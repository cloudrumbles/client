import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const wasm = await WebAssembly.compile(await readFile(new URL('../target/wasm32-unknown-unknown/release/pomme_web_core.wasm', import.meta.url)));

async function importedWorld() {
  const { exports: core } = await WebAssembly.instantiate(wasm, {});
  assert.equal(core.world_reset(-64, 384, -2, -3, 4, 4), 1);
  return core;
}

function section(core, cx, sy, cz, values) {
  assert.equal(core.world_stage_capacity(), 4096);
  const ptr = core.world_stage_ptr();
  new Uint16Array(core.memory.buffer, ptr, 4096).set(values);
  return core.world_load_section(cx, sy, cz, ptr, 4096);
}

function mesh(core, index, water = 0) {
  const vertices = core.mesh_chunk(index, water);
  return new Float32Array(core.memory.buffer, core.mesh_ptr(), vertices * core.mesh_vertex_stride()).slice();
}

function slot(core, cx, cz) {
  return (cz - core.world_origin_z() / 16) * (core.world_width() / 16) + cx - core.world_origin_x() / 16;
}

function nativeMesh(core, cx, cz, water = 0) {
  const originX = core.mesh_origin_x(), originZ = core.mesh_origin_z();
  return Array.from(mesh(core, slot(core, cx, cz), water), (value, index) => value + (index % 14 === 0 ? originX : index % 14 === 2 ? originZ : 0));
}

function cleanAll(core) {
  for (let i = 0; i < core.world_chunk_count(); i++) core.mesh_clean(i);
}

function dirtyCount(core) {
  let count = 0;
  for (let i = 0; i < core.world_chunk_count(); i++) count += core.mesh_dirty(i);
  return count;
}

test('import ABI preserves full state IDs, signed height and sparse native coordinates', async () => {
  assert.deepEqual(WebAssembly.Module.imports(wasm), []);
  const core = await importedWorld();
  assert.equal(core.mesh_vertex_stride(), 14);
  assert.deepEqual([core.world_origin_x(),core.world_min_y(),core.world_origin_z()],[-32,-64,-48]);
  assert.deepEqual([core.world_width(),core.world_height(),core.world_depth()],[64,384,64]);
  const values = new Uint16Array(4096);
  values[(15*16+1)*16+2] = 50000;
  assert.equal(core.block_register(50000,0.2,0.4,0.6,3),1);
  assert.equal(section(core,-1,-4,-2,values),1);
  assert.equal(core.block_get(-14,-49,-31),50000);
  assert.equal(core.block_get(-14,-65,-31),0);
  assert.equal(core.terrain_height(-14,-31),-48);
  assert.equal(core.world_section_count(),1);
  assert.equal(core.world_column_loaded(-1,-2),1);
  assert.equal(core.world_revision(),2);
  const geometry = mesh(core,5);
  assert.equal(geometry.length,36*14);
  for(let i=0;i<geometry.length;i+=14) {
    assert.ok(geometry[i]>=18 && geometry[i]<=19,'X rebased before float conversion');
    assert.ok(geometry[i+1]>=-49 && geometry[i+1]<=-48,'Y remains native');
    assert.ok(geometry[i+2]>=17 && geometry[i+2]<=18,'Z rebased before float conversion');
  }
  assert.equal(section(core,-1,-4,-2,values),1,'duplicate accepted');
  assert.equal(core.world_revision(),2,'duplicate does not invalidate');
  assert.equal(core.world_load_section(-1,-4,-2,core.world_stage_ptr()+2,4096),0,'foreign pointers rejected');
  assert.equal(core.world_load_section(-1,-4,-2,core.world_stage_ptr(),4095),0,'bad length rejected');
});

test('empty imported sections allocate no block arrays and moving windows retain overlap', async () => {
  const core = await importedWorld();
  const empty = new Uint16Array(4096);
  assert.equal(section(core,-1,-4,-2,empty),1);
  assert.equal(core.world_column_loaded(-1,-2),1);
  assert.equal(core.world_section_count(),0);
  const values = empty.slice(); values[0]=300;
  assert.equal(section(core,-1,-4,-2,values),1);
  assert.equal(core.world_rebase(-1,-2),1);
  assert.equal(core.block_get(-16,-64,-32),300);
  assert.equal(core.world_section_count(),1);
  assert.equal(core.mesh_dirty(0),1);
  assert.equal(core.world_unload_column(-1,-2),1);
  assert.equal(core.block_get(-16,-64,-32),0);
  assert.equal(core.world_section_count(),0);
  assert.equal(core.world_unload_column(-1,-2),0);
  assert.equal(core.world_reset(-63,384,0,0,1,1),0,'unaligned import configuration rejected');
});

test('a full 16-square moving window retains exact native opaque/fluid meshes and remeshes only its strips', async () => {
  const core = await importedWorld();
  assert.equal(core.world_reset(-64, 384, -8, -8, 16, 16), 1);
  const stone = new Uint16Array(4096).fill(3), water = new Uint16Array(4096).fill(7);
  for (let z = -8; z < 8; z++) for (let x = -8; x < 8; x++) {
    assert.equal(section(core, x, -4, z, stone), 1);
    assert.equal(section(core, x, -3, z, water), 1);
  }
  const previous = new Map(), revisions = new Map();
  for (let z = -8; z < 8; z++) for (let x = -6; x < 8; x++) {
    revisions.set(`${x},${z}`, core.chunk_revision(slot(core, x, z)));
    for (const pass of [0, 1]) {
      const geometry = nativeMesh(core, x, z, pass);
      assert.ok(geometry.length > 0);
      previous.set(`${x},${z},${pass}`, geometry);
    }
  }
  cleanAll(core);
  const revision = core.world_revision();
  assert.equal(core.world_rebase(-7, -8), 1);
  assert.equal(core.world_revision(), revision + 1);
  assert.equal(dirtyCount(core), 32, '16 entering and 16 eviction-adjacent columns; 224 interior meshes remain reusable');
  for (let z = -8; z < 8; z++) for (let x = -7; x < 9; x++) {
    const index = slot(core, x, z);
    if (x === -7 || x === 8) {
      assert.equal(core.mesh_dirty(index), 1);
      assert.equal(core.chunk_revision(index), revision + 1);
    } else {
      assert.equal(core.mesh_dirty(index), 0);
      assert.equal(core.chunk_revision(index), revisions.get(`${x},${z}`));
      for (const pass of [0, 1]) assert.deepEqual(nativeMesh(core, x, z, pass), previous.get(`${x},${z},${pass}`));
      assert.equal(core.terrain_height(x * 16, z * 16), -48);
      assert.equal(core.collides_aabb(x * 16 + 0.1, -63.9, z * 16 + 0.1, x * 16 + 0.9, -63.1, z * 16 + 0.9), 1);
    }
  }
});

test('diagonal eviction rebuilds native AO rather than retaining a stale dark corner', async () => {
  const core = await importedWorld();
  assert.equal(core.world_reset(0, 16, -1, -1, 4, 4), 1);
  assert.equal(core.block_set(0, 5, 0, 3), 1);
  assert.equal(core.block_set(-1, 6, -1, 3), 1);
  const before = nativeMesh(core, 0, 0);
  const ao = geometry => geometry.filter((_value, index) => index % 14 === 9);
  assert.ok(ao(before).some(value => value < 1));
  cleanAll(core);
  assert.equal(core.world_rebase(0, 0), 1);
  assert.equal(dirtyCount(core), 8, 'seven entering slots and one retained diagonal neighbor');
  assert.equal(core.mesh_dirty(slot(core, 0, 0)), 1);
  assert.equal(core.mesh_dirty(slot(core, 1, 1)), 0);
  const after = nativeMesh(core, 0, 0);
  assert.equal(after.length, before.length);
  assert.ok(ao(after).every(value => value === 1));
});

test('light-only eviction invalidates an adjacent retained face', async () => {
  const core = await importedWorld();
  assert.equal(core.world_reset(0, 16, 0, 0, 4, 4), 1);
  assert.equal(core.block_set(16, 5, 24, 3), 1);
  const ptr = core.world_stage_ptr();
  new Uint8Array(core.memory.buffer, ptr, 2048).fill(0x33);
  new Uint8Array(core.memory.buffer, ptr + 2048, 2048).fill(0x99);
  assert.equal(core.world_load_light(0, 0, 1, ptr, ptr + 2048, 2048), 1);
  assert.equal(core.world_column_loaded(0, 1), 0);
  const faceLights = () => {
    const geometry = nativeMesh(core, 1, 1), lights = [];
    for (let i = 0; i < geometry.length; i += 14) if (geometry[i + 3] === -1) lights.push([geometry[i + 13] >>> 10 & 15, geometry[i + 13] >>> 14 & 15]);
    return lights;
  };
  assert.ok(faceLights().every(([sky, block]) => sky === 3 && block === 9));
  cleanAll(core);
  assert.equal(core.world_rebase(1, 0), 1);
  assert.equal(core.mesh_dirty(slot(core, 1, 1)), 1);
  assert.ok(faceLights().every(([sky, block]) => sky === 15 && block === 0));
});

test('pending edits retain dirty flags and revisions by native coordinate through rebase and teleport', async () => {
  const core = await importedWorld();
  assert.equal(core.world_reset(0, 16, 0, 0, 4, 4), 1);
  const stone = new Uint16Array(4096).fill(3);
  for (let z = 0; z < 4; z++) for (let x = 0; x < 4; x++) section(core, x, 0, z, stone);
  cleanAll(core);
  assert.equal(core.block_set(40, 8, 40, 7), 1);
  const revision = core.world_revision();
  assert.equal(core.world_rebase(1, 0), 1);
  assert.equal(core.mesh_dirty(slot(core, 2, 2)), 1);
  assert.equal(core.chunk_revision(slot(core, 2, 2)), revision);
  assert.equal(core.block_get(40, 8, 40), 7);
  assert.equal(dirtyCount(core), 9);
  const rebasedRevision = core.world_revision();
  assert.equal(core.world_rebase(1, 0), 1);
  assert.equal(core.world_revision(), rebasedRevision, 'same origin is a no-op');
  assert.equal(core.chunk_revision(slot(core, 2, 2)), revision);
  assert.equal(core.world_rebase(100, -100), 1);
  assert.equal(dirtyCount(core), 16, 'a nonoverlapping teleport replaces every mesh slot');
  assert.equal(core.world_section_count(), 0);
  for (let i = 0; i < 16; i++) assert.equal(core.chunk_revision(i), core.world_revision());
});

test('real model/collision staging shares templates and preserves nonfull geometry', async () => {
  const core = await importedWorld();
  assert.equal(core.block_register(600,0.8,0.2,0.1,17),1);
  assert.equal(core.block_register(601,0.8,0.2,0.1,17),1);
  const template = [];
  for(const p of [[0,0.5,0],[0,0.5,1],[1,0.5,1],[0,0.5,0],[1,0.5,1],[1,0.5,0]]) template.push(...p,0,1,0,0.8,0.2,0.1,1,0,0,4,17);
  const ptr = core.world_float_stage_ptr();
  assert.ok(core.world_float_stage_capacity()>=32768);
  new Float32Array(core.memory.buffer,ptr,template.length).set(template);
  assert.equal(core.block_model_register(600,ptr,template.length),1);
  assert.equal(core.block_model_register(601,ptr,template.length),1);
  assert.equal(core.world_model_float_count(),template.length,'one allocation for shared template');
  new Float32Array(core.memory.buffer,ptr,6).set([0,0,0,1,0.5,1]);
  assert.equal(core.block_collision_register(600,ptr,1),1);
  assert.equal(core.block_set(-14,-60,-31,600),1);
  const geometry = mesh(core,5);
  assert.equal(geometry.length,6*14);
  for(let i=0;i<geometry.length;i+=14) assert.equal(geometry[i+1],-59.5);
  assert.equal(core.collides_aabb(-13.9,-59.9,-30.9,-13.1,-59.6,-30.1),1);
  assert.equal(core.collides_aabb(-13.9,-59.4,-30.9,-13.1,-58,-30.1),0);
  assert.equal(core.ray_cast(-13.5,-58,-30.5,0,-1,0,6),1);
  assert.equal(core.ray_cast(-15.5,-59.25,-30.5,1,0,0,6),0);
  assert.equal(core.block_model_register(600,ptr+4,template.length),0,'foreign float pointer rejected');
  assert.equal(core.block_model_register(600,ptr,core.world_float_stage_capacity()+1),0,'excessive template rejected');
});

test('registry batches invalidate once and reset preserves prepared materials', async () => {
  const core = await importedWorld();
  const blocks = new Uint16Array(4096); blocks[0]=300;
  section(core,-1,-4,-2,blocks);
  const before = core.world_revision();
  assert.equal(core.block_registry_begin(),1);
  assert.equal(core.block_register(300,0.2,0.4,0.6,3),1);
  assert.equal(core.block_face_tile(300,2,7,90),1);
  assert.equal(core.world_revision(),before);
  assert.equal(core.block_registry_end(),1);
  assert.equal(core.world_revision(),before+1);
  assert.equal(core.block_registry_end(),0);
  assert.equal(core.world_reset(-64,384,-2,-3,4,4),1);
  assert.equal(core.block_flags(300),3);
  assert.equal(core.world_section_count(),0);
  assert.equal(core.block_register(301,0,0,0,128),1);
  assert.equal(core.block_set(-14,-60,-31,301),1);
  assert.equal(mesh(core,5).length,0,'nonzero cave/void air IDs remain invisible');
});

test('window-relative F32 meshes preserve voxel size near the Minecraft world border', async () => {
  const core = await importedWorld();
  assert.equal(core.world_reset(-64,384,1874998,-1874998,2,2),1);
  const x = core.world_origin_x()+1, z = core.world_origin_z()+1;
  assert.equal(core.block_set(x,-60,z,300),1);
  const geometry = mesh(core,0);
  const xs = [], zs = [];
  for(let i=0;i<geometry.length;i+=14) { xs.push(geometry[i]); zs.push(geometry[i+2]); }
  assert.equal(Math.min(...xs),1); assert.equal(Math.max(...xs),2);
  assert.equal(Math.min(...zs),1); assert.equal(Math.max(...zs),2);
  assert.deepEqual([core.mesh_origin_x(),core.mesh_origin_z()],[x-1,z-1]);
  assert.equal(core.collides_aabb(x+0.1,-59.9,z+0.1,x+0.9,-59.1,z+0.9),1,'f64 query preserves subblock body at world border');
  assert.equal(core.collides_aabb(x-0.9,-59.9,z+0.1,x-0.1,-59.1,z+0.9),0);
  assert.equal(core.ray_cast(x-1.5,-59.5,z+0.5,1,0,0,6),1);
});

test('native packed light arrays produce darkness and preserve independently updated channels', async () => {
  const core=await importedWorld();
  assert.equal(core.block_set(-14,-60,-31,300),1);
  const ptr=core.world_stage_ptr();
  new Uint8Array(core.memory.buffer,ptr,4096).fill(0);
  assert.equal(core.world_load_light(-1,-4,-2,ptr,ptr+2048,2048),1);
  assert.equal(core.world_light_section_count(),1);
  const darkGeometry=mesh(core,5);
  for(let i=0;i<darkGeometry.length;i+=14) {
    assert.equal(darkGeometry[i+13]>>>10&15,0);
    assert.equal(darkGeometry[i+13]>>>14&15,0);
    assert.ok(darkGeometry[i+13]&512);
  }
  const upIndex=(5*16+1)*16+2;
  new Uint8Array(core.memory.buffer,ptr,2048)[upIndex>>>1]=7;
  assert.equal(core.world_load_light(-1,-4,-2,ptr,0,2048),1);
  new Uint8Array(core.memory.buffer,ptr+2048,2048).fill(0x99);
  assert.equal(core.world_load_light(-1,-4,-2,0,ptr+2048,2048),1);
  const geometry=mesh(core,5);
  for(let i=0;i<geometry.length;i+=14) {
    if(geometry[i+4]===1) assert.equal(geometry[i+13]>>>10&15,7,'missing sky channel preserves prior data');
    assert.equal(geometry[i+13]>>>14&15,9);
  }
  const revision=core.world_revision();
  assert.equal(core.world_load_light(-1,-4,-2,0,ptr+2048,2048),1);
  assert.equal(core.world_revision(),revision,'duplicate light packet does not invalidate');
  assert.equal(core.world_load_light(-1,-4,-2,ptr-1,0,2048),0);
  assert.equal(core.world_load_light(-1,-4,-2,ptr,0,2047),0);
  assert.equal(core.world_set_skylight_default(0),1);
  assert.equal(core.world_set_skylight_default(16),0);
  assert.equal(core.world_unload_column(-1,-2),1);
  assert.equal(core.world_light_section_count(),0);
});

test('server End void can disable the floor while retaining actual terrain collision', async () => {
  const core=await importedWorld();
  assert.equal(core.world_reset(0,256,-1,-1,2,2),1);
  assert.equal(core.collides_aabb(0.1,-100,0.1,0.9,-98.2,0.9),1);
  assert.equal(core.world_set_floor_collision(0),1);
  assert.equal(core.collides_aabb(0.1,-100,0.1,0.9,-98.2,0.9),0);
  assert.equal(core.world_set_floor_collision(2),0);
  core.block_set(0,0,0,300);
  assert.equal(core.collides_aabb(0.1,-1,0.1,0.9,0.8,0.9),1);
});
