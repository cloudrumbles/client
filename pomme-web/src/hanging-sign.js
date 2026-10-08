import { bakeEntityCube } from './entity-models.js';
import { HANGING_SIGN_PARTS, HANGING_SIGN_ATTACHMENTS } from './hanging-sign-data.js';

const STRIDE = 14, cache = new Map();
/** Native AttachmentType.byBlockState, also matching 1.20.4 part visibility. */
export function hangingSignAttachment(name, properties = {}) {
  name = String(name).replace(/^minecraft:/, '');
  if (!/^.+_(?:wall_)?hanging_sign$/.test(name)) return null;
  return name.endsWith('_wall_hanging_sign') ? 'wall' : properties.attached === true || properties.attached === 'true' ? 'ceiling_middle' : 'ceiling';
}

/** Canonical native sign mesh before block-facing/rotation-segment transforms. */
export function hangingSignGeometry(attachment = 'ceiling') {
  if (!Object.hasOwn(HANGING_SIGN_ATTACHMENTS, attachment)) return null;
  if (cache.has(attachment)) return cache.get(attachment);
  const vertices = [], parts = [];
  for (const name of HANGING_SIGN_ATTACHMENTS[attachment]) {
    const part = HANGING_SIGN_PARTS[name], source = bakeEntityCube({ ...part, inflate: 0, mirror: false }, [64, 32]), firstVertex = vertices.length / STRIDE;
    const transform = (point, normal = false) => {
      // Undo the entity baker's native-Y reflection, apply its ModelPart pose,
      // then HangingSignRenderer's scale(1,-1,-1) and base height 0.625.
      const native = [point[0], -point[1], point[2]], c = Math.cos(part.yaw), s = Math.sin(part.yaw);
      const posed = [native[0] * c + native[2] * s, native[1], -native[0] * s + native[2] * c];
      if (!normal) for (let axis = 0; axis < 3; axis++) posed[axis] += part.offset[axis] / 16;
      return normal ? [posed[0], -posed[1], -posed[2]] : [.5 + posed[0], .625 - posed[1], .5 - posed[2]];
    };
    for (let triangle = 0; triangle < source.length; triangle += 24) for (const corners of [[0, 2, 1], [0, 1, 2]]) for (const corner of corners) {
      // Net Z reflection relative to the existing baker reverses winding.
      // Native entityCutoutNoCull draws each polygon from either side. Our
      // terrain pipeline culls backfaces, so retain a reverse-wound copy with
      // the same UVs and normal. The zero-depth V-chain's other native face
      // has transparent UVs; substituting that UV would erase the chain.
      const i = triangle + corner * 8, position = transform(source.subarray(i, i + 3)), normal = transform(source.subarray(i + 3, i + 6), true);
      vertices.push(...position, ...normal, 1, 1, 1, 1, source[i + 6], source[i + 7], 0, 0);
    }
    parts.push({ name, firstVertex, vertexCount: vertices.length / STRIDE - firstVertex });
  }
  const result = { vertices: new Float32Array(vertices), parts }; cache.set(attachment, result); return result;
}

export function hangingSignForm(name, properties = {}, tileByName) {
  const bare = String(name).replace(/^minecraft:/, ''), attachment = hangingSignAttachment(bare, properties);
  if (!attachment) return null;
  const wood = bare.replace(/_(?:wall_)?hanging_sign$/, ''), texture = `minecraft:entity/signs/hanging/${wood}`, tile = tileByName?.get(texture);
  if (tile === undefined) return null;
  const geometry = hangingSignGeometry(attachment), vertices = geometry.vertices.slice();
  for (let i = 12; i < vertices.length; i += STRIDE) vertices[i] = tile;
  const wall = attachment === 'wall';
  return { kind: 'hanging sign', x: 0, y: wall ? ({ south: 0, west: 90, north: 180, east: 270 }[properties.facing] ?? 180) : 0,
    freeY: wall ? 0 : Number(properties.rotation ?? 0) * 22.5, vertices, parts: geometry.parts,
    model: { namespace: 'minecraft', name: `browser_static/${bare}/${attachment}`, textures: { entity: texture }, elements: [], hasElements: true } };
}
