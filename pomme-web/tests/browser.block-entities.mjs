import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';

const source = process.env.POMME_MINECRAFT_JAR;
if (!source) throw new Error('Set POMME_MINECRAFT_JAR to your original Minecraft Java 1.20.4 client JAR. This test never distributes game assets.');
const original = await readFile(source), software = process.env.POMME_SOFTWARE_GPU === '1';
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? '/usr/bin/chromium', headless: true, args: ['--no-sandbox', '--enable-unsafe-webgpu', ...(software ? ['--use-angle=swiftshader', '--enable-features=Vulkan', '--use-vulkan=swiftshader'] : [])] });
const errors = [];
try {
  const page = await browser.newPage({ viewport: { width: 640, height: 360 } });
  await page.route('**/__original-client.jar', route => route.fulfill({ status: 200, contentType: 'application/java-archive', body: original }));
  page.on('pageerror', error => errors.push(error.message)); page.on('console', message => { if (message.type() === 'error' && !message.text().includes('404')) errors.push(message.text()); });
  await page.goto(new URL('/src/shaders/world.wgsl', process.env.POMME_URL ?? 'http://127.0.0.1:5173').href);
  const result = await page.evaluate(async () => {
    const [{ createRenderer }, { loadResourcePack }, { BlockEntityScene }, { loadMinecraftRegistry }, { SignEditor }] = await Promise.all([import('/src/renderer.js'), import('/src/assets.js'), import('/src/block-entities.js'), import('/src/registry.js'), import('/src/sign-editor.js')]);
    document.body.replaceChildren(); const canvas = document.createElement('canvas'); canvas.style.width = '480px'; canvas.style.height = '270px'; document.body.append(canvas);
    const registry = await loadMinecraftRegistry(), pack = await loadResourcePack(new Uint8Array(await (await fetch('/__original-client.jar')).arrayBuffer()), { registry });
    const renderer = await createRenderer(canvas); renderer.setTextureAtlas(pack.atlas); renderer.configureWorld({ min: [-8, -4, -8], max: [8, 8, 8] });
    const states = new Map(), meshes = new Map(), native = name => registry.blocks.find(block => block.name === name).defaultState;
    const upload = (x, y, z, state) => { const key = `${x},${y},${z}`, material = pack.materials.get(state); states.set(key, state); meshes.set(key, material); renderer.uploadChunk(key, material.templateVertices, [], null, { stride: 14, origin: [x, y, z] }); };
    const scene = new BlockEntityScene({ renderer, registry, materials: pack.materials, atlas: pack.atlas, getState: (x, y, z) => states.get(`${x},${y},${z}`), setVisualOverride(x, y, z, state) { const key = `${x},${y},${z}`; if (state === 0) renderer.removeChunk(key); else renderer.uploadChunk(key, meshes.get(key).templateVertices, [], null, { stride: 14, origin: [x, y, z] }); } });
    const frame = { eye: [.5, 1.8, 4], yaw: 0, pitch: -.25, timeSeconds: 10, dayPhase: .25, quality: 'low', scale: 1 };
    const draw = async time => { scene.update(time, frame.eye, { direction: [Math.sin(frame.yaw) * Math.cos(frame.pitch), Math.sin(frame.pitch), -Math.cos(frame.yaw) * Math.cos(frame.pitch)] }); renderer.render({ ...frame, timeSeconds: 10 + time }); return (await renderer.readPixels()).pixels; };
    const captures = {}, capture = name => { captures[name] = canvas.toDataURL('image/png'); }, reset = () => { scene.clear(); renderer.removeChunk('0,0,0'); states.clear(); meshes.clear(); }, stateFor = (name, properties) => scene.registry.lookup(name, { ...pack.materials.get(native(name)).properties, ...properties });
    const changed = (a, b) => { let count = 0; for (let i = 0; i < a.length; i += 4) if (a[i] !== b[i] || a[i + 1] !== b[i + 1] || a[i + 2] !== b[i + 2]) count++; return count; };
    const check = (condition, message) => { if (!condition) throw new Error(message); };
    try {
      upload(0, 0, 0, native('chest')); scene.consume({ type: 'block-entity', x: 0, y: 0, z: 0, nbt: {} });
      const closed = await draw(0); scene.consume({ type: 'block-action', x: 0, y: 0, z: 0, actionId: 1, actionParam: 1 }); const opened = await draw(.5);
      const chestPixels = changed(closed, opened); check(chestPixels > 100, `Chest open changed only ${chestPixels} HDR pixels.`); check(scene.stats.containers === 1, 'Native lid parts must be rendered.');
      scene.consume({ type: 'block-action', x: 0, y: 0, z: 0, actionId: 1, actionParam: 0 }); await draw(1); check(scene.stats.containers === 0, 'Closing must restore the original cached native model.');
      scene.clear(); renderer.removeChunk('0,0,0'); states.clear(); meshes.clear();
      upload(0, 0, 0, native('oak_sign')); const blank = await draw(1.1); scene.consume({ type: 'block-entity', x: 0, y: 0, z: 0, nbt: { front_text: { messages: ['{"text":"Minecraft"}', '"Native sign"', '"WebGPU"', '"1.20.4"'], color: 'red', has_glowing_text: 1 }, back_text: { messages: ['"Original font"'], color: 'blue' } } }); const written = await draw(1.2);
      const signPixels = changed(blank, written), glyphs = scene.stats.signGlyphs; check(signPixels > 10, `Imported sign text changed only ${signPixels} HDR pixels.`); check(glyphs >= 30, 'Native front/back font glyphs should produce real geometry.');
      scene.clear(); renderer.removeChunk('0,0,0'); states.clear(); meshes.clear();
      upload(0, 0, 0, native('white_banner')); const plainBanner = await draw(1.3); scene.consume({ type: 'block-entity', x: 0, y: 0, z: 0, nbt: { Patterns: [{ Pattern: 'cr', Color: 14 }, { Pattern: 'bo', Color: 11 }] } }); const patternedBanner = await draw(1.4);
      const bannerPixels = changed(plainBanner, patternedBanner); check(bannerPixels > 50, `Native banner patterns changed only ${bannerPixels} HDR pixels.`); check(scene.stats.patterns === 2, 'Server pattern order must produce both real texture layers.');
      scene.clear(); renderer.removeChunk('0,0,0'); states.clear(); meshes.clear();
      upload(0, 0, 0, native('decorated_pot')); const plainPot = await draw(1.5); scene.consume({ type: 'block-entity', x: 0, y: 0, z: 0, nbt: { sherds: Array(4).fill('minecraft:archer_pottery_sherd') } }); const decoratedPot = await draw(1.6);
      const potteryPixels = changed(plainPot, decoratedPot); check(potteryPixels > 50, `Native pottery sherds changed only ${potteryPixels} HDR pixels.`); check(scene.stats.decoratedSides === 4, 'All declared sherd sides must render.');
      scene.clear(); renderer.removeChunk('0,0,0'); states.clear(); meshes.clear();
      upload(0, 0, 0, native('beacon')); const bareBeacon = await draw(1.7);
      for (let x = -1; x <= 1; x++) for (let z = -1; z <= 1; z++) states.set(`${x},-1,${z}`, native('iron_block')); states.set('0,2,0', native('red_stained_glass'));
      scene.consume({ type: 'block-entity', x: 0, y: 0, z: 0, nbt: {} }); const activeBeacon = await draw(1.8), beamSegments = scene.stats.beaconSegments, beaconPixels = changed(bareBeacon, activeBeacon); check(beaconPixels > 100, `Active native beacon changed only ${beaconPixels} HDR pixels.`); check(beamSegments === 2, 'Stained glass must make a separate native colored beam section.');
      states.set('0,3,0', native('stone')); scene.consume({ type: 'block', x: 0, y: 3, z: 0, stateId: native('stone') }); await draw(1.9); check(scene.stats.beaconSegments === 0, 'An actual opaque world block must stop the beacon.');
      scene.clear(); renderer.removeChunk('0,0,0'); states.clear(); meshes.clear();
      states.set('0,0,0', native('moving_piston')); scene.consume({ type: 'block-entity', x: 0, y: 0, z: 0, nbt: { blockState: { Name: 'minecraft:stone', Properties: {} }, facing: 5, extending: 1, progress: .25 } }); const start = await draw(1.9), end = await draw(2);
      const pistonPixels = changed(start, end); check(pistonPixels > 100, `Moving native stone changed only ${pistonPixels} HDR pixels.`); check(states.get('0,0,0') === native('moving_piston'), 'Visual piston motion must preserve the server block state.');
      scene.clear(); renderer.removeChunk('0,0,0'); states.clear(); meshes.clear();
      upload(0, 0, 0, native('enchanting_table')); const bareTable = await draw(2.1); scene.getNearbyPlayers = () => [[.5, 0, 2]];
      scene.consume({ type: 'block-entity', x: 0, y: 0, z: 0, nbt: {} }); const closedBook = await draw(2.1), openBook = await draw(2.6);
      const bookPixels = changed(bareTable, closedBook), bookAnimationPixels = changed(closedBook, openBook); check(bookPixels > 50, `Actual native enchanting book changed only ${bookPixels} HDR pixels.`); check(bookAnimationPixels > 50, `Native opening book changed only ${bookAnimationPixels} HDR pixels.`); check(scene.stats.enchantingBooks === 1 && scene.entities.get('0,0,0').book.open > .99, 'Nearby native player must open the seven-part book.');
      scene.clear(); renderer.removeChunk('0,0,0'); states.clear(); meshes.clear();
      upload(0, 0, 0, native('campfire')); const bareCampfire = await draw(2.7);
      scene.consume({ type: 'block-entity', x: 0, y: 0, z: 0, nbt: { Items: [{ Slot: 0, id: 'minecraft:beef', Count: 1 }, { Slot: 1, id: 'minecraft:chicken', Count: 1 }, { Slot: 2, id: 'minecraft:potato', Count: 1 }, { Slot: 3, id: 'minecraft:cod', Count: 1 }] } }); const cookingCampfire = await draw(2.8), campfirePixels = changed(bareCampfire, cookingCampfire); check(campfirePixels > 20, `Actual cooking item textures changed only ${campfirePixels} HDR pixels.`); check(scene.stats.cookingItems === 4, 'Native campfire must render all four distinct fixed-display cooking slots.');
      scene.clear(); renderer.removeChunk('0,0,0'); states.clear(); meshes.clear();
      upload(0, 0, 0, native('spawner')); const bareSpawner = await draw(2.9);
      scene.consume({ type: 'block-entity', x: 0, y: 0, z: 0, nbt: { SpawnData: { entity: { id: 'minecraft:pig' } }, Delay: 200 } }); const pigSpawner = await draw(3), rotatingSpawner = await draw(3.4), spawnerPixels = changed(bareSpawner, pigSpawner), spawnerAnimationPixels = changed(pigSpawner, rotatingSpawner); check(spawnerPixels > 10, `Actual SpawnData pig changed only ${spawnerPixels} HDR pixels.`); check(spawnerAnimationPixels > 10, `Native rotating spawner changed only ${spawnerAnimationPixels} HDR pixels.`); check(scene.stats.spawnerPreviews === 1 && scene.entities.get('0,0,0').preview.vertices.length > 0, 'Spawner preview must use the source-backed pig mesh.');
      capture('spawner'); reset();
      upload(0, 0, 0, native('red_banner')); scene.consume({ type: 'block-entity', x: 0, y: 0, z: 0, nbt: { Patterns: [{ Pattern: 'cr', Color: 11 }] } }); const clothA = await draw(3.5), clothB = await draw(4.75), bannerAnimationPixels = changed(clothA, clothB); check(bannerAnimationPixels > 10, `Native cloth phase changed only ${bannerAnimationPixels} pixels.`); capture('banner'); reset();
      upload(0, 0, 0, native('bell')); scene.consume({ type: 'block-entity', x: 0, y: 0, z: 0, nbt: {} }); const restingBell = await draw(4.8); scene.consume({ type: 'block-action', x: 0, y: 0, z: 0, actionId: 1, actionParam: 2 }); const ringingBell = await draw(4.9), bellPixels = changed(restingBell, ringingBell); check(bellPixels > 20 && scene.stats.bells === 1, `Native ringing bell changed only ${bellPixels} pixels.`); capture('bell'); reset();
      const skullPixels = {};
      for (const [index, name] of ['piglin_head', 'dragon_head'].entries()) {
        upload(0, 0, 0, stateFor(name, { powered: 'true', rotation: '8' })); scene.consume({ type: 'block-entity', x: 0, y: 0, z: 0, nbt: {} }); const before = await draw(5 + index * .3), after = await draw(5.1 + index * .3); skullPixels[name] = changed(before, after); check(skullPixels[name] > 5 && scene.stats.animatedHeads === 1, `Native powered ${name} changed only ${skullPixels[name]} pixels.`); capture(name); reset();
      }
      upload(0, 0, 0, stateFor('conduit', { waterlogged: 'true' }));
      for (let x = -1; x <= 1; x++) for (let y = -1; y <= 1; y++) for (let z = -1; z <= 1; z++) if (x || y || z) states.set(`${x},${y},${z}`, native('water'));
      for (let x = -2; x <= 2; x++) for (let y = -2; y <= 2; y++) for (let z = -2; z <= 2; z++) if ((x === 0 && (Math.abs(y) === 2 || Math.abs(z) === 2)) || (y === 0 && (Math.abs(x) === 2 || Math.abs(z) === 2)) || (z === 0 && (Math.abs(x) === 2 || Math.abs(y) === 2))) states.set(`${x},${y},${z}`, native('prismarine'));
      scene.getGameTime = () => 39n; scene.consume({ type: 'block-entity', x: 0, y: 0, z: 0, nbt: {} }); const inactiveConduit = await draw(5.5); scene.getGameTime = () => 40n; const activeConduit = await draw(5.55), conduitPixels = changed(inactiveConduit, activeConduit); check(conduitPixels > 20 && scene.stats.activeConduits === 1 && scene.entities.get('0,0,0').conduit.hunting, `Native complete-ring conduit changed only ${conduitPixels} pixels.`); scene.getGameTime = () => 45n; const movingConduit = await draw(5.8), conduitAnimationPixels = changed(activeConduit, movingConduit); check(conduitAnimationPixels > 10, `Native rotating/bobbing conduit changed only ${conduitAnimationPixels} pixels.`); capture('conduit'); reset();
      upload(0, 0, 0, native('end_gateway')); const bareGateway = await draw(6); scene.getGameTime = () => 15n; scene.consume({ type: 'block-entity', x: 0, y: 0, z: 0, nbt: { Age: 100n } }); const spawningGateway = await draw(6.1), gatewayPixels = changed(bareGateway, spawningGateway); check(gatewayPixels > 100 && scene.stats.gatewayBeams === 1, `Native spawning gateway beam changed only ${gatewayPixels} pixels.`); capture('gateway');
      window.__signPackets = []; window.__signEditor = new SignEditor({ atlas: pack.atlas, session: { packet(name, data) { window.__signPackets.push({ name, data }); } }, getMaterial: () => pack.materials.get(native('oak_sign')) });
      check(renderer.stats().lastError === null, renderer.stats().lastError); return { chestPixels, signPixels, bannerPixels, bannerAnimationPixels, potteryPixels, beaconPixels, beamSegments, pistonPixels, bookPixels, bookAnimationPixels, campfirePixels, spawnerPixels, spawnerAnimationPixels, bellPixels, skullPixels, conduitPixels, conduitAnimationPixels, gatewayPixels, glyphs, supportedStates: pack.diagnostics.supportedStates, fontGlyphs: pack.atlas.fontGlyphs.size, atlas: [pack.atlas.width, pack.atlas.height], renderer: renderer.stats(), captures };
    } finally { scene.clear(); renderer.destroy(); }
  });
  await page.evaluate(() => window.__signEditor.consume({ type: 'open-sign', x: -17, y: -60, z: 48, isFrontText: false }));
  await page.getByLabel('Sign line 1', { exact: true }).fill('A'.repeat(40)); await page.getByLabel('Sign line 2', { exact: true }).fill('Native text'); await page.getByRole('button', { name: 'Done', exact: true }).click();
  const packets = await page.evaluate(() => window.__signPackets); assert.equal(packets.length, 1); assert.equal(packets[0].name, 'update_sign'); assert.deepEqual(packets[0].data.location, { x: -17, y: -60, z: 48 }); assert.equal(packets[0].data.isFrontText, false); assert.equal(packets[0].data.text1, 'A'.repeat(15)); assert.equal(packets[0].data.text2, 'Native text');
  const waxed = await page.evaluate(() => window.__signEditor.open({ x: 0, y: 0, z: 0, nbt: { is_waxed: 1 } })); assert.equal(waxed, false); await page.evaluate(() => window.__signEditor.destroy()); result.signEditorPackets = packets.length;
  assert.deepEqual(errors, []); await mkdir('test-results', { recursive: true }); for (const [name, data] of Object.entries(result.captures)) await writeFile(`test-results/native-block-entity-${name}.png`, Buffer.from(data.split(',')[1], 'base64')); delete result.captures; await writeFile('test-results/native-block-entities.json', JSON.stringify(result, null, 2)); console.log(JSON.stringify({ ...result, renderer: { ...result.renderer, adapter: result.renderer.adapter } }, null, 2));
} finally { await browser.close(); }
