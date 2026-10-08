const STRIDE = 14, TRIANGLE_FLOATS = STRIDE * 3;
const REACTIVE = 2097152, FULLBRIGHT = 16777216, BLEND = 64, EMISSIVE = 8, SOLID = 1;

// Keep uncertain triangles. Only immutable flag branches in shadow.wgsl can
// prove a triangle never contributes; atlas alpha/emission may change later.
export function opaqueGeometryCastsShadow(vertices) {
  if (!vertices?.length) return false;
  if (!(vertices instanceof Float32Array) || vertices.length % TRIANGLE_FLOATS) return true;
  for (let triangle = 0; triangle < vertices.length; triangle += TRIANGLE_FLOATS) {
    for (let vertex = triangle; vertex < triangle + TRIANGLE_FLOATS; vertex += STRIDE) {
      const source = vertices[vertex + 13];
      if (!Number.isFinite(source) || source < 0 || source > 0xffffffff) return true;
      // Match the renderer's actual dynamic upload and Float32 ABI before
      // interpreting flags, including high packed native beam/layer bits.
      const admitted = Math.fround((Math.round(source) | REACTIVE) >>> 0);
      if (admitted > 0xffffffff) return true;
      const flags = admitted >>> 0;
      if (!(flags & FULLBRIGHT) && !(flags & BLEND) && (!(flags & EMISSIVE) || flags & SOLID)) return true;
    }
  }
  return false;
}
