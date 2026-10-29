import test from 'node:test';
import assert from 'node:assert/strict';
import { GymService, userKey, walletKey } from '../server/service';
import { fixtureStore } from './helpers/store';
import { BusinessError } from '../server/model';

async function setup() {
  const store = await fixtureStore(); let now = Date.parse('2026-11-01T08:00:00+08:00'); let seq = 0;
  const service = new GymService(store, () => now);
  await store.transaction(async tx => {
    for (const [name, roles] of [['admin', ['admin']], ['coach', ['coach']], ['student', ['student']], ['other', ['student']]] as const) {
      await tx.put('users', { id: userKey(name), name, phone: '13800000000', status: 'active', roles: [...roles] });
    }
  });
  const call = (who: string, action: string, data: object = {}) => service.execute(who, { action, requestId: `wallet-test-${++seq}`, ...data }) as Promise<{ id: string }>;
  const recharge = (data: object = {}) => call('admin', 'recharge', { memberId: userKey('student'), amountFen: 440000, prices: { private: 22000, group: 10000 }, expiresAt: now + 30 * 86400000, method: 'transfer', note: 'test', ...data });
  const publish = (kind: 'private' | 'group', offset = 0) => call('admin', 'publish', { kind, title: kind, coachId: userKey('coach'), roomId: 'open', exclusive: false, start: now + 2 * 86400000 + offset, end: now + 2 * 86400000 + offset + 3600000, capacity: kind === 'private' ? 1 : 10, cost: 1 });
  const book = (sessionId: string, expectedAmountFen: number) => call('student', 'book', { sessionId, packageId: walletKey(userKey('student')), expectedAmountFen });
  const wallet = () => store.transaction(tx => tx.get('memberPackages', walletKey(userKey('student'))));
  return { store, service, call, recharge, publish, book, wallet, advance: (n: number) => { now += n; } };
}
const rejectsCode = (p: Promise<unknown>, code: string) => assert.rejects(p, (e: unknown) => e instanceof BusinessError && e.code === code);

test('一次充值同时用于私教和团课，预约锁价，取消和结算按原金额记账', async () => {
  const f = await setup(); await f.recharge();
  const a = await f.publish('private'); const b = await f.publish('group', 7200000);
  const ba = await f.book(a.id, 22000); const bb = await f.book(b.id, 10000);
  assert.equal((await f.wallet())?.available, 408000); assert.equal((await f.wallet())?.frozen, 32000);
  await f.call('admin', 'setMemberPrices', { userId: userKey('student'), prices: { private: 30000, group: 15000 } });
  await f.call('student', 'cancel', { bookingId: bb.id });
  assert.equal((await f.wallet())?.available, 418000);
  f.advance(3 * 86400000);
  await f.call('coach', 'settle', { bookingId: ba.id, outcome: 'attended' });
  await f.call('coach', 'settle', { bookingId: ba.id, outcome: 'attended' });
  const w = (await f.wallet())!;
  assert.equal(w.available, 418000); assert.equal(w.frozen, 0); assert.equal(w.consumed, 22000);
  const notices = await f.store.list('inbox', { userId: userKey('student'), bookingId: ba.id }, 20);
  assert.equal(notices.filter(n => n.receipt).length, 1);
  assert.equal(notices.find(n => n.receipt)?.receipt?.deductedFen, 22000);
  const dashboard = await f.service.execute('coach', { action: 'dashboard' });
  assert.ok('coachPay' in dashboard); assert.equal(dashboard.coachPay?.monthClassRevenueFen, 22000);
  assert.deepEqual(dashboard.packages, []); assert.deepEqual(dashboard.purchases, []);
});

test('续充合并同一余额、金额无需整除单价、充值幂等且有效期不缩短', async () => {
  const f = await setup(); await f.recharge({ requestId: 'wallet-recharge-fixed', amountFen: 450001 });
  await f.recharge({ requestId: 'wallet-recharge-fixed', amountFen: 450001 });
  const first = (await f.wallet())!;
  await f.recharge({ amountFen: 10000, expiresAt: first.expiresAt - 86400000 });
  const w = (await f.wallet())!; assert.equal(w.total, 460001); assert.equal(w.available, 460001); assert.equal(w.expiresAt, first.expiresAt);
  assert.equal((await f.store.list('purchaseRecords', {}, 20)).length, 2);
  const entries = await f.store.list('creditLedger', { packageId: w.id }, 20);
  assert.equal(entries.reduce((sum, l) => sum + l.delta.available, 0), w.available);
  assert.ok(entries.every(l => l.unit === 'fen'));
});

test('同一余额并发约私教与团课不能超扣，价格过期须重新确认', async () => {
  const f = await setup(); await f.recharge({ amountFen: 25000 });
  const a = await f.publish('private'); const b = await f.publish('group', 7200000);
  await rejectsCode(f.book(a.id, 1), 'PRICE_CHANGED');
  const result = await Promise.allSettled([f.book(a.id, 22000), f.book(b.id, 10000)]);
  assert.equal(result.filter(r => r.status === 'fulfilled').length, 1);
  const w = (await f.wallet())!; assert.ok(w.available >= 0); assert.equal(w.available + w.frozen, 25000);
});

test('不同学员各自定价，门店停课按每人冻结金额原路退回', async () => {
  const f = await setup(); await f.recharge();
  await f.recharge({ memberId: userKey('other'), prices: { private: 18000, group: 8000 } });
  const s = await f.publish('group'); await f.book(s.id, 10000);
  await f.call('other', 'book', { sessionId: s.id, packageId: walletKey(userKey('other')), expectedAmountFen: 8000 });
  await f.call('admin', 'cancelSession', { sessionId: s.id, reason: 'test cancellation' });
  assert.equal((await f.wallet())?.available, 440000); assert.equal((await f.wallet())?.frozen, 0);
  const other = await f.store.transaction(tx => tx.get('memberPackages', walletKey(userKey('other'))));
  assert.equal(other?.available, 440000); assert.equal(other?.frozen, 0);
});

test('储值禁止越权、透支、过期与恶意价格；爽约扣款但不计授课提成', async () => {
  const f = await setup();
  await rejectsCode(f.call('student', 'setMemberPrices', { userId: userKey('student'), prices: { private: 1, group: 1 } }), 'FORBIDDEN');
  await rejectsCode(f.call('coach', 'recharge', { memberId: userKey('student'), prices: { private: 100, group: 100 }, amountFen: 10000, expiresAt: Date.parse('2027-01-01T00:00:00Z'), method: 'cash', note: 'test' }), 'FORBIDDEN');
  await assert.rejects(f.recharge({ prices: { private: 0, group: 10000 } }));
  await f.recharge({ amountFen: 22000, salesCoachId: userKey('coach') });
  const s = await f.publish('private');
  await rejectsCode(f.call('other', 'book', { sessionId: s.id, packageId: walletKey(userKey('student')), expectedAmountFen: 22000 }), 'PACKAGE');
  const b = await f.book(s.id, 22000); f.advance(3 * 86400000);
  await f.call('coach', 'settle', { bookingId: b.id, outcome: 'absent' });
  assert.equal((await f.wallet())?.consumed, 22000);
  const dashboard = await f.service.execute('coach', { action: 'dashboard' });
  assert.ok('coachPay' in dashboard); assert.equal(dashboard.coachPay?.monthClassRevenueFen, 0); assert.equal(dashboard.coachPay?.monthPerformanceFen, 22000);
  const late = await f.publish('group'); f.advance(31 * 86400000);
  await assert.rejects(f.book(late.id, 10000));
});

test('过期储值和缺失价格无法预约，失败不冻结金额或占用名额', async () => {
  const f = await setup();
  await f.recharge({ expiresAt: Date.parse('2026-11-02T08:00:00+08:00') });
  const s = await f.publish('private');
  await rejectsCode(f.book(s.id, 22000), 'EXPIRED');
  await f.recharge();
  await f.store.transaction(async tx => {
    const member = (await tx.get('users', userKey('student')))!;
    delete member.prices; await tx.put('users', member);
  });
  await rejectsCode(f.book(s.id, 22000), 'PRICE');
  assert.equal((await f.wallet())?.frozen, 0);
  assert.equal((await f.store.list('sessions', { id: s.id }, 1))[0]?.reserved, 0);
});
