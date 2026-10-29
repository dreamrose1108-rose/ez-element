import { config } from '../config';
import { callCloud } from './cloudbase';

export type Role = 'student' | 'coach' | 'admin';
export interface Profile { id: string; name: string; phone: string; birthday?: string; prices?: { private?: number; group?: number }; employmentType?: 'fullTime' | 'partTime'; roles: Role[]; status: string }
export interface Session { id: string; kind: string; title: string; coachId: string; roomId: string; start: number; end: number; reserved: number; capacity: number; cost: number; status: string; cancelHours: number; cutoffMinutes: number; cancelReason?: string }
export interface Pack { id: string; memberId: string; kind: string; available: number; frozen: number; consumed: number; total: number; expiresAt: number; coachIds: string[] }
export interface Booking { notificationState?: string; id: string; sessionId: string; memberId: string; status: string; cost: number; packageId: string; cancelReason?: string; totalAmountFen?: number; unitPriceFen?: number; settleAmountFen?: number }
export interface Purchase { id: string; memberId: string; packageId: string; amountFen: number; method: string; note: string; at: number }
export interface CoachPay {
  employmentType: 'fullTime' | 'partTime'; month: string;
  todayClassCount: number; todayClassRevenueFen: number; todayClassCommissionFen: number;
  todayPerformanceFen: number; todayPerformanceCommissionFen: number; todayTotalFen: number;
  monthClassCount: number; monthClassRevenueFen: number; classCommissionBps: number; monthClassCommissionFen: number;
  monthPerformanceFen: number; performanceCommissionBps: number; performanceCommissionFen: number;
  baseSalaryFen: number; bonusFen: number; estimatedTotalFen: number;
}
export interface AdminFinance {
  todayRevenueFen: number; todayConsumedFen: number; todayCoachPayFen: number; todayAfterCoachPayFen: number;
  coaches: { id: string; name: string; employmentType: 'fullTime' | 'partTime'; todayClassCommissionFen: number; todayPerformanceCommissionFen: number; todayTotalFen: number; monthEstimatedTotalFen: number }[];
  historyMonths: string[];
  teachingHistory: { id: string; coachId: string; memberId: string; memberName: string; month: string; start: number; end: number; title: string; kind: string; status: string; cost: number; amountFen: number }[];
}
export interface Dashboard { profile: Profile | null; sessions?: Session[]; packages?: Pack[]; bookings?: Booking[]; purchases?: Purchase[]; coachPay?: CoachPay; adminFinance?: AdminFinance; inbox?: { id: string; userId: string; title: string; at: number }[]; users?: Profile[]; roster?: { id: string; name: string }[]; coaches?: { id: string; name: string }[]; ledger?: { id: string; packageId: string; memberId: string; type: string; unit?: 'fen'; at: number; delta: { available: number; frozen: number; consumed: number } }[] }
interface Reply<T> { ok: boolean; data: T; message?: string; code?: string }
const requests = new Map<string, string>();
export async function api<T>(role: Role, command: Record<string, unknown>): Promise<T> {
  const key = JSON.stringify({ role, command });
  const mutation = !['dashboard', 'register'].includes(String(command.action));
  if (mutation && !requests.has(key)) requests.set(key, `wx-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const payload = mutation ? { ...command, requestId: requests.get(key) } : command;
  let response: Reply<T>;
  if (config.mode === 'demo') {
    response = await new Promise<Reply<T>>((resolve, reject) => {
      wx.request<Reply<T>>({ url: config.demoUrl, method: 'POST', data: { role, command: payload }, success: r => { if (r.statusCode === 200) resolve(r.data); else reject(new Error('演示服务不可用')); }, fail: e => reject(new Error(`无法连接演示服务。请确认手机能访问电脑所在局域网，且电脑演示服务正在运行。请求详情：${e.errMsg}`)) });
    });
  } else {
    if (!config.envId) throw new Error('云环境尚未配置');
    response = await callCloud(payload) as Reply<T>;
  }
  if (!response || typeof response.ok !== 'boolean') throw new Error('服务返回格式异常');
  if (!response.ok) {
    if (!['INTERNAL', 'UNAUTHENTICATED', 'NOT_CONFIGURED'].includes(response.code || '')) requests.delete(key);
    throw new Error(response.message || '操作失败，请重试');
  }
  requests.delete(key);
  return response.data;
}
