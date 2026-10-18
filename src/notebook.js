const { createHash, randomUUID } = require('node:crypto');
const path = require('node:path');
const sync = require('y-protocols/sync.js');
const encoding = require('lib0/encoding');
const decoding = require('lib0/decoding');
const { WebSocket } = require('ws');
const { YNotebook } = require('@jupyter/ydoc');
const { buildSystemPrompt } = require('./prompts');
const { sanitizeReferenceText } = require('./text-safety');

const NOTEBOOK_SYSTEM_PROMPT = buildSystemPrompt({ webEnabled: true, notebookMode: true, notebookEnabled: true });

const joinSource = value => Array.isArray(value) ? value.join('') : String(value || '');
const safeSource = value => sanitizeReferenceText(joinSource(value));
const hash = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
const executionOutputsHash = cell => hash({ outputs: cell.outputs || [], execution_count: cell.execution_count ?? null });
const cellId = (cell, index) => typeof cell?.id === 'string' && cell.id ? cell.id : `index-${index}`;
const textData = data => {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return {};
  const clean = {};
  for (const [mime, value] of Object.entries(data)) {
    if (/^image\//i.test(mime) || /svg/i.test(mime) || /widget/i.test(mime)) continue;
    const text = joinSource(value);
    if (text.length > 200000 || /(?:data:image\/|[A-Za-z0-9+/]{400,}={0,2})/i.test(text)) continue;
    clean[mime] = text;
  }
  return clean;
};
function safeOutputs(outputs) {
  if (!Array.isArray(outputs)) return [];
  return outputs.map(output => {
    if (!output || typeof output !== 'object') return null;
    if (output.output_type === 'stream') return { output_type: 'stream', name: safeSource(output.name), text: safeSource(output.text).slice(0, 200000) };
    if (output.output_type === 'error') return { output_type: 'error', ename: safeSource(output.ename), evalue: safeSource(output.evalue), traceback: safeSource(Array.isArray(output.traceback) ? output.traceback.map(String).join('\n') : output.traceback).slice(0, 200000) };
    if (output.output_type === 'execute_result' || output.output_type === 'display_data') return { output_type: output.output_type, data: textData(output.data) };
    return null;
  }).filter(Boolean);
}
function safeNotebook(notebook) {
  const cells = Array.isArray(notebook?.cells) ? notebook.cells : [], hashedCells = [], safeCells = [];
  for (const [index, cell] of cells.entries()) {
    const id = cellId(cell, index), source = joinSource(cell.source), outputs = safeOutputs(cell.outputs);
    hashedCells.push({ id, type: cell.cell_type, source, outputs });
    safeCells.push({ cellId: id, index, cellType: cell.cell_type || 'raw', source: safeSource(source),
      executionCount: Number.isInteger(cell.execution_count) ? cell.execution_count : null, outputs });
  }
  return { notebookHash: hash(hashedCells), cells: safeCells };
}
function notebookHash(notebook) {
  const cells = Array.isArray(notebook?.cells) ? notebook.cells : [];
  return hash(cells.map((cell, index) => ({ id: cellId(cell, index), type: cell.cell_type, source: joinSource(cell.source), outputs: safeOutputs(cell.outputs) })));
}
function snapshotFromSafe(safe) {
  return { hash: safe.notebookHash, cells: Object.fromEntries(safe.cells.map(cell => [cell.cellId, {
    hash: hash({ index: cell.index, cellType: cell.cellType, source: cell.source, outputs: cell.outputs }),
    index: cell.index, cellType: cell.cellType, source: cell.source, sourceHash: hash(cell.source), outputsHash: hash(cell.outputs)
  }])) };
}
function notebookSnapshot(notebook) { return snapshotFromSafe(safeNotebook(notebook)); }
function sourceLinePatch(before, after) {
  const oldLines = before.split('\n'), newLines = after.split('\n');
  let start = 0, oldEnd = oldLines.length, newEnd = newLines.length;
  while (start < oldEnd && start < newEnd && oldLines[start] === newLines[start]) start++;
  while (oldEnd > start && newEnd > start && oldLines[oldEnd - 1] === newLines[newEnd - 1]) { oldEnd--; newEnd--; }
  return { startLine: start + 1, deleteLines: oldEnd - start, insertLines: newLines.slice(start, newEnd) };
}
function notebookDelta(notebook, previous) {
  const safe = safeNotebook(notebook), current = snapshotFromSafe(safe), changed = [], removed = [];
  for (const cell of safe.cells) {
    const old = previous?.cells?.[cell.cellId], now = current.cells[cell.cellId];
    if (!old || typeof old.sourceHash !== 'string' || typeof old.outputsHash !== 'string') { changed.push(cell); continue; }
    const sourceChanged = old.sourceHash !== now.sourceHash, outputsChanged = old.outputsHash !== now.outputsHash;
    if (!sourceChanged && !outputsChanged && old.index === cell.index && old.cellType === cell.cellType) continue;
    const update = { cellId: cell.cellId, index: cell.index, cellType: cell.cellType };
    if (sourceChanged) {
      const patch = typeof old.source === 'string' ? sourceLinePatch(old.source, cell.source) : null;
      if (patch && JSON.stringify(patch).length < JSON.stringify(cell.source).length) update.sourcePatch = patch;
      else update.source = cell.source;
    }
    if (outputsChanged) { update.outputs = cell.outputs; update.executionCount = cell.executionCount; }
    changed.push(update);
  }
  for (const id of Object.keys(previous?.cells || {})) if (!current.cells[id]) removed.push(id);
  return { baseHash: previous?.hash || null, currentHash: current.hash, changed, removed, snapshot: current };
}
function notebookContext(delta) {
  return `\n\n[Notebook delta; images, attachments, base64, and widgets were removed locally]\n${JSON.stringify({ previousHash: delta.baseHash, currentHash: delta.currentHash, changed: delta.changed, removed: delta.removed })}`;
}
function notebookCurrentHash(text) {
  const marker = '[Notebook delta';
  const start = String(text || '').lastIndexOf(marker);
  if (start < 0) return '';
  const line = String(text).slice(start).split('\n')[1];
  try { const hash = JSON.parse(line).currentHash; return /^[0-9a-f]{64}$/i.test(hash) ? hash : ''; }
  catch { return ''; }
}
function normalizePatch(value, fallbackHash = '') {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !Array.isArray(value.operations)) throw Error('Notebook 补丁缺少 operations');
  const baseHash = typeof value.baseHash === 'string' && value.baseHash ? value.baseHash : fallbackHash;
  if (!/^[0-9a-f]{64}$/i.test(baseHash)) throw Error('Notebook 补丁缺少当前哈希；请本轮附带 Notebook 增量后重新生成');
  const operations = value.operations.map(op => {
    const type = op?.type || op?.op;
    if (!op || typeof op !== 'object' || Array.isArray(op)) throw Error('Notebook 补丁包含不支持的操作');
    if (op.type && op.op && op.type !== op.op) throw Error('Notebook 补丁操作类型冲突');
    if (!['set_source', 'replace_text', 'insert_cell', 'delete_cell', 'source_chunk'].includes(type)) throw Error('Notebook 补丁包含不支持的操作');
    if ((op.cellId != null && typeof op.cellId !== 'string') || (op.index != null && (!Number.isSafeInteger(op.index) || op.index < 0)) || (op.sourceHash != null && (typeof op.sourceHash !== 'string' || !/^[0-9a-f]{64}$/i.test(op.sourceHash)))) throw Error('Notebook 补丁目标或源码哈希无效');
    if (type === 'set_source' && typeof op.source !== 'string') throw Error('set_source 缺少源码');
    if (type === 'replace_text' && (typeof op.oldText !== 'string' || !op.oldText || typeof op.newText !== 'string')) throw Error('replace_text 需要非空 oldText 和字符串 newText');
    if (type === 'insert_cell' && (!['code', 'markdown', 'raw'].includes(op.cellType) || typeof op.source !== 'string')) throw Error('insert_cell 格式无效');
    if (type === 'source_chunk' && (typeof op.chunkId !== 'string' || !/^[A-Za-z0-9_.-]{1,128}$/.test(op.chunkId) || !Number.isSafeInteger(op.part) || op.part < 0 || (op.totalParts != null && (!Number.isSafeInteger(op.totalParts) || op.totalParts < 1 || op.part >= op.totalParts)) || (op.final != null && typeof op.final !== 'boolean') || typeof op.source !== 'string')) throw Error('Notebook 源码分块格式无效');
    return { ...op, type };
  });
  return { baseHash, operations, ...(typeof value.done === 'boolean' ? { done: value.done } : {}) };
}
// Locate the JSON object's end while ignoring braces and fences inside source strings.
function jsonObjectAt(text, start) {
  while (/\s/.test(text[start] || '') && start < text.length) start++;
  if (text[start] !== '{') return '';
  let depth = 0, quoted = false, escaped = false;
  for (let i = start; i < text.length; i++) {
    const char = text[i];
    if (quoted) { if (escaped) escaped = false; else if (char === '\\') escaped = true; else if (char === '"') quoted = false; continue; }
    if (char === '"') quoted = true;
    else if (char === '{' || char === '[') depth++;
    else if (char === '}' || char === ']') { depth--; if (depth === 0) return text.slice(start, i + 1); }
  }
  return '';
}
function parsePatch(text, fallbackHash = '') {
  if (text && typeof text === 'object') return normalizePatch(text, fallbackHash);
  const source = String(text || ''), trimmed = source.trim();
  if (trimmed.startsWith('{')) {
    try {
      const value = JSON.parse(trimmed);
      if (value && Array.isArray(value.operations)) return normalizePatch(value, fallbackHash);
    } catch (error) { if (!(error instanceof SyntaxError)) throw error; if (/"(?:operations|baseHash)"/.test(trimmed)) throw Error('Notebook 补丁 JSON 无法解析'); }
  }
  for (const block of source.matchAll(/(?:^|\n)[ \t]*(`{3,}|~{3,})(notebook-patch|json)(?=[ \t\r\n{])[ \t]*(?:\r?\n)?/gi)) {
    const explicit = block[2].toLowerCase() === 'notebook-patch', start = block.index + block[0].length;
    let value;
    try {
      const json = jsonObjectAt(source, start);
      if (!json) throw Error('incomplete JSON');
      const closing = source.slice(start + source.slice(start).indexOf(json) + json.length);
      if (!new RegExp('^[ \\t]*(?:\\r?\\n[ \\t]*)?' + block[1][0] + '{' + block[1].length + ',}[ \\t]*(?:\\r?\\n|$)').test(closing)) throw Error('missing closing fence');
      value = JSON.parse(json);
    } catch { if (explicit) throw Error('Notebook 补丁 JSON 无法解析'); else continue; }
    if (!value || !Array.isArray(value.operations)) { if (explicit) throw Error('Notebook 补丁缺少 operations'); else continue; }
    return normalizePatch(value, fallbackHash);
  }
  return null;
}
function validatePatch(notebook, value) {
  if (value?.baseHash !== notebookHash(notebook)) throw Error('Notebook 已在别处发生变化，请重新生成或检查补丁');
  const patch = normalizePatch(value), workspace = new NotebookPatchWorkspace(notebook);
  const operations = patch.operations.map(op => workspace.apply(op));
  return { patch: { baseHash: patch.baseHash, operations }, notebook: workspace.notebook };
}
class NotebookPatchWorkspace {
  constructor(notebook, { copy = true } = {}) {
    this.notebook = copy ? JSON.parse(JSON.stringify(notebook)) : notebook;
    if (!Array.isArray(this.notebook.cells)) this.notebook.cells = [];
    this.indices = null;
  }
  indexForId(id) {
    if (!this.indices) {
      this.indices = new Map();
      this.notebook.cells.forEach((cell, index) => { const id = cellId(cell, index); if (!this.indices.has(id)) this.indices.set(id, index); });
    }
    return this.indices.get(id) ?? -1;
  }
  apply(value) {
    // The workspace owns its virtual copy; each operation retains the same
    // validation without hashing and cloning every unaffected cell again.
    const op = normalizePatch({ baseHash: '0'.repeat(64), operations: [value] }).operations[0], next = this.notebook;
    if (op.type === 'source_chunk') throw Error('Notebook 源码分块尚未收齐');
    if (op.type === 'insert_cell') {
      const at = op.index == null ? next.cells.length : op.index;
      if (!Number.isInteger(at) || at < 0 || at > next.cells.length) throw Error('插入单元格的位置无效');
      const id = op.cellId == null ? randomUUID() : op.cellId;
      if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(id) || this.indexForId(id) >= 0) throw Error('新单元格 ID 无效或重复');
      const cell = { cell_type: op.cellType, source: op.source, metadata: {}, ...(op.cellType === 'code' ? { outputs: [], execution_count: null } : {}) };
      if (!(next.nbformat === 4 && Number.isInteger(next.nbformat_minor) && next.nbformat_minor <= 4)) cell.id = id;
      next.cells.splice(at, 0, cell); this.indices = null; return { ...op, index: at, cellId: id };
    }
    const index = typeof op.cellId === 'string' && op.cellId ? this.indexForId(op.cellId) : Number.isInteger(op.index) && op.index >= 0 && op.index < next.cells.length ? op.index : -1;
    if (index < 0) throw Error(op.type === 'delete_cell' ? '找不到要删除的单元格' : '找不到要修改的单元格');
    const source = joinSource(next.cells[index].source);
    if (op.sourceHash != null && op.sourceHash !== hash(source)) throw Error('单元格源码哈希不匹配，请重新生成补丁');
    if (op.type === 'delete_cell') { next.cells.splice(index, 1); this.indices = null; }
    else if (op.type === 'set_source') next.cells[index].source = op.source;
    else {
      const first = source.indexOf(op.oldText);
      if (first < 0 || source.indexOf(op.oldText, first + 1) !== -1) throw Error('replace_text 的 oldText 必须在目标单元格中恰好匹配一次');
      next.cells[index].source = source.slice(0, first) + op.newText + source.slice(first + op.oldText.length);
    }
    return { ...op, index };
  }
}
function taskOperation(op) {
  if (op.type && op.op && op.type !== op.op) throw Error('Notebook 补丁操作类型冲突');
  const result = { type: op.type };
  if (op.type !== 'source_chunk') for (const key of ['index', 'cellId', 'sourceHash']) if (op[key] != null) result[key] = op[key];
  if (['set_source', 'insert_cell', 'source_chunk'].includes(op.type) && op.source != null) result.source = op.source;
  if (op.type === 'insert_cell') result.cellType = op.cellType;
  if (op.type === 'replace_text') { result.oldText = op.oldText; result.newText = op.newText; }
  if (op.type === 'source_chunk') {
    result.chunkId = op.chunkId; result.part = op.part; result.totalParts = op.totalParts ?? null; result.final = op.final === true;
    if (op.operation != null) result.operation = taskOperation({ ...op.operation, type: op.operation.type || op.operation.op });
  }
  return result;
}
function taskBatch(value) {
  const batch = normalizePatch(value);
  return { baseHash: batch.baseHash, operations: batch.operations.map(taskOperation), done: batch.done === true };
}
function taskNotebook(value) {
  if (!value || !Array.isArray(value.cells)) throw Error('Notebook 暂存任务无效');
  return {
    ...(Number.isInteger(value.nbformat) ? { nbformat: value.nbformat } : {}),
    ...(Number.isInteger(value.nbformat_minor) ? { nbformat_minor: value.nbformat_minor } : {}),
    metadata: {},
    cells: value.cells.map(cell => ({
      ...(typeof cell.id === 'string' ? { id: cell.id } : {}), cell_type: ['code', 'markdown', 'raw'].includes(cell.cell_type) ? cell.cell_type : 'raw', source: safeSource(cell.source), metadata: {},
      ...(cell.cell_type === 'code' ? { execution_count: Number.isInteger(cell.execution_count) ? cell.execution_count : null, outputs: safeOutputs(cell.outputs) } : {})
    }))
  };
}
function safeTaskText(value) {
  if (typeof value === 'string') return safeSource(value) === value;
  if (Array.isArray(value)) return value.every(safeTaskText);
  if (value && typeof value === 'object') return Object.values(value).every(safeTaskText);
  return value == null || typeof value === 'number' || typeof value === 'boolean';
}
class NotebookEditBuffer {
  constructor(notebook, { taskId = randomUUID() } = {}) {
    if (typeof taskId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(taskId)) throw Error('Notebook 暂存任务 ID 无效');
    this.taskId = taskId; this.revision = 0; this.progress = 0;
    this.baseNotebook = JSON.parse(JSON.stringify(notebook)); this.notebook = JSON.parse(JSON.stringify(notebook)); this.baseHash = notebookHash(notebook); this.operations = []; this.chunk = null; this._done = false; this._started = false; this.chunkIds = new Set();
    this.baseMetadataHashes = (this.baseNotebook.cells || []).map(cell => hash(cell.metadata || {}));
    this.baseAttachmentHashes = (this.baseNotebook.cells || []).map(cell => hash(cell.attachments || {}));
    this.batches = []; this.acceptedBatches = new Set(); this.acceptedParts = new Map();
  }
  get currentHash() { return notebookHash(this.notebook); }
  get done() { return this._done; }
  snapshot() { return JSON.parse(JSON.stringify(this.notebook)); }
  read() { return this.snapshot(); }
  status() {
    const chunkCharacters = this.chunk?.parts.reduce((sum, part) => sum + part.length, 0) || 0;
    return { taskId: this.taskId, revision: this.revision, progress: this.progress, baseHash: this.baseHash, currentHash: this.currentHash,
      completedOperations: this.operations.length, stagedCharacters: this.operations.reduce((sum, op) => sum + (op.source?.length || op.newText?.length || 0), 0) + chunkCharacters,
      pendingChunks: this.chunk ? this.chunk.totalParts == null ? 1 : this.chunk.totalParts - this.chunk.parts.length : 0, started: this._started, done: this.done,
      ...(this.chunk ? { chunkId: this.chunk.chunkId, nextPart: this.chunk.parts.length, totalParts: this.chunk.totalParts, receivedCharacters: chunkCharacters } : {}) };
  }
  readPending({ offset = 0, limit = 12000 } = {}) {
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 12000) throw Error('Notebook 暂存源码读取范围无效');
    const source = safeSource(this.chunk?.parts.join('') || '');
    const end = Math.min(source.length, offset + limit);
    return { ...this.status(), pending: !!this.chunk, ...(this.chunk ? { operation: taskOperation(this.chunk.operation) } : {}), offset, totalCharacters: source.length, totalLength: source.length, nextOffset: end, source: source.slice(offset, end), hasMore: end < source.length };
  }
  stage(value) {
    const batch = taskBatch(value), fingerprint = hash(batch);
    if (this.acceptedBatches.has(fingerprint)) return { ...this.status(), replayed: true };
    const duplicateChunks = batch.operations.length > 0 && batch.operations.every(op => op.type === 'source_chunk' && this.acceptedParts.get(`${op.chunkId}:${op.part}`) === hash(op));
    if (duplicateChunks && (!batch.done || this.done)) return { ...this.status(), replayed: true };
    if (this.done) throw Error('Notebook 修改批次已经完成');
    if (batch.baseHash !== this.currentHash) throw Error('Notebook 已在别处发生变化，请重新生成或检查补丁');
    let virtual = this.notebook, workspace = null, pending = this.chunk ? { ...this.chunk, parts: [...this.chunk.parts] } : null;
    const operations = [], ids = new Set(this.chunkIds), parts = new Map(this.acceptedParts);
    let acceptedProgress = 0;
    for (let ordinal = 0; ordinal < batch.operations.length; ordinal++) {
      const op = batch.operations[ordinal];
      let complete = op;
      const insertionId = () => hash(`${this.taskId}:${this.revision}:${ordinal}`).slice(0, 32);
      if (op.type === 'source_chunk') {
        const partKey = `${op.chunkId}:${op.part}`, previous = parts.get(partKey), partHash = hash(op);
        if (previous) { if (previous !== partHash) throw Error('Notebook 源码分块重复内容不一致'); continue; }
        if (!pending) {
          if (op.part !== 0 || ids.has(op.chunkId) || !['insert_cell', 'set_source'].includes(op.operation?.type)) throw Error('Notebook 源码分块顺序或元数据不一致；必须从插入或修改操作第 0 块开始');
          const initial = { ...op.operation, source: '' };
          if (initial.type === 'insert_cell' && initial.cellId == null) initial.cellId = insertionId();
          const checked = new NotebookPatchWorkspace(virtual).apply(initial);
          pending = { chunkId: op.chunkId, totalParts: op.totalParts, operation: checked, parts: [] }; ids.add(op.chunkId);
        }
        if (op.chunkId !== pending.chunkId || op.totalParts !== pending.totalParts || op.part !== pending.parts.length || (op.part > 0 && op.operation != null) || (op.final && op.totalParts != null && op.part !== op.totalParts - 1)) throw Error('Notebook 源码分块顺序或元数据不一致');
        pending.parts.push(op.source); parts.set(partKey, partHash); acceptedProgress += op.source.length + 1;
        if (!op.final && (pending.totalParts == null || pending.parts.length < pending.totalParts)) continue;
        complete = { ...pending.operation, source: pending.parts.join('') }; pending = null;
      } else {
        if (pending) throw Error('请先收齐当前单元格的源码分块');
        if (op.type === 'insert_cell' && op.cellId == null) complete = { ...op, cellId: insertionId() };
        acceptedProgress += (op.source?.length || op.newText?.length || 0) + 1;
      }
      workspace ||= new NotebookPatchWorkspace(virtual);
      operations.push(workspace.apply(complete)); virtual = workspace.notebook;
    }
    if (batch.done && pending) throw Error('Notebook 源码分块尚未收齐');
    if (acceptedProgress === 0 && !batch.done && batch.operations.length) return { ...this.status(), replayed: true };
    this.notebook = virtual; this.operations.push(...operations); this.chunk = pending; this.chunkIds = ids; this.acceptedParts = parts; this._done = batch.done === true; this._started = true;
    this.batches.push(batch); this.acceptedBatches.add(fingerprint); this.revision++; this.progress += acceptedProgress + (batch.done ? 1 : 0);
    return this.status();
  }
  exportState() {
    const baseNotebook = taskNotebook(this.baseNotebook);
    if (notebookHash(baseNotebook) !== this.baseHash || !safeTaskText(baseNotebook) || !safeTaskText(this.batches)) return null;
    const value = JSON.parse(JSON.stringify({ version: 1, taskId: this.taskId, baseHash: this.baseHash, currentHash: this.currentHash, revision: this.revision, progress: this.progress, baseNotebook,
      ...(Array.isArray(this.baseMetadataHashes) ? { baseMetadataHashes: this.baseMetadataHashes } : {}),
      ...(Array.isArray(this.baseAttachmentHashes) ? { baseAttachmentHashes: this.baseAttachmentHashes } : {}), batches: this.batches }));
    return { ...value, stateHash: hash(value) };
  }
  static restore(state) {
    if (!state || state.version !== 1 || !Array.isArray(state.batches) || !Number.isSafeInteger(state.revision) || state.revision !== state.batches.length || !Number.isSafeInteger(state.progress) || state.progress < 0) throw Error('Notebook 暂存任务无效');
    const baseNotebook = taskNotebook(state.baseNotebook);
    const hasMetadataHashes = Object.prototype.hasOwnProperty.call(state, 'baseMetadataHashes');
    const hasAttachmentHashes = Object.prototype.hasOwnProperty.call(state, 'baseAttachmentHashes');
    if (hasMetadataHashes && (!Array.isArray(state.baseMetadataHashes) || state.baseMetadataHashes.length !== baseNotebook.cells.length || !state.baseMetadataHashes.every(value => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value)))) throw Error('Notebook 暂存任务校验失败');
    if (hasAttachmentHashes && (!Array.isArray(state.baseAttachmentHashes) || state.baseAttachmentHashes.length !== baseNotebook.cells.length || !state.baseAttachmentHashes.every(value => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value)))) throw Error('Notebook 暂存任务校验失败');
    const value = { version: 1, taskId: state.taskId, baseHash: state.baseHash, currentHash: state.currentHash, revision: state.revision, progress: state.progress, baseNotebook,
      ...(hasMetadataHashes ? { baseMetadataHashes: state.baseMetadataHashes } : {}),
      ...(hasAttachmentHashes ? { baseAttachmentHashes: state.baseAttachmentHashes } : {}), batches: state.batches };
    if (!safeTaskText(value) || JSON.stringify(baseNotebook) !== JSON.stringify(state.baseNotebook) || hash(value) !== state.stateHash || notebookHash(baseNotebook) !== state.baseHash) throw Error('Notebook 暂存任务校验失败');
    const restored = new NotebookEditBuffer(baseNotebook, { taskId: state.taskId });
    restored.baseMetadataHashes = hasMetadataHashes ? [...state.baseMetadataHashes] : null;
    restored.baseAttachmentHashes = hasAttachmentHashes ? [...state.baseAttachmentHashes] : null;
    for (const batch of state.batches) {
      if (JSON.stringify(taskBatch(batch)) !== JSON.stringify(batch)) throw Error('Notebook 暂存任务校验失败');
      restored.stage(batch);
    }
    if (restored.revision !== state.revision || restored.progress !== state.progress || restored.currentHash !== state.currentHash) throw Error('Notebook 暂存任务校验失败');
    return restored;
  }
  result() {
    if (!this.done || this.chunk) throw Error('Notebook 修改批次尚未完成');
    return JSON.parse(JSON.stringify({ baseHash: this.baseHash, operations: this.operations }));
  }
}
function describePatch(patch, language = 'zh') {
  return patch.operations.map((op, index) => {
    if (language === 'en') {
      if (op.type === 'set_source') return `${index + 1}. Update cell ${op.cellId || `#${op.index}`} (${op.source.length} characters)`;
      if (op.type === 'replace_text') return `${index + 1}. Replace text in cell ${op.cellId || `#${op.index}`} (${op.oldText.length} → ${op.newText.length} characters)`;
      if (op.type === 'insert_cell') return `${index + 1}. Insert a ${op.cellType} cell ${op.index == null ? 'at the end' : `at index ${op.index}`} (${op.source.length} characters)`;
      if (op.type === 'source_chunk') return `${index + 1}. Collect source chunk ${op.part + 1}/${op.totalParts}`;
      return `${index + 1}. Delete cell ${op.cellId || `#${op.index}`}`;
    }
    if (op.type === 'set_source') return `${index + 1}. 修改单元格 ${op.cellId || `#${op.index}`}（${op.source.length} 字符）`;
    if (op.type === 'replace_text') return `${index + 1}. 替换单元格 ${op.cellId || `#${op.index}`} 中的文本（${op.oldText.length} → ${op.newText.length} 字符）`;
    if (op.type === 'insert_cell') return `${index + 1}. 在 ${op.index ?? '末尾'} 插入 ${op.cellType} 单元格（${op.source.length} 字符）`;
    if (op.type === 'source_chunk') return `${index + 1}. 收集源码分块 ${op.part + 1}/${op.totalParts}`;
    return `${index + 1}. 删除单元格 ${op.cellId || `#${op.index}`}`;
  }).join('\n');
}
function normalizeBaseUrl(value) {
  const url = new URL(String(value || '').trim());
  if (!/^https?:$/.test(url.protocol)) throw Error('Jupyter 地址必须使用 http 或 https');
  url.hash = ''; url.search = ''; url.pathname = url.pathname.replace(/\/(?:lab|tree)\/?$/, '/').replace(/\/+$/, '');
  return url.toString().replace(/\/$/, '');
}
function encodeNotebookPath(value) {
  const normalized = String(value || '').trim().replace(/\\/g, '/');
  if (path.win32.isAbsolute(normalized) || path.posix.isAbsolute(normalized) || /^[A-Za-z]:/.test(normalized)) throw Error('Notebook 路径要相对于 Jupyter 根目录填写，例如 Untitled.ipynb；不要填写 C:\\... 绝对路径');
  if (!normalized || !/\.ipynb$/i.test(normalized) || normalized.split('/').some(part => !part || part === '.' || part === '..')) throw Error('Notebook 路径必须是 Jupyter 根目录内的 .ipynb 相对路径');
  return normalized.split('/').map(encodeURIComponent).join('/');
}
const jupyterClosed = () => Object.assign(Error('Jupyter RTC 已断开，请重新连接'), { name: 'AbortError', code: 'JUPYTER_CLOSED' });
const abortReason = signal => signal?.reason instanceof Error ? signal.reason : jupyterClosed();
function abortable(value, signal) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback, result) => { if (settled) return; settled = true; signal?.removeEventListener('abort', cancel); callback(result); };
    const cancel = () => finish(reject, abortReason(signal));
    signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted) cancel();
    Promise.resolve(value).then(result => finish(resolve, result), error => finish(reject, error));
  });
}
function requestUrlFetch(requestUrl) {
  return async (url, options = {}) => {
    if (options.signal?.aborted) throw abortReason(options.signal);
    const response = await abortable(Promise.resolve().then(() => {
      if (options.signal?.aborted) throw abortReason(options.signal);
      return requestUrl({ url, method: options.method || 'GET', headers: options.headers || {}, ...(options.body == null ? {} : { body: options.body }), throw: false });
    }), options.signal);
    return { ok: response.status >= 200 && response.status < 300, status: response.status, json: async () => { if (options.signal?.aborted) throw abortReason(options.signal); return response.json; } };
  };
}
class YSocket {
  constructor({ url, token, roomId, sessionId, notebook = new YNotebook(), timeout = 15000, signal, onClose = () => {} }) {
    this.notebook = notebook; this.closed = false; this.synced = false; this.signal = signal; this.onClose = onClose;
    const wsBase = url.replace(/^http/, 'ws');
    const query = new URLSearchParams({ sessionId, ...(token ? { token } : {}) });
    this.url = `${wsBase}/api/collaboration/room/${encodeURIComponent(roomId).replace(/%3A/gi, ':')}?${query}`;
    this.ready = new Promise((resolve, reject) => { this.resolveReady = resolve; this.rejectReady = reject; });
    this.abort = () => this.close(abortReason(signal));
    signal?.addEventListener('abort', this.abort, { once: true });
    if (signal?.aborted) { this.abort(); return; }
    this.timer = setTimeout(() => this.fail(Error('Jupyter RTC 连接超时')), timeout);
    try { this.socket = new WebSocket(this.url, { maxPayload: 128 * 1024 * 1024 }); }
    catch (error) { this.fail(error); return; }
    this.onUpdate = (update, origin) => {
      if (this.closed || origin === this || this.socket.readyState !== WebSocket.OPEN) return;
      try { const out = encoding.createEncoder(); encoding.writeVarUint(out, 0); sync.writeUpdate(out, update); this.socket.send(encoding.toUint8Array(out)); }
      catch (error) { this.fail(error); }
    };
    this.notebook.ydoc.on('update', this.onUpdate);
    this.socket.binaryType = 'arraybuffer';
    this.socket.on('open', () => { if (this.closed) return; try { const out = encoding.createEncoder(); encoding.writeVarUint(out, 0); sync.writeSyncStep1(out, this.notebook.ydoc); this.socket.send(encoding.toUint8Array(out)); } catch (error) { this.fail(error); } });
    this.socket.on('message', data => this.message(new Uint8Array(data)));
    this.socket.on('error', error => this.fail(Error('Jupyter RTC WebSocket 失败：' + (error.message || '连接错误'))));
    this.socket.on('close', (code, reason) => this.fail(Error(`Jupyter RTC 已断开（${code}${reason ? `：${reason}` : ''}）`)));
  }
  message(bytes) {
    if (this.closed) return;
    try {
      const decoder = decoding.createDecoder(bytes), messageType = decoding.readVarUint(decoder);
      if (messageType !== 0) return;
      const subtype = bytes[decoder.pos];
      const reply = encoding.createEncoder(); encoding.writeVarUint(reply, 0);
      sync.readSyncMessage(decoder, reply, this.notebook.ydoc, this);
      if (encoding.length(reply) > 1 && this.socket.readyState === WebSocket.OPEN) this.socket.send(encoding.toUint8Array(reply));
      if (subtype === 1 && !this.synced) { this.synced = true; clearTimeout(this.timer); this.resolveReady(this); }
    } catch (error) { this.fail(Error('Jupyter RTC 数据无法解析：' + error.message)); }
  }
  fail(error) { this.close(error); }
  close(error = jupyterClosed()) {
    if (this.closed) return;
    this.closed = true; this.synced = false; clearTimeout(this.timer); this.signal?.removeEventListener('abort', this.abort);
    this.rejectReady(error);
    if (this.onUpdate) this.notebook.ydoc.off('update', this.onUpdate);
    try { this.socket?.close(); } catch {}
    this.notebook.dispose(); this.onClose(error);
  }
}
class JupyterRtcClient {
  constructor({ baseUrl, token = '', notebookPath, fetchImpl = (url, options) => globalThis.fetch(url, options), onStatus = () => {}, timeout = 15000, restTimeout = 60000, kernelIdleGrace = 20000, kernelPollInterval = 5000 }) {
    this.baseUrl = normalizeBaseUrl(baseUrl); this.token = token.trim(); this.path = encodeNotebookPath(notebookPath); this.fetch = (url, options) => fetchImpl.call(globalThis, url, options); this.onStatus = onStatus; this.timeout = timeout; this.restTimeout = restTimeout; this.kernelIdleGrace = kernelIdleGrace; this.kernelPollInterval = kernelPollInterval; this.socket = null; this.changeListeners = new Set();
    this.closed = false; this.lifetime = new AbortController(); this.requestControllers = new Set(); this.kernelSockets = new Set(); this.connecting = null; this.kernelConnecting = null;
  }
  get connected() { return !this.closed && !this.lifetime.signal.aborted && !!this.socket?.synced && !this.socket.closed && (this.socket.socket?.readyState == null || this.socket.socket.readyState === WebSocket.OPEN); }
  assertOpen() { if (this.closed || this.lifetime.signal.aborted) throw abortReason(this.lifetime.signal); }
  headers() { return { Accept: 'application/json', ...(this.token ? { Authorization: `token ${this.token}` } : {}) }; }
  async wait(work, { controller = new AbortController(), signal, timeout = this.restTimeout, message = 'Jupyter 请求等待超时，请检查服务或重新连接' } = {}) {
    this.assertOpen();
    const signals = [this.lifetime.signal, signal].filter(Boolean), cancels = signals.map(parent => () => controller.abort(abortReason(parent)));
    signals.forEach((parent, index) => { parent.addEventListener('abort', cancels[index], { once: true }); if (parent.aborted) cancels[index](); });
    const timer = setTimeout(() => controller.abort(Error(message)), timeout);
    try {
      const result = await abortable(Promise.resolve().then(() => { this.assertOpen(); if (controller.signal.aborted) throw abortReason(controller.signal); return work(controller.signal); }), controller.signal);
      this.assertOpen(); return result;
    } finally { clearTimeout(timer); signals.forEach((parent, index) => parent.removeEventListener('abort', cancels[index])); }
  }
  async request(url, options = {}) {
    const controller = new AbortController(); this.requestControllers.add(controller);
    try {
      const response = await this.wait(signal => this.fetch(url, { ...options, signal }), { controller, signal: options.signal });
      if (!response.ok || response.status === 204) { controller.abort(); this.requestControllers.delete(controller); return response; }
      return { ok: response.ok, status: response.status, json: async () => {
        try { return await this.wait(() => response.json(), { controller, signal: options.signal }); }
        finally { this.requestControllers.delete(controller); }
      } };
    } catch (error) { controller.abort(error); this.requestControllers.delete(controller); throw error; }
  }
  async connect() {
    this.assertOpen(); if (this.connected) return this.read(); if (this.connecting) return this.connecting;
    const pending = this.connectRtc(); this.connecting = pending;
    try { return await pending; } finally { if (this.connecting === pending) this.connecting = null; }
  }
  async connectRtc() {
    try {
    this.onStatus('connecting');
    const response = await this.request(`${this.baseUrl}/api/collaboration/session/${this.path}`, { method: 'PUT', headers: { ...this.headers(), 'Content-Type': 'application/json' }, body: JSON.stringify({ format: 'json', type: 'notebook' }) });
    if (!response.ok) throw Error(response.status === 404 ? 'Jupyter 未提供协作端点；请安装并启用 jupyter-collaboration' : response.status === 401 || response.status === 403 ? 'Jupyter 地址或令牌无效' : `Jupyter 协作会话创建失败（HTTP ${response.status}）`);
    const info = await response.json(); this.assertOpen();
    const roomId = info?.roomId || (info?.fileId ? `json:notebook:${info.fileId}` : '');
    if (!roomId || !info?.sessionId) throw Error('Jupyter 协作会话响应无效');
    this.roomId = roomId; this.sessionId = info.sessionId;
    const socket = new YSocket({ url: this.baseUrl, token: this.token, roomId, sessionId: info.sessionId, timeout: this.timeout, signal: this.lifetime.signal });
    this.socket = socket; socket.onClose = error => { if (this.socket === socket) this.close(error); };
    await socket.ready; this.assertOpen(); if (!this.connected || this.socket !== socket) throw jupyterClosed();
    this.onStatus('connected'); this.assertOpen();
    this.onNotebookUpdate = (_update, origin) => { if (this.connected && this.socket === socket && origin === socket) { const value = this.read(); for (const listener of this.changeListeners) listener(value); } };
    socket.notebook.ydoc.on('update', this.onNotebookUpdate);
    return this.read();
    } catch (error) { this.close(error); throw error; }
  }
  read() { if (!this.connected) throw Error('Jupyter RTC 尚未连接'); return this.socket.notebook.toJSON(); }
  onChange(listener) { this.assertOpen(); this.changeListeners.add(listener); return () => this.changeListeners.delete(listener); }
  async applyPatch(patch) {
    if (!this.connected) throw Error('Jupyter RTC 尚未连接');
    const before = this.read();
    const prepared = validatePatch(before, patch);
    const model = this.socket.notebook, cells = [...model.cells], sources = before.cells.map(cell => joinSource(cell.source));
    const identities = before.cells.map(cell => cell.id), touched = new Set(), deleted = new Set();
    const persistentIds = value => value.cells.every(cell => typeof cell.id === 'string' && cell.id) && new Set(value.cells.map(cell => cell.id)).size === value.cells.length;
    const canConfirmCells = persistentIds(before) && persistentIds(prepared.notebook);
    for (const op of prepared.patch.operations) {
      if (op.type === 'insert_cell') { identities.splice(op.index, 0, op.cellId); touched.add(op.cellId); deleted.delete(op.cellId); }
      else {
        const id = identities[op.index];
        if (op.type === 'delete_cell') { identities.splice(op.index, 1); touched.delete(id); deleted.add(id); }
        else touched.add(id);
      }
    }
    const expectedCells = new Map(prepared.notebook.cells.map(cell => [cell.id, { type: cell.cell_type, source: joinSource(cell.source) }]));
    const accept = canConfirmCells && prepared.patch.operations.length ? snapshot => {
      if (!Array.isArray(snapshot?.cells) || !persistentIds(snapshot)) return false;
      const actual = new Map(snapshot.cells.map(cell => [cell.id, cell]));
      for (const id of deleted) if (actual.has(id)) return false;
      for (const id of touched) {
        const cell = actual.get(id), expected = expectedCells.get(id);
        if (!cell || !expected || cell.cell_type !== expected.type || joinSource(cell.source) !== expected.source) return false;
      }
      return true;
    } : null;
    model.transact(() => {
      for (const op of prepared.patch.operations) {
        const index = op.index;
        if (op.type === 'set_source' || op.type === 'replace_text') {
          sources[index] = op.type === 'set_source' ? op.source : sources[index].replace(op.oldText, () => op.newText);
          cells[index].setSource(sources[index]);
        }
        else if (op.type === 'delete_cell') { model.deleteCell(index); cells.splice(index, 1); sources.splice(index, 1); }
        else {
          const inserted = model.insertCell(index, { id: op.cellId, cell_type: op.cellType, source: op.source, metadata: {}, ...(op.cellType === 'code' ? { outputs: [], execution_count: null } : {}) });
          cells.splice(index, 0, inserted); sources.splice(index, 0, op.source);
        }
      }
    }, true, 'simple-deepseek');
    let submitted = prepared.notebook;
    try {
      submitted = this.read(); const expected = notebookHash(submitted);
      this.onStatus('syncing');
      await this.verify(expected, accept ? { accept } : undefined);
      const confirmed = this.read();
      if (!(accept ? accept(confirmed) : notebookHash(confirmed) === expected)) throw Error('Notebook 已在别处发生变化，请重新生成或检查补丁');
      this.onStatus('connected'); return confirmed;
    } catch (error) {
      // The Yjs transaction has already been sent. A lost confirmation must not
      // offer a second application or roll back edits made concurrently.
      let notebook = submitted; try { notebook = this.read(); } catch {}
      throw Object.assign(error instanceof Error ? error : Error(String(error)), { applied: true, notebook });
    }
  }
  async json(url, options = {}) {
    const response = await this.request(this.baseUrl + url, { ...options, headers: { ...this.headers(), 'Content-Type': 'application/json', ...(options.headers || {}) } });
    if (!response.ok) throw Error(`Jupyter 请求失败（HTTP ${response.status}）`);
    return response.status === 204 ? null : response.json();
  }
  async ensureKernel() {
    this.assertOpen();
    if (this.kernel?.socket?.readyState === WebSocket.OPEN) return this.kernel;
    if (this.kernelConnecting) return this.kernelConnecting;
    const pending = this.connectKernel(); this.kernelConnecting = pending;
    try { return await pending; } finally { if (this.kernelConnecting === pending) this.kernelConnecting = null; }
  }
  async connectKernel() {
    let socket, kernel;
    try {
    const sessions = await this.json('/api/sessions');
    this.assertOpen();
    let session = Array.isArray(sessions) ? sessions.find(item => encodeNotebookPath(item.path || '') === this.path) : null;
    if (!session) session = await this.json('/api/sessions', { method: 'POST', body: JSON.stringify({ path: decodeURIComponent(this.path), name: '', type: 'notebook', kernel: { name: this.read()?.metadata?.kernelspec?.name || 'python3' } }) });
    this.assertOpen(); const kernelId = session?.kernel?.id; if (!kernelId) throw Error('Jupyter 没有返回 Kernel');
    const sessionId = randomUUID(), wsBase = this.baseUrl.replace(/^http/, 'ws');
    const query = new URLSearchParams({ session_id: sessionId, ...(this.token ? { token: this.token } : {}) });
    socket = new WebSocket(`${wsBase}/api/kernels/${encodeURIComponent(kernelId)}/channels?${query}`, { maxPayload: 128 * 1024 * 1024 });
    kernel = { id: kernelId, sessionId, socket, pending: new Map() }; this.kernelSockets.add(socket);
    const fail = error => { for (const pending of kernel.pending.values()) pending.reject(error); kernel.pending.clear(); if (this.kernel === kernel) this.kernel = null; };
    socket.on('message', raw => {
      if (this.closed || this.kernel !== kernel) return;
      let message; try { message = JSON.parse(Buffer.from(raw).toString('utf8')); } catch { return; }
      const id = message?.parent_header?.msg_id, pending = kernel.pending.get(id); if (!pending) return;
      pending.messages.push(message);
      if (message.channel === 'iopub' && message.header?.msg_type === 'status' && message.content?.execution_state === 'idle') { kernel.pending.delete(id); pending.resolve(pending.messages); }
    });
    socket.on('error', error => { fail(Error('Jupyter Kernel 连接失败：' + (error.message || '连接错误'))); try { socket.close(); } catch {} });
    socket.on('close', () => { fail(Error('Jupyter Kernel 连接已断开')); this.kernelSockets.delete(socket); });
    let opened, failed, disconnected;
    const ready = new Promise((resolve, reject) => {
      opened = resolve; failed = reject; disconnected = () => reject(Error('Jupyter Kernel 连接已断开'));
      socket.once('open', opened); socket.once('error', failed); socket.once('close', disconnected);
      if (socket.readyState === WebSocket.OPEN) resolve();
    });
    ready.catch(() => {});
    try { await this.wait(() => ready, { timeout: this.timeout, message: '连接 Jupyter Kernel 超时' }); }
    finally { socket.off('open', opened); socket.off('error', failed); socket.off('close', disconnected); }
    this.assertOpen(); if (socket.readyState !== WebSocket.OPEN) throw Error('Jupyter Kernel 连接已断开');
    this.kernel = kernel;
    return kernel;
    } catch (error) {
      if (socket) { this.kernelSockets.delete(socket); if (socket.readyState !== WebSocket.CLOSING && socket.readyState !== WebSocket.CLOSED) { try { socket.close(); } catch {} } }
      throw error;
    }
  }
  async kernelRequest(msgType, content) {
    const kernel = await this.ensureKernel(), msgId = randomUUID(); this.assertOpen();
    if (kernel.socket.readyState != null && kernel.socket.readyState !== WebSocket.OPEN) throw Error('Jupyter Kernel 连接已断开');
    const message = { channel: 'shell', header: { msg_id: msgId, username: 'simple-deepseek', session: kernel.sessionId, date: new Date().toISOString(), msg_type: msgType, version: '5.3' }, parent_header: {}, metadata: {}, content };
    const response = new Promise((resolve, reject) => {
      let checking = false, idleSince = 0, settled = false;
      const finish = (callback, value) => { if (settled) return; settled = true; clearTimeout(timer); clearInterval(monitor); this.lifetime.signal.removeEventListener('abort', cancel); kernel.pending.delete(msgId); callback(value); };
      const cancel = () => finish(reject, abortReason(this.lifetime.signal));
      const timer = setTimeout(() => { kernel.pending.delete(msgId); finish(reject, Error('Jupyter Kernel 执行超时')); }, 30 * 60 * 1000);
      const monitor = setInterval(async () => {
        if (checking || !kernel.pending.has(msgId)) return;
        checking = true;
        try {
          const status = await this.json(`/api/kernels/${encodeURIComponent(kernel.id)}`);
          if (this.closed || !kernel.pending.has(msgId)) return;
          if (status?.execution_state !== 'idle') idleSince = 0;
          else if (!idleSince) idleSince = Date.now();
          else if (Date.now() - idleSince >= this.kernelIdleGrace) {
            const pending = kernel.pending.get(msgId);
            if (pending) { kernel.pending.delete(msgId); pending.reject(Error('Jupyter Kernel 已空闲，但插件没有收到本次执行完成消息；请重新连接后重试')); }
          }
        } catch {} finally { checking = false; }
      }, this.kernelPollInterval);
      kernel.pending.set(msgId, { messages: [], resolve: value => finish(resolve, value), reject: error => finish(reject, error) });
      this.lifetime.signal.addEventListener('abort', cancel, { once: true });
      if (this.lifetime.signal.aborted) cancel();
    });
    try { kernel.socket.send(JSON.stringify(message)); }
    catch (error) { const pending = kernel.pending.get(msgId); kernel.pending.delete(msgId); pending?.reject(error); }
    return response;
  }
  messagesToOutputs(messages) {
    const outputs = [];
    for (const message of messages) {
      if (message.channel !== 'iopub') continue;
      const type = message.header?.msg_type, value = message.content || {};
      if (type === 'stream') outputs.push({ output_type: 'stream', name: value.name || 'stdout', text: value.text || '' });
      else if (type === 'display_data' || type === 'execute_result') outputs.push({ output_type: type, data: value.data || {}, metadata: value.metadata || {}, ...(type === 'execute_result' ? { execution_count: value.execution_count ?? null } : {}) });
      else if (type === 'error') outputs.push({ output_type: 'error', ename: value.ename || '', evalue: value.evalue || '', traceback: value.traceback || [] });
      else if (type === 'clear_output') outputs.length = 0;
    }
    return outputs;
  }
  captureExecutionTarget(target, { snapshot = null } = {}) {
    const notebook = snapshot || this.read(), index = typeof target === 'string' ? notebook.cells.findIndex((cell, i) => cellId(cell, i) === target) : target;
    if (!Number.isInteger(index) || index < 0 || index >= notebook.cells.length) throw Error('找不到要运行的单元格');
    if (notebook.cells[index].cell_type !== 'code') throw Error('只能运行代码单元格');
    const raw = notebook.cells[index];
    return { model: this.socket.notebook, cell: this.socket.notebook.getCell(index), id: typeof raw.id === 'string' && raw.id ? raw.id : null, source: joinSource(raw.source),
      outputsHash: executionOutputsHash(raw) };
  }
  resolveExecutionTarget(target, { checkOutputs = false } = {}) {
    const fail = reason => { throw Object.assign(Error(reason === 'outputs_changed' ? '运行期间单元格输出已变化，旧运行结果未写入' : 'Notebook 连接或目标单元格已变化，当前运行结果未写入，请重新运行'), { code: 'NOTEBOOK_EXECUTION_CONFLICT', reason, outputsDiscarded: true }); };
    if (!this.socket?.synced || this.socket.notebook !== target.model) fail('connection_changed');
    const matches = target.id ? target.model.cells.map((cell, index) => cell.id === target.id ? index : -1).filter(index => index >= 0) : [];
    const index = target.id ? matches.length === 1 ? matches[0] : -1 : target.model.cells.indexOf(target.cell);
    if (index < 0) fail('target_deleted');
    const cell = target.model.getCell(index), raw = cell?.toJSON();
    if (!cell || raw.cell_type !== 'code' || joinSource(raw.source) !== target.source) fail('source_changed');
    if (checkOutputs && executionOutputsHash(raw) !== target.outputsHash) fail('outputs_changed');
    return { index, cell };
  }
  async executeCell(target, { expectedTarget = null } = {}) {
    if (expectedTarget) this.resolveExecutionTarget(expectedTarget);
    const pinned = this.captureExecutionTarget(target);
    if (expectedTarget && (pinned.model !== expectedTarget.model || (expectedTarget.id ? pinned.id !== expectedTarget.id : pinned.cell !== expectedTarget.cell))) throw Object.assign(Error('Notebook 连接或目标单元格已变化，当前运行结果未写入，请重新运行'), { code: 'NOTEBOOK_EXECUTION_CONFLICT', reason: 'target_changed', outputsDiscarded: true });
    this.onStatus('executing');
    const messages = await this.kernelRequest('execute_request', { code: pinned.source, silent: false, store_history: true, user_expressions: {}, allow_stdin: false, stop_on_error: true });
    const outputs = this.messagesToOutputs(messages), reply = messages.find(message => message.channel === 'shell' && message.header?.msg_type === 'execute_reply');
    const { cell } = this.resolveExecutionTarget(pinned, { checkOutputs: true });
    cell.transact(() => { cell.setOutputs(outputs); cell.setExecutionCount(reply?.content?.execution_count ?? null); }, true, 'simple-deepseek-execution');
    const expected = notebookHash(this.read()), outputsHash = executionOutputsHash({ outputs, execution_count: reply?.content?.execution_count });
    const accept = pinned.id ? snapshot => { const cells = snapshot?.cells?.filter(raw => raw.id === pinned.id) || []; return cells.length === 1 && cells[0].cell_type === 'code' && joinSource(cells[0].source) === pinned.source && executionOutputsHash(cells[0]) === outputsHash; } : null;
    let index, confirmedCell;
    try {
      this.onStatus('syncing'); await this.verify(expected, accept ? { accept } : undefined);
      const confirmed = this.read();
      if (!(accept ? accept(confirmed) : notebookHash(confirmed) === expected)) throw Error('Notebook verification drift');
      ({ index, cell: confirmedCell } = this.resolveExecutionTarget(pinned)); this.onStatus('connected');
    } catch (error) {
      throw Object.assign(Error('运行结果已写入，但 Notebook 随后发生变化或未确认同步，请核对并重新运行'), { code: 'NOTEBOOK_EXECUTION_CONFLICT', reason: error.reason || 'verification_failed', outputsDiscarded: false, outputsApplied: true });
    }
    const error = outputs.find(output => output.output_type === 'error'); if (error) throw Error(`${error.ename}: ${error.evalue}`);
    return { index, cellId: confirmedCell.id, outputs: safeOutputs(outputs), notebook: this.read() };
  }
  async runAll({ clean = true, onProgress = () => {} } = {}) {
    const initial = this.read(), model = this.socket.notebook;
    const targets = initial.cells.flatMap((cell, index) => cell.cell_type === 'code' ? [this.captureExecutionTarget(index, { snapshot: initial })] : []);
    const assertTargets = () => { if (!this.socket?.synced || this.socket.notebook !== model) throw Object.assign(Error('Notebook 连接或目标单元格已变化，当前运行结果未写入，请重新运行'), { code: 'NOTEBOOK_EXECUTION_CONFLICT', reason: 'connection_changed', outputsDiscarded: true }); return targets.map(target => this.resolveExecutionTarget(target)); };
    if (clean) {
      delete this.lastCleanRun;
      const kernel = await this.ensureKernel(); assertTargets(); await this.json(`/api/kernels/${encodeURIComponent(kernel.id)}/restart`, { method: 'POST', body: '{}' });
      try { kernel.socket.close(); } catch {} if (this.kernel === kernel) this.kernel = null;
      const current = assertTargets(); model.transact(() => { for (const { cell } of current) { cell.clearOutputs('simple-deepseek-clean'); cell.setExecutionCount(null); } }, true, 'simple-deepseek-clean');
    }
    for (let done = 0; done < targets.length; done++) {
      const { index } = this.resolveExecutionTarget(targets[done]);
      onProgress(done + 1, targets.length, index); await this.executeCell(index, { expectedTarget: targets[done] });
    }
    const resolved = assertTargets(), planned = new Set(resolved.map(({ cell }) => cell));
    if (model.cells.some(cell => cell.cell_type === 'code' && !planned.has(cell))) throw Object.assign(Error('全量运行期间新增了代码单元格，未运行新增内容，请重新全量运行'), { code: 'NOTEBOOK_EXECUTION_CONFLICT', reason: 'new_code_cells', outputsDiscarded: false });
    const completed = this.read(); if (clean) this.lastCleanRun = JSON.parse(JSON.stringify(completed)); return completed;
  }
  async writeResultJson() {
    if (!this.lastCleanRun) throw Error('请先成功完成一次全量运行');
    const relative = decodeURIComponent(this.path), directory = path.posix.dirname(relative), target = path.posix.join(directory === '.' ? '' : directory, 'result.json');
    const content = JSON.stringify(resultJson(this.lastCleanRun), null, 2) + '\n';
    await this.json(`/api/contents/${target.split('/').map(encodeURIComponent).join('/')}`, { method: 'PUT', body: JSON.stringify({ type: 'file', format: 'text', content }) });
    return target;
  }
  async verify(expected, { accept } = {}) {
    this.assertOpen();
    const deadline = Date.now() + this.timeout; let lastHash = '';
    while (Date.now() < deadline) {
      this.assertOpen();
      const verifier = new YSocket({ url: this.baseUrl, token: this.token, roomId: this.roomId, sessionId: this.sessionId, timeout: Math.max(500, Math.min(3000, deadline - Date.now())), signal: this.lifetime.signal });
      try {
        await verifier.ready; this.assertOpen(); const snapshot = verifier.notebook.toJSON(); lastHash = notebookHash(snapshot);
        if (lastHash === expected || (typeof accept === 'function' && accept(snapshot))) return;
      }
      finally { verifier.close(); }
      await this.wait(() => new Promise(resolve => setTimeout(resolve, 50)));
    }
    throw Error(`Jupyter 未确认本次 Notebook 更新（服务器哈希 ${lastHash.slice(0, 12) || '未知'}）`);
  }
  close(error = jupyterClosed()) {
    if (this.closed) return;
    this.closed = true;
    const socket = this.socket; this.socket = null;
    if (socket && this.onNotebookUpdate) socket.notebook.ydoc.off('update', this.onNotebookUpdate);
    this.onNotebookUpdate = null; this.lifetime.abort(error);
    for (const controller of this.requestControllers) controller.abort(error);
    this.requestControllers.clear();
    if (socket instanceof YSocket) socket.close(error);
    else { try { socket?.close?.(); } catch {} socket?.notebook?.dispose?.(); }
    for (const pending of this.kernel?.pending?.values?.() || []) pending.reject(error);
    this.kernel?.pending?.clear?.();
    for (const pending of this.kernelSockets) { try { pending.close(); } catch {} }
    this.kernelSockets.clear(); this.kernel = null; this.changeListeners.clear(); this.onStatus('disconnected', error);
  }
}
function resultJson(notebook) {
  const safe = safeNotebook(notebook);
  return { notebookHash: safe.notebookHash, generatedAt: new Date().toISOString(), cells: safe.cells.filter(cell => cell.outputs.length).map(({ cellId, index, executionCount, outputs }) => ({ cellId, index, executionCount, outputs })) };
}
module.exports = { NOTEBOOK_SYSTEM_PROMPT, safeOutputs, safeNotebook, notebookHash, notebookSnapshot, notebookDelta, notebookContext, notebookCurrentHash, parsePatch, describePatch, validatePatch, NotebookPatchWorkspace, NotebookEditBuffer, normalizeBaseUrl, encodeNotebookPath, requestUrlFetch, JupyterRtcClient, resultJson, hash };
