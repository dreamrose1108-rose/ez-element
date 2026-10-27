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
  return new Promise<string>((resolve, reject) => wx.request<{ ok?: boolean; ticket?: string; code?: string }>({
    url: config.loginUrl, method: 'POST', timeout: 12000, data: { code },
    header: { 'content-type': 'application/json' },
    success: response => {
      if (response.statusCode === 200 && response.data?.ok === true && typeof response.data.ticket === 'string' && response.data.ticket) resolve(response.data.ticket);
      else {
        const messages: Record<string, string> = {
          LOGIN_REJECTED: '微信登录凭证校验失败，请重试',
          NOT_CONFIGURED: '云端登录配置尚未完成',
          LOGIN_UNAVAILABLE: '云端登录服务暂时不可用',
          METHOD_NOT_ALLOWED: '云端登录请求方式不正确',
          INVALID_INPUT: '云端登录请求格式不正确',
        };
        reject(new Error(messages[String(response.data?.code)] || `云端登录失败（HTTP ${response.statusCode}）`));
      }
    },
    fail: error => {
      const detail = String(error.errMsg || '').toLowerCase();
      if (detail.includes('domain list')) reject(new Error('登录域名未加入微信后台 request 合法域名'));
      else if (detail.includes('timeout')) reject(new Error('连接云端登录服务超时'));
      else reject(new Error('无法连接云端登录服务，请检查网络'));
    },
  }));
}
function authError(error: unknown): boolean {
  const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
  return ['UNAUTHORIZED', 'UNAUTHENTICATED', 'ACCESS_TOKEN_EXPIRED', 'INVALID_ACCESS_TOKEN', 'CHECK_LOGIN_FAILED'].includes(String(code));
}

function cloudFailureCode(error: unknown): string {
  const value = error && typeof error === 'object' ? error as Record<string, unknown> : {};
  const detail = [value.message, value.errMsg, value.error_description].map(String).join(' ').toLowerCase();
  if (detail.includes('domain list')) return 'REQUEST_DOMAIN';
  if (detail.includes('timeout') || detail.includes('timed out')) return 'TIMEOUT';
  if (detail.includes('network') || detail.includes('request:fail')) return 'NETWORK';
  if (detail.includes('not found') || detail.includes('not exist')) return 'FUNCTION_NOT_FOUND';
  if (detail.includes('permission') || detail.includes('forbidden')) return 'PERMISSION_DENIED';
  const raw = [value.code, value.errorCode, value.errCode].find(item => typeof item === 'string' || typeof item === 'number');
  const code = String(raw || '').toUpperCase();
  return /^[A-Z0-9_.:-]{1,64}$/.test(code) ? code : 'UNKNOWN';
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
      // Do not expose SDK messages, URLs, headers or tokens. The short category
      // is enough to distinguish domain, timeout, permission and platform errors.
      // A network failure may follow a successful commit, so api.ts keeps the
      // pending request ID intact for the user's retry.
      throw new Error(`云端请求未完成（${cloudFailureCode(error)}），请稍后重试`);
    }
  }
}
