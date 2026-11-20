const test = require('node:test');
const assert = require('node:assert/strict');
const {JSDOM} = require('jsdom');
const {transcribeAudio, synthesizeSpeech, speechChunks, encodeWav, validateWav, SpeechControls} = require('./src/speech');

function wav(duration = 0.1, sampleRate = 16000) {
  return encodeWav({sampleRate, getChannelData: () => new Float32Array(Math.round(duration * sampleRate)).fill(0.5)});
}
function signal() { return new AbortController().signal; }

test('ASR sends one authenticated WAV multipart and returns only text', async () => {
  let calls = 0;
  const result = await transcribeAudio(wav(), 'test-key', signal(), async (url, options) => {
    calls++;
    assert.equal(url, 'https://api.deepseek.com/v1/tools/asr');
    assert.equal(options.headers.Authorization, 'Bearer test-key');
    assert.match(options.headers['Content-Type'], /^multipart\/form-data; boundary=/);
    assert.ok(options.body.includes(Buffer.from('filename="speech.wav"')));
    assert.ok(options.body.includes(wav()));
    return Buffer.from('{"text":" Hello ","duration_ms":100}');
  });
  assert.equal(result, 'Hello'); assert.equal(calls, 1);
});

test('ASR refuses invalid format, oversize files and malformed response', async () => {
  await assert.rejects(transcribeAudio(Buffer.from('WebM'), 'key', signal()), /invalid/);
  await assert.rejects(transcribeAudio(Buffer.alloc(8 * 1024 * 1024 + 1), 'key', signal()), /8 MiB/);
  await assert.rejects(transcribeAudio(wav(), 'key', signal(), async () => Buffer.from('{}')), /invalid/);
  await assert.rejects(transcribeAudio(wav(), 'key', signal(), async () => Buffer.from('bad')), /invalid/);
});

test('speech authentication errors retain DeepSeek expiration metadata', async () => {
  const error = Object.assign(new Error('unauthorized'), {status: 401});
  await assert.rejects(transcribeAudio(wav(), 'key', signal(), async () => { throw error; }), value => value === error && value.authExpired && value.authService === 'deepseek');
});

test('PCM WAV encoder uses mono 16-bit 16 kHz and obeys duration limit', () => {
  const bytes = wav(1, 48000);
  assert.equal(bytes.readUInt32LE(24), 16000);
  assert.equal(bytes.readUInt16LE(22), 1);
  assert.equal(bytes.readUInt16LE(34), 16);
  assert.equal(bytes.length, 32044);
  assert.equal(bytes.readInt16LE(44), 16384);
  assert.throws(() => wav(121), /120 seconds/);
});

test('speech chunks preserve all text and respect billed Chinese characters', () => {
  const text = ('Hello 世界 😀\n'.repeat(2100)) + '\\'.repeat(14000);
  const chunks = speechChunks(text);
  assert.equal(chunks.join(''), text);
  assert.ok(chunks.length > 1);
  for (const chunk of chunks) {
    const billed = [...chunk].reduce((sum, value) => sum + (/\p{Script=Han}/u.test(value) ? 2 : 1), 0);
    assert.ok(billed <= 9000);
    assert.ok(Buffer.byteLength(JSON.stringify({text:chunk,voice_id:'stella',format:'wav',filter_markdown:true})) < 64 * 1024);
    assert.ok(!/[\uD800-\uDBFF]$/.test(chunk));
  }
});

test('TTS requests WAV with Markdown filtering and validates declared payload length', async () => {
  const expected = wav();
  const result = await synthesizeSpeech('Hello', 'key', signal(), async (url, options) => {
    assert.equal(url, 'https://api.deepseek.com/v1/tools/tts');
    assert.deepEqual(JSON.parse(options.body), {text:'Hello',voice_id:'stella',format:'wav',filter_markdown:true});
    return expected;
  });
  assert.deepEqual(result, expected);
  assert.throws(() => validateWav(expected.subarray(0, 50)), /incomplete/);
  await assert.rejects(synthesizeSpeech(' ', 'key', signal()), /invalid/);
});

test('speech network operations reject already aborted signals before invoking transport', async () => {
  const controller = new AbortController(); controller.abort();
  let called = false;
  const http = async () => { called = true; };
  await assert.rejects(transcribeAudio(wav(), 'key', controller.signal, http), {name:'AbortError'});
  await assert.rejects(synthesizeSpeech('Hello', 'key', controller.signal, http), {name:'AbortError'});
  assert.equal(called, false);
});

function fixture(options = {}) {
  const dom = new JSDOM('<textarea></textarea><div></div>');
  const win = dom.window;
  const parent = win.document.querySelector('div');
  parent.createEl = (tag, settings) => {
    const element = win.document.createElement(tag);
    for (const [key,value] of Object.entries(settings.attr || {})) element.setAttribute(key,value);
    parent.append(element); return element;
  };
  const notices = [];
  const view = {plugin:{keys:{deepseek:'key'},uiLanguage:'en'},session:{},input:win.document.querySelector('textarea'),notice:message=>notices.push(message)};
  const controller = new SpeechControls(view, {environment: win, ...options});
  return {dom, win, parent, notices, view, controller};
}

test('read-aloud cancellation aborts pending synthesis and restores its icon', async () => {
  let pendingSignal;
  const f = fixture({synthesize: async (_text,_key,signal) => {
    pendingSignal = signal;
    return await new Promise((_resolve,reject) => signal.addEventListener('abort', () => reject(Object.assign(new Error(), {name:'AbortError'}))));
  }});
  const button = f.controller.addReadAloudButton(f.parent, () => 'text', () => {});
  button.click();
  assert.equal(button.getAttribute('aria-label'), 'Stop reading');
  button.click();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(pendingSignal.aborted, true);
  assert.equal(button.getAttribute('aria-label'), 'Read aloud');
  assert.equal(f.notices.length, 0);
  f.controller.dispose(); f.dom.window.close();
});

test('speech buttons refresh language and disconnected row buttons are released', () => {
  const f = fixture();
  const button = f.controller.addReadAloudButton(f.parent, () => 'text', () => {});
  f.view.plugin.uiLanguage = 'zh-CN'; f.controller.refresh();
  assert.equal(button.title, '朗读');
  button.remove(); f.controller.refresh();
  assert.equal(f.controller.buttons.size, 0);
  f.controller.dispose(); f.dom.window.close();
});

test('late microphone permission grant after reset releases tracks without recording', async () => {
  const f = fixture();
  let resolveMedia, stopped = 0, constructed = 0;
  f.win.navigator.mediaDevices = {getUserMedia: () => new Promise(resolve => { resolveMedia = resolve; })};
  f.win.MediaRecorder = class { constructor() { constructed++; } };
  f.win.AudioContext = class {};
  f.controller.addDictationButton(f.parent, () => {});
  const pending = f.controller.record();
  f.controller.reset();
  resolveMedia({getTracks: () => [{stop: () => stopped++}]});
  await pending;
  assert.equal(stopped, 1); assert.equal(constructed, 0); assert.equal(f.notices.length, 0);
  f.controller.dispose(); f.dom.window.close();
});

test('a late recorder error after reset cannot cancel the next recording', async () => {
  const f = fixture();
  f.win.navigator.mediaDevices = {getUserMedia: async () => ({getTracks: () => []})};
  f.win.MediaRecorder = class {
    start() { this.state = 'recording'; }
    stop() { this.state = 'inactive'; }
  };
  f.win.AudioContext = class {};
  f.controller.addDictationButton(f.parent, () => {});
  try {
    await f.controller.record();
    const first = f.controller.recording.recorder;
    f.controller.reset();
    await f.controller.record();
    const second = f.controller.recording;
    first.onerror();
    assert.equal(f.controller.recording, second);
    assert.equal(second.recorder.state, 'recording');
    assert.equal(second.controller.signal.aborted, false);
    assert.equal(f.notices.length, 0);
  } finally {
    f.controller.dispose(); f.dom.window.close();
  }
});

test('transcription appends to current draft and never submits a conversation message', async () => {
  const f = fixture({transcribe:async () => 'dictated words'});
  f.controller.addDictationButton(f.parent, () => {});
  f.win.Blob = Blob;
  f.win.AudioContext = class {
    async decodeAudioData() { return {sampleRate:16000,getChannelData:()=>new Float32Array(160)}; }
    async close() {}
  };
  f.view.input.value = 'draft';
  let inputEvents = 0;
  f.view.input.addEventListener('input', () => inputEvents++);
  const job = {controller:new AbortController(),generation:0,session:f.view.session,chunks:[new Blob(['audio'])],recorder:{mimeType:'audio/webm'}};
  f.controller.recording = job;
  await f.controller.finishRecording(job, 'key');
  assert.equal(f.view.input.value, 'draft dictated words'); assert.equal(inputEvents, 1);
  assert.equal(f.controller.recording, null);
  f.controller.dispose(); f.dom.window.close();
});

test('transcription for a replaced conversation cannot enter its draft', async () => {
  let finishTranscription;
  const f = fixture({transcribe: () => new Promise(resolve => { finishTranscription = resolve; })});
  f.controller.addDictationButton(f.parent, () => {});
  f.win.Blob = Blob;
  f.win.AudioContext = class {
    async decodeAudioData() { return {sampleRate:16000,getChannelData:()=>new Float32Array(160)}; }
    async close() {}
  };
  const job = {controller:new AbortController(),generation:0,session:f.view.session,chunks:[new Blob(['audio'])],recorder:{mimeType:'audio/webm'}};
  f.controller.recording = job;
  const pending = f.controller.finishRecording(job, 'key');
  while (!finishTranscription) await new Promise(resolve => setImmediate(resolve));
  f.view.session = {}; f.controller.reset(); finishTranscription('old conversation');
  await pending;
  assert.equal(f.view.input.value, ''); assert.equal(f.notices.length, 0);
  f.controller.dispose(); f.dom.window.close();
});
