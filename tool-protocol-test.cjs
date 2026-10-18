const test = require('node:test');
const assert = require('node:assert/strict');
const { textualToolRequest, protocolRequestInfo, ProtocolTextBuffer } = require('./src/tool-protocol');
const dsml = '<｜｜DSML｜｜ calls>\n<｜｜DSML｜｜ invoke name="search_web">\n<｜｜DSML｜｜ parameter name="query" string="true">Washington DC current weather forecast today</｜｜DSML｜｜ parameter>\n<｜｜DSML｜｜ parameter name="count" string="false">5</｜｜DSML｜｜ parameter>\n<｜｜DSML｜｜ parameter name="need_content" string="false">true</｜｜DSML｜｜ parameter>\n</｜｜DSML｜｜ invoke>\n</｜｜DSML｜｜ calls>';

test('the reported full-width DSML response is identified without treating parameter names as tool names', () => {
  assert.equal(dsml.length, 354);
  assert.deepEqual(protocolRequestInfo(dsml, 'what about dc'), {leaked:true,webOnly:true});
  for (const text of [dsml, dsml.replace(/｜/g, '|'), dsml.replace(/｜｜/g, '|'), 'Searching now.\n'+dsml+'\nPlease wait.', '```xml\n'+dsml+'\n```', '<tool_call>{"name":"search_web","arguments":{}}</tool_call>']) assert.equal(textualToolRequest(text, 'Check the weather'), true);
  assert.deepEqual(protocolRequestInfo('<||DSML|| invoke name="stage_notebook_edits"></||DSML|| invoke>'), {leaked:true,webOnly:false});
});

test('DSML and XML split at every possible SSE boundary never enter the visible stream', () => {
  for (const markup of [dsml, dsml.replace(/｜/g, '|'), '```xml\n'+dsml+'\n```', '<tool_call>{"name":"search_web","arguments":{}}</tool_call>']) {
    for (let split = 1; split < markup.length; split++) {
      let shown = ''; const buffer = new ProtocolTextBuffer({userText:'Current weather?',onText:value => {shown += value;}});
      buffer.push(markup.slice(0,split)); buffer.push(markup.slice(split));
      assert.deepEqual(buffer.end(), {leaked:true,webOnly:true}); assert.equal(shown, '', 'split '+split);
    }
    let shown = ''; const buffer = new ProtocolTextBuffer({onText:value => {shown += value;}});
    for (const character of markup) buffer.push(character);
    assert.equal(buffer.end().leaked, true); assert.equal(shown, '');
  }
});

test('ordinary long text is emitted incrementally and only a short possible marker is retained', () => {
  const emitted = []; const buffer = new ProtocolTextBuffer({onText:value => emitted.push(value)});
  for (let i=0;i<100;i++) { buffer.push('ordinary paragraph '.repeat(100)); assert.equal(buffer.pending.length,0); }
  assert.equal(emitted.length,100);
  buffer.push('x <'); assert.equal(buffer.pending,'<'); buffer.push('span>normal HTML</span>');
  assert.equal(buffer.end().leaked,false); assert.equal(emitted.join('').endsWith('x <span>normal HTML</span>'),true);
});

test('explicit protocol questions and ordinary examples remain readable', () => {
  for (const [userText,text] of [
    ['What does DSML mean?',dsml], ['Show the exact <tool_call> wrapper','<tool_call>{}</tool_call>'],
    ['Show an XML example','```xml\n'+dsml+'\n```'], ['解释工具调用的格式',dsml],
    ['Explain the format','The following is an example:\n'+dsml],
    ['What happened?', 'This is the protocol syntax:\n```xml\n'+dsml+'\n```']
  ]) {
    let shown=''; const buffer=new ProtocolTextBuffer({userText,onText:value=>{shown+=value;}});
    for (const character of text) buffer.push(character);
    assert.equal(buffer.end().leaked,false,userText); assert.equal(shown,text,userText);
    assert.equal(textualToolRequest(text,userText),false,userText);
  }
});

test('ordinary source fences preserve literal tool tags beyond the short prefix across arbitrary chunks', () => {
  for (const language of ['python','javascript']) {
    const text='```'+language+'\n'+('ordinary_source_line = 1\n'.repeat(100))+'tag = "<tool_call>"\nprotocol = "<||DSML|| calls>"\n```\nParser complete.';
    assert.equal(textualToolRequest(text,'Write a parser'),false);
    for (const chunkSize of [1,7,text.length]) {
      let shown='';const buffer=new ProtocolTextBuffer({userText:'Write a parser',onText:value=>{shown+=value;}});
      for(let index=0;index<text.length;index+=chunkSize)buffer.push(text.slice(index,index+chunkSize));
      assert.equal(buffer.end().leaked,false,language+' '+chunkSize);assert.equal(shown,text);
    }
  }
});

test('a real request after a normal source fence is caught while the source closing fence stays visible', () => {
  const source='```python\n'+('line = 1\n'.repeat(100))+'tag = "<tool_call>"\n```\n';
  for(const chunkSize of [1,7,source.length+dsml.length]) {
    let shown='';const buffer=new ProtocolTextBuffer({userText:'Write a parser',onText:value=>{shown+=value;}});const text=source+dsml;
    for(let index=0;index<text.length;index+=chunkSize)buffer.push(text.slice(index,index+chunkSize));
    assert.equal(buffer.end().leaked,true);assert.equal(shown,source);
  }
});

test('Markdown quotations and inline code preserve protocol markers without invoking recovery', () => {
  const text='Quoted response:\n> <tool_call>{"name":"search_web"}</tool_call>\n> <||DSML|| calls>\n\nThe literal `<tool_call>` and `<||DSML|| calls>` are strings.';
  assert.equal(textualToolRequest(text,'What happened?'),false);
  let shown='';const buffer=new ProtocolTextBuffer({userText:'What happened?',onText:value=>{shown+=value;}});
  for(const character of text)buffer.push(character);
  assert.equal(buffer.end().leaked,false);assert.equal(shown,text);
});

test('a response ending in an identifiable partial DSML opening never releases that marker to the UI', () => {
  for(const text of ['<||DSML|| c','```xml\n<｜｜DSML｜｜ inv']) {
    let shown='';const buffer=new ProtocolTextBuffer({onText:value=>{shown+=value;}});
    for(const character of text)buffer.push(character);
    assert.equal(buffer.end().leaked,true);assert.equal(shown,'');
  }
});
