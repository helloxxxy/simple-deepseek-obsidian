const MAX_VISION_IMAGE = 32 * 1024 * 1024;
const { sanitizeReferenceText } = require('./text-safety');
const MAX_VISION_DIMENSION = 8192;
const MAX_VISION_REQUEST = 48 * 1024 * 1024;

function safeVisionText(value) {
  return sanitizeReferenceText(value).replace(/<svg\b[^>]*>[\s\S]*?<\/svg>/gi, '[image markup omitted]');
}

function checkAbort(signal) {
  if (!signal?.aborted) return;
  const error = new Error('已停止');
  error.name = 'AbortError';
  throw error;
}

function imageMime(bytes) {
  const data = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  if (data.length >= 8 && data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'image/jpeg';
  if (data.length >= 6 && /^GIF8[79]a$/.test(data.toString('ascii', 0, 6))) return 'image/gif';
  if (data.length >= 12 && data.toString('ascii', 0, 4) === 'RIFF' && data.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  throw new Error('DeepSeek 原生识图仅支持 PNG、JPEG、GIF 和 WebP；请先转换图片格式');
}

function assertVisionImageSize(size) {
  if (!Number.isSafeInteger(size) || size <= 0 || size > MAX_VISION_IMAGE) {
    throw new Error('图片必须大于 0 且不超过 DeepSeek 官方的 32 MiB 上限');
  }
}

function decodeImageDimensions(bytes, mime, {
  signal,
  ImageCtor = globalThis.Image,
  BlobCtor = globalThis.Blob,
  url = globalThis.URL
} = {}) {
  checkAbort(signal);
  if (typeof ImageCtor !== 'function' || typeof BlobCtor !== 'function' || typeof url?.createObjectURL !== 'function' || typeof url?.revokeObjectURL !== 'function') {
    throw new Error('当前环境无法读取图片尺寸，请在 Obsidian 桌面端重试');
  }
  return new Promise((resolve, reject) => {
    const image = new ImageCtor();
    let objectUrl;
    let settled = false;
    const finish = (error, dimensions) => {
      if (settled) return;
      settled = true;
      image.onload = null;
      image.onerror = null;
      signal?.removeEventListener('abort', abort);
      image.removeAttribute?.('src');
      if (objectUrl) url.revokeObjectURL(objectUrl);
      if (error) reject(error);
      else resolve(dimensions);
    };
    const abort = () => {
      const error = new Error('已停止');
      error.name = 'AbortError';
      finish(error);
    };
    image.decoding = 'async';
    image.onload = () => finish(null, { width: image.naturalWidth, height: image.naturalHeight });
    image.onerror = () => finish(new Error('无法读取图片尺寸，文件可能损坏或格式不受支持'));
    signal?.addEventListener('abort', abort, { once: true });
    try {
      checkAbort(signal);
      objectUrl = url.createObjectURL(new BlobCtor([bytes], { type: mime }));
      image.src = objectUrl;
    } catch (error) {
      finish(error?.name === 'AbortError' ? error : new Error('无法读取图片尺寸，文件可能损坏或格式不受支持'));
    }
  });
}

async function validateVisionImage(bytes, { signal, decodeDimensions = decodeImageDimensions } = {}) {
  checkAbort(signal);
  const data = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  assertVisionImageSize(data.length);
  const mime = imageMime(data);
  const dimensions = await decodeDimensions(data, mime, { signal });
  checkAbort(signal);
  const { width, height } = dimensions || {};
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0) {
    throw new Error('无法读取图片尺寸，文件可能损坏或格式不受支持');
  }
  if (width > MAX_VISION_DIMENSION || height > MAX_VISION_DIMENSION) {
    throw new Error(`图片尺寸 ${width} × ${height} px 超过 DeepSeek 官方的单边 8192 px 上限；请先缩小或裁剪图片`);
  }
  return { mime, width, height };
}

function assertVisionRequestSize(body) {
  const serialized = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  const size = Buffer.byteLength(serialized, 'utf8');
  if (size > MAX_VISION_REQUEST) {
    throw new Error('图片请求正文超过 DeepSeek 官方的 48 MiB 上限；请缩小图片或减少附带内容');
  }
  return size;
}

module.exports = {
  MAX_VISION_IMAGE,
  MAX_VISION_DIMENSION,
  MAX_VISION_REQUEST,
  safeVisionText,
  imageMime,
  assertVisionImageSize,
  decodeImageDimensions,
  validateVisionImage,
  assertVisionRequestSize
};
