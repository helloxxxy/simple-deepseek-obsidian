const {splitMarkdownBlocks} = require('./markdown');

class MarkdownBlockCache {
  constructor({document,render,createComponent,disposeComponent,tokenLimit = 8000}) {
    this.document = document; this.render = render; this.createComponent = createComponent; this.disposeComponent = disposeComponent; this.tokenLimit = tokenLimit;
    this.entries = []; this.pending = new Set(); this.generation = 0;
  }

  drop(entry) {
    if (entry.disposed) return;
    entry.disposed = true; this.pending.delete(entry); this.disposeComponent(entry.component);
  }

  async prepare(markdown,current = () => true) {
    const {cacheable,chunks} = splitMarkdownBlocks(markdown,this.tokenLimit);
    const plan = {generation:this.generation,entries:[],created:[],committed:false};
    try {
      for (const [index,chunk] of chunks.entries()) {
        if (!current()) { this.discard(plan); return null; }
        const prior = cacheable || this.entries.length === 1 ? this.entries[index] : null;
        if (prior && !prior.disposed && !prior.failed && prior.source === chunk.text) { plan.entries.push(prior); continue; }
        const host = this.document.createElement('div'); host.className = 'sd-markdown-chunk';
        const entry = {host,source:chunk.text,component:this.createComponent(),disposed:false};
        plan.entries.push(entry); plan.created.push(entry); this.pending.add(entry);
        try { await this.render(chunk.text,host,entry.component); }
        catch { entry.failed = true; host.replaceChildren(); host.classList.add('sd-render-fallback'); host.textContent = chunk.text; }
        if (plan.generation !== this.generation || !current()) { this.discard(plan); return null; }
      }
      return plan;
    } catch (error) { this.discard(plan); throw error; }
  }

  commit(plan,host) {
    if (!plan || plan.generation !== this.generation || plan.committed) return false;
    for (const entry of plan.entries) host.append(entry.host);
    const retained = new Set(plan.entries);
    for (const entry of this.entries) if (!retained.has(entry)) this.drop(entry);
    for (const entry of plan.created) this.pending.delete(entry);
    this.entries = plan.entries; plan.committed = true; return true;
  }

  discard(plan) {
    if (!plan || plan.committed) return;
    for (const entry of plan.created) this.drop(entry);
  }

  clear() {
    this.generation++;
    for (const entry of this.entries) this.drop(entry);
    for (const entry of [...this.pending]) this.drop(entry);
    this.entries = [];
  }

  get component() { return this.entries[0]?.component || null; }
}

function findTextRange(body,query) {
  const text = body.textContent, needle = query.toLocaleLowerCase(), match = text.toLocaleLowerCase().indexOf(needle);
  if (!needle || match < 0) return null;
  let offset = 0, folded = 0, start = null, end = text.length;
  for (const point of text) {
    const next = folded + point.toLocaleLowerCase().length;
    if (start === null && next > match) start = offset;
    if (next >= match+needle.length) { end = offset+point.length; break; }
    offset += point.length; folded = next;
  }
  const range = body.ownerDocument.createRange(), walker = body.ownerDocument.createTreeWalker(body,4);
  let node, traversed = 0, started = false;
  while ((node = walker.nextNode())) {
    if (!started && traversed+node.length > start) { range.setStart(node,start-traversed); started = true; }
    if (started && traversed+node.length >= end) { range.setEnd(node,end-traversed); return range; }
    traversed += node.length;
  }
  return null;
}

module.exports = {MarkdownBlockCache,findTextRange};
