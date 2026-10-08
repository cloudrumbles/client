import { test } from 'node:test';
import assert from 'node:assert/strict';
import minecraftProtocol from 'minecraft-protocol';
import minecraftData from 'minecraft-data';
import { MinecraftSession } from '../src/minecraft.js';
import { resolveSlotDisplay } from '../src/recipe-book.js';

function fixture(version) {
  const data = minecraftData(version), events = [], sent = [];
  const writer = minecraftProtocol.createSerializer({ version, state: 'play', isServer: true });
  const reader = minecraftProtocol.createDeserializer({ version, state: 'play', isServer: false });
  const outbound = minecraftProtocol.createSerializer({ version, state: 'play', isServer: false });
  const outboundReader = minecraftProtocol.createDeserializer({ version, state: 'play', isServer: true });
  const session = new MinecraftSession({ registry: { version: data.version, items: data.itemsArray }, onEvent: event => events.push(event), transport: { packet(name, params) { sent.push(outboundReader.parsePacketBuffer(outbound.createPacketBuffer({ name, params })).data); return true; }, close() {} } });
  const receive = (name, params) => { const parsed = reader.parsePacketBuffer(writer.createPacketBuffer({ name, params })).data; session.receive({ type: 'packet', name: parsed.name, data: parsed.params }); assert.equal(events.find(event => event.type === 'error'), undefined); };
  const stack = (name, count = 1, components = []) => ({ itemId: data.itemsByName[name].id, itemCount: count, addedComponentCount: components.length, removedComponentCount: 0, components, removeComponents: [] });
  const slotDisplay = (name, count = 1) => ({ type: 'item_stack', data: stack(name, count) });
  return { data, session, events, sent, receive, stack, slotDisplay };
}

for (const version of ['1.21.11', '26.1']) {
  test(`${version} native recipe-book display IDs drive add/remove/replace and craft request codecs`, () => {
    const { data, session, events, receive, sent, slotDisplay } = fixture(version);
    receive('tags', { tags: [{ tagType: 'minecraft:item', tags: [{ tagName: 'minecraft:logs', entries: [data.itemsByName.oak_log.id] }] }] });
    const entry = id => ({ recipe: { displayId: id, display: { type: 'crafting_shapeless', data: { ingredients: [{ type: 'tag', data: 'minecraft:logs' }], result: slotDisplay('oak_planks', 4), craftingStation: { type: 'item', data: data.itemsByName.crafting_table.id } } }, group: undefined, category: 'crafting_building_blocks', craftingRequirements: [{ ids: [data.itemsByName.oak_log.id] }] }, flags: { notification: true, highlight: true } });
    receive('recipe_book_add', { entries: [entry(57)], replace: true });
    const recipe = session.recipes.get(57); assert.equal(recipe.recipeId, 57); assert.equal(recipe.type, 'minecraft:crafting_shapeless');
    assert.equal(recipe.data.result.itemCount, 4); assert.equal(recipe.data.ingredients[0][0].itemId, data.itemsByName.oak_log.id);
    assert.deepEqual(events.findLast(event => event.type === 'unlock-recipes').recipes1, [57]);
    assert.equal(session.craftRecipe(57, { windowId: 4, makeAll: true }), true);
    assert.deepEqual(sent.at(-1), { name: 'craft_recipe_request', params: { windowId: 4, recipeId: 57, makeAll: true } });
    assert.equal(session.craftRecipe('minecraft:oak_planks'), false, 'resource IDs are not native recipe display IDs');
    receive('recipe_book_add', { entries: [entry(58)], replace: true });
    assert.equal(session.recipes.has(57), false); assert.equal(session.recipes.has(58), true);
    receive('recipe_book_remove', { recipeIds: [58] }); assert.equal(session.recipes.size, 0);
    assert.equal(events.findLast(event => event.type === 'unlock-recipes').action, 2);
  });

  test(`${version} recipe properties route furnace inputs/fuel and preserve authoritative stonecutter order`, () => {
    const { data, session, receive, stack, slotDisplay } = fixture(version);
    receive('declare_recipes', { recipes: [{ name: 'minecraft:furnace_input', items: [data.itemsByName.iron_ore.id] }], stoneCutterRecipes: [
      { input: { ids: [data.itemsByName.stone.id] }, slotDisplay: slotDisplay('stone_bricks') },
      { input: { ids: [data.itemsByName.stone.id] }, slotDisplay: slotDisplay('stone_brick_slab', 2) },
    ] });
    const ordered = [...session.recipes.values()].filter(recipe => recipe.source === 'stonecutter');
    assert.deepEqual(ordered.map(recipe => recipe.data.result.itemId), [data.itemsByName.stone_bricks.id, data.itemsByName.stone_brick_slab.id]);
    assert.deepEqual(ordered.map(recipe => recipe.nativeOrder), [0, 1]);
    receive('open_window', { windowId: 1, inventoryType: 14, windowTitle: { type: 'compound', value: { text: { type: 'string', value: 'Furnace' } } } });
    const items = Array.from({ length: 39 }, () => ({ itemCount: 0 })); items[3] = stack('coal', 8); items[4] = stack('iron_ore', 6); items[5] = stack('stone', 3);
    receive('window_items', { windowId: 1, stateId: 1, items, carriedItem: { itemCount: 0 } });
    session.clickWindow(3, { mode: 1 }); session.clickWindow(4, { mode: 1 }); session.clickWindow(5, { mode: 1 });
    assert.equal(session.windows.get(1).slots[1].itemId, data.itemsByName.coal.id); assert.equal(session.windows.get(1).slots[1].itemCount, 8);
    assert.equal(session.windows.get(1).slots[0].itemId, data.itemsByName.iron_ore.id); assert.equal(session.windows.get(1).slots[0].itemCount, 6);
    assert.equal(session.windows.get(1).slots[30].itemId, data.itemsByName.stone.id, 'non-input non-fuel toggles inventory into hotbar');
  });

  test(`${version} modern max_stack_size99, armor and binding restrictions survive accepted predictions`, () => {
    const { data, session, receive, stack } = fixture(version);
    const items = Array.from({ length: 46 }, () => ({ itemCount: 0 }));
    items[36] = stack('stone', 90, [{ type: 'max_stack_size', data: 99 }]); items[9] = stack('diamond_helmet');
    receive('window_items', { windowId: 0, stateId: 2, items, carriedItem: { itemCount: 0 } });
    session.clickWindow(36); session.clickWindow(10); assert.equal(session.windows.get(0).slots[10].itemCount, 90);
    session.clickWindow(9, { mode: 1 }); assert.equal(session.windows.get(0).slots[5].itemId, data.itemsByName.diamond_helmet.id);
    session.windows.get(0).cursor = { present: true, itemId: data.itemsByName.stone.id, itemCount: 1 };
    session.clickWindow(6); assert.equal(session.windows.get(0).slots[6].present, false, 'armor slots reject blocks');
  });
}

test('slot display resolver handles nested alternatives, remainders, tags, full components and fuel registries', () => {
  const tags = new Map([['minecraft:test', new Set([1, 2])]]), component = { itemCount: 1, itemId: 3, components: [{ type: 'damage', data: 4 }] };
  const resolve = display => resolveSlotDisplay(display, { tags, fuelIds: [5, 6], normalizeSlot: value => ({ ...value, present: true }) });
  assert.deepEqual(resolve({ type: 'composite', data: [{ type: 'tag', data: 'minecraft:test' }, { type: 'with_remainder', data: { input: { type: 'item_stack', data: component }, remainder: { type: 'item', data: 4 } } }, { type: 'any_fuel' }] }).map(value => value.itemId), [1, 2, 3, 5, 6]);
  assert.deepEqual(resolve({ type: 'item_stack', data: component })[0].components, component.components);
  const cycle = { type: 'with_remainder', data: {} }; cycle.data.input = cycle; assert.deepEqual(resolve(cycle), []);
});
