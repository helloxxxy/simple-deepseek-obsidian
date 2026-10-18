const { test } = require('node:test');
const assert = require('node:assert/strict');
const { notebookHash, validatePatch, safeNotebook, hash } = require('./src/notebook');
const { rebaseNotebookPatch } = require('./src/notebook-merge');

const cell = (id, source = `${id} = 1\nprint(${id})`) => ({ id, cell_type: 'code', source, metadata: {}, outputs: [], execution_count: null });
const fixture = () => ({ nbformat: 4, nbformat_minor: 5, metadata: {}, cells: [cell('a'), cell('b'), cell('c')] });
const patchFor = (base, operations) => ({ baseHash: notebookHash(base), operations });
const apply = (base, current, operations) => {
  const result = rebaseNotebookPatch(base, current, patchFor(base, operations));
  return { ...result, notebook: validatePatch(current, result.patch).notebook };
};
function expectConflict(base, current, operations, reason) {
  const originalBase = JSON.stringify(base), originalCurrent = JSON.stringify(current);
  assert.throws(() => apply(base, current, operations), error => {
    assert.equal(error.code, 'NOTEBOOK_MERGE_CONFLICT');
    assert.equal(error.conflicts[0].reason, reason);
    assert.equal(JSON.stringify(error).includes('print('), false);
    return true;
  });
  assert.equal(JSON.stringify(base), originalBase); assert.equal(JSON.stringify(current), originalCurrent);
}

test('Notebook rebase applies an unchanged base and returns stable IDs for index targets', () => {
  const base = fixture(), result = apply(base, structuredClone(base), [{ type: 'set_source', index: 1, source: 'b = 2' }]);
  assert.equal(result.rebased, false); assert.equal(result.patch.operations[0].cellId, 'b');
  assert.equal(result.notebook.cells[1].source, 'b = 2'); assert.equal(base.cells[1].source, 'b = 1\nprint(b)');
});

test('Notebook rebase ignores execution-only changes and preserves new outputs', () => {
  const base = fixture(), current = structuredClone(base);
  current.cells[1].outputs = [{ output_type: 'stream', name: 'stdout', text: '1\n' }]; current.cells[1].execution_count = 8;
  const result = apply(base, current, [{ type: 'set_source', cellId: 'a', source: 'a = 2' }]);
  assert.equal(result.rebased, true); assert.equal(result.patch.baseHash, notebookHash(current));
  assert.deepEqual(result.notebook.cells[1], current.cells[1]);
});

test('Notebook rebase preserves independent manual changes to other cells and metadata', () => {
  const base = fixture(), current = structuredClone(base); current.cells[1].source = 'b = 99'; current.cells[0].metadata = { tags: ['manual'] };
  const result = apply(base, current, [{ type: 'set_source', cellId: 'a', source: 'a = 2' }]);
  assert.equal(result.notebook.cells[1].source, 'b = 99'); assert.deepEqual(result.notebook.cells[0].metadata, { tags: ['manual'] });
});

test('Notebook rebase follows a stable target through manual insertions and moves', () => {
  const base = fixture(), current = structuredClone(base); current.cells.unshift(cell('manual')); current.cells.push(current.cells.splice(2, 1)[0]);
  const result = apply(base, current, [{ type: 'set_source', index: 1, source: 'b = 2' }]);
  assert.deepEqual(result.notebook.cells.map(c => c.id), ['manual', 'a', 'c', 'b']);
  assert.equal(result.notebook.cells[3].source, 'b = 2');
});

test('Notebook rebase preserves an unrelated manual deletion', () => {
  const base = fixture(), current = structuredClone(base); current.cells.splice(1, 1);
  const result = apply(base, current, [{ type: 'set_source', cellId: 'c', source: 'c = 2' }]);
  assert.deepEqual(result.notebook.cells.map(c => c.id), ['a', 'c']); assert.equal(result.notebook.cells[1].source, 'c = 2');
});

test('Notebook rebase refuses deleted targets and changes in cell type', () => {
  const base = fixture(), current = structuredClone(base); current.cells.splice(1, 1);
  expectConflict(base, current, [{ type: 'set_source', cellId: 'b', source: 'b = 2' }], 'target_deleted');
  const changedType = structuredClone(base); changedType.cells[1].cell_type = 'markdown';
  expectConflict(base, changedType, [{ type: 'set_source', cellId: 'b', source: 'b = 2' }], 'cell_type_changed');
});

test('Notebook rebase merges proven nonoverlapping source edits in the same cell', () => {
  const base = fixture(); base.cells[0].source = 'alpha = 1\nbeta = 2\ngamma = 3\n';
  const current = structuredClone(base); current.cells[0].source = 'alpha = 9\nbeta = 2\ngamma = 3\n';
  const result = apply(base, current, [{ type: 'set_source', cellId: 'a', source: 'alpha = 1\nbeta = 2\ngamma = 8\n' }]);
  assert.equal(result.notebook.cells[0].source, 'alpha = 9\nbeta = 2\ngamma = 8\n');
  assert.equal(result.patch.operations[0].sourceHash, hash(current.cells[0].source));
});

test('Notebook rebase preserves manual edits when AI set_source is a no-op or agrees', () => {
  const base = fixture(), current = structuredClone(base); current.cells[0].source = 'a = 5';
  assert.equal(apply(base, current, [{ type: 'set_source', cellId: 'a', source: base.cells[0].source }]).notebook.cells[0].source, 'a = 5');
  assert.equal(apply(base, current, [{ type: 'set_source', cellId: 'a', source: 'a = 5' }]).notebook.cells[0].source, 'a = 5');
});

test('Notebook rebase rejects overlapping source edits and ambiguous insertions at the same point', () => {
  const base = fixture(), current = structuredClone(base); current.cells[0].source = 'a = 9\nprint(a)';
  expectConflict(base, current, [{ type: 'set_source', cellId: 'a', source: 'a = 7\nprint(a)' }], 'overlapping_source_edit');
  base.cells[0].source = 'abc'; current.cells[0].source = 'aUSERbc';
  expectConflict(base, current, [{ type: 'set_source', cellId: 'a', source: 'aAIbc' }], 'overlapping_source_edit');
});

test('Notebook rebase allows unique replace_text after a proven preceding manual edit', () => {
  const base = fixture(); base.cells[0].source = 'header\nTARGET = 1\nfooter';
  const current = structuredClone(base); current.cells[0].source = 'a longer header\nTARGET = 1\nfooter';
  const result = apply(base, current, [{ type: 'replace_text', cellId: 'a', oldText: 'TARGET = 1', newText: 'TARGET = 2' }]);
  assert.equal(result.notebook.cells[0].source, 'a longer header\nTARGET = 2\nfooter');
});

test('Notebook rebase allows unique replace_text before a separate manual suffix edit', () => {
  const base = fixture(); base.cells[0].source = 'header\nTARGET = 1\nfooter';
  const current = structuredClone(base); current.cells[0].source = 'header\nTARGET = 1\na new footer';
  assert.equal(apply(base, current, [{ type: 'replace_text', cellId: 'a', oldText: 'TARGET = 1', newText: 'TARGET = 2' }]).notebook.cells[0].source, 'header\nTARGET = 2\na new footer');
});

test('Notebook rebase rejects moved or newly duplicated replace_text even if text still exists', () => {
  const base = fixture(); base.cells[0].source = 'before\nTARGET\nafter';
  const current = structuredClone(base); current.cells[0].source = 'before\nafter\nTARGET';
  expectConflict(base, current, [{ type: 'replace_text', cellId: 'a', oldText: 'TARGET', newText: 'NEW' }], 'replace_text_region_changed');
  current.cells[0].source = 'TARGET\nbefore\nTARGET\nafter';
  expectConflict(base, current, [{ type: 'replace_text', cellId: 'a', oldText: 'TARGET', newText: 'NEW' }], 'replace_text_region_changed');
});

test('Notebook rebase refuses to delete a source or metadata changed manually', () => {
  const base = fixture(), current = structuredClone(base); current.cells[0].source = 'manual secret';
  expectConflict(base, current, [{ type: 'delete_cell', cellId: 'a' }], 'deleted_cell_changed');
  current.cells[0].source = base.cells[0].source; current.cells[0].metadata = { tags: ['keep'] };
  expectConflict(base, current, [{ type: 'delete_cell', cellId: 'a' }], 'deleted_cell_metadata_changed');
});

test('Notebook rebase anchors insertions between base IDs and preserves manual additions in the gap', () => {
  const base = fixture(), current = structuredClone(base); current.cells.splice(1, 0, cell('manual'));
  const result = apply(base, current, [{ type: 'insert_cell', cellId: 'ai', index: 1, cellType: 'code', source: 'ai = 1' }]);
  assert.deepEqual(result.notebook.cells.map(c => c.id), ['a', 'manual', 'ai', 'b', 'c']);
});

test('Notebook rebase keeps manual tail and leading additions when AI inserts at a boundary', () => {
  const base = fixture(), current = structuredClone(base); current.cells.unshift(cell('head')); current.cells.push(cell('tail'));
  const result = apply(base, current, [
    { type: 'insert_cell', cellId: 'front-ai', index: 0, cellType: 'markdown', source: '# Start' },
    { type: 'insert_cell', cellId: 'tail-ai', cellType: 'code', source: 'end = 1' }
  ]);
  assert.deepEqual(result.notebook.cells.map(c => c.id), ['head', 'front-ai', 'a', 'b', 'c', 'tail', 'tail-ai']);
});

test('Notebook rebase refuses an insertion if its anchors were deleted or reordered', () => {
  const base = fixture(), current = structuredClone(base), op = { type: 'insert_cell', cellId: 'ai', index: 1, cellType: 'code', source: 'ai = 1' };
  current.cells.shift(); expectConflict(base, current, [op], 'insert_anchor_deleted');
  current.cells = [base.cells[1], base.cells[0], base.cells[2]];
  expectConflict(base, current, [op], 'insert_anchor_reordered');
  current.cells = [base.cells[0], base.cells[2], base.cells[1]];
  expectConflict(base, current, [op], 'insert_anchor_reordered');
});

test('Notebook rebase rejects an inserted ID colliding with a manual addition', () => {
  const base = fixture(), current = structuredClone(base); current.cells.push(cell('ai'));
  expectConflict(base, current, [{ type: 'insert_cell', cellId: 'ai', cellType: 'code', source: 'ai = 1' }], 'insert_id_collision');
});

test('Notebook rebase processes a multi-operation patch against virtual base and current versions', () => {
  const base = fixture(), current = structuredClone(base); current.cells.unshift(cell('manual'));
  const result = apply(base, current, [
    { type: 'delete_cell', cellId: 'b' },
    { type: 'insert_cell', cellId: 'ai', index: 1, cellType: 'code', source: 'first\nlast' },
    { type: 'replace_text', index: 1, oldText: 'first', newText: 'changed' },
    { type: 'set_source', index: 2, source: 'c = 2' }
  ]);
  assert.deepEqual(result.notebook.cells.map(c => c.id), ['manual', 'a', 'ai', 'c']);
  assert.equal(result.notebook.cells[2].source, 'changed\nlast'); assert.equal(result.notebook.cells[3].source, 'c = 2');
});

test('Notebook rebase rejects the complete patch if a late operation conflicts', () => {
  const base = fixture(), current = structuredClone(base); current.cells[2].source = 'manual value';
  expectConflict(base, current, [{ type: 'set_source', cellId: 'a', source: 'a = 2' }, { type: 'set_source', cellId: 'c', source: 'ai value' }], 'overlapping_source_edit');
});

test('Notebook rebase permits legacy index IDs for output-only changes but refuses uncertain shifts', () => {
  const base = fixture(); base.nbformat_minor = 4; for (const cell of base.cells) delete cell.id;
  const current = structuredClone(base); current.cells[1].outputs = [{ output_type: 'stream', name: 'stdout', text: 'ran' }];
  assert.equal(apply(base, current, [{ type: 'set_source', index: 1, source: 'b = 3' }]).notebook.cells[1].source, 'b = 3');
  current.cells.unshift({ ...cell('manual'), id: undefined });
  expectConflict(base, current, [{ type: 'set_source', index: 1, source: 'b = 3' }], 'unstable_cell_identity');
});

test('Notebook rebase accepts safe text-only snapshots while retaining original output-aware base hash', () => {
  const original = fixture(); original.cells[1].outputs = [{ output_type: 'display_data', data: { 'text/plain': 'old result' } }];
  const base = safeNotebook(original), current = structuredClone(original); current.cells[1].outputs = [];
  const result = rebaseNotebookPatch(base, current, patchFor(original, [{ type: 'set_source', cellId: 'a', source: 'a = 2' }]));
  assert.equal(result.patch.baseHash, notebookHash(current));
  assert.equal(validatePatch(current, result.patch).notebook.cells[0].source, 'a = 2');
});

test('Notebook rebase refuses ambiguous duplicate legacy sources and preserves manual metadata before deletion', () => {
  const base = fixture(); base.nbformat_minor = 4; for (const cell of base.cells) delete cell.id;
  base.cells[1].source = base.cells[0].source;
  const current = structuredClone(base); current.cells[0].outputs = [{ output_type: 'stream', name: 'stdout', text: 'ran' }];
  expectConflict(base, current, [{ type: 'set_source', index: 0, source: 'changed' }], 'unstable_cell_identity');
  base.cells[1].source = 'different'; current.cells[1].source = 'different'; current.cells[0].metadata = { tags: ['keep'] };
  expectConflict(base, current, [{ type: 'delete_cell', index: 0 }], 'deleted_cell_metadata_changed');
});

test('Notebook rebase rejects forged base hashes, invalid operations and duplicate identities without source leakage', () => {
  const base = fixture(), current = structuredClone(base);
  assert.throws(() => rebaseNotebookPatch(base, current, { baseHash: '0'.repeat(64), operations: [] }), error => error.code === 'NOTEBOOK_MERGE_CONFLICT' && error.conflicts[0].reason === 'base_hash_mismatch');
  expectConflict(base, current, [{ type: 'shell', source: 'secret command' }], 'invalid_patch');
  current.cells.push(structuredClone(current.cells[0]));
  expectConflict(base, current, [], 'duplicate_cell_id');
});

test('Notebook checkpoint metadata fingerprints permit unchanged nonempty metadata without storing its contents', () => {
  const original = fixture(); original.cells[0].metadata = { tags: ['baseline'], secret: 'must not persist' };
  const base = safeNotebook(original), baseMetadataHashes = original.cells.map(cell => hash(cell.metadata || {}));
  assert.equal(JSON.stringify(base).includes('must not persist'), false);
  const patch = patchFor(original, [{ type: 'delete_cell', cellId: 'a' }]);
  const result = rebaseNotebookPatch(base, structuredClone(original), patch, { baseMetadataHashes });
  assert.deepEqual(validatePatch(original, result.patch).notebook.cells.map(cell => cell.id), ['b', 'c']);
  const changed = structuredClone(original); changed.cells[0].metadata.tags.push('manual');
  assert.throws(() => rebaseNotebookPatch(base, changed, patch, { baseMetadataHashes }), error => error.code === 'NOTEBOOK_MERGE_CONFLICT' && error.conflicts[0].reason === 'deleted_cell_metadata_changed');
});

test('Notebook metadata fingerprints follow sequential deletions and insertions by the virtual base order', () => {
  const original = fixture(); original.cells.forEach((cell, index) => { cell.metadata = { baseline: index }; });
  const base = safeNotebook(original), baseMetadataHashes = original.cells.map(cell => hash(cell.metadata));
  const patch = patchFor(original, [
    { type: 'delete_cell', cellId: 'a' },
    { type: 'insert_cell', cellId: 'temporary', index: 0, cellType: 'code', source: 'temporary = 1' },
    { type: 'delete_cell', cellId: 'b' },
    { type: 'delete_cell', cellId: 'temporary' }
  ]);
  const current = structuredClone(original); current.cells[2].metadata.extra = 'preserved';
  const result = rebaseNotebookPatch(base, current, patch, { baseMetadataHashes });
  const after = validatePatch(current, result.patch).notebook;
  assert.deepEqual(after.cells.map(cell => cell.id), ['c']); assert.equal(after.cells[0].metadata.extra, 'preserved');
  const changed = structuredClone(original); changed.cells[1].metadata.baseline = 88;
  assert.throws(() => rebaseNotebookPatch(base, changed, patch, { baseMetadataHashes }), error => error.conflicts[0].reason === 'deleted_cell_metadata_changed');
});

test('Notebook legacy metadata fingerprints follow index shifts without assigning unstable cell identities', () => {
  const original = fixture(); original.nbformat_minor = 4;
  original.cells.forEach((cell, index) => { delete cell.id; cell.metadata = { baseline: index }; });
  const base = structuredClone(original); base.cells.forEach(cell => { cell.metadata = {}; });
  const baseMetadataHashes = original.cells.map(cell => hash(cell.metadata));
  const patch = patchFor(original, [{ type: 'delete_cell', index: 0 }, { type: 'delete_cell', index: 0 }]);
  const result = rebaseNotebookPatch(base, original, patch, { baseMetadataHashes });
  assert.equal(validatePatch(original, result.patch).notebook.cells[0].source, original.cells[2].source);
});

test('Notebook invalid metadata fingerprint arrays fall back to conservative metadata comparison', () => {
  const original = fixture(); original.cells[0].metadata = { tags: ['keep'] };
  const base = safeNotebook(original), patch = patchFor(original, [{ type: 'delete_cell', cellId: 'a' }]);
  for (const baseMetadataHashes of [[], ['bad', 'bad', 'bad'], ['a'.repeat(64)], null]) {
    assert.throws(() => rebaseNotebookPatch(base, original, patch, { baseMetadataHashes }), error => error.conflicts[0].reason === 'deleted_cell_metadata_changed');
  }
});

test('deleting a cell never discards attachments replaced added or removed after generation', () => {
  const original = fixture(); original.cells[1].attachments = { 'figure.png': { 'image/png': 'AAAA' } };
  for (const attachments of [{ 'figure.png': { 'image/png': 'BBBB' } }, { 'figure.png': { 'image/png': 'AAAA' }, 'new.png': { 'image/png': 'CCCC' } }, {}]) {
    const current = structuredClone(original); current.cells[1].attachments = attachments;
    assert.equal(notebookHash(current), notebookHash(original));
    expectConflict(original, current, [{ type: 'delete_cell', cellId: 'b' }], 'deleted_cell_attachments_changed');
  }
  assert.deepEqual(apply(original, structuredClone(original), [{ type: 'delete_cell', cellId: 'b' }]).notebook.cells.map(cell => cell.id), ['a', 'c']);
});

test('attachment fingerprints retain deletion targets through sequential index shifts', () => {
  const original = fixture(); original.cells.forEach((cell, index) => { cell.attachments = { [`figure-${index}.png`]: { 'image/png': `${index}AAAA` } }; });
  const base = safeNotebook(original), baseAttachmentHashes = original.cells.map(cell => hash(cell.attachments));
  const patch = patchFor(original, [{ type: 'delete_cell', cellId: 'a' }, { type: 'insert_cell', cellType: 'markdown', cellId: 'temporary', index: 0, source: 'temporary' }, { type: 'delete_cell', cellId: 'b' }, { type: 'delete_cell', cellId: 'temporary' }]);
  const result = rebaseNotebookPatch(base, original, patch, { baseAttachmentHashes });
  assert.deepEqual(validatePatch(original, result.patch).notebook.cells.map(cell => cell.id), ['c']);
  const current = structuredClone(original); current.cells[1].attachments['figure-1.png']['image/png'] = 'CHANGED';
  assert.throws(() => rebaseNotebookPatch(base, current, patch, { baseAttachmentHashes }), error => error.conflicts[0].operation === 2 && error.conflicts[0].reason === 'deleted_cell_attachments_changed');
});

test('legacy deletion checks attachment fingerprints after earlier index deletions', () => {
  const original = fixture(); original.nbformat_minor = 4; original.cells.forEach((cell, index) => { delete cell.id; cell.attachments = { figure: { 'image/png': `${index}AAAA` } }; });
  const base = structuredClone(original); base.cells.forEach(cell => delete cell.attachments);
  const options = { baseAttachmentHashes: original.cells.map(cell => hash(cell.attachments)) }, patch = patchFor(original, [{ type: 'delete_cell', index: 0 }, { type: 'delete_cell', index: 0 }]);
  assert.equal(validatePatch(original, rebaseNotebookPatch(base, original, patch, options).patch).notebook.cells.length, 1);
  const current = structuredClone(original); current.cells[1].attachments.figure['image/png'] = 'BBBB';
  assert.throws(() => rebaseNotebookPatch(base, current, patch, options), error => error.conflicts[0].operation === 1 && error.conflicts[0].reason === 'deleted_cell_attachments_changed');
});

test('unknown or malformed attachment fingerprints cannot authorize deleting existing attachments', () => {
  const original = fixture(); original.cells[0].attachments = { figure: { 'image/png': 'AAAA' } };
  const patch = patchFor(original, [{ type: 'delete_cell', cellId: 'a' }]);
  for (const baseAttachmentHashes of [null, [], ['bad', 'bad', 'bad']]) {
    assert.throws(() => rebaseNotebookPatch(original, original, patch, { baseAttachmentHashes }), error => error.conflicts[0].reason === 'deleted_cell_attachments_changed');
  }
  const noAttachments = fixture(), emptyPatch = patchFor(noAttachments, [{ type: 'delete_cell', cellId: 'a' }]);
  assert.equal(validatePatch(noAttachments, rebaseNotebookPatch(noAttachments, noAttachments, emptyPatch, { baseAttachmentHashes: null }).patch).notebook.cells.length, 2);
  const changed = structuredClone(original); changed.cells[0].attachments.figure['image/png'] = 'BBBB';
  const textPatch = patchFor(original, [{ type: 'set_source', cellId: 'a', source: 'a = 2' }]);
  const kept = validatePatch(changed, rebaseNotebookPatch(original, changed, textPatch, { baseAttachmentHashes: null }).patch).notebook;
  assert.deepEqual(kept.cells[0].attachments, changed.cells[0].attachments);
});

test('many Notebook source edits preserve shifted targets manual changes and final atomic conflict checks', () => {
  const base = { nbformat: 4, nbformat_minor: 5, metadata: {}, cells: Array.from({ length: 80 }, (_, index) => cell('cell-'+index, 'value = '+index+'\nprint(value)')) };
  const operations = Array.from({ length: 36 }, (_, index) => ({ type: 'set_source', cellId: 'cell-'+index, source: 'value = '+(index+100)+'\nprint(value)' }));
  const current = structuredClone(base); current.cells.unshift(cell('manual', 'keep manual insertion')); current.cells[70].source = 'independent = 999';
  const result = apply(base, current, operations);
  assert.equal(result.notebook.cells[0].id, 'manual'); assert.equal(result.notebook.cells[70].source, 'independent = 999');
  for (let index = 0; index < 36; index++) { assert.equal(result.patch.operations[index].index, index+1); assert.equal(result.notebook.cells[index+1].source, operations[index].source); }
  current.cells[36].source = 'value = manual_conflict\nprint(value)';
  const before = JSON.stringify(current);
  assert.throws(() => apply(base, current, operations), error => error.code === 'NOTEBOOK_MERGE_CONFLICT' && error.conflicts[0].operation === 35);
  assert.equal(JSON.stringify(current), before); assert.equal(base.cells[0].source, 'value = 0\nprint(value)');
});

test('merge workspaces preserve every caller-owned field on success and a late conflicting operation', () => {
  const base = fixture(), current = structuredClone(base);
  base.cells[1].attachments = { figure: { 'image/png': 'BASE_IMAGE' } }; current.cells[1].attachments = { figure: { 'image/png': 'MANUAL_IMAGE' } };
  current.cells[1].source = 'b = 9\nprint(b)';
  current.cells[1].outputs = [{ output_type: 'stream', name: 'stdout', text: 'manual output' }]; current.cells[1].metadata = { tags: ['manual'] };
  const originalBase = JSON.stringify(base), originalCurrent = JSON.stringify(current);
  const operations = [{ type: 'insert_cell', index: 0, cellType: 'markdown', cellId: 'new', source: '# Introduction' }, { type: 'set_source', cellId: 'a', source: 'a = 2' }, { type: 'delete_cell', cellId: 'c' }];
  const prepared = rebaseNotebookPatch(base, current, patchFor(base, operations));
  assert.equal(prepared.patch.operations.length, 3); assert.equal(JSON.stringify(base), originalBase); assert.equal(JSON.stringify(current), originalCurrent);
  const invalid = [...operations, { type: 'replace_text', cellId: 'b', oldText: 'b = 1', newText: 'b = 8' }];
  assert.throws(() => rebaseNotebookPatch(base, current, patchFor(base, invalid)), error => error.code === 'NOTEBOOK_MERGE_CONFLICT' && error.conflicts[0].operation === 3);
  assert.equal(JSON.stringify(base), originalBase); assert.equal(JSON.stringify(current), originalCurrent);
  const safeBase = safeNotebook(base), safeBefore = JSON.stringify(safeBase);
  rebaseNotebookPatch(safeBase, current, patchFor(base, operations)); assert.equal(JSON.stringify(safeBase), safeBefore); assert.equal(JSON.stringify(current), originalCurrent);
});

test('the default patch workspace isolates caller data even if a later operation fails', () => {
  const { NotebookPatchWorkspace } = require('./src/notebook');
  const original = fixture(), before = JSON.stringify(original), workspace = new NotebookPatchWorkspace(original);
  workspace.apply({ type: 'set_source', cellId: 'a', source: 'a = 2' });
  workspace.apply({ type: 'insert_cell', cellId: 'extra', index: 0, cellType: 'markdown', source: '# Extra' });
  assert.throws(() => workspace.apply({ type: 'delete_cell', cellId: 'missing' }), /找不到/);
  assert.equal(JSON.stringify(original), before); assert.notEqual(workspace.notebook, original); assert.equal(workspace.notebook.cells[1].source, 'a = 2');
});
