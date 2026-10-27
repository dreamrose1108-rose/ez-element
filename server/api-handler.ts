import { ZodError } from 'zod';
import { BusinessError, Store } from './model';
import { authenticatedIdentity, TrustedCaller } from './identity';
import { GymService } from './service';
export function apiHandler(getCaller: () => TrustedCaller, getStore: () => Store) {
  return async (event: unknown) => {
    try {
      const identity = authenticatedIdentity(getCaller());
      const data = await new GymService(getStore()).execute(identity, event);
      return { ok: true, data };
    } catch (error) {
      if (error instanceof BusinessError) return { ok: false, code: error.code, message: error.message };
      if (error instanceof ZodError) return { ok: false, code: 'INVALID_INPUT', message: '提交内容不正确，请检查必填项' };
      console.error('EZ_API_FAILURE', error instanceof Error ? error.name : 'UnknownError');
      return { ok: false, code: 'INTERNAL', message: '服务暂时不可用，请稍后使用同一请求重试' };
    }
  };
}
