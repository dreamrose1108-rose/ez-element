import { createHash } from 'node:crypto';
import { BusinessError } from './model';
// Opaque, app-scoped IDs fit CloudBase's 4–32 character limit.
export const customUserPattern = /^wx_[0-9a-f]{29}$/;
export function wechatIdentity(appid: string, openid: string): string {
  return `wx_${createHash('sha256').update(`${appid}:${openid}`).digest('hex').slice(0, 29)}`;
}
export interface TrustedCaller { uid?: string; customUserId?: string; isAnonymous?: boolean }
export function authenticatedIdentity(caller: TrustedCaller): string {
  if (!caller.uid || caller.isAnonymous !== false || !caller.customUserId || !customUserPattern.test(caller.customUserId)) {
    throw new BusinessError('UNAUTHENTICATED', '登录已失效，请重新登录');
  }
  return caller.customUserId;
}
