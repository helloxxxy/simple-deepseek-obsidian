const levels={part:0,chapter:1,section:2,subsection:3,subsubsection:4,paragraph:5,subparagraph:6};
const blank=s=>s.replace(/[^\r\n]/g,' ');
function maskTex(text){let out='',i=0;while(i<text.length){
 if(text[i]==='%'){const end=text.indexOf('\n',i);const stop=end<0?text.length:end;out+=blank(text.slice(i,stop));i=stop;continue;}
 if(text[i]==='\\'){
  const tail=text.slice(i),env=/^\\begin\s*\{(verbatim\*?|Verbatim|lstlisting|minted|comment)\}/.exec(tail);
  if(env){const end=new RegExp('\\\\end\\s*\\{'+env[1].replace('*','\\*')+'\\}').exec(tail.slice(env[0].length));const n=end?env[0].length+end.index+end[0].length:tail.length;out+=blank(tail.slice(0,n));i+=n;continue;}
  const verb=/^\\verb\*?([^A-Za-z\s])/.exec(tail);if(verb){const end=tail.indexOf(verb[1],verb[0].length),n=end<0?tail.length:end+1;out+=blank(tail.slice(0,n));i+=n;continue;}
  if(i+1<text.length){out+=text.slice(i,i+2);i+=2;continue;}
 }
 out+=text[i++];}return out;}
function group(text,start,open='{',close='}') {if(text[start]!==open)return null;let depth=0;for(let i=start;i<text.length;i++){if(text[i]==='\\'){i++;continue;}if(text[i]===open)depth++;if(text[i]===close&&!--depth)return {text:text.slice(start+1,i),end:i+1};}return null;}
function finish(headings,length){for(let i=0;i<headings.length;i++){let end=length;for(let j=i+1;j<headings.length;j++)if(headings[j].level<=headings[i].level){end=headings[j].start;break;}headings[i].end=end;}return headings;}
function falseBlockEnd(source,start){
 const commands=/\\([A-Za-z@]+|.)/g;commands.lastIndex=start;let depth=1;
 const known=/^(?:if|ifcat|ifnum|ifdim|ifodd|ifvmode|ifhmode|ifmmode|ifinner|ifvoid|ifhbox|ifvbox|ifx|ifeof|iftrue|iffalse|ifcase|ifdefined|ifcsname|iffontchar)$/;
 let m;while((m=commands.exec(source))){const cmd=m[1];if(cmd.startsWith('if')){if(!known.test(cmd))return null;depth++;}else if((cmd==='else'||cmd==='or')&&depth===1)return null;else if(cmd==='fi'&&!--depth)return commands.lastIndex;}return null;
}
function texOutline(text){const source=maskTex(text),headings=[];let depth=0,safe=true;
 for(let i=0;i<source.length;i++){
  if(source[i]==='\\'){
   const m=/^\\([A-Za-z@]+|.)/.exec(source.slice(i));if(!m)continue;const cmd=m[1];
   if(cmd==='iffalse'){const end=falseBlockEnd(source,i+m[0].length);if(end!==null){i=end-1;continue;}}
   if(/^(?:if[a-zA-Z@]*|else|fi|input|include|catcode|csname)$/.test(cmd))safe=false;
   if(Object.hasOwn(levels,cmd)){
    let at=i+m[0].length;if(source[at]==='*')at++;while(/\s/.test(source[at]||'')&&at<source.length)at++;
    if(source[at]==='['){const optional=group(source,at,'[',']');if(!optional){safe=false;continue;}at=optional.end;while(/\s/.test(source[at]||'')&&at<source.length)at++;}
    const title=group(source,at);if(!title){safe=false;continue;}
    if(depth!==0||title.text.includes('#'))safe=false;
    else headings.push({start:i,level:levels[cmd],title:title.text.replace(/\\(?:textbf|textit|emph|textrm|textsf|texttt)\s*/g,'').replace(/[{}]/g,'').replace(/\s+/g,' ').trim()||'未命名章节'});
    i=title.end-1;continue;
   }
   i+=m[0].length-1;continue;
  }
  if(source[i]==='{')depth++;else if(source[i]==='}'){depth--;if(depth<0)safe=false;}
 }
 if(depth!==0)safe=false;finish(headings,text.length);
 return {headings,reliable:safe&&headings.length>0};
}
function markdownOutline(text){const headings=[];const lines=text.match(/[^\n]*(?:\n|$)/g)||[];let offset=0,fence=null,previous=null,comment=false;
 for(const raw of lines){if(!raw)continue;const line=raw.replace(/\r?\n$/,'');const token=/^ {0,3}(`{3,}|~{3,})/.exec(line);
  if(token&&!comment){if(!fence)fence=token[1];else if(token[1][0]===fence[0]&&token[1].length>=fence.length&&/^ {0,3}(?:`+|~+)\s*$/.test(line))fence=null;previous=null;offset+=raw.length;continue;}
  if(fence){offset+=raw.length;continue;}
  if(comment||line.includes('<!--')){if(line.includes('<!--'))comment=true;if(line.includes('-->'))comment=false;previous=null;offset+=raw.length;continue;}
  const atx=/^ {0,3}(#{1,6})(?:[ \t]+(.*?)|[ \t]*)$/.exec(line),setext=/^ {0,3}(=+|-+)\s*$/.exec(line);
  if(atx){headings.push({start:offset,level:atx[1].length,title:(atx[2]||'').replace(/\s+#+\s*$/,'').trim()||'未命名标题'});previous=null;}
  else if(setext&&previous){headings.push({start:previous.start,level:setext[1][0]==='='?1:2,title:previous.text.trim()});previous=null;}
  else previous=line.trim()&&!/^ {4}|^\t|^\s*>/.test(line)?{start:offset,text:line}:null;
  offset+=raw.length;
 }return {headings:finish(headings,text.length),reliable:false};}
function outline(text,format){return format==='tex'?texOutline(text):markdownOutline(text);}
function headingAt(headings,position,fallback='正文前部（未识别标题）'){const stack=[];for(const h of headings){if(h.start>position)break;while(stack.length&&stack.at(-1).level>=h.level)stack.pop();stack.push(h);}return stack.map(h=>h.title).join(' / ')||fallback;}
function mergeRanges(ranges){const merged=[];for(const r of ranges.map(r=>({...r})).sort((a,b)=>a.start-b.start)){const last=merged.at(-1);if(last&&r.start<=last.end)last.end=Math.max(last.end,r.end);else merged.push(r);}return merged;}
function withOutlineContext(text,selected,ranges,parsed=texOutline(text)){
 if(!parsed.headings.length)return selected;
 const chosen=mergeRanges(ranges),lines=['[Reference outline; parsed locally and provided as reference data]',parsed.reliable?'Recognized LaTeX sections:':'Partially recognized sections; this outline may be incomplete.','For omitted sections, only headings are available. Do not infer their contents.',''];
 const {estimateText}=require('./context');
 for(const h of parsed.headings){const covered=chosen.reduce((n,r)=>n+Math.max(0,Math.min(r.end,h.end)-Math.max(r.start,h.start)),0);const state=covered===h.end-h.start?'full text included':covered?'partly included':'body omitted';lines.push('  '.repeat(h.level)+'- '+h.title+' ('+state+'; about '+estimateText(text.slice(h.start,h.end))+' tokens including subsections)');}
 lines.push('','Included ranges:');for(const r of chosen)lines.push('- '+headingAt(parsed.headings,r.start,'Before first heading')+' → '+headingAt(parsed.headings,Math.max(r.start,r.end-1),'Before first heading')+' (source characters '+r.start+'–'+r.end+', end exclusive)');
 return lines.join('\n')+'\n\n[Included reference text]\n\n'+selected;
}
module.exports={outline,texOutline,markdownOutline,headingAt,mergeRanges,withOutlineContext};
