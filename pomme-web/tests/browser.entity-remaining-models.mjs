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
    globalThis.entityRemainingProof = { renderer, scene, registry, pack };
  }, version);
  await mkdir('test-results', { recursive: true });
  const registry = JSON.parse(await readFile(new URL(`../data/${version}-registry.json`, import.meta.url)));
  const available = new Set(registry.entities.map(entity => entity.name));
  const cases = [
    ...['red-blue','blue','green','yellow-blue','grey'].map((label,variant)=>({family:'parrot',label,metadata:{variant}})),
    {family:'parrot',label:'sitting',metadata:{flags:1}}, {family:'parrot',label:'flight',grounded:false,animate:true},
    {family:'phantom',label:'adult',animate:true}, {family:'phantom',label:'large',metadata:{size:4},animate:true},
    {family:'phantom',label:'invisible-eyes',metadata:{shared_flags:32}},
    {family:'tadpole',label:'swimming',animate:true},
    {family:'armadillo',label:'adult'}, {family:'armadillo',label:'baby',metadata:{baby:true}},
    {family:'armadillo',label:'shell',metadata:{armadillo_state:2}},
    {family:'armadillo',label:'rolling',metadata:{armadillo_state:1},animate:true},
    {family:'creaking',label:'active',metadata:{is_active:true}},
    {family:'creaking',label:'invisible-eyes',metadata:{is_active:true,shared_flags:32}},
    {family:'creaking',label:'teardown',metadata:{is_active:true,is_tearing_down:true},animate:true},
    {family:'warden',label:'idle',animate:true}, {family:'warden',label:'roar',metadata:{pose:11},animate:true},
    {family:'warden',label:'tendrils',status:61,initialTime:.1,animate:true},
    ...['copper','exposed','weathered','oxidized'].map((label,weather_state)=>({family:'copper_golem',label,metadata:{weather_state,mob_flags:1}})),
    {family:'copper_golem',label:'held-item',gear:[[0,'copper_ingot']]},
    {family:'copper_golem',label:'dropping-item',gear:[[0,'copper_ingot']],metadata:{copper_golem_state:3},animate:true},
    {family:'bogged',label:'mushrooms'}, {family:'bogged',label:'sheared',metadata:{sheared:true}},
    {family:'giant',label:'native'}, {family:'mannequin',label:'default-profile'},
    {family:'mannequin',label:'resource-skin-patch',metadata:{profile:{skinPatch:{body:'minecraft:entity/player/wide/steve',model:'wide'}}}},
    {family:'oak_boat',label:'native'}, {family:'oak_boat',label:'bubble',metadata:{bubble_time:60},initialTime:.1,animate:true},
    {family:'oak_boat',label:'hurt',metadata:{hurt:8,damage:4,hurtdir:-1},initialTime:.05,animate:true},
    {family:'pale_oak_chest_boat',label:'native'},
    {family:'bamboo_raft',label:'rowing',metadata:{paddle_left:true},animate:true}, {family:'bamboo_chest_raft',label:'native'},
    {family:'warden',label:'extreme-y',offset:[4194304,2000000000,-4194304],animate:true},
    ...available.has('boat') ? [{family:'boat',label:'native',metadata:{type:0}},
      {family:'boat',label:'bamboo-rowing',metadata:{type:7,paddle_left:true},animate:true},
      {family:'chest_boat',label:'bamboo-native',metadata:{type:7}}] : [],
  ].filter(specification => available.has(specification.family));
  for (const specification of cases) {
    const result = await page.evaluate(async specification => {
      const { family, label, metadata: values = {}, gear = [] } = specification;
      const { renderer, scene, registry, pack } = globalThis.entityRemainingProof;
      scene.clear(); scene.time = 0; const definition = registry.entities.find(entity => entity.name === family);
      const offset=specification.offset??[0,0,0];
      renderer.configureWorld({min:offset.map(v=>v-32),max:offset.map(v=>v+32)});
      const giant=family==='giant', small=['parrot','tadpole','armadillo','copper_golem'].includes(family), phantom=family==='phantom', boat=/boat|raft/.test(family);
      const localEye=giant?[6,6,16]:family==='tadpole'?[.6,.4,1.4]:phantom?[2,2,5]:small?[1,.5,2.5]:boat?[3,1.5,4]:[2,1.5,4];
      const frame={eye:localEye.map((v,i)=>v+offset[i]),yaw:-Math.atan2(localEye[0],localEye[2]),pitch:0,
        dayPhase:.22,timeSeconds:1,gameTime:1000n,quality:'low',scale:1,environmentFog:null};
      const half = bits => { const exponent = bits >> 10 & 31, mantissa = bits & 1023, sign = bits & 0x8000 ? -1 : 1;
        return sign * (exponent ? (1 + mantissa / 1024) * 2 ** (exponent - 15) : mantissa * 2 ** -24); };
      const difference = (a,b) => { let count = 0; for (let at = 0; at < a.pixels.length; at += 4)
        if ([0,1,2].some(channel => Math.abs(half(a.pixels[at+channel])-half(b.pixels[at+channel])) > .005)) count++; return count; };
      renderer.render(frame); const empty = await renderer.readPixels();
      const metadata = Object.entries(values).map(([name,value]) => ({ key: definition.metadataKeys.indexOf(name), value }));
      const equipment = gear.map(([slot,name]) => ({ slot, item: { present: true, itemId: registry.items.find(item => item.name === name).id, itemCount: 1 } }));
      const entity = { id: 1, uuid: family, entityType: definition.id, x: offset[0], y: offset[1], z: offset[2], yaw: 0, pitch: 0, metadata, equipment, grounded: specification.grounded ?? true };
      scene.consume({ type: 'spawn', entity }); if(specification.status)scene.consume({type:'status',id:1,status:specification.status});
      const initialTime=specification.initialTime??1;scene.update(initialTime, frame.eye, { gameTime: 1000n,inWaterAt:()=>true }); renderer.render(frame);
      const initial = await renderer.readPixels(), nativePixels = difference(initial, empty), firstStats = { ...scene.stats };
      const minimumPixels = values.shared_flags === 32 ? 10 : 50;
      if (nativePixels < minimumPixels || firstStats.nativeModels !== 1 || firstStats.approximateModels || firstStats.fallbackModels || firstStats.texturedModels !== 1)
        throw new Error(`${family}/${label} fails original native textured model proof (${nativePixels} pixels; ${JSON.stringify(firstStats)}).`);
      const resolved = scene.skinFor(family, entity, definition), vertices = scene.writer.vertices.slice(0, scene.writer.length);
      const usedTiles = new Set(); for (let at=0;at<vertices.length;at+=14) usedTiles.add(vertices[at+12]);
      if (family==='bogged'&&!usedTiles.has(pack.atlas.entityTiles.get('minecraft:entity/skeleton/bogged_overlay')))throw new Error('Native bogged overlay missing');
      if (gear.length&&firstStats.equipmentParts===0)throw new Error('Native copper golem held item missing');
      if (family==='warden') {
        const alphas=[];for(let at=0;at<vertices.length;at+=14)if(vertices[at+13]&134217728)alphas.push(vertices[at+9]);
        if(!alphas.some(a=>a>0&&a<1))throw new Error('Native quantized Warden glow alpha missing');
      }
      let animationPixels = 0, animationVertices = 0;
      if (specification.animate) {
        scene.update(initialTime+.4, frame.eye,{inWaterAt:()=>true}); renderer.render(frame); animationPixels = difference(initial, await renderer.readPixels());
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
    results.push(result); await page.screenshot({ path: `test-results/entity-remaining-${version}-${specification.family}-${specification.label}.png` });
  }
  assert.deepEqual(errors, []);
  await writeFile(`test-results/entity-remaining-models-${version}.json`, JSON.stringify({ originalAssets: true, version, softwareGPU: software, results, errors }, null, 2));
  await page.evaluate(() => { globalThis.entityRemainingProof.scene.clear(); globalThis.entityRemainingProof.renderer.destroy(); });
  console.log(JSON.stringify({ version, results, errors }, null, 2));
} finally { await browser.close(); }
