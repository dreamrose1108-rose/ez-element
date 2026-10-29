import test from 'node:test';
import assert from 'node:assert/strict';
import { positiveMoneyFen } from '../miniprogram/services/purchase-price';

test('储值与课程价格按分精确读取，不将充值折算课时', () => {
  assert.equal(positiveMoneyFen('4500.01', '充值金额'), 450001);
  assert.equal(positiveMoneyFen('0.29', '课程价格'), 29);
  assert.equal(positiveMoneyFen('19.90', '课程价格'), 1990);
  assert.equal(positiveMoneyFen('1000000', '充值金额'), 100000000);
});

test('储值拒绝零值、非法金额和超额金额', () => {
  for (const value of ['', '0', '-1', '1.234', 'abc', 'NaN', 'Infinity', '1e2', '1000000.01']) {
    assert.throws(() => positiveMoneyFen(value, '金额'));
  }
});
