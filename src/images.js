const { createHash } = require('crypto');
const { check, readVisionImage, describeVisionImages } = require('./core');
const { validateVisionImage, safeVisionText } = require('./vision');

const DEFAULT_IMAGE_MEMORY = 128 * 1024 * 1024;
const DEFAULT_DESCRIPTION_MEMORY = 16 * 1024 * 1024;

function safeImage(image) {
  return { id: image.id, name: image.name, mime: image.mime, width: image.width, height: image.height, size: image.size, ...(image.region ? { region: { ...image.region } } : {}) };
}

function imageRegion(region) {
  if (region == null) return null;
  const { x, y, width, height } = region;
  if (![x, y, width, height].every(Number.isFinite) || x < 0 || y < 0 || width <= 0 || height <= 0 || x + width > 1 || y + height > 1) {
    throw new Error('图片裁剪区域必须在 0 到 1 范围内，且宽高大于 0');
  }
  return { x, y, width, height };
}

function stopped() {
  const error = new Error('已停止'); error.name = 'AbortError'; return error;
}

function abortable(task, signal) {
  return new Promise((resolve, reject) => {
    const abort = () => reject(stopped());
    signal?.addEventListener('abort', abort, { once: true });
    Promise.resolve(task).then(resolve, reject).finally(() => signal?.removeEventListener('abort', abort));
    if (signal?.aborted) abort();
  });
}

async function cropVisionImage(image, region, signal, {
  ImageCtor = globalThis.Image,
  BlobCtor = globalThis.Blob,
  url = globalThis.URL,
  document = globalThis.document
} = {}) {
  const bounds = imageRegion(region);
  check(signal);
  if (!bounds || typeof ImageCtor !== 'function' || typeof BlobCtor !== 'function' || typeof url?.createObjectURL !== 'function' || typeof url?.revokeObjectURL !== 'function' || typeof document?.createElement !== 'function') {
    throw new Error('当前环境无法裁剪图片，请在 Obsidian 桌面端重试');
  }
  let objectUrl, decoded;
  try {
    objectUrl = url.createObjectURL(new BlobCtor([image.bytes], { type: image.mime }));
    decoded = new ImageCtor();
    const loading = new Promise((resolve, reject) => {
      decoded.onload = () => resolve(decoded);
      decoded.onerror = () => reject(new Error('无法读取图片以裁剪，请重新上传'));
      decoded.src = objectUrl;
    });
    await abortable(loading, signal); check(signal);
    const left = Math.floor(image.width * bounds.x), top = Math.floor(image.height * bounds.y);
    const width = Math.min(image.width, Math.ceil(image.width * (bounds.x + bounds.width))) - left;
    const height = Math.min(image.height, Math.ceil(image.height * (bounds.y + bounds.height))) - top;
    const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
    const context = canvas.getContext('2d');
    if (!context || typeof canvas.toBlob !== 'function') throw new Error('当前环境无法裁剪图片，请在 Obsidian 桌面端重试');
    context.drawImage(decoded, left, top, width, height, 0, 0, width, height);
    const blob = await abortable(new Promise((resolve, reject) => canvas.toBlob(value => value ? resolve(value) : reject(new Error('图片裁剪失败，请重试')), 'image/png')), signal);
    const bytes = Buffer.from(await abortable(blob.arrayBuffer(), signal)); check(signal);
    return { ...image, bytes, mime: 'image/png', width, height, size: bytes.length, region: bounds };
  } finally {
    if (decoded) { decoded.onload = null; decoded.onerror = null; decoded.removeAttribute?.('src'); }
    if (objectUrl) url.revokeObjectURL(objectUrl);
  }
}

class ImageStore {
  #images = new Map();
  #pinned = new Set();
  #active = new Map();
  #descriptions = new Map();
  #requests = new Set();
  #bytes = 0;
  #descriptionBytes = 0;
  #generation = 0;
  #maxBytes;
  #maxDescriptionBytes;
  #decodeDimensions;
  #send;
  #crop;

  constructor({ maxBytes = DEFAULT_IMAGE_MEMORY, maxDescriptionBytes = DEFAULT_DESCRIPTION_MEMORY, decodeDimensions, send, cropImage = cropVisionImage } = {}) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || !Number.isSafeInteger(maxDescriptionBytes) || maxDescriptionBytes < 0) throw new Error('图片内存上限无效');
    this.#maxBytes = maxBytes;
    this.#maxDescriptionBytes = maxDescriptionBytes;
    this.#decodeDimensions = decodeDimensions;
    this.#send = send;
    this.#crop = cropImage;
  }

  #touch(id) {
    const image = this.#images.get(id);
    if (image) { this.#images.delete(id); this.#images.set(id, image); }
    return image;
  }

  #deleteDescription(key) {
    const cached = this.#descriptions.get(key);
    if (cached) this.#descriptionBytes -= cached.size;
    this.#descriptions.delete(key);
  }

  #drop(id) {
    const image = this.#images.get(id);
    if (!image) return;
    this.#bytes -= image.size;
    this.#images.delete(id); this.#pinned.delete(id);
    for (const [key, cached] of this.#descriptions) if (cached.ids.includes(id)) this.#deleteDescription(key);
  }

  #makeRoom(size) {
    if (size > this.#maxBytes) throw new Error('图片超过本次会话的原图内存上限，请缩小图片');
    for (const id of this.#images.keys()) {
      if (this.#bytes + size <= this.#maxBytes) break;
      if (!this.#pinned.has(id) && !this.#active.has(id)) this.#drop(id);
    }
    if (this.#bytes + size > this.#maxBytes) throw new Error('待发送图片已达到原图内存上限，请发送或移除部分图片后重试');
  }

  async add(file, signal, { pin = true } = {}) {
    const generation = this.#generation;
    const image = await readVisionImage(file, signal, { decodeDimensions: this.#decodeDimensions });
    check(signal);
    if (generation !== this.#generation) throw stopped();
    const id = 'image-' + createHash('sha256').update(image.bytes).digest('hex');
    const existing = this.#touch(id);
    if (existing) { if (pin) this.#pinned.add(id); return safeImage(existing); }
    this.#makeRoom(image.size);
    const stored = { ...image, id };
    this.#images.set(id, stored); this.#bytes += stored.size;
    if (pin) this.#pinned.add(id);
    return safeImage(stored);
  }

  get(id) {
    const image = this.#touch(id);
    return image ? safeImage(image) : undefined;
  }

  metadata(ids) {
    return (ids == null ? [...this.#images.keys()] : ids).map(id => this.#images.get(id)).filter(Boolean).map(safeImage);
  }

  setPinned(ids, pinned) {
    for (const id of ids) {
      if (pinned && this.#images.has(id)) this.#pinned.add(id);
      else this.#pinned.delete(id);
    }
  }

  remove(id) {
    if (this.#active.has(id)) { this.#pinned.delete(id); return false; }
    this.#drop(id); return true;
  }

  async describe(ids, question, options = {}) {
    check(options.signal);
    if (!Array.isArray(ids) || !ids.length || ids.some(id => typeof id !== 'string')) throw new Error('请指定要识别的图片');
    const selected = [...new Set(ids)];
    let images = selected.map(id => {
      const image = this.#touch(id);
      if (!image) throw new Error('原图已从内存释放或会话已关闭，请重新上传图片');
      return image;
    });
    const region = imageRegion(options.region);
    if (region && images.length !== 1) throw new Error('区域识图一次只能选择一张图片');
    const model = options.model || 'deepseek-flash';
    const effort = ['low', 'high', 'max'].includes(options.reasoningEffort) ? options.reasoningEffort : 'low';
    const task = typeof question === 'string' ? safeVisionText(question.trim()) : '';
    const cacheKey = JSON.stringify([selected, task, model, effort, options.maxOutputTokens ?? null, region]);
    const cached = this.#descriptions.get(cacheKey);
    if (cached) {
      this.#descriptions.delete(cacheKey); this.#descriptions.set(cacheKey, cached);
      return { text: cached.text, images: cached.images.map(image => ({ ...image, ...(image.region ? { region: { ...image.region } } : {}) })), cached: true };
    }
    const generation = this.#generation;
    const controller = new AbortController();
    const abort = () => controller.abort();
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) controller.abort();
    this.#requests.add(controller);
    for (const id of selected) this.#active.set(id, (this.#active.get(id) || 0) + 1);
    try {
      if (region) {
        const cropped = await abortable(this.#crop(images[0], region, controller.signal), controller.signal);
        check(controller.signal);
        const decoded = await validateVisionImage(cropped.bytes, { signal: controller.signal, decodeDimensions: async () => ({ width: cropped.width, height: cropped.height }) });
        images = [{ ...images[0], ...cropped, ...decoded, id: images[0].id, size: cropped.bytes.length, region }];
      }
      const text = await describeVisionImages(images, options.key, controller.signal, options.progress, this.#send, { ...options, model, reasoningEffort: effort, question: task });
      check(controller.signal);
      if (generation !== this.#generation) throw stopped();
      const metadata = images.map(safeImage);
      const size = Buffer.byteLength(text, 'utf8') + Buffer.byteLength(cacheKey, 'utf8') + Buffer.byteLength(JSON.stringify(metadata), 'utf8');
      if (size <= this.#maxDescriptionBytes) {
        while (this.#descriptionBytes + size > this.#maxDescriptionBytes || this.#descriptions.size >= 64) this.#deleteDescription(this.#descriptions.keys().next().value);
        this.#descriptions.set(cacheKey, { text, images: metadata, ids: selected, size });
        this.#descriptionBytes += size;
      }
      return { text, images: metadata.map(image => ({ ...image, ...(image.region ? { region: { ...image.region } } : {}) })), cached: false };
    } finally {
      options.signal?.removeEventListener('abort', abort);
      this.#requests.delete(controller);
      if (generation === this.#generation) for (const id of selected) {
        const count = (this.#active.get(id) || 0) - 1;
        if (count > 0) this.#active.set(id, count); else this.#active.delete(id);
      }
    }
  }

  clear() {
    this.#generation++;
    for (const controller of this.#requests) controller.abort();
    this.#requests.clear(); this.#images.clear(); this.#pinned.clear(); this.#active.clear(); this.#descriptions.clear();
    this.#bytes = 0; this.#descriptionBytes = 0;
  }
}

module.exports = { ImageStore, cropVisionImage, imageRegion, DEFAULT_IMAGE_MEMORY };
