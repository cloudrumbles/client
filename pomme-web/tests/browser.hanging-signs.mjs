import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';

const version = process.env.POMME_MINECRAFT_VERSION ?? '1.20.4', source = process.env.POMME_MINECRAFT_JAR;
if (!source) throw new Error('Set POMME_MINECRAFT_JAR to the original client JAR. Game assets remain private.');
const original = await readFile(source), software = process.env.POMME_SOFTWARE_GPU === '1';
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? '/usr/bin/chromium', headless: true, args: ['--no-sandbox', '--enable-unsafe-webgpu', ...(software ? ['--use-angle=swiftshader', '--enable-features=Vulkan', '--use-vulkan=swiftshader'] : [])] });
const errors = [];
try {
  const page = await browser.newPage({ viewport: { width: 640, height: 360 } });
  await page.route('**/__hanging-sign-original.jar', route => route.fulfill({ status: 200, contentType: 'application/java-archive', body: original }));
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error' && !message.text().includes('404')) errors.push(message.text()); });
  await page.goto(new URL('/src/shaders/world.wgsl', process.env.POMME_URL ?? 'http://127.0.0.1:5173').href);
  const result = await page.evaluate(async version => {
    const [{ createRenderer }, { loadResourcePack }, { BlockEntityScene }, { loadMinecraftRegistry }, { registryStates }, { hangingSignForm, hangingSignAttachment }] = await Promise.all([import('/src/renderer.js'), import('/src/assets.js'), import('/src/block-entities.js'), import('/src/registry.js'), import('/src/anvil.js'), import('/src/hanging-sign.js')]);
    document.body.replaceChildren(); const canvas = document.createElement('canvas'); canvas.style.width = '480px'; canvas.style.height = '270px'; document.body.append(canvas);
    const registry = await loadMinecraftRegistry({ url: `/data/${version}-registry.json` }), pack = await loadResourcePack(new Uint8Array(await (await fetch('/__hanging-sign-original.jar')).arrayBuffer()), { registry }), states = registryStates(registry);
    const check = (condition, message) => { if (!condition) throw new Error(message); }, near = (a, b) => Math.abs(a - b) < 1e-6;
    const rotate = (point, angle, normal = false) => { const origin = normal ? 0 : .5, x = point[0] - origin, z = point[2] - origin, c = Math.cos(angle * Math.PI / 180), s = Math.sin(angle * Math.PI / 180); return [origin + x * c - z * s, point[1], origin + x * s + z * c]; };
    const hanging = [...states.byId.values()].filter(state => state.name.endsWith('_hanging_sign')), attachments = {}, woods = new Set(), allRotations = new Set(), allFacings = new Set();
    for (const state of hanging) {
      const material = pack.materials.get(state.id), form = hangingSignForm(state.name, state.properties, pack.atlas.tileByName), attachment = hangingSignAttachment(state.name, state.properties);
      check(form && material?.model.staticBlockEntity === 'hanging sign' && material.model.supported && !material.unsupported, `Native state ${state.id} did not use its hanging-sign model.`);
      check(material.templateVertices.length === form.vertices.length && material.model.parts.length === form.parts.length, `Native ${state.id} selected wrong visible parts.`);
      for (let i = 0; i < form.vertices.length; i += 14) {
        const p = rotate(form.vertices.subarray(i, i + 3), form.y + form.freeY), n = rotate(form.vertices.subarray(i + 3, i + 6), form.y + form.freeY, true);
        check(p.every((value, axis) => near(value, material.templateVertices[i + axis])) && n.every((value, axis) => near(value, material.templateVertices[i + axis + 3])), `Native ${state.id} lost its source facing or normal.`);
        check([10, 11, 12].every(offset => near(form.vertices[i + offset], material.templateVertices[i + offset])), `Native ${state.id} lost its source sheet UV.`);
      }
      const shapeRefs = registry.collisionShapes.blocks[state.block.name], shapeId = Array.isArray(shapeRefs) ? shapeRefs[state.id - state.block.minStateId] : shapeRefs;
      check(JSON.stringify(material.collisionBoxes) === JSON.stringify(registry.collisionShapes.shapes[shapeId]), `Native ${state.id} changed its authoritative collision.`);
      const particle = pack.atlas.tiles[material.particleTile]; check(particle && !particle.name.startsWith('minecraft:entity/'), `Native ${state.id} lost its inherited breaking-particle tile.`);
      attachments[attachment] = (attachments[attachment] ?? 0) + 1; woods.add(state.block.name.replace(/_(?:wall_)?hanging_sign$/, ''));
      if (attachment === 'wall') allFacings.add(state.properties.facing); else allRotations.add(state.properties.rotation);
    }
    check(hanging.length >= 720 && woods.size >= 10 && Object.keys(attachments).length === 3 && allRotations.size === 16 && allFacings.size === 4, 'All native woods, attachment forms and orientations must bake.');
    const renderer = await createRenderer(canvas); renderer.setTextureAtlas(pack.atlas); renderer.configureWorld({ min: [-4, -4, -4], max: [4, 8, 4], fogDensity: 0 });
    let stateId = 0; const scene = new BlockEntityScene({ renderer, registry, materials: pack.materials, atlas: pack.atlas, getState: () => stateId });
    const frame = { eye: [.5, .45, 2.2], yaw: 0, pitch: 0, timeSeconds: 10, dayPhase: .25, quality: 'low', scale: 1 }, captures = {}, images = {}, picking = {}, alpha = {}, orientations = {};
    const draw = async () => { scene.update(10, frame.eye); renderer.render(frame); return (await renderer.readPixels()).pixels; };
    const changed = (a, b) => { let count = 0; for (let i = 0; i < a.length; i += 4) if (a[i] !== b[i] || a[i + 1] !== b[i + 1] || a[i + 2] !== b[i + 2]) count++; return count; };
    const capture = name => { captures[name] = canvas.toDataURL('image/png'); };
    const clear = () => { scene.clear(); renderer.removeChunk('sign'); stateId = 0; };
    const select = (name, properties = {}) => { clear(); const block = registry.blocks.find(block => block.name === name); check(block, `Missing native ${name}.`); stateId = states.lookup(name, { ...pack.materials.get(block.defaultState).properties, ...properties }); const material = pack.materials.get(stateId); renderer.uploadChunk('sign', material.templateVertices, [], null, { stride: 14, origin: [0, 0, 0] }); return material; };
    const pointAt = angle => { const normal = rotate([0, 0, 1], angle, true); frame.eye = [.5 + normal[0] * 1.7, .45, .5 + normal[2] * 1.7]; frame.yaw = Math.atan2(-normal[0], normal[2]); frame.pitch = 0; };
    const paint = () => scene.consume({ type: 'block-entity', x: 0, y: 0, z: 0, nbt: { front_text: { messages: ['LINE 1', 'LINE 2', 'LINE 3', 'LINE 4'].map(text => JSON.stringify({ text, color: '#40ff80' })), color: 'white', has_glowing_text: true } } });
    const core = (await WebAssembly.instantiate(await (await fetch('/public/core.wasm')).arrayBuffer(), {})).instance.exports;
    const register = material => {
      check(core.world_reset(0, 16, 0, 0, 1, 1) === 1, 'WASM hanging-sign fixture reset failed.'); core.world_set_floor_collision(0); core.block_register(stateId, ...material.color, material.flags);
      const ptr = core.world_float_stage_ptr(); new Float32Array(core.memory.buffer, ptr, material.templateVertices.length).set(material.templateVertices); check(core.block_model_register(stateId, ptr, material.templateVertices.length) === 1, 'WASM native model registration failed.');
      new Float32Array(core.memory.buffer, ptr, material.collisionBoxes.length * 6).set(material.collisionBoxes.flat()); check(core.block_collision_register(stateId, ptr, material.collisionBoxes.length) === 1, 'WASM native collision registration failed.');
      const stage = core.world_stage_ptr(); new Uint16Array(core.memory.buffer, stage, 4096).fill(0); check(core.world_load_section(0, 0, 0, stage, 4096) === 1 && core.block_set(0, 0, 0, stateId) === 1, 'WASM native section load failed.');
    };
    try {
      for (const [attachment, name, properties] of [['wall', 'oak_wall_hanging_sign', { facing: 'south' }], ['ceiling', 'oak_hanging_sign', { attached: 'false', rotation: '0' }], ['ceiling_middle', 'oak_hanging_sign', { attached: 'true', rotation: '0' }]]) {
        clear(); pointAt(0); const sky = await draw(), material = select(name, properties), bare = await draw(); paint(); const text = await draw();
        images[attachment] = { stateId, vertices: material.templateVertices.length / 14, parts: material.model.parts.map(part => part.name), modelPixels: changed(sky, bare), textPixels: changed(bare, text), particleTile: pack.atlas.tiles[material.particleTile].name };
        check(images[attachment].modelPixels > 1000 && images[attachment].textPixels > 200 && scene.stats.signGlyphs === 20, `Native ${attachment} board/text did not render.`);
        // The native four line baselines and 0.9/64 scale stay on the board.
        const glyphs = scene.writer.data.subarray(0, scene.writer.length); for (let i = 0; i < glyphs.length; i += 14) check(glyphs[i + 1] >= 0 && glyphs[i + 1] <= .625 && (near(glyphs[i + 2], .574) || near(glyphs[i + 2], .5739)), 'Native hanging text escaped its board or front anchor.');
        capture(attachment); register(material);
        const boardCollision = core.collides_aabb(.49, .29, .49, .51, .31, .51), plankCollision = core.collides_aabb(.49, .93, .49, .51, .95, .51);
        check(boardCollision === 0 && plankCollision === (attachment === 'wall' ? 1 : 0), `Native ${attachment} replaced its empty board collision with rendered geometry.`);
        check(core.ray_cast(.5, .3, 2, 0, 0, -1, 3) === 1, `Native ${attachment} source board could not be picked.`); const hit = Array.from(new Int32Array(core.memory.buffer, core.ray_hit_ptr(), 7)); check(hit[0] === 0 && hit[1] === 0 && hit[2] === 0 && hit[6] === stateId, 'WASM picked the wrong native hanging sign.');
        picking[attachment] = { stateId, flags: material.flags, collisionBoxes: material.collisionBoxes, boardCollision, plankCollision, hit };
        clear(); pointAt(0); const empty = await draw(), chains = new Float32Array(material.model.parts.filter(part => /chain/i.test(part.name)).flatMap(part => Array.from(material.templateVertices.subarray(part.firstVertex * 14, (part.firstVertex + part.vertexCount) * 14))));
        // Isolate native zero-depth chain planes: opaque texels render while
        // the actual imported sheet holes must discard in the world shader.
        for (let i = 13; i < chains.length; i += 14) chains[i] = 16777216;
        renderer.uploadChunk('sign', chains, [], null, { stride: 14, origin: [0, 0, 0] }); const originalChains = await draw(); capture(`${attachment}-chain-alpha`);
        const tileId = material.templateVertices[12], tile = pack.atlas.tiles[tileId], bytes = new Uint8Array(tile.width * tile.height * 4);
        for (let y = 0; y < tile.height; y++) bytes.set(pack.atlas.pixelsRGBA.subarray(((tile.y + y) * pack.atlas.width + tile.x) * 4, ((tile.y + y) * pack.atlas.width + tile.x + tile.width) * 4), y * tile.width * 4);
        const opaque = bytes.slice(); for (let i = 3; i < opaque.length; i += 4) opaque[i] = 255;
        renderer.updateAtlasTile(tileId, { pixelsRGBA: opaque, width: tile.width, height: tile.height }); const opaqueChains = await draw();
        renderer.updateAtlasTile(tileId, { pixelsRGBA: bytes, width: tile.width, height: tile.height }); const restored = await draw();
        alpha[attachment] = { originalPixels: changed(empty, originalChains), opaquePixels: changed(empty, opaqueChains), holePixels: changed(originalChains, opaqueChains), restoredPixels: changed(originalChains, restored) };
        check(alpha[attachment].originalPixels > 10 && alpha[attachment].opaquePixels > alpha[attachment].originalPixels && alpha[attachment].holePixels > 10 && alpha[attachment].restoredPixels === 0, `Native ${attachment} chain alpha holes or restoration failed: ${JSON.stringify(alpha[attachment])}.`);
        renderer.removeChunk('sign'); pointAt(180); const emptyBack = await draw(); renderer.uploadChunk('sign', chains, [], null, { stride: 14, origin: [0, 0, 0] }); const originalBack = await draw(); capture(`${attachment}-chain-back`);
        alpha[attachment].backPixels = changed(emptyBack, originalBack); check(alpha[attachment].backPixels > 10, `Native no-cull ${attachment} chain disappeared from its reverse side.`);
      }
      for (let rotation = 0; rotation < 16; rotation++) {
        pointAt(rotation * 22.5); clear(); const sky = await draw(), material = select('oak_hanging_sign', { attached: 'false', rotation: String(rotation) }), bare = await draw(); paint(); const text = await draw();
        orientations[`rotation-${rotation}`] = { modelPixels: changed(sky, bare), textPixels: changed(bare, text), rotation: material.model.rotation }; check(orientations[`rotation-${rotation}`].modelPixels > 1000 && orientations[`rotation-${rotation}`].textPixels > 200, `Native rotation segment ${rotation} misaligned its text.`);
        if (rotation % 4 === 0) capture(`rotation-${rotation}`);
      }
      for (const [facing, angle] of Object.entries({ south: 0, west: 90, north: 180, east: 270 })) {
        pointAt(angle); clear(); const sky = await draw(), material = select('oak_wall_hanging_sign', { facing }), bare = await draw(); paint(); const text = await draw(); orientations[facing] = { modelPixels: changed(sky, bare), textPixels: changed(bare, text), rotation: material.model.rotation };
        check(orientations[facing].modelPixels > 1000 && orientations[facing].textPixels > 200, `Native wall facing ${facing} misaligned its text.`); capture(facing);
      }
      for (const wood of woods) { pointAt(0); clear(); const sky = await draw(); select(`${wood}_hanging_sign`, { attached: 'true', rotation: '0' }); images[wood] = { modelPixels: changed(sky, await draw()) }; check(images[wood].modelPixels > 1000, `Native ${wood} sheet was missing.`); if (['bamboo', 'crimson', 'pale_oak'].includes(wood)) capture(wood); }
      check(renderer.stats().lastError === null, renderer.stats().lastError);
      return { version, bakedStates: hanging.length, attachments, woods: [...woods], images, picking, alpha, orientations, renderer: renderer.stats(), captures };
    } finally { scene.clear(); renderer.destroy(); }
  }, version);
  assert.deepEqual(errors, []); await mkdir('test-results', { recursive: true }); for (const [name, data] of Object.entries(result.captures)) await writeFile(`test-results/native-hanging-sign-${version}-${name}.png`, Buffer.from(data.split(',')[1], 'base64')); delete result.captures;
  result.errors = errors; await writeFile(`test-results/native-hanging-signs-${version}.json`, JSON.stringify(result, null, 2)); console.log(JSON.stringify(result, null, 2));
} finally { await browser.close(); }
