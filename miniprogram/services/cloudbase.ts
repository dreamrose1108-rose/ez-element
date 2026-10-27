import { config } from '../config';
import { LoginSession } from './login-session';

type CloudApp = ReturnType<typeof import('@cloudbase/js-sdk').init>;
let client: CloudApp | undefined;
let login: LoginSession | undefined;

function getClient(): { client: CloudApp; login: LoginSession } {
  if (!config.envId || !/^https:\/\/[^\s/?#]+\/[^\s]*$/.test(config.loginUrl)) throw new Error('云端登录服务尚未配置');
  if (!client) {
    // Lazy require prevents SDK browser/global initialization during demo mode.
    const sdk = require('@cloudbase/js-sdk/miniprogram_dist/index.js') as typeof import('@cloudbase/js-sdk');
    const adapterModule = require('@cloudbase/adapter-wx_mp') as { default?: unknown };
    sdk.useAdapters((adapterModule.default || adapterModule) as Parameters<typeof sdk.useAdapters>[0]);
    client = sdk.init({ env: config.envId, timeout: 15000 });
    const auth = client.auth({ persistence: 'local' });
    login = new LoginSession({
      hasSession: async () => Boolean(await auth.getLoginState()),
      getTicket,
      signIn: ticket => auth.signInWithCustomTicket(() => Promise.resolve(ticket)),
      signOut: () => auth.signOut(),
    });
  }
  return { client, login: login! };
}
async function getTicket(): Promise<string> {
  const code = await new Promise<string>((resolve, reject) => wx.login({ timeout: 10000,
    success: value => value.code ? resolve(value.code) : reject(new Error('未获取到微信登录凭证')),
    fail: () => reject(new Error('微信登录失败，请重试')),
  }));
  return new Promise<string>((resolve, reject) => wx.request<{ ok?: boolean; ticket?: string }>({
    url: config.loginUrl, method: 'POST', timeout: 12000, data: { code },
    header: { 'content-type': 'application/json' },
    success: response => {
      if (response.statusCode === 200 && response.data?.ok === true && typeof response.data.ticket === 'string' && response.data.ticket) resolve(response.data.ticket);
      else reject(new Error('云端登录失败，请稍后重试'));
    },
    fail: () => reject(new Error('无法连接云端登录服务，请检查网络')),
  }));
}
function authError(error: unknown): boolean {
  const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
  return ['UNAUTHORIZED', 'UNAUTHENTICATED', 'ACCESS_TOKEN_EXPIRED', 'INVALID_ACCESS_TOKEN', 'CHECK_LOGIN_FAILED'].includes(String(code));
}
export async function callCloud(command: Record<string, unknown>): Promise<unknown> {
  const { client, login } = getClient();
  await login.ensure();
  for (let attempt = 0; ; attempt++) {
    try {
      const response = await client.callFunction({ name: 'api', data: command, parse: true });
      const result = response.result;
      if (result && typeof result === 'object' && 'ok' in result && result.ok === false && authError(result) && attempt === 0) {
        await login.ensure(true);
        continue;
      }
      return result;
    } catch (error) {
      if (attempt === 0 && authError(error)) { await login.ensure(true); continue; }
      // Do not leak SDK errors/tokens. A network failure may follow a successful
      // commit: leave api.ts's pending request ID intact for the user's retry.
      throw new Error('云端请求未完成，请稍后重试');
    }
  }
}
