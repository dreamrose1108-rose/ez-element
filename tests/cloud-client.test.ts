import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { build } from 'esbuild';

async function bundle(fakeSdk: boolean) {
  return (await build({ entryPoints: ['miniprogram/services/api.ts'], bundle: true, write: false, platform: 'neutral', mainFields: ['main', 'module'], format: 'cjs', plugins: [{ name: 'test-config', setup(builder) {
    builder.onLoad({ filter: /miniprogram[\\/]config\.ts$/ }, () => ({ contents: `export const config = { mode: 'cloud', envId: 'test-env', loginUrl: 'https://test-env.service.tcloudbase.com/getLoginTicket', demoUrl: '' };`, loader: 'ts' }));
    if (fakeSdk) {
      builder.onResolve({ filter: /^@cloudbase\/(js-sdk\/miniprogram_dist\/index.js|adapter-wx_mp)$/ }, args => ({ path: args.path, namespace: 'test-sdk' }));
      builder.onLoad({ filter: /.*/, namespace: 'test-sdk' }, args => ({ contents: args.path.includes('js-sdk') ? 'module.exports = testSdk;' : 'module.exports = {};', loader: 'js' }));
    }
  } }] })).outputFiles[0]!.text;
}
interface ApiModule { api(role: string, cmd: object): Promise<unknown> }
function sandbox() {
  const exported = { exports: {} as ApiModule };
  return { exported, context: { module: exported, exports: exported.exports, console, setTimeout, clearTimeout, setInterval, clearInterval } };
}

test('cloud client preserves request IDs after uncertain network failure and one auth refresh', async () => {
  const { exported, context } = sandbox();
  let session = false; let logins = 0; let signs = 0; let calls = 0; const sent: Record<string, unknown>[] = [];
  const testSdk = { useAdapters() {}, init() { return {
    auth: () => ({ getLoginState: async () => session ? {} : null, signOut: async () => { session = false; },
      signInWithCustomTicket: async (getTicket: () => Promise<string>) => { assert.equal(await getTicket(), 'ticket'); signs++; session = true; },
    }),
    callFunction: async ({ data }: { data: Record<string, unknown> }) => {
      sent.push(data); calls++;
      if (calls === 1) throw new Error('network outcome unknown');
      if (calls === 2) return { result: { ok: false, code: 'UNAUTHENTICATED' } };
      return { result: { ok: true, data: { id: 'booking' } } };
    },
  }; } };
  vm.runInNewContext(await bundle(true), { ...context, testSdk, wx: {
    login: ({ success }: { success(value: object): void }) => { logins++; success({ code: 'code' }); },
    request: (opts: { data: object; success(value: object): void }) => { assert.equal(JSON.stringify(opts.data), '{"code":"code"}'); opts.success({ statusCode: 200, data: { ok: true, ticket: 'ticket' } }); },
  } });
  const cmd = { action: 'book', sessionId: 's', packageId: 'p' };
  await assert.rejects(exported.exports.api('student', cmd), /云端请求未完成/);
  assert.equal(JSON.stringify(await exported.exports.api('student', cmd)), '{"id":"booking"}');
  assert.equal(logins, 2); assert.equal(signs, 2); assert.equal(calls, 3);
  assert.equal(new Set(sent.map(c => c.requestId)).size, 1);
  assert.ok(sent.every(c => !('role' in c) && !('openid' in c)));
  await exported.exports.api('student', cmd);
  assert.notEqual(sent[3]!.requestId, sent[0]!.requestId);
});

test('packaged real SDK and wx adapter initialize without browser globals before wx.login', async () => {
  const { exported, context } = sandbox();
  let loginCalled = false;
  const storage = new Map<string, unknown>();
  vm.runInNewContext(await bundle(false), { ...context, Page() {}, App() {}, wx: {
    getSystemInfoSync: () => ({ platform: 'devtools' }), getAccountInfoSync: () => ({ miniProgram: { appId: 'wx6d8fac347b122572' } }),
    getStorageSync: (key: string) => storage.get(key), setStorageSync: (key: string, value: unknown) => storage.set(key, value),
    removeStorageSync: (key: string) => storage.delete(key), clearStorageSync: () => storage.clear(),
    connectSocket() {}, onAppHide() {}, offAppHide() {}, onAppShow() {}, offAppShow() {},
    request() { throw new Error('Unexpected network request in SDK initialization'); },
    login: ({ fail }: { fail(): void }) => { loginCalled = true; fail(); },
  } });
  await assert.rejects(exported.exports.api('student', { action: 'dashboard' }), /微信登录失败/);
  assert.equal(loginCalled, true);
});

test('resolved SDK login errors stop business calls and allow a successful retry', async () => {
  const { exported, context } = sandbox();
  let signedIn = false; let signs = 0; let calls = 0;
  const testSdk = { useAdapters() {}, init() { return {
    auth: () => ({ getLoginState: async () => signedIn ? {} : null, signOut: async () => { signedIn = false; },
      signInWithCustomTicket: async () => {
        if (++signs === 1) return { data: {}, error: { errMsg: 'request:fail url not in domain list' } };
        signedIn = true; return { data: { session: {} }, error: null };
      },
    }),
    callFunction: async () => { calls++; return { result: { ok: true, data: { profile: null } } }; },
  }; } };
  vm.runInNewContext(await bundle(true), { ...context, testSdk, wx: {
    login: ({ success }: { success(value: object): void }) => success({ code: 'code' }),
    request: ({ success }: { success(value: object): void }) => success({ statusCode: 200, data: { ok: true, ticket: 'ticket' } }),
  } });
  await assert.rejects(exported.exports.api('student', { action: 'dashboard' }), /云端登录未完成（REQUEST_DOMAIN）/);
  assert.equal(calls, 0);
  assert.equal(JSON.stringify(await exported.exports.api('student', { action: 'dashboard' })), '{"profile":null}');
  assert.equal(calls, 1); assert.equal(signs, 2);
});
