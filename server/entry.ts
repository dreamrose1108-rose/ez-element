import cloudbase from '@cloudbase/node-sdk';
import { managerPostgresStore } from './manager-postgres-store';
import { apiHandler } from './api-handler';
export async function main(event: unknown) {
  const env = process.env.EZ_ENV_ID;
  if (!env) {
    return { ok: false, code: 'NOT_CONFIGURED', message: '门店服务尚未配置完成' };
  }
  // Read the platform-injected identity on EVERY invocation. Never initialize
  // SDK context from an event/header field supplied by a caller.
  return apiHandler(() => cloudbase.init({ env }).auth().getUserInfo(), managerPostgresStore)(event);
}
