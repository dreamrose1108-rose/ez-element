import test from 'node:test';
import assert from 'node:assert/strict';
import { cloudFailureCode } from '../miniprogram/services/cloud-error';

test('cloud diagnostics recognize nested HTTP and serialized SDK errors', () => {
  assert.equal(cloudFailureCode({ statusCode: 403, data: { error: { code: 'EXCEED_AUTHORITY' } } }), 'EXCEED_AUTHORITY');
  assert.equal(cloudFailureCode(new Error(JSON.stringify({ code: 'FUNCTION_INVOCATION_FAILED', msg: 'failure' }))), 'FUNCTION_INVOCATION_FAILED');
  assert.equal(cloudFailureCode({ statusCode: 500, data: '<html>failure</html>' }), 'HTTP_500');
  assert.equal(cloudFailureCode({ error: 'access_denied' }), 'ACCESS_DENIED');
  assert.equal(cloudFailureCode(new TypeError('undefined property')), 'TYPEERROR');
});

test('cloud diagnostics do not echo response bodies or arbitrary error messages', () => {
  const e: Record<string, unknown> = { message: 'https://example.com/?token=secret', data: { ticket: 'secret', headers: { Authorization: 'secret' } } };
  e.cause = e;
  assert.equal(cloudFailureCode(e), 'UNKNOWN');
  assert.equal(cloudFailureCode({ errMsg: 'request:fail url not in domain list' }), 'REQUEST_DOMAIN');
  assert.equal(cloudFailureCode({ data: { message: 'operation timed out' } }), 'TIMEOUT');
});
