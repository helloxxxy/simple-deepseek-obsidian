const { test } = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const { NotebookPatchView } = require('./src/notebook-patch-view');
const { selectionToMarkdown, copySelection } = require('./src/selection-copy');

function fixture(initial, options = {}) {
  const dom = new JSDOM('<!doctype html><div id="feed"><div class="sd-body" id="patch"></div></div>');
  const document = dom.window.document, host = document.querySelector('#patch'), feed = document.querySelector('#feed');
  let patch = initial, language = options.language || 'en';
  const view = new NotebookPatchView({ host, getPatch: () => patch, getLanguage: () => language, ...(options.visible === undefined ? {} : { visible: options.visible }) });
  return { dom, document, host, feed, view, patch(value) { patch = value; view.refresh(); }, language(value) { language = value; view.refresh(); }, close() { view.dispose(); dom.window.close(); } };
}
const patch = operations => ({ baseHash: 'a'.repeat(64), operations });
const codePatch = source => patch([{ type: 'set_source', cellId: 'code-cell', source }]);
function selectText(env, node, start = 0, end = node.textContent.length) {
  const range = env.document.createRange(), text = node.firstChild;
  range.setStart(text, start); range.setEnd(text, end);
  const selection = env.document.getSelection(); selection.removeAllRanges(); selection.addRange(range); return selection;
}
function clearSelection(env) {
  env.document.getSelection().removeAllRanges(); env.document.dispatchEvent(new env.dom.window.Event('selectionchange'));
}

test('Notebook source view shows real newlines and whitespace without JSON string escapes', () => {
  const source = 'def answer():\n    value = "literal \\n text"\n    return value\n';
  const env = fixture(codePatch(source));
  try {
    assert.equal(env.host.hidden, false); assert.equal(env.host.querySelectorAll('pre code').length, 1);
    assert.equal(env.host.querySelector('code').textContent, source);
    assert.equal(env.host.querySelector('code').textContent.split('\n').length, 4);
    assert.match(env.host.querySelector('.sd-notebook-patch-operation-title').textContent, /Update cell code-cell/);
    assert.equal(env.host.querySelector('code').textContent.includes('"source":'), false);
  } finally { env.close(); }
});

test('Notebook source view displays set insert replace and delete operations in order', () => {
  const value = patch([
    { type: 'insert_cell', index: 0, cellId: 'intro', cellType: 'markdown', source: '# Title\n\n**literal Markdown**' },
    { type: 'set_source', index: 1, cellId: 'code', source: 'print(1)\nprint(2)' },
    { type: 'replace_text', cellId: 'code', oldText: 'old\ntext', newText: 'new\ntext' },
    { type: 'delete_cell', cellId: 'obsolete', index: 3 }
  ]);
  const env = fixture(value);
  try {
    const operations = [...env.host.querySelectorAll('.sd-notebook-patch-operation')];
    assert.deepEqual(operations.map(node => node.dataset.operation), ['insert_cell', 'set_source', 'replace_text', 'delete_cell']);
    assert.match(operations[0].querySelector('p').textContent, /^1\. Insert/); assert.match(operations[3].textContent, /^4\. Delete cell obsolete/);
    assert.equal(operations[0].querySelector('code').className, 'language-markdown');
    assert.equal(operations[0].querySelector('code').textContent, value.operations[0].source);
    assert.equal(operations[0].querySelector('strong'), null);
    assert.deepEqual([...operations[2].querySelectorAll('code')].map(node => node.textContent), ['old\ntext', 'new\ntext']);
    assert.deepEqual([...operations[2].querySelectorAll('.sd-notebook-patch-fragment-title')].map(node => node.textContent), ['Original text', 'Replacement text']);
    assert.equal(operations[3].querySelector('pre'), null);
  } finally { env.close(); }
});

test('Notebook source view keeps empty rewrites and replacements empty instead of inserting placeholder source', () => {
  const env = fixture(patch([{ type: 'set_source', cellId: 'clear', source: '' }, { type: 'replace_text', cellId: 'delete-fragment', oldText: 'remove me', newText: '' }]));
  try { assert.deepEqual([...env.host.querySelectorAll('code')].map(node => node.textContent), ['', 'remove me', '']); }
  finally { env.close(); }
});

test('Notebook source view treats script HTML URLs and code fences as inert source text', () => {
  const source = '<script>window.notebookSourceExecuted = true</script>\n<img src="https://invalid.example/image" onerror="alert(1)">\n```python\nprint("literal fence")\n```';
  const env = fixture(codePatch(source));
  try {
    assert.equal(env.host.querySelector('code').textContent, source);
    assert.equal(env.host.querySelector('script,img,iframe,a'), null);
    assert.equal(env.dom.window.notebookSourceExecuted, undefined);
    assert.equal(env.host.querySelectorAll('code').length, 1);
  } finally { env.close(); }
});

test('Notebook source view hides missing empty or unfinished patches without executing operations', () => {
  const env = fixture(null);
  try {
    assert.equal(env.host.hidden, true); assert.equal(env.host.childNodes.length, 0);
    for (const value of [patch([]), {}, patch([{ type: 'source_chunk', source: 'incomplete' }]), patch([{ type: 'set_source', source: null }])]) {
      env.patch(value); assert.equal(env.host.hidden, true); assert.equal(env.host.childNodes.length, 0);
    }
    env.patch(codePatch('ready\n')); assert.equal(env.host.hidden, false); assert.equal(env.host.querySelector('code').textContent, 'ready\n');
    env.patch(null); assert.equal(env.host.hidden, true); assert.equal(env.host.childNodes.length, 0);
  } finally { env.close(); }
});

test('Notebook source view responds to patch identity and UI language changes without mutating canonical data', () => {
  const original = codePatch('x = 1\n'), before = JSON.stringify(original), env = fixture(original);
  try {
    const code = env.host.querySelector('code'); env.view.refresh(); assert.equal(env.host.querySelector('code'), code);
    env.language('zh'); assert.match(env.host.querySelector('.sd-notebook-patch-operation-title').textContent, /修改单元格/);
    env.patch(codePatch('x = 2\n')); assert.equal(env.host.querySelector('code').textContent, 'x = 2\n');
    assert.equal(JSON.stringify(original), before);
    env.patch(patch([{ type: 'replace_text', cellId: 'code', oldText: 'a', newText: 'b' }]));
    assert.deepEqual([...env.host.querySelectorAll('.sd-notebook-patch-fragment-title')].map(node => node.textContent), ['原文', '新文']);
  } finally { env.close(); }
});

test('Notebook source view avoids building source DOM when constructed offscreen', () => {
  const env = fixture(codePatch('large\n'.repeat(20000)), { visible: false });
  try {
    assert.equal(env.host.hidden, false); assert.equal(env.host.childNodes.length, 0);
    env.view.refresh(); assert.equal(env.host.childNodes.length, 0);
    env.view.setVisible(true); assert.equal(env.host.querySelector('code').textContent.length, 120000);
  } finally { env.close(); }
});

test('Notebook source view releases offscreen source DOM with a measured height and restores the original height style', () => {
  const env = fixture(codePatch('one\ntwo\n'));
  try {
    env.host.style.minHeight = '7px'; env.host.getBoundingClientRect = () => ({ height: 250.2 });
    env.view.setVisible(false); assert.equal(env.host.childNodes.length, 0); assert.equal(env.host.style.minHeight, '251px');
    env.view.refresh(); assert.equal(env.host.style.minHeight, '251px');
    env.patch(codePatch('new\nsource\n')); assert.equal(env.host.childNodes.length, 0); assert.equal(env.host.style.minHeight, '251px');
    env.view.setVisible(true); assert.equal(env.host.querySelector('code').textContent, 'new\nsource\n'); assert.equal(env.host.style.minHeight, '7px');
    env.view.setVisible(false); env.patch(null); assert.equal(env.host.hidden, true); assert.equal(env.host.style.minHeight, '7px');
  } finally { env.close(); }
});

test('Notebook source view defers offscreen release while source is selected', () => {
  const env = fixture(codePatch('keep selection\nnext line'));
  try {
    const code = env.host.querySelector('code'); selectText(env, code, 0, 14); env.host.getBoundingClientRect = () => ({ height: 170 });
    env.view.setVisible(false); assert.equal(env.host.querySelector('code'), code); assert.equal(env.document.getSelection().toString(), 'keep selection');
    clearSelection(env); assert.equal(env.host.childNodes.length, 0); assert.equal(env.host.style.minHeight, '170px');
    env.view.setVisible(true); assert.equal(env.host.querySelector('code').textContent, 'keep selection\nnext line');
  } finally { env.close(); }
});

test('Notebook source view defers patch and language replacement until a selection is cleared', () => {
  const env = fixture(codePatch('selected source\n'));
  try {
    const code = env.host.querySelector('code'); selectText(env, code, 0, 8);
    env.patch(codePatch('replacement\n')); env.language('zh'); assert.equal(env.host.querySelector('code'), code); assert.match(env.host.querySelector('p').textContent, /Update/);
    assert.equal(env.document.getSelection().toString(), 'selected'); clearSelection(env);
    assert.equal(env.host.querySelector('code').textContent, 'replacement\n'); assert.match(env.host.querySelector('p').textContent, /修改单元格/);
  } finally { env.close(); }
});

test('Notebook source view does not hide selected text when its patch is removed', () => {
  const env = fixture(codePatch('still selected'));
  try {
    selectText(env, env.host.querySelector('code')); env.patch(null); assert.equal(env.host.hidden, false); assert.equal(env.document.getSelection().toString(), 'still selected');
    clearSelection(env); assert.equal(env.host.hidden, true); assert.equal(env.host.childNodes.length, 0);
  } finally { env.close(); }
});

test('Notebook source selection uses the existing Markdown copy serializer with real lines and safe fences', () => {
  const source = 'first\n```literal```\nlast', env = fixture(codePatch(source));
  try {
    selectText(env, env.host.querySelector('code')); const expected = '````\n'+source+'\n````';
    assert.equal(selectionToMarkdown(env.document.getSelection(), env.feed), expected);
    const values = new Map(), event = new env.dom.window.Event('copy', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'clipboardData', { value: { clearData() { values.clear(); }, setData(type, text) { values.set(type, text); } } });
    env.host.querySelector('code').addEventListener('copy', value => copySelection(value, env.feed)); env.host.querySelector('code').dispatchEvent(event);
    assert.equal(event.defaultPrevented, true); assert.equal(values.get('text/plain'), expected);
  } finally { env.close(); }
});

test('Notebook source partial selection copies just the selected code as Markdown', () => {
  const env = fixture(patch([{ type: 'insert_cell', cellType: 'markdown', source: '# First\n\n**second**\nthird' }]));
  try {
    selectText(env, env.host.querySelector('code'), 9, 19);
    assert.equal(selectionToMarkdown(env.document.getSelection(), env.feed), '```markdown\n**second**\n```');
  } finally { env.close(); }
});

test('Notebook source view disposal clears DOM and selection watchers and prevents later revival', () => {
  const env = fixture(codePatch('selected source'));
  try {
    env.host.style.minHeight = '8px'; env.host.getBoundingClientRect = () => ({ height: 200 });
    selectText(env, env.host.querySelector('code')); env.view.setVisible(false); assert.equal(env.view.watchingSelection, true);
    env.view.dispose(); assert.equal(env.view.watchingSelection, false); assert.equal(env.host.childNodes.length, 0); assert.equal(env.host.hidden, true); assert.equal(env.host.style.minHeight, '8px');
    clearSelection(env); env.patch(codePatch('must not appear')); env.view.setVisible(true); env.view.refresh(); assert.equal(env.host.childNodes.length, 0); assert.equal(env.host.hidden, true);
  } finally { env.close(); }
});

test('language switches relabel large Notebook operations without rebuilding or copying their source DOM',()=>{
  const source='print("large source")\n'.repeat(10000),value=codePatch(source),env=fixture(value);try{const code=env.host.querySelector('code'),before=JSON.stringify(value),create=env.document.createElement.bind(env.document);let codeCreates=0;env.document.createElement=(tag,...args)=>{if(tag==='code')codeCreates++;return create(tag,...args);};for(let index=0;index<10;index++)env.language(index%2?'en':'zh');assert.equal(codeCreates,0);assert.equal(env.host.querySelector('code'),code);assert.equal(code.textContent,source);assert.match(env.host.querySelector('p').textContent,/Update cell/);assert.equal(JSON.stringify(value),before);}finally{env.close();}
});

test('a single changed operation replaces only its source while equivalent patch copies keep all code nodes',()=>{
  const operations=Array.from({length:100},(_,index)=>({type:'set_source',cellId:'cell-'+index,source:('line '+index+'\n').repeat(100)})),env=fixture(patch(operations));try{const original=[...env.host.querySelectorAll('code')],create=env.document.createElement.bind(env.document);let codeCreates=0;env.document.createElement=(tag,...args)=>{if(tag==='code')codeCreates++;return create(tag,...args);};const changed=operations.map(op=>({...op}));changed[50].source='only this source changed\n';env.patch(patch(changed));const current=[...env.host.querySelectorAll('code')];assert.equal(codeCreates,1);assert.equal(current[50].textContent,changed[50].source);for(let index=0;index<100;index++)if(index!==50)assert.equal(current[index],original[index]);env.patch(patch(changed.map(op=>({...op}))));assert.equal(codeCreates,1);assert.deepEqual([...env.host.querySelectorAll('code')],current);}finally{env.close();}
});

test('operation reuse still detects in-place edits and rejects an operation mutated to an incomplete chunk',()=>{
  const value=codePatch('initial source\n'),env=fixture(value);try{value.operations[0].source='edited in place\n';env.view.refresh();assert.equal(env.host.querySelector('code').textContent,'edited in place\n');value.operations[0].type='source_chunk';env.view.refresh();assert.equal(env.host.hidden,true);assert.equal(env.host.childNodes.length,0);}finally{env.close();}
});

test('offscreen Notebook refreshes do not repeatedly mutate an already empty placeholder',()=>{
  const env=fixture(codePatch('line\n'.repeat(20000)));try{env.host.getBoundingClientRect=()=>({height:900});const replace=env.host.replaceChildren.bind(env.host);let replacements=0;env.host.replaceChildren=(...nodes)=>{replacements++;return replace(...nodes);};env.view.setVisible(false);assert.equal(replacements,1);for(let index=0;index<200;index++)env.view.refresh();assert.equal(replacements,1);assert.equal(env.host.childNodes.length,0);assert.equal(env.host.style.minHeight,'900px');env.view.setVisible(true);assert.equal(env.host.querySelector('code').textContent,'line\n'.repeat(20000));}finally{env.close();}
});

test('changing another operation and language preserves selected source nodes through deferred reconciliation',()=>{
  const value=patch([{type:'set_source',cellId:'selected',source:'keep this selection\n'},{type:'set_source',cellId:'changed',source:'old\n'}]),env=fixture(value);try{const selected=env.host.querySelector('code');selectText(env,selected,0,9);env.patch(patch([value.operations[0],{...value.operations[1],source:'new\n'}]));env.language('zh');assert.equal(env.host.querySelector('code'),selected);assert.equal(env.document.getSelection().toString(),'keep this');assert.equal(env.host.querySelectorAll('code')[1].textContent,'old\n');clearSelection(env);assert.equal(env.host.querySelector('code'),selected);assert.equal(env.host.querySelectorAll('code')[1].textContent,'new\n');assert.match(env.host.querySelector('p').textContent,/修改单元格/);}finally{env.close();}
});
