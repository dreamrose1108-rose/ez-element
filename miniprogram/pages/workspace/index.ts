import { api, Dashboard, Role, Session, Pack } from '../../services/api';
import { config } from '../../config';
import { subscribeReceipt, sendReceiptNotification } from '../../services/receipt-notification';
import { positiveMoneyFen } from '../../services/purchase-price';

const dayKey = (n: number) => new Date(n + 8 * 3600000).toISOString().slice(0, 10);
const time = (n: number) => new Date(n + 8 * 3600000).toISOString().slice(11, 16);
const money = (fen: number) => `¥${(fen / 100).toFixed(2)}`;
const canCopy = (s: Session) => s.end - s.start === 3600000 && s.capacity === 1 && dayKey(s.start) === dayKey(s.end - 1);
const copyWarning = (sessions: Session[]) => {
  const skipped = sessions.filter(s => !canCopy(s));
  return skipped.length ? `将跳过 ${skipped.length} 个不符合一小时、单人规则的历史时段：${skipped.map(s => `${dayKey(s.start)} ${time(s.start)}–${time(s.end)}`).join('、')}。原课程和预约不变。` : '';
};
const walletView = (p: Pack) => ({ id: p.id, available: money(p.available), frozen: money(p.frozen), consumed: money(p.consumed), total: money(p.total), expiry: dayKey(p.expiresAt), expired: p.expiresAt < Date.now() });
const roleNames = { student: '学员端', coach: '教练端', admin: '管理端' };
const navigation = {
  student: [{ id: 'home', name: '我的课程' }, { id: 'schedule', name: '预约训练' }, { id: 'account', name: '我的账户' }, { id: 'messages', name: '消息' }],
  coach: [{ id: 'home', name: '授课出勤' }, { id: 'schedule', name: '我的排班' }, { id: 'account', name: '学员名单' }, { id: 'income', name: '我的收入' }, { id: 'messages', name: '消息' }],
  admin: [{ id: 'home', name: '工作台' }, { id: 'schedule', name: '课程排班' }, { id: 'account', name: '学员管理' }, { id: 'finance', name: '收款账务' }],
};
const statuses: Record<string, string> = { confirmed: '待上课', cancelled: '已取消', attended: '已到课', absent: '爽约已结算' };
const notificationLabels: Record<string, string> = { pending: '微信消课通知待发送', sending: '微信消课通知发送中；超时请人工确认', sent: '微信消课通知已发送', needs_subscription: '学员需先订阅消课提醒', failed: '微信消课通知发送失败', unknown: '微信发送结果未确认，请人工联系学员，避免重复推送' };
interface StaffMember { id: string; name: string; phone: string; birthday: string; shortId: string; isCoach: boolean; employmentType: 'fullTime' | 'partTime'; employmentTypeName: string }
interface CoachPayView {
  employmentTypeName: string; month: string;
  todayClassCount: number; todayClassRevenueLabel: string; todayClassCommissionLabel: string;
  todayPerformanceLabel: string; todayPerformanceCommissionLabel: string; todayTotalLabel: string;
  monthClassCount: number; classRateLabel: string; monthClassRevenueLabel: string; monthClassCommissionLabel: string;
  monthPerformanceLabel: string; performanceRateLabel: string; performanceCommissionLabel: string;
  baseSalaryLabel: string; bonusLabel: string; estimatedTotalLabel: string;
}
interface AdminFinanceView {
  todayRevenueLabel: string; todayConsumedLabel: string; todayCoachPayLabel: string; todayAfterCoachPayLabel: string; negative: boolean;
  coaches: { id: string; name: string; employmentTypeName: string; todayClassCommissionLabel: string; todayPerformanceCommissionLabel: string; todayTotalLabel: string; monthEstimatedTotalLabel: string }[];
}
let snapshot: Dashboard = { profile: null };
let snapshotLoadedAt = 0;
const SWITCH_CACHE_MS = 30_000;
let dragAnchor = -1; let dragCurrent = -1;
let dragRects: { top: number; bottom: number; left: number; right: number; dataset?: { index?: string | number } }[] = [];
Page({
  data: {
    demo: config.mode === 'demo', role: 'student' as Role, roleName: '学员端', roles: [] as { id: Role; name: string }[],
    tab: 'home', subscribingReceipt: false, subscriptionMessage: '', busy: false, error: '', errorScope: 'load', errorId: '', profile: null as Dashboard['profile'], today: dayKey(Date.now()), registrationBirthday: '',
    navItems: navigation.student, todayClasses: 0, unsettledCount: 0, coachRoster: [] as { id: string; name: string }[],
    days: Array.from({ length: 7 }, (_, i) => { const key = dayKey(Date.now() + i * 86400000); return { key, short: key.slice(5), label: i === 0 ? '今天' : ['日', '一', '二', '三', '四', '五', '六'][new Date(`${key}T12:00:00+08:00`).getUTCDay()] }; }),
    day: dayKey(Date.now()), kind: 'private', coachIndex: 0, coaches: [] as { id: string; name: string }[],
    publishStart: '', publishEnd: '', dragging: false, scheduleTimes: Array.from({ length: 28 }, (_, index) => ({ key: index, label: `${String(8 + Math.floor(index / 2)).padStart(2, '0')}:${index % 2 ? '30' : '00'}` })), scheduleSlots: [] as { key: string; day: string; index: number; startLabel: string; endLabel: string; displayTime: string; durationLabel: string; state: string; stateName: string; sessionId: string; sessionStart: number; sessionEnd: number; start: number; end: number; disabled: boolean; selected: boolean; visible: boolean; span: number }[],
    weekScheduleDays: [] as { key: string; label: string; short: string; slots: { key: string; day: string; index: number; startLabel: string; endLabel: string; displayTime: string; durationLabel: string; state: string; stateName: string; sessionId: string; sessionStart: number; sessionEnd: number; start: number; end: number; disabled: boolean; selected: boolean; visible: boolean; span: number }[] }[],
    sessions: [] as object[], bookings: [] as object[], packs: [] as object[], messages: [] as object[], ledger: [] as object[], pending: [] as object[],
    users: [] as { id: string; name: string }[], memberIndex: 0, purchaseExpiry: '', purchaseAmount: '', purchaseNote: '', privatePrice: '', groupPrice: '', salesCoachIndex: 0, salesCoachNames: ['不归属教练'],
    wallet: null as ReturnType<typeof walletView> | null, memberWallet: null as ReturnType<typeof walletView> | null,
    ownPrivatePrice: '', ownGroupPrice: '', memberPrivatePrice: '', memberGroupPrice: '',
    staffMembers: [] as StaffMember[],
    memberSection: 'members', memberQuery: '', memberFilter: 'student', studentMemberCount: 0, coachMemberCount: 0, filteredMembers: [] as StaffMember[],
    memberDetailId: '', memberDetail: null as StaffMember | null,
    coachMember: null as null | { id: string; name: string; shortId: string; records: { id: string; title: string; schedule: string; status: string; statusCode: string; cost: number; amount: string }[] },
    memberPacks: [] as object[], memberBookings: [] as object[],
    coachPay: null as CoachPayView | null,
    adminFinance: null as AdminFinanceView | null,
    totalAvailable: 0, totalFrozen: 0, totalConsumed: 0, myCount: 0,
    editing: null as null | { id: string; title: string; day: string; start: string; end: string; room: string; capacity: number; kind: string },
    copyCount: 0, copyEnd: '', copyTarget: '', copyTargetEnd: '', copyUnavailable: false,
    copyMode: 'day', copySourceDay: '', copyDestinationDay: '', copyDayCount: 0, copyDayWarning: '', copyWeekWarning: '',
    selectedId: '', selectedTitle: '', selectedTime: '', selectedCost: 1, selectedCancel: 0, eligible: [] as { id: string; label: string; freezeLabel: string; expectedAmountFen?: number }[], packageIndex: 0,
  },
  onLoad(options: Record<string, string | undefined>) { if (options?.tab === 'messages') this.setData({ tab: 'messages' }); snapshot = { profile: null }; snapshotLoadedAt = 0; this.refresh(); },
  onPullDownRefresh() { this.refresh().finally(() => wx.stopPullDownRefresh()); },
  async refresh() {
    if (this.data.busy) return;
    snapshotLoadedAt = 0;
    this.setData({ busy: true, error: '' });
    try {
      snapshot = await api<Dashboard>(this.data.role, { action: 'dashboard' });
      this.applySnapshot();
      snapshotLoadedAt = Date.now();
    } catch (e) { this.setData({ errorScope: 'load', error: e instanceof Error ? e.message : '加载失败' }); }
    finally { this.setData({ busy: false }); }
  },
  applySnapshot() {
      const available = this.data.demo ? ['student', 'coach', 'admin'] as Role[] : snapshot.profile?.roles || [];
      const role = available.includes(this.data.role) ? this.data.role : available[0] || 'student';
      this.setData({ navItems: navigation[role], tab: navigation[role].some(item => item.id === this.data.tab) ? this.data.tab : 'home' });
      this.setData({ profile: snapshot.profile, role, roleName: roleNames[role], roles: available.map(id => ({ id, name: roleNames[id] })), coaches: snapshot.coaches || [], salesCoachNames: ['不归属教练', ...(snapshot.coaches || []).map(c => c.name)], users: (snapshot.users || []).filter(u => u.status === 'active' && u.roles.includes('student')).map(u => ({ id: u.id, name: u.name })), pending: (snapshot.users || []).filter(u => u.status === 'pending') });
      this.setData({ coachIndex: Math.min(this.data.coachIndex, Math.max(0, this.data.coaches.length - 1)), staffMembers: (snapshot.users || []).filter(u => u.status === 'active' && (u.roles.includes('student') || u.roles.includes('coach'))).map(u => { const employmentType = u.employmentType || 'fullTime'; return { id: u.id, name: u.name, phone: u.phone, birthday: u.birthday || '', shortId: u.id.slice(-6), isCoach: u.roles.includes('coach'), employmentType, employmentTypeName: employmentType === 'fullTime' ? '全职' : '兼职' }; }) });
      this.renderData();
      this.renderMembers();
      if (this.data.coachMember) this.showCoachMember(this.data.coachMember.id);
  },
  renderData() {
    const now = Date.now(); const all = snapshot.sessions || []; const profile = snapshot.profile;
    const coaches = snapshot.coaches || []; const coach = coaches[this.data.coachIndex];
    const sourceStart = Date.parse(`${this.data.day}T00:00:00+08:00`);
    const weeklyPrivate = this.data.role !== 'student' && this.data.kind !== 'group';
    const weekKeys = Array.from({ length: 7 }, (_, i) => dayKey(sourceStart + i * 86400000));
    const sessions = all.filter(s => (weeklyPrivate ? weekKeys.includes(dayKey(s.start)) && s.kind === 'private' : dayKey(s.start) === this.data.day) && s.status === 'open' && (this.data.role === 'student' ? s.kind === this.data.kind && (s.kind === 'group' || !coach || s.coachId === coach.id) : this.data.role === 'coach' ? s.coachId === profile?.id : true)).sort((a, b) => a.start - b.start).map(s => ({ ...s, dayLabel: dayKey(s.start), startLabel: time(s.start), endLabel: time(s.end), coachName: coaches.find(c => c.id === s.coachId)?.name || '教练', kindName: s.kind === 'private' ? '私教' : '团课', free: s.capacity - s.reserved, canBook: s.reserved < s.capacity && s.start - now >= s.cutoffMinutes * 60000, canCancelSession: this.data.role === 'admin' && s.start > now, canClose: s.reserved === 0 && s.start > now && (this.data.role === 'admin' || s.kind === 'private') }));
    const scheduleCoach = this.data.role === 'coach' ? profile?.id : coach?.id;
    const weekScheduleDays = !weeklyPrivate ? [] : weekKeys.map((key, dayIndex) => {
      const dayStart = Date.parse(`${key}T00:00:00+08:00`);
      const raw = Array.from({ length: 28 }, (_, slotIndex) => {
        const index = dayIndex * 28 + slotIndex; const start = dayStart + 8 * 3600000 + slotIndex * 1800000; const end = start + 1800000;
        const session = all.find(s => s.coachId === scheduleCoach && (s.status === 'open' || s.status === 'rest') && s.start < end && start < s.end);
        const state = !session ? 'free' : session.status === 'rest' ? 'rest' : session.reserved > 0 ? 'booked' : 'scheduled';
        const stateName = ({ free: '可选', rest: '休息', booked: '已约', scheduled: '已排课' } as Record<string, string>)[state] || '可选';
        return { key: `${key}-${slotIndex}`, day: key, index, startLabel: time(start), endLabel: time(end), state, stateName, sessionId: session?.id || '', sessionStart: session?.start || start, sessionEnd: session?.end || end, start, end, disabled: start <= now || state === 'booked', selected: false };
      });
      const firstIndexBySession = new Map<string, number>();
      raw.forEach(slot => { if (slot.sessionId && !firstIndexBySession.has(slot.sessionId)) firstIndexBySession.set(slot.sessionId, slot.index); });
      const slots = raw.map(slot => {
        const span = slot.sessionId ? Math.max(1, Math.round((slot.sessionEnd - slot.sessionStart) / 1800000)) : 1;
        const minutes = span * 30; const durationLabel = minutes < 60 ? `${minutes}分` : minutes % 60 ? `${Math.floor(minutes / 60)}时${minutes % 60}分` : `${minutes / 60}小时`;
        return { ...slot, visible: !slot.sessionId || firstIndexBySession.get(slot.sessionId) === slot.index, displayTime: slot.sessionId ? `${time(slot.sessionStart)}–${time(slot.sessionEnd)}` : slot.startLabel, durationLabel: slot.sessionId ? durationLabel : '30分', span };
      });
      const date = new Date(`${key}T12:00:00+08:00`); const weekday = ['日', '一', '二', '三', '四', '五', '六'][date.getUTCDay()];
      return { key, label: `周${weekday}`, short: key.slice(5), slots };
    });
    const scheduleSlots = weekScheduleDays.flatMap(item => item.slots);
    const copyCoach = this.data.role === 'coach' ? profile?.id : coach?.id;
    const copySlots = all.filter(s => s.kind === 'private' && s.status === 'open' && s.coachId === copyCoach && s.start >= sourceStart && s.start < sourceStart + 7 * 86400000);
    const dayCopySlots = all.filter(s => s.kind === 'private' && s.status === 'open' && s.coachId === copyCoach && dayKey(s.start) === (this.data.copySourceDay || this.data.day));
    this.setData({ copyDayCount: dayCopySlots.filter(canCopy).length, copyDayWarning: copyWarning(dayCopySlots), copyWeekWarning: copyWarning(copySlots) });
    this.setData({ scheduleSlots, weekScheduleDays, copyCount: copySlots.filter(canCopy).length, copyEnd: dayKey(sourceStart + 6 * 86400000), copyTarget: dayKey(sourceStart + 7 * 86400000), copyTargetEnd: dayKey(sourceStart + 13 * 86400000), copyUnavailable: all.length >= 200 });
    const bookings = (snapshot.bookings || []).filter(b => this.data.role === 'student' ? b.memberId === profile?.id : this.data.role === 'coach' ? all.some(s => s.id === b.sessionId && s.coachId === profile?.id) : true).map(b => { const s = all.find(s => s.id === b.sessionId); return { ...b, notificationLabel: notificationLabels[b.notificationState || ''] || '', canRetryNotification: ['pending', 'failed', 'needs_subscription'].includes(b.notificationState || ''), statusClass: `status-${b.status}`, title: s?.title || '历史课程', schedule: s ? `${dayKey(s.start)} ${time(s.start)}–${time(s.end)}` : '', cancelReason: b.cancelReason || '', statusName: b.status === 'cancelled' && b.cancelReason ? '门店停课' : statuses[b.status] || b.status, memberName: [...(snapshot.users || []), ...(snapshot.roster || [])].find(u => u.id === b.memberId)?.name || b.memberId.slice(-6), unitPriceLabel: b.unitPriceFen === undefined ? '' : money(b.unitPriceFen), settleAmountLabel: b.settleAmountFen === undefined ? '' : money(b.settleAmountFen), totalAmountLabel: b.totalAmountFen === undefined ? '' : money(b.totalAmountFen), canCancel: b.status === 'confirmed' && !!s && s.start - now >= s.cancelHours * 3600000, canSettle: b.status === 'confirmed' && !!s && s.end <= now }; });
    const pay = snapshot.coachPay;
    const coachPay: CoachPayView | null = this.data.role === 'coach' && pay ? {
      employmentTypeName: pay.employmentType === 'fullTime' ? '全职' : '兼职', month: pay.month,
      todayClassCount: pay.todayClassCount, todayClassRevenueLabel: money(pay.todayClassRevenueFen), todayClassCommissionLabel: money(pay.todayClassCommissionFen),
      todayPerformanceLabel: money(pay.todayPerformanceFen), todayPerformanceCommissionLabel: money(pay.todayPerformanceCommissionFen), todayTotalLabel: money(pay.todayTotalFen),
      monthClassCount: pay.monthClassCount, classRateLabel: `${(pay.classCommissionBps / 100).toFixed(0)}%`, monthClassRevenueLabel: money(pay.monthClassRevenueFen), monthClassCommissionLabel: money(pay.monthClassCommissionFen),
      monthPerformanceLabel: money(pay.monthPerformanceFen), performanceRateLabel: `${(pay.performanceCommissionBps / 100).toFixed(0)}%`, performanceCommissionLabel: money(pay.performanceCommissionFen),
      baseSalaryLabel: money(pay.baseSalaryFen), bonusLabel: money(pay.bonusFen), estimatedTotalLabel: money(pay.estimatedTotalFen),
    } : null;
    const finance = snapshot.adminFinance;
    const adminFinance: AdminFinanceView | null = this.data.role === 'admin' && finance ? {
      todayRevenueLabel: money(finance.todayRevenueFen), todayConsumedLabel: money(finance.todayConsumedFen),
      todayCoachPayLabel: money(finance.todayCoachPayFen), todayAfterCoachPayLabel: money(finance.todayAfterCoachPayFen), negative: finance.todayAfterCoachPayFen < 0,
      coaches: finance.coaches.map(item => ({ id: item.id, name: item.name, employmentTypeName: item.employmentType === 'fullTime' ? '全职' : '兼职',
        todayClassCommissionLabel: money(item.todayClassCommissionFen), todayPerformanceCommissionLabel: money(item.todayPerformanceCommissionFen),
        todayTotalLabel: money(item.todayTotalFen), monthEstimatedTotalLabel: money(item.monthEstimatedTotalFen) })),
    } : null;
    const rosterIds = new Set(bookings.map(b => b.memberId));
    this.setData({ coachPay, adminFinance, todayClasses: all.filter(s => s.status === 'open' && dayKey(s.start) === dayKey(now) && (this.data.role === 'admin' || s.coachId === profile?.id)).length, unsettledCount: bookings.filter(b => b.canSettle).length, coachRoster: [...(snapshot.users || []), ...(snapshot.roster || [])].filter(u => rosterIds.has(u.id)).filter((u, i, list) => list.findIndex(v => v.id === u.id) === i).map(u => ({ id: u.id, name: u.name })) });
    const packs = (snapshot.packages || []).filter(p => p.kind !== 'wallet' && (this.data.role === 'admin' || p.memberId === profile?.id));
    const wallet = (snapshot.packages || []).find(p => p.kind === 'wallet' && p.memberId === profile?.id);
    this.setData({ wallet: wallet ? walletView(wallet) : null, ownPrivatePrice: profile?.prices?.private ? money(profile.prices.private) : '未设置', ownGroupPrice: profile?.prices?.group ? money(profile.prices.group) : '未设置' });
    const messages = (snapshot.inbox || []).filter(m => this.data.role === 'admin' || m.userId === profile?.id);
    const visibleLedger = (snapshot.ledger || []).filter(l => this.data.role === 'admin' || l.memberId === profile?.id);
    this.setData({ sessions, bookings, myCount: bookings.filter(b => b.status === 'confirmed').length, packs: packs.map(p => ({ ...p, title: p.kind === 'private' ? '私教课包' : '团课课包', expiry: dayKey(p.expiresAt), expired: p.expiresAt < now })), totalAvailable: packs.filter(p => p.expiresAt >= now).reduce((a, p) => a + p.available, 0), totalFrozen: packs.reduce((a, p) => a + p.frozen, 0), totalConsumed: packs.reduce((a, p) => a + p.consumed, 0), messages: messages.sort((a, b) => b.at - a.at).map(m => ({ ...m, date: `${dayKey(m.at)} ${time(m.at)}` })), ledger: visibleLedger.sort((a, b) => b.at - a.at).map(l => ({ ...l, title: ({ migration: '旧课包转入余额', purchase: '购课入账', freeze: '预约冻结', release: '取消释放', consume: '出勤消课' } as Record<string, string>)[l.type] || l.type, date: dayKey(l.at), availableLabel: l.unit === 'fen' ? money(l.delta.available) : `${l.delta.available} 节`, frozenLabel: l.unit === 'fen' ? money(l.delta.frozen) : `${l.delta.frozen} 节`, consumedLabel: l.unit === 'fen' ? money(l.delta.consumed) : `${l.delta.consumed} 节` })) });
  },
  renderMembers() {
    const query = this.data.memberQuery.trim().toLocaleLowerCase();
    const members = this.data.role === 'admin' ? this.data.staffMembers : [];
    const filteredMembers = members.filter(u => (!query || u.name.toLocaleLowerCase().includes(query) || u.shortId.includes(query)) && (this.data.memberFilter === 'coach' ? u.isCoach : !u.isCoach));
    const member = members.find(u => u.id === this.data.memberDetailId) || null;
    const memberWallet = member && (snapshot.packages || []).find(p => p.memberId === member.id && p.kind === 'wallet');
    this.setData({ memberWallet: memberWallet ? walletView(memberWallet) : null });
    const memberPacks = member ? (snapshot.packages || []).filter(p => p.memberId === member.id && p.kind !== 'wallet').map(p => {
      const purchase = (snapshot.purchases || []).find(item => item.packageId === p.id);
      return { ...p, title: p.kind === 'private' ? '私教课包' : '团课课包', expiry: dayKey(p.expiresAt), expired: p.expiresAt < Date.now(), totalAmountLabel: purchase ? money(purchase.amountFen) : '', unitPriceLabel: purchase && p.total > 0 ? money(purchase.amountFen / p.total) : '' };
    }) : [];
    const memberBookings = member ? (snapshot.bookings || []).filter(b => b.memberId === member.id).map(b => {
      const s = (snapshot.sessions || []).find(s => s.id === b.sessionId);
      return { id: b.id, statusCode: b.status, title: s?.title || '历史课程', schedule: s ? `${dayKey(s.start)} ${time(s.start)}–${time(s.end)}` : '场次详情未加载', status: statuses[b.status] || b.status, start: s?.start || 0 };
    }).sort((a, b) => b.start - a.start) : [];
    this.setData({ filteredMembers, studentMemberCount: members.filter(u => !u.isCoach).length, coachMemberCount: members.filter(u => u.isCoach).length, memberDetail: member, memberPacks, memberBookings });
  },
  searchMembers(e: WechatMiniprogram.Input) { this.setData({ memberQuery: e.detail.value }); this.renderMembers(); },
  chooseMemberSection(e: WechatMiniprogram.TouchEvent) { if (this.data.role !== 'admin' || this.data.busy) return; this.closeMember(); this.setData({ memberSection: e.currentTarget.dataset.section === 'pending' ? 'pending' : 'members', error: '' }); },
  filterMembers(e: WechatMiniprogram.TouchEvent) { this.setData({ memberFilter: e.currentTarget.dataset.filter === 'coach' ? 'coach' : 'student' }); this.renderMembers(); },
  openMember(e: WechatMiniprogram.TouchEvent) {
    if (this.data.role !== 'admin' || this.data.busy) return;
    this.setData({ memberDetailId: String(e.currentTarget.dataset.id), error: '' }); this.renderMembers();
    const prices = (snapshot.users || []).find(u => u.id === this.data.memberDetailId)?.prices;
    this.setData({ memberPrivatePrice: prices?.private ? (prices.private / 100).toFixed(2) : '', memberGroupPrice: prices?.group ? (prices.group / 100).toFixed(2) : '' });
  },
  openCoachMember(e: WechatMiniprogram.TouchEvent) { if (!this.data.busy) this.showCoachMember(String(e.currentTarget.dataset.id)); },
  showCoachMember(id: string) {
    const member = this.data.role === 'coach' ? this.data.coachRoster.find(item => item.id === id) : undefined;
    if (!member) { this.setData({ coachMember: null }); return; }
    const ownSessions = new Map((snapshot.sessions || []).filter(s => s.coachId === snapshot.profile?.id).map(s => [s.id, s]));
    const records = (snapshot.bookings || []).filter(b => b.memberId === id && ownSessions.has(b.sessionId)).map(b => {
      const session = ownSessions.get(b.sessionId)!;
      return { id: b.id, statusCode: b.status, title: session.title, schedule: `${dayKey(session.start)} ${time(session.start)}–${time(session.end)}`, status: b.status === 'cancelled' && b.cancelReason ? '门店停课' : statuses[b.status] || b.status, cost: b.cost, amount: b.settleAmountFen === undefined || b.status === 'cancelled' ? '' : money(b.settleAmountFen), start: session.start };
    }).sort((a, b) => b.start - a.start);
    this.setData({ coachMember: { ...member, shortId: id.slice(-6), records } });
  },
  closeMember() { this.setData({ memberDetailId: '', memberDetail: null, memberPacks: [], memberBookings: [], coachMember: null }); },
  switchRole(e: WechatMiniprogram.TouchEvent) { if (this.data.busy) return; const role = e.currentTarget.dataset.role as Role; if (role === this.data.role || !this.data.roles.some(r => r.id === role)) return; this.closeMember(); this.setData({ role, roleName: roleNames[role], navItems: navigation[role], tab: 'home', kind: role === 'coach' ? 'private' : this.data.kind, selectedId: '', editing: null }); wx.pageScrollTo({ scrollTop: 0, duration: 0 }); if (!this.data.demo && snapshot.profile?.id === this.data.profile?.id && snapshotLoadedAt > 0 && Date.now() - snapshotLoadedAt < SWITCH_CACHE_MS) { this.setData({ error: '' }); this.applySnapshot(); } else { this.refresh(); } },
  switchTab(e: WechatMiniprogram.TouchEvent) { if (this.data.busy) return; const tab = String(e.currentTarget.dataset.tab); if (!navigation[this.data.role].some(item => item.id === tab)) return; this.closeMember(); this.setData({ tab, selectedId: '', editing: null, error: '' }); if (tab === 'finance') this.loadMemberPrices(); wx.pageScrollTo({ scrollTop: 0, duration: 0 }); },
  chooseDay(e: WechatMiniprogram.TouchEvent) { this.setData({ day: String(e.currentTarget.dataset.day) }); this.renderData(); },
  chooseScheduleDate(e: WechatMiniprogram.PickerChange) { this.setData({ day: String(e.detail.value) }); this.renderData(); },
  chooseKind(e: WechatMiniprogram.TouchEvent) { this.setData({ kind: String(e.currentTarget.dataset.kind) }); this.renderData(); },
  chooseCoach(e: WechatMiniprogram.PickerChange) { this.setData({ coachIndex: Number(e.detail.value) }); this.renderData(); },
  chooseMember(e: WechatMiniprogram.PickerChange) { this.setData({ memberIndex: Number(e.detail.value) }); this.loadMemberPrices(); },
  loadMemberPrices() {
    const prices = (snapshot.users || []).find(u => u.id === this.data.users[this.data.memberIndex]?.id)?.prices;
    this.setData({ privatePrice: prices?.private ? (prices.private / 100).toFixed(2) : '', groupPrice: prices?.group ? (prices.group / 100).toFixed(2) : '' });
  },
  chooseSalesCoach(e: WechatMiniprogram.PickerChange) { this.setData({ salesCoachIndex: Number(e.detail.value) }); },
  choosePurchaseExpiry(e: WechatMiniprogram.PickerChange) { this.setData({ purchaseExpiry: String(e.detail.value), error: '' }); },
  editPurchaseAmount(e: WechatMiniprogram.Input) { this.setData({ purchaseAmount: e.detail.value }); },
  editPurchaseNote(e: WechatMiniprogram.Input) { this.setData({ purchaseNote: e.detail.value }); },
  editPrivatePrice(e: WechatMiniprogram.Input) { this.setData({ privatePrice: e.detail.value }); },
  editGroupPrice(e: WechatMiniprogram.Input) { this.setData({ groupPrice: e.detail.value }); },
  editMemberPrivatePrice(e: WechatMiniprogram.Input) { this.setData({ memberPrivatePrice: e.detail.value }); },
  editMemberGroupPrice(e: WechatMiniprogram.Input) { this.setData({ memberGroupPrice: e.detail.value }); },
  async saveMemberPrices() {
    if (this.data.role !== 'admin' || !this.data.memberDetail || this.data.busy) return;
    this.beginActionError('setMemberPrices');
    let prices: { private: number; group: number };
    try { prices = { private: positiveMoneyFen(this.data.memberPrivatePrice, '私教单价'), group: positiveMoneyFen(this.data.memberGroupPrice, '团课单价') }; }
    catch (e) { this.setData({ error: (e as Error).message }); return; }
    await this.mutate({ action: 'setMemberPrices', userId: this.data.memberDetail.id, prices }, '课程价格已保存');
  },
  choosePackage(e: WechatMiniprogram.PickerChange) { this.setData({ packageIndex: Number(e.detail.value) }); },
  chooseRegistrationBirthday(e: WechatMiniprogram.PickerChange) { this.setData({ registrationBirthday: String(e.detail.value), error: '' }); },
  editMemberName(e: WechatMiniprogram.Input) { if (this.data.memberDetail) this.setData({ memberDetail: { ...this.data.memberDetail, name: e.detail.value } }); },
  editMemberPhone(e: WechatMiniprogram.Input) { if (this.data.memberDetail) this.setData({ memberDetail: { ...this.data.memberDetail, phone: e.detail.value } }); },
  chooseMemberBirthday(e: WechatMiniprogram.PickerChange) { if (this.data.memberDetail) this.setData({ memberDetail: { ...this.data.memberDetail, birthday: String(e.detail.value) }, error: '' }); },
  startScheduleDrag(e: WechatMiniprogram.TouchEvent) {
    if (this.data.busy || this.data.role === 'student') return;
    const index = Number(e.currentTarget.dataset.index); const slot = this.data.scheduleSlots[index]; if (!slot) return;
    dragAnchor = index; dragCurrent = index;
    this.setData({ dragging: slot.state === 'free' && !slot.disabled, scheduleSlots: this.data.scheduleSlots.map((item, i) => ({ ...item, selected: i === index && slot.state === 'free' && !slot.disabled })) });
    wx.createSelectorQuery().selectAll('.schedule-block').boundingClientRect(result => { dragRects = (result as unknown as { top: number; bottom: number; left: number; right: number; dataset?: { index?: string | number } }[]) || []; }).exec();
  },
  tapScheduleSlot(e: WechatMiniprogram.TouchEvent) {
    if (this.data.dragging) return;
    this.startScheduleDrag(e); this.endScheduleDrag();
  },
  moveScheduleDrag(e: WechatMiniprogram.TouchEvent) {
    if (dragAnchor < 0 || !this.data.dragging) return;
    const touch = e.touches[0]; if (!touch) return;
    const rect = dragRects.find(item => touch.clientY >= item.top && touch.clientY <= item.bottom && touch.clientX >= item.left && touch.clientX <= item.right);
    const index = Number(rect?.dataset?.index); if (!rect || !Number.isInteger(index)) return;
    const direction = index >= dragAnchor ? 1 : -1; let next = dragAnchor;
    while (next !== index) {
      const candidate = next + direction; const size = Math.abs(candidate - dragAnchor) + 1; const slot = this.data.scheduleSlots[candidate];
      if (!slot || slot.day !== this.data.scheduleSlots[dragAnchor]?.day || slot.state !== 'free' || slot.disabled || size > 2) break;
      next = candidate;
    }
    dragCurrent = next; const low = Math.min(dragAnchor, dragCurrent), high = Math.max(dragAnchor, dragCurrent);
    this.setData({ scheduleSlots: this.data.scheduleSlots.map((item, i) => ({ ...item, selected: i >= low && i <= high })) });
  },
  cancelScheduleDrag() { dragAnchor = -1; dragCurrent = -1; dragRects = []; this.setData({ dragging: false, scheduleSlots: this.data.scheduleSlots.map(item => ({ ...item, selected: false })) }); },
  async endScheduleDrag() {
    if (dragAnchor < 0) return;
    const anchor = dragAnchor; const current = dragCurrent; const slot = this.data.scheduleSlots[anchor];
    let low = Math.min(anchor, current), high = Math.max(anchor, current);
    if (slot?.state === 'free' && low === high) {
      const next = this.data.scheduleSlots[high + 1];
      if (next?.day === slot.day && next.state === 'free' && !next.disabled) high += 1;
      else { this.cancelScheduleDrag(); await wx.showModal({ title: '无法安排一节课', content: '私教课固定 1 小时，后续半小时当前不可用。请选择其他开始时间。', showCancel: false }); return; }
    }
    const rangeStart = this.data.scheduleSlots[low]?.start; const rangeEnd = this.data.scheduleSlots[high]?.end;
    this.cancelScheduleDrag(); if (!slot || rangeStart === undefined || rangeEnd === undefined) return;
    if (slot.state === 'booked') {
      const session = (snapshot.sessions || []).find(s => s.id === slot.sessionId);
      if (!session) return;
      const canStop = this.data.role === 'admin' && session.start > Date.now();
      let choice: WechatMiniprogram.ShowActionSheetSuccessCallbackResult;
      try { choice = await wx.showActionSheet({ itemList: canStop ? ['查看课程与预约', '整场停课 · 退回冻结余额或课时'] : ['查看课程与预约'] }); } catch { return; }
      if (canStop && choice.tapIndex === 1) {
        await this.cancelSession({ currentTarget: { dataset: { id: session.id } } } as unknown as WechatMiniprogram.TouchEvent);
      } else {
        const names = (snapshot.bookings || []).filter(b => b.sessionId === session.id && b.status === 'confirmed').map(b => [...(snapshot.users || []), ...(snapshot.roster || [])].find(u => u.id === b.memberId)?.name || '学员');
        await wx.showModal({ title: session.title, content: `${dayKey(session.start)} ${time(session.start)}–${time(session.end)}\n地点：${session.roomId}\n已约 ${session.reserved} / ${session.capacity} 人\n${names.join('、') || '暂无预约名单'}${this.data.role === 'coach' ? '\n如需停课，请联系门店管理员。' : ''}`, showCancel: false });
      }
      return;
    }
    if (slot.start <= Date.now()) { await wx.showModal({ title: '暂不可修改', content: '已开始或已过去的时间不能调整。', showCancel: false }); return; }
    const existing = slot.state !== 'free';
    const options = !existing ? [`排课 ${time(rangeStart)}–${time(rangeEnd)}`, '标记休息'] : slot.state === 'rest' ? ['改为排课', '取消休息'] : ['标记休息', '取消排课', '编辑时段'];
    let choice: WechatMiniprogram.ShowActionSheetSuccessCallbackResult;
    try { choice = await wx.showActionSheet({ itemList: options }); } catch { return; }
    if (slot.state === 'scheduled' && choice.tapIndex === 2) {
      this.editSlot({ currentTarget: { dataset: { id: slot.sessionId } } } as unknown as WechatMiniprogram.TouchEvent);
      return;
    }
    const state = !existing ? (choice.tapIndex === 0 ? 'open' : 'rest')
      : slot.state === 'rest' ? (choice.tapIndex === 0 ? 'open' : 'clear')
      : (choice.tapIndex === 0 ? 'rest' : 'clear');
    const coachId = this.data.role === 'coach' ? snapshot.profile?.id : this.data.coaches[this.data.coachIndex]?.id;
    this.beginActionError('setSlotState');
    if (!coachId) { this.setData({ error: '请先选择教练' }); return; }
    await this.mutate({ action: 'setSlotState', coachId, ...(existing ? { sessionId: slot.sessionId } : {}), start: existing ? slot.sessionStart : rangeStart, end: existing ? slot.sessionEnd : rangeEnd, state }, state === 'open' ? '已排课' : state === 'rest' ? '已标记休息' : '已清除');
  },
  selectSession(e: WechatMiniprogram.TouchEvent) {
    const s = (snapshot.sessions || []).find(s => s.id === e.currentTarget.dataset.id); if (!s) return;
    const price = snapshot.profile?.prices?.[s.kind as 'private' | 'group'];
    const eligible = (snapshot.packages || []).filter(p => p.kind === 'wallet' && p.memberId === snapshot.profile?.id && p.expiresAt >= s.start && !!price && p.available >= price * s.cost).map(p => ({ id: p.id, label: `通用余额 ${money(p.available)} · 本次 ${money(price! * s.cost)}`, freezeLabel: money(price! * s.cost), expectedAmountFen: price! * s.cost }));
    this.setData({ selectedId: s.id, selectedTitle: s.title, selectedTime: `${dayKey(s.start)} ${time(s.start)}–${time(s.end)}`, selectedCost: s.cost, selectedCancel: s.cancelHours, eligible, packageIndex: 0 });
  },
  dismiss() { this.setData({ selectedId: '' }); },
  beginActionError(scope: string, id = '') { this.setData({ error: '', errorScope: scope, errorId: id }); },
  async enableReceiptNotification(e?: WechatMiniprogram.TouchEvent) {
    if (this.data.subscribingReceipt) return;
    this.setData({ subscribingReceipt: true, subscriptionMessage: '' });
    try { this.setData({ subscriptionMessage: await subscribeReceipt(e?.currentTarget.dataset.kind === 'booking') }); }
    catch (e) { this.setData({ subscriptionMessage: e instanceof Error ? e.message : '订阅未完成，请稍后重试' }); }
    finally { this.setData({ subscribingReceipt: false }); }
  },
  async retryReceiptNotification(e: WechatMiniprogram.TouchEvent) {
    if (this.data.busy || this.data.role === 'student') return;
    const id = String(e.currentTarget.dataset.id); this.beginActionError('sendReceipt', id);
    this.setData({ busy: true });
    try { await sendReceiptNotification(id); }
    catch (e) { this.setData({ error: e instanceof Error ? e.message : '微信通知未完成' }); }
    finally { this.setData({ busy: false }); }
    const { error, errorScope, errorId } = this.data; await this.refresh(); if (error) this.setData({ error, errorScope, errorId });
  },
  async mutate(command: Record<string, unknown>, success: string) {
    if (this.data.busy) return;
    this.beginActionError(String(command.action), String(command.userId || command.bookingId || command.sessionId || ''));
    this.setData({ busy: true, error: '' });
    try { await api(this.data.role, command); if (command.action === 'settle' && command.outcome === 'attended') { try { await sendReceiptNotification(String(command.bookingId)); } catch { /* Settlement is committed; pending delivery remains retryable. */ } } this.setData({ selectedId: '', ...(command.action === 'editSlot' ? { editing: null } : {}) }); wx.showToast({ title: success, icon: 'success' }); }
    catch (e) { this.setData({ error: e instanceof Error ? e.message : '操作失败' }); }
    finally { this.setData({ busy: false }); }
    const { error, errorScope, errorId } = this.data; await this.refresh(); if (error) this.setData({ error, errorScope, errorId });
  },
  confirmBook() { const p = this.data.eligible[this.data.packageIndex]; if (p) this.mutate({ action: 'book', sessionId: this.data.selectedId, packageId: p.id, ...(p.expectedAmountFen ? { expectedAmountFen: p.expectedAmountFen } : {}) }, '预约成功'); },
  async cancelBooking(e: WechatMiniprogram.TouchEvent) { const r = await wx.showModal({ title: '取消预约', content: '取消后冻结金额退回可用余额，是否继续？' }); if (r.confirm) this.mutate({ action: 'cancel', bookingId: e.currentTarget.dataset.id }, '已取消'); },
  async settle(e: WechatMiniprogram.TouchEvent) {
    const outcome = e.currentTarget.dataset.outcome; const bookingId = String(e.currentTarget.dataset.id);
    const booking = (this.data.bookings as { id: string; unitPriceLabel?: string; settleAmountLabel?: string }[]).find(item => item.id === bookingId);
    const price = booking?.unitPriceLabel ? `课单价 ${booking.unitPriceLabel}${booking.settleAmountLabel ? `，本次预计扣款 ${booking.settleAmountLabel}` : ''}。` : '该预约缺少价格记录，请先核对。';
    const r = await wx.showModal({ title: outcome === 'absent' ? '确认爽约并扣费' : '确认到课并扣费', content: `${price}将冻结金额转为已消费，并自动向学员发送站内扣费及余额通知。请核对学员后确认。` });
    if (r.confirm) this.mutate({ action: 'settle', bookingId, outcome }, '已结算并发送站内通知');
  },
  editSlot(e: WechatMiniprogram.TouchEvent) {
    if (this.data.busy || this.data.role === 'student') return;
    const s = (snapshot.sessions || []).find(s => s.id === e.currentTarget.dataset.id);
    if (!s || s.status !== 'open' || s.reserved !== 0 || s.start <= Date.now()) return;
    this.setData({ error: '', editing: { id: s.id, title: s.title, day: dayKey(s.start), start: time(s.start), end: time(s.end), room: s.roomId, capacity: s.capacity, kind: s.kind } });
  },
  dismissEdit() { if (!this.data.busy) this.setData({ editing: null }); },
  changeEditDate(e: WechatMiniprogram.PickerChange) { if (this.data.editing) this.setData({ editing: { ...this.data.editing, day: String(e.detail.value) } }); },
  async saveSlot(e: WechatMiniprogram.FormSubmit) {
    const edit = this.data.editing; if (!edit || this.data.busy) return;
    this.beginActionError('editSlot');
    const v = e.detail.value as Record<string, string>;
    const startText = this.data.role === 'coach' ? edit.start : v.start || '', endText = this.data.role === 'coach' ? edit.end : v.end || '';
    if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(startText) || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(endText)) { this.setData({ error: '请输入有效的 24 小时时间，如 09:00' }); return; }
    const start = Date.parse(`${edit.day}T${startText}:00+08:00`), end = Date.parse(`${edit.day}T${endText}:00+08:00`);
    if (start <= Date.now() || end <= start || end - start > 4 * 3600000) { this.setData({ error: '课程须在未来，同一天内且不超过四小时' }); return; }
    await this.mutate({ action: 'editSlot', sessionId: edit.id, title: v.title, roomId: v.room, start, end, capacity: edit.kind === 'private' ? 1 : Number(v.capacity) }, '时段已更新');
    if (!this.data.editing) { this.setData({ day: edit.day }); this.renderData(); }
  },
  async cancelSession(e: WechatMiniprogram.TouchEvent) {
    if (this.data.busy || this.data.role !== 'admin') return;
    const s = (snapshot.sessions || []).find(s => s.id === e.currentTarget.dataset.id); if (!s) return;
    this.beginActionError('cancelSession', s.id);
    const r = await wx.showModal({ title: '填写停课原因', content: '', editable: true, placeholderText: '请输入停课原因（1–100字）', confirmText: '下一步' });
    if (!r.confirm || this.data.role !== 'admin') return;
    const reason = (r.content || '').trim();
    if (!reason || reason.length > 100) { this.setData({ error: '请填写 1–100 字的停课原因' }); return; }
    const confirm = await wx.showModal({ title: '确认整场停课', content: `${s.title} · ${dayKey(s.start)} ${time(s.start)}，当前 ${s.reserved} 人预约。原因：${reason}。确认后取消全部预约、释放冻结金额，保留历史记录；此操作不能直接撤销。`, confirmText: '确认停课', confirmColor: '#b23b30' });
    if (confirm.confirm && this.data.role === 'admin') await this.mutate({ action: 'cancelSession', sessionId: s.id, reason }, '已停课并退回课时');
  },
  closeSlot(e: WechatMiniprogram.TouchEvent) { this.mutate({ action: 'closeSlot', sessionId: e.currentTarget.dataset.id }, '时段已关闭'); },
  approve(e: WechatMiniprogram.TouchEvent) { this.mutate({ action: 'approve', userId: e.currentTarget.dataset.id }, '审核通过'); },
  async setCoach(e: WechatMiniprogram.TouchEvent) {
    if (this.data.busy || this.data.role !== 'admin') return;
    const member = this.data.staffMembers.find(u => u.id === e.currentTarget.dataset.id);
    if (!member) return;
    const enabled = !member.isCoach;
    const r = await wx.showModal({ title: enabled ? '设为教练' : '取消教练身份', content: enabled ? `将 ${member.name}（${member.shortId}）设为教练，可维护自己的私教排班、查看授课预约并确认出勤。保留学员身份。` : `取消 ${member.name}（${member.shortId}）的教练权限，保留学员及其他已有身份。有未结束排课或未结算预约时无法取消。`, confirmText: enabled ? '确认设置' : '确认取消' });
    if (r.confirm && this.data.role === 'admin' && !this.data.busy) await this.mutate({ action: 'setCoach', userId: member.id, enabled }, enabled ? '已设为教练' : '已取消教练身份');
  },
  register(e: WechatMiniprogram.FormSubmit) {
    if (!this.data.registrationBirthday) { this.setData({ error: '请选择生日' }); return; }
    this.mutate({ action: 'register', ...e.detail.value, birthday: this.data.registrationBirthday }, '已提交');
  },
  async updateMember(e: WechatMiniprogram.FormSubmit) {
    if (this.data.role !== 'admin' || !this.data.memberDetail || this.data.busy) return;
    this.beginActionError('updateMember');
    if (!this.data.memberDetail.birthday) { this.setData({ error: '请选择生日' }); return; }
    await this.mutate({ action: 'updateMember', userId: this.data.memberDetail.id, ...e.detail.value, birthday: this.data.memberDetail.birthday }, '基础资料已保存');
  },
  async updateCoachPay(e: WechatMiniprogram.TouchEvent) {
    if (this.data.role !== 'admin' || !this.data.memberDetail?.isCoach || this.data.busy) return;
    const employmentType = String(e.currentTarget.dataset.type) === 'partTime' ? 'partTime' : 'fullTime';
    await this.mutate({ action: 'updateCoachPay', userId: this.data.memberDetail.id, employmentType }, `已设为${employmentType === 'fullTime' ? '全职' : '兼职'}教练`);
  },
  choosePublishStart(e: WechatMiniprogram.PickerChange) { this.setData({ publishStart: String(e.detail.value), error: '' }); },
  choosePublishEnd(e: WechatMiniprogram.PickerChange) { this.setData({ publishEnd: String(e.detail.value), error: '' }); },
  publish(e: WechatMiniprogram.FormSubmit) {
    if (this.data.busy || this.data.role === 'student') return;
    this.beginActionError('publish');
    const v = e.detail.value as Record<string, string>;
    if (!this.data.publishStart || !this.data.publishEnd) { this.setData({ error: '请选择开始时间和结束时间' }); return; }
    const start = Date.parse(`${this.data.day}T${this.data.publishStart}:00+08:00`);
    const end = Date.parse(`${this.data.day}T${this.data.publishEnd}:00+08:00`);
    if (!Number.isFinite(start) || !Number.isFinite(end) || start <= Date.now() || end <= start || end - start > 4 * 3600000) { this.setData({ error: '请选择未来的时段，结束须晚于开始，同一天内且不超过四小时' }); return; }
    const coachId = this.data.role === 'coach' ? snapshot.profile?.id : this.data.coaches[this.data.coachIndex]?.id;
    this.mutate({ action: 'publish', kind: this.data.role === 'coach' ? 'private' : this.data.kind, title: v.title, coachId, roomId: v.room || '开放区', exclusive: false, start, end, capacity: this.data.role === 'coach' || this.data.kind === 'private' ? 1 : Number(v.capacity), cost: 1 }, '排课已发布');
  },
  chooseCopyMode(e: WechatMiniprogram.TouchEvent) { if (!this.data.busy) this.setData({ copyMode: e.currentTarget.dataset.mode === 'week' ? 'week' : 'day', error: '' }); },
  chooseCopySource(e: WechatMiniprogram.PickerChange) { this.setData({ copySourceDay: String(e.detail.value), error: '' }); this.renderData(); },
  chooseCopyDestination(e: WechatMiniprogram.PickerChange) { this.setData({ copyDestinationDay: String(e.detail.value), error: '' }); },
  async copyDay() {
    if (this.data.busy || this.data.role === 'student') return;
    this.beginActionError('copyDay');
    if (this.data.copyUnavailable) { this.setData({ error: '排课记录较多，暂无法完整复制，请逐个时段发布' }); return; }
    const sourceDay = this.data.copySourceDay || this.data.day;
    const targetDay = this.data.copyDestinationDay;
    const sourceStart = Date.parse(`${sourceDay}T00:00:00+08:00`);
    const targetStart = Date.parse(`${targetDay}T00:00:00+08:00`);
    if (!Number.isFinite(sourceStart) || !Number.isFinite(targetStart) || sourceDay === targetDay || targetDay < dayKey(Date.now())) { this.setData({ error: '请选择今天或之后、且与来源不同的目标日期' }); return; }
    const coachId = this.data.role === 'coach' ? snapshot.profile?.id : this.data.coaches[this.data.coachIndex]?.id;
    const sources = (snapshot.sessions || []).filter(s => s.kind === 'private' && s.status === 'open' && s.coachId === coachId && dayKey(s.start) === sourceDay);
    const sessionIds = sources.filter(canCopy).map(s => s.id);
    if (!sessionIds.length || sessionIds.length > 35) { this.setData({ error: '来源日期需有 1–35 个开放的私教时段' }); return; }
    const role = this.data.role;
    const r = await wx.showModal({ title: '按天复制私教排班', content: `${copyWarning(sources)}将 ${sourceDay} 的 ${sessionIds.length} 个时段复制到 ${targetDay}，保持原上课时间、地点和教练。不复制预约或休息；如目标时间已过或存在冲突，本次全部不创建。` });
    if (r.confirm && role === this.data.role) await this.mutate({ action: 'copyDay', sessionIds, sourceStart, targetStart }, '当天排班已复制');
  },
  async copyWeek() {
    if (this.data.busy || this.data.role === 'student') return;
    this.beginActionError('copyWeek');
    if (this.data.copyUnavailable) { this.setData({ error: '排课记录较多，暂不支持整周复制，请逐日发布' }); return; }
    const sourceStart = Date.parse(`${this.data.day}T00:00:00+08:00`);
    const coachId = this.data.role === 'coach' ? snapshot.profile?.id : this.data.coaches[this.data.coachIndex]?.id;
    const sources = (snapshot.sessions || []).filter(s => s.kind === 'private' && s.status === 'open' && s.coachId === coachId && s.start >= sourceStart && s.start < sourceStart + 7 * 86400000);
    const sessionIds = sources.filter(canCopy).map(s => s.id);
    if (!sessionIds.length || sessionIds.length > 35) { this.setData({ error: '请选择含 1–35 个私教时段的七天排班' }); return; }
    const role = this.data.role;
    const r = await wx.showModal({ title: '复制私教排班到下一周', content: `${copyWarning(sources)}将 ${this.data.day} 至 ${this.data.copyEnd} 的 ${sessionIds.length} 个时段复制到 ${this.data.copyTarget} 至 ${this.data.copyTargetEnd}。不复制预约；如有冲突，本次全部不创建。` });
    if (r.confirm && role === this.data.role) await this.mutate({ action: 'copyWeek', sessionIds, sourceStart }, '排班已复制');
  },
  purchase() {
    if (this.data.busy || this.data.role !== 'admin') return;
    this.beginActionError('recharge');
    const v = { amount: this.data.purchaseAmount, privatePrice: this.data.privatePrice, groupPrice: this.data.groupPrice, note: this.data.purchaseNote };
    if (!this.data.users[this.data.memberIndex]?.id) { this.setData({ error: '请选择充值学员' }); return; }
    if (!v.note?.trim() || v.note.trim().length > 200) { this.setData({ error: '请填写收款凭据 / 备注（1–200 字）' }); return; }
    let amountFen: number; let prices: { private: number; group: number };
    try { amountFen = positiveMoneyFen(v.amount || '', '实收金额'); prices = { private: positiveMoneyFen(v.privatePrice || '', '私教单价'), group: positiveMoneyFen(v.groupPrice || '', '团课单价') }; }
    catch (e) { this.setData({ error: e instanceof Error ? e.message : '请检查实收金额和课程单价' }); return; }
    const expiresAt = Date.parse(`${this.data.purchaseExpiry}T23:59:59+08:00`);
    if (!this.data.purchaseExpiry || !Number.isFinite(expiresAt) || expiresAt <= Date.now()) { this.setData({ error: '请选择今天或之后的有效期' }); return; }
    const coach = this.data.salesCoachIndex > 0 ? this.data.coaches[this.data.salesCoachIndex - 1] : undefined;
    this.mutate({ action: 'recharge', memberId: this.data.users[this.data.memberIndex]?.id, prices, amountFen, ...(coach ? { salesCoachId: coach.id } : {}), expiresAt, method: 'transfer', note: v.note }, '充值成功');
  },
});
