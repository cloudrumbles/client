import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import { unzipSync, zipSync } from '../vendor/fflate.js';
import { rgbaPNG } from './entity-fixtures.mjs';

const software = process.env.POMME_SOFTWARE_GPU === '1';
let textures, nativeAssets = false;
if (process.env.POMME_MINECRAFT_JAR) {
  textures = unzipSync(new Uint8Array(await readFile(process.env.POMME_MINECRAFT_JAR)), { filter: entry => /^assets\/minecraft\/(textures\/(map|font)\/.*\.png|font\/.*\.json)$/.test(entry.name) });
  nativeAssets = true;
} else {
  const pixels = new Uint8Array(128 * 128 * 4);
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) pixels.set([255, 255, 0, 255], (y * 128 + x) * 4);
  textures = { 'assets/minecraft/textures/map/map_icons.png': rgbaPNG(128, 128, pixels) };
}
const pack = zipSync(textures, { level: 0 }), errors = [];
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? '/usr/bin/chromium', headless: true, args: ['--no-sandbox', '--enable-unsafe-webgpu', ...(software ? ['--use-angle=swiftshader', '--enable-features=Vulkan', '--use-vulkan=swiftshader'] : [])] });
try {
  const page = await browser.newPage({ viewport: { width: 640, height: 360 } });
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error' && !message.text().includes('404')) errors.push(message.text()); });
  await page.route('**/__map-parity-assets.zip', route => route.fulfill({ body: Buffer.from(pack), contentType: 'application/zip' }));
  await page.goto(new URL('/src/shaders/world.wgsl', process.env.POMME_URL ?? 'http://127.0.0.1:5173').href);
  const result = await page.evaluate(async ({ nativeAssets }) => {
    const { createRenderer } = await import('/src/renderer.js'), { MinecraftMaps } = await import('/src/maps.js'), { loadResourcePack } = await import('/src/assets.js');
    const registry = { version: { minecraftVersion: '1.20.4' }, blocks: [{ id: 0, name: 'air', minStateId: 0, maxStateId: 0, defaultState: 0, states: [], boundingBox: 'empty' }], items: [{ id: 1, name: 'filled_map' }] };
    const bytes = new Uint8Array(await (await fetch('/__map-parity-assets.zip')).arrayBuffer());
    const resources = await loadResourcePack(bytes, { registry });
    document.body.innerHTML = ''; const canvas = document.createElement('canvas'); canvas.style.width = '320px'; canvas.style.height = '180px'; document.body.append(canvas);
    const renderer = await createRenderer(canvas); renderer.setTextureAtlas(resources.atlas); renderer.configureWorld({ min: [-8, -4, -8], max: [8, 8, 8] });
    const maps = new MinecraftMaps({ renderer, registry, worldKey: `test:map:${Date.now()}`, indexedDB: null }); maps.setAssets(resources.atlas);
    const slot = { present: true, itemId: 1, nbtData: { map: 10 } }, check = (condition, message) => { if (!condition) throw new Error(message); };
    const full = packed => ({ itemDamage: 10, scale: 0, locked: true, columns: 128, rows: 128, x: 0, y: 0, data: new Uint8Array(16384).fill(packed), icons: [{ type: 0, x: 0, z: 0, direction: 0, displayName: { text: 'Player' } }] });
    const geometry = tile => { const positions = [[-.75, 0, 0], [.75, 0, 0], [.75, 1.5, 0], [-.75, 1.5, 0]], uv = [[0, 1], [1, 1], [1, 0], [0, 0]]; return new Float32Array([0, 1, 2, 0, 2, 3].flatMap(corner => [...positions[corner], 0, 0, 1, 1, 1, 1, 1, ...uv[corner], tile, 32])); };
    const frame = { eye: [0, .75, 3], yaw: 0, pitch: 0, dayPhase: .25, timeSeconds: 10, quality: 'low', scale: 1 };
    const draw = async () => { renderer.render(frame); return renderer.readPixels(); };
    const half = bits => { const sign = bits & 0x8000 ? -1 : 1, exponent = bits >> 10 & 31, mantissa = bits & 1023; return sign * (exponent ? (1 + mantissa / 1024) * 2 ** (exponent - 15) : mantissa * 2 ** -24); };
    const colored = (image, channel) => { let count = 0; for (let i = 0; i < image.pixels.length; i += 4) { const rgb = [0, 1, 2].map(axis => half(image.pixels[i + axis])); if (rgb[channel] > .05 && rgb[channel] > rgb[(channel + 1) % 3] * 1.5 && rgb[channel] > rgb[(channel + 2) % 3] * 1.5) count++; } return count; };
    const difference = (a, b) => { let count = 0; for (let i = 0; i < a.pixels.length; i += 4) if ([0, 1, 2].reduce((sum, channel) => sum + Math.abs(half(a.pixels[i + channel]) - half(b.pixels[i + channel])), 0) > .05) count++; return count; };
    try {
      maps.consume(full(18)); const initial = maps.tileForItem(slot); renderer.uploadDynamicMesh('__map', geometry(initial.tile), [], { min: [-.75, 0, -.01], max: [.75, 1.5, .01] });
      const red = await draw(), redPixels = colored(red, 0), initialShadowUpdates = renderer.stats().shadowUpdates; check(redPixels > 100, `Native red map colors must reach the GPU (${redPixels}).`);
      const uploads = maps.stats().uploads; for (let i = 0; i < 20; i++) maps.tileForItem(slot); check(maps.stats().uploads === uploads, 'Static maps must reuse their texture without uploads.');
      maps.consume(full(50)); const updated = maps.tileForItem(slot); check(updated.tile === initial.tile, 'Map patches must preserve the existing runtime tile ID.');
      const blue = await draw(), bluePixels = colored(blue, 2), patchPixels = difference(red, blue); check(bluePixels > 100 && patchPixels > 100, `Map patch must update actual GPU pixels (${bluePixels} blue, ${patchPixels} changed).`);
      check(renderer.stats().shadowUpdates === initialShadowUpdates, 'Map texture updates must retain static shadow caches.');
      // Native held/frame variants filter the moving player marker without
      // altering the terrain texture or issuing more world mesh uploads.
      const framed = maps.tileForItem(slot, { frame: true }); renderer.uploadDynamicMesh('__map', geometry(framed.tile), [], { min: [-.75, 0, -.01], max: [.75, 1.5, .01] });
      const filtered = await draw(), iconPixels = difference(blue, filtered); check(iconPixels > 0, 'Native player marker and label must disappear from framed maps.');
      const image = maps.imageForItem(slot); check(image?.startsWith('data:image/png;base64,'), 'Map image previews must use real cached RGBA pixels.');
      check(renderer.stats().lastError === null, renderer.stats().lastError);
      return { nativeAssets, adapter: renderer.stats().adapter, redPixels, bluePixels, patchPixels, iconPixels, initialShadowUpdates, finalShadowUpdates: renderer.stats().shadowUpdates, mapStats: maps.stats(), fontGlyphs: resources.atlas.fontGlyphs?.size || 0, backgroundTile: initial.backgroundTile, gpuError: renderer.stats().lastError };
    } finally { await maps.close(); renderer.removeChunk('__map'); renderer.destroy(); }
  }, { nativeAssets });
  assert.deepEqual(errors, []); await mkdir('test-results', { recursive: true }); await writeFile('test-results/map-rendering.json', JSON.stringify(result, null, 2)); console.log(JSON.stringify(result, null, 2));
} finally { await browser.close(); }
