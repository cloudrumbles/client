import assert from 'node:assert/strict';
import { mkdir,writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';
const prefix='.',software=process.env.POMME_SOFTWARE_GPU==='1',errors=[];
const browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH??'/usr/bin/chromium',headless:true,args:['--no-sandbox','--enable-unsafe-webgpu',...(software?['--use-angle=swiftshader','--enable-features=Vulkan','--use-vulkan=swiftshader']:[])]});
try{
 const page=await browser.newPage({viewport:{width:160,height:160}});page.on('pageerror',error=>errors.push(error.message));
 // Exercise the production renderer without intercepting its modules.
 await page.goto(new URL('/src/shaders/world.wgsl',process.env.POMME_URL??'http://127.0.0.1:5173').href);
 const proof=await page.evaluate(async()=>{
  const {createRenderer}=await import('/src/renderer.js'),{EnvironmentFog,nativeFogFactor}=await import('/src/environment-fog.js'),{nativeFogColorToLinear}=await import('/src/render-environment-fog.js');
  const check=(ok,message)=>{if(!ok)throw new Error(message);};const near=(actual,expected,message)=>check(actual.every((value,index)=>Math.abs(value-expected[index])<.0015),`${message}: ${JSON.stringify({actual,expected})}`);
  const half=bits=>{const sign=bits&0x8000?-1:1,exponent=bits>>10&31,mantissa=bits&1023;return sign*(exponent?(1+mantissa/1024)*2**(exponent-15):mantissa*2**-24);};
  const pixel=(image,x=64,y=64)=>Array.from(image.pixels.subarray((y*image.width+x)*4,(y*image.width+x)*4+3),half);
  const quad=(radius,distance,color,flags=16777216)=>new Float32Array([[-radius,-radius,-distance],[radius,-radius,-distance],[radius,radius,-distance],[-radius,-radius,-distance],[radius,radius,-distance],[-radius,radius,-distance]].flatMap((point,index)=>[...point,0,0,1,...color,1,index%2,index%3,0,flags]));
  document.body.replaceChildren();const canvas=document.createElement('canvas');canvas.style.cssText='width:128px;height:128px';document.body.append(canvas);const renderer=await createRenderer(canvas),baseColor=[.4,.2,.1],frame={eye:[0,0,0],yaw:0,pitch:0,timeSeconds:10,dayPhase:.22,quality:'low',scale:1};
  const draw=async(fog=null,options={})=>{renderer.render({...frame,environmentFog:fog,...options});const hdr=await renderer.readPixels(),depth=await renderer.readPixels({source:'depth'});check(renderer.stats().lastError===null,renderer.stats().lastError);return{hdr,depth,stats:renderer.stats()};};
  const cases=[],sphere=Math.sqrt(18),cylinder=Math.sqrt(17);
  const expected=(fog,base)=>{const fraction=(distance,start,end)=>distance<=start?0:distance>=end?1:(distance-start)/(end-start);let value;
   if(fog.separateRenderDistance)value=Math.max(fraction(sphere,fog.start,fog.end),fraction(cylinder,fog.renderStart,fog.renderEnd));
   else{const t=fraction(fog.shape==='cylinder'?cylinder:sphere,fog.start,fog.end);value=t*t*(3-2*t);}
   const rgb=nativeFogColorToLinear(fog.color);return base.map((color,index)=>color+(rgb[index]-color)*value);};
  try{
   renderer.setTextureAtlas({pixelsRGBA:new Uint8Array([255,255,255,255]),width:1,height:1,tiles:[{id:0,x:0,y:0,width:1,height:1}]});renderer.configureWorld({min:[-8,-8,-8],max:[8,8,8],fogDensity:0});renderer.uploadChunk('known-base',quad(1,4,baseColor),[],{min:[-1,-1,-4],max:[1,1,-3.999]},{stride:14});
   const baseline=await draw();near(pixel(baseline.hdr),baseColor,'Known linear HDR base');const cache=renderer.stats();
   for(const version of['1.20.4','1.21.11','26.1'])for(const type of['water','lava','powder-snow']){
    const controller=new EnvironmentFog({version}),fog=controller.sample({type,waterFogColor:0x336699,farPlane:128});const image=await draw(fog),rgb=expected(fog,pixel(baseline.hdr));near(pixel(image.hdr),rgb,`${version} ${type} native vertex-distance/color fog`);near(pixel(image.hdr,4,4),nativeFogColorToLinear(fog.color),`${version} ${type} immersed sky`);
    check(image.depth.pixels.every((value,index)=>value===baseline.depth.pixels[index]),'Fog uniforms must preserve every depth pixel');
    for(const field of['shadowUpdates','skyCacheUpdates','meshUploadCount','terrainBundleEncodes','shadowBundleEncodes'])check(image.stats[field]===cache[field],`Fog changed cached ${field}`);
    cases.push({version,type,sourceColor:fog.color,linearColor:nativeFogColorToLinear(fog.color),actual:pixel(image.hdr),expected:rgb,curve:fog.separateRenderDistance?'linear':'smoothstep'});
   }
   const legacy=new EnvironmentFog().sample({type:'water',waterFogColor:0x336699});
   for(const shape of['sphere','cylinder']){const fog={...legacy,shape,start:0,end:8};const image=await draw(fog);near(pixel(image.hdr),expected(fog,pixel(baseline.hdr)),`Native ${shape} admission control`);cases.push({case:'shape admission',shape,actual:pixel(image.hdr),expected:expected(fog,pixel(baseline.hdr))});}
   const modern={...legacy,separateRenderDistance:true,start:0,end:100,renderStart:3,renderEnd:5};const rendered=await draw(modern);near(pixel(rendered.hdr),expected(modern,pixel(baseline.hdr)),'Modern max of spherical environmental/cylindrical render-distance fog');cases.push({case:'modern max-distance branch',actual:pixel(rendered.hdr),expected:expected(modern,pixel(baseline.hdr))});
   const skyFog={...modern,type:'none',skyEnd:512},skyBase=pixel(baseline.hdr,4,4),skyLinear=nativeFogColorToLinear(skyFog.color),skyExpected=skyBase.map((value,index)=>value+(skyLinear[index]-value)*.25),skyImage=await draw(skyFog);near(pixel(skyImage.hdr,4,4),skyExpected,'Modern sky uses SkyEnd independently of world render-distance ranges');cases.push({case:'modern sky distance branch',actual:pixel(skyImage.hdr,4,4),expected:skyExpected});
   // Actual native first-person mesh selects Fog.NONE while the world and sky
   // remain immersed. Renderer adds the established first-person flag itself.
   renderer.uploadFirstPersonMesh(quad(.1,.5,[.8,.05,.1]),[],{min:[-.1,-.1,-.5],max:[.1,.1,-.499]});const hand=await draw(new EnvironmentFog().sample({type:'lava'}));near(pixel(hand.hdr),[.8,.05,.1],'Native hand immersion Fog.NONE');
   const airEffect={...legacy,type:'none',color:[0,0,0],start:0,end:.25,skyEnd:.25};const airHand=await draw(airEffect);near(pixel(airHand.hdr),[.8,.05,.1],'Native hand air effect Fog.NONE');renderer.clearFirstPersonMesh();
   const airWorld=await draw(airEffect);near(pixel(airWorld.hdr),[0,0,0],'The same air effect must still fog world geometry');
   // Entering/exiting an environment rejects history once. Stable colors of
   // one environment retain history without world/shadow/cache invalidation.
   await draw(null,{quality:'balanced'});await draw(null,{quality:'balanced'});const before=renderer.stats();check(before.historyUsed,'Fog history proof requires stable air history');
   const water=new EnvironmentFog().sample({type:'water'}),entered=await draw(water,{quality:'balanced'});check(!entered.stats.historyUsed && entered.stats.lastTemporalReset==='environment fog type' && entered.stats.temporalResets===before.temporalResets+1,'Entering water must reject the previous air history once');
   const stable=await draw({...water,color:[.1,.2,.4]},{quality:'balanced'});check(stable.stats.historyUsed && stable.stats.temporalResets===entered.stats.temporalResets,'Same environment color transition must retain valid history');
   const exited=await draw(null,{quality:'balanced'});check(!exited.stats.historyUsed && exited.stats.temporalResets===entered.stats.temporalResets+1,'Exiting immersion must reject old history once');
   return{productionRenderer:true,uniformBytes:448,nativeVertexDistances:true,colorPolicy:'Convert final source RGB to linear HDR after native color interpolation',cases,history:{before:before.temporalResets,entered:entered.stats.temporalResets,stable:stable.stats.temporalResets,exited:exited.stats.temporalResets},firstPersonFogNone:true,firstPersonAirEffectFogNone:true,stats:renderer.stats()};
  }finally{renderer.destroy();canvas.remove();}
 });assert.deepEqual(errors,[]);await mkdir(`${prefix}/test-results`,{recursive:true});await writeFile(`${prefix}/test-results/environment-fog.json`,JSON.stringify({softwareSmoke:software,proof,errors},null,2));console.log(JSON.stringify({softwareSmoke:software,proof,errors},null,2));
}finally{await browser.close();}
