import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';

const software = process.env.POMME_SOFTWARE_GPU === '1', errors = [];
const browser = await chromium.launch({ executablePath:process.env.CHROMIUM_PATH ?? '/usr/bin/chromium',headless:true,
  args:['--no-sandbox','--enable-unsafe-webgpu',...(software ? ['--use-angle=swiftshader','--enable-features=Vulkan','--use-vulkan=swiftshader'] : [])] });
try {
  const page = await browser.newPage({ viewport:{width:160,height:160} }); page.on('pageerror',error => errors.push(error.message));
  await page.goto(new URL('/src/shaders/shadow.wgsl',process.env.POMME_URL ?? 'http://127.0.0.1:5173').href);
  const proof = await page.evaluate(async () => {
    const { createRenderer } = await import('/src/renderer.js'), { nativeBeamQuads,nativeBeamProfile } = await import('/src/native-beams.js');
    const check = (value,message) => { if (!value) throw new Error(message); };
    const same = (actual,expected,message) => check(actual.length === expected.length && actual.every((value,index) => value === expected[index]),message);
    const concat = (...arrays) => new Float32Array(arrays.flatMap(array => Array.from(array)));
    const lit = 512 | 15 << 10;
    const quad = (points,color=[.4,.4,.4],flags=1) => new Float32Array(points.flatMap((point,index) => [...point,0,1,0,...color,1,index%2,index%3,0,flags | lit]));
    const wall = x => { const points=[[x,0,-2],[x+1,0,-2],[x+1,1.5,-2],[x,0,-2],[x+1,1.5,-2],[x,1.5,-2]];
      return concat(quad(points,[.7,.1,.05]),quad([points[0],points[2],points[1],points[3],points[5],points[4]],[.7,.1,.05])); };
    const beam = time => new Float32Array(nativeBeamQuads({ height:2,animationTime:time,...nativeBeamProfile('1.21.11') }).flatMap(q => [0,1,2,0,2,3].flatMap(index => [
      ...q.positions[index].map((value,axis) => value + [-2,0,-1][axis]),...q.normal,.1,.8,.2,q.alpha,...q.uv[index],0,q.flags | lit])));
    const actorBounds = x => ({ min:[x,0,-2],max:[x+1,1.5,-1.999] }), beamBounds={ min:[-2,0,-1],max:[-1,2,0] };
    const worldBounds={ min:[-8,-4,-8],max:[8,8,8] },frame={ eye:[0,1.5,4],yaw:0,pitch:-.15,timeSeconds:10,dayPhase:.22,quality:'low',scale:1 };
    document.body.replaceChildren();const canvas=document.createElement('canvas');canvas.style.cssText='width:128px;height:128px';document.body.append(canvas);
    const samples=[],renderer=await createRenderer(canvas,{onGpuSample:sample=>samples.push(sample)});
    const deadline = async(promise,label)=>{let timer;try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error(`${label} timed out`)),15000);})]);}finally{clearTimeout(timer);}};
    const draw = async(delay=0)=>{if(delay)await new Promise(resolve=>setTimeout(resolve,delay));renderer.render(frame);
      const hdr=await deadline(renderer.readPixels(),'HDR caster proof'),shadow=await deadline(renderer.readPixels({source:'shadow'}),'Shadow caster proof');
      check(renderer.stats().lastError===null,renderer.stats().lastError);const frameId=renderer.stats().frameCount-1;
      check(renderer.stats().gpuTimingSupported,'The caster proof requires timestamp-query to prove omitted native passes.');
      await deadline((async()=>{while(!samples.some(sample=>sample.frameId===frameId))await new Promise(resolve=>setTimeout(resolve,5));})(),'Current caster pass timestamps');
      return { hdr,shadow,stats:renderer.stats(),sample:samples.find(sample=>sample.frameId===frameId) };};
    const activeDynamic = image => image.sample?.passMs.dynamicShadow !== null && image.sample?.passMs.dynamicShadow !== undefined;
    const cases=[],diagnostics={};
    try {
      renderer.setTextureAtlas({ pixelsRGBA:new Uint8Array([255,255,255,255]),width:1,height:1,tiles:[{id:0,x:0,y:0,width:1,height:1}] }); renderer.configureWorld({...worldBounds,fogDensity:0});
      renderer.uploadChunk('ground',quad([[-4,-.5,-4],[-4,-.5,4],[4,-.5,4],[-4,-.5,-4],[4,-.5,4],[4,-.5,-4]],[.15,.3,.45]),[],worldBounds,{stride:14});
      const baseline=await draw();check(baseline.stats.dynamicShadowUpdates===0,'Baseline must have no dynamic caster.');
      renderer.uploadDynamicMesh('native-beam',beam(0),[],beamBounds,{stride:14}); const firstBeam=await draw();
      check(firstBeam.stats.entityTriangles>0 && firstBeam.stats.dynamicShadowUpdates===0 && !activeDynamic(firstBeam),'Visible native beam must omit the empty dynamic shadow pass.');
      same(firstBeam.shadow.pixels,baseline.shadow.pixels,'Beam-only geometry cannot alter source static shadow depth.');
      const changedHdr=firstBeam.hdr.pixels.reduce((count,value,index)=>count+(value!==baseline.hdr.pixels[index]?1:0),0);check(changedHdr>20,'Beam proof must draw actual changed HDR pixels.');
      for(const time of [1,2]){renderer.uploadDynamicMesh('native-beam',beam(time),[],beamBounds,{stride:14});const result=await draw(40);
        check(result.stats.dynamicShadowUpdates===0 && !activeDynamic(result),'Animated beam-only frames must omit shadow copies/queries.');same(result.shadow.pixels,baseline.shadow.pixels,'Beam animation cannot alter static shadows.');}
      cases.push({case:'source-native beam alone',changedHdr,dynamicShadowUpdates:0,omittedPass:true});
      renderer.uploadDynamicMesh('opaque-actor',wall(-.5),[],actorBounds(-.5),{stride:14});const actor=await draw(40);
      check(actor.stats.dynamicShadowUpdates===1 && actor.stats.dynamicShadowDrawCalls===1 && activeDynamic(actor),'Exactly one true opaque actor must render a dynamic shadow.');
      const casterPixels=actor.shadow.pixels.reduce((count,value,index)=>count+(value<baseline.shadow.pixels[index]-.000001?1:0),0);check(casterPixels>10,'True opaque actor must produce actual native shadow depth.');
      for(const time of [3,4,5]){renderer.uploadDynamicMesh('native-beam',beam(time),[],beamBounds,{stride:14});const result=await draw(40);
        check(result.stats.dynamicShadowUpdates===actor.stats.dynamicShadowUpdates && result.stats.dynamicShadowDrawCalls===0 && !activeDynamic(result),'Beam animation beside a real actor must preserve its cached dynamic shadow.');
        same(result.shadow.pixels,actor.shadow.pixels,'Beam-only updates must preserve exact coexisting actor shadow depth.');}
      renderer.removeMesh('native-beam');const removedBeam=await draw(40);check(removedBeam.stats.dynamicShadowUpdates===actor.stats.dynamicShadowUpdates && !activeDynamic(removedBeam),'Removing an omitted beam must preserve another actor shadow cache.');
      same(removedBeam.shadow.pixels,actor.shadow.pixels,'Beam removal must preserve exact actor shadow depth.');cases.push({case:'beam beside true actor',casterPixels,dynamicShadowDrawCalls:1,animatedFrames:3,exactRetainedShadow:true});
      const mixedBounds={min:[-2,0,-2],max:[3,2,0]};renderer.uploadDynamicMesh('mixed',concat(beam(8),wall(1)),[],mixedBounds,{stride:14});const mixed=await draw(40);
      check(mixed.stats.dynamicShadowUpdates===actor.stats.dynamicShadowUpdates+1 && mixed.stats.dynamicShadowDrawCalls===2 && activeDynamic(mixed),'Mixed geometry must remain a caster.');
      renderer.uploadDynamicMesh('mixed',concat(beam(9),wall(2)),[],mixedBounds,{stride:14});const moved=await draw(40);
      check(moved.stats.dynamicShadowUpdates===mixed.stats.dynamicShadowUpdates+1 && activeDynamic(moved),'Changed mixed caster geometry must invalidate dynamic depth.');
      const movedPixels=moved.shadow.pixels.reduce((count,value,index)=>count+(value!==mixed.shadow.pixels[index]?1:0),0);check(movedPixels>10,'Moved mixed opaque geometry must change actual shadow pixels.');
      renderer.uploadDynamicMesh('mixed',beam(10),[],beamBounds,{stride:14});const noLongerMixed=await draw(40);
      check(noLongerMixed.stats.dynamicShadowUpdates===moved.stats.dynamicShadowUpdates+1 && noLongerMixed.stats.dynamicShadowDrawCalls===1,'Caster→beam-only must retire its previous shadow.');
      same(noLongerMixed.shadow.pixels,actor.shadow.pixels,'Caster removal must restore exact remaining actor depth.');
      renderer.uploadDynamicMesh('mixed',beam(11),[],beamBounds,{stride:14});const stableBeam=await draw(40);
      check(stableBeam.stats.dynamicShadowUpdates===noLongerMixed.stats.dynamicShadowUpdates && !activeDynamic(stableBeam),'Subsequent beam-only updates must preserve the restored actor cache.');
      renderer.uploadDynamicMesh('mixed',concat(beam(12),wall(1)),[],mixedBounds,{stride:14});const regained=await draw(40);
      check(regained.stats.dynamicShadowUpdates===stableBeam.stats.dynamicShadowUpdates+1 && regained.stats.dynamicShadowDrawCalls===2,'Beam-only→mixed must admit its new caster.');
      renderer.removeMesh('mixed');const removedMixed=await draw(40);check(removedMixed.stats.dynamicShadowUpdates===regained.stats.dynamicShadowUpdates+1,'Removing a mixed caster must invalidate its previous depth.');same(removedMixed.shadow.pixels,actor.shadow.pixels,'Removing mixed caster must restore remaining actor depth.');
      cases.push({case:'mixed caster transitions',movedPixels,castsAgain:true,restoredExactActorDepth:true});
      for(const pitch of [-Math.PI/2,Math.PI/2])for(const yaw of [0,1.1]) {
        renderer.render({...frame,pitch,yaw});const image=await deadline(renderer.readPixels(),'Native camera pole readback');
        check(renderer.stats().lastError===null && image.pixels.length>0,'Native +/-90 degree pitch must remain invertible and render.');
        cases.push({case:'native camera pole',pitch,yaw,validProjection:true});
      }
      return {productionRenderer:true,sourceNativeBeamGeometry:true,cases,profiledFrames:samples.length,adapter:renderer.stats().adapterInfo,stats:renderer.stats(),diagnostics};
    } finally {renderer.destroy();canvas.remove();const after=renderer.stats();check(after.renderTargetBytes===0,'Destroyed renderer diagnostics must remain readable and report released render targets.');diagnostics.afterDestroyRenderTargetBytes=after.renderTargetBytes;}
  });
  assert.deepEqual(errors,[]);await mkdir('test-results',{recursive:true});await writeFile('test-results/shadow-casters.json',JSON.stringify({softwareSmoke:software,proof,errors},null,2));console.log(JSON.stringify({softwareSmoke:software,proof,errors},null,2));
} finally {await browser.close();}
