const { publicWebUrl, safeWebText } = require('./web');
const { translate } = require('./i18n');

function sourcesForDisplay(value,cache) {
  const sources = [], seen = new Set();
  for (const source of Array.isArray(value) ? value : []) {
    if (!source || !['object','function'].includes(typeof source)) continue;
    let inputUrl;
    try { inputUrl = source.url; } catch { continue; }
    let record = cache.get(source);
    if (!record || record.inputUrl !== inputUrl) {
      let url = null;
      try { url = publicWebUrl(inputUrl); } catch {}
      record = {...record,inputUrl,url}; cache.set(source,record);
    }
    const url = record.url;
    if (!url) continue;
    if (seen.has(url)) continue;
    seen.add(url);
    const suppliedTitle = source.title, inputTitle = typeof suppliedTitle === 'string' ? suppliedTitle : '';
    if (!record.display || record.inputTitle !== inputTitle || record.display.url !== url) {
      if (record.inputTitle !== inputTitle) record.title = safeWebText(inputTitle).replace(/[\u0000-\u001f\u007f]/g,' ').trim();
      record.inputTitle = inputTitle;
      const title = record.title || url;
      if (!record.display || record.display.url !== url || record.display.title !== title) record.display = {url,title};
    }
    sources.push(record.display);
  }
  return sources;
}

class SourceList {
  constructor({details,body,summary,getSources = () => [],getLanguage = () => 'en'}) {
    this.details = details; this.body = body; this.summary = summary;
    this.document = body.ownerDocument; this.getSources = getSources; this.getLanguage = getLanguage;
    this.visible = true; this.disposed = false; this.renderedSources = null; this.sources = [];
    this.sourceCache = new WeakMap(); this.linkNodes = new Map(); this.list = null; this.labelLanguage = null; this.labelPrefix = '';
    this.savedMinHeight = null; this.watchingSelection = false;
    this.onToggle = () => this.refresh();
    this.onSelectionChange = () => {
      if (this.selected()) return;
      this.unwatchSelection(); this.refresh();
    };
    details.open = false;
    details.addEventListener('toggle',this.onToggle);
    this.refresh();
  }

  selected() {
    if (!this.body.firstChild) return false;
    const selection = this.document.getSelection?.();
    if (!selection || selection.isCollapsed || !selection.rangeCount) return false;
    for (let index = 0; index < selection.rangeCount; index++) {
      try { if (selection.getRangeAt(index).intersectsNode(this.body)) return true; } catch {}
    }
    return false;
  }

  watchSelection() {
    if (this.watchingSelection) return;
    this.watchingSelection = true;
    this.document.addEventListener('selectionchange',this.onSelectionChange);
  }

  unwatchSelection() {
    if (!this.watchingSelection) return;
    this.watchingSelection = false;
    this.document.removeEventListener('selectionchange',this.onSelectionChange);
  }

  clearBody(preserveHeight) {
    if (this.selected()) { this.watchSelection(); return; }
    this.unwatchSelection();
    if (preserveHeight && this.body.childNodes.length) {
      const height = this.body.getBoundingClientRect().height || this.body.offsetHeight;
      if (height > 0 && Number.isFinite(height)) {
        if (this.savedMinHeight === null) this.savedMinHeight = this.body.style.minHeight;
        this.body.style.minHeight = height+'px';
      }
    } else if (!preserveHeight) this.restoreHeight();
    if (this.body.childNodes.length) this.body.replaceChildren();
    this.renderedSources = null; this.linkNodes.clear(); this.list = null;
  }

  restoreHeight() {
    if (this.savedMinHeight === null) return;
    this.body.style.minHeight = this.savedMinHeight;
    this.savedMinHeight = null;
  }

  refresh() {
    if (this.disposed) return;
    this.sources = sourcesForDisplay(this.getSources(),this.sourceCache);
    const language = this.getLanguage();
    if (language !== this.labelLanguage) { this.labelLanguage = language; this.labelPrefix = translate('已检索网页',language); }
    const label = this.labelPrefix+' ('+this.sources.length+')';
    if (this.summary.textContent !== label) this.summary.textContent = label;
    if (this.details.hidden !== !this.sources.length) this.details.hidden = !this.sources.length;
    if (!this.visible || !this.details.open || !this.sources.length) {
      this.clearBody(!this.visible && this.details.open && !!this.sources.length);
      return;
    }
    const unchanged = this.renderedSources?.length === this.sources.length && this.sources.every((source,index) => source.url === this.renderedSources[index].url && source.title === this.renderedSources[index].title);
    if (unchanged) { this.restoreHeight(); return; }
    if (this.selected()) { this.watchSelection(); return; }
    this.unwatchSelection();
    const list = this.list || this.document.createElement('ul'), wanted = new Set();
    let current = list.firstChild;
    for (const source of this.sources) {
      let nodes = this.linkNodes.get(source.url);
      if (!nodes) {
        const item = this.document.createElement('li'), link = this.document.createElement('a');
        link.className = 'external-link'; link.href = source.url; link.title = source.url;
        link.target = '_blank'; link.rel = 'noopener noreferrer'; item.append(link);
        nodes = {item,link}; this.linkNodes.set(source.url,nodes);
      }
      if (nodes.link.textContent !== source.title) nodes.link.textContent = source.title;
      if (nodes.item === current) current = current.nextSibling;
      else list.insertBefore(nodes.item,current);
      wanted.add(source.url);
    }
    while (current) { const next = current.nextSibling; current.remove(); current = next; }
    for (const url of this.linkNodes.keys()) if (!wanted.has(url)) this.linkNodes.delete(url);
    if (this.list !== list) this.body.replaceChildren(list);
    this.list = list; this.renderedSources = this.sources; this.restoreHeight();
  }

  setVisible(value) {
    if (this.disposed) return;
    this.visible = !!value; this.refresh();
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.details.removeEventListener('toggle',this.onToggle); this.unwatchSelection();
    this.body.replaceChildren(); this.restoreHeight(); this.sources = [];
    this.renderedSources = null; this.linkNodes.clear(); this.list = null; this.sourceCache = new WeakMap(); this.getSources = () => []; this.getLanguage = () => 'en';
  }
}

module.exports = { SourceList };
