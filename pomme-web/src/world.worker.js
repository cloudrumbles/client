import { loadCore, copyMesh } from './wasm.js';
import { applyMaterials, activateMaterials } from './registry.js';
let core;
let generation = 0;
let activated = new Set();
let scheduled = false;
let ready = false;
const pump = () => {
  scheduled = false;
  if (!core) return;
  const started = performance.now();
  for (let i = 0; i < core.world_chunk_count(); i++) {
    if (!core.mesh_dirty(i)) continue;
    const opaque = copyMesh(core, i, false);
    const water = copyMesh(core, i, true);
    const size = core.world_chunk_size();
    const columns = core.world_width() / size;
    const x = (core.world_origin_x?.() ?? 0) + (i % columns) * size;
    const z = (core.world_origin_z?.() ?? 0) + Math.floor(i / columns) * size;
    const minY = core.world_min_y?.() ?? 0;
    core.mesh_clean(i);
    postMessage({ type: 'mesh', generation, index: `${x / size},${z / size}`, opaque, water, origin: [core.world_origin_x(), 0, core.world_origin_z()], stride: core.mesh_vertex_stride(), revision: core.world_revision(), bounds: { min: [x, minY, z], max: [x + size, minY + core.world_height(), z + size] } }, [opaque.buffer, water.buffer]);
    // Yield between chunks so edits are not blocked by the entire initial build.
    if (performance.now() - started > 12) { schedule(); return; }
  }
  if (!ready) { ready = true; postMessage({ type: 'ready', generation }); }
};
function schedule() { if (!scheduled) { scheduled = true; setTimeout(pump, 0); } }
let pending = Promise.resolve();
onmessage = ({ data }) => { pending = pending.then(async () => {
  try {
    if (data.type === 'init') {
      generation = data.generation;
      core = await loadCore(data.seed);
      for (const [x, y, z, id] of data.edits ?? []) core.block_set(x, y, z, id);
      schedule();
    } else if (data.type === 'reset' && core) {
      generation = data.generation; ready = false; activated = new Set();
      if (!core.world_reset(data.minY, data.height, data.originX, data.originZ, data.width, data.depth)) throw new Error('Invalid dimension bounds');
      applyMaterials(core, data.materials);
      core.world_set_skylight_default?.(data.hasSkylight ? 15 : 0);
      core.world_set_floor_collision?.(data.floorCollision ? 1 : 0);
      schedule();
    } else if (data.generation !== generation) return;
    else if (data.type === 'definitions' && core) {
      const materials = new Map(data.materials.map(material => [material.id, material]));
      activateMaterials(core, materials, materials.keys(), activated);
    } else if (data.type === 'section' && core) {
      const pointer = core.world_stage_ptr();
      new Uint16Array(core.memory.buffer, pointer, 4096).set(data.blocks);
      if (!core.world_load_section(data.x, data.y, data.z, pointer, 4096)) throw new Error('Invalid section');
      schedule();
    } else if (data.type === 'light' && core && core.world_load_light) {
      const pointer = core.world_stage_ptr();
      if (data.sky) new Uint8Array(core.memory.buffer, pointer, 2048).set(data.sky);
      if (data.block) new Uint8Array(core.memory.buffer, pointer + 2048, 2048).set(data.block);
      if (!core.world_load_light(data.x, data.y, data.z, data.sky ? pointer : 0, data.block ? pointer + 2048 : 0, 2048)) throw new Error('Invalid lighting arrays');
      schedule();
    } else if (data.type === 'unload' && core) {
      core.world_unload_column(data.x, data.z); schedule();
    } else if (data.type === 'rebase' && core) {
      core.world_rebase(data.x, data.z); schedule();
    } else if (data.type === 'edit' && core) {
      core.block_set(...data.block);
      schedule();
    }
  } catch (error) { postMessage({ type: 'error', generation, message: error.message }); }
}); };
