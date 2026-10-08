// These render-only flags stay multiples of 32, including packed light and
// reactivity. That preserves them exactly in the shared Float32 vertex ABI.
export const FULLBRIGHT = 16777216;
export const EYES_ADDITIVE = 33554432;
export const EYES_TRANSLUCENT = 67108864;
export const EMISSIVE_TRANSLUCENT = 134217728;
export const WIND_TRANSLUCENT = 268435456;
export const ACTOR_LAYERS = Object.freeze([
  { name: 'eyesAdditive', flag: EYES_ADDITIVE, additive: true, cull: 'back', depthWrite: false },
  { name: 'eyesTranslucent', flag: EYES_TRANSLUCENT, cull: 'back', depthWrite: false },
  { name: 'emissiveTranslucent', flag: EMISSIVE_TRANSLUCENT, cull: 'none', depthWrite: false },
  { name: 'windTranslucent', flag: WIND_TRANSLUCENT, cull: 'none', depthWrite: true },
]);

export function actorEyeFlags(version = '1.20.4') {
  // The original 1.20 eyes use ONE/ONE. The modern 1.21.11 entity
  // pipeline uses SRC_ALPHA/ONE_MINUS_SRC_ALPHA for this same layer.
  const minor = /^1\.(\d+)/.exec(version)?.[1];
  return 32 | FULLBRIGHT | (minor && Number(minor) <= 20 ? EYES_ADDITIVE : EYES_TRANSLUCENT);
}

export function partitionActorLayers(data, stride = 14) {
  const triangleFloats = stride * 3, counts = new Map([['base', 0], ...ACTOR_LAYERS.map(layer => [layer.name, 0])]);
  const kind = offset => {
    const flags = Math.round(data[offset + 13]);
    return ACTOR_LAYERS.find(layer => (flags & layer.flag) !== 0)?.name ?? 'base';
  };
  for (let offset = 0; offset < data.length; offset += triangleFloats) {
    const name = kind(offset); counts.set(name, counts.get(name) + triangleFloats);
  }
  const result = Object.fromEntries([...counts].map(([name, count]) => [name, count === data.length ? data : new Float32Array(count)]));
  if ([...counts.values()].includes(data.length)) return result;
  const cursors = new Map([...counts].map(([name]) => [name, 0]));
  for (let offset = 0; offset < data.length; offset += triangleFloats) {
    const name = kind(offset), cursor = cursors.get(name);
    result[name].set(data.subarray(offset, offset + triangleFloats), cursor); cursors.set(name, cursor + triangleFloats);
  }
  return result;
}

export function sortActorQuads(data, eye, origin = [0, 0, 0], stride = 14) {
  // Native entity layers sort whole four-corner faces. Each face is expanded
  // into two adjacent triangles by the model baker, so keep its six vertices
  // together rather than giving the halves different compositing positions.
  const faceFloats = stride * 6;
  if (data.length % faceFloats) throw new Error('Actor layers require paired face triangles.');
  if (data.length <= faceFloats) return data;
  const distances = new Float64Array(data.length / faceFloats), order = Array.from(distances.keys());
  for (let face = 0; face < distances.length; face++) {
    for (let axis = 0; axis < 3; axis++) {
      let center = 0; for (let vertex = 0; vertex < 6; vertex++) center += data[face * faceFloats + vertex * stride + axis];
      distances[face] += (center / 6 + origin[axis] - eye[axis]) ** 2;
    }
  }
  order.sort((a, b) => distances[b] - distances[a]);
  if (order.every((face, index) => face === index)) return data;
  const sorted = new Float32Array(data.length);
  for (let index = 0; index < order.length; index++) sorted.set(data.subarray(order[index] * faceFloats, (order[index] + 1) * faceFloats), index * faceFloats);
  return sorted;
}
