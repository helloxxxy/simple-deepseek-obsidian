const THINKING_UPDATE_MS = 100;
const THINKING_CHUNK_CHARS = 4096;

function selectionInside(body) {
  const selection = body.ownerDocument.getSelection?.();
  if (!selection || selection.isCollapsed) return false;
  for (let index = 0; index < selection.rangeCount; index++) {
    try { if (selection.getRangeAt(index).intersectsNode(body)) return true; } catch {}
  }
  return false;
}

class ThinkingView {
  #details;
  #body;
  #getText;
  #feed;
  #onFollow;
  #onBeforeRender;
  #onAfterRender;
  #schedule;
  #cancel;
  #timer = null;
  #visible = true;
  #disposed = false;
  #shown = Infinity;
  #rendered = 0;
  #lastText = '';
  #chunks = [];
  #placeholder = false;
  #priorMinHeight;
  #selectionDeferred = false;
  #toggle;
  #selectionChange;
  #copy;

  constructor({ details, body, getText, feed, onFollow, onBeforeRender, onAfterRender, schedule = setTimeout, cancel = clearTimeout }) {
    this.#details = details; this.#body = body; this.#getText = getText; this.#feed = feed;
    this.#onFollow = onFollow; this.#onBeforeRender = onBeforeRender; this.#onAfterRender = onAfterRender;
    this.#schedule = schedule; this.#cancel = cancel; this.#priorMinHeight = body.style.minHeight;
    this.#toggle = () => {
      if (this.#disposed) return;
      if (!details.open) { this.#cancelUpdate(); this.#release(false); }
      else {
        if (!this.#visible && this.#visibleInFeed() === true) this.#visible = true;
        this.refresh(true);
      }
    };
    this.#selectionChange = () => {
      if (this.#disposed || !this.#selectionDeferred || selectionInside(body)) return;
      this.#unwatchSelection();
      if (!this.#visible && details.open) this.#release(true);
      else this.refresh();
    };
    this.#copy = event => {
      if (this.#disposed || !event.clipboardData) return;
      const selection = body.ownerDocument.getSelection?.();
      if (!selection || selection.isCollapsed || selection.rangeCount !== 1) return;
      const range = selection.getRangeAt(0);
      if (!body.contains(range.startContainer) || !body.contains(range.endContainer)) return;
      // Range text retains the source newlines; block layout must not add any.
      event.clipboardData.setData('text/plain', range.toString()); event.preventDefault();
    };
    details.addEventListener('toggle', this.#toggle);
    body.addEventListener('copy', this.#copy);
    if (details.open && !details.hidden) this.refresh(); else this.#release(false);
  }

  #cancelUpdate() {
    const cancel = this.#cancel;
    if (this.#timer !== null) cancel(this.#timer);
    this.#timer = null;
  }

  #canRender() { return !this.#disposed && this.#visible && this.#details.open && !this.#details.hidden; }

  #visibleInFeed() {
    if (!this.#feed || this.#details.closest('[hidden]') || this.#feed.closest('[hidden]')) return null;
    const window = this.#body.ownerDocument.defaultView;
    if (this.#body.ownerDocument.visibilityState === 'hidden') return null;
    try {
      const target = this.#details.getBoundingClientRect(), viewport = this.#feed.getBoundingClientRect();
      const valid = rect => rect && ['left','right','top','bottom','width','height'].every(key => Number.isFinite(rect[key])) && rect.width > 0 && rect.height > 0;
      if (!valid(target) || !valid(viewport)) return null;
      for (const element of [this.#details,this.#feed]) {
        const style = window?.getComputedStyle?.(element);
        if (style?.display === 'none' || ['hidden','collapse'].includes(style?.visibility) || style?.contentVisibility === 'hidden') return null;
      }
      const right = Math.min(viewport.right,window?.innerWidth > 0 ? window.innerWidth : viewport.right);
      const bottom = Math.min(viewport.bottom,window?.innerHeight > 0 ? window.innerHeight : viewport.bottom);
      return target.right > Math.max(0,viewport.left) && target.left < right && target.bottom > Math.max(0,viewport.top) && target.top < bottom;
    } catch { return null; }
  }

  #watchSelection() {
    if (this.#selectionDeferred) return;
    this.#selectionDeferred = true;
    this.#body.ownerDocument.addEventListener('selectionchange',this.#selectionChange);
  }

  #unwatchSelection() {
    if (!this.#selectionDeferred) return;
    this.#selectionDeferred = false;
    this.#body.ownerDocument.removeEventListener('selectionchange',this.#selectionChange);
  }

  #queue() {
    if (!this.#canRender() || this.#timer !== null) return;
    const schedule = this.#schedule;
    this.#timer = schedule(() => { this.#timer = null; this.#render(true); }, THINKING_UPDATE_MS);
  }

  #release(preserveHeight) {
    if (preserveHeight && selectionInside(this.#body)) { this.#watchSelection(); return; }
    if (preserveHeight && this.#body.childNodes.length) {
      const height = Math.max(0, this.#body.getBoundingClientRect?.().height || this.#body.scrollHeight || 0);
      if (height) { this.#body.style.minHeight = Math.ceil(height) + 'px'; this.#placeholder = true; }
    } else if (!preserveHeight && this.#placeholder) {
      this.#body.style.minHeight = this.#priorMinHeight; this.#placeholder = false;
    }
    if (this.#body.childNodes.length) this.#body.replaceChildren();
    this.#chunks = []; this.#rendered = 0; this.#lastText = '';
    this.#unwatchSelection();
  }

  #append(source, start, end) {
    const doc = this.#body.ownerDocument;
    const addition = source.slice(start,end);
    let cursor = 0, runStart = 0, chunk = this.#chunks[this.#chunks.length - 1];
    const flush = () => { if (chunk && cursor > runStart) chunk.text.appendData(addition.slice(runStart,cursor)); runStart = cursor; };
    while (cursor < addition.length) {
      const newline = addition.indexOf('\n', cursor);
      const next = newline >= 0 ? newline + 1 : addition.length;
      if (!chunk || (chunk.newline && chunk.length + next - cursor > THINKING_CHUNK_CHARS)) {
        flush();
        const element = doc.createElement('div'); element.className = 'sd-thinking-chunk';
        element.style.whiteSpace = 'pre-wrap'; element.style.overflowWrap = 'anywhere';
        element.style.margin = '0';
        const text = doc.createTextNode(''); element.append(text); this.#body.append(element);
        chunk = { element, text, length: 0, newline: true }; this.#chunks.push(chunk);
      }
      chunk.length += next-cursor; chunk.newline = addition.charCodeAt(next-1) === 10;
      cursor = next;
    }
    flush();
  }

  #render(follow, verifyPrefix = false) {
    if (!this.#canRender()) return;
    const value = this.#getText();
    const source = typeof value === 'string' ? value : String(value ?? '');
    let end = Math.min(source.length, this.#shown);
    if (end > 0 && end < source.length && source.charCodeAt(end - 1) >= 0xd800 && source.charCodeAt(end - 1) <= 0xdbff && source.charCodeAt(end) >= 0xdc00 && source.charCodeAt(end) <= 0xdfff) end--;
    const reset = end < this.#rendered || (verifyPrefix && source !== this.#lastText && source.slice(0,this.#rendered) !== this.#lastText.slice(0,this.#rendered));
    if (reset && selectionInside(this.#body)) { this.#watchSelection(); return; }
    if (!reset && end === this.#rendered && !this.#placeholder) { this.#lastText = source; return; }
    const marker = this.#onBeforeRender ? this.#onBeforeRender(follow) : !!(this.#feed && this.#feed.scrollHeight - this.#feed.scrollTop - this.#feed.clientHeight < 100);
    if (reset) this.#release(false);
    if (this.#placeholder) { this.#body.style.minHeight = this.#priorMinHeight; this.#placeholder = false; }
    this.#append(source, this.#rendered, end); this.#rendered = end; this.#lastText = source;
    if (this.#onAfterRender) this.#onAfterRender(marker);
    else if (follow && marker && !selectionInside(this.#body)) {
      if (this.#onFollow) this.#onFollow(); else this.#feed.scrollTop = this.#feed.scrollHeight;
    }
  }

  setShown(length) {
    if (this.#disposed) return;
    if (length !== Infinity && (!Number.isSafeInteger(length) || length < 0)) throw new Error('Thinking display length must be a nonnegative integer.');
    this.#shown = length; this.#queue();
  }

  refresh(follow = false) {
    if (this.#disposed) return;
    this.#cancelUpdate();
    if (!this.#details.open) { this.#release(false); return; }
    if (!this.#visible) { this.#release(true); return; }
    this.#render(follow,true);
  }

  setVisible(visible) {
    if (this.#disposed) return;
    this.#visible = !!visible || (this.#details.open && this.#visibleInFeed() === true);
    if (!this.#visible) { this.#cancelUpdate(); this.#release(this.#details.open); }
    else this.refresh();
  }

  finish() { if (!this.#disposed) { this.#shown = Infinity; this.refresh(); } }

  dispose() {
    if (this.#disposed) return;
    this.#disposed = true; this.#cancelUpdate();
    this.#details.removeEventListener('toggle', this.#toggle);
    this.#unwatchSelection();
    this.#body.removeEventListener('copy', this.#copy);
    this.#release(false);
  }
}

module.exports = { ThinkingView, THINKING_UPDATE_MS, THINKING_CHUNK_CHARS };
