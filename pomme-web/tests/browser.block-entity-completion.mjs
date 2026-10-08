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
  await page.route('**/__block-entity-original.jar', route => route.fulfill({ status: 200, contentType: 'application/java-archive', body: original }));
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error' && !message.text().includes('404')) errors.push(message.text()); });
  await page.goto(new URL('/src/shaders/world.wgsl', process.env.POMME_URL ?? 'http://127.0.0.1:5173').href);
  const result = await page.evaluate(async version => {
    const [{ createRenderer }, { loadResourcePack }, { BlockEntityScene }, { loadMinecraftRegistry }] = await Promise.all([import('/src/renderer.js'), import('/src/assets.js'), import('/src/block-entities.js'), import('/src/registry.js')]);
    document.body.replaceChildren(); const canvas = document.createElement('canvas'); canvas.style.width = '480px'; canvas.style.height = '270px'; document.body.append(canvas);
    const registry = await loadMinecraftRegistry({ url: `/data/${version}-registry.json` }), pack = await loadResourcePack(new Uint8Array(await (await fetch('/__block-entity-original.jar')).arrayBuffer()), { registry });
    const renderer = await createRenderer(canvas); renderer.setTextureAtlas(pack.atlas); renderer.configureWorld({ min: [-8, -4, -8], max: [8, 8, 8], fogDensity: 0 });
    const states = new Map(), originals = new Map();
    const scene = new BlockEntityScene({ renderer, registry, materials: pack.materials, atlas: pack.atlas, getState: (x, y, z) => states.get(`${x},${y},${z}`), setVisualOverride(x, y, z, state) { const key = `${x},${y},${z}`; if (state === 0) renderer.removeChunk(key); else { const material = originals.get(key); if (material) renderer.uploadChunk(key, material.templateVertices, [], null, { stride: 14, origin: [x, y, z] }); } } });
    const stateFor = (name, properties = {}) => { const native = registry.blocks.find(block => block.name === name); if (!native) throw new Error(`Missing native block ${name}`); return scene.registry.lookup(name, { ...pack.materials.get(native.defaultState).properties, ...properties }); };
    const upload = (name, properties = {}, x = 0, y = 0, z = 0) => { const id = stateFor(name, properties), material = pack.materials.get(id), key = `${x},${y},${z}`; states.set(key, id); originals.set(key, material); renderer.uploadChunk(key, material.templateVertices, [], null, { stride: 14, origin: [x, y, z] }); return id; };
    const setNbt = nbt => scene.consume({ type: 'block-entity', x: 0, y: 0, z: 0, nbt });
    const frame = { eye: [3, 1.8, 3], yaw: -Math.PI / 4, pitch: -.25, timeSeconds: 10, dayPhase: .25, quality: 'low', scale: 1 };
    const draw = async time => { scene.update(time, frame.eye); renderer.render(frame); return (await renderer.readPixels()).pixels; };
    const changed = (a, b) => { let count = 0; for (let i = 0; i < a.length; i += 4) if (a[i] !== b[i] || a[i + 1] !== b[i + 1] || a[i + 2] !== b[i + 2]) count++; return count; };
    const check = (condition, message) => { if (!condition) throw new Error(message); }, captures = {}, capture = name => { captures[name] = canvas.toDataURL('image/png'); };
    const reset = () => { scene.clear(); for (const key of states.keys()) renderer.removeChunk(key); states.clear(); originals.clear(); };
    try {
      upload('lectern', { has_book: 'false' }); setNbt({}); const bareLectern = await draw(0);
      upload('lectern', { has_book: 'true' }); setNbt({ Book: { id: 'minecraft:written_book', count: 1 } }); const bookLectern = await draw(.1), lecternPixels = changed(bareLectern, bookLectern);
      check(lecternPixels > 100 && scene.stats.lecternBooks === 1, `Native lectern book changed ${lecternPixels} pixels.`); capture('lectern');
      const lecternUploads = scene.stats.uploads; await draw(.2); check(scene.stats.uploads === lecternUploads, 'Stationary lectern must reuse its mesh.');
      const facings = {};
      for (const [index, facing] of ['north', 'east', 'south', 'west'].entries()) { upload('lectern', { has_book: 'true', facing }); setNbt({}); const pixels = await draw(.3 + index * .1); facings[facing] = changed(bareLectern, pixels); check(scene.stats.lecternBooks === 1 && facings[facing] > 50, `Lectern ${facing} has no native book.`); }
      reset(); upload('suspicious_sand', { dusted: '3' }); const bareBrushable = await draw(1);
      setNbt({ item: { id: 'minecraft:diamond', Count: 1, count: 1 }, hit_direction: 3 }); const revealedItem = await draw(1.1), brushingPixels = changed(bareBrushable, revealedItem);
      check(brushingPixels > 20 && scene.stats.brushingItems === 1, `Native brushable item changed ${brushingPixels} pixels.`); capture('brushable');
      const brushingUploads = scene.stats.uploads; await draw(1.2); check(scene.stats.uploads === brushingUploads, 'Stationary revealed item must reuse its mesh.');
      upload('suspicious_sand', { dusted: '0' }); setNbt({ item: { id: 'minecraft:diamond', Count: 1, count: 1 }, hit_direction: 3 }); await draw(1.3); check(scene.stats.brushingItems === 0, 'DUSTED=0 must hide the revealed item.');
      reset(); upload('decorated_pot'); setNbt({ sherds: Array(4).fill('minecraft:archer_pottery_sherd') }); const restingPot = await draw(2), potWobblePixels = {}, potRestPixels = {};
      for (const [style, duration] of [[0, .35], [1, .5]]) { scene.consume({ type: 'block-action', x: 0, y: 0, z: 0, actionId: 1, actionParam: style }); const moved = await draw(scene.time + duration / 4); potWobblePixels[style] = changed(restingPot, moved); check(potWobblePixels[style] > 50 && scene.stats.potWobbles === 1 && scene.stats.decoratedSides === 4, `Pot wobble ${style} changed ${potWobblePixels[style]} pixels.`); capture(`pot-wobble-${style}`); const settled = await draw(scene.time + duration); potRestPixels[style] = changed(restingPot, settled); check(potRestPixels[style] === 0 && scene.stats.potWobbles === 0 && scene.overrides.size === 0, 'Expired wobble must exactly restore its static model and sherds.'); }
      reset(); frame.eye = [1.5, 1.4, 2]; frame.yaw = -Math.atan2(1, 1.5); frame.pitch = -.25; upload('oak_sign', { rotation: '0' }); const plain = { front_text: { messages: [JSON.stringify({ text: 'Native', color: '#20ff40' })], color: 'white', has_glowing_text: true } }; setNbt(plain); const greenSign = await draw(4);
      setNbt({ front_text: { messages: [JSON.stringify({ text: 'Native', color: '#4080ff', bold: true, italic: true, underlined: true, strikethrough: true })], color: 'white', has_glowing_text: true } }); const styledSign = await draw(4.1), styledSignPixels = changed(greenSign, styledSign);
      check(styledSignPixels > 100 && scene.stats.signDecorations === 12 && scene.stats.signOutlines === 96, `Styled native sign changed ${styledSignPixels} pixels.`); capture('styled-sign');
      const styledUploads = scene.stats.uploads; await draw(4.2); check(scene.stats.uploads === styledUploads, 'Unchanged styled sign must reuse its mesh.');
      const half = bits => { const sign = bits & 32768 ? -1 : 1, exponent = bits >> 10 & 31, fraction = bits & 1023; return exponent === 0 ? sign * fraction * 2 ** -24 : exponent === 31 ? fraction ? NaN : sign * Infinity : sign * (1 + fraction / 1024) * 2 ** (exponent - 15); };
      const fullbrightPixels = [];
      for (let i = 0; i < styledSign.length; i += 4) { const r = half(styledSign[i]), g = half(styledSign[i + 1]), b = half(styledSign[i + 2]); if (Math.abs(r - 64 / 255) < .02 && Math.abs(g - 128 / 255) < .02 && Math.abs(b - 1) < .02) fullbrightPixels.push(i); }
      check(fullbrightPixels.length > 20, 'Native fullbright text must retain its capped blue component color.');
      frame.dayPhase = .75; const nightSign = await draw(4.3); let fullbrightDayNightChanges = 0;
      for (const i of fullbrightPixels) { if ([0, 1, 2].some(channel => nightSign[i + channel] !== styledSign[i + channel])) fullbrightDayNightChanges++; check([0, 1, 2].every(channel => half(nightSign[i + channel]) <= 1), 'Native fullbright glyph albedo cannot receive the material emission boost.'); }
      check(fullbrightDayNightChanges === 0, 'Native glowing glyph HDR must be independent of the day/night lightmap.');
      let signLight = { sky: 0, block: 0 }; scene.getLight = () => signLight;
      const nonGlowing = { front_text: { messages: [JSON.stringify({ text: 'Native', color: '#4080ff', bold: true, italic: true, underlined: true, strikethrough: true })], color: 'white', has_glowing_text: false } };
      setNbt(nonGlowing); const darkSign = await draw(4.4); signLight = { sky: 15, block: 15 }; setNbt(nonGlowing); const litSign = await draw(4.5), nonGlowingLightPixels = changed(darkSign, litSign);
      check(nonGlowingLightPixels > 50, 'Non-glowing native glyphs must retain packed sky/block lighting.'); scene.getLight = null; frame.dayPhase = .25;
      const dimensionSignPixels = {};
      for (const [index, y] of [-40000, 40000, -2147483632, 2147483631].entries()) {
        reset(); renderer.configureWorld({ min: [-8, y - 4, -8], max: [8, y + 8, 8], fogDensity: 0 }); frame.eye = [1.5, y + 1.4, 2];
        upload('oak_sign', { rotation: '0' }, 0, y, 0); const bare = await draw(4.3 + index * .2);
        scene.consume({ type: 'block-entity', x: 0, y, z: 0, nbt: { front_text: { messages: [JSON.stringify({ text: 'Native', color: '#4080ff', bold: true, italic: true, underlined: true, strikethrough: true })], color: 'white', has_glowing_text: true } } });
        const painted = await draw(4.4 + index * .2); dimensionSignPixels[y] = changed(bare, painted); check(dimensionSignPixels[y] > 100 && scene.stats.signGlyphs === 6 && scene.stats.signDecorations === 12, `Styled sign lost geometry at Y=${y}.`);
      }
      reset(); renderer.configureWorld({ min: [-8, -4, -8], max: [8, 8, 8], fogDensity: 0 }); frame.eye = [3, 1.8, 3]; frame.yaw = -Math.PI / 4; frame.pitch = -.25; const copper = {};
      for (const name of ['copper_chest', 'exposed_copper_chest', 'weathered_copper_chest', 'oxidized_copper_chest']) {
        if (!registry.blocks.some(block => block.name === name)) continue;
        reset(); upload(name); setNbt({}); const closed = await draw(5); scene.consume({ type: 'block-action', x: 0, y: 0, z: 0, actionId: 1, actionParam: 1 }); const opened = await draw(5.5); copper[name] = changed(closed, opened); check(copper[name] > 100 && scene.stats.containers === 1, `Native ${name} lid changed ${copper[name]} pixels.`); scene.consume({ type: 'block-action', x: 0, y: 0, z: 0, actionId: 1, actionParam: 0 }); await draw(6); check(scene.overrides.size === 0, `${name} must restore its cached model.`);
      }
      const statues = {};
      if (registry.blocks.some(block => block.name === 'copper_golem_statue')) {
        const core = (await WebAssembly.instantiate(await (await fetch('/public/core.wasm')).arrayBuffer(), {})).instance.exports;
        for (const [index, pose] of ['standing', 'running', 'sitting', 'star'].entries()) {
          reset(); const sky = await draw(7 + index * .2), state = upload('copper_golem_statue', { copper_golem_pose: pose, facing: 'south' }), material = pack.materials.get(state), rendered = await draw(7.1 + index * .2);
          const pixels = changed(sky, rendered); check(pixels > 100 && material.model.staticBlockEntity === 'copper statue' && material.model.supported && !material.unsupported && (material.flags & 1) !== 0, `Native statue pose ${pose} did not render its source model.`);
          check(material.collisionBoxes.length > 0, `Native statue ${pose} must retain its authoritative collision shape.`);
          check(core.world_reset(0, 16, 0, 0, 1, 1) === 1, 'Statue picking fixture reset failed.'); core.world_set_floor_collision(0); core.block_register(state, ...material.color, material.flags);
          const floatPtr = core.world_float_stage_ptr(); check(material.templateVertices.length <= core.world_float_stage_capacity(), 'Native statue model exceeds the WASM staging capacity.'); new Float32Array(core.memory.buffer, floatPtr, material.templateVertices.length).set(material.templateVertices); check(core.block_model_register(state, floatPtr, material.templateVertices.length) === 1, 'Native statue picking model registration failed.'); new Float32Array(core.memory.buffer, floatPtr, material.collisionBoxes.length * 6).set(material.collisionBoxes.flat()); check(core.block_collision_register(state, floatPtr, material.collisionBoxes.length) === 1, 'Native statue collision registration failed.');
          const stagePtr = core.world_stage_ptr(); new Uint16Array(core.memory.buffer, stagePtr, 4096).fill(0); check(core.world_load_section(0, 0, 0, stagePtr, 4096) === 1 && core.block_set(0, 0, 0, state) === 1, 'Statue picking fixture load failed.');
          const box = material.collisionBoxes[0], center = [0, 1, 2].map(axis => (box[axis] + box[axis + 3]) / 2);
          check(core.collides_aabb(...center.map(value => value - .01), ...center.map(value => value + .01)) === 1, `Native statue ${pose} lost WASM collision.`);
          check(core.ray_cast(center[0], box[4] + 1, center[2], 0, -1, 0, 3) === 1, `Native statue ${pose} lost WASM picking.`); const hit = Array.from(new Int32Array(core.memory.buffer, core.ray_hit_ptr(), 7)); check(hit[0] === 0 && hit[1] === 0 && hit[2] === 0, `Native statue ${pose} selected a wrong block.`);
          statues[pose] = { pixels, stateId: state, flags: material.flags, collisionBoxes: material.collisionBoxes, hit }; capture(`statue-${pose}`);
        }
      }
      check(renderer.stats().lastError === null, renderer.stats().lastError);
      return { version, lecternPixels, facings, brushingPixels, potWobblePixels, potRestPixels, styledSignPixels, fullbrightPixels: fullbrightPixels.length, fullbrightDayNightChanges, nonGlowingLightPixels, dimensionSignPixels, copper, statues, renderer: renderer.stats(), captures };
    } finally { scene.clear(); renderer.destroy(); }
  }, version);
  assert.deepEqual(errors, []); await mkdir('test-results', { recursive: true }); for (const [name, data] of Object.entries(result.captures)) await writeFile(`test-results/native-completion-${version}-${name}.png`, Buffer.from(data.split(',')[1], 'base64')); delete result.captures;
  result.errors = errors; await writeFile(`test-results/native-block-entity-completion-${version}.json`, JSON.stringify(result, null, 2)); console.log(JSON.stringify(result, null, 2));
} finally { await browser.close(); }
