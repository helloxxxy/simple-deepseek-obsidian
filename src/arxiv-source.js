const path = require('node:path').posix;
const { gunzipSync } = require('node:zlib');
const { unzipSync } = require('fflate');
const MAX_SOURCE = 128 * 1024 * 1024, MAX_TEX = 16 * 1024 * 1024;
function safeName(name) {
  const value = name.replace(/\\/g, '/').replace(/^(\.\/)+/, '');
  if (!value || value.startsWith('/') || /^[A-Za-z]:/.test(value) || value.split('/').includes('..')) throw Error('源码包包含不安全路径');
  return path.normalize(value).replace(/\/$/, '');
}
function decode(raw) { try { return new TextDecoder('utf-8', { fatal:true }).decode(raw); } catch { return Buffer.from(raw).toString('latin1'); } }
function sourceFiles(input) {
  let raw = Buffer.from(input);
  if (raw[0] === 31 && raw[1] === 139) raw = gunzipSync(raw, { maxOutputLength: MAX_SOURCE });
  if (raw.length > MAX_SOURCE) throw Error('源码包展开后过大');
  if (raw.subarray(0,5).toString() === '%PDF-') return new Map();
  const files = new Map(); let total = 0;
  const add = (name, data) => { name = safeName(name); if (files.has(name)) throw Error('源码包文件名重复'); if (data.length > MAX_TEX || (total += data.length) > MAX_SOURCE) throw Error('源码文件过大'); files.set(name, decode(data)); };
  if (raw.length >= 2 && raw.readUInt16LE(0) === 0x4b50) {
    let declaredTotal = 0;
    const items = unzipSync(raw, { filter: item => { safeName(item.name); if ((declaredTotal += item.originalSize) > MAX_SOURCE || item.originalSize > MAX_TEX) throw Error('源码文件过大'); return !item.name.endsWith('/'); } });
    for (const [name, data] of Object.entries(items)) add(name, data);
    return files;
  }
  const octal = bytes => { const s = bytes.toString('ascii').replace(/\0.*$/, '').trim(); if (!/^[0-7]*$/.test(s)) throw Error('不支持的 tar 数值'); return parseInt(s || '0', 8); };
  const looksTar = raw.length >= 512 && (raw.subarray(257,262).toString() === 'ustar' || /^[0-7\0 ]+$/.test(raw.subarray(124,136).toString()));
  if (looksTar) {
    let offset=0, pendingName=null, paxName=null;
    while(offset+512<=raw.length) {
      const h=raw.subarray(offset,offset+512); if(h.every(x=>x===0))break;
      const sum=h.reduce((n,v,i)=>n+(i>=148&&i<156?32:v),0); if(sum!==octal(h.subarray(148,156)))throw Error('tar 校验失败');
      const size=octal(h.subarray(124,136)); if(size>MAX_SOURCE || offset+512+size>raw.length)throw Error('源码包损坏或过大');
      const body=raw.subarray(offset+512,offset+512+size), type=String.fromCharCode(h[156]);
      let name=h.subarray(0,100).toString().split('\0')[0],prefix=h.subarray(345,500).toString().split('\0')[0];if(prefix)name=prefix+'/'+name;
      offset+=512+Math.ceil(size/512)*512;
      if(type==='L'){pendingName=body.toString().replace(/\0.*$/s,'').trim();continue;}
      if(type==='x'||type==='g'){for(const line of body.toString().split('\n')){const m=/^\d+ path=(.*)$/.exec(line);if(m)paxName=m[1];}continue;}
      name=paxName||pendingName||name;paxName=null;pendingName=null;
      if(name==='.'||name==='./'){if(type==='5')continue;} safeName(name);
      if(['1','2','3','4','6'].includes(type))throw Error('源码包包含不支持的链接或设备文件');
      if(type==='0'||type==='\0')add(name,body);
    }
    return files;
  }
  const text=decode(raw); if(/\\(?:documentclass|documentstyle|input)\b/.test(text))add('main.tex',raw);
  return files;
}
function flattenSource(input) {
  const files=sourceFiles(input), candidates=[];
  for(const [name,text] of files) if(/\.tex$/i.test(name)) {
    let score=(/\\documentclass\b/.test(text)?100:0)+(/\\begin\s*\{document\}/.test(text)?80:0)+(/\\(?:title|maketitle)\b/.test(text)?10:0)-4*name.split('/').length;
    if(/^(main|paper|article|manuscript|ms)\.tex$/i.test(path.basename(name)))score+=12;
    if(/supp|appendix|response|cover|letter/i.test(path.basename(name)))score-=20;
    candidates.push({name,score});
  }
  candidates.sort((a,b)=>b.score-a.score||a.name.localeCompare(b.name));
  if(!candidates.length)return {text:null,unresolved:[]};
  const unresolved=new Set(), visited=new Set(); let consumed=0;
  function expand(name,stack=[]) {
    if(stack.includes(name))throw Error('TeX 文件存在循环引用'); if(stack.length>64)throw Error('TeX 嵌套过深');
    visited.add(name);
    const text=files.get(name).replace(/\r\n?/g,'\n'); if((consumed+=text.length)>MAX_TEX)throw Error('展开后的 TeX 过大');
    let out='',i=0;
    while(i<text.length) {
      if(text[i]==='%'){let slashes=0;for(let j=i-1;j>=0&&text[j]==='\\';j--)slashes++;if(slashes%2===0){const end=text.indexOf('\n',i);const next=end<0?text.length:end+1;out+=text.slice(i,next);i=next;continue;}}
      if(text[i]==='\\') {
        const rest=text.slice(i), verb=/^\\begin\s*\{(verbatim\*?|Verbatim|lstlisting|minted)\}/.exec(rest);
        if(verb){const re=new RegExp('\\\\end\\s*\\{'+verb[1].replace('*','\\*')+'\\}');const end=re.exec(rest.slice(verb[0].length));const count=end?verb[0].length+end.index+end[0].length:rest.length;out+=rest.slice(0,count);i+=count;continue;}
        const inline=/^\\verb\*?([^A-Za-z\s])/.exec(rest);if(inline){const end=rest.indexOf(inline[1],inline[0].length);const count=end<0?rest.length:end+1;out+=rest.slice(0,count);i+=count;continue;}
        const match=/^\\(input|include)(?![A-Za-z@])\s*(?:\{([^{}]+)\}|([^\s%{}]+))/.exec(rest);
        if(match){const reference=(match[2]||match[3]).trim();let included;
          if(!/[\\#]/.test(reference)){
            if(reference.startsWith('/')||/^[A-Za-z]:/.test(reference))throw Error('TeX 引用超出源码范围');
            search: for(const base of [path.dirname(name),'.'])for(const suffix of path.extname(reference)?['']:['','.tex']){const target=path.normalize(path.join(base,reference+suffix));if(target==='..'||target.startsWith('../'))continue;safeName(target);if(files.has(target)){included=target;break search;}}
            if(!included&&reference.startsWith('../')&&path.dirname(name)==='.')throw Error('TeX 引用超出源码范围');
          }
          if(included){const body=expand(included,[...stack,name]);out+='\n% BEGIN INLINED FILE: '+included+'\n'+(match[1]==='include'?'\\clearpage\n':'')+body+(match[1]==='include'?'\n\\clearpage':'')+'\n% END INLINED FILE: '+included+'\n';}
          else{unresolved.add(reference);out+=match[0];}i+=match[0].length;continue;
        }
      }
      out+=text[i++];
    }
    if(out.length>MAX_TEX)throw Error('展开后的 TeX 过大');return out;
  }
  const chunks=[];
  const append=name=>chunks.push('=== '+name+' ===\n'+expand(name).trimEnd()+'\n');
  append(candidates[0].name);
  for(const name of candidates.map(c=>c.name).sort())if(!visited.has(name))append(name);
  const text=chunks.join('\n');if(Buffer.byteLength(text,'utf8')>MAX_TEX)throw Error('汇总后的 TeX 过大');
  return {text,unresolved:[...unresolved]};
}
module.exports={safeName,sourceFiles,flattenSource,MAX_TEX};
