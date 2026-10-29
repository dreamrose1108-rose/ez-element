import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { build } from 'esbuild';
import { receiptTemplateId } from '../server/receipt-notification';
import { bookingTemplates } from '../server/booking-notification';

test('微信订阅必须主动授权；拒绝不绑定，接受只提交一次性登录码', async () => {
  let accepted = false; let logins = 0; let bindings = 0;
  const compiled = await build({ entryPoints: ['miniprogram/services/receipt-notification.ts'], bundle: true, write: false, platform: 'neutral', format: 'cjs', plugins: [{ name: 'subscription-port', setup(builder) {
    builder.onLoad({ filter: /cloudbase\.ts$/ }, () => ({ contents: 'export const callCloud = async () => ({ ok: true });', loader: 'ts' }));
  } }] });
  const module = { exports: {} as { subscribeReceipt(): Promise<string>; receiptTemplateId: string } };
  vm.runInNewContext(compiled.outputFiles[0]!.text, { module, exports: module.exports, wx: {
    async requestSubscribeMessage(options: { tmplIds: string[] }) { assert.equal(options.tmplIds.length, 1); assert.equal(options.tmplIds[0], receiptTemplateId); return { [receiptTemplateId]: accepted ? 'accept' : 'reject' }; },
    async login() { logins++; return { code: 'one-use-code' }; },
    request(options: { data: unknown; success(result: object): void }) { bindings++; assert.equal(JSON.stringify(options.data), JSON.stringify({ code: 'one-use-code', subscribeReceipt: true })); options.success({ statusCode: 200, data: { ok: true } }); },
  } });
  assert.equal(module.exports.receiptTemplateId, receiptTemplateId);
  assert.match(await module.exports.subscribeReceipt(), /未开启/);
  assert.equal(logins, 0); assert.equal(bindings, 0);
  accepted = true;
  assert.match(await module.exports.subscribeReceipt(), /本次订阅已完成/);
  assert.equal(logins, 1); assert.equal(bindings, 1);
});

test('预约订阅一次申请三个准确模板，部分同意也绑定且反馈实际数量', async () => {
  const compiled = await build({ entryPoints: ['miniprogram/services/receipt-notification.ts'], bundle: true, write: false, platform: 'neutral', format: 'cjs', plugins: [{ name: 'subscription-port', setup(builder) {
    builder.onLoad({ filter: /cloudbase\.ts$/ }, () => ({ contents: 'export const callCloud = async () => ({ ok: true });', loader: 'ts' }));
  } }] });
  const module = { exports: {} as { subscribeReceipt(booking: boolean): Promise<string> } };
  let bindings = 0;
  vm.runInNewContext(compiled.outputFiles[0]!.text, { module, exports: module.exports, wx: {
    async requestSubscribeMessage(options: { tmplIds: string[] }) {
      assert.deepEqual(Array.from(options.tmplIds), Object.values(bookingTemplates));
      return { [bookingTemplates.booked]: 'accept', [bookingTemplates.cancelled]: 'reject', [bookingTemplates.reminder]: 'accept' };
    },
    async login() { return { code: 'verified-code' }; },
    request(options: { success(result: object): void }) { bindings++; options.success({ statusCode: 200, data: { ok: true } }); },
  } });
  assert.match(await module.exports.subscribeReceipt(true), /2\/3/);
  assert.equal(bindings, 1);
});

test('首页统一入口依次申请课程与消课提醒', async () => {
  const compiled = await build({ entryPoints: ['miniprogram/services/receipt-notification.ts'], bundle: true, write: false, platform: 'neutral', format: 'cjs', plugins: [{ name: 'subscription-port', setup(builder) {
    builder.onLoad({ filter: /cloudbase\.ts$/ }, () => ({ contents: 'export const callCloud = async () => ({ ok: true });', loader: 'ts' }));
  } }] });
  const module = { exports: {} as { subscribeReceipt(kind: 'all'): Promise<string> } };
  const requested: string[][] = [];
  vm.runInNewContext(compiled.outputFiles[0]!.text, { module, exports: module.exports, wx: {
    async requestSubscribeMessage(options: { tmplIds: string[] }) {
      requested.push(Array.from(options.tmplIds));
      return Object.fromEntries(options.tmplIds.map(id => [id, 'accept']));
    },
    async login() { return { code: 'verified-code' }; },
    request(options: { success(result: object): void }) { options.success({ statusCode: 200, data: { ok: true } }); },
  } });
  assert.match(await module.exports.subscribeReceipt('all'), /4\/4/);
  assert.deepEqual(requested, [Object.values(bookingTemplates), [receiptTemplateId]]);
});
