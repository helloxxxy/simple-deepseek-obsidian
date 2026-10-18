const { Plugin, ItemView, Notice, MarkdownRenderer, Component, setIcon, requestUrl } = require('obsidian');
const { shell, clipboard } = require('electron');
const { chat, listModels, parseFile, check, abortableTask } = require('./core');
const { ImageStore } = require('./images');
const { imageReference } = require('./image-context');
const { stripImageDataUris } = require('./text-safety');
const { ThinkingView } = require('./thinking-view');
const { SourceList } = require('./source-list');
const { NotebookPatchView } = require('./notebook-patch-view');
const { ModelCatalog, assertReasoningEffort } = require('./models');
const { validMessage, copyMessage, entryMessages, repairOpenTools, rebuildEntryMessages } = require('./history');
const { WebReferences, extractWebMentions, referenceMarker, hasOriginal, publicWebUrl } = require('./web');
const { runToolTurn, turnTools, addUsage, TOOL_PROTOCOL_MESSAGES } = require('./tool-turn');
const { buildSystemPrompt } = require('./prompts');
const { TurnContext, notebookConnected } = require('./turn-context');
const { requestTimeContext } = require('./request-context');
const { normalizeMath } = require('./markdown');
const { annotateMath, selectionInside, copySelection, backtickFence } = require('./selection-copy');
const { estimateText, estimateMessages, contextTokens, rememberUsage, contextReserve, outputBudget, compactContext, formatUsage, recordCacheUsage, sessionStats } = require('./context');
const { TextPacer } = require('./pacing');
const { createKeyStore } = require('./secrets');
const { createConversationStore, validId: validConversationId } = require('./conversations');
const { DEFAULT_LIBRARY, arxivId, scanLibrary, findRecord, searchRecords, expandMentions, deduplicateMentions } = require('./library');
const { outline, headingAt, mergeRanges, withOutlineContext } = require('./outline');
const { safeNotebook, notebookSnapshot, notebookDelta, notebookContext, notebookCurrentHash, notebookHash, parsePatch, describePatch, NotebookEditBuffer, requestUrlFetch, JupyterRtcClient } = require('./notebook');
const { rebaseNotebookPatch } = require('./notebook-merge');
const { startLocalJupyter, stopLocalJupyter } = require('./jupyter-local');
const { clipboardAttachments, materializeClipboardAttachment } = require('./clipboard');
const { translate, translateNotebookEvent } = require('./i18n');
const VIEW = 'simple-deepseek-chat';
const STREAM_MARKDOWN_MS = 1000;
const IMAGE_NOTICE = '已识别并加入上下文（识别文本不在对话框显示）';
const ARXIV_IMPORT_HINT = '本地未收录 · 发送时下载入库';
const isImageNotice = entry => entry?.label?.startsWith('图片 · ') && entry.raw === IMAGE_NOTICE;
const API_MANAGE_PAGES = {
  deepseek: { name: 'DeepSeek', url: 'https://platform.deepseek.com/api_keys' },
  mineru: { name: 'MinerU', url: 'https://mineru.net/apiManage' }
};
const emptySession = () => ({ messages: [], entries: [], meter: null, compactions: 0, cache: null });
function imageMetadata(value) {
  if (!value || typeof value.id !== 'string' || !/^image-[a-f0-9]{64}$/.test(value.id) || typeof value.name !== 'string') return null;
  return Object.fromEntries(['id','name','mime','width','height','size'].filter(field => typeof value[field] === (['width','height','size'].includes(field) ? 'number' : 'string')).map(field => [field,value[field]]));
}
function restoreSession(value) {
  if (!value || !Array.isArray(value.messages) || !Array.isArray(value.entries)
    || !value.messages.every(validMessage)
    || !value.entries.every(e => e && typeof e.label === 'string' && typeof e.raw === 'string')) return null;
  const session = emptySession();
  session.messages = value.messages.map(copyMessage);
  session.entries = value.entries.map(e => ({ label: e.label, raw: e.raw, ...(typeof e.contextText === 'string' ? { contextText: e.contextText } : {}), ...(typeof e.references === 'string' ? { references: e.references } : {}), ...(typeof e.thinking === 'string' ? { thinking: e.thinking } : {}), ...(typeof e.usageText === 'string' ? { usageText: e.usageText } : {}), ...(e.usage && typeof e.usage === 'object' && !Array.isArray(e.usage) ? { usage: e.usage } : {}), ...(Number.isFinite(e.durationMs) && e.durationMs > 0 ? { durationMs: e.durationMs } : {}), ...(e.notebookEvent ? { notebookEvent: true } : {}), ...(e.notebookAttached ? { notebookAttached: true } : {}) }));
  value.entries.forEach((entry,index) => {
    const restored = session.entries[index];
    for (const field of ['replyId','sourceReplyId','notebookTaskId']) if (typeof entry[field] === 'string') restored[field] = entry[field];
    if (Array.isArray(entry.modelMessages) && entry.modelMessages.every(validMessage)) restored.modelMessages = entry.modelMessages.map(copyMessage);
    if (Array.isArray(entry.failedRequests)) restored.failedRequests = entry.failedRequests;
    if (Array.isArray(entry.sources)) restored.sources = entry.sources.filter(source => source && typeof source.url === 'string' && typeof source.title === 'string');
    if (Array.isArray(entry.images)) restored.images = entry.images.map(imageMetadata).filter(Boolean);
    if (entry.imageAnalysis && typeof entry.imageAnalysis.question === 'string') restored.imageAnalysis = {question:entry.imageAnalysis.question,model:'deepseek-flash',cached:!!entry.imageAnalysis.cached};
    if (entry.notebookPatch) { try { restored.notebookPatch = parsePatch(entry.notebookPatch); } catch {} }
    if (entry.notebookApplied) restored.notebookApplied = true;
    if (entry.notebookUnverified) restored.notebookUnverified = true;
    if (entry.notebookTaskInvalidated) restored.notebookTaskInvalidated = true;
    if (Number.isSafeInteger(entry.notebookTaskRevision) && entry.notebookTaskRevision >= 0) restored.notebookTaskRevision = entry.notebookTaskRevision;
    if (typeof entry.notebookTaskIdentity === 'string' && /^[0-9a-f]{64}$/.test(entry.notebookTaskIdentity)) restored.notebookTaskIdentity = entry.notebookTaskIdentity;
    if (['web_disabled','invalid_tool_protocol'].includes(entry.toolProtocolError)) restored.toolProtocolError = entry.toolProtocolError;
    if (typeof entry.displayText === 'string') restored.displayText = entry.displayText;
    if (Array.isArray(entry.protocolRecovery)) restored.protocolRecovery = entry.protocolRecovery.filter(event => event && typeof event.recovered === 'boolean' && Number.isSafeInteger(event.attempt));
    if (entry.requestCapabilities && typeof entry.requestCapabilities.webEnabled === 'boolean' && Array.isArray(entry.requestCapabilities.tools) && entry.requestCapabilities.tools.every(name => typeof name === 'string')) restored.requestCapabilities = {webEnabled:entry.requestCapabilities.webEnabled,tools:[...entry.requestCapabilities.tools]};
  });
  const valid = n => Number.isFinite(n) && n >= 0;
  if (valid(value.meter?.tokens) && Number.isInteger(value.meter?.count) && value.meter.count >= 0 && value.meter.count <= session.messages.length) session.meter = { tokens: value.meter.tokens, count: value.meter.count, estimated: !!value.meter.estimated, ...(typeof value.meter.model === 'string' ? { model: value.meter.model } : {}), ...(typeof value.meter.systemPrompt === 'string' ? { systemPrompt: value.meter.systemPrompt } : {}), ...(typeof value.meter.includeReasoning === 'boolean' ? {includeReasoning:value.meter.includeReasoning} : {}) };
  if (valid(value.compactions)) session.compactions = value.compactions;
  if (value.cache && ['hit','miss','measured','unknown'].every(k => valid(value.cache[k]))) session.cache = Object.fromEntries(['hit','miss','measured','unknown'].map(k => [k, value.cache[k]]));
  if (value.notebookSnapshot && typeof value.notebookSnapshot.hash === 'string' && value.notebookSnapshot.cells && typeof value.notebookSnapshot.cells === 'object') session.notebookSnapshot = value.notebookSnapshot;
  if (value.notebookTasks && typeof value.notebookTasks === 'object' && !Array.isArray(value.notebookTasks)) {
    session.notebookTasks = Object.create(null);
    for (const [id,envelope] of Object.entries(value.notebookTasks)) {
      try {
        if (!envelope || !/^[0-9a-f]{64}$/.test(envelope.identity)) continue;
        const buffer = NotebookEditBuffer.restore(envelope.state), state = buffer.exportState();
        if (buffer.taskId !== id || !state) continue;
        session.notebookTasks[id] = {state,identity:envelope.identity,...(envelope.discarded ? {discarded:true} : {}),...(envelope.invalidated ? {invalidated:true} : {}),...(typeof envelope.sourceReplyId === 'string' ? {sourceReplyId:envelope.sourceReplyId} : {})};
        if (id === value.activeNotebookTaskId && !buffer.done && !envelope.discarded && !envelope.invalidated) session.activeNotebookTaskId = id;
      } catch {}
    }
  }
  const recovered = repairOpenTools(session.messages);
  if (recovered.length) {
    session.meter = null;
    const ids = new Set(recovered.map(message => message.tool_call_id));
    const owner = [...session.entries].reverse().find(entry => entry.modelMessages?.some(message => message.tool_calls?.some(call => ids.has(call.id))));
    if (owner) owner.modelMessages.push(...recovered.map(copyMessage));
  }
  return session;
}
function sessionTitle(session) {
  const entry = session.entries.find(item => item.label === '你' && item.raw.trim()) || session.entries.find(item => item.raw.trim());
  const text = entry?.raw.trim().replace(/\s+/g, ' ') || '';
  return text ? (text.length > 36 ? text.slice(0, 36) + '…' : text) : '新对话';
}
function splitMarkdown(text, tokenLimit = 8000) {
  if (estimateText(text) <= tokenLimit) return [text];
  const lines = String(text).split(/(?<=\n)/), chunks = []; let current = '', inFence = false, inMath = false, ascii = 0, other = 0;
  for (const line of lines) {
    current += line;
    for (const character of line) { if (character.charCodeAt(0) < 128) ascii++; else other++; }
    if (/^\s*(?:`{3,}|~{3,})/.test(line)) inFence = !inFence;
    if (!inFence && (line.match(/\$\$/g) || []).length % 2) inMath = !inMath;
    if (!inFence && !inMath && /^\s*$/.test(line) && Math.ceil(ascii * 0.3 + other * 0.6) >= tokenLimit) { chunks.push(current); current = ''; ascii = 0; other = 0; }
  }
  if (current) chunks.push(current); return chunks.length ? chunks : [text];
}
const conversationId = () => `conversation-${Date.now().toString(36)}-${Math.random().toString(36).slice(2,10)}`;
function messageMarkdown(entry, language = 'zh', includeSources = true, includeNotebookPatch = true) {
  let text = entry.toolProtocolError ? translate(TOOL_PROTOCOL_MESSAGES[entry.toolProtocolError], language) : entry.displayText ?? entry.raw;
  if (includeNotebookPatch && entry.notebookPatch) {
    const json = JSON.stringify(entry.notebookPatch,null,2), fence = backtickFence(json);
    text += `\n\n${fence}notebook-patch\n${json}\n${fence}`;
  }
  if (includeSources && entry.sources?.length) {
    const escape = value => value.replace(/[\r\n]/g,' ').replace(/[\\\[\]<>`!*_{}]/g,'\\$&');
    const links = entry.sources.flatMap(source => { try { const url = publicWebUrl(source.url); return [`[${escape(source.title || url)}](<${url.replace(/>/g,'%3E')}>)`]; } catch { return []; } });
    if (links.length) text += '\n\n'+translate('已检索网页',language)+': '+links.join(' · ');
  }
  return text;
}
class ChatView extends ItemView {
  constructor(leaf, plugin) { super(leaf); this.plugin = plugin; this.session = plugin.session; this.messages = this.session.messages; this.notebookSnapshot = this.session.notebookSnapshot || null; this.controller = null; this.closed = false; this.rows = new Set(); this.images = new ImageStore(); this.pendingImages = []; this.notebookTaskBuffers = new Map(); }
  getViewType() { return VIEW; }
  getDisplayText() { return 'Simple DeepSeek'; }
  getIcon() { return 'message-circle'; }
  isBusy() { return !!(this.controller || this.clearing || this.closed || this.applyingNotebookPatch || this.conversationTransition); }
  notice(message) { return new Notice(translate(message, this.plugin.uiLanguage)); }
  localizeTree(node) {
    if (!node || !this.textOrigins) return;
    if (node.nodeType === 3) {
      if (node.parentElement?.closest('.sd-body, .sd-thinking-body, .sd-sources-body, .sd-notebook-cell-body, .sd-notebook-cell-summary, .sd-outline-heading, .sd-range-preview-text, .sd-range-name, .sd-image-name, .sd-mentions button, .sd-confirm pre')) return;
      const prior = this.textOrigins.get(node);
      const raw = prior && node.data === prior.rendered ? prior.raw : node.data;
      const rendered = translate(raw, this.plugin.uiLanguage);
      this.textOrigins.set(node, { raw, rendered });
      if (node.data !== rendered) node.data = rendered;
      return;
    }
    if (node.nodeType !== 1) return;
    if (node.closest('.sd-body, .sd-thinking-body, .sd-sources-body, .sd-notebook-cell-body, .sd-notebook-cell-summary, .sd-outline-heading, .sd-range-preview-text, .sd-range-name, .sd-image-name, .sd-language-select, .sd-mentions button, .sd-confirm pre')) return;
    if (node.tagName === 'OPTION' && node.parentElement === this.conversationSelect) return;
    for (const name of ['aria-label', 'aria-valuetext', 'title', 'placeholder']) {
      if (!node.hasAttribute(name)) continue;
      let record = this.attributeOrigins.get(node);
      if (!record) { record = new Map(); this.attributeOrigins.set(node, record); }
      const current = node.getAttribute(name), prior = record.get(name);
      const raw = prior && current === prior.rendered ? prior.raw : current;
      const rendered = name === 'aria-label' && node.classList.contains('sd-icon-button') && raw.startsWith('复制')
        ? translate('复制', this.plugin.uiLanguage) + translate(raw.slice('复制'.length), this.plugin.uiLanguage)
        : translate(raw, this.plugin.uiLanguage);
      record.set(name, { raw, rendered });
      if (current !== rendered) node.setAttribute(name, rendered);
    }
    for (const child of node.childNodes) this.localizeTree(child);
  }
  refreshLanguage() {
    this.refreshConversationOptions();
    this.refreshStats();
    this.refreshNotebookDeltaLabel();
    for (const row of this.rows) {
      row.sourceList?.refresh();
      row.patchView?.refresh();
      if (row.entry.usage) row.usageEl.textContent = formatUsage(row.entry.usage, row.entry.durationMs, this.plugin.uiLanguage);
      if (row.entry.notebookEvent || isImageNotice(row.entry) || row.entry.toolProtocolError) { row.version++; void this.render(row); }
    }
    [...(this.mentionPopup?.querySelectorAll('button') || [])].forEach((button, index) => {
      if (this.mentionItems?.[index]?.systemHint) {
        const title = button.querySelector('.sd-mention-title');
        if (title) title.textContent = translate(ARXIV_IMPORT_HINT, this.plugin.uiLanguage);
      }
    });
    for (const heading of this.contentEl.querySelectorAll('.sd-outline-heading[data-sd-system-title]')) {
      heading.textContent = translate(heading.dataset.sdSystemTitle, this.plugin.uiLanguage);
    }
    this.localizeTree(this.contentEl);
  }
  async onOpen() {
    this.closed = false;
    this.textOrigins = new WeakMap(); this.attributeOrigins = new WeakMap();
    const root = this.contentEl; root.empty(); root.addClass('simple-deepseek');
    this.windowFocusListener = () => {
      if (!this.pendingComposerFocus) return;
      const origin = this.pendingComposerFocusOrigin, doc = this.input.ownerDocument;
      this.pendingComposerFocus = false; this.pendingComposerFocusOrigin = null;
      if (!this.closed && (doc.activeElement === doc.body || doc.activeElement === origin || doc.activeElement === this.input)) this.input.focus({ preventScroll: true });
    };
    root.ownerDocument.defaultView?.addEventListener('focus', this.windowFocusListener);
    const keys = root.createEl('details');
    keys.createEl('summary', { text: '密钥与模型设置' });
    const languageLine = keys.createEl('label', { cls: 'sd-key' }); languageLine.createSpan({ text: '界面语言' });
    const language = languageLine.createEl('select', { cls: 'sd-language-select', attr: { 'aria-label': '界面语言' } });
    for (const [value, label] of [['en', 'English'], ['zh', '简体中文']]) { const option = language.createEl('option', { text: label }); option.value = value; }
    language.value = this.plugin.uiLanguage;
    language.addEventListener('change', () => { this.plugin.uiLanguage = language.value; if (this.plugin.chatCommand) this.plugin.chatCommand.name = translate('打开聊天', language.value); this.refreshLanguage(); void this.plugin.saveSession(); });
    for (const [name, label] of [['deepseek', 'DeepSeek API Key'], ['mineru', 'MinerU Token']]) {
      const line = keys.createEl('label', { cls: 'sd-key' }); line.createSpan({ text: label });
      const input = line.createEl('input', { type: 'password', attr: { autocomplete: 'off', spellcheck: 'false', 'aria-label': label } });
      input.value = this.plugin.keys[name];
      input.addEventListener('input', () => { this.plugin.keys[name] = input.value.trim().replace(/^Bearer\s+/i, ''); });
      input.addEventListener('change', () => { void this.plugin.saveKeys().then(() => {
        if (!this.closed) keyStatus.textContent = '密钥已加密保存，下次打开自动读取。';
      }).catch(error => { if (!this.closed) keyStatus.textContent = error.message || '密钥安全保存失败'; }); });
    }
    const modelLine = keys.createEl('label', { cls: 'sd-key' }); modelLine.createSpan({ text: '模型名称' });
    const modelInput = modelLine.createEl('input', { type: 'text', cls: 'sd-model', attr: { placeholder: 'deepseek-flash', 'aria-label': '模型名称' } });
    modelInput.value = this.plugin.model;
    modelInput.addEventListener('change', () => {
      this.plugin.model = modelInput.value.trim() || 'deepseek-flash'; modelInput.value = this.plugin.model;
      this.refreshStats();
      void this.plugin.saveKeys().catch(() => this.notice('模型名称保存失败'));
    });
    modelLine.createSpan({ cls: 'sd-hint', text: '下次请求生效。可用时自动读取模型的上下文和输出上限。' });
    const libraryLine = keys.createEl('label', { cls: 'sd-key' }); libraryLine.createSpan({ text: '文献库路径（@ 引用）' });
    const libraryInput = libraryLine.createEl('input', { type: 'text', cls: 'sd-library-path', attr: { 'aria-label': '文献库路径' } }); libraryInput.value = this.plugin.libraryPath;
    libraryInput.addEventListener('change', () => { this.plugin.libraryPath = libraryInput.value.trim(); this.libraryRecords = null; this.hideMentions(); void this.plugin.saveKeys(false).catch(() => this.notice('文献库路径保存失败')); });
    const jupyterProgramLine = keys.createEl('label', { cls: 'sd-key' }); jupyterProgramLine.createSpan({ text: 'Jupyter 启动程序路径' });
    const jupyterProgramInput = jupyterProgramLine.createEl('input', { type: 'text', attr: { placeholder: '输入本机 jupyter 启动程序的完整路径', 'aria-label': 'Jupyter 启动程序路径' } }); jupyterProgramInput.value = this.plugin.jupyterExecutablePath;
    jupyterProgramInput.addEventListener('change', () => { this.plugin.jupyterExecutablePath = jupyterProgramInput.value.trim(); this.plugin.jupyterRoot = ''; this.disconnectNotebook(); void this.plugin.saveKeys(false).catch(() => this.notice('Jupyter 启动程序路径保存失败')); });
    const notebookPathLine = keys.createEl('label', { cls: 'sd-key' }); notebookPathLine.createSpan({ text: 'Notebook 文件路径' });
    const notebookPathInput = notebookPathLine.createEl('input', { type: 'text', attr: { placeholder: '输入本机 .ipynb 文件的完整路径；不存在则新建', 'aria-label': 'Notebook 文件路径' } }); notebookPathInput.value = this.plugin.notebookFilePath;
    notebookPathInput.addEventListener('change', () => { this.plugin.notebookFilePath = notebookPathInput.value.trim(); this.disconnectNotebook(); void this.plugin.saveKeys(false).catch(() => this.notice('Notebook 文件路径保存失败')); });
    const keyStatus = keys.createDiv({ cls: 'sd-hint', text: this.plugin.keyStorageMessage });
    const save = keys.createEl('button', { text: '保存本机设置' });
    save.addEventListener('click', () => { void this.plugin.saveKeys().then(() => { if (!this.closed) keyStatus.textContent = '密钥、路径和 Jupyter 连接信息已在本机加密保存。'; }).catch(error => { if (!this.closed) keyStatus.textContent = error.message || '本机设置安全保存失败'; }); });
    keys.open = !this.plugin.keys.deepseek;
    keys.createEl('div', { cls: 'sd-hint', text: '填好两条本机路径后，连接会自动创建缺失的 Notebook、启动 Jupyter 并用默认浏览器打开。同一 Jupyter 环境需安装 jupyterlab 和 jupyter-collaboration。密钥与路径仅在本机加密保存。' });
    const history = root.createDiv({ cls: 'sd-history' });
    this.conversationSelect = history.createEl('select', { attr: { 'aria-label': '选择对话历史', title: '选择对话历史' } });
    this.conversationSelect.addEventListener('change', () => { void this.switchConversation(this.conversationSelect.value); });
    this.newConversationButton = history.createEl('button', { attr: { 'aria-label': '新建对话', title: '新建对话' } }); setIcon(this.newConversationButton, 'plus');
    this.newConversationButton.addEventListener('click', () => { void this.newConversation(); });
    this.renameConversationButton = history.createEl('button', { attr: { 'aria-label': '重命名对话', title: '重命名对话' } }); setIcon(this.renameConversationButton, 'pencil');
    this.renameConversationButton.addEventListener('click', () => this.startRenameConversation());
    this.notebookToggle = history.createEl('button', { attr: { 'aria-label': 'Notebook 模式', title: 'Notebook 模式' } }); setIcon(this.notebookToggle, 'notebook-tabs');
    this.notebookToggle.addEventListener('click', () => this.toggleNotebookMode());
    const searchToggle = history.createEl('button', { attr: { 'aria-label': '搜索当前对话', title: '搜索当前对话' } }); setIcon(searchToggle, 'search');
    this.refreshConversationOptions();
    this.metrics = history.createDiv({ cls: 'sd-metrics', attr: { 'aria-label': '上下文与缓存使用统计' } });
    this.refreshStats();
    this.searchBar = root.createDiv({ cls: 'sd-search' }); this.searchBar.hidden = true;
    this.searchInput = this.searchBar.createEl('input', { type: 'search', attr: { placeholder: '搜索当前对话…', 'aria-label': '搜索当前对话' } });
    const searchNext = this.searchBar.createEl('button', { text: '下一个' });
    searchToggle.addEventListener('click', () => { this.searchBar.hidden = !this.searchBar.hidden; if (!this.searchBar.hidden) this.searchInput.focus(); else { this.searchHit?.classList.remove('sd-search-hit'); this.searchHit = null; } });
    searchNext.addEventListener('click', () => this.findNext()); this.searchInput.addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); this.findNext(); } });
    this.notebookPanel = root.createDiv({ cls: 'sd-notebook-panel' }); this.notebookPanel.hidden = true;
    const notebookTop = this.notebookPanel.createDiv({ cls: 'sd-notebook-top' });
    this.notebookConnect = notebookTop.createEl('button', { text: '连接 Jupyter RTC' }); this.notebookConnect.addEventListener('click', () => { if (this.notebookClient) this.disconnectNotebook(); else void this.connectNotebook(); });
    this.notebookStatus = notebookTop.createSpan({ cls: 'sd-notebook-status', text: '未连接' });
    const attachLabel = notebookTop.createEl('label', { cls: 'sd-notebook-attach' }); attachLabel.createSpan({ text: '发送 Notebook' });
    this.notebookAttach = attachLabel.createEl('select', { attr: { 'aria-label': '发送 Notebook' } });
    for (const [value, label] of [['none', '不发'], ['delta', '发增量'], ['all', '发全部']]) {
      const option = this.notebookAttach.createEl('option', { text: label }); option.value = value;
    }
    this.notebookAttach.value = 'delta';
    this.notebookAttach.addEventListener('change', () => { this.refreshNotebookDeltaLabel(); this.refreshStats(); });
    this.notebookAttachLabel = notebookTop.createSpan({ cls: 'sd-notebook-pending' });
    const notebookActions = this.notebookPanel.createDiv({ cls: 'sd-notebook-actions' });
    this.runCellButton = notebookActions.createEl('button', { text: '运行单元格' }); this.runCellButton.addEventListener('click', () => void this.runNotebookCell());
    this.runAllButton = notebookActions.createEl('button', { text: '全量运行' }); this.runAllButton.addEventListener('click', () => void this.runNotebookAll());
    this.resultButton = notebookActions.createEl('button', { text: '输出 result.json' }); this.resultButton.addEventListener('click', () => void this.writeNotebookResult());
    this.notebookCellIndex = notebookActions.createEl('input', { type: 'number', attr: { min: '1', step: '1', value: '1', 'aria-label': '运行第几个单元格', title: '单元格序号，从 1 开始' } });
    this.notebookTaskBar = this.notebookPanel.createDiv({cls:'sd-notebook-task'}); this.notebookTaskBar.hidden = true;
    this.notebookTaskBar.createSpan({text:'Notebook 修改待继续'});
    this.resumeNotebookButton = this.notebookTaskBar.createEl('button',{text:'继续生成'});
    this.resumeNotebookButton.addEventListener('click', () => void this.resumeNotebookTask(this.session.activeNotebookTaskId));
    this.discardNotebookButton = this.notebookTaskBar.createEl('button',{text:'放弃暂存'});
    this.discardNotebookButton.addEventListener('click', () => void this.discardNotebookTask(this.session.activeNotebookTaskId));
    this.notebookPreview = this.notebookPanel.createEl('details', { cls: 'sd-notebook-preview' }); this.notebookPreview.hidden = true;
    this.notebookPreviewTitle = this.notebookPreview.createEl('summary', { text: 'Notebook 预览' });
    this.notebookPreviewBody = this.notebookPreview.createDiv({ cls: 'sd-notebook-preview-body' });
    this.notebookPreviewCells = new Map(); this.notebookPreviewOpenIds = new Set(); this.notebookPreviewInitialized = false; this.notebookPreviewSelectionDeferred = false;
    this.notebookPreviewToggleListener = event => { if (event.target === this.notebookPreview) this.renderNotebookPreview(this.notebookLatest); };
    this.notebookPreview.addEventListener('toggle', this.notebookPreviewToggleListener);
    const feedShell = root.createDiv({ cls: 'sd-feed-shell' });
    this.feed = feedShell.createDiv({ cls: 'sd-feed', attr: { role: 'log', 'aria-label': '对话' } });
    this.selectionDeferredRows = new Set(); this.thinkingCollapseDeferredRows = new Set();
    this.copySelectionListener = event => copySelection(event, this.feed);
    this.selectionChangeListener = () => {
      if (selectionInside(this.feed)) this.pauseFollowing();
      for (const state of this.thinkingCollapseDeferredRows) {
        if (selectionInside(state.thinkingBody)) continue;
        this.thinkingCollapseDeferredRows.delete(state);
        state.thinkingBox.open = false; state.thinkingView.refresh();
      }
      for (const state of this.selectionDeferredRows) {
        if (selectionInside(state.body)) continue;
        this.selectionDeferredRows.delete(state);
        if (state.virtualVisible) void this.render(state); else this.virtualize(state);
      }
      if (this.notebookPreviewSelectionDeferred && !selectionInside(this.notebookPreviewBody)) this.renderNotebookPreview(this.notebookLatest);
    };
    this.feed.ownerDocument.addEventListener('copy', this.copySelectionListener, true);
    this.feed.ownerDocument.addEventListener('selectionchange', this.selectionChangeListener);
    this.dropZone = feedShell.createDiv({ cls: 'sd-drop-zone', text: '松开以上传 PDF 或图片', attr: { 'aria-hidden': 'true' } }); this.dropZone.hidden = true;
    const WindowIntersectionObserver = this.feed.ownerDocument.defaultView?.IntersectionObserver;
    this.virtualObserver = WindowIntersectionObserver ? new WindowIntersectionObserver(entries => {
      const viewport = entries.some(item => !item.isIntersecting) ? this.feed.getBoundingClientRect?.() : null;
      const validViewport = viewport && viewport.bottom > viewport.top && viewport.right > viewport.left;
      const observations = entries.map(item => {
        if (item.isIntersecting || !validViewport || item.target.__sdState?.disposed) return {item,visible:item.isIntersecting};
        const rect = item.target.getBoundingClientRect?.();
        return {item,visible:!!(rect && rect.bottom > rect.top && rect.right > rect.left && rect.bottom > viewport.top && rect.top < viewport.bottom && rect.right > viewport.left && rect.left < viewport.right)};
      });
      for (const {item,visible} of observations) {
        const state = item.target.__sdState; if (!state || state.disposed) continue;
        if (visible) { state.virtualVisible = true; state.thinkingView?.setVisible(true); state.sourceList?.setVisible(true); state.patchView?.setVisible(true); void this.render(state); }
        else { state.virtualVisible = false; state.thinkingView?.setVisible(false); state.sourceList?.setVisible(false); state.patchView?.setVisible(false); this.virtualize(state); }
      }
    }, { root: this.feed, rootMargin: '200% 0px 200% 0px' }) : null;
    const nav = feedShell.createDiv({ cls: 'sd-reply-nav', attr: { role: 'group', 'aria-label': '回复导航' } });
    for (const [direction, icon, title] of [[-1, 'chevron-up', '上一条回复'], [1, 'chevron-down', '下一条回复'], [0, 'arrow-down-to-line', '置底']]) {
      const button = nav.createEl('button', { attr: { 'aria-label': title, title } });
      setIcon(button, icon);
      button.addEventListener('click', () => {
        if (direction === 0) { this.replyAnchor = null; this.resumeFollowing(); this.scroll(); }
        else this.jumpReply(direction);
      });
    }
    for (const event of ['wheel', 'touchmove']) this.feed.addEventListener(event, () => { this.replyAnchor = null; this.pauseFollowing(); },{passive:true});
    this.feed.addEventListener('pointerdown',event => {
      this.replyAnchor = null;
      if (event.target === this.feed) this.pauseFollowing();
    },{passive:true});
    this.feed.addEventListener('keydown',event => {
      if (event.key === ' ' && event.target.closest?.('summary,button,input,select,textarea')) return;
      if (['ArrowUp','ArrowDown','PageUp','PageDown','Home','End',' '].includes(event.key)) this.pauseFollowing();
    });
    this.feedScrollTop = this.feed.scrollTop;
    this.feed.addEventListener('scroll',() => {
      const top = this.feed.scrollTop, previousTop = this.feedScrollTop;
      this.feedScrollTop = top;
      if (!this.followingReply?.streaming) return;
      if (this.feed.scrollHeight-this.feed.scrollTop-this.feed.clientHeight <= 2) { if (this.followPaused) this.resumeFollowing(); }
      else if (top < previousTop - 1) this.pauseFollowing();
    });
    this.status = root.createDiv({ cls: 'sd-status', attr: { role: 'status', 'aria-live': 'polite' } });
    const composer = root.createDiv({ cls: 'sd-composer' });
    this.pendingImageList = composer.createDiv({cls:'sd-pending-images',attr:{'aria-label':'待发送图片'}}); this.pendingImageList.hidden = true;
    this.input = composer.createEl('textarea', { cls: 'sd-input', attr: { placeholder: '输入消息… Enter 发送，Shift+Enter 换行', 'aria-label': '消息', rows: '3' } });
    this.mentionPopup = composer.createDiv({ cls: 'sd-mentions', attr: { role: 'listbox', 'aria-label': '选择引用文献' } }); this.mentionPopup.hidden = true;
    this.input.addEventListener('input', () => { void this.updateMentions(); });
    this.input.addEventListener('paste', event => {
      const attachments = clipboardAttachments(event.clipboardData, clipboard);
      if (!attachments.length) return;
      event.preventDefault();
      if (this.controller || this.clearing || this.closed) { this.status.textContent = '请等当前操作结束后再粘贴文件'; return; }
      void this.uploadFiles(attachments, true);
    });
    this.input.addEventListener('keydown', event => {
      if (this.mentionKey(event)) return;
      if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && event.keyCode !== 229) { event.preventDefault(); void this.send(); }
    });
    const actions = root.createDiv({ cls: 'sd-actions' });
    const speedLine = actions.createEl('label', { cls: 'sd-speed' });
    const speed = speedLine.createEl('input', { type: 'range', attr: { min: '20', max: '301', step: '1', 'aria-label': '本地显示速度：20 到 300 tokens/s，最右端不限速' } });
    const speedValue = speedLine.createSpan({ cls: 'sd-speed-value' });
    speed.value = String(this.plugin.displayTokensPerSecond === 0 ? 301 : this.plugin.displayTokensPerSecond);
    const updateSpeed = () => {
      const value = Number(speed.value);
      this.plugin.displayTokensPerSecond = value === 301 ? 0 : value;
      const label = value === 301 ? '不限速' : value + ' t/s';
      speedValue.textContent = label; speed.setAttribute('aria-valuetext', label); speed.title = label;
    };
    updateSpeed();
    speed.addEventListener('input', updateSpeed);
    speed.addEventListener('change', () => { updateSpeed(); void this.plugin.saveKeys().catch(() => this.notice('显示速度保存失败')); });
    this.file = root.createEl('input', { type: 'file', cls: 'sd-file', attr: { accept: '.pdf,.png,.jpg,.jpeg,.webp,.gif', multiple:'', 'aria-label': '选择附件' } });
    this.file.addEventListener('change', () => { const files = [...(this.file.files || [])]; this.file.value = ''; if (files.length) void this.uploadFiles(files); });
    this.uploadButton = actions.createEl('button', { text: '上传 PDF / 图片' });
    this.uploadButton.addEventListener('click', () => this.file.click());
    this.sendButton = actions.createEl('button', { text: '发送', cls: 'mod-cta' });
    this.sendButton.addEventListener('click', () => { if (this.controller) this.controller.abort(); else void this.send(); });
    this.compressButton = actions.createEl('button', { text: '压缩', cls: 'sd-compress' });
    this.compressButton.addEventListener('click', () => { void this.manualCompress(); });
    const clear = this.clearButton = actions.createEl('button', { text: '清空' }); clear.title = '删除当前对话历史';
    clear.addEventListener('click', async () => {
      const accepted = await this.confirmAction({
        title: translate('清空当前对话', this.plugin.uiLanguage),
        message: translate('将当前会话文件移入系统回收站？可以从电脑回收站恢复。', this.plugin.uiLanguage),
        confirmText: translate('移入回收站', this.plugin.uiLanguage),
        danger: true
      });
      if (accepted && !this.closed) await this.clear();
    });
    actions.append(speedLine);
    const webLine = actions.createEl('label', {cls:'sd-web-toggle',attr:{title:'允许使用 Search / Fetch，下次发送生效'}});
    this.searchFetchToggle = webLine.createEl('input', {type:'checkbox',attr:{'aria-label':'启用 Search / Fetch'}}); this.searchFetchToggle.checked = this.plugin.webEnabled;
    webLine.createSpan({text:'Search / Fetch'});
    this.searchFetchToggle.addEventListener('change', () => { this.plugin.webEnabled = this.searchFetchToggle.checked; this.refreshStats(); void this.plugin.saveSession(); });
    const effortLine = actions.createEl('label', { cls: 'sd-thinking-effort' }); effortLine.createSpan({ text: '思考强度' });
    this.effortSelect = effortLine.createEl('select', { attr: { 'aria-label': '思考强度', title: 'DeepSeek 思考强度' } });
    for (const [value,label] of [['low','低'],['high','高'],['max','最大']]) { const option = this.effortSelect.createEl('option', { text: label }); option.value = value; }
    this.effortSelect.value = this.plugin.reasoningEffort;
    this.effortSelect.addEventListener('change', () => { this.plugin.reasoningEffort = this.effortSelect.value; void this.plugin.saveKeys().catch(() => this.notice('思考强度保存失败')); });
    feedShell.addEventListener('dragenter', event => { event.preventDefault(); this.dropZone.hidden = false; });
    feedShell.addEventListener('dragover', event => { event.preventDefault(); if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy'; this.dropZone.hidden = false; });
    feedShell.addEventListener('dragleave', event => { if (!feedShell.contains(event.relatedTarget)) this.dropZone.hidden = true; });
    feedShell.addEventListener('drop', event => { event.preventDefault(); this.dropZone.hidden = true; const files = [...(event.dataTransfer?.files || [])]; if (files.length) void this.uploadFiles(files); });
    for (const entry of this.session.entries) this.row(entry.label, entry.raw, entry);
    if (!this.virtualObserver) await Promise.all([...this.rows].map(state => this.render(state)));
    this.refreshLanguage();
    this.refreshNotebookTaskStatus();
    const Observer = root.ownerDocument.defaultView?.MutationObserver;
    if (Observer) {
      this.localeObserver = new Observer(changes => {
        if (this.closed) return;
        for (const change of changes) {
          if (change.type === 'attributes') this.localizeTree(change.target);
          else for (const node of change.addedNodes) this.localizeTree(node);
        }
      });
      this.localeObserver.observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ['aria-label', 'aria-valuetext', 'title', 'placeholder'] });
    }
  }
  refreshConversationOptions() {
    if (!this.conversationSelect) return;
    this.conversationSelect.empty();
    const counts = new Map();
    for (const item of this.plugin.conversations) {
      const title = this.plugin.conversationNames[item.id] || sessionTitle(item.session);
      const displayTitle = title === '新对话' ? translate(title, this.plugin.uiLanguage) : title;
      const count = (counts.get(displayTitle) || 0) + 1; counts.set(displayTitle, count);
      const option = this.conversationSelect.createEl('option', { text: count > 1 ? `${displayTitle} · ${count}` : displayTitle }); option.value = item.id;
    }
    this.conversationSelect.value = this.plugin.activeConversationId;
  }
  startRenameConversation() {
    if (this.controller || this.clearing || this.closed || this.renameInput || this.conversationTransition) return;
    const id = this.plugin.activeConversationId;
    const input = this.conversationSelect.ownerDocument.createElement('input');
    input.className = 'sd-conversation-name-input'; input.type = 'text';
    input.setAttribute('aria-label', translate('对话名称', this.plugin.uiLanguage));
    input.value = this.plugin.conversationNames[id] || sessionTitle(this.session);
    this.conversationSelect.hidden = true;
    this.conversationSelect.after(input); this.renameInput = input;
    let finished = false;
    const finish = save => {
      if (finished) return;
      finished = true;
      if (save) {
        const name = input.value.trim();
        if (name && name !== sessionTitle(this.session)) this.plugin.conversationNames[id] = name;
        else delete this.plugin.conversationNames[id];
        void this.plugin.saveSession();
      }
      input.remove(); this.renameInput = null; this.conversationSelect.hidden = false;
      this.refreshConversationOptions();
    };
    input.addEventListener('keydown', event => {
      if (event.key === 'Enter') { event.preventDefault(); event.stopPropagation(); finish(true); }
      else if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); finish(false); }
    });
    input.addEventListener('blur', () => finish(true));
    input.focus(); input.select();
  }
  async showConversation(id) {
    if (!this.plugin.activateConversation(id)) { this.refreshConversationOptions(); return; }
    const feed = this.feed;
    this.resetImages();
    this.notebookTaskBuffers.clear(); this.resumeNotebookTaskId = null;
    this.session = this.plugin.session; this.messages = this.session.messages;
    this.notebookSnapshot = this.session.notebookSnapshot || null;
    this.reconcileNotebookSnapshot(); this.refreshNotebookDeltaLabel();
    this.disposeRows(); this.feed.empty(); this.replyAnchor = null;
    for (const entry of this.session.entries) this.row(entry.label, entry.raw, entry);
    if (!this.virtualObserver) await Promise.all([...this.rows].map(state => this.render(state)));
    if (this.closed || this.feed !== feed) return;
    this.refreshConversationOptions(); this.refreshStats(); this.refreshNotebookTaskStatus(); this.status.textContent = ''; this.scroll();
  }
  async switchConversation(id) {
    if (id === this.plugin.activeConversationId) { this.refreshConversationOptions(); return; }
    await this.changeConversation(async () => { await this.showConversation(id); });
  }
  async newConversation() {
    await this.changeConversation(async () => {
      const item = this.plugin.addConversation();
      await this.showConversation(item.id);
      await this.plugin.saveSession();
      this.restoreComposerFocus(null, true);
    });
  }
  async changeConversation(work) {
    if (this.isBusy()) { this.refreshConversationOptions(); return; }
    const transition = {}, session = this.session;
    this.conversationTransition = transition;
    const controls = [this.conversationSelect,this.newConversationButton,this.renameConversationButton,this.sendButton,this.uploadButton,this.compressButton,this.clearButton,this.notebookAttach,this.runCellButton,this.runAllButton,this.resultButton,
      ...this.feed.querySelectorAll('.sd-delete-turn,.sd-notebook-apply,.sd-notebook-resume,.sd-notebook-regenerate')].map(control => [control,control.disabled]);
    for (const [control] of controls) control.disabled = true;
    try {
      await this.plugin.saveSession(session);
      if (this.closed || this.conversationTransition !== transition || this.session !== session) return;
      await work();
    } finally {
      if (this.conversationTransition === transition) {
        this.conversationTransition = null;
        if (!this.closed) {
          for (const [control,disabled] of controls) if (control.isConnected) control.disabled = disabled;
          for (const control of [this.runCellButton,this.runAllButton,this.resultButton]) control.disabled = !!this.notebookOperationToken;
          this.refreshPatchActions();
          this.refreshConversationOptions(); this.refreshNotebookTaskStatus();
        }
      }
    }
  }
  toggleNotebookMode() {
    this.notebookMode = !this.notebookMode; this.notebookPanel.hidden = !this.notebookMode;
    this.notebookToggle.classList.toggle('is-active', this.notebookMode);
    if (!this.notebookMode) this.disconnectNotebook();
    if (this.notebookMode && !this.notebookClient && this.plugin.jupyterExecutablePath && this.plugin.notebookFilePath) void this.connectNotebook();
    this.refreshStats();
  }
  findNext() {
    this.searchHit?.classList.remove('sd-search-hit'); this.searchHit = null;
    const query = this.searchInput.value.trim().toLocaleLowerCase(); if (!query) return;
    this.pauseFollowing();
    const entries = this.session.entries, start = Number.isInteger(this.searchIndex) ? this.searchIndex + 1 : 0;
    for (let offset = 0; offset < entries.length; offset++) {
      const index = (start + offset) % entries.length, entry = entries[index];
      if (!`${entry.label}\n${entry.displayText ?? entry.raw}\n${entry.thinking || ''}`.toLocaleLowerCase().includes(query)) continue;
      this.searchIndex = index; const state = [...this.rows].find(row => row.entry === entry); if (!state) return;
      state.virtualVisible = true; void this.render(state); state.element.scrollIntoView({ block: 'center', behavior: 'smooth' }); state.element.classList.add('sd-search-hit'); this.searchHit = state.element; return;
    }
    this.status.textContent = '当前对话中没有匹配内容';
  }
  setNotebookStatus(status, detail = '') {
    if (!this.notebookStatus || this.closed) return;
    const labels = { connecting: '正在连接…', connected: 'RTC 已连接', syncing: '正在同步…', executing: '正在运行…', disconnected: '未连接', conflict: '存在冲突' };
    this.notebookStatus.textContent = detail || labels[status] || status; this.notebookStatus.dataset.state = status;
  }
  async connectNotebook() {
    if (this.notebookClient || this.notebookConnectController || !this.notebookMode || this.closed) return;
    if (!this.plugin.jupyterExecutablePath || !this.plugin.notebookFilePath) { this.setNotebookStatus('disconnected', '请在顶部填写 Jupyter 启动程序和 Notebook 文件路径'); return; }
    const attempt = this.notebookAttempt = (this.notebookAttempt || 0) + 1;
    const connectController = new AbortController(); this.notebookConnectController = connectController;
    const cancelled = () => this.closed || !this.notebookMode || attempt !== this.notebookAttempt;
    let client, local;
    this.notebookConnect.disabled = true; this.setNotebookStatus('connecting');
    try {
      if (this.notebookShutdown) await this.notebookShutdown;
      if (cancelled()) return;
      local = await startLocalJupyter({ executablePath: this.plugin.jupyterExecutablePath, notebookFilePath: this.plugin.notebookFilePath, previous: { root: this.plugin.jupyterRoot, baseUrl: this.plugin.jupyterUrl, token: this.plugin.jupyterToken }, signal: connectController.signal });
      if (cancelled()) { await stopLocalJupyter(local); return; }
      this.localJupyter = local;
      this.plugin.jupyterUrl = local.baseUrl; this.plugin.jupyterToken = local.token; this.plugin.jupyterRoot = local.root; this.plugin.notebookPath = local.name;
      await this.plugin.saveKeys(false);
      if (cancelled()) { await stopLocalJupyter(local); return; }
      client = new JupyterRtcClient({ baseUrl: this.plugin.jupyterUrl, token: this.plugin.jupyterToken, notebookPath: this.plugin.notebookPath, fetchImpl: requestUrlFetch(requestUrl), onStatus: (status,error) => {
        if (cancelled() || this.notebookClient !== client) return;
        if (status === 'disconnected') { void this.disconnectNotebook(); if (error) this.setNotebookStatus('disconnected',error.message); }
        else this.setNotebookStatus(status);
      } });
      this.notebookClient = client;
      const notebook = await client.connect();
      if (cancelled() || this.notebookClient !== client) { client.close(); await stopLocalJupyter(local); return; }
      this.notebookSnapshot = this.session.notebookSnapshot || null; this.notebookLatest = notebook;
      this.reconcileNotebookSnapshot(); this.refreshNotebookDeltaLabel();
      this.stopNotebookChanges = client.onChange(value => {
        if (cancelled() || this.notebookClient !== client) return;
        this.notebookLatest = value; this.scheduleNotebookPreview(value); this.refreshNotebookDeltaLabel(); this.setNotebookStatus('connected', this.controller && this.activeNotebookEdit && this.activeTurn?.notebookAvailable ? 'RTC 已连接 · 手动修改将在下一步同步给 AI' : 'RTC 已连接 · Notebook 有新变化');
      });
      this.notebookPreview.hidden = false; this.notebookPreview.open = false; this.renderNotebookPreview(notebook);
      this.notebookConnect.textContent = '断开'; this.notebookConnect.disabled = false; this.setNotebookStatus('connected');
      this.refreshNotebookTaskStatus();
      this.logNotebookEvent('已连接 Jupyter RTC', `Notebook：${this.plugin.notebookPath}\n哈希：${notebookHash(notebook)}`);
      try { await shell.openExternal(local.browserUrl); } catch { this.notice('Notebook 已连接，但默认浏览器打开失败'); }
    } catch (error) {
      if (client && this.notebookClient === client) { client.close(); this.notebookClient = null; }
      if (this.localJupyter === local) this.localJupyter = null;
      await stopLocalJupyter(local);
      if (!cancelled()) { this.notebookConnect.disabled = false; this.setNotebookStatus('disconnected', error.message || 'RTC 连接失败'); }
    } finally { if (this.notebookConnectController === connectController) this.notebookConnectController = null; }
  }
  disconnectNotebook() {
    this.notebookAttempt = (this.notebookAttempt || 0) + 1;
    this.notebookConnectController?.abort(); this.notebookConnectController = null;
    clearTimeout(this.notebookPreviewTimer); this.notebookPreviewTimer = null;
    this.stopNotebookChanges?.(); this.stopNotebookChanges = null; this.notebookClient?.close(); this.notebookClient = null; this.notebookLatest = null;
    this.notebookOperationToken = null;
    for (const button of [this.runCellButton,this.runAllButton,this.resultButton]) if (button) button.disabled = !!this.conversationTransition;
    this.refreshPatchActions();
    const local = this.localJupyter; this.localJupyter = null;
    if (local?.child) {
      this.notebookShutdown = stopLocalJupyter(local).catch(() => {});
      this.plugin.jupyterUrl = ''; this.plugin.jupyterToken = ''; this.plugin.jupyterRoot = ''; this.plugin.notebookPath = '';
      void this.plugin.saveKeys(false).catch(() => {});
    } else this.notebookShutdown ||= Promise.resolve();
    this.refreshNotebookDeltaLabel();
    if (this.notebookPreview) { this.notebookPreview.hidden = true; this.renderNotebookPreview(null); }
    if (this.notebookConnect) { this.notebookConnect.textContent = '连接 Jupyter RTC'; this.notebookConnect.disabled = false; }
    this.setNotebookStatus('disconnected');
    this.refreshNotebookTaskStatus();
    return this.notebookShutdown;
  }
  notebookIdentity() { return notebookHash({cells:[{id:'notebook-location',cell_type:'raw',source:this.plugin.notebookFilePath || this.plugin.notebookPath || ''}]}); }
  notebookTask(id) {
    const stored = this.session.notebookTasks?.[id];
    if (stored?.discarded || stored?.invalidated || this.session.entries.some(entry => entry.notebookTaskId === id && entry.notebookTaskInvalidated) || (stored && stored.identity !== this.notebookIdentity())) return null;
    const cached = this.notebookTaskBuffers.get(id);
    if (cached && cached.identity === this.notebookIdentity()) return cached.buffer;
    if (!stored) return null;
    try { const buffer = NotebookEditBuffer.restore(stored.state); this.notebookTaskBuffers.set(id,{buffer,identity:stored.identity}); return buffer; } catch { return null; }
  }
  refreshNotebookTaskStatus() {
    if (!this.notebookTaskBar || this.closed) return;
    const task = this.notebookTask(this.session.activeNotebookTaskId);
    this.notebookTaskBar.hidden = !task || task.done;
    this.resumeNotebookButton.disabled = !!(this.controller || !notebookConnected(this.notebookClient) || this.applyingNotebookPatch || this.conversationTransition);
    this.discardNotebookButton.disabled = !!(this.controller || this.applyingNotebookPatch || this.conversationTransition);
    for (const button of this.feed?.querySelectorAll('.sd-notebook-resume') || []) button.disabled = !!(this.controller || !notebookConnected(this.notebookClient) || this.applyingNotebookPatch || this.conversationTransition);
    for (const state of this.rows) if (state.resumeButton && (!this.notebookTask(state.entry.notebookTaskId) || this.notebookTask(state.entry.notebookTaskId).done)) { state.resumeButton.remove(); state.resumeButton = null; }
  }
  async resumeNotebookTask(id) {
    if (this.controller || this.closed || this.clearing || this.conversationTransition || !id) return;
    const buffer = this.notebookTask(id);
    if (!buffer || buffer.done) { this.status.textContent = '暂存任务不可恢复，请基于最新 Notebook 重新生成'; return; }
    if (!notebookConnected(this.notebookClient)) { this.setNotebookStatus('disconnected','请先连接 Jupyter RTC'); return; }
    this.resumeNotebookTaskId = id; this.notebookMode = true; this.notebookPanel.hidden = false; this.notebookAttach.value = 'delta';
    if (!this.input.value.trim()) this.input.value = translate('继续生成尚未完成的 Notebook 修改。',this.plugin.uiLanguage);
    await this.send();
  }
  async discardNotebookTask(id) {
    if (this.controller || this.closed || this.conversationTransition || !id) return;
    if (this.session.notebookTasks?.[id]) this.session.notebookTasks[id].discarded = true;
    this.notebookTaskBuffers.delete(id);
    if (this.session.activeNotebookTaskId === id) delete this.session.activeNotebookTaskId;
    if (this.resumeNotebookTaskId === id) this.resumeNotebookTaskId = null;
    for (const state of this.rows) if (state.entry.notebookTaskId === id) state.resumeButton?.remove();
    this.refreshNotebookTaskStatus(); this.status.textContent = '已放弃暂存，原始对话记录保留。'; await this.plugin.saveSession();
  }
  pruneNotebookTasks(invalidatedTaskIds = new Set()) {
    for (const id of invalidatedTaskIds) {
      const envelope = this.session.notebookTasks?.[id];
      if (envelope) envelope.invalidated = true;
      for (const entry of this.session.entries) if (entry.notebookTaskId === id && !entry.notebookApplied) entry.notebookTaskInvalidated = true;
      this.notebookTaskBuffers.delete(id);
      if (this.session.activeNotebookTaskId === id) delete this.session.activeNotebookTaskId;
      if (this.resumeNotebookTaskId === id) this.resumeNotebookTaskId = null;
    }
    for (const [id,envelope] of Object.entries(this.session.notebookTasks || {})) {
      const entries = this.session.entries.filter(entry => entry.notebookTaskId === id);
      if (!entries.length) { delete this.session.notebookTasks[id]; this.notebookTaskBuffers.delete(id); if (this.session.activeNotebookTaskId === id) delete this.session.activeNotebookTaskId; continue; }
      if (envelope.invalidated || entries.some(entry => entry.notebookTaskInvalidated)) continue;
      const revision = Math.max(...entries.map(entry => entry.notebookTaskRevision || 0));
      if (revision < envelope.state.revision) {
        try {
          const restored = new NotebookEditBuffer(envelope.state.baseNotebook,{taskId:id});
          restored.baseMetadataHashes = envelope.state.baseMetadataHashes ? [...envelope.state.baseMetadataHashes] : null;
          restored.baseAttachmentHashes = envelope.state.baseAttachmentHashes ? [...envelope.state.baseAttachmentHashes] : null;
          for (const batch of envelope.state.batches.slice(0,revision)) restored.stage(batch);
          envelope.state = restored.exportState(); envelope.sourceReplyId = entries.at(-1).replyId;
          this.notebookTaskBuffers.set(id,{buffer:restored,identity:envelope.identity});
          if (!restored.done && !envelope.discarded) this.session.activeNotebookTaskId = id;
        } catch { delete this.session.notebookTasks[id]; this.notebookTaskBuffers.delete(id); }
      }
    }
    for (const id of this.notebookTaskBuffers.keys()) if (!this.session.entries.some(entry => entry.notebookTaskId === id)) this.notebookTaskBuffers.delete(id);
    if (!this.notebookTask(this.session.activeNotebookTaskId)) delete this.session.activeNotebookTaskId;
  }
  addNotebookResumeAction(state) {
    if (state.streaming || state.resumeButton || !state.entry.notebookTaskId || state.entry.notebookApplied) return;
    const buffer = this.notebookTask(state.entry.notebookTaskId);
    if (!buffer || buffer.done) return;
    const button = state.element.querySelector('.sd-message-footer').createEl('button',{cls:'sd-notebook-resume',text:'继续生成'}); state.resumeButton = button;
    button.disabled = !!(this.controller || !notebookConnected(this.notebookClient));
    button.addEventListener('click', () => void this.resumeNotebookTask(state.entry.notebookTaskId));
  }
  logNotebookEvent(title, detail = '', session = this.session) {
    const text = detail ? `**${title}**\n\n${detail}` : `**${title}**`;
    if (!this.plugin.conversations.some(item => item.session === session)) return;
    if (this.closed || session !== this.session) {
      session.entries.push({label:'Notebook 操作',raw:text,notebookEvent:true});
      void this.plugin.saveSession(session);
      return;
    }
    if (!this.feed) return;
    const state = this.row('Notebook 操作', text); state.entry.notebookEvent = true; void this.render(state); return state;
  }
  scheduleNotebookPreview(notebook) {
    if (this.closed || !this.notebookClient) return;
    this.notebookLatest = notebook;
    clearTimeout(this.notebookPreviewTimer); this.notebookPreviewTimer = null;
    if (this.closed || !this.notebookPreviewBody) return;
    if (!this.notebookPreview.open) { this.renderNotebookPreview(notebook); return; }
    this.notebookPreviewTimer = setTimeout(() => { this.notebookPreviewTimer = null; if (!this.closed && this.notebookClient) this.renderNotebookPreview(this.notebookLatest); }, 100);
  }
  resetNotebookDelta() {
    this.notebookSnapshot = null;
    delete this.session.notebookSnapshot;
    this.refreshNotebookDeltaLabel();
    this.plugin.scheduleSessionSave();
  }
  reconcileNotebookSnapshot() {
    if (!this.notebookSnapshot) return;
    const known = new Set();
    for (const message of this.messages) {
      if (message.role !== 'user') continue;
      const marker = message.content.lastIndexOf('[Notebook delta');
      try {
        if (marker >= 0) { const delta = JSON.parse(message.content.slice(marker).split('\n')[1]); if (delta.previousHash === null || known.has(delta.previousHash)) known.add(delta.currentHash); }
        if (message.content.startsWith('[Notebook edits applied]\n')) { const receipt = JSON.parse(message.content.split('\n')[1]); if (known.has(receipt.baseHash)) known.add(receipt.currentHash); }
      } catch {}
    }
    if (!known.has(this.notebookSnapshot.hash)) this.resetNotebookDelta();
  }
  refreshNotebookDeltaLabel() {
    if (!this.notebookAttachLabel) return;
    try {
      const notebook = this.notebookClient.read();
      const mode = this.notebookAttach.value;
      let count;
      if (mode === 'all') count = safeNotebook(notebook).cells.length;
      else { const delta = notebookDelta(notebook, this.notebookSnapshot); count = delta.changed.length + delta.removed.length; }
      const label = mode === 'all' ? '全部' : mode === 'none' ? '增量待发' : '待发';
      this.notebookAttachLabel.textContent = `${translate(label, this.plugin.uiLanguage)} ${count} ${translate('格', this.plugin.uiLanguage)}`;
    } catch { this.notebookAttachLabel.textContent = ''; }
  }
  renderNotebookPreview(notebook) {
    if (!this.notebookPreviewBody || this.closed) return;
    clearTimeout(this.notebookPreviewTimer); this.notebookPreviewTimer = null;
    this.notebookLatest = notebook;
    const count = Array.isArray(notebook?.cells) ? notebook.cells.length : 0, title = `Notebook · ${count} 个单元格`;
    if (this.notebookPreviewTitle.textContent !== translate(title, this.plugin.uiLanguage)) { this.notebookPreviewTitle.textContent = title; this.localizeTree(this.notebookPreviewTitle); }
    const states = this.notebookPreviewCells, openIds = this.notebookPreviewOpenIds;
    if (notebook && selectionInside(this.notebookPreviewBody)) { this.notebookPreviewSelectionDeferred = true; return; }
    this.notebookPreviewSelectionDeferred = false;
    if (!notebook || !this.notebookPreview.open) {
      clearTimeout(this.notebookPreviewTimer); this.notebookPreviewTimer = null;
      for (const [key,state] of states) {
        if (state.item.open) openIds.add(key); else openIds.delete(key);
        state.item.removeEventListener('toggle', state.onToggle);
      }
      states.clear(); this.notebookPreviewBody.replaceChildren();
      if (!notebook) { openIds.clear(); this.notebookPreviewInitialized = false; }
      return;
    }
    const cells = safeNotebook(notebook).cells, counts = new Map(), seen = new Set(), scrollTop = this.notebookPreviewBody.scrollTop;
    for (const cell of cells) counts.set(cell.cellId, (counts.get(cell.cellId) || 0) + 1);
    const fill = state => {
      if (!state.item.open) { if (state.body.childNodes.length) { state.body.replaceChildren(); state.sourceNode = null; state.outputNodes = []; } return; }
      if (!state.sourceNode) state.sourceNode = state.body.createEl('pre');
      if (state.sourceNode.textContent !== state.cell.source) state.sourceNode.textContent = state.cell.source;
      const values = state.cell.outputs.map(output => output.output_type === 'stream' ? output.text : output.output_type === 'error' ? output.traceback : Object.entries(output.data || {}).map(([mime,text]) => `${mime}\n${text}`).join('\n')).filter(Boolean);
      for (const [index,value] of values.entries()) {
        const node = state.outputNodes[index] || (state.outputNodes[index] = state.body.createEl('pre', {cls:'sd-notebook-output'}));
        if (node.textContent !== value) node.textContent = value;
      }
      while (state.outputNodes.length > values.length) state.outputNodes.pop().remove();
    };
    if (!cells.length) {
      for (const state of states.values()) state.item.removeEventListener('toggle', state.onToggle);
      states.clear(); openIds.clear();
      if (!this.notebookPreviewBody.querySelector('.sd-notebook-empty')) { this.notebookPreviewBody.replaceChildren(); const hint = this.notebookPreviewBody.createDiv({cls:'sd-hint sd-notebook-empty',text:'空 Notebook，可在 JupyterLab 页面添加单元格。'}); this.localizeTree(hint); }
      return;
    }
    this.notebookPreviewBody.querySelector('.sd-notebook-empty')?.remove();
    for (const cell of cells) {
      const key = counts.get(cell.cellId) === 1 ? cell.cellId : cell.cellId+'\0'+cell.index; seen.add(key);
      let state = states.get(key);
      if (!state) {
        const item = this.notebookPreviewBody.createEl('details', {cls:'sd-notebook-cell'}), summary = item.createEl('summary',{cls:'sd-notebook-cell-summary'}), body = item.createDiv({cls:'sd-notebook-cell-body'});
        item.dataset.cellId = cell.cellId; state = {item,summary,body,cell,sourceNode:null,outputNodes:[]};
        state.onToggle = () => {
          if (this.closed || !this.notebookPreview.open || states.get(key) !== state) return;
          if (item.open) openIds.add(key); else openIds.delete(key);
          if (selectionInside(this.notebookPreviewBody)) { this.notebookPreviewSelectionDeferred = true; return; }
          fill(state);
        };
        states.set(key,state); item.addEventListener('toggle',state.onToggle);
        item.open = openIds.has(key) || (!this.notebookPreviewInitialized && cell.index === 0);
      }
      state.cell = cell;
      if (state.item.open) openIds.add(key); else openIds.delete(key);
      const firstLine = cell.source.slice(0,80).split('\n',1)[0];
      const summary = `${cell.index + 1}. ${cell.cellType}${cell.executionCount == null ? '' : ` [${cell.executionCount}]`}${firstLine ? ` · ${firstLine}` : ''}`;
      if (state.summary.textContent !== summary) state.summary.textContent = summary;
      fill(state);
      const next = this.notebookPreviewBody.children[cell.index]; if (next !== state.item) this.notebookPreviewBody.insertBefore(state.item,next || null);
    }
    for (const [key,state] of states) if (!seen.has(key)) { state.item.removeEventListener('toggle',state.onToggle); state.item.remove(); states.delete(key); openIds.delete(key); }
    for (const key of openIds) if (!seen.has(key)) openIds.delete(key);
    this.notebookPreviewInitialized = true; this.notebookPreviewBody.scrollTop = scrollTop;
  }
  restoreComposerFocus(origin = null, force = false) {
    if (this.closed || !this.input?.isConnected) return;
    const doc = this.input.ownerDocument, active = doc.activeElement;
    if (!force && active !== doc.body && active !== origin && active !== this.input) return;
    if (!doc.hasFocus()) {
      this.pendingComposerFocus = true;
      this.pendingComposerFocusOrigin = origin || this.pendingComposerFocusOrigin || null;
      return;
    }
    this.pendingComposerFocus = false; this.pendingComposerFocusOrigin = null;
    this.input.focus({ preventScroll: true });
  }
  async notebookOperation(work) {
    if (!notebookConnected(this.notebookClient)) { this.setNotebookStatus('disconnected', '请先连接 Jupyter RTC'); return; }
    if (this.closed || this.conversationTransition || this.notebookOperationToken) return;
    const operation = {client:this.notebookClient,session:this.session}; this.notebookOperationToken = operation;
    operation.current = () => !this.closed && notebookConnected(operation.client) && this.notebookClient === operation.client && this.notebookOperationToken === operation;
    const doc = this.input.ownerDocument;
    const origin = doc.activeElement;
    const restoreComposerFocus = [this.runCellButton, this.runAllButton, this.resultButton].includes(origin) || origin?.classList?.contains('sd-notebook-apply');
    this.refreshPatchActions();
    for (const button of [this.runCellButton, this.runAllButton, this.resultButton]) button.disabled = true;
    try { await work(operation); }
    catch (error) { if (operation.current()) this.setNotebookStatus(error.message?.includes('变化') ? 'conflict' : 'connected', error.message || 'Notebook 操作失败'); }
    finally {
      if (operation.current()) {
        try { this.scheduleNotebookPreview(operation.client.read()); } catch {}
        for (const button of [this.runCellButton, this.runAllButton, this.resultButton]) button.disabled = !!this.conversationTransition;
        if (restoreComposerFocus) this.restoreComposerFocus(origin);
      }
      if (this.notebookOperationToken === operation) { this.notebookOperationToken = null; if (!this.closed) this.refreshPatchActions(); }
    }
  }
  async runNotebookCell() {
    await this.notebookOperation(async operation => {
      const index = Math.max(0, Number(this.notebookCellIndex.value || 1) - 1), result = await operation.client.executeCell(index);
      if (operation.current()) this.notebookLatest = result.notebook;
      this.logNotebookEvent(`运行单元格 ${(Number.isInteger(result.index) ? result.index : index) + 1}`, JSON.stringify(result.outputs, null, 2),operation.session);
    });
  }
  async runNotebookAll() {
    await this.notebookOperation(async operation => {
      const notebook = await operation.client.runAll({ clean: true, onProgress: (done, total) => { if (operation.current()) this.setNotebookStatus('executing', `全量运行 ${done}/${total}`); } });
      if (operation.current()) { this.notebookLatest = notebook; this.setNotebookStatus('connected'); }
      this.logNotebookEvent('全量运行完成', `Notebook 哈希：${notebookHash(notebook)}`,operation.session);
    });
  }
  async writeNotebookResult() {
    await this.notebookOperation(async operation => { const target = await operation.client.writeResultJson(); this.logNotebookEvent('已输出 result.json',target,operation.session); if (operation.current()) this.setNotebookStatus('connected'); });
  }
  confirmAction({ title, message, confirmText, danger = false }) {
    if (this.confirmationFinish) return Promise.resolve(false);
    const doc = this.contentEl.ownerDocument;
    const origin = doc.activeElement;
    return new Promise(resolve => {
      const overlay = this.contentEl.createDiv({ cls: 'sd-confirm-overlay' });
      const dialog = overlay.createDiv({ cls: 'sd-confirm', attr: { role: 'dialog', 'aria-modal': 'true', 'aria-label': title } });
      dialog.createEl('strong', { text: title });
      dialog.createEl('pre', { text: message });
      const actions = dialog.createDiv({ cls: 'sd-confirm-actions' });
      const cancel = actions.createEl('button', { text: translate('取消', this.plugin.uiLanguage) });
      const apply = actions.createEl('button', { text: confirmText, cls: danger ? 'mod-warning' : 'mod-cta' });
      let done = false;
      const finish = accepted => {
        if (done) return;
        done = true; overlay.remove(); this.confirmationFinish = null;
        this.restoreComposerFocus(origin, true);
        resolve(accepted);
      };
      this.confirmationFinish = () => finish(false);
      cancel.addEventListener('click', () => finish(false));
      apply.addEventListener('click', () => finish(true));
      overlay.addEventListener('click', event => { if (event.target === overlay) finish(false); });
      dialog.addEventListener('keydown', event => {
        if (event.key === 'Escape') { event.preventDefault(); finish(false); }
        else if (event.key === 'Tab') {
          event.preventDefault();
          (doc.activeElement === apply ? cancel : apply).focus();
        }
      });
      cancel.focus();
    });
  }
  confirmNotebookPatch(patch, rebased = false) {
    return this.confirmAction({
      title: translate('检查并应用 Notebook 修改', this.plugin.uiLanguage),
      message: `${rebased ? translate('已保留手动修改并重新定位无冲突的 AI 修改。',this.plugin.uiLanguage)+'\n\n' : ''}${translate('将通过 RTC 应用以下修改：', this.plugin.uiLanguage)}\n\n${describePatch(patch, this.plugin.uiLanguage)}\n\n${translate('确认后，Jupyter 页面会实时更新。', this.plugin.uiLanguage)}`,
      confirmText: translate('应用修改', this.plugin.uiLanguage)
    });
  }
  prepareNotebookPatch(state, patch, current) {
    const stored = this.session.notebookTasks?.[state.entry.notebookTaskId];
    if (state.entry.notebookTaskInvalidated || stored?.invalidated) throw Object.assign(Error('暂存任务不可恢复，请基于最新 Notebook 重新生成'),{code:'NOTEBOOK_MERGE_CONFLICT'});
    const cached = this.notebookTaskBuffers.get(state.entry.notebookTaskId), identity = this.notebookIdentity();
    if ([stored?.identity,cached?.identity,state.entry.notebookTaskIdentity].some(value => value && value !== identity)) throw Object.assign(Error('Notebook 连接或路径已变化，请基于最新 Notebook 重新生成'),{code:'NOTEBOOK_MERGE_CONFLICT'});
    const task = this.notebookTask(state.entry.notebookTaskId), base = task?.baseNotebook;
    if (base) {
      try { return rebaseNotebookPatch(base,current,patch,{baseMetadataHashes:task.baseMetadataHashes,baseAttachmentHashes:task.baseAttachmentHashes}); }
      catch (error) { if (error.code === 'NOTEBOOK_MERGE_CONFLICT') error.message = 'AI 修改与手动修改存在冲突，原笔记本已保留，请基于最新 Notebook 重新生成'; throw error; }
    }
    if (patch.baseHash !== notebookHash(current)) throw Object.assign(Error('Notebook 已在别处发生变化，请基于最新 Notebook 重新生成'),{code:'NOTEBOOK_MERGE_CONFLICT'});
    if (patch.operations.some(operation => operation.type === 'delete_cell')) rebaseNotebookPatch(current,current,patch,{baseAttachmentHashes:null});
    return {patch,rebased:false};
  }
  addNotebookRegenerateAction(state) {
    if (state.regenerateButton || this.closed || state.disposed) return;
    const button = state.element.querySelector('.sd-message-footer').createEl('button',{cls:'sd-notebook-regenerate',text:'基于最新 Notebook 重新生成'}); state.regenerateButton = button;
    button.addEventListener('click', () => {
      if (this.controller || this.applyingNotebookPatch || this.closed || this.conversationTransition) return;
      const index = this.session.entries.indexOf(state.entry), question = [...this.session.entries.slice(0,index)].reverse().find(entry => entry.label === '你');
      this.resumeNotebookTaskId = null;
      if (this.session.activeNotebookTaskId === state.entry.notebookTaskId) delete this.session.activeNotebookTaskId;
      this.notebookMode = true; this.notebookPanel.hidden = false; this.notebookAttach.value = 'delta';
      const prompt = translate('请基于最新 Notebook 重新生成修改，保留我手动做出的改动。',this.plugin.uiLanguage);
      this.input.value = (question?.raw ? question.raw+'\n\n' : '')+prompt+(this.input.value.trim() ? '\n\n'+this.input.value : '');
      this.refreshNotebookDeltaLabel(); this.restoreComposerFocus(null,true);
    });
  }
  refreshPatchActions() {
    for (const button of this.feed?.querySelectorAll('.sd-notebook-apply') || []) button.disabled = !!(this.controller || this.clearing || this.applyingNotebookPatch || this.conversationTransition || this.notebookOperationToken || button.closest('.sd-message')?.__sdState?.entry.notebookApplied);
  }
  canApplyNotebookPatch(state) { return !this.isBusy() && !state.disposed && this.session.entries.includes(state.entry) && !state.entry.notebookApplied; }
  addPatchAction(state) {
    if (this.closed || state.disposed || typeof parsePatch !== 'function' || state.patchButton || (state.streaming && !state.entry.notebookPatch) || state.entry.label === '你' || state.entry.notebookEvent) return;
    if (!state.entry.notebookApplied && (state.entry.notebookTaskInvalidated || this.session.notebookTasks?.[state.entry.notebookTaskId]?.invalidated)) { this.addNotebookRegenerateAction(state); return; }
    const index = this.session.entries.indexOf(state.entry);
    let fallbackHash = '';
    for (let i = index - 1; i >= 0; i--) if (this.session.entries[i].label === '你') {
      if (this.session.entries[i].notebookAttached) fallbackHash = notebookCurrentHash(this.session.entries[i].contextText);
      break;
    }
    let patch; try { patch = state.entry.notebookPatch || parsePatch(state.entry.raw, fallbackHash); } catch (error) { state.usageEl.textContent = error.message; return; }
    if (!patch) return;
    const button = state.element.querySelector('.sd-message-footer').createEl('button', { text: '检查并应用 Notebook 修改', cls: 'sd-notebook-apply' }); state.patchButton = button;
    button.disabled = !!(this.controller || this.clearing || this.applyingNotebookPatch || this.conversationTransition || this.notebookOperationToken);
    if (state.entry.notebookApplied) { button.disabled = true; button.textContent = state.entry.notebookUnverified ? '已提交，未确认同步' : '已同步'; }
    button.addEventListener('click', () => void this.notebookOperation(async operation => {
      if (!operation.current()) throw Error('请先连接 Jupyter RTC');
      if (!this.canApplyNotebookPatch(state)) throw Error('请等待当前回复结束后应用 Notebook 修改');
      let preview;
      try { preview = this.prepareNotebookPatch(state,patch,operation.client.read()); }
      catch (error) { this.addNotebookRegenerateAction(state); throw error; }
      if (!await this.confirmNotebookPatch(preview.patch,preview.rebased)) return;
      if (!operation.current()) {
        if (!this.closed && this.session === operation.session) this.status.textContent = translate('Notebook 连接已变化，请重新检查修改',this.plugin.uiLanguage);
        return;
      }
      if (!this.canApplyNotebookPatch(state)) throw Error('会话状态已变化，请重新检查 Notebook 修改');
      const targetSession = operation.session;
      state.entry.replyId ||= `reply-${Date.now().toString(36)}-${Math.random().toString(36).slice(2,10)}`;
      this.applyingNotebookPatch = true;
      const locked = [this.clearButton,this.conversationSelect,this.newConversationButton,this.renameConversationButton,this.sendButton,this.uploadButton,this.compressButton,this.notebookToggle,this.notebookAttach,this.notebookConnect].map(control => [control,control.disabled]);
      for (const [control] of locked) control.disabled = true;
      try {
      const before = operation.client.read(); let prepared;
      try { prepared = this.prepareNotebookPatch(state,patch,before); }
      catch (error) { this.addNotebookRegenerateAction(state); throw error; }
      if (JSON.stringify(prepared.patch.operations) !== JSON.stringify(preview.patch.operations)) throw Error('确认期间 Notebook 又发生变化，请重新检查修改');
      const manual = notebookDelta(before,this.notebookSnapshot), updates = [];
      if (manual.changed.length || manual.removed.length) updates.push({role:'user',content:notebookContext(manual)+'\n\n[Notebook live state before applying edits]\nThese live edits must be preserved; the following receipt describes only the applied AI operations.'});
      let notebook, unverified = false;
      try { notebook = await operation.client.applyPatch(prepared.patch); }
      catch (error) { if (!error.applied) throw error; notebook = error.notebook; unverified = true; }
      unverified ||= !operation.current();
      if (operation.current()) this.notebookLatest = notebook;
      button.disabled = true; button.textContent = unverified ? '已提交，未确认同步' : '已同步'; state.entry.notebookApplied = true; if (unverified) state.entry.notebookUnverified = true;
      const currentHash = notebookHash(notebook);
      const receipt = {role:'user',content:'[Notebook edits applied]\n'+JSON.stringify({baseHash:prepared.patch.baseHash,currentHash,verified:!unverified,...(prepared.rebased ? {rebasedFrom:patch.baseHash} : {}),operations:prepared.patch.operations.map(op => ({type:op.type,...(op.cellId ? {cellId:op.cellId} : {}),...(Number.isInteger(op.index) ? {index:op.index} : {})}))})};
      updates.push(receipt); targetSession.messages.push(...updates); targetSession.meter = null;
      if (targetSession.activeNotebookTaskId === state.entry.notebookTaskId) delete targetSession.activeNotebookTaskId;
      const detail = `${describePatch(prepared.patch)}\n\nNotebook 哈希：${currentHash}`, title = unverified ? 'AI 修改已提交，未确认同步' : 'AI 修改已通过 RTC 同步';
      if (this.session === targetSession && !this.closed) {
        const event = this.logNotebookEvent(title, detail);
        if (event) { event.entry.modelMessages = updates; event.entry.sourceReplyId = state.entry.replyId; }
        if (!unverified && operation.current()) { this.notebookSnapshot = notebookSnapshot(notebook); targetSession.notebookSnapshot = this.notebookSnapshot; }
        this.refreshNotebookDeltaLabel(); this.refreshStats(); this.refreshNotebookTaskStatus();
        if (unverified && operation.current()) this.setNotebookStatus('conflict','修改已提交，但服务器确认失败；请在 Jupyter 中核对，不要重复应用');
      } else targetSession.entries.push({label:'Notebook 操作',raw:'**'+title+'**\n\n'+detail,notebookEvent:true,modelMessages:updates,sourceReplyId:state.entry.replyId});
      await this.plugin.saveSession(targetSession);
      } finally {
        this.applyingNotebookPatch = false;
        if (!this.closed) {
          for (const [control,disabled] of locked) if (control !== this.notebookConnect) control.disabled = disabled;
          this.notebookConnect.disabled = !!this.notebookConnectController;
        }
        this.refreshNotebookTaskStatus();
      }
    }));
  }
  showNotebookPatchPreview(state) {
    if (!state.disposed && !this.closed) state.patchView?.refresh();
  }
  row(label, text = '', entry = null, references = '', images = []) {
    if (!entry) { entry = { label, raw: text, ...(references ? { references } : {}), ...(images.length ? {images:images.map(imageMetadata).filter(Boolean)} : {}) }; this.session.entries.push(entry); this.plugin.scheduleSessionSave(); }
    const row = this.feed.createDiv({ cls: 'sd-message' });
    const head = row.createDiv({ cls: 'sd-message-head' }); head.createSpan({ text: label });
    const copy = head.createEl('button', { cls: 'sd-icon-button', attr: { 'aria-label': '复制' + label, title: '复制 Markdown' } });
    const thinkingBox = row.createEl('details', { cls: 'sd-thinking' }); thinkingBox.hidden = !entry.thinking;
    thinkingBox.createEl('summary', { text: '思考过程' });
    const thinkingBody = thinkingBox.createDiv({ cls: 'sd-thinking-body' });
    const body = row.createDiv({ cls: 'sd-body' });
    const patchHost = row.createDiv({ cls: 'sd-notebook-patch-view' });
    const sourcesBox = row.createEl('details',{cls:'sd-sources'}), sourcesSummary = sourcesBox.createEl('summary'), sourcesBody = sourcesBox.createDiv({cls:'sd-sources-body'});
    if (entry.images?.length) {
      const attachments = row.createDiv({cls:'sd-image-references'});
      for (const image of entry.images) attachments.createSpan({cls:'sd-image-name',text:image.name});
    }
    const usageEl = row.createDiv({ cls: 'sd-usage', text: entry.usage ? formatUsage(entry.usage, entry.durationMs, this.plugin.uiLanguage) : entry.usageText || '' });
    const footer = row.createDiv({ cls: 'sd-message-footer' });
    const copyBottom = footer.createEl('button', { cls: 'sd-icon-button', attr: { 'aria-label': '复制' + label, title: '复制 Markdown' } });
    for (const button of [copy, copyBottom]) setIcon(button, 'copy');
    const index = this.session.entries.indexOf(entry);
    if (index > 0 && this.session.entries[index - 1].label === '你' && label !== '你' && !label.startsWith('MinerU')) {
      const trash = footer.createEl('button', { cls: 'sd-icon-button sd-delete-turn', attr: { 'aria-label': '删除本轮对话', title: '删除本轮对话并恢复输入' } });
      setIcon(trash, 'trash-2'); trash.disabled = !!(this.controller || this.conversationTransition);
      trash.addEventListener('click', () => { void this.deleteTurn(entry).catch(() => { this.status.textContent = '对话已在内存中删除，但存档保存失败'; }); });
    }
    const state = { element: row, entry, thinkingBox, thinkingBody, sourcesBox, body, usageEl, raw: '', version: 0, rendered: -1, timer: null, running: null, component: null, inflight: null, disposed: false };
    state.thinkingView = new ThinkingView({details:thinkingBox,body:thinkingBody,getText:() => state.entry.thinking || '',feed:this.feed,
      onBeforeRender:follow => !!follow && this.canFollow(state),
      onAfterRender:follow => { if (follow && !state.disposed && !this.closed && thinkingBox.open) this.scroll(); }
    });
    state.sourceList = new SourceList({details:sourcesBox,body:sourcesBody,summary:sourcesSummary,getSources:() => state.entry.sources || [],getLanguage:() => this.plugin.uiLanguage});
    state.patchView = new NotebookPatchView({host:patchHost,getPatch:() => state.entry.notebookPatch,getLanguage:() => this.plugin.uiLanguage,visible:!this.virtualObserver});
    state.thinkingView.setVisible(!this.virtualObserver); state.sourceList.setVisible(!this.virtualObserver);
    row.__sdState = state; state.virtualVisible = !this.virtualObserver; this.virtualObserver?.observe(row);
    this.rows.add(state);
    for (const button of [copy, copyBottom]) button.addEventListener('click', () => { void navigator.clipboard.writeText(normalizeMath(messageMarkdown(state.entry,this.plugin.uiLanguage))).catch(() => this.notice('无法访问剪贴板，请手动选择文本复制')); });
    this.update(state, text); if (entry.notebookPatch) this.addPatchAction(state); this.localizeTree(row); this.scroll(); return state;
  }
  async selectTextRange(text, name, signal, format = 'md') {
    check(signal); if (estimateText(text) <= 100000) return format === 'tex' ? withOutlineContext(text,text,[{start:0,end:text.length}]) : text;
    return new Promise((resolve, reject) => {
      const weights = new Uint32Array(text.length + 1); let offset=0,total=0;
      for (const char of text) { const cost=char.charCodeAt(0)<128?3:6; for(let j=1;j<char.length;j++)weights[offset+j]=total;offset+=char.length;total+=cost;weights[offset]=total; }
      const parsed=outline(text,format),tocMode=format==='tex'&&parsed.reliable;
      const nodes=parsed.headings.map(h=>({...h}));if(nodes.length&&nodes[0].start>0)nodes.unshift({start:0,end:nodes[0].start,level:0,title:'前言 / 导言区',systemTitle:true});
      const units=nodes.map((n,i)=>({start:n.start,end:nodes[i+1]?.start??text.length}));const selected=new Set(units.map((_,i)=>i)),checks=[];
      const panel=this.contentEl.createDiv({cls:'sd-range-picker',attr:{role:'dialog','aria-modal':'true','aria-label':'选择文本范围'}});
      panel.createEl('strong',{text:'选择发送范围'});panel.createDiv({cls:'sd-range-name',text:name});
      panel.createDiv({cls:'sd-hint',text:tocMode?'已识别标准 LaTeX 章节。勾选目录选择内容，父级包含子章节，token 不重复计算。':'单文件超过约 100k tokens。拖动两端选择连续文本；首尾预览显示所在标题。'});
      const count=panel.createDiv({cls:'sd-range-count'}),track=panel.createDiv({cls:'sd-range-track'});
      const toc=panel.createDiv({cls:'sd-outline-list'});toc.hidden=!tocMode;track.hidden=tocMode;
      const start=track.createEl('input',{type:'range',cls:'sd-range-start',attr:{min:'0',max:String(text.length),step:'1','aria-label':'范围起点'}});
      const end=track.createEl('input',{type:'range',cls:'sd-range-end',attr:{min:'0',max:String(text.length),step:'1','aria-label':'范围终点'}});start.value='0';end.value=String(text.length);
      let preview=null,startTitle,startPreview,endTitle,endPreview;
      if(!tocMode){preview=panel.createDiv({cls:'sd-range-preview'});const first=preview.createDiv({cls:'sd-range-preview-pane'}),last=preview.createDiv({cls:'sd-range-preview-pane'});startTitle=first.createDiv({cls:'sd-range-preview-title'});startPreview=first.createEl('pre',{cls:'sd-range-preview-text'});endTitle=last.createDiv({cls:'sd-range-preview-title'});endPreview=last.createEl('pre',{cls:'sd-range-preview-text'});}
      const actions=panel.createDiv({cls:'sd-range-actions'});
      const all=actions.createEl('button',{text:tocMode?'全选':'全文'}),none=tocMode?actions.createEl('button',{text:'全不选'}):null,cancel=actions.createEl('button',{text:'取消'}),confirm=actions.createEl('button',{text:'使用所选范围',cls:'mod-cta'});
      let lo=0,hi=text.length,done=false,ranges=[{start:0,end:text.length}];
      if(tocMode)for(const n of nodes){const line=toc.createEl('label',{cls:'sd-outline-item'});line.style.paddingLeft=(Math.max(0,n.level)*10)+'px';const box=line.createEl('input',{type:'checkbox',attr:{'aria-label':n.title}});const indices=units.map((u,i)=>u.start>=n.start&&u.start<n.end?i:-1).filter(i=>i>=0);line.createSpan({cls:'sd-outline-heading',text:n.systemTitle?translate(n.title,this.plugin.uiLanguage):n.title,attr:n.systemTitle?{'data-sd-system-title':n.title}:{}});line.createSpan({cls:'sd-outline-tokens',text:'约 '+Math.ceil((weights[n.end]-weights[n.start])/10).toLocaleString('en-US')+' tokens'});checks.push({box,indices});box.addEventListener('change',()=>{for(const i of indices){if(box.checked)selected.add(i);else selected.delete(i);}update();});}
      const boundary=n=>n>0&&n<text.length&&text.charCodeAt(n)>=0xdc00&&text.charCodeAt(n)<=0xdfff?n-1:n;
      const update=changed=>{
        lo=boundary(Number(start.value));hi=boundary(Number(end.value));
        if(lo>hi){if(changed===start)hi=lo;else lo=hi;}start.value=String(lo);end.value=String(hi);
        ranges=tocMode?mergeRanges([...selected].map(i=>units[i])):[{start:lo,end:hi}];
        if(tocMode){for(const {box,indices} of checks){const n=indices.filter(i=>selected.has(i)).length;box.checked=n===indices.length;box.indeterminate=n>0&&n<indices.length;}lo=ranges[0]?.start||0;hi=ranges.at(-1)?.end||0;}
        const tokens=Math.ceil(ranges.reduce((n,r)=>n+weights[r.end]-weights[r.start],0)/10);confirm.disabled=!ranges.length||lo===hi;
        count.textContent='已选约 '+tokens.toLocaleString('en-US')+' / '+Math.ceil(total/10).toLocaleString('en-US')+' tokens · '+(lo/text.length*100).toFixed(1)+'%–'+(hi/text.length*100).toFixed(1)+'%';
        start.setAttribute('aria-valuetext','约第 '+Math.ceil(weights[lo]/10)+' token');end.setAttribute('aria-valuetext','约第 '+Math.ceil(weights[hi]/10)+' token');
        track.style.setProperty('--range-start',(lo/text.length*100)+'%');track.style.setProperty('--range-end',(hi/text.length*100)+'%');
        if(preview){startTitle.textContent='起点所在标题：'+headingAt(parsed.headings,lo);endTitle.textContent='终点所在标题：'+headingAt(parsed.headings,Math.max(lo,hi-1));startPreview.textContent=ranges.length?text.slice(lo,Math.min(ranges[0].end,lo+400)):'';endPreview.textContent=ranges.length?text.slice(Math.max(ranges.at(-1).start,hi-400),hi):'';startTitle.title=startTitle.textContent;endTitle.title=endTitle.textContent;startPreview.scrollTop=0;endPreview.scrollTop=endPreview.scrollHeight;}
      };
      const finish=(error,value)=>{if(done)return;done=true;signal.removeEventListener('abort',abort);panel.remove();this.restoreComposerFocus(null,true);if(error)reject(error);else resolve(value);};
      const abort=()=>{const error=new Error('已取消范围选择');error.name='AbortError';finish(error);};
      start.addEventListener('input',()=>update(start));end.addEventListener('input',()=>update(end));
      all.addEventListener('click',()=>{start.value='0';end.value=String(text.length);for(let i=0;i<units.length;i++)selected.add(i);update();});
      if(none)none.addEventListener('click',()=>{selected.clear();update();});
      cancel.addEventListener('click',()=>{this.controller?.abort();abort();});confirm.addEventListener('click',()=>{if(hi>lo){const selectedText=ranges.map(r=>text.slice(r.start,r.end)).join('\n\n');finish(null,format==='tex'?withOutlineContext(text,selectedText,ranges,parsed):selectedText);}});
      panel.addEventListener('keydown',e=>{if(e.key==='Escape'){e.preventDefault();cancel.click();}else if(e.key==='Tab'){const controls=[...panel.querySelectorAll('input,button')].filter(c=>!c.disabled&&!c.closest('[hidden]'));const current=controls.indexOf(panel.ownerDocument.activeElement);e.preventDefault();controls[(current+(e.shiftKey?-1:1)+controls.length)%controls.length].focus();}});
      signal.addEventListener('abort',abort,{once:true});if(signal.aborted){abort();return;}update();(tocMode?checks[0]?.box:start)?.focus();
    });
  }
  async deleteTurn(entry) {
    if (this.isBusy()) return;
    const index = this.session.entries.indexOf(entry), user = this.session.entries[index - 1];
    if (index < 1 || user?.label !== '你') return;
    const compressed = !!this.session.compactions;
    const asMessages = entryMessages;
    const suffix = this.session.entries.slice(index - 1).flatMap(asMessages);
    const offset = this.messages.length - suffix.length;
    const direct = offset >= 0 && suffix.every((m, i) => JSON.stringify(copyMessage(this.messages[offset + i])) === JSON.stringify(copyMessage(m)));
    const retainedSuffix = this.session.entries.slice(index - 1).filter(item => item !== user && item !== entry && !(entry.replyId && item.sourceReplyId === entry.replyId));
    const invalidatedTaskIds = new Set(entry.notebookTaskId && retainedSuffix.some(item => item.notebookTaskId === entry.notebookTaskId) ? [entry.notebookTaskId] : []);
    this.session.entries.splice(index - 1,this.session.entries.length-index+1,...retainedSuffix);
    this.pruneNotebookTasks(invalidatedTaskIds);
    if (direct) this.messages.splice(offset, suffix.length,...retainedSuffix.flatMap(asMessages));
    else { this.messages.splice(0, this.messages.length, ...rebuildEntryMessages(this.session.entries)); this.session.compactions = 0; }
    this.session.meter = null;
    this.reconcileNotebookSnapshot(); this.refreshNotebookDeltaLabel();
    this.disposeRows(); this.feed.empty(); this.replyAnchor = null;
    for (const item of this.session.entries) this.row(item.label, item.raw, item);
    this.hideMentions(); const draft = this.input.value;
    this.input.value = user.raw + (draft.trim() ? '\n\n' + draft : ''); this.restoreComposerFocus(null, true); this.input.setSelectionRange(0, user.raw.length);
    for (const image of user.images || []) if (this.images.get(image.id) && !this.pendingImages.some(value => value.id === image.id)) { this.pendingImages.push(image); this.images.setPinned([image.id],true); }
    this.refreshPendingImages();
    this.refreshConversationOptions(); this.refreshStats(); this.refreshNotebookTaskStatus(); this.status.textContent = compressed && !direct ? '已删除本轮；原压缩摘要已移除，上下文由剩余对话重建。' : '已删除本轮，原提问已放回输入框。';
    await this.plugin.saveSession();
  }
  hideMentions() { this.mentionTicket = (this.mentionTicket || 0) + 1; if (this.mentionPopup) this.mentionPopup.hidden = true; }
  mentionAtCursor() {
    const range = this.mentionRange;
    return range && this.input.selectionStart === range.end && this.input.selectionEnd === range.end && this.input.value.slice(0,range.end) === range.prefix;
  }
  async updateMentions() {
    const cursor = this.input.selectionStart, before = this.input.value.slice(0, cursor);
    const match = /(?:^|\s)@([^\s@\[\]]*)$/.exec(before);
    if (!match || this.controller || this.clearing || this.closed) { this.hideMentions(); return; }
    const ticket = this.mentionTicket = (this.mentionTicket || 0) + 1;
    this.mentionRange = { start: cursor - match[1].length - 1, end: cursor, prefix: before }; const query = match[1];
    const libraryPath = this.plugin.libraryPath;
    try {
      if (!this.libraryRecords || this.libraryRecordsPath !== libraryPath || Date.now() - this.libraryScannedAt > 3000) {
        if (!this.libraryScan || this.libraryScan.path !== libraryPath) this.libraryScan = {path:libraryPath,promise:scanLibrary(libraryPath)};
        const scan = this.libraryScan;
        let records;
        try { records = await scan.promise; } finally { if (this.libraryScan === scan) this.libraryScan = null; }
        if (ticket !== this.mentionTicket || this.closed || this.plugin.libraryPath !== libraryPath) return;
        this.libraryRecords = records; this.libraryRecordsPath = libraryPath; this.libraryScannedAt = Date.now();
      }
      if (ticket !== this.mentionTicket || this.closed || this.plugin.libraryPath !== libraryPath) return;
      if (!this.mentionAtCursor()) { this.hideMentions(); return; }
      this.mentionItems = searchRecords(this.libraryRecords, query);
      try { const id = arxivId(query); if (!findRecord(this.libraryRecords, id)) this.mentionItems.unshift({ id, title: ARXIV_IMPORT_HINT, authors: '', systemHint: true }); } catch {}
      this.mentionPopup.empty(); this.mentionPopup.hidden = false; this.mentionIndex = 0;
      if (!this.mentionItems.length) this.mentionPopup.createDiv({ text: '未找到文献；可输入完整 arXiv 编号入库', cls: 'sd-hint' });
      for (const [i, item] of this.mentionItems.entries()) {
        const button = this.mentionPopup.createEl('button', { attr: { role: 'option', 'aria-selected': String(i === 0) } });
        button.createSpan({ text: item.id, cls: 'sd-mention-id' }); button.createSpan({ text: item.systemHint ? translate(item.title, this.plugin.uiLanguage) : item.title, cls: 'sd-mention-title' });
        button.addEventListener('mousedown', event => event.preventDefault()); button.addEventListener('click', () => this.selectMention(i));
      }
    } catch (error) { if (ticket === this.mentionTicket && !this.closed) { if (!this.mentionAtCursor()) { this.hideMentions(); return; } this.mentionItems = []; this.mentionPopup.empty(); this.mentionPopup.createDiv({ cls: 'sd-hint', text: '无法读取文献库，请检查顶部路径设置。' }); this.mentionPopup.hidden = false; } }
  }
  selectMention(index) {
    if (!this.mentionAtCursor()) { this.hideMentions(); return; }
    const item = this.mentionItems?.[index]; if (!item || !this.mentionRange) return;
    const {start,end} = this.mentionRange; const mention = '@[' + item.id + '] ';
    this.input.value = this.input.value.slice(0,start) + mention + this.input.value.slice(end);
    this.input.setSelectionRange(start + mention.length, start + mention.length); this.restoreComposerFocus(null, true); this.hideMentions();
  }
  mentionKey(event) {
    if (event.isComposing || event.keyCode === 229 || this.mentionPopup?.hidden) return false;
    if (!this.mentionAtCursor()) { this.hideMentions(); return false; }
    if (event.key === 'Escape') { event.preventDefault(); this.hideMentions(); return true; }
    if (['ArrowUp','ArrowDown'].includes(event.key) && this.mentionItems?.length) {
      event.preventDefault(); this.mentionIndex = (this.mentionIndex + (event.key === 'ArrowDown' ? 1 : -1) + this.mentionItems.length) % this.mentionItems.length;
      [...this.mentionPopup.querySelectorAll('button')].forEach((button,i) => button.setAttribute('aria-selected',String(i===this.mentionIndex))); return true;
    }
    if ((event.key === 'Enter' && !event.shiftKey) || event.key === 'Tab') { if (this.mentionItems?.length) { event.preventDefault(); this.selectMention(this.mentionIndex); return true; } }
    return false;
  }
  jumpReply(direction) {
    this.pauseFollowing();
    if (this.closed) return;
    const replies = [...this.rows].filter(state => !state.disposed && state.entry.label !== '你' && !state.entry.label.startsWith('MinerU'));
    if (!replies.length) return;
    const top = this.feed.scrollTop;
    const origin = this.feed.getBoundingClientRect().top + this.feed.clientTop;
    const positions = replies.map(state => state.element.getBoundingClientRect().top - origin + top);
    let current = -1;
    if (this.replyAnchor && Math.abs(this.replyAnchor.top - top) < 2) current = replies.indexOf(this.replyAnchor.state);
    else for (let i = 0; i < positions.length; i++) if (positions[i] <= top + 8) current = i;
    const index = Math.max(0, Math.min(replies.length - 1, current + direction));
    this.feed.scrollTop = Math.max(0, positions[index]);
    this.replyAnchor = { state: replies[index], top: this.feed.scrollTop };
  }
  refreshStats() {
    if (!this.metrics || this.closed) return;
    const stats = sessionStats(this.session, this.plugin.uiLanguage,this.activeRequestMetadata || this.requestMetadata());
    if (!this.metricNodes) {
      this.metrics.replaceChildren();
      this.metricNodes = ['sd-metric-label','sd-metric-value','sd-metric-separator','sd-metric-label','sd-metric-value','sd-metric-note'].map(cls => this.metrics.createSpan({cls}));
    }
    for (let index = 0; index < stats.parts.length; index++) {
      const node = this.metricNodes[index], value = stats.parts[index];
      if (node.textContent === value) continue;
      if (index === 5) { node.replaceChildren(); if (value) node.createSpan({cls:'sd-metric-note-text',text:value}); }
      else node.textContent = value;
    }
    if (this.metrics.getAttribute('aria-label') !== stats.text) this.metrics.setAttribute('aria-label',stats.text);
    if (this.metrics.title !== stats.detail) this.metrics.title = stats.detail;
  }
  hasImages() { return !!(this.pendingImages.length || this.session.entries.some(entry => entry.images?.length)); }
  currentCapabilities() {
    const notebookMode = !!this.notebookMode, notebookSendMode = notebookMode ? this.notebookAttach.value : 'none';
    return {webEnabled:this.plugin.webEnabled,imagesEnabled:this.hasImages(),notebookMode,notebookSendMode,notebookEnabled:notebookMode && notebookSendMode !== 'none' && notebookConnected(this.notebookClient)};
  }
  requestMetadata() {
    const capabilities = this.currentCapabilities();
    return {model:this.plugin.model,systemPrompt:buildSystemPrompt(capabilities),includeReasoning:capabilities.webEnabled || capabilities.imagesEnabled || capabilities.notebookEnabled};
  }
  requestPrompt() { return this.requestMetadata().systemPrompt; }
  refreshPendingImages() {
    if (!this.pendingImageList || this.closed) return;
    this.pendingImageList.empty(); this.pendingImageList.hidden = !this.pendingImages.length;
    for (const image of this.pendingImages) {
      const item = this.pendingImageList.createDiv({cls:'sd-pending-image'});
      item.createSpan({cls:'sd-image-name',text:image.name});
      const remove = item.createEl('button',{cls:'sd-icon-button',attr:{title:'移除图片','aria-label':'移除图片'}}); setIcon(remove,'x');
      remove.disabled = !!this.controller;
      remove.addEventListener('click', () => {
        if (this.controller || this.closed) return;
        this.pendingImages = this.pendingImages.filter(value => value.id !== image.id); this.images.setPinned([image.id],false);
        if (!this.session.entries.some(entry => entry.images?.some(value => value.id === image.id))) this.images.remove(image.id);
        this.refreshPendingImages(); this.refreshStats(); this.restoreComposerFocus(null,true);
      });
    }
  }
  resetImages() { this.images.clear(); this.pendingImages = []; this.refreshPendingImages(); }
  async visionOptions(key, signal, reasoningEffort, imageIds = [], question = '') {
    const capabilities = await this.plugin.modelCatalog.get(key,'deepseek-flash',signal); check(signal);
    assertReasoningEffort(capabilities,reasoningEffort);
    if (!capabilities.inputModalities.includes('image')) throw Error('当前识图模型不支持图片输入，请稍后重试');
    const imageInputTokens = imageIds.length * 1024 + estimateText(question) + estimateText(JSON.stringify(this.images.metadata(imageIds))) + 512;
    const maxOutputTokens = Math.min(capabilities.maxOutputTokens,capabilities.contextWindow-contextReserve(capabilities)-imageInputTokens);
    if (maxOutputTokens < 1) throw Error('当前模型的上下文空间不足以识别图片');
    return {key,signal,reasoningEffort,maxOutputTokens,progress:value => { if (!signal.aborted && !this.closed) this.status.textContent = value; }};
  }
  scheduleStatsRefresh() {
    if (this.statsTimer || this.closed) return;
    this.statsTimer = setTimeout(() => { this.statsTimer = null; this.refreshStats(); }, 1000);
  }
  showUsage(state, usage, durationMs) {
    if (state.disposed || this.closed) return;
    state.entry.usage = usage || null;
    state.entry.durationMs = durationMs || null;
    state.entry.usageText = formatUsage(usage, durationMs, this.plugin.uiLanguage);
    state.usageEl.textContent = state.entry.usageText;
  }
  scroll() {
    if (typeof this.feed.scrollTo === 'function') this.feed.scrollTo({top:this.feed.scrollHeight,behavior:'instant'});
    else this.feed.scrollTop = this.feed.scrollHeight;
    this.feedScrollTop = this.feed.scrollTop;
  }
  startFollowing(state) { this.followingReply = state; this.followPaused = false; this.feedScrollTop = this.feed.scrollTop; }
  endFollowing(state) { if (this.followingReply === state) { this.followingReply = null; this.followPaused = true; } }
  pauseFollowing() { this.followPaused = true; }
  resumeFollowing() { this.followPaused = false; if (this.followingReply) this.followingReply.lastScrollSet = 0; }
  canFollow(state) { return !!(this.followingReply === state && state.streaming && !state.disposed && !this.closed && !this.followPaused && !this.controller?.signal.aborted && !selectionInside(this.feed)); }
  update(state, text, record = true, schedule = true) {
    if (state.disposed || this.closed) return;
    state.raw = text; if (record) state.entry.raw = text; state.version++;
    if (schedule && !state.timer) state.timer = setTimeout(() => { state.timer = null; void this.render(state); }, 100);
  }
  revealDelta(state, chunk) {
    if (state.disposed || this.closed || !chunk) return;
    const now = Date.now();
    state.raw += chunk; state.version++;
    if (!state.tail) {
      state.tail = state.body.createSpan({ cls: 'sd-stream-tail' });
      state.tailText = state.body.ownerDocument.createTextNode(''); state.tail.append(state.tailText);
      state.committed = 0;
    }
    state.tailText.appendData(chunk);
    if (!state.timer && !state.running && state.raw.length > state.committed) {
      state.timer = setTimeout(() => { state.timer = null; void this.render(state); }, STREAM_MARKDOWN_MS);
    }
    if (this.canFollow(state) && (!state.lastScrollSet || now - state.lastScrollSet >= 50)) { this.scroll(); state.lastScrollSet = now; }
  }
  attachTail(stage, tail, raw) {
    // Stay inside the final text block, never inside a link, emphasis or MathJax tree.
    let host = stage, node = stage.lastElementChild;
    const boundary = /\n[ \t]*\n$/.test(raw);
    if (!boundary) {
      while (node) {
        if (node.matches('.math, .math-block, mjx-container, table, hr')) break;
        if (node.matches('p, h1, h2, h3, h4, h5, h6, td, th')) { host = node; break; }
        if (node.matches('pre')) {
          if (!/\n[ \t]*(?:`{3,}|~{3,})[ \t]*\n?$/.test(raw)) host = node.querySelector('code') || node;
          break;
        }
        if (node.matches('li')) host = node;
        if (!node.matches('div, section, blockquote, ul, ol, li')) break;
        node = node.lastElementChild;
      }
    }
    host.append(tail);
  }
  async render(state) {
    if (state.timer) { clearTimeout(state.timer); state.timer = null; }
    if (state.disposed || this.closed) return;
    state.sourceList?.refresh(); if (!state.streaming) state.thinkingView?.refresh();
    if (state.entry.notebookPatch) this.addPatchAction(state);
    if (this.virtualObserver && !state.virtualVisible && !state.streaming) return;
    this.showNotebookPatchPreview(state);
    if (state.running) { await state.running; return this.render(state); }
    if (state.rendered === state.version) return;
    if (selectionInside(state.body)) { this.selectionDeferredRows.add(state); return; }
    const version = state.version;
    const raw = state.raw;
    if (state.streaming && raw.length <= (state.committed || 0)) return;
    const displayText = state.entry.notebookEvent ? translateNotebookEvent(raw, this.plugin.uiLanguage)
      : isImageNotice(state.entry) ? translate(raw, this.plugin.uiLanguage) : state.streaming ? raw : messageMarkdown({...state.entry,raw},this.plugin.uiLanguage,false,false);
    const expressions = [];
    const markdown = normalizeMath(displayText, expression => expressions.push(expression));
    const stage = state.body.ownerDocument.createElement('div'); stage.className = 'markdown-rendered sd-markdown';
    const component = new Component(); this.addChild(component); state.inflight = component;
    state.running = (async () => {
      try {
        const chunks = splitMarkdown(markdown);
        if (chunks.length === 1) await MarkdownRenderer.render(this.app, markdown, stage, '', component);
        else for (const chunk of chunks) { const part = stage.ownerDocument.createElement('div'); part.className = 'sd-markdown-chunk'; stage.append(part); await MarkdownRenderer.render(this.app, chunk, part, '', component); }
        annotateMath(stage, expressions);
      } catch {
        stage.replaceChildren(); stage.classList.add('sd-render-fallback'); stage.textContent = markdown;
      }
      if (state.disposed || this.closed || (!state.streaming && version !== state.version)) { this.removeChild(component); return; }
      if (selectionInside(state.body)) { this.selectionDeferredRows.add(state); this.removeChild(component); return; }
      const nearBottom = this.canFollow(state);
      if (state.component) this.removeChild(state.component);
      state.component = component;
      if (state.streaming) {
        state.committed = raw.length;
        state.tailText.data = state.raw.slice(raw.length);
        this.attachTail(stage, state.tail, raw);
        state.body.replaceChildren(stage);
      } else { state.body.replaceChildren(stage); state.tail = null; }
      state.body.style.minHeight = '';
      state.rendered = version;
      if (!state.streaming) { this.addPatchAction(state); this.addNotebookResumeAction(state); }
      if (nearBottom) this.scroll(); this.scheduleStatsRefresh();
    })();
    try { await state.running; }
    finally { state.running = null; state.inflight = null; }
    if (!state.disposed && !this.closed && state.rendered !== state.version) {
      if (state.streaming) {
        if (!state.timer) state.timer = setTimeout(() => { state.timer = null; void this.render(state); }, STREAM_MARKDOWN_MS);
      } else await this.render(state);
    }
  }
  disposeRows() {
    this.replyAnchor = null;
    this.searchHit = null;
    this.followingReply = null; this.followPaused = true;
    for (const state of this.rows) {
      this.selectionDeferredRows?.delete(state);
      this.thinkingCollapseDeferredRows?.delete(state);
      this.virtualObserver?.unobserve(state.element);
      state.disposed = true; state.raw = ''; clearTimeout(state.timer);
      state.thinkingView?.dispose(); state.sourceList?.dispose(); state.patchView?.dispose();
      if (state.component) this.removeChild(state.component);
      if (state.inflight) this.removeChild(state.inflight);
    }
    this.rows.clear();
  }
  virtualize(state) {
    if (state.streaming || state.running || state.disposed || !state.component) return;
    if (selectionInside(state.body)) { this.selectionDeferredRows.add(state); return; }
    const height = Math.max(24, Math.ceil(state.body.getBoundingClientRect?.().height || state.body.scrollHeight || 0));
    state.body.style.minHeight = height + 'px'; state.body.replaceChildren(); this.removeChild(state.component); state.component = null; state.rendered = -1;
  }
  async run(work) {
    if (this.isBusy()) return;
    const doc = this.input.ownerDocument;
    const origin = doc.activeElement;
    const restoreComposerFocus = origin === this.input || origin === this.sendButton;
    const controller = new AbortController(); this.controller = controller;
    const requestKeys = {...this.plugin.keys};
    const targetSession = this.session; this.refreshPendingImages(); this.refreshNotebookTaskStatus();
    for (const button of this.feed.querySelectorAll('.sd-delete-turn')) button.disabled = true;
    for (const button of this.feed.querySelectorAll('.sd-notebook-apply')) button.disabled = true;
    this.sendButton.textContent = '停止'; this.sendButton.title = '停止当前操作'; this.uploadButton.disabled = true; this.compressButton.disabled = true; this.effortSelect.disabled = true;
    this.conversationSelect.disabled = true; this.newConversationButton.disabled = true; this.renameConversationButton.disabled = true; this.notebookAttach.disabled = true;
    try { await work(controller.signal); }
    catch (error) {
      if (this.controller === controller && !this.closed) {
        if (!controller.signal.aborted && (!error.authService || requestKeys[error.authService] === this.plugin.keys[error.authService])) this.plugin.openExpiredKeyPage(error);
        this.status.textContent = controller.signal.aborted ? '已停止。云端已提交的解析任务可能继续运行。' : (error.message || '操作失败，请重试');
      }
    } finally {
      await this.plugin.saveSession(targetSession);
      if (this.controller === controller) {
        this.controller = null;
        this.activeTurn = null; this.activeRequestMetadata = null;
        this.followingReply = null; this.followPaused = true;
        for (const state of this.rows) if (state.entry.notebookTaskId) { if (controller.signal.aborted) state.streaming = false; this.addNotebookResumeAction(state); this.addPatchAction(state); }
        for (const button of this.feed.querySelectorAll('.sd-delete-turn')) button.disabled = false;
        this.refreshPatchActions();
        if (!this.closed) {
          this.refreshStats(); this.sendButton.textContent = '发送'; this.sendButton.title = ''; this.sendButton.disabled = false; this.uploadButton.disabled = false; this.compressButton.disabled = false; this.effortSelect.disabled = false; this.conversationSelect.disabled = false; this.newConversationButton.disabled = false; this.renameConversationButton.disabled = false; this.notebookAttach.disabled = false;
          this.refreshPendingImages(); this.refreshNotebookTaskStatus(); this.activeNotebookEdit = null;
          if (restoreComposerFocus) this.restoreComposerFocus(origin);
        }
      }
    }
  }
  async compress(key, signal, extra = 0, model = this.plugin.model, force = false, capabilities = null, reasoningEffort = this.plugin.reasoningEffort, systemPrompt = this.requestPrompt(), includeReasoning = this.requestMetadata().includeReasoning) {
    const limits = capabilities || await this.plugin.modelCatalog.get(key, model, signal); check(signal);
    assertReasoningEffort(limits, reasoningEffort);
    const result = await compactContext(this.session, key, signal, text => { if (!signal.aborted && !this.closed) this.status.textContent = text; }, (...args) => { args[5] = { ...args[5], model, reasoningEffort }; return chat(...args); }, extra, force, systemPrompt, limits, model, includeReasoning);
    check(signal); this.refreshStats();
    if (result) { this.resetNotebookDelta(); await this.plugin.saveSession(); }
    return result;
  }
  async manualCompress() {
    if (this.controller || this.clearing || this.closed) return;
    if (!this.messages.length) { this.status.textContent = '暂无可压缩的上下文'; return; }
    if (!this.plugin.keys.deepseek) { this.status.textContent = '请先填写 DeepSeek 密钥'; return; }
    await this.run(async signal => { await this.compress(this.plugin.keys.deepseek, signal, 0, this.plugin.model, true); check(signal); this.status.textContent = ''; });
  }
  async send() {
    const submittedDraft = this.input.value;
    const text = submittedDraft.trim();
    if ((!text && !this.pendingImages.length) || this.controller || this.clearing || this.closed || this.conversationTransition) return;
    if (!this.plugin.keys.deepseek) { this.status.textContent = '请先填写 DeepSeek 密钥'; return; }
    const key = this.plugin.keys.deepseek; const model = this.plugin.model;
    const libraryPath = this.plugin.libraryPath, mineruKey = this.plugin.keys.mineru;
    const reasoningEffort = this.plugin.reasoningEffort;
    const turn = new TurnContext({...this.currentCapabilities(),session:this.session,model,reasoningEffort,notebookClient:this.notebookClient,notebookIdentity:this.notebookIdentity(),notebookEpoch:this.notebookAttempt,
      currentNotebook:() => this.closed ? null : {client:this.notebookClient,identity:this.notebookIdentity(),epoch:this.notebookAttempt}});
    const {webEnabled,imagesEnabled,notebookSendMode} = turn;
    const resumeTaskId = this.resumeNotebookTaskId || null;
    const attachments = this.pendingImages.map(image => ({...image}));
    const imageQuestion = text || 'Describe the attached images.';
    const userText = text || attachments.map(image => image.name).join('\n');
    const requestContext = requestTimeContext();
    const targetSession = turn.session;
    await this.run(async signal => {
      this.activeTurn = turn;
      this.hideMentions();
      const capabilities = await this.plugin.modelCatalog.get(key, model, signal); check(signal);
      assertReasoningEffort(capabilities, reasoningEffort);
      let initialImageUsage = null, initialImageResult = null, initialImageDurationMs = 0;
      if (attachments.length) {
        const started = Date.now();
        const options = await this.visionOptions(key,signal,reasoningEffort,attachments.map(image => image.id),imageQuestion);
        initialImageResult = await this.images.describe(attachments.map(image => image.id),imageQuestion,{...options,onUsage:reported => {
          initialImageUsage = addUsage(initialImageUsage,reported); recordCacheUsage(targetSession,reported);
          if (this.session === targetSession && !this.closed) this.refreshStats();
          if (signal.aborted || this.closed || this.session !== targetSession) void this.plugin.saveSession(targetSession);
        }}); check(signal);
        initialImageDurationMs = Date.now()-started;
      }
      const composeImages = (reuse = true) => initialImageResult ? imageReference(initialImageResult,imageQuestion,{history:this.messages,reuse}) : '';
      const allowedImageIds = new Set([...this.session.entries.flatMap(entry => entry.images || []),...attachments].map(image => image.id));
      const imageTools = imagesEnabled ? {execute:async (args,{onUsage}) => {
        if (args.imageIds.some(id => !allowedImageIds.has(id))) throw Error('图片不属于当前会话，请重新附加图片');
        const options = await this.visionOptions(key,signal,reasoningEffort,args.imageIds,args.question); check(signal);
        const result = await this.images.describe(args.imageIds,args.question,{...options,region:args.region,onUsage}); check(signal);
        return {kind:'image_description',images:result.images,question:args.question,...(args.region ? {region:args.region} : {}),description:result.text,cached:result.cached};
      }} : null;
      const available = capabilities.contextWindow - contextReserve(capabilities);
      const webMaterials = [], sources = [];
      const addSource = source => { if (source && typeof source.url === 'string' && !sources.some(item => item.url === source.url)) sources.push({url:source.url,title:source.title || source.url}); };
      const web = new WebReferences({key,signal,http:this.plugin.webHttp,existingMessages:this.messages,
        onStatus:value => { if (!signal.aborted && !this.closed) this.status.textContent = value; },
        onReference:material => { webMaterials.push(material); addSource(material); },
        selectText:(body,name) => this.selectTextRange(body,name,signal)
      });
      const urls = webEnabled ? extractWebMentions(text).filter(url => { try { arxivId(url); return false; } catch { return true; } }) : [];
      const webUrlSet = new Set(urls);
      for (const url of urls) { const result = JSON.parse(await web.execute('fetch_page',{url})); addSource(result); check(signal); }
      const libraryText = text.replace(/@\[(https?:\/\/(?:\[[^\]\r\n]+\]|[^\]\r\n])*)\]/gi,(match,url) => { if (webEnabled) return webUrlSet.has(publicWebUrl(url)) ? url : match; try { arxivId(url); return match; } catch { return url; } });
      const materials = [];
      const fullExpanded = text ? await expandMentions(libraryText, libraryPath, mineruKey, signal, value => { if (!signal.aborted && !this.closed) this.status.textContent = value; }, parseFile, { materials, selectText: (body, name, format) => this.selectTextRange(body, name, signal, format) }) : userText; check(signal); this.libraryRecords = null;
      let notebookExtra = '', sentNotebookSnapshot = null, notebookForEdits = null;
      const refreshNotebookExtra = () => {
        if (notebookSendMode === 'none') return;
        notebookForEdits = turn.readNotebook();
        if (!notebookForEdits) { notebookExtra = ''; sentNotebookSnapshot = null; return; }
        this.reconcileNotebookSnapshot();
        const delta = notebookDelta(notebookForEdits, notebookSendMode === 'all' ? null : this.notebookSnapshot);
        notebookExtra = notebookContext(delta); sentNotebookSnapshot = delta.snapshot;
      };
      refreshNotebookExtra();
      const notebookIdentity = turn.notebookIdentity;
      const editBuffer = notebookExtra && notebookForEdits ? (resumeTaskId ? this.notebookTask(resumeTaskId) : new NotebookEditBuffer(notebookForEdits)) : null;
      if (resumeTaskId && (!editBuffer || editBuffer.done)) throw Error('暂存任务不可恢复，请基于最新 Notebook 重新生成');
      if (editBuffer) this.notebookTaskBuffers.set(editBuffer.taskId,{buffer:editBuffer,identity:notebookIdentity});
      const editTaskContext = () => editBuffer && turn.notebookAvailable ? '\n\n[Notebook edit task]\n'+JSON.stringify({resumed:!!resumeTaskId,...editBuffer.status()})+'\nUse this task currentHash for staged edits. The live Notebook delta may describe a newer version; edits remain unapplied until review. Read pendingSource to inspect accepted incomplete source before continuing.' : '';
      let systemPrompt,includeReasoning;
      const metadata = {model};
      const updateRequestMetadata = () => {
        includeReasoning = turn.includeReasoning;
        systemPrompt = buildSystemPrompt({webEnabled,imagesEnabled,notebookMode:turn.notebookMode,notebookEnabled:!!editBuffer && turn.notebookAvailable});
        Object.assign(metadata,{systemPrompt,includeReasoning});
        this.activeRequestMetadata = metadata;
      };
      updateRequestMetadata();
      const webText = (deduplicate = false, history = this.messages, includeReuseMetadata = true) => {
        const seen = new Set();
        return (web.retainedMaterials || webMaterials).filter(material => { if (seen.has(material.hash)) return false; seen.add(material.hash); return true; }).map(material => {
          const sourceMetadata = Object.fromEntries(['retrieved_at','text_kind','date','rerank_score','authority','site_name'].filter(field => material[field] !== undefined).map(field => [field,material[field]]));
          if (deduplicate && hasOriginal(history,material.content,material.hash)) return includeReuseMetadata ? '\n\n[Web reference metadata]\n'+JSON.stringify({url:material.url,hash:material.hash,...sourceMetadata}) : '';
          return '\n\n'+referenceMarker(material.hash)+'\nURL: '+material.url+'\nTitle: '+material.title.replace(/[\r\n]/g,' ')+'\nMetadata: '+JSON.stringify(sourceMetadata)+'\n\n'+material.content;
        }).join('');
      };
      const composeWeb = () => webText(true);
      const compose = () => (materials.length ? deduplicateMentions(libraryText, materials, this.messages) : fullExpanded) + composeWeb() + composeImages() + notebookExtra + editTaskContext() + requestContext;
      let expanded = compose();
      const extra = estimateMessages([{role:'user',content:expanded}]);
      if (extra >= available) throw Error('单次输入超过上下文可用空间，请缩小引用或选择更短范围');
      await this.compress(key, signal, extra, model, false, capabilities, reasoningEffort, systemPrompt, includeReasoning); check(signal); refreshNotebookExtra();
      expanded = compose();
      if (estimateMessages([{role:'user',content:expanded}]) > extra) { await this.compress(key, signal, estimateMessages([{role:'user',content:expanded}]), model, false, capabilities, reasoningEffort, systemPrompt, includeReasoning); check(signal); refreshNotebookExtra(); expanded = compose(); }
      if (contextTokens(this.session, metadata) + estimateMessages([{role:'user',content:expanded}]) >= available) throw Error('本轮输入和现有上下文仍超过可用空间，请缩小引用或选择更短范围');
      let observedLiveSnapshot = notebookForEdits ? notebookSnapshot(notebookForEdits) : null;
      updateRequestMetadata();
      const tools = turnTools(turn.notebookAvailable ? editBuffer : null,webEnabled,imageTools), schemaTokens = tools.length ? estimateText(JSON.stringify(tools)) + 16 : 0;
      outputBudget(this.session,estimateMessages([{role:'user',content:expanded}])+schemaTokens,capabilities,metadata);
      if (this.input.value === submittedDraft) this.input.value = '';
      const submittedNotebookContext = notebookExtra + editTaskContext();
      this.resumeNotebookTaskId = null; const question = this.row('你', userText, null, text && fullExpanded !== libraryText ? fullExpanded.slice(libraryText.length).trim() : '',attachments); question.entry.contextText = fullExpanded + webText() + composeImages(false) + submittedNotebookContext + requestContext; if (notebookExtra) question.entry.notebookAttached = true;
      if (initialImageResult) question.entry.imageAnalysis = {question:imageQuestion,model:'deepseek-flash',cached:initialImageResult.cached};
      this.pendingImages = this.pendingImages.filter(image => !attachments.some(sent => sent.id === image.id)); this.images.setPinned(attachments.map(image => image.id),false); this.refreshPendingImages(); this.refreshConversationOptions();
      const output = this.row(model); let answer = '';
      output.entry.replyId = `reply-${Date.now().toString(36)}-${Math.random().toString(36).slice(2,10)}`; output.entry.modelMessages = [];
      output.entry.requestCapabilities = {webEnabled,tools:tools.map(tool => tool.function.name)};
      if (editBuffer) output.entry.notebookTaskIdentity = notebookIdentity;
      this.activeNotebookEdit = editBuffer;
      this.status.textContent = '正在思考…';
      const user = { role: 'user', content: expanded };
      this.messages.push(user); this.refreshStats();
      clearTimeout(output.timer); output.timer = null; output.streaming = true;
      this.startFollowing(output);
      const pacer = new TextPacer({ incremental: true, frameMs: 32, getRate: () => this.plugin.displayTokensPerSecond, signal, onFrame: async chunk => {
        if (signal.aborted || this.closed || output.disposed) return;
        this.revealDelta(output, chunk);
      }});
      let answerStarted = false, responsePhase = 'thinking', lastToolProgressAt = 0, lastToolProgressName = '';
      output.thinkingView.setShown(0);
      const syncThinkingShown = () => {
        if (signal.aborted || this.closed || output.disposed) return;
        const direct = this.plugin.displayTokensPerSecond === 0 || !output.thinkingBox.open || answerStarted || output.thinkingPlaybackFailed;
        output.thinkingShown = Math.max(output.thinkingShown || 0,direct ? (output.entry.thinking || '').length : thinkingPacer.shown);
        output.thinkingView.setShown(output.thinkingShown);
      };
      const thinkingPacer = new TextPacer({ incremental: true, frameMs: 48, getRate: () => output.thinkingBox.open ? this.plugin.displayTokensPerSecond : 0, signal, onFrame: () => {
        syncThinkingShown();
      }});
      const thinkingDisplay = thinkingPacer.run().then(() => null, error => {
        if (signal.aborted) return error;
        output.thinkingPlaybackFailed = true; syncThinkingShown(); return null;
      });
      const displaying = pacer.run().then(() => null, error => error);
      let usage, failure, notebookAvailabilityNotified = false;
      const notifyNotebookUnavailable = () => {
        if (!editBuffer || turn.notebookAvailable || notebookAvailabilityNotified) return;
        notebookAvailabilityNotified = true;
        const update = {role:'user',content:'[Notebook unavailable]\nThe Notebook connection used by this request was disconnected or replaced. Do not read or stage further Notebook edits in this turn. Previously accepted edits remain staged and unapplied. Continue the conversation using the remaining available tools, or answer normally. A new connection is available only to a new user turn.'};
        targetSession.messages.push(update); output.entry.modelMessages.push(update); targetSession.meter = null; this.plugin.scheduleSessionSave(targetSession);
      };
      try {
        const requestStarted = Date.now()-initialImageDurationMs;
        const result = await runToolTurn({key,session:targetSession,signal,model,reasoningEffort,systemPrompt,capabilities,web:webEnabled ? web : null,webEnabled,notebook:editBuffer,notebookAvailable:() => turn.notebookAvailable,images:imageTools,userText,send:chat,
          beforeRequest:async extra => {
            if (editBuffer) {
              const latest = turn.readNotebook(), delta = latest ? notebookDelta(latest,observedLiveSnapshot) : null;
              if (delta && (delta.changed.length || delta.removed.length)) {
                const update = {role:'user',content:notebookContext(delta)+'\n\n[Notebook changed during generation]\nThe user changed the live Notebook. Preserve those changes. The edit task is still based on its original snapshot; use the task currentHash, not this live hash, for staging. Reconciliation is required before applying. Task: '+JSON.stringify(editBuffer.status())};
                targetSession.messages.push(update); output.entry.modelMessages.push(update); targetSession.meter = null; this.plugin.scheduleSessionSave(targetSession);
                observedLiveSnapshot = delta.snapshot; sentNotebookSnapshot = delta.snapshot;
              }
            }
            notifyNotebookUnavailable();
            await this.compress(key,signal,extra,model,false,capabilities,reasoningEffort,systemPrompt,turn.includeReasoning); check(signal);
            notifyNotebookUnavailable();
          },
          onCheckpoint:async state => {
            if (!editBuffer?.status().started) return;
            output.entry.notebookTaskId = editBuffer.taskId; output.entry.notebookTaskRevision = editBuffer.revision;
            output.entry.notebookTaskIdentity = notebookIdentity;
            if (editBuffer.done) { output.entry.notebookPatch = editBuffer.result(); this.addPatchAction(output); this.showNotebookPatchPreview(output); }
            if (state) {
              (targetSession.notebookTasks ||= Object.create(null))[editBuffer.taskId] = {state,identity:notebookIdentity,sourceReplyId:output.entry.replyId};
              if (!editBuffer.done) targetSession.activeNotebookTaskId = editBuffer.taskId;
              else if (targetSession.activeNotebookTaskId === editBuffer.taskId) delete targetSession.activeNotebookTaskId;
            } else if (!signal.aborted && !this.closed) this.status.textContent = '源码含图片或二进制数据，暂存任务仅在本次运行中可恢复';
            await this.plugin.saveSession(targetSession,true);
          },
          onStatus:value => { if (!signal.aborted && !this.closed) { responsePhase = 'status'; this.status.textContent = value; } },
          onToolProgress:progress => {
            if (signal.aborted || this.closed || output.disposed || !Number.isSafeInteger(progress?.totalArgumentCharacters) || progress.totalArgumentCharacters < 0) return;
            const now = Date.now();
            if (responsePhase === 'tool' && progress.name === lastToolProgressName && now - lastToolProgressAt < 100) return;
            responsePhase = 'tool'; lastToolProgressAt = now; lastToolProgressName = progress.name;
            const label = progress.name === 'stage_notebook_edits' ? '正在生成 Notebook 修改…' : '正在生成工具请求…';
            this.status.textContent = translate(label,this.plugin.uiLanguage)+' · '+progress.totalArgumentCharacters.toLocaleString()+' '+(this.plugin.uiLanguage === 'en' ? 'characters' : '字符');
          },
          onRawText:delta => { if (signal.aborted || this.closed || output.disposed) return; output.entry.raw += delta; this.plugin.scheduleSessionSave(targetSession); },
          onProtocolIssue:event => {
            if (signal.aborted || this.closed || output.disposed) return;
            output.entry.displayText = answer; (output.entry.protocolRecovery ||= []).push({attempt:event.attempt,recovered:event.recovered});
            this.status.textContent = event.recovered ? '正在思考…' : '模型返回了文字形式的工具请求，正在纠正调用方式…';
            this.plugin.scheduleSessionSave(targetSession);
          },
          onMessage:message => { output.entry.modelMessages.push(message); this.plugin.scheduleSessionSave(targetSession); },
          onRecord:record => {
            if (record.error || record.unfinishedToolCalls?.length || record.rejectedToolCalls?.length) (output.entry.failedRequests ||= []).push(record);
            if (record.type === 'tool_result') { try { const data = JSON.parse(record.message.content); for (const source of data.results || [data]) addSource(source); } catch {} }
          },
          onUsage:(reported,assistant,request) => {
            recordCacheUsage(targetSession,reported);
            if (signal.aborted || this.closed || this.session !== targetSession) return;
            const requestMetadata = {...metadata,includeReasoning:request?.includeReasoning ?? includeReasoning};
            if (!request?.auxiliary) this.activeRequestMetadata = requestMetadata;
            if (!request?.auxiliary) rememberUsage(targetSession,reported,requestMetadata);
            if (!request?.auxiliary && !requestMetadata.includeReasoning && assistant?.reasoning_content && Number.isFinite(reported?.prompt_tokens) && !Number.isFinite(reported?.completion_tokens_details?.reasoning_tokens)) targetSession.meter = {tokens:reported.prompt_tokens+estimateText(assistant.content)+8,count:targetSession.messages.length,estimated:true,...requestMetadata};
            this.refreshStats();
          },
          onText:delta => {
          if (!signal.aborted && !this.closed) {
            if (delta && !answerStarted) {
              answerStarted = true;
              if (selectionInside(output.thinkingBody)) this.thinkingCollapseDeferredRows.add(output);
              else { output.thinkingBox.open = false; output.thinkingView.refresh(); }
              thinkingPacer.skip(); this.status.textContent = '正在回答…';
            }
            if (delta && responsePhase !== 'answer') { responsePhase = 'answer'; this.status.textContent = '正在回答…'; }
            answer += delta; if (output.entry.displayText !== undefined) output.entry.displayText = answer; this.plugin.scheduleSessionSave(targetSession); pacer.push(delta);
          }
        }, onThinking: delta => {
          if (!delta || signal.aborted || this.closed || output.disposed) return;
          if (responsePhase !== 'thinking') { responsePhase = 'thinking'; this.status.textContent = '正在思考…'; }
          output.entry.thinking = (output.entry.thinking || '') + delta;
          output.thinkingBox.hidden = false;
          thinkingPacer.push(delta); syncThinkingShown(); this.plugin.scheduleSessionSave(targetSession);
        } });
        usage = addUsage(initialImageUsage,result.usage); if (result.patch) output.entry.notebookPatch = result.patch;
        if (sources.length) output.entry.sources = sources;
        check(signal);
        if (sentNotebookSnapshot && turn.notebookAvailable) { this.notebookSnapshot = sentNotebookSnapshot; targetSession.notebookSnapshot = sentNotebookSnapshot; this.refreshNotebookDeltaLabel(); this.plugin.scheduleSessionSave(targetSession); }
        this.showUsage(output, usage, Math.max(1, Date.now() - requestStarted)); this.refreshStats();
      } catch (error) {
        failure = error;
        if (error.toolProtocolError) output.entry.toolProtocolError = error.toolProtocolError;
        if (error.stagedPatch) output.entry.notebookPatch = error.stagedPatch;
        if (sources.length) output.entry.sources = sources;
        if (!signal.aborted) { if (initialImageUsage || error.turnUsage || error.usage) this.showUsage(output, addUsage(initialImageUsage,error.turnUsage || error.usage)); this.refreshStats(); }
      } finally {
        question.entry.contextText = fullExpanded + webText(true,output.entry.modelMessages,false) + composeImages(false) + submittedNotebookContext + requestContext;
        if (output.entry.raw !== answer) output.entry.displayText = answer;
        pacer.finish(); thinkingPacer.finish(); await this.plugin.saveSession(targetSession);
      }
      if (!signal.aborted && pacer.pending) this.status.textContent = failure ? '连接已结束，正在显示已接收的部分内容…' : '回复已接收完毕，正在按本地显示速度继续渲染…';
      const displayError = await displaying; const thinkingError = await thinkingDisplay;
      if (signal.aborted || displayError || thinkingError) this.endFollowing(output);
      output.thinkingView.finish();
      if (signal.aborted && !this.closed && !output.disposed && this.session === targetSession) {
        clearTimeout(output.timer); output.timer = null;
        // Keep the text already shown, and invalidate any unfinished Markdown snapshot.
        output.streaming = false; output.version++; output.rendered = output.version;
        output.sourceList.refresh();
        this.showNotebookPatchPreview(output);
      }
      check(signal);
      if (displayError) throw displayError;
      if (thinkingError) throw thinkingError;
      output.streaming = false; this.endFollowing(output); output.version++;
      if (output.entry.notebookPatch) void this.render(output).catch(() => { this.showNotebookPatchPreview(output); });
      else await abortableTask(this.render(output),signal);
      check(signal);
      this.addNotebookResumeAction(output); this.refreshNotebookTaskStatus();
      if (failure) throw failure;
      if (!answer.trim() && !output.entry.notebookPatch) throw new Error('服务未返回文本，请重试');
      await this.compress(key, signal, 0, model, false, capabilities, reasoningEffort, systemPrompt,turn.includeReasoning); check(signal);
      this.status.textContent = '';
    });
  }
  async upload(file) { return this.uploadFiles([file]); }
  async uploadFiles(candidates, fromClipboard = false) {
    if (this.controller || this.clearing || this.closed) return;
    const targetSession = this.session;
    const mineruKey = this.plugin.keys.mineru;
    await this.run(async signal => {
      for (const candidate of candidates) {
        check(signal); if (this.closed || this.session !== targetSession) return;
        const file = fromClipboard ? await materializeClipboardAttachment(candidate) : candidate; check(signal);
        const pdf = /\.pdf$/i.test(file.name);
        if (!pdf && !/\.(png|jpe?g|webp|gif)$/i.test(file.name)) throw Error('请选择 PDF、PNG、JPEG、GIF 或 WebP');
        if (!pdf) {
          const image = await this.images.add(file,signal); check(signal);
          if (!this.pendingImages.some(value => value.id === image.id)) this.pendingImages.push(image);
          this.refreshPendingImages(); this.refreshStats(); this.status.textContent = '图片已暂存，发送时结合问题识别。';
        } else {
          if (!mineruKey) throw Error('请先填写 MinerU 密钥');
          await this.uploadPdf(file,mineruKey,signal); check(signal);
        }
      }
    });
  }
  async uploadPdf(file,key,signal) {
      const output = this.row(`MinerU · ${file.name}`);
      output.entry.modelMessages = [];
      const fullMd = stripImageDataUris(await parseFile(file, key, signal, status => { if (!signal.aborted && !this.closed) this.status.textContent = status; }));
      check(signal);
      const md = await this.selectTextRange(fullMd, file.name, signal); check(signal);
      this.update(output, md); await abortableTask(this.render(output),signal); check(signal);
      const contextText = `Extracted text from uploaded file ${JSON.stringify(file.name)} for later questions, as reference data:\n\n${md}`;
      const message = { role: 'user', content: contextText };
      this.messages.push(message); output.entry.modelMessages.push(copyMessage(message)); output.entry.contextText = contextText;
      if (this.plugin.keys.deepseek) await this.compress(this.plugin.keys.deepseek, signal);
      check(signal); this.refreshConversationOptions(); this.status.textContent = '解析完成，可以复制 Markdown 或继续提问。';
  }
  async clear() {
    if (this.clearing || this.closed || this.applyingNotebookPatch || this.conversationTransition) return;
    this.clearing = true; this.hideMentions();
    this.controller?.abort(); this.controller = null;
    this.activeTurn = null; this.activeRequestMetadata = null;
    for (const button of [this.sendButton, this.uploadButton, this.compressButton, this.conversationSelect, this.newConversationButton, this.renameConversationButton, this.notebookAttach, this.clearButton]) button.disabled = true;
    for (const button of this.feed.querySelectorAll('.sd-notebook-apply')) button.disabled = true;
    try {
      const moved = await this.plugin.trashActiveConversation();
      this.resetImages();
      this.notebookTaskBuffers.clear(); this.resumeNotebookTaskId = null; this.activeNotebookEdit = null;
      this.plugin.removeActiveConversation(); this.session = this.plugin.session; this.messages = this.session.messages;
      this.notebookSnapshot = this.session.notebookSnapshot || null;
      if (!this.closed) {
        this.disposeRows(); this.feed.empty(); this.input.value = ''; this.refreshNotebookDeltaLabel(); this.refreshStats();
        for (const entry of this.session.entries) this.row(entry.label, entry.raw, entry);
        for (const state of this.rows) void this.render(state);
        this.refreshConversationOptions(); this.refreshNotebookTaskStatus(); this.status.textContent = moved ? '会话已移入系统回收站。' : '';
      }
      await this.plugin.saveSession();
    } catch {
      if (!this.closed) {
        for (const state of this.rows) if (state.streaming) {
          state.streaming = false; this.update(state, state.entry.raw, false, false);
          state.thinkingView?.finish();
          void this.render(state);
        }
        this.status.textContent = '移入系统回收站失败，原会话已保留。';
      }
    } finally {
      this.clearing = false;
      if (!this.closed) {
        this.sendButton.textContent = '发送'; this.sendButton.title = '';
        for (const button of [this.sendButton, this.uploadButton, this.compressButton, this.effortSelect, this.conversationSelect, this.newConversationButton, this.renameConversationButton, this.notebookAttach, this.clearButton]) button.disabled = false;
        for (const button of this.feed.querySelectorAll('.sd-delete-turn')) button.disabled = false;
        this.refreshPatchActions();
        this.restoreComposerFocus(null, true);
      }
    }
  }
  async onClose() {
    this.hideMentions(); const shutdown = this.disconnectNotebook(); this.closed = true; this.conversationTransition = null; this.confirmationFinish?.();
    this.notebookPreview?.removeEventListener('toggle',this.notebookPreviewToggleListener); this.notebookPreviewToggleListener = null;
    const doc = this.input?.ownerDocument;
    doc?.defaultView?.removeEventListener('focus', this.windowFocusListener);
    doc?.removeEventListener('copy', this.copySelectionListener, true);
    doc?.removeEventListener('selectionchange', this.selectionChangeListener);
    this.windowFocusListener = null; this.copySelectionListener = null; this.selectionChangeListener = null;
    this.pendingComposerFocus = false; this.pendingComposerFocusOrigin = null;
    this.localeObserver?.disconnect(); this.localeObserver = null; this.controller?.abort(); this.controller = null; this.activeTurn = null; this.activeRequestMetadata = null; this.resetImages(); this.notebookTaskBuffers.clear(); this.activeNotebookEdit = null;
    clearTimeout(this.statsTimer); this.statsTimer = null; this.disposeRows(); this.virtualObserver?.disconnect(); this.virtualObserver = null;
    this.contentEl.empty(); await shutdown; await this.plugin.saveSession();
  }
}
module.exports = class SimpleDeepSeek extends Plugin {
  notice(message) { return new Notice(translate(message, this.uiLanguage)); }
  async onload() {
    this.modelCatalog = new ModelCatalog({ fetchModels: listModels });
    this.conversations = []; this.activeConversationId = ''; this.conversationNames = {};
    this.displayTokensPerSecond = 0; this.model = 'deepseek-flash'; this.reasoningEffort = 'low'; this.webEnabled = true; this.uiLanguage = 'en'; this.libraryPath = DEFAULT_LIBRARY; this.notebookPath = ''; this.jupyterUrl = ''; this.jupyterToken = ''; this.jupyterRoot = ''; this.jupyterExecutablePath = ''; this.notebookFilePath = '';
    this.keys = { deepseek: '', mineru: '' }; this.saveQueue = Promise.resolve(); this.sessionTimers = new Map(); this.authPageOpenedAt = new Map(); this.retiredConversationIds = new Set(); this.persistedConversationIds = new Set();
    let saved = null, requestedActive = '';
    try {
      saved = await this.loadData();
      if (typeof saved?.activeConversationId === 'string') requestedActive = saved.activeConversationId;
      if (typeof saved?.model === 'string' && saved.model.trim()) this.model = saved.model.trim();
      if (saved?.conversationNames && typeof saved.conversationNames === 'object' && !Array.isArray(saved.conversationNames)) {
        for (const [id, name] of Object.entries(saved.conversationNames)) if (validConversationId(id) && typeof name === 'string' && name.trim()) this.conversationNames[id] = name.trim();
      }
      if (['en', 'zh'].includes(saved?.uiLanguage)) this.uiLanguage = saved.uiLanguage;
      if (['low','high','max'].includes(saved?.reasoningEffort)) this.reasoningEffort = saved.reasoningEffort;
      if (typeof saved?.webEnabled === 'boolean') this.webEnabled = saved.webEnabled;
      if (saved?.displayTokensPerSecond === 0 || (Number.isInteger(saved?.displayTokensPerSecond) && saved.displayTokensPerSecond >= 20 && saved.displayTokensPerSecond <= 300)) this.displayTokensPerSecond = saved.displayTokensPerSecond;
    } catch { this.notice('无法读取共享设置，请检查插件配置文件。'); }
    try {
      this.conversationStore = createConversationStore(this.app, this.manifest);
      const loaded = await this.conversationStore.load();
      for (const item of loaded.items) {
        const session = restoreSession(item.session);
        if (session && !this.conversations.some(other => other.id === item.id)) {
          this.conversations.push({ id: item.id, createdAt: item.createdAt, session });
          this.persistedConversationIds.add(item.id);
          if (item.name && !this.conversationNames[item.id]) this.conversationNames[item.id] = item.name;
        }
      }
      if (loaded.errors.length) this.notice(`${loaded.errors.length} 个对话文件无法读取，其他对话已正常载入。`);
      this.conversations.sort((a,b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
    } catch { this.conversationStore = null; this.notice('无法访问 conversations 对话目录；本次运行中的新对话不能持久保存。'); }
    this.keyStorageMessage = '系统安全存储不可用，密钥和文献库路径仅保留在本次运行内存中。';
    try {
      this.keyStore = createKeyStore(this.app);
      const local = await this.keyStore.load(); this.keys = { deepseek: local.deepseek, mineru: local.mineru }; this.libraryPath = typeof local.libraryPath === 'string' ? local.libraryPath : ''; this.notebookPath = local.notebookPath || ''; this.jupyterUrl = local.jupyterUrl || ''; this.jupyterToken = local.jupyterToken || ''; this.jupyterRoot = local.jupyterRoot || ''; this.jupyterExecutablePath = local.jupyterExecutablePath || ''; this.notebookFilePath = local.notebookFilePath || '';
      this.keyStorageMessage = '密钥、路径和 Jupyter 连接信息按当前系统用户加密保存，不写入笔记库配置。';
    } catch { this.keyStore = null; this.notice(this.keyStorageMessage); }
    if (!this.conversations.length) this.addConversation();
    else { this.activeConversationId = this.conversations.some(item => item.id === requestedActive) ? requestedActive : this.conversations[0].id; this.session = this.conversations.find(item => item.id === this.activeConversationId).session; }
    this.registerView(VIEW, leaf => new ChatView(leaf, this));
    const open = async () => {
      try {
        let leaf = this.app.workspace.getLeavesOfType(VIEW)[0];
        if (!leaf) { leaf = this.app.workspace.getRightLeaf(false) || this.app.workspace.getLeaf(true); await leaf.setViewState({ type: VIEW, active: true }); }
        await this.app.workspace.revealLeaf(leaf);
      } catch { this.notice('无法打开 Simple DeepSeek 面板，请重启插件'); }
    };
    this.addRibbonIcon('message-circle', 'Simple DeepSeek', () => { void open(); });
    this.chatCommand = this.addCommand({ id: 'open-chat', name: translate('打开聊天', this.uiLanguage), callback: () => { void open(); } });
  }
  addConversation() {
    const item = { id: conversationId(), createdAt: Date.now(), session: emptySession() }; this.conversations.push(item);
    if (!this.session) { this.activeConversationId = item.id; this.session = item.session; }
    return item;
  }
  activateConversation(id) {
    const item = this.conversations.find(candidate => candidate.id === id); if (!item) return false;
    this.activeConversationId = item.id; this.session = item.session; return true;
  }
  removeActiveConversation() {
    const index = this.conversations.findIndex(item => item.id === this.activeConversationId);
    if (index >= 0) { const {id,session} = this.conversations[index]; this.cancelSessionSave(session); this.retiredConversationIds.add(id); delete this.conversationNames[id]; this.conversations.splice(index, 1); }
    if (!this.conversations.length) this.addConversation();
    const next = this.conversations[Math.min(Math.max(index, 0), this.conversations.length - 1)]; this.activeConversationId = next.id; this.session = next.session;
  }
  openExpiredKeyPage(error) {
    const page = error?.authExpired && API_MANAGE_PAGES[error.authService];
    if (!page) return false;
    const now = Date.now();
    if (now - (this.authPageOpenedAt.get(error.authService) || 0) < 60000) return false;
    this.authPageOpenedAt.set(error.authService, now);
    try {
      const launched = shell.openExternal(page.url);
      if (launched?.catch) launched.catch(() => {
        this.authPageOpenedAt.delete(error.authService);
        this.notice(`${page.name} API 管理页面打开失败`);
      });
      this.notice(`${page.name} 密钥已过期，已打开 API 管理页面`);
      return true;
    } catch {
      this.authPageOpenedAt.delete(error.authService);
      this.notice(`${page.name} 密钥已过期，请打开 API 管理页面`);
      return false;
    }
  }
  scheduleSessionSave(session = this.session) {
    const item = this.conversations.find(item => item.session === session);
    if (!item || this.retiredConversationIds.has(item.id) || this.sessionTimers.has(session)) return;
    this.sessionTimers.set(session,setTimeout(() => { this.sessionTimers.delete(session); void this.saveSession(session); },3000));
  }
  cancelSessionSave(session) {
    const timer = this.sessionTimers.get(session);
    if (timer !== undefined) { clearTimeout(timer); this.sessionTimers.delete(session); }
  }
  conversationRecord(current) {
    return current && (current.session.messages.length || current.session.entries.length || this.conversationNames[current.id] || this.persistedConversationIds.has(current.id))
      ? { id: current.id, createdAt: current.createdAt, session: JSON.parse(JSON.stringify(current.session)), ...(this.conversationNames[current.id] ? { name: this.conversationNames[current.id] } : {}) } : null;
  }
  async trashActiveConversation() {
    const current = this.conversations.find(item => item.id === this.activeConversationId), record = this.conversationRecord(current);
    if (!current) return false;
    this.cancelSessionSave(current.session);
    let moved = false;
    const operation = this.saveQueue.catch(() => {}).then(async () => {
      if (!this.conversationStore) throw Error('对话目录不可用');
      if (record) await this.conversationStore.save(record);
      moved = await this.conversationStore.remove(current.id);
      this.retiredConversationIds.add(current.id);
    });
    this.saveQueue = operation;
    await operation;
    return moved;
  }
  async saveSession(session = this.session, strict = false) {
    this.cancelSessionSave(session);
    const current = this.conversations.find(item => item.session === session);
    const record = this.conversationRecord(current), snapshot = this.sharedSnapshot();
    this.saveQueue = this.saveQueue.catch(() => {}).then(async () => {
      if (!this.conversationStore) throw Error('对话目录不可用');
      if (record && !this.retiredConversationIds.has(record.id)) { await this.conversationStore.save(record); this.persistedConversationIds.add(record.id); }
      await this.saveData(snapshot);
    });
    try { await this.saveQueue; }
    catch { this.notice('当前对话保存失败，请检查插件目录是否可写。'); if (strict) throw Error('Notebook 暂存任务保存失败，已停止继续生成'); }
  }
  sharedSnapshot() {
    const snapshot = { model: this.model, displayTokensPerSecond: this.displayTokensPerSecond, reasoningEffort: this.reasoningEffort, webEnabled:this.webEnabled, uiLanguage: this.uiLanguage };
    if (Object.keys(this.conversationNames).length) snapshot.conversationNames = { ...this.conversationNames };
    if (this.conversations.some(item => item.id === this.activeConversationId && (item.session.messages.length || item.session.entries.length || this.conversationNames[item.id] || this.persistedConversationIds.has(item.id)))) snapshot.activeConversationId = this.activeConversationId;
    return snapshot;
  }
  saveKeys(requireSecure = true) {
    const keys = { deepseek: this.keys.deepseek, mineru: this.keys.mineru, libraryPath: this.libraryPath, notebookPath: this.notebookPath, jupyterUrl: this.jupyterUrl, jupyterToken: this.jupyterToken, jupyterRoot: this.jupyterRoot, jupyterExecutablePath: this.jupyterExecutablePath, notebookFilePath: this.notebookFilePath };
    const snapshot = this.sharedSnapshot();
    this.saveQueue = this.saveQueue.catch(() => {}).then(async () => {
      let keyError;
      if (this.keyStore) { try { await this.keyStore.save(keys); } catch { keyError = new Error('密钥安全保存失败，已输入密钥仅在本次运行可用。'); } }
      else if (keys.deepseek || keys.mineru || keys.libraryPath || keys.notebookPath || keys.jupyterUrl || keys.jupyterToken || keys.jupyterExecutablePath || keys.notebookFilePath) keyError = new Error('系统安全存储不可用，密钥、路径和 Jupyter 连接信息仅在本次运行可用。');
      await this.saveData(snapshot);
      if (keyError && requireSecure) { this.notice(keyError.message); throw keyError; }
    });
    return this.saveQueue;
  }
  onunload() {
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW)) { leaf.view.controller?.abort(); leaf.view.resetImages?.(); leaf.view.disposeRows?.();  }
    for (const session of new Set([...this.sessionTimers.keys(),this.session])) void this.saveSession(session);
    this.app.workspace.detachLeavesOfType(VIEW);
    // Keep the final snapshot available while asynchronous view-close saves finish.
  }
};
