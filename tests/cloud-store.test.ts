import test from 'node:test';
import assert from 'node:assert/strict';
import { CloudDatabase, CloudStore } from '../server/cloud-store';

test('数据库适配器识别事务单文档结果，避免把 SDK 返回错误当成空记录', async () => {
  let fail = false;
  const db: CloudDatabase = {
    collection: () => ({
      doc: () => ({ get: async () => fail ? { code: 'PERMISSION_DENIED', data: undefined } : { data: { _id: 'u', id: 'u', name: 'A', phone: '13800000000', roles: ['student'], status: 'active' } }, set: async () => ({}) }),
      where: () => ({ limit: () => ({ get: async () => ({ data: [] }) }) }),
    }),
    runTransaction: async work => work(db),
  };
  const store = new CloudStore(db);
  assert.equal((await store.transaction(tx => tx.get('users', 'u')))?.name, 'A');
  fail = true;
  await assert.rejects(store.transaction(tx => tx.get('users', 'u')), /Cloud database operation failed/);
});
