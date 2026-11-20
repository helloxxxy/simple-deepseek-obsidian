const test = require('node:test');
const assert = require('node:assert/strict');
const {ui} = require('./scripts/test-ui.cjs');
const {splitMarkdown} = require('./src/markdown');
const library = require('./src/library');
const until = async predicate => { for (let attempt=0;attempt<200;attempt++) { if (predicate()) return; await new Promise(resolve=>setTimeout(resolve,5)); } assert.fail('Display checkpoint did not arrive'); };
async function open(options = {}) { const env = ui(async()=>{},async()=>'',{saved:{uiLanguage:'en'},...options}); await env.plugin.onload(); const view = env.plugin.factory({}); await view.onOpen(); return {...env,view}; }

test('each rendered code block copies its own text from the bottom, reusing the native top button', async () => {
  const {view,copies} = await open({renderMarkdown:(_text,el) => {
    for (const [language,source] of [['text','first\n  literal $x$\n'],['js','x < 2 && y;\n']]) {
      const pre = el.createEl('pre');
      const code = pre.createEl('code',{cls:'language-'+language}); code.createSpan({text:source});
      if (language === 'js') pre.createEl('button',{cls:'copy-code-button'});
    }
  }});
  const state = view.row('deepseek-flash','```text\nfirst\n  literal $x$\n```\n\n```js\nx < 2 && y;\n```');
  await view.render(state);
  const [plain,js] = state.body.querySelectorAll('.sd-code-block');
  assert.equal(plain.querySelectorAll('button').length,2); assert.equal(js.querySelectorAll('button').length,2);
  for (const button of [plain.firstElementChild,plain.lastElementChild,js.lastElementChild]) {
    assert.equal(button.getAttribute('aria-label'),'Copy block text'); button.click();
  }
  assert.deepEqual(copies,['first\n  literal $x$\n','first\n  literal $x$\n','x < 2 && y;\n']);
  view.plugin.uiLanguage='zh'; view.refreshLanguage(); assert.equal(js.lastElementChild.title,'复制文本块');
  state.version++; await view.render(state); assert.equal(state.body.querySelectorAll('.sd-code-copy').length,3);
  await view.onClose();
});

test('an unfinished streamed fence appends in the code element above its bottom copy button', async () => {
  const {view,copies} = await open({renderMarkdown:(_text,host) => { host.createEl('pre').createEl('code',{text:'first'}); }});
  const state = view.row('deepseek-flash'); state.streaming = true;
  view.revealDelta(state,'```text\nfirst'); await view.render(state);
  view.revealDelta(state,' second');
  const code = state.body.querySelector('pre > code');
  assert.equal(state.tail.parentElement,code); assert.equal(code.textContent,'first second');
  state.body.querySelector('.sd-code-copy:last-child').click(); assert.equal(copies.at(-1),'first second');
  await view.onClose();
});

test('streamed native snapshots reuse stable blocks and keep complete copying and visible text', async()=>{
  const env = await open(),{view}=env,row=view.row('deepseek-flash');clearTimeout(row.timer);row.timer=null;row.streaming=true;
  const batch='Paragraph alpha.\n\n'.repeat(60);let uncached=0;
  for(let index=0;index<100;index++){view.revealDelta(row,batch);uncached+=row.raw.length;await view.render(row);}
  row.entry.raw=row.raw;row.streaming=false;row.version++;await view.render(row);
  assert.equal(row.body.textContent,row.raw);assert.ok(env.renders.reduce((total,item)=>total+item.text.length,0)<uncached*0.4);
  row.element.querySelector('.sd-message-footer .sd-icon-button').click();await new Promise(setImmediate);assert.equal(env.copies.at(-1),row.raw);
  assert.ok(row.markdownCache.entries.length>1);await view.onClose();assert.equal(view.children.size,0);
});

test('native chunk input keeps a shorter inner marker inside its longer outer code fence',async()=>{
  const env=await open(),block='````markdown\n```python\n'+'literal code line\n'.repeat(2500)+'\nLater inside outer fence\n````\n\n',text=block+'After\n\n';
  const row=env.view.row('deepseek-flash',text);await env.view.render(row);
  assert.deepEqual(env.renders.map(item=>item.text),splitMarkdown(text));assert.equal(env.renders[0].text,block);assert.equal(row.body.textContent,text);await env.view.onClose();
});

test('selection during a changed-tail render leaves the stable native block connected until deselection',async()=>{
  let release,held=false;
  const env=await open({render:async text=>{if(text==='New tail'&&!held){held=true;await new Promise(resolve=>release=resolve);}}}),{view,doc}=env;
  const prefix='Stable paragraph '.repeat(1700)+'\n\n',row=view.row('deepseek-flash',prefix+'Old tail');await view.render(row);const stable=row.markdownCache.entries[0].host;
  view.update(row,prefix+'New tail',true,false);const drawing=view.render(row);await until(()=>release);
  const range=doc.createRange();range.setStart(stable.firstChild.firstChild,0);range.setEnd(stable.firstChild.firstChild,6);doc.getSelection().addRange(range);
  release();await drawing;assert.equal(doc.getSelection().toString(),'Stable');assert.equal(stable.isConnected,true);assert.equal(row.body.textContent,prefix+'Old tail');
  doc.getSelection().removeAllRanges();doc.dispatchEvent(new env.dom.window.Event('selectionchange'));await until(()=>row.body.textContent===prefix+'New tail');
  assert.equal(row.markdownCache.entries[0].host,stable);await view.onClose();
});

test('a row moving offscreen during native preparation releases both prior and unfinished components',async()=>{
  let observe,release,hold=false;class Observer{constructor(callback){observe=callback;}observe(){}unobserve(){}disconnect(){}}
  const env=await open({IntersectionObserver:Observer,render:async text=>{if(hold&&text==='Changed')await new Promise(resolve=>release=resolve);}}),{view}=env,row=view.row('deepseek-flash','Original');
  observe([{target:row.element,isIntersecting:true}]);await until(()=>row.body.textContent==='Original'&&!row.running);row.body.getBoundingClientRect=()=>({height:300});
  hold=true;view.update(row,'Changed',true,false);const drawing=view.render(row);await until(()=>release);observe([{target:row.element,isIntersecting:false}]);release();await drawing;
  assert.equal(row.body.childNodes.length,0);assert.equal(row.body.style.minHeight,'300px');assert.equal(row.markdownCache.entries.length,0);assert.equal(view.children.size,0);
  hold=false;observe([{target:row.element,isIntersecting:true}]);await until(()=>row.body.textContent==='Changed');assert.equal(row.body.style.minHeight,'');await view.onClose();
});

test('reference definitions arriving after stable text force a complete native document',async()=>{
  const env=await open(),{view}=env,prefix='Paragraph alpha.\n\n'.repeat(1600),row=view.row('deepseek-flash',prefix+'Tail');await view.render(row);
  const text=prefix+'Tail\n\n[ref]: https://example.com\n';view.update(row,text,true,false);await view.render(row);
  assert.equal(env.renders.at(-1).text,text);assert.equal(row.markdownCache.entries.length,1);assert.equal(row.body.textContent,text);await view.onClose();
});

test('search opens and locates archived Thinking without replacing the current text selection',async()=>{
  const env=await open(),{view,doc}=env,entry={label:'deepseek-flash',raw:'Visible answer.',thinking:'First phase.\nUNIQUE_THOUGHT_MATCH\nFinal phase.'};view.session.entries.push(entry);const row=view.row(entry.label,entry.raw,entry);await view.render(row);
  const selected=doc.createRange();selected.selectNodeContents(row.body.querySelector('p'));doc.getSelection().addRange(selected);let scrolled=false;row.thinkingBody.scrollIntoView=()=>{scrolled=true;};
  view.searchInput.value='unique_thought_match';view.findNext();assert.equal(row.thinkingBox.open,true);assert.ok(row.thinkingBody.textContent.includes('UNIQUE_THOUGHT_MATCH'));assert.equal(scrolled,true);assert.equal(doc.getSelection().toString(),'Visible answer.');assert.equal(view.followPaused,true);
  doc.getSelection().removeAllRanges();await view.onClose();
});

test('search does not bypass a live local display cursor to expose a not-yet-shown Thinking match',async()=>{
  const env=await open(),{view}=env,entry={label:'deepseek-flash',raw:'Answer.',thinking:'Shown prefix. Hidden needle.'};view.session.entries.push(entry);const live=view.row(entry.label,entry.raw,entry);live.streaming=true;live.thinkingShown=13;live.thinkingView.setShown(13);
  view.searchInput.value='hidden needle';view.findNext();assert.equal(live.thinkingBox.open,false);assert.equal(view.searchHit,null);
  live.streaming=false;live.thinkingView.finish();view.findNext();assert.equal(live.thinkingBox.open,true);assert.ok(live.thinkingBody.textContent.includes('Hidden needle.'));await view.onClose();
});

test('mention candidates expose the active option to the focused input and reset on Escape or selection',async()=>{
  const records=[{id:'2601.12345',title:'First'},{id:'2601.12346',title:'Second'}];
  const env=await open({keyState:{libraryPath:'library'},libraryApi:{...library,scanLibrary:async()=>records,searchRecords:()=>records}}),{view,doc,dom}=env;view.input.value='@candidate';view.input.setSelectionRange(10,10);view.input.focus();await view.updateMentions();
  const options=[...view.mentionPopup.querySelectorAll('[role="option"]')];assert.equal(view.input.getAttribute('aria-controls'),view.mentionPopup.id);assert.equal(view.input.getAttribute('aria-autocomplete'),'list');assert.equal(view.input.getAttribute('aria-expanded'),'true');assert.equal(view.input.getAttribute('aria-activedescendant'),options[0].id);
  view.input.dispatchEvent(new dom.window.KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true,cancelable:true}));assert.equal(doc.activeElement,view.input);assert.equal(view.input.getAttribute('aria-activedescendant'),options[1].id);assert.equal(options[1].getAttribute('aria-selected'),'true');
  view.input.dispatchEvent(new dom.window.KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}));assert.equal(view.input.getAttribute('aria-expanded'),'false');assert.equal(view.input.hasAttribute('aria-activedescendant'),false);
  await view.updateMentions();view.selectMention(0);assert.ok(view.input.value.includes('@[2601.12345]'));assert.equal(view.input.getAttribute('aria-expanded'),'false');assert.equal(view.input.hasAttribute('aria-activedescendant'),false);await view.onClose();
});
