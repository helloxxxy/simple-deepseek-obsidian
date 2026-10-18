const test = require('node:test');
const assert = require('node:assert/strict');
const vision = require('./src/vision');

const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]);
const signal = () => new AbortController().signal;

test('vision identifies supported formats by bytes rather than file extensions', () => {
  assert.equal(vision.imageMime(png), 'image/png');
  assert.equal(vision.imageMime(Buffer.from([255, 216, 255, 224])), 'image/jpeg');
  assert.equal(vision.imageMime(Buffer.from('GIF87a')), 'image/gif');
  assert.equal(vision.imageMime(Buffer.from('GIF89a')), 'image/gif');
  assert.equal(vision.imageMime(Buffer.from('RIFF0000WEBP')), 'image/webp');
  for (const bytes of [Buffer.from('a.png'), png.subarray(0, 7), Buffer.from('GIF80a'), Buffer.from('RIFF0000WAVE')]) {
    assert.throws(() => vision.imageMime(bytes), /PNG、JPEG、GIF 和 WebP/);
  }
});

test('vision verifies decoded dimensions and returns only non-image metadata', async () => {
  let decoded = 0;
  const inputSignal = signal();
  const result = await vision.validateVisionImage(png, {
    signal: inputSignal,
    decodeDimensions: async (bytes, mime, options) => {
      decoded++;
      assert.equal(bytes, png);
      assert.equal(mime, 'image/png');
      assert.equal(options.signal, inputSignal);
      return { width: 8192, height: 8192 };
    }
  });
  assert.equal(decoded, 1);
  assert.deepEqual(result, { mime: 'image/png', width: 8192, height: 8192 });
  assert.ok(!JSON.stringify(result).includes('base64'));
});

test('vision rejects either oversized axis and invalid dimensions before sending', async () => {
  for (const dimensions of [
    { width: 8193, height: 1 },
    { width: 1, height: 8193 }
  ]) {
    await assert.rejects(vision.validateVisionImage(png, { decodeDimensions: async () => dimensions }), /8192 px/);
  }
  for (const dimensions of [null, {}, { width: 0, height: 1 }, { width: 1, height: NaN }, { width: 1.5, height: 2 }]) {
    await assert.rejects(vision.validateVisionImage(png, { decodeDimensions: async () => dimensions }), /无法读取图片尺寸/);
  }
  await assert.rejects(vision.validateVisionImage(png, { decodeDimensions: async () => { throw new Error('invalid image'); } }), /invalid image/);
});

test('vision validates actual byte count before decoding and accepts the official limit', async () => {
  vision.assertVisionImageSize(vision.MAX_VISION_IMAGE);
  for (const size of [0, -1, NaN, Infinity, 1.1, vision.MAX_VISION_IMAGE + 1]) {
    assert.throws(() => vision.assertVisionImageSize(size), /32 MiB/);
  }
  for (const bytes of [Buffer.alloc(0), Buffer.alloc(vision.MAX_VISION_IMAGE + 1)]) {
    await assert.rejects(vision.validateVisionImage(bytes, { decodeDimensions: () => assert.fail('must not decode') }), /32 MiB/);
  }
  await assert.rejects(vision.validateVisionImage(Buffer.from('not an image'), { decodeDimensions: () => assert.fail('must not decode') }), /PNG、JPEG、GIF 和 WebP/);
});

test('vision honors cancellation before decoding and after asynchronous decoding', async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(vision.validateVisionImage(png, { signal: controller.signal, decodeDimensions: () => assert.fail('must not decode') }), { name: 'AbortError' });
  const during = new AbortController();
  await assert.rejects(vision.validateVisionImage(png, {
    signal: during.signal,
    decodeDimensions: async () => { during.abort(); return { width: 10, height: 10 }; }
  }), { name: 'AbortError' });
});

function browserDecoder({ fail = false, wait = false, width = 640, height = 480 } = {}) {
  let instance;
  const revoked = [];
  let blob;
  class FakeImage {
    constructor() { instance = this; this.naturalWidth = width; this.naturalHeight = height; }
    set src(value) {
      this.source = value;
      if (!wait) queueMicrotask(() => { if (fail) this.onerror?.(); else this.onload?.(); });
    }
    removeAttribute(name) { assert.equal(name, 'src'); this.removed = true; }
  }
  class FakeBlob {
    constructor(parts, options) { blob = { parts, options }; }
  }
  const url = { createObjectURL: () => 'blob:local-image', revokeObjectURL: value => revoked.push(value) };
  return { options: { ImageCtor: FakeImage, BlobCtor: FakeBlob, url }, revoked, get instance() { return instance; }, get blob() { return blob; } };
}

test('browser decoder obtains natural dimensions with a temporary local blob and always releases it', async () => {
  const browser = browserDecoder();
  assert.deepEqual(await vision.decodeImageDimensions(png, 'image/png', browser.options), { width: 640, height: 480 });
  assert.equal(browser.blob.parts[0], png);
  assert.equal(browser.blob.options.type, 'image/png');
  assert.equal(browser.instance.decoding, 'async');
  assert.equal(browser.instance.removed, true);
  assert.equal(browser.instance.onload, null);
  assert.equal(browser.instance.onerror, null);
  assert.deepEqual(browser.revoked, ['blob:local-image']);

  const corrupt = browserDecoder({ fail: true });
  await assert.rejects(vision.decodeImageDimensions(png, 'image/png', corrupt.options), /无法读取图片尺寸/);
  assert.deepEqual(corrupt.revoked, ['blob:local-image']);
});

test('browser decoder cancels pending decoding, releases blob and does not require an upload', async () => {
  const browser = browserDecoder({ wait: true });
  const controller = new AbortController();
  const pending = vision.decodeImageDimensions(png, 'image/png', { ...browser.options, signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(browser.instance.removed, true);
  assert.deepEqual(browser.revoked, ['blob:local-image']);
  assert.equal(browser.instance.onload, null);
});

test('browser decoder fails explicitly when no browser image decoder is available', () => {
  assert.throws(() => vision.decodeImageDimensions(png, 'image/png', { ImageCtor: null }), /Obsidian 桌面端/);
});

test('vision request limit is checked on serialized UTF-8 bytes including base64 and JSON overhead', () => {
  assert.equal(vision.assertVisionRequestSize({ message: '中文' }), Buffer.byteLength(JSON.stringify({ message: '中文' })));
  assert.equal(vision.assertVisionRequestSize(Buffer.alloc(vision.MAX_VISION_REQUEST)), vision.MAX_VISION_REQUEST);
  assert.throws(() => vision.assertVisionRequestSize(Buffer.alloc(vision.MAX_VISION_REQUEST + 1)), /48 MiB/);
  const body = { messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: `data:image/png;base64,${'A'.repeat(vision.MAX_VISION_REQUEST)}` } }] }] };
  assert.throws(() => vision.assertVisionRequestSize(body), /48 MiB/);
});
