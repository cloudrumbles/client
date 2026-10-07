import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { copyMesh } from '../src/wasm.js';

const bytes = await readFile(new URL('../public/core.wasm', import.meta.url)).catch(error => {
  throw new Error('Build the real WASM artifact with npm run build before running tests.', { cause: error });
});
const wasmModule = await WebAssembly.compile(bytes);
const stride = 10;

async function world(seed = 1650) {
  const instance = await WebAssembly.instantiate(wasmModule, {});
  instance.exports.world_init(seed);
  return instance.exports;
}

function snapshot(core) {
  const width = core.world_width(), height = core.world_height(), depth = core.world_depth();
  const blocks = new Uint8Array(width * height * depth);
  let index = 0;
  for (let z = 0; z < depth; z++) {
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) blocks[index++] = core.block_get(x, y, z);
    }
  }
  return blocks;
}

function markAllClean(core) {
  for (let chunk = 0; chunk < core.world_chunk_count(); chunk++) core.mesh_clean(chunk);
}

function dirtyChunks(core) {
  return Array.from({ length: core.world_chunk_count() }, (_, index) => index)
    .filter(index => core.mesh_dirty(index));
}

function assertMesh(mesh) {
  assert.equal(mesh.length % (stride * 3), 0, 'complete triangle vertices');
  for (let i = 0; i < mesh.length; i += stride) {
    assert.ok(mesh.subarray(i, i + stride).every(Number.isFinite), 'finite vertex attributes');
    assert.ok(mesh[i + 9] >= 0.4799 && mesh[i + 9] <= 1, 'baked AO light factor');
    assert.equal(Math.abs(mesh[i + 3]) + Math.abs(mesh[i + 4]) + Math.abs(mesh[i + 5]), 1, 'cardinal unit normal');
  }
  for (let i = 0; i < mesh.length; i += stride * 3) {
    const u = [mesh[i + 10] - mesh[i], mesh[i + 11] - mesh[i + 1], mesh[i + 12] - mesh[i + 2]];
    const v = [mesh[i + 20] - mesh[i], mesh[i + 21] - mesh[i + 1], mesh[i + 22] - mesh[i + 2]];
    const cross = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
    const facing = cross[0] * mesh[i + 3] + cross[1] * mesh[i + 4] + cross[2] * mesh[i + 5];
    assert.ok(facing > 0, 'triangle winding faces outward and has nonzero area');
  }
}

test('built WASM runs without host imports and exports the browser ABI', async () => {
  assert.deepEqual(WebAssembly.Module.imports(wasmModule), []);
  const core = await world();
  assert.ok(core.memory instanceof WebAssembly.Memory);
  for (const name of ['block_get', 'block_set', 'block_solid', 'mesh_chunk', 'mesh_ptr', 'mesh_dirty',
    'mesh_clean', 'world_revision', 'chunk_revision', 'terrain_height', 'ray_cast', 'ray_hit_ptr', 'collides_aabb']) {
    assert.equal(typeof core[name], 'function', name);
  }
  assert.deepEqual([core.world_width(), core.world_height(), core.world_depth()], [128, 64, 128]);
  assert.equal(core.world_chunk_size(), 16);
  assert.equal(core.world_chunk_count(), 64);
});

test('actual WASM generation repeats exactly for one seed and differs across seeds', async () => {
  const first = await world(42), repeated = await world(42), different = await world(43);
  const firstBlocks = snapshot(first), repeatedBlocks = snapshot(repeated), differentBlocks = snapshot(different);
  assert.deepEqual(firstBlocks, repeatedBlocks);
  assert.notDeepEqual(firstBlocks, differentBlocks);
  for (const id of [1, 2, 3, 4, 5, 6, 7]) assert.ok(firstBlocks.includes(id), `generated block ID ${id}`);
  assert.equal(first.world_revision(), 1);
  assert.equal(first.mesh_dirty(0), 1);
});

test('invalid coordinates and IDs cannot modify world state', async () => {
  const core = await world();
  markAllClean(core);
  const initialRevision = core.world_revision();
  for (const point of [[-1, 2, 2], [2, -1, 2], [2, 2, -1], [128, 2, 2], [2, 64, 2], [2, 2, 128]]) {
    assert.equal(core.block_get(...point), 0);
    assert.equal(core.block_set(...point, 3), 0);
  }
  assert.equal(core.block_set(2, 60, 2, 9), 0);
  assert.equal(core.block_set(2, 60, 2, 0), 0, 'unchanged air is a no-op');
  assert.equal(core.terrain_height(-1, 2), 0);
  assert.equal(core.terrain_height(128, 2), 0);
  assert.equal(core.chunk_revision(64), 0);
  assert.equal(core.mesh_dirty(64), 0);
  core.mesh_clean(64);
  assert.equal(core.mesh_chunk(64, 0), 0);
  assert.equal(core.world_revision(), initialRevision);
  assert.deepEqual(dirtyChunks(core), []);
  assert.equal(core.block_solid(0), 0);
  assert.equal(core.block_solid(7), 0);
  assert.equal(core.block_solid(3), 1);
  assert.equal(core.block_solid(999), 0);
});

test('corner editing invalidates diagonal AO neighbours and only actual edits advance revisions', async () => {
  const core = await world();
  markAllClean(core);
  const initialRevision = core.world_revision();
  assert.equal(core.block_set(15, 60, 15, 3), 1);
  assert.deepEqual(dirtyChunks(core), [0, 1, 8, 9]);
  const editedRevision = core.world_revision();
  assert.equal(editedRevision, initialRevision + 1);
  for (const chunk of [0, 1, 8, 9]) assert.equal(core.chunk_revision(chunk), editedRevision);
  assert.equal(core.chunk_revision(2), initialRevision);
  assert.equal(core.block_set(15, 60, 15, 3), 0);
  assert.equal(core.world_revision(), editedRevision);
  copyMesh(core, 0, false);
  assert.equal(core.mesh_dirty(0), 1, 'meshing opaque alone does not declare water clean');
  copyMesh(core, 0, true);
  core.mesh_clean(0);
  assert.deepEqual(dirtyChunks(core), [1, 8, 9]);
  markAllClean(core);
  assert.equal(core.block_set(15, 60, 15, 0), 1);
  assert.equal(core.world_revision(), editedRevision + 1);
  assert.deepEqual(dirtyChunks(core), [0, 1, 8, 9]);
});

test('exported terrain and water mesh memory contains valid outward-facing geometry', async () => {
  const core = await world();
  let opaqueVertices = 0, waterVertices = 0, darkVertices = 0;
  for (let chunk = 0; chunk < core.world_chunk_count(); chunk++) {
    const opaque = copyMesh(core, chunk, false);
    const water = copyMesh(core, chunk, true);
    assertMesh(opaque);
    assertMesh(water);
    opaqueVertices += opaque.length / stride;
    waterVertices += water.length / stride;
    for (let i = 9; i < opaque.length; i += stride) if (opaque[i] < 0.99) darkVertices++;
    for (let i = 9; i < water.length; i += stride) assert.equal(water[i], 1, 'water has separate lighting');
  }
  assert.ok(opaqueVertices > 0);
  assert.ok(waterVertices > 0);
  assert.ok(darkVertices > 0, 'terrain AO is carried into the real ABI buffers');
});

test('voxel picking and AABB collision work through the exported WASM API', async () => {
  const core = await world();
  assert.equal(core.block_set(4, 60, 4, 3), 1);
  assert.equal(core.block_set(2, 60, 4, 7), 1);
  assert.equal(core.ray_cast(1.5, 60.5, 4.5, 2, 0, 0, 8), 1, 'direction is normalized and water skipped');
  const hit = Array.from(new Int32Array(core.memory.buffer, core.ray_hit_ptr(), 7));
  assert.deepEqual(hit, [4, 60, 4, 3, 60, 4, 3]);
  assert.equal(core.ray_cast(1.5, 60.5, 4.5, 1, 0, 0, 2), 0, 'reach is enforced');
  assert.equal(core.ray_cast(1.5, 60.5, 4.5, 0, 0, 0, 8), 0, 'zero direction is rejected');
  assert.equal(core.ray_cast(5.5, 60.5, 4.5, -1, 0, 0, 8), 1);
  assert.deepEqual(Array.from(new Int32Array(core.memory.buffer, core.ray_hit_ptr(), 7)), [4, 60, 4, 5, 60, 4, 3]);
  assert.equal(core.collides_aabb(4.1, 60.1, 4.1, 4.9, 60.9, 4.9), 1);
  assert.equal(core.collides_aabb(2.1, 60.1, 4.1, 2.9, 60.9, 4.9), 0, 'water is passable');
  assert.equal(core.collides_aabb(4.1, 61, 4.1, 4.9, 62.8, 4.9), 0, 'touching the top face is not penetration');
  assert.equal(core.collides_aabb(-0.1, 60, 4, 0.1, 61, 5), 1, 'world edge collides');
  assert.equal(core.collides_aabb(4, 65, 4, 5, 67, 5), 0, 'sky above build height stays open');
  assert.equal(core.terrain_height(4, 4), 61, 'ground edits update terrain height');
  core.block_set(4, 62, 4, 4);
  assert.equal(core.terrain_height(4, 4), 61, 'tree blocks are excluded from terrain height');
});

test('browser mesh copying survives memory growth and subsequent mesh-buffer reuse', async () => {
  const core = await world();
  const copied = copyMesh(core, 0, false);
  assert.ok(copied.length > 0);
  assert.notEqual(copied.buffer, core.memory.buffer, 'GPU upload data owns a copied buffer');
  const saved = copied.slice();
  const oldMemory = core.memory.buffer;
  const borrowed = new Float32Array(oldMemory, core.mesh_ptr(), copied.length);
  core.memory.grow(1);
  assert.equal(oldMemory.byteLength, 0, 'growth detaches the old WASM ArrayBuffer');
  assert.equal(borrowed.byteLength, 0);
  assert.deepEqual(copyMesh(core, 0, false), saved, 'helper refreshes its view from current memory');
  copyMesh(core, 1, false);
  copyMesh(core, 0, true);
  assert.deepEqual(copied, saved, 'reusing the Rust mesh buffer cannot overwrite copied upload data');
});
