const test = require('node:test');
const assert = require('node:assert/strict');
const {JSDOM} = require('jsdom');
const {splitMarkdownBlocks,splitMarkdown} = require('./src/markdown');
const {MarkdownBlockCache,findTextRange} = require('./src/message-renderer');

function fixture(render,tokenLimit = 40) {
  const dom = new JSDOM('<div id="body"></div>'),document = dom.window.document,body = document.querySelector('#body'),calls = [],components = [];
  const cache = new MarkdownBlockCache({document,tokenLimit,createComponent:() => { const component = {disposed:false}; components.push(component); return component; },disposeComponent:component => { assert.equal(component.disposed,false); component.disposed = true; },
    render:async (text,host,component) => { calls.push(text); if (render) await render(text,host,component); else { const p = document.createElement('p'); p.textContent = text; host.append(p); } }});
  const show = async text => { const plan = await cache.prepare(text),stage = document.createElement('div'); if (cache.commit(plan,stage)) body.replaceChildren(stage); return plan; };
  return {dom,document,body,cache,calls,components,show};
}

test('Markdown chunks keep longer fences intact despite shorter or different markers inside them', () => {
  for (const marker of ['````','~~~~']) {
    const block = marker+'markdown\n```python\n'+'literal line\n'.repeat(80)+'\nStill inside\n'+marker+'\n\n';
    const text = block+'After the fence\n\n';
    assert.deepEqual(splitMarkdown(text,20),[block,'After the fence\n\n']);
    assert.equal(splitMarkdown(text,20).join(''),text);
  }
  const unfinished = '````markdown\n```\n'+'unfinished\n\n'.repeat(100);
  assert.deepEqual(splitMarkdown(unfinished,20),[unfinished]);
});

test('Markdown splitting respects display math and ignores dollars inside inline code', () => {
  const first = '`$$` is literal. '+'x'.repeat(80)+'\n\n';
  assert.deepEqual(splitMarkdown(first+'Next\n\n',20),[first,'Next\n\n']);
  const math = '$$\n'+'x+y\n\n'.repeat(80)+'$$\n\n';
  assert.deepEqual(splitMarkdown(math+'Next\n\n',20),[math,'Next\n\n']);
});

test('cross-block Markdown dependencies conservatively use one complete native document', () => {
  const prefix = 'A stable paragraph.\n\n'.repeat(40);
  for (const dependency of ['[label]: https://example.com\n','Read [label][target]\n','<div>HTML\n\nbody</div>','| a | b |\n| --- | --- |\n','- list\n\n  continuation','    indented code','$$\\label{eq:test} x$$','Unfinished `code']) {
    const text = prefix+dependency,split = splitMarkdownBlocks(text,20);
    assert.equal(split.cacheable,false); assert.deepEqual(split.chunks,[{text,stable:false}]);
  }
});

test('Obsidian comments spanning chunk boundaries reach the native renderer as one complete document',async t=>{
  const prefix='Visible paragraph.\n\n'.repeat(20),comment='%%\n'+('Hidden paragraph. '.repeat(20)+'\n\n').repeat(3);
  const f=fixture(undefined,20);t.after(()=>{f.cache.clear();f.dom.window.close();});
  await f.show(prefix);const previous=[...f.components];assert.ok(f.cache.entries.length>1);
  for(const source of [prefix+comment+'%%\n\nVisible after.',prefix+comment]){
    assert.deepEqual(splitMarkdownBlocks(source,20),{cacheable:false,chunks:[{text:source,stable:false}]});
    const count=f.calls.length;await f.show(source);
    assert.equal(f.calls.length,count+1);assert.equal(f.calls.at(-1),source);assert.equal(f.cache.entries.length,1);
  }
  assert.ok(previous.every(component=>component.disposed));
});

test('comment markers inside code fences preserve code text and independent Markdown chunks',()=>{
  for(const marker of ['```','~~~~']){
    const block=marker+'text\n%%\n'+('Literal code %% text.\n\n').repeat(40)+'%%\n'+marker+'\n\n';
    const source=block+'Visible after.\n\n',split=splitMarkdownBlocks(source,20);
    assert.equal(split.cacheable,true);assert.deepEqual(split.chunks.map(chunk=>chunk.text),[block,'Visible after.\n\n']);
    assert.equal(split.chunks.map(chunk=>chunk.text).join(''),source);
  }
});

test('stable blocks retain native DOM and components while only a changed tail is rendered again', async t => {
  const f = fixture(); t.after(() => {f.cache.clear();f.dom.window.close();});
  const prefix = 'Stable paragraph '.repeat(12)+'\n\n';
  await f.show(prefix+'Tail'); const host = f.cache.entries[0].host,component = f.cache.entries[0].component,oldTail = f.cache.entries[1].component;
  await f.show(prefix+'Tail expanded');
  assert.equal(f.cache.entries[0].host,host); assert.equal(f.cache.entries[0].component,component);
  assert.equal(component.disposed,false); assert.equal(oldTail.disposed,true);
  assert.deepEqual(f.calls,[prefix,'Tail','Tail expanded']); assert.equal(f.body.textContent,prefix+'Tail expanded');
  await f.show(prefix+'Tail expanded'); assert.equal(f.calls.length,3);
});

test('new blocks stay detached until commit and a discarded plan cannot disturb an existing selection', async t => {
  let waiting = false,release;
  const f = fixture(async(text,host) => { if (waiting) await new Promise(resolve => {release = resolve;}); host.textContent = text; });
  t.after(() => {f.cache.clear();f.dom.window.close();});
  const prefix = 'Stable paragraph '.repeat(12)+'\n\n'; await f.show(prefix+'Tail');
  const stable = f.cache.entries[0].host,range = f.document.createRange(); range.selectNodeContents(stable); f.document.getSelection().addRange(range);
  waiting = true; const preparing = f.cache.prepare(prefix+'Changed tail'); await Promise.resolve();
  assert.equal(stable.isConnected,true); assert.equal(f.document.getSelection().toString(),prefix);
  release(); const plan = await preparing; f.cache.discard(plan);
  assert.equal(stable.isConnected,true); assert.equal(f.body.textContent,prefix+'Tail'); assert.equal(f.document.getSelection().toString(),prefix);
});

test('clearing an unfinished native render releases its component once and prevents late cache revival', async () => {
  let release;
  const f = fixture(async(text,host) => { await new Promise(resolve => {release = resolve;}); host.textContent = text; });
  const preparing = f.cache.prepare('Pending source'); await Promise.resolve(); f.cache.clear();
  assert.equal(f.components[0].disposed,true); release(); assert.equal(await preparing,null);
  assert.equal(f.cache.entries.length,0); assert.equal(f.cache.pending.size,0); f.dom.window.close();
});

test('a reference definition arriving later invalidates every formerly independent block', async t => {
  const f = fixture(); t.after(() => {f.cache.clear();f.dom.window.close();});
  const source = 'A paragraph. '.repeat(20)+'\n\nTail'; await f.show(source); const previous = [...f.components];
  const complete = source+'\n\n[ref]: https://example.com\n'; await f.show(complete);
  assert.equal(f.calls.at(-1),complete); assert.equal(f.cache.entries.length,1); assert.ok(previous.every(component => component.disposed));
});

test('native failures remain inert plaintext and retry on a later render instead of caching the failure', async t => {
  let fail = true;
  const f = fixture(async(text,host) => { if (fail) throw Error('renderer unavailable'); host.textContent = 'Rendered '+text; });
  t.after(() => {f.cache.clear();f.dom.window.close();});
  await f.show('<script>not executable</script>'); assert.equal(f.body.querySelector('script'),null); assert.ok(f.body.querySelector('.sd-render-fallback'));
  fail = false; await f.show('<script>not executable</script>'); assert.equal(f.calls.length,2); assert.equal(f.body.querySelector('.sd-render-fallback'),null);
});

test('successive append snapshots reduce native renderer input without removing any received text', async t => {
  const f = fixture(undefined,80); t.after(() => {f.cache.clear();f.dom.window.close();});
  const batch = 'A stable paragraph.\n\n'.repeat(8); let text = '',uncached = 0;
  for (let index = 0; index < 40; index++) {text += batch;uncached += text.length;await f.show(text);}
  assert.equal(f.body.textContent,text); assert.ok(f.calls.reduce((total,text) => total+text.length,0)<uncached/5);
});

test('search ranges span Thinking chunks without changing selection and handle expanding Unicode case folds', () => {
  const dom = new JSDOM('<div id="body"><div>İ prefix NEED</div><div>LE 🌱</div></div><p>Keep selected</p>'),doc = dom.window.document,body = doc.querySelector('#body');
  const selected = doc.createRange(); selected.selectNodeContents(doc.querySelector('p')); doc.getSelection().addRange(selected);
  assert.equal(findTextRange(body,'needle').toString(),'NEEDLE'); assert.equal(findTextRange(body,'i̇').toString(),'İ');
  assert.equal(findTextRange(body,'🌱').toString(),'🌱'); assert.equal(findTextRange(body,'absent'),null); assert.equal(doc.getSelection().toString(),'Keep selected'); dom.window.close();
});
