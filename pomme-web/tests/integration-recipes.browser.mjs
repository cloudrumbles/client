import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import minecraftProtocol from 'minecraft-protocol';
import minecraftData from 'minecraft-data';

// DOM controls use codec-decoded native modern packets and their outgoing
// predictions are re-encoded/decoded with the real matching Java wire codec.
const base = process.env.POMME_URL || 'http://127.0.0.1:5173', version = '1.21.11', data = minecraftData(version);
const incomingWriter = minecraftProtocol.createSerializer({ version, state: 'play', isServer: true });
const incomingReader = minecraftProtocol.createDeserializer({ version, state: 'play', isServer: false });
const outgoingWriter = minecraftProtocol.createSerializer({ version, state: 'play', isServer: false });
const outgoingReader = minecraftProtocol.createDeserializer({ version, state: 'play', isServer: true });
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] });
const page = await browser.newPage({ viewport: { width: 1040, height: 740 } }), errors = [];
page.on('pageerror', error => errors.push(error.message));
const stack = (name, itemCount = 1) => ({ itemId: data.itemsByName[name].id, itemCount, addedComponentCount: 0, removedComponentCount: 0, components: [], removeComponents: [] });
const display = (name, count = 1) => ({ type: 'item_stack', data: stack(name, count) });
async function receive(name, params) {
  const packet = incomingReader.parsePacketBuffer(incomingWriter.createPacketBuffer({ name, params })).data;
  await page.evaluate(packet => window.recipeProof.session.receive({ type: 'packet', name: packet.name, data: packet.params }), packet);
}
async function outgoing() {
  return (await page.evaluate(() => window.recipeProof.sent)).map(packet => outgoingReader.parsePacketBuffer(outgoingWriter.createPacketBuffer({ name: packet.name, params: packet.data })).data);
}
try {
  await page.route('**/__modern_recipe_proof', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><head><title>Modern native recipes</title></head><body><canvas id="world"></canvas><nav id="hotbar"></nav></body></html>' }));
  await page.goto(`${base}/__modern_recipe_proof`);
  await page.evaluate(async () => {
    const [{ MinecraftSession }, { ServerGameplay }, { Player }] = await Promise.all([import('/src/minecraft.js'), import('/src/gameplay.js'), import('/src/player.js')]);
    const registry = await (await fetch('/data/1.21.11-registry.json')).json();
    const { instance } = await WebAssembly.instantiateStreaming(fetch('/public/core.wasm'), {}); instance.exports.world_init(1650);
    const player = new Player(instance.exports), sent = []; let gameplay;
    const session = new MinecraftSession({ registry, onInventory: value => gameplay?.inventory(value), onState: value => gameplay?.state(value), onEvent: value => gameplay?.event(value), transport: { packet(name, data) { sent.push({ name, data }); return true; }, close() {} } });
    gameplay = new ServerGameplay({ session, registry, player, world: instance.exports });
    window.recipeProof = { session, gameplay, sent }; session.changeState({ status: 'playing', entityId: 9, gameMode: 0 });
  });
  await receive('recipe_book_add', { replace: true, entries: [{ recipe: { displayId: 57, category: 'crafting_building_blocks', group: undefined, craftingRequirements: [{ ids: [data.itemsByName.oak_log.id] }], display: { type: 'crafting_shapeless', data: { ingredients: [{ type: 'item', data: data.itemsByName.oak_log.id }], result: display('oak_planks', 4), craftingStation: { type: 'item', data: data.itemsByName.crafting_table.id } } } }, flags: { notification: true, highlight: true } }] });
  await receive('open_window', { windowId: 1, inventoryType: 12, windowTitle: { type: 'compound', value: { text: { type: 'string', value: 'Crafting' } } } });
  await receive('window_items', { windowId: 1, stateId: 4, items: Array.from({ length: 46 }, () => ({ itemCount: 0 })), carriedItem: { itemCount: 0 } });
  await page.locator('[data-recipe="57"]').click({ modifiers: ['Shift'] });
  let packets = await outgoing();
  assert.deepEqual(packets.find(packet => packet.name === 'craft_recipe_request'), { name: 'craft_recipe_request', params: { windowId: 1, recipeId: 57, makeAll: true } });
  assert.equal(packets.find(packet => packet.name === 'displayed_recipe').params.recipeId, 57);
  await receive('recipe_book_remove', { recipeIds: [57] }); assert.equal(await page.locator('[data-recipe="57"]').count(), 0);
  await receive('declare_recipes', { recipes: [{ name: 'minecraft:furnace_input', items: [data.itemsByName.iron_ore.id] }], stoneCutterRecipes: [
    { input: { ids: [data.itemsByName.stone.id] }, slotDisplay: display('stone_bricks') },
    { input: { ids: [data.itemsByName.stone.id] }, slotDisplay: display('stone_brick_slab', 2) },
  ] });
  await receive('open_window', { windowId: 2, inventoryType: 24, windowTitle: { type: 'compound', value: { text: { type: 'string', value: 'Stonecutter' } } } });
  const items = Array.from({ length: 38 }, () => ({ itemCount: 0 })); items[0] = stack('stone', 4);
  await receive('window_items', { windowId: 2, stateId: 5, items, carriedItem: { itemCount: 0 } });
  const order = await page.locator('.server-recipes [data-recipe]').allTextContents();
  assert.ok(order[0].includes('Stone Bricks')); assert.ok(order[1].includes('Stone Brick Slab'));
  await page.locator('[data-recipe="stonecutter:0"]').click();
  await page.getByRole('searchbox', { name: 'Search recipes' }).fill('slab'); await page.locator('[data-recipe="stonecutter:1"]').click();
  packets = await outgoing(); assert.deepEqual(packets.filter(packet => packet.name === 'enchant_item').map(packet => packet.params), [{ windowId: 2, enchantment: 0 }, { windowId: 2, enchantment: 1 }]);
  assert.equal(packets.filter(packet => packet.name === 'displayed_recipe').length, 1, 'stonecutter selection is not a recipe-book display acknowledgement');
  assert.deepEqual(errors, []);
  await mkdir('test-results', { recursive: true }); await page.screenshot({ path: 'test-results/modern-recipes.png' });
  await writeFile('test-results/modern-recipes.json', JSON.stringify({ version, order, packets, errors }, null, 2));
  console.log(JSON.stringify({ version, order, packets, errors }, null, 2));
} finally { await browser.close(); }
