const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const { SourceList } = require('./src/source-list');

function fixture(sources = [{url:'https://example.com/docs',title:'Official docs'}],language = 'en',View = SourceList) {
  const dom = new JSDOM('<details open><summary></summary><div class="sd-sources-body"></div></details>');
  const document = dom.window.document, details = document.querySelector('details'), body = details.querySelector('div'), summary = details.querySelector('summary');
  const current = {sources,language};
  const list = new View({details,body,summary,getSources:()=>current.sources,getLanguage:()=>current.language});
  const toggle = open => {details.open=open;details.dispatchEvent(new dom.window.Event('toggle'));};
  const clearSelection = () => {document.getSelection().removeAllRanges();document.dispatchEvent(new dom.window.Event('selectionchange'));};
  const selectLink = () => {const range=document.createRange();range.selectNodeContents(body.querySelector('a'));const selection=document.getSelection();selection.removeAllRanges();selection.addRange(range);};
  return {dom,document,details,body,summary,current,list,toggle,selectLink,clearSelection};
}

test('restored source lists start collapsed and do not create link DOM before opening',()=>{
  const f=fixture();assert.equal(f.details.open,false);assert.equal(f.details.hidden,false);assert.equal(f.summary.textContent,'Retrieved pages (1)');
  assert.equal(f.body.childNodes.length,0);f.list.refresh();assert.equal(f.body.childNodes.length,0);
  f.toggle(true);assert.equal(f.body.querySelectorAll('a').length,1);assert.equal(f.body.querySelector('a').textContent,'Official docs');
  f.list.dispose();f.dom.window.close();
});

test('closing releases sources and reopening reconstructs native external links',()=>{
  const f=fixture();f.toggle(true);const first=f.body.querySelector('a');
  assert.equal(first.href,'https://example.com/docs');assert.equal(first.target,'_blank');assert.equal(first.rel,'noopener noreferrer');assert.equal(first.className,'external-link');
  f.toggle(false);assert.equal(f.body.childNodes.length,0);f.toggle(true);assert.notEqual(f.body.querySelector('a'),first);
  f.list.refresh();assert.equal(f.details.open,true);assert.equal(f.body.querySelectorAll('a').length,1);f.list.dispose();f.dom.window.close();
});

test('refresh detects source changes without a message revision and preserves the open state',()=>{
  const f=fixture();f.toggle(true);const first=f.body.querySelector('a');
  f.list.refresh();assert.equal(f.body.querySelector('a'),first);
  f.current.sources.push({url:'http://example.org/new',title:'New source'});f.list.refresh();
  assert.equal(f.details.open,true);assert.equal(f.summary.textContent,'Retrieved pages (2)');assert.equal(f.body.querySelectorAll('a').length,2);
  f.current.sources[0].title='Updated title';f.list.refresh();assert.equal(f.body.querySelector('a').textContent,'Updated title');
  f.toggle(false);f.current.sources.push({url:'https://example.net/',title:'Third'});f.list.refresh();assert.equal(f.body.childNodes.length,0);assert.equal(f.summary.textContent,'Retrieved pages (3)');
  f.list.dispose();f.dom.window.close();
});

test('source links are unique validated public URLs and unsafe or private destinations never become clickable',()=>{
  const blocked=['javascript:alert(1)','data:text/html,<script>alert(1)</script>','file:///C:/secret.txt','obsidian://open','https://localhost/a','http://127.0.0.1/','http://192.168.1.2/','https://user:password@example.com/','https://example.com/?token=secret'];
  const sources=[...blocked.map(url=>({url,title:'Blocked'})),{url:'HTTPS://EXAMPLE.COM:443/docs#one',title:'Safe'},{url:'https://example.com/docs#two',title:'Duplicate'},{url:'http://example.org/',title:''},null,{}];
  const f=fixture(sources);f.toggle(true);assert.equal(f.summary.textContent,'Retrieved pages (2)');
  assert.deepEqual([...f.body.querySelectorAll('a')].map(link=>[link.href,link.textContent]),[['https://example.com/docs','Safe'],['http://example.org/','http://example.org/']]);
  assert.doesNotMatch(f.body.innerHTML,/javascript:|secret|localhost|192\.168|127\.0/);f.list.dispose();f.dom.window.close();
});

test('malicious titles remain literal text with no HTML, scripts, images or Markdown rendering',()=>{
  const title='<img src=x onerror=alert(1)> **bold** [evil](javascript:alert(1)) <script>bad()</script>';
  const f=fixture([{url:'https://example.com/',title}]);f.toggle(true);
  assert.equal(f.body.querySelector('a').textContent,title);assert.equal(f.body.querySelectorAll('script,img,strong,iframe').length,0);assert.equal(f.body.querySelector('a').getAttribute('onerror'),null);
  f.list.dispose();f.dom.window.close();
});

test('titles omit embedded image payloads without mutating archived sources or reference fields',()=>{
  const sources=[{url:'https://example.com/docs',title:'Figure data:image/png;base64,'+'A'.repeat(600),content:'Original page text',hash:'original-hash'}],before=structuredClone(sources);
  const f=fixture(sources);f.toggle(true);assert.doesNotMatch(f.body.innerHTML,/base64|A{400}/);assert.deepEqual(sources,before);
  f.list.dispose();assert.deepEqual(sources,before);f.dom.window.close();
});

test('empty or invalid lists stay hidden and language changes update only the interface label',()=>{
  const f=fixture([], 'zh');assert.equal(f.details.hidden,true);assert.equal(f.summary.textContent,'已检索网页 (0)');
  f.current.sources=[{url:'https://example.com/',title:'中文标题'}];f.list.refresh();assert.equal(f.details.hidden,false);assert.equal(f.details.open,false);
  f.toggle(true);const link=f.body.querySelector('a');f.current.language='en';f.list.refresh();assert.equal(f.summary.textContent,'Retrieved pages (1)');assert.equal(f.body.querySelector('a'),link);assert.equal(link.textContent,'中文标题');
  f.current.sources=null;f.list.refresh();assert.equal(f.details.hidden,true);assert.equal(f.body.childNodes.length,0);f.list.dispose();f.dom.window.close();
});

test('offscreen open lists release DOM while preserving their height and expansion state',()=>{
  const f=fixture();f.body.style.minHeight='12px';f.body.getBoundingClientRect=()=>({height:123});f.toggle(true);
  f.list.setVisible(false);assert.equal(f.details.open,true);assert.equal(f.body.childNodes.length,0);assert.equal(f.body.style.minHeight,'123px');
  f.current.sources.push({url:'https://example.org/',title:'Second'});f.list.refresh();assert.equal(f.body.childNodes.length,0);assert.equal(f.summary.textContent,'Retrieved pages (2)');
  f.list.setVisible(true);assert.equal(f.body.querySelectorAll('a').length,2);assert.equal(f.body.style.minHeight,'12px');assert.equal(f.details.open,true);
  f.toggle(false);f.list.setVisible(false);assert.equal(f.body.style.minHeight,'12px');f.list.dispose();f.dom.window.close();
});

test('selected source text survives offscreen virtualization until the selection is cleared',()=>{
  const f=fixture();f.toggle(true);const first=f.body.querySelector('a');f.selectLink();
  f.list.setVisible(false);assert.equal(f.body.querySelector('a'),first);assert.equal(f.document.getSelection().toString(),'Official docs');assert.equal(f.list.watchingSelection,true);
  f.clearSelection();assert.equal(f.body.childNodes.length,0);assert.equal(f.list.watchingSelection,false);
  f.list.setVisible(true);assert.equal(f.body.querySelectorAll('a').length,1);f.list.dispose();f.dom.window.close();
});

test('source refresh defers DOM replacement during selection and applies new sources after it clears',()=>{
  const f=fixture();f.toggle(true);const first=f.body.querySelector('a');f.selectLink();
  f.current.sources=[{url:'https://example.org/',title:'Changed'}];f.list.refresh();assert.equal(f.body.querySelector('a'),first);
  f.clearSelection();assert.equal(f.body.querySelector('a').textContent,'Changed');assert.equal(f.body.querySelector('a').href,'https://example.org/');f.list.dispose();f.dom.window.close();
});

test('disposal removes event work and repeated disposal or refresh cannot recreate links',()=>{
  const f=fixture();f.toggle(true);f.selectLink();f.list.setVisible(false);assert.equal(f.list.watchingSelection,true);
  f.list.dispose();assert.equal(f.list.watchingSelection,false);assert.equal(f.body.childNodes.length,0);f.clearSelection();
  f.toggle(false);f.toggle(true);f.list.refresh();f.list.setVisible(true);f.list.dispose();assert.equal(f.body.childNodes.length,0);f.dom.window.close();
});

test('stable large source lists reuse validated URLs and sanitized titles without serializing them on each refresh',()=>{
  const fs=require('node:fs'),vm=require('node:vm'),web=require('./src/web'),module={exports:{}};const calls={urls:0,titles:0,json:0};vm.runInNewContext(fs.readFileSync(__dirname+'/src/source-list.js','utf8'),{module,require:name=>name==='./web'?{...web,publicWebUrl:(...args)=>{calls.urls++;return web.publicWebUrl(...args);},safeWebText:(...args)=>{calls.titles++;return web.safeWebText(...args);}}:require('./src/i18n'),JSON:{stringify:(...args)=>{calls.json++;return JSON.stringify(...args);}}});const sources=Array.from({length:500},(_,index)=>({url:'https://example.com/'+index,title:'Long title '.repeat(100)})),f=fixture(sources,'en',module.exports.SourceList);try{for(let index=0;index<20;index++)f.list.refresh();assert.equal(calls.urls,500);assert.equal(calls.titles,500);f.toggle(true);for(let index=0;index<20;index++)f.list.refresh();assert.equal(calls.urls,500);assert.equal(calls.titles,500);assert.equal(calls.json,0);assert.equal(f.body.querySelectorAll('a').length,500);sources[10].title='Updated title';f.list.refresh();assert.equal(calls.urls,500);assert.equal(calls.titles,501);sources[10].url='http://127.0.0.1/private';f.list.refresh();assert.equal(calls.urls,501);assert.equal(f.body.querySelectorAll('a').length,499);assert.doesNotMatch(f.body.innerHTML,/127\.0/);}finally{f.list.dispose();f.dom.window.close();}
});

test('source updates reuse existing links for title changes insertion removal and reordering',()=>{
  const sources=Array.from({length:100},(_,index)=>({url:'https://example.com/'+index,title:'Source '+index})),f=fixture(sources);try{f.toggle(true);const original=[...f.body.querySelectorAll('a')],create=f.document.createElement.bind(f.document);let anchors=0;f.document.createElement=(tag,...args)=>{if(tag==='a')anchors++;return create(tag,...args);};sources[50].title='Updated source';sources.push({url:'https://example.org/new',title:'New source'});f.list.refresh();assert.equal(anchors,1);for(let index=0;index<100;index++)assert.equal(f.body.querySelectorAll('a')[index],original[index]);assert.equal(original[50].textContent,'Updated source');const prior=[...f.body.querySelectorAll('a')];sources.reverse();f.list.refresh();assert.equal(anchors,1);assert.deepEqual([...f.body.querySelectorAll('a')],prior.reverse());sources.splice(10,1);f.list.refresh();assert.equal(anchors,1);assert.equal(f.body.querySelectorAll('a').length,100);}finally{f.list.dispose();f.dom.window.close();}
});

test('offscreen source release drops reusable DOM nodes and reentry creates fresh links with the same exact text',()=>{
  const f=fixture([{url:'https://example.com/',title:'Keep **literal** title'}]);try{f.toggle(true);const before=f.body.querySelector('a');f.body.getBoundingClientRect=()=>({height:150});f.list.setVisible(false);assert.equal(f.body.childNodes.length,0);for(let index=0;index<100;index++)f.list.refresh();assert.equal(f.body.style.minHeight,'150px');f.list.setVisible(true);const after=f.body.querySelector('a');assert.notEqual(after,before);assert.equal(after.textContent,'Keep **literal** title');assert.equal(f.body.style.minHeight,'');}finally{f.list.dispose();f.dom.window.close();}
});
