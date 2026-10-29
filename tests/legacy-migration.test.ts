import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStore } from '../server/memory-store';
import { GymService, userKey, walletKey } from '../server/service';

async function fixture(amount = 1100000, total = 50, consumed = 2, frozen = 6) {
  const store = new MemoryStore(); let now = Date.parse('2026-11-01T08:00:00+08:00');
  const service = new GymService(store, () => now);
  await store.transaction(async tx => {
    for (const [name, roles] of [['admin', ['admin']], ['student', ['student']], ['coach', ['coach']]] as const) await tx.put('users', { id: userKey(name), name, phone: '13800000000', roles: [...roles], status: 'active' });
    await tx.put('memberPackages', { id: 'legacy', memberId: userKey('student'), kind: 'private', coachIds: [userKey('coach')], total, consumed, frozen, available: total - consumed - frozen, expiresAt: now + 90 * 86400000 });
    await tx.put('purchaseRecords', { id: 'legacy', memberId: userKey('student'), packageId: 'legacy', amountFen: amount, method: 'cash', note: 'original', actorId: userKey('admin'), at: now - 86400000 });
    for (let i = 0; i < frozen; i++) {
      await tx.put('sessions', { id: `session-${i}`, kind: 'private', title: '课程', coachId: userKey('coach'), roomId: 'room', exclusive: false, start: now + 2 * 86400000 + i * 3600000, end: now + 2 * 86400000 + (i + 1) * 3600000, capacity: 1, reserved: 1, cost: 1, status: 'open', cancelHours: 12, cutoffMinutes: 60 });
      await tx.put('bookings', { id: `booking-${i}`, sessionId: `session-${i}`, memberId: userKey('student'), packageId: 'legacy', cost: 1, cancelHours: 12, status: 'confirmed', createdAt: now });
    }
  });
  let seq = 0;
  const call = (who: string, cmd: object) => service.execute(who, { requestId: `migration-${++seq}`, ...cmd });
  const wallet = () => store.transaction(tx => tx.get('memberPackages', walletKey(userKey('student'))));
  return { store, service, call, wallet, advance: () => { now += 4 * 86400000; } };
}
test('剩余权益精确转换，重复/并发执行不重复入账，保留原价预约可取消和消课', async () => {
  const f = await fixture();
  await assert.rejects(f.call('student', { action: 'migrateLegacy' }));
  await Promise.all([f.call('admin', { action: 'migrateLegacy' }), f.call('admin', { action: 'migrateLegacy' })]);
  let w = (await f.wallet())!;
  assert.deepEqual([w.available, w.frozen, w.total, w.consumed], [924000, 132000, 1056000, 0]);
  const bookings = await f.store.list('bookings', {}, 20);
  assert.ok(bookings.every(b => b.packageId === w.id && b.amountFen === 22000 && b.legacyPackageId === 'legacy'));
  assert.equal((await f.store.list('purchaseRecords', {}, 20)).length, 1);
  assert.equal((await f.store.list('creditLedger', {}, 20)).length, 1);
  const dashboard = await f.service.execute('student', { action: 'dashboard' });
  assert.ok('profile' in dashboard);
  assert.equal(dashboard.packages?.length, 1); assert.equal(dashboard.profile?.prices?.private, 22000);
  assert.equal(dashboard.profile?.prices?.group, undefined);
  await f.call('student', { action: 'cancel', bookingId: 'booking-0' });
  w = (await f.wallet())!; assert.equal(w.available, 946000); assert.equal(w.frozen, 110000);
  f.advance(); await f.call('coach', { action: 'settle', bookingId: 'booking-1', outcome: 'attended' });
  w = (await f.wallet())!; assert.equal(w.frozen, 88000); assert.equal(w.consumed, 22000);
  assert.equal(w.available + w.frozen + w.consumed, w.total);
  await assert.rejects(f.call('admin', { action: 'purchase', memberId: userKey('student'), kind: 'group', coachIds: [], credits: 1, amountFen: 100, expiresAt: Date.parse('2099-01-01'), method: 'cash', note: 'retired' }), /旧课包已停用/);
});
test('合并现有余额，保留现有单价和有效期，不把转换算成新收款', async () => {
  const f = await fixture();
  await f.call('admin', { action: 'recharge', memberId: userKey('student'), prices: { private: 30000, group: 10000 }, amountFen: 100000, expiresAt: Date.parse('2030-01-01'), method: 'cash', note: 'wallet' });
  await f.call('admin', { action: 'migrateLegacy' });
  const w = (await f.wallet())!; assert.equal(w.total, 1156000); assert.equal(w.available, 1024000); assert.equal(w.expiresAt, Date.parse('2030-01-01'));
  const member = await f.store.transaction(tx => tx.get('users', userKey('student')));
  assert.deepEqual(member?.prices, { private: 30000, group: 10000 });
  assert.equal((await f.store.list('purchaseRecords', {}, 20)).length, 2);
});
test('非整分单价累计分摊保留每一分钱；冻结不一致整笔回滚', async () => {
  const f = await fixture(100, 3, 1, 1);
  await f.call('admin', { action: 'migrateLegacy' });
  const w = (await f.wallet())!; assert.deepEqual([w.total, w.available, w.frozen], [67, 33, 34]);
  const g = await fixture();
  await g.store.transaction(async tx => { const b = (await tx.get('bookings', 'booking-0'))!; b.status = 'cancelled'; await tx.put('bookings', b); });
  await assert.rejects(g.call('admin', { action: 'migrateLegacy' }), /冻结课时/);
  assert.equal(await g.wallet(), undefined);
  assert.equal((await g.store.transaction(tx => tx.get('memberPackages', 'legacy')))?.migratedAt, undefined);
  assert.equal((await g.store.list('creditLedger', {}, 20)).length, 0);
});
