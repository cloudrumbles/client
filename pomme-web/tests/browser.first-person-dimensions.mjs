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
  await page.route('**/__first-person-original.jar', route => route.fulfill({ status: 200, contentType: 'application/java-archive', body: original }));
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error' && !message.text().includes('404')) errors.push(message.text()); });
  await page.goto(new URL('/src/shaders/world.wgsl', process.env.POMME_URL ?? 'http://127.0.0.1:5173').href);
  const result = await page.evaluate(async version => {
    const [{ createRenderer }, { loadResourcePack }, { FirstPersonScene }, { MeshWriter }, { MinecraftMaps }, { loadMinecraftRegistry }] = await Promise.all([import('/src/renderer.js'), import('/src/assets.js'), import('/src/first-person.js'), import('/src/entities.js'), import('/src/maps.js'), import('/src/registry.js')]);
    document.body.replaceChildren(); const canvas = document.createElement('canvas'); canvas.style.width = '320px'; canvas.style.height = '180px'; document.body.append(canvas);
    const registry = await loadMinecraftRegistry({ url: `/data/${version}-registry.json` }), pack = await loadResourcePack(new Uint8Array(await (await fetch('/__first-person-original.jar')).arrayBuffer()), { registry });
    const renderer = await createRenderer(canvas); renderer.setTextureAtlas(pack.atlas);
    const maps = new MinecraftMaps({ renderer, registry, worldKey: 'proof:extreme-first-person', indexedDB: null }); maps.setAssets(pack.atlas);
    maps.consume({ itemDamage: 10, scale: 0, locked: true, columns: 128, rows: 128, x: 0, y: 0, data: new Uint8Array(16384).fill(18), icons: [] });
    const slot = name => ({ present: true, itemId: registry.items.find(item => item.name === name).id, itemCount: 1, ...(name === 'filled_map' ? { components: [{ type: 'map_id', data: 10 }], nbtData: { map: 10 } } : {}) }), empty = { present: false };
    // Reserve the native palette tile before measuring steady terrain caches;
    // initial atlas growth legitimately changes the terrain material binding.
    if (!maps.tileForItem(slot('filled_map'))) throw new Error('Native held-map palette tile did not upload.');
    // Capture the actual source vertices passed to the real renderer. The
    // wrapper leaves the upload, dedicated HDR pass and depth attachment live.
    let uploaded; const upload = renderer.uploadFirstPersonMesh.bind(renderer); renderer.uploadFirstPersonMesh = (opaque, transparent, bounds, format) => { uploaded = { vertices: opaque.slice(), origin: [...format.origin], bounds }; return upload(opaque, transparent, bounds, format); };
    const scene = new FirstPersonScene({ renderer, registry, atlas: pack.atlas, materials: pack.materials, maps });
    const stone = registry.blocks.find(block => block.name === 'stone'), wall = new MeshWriter(); wall.box([0, 1.625, -.35], [8, 8, .2], [.15, .15, .15], { position: [0, 0, 0], rotation: [0, 0, 0], scale: 1 }, { tile: pack.materials.get(stone.defaultState).templateVertices[12] });
    const frame = { eye: [0, 1.625, 0], yaw: 0, pitch: 0, dayPhase: .25, timeSeconds: 10, quality: 'low', scale: 1 }, records = {}, captures = {}, reference = {};
    const check = (condition, message) => { if (!condition) throw new Error(message); }, draw = async () => { renderer.render(frame); check(renderer.stats().lastError === null, renderer.stats().lastError); return (await renderer.readPixels()).pixels; };
    const changed = (a, b) => { let count = 0; for (let i = 0; i < a.length; i += 4) if (a[i] !== b[i] || a[i + 1] !== b[i + 1] || a[i + 2] !== b[i + 2]) count++; return count; };
    try {
      for (const y of [0, -2_000_000_000, 2_000_000_000]) {
        scene.clear(); frame.eye = [0, y + 1.625, 0]; renderer.configureWorld({ min: [-16, y - 4, -16], max: [16, y + 16, 16], fogDensity: 0 });
        renderer.uploadChunk('depth-wall', wall.vertices.slice(0, wall.length), [], { min: wall.min.map((value, axis) => value + (axis === 1 ? y : 0)), max: wall.max.map((value, axis) => value + (axis === 1 ? y : 0)) }, { stride: 14, origin: [0, y, 0] });
        const terrain = await draw(), cached = renderer.stats(); records[y] = { renderOrigin: cached.renderOrigin, cachedShadowUpdates: cached.shadowUpdates, cases: {} };
        check(cached.renderOrigin[1] === y, `Renderer did not use the expected local custom dimension at ${y}.`);
        for (const kind of ['arm', 'item', 'map']) {
          scene.clear(); const mainHand = kind === 'arm' ? empty : slot(kind === 'map' ? 'filled_map' : 'diamond_sword'), input = { eye: frame.eye, yaw: 0, pitch: 0, mainHand, offHand: empty };
          scene.update(0, input); const image = await draw(), visiblePixels = changed(terrain, image), current = renderer.stats();
          check(visiblePixels > 30, `Native ${kind} disappeared behind filled terrain depth at Y=${y}: ${visiblePixels}.`);
          check(current.shadowUpdates === cached.shadowUpdates && current.terrainBundleEncodes === cached.terrainBundleEncodes && current.shadowBundleEncodes === cached.shadowBundleEncodes, `Native ${kind} rebuilt cached terrain/shadows at Y=${y}.`);
          const vertices = uploaded.vertices.slice(), origin = [...uploaded.origin]; check(origin[1] === y, `First-person ${kind} retained an absolute Float32 Y.`);
          if (y === 0) reference[kind] = { vertices, image: image.slice() };
          const vertexChanges = vertices.reduce((count, value, index) => count + Number(value !== reference[kind].vertices[index]), 0), pixelChanges = changed(reference[kind].image, image);
          check(vertices.length === reference[kind].vertices.length && vertexChanges === 0 && pixelChanges === 0, `Native ${kind} differs at Y=${y}: ${vertexChanges} vertex floats, ${pixelChanges} HDR pixels.`);
          const uploads = current.firstPersonUploads; scene.update(.01, input); await draw(); check(renderer.stats().firstPersonUploads === uploads && renderer.stats().shadowUpdates === cached.shadowUpdates, 'Stationary custom-dimension hands must reuse their buffers and terrain shadow.');
          records[y].cases[kind] = { visiblePixels, vertices: vertices.length / 14, origin, vertexChanges, pixelChanges, arms: scene.stats.arms, items: scene.stats.items, maps: scene.stats.maps, shadowUpdates: current.shadowUpdates, terrainBundleEncodes: current.terrainBundleEncodes };
          captures[`${kind}-${y}`] = canvas.toDataURL('image/png');
        }
      }
      check(renderer.stats().dynamicMeshes === 0 && renderer.stats().firstPersonMeshes === 1, 'First-person meshes must keep their dedicated depth/HDR layer.');
      return { version, cases: records, renderer: renderer.stats(), captures };
    } finally { scene.clear(); await maps.close(); renderer.destroy(); }
  }, version);
  assert.deepEqual(errors, []); await mkdir('test-results', { recursive: true }); for (const [name, data] of Object.entries(result.captures)) await writeFile(`test-results/native-first-person-${version}-${name}.png`, Buffer.from(data.split(',')[1], 'base64')); delete result.captures;
  result.errors = errors; await writeFile(`test-results/native-first-person-dimensions-${version}.json`, JSON.stringify(result, null, 2)); console.log(JSON.stringify(result, null, 2));
} finally { await browser.close(); }
