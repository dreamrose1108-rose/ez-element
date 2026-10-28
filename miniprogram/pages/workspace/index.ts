import { api, Dashboard, Role, Session } from '../../services/api';
import { config } from '../../config';

const dayKey = (n: number) => new Date(n + 8 * 3600000).toISOString().slice(0, 10);
const time = (n: number) => new Date(n + 8 * 3600000).toISOString().slice(11, 16);
const roleNames = { student: '学员端', coach: '教练端', admin: '管理端' };
const navigation = {
  student: [{ id: 'home', name: '我的课程' }, { id: 'schedule', name: '预约训练' }, { id: 'account', name: '我的课包' }, { id: 'messages', name: '消息' }],
  coach: [{ id: 'home', name: '授课出勤' }, { id: 'schedule', name: '我的排班' }, { id: 'account', name: '学员名单' }, { id: 'messages', name: '消息' }],
  admin: [{ id: 'home', name: '工作台' }, { id: 'schedule', name: '课程排班' }, { id: 'account', name: '学员管理' }, { id: 'finance', name: '收款账务' }],
};
const statuses: Record<string, string> = { confirmed: '待上课', cancelled: '已取消', attended: '已到课', absent: '爽约已结算' };
let snapshot: Dashboard = { profile: null };
Page({
  data: {
    demo: config.mode === 'demo', role: 'student' as Role, roleName: '学员端', roles: [] as { id: Role; name: string }[],
    tab: 'home', busy: false, error: '', profile: null as Dashboard['profile'],
    navItems: navigation.student, todayClasses: 0, unsettledCount: 0, coachRoster: [] as { id: string; name: string }[],
    days: Array.from({ length: 7 }, (_, i) => { const key = dayKey(Date.now() + i * 86400000); return { key, short: key.slice(5), label: i === 0 ? '今天' : ['日', '一', '二', '三', '四', '五', '六'][new Date(`${key}T12:00:00+08:00`).getUTCDay()] }; }),
    day: dayKey(Date.now()), kind: 'private', coachIndex: 0, coaches: [] as { id: string; name: string }[],
    publishStart: '', publishEnd: '', scheduleSlots: [] as { key: string; startLabel: string; endLabel: string; state: string; stateName: string; sessionId: string; start: number; end: number; disabled: boolean }[],
    sessions: [] as object[], bookings: [] as object[], packs: [] as object[], messages: [] as object[], ledger: [] as object[], pending: [] as object[],
    users: [] as { id: string; name: string }[], memberIndex: 0, purchaseKindIndex: 0, kindNames: ['私教', '团课'],
    staffMembers: [] as { id: string; name: string; shortId: string; isCoach: boolean }[],
    memberQuery: '', memberFilter: 'all', filteredMembers: [] as { id: string; name: string; shortId: string; isCoach: boolean }[],
    memberDetailId: '', memberDetail: null as null | { id: string; name: string; shortId: string; isCoach: boolean },
    memberPacks: [] as object[], memberBookings: [] as object[],
    totalAvailable: 0, totalFrozen: 0, totalConsumed: 0, myCount: 0,
    editing: null as null | { id: string; title: string; day: string; start: string; end: string; room: string; capacity: number; kind: string },
    copyCount: 0, copyEnd: '', copyTarget: '', copyTargetEnd: '', copyUnavailable: false,
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
      this.setData({ navItems: navigation[role], tab: navigation[role].some(item => item.id === this.data.tab) ? this.data.tab : 'home' });
      this.setData({ profile: snapshot.profile, role, roleName: roleNames[role], roles: available.map(id => ({ id, name: roleNames[id] })), coaches: snapshot.coaches || [], users: (snapshot.users || []).filter(u => u.status === 'active' && u.roles.includes('student')).map(u => ({ id: u.id, name: u.name })), pending: (snapshot.users || []).filter(u => u.status === 'pending') });
      this.setData({ coachIndex: Math.min(this.data.coachIndex, Math.max(0, this.data.coaches.length - 1)), staffMembers: (snapshot.users || []).filter(u => u.status === 'active' && (u.roles.includes('student') || u.roles.includes('coach'))).map(u => ({ id: u.id, name: u.name, shortId: u.id.slice(-6), isCoach: u.roles.includes('coach') })) });
      this.renderData();
      this.renderMembers();
    } catch (e) { this.setData({ error: e instanceof Error ? e.message : '加载失败' }); }
    finally { this.setData({ busy: false }); }
  },
  renderData() {
    const now = Date.now(); const all = snapshot.sessions || []; const profile = snapshot.profile;
    const coaches = snapshot.coaches || []; const coach = coaches[this.data.coachIndex];
    const sessions = all.filter(s => dayKey(s.start) === this.data.day && s.status === 'open' && (this.data.role === 'student' ? s.kind === this.data.kind && (s.kind === 'group' || !coach || s.coachId === coach.id) : this.data.role === 'coach' ? s.coachId === profile?.id : true)).sort((a, b) => a.start - b.start).map(s => ({ ...s, startLabel: time(s.start), endLabel: time(s.end), coachName: coaches.find(c => c.id === s.coachId)?.name || '教练', kindName: s.kind === 'private' ? '私教' : '团课', free: s.capacity - s.reserved, canBook: s.reserved < s.capacity && s.start - now >= s.cutoffMinutes * 60000, canCancelSession: this.data.role === 'admin' && s.start > now, canClose: s.reserved === 0 && s.start > now && (this.data.role === 'admin' || s.kind === 'private') }));
    const sourceStart = Date.parse(`${this.data.day}T00:00:00+08:00`);
    const scheduleCoach = this.data.role === 'coach' ? profile?.id : coach?.id;
    const scheduleSlots = this.data.role === 'student' || this.data.kind === 'group' ? [] : Array.from({ length: 14 }, (_, index) => {
      const start = sourceStart + (index + 8) * 3600000; const end = start + 3600000;
      const session = all.find(s => s.coachId === scheduleCoach && (s.status === 'open' || s.status === 'rest') && s.start < end && start < s.end);
      const exact = !!session && session.start === start && session.end === end && session.kind === 'private';
      const state = !session ? 'free' : session.status === 'rest' ? 'rest' : session.reserved > 0 ? 'booked' : 'scheduled';
      const stateName = ({ free: '未安排', rest: '休息', booked: '已约', scheduled: '已排课' } as Record<string, string>)[state] || '未安排';
      return { key: `${this.data.day}-${index + 8}`, startLabel: time(start), endLabel: time(end), state, stateName, sessionId: exact ? session!.id : '', start, end, disabled: start <= now || (!!session && !exact) || state === 'booked' };
    });
    const copyCoach = this.data.role === 'coach' ? profile?.id : coach?.id;
    const copySlots = all.filter(s => s.kind === 'private' && s.status === 'open' && s.coachId === copyCoach && s.start >= sourceStart && s.start < sourceStart + 7 * 86400000);
    this.setData({ scheduleSlots, copyCount: copySlots.length, copyEnd: dayKey(sourceStart + 6 * 86400000), copyTarget: dayKey(sourceStart + 7 * 86400000), copyTargetEnd: dayKey(sourceStart + 13 * 86400000), copyUnavailable: all.length >= 200 });
    const bookings = (snapshot.bookings || []).filter(b => this.data.role === 'student' ? b.memberId === profile?.id : this.data.role === 'coach' ? all.some(s => s.id === b.sessionId && s.coachId === profile?.id) : true).map(b => { const s = all.find(s => s.id === b.sessionId); return { ...b, title: s?.title || '历史课程', schedule: s ? `${dayKey(s.start)} ${time(s.start)}–${time(s.end)}` : '', cancelReason: b.cancelReason || '', statusName: b.status === 'cancelled' && b.cancelReason ? '门店停课' : statuses[b.status] || b.status, memberName: [...(snapshot.users || []), ...(snapshot.roster || [])].find(u => u.id === b.memberId)?.name || b.memberId.slice(-6), canCancel: b.status === 'confirmed' && !!s && s.start - now >= s.cancelHours * 3600000, canSettle: b.status === 'confirmed' && !!s && s.end <= now }; });
    const rosterIds = new Set(bookings.map(b => b.memberId));
    this.setData({ todayClasses: all.filter(s => s.status === 'open' && dayKey(s.start) === dayKey(now) && (this.data.role === 'admin' || s.coachId === profile?.id)).length, unsettledCount: bookings.filter(b => b.canSettle).length, coachRoster: [...(snapshot.users || []), ...(snapshot.roster || [])].filter(u => rosterIds.has(u.id)).filter((u, i, list) => list.findIndex(v => v.id === u.id) === i).map(u => ({ id: u.id, name: u.name })) });
    const packs = (snapshot.packages || []).filter(p => this.data.role === 'admin' || p.memberId === profile?.id);
    this.setData({ sessions, bookings, myCount: bookings.filter(b => b.status === 'confirmed').length, packs: packs.map(p => ({ ...p, title: p.kind === 'private' ? '私教课包' : '团课课包', expiry: dayKey(p.expiresAt), expired: p.expiresAt < now })), totalAvailable: packs.filter(p => p.expiresAt >= now).reduce((a, p) => a + p.available, 0), totalFrozen: packs.reduce((a, p) => a + p.frozen, 0), totalConsumed: packs.reduce((a, p) => a + p.consumed, 0), messages: (snapshot.inbox || []).sort((a, b) => b.at - a.at).map(m => ({ ...m, date: `${dayKey(m.at)} ${time(m.at)}` })), ledger: (snapshot.ledger || []).sort((a, b) => b.at - a.at).map(l => ({ ...l, title: ({ purchase: '购课入账', freeze: '预约冻结', release: '取消释放', consume: '出勤消课' } as Record<string, string>)[l.type] || l.type, date: dayKey(l.at) })) });
  },
  renderMembers() {
    const query = this.data.memberQuery.trim().toLocaleLowerCase();
    const members = this.data.role === 'admin' ? this.data.staffMembers : [];
    const filteredMembers = members.filter(u => (!query || u.name.toLocaleLowerCase().includes(query) || u.shortId.includes(query)) && (this.data.memberFilter !== 'coach' || u.isCoach));
    const member = members.find(u => u.id === this.data.memberDetailId) || null;
    const memberPacks = member ? (snapshot.packages || []).filter(p => p.memberId === member.id).map(p => ({ ...p, title: p.kind === 'private' ? '私教课包' : '团课课包', expiry: dayKey(p.expiresAt), expired: p.expiresAt < Date.now() })) : [];
    const memberBookings = member ? (snapshot.bookings || []).filter(b => b.memberId === member.id).map(b => {
      const s = (snapshot.sessions || []).find(s => s.id === b.sessionId);
      return { id: b.id, title: s?.title || '历史课程', schedule: s ? `${dayKey(s.start)} ${time(s.start)}–${time(s.end)}` : '场次详情未加载', status: statuses[b.status] || b.status, start: s?.start || 0 };
    }).sort((a, b) => b.start - a.start) : [];
    this.setData({ filteredMembers, memberDetail: member, memberPacks, memberBookings });
  },
  searchMembers(e: WechatMiniprogram.Input) { this.setData({ memberQuery: e.detail.value }); this.renderMembers(); },
  filterMembers(e: WechatMiniprogram.TouchEvent) { this.setData({ memberFilter: e.currentTarget.dataset.filter === 'coach' ? 'coach' : 'all' }); this.renderMembers(); },
  openMember(e: WechatMiniprogram.TouchEvent) {
    if (this.data.role !== 'admin' || this.data.busy) return;
    this.setData({ memberDetailId: String(e.currentTarget.dataset.id) }); this.renderMembers();
  },
  closeMember() { this.setData({ memberDetailId: '', memberDetail: null, memberPacks: [], memberBookings: [] }); },
  switchRole(e: WechatMiniprogram.TouchEvent) { if (this.data.busy) return; const role = e.currentTarget.dataset.role as Role; if (!this.data.roles.some(r => r.id === role)) return; this.closeMember(); this.setData({ role, roleName: roleNames[role], navItems: navigation[role], tab: 'home', kind: role === 'coach' ? 'private' : this.data.kind, selectedId: '', editing: null }); wx.pageScrollTo({ scrollTop: 0, duration: 0 }); this.refresh(); },
  switchTab(e: WechatMiniprogram.TouchEvent) { if (this.data.busy) return; const tab = String(e.currentTarget.dataset.tab); if (!navigation[this.data.role].some(item => item.id === tab)) return; this.closeMember(); this.setData({ tab, selectedId: '', editing: null }); wx.pageScrollTo({ scrollTop: 0, duration: 0 }); },
  chooseDay(e: WechatMiniprogram.TouchEvent) { this.setData({ day: String(e.currentTarget.dataset.day) }); this.renderData(); },
  chooseScheduleDate(e: WechatMiniprogram.PickerChange) { this.setData({ day: String(e.detail.value) }); this.renderData(); },
  chooseKind(e: WechatMiniprogram.TouchEvent) { this.setData({ kind: String(e.currentTarget.dataset.kind) }); this.renderData(); },
  chooseCoach(e: WechatMiniprogram.PickerChange) { this.setData({ coachIndex: Number(e.detail.value) }); this.renderData(); },
  chooseMember(e: WechatMiniprogram.PickerChange) { this.setData({ memberIndex: Number(e.detail.value) }); },
  choosePurchaseKind(e: WechatMiniprogram.PickerChange) { this.setData({ purchaseKindIndex: Number(e.detail.value) }); },
  choosePackage(e: WechatMiniprogram.PickerChange) { this.setData({ packageIndex: Number(e.detail.value) }); },
  async tapScheduleSlot(e: WechatMiniprogram.TouchEvent) {
    if (this.data.busy || this.data.role === 'student') return;
    const slot = this.data.scheduleSlots.find(item => item.key === String(e.currentTarget.dataset.key));
    if (!slot) return;
    if (slot.state === 'booked') { await wx.showModal({ title: '该时段已约', content: '已有学员预约，不能改为休息或取消排课。请在课程详情中处理预约。', showCancel: false }); return; }
    if (slot.disabled) { await wx.showModal({ title: '暂不可修改', content: slot.start <= Date.now() ? '已开始或已过去的时间不能调整。' : '该课程跨越多个时间格，请在课程详情中编辑。', showCancel: false }); return; }
    const options = slot.state === 'free' ? ['排课', '标记休息'] : slot.state === 'rest' ? ['改为排课', '取消休息'] : ['标记休息', '取消排课'];
    let choice: WechatMiniprogram.ShowActionSheetSuccessCallbackResult;
    try { choice = await wx.showActionSheet({ itemList: options }); } catch { return; }
    const state = slot.state === 'free' ? (choice.tapIndex === 0 ? 'open' : 'rest')
      : slot.state === 'rest' ? (choice.tapIndex === 0 ? 'open' : 'clear')
      : (choice.tapIndex === 0 ? 'rest' : 'clear');
    const coachId = this.data.role === 'coach' ? snapshot.profile?.id : this.data.coaches[this.data.coachIndex]?.id;
    if (!coachId) { this.setData({ error: '请先选择教练' }); return; }
    await this.mutate({ action: 'setSlotState', coachId, ...(slot.sessionId ? { sessionId: slot.sessionId } : {}), start: slot.start, end: slot.end, state }, state === 'open' ? '已排课' : state === 'rest' ? '已标记休息' : '已清除');
  },
  selectSession(e: WechatMiniprogram.TouchEvent) {
    const s = (snapshot.sessions || []).find(s => s.id === e.currentTarget.dataset.id); if (!s) return;
    const eligible = (snapshot.packages || []).filter(p => p.memberId === snapshot.profile?.id && p.kind === s.kind && p.available >= s.cost && p.expiresAt >= s.start && (p.kind !== 'private' || p.coachIds.includes(s.coachId))).sort((a, b) => a.expiresAt - b.expiresAt).map(p => ({ id: p.id, label: `${p.kind === 'private' ? '私教' : '团课'} · 余 ${p.available} 节 · ${dayKey(p.expiresAt)} 到期` }));
    this.setData({ selectedId: s.id, selectedTitle: s.title, selectedTime: `${dayKey(s.start)} ${time(s.start)}–${time(s.end)}`, selectedCost: s.cost, selectedCancel: s.cancelHours, eligible, packageIndex: 0 });
  },
  dismiss() { this.setData({ selectedId: '' }); },
  async mutate(command: Record<string, unknown>, success: string) {
    if (this.data.busy) return;
    this.setData({ busy: true, error: '' });
    try { await api(this.data.role, command); this.setData({ selectedId: '', ...(command.action === 'editSlot' ? { editing: null } : {}) }); wx.showToast({ title: success, icon: 'success' }); }
    catch (e) { this.setData({ error: e instanceof Error ? e.message : '操作失败' }); }
    finally { this.setData({ busy: false }); }
    const error = this.data.error; await this.refresh(); if (error) this.setData({ error });
  },
  confirmBook() { const p = this.data.eligible[this.data.packageIndex]; if (p) this.mutate({ action: 'book', sessionId: this.data.selectedId, packageId: p.id }, '预约成功'); },
  async cancelBooking(e: WechatMiniprogram.TouchEvent) { const r = await wx.showModal({ title: '取消预约', content: '取消后冻结课时退回原课包，是否继续？' }); if (r.confirm) this.mutate({ action: 'cancel', bookingId: e.currentTarget.dataset.id }, '已取消'); },
  async settle(e: WechatMiniprogram.TouchEvent) { const outcome = e.currentTarget.dataset.outcome; const r = await wx.showModal({ title: outcome === 'absent' ? '确认爽约并扣课' : '确认到课并扣课', content: '将冻结课时转为已消耗，并自动向学员发送站内扣费及课包余额通知。请核对学员后确认。' }); if (r.confirm) this.mutate({ action: 'settle', bookingId: e.currentTarget.dataset.id, outcome }, '已结算并发送站内通知'); },
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
    const r = await wx.showModal({ title: '填写停课原因', content: '', editable: true, placeholderText: '请输入停课原因（1–100字）', confirmText: '下一步' });
    if (!r.confirm || this.data.role !== 'admin') return;
    const reason = (r.content || '').trim();
    if (!reason || reason.length > 100) { this.setData({ error: '请填写 1–100 字的停课原因' }); return; }
    const confirm = await wx.showModal({ title: '确认整场停课', content: `${s.title} · ${dayKey(s.start)} ${time(s.start)}，当前 ${s.reserved} 人预约。原因：${reason}。确认后取消全部预约、释放冻结课时，保留历史记录；此操作不能直接撤销。`, confirmText: '确认停课', confirmColor: '#b23b30' });
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
  register(e: WechatMiniprogram.FormSubmit) { this.mutate({ action: 'register', ...e.detail.value }, '已提交'); },
  choosePublishStart(e: WechatMiniprogram.PickerChange) { this.setData({ publishStart: String(e.detail.value), error: '' }); },
  choosePublishEnd(e: WechatMiniprogram.PickerChange) { this.setData({ publishEnd: String(e.detail.value), error: '' }); },
  publish(e: WechatMiniprogram.FormSubmit) {
    if (this.data.busy || this.data.role === 'student') return;
    const v = e.detail.value as Record<string, string>;
    if (!this.data.publishStart || !this.data.publishEnd) { this.setData({ error: '请选择开始时间和结束时间' }); return; }
    const start = Date.parse(`${this.data.day}T${this.data.publishStart}:00+08:00`);
    const end = Date.parse(`${this.data.day}T${this.data.publishEnd}:00+08:00`);
    if (!Number.isFinite(start) || !Number.isFinite(end) || start <= Date.now() || end <= start || end - start > 4 * 3600000) { this.setData({ error: '请选择未来的时段，结束须晚于开始，同一天内且不超过四小时' }); return; }
    const coachId = this.data.role === 'coach' ? snapshot.profile?.id : this.data.coaches[this.data.coachIndex]?.id;
    this.mutate({ action: 'publish', kind: this.data.role === 'coach' ? 'private' : this.data.kind, title: v.title, coachId, roomId: v.room || '开放区', exclusive: false, start, end, capacity: this.data.role === 'coach' || this.data.kind === 'private' ? 1 : Number(v.capacity), cost: 1 }, '排课已发布');
  },
  async copyWeek() {
    if (this.data.busy || this.data.role === 'student') return;
    if (this.data.copyUnavailable) { this.setData({ error: '排课记录较多，暂不支持整周复制，请逐日发布' }); return; }
    const sourceStart = Date.parse(`${this.data.day}T00:00:00+08:00`);
    const coachId = this.data.role === 'coach' ? snapshot.profile?.id : this.data.coaches[this.data.coachIndex]?.id;
    const sessionIds = (snapshot.sessions || []).filter(s => s.kind === 'private' && s.status === 'open' && s.coachId === coachId && s.start >= sourceStart && s.start < sourceStart + 7 * 86400000).map(s => s.id);
    if (!sessionIds.length || sessionIds.length > 35) { this.setData({ error: '请选择含 1–35 个私教时段的七天排班' }); return; }
    const role = this.data.role;
    const r = await wx.showModal({ title: '复制私教排班到下一周', content: `将 ${this.data.day} 至 ${this.data.copyEnd} 的 ${sessionIds.length} 个时段复制到 ${this.data.copyTarget} 至 ${this.data.copyTargetEnd}。不复制预约；如有冲突，本次全部不创建。` });
    if (r.confirm && role === this.data.role) await this.mutate({ action: 'copyWeek', sessionIds, sourceStart }, '排班已复制');
  },
  purchase(e: WechatMiniprogram.FormSubmit) {
    const v = e.detail.value as Record<string, string>; const kind = this.data.purchaseKindIndex === 0 ? 'private' : 'group';
    if (!/^\d+(\.\d{1,2})?$/.test(v.amount || '')) { this.setData({ error: '金额须为非负数字，最多两位小数' }); return; }
    const coach = this.data.coaches[this.data.coachIndex];
    this.mutate({ action: 'purchase', memberId: this.data.users[this.data.memberIndex]?.id, kind, coachIds: kind === 'private' && coach ? [coach.id] : [], credits: Number(v.credits), amountFen: Math.round(Number(v.amount) * 100), expiresAt: Date.parse(`${v.expiry}T23:59:59+08:00`), method: 'transfer', note: v.note }, '入账成功');
  },
});
