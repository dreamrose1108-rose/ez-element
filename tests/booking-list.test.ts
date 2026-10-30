import test from 'node:test';
import assert from 'node:assert/strict';
import { bookingList } from '../miniprogram/services/booking-list';
const at = (hour: number) => Date.parse(`2026-10-30T${hour}:00:00+08:00`);
const rows = [
  { id: 'future', status: 'confirmed', start: at(18), canSettle: false },
  { id: 'done', status: 'attended', start: at(10), canSettle: false },
  { id: 'late', status: 'confirmed', start: at(11), canSettle: true },
  { id: 'cancelled', status: 'cancelled', start: at(14), canSettle: false },
  { id: 'absent', status: 'absent', start: at(12), canSettle: false },
];
test('预约首页只取待上课，按时间排列并保留总数供查看更多', () => {
  const result = bookingList(rows, 'student', 'upcoming', 1, '2026-10-30');
  assert.equal(result.total, 2);
  assert.deepEqual(result.rows.map(r => r.id), ['future']);
  assert.equal(rows[0]?.id, 'future');
});
test('教练待办优先待确认，历史完成包含爽约而取消独立', () => {
  assert.deepEqual(bookingList(rows, 'coach', 'settle', 10, '2026-10-30').rows.map(r => r.id), ['late']);
  assert.deepEqual(bookingList(rows, 'coach', 'upcoming', 10, '2026-10-30').rows.map(r => r.id), ['late', 'future']);
  assert.deepEqual(bookingList(rows, 'student', 'completed', 10, '2026-10-30').rows.map(r => r.id), ['absent', 'done']);
  assert.deepEqual(bookingList(rows, 'student', 'cancelled', 10, '2026-10-30').rows.map(r => r.id), ['cancelled']);
});
test('今日待办按中国时区过滤，排除完成记录和缺失课程时间', () => {
  assert.equal(bookingList([...rows, { id: 'missing', status: 'confirmed', start: 0, canSettle: false }], 'coach', 'today', 10, '2026-10-30').total, 2);
  assert.equal(bookingList(rows, 'coach', 'today', 10, '2026-10-31').total, 0);
});
