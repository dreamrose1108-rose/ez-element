import { z } from 'zod';
import { Store, requireThat } from './model';
import { authenticatedIdentity, TrustedCaller, wechatIdentity } from './identity';
import { userKey } from './service';

export const receiptTemplateId = 'uQw9Dwn6iRzjlcoCjSnvOlXeeHHAFrDJ8o3xfcnHWbg';
export type DeliveryState = 'pending' | 'sending' | 'sent' | 'needs_subscription' | 'failed' | 'unknown';
export interface ReceiptDelivery { state: DeliveryState; updatedAt: number; code?: number; }
export interface ReceiptPayload {
  touser: string; template_id: string; page: string; miniprogram_state: 'developer' | 'trial' | 'formal';
  data: Record<string, { value: string }>;
}
export interface ReceiptSender { send(payload: ReceiptPayload): Promise<{ errcode: number }> }

// Called only after jscode2session verified the code. No caller-supplied user ID or OpenID.
export async function bindReceiptRecipient(store: Store, appid: string, openid: string, now = Date.now()) {
  await store.transaction(async tx => {
    const id = userKey(wechatIdentity(appid, openid));
    const user = await tx.get('users', id);
    requireThat(user?.status === 'active' && user.roles.includes('student'), 'INACTIVE', '请先完成学员入会审核');
    user.receiptRecipient = { appid, openid, enabledAt: now };
    await tx.put('users', user);
  });
}

const request = z.object({ action: z.literal('sendReceipt'), bookingId: z.string().regex(/^[\w-]{1,128}$/) }).strict();
const short = (value: string, limit: number) => Array.from(value.replace(/[\r\n\t]/g, ' ').trim()).slice(0, limit).join('') || '未填写';

export async function deliverReceipt(store: Store, caller: TrustedCaller, raw: unknown, sender: ReceiptSender, appid: string, state: ReceiptPayload['miniprogram_state'], now = Date.now()) {
  const actorId = userKey(authenticatedIdentity(caller));
  const command = request.parse(raw);
  const notices = await store.list('inbox', { bookingId: command.bookingId }, 10);
  const candidate = notices.find(n => n.wxDelivery);
  // Claim before sending. Retrying a timed-out send must not create a second push.
  const claimed = await store.transaction(async tx => {
    const actor = await tx.get('users', actorId);
    const booking = await tx.get('bookings', command.bookingId);
    const session = booking && await tx.get('sessions', booking.sessionId);
    requireThat(actor?.status === 'active' && booking && session, 'NOT_FOUND', '预约或账户不存在');
    requireThat(actor.roles.includes('admin') || (actor.roles.includes('coach') && session.coachId === actor.id), 'FORBIDDEN', '只能发送本人授课的消课通知');
    requireThat(booking.status === 'attended', 'STATE', '仅到课完成的课程可发送此通知');
    const notice = candidate && await tx.get('inbox', candidate.id);
    requireThat(notice?.wxDelivery && notice.userId === booking.memberId, 'NOT_FOUND', '这条历史记录未创建微信通知任务');
    if (notice.wxDelivery.state === 'sent' || notice.wxDelivery.state === 'unknown') return { result: notice.wxDelivery.state } as const;
    if (notice.wxDelivery.state === 'sending') {
      if (now - notice.wxDelivery.updatedAt > 60000) {
        notice.wxDelivery = { state: 'unknown', updatedAt: now }; await tx.put('inbox', notice);
        return { result: 'unknown' } as const;
      }
      return { result: 'sending' } as const;
    }
    const member = await tx.get('users', booking.memberId);
    const coach = await tx.get('users', session.coachId);
    const recipient = member?.receiptRecipient;
    if (member?.status !== 'active' || !recipient || recipient.appid !== appid) {
      notice.wxDelivery = { state: 'needs_subscription', updatedAt: now }; await tx.put('inbox', notice);
      return { result: 'needs_subscription' } as const;
    }
    const localStart = new Date(session.start + 8 * 3600000).toISOString();
    const localEnd = new Date(session.end + 8 * 3600000).toISOString();
    const payload: ReceiptPayload = {
      touser: recipient.openid, template_id: receiptTemplateId,
      page: 'pages/workspace/index?tab=messages', miniprogram_state: state,
      data: {
        name1: { value: short(session.title, 10) }, name2: { value: short(coach?.name || '授课教练', 10) },
        date3: { value: localStart.slice(0, 10) }, thing4: { value: short(session.roomId, 20) },
        thing5: { value: short(`${session.kind === 'private' ? '私教' : '团课'}${localStart.slice(11, 16)}-${localEnd.slice(11, 16)}/${booking.cost}课时`, 20) },
      },
    };
    notice.wxDelivery = { state: 'sending', updatedAt: now }; await tx.put('inbox', notice);
    return { noticeId: notice.id, payload } as const;
  });
  if ('result' in claimed) return { state: claimed.result };
  let delivery: ReceiptDelivery;
  try {
    const response = await sender.send(claimed.payload);
    delivery = { state: response.errcode === 0 ? 'sent' : response.errcode === 43101 ? 'needs_subscription' : 'failed', updatedAt: Date.now(), code: response.errcode };
  } catch {
    // Response may have been lost after WeChat accepted the push. No automatic retry.
    delivery = { state: 'unknown', updatedAt: Date.now() };
  }
  await store.transaction(async tx => {
    const notice = await tx.get('inbox', claimed.noticeId);
    if (notice?.wxDelivery?.state === 'sending') { notice.wxDelivery = delivery; await tx.put('inbox', notice); }
  });
  return { state: delivery.state };
}

export function wechatReceiptSender(settings: { appid: string; secret: string }): ReceiptSender {
  // Token stays in this server process; never persisted in business records or logs.
  let cached: { token: string; expiresAt: number } | undefined;
  return { async send(payload) {
    if (!cached || cached.expiresAt <= Date.now()) {
      try {
      const url = new URL('https://api.weixin.qq.com/cgi-bin/token');
      url.search = new URLSearchParams({ grant_type: 'client_credential', appid: settings.appid, secret: settings.secret }).toString();
      const response = await fetch(url, { signal: AbortSignal.timeout(2000), redirect: 'error' });
      if (!response.ok) throw new Error('Token unavailable');
      const token = z.object({ access_token: z.string().min(1), expires_in: z.number().positive() }).parse(await response.json());
      cached = { token: token.access_token, expiresAt: Date.now() + Math.max(0, token.expires_in - 300) * 1000 };
      } catch {
        // No send request was made, so retry is safe. Do not return upstream secrets/errors.
        return { errcode: -1 };
      }
    }
    const url = new URL('https://api.weixin.qq.com/cgi-bin/message/subscribe/send');
    url.search = new URLSearchParams({ access_token: cached.token }).toString();
    const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload), signal: AbortSignal.timeout(2000), redirect: 'error' });
    if (!response.ok) throw new Error('Delivery unavailable');
    const result = z.object({ errcode: z.number().int() }).parse(await response.json());
    if ([40001, 40014, 42001].includes(result.errcode)) cached = undefined;
    return result;
  } };
}
