const {createHash} = require('node:crypto');
const {uploadFile, validateFiles, fileOptions} = require('./deepseek-files');
const {check, abortableTask} = require('./core');

const ACCEPT = '.pdf,.doc,.docx,.ppt,.pptx,.xls,.xlsx,.epub,.mobi,.txt,.md,.csv,.json,.tex,.py,.js,.ts,.html,.css,.png,.jpg,.jpeg,.gif,.webp,.bmp,.tif,.tiff';
const allowedExtensions = new Set(ACCEPT.split(','));
function acceptsChatFile(name) {
  const extension = /\.[^.\\/]+$/.exec(name);
  return !!extension && allowedExtensions.has(extension[0].toLowerCase());
}

function fileRecords(session) {
  return session.files ||= [];
}

function renewReference(session, oldId, newId, record) {
  const messages = [...session.messages, ...session.entries.flatMap(entry => entry.modelMessages || [])];
  for (const message of messages) {
    if (!Array.isArray(message.content)) continue;
    message.content = message.content.map(block => block.type === 'file' && block.file_id === oldId ? {...block,file_id:newId} : block);
  }
  for (const entry of session.entries) {
    if (entry.files) entry.files = entry.files.map(file => file.id === oldId ? {...file,...record,id:newId} : file);
  }
  session.meter = null;
}

function attachmentMetadata(value) {
  const metadata = Object.fromEntries(['id','name','hash','purpose','bytes','expiresAt'].filter(field => value[field] !== undefined).map(field => [field,value[field]]));
  if (value.notebookFigure === true) metadata.notebookFigure = true;
  return metadata;
}

async function prepareFile(file, session, key, signal, options = {}) {
  check(signal);
  const format = fileOptions(file.name);
  if (!Number.isSafeInteger(file.size) || file.size <= 0 || file.size > format.maxBytes) throw new Error(`File must be between 1 byte and ${format.maxBytes / 1024 / 1024} MiB.`);
  // Keep binary data outside conversation records and send it only to /files.
  const source = await abortableTask(file.arrayBuffer(), signal);
  check(signal);
  const bytes = ArrayBuffer.isView(source) ? new Uint8Array(source.buffer,source.byteOffset,source.byteLength) : new Uint8Array(source);
  if (bytes.byteLength !== file.size) throw new Error('The file changed while being read. Attach it again.');
  const hash = createHash('sha256').update(bytes).digest('hex');
  const records = fileRecords(session), previous = records.find(item => item.hash === hash && item.purpose === format.purpose);
  const validate = options.validate || validateFiles, upload = options.upload || uploadFile;
  if (previous && previous.expiresAt > (options.now || Date.now)()/1000 + 60) {
    try {
      await validate([{role:'user',content:[{type:'file',file_id:previous.id}]}],key,signal);
      check(signal);
      return previous;
    } catch (error) { if (error.code !== 'FILE_UNAVAILABLE') throw error; }
  }
  const uploaded = await upload({name:file.name,size:bytes.byteLength,arrayBuffer:async () => source},key,signal);
  check(signal);
  const record = attachmentMetadata({...uploaded,hash});
  if (previous) {
    renewReference(session,previous.id,record.id,record);
    records.splice(records.indexOf(previous),1,record);
  } else records.push(record);
  return record;
}

function contentWithFiles(text, files, history) {
  const existing = new Set(history.flatMap(message => Array.isArray(message.content) ? message.content.filter(block => block.type === 'file').map(block => block.file_id) : []));
  const blocks = [];
  for (const file of files) {
    if (existing.has(file.id)) continue;
    existing.add(file.id);
    if (file.notebookFigure) blocks.push({type:'text',text:'Notebook output figure SHA-256: '+file.hash});
    blocks.push({type:'file',file_id:file.id});
  }
  return blocks.length ? [{type:'text',text},...blocks] : text;
}

module.exports = {ACCEPT, acceptsChatFile, prepareFile, contentWithFiles, renewReference, attachmentMetadata};
