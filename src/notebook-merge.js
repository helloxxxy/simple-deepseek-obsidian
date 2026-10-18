// RTC transports concurrent edits. This module separately checks whether an AI
// edit still has the same meaning against the current Notebook before applying it.
const clone = value => JSON.parse(JSON.stringify(value));
const sourceOf = cell => Array.isArray(cell?.source) ? cell.source.join('') : String(cell?.source || '');
const idOf = (cell, index) => typeof cell?.id === 'string' && cell.id ? cell.id : `index-${index}`;
const fingerprintHashes = (value, count) => Array.isArray(value) && value.length === count && value.every(item => typeof item === 'string' && /^[0-9a-f]{64}$/i.test(item))
  ? value.map(item => item.toLowerCase()) : null;

function conflict(operation, op, reason) {
  const error = Error('Notebook edits conflict with changes made since generation. Review or regenerate the edits.');
  error.code = 'NOTEBOOK_MERGE_CONFLICT';
  error.conflicts = [{ operation, type: typeof op?.type === 'string' ? op.type : 'unknown', ...(typeof op?.cellId === 'string' ? { cellId: op.cellId } : {}), reason }];
  return error;
}

function rawNotebook(value) {
  if (!Array.isArray(value?.cells)) throw conflict(-1, null, 'missing_base_snapshot');
  if (value.cells.some(cell => typeof cell?.cellType === 'string')) {
    return { nbformat: 4, nbformat_minor: 5, cells: value.cells.map(cell => ({
      ...(typeof cell.cellId === 'string' && cell.cellId && !/^index-\d+$/.test(cell.cellId) ? { id: cell.cellId } : {}),
      cell_type: cell.cellType, source: sourceOf(cell), metadata: {}, outputs: Array.isArray(cell.outputs) ? cell.outputs : []
    })) };
  }
  return clone(value);
}

function hasStableIds(notebook) {
  const ids = notebook.cells.map(cell => cell.id);
  return ids.every(id => typeof id === 'string' && id) && new Set(ids).size === ids.length;
}

function duplicateIds(notebook) {
  const ids = notebook.cells.map(cell => cell.id).filter(id => typeof id === 'string' && id);
  return new Set(ids).size !== ids.length;
}

// A common prefix/suffix proves that text outside this one edit span is intact.
// Multiple separate user edits become a conservative larger span, rather than
// guessing which repeated line corresponds to the old edit position.
function editSpan(before, after) {
  let start = 0, end = before.length, afterEnd = after.length;
  while (start < end && start < afterEnd && before[start] === after[start]) start++;
  while (end > start && afterEnd > start && before[end - 1] === after[afterEnd - 1]) { end--; afterEnd--; }
  return { start, end, text: after.slice(start, afterEnd) };
}

function overlaps(a, b) {
  if (a.start === a.end) return a.start >= b.start && a.start <= b.end;
  if (b.start === b.end) return b.start >= a.start && b.start <= a.end;
  return a.start < b.end && b.start < a.end;
}

function uniqueIndex(text, needle) {
  if (typeof needle !== 'string' || !needle) return -1;
  const index = text.indexOf(needle);
  return index >= 0 && text.indexOf(needle, index + 1) < 0 ? index : -1;
}

function mergedSource(base, current, proposed, operation, op) {
  if (base === current) return proposed;
  if (proposed === base || proposed === current) return current;
  const manual = editSpan(base, current), ai = editSpan(base, proposed);
  if (overlaps(manual, ai)) throw conflict(operation, op, 'overlapping_source_edit');
  const edits = [manual, ai].sort((a, b) => b.start - a.start);
  return edits.reduce((text, edit) => text.slice(0, edit.start) + edit.text + text.slice(edit.end), base);
}

function insertIndex(base, current, at, operation, op, baseWorkspace, currentWorkspace) {
  const left = at > 0 ? base.cells[at - 1].id : null;
  const right = at < base.cells.length ? base.cells[at].id : null;
  const leftIndex = left == null ? -1 : currentWorkspace.indexForId(left);
  const rightIndex = right == null ? current.cells.length : currentWorkspace.indexForId(right);
  if ((left != null && leftIndex < 0) || (right != null && rightIndex < 0)) throw conflict(operation, op, 'insert_anchor_deleted');
  if (leftIndex >= rightIndex) throw conflict(operation, op, 'insert_anchor_reordered');
  for (let index = leftIndex + 1; index < rightIndex; index++) if (baseWorkspace.indexForId(current.cells[index].id) >= 0) throw conflict(operation, op, 'insert_anchor_reordered');
  // Retain manual additions inside the gap and append the AI cell after them.
  return rightIndex;
}

function rebaseNotebookPatch(baseNotebook, currentNotebook, patch, options = {}) {
  // Lazy import permits notebook.js to call this module without a require cycle.
  const { notebookHash, validatePatch, NotebookPatchWorkspace, hash } = require('./notebook');
  let base = rawNotebook(baseNotebook), current = rawNotebook(currentNotebook);
  const metadataHashes = fingerprintHashes(options?.baseMetadataHashes, base.cells.length);
  const attachmentHashes = fingerprintHashes(options?.baseAttachmentHashes, base.cells.length);
  const sameMetadata = (before, now, index) => metadataHashes ? hash(now?.metadata || {}) === metadataHashes[index] : JSON.stringify(before?.metadata || {}) === JSON.stringify(now?.metadata || {});
  const sameAttachments = (before, now, index) => {
    if (attachmentHashes) return hash(now?.attachments || {}) === attachmentHashes[index];
    // Without an attachment fingerprint, a text-only snapshot cannot prove
    // that a live attachment has remained unchanged.
    if (Object.prototype.hasOwnProperty.call(options || {}, 'baseAttachmentHashes')) return Object.keys(now?.attachments || {}).length === 0;
    return JSON.stringify(before?.attachments || {}) === JSON.stringify(now?.attachments || {});
  };
  const advanceFingerprints = (op, index) => {
    for (const fingerprints of [metadataHashes, attachmentHashes]) {
      if (!fingerprints) continue;
      if (op.type === 'insert_cell') fingerprints.splice(op.index, 0, hash({}));
      else if (op.type === 'delete_cell') fingerprints.splice(index, 1);
    }
  };
  const originalBaseHash = typeof baseNotebook.notebookHash === 'string' ? baseNotebook.notebookHash : notebookHash(base);
  if (!patch || patch.baseHash !== originalBaseHash) throw conflict(-1, null, 'base_hash_mismatch');
  if (duplicateIds(base) || duplicateIds(current)) throw conflict(-1, null, 'duplicate_cell_id');
  let checked;
  try { checked = validatePatch(base, { ...patch, baseHash: notebookHash(base) }).patch; }
  catch { throw conflict(-1, null, 'invalid_patch'); }
  const currentHash = notebookHash(current);
  const stable = hasStableIds(base) && hasStableIds(current);
  // rawNotebook owns these copies; adopting them avoids cloning each notebook twice.
  const baseWorkspace = new NotebookPatchWorkspace(base, { copy: false }), currentWorkspace = new NotebookPatchWorkspace(current, { copy: false });
  base = baseWorkspace.notebook; current = currentWorkspace.notebook;
  if (!stable) {
    const sameCells = base.cells.length === current.cells.length && base.cells.every((cell, index) =>
      idOf(cell, index) === idOf(current.cells[index], index) && cell.cell_type === current.cells[index].cell_type && sourceOf(cell) === sourceOf(current.cells[index]));
    if (!sameCells) throw conflict(-1, null, 'unstable_cell_identity');
    const legacySignatures = base.cells.filter(cell => !cell.id).map(cell => JSON.stringify([cell.cell_type, sourceOf(cell)]));
    if (patch.baseHash !== currentHash && new Set(legacySignatures).size !== legacySignatures.length) throw conflict(-1, null, 'unstable_cell_identity');
    // Without persistent IDs only unchanged positions can be used. Even here,
    // deletion must not silently discard metadata edited by the user.
    let before = base, now = current;
    for (const [operation, op] of checked.operations.entries()) {
      let metadataIndex = null;
      if (op.type === 'delete_cell') {
        const at = typeof op.cellId === 'string' && op.cellId ? baseWorkspace.indexForId(op.cellId) : op.index;
        metadataIndex = at;
        if (!sameMetadata(before.cells[at], now.cells[at], at)) throw conflict(operation, op, 'deleted_cell_metadata_changed');
        if (!sameAttachments(before.cells[at], now.cells[at], at)) throw conflict(operation, op, 'deleted_cell_attachments_changed');
      }
      baseWorkspace.apply(op); currentWorkspace.apply(op);
      advanceFingerprints(op, metadataIndex);
    }
    return { patch: { baseHash: currentHash, operations: checked.operations }, rebased: patch.baseHash !== currentHash };
  }
  const operations = [];
  for (const [operation, op] of checked.operations.entries()) {
    let rebased, metadataIndex = null;
    if (op.type === 'insert_cell') {
      if (currentWorkspace.indexForId(op.cellId) >= 0) throw conflict(operation, op, 'insert_id_collision');
      rebased = { ...op, index: insertIndex(base, current, op.index, operation, op, baseWorkspace, currentWorkspace) };
    } else {
      const baseIndex = typeof op.cellId === 'string' && op.cellId ? baseWorkspace.indexForId(op.cellId) : op.index;
      metadataIndex = baseIndex;
      const baseCell = base.cells[baseIndex], id = baseCell?.id;
      const currentIndex = currentWorkspace.indexForId(id);
      if (!baseCell || currentIndex < 0) throw conflict(operation, { ...op, cellId: id }, 'target_deleted');
      const currentCell = current.cells[currentIndex];
      if (baseCell.cell_type !== currentCell.cell_type) throw conflict(operation, { ...op, cellId: id }, 'cell_type_changed');
      const before = sourceOf(baseCell), now = sourceOf(currentCell);
      rebased = { ...op, cellId: id, index: currentIndex, sourceHash: hash(now) };
      if (op.type === 'delete_cell') {
        if (before !== now) throw conflict(operation, rebased, 'deleted_cell_changed');
        if (!sameMetadata(baseCell, currentCell, baseIndex)) throw conflict(operation, rebased, 'deleted_cell_metadata_changed');
        if (!sameAttachments(baseCell, currentCell, baseIndex)) throw conflict(operation, rebased, 'deleted_cell_attachments_changed');
      } else if (op.type === 'set_source') rebased.source = mergedSource(before, now, op.source, operation, rebased);
      else if (op.type === 'replace_text' && before !== now) {
        const at = uniqueIndex(before, op.oldText), actual = uniqueIndex(now, op.oldText), manual = editSpan(before, now);
        if (at < 0 || actual < 0 || overlaps(manual, { start: at, end: at + op.oldText.length })) throw conflict(operation, rebased, 'replace_text_region_changed');
        const expected = at + (manual.end <= at ? manual.text.length - (manual.end - manual.start) : 0);
        if (actual !== expected) throw conflict(operation, rebased, 'replace_text_location_changed');
      }
    }
    // Advance both virtual versions so subsequent AI indices and hashes retain
    // their original sequential meaning. Nothing here mutates either live input.
    try {
      baseWorkspace.apply(op); currentWorkspace.apply(rebased);
    } catch { throw conflict(operation, rebased, 'invalid_rebased_operation'); }
    advanceFingerprints(op, metadataIndex);
    operations.push(rebased);
  }
  return { patch: { baseHash: currentHash, operations }, rebased: patch.baseHash !== currentHash };
}

module.exports = { rebaseNotebookPatch };
