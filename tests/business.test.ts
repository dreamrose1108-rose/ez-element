import test from 'node:test';
import assert from 'node:assert/strict';
import { GymService, userKey } from '../server/service';
import { MemoryStore } from '../server/memory-store';
import { BusinessError, Session } from '../server/model';

async function fixture() {
  const store = new MemoryStore(); let now = Date.parse('2026-11-01T08:00:00+08:00');
  const service = new GymService(store, () => now);
  await store.transaction(async tx => {
    for (const [name, roles] of [['admin', ['admin']], ['coach', ['coach']], ['coach2', ['coach']], ['student', ['student']], ['student2', ['student']]] as const) {
      await tx.put('users', { id: userKey(name), name, roles: [...roles], status: 'active', phone: '13800000000' });
    }
  });
  let seq = 0;
  const call = (who: string, action: string, data: object = {}) => service.execute(who, { action, requestId: `request-${++seq}`, ...data }) as Promise<{ id: string }>;
  const publish = (data: object = {}, who = 'admin') => call(who, 'publish', { kind: 'private', title: '力量私教', coachId: userKey('coach'), roomId: 'open', exclusive: false, start: now + 2 * 86400000, end: now + 2 * 86400000 + 3600000, capacity: 1, cost: 1, ...data });
  const purchase = (who = 'student', data: object = {}) => call('admin', 'purchase', { memberId: userKey(who), kind: 'private', coachIds: [userKey('coach'), userKey('coach2')], credits: 10, expiresAt: now + 30 * 86400000, amountFen: 200000, method: 'transfer', note: '线下转账凭据 001', ...data });
  const get = <K extends Parameters<typeof store.list>[0]>(table: K) => store.list(table, {}, 200);
  return { store, service, call, publish, purchase, get, now: () => now, advance: (n: number) => { now += n; } };
}
const rejectsCode = async (promise: Promise<unknown>, code: string) => assert.rejects(promise, (e: unknown) => e instanceof BusinessError && e.code === code);

test('注册无法自行提权；同手机号不接管原有身份；待审核不能预约', async () => {
  const f = await fixture();
  await assert.rejects(f.service.execute('new', { action: 'register', name: '新人', phone: '13800000000', roles: ['admin'] }));
  await f.service.execute('new', { action: 'register', name: '新人', phone: '13800000000' });
  assert.equal((await f.store.transaction(tx => tx.get('users', userKey('new'))))?.status, 'pending');
  await rejectsCode(f.call('new', 'book', { sessionId: 'x', packageId: 'y' }), 'INACTIVE');
  await f.call('admin', 'approve', { userId: userKey('new') });
  assert.equal((await f.store.transaction(tx => tx.get('users', userKey('new'))))?.status, 'active');
});

test('购课 → 预约 → 取消 → 重新预约 → 出勤；幂等且账目可重建', async () => {
  const f = await fixture(); const p = await f.purchase(); const s = await f.publish();
  const input = { sessionId: s.id, packageId: p.id, requestId: 'same-booking-1' };
  const b = await f.call('student', 'book', input);
  assert.deepEqual(await f.call('student', 'book', input), b);
  await f.call('student', 'cancel', { bookingId: b.id });
  await f.call('student', 'cancel', { bookingId: b.id });
  const b2 = await f.call('student', 'book', { sessionId: s.id, packageId: p.id });
  await rejectsCode(f.call('coach', 'settle', { bookingId: b2.id, outcome: 'attended' }), 'STATE');
  f.advance(3 * 86400000);
  await f.call('coach', 'settle', { bookingId: b2.id, outcome: 'attended' });
  await f.call('coach', 'settle', { bookingId: b2.id, outcome: 'attended' });
  const pack = await f.store.transaction(tx => tx.get('memberPackages', p.id));
  assert.deepEqual([pack?.available, pack?.frozen, pack?.consumed], [9, 0, 1]);
  const ledger = await f.store.list('creditLedger', { packageId: p.id }, 200);
  const sums = ledger.reduce((a, l) => [a[0]! + l.delta.available, a[1]! + l.delta.frozen, a[2]! + l.delta.consumed], [0, 0, 0]);
  assert.deepEqual(sums, [9, 0, 1]);
  assert.equal((await f.store.list('inbox', { userId: userKey('student') }, 200)).length, 4);
});

test('11 人并发抢 10 人团课，失败者不冻结课时', async () => {
  const f = await fixture(); const s = await f.publish({ kind: 'group', capacity: 10 });
  const people = Array.from({ length: 11 }, (_, i) => `member${i}`);
  await f.store.transaction(async tx => { for (const n of people) await tx.put('users', { id: userKey(n), name: n, phone: '13800000000', status: 'active', roles: ['student'] }); });
  const packs = await Promise.all(people.map(n => f.purchase(n, { kind: 'group', coachIds: [] })));
  const results = await Promise.allSettled(people.map((n, i) => f.call(n, 'book', { sessionId: s.id, packageId: packs[i]!.id })));
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 10);
  assert.equal((await f.store.list('memberPackages', {}, 200)).reduce((s, p) => s + p.frozen, 0), 10);
  assert.equal((await f.store.transaction(tx => tx.get('sessions', s.id)))?.reserved, 10);
});

test('同学员并发约重叠课程最多成功一笔；不同教练也不能绕过', async () => {
  const f = await fixture(); const p = await f.purchase(); const s = await f.publish(); const s2 = await f.publish({ coachId: userKey('coach2') });
  const results = await Promise.allSettled([s, s2].map(s => f.call('student', 'book', { sessionId: s.id, packageId: p.id })));
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
});

test('剩余一节课同时预约两个不重叠时段，不能超额冻结', async () => {
  const f = await fixture(); const p = await f.purchase('student', { credits: 1 });
  const s = await f.publish(); const s2 = await f.publish({ start: f.now() + 3 * 86400000, end: f.now() + 3 * 86400000 + 3600000 });
  const results = await Promise.allSettled([s, s2].map(s => f.call('student', 'book', { sessionId: s.id, packageId: p.id })));
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  const pack = await f.store.transaction(tx => tx.get('memberPackages', p.id));
  assert.deepEqual([pack?.available, pack?.frozen], [0, 1]);
});

test('跨私教团课检查教练和独占场地冲突，相邻场次允许', async () => {
  const f = await fixture(); await f.publish({ roomId: 'room1', exclusive: true });
  await rejectsCode(f.publish({ kind: 'group', capacity: 10 }), 'CONFLICT');
  await rejectsCode(f.publish({ coachId: userKey('coach2'), roomId: 'room1', exclusive: true }), 'CONFLICT');
  await f.publish({ start: f.now() + 2 * 86400000 + 3600000, end: f.now() + 2 * 86400000 + 7200000 });
});

test('课包类型、教练和有效期须符合上课时间', async () => {
  const f = await fixture(); const s = await f.publish();
  const group = await f.purchase('student', { kind: 'group', coachIds: [] });
  await rejectsCode(f.call('student', 'book', { sessionId: s.id, packageId: group.id }), 'PACKAGE');
  const wrong = await f.purchase('student', { coachIds: [userKey('coach2')] });
  await rejectsCode(f.call('student', 'book', { sessionId: s.id, packageId: wrong.id }), 'PACKAGE');
  const expired = await f.purchase('student', { expiresAt: f.now() + 86400000 });
  await rejectsCode(f.call('student', 'book', { sessionId: s.id, packageId: expired.id }), 'EXPIRED');
});

test('取消期限边界；别人不能取消；教练不能越权消课或开卡', async () => {
  const f = await fixture(); const p = await f.purchase(); const s = await f.publish(); const b = await f.call('student', 'book', { sessionId: s.id, packageId: p.id });
  await rejectsCode(f.call('student2', 'cancel', { bookingId: b.id }), 'FORBIDDEN');
  await rejectsCode(f.call('coach2', 'settle', { bookingId: b.id, outcome: 'absent' }), 'FORBIDDEN');
  f.advance(36 * 3600000 + 1);
  await rejectsCode(f.call('student', 'cancel', { bookingId: b.id }), 'LATE_CANCEL');
  f.advance(24 * 3600000);
  await f.call('coach', 'settle', { bookingId: b.id, outcome: 'absent' });
  await rejectsCode(f.call('coach', 'settle', { bookingId: b.id, outcome: 'attended' }), 'STATE');
});

test('有预约的私教时段不能关闭；空闲时段关闭后可重新排课', async () => {
  const f = await fixture(); const p = await f.purchase(); const s = await f.publish();
  const b = await f.call('student', 'book', { sessionId: s.id, packageId: p.id });
  await rejectsCode(f.call('coach', 'closeSlot', { sessionId: s.id }), 'STATE');
  await f.call('student', 'cancel', { bookingId: b.id });
  await f.call('coach', 'closeSlot', { sessionId: s.id });
  await f.publish();
});

test('失败事务完整回滚；请求键不能用于不同操作；非法负金额被拒绝', async () => {
  const f = await fixture(); const p = await f.purchase(); const s = await f.publish();
  const input = { sessionId: s.id, packageId: p.id, requestId: 'shared-request-1' };
  const b = await f.call('student', 'book', input);
  await rejectsCode(f.call('student', 'cancel', { bookingId: b.id, requestId: input.requestId }), 'REQUEST_REUSED');
  await assert.rejects(f.purchase('student', { amountFen: -1 }));
  const count = (await f.store.list('sessions', {}, 200)).length;
  await rejectsCode(f.publish(), 'CONFLICT');
  assert.equal((await f.store.list('sessions', {}, 200)).length, count);
});

test('学员及教练响应不包含线下收款和他人课包', async () => {
  const f = await fixture(); await f.purchase();
  const result = await f.service.execute('coach', { action: 'dashboard' });
  assert.ok('purchases' in result); assert.deepEqual(result.purchases, []);
  assert.ok('packages' in result); assert.deepEqual(result.packages, []);
  assert.ok('users' in result); assert.deepEqual(result.users, []);
});
