const test = require('node:test');
const assert = require('node:assert/strict');
const { ImageStore, imageRegion, cropVisionImage } = require('./src/images');
const { describeImage, describeImages, describeVisionImages } = require('./src/core');
const { translate } = require('./src/i18n');

const png = value => Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, value, 2, 3]);
const file = (value = 1, name = 'figure.png') => {
  const bytes = png(value);
  return { name, size: bytes.length, arrayBuffer: async () => bytes };
};
const decodeDimensions = async () => ({ width: 640, height: 480 });
const tick = () => new Promise(resolve => setImmediate(resolve));

test('image store deduplicates actual bytes and exposes only safe metadata', async () => {
  const store = new ImageStore({ decodeDimensions });
  const first = await store.add(file());
  const duplicate = await store.add(file(1, 'renamed.jpg'));
  assert.equal(first.id, duplicate.id);
  assert.match(first.id, /^image-[0-9a-f]{64}$/);
  assert.equal(store.metadata().length, 1);
  assert.deepEqual(store.get(first.id), first);
  const serialized = JSON.stringify({ store, first, metadata: store.metadata() });
  assert.ok(!serialized.includes('base64'));
  assert.ok(!serialized.includes('Buffer'));
  assert.ok(!serialized.includes('bytes'));
  assert.equal(JSON.stringify(store), '{}');
  first.name = 'mutated';
  assert.equal(store.get(duplicate.id).name, 'figure.png');
});

test('image descriptions group images with the actual question and cache only the same task', async () => {
  const requests = [], usages = [];
  const send = async (key, messages, signal, onText, http, options) => {
    requests.push({ key, messages, options }); onText('The red curve is above the blue curve.');
    return { prompt_tokens: 100, completion_tokens: 10 };
  };
  const store = new ImageStore({ decodeDimensions, send });
  const one = await store.add(file(1, 'first.png')), two = await store.add(file(2, 'second.png'));
  const options = { key: 'secret', onUsage: usage => usages.push(usage), reasoningEffort: 'low', maxOutputTokens: 1000 };
  const result = await store.describe([one.id, two.id], 'Compare the colored curves', options);
  assert.equal(result.cached, false);
  assert.equal(result.images.length, 2);
  assert.equal(requests[0].messages.length, 1);
  const parts = requests[0].messages[0].content;
  assert.match(parts[0].text, /Compare the colored curves/);
  assert.match(parts[0].text, /first.png/);
  assert.match(parts[0].text, /second.png/);
  assert.equal(parts.filter(part => part.type === 'image_url').length, 2);
  assert.equal(requests[0].options.model, 'deepseek-flash');
  assert.equal(requests[0].options.maxOutputTokens, 1000);
  assert.ok(!JSON.stringify(result).includes('base64'));
  assert.equal((await store.describe([one.id, two.id], 'Compare the colored curves', options)).cached, true);
  assert.equal(requests.length, 1); assert.equal(usages.length, 1);
  await store.describe([one.id, two.id], 'Read the axis labels', options);
  await store.describe([two.id, one.id], 'Compare the colored curves', options);
  await store.describe([one.id, two.id], 'Compare the colored curves', { ...options, reasoningEffort: 'max' });
  await store.describe([one.id, two.id], 'Compare the colored curves', { ...options, model: 'another-vision-model' });
  assert.equal(requests.length, 5); assert.equal(usages.length, 5);
});

test('image original memory evicts least recently used unpinned images and gives an explicit reread error', async () => {
  const store = new ImageStore({ maxBytes: png(0).length * 2, decodeDimensions });
  const one = await store.add(file(1), undefined, { pin: false });
  const two = await store.add(file(2), undefined, { pin: false });
  store.get(one.id);
  const three = await store.add(file(3), undefined, { pin: false });
  assert.equal(store.get(two.id), undefined);
  assert.ok(store.get(one.id)); assert.ok(store.get(three.id));
  await assert.rejects(store.describe([two.id], 'Read this', { key: 'key' }), /重新上传/);
  store.setPinned([one.id, three.id], true);
  await assert.rejects(store.add(file(4)), /待发送图片/);
  store.setPinned([one.id], false);
  await store.add(file(4));
  assert.equal(store.get(one.id), undefined);
  assert.ok(store.get(three.id));
});

test('image memory cancellation cannot leave an attachment or completed description behind', async () => {
  const controller = new AbortController();
  const store = new ImageStore({ decodeDimensions: async () => { controller.abort(); return { width: 10, height: 10 }; } });
  await assert.rejects(store.add(file(), controller.signal), { name: 'AbortError' });
  assert.equal(store.metadata().length, 0);

  let resolveRead;
  const reading = new ImageStore({ decodeDimensions });
  const pending = reading.add({ ...file(), arrayBuffer: () => new Promise(resolve => { resolveRead = resolve; }) });
  await tick(); reading.clear(); resolveRead(png(1));
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(reading.metadata().length, 0);
});

test('clear aborts image requests even when an injected transport ignores the signal', async () => {
  let finish, started = false;
  const store = new ImageStore({ decodeDimensions, send: async (_key, _messages, _signal, onText) => {
    started = true;
    await new Promise(resolve => { finish = resolve; });
    onText('Late result'); return { completion_tokens: 3 };
  } });
  const image = await store.add(file());
  const pending = store.describe([image.id], 'What is this?', { key: 'key' });
  await tick(); assert.equal(started, true);
  store.clear();
  await assert.rejects(pending, { name: 'AbortError' });
  finish(); await tick();
  assert.equal(store.metadata().length, 0);
  await assert.rejects(store.describe([image.id], 'What is this?', { key: 'key' }), /重新上传/);
});

test('vision usage is reported once on successful and failed actual requests, and cancellation stops immediately', async () => {
  const seen = [];
  const options = { decodeDimensions, question: 'Read the equation', onUsage: (usage, metadata) => seen.push({ usage, metadata }) };
  const text = await describeImage(file(), 'key', undefined, undefined, async (_key, messages, _signal, onText) => {
    assert.match(messages[0].content[0].text, /Read the equation/); onText('x = 2');
    return { prompt_tokens: 11, completion_tokens: 3 };
  }, options);
  assert.equal(text, 'x = 2'); assert.equal(seen.length, 1);
  const failure = Object.assign(new Error('cut off'), { usage: { prompt_tokens: 11, completion_tokens: 2 } });
  await assert.rejects(describeImage(file(), 'key', undefined, undefined, async () => { throw failure; }, options), /cut off/);
  assert.equal(seen.length, 2); assert.equal(seen[1].metadata.error, failure);

  const controller = new AbortController();
  let finish;
  const pending = describeImage(file(), 'key', controller.signal, undefined, async () => new Promise(resolve => { finish = resolve; }), { decodeDimensions });
  await tick(); controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  finish({ completion_tokens: 0 });
});

test('vision accounts for dispatched requests without usage but does not count preflight or pre-dispatch cancellation', async () => {
  const reports = [];
  const options = { decodeDimensions, onUsage: (usage, metadata) => reports.push({ usage, metadata }) };
  await describeImage(file(), 'key', undefined, undefined, async (_key, _messages, _signal, onText) => { onText('A plot.'); }, options);
  assert.equal(reports.length, 1); assert.equal(reports[0].usage, undefined);
  const failure = new Error('Network failed');
  await assert.rejects(describeImage(file(), 'key', undefined, undefined, async () => { throw failure; }, options), /Network failed/);
  assert.equal(reports.length, 2); assert.equal(reports[1].usage, undefined); assert.equal(reports[1].metadata.error, failure);
  await assert.rejects(describeImage({ ...file(), size: 0 }, 'key', undefined, undefined, () => assert.fail('no dispatch'), options), /32 MiB/);
  assert.equal(reports.length, 2);
  const controller = new AbortController();
  await assert.rejects(describeImage(file(), 'key', controller.signal, status => {
    if (status === '正在识别图片…') controller.abort();
  }, () => assert.fail('no dispatch after cancellation'), options), { name: 'AbortError' });
  assert.equal(reports.length, 2);
});

test('group vision honors official batch dimensions, count and serialized body limits before transport', async () => {
  const tiny = { bytes: png(1), mime: 'image/png', name: 'x.png', width: 5000, height: 100, size: png(1).length };
  const noSend = () => assert.fail('request must not be sent');
  await assert.rejects(describeVisionImages(Array(601).fill(tiny), 'key', undefined, undefined, noSend), /600/);
  await assert.rejects(describeVisionImages(Array(15).fill(tiny), 'key', undefined, undefined, noSend), /4096/);
  const oversized = Buffer.alloc(18 * 1024 * 1024); png(1).copy(oversized);
  const large = { ...tiny, bytes: oversized, width: 100, height: 100, size: oversized.length };
  assert.ok(oversized.length * 2 < 64 * 1024 * 1024);
  await assert.rejects(describeVisionImages([large, large], 'key', undefined, undefined, noSend), /48 MiB/);
  const text = await describeImages([file(), file(2)], 'key', undefined, undefined, async (_key, messages, _signal, onText) => {
    assert.equal(messages[0].content.filter(part => part.type === 'image_url').length, 2);
    onText('Both images.');
  }, { decodeDimensions });
  assert.equal(text, 'Both images.');
});

test('region validation, cache identity and crops keep the original intact', async () => {
  for (const region of [{ x: -1, y: 0, width: 1, height: 1 }, { x: 0, y: 0, width: 0, height: 1 }, { x: 0, y: 0, width: 1, height: Infinity }, { x: 0.5, y: 0, width: 0.6, height: 1 }]) {
    assert.throws(() => imageRegion(region), /0 到 1/);
  }
  let crops = 0, requests = 0;
  const store = new ImageStore({ decodeDimensions, cropImage: async (image, region, signal) => {
    crops++; assert.equal(image.width, 640); assert.equal(signal.aborted, false);
    return { ...image, bytes: png(9), mime: 'image/png', width: 320, height: 240, region };
  }, send: async (_key, messages, _signal, onText) => {
    requests++; assert.match(messages[0].content[0].text, /cropped region/); onText('Zoomed formula');
  } });
  const image = await store.add(file());
  const options = { key: 'key', region: { x: 0.5, y: 0.5, width: 0.5, height: 0.5 } };
  const result = await store.describe([image.id], 'Read formula', options);
  assert.equal(result.images[0].width, 320);
  assert.deepEqual(result.images[0].region, options.region);
  assert.equal(store.get(image.id).width, 640);
  assert.equal((await store.describe([image.id], 'Read formula', options)).cached, true);
  assert.equal(crops, 1); assert.equal(requests, 1);
  await store.describe([image.id], 'Read formula', { ...options, region: { x: 0, y: 0, width: 0.5, height: 0.5 } });
  assert.equal(crops, 2);
  await assert.rejects(store.describe([image.id, (await store.add(file(2))).id], 'Read', options), /一次只能/);
});

test('browser region crop uses source pixels and releases its temporary object URL', async () => {
  const revoked = [], drawn = [];
  let instance;
  class FakeImage {
    constructor() { instance = this; }
    set src(value) { queueMicrotask(() => this.onload?.()); }
    removeAttribute(name) { assert.equal(name, 'src'); this.removed = true; }
  }
  const canvas = { getContext: () => ({ drawImage: (...args) => drawn.push(args) }), toBlob: callback => callback({ arrayBuffer: async () => png(7) }) };
  const cropped = await cropVisionImage({ bytes: png(1), mime: 'image/png', name: 'original.png', width: 100, height: 80 }, { x: 0.5, y: 0.25, width: 0.5, height: 0.5 }, undefined, {
    ImageCtor: FakeImage, BlobCtor: class {}, url: { createObjectURL: () => 'blob:crop', revokeObjectURL: value => revoked.push(value) }, document: { createElement: name => { assert.equal(name, 'canvas'); return canvas; } }
  });
  assert.equal(cropped.width, 50); assert.equal(cropped.height, 40);
  assert.deepEqual(drawn[0].slice(1), [50, 20, 50, 40, 0, 0, 50, 40]);
  assert.equal(canvas.width, 50); assert.equal(canvas.height, 40);
  assert.equal(instance.removed, true); assert.equal(instance.onload, null);
  assert.deepEqual(revoked, ['blob:crop']);
});

test('browser region crop releases object URLs on decode failure and cancellation', async () => {
  for (const cancel of [false, true]) {
    const revoked = [];
    const controller = new AbortController();
    let instance;
    class FakeImage {
      constructor() { instance = this; }
      set src(value) { queueMicrotask(() => { if (cancel) controller.abort(); else this.onerror?.(); }); }
      removeAttribute() { this.removed = true; }
    }
    const pending = cropVisionImage({ bytes: png(1), mime: 'image/png', width: 100, height: 80 }, { x: 0, y: 0, width: 1, height: 1 }, controller.signal, {
      ImageCtor: FakeImage, BlobCtor: class {}, url: { createObjectURL: () => 'blob:crop', revokeObjectURL: value => revoked.push(value) }, document: { createElement: () => assert.fail('no canvas after decode failure') }
    });
    if (cancel) await assert.rejects(pending, { name: 'AbortError' });
    else await assert.rejects(pending, /无法读取图片/);
    assert.deepEqual(revoked, ['blob:crop']);
    assert.equal(instance.removed, true);
    assert.equal(instance.onload, null);
  }
});

test('vision descriptions and attachment metadata cannot carry image payloads into saved context', async () => {
  const payload = 'A'.repeat(800);
  const store = new ImageStore({ decodeDimensions, send: async (_key, messages, _signal, onText) => {
    assert.ok(!messages[0].content[0].text.includes(payload));
    onText(`A labeled plot. data:image/png;base64,${payload}\n<svg><path d="M0 0"/></svg>\n${payload}`);
  } });
  const image = await store.add(file(1, `data:image/png;base64,${payload}`));
  assert.ok(!JSON.stringify(image).includes(payload));
  const result = await store.describe([image.id], `Read data:image/png;base64,${payload}`, { key: 'key' });
  assert.ok(!JSON.stringify(result).includes(payload));
  assert.ok(!JSON.stringify(result).includes('data:image/'));
  assert.ok(!result.text.includes('<svg'));
  assert.match(result.text, /A labeled plot/);
});

test('new image interface messages are available in English without changing Chinese originals', () => {
  for (const source of [
    '待发送图片', '移除图片', '图片已暂存，发送时结合问题识别。',
    '图片不属于当前会话，请重新附加图片', '原图已从内存释放或会话已关闭，请重新上传图片',
    '图片裁剪区域必须在 0 到 1 范围内，且宽高大于 0', '图片内存上限无效',
    '当前环境无法裁剪图片，请在 Obsidian 桌面端重试', '区域识图一次只能选择一张图片',
    '图片批次超过 DeepSeek 官方的 600 张或总计 64 MiB 上限',
    '同时发送至少 15 张图片时，DeepSeek 官方要求每张图片的单边不超过 4096 px；请减少图片或缩小尺寸'
  ]) {
    assert.equal(translate(source, 'zh'), source);
    assert.ok(!/[\u4e00-\u9fff]/.test(translate(source, 'en')), source);
  }
});
