const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const { mathExpressions } = require('./src/markdown');
const { annotateMath, selectionInside, selectionToMarkdown, copySelection } = require('./src/selection-copy');

function fixture(html) {
  const dom = new JSDOM('<div id="feed"><div class="sd-body">' + html + '</div></div><textarea></textarea>');
  const doc = dom.window.document, feed = doc.querySelector('#feed'), body = feed.querySelector('.sd-body');
  const select = (start, startOffset, end = start, endOffset = startOffset) => {
    const range = doc.createRange(); range.setStart(start, startOffset); range.setEnd(end, endOffset);
    const selection = doc.getSelection(); selection.removeAllRanges(); selection.addRange(range); return selection;
  };
  const all = () => select(body, 0, body, body.childNodes.length);
  return { dom, doc, feed, body, select, all };
}
test('selected portions retain emphasis and link syntax without copying surrounding text', () => {
  const f = fixture('<p>Start <strong>bold text</strong> and <a href="https://example.com/a_(b)">link label</a> end</p>');
  const selection = f.select(f.body.querySelector('strong').firstChild, 5, f.body.querySelector('a').firstChild, 4);
  assert.equal(selectionToMarkdown(selection, f.feed), '**text** and [link](https://example.com/a_\\(b\\))');
  assert.equal(f.body.querySelector('strong').textContent, 'bold text');
});
test('whole paragraphs and headings produce Markdown separated by blank lines', () => {
  const f = fixture('<h2>Heading</h2><p>One <em>word</em>.</p><p>Two <del>old</del> <mark>highlight</mark>.</p>');
  assert.equal(selectionToMarkdown(f.all(), f.feed), '## Heading\n\nOne *word*.\n\nTwo ~~old~~ ==highlight==.');
});
test('partial code block keeps its language and uses a fence that cannot be closed by its content', () => {
  const f = fixture('<pre><button>Copy</button><code class="language-python">before\nx = `value`\n```\nafter</code></pre>');
  const node = f.body.querySelector('code').firstChild;
  const selection = f.select(node, 'before\n'.length, node, node.data.indexOf('after'));
  assert.equal(selectionToMarkdown(selection, f.feed), '````python\nx = `value`\n```\n````');
});
test('inline code stays code and ordinary text is escaped as literal Markdown', () => {
  const f = fixture('<p>A <code>call(`x`)</code> and literal *stars* $5.</p>');
  assert.equal(selectionToMarkdown(f.all(), f.feed), 'A ``call(`x`)`` and literal \\*stars\\* \\$5.');
});
test('long code selections with many backtick runs copy completely without an argument-list overflow', () => {
  const text = 'x`y '.repeat(150000) + 'end';
  for (const block of [true,false]) {
    const f = fixture(block ? '<pre><code class="language-python"></code></pre>' : '<p><code></code></p>');
    f.body.querySelector('code').textContent = text;
    assert.equal(selectionToMarkdown(f.all(), f.feed), block ? '```python\n' + text + '\n```' : '``' + text + '``');
    f.dom.window.close();
  }
});
test('ordered lists retain numbering, nested lists and task checkboxes', () => {
  const f = fixture('<ol start="3"><li>alpha</li><li>beta<ul><li>child</li></ul></li></ol><ul><li><input type="checkbox" checked>done</li></ul>');
  assert.equal(selectionToMarkdown(f.all(), f.feed), '3. alpha\n4. beta\n   - child\n\n- [x] done');
  const selection = f.select(f.body.querySelector('ol > li:last-child').firstChild, 0, f.body.querySelector('ol > li:last-child').firstChild, 4);
  assert.equal(selectionToMarkdown(selection, f.feed), '4. beta');
});
test('table selections produce a Markdown table with a header separator', () => {
  const f = fixture('<table><thead><tr><th>Name</th><th>Value</th></tr></thead><tbody><tr><td>a|b</td><td><strong>2</strong></td></tr></tbody></table>');
  assert.equal(selectionToMarkdown(f.all(), f.feed), '| Name | Value |\n| --- | --- |\n| a\\|b | **2** |');
});
test('math source is recovered from rendered inline and display expressions', () => {
  const f = fixture('<p>Use <span class="math"><mjx-container><span>x</span></mjx-container></span>.</p><div class="math-block"><mjx-container display="true"><span>y</span></mjx-container></div>');
  annotateMath(f.body, 'Use $x^2$.\n\n\\[y = 1\\]');
  assert.equal(selectionToMarkdown(f.all(), f.feed), 'Use $x^2$.\n\n$$y = 1$$');
  const inside = f.body.querySelector('.math span').firstChild;
  assert.equal(selectionToMarkdown(f.select(inside, 0, inside, 1), f.feed), '$x^2$');
});
test('formula scanner excludes code, escaped currency and links, and does not guess on a count mismatch', () => {
  const source = 'Text $x$ and `code $not_math$`\n\n```tex\n$$also_not_math$$\n```\n\n\\$5 and [link](url/$ignored$)\n\n$$y$$';
  assert.deepEqual(mathExpressions(source), ['$x$', '$$y$$']);
  const f = fixture('<span class="math">x</span>'); annotateMath(f.body, '$x$ and $y$');
  assert.equal(f.body.querySelector('.math').hasAttribute('data-sd-math'), false);
});
test('raw streaming text and renderer fallback preserve selected Markdown literally', () => {
  const f = fixture('<div class="sd-render-fallback">**raw** $x$</div><span class="sd-stream-tail">## next</span>');
  const node = f.body.querySelector('.sd-render-fallback').firstChild;
  assert.equal(selectionToMarkdown(f.select(node, 0, node, node.data.length), f.feed), '**raw** $x$');
});
test('copying across replies excludes controls, message labels and hidden thinking', () => {
  const f = fixture('<p>First <strong>reply</strong></p>');
  f.feed.insertAdjacentHTML('beforeend', '<div class="sd-message-head">DeepSeek<button>Copy</button></div><details class="sd-thinking"><summary>Thinking</summary><div class="sd-thinking-body">Hidden thought</div></details><div class="sd-body"><p>Second reply</p></div>');
  const first = f.body.querySelector('p').firstChild, last = f.feed.querySelectorAll('.sd-body')[1].firstChild.firstChild;
  assert.equal(selectionToMarkdown(f.select(first, 0, last, last.data.length), f.feed), 'First **reply**\n\nSecond reply');
});
test('expanded thinking copies exact selected plain text across display chunks without invented newlines',()=>{
  const f=fixture('');f.feed.innerHTML='<details class="sd-thinking" open><summary>Thinking</summary><div class="sd-thinking-body"><div>  **literal** $x$\n</div><div>continued\n\nfinal  </div></div></details>';
  const body=f.feed.querySelector('.sd-thinking-body'),first=body.firstChild.firstChild,last=body.lastChild.firstChild;
  assert.equal(selectionToMarkdown(f.select(first,0,last,last.data.length),f.feed),'  **literal** $x$\ncontinued\n\nfinal  ');
  assert.equal(selectionToMarkdown(f.select(first,4,last,5),f.feed),'literal** $x$\nconti');
  body.parentElement.open=false;assert.equal(selectionToMarkdown(f.select(first,0,last,last.data.length),f.feed),null);
});
test('mixed selections include expanded thinking and source Markdown links in DOM order without summary controls',()=>{
  const f=fixture('');f.feed.innerHTML='<details class="sd-thinking" open><summary>Thinking<button>Control</button></summary><div class="sd-thinking-body"><div>Plain *thought*.</div></div></details><div class="sd-body"><p>Answer <strong>text</strong>.</p></div><details class="sd-sources" open><summary>Retrieved pages (1)</summary><div class="sd-sources-body"><ul><li><a href="https://example.com/a_(b)">A *title*</a></li></ul></div></details>';
  const first=f.feed.querySelector('.sd-thinking-body div').firstChild,last=f.feed.querySelector('a').firstChild;
  assert.equal(selectionToMarkdown(f.select(first,0,last,last.data.length),f.feed),'Plain *thought*.\n\nAnswer **text**.\n\n- [A \\*title\\*](https://example.com/a_\\(b\\))');
  f.feed.querySelector('.sd-sources').open=false;assert.equal(selectionToMarkdown(f.select(first,0,last,last.data.length),f.feed),'Plain *thought*.\n\nAnswer **text**.');
});
test('hidden thinking and source bodies stay excluded even when stale DOM remains in the selection',()=>{
  const f=fixture('<p>Visible answer</p>');f.feed.insertAdjacentHTML('afterbegin','<details class="sd-thinking" open hidden><div class="sd-thinking-body">hidden text</div></details>');f.feed.insertAdjacentHTML('beforeend','<details class="sd-sources" open hidden><div class="sd-sources-body"><a href="https://example.com/hidden">hidden source</a></div></details>');
  assert.equal(selectionToMarkdown(f.select(f.feed,0,f.feed,f.feed.childNodes.length),f.feed),'Visible answer');
});
test('copy event writes plain Markdown only, leaving input and out-of-chat copies alone', () => {
  const f = fixture('<p><strong>bold</strong></p>'); f.all();
  const data = new Map([['text/html', '<b>bold</b>']]), event = { target: f.body, clipboardData: { clearData: () => data.clear(), setData: (type, value) => data.set(type, value) }, preventDefault() { this.prevented = true; }, stopPropagation() {} };
  assert.equal(copySelection(event, f.feed), true); assert.equal(event.prevented, true);
  assert.deepEqual([...data], [['text/plain', '**bold**']]);
  assert.equal(copySelection({ ...event, target: f.doc.querySelector('textarea') }, f.feed), false);
  const outside = f.doc.createTextNode('outside'); f.doc.body.append(outside);
  assert.equal(selectionToMarkdown(f.select(outside, 0, outside, 3), f.feed), null);
  f.doc.getSelection().removeAllRanges(); assert.equal(selectionInside(f.body), false);
});

test('a local selection among a thousand replies visits only the selected body while retaining ancestor formatting', t => {
  const f = fixture(''); t.after(() => f.dom.window.close());
  f.feed.innerHTML = Array.from({length:1000},(_,index) => '<article><div class="sd-body"><p>Before <strong>target ' + index + '</strong> after.</p></div></article>').join('');
  const target = f.feed.children[550].querySelector('strong').firstChild, selection = f.select(target,0,target,target.length);
  let bodyChecks = 0; const intersectsNode = f.dom.window.Range.prototype.intersectsNode;
  f.dom.window.Range.prototype.intersectsNode = function(node) { if (node.nodeType === 1 && node.matches('.sd-body')) bodyChecks++; return intersectsNode.call(this,node); };
  t.after(() => { f.dom.window.Range.prototype.intersectsNode = intersectsNode; });
  assert.equal(selectionToMarkdown(selection,f.feed),'**target 550**');
  assert.ok(bodyChecks <= 3,'a local copy should not inspect every unrelated reply');
  const outside = f.doc.querySelector('textarea'); outside.textContent = 'outside';
  assert.equal(selectionToMarkdown(f.select(target,0,outside.firstChild,3),f.feed),null);
});

test('a selection spanning virtual Markdown chunks preserves formulas and paragraph boundaries', () => {
  const f = fixture('<div class="sd-markdown-chunk"><p>Before <strong>bold</strong></p></div><div class="sd-markdown-chunk"><p><span class="math" data-math="x^2">x</span> after.</p></div>');
  const first = f.body.querySelector('strong').firstChild,last = f.body.querySelector('.math').firstChild;
  assert.equal(selectionToMarkdown(f.select(first,2,last,1),f.feed),'**ld**\n\n$x^2$');
  f.dom.window.close();
});
