import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';

const software = process.env.POMME_SOFTWARE_GPU === '1', errors = [];
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? '/usr/bin/chromium', headless: true,
  args: ['--no-sandbox', '--enable-unsafe-webgpu', ...(software ? ['--use-angle=swiftshader', '--enable-features=Vulkan', '--use-vulkan=swiftshader'] : [])] });
try {
  const page = await browser.newPage({ viewport: { width: 160, height: 160 } });
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(new URL('/src/shaders/world.wgsl', process.env.POMME_URL ?? 'http://127.0.0.1:5173').href);
  const proof = await page.evaluate(async () => {
    const { createRenderer } = await import('/src/renderer.js');
    const { FULLBRIGHT, EYES_ADDITIVE, EYES_TRANSLUCENT, EMISSIVE_TRANSLUCENT, WIND_TRANSLUCENT } = await import('/src/actor-layers.js');
    document.body.replaceChildren(); const canvas = document.createElement('canvas'); canvas.style.cssText = 'width:128px;height:128px'; document.body.append(canvas);
    const renderer = await createRenderer(canvas), base = [.25, .125, .0625], eye = [.125, .25, .375];
    const points = [[0,0],[1,0],[1,1],[0,0],[1,1],[0,1]], bounds = { min: [0,0,-1], max: [1,1,1] };
    const quad = (color, flags, z = 0, tile = 0, normal = [0,0,1]) => new Float32Array(points.flatMap(([x,y]) => [x,y,z,...normal,...color,1,0,0,tile,32 | 512 | flags]));
    const half = bits => { const sign = bits & 0x8000 ? -1 : 1, exponent = bits >> 10 & 31, mantissa = bits & 1023; return sign * (exponent ? (1 + mantissa / 1024) * 2 ** (exponent - 15) : mantissa * 2 ** -24); };
    let origin = [0,0,0];
    const upload = (key, vertices) => renderer.uploadDynamicMesh(key, vertices, [], { min: [0,origin[1],-1], max: [1,origin[1]+1,1] }, { stride: 14, origin });
    const frame = phase => ({ eye: [.5,origin[1]+.5,2], yaw: 0, pitch: 0, dayPhase: phase, timeSeconds: 10, quality: 'low', scale: 1 });
    const capture = async (phase = .25) => {
      renderer.render(frame(phase)); const image = await renderer.readPixels();
      const pixel = (Math.floor(image.height/2)*image.width+Math.floor(image.width/2))*4;
      return [...image.pixels.subarray(pixel,pixel+3)].map(half);
    };
    const near = (actual, expected, label) => { for (let axis=0;axis<3;axis++) if (Math.abs(actual[axis]-expected[axis])>.002) throw new Error(`${label}: ${JSON.stringify({actual,expected})}`); };
    const cases = [];
    try {
      renderer.setTextureAtlas({ pixelsRGBA: new Uint8Array([255,255,255,255,255,255,255,128,255,255,255,1,0,0,0,0]), width: 4, height: 1,
        tiles: [255,128,1,0].map((alpha,id)=>({ id, name:`test:alpha_${alpha}`, x:id, y:0, width:1, height:1 })) });
      renderer.configureWorld({ ...bounds, hasSkylight: true, fogDensity: 0 }); upload('base',quad(base,FULLBRIGHT));
      near(await capture(),base,'base');
      for (const [name,flag,tile,expected] of [
        ['legacyAdditive',EYES_ADDITIVE,1,base.map((value,axis)=>value+eye[axis])],
        ['modernTranslucent',EYES_TRANSLUCENT,1,base.map((value,axis)=>value*(1-128/255)+eye[axis]*128/255)],
        ['breezeEmissive',EMISSIVE_TRANSLUCENT,1,base.map((value,axis)=>value*(1-128/255)+eye[axis]*128/255)],
        ['legacyLowAlpha',EYES_ADDITIVE,2,base.map((value,axis)=>value+eye[axis])],
        ['modernLowAlpha',EYES_TRANSLUCENT,2,base.map((value,axis)=>value*(1-1/255)+eye[axis]/255)],
      ]) {
        upload('eye',quad(eye,FULLBRIGHT|flag,0,tile)); const day=await capture(), night=await capture(.75);
        near(day,expected,name); near(night,expected,`${name} night`); cases.push({name,day,night,expected});
      }
      const alpha = 128/255, red=[.5,0,0], blue=[0,0,.5];
      for (const [name,flag,lighting] of [['sortedModernEyes',EYES_TRANSLUCENT,[1,1,1]],['sortedWind',WIND_TRANSLUCENT,[.85,.67*.85,.33*.85]]]) {
        const fullbright=flag===WIND_TRANSLUCENT?0:FULLBRIGHT, lightFlags=flag===WIND_TRANSLUCENT?15<<14:0;
        const front=quad(red,flag|fullbright|lightFlags,.2,1), back=quad(blue,flag|fullbright|lightFlags,.1,1);
        const wrongOrder=new Float32Array(front.length+back.length);wrongOrder.set(front);wrongOrder.set(back,front.length);upload('eye',wrongOrder);
        const expected=base.map((value,axis)=>value*(1-alpha)**2+blue[axis]*lighting[axis]*alpha*(1-alpha)+red[axis]*lighting[axis]*alpha);
        const actual=await capture();near(actual,expected,name);cases.push({name,actual,expected});
        const stats=renderer.stats();await capture();if(renderer.stats().actorLayerSorts!==stats.actorLayerSorts)throw new Error('Unchanged actor camera repeated sorting/upload work');
      }
      upload('eye',quad(eye,FULLBRIGHT|EYES_ADDITIVE,-.1,1)); near(await capture(),base,'opaque occludes eyes');
      upload('eye',quad(eye,FULLBRIGHT|EYES_ADDITIVE,.1,3)); renderer.configureWorld({ ...bounds, fogDensity: .01 });
      const beforeFog=await capture(); renderer.removeMesh('eye'); near(await capture(),beforeFog,'black additive does not add atmospheric fog');
      renderer.configureWorld({ ...bounds, fogDensity: 0 }); upload('eye',quad(eye,FULLBRIGHT|EYES_TRANSLUCENT,.1,1));
      renderer.render(frame(.25)); const depthBefore=await renderer.readPixels({source:'depth'});
      upload('wind',quad([1,1,1],WIND_TRANSLUCENT|(15<<10),.2,1)); renderer.render(frame(.25)); const depthAfter=await renderer.readPixels({source:'depth'});
      const center=Math.floor(depthBefore.height/2)*depthBefore.width+Math.floor(depthBefore.width/2);
      if (!(depthAfter.pixels[center]<depthBefore.pixels[center])) throw new Error('Native wind did not write depth');
      renderer.removeMesh('wind'); renderer.removeMesh('eye');
      origin=[0,40000,0]; renderer.configureWorld({min:[0,40000,-1],max:[1,40001,1],fogDensity:0});
      upload('base',quad(base,FULLBRIGHT)); upload('eye',quad(eye,FULLBRIGHT|EYES_ADDITIVE,0,1));
      const high=await capture(); near(high,base.map((value,axis)=>value+eye[axis]),'actor local Y rebase');
      const stats=renderer.stats(); if(stats.lastError)throw new Error(stats.lastError);
      return {cases,extremeY:high,windDepth:{before:depthBefore.pixels[center],after:depthAfter.pixels[center]},actorLayerTriangles:stats.actorLayerTriangles,adapter:stats.adapterInfo};
    } finally { renderer.destroy(); }
  });
  assert.deepEqual(errors,[]); await mkdir('test-results',{recursive:true}); await writeFile('test-results/actor-layers.json',JSON.stringify({...proof,softwareGPU:software,errors},null,2));
  console.log(JSON.stringify(proof));
} finally { await browser.close(); }
