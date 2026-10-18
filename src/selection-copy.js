const { mathExpressions } = require('./markdown');

const MATH = '.math, .math-inline, .math-block, mjx-container';
const IGNORED = 'button, script, style, .copy-code-button, .code-block-flair, mjx-assistive-mml';
const COPY_BODY = '.sd-thinking-body, .sd-body, .sd-sources-body';
const escapeText = text => text.replace(/[\\`*_[\]<>$|#]/g, '\\$&')
  .replace(/(^|\n)([ \t]*)([-+]|\d+[.)])(?=\s)/g, '$1$2\\$3');
const block = text => text.trim() ? text.trim() + '\n\n' : '';
const inline = (text, marker) => text.trim() ? text.replace(/^(\s*)([\s\S]*?)(\s*)$/, (_, before, middle, after) => before + marker + middle + marker + after) : text;

function mathNodes(root) {
  return [...root.querySelectorAll(MATH)].filter(node => !node.parentElement?.closest(MATH));
}
function annotateMath(root, markdown) {
  const nodes = mathNodes(root);
  if (!nodes.length) return;
  const expressions = Array.isArray(markdown) ? markdown : mathExpressions(markdown);
  // A count mismatch can indicate renderer-specific syntax; never attach the wrong formula.
  if (nodes.length === expressions.length) nodes.forEach((node, index) => node.dataset.sdMath = expressions[index]);
}
function mathSource(node) {
  if (node.dataset.sdMath) return node.dataset.sdMath;
  const tex = node.getAttribute('data-math') || node.querySelector('annotation[encoding="application/x-tex"]')?.textContent;
  if (!tex) return '';
  const delimiter = node.matches('.math-block') || node.getAttribute('display') === 'true' ? '$$' : '$';
  return delimiter + tex + delimiter;
}
function intersects(range, node) {
  try { return range.intersectsNode(node); } catch { return false; }
}
function selectedText(node, range) {
  if (!intersects(range, node)) return '';
  const start = range.startContainer === node ? range.startOffset : 0;
  const end = range.endContainer === node ? range.endOffset : node.data.length;
  return node.data.slice(start, end);
}
function backtickFence(text, minimum = 3) {
  let length = minimum;
  for (const match of text.matchAll(/`+/g)) length = Math.max(length, match[0].length + 1);
  return '`'.repeat(length);
}
function fence(text, language = '') {
  const marker = backtickFence(text);
  return marker + language + '\n' + text.replace(/\n$/, '') + '\n' + marker;
}
function inlineCode(text) {
  if (!text) return '';
  const marker = backtickFence(text, 1);
  const pad = /^`|`$/.test(text) || (/^ .* $/.test(text) && text.trim()) ? ' ' : '';
  return marker + pad + text.replace(/\n/g, ' ') + pad + marker;
}
function destination(value) {
  return value.replace(/[\\()\s]/g, character => /\s/.test(character) ? encodeURIComponent(character) : '\\' + character);
}
function serialize(node, range, context = {}) {
  if (!intersects(range, node)) return '';
  if (node.nodeType === 3) {
    const text = selectedText(node, range);
    return context.literal ? text : escapeText(text.replace(/[\t\r\n ]+/g, ' '));
  }
  if (node.nodeType !== 1 || node.matches(IGNORED) || node.hidden) return '';
  const children = childContext => [...node.childNodes].map(child => serialize(child, range, childContext || context)).join('');
  if (node.matches(MATH)) {
    const source = mathSource(node);
    if (source) return source.startsWith('$$') ? block(source) : source;
    return escapeText(children({ literal: true }).trim());
  }
  if (node.matches('.sd-render-fallback, .sd-stream-tail')) return children({ literal: true });
  const tag = node.tagName.toLowerCase();
  if (tag === 'pre') {
    const text = children({ literal: true });
    if (!text) return '';
    const code = node.querySelector('code'), className = code?.className || node.className || '';
    const language = /(?:^|\s)language-([^\s]+)/.exec(className)?.[1] || '';
    return block(fence(text, language));
  }
  if (tag === 'code') return context.literal ? children() : inlineCode(children({ literal: true }));
  if (tag === 'strong' || tag === 'b') return inline(children(), '**');
  if (tag === 'em' || tag === 'i') return inline(children(), '*');
  if (tag === 'del' || tag === 's') return inline(children(), '~~');
  if (tag === 'mark') return inline(children(), '==');
  if (tag === 'br') return context.literal ? '\n' : '  \n';
  if (tag === 'a') {
    const text = children();
    if (!text.trim()) return '';
    const href = node.getAttribute('data-href') || node.getAttribute('href');
    if (!href) return text;
    if (node.classList.contains('internal-link')) return '[[' + href + (text === href ? '' : '|' + text) + ']]';
    const title = node.getAttribute('title');
    return '[' + text + '](' + destination(href) + (title ? ' "' + title.replace(/"/g, '\\"') + '"' : '') + ')';
  }
  if (tag === 'img') {
    const alt = escapeText(node.getAttribute('alt') || ''), source = node.getAttribute('src') || '';
    return /^(?:data|blob):/i.test(source) ? alt : '![' + alt + '](' + destination(source) + ')';
  }
  if (tag === 'input') return '';
  if (tag === 'ul' || tag === 'ol') {
    const items = [...node.children].filter(child => child.tagName === 'LI');
    let number = Number(node.getAttribute('start')) || 1;
    const result = [];
    for (const item of items) {
      if (item.hasAttribute('value')) number = Number(item.getAttribute('value'));
      const text = serialize(item, range, context).trim();
      const marker = tag === 'ol' ? number + '. ' : '- ';
      const checkbox = item.querySelector(':scope > input[type="checkbox"], :scope > p > input[type="checkbox"]');
      if (text) {
        const task = checkbox ? (checkbox.checked || checkbox.hasAttribute('checked') ? '[x] ' : '[ ] ') : '';
        result.push(marker + task + text.replace(/\n/g, '\n' + ' '.repeat(marker.length)));
      }
      number++;
    }
    return result.length ? (node.parentElement?.closest('li') ? '\n' : '') + result.join('\n') + '\n\n' : '';
  }
  if (tag === 'table') {
    const rows = [...node.querySelectorAll('tr')].filter(row => row.closest('table') === node);
    const selected = rows.map(row => [...row.children].filter(cell => /^(TH|TD)$/.test(cell.tagName)).map(cell => serialize(cell, range, context).trim().replace(/\n+/g, '<br>')));
    const width = Math.max(0, ...selected.map(row => row.length));
    if (!width || !selected.some(row => row.some(Boolean))) return '';
    const line = row => '| ' + Array.from({ length: width }, (_, i) => row[i] || '').join(' | ') + ' |';
    const header = rows[0]?.querySelector('th') ? selected.shift() : [];
    return block([line(header), line(Array(width).fill('---')), ...selected.filter(row => row.some(Boolean)).map(line)].join('\n'));
  }
  const text = children();
  if (tag === 'li' || tag === 'td' || tag === 'th') return text;
  if (/^h[1-6]$/.test(tag)) return text.trim() ? block('#'.repeat(Number(tag[1])) + ' ' + text.trim()) : '';
  if (tag === 'blockquote') return text.trim() ? block(text.trim().split('\n').map(line => '> ' + line).join('\n')) : '';
  if (tag === 'hr') return block('---');
  if (tag === 'p') return block(text);
  return text;
}

function selectionInside(root, selection = root.ownerDocument.getSelection()) {
  if (!selection || selection.isCollapsed || !selection.rangeCount) return false;
  for (let index = 0; index < selection.rangeCount; index++) if (intersects(selection.getRangeAt(index), root)) return true;
  return false;
}
function visibleCopyBody(body) {
  if (body.closest('[hidden]')) return false;
  for (let ancestor = body.parentElement; ancestor; ancestor = ancestor.parentElement) if (ancestor.tagName === 'DETAILS' && !ancestor.open) return false;
  return true;
}
function selectedLiteral(node, range) {
  if (!intersects(range,node)) return '';
  if (node.nodeType === 3) return selectedText(node,range);
  if (node.nodeType !== 1 || node.matches(IGNORED) || node.hidden) return '';
  return [...node.childNodes].map(child=>selectedLiteral(child,range)).join('');
}
function selectionToMarkdown(selection, feed) {
  if (!selection || selection.isCollapsed || !selection.rangeCount) return null;
  const pieces = [];
  for (let index = 0; index < selection.rangeCount; index++) {
    const range = selection.getRangeAt(index);
    if (!feed.contains(range.startContainer) || !feed.contains(range.endContainer)) return null;
    let scope = range.commonAncestorContainer;
    if (scope.nodeType !== 1) scope = scope.parentElement;
    for (let ancestor = scope; ancestor && ancestor !== feed; ancestor = ancestor.parentElement) if (ancestor.matches(COPY_BODY)) scope = ancestor;
    const bodies = scope.matches(COPY_BODY) ? [scope, ...scope.querySelectorAll(COPY_BODY)] : scope.querySelectorAll(COPY_BODY);
    for (const body of bodies) {
      if (!intersects(range, body) || !visibleCopyBody(body)) continue;
      const text = body.matches('.sd-thinking-body') ? selectedLiteral(body,range) : serialize(body, range).trim();
      if (text) pieces.push(text);
    }
  }
  return pieces.length ? pieces.join('\n\n') : null;
}
function copySelection(event, feed) {
  const target = event.target;
  if (target?.closest?.('input, textarea, [contenteditable="true"]') || !event.clipboardData) return false;
  const markdown = selectionToMarkdown(feed.ownerDocument.getSelection(), feed);
  if (markdown == null) return false;
  try {
    event.clipboardData.clearData?.();
    event.clipboardData.setData('text/plain', markdown);
  } catch { return false; }
  event.preventDefault();
  event.stopPropagation();
  return true;
}

module.exports = { annotateMath, selectionInside, selectionToMarkdown, copySelection, backtickFence };
