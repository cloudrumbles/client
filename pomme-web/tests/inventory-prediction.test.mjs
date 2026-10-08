import { test } from 'node:test';
import assert from 'node:assert/strict';
import minecraftProtocol from 'minecraft-protocol';
import minecraftData from 'minecraft-data';
import { MinecraftSession } from '../src/minecraft.js';
import { bundleContents, bundleCapacity, matchesCraftingRecipe, sameStack, stackable } from '../src/inventory-prediction.js';
import { installNativeCodecs } from '../scripts/native-codec.mjs';

installNativeCodecs('26.1');

function fixture(version) {
  const data = minecraftData(version), modern = version !== '1.20.4', events = [], sent = [];
  const input = minecraftProtocol.createSerializer({ version, state: 'play', isServer: true }), reader = minecraftProtocol.createDeserializer({ version, state: 'play', isServer: false });
  const output = minecraftProtocol.createSerializer({ version, state: 'play', isServer: false }), outputReader = minecraftProtocol.createDeserializer({ version, state: 'play', isServer: true });
  const session = new MinecraftSession({ registry: { version: data.version, items: data.itemsArray }, onEvent: event => events.push(event), transport: { packet(name, params) { sent.push(outputReader.parsePacketBuffer(output.createPacketBuffer({ name, params })).data); return true; }, close() {} } });
  const receive = (name, params) => { const packet = reader.parsePacketBuffer(input.createPacketBuffer({ name, params })).data; session.receive({ type: 'packet', name: packet.name, data: packet.params }); assert.equal(events.find(event => event.type === 'error'), undefined); };
  const stack = (name, itemCount = 1, extra = {}) => ({ present: true, itemId: data.itemsByName[name].id, itemCount, ...(modern ? { addedComponentCount: 0, removedComponentCount: 0, components: [], removeComponents: [] } : {}), ...extra });
  const content = (entries, cursor = { present: false }, windowId = 0, length = windowId ? 46 : 46) => receive('window_items', { windowId, stateId: 4, items: Array.from({ length }, (_, index) => session.adapter.protocolSlot(entries[index] || { present: false })), carriedItem: session.adapter.protocolSlot(cursor) });
  const bundle = (items = [], extra = {}) => {
    if (modern) return stack('bundle', 1, { components: [{ type: 'bundle_contents', data: { contents: items.map(item => session.adapter.protocolSlot(item)) } }], addedComponentCount: 1, ...extra });
    const nbtItem = item => ({ id: { type: 'string', value: `minecraft:${data.items[item.itemId].name}` }, Count: { type: 'byte', value: item.itemCount }, ...(item.nbtData ? { tag: item.nbtData } : {}) });
    return stack('bundle', 1, { nbtData: { type: 'compound', name: '', value: { Items: { type: 'list', value: { type: 'compound', value: items.map(nbtItem) } } } }, ...extra });
  };
  const shapeless = (ingredients, result) => ({ recipeId: `minecraft:fixture_${ingredients.join('_')}`, type: 'minecraft:crafting_shapeless', data: { group: '', category: 0, ingredients: ingredients.map(name => [stack(name)]), result } });
  return { data, modern, session, receive, stack, content, bundle, sent, shapeless };
}

for (const version of ['1.20.4', '1.21.11', '26.1']) {
  test(`${version} result pickup/throw/hotbar swap predict grid consumption and preserve authoritative output revisions`, () => {
    const { session, receive, content, stack, sent, shapeless, modern } = fixture(version);
    if (!modern) receive('declare_recipes', { recipes: [shapeless(['oak_log'], stack('oak_planks', 4))] });
    content({ 0: stack('oak_planks', 4), 1: stack('oak_log', 3) });
    session.clickWindow(0, { button: 1 });
    assert.equal(session.windows.get(0).cursor.itemCount, 2, 'native secondary result pickup takes half, then calls onTake');
    assert.equal(session.windows.get(0).slots[0].itemCount, 2); assert.equal(session.windows.get(0).slots[1].itemCount, 2);
    assert.equal(session.windows.get(0).stateId, 4); assert.deepEqual(sent.at(-1).params.changedSlots.map(value => value.location), [0, 1]);
    content({ 0: stack('oak_planks', 4), 1: stack('oak_log', 3) }); session.clickWindow(0, { mode: 4, button: 0 });
    assert.equal(session.windows.get(0).slots[0].itemCount, 3); assert.equal(session.windows.get(0).slots[1].itemCount, 2);
    content({ 0: stack('oak_planks', 4), 1: stack('oak_log', 3) }); session.clickWindow(0, { mode: 2, button: 0 });
    assert.equal(session.windows.get(0).slots[36].itemCount, 4); assert.equal(session.windows.get(0).slots[1].itemCount, 2);
    receive('set_slot', { windowId: 0, stateId: 5, slot: 0, item: session.adapter.protocolSlot(stack('oak_planks', 4)) });
    assert.equal(session.windows.get(0).stateId, 5); assert.equal(session.windows.get(0).slots[0].itemCount, 4, 'only server updates recompute outputs');
  });

  test(`${version} quick-moving a partially transferable result consumes once and clears dropped surplus`, () => {
    const { session, receive, content, stack, shapeless, modern } = fixture(version);
    if (!modern) receive('declare_recipes', { recipes: [shapeless(['oak_log'], stack('oak_planks', 4))] });
    const filled = Object.fromEntries(Array.from({ length: 36 }, (_, index) => [index + 9, stack('stone', 64)])); filled[44] = stack('oak_planks', 62);
    content({ ...filled, 0: stack('oak_planks', 4), 1: stack('oak_log', 3) }); session.clickWindow(0, { mode: 1 });
    assert.equal(session.windows.get(0).slots[44].itemCount, 64); assert.equal(session.windows.get(0).slots[0].present, false); assert.equal(session.windows.get(0).slots[1].itemCount, 2);
    content({ ...filled, 44: stack('oak_planks', 64), 0: stack('oak_planks', 4), 1: stack('oak_log', 3) }); session.clickWindow(0, { mode: 1 });
    assert.equal(session.windows.get(0).slots[1].itemCount, 3, 'blocked quick move does not craft');
  });

  test(`${version} native milk/honey/breath remainders replace grid cells or merge into selected hotbar before offhand`, () => {
    const { session, receive, content, stack, shapeless, modern } = fixture(version);
    if (!modern) receive('declare_recipes', { recipes: [shapeless(['milk_bucket'], stack('cake')), shapeless(['honey_bottle'], stack('sugar', 3)), shapeless(['dragon_breath'], stack('stone'))] });
    content({ 0: stack('cake'), 1: stack('milk_bucket') }); session.clickWindow(0);
    assert.equal(session.windows.get(0).slots[1].itemId, session.itemDefinitions.values().find(item => item.name === 'bucket').id);
    content({ 0: stack('sugar', 3), 1: stack('honey_bottle', 2), 9: stack('glass_bottle', 20), 36: stack('glass_bottle', 60), 45: stack('glass_bottle', 40) }); session.clickWindow(0);
    assert.equal(session.windows.get(0).slots[1].itemCount, 1); assert.equal(session.windows.get(0).slots[36].itemCount, 61); assert.equal(session.windows.get(0).slots[9].itemCount, 20);
    content({ 0: stack('sugar', 3), 1: stack('honey_bottle', 2), 9: stack('glass_bottle', 20), 36: stack('glass_bottle', 64), 45: stack('glass_bottle', 40) }); session.clickWindow(0);
    assert.equal(session.windows.get(0).slots[45].itemCount, 41); assert.equal(session.windows.get(0).slots[9].itemCount, 20);
  });

  test(`${version} bundle cursor inserts with native button and full capacity, then removes a complete stack`, () => {
    const { session, content, stack, bundle, modern, data } = fixture(version);
    content({ 9: stack('stone', 70) }, bundle()); session.clickWindow(9, { button: modern ? 0 : 1 });
    const window = session.windows.get(0), contents = bundleContents(window.cursor, session.itemDefinitions, modern);
    assert.deepEqual(contents.map(item => [item.itemId, item.itemCount]), [[data.itemsByName.stone.id, 64]]); assert.equal(window.slots[9].itemCount, 6);
    session.clickWindow(10, { button: 1 }); assert.equal(window.slots[10].itemCount, 64); assert.equal(bundleContents(window.cursor, session.itemDefinitions, modern).length, 0);
    content({ 9: bundle([stack('stone', 12)]) }); session.clickWindow(9, { button: 1 });
    assert.equal(session.windows.get(0).cursor.itemCount, 12); assert.equal(session.windows.get(0).cursor.itemId, data.itemsByName.stone.id);
    assert.equal(bundleContents(session.windows.get(0).slots[9], session.itemDefinitions, modern).length, 0);
  });

  test(`${version} bundle merge moves matching stacks to the front and preserves damage/NBT separation`, () => {
    const { session, content, stack, bundle, modern, data } = fixture(version);
    const tagged = modern ? stack('stone', 2, { components: [{ type: 'damage', data: 1 }], addedComponentCount: 1 }) : stack('stone', 2, { nbtData: { type: 'compound', name: '', value: { Damage: { type: 'int', value: 1 } } } });
    content({ 9: bundle([stack('dirt', 5), stack('stone', 10), tagged]) }, stack('stone', 3)); session.clickWindow(9, { button: modern ? 0 : 1 });
    const contents = bundleContents(session.windows.get(0).slots[9], session.itemDefinitions, modern);
    assert.deepEqual(contents.map(item => [item.itemId, item.itemCount]), [[data.itemsByName.stone.id, 13], [data.itemsByName.dirt.id, 5], [data.itemsByName.stone.id, 2]]);
    assert.equal(sameStack(contents[0], contents[2]), false); assert.equal(session.windows.get(0).cursor.present, false);
  });

  test(`${version} nested bundles cost four units and shulker boxes cannot enter`, () => {
    const { session, content, stack, bundle, modern } = fixture(version);
    content({ 9: bundle([stack('stone', 8)]) }, bundle([stack('dirt', 52)])); session.clickWindow(9, { button: modern ? 0 : 1 });
    const items = bundleContents(session.windows.get(0).cursor, session.itemDefinitions, modern);
    assert.equal(items.length, 2); assert.equal(bundleContents(items[0], session.itemDefinitions, modern)[0].itemCount, 8);
    assert.equal(session.windows.get(0).slots[9].present, false);
    content({ 9: stack('shulker_box') }, bundle()); session.clickWindow(9, { button: modern ? 0 : 1 });
    assert.equal(session.windows.get(0).slots[9].itemCount, 1); assert.equal(bundleContents(session.windows.get(0).cursor, session.itemDefinitions, modern).length, 0);
  });

  test(`${version} bundle transfer from a crafting result requires room for the complete output and consumes its grid`, () => {
    const { session, receive, content, stack, bundle, shapeless, modern } = fixture(version);
    if (!modern) receive('declare_recipes', { recipes: [shapeless(['oak_log'], stack('oak_planks', 4))] });
    content({ 0: stack('oak_planks', 4), 1: stack('oak_log', 2) }, bundle([stack('stone', 62)])); session.clickWindow(0, { button: modern ? 0 : 1 });
    assert.equal(session.windows.get(0).slots[0].itemCount, 4); assert.equal(session.windows.get(0).slots[1].itemCount, 2);
    content({ 0: stack('oak_planks', 4), 1: stack('oak_log', 2) }, bundle([stack('stone', 60)])); session.clickWindow(0, { button: modern ? 0 : 1 });
    assert.equal(session.windows.get(0).slots[0].present, false); assert.equal(session.windows.get(0).slots[1].itemCount, 1);
  });
}

test('legacy shaped ingredients match offset/mirror coordinates after actual codec decode', () => {
  const { session, stack, receive, content } = fixture('1.20.4');
  const recipe = { recipeId: 'minecraft:fixture', type: 'minecraft:crafting_shaped', data: { group: '', category: 0, width: 2, height: 1, ingredients: [[[stack('honey_bottle')]], [[stack('oak_log')]]], result: stack('stone'), showNotification: true } };
  receive('declare_recipes', { recipes: [recipe] });
  const decoded = session.recipes.values().next().value;
  assert.equal(matchesCraftingRecipe(decoded, [stack('oak_log'), stack('honey_bottle'), { present: false }, { present: false }], 2, session.itemDefinitions), true);
  assert.equal(matchesCraftingRecipe(decoded, [stack('oak_log'), stack('honey_bottle'), stack('dirt'), { present: false }], 2, session.itemDefinitions), false);
  content({ 0: stack('stone'), 3: stack('oak_log', 2), 4: stack('honey_bottle') }); session.clickWindow(0);
  assert.equal(session.windows.get(0).slots[3].itemCount, 1); assert.equal(session.windows.get(0).slots[4].itemId, session.itemDefinitions.values().find(item => item.name === 'glass_bottle').id);
});

test('legacy shapeless matching finds a one-to-one assignment for overlapping alternatives', () => {
  const { session, stack } = fixture('1.20.4');
  const recipe = { type: 'minecraft:crafting_shapeless', data: { ingredients: [[stack('stone'), stack('dirt')], [stack('stone')]] } };
  assert.equal(matchesCraftingRecipe(recipe, [stack('stone'), stack('dirt'), { present: false }, { present: false }], 2, session.itemDefinitions), true);
  assert.equal(matchesCraftingRecipe(recipe, [stack('dirt'), stack('dirt'), { present: false }, { present: false }], 2, session.itemDefinitions), false);
});

test('legacy native book/banner cloning retains the original NBT while consuming its blank counterpart', () => {
  const { session, receive, stack, content } = fixture('1.20.4');
  receive('declare_recipes', { recipes: [{ recipeId: 'minecraft:book_cloning', type: 'minecraft:crafting_special_bookcloning', data: { category: 0 } }, { recipeId: 'minecraft:banner_duplicate', type: 'minecraft:crafting_special_bannerduplicate', data: { category: 0 } }] });
  const book = stack('written_book', 1, { nbtData: { type: 'compound', name: '', value: { title: { type: 'string', value: 'Original' }, author: { type: 'string', value: 'Writer' } } } });
  content({ 0: book, 1: book, 2: stack('writable_book', 2) }); session.clickWindow(0);
  assert.equal(session.windows.get(0).slots[1].itemCount, 1); assert.equal(sameStack(session.windows.get(0).slots[1], book), true); assert.equal(session.windows.get(0).slots[2].itemCount, 1);
  const banner = stack('white_banner', 1, { nbtData: { type: 'compound', name: '', value: { BlockEntityTag: { type: 'compound', value: { Patterns: { type: 'list', value: { type: 'compound', value: [{ Pattern: { type: 'string', value: 'bs' }, Color: { type: 'int', value: 14 } }] } } } } } } });
  content({ 0: banner, 1: banner, 2: stack('white_banner', 2) }); session.clickWindow(0);
  assert.equal(sameStack(session.windows.get(0).slots[1], banner), true); assert.equal(session.windows.get(0).slots[2].itemCount, 1);
});

for (const version of ['1.21.11', '26.1']) {
  test(`${version} modern recipe displays never replace authoritative output or custom remainder logic`, () => {
    const { session, content, stack } = fixture(version);
    session.recipes.set(1, { recipeId: 1, type: 'minecraft:crafting_shapeless', source: 'book', data: { ingredients: [[stack('stone')]], result: stack('diamond', 64) } });
    content({ 0: stack('oak_planks', 4), 1: stack('oak_log', 2) }); session.clickWindow(0);
    assert.equal(session.windows.get(0).cursor.itemId, stack('oak_planks').itemId); assert.equal(session.windows.get(0).slots[0].present, false); assert.equal(session.windows.get(0).slots[1].itemCount, 1);
  });

  test(`${version} bundle capacity uses exact fractions for 99-size component stacks and full bees`, () => {
    const { session, stack, bundle } = fixture(version);
    const custom = stack('stone', 98, { components: [{ type: 'max_stack_size', data: 99 }], addedComponentCount: 1 });
    assert.equal(bundleCapacity(bundle([custom]), custom, session.itemDefinitions), 1);
    const bees = stack('beehive', 1, { components: [{ type: 'bees', data: { bees: [{ nbtData: { type: 'compound', value: {} }, ticksInHive: 0, minTicksInHive: 0 }] } }], addedComponentCount: 1 });
    assert.equal(bundleCapacity(bundle([stack('stone')]), bees, session.itemDefinitions), 0); assert.equal(bundleCapacity(bundle(), bees, session.itemDefinitions), 1);
  });

  test(`${version} nested bundle equality ignores wire counters, derived NBT, selection and component ordering`, () => {
    const { session, stack, bundle } = fixture(version);
    const native = stack('stone', 3, { components: [{ type: 'damage', data: 2 }, { type: 'max_stack_size', data: 99 }], addedComponentCount: 2 });
    const normalized = session.adapter.normalizeSlot(native);
    assert.equal(sameStack(bundle([native]), bundle([{ ...normalized, bundleSelectedItem: 1, components: [...normalized.components].reverse() }])), true);
    assert.equal(sameStack(bundle([native]), bundle([{ ...native, itemCount: 4 }])), false);
    assert.equal(sameStack(native, { ...native, components: [{ type: 'minecraft:damage', data: 2, hash: 123 }, { type: 'max_stack_size', data: 99 }] }), true);
  });

  test(`${version} bundle merges follow native damageability rather than a stray damage component`, () => {
    const { session, stack, bundle, content } = fixture(version);
    const tagged = stack('stone', 3, { components: [{ type: 'damage', data: 2 }], addedComponentCount: 1 });
    assert.equal(stackable(tagged, session.itemDefinitions), true, 'an item without max_damage is not damageable');
    content({ 9: bundle([tagged]) }, tagged); session.clickWindow(9);
    assert.equal(bundleContents(session.windows.get(0).slots[9], session.itemDefinitions)[0].itemCount, 6);
    const damaged = stack('stone', 3, { components: [{ type: 'damage', data: 2 }, { type: 'max_damage', data: 10 }], addedComponentCount: 2 });
    assert.equal(stackable(damaged, session.itemDefinitions), false);
    content({ 9: bundle([damaged]) }, damaged); session.clickWindow(9);
    assert.equal(bundleContents(session.windows.get(0).slots[9], session.itemDefinitions).length, 2, 'damaged stacks remain separate');
    assert.equal(stackable({ ...damaged, components: [...damaged.components, { type: 'unbreakable' }] }, session.itemDefinitions), true);
  });

  test(`${version} bundle selection packet picks the selected complete stack and clears selection`, () => {
    const { session, content, stack, bundle, sent, data } = fixture(version);
    content({ 9: bundle([stack('stone', 12), stack('dirt', 3)]) });
    assert.equal(session.selectBundleItem(9, 1), true); assert.deepEqual(sent.at(-1), { name: 'select_bundle_item', params: { slotId: 9, selectedItemIndex: 1 } });
    session.clickWindow(9, { button: 1 }); assert.equal(session.windows.get(0).cursor.itemId, data.itemsByName.dirt.id); assert.equal(session.windows.get(0).cursor.itemCount, 3); assert.equal(session.windows.get(0).slots[9].bundleSelectedItem, -1);
    assert.equal(session.selectBundleItem(9, 4), false);
    content({ 9: stack('bundle', 1, { removeComponents: [{ type: 'bundle_contents' }], removedComponentCount: 1 }) }, stack('stone', 3)); session.clickWindow(9);
    assert.equal(session.windows.get(0).cursor.itemId, data.itemsByName.bundle.id, 'removed contents component disables the BundleItem override');
  });
}
