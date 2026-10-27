import test from 'node:test';
import assert from 'node:assert/strict';
import { adminPool, runtimePool, fixtureStore, pgTest } from './helpers/store';
import { pgTables } from '../server/postgres-store';
import { GymService, userKey } from '../server/service';

test('PostgreSQL: RLS blocks API roles; runtime role has no schema or destructive privileges', async () => {
  assert.ok(pgTest);
  const store = await fixtureStore();
  await store.transaction(tx => tx.put('settings', { id: 'store', bookingDays: 7, privateCancelHours: 12, groupCancelHours: 6, cutoffMinutes: 30 }));
  assert.equal((await store.list('settings', {}, 10)).length, 1);
  for (const role of ['anon', 'authenticated']) {
    const client = await adminPool!.connect();
    try {
      await client.query(`SET ROLE ${role}`);
      for (const table of pgTables) {
        await assert.rejects(client.query(`SELECT * FROM public."ez_${table}"`), { code: '42501' });
        await assert.rejects(client.query(`INSERT INTO public."ez_${table}" (id,data) VALUES ('x','{"id":"x"}')`), { code: '42501' });
      }
    } finally { await client.query('RESET ROLE'); client.release(); }
  }
  await assert.rejects(runtimePool!.query('DELETE FROM public."ez_settings"'), { code: '42501' });
  await assert.rejects(runtimePool!.query('CREATE TABLE public.unauthorized (id text)'), { code: '42501' });
  await assert.rejects(runtimePool!.query('INSERT INTO public."ez_settings" (id,data) VALUES ($1,$2)', ['invalid', { id: 'different' }]), { code: '23514' });
  // Even if a platform accidentally grants table privileges, no client RLS
  // policy exists. Check both invisible rows and rejected writes; roll back grants.
  const client = await adminPool!.connect();
  try {
    await client.query('BEGIN');
    await client.query('GRANT SELECT, INSERT ON public."ez_settings" TO authenticated');
    await client.query('SET LOCAL ROLE authenticated');
    assert.equal((await client.query('SELECT * FROM public."ez_settings"')).rows.length, 0);
    await assert.rejects(client.query(`INSERT INTO public."ez_settings" VALUES ('client','{"id":"client"}')`), { code: '42501' });
  } finally { await client.query('ROLLBACK'); client.release(); }
});

test('PostgreSQL: concurrent creation of an absent request key produces one purchase and ledger row', async () => {
  const store = await fixtureStore();
  await store.transaction(async tx => {
    for (const [name, roles] of [['admin', ['admin']], ['member', ['student']]] as const) {
      await tx.put('users', { id: userKey(name), name, roles: [...roles], phone: '13800000000', status: 'active' });
    }
  });
  const now = Date.parse('2026-11-01T08:00:00+08:00');
  const service = new GymService(store, () => now);
  const command = { action: 'purchase', requestId: 'same-pg-purchase', memberId: userKey('member'), kind: 'group', coachIds: [], credits: 10,
    expiresAt: now + 86400000, amountFen: 10000, method: 'cash', note: '并发测试' };
  const results = await Promise.all(Array.from({ length: 12 }, () => service.execute('admin', command)));
  for (const result of results) assert.deepEqual(result, results[0]);
  for (const table of ['memberPackages', 'purchaseRecords', 'creditLedger', 'requestKeys', 'auditLogs'] as const) {
    assert.equal((await store.list(table, {}, 100)).length, 1);
  }
});

test('PostgreSQL: filters are parameterized and missing-row schedule conflicts retry without double publishing', async () => {
  const store = await fixtureStore();
  const name = "A' OR 1=1 -- 中文";
  await store.transaction(tx => tx.put('users', { id: userKey('coach'), name, roles: ['coach'], phone: '13800000000', status: 'active' }));
  assert.equal((await store.list('users', { name }, 10)).length, 1);
  assert.equal((await store.list('users', { name: "' OR true --" }, 10)).length, 0);
  const now = Date.parse('2026-11-01T08:00:00+08:00');
  const service = new GymService(store, () => now);
  const results = await Promise.allSettled(Array.from({ length: 8 }, (_, i) => service.execute('coach', {
    action: 'publish', requestId: `concurrent-slot-${i}`, coachId: userKey('coach'), kind: 'private', title: '并发排课',
    roomId: 'room1', exclusive: true, start: now + 3600000, end: now + 7200000, capacity: 1, cost: 1,
  })));
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  for (const result of results) if (result.status === 'rejected') assert.equal(result.reason.code, 'CONFLICT');
  assert.equal((await store.list('sessions', {}, 100)).length, 1);
});
