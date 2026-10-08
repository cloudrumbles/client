import { bakeModelElements } from './model-elements.js';
import { quadGeometry } from './mesh-geometry.js';

const IDENTITY = [1, 0, 0, 0, 1, 0, 0, 0, 1], CACHE = new WeakMap();
const multiply = (a, b) => Array.from({ length: 9 }, (_, index) => { const row = Math.floor(index / 3), column = index % 3; return a[row * 3] * b[column] + a[row * 3 + 1] * b[column + 3] + a[row * 3 + 2] * b[column + 6]; });
const transform = (point, m) => [0, 1, 2].map(axis => m[axis * 3] * point[0] + m[axis * 3 + 1] * point[1] + m[axis * 3 + 2] * point[2]);
const rotate = (axis, angle) => { const c = Math.cos(angle), s = Math.sin(angle); return axis === 'x' ? [1, 0, 0, 0, c, -s, 0, s, c] : axis === 'y' ? [c, 0, s, 0, 1, 0, -s, 0, c] : [c, -s, 0, s, c, 0, 0, 0, 1]; };
const DIRECTIONS = [[0, -1, 0], [0, 1, 0], [0, 0, -1], [0, 0, 1], [-1, 0, 0], [1, 0, 0]];
const metadata = (entity, definition, name, fallback) => entity.metadata?.find(entry => entry.key === definition.metadataKeys?.indexOf(name))?.value ?? fallback;

/** Source ItemFrameRenderer transforms, using the imported Java block model. */
export function drawItemFrame(writer, track, position, { atlas, library, maps, origin = [0, 0, 0] } = {}) {
  const { entity, definition } = track, slot = metadata(entity, definition, 'item', { present: false }), item = library.definition(slot), isMap = item?.name === 'filled_map', glow = definition.name === 'glow_item_frame';
  let direction = DIRECTIONS[entity.objectData];
  if (!direction) direction = Math.abs(Math.sin(position.pitch)) > .9 ? [0, Math.sin(position.pitch) < 0 ? 1 : -1, 0] : [Math.sin(position.yaw), 0, Math.cos(position.yaw)];
  const base = multiply(rotate('x', position.pitch), rotate('y', Math.PI - position.yaw));
  const context = { position: [position.x, position.y, position.z].map((value, axis) => value - origin[axis] + direction[axis] * .46875), rotationMatrix: base, rotation: [0, 0, 0], scale: 1, hurt: false };
  const invisible = Boolean(metadata(entity, definition, 'shared_flags', 0) & 32), resource = `minecraft:block/${glow ? 'glow_' : ''}item_frame${isMap ? '_map' : ''}`;
  let frame = [], importedModel = false;
  if (!invisible && atlas) {
    let cache = CACHE.get(atlas); if (!cache) { cache = new Map(); CACHE.set(atlas, cache); }
    if (!cache.has(resource)) cache.set(resource, bakeModelElements(library.resolve(resource), atlas));
    frame = cache.get(resource); importedModel = frame.length > 0;
    for (const part of frame) writer.triangles(part.vertices, context, { matrix: IDENTITY, position: [0, 0, 0], tile: part.tile, flags: part.flags });
  }
  if (!slot.present) return { importedModel, items: 0 };
  const rotation = metadata(entity, definition, 'rotation', 0), angle = (isMap ? rotation % 4 * 2 : rotation) * Math.PI / 4;
  const itemBase = rotate('z', angle), z = invisible ? .5 : .4375;
  if (isMap) {
    const map = maps?.tileForItem(slot, { frame: true });
    if (map) {
      const matrix = multiply(itemBase, rotate('z', Math.PI));
      const vertices = new Float32Array(quadGeometry([[-.5, .5, 0], [.5, .5, 0], [.5, -.5, 0], [-.5, -.5, 0]], [[0, 1], [1, 1], [1, 0], [0, 0]], [0, 0, -1]));
      writer.triangles(vertices, context, { matrix, position: [0, 0, z - 1 / 128], tile: map.tile, flags: 32 | (glow ? 8 : 0) });
      return { importedModel, items: 1, map: true };
    }
    return { importedModel, items: 0, map: true };
  }
  const mesh = library.get(slot), display = mesh.display.fixed || (mesh.block ? {} : { rotation: [0, 180, 0] }), angles = display.rotation || [0, 0, 0], translation = display.translation || [0, 0, 0], scale = display.scale || [1, 1, 1];
  const orientation = multiply(itemBase, multiply(multiply(rotate('x', angles[0] * Math.PI / 180), rotate('y', angles[1] * Math.PI / 180)), rotate('z', angles[2] * Math.PI / 180)));
  const matrix = orientation.map((value, index) => value * scale[index % 3] * .5), normalMatrix = orientation.map((value, index) => value / (scale[index % 3] * .5));
  const offset = transform(translation.map(value => value / 16 * .5), itemBase); offset[2] += z;
  for (const part of mesh.parts) writer.triangles(part.vertices, context, { matrix, normalMatrix, position: offset, tile: part.tile, tint: part.tint, flags: part.flags | (glow ? 8 : 0) });
  return { importedModel, items: Number(mesh.parts.length > 0), map: false };
}
