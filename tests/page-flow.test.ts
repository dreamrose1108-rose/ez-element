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
  interface PageHarness { data: Record<string, unknown>; setData(value: object): void; refresh(): Promise<void>; copyWeek(): Promise<void>; editSlot(e: object): void; saveSlot(e: object): Promise<void>; cancelSession(e: object): Promise<void>; chooseScheduleDate(e: object): void; renderData(): void; publish(e: object): void; selectSession(e: object): void; confirmBook(): void; mutate(command: object, success: string): Promise<void> }
  let page: PageHarness | undefined;
  const buildResult = await build({
    entryPoints: ['miniprogram/pages/workspace/index.ts'], bundle: true, write: false,
    platform: 'neutral', mainFields: ['main', 'module'], format: 'cjs',
    plugins: [{ name: 'demo-config', setup(builder) {
      builder.onLoad({ filter: /miniprogram\/config\.ts$/ }, () => ({
        contents: "export const config = { mode: 'demo', envId: '', loginUrl: '', demoUrl: 'http://demo.test/api' };",
        loader: 'ts',
      }));
    } }],
  });
  const bundle = buildResult.outputFiles[0]!.text;
  vm.runInNewContext(bundle, {
    console, module: { exports: {} }, exports: {},
    Page(p: PageHarness) { page = p; p.setData = value => Object.assign(p.data, value); },
    wx: { showToast() {}, showModal: async () => ({ confirm: true, content: '场地维护测试' }), request(opts: { data: { role: string; command: object }; success(r: object): void; fail(): void }) {
      service.execute(opts.data.role, opts.data.command).then(data => opts.success({ statusCode: 200, data: { ok: true, data } }), e => opts.success({ statusCode: 200, data: { ok: false, message: e.message } }));
    } },
  });
  assert.ok(page); const p = page;
  const idle = async () => { for (let i = 0; i < 30; i++) { await new Promise<void>(r => setImmediate(r)); if (!p.data.busy) return; } assert.fail('page did not settle'); };
  p.setData({ role: 'coach' }); await p.refresh();
  const days = p.data.days as { key: string }[];
  assert.equal(days.length, 7); const day = days[3]!.key;
  p.setData({ day });
  p.publish({ detail: { value: { title: '测试私教', start: '09:00', end: '10:00', room: '私教区' } } }); await idle();
  assert.equal(p.data.error, '');
  p.setData({ role: 'student' }); await p.refresh();
  let slots = p.data.sessions as { id: string; startLabel: string }[];
  assert.equal(slots.length, 1); assert.equal(slots[0]?.startLabel, '09:00');
  const sid = slots[0]!.id; p.selectSession({ currentTarget: { dataset: { id: sid } } });
  p.confirmBook(); await idle();
  assert.equal(p.data.error, ''); assert.equal(p.data.totalFrozen, 1); assert.equal(p.data.totalAvailable, 9);
  const bookings = p.data.bookings as { id: string }[];
  p.setData({ role: 'coach' }); await p.refresh(); assert.equal((p.data.bookings as object[]).length, 1);
  p.setData({ role: 'student' }); await p.refresh();
  await p.mutate({ action: 'cancel', bookingId: bookings[0]!.id }, '已取消');
  assert.equal(p.data.totalFrozen, 0); assert.equal(p.data.totalAvailable, 10);
  p.setData({ role: 'coach' }); await p.refresh();
  assert.equal(p.data.copyCount, 1);
  await p.copyWeek(); assert.equal(p.data.error, '');
  const targetDay = String(p.data.copyTarget);
  p.chooseScheduleDate({ detail: { value: targetDay } });
  slots = p.data.sessions as { id: string; startLabel: string }[];
  assert.equal(slots.length, 1); assert.equal(slots[0]!.startLabel, '09:00');
  assert.notEqual(slots[0]!.id, sid);
  p.editSlot({ currentTarget: { dataset: { id: slots[0]!.id } } });
  assert.ok(p.data.editing);
  await p.saveSlot({ detail: { value: { title: '修改后私教', start: '11:00', end: '12:00', room: '新训练区' } } });
  assert.equal(p.data.error, ''); assert.equal(p.data.editing, null);
  slots = p.data.sessions as { id: string; startLabel: string }[];
  assert.equal(slots.length, 1); assert.equal(slots[0]!.startLabel, '11:00');
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
