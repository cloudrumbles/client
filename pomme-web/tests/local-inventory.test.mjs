import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { LocalInventory } from '../src/local-inventory.js';
import { LocalInventorySession } from '../src/local-inventory-session.js';
import { InventoryRuntime } from '../authority/inventory.js';
import { nativeFixtures } from '../authority/tests/inventory-fixtures.js';
const registry = JSON.parse(await readFile(new URL('../data/1.21.11-registry.json', import.meta.url))), table = registry.blocks.find(block => block.name === 'crafting_table');
test('local crafting UI cannot announce a table whose native transaction was not admitted', async () => {
  const events = [], local = new LocalInventory({ registry, world: { core: { block_get: () => table.defaultState } } });
  local.authority = { state: { width: 2 } }; local.pendingCount = 127;
  local.session = { windowId: 0, state: { windowId: 0 }, menus: new Map(), accept() { events.push('accept'); } };
  local.gameplay = { event() { events.push('open'); } };
  await assert.rejects(local.useBlock(0, 0, 0), /busy/);
  assert.equal(local.session.windowId, 0); assert.equal(local.authority.state.width, 2); assert.deepEqual(events, []);
});
test('local creative and click admission return false without changing native inventory', () => {
  const local = new LocalInventory({ registry, world: {} }), session = local.session = new LocalInventorySession(local, registry, { fly: false });
  local.pendingCount = 127; const plank = registry.items.find(item => item.name === 'oak_planks');
  session.windows.set(0, { slots: [], cursor: { present: false } }); session.native = { cursor: { present: false } };
  assert.equal(session.setCreativeSlot(plank.id, 64), false); assert.equal(session.selectHotbar(1), false); assert.equal(session.clickWindow(1), false);
  assert.equal(session.state.selectedSlot, 0); assert.equal(local.pendingCount, 127);
});
test('local creative clone uses native component limits and retains component identity in WASM', async () => {
  const wasmBytes = await readFile(new URL('../authority/authority.wasm', import.meta.url));
  const plank = registry.items.find(item => item.name === 'oak_planks');
  for (const [fields, expected] of [
    [{ components: [{ type: 'minecraft:max_stack_size', data: 16 }] }, 16],
    [{ components: [{ type: 'max_stack_size', data: 7 }] }, 7],
    [{ removeComponents: ['max_stack_size'] }, 1],
    [{ removeComponents: ['minecraft:max_stack_size'], components: [{ type: 'max_stack_size', data: 16 }] }, 1],
  ]) {
    const local = new LocalInventory({ registry, world: {} });
    const runtime = await InventoryRuntime.create({ registry, data: nativeFixtures(registry), wasmBytes });
    runtime.setSlot('player', 0, { present: true, itemId: plank.id, itemCount: 1, ...fields });
    local.authority = { state: runtime.state(), setSlot(...args) { runtime.setSlot(...args); this.state = runtime.state(); } };
    const session = local.session = new LocalInventorySession(local, registry, { fly: false }); session.accept(local.authority.state);
    assert.equal(session.clickWindow(36, { mode: 3 }), true); await local.pending;
    assert.equal(local.authority.state.cursor.itemCount, expected);
    const { itemCount: _cursorCount, ...cursorIdentity } = local.authority.state.cursor;
    const { itemCount: _sourceCount, ...sourceIdentity } = local.authority.state.player[0];
    assert.deepEqual(cursorIdentity, sourceIdentity); assert.equal(local.authority.state.player[0].itemCount, 1);
    runtime.click('player', 0);
    assert.equal(runtime.state().player[0].itemCount, expected, 'A later native merge is limited by the same cloned component limit.');
    assert.equal(runtime.state().cursor.itemCount, 1);
  }
});
