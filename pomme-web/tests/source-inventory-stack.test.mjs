import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { planSourceInventoryStack } from '../src/source-inventory-stack.js';
const compound = value => ({ type: 10, value }), text = value => ({ type: 8, value }), byte = value => ({ type: 1, value }), int = value => ({ type: 3, value });
for (const version of ['1.20.4', '1.21.11']) {
  const registry = JSON.parse(await readFile(new URL(`../data/${version}-registry.json`, import.meta.url)));
  test(`typed source ${version} ItemStack conversion reuses native inventory codecs and preserves original record`, () => {
    const legacy = version === '1.20.4', record = compound({ id: text('minecraft:oak_planks'), [legacy ? 'Count' : 'count']: legacy ? byte(3) : int(3), ...(legacy ? { tag: compound({ exact: { type: 4, value: 7n } }) } : { components: compound({ max_stack_size: int(16) }) }) }), before = structuredClone(record);
    const result = planSourceInventoryStack(record, { registry }); assert.equal(result.ready, true); assert.equal(result.stack.itemCount, 3); assert.equal(result.stack.itemId, registry.items.find(item => item.name === 'oak_planks').id);
    if (legacy) assert.equal(result.stack.nbtData.value.exact.value, 7n); else assert.deepEqual(result.stack.components, [{ type: 'minecraft:max_stack_size', data: 16 }]);
    assert.deepEqual(result.source, before); assert.deepEqual(record, before);
    assert.equal(planSourceInventoryStack(record, { registry, dataVersion: -1 }).ready, false);
    const invalid = planSourceInventoryStack(compound({ id: text('minecraft:no_such_source_item') }), { registry }); assert.equal(invalid.stack.present, false); assert.ok(invalid.diagnostics.length);
  });
}
test('typed source item decoding defers unknown modern save codecs without interpreting their payload', async () => {
  const registry = JSON.parse(await readFile(new URL('../data/1.21.11-registry.json', import.meta.url))), record = compound({ id: text('minecraft:oak_planks'), count: int(1), components: compound({ custom_data: compound({ value: { type: 4, value: 7n } }) }) });
  const plan = planSourceInventoryStack(record, { registry }); assert.equal(plan.ready, false); assert.equal(plan.stack.components, undefined); assert.equal(plan.deferred[0].component.value.value.value.value, 7n); assert.deepEqual(plan.source, record);
});
