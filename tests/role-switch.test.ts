import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { build } from 'esbuild';

test('cloud role switches reuse a recent authorized snapshot; refresh, expiry and mutations fetch again', async () => {
  let now = Date.now(); let reads = 0; let fail = false;
  let roles = ['student', 'admin', 'coach'];
  interface Harness {
    data: Record<string, any>;
    setData(value: object): void;
    refresh(): Promise<void>;
    switchRole(event: object): void;
    mutate(command: object, message: string): Promise<void>;
  }
  let page!: Harness;
  const result = await build({
    entryPoints: ['miniprogram/pages/workspace/index.ts'], bundle: true, write: false,
    platform: 'neutral', format: 'cjs', mainFields: ['main', 'module'],
    plugins: [{ name: 'cloud-fixture', setup(builder) {
      builder.onLoad({ filter: /miniprogram[\\/]config\.ts$/ }, () => ({ contents: "export const config = { mode: 'cloud' };", loader: 'ts' }));
      builder.onLoad({ filter: /miniprogram[\\/]services[\\/]api\.ts$/ }, () => ({ contents: 'export const api = (...args) => globalThis.testApi(...args);', loader: 'ts' }));
    } }],
  });
  vm.runInNewContext(result.outputFiles[0]!.text, {
    module: { exports: {} }, exports: {},
    Date: class extends Date { static now() { return now; } },
    Page(p: Harness) { page = p; p.setData = value => Object.assign(p.data, value); },
    wx: { pageScrollTo() {}, showToast() {} },
    async testApi(_role: string, command: { action: string }) {
      if (command.action !== 'dashboard') return { id: 'operation' };
      reads++;
      if (fail) throw new Error('offline');
      return { profile: { id: 'same-user', name: 'Member', roles: [...roles], status: 'active' } };
    },
  });
  const switchTo = (role: string) => page.switchRole({ currentTarget: { dataset: { role } } });
  const idle = async () => { for (let i = 0; page.data.busy && i < 50; i++) await new Promise(resolve => setTimeout(resolve, 1)); assert.equal(page.data.busy, false); };
  await page.refresh(); assert.equal(reads, 1);
  switchTo('admin'); switchTo('coach');
  assert.equal(page.data.bookingFilter, 'settle', 'coach opens on attendance confirmations');
  assert.equal((page.data.navItems as { name: string }[]).map(item => item.name).join(','), '出勤,排班,学员,收入,消息');
  switchTo('student');
  assert.equal(reads, 1); assert.equal(page.data.role, 'student');
  assert.equal(page.data.busy, false);
  switchTo('student'); assert.equal(reads, 1, 'same role is a no-op');
  switchTo('unknown'); assert.equal(page.data.role, 'student');
  now += 30_001;
  switchTo('admin'); await idle(); assert.equal(reads, 2);
  await page.refresh(); assert.equal(reads, 3, 'manual refresh bypasses cache');
  await page.mutate({ action: 'recharge' }, 'saved'); assert.equal(reads, 4);
  switchTo('coach'); assert.equal(reads, 4);
  fail = true; await page.refresh(); assert.equal(reads, 5);
  fail = false; switchTo('student'); await idle(); assert.equal(reads, 6, 'failed refresh invalidates cached freshness');
  roles = ['student']; await page.refresh();
  switchTo('admin'); assert.equal(page.data.role, 'student', 'refreshed role revocation is honored');
});
