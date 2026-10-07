import { loadCore, copyMesh } from './wasm.js';
let core;
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
    const x = (i % columns) * size;
    const z = Math.floor(i / columns) * size;
    core.mesh_clean(i);
    postMessage({ type: 'mesh', index: i, opaque, water, revision: core.world_revision(), bounds: { min: [x, 0, z], max: [x + size, core.world_height(), z + size] } }, [opaque.buffer, water.buffer]);
    // Yield between chunks so edits are not blocked by the entire initial build.
    if (performance.now() - started > 12) { schedule(); return; }
  }
  if (!ready) { ready = true; postMessage({ type: 'ready' }); }
};
function schedule() { if (!scheduled) { scheduled = true; setTimeout(pump, 0); } }
onmessage = async ({ data }) => {
  try {
    if (data.type === 'init') {
      core = await loadCore(data.seed);
      for (const [x, y, z, id] of data.edits ?? []) core.block_set(x, y, z, id);
      schedule();
    } else if (data.type === 'edit' && core) {
      core.block_set(...data.block);
      schedule();
    }
  } catch (error) { postMessage({ type: 'error', message: error.message }); }
};
