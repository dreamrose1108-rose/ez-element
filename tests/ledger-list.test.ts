import test from 'node:test';
import assert from 'node:assert/strict';
import { ledgerList } from '../miniprogram/services/ledger-list';
const rows = [
  { id: 'a', memberId: 'u1', type: 'purchase', at: Date.parse('2026-09-30T16:00:00Z'), unit: 'fen', delta: { available: 10000, frozen: 0, consumed: 0 } },
  { id: 'b', memberId: 'u1', type: 'freeze', at: Date.parse('2026-10-02T08:00:00Z'), unit: 'fen', delta: { available: -2200, frozen: 2200, consumed: 0 } },
  { id: 'c', memberId: 'legacy', type: 'release', at: Date.parse('2026-09-01T08:00:00Z'), delta: { available: 1, frozen: -1, consumed: 0 } },
];
test('流水联合筛选按中国时区月份且不丢失未加载姓名的学员', () => {
  const view = ledgerList(rows, [{ id: 'u1', name: '学员一' }], 'u1', '2026-10', 'purchase');
  assert.deepEqual(view.rows.map(r => r.id), ['a']);
  assert.equal(view.rows[0]?.memberName, '学员一');
  assert.equal(view.rows[0]?.available, '+¥100.00');
  assert.ok(view.members.some(m => m.id === 'legacy'));
  assert.deepEqual(view.months.map(m => m.id), ['', '2026-10', '2026-09']);
});
test('流水默认倒序，区分金额与旧课时单位，空结果不回退全部', () => {
  const view = ledgerList(rows, [], '', '', '');
  assert.deepEqual(view.rows.map(r => r.id), ['b', 'a', 'c']);
  assert.equal(view.rows[0]?.available, '−¥22.00');
  assert.equal(view.rows[2]?.frozen, '−1 节');
  assert.equal(ledgerList(rows, [], 'u1', '2026-09', '').rows.length, 0);
  assert.equal(rows[0]?.id, 'a');
});
