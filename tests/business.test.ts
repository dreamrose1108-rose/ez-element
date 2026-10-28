import test from 'node:test';
import assert from 'node:assert/strict';
import { GymService, userKey } from '../server/service';
import { fixtureStore } from './helpers/store';
import { BusinessError, Session } from '../server/model';

async function fixture() {
  const store = await fixtureStore(); let now = Date.parse('2026-11-01T08:00:00+08:00');
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

test('消课金额通知原子保存、重复结算不重发，分摊尾差最终归零', async () => {
  const f = await fixture(); const p = await f.purchase('student', { credits: 3, amountFen: 100 });
  const bookings: string[] = [];
  for (let i = 0; i < 3; i++) {
    const s = await f.publish({ start: f.now() + (i + 2) * 86400000, end: f.now() + (i + 2) * 86400000 + 3600000 });
    bookings.push((await f.call('student', 'book', { sessionId: s.id, packageId: p.id })).id);
  }
  f.advance(6 * 86400000);
  for (const bookingId of bookings) {
    await f.call('coach', 'settle', { bookingId, outcome: 'attended' });
    await f.call('coach', 'settle', { bookingId, outcome: 'attended' });
  }
  const notices = (await f.get('inbox')).filter(m => m.userId === userKey('student') && m.receipt);
  assert.equal(notices.length, 3);
  const receipts = bookings.map(id => notices.find(m => m.bookingId === id)!.receipt!);
  assert.deepEqual(receipts.map(r => r.deductedFen), [33, 34, 33]);
  assert.deepEqual(receipts.map(r => r.remainingFen), [67, 33, 0]);
  assert.deepEqual(receipts.map(r => r.frozenCredits), [2, 1, 0]);
  assert.equal((await f.get('inbox')).filter(m => m.userId === userKey('coach') && m.receipt).length, 0);
});

test('教练身份仅管理员可管理，保留原角色，幂等并记录审计', async () => {
  const f = await fixture();
  for (const who of ['student', 'coach']) await rejectsCode(f.call(who, 'setCoach', { userId: userKey('student'), enabled: true }), 'FORBIDDEN');
  await f.service.execute('pending', { action: 'register', name: '待审核', phone: '13800000000' });
  await rejectsCode(f.call('admin', 'setCoach', { userId: userKey('pending'), enabled: true }), 'INACTIVE');
  await f.store.transaction(async tx => { const u = (await tx.get('users', userKey('student')))!; u.roles.push('admin'); await tx.put('users', u); });
  const cmd = { userId: userKey('student'), enabled: true, requestId: 'grant-coach-unique' };
  await f.call('admin', 'setCoach', cmd); await f.call('admin', 'setCoach', cmd);
  assert.deepEqual((await f.store.transaction(tx => tx.get('users', userKey('student'))))?.roles, ['student', 'admin', 'coach']);
  assert.equal((await f.get('auditLogs')).filter(a => a.action === 'setCoach').length, 1);
  await f.call('admin', 'setCoach', { userId: userKey('student'), enabled: false });
  assert.deepEqual((await f.store.transaction(tx => tx.get('users', userKey('student'))))?.roles, ['student', 'admin']);
});

test('取消教练阻止未来空闲排课和历史未结算预约，处理完后才允许取消', async () => {
  const f = await fixture(); const s = await f.publish();
  await rejectsCode(f.call('admin', 'setCoach', { userId: userKey('coach'), enabled: false }), 'COACH_HAS_WORK');
  const p = await f.purchase(); const b = await f.call('student', 'book', { sessionId: s.id, packageId: p.id });
  f.advance(3 * 86400000);
  await rejectsCode(f.call('admin', 'setCoach', { userId: userKey('coach'), enabled: false }), 'COACH_HAS_WORK');
  await f.call('coach', 'settle', { bookingId: b.id, outcome: 'attended' });
  await f.call('admin', 'setCoach', { userId: userKey('coach'), enabled: false });
  assert.deepEqual((await f.store.transaction(tx => tx.get('users', userKey('coach'))))?.roles, ['student']);
  await rejectsCode(f.publish({}, 'coach'), 'FORBIDDEN');
});

test('并发发布排课与取消教练身份不能同时成功', async () => {
  const f = await fixture();
  const results = await Promise.allSettled([f.publish(), f.call('admin', 'setCoach', { userId: userKey('coach'), enabled: false })]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
});

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

test('复制七天私教排班保留课程属性，不复制预约；重复请求不重复创建', async () => {
  const f = await fixture(); const pack = await f.purchase();
  const a = await f.publish({ exclusive: true, roomId: 'room-a', cost: 2 });
  const b = await f.publish({ start: f.now() + 3 * 86400000, end: f.now() + 3 * 86400000 + 3600000 });
  await f.call('student', 'book', { sessionId: a.id, packageId: pack.id });
  const command = { action: 'copyWeek', requestId: 'copy-week-repeat', sessionIds: [a.id, b.id], sourceStart: Date.parse('2026-11-03T00:00:00+08:00') };
  const first = await f.service.execute('coach', command);
  assert.deepEqual(await f.service.execute('coach', command), first);
  const sessions = await f.get('sessions'); assert.equal(sessions.length, 4);
  const original = sessions.find(s => s.id === a.id)!;
  const copied = sessions.find(s => s.start === original.start + 7 * 86400000)!;
  assert.equal(copied.reserved, 0); assert.equal(copied.status, 'open');
  for (const field of ['kind', 'title', 'coachId', 'roomId', 'exclusive', 'capacity', 'cost'] as const) assert.equal(copied[field], original[field]);
  assert.equal((await f.get('bookings')).length, 1);
  assert.equal((await f.get('memberPackages'))[0]!.frozen, 2);
  await rejectsCode(f.call('coach', 'copyWeek', { sessionIds: [a.id, b.id], sourceStart: command.sourceStart }), 'CONFLICT');
  assert.equal((await f.get('sessions')).length, 4);
});

test('整周复制后续场次冲突时回滚全部新场次和锁；修正冲突后可重试', async () => {
  const f = await fixture(); const a = await f.publish();
  const b = await f.publish({ start: f.now() + 3 * 86400000, end: f.now() + 3 * 86400000 + 3600000 });
  const conflict = await f.publish({ start: f.now() + 10 * 86400000, end: f.now() + 10 * 86400000 + 3600000, kind: 'group', capacity: 10 });
  const before = await f.get('scheduleLocks');
  const command = { action: 'copyWeek', requestId: 'copy-week-conflict', sessionIds: [a.id, b.id], sourceStart: Date.parse('2026-11-03T00:00:00+08:00') };
  await rejectsCode(f.service.execute('coach', command), 'CONFLICT');
  assert.equal((await f.get('sessions')).length, 3);
  assert.deepEqual(await f.get('scheduleLocks'), before);
  await f.call('admin', 'closeSlot', { sessionId: conflict.id });
  await f.service.execute('coach', command);
  assert.equal((await f.get('sessions')).length, 5);
});

test('复制排班拒绝越权、重复来源、跨周及关闭场次', async () => {
  const f = await fixture(); const a = await f.publish();
  const input = { sessionIds: [a.id], sourceStart: Date.parse('2026-11-03T00:00:00+08:00') };
  await rejectsCode(f.call('student', 'copyWeek', input), 'FORBIDDEN');
  await rejectsCode(f.call('coach2', 'copyWeek', input), 'FORBIDDEN');
  await rejectsCode(f.call('coach', 'copyWeek', { ...input, sessionIds: [a.id, a.id] }), 'INPUT');
  await rejectsCode(f.call('coach', 'copyWeek', { ...input, sourceStart: input.sourceStart + 86400000 }), 'TIME');
  await rejectsCode(f.call('coach', 'copyWeek', { ...input, sourceStart: input.sourceStart + 1 }), 'TIME');
  await f.call('coach', 'closeSlot', { sessionId: a.id });
  await rejectsCode(f.call('coach', 'copyWeek', input), 'STATE');
  assert.equal((await f.get('sessions')).length, 1);
});

test('整周复制仍校验目标时间和独占场地冲突', async () => {
  const f = await fixture(); const a = await f.publish({ exclusive: true, roomId: 'only-room' });
  await f.publish({ coachId: userKey('coach2'), exclusive: true, roomId: 'only-room', start: f.now() + 9 * 86400000, end: f.now() + 9 * 86400000 + 3600000 });
  const input = { sessionIds: [a.id], sourceStart: Date.parse('2026-11-03T00:00:00+08:00') };
  await rejectsCode(f.call('admin', 'copyWeek', input), 'CONFLICT');
  f.advance(10 * 86400000);
  await rejectsCode(f.call('admin', 'copyWeek', input), 'TIME');
  assert.equal((await f.get('sessions')).length, 2);
});

test('编辑空闲时段迁移日程锁，保留取消历史并支持幂等重试', async () => {
  const f = await fixture(); const a = await f.publish({ exclusive: true, roomId: 'old-room' }); const p = await f.purchase();
  const booking = await f.call('student', 'book', { sessionId: a.id, packageId: p.id });
  await f.call('student', 'cancel', { bookingId: booking.id });
  const original = (await f.get('sessions'))[0]!;
  const command = { action: 'editSlot', requestId: 'edit-slot-repeat', sessionId: a.id, title: '新时段', roomId: 'new-room', start: original.start + 86400000, end: original.end + 86400000, capacity: 1 };
  const edited = await f.service.execute('coach', command) as { id: string };
  assert.deepEqual(await f.service.execute('coach', command), edited);
  const sessions = await f.get('sessions'); assert.equal(sessions.length, 2);
  assert.equal(sessions.find(s => s.id === a.id)!.status, 'closed');
  assert.equal(sessions.find(s => s.id === a.id)!.start, original.start);
  const next = sessions.find(s => s.id === edited.id)!;
  assert.equal(next.start, command.start); assert.equal(next.cost, original.cost); assert.equal(next.exclusive, true);
  assert.equal((await f.get('bookings'))[0]!.sessionId, a.id);
  await f.publish({ exclusive: true, roomId: 'old-room' }); // Original time was released.
  await rejectsCode(f.call('student', 'book', { sessionId: a.id, packageId: p.id }), 'NOT_FOUND');
  await f.call('student', 'book', { sessionId: edited.id, packageId: p.id });
});

test('编辑冲突完整回滚；拒绝越权、已有预约、关闭及已开始的场次', async () => {
  const f = await fixture(); const a = await f.publish({ exclusive: true, roomId: 'old-room' });
  const input = { sessionId: a.id, title: '调整', roomId: 'new-room', start: f.now() + 3 * 86400000, end: f.now() + 3 * 86400000 + 3600000, capacity: 1 };
  await f.publish({ coachId: userKey('coach2'), exclusive: true, roomId: 'new-room', start: input.start, end: input.end });
  const before = await f.get('scheduleLocks');
  await rejectsCode(f.call('coach', 'editSlot', input), 'CONFLICT');
  assert.deepEqual(await f.get('scheduleLocks'), before);
  assert.equal((await f.get('sessions')).find(s => s.id === a.id)!.status, 'open');
  await rejectsCode(f.call('student', 'editSlot', input), 'FORBIDDEN');
  await rejectsCode(f.call('coach2', 'editSlot', input), 'FORBIDDEN');
  const p = await f.purchase(); await f.call('student', 'book', { sessionId: a.id, packageId: p.id });
  await rejectsCode(f.call('admin', 'editSlot', input), 'STATE');
  const closed = await f.publish({ start: input.start + 86400000, end: input.end + 86400000 });
  await f.call('coach', 'closeSlot', { sessionId: closed.id });
  await rejectsCode(f.call('coach', 'editSlot', { ...input, sessionId: closed.id }), 'STATE');
  const past = await f.publish({ start: f.now() + 3600000, end: f.now() + 7200000 });
  f.advance(7200000);
  await rejectsCode(f.call('coach', 'editSlot', { ...input, sessionId: past.id }), 'STATE');
});

test('团课仅管理员可编辑；私教容量及时间约束不被编辑绕过', async () => {
  const f = await fixture(); const a = await f.publish({ kind: 'group', capacity: 10 });
  const input = { sessionId: a.id, title: '调整团课', roomId: 'group-room', start: f.now() + 3 * 86400000, end: f.now() + 3 * 86400000 + 3600000, capacity: 8 };
  await rejectsCode(f.call('coach', 'editSlot', input), 'FORBIDDEN');
  const result = await f.call('admin', 'editSlot', input);
  assert.equal((await f.get('sessions')).find(s => s.id === result.id)!.capacity, 8);
  const p = await f.publish();
  await rejectsCode(f.call('coach', 'editSlot', { ...input, sessionId: p.id }), 'CAPACITY');
  await rejectsCode(f.call('coach', 'editSlot', { ...input, sessionId: p.id, capacity: 1, end: input.start }), 'TIME');
});

test('管理员整场停课释放所有课时和日程锁，保留原因及通知，重复提交不重复退款', async () => {
  const f = await fixture();
  const s = await f.publish({ kind: 'group', capacity: 10, exclusive: true, roomId: 'studio' });
  for (const who of ['student', 'student2']) {
    const p = await f.purchase(who, { kind: 'group', coachIds: [] });
    await f.call(who, 'book', { sessionId: s.id, packageId: p.id });
  }
  f.advance(2 * 86400000 - 3600000); // Within the student self-cancellation cutoff.
  const booking = (await f.get('bookings')).find(b => b.memberId === userKey('student'))!;
  await rejectsCode(f.call('student', 'cancel', { bookingId: booking.id }), 'LATE_CANCEL');
  const command = { action: 'cancelSession', requestId: 'cancel-whole-class', sessionId: s.id, reason: '教练临时请假' };
  await f.service.execute('admin', command); await f.service.execute('admin', command);
  await f.call('admin', 'cancelSession', { sessionId: s.id, reason: '重复操作' });
  const session = (await f.get('sessions'))[0]!;
  assert.equal(session.status, 'closed'); assert.equal(session.reserved, 0); assert.equal(session.cancelReason, '教练临时请假');
  assert.ok((await f.get('bookings')).every(b => b.status === 'cancelled'));
  assert.ok((await f.get('memberPackages')).every(p => p.available === 10 && p.frozen === 0));
  assert.equal((await f.get('creditLedger')).filter(l => l.type === 'release').length, 2);
  assert.equal((await f.get('inbox')).filter(m => m.title.includes('教练临时请假')).length, 4);
  assert.ok((await f.get('scheduleLocks')).every(l => l.entries.length === 0));
  await f.publish({ kind: 'group', capacity: 10, exclusive: true, roomId: 'studio', start: session.start, end: session.end });
});

test('停课拒绝教练和学员，已开始场次及空原因；名单不完整时不释放部分课时', async () => {
  const f = await fixture(); const s = await f.publish(); const p = await f.purchase();
  await f.call('student', 'book', { sessionId: s.id, packageId: p.id });
  const input = { sessionId: s.id, reason: '场地维护' };
  await rejectsCode(f.call('coach', 'cancelSession', input), 'FORBIDDEN');
  await rejectsCode(f.call('student', 'cancelSession', input), 'FORBIDDEN');
  await assert.rejects(f.call('admin', 'cancelSession', { ...input, reason: '  ' }));
  const originalList = f.store.list.bind(f.store);
  f.store.list = async (table, filter, limit) => {
    const rows = await originalList(table, filter, limit);
    return table === 'bookings' ? rows.slice(0, 0) : rows;
  };
  await rejectsCode(f.call('admin', 'cancelSession', input), 'ROSTER_CHANGED');
  f.store.list = originalList;
  assert.equal((await f.get('sessions'))[0]!.status, 'open');
  assert.equal((await f.get('memberPackages'))[0]!.frozen, 1);
  f.advance(2 * 86400000);
  await rejectsCode(f.call('admin', 'cancelSession', input), 'STATE');
});

test('停课遇到后续学员课包异常时回滚前面已处理的预约、流水与通知', async () => {
  const f = await fixture(); const s = await f.publish({ kind: 'group', capacity: 10 });
  const a = await f.purchase('student', { kind: 'group', coachIds: [] });
  const b = await f.purchase('student2', { kind: 'group', coachIds: [] });
  await f.call('student', 'book', { sessionId: s.id, packageId: a.id });
  await f.call('student2', 'book', { sessionId: s.id, packageId: b.id });
  await f.store.transaction(async tx => {
    const pack = (await tx.get('memberPackages', b.id))!;
    pack.available = pack.total; pack.frozen = 0; await tx.put('memberPackages', pack);
  });
  const ledgerBefore = await f.get('creditLedger'); const inboxBefore = await f.get('inbox');
  await rejectsCode(f.call('admin', 'cancelSession', { sessionId: s.id, reason: '临时停课' }), 'BALANCE');
  assert.deepEqual(await f.get('creditLedger'), ledgerBefore);
  assert.deepEqual(await f.get('inbox'), inboxBefore);
  assert.ok((await f.get('bookings')).every(b => b.status === 'confirmed'));
  assert.equal((await f.get('memberPackages')).find(p => p.id === a.id)!.frozen, 1);
  assert.equal((await f.get('sessions'))[0]!.reserved, 2);
});
