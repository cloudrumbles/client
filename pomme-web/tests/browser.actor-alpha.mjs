import assert from 'node:assert/strict';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {chromium} from 'playwright';
const prefix='.',software=process.env.POMME_SOFTWARE_GPU==='1',errors=[],world=await readFile(new URL('../src/shaders/world.wgsl',import.meta.url),'utf8');
const browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH??'/usr/bin/chromium',headless:true,args:['--no-sandbox','--enable-unsafe-webgpu',...(software?['--use-angle=swiftshader','--enable-features=Vulkan','--use-vulkan=swiftshader']:[])]});
try{
 const results={};for(const mode of['baseline','candidate']){
  const page=await browser.newPage({viewport:{width:160,height:160}});page.on('pageerror',error=>errors.push(error.message));const baseline=world.replace('texel.a * clamp(input.ambient_occlusion, 0.0, 1.0), actor_alpha','texel.a, actor_alpha').replace('albedo * lightmap, input.fog_distances, material_flags), texel.a * clamp(input.ambient_occlusion, 0.0, 1.0)','albedo * lightmap, input.fog_distances, material_flags), texel.a');assert.notEqual(baseline,world,'Native alpha proof must exercise the admitted multipliers');if(mode==='baseline')await page.route('**/src/shaders/world.wgsl',route=>route.fulfill({status:200,contentType:'text/plain',body:baseline}));await page.goto(new URL('/src/shaders/world.wgsl',process.env.POMME_URL??'http://127.0.0.1:5173').href);
  results[mode]=await page.evaluate(async()=>{
   const{createRenderer}=await import('/src/renderer.js');const check=(ok,message)=>{if(!ok)throw new Error(message);},half=bits=>{const sign=bits&0x8000?-1:1,exponent=bits>>10&31,mantissa=bits&1023;return sign*(exponent?(1+mantissa/1024)*2**(exponent-15):mantissa*2**-24);},center=image=>Array.from(image.pixels.subarray((64*image.width+64)*4,(64*image.width+64)*4+3),half);
   const base=[.05,.1,.2],source=[.8,.4,.1],quad=(radius,z,color,flags,alpha=1,tile=0)=>new Float32Array([[-radius,-radius,z],[radius,-radius,z],[radius,radius,z],[-radius,-radius,z],[radius,radius,z],[-radius,radius,z]].flatMap((p,i)=>[...p,0,0,1,...color,alpha,i%2,i%3,tile,flags]));
   document.body.replaceChildren();const canvas=document.createElement('canvas');canvas.style.cssText='width:128px;height:128px';document.body.append(canvas);const renderer=await createRenderer(canvas),frame={eye:[0,0,0],yaw:0,pitch:0,timeSeconds:10,dayPhase:.22,quality:'low',scale:1},bounds={min:[-2,-2,-2],max:[2,2,0]};
   const texture=alpha=>renderer.setTextureAtlas({pixelsRGBA:new Uint8Array([255,255,255,255,255,255,255,alpha]),width:2,height:1,tiles:[{id:0,x:0,y:0,width:1,height:1},{id:1,x:1,y:0,width:1,height:1}]});
   const draw=async()=>{renderer.render(frame);const hdr=await renderer.readPixels(),depth=await renderer.readPixels({source:'depth'});check(renderer.stats().lastError===null,renderer.stats().lastError);return{pixel:center(hdr),hdr:Array.from(hdr.pixels),depth:Array.from(depth.pixels),stats:renderer.stats()};};
   const cases=[];try{texture(255);renderer.configureWorld({...bounds,fogDensity:0});renderer.uploadChunk('background',quad(2,-2,base,16777216),[],bounds,{stride:14});const background=await draw();
    const configs=[
     ...[255,128,26].flatMap(textureAlpha=>[1,63/255,0,5/255].map(vertexAlpha=>({layer:'emissive',flags:32|16777216|134217728,textureAlpha,vertexAlpha}))),
     {layer:'emissive-cutout',flags:32|16777216|134217728,textureAlpha:5,vertexAlpha:1},
     {layer:'modern-eyes-low-alpha',flags:32|16777216|67108864,textureAlpha:5,vertexAlpha:1},
     {layer:'legacy-eyes-low-alpha',flags:32|16777216|33554432,textureAlpha:5,vertexAlpha:1},
     {layer:'breeze-wind-default',flags:32|268435456|512|(15<<10),textureAlpha:128,vertexAlpha:1},
     {layer:'breeze-wind-cutout',flags:32|268435456|512|(15<<10),textureAlpha:5,vertexAlpha:1},
     {layer:'native-beam-alpha',flags:32|16777216|536870912,textureAlpha:128,vertexAlpha:63/255},
    ];
    for(const config of configs){texture(config.textureAlpha);renderer.uploadDynamicMesh('layer',quad(.5,-1,source,config.flags,config.vertexAlpha,1),[],{min:[-.5,-.5,-1],max:[.5,.5,-.999]},{stride:14});const result=await draw();cases.push({...config,pixel:result.pixel,hdr:config.layer.startsWith('breeze')?result.hdr:undefined,depth:config.layer.startsWith('breeze')?result.depth:undefined,depthExactToBackground:result.depth.every((value,index)=>value===background.depth[index]),actorDraws:result.stats.actorLayerDraws});}
    return{background:background.pixel,cases,adapter:renderer.stats().adapterInfo};
   }finally{renderer.destroy();canvas.remove();}
  });await page.close();
 }
 const near=(actual,expected,label,tolerance=.0015)=>assert.ok(actual.every((v,i)=>Math.abs(v-expected[i])<tolerance),`${label}: ${JSON.stringify({actual,expected})}`),source=[.8,.4,.1],candidate=results.candidate;
 for(let i=0;i<candidate.cases.length;i++){const item=candidate.cases[i],control=results.baseline.cases[i];if(item.layer==='emissive'){const alpha=item.textureAlpha/255*item.vertexAlpha,expected=candidate.background.map((base,c)=>base*(1-alpha)+source[c]*alpha);near(item.pixel,expected,`Native alpha ${item.textureAlpha}/255 * ${item.vertexAlpha}`);assert.ok(item.depthExactToBackground,'Native emissive layers must preserve opaque depth');item.expected=expected;item.combinedAlpha=alpha;if(item.vertexAlpha===1)near(item.pixel,control.pixel,'Native default alpha must remain exact',1e-10);}
  else if(item.layer==='emissive-cutout')near(item.pixel,candidate.background,'Native texel cutoff before vertex alpha');
  else{near(item.pixel,control.pixel,`${item.layer} source alpha/default control`,1e-10);if(item.layer.startsWith('breeze')){assert.deepEqual(item.hdr,control.hdr,'Breeze default1 HDR must remain bit exact');assert.deepEqual(item.depth,control.depth,'Breeze default1 depth must remain bit exact');}}
  if(item.layer==='modern-eyes-low-alpha')near(item.pixel,candidate.background.map((base,c)=>base*(1-item.textureAlpha/255)+source[c]*item.textureAlpha/255),'Modern eyes preserve low sheet alpha');
  if(item.layer==='legacy-eyes-low-alpha')near(item.pixel,candidate.background.map((base,c)=>base+source[c]),'Legacy ONE/ONE eyes ignore alpha in RGB blend and preserve low-alpha texels');
  delete item.hdr;delete item.depth;
 }
 assert.deepEqual(errors,[]);const proof={productionRenderer:true,nativeCutoffBeforeVertexAlpha:true,rgbUnchanged:true,quantization:'floor(alpha*255)/255 (source ARGB.as8BitChannel)',defaultBreezeHdrDepthExact:true,...candidate};await mkdir(`${prefix}/test-results`,{recursive:true});await writeFile(`${prefix}/test-results/actor-alpha.json`,JSON.stringify({softwareSmoke:software,proof,errors},null,2));console.log(JSON.stringify({softwareSmoke:software,proof,errors},null,2));
}finally{await browser.close();}
