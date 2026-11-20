function normalizeMath(markdown, onMath) {
  const protectedParts = [];
  let marker = '\u0000SD';
  while (markdown.includes(marker)) marker += '_';
  const hold = text => marker + (protectedParts.push(text) - 1) + '\u0000';
  const lines = markdown.split(/(?<=\n)/);
  let text = '', fence = null, block = '', listContentIndent = null;
  for (const line of lines) {
    const indent = /^( *)/.exec(line)[1].length;
    const possibleListMarker = /^( *)(?:[-+*]|\d+[.)])[ \t]+/.exec(line);
    const listMarker = possibleListMarker && (listContentIndent === null ? indent <= 3 : indent < listContentIndent + 4) ? possibleListMarker : null;
    if (!fence) {
      if (listMarker) listContentIndent = listMarker[0].length;
      else if (line.trim() && listContentIndent !== null && indent < listContentIndent) listContentIndent = null;
    }
    const possibleFence = /^( *)(`{3,}|~{3,})/.exec(line);
    const open = possibleFence && (listContentIndent === null ? indent <= 3 : indent >= listContentIndent && indent < listContentIndent + 4) ? possibleFence : null;
    if (fence) {
      block += line;
      if (new RegExp('^ {0,' + Math.max(3, fence.indent) + '}' + fence.char + '{' + fence.length + ',}[ \\t]*(?:\\r?\\n)?$').test(line)) {
        text += hold(block); block = ''; fence = null;
      }
    } else if (open) { fence = {char:open[2][0],length:open[2].length,indent}; block = line; }
    else if (/^(?: {4}|\t)/.test(line) && (listContentIndent === null || indent >= listContentIndent + 4)) text += hold(line);
    else text += line;
  }
  if (block) text += hold(block);
  text = text.replace(/(`+)([^`]|(?!\1)`)*?\1/g, hold);
  text = text.replace(/!?\[[^\]\n]*\]\([^\n)]*\)|<[^>\n]+>/g, hold);
  const escaped = i => { let n = 0; while (i > 0 && text[--i] === '\\') n++; return n % 2 === 1; };
  const closing = (token, start, single = false) => {
    let i = start;
    while ((i = text.indexOf(token, i)) >= 0) {
      if (!escaped(i) && (!single || (text[i-1] !== '$' && text[i+1] !== '$'))) return i;
      i += token.length;
    }
    return -1;
  };
  let out = '';
  for (let i = 0; i < text.length;) {
    if (escaped(i)) { out += text[i++]; continue; }
    let open, close;
    if (text.startsWith('$$', i)) { open = '$$'; close = '$$'; }
    else if (text.startsWith('\\(', i)) { open = '\\('; close = '\\)'; }
    else if (text.startsWith('\\[', i)) { open = '\\['; close = '\\]'; }
    else if (text[i] === '$') { open = '$'; close = '$'; }
    if (!open) { out += text[i++]; continue; }
    const end = closing(close, i + open.length, open === '$');
    if (end < 0) { out += text.slice(i, i + open.length); i += open.length; continue; }
    const inner = text.slice(i + open.length, end);
    // Do not interpret currency pairs, incomplete stream fragments, or code as math.
    const invalid = !inner.trim() || inner.includes(marker) || (open === '$' && (/^\s|\s$|\n/.test(inner) || /^\d/.test(text.slice(end+1))));
    if (invalid) { out += text.slice(i, i + open.length); i += open.length; continue; }
    const delimiter = open === '\\[' ? '$$' : '$';
    const normalized = open === '$$' || open === '$' ? text.slice(i, end + close.length) : delimiter + inner.trim() + delimiter;
    if (onMath) onMath(normalized);
    out += normalized;
    i = end + close.length;
  }
  const token = new RegExp(marker + '(\\d+)\u0000', 'g');
  while (out.includes(marker)) out = out.replace(token, (_, i) => protectedParts[Number(i)]);
  return out;
}
function mathExpressions(markdown) {
  const expressions = [];
  normalizeMath(markdown, expression => expressions.push(expression));
  return expressions;
}

function splitMarkdownBlocks(text, tokenLimit = 8000) {
  const chunks = []; let start = 0, offset = 0, units = 0, fence = null, math = false;
  const full = () => ({cacheable:false,chunks:[{text,stable:false}]});
  for (const line of text.split(/(?<=\n)/)) {
    offset += line.length;
    for (const char of line) units += char.charCodeAt(0) < 128 ? 3 : 6;
    if (fence) {
      if (fence.close.test(line)) fence = null;
    } else if (!math && /^ {0,3}(`{3,}|~{3,})/.test(line)) {
      const opening = /^ {0,3}(`{3,}|~{3,})([^\r\n]*)/.exec(line);
      if (opening[1][0] === '`' && opening[2].includes('`')) return full();
      fence = {close:new RegExp('^ {0,3}'+opening[1][0]+'{'+opening[1].length+',}[ \\t]*(?:\\r?\\n)?$')};
    } else {
      // These constructs can depend on content outside an otherwise closed block.
      if (line.includes('%%') || /^(?: {4}|\t)|^ {0,3}(?:>|[-+*][ \t]|\d+[.)][ \t])|<[A-Za-z!/?]|\||!?\[[^\]\r\n]+\](?!\()|\\(?:label|ref|eqref|tag|def|gdef|newcommand|renewcommand|require)\b/.test(line)) return full();
      let ticks = 0;
      for (let index = 0; index < line.length; index++) {
        if (line[index] === '\\') { index++; continue; }
        if (!math && line[index] === '`') {
          let end = index + 1; while (line[end] === '`') end++;
          const length = end-index; if (!ticks) ticks = length; else if (ticks === length) ticks = 0;
          index = end-1;
        } else if (!ticks && line.startsWith('$$',index)) { math = !math; index++; }
      }
      if (ticks) return full();
    }
    if (!fence && !math && /^\s*$/.test(line) && Math.ceil(units/10) >= tokenLimit) {
      chunks.push({text:text.slice(start,offset),stable:true}); start = offset; units = 0;
    }
  }
  if (start < text.length || !chunks.length) chunks.push({text:text.slice(start),stable:false});
  return {cacheable:true,chunks};
}
function splitMarkdown(text, tokenLimit = 8000) { return splitMarkdownBlocks(text,tokenLimit).chunks.map(chunk => chunk.text); }

module.exports = { normalizeMath, mathExpressions, splitMarkdown, splitMarkdownBlocks };
