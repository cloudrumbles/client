import { bakeEntityCube, bakedEntityModel } from './entity-models.js';

const SHIELD = [
  { origin: [-6, -11, -2], size: [12, 22, 1], uv: [0, 0], inflate: 0, mirror: false },
  { origin: [-1, -3, -1], size: [2, 6, 6], uv: [26, 0], inflate: 0, mirror: false },
];
const cache = new Map();
function itemVertices(source) {
  // BlockEntityWithoutLevelRenderer uses scale(1,-1,-1). Cuboid baking
  // already reverses Y; reverse Z and the reflected triangle winding here.
  const result = new Float32Array(source.length);
  for (let triangle = 0; triangle < source.length; triangle += 24) for (let corner = 0; corner < 3; corner++) {
    const from = triangle + (corner ? 3 - corner : 0) * 8, to = triangle + corner * 8;
    result.set(source.subarray(from, from + 8), to); result[to + 2] = -result[to + 2]; result[to + 5] = -result[to + 5];
  }
  return result;
}
export function builtinItemParts(name, atlas) {
  if (name !== 'shield' && name !== 'trident') return [];
  const resource = name === 'shield' ? 'minecraft:entity/shield_base_nopattern' : 'minecraft:entity/trident';
  const tile = atlas?.entityTiles?.get(resource) ?? atlas?.tileByName?.get(resource); if (tile === undefined) return [];
  if (!cache.has(name)) cache.set(name, (name === 'shield' ? SHIELD.map(cube => bakeEntityCube(cube, [64, 64])) : bakedEntityModel('trident').parts.flatMap(part => part.geometry)).map(itemVertices));
  return cache.get(name).map(vertices => ({ vertices, tile, flags: 32, tint: [1, 1, 1] }));
}
