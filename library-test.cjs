const {test}=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs/promises');const path=require('node:path');const {createHash}=require('node:crypto');const {gzipSync}=require('node:zlib');const {zipSync,strToU8}=require('fflate');const {JSDOM}=require('jsdom');const Parser=new JSDOM('').window.DOMParser;
const lib=require('./src/library'),source=require('./src/arxiv-source');
const baseOverview='\n---\n\n### ARXIV\n\n---\n\n#### 2001.00001 | Old\n\n> Old Author\n> \n> [[Old-2020-A.pdf|pdf]], [web](https://arxiv.org/abs/2001.00001), [[notes#Old|notes]]\n\n\n---\n\n### BOOK\n\n---\n\n#### 9780120831821 | Book\n\n> Book Author\n> [[Book.pdf|pdf]]\n\n---\n\n### OTHER PAPER\n\n---\n';
const xml=id=>`<html><head><meta name="citation_arxiv_id" content="${id}"><meta name="citation_title" content="A &amp; B paper"><meta name="citation_author" content="Doe, Jane"><meta name="citation_pdf_url" content="https://arxiv.org/pdf/${id}"></head><body><a href="https://arxiv.org/abs/${id}v2">arXiv:${id}v2</a><a href="/src/${id}">TeX Source</a></body></html>`;

const tex='\\documentclass{article}\n\\title{Title}\n\\begin{document}\n\\input{part}\n\\end{document}';
const bundle=()=>Buffer.from(zipSync({'main.tex':strToU8(tex),'part.tex':strToU8('BODY')}));
async function fixture(fn){const root=await fs.mkdtemp(path.join(__dirname,'library-test-'));try{await fs.mkdir(path.join(root,'arxiv'));await fs.mkdir(path.join(root,'book','9780120831821'),{recursive:true});await fs.mkdir(path.join(root,'otherpaper'));await fs.writeFile(path.join(root,'book','9780120831821','Book.pdf'),'%PDF-fake');await fs.writeFile(path.join(root,'OVERVIEW.md'),baseOverview);await fn(root);}finally{const resolved=await fs.realpath(root);if(path.dirname(resolved)!==await fs.realpath(__dirname)||!path.basename(resolved).startsWith('library-test-'))throw Error('Unsafe fixture cleanup');await fs.rm(resolved,{recursive:true});}}
const signal=()=>new AbortController().signal;
function fakeGet(id,src=bundle()){return async url=>url.includes('/abs/')?Buffer.from(xml(id)):url.includes('/src/')?src:Buffer.from('%PDF-test');}
test('arxiv ids: normalize modern and historical URL forms; reject arbitrary hosts or DOI',()=>{
 assert.equal(lib.arxivId('arXiv:2101.12345'),'2101.12345');assert.equal(lib.arxivId('https://arxiv.org/pdf/cond-mat/0203193v2.pdf'),'cond-mat/0203193v2');for(const s of ['https://evil.test/pdf/2101.12345','../x','10.1234/a','9780120831821'])assert.throws(()=>lib.arxivId(s));
});
test('empty library: scanning stays empty and first arXiv import creates the standard layout',async()=>{
 const root=await fs.mkdtemp(path.join(__dirname,'library-test-'));try{
  assert.deepEqual(await lib.scanLibrary(root),[]);assert.deepEqual(await fs.readdir(root),[]);
  const record=await lib.importArxiv(root,'2101.12345',signal(),()=>{},{get:fakeGet('2101.12345'),Parser});assert.equal(record.id,'2101.12345');
  assert.deepEqual((await fs.readdir(root)).sort(),['OVERVIEW.md','arxiv','book','otherpaper']);const overview=await fs.readFile(path.join(root,'OVERVIEW.md'),'utf8');
  for(const heading of ['### ARXIV','### BOOK','### OTHER PAPER'])assert.ok(overview.includes(heading));assert.match(overview,/#### 2101\.12345 \| A & B paper/);
 }finally{await fs.rm(root,{recursive:true});}
 const incomplete=await fs.mkdtemp(path.join(__dirname,'library-test-'));try{await fs.writeFile(path.join(incomplete,'unrelated.txt'),'keep');await assert.rejects(lib.scanLibrary(incomplete),error=>error.code==='ENOENT');assert.equal(await fs.readFile(path.join(incomplete,'unrelated.txt'),'utf8'),'keep');}finally{await fs.rm(incomplete,{recursive:true});}
});
test('source: plain gzip zip and nested include flatten without interpreting comments or verbatim',()=>{
 const text=tex.replace('\\input{part}','% \\input{missing}\n\\begin{verbatim}\\input{missing}\\end{verbatim}\n\\verb|\\input{missing}|\n\\input{part}');
 const result=source.flattenSource(zipSync({'main.tex':strToU8(text),'part.tex':strToU8('BODY')}));assert.match(result.text,/BODY/);assert.deepEqual(result.unresolved,[]);assert.match(result.text,/% \\input\{missing\}/);
 assert.ok(source.flattenSource(gzipSync(Buffer.from(tex))).text);assert.ok(source.flattenSource(Buffer.from(tex)).text);assert.equal(source.flattenSource(Buffer.from('%PDF-test')).text,null);assert.equal(source.flattenSource(Buffer.alloc(0)).text,null);
});
test('source: rejects archive traversal and cyclic include; retains unresolved include',()=>{
 assert.throws(()=>source.sourceFiles(zipSync({'../bad.tex':strToU8(tex)})));assert.throws(()=>source.flattenSource(zipSync({'main.tex':strToU8(tex),'part.tex':strToU8('\\input{main}')})),/循环/);assert.deepEqual(source.flattenSource(Buffer.from(tex)).unresolved,['part']);
});
test('source: nested include resolves parent file inside source root',()=>{
 const result=source.flattenSource(zipSync({'nested/main.tex':strToU8(tex.replace('{part}','{../part}')),'part.tex':strToU8('BODY')}));assert.match(result.text,/BODY/);
});
function tarFile(name,body,type='0'){body=Buffer.from(body);const h=Buffer.alloc(512);h.write(name);h.write('0000644\0',100);h.write('0000000\0',108);h.write('0000000\0',116);h.write(body.length.toString(8).padStart(11,'0')+'\0',124);h.write('00000000000\0',136);h.fill(32,148,156);h.write(type,156);h.write('ustar\0',257);h.write(h.reduce((a,b)=>a+b,0).toString(8).padStart(6,'0')+'\0 ',148);return Buffer.concat([h,body,Buffer.alloc((512-body.length%512)%512)]);}
test('source: tar gzip expansion and link rejection',()=>{
 const tar=Buffer.concat([tarFile('./main.tex',tex),tarFile('part.tex','BODY'),Buffer.alloc(1024)]);assert.match(source.flattenSource(gzipSync(tar)).text,/BODY/);assert.throws(()=>source.sourceFiles(Buffer.concat([tarFile('link','target','2'),Buffer.alloc(1024)])),/链接/);
});
test('overview: chronological insert preserves every old byte and other sections',()=>{
 for(const id of ['cond-mat/9901001','2001.00000','2001.00002','2601.11111']){const info={id,title:'New title',authors:['New Author'],pdf:'New.pdf'};const updated=lib.insertOverview(baseOverview,info);const entries=lib.overviewEntries(updated).filter(e=>!e.id.startsWith('978'));assert.deepEqual(entries.map(e=>e.id),['2001.00001',id].sort((a,b)=>lib.sortKey(a).localeCompare(lib.sortKey(b))));assert.equal(updated.slice(updated.indexOf('### BOOK')),baseOverview.slice(baseOverview.indexOf('### BOOK')));assert.ok(updated.includes('[[notes#Old|notes]]'));assert.equal(lib.insertOverview(updated,info),updated);}
});
test('metadata: verifies id and reads webpage title/authors and pinned download links',()=>{
 const result=lib.metadata(xml('2101.12345'),'2101.12345',Parser);assert.equal(result.resolved,'2101.12345v2');assert.equal(result.title,'A & B paper');assert.equal(result.pdf,undefined);assert.throws(()=>lib.metadata(xml('2101.12345'),'2101.54321',Parser));
});
test('import: source-only and overview commit; reimport is idempotent',async()=>fixture(async root=>{
 const id='2101.12345';const record=await lib.importArxiv(root,id,signal(),()=>{},{get:fakeGet(id),Parser});assert.equal(record.id,id);assert.equal(path.basename(record.file),'source.tex');assert.match(await fs.readFile(record.file,'utf8'),/BODY/);assert.match(await fs.readFile(path.join(root,'OVERVIEW.md'),'utf8'),/#### 2101.12345 \| A & B paper/);await lib.importArxiv(root,id+'v2',signal(),()=>{},{get:()=>assert.fail('no repeat network'),Parser});assert.ok(!(await fs.readdir(root)).includes('.simple-deepseek-library.lock'));
}));
test('import: unavailable source creates no PDF, folder or overview entry',async()=>fixture(async root=>{
 for(const src of [Buffer.from('%PDF-source'),Buffer.alloc(0),Buffer.from('no source')]){await assert.rejects(lib.importArxiv(root,'2101.12345',signal(),()=>{},{get:fakeGet('2101.12345',src),Parser}),/MinerU 密钥/);assert.deepEqual(await fs.readdir(path.join(root,'arxiv')),[]);assert.equal(await fs.readFile(path.join(root,'OVERVIEW.md'),'utf8'),baseOverview);}
 await assert.rejects(lib.importArxiv(root,'2101.12345',signal(),()=>{},{get:async url=>{if(url.includes('/abs/'))return Buffer.from(xml('2101.12345'));throw Error('HTTP 404');},Parser}),/MinerU 密钥/);
}));
test('import: failed source or cancellation leaves overview and library untouched',async()=>fixture(async root=>{
 const original=await fs.readFile(path.join(root,'OVERVIEW.md'),'utf8');await assert.rejects(lib.importArxiv(root,'2101.12345',signal(),()=>{},{get:async url=>url.includes('/abs/')?Buffer.from(xml('2101.12345')):Buffer.from('not pdf'),Parser}));assert.equal(await fs.readFile(path.join(root,'OVERVIEW.md'),'utf8'),original);assert.deepEqual(await fs.readdir(path.join(root,'arxiv')),[]);
 const controller=new AbortController();await assert.rejects(lib.importArxiv(root,'2101.12345',controller.signal,()=>{},{get:async url=>{if(url.includes('/abs/'))return Buffer.from(xml('2101.12345'));controller.abort();return Buffer.from('%PDF-test');},Parser}));assert.deepEqual(await fs.readdir(path.join(root,'arxiv')),[]);
}));
test('import: concurrent overview edit is incorporated before sorted insert',async()=>fixture(async root=>{
 const id='2101.12345';const get=fakeGet(id);await lib.importArxiv(root,id,signal(),()=>{},{get:async(url,s)=>{if(url.includes('/src/'))await fs.appendFile(path.join(root,'OVERVIEW.md'),'\nUser note\n');return get(url,s);},Parser});assert.match(await fs.readFile(path.join(root,'OVERVIEW.md'),'utf8'),/User note/);
}));
test('citation: direct TeX read, alias search, no network or duplicate within one message',async()=>fixture(async root=>{
 const dir=path.join(root,'arxiv','2001.00001');await fs.mkdir(dir);await fs.writeFile(path.join(dir,'Old-2020-A.pdf'),'%PDF-test');await fs.writeFile(path.join(dir,'source.tex'),'RAW TEX');const records=await lib.scanLibrary(root);assert.equal(lib.searchRecords(records,'Old')[0].id,'2001.00001');const result=await lib.expandMentions('Compare @[2001.00001v2] @[2001.00001v2]',root,'',signal(),()=>{},()=>assert.fail('not PDF'));assert.equal(result.split('RAW TEX').length,2);assert.equal(lib.mentions('email@example.com').length,0);
}));

test('source: keeps independent supplements and original file markers without duplicating included children',()=>{
 const result=source.flattenSource(zipSync({'main.tex':strToU8(tex),'part.tex':strToU8('BODY'),'supplement.tex':strToU8('SUPPLEMENT CONTENT')}));assert.match(result.text,/^=== main.tex ===/);assert.match(result.text,/=== supplement.tex ===/);assert.match(result.text,/SUPPLEMENT CONTENT/);assert.equal(result.text.split('BODY').length,2);
 const fragments=source.flattenSource(zipSync({'fragment.tex':strToU8('FRAGMENT')}));assert.match(fragments.text,/FRAGMENT/);
});
test('import: only source endpoint requested, tex indexed by id and cited without MinerU',async()=>fixture(async root=>{
 const id='2101.12345',urls=[];const record=await lib.importArxiv(root,id,signal(),()=>{},{get:async url=>{urls.push(url);assert.ok(!url.includes('/pdf/'));return fakeGet(id)(url);},Parser});assert.equal(urls.length,2);assert.equal(record.pdf,null);assert.equal(record.title,'A & B paper');assert.equal(record.authors,'Jane Doe');assert.ok(record.indexed);assert.deepEqual(await fs.readdir(record.folder),['source.tex']);
 const overview=await fs.readFile(path.join(root,'OVERVIEW.md'),'utf8');const entry=overview.slice(overview.indexOf('#### '+id),overview.indexOf('### BOOK'));assert.ok(entry.includes('> [web](https://arxiv.org/abs/'+id+')'));assert.ok(!entry.includes('[['));assert.ok(!entry.includes('source.tex'));assert.ok(!overview.includes('undefined'));assert.ok(lib.searchRecords(await lib.scanLibrary(root),'Jane Doe').length);
 const result=await lib.expandMentions('@['+id+'v2]',root,'',signal(),()=>{},()=>assert.fail('No MinerU'));assert.match(result,/BODY/);
}));
test('citation: MinerU result is saved locally and reused while PDF hash matches',async()=>fixture(async root=>{
 const folder=path.join(root,'book','9780120831821'),pdf=path.join(folder,'Book.pdf'),md=path.join(folder,'markdown_Book.md');let parses=0;
 const result=await lib.expandMentions('@[9780120831821]',root,'fake',signal(),()=>{},async file=>{parses++;assert.equal(file.name,'Book.pdf');return 'PARSED PDF ONE';});assert.match(result,/PARSED PDF ONE/);assert.equal(await fs.readFile(md,'utf8'),'PARSED PDF ONE');
 const firstHash=createHash('sha256').update(Buffer.from('%PDF-fake')).digest('hex'),firstOverview=await fs.readFile(path.join(root,'OVERVIEW.md'),'utf8');assert.ok(firstOverview.includes('<!-- pdf-sha256: '+firstHash+' -->'));assert.equal((firstOverview.match(/pdf-sha256:/g)||[]).length,1);
 const cached=await lib.expandMentions('@[9780120831821]',root,'',signal(),()=>{},()=>assert.fail('matching PDF must use saved Markdown'));assert.match(cached,/PARSED PDF ONE/);assert.equal(parses,1);
 await fs.writeFile(pdf,'%PDF-changed');const changed=await lib.expandMentions('@[9780120831821]',root,'fake',signal(),()=>{},async()=>{parses++;return 'PARSED PDF TWO';});assert.match(changed,/PARSED PDF TWO/);assert.equal(await fs.readFile(md,'utf8'),'PARSED PDF TWO');assert.equal(parses,2);
 const secondHash=createHash('sha256').update(Buffer.from('%PDF-changed')).digest('hex'),secondOverview=await fs.readFile(path.join(root,'OVERVIEW.md'),'utf8');assert.ok(secondOverview.includes('<!-- pdf-sha256: '+secondHash+' -->'));assert.ok(!secondOverview.includes(firstHash));assert.equal((secondOverview.match(/pdf-sha256:/g)||[]).length,1);
 await fs.writeFile(pdf,'%PDF-broken-update');await assert.rejects(lib.expandMentions('@[9780120831821]',root,'fake',signal(),()=>{},async()=>{throw Error('MinerU failed');}),/MinerU failed/);assert.equal(await fs.readFile(md,'utf8'),'PARSED PDF TWO');assert.equal(await fs.readFile(path.join(root,'OVERVIEW.md'),'utf8'),secondOverview);
}));
test('arXiv import and library PDF conversion cannot write the overview concurrently',async()=>fixture(async root=>{
 const id='2101.12345',get=fakeGet(id);let release,entered;
 const gate=new Promise(resolve=>{release=resolve;}),started=new Promise(resolve=>{entered=resolve;});
 const importing=lib.importArxiv(root,id,signal(),()=>{},{Parser,get:async url=>{if(url.includes('/abs/')){entered();await gate;}return get(url);}});
 await started;
 try {
  await assert.rejects(lib.expandMentions('@[9780120831821]',root,'mineru-key',signal(),()=>{},async()=> 'BOOK TEXT'),/文献库正在保存 PDF 解析结果/);
  assert.ok(!(await fs.readdir(path.join(root,'book','9780120831821'))).includes('markdown_Book.md'));
 } finally { release(); }
 await importing;
 assert.match(await fs.readFile(path.join(root,'OVERVIEW.md'),'utf8'),/#### 2101\.12345/);
}));
test('import: explicit version uses one canonical folder and overview id; later base/version references reuse it',async()=>fixture(async root=>{
 const id='2101.12345';const urls=[];const record=await lib.importArxiv(root,id+'v2',signal(),()=>{},{get:async url=>{urls.push(url);return fakeGet(id)(url);},Parser});assert.equal(record.id,id);assert.equal(path.basename(record.folder),id);assert.ok(urls.every(url=>url.includes(id+'v2')));assert.equal(lib.findRecord(await lib.scanLibrary(root),id+'v3').id,id);
 await lib.importArxiv(root,id+'v2',signal(),()=>{},{get:()=>assert.fail('no duplicate import'),Parser});assert.deepEqual(await fs.readdir(path.join(root,'arxiv')),[id]);
}));
test('overview: inserting into empty section keeps separators before and after entry',()=>{
 const original='---\n\n### ARXIV\n\n---\n\n---\n\n### BOOK\n';const updated=lib.insertOverview(original,{id:'2101.12345',title:'New',authors:['A'],pdf:'A.pdf'});assert.ok(updated.indexOf('####')>updated.indexOf('---',updated.indexOf('### ARXIV')));assert.equal(updated.slice(updated.indexOf('### BOOK')),'### BOOK\n');
});

test('fallback: missing TeX converts PDF once, persists only md, later @ reads by id offline',async()=>fixture(async root=>{
 const id='2101.12345',urls=[];let parsed=0;const result=await lib.expandMentions('@['+id+']',root,'test-key',signal(),()=>{},async(file,key)=>{parsed++;assert.equal(key,'test-key');assert.equal(Buffer.from(await file.arrayBuffer()).toString(),'%PDF-test');return '# Paper\n\nEquation $x=1$';},{Parser,get:async url=>{urls.push(url);return fakeGet(id,Buffer.from('%PDF-source'))(url);}});
 assert.match(result,/# Paper/);assert.equal(parsed,1);assert.deepEqual(await fs.readdir(path.join(root,'arxiv',id)),['markdown_'+id+'.md']);assert.ok(urls.every(u=>!u.includes('/api/')));assert.equal(urls.filter(u=>u.includes('/pdf/')).length,1);
 const record=lib.findRecord(await lib.scanLibrary(root),id);assert.ok(record.indexed);assert.equal(record.title,'A & B paper');assert.equal(path.extname(record.file),'.md');const later=await lib.expandMentions('@['+id+'v2]',root,'',signal(),()=>{},()=>assert.fail('must read saved md'),{get:()=>assert.fail('must not fetch')});assert.match(later,/Equation/);
 const overview=await fs.readFile(path.join(root,'OVERVIEW.md'),'utf8');const block=overview.slice(overview.indexOf('#### '+id),overview.indexOf('### BOOK'));assert.ok(!block.includes('[['));assert.ok(!block.includes('.pdf'));assert.ok(!block.includes('.md'));
}));
test('fallback: source 404 or absent source link uses PDF',async()=>fixture(async root=>{
 for(const [id,missing] of [['2101.12345',false],['2101.12346',true]]){const record=await lib.importArxiv(root,id,signal(),()=>{},{Parser,mineruKey:'test',parseFile:async()=> 'PDF TEXT',get:async url=>{if(url.includes('/abs/'))return Buffer.from(missing?xml(id).replace(/<a href="\/src\/[^\"]+">TeX Source<\/a>/,''):xml(id));if(url.includes('/src/'))throw Error('HTTP 404');assert.ok(url.includes('/pdf/'));return Buffer.from('%PDF-test');}});assert.match(await fs.readFile(record.file,'utf8'),/PDF TEXT/);}
}));
test('fallback: conversion error, empty output, invalid PDF and cancellation leave no artifacts',async()=>fixture(async root=>{
 const id='2101.12345';for(const mode of ['error','empty','pdf','cancel']){const controller=new AbortController();await assert.rejects(lib.importArxiv(root,id,controller.signal,()=>{},{Parser,mineruKey:'test',get:async url=>url.includes('/abs/')?Buffer.from(xml(id)):url.includes('/src/')?Buffer.alloc(0):Buffer.from(mode==='pdf'?'INVALID':'%PDF-test'),parseFile:async()=>{if(mode==='error')throw Error('MinerU failed');if(mode==='cancel')controller.abort();return mode==='empty'?'':'TEXT';}}));assert.deepEqual(await fs.readdir(path.join(root,'arxiv')),[]);assert.equal(await fs.readFile(path.join(root,'OVERVIEW.md'),'utf8'),baseOverview);assert.ok(!(await fs.readdir(root)).includes('.simple-deepseek-library.lock'));}
}));
test('fallback: source rate-limit is not treated as absent source',async()=>fixture(async root=>{
 await assert.rejects(lib.importArxiv(root,'2101.12345',signal(),()=>{},{Parser,mineruKey:'test',parseFile:()=>assert.fail('must not parse'),get:async url=>{if(url.includes('/abs/'))return Buffer.from(xml('2101.12345'));throw Error('HTTP 429');}}),/429/);assert.deepEqual(await fs.readdir(path.join(root,'arxiv')),[]);
}));
test('web metadata: missing id, mismatched versions and external download links are rejected',()=>{
 const id='2101.12345';assert.throws(()=>lib.metadata('<html>Rate exceeded</html>',id,Parser));assert.throws(()=>lib.metadata(xml(id),id+'v1',Parser));assert.throws(()=>lib.metadata(xml(id).replace('https://arxiv.org/pdf/','https://evil.test/pdf/'),id,Parser));const info=lib.metadata(xml(id),id,Parser);assert.equal(info.pdfUrl,'https://arxiv.org/pdf/'+id+'v2');assert.equal(info.sourceUrl,'https://arxiv.org/src/'+id+'v2');
});

test('refresh: unversioned @ replaces TeX and keeps PDF bytes and overview exactly',async()=>fixture(async root=>{
 const id='2001.00001',folder=path.join(root,'arxiv',id);await fs.mkdir(folder);await fs.writeFile(path.join(folder,'source.tex'),'OLD TEX');await fs.writeFile(path.join(folder,'Old-2020-A.pdf'),'%PDF-KEEP');let fetched=0;
 const result=await lib.expandMentions('@['+id+']',root,'',signal(),()=>{},()=>assert.fail('TeX needs no MinerU'),{Parser,get:async url=>{fetched++;return fakeGet(id)(url);}});assert.equal(fetched,2);assert.match(result,/BODY/);assert.ok(!result.includes('OLD TEX'));assert.equal(await fs.readFile(path.join(folder,'Old-2020-A.pdf'),'utf8'),'%PDF-KEEP');assert.equal((await fs.readFile(path.join(root,'OVERVIEW.md'),'utf8')).replace(/<!-- arxiv-version: [^\n]+ -->\n/,''),baseOverview);assert.deepEqual((await fs.readdir(folder)).sort(),['Old-2020-A.pdf','source.tex']);
}));
test('refresh: switching TeX to md and back keeps only current text and preserves PDF',async()=>fixture(async root=>{
 const id='2101.12345';let record=await lib.importArxiv(root,id,signal(),()=>{},{Parser,get:fakeGet(id)});await fs.writeFile(path.join(record.folder,'Keep.pdf'),'%PDF-KEEP');
 record=await lib.importArxiv(root,id,signal(),()=>{},{Parser,get:async url=>url.includes('/abs/')?Buffer.from(xml(id).replaceAll(id+'v2',id+'v3')):fakeGet(id,Buffer.alloc(0))(url),mineruKey:'test',parseFile:async()=> 'NEW MD'});assert.equal(path.extname(record.file),'.md');assert.deepEqual((await fs.readdir(record.folder)).sort(),['Keep.pdf','markdown_'+id+'.md']);
 record=await lib.importArxiv(root,id,signal(),()=>{},{Parser,get:async url=>url.includes('/abs/')?Buffer.from(xml(id).replaceAll(id+'v2',id+'v4')):bundle()});assert.equal(path.basename(record.file),'source.tex');assert.deepEqual((await fs.readdir(record.folder)).sort(),['Keep.pdf','source.tex']);assert.equal(await fs.readFile(path.join(record.folder,'Keep.pdf'),'utf8'),'%PDF-KEEP');
}));
test('refresh: failed conversion leaves old text and PDF unchanged, explicit version is local',async()=>fixture(async root=>{
 const id='2101.12345';const record=await lib.importArxiv(root,id,signal(),()=>{},{Parser,get:fakeGet(id)});const old=await fs.readFile(record.file);await fs.writeFile(path.join(record.folder,'Keep.pdf'),'%PDF-KEEP');const before=await fs.readFile(path.join(root,'OVERVIEW.md'),'utf8');
 await assert.rejects(lib.importArxiv(root,id,signal(),()=>{},{Parser,get:async url=>url.includes('/abs/')?Buffer.from(xml(id).replaceAll(id+'v2',id+'v3')):fakeGet(id,Buffer.alloc(0))(url),mineruKey:'test',parseFile:async()=>{throw Error('conversion failed');}}),/conversion failed/);assert.deepEqual(await fs.readFile(record.file),old);assert.equal(await fs.readFile(path.join(root,'OVERVIEW.md'),'utf8'),before);assert.equal(await fs.readFile(path.join(record.folder,'Keep.pdf'),'utf8'),'%PDF-KEEP');
 await lib.expandMentions('@['+id+'v2]',root,'',signal(),()=>{},()=>assert.fail('no parse'),{get:()=>assert.fail('explicit version uses local')});assert.ok(!(await fs.readdir(root)).includes('.simple-deepseek-library.lock'));
}));

test('dedup: skips only exact reference blocks actually present in user context',()=>{
 const block='文献编号：2101.12345\n标题：Paper\n来源：arxiv/2101.12345/source.tex\n以下为参考资料原文：\n\nFULL TEXT';
 assert.equal(lib.deduplicateMentions('Again',[block],[{role:'user',content:'First\n\n'+block}]),'Again');
 assert.ok(lib.deduplicateMentions('Again',[block],[{role:'assistant',content:block}]).includes('FULL TEXT'));
 assert.ok(lib.deduplicateMentions('Again',[block],[{role:'user',content:'summary of FULL TEXT'}]).includes(block));
 assert.ok(lib.deduplicateMentions('Again',[block+' UPDATED'],[{role:'user',content:block}]).includes('UPDATED'));
 assert.ok(lib.deduplicateMentions('Shorter',[block],[{role:'user',content:block+' LONGER'}]).includes(block));
 assert.equal(lib.deduplicateMentions('Compare',[block,'OTHER'],[{role:'user',content:block}]),'Compare\n\nOTHER');
});
test('dedup: aliases of same local arxiv file attach once within one message',async()=>fixture(async root=>{
 const id='2101.12345';await lib.importArxiv(root,id,signal(),()=>{},{Parser,get:fakeGet(id)});const materials=[];
 const result=await lib.expandMentions('@['+id+'v2] @['+id+'v3]',root,'',signal(),()=>{},()=>assert.fail('no parse'),{materials});assert.equal(materials.length,1);assert.equal(result.split('BODY').length,2);
}));

test('version comment: inserts and updates hidden marker while preserving all visible content',()=>{
 for(const eol of ['\n','\r\n']){const original=baseOverview.replace(/\n/g,eol);const first=lib.setOverviewVersion(original,'2001.00001','2001.00001v2');assert.ok(first.includes('<!-- arxiv-version: 2001.00001v2 -->'));assert.equal(first.replace(/<!-- arxiv-version: [^\r\n]* -->\r?\n/,''),original);const second=lib.setOverviewVersion(first,'2001.00001','2001.00001v3');assert.equal((second.match(/arxiv-version:/g)||[]).length,1);assert.equal(second.replace(/<!-- arxiv-version: [^\r\n]* -->\r?\n/,''),original);assert.equal(lib.setOverviewVersion(second,'2001.00001','2001.00001v3'),second);}
 assert.throws(()=>lib.setOverviewVersion(baseOverview,'2001.00001','2101.12345v2'));
});
test('PDF hash comment is hidden, replaceable and preserves visible overview bytes',()=>{
 const one='a'.repeat(64),two='B'.repeat(64);for(const eol of ['\n','\r\n']){const original=baseOverview.replace(/\n/g,eol);const first=lib.setOverviewPdfHash(original,'9780120831821',one);assert.ok(first.includes('<!-- pdf-sha256: '+one+' -->'));assert.equal(first.replace(/<!-- pdf-sha256: [^\r\n]* -->\r?\n/,''),original);const second=lib.setOverviewPdfHash(first,'9780120831821',two);assert.ok(second.includes('<!-- pdf-sha256: '+two.toLowerCase()+' -->'));assert.equal((second.match(/pdf-sha256:/g)||[]).length,1);assert.equal(lib.overviewEntries(second).find(entry=>entry.id==='9780120831821').pdfHash,two.toLowerCase());}
 assert.throws(()=>lib.setOverviewPdfHash(baseOverview,'missing','a'.repeat(64)));assert.throws(()=>lib.setOverviewPdfHash(baseOverview,'9780120831821','short'));
});
test('version comment: records successful text version and leaves it unchanged after failed update',async()=>fixture(async root=>{
 const id='2101.12345';await lib.importArxiv(root,id,signal(),()=>{},{Parser,get:fakeGet(id)});const before=await fs.readFile(path.join(root,'OVERVIEW.md'),'utf8');assert.ok(before.includes('<!-- arxiv-version: '+id+'v2 -->'));
 await assert.rejects(lib.importArxiv(root,id,signal(),()=>{},{Parser,get:async url=>url.includes('/abs/')?Buffer.from(xml(id).replaceAll(id+'v2',id+'v3')):Buffer.alloc(0)}));assert.equal(await fs.readFile(path.join(root,'OVERVIEW.md'),'utf8'),before);
 await lib.importArxiv(root,id,signal(),()=>{},{Parser,get:async url=>url.includes('/abs/')?Buffer.from(xml(id).replaceAll(id+'v2',id+'v3')):bundle()});assert.ok((await fs.readFile(path.join(root,'OVERVIEW.md'),'utf8')).includes('<!-- arxiv-version: '+id+'v3 -->'));
}));

test('version reuse: latest local text skips all downloads and parser calls',async()=>fixture(async root=>{
 const id='2101.12345';const record=await lib.importArxiv(root,id,signal(),()=>{},{Parser,get:fakeGet(id)});const before=await fs.readFile(path.join(root,'OVERVIEW.md'),'utf8');const notices=[];let calls=0;
 const result=await lib.expandMentions('@['+id+']',root,'',signal(),m=>notices.push(m),()=>assert.fail('no conversion'),{Parser,get:async url=>{calls++;assert.ok(url.includes('/abs/'));return Buffer.from(xml(id));}});assert.equal(calls,1);assert.match(result,/BODY/);assert.ok(notices.some(n=>n.includes('本地已是最新版')));assert.equal(await fs.readFile(path.join(root,'OVERVIEW.md'),'utf8'),before);assert.equal((await lib.scanLibrary(root)).find(r=>r.id===id).version,id+'v2');
}));
test('version reuse: offline and rate-limit reuse local text without changing version',async()=>fixture(async root=>{
 const id='2101.12345';await lib.importArxiv(root,id,signal(),()=>{},{Parser,get:fakeGet(id)});for(const message of ['ECONNRESET','HTTP 429','网络请求失败']){const result=await lib.expandMentions('@['+id+']',root,'',signal(),()=>{},()=>assert.fail('no conversion'),{Parser,get:async()=>{throw Error(message);}});assert.match(result,/BODY/);}
 const refreshed=await lib.importArxiv(root,id,signal(),()=>{},{Parser,get:async url=>{if(url.includes('/abs/'))return Buffer.from(xml(id).replaceAll(id+'v2',id+'v3'));throw Error('ETIMEDOUT');}});assert.equal(refreshed.version,id+'v2');assert.ok(!(await fs.readdir(root)).includes('.simple-deepseek-library.lock'));
}));
test('version reuse: no local copy or cancellation still fails',async()=>fixture(async root=>{
 await assert.rejects(lib.importArxiv(root,'2101.12345',signal(),()=>{},{Parser,get:async()=>{throw Error('ENOTFOUND');}}),/ENOTFOUND/);
 const id='2101.12345';await lib.importArxiv(root,id,signal(),()=>{},{Parser,get:fakeGet(id)});const c=new AbortController();await assert.rejects(lib.importArxiv(root,id,c.signal,()=>{},{Parser,get:async()=>{c.abort();throw Error('network');}}));
}));

test('range selection: @ uses selected body without modifying saved source',async()=>fixture(async root=>{
 const id='2101.12345';const record=await lib.importArxiv(root,id,signal(),()=>{},{Parser,get:fakeGet(id)});const original=await fs.readFile(record.file,'utf8');const materials=[];const result=await lib.expandMentions('@['+id+'v2]',root,'',signal(),()=>{},()=>assert.fail('not PDF'),{materials,selectText:async(body,name)=>{assert.equal(body,original);assert.ok(name.includes(id));return 'SELECTED TEXT';}});assert.match(result,/SELECTED TEXT/);assert.ok(!result.includes('documentclass'));assert.equal(materials.length,1);assert.equal(await fs.readFile(record.file,'utf8'),original);
}));
