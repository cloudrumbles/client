import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';

const software = process.env.POMME_SOFTWARE_GPU === '1', errors = [];
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? '/usr/bin/chromium', headless: true,
  args: ['--no-sandbox', '--enable-unsafe-webgpu', ...(software ? ['--use-angle=swiftshader', '--enable-features=Vulkan', '--use-vulkan=swiftshader'] : [])],
});
try {
  const page = await browser.newPage({ viewport: { width: 640, height: 360 } });
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error' && !message.text().includes('404')) errors.push(message.text()); });
  await page.goto(new URL('/src/shaders/world.wgsl', process.env.POMME_URL ?? 'http://127.0.0.1:5173').href);
  const result = await page.evaluate(async () => {
    const [{ Player }, { BlockEntityScene }, { createRenderer }, { MeshWriter }] = await Promise.all([import('/src/player.js'), import('/src/block-entities.js'), import('/src/renderer.js'), import('/src/entities.js')]);
    const registry = await (await fetch('/data/1.20.4-registry.json')).json();
    const core = (await WebAssembly.instantiate(await (await fetch('/public/core.wasm')).arrayBuffer(), {})).instance.exports;
    const check = (condition, message) => { if (!condition) throw new Error(message); }, near = (actual, expected) => check(Math.abs(actual - expected) < 1e-6, `${actual} != ${expected}`);
    const stone = registry.blocks.find(block => block.name === 'stone').defaultState, moving = registry.blocks.find(block => block.name === 'moving_piston').defaultState, shulker = registry.blocks.find(block => block.name === 'shulker_box').defaultState;
    const cube = new MeshWriter(); cube.box([.5, .5, .5], [1, 1, 1], [.75, .45, .1], { position: [0, 0, 0], rotation: [0, 0, 0], scale: 1 });
    const template = cube.vertices.slice(0, cube.length);
    const materials = new Map([[0, { name: 'air', flags: 0, collisionBoxes: [] }], [stone, { name: 'minecraft:stone', flags: 1, collisionBoxes: [[0, 0, 0, 1, 1, 1]], templateVertices: template }], [moving, { name: 'minecraft:moving_piston', flags: 0, collisionBoxes: [], templateVertices: [] }], [shulker, { name: 'minecraft:shulker_box', flags: 1, collisionBoxes: [[0, 0, 0, 1, 1, 1]], properties: { facing: 'up' }, model: { rotation: [0, 0, 0] }, templateVertices: [] }]]);
    core.world_reset(0, 64, 0, 0, 2, 2); core.world_set_floor_collision(0);
    for (const [id, material] of materials) { core.block_register(id, .5, .5, .5, material.flags); const ptr = core.world_float_stage_ptr(); new Float32Array(core.memory.buffer, ptr, material.collisionBoxes.length * 6).set(material.collisionBoxes.flat()); core.block_collision_register(id, ptr, material.collisionBoxes.length); }
    for (let x = 0; x < 2; x++) for (let z = 0; z < 2; z++) { const states = new Uint16Array(4096), ptr = core.world_stage_ptr(); states.fill(stone, 0, 256); new Uint16Array(core.memory.buffer, ptr, 4096).set(states); core.world_load_section(x, 0, z, ptr, 4096); }
    core.block_set(2, 1, 3, moving); core.block_set(7, 1, 3, shulker);
    document.body.innerHTML = ''; const canvas = document.createElement('canvas'); canvas.style.width = '640px'; canvas.style.height = '360px'; document.body.append(canvas);
    const renderer = await createRenderer(canvas), scene = new BlockEntityScene({ renderer, registry, materials, getState: core.block_get, getGameTime: () => BigInt(Math.floor(scene.time * 20 + 1e-7)), setVisualOverride: () => {} });
    const player = new Player(core, { materials }); player.setPosition([2.4, 1, 3.5]); player.grounded = true; player.setCollisionProvider((bounds, options) => scene.collisionBoxes(bounds, options), (bounds, options) => scene.collisionEntries(bounds, options));
    const atlas = { width: 16, height: 16, pixelsRGBA: new Uint8Array(16 * 16 * 4).fill(255), tiles: [{ id: 0, x: 0, y: 0, width: 16, height: 16 }] };
    renderer.setTextureAtlas(atlas); renderer.configureWorld({ min: [0, 0, 0], max: [32, 64, 32] });
    const floor = new MeshWriter(); floor.box([5, .5, 4], [12, 1, 12], [.25, .45, .2], { position: [0, 0, 0], rotation: [0, 0, 0], scale: 1 }); renderer.uploadChunk('floor', floor.vertices.slice(0, floor.length), [], { min: floor.min, max: floor.max }, { stride: 14 });
    const frame = { eye: [6, 4, 8], yaw: -.674740942, pitch: -.302745952, dayPhase: .22, timeSeconds: 10, quality: 'low', scale: 1 };
    const revisions = Array.from({ length: core.world_chunk_count() }, (_, index) => core.chunk_revision(index));
    const positions = [], motions = [];
    try {
      scene.consume({ type: 'block-entity', x: 2, y: 1, z: 3, nbt: { blockState: { Name: 'minecraft:stone' }, facing: 5, extending: true, source: false, progress: 0 } });
      scene.update(0, frame.eye); renderer.render(frame); const before = await renderer.readPixels();
      for (const time of [.02, .05, .075, .1]) {
        scene.update(time, frame.eye); const events = scene.drainBlockMotions(); motions.push(...events.map(event => ({ kind: event.kind, tick: String(event.tick), previous: event.previousProgress, current: event.currentProgress })));
        player.applyBlockMotions(events); positions.push([...player.position]); renderer.render(frame);
      }
      const after = await renderer.readPixels();
      near(positions[0][0], 2.4); near(positions[1][0], 2.81); near(positions[2][0], 2.81); near(positions[3][0], 3.31);
      check(motions.length === 2 && motions[0].current === .5 && motions[1].current === 1, 'Exactly two native piston ticks must drive browser displacement.');
      let changedPixels = 0; for (let index = 0; index < before.pixels.length; index += 4) if ([0, 1, 2].some(channel => Math.abs(before.pixels[index + channel] - after.pixels[index + channel]) > 10)) changedPixels++;
      check(changedPixels > 100, `Moving native collision/render geometry must change GPU pixels (${changedPixels}).`);
      player.setPosition([7.5, 2.05, 3.5]); player.grounded = false;
      scene.consume({ type: 'block-entity', x: 7, y: 1, z: 3, nbt: {} }); scene.consume({ type: 'block-action', x: 7, y: 1, z: 3, actionId: 1, actionParam: 1 });
      scene.update(.15, frame.eye); const lid = scene.drainBlockMotions(); player.applyBlockMotions(lid);
      near(player.position[1], 2.160000001490116); check(lid.length === 1 && lid[0].kind === 'shulker', 'Native lid action must push its local player.');
      scene.consume({ type: 'block-action', x: 7, y: 1, z: 3, actionId: 1, actionParam: 0 }); scene.update(.2, frame.eye); check(scene.drainBlockMotions().length === 0, 'Closing lids cannot push actors.');
      check(core.block_get(2, 1, 3) === moving && core.block_get(7, 1, 3) === shulker, 'Authoritative block states stay unchanged while block entities animate.');
      check(revisions.every((revision, index) => revision === core.chunk_revision(index)), 'Actor pushes must not invalidate authoritative voxel meshes or light caches.');
      check(renderer.stats().lastError === null, renderer.stats().lastError);
      return { validation: 'passed', adapter: renderer.stats().adapter, positions, motions, shulkerY: player.position[1], changedPixels, authoritativeStatesUnchanged: true, rendererError: renderer.stats().lastError };
    } finally { scene.clear(); renderer.destroy(); }
  });
  assert.deepEqual(errors, []); await mkdir('test-results', { recursive: true }); await writeFile('test-results/dynamic-collision.json', JSON.stringify({ ...result, softwareGPU: software }, null, 2)); console.log(JSON.stringify(result, null, 2));
} finally { await browser.close(); }
