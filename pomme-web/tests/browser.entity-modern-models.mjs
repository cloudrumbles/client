import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';

const jar = process.env.POMME_MINECRAFT_JAR;
if (!jar) throw new Error('Set POMME_MINECRAFT_JAR to a privately supplied matching client JAR.');
const version = process.env.POMME_MINECRAFT_VERSION ?? '1.21.11', bytes = await readFile(jar), software = process.env.POMME_SOFTWARE_GPU === '1';
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? '/usr/bin/chromium', headless: true,
  args: ['--no-sandbox', '--enable-unsafe-webgpu', ...(software ? ['--use-angle=swiftshader', '--enable-features=Vulkan', '--use-vulkan=swiftshader'] : [])] });
const errors = [], results = [];
try {
  const page = await browser.newPage({ viewport: { width: 480, height: 270 } });
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/private-client.jar', route => route.fulfill({ status: 200, contentType: 'application/zip', body: bytes }));
  await page.route('**/favicon.ico', route => route.fulfill({ status: 204 }));
  await page.goto(new URL('/src/shaders/world.wgsl', process.env.POMME_URL ?? 'http://127.0.0.1:5173').href);
  await page.evaluate(async version => {
    const [{ createRenderer }, { loadResourcePack }, { EntityScene }] = await Promise.all([import('/src/renderer.js'), import('/src/assets.js'), import('/src/entities.js')]);
    const registry = await (await fetch(`/data/${version}-registry.json`)).json();
    const pack = await loadResourcePack(new Uint8Array(await (await fetch('/private-client.jar')).arrayBuffer()), { registry });
    document.body.replaceChildren(); const canvas = document.createElement('canvas'); canvas.style.cssText = 'width:480px;height:270px'; document.body.append(canvas);
    const renderer = await createRenderer(canvas); renderer.setTextureAtlas(pack.atlas); renderer.configureWorld({ min: [-32,-16,-32], max: [32,32,32] });
    const scene = new EntityScene({ renderer, registry, materials: pack.materials, atlas: pack.atlas, getLight: () => ({ sky: 15, block: 0 }) });
    globalThis.entityModernProof = { renderer, scene, registry, pack };
  }, version);
  await mkdir('test-results', { recursive: true });
  const cases = [
    { family: 'happy_ghast', label: 'adult' }, { family: 'happy_ghast', label: 'baby', metadata: { baby: true } },
    { family: 'happy_ghast', label: 'harness', metadata: { is_leash_holder: true }, gear: [[6,'red_harness']] },
    { family: 'nautilus', label: 'adult' }, { family: 'nautilus', label: 'baby', metadata: { baby: true } },
    { family: 'nautilus', label: 'armor', gear: [[6,'copper_nautilus_armor'],[7,'saddle']] },
    { family: 'zombie_nautilus', label: 'temperate' }, { family: 'zombie_nautilus', label: 'coral', metadata: { variant: 1 } },
    { family: 'camel_husk', label: 'saddle', gear: [[7,'saddle']] },
    { family: 'camel', label: 'baby', metadata: { baby: true }, gear: [[7,'saddle']] },
    { family: 'enderman', label: 'invisible-eyes', metadata: { shared_flags: 32 } },
    { family: 'breeze', label: 'invisible-layers', metadata: { shared_flags: 32 } },
    { family: 'zombie', label: 'invisible-equipment', metadata: { shared_flags: 32 }, gear: [[4,'copper_chestplate']] },
    { family: 'chicken', label: 'flight', grounded: false },
    ...['cow','pig','chicken'].flatMap(family => [
      { family, label: 'temperate' }, { family, label: 'warm', metadata: { variant: 1 } }, { family, label: 'cold', metadata: { variant: 2 } },
      { family, label: 'baby', metadata: { variant: 2, baby: true } },
    ]),
  ];
  for (const specification of cases) {
    const result = await page.evaluate(async specification => {
      const { family, label, metadata: values = {}, gear = [] } = specification;
      const { renderer, scene, registry, pack } = globalThis.entityModernProof;
      scene.clear(); scene.time = 0; const definition = registry.entities.find(entity => entity.name === family);
      const large = family === 'happy_ghast', baby = values.baby;
      const frame = { eye: large && !baby ? [5,3,11] : family === 'camel_husk' ? [3,1.5,6] : family === 'enderman' ? [1,2.6,2.8] : [2,1,4],
        yaw: large && !baby ? -Math.atan2(5,11) : family === 'camel_husk' ? -Math.atan2(3,6) : family === 'enderman' ? -Math.atan2(1,2.8) : -Math.atan2(2,4), pitch: 0,
        dayPhase: .22, timeSeconds: 1, gameTime: 1000n, quality: 'low', scale: 1 };
      const half = bits => { const exponent = bits >> 10 & 31, mantissa = bits & 1023, sign = bits & 0x8000 ? -1 : 1;
        return sign * (exponent ? (1 + mantissa / 1024) * 2 ** (exponent - 15) : mantissa * 2 ** -24); };
      const difference = (a,b) => { let count = 0; for (let at = 0; at < a.pixels.length; at += 4)
        if ([0,1,2].some(channel => Math.abs(half(a.pixels[at+channel])-half(b.pixels[at+channel])) > .005)) count++; return count; };
      renderer.render(frame); const empty = await renderer.readPixels();
      const metadata = Object.entries(values).map(([name,value]) => ({ key: definition.metadataKeys.indexOf(name), value }));
      const equipment = gear.map(([slot,name]) => ({ slot, item: { present: true, itemId: registry.items.find(item => item.name === name).id, itemCount: 1 } }));
      const entity = { id: 1, uuid: family, entityType: definition.id, x: 0, y: 0, z: 0, yaw: 0, pitch: 0, metadata, equipment, grounded: specification.grounded ?? true };
      scene.consume({ type: 'spawn', entity }); scene.update(1, frame.eye, { gameTime: 1000n }); renderer.render(frame);
      const initial = await renderer.readPixels(), nativePixels = difference(initial, empty), firstStats = { ...scene.stats };
      if (nativePixels < 50 || firstStats.nativeModels !== 1 || firstStats.approximateModels || firstStats.fallbackModels || firstStats.texturedModels !== 1)
        throw new Error(`${family}/${label} fails original native textured model proof (${nativePixels} pixels; ${JSON.stringify(firstStats)}).`);
      const resolved = scene.skinFor(family, entity, definition), vertices = scene.writer.vertices.slice(0, scene.writer.length);
      const usedTiles = new Set(); for (let at=0;at<vertices.length;at+=14) usedTiles.add(vertices[at+12]);
      if (label === 'harness' && !usedTiles.has(pack.atlas.entityTiles.get('minecraft:entity/equipment/happy_ghast_body/red_harness')))
        throw new Error('Original happy ghast harness sheet was not rendered.');
      if (label === 'armor' && !usedTiles.has(pack.atlas.entityTiles.get('minecraft:entity/equipment/nautilus_body/copper')))
        throw new Error('Original nautilus armor sheet was not rendered.');
      if (family === 'camel_husk' && !usedTiles.has(pack.atlas.entityTiles.get('minecraft:entity/equipment/camel_husk_saddle/saddle')))
        throw new Error('Original camel husk saddle sheet was not rendered.');
      let animationPixels = 0, animationVertices = 0;
      if (['happy_ghast','nautilus','zombie_nautilus'].includes(family) || specification.grounded === false) {
        scene.update(1.4, frame.eye); renderer.render(frame); animationPixels = difference(initial, await renderer.readPixels());
        const animated = scene.writer.vertices.subarray(0, scene.writer.length);
        for(let at=0;at<Math.min(vertices.length,animated.length);at+=14) if([0,1,2].some(axis => Math.abs(vertices[at+axis]-animated[at+axis])>1e-5)) animationVertices++;
        if (animationVertices === 0 || animationPixels < 5)
          throw new Error(`${family}/${label} did not animate its native articulated parts (${animationPixels} pixels,${animationVertices} vertices).`);
      }
      const stats = renderer.stats(); if (stats.lastError) throw new Error(stats.lastError);
      return { family, label, nativePixels, animationPixels, animationVertices, model: resolved.model, originalTextureTile: resolved.skin.tile,
        nativeVertices: firstStats.vertices, nativeEquipmentParts: firstStats.equipmentParts, originalNativeModel: true,
        adapter: stats.adapterInfo, error: stats.lastError };
    }, specification);
    results.push(result); await page.screenshot({ path: `test-results/entity-modern-${version}-${specification.family}-${specification.label}.png` });
  }
  assert.deepEqual(errors, []);
  await writeFile(`test-results/entity-modern-models-${version}.json`, JSON.stringify({ originalAssets: true, version, softwareGPU: software, results, errors }, null, 2));
  await page.evaluate(() => { globalThis.entityModernProof.scene.clear(); globalThis.entityModernProof.renderer.destroy(); });
  console.log(JSON.stringify({ version, results, errors }, null, 2));
} finally { await browser.close(); }
