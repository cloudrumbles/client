import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { AuthorityRuntime, authorityStateDefinitions } from '../runtime.js';
import { registryStates } from '../../src/anvil.js';
const wasmBytes = await readFile(new URL('../authority.wasm', import.meta.url));
for (const version of ['1.20.4', '1.21.11', '26.1']) {
  const registry = JSON.parse(await readFile(new URL(`../../data/${version}-registry.json`, import.meta.url))), native = registryStates(registry);
  test(`browser authority uses exact native ${version} IDs and button delays`, async () => {
    const runtime = await AuthorityRuntime.create({ registry, wasmBytes }), stone = registry.blocks.find(block => block.name === 'stone').defaultState;
    const lamp = native.lookup('redstone_lamp', { lit: 'false' }), lit = native.lookup('redstone_lamp', { lit: 'true' });
    const off = native.lookup('polished_blackstone_button', { face: 'floor', facing: 'north', powered: 'false' }), on = native.lookup('polished_blackstone_button', { face: 'floor', facing: 'north', powered: 'true' });
    assert.ok(Number.isInteger(off));
    const blocks = new Uint16Array(4096); blocks.fill(stone, 0, 256); runtime.loadSection(0, 0, 0, blocks);
    runtime.setBlock(2, 1, 2, off); runtime.setBlock(3, 1, 2, lamp); runtime.useBlock(2, 1, 2);
    assert.equal(runtime.blockAt(2, 1, 2), on); assert.equal(runtime.blockAt(3, 1, 2), lit);
    runtime.step(19); assert.equal(runtime.blockAt(2, 1, 2), on); runtime.step(); assert.equal(runtime.blockAt(2, 1, 2), off);
    runtime.step(3); assert.equal(runtime.blockAt(3, 1, 2), lit); runtime.step(); assert.equal(runtime.blockAt(3, 1, 2), lamp);
    const snapshot = runtime.snapshot(), restored = await AuthorityRuntime.create({ registry, wasmBytes }); restored.restore(snapshot);
    assert.deepEqual(restored.state(), runtime.state()); assert.deepEqual(restored.sections(), runtime.sections());
    assert.deepEqual(restored.column(0, 0).sections, runtime.sections().map(({ sectionY, blocks }) => ({ sectionY, blocks })));
    assert.deepEqual(restored.column(40, 40).sections, []);
    assert.ok(authorityStateDefinitions(registry).length > 26000);
    assert.throws(() => runtime.setBlock(2.5, 1, 2, stone), /coordinates/); assert.throws(() => runtime.setBlock(2, 1, 2, -1), /native unsigned/);
    assert.throws(() => runtime.restore({ ...snapshot, version: 'unknown' }), /different native/);
    runtime.events(); runtime.step(100); assert.deepEqual(runtime.events(), []);
  });
}
