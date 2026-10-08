import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import minecraftProtocol from 'minecraft-protocol';
import minecraftData from 'minecraft-data';
import { installNativeCodecs } from '../scripts/native-codec.mjs';

installNativeCodecs('26.1');

const base = process.env.POMME_URL || 'http://127.0.0.1:5173';
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] });
const errors = [], proofs = [];
try {
  for (const version of ['1.20.4', '1.21.11', '26.1']) {
    const data = minecraftData(version), modern = version !== '1.20.4', page = await browser.newPage({ viewport: { width: 1040, height: 740 } });
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/__inventory_prediction', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><head><title>Native inventory prediction</title></head><body><canvas id="world"></canvas><nav id="hotbar"></nav></body></html>' }));
    await page.goto(`${base}/__inventory_prediction`);
    await page.evaluate(async version => {
      const [{ MinecraftSession }, { ServerGameplay }, { Player }, { bundleContents }] = await Promise.all([import('/src/minecraft.js'), import('/src/gameplay.js'), import('/src/player.js'), import('/src/inventory-prediction.js')]);
      const registry = await (await fetch(`/data/${version}-registry.json`)).json();
      const { instance } = await WebAssembly.instantiateStreaming(fetch('/public/core.wasm'), {}); instance.exports.world_init(1650);
      const player = new Player(instance.exports), sent = []; let gameplay;
      const session = new MinecraftSession({ registry, onInventory: value => gameplay?.inventory(value), onState: value => gameplay?.state(value), onEvent: value => gameplay?.event(value), transport: { packet(name, data) { sent.push({ name, data }); return true; }, close() {} } });
      gameplay = new ServerGameplay({ session, registry, player, world: instance.exports });
      window.inventoryProof = { session, gameplay, sent, bundleContents }; session.changeState({ status: 'playing', entityId: 9, gameMode: 0 });
    }, version);
    const input = minecraftProtocol.createSerializer({ version, state: 'play', isServer: true }), inputReader = minecraftProtocol.createDeserializer({ version, state: 'play', isServer: false });
    const output = minecraftProtocol.createSerializer({ version, state: 'play', isServer: false }), outputReader = minecraftProtocol.createDeserializer({ version, state: 'play', isServer: true });
    const stack = (name, itemCount = 1) => modern ? { itemId: data.itemsByName[name].id, itemCount, addedComponentCount: 0, removedComponentCount: 0, components: [], removeComponents: [] } : { present: true, itemId: data.itemsByName[name].id, itemCount };
    const empty = modern ? { itemCount: 0 } : { present: false };
    const bundle = items => modern ? { ...stack('bundle'), addedComponentCount: 1, components: [{ type: 'bundle_contents', data: { contents: items } }] } : { ...stack('bundle'), nbtData: { type: 'compound', name: '', value: { Items: { type: 'list', value: { type: 'compound', value: items.map(item => ({ id: { type: 'string', value: `minecraft:${data.items[item.itemId].name}` }, Count: { type: 'byte', value: item.itemCount } })) } } } } };
    const receive = async (name, params) => {
      const packet = inputReader.parsePacketBuffer(input.createPacketBuffer({ name, params })).data;
      await page.evaluate(packet => { const proof = window.inventoryProof; proof.session.receive({ type: 'packet', name: packet.name, data: packet.params }); proof.gameplay.inventoryLastClick = null; proof.gameplay.ignoreInventoryClickUntil = 0; }, packet);
    };
    const content = async (entries, cursor = empty) => receive('window_items', { windowId: 0, stateId: 4, items: Array.from({ length: 46 }, (_, index) => entries[index] || empty), carriedItem: cursor });
    if (!modern) await receive('declare_recipes', { recipes: [{ recipeId: 'minecraft:fixture_honey', type: 'minecraft:crafting_shapeless', data: { category: 0, group: '', ingredients: [[stack('honey_bottle')]], result: stack('sugar', 3) } }] });
    await content({ 0: stack('sugar', 3), 1: stack('honey_bottle', 2), 36: stack('glass_bottle', 60) });
    await page.evaluate(() => window.inventoryProof.gameplay.openPanel('inventory'));
    await page.locator('[data-ui="slots"] [data-slot="0"]').click();
    const craft = await page.evaluate(() => { const window = inventoryProof.session.windows.get(0); return { ingredients: window.slots[1].itemCount, bottles: window.slots[36].itemCount, cursor: window.cursor.itemCount, output: window.slots[0].present, revision: window.stateId }; });
    assert.deepEqual(craft, { ingredients: 1, bottles: 61, cursor: 3, output: false, revision: 4 });
    assert.ok((await page.locator('[data-ui="cursor"]').textContent()).includes('3'));
    await content({ 9: stack('stone', 70) }, bundle([]));
    await page.locator('[data-ui="slots"] [data-slot="9"]').click({ button: modern ? 'left' : 'right' });
    const inserted = await page.evaluate(() => { const proof = inventoryProof, window = proof.session.windows.get(0); return { remaining: window.slots[9].itemCount, contents: proof.bundleContents(window.cursor, proof.session.itemDefinitions, proof.session.adapter.modern).map(item => item.itemCount) }; });
    assert.deepEqual(inserted, { remaining: 6, contents: [64] });
    await page.evaluate(() => { inventoryProof.gameplay.inventoryLastClick = null; inventoryProof.gameplay.ignoreInventoryClickUntil = 0; });
    await page.locator('[data-ui="slots"] [data-slot="10"]').click({ button: 'right' });
    const removed = await page.evaluate(() => { const proof = inventoryProof, window = proof.session.windows.get(0); return { count: window.slots[10].itemCount, contents: proof.bundleContents(window.cursor, proof.session.itemDefinitions, proof.session.adapter.modern).length }; });
    assert.deepEqual(removed, { count: 64, contents: 0 });
    await content({ 9: bundle([stack('stone', 12), stack('dirt', 3)]) });
    if (modern) assert.equal(await page.evaluate(() => inventoryProof.session.selectBundleItem(9, 1)), true);
    await page.locator('[data-ui="slots"] [data-slot="9"]').click({ button: 'right' });
    const selected = await page.evaluate(() => { const window = inventoryProof.session.windows.get(0); return { id: window.cursor.itemId, count: window.cursor.itemCount }; });
    assert.deepEqual(selected, { id: data.itemsByName[modern ? 'dirt' : 'stone'].id, count: modern ? 3 : 12 });
    const packets = (await page.evaluate(() => inventoryProof.sent)).map(packet => outputReader.parsePacketBuffer(output.createPacketBuffer({ name: packet.name, params: packet.data })).data);
    const clicks = packets.filter(packet => packet.name === 'window_click'); assert.equal(clicks.length, 4); assert.deepEqual(clicks[0].params.changedSlots.map(value => value.location), [0, 1, 36]);
    if (modern) assert.deepEqual(packets.find(packet => packet.name === 'select_bundle_item').params, { slotId: 9, selectedItemIndex: 1 });
    proofs.push({ version, craft, inserted, removed, selected, clicks: clicks.map(packet => ({ slot: packet.params.slot, button: packet.params.mouseButton, changed: packet.params.changedSlots.map(value => value.location) })) });
    await mkdir('test-results', { recursive: true }); await page.screenshot({ path: `test-results/inventory-prediction-${version}.png` }); await page.close();
  }
  assert.deepEqual(errors, []); await writeFile('test-results/inventory-prediction.json', JSON.stringify({ proofs, errors }, null, 2)); console.log(JSON.stringify({ proofs, errors }, null, 2));
} finally { await browser.close(); }
