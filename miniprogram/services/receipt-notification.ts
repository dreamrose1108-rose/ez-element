import { config } from '../config';
import { callCloud } from './cloudbase';

export const receiptTemplateId = 'uQw9Dwn6iRzjlcoCjSnvOlXeeHHAFrDJ8o3xfcnHWbg';
export const bookingTemplateIds = ['cT8g1p6dE-Kr3ooCZ6fWqdv7zUzZFYNJKPVOssF8hhA', 'a_5WEv4RCAsa_Z_fZKjIxemLgjOl8bfytueMQEjj848', 'L4V2yd5IyYeRJPm1WwM9OscJDFO8rzrAYkHxuosyvPc'];

// Must be invoked directly from a user tap, before any network await.
export async function subscribeReceipt(booking = false): Promise<string> {
  if (config.mode !== 'cloud') return '演示模式不发送微信通知';
  const tmplIds = booking ? bookingTemplateIds : [receiptTemplateId];
  const result = await wx.requestSubscribeMessage({ tmplIds });
  const accepted = tmplIds.filter(id => result[id] === 'accept').length;
  if (!accepted) return '未开启微信提醒，仍可查看站内消息';
  const { code } = await wx.login({ timeout: 10000 });
  if (!code) throw new Error('微信身份确认失败，请重新点击订阅');
  await new Promise<void>((resolve, reject) => wx.request<{ ok?: boolean }>({
    url: config.loginUrl, method: 'POST', timeout: 15000,
    data: { code, subscribeReceipt: true }, header: { 'content-type': 'application/json' },
    success(response) {
      if (response.statusCode === 200 && response.data?.ok === true) resolve();
      else reject(new Error('微信已授权，但通知绑定未完成，请稍后重新订阅'));
    },
    fail: () => reject(new Error('通知绑定连接失败，请稍后重新订阅')),
  }));
  return `本次订阅已完成${booking ? `（${accepted}/3 类）` : ''}；后续提醒需有可用订阅次数`;
}

export async function sendReceiptNotification(bookingId: string): Promise<void> {
  if (config.mode !== 'cloud') return;
  const result = await callCloud({ action: 'sendReceipt', bookingId }, 'getLoginTicket') as { ok?: boolean; message?: string };
  if (!result?.ok) throw new Error(result?.message || '微信通知未完成，请稍后重试');
}
