// Real browser HUD/container controls through the Java 1.20.4 packet codec and TCP gateway.
// Fixtures use generated text/items; they do not contain Minecraft assets.
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import minecraftProtocol from 'minecraft-protocol';
import minecraftData from 'minecraft-data';
import { createGateway } from '../scripts/gateway.mjs';
import { zipSync } from 'fflate';

const url = process.env.POMME_URL || 'http://127.0.0.1:5173';
const registry = minecraftData('1.20.4');
const text = (value) => ({ type: 'compound', value: { text: { type: 'string', value } } });
const empty = { present: false };
const item = (name, count = 1, nbtData) => ({ present: true, itemId: registry.itemsByName[name].id, itemCount: count, nbtData });
const slots = (count, values = {}) => Array.from({ length: count }, (_, index) => values[index] || empty);
const received = [], errors = [];
const waitPacket = async (name, predicate = () => true, from = 0) => {
  const until = Date.now() + 10000;
  while (Date.now() < until) {
    const packet = received.slice(from).find((packet) => packet.name === name && predicate(packet.data));
    if (packet) return packet.data;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Missing ${name}; received ${received.slice(from).map((packet) => packet.name).join(', ')}`);
};
const server = minecraftProtocol.createServer({ host: '127.0.0.1', port: 0, version: '1.20.4', 'online-mode': false, keepAlive: false, hideErrors: true });
server.on('error', (error) => errors.push(error.message));
await once(server, 'listening');
const serverPort = server.socketServer.address().port;
let client, browser, gateway, page;
server.on('playerJoin', (joined) => {
  client = joined; joined.on('error', (error) => errors.push(error.message));
  joined.on('packet', (data, meta) => received.push({ name: meta.name, data }));
  joined.write('login', { ...registry.loginPacket, entityId: 42, gameMode: 0, hashedSeed: 1650n });
  joined.write('position', { x: 8, y: 64, z: 8, yaw: 180, pitch: 0, flags: 0, teleportId: 3 });
  joined.write('window_items', { windowId: 0, stateId: 1, items: slots(46, { 36: item('stone', 16) }), carriedItem: empty });
  joined.write('experience', { experienceBar: 0.65, level: 30, totalExperience: 1000 });
  joined.write('update_health', { health: 17, food: 19, foodSaturation: 4 });
});

try {
  gateway = await createGateway({ port: 0, allowedOrigins: [new URL(url).origin], allowDestinations: [`127.0.0.1:${serverPort}`] });
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] });
  const context = await browser.newContext({ viewport: { width: 1080, height: 760 } });
  await context.grantPermissions(['local-network-access'], { origin: new URL(url).origin });
  page = await context.newPage();
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
  await page.route('**/__gameplay_wire_test', (route) => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><head><title>Java server HUD and containers</title></head><body style="margin:0;background:#304251"><canvas id="world"></canvas><nav id="hotbar"></nav></body></html>' }));
  await page.goto(`${url}/__gameplay_wire_test`);
  await page.evaluate(async ({ port, gatewayPort }) => {
    const [{ MinecraftSession }, { ServerGameplay }, { Player }] = await Promise.all([import('/src/minecraft.js'), import('/src/gameplay.js'), import('/src/player.js')]);
    const registry = await (await fetch('/data/1.20.4-registry.json')).json();
    const { instance } = await WebAssembly.instantiateStreaming(fetch('/public/core.wasm'), {});
    instance.exports.world_init(1650); const player = new Player(instance.exports);
    let gameplay;
    const session = new MinecraftSession({ registry, onState: (state) => gameplay?.state(state), onInventory: (window) => gameplay?.inventory(window), onEvent: (event) => gameplay?.event(event), onPosition: (position) => player.setPosition([position.x, position.y, position.z], position) });
    gameplay = new ServerGameplay({ session, registry, player, world: instance.exports });
    window.wireProof = { session, gameplay, player };
    document.addEventListener('keydown', (event) => gameplay.key(event)); document.addEventListener('keyup', (event) => gameplay.key(event));
    let last = performance.now(); const frame = (now) => { gameplay.tick(Math.min(0.1, (now - last) / 1000)); last = now; requestAnimationFrame(frame); }; requestAnimationFrame(frame);
    await session.connect(`ws://127.0.0.1:${gatewayPort}`, { host: '127.0.0.1', port, username: 'HudBrowser', auth: 'offline', version: '1.20.4' });
  }, { port: serverPort, gatewayPort: gateway.address.port });
  await page.waitForFunction(() => window.wireProof.session.state.status === 'playing' && window.wireProof.session.windows.has(0), null, { timeout: 20000 });
  const png = await page.evaluate(() => { const canvas = document.createElement('canvas'); canvas.width = 16; canvas.height = 16; const context = canvas.getContext('2d'); context.fillStyle = '#6b8b98'; context.fillRect(0, 0, 16, 16); return canvas.toDataURL('image/png').split(',')[1]; });
  const faces = Object.fromEntries(['east', 'west', 'up', 'down', 'south', 'north'].map((face) => [face, { texture: '#all', cullface: face }]));
  const pack = zipSync({ 'assets/minecraft/textures/block/stone.png': Buffer.from(png, 'base64'), 'assets/minecraft/models/block/stone.json': new TextEncoder().encode(JSON.stringify({ textures: { all: 'minecraft:block/stone' }, elements: [{ from: [0, 0, 0], to: [16, 16, 16], faces }] })), 'assets/minecraft/blockstates/stone.json': new TextEncoder().encode(JSON.stringify({ variants: { '': { model: 'minecraft:block/stone' } } })) });
  await page.evaluate(async (bytes) => { const { loadResourcePack } = await import('/src/assets.js'); const pack = await loadResourcePack(Uint8Array.from(bytes), { registry: window.wireProof.gameplay.registry }); window.wireProof.gameplay.setAssets(pack); }, [...pack]);
  await page.waitForFunction(() => document.querySelector('.server-hotbar-slot img')?.naturalWidth > 0);
  assert.equal(await page.locator('.server-hotbar-slot img').count(), 1);
  assert.equal(await page.locator('[data-ui="xp"]').evaluate((node) => node.value), 0.6499999761581421);
  client.write('set_title_time', { fadeIn: 0, stay: 400, fadeOut: 10 });
  client.write('set_title_subtitle', { text: text('Real server packet stream') });
  client.write('set_title_text', { text: text('Minecraft HUD') });
  client.write('action_bar', { text: text('A native action bar') });
  client.write('boss_bar', { entityUUID: '12345678-1234-4234-8234-123456789abc', action: 0, title: text('Ender dragon'), health: 0.75, color: 5, dividers: 0, flags: 0 });
  client.write('scoreboard_objective', { name: 'parity', action: 0, displayText: text('Adventure'), type: 0, number_format: null });
  client.write('scoreboard_display_objective', { position: 1, name: 'parity' });
  client.write('scoreboard_score', { itemName: 'Diamonds', scoreName: 'parity', value: 12, display_name: null, number_format: null });
  client.write('playerlist_header', { header: text('Server players'), footer: text('Java 1.20.4') });
  client.write('player_info', { action: { add_player: true, update_game_mode: true, update_listed: true, update_latency: true, update_display_name: true }, data: [{ uuid: '12345678-1234-4234-8234-123456789012', player: { name: 'Alex', properties: [] }, gamemode: 0, listed: 1, latency: 43, displayName: text('Adventure Alex') }] });
  client.write('entity_effect', { entityId: 42, effectId: 12, amplifier: 0, duration: 1200, hideParticles: 0, factorCodec: null });
  await page.waitForFunction(() => document.querySelector('[data-ui="title"]').textContent === 'Minecraft HUD' && document.querySelector('[data-ui="scoreboard"]').textContent.includes('Diamonds') && document.querySelector('[data-ui="effects"]').textContent.includes('Water breathing'));
  await page.keyboard.down('Tab'); await page.waitForFunction(() => !document.querySelector('[data-ui="playerlist"]').hidden);
  assert.ok((await page.locator('[data-ui="playerlist"]').textContent()).includes('Adventure Alex'));
  assert.ok((await page.locator('[data-ui="playerlist"]').textContent()).includes('43 ms'));
  assert.equal(await page.locator('.server-bossbar progress').evaluate((node) => node.value), 0.75);
  await mkdir('test-results', { recursive: true }); await page.screenshot({ path: 'test-results/server-hud.png' }); await page.keyboard.up('Tab');

  const open = async (id, type, title, count, values = {}) => {
    client.write('open_window', { windowId: id, inventoryType: type, windowTitle: text(title) });
    client.write('window_items', { windowId: id, stateId: id + 10, items: slots(count, values), carriedItem: empty });
    await page.waitForFunction(({ id, title }) => window.wireProof.session.state.windowId === id && document.querySelector('[data-ui="inventory-title"]').textContent === title && !document.querySelector('[data-ui="inventory"]').hidden, { id, title });
    await page.waitForFunction((count) => document.querySelectorAll('[data-ui="slots"] [data-slot]').length === count, count);
  };

  await open(1, 8, 'Repair & Name', 39, { 0: item('stone') });
  client.write('craft_progress_bar', { windowId: 1, property: 0, value: 2 });
  await page.getByRole('textbox', { name: 'Rename item' }).fill('Named by Chromium');
  assert.equal((await waitPacket('name_item', (packet) => packet.name === 'Named by Chromium')).name, 'Named by Chromium');
  await page.waitForFunction(() => document.querySelector('.server-container-options').textContent.includes('Repair cost: 2'));

  await open(2, 13, 'Enchant', 38, { 0: item('diamond_pickaxe'), 1: item('lapis_lazuli', 8) });
  for (const [property, value] of [[0, 5], [1, 15], [2, 30], [4, 32], [5, 32], [6, 32], [7, 1], [8, 2], [9, 4]]) client.write('craft_progress_bar', { windowId: 2, property, value });
  await page.getByRole('button', { name: /3\. .*Requires level 30/ }).click();
  assert.deepEqual(await waitPacket('enchant_item', (packet) => packet.windowId === 2), { windowId: 2, enchantment: 2 });

  await open(3, 19, 'Villager', 39);
  client.write('trade_list', { windowId: 3, trades: [{ inputItem1: item('emerald', 3), outputItem: item('bread', 2), inputItem2: empty, tradeDisabled: false, nbTradeUses: 0, maximumNbTradeUses: 12, xp: 2, specialPrice: -1, priceMultiplier: 0.05, demand: 0 }], villagerLevel: 2, experience: 25, isRegularVillager: true, canRestock: true });
  await page.locator('[data-trade="0"]').click(); assert.deepEqual(await waitPacket('select_trade'), { slot: 0 });
  assert.ok((await page.locator('[data-trade="0"]').textContent()).startsWith('2 Emerald'));

  await open(4, 12, 'Crafting', 46, { 1: item('oak_log'), 10: item('stone', 5) });
  client.write('declare_recipes', { recipes: [{ type: 'minecraft:crafting_shapeless', recipeId: 'minecraft:oak_planks', data: { group: '', category: 0, ingredients: [[item('oak_log')]], result: item('oak_planks', 4) } }] });
  client.write('unlock_recipes', { action: 0, craftingBookOpen: true, filteringCraftable: false, smeltingBookOpen: false, filteringSmeltable: false, blastFurnaceOpen: false, filteringBlastFurnace: false, smokerBookOpen: false, filteringSmoker: false, recipes1: ['minecraft:oak_planks'], recipes2: [] });
  await page.locator('[data-recipe="minecraft:oak_planks"]').click({ modifiers: ['Shift'] });
  assert.deepEqual(await waitPacket('craft_recipe_request'), { windowId: 4, recipe: 'minecraft:oak_planks', makeAll: true });
  await page.locator('[data-ui="slots"] [data-slot="10"]').click({ modifiers: ['Shift'] });
  const click = await waitPacket('window_click', (packet) => packet.windowId === 4);
  assert.equal(click.slot, 10); assert.equal(click.mode, 1); assert.equal(click.stateId, 14);
  await page.screenshot({ path: 'test-results/server-crafting.png' });

  await open(5, 14, 'Furnace', 39, { 0: item('iron_ore'), 1: item('coal') });
  for (const [property, value] of [[0, 40], [1, 80], [2, 25], [3, 100]]) client.write('craft_progress_bar', { windowId: 5, property, value });
  await page.waitForFunction(() => document.querySelector('[aria-label="Cooking progress"]')?.value === 25);
  assert.equal(await page.locator('[aria-label="Cooking progress"]').evaluate((node) => node.value / node.max), 0.25);

  await open(6, 17, 'Lectern', 1, { 0: item('written_book', 1, { type: 'compound', value: { pages: { type: 'list', value: { type: 'string', value: ['{"text":"The first native page"}', '{"text":"The second native page"}'] } } } }) });
  client.write('craft_progress_bar', { windowId: 6, property: 0, value: 0 });
  await page.getByRole('button', { name: 'Next page' }).click();
  assert.deepEqual(await waitPacket('enchant_item', (packet) => packet.windowId === 6), { windowId: 6, enchantment: 2 });
  assert.ok((await page.locator('.server-container-options').textContent()).includes('The first native page'));

  client.write('close_window', { windowId: 6 });
  await page.waitForFunction(() => !window.wireProof.gameplay.blocking);
  await open(7, 7, 'Crafter', 46);
  await page.locator('[data-ui="slots"] [data-slot="0"]').click();
  assert.deepEqual(await waitPacket('set_slot_state'), { slot_id: 0, window_id: 7, state: false });
  client.write('craft_progress_bar', { windowId: 7, property: 0, value: 1 });
  await page.waitForFunction(() => document.querySelector('[data-ui="slots"] [data-slot="0"]').classList.contains('crafter-disabled'));
  assert.equal(await page.locator('[data-ui="slots"] [data-slot="45"]').count(), 1);

  client.write('tags', { tags: [{ tagType: 'minecraft:banner_pattern', tags: [{ tagName: 'minecraft:no_item_required', entries: [6, 8] }] }] });
  await open(8, 18, 'Loom', 40, { 0: item('white_banner'), 1: item('red_dye') });
  await page.locator('[data-pattern="1"]').click();
  assert.deepEqual(await waitPacket('enchant_item', (packet) => packet.windowId === 8), { windowId: 8, enchantment: 1 });

  await open(9, 24, 'Stonecutter', 38, { 0: item('stone') });
  client.write('declare_recipes', { recipes: ['stone_bricks', 'stone_brick_slab'].map((name) => ({ type: 'minecraft:stonecutting', recipeId: `minecraft:${name}_from_stone`, data: { group: '', ingredient: [item('stone')], result: item(name) } })) });
  await page.locator('[data-recipe="minecraft:stone_brick_slab_from_stone"]').click();
  assert.deepEqual(await waitPacket('enchant_item', (packet) => packet.windowId === 9), { windowId: 9, enchantment: 0 });

  client.write('close_window', { windowId: 9 }); await page.waitForFunction(() => !window.wireProof.gameplay.blocking);
  const advancement = (key, parentId, title, xCord, requirements) => ({ key, value: { parentId, displayData: { title: text(title), description: text(`${title} from the native server`), icon: item('diamond'), frameType: 0, flags: { _unused: 0, hidden: 0, show_toast: 1, has_background_texture: 0 }, xCord, yCord: 0 }, requirements, sendsTelemtryData: false } });
  client.write('advancements', { reset: true, advancementMapping: [advancement('minecraft:story/root', null, 'Minecraft', 0, [['start']]), advancement('minecraft:story/mine_diamond', 'minecraft:story/root', 'Diamonds!', 1, [['diamond']])], identifiers: [], progressMapping: [{ key: 'minecraft:story/root', value: [{ criterionIdentifier: 'start', criterionProgress: 1690000000000n }] }] });
  await page.keyboard.press('KeyL');
  await page.waitForFunction(() => document.querySelector('[data-advancement="minecraft:story/mine_diamond"]'));
  assert.deepEqual(await waitPacket('advancement_tab', (packet) => packet.action === 0), { action: 0, tabId: 'minecraft:story/root' });
  client.write('advancements', { reset: false, advancementMapping: [], identifiers: [], progressMapping: [{ key: 'minecraft:story/mine_diamond', value: [{ criterionIdentifier: 'diamond', criterionProgress: 1690000000001n }] }] });
  await page.waitForFunction(() => document.querySelector('[data-advancement="minecraft:story/mine_diamond"]').classList.contains('complete') && document.querySelector('.server-advancement-toast').textContent.includes('Diamonds!'));
  await page.screenshot({ path: 'test-results/server-advancements.png' }); await page.keyboard.press('Escape');
  assert.equal((await waitPacket('advancement_tab', (packet) => packet.action === 1)).action, 1);

  await page.keyboard.press('KeyE'); await page.locator('[data-ui="statistics-open"]').click();
  assert.equal((await waitPacket('client_command', (packet) => packet.actionId === 'request_stats')).actionId, 'request_stats');
  client.write('statistics', { entries: [{ categoryId: 8, statisticId: 1, value: 1200 }, { categoryId: 0, statisticId: registry.blocksByName.stone.id, value: 17 }] });
  await page.waitForFunction(() => document.querySelector('.server-statistics-table')?.textContent.includes('1.00 min'));
  await page.getByRole('tab', { name: 'Blocks mined', exact: true }).click();
  assert.ok((await page.locator('.server-statistics-table').textContent()).includes('Stone'));
  assert.ok((await page.locator('.server-statistics-table').textContent()).includes('17'));
  await page.keyboard.press('Escape');
  const originalBook = { type: 'compound', value: { pages: { type: 'list', value: { type: 'string', value: ['Original server page'] } } } };
  client.write('window_items', { windowId: 0, stateId: 40, items: slots(46, { 36: item('writable_book', 1, originalBook) }), carriedItem: empty });
  client.write('open_book', { hand: 0 });
  await page.getByRole('textbox', { name: 'Book page 1', exact: true }).fill('Written in the actual browser');
  await page.getByRole('button', { name: 'Sign', exact: true }).click(); await page.getByRole('textbox', { name: 'Book title', exact: true }).fill('Chromium book'); await page.getByRole('button', { name: 'Sign and close', exact: true }).click();
  assert.deepEqual(await waitPacket('edit_book'), { hand: 0, pages: ['Written in the actual browser'], title: 'Chromium book' });
  assert.equal(await page.evaluate(() => window.wireProof.session.windows.get(0).slots[36].nbtData.value.pages.value.value[0]), 'Original server page');
  client.write('window_items', { windowId: 0, stateId: 41, items: slots(46, { 45: item('written_book', 1, { type: 'compound', value: { pages: { type: 'list', value: { type: 'string', value: ['{"text":"A confirmed offhand book"}'] } }, title: { type: 'string', value: 'Native book' }, author: { type: 'string', value: 'Alex' } } }) }), carriedItem: empty });
  client.write('open_book', { hand: 1 }); await page.waitForFunction(() => document.querySelector('.server-book-page')?.textContent === 'A confirmed offhand book'); await page.getByRole('button', { name: 'Done', exact: true }).click();
  await page.keyboard.press('KeyE'); await page.locator('[data-ui="controls-open"]').click();
  await page.locator('[data-control="forward"]').click(); await page.keyboard.press('ArrowUp');
  assert.equal(await page.evaluate(() => window.wireProof.gameplay.controlCode('ArrowUp')), 'KeyW');
  assert.equal(await page.evaluate(() => window.wireProof.gameplay.controlCode('KeyW')), null);
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  client.write('boss_bar', { entityUUID: '12345678-1234-4234-8234-123456789abc', action: 2, health: 0.2 });
  await page.waitForFunction(() => Math.abs(document.querySelector('.server-bossbar progress').value - 0.2) < 0.00001);
  client.write('clear_titles', { reset: true }); client.write('reset_score', { entity_name: 'Diamonds', objective_name: 'parity' });
  await page.waitForFunction(() => document.querySelector('[data-ui="titles"]').hidden && !document.querySelector('[data-ui="scoreboard"]').textContent.includes('Diamonds'));
  client.write('close_window', { windowId: 0 });
  client.write('game_state_change', { reason: 'change_game_mode', gameMode: 1 });
  client.write('window_items', { windowId: 0, stateId: 50, items: slots(46, { 36: item('stone', 8) }), carriedItem: empty });
  await page.waitForFunction(() => window.wireProof.session.state.gameMode === 1 && window.wireProof.session.windows.get(0).stateId === 50 && !window.wireProof.gameplay.blocking);
  await page.keyboard.press('KeyE');
  await page.locator('[data-ui="slots"] [data-slot="36"]').click({ button: 'middle' });
  await page.waitForFunction(() => window.wireProof.session.windows.get(0).cursor.itemCount === 64);
  const firstDrag = await page.locator('[data-ui="slots"] [data-slot="12"]').boundingBox(), secondDrag = await page.locator('[data-ui="slots"] [data-slot="13"]').boundingBox();
  await page.mouse.move(firstDrag.x + firstDrag.width / 2, firstDrag.y + firstDrag.height / 2); await page.mouse.down();
  await page.mouse.move(secondDrag.x + secondDrag.width / 2, secondDrag.y + secondDrag.height / 2, { steps: 3 }); await page.mouse.up();
  await page.waitForFunction(() => window.wireProof.session.windows.get(0).slots[12].itemCount === 32 && window.wireProof.session.windows.get(0).slots[13].itemCount === 32 && !window.wireProof.session.windows.get(0).cursor.present);
  client.write('window_items', { windowId: 0, stateId: 51, items: slots(46, { 14: item('stone', 3), 15: item('stone', 7), 36: item('stone', 8) }), carriedItem: empty });
  await page.waitForFunction(() => window.wireProof.session.windows.get(0).stateId === 51);
  await page.locator('[data-ui="slots"] [data-slot="14"]').dblclick({ delay: 70 });
  await page.waitForFunction(() => window.wireProof.session.windows.get(0).cursor.itemCount === 18 && !window.wireProof.session.windows.get(0).slots[15].present && !window.wireProof.session.windows.get(0).slots[36].present);
  const dragBetween = async (first, second, button) => {
    const a = await page.locator(`[data-ui="slots"] [data-slot="${first}"]`).boundingBox(), b = await page.locator(`[data-ui="slots"] [data-slot="${second}"]`).boundingBox();
    await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2); await page.mouse.down({ button });
    await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 3 }); await page.mouse.up({ button });
  };
  await dragBetween(16, 17, 'right');
  await page.waitForFunction(() => window.wireProof.session.windows.get(0).slots[16].itemCount === 1 && window.wireProof.session.windows.get(0).slots[17].itemCount === 1 && window.wireProof.session.windows.get(0).cursor.itemCount === 16);
  client.write('window_items', { windowId: 0, stateId: 52, items: slots(46), carriedItem: item('stone', 64) });
  await page.waitForFunction(() => window.wireProof.session.windows.get(0).stateId === 52);
  await dragBetween(20, 21, 'middle');
  await page.waitForFunction(() => window.wireProof.session.windows.get(0).slots[20].itemCount === 64 && window.wireProof.session.windows.get(0).slots[21].itemCount === 64 && !window.wireProof.session.windows.get(0).cursor.present);
  const nativeInput = received.filter(packet => packet.name === 'window_click' && packet.data.stateId >= 50).map(packet => packet.data);
  assert.equal(nativeInput.filter(packet => packet.mode === 3).length, 1); assert.equal(nativeInput.filter(packet => packet.mode === 5).length, 12); assert.equal(nativeInput.filter(packet => packet.mode === 6).length, 1);
  const proof = { hud: ['titles', 'action bar', 'boss bar', 'XP', 'effects', 'player list', 'scoreboard', 'advancement tree/progress/toast', 'native statistics', 'native model inventory icon'], containers: ['anvil rename/cost', 'enchantment buttons', 'villager trade', 'craft recipe/shift click', 'furnace progress', 'lectern page', 'crafter disabled-slot toggle', 'loom native pattern tag', 'stonecutter native recipe index', 'signed book edit and offhand reader'], nativeServerboundPackets: received.filter((packet) => ['name_item', 'enchant_item', 'select_trade', 'craft_recipe_request', 'window_click', 'set_slot_state', 'advancement_tab', 'client_command', 'edit_book'].includes(packet.name)), errors };
  proof.nativeInput = nativeInput;
  assert.deepEqual(errors, []); await writeFile('test-results/gameplay-wire.json', JSON.stringify(proof, null, 2));
  console.log(JSON.stringify(proof, null, 2));
} catch (error) {
  console.error(JSON.stringify({ error: error.message, browserErrors: errors, state: await page?.evaluate(() => window.wireProof?.session.state).catch(() => null), serverboundPackets: received.map((packet) => packet.name) }, (_key, value) => typeof value === 'bigint' ? String(value) : value, 2));
  throw error;
} finally {
  await browser?.close(); await gateway?.close();
  for (const client of Object.values(server.clients)) client.socket?.destroy();
  await new Promise((resolve) => server.socketServer.close(resolve));
}
