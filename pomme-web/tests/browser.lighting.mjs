import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';

const url = process.env.POMME_URL ?? 'http://127.0.0.1:5173';
const software = process.env.POMME_SOFTWARE_GPU === '1', errors = [];
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? '/usr/bin/chromium', headless: true,
  args: ['--no-sandbox', '--enable-unsafe-webgpu', ...(software ? ['--use-angle=swiftshader', '--enable-features=Vulkan', '--use-vulkan=swiftshader'] : [])],
});
try {
  const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error' && !message.text().includes('favicon.ico')) errors.push(message.text()); });
  await page.goto(url);
  await page.waitForFunction(() => document.documentElement.dataset.engine === 'ready' || document.documentElement.dataset.engine === 'error', null, { timeout: 60000 });
  assert.equal(await page.locator('html').getAttribute('data-engine'), 'ready', await page.locator('#error').textContent());
  const ids = await page.evaluate(async () => {
    const { loadMinecraftRegistry } = await import('/src/registry.js');
    const registry = await loadMinecraftRegistry(), world = window.pomme.world;
    document.querySelector('#adaptive').checked = false; document.querySelector('#cycle').checked = false;
    // Hold the source window fixed to test persistence beyond its boundary.
    world.updateCamera = () => {};
    const stone = registry.blocks.find(block => block.name === 'stone').defaultState;
    const glowstone = registry.blocks.find(block => block.name === 'glowstone').defaultState;
    await world.reset({ registry, mode: 'import', worldKey: `local-light-browser:${Date.now()}`, hasSkylight: false });
    const blocks = new Uint16Array(4096);
    for (let z = 0; z < 16; z++) for (let x = 0; x < 16; x++) blocks[4 * 256 + z * 16 + x] = stone;
    await world.ingestSection({ cx: 7, sy: -4, cz: 0, states: blocks });
    await world.ingestSection({ cx: 8, sy: -4, cz: 0, states: new Uint16Array(4096) });
    await world.finishImport();
    window.pomme.player.setPosition([120, -59, 8], { yaw: 1.3, pitch: -.1 });
    return { stone, glowstone };
  });
  await page.waitForFunction(() => window.pomme.world.lightingStats().jobs > 0 && !window.pomme.world.lightingStats().busy, null, { timeout: 30000 });
  assert.equal(await page.evaluate(id => window.pomme.world.setBlock(127, -59, 8, id), ids.glowstone), true);
  await page.waitForFunction(() => {
    const bytes = window.pomme.world.columns.get('7,0').light?.block.get(-4);
    const index = 5 * 256 + 8 * 16 + 15;
    return bytes && ((bytes[index >>> 1] >>> ((index & 1) * 4)) & 15) === 15 && !window.pomme.world.lightingStats().busy;
  }, null, { timeout: 30000 });
  const proof = await page.evaluate(async () => {
    const world = window.pomme.world, neighbor = await world.store.get(8, 0);
    const bytes = neighbor.light?.block.get(-4), index = 5 * 256 + 8 * 16;
    const mesh = window.pomme.core.mesh_chunk(7 + 8 + 8 * 16, 0);
    const vertices = new Float32Array(window.pomme.core.memory.buffer, window.pomme.core.mesh_ptr(), mesh * 14);
    let vertexEmission = 0;
    for (let i = 13; i < vertices.length; i += 14) vertexEmission = Math.max(vertexEmission, Math.round(vertices[i]) >>> 14 & 15);
    return { neighborBlockLight: bytes ? bytes[index >>> 1] >>> ((index & 1) * 4) & 15 : null,
      sourceOutsideNearWindow: !world.contains(8, 0), vertexEmission, lightSections: window.pomme.core.world_light_section_count(), stats: world.lightingStats() };
  });
  assert.equal(proof.sourceOutsideNearWindow, true);
  assert.equal(proof.neighborBlockLight, 14, 'light crosses into an actual persisted column outside the near window');
  assert.equal(proof.vertexEmission, 15, 'actual WASM mesh vertices carry local emission into WebGPU');
  assert.equal(proof.lightSections, 24);
  assert.equal(await page.evaluate(() => window.pomme.world.setBlock(127, -59, 8, 0)), true);
  await page.waitForFunction(() => {
    const light = window.pomme.world.columns.get('7,0').light?.block;
    return light && [...light.values()].every(bytes => bytes.every(value => value === 0)) && !window.pomme.world.lightingStats().busy;
  }, null, { timeout: 30000 });
  const removed = await page.evaluate(async () => {
    const neighbor = await window.pomme.world.store.get(8, 0);
    return [...neighbor.light.block.values()].every(bytes => bytes.every(value => value === 0));
  });
  assert.equal(removed, true, 'emitter removal clears persisted neighbor lighting');
  assert.deepEqual(errors.filter(error => !error.includes('404 (Not Found)')), []);
  await mkdir(new URL('../test-results/', import.meta.url), { recursive: true });
  await writeFile(new URL('../test-results/local-lighting.json', import.meta.url), JSON.stringify({ validation: 'passed', softwareGPU: software, proof }, null, 2));
  console.log(JSON.stringify({ validation: 'passed', softwareGPU: software, proof }, null, 2));
} finally { await browser.close(); }
