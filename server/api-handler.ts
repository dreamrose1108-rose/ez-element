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
      if (error instanceof ZodError) {
        const labels: Record<string, string> = { memberId: '学员', userId: '学员', amountFen: '实收金额', 'prices.private': '私教单价', 'prices.group': '团课单价', prices: '课程单价', expiresAt: '有效期', note: '收款凭据 / 备注', name: '姓名', phone: '手机号', birthday: '生日', salesCoachId: '业绩归属教练' };
        const field = error.issues.map(issue => labels[issue.path.join('.')]).find(Boolean);
        const unsupported = error.issues.some(issue => issue.path[0] === 'action');
        return { ok: false, code: 'INVALID_INPUT', message: field ? `请检查${field}是否填写正确` : unsupported ? '当前服务不支持此操作，请确认前后端版本已同步' : '提交内容不正确，请检查必填项' };
      }
      console.error('EZ_API_FAILURE', error instanceof Error ? error.name : 'UnknownError');
      return { ok: false, code: 'INTERNAL', message: '服务暂时不可用，请稍后使用同一请求重试' };
    }
  };
}
