import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';

const software = process.env.POMME_SOFTWARE_GPU === '1';
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? '/usr/bin/chromium', headless: true,
  args: ['--no-sandbox', '--enable-unsafe-webgpu', ...(software ? ['--use-angle=swiftshader', '--enable-features=Vulkan', '--use-vulkan=swiftshader'] : [])] });
const errors = [];
try {
  const page = await browser.newPage({ viewport: { width: 480, height: 270 } });
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(new URL('/src/shaders/world.wgsl', process.env.POMME_URL ?? 'http://127.0.0.1:5173').href);
  const proof = await page.evaluate(async () => {
    const [{ createRenderer }, { CachedIrradiance }, { irradianceMaterials, solveIrradiance }] = await Promise.all([
      import('/src/renderer.js'), import('/src/irradiance-cache.js'), import('/src/irradiance.js'),
    ]);
    document.body.replaceChildren();
    const canvas = document.createElement('canvas'); canvas.style.cssText = 'width:320px;height:180px'; document.body.append(canvas);
    const renderer = await createRenderer(canvas), failures = [];
    if (typeof renderer.setIrradianceVolume !== 'function') throw new Error('Renderer irradiance integration is required for this proof.');
    const materials = new Map([[0,{opacity:0,color:[1,1,1]}],[1,{opacity:15,color:[1,1,1]}],
      [2,{opacity:0,emitLight:15,emissionColor:[1,0,0],color:[1,0,0]}],[3,{opacity:0,emitLight:15,emissionColor:[0,0,1],color:[0,0,1]}],
      [4,{opacity:15,color:[1,0,0]}]]);
    const blocks = new Uint16Array(4096);
    for(let z=0;z<16;z++)for(let x=0;x<16;x++)blocks[(2*16+z)*16+x]=1;
    const emitter = (3*16+7)*16+6; blocks[emitter]=2;
    const column = { x:0,z:0,sections:[{sectionY:0,blocks,skyLight:new Uint8Array(2048),blockLight:new Uint8Array(2048).fill(0x88)}] };
    const nativeFlags = 512 | (8<<14), vertices = new Float32Array([[0,3,0,0,0],[0,3,16,0,1],[16,3,16,1,1],[0,3,0,0,0],[16,3,16,1,1],[16,3,0,1,0]]
      .flatMap(([x,y,z,u,v])=>[x,y,z,0,1,0,1,1,1,1,u,v,-1,nativeFlags]));
    const frame = { eye:[8,11,23],yaw:0,pitch:-.42,timeSeconds:10,dayPhase:.25,quality:'low',scale:1 };
    const half = bits => { const exponent = bits >>> 10 & 31,mantissa=bits&1023;return exponent?(1+mantissa/1024)*2**(exponent-15):mantissa*2**-24; };
    const changed = (a,b) => {let count=0;for(let i=0;i<a.pixels.length;i+=4)if([0,1,2].some(c=>Math.abs(half(a.pixels[i+c])-half(b.pixels[i+c]))>.004))count++;return count;};
    const dominance = pixels => { let red=0,blue=0;for(let i=0;i<pixels.pixels.length;i+=4){const r=half(pixels.pixels[i]),b=half(pixels.pixels[i+2]);if(r>b+.08)red++;if(b>r+.08)blue++;}return{red,blue}; };
    const draw=async(options={})=>{renderer.render({...frame,...options});return renderer.readPixels();};
    let latest=null;
    const cache=new CachedIrradiance({onVolume:volume=>{latest=volume;renderer.setIrradianceVolume(volume);},onStatus:message=>failures.push(message)});
    const wait=async(predicate)=>{for(let i=0;i<600;i++){if(predicate())return;await new Promise(resolve=>setTimeout(resolve,10));}throw new Error('Bounded irradiance worker timed out.');};
    try {
      renderer.configureWorld({min:[0,0,0],max:[16,16,16],hasSkylight:false});
      renderer.uploadChunk('irradiance-floor',vertices,[],{min:[0,3,0],max:[16,3,16]},{stride:14});
      const baseline=await draw();
      cache.configure({materials,minY:0,height:16,hasSkylight:false,generation:1});
      const update={eye:[8,8,8],dayPhase:.25,columns:new Map([['0,0',column]])};
      cache.update(update);await wait(()=>cache.stats().jobs===1);
      const red=await draw(), redCounts=dominance(red), before=renderer.stats(), cacheBefore=cache.stats();
      for(let i=0;i<1000;i++)cache.update(update);
      await draw();await draw();
      const stable=renderer.stats();
      if(cache.stats().volumeUploads!==cacheBefore.volumeUploads||stable.meshUploadCount!==before.meshUploadCount||stable.shadowUpdates!==before.shadowUpdates)
        throw new Error('Stable cached-light frames rebuilt a worker volume, terrain mesh, or directional shadow.');
      cache.setBlock(6,3,7,3);await wait(()=>cache.stats().jobs===2);
      const blue=await draw(), blueCounts=dominance(blue), colorPixels=changed(red,blue);
      const cacheAfterColor = cache.stats();
      if(colorPixels<1000||redCounts.red<1000||blueCounts.blue<1000)throw new Error(`Cached source color must alter real HDR pixels (${JSON.stringify({colorPixels,redCounts,blueCounts})}).`);
      const blueVolume=latest;
      renderer.setIrradianceVolume(null);
      const restored=await draw();
      if(changed(baseline,restored)!==0)throw new Error('Disabling optional color cache must restore the authoritative scalar-light rendering.');
      const far=[4096,0,-8192];
      renderer.configureWorld({min:far,max:[far[0]+16,16,far[2]+16],hasSkylight:false});
      renderer.uploadChunk('irradiance-floor',vertices,[],{min:[far[0],3,far[2]],max:[far[0]+16,3,far[2]+16]},{stride:14,origin:far});
      renderer.setIrradianceVolume({...blueVolume,origin:blueVolume.origin.map((value,axis)=>value+far[axis])});
      const rebased=await draw({eye:frame.eye.map((value,axis)=>value+far[axis])});
      if(changed(blue,rebased)!==0)throw new Error('World-space cached light moved or changed after renderer origin rebasing.');

      // Separate sun-bounce proof uses a red floor lighting a white side wall.
      // Both meshes and input scalar light remain identical across the toggle.
      renderer.configureWorld({min:[0,0,0],max:[16,16,16],hasSkylight:true});
      renderer.removeChunk('irradiance-floor');
      const wall=new Float32Array([[0,3,0,0,0],[16,3,0,1,0],[16,9,0,1,1],[0,3,0,0,0],[16,9,0,1,1],[0,9,0,0,1]]
        .flatMap(([x,y,z,u,v])=>[x,y,z,0,0,1,1,1,1,1,u,v,-1,512|(15<<10)]));
      renderer.uploadChunk('bounce-wall',wall,[],{min:[0,3,0],max:[16,9,0]},{stride:14});
      const cells=16**3,snapshot={origin:[0,0,0],dimensions:[16,16,16],states:new Uint16Array(cells),known:new Uint8Array(cells).fill(1),sky:new Uint8Array(cells).fill(15),block:new Uint8Array(cells),sunBucket:60,hasSkylight:true};
      for(let z=0;z<16;z++)for(let x=0;x<16;x++)snapshot.states[(z*16+2)*16+x]=4;
      const bounceVolume=solveIrradiance(snapshot,irradianceMaterials(materials));
      renderer.setIrradianceVolume(null);
      const wallFrame={eye:[8,7,15],pitch:0};
      const plainWall=await draw(wallFrame);
      renderer.setIrradianceVolume(bounceVolume);
      const bouncedWall=await draw(wallFrame),bouncePixels=changed(plainWall,bouncedWall);
      if(bouncePixels<100)throw new Error(`Material-colored cached bounce must affect the actual GPU wall (${bouncePixels} pixels).`);
      // A full source band is immutable across this time jump. Repeat an angle,
      // then restart its real Worker to exercise persistent browser storage.
      cache.configure({materials,minY:0,height:16,hasSkylight:true,generation:2});
      const recurrence = { ...update, dayPhase: .25 };
      let jobs = cache.stats().jobs; cache.update(recurrence); await wait(()=>cache.stats().jobs===jobs+1);
      const angleVolume = { localData: latest.localData.slice(), bounceData: latest.bounceData.slice() };
      const angleHDR = await draw(wallFrame);
      jobs = cache.stats().jobs; cache.update({ ...recurrence, dayPhase: 61.5 / 240 }); await wait(()=>cache.stats().jobs===jobs+1);
      jobs = cache.stats().jobs; cache.update(recurrence); await wait(()=>cache.stats().jobs===jobs+1);
      const repeatedHDR = await draw(wallFrame);
      if (!cache.stats().sunCacheHits || changed(angleHDR,repeatedHDR)!==0 || latest.bounceData.some((value,index)=>value!==angleVolume.bounceData[index])) throw new Error('Repeated sun angle did not reuse exact lighting/GPU pixels.');
      const [{ IrradianceDiskCache }, { irradianceMaterialKey, irradianceSourceKey }] = await Promise.all([import('/src/irradiance-disk-cache.js'),import('/src/irradiance-source-key.js')]);
      const verifier = new IrradianceDiskCache(), identity = await irradianceSourceKey(cache.snapshot(), await irradianceMaterialKey(cache.tables));
      let stored = null;
      for (let attempt=0;attempt<200&&!stored;attempt++) { stored=await verifier.get(identity,60);if(!stored)await new Promise(resolve=>setTimeout(resolve,10)); }
      await verifier.close(); if(!stored)throw new Error('Real lighting Worker did not durably store the sun-angle result.');
      cache.configure({materials,minY:0,height:16,hasSkylight:true,generation:3});
      jobs = cache.stats().jobs; cache.update(recurrence); await wait(()=>cache.stats().jobs===jobs+1);
      const diskHDR = await draw(wallFrame);
      if (!cache.stats().diskCacheHits || changed(angleHDR,diskHDR)!==0 || latest.localData.some((value,index)=>value!==angleVolume.localData[index]) || latest.bounceData.some((value,index)=>value!==angleVolume.bounceData[index])) throw new Error('Worker reopen did not restore exact disk lighting/GPU pixels.');
      const periodicCache={repeatedPixels:changed(angleHDR,repeatedHDR),diskPixels:changed(angleHDR,diskHDR),ramHits:cache.stats().sunCacheHits,diskHits:cache.stats().diskCacheHits,lastDiskReadMs:cache.stats().lastDiskReadMs,retainedSunBytes:cache.stats().sunCacheBytes};
      const stats=renderer.stats();if(stats.lastError)throw new Error(stats.lastError);
      if(vertices.some((value,i)=>i%14===13&&value!==nativeFlags))throw new Error('Cached lighting changed authoritative vertex light flags.');
      return {colorPixels,bouncePixels,redCounts,blueCounts,periodicCache,stableWorkerUploads:[cacheBefore.volumeUploads,cacheAfterColor.volumeUploads-1],
        stableMeshUploads:[before.meshUploadCount,stable.meshUploadCount],stableShadows:[before.shadowUpdates,stable.shadowUpdates],
        fallbackPixels:changed(baseline,restored),rebasePixels:changed(blue,rebased),sourceBytes:cache.stats().sourceBytes,snapshotBytes:cache.stats().snapshotBytes,
        outputBytes:cache.stats().outputBytes,irradianceStats:{enabled:stats.irradianceEnabled,bytes:stats.irradianceBytes,uploads:stats.irradianceUploads,uploadBytes:stats.irradianceUploadBytes},errors:failures,gpuError:stats.lastError,adapter:stats.adapterInfo};
    }finally{cache.destroy();renderer.destroy();}
  });
  assert.deepEqual(proof.errors,[]);assert.equal(proof.gpuError,null);assert.deepEqual(errors,[]);
  await mkdir('test-results',{recursive:true});await writeFile('test-results/irradiance-rendering.json',JSON.stringify({...proof,softwareGPU:software},null,2));
  console.log(JSON.stringify(proof,null,2));
}finally{await browser.close();}
