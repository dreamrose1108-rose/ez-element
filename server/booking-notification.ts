import { Store, Tx, Booking, Session } from './model';
import { key } from './service';
import { ReceiptPayload, ReceiptSender } from './receipt-notification';

export const bookingTemplates = {
  booked: 'cT8g1p6dE-Kr3ooCZ6fWqdv7zUzZFYNJKPVOssF8hhA',
  cancelled: 'a_5WEv4RCAsa_Z_fZKjIxemLgjOl8bfytueMQEjj848',
  reminder: 'L4V2yd5IyYeRJPm1WwM9OscJDFO8rzrAYkHxuosyvPc',
} as const;
export interface BookingNotification {
  kind: keyof typeof bookingTemplates;
  dueAt: number;
  state: 'pending' | 'sending' | 'sent' | 'skipped' | 'failed' | 'needs_subscription' | 'unknown';
  updatedAt: number;
  reason?: string;
  code?: number;
}
export async function queueBookingNotification(tx: Tx, booking: Booking, session: Session, kind: 'booked' | 'cancelled', now: number, reason?: string) {
  const id = key('notification', booking.id, kind);
  if (await tx.get('inbox', id)) return;
  await tx.put('inbox', { id, userId: booking.memberId, bookingId: booking.id,
    title: `${kind === 'booked' ? '预约成功' : reason ? `门店停课：${reason}` : '预约已取消'} · ${session.title}`, at: now,
    notification: { kind, dueAt: now, updatedAt: now, state: 'pending', ...(reason ? { reason } : {}) } });
  if (kind === 'booked') {
    await tx.put('inbox', { id: key('notification', booking.id, 'reminder'), userId: booking.memberId,
      bookingId: booking.id, title: `开课提醒 · ${session.title}`, at: now,
      notification: { kind: 'reminder', dueAt: Math.max(now, session.start - 2 * 3600000), updatedAt: now, state: 'pending' } });
  }
}
const value = (text: string, length = 20) => ({ value: Array.from(text.replace(/[\r\n\t]/g, ' ').trim()).slice(0, length).join('') || '未填写' });

// Only persisted jobs are processed: invocation cannot supply recipients, content or dates.
export async function dispatchBookingNotifications(store: Store, sender: ReceiptSender, appid: string, state: ReceiptPayload['miniprogram_state'], now = Date.now()) {
  const jobs = await store.dueNotifications(now, 8);
  let sent = 0;
  for (const candidate of jobs) {
    const claimed = await store.transaction(async tx => {
      const notice = await tx.get('inbox', candidate.id);
      const job = notice?.notification;
      if (!notice || !job || job.dueAt > now) return;
      if (job.state === 'sending') {
        if (now - job.updatedAt > 60000) { job.state = 'unknown'; job.updatedAt = now; await tx.put('inbox', notice); }
        return;
      }
      if (job.state !== 'pending') return;
      const booking = await tx.get('bookings', notice.bookingId);
      const session = booking && await tx.get('sessions', booking.sessionId);
      const member = booking && await tx.get('users', booking.memberId);
      const stop = async (status: BookingNotification['state']) => { job.state = status; job.updatedAt = now; await tx.put('inbox', notice); };
      if (!booking || !session || notice.userId !== booking.memberId ||
          (job.kind === 'cancelled' ? booking.status !== 'cancelled' : booking.status !== 'confirmed' || session.status !== 'open') ||
          (job.kind !== 'cancelled' && session.start <= now) || now - job.dueAt > 86400000) { await stop('skipped'); return; }
      // Recheck authoritative class time, including subsequent schedule edits.
      if (job.kind === 'reminder' && now < session.start - 2 * 3600000) {
        job.dueAt = session.start - 2 * 3600000; await tx.put('inbox', notice); return;
      }
      const recipient = member?.receiptRecipient;
      if (member?.status !== 'active' || !recipient || recipient.appid !== appid) { await stop('needs_subscription'); return; }
      const coach = await tx.get('users', session.coachId);
      const name = coach?.name || '授课教练';
      const date = new Date(session.start + 8 * 3600000).toISOString().slice(0, 16).replace('T', ' ');
      const data: ReceiptPayload['data'] = job.kind === 'booked' ? {
        thing6: value(session.title), time3: value(date), name2: value(name, 10),
        thing8: value(`${session.kind === 'private' ? '私教课' : '团课'} · ${session.roomId}`),
      } : job.kind === 'cancelled' ? {
        name2: value(name, 10), time3: value(date), thing6: value(session.title),
        thing9: value(member.name), thing5: value(job.reason || booking.cancelReason || '学员主动取消'),
      } : {
        thing2: value(session.title), name3: value(name, 10), date4: value(date),
        thing6: value(name), thing5: value(`请准时到${session.roomId}上课`),
      };
      await stop('sending');
      return { id: notice.id, payload: { touser: recipient.openid, template_id: bookingTemplates[job.kind],
        page: 'pages/workspace/index?tab=messages', miniprogram_state: state, data } satisfies ReceiptPayload };
    });
    if (!claimed) continue;
    let outcome: BookingNotification['state']; let code: number | undefined;
    try { code = (await sender.send(claimed.payload)).errcode; outcome = code === 0 ? 'sent' : code === 43101 ? 'needs_subscription' : 'failed'; }
    catch { outcome = 'unknown'; }
    await store.transaction(async tx => {
      const notice = await tx.get('inbox', claimed.id);
      if (notice?.notification?.state === 'sending') {
        notice.notification = { ...notice.notification, state: outcome, updatedAt: now, ...(code === undefined ? {} : { code }) };
        await tx.put('inbox', notice);
      }
    });
    if (outcome === 'sent') sent++;
  }
  return { processed: jobs.length, sent };
}
