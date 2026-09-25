const fs=require('node:fs/promises');const path=require('node:path');const {randomBytes,createHash}=require('node:crypto');
const {request,check,pause,parseFile:parsePdf}=require('./core');const {flattenSource,MAX_TEX}=require('./arxiv-source');
const {withOutlineContext}=require('./outline');
const DEFAULT_LIBRARY='';
const LIBRARY_LOCK='.simple-deepseek-library.lock';
const EMPTY_OVERVIEW=['','---','','### ARXIV','','---','','### BOOK','','---','','### OTHER PAPER','','---',''].join('\n');
function arxivId(value){
 let id=value.trim().replace(/^arxiv:\s*/i,'');
 if(id.includes('://')){const u=new URL(id);if(!['arxiv.org','www.arxiv.org','export.arxiv.org'].includes(u.hostname)||!['https:','http:'].includes(u.protocol)||u.username||u.password)throw Error('无效 arXiv 地址');id=u.pathname.replace(/^\/(abs|pdf|e-print)\//,'').replace(/\.pdf$/i,'');}
 if(!/^(?:\d{4}\.\d{4,5}|[a-z][a-z0-9.-]*\/\d{7})(?:v[1-9]\d*)?$/i.test(id))throw Error('无效 arXiv 编号');
 return id.replace(/V(?=\d+$)/,'v');
}
function overviewEntries(text){const matches=[...text.matchAll(/^####\s+([^|\r\n]+)\|\s*(.*)$/gm)];return matches.map((m,i)=>{const block=text.slice(m.index,matches[i+1]?.index??text.length);return{id:m[1].trim(),title:m[2].trim(),version:block.match(/^<!-- arxiv-version: ([^\r\n ]+v\d+) -->\r?$/m)?.[1]||null,pdfHash:block.match(/^<!-- pdf-sha256: ([a-f0-9]{64}) -->\r?$/mi)?.[1].toLowerCase()||null,authors:(block.match(/^\s*>\s*([^\[\r\n][^\r\n]*)/m)?.[1]||'').trim(),pdf:block.match(/\[\[([^\]|]+\.pdf)(?:\|[^\]]*)?\]\]/)?.[1],index:m.index};});}
async function checkedPath(root,file){const base=await fs.realpath(root),real=await fs.realpath(file);const rel=path.relative(base,real);if(rel==='..'||rel.startsWith('..'+path.sep)||path.isAbsolute(rel))throw Error('文件路径超出文献库');return real;}
async function readLimited(root,file,max=MAX_TEX){const real=await checkedPath(root,file);const h=await fs.open(real,'r');try{const stat=await h.stat();if(!stat.isFile()||stat.size>max)throw Error('文献文件过大或不是普通文件');const buffer=Buffer.alloc(stat.size+1);let bytesRead=0;while(bytesRead<buffer.length){const part=await h.read(buffer,bytesRead,buffer.length-bytesRead,bytesRead);if(!part.bytesRead)break;bytesRead+=part.bytesRead;}if(bytesRead!==stat.size)throw Error('读取时文件发生变化，请重试');return buffer.subarray(0,bytesRead);}finally{await h.close();}}
async function scanLibrary(root){
 if(!root)throw Error('请在顶部设置填写文献库路径');root=await fs.realpath(root);let overview;
 try{overview=(await readLimited(root,path.join(root,'OVERVIEW.md'))).toString('utf8');}catch(error){if(error.code==='ENOENT'&&(await fs.readdir(root)).length===0)return[];throw error;}
 const meta=overviewEntries(overview),byPdf=new Map(meta.filter(m=>m.pdf).map(m=>[path.basename(m.pdf),m]));const records=[];
 for(const category of ['arxiv','otherpaper','book']){
  const base=path.join(root,category);let dirs;try{dirs=await fs.readdir(base,{withFileTypes:true});}catch(e){if(e.code==='ENOENT')continue;throw e;}
  for(const dir of dirs.filter(d=>d.isDirectory()&&!d.name.startsWith('.'))){const folder=await checkedPath(root,path.join(base,dir.name));const files=(await fs.readdir(folder,{withFileTypes:true})).filter(f=>f.isFile()).map(f=>f.name);const pdfs=files.filter(f=>/\.pdf$/i.test(f));const info=pdfs.map(p=>byPdf.get(p)).find(Boolean)||meta.find(m=>m.id.toLowerCase()===(category==='book'?dir.name:dir.name.replace('_','/')).toLowerCase());const id=info?.id || (category==='book'?dir.name:dir.name.replace('_','/'));
   const tex=files.includes('source.tex')?'source.tex':null;const md=files.filter(f=>/^markdown_.*\.md$/i.test(f));const selected=category==='arxiv'&&tex?tex:md.length===1?md[0]:pdfs.length===1?pdfs[0]:null;
   records.push({id,aliases:[dir.name,dir.name.replace('_','/')],category,title:info?.title||pdfs[0]||id,authors:info?.authors||'',folder,file:selected?path.join(folder,selected):null,mdFile:md.length===1?path.join(folder,md[0]):null,pdfFile:pdfs.length===1?path.join(folder,pdfs[0]):null,indexed:!!info,version:info?.version||null,pdfHash:info?.pdfHash||null,pdf:pdfs.length===1?pdfs[0]:null});
  }
 }
 return records;
}
async function initializeEmptyLibrary(root){
 const entries=(await fs.readdir(root)).filter(name=>name!==LIBRARY_LOCK);
 if(entries.length)return;
 await fs.writeFile(path.join(root,'OVERVIEW.md'),EMPTY_OVERVIEW,{flag:'wx'});
 for(const category of ['arxiv','book','otherpaper'])await fs.mkdir(path.join(root,category));
}
function findRecord(records,id){const query=id.toLowerCase();const exact=records.find(r=>r.id.toLowerCase()===query||r.aliases.some(a=>a.toLowerCase()===query));if(exact)return exact;let base;try{base=arxivId(id).replace(/v\d+$/,'').toLowerCase();}catch{return undefined;}return records.find(r=>r.category==='arxiv'&&[r.id,...r.aliases].some(a=>a.toLowerCase().replace(/v\d+$/,'')===base));}
function searchRecords(records,query){const q=query.toLowerCase();return records.filter(r=>[r.id,r.title,r.authors,...r.aliases].some(v=>v.toLowerCase().includes(q))).sort((a,b)=>(a.id===query?-1:b.id===query?1:0)||a.id.localeCompare(b.id)).slice(0,12);}
function sortKey(id){id=id.replace(/v\d+$/,'');const m=/^(?:[^/]+\/)?(\d{2})(\d{2})(?:\.)?(\d+)$/.exec(id);if(!m)return id;return (Number(m[1])>=90?'19':'20')+m[1]+m[2]+m[3].padStart(5,'0');}
function insertOverview(original,record){
 const eol=original.includes('\r\n')?'\r\n':'\n';const section=/^### ARXIV[ \t]*\r?$/m.exec(original);if(!section)throw Error('OVERVIEW.md 缺少 ARXIV 分区');
 const after=section.index+section[0].length;const next=/^### /m.exec(original.slice(after));const end=next?after+next.index:original.length;
 const entries=overviewEntries(original.slice(after,end));if(entries.some(e=>e.id===record.id))return original;
 const clean=t=>t.replace(/[\r\n]+/g,' ').replace(/\[/g,'\\[').replace(/\]/g,'\\]').replace(/\|/g,'\\|');
 const block=['#### '+record.id+' | '+clean(record.title),'','> '+record.authors.map(clean).join(', '),'> ','> '+(record.pdf?'[['+record.pdf+'|pdf]], ':'')+'[web](https://arxiv.org/abs/'+record.id+')','',''].join(eol)+eol;
 const later=entries.find(e=>sortKey(e.id)>sortKey(record.id));let at;
 if(later)at=after+later.index;else{const tail=original.slice(after,end);const separator=/\r?\n---\s*$/.exec(tail);at=separator?after+separator.index:end;}
 return original.slice(0,at)+(at&&original[at-1]!=='\n'?eol:'')+block+original.slice(at);
}
function setOverviewVersion(text,id,version){
 if(arxivId(version).replace(/v\d+$/,'')!==id||!/v\d+$/.test(version))throw Error('入库版本编号无效');
 const section=/^### ARXIV[ \t]*\r?$/m.exec(text);if(!section)throw Error('缺少 ARXIV 分类');
 const nextSection=/^### /m.exec(text.slice(section.index+section[0].length));const end=nextSection?section.index+section[0].length+nextSection.index:text.length;
 const entries=overviewEntries(text.slice(section.index,end)),index=entries.findIndex(e=>e.id===id);if(index<0)throw Error('缺少待标记的 arXiv 条目');
 const start=section.index+entries[index].index,stop=index+1<entries.length?section.index+entries[index+1].index:end;
 const block=text.slice(start,stop),marker='<!-- arxiv-version: '+version+' -->';
 const comment=/^<!-- arxiv-version: [^\r\n]* -->[ \t]*\r?$/m;
 const eol=text.includes('\r\n')?'\r\n':'\n';
 const updated=comment.test(block)?block.replace(comment,()=>marker+(eol==='\r\n'?'\r':'')):block.replace(/^(####[^\r\n]*)(\r?\n|$)/,(_,heading,nl)=>heading+(nl||eol)+marker+eol);
 return text.slice(0,start)+updated+text.slice(stop);
}
function setOverviewPdfHash(text,id,hash){
 if(!/^[a-f0-9]{64}$/i.test(hash))throw Error('PDF SHA-256 无效');
 const entries=overviewEntries(text),index=entries.findIndex(entry=>entry.id===id);if(index<0)throw Error('OVERVIEW.md 缺少对应文献条目：'+id);
 const start=entries[index].index,stop=index+1<entries.length?entries[index+1].index:text.length,block=text.slice(start,stop),marker='<!-- pdf-sha256: '+hash.toLowerCase()+' -->';
 const comment=/^<!-- pdf-sha256: [^\r\n]* -->[ \t]*\r?$/mi,eol=text.includes('\r\n')?'\r\n':'\n';
 const updated=comment.test(block)?block.replace(comment,()=>marker+(eol==='\r\n'?'\r':'')):block.replace(/^(####[^\r\n]*)(\r?\n|$)/,(_,heading,nl)=>heading+(nl||eol)+marker+eol);
 return text.slice(0,start)+updated+text.slice(stop);
}
async function persistParsedPdf(root,record,pdf,markdown,signal){
 check(signal);if(typeof markdown!=='string'||!markdown.trim())throw Error('PDF 转换结果为空，未保存');if(Buffer.byteLength(markdown,'utf8')>MAX_TEX)throw Error('转换后的 Markdown 过大');
 const hash=createHash('sha256').update(pdf).digest('hex'),folder=await checkedPath(root,record.folder),overviewPath=await checkedPath(root,path.join(root,'OVERVIEW.md'));
 const stem=path.basename(record.pdfFile,path.extname(record.pdfFile)),destination=record.mdFile||path.join(folder,'markdown_'+stem+'.md');
 if(path.dirname(destination)!==folder||!/^markdown_.*\.md$/i.test(path.basename(destination)))throw Error('Markdown 保存路径无效');
 const lockPath=path.join(root,LIBRARY_LOCK);let lock,tempMd=null,tempOverview=null,backup=null,installed=false;
 try{lock=await fs.open(lockPath,'wx');}catch{throw Error('文献库正在保存 PDF 解析结果，请稍后重试');}
 try{
  const before=await fs.readFile(overviewPath,'utf8'),updated=setOverviewPdfHash(before,record.id,hash);check(signal);
  tempMd=path.join(folder,'.simple-deepseek-md-'+randomBytes(8).toString('hex')+'.tmp');tempOverview=path.join(root,'.OVERVIEW.'+randomBytes(8).toString('hex')+'.tmp');
  await fs.writeFile(tempMd,markdown,{flag:'wx'});await fs.writeFile(tempOverview,updated,{flag:'wx'});check(signal);
  const currentPdf=await readLimited(root,record.pdfFile,200*1024*1024);if(createHash('sha256').update(currentPdf).digest('hex')!==hash)throw Error('PDF 在解析期间发生变化，请重试');
  if(await fs.readFile(overviewPath,'utf8')!==before)throw Error('OVERVIEW.md 已被其他程序修改，请重试');
  try{await fs.lstat(destination);backup=path.join(folder,'.simple-deepseek-old-'+randomBytes(8).toString('hex')+'.md');await fs.rename(destination,backup);}catch(error){if(error.code!=='ENOENT')throw error;}
  await fs.rename(tempMd,destination);tempMd=null;installed=true;
  try{await fs.rename(tempOverview,overviewPath);tempOverview=null;}catch(error){await fs.unlink(destination).catch(()=>{});installed=false;if(backup){await fs.rename(backup,destination);backup=null;}throw error;}
  if(backup){await fs.unlink(backup).catch(()=>{});backup=null;}return{file:destination,hash};
 }finally{
  if(tempMd)await fs.unlink(tempMd).catch(()=>{});if(tempOverview)await fs.unlink(tempOverview).catch(()=>{});
  if(backup){if(installed)await fs.unlink(backup).catch(()=>{});else await fs.rename(backup,destination).catch(()=>{});}
  await lock.close();await fs.unlink(lockPath).catch(()=>{});
 }
}
function metadata(html,requested,Parser=globalThis.DOMParser){
 if(!Parser)throw Error('网页解析器不可用');const doc=new Parser().parseFromString(html,'text/html');
 const meta=name=>doc.querySelector('meta[name="'+name+'"]')?.getAttribute('content')?.trim()||'';
 const base=requested.replace(/v\d+$/,'');let actual;try{actual=arxivId(meta('citation_arxiv_id'));}catch{throw Error('arXiv 网页未提供有效论文编号');}
 if(actual.replace(/v\d+$/,'')!==base)throw Error('arXiv 网页编号不匹配');
 const links=[...doc.querySelectorAll('a[href]')];const versions=links.map(a=>{try{const id=arxivId(new URL(a.getAttribute('href'),'https://arxiv.org').href);return id.startsWith(base+'v')?id:null;}catch{return null;}}).filter(Boolean);
 const resolved=/v\d+$/.test(actual)?actual:versions.sort((a,b)=>Number(b.split('v').at(-1))-Number(a.split('v').at(-1)))[0];
 if(!resolved||(/v\d+$/.test(requested)&&resolved!==requested))throw Error('无法确认 arXiv 网页版本');
 const title=meta('citation_title').replace(/\s+/g,' '),authors=[...doc.querySelectorAll('meta[name="citation_author"]')].map(e=>{const n=e.getAttribute('content')?.trim()||'';const parts=n.split(',').map(x=>x.trim());return parts.length===2?parts[1]+' '+parts[0]:n;}).filter(Boolean);
 if(!title||!authors.length)throw Error('arXiv 网页标题或作者缺失');
 const source=links.find(a=>a.textContent.trim()==='TeX Source');
 const pinned=(value,kind)=>{if(!value)return null;const u=new URL(value,'https://arxiv.org');if(u.protocol!=='https:'||u.hostname!=='arxiv.org'||u.username||u.password||!u.pathname.startsWith('/'+kind+'/'))throw Error('arXiv 网页下载链接无效');const id=arxivId(u.pathname.slice(kind.length+2));if(id.replace(/v\d+$/,'')!==base)throw Error('arXiv 下载编号不匹配');return 'https://arxiv.org/'+kind+'/'+resolved;};
 return{id:base,resolved,title,authors,sourceUrl:pinned(source?.getAttribute('href'),'src'),pdfUrl:pinned(meta('citation_pdf_url'),'pdf')};
}

let lastRequest=0;
async function arxivGet(url,signal,http=request){await pause(Math.max(0,3000-(Date.now()-lastRequest)),signal);lastRequest=Date.now();try{return await http(url,{signal,maxBytes:200*1024*1024,headers:{'User-Agent':'Simple-DeepSeek/0.1.0 (single-paper import)'}});}catch(error){if(/HTTP 429/.test(error.message))throw Error('arXiv 请求受到限流（HTTP 429），请稍后重新发送');throw error;}}
async function replaceLibraryText(stage,destination){
 const fresh=(await fs.readdir(stage)).filter(n=>n==='source.tex'||/^markdown_.*\.md$/i.test(n));if(fresh.length!==1)throw Error('新文献文本不唯一');
 const old=(await fs.readdir(destination)).filter(n=>n==='source.tex'||/^markdown_.*\.md$/i.test(n));
 const moved=[];let installed=false;
 try{
  for(const name of old){if(!(await fs.lstat(path.join(destination,name))).isFile())throw Error('旧文本不是普通文件');await fs.rename(path.join(destination,name),path.join(stage,'.old-'+name));moved.push(name);}
  await fs.rename(path.join(stage,fresh[0]),path.join(destination,fresh[0]));installed=true;
 }catch(error){
  if(installed)await fs.rename(path.join(destination,fresh[0]),path.join(stage,fresh[0]));
  try{for(const name of moved.reverse())await fs.rename(path.join(stage,'.old-'+name),path.join(destination,name));}catch(rollback){const failure=new Error('恢复旧文本失败，恢复文件保留在 '+stage);failure.keepStage=true;throw failure;}throw error;
 }
}
async function importArxiv(root,value,signal,notify=()=>{},options={}){
 const requested=arxivId(value),id=requested.replace(/v\d+$/,'');root=await fs.realpath(root);const lockPath=path.join(root,LIBRARY_LOCK);let lock;
 try{lock=await fs.open(lockPath,'wx');}catch{throw Error('文献库正在入库或有遗留锁文件，请稍后重试');}
 let stage=null,temp=null,reusable=null;
 try{
  await initializeEmptyLibrary(root);
  const records=await scanLibrary(root),existing=findRecord(records,id);const refresh=!!existing&&!/v\d+$/.test(requested);if(existing?.indexed&&!refresh)return existing;
  notify('正在获取 arXiv 元数据：'+id);const get=options.get||((url,s)=>arxivGet(url,s));
  let canReuse=false;
  if(existing?.file&&!/\.pdf$/i.test(existing.file)){const stat=await fs.stat(await checkedPath(root,existing.file));canReuse=stat.isFile()&&stat.size>0&&stat.size<=MAX_TEX;if(canReuse)reusable=existing;}
  let page;
  try{page=await get('https://arxiv.org/abs/'+requested,signal);}
  catch(error){check(signal);if(canReuse&&/网络|超时|限流|HTTP (?:429|5\d\d)|ENOTFOUND|EAI_AGAIN|ECONN|ETIMEDOUT|socket|network|fetch failed/i.test(error.message)){notify('无法确认最新版本，使用本地文献：'+id);return existing;}throw error;}
  const info=metadata(page.toString('utf8'),requested,options.Parser);
  if(canReuse&&existing.version===info.resolved){notify('本地已是最新版：'+info.resolved);return existing;}
  if(existing?.pdf)info.pdf=existing.pdf;
  const arxivRoot=path.join(root,'arxiv');await fs.mkdir(arxivRoot,{recursive:true});await checkedPath(root,arxivRoot);
  const destination=existing?.folder||path.join(arxivRoot,id.replace('/','_'));
  if(!existing||refresh){
   if(!existing){try{await fs.lstat(destination);throw Error('入库目录已存在，未覆盖');}catch(e){if(e.code!=='ENOENT')throw e;}}
   stage=await fs.mkdtemp(path.join(arxivRoot,'.simple-deepseek-'));
   notify('正在下载并展开 TeX：'+id);let flattened={text:null,unresolved:[]};
   try{if(info.sourceUrl)flattened=flattenSource(await get(info.sourceUrl,signal));}catch(e){check(signal);if(!/HTTP 404/.test(e.message))throw e;}
   check(signal);
   if(flattened.text){await fs.writeFile(path.join(stage,'source.tex'),(flattened.unresolved.length?'% UNRESOLVED INPUTS: '+flattened.unresolved.join(', ')+'\n':'')+flattened.text,{flag:'wx'});}
   else{
    if(!options.mineruKey)throw Error('无可用 TeX 源码，请先填写 MinerU 密钥以将 PDF 转为 Markdown');
    if(!info.pdfUrl)throw Error('arXiv 网页未提供 PDF 下载链接');
    notify('无可用 TeX，正在下载 PDF 并转换为 Markdown：'+id);
    const pdf=await get(info.pdfUrl,signal);check(signal);if(pdf.subarray(0,5).toString()!=='%PDF-')throw Error('下载内容不是 PDF');
    const name=id.replace('/','_')+'.pdf';
    const md=await (options.parseFile||parsePdf)({name,size:pdf.length,arrayBuffer:async()=>pdf.buffer.slice(pdf.byteOffset,pdf.byteOffset+pdf.length)},options.mineruKey,signal,notify);
    check(signal);if(typeof md!=='string'||!md.trim())throw Error('PDF 转换结果为空，未入库');if(Buffer.byteLength(md,'utf8')>MAX_TEX)throw Error('转换后的 Markdown 过大');
    await fs.writeFile(path.join(stage,'markdown_'+id.replace('/','_')+'.md'),md,{flag:'wx'});
   }
   if(flattened.unresolved.length)notify('部分 TeX 引用未找到：'+flattened.unresolved.join(', '));
  }
  check(signal);const overviewPath=await checkedPath(root,path.join(root,'OVERVIEW.md'));const before=await fs.readFile(overviewPath,'utf8');let updated=insertOverview(before,info);if(stage)updated=setOverviewVersion(updated,id,info.resolved);
  temp=path.join(root,'.OVERVIEW.'+randomBytes(8).toString('hex')+'.tmp');await fs.writeFile(temp,updated,{flag:'wx'});check(signal);
  if(await fs.readFile(overviewPath,'utf8')!==before)throw Error('OVERVIEW.md 已被其他程序修改，请重试');
  if(stage){if(existing){try{await replaceLibraryText(stage,destination);}catch(error){if(error.keepStage)stage=null;throw error;}}else {await fs.rename(stage,destination);stage=null;}}
  try{await fs.rename(temp,overviewPath);temp=null;}catch{throw Error('文件已保留，但总目录更新失败；再次引用可重试登记');}
  notify('arXiv 入库完成：'+id);return findRecord(await scanLibrary(root),id);
 }catch(error){check(signal);if(reusable&&/网络|超时|限流|HTTP (?:429|5\d\d)|ENOTFOUND|EAI_AGAIN|ECONN|ETIMEDOUT|socket|network|fetch failed/i.test(error.message)){notify('更新暂不可用，使用本地文献：'+id);return reusable;}throw error;}finally{
  if(temp)await fs.unlink(temp).catch(()=>{});
  if(stage){const real=await fs.realpath(stage).catch(()=>null);const base=await fs.realpath(path.join(root,'arxiv')).catch(()=>null);if(real&&base&&path.dirname(real)===base&&path.basename(real).startsWith('.simple-deepseek-'))await fs.rm(real,{recursive:true});}
  await lock.close();await fs.unlink(lockPath).catch(()=>{});
 }
}
function mentions(text){return [...new Set([...text.matchAll(/@\[([^\]\r\n]+)\]/g)].map(m=>m[1]))];}
async function expandMentions(text,root,mineruKey,signal,notify,parseFile,options={}){
 const ids=mentions(text);if(!ids.length)return text;let records=await scanLibrary(root);const material=[],seen=new Set();
 for(const id of ids){check(signal);let record=findRecord(records,id);if(record&&seen.has(record.folder))continue;if(!record||(record.category==='arxiv'&&(!record.indexed||!/v\d+$/i.test(id)))){try{arxivId(id);}catch{throw Error('本地未找到该编号；自动入库仅支持 arXiv：'+id);}record=await importArxiv(root,id,signal,notify,{...options,mineruKey,parseFile});records=await scanLibrary(root);}
  if(!record?.file)throw Error('文献缺少可唯一确定的正文文件：'+id);
  seen.add(record.folder);notify('正在读取文献：'+id);let body,inputFile=record.file,raw=null;
  if(record.pdfFile&&record.mdFile&&record.pdfHash){raw=await readLimited(root,record.pdfFile,200*1024*1024);if(createHash('sha256').update(raw).digest('hex')!==record.pdfHash){notify('PDF 已变化，正在重新解析：'+id);inputFile=record.pdfFile;}}
  if(/\.pdf$/i.test(inputFile)){if(!record.indexed)throw Error('OVERVIEW.md 缺少该 PDF 的对应条目：'+record.id);if(!mineruKey)throw Error('该文献需要解析 PDF，请先填写 MinerU 密钥');raw=raw||await readLimited(root,inputFile,200*1024*1024);body=await parseFile({name:path.basename(inputFile),size:raw.length,arrayBuffer:async()=>raw.buffer.slice(raw.byteOffset,raw.byteOffset+raw.byteLength)},mineruKey,signal,notify);check(signal);const saved=await persistParsedPdf(root,{...record,pdfFile:inputFile},raw,body,signal);inputFile=saved.file;notify('PDF 解析结果已保存：'+path.relative(root,inputFile));}
  else body=(await readLimited(root,inputFile)).toString('utf8');
  check(signal);if(options.selectText)body=await options.selectText(body,record.id+' · '+record.title,/\.tex$/i.test(inputFile)?'tex':'md');else if(/\.tex$/i.test(inputFile))body=withOutlineContext(body,body,[{start:0,end:body.length}]);check(signal);material.push('Reference ID: '+record.id+'\nTitle: '+record.title+'\nSource: '+path.relative(root,inputFile)+'\nReference text:\n\n'+body);
 }
 if(options.materials)options.materials.push(...material);
 return text+'\n\n'+material.join('\n\n---\n\n');
}
function deduplicateMentions(text,materials,messages){
 const contains=(content,block)=>{let start=content.indexOf(block);while(start>=0){const end=start+block.length;if((start===0||content.slice(start-2,start)==='\n\n')&&(end===content.length||content.startsWith('\n\n---\n\nReference ID: ',end)))return true;start=content.indexOf(block,start+1);}return false;};
 const remaining=materials.filter(block=>!messages.some(m=>m.role==='user'&&contains(m.content,block)));
 return remaining.length?text+'\n\n'+remaining.join('\n\n---\n\n'):text;
}
module.exports={DEFAULT_LIBRARY,arxivId,overviewEntries,scanLibrary,findRecord,searchRecords,sortKey,insertOverview,metadata,importArxiv,mentions,expandMentions,deduplicateMentions,setOverviewVersion,setOverviewPdfHash,persistParsedPdf,readLimited};
