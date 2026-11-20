const { randomBytes } = require('node:crypto');
const { request, check } = require('./core');
const { isAuthenticationFailure } = require('./service-errors');

const API = 'https://api.deepseek.com/v1/tools/';
const MAX_AUDIO_BYTES = 8 * 1024 * 1024;
const MAX_RECORDING_MS = 120000;
const labels = {
  dictate: ['Voice input', '语音输入'],
  stopRecording: ['Finish recording', '结束录音'],
  recognizing: ['Transcribing… Click to cancel', '正在转写…点击取消'],
  speak: ['Read aloud', '朗读'],
  stop: ['Stop reading', '停止朗读'],
  microphone: ['Microphone recording is unavailable.', '无法使用麦克风录音。'],
  key: ['Enter your DeepSeek API key first.', '请先填写 DeepSeek 密钥。'],
  empty: ['No speech was recognized.', '未识别到语音。'],
  duration: ['Recordings may be at most 120 seconds.', '录音最长为 120 秒。'],
  size: ['Audio files may be at most 8 MiB.', '音频文件最大为 8 MiB。'],
  invalid: ['The speech service returned an invalid response.', '语音服务返回了无效结果。'],
  audio: ['The speech service returned incomplete audio.', '语音服务返回的音频不完整。']
};

function speechError(code) {
  const error = new Error(labels[code]?.[0] || code);
  error.speechCode = code;
  return error;
}

async function speechRequest(endpoint, key, options, http) {
  if (!key) throw speechError('key');
  try {
    return await http(API + endpoint, {...options, headers: {...options.headers, Authorization: `Bearer ${key}`}});
  } catch (error) {
    if (isAuthenticationFailure(error)) {
      error.authExpired = true;
      error.authService = 'deepseek';
    }
    throw error;
  }
}

async function transcribeAudio(wav, key, signal, http = request) {
  check(signal);
  const bytes = Buffer.from(wav);
  if (bytes.length > MAX_AUDIO_BYTES) throw speechError('size');
  if (bytes.length <= 44 || bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WAVE') throw speechError('invalid');
  const boundary = `sd-speech-${randomBytes(16).toString('hex')}`;
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="speech.wav"\r\nContent-Type: audio/wav\r\n\r\n`),
    bytes,
    Buffer.from(`\r\n--${boundary}--\r\n`)
  ]);
  const response = await speechRequest('asr', key, {method: 'POST', body, signal, headers: {'Content-Type': `multipart/form-data; boundary=${boundary}`}, maxBytes: 1024 * 1024, timeoutMs: 11 * 60 * 1000}, http);
  check(signal);
  let data;
  try { data = JSON.parse(response.toString('utf8')); } catch { throw speechError('invalid'); }
  if (typeof data.text !== 'string') throw speechError('invalid');
  return data.text.trim();
}

// Encode the left channel as PCM because Chromium records WebM, which ASR does not accept.
function encodeWav(audioBuffer) {
  const source = audioBuffer.getChannelData(0);
  if (!source.length || !Number.isFinite(audioBuffer.sampleRate) || audioBuffer.sampleRate <= 0) throw speechError('invalid');
  if (source.length / audioBuffer.sampleRate > MAX_RECORDING_MS / 1000 + 0.25) throw speechError('duration');
  const sampleRate = 16000;
  const count = Math.min(Math.floor(source.length * sampleRate / audioBuffer.sampleRate), sampleRate * MAX_RECORDING_MS / 1000);
  const bytes = Buffer.alloc(44 + count * 2);
  bytes.write('RIFF', 0); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8);
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(sampleRate, 24); bytes.writeUInt32LE(sampleRate * 2, 28);
  bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34); bytes.write('data', 36); bytes.writeUInt32LE(count * 2, 40);
  for (let index = 0; index < count; index++) {
    const position = index * audioBuffer.sampleRate / sampleRate;
    const left = Math.floor(position), fraction = position - left;
    const sample = Math.max(-1, Math.min(1, source[left] * (1 - fraction) + source[Math.min(left + 1, source.length - 1)] * fraction));
    bytes.writeInt16LE(Math.round(sample * (sample < 0 ? 32768 : 32767)), 44 + index * 2);
  }
  return bytes;
}

function speechChunks(text) {
  const chunks = [];
  let pending = '', billed = 0;
  for (const character of String(text)) {
    const cost = /\p{Script=Han}/u.test(character) ? 2 : 1;
    if (billed + cost > 9000) {
      const boundary = Math.max(pending.lastIndexOf('\n'), pending.lastIndexOf('. '), pending.lastIndexOf('。'));
      const split = boundary > pending.length / 2 ? boundary + 1 : pending.length;
      chunks.push(pending.slice(0, split));
      pending = pending.slice(split);
      billed = [...pending].reduce((total, value) => total + (/\p{Script=Han}/u.test(value) ? 2 : 1), 0);
    }
    pending += character;
    billed += cost;
  }
  if (pending.trim()) chunks.push(pending);
  return chunks;
}

function validateWav(bytes) {
  if (bytes.length < 44 || bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WAVE') throw speechError('audio');
  const advertised = bytes.readUInt32LE(4);
  // A streaming WAV may use an unknown-length sentinel in its RIFF header.
  if (advertised !== 0xffffffff && advertised + 8 > bytes.length) throw speechError('audio');
  let cursor = 12, hasData = false;
  while (cursor + 8 <= bytes.length) {
    const name = bytes.toString('ascii', cursor, cursor + 4), length = bytes.readUInt32LE(cursor + 4);
    if (name === 'data') {
      if (length !== 0xffffffff && cursor + 8 + length > bytes.length) throw speechError('audio');
      hasData = bytes.length > cursor + 8;
      break;
    }
    cursor += 8 + length + (length % 2);
  }
  if (!hasData) throw speechError('audio');
  return bytes;
}

async function synthesizeSpeech(text, key, signal, http = request) {
  check(signal);
  const body = JSON.stringify({text, voice_id: 'stella', format: 'wav', filter_markdown: true});
  if (!text.trim() || speechChunks(text).length !== 1 || Buffer.byteLength(body) > 64 * 1024) throw speechError('invalid');
  const bytes = await speechRequest('tts', key, {method: 'POST', body, signal, headers: {'Content-Type': 'application/json'}, maxBytes: 100 * 1024 * 1024, timeoutMs: 31 * 60 * 1000}, http);
  check(signal);
  return validateWav(Buffer.from(bytes));
}

class SpeechControls {
  constructor(view, options = {}) {
    this.view = view;
    this.environment = options.environment || view.input?.ownerDocument?.defaultView || globalThis;
    this.transcribe = options.transcribe || transcribeAudio;
    this.synthesize = options.synthesize || synthesizeSpeech;
    this.generation = 0;
    this.closed = false;
    this.buttons = new Set();
  }
  label(code) { return labels[code][this.view.plugin.uiLanguage === 'en' ? 0 : 1]; }
  report(error, key) {
    if (error.name === 'AbortError' || this.closed || this.view.closed) return;
    if (key === this.view.plugin.keys.deepseek) this.view.plugin.openExpiredKeyPage?.(error);
    this.view.notice(error.speechCode ? this.label(error.speechCode) : error.message);
  }
  setButton(button, code, icon) {
    button.title = this.label(code);
    button.setAttribute('aria-label', this.label(code));
    button.setAttribute('aria-pressed', String(code === 'stop' || code === 'stopRecording' || code === 'recognizing'));
    button.speechCode = code;
    button.speechIcon?.(button, icon);
  }
  button(parent, setIcon, code, icon) {
    const button = parent.createEl('button', {cls: 'sd-icon-button', attr: {type: 'button'}});
    button.speechIcon = setIcon;
    this.buttons.add(button);
    this.setButton(button, code, icon);
    return button;
  }
  refresh() {
    for (const button of this.buttons) {
      if (!button.isConnected) { this.buttons.delete(button); continue; }
      button.title = this.label(button.speechCode);
      button.setAttribute('aria-label', button.title);
    }
  }
  addDictationButton(parent, setIcon) {
    const button = this.button(parent, setIcon, 'dictate', 'mic');
    this.recordButton = button;
    button.addEventListener('click', () => {
      if (this.recording?.recorder?.state === 'recording') this.recording.recorder.stop();
      else if (this.recording) this.cancelRecording();
      else void this.record();
    });
    return button;
  }
  addReadAloudButton(parent, getText, setIcon) {
    const button = this.button(parent, setIcon, 'speak', 'volume-2');
    button.addEventListener('click', () => {
      if (this.playback?.button === button) this.stopPlayback();
      else void this.readAloud(getText(), button);
    });
    return button;
  }
  async record() {
    if (this.closed || this.recording) return;
    const key = this.view.plugin.keys.deepseek;
    if (!key) { this.report(speechError('key'), key); return; }
    const env = this.environment;
    if (!env.navigator?.mediaDevices?.getUserMedia || !env.MediaRecorder || !env.AudioContext) { this.report(speechError('microphone'), key); return; }
    const job = {controller: new AbortController(), generation: this.generation, session: this.view.session, chunks: []};
    this.recording = job;
    this.setButton(this.recordButton, 'recognizing', 'square');
    try {
      job.stream = await env.navigator.mediaDevices.getUserMedia({audio: true});
      check(job.controller.signal);
      job.recorder = new env.MediaRecorder(job.stream);
      job.recorder.ondataavailable = event => { if (event.data.size && !job.controller.signal.aborted) job.chunks.push(event.data); };
      job.recorder.onerror = () => {
        if (this.recording !== job) return;
        this.report(speechError('microphone'), key);
        this.cancelRecording();
      };
      job.recorder.onstop = () => { void this.finishRecording(job, key); };
      job.recorder.start();
      this.setButton(this.recordButton, 'stopRecording', 'square');
      job.timer = setTimeout(() => { if (job.recorder.state === 'recording') job.recorder.stop(); }, MAX_RECORDING_MS);
    } catch (error) {
      job.stream?.getTracks().forEach(track => track.stop());
      if (!job.controller.signal.aborted) this.report(error, key);
      if (this.recording === job) this.cancelRecording();
    }
  }
  async finishRecording(job, key) {
    clearTimeout(job.timer);
    job.stream?.getTracks().forEach(track => track.stop());
    if (this.recording !== job || job.controller.signal.aborted) return;
    this.setButton(this.recordButton, 'recognizing', 'square');
    try {
      const blob = new this.environment.Blob(job.chunks, {type: job.recorder.mimeType});
      job.chunks = [];
      job.audioContext = new this.environment.AudioContext();
      const decoded = await job.audioContext.decodeAudioData(await blob.arrayBuffer());
      check(job.controller.signal);
      const wav = encodeWav(decoded);
      await job.audioContext.close(); job.audioContext = null;
      const text = await this.transcribe(wav, key, job.controller.signal);
      check(job.controller.signal);
      if (job.generation !== this.generation || job.session !== this.view.session || this.closed || this.view.closed) return;
      if (!text) { this.view.notice(this.label('empty')); return; }
      const input = this.view.input;
      input.value += (input.value && !/\s$/.test(input.value) ? ' ' : '') + text;
      input.dispatchEvent(new this.environment.Event('input', {bubbles: true}));
      this.view.restoreComposerFocus?.(this.recordButton);
    } catch (error) { if (!job.controller.signal.aborted) this.report(error, key); }
    finally {
      await job.audioContext?.close().catch(() => {});
      if (this.recording === job) { this.recording = null; this.setButton(this.recordButton, 'dictate', 'mic'); }
    }
  }
  cancelRecording() {
    const job = this.recording;
    this.recording = null;
    if (job) {
      clearTimeout(job.timer);
      job.controller.abort();
      job.stream?.getTracks().forEach(track => track.stop());
      if (job.recorder?.state === 'recording') job.recorder.stop();
      job.chunks = [];
      void job.audioContext?.close().catch(() => {});
    }
    if (this.recordButton) this.setButton(this.recordButton, 'dictate', 'mic');
  }
  async readAloud(text, button) {
    this.stopPlayback();
    if (this.closed || !text?.trim()) return;
    const key = this.view.plugin.keys.deepseek;
    if (!key) { this.report(speechError('key'), key); return; }
    const job = {controller: new AbortController(), button};
    this.playback = job;
    this.setButton(button, 'stop', 'square');
    try {
      for (const chunk of speechChunks(text)) {
        const bytes = await this.synthesize(chunk, key, job.controller.signal);
        check(job.controller.signal);
        await this.playAudio(bytes, job);
      }
    } catch (error) { if (!job.controller.signal.aborted) this.report(error, key); }
    finally { if (this.playback === job) this.stopPlayback(); }
  }
  playAudio(bytes, job) {
    const env = this.environment;
    job.url = env.URL.createObjectURL(new env.Blob([bytes], {type: 'audio/wav'}));
    job.audio = new env.Audio(job.url);
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = error => {
        if (settled) return;
        settled = true;
        job.controller.signal.removeEventListener('abort', abort);
        job.audio.onended = null; job.audio.onerror = null;
        job.audio.pause(); job.audio.removeAttribute('src'); job.audio.load();
        env.URL.revokeObjectURL(job.url); job.url = null;
        if (error) reject(error); else resolve();
      };
      const abort = () => { const error = new Error('Stopped'); error.name = 'AbortError'; finish(error); };
      job.audio.onended = () => finish();
      job.audio.onerror = () => finish(speechError('audio'));
      job.controller.signal.addEventListener('abort', abort, {once: true});
      job.audio.play().catch(finish);
    });
  }
  stopPlayback() {
    const job = this.playback;
    this.playback = null;
    if (!job) return;
    job.controller.abort();
    this.setButton(job.button, 'speak', 'volume-2');
  }
  discardReplyControls() {
    this.stopPlayback();
    for (const button of this.buttons) if (button !== this.recordButton) this.buttons.delete(button);
  }
  reset() { this.generation++; this.cancelRecording(); this.stopPlayback(); this.refresh(); }
  dispose() { this.closed = true; this.reset(); this.buttons.clear(); }
}

module.exports = {transcribeAudio, synthesizeSpeech, speechChunks, encodeWav, validateWav, SpeechControls};
