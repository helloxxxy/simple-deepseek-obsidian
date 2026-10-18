const { createHash } = require('node:crypto');
const { imageReferenceEdits } = require('./image-context');
const messageFields = ['role', 'content', 'reasoning_content', 'tool_calls', 'tool_call_id'];
function validMessage(message) {
  if (!message || !['user','assistant','system','tool'].includes(message.role) || typeof message.content !== 'string') return false;
  if (message.role === 'tool' && (typeof message.tool_call_id !== 'string' || !message.tool_call_id)) return false;
  if (message.reasoning_content !== undefined && typeof message.reasoning_content !== 'string') return false;
  if (message.tool_calls !== undefined && (!Array.isArray(message.tool_calls) || !message.tool_calls.every(call => call && typeof call.id === 'string' && call.type === 'function' && typeof call.function?.name === 'string' && typeof call.function?.arguments === 'string'))) return false;
  return true;
}
function cloneToolCalls(calls) {
  if (!Array.isArray(calls) || typeof calls.toJSON === 'function') return null;
  const result = [];
  for (const call of calls) {
    if (!call || typeof call !== 'object' || typeof call.toJSON === 'function') return null;
    const keys = Object.keys(call), fn = call.function;
    if (keys.length !== 3 || keys.some(key => !['id','type','function'].includes(key)) || typeof call.id !== 'string' || typeof call.type !== 'string' || !fn || typeof fn !== 'object' || typeof fn.toJSON === 'function') return null;
    const names = Object.keys(fn);
    if (names.length !== 2 || names.some(key => !['name','arguments'].includes(key)) || typeof fn.name !== 'string' || typeof fn.arguments !== 'string') return null;
    const copiedFunction = Object.fromEntries(names.map(name => [name,fn[name]]));
    result.push(Object.fromEntries(keys.map(key => [key,key === 'function' ? copiedFunction : call[key]])));
  }
  return result;
}
function serializedMessageCopy(message) {
  return JSON.parse(JSON.stringify(Object.fromEntries(messageFields.filter(name => message[name] !== undefined).map(name => [name,message[name]]))));
}
function copyMessage(message) {
  const result = {};
  for (const name of messageFields) {
    const value = message[name];
    if (value === undefined) continue;
    if (name === 'tool_calls') {
      const calls = cloneToolCalls(value);
      if (calls === null) return serializedMessageCopy(message);
      result[name] = calls;
    } else {
      if (typeof value !== 'string') return serializedMessageCopy(message);
      result[name] = value;
    }
  }
  return result;
}
function sameMessage(message, snapshot) {
  const serialized = () => JSON.stringify(copyMessage(message)) === JSON.stringify(copyMessage(snapshot));
  for (const name of messageFields) {
    if (name === 'tool_calls') continue;
    const left = message[name], right = snapshot[name];
    if ((left !== undefined && typeof left !== 'string') || (right !== undefined && typeof right !== 'string')) return serialized();
    if (left !== right) return false;
  }
  if (message.tool_calls === undefined && snapshot.tool_calls === undefined) return true;
  const left = cloneToolCalls(message.tool_calls), right = cloneToolCalls(snapshot.tool_calls);
  if (left === null || right === null) return serialized();
  return left.length === right.length && left.every((call,index) => {
    const other = right[index];
    return Object.keys(call).join() === Object.keys(other).join() && Object.keys(call.function).join() === Object.keys(other.function).join()
      && call.id === other.id && call.type === other.type && call.function.name === other.function.name && call.function.arguments === other.function.arguments;
  });
}
function entryMessages(entry) {
  if (Array.isArray(entry.modelMessages) && entry.modelMessages.every(validMessage)) return entry.modelMessages.map(copyMessage);
  if (entry.notebookEvent) return [];
  if (entry.label === '你') return [{role:'user',content:entry.contextText ?? (entry.raw + (entry.references ? '\n\n' + entry.references : ''))}];
  if (entry.label.startsWith('MinerU · ')) return entry.raw ? [{role:'user',content:entry.contextText ?? ('Extracted text from uploaded file '+JSON.stringify(entry.label.slice('MinerU · '.length))+' for later questions, as reference data:\n\n'+entry.raw)}] : [];
  if (entry.label.startsWith('图片 · ')) return entry.contextText ? [{role:'user',content:entry.contextText}] : [];
  return entry.raw ? [{role:'assistant',content:entry.raw,...(entry.thinking ? {reasoning_content:entry.thinking} : {})}] : [];
}
function repairOpenTools(messages) {
  if (!Array.isArray(messages) || !messages.length) return [];
  let index = messages.length - 1;
  while (index >= 0 && messages[index]?.role === 'tool') index--;
  const assistant = messages[index], calls = assistant?.role === 'assistant' ? assistant.tool_calls : null;
  if (!Array.isArray(calls) || !calls.length) return [];
  const ids = calls.map(call => call?.id);
  if (ids.some(id => typeof id !== 'string' || !id) || new Set(ids).size !== ids.length) return [];
  const completed = new Set();
  for (const result of messages.slice(index + 1)) {
    if (!ids.includes(result.tool_call_id) || completed.has(result.tool_call_id)) return [];
    completed.add(result.tool_call_id);
  }
  const added = ids.filter(id => !completed.has(id)).map(id => ({role:'tool',tool_call_id:id,content:JSON.stringify({error:'The conversation was interrupted before this tool result was saved. Its execution outcome is unknown; do not assume it succeeded.',executed:null,interrupted:true})}));
  messages.push(...added);
  return added;
}
const sha256 = content => createHash('sha256').update(content).digest('hex');
function rememberWebResults(message, known) {
  if (message.role !== 'tool') return;
  let data; try { data = JSON.parse(message.content); } catch { return; }
  for (const item of Array.isArray(data?.results) ? data.results : [data]) {
    if (typeof item?.content === 'string' && typeof item.hash === 'string' && /^[0-9a-f]{64}$/.test(item.hash) && sha256(item.content) === item.hash) known.set(item.hash, item.content);
  }
}
function hiddenPrefixLength(entry, content) {
  if (typeof entry.raw !== 'string') return -1;
  let rawOffset = 0, contentOffset = 0;
  for (const marker of entry.raw.matchAll(/@\[(https?:\/\/(?:\[[^\]\r\n]+\]|[^\]\r\n])*)\]/gi)) {
    const literal = entry.raw.slice(rawOffset, marker.index);
    if (!content.startsWith(literal, contentOffset)) return -1;
    contentOffset += literal.length;
    const matched = content.startsWith(marker[0], contentOffset) ? marker[0] : content.startsWith(marker[1], contentOffset) ? marker[1] : null;
    if (matched === null) return -1;
    contentOffset += matched.length; rawOffset = marker.index + marker[0].length;
  }
  const tail = entry.raw.slice(rawOffset);
  return content.startsWith(tail, contentOffset) ? contentOffset + tail.length : -1;
}
function deduplicateEntryReferences(entry, content, knownLibrary, knownWeb, knownImages) {
  const prefix = hiddenPrefixLength(entry, content);
  if (prefix < 0) return content;
  const excludedImages = [];
  if (typeof entry.references === 'string' && entry.references) {
    const material = entry.references, start = prefix, end = start + 2 + material.length;
    if (content.startsWith('\n\n' + material, start) && (end === content.length || /^\n\n\[(?:Web reference sha256:|Web reference metadata\]|Image reference |Notebook delta|Request context)/.test(content.slice(end)))) {
      const parts = material.split(/\n\n---\n\n(?=Reference ID: [^\r\n]+\r?\nTitle: [^\r\n]*\r?\nSource: [^\r\n]+\r?\nReference text:\r?\n\r?\n)/);
      const remaining = parts.filter(part => { if (knownLibrary.has(part)) return false; knownLibrary.add(part); return true; });
      content = content.slice(0, start) + (remaining.length ? '\n\n' + remaining.join('\n\n---\n\n') : '') + content.slice(end);
      if (remaining.length) excludedImages.push([start,start + 2 + remaining.join('\n\n---\n\n').length]);
    }
  }
  const header = /\n\n\[Web reference sha256:([0-9a-f]{64})\]\nURL: [^\r\n]+\nTitle: [^\r\n]*\n(?:Metadata: [^\r\n]*\n)?\n/g;
  header.lastIndex = prefix;
  const blocks = [...content.matchAll(header)], removals = []; let coveredUntil = prefix;
  for (const block of blocks) {
    if (block.index < coveredUntil) continue;
    const bodyStart = block.index + block[0].length, endings = [];
    const boundary = /\n\n\[(?:Web reference sha256:|Web reference metadata\]|Image reference |Notebook delta|Request context)/g; boundary.lastIndex = bodyStart;
    let next; while ((next = boundary.exec(content))) endings.push(next.index);
    endings.push(content.length);
    let end = -1, body, cursor = bodyStart; const digest = createHash('sha256');
    for (const candidate of endings) { digest.update(content.slice(cursor, candidate)); cursor = candidate; if (digest.copy().digest('hex') === block[1]) { end = candidate; body = content.slice(bodyStart, candidate); break; } }
    if (end < 0) continue;
    coveredUntil = end;
    excludedImages.push([block.index,end]);
    if (knownWeb.get(block[1]) === body) removals.push([block.index, end]);
    else knownWeb.set(block[1], body);
  }
  const edits = [...removals.map(([start,end]) => [start,end,'']),...imageReferenceEdits(content,knownImages,{start:prefix,excluded:excludedImages})];
  for (const [start,end,replacement] of edits.sort((a,b) => b[0]-a[0])) content = content.slice(0,start) + replacement + content.slice(end);
  return content;
}
function rebuildEntryMessages(entries) {
  const messages = [], knownLibrary = new Set(), knownWeb = new Map(), knownImages = new Map();
  for (const entry of entries) {
    const restored = entryMessages(entry);
    for (const message of restored) {
      if (entry.label === '你' && message.role === 'user') message.content = deduplicateEntryReferences(entry, message.content, knownLibrary, knownWeb, knownImages);
      messages.push(message); rememberWebResults(message, knownWeb);
    }
  }
  return messages;
}
module.exports = { validMessage, copyMessage, sameMessage, entryMessages, repairOpenTools, rebuildEntryMessages };
