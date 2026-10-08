import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';

const version = process.env.POMME_MINECRAFT_VERSION ?? '1.21.11', source = process.env.POMME_MINECRAFT_JAR;
if (!source) throw new Error('Set POMME_MINECRAFT_JAR to the original client JAR. Game assets remain private.');
const original = await readFile(source), software = process.env.POMME_SOFTWARE_GPU === '1';
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? '/usr/bin/chromium', headless: true, args: ['--no-sandbox', '--enable-unsafe-webgpu', ...(software ? ['--use-angle=swiftshader', '--enable-features=Vulkan', '--use-vulkan=swiftshader'] : [])] });
const errors = [];
try {
  const page = await browser.newPage({ viewport: { width: 640, height: 360 } });
  await page.route('**/__conduit-beam-original.jar', route => route.fulfill({ status: 200, contentType: 'application/java-archive', body: original }));
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error' && !message.text().includes('404')) errors.push(message.text()); });
  await page.goto(new URL('/src/shaders/world.wgsl', process.env.POMME_URL ?? 'http://127.0.0.1:5173').href);
  const result = await page.evaluate(async version => {
    const [{ createRenderer }, { loadResourcePack }, { BlockEntityScene }, { loadMinecraftRegistry }, { nativeBeamProfile, nativeBeamQuads }] = await Promise.all([import('/src/renderer.js'), import('/src/assets.js'), import('/src/block-entities.js'), import('/src/registry.js'), import('/src/native-beams.js')]);
    document.body.replaceChildren(); const canvas = document.createElement('canvas'); canvas.style.width = '320px'; canvas.style.height = '180px'; document.body.append(canvas);
    const registry = await loadMinecraftRegistry({ url: `/data/${version}-registry.json` }), pack = await loadResourcePack(new Uint8Array(await (await fetch('/__conduit-beam-original.jar')).arrayBuffer()), { registry });
    const renderer = await createRenderer(canvas); renderer.setTextureAtlas(pack.atlas); renderer.configureWorld({ min: [-8, -8, -8], max: [8, 320, 8], fogDensity: 0 });
    const states = new Map(), originals = new Map(); let gameAge = 39n, elapsed = 0;
    const scene = new BlockEntityScene({ renderer, registry, materials: pack.materials, atlas: pack.atlas, getState: (x, y, z) => states.get(`${x},${y},${z}`), getGameTime: () => gameAge, getPartialTick: () => .25, maxY: 320,
      setVisualOverride(x, y, z, state) { const key = `${x},${y},${z}`; if (!state) renderer.removeChunk(key); else { const material = originals.get(key); if (material) renderer.uploadChunk(key, material.templateVertices, [], null, { stride: 14, origin: [x, y, z] }); } } });
    const stateFor = (name, properties = {}) => { const block = registry.blocks.find(block => block.name === name); if (!block) throw new Error(`Missing native ${name}`); return scene.registry.lookup(name, { ...pack.materials.get(block.defaultState).properties, ...properties }); };
    const upload = (name, properties = {}) => { const state = stateFor(name, properties), material = pack.materials.get(state); states.set('0,0,0', state); originals.set('0,0,0', material); renderer.uploadChunk('0,0,0', material.templateVertices, [], null, { stride: 14, origin: [0, 0, 0] }); return state; };
    const nbt = value => scene.consume({ type: 'block-entity', x: 0, y: 0, z: 0, nbt: value });
    const frame = { eye: [.5, .55, 2.5], yaw: 0, pitch: 0, dayPhase: .25, timeSeconds: 10, quality: 'low', scale: 1 }, direction = () => [Math.sin(frame.yaw) * Math.cos(frame.pitch), Math.sin(frame.pitch), -Math.cos(frame.yaw) * Math.cos(frame.pitch)];
    const check = (condition, message) => { if (!condition) throw new Error(message); }, render = async () => { renderer.render(frame); check(renderer.stats().lastError === null, renderer.stats().lastError); return (await renderer.readPixels()).pixels; };
    const draw = async time => { elapsed = time; scene.update(time, frame.eye, { direction: direction() }); return render(); };
    const changed = (a, b) => { let count = 0; for (let i = 0; i < a.length; i += 4) if ([0, 1, 2].some(channel => a[i + channel] !== b[i + channel])) count++; return count; };
    const half = bits => { const sign = bits & 32768 ? -1 : 1, e = bits >> 10 & 31, m = bits & 1023; return sign * (e === 0 ? m * 2 ** -24 : (1 + m / 1024) * 2 ** (e - 15)); };
    const captures = {}, capture = name => { captures[name] = canvas.toDataURL('image/png'); };
    const reset = () => { scene.clear(); renderer.removeChunk('0,0,0'); renderer.removeMesh('beam-alpha'); states.clear(); originals.clear(); elapsed = 0; };
    const sourceMesh = () => scene.writer.data.slice(0, scene.writer.length);
    const direct = (vertices, bounds = null) => renderer.uploadDynamicMesh(scene.key, vertices, [], bounds, { stride: 14, origin: [0, 0, 0] });
    const ring = []; for (let x = -2; x <= 2; x++) for (let y = -2; y <= 2; y++) for (let z = -2; z <= 2; z++) { const a = [Math.abs(x), Math.abs(y), Math.abs(z)]; if ((x === 0 && (a[1] === 2 || a[2] === 2)) || (y === 0 && (a[0] === 2 || a[2] === 2)) || (z === 0 && (a[0] === 2 || a[1] === 2))) ring.push([x, y, z]); }
    const prepareConduit = count => { reset(); gameAge = 39n; const water = stateFor('water'), prismarine = stateFor('prismarine'); for (let x = -1; x <= 1; x++) for (let y = -1; y <= 1; y++) for (let z = -1; z <= 1; z++) states.set(`${x},${y},${z}`, water); for (const p of ring.slice(0, count)) states.set(p.join(','), prismarine); upload('conduit', { waterlogged: 'true' }); nbt({}); };
    const advanceConduit = target => { const state = scene.entities.get('0,0,0').conduit; while (state.ticks < target) { elapsed += .05; gameAge++; scene.update(elapsed, frame.eye, { direction: direction() }); } };
    const profile = nativeBeamProfile(version), conduit = {}, phases = {}, beacon = {}, gateway = {};
    try {
      prepareConduit(16); const inactive = await draw(0); gameAge = 40n; const activeClosed = await draw(.05); conduit.activationPixels = changed(inactive, activeClosed); check(conduit.activationPixels > 30 && scene.stats.activeConduits === 1 && !scene.entities.get('0,0,0').conduit.hunting, 'Native sixteen-block ring must activate the closed-eye conduit.'); capture('conduit-closed-eye');
      prepareConduit(42); await draw(0); gameAge = 40n; const activeOpen = await draw(.05); conduit.eyePixels = changed(activeClosed, activeOpen); check(conduit.eyePixels > 5 && scene.entities.get('0,0,0').conduit.hunting, `Native forty-two-block ring must display its open eye: ${conduit.eyePixels}.`); capture('conduit-open-eye');
      let previous = activeOpen;
      for (const tick of [65, 66, 131, 132, 197, 198]) { advanceConduit(tick); const pixels = await render(), vertices = sourceMesh(), expected = Math.trunc(tick / 66) % 3 === 1 ? 'wind_vertical' : 'wind'; phases[tick] = { changedPixels: changed(previous, pixels), phase: Math.trunc(tick / 66) % 3, windTile: vertices[72 * 14 + 12], vertices: vertices.length / 14 };
        check(phases[tick].vertices === 288 && phases[tick].windTile === pack.atlas.entityTiles.get(`minecraft:entity/conduit/${expected}`), `Native conduit tick ${tick} selected the wrong wind phase.`); check(phases[tick].changedPixels > 5, `Native conduit tick ${tick} did not animate.`); capture(`conduit-${tick}`); previous = pixels; }
      const complete = sourceMesh(), cage = complete.slice(0, 72 * 14), culledCage = cage.slice(0, 36 * 14); direct(cage); const nativeCage = await render(); direct(culledCage); const culled = await render(); conduit.noCullPixels = changed(nativeCage, culled); check(conduit.noCullPixels > 5, `Native cage backfaces must remain visible through imported sheet holes: ${conduit.noCullPixels}.`); direct(complete); await render(); capture('conduit-native-cage');
      const track = scene.entities.get('0,0,0'), rotation = track.conduit.activeRotation; states.set('1,1,1', stateFor('air')); scene.refreshConduit(track); const stopped = await draw(elapsed + .05); conduit.deactivationPixels = changed(previous, stopped); check(!track.conduit.active && scene.stats.vertices === 36 && track.conduit.activeRotation === rotation, 'Dry conduit must restore its native inactive shell and retain rotation.'); capture('conduit-inactive');

      reset(); frame.eye = [2, 2.5, 4]; frame.yaw = -Math.atan2(1.5, 3.5); frame.pitch = -.1; gameAge = -1n; scene.maxY = 8; upload('beacon');
      const iron = stateFor('iron_block'); for (let x = -1; x <= 1; x++) for (let z = -1; z <= 1; z++) states.set(`${x},-1,${z}`, iron); states.set('0,2,0', stateFor('red_stained_glass')); states.set('0,4,0', stateFor('magenta_stained_glass')); nbt({});
      await draw(0); const sections = scene.entities.get('0,0,0').beamSections; beacon.sections = sections.map(section => ({ y: section.y, height: section.height, color: section.color })); beacon.height = scene.writer.max[1]; beacon.alpha = sourceMesh()[24 * 14 + 9]; check(sections.length === 3 && beacon.height === profile.finalHeight + 4 && beacon.alpha === Math.fround(profile.outerAlpha), 'Original registry version must control native final beam height/alpha.'); capture('beacon');
      const cachedBeam = renderer.stats(); await draw(.05); const animatedBeam = renderer.stats(); beacon.cachedShadow = { staticBefore: cachedBeam.shadowUpdates, staticAfter: animatedBeam.shadowUpdates, dynamicBefore: cachedBeam.dynamicShadowUpdates, dynamicAfter: animatedBeam.dynamicShadowUpdates, dynamicDrawCalls: animatedBeam.dynamicShadowDrawCalls };
      check(cachedBeam.shadowUpdates === animatedBeam.shadowUpdates && cachedBeam.dynamicShadowUpdates === animatedBeam.dynamicShadowUpdates && animatedBeam.dynamicShadowDrawCalls === 0, 'Native fullbright beam animation must preserve cached shadows and skip empty dynamic shadow passes.');
      const allBeams = sourceMesh(), inner = new Float32Array(Array.from({ length: allBeams.length / 42 }, (_, triangle) => allBeams.subarray(triangle * 42, (triangle + 1) * 42)).filter(triangle => (triangle[13] & 64) === 0).flatMap(triangle => Array.from(triangle)));
      renderer.removeChunk('0,0,0'); renderer.removeMesh(scene.key); const skyDay = await render(); direct(inner); const day = await render(); frame.dayPhase = .75; const night = await render(); let corePixels = 0, coreChanges = 0, maxAlbedo = 0;
      for (let i = 0; i < day.length; i += 4) if ([0, 1, 2].some(channel => day[i + channel] !== skyDay[i + channel])) { corePixels++; if ([0, 1, 2].some(channel => day[i + channel] !== night[i + channel])) coreChanges++; maxAlbedo = Math.max(maxAlbedo, ...[0, 1, 2].map(channel => half(day[i + channel]))); }
      beacon.corePixels = corePixels; beacon.dayNightCoreChanges = coreChanges; beacon.maxAlbedo = maxAlbedo; check(corePixels > 100 && coreChanges === 0 && maxAlbedo <= 1, `Native beam core must be unlit capped albedo: ${JSON.stringify(beacon)}.`);
      frame.dayPhase = .25; scene.getLight = () => ({ sky: 0, block: 0 }); scene.dirty = true; scene.update(.1, frame.eye, { direction: direction() }); const darkNative = sourceMesh(); check(darkNative[13] % 64 === 0 && (darkNative[13] & 8) === 0, 'Beam source flags must remain Float32-exact without material emission.');
      frame.eye = [192.5, 2, .5]; scene.dirty = true; scene.update(.2, frame.eye, { scoping: false }); beacon.distantRadius = (scene.writer.max[0] - scene.writer.min[0]) / 2; scene.update(.3, frame.eye, { scoping: true }); beacon.scopedRadius = (scene.writer.max[0] - scene.writer.min[0]) / 2;
      check(Math.abs(beacon.distantRadius - (profile.modern ? .5 : .25)) < 1e-6 && Math.abs(beacon.scopedRadius - .25) < 1e-6, 'Native modern distant beacon radius/scoping did not reach imported geometry.'); scene.getLight = null;

      reset(); scene.maxY = 320; frame.eye = [2, 1.5, 4]; frame.yaw = -Math.atan2(1.5, 3.5); frame.pitch = -.1; upload('end_gateway');
      const portalSheet = pack.atlas.entityTiles.get('minecraft:entity/end_portal'), portal = pack.atlas.tiles[portalSheet], gatewaySheet = pack.atlas.tiles[originals.get('0,0,0').templateVertices[12]];
      check(portal && portal.portalLayers === 15 && gatewaySheet?.portalLayers === 16 && gatewaySheet.aliasOf === portalSheet, 'Imported original portal metadata must reach static gateway geometry.'); gateway.portalSource = portal.name;
      nbt({ Age: 1000n }); const noBeam = await draw(0); nbt({ Age: 99n }); const spawn = await draw(.05); gateway.spawnPixels = changed(noBeam, spawn); gateway.extent = scene.writer.max[1]; check(gateway.spawnPixels > 100 && gateway.extent === (profile.modern ? 319 : 320), 'Native gateway spawn beam must use the version-correct build-height endpoint.'); capture('gateway-spawn');
      nbt({ Age: 1000n }); await draw(.1); scene.consume({ type: 'block-action', x: 0, y: 0, z: 0, actionId: 1, actionParam: 0 }); await draw(.1); const cooling = await draw(.6); gateway.cooldownPixels = changed(noBeam, cooling); gateway.cooldownExtent = scene.writer.max[1]; check(gateway.cooldownPixels > 100 && gateway.cooldownExtent === 35, 'Native ten-tick cooldown must use the 35-block purple beam.'); capture('gateway-cooldown'); await draw(1.6); await draw(2.1); check(scene.stats.gatewayBeams === 0 && scene.stats.vertices === 0, 'Native gateway beam must retire after its forty-tick cooldown.');

      reset(); frame.eye = [.5, 1, 3]; frame.yaw = 0; frame.pitch = 0; frame.dayPhase = .25;
      // Original procedural test texel: source beams accept alpha below the
      // entity cutout threshold, preserve RGBA, and cull the nearer glow face.
      const tile = renderer.appendAtlasTile({ width: 1, height: 1, pixelsRGBA: new Uint8Array([255, 255, 255, 13]) }, { name: 'proof:native-beam-alpha' }).id;
      const rows = outer => new Float32Array(nativeBeamQuads({ height: 2, animationTime: 20, outerAlpha: profile.outerAlpha }).filter(quad => quad.outer === outer).flatMap(quad => [0, 1, 2, 0, 2, 3].flatMap(corner => [...quad.positions[corner], ...quad.normal, 1, 1, 1, quad.alpha, ...quad.uv[corner], tile, quad.flags | 512 | (15 << 10)])));
      const background = await render(); renderer.uploadDynamicMesh('beam-alpha', rows(true), [], null, { stride: 14, origin: [0, 0, 0] }); const glow = await render(), center = (90 * 320 + 160) * 4, alpha = profile.outerAlpha * 13 / 255, expected = [0, 1, 2].map(channel => half(background[center + channel]) * (1 - alpha) + alpha), actual = [0, 1, 2].map(channel => half(glow[center + channel]));
      beacon.lowAlphaGlowPixels = changed(background, glow); beacon.lowAlphaExpected = expected; beacon.lowAlphaActual = actual; check(beacon.lowAlphaGlowPixels > 10 && actual.every((value, channel) => Math.abs(value - expected[channel]) < .001), `Native glow must blend exactly one source-facing low-alpha surface: ${actual} vs ${expected}.`);
      renderer.uploadDynamicMesh('beam-alpha', rows(false), [], null, { stride: 14, origin: [0, 0, 0] }); const solid = await render(); beacon.lowAlphaCore = [0, 1, 2].map(channel => half(solid[center + channel])); check(beacon.lowAlphaCore.every(value => value === 1), 'Native opaque beam must retain RGB despite source alpha below .1.'); capture('beam-alpha');
      return { version, profile, conduit, phases, beacon, gateway, renderer: renderer.stats(), captures };
    } finally { scene.clear(); renderer.destroy(); }
  }, version);
  assert.deepEqual(errors, []); await mkdir('test-results', { recursive: true }); for (const [name, data] of Object.entries(result.captures)) await writeFile(`test-results/native-conduit-beams-${version}-${name}.png`, Buffer.from(data.split(',')[1], 'base64')); delete result.captures;
  result.errors = errors; await writeFile(`test-results/native-conduit-beams-${version}.json`, JSON.stringify(result, null, 2)); console.log(JSON.stringify(result, null, 2));
} finally { await browser.close(); }
