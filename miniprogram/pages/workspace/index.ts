import { api, Dashboard, Role, Session } from '../../services/api';
import { config } from '../../config';

const dayKey = (n: number) => new Date(n + 8 * 3600000).toISOString().slice(0, 10);
const time = (n: number) => new Date(n + 8 * 3600000).toISOString().slice(11, 16);
const roleNames = { student: '学员端', coach: '教练端', admin: '管理端' };
const statuses: Record<string, string> = { confirmed: '待上课', cancelled: '已取消', attended: '已到课', absent: '爽约已结算' };
let snapshot: Dashboard = { profile: null };
Page({
  data: {
    demo: config.mode === 'demo', role: 'student' as Role, roleName: '学员端', roles: [] as { id: Role; name: string }[],
    tab: 'home', busy: false, error: '', profile: null as Dashboard['profile'],
    days: Array.from({ length: 7 }, (_, i) => { const key = dayKey(Date.now() + i * 86400000); return { key, short: key.slice(5), label: i === 0 ? '今天' : ['日', '一', '二', '三', '四', '五', '六'][new Date(`${key}T12:00:00+08:00`).getUTCDay()] }; }),
    day: dayKey(Date.now()), kind: 'private', coachIndex: 0, coaches: [] as { id: string; name: string }[],
    sessions: [] as object[], bookings: [] as object[], packs: [] as object[], messages: [] as object[], ledger: [] as object[], pending: [] as object[],
    users: [] as { id: string; name: string }[], memberIndex: 0, purchaseKindIndex: 0, kindNames: ['私教', '团课'],
    totalAvailable: 0, totalFrozen: 0, totalConsumed: 0, myCount: 0,
    selectedId: '', selectedTitle: '', selectedTime: '', selectedCost: 1, selectedCancel: 0, eligible: [] as { id: string; label: string }[], packageIndex: 0,
  },
  onLoad() { this.refresh(); },
  onPullDownRefresh() { this.refresh().finally(() => wx.stopPullDownRefresh()); },
  async refresh() {
    if (this.data.busy) return;
    this.setData({ busy: true, error: '' });
    try {
      snapshot = await api<Dashboard>(this.data.role, { action: 'dashboard' });
      const available = this.data.demo ? ['student', 'coach', 'admin'] as Role[] : snapshot.profile?.roles || [];
      const role = available.includes(this.data.role) ? this.data.role : available[0] || 'student';
      this.setData({ profile: snapshot.profile, role, roleName: roleNames[role], roles: available.map(id => ({ id, name: roleNames[id] })), coaches: snapshot.coaches || [], users: (snapshot.users || []).filter(u => u.status === 'active' && u.roles.includes('student')).map(u => ({ id: u.id, name: u.name })), pending: (snapshot.users || []).filter(u => u.status === 'pending') });
      this.renderData();
    } catch (e) { this.setData({ error: e instanceof Error ? e.message : '加载失败' }); }
    finally { this.setData({ busy: false }); }
  },
  renderData() {
    const now = Date.now(); const all = snapshot.sessions || []; const profile = snapshot.profile;
    const coaches = snapshot.coaches || []; const coach = coaches[this.data.coachIndex];
    const sessions = all.filter(s => dayKey(s.start) === this.data.day && s.status === 'open' && (this.data.role === 'student' ? s.kind === this.data.kind && (s.kind === 'group' || !coach || s.coachId === coach.id) : this.data.role === 'coach' ? s.coachId === profile?.id : true)).sort((a, b) => a.start - b.start).map(s => ({ ...s, startLabel: time(s.start), endLabel: time(s.end), coachName: coaches.find(c => c.id === s.coachId)?.name || '教练', kindName: s.kind === 'private' ? '私教' : '团课', free: s.capacity - s.reserved, canBook: s.reserved < s.capacity && s.start - now >= s.cutoffMinutes * 60000, canClose: s.reserved === 0 && s.start > now && (this.data.role === 'admin' || s.kind === 'private') }));
    const bookings = (snapshot.bookings || []).filter(b => this.data.role !== 'student' || b.memberId === profile?.id).map(b => { const s = all.find(s => s.id === b.sessionId); return { ...b, title: s?.title || '历史课程', schedule: s ? `${dayKey(s.start)} ${time(s.start)}–${time(s.end)}` : '', statusName: statuses[b.status] || b.status, memberName: [...(snapshot.users || []), ...(snapshot.roster || [])].find(u => u.id === b.memberId)?.name || b.memberId.slice(-6), canCancel: b.status === 'confirmed' && !!s && s.start - now >= s.cancelHours * 3600000, canSettle: b.status === 'confirmed' && !!s && s.end <= now }; });
    const packs = (snapshot.packages || []).filter(p => this.data.role === 'admin' || p.memberId === profile?.id);
    this.setData({ sessions, bookings, myCount: bookings.filter(b => b.status === 'confirmed').length, packs: packs.map(p => ({ ...p, title: p.kind === 'private' ? '私教课包' : '团课课包', expiry: dayKey(p.expiresAt), expired: p.expiresAt < now })), totalAvailable: packs.filter(p => p.expiresAt >= now).reduce((a, p) => a + p.available, 0), totalFrozen: packs.reduce((a, p) => a + p.frozen, 0), totalConsumed: packs.reduce((a, p) => a + p.consumed, 0), messages: (snapshot.inbox || []).sort((a, b) => b.at - a.at).map(m => ({ ...m, date: `${dayKey(m.at)} ${time(m.at)}` })), ledger: (snapshot.ledger || []).sort((a, b) => b.at - a.at).map(l => ({ ...l, title: ({ purchase: '购课入账', freeze: '预约冻结', release: '取消释放', consume: '出勤消课' } as Record<string, string>)[l.type] || l.type, date: dayKey(l.at) })) });
  },
  switchRole(e: WechatMiniprogram.TouchEvent) { if (this.data.busy) return; const role = e.currentTarget.dataset.role as Role; if (!this.data.roles.some(r => r.id === role)) return; this.setData({ role, roleName: roleNames[role], tab: 'home', selectedId: '' }); this.refresh(); },
  switchTab(e: WechatMiniprogram.TouchEvent) { this.setData({ tab: String(e.currentTarget.dataset.tab), selectedId: '' }); },
  chooseDay(e: WechatMiniprogram.TouchEvent) { this.setData({ day: String(e.currentTarget.dataset.day) }); this.renderData(); },
  chooseKind(e: WechatMiniprogram.TouchEvent) { this.setData({ kind: String(e.currentTarget.dataset.kind) }); this.renderData(); },
  chooseCoach(e: WechatMiniprogram.PickerChange) { this.setData({ coachIndex: Number(e.detail.value) }); this.renderData(); },
  chooseMember(e: WechatMiniprogram.PickerChange) { this.setData({ memberIndex: Number(e.detail.value) }); },
  choosePurchaseKind(e: WechatMiniprogram.PickerChange) { this.setData({ purchaseKindIndex: Number(e.detail.value) }); },
  choosePackage(e: WechatMiniprogram.PickerChange) { this.setData({ packageIndex: Number(e.detail.value) }); },
  selectSession(e: WechatMiniprogram.TouchEvent) {
    const s = (snapshot.sessions || []).find(s => s.id === e.currentTarget.dataset.id); if (!s) return;
    const eligible = (snapshot.packages || []).filter(p => p.memberId === snapshot.profile?.id && p.kind === s.kind && p.available >= s.cost && p.expiresAt >= s.start && (p.kind !== 'private' || p.coachIds.includes(s.coachId))).sort((a, b) => a.expiresAt - b.expiresAt).map(p => ({ id: p.id, label: `${p.kind === 'private' ? '私教' : '团课'} · 余 ${p.available} 节 · ${dayKey(p.expiresAt)} 到期` }));
    this.setData({ selectedId: s.id, selectedTitle: s.title, selectedTime: `${dayKey(s.start)} ${time(s.start)}–${time(s.end)}`, selectedCost: s.cost, selectedCancel: s.cancelHours, eligible, packageIndex: 0 });
  },
  dismiss() { this.setData({ selectedId: '' }); },
  async mutate(command: Record<string, unknown>, success: string) {
    if (this.data.busy) return;
    this.setData({ busy: true, error: '' });
    try { await api(this.data.role, command); this.setData({ selectedId: '' }); wx.showToast({ title: success, icon: 'success' }); }
    catch (e) { this.setData({ error: e instanceof Error ? e.message : '操作失败' }); }
    finally { this.setData({ busy: false }); }
    const error = this.data.error; await this.refresh(); if (error) this.setData({ error });
  },
  confirmBook() { const p = this.data.eligible[this.data.packageIndex]; if (p) this.mutate({ action: 'book', sessionId: this.data.selectedId, packageId: p.id }, '预约成功'); },
  async cancelBooking(e: WechatMiniprogram.TouchEvent) { const r = await wx.showModal({ title: '取消预约', content: '取消后冻结课时退回原课包，是否继续？' }); if (r.confirm) this.mutate({ action: 'cancel', bookingId: e.currentTarget.dataset.id }, '已取消'); },
  async settle(e: WechatMiniprogram.TouchEvent) { const outcome = e.currentTarget.dataset.outcome; const r = await wx.showModal({ title: outcome === 'absent' ? '确认爽约并扣课' : '确认到课并扣课', content: '将冻结课时转为已消耗。请核对学员后确认。' }); if (r.confirm) this.mutate({ action: 'settle', bookingId: e.currentTarget.dataset.id, outcome }, '已结算'); },
  closeSlot(e: WechatMiniprogram.TouchEvent) { this.mutate({ action: 'closeSlot', sessionId: e.currentTarget.dataset.id }, '时段已关闭'); },
  approve(e: WechatMiniprogram.TouchEvent) { this.mutate({ action: 'approve', userId: e.currentTarget.dataset.id }, '审核通过'); },
  register(e: WechatMiniprogram.FormSubmit) { this.mutate({ action: 'register', ...e.detail.value }, '已提交'); },
  publish(e: WechatMiniprogram.FormSubmit) {
    const v = e.detail.value as Record<string, string>; const start = Date.parse(`${this.data.day}T${v.start}:00+08:00`); const end = Date.parse(`${this.data.day}T${v.end}:00+08:00`);
    const coachId = this.data.role === 'coach' ? snapshot.profile?.id : this.data.coaches[this.data.coachIndex]?.id;
    this.mutate({ action: 'publish', kind: this.data.role === 'coach' ? 'private' : this.data.kind, title: v.title, coachId, roomId: v.room || '开放区', exclusive: false, start, end, capacity: this.data.role === 'coach' || this.data.kind === 'private' ? 1 : Number(v.capacity), cost: 1 }, '排课已发布');
  },
  purchase(e: WechatMiniprogram.FormSubmit) {
    const v = e.detail.value as Record<string, string>; const kind = this.data.purchaseKindIndex === 0 ? 'private' : 'group';
    if (!/^\d+(\.\d{1,2})?$/.test(v.amount || '')) { this.setData({ error: '金额须为非负数字，最多两位小数' }); return; }
    const coach = this.data.coaches[this.data.coachIndex];
    this.mutate({ action: 'purchase', memberId: this.data.users[this.data.memberIndex]?.id, kind, coachIds: kind === 'private' && coach ? [coach.id] : [], credits: Number(v.credits), amountFen: Math.round(Number(v.amount) * 100), expiresAt: Date.parse(`${v.expiry}T23:59:59+08:00`), method: 'transfer', note: v.note }, '入账成功');
  },
});
