import test from 'node:test';
import assert from 'node:assert/strict';
import { AuthorityWorldBridge } from '../bridge.js';
import { BrowserAuthority } from '../client.js';

test('authority admits large sources in bounded batches without retaining columns', async () => {
  const bridge = new AuthorityWorldBridge({}, 1024, () => {}), sizes = [];
  bridge.authority = { async loadColumns(columns) { sizes.push(columns.reduce((sum, column) => sum + column.sections.length, 0)); } };
  const blocks = new Uint16Array(4096), columns = Array.from({ length: 256 }, (_, x) => ({ x, z: 0, sections: Array.from({ length: 24 }, (_, sectionY) => ({ sectionY, blocks })) }));
  await bridge.admit(columns);
  assert.equal(bridge.keys.size, 1024); assert.ok(sizes.every(size => size <= 32)); assert.equal(sizes.reduce((sum, size) => sum + size, 0), 1024);
  assert.equal(bridge.covers(0, 0, 0), true); assert.equal(bridge.covers(255 * 16, 0, 0), false);
  assert.deepEqual(await bridge.setBlock(255 * 16, 0, 0, 1), { handled: false, events: [] }); assert.equal(await bridge.useBlock(255 * 16, 0, 0), false);
});
test('incremental bridge import queries one column and preserves overlays on save failure', async () => {
  const blocks = new Uint16Array(4096), column = { x: 0, z: 0, sections: [{ sectionY: 0, blocks }] }, edits = new Map([['2,1,2', [2, 1, 2, 1]]]);
  let ingested = false, queries = 0, saved = 0;
  const world = { columns: new Map([['0,0', column]]), overlays: new Map([['0,0', edits]]), ingestColumn() { ingested = true; } };
  const bridge = new AuthorityWorldBridge(world, 1024, () => {}); bridge.keys.add('0,0,0'); bridge.trackSource(column);
  bridge.authority = { async save() { throw new Error('IndexedDB quota exceeded.'); }, async column() { queries++; return column; }, async columns() { throw new Error('Full authority export is forbidden for incremental imports.'); } };
  await assert.rejects(bridge.loadColumn(column), /quota/); assert.equal(ingested, false); assert.equal(edits.size, 1); assert.equal(queries, 0);
  bridge.authority.save = async () => { saved++; };
  await bridge.loadColumn(column); assert.equal(saved, 1); assert.equal(queries, 1); assert.equal(ingested, true); assert.equal(edits.size, 0);
});
test('bootstrap aborts stale work after every async stage without later world writes', async () => {
  const original = BrowserAuthority.open;
  try {
    for (const phase of ['open', 'sections', 'load', 'save', 'columns', 'start']) {
      let current = true, writesAfterChange = 0, closes = 0;
      const blocks = new Uint16Array(4096), column = { x: 0, z: 0, sections: [{ sectionY: 0, blocks }] };
      const flip = stage => { if (stage === phase) current = false; };
      const world = { columns: new Map(), overlays: new Map(), ingestColumn() { if (!current) writesAfterChange++; }, setBlock() { if (!current) writesAfterChange++; } };
      BrowserAuthority.open = async () => {
        flip('open');
        return { async sections() { flip('sections'); return []; }, async loadColumns() { flip('load'); }, async save() { flip('save'); }, async columns() { flip('columns'); return [column]; }, async start() { flip('start'); }, async close(options) { assert.equal(options.save, false); closes++; } };
      };
      await assert.rejects(AuthorityWorldBridge.open({ world, registry: {}, worldKey: phase, columns: [column], autoTick: true, isCurrent: () => current }), error => error.name === 'AbortError' && error.code === 'AUTHORITY_STALE_WORLD');
      assert.equal(writesAfterChange, 0, phase); assert.equal(closes, 1, phase);
    }
  } finally { BrowserAuthority.open = original; }
});
test('incremental stale column replies cannot retire overlays or replace a reset world', async () => {
  let current = true, resolveColumn, mutations = 0;
  const blocks = new Uint16Array(4096), column = { x: 0, z: 0, sections: [{ sectionY: 0, blocks }] }, edits = new Map([['2,1,2', [2, 1, 2, 1]]]);
  const world = { columns: new Map([['0,0', column]]), overlays: new Map([['0,0', edits]]), ingestColumn() { mutations++; } };
  const bridge = new AuthorityWorldBridge(world, 1024, () => {}, () => current); bridge.keys.add('0,0,0'); bridge.trackSource(column);
  bridge.authority = { async save() {}, column() { return new Promise(resolve => { resolveColumn = resolve; }); }, async close(options) { assert.equal(options.save, false); } };
  const pending = bridge.loadColumn(column); await new Promise(resolve => setImmediate(resolve)); current = false; resolveColumn(column);
  await assert.rejects(pending, error => error.code === 'AUTHORITY_STALE_WORLD'); assert.equal(mutations, 0); assert.equal(edits.size, 1);
  assert.equal(bridge.closed, true);
});
test('retirement callback invalidation stops the following mirror and light writes', () => {
  let current = true, writes = 0;
  const blocks = new Uint16Array(4096), column = { x: 0, z: 0, sections: [{ sectionY: 0, blocks }] }, world = { overlays: new Map([['0,0', new Map([['2,1,2', [2, 1, 2, 1]]])]]), ingestColumn() { writes++; }, dirtyLighting() { writes++; } };
  const bridge = new AuthorityWorldBridge(world, 1024, () => { current = false; }, () => current); bridge.keys.add('0,0,0');
  assert.throws(() => bridge.mergeColumn(column, column, { retireOverlays: true }), error => error.code === 'AUTHORITY_STALE_WORLD'); assert.equal(writes, 0);
});
