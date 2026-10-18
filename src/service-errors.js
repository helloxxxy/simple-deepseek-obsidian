// Display-only metadata: retryable never schedules another request or executes tools.
const MAX_ERROR_BODY_BYTES = 16 * 1024;
const MAX_DETAIL_CHARS = 320;
const FINISH_REASONS = Object.freeze({
  stop: { message: '', category: 'complete', retryable: false, incomplete: false },
  length: { message: '回答达到长度上限，已显示的内容不完整', category: 'length', retryable: false, incomplete: true },
  content_filter: { message: '回答因服务内容过滤而停止，已显示的内容可能不完整', category: 'content_filter', retryable: false, incomplete: true },
  insufficient_system_resource: { message: 'DeepSeek 推理资源不足，回答已中断；请稍后重试', category: 'capacity', retryable: true, incomplete: true },
  aborted: { message: 'DeepSeek 中断了回答，已显示的内容可能不完整；可重新发送', category: 'interrupted', retryable: true, incomplete: true },
  tool_calls: { message: '模型返回了工具调用，当前对话未启用工具执行', category: 'tool_calls', retryable: false, incomplete: true }
});

function finishReasonInfo(reason) {
  const known = typeof reason === 'string' && Object.hasOwn(FINISH_REASONS, reason) ? FINISH_REASONS[reason] : null;
  return {
    ...(known || { message: '服务提前结束了回答', category: 'unknown', retryable: false, incomplete: true }),
    finishReason: typeof reason === 'string' ? sanitizeServiceDetail(reason, 80) : ''
  };
}

function truncate(value, limit) {
  if (value.length <= limit) return value;
  let end = Math.max(0, limit - 1);
  if (end && /[\uD800-\uDBFF]/.test(value[end - 1])) end--;
  return value.slice(0, end) + '…';
}

function sanitizeServiceDetail(value, limit = MAX_DETAIL_CHARS) {
  if (typeof value !== 'string' && typeof value !== 'number') return '';
  const boundedLimit = Number.isFinite(limit) ? Math.min(MAX_DETAIL_CHARS, Math.max(1, Math.floor(limit))) : MAX_DETAIL_CHARS;
  // Bound both the scan and result; redact before truncation so a truncated key cannot leak.
  const safe = String(value).slice(0, MAX_ERROR_BODY_BYTES)
    .replace(/\b(?:proxy[-_ ]?)?authorization\b\s*["']?\s*[:=]\s*["']?[^\r\n,"'}]+/gi, 'Authorization: [redacted]')
    .replace(/\bbearer\s+["']?\s*[^\s,"'<>;}]+/gi, 'Bearer [redacted]')
    .replace(/\bsk-[a-z0-9_-]+/gi, '[redacted]')
    .replace(/\b(?:api[-_ ]?key|access[-_ ]?token|refresh[-_ ]?token|token|secret)\b\s*["']?\s*[:=]\s*["']?[^\s,"'<>;&}]+/gi, '[redacted]')
    .replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, ' ')
    .replace(/\s+/g, ' ').trim();
  return truncate(safe, boundedLimit);
}

function errorEnvelope(body) {
  if (Buffer.isBuffer(body) || body instanceof Uint8Array) {
    if (body.byteLength > MAX_ERROR_BODY_BYTES) return null;
    body = Buffer.from(body).toString('utf8');
  }
  if (typeof body === 'string') {
    if (Buffer.byteLength(body) > MAX_ERROR_BODY_BYTES) return null;
    try { body = JSON.parse(body); } catch { return null; }
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  if (typeof body.error === 'string') return { message: body.error };
  const candidate = body.error && typeof body.error === 'object' ? body.error : body;
  return Array.isArray(candidate) ? null : candidate;
}

const HTTP_ERRORS = Object.freeze({
  400: { message: '请求过大或参数不支持，请清空对话或缩小文件后重试', category: 'request', retryable: false },
  401: { message: '密钥无效或已过期', category: 'authentication', retryable: false },
  402: { message: '余额不足，请检查服务账户余额', category: 'balance', retryable: false },
  403: { message: '没有访问权限', category: 'permission', retryable: false },
  404: { message: '服务地址或模型不存在，请检查配置', category: 'not_found', retryable: false },
  408: { message: '服务请求超时，请稍后重试', category: 'timeout', retryable: true },
  413: { message: '内容过大，请缩小文件或请求内容', category: 'request_size', retryable: false },
  422: { message: '请求参数无效，请检查模型及请求参数', category: 'parameters', retryable: false },
  429: { message: '请求达到并发或 QPS 上限，请稍后重试', category: 'rate_limit', retryable: true },
  500: { message: '服务内部错误，请稍后重试', category: 'server', retryable: true },
  502: { message: '服务网关异常，请稍后重试', category: 'server', retryable: true },
  503: { message: '服务繁忙或暂不可用，请稍后重试', category: 'capacity', retryable: true },
  504: { message: '服务网关超时，请稍后重试', category: 'timeout', retryable: true }
});

function parseServiceError(status, body) {
  const httpStatus = Number.isInteger(status) && status >= 100 && status <= 599 ? status : 0;
  const known = Object.hasOwn(HTTP_ERRORS, httpStatus) ? HTTP_ERRORS[httpStatus] : null;
  const base = known || { message: '服务请求失败，请稍后重试', category: httpStatus >= 500 ? 'server' : 'unknown', retryable: httpStatus >= 500 };
  const envelope = errorEnvelope(body);
  const serviceMessage = sanitizeServiceDetail(envelope?.message);
  const serviceCode = sanitizeServiceDetail(envelope?.code, 80);
  const serviceType = sanitizeServiceDetail(envelope?.type, 80);
  const tags = [...new Set([serviceType, serviceCode].filter(Boolean))];
  const details = [serviceMessage, tags.length ? `[${tags.join('; ')}]` : ''].filter(Boolean).join(' ');
  const message = `${base.message}${httpStatus ? `（HTTP ${httpStatus}）` : ''}${details ? `：${details}` : ''}`;
  // Authentication expiry is deliberately left to the caller, which knows the service/host.
  return { ...base, message, httpStatus, serviceMessage, serviceCode, serviceType };
}

const AUTHENTICATION_CODES = new Set([
  'invalid_api_key', 'invalid_key', 'invalid_authentication', 'authentication_error',
  'authentication_failed', 'auth_error', 'unauthorized', 'api_key_expired',
  'expired_api_key', 'key_expired'
]);

function authenticationHttpStatus(value) {
  if (typeof value === 'string') {
    if (!/^\s*\d{3}\s*$/.test(value)) return 0;
    value = Number(value);
  }
  return Number.isInteger(value) && value >= 100 && value <= 599 ? value : 0;
}

function isAuthenticationFailure(error) {
  if (typeof error === 'string') return error.length <= 128 && AUTHENTICATION_CODES.has(error.trim().toLowerCase());
  if (!error || typeof error !== 'object' || Array.isArray(error)) return false;
  // Explicit transport status wins over provider labels; balance, quota, and file
  // expiry failures must never open the API-key-expired flow.
  for (const value of [error.httpStatus, error.status, error.code]) {
    const status = authenticationHttpStatus(value);
    if (status) return status === 401;
  }
  return [error.code, error.type].some(value => typeof value === 'string' && value.length <= 128 && AUTHENTICATION_CODES.has(value.trim().toLowerCase()));
}

module.exports = { MAX_ERROR_BODY_BYTES, MAX_DETAIL_CHARS, finishReasonInfo, sanitizeServiceDetail, parseServiceError, isAuthenticationFailure };
