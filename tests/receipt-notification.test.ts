import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStore } from '../server/memory-store';
import { GymService, userKey } from '../server/service';
import { wechatIdentity } from '../server/identity';
import { bindReceiptRecipient, deliverReceipt, receiptTemplateId, ReceiptPayload } from '../server/receipt-notification';
import { loginHandler } from '../server/login';

const appid = 'wx6d8fac347b122572';
const identity = (name: string) => wechatIdentity(appid, name);
const caller = (name: string) => ({ uid: name, customUserId: identity(name), isAnonymous: false });
async function fixture() {
  const store = new MemoryStore(); let now = Date.parse('2026-11-01T08:00:00+08:00');
  const service = new GymService(store, () => now);
  await store.transaction(async tx => {
    for (const [name, roles] of [['admin', ['admin']], ['coach', ['coach']], ['student', ['student']], ['other', ['coach']]] as const) {
      await tx.put('users', { id: userKey(identity(name)), name, phone: '13800000000', roles: [...roles], status: 'active' });
    }
  });
  let requestId = 0;
  const call = (name: string, command: object) => service.execute(identity(name), { requestId: `receipt-test-${++requestId}`, ...command }) as Promise<{ id: string }>;
  const pack = await call('admin', { action: 'recharge', memberId: userKey(identity('student')), amountFen: 50000, prices: { private: 20000, group: 10000 }, expiresAt: now + 30 * 86400000, method: 'transfer', note: 'test' });
  const session = await call('admin', { action: 'publish', kind: 'private', coachId: userKey(identity('coach')), title: '力量训练', roomId: '训练区', exclusive: false, start: now + 86400000, end: now + 86400000 + 3600000, capacity: 1, cost: 1 });
  const booking = await call('student', { action: 'book', sessionId: session.id, packageId: pack.id, expectedAmountFen: 20000 });
  now += 2 * 86400000;
  const send = (sender: { send(p: ReceiptPayload): Promise<{ errcode: number }> }, who = 'coach') => deliverReceipt(store, caller(who), { action: 'sendReceipt', bookingId: booking.id }, sender, appid, 'developer');
  const notices = () => store.list('inbox', { bookingId: booking.id }, 10);
  return { store, service, call, booking, send, notices };
}

test('到课通知原子入队，真实微信身份绑定，消息映射正确且并发/重复请求不重复发送', async () => {
  const f = await fixture();
  await bindReceiptRecipient(f.store, appid, 'student');
  await f.call('coach', { action: 'settle', bookingId: f.booking.id, outcome: 'attended' });
  await f.call('coach', { action: 'settle', bookingId: f.booking.id, outcome: 'attended' });
  assert.equal((await f.notices()).filter(n => n.wxDelivery).length, 1);
  let sends = 0;
  const sender = { async send(p: ReceiptPayload) {
    sends++; assert.equal(p.touser, 'student'); assert.equal(p.template_id, receiptTemplateId);
    assert.equal(p.data.name1?.value, '力量训练'); assert.equal(p.data.name2?.value, 'coach');
    assert.equal(p.data.date3?.value, '2026-11-02'); assert.equal(p.data.thing4?.value, '训练区');
    assert.match(p.data.thing5!.value, /08:00-09:00/);
    return { errcode: 0 };
  } };
  await Promise.all([f.send(sender), f.send(sender)]); await f.send(sender);
  assert.equal(sends, 1); assert.equal((await f.notices()).find(n => n.wxDelivery)?.wxDelivery?.state, 'sent');
  for (const who of ['student', 'admin']) {
    const dashboard = await f.service.execute(identity(who), { action: 'dashboard' });
    assert.ok(!JSON.stringify(dashboard).includes('receiptRecipient'));
    assert.ok(!JSON.stringify(dashboard).includes('openid'));
  }
});

test('拒绝越权发送、未绑定不发送、明确拒收可重订阅后重试，超时不自动重发', async () => {
  const f = await fixture();
  await f.call('coach', { action: 'settle', bookingId: f.booking.id, outcome: 'attended' });
  let calls = 0; const sender = { async send() { calls++; return { errcode: 43101 }; } };
  await assert.rejects(f.send(sender, 'student')); await assert.rejects(f.send(sender, 'other'));
  assert.equal((await f.send(sender)).state, 'needs_subscription'); assert.equal(calls, 0);
  await bindReceiptRecipient(f.store, appid, 'student');
  assert.equal((await f.send(sender)).state, 'needs_subscription'); assert.equal(calls, 1);
  assert.equal((await f.send({ async send() { throw new Error('sensitive network response'); } })).state, 'unknown');
  await f.send(sender); assert.equal(calls, 1);
  assert.equal((await f.store.list('memberPackages', {}, 10))[0]?.consumed, 20000);
  assert.ok(!JSON.stringify(await f.notices()).includes('sensitive'));
});

test('爽约不创建完成通知；绑定端只接受微信换取的身份且不返回 OpenID 或 ticket', async () => {
  const f = await fixture();
  await f.call('coach', { action: 'settle', bookingId: f.booking.id, outcome: 'absent' });
  assert.equal((await f.notices()).filter(n => n.wxDelivery).length, 0);
  await assert.rejects(f.send({ async send() { throw new Error('must not send'); } }));
  const login = loginHandler({ settings: () => ({ appid, secret: 'server-only' }), exchange: async () => ({ openid: 'student', session_key: 'private' }), ticket: () => { throw new Error('must not mint ticket'); }, bindReceipt: (app, openid) => bindReceiptRecipient(f.store, app, openid) });
  const result = await login({ httpMethod: 'POST', body: JSON.stringify({ code: 'valid-code', subscribeReceipt: true }) });
  assert.deepEqual(JSON.parse(result.body), { ok: true });
  assert.equal((await login({ httpMethod: 'POST', body: JSON.stringify({ code: 'valid-code', subscribeReceipt: true, openid: 'victim' }) })).statusCode, 400);
  await assert.rejects(bindReceiptRecipient(f.store, appid, 'unregistered'));
});
