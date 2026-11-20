const { createHash, randomBytes } = require('node:crypto');
const { request, check } = require('./core');
const { isAuthenticationFailure } = require('./service-errors');

const FILE_LIFETIME_SECONDS = 30 * 24 * 60 * 60;
const API = 'https://api.deepseek.com/files';
const DOCUMENT = /\.(?:pdf|docx?|pptx?|bmp|tiff?)$/i;
const IMAGE = /\.(?:jpe?g|png|gif|webp)$/i;

function fileOptions(name) {
  if (DOCUMENT.test(name)) return { purpose: 'rich_layout_recognition', maxBytes: 100 * 1024 * 1024 };
  return { purpose: 'user_data', maxBytes: (IMAGE.test(name) ? 64 : 32) * 1024 * 1024 };
}

async function fileRequest(url, key, signal, options = {}) {
  if (!key) throw new Error('Enter a DeepSeek API key.');
  const { request: http = request, ...requestOptions } = options;
  try {
    const body = await http(url, { ...requestOptions, signal, headers: { Authorization: 'Bearer ' + key, ...requestOptions.headers }, maxBytes: 1024 * 1024 });
    check(signal);
    const data = JSON.parse(body.toString('utf8'));
    if (data.error) throw Object.assign(new Error(data.error.message || 'DeepSeek file request failed.'), { code: data.error.code });
    return data;
  } catch (error) {
    if (isAuthenticationFailure(error)) Object.assign(error, { authExpired: true, authService: 'deepseek' });
    throw error;
  }
}

async function uploadFile(file, key, signal, options = {}) {
  check(signal);
  const name = String(file.name || 'attachment');
  const format = fileOptions(name);
  if (!Number.isSafeInteger(file.size) || file.size <= 0 || file.size > format.maxBytes) throw new Error(`File must be between 1 byte and ${format.maxBytes / 1024 / 1024} MiB.`);
  const raw = Buffer.from(await file.arrayBuffer());
  check(signal);
  if (raw.length !== file.size) throw new Error('The file changed while being read. Attach it again.');
  const hash = createHash('sha256').update(raw).digest('hex');
  const boundary = '----SimpleDeepSeek' + randomBytes(18).toString('hex');
  const filename = name.replace(/[\r\n"\\]/g, '_');
  const field = (key, value) => `--${boundary}\r\nContent-Disposition: form-data; name="${key}"\r\n\r\n${value}\r\n`;
  // The service requires purpose before file and waits for document parsing before responding.
  const prefix = field('purpose', format.purpose) + field('expires_after[anchor]', 'created_at') + field('expires_after[seconds]', FILE_LIFETIME_SECONDS)
    + `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: application/octet-stream\r\n\r\n`;
  const body = Buffer.concat([Buffer.from(prefix), raw, Buffer.from(`\r\n--${boundary}--\r\n`)]);
  const data = await fileRequest(API, key, signal, { request: options.request, method: 'POST', body,
    headers: { 'Content-Type': 'multipart/form-data; boundary=' + boundary }, timeoutMs: 11 * 60 * 1000, idleTimeoutMs: 5 * 60 * 1000 });
  if (typeof data.id !== 'string' || !/^file-[A-Za-z0-9_-]+$/.test(data.id)) throw new Error('DeepSeek returned an invalid file ID.');
  return { id: data.id, name, hash, purpose: format.purpose, bytes: raw.length, expiresAt: Number(data.expires_at) || Math.floor(Date.now() / 1000) + FILE_LIFETIME_SECONDS };
}

function fileIds(messages) {
  const ids = new Set();
  for (const message of messages || []) {
    if (!Array.isArray(message.content)) continue;
    for (const block of message.content) if (block?.type === 'file' && typeof block.file_id === 'string') ids.add(block.file_id);
  }
  return [...ids];
}

async function validateFiles(messages, key, signal, options = {}) {
  const result = [];
  for (const id of fileIds(messages)) {
    check(signal);
    let data;
    try {
      data = await fileRequest(API + '/' + encodeURIComponent(id), key, signal, options);
    } catch (error) {
      if (![404,410].includes(error.httpStatus || error.status || error.statusCode) && !/HTTP (?:404|410)\b/.test(error.message)) throw error;
      throw Object.assign(new Error('A DeepSeek attachment has expired or is unavailable. Attach the original file again to continue.'), { code: 'FILE_UNAVAILABLE', fileId: id });
    }
    if (data.id !== id || data.deleted || (data.expires_at && data.expires_at <= Date.now() / 1000)) {
      throw Object.assign(new Error('A DeepSeek attachment has expired or is unavailable. Attach the original file again to continue.'), { code: 'FILE_UNAVAILABLE', fileId: id });
    }
    result.push(data);
  }
  return result;
}

module.exports = { FILE_LIFETIME_SECONDS, fileOptions, uploadFile, fileIds, validateFiles };
