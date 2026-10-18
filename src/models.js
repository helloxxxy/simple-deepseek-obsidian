const { createHash } = require('node:crypto');

const DEFAULT_CONTEXT_WINDOW = 1048576;
const DEFAULT_MAX_OUTPUT = 393216;
const positiveInteger = value => Number.isSafeInteger(value) && value > 0;
const check = signal => { if (signal?.aborted) { const error = Error('已停止'); error.name = 'AbortError'; throw error; } };
function modelCapabilities(id, record = null) {
  const contextWindow = positiveInteger(record?.context_window) ? record.context_window : DEFAULT_CONTEXT_WINDOW;
  const maxOutputTokens = Math.min(contextWindow, positiveInteger(record?.max_output_tokens) ? record.max_output_tokens : DEFAULT_MAX_OUTPUT);
  const levels = Array.isArray(record?.effort?.supported_levels) ? [...new Set(record.effort.supported_levels.filter(level => ['low','high','max'].includes(level)))] : [];
  return Object.freeze({
    id, name: typeof record?.name === 'string' && record.name.trim() ? record.name : id,
    contextWindow, maxOutputTokens,
    inputModalities: Object.freeze(Array.isArray(record?.input_modalities) ? record.input_modalities.filter(value => ['text','image'].includes(value)) : (/^deepseek-(?:flash|v4-flash|v4-flash-vision-exp)$/.test(id) ? ['text','image'] : ['text'])),
    reasoningEfforts: Object.freeze(levels.length ? levels : ['low','high','max']),
    defaultEffort: levels.includes(record?.effort?.default_level) ? record.effort.default_level : (levels[0] || 'high'),
    discovered: !!record
  });
}
function assertReasoningEffort(capabilities, effort) {
  if (!capabilities.reasoningEfforts.includes(effort)) throw Error('当前模型不支持所选思考强度，请调整思考强度后重试');
}
class ModelCatalog {
  constructor({ fetchModels, now = Date.now, ttlMs = 15 * 60 * 1000, failureTtlMs = 60000 } = {}) {
    this.fetchModels = fetchModels; this.now = now; this.ttlMs = ttlMs; this.failureTtlMs = failureTtlMs; this.cache = new Map();
  }
  async get(key, model, signal) {
    check(signal);
    if (!key || typeof this.fetchModels !== 'function') return modelCapabilities(model);
    const cacheKey = createHash('sha256').update(key).digest('hex');
    let entry = this.cache.get(cacheKey);
    if (!entry || entry.expiresAt <= this.now()) {
      let records = entry?.records || new Map(), ttl = this.ttlMs;
      try {
        const result = await this.fetchModels(key, signal); check(signal);
        if (!Array.isArray(result?.data)) throw Error('Invalid model list');
        records = new Map();
        for (const record of result.data) if (record && typeof record.id === 'string' && record.id.trim()) records.set(record.id, record);
      } catch (error) {
        check(signal); if (error?.name === 'AbortError') throw error;
        const current = this.cache.get(cacheKey);
        if (current && current !== entry) return modelCapabilities(model,current.records.get(model));
        ttl = this.failureTtlMs;
      }
      entry = { records, expiresAt: this.now() + ttl }; this.cache.set(cacheKey, entry);
      while (this.cache.size > 4) this.cache.delete(this.cache.keys().next().value);
    }
    check(signal);
    return modelCapabilities(model, entry.records.get(model));
  }
}
module.exports = { DEFAULT_CONTEXT_WINDOW, DEFAULT_MAX_OUTPUT, modelCapabilities, assertReasoningEffort, ModelCatalog };
