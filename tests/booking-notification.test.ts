import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStore } from '../server/memory-store';
import { queueBookingNotification, dispatchBookingNotifications, bookingTemplates } from '../server/booking-notification';
import { Booking, Session } from '../server/model';
import { ReceiptPayload } from '../server/receipt-notification';

const now = Date.parse('2026-11-01T08:00:00+08:00');
async function fixture() {
  const store = new MemoryStore();
  const session: Session = { id: 'class', kind: 'group', title: '瑜伽团课', coachId: 'coach', roomId: '一号馆', exclusive: false, start: now + 3 * 3600000, end: now + 4 * 3600000, capacity: 5, reserved: 1, cost: 1, status: 'open', cancelHours: 0, cutoffMinutes: 0 };
  const booking: Booking = { id: 'booking', sessionId: session.id, memberId: 'member', packageId: 'wallet', cost: 1, status: 'confirmed', createdAt: now, cancelHours: 0 };
  await store.transaction(async tx => {
    await tx.put('users', { id: 'member', name: '学员', phone: '13800000000', roles: ['student'], status: 'active', receiptRecipient: { appid: 'app', openid: 'private-id', enabledAt: now } });
    await tx.put('users', { id: 'coach', name: 'Rose', phone: '13800000001', roles: ['coach'], status: 'active' });
    await tx.put('sessions', session); await tx.put('bookings', booking);
    await queueBookingNotification(tx, booking, session, 'booked', now);
    await queueBookingNotification(tx, booking, session, 'booked', now);
  });
  const sent: ReceiptPayload[] = [];
  const sender = { async send(p: ReceiptPayload) { sent.push(p); return { errcode: 0 }; } };
  const run = (at = now) => dispatchBookingNotifications(store, sender, 'app', 'developer', at);
  return { store, session, booking, sent, run };
}
test('预约与提前两小时提醒：字段准确、重复和并发定时执行只发送一次', async () => {
  const f = await fixture();
  await Promise.all([f.run(), f.run()]);
  assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0]!.template_id, bookingTemplates.booked);
  assert.deepEqual(f.sent[0]!.data, { thing6: { value: '瑜伽团课' }, time3: { value: '2026-11-01 11:00' }, name2: { value: 'Rose' }, thing8: { value: '团课 · 一号馆' } });
  await f.run(now + 3599999); assert.equal(f.sent.length, 1);
  await Promise.all([f.run(now + 3600000), f.run(now + 3600000)]);
  assert.equal(f.sent.length, 2);
  assert.equal(f.sent[1]!.template_id, bookingTemplates.reminder);
  assert.deepEqual(Object.keys(f.sent[1]!.data).sort(), ['thing2', 'name3', 'date4', 'thing6', 'thing5'].sort());
  await f.run(now + 3600001); assert.equal(f.sent.length, 2);
});
test('取消与门店停课：旧成功/提醒任务失效，取消原因和会员字段准确', async () => {
  const f = await fixture();
  await f.store.transaction(async tx => {
    f.booking.status = 'cancelled'; f.booking.cancelReason = '教练请假';
    f.session.status = 'closed';
    await tx.put('bookings', f.booking); await tx.put('sessions', f.session);
    await queueBookingNotification(tx, f.booking, f.session, 'cancelled', now, '教练请假');
  });
  await f.run(now + 3600000);
  assert.equal(f.sent.length, 1); assert.equal(f.sent[0]!.template_id, bookingTemplates.cancelled);
  assert.equal(f.sent[0]!.data.thing5!.value, '教练请假'); assert.equal(f.sent[0]!.data.thing9!.value, '学员');
});
test('失去响应不重发；缺少订阅与已开课不发送；未来任务不挤占到期任务', async () => {
  const f = await fixture();
  let calls = 0;
  const timeout = { async send() { calls++; throw new Error('timeout'); } };
  await dispatchBookingNotifications(f.store, timeout, 'app', 'developer', now);
  await dispatchBookingNotifications(f.store, timeout, 'app', 'developer', now);
  assert.equal(calls, 1);
  await f.run(f.session.start); assert.equal(f.sent.length, 0);
  const g = await fixture();
  await g.store.transaction(async tx => { const member = (await tx.get('users', 'member'))!; delete member.receiptRecipient; await tx.put('users', member); });
  await g.run(); assert.equal(g.sent.length, 0);
  assert.ok((await g.store.list('inbox', {}, 100)).some(n => n.notification?.state === 'needs_subscription'));
  const h = await fixture();
  await h.store.transaction(async tx => {
    for (let i = 0; i < 1001; i++) await tx.put('inbox', { id: `future-${i}`, userId: 'member', bookingId: 'booking', title: 'future', at: now, notification: { kind: 'reminder', dueAt: now + 86400000, state: 'pending', updatedAt: now } });
  });
  await h.run(); assert.equal(h.sent.length, 1);
});
