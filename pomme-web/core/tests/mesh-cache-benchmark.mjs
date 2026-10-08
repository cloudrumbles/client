// Compare release WASM binaries against the same source-backed meshing scenes.
// This measures CPU meshing only; it is not a GPU/FPS benchmark.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
const options=new Map();for(let at=2;at<process.argv.length;at+=2)options.set(process.argv[at],process.argv[at+1]);
if(!options.has('--baseline')||!options.has('--candidate'))throw new Error('Supply --baseline <release.wasm> --candidate <release.wasm> [--iterations 100] [--output report.json].');
const iterations=Math.max(20,Math.min(500,Number(options.get('--iterations')??100)));
const binaries=await Promise.all(['--baseline','--candidate'].map(async key=>{const bytes=await readFile(options.get(key));return {module:await WebAssembly.compile(bytes),sha256:createHash('sha256').update(bytes).digest('hex')};}));
const hash=mesh=>createHash('sha256').update(new Uint8Array(mesh.buffer,mesh.byteOffset,mesh.byteLength)).digest('hex');
function mesh(core,index,water){const count=core.mesh_chunk(index,water);return new Float32Array(core.memory.buffer,core.mesh_ptr(),count*14).slice();}
function load(core,x,y,z,blocks){const pointer=core.world_stage_ptr();new Uint16Array(core.memory.buffer,pointer,4096).set(blocks);assert.equal(core.world_load_section(x,y,z,pointer,4096),1);}
async function fixture(module,name) {
  const {exports:core}=await WebAssembly.instantiate(module,{});assert.equal(core.world_reset(-32,64,-1,-1,3,3),1);
  core.block_registry_begin();
  for(const [id,flags]of[[500,3],[501,48],[502,3],[503,68],[504,48]])assert.equal(core.block_register(id,.4,.6,.8,flags),1);
  assert.equal(core.block_light_emission(502,12),1);
  for(const id of[503,504])assert.equal(core.block_fluid_register(id,1,4,2,3),1);
  assert.equal(core.block_face_tint(500,2,1,1,1,1),1);
  const model=Float32Array.from([[0,.4,0],[0,.4,1],[1,.4,1]].flatMap(p=>[...p,0,1,0,.8,.6,.4,1,0,0,1,48]));
  for(const id of[501,504]) {const pointer=core.world_float_stage_ptr();new Float32Array(core.memory.buffer,pointer,model.length).set(model);assert.equal(core.block_model_register(id,pointer,model.length),1);}
  assert.equal(core.biome_tints_register(0,0x7cbd6b,0x48b518,4159204,0),1);core.block_registry_end();
  for(let z=-1;z<=1;z++)for(let x=-1;x<=1;x++)for(let y=-2;y<2;y++) {
    const blocks=new Uint16Array(4096);
    for(let at=0;at<4096;at++) {
      const lx=at&15,lz=at>>4&15,ly=at>>8,salt=(lx*17+ly*31+lz*43+x*7+z*11+y*13)>>>0;
      if(name==='opaque_uniform')blocks[at]=500;
      else if(name==='native_terrain')blocks[at]=(salt%13<6)?500:(salt%17===0)?502:0;
      else if(name==='native_models')blocks[at]=salt%127===0?501:salt%31===0?500:0;
      else blocks[at]=salt%11<4?503:salt%19===0?504:salt%7===0?500:0;
    }
    load(core,x,y,z,blocks);
    const pointer=core.world_stage_ptr(),light=new Uint8Array(core.memory.buffer,pointer,4096);
    for(let at=0;at<4096;at++)light[at]=((at+y+32)%16)<<4|(at+x+z+32)%16;
    assert.equal(core.world_load_light(x,y,z,pointer,pointer+2048,2048),1);
  }
  core.block_render_override(8,0,8,0);
  return core;
}
const results=[];
for(const name of['opaque_uniform','native_terrain','native_models','contained_fluid']) {
  const cores=await Promise.all(binaries.map(binary=>fixture(binary.module,name)));
  const water=name==='contained_fluid'?1:0,index=4;
  const before=mesh(cores[0],index,water),after=mesh(cores[1],index,water);assert.deepEqual(after,before,`${name} complete vertex/AO/light/UV/native shape output`);
  for(const core of cores)for(let warm=0;warm<15;warm++)core.mesh_chunk(index,water);
  const timings=[[],[]];
  for(let round=0;round<iterations;round++)for(const side of round%2?[1,0]:[0,1]) {const start=performance.now();cores[side].mesh_chunk(index,water);timings[side].push(performance.now()-start);}
  const stats=values=>{const sorted=values.slice().sort((a,b)=>a-b);return {medianMs:sorted[Math.floor(sorted.length*.5)],p95Ms:sorted[Math.floor(sorted.length*.95)]};};
  const baseline=stats(timings[0]),candidate=stats(timings[1]);
  // Neighbor edit, native light replacement, and visual override removal must
  // invalidate the ephemeral cache before the next mesh, without stale samples.
  for(const core of cores){core.block_set(15,0,8,502);core.block_render_override(8,0,8,0xffffffff);const p=core.world_stage_ptr();new Uint8Array(core.memory.buffer,p,4096).fill(0x12);core.world_load_light(0,0,0,p,p+2048,2048);}
  assert.deepEqual(mesh(cores[1],index,water),mesh(cores[0],index,water),`${name} post-mutation exact output`);
  results.push({scene:name,iterations,vertices:before.length/14,completeVertexSha256:hash(before),completeOutputExact:true,postMutationOutputExact:true,baseline,candidate,medianSpeedup:baseline.medianMs/candidate.medianMs});
}
const report={measurement:'Node release-WASM CPU meshing; no GPU or hardware FPS claim',source:'Sodium ArrayLightDataCache port at 8aa723c69af6ce40255862df6c3bf8c6cca9d883',baselineSha256:binaries[0].sha256,candidateSha256:binaries[1].sha256,cacheBytes:64000,cacheSamples:8000,results};
if(options.has('--output'))await writeFile(options.get('--output'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
