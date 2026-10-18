const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const { ThinkingView, THINKING_UPDATE_MS, THINKING_CHUNK_CHARS } = require('./src/thinking-view');

function clock() {
  let now = 0, next = 1;
  const tasks = new Map();
  return {
    schedule: (callback, delay) => { const id = next++; tasks.set(id,{callback,at:now+delay}); return id; },
    cancel: id => tasks.delete(id),
    advance: milliseconds => {
      const end = now + milliseconds;
      while (true) {
        const task = [...tasks.entries()].filter(([,value]) => value.at <= end).sort((left,right) => left[1].at-right[1].at)[0];
        if (!task) break;
        now = task[1].at; tasks.delete(task[0]); task[1].callback();
      }
      now = end;
    },
    get size() { return tasks.size; }
  };
}

function fixture(options = {}) {
  const dom = new JSDOM('<!doctype html><div id="feed"><details><summary>Thinking</summary><div id="body"></div></details></div>');
  const doc = dom.window.document, details = doc.querySelector('details'), body = doc.querySelector('#body'), feed = doc.querySelector('#feed');
  const scheduler = clock();
  let text = '', reads = 0;
  const view = new ThinkingView({ details, body, feed, getText: () => { reads++; return text; }, schedule:scheduler.schedule, cancel:scheduler.cancel, ...options });
  return { dom, doc, details, body, feed, scheduler, view,
    get reads() { return reads; }, get text() { return text; }, set text(value) { text = value; },
    open: () => { details.open = true; details.dispatchEvent(new dom.window.Event('toggle')); },
    close: () => { details.open = false; details.dispatchEvent(new dom.window.Event('toggle')); }
  };
}

function browserTimers(scheduler) {
  const window = {};
  const checkReceiver = receiver => { if (receiver !== undefined && receiver !== window) throw new TypeError('Illegal invocation'); };
  window.setTimeout = function(callback, delay) { 'use strict'; checkReceiver(this); return scheduler.schedule(callback, delay); };
  window.clearTimeout = function(id) { 'use strict'; checkReceiver(this); scheduler.cancel(id); };
  return window;
}

test('browser-branded scheduling keeps live thinking advancing beyond its initial synchronous render', t => {
  const scheduler = clock(), timers = browserTimers(scheduler);
  assert.throws(() => Reflect.apply(timers.setTimeout, {}, [() => {}, 100]), /Illegal invocation/);
  const env = fixture({schedule:timers.setTimeout,cancel:timers.clearTimeout}); t.after(() => env.view.dispose());
  env.text = 'Initial thought\n'.repeat(10); env.open(); const initial = env.body.textContent;
  env.text += 'A later thought with real newlines.\n'.repeat(300);
  assert.doesNotThrow(() => env.view.setShown(env.text.length));
  assert.equal(env.body.textContent, initial); assert.equal(scheduler.size, 1);
  scheduler.advance(THINKING_UPDATE_MS);
  assert.equal(env.body.textContent, env.text); assert.equal(scheduler.size, 0);
  env.close(); env.open(); assert.equal(env.body.textContent, env.text);
});

test('browser-branded cancellation works during refresh offscreen release and disposal', () => {
  const scheduler = clock(), timers = browserTimers(scheduler);
  const env = fixture({schedule:scheduler.schedule,cancel:timers.clearTimeout});
  env.text = 'First thought'; env.open();
  env.text += '\nRefresh tail'; env.view.setShown(env.text.length);
  assert.doesNotThrow(() => env.view.refresh()); assert.equal(scheduler.size, 0); assert.equal(env.body.textContent, env.text);
  env.text += '\nOffscreen tail'; env.view.setShown(env.text.length);
  assert.doesNotThrow(() => env.view.setVisible(false)); assert.equal(scheduler.size, 0);
  env.view.setVisible(true); env.text += '\nQueued before disposal'; env.view.setShown(env.text.length);
  assert.equal(scheduler.size, 1); assert.doesNotThrow(() => env.view.dispose()); assert.equal(scheduler.size, 0);
  scheduler.advance(THINKING_UPDATE_MS); assert.equal(env.body.childNodes.length, 0);
});

test('collapsed thinking never reads or writes incoming text and allocates no timer', t => {
  const env = fixture(); t.after(() => env.view.dispose());
  let writes = 0;
  const append = env.body.append.bind(env.body), replace = env.body.replaceChildren.bind(env.body);
  env.body.append = (...values) => { writes++; append(...values); };
  env.body.replaceChildren = (...values) => { writes++; replace(...values); };
  env.text = 'A long hidden analysis.\n'.repeat(20000);
  for (let index = 1; index <= 1000; index++) env.view.setShown(index);
  env.scheduler.advance(1000);
  assert.equal(env.reads, 0); assert.equal(writes, 0); assert.equal(env.scheduler.size, 0);
  assert.equal(env.body.childNodes.length, 0);
  env.view.finish(); env.view.refresh();
  assert.equal(env.reads, 0); assert.equal(writes, 0);
});

test('expanding thinking lazily renders exact plaintext in chunks without estimated layout heights', t => {
  const env = fixture(); t.after(() => env.view.dispose());
  env.text = '# not a heading\n<script>not executable</script>\n' + 'Line **a** with $x$ and `code`.\n'.repeat(900);
  assert.equal(env.body.childNodes.length, 0);
  env.open();
  assert.equal(env.body.textContent, env.text);
  assert.equal(env.body.querySelector('script'), null);
  assert.equal(env.body.querySelector('strong'), null);
  assert.ok(env.body.children.length > 1);
  for (const chunk of env.body.children) {
    assert.equal(chunk.className, 'sd-thinking-chunk');
    assert.equal(chunk.style.contentVisibility, '');
    assert.equal(chunk.style.containIntrinsicSize, '');
    assert.ok(chunk.textContent.length <= THINKING_CHUNK_CHARS);
  }
  assert.equal(env.body.style.overflowY, '');
});

test('thinking updates coalesce for 100ms and append to the existing text node', t => {
  const events = [];
  const env = fixture({ onBeforeRender: () => { events.push('before'); return 'position'; }, onAfterRender: marker => events.push(marker) });
  t.after(() => env.view.dispose());
  env.view.setShown(0); env.open();
  env.text = 'first'; env.view.setShown(5); env.view.setShown(5);
  assert.equal(env.scheduler.size, 1);
  env.scheduler.advance(THINKING_UPDATE_MS-1);
  assert.equal(env.body.textContent, ''); assert.deepEqual(events, []);
  env.scheduler.advance(1);
  const original = env.body.firstChild.firstChild;
  assert.equal(env.body.textContent, 'first'); assert.deepEqual(events, ['before','position']);
  env.text += ' second';
  for (let index = 6; index <= env.text.length; index++) env.view.setShown(index);
  assert.equal(env.scheduler.size, 1);
  env.scheduler.advance(100);
  assert.equal(env.body.firstChild.firstChild, original);
  assert.equal(original.data, 'first second');
  assert.deepEqual(events, ['before','position','before','position']);
});

test('collapse clears nodes and reopening shows the full retained thinking without truncation', t => {
  const env = fixture(); t.after(() => env.view.dispose());
  env.text = 'Initial thinking\n'; env.open();
  assert.equal(env.body.textContent, env.text);
  env.close(); assert.equal(env.body.childNodes.length, 0);
  const reads = env.reads;
  env.text += 'Later analysis\n'.repeat(2000); env.view.setShown(env.text.length);
  env.scheduler.advance(1000); assert.equal(env.reads, reads);
  env.open(); assert.equal(env.body.textContent, env.text);
  env.close(); env.text += 'Final detail'; env.view.finish();
  env.open(); assert.equal(env.body.textContent, env.text);
});

test('explicit expansion requests live following while refresh finish and offscreen reentry preserve the viewport', t => {
  let active = true, follows = 0;
  const requests = [];
  const env = fixture({
    onBeforeRender: follow => { requests.push(follow); return follow && active; },
    onAfterRender: follow => { if (follow) follows++; }
  });
  t.after(() => env.view.dispose());
  env.text = 'First live thought'; env.view.setShown(5); env.open();
  assert.equal(env.body.textContent, 'First'); assert.deepEqual(requests, [true]); assert.equal(follows, 1);
  env.text += '\nNext thought'; env.view.refresh();
  env.view.finish();
  assert.equal(env.body.textContent, env.text); assert.equal(follows, 1);
  env.view.setVisible(false); env.text += '\nArrived offscreen'; env.view.setShown(env.text.length);
  env.view.setVisible(true);
  assert.equal(env.body.textContent, env.text); assert.equal(follows, 1);
  assert.ok(requests.slice(1).every(follow => follow === false));
  active = false; env.close(); env.open();
  assert.equal(env.body.textContent, env.text); assert.equal(requests.at(-1), true); assert.equal(follows, 1);
});

test('explicit follow refresh keeps hidden offscreen and selected thinking from moving the viewport', t => {
  let follows = 0;
  const env = fixture({ onFollow: () => { follows++; } });
  t.after(() => env.view.dispose());
  env.text = 'Selected thought'; env.open(); assert.equal(follows, 1);
  const range = env.doc.createRange(); const text = env.body.firstChild.firstChild; range.setStart(text, 0); range.setEnd(text, text.length);
  const selection = env.doc.getSelection(); selection.removeAllRanges(); selection.addRange(range);
  env.text += '\nNew tail'; env.view.refresh(true);
  assert.equal(env.body.textContent, env.text); assert.equal(selection.toString(), 'Selected thought'); assert.equal(follows, 1);
  selection.removeAllRanges(); env.view.setVisible(false); env.text += '\nOffscreen tail'; env.view.refresh(true);
  assert.equal(env.body.childNodes.length, 0); assert.equal(follows, 1);
  env.details.hidden = true; env.view.setVisible(true); env.view.refresh(true);
  assert.equal(env.body.childNodes.length, 0); assert.equal(follows, 1);
  env.details.hidden = false; env.close(); env.view.refresh(true);
  assert.equal(env.body.childNodes.length, 0); assert.equal(follows, 1);
});

test('chunks keep long lines and Unicode intact instead of inserting visual line breaks', t => {
  const env = fixture(); t.after(() => env.view.dispose());
  env.text = 'a'.repeat(THINKING_CHUNK_CHARS*2) + '😀\nnext line';
  env.view.setShown(THINKING_CHUNK_CHARS*2+1); env.open();
  assert.equal(env.body.textContent, 'a'.repeat(THINKING_CHUNK_CHARS*2));
  assert.equal(env.body.children.length, 1);
  env.view.setShown(env.text.length); env.scheduler.advance(100);
  assert.equal(env.body.textContent, env.text);
  assert.equal(env.body.children.length, 2);
  assert.ok(env.body.firstChild.textContent.endsWith('😀\n'));
});

test('offscreen thinking keeps a height placeholder and rehydrates on reentry', t => {
  const env = fixture(); t.after(() => env.view.dispose());
  env.text = 'Visible\n'.repeat(1000); env.open();
  env.body.getBoundingClientRect = () => ({height:840});
  env.view.setVisible(false);
  assert.equal(env.body.childNodes.length, 0); assert.equal(env.body.style.minHeight, '840px');
  const reads = env.reads;
  env.text += 'New tail'; env.view.setShown(env.text.length); env.scheduler.advance(1000);
  assert.equal(env.reads, reads);
  env.view.setVisible(true);
  assert.equal(env.body.style.minHeight, ''); assert.equal(env.body.textContent, env.text);
});

test('offscreen release waits until the selected thinking text is no longer selected', t => {
  const env = fixture(); t.after(() => env.view.dispose());
  env.text = 'Select this thinking.'; env.open();
  const range = env.doc.createRange(); range.selectNodeContents(env.body);
  const selection = env.doc.getSelection(); selection.removeAllRanges(); selection.addRange(range);
  env.view.setVisible(false);
  assert.equal(env.body.textContent, env.text);
  assert.equal(selection.getRangeAt(0).toString(), env.text);
  selection.removeAllRanges(); env.doc.dispatchEvent(new env.dom.window.Event('selectionchange'));
  assert.equal(env.body.childNodes.length, 0);
  env.view.setVisible(true); assert.equal(env.body.textContent, env.text);
});

test('copying a selection across thinking chunks retains exact source newlines as plaintext', t => {
  const env = fixture(); t.after(() => env.view.dispose());
  env.text = 'one\n'.repeat(1100) + 'two\n\nthree'; env.open();
  assert.ok(env.body.children.length > 1);
  const range = env.doc.createRange(); range.selectNodeContents(env.body);
  const selection = env.doc.getSelection(); selection.removeAllRanges(); selection.addRange(range);
  const copied = new Map(), event = new env.dom.window.Event('copy',{bubbles:true,cancelable:true});
  Object.defineProperty(event,'clipboardData',{value:{setData:(type,value) => copied.set(type,value)}});
  env.body.dispatchEvent(event);
  assert.equal(event.defaultPrevented, true); assert.equal(copied.get('text/plain'), env.text);
  const first = env.body.firstChild.firstChild, last = env.body.lastChild.firstChild;
  range.setStart(first,2); range.setEnd(last,last.length-2); selection.removeAllRanges(); selection.addRange(range);
  const partial = new env.dom.window.Event('copy',{bubbles:true,cancelable:true});
  Object.defineProperty(partial,'clipboardData',{value:{setData:(type,value) => copied.set(type,value)}});
  env.body.dispatchEvent(partial);
  assert.equal(copied.get('text/plain'), env.text.slice(2,-2));
});

test('refresh reconciles changed authoritative text and dispose cancels timers and listeners', () => {
  const env = fixture(); env.text = 'Old'; env.open();
  env.text = 'New'; env.view.refresh(); assert.equal(env.body.textContent, 'New');
  env.text += ' tail'; env.view.setShown(env.text.length); assert.equal(env.scheduler.size,1);
  env.view.dispose(); assert.equal(env.scheduler.size,0); assert.equal(env.body.childNodes.length,0);
  const reads = env.reads;
  env.view.refresh(); env.view.setShown(10); env.view.finish(); env.view.setVisible(true); env.open(); env.scheduler.advance(1000);
  assert.equal(env.reads,reads); assert.equal(env.body.childNodes.length,0);
});

test('thinking rows register document selection listeners only while selected text defers release', () => {
  const dom = new JSDOM('<!doctype html><div id="feed"></div>'), doc = dom.window.document;
  const feed = doc.querySelector('#feed'), helpers = [];
  let adds = 0, removes = 0;
  const add = doc.addEventListener.bind(doc), remove = doc.removeEventListener.bind(doc);
  doc.addEventListener = (name,...args) => { if (name === 'selectionchange') adds++; add(name,...args); };
  doc.removeEventListener = (name,...args) => { if (name === 'selectionchange') removes++; remove(name,...args); };
  for (let index = 0; index < 100; index++) {
    const details = doc.createElement('details'), body = doc.createElement('div'); details.append(body); feed.append(details);
    helpers.push({details,body,view:new ThinkingView({details,body,feed,getText:() => 'Selected text'})});
  }
  assert.equal(adds,0); assert.equal(removes,0);
  const first = helpers[0]; first.details.open = true; first.view.refresh();
  const range = doc.createRange(); range.selectNodeContents(first.body);
  const selection = doc.getSelection(); selection.removeAllRanges(); selection.addRange(range);
  first.view.setVisible(false); first.view.setVisible(false);
  assert.equal(adds,1); assert.equal(removes,0);
  selection.removeAllRanges(); doc.dispatchEvent(new dom.window.Event('selectionchange'));
  assert.equal(adds,1); assert.equal(removes,1); assert.equal(first.body.childNodes.length,0);
  first.view.setVisible(true); selection.addRange(range);
  // Select the newly materialized nodes, rather than the released old range.
  range.selectNodeContents(first.body); selection.removeAllRanges(); selection.addRange(range);
  first.view.setVisible(false); assert.equal(adds,2);
  for (const helper of helpers) helper.view.dispose();
  assert.equal(removes,2);
});

function visibleGeometry(env){
  let reads=0,target={left:0,right:400,top:100,bottom:200,width:400,height:100};
  env.feed.getBoundingClientRect=()=>{reads++;return{left:0,right:400,top:0,bottom:300,width:400,height:300};};
  env.details.getBoundingClientRect=()=>{reads++;return target;};
  return{get reads(){return reads;},set target(value){target=value;}};
}

test('opening visible thinking corrects stale offscreen state without bypassing the shown limit or batching',t=>{
  const env=fixture();t.after(()=>env.view.dispose());const geometry=visibleGeometry(env);env.text='First phase\nSecond phase';env.view.setShown(5);env.view.setVisible(false);assert.equal(geometry.reads,0);env.open();assert.equal(env.body.textContent,'First');assert.equal(geometry.reads,2);env.text+='\nLater reasoning';env.view.setShown(env.text.length);assert.equal(env.body.textContent,'First');env.scheduler.advance(THINKING_UPDATE_MS);assert.equal(env.body.textContent,env.text);assert.equal(geometry.reads,2);
});

test('a late offscreen notification cannot hide expanded thinking that is still inside the feed viewport',t=>{
  const env=fixture();t.after(()=>env.view.dispose());const geometry=visibleGeometry(env);env.text='Visible first phase';env.open();env.view.setVisible(false);assert.equal(env.body.textContent,env.text);env.text+='\nVisible later phase';env.view.setShown(env.text.length);env.scheduler.advance(THINKING_UPDATE_MS);assert.equal(env.body.textContent,env.text);const visibleReads=geometry.reads;
  geometry.target={left:0,right:400,top:500,bottom:600,width:400,height:100};env.body.getBoundingClientRect=()=>({height:140});env.view.setVisible(false);assert.equal(env.body.childNodes.length,0);assert.equal(env.body.style.minHeight,'140px');const offscreenReads=env.reads;env.text+='\nReceived while offscreen';env.view.setShown(env.text.length);env.scheduler.advance(1000);assert.equal(env.reads,offscreenReads);assert.equal(env.body.childNodes.length,0);assert.equal(geometry.reads,visibleReads+2);env.view.setVisible(true);assert.equal(env.body.textContent,env.text);assert.equal(env.body.style.minHeight,'');
});

test('hidden nodes and missing geometry continue to obey observer visibility',t=>{
  for(const hidden of ['attribute','style','geometry']){
    const env=fixture();t.after(()=>env.view.dispose());const geometry=visibleGeometry(env);env.text='Hidden reasoning';env.view.setVisible(false);if(hidden==='attribute')env.feed.hidden=true;else if(hidden==='style')env.details.style.visibility='hidden';else geometry.target={left:0,right:0,top:0,bottom:0,width:0,height:0};env.open();env.view.setShown(env.text.length);env.scheduler.advance(1000);assert.equal(env.body.childNodes.length,0,hidden);assert.equal(env.reads,0,hidden);assert.equal(env.scheduler.size,0,hidden);
  }
});

test('collapsed and steady streaming updates do not poll layout to correct observer state',t=>{
  const env=fixture();t.after(()=>env.view.dispose());const geometry=visibleGeometry(env);env.text='Initial';for(let index=0;index<100;index++){env.view.setVisible(false);env.view.setShown(index);}assert.equal(geometry.reads,0);assert.equal(env.reads,0);env.open();const reads=geometry.reads;for(let index=0;index<20;index++){env.text+='\nMore';env.view.setShown(env.text.length);env.scheduler.advance(THINKING_UPDATE_MS);}assert.equal(env.body.textContent,env.text);assert.equal(geometry.reads,reads);assert.equal(env.scheduler.size,0);
});

test('large short-line thinking batches text writes by display chunk while keeping source and selection exact',t=>{
  const env=fixture();t.after(()=>env.view.dispose());let writes=0,characters=0;const append=env.dom.window.Text.prototype.appendData;env.dom.window.Text.prototype.appendData=function(text){writes++;characters+=text.length;return append.call(this,text);};env.text='x\n'.repeat(10000);env.open();assert.equal(env.body.textContent,env.text);assert.equal(characters,env.text.length);assert.ok(writes<=6,'10,000 lines should not cause 10,000 DOM text writes');const first=env.body.firstChild.firstChild,range=env.doc.createRange();range.setStart(first,0);range.setEnd(first,4);const selection=env.doc.getSelection();selection.removeAllRanges();selection.addRange(range);const initialWrites=writes;env.text+='y\n'.repeat(1000);env.view.setShown(env.text.length);assert.equal(writes,initialWrites);env.scheduler.advance(THINKING_UPDATE_MS);assert.equal(env.body.textContent,env.text);assert.equal(characters,env.text.length);assert.ok(writes-initialWrites<=3);assert.equal(env.body.firstChild.firstChild,first);assert.equal(selection.toString(),'x\nx\n');assert.ok([...env.body.children].every(node=>node.style.contentVisibility===''&&node.style.containIntrinsicSize===''));
});
