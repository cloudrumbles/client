import test from 'node:test';
import assert from 'node:assert/strict';
import { IRRADIANCE_LIMITS, floatToHalf, irradianceMaterials, solveIrradiance, validateIrradianceSnapshot, snapshotGeometryKey } from '../src/irradiance.js';
import { CachedIrradiance } from '../src/irradiance-cache.js';
import { createIrradianceProcessor } from '../src/irradiance.worker.js';
import { IrradianceSunCache } from '../src/irradiance-sun-cache.js';
import { irradianceMaterialKey, irradianceSourceKey } from '../src/irradiance-source-key.js';
import { IrradianceDiskCache } from '../src/irradiance-disk-cache.js';
import { IDBFactory } from 'fake-indexeddb';

const materials = new Map([[0, { opacity: 0, color: [1,1,1] }], [1, { opacity: 15, color: [.5,.5,.5] }],
  [2, { opacity: 0, emitLight: 15, emissionColor: [1,0,0], color: [1,0,0] }],
  [3, { opacity: 0, emitLight: 15, emissionColor: [0,0,1], color: [0,0,1] }],
  [4, { opacity: 15, color: [1,0,0] }]]);
const tables = irradianceMaterials(materials);
const index = (snapshot, x, y, z) => (z * snapshot.dimensions[1] + y) * snapshot.dimensions[0] + x;
const fixture = (dimensions = [16,16,16]) => {
  const cells = dimensions.reduce((a,b) => a*b, 1);
  return { origin: [-16,-64,32], dimensions, states: new Uint16Array(cells), known: new Uint8Array(cells).fill(1), sky: new Uint8Array(cells).fill(15), block: new Uint8Array(cells), sunBucket: 60, hasSkylight: true };
};
const half = value => { const exponent = value >>> 10 & 31, mantissa = value & 1023; return exponent ? (1 + mantissa / 1024) * 2 ** (exponent - 15) : mantissa * 2 ** -24; };
const sample = (volume, kind, x,y,z) => Array.from(volume[`${kind}Data`].subarray(index(volume,x,y,z)*4,index(volume,x,y,z)*4+4), half);
const write = (snapshot,x,y,z,id) => { snapshot.states[index(snapshot,x,y,z)] = id; };

test('cached colored light follows native voxel opacity and cannot cross a sealed wall or unknown cells', () => {
  const input = fixture(); write(input,3,8,8,2); write(input,12,8,8,3);
  for (let z=0;z<16;z++) for(let y=0;y<16;y++) write(input,8,y,z,1);
  const before = input.block.slice(), volume = solveIrradiance(input,tables);
  assert.ok(sample(volume,'local',7,8,8)[0] > .6);
  assert.equal(sample(volume,'local',7,8,8)[2], 0, 'blue source stays behind the wall');
  assert.ok(sample(volume,'local',9,8,8)[2] > .6);
  assert.equal(sample(volume,'local',9,8,8)[0], 0, 'red source stays behind the wall');
  assert.deepEqual(sample(volume,'local',8,8,8),[0,0,0,0]);
  input.known.fill(0); input.known[index(input,3,8,8)] = 1;
  const unknown = solveIrradiance(input,tables);
  assert.deepEqual(sample(unknown,'local',4,8,8),[0,0,0,0]);
  assert.deepEqual(input.block,before,'optional color solver never rewrites native scalar light');
  assert.ok(volume.stats.outputBytes <= IRRADIANCE_LIMITS.maxCells * 16);
});

test('removing an emitter clears its color, while exact source-local cache reuses a sun-only change', () => {
  const input = fixture([8,8,8]); write(input,2,2,2,2);
  const first = solveIrradiance(input,tables);
  const shifted = solveIrradiance({...input,sunBucket:61},tables,first.localCache);
  assert.equal(shifted.stats.localCacheHit,true);
  assert.deepEqual(shifted.localData,first.localData);
  write(input,2,2,2,0);
  const removed = solveIrradiance(input,tables);
  assert.equal(removed.stats.sourceCells,0);
  assert.ok(removed.localData.every(value=>value===0));
});

test('sun bounce uses imported surface albedo and exact nearby roof occlusion', () => {
  const input = fixture();
  for(let z=0;z<16;z++) for(let x=0;x<16;x++) write(input,x,3,z,4);
  const daylight = solveIrradiance(input,tables), reflected = sample(daylight,'bounce',8,4,8);
  assert.ok(reflected[0] > .12); assert.equal(reflected[1],0); assert.equal(reflected[2],0);
  for(let z=0;z<16;z++) for(let x=0;x<16;x++) write(input,x,6,z,1);
  const roof = solveIrradiance(input,tables);
  assert.equal(sample(roof,'bounce',8,4,8)[0],0,'sun does not pass through the roof');
  const night = solveIrradiance({...input,hasSkylight:false},tables);
  assert.ok(night.bounceData.every((value,i)=>i%4===3||value===0));
  const atlas = {tiles:[{averageColor:[0,0,1]}]};
  const tinted = irradianceMaterials(new Map([[0,{opacity:0}],[4,{opacity:15,color:[1,1,1],faces:{up:{tile:0,tint:[1,1,1]}}}]]),atlas);
  assert.deepEqual([...tinted.albedo.subarray(12,15)],[0,0,255]);
});

test('fixed volume/table budgets and half conversion reject malformed requests', () => {
  assert.equal(floatToHalf(1),0x3c00); assert.equal(floatToHalf(.5),0x3800); assert.equal(floatToHalf(0),0);
  assert.equal(half(floatToHalf(2**-20)),2**-20);
  const input=fixture();
  assert.throws(()=>validateIrradianceSnapshot({...input,dimensions:[49,16,16]}),/budget/);
  assert.throws(()=>validateIrradianceSnapshot({...input,origin:[Number.MAX_SAFE_INTEGER,0,0]}),/budget/);
  assert.throws(()=>validateIrradianceSnapshot({...input,states:new Uint16Array(1)}),/states/);
  assert.throws(()=>solveIrradiance({...input,sky:new Uint8Array(4096).fill(16)},tables),/native light/);
  assert.throws(()=>irradianceMaterials(new Map([[65536,{}]])),/material/);
});

test('worker cache detects changed actual source content and reset cancels bounded slices',async()=>{
  const process=createIrradianceProcessor({yieldControl:async()=>{},slicesPerYield:1});
  await process({type:'init',generation:1,tables});
  const snapshot=fixture([8,8,8]); write(snapshot,2,2,2,2);
  const request={type:'solve',generation:1,id:1,key:'same-controller-key',snapshot};
  const first=await process(request);
  first.localData.fill(0);
  const second=await process({...request,id:2,snapshot:{...snapshot,sunBucket:61}});
  assert.equal(second.stats.localCacheHit,true);
  assert.ok(second.localData.some(value=>value!==0),'transferred/mutated GPU result does not alias worker cache');
  write(snapshot,2,2,2,0);
  const removed=await process({...request,id:3});
  assert.equal(removed.stats.localCacheHit,false); assert.ok(removed.localData.every(value=>value===0));
  let release;
  const cancellable=createIrradianceProcessor({yieldControl:()=>new Promise(resolve=>{release=resolve;}),slicesPerYield:1});
  await cancellable({type:'init',generation:1,tables});
  const pending=cancellable(request);
  assert.equal(typeof release,'function');
  await cancellable({type:'init',generation:2,tables}); release();
  assert.equal(await pending,null);
  assert.equal(await cancellable(request),null);
});

test('all240 repeated day angles reuse exact half-float bounce bits without processing light cells', async () => {
  const process = createIrradianceProcessor({ yieldControl: async () => {} });
  await process({ type: 'init', generation: 1, tables });
  const snapshot = fixture([8, 8, 8]);
  for (let z = 0; z < 8; z++) for (let x = 0; x < 8; x++) write(snapshot, x, 2, z, 4);
  write(snapshot, 3, 3, 3, 2);
  const results = [];
  for (let sunBucket = 0; sunBucket < 240; sunBucket++) {
    const result = await process({ type: 'solve', generation: 1, id: sunBucket, key: String(sunBucket), snapshot: { ...snapshot, sunBucket } });
    assert.equal(result.stats.sunCacheHit, false); results.push(result);
  }
  for (let sunBucket = 0; sunBucket < 240; sunBucket++) {
    const result = await process({ type: 'solve', generation: 1, id: 240 + sunBucket, key: String(sunBucket), snapshot: { ...snapshot, sunBucket } });
    assert.equal(result.stats.sunCacheHit, true); assert.equal(result.stats.processedCells, 0);
    assert.deepEqual(result.localData, results[sunBucket].localData); assert.deepEqual(result.bounceData, results[sunBucket].bounceData);
    assert.equal(result.stats.sunCacheEntries, 240); assert.ok(result.stats.sunCacheBytes <= result.stats.sunCacheMaxBytes);
    result.localData.fill(0); result.bounceData.fill(0);
  }
  const repeat = await process({ type: 'solve', generation: 1, id: 500, key: 'immutable', snapshot });
  assert.deepEqual(repeat.bounceData, results[60].bounceData, 'returned buffers cannot mutate cached day lighting');
  snapshot.sky[0] = 0;
  const changed = await process({ type: 'solve', generation: 1, id: 501, key: 'light-edit', snapshot });
  assert.equal(changed.stats.sunCacheHit, false); assert.equal(changed.stats.localCacheHit, false); assert.equal(changed.stats.sunCacheEntries, 1);
});

test('hash-colliding geometry never reuses stale local or sun lighting', async () => {
  const a = fixture([4, 1, 1]), b = fixture([4, 1, 1]);
  a.states.set([9244, 7255, 26814, 65085]); b.states.set([50987, 22683, 21829, 3009]);
  assert.equal(snapshotGeometryKey(a), snapshotGeometryKey(b));
  const sourceTables = irradianceMaterials(new Map([...a.states].map(id => [id, { opacity: 0, emitLight: 15, emissionColor: [1, 0, 0] }]).concat([...b.states].map(id => [id, { opacity: 0, emitLight: 15, emissionColor: [0, 0, 1] }]))));
  const process = createIrradianceProcessor({ yieldControl: async () => {} });
  await process({ type: 'init', generation: 1, tables: sourceTables });
  const first = await process({ type: 'solve', generation: 1, id: 1, key: 'same', snapshot: a });
  const next = await process({ type: 'solve', generation: 1, id: 2, key: 'same', snapshot: b });
  assert.equal(next.stats.sunCacheHit, false); assert.equal(next.stats.localCacheHit, false);
  assert.notDeepEqual(first.localData, next.localData); assert.deepEqual(next.localData, solveIrradiance(b, sourceTables).localData);
});

test('persistent source identity survives day repetition and rejects edits, material changes and32bit hash collisions', async () => {
  const a = fixture([4, 1, 1]), b = fixture([4, 1, 1]);
  a.states.set([9244, 7255, 26814, 65085]); b.states.set([50987, 22683, 21829, 3009]);
  const materialKey = await irradianceMaterialKey(tables), first = await irradianceSourceKey(a, materialKey);
  assert.match(first, /^[0-9a-f]{64}$/);
  assert.equal(await irradianceSourceKey({ ...a, sunBucket: 0 }, materialKey), first);
  assert.notEqual(await irradianceSourceKey(b, materialKey), first);
  const edited = { ...a, sky: a.sky.slice() }; edited.sky[0]--;
  assert.notEqual(await irradianceSourceKey(edited, materialKey), first);
  assert.notEqual(await irradianceSourceKey({ ...a, hasSkylight: false }, materialKey), first);
  const changed = { ...tables, albedo: tables.albedo.slice() }; changed.albedo[0] ^= 1;
  assert.notEqual(await irradianceSourceKey(a, await irradianceMaterialKey(changed)), first);
});

test('sun-cache lossless compressed and raw paths obey LRU byte limits', () => {
  const cache = new IrradianceSunCache({ maxBytes: 100 });
  const constant = new Uint16Array(32 * 4); for (let cell = 0; cell < 32; cell++) constant.set([0x3c00, 0x3800, 0, cell % 2 ? 0 : 0x3c00], cell * 4);
  for (let bucket = 0; bucket < 10; bucket++) cache.store(bucket, constant);
  assert.equal(cache.stats().sunCacheEntries, 10); assert.deepEqual(cache.get(0), constant);
  cache.store(10, constant); assert.equal(cache.get(1), null); assert.deepEqual(cache.get(0), constant);
  const raw = constant.slice(); for (let cell = 0; cell < 32; cell++) raw[cell * 4] = cell;
  cache.store(11, raw); assert.equal(cache.get(11), null, 'oversize entries do not exceed the cache budget');
  const rawCache = new IrradianceSunCache({ maxBytes: 200 }); rawCache.store(0, raw); assert.deepEqual(rawCache.get(0), raw);
  cache.clear(); assert.equal(cache.stats().sunCacheBytes, 0);
});

test('disk lighting survives worker generations, prefetches periodic angles, and rejects changed sources', async () => {
  const disk = new IrradianceDiskCache({ indexedDB: new IDBFactory() });
  const processor = createIrradianceProcessor({ yieldControl: async () => {}, diskCache: disk });
  const snapshot = fixture([8, 8, 8]);
  for (let z = 0; z < 8; z++) for (let x = 0; x < 8; x++) write(snapshot, x, 2, z, 4);
  const wait = async predicate => { for (let at = 0; at < 500; at++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 1)); } assert.fail('Lighting storage did not settle.'); };
  await processor({ type: 'init', generation: 1, tables });
  const first = await processor({ type: 'solve', generation: 1, id: 1, key: 'a', snapshot }); await wait(() => disk.stats().diskPending === 0);
  const next = await processor({ type: 'solve', generation: 1, id: 2, key: 'b', snapshot: { ...snapshot, sunBucket: 61 } }); await wait(() => disk.stats().diskPending === 0);
  assert.equal(first.stats.diskCacheHit, false); assert.equal(next.stats.diskCacheHit, false); assert.equal(disk.stats().diskWrites, 2);
  await processor({ type: 'init', generation: 2, tables });
  const restored = await processor({ type: 'solve', generation: 2, id: 3, key: 'restore', snapshot });
  assert.equal(restored.stats.diskCacheHit, true); assert.equal(restored.stats.processedCells, 0); assert.deepEqual(restored.bounceData, first.bounceData); assert.deepEqual(restored.localData, first.localData);
  await wait(() => disk.stats().diskPending === 0);
  const prefetched = await processor({ type: 'solve', generation: 2, id: 4, key: 'prefetch', snapshot: { ...snapshot, sunBucket: 61 } });
  assert.equal(prefetched.stats.diskCacheHit, false); assert.equal(prefetched.stats.prefetchedSunCacheHit, true); assert.equal(prefetched.stats.processedCells, 0); assert.deepEqual(prefetched.bounceData, next.bounceData);
  snapshot.sky[0] = 0;
  const edited = await processor({ type: 'solve', generation: 2, id: 5, key: 'edit', snapshot });
  assert.equal(edited.stats.diskCacheHit, false); assert.equal(edited.stats.sunCacheHit, false); assert.deepEqual(edited.bounceData, solveIrradiance(snapshot, tables).bounceData);
  await disk.close(); assert.equal(disk.stats().diskErrors, 0);
});

test('disk latency and failures cannot publish a retired world or prevent a fresh solve', async () => {
  let release;
  const delayed = { get: () => new Promise(resolve => { release = resolve; }), put: async () => null };
  const processor = createIrradianceProcessor({ diskCache: delayed, yieldControl: async () => {} });
  await processor({ type: 'init', generation: 1, tables });
  const pending = processor({ type: 'solve', generation: 1, id: 1, key: 'old', snapshot: fixture([8, 8, 8]) });
  for (let at = 0; at < 100 && !release; at++) await new Promise(resolve => setTimeout(resolve, 1));
  assert.equal(typeof release, 'function');
  await processor({ type: 'init', generation: 2, tables }); release(null); assert.equal(await pending, null);
  const failing = createIrradianceProcessor({ diskCache: { get: async () => { throw new Error('Storage denied'); }, put: async () => { throw new Error('Quota exceeded'); } }, yieldControl: async () => {} });
  await failing({ type: 'init', generation: 1, tables });
  const snapshot = fixture([8, 8, 8]); write(snapshot, 3, 3, 3, 2);
  const result = await failing({ type: 'solve', generation: 1, id: 1, key: 'fresh', snapshot });
  assert.equal(result.stats.diskCacheHit, false); assert.deepEqual(result.localData, solveIrradiance(snapshot, tables).localData);
});

function harness() {
  const tasks=[], workers=[], volumes=[], statuses=[];
  const cache=new CachedIrradiance({onVolume:volume=>volumes.push(volume),onStatus:message=>statuses.push(message),
    workerFactory:()=>{const worker={messages:[],terminate(){this.terminated=true;},postMessage(message,transfer=[]){this.messages.push(structuredClone(message,{transfer}));}}; workers.push(worker); return worker;},
    schedule:callback=>{tasks.push(callback);return callback;},cancelSchedule:callback=>{const at=tasks.indexOf(callback);if(at>=0)tasks.splice(at,1);}});
  const run=()=>{assert.ok(tasks.length);tasks.shift()();};
  const finish=(worker=workers.at(-1),job=worker.messages.at(-1))=>{
    const cells=job.snapshot.dimensions.reduce((a,b)=>a*b,1);
    worker.onmessage({data:{type:'irradiance-result',generation:job.generation,id:job.id,key:job.key,origin:job.snapshot.origin,dimensions:job.snapshot.dimensions,localData:new Uint16Array(cells*4),bounceData:new Uint16Array(cells*4),stats:{workerMs:1}}});
  };
  cache.configure({materials,minY:-64,height:384,generation:7});
  return {cache,tasks,workers,volumes,statuses,run,finish};
}
function sourceColumn(x=0,z=0){return{x,z,sections:Array.from({length:24},(_,i)=>({sectionY:i-4,blocks:new Uint16Array(4096)}))};}

test('controller copies only a capped Y band, ignores unchanged frames, and rejects stale edited jobs',()=>{
  const {cache,run,finish,workers,volumes,tasks}=harness();
  const source=sourceColumn(), columns=new Map([['0,0',source]]);
  cache.update({eye:[8,8,8],dayPhase:.25,columns});
  assert.equal(cache.columns.get('0,0').sections.size,3);
  assert.ok(cache.stats().sourceBytes<=IRRADIANCE_LIMITS.maxSections*12288);
  source.sections.find(s=>s.sectionY===0).blocks[0]=3;
  assert.equal(cache.columns.get('0,0').sections.get(0).blocks[0],0,'mirror owns its clipped copies');
  run(); const worker=workers[0], stale=worker.messages.at(-1);
  cache.setBlock(2,2,2,2); finish(worker,stale);
  assert.equal(cache.stats().discardedJobs,1); assert.equal(volumes.filter(Boolean).length,0);
  run(); finish(); const stable=cache.stats();
  for(let frame=0;frame<1000;frame++)cache.update({eye:[8.2,8.3,8.1],dayPhase:.25001,columns});
  assert.equal(cache.stats().volumeUploads,stable.volumeUploads); assert.equal(tasks.length,0);
  assert.equal(cache.stats().reusedFrames,1000);
  assert.equal(cache.setBlock(2,2,2,2),false,'same native state does not invalidate cache');
  cache.update({eye:[8,8,8],dayPhase:.26,columns}); assert.equal(tasks.length,1,'only quantized sun change enqueues a solve');
  cache.destroy(); assert.equal(worker.terminated,true); assert.equal(cache.stats().sourceBytes,0);
});

test('controller re-centers through negative coordinates, removes unloaded sources and bounds full world mirrors',()=>{
  const {cache,run,finish}=harness();
  const columns=new Map();for(let z=-8;z<=8;z++)for(let x=-8;x<=8;x++)columns.set(`${x},${z}`,sourceColumn(x,z));
  cache.update({eye:[-9,-1,-9],columns,dayPhase:.25});
  assert.equal(cache.stats().sourceColumns,16);
  assert.ok(cache.stats().sourceBytes<=cache.stats().maxSourceBytes);
  assert.equal(cache.stats().snapshotBytes,IRRADIANCE_LIMITS.maxCells*5);
  run();finish();
  assert.equal(cache.removeColumn(-1,-1),true);
  assert.equal(cache.removeColumn(-1,-1),false);
  assert.equal(cache.setColumn(sourceColumn(20,20)),false);
  cache.update({eye:[81,241,81],columns,dayPhase:.25});
  assert.ok(cache.stats().origin[1]>=-64);assert.ok(cache.stats().origin[1]+cache.stats().dimensions[1]<=320);
  assert.ok([...cache.columns.values()].every(column=>column.x>=3&&column.z>=3));
  assert.ok(cache.stats().sourceColumns<=16);
  cache.destroy();
});

test('native light updates invalidate color visibility without changing block states, and old generations cannot upload',()=>{
  const {cache,run,finish,workers,volumes}=harness();
  const column=sourceColumn();cache.update({eye:[8,8,8],columns:new Map([['0,0',column]]),dayPhase:.25});run();finish();
  const before=cache.columns.get('0,0').sections.get(0).blocks.slice();
  const sky=new Uint8Array(2048).fill(255);assert.equal(cache.setLight(0,0,{sky:new Map([[0,sky]]),block:new Map()}),true);
  assert.equal(volumes.at(-1),null); assert.equal(cache.setLight(0,0,{sky:new Map([[0,sky]])}),false);
  assert.deepEqual(cache.columns.get('0,0').sections.get(0).blocks,before);
  run();const old=workers[0],job=old.messages.at(-1);
  cache.configure({materials,minY:0,height:16,generation:8});
  old.onmessage({data:{type:'irradiance-result',generation:7,id:job.id,key:job.key}});
  assert.equal(volumes.at(-1),null);assert.equal(old.terminated,true);
  cache.destroy();
});
