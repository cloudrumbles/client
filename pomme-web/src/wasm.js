export async function loadCore(seed) {
  const response = await fetch('/public/core.wasm');
  if (!response.ok) throw new Error('The WASM world is missing. Run npm run build, then reload.');
  const { instance } = await WebAssembly.instantiateStreaming(response, {});
  const core = instance.exports;
  core.world_init(seed);
  return core;
}

export function copyMesh(core, index, water) {
  const count = core.mesh_chunk(index, water ? 1 : 0);
  return new Float32Array(core.memory.buffer, core.mesh_ptr(), count * 10).slice();
}
