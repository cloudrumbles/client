import { COPPER_STATUE_POSES } from './copper-statue-data.js';
import { bakeEntityCube } from './entity-models.js';

const geometry = new Map();
function rotate(point, [rx, ry, rz]) {
  let [x, y, z] = point;
  [y, z] = [y * Math.cos(rx) - z * Math.sin(rx), y * Math.sin(rx) + z * Math.cos(rx)];
  [x, z] = [x * Math.cos(ry) + z * Math.sin(ry), -x * Math.sin(ry) + z * Math.cos(ry)];
  return [x * Math.cos(rz) - y * Math.sin(rz), x * Math.sin(rz) + y * Math.cos(rz), z];
}

/** Native ModelPart hierarchy, before block-facing rotation, in block units. */
export function copperStatueGeometry(pose = 'standing') {
  if (!Object.hasOwn(COPPER_STATUE_POSES, pose)) return null;
  if (geometry.has(pose)) return geometry.get(pose);
  const definition = COPPER_STATUE_POSES[pose], vertices = [];
  const transform = (point, part, normal = false) => {
    while (part) {
      point = rotate(point, part.rotation);
      if (!normal) point = point.map((value, axis) => value + part.offset[axis] / 16);
      part = part.parent === null ? null : definition.parts[part.parent];
    }
    // CopperGolemStatueModel resets root.y, rotates Z by π, then uses the
    // opposite facing. South is the canonical block-facing orientation.
    return normal ? [point[0], -point[1], -point[2]] : [.5 + point[0], -point[1], .5 - point[2]];
  };
  for (const part of definition.parts) for (const cube of part.cubes) {
    const source = bakeEntityCube(cube, definition.sheet);
    for (let triangle = 0; triangle < source.length; triangle += 24) {
      // The existing entity baker flips native Y. Undo that before native
      // part transforms; reverse the final Z reflection's triangle winding.
      for (const corner of [0, 2, 1]) {
        const i = triangle + corner * 8;
        const position = transform([source[i], -source[i + 1], source[i + 2]], part);
        const normal = transform([source[i + 3], -source[i + 4], source[i + 5]], part, true);
        vertices.push(...position, ...normal, 1, 1, 1, 1, source[i + 6], source[i + 7], 0, 0);
      }
    }
  }
  const result = new Float32Array(vertices); geometry.set(pose, result); return result;
}

export function copperStatueForm(name, properties, tileByName) {
  const match = /^(?:waxed_)?(?:(exposed|weathered|oxidized)_)?copper_golem_statue$/.exec(name);
  if (!match) return null;
  const texture = `minecraft:entity/copper_golem/${match[1] ? `${match[1]}_` : ''}copper_golem`;
  const tile = tileByName.get(texture), pose = properties.copper_golem_pose ?? properties.pose ?? 'standing';
  const source = copperStatueGeometry(pose);
  if (tile === undefined || !source) return null;
  const vertices = source.slice(); for (let i = 12; i < vertices.length; i += 14) vertices[i] = tile;
  return { kind: 'copper statue', x: 0, y: ({ south: 0, west: 90, north: 180, east: 270 })[properties.facing] ?? 0, freeY: 0, vertices,
    model: { namespace: 'minecraft', name: `browser_static/${name}/${pose}`, textures: { entity: texture }, elements: [], hasElements: true } };
}
