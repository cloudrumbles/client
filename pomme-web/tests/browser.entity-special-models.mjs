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
    globalThis.entitySpecialProof = { renderer, scene, registry, pack };
  }, version);
  await mkdir('test-results', { recursive: true });
  for (const family of ['camel', 'ravager', 'sniffer', 'breeze', 'ender_dragon']) {
    const result = await page.evaluate(async family => {
      const { renderer, scene, registry, pack } = globalThis.entitySpecialProof;
      scene.clear(); const definition = registry.entities.find(entity => entity.name === family);
      const frame = { eye: family === 'ender_dragon' ? [7,4,16] : [3,1.5,6], yaw: family === 'ender_dragon' ? -Math.atan2(7,18) : -Math.atan2(3,6), pitch: 0,
        dayPhase: .22, timeSeconds: 1, gameTime: 1000n, quality: 'low', scale: 1 };
      const half = bits => { const exponent = bits >> 10 & 31, mantissa = bits & 1023, sign = bits & 0x8000 ? -1 : 1;
        return sign * (exponent ? (1 + mantissa / 1024) * 2 ** (exponent - 15) : mantissa * 2 ** -24); };
      const difference = (a,b) => { let count = 0; for (let at = 0; at < a.pixels.length; at += 4)
        if ([0,1,2].some(channel => Math.abs(half(a.pixels[at+channel])-half(b.pixels[at+channel])) > .005)) count++; return count; };
      renderer.render(frame); const empty = await renderer.readPixels();
      let entity = { id: 1, uuid: family, entityType: definition.id, x: 0, y: 0, z: 0, yaw: Math.PI, pitch: 0, metadata: [], equipment: [] };
      const metadata = values => Object.entries(values).map(([name,value]) => ({ key: definition.metadataKeys.indexOf(name), value }));
      scene.consume({ type: 'spawn', entity });
      const draw = async (time, gameTime = 1000n) => { scene.update(time, frame.eye, { gameTime }); renderer.render(frame); return renderer.readPixels(); };
      const initial = await draw(1), nativePixels = difference(initial, empty), initialStats = { ...scene.stats };
      if (nativePixels < 100 || initialStats.nativeModels !== 1 || initialStats.approximateModels || initialStats.texturedModels !== 1)
        throw new Error(`${family} does not render an original native model (${nativePixels} pixels).`);
      let changed;
      if (family === 'camel') {
        entity = { ...entity, metadata: metadata({ last_pose_change_tick: -1000n }) }; scene.consume({ type: 'update', entity }); changed = await draw(1.1,1045n);
      } else if (family === 'ravager') {
        scene.consume({ type: 'status', id: 1, status: 39 }); changed = await draw(1.1);
      } else if (family === 'sniffer') {
        entity = { ...entity, metadata: metadata({ state: 5 }) }; scene.consume({ type: 'update', entity }); await draw(1.1); changed = await draw(2.1);
      } else if (family === 'breeze') {
        entity = { ...entity, metadata: metadata({ pose: 16 }) }; scene.consume({ type: 'update', entity }); await draw(1.1); changed = await draw(1.5);
      } else changed = await draw(1.15);
      const animationPixels = difference(initial, changed);
      if (animationPixels < 25) throw new Error(`${family} source pose/animation did not change its image (${animationPixels} pixels).`);
      const stats = renderer.stats(); if (stats.lastError) throw new Error(stats.lastError);
      const skinTiles = { camel: 'camel/camel', ravager: 'illager/ravager', sniffer: 'sniffer/sniffer', breeze: 'breeze/breeze', ender_dragon: 'enderdragon/dragon' };
      const tile = pack.atlas.entityTiles.get(`minecraft:entity/${skinTiles[family]}`);
      return { family, nativePixels, animationPixels, originalTextureTile: tile, nativeVertices: scene.stats.vertices, originalNativeModel: true,
        sourceState: family === 'camel' ? 'native sit pose at age1045/pose1000' : family === 'ravager' ? 'status39 stun' : family === 'sniffer' ? 'state5 digging' : family === 'breeze' ? 'pose16 shoot + scrolling wind' : 'native flap + 5 neck/12 tail links',
        dragonHistoryBytes: scene.entities.get(1)?.dragonHistory?.values.byteLength ?? 0, adapter: stats.adapterInfo, error: stats.lastError };
    }, family);
    results.push(result); await page.screenshot({ path: `test-results/entity-special-${family}.png` });
  }
  const precision = await page.evaluate(async () => {
    const { renderer, scene, registry, pack } = globalThis.entitySpecialProof;
    const { buildEntityPreview } = await import('/src/entities.js');
    const reports = [], half = bits => { const exponent = bits >> 10 & 31, mantissa = bits & 1023, sign = bits & 0x8000 ? -1 : 1;
      return sign * (exponent ? (1+mantissa/1024)*2**(exponent-15) : mantissa*2**-24); };
    const pixels = (a,b) => { let count=0; for(let at=0;at<a.pixels.length;at+=4) if([0,1,2].some(c=>Math.abs(half(a.pixels[at+c])-half(b.pixels[at+c]))>.005)) count++; return count; };
    for(const family of ['player','item_frame','zombie_preview']) {
      let normal;
      for(const shift of [0,2_000_000_000,-2_000_000_000]) {
        scene.clear(); renderer.removeMesh('__precision_preview');
        renderer.configureWorld({min:[-32,shift-16,-32],max:[32,shift+32,32]});
        const frame={eye:[3,shift+1.5,6],yaw:-Math.atan2(3,6),pitch:0,dayPhase:.22,timeSeconds:1,quality:'low',scale:1};
        renderer.render(frame); const empty=await renderer.readPixels(); let mesh,height;
        if(family==='zombie_preview') {
          const preview=buildEntityPreview({name:'zombie',position:[0,shift,0],origin:[0,shift,0],yaw:Math.PI,scale:.7},{registry,atlas:pack.atlas,materials:pack.materials});
          mesh=preview.vertices; height=preview.bounds.max[1]-preview.bounds.min[1];
          renderer.uploadDynamicMesh('__precision_preview',mesh,new Float32Array(0),{
            min:preview.bounds.min.map((v,a)=>v+preview.origin[a]),max:preview.bounds.max.map((v,a)=>v+preview.origin[a])},{stride:14,origin:preview.origin});
        } else {
          const definition=registry.entities.find(e=>e.name===family);
          scene.consume({type:'spawn',entity:{id:1,uuid:'00000000-0000-0000-0000-000000000001',entityType:definition.id,x:0,y:shift,z:0,yaw:Math.PI,pitch:0,metadata:[],equipment:[],objectData:3}});
          scene.update(1,frame.eye); mesh=scene.writer.vertices.slice(0,scene.writer.length); height=scene.writer.max[1]-scene.writer.min[1];
        }
        renderer.render(frame); const rendered=await renderer.readPixels(), nativePixels=pixels(empty,rendered);
        if(nativePixels<50 || height<.4) throw new Error(`${family} at Y${shift} collapsed (${nativePixels} pixels,height${height}).`);
        if(shift===0) normal=mesh;
        else if(mesh.length!==normal.length || mesh.some((v,i)=>v!==normal[i])) throw new Error(`${family} native Float32 relative vertices changed at Y${shift}.`);
        reports.push({family,worldY:shift,nativePixels,nativeHeight:height,relativeVerticesEqual:true});
      }
    }
    scene.clear(); renderer.removeMesh('__precision_preview'); return reports;
  });
  assert.deepEqual(errors, []);
  await writeFile('test-results/entity-special-models.json', JSON.stringify({ originalAssets: true, version, softwareGPU: software, results, precision, errors }, null, 2));
  await page.evaluate(() => { globalThis.entitySpecialProof.scene.clear(); globalThis.entitySpecialProof.renderer.destroy(); });
  console.log(JSON.stringify({ version, results, precision, errors }, null, 2));
} finally { await browser.close(); }
