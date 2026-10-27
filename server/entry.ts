import cloudbase from '@cloudbase/node-sdk';
import wxCloud from 'wx-server-sdk';
import { ZodError } from 'zod';
import { BusinessError } from './model';
import { CloudDatabase, CloudStore } from './cloud-store';
import { GymService } from './service';

export async function main(event: unknown) {
  try {
    const env = process.env.EZ_ENV_ID;
    const appid = process.env.EZ_APP_ID;
    if (!env || !appid) return { ok: false, code: 'NOT_CONFIGURED', message: '门店服务尚未配置完成' };
    wxCloud.init({ env });
    const caller = wxCloud.getWXContext();
    if (!caller.OPENID || caller.APPID !== appid) return { ok: false, code: 'UNAUTHENTICATED', message: '请从元素领域小程序访问' };
    const db = cloudbase.init({ env }).database() as unknown as CloudDatabase;
    const data = await new GymService(new CloudStore(db)).execute(caller.OPENID, event);
    return { ok: true, data };
  } catch (error) {
    if (error instanceof BusinessError) return { ok: false, code: error.code, message: error.message };
    if (error instanceof ZodError) return { ok: false, code: 'INVALID_INPUT', message: '提交内容不正确，请检查必填项' };
    // Never echo event/context/SDK errors: they may contain credentials or PII.
    console.error('EZ_API_FAILURE', error instanceof Error ? error.name : 'UnknownError');
    return { ok: false, code: 'INTERNAL', message: '服务暂时不可用，请稍后使用同一请求重试' };
  }
}
