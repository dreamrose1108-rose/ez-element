import cloudbase from '@cloudbase/node-sdk';
import { z } from 'zod';
import { exchangeWechatCode, loginHandler } from './login';
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
export const main = loginHandler({
  settings() { const { env } = configured(); return { appid: env.EZ_APP_ID, secret: env.EZ_WX_APP_SECRET }; },
  exchange: exchangeWechatCode,
  ticket(identity) {
    const { env, credentials } = configured();
    const options = {
      refresh: 3600000, expire: Date.now() + 86400000, allowInsecureKeySizes: false,
    };
    return cloudbase.init({ env: env.EZ_ENV_ID, credentials }).auth().createTicket(identity, options);
  },
});
