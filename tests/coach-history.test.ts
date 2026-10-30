import test from 'node:test';
import assert from 'node:assert/strict';
import { coachColor, coachHistory } from '../miniprogram/services/coach-history';
test('教练明细隔离月份和教练，爽约计入金额但不计到课人数', () => {
  const row = { id: 'a', coachId: 'c', memberId: 'm', memberName: '学员', month: '2026-10', start: Date.parse('2026-10-30T08:00:00+08:00'), end: Date.parse('2026-10-30T09:00:00+08:00'), title: '训练', kind: 'private', status: 'attended', cost: 1, amountFen: 22000 };
  const finance = { todayRevenueFen: 0, todayConsumedFen: 0, todayCoachPayFen: 0, todayAfterCoachPayFen: 0,
    coaches: [{ id: 'c', name: '教练', employmentType: 'fullTime', todayClassCommissionFen: 0, todayPerformanceCommissionFen: 0, todayTotalFen: 0, monthEstimatedTotalFen: 0 }], historyMonths: ['2026-10'],
    teachingHistory: [row, { ...row, id: 'b', memberId: 'n', status: 'absent', start: row.start + 3600000, end: row.end + 3600000 }, { ...row, id: 'x', coachId: 'other' }, { ...row, id: 'y', month: '2026-09' }] };
  const view = coachHistory(finance, 'c', '2026-10');
  assert.equal(view?.count, 1); assert.equal(view?.students, 1); assert.equal(view?.amount, '¥440.00');
  assert.deepEqual(view?.records.map(r => r.id), ['b', 'a']);
  assert.equal(view?.records[1]?.time, '08:00–09:00');
  assert.equal(coachHistory(finance, 'missing', '2026-10'), null);
  assert.equal(coachHistory(finance, 'c', '2027-01')?.records.length, 0);
  assert.deepEqual(coachColor('c'), coachColor('c'));
});
