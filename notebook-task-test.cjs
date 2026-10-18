const { test } = require('node:test');
const assert = require('node:assert/strict');
const { NotebookEditBuffer, notebookHash, validatePatch, hash } = require('./src/notebook');

const fixture = () => ({ nbformat: 4, nbformat_minor: 5, metadata: { kernelspec: { name: 'python3' }, hidden: 'private metadata' }, cells: [
  { id: 'first', cell_type: 'code', source: 'before = 1\nprint(before)', metadata: {}, execution_count: 1, outputs: [] },
  { id: 'second', cell_type: 'markdown', source: '# Notes', metadata: {} }
] });
const begin = (buffer, source = 'value = ', extra = {}) => ({ baseHash: buffer.currentHash, operations: [{ type: 'source_chunk', chunkId: 'rewrite', part: 0, source, operation: { type: 'set_source', cellId: 'first', sourceHash: hash('before = 1\nprint(before)') }, ...extra }], done: false });

test('existing cell source can be rewritten in an open-ended acknowledged chunk task', () => {
  const original = fixture(), buffer = new NotebookEditBuffer(original);
  const first = buffer.stage(begin(buffer));
  assert.equal(first.taskId, buffer.taskId); assert.equal(first.revision, 1); assert.ok(first.progress > 0);
  assert.equal(first.totalParts, null); assert.equal(first.pendingChunks, 1); assert.equal(first.nextPart, 1);
  assert.equal(buffer.read().cells[0].source, original.cells[0].source);
  const next = buffer.stage({ baseHash: buffer.currentHash, operations: [{ type: 'source_chunk', chunkId: 'rewrite', part: 1, source: '42\nprint(value)', final: true }], done: true });
  assert.equal(next.done, true); assert.equal(next.pendingChunks, 0); assert.equal(next.completedOperations, 1);
  assert.equal(buffer.result().operations[0].type, 'set_source');
  assert.equal(validatePatch(original, buffer.result()).notebook.cells[0].source, 'value = 42\nprint(value)');
  assert.equal(original.cells[0].source, 'before = 1\nprint(before)');
});

test('known-length existing cell rewrite closes at the declared final chunk', () => {
  const buffer = new NotebookEditBuffer(fixture());
  buffer.stage(begin(buffer, 'x = ', { totalParts: 2 }));
  buffer.stage({ baseHash: buffer.currentHash, operations: [{ type: 'source_chunk', chunkId: 'rewrite', part: 1, totalParts: 2, source: '7' }], done: true });
  assert.equal(buffer.read().cells[0].source, 'x = 7'); assert.equal(buffer.done, true);
});

test('exact accepted batches including the final receipt retry without duplicated changes', () => {
  const buffer = new NotebookEditBuffer(fixture());
  const batch = { baseHash: buffer.currentHash, operations: [{ type: 'insert_cell', cellType: 'code', source: 'ready = True' }], done: true };
  const accepted = buffer.stage(batch), duplicate = buffer.stage(structuredClone(batch));
  assert.equal(duplicate.replayed, true); assert.equal(duplicate.revision, accepted.revision); assert.equal(duplicate.progress, accepted.progress);
  assert.equal(buffer.read().cells.length, 3); assert.equal(buffer.result().operations.length, 1);
});

test('exact chunk retry with the current hash does not advance revision or progress', () => {
  const buffer = new NotebookEditBuffer(fixture()), batch = begin(buffer);
  const first = buffer.stage(batch);
  const replay = buffer.stage({ ...batch, baseHash: buffer.currentHash });
  assert.equal(replay.replayed, true); assert.equal(replay.nextPart, 1); assert.equal(replay.revision, first.revision); assert.equal(replay.progress, first.progress);
  assert.throws(() => buffer.stage({ ...batch, operations: [{ ...batch.operations[0], source: 'conflicting' }] }), /重复内容不一致/);
  assert.equal(buffer.readPending().source, 'value = ');
});

test('completed source chunk receipts remain idempotent after the virtual notebook hash changes', () => {
  const buffer = new NotebookEditBuffer(fixture());
  const batch = begin(buffer, 'x = 1', { totalParts: 1 }); batch.done = true;
  const accepted = buffer.stage(batch);
  const repeated = buffer.stage({ ...batch, baseHash: buffer.currentHash });
  assert.equal(repeated.replayed, true); assert.equal(repeated.progress, accepted.progress); assert.equal(buffer.result().operations.length, 1);
});

test('partial source paging can inspect accepted chunks before they become a cell', () => {
  const buffer = new NotebookEditBuffer(fixture()); buffer.stage(begin(buffer, 'abcdefghij'));
  const page = buffer.readPending({ offset: 3, limit: 4 });
  assert.equal(page.source, 'defg'); assert.equal(page.totalLength, 10); assert.equal(page.nextOffset, 7); assert.equal(page.hasMore, true);
  assert.equal(page.operation.cellId, 'first'); assert.equal(page.pending, true);
  assert.throws(() => buffer.readPending({ offset: -1 }), /范围无效/);
  assert.throws(() => buffer.readPending({ limit: 12001 }), /范围无效/);
});

test('partial source reads strip image bytes and unsafe task sources are not archived', () => {
  const buffer = new NotebookEditBuffer(fixture()), image = 'Q'.repeat(900);
  buffer.stage(begin(buffer, `image = "data:image/png;base64,${image}"\nprint(1)`));
  const page = buffer.readPending();
  assert.equal(page.source.includes(image), false); assert.match(page.source, /image data omitted/);
  assert.equal(buffer.exportState(), null);
});

test('staged state persists text only and resumes a partially accepted rewrite with exact hashes', () => {
  const original = fixture(), image = 'Q'.repeat(900);
  original.cells[0].outputs = [{ output_type: 'display_data', metadata: { hidden: image }, data: { 'image/png': image, 'text/plain': 'visible result' } }];
  original.cells[1].attachments = { hidden: { 'image/png': image } };
  original.metadata.privateBinary = image;
  const buffer = new NotebookEditBuffer(original), first = begin(buffer); buffer.stage(first);
  const state = JSON.parse(JSON.stringify(buffer.exportState())), serialized = JSON.stringify(state);
  assert.equal(serialized.includes(image), false); assert.equal(serialized.includes('attachments'), false); assert.equal(serialized.includes('private metadata'), false);
  assert.equal(state.baseHash, notebookHash(original));
  const restored = NotebookEditBuffer.restore(state);
  assert.deepEqual(restored.status(), buffer.status()); assert.equal(restored.readPending().source, buffer.readPending().source);
  assert.equal(restored.stage(first).replayed, true);
  restored.stage({ baseHash: restored.currentHash, operations: [{ type: 'source_chunk', chunkId: 'rewrite', part: 1, source: '99', final: true }], done: true });
  assert.equal(validatePatch(original, restored.result()).notebook.cells[0].source, 'value = 99');
});

test('restoring inserted IDs is deterministic for complete operations and incomplete source chunks', () => {
  const buffer = new NotebookEditBuffer(fixture());
  buffer.stage({ baseHash: buffer.currentHash, operations: [{ type: 'insert_cell', cellType: 'markdown', source: '# New' }], done: false });
  const batch = { baseHash: buffer.currentHash, operations: [{ type: 'source_chunk', chunkId: 'new-code', part: 0, source: 'print(', operation: { type: 'insert_cell', cellType: 'code' } }], done: false };
  buffer.stage(batch);
  const restored = NotebookEditBuffer.restore(JSON.parse(JSON.stringify(buffer.exportState())));
  assert.equal(restored.read().cells[2].id, buffer.read().cells[2].id); assert.equal(restored.chunk.operation.cellId, buffer.chunk.operation.cellId);
  const finish = { baseHash: buffer.currentHash, operations: [{ type: 'source_chunk', chunkId: 'new-code', part: 1, source: '42)', final: true }], done: true };
  buffer.stage(finish); restored.stage(finish);
  assert.deepEqual(restored.result(), buffer.result()); assert.equal(restored.currentHash, buffer.currentHash);
});

test('completed tasks survive restart and do not replay duplicate insertions', () => {
  const buffer = new NotebookEditBuffer(fixture());
  const batch = { baseHash: buffer.currentHash, operations: [{ type: 'insert_cell', cellType: 'raw', source: 'finished' }], done: true };
  buffer.stage(batch);
  const restored = NotebookEditBuffer.restore(buffer.exportState());
  assert.equal(restored.done, true); assert.deepEqual(restored.result(), buffer.result());
  assert.equal(restored.stage(batch).replayed, true); assert.equal(restored.read().cells.length, 3);
});

test('a failed chunk batch leaves accepted state, receipts and checkpoint data untouched', () => {
  const buffer = new NotebookEditBuffer(fixture()); buffer.stage(begin(buffer));
  const before = buffer.exportState();
  assert.throws(() => buffer.stage({ baseHash: buffer.currentHash, operations: [{ type: 'source_chunk', chunkId: 'rewrite', part: 1, source: '3', final: true }, { type: 'delete_cell', cellId: 'missing' }], done: true }), /找不到/);
  assert.deepEqual(buffer.exportState(), before);
  buffer.stage({ baseHash: buffer.currentHash, operations: [{ type: 'source_chunk', chunkId: 'rewrite', part: 1, source: '4', final: true }], done: true });
  assert.equal(buffer.read().cells[0].source, 'value = 4');
});

test('task restore rejects corrupted hashes, batch content, ordering and invalid generated state', () => {
  const buffer = new NotebookEditBuffer(fixture()); buffer.stage(begin(buffer));
  const state = buffer.exportState();
  for (const mutate of [value => { value.currentHash = '0'.repeat(64); }, value => { value.batches[0].operations[0].source = 'corrupt'; }, value => { value.revision++; }, value => { value.baseNotebook.cells[0].source = 'corrupt'; }]) {
    const damaged = structuredClone(state); mutate(damaged); assert.throws(() => NotebookEditBuffer.restore(damaged), /无效|校验失败/);
  }
  const badPart = structuredClone(state); badPart.batches[0].operations[0].part = 2;
  const { stateHash: _hash, ...payload } = badPart; badPart.stateHash = hash(payload);
  assert.throws(() => NotebookEditBuffer.restore(badPart), /顺序或元数据/);
});

test('a base notebook with embedded source images disables persistence instead of silently changing its hash', () => {
  const original = fixture(); original.cells[0].source = `image = "data:image/png;base64,${'A'.repeat(900)}"`;
  const buffer = new NotebookEditBuffer(original);
  buffer.stage({ baseHash: buffer.currentHash, operations: [{ type: 'insert_cell', cellType: 'markdown', source: 'safe addition' }], done: false });
  assert.equal(buffer.exportState(), null); assert.equal(buffer.baseHash, notebookHash(original));
});

test('unknown chunk length requires explicit final and rejects changed totals or an early final', () => {
  const buffer = new NotebookEditBuffer(fixture()); buffer.stage(begin(buffer));
  assert.throws(() => buffer.stage({ baseHash: buffer.currentHash, operations: [], done: true }), /尚未收齐/);
  assert.throws(() => buffer.stage({ baseHash: buffer.currentHash, operations: [{ type: 'source_chunk', chunkId: 'rewrite', part: 1, totalParts: 2, source: '2' }], done: false }), /顺序或元数据/);
  const known = new NotebookEditBuffer(fixture()); known.stage(begin(known, 'x = ', { totalParts: 3 }));
  assert.throws(() => known.stage({ baseHash: known.currentHash, operations: [{ type: 'source_chunk', chunkId: 'rewrite', part: 1, totalParts: 3, final: true, source: '2' }], done: false }), /顺序或元数据/);
});

test('completed tasks remain verifiable for legacy notebooks without cell IDs', () => {
  const original = fixture(); original.nbformat_minor = 4; original.cells.forEach(cell => delete cell.id);
  const buffer = new NotebookEditBuffer(original);
  buffer.stage({ baseHash: buffer.currentHash, operations: [{ type: 'insert_cell', cellType: 'markdown', index: 1, source: '# Legacy' }], done: true });
  const restored = NotebookEditBuffer.restore(buffer.exportState());
  assert.deepEqual(restored.result(), buffer.result()); assert.equal(validatePatch(original, restored.result()).notebook.cells[1].source, '# Legacy');
});

test('metadata fingerprints survive task restart without persisting metadata contents', () => {
  const original = fixture(), image = 'Q'.repeat(900), secret = 'local-private-token-123';
  original.cells[0].metadata = { trusted: true, image, token: secret, tags: ['keep'] };
  const buffer = new NotebookEditBuffer(original);
  buffer.stage({ baseHash: buffer.currentHash, operations: [{ type: 'delete_cell', cellId: 'first' }], done: true });
  assert.equal(buffer.baseMetadataHashes[0], hash(original.cells[0].metadata));
  const state = buffer.exportState(), serialized = JSON.stringify(state);
  assert.equal(serialized.includes(image), false); assert.equal(serialized.includes(secret), false); assert.equal(serialized.includes('trusted'), false);
  assert.deepEqual(state.baseNotebook.cells[0].metadata, {});
  const restored = NotebookEditBuffer.restore(JSON.parse(serialized));
  assert.deepEqual(restored.baseMetadataHashes, buffer.baseMetadataHashes);
  assert.equal(restored.baseMetadataHashes[0], hash(original.cells[0].metadata));
  assert.notEqual(restored.baseMetadataHashes[0], hash({}));
  const exported = restored.exportState(); assert.equal(exported.stateHash, state.stateHash);
});

test('metadata fingerprint tampering or invalid fingerprint arrays reject checkpoint recovery', () => {
  const buffer = new NotebookEditBuffer(fixture()), state = buffer.exportState();
  const tampered = structuredClone(state); tampered.baseMetadataHashes[0] = '0'.repeat(64);
  assert.throws(() => NotebookEditBuffer.restore(tampered), /校验失败/);
  for (const invalid of [[], ['bad', state.baseMetadataHashes[1]], [null, state.baseMetadataHashes[1]], 'not-an-array']) {
    const damaged = structuredClone(state); damaged.baseMetadataHashes = invalid;
    const { stateHash: _hash, ...payload } = damaged; damaged.stateHash = hash(payload);
    assert.throws(() => NotebookEditBuffer.restore(damaged), /校验失败/);
  }
});

test('older task checkpoints without metadata fingerprints remain conservative after recovery', () => {
  const buffer = new NotebookEditBuffer(fixture()), state = buffer.exportState();
  delete state.baseMetadataHashes;
  const { stateHash: _hash, ...payload } = state; state.stateHash = hash(payload);
  const restored = NotebookEditBuffer.restore(state);
  assert.equal(restored.baseMetadataHashes, null);
  assert.equal(Object.hasOwn(restored.exportState(), 'baseMetadataHashes'), false);
  assert.equal(restored.exportState().stateHash, state.stateHash);
});

test('restored deletion uses metadata fingerprints to accept unchanged Jupyter metadata and reject manual changes', () => {
  const { rebaseNotebookPatch } = require('./src/notebook-merge');
  const original = fixture(); original.cells[0].metadata = { trusted: true, tags: ['important'] };
  const buffer = new NotebookEditBuffer(original);
  buffer.stage({ baseHash: buffer.currentHash, operations: [{ type: 'delete_cell', cellId: 'first' }], done: true });
  const restored = NotebookEditBuffer.restore(buffer.exportState());
  const rebased = rebaseNotebookPatch(restored.baseNotebook, original, restored.result(), { baseMetadataHashes: restored.baseMetadataHashes });
  assert.equal(validatePatch(original, rebased.patch).notebook.cells.length, 1);
  const manual = structuredClone(original); manual.cells[0].metadata.tags.push('manual-new-tag');
  assert.throws(() => rebaseNotebookPatch(restored.baseNotebook, manual, restored.result(), { baseMetadataHashes: restored.baseMetadataHashes }), error => error.code === 'NOTEBOOK_MERGE_CONFLICT' && error.conflicts[0].reason === 'deleted_cell_metadata_changed');
});

test('attachment fingerprints survive checkpoint recovery without persisting image bytes', () => {
  const { rebaseNotebookPatch } = require('./src/notebook-merge');
  const original = fixture(), image = 'Q'.repeat(900);
  original.cells[1].source = '![figure](attachment:figure.png)'; original.cells[1].attachments = { 'figure.png': { 'image/png': image } };
  const buffer = new NotebookEditBuffer(original);
  buffer.stage({ baseHash: buffer.currentHash, operations: [{ type: 'delete_cell', cellId: 'second' }], done: true });
  const state = buffer.exportState(), serialized = JSON.stringify(state);
  assert.equal(serialized.includes(image), false); assert.equal(serialized.includes('"attachments":'), false);
  assert.equal(state.baseAttachmentHashes[1], hash(original.cells[1].attachments));
  const restored = NotebookEditBuffer.restore(JSON.parse(serialized));
  assert.deepEqual(restored.baseAttachmentHashes, buffer.baseAttachmentHashes); assert.equal(restored.exportState().stateHash, state.stateHash);
  const options = { baseMetadataHashes: restored.baseMetadataHashes, baseAttachmentHashes: restored.baseAttachmentHashes };
  const allowed = rebaseNotebookPatch(restored.baseNotebook, original, restored.result(), options);
  assert.equal(validatePatch(original, allowed.patch).notebook.cells.length, 1);
  const current = structuredClone(original); current.cells[1].attachments['figure.png']['image/png'] = 'R'.repeat(900);
  assert.equal(notebookHash(current), notebookHash(original));
  assert.throws(() => rebaseNotebookPatch(restored.baseNotebook, current, restored.result(), options), error => error.code === 'NOTEBOOK_MERGE_CONFLICT' && error.conflicts[0].reason === 'deleted_cell_attachments_changed');
});

test('damaged attachment fingerprint lists cannot be restored as a trusted deletion baseline', () => {
  const state = new NotebookEditBuffer(fixture()).exportState();
  const changed = structuredClone(state); changed.baseAttachmentHashes[0] = '0'.repeat(64);
  assert.throws(() => NotebookEditBuffer.restore(changed), /校验失败/);
  for (const invalid of [null, [], ['bad', state.baseAttachmentHashes[1]], [state.baseAttachmentHashes[0]], ['A'.repeat(64), state.baseAttachmentHashes[1]]]) {
    const damaged = structuredClone(state); damaged.baseAttachmentHashes = invalid;
    const { stateHash: _hash, ...payload } = damaged; damaged.stateHash = hash(payload);
    assert.throws(() => NotebookEditBuffer.restore(damaged), /校验失败/);
  }
});

test('an older checkpoint without attachment fingerprints cannot authorize deleting a live attachment', () => {
  const { rebaseNotebookPatch } = require('./src/notebook-merge');
  const original = fixture(); original.cells[1].attachments = { 'figure.png': { 'image/png': 'AAAA' } };
  const buffer = new NotebookEditBuffer(original); buffer.stage({ baseHash: buffer.currentHash, operations: [{ type: 'delete_cell', cellId: 'second' }], done: true });
  const state = buffer.exportState(); delete state.baseAttachmentHashes;
  const { stateHash: _hash, ...payload } = state; state.stateHash = hash(payload);
  const restored = NotebookEditBuffer.restore(state);
  assert.equal(restored.baseAttachmentHashes, null); assert.equal(Object.hasOwn(restored.exportState(), 'baseAttachmentHashes'), false);
  assert.throws(() => rebaseNotebookPatch(restored.baseNotebook, original, restored.result(), { baseMetadataHashes: restored.baseMetadataHashes, baseAttachmentHashes: restored.baseAttachmentHashes }), error => error.conflicts[0].reason === 'deleted_cell_attachments_changed');
});

test('one virtual Notebook batch preserves ordered edits and a pending rewrite across checkpoint recovery', () => {
  const original = fixture(), buffer = new NotebookEditBuffer(original, { taskId: 'mixed-batch-task' });
  buffer.stage({ baseHash: buffer.currentHash, operations: [
    { type: 'insert_cell', index: 0, cellType: 'markdown', source: '# Generated introduction' },
    { type: 'replace_text', cellId: 'first', oldText: 'before = 1', newText: 'before = 2' },
    { type: 'delete_cell', cellId: 'second' },
    { type: 'source_chunk', chunkId: 'replace-first', part: 0, source: 'finished = ', operation: { type: 'set_source', cellId: 'first', sourceHash: hash('before = 2\nprint(before)') } }
  ], done: false });
  assert.equal(buffer.status().completedOperations, 3); assert.equal(buffer.status().pendingChunks, 1);
  assert.equal(buffer.read().cells[1].source, 'before = 2\nprint(before)');
  const state = buffer.exportState(), restored = NotebookEditBuffer.restore(state);
  assert.deepEqual(restored.exportState(), state); assert.equal(restored.readPending().source, 'finished = ');
  restored.stage({ baseHash: restored.currentHash, operations: [
    { type: 'source_chunk', chunkId: 'replace-first', part: 1, source: '42\nprint(finished)', final: true },
    { type: 'insert_cell', index: 2, cellType: 'raw', source: 'after code' }
  ], done: true });
  const final = validatePatch(original, restored.result()).notebook;
  assert.equal(final.cells.length, 3); assert.equal(final.cells[1].id, 'first'); assert.equal(final.cells[1].source, 'finished = 42\nprint(finished)');
  assert.equal(notebookHash(final), restored.currentHash); assert.deepEqual(NotebookEditBuffer.restore(restored.exportState()).result(), restored.result());
  assert.equal(original.cells[0].source, 'before = 1\nprint(before)');
});

test('a late failed operation in a multi-edit virtual batch cannot change a prior checkpoint or receipts', () => {
  const buffer = new NotebookEditBuffer(fixture(), { taskId: 'atomic-many-edits' });
  buffer.stage({ baseHash: buffer.currentHash, operations: [{ type: 'set_source', cellId: 'first', source: 'accepted = 1' }], done: false });
  const before = buffer.exportState(), notebook = buffer.read(), status = buffer.status();
  assert.throws(() => buffer.stage({ baseHash: buffer.currentHash, operations: [
    { type: 'insert_cell', index: 0, cellType: 'code', source: 'uncommitted = True' },
    { type: 'replace_text', cellId: 'first', oldText: 'accepted = 1', newText: 'uncommitted = 2' },
    { type: 'delete_cell', cellId: 'second', sourceHash: hash('wrong source') }
  ], done: true }), /源码哈希不匹配/);
  assert.deepEqual(buffer.exportState(), before); assert.deepEqual(buffer.read(), notebook); assert.deepEqual(buffer.status(), status);
});
