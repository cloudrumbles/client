import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import minecraftData from 'minecraft-data';
import minecraftProtocol from 'minecraft-protocol';
import { installNativeCodecs } from '../scripts/native-codec.mjs';
import { ProtocolAdapter } from '../src/protocol-compat.js';
import { bundleView } from '../src/inventory-prediction.js';
import { BundleWheel, nextBundleSelection } from '../src/container-ui.js';

installNativeCodecs('26.1');

export function bundleFixture(version) {
  const data = minecraftData(version), adapter = new ProtocolAdapter(version, { items: data.itemsArray });
  const definitions = new Map(data.itemsArray.map(item => [item.id, item]));
  const stack = (name, itemCount = 1, components = [], removeComponents = []) => ({ itemId: data.itemsByName[name].id, itemCount, addedComponentCount: components.length, removedComponentCount: removeComponents.length, components, removeComponents });
  const component = contents => ({ type: 'bundle_contents', data: { contents } });
  const cases = {
    empty: [], stone1: [stack('stone')], stone12: [stack('stone', 12)], stone64: [stack('stone', 64)],
    stone12dirt3: [stack('stone', 12), stack('dirt', 3)],
    varint_boundary: [stack('waxed_exposed_cut_copper_stairs'), stack('waxed_weathered_cut_copper_stairs', 99)],
    stone98max99: [stack('stone', 98, [{ type: 'max_stack_size', data: 99 }])],
    nested: [stack('bundle', 1, [component([stack('stone', 8)])]), stack('dirt', 52)],
    removed_damage: [stack('diamond_pickaxe', 1, [], [{ type: 'damage' }])],
  };
  const bundle = contents => adapter.normalizeSlot(stack('bundle', 1, contents.length ? [component(contents)] : []));
  return { data, adapter, definitions, stack, component, cases, bundle };
}

for (const version of ['1.21.11', '26.1']) {
  const official = JSON.parse(await readFile(new URL(`./fixtures/native-bundle/${version}.json`, import.meta.url)));
  const { adapter, component, cases } = bundleFixture(version);
  const proto = minecraftProtocol.createSerializer({ version, state: 'play', isServer: true }).proto;
  for (const [name, expected] of Object.entries(official.cases)) {
    test(`${version} ${name} hash and codec match official Java bytes with exact consumption`, () => {
      assert.equal(adapter.componentHash(component(cases[name])), expected.hash);
      const bytes = Buffer.concat([Buffer.from([adapter.bundleComponentId]), Buffer.from(expected.wire, 'hex'), Buffer.from([0x55, 0x66])]);
      const decoded = proto.read(bytes, 0, 'SlotComponent');
      assert.equal(decoded.size, bytes.length - 2, 'the next field must remain unconsumed');
      assert.equal(bytes[decoded.size], 0x55);
      assert.deepEqual(decoded.value, component(cases[name]));
      assert.deepEqual(proto.createPacketBuffer('SlotComponent', decoded.value), bytes.subarray(0, decoded.size));
      assert.equal(adapter.componentHash(decoded.value), expected.hash);
    });
  }
  test(`${version} native empty bundle prototype produces no added patch and nested templates normalize`, () => {
    const { stack } = bundleFixture(version);
    const empty = adapter.normalizeSlot(stack('bundle', 1, [component([])]));
    assert.deepEqual(adapter.hashedSlot(empty).components, []);
    assert.equal(empty.addedComponentCount, 0);
    const nested = adapter.normalizeSlot(stack('bundle', 1, [component(cases.nested)]));
    assert.equal(nested.components[0].data.contents[0].present, true);
    assert.equal(nested.components[0].data.contents[0].components[0].data.contents[0].present, true);
  });
  if (version === '26.1') for (const expected of official.invalid) test(`26.1 invalid ${expected.wire} matches native consumption before rejection`, () => {
    const bytes = Buffer.concat([Buffer.from([adapter.bundleComponentId]), Buffer.from(expected.wire, 'hex'), Buffer.from([expected.sentinel])]);
    const decoded = proto.read(bytes, 0, 'SlotComponent');
    assert.equal(decoded.size, 1 + expected.consumed);
    assert.equal(bytes[decoded.size], expected.sentinel);
    assert.throws(() => adapter.normalizeSlot({ itemId: 1037, itemCount: 1, components: [decoded.value] }), /must be non-empty/);
  });
  test(`${version} native tooltip shows aligned visible entries, counts hidden units and respects component hiding`, () => {
    const { bundle, stack, definitions } = bundleFixture(version);
    for (let count = 0; count < 17; count++) {
      const view = bundleView(bundle(Array.from({ length: count }, () => stack('stone', 2))), definitions);
      assert.equal(view.shown, [0,1,2,3,4,5,6,7,8,9,10,11,12,8,9,10,11][count]);
      assert.deepEqual(view.cells.filter(cell => cell?.stack).map(cell => cell.index), Array.from({ length: view.shown }, (_, i) => i));
      assert.equal(view.hiddenCount, (count - view.shown) * 2);
    }
    const full = bundleView(bundle(cases.stone64), definitions);
    assert.equal(full.full, true); assert.equal(full.fill, 94);
    const hidden = bundle(cases.stone12);
    hidden.components.push({ type: 'tooltip_display', data: { hideTooltip: false, hiddenComponents: [adapter.bundleComponentId] } });
    assert.equal(bundleView(hidden, definitions, { componentId: adapter.bundleComponentId }).tooltipVisible, false);
    hidden.components[1].data.hiddenComponents = [adapter.bundleComponentId + 1];
    assert.equal(bundleView(hidden, definitions, { componentId: adapter.bundleComponentId }).tooltipVisible, true);
  });
}

test('native bundle wheel accumulates fractions, resets changed direction, chooses one item per event and wraps', () => {
  const wheel = new BundleWheel();
  assert.equal(wheel.step(0, .6), 0); assert.equal(wheel.step(0, -.6), 0); assert.equal(wheel.step(0, -.6), -1);
  assert.equal(nextBundleSelection(10, -1, 8), 7);
  assert.equal(nextBundleSelection(-10, -1, 8), 0);
  assert.equal(nextBundleSelection(-1, 7, 8), 0);
  assert.equal(nextBundleSelection(1, 0, 8), 7);
  assert.equal(wheel.step(2, 0), -2);
});
