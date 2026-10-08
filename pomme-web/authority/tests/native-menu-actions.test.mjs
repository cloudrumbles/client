import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { InventoryRuntime } from '../inventory.js';
import { nativeFixtures } from './inventory-fixtures.js';
import { nativeMenuActionFixtures, resolveNativeMenuFixture } from './native-menu-action-fixtures.js';
const wasmBytes = await readFile(process.env.POMME_INVENTORY_WASM ?? new URL('../authority.wasm', import.meta.url));
const present = stack => stack?.present && stack.itemCount > 0;
function slots(state) {
  const result = Array.from({ length: 46 }, () => ({ present: false })); result[0] = state.result;
  if (state.width === 2) {
    state.grid.forEach((stack, index) => result[index + 1] = stack);
    for (let index = 5; index <= 8; index++) result[index] = state.player[44 - index];
    for (let index = 9; index <= 35; index++) result[index] = state.player[index];
    for (let index = 0; index < 9; index++) result[index + 36] = state.player[index]; result[45] = state.player[40];
  } else {
    state.grid.forEach((stack, index) => result[index + 1] = stack);
    for (let index = 9; index <= 35; index++) result[index + 1] = state.player[index];
    for (let index = 0; index < 9; index++) result[index + 37] = state.player[index];
  }
  return result;
}
function seed(runtime, fixture) {
  for (const [indexText, stack] of Object.entries(fixture.slots)) {
    const index = Number(indexText), width = fixture.width;
    if (index === 0) continue;
    if (index <= width * width) runtime.setSlot('grid', index - 1, stack);
    else if (width === 2) runtime.setSlot('player', index >= 36 && index < 45 ? index - 36 : index === 45 ? 40 : index >= 5 && index <= 8 ? 44 - index : index, stack);
    else runtime.setSlot('player', index >= 37 ? index - 37 : index - 1, stack);
  }
  runtime.setSlot('cursor', 0, fixture.cursor); if (present(fixture.offhand)) runtime.setSlot('player', 40, fixture.offhand);
}
for (const version of ['1.20.4', '1.21.11']) {
  const registry = JSON.parse(await readFile(new URL(`../../data/${version}-registry.json`, import.meta.url)));
  test(`native ${version} source-derived menu click acceptance vectors run in actual WASM`, async () => {
    let checked = 0;
    for (const raw of nativeMenuActionFixtures.filter(fixture => !fixture.versions || fixture.versions.includes(version))) {
      const fixture = resolveNativeMenuFixture(raw, registry), runtime = await InventoryRuntime.create({ registry, data: nativeFixtures(registry), wasmBytes, width: fixture.width }); seed(runtime, fixture);
      for (const input of fixture.clicks) runtime.menuClick(input.slot, { ...input, creative: true, allowDrops: true });
      const state = runtime.state(), menu = slots(state);
      for (const [index, expected] of Object.entries(fixture.expected.slots)) assert.deepEqual(menu[index], expected, `${fixture.name}: slot${index}`);
      for (const [field, value] of Object.entries(fixture.expected)) {
        if (field === 'cursor' || field === 'drops') assert.deepEqual(state[field], value, `${fixture.name}: ${field}`);
        if (field === 'offhand') assert.deepEqual(state.player[40], value, `${fixture.name}: offhand`);
      }
      checked++;
    }
    assert.ok(checked >= 34);
  });
  test(`native ${version} equipment routing and bounded drop gating preserve entire state`, async () => {
    const runtime = await InventoryRuntime.create({ registry, data: nativeFixtures(registry), wasmBytes });
    const stack = (name, count = 1, fields = {}) => ({ present: true, itemId: registry.items.find(item => item.name === name).id, itemCount: count, ...fields });
    runtime.setSlot('player', 9, stack('diamond_helmet')); runtime.menuClick(9, { mode: 1 });
    assert.equal(runtime.state().player[39].itemId, stack('diamond_helmet').itemId); assert.equal(runtime.state().player[9].present, false);
    runtime.setSlot('player', 9, stack('shield')); runtime.menuClick(9, { mode: 1 }); assert.equal(runtime.state().player[40].itemId, stack('shield').itemId);
    runtime.menuClick(5); assert.equal(runtime.state().cursor.itemId, stack('diamond_helmet').itemId);
    runtime.menuClick(9); runtime.setSlot('cursor', 0, stack('stone')); runtime.menuClick(5); assert.equal(runtime.state().player[39].present, false, 'An ordinary nonempty slot cannot place the wrong item into armor.');
    const before = runtime.snapshot(); assert.throws(() => runtime.menuClick(-999), /drop authority/); assert.deepEqual(runtime.snapshot(), before);
    for (let index = 0; index < 64; index++) { runtime.setSlot('cursor', 0, stack('oak_planks')); runtime.menuClick(-999, { allowDrops: true }); }
    runtime.setSlot('cursor', 0, stack('stone')); const full = runtime.snapshot(); assert.throws(() => runtime.menuClick(-999, { allowDrops: true }), /drop queue limit/); assert.deepEqual(runtime.snapshot(), full);
    const reopen = await InventoryRuntime.create({ registry, data: nativeFixtures(registry), wasmBytes }); reopen.restore(full); assert.deepEqual(reopen.state(), runtime.state());
  });
}
