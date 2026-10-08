import { quadGeometry } from './mesh-geometry.js';

const NORMAL = { east: [1, 0, 0], west: [-1, 0, 0], up: [0, 1, 0], down: [0, -1, 0], south: [0, 0, 1], north: [0, 0, -1] };
function corners(from, to, face) {
  const [x, y, z] = from, [X, Y, Z] = to;
  return ({ east: [[X, y, Z], [X, y, z], [X, Y, z], [X, Y, Z]], west: [[x, y, z], [x, y, Z], [x, Y, Z], [x, Y, z]], up: [[x, Y, Z], [X, Y, Z], [X, Y, z], [x, Y, z]], down: [[x, y, z], [X, y, z], [X, y, Z], [x, y, Z]], south: [[x, y, Z], [X, y, Z], [X, Y, Z], [x, Y, Z]], north: [[X, y, z], [x, y, z], [x, Y, z], [X, Y, z]] })[face];
}
function defaultUV(from, to, face) {
  const [x, y, z] = from, [X, Y, Z] = to;
  return ({ down: [x, 16 - Z, X, 16 - z], up: [x, z, X, Z], north: [16 - X, 16 - Y, 16 - x, 16 - y], south: [x, 16 - Y, X, 16 - y], west: [z, 16 - Y, Z, 16 - y], east: [16 - Z, 16 - Y, 16 - z, 16 - y] })[face];
}
function rotate(point, rotation) {
  if (!rotation) return point;
  const origin = rotation.origin || [8, 8, 8], axis = 'xyz'.indexOf(rotation.axis), a = (axis + 1) % 3, b = (axis + 2) % 3, radians = rotation.angle * Math.PI / 180, c = Math.cos(radians), s = Math.sin(radians);
  const result = point.map((value, index) => value - origin[index]), first = result[a]; result[a] = first * c - result[b] * s; result[b] = first * s + result[b] * c;
  if (rotation.rescale) { result[a] /= c; result[b] /= c; }
  return result.map((value, index) => value + origin[index]);
}

/** Bake the imported Java JSON element faces, including UV and element rotation. */
export function bakeModelElements(model, atlas) {
  if (!Array.isArray(model?.elements) || model.elements.length > 256) return [];
  const groups = new Map();
  for (const element of model.elements) {
    if (![...(element.from || []), ...(element.to || [])].every(value => Number.isFinite(value) && Math.abs(value) <= 256) || element.from?.length !== 3 || element.to?.length !== 3) continue;
    if (element.rotation && (!['x', 'y', 'z'].includes(element.rotation.axis) || ![-45, -22.5, 0, 22.5, 45].includes(element.rotation.angle))) continue;
    for (const [face, descriptor] of Object.entries(element.faces || {})) {
      if (!NORMAL[face]) continue;
      let texture = descriptor.texture || '', depth = 0;
      while (texture.startsWith('#') && depth++ < 24) texture = model.textures?.[texture.slice(1)] || '';
      if (!texture || texture.startsWith('#')) continue;
      const qualified = texture.includes(':') ? texture : `${model.namespace || 'minecraft'}:${texture}`;
      const tile = atlas?.tileByName?.get(qualified) ?? atlas?.itemTiles?.get(qualified);
      if (tile === undefined) continue;
      const positions = corners(element.from, element.to, face).map(point => rotate(point, element.rotation).map(value => value / 16 - .5));
      const ab = positions[1].map((value, axis) => value - positions[0][axis]), ac = positions[2].map((value, axis) => value - positions[0][axis]);
      let normal = [ab[1] * ac[2] - ab[2] * ac[1], ab[2] * ac[0] - ab[0] * ac[2], ab[0] * ac[1] - ab[1] * ac[0]], length = Math.hypot(...normal);
      if (length < 1e-12) continue; normal = normal.map(value => value / length);
      const rawUV = descriptor.uv || defaultUV(element.from, element.to, face), angle = descriptor.rotation || 0;
      if (!Array.isArray(rawUV) || rawUV.length !== 4 || !rawUV.every(Number.isFinite) || ![0, 90, 180, 270].includes(angle)) continue;
      const uv = [[rawUV[0], rawUV[3]], [rawUV[2], rawUV[3]], [rawUV[2], rawUV[1]], [rawUV[0], rawUV[1]]].map(point => point.map(value => value / 16));
      if (!groups.has(tile)) groups.set(tile, []);
      groups.get(tile).push(...quadGeometry(positions, uv.map((_, index) => uv[(index + angle / 90) % 4]), normal));
    }
  }
  return [...groups].map(([tile, vertices]) => ({ tile, vertices: new Float32Array(vertices), tint: [1, 1, 1], flags: 32 }));
}
