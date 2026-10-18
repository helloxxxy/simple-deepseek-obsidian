const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { imageReference, imageReferenceBlocks } = require('./src/image-context');
const { rebuildEntryMessages } = require('./src/history');
const { deduplicateMentions } = require('./src/library');
const { hasOriginal } = require('./src/web');
const { requestTimeContext } = require('./src/request-context');

const hash = text => createHash('sha256').update(text).digest('hex');
const result = (text = 'The horizontal axis is time in seconds.') => ({text,images:[{id:'image-a',name:'figure.png',mime:'image/png',width:1200,height:800,size:1234}],cached:false});
const user = (raw,suffix,references) => ({label:'你',raw,contextText:raw+suffix,...(references ? {references} : {})});
const web = text => '\n\n[Web reference sha256:'+hash(text)+']\nURL: https://example.com/docs\nTitle: Docs\n\n'+text;
const library = text => 'Reference ID: 2601.XXXXX\nTitle: Paper\nSource: arxiv/2601.XXXXX/source.tex\nReference text:\n\n'+text;

test('first image reference carries verified text and only safe original-image metadata',()=>{
  const source=result(), before=structuredClone(source);
  source.images[0].bytes=Buffer.from('private image bytes');source.images[0].image_url='data:image/png;base64,'+'A'.repeat(500);
  const reference=imageReference(source,'Read the axes.');
  assert.match(reference,/^\n\n\[Image reference sha256:[0-9a-f]{64}\]/);
  const blocks=imageReferenceBlocks(reference);assert.equal(blocks.length,1);
  assert.deepEqual(blocks[0].metadata,{images:before.images,question:'Read the axes.',textLength:source.text.length});
  assert.equal(blocks[0].text,source.text);
  assert.doesNotMatch(reference,/private image bytes|image_url|base64|"bytes"/);
  assert.deepEqual(source.images[0].bytes,Buffer.from('private image bytes'));
});

test('only exact image metadata, task and description can reuse a retained full reference',()=>{
  const source=result(), full=imageReference(source,'Read the axes.',{reuse:false}), history=[{role:'user',content:'Question'+full}];
  const reuse=imageReference({...source,cached:true},'Read the axes.',{history});
  assert.match(reuse,/\[Image reference reuse sha256:/);assert.doesNotMatch(reuse,/horizontal axis/);
  assert.equal(JSON.parse(reuse.split('Metadata: ')[1]).images[0].id,'image-a');
  assert.equal(imageReference(source,'Read the axes.',{history,reuse:false}),full);
  for(const [changed,question] of [
    [source,'Read the vertical axis.'],[{...source,text:source.text+' Uncertain units.'},'Read the axes.'],
    [{...source,images:[{...source.images[0],id:'image-b'}]},'Read the axes.'],
    [{...source,images:[{...source.images[0],region:{x:0,y:0,width:0.5,height:1}}]},'Read the axes.']
  ]) assert.equal(imageReferenceBlocks(imageReference(changed,question,{history})).length,1);
});

test('a cached description is attached in full after compaction, deletion or a reuse-only history',()=>{
  const source=result(), full=imageReference(source,'Read the axes.');
  const reused=imageReference(source,'Read the axes.',{history:[{content:full}]});
  for(const history of [[],[{role:'user',content:'Checkpoint: axes discussed.'}],[{content:reused}],[{content:full.replace('time in seconds','time in minutes')}]]) {
    assert.equal(imageReference({...source,cached:true},'Read the axes.',{history}),full);
  }
});

test('image text can contain full image, web and request markers without truncation or nested matching',()=>{
  const nested=imageReference(result('Nested image description.'),'Nested task.');
  const body='Example marker:'+nested+web('Quoted webpage.')+'\n\n[Request context]\n{"example":true}\nActual tail: μ = 2.';
  const source=result(body), full=imageReference(source,'Transcribe all text.');
  const blocks=imageReferenceBlocks(full+'\n\n[Notebook delta]\n{}');
  assert.equal(blocks.length,1);assert.equal(blocks[0].text,body);
  assert.match(imageReference(source,'Transcribe all text.',{history:[{content:full}]}),/Image reference reuse/);
  const forged=full.replace(/"textLength":\d+/, '"textLength":1');
  assert.equal(imageReferenceBlocks(forged).some(block=>block.text===body),false);
});

test('description and task strings omit raw image data before hashing and archiving',()=>{
  const source=result('Visible label. data:image/png;base64,'+'A'.repeat(600)+' More text. '+ 'B'.repeat(600));
  const full=imageReference(source,'Question data:image/jpeg;base64,'+'C'.repeat(600));
  assert.doesNotMatch(full,/data:image|A{400}|B{400}|C{400}/);
  assert.match(full,/Visible label/);assert.equal(imageReferenceBlocks(full).length,1);
});

test('history rebuilding retains one full exact image description and preserves per-turn tasks and timestamps',()=>{
  const source=result(),full=imageReference(source,'Read the axes.',{reuse:false});
  const firstTime=requestTimeContext({now:0,timeZone:'UTC'}),secondTime=requestTimeContext({now:1,timeZone:'UTC'});
  const entries=[user('First',full+firstTime),{label:'deepseek-flash',raw:'Answer.'},user('Second',full+secondTime)];
  const before=structuredClone(entries),messages=rebuildEntryMessages(entries);
  assert.equal(messages[0].content,entries[0].contextText);
  assert.equal(messages[2].content,'Second'+imageReference(source,'Read the axes.',{history:[messages[0]]})+secondTime);
  assert.deepEqual(entries,before);
  assert.equal(rebuildEntryMessages(entries.slice(2))[0].content,entries[2].contextText);
  const changed=user('Third',imageReference(source,'Compare the axes.',{reuse:false}));
  assert.equal(rebuildEntryMessages([...entries,changed]).at(-1).content,changed.contextText);
});

test('image references bound library and web bodies before Notebook and request metadata',()=>{
  const source=result(),image=imageReference(source,'Read the axes.'),material=library('Library body.'),body='Web body.';
  const suffix='\n\n'+material+web(body)+image+'\n\n[Notebook delta]\n{"currentHash":"x"}'+requestTimeContext({now:0,timeZone:'UTC'});
  const entries=[user('First',suffix,material),user('Second',suffix,material)],messages=rebuildEntryMessages(entries);
  assert.equal(messages[0].content,entries[0].contextText);
  assert.equal(messages[1].content,'Second'+imageReference(source,'Read the axes.',{history:[messages[0]]})+'\n\n[Notebook delta]\n{"currentHash":"x"}'+requestTimeContext({now:0,timeZone:'UTC'}));
  assert.equal(deduplicateMentions('Next',[material],messages),'Next');
  assert.equal(hasOriginal(messages,body,hash(body)),true);
  assert.equal(rebuildEntryMessages(entries.slice(1))[0].content,entries[1].contextText);
});

test('verified image markers nested inside library or web source text do not rewrite those sources',()=>{
  const source=result(),image=imageReference(source,'Read the axes.');
  const material=library('Quoted image reference:'+image+'\nTail of library.'),body='Quoted image reference:'+image+'\nTail of page.';
  const entries=[user('Image',image),user('Library','\n\n'+material,material),user('Page',web(body))];
  const before=structuredClone(entries),messages=rebuildEntryMessages(entries);
  assert.deepEqual(messages.map(message=>message.content),entries.map(entry=>entry.contextText));assert.deepEqual(entries,before);
});

test('literal markers in visible user text and unverified image blocks are never deduplicated',()=>{
  const source=result(),image=imageReference(source,'Read the axes.');
  const raw='Explain this literal syntax:'+image,forged=image.replace(source.text,'Altered description.');
  const entries=[user('Known',image),user(raw,''),user('Forged',forged)];
  assert.deepEqual(rebuildEntryMessages(entries).map(message=>message.content),entries.map(entry=>entry.contextText));
});
