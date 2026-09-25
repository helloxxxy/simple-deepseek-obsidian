// Normalize explicitly delimited math while keeping Markdown code and links intact.
function normalizeMath(markdown) {
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
    out += open === '$$' || open === '$' ? text.slice(i, end + close.length) : delimiter + inner.trim() + delimiter;
    i = end + close.length;
  }
  const token = new RegExp(marker + '(\\d+)\u0000', 'g');
  while (out.includes(marker)) out = out.replace(token, (_, i) => protectedParts[Number(i)]);
  return out;
}
module.exports = { normalizeMath };
