const { describePatch } = require('./notebook');
const { selectionInside } = require('./selection-copy');

function displayPatch(value) {
  if (!value || !Array.isArray(value.operations) || !value.operations.length) return null;
  for (const op of value.operations) {
    if (!op || !['set_source', 'insert_cell', 'replace_text', 'delete_cell'].includes(op.type)) return null;
    if (['set_source', 'insert_cell'].includes(op.type) && typeof op.source !== 'string') return null;
    if (op.type === 'replace_text' && (typeof op.oldText !== 'string' || typeof op.newText !== 'string')) return null;
  }
  return value;
}
const DISPLAY_FIELDS = ['type','index','cellId','cellType','source','oldText','newText'];
const sameOperation = (snapshot,op) => !!snapshot && DISPLAY_FIELDS.every(key => snapshot[key] === op[key]);
const operationSnapshot = op => Object.fromEntries(DISPLAY_FIELDS.map(key => [key,op[key]]));

class NotebookPatchView {
  constructor({ host, getPatch = () => null, getLanguage = () => 'en', visible = true }) {
    this.host = host; this.document = host.ownerDocument;
    this.getPatch = getPatch; this.getLanguage = getLanguage;
    this.visible = !!visible; this.disposed = false; this.renderedPatch = null; this.renderedLanguage = null;
    this.operationRows = [];
    this.savedMinHeight = null; this.watchingSelection = false;
    this.onSelectionChange = () => {
      if (this.disposed || this.selected()) return;
      this.unwatchSelection(); this.refresh();
    };
    host.classList.add('sd-notebook-patch-view');
    this.refresh();
  }

  selected() { return !!this.host.firstChild && selectionInside(this.host); }

  watchSelection() {
    if (this.watchingSelection) return;
    this.watchingSelection = true;
    this.document.addEventListener('selectionchange', this.onSelectionChange);
  }

  unwatchSelection() {
    if (!this.watchingSelection) return;
    this.watchingSelection = false;
    this.document.removeEventListener('selectionchange', this.onSelectionChange);
  }

  restoreHeight() {
    if (this.savedMinHeight === null) return;
    this.host.style.minHeight = this.savedMinHeight; this.savedMinHeight = null;
  }

  release(preserveHeight) {
    if (this.selected()) { this.watchSelection(); return; }
    this.unwatchSelection();
    if (preserveHeight && this.host.childNodes.length) {
      const height = this.host.getBoundingClientRect?.().height || this.host.scrollHeight || this.host.offsetHeight;
      if (Number.isFinite(height) && height > 0) {
        if (this.savedMinHeight === null) this.savedMinHeight = this.host.style.minHeight;
        this.host.style.minHeight = Math.ceil(height)+'px';
      }
    } else if (!preserveHeight) this.restoreHeight();
    if (this.host.firstChild) this.host.replaceChildren();
    this.operationRows = []; this.renderedPatch = null; this.renderedLanguage = null;
  }

  source(parent, text, { label = '', markdown = false } = {}) {
    let title = null;
    if (label) {
      title = this.document.createElement('p'); title.className = 'sd-notebook-patch-fragment-title'; title.textContent = label; parent.append(title);
    }
    const pre = this.document.createElement('pre'), code = this.document.createElement('code');
    pre.className = 'sd-notebook-patch-source';
    if (markdown) code.className = 'language-markdown';
    code.textContent = text; pre.append(code); parent.append(pre);
    return title;
  }

  operation(op,index,language) {
    const element = this.document.createElement('section'), title = this.document.createElement('p');
    element.className = 'sd-notebook-patch-operation'; element.dataset.operation = op.type;
    title.className = 'sd-notebook-patch-operation-title'; element.append(title);
    const row = {element,title,data:operationSnapshot(op),labels:[]};
    if (op.type === 'set_source' || op.type === 'insert_cell') this.source(element,op.source,{markdown:op.cellType === 'markdown'});
    else if (op.type === 'replace_text') {
      row.labels.push(this.source(element,op.oldText,{label:'Original text'}),this.source(element,op.newText,{label:'Replacement text'}));
    }
    this.labelOperation(row,op,index,language);
    return row;
  }

  labelOperation(row,op,index,language) {
    const title = describePatch({operations:[op]},language).replace(/^1\./,`${index+1}.`);
    if (row.title.textContent !== title) row.title.textContent = title;
    const labels = language === 'zh' ? ['原文','新文'] : ['Original text','Replacement text'];
    row.labels.forEach((node,index) => { if (node.textContent !== labels[index]) node.textContent = labels[index]; });
  }

  refresh() {
    if (this.disposed) return;
    const patch = displayPatch(this.getPatch()), language = this.getLanguage() === 'zh' ? 'zh' : 'en';
    const sameOperations = patch && this.operationRows.length === patch.operations.length && this.operationRows.every((row,index) => sameOperation(row.data,patch.operations[index]));
    const unchanged = sameOperations && this.renderedLanguage === language;
    if ((!patch || !this.visible || !unchanged) && this.selected()) { this.watchSelection(); return; }
    this.unwatchSelection(); this.host.classList.toggle('sd-body',!!patch); this.host.hidden = !patch;
    if (!patch || !this.visible) { this.release(!this.visible && !!patch); return; }
    if (unchanged) { this.renderedPatch = patch; this.restoreHeight(); return; }
    const rows = [];
    for (const [index,op] of patch.operations.entries()) {
      const old = this.operationRows[index];
      const row = sameOperation(old?.data,op) ? old : this.operation(op,index,language);
      if (row === old) this.labelOperation(row,op,index,language);
      rows.push(row);
    }
    let current = this.host.firstChild;
    for (const row of rows) {
      if (row.element === current) current = current.nextSibling;
      else this.host.insertBefore(row.element,current);
    }
    while (current) { const next = current.nextSibling; current.remove(); current = next; }
    this.operationRows = rows; this.renderedPatch = patch; this.renderedLanguage = language; this.restoreHeight();
  }

  setVisible(visible) {
    if (this.disposed) return;
    this.visible = !!visible; this.refresh();
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true; this.unwatchSelection(); this.host.replaceChildren(); this.restoreHeight(); this.host.hidden = true;
    this.operationRows = [];
    this.renderedPatch = null; this.renderedLanguage = null; this.getPatch = () => null; this.getLanguage = () => 'en';
  }
}

module.exports = { NotebookPatchView };
