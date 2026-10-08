import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import { zipSync, zlibSync } from '../vendor/fflate.js';
import { createResourcePackProxy } from '../scripts/resource-pack-proxy.mjs';

const enc = new TextEncoder(), base = process.env.POMME_URL ?? 'http://127.0.0.1:5173';
const origin = new URL(base).origin, firstUUID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', secondUUID = '11111111-2222-3333-4444-555555555555';
const join = arrays => { const out = new Uint8Array(arrays.reduce((length, array) => length + array.length, 0)); let offset = 0; for (const array of arrays) { out.set(array, offset); offset += array.length; } return out; };
const crc = bytes => { let value = 0xffffffff; for (const byte of bytes) { value ^= byte; for (let bit = 0; bit < 8; bit++) value = value >>> 1 ^ ((value & 1) ? 0xedb88320 : 0); } return (value ^ 0xffffffff) >>> 0; };
const chunk = (name, data) => { const out = new Uint8Array(data.length + 12), view = new DataView(out.buffer); view.setUint32(0, data.length); out.set(enc.encode(name), 4); out.set(data, 8); view.setUint32(out.length - 4, crc(out.subarray(4, out.length - 4))); return out; };
function png(color) { const header = new Uint8Array(13), view = new DataView(header.buffer); view.setUint32(0, 1); view.setUint32(4, 1); header[8] = 8; header[9] = 6; return join([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', zlibSync(new Uint8Array([0, ...color, 255]))), chunk('IEND', new Uint8Array())]); }
const texture = color => ({ 'assets/minecraft/textures/block/test.png': png(color) });
const basePack = zipSync({ ...texture([220, 20, 20]), 'assets/minecraft/blockstates/stone.json': enc.encode(JSON.stringify({ variants: { '': { model: 'minecraft:block/test' } } })), 'assets/minecraft/models/block/test.json': enc.encode(JSON.stringify({ textures: { all: 'minecraft:block/test' }, elements: [{ from: [0, 0, 0], to: [16, 16, 16], faces: Object.fromEntries(['east', 'west', 'up', 'down', 'south', 'north'].map(face => [face, { texture: '#all', cullface: face }])) }] })) });
const bluePack = zipSync(texture([20, 40, 230])), greenPack = zipSync(texture([20, 220, 40]));
const upstream = createServer((req, res) => { const bytes = req.url === '/blue.zip' ? bluePack : greenPack; res.writeHead(200, { 'Content-Length': bytes.length }); res.end(bytes); });
await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
const upstreamURL = `http://127.0.0.1:${upstream.address().port}`;
const proxy = createResourcePackProxy({ allowedOrigins: [origin], allowPrivateHosts: ['127.0.0.1'], token: 'test-token' });
const gateway = createServer(async (req, res) => { if (!await proxy.handleRequest(req, res)) res.writeHead(404).end(); });
await new Promise(resolve => gateway.listen(0, '127.0.0.1', resolve));
const gatewayURL = `ws://127.0.0.1:${gateway.address().port}/?token=test-token`;
const advertise = (uuid, name, bytes) => ({ type: 'resource-pack', ...proxy.registerAdvertisedPack({ uuid, url: `${upstreamURL}/${name}.zip`, hash: createHash('sha1').update(bytes).digest('hex'), forced: false, promptMessage: { text: 'Use these original test textures?' } }, 'playwright-session') });
const blue = advertise(firstUUID, 'blue', bluePack), green = advertise(secondUUID, 'green', greenPack);
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] });
const errors = [];
try {
  const page = await browser.newPage({ viewport: { width: 900, height: 560 } }); page.on('pageerror', error => errors.push(error.message));
  await page.goto(new URL('/src/server-packs.js', base).href);
  await page.evaluate(async ({ gatewayURL, baseBytes }) => {
    const { ServerResourcePacks } = await import('/src/server-packs.js'); const { loadResourcePack } = await import('/src/assets.js');
    const fullRegistry = await (await fetch('/data/1.20.4-registry.json')).json(), registry = { blocks: fullRegistry.blocks.filter(block => ['air', 'stone'].includes(block.name)) };
    const local = new Uint8Array(baseBytes); window.acknowledgements = []; window.assetColors = []; window.disconnected = false;
    window.manager = new ServerResourcePacks({ gatewayUrl: gatewayURL, preference: 'prompt', session: { packet: (name, data) => window.acknowledgements.push({ name, ...data }), disconnect: () => { window.disconnected = true; } }, applyPacks: async files => {
      const pack = await loadResourcePack([local, ...files], { registry });
      const tile = pack.atlas.tiles.find(tile => tile.name === 'minecraft:block/test'), offset = (tile.y * pack.atlas.width + tile.x) * 4;
      window.assetColors.push(Array.from(pack.atlas.pixelsRGBA.subarray(offset, offset + 3)));
      if (!pack.materials.get(registry.blocks[1].minStateId).templateVertices.length) throw new Error('Stacking partial server texture pack lost the base block model');
    } });
    document.body.replaceChildren(); document.body.style.cssText = 'background:#0c151c;color:#fff;font:16px monospace';
  }, { gatewayURL, baseBytes: Array.from(basePack) });
  await page.evaluate(blue => { window.pendingPack = window.manager.event(blue); }, blue);
  await page.waitForSelector('dialog[open]'); await page.screenshot({ path: new URL('../test-results/server-pack-prompt.png', import.meta.url).pathname }).catch(async error => { await mkdir(new URL('../test-results/', import.meta.url), { recursive: true }); await page.screenshot({ path: new URL('../test-results/server-pack-prompt.png', import.meta.url).pathname }); });
  await page.click('dialog button[data-action="accept"]'); await page.evaluate(() => window.pendingPack);
  let state = await page.evaluate(() => ({ packets: window.acknowledgements, colors: window.assetColors, stats: window.manager.stats() }));
  assert.deepEqual(state.packets.map(packet => packet.result), [3, 4, 0]); assert.deepEqual(state.colors.at(-1), [20, 40, 230]);
  await page.evaluate(green => { window.pendingPack = window.manager.event(green); }, green);
  await page.waitForSelector('dialog[open]'); await page.click('dialog button[data-action="accept"]'); await page.evaluate(() => window.pendingPack);
  state = await page.evaluate(() => ({ colors: window.assetColors, stats: window.manager.stats() })); assert.deepEqual(state.colors.at(-1), [20, 220, 40]); assert.equal(state.stats.loaded, 2);
  await page.evaluate(async uuid => { await window.manager.event({ type: 'remove-resource-pack', uuid }); }, secondUUID);
  assert.deepEqual(await page.evaluate(() => window.assetColors.at(-1)), [20, 40, 230]);
  await page.evaluate(async () => { await window.manager.event({ type: 'remove-resource-pack' }); }); assert.deepEqual(await page.evaluate(() => window.assetColors.at(-1)), [220, 20, 20]);
  const declined = advertise(secondUUID, 'green', greenPack); declined.forced = true;
  await page.evaluate(pack => { window.pendingPack = window.manager.event(pack); }, declined); await page.waitForSelector('dialog[open]');
  assert.match(await page.locator('dialog').innerText(), /Declining this pack disconnects/);
  await page.click('dialog button[data-action="decline"]'); await page.evaluate(() => window.pendingPack);
  assert.equal(await page.evaluate(() => window.disconnected), true);
  const result = await page.evaluate(() => ({ acknowledgements: window.acknowledgements, colors: window.assetColors, stats: window.manager.stats(), disconnected: window.disconnected }));
  assert.deepEqual(errors, []); await mkdir(new URL('../test-results/', import.meta.url), { recursive: true }); await writeFile(new URL('../test-results/server-packs.json', import.meta.url), JSON.stringify({ ...result, errors }, null, 2));
  console.log(JSON.stringify({ acknowledgements: result.acknowledgements.map(packet => packet.result), stackedColors: result.colors, forcedDeclineDisconnects: result.disconnected, errors }, null, 2));
} finally { await browser.close(); proxy.close(); await new Promise(resolve => gateway.close(resolve)); await new Promise(resolve => upstream.close(resolve)); }
