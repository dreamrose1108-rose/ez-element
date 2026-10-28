import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { build } from 'esbuild';
import { GymService, userKey } from '../server/service';
import { MemoryStore } from '../server/memory-store';

test('原生页面控制器：教练排班同步到学员七天列表，预约/取消同步到课包和教练', async () => {
  const store = new MemoryStore(); const service = new GymService(store);
  await store.transaction(async tx => {
    for (const [n, roles] of [['student', ['student']], ['coach', ['coach']], ['admin', ['admin']]] as const) await tx.put('users', { id: userKey(n), name: n, phone: '13800000000', roles: [...roles], status: 'active' });
  });
  await service.execute('admin', { action: 'purchase', requestId: 'test-purchase', memberId: userKey('student'), kind: 'private', coachIds: [userKey('coach')], credits: 10, expiresAt: Date.now() + 90 * 86400000, amountFen: 10000, method: 'cash', note: 'test' });
  interface PageHarness { data: Record<string, unknown>; setData(value: object): void; refresh(): Promise<void>; copyWeek(): Promise<void>; editSlot(e: object): void; saveSlot(e: object): Promise<void>; cancelSession(e: object): Promise<void>; chooseScheduleDate(e: object): void; renderData(): void; startScheduleDrag(e: object): void; tapScheduleSlot(e: object): void; moveScheduleDrag(e: object): void; endScheduleDrag(): Promise<void>; selectSession(e: object): void; confirmBook(): void; mutate(command: object, success: string): Promise<void> }
  let page: PageHarness | undefined;
  let confirmModal = true;
  let actionSheetIndex = 0;
  let scrollTop = -1;
  const buildResult = await build({
    entryPoints: ['miniprogram/pages/workspace/index.ts'], bundle: true, write: false,
    platform: 'neutral', mainFields: ['main', 'module'], format: 'cjs',
    plugins: [{ name: 'demo-config', setup(builder) {
      builder.onLoad({ filter: /miniprogram[\\/]config\.ts$/ }, () => ({
        contents: "export const config = { mode: 'demo', envId: '', loginUrl: '', demoUrl: 'http://demo.test/api' };",
        loader: 'ts',
      }));
    } }],
  });
  const bundle = buildResult.outputFiles[0]!.text;
  vm.runInNewContext(bundle, {
    console, module: { exports: {} }, exports: {},
    Page(p: PageHarness) { page = p; p.setData = value => Object.assign(p.data, value); },
    wx: { pageScrollTo(options: { scrollTop: number }) { scrollTop = options.scrollTop; }, showToast() {}, showActionSheet: async () => ({ tapIndex: actionSheetIndex }), showModal: async () => ({ confirm: confirmModal, content: '场地维护测试' }), createSelectorQuery() { const query = { selectAll() { return query; }, boundingClientRect(callback: (rects: object[]) => void) { callback(Array.from({ length: 196 }, (_, i) => ({ top: Math.floor(i / 28) * 50, bottom: Math.floor(i / 28) * 50 + 48, left: (i % 28) * 50, right: (i % 28) * 50 + 48, dataset: { index: i } }))); return query; }, exec() {} }; return query; }, request(opts: { data: { role: string; command: object }; success(r: object): void; fail(): void }) {
      service.execute(opts.data.role, opts.data.command).then(data => opts.success({ statusCode: 200, data: { ok: true, data } }), e => opts.success({ statusCode: 200, data: { ok: false, message: e.message } }));
    } },
  });
  assert.ok(page); const p = page;
  const memberPage = p as PageHarness & { searchMembers(e: object): void; filterMembers(e: object): void; openMember(e: object): void; closeMember(): void; chooseMemberBirthday(e: object): void; updateMember(e: object): Promise<void>; updateCoachPay(e: object): Promise<void> };
  p.setData({ role: 'admin' }); await p.refresh();
  const navPage = p as PageHarness & { switchTab(e: object): void };
  assert.equal((p.data.navItems as { id: string }[]).map(n => n.id).join(','), 'home,schedule,account,finance');
  navPage.switchTab({ currentTarget: { dataset: { tab: 'finance' } } });
  assert.equal(p.data.tab, 'finance'); assert.equal(scrollTop, 0);
  memberPage.searchMembers({ detail: { value: ' STUDENT ' } });
  assert.equal((p.data.filteredMembers as object[]).length, 1);
  memberPage.openMember({ currentTarget: { dataset: { id: userKey('student') } } });
  assert.equal((p.data.memberDetail as { id: string }).id, userKey('student'));
  assert.equal((p.data.memberPacks as object[]).length, 1);
  assert.deepEqual((p.data.memberPacks as { unitPriceLabel: string; totalAmountLabel: string; total: number }[]).map(pack => [pack.unitPriceLabel, pack.totalAmountLabel, pack.total]), [['¥10.00', '¥100.00', 10]]);
  memberPage.chooseMemberBirthday({ detail: { value: '1996-06-18' } });
  await memberPage.updateMember({ detail: { value: { name: '学员新名', phone: '13900000000' } } });
  const updatedMember = await store.transaction(tx => tx.get('users', userKey('student')));
  assert.equal(updatedMember?.name, '学员新名'); assert.equal(updatedMember?.phone, '13900000000'); assert.equal(updatedMember?.birthday, '1996-06-18');
  memberPage.filterMembers({ currentTarget: { dataset: { filter: 'coach' } } });
  assert.equal((p.data.filteredMembers as object[]).length, 0);
  memberPage.closeMember(); assert.equal(p.data.memberDetail, null);
  memberPage.openMember({ currentTarget: { dataset: { id: userKey('coach') } } });
  await memberPage.updateCoachPay({ currentTarget: { dataset: { type: 'partTime' } } });
  assert.equal((await store.transaction(tx => tx.get('users', userKey('coach'))))?.employmentType, 'partTime');
  assert.equal((p.data.memberDetail as unknown as { employmentTypeName: string }).employmentTypeName, '兼职');
  await memberPage.updateCoachPay({ currentTarget: { dataset: { type: 'fullTime' } } });
  assert.equal((await store.transaction(tx => tx.get('users', userKey('coach'))))?.employmentType, 'fullTime');
  memberPage.closeMember();
  memberPage.searchMembers({ detail: { value: '' } });
  memberPage.filterMembers({ currentTarget: { dataset: { filter: 'all' } } });
  p.setData({ role: 'student' }); await p.refresh();
  assert.equal(p.data.tab, 'home', 'student cannot remain on admin finance page');
  navPage.switchTab({ currentTarget: { dataset: { tab: 'finance' } } });
  assert.equal(p.data.tab, 'home');
  assert.equal((p.data.navItems as { id: string }[]).map(n => n.id).join(','), 'home,schedule,account,messages');
  memberPage.openMember({ currentTarget: { dataset: { id: userKey('coach') } } });
  assert.equal(p.data.memberDetail, null);
  const staffPage = p as PageHarness & { setCoach(e: object): Promise<void> };
  const studentEvent = { currentTarget: { dataset: { id: userKey('student') } } };
  p.setData({ role: 'admin' }); await p.refresh();
  confirmModal = false; await staffPage.setCoach(studentEvent);
  assert.ok(!(await store.transaction(tx => tx.get('users', userKey('student'))))?.roles.includes('coach'));
  confirmModal = true; await staffPage.setCoach(studentEvent);
  assert.equal(p.data.error, '');
  assert.ok((p.data.staffMembers as { id: string; isCoach: boolean }[]).find(u => u.id === userKey('student'))?.isCoach);
  assert.ok((p.data.coaches as { id: string }[]).some(u => u.id === userKey('student')));
  await staffPage.setCoach(studentEvent);
  assert.ok(!(p.data.coaches as { id: string }[]).some(u => u.id === userKey('student')));
  const idle = async () => { for (let i = 0; i < 30; i++) { await new Promise<void>(r => setImmediate(r)); if (!p.data.busy) return; } assert.fail('page did not settle'); };
  p.setData({ role: 'coach' }); await p.refresh();
  assert.equal((p.data.navItems as { id: string }[]).map(n => n.id).join(','), 'home,schedule,account,income,messages');
  navPage.switchTab({ currentTarget: { dataset: { tab: 'income' } } }); assert.equal(p.data.tab, 'income');
  const pay = p.data.coachPay as { employmentTypeName: string; baseSalaryLabel: string; monthPerformanceLabel: string; estimatedTotalLabel: string };
  assert.equal(pay.employmentTypeName, '全职'); assert.equal(pay.baseSalaryLabel, '¥2200.00');
  assert.equal(pay.monthPerformanceLabel, '¥100.00'); assert.equal(pay.estimatedTotalLabel, '¥2200.00');
  const days = p.data.days as { key: string }[];
  assert.equal(days.length, 7); const day = days[3]!.key;
  p.setData({ day }); p.renderData();
  let grid = p.data.scheduleSlots as { day: string; index: number; startLabel: string; state: string; visible: boolean; displayTime: string; durationLabel: string }[];
  assert.equal((p.data.weekScheduleDays as object[]).length, 7, '教练排班应在同一页面加载连续七天');
  const restCell = grid.find(item => item.day === day && item.startLabel === '08:00')!;
  actionSheetIndex = 1; p.startScheduleDrag({ currentTarget: { dataset: { index: restCell.index } } }); await p.endScheduleDrag();
  grid = p.data.scheduleSlots as { day: string; index: number; startLabel: string; state: string; visible: boolean; displayTime: string; durationLabel: string }[];
  assert.equal(grid.find(item => item.day === day && item.startLabel === '08:00')?.state, 'rest');
  const publishCell = grid.find(item => item.day === day && item.startLabel === '09:30')!;
  actionSheetIndex = 0; p.startScheduleDrag({ currentTarget: { dataset: { index: publishCell.index } } });
  p.moveScheduleDrag({ touches: [{ clientX: ((publishCell.index % 28) + 1) * 50 + 20, clientY: Math.floor(publishCell.index / 28) * 50 + 20 }] }); await p.endScheduleDrag();
  grid = p.data.scheduleSlots as { day: string; index: number; startLabel: string; state: string; visible: boolean; displayTime: string; durationLabel: string }[];
  const merged = grid.find(item => item.day === day && item.startLabel === '09:30')!;
  assert.equal(merged.visible, true); assert.equal(merged.displayTime, '09:30–10:30'); assert.equal(merged.durationLabel, '1小时');
  assert.equal(grid.find(item => item.day === day && item.startLabel === '10:00')?.visible, false, '同一节课的后续半小时不应单独渲染');
  assert.equal(p.data.error, '');
  p.setData({ role: 'student' }); await p.refresh();
  let slots = p.data.sessions as { id: string; startLabel: string }[];
  assert.equal(slots.length, 1); assert.equal(slots[0]?.startLabel, '09:30');
  const sid = slots[0]!.id; p.selectSession({ currentTarget: { dataset: { id: sid } } });
  p.confirmBook(); await idle();
  assert.equal(p.data.error, ''); assert.equal(p.data.totalFrozen, 1); assert.equal(p.data.totalAvailable, 9);
  const bookings = p.data.bookings as { id: string }[];
  p.setData({ role: 'coach' }); await p.refresh(); assert.equal((p.data.bookings as object[]).length, 1);
  assert.equal((p.data.bookings as { unitPriceLabel: string; settleAmountLabel: string }[])[0]?.unitPriceLabel, '¥10.00');
  assert.equal((p.data.bookings as { unitPriceLabel: string; settleAmountLabel: string }[])[0]?.settleAmountLabel, '¥10.00');
  assert.equal((p.data.scheduleSlots as { startLabel: string; state: string }[]).find(item => item.startLabel === '09:30')?.state, 'booked');
  assert.equal((p.data.scheduleSlots as { startLabel: string; state: string }[]).find(item => item.startLabel === '10:00')?.state, 'booked');
  assert.equal((p.data.scheduleSlots as { startLabel: string; state: string }[]).find(item => item.startLabel === '09:00')?.state, 'free');
  p.setData({ role: 'student' }); await p.refresh();
  await p.mutate({ action: 'cancel', bookingId: bookings[0]!.id }, '已取消');
  assert.equal(p.data.totalFrozen, 0); assert.equal(p.data.totalAvailable, 10);
  p.setData({ role: 'coach' }); await p.refresh();
  assert.equal(p.data.copyCount, 1);
  await p.copyWeek(); assert.equal(p.data.error, '');
  const targetDay = String(p.data.copyTarget);
  p.chooseScheduleDate({ detail: { value: targetDay } });
  slots = p.data.sessions as { id: string; startLabel: string }[];
  assert.equal(slots.length, 1); assert.equal(slots[0]!.startLabel, '09:30');
  assert.notEqual(slots[0]!.id, sid);
  p.editSlot({ currentTarget: { dataset: { id: slots[0]!.id } } });
  assert.ok(p.data.editing);
  await p.saveSlot({ detail: { value: { title: '修改后私教', room: '新训练区' } } });
  assert.equal(p.data.error, ''); assert.equal(p.data.editing, null);
  slots = p.data.sessions as { id: string; startLabel: string }[];
  assert.equal(slots.length, 1); assert.equal(slots[0]!.startLabel, '09:30');
  assert.equal((p.data.bookings as object[]).length, 1, '复制不能创建新的学员预约');
  await p.copyWeek(); assert.equal(p.data.error, '');
  p.setData({ role: 'student', day }); await p.refresh();
  p.selectSession({ currentTarget: { dataset: { id: sid } } }); p.confirmBook(); await idle();
  assert.equal(p.data.totalFrozen, 1);
  p.setData({ role: 'admin' }); await p.refresh();
  await p.cancelSession({ currentTarget: { dataset: { id: sid } } });
  assert.equal(p.data.error, '');
  p.setData({ role: 'student' }); await p.refresh();
  assert.equal(p.data.totalFrozen, 0); assert.equal(p.data.totalAvailable, 10);
  const cancelled = p.data.bookings as { statusName: string; cancelReason: string }[];
  assert.ok(cancelled.some(b => b.statusName === '门店停课' && b.cancelReason === '场地维护测试'));
  assert.ok(cancelled.some(b => b.statusName === '已取消' && !b.cancelReason), '原来的学员自行取消记录不应被改写');
});
