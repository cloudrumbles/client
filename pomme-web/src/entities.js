// Lightweight articulated models for entities received from a real server.
// Models use procedural colors until entity skins/textures are supplied. Block
// items can reuse the user's imported block atlas. No entities are synthesized.
const STRIDE = 14;
const EMPTY = new Float32Array(0);
const TAU = Math.PI * 2;
const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
const angleDelta = (a, b) => ((b - a + Math.PI) % TAU + TAU) % TAU - Math.PI;
const FACE_NORMALS = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
const FACES = [[4, 6, 7, 5], [1, 3, 2, 0], [2, 3, 7, 6], [1, 0, 4, 5], [5, 7, 3, 1], [0, 2, 6, 4]];
const TRIANGLES = [0, 1, 2, 0, 2, 3];
const UVS = [[0, 1], [0, 0], [1, 0], [1, 1]];
const TOP_UVS = [[0, 0], [0, 1], [1, 1], [1, 0]];
const SKIN_UV_CACHE = new Map();
const HUMANOIDS = /^(?:player|zombie|husk|drowned|skeleton|stray|wither_skeleton|villager|wandering_trader|witch|pillager|vindicator|evoker|illusioner|piglin|piglin_brute|zombified_piglin|armor_stand)$/;
const QUADRUPEDS = /^(?:pig|cow|mooshroom|sheep|wolf|cat|ocelot|fox|goat|horse|donkey|mule|llama|trader_llama|polar_bear|panda|hoglin|zoglin)$/;
const HIDDEN = new Set(['marker', 'interaction', 'area_effect_cloud']);
const PICK_SKIP = new Set([...HIDDEN, 'item', 'experience_orb', 'lightning_bolt']);
const SKINS = {
  player: ['player/wide/steve', 64], zombie: ['zombie/zombie', 64], husk: ['zombie/husk', 64], drowned: ['zombie/drowned', 64],
  skeleton: ['skeleton/skeleton', 32], stray: ['skeleton/stray', 32], wither_skeleton: ['skeleton/wither_skeleton', 32],
  creeper: ['creeper/creeper', 32], pig: ['pig/pig', 32], cow: ['cow/cow', 32], mooshroom: ['cow/red_mooshroom', 32], sheep: ['sheep/sheep', 32],
};
const DYE_RGB = [0xf9fffe, 0xf9801d, 0xc74ebd, 0x3ab3da, 0xfed83d, 0x80c71f, 0xf38baa, 0x474f52, 0x9d9d97, 0x169c9c, 0x8932b8, 0x3c44aa, 0x835432, 0x5e7c16, 0xb02e26, 0x1d1d21].map((hex) => [hex >> 16 & 255, hex >> 8 & 255, hex & 255].map((value) => value / 255));
const partSkin = (context, uv, size, options = {}) => context.skin ? { ...context.skin, uv, size, ...options } : null;

function skinRectangles(skin) {
  const key = [...skin.uv, ...skin.size, ...skin.sheet].join(',');
  if (SKIN_UV_CACHE.has(key)) return SKIN_UV_CACHE.get(key);
  const [u, v] = skin.uv, [w, h, d] = skin.size;
  const rectangles = [[u + d + w, v + d, u + 2 * d + w, v + d + h], [u, v + d, u + d, v + d + h], [u + d, v, u + d + w, v + d], [u + d + w, v, u + d + 2 * w, v + d], [u + d, v + d, u + d + w, v + d + h], [u + 2 * d + w, v + d, u + 2 * d + 2 * w, v + d + h]];
  const result = rectangles.map((rectangle) => rectangle.map((value, axis) => value / skin.sheet[axis % 2]));
  if (SKIN_UV_CACHE.size >= 256) SKIN_UV_CACHE.delete(SKIN_UV_CACHE.keys().next().value);
  SKIN_UV_CACHE.set(key, result);
  return result;
}

export function rayBoxDistance(eye, direction, min, max, maximum = Infinity) {
  let near = 0, far = maximum;
  for (let axis = 0; axis < 3; axis++) {
    if (Math.abs(direction[axis]) < 1e-10) { if (eye[axis] < min[axis] || eye[axis] > max[axis]) return null; continue; }
    let first = (min[axis] - eye[axis]) / direction[axis], second = (max[axis] - eye[axis]) / direction[axis];
    if (first > second) [first, second] = [second, first];
    near = Math.max(near, first); far = Math.min(far, second);
    if (near > far) return null;
  }
  return near;
}

function rotationMatrix([rx = 0, ry = 0, rz = 0]) {
  const cx = Math.cos(rx), sx = Math.sin(rx), cy = Math.cos(ry), sy = Math.sin(ry), cz = Math.cos(rz), sz = Math.sin(rz);
  return [cz * cy, cz * sy * sx - sz * cx, cz * sy * cx + sz * sx, sz * cy, sz * sy * sx + cz * cx, sz * sy * cx - cz * sx, -sy, cy * sx, cy * cx];
}
const transform = ([x, y, z], matrix) => [matrix[0] * x + matrix[1] * y + matrix[2] * z, matrix[3] * x + matrix[4] * y + matrix[5] * z, matrix[6] * x + matrix[7] * y + matrix[8] * z];

function meta(entity, definition, name, fallback = 0) {
  const index = definition?.metadataKeys?.indexOf(name);
  return index >= 0 ? entity.metadata?.find((item) => item.key === index)?.value ?? fallback : fallback;
}

class MeshWriter {
  constructor() { this.vertices = new Float32Array(65536); this.length = 0; this.reset(); }
  reset() { this.length = 0; this.min = [Infinity, Infinity, Infinity]; this.max = [-Infinity, -Infinity, -Infinity]; }
  reserve(count) {
    if (this.length + count <= this.vertices.length) return;
    const next = new Float32Array(Math.max(this.length + count, this.vertices.length * 2));
    next.set(this.vertices.subarray(0, this.length)); this.vertices = next;
  }
  box(center, size, color, context, { rotation = [0, 0, 0], pivot = center, tile = -1, skin = null } = {}) {
    this.reserve(36 * STRIDE);
    const partMatrix = rotationMatrix(rotation), worldMatrix = context.rotationMatrix ||= rotationMatrix(context.rotation);
    const rectangles = skin ? skinRectangles(skin) : null;
    const points = [0, 1].flatMap((x) => [0, 1].flatMap((y) => [0, 1].map((z) => {
      const local = [center[0] + (x - 0.5) * size[0], center[1] + (y - 0.5) * size[1], center[2] + (z - 0.5) * size[2]];
      const posed = transform(local.map((value, axis) => value - pivot[axis]), partMatrix).map((value, axis) => value + pivot[axis]);
      const oriented = transform(posed.map((value) => value * context.scale), worldMatrix);
      return oriented.map((value, axis) => value + context.position[axis]);
    })));
    for (let face = 0; face < 6; face++) {
      const normal = transform(transform(FACE_NORMALS[face], partMatrix), worldMatrix);
      const rectangle = rectangles?.[face];
      for (const corner of TRIANGLES) {
        const point = points[FACES[face][corner]];
        for (let axis = 0; axis < 3; axis++) { this.min[axis] = Math.min(this.min[axis], point[axis]); this.max[axis] = Math.max(this.max[axis], point[axis]); }
        const target = this.length, vertices = this.vertices;
        for (let axis = 0; axis < 3; axis++) {
          vertices[target + axis] = point[axis]; vertices[target + 3 + axis] = normal[axis];
          const tint = skin ? skin.tint?.[axis] ?? 1 : color[axis];
          vertices[target + 6 + axis] = context.hurt ? clamp(tint * (axis === 0 ? 1.4 : 0.65), 0, 1) : tint;
        }
        let [u, v] = UVS[corner];
        if (rectangle) {
          if (face === 2) [u, v] = TOP_UVS[corner];
          else u = 1 - u;
          if (skin.mirror) u = 1 - u;
          u = rectangle[0] + (rectangle[2] - rectangle[0]) * u;
          v = rectangle[1] + (rectangle[3] - rectangle[1]) * v;
        }
        vertices[target + 9] = 1; vertices[target + 10] = u; vertices[target + 11] = v; vertices[target + 12] = skin ? skin.tile : tile; vertices[target + 13] = skin ? 32 : 0;
        this.length += STRIDE;
      }
    }
  }
}

function humanoid(writer, context, definition, entity, swing) {
  const name = definition.name, skeletal = /skeleton|stray/.test(name), zombie = /zombie|husk|drowned/.test(name);
  const villager = /villager|trader|witch|illager|vindicator|evoker/.test(name);
  const skin = skeletal ? [0.76, 0.76, 0.69] : zombie ? [0.26, 0.45, 0.2] : villager ? [0.57, 0.39, 0.28] : [0.65, 0.43, 0.3];
  const shirt = skeletal ? skin : villager ? [0.39, 0.29, 0.2] : [0.13, 0.52, 0.56];
  const pants = skeletal ? skin : [0.2, 0.23, 0.45];
  const limb = skeletal ? 0.13 : 0.23;
  const headYaw = -angleDelta(entity.yaw || 0, entity.headYaw ?? entity.yaw ?? 0);
  const head = { rotation: [entity.pitch || 0, headYaw, 0], pivot: [0, 1.45, 0] };
  writer.box([0, 1.55, 0], [0.5, 0.5, 0.5], skin, context, { ...head, skin: partSkin(context, [0, 0], [8, 8, 8]) });
  writer.box([0, 0.99, 0], [skeletal && !context.skin ? 0.28 : 0.48, 0.7, 0.25], shirt, context, { skin: partSkin(context, [16, 16], [8, 12, 4]) });
  for (const side of [-1, 1]) {
    const phase = swing * side;
    const leftPlayer = side > 0 && name === 'player' && context.skin?.sheet[1] === 64;
    const legSkin = partSkin(context, leftPlayer ? [16, 48] : [0, 16], skeletal ? [2, 12, 2] : [4, 12, 4], { mirror: side > 0 && !leftPlayer });
    const armSkin = partSkin(context, leftPlayer ? [32, 48] : [40, 16], skeletal ? [2, 12, 2] : [4, 12, 4], { mirror: side > 0 && !leftPlayer });
    writer.box([side * 0.13, 0.325, 0], [limb, 0.65, limb], pants, context, { rotation: [phase, 0, 0], pivot: [side * 0.13, 0.65, 0], skin: legSkin });
    writer.box([side * 0.36, 1.0, 0], [limb, 0.65, limb], skin, context, { rotation: [zombie ? -Math.PI / 2 + phase * 0.2 : -phase, 0, 0], pivot: [side * 0.36, 1.325, 0], skin: armSkin });
    if (!context.skin) writer.box([side * 0.12, 1.61, 0.253], [skeletal ? 0.12 : 0.07, 0.055, 0.012], [0.035, 0.035, 0.04], context, head);
  }
  if (name === 'player' && context.skin && (meta(entity, definition, 'player_mode_customisation', 127) & 64)) writer.box([0, 1.55, 0], [0.56, 0.56, 0.56], [1, 1, 1], context, { ...head, skin: partSkin(context, [32, 0], [8, 8, 8]) });
  if (villager) writer.box([0, 1.47, 0.31], [0.11, 0.2, 0.16], skin, context, head);
  if (skeletal && !context.skin) for (const height of [0.83, 1.0, 1.17]) writer.box([0, height, 0.14], [0.34, 0.055, 0.06], skin, context);
}

function creeper(writer, context, swing) {
  const green = [0.25, 0.52, 0.16], dark = [0.045, 0.09, 0.025];
  writer.box([0, 1.4, 0], [0.5, 0.5, 0.5], green, context, { skin: partSkin(context, [0, 0], [8, 8, 8]) });
  writer.box([0, 0.85, 0], [0.45, 0.65, 0.3], green, context, { skin: partSkin(context, [16, 16], [8, 12, 4]) });
  for (const x of [-0.15, 0.15]) for (const z of [-0.17, 0.17]) writer.box([x, 0.23, z], [0.26, 0.46, 0.28], green, context, { rotation: [swing * Math.sign(x * z), 0, 0], pivot: [x, 0.45, z], skin: partSkin(context, [0, 16], [4, 6, 4]) });
  if (context.skin) return;
  for (const x of [-0.12, 0.12]) writer.box([x, 1.47, 0.255], [0.12, 0.09, 0.016], dark, context);
  writer.box([0, 1.32, 0.255], [0.09, 0.19, 0.016], dark, context);
  for (const x of [-0.065, 0.065]) writer.box([x, 1.26, 0.255], [0.07, 0.07, 0.016], dark, context);
}

function quadruped(writer, context, definition, entity, swing) {
  const name = definition.name, pig = /pig|hoglin/.test(name), sheep = name === 'sheep', cow = /cow|mooshroom/.test(name), wolf = /wolf|cat|fox|ocelot/.test(name);
  const color = pig ? [0.84, 0.49, 0.5] : sheep ? [0.88, 0.87, 0.79] : cow ? [0.28, 0.21, 0.16] : wolf ? [0.57, 0.57, 0.53] : [0.49, 0.32, 0.19];
  const height = cow || sheep ? 1.35 : pig ? 0.9 : 1;
  context = { ...context, scale: context.scale * (definition.height || height) / height };
  const leg = cow || sheep ? 0.5 : 0.35, bodyY = leg + 0.3;
  const bodySkin = partSkin(context, cow ? [18, 4] : [28, 8], cow ? [12, 18, 10] : sheep ? [8, 16, 6] : [10, 16, 8]);
  if (bodySkin) writer.box([0, bodyY, -0.05], cow ? [0.75, 1.125, 0.625] : sheep ? [0.5, 1, 0.375] : [0.625, 1, 0.5], color, context, { rotation: [Math.PI / 2, 0, 0], skin: bodySkin });
  else writer.box([0, bodyY, -0.05], [0.65, 0.55, 0.95], color, context);
  const head = { rotation: [entity.pitch || 0, -angleDelta(entity.yaw || 0, entity.headYaw ?? entity.yaw ?? 0), 0], pivot: [0, bodyY, 0.4] };
  writer.box([0, bodyY + 0.13, 0.58], [0.4, 0.45, 0.4], color, context, { ...head, skin: partSkin(context, [0, 0], cow ? [8, 8, 6] : sheep ? [6, 6, 8] : [8, 8, 8]) });
  if (pig || !context.skin) writer.box([0, bodyY + 0.06, 0.82], [pig ? 0.23 : 0.27, 0.16, 0.14], pig ? [0.66, 0.32, 0.35] : color, context, { ...head, skin: partSkin(context, [16, 16], [4, 3, 1]) });
  for (const x of [-0.22, 0.22]) for (const z of [-0.34, 0.3]) writer.box([x, leg / 2, z], [0.18, leg, 0.18], sheep ? [0.43, 0.32, 0.25] : color, context, { rotation: [swing * Math.sign(x * z), 0, 0], pivot: [x, leg, z], skin: partSkin(context, [0, 16], [4, pig ? 6 : 12, 4]) });
  for (const x of [-0.14, 0.14]) {
    if (!context.skin) writer.box([x, bodyY + 0.2, 0.785], [0.045, 0.06, 0.02], [0.035, 0.03, 0.025], context, head);
    if (cow || (!context.skin && (sheep || wolf))) writer.box([x * 1.5, bodyY + 0.42, 0.55], [0.08, cow ? 0.2 : 0.14, 0.11], cow ? [0.66, 0.62, 0.5] : color, context, { ...head, skin: partSkin(context, [22, 0], [1, 3, 1]) });
  }
  if (cow && !context.skin) for (const x of [-0.33, 0.33]) writer.box([x, bodyY + 0.06, -0.17], [0.018, 0.25, 0.3], [0.72, 0.7, 0.62], context);
  const wool = meta(entity, definition, 'wool', 0);
  if (sheep && context.fur !== undefined && !(wool & 16)) {
    const tint = DYE_RGB[wool & 15], fur = { ...context.skin, tile: context.fur, tint };
    writer.box([0, bodyY, -0.05], [0.63, 1.13, 0.5], tint, context, { rotation: [Math.PI / 2, 0, 0], skin: { ...fur, uv: [28, 8], size: [8, 16, 6] } });
    writer.box([0, bodyY + 0.13, 0.58], [0.44, 0.49, 0.44], tint, context, { ...head, skin: { ...fur, uv: [0, 0], size: [6, 6, 8] } });
  }
}

function spider(writer, context, swing) {
  const body = [0.19, 0.13, 0.1];
  writer.box([0, 0.52, -0.35], [0.6, 0.45, 0.65], body, context);
  writer.box([0, 0.45, 0.17], [0.4, 0.3, 0.5], body, context);
  writer.box([0, 0.48, 0.5], [0.42, 0.32, 0.3], body, context);
  for (const side of [-1, 1]) for (let leg = 0; leg < 4; leg++) {
    const z = (leg - 1.5) * 0.22;
    writer.box([side * 0.5, 0.3, z], [0.65, 0.065, 0.065], body, context, { rotation: [0, (leg - 1.5) * 0.25 + swing * 0.13, side * 0.25], pivot: [side * 0.2, 0.38, z] });
  }
  for (const x of [-0.12, 0.12]) writer.box([x, 0.53, 0.66], [0.07, 0.07, 0.018], [0.8, 0.03, 0.01], context);
}

function vehicle(writer, context, definition) {
  const boat = definition.name.includes('boat'), color = boat ? [0.52, 0.34, 0.19] : [0.42, 0.44, 0.45];
  const width = boat ? 1.3 : 0.98, length = boat ? 1.6 : 0.98;
  writer.box([0, 0.13, 0], [width, 0.16, length], color, context);
  for (const side of [-1, 1]) {
    writer.box([side * (width / 2 - 0.07), 0.36, 0], [0.14, 0.4, length], color, context);
    writer.box([0, 0.36, side * (length / 2 - 0.07)], [width, 0.4, 0.14], color, context);
  }
}

export class EntityScene {
  constructor({ renderer, registry = {}, materials = null, atlas = null, maxVisible = 96, maxTracked = 1024, maxDistance = 96, uploadHz = 30 } = {}) {
    if (!renderer || typeof renderer.uploadDynamicMesh !== 'function') throw new Error('EntityScene requires renderer.uploadDynamicMesh.');
    this.renderer = renderer;
    this.definitions = new Map((registry.entities || []).map((entity) => [entity.id, entity]));
    this.items = new Map((registry.items || []).map((item) => [item.id, item]));
    this.blocks = new Map((registry.blocks || []).map((block) => [block.name.replace(/^minecraft:/, ''), block]));
    this.materials = materials;
    this.atlas = atlas;
    this.maxVisible = clamp(Math.floor(maxVisible), 1, 256);
    this.maxTracked = clamp(Math.floor(maxTracked), this.maxVisible, 4096);
    this.maxDistance = clamp(maxDistance, 8, 256);
    this.uploadInterval = 1 / clamp(uploadHz, 10, 60);
    this.entities = new Map();
    this.players = new Map();
    this.writer = new MeshWriter();
    this.key = '__minecraft_entities';
    this.time = 0;
    this.lastUpload = -Infinity;
    this.eye = [0, 0, 0];
    this.meshOrigin = [0, 0, 0];
    this.cameraSignature = '';
    this.dirty = false;
    this.hasMesh = false;
    this.stats = { tracked: 0, visible: 0, vertices: 0, uploads: 0, proceduralModels: true, texturedModels: 0, fallbackModels: 0, dynamicShadows: Boolean(renderer.stats?.().dynamicShadows) };
  }

  setMaterials(materials) { this.materials = materials; this.dirty = true; }
  setAtlas(atlas) { this.atlas = atlas; this.dirty = true; }

  sample(track, time = this.time) {
    const fraction = clamp((time - track.start) / 0.075, 0, 1);
    const result = {};
    for (const axis of ['x', 'y', 'z']) result[axis] = track.from[axis] + (track.target[axis] - track.from[axis]) * fraction;
    for (const angle of ['yaw', 'pitch', 'headYaw']) result[angle] = track.from[angle] + angleDelta(track.from[angle], track.target[angle]) * fraction;
    return result;
  }

  consume(event) {
    if (!event) return;
    if (event.type === 'player-info') {
      this.players.set(event.player.uuid, event.player);
      while (this.players.size > this.maxTracked) this.players.delete(this.players.keys().next().value);
      return;
    }
    if (event.type === 'player-remove') { this.players.delete(event.uuid); return; }
    if (event.type === 'remove') { this.entities.delete(event.id); this.dirty = true; return; }
    if (event.type === 'status') {
      const track = this.entities.get(event.id);
      if (track && event.status === 2) { track.hurtUntil = this.time + 0.35; this.dirty = true; }
      return;
    }
    if (event.type !== 'spawn' && event.type !== 'update') return;
    const entity = event.entity;
    if (!entity || ![entity.x, entity.y, entity.z].every(Number.isFinite)) return;
    const target = { x: entity.x, y: entity.y, z: entity.z, yaw: entity.yaw || 0, pitch: entity.pitch || 0, headYaw: entity.headYaw ?? entity.yaw ?? 0 };
    let track = this.entities.get(entity.id);
    if (!track) {
      const definition = this.definitions.get(entity.entityType) || { id: entity.entityType, name: 'unknown', width: 0.6, height: 1 };
      track = { entity: { ...entity }, definition, target, from: { ...target }, start: this.time, lastPacket: this.time, speed: 0, phase: 0, lastRendered: target, hurtUntil: -Infinity };
      this.entities.set(entity.id, track);
    } else {
      track.entity = { ...track.entity, ...entity };
      if (['x', 'y', 'z', 'yaw', 'pitch', 'headYaw'].some((key) => target[key] !== track.target[key])) {
        const prior = this.sample(track);
        const distance = Math.hypot(target.x - track.target.x, target.z - track.target.z);
        const teleport = Math.hypot(target.x - track.target.x, target.y - track.target.y, target.z - track.target.z) > 8;
        track.speed = teleport ? 0 : Math.min(10, distance / Math.max(0.05, this.time - track.lastPacket));
        track.from = teleport ? { ...target } : prior;
        track.target = target; track.start = this.time; track.lastPacket = this.time;
      }
    }
    this.dirty = true;
    if (this.entities.size > this.maxTracked) {
      const farthest = [...this.entities].sort((a, b) => this.distance(b[1].target) - this.distance(a[1].target));
      for (let i = 0; i < farthest.length - this.maxTracked; i++) this.entities.delete(farthest[i][0]);
    }
    this.stats.tracked = this.entities.size;
  }

  distance(position) { return Math.hypot(position.x - this.eye[0], position.y - this.eye[1], position.z - this.eye[2]); }

  pick(eye, direction, maxDistance = 6) {
    const length = Math.hypot(...direction);
    if (!length || ![...eye, ...direction].every(Number.isFinite)) return null;
    direction = direction.map((value) => value / length);
    let closest = null;
    for (const [id, track] of this.entities) {
      if (PICK_SKIP.has(track.definition.name)) continue;
      const position = this.sample(track), scale = meta(track.entity, track.definition, 'baby', false) ? 0.5 : 1;
      const width = (track.definition.width || 0.6) * scale, height = (track.definition.height || 1) * scale;
      const min = [position.x - width / 2, position.y, position.z - width / 2], max = [position.x + width / 2, position.y + height, position.z + width / 2];
      const distance = rayBoxDistance(eye, direction, min, max, closest?.distance ?? maxDistance);
      if (distance === null) continue;
      const point = eye.map((value, axis) => value + direction[axis] * distance);
      closest = { entityId: id, distance, point, localPoint: point.map((value, axis) => value - [position.x, position.y, position.z][axis]) };
    }
    return closest;
  }

  visible(track, position, camera) {
    if (HIDDEN.has(track.definition.name) || (meta(track.entity, track.definition, 'shared_flags') & 32)) return false;
    const width = track.definition.width || 0.6, height = track.definition.height || 1;
    const delta = [position.x - this.eye[0], position.y + height / 2 - this.eye[1], position.z - this.eye[2]];
    const radius = Math.hypot(width, height) * 0.6;
    if (Math.hypot(...delta) - radius > this.maxDistance) return false;
    if (!camera.direction) return true;
    const length = Math.hypot(...camera.direction);
    if (!length) return true;
    const forward = camera.direction.map((value) => value / length);
    const rightLength = Math.hypot(forward[0], forward[2]);
    if (rightLength < 0.001) return true;
    const right = [-forward[2] / rightLength, 0, forward[0] / rightLength];
    const up = [right[1] * forward[2] - right[2] * forward[1], right[2] * forward[0] - right[0] * forward[2], right[0] * forward[1] - right[1] * forward[0]];
    const dot = (basis) => delta.reduce((sum, value, index) => sum + value * basis[index], 0);
    const depth = dot(forward), vertical = Math.tan((camera.fov || Math.PI * 75 / 180) / 2), horizontal = vertical * (camera.aspect || 16 / 9);
    return depth + radius > 0 && Math.abs(dot(right)) <= depth * horizontal + radius * Math.hypot(1, horizontal) && Math.abs(dot(up)) <= depth * vertical + radius * Math.hypot(1, vertical);
  }

  model(track, position, time) {
    const { definition, entity } = track;
    const name = definition.name;
    const baby = meta(entity, definition, 'baby', false);
    const pose = meta(entity, definition, 'pose');
    const context = { position: [position.x - this.meshOrigin[0], position.y - (pose === 5 ? 0.16 : 0), position.z - this.meshOrigin[2]], rotation: [0, -position.yaw, 0], scale: baby ? 0.5 : 1, hurt: time < track.hurtUntil };
    const skin = SKINS[name], tile = skin ? this.atlas?.entityTiles?.get(`minecraft:entity/${skin[0]}`) : undefined;
    if (tile !== undefined) {
      const rectangle = this.atlas.tiles?.[tile];
      const sheetHeight = name === 'player' && rectangle?.height * 2 === rectangle?.width ? 32 : skin[1];
      context.skin = { tile, sheet: [64, sheetHeight] };
      context.fur = this.atlas.entityTiles.get('minecraft:entity/sheep/sheep_fur');
      this.stats.texturedModels++;
    } else this.stats.fallbackModels++;
    if (HUMANOIDS.test(name)) context.scale *= (definition.height || 1.8) / 1.8;
    const travel = Math.hypot(position.x - track.lastRendered.x, position.z - track.lastRendered.z);
    track.phase += travel * 7;
    track.lastRendered = position;
    const speed = this.time - track.lastPacket > 0.25 ? 0 : track.speed;
    const swing = Math.sin(track.phase) * Math.min(0.7, speed * 0.15);
    const posed = { ...entity, yaw: position.yaw, pitch: position.pitch, headYaw: position.headYaw };
    if (HUMANOIDS.test(name)) humanoid(this.writer, context, definition, posed, swing);
    else if (name === 'creeper') creeper(this.writer, context, swing);
    else if (QUADRUPEDS.test(name)) quadruped(this.writer, context, definition, posed, swing);
    else if (name.includes('spider')) spider(this.writer, context, swing);
    else if (name.includes('boat') || name.includes('minecart')) vehicle(this.writer, context, definition);
    else if (name === 'item') {
      const item = meta(entity, definition, 'item', {}), itemDefinition = this.items.get(item.itemId);
      const block = this.blocks.get(itemDefinition?.name), material = block ? this.materials?.get(block.defaultState) : null;
      const tile = material?.faces?.up?.tile ?? material?.faces?.east?.tile ?? -1;
      const color = tile >= 0 ? [1, 1, 1] : [0.74, 0.65, 0.39];
      context.position[1] += 0.15 + Math.sin(time * 2 + entity.id * 0.47) * 0.045;
      context.rotation[1] = tile >= 0 ? time * 0.7 : Math.atan2(this.eye[0] - position.x, this.eye[2] - position.z);
      this.writer.box([0, 0, 0], tile >= 0 ? [0.24, 0.24, 0.24] : [0.24, 0.24, 0.025], color, context, { tile });
    } else if (name === 'bee') {
      this.writer.box([0, 0.3, 0], [0.55, 0.45, 0.65], [0.76, 0.56, 0.06], context);
      for (const z of [-0.17, 0.05]) this.writer.box([0, 0.3, z], [0.56, 0.46, 0.07], [0.15, 0.1, 0.04], context);
      for (const side of [-1, 1]) this.writer.box([side * 0.25, 0.59, 0], [0.35, 0.025, 0.4], [0.74, 0.82, 0.88], context, { rotation: [0, 0, side * Math.sin(time * 24) * 0.5], pivot: [side * 0.17, 0.58, 0] });
    } else {
      const size = name.includes('slime') || name === 'magma_cube' ? clamp(meta(entity, definition, 'size', 1), 1, 16) * 0.52 : null;
      this.writer.box([0, (size || definition.height || 0.8) / 2, 0], [size || definition.width || 0.6, size || definition.height || 0.8, size || definition.width || 0.6], size ? [0.34, 0.61, 0.26] : [0.49, 0.45, 0.39], context);
    }
  }

  update(time, eye, camera = {}) {
    this.stats.dynamicShadows = Boolean(this.renderer.stats?.().dynamicShadows);
    if (!Number.isFinite(time) || !eye || eye.length !== 3 || !Array.from(eye).every(Number.isFinite)) return this.stats;
    this.time = time; this.eye = Array.from(eye);
    if (time - this.lastUpload < this.uploadInterval) return this.stats;
    const cameraSignature = [...eye, ...(camera.direction || []), camera.fov || 0, camera.aspect || 0].map((value) => value.toFixed(2)).join(',');
    if (cameraSignature !== this.cameraSignature) this.dirty = true;
    this.cameraSignature = cameraSignature;
    const candidates = [];
    let animated = false;
    for (const track of this.entities.values()) {
      const position = this.sample(track, time);
      if (!this.visible(track, position, camera)) continue;
      candidates.push({ track, position, distance: this.distance(position) });
      if (time - track.start < 0.08 || (track.speed > 0 && time - track.lastPacket < 0.3) || time < track.hurtUntil + 0.05 || track.definition.name === 'item' || track.definition.name === 'bee') animated = true;
    }
    if (!this.dirty && !animated) return this.stats;
    candidates.sort((a, b) => a.distance - b.distance);
    const visible = candidates.slice(0, this.maxVisible);
    this.meshOrigin = [Math.floor(eye[0] / 256) * 256, 0, Math.floor(eye[2] / 256) * 256];
    this.writer.reset();
    this.stats.texturedModels = 0; this.stats.fallbackModels = 0;
    for (const { track, position } of visible) this.model(track, position, time);
    if (this.writer.length) {
      const worldBounds = { min: this.writer.min.map((value, axis) => value + this.meshOrigin[axis]), max: this.writer.max.map((value, axis) => value + this.meshOrigin[axis]) };
      this.renderer.uploadDynamicMesh(this.key, this.writer.vertices.subarray(0, this.writer.length), EMPTY, worldBounds, { stride: STRIDE, origin: [...this.meshOrigin] });
      this.hasMesh = true; this.stats.uploads++;
    } else if (this.hasMesh) { this.renderer.removeMesh(this.key); this.hasMesh = false; }
    this.lastUpload = time; this.dirty = false;
    Object.assign(this.stats, { tracked: this.entities.size, visible: visible.length, vertices: this.writer.length / STRIDE });
    this.stats.proceduralModels = this.stats.fallbackModels > 0;
    return this.stats;
  }

  clear() {
    this.entities.clear(); this.players.clear(); this.writer.reset();
    if (this.hasMesh) this.renderer.removeMesh(this.key);
    this.hasMesh = false; this.dirty = false; this.lastUpload = -Infinity;
    Object.assign(this.stats, { tracked: 0, visible: 0, vertices: 0, texturedModels: 0, fallbackModels: 0 });
  }
}
