import cloudbase from '@cloudbase/node-sdk';
import { z } from 'zod';
import { exchangeWechatCode, loginHandler } from './login';
import type { ReceiptSender } from './receipt-notification';
import { BusinessError } from './model';
const settingsSchema = z.object({
  EZ_APP_ID: z.string().regex(/^wx[0-9a-f]{16}$/), EZ_WX_APP_SECRET: z.string().min(1),
  EZ_ENV_ID: z.string().min(1), EZ_TCB_LOGIN_CREDENTIALS: z.string().min(1),
});
const credentialsSchema = z.object({ env_id: z.string().min(1), private_key_id: z.string().min(1), private_key: z.string().min(1) });
function configured() {
  const env = settingsSchema.parse(process.env);
  const credentials = credentialsSchema.parse(JSON.parse(env.EZ_TCB_LOGIN_CREDENTIALS));
  if (credentials.env_id !== env.EZ_ENV_ID) throw new Error('Wrong login key environment');
  return { env, credentials };
}
const login = loginHandler({
  settings() { const { env } = configured(); return { appid: env.EZ_APP_ID, secret: env.EZ_WX_APP_SECRET }; },
  exchange: exchangeWechatCode,
  async bindReceipt(appid, openid) {
    const [{ managerPostgresStore }, { bindReceiptRecipient }] = await Promise.all([import('./manager-postgres-store.js'), import('./receipt-notification.js')]);
    await bindReceiptRecipient(managerPostgresStore(), appid, openid);
  },
  ticket(identity) {
    const { env, credentials } = configured();
    // CloudBase currently issues 1024-bit RSA custom-login keys. Its Node SDK
    // enables compatibility for those provider-managed keys by default.
    const options = { refresh: 3600000, expire: Date.now() + 86400000 };
    return cloudbase.init({ env: env.EZ_ENV_ID, credentials }).auth().createTicket(identity, options);
  },
});
let sender: ReceiptSender | undefined;
export async function main(event: unknown) {
  if (event && typeof event === 'object' && 'httpMethod' in event) return login(event);
  try {
    const { env } = configured();
    const app = cloudbase.init({ env: env.EZ_ENV_ID });
    const [{ managerPostgresStore }, { deliverReceipt, wechatReceiptSender }] = await Promise.all([import('./manager-postgres-store.js'), import('./receipt-notification.js')]);
    sender ||= wechatReceiptSender({ appid: env.EZ_APP_ID, secret: env.EZ_WX_APP_SECRET });
    // Strip only platform transport metadata. All remaining keys are strictly validated.
    const { tcbContext: _context, userInfo: _info, ...command } = (event || {}) as Record<string, unknown>;
    const state = z.enum(['developer', 'trial', 'formal']).parse(process.env.EZ_NOTIFICATION_STATE || 'developer');
    if (command.Type === 'Timer' && command.TriggerName === 'booking-notifications') {
      // A client cannot choose recipients or bypass due-time/status checks. Reject
      // authenticated client invocations of this internal scheduler entry point.
      if (app.auth().getUserInfo().uid) throw new BusinessError('FORBIDDEN', '定时任务不接受客户端调用');
      const { dispatchBookingNotifications } = await import('./booking-notification.js');
      return { ok: true, data: await dispatchBookingNotifications(managerPostgresStore(), sender, env.EZ_APP_ID, state) };
    }
    const result = await deliverReceipt(managerPostgresStore(), app.auth().getUserInfo(), command, sender, env.EZ_APP_ID, state);
    return { ok: true, data: result };
  } catch (error) {
    return { ok: false, code: error instanceof BusinessError ? error.code : 'NOTIFICATION_FAILED', message: error instanceof BusinessError ? error.message : '微信通知未完成，请查看通知状态；课程结算不受影响' };
  }
}
