const test = require('node:test');
const assert = require('node:assert/strict');
const { MAX_ERROR_BODY_BYTES, MAX_DETAIL_CHARS, finishReasonInfo, sanitizeServiceDetail, parseServiceError, isAuthenticationFailure } = require('./src/service-errors');

test('finish reasons distinguish normal completion, truncation, content filtering, interruptions and tool calls', () => {
  assert.deepEqual(finishReasonInfo('stop'), { message: '', category: 'complete', retryable: false, incomplete: false, finishReason: 'stop' });
  assert.equal(finishReasonInfo('length').message, '回答达到长度上限，已显示的内容不完整');
  assert.equal(finishReasonInfo('length').retryable, false);
  assert.equal(finishReasonInfo('content_filter').category, 'content_filter');
  assert.equal(finishReasonInfo('content_filter').retryable, false);
  assert.equal(finishReasonInfo('insufficient_system_resource').retryable, true);
  assert.equal(finishReasonInfo('insufficient_system_resource').category, 'capacity');
  assert.equal(finishReasonInfo('aborted').category, 'interrupted');
  assert.match(finishReasonInfo('tool_calls').message, /未启用工具执行/);
  assert.equal(finishReasonInfo('tool_calls').retryable, false);
  for (const value of ['future_reason', '__proto__', null, {}, '']) assert.equal(finishReasonInfo(value).category, 'unknown');
});

test('HTTP errors preserve useful OpenAI-compatible fields without treating balance as authentication failure', () => {
  const result = parseServiceError(422, Buffer.from(JSON.stringify({ error: { message: 'max_tokens must be positive', type: 'invalid_request_error', code: 'invalid_parameter' } })));
  assert.equal(result.category, 'parameters');
  assert.equal(result.httpStatus, 422);
  assert.equal(result.retryable, false);
  assert.match(result.message, /请求参数无效.*HTTP 422.*max_tokens must be positive.*invalid_parameter/);
  assert.equal(result.serviceType, 'invalid_request_error');
  const unauthorized = parseServiceError(401, { error: { message: 'Expired key', code: 401 } });
  assert.equal(unauthorized.category, 'authentication');
  assert.equal(unauthorized.authExpired, undefined);
  const balance = parseServiceError(402, { error: { type: 'authentication_error', message: 'Insufficient balance' } });
  assert.equal(balance.category, 'balance');
  assert.equal(balance.authExpired, undefined);
  assert.equal(balance.retryable, false);
  assert.match(parseServiceError(429, {}).message, /并发或 QPS/);
  assert.equal(parseServiceError(429, {}).retryable, true);
  assert.equal(parseServiceError(503, {}).retryable, true);
  assert.equal(parseServiceError(599, {}).retryable, true);
});

test('service details redact authorization, bearer credentials, sk keys and common key assignments before truncation', () => {
  const secret = 'sk-secret_value-1234';
  for (const detail of [
    `Authorization: Bearer ${secret}`,
    `"authorization":"Basic privateCredential"`,
    'Failed with Bearer privateCredential',
    'Failed with Bearer "privateCredential"',
    "Failed with Bearer 'privateCredential'",
    `The provided key ${secret} is invalid`,
    'api_key=privateCredential&next=ok',
    'access_token: "privateCredential"',
    'token=privateCredential',
    'secret: privateCredential'
  ]) {
    const result = sanitizeServiceDetail(detail);
    assert.ok(!result.includes(secret), result);
    assert.ok(!result.includes('privateCredential'), result);
    assert.match(result, /\[redacted\]/);
  }
  const result = parseServiceError(400, { error: { message: 'Authorization: Bearer sk-do-not-show', type: 'sk-type-secret', code: 'Bearer sk-code-secret' } });
  assert.ok(!result.message.includes('sk-'));
  const longKey = 'sk-' + 'a'.repeat(MAX_ERROR_BODY_BYTES * 2);
  assert.equal(sanitizeServiceDetail(longKey), '[redacted]');
  assert.equal(sanitizeServiceDetail('x'.repeat(MAX_ERROR_BODY_BYTES * 2)).length, MAX_DETAIL_CHARS);
  assert.equal(sanitizeServiceDetail({ key: secret }), '');
});

test('authentication failures honor explicit HTTP status before exact provider authentication labels', () => {
  assert.equal(isAuthenticationFailure({ code: 401 }), true);
  assert.equal(isAuthenticationFailure({ code: ' 401 ' }), true);
  assert.equal(isAuthenticationFailure({ code: 402, type: 'authentication_error' }), false);
  assert.equal(isAuthenticationFailure({ code: '402', type: 'authentication_error' }), false);
  assert.equal(isAuthenticationFailure({ status: 429, code: 'invalid_api_key' }), false);
  assert.equal(isAuthenticationFailure({ httpStatus: 403, code: 401, type: 'authentication_error' }), false);
  for (const marker of ['invalid_api_key', 'authentication_error', 'unauthorized', 'api_key_expired', 'expired_api_key']) {
    assert.equal(isAuthenticationFailure({ code: marker }), true, marker);
    assert.equal(isAuthenticationFailure({ type: marker.toUpperCase() }), true, marker);
  }
  assert.equal(isAuthenticationFailure('invalid_api_key'), true);
  for (const value of [null, undefined, [], {}, { code: 'file_expired' }, { type: 'authorization_file_error' }, { code: 'expired' }, { message: 'Invalid API key' }, { code: 'x401x' }, { code: 'authentication_error_suffix' }]) {
    assert.equal(isAuthenticationFailure(value), false, JSON.stringify(value));
  }
});

test('HTTP parsing ignores raw HTML and oversized bodies and bounds display fields', () => {
  for (const body of ['<html>proxy response</html>', 'raw upstream body', Buffer.alloc(MAX_ERROR_BODY_BYTES + 1, 'x'), [], null, 0]) {
    const result = parseServiceError(502, body);
    assert.equal(result.serviceMessage, '');
    assert.ok(result.message.length < 100);
  }
  assert.equal(parseServiceError(400, { error: 'Invalid request' }).serviceMessage, 'Invalid request');
  assert.equal(parseServiceError(400, JSON.stringify({ message: 'Invalid model' })).serviceMessage, 'Invalid model');
  assert.equal(parseServiceError(400, new Uint8Array(Buffer.from('{"error":{"message":"bad input"}}'))).serviceMessage, 'bad input');
  const longFields = parseServiceError(422, { error: { message: 'x'.repeat(50000), type: 'y'.repeat(50000), code: 'z'.repeat(50000) } });
  assert.equal(longFields.serviceMessage.length, 320);
  assert.equal(longFields.serviceType.length, 80);
  assert.equal(longFields.serviceCode.length, 80);
  assert.ok(longFields.message.length < 600);
  assert.equal(sanitizeServiceDetail('x\n\u0000y\u202ez'), 'x y z');
  assert.equal(parseServiceError('401', { error: { message: 'Bad request' } }).httpStatus, 0);
});

test('error metadata is independent per call and contains no automatic action', () => {
  const first = finishReasonInfo('stop'); first.message = 'changed';
  assert.equal(finishReasonInfo('stop').message, '');
  const error = parseServiceError(429, { error: { message: 'Busy' } }); error.category = 'changed';
  assert.equal(parseServiceError(429, {}).category, 'rate_limit');
  assert.equal(Object.values(finishReasonInfo('tool_calls')).some(value => typeof value === 'function'), false);
});
