const { createHash } = require('node:crypto');
const { sanitizeReferenceText } = require('./text-safety');

function safeText(value) {
  return sanitizeReferenceText(value);
}
function safeImages(images) {
  if (!Array.isArray(images) || !images.length) throw Error('Image reference requires image metadata.');
  return images.map(image => {
    if (!image || typeof image.id !== 'string' || !image.id.trim()) throw Error('Image reference requires a nonempty image ID.');
    const result = { id: safeText(image.id), name: safeText(image.name) };
    if (typeof image.mime === 'string') result.mime = safeText(image.mime);
    for (const key of ['width','height','size']) if (Number.isSafeInteger(image[key]) && image[key] > 0) result[key] = image[key];
    if (image.region) {
      const {x,y,width,height} = image.region;
      if (![x,y,width,height].every(Number.isFinite) || x < 0 || y < 0 || width <= 0 || height <= 0 || x + width > 1 || y + height > 1) throw Error('Image reference crop is outside the original image.');
      result.region = {x,y,width,height};
    }
    return result;
  });
}
const identity = (metadata, text) => JSON.stringify({images:metadata.images,question:metadata.question}) + '\n\n' + text;
const digest = value => createHash('sha256').update(value).digest('hex');
const reused = (hash, metadata, prefix = '\n\n') => prefix + '[Image reference reuse sha256:' + hash + ']\nMetadata: ' + JSON.stringify({images:metadata.images,question:metadata.question});

// Length bounds the body; its digest also covers metadata, including the task.
// Marker-like text in an image description cannot terminate the outer block.
function imageReferenceBlocks(content, start = 0) {
  if (typeof content !== 'string') return [];
  const header = /(?:^|\n\n)\[Image reference sha256:([0-9a-f]{64})\]\nMetadata: ([^\r\n]+)\n\n/g;
  header.lastIndex = start;
  const blocks = [];
  let match;
  while ((match = header.exec(content))) {
    let metadata;
    try {
      metadata = JSON.parse(match[2]);
      if (!metadata || typeof metadata.question !== 'string' || !Number.isSafeInteger(metadata.textLength) || metadata.textLength < 0 || Object.keys(metadata).some(key => !['images','question','textLength'].includes(key))) continue;
      const images = safeImages(metadata.images);
      if (JSON.stringify(images) !== JSON.stringify(metadata.images) || safeText(metadata.question) !== metadata.question) continue;
    } catch { continue; }
    const bodyStart = match.index + match[0].length, end = bodyStart + metadata.textLength;
    if (end > content.length || (end !== content.length && !content.startsWith('\n\n',end))) continue;
    const text = content.slice(bodyStart,end), key = identity(metadata,text);
    if (digest(key) !== match[1]) continue;
    blocks.push({start:match.index,end,hash:match[1],metadata,text,key,prefix:match[0].startsWith('\n\n') ? '\n\n' : ''});
    header.lastIndex = end;
  }
  return blocks;
}

function imageReference(result, question, {history = [], reuse = true} = {}) {
  if (!result || typeof result.text !== 'string') throw Error('Image reference requires description text.');
  const metadata = {images:safeImages(result.images),question:safeText(question)}, text = safeText(result.text);
  const key = identity(metadata,text), hash = digest(key);
  if (reuse && history.some(message => imageReferenceBlocks(typeof message === 'string' ? message : message?.content).some(block => block.hash === hash && block.key === key))) return reused(hash,metadata);
  return '\n\n[Image reference sha256:' + hash + ']\nMetadata: ' + JSON.stringify({...metadata,textLength:text.length}) + '\n\n' + text;
}

function imageReferenceEdits(content, known, {start = 0, excluded = []} = {}) {
  const edits = [];
  for (const block of imageReferenceBlocks(content,start)) {
    if (excluded.some(([left,right]) => block.start < right && block.end > left)) continue;
    if (known.get(block.hash) === block.key) edits.push([block.start,block.end,reused(block.hash,block.metadata,block.prefix)]);
    else known.set(block.hash,block.key);
  }
  return edits;
}

module.exports = { imageReference, imageReferenceBlocks, imageReferenceEdits };
