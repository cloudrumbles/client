import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { once } from 'node:events';
import { chromium } from 'playwright';
import { WebSocketServer } from 'ws';
import minecraftData from 'minecraft-data';
import minecraftProtocol from 'minecraft-protocol';
import { installNativeCodecs } from '../scripts/native-codec.mjs';

installNativeCodecs('26.1');
const base = process.env.POMME_URL || 'http://127.0.0.1:5173';
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] });
const proofs = [], errors = [];
try {
  for (const version of ['1.21.11', '26.1']) {
    const official = JSON.parse(await readFile(new URL(`./fixtures/native-bundle/${version}.json`, import.meta.url))), data = minecraftData(version);
    const incoming = minecraftProtocol.createSerializer({ version, state: 'play', isServer: true }), incomingReader = minecraftProtocol.createDeserializer({ version, state: 'play', isServer: false });
    const outgoing = minecraftProtocol.createSerializer({ version, state: 'play', isServer: false }), outgoingReader = minecraftProtocol.createDeserializer({ version, state: 'play', isServer: true });
    const stack = (name, itemCount = 1, components = []) => ({ itemId: data.itemsByName[name].id, itemCount, addedComponentCount: components.length, removedComponentCount: 0, components, removeComponents: [] });
    const bundle = key => stack('bundle', 1, key === 'empty' ? [] : [incoming.proto.read(Buffer.concat([Buffer.from([version === '26.1' ? 50 : 48]), Buffer.from(official.cases[key].wire, 'hex')]), 0, 'SlotComponent').value]);
    const hashed = (name, itemCount = 1, hash) => ({ itemId: data.itemsByName[name].id, itemCount, components: hash === undefined ? [] : [{ type: 'bundle_contents', hash }], removeComponents: [] });
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0 }); await once(server, 'listening');
    const serverPackets = [], rejected = [], accepted = []; let socket, pending;
    server.on('connection', connection => {
      socket = connection;
      socket.on('message', message => {
        try {
          const payload = JSON.parse(message), bytes = outgoing.createPacketBuffer({ name: payload.name, params: payload.data });
          const packet = outgoingReader.parsePacketBuffer(bytes).data; serverPackets.push(packet);
          if (packet.name !== 'window_click') return;
          assert.ok(pending, 'the fixture must have an authoritative action to accept');
          pending.check(packet.params); accepted.push({ action: pending.action, bytes: bytes.toString('hex'), packet });
          const resolve = pending.resolve; pending = null; resolve();
          // Native accepted predictions send no set_slot/window_items echo.
        } catch (error) { rejected.push(error.message); pending?.reject(error); pending = null; }
      });
    });
    const page = await browser.newPage({ viewport: { width: 1040, height: 740 } }); page.on('pageerror', error => errors.push(error.message));
    await page.context().grantPermissions(['local-network-access'], { origin: new URL(base).origin });
    page.on('console', message => { if (message.type() === 'error') console.error(message.text()); });
    try {
      await page.route('**/__bundle_inventory', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><head><title>Native bundle inventory</title></head><body><canvas id="world"></canvas><nav id="hotbar"></nav></body></html>' }));
      await page.goto(`${base}/__bundle_inventory`);
      await page.evaluate(async ({ version, port }) => {
        const [{ MinecraftSession }, { ServerGameplay }, { Player }, { bundleContents }] = await Promise.all([import('/src/minecraft.js'), import('/src/gameplay.js'), import('/src/player.js'), import('/src/inventory-prediction.js')]);
        const registry = await (await fetch(`/data/${version}-registry.json`)).json(), { instance } = await WebAssembly.instantiateStreaming(fetch('/public/core.wasm'), {}); instance.exports.world_init(1650);
        const player = new Player(instance.exports), socket = new WebSocket(`ws://127.0.0.1:${port}`); window.bundleSocket = socket;
        await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', () => reject(new Error('Bundle fixture socket failed')), { once: true }); });
        let gameplay; const session = new MinecraftSession({ registry, onInventory: value => gameplay?.inventory(value), onState: value => gameplay?.state(value), onEvent: value => gameplay?.event(value), transport: { packet(name, data) { socket.send(JSON.stringify({ name, data })); return true; }, close() { socket.close(); } } });
        gameplay = new ServerGameplay({ session, registry, player, world: instance.exports });
        window.bundleProof = { session, gameplay, socket, bundleContents, received: 0 };
        socket.addEventListener('message', event => { session.receive(JSON.parse(event.data)); gameplay.inventoryLastClick = null; gameplay.ignoreInventoryClickUntil = 0; bundleProof.received++; });
        session.changeState({ status: 'playing', entityId: 9, gameMode: 0 });
      }, { version, port: server.address().port });
      const content = async (entries, cursor = { itemCount: 0 }) => {
        const packet = incomingReader.parsePacketBuffer(incoming.createPacketBuffer({ name: 'window_items', params: { windowId: 0, stateId: 4, items: Array.from({ length: 46 }, (_, i) => entries[i] || { itemCount: 0 }), carriedItem: cursor } })).data;
        const received = await page.evaluate(() => bundleProof.received); socket.send(JSON.stringify({ type: 'packet', name: packet.name, data: packet.params }));
        await page.waitForFunction(count => bundleProof.received > count, received);
      };
      const accept = async (action, check, click) => {
        const promise = new Promise((resolve, reject) => { pending = { action, check, resolve, reject }; });
        await click(); await Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error(`No ${action} click received`)), 4000))]);
        await page.evaluate(() => { bundleProof.gameplay.inventoryLastClick = null; bundleProof.gameplay.ignoreInventoryClickUntil = 0; });
      };
      await content({ 9: stack('stone', 64) }, bundle('empty'));
      await page.evaluate(() => bundleProof.gameplay.openPanel('inventory'));
      const slot = index => page.locator(`[data-ui="slots"] [data-slot="${index}"]`);
      await accept('insert stone64', packet => {
        assert.equal(packet.stateId, 4); assert.equal(packet.slot, 9); assert.equal(packet.mouseButton, 0);
        assert.deepEqual(packet.changedSlots, [{ location: 9, item: undefined }]); assert.deepEqual(packet.cursorItem, hashed('bundle', 1, official.cases.stone64.hash));
      }, () => slot(9).click());
      await accept('remove stone64', packet => {
        assert.equal(packet.stateId, 4); assert.equal(packet.slot, 10); assert.equal(packet.mouseButton, 1);
        assert.deepEqual(packet.changedSlots, [{ location: 10, item: hashed('stone', 64) }]); assert.deepEqual(packet.cursorItem, hashed('bundle'));
      }, () => slot(10).click({ button: 'right' }));
      const released = await page.evaluate(() => { const w = bundleProof.session.windows.get(0); return { count: w.slots[10].itemCount, cursorComponents: w.cursor.components, stateId: w.stateId, received: bundleProof.received }; });
      assert.deepEqual(released, { count: 64, cursorComponents: [], stateId: 4, received: 1 });
      await page.mouse.move(0, 0); await content({ 9: bundle('stone12dirt3') }); await slot(9).hover();
      await page.mouse.wheel(0, -100); await page.waitForFunction(() => bundleProof.session.windows.get(0).slots[9].bundleSelectedItem === 1);
      assert.equal(await page.locator('.server-bundle-selected').textContent(), 'Dirt');
      assert.equal(await page.locator('.server-bundle-cell.selected').getAttribute('data-bundle-index'), '1');
      await accept('remove selected dirt3', packet => {
        assert.equal(packet.stateId, 4); assert.equal(packet.slot, 9); assert.equal(packet.mouseButton, 1);
        assert.deepEqual(packet.changedSlots, [{ location: 9, item: hashed('bundle', 1, official.cases.stone12.hash) }]); assert.deepEqual(packet.cursorItem, hashed('dirt', 3));
      }, () => slot(9).click({ button: 'right' }));
      const extracted = await page.evaluate(() => { const w = bundleProof.session.windows.get(0); return { cursorId: w.cursor.itemId, cursorCount: w.cursor.itemCount, selection: w.slots[9].bundleSelectedItem, contents: bundleProof.bundleContents(w.slots[9], bundleProof.session.itemDefinitions).map(x => x.itemCount), received: bundleProof.received }; });
      assert.deepEqual(extracted, { cursorId: data.itemsByName.dirt.id, cursorCount: 3, selection: -1, contents: [12], received: 2 });
      assert.ok(serverPackets.some(packet => packet.name === 'select_bundle_item' && packet.params.slotId === 9 && packet.params.selectedItemIndex === 1));
      await page.mouse.move(0, 0);
      const items = Array.from({ length: 13 }, (_, i) => stack(['stone','dirt','cobblestone','granite','andesite','diorite','sand','red_sand','gravel','oak_log','birch_log','spruce_log','jungle_log'][i], 2));
      await content({ 9: stack('bundle', 1, [{ type: 'bundle_contents', data: { contents: items } }]) }); await slot(9).hover();
      assert.equal(await page.locator('.server-bundle-cell').count(), 12); assert.equal(await page.locator('[data-bundle-surplus]').textContent(), '+10');
      assert.deepEqual(await page.locator('[data-bundle-index]').evaluateAll(nodes => nodes.map(node => Number(node.dataset.bundleIndex))), [0,1,2,3,4,5,6,7]);
      await page.mouse.wheel(0, -900); await page.waitForFunction(() => bundleProof.session.windows.get(0).slots[9].bundleSelectedItem === 7);
      await page.mouse.move(0, 0); await page.waitForFunction(() => bundleProof.session.windows.get(0).slots[9].bundleSelectedItem === -1);
      const hidden = bundle('stone12'); hidden.components.push({ type: 'tooltip_display', data: { hideTooltip: false, hiddenComponents: [version === '26.1' ? 50 : 48] } }); hidden.addedComponentCount++;
      await content({ 9: hidden }); await slot(9).hover(); assert.equal(await page.locator('.server-bundle-tooltip').isVisible(), false);
      await page.mouse.move(0, 0); await content({ 9: bundle('stone64') }); await slot(9).hover();
      assert.equal(await page.locator('.server-bundle-meter-fill').evaluate(node => node.style.width), '94px'); assert.equal(await page.locator('.server-bundle-meter-label').textContent(), 'Full');
      assert.equal(accepted.length, 3); assert.deepEqual(rejected, []);
      const proof = { version, accepted, receivedCorrections: 0, released, extracted, selections: serverPackets.filter(packet => packet.name === 'select_bundle_item').map(packet => packet.params), rejected };
      proofs.push(proof); await mkdir('test-results', { recursive: true }); await page.screenshot({ path: `test-results/bundle-inventory-${version}.png` });
    } finally { socket?.close(); await page.close(); await new Promise(resolve => server.close(resolve)); }
  }
  assert.deepEqual(errors, []); await writeFile('test-results/bundle-inventory.json', JSON.stringify({ proofs, errors }, null, 2)); console.log(JSON.stringify({ proofs, errors }, null, 2));
} finally { await browser.close(); }
