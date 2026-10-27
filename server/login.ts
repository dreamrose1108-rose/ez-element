import { z } from 'zod';
import { wechatIdentity } from './identity';
const input = z.object({ code: z.string().min(1).max(256).regex(/^[A-Za-z0-9_-]+$/) }).strict();
export interface LoginSettings { appid: string; secret: string }
export interface LoginDeps {
  settings(): LoginSettings;
  exchange(code: string, settings: LoginSettings): Promise<unknown>;
  ticket(identity: string): string;
}
function reply(statusCode: number, body: object) {
  return { statusCode, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }, body: JSON.stringify(body), isBase64Encoded: false };
}
export function loginHandler(deps: LoginDeps) {
  return async (event: unknown) => {
    // Only this bootstrap endpoint is exposed via POST. Never accept a caller's
    // openid, role, user ID or AppID in place of a code verified by WeChat.
    if (!event || typeof event !== 'object' || !('httpMethod' in event) || event.httpMethod !== 'POST') {
      return reply(405, { ok: false, code: 'METHOD_NOT_ALLOWED', message: '请使用 POST 登录' });
    }
    const http = event as Record<string, unknown>;
    if (http.isBase64Encoded || typeof http.body !== 'string' || Buffer.byteLength(http.body) > 4096) {
      return reply(400, { ok: false, code: 'INVALID_INPUT', message: '登录请求格式不正确' });
    }
    let code: string;
    try { code = input.parse(JSON.parse(http.body)).code; }
    catch { return reply(400, { ok: false, code: 'INVALID_INPUT', message: '登录请求格式不正确' }); }
    let settings: LoginSettings;
    try { settings = deps.settings(); }
    catch { return reply(503, { ok: false, code: 'NOT_CONFIGURED', message: '登录服务尚未配置完成' }); }
    try {
      const session = z.object({ errcode: z.number().optional(), openid: z.string().min(1).max(128), session_key: z.string().min(1) }).safeParse(await deps.exchange(code, settings));
      if (!session.success || (session.data.errcode !== undefined && session.data.errcode !== 0)) {
        return reply(401, { ok: false, code: 'LOGIN_REJECTED', message: '微信登录凭证已失效，请重试' });
      }
      const ticket = deps.ticket(wechatIdentity(settings.appid, session.data.openid));
      // No openid, session_key, upstream errors, private keys or URLs returned.
      return reply(200, { ok: true, ticket });
    } catch {
      return reply(503, { ok: false, code: 'LOGIN_UNAVAILABLE', message: '登录服务暂时不可用，请稍后重试' });
    }
  };
}
export async function exchangeWechatCode(code: string, settings: LoginSettings): Promise<unknown> {
  const url = new URL('https://api.weixin.qq.com/sns/jscode2session');
  url.search = new URLSearchParams({ appid: settings.appid, secret: settings.secret, js_code: code, grant_type: 'authorization_code' }).toString();
  // The trial CloudBase plan fixes event functions at a 3-second timeout.
  // Leave enough time for the handler to sign and return the custom ticket.
  const response = await fetch(url, { signal: AbortSignal.timeout(2200), redirect: 'error' });
  if (!response.ok) throw new Error('Wechat login unavailable');
  return response.json();
}
