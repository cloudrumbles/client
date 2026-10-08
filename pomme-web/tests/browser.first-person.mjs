import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import { rgbaPNG } from './entity-fixtures.mjs';

const software = process.env.POMME_SOFTWARE_GPU === '1';
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? '/usr/bin/chromium', headless: true, args: ['--no-sandbox', '--enable-unsafe-webgpu', ...(software ? ['--use-angle=swiftshader', '--enable-features=Vulkan', '--use-vulkan=swiftshader'] : [])] });
const errors = [], pixels = new Uint8Array(64 * 64 * 4); for (let i = 0; i < pixels.length; i += 4) pixels.set([235, 12, 8, 255], i);
const png = rgbaPNG(64, 64, pixels), textureURL = `https://textures.minecraft.net/texture/${'b'.repeat(64)}`;
try {
  const page = await browser.newPage({ viewport: { width: 640, height: 360 } });
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error' && !message.text().includes('404')) errors.push(message.text()); });
  await page.route(textureURL, route => route.fulfill({ status: 200, contentType: 'image/png', body: Buffer.from(png), headers: { 'access-control-allow-origin': '*' } }));
  await page.goto(new URL('/src/shaders/world.wgsl', process.env.POMME_URL ?? 'http://127.0.0.1:5173').href);
  const result = await page.evaluate(async ({ textureURL }) => {
    const { createRenderer } = await import('/src/renderer.js'), { FirstPersonScene } = await import('/src/first-person.js'), { MeshWriter } = await import('/src/entities.js');
    const registry = await (await fetch('/data/1.20.4-registry.json')).json();
    document.body.innerHTML = ''; const canvas = document.createElement('canvas'); canvas.style.width = '320px'; canvas.style.height = '180px'; document.body.append(canvas);
    const renderer = await createRenderer(canvas), check = (condition, message) => { if (!condition) throw new Error(message); };
    const atlasPixels = new Uint8Array(256 * 128 * 4);
    for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) atlasPixels.set([8, 24, 230, 255], (y * 256 + x) * 4);
    for (let y = 0; y < 16; y++) for (let x = 64; x < 80; x++) if (Math.abs((x - 64) - y) < 3) atlasPixels.set([8, 235, 16, 255], (y * 256 + x) * 4);
    const atlas = { width: 256, height: 128, pixelsRGBA: atlasPixels, tiles: [{ id: 0, x: 0, y: 0, width: 64, height: 64 }, { id: 1, x: 64, y: 0, width: 16, height: 16 }], entityTiles: new Map([['minecraft:entity/player/wide/steve', 0]]), itemTiles: new Map([['minecraft:item/diamond_sword', 1], ['minecraft:item/apple', 1]]), itemModels: new Map() };
    renderer.setTextureAtlas(atlas); renderer.configureWorld({ min: [-16, -4, -16], max: [16, 16, 16] });
    const stone = registry.blocks.find(block => block.name === 'stone'), materials = new Map([[stone.defaultState, { fullCube: true, color: [0.9, 0.65, 0.08], flags: 0, faces: {} }]]);
    const scene = new FirstPersonScene({ renderer, registry, atlas, materials }), empty = { present: false }, slot = name => ({ present: true, itemId: registry.items.find(item => item.name === name).id, itemCount: 1 });
    const frame = { eye: [0, 1.62, 0], yaw: 0, pitch: 0, dayPhase: 0.22, timeSeconds: 10, quality: 'low', scale: 1 }, input = { eye: frame.eye, yaw: 0, pitch: 0, mainHand: empty, offHand: empty };
    const halfFloat = bits => { const sign = bits & 0x8000 ? -1 : 1, exponent = (bits >> 10) & 31, mantissa = bits & 1023; return sign * (exponent === 0 ? mantissa * 2 ** -24 : (1 + mantissa / 1024) * 2 ** (exponent - 15)); };
    const colored = (image, channel) => { let count = 0; for (let i = 0; i < image.pixels.length; i += 4) { const rgb = [0, 1, 2].map(axis => halfFloat(image.pixels[i + axis])); if (rgb[channel] > 0.01 && rgb[channel] > rgb[(channel + 1) % 3] * 2.5 && rgb[channel] > rgb[(channel + 2) % 3] * 2.5) count++; } return count; };
    const difference = (a, b) => { let count = 0; for (let i = 0; i < a.pixels.length; i += 4) if ([0, 1, 2].reduce((sum, channel) => sum + Math.abs(halfFloat(a.pixels[i + channel]) - halfFloat(b.pixels[i + channel])), 0) > 0.025) count++; return count; };
    const draw = async (time, changes = {}) => { scene.update(time, { ...input, ...changes }); renderer.render(frame); const image = await renderer.readPixels(); check(renderer.stats().lastError === null, renderer.stats().lastError); return image; };
    try {
      const arm = await draw(0), bluePixels = colored(arm, 2); check(bluePixels > 30, `Original arm geometry must produce visible skin pixels (${bluePixels}).`);
      const shadowUpdates = renderer.stats().shadowUpdates, firstPersonUploads = renderer.stats().firstPersonUploads;
      await draw(0.1); await draw(0.2); check(renderer.stats().firstPersonUploads === firstPersonUploads, 'Stationary arms reuse their previous GPU buffers.');
      scene.setProfile({ uuid: 'account', player: { properties: [{ name: 'textures', value: btoa(JSON.stringify({ textures: { SKIN: { url: textureURL, metadata: { model: 'slim' } } } })) }] } });
      await Promise.all([...scene.skinCache.skins.values()].map(entry => entry.promise));
      const skin = await draw(0.3), redPixels = colored(skin, 0), accountPixels = difference(arm, skin); check(redPixels > 30 && accountPixels > 30, 'Received account skin must appear on the first-person arm.');
      scene.swing(0, 0.3); const swing = await draw(0.4), swingPixels = difference(skin, swing); check(swingPixels > 30, 'The original attack transform must move rendered arm pixels.');
      scene.clear(); const sword = await draw(1, { mainHand: slot('diamond_sword') }), swordPixels = colored(sword, 1); check(swordPixels > 10 && scene.stats.items === 1, `Actual alpha-extruded item texture must be visible (${swordPixels}).`);
      scene.clear(); const block = await draw(2, { mainHand: slot('stone') }), blockPixels = difference(sword, block); check(blockPixels > 30 && scene.stats.vertices === 36, 'Confirmed block item must render its cube, independently of sprite-only items.');
      scene.clear(); const apple = slot('apple'), eatingBefore = await draw(3, { mainHand: apple }), eating = await draw(3.1, { mainHand: apple, use: true, useTicks: 16 }), eatingPixels = difference(eatingBefore, eating); check(eatingPixels > 10, 'Native eating transform changes actual held-item pixels.');
      check(renderer.stats().shadowUpdates === shadowUpdates, 'Hand transforms and account skins must preserve cached terrain shadows.');
      const wall = new MeshWriter(); wall.box([0, 1.62, -0.35], [8, 8, 0.2], [0.15, 0.15, 0.15], { position: [0, 0, 0], rotation: [0, 0, 0], scale: 1 }); renderer.uploadChunk('wall', wall.vertices.slice(0, wall.length), [], { min: wall.min, max: wall.max }, { stride: 14 });
      scene.clear(); renderer.render(frame); const wallOnly = await renderer.readPixels(); const wallShadowUpdates = renderer.stats().shadowUpdates;
      scene.setProfile({ uuid: 'account', player: { properties: [{ name: 'textures', value: btoa(JSON.stringify({ textures: { SKIN: { url: textureURL, metadata: { model: 'slim' } } } })) }] } }); await Promise.all([...scene.skinCache.skins.values()].map(entry => entry.promise));
      const occluded = await draw(4), occlusionPixels = difference(wallOnly, occluded); check(colored(occluded, 0) > 30 && occlusionPixels > 30, 'The hand HDR layer remains visible when world terrain fills the depth buffer.');
      check(renderer.stats().shadowUpdates === wallShadowUpdates, 'First-person geometry does not enter the world shadow caster list.');
      check(renderer.stats().dynamicMeshes === 0 && renderer.stats().firstPersonMeshes === 1, 'Hands use their dedicated HDR layer and separate geometry counters.');
      return { adapter: renderer.stats().adapter, bluePixels, redPixels, accountPixels, swingPixels, swordPixels, blockPixels, eatingPixels, occlusionPixels, shadowUpdates, wallShadowUpdates, finalShadowUpdates: renderer.stats().shadowUpdates, scene: { ...scene.stats }, errors: renderer.stats().lastError };
    } finally { scene.clear(); renderer.destroy(); }
  }, { textureURL });
  assert.deepEqual(errors, []); await mkdir('test-results', { recursive: true }); await writeFile('test-results/first-person-rendering.json', JSON.stringify(result, null, 2)); console.log(JSON.stringify(result, null, 2));
} finally { await browser.close(); }
