const IMAGE_OMITTED = '[image data omitted]';
const BINARY_OMITTED = '[binary data omitted]';

function base64Character(code) {
  return code >= 65 && code <= 90 || code >= 97 && code <= 122 || code >= 48 && code <= 57 || code === 43 || code === 47;
}

function horizontal(code) { return code === 32 || code === 9; }

function newlineLength(text,index) {
  if (text[index] === '\n') return 1;
  if (text[index] === '\r') return text[index+1] === '\n' ? 2 : 1;
  if (text[index] !== '\\') return 0;
  if (text[index+1] === 'n') return 2;
  if (text[index+1] === 'r') return text[index+2] === '\\' && text[index+3] === 'n' ? 4 : 2;
  // A source-language line continuation can precede an actual newline.
  if (text[index+1] === '\n') return 2;
  if (text[index+1] === '\r') return text[index+2] === '\n' ? 3 : 2;
  return 0;
}

function base64Run(text,start) {
  let end = start, firstPadding = -1;
  while (end < text.length) {
    const code = text.charCodeAt(end);
    if (code === 61) { if (firstPadding < 0) firstPadding = end; }
    else if (!base64Character(code)) break;
    end++;
  }
  const padding = firstPadding < 0 ? 0 : end-firstPadding;
  const valid = end > start && (firstPadding < 0 || padding <= 2 && /^={1,2}$/.test(text.slice(firstPadding,end)));
  return {start,end,length:end-start,padding,valid};
}

function continuationStart(text,start) {
  let index = start, separated = false;
  while (true) {
    while (horizontal(text.charCodeAt(index))) index++;
    const count = newlineLength(text,index);
    if (!count) break;
    separated = true; index += count;
  }
  return separated ? index : -1;
}

function continuationEnd(text,start) {
  const run = base64Run(text,start);
  if (!run.valid || run.length % 4 === 1) return null;
  let tail = run.end;
  while (horizontal(text.charCodeAt(tail))) tail++;
  const endOfLine = tail === text.length || newlineLength(text,tail) > 0;
  const closed = /['"`<>)\]]/.test(text[tail] || '');
  if (!endOfLine && !closed) return null;
  // A data URI establishes what the continuation contains, but an ordinary
  // word on the next line must not be mistaken for another Base64 fragment.
  const fullLine = run.length >= 32 && run.length % 4 === 0;
  const paddedFinal = run.padding > 0 && run.length % 4 === 0;
  const closedFinal = closed && tail === run.end && run.length >= 2;
  return fullLine || paddedFinal || closedFinal ? run : null;
}

function stripImageDataUris(text) {
  const marker = /data:image\//gi, parts = [];
  let copied = 0, match;
  while ((match = marker.exec(text))) {
    const start = match.index;
    let headerEnd = marker.lastIndex;
    while (headerEnd < text.length && !/[\s'"`<>()]/.test(text[headerEnd]) && text[headerEnd] !== ',') headerEnd++;
    let end;
    if (text[headerEnd] === ',' && /;base64$/i.test(text.slice(marker.lastIndex,headerEnd))) {
      let run = base64Run(text,headerEnd+1);
      end = run.end;
      if (!run.padding) while (true) {
        const next = continuationStart(text,end);
        if (next < 0) break;
        const continued = continuationEnd(text,next);
        if (!continued) break;
        run = continued; end = continued.end;
        if (continued.padding) break;
      }
    } else {
      end = headerEnd;
      while (end < text.length && !/[\s'"`<>()]/.test(text[end])) end++;
    }
    parts.push(text.slice(copied,start),IMAGE_OMITTED); copied = end; marker.lastIndex = end;
  }
  return parts.length ? parts.join('')+text.slice(copied) : text;
}

function stripLongBase64(text) {
  const parts = [];
  let index = 0, copied = 0;
  while (index < text.length) {
    if (!base64Character(text.charCodeAt(index))) { index++; continue; }
    const start = index;
    while (base64Character(text.charCodeAt(index))) index++;
    if (index-start < 400) continue;
    if (text[index] === '=') index++;
    if (text[index] === '=') index++;
    parts.push(text.slice(copied,start),BINARY_OMITTED); copied = index;
  }
  return parts.length ? parts.join('')+text.slice(copied) : text;
}

function sanitizeReferenceText(value) { return stripLongBase64(stripImageDataUris(String(value || ''))); }

module.exports = {sanitizeReferenceText,stripImageDataUris,stripLongBase64};
