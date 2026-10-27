import test from 'node:test';
import assert from 'node:assert/strict';
import { loginHandler, LoginDeps } from '../server/login';
import { apiHandler } from '../server/api-handler';
import { wechatIdentity, TrustedCaller } from '../server/identity';
import { MemoryStore } from '../server/memory-store';
import { userKey } from '../server/service';
import { LoginSession } from '../miniprogram/services/login-session';
const post = (body: unknown) => ({ httpMethod: 'POST', body: JSON.stringify(body) });
const settings = { appid: 'wx6d8fac347b122572', secret: 'secret-only-on-server' };
function loginFixture() {
  let signed = ''; let exchanges = 0;
  const deps: LoginDeps = { settings: () => settings,
    exchange: async (code, supplied) => { assert.equal(code, 'valid-code'); assert.deepEqual(supplied, settings); exchanges++; return { openid: 'wechat-openid', session_key: 'session-secret', unionid: 'private-unionid' }; },
    ticket: identity => { signed = identity; return 'signed-ticket'; },
  };
  return { deps, handler: loginHandler(deps), signed: () => signed, exchanges: () => exchanges };
}
test('ticket endpoint only accepts a WeChat code, never caller-provided identities or roles', async () => {
  const f = loginFixture();
  for (const event of [post({ code: 'valid-code', openid: 'victim' }), post({ code: 'valid-code', role: 'admin' }), post({ code: '' }), post({ code: 'x'.repeat(5000) }), { httpMethod: 'POST', body: '{' }, { httpMethod: 'POST', body: '{}', isBase64Encoded: true }]) {
    assert.equal((await f.handler(event)).statusCode, 400);
  }
  assert.equal((await f.handler({ code: 'valid-code' })).statusCode, 405);
  assert.equal(f.exchanges(), 0); assert.equal(f.signed(), '');
  const result = await f.handler(post({ code: 'valid-code' }));
  assert.equal(result.statusCode, 200);
  assert.deepEqual(JSON.parse(result.body), { ok: true, ticket: 'signed-ticket' });
  assert.equal(result.headers['Cache-Control'], 'no-store');
  assert.equal(f.signed(), wechatIdentity(settings.appid, 'wechat-openid'));
  assert.match(f.signed(), /^wx_[0-9a-f]{29}$/);
  assert.notEqual(f.signed(), wechatIdentity('another-app', 'wechat-openid'));
});
test('failed/expired WeChat codes cannot mint tickets; upstream secrets never appear in errors', async () => {
  const f = loginFixture();
  for (const result of [{ errcode: 40029, errmsg: settings.secret }, {}, { openid: 'x' }, { errcode: 40029, openid: 'x', session_key: 'x' }]) {
    f.deps.exchange = async () => result;
    const response = await f.handler(post({ code: 'valid-code' }));
    assert.equal(response.statusCode, 401); assert.ok(!response.body.includes(settings.secret));
    assert.equal(f.signed(), '');
  }
  f.deps.exchange = async () => { throw new Error(settings.secret); };
  assert.equal((await f.handler(post({ code: 'valid-code' }))).statusCode, 503);
  f.deps.settings = () => { throw new Error(settings.secret); };
  const missing = await f.handler(post({ code: 'valid-code' }));
  assert.equal(JSON.parse(missing.body).code, 'NOT_CONFIGURED'); assert.ok(!missing.body.includes(settings.secret));
});
test('business API rejects missing/anonymous/wrong-source identity before opening the database', async () => {
  let opened = false;
  for (const caller of [{}, { uid: 'u' }, { uid: 'u', customUserId: wechatIdentity(settings.appid, 'a'), isAnonymous: true }, { uid: 'u', customUserId: 'admin', isAnonymous: false }]) {
    const response = await apiHandler(() => caller, () => { opened = true; return new MemoryStore(); })({ action: 'dashboard', uid: 'admin', openid: 'victim' });
    assert.equal(response.ok, false); assert.ok('code' in response && response.code === 'UNAUTHENTICATED');
  }
  assert.equal(opened, false);
});
test('warm API invocations re-read trusted identity; client cannot register as admin or another user', async () => {
  const store = new MemoryStore();
  const first = wechatIdentity(settings.appid, 'a'); const second = wechatIdentity(settings.appid, 'b');
  let caller: TrustedCaller = { uid: 'platform-a', customUserId: first, isAnonymous: false };
  const api = apiHandler(() => caller, () => store);
  assert.equal((await api({ action: 'register', name: 'A', phone: '13800000000', roles: ['admin'] })).ok, false);
  assert.equal((await api({ action: 'register', name: 'A', phone: '13800000000' })).ok, true);
  caller = { uid: 'platform-b', customUserId: second, isAnonymous: false };
  const fresh = await api({ action: 'dashboard' });
  assert.ok('data' in fresh && fresh.data && 'profile' in fresh.data && fresh.data.profile === null);
  assert.equal((await api({ action: 'register', name: 'B', phone: '13800000000' })).ok, true);
  assert.deepEqual((await store.transaction(tx => tx.get('users', userKey(first))))?.roles, ['student']);
  assert.equal((await store.transaction(tx => tx.get('users', userKey(second))))?.name, 'B');
});
test('client shares one in-flight login; errors permit retry and forced login clears old session', async () => {
  let tickets = 0; let signs = 0; let outs = 0; let valid = false; let fail = true;
  const session = new LoginSession({ hasSession: async () => valid,
    getTicket: async () => { tickets++; if (fail) throw new Error('network'); return 'ticket'; },
    signIn: async value => { assert.equal(value, 'ticket'); signs++; valid = true; },
    signOut: async () => { outs++; valid = false; },
  });
  const failed = await Promise.allSettled([session.ensure(), session.ensure(), session.ensure()]);
  assert.equal(failed.filter(r => r.status === 'rejected').length, 3); assert.equal(tickets, 1);
  fail = false;
  await Promise.all([session.ensure(), session.ensure()]); assert.equal(tickets, 2); assert.equal(signs, 1);
  await session.ensure(); assert.equal(tickets, 2);
  await Promise.all([session.ensure(true), session.ensure(true)]); assert.equal(outs, 1); assert.equal(signs, 2);
});
