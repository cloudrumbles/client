import { test } from 'node:test';
import assert from 'node:assert/strict';
import { solveColumnLighting, ColumnLightingCache } from '../src/lighting.js';

const materials = new Map([[0, { flags: 128, opacity: 0, emitLight: 0 }], [1, { flags: 3, opacity: 15, emitLight: 0 }],
  [2, { flags: 9, opacity: 15, emitLight: 15 }], [3, { flags: 4, filterLight: 3, emitLight: 0 }]]);
function column(x = 0, z = 0) { return { x, z, sections: [], revision: 0 }; }
function set(column, x, y, z, id) {
  const sy = Math.floor(y / 16);
  let section = column.sections.find(section => section.sectionY === sy);
  if (!section) { section = { sectionY: sy, blocks: new Uint16Array(4096) }; column.sections.push(section); }
  section.blocks[((y % 16 + 16) % 16) * 256 + z * 16 + x] = id;
  column.revision++;
}
function sample(light, kind, x, y, z) {
  const bytes = light[kind].get(Math.floor(y / 16));
  const index = ((y % 16 + 16) % 16) * 256 + z * 16 + x;
  return bytes[index >>> 1] >>> ((index & 1) * 4) & 15;
}
function solve(center, options = {}) { return solveColumnLighting({ ...center, materials, minY: -64, height: 80, ...options }); }

test('open sky is cached as full light with signed section coordinates and packed nibbles', () => {
  const result = solve(column(-3, -5));
  assert.deepEqual([...result.sky.keys()], [-4, -3, -2, -1, 0]);
  assert.ok([...result.sky.values()].every(bytes => bytes.length === 2048 && bytes.every(value => value === 255)));
  assert.ok([...result.block.values()].every(bytes => bytes.every(value => value === 0)));
  assert.equal(result.stats.processed, 0, 'uniform open sky needs no flood fill');
  const noSky = solve(column(), { hasSkylight: false });
  assert.equal(sample(noSky, 'sky', 8, 0, 8), 0);
});

test('opaque roof blocks direct sky, openings bend light, and closing them removes it', () => {
  const center = column();
  for(let z=0;z<16;z++) for(let x=0;x<16;x++) set(center,x,0,z,1);
  assert.equal(sample(solve(center), 'sky', 8, -1, 8), 0);
  set(center,8,0,8,0);
  const opened = solve(center);
  assert.equal(sample(opened,'sky',8,-1,8),15);
  assert.equal(sample(opened,'sky',9,-1,8),14);
  assert.equal(sample(opened,'sky',10,-1,8),13);
  set(center,8,0,8,1);
  assert.equal(sample(solve(center),'sky',8,-1,8),0,'no stale light remains after closing the hole');
});

test('transparent filterLight attenuates sunlight while opaque source voxels still emit', () => {
  const center = column();
  for(let z=0;z<16;z++) for(let x=0;x<16;x++) set(center,x,0,z,1);
  set(center,8,0,8,3);
  const filtered = solve(center);
  assert.equal(sample(filtered,'sky',8,0,8),12);
  assert.equal(sample(filtered,'sky',8,-1,8),11);
  set(center,8,-10,8,2);
  const glowing = solve(center);
  assert.equal(sample(glowing,'block',8,-10,8),15);
  assert.equal(sample(glowing,'block',9,-10,8),14);
  assert.equal(sample(glowing,'block',10,-10,8),13);
});

test('block light respects enclosure and disappears when the emitter is removed', () => {
  const center = column();
  set(center,8,-10,8,2);
  for(const [dx,dy,dz] of [[-1,0,0],[1,0,0],[0,-1,0],[0,1,0],[0,0,-1],[0,0,1]]) set(center,8+dx,-10+dy,8+dz,1);
  const enclosed = solve(center);
  assert.equal(sample(enclosed,'block',8,-10,8),15);
  assert.equal(sample(enclosed,'block',10,-10,8),0);
  set(center,9,-10,8,0);
  assert.equal(sample(solve(center),'block',10,-10,8),13);
  set(center,8,-10,8,0);
  assert.ok([...solve(center).block.values()].every(bytes => bytes.every(value => value === 0)));
});

test('native neighbouring columns supply light across negative chunk boundaries', () => {
  const center = column(-3,-5), west = column(-4,-5);
  set(west,15,-10,8,2);
  const neighbors = new Map([['-4,-5',west]]);
  assert.equal(sample(solve(center,{neighbors}),'block',0,-10,8),14);
  assert.equal(sample(solve(center),'block',0,-10,8),0,'unloaded neighbours are not invented source data');
});

test('local solver handles complete Overworld height and uniformly filled sections', () => {
  const center = column();
  center.sections.push({sectionY:-4,blocks:new Uint16Array(4096).fill(1)});
  const result = solveColumnLighting({...center,materials});
  assert.equal(result.sky.size,24);
  assert.equal(result.stats.uniformSections,1);
  assert.equal(sample(result,'sky',8,-64,8),0);
  assert.equal(sample(result,'sky',8,319,8),15);
});

test('revision cache is bounded, invalidates neighbour targets and returns owned copies', () => {
  const center = column(), cache = new ColumnLightingCache({maxEntries:1,maxBytes:2048*10});
  const input = {...center,materials,minY:-64,height:80};
  const first = cache.solve(input);
  assert.equal(first.stats.cacheHit,false);
  first.sky.get(-4).fill(0);
  const second = cache.solve(input);
  assert.equal(second.stats.cacheHit,true);
  assert.equal(sample(second,'sky',8,-64,8),15,'caller writes cannot corrupt cached values');
  set(center,8,-10,8,2);
  const changed = cache.solve({...input,sections:center.sections,revision:center.revision});
  assert.equal(changed.stats.cacheHit,false);
  assert.equal(sample(changed,'block',9,-10,8),14);
  cache.invalidate(1,0);
  assert.equal(cache.entries.size,0,'edited adjacent column invalidates the target halo');
  const noRevision = {...input}; delete noRevision.revision;
  assert.equal(cache.solve(noRevision).stats.cacheHit,false);
  assert.equal(cache.solve(noRevision).stats.cacheHit,false,'unknown freshness bypasses cache');
  const tiny = new ColumnLightingCache({maxBytes:1}); tiny.solve(input);
  assert.equal(tiny.bytes,0);
});

test('malformed local bounds, duplicate sections and invalid block arrays are rejected', () => {
  assert.throws(()=>solve(column(),{minY:-63}),/bounds/);
  assert.throws(()=>solve(column(),{height:1025}),/bounds/);
  assert.throws(()=>solve({...column(),sections:[{sectionY:0,blocks:new Uint16Array(4095)}]}),/4096/);
  const section={sectionY:0,blocks:new Uint16Array(4096)};
  assert.throws(()=>solve({...column(),sections:[section,section]}),/distinct/);
});
