import { ZodError } from 'zod';
import { BusinessError, Store } from './model';
import { authenticatedIdentity, TrustedCaller } from './identity';
import { GymService } from './service';
// CloudBase appends tcbContext (and may append userInfo) to the event. These are
// transport metadata, never
// an authority for identity or roles. Keep all other fields for strict validation.
function businessCommand(event: unknown): unknown {
  if (!event || typeof event !== 'object' || Array.isArray(event)) return event;
  const { userInfo: _userInfo, tcbContext: _tcbContext, ...command } = event as Record<string, unknown>;
  return command;
}
export function apiHandler(getCaller: () => TrustedCaller, getStore: () => Store) {
  return async (event: unknown) => {
    try {
      const identity = authenticatedIdentity(getCaller());
      const data = await new GymService(getStore()).execute(identity, businessCommand(event));
      return { ok: true, data };
    } catch (error) {
      if (error instanceof BusinessError) return { ok: false, code: error.code, message: error.message };
      if (error instanceof ZodError) return { ok: false, code: 'INVALID_INPUT', message: '提交内容不正确，请检查必填项' };
      console.error('EZ_API_FAILURE', error instanceof Error ? error.name : 'UnknownError');
      return { ok: false, code: 'INTERNAL', message: '服务暂时不可用，请稍后使用同一请求重试' };
    }
  };
}
