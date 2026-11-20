const fs = require('node:fs/promises');
const path = require('node:path');
const { fileURLToPath } = require('node:url');
const { acceptsChatFile } = require('./chat-files');

const EXTENSION = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/gif': '.gif', 'image/webp': '.webp', 'image/bmp': '.bmp', 'image/tiff': '.tiff', 'application/pdf': '.pdf' };

function clipboardAttachments(data, osClipboard, platform = process.platform) {
  if (!data) return [];
  const direct = [...(data.files || [])];
  if (!direct.length) for (const item of data.items || []) if (item.kind === 'file') { const file = item.getAsFile?.(); if (file) direct.push(file); }
  const selected = direct.map(file => {
    const name = file.name && path.extname(file.name) ? file.name : `clipboard${EXTENSION[file.type] || ''}`;
    return acceptsChatFile(name) ? { file, name } : null;
  }).filter(Boolean);
  if (selected.length) return selected;
  let uris = '';
  try { uris = data.getData?.('text/uri-list') || ''; } catch {}
  const paths = uris.split(/\r?\n/).filter(line => line && !line.startsWith('#')).flatMap(line => {
    try { const file = fileURLToPath(line); return acceptsChatFile(file) ? [file] : []; } catch { return []; }
  });
  if (paths.length) return paths.map(filePath => ({ filePath }));
  let formats = [];
  try { formats = osClipboard?.availableFormats?.() || []; } catch {}
  if (platform === 'win32' && formats.includes('FileNameW')) {
    try {
      const filePath = osClipboard.readBuffer('FileNameW').toString('utf16le').split('\0')[0];
      if (path.isAbsolute(filePath) && acceptsChatFile(filePath)) return [{ filePath }];
    } catch {}
  }
  return [];
}

async function materializeClipboardAttachment(candidate, io = fs) {
  if (candidate.file) return { name: candidate.name, size: candidate.file.size, arrayBuffer: () => candidate.file.arrayBuffer() };
  const filePath = candidate.filePath;
  if (!path.isAbsolute(filePath) || !acceptsChatFile(filePath)) throw Error('剪贴板文件路径无效');
  const stat = await io.stat(filePath);
  if (!stat.isFile()) throw Error('剪贴板文件不存在或不是普通文件');
  return { name: path.basename(filePath), size: stat.size, arrayBuffer: () => io.readFile(filePath) };
}

module.exports = { clipboardAttachments, materializeClipboardAttachment };
