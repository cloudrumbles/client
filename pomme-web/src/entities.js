import { drawEntityModel, hasNativeBabyTransform } from './entity-models.js';
import { defaultPlayerSkin, PlayerSkinCache } from './entity-skins.js';
import { arrowGeometry } from './entity-projectiles.js';
import { previewEntityData } from './entity-preview.js';
import { ItemMeshLibrary } from './item-geometry.js';
import { drawItemFrame } from './entity-frames.js';
import { advanceEntityAnimation } from './entity-animation-state.js';
import { drawDroppedItem, drawEquippedItem } from './entity-item-rendering.js';
import { entityLightFlags } from './entity-lighting.js';
import { prepareSpecialEntity, prepareDragon } from './entity-keyframes.js';
import { prepareModernEntity, resolveModernEntity } from './entity-modern-models.js';
import { consumeRemainingStatus, mannequinProfile, mannequinSkinPatch, prepareRemainingEntity, remainingEntityAnimated, resolveRemainingEntity } from './entity-remaining-models.js';
import { actorEyeFlags, FULLBRIGHT, EMISSIVE_TRANSLUCENT, WIND_TRANSLUCENT } from './actor-layers.js';
import { advanceBoatVisual, boatBubbleMatrix, nativeBoatUnderWater } from './entity-boat-state.js';

// Server entities use the native client's cuboid models and imported sheets.
const STRIDE = 14;
const LIGHT_MASK = 512 | (15 << 10) | (15 << 14);
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
const HUMANOIDS = /^(?:player|mannequin|giant|bogged|parched|zombie|husk|drowned|skeleton|stray|wither_skeleton|villager|wandering_trader|witch|pillager|vindicator|evoker|illusioner|piglin|piglin_brute|zombified_piglin|armor_stand)$/;
const QUADRUPEDS = /^(?:pig|cow|mooshroom|sheep|wolf|cat|ocelot|fox|goat|horse|donkey|mule|llama|trader_llama|polar_bear|panda|hoglin|zoglin)$/;
const HIDDEN = new Set(['marker', 'interaction', 'area_effect_cloud']);
const INVISIBLE_LAYERS = new Set(['spider', 'cave_spider', 'enderman', 'ender_dragon', 'breeze', 'happy_ghast', 'nautilus', 'zombie_nautilus', 'camel', 'camel_husk', 'phantom', 'creaking', 'copper_golem']);
const PICK_SKIP = new Set([...HIDDEN, 'item', 'experience_orb', 'lightning_bolt']);
const SKINS = {
  player: ['player/wide/steve', 64], zombie: ['zombie/zombie', 64], husk: ['zombie/husk', 64], drowned: ['zombie/drowned', 64],
  skeleton: ['skeleton/skeleton', 32], stray: ['skeleton/stray', 32], wither_skeleton: ['skeleton/wither_skeleton', 32],
  creeper: ['creeper/creeper', 32], pig: ['pig/pig', 32], cow: ['cow/cow', 32], mooshroom: ['cow/red_mooshroom', 32], sheep: ['sheep/sheep', 32],
};
const DYE_RGB = [0xf9fffe, 0xf9801d, 0xc74ebd, 0x3ab3da, 0xfed83d, 0x80c71f, 0xf38baa, 0x474f52, 0x9d9d97, 0x169c9c, 0x8932b8, 0x3c44aa, 0x835432, 0x5e7c16, 0xb02e26, 0x1d1d21].map((hex) => [hex >> 16 & 255, hex >> 8 & 255, hex & 255].map((value) => value / 255));
const partSkin = (context, uv, size, options = {}) => context.skin ? { ...context.skin, uv, size, ...options } : null;
const NATIVE_MODELS = {
  player: 'player', zombie: 'zombie', husk: 'husk', drowned: 'drowned', zombie_villager: 'zombie_villager',
  skeleton: 'skeleton', stray: 'skeleton', wither_skeleton: 'skeleton', creeper: 'creeper', spider: 'spider', cave_spider: 'spider',
  pig: 'pig', cow: 'cow', mooshroom: 'cow', chicken: 'chicken', sheep: 'sheep', wolf: 'wolf', cat: 'cat', ocelot: 'ocelot', rabbit: 'rabbit',
  horse: 'horse', skeleton_horse: 'skeleton_horse', zombie_horse: 'skeleton_horse', donkey: 'donkey', mule: 'mule',
  squid: 'squid', glow_squid: 'squid', bat: 'bat', cod: 'cod', salmon: 'salmon', tropical_fish: 'tropical_fish', pufferfish: 'pufferfish_0',
  iron_golem: 'iron_golem', enderman: 'enderman', slime: 'slime', villager: 'villager', wandering_trader: 'villager', witch: 'witch',
  boat: 'boat', chest_boat: 'chest_boat', minecart: 'minecart', chest_minecart: 'minecart', furnace_minecart: 'minecart', hopper_minecart: 'minecart', tnt_minecart: 'minecart', spawner_minecart: 'minecart', command_block_minecart: 'minecart', trident: 'trident',
  fox: 'fox', strider: 'strider', dolphin: 'dolphin', bee: 'bee', frog: 'frog', turtle: 'turtle', llama: 'llama', trader_llama: 'llama', goat: 'goat', pillager: 'illager', vindicator: 'illager', evoker: 'illager', illusioner: 'illager', axolotl: 'axolotl', vex: 'vex', evoker_fangs: 'evoker_fangs', hoglin: 'hoglin', zoglin: 'hoglin', allay: 'allay', shulker: 'shulker', snow_golem: 'snow_golem',
  panda: 'panda', polar_bear: 'polar_bear',
  ghast: 'ghast', blaze: 'blaze', guardian: 'guardian', elder_guardian: 'guardian', endermite: 'endermite', silverfish: 'silverfish', magma_cube: 'magma_cube', wither: 'wither',
  piglin: 'piglin', piglin_brute: 'piglin', zombified_piglin: 'piglin', armor_stand: 'armor_stand',
  camel: 'camel', ravager: 'ravager', sniffer: 'sniffer', breeze: 'breeze', ender_dragon: 'ender_dragon',
};
const CAT_VARIANTS = ['tabby', 'black', 'red', 'siamese', 'british_shorthair', 'calico', 'persian', 'ragdoll', 'white', 'jellie', 'all_black'];
const HORSE_VARIANTS = ['white', 'creamy', 'chestnut', 'brown', 'black', 'gray', 'darkbrown'];
const RABBIT_VARIANTS = ['brown', 'white', 'black', 'white_splotched', 'gold', 'salt'];
const BOAT_VARIANTS = ['oak', 'spruce', 'birch', 'jungle', 'acacia', 'dark_oak', 'mangrove', 'bamboo', 'cherry'];
const VILLAGER_TYPES = ['desert', 'jungle', 'plains', 'savanna', 'snow', 'swamp', 'taiga'];
const VILLAGER_PROFESSIONS = ['none', 'armorer', 'butcher', 'cartographer', 'cleric', 'farmer', 'fisherman', 'fletcher', 'leatherworker', 'librarian', 'mason', 'nitwit', 'shepherd', 'toolsmith', 'weaponsmith'];
const VILLAGER_LEVELS = ['stone', 'iron', 'gold', 'emerald', 'diamond'];
const HORSE_MARKINGS = [null, 'white', 'whitefield', 'whitedots', 'blackdots'];
Object.assign(SKINS, {
  spider: ['spider/spider', 32], cave_spider: ['spider/cave_spider', 32], chicken: ['chicken', 32], wolf: ['wolf/wolf', 32], cat: ['cat/tabby', 32],
  ocelot: ['cat/ocelot', 32], rabbit: ['rabbit/brown', 32], horse: ['horse/horse_white', 64], donkey: ['horse/donkey', 64], mule: ['horse/mule', 64],
  skeleton_horse: ['horse/horse_skeleton', 64], zombie_horse: ['horse/horse_zombie', 64], squid: ['squid/squid', 32], glow_squid: ['squid/glow_squid', 32],
  bat: ['bat', 64], cod: ['fish/cod', 32], salmon: ['fish/salmon', 32], tropical_fish: ['fish/tropical_a', 32], pufferfish: ['fish/pufferfish', 32],
  iron_golem: ['iron_golem/iron_golem', 128], enderman: ['enderman/enderman', 32], slime: ['slime/slime', 32],
  villager: ['villager/villager', 64], wandering_trader: ['wandering_trader', 64], witch: ['witch', 128], zombie_villager: ['zombie_villager/zombie_villager', 64],
  boat: ['boat/oak', 64], chest_boat: ['chest_boat/oak', 128], minecart: ['minecart', 32], chest_minecart: ['minecart', 32], furnace_minecart: ['minecart', 32], hopper_minecart: ['minecart', 32], tnt_minecart: ['minecart', 32], spawner_minecart: ['minecart', 32], command_block_minecart: ['minecart', 32], trident: ['trident', 32],
  arrow: ['projectiles/arrow', 32], spectral_arrow: ['projectiles/spectral_arrow', 32],
  fox: ['fox/fox', 32], strider: ['strider/strider', 128], dolphin: ['dolphin', 64], bee: ['bee/bee', 64], frog: ['frog/temperate_frog', 32], turtle: ['turtle/big_sea_turtle', 64], llama: ['llama/creamy', 64], trader_llama: ['llama/creamy', 64], goat: ['goat/goat', 128],
  pillager: ['illager/pillager', 64], vindicator: ['illager/vindicator', 64], evoker: ['illager/evoker', 64], illusioner: ['illager/illusioner', 64], axolotl: ['axolotl/axolotl_lucy', 64], vex: ['illager/vex', 64], evoker_fangs: ['illager/evoker_fangs', 32], hoglin: ['hoglin/hoglin', 64], zoglin: ['hoglin/zoglin', 64], allay: ['allay/allay', 32], shulker: ['shulker/shulker', 64], snow_golem: ['snow_golem', 64],
  panda: ['panda/panda', 64], polar_bear: ['bear/polarbear', 64],
  ghast: ['ghast/ghast', 32], blaze: ['blaze', 32], guardian: ['guardian', 64], elder_guardian: ['guardian_elder', 64], endermite: ['endermite', 32], silverfish: ['silverfish', 32], magma_cube: ['slime/magmacube', 32], wither: ['wither/wither', 64],
  piglin: ['piglin/piglin', 64], piglin_brute: ['piglin/piglin_brute', 64], zombified_piglin: ['piglin/zombified_piglin', 64], armor_stand: ['armorstand/wood', 64],
  camel: ['camel/camel', 128], ravager: ['illager/ravager', 128], sniffer: ['sniffer/sniffer', 192], breeze: ['breeze/breeze', 32], ender_dragon: ['enderdragon/dragon', 256],
});

function skinRectangles(skin) {
  if (skin.rectangles) return skin.rectangles;
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
const combineMatrix = (a, b) => Array.from({ length: 9 }, (_, index) => { const row = Math.floor(index / 3), column = index % 3; return a[row * 3] * b[column] + a[row * 3 + 1] * b[column + 3] + a[row * 3 + 2] * b[column + 6]; });
const IDENTITY = [1, 0, 0, 0, 1, 0, 0, 0, 1];

function meta(entity, definition, name, fallback = 0) {
  const index = definition?.metadataKeys?.indexOf(name);
  return index >= 0 ? entity.metadata?.find((item) => item.key === index)?.value ?? fallback : fallback;
}

export class MeshWriter {
  constructor() { this.vertices = new Float32Array(65536); this.length = 0; this.reset(); }
  reset() { this.length = 0; this.min = [Infinity, Infinity, Infinity]; this.max = [-Infinity, -Infinity, -Infinity]; }
  reserve(count) {
    if (this.length + count <= this.vertices.length) return;
    const next = new Float32Array(Math.max(this.length + count, this.vertices.length * 2));
    next.set(this.vertices.subarray(0, this.length)); this.vertices = next;
  }
  triangles(source, context, { matrix, position, normalMatrix, tile = -1, tint = [1, 1, 1], flags = 32, inflation = 0, reversed = false, uvOffset = [0, 0], alpha = 1 }) {
    this.reserve(source.length / 8 * STRIDE);
    const worldMatrix = context.rotationMatrix ||= rotationMatrix(context.rotation);
    const combined = new Float64Array(9);
    for (let row = 0; row < 3; row++) for (let column = 0; column < 3; column++) combined[row * 3 + column] = worldMatrix[row * 3] * matrix[column] + worldMatrix[row * 3 + 1] * matrix[column + 3] + worldMatrix[row * 3 + 2] * matrix[column + 6];
    const offset = transform(position, worldMatrix).map((value, axis) => value * context.scale + context.position[axis]);
    const normals = context.normalMatrix || normalMatrix ? combineMatrix(context.normalMatrix || worldMatrix, normalMatrix || matrix) : combined;
    const exactNormals = Boolean(context.normalMatrix || normalMatrix);
    const inverseNormalScale = exactNormals ? 1 : 1 / Math.hypot(combined[0], combined[3], combined[6]);
    const vertices = this.vertices, min = this.min, max = this.max;
    for (let triangle = 0; triangle < source.length; triangle += 24) for (let corner = 0; corner < 3; corner++) {
      const index = triangle + (reversed && corner ? 3 - corner : corner) * 8;
      const nx = source[index + 3], ny = source[index + 4], nz = source[index + 5];
      const x = source[index] + nx * inflation, y = source[index + 1] + ny * inflation, z = source[index + 2] + nz * inflation;
      const target = this.length;
      const normalX = normals[0] * nx + normals[1] * ny + normals[2] * nz, normalY = normals[3] * nx + normals[4] * ny + normals[5] * nz, normalZ = normals[6] * nx + normals[7] * ny + normals[8] * nz;
      const normalScale = exactNormals ? 1 / Math.hypot(normalX, normalY, normalZ) : inverseNormalScale;
      for (let axis = 0; axis < 3; axis++) {
        const a = combined[axis * 3], b = combined[axis * 3 + 1], c = combined[axis * 3 + 2], point = (a * x + b * y + c * z) * context.scale + offset[axis];
        min[axis] = Math.min(min[axis], point); max[axis] = Math.max(max[axis], point);
        vertices[target + axis] = point; vertices[target + 3 + axis] = (axis === 0 ? normalX : axis === 1 ? normalY : normalZ) * normalScale;
        vertices[target + 6 + axis] = context.hurt ? clamp(tint[axis] * (axis === 0 ? 1.4 : 0.65), 0, 1) : tint[axis];
      }
      vertices[target + 9] = clamp(alpha, 0, 1); vertices[target + 10] = source[index + 6] + uvOffset[0]; vertices[target + 11] = source[index + 7] + uvOffset[1];
      vertices[target + 12] = tile; vertices[target + 13] = flags;
      this.length += STRIDE;
    }
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

function slotNBT(value, depth = 0) {
  if (depth > 16 || value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.map(item => slotNBT(item, depth + 1));
  if (typeof value !== 'object') return value;
  if ('type' in value && 'value' in value) return slotNBT(value.value, depth + 1);
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, slotNBT(item, depth + 1)]));
}
function leatherTint(item) {
  const component = item.components?.find(entry => ['dyed_color', 'minecraft:dyed_color'].includes(entry.type))?.data;
  const value = slotNBT(item.nbtData)?.display?.color ?? (typeof component === 'number' ? component : component?.rgb ?? component?.color);
  const color = Number.isInteger(value) ? value : 0xa06540;
  return [color >> 16 & 255, color >> 8 & 255, color & 255].map(channel => channel / 255);
}

export class EntityScene {
  constructor({ renderer, registry = {}, registries = new Map(), materials = null, atlas = null, maps = null, getLight = null, maxVisible = 96, maxTracked = 1024, maxDistance = 96, uploadHz = 30, fetchSkin } = {}) {
    if (!renderer || typeof renderer.uploadDynamicMesh !== 'function') throw new Error('EntityScene requires renderer.uploadDynamicMesh.');
    this.renderer = renderer;
    this.registries = registries;
    this.getLight = getLight;
    this.definitions = new Map((registry.entities || []).map((entity) => [entity.id, entity]));
    this.items = new Map((registry.items || []).map((item) => [item.id, item]));
    this.blocks = new Map((registry.blocks || []).map((block) => [block.name.replace(/^minecraft:/, ''), block]));
    this.materials = materials;
    this.minecraftVersion = registry.version?.minecraftVersion ?? registry.minecraftVersion ?? (typeof registry.version === 'string' ? registry.version : '1.20.4');
    this.atlas = atlas;
    this.maps = maps; this.itemLibrary = new ItemMeshLibrary({ registry, materials, atlas });
    this.maxVisible = clamp(Math.floor(maxVisible), 1, 256);
    this.maxTracked = clamp(Math.floor(maxTracked), this.maxVisible, 4096);
    this.maxDistance = clamp(maxDistance, 8, 256);
    this.uploadInterval = 1 / clamp(uploadHz, 10, 60);
    this.entities = new Map();
    this.vehicles = new Map();
    this.players = new Map();
    this.itemTags = new Map();
    this.writer = new MeshWriter();
    this.waterMaskWriter = new MeshWriter();
    this.key = '__minecraft_entities';
    this.waterMaskKey = '__minecraft_boat_water_mask';
    this.time = 0;
    this.lastUpload = -Infinity;
    this.eye = [0, 0, 0];
    this.meshOrigin = [0, 0, 0];
    this.cameraSignature = '';
    this.localEntityId = null;
    this.dirty = false;
    this.hasMesh = false;
    this.skinCache = new PlayerSkinCache({ appendTile: renderer.appendAtlasTile?.bind(renderer), fetchSkin, onReady: () => { this.dirty = true; } });
    this.stats = { tracked: 0, visible: 0, vertices: 0, uploads: 0, proceduralModels: true, texturedModels: 0, fallbackModels: 0, nativeModels: 0, approximateModels: 0, accountSkins: 0, equipmentParts: 0, dynamicShadows: Boolean(renderer.stats?.().dynamicShadows) };
  }

  setMaterials(materials) { this.materials = materials; this.itemLibrary.setAssets(this.atlas, materials); this.dirty = true; }
  setAtlas(atlas) { this.atlas = atlas; this.itemLibrary.setAssets(atlas, this.materials); this.skinCache.clear(); this.dirty = true; }
  setMaps(maps) { this.maps = maps; this.dirty = true; }

  sample(track, time = this.time) {
    const fraction = clamp((time - track.start) / 0.075, 0, 1);
    const result = {};
    for (const axis of ['x', 'y', 'z']) result[axis] = track.from[axis] + (track.target[axis] - track.from[axis]) * fraction;
    for (const angle of ['yaw', 'pitch', 'headYaw']) result[angle] = track.from[angle] + angleDelta(track.from[angle], track.target[angle]) * fraction;
    return result;
  }

  consume(event) {
    if (!event) return;
    if (event.type === 'record') {
      const point = Array.isArray(event.position) ? event.position : [event.position?.x, event.position?.y, event.position?.z];
      if (!point.every(Number.isInteger) || point.some(value => Math.abs(value) > 2147483647)) return;
      // LevelEventHandler notifies living AABBs intersecting the unit jukebox
      // cube inflated by three. Parrot.aiStep then applies its tighter radius.
      for (const track of this.entities.values()) {
        if (track.definition.name !== 'parrot') continue;
        const position = this.sample(track), half = (track.definition.width || .5) / 2, height = track.definition.height || .9;
        if (!(position.x + half > point[0] - 3 && position.x - half < point[0] + 4
          && position.y + height > point[1] - 3 && position.y < point[1] + 4
          && position.z + half > point[2] - 3 && position.z - half < point[2] + 4)) continue;
        track.partyJukebox = [...point]; track.entity.partyParrot = Boolean(event.playing); this.dirty = true;
      }
      return;
    }
    if (event.type === 'registry') {
      if (event.id && Array.isArray(event.entries)) this.registries.set(event.id, event.entries);
      for (const [id, registry] of Object.entries(event.codec || {})) {
        const entries = registry?.value || registry?.entries;
        if (Array.isArray(entries)) this.registries.set(id, entries);
      }
      this.dirty = true; return;
    }
    if (event.type === 'tags') {
      const items = event.tags?.find(entry => entry.tagType === 'minecraft:item');
      if (items) this.itemTags = new Map(items.tags.map(tag => [tag.tagName, new Set(tag.entries)]));
      this.dirty = true; return;
    }
    if (event.type === 'player-info') {
      this.players.set(event.player.uuid, event.player);
      this.skinCache.request(event.player); this.dirty = true;
      while (this.players.size > this.maxTracked) this.players.delete(this.players.keys().next().value);
      return;
    }
    if (event.type === 'player-remove') { this.players.delete(event.uuid); this.dirty = true; return; }
    if (event.type === 'remove') {
      this.entities.delete(event.id); this.vehicles.delete(event.id);
      for (const [id, vehicle] of this.vehicles) if (vehicle === event.id) { this.vehicles.delete(id); const passenger = this.entities.get(id); if (passenger) passenger.entity.vehicleId = null; }
      this.dirty = true; return;
    }
    if (event.type === 'collect') {
      const track = this.entities.get(event.id);
      if (track?.definition.name === 'item') {
        const key = track.definition.metadataKeys?.indexOf('item'), entry = track.entity.metadata?.find(value => value.key === key), count = Math.max(0, Number(event.count) || 0);
        if (entry?.value?.present && count < entry.value.itemCount) track.entity.metadata = track.entity.metadata.map(value => value === entry ? { ...entry, value: { ...entry.value, itemCount: entry.value.itemCount - count } } : value);
        else this.entities.delete(event.id);
      } else if (track && ['arrow', 'spectral_arrow', 'trident'].includes(track.definition.name)) this.entities.delete(event.id);
      this.dirty = true; return;
    }
    if (event.type === 'status') {
      const track = this.entities.get(event.id);
      if (track) consumeRemainingStatus(track, event.status, this.time);
      if (track && event.status === 2) { track.hurtUntil = this.time + 0.35; this.dirty = true; }
      if (track && event.status === 3) { track.deathAt = this.time; this.dirty = true; }
      if (track && event.status === 4) { track.attackAt = this.time; this.dirty = true; }
      if (track && event.status === 39 && track.definition.name === 'ravager') { track.stunnedAt = this.time; this.dirty = true; }
      return;
    }
    if (event.type === 'animation') {
      const track = this.entities.get(event.id);
      if (track && [0, 3].includes(event.animation)) { track.attackAt = this.time; track.attackOffhand = event.animation === 3; this.dirty = true; }
      return;
    }
    if (event.type !== 'spawn' && event.type !== 'update') return;
    const entity = event.entity;
    if (!entity || ![entity.x, entity.y, entity.z].every(Number.isFinite)) return;
    if (Array.isArray(entity.passengers)) {
      const passengers = new Set(entity.passengers.slice(0, this.maxTracked).filter(Number.isInteger));
      for (const [id, vehicle] of this.vehicles) if (vehicle === entity.id && !passengers.has(id)) { this.vehicles.delete(id); const prior = this.entities.get(id); if (prior) prior.entity.vehicleId = null; }
      for (const id of passengers) { this.vehicles.set(id, entity.id); const passenger = this.entities.get(id); if (passenger) passenger.entity.vehicleId = entity.id; }
      while (this.vehicles.size > this.maxTracked) this.vehicles.delete(this.vehicles.keys().next().value);
    }
    const target = { x: entity.x, y: entity.y, z: entity.z, yaw: entity.yaw || 0, pitch: entity.pitch || 0, headYaw: entity.headYaw ?? entity.yaw ?? 0 };
    let track = this.entities.get(entity.id);
    if (!track) {
      const definition = this.definitions.get(entity.entityType) || { id: entity.entityType, name: 'unknown', width: 0.6, height: 1 };
      track = { entity: { ...entity, vehicleId: entity.vehicleId ?? this.vehicles.get(entity.id) }, definition, target, from: { ...target }, start: this.time, createdAt: this.time, bobOffset: (entity.id * .47) % TAU, lastPacket: this.time, speed: 0, phase: 0, lastRendered: target, hurtUntil: -Infinity, attackAt: -Infinity, deathAt: -Infinity };
      this.entities.set(entity.id, track);
    } else {
      if (/boat|raft/.test(track.definition.name)) advanceBoatVisual(track, this.time, (key, fallback) => meta(track.entity, track.definition, key, fallback), this.minecraftVersion, this.gameTime);
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
    if (/boat|raft/.test(track.definition.name)) advanceBoatVisual(track, this.time, (key, fallback) => meta(track.entity, track.definition, key, fallback), this.minecraftVersion, this.gameTime);
    if (Number.isFinite(entity.visualAgeSeconds)) { track.visualAgeSeconds = entity.visualAgeSeconds; track.visualAgeAt = this.time; }
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
      if (id === this.localEntityId || PICK_SKIP.has(track.definition.name)) continue;
      if (track.definition.name === 'armor_stand' && (meta(track.entity, track.definition, 'client_flags') & 16)) continue;
      const position = this.sample(track), scale = meta(track.entity, track.definition, 'baby', false) || track.definition.name === 'armor_stand' && (meta(track.entity, track.definition, 'client_flags') & 1) ? 0.5 : 1;
      let width = (track.definition.width || 0.6) * scale, height = (track.definition.height || 1) * scale;
      if (track.definition.name === 'player') { const pose = meta(track.entity, track.definition, 'pose'); if ([1, 3, 4].includes(pose)) height = .6; else if (pose === 5) height = 1.5; else if (pose === 2) { width = .2; height = .2; } }
      const min = [position.x - width / 2, position.y, position.z - width / 2], max = [position.x + width / 2, position.y + height, position.z + width / 2];
      const distance = rayBoxDistance(eye, direction, min, max, closest?.distance ?? maxDistance);
      if (distance === null) continue;
      const point = eye.map((value, axis) => value + direction[axis] * distance);
      closest = { entityId: id, distance, point, localPoint: point.map((value, axis) => value - [position.x, position.y, position.z][axis]) };
    }
    return closest;
  }

  visible(track, position, camera) {
    if (track.entity.id === this.localEntityId && !camera.thirdPerson) return false;
    const invisible = meta(track.entity, track.definition, 'shared_flags') & 32;
    if (HIDDEN.has(track.definition.name) || invisible && !track.definition.name.includes('item_frame') && !INVISIBLE_LAYERS.has(track.definition.name) && !(HUMANOIDS.test(track.definition.name) && track.entity.equipment?.some(entry => (entry.item || entry.equipment)?.present))) return false;
    if (track.definition.name === 'item' && !meta(track.entity, track.definition, 'item', {})?.present) return false;
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

  skinFor(name, entity, definition) {
    let skin = SKINS[name], model = NATIVE_MODELS[name], slim = false;
    const modern = resolveModernEntity(name, (key, fallback) => meta(entity, definition, key, fallback), this.registries, this.minecraftVersion);
    if (modern) { model = modern.model; skin = [modern.assetId, modern.height]; }
    const remaining = resolveRemainingEntity(name, (key, fallback) => meta(entity, definition, key, fallback), this.minecraftVersion);
    if (remaining) { model = remaining.model; skin = [remaining.assetId, remaining.height]; }
    if (name === 'player' || name === 'mannequin') {
      const profile = name === 'player' ? this.players.get(entity.uuid) : mannequinProfile(meta(entity, definition, 'profile')), account = this.skinCache.request(profile);
      const patch = name === 'mannequin' ? mannequinSkinPatch(profile, this.atlas) : null;
      const fallback = defaultPlayerSkin(name === 'player' ? entity.uuid : '00000000-0000-0000-0000-000000000000');
      if (account?.state === 'ready' || patch?.tile !== undefined) {
        if (account?.state === 'ready') this.stats.accountSkins++;
        slim = patch?.slim ?? account?.slim ?? fallback.slim;
        return { model: slim ? 'player_slim' : 'player', skin: { tile: patch?.tile ?? account.tile, sheet: [64, 64], slim } };
      }
      // ClientMannequin starts with the skin of its empty profile, independent
      // of the entity's spawn UUID, until a profile lookup actually succeeds.
      slim = patch?.slim ?? fallback.slim;
      skin = [fallback.path.replace(/^minecraft:entity\//, ''), 64];
      model = slim ? 'player_slim' : 'player';
    }
    if (name === 'mooshroom') skin = [`cow/${meta(entity, definition, 'type', 'red') === 'brown' ? 'brown' : 'red'}_mooshroom`, 32];
    if (name === 'cat') skin = [`cat/${CAT_VARIANTS[meta(entity, definition, 'variant', 0)] || 'tabby'}`, 32];
    if (name === 'wolf') skin = [`wolf/wolf${meta(entity, definition, 'remaining_anger_time', 0) > 0 ? '_angry' : meta(entity, definition, 'flags', 0) & 4 ? '_tame' : ''}`, 32];
    if (name === 'rabbit') skin = [`rabbit/${meta(entity, definition, 'type', 0) === 99 ? 'caerbannog' : RABBIT_VARIANTS[meta(entity, definition, 'type', 0)] || 'brown'}`, 32];
    if (name === 'horse') skin = [`horse/horse_${HORSE_VARIANTS[meta(entity, definition, 'type_variant', 0) & 255] || 'white'}`, 64];
    if (['donkey', 'mule'].includes(name) && meta(entity, definition, 'chest', false)) model += '_chest';
    if (name === 'pufferfish') model = `pufferfish_${clamp(meta(entity, definition, 'puff_state', 0), 0, 2)}`;
    if (name === 'tropical_fish') { const large = (meta(entity, definition, 'type_variant', 0) & 255) === 1; model = large ? 'tropical_fish_large' : 'tropical_fish'; skin = [`fish/tropical_${large ? 'b' : 'a'}`, 32]; }
    if (name === 'boat' || name === 'chest_boat') {
      const variant = BOAT_VARIANTS[meta(entity, definition, 'type', 0)] || 'oak';
      skin = [`${name === 'chest_boat' ? 'chest_boat' : 'boat'}/${variant}`, name === 'chest_boat' ? 128 : 64];
      model = variant === 'bamboo' ? name === 'chest_boat' ? 'chest_raft' : 'raft' : name;
    }
    if (name === 'fox') skin = [`fox/${meta(entity, definition, 'type', 0) === 1 ? 'snow_fox' : 'fox'}`, 32];
    if (name === 'strider') skin = [`strider/strider${meta(entity, definition, 'suffocating', false) ? '_cold' : ''}`, 128];
    if (name === 'bee') { const flags = meta(entity, definition, 'flags', 0); skin = [`bee/bee${meta(entity, definition, 'remaining_anger_time', 0) > 0 ? '_angry' : ''}${flags & 8 ? '_nectar' : ''}`, 64]; }
    if (name === 'frog') skin = [`frog/${['temperate', 'warm', 'cold'][meta(entity, definition, 'variant', 0)] || 'temperate'}_frog`, 32];
    if (name === 'axolotl') skin = [`axolotl/axolotl_${['lucy', 'wild', 'gold', 'cyan', 'blue'][meta(entity, definition, 'variant', 0)] || 'lucy'}`, 64];
    if (name === 'panda') { let gene = meta(entity, definition, 'main_gene', 0); if ([4, 5].includes(gene) && gene !== meta(entity, definition, 'hidden_gene', 0)) gene = 0; skin = [`panda/${['panda', 'lazy_panda', 'worried_panda', 'playful_panda', 'brown_panda', 'weak_panda', 'aggressive_panda'][gene] || 'panda'}`, 64]; }
    if (name.includes('llama')) skin = [`llama/${['creamy', 'white', 'brown', 'gray'][meta(entity, definition, 'variant', 0)] || 'creamy'}`, 64];
    if (name === 'vex' && (meta(entity, definition, 'flags', 0) & 1)) skin = ['illager/vex_charging', 64];
    if (name === 'shulker') { const color = meta(entity, definition, 'color', 16), colors = ['white', 'orange', 'magenta', 'light_blue', 'yellow', 'lime', 'pink', 'gray', 'light_gray', 'cyan', 'purple', 'blue', 'brown', 'green', 'red', 'black']; if (color >= 0 && color < 16) skin = [`shulker/shulker_${colors[color]}`, 64]; }
    if (name === 'ghast' && meta(entity, definition, 'is_charging', false)) skin = ['ghast/ghast_shooting', 32];
    if (name === 'wither') { const inv = meta(entity, definition, 'inv', 0); if (inv > 0 && !(inv <= 80 && Math.floor(inv / 5) % 2 === 1)) skin = ['wither/wither_invulnerable', 64]; }
    let tile = skin ? this.atlas?.entityTiles?.get(skin[0].includes(':') ? skin[0] : `minecraft:entity/${skin[0]}`) : undefined;
    if ((name === 'player' || name === 'mannequin') && tile === undefined) { tile = this.atlas?.entityTiles?.get('minecraft:entity/player/wide/steve'); slim = false; model = 'player'; }
    const rectangle = tile !== undefined ? this.atlas?.tiles?.[tile] : null;
    const sheet = tile !== undefined ? [rectangle?.width || (['cod', 'salmon', 'pufferfish', 'tropical_fish'].includes(name) ? 32 : name === 'iron_golem' ? 128 : 64), rectangle?.height || skin[1]] : null;
    return { model, skin: sheet ? { tile, sheet, slim } : null };
  }

  itemMaterial(item) {
    if (!item?.present || !Number.isInteger(item.itemId)) return null;
    const definition = this.items.get(item.itemId);
    if (!definition) return null;
    const block = this.blocks.get(definition.name), material = block ? this.materials?.get(block.defaultState) : null;
    const itemTile = this.atlas?.itemTiles?.get(`minecraft:item/${definition.name}`);
    const tile = material?.faces?.up?.tile ?? material?.faces?.east?.tile ?? itemTile ?? -1;
    return { definition, material, tile, block: Boolean(material), itemTile: itemTile ?? -1 };
  }

  equipment(track, context, input, native, handsOnly = false) {
    // The native equipment renderer always submits OverlayTexture.NO_OVERLAY.
    context = { ...context, hurt: false };
    for (const entry of track.entity.equipment || []) {
      const item = entry.item || entry.equipment, data = this.itemMaterial(item);
      if (!data) continue;
      const slot = entry.slot & 127;
      if (handsOnly && slot >= 2) continue;
      if (slot < 2) {
        const side = (slot === 1 ? -1 : 1) * (input.leftHanded ? -1 : 1), armIndex = native?.model.parts.findIndex(part => part.name === (side < 0 ? 'left_arm' : 'right_arm'));
        const mesh = this.itemLibrary.get(item, { displayContext: 'thirdperson' });
        if (drawEquippedItem(this.writer, context, mesh, native?.transforms[armIndex], { ...input, nativeYoungBody: input.young && hasNativeBabyTransform(track.definition.name) }, side)) { this.stats.equipmentParts++; continue; }
        if (data.tile < 0) continue;
        const arm = side;
        const center = [arm * 0.36, input.crouching ? 0.52 : 0.7, -0.14];
        const heldContext = { ...context, rotation: [...context.rotation], rotationMatrix: context.rotationMatrix };
        this.writer.box(center, data.block ? [0.28, 0.28, 0.28] : [0.4, 0.4, 0.022], [1, 1, 1], heldContext, {
          rotation: [input.zombie ? Math.PI / 2 : input.swing * arm, 0, data.block ? 0 : arm * -Math.PI / 4], pivot: [arm * 0.36, 1.375, 0],
          tile: data.block ? data.tile : -1,
          skin: data.block ? null : { tile: data.itemTile, sheet: [1, 1], uv: [0, 0], size: [0, 1, 1], rectangles: Array.from({ length: 6 }, () => [0, 0, 1, 1]) },
        });
        this.stats.equipmentParts++; continue;
      }
      const match = /^(leather|chainmail|copper|iron|golden|diamond|netherite|turtle)_(helmet|chestplate|leggings|boots)$/.exec(data.definition.name);
      if (!match) continue;
      const material = match[1] === 'golden' ? 'gold' : match[1], layer = slot === 3 ? 2 : 1;
      const modernPath = `minecraft:entity/equipment/${layer === 2 ? 'humanoid_leggings' : 'humanoid'}/${material === 'turtle' ? 'turtle_scute' : material}`;
      const tile = this.atlas?.entityTiles?.get(modernPath) ?? this.atlas?.entityTiles?.get(`minecraft:entity/armor/${material}_layer_${layer}`);
      if (tile === undefined) continue;
      const parts = new Set(slot === 5 ? ['head'] : slot === 4 ? ['body', 'right_arm', 'left_arm'] : slot === 3 ? ['body', 'right_leg', 'left_leg'] : ['right_leg', 'left_leg']);
      const tint = material === 'leather' ? leatherTint(item) : [1, 1, 1];
      const model = track.definition.name === 'armor_stand' ? layer === 2 ? 'armor_stand_armor_inner' : 'armor_stand_armor_outer' : layer === 2 ? 'armor_inner' : 'armor_outer';
      drawEntityModel(this.writer, model, context, input, { tile, parts, hat: false, tint });
      if (material === 'leather') {
        const overlay = this.atlas?.entityTiles?.get(`${modernPath}_overlay`) ?? this.atlas?.entityTiles?.get(`minecraft:entity/armor/leather_layer_${layer}_overlay`);
        if (overlay !== undefined) drawEntityModel(this.writer, model, context, input, { tile: overlay, parts, hat: false, inflation: 0.001 });
      }
      this.stats.equipmentParts++;
    }
  }

  modernEquipment(track, context, input, bodyItem, saddleItem) {
    const name = track.definition.name;
    if (!['happy_ghast', 'nautilus', 'zombie_nautilus'].includes(name)) return;
    const draw = (model, path) => {
      const tile = this.atlas?.entityTiles?.get(`minecraft:entity/${path}`);
      if (tile === undefined) return;
      drawEntityModel(this.writer, model, { ...context, hurt: false }, input, { tile });
      this.stats.equipmentParts++;
    };
    const bodyName = bodyItem?.present ? this.items.get(bodyItem.itemId)?.name : null;
    if (name === 'happy_ghast') {
      const color = /^(white|orange|magenta|light_blue|yellow|lime|pink|gray|light_gray|cyan|purple|blue|brown|green|red|black)_harness$/.exec(bodyName || '')?.[1];
      if (color) {
        draw(input.young ? 'happy_ghast_baby_harness' : 'happy_ghast_harness', `equipment/happy_ghast_body/${color}_harness`);
        const harness = this.itemTags.get('minecraft:harnesses')?.has(bodyItem.itemId) ?? true;
        if (harness && meta(track.entity, track.definition, 'is_leash_holder', false))
          draw(input.young ? 'happy_ghast_baby_ropes' : 'happy_ghast_ropes', 'ghast/happy_ghast_ropes');
      }
      return;
    }
    // SimpleEquipmentLayer has no baby equipment model for native nautiluses.
    if (input.young && name === 'nautilus') return;
    const material = /^(iron|golden|diamond|netherite|copper)_nautilus_armor$/.exec(bodyName || '')?.[1];
    if (material) draw('nautilus_armor', `equipment/nautilus_body/${material === 'golden' ? 'gold' : material}`);
    if (saddleItem?.present && this.items.get(saddleItem.itemId)?.name === 'saddle') draw('nautilus_saddle', 'equipment/nautilus_saddle/saddle');
  }

  layers(track, context, input, model) {
    const { entity, definition } = track, name = definition.name;
    const eyes = path => {
      const tile = this.atlas?.entityTiles?.get(`minecraft:entity/${path}`);
      if (tile !== undefined) drawEntityModel(this.writer, model, { ...context, hurt: false }, input, { tile, flags: actorEyeFlags(this.minecraftVersion) });
    };
    if (name === 'enderman') eyes('enderman/enderman_eyes');
    if (name.includes('spider')) eyes('spider_eyes');
    if (meta(entity, definition, 'shared_flags') & 32) return;
    const layer = (path, options = {}) => {
      const tile = this.atlas?.entityTiles?.get(`minecraft:entity/${path}`);
      if (tile !== undefined) drawEntityModel(this.writer, model, context, input, { tile, inflation: 0.0005, ...options });
    };
    if (name === 'horse') {
      const markings = HORSE_MARKINGS[(meta(entity, definition, 'type_variant', 0) >>> 8) & 255];
      if (markings) layer(`horse/horse_markings_${markings}`);
      const armor = entity.equipment?.find(entry => (entry.slot & 127) === 4)?.item;
      const definition = armor?.present ? this.items.get(armor.itemId) : null;
      const material = /^(leather|iron|golden|diamond)_horse_armor$/.exec(definition?.name || '')?.[1];
      if (material) layer(`horse/armor/horse_armor_${material === 'golden' ? 'gold' : material}`, { tint: material === 'leather' ? leatherTint(armor) : [1, 1, 1], inflation: 0.002 });
    }
    if (['wolf', 'cat'].includes(name) && (meta(entity, definition, 'flags', 0) & 4)) layer(`${name}/${name}_collar`, { tint: DYE_RGB[meta(entity, definition, 'collar_color', 14) & 15] });
    if (name === 'tropical_fish') {
      const variant = meta(entity, definition, 'type_variant', 0), shape = (variant & 255) === 1 ? 'b' : 'a', pattern = clamp((variant >>> 8 & 255) + 1, 1, 6);
      layer(`fish/tropical_${shape}_pattern_${pattern}`, { tint: DYE_RGB[(variant >>> 24) & 15] });
    }
    if (name === 'iron_golem') {
      const health = meta(entity, definition, 'health', 100), stage = health < 25 ? 'high' : health < 50 ? 'medium' : health < 75 ? 'low' : null;
      if (stage) layer(`iron_golem/iron_golem_crackiness_${stage}`);
    }
    if (name === 'villager' || name === 'zombie_villager') {
      const data = meta(entity, definition, 'villager_data', { villagerType: 2, villagerProfession: 0, level: 1 });
      const type = VILLAGER_TYPES[data.villagerType ?? data.type] || 'plains', profession = VILLAGER_PROFESSIONS[data.villagerProfession ?? data.profession] || 'none';
      layer(`${name}/type/${type}`);
      if (profession !== 'none') layer(`${name}/profession/${profession}`, { inflation: 0.001 });
      if (!['none', 'nitwit'].includes(profession)) layer(`${name}/profession_level/${VILLAGER_LEVELS[clamp((data.level || 1) - 1, 0, 4)]}`, { inflation: 0.0015 });
    }
  }

  model(track, position, time) {
    const { definition, entity } = track;
    const name = definition.name;
    if (name === 'item_frame' || name === 'glow_item_frame') {
      const result = drawItemFrame(this.writer, track, position, { atlas: this.atlas, library: this.itemLibrary, maps: this.maps, origin: this.meshOrigin });
      if (result.importedModel || result.map) this.stats.nativeModels++; else this.stats.approximateModels++;
      this.stats.equipmentParts += result.items; return;
    }
    const baby = name !== 'zombie_nautilus' && (meta(entity, definition, 'baby', false) || name === 'armor_stand' && Boolean(meta(entity, definition, 'client_flags') & 1));
    const invisible = Boolean(meta(entity, definition, 'shared_flags') & 32);
    const pose = meta(entity, definition, 'pose');
    const context = { position: [position.x, position.y, position.z].map((value, axis) => value - this.meshOrigin[axis]), rotation: [0, -position.yaw, 0], scale: baby ? 0.5 : 1, hurt: time < track.hurtUntil };
    const resolved = this.skinFor(name, entity, definition);
    if (baby && resolved.model && hasNativeBabyTransform(name)) context.scale = 1;
    if (resolved.skin) {
      context.skin = resolved.skin;
      context.fur = this.atlas?.entityTiles?.get('minecraft:entity/sheep/sheep_fur');
      this.stats.texturedModels++;
    } else this.stats.fallbackModels++;
    if (HUMANOIDS.test(name) && !resolved.model) context.scale *= (definition.height || 1.8) / 1.8;
    const travel = Math.hypot(position.x - track.lastRendered.x, position.z - track.lastRendered.z);
    track.phase += travel * 7;
    track.lastRendered = position;
    const speed = this.time - track.lastPacket > 0.25 ? 0 : track.speed;
    const swing = Math.sin(track.phase) * Math.min(0.7, speed * 0.15);
    const posed = { ...entity, yaw: position.yaw, pitch: position.pitch, headYaw: position.headYaw };
    if (resolved.model) {
      context.rotation[1] += Math.PI;
      if (/boat|raft/.test(name)) {
        context.rotation[1] -= Math.PI / 2; context.position[1] += 0.375; context.hurt = false;
        const boat = track.boatPose ?? advanceBoatVisual(track, time, (key, fallback) => meta(entity, definition, key, fallback), this.minecraftVersion, this.gameTime);
        const submerged = entity.isUnderWater ?? nativeBoatUnderWater(position, definition, this.sampleBlock);
        const legacy = /^1\.(\d+)/.exec(this.minecraftVersion)?.[1] <= 20;
        const bubble = !submerged || legacy ? boat.bubbleDegrees : 0;
        track.boatSubmerged = submerged;
        if (boat.hurtRadians || bubble) context.rotationMatrix = combineMatrix(
          combineMatrix(combineMatrix(rotationMatrix([0, context.rotation[1] + Math.PI / 2, 0]), rotationMatrix([boat.hurtRadians, 0, 0])), boatBubbleMatrix(bubble)),
          rotationMatrix([0, -Math.PI / 2, 0]));
      }
      if (name.includes('minecart')) { context.position[1] += 0.375; context.rotation[2] = -position.pitch; }
      if (name === 'trident') context.rotationMatrix = combineMatrix(rotationMatrix([0, position.yaw - Math.PI / 2, 0]), rotationMatrix([0, 0, position.pitch - Math.PI / 2]));
      if (name === 'player' || name === 'mannequin') context.scale *= 0.9375;
      if (name === 'giant') context.scale *= 6;
      if (name === 'wither_skeleton') context.scale *= 1.2;
      if (name === 'cave_spider') context.scale *= 0.7;
      if (name === 'slime' || name === 'magma_cube') context.scale *= clamp(meta(entity, definition, 'size', 1), 1, 127) * (name === 'slime' ? .999 : 1);
      if (name === 'ghast') context.scale *= 4.5;
      if (name === 'elder_guardian') context.scale *= 2.35;
      if (name === 'wither') context.scale *= 2 - clamp(meta(entity, definition, 'inv', 0), 0, 220) / 220 * .5;
      if (name === 'shulker') {
        context.rotation[1] -= Math.PI;
        const face = meta(entity, definition, 'attach_face', 0), opposite = face ^ 1;
        const attachment = opposite === 1 ? IDENTITY : opposite === 0 ? rotationMatrix([Math.PI, 0, 0]) : combineMatrix(rotationMatrix([Math.PI / 2, 0, 0]), rotationMatrix([0, 0, opposite === 2 ? 0 : opposite === 3 ? Math.PI : opposite === 4 ? Math.PI / 2 : -Math.PI / 2]));
        const base = rotationMatrix(context.rotation), pivot = [0, .5, 0], shifted = transform(transform(pivot, attachment).map((value, axis) => pivot[axis] - value), base);
        context.rotationMatrix = combineMatrix(base, attachment); context.position = context.position.map((value, axis) => value + shifted[axis]);
      }
      if ([1, 2, 3, 4].includes(pose)) { context.rotation[0] = Math.PI / 2; context.position[1] += 0.3; }
      if (pose === 7 || time < track.deathAt + 1) context.rotation[2] = Math.min(Math.PI / 2, Math.sqrt(Math.max(0, time - track.deathAt) * 1.6) * Math.PI / 2);
      const attack = time - track.attackAt < 0.3 ? clamp((time - track.attackAt) / 0.3, 0, 1) : 0;
      const input = { swing, phase: track.phase, speed: Math.min(1, speed * 0.15), time, young: baby, pitch: position.pitch, headYaw: angleDelta(position.yaw, position.headYaw), crouching: pose === 5 || Boolean(meta(entity, definition, 'shared_flags', 0) & 2), zombie: /zombie|husk|drowned/.test(name), attack, leftHanded: meta(entity, definition, 'player_main_hand', 1) === 0, humanoid: HUMANOIDS.test(name), sitting: Number.isInteger(entity.vehicleId) || ['wolf', 'cat'].includes(name) && Boolean(meta(entity, definition, 'flags', 0) & 1), paddleLeft: Boolean(meta(entity, definition, 'paddle_left', false)), paddleRight: Boolean(meta(entity, definition, 'paddle_right', false)), family: name === 'camel_husk' ? 'camel' : name.includes('spider') ? 'spider' : name.includes('squid') ? 'squid' : ['cod', 'salmon', 'tropical_fish', 'pufferfish'].includes(name) ? 'fish' : name === 'bat' ? 'bat' : name };
      const hiddenParts = new Set();
      input.nativeCamelBaby = resolved.model === 'camel_baby_modern';
      input.nativeAdultOnly = name === 'camel_husk' && Number.parseInt(this.minecraftVersion, 10) >= 26;
      if (['camel', 'camel_husk', 'ravager', 'sniffer', 'breeze'].includes(name)) {
        input.worldSpeed = speed;
        prepareSpecialEntity(track, input, (key, fallback) => meta(entity, definition, key, fallback), this.gameTime);
      }
      const equipmentItem = slot => { const entry = entity.equipment?.find(entry => (entry.slot & 127) === slot); return entry?.item || entry?.equipment; };
      const bodyItem = equipmentItem(6);
      if (['parrot', 'phantom', 'tadpole', 'armadillo', 'creaking', 'warden', 'copper_golem'].includes(name)) {
        input.nativeModel = resolved.model; input.minecraftVersion = this.minecraftVersion; input.worldSpeed = speed; input.hiddenParts = hiddenParts;
        prepareRemainingEntity(track, input, (key, fallback) => meta(entity, definition, key, fallback), {
          inWater: this.inWaterAt?.([position.x, position.y, position.z]) ?? true,
          hasHands: Boolean(equipmentItem(0)?.present || equipmentItem(1)?.present),
        });
        if (input.suppressDeathRotation) context.rotation[2] = 0;
        if (input.suppressHurt) context.hurt = false;
        if (name === 'phantom') {
          context.scale *= input.phantomScale;
          context.rotationMatrix = combineMatrix(rotationMatrix(context.rotation), rotationMatrix([position.pitch, 0, 0]));
          const shifted = transform([0, -1.3125, .1875], context.rotationMatrix);
          context.position = context.position.map((value, axis) => value + shifted[axis] * context.scale);
        }
      }
      if (name === 'bogged' && meta(entity, definition, 'sheared', false)) hiddenParts.add('mushrooms');
      input.modernFarm = ['cow', 'pig', 'chicken'].includes(name) && resolved.model !== name;
      if (['happy_ghast', 'nautilus', 'zombie_nautilus'].includes(name) || input.modernFarm) {
        input.worldSpeed = speed;
        prepareModernEntity(track, input, { bodyItem, ridden: Boolean(entity.passengers?.length) });
        if (name === 'zombie_nautilus' && bodyItem?.present) hiddenParts.add('corals');
      }
      if (name === 'ender_dragon') {
        input.minecraftVersion = this.minecraftVersion;
        prepareDragon(track, input, position, (key, fallback) => meta(entity, definition, key, fallback), sampleTime => this.sample(track, sampleTime));
        // The native dragon renderer uses delayed yaw, climb tilt and a local
        // forward translation before its model flip, independently of mob yaw.
        context.rotation = [0, -input.dragonYaw, 0];
        context.rotationMatrix = combineMatrix(rotationMatrix(context.rotation), rotationMatrix([input.dragonTilt, 0, 0]));
        const shifted = transform([0, 0, 1], context.rotationMatrix);
        context.position = context.position.map((value, axis) => value + shifted[axis]);
      }
      if (name === 'camel' || name === 'camel_husk') {
        const saddleItem = entity.equipment?.some(entry => (entry.slot & 127) === 7 && this.items.get((entry.item || entry.equipment)?.itemId)?.name === 'saddle');
        const saddled = Boolean(meta(entity, definition, 'flags', 0) & 4) || saddleItem;
        if (!saddled) { hiddenParts.add('saddle'); hiddenParts.add('bridle'); }
        if (!saddled || !entity.passengers?.length) hiddenParts.add('reins');
        input.camelSaddled = saddled; input.camelRidden = Boolean(entity.passengers?.length);
        input.camelSaddleTile = this.atlas?.entityTiles?.get(`minecraft:entity/equipment/${name}_saddle/saddle`);
        if (input.camelSaddleTile !== undefined) { hiddenParts.add('saddle'); hiddenParts.add('bridle'); hiddenParts.add('reins'); }
      }
      if (name.includes('llama') && (baby || !meta(entity, definition, 'chest', false))) { hiddenParts.add('left_chest'); hiddenParts.add('right_chest'); }
      if (name === 'bee') { if (meta(entity, definition, 'flags', 0) & 4) hiddenParts.add('stinger'); input.angry = meta(entity, definition, 'remaining_anger_time', 0) > 0; }
      if (name === 'frog' && pose !== 8) hiddenParts.add('croaking_body');
      if (name === 'goat') { if (!meta(entity, definition, 'has_left_horn', true)) hiddenParts.add('left_horn'); if (!meta(entity, definition, 'has_right_horn', true)) hiddenParts.add('right_horn'); }
      if (name === 'turtle' && (baby || !meta(entity, definition, 'has_egg', false))) hiddenParts.add('egg_belly');
      if (name === 'zombified_piglin') hiddenParts.add('right_ear');
      if (name === 'armor_stand') {
        const flags = meta(entity, definition, 'client_flags', 0); if (!(flags & 4)) { hiddenParts.add('left_arm'); hiddenParts.add('right_arm'); } if (flags & 8) hiddenParts.add('base_plate');
        const defaults = { head: [0, 0, 0], body: [0, 0, 0], left_arm: [-10, 0, -10], right_arm: [-15, 0, 10], left_leg: [-1, 0, -1], right_leg: [1, 0, 1] };
        input.partPoses = Object.fromEntries(Object.entries(defaults).map(([part, fallback]) => { const value = meta(entity, definition, `${part}_pose`, fallback); return [part, (Array.isArray(value) ? value : [value?.pitch ?? value?.x ?? 0, value?.yaw ?? value?.y ?? 0, value?.roll ?? value?.z ?? 0]).map(v => Number(v) * Math.PI / 180)]; }));
        input.bodyYaw = position.yaw;
      }
      if (name.includes('piglin')) {
        input.leftHanded = Boolean(meta(entity, definition, 'mob_flags') & 2); input.dancing = Boolean(meta(entity, definition, 'is_dancing', false)); input.chargingCrossbow = Boolean(meta(entity, definition, 'is_charging_crossbow', false)); input.aggressive = Boolean(meta(entity, definition, 'mob_flags') & 4);
        const crossbow = entity.equipment?.some(entry => (entry.slot & 127) < 2 && this.items.get((entry.item || entry.equipment)?.itemId)?.name === 'crossbow');
        input.holdingCrossbow = input.aggressive && crossbow; if (crossbow) input.aggressive = false;
        const offhand = entity.equipment?.find(entry => (entry.slot & 127) === 1), offItem = offhand?.item || offhand?.equipment;
        input.admiring = name === 'piglin' && Boolean(offItem?.present && this.itemTags.get('minecraft:piglin_loved')?.has(offItem.itemId));
        if (input.chargingCrossbow && track.crossbowAt === undefined) track.crossbowAt = time; if (!input.chargingCrossbow) track.crossbowAt = undefined;
        input.useTicks = Math.max(0, time - (track.crossbowAt ?? time)) * 20;
      }
      if (name === 'shulker') input.peek = clamp(meta(entity, definition, 'peek', 0) / 100, 0, 1);
      const sideHeads = name === 'wither' ? ['target_b', 'target_c'].map((key, index) => {
        const target = this.entities.get(meta(entity, definition, key, 0)); if (!target) return null;
        const point = this.sample(target), angle = position.yaw + index * Math.PI, dx = point.x - position.x - Math.cos(angle) * 1.3, dz = point.z - position.z - Math.sin(angle) * 1.3;
        return { yaw: Math.atan2(dz, dx) - Math.PI / 2, pitch: -Math.atan2(point.y + (target.definition.height || 1) * .85 - position.y - 2.2, Math.hypot(dx, dz)) };
      }) : [];
      const animated = advanceEntityAnimation(track, time, { moving: Boolean(meta(entity, definition, 'moving', false)), inWater: name.includes('guardian') ? this.inWaterAt?.([position.x, position.y, position.z]) ?? true : true, sideHeads, bodyYaw: position.yaw });
      if (animated) Object.assign(input, animated);
      if (name === 'guardian' || name === 'elder_guardian') {
        const target = this.entities.get(meta(entity, definition, 'attack_target', 0)), targetPosition = target ? this.sample(target) : null;
        const eye = targetPosition ? [targetPosition.x, targetPosition.y + (target.definition.height || 1) * .85, targetPosition.z] : this.eye;
        const dx = position.x - eye[0], dz = position.z - eye[2], length = Math.hypot(dx, dz), yaw = position.headYaw ?? position.yaw;
        const dot = length ? (-Math.sin(yaw) * dz - Math.cos(yaw) * dx) / length : 0;
        input.eyeX = Math.sqrt(Math.abs(dot)) * 2 * Math.sign(dot); input.eyeY = eye[1] > position.y + definition.height * .5 ? 0 : 1;
      }
      if (name === 'slime' || name === 'magma_cube') {
        const factor = 1 / (input.squish / (clamp(meta(entity, definition, 'size', 1), 1, 127) * .5 + 1) + 1), base = rotationMatrix(context.rotation);
        context.rotationMatrix = combineMatrix(base, [factor, 0, 0, 0, 1 / factor, 0, 0, 0, factor]);
        context.normalMatrix = combineMatrix(base, [1 / factor, 0, 0, 0, factor, 0, 0, 0, 1 / factor]);
        if (name === 'slime') context.position[1] += .000999;
      }
      let tint = [1, 1, 1];
      if (name === 'tropical_fish') tint = DYE_RGB[(meta(entity, definition, 'type_variant', 0) >>> 16) & 15];
      if (!context.skin) tint = /zombie|creeper|slime/.test(name) ? [0.3, 0.55, 0.22] : name === 'pig' ? [0.84, 0.49, 0.5] : /skeleton/.test(name) ? [0.76, 0.76, 0.69] : [0.65, 0.43, 0.3];
      const native = drawEntityModel(this.writer, resolved.model, context, input, { playerCustomization: name === 'player' || name === 'mannequin' ? meta(entity, definition, 'player_mode_customisation', 127) : undefined, tint, hiddenParts, skipDrawParts: input.skipDrawParts, parts: invisible ? new Set() : undefined });
      if (this.renderer.supportsNativeWaterMask === true && !invisible && /^(?:chest_)?boat(?:_modern)?$/.test(resolved.model) && !track.boatSubmerged)
        drawEntityModel(this.waterMaskWriter, 'boat_water_patch', { ...context, skin: null, hurt: false }, {}, { tile: -1 });
      for (const layer of input.nativeLayers ?? []) {
        if (invisible && name !== 'phantom' && name !== 'creaking') continue;
        const tile = this.atlas?.entityTiles?.get(layer.path); if (tile === undefined) continue;
        drawEntityModel(this.writer, resolved.model, layer.noOverlay ? { ...context, hurt: false } : context, input,
          { tile, flags: layer.flags, parts: layer.parts, alpha: layer.alpha, hiddenParts, skipDrawParts: input.skipDrawParts });
      }
      if (['camel', 'camel_husk'].includes(name) && !input.nativeCamelBaby && !(input.nativeAdultOnly && baby) && input.camelSaddled && input.camelSaddleTile !== undefined) {
        drawEntityModel(this.writer, 'camel', { ...context, hurt: false }, input, { tile: input.camelSaddleTile,
          parts: new Set(input.camelRidden ? ['saddle', 'bridle', 'reins'] : ['saddle', 'bridle']) });
      }
      if (name === 'breeze') {
        const wind = this.atlas?.entityTiles?.get('minecraft:entity/breeze/breeze_wind'), eyes = this.atlas?.entityTiles?.get('minecraft:entity/breeze/breeze_eyes');
        if (wind !== undefined) drawEntityModel(this.writer, 'breeze_wind', { ...context, hurt: false }, input, { tile: wind, flags: 32 | WIND_TRANSLUCENT, uvOffset: [(time * 20 * .02) % 1, 0] });
        if (eyes !== undefined) drawEntityModel(this.writer, 'breeze_eyes', { ...context, hurt: false }, input, { tile: eyes, flags: 32 | FULLBRIGHT | EMISSIVE_TRANSLUCENT });
      }
      if (name === 'ender_dragon') {
        const eyes = this.atlas?.entityTiles?.get('minecraft:entity/enderdragon/dragon_eyes');
        if (eyes !== undefined) drawEntityModel(this.writer, 'ender_dragon', { ...context, hurt: false }, input, { tile: eyes, flags: actorEyeFlags(this.minecraftVersion) });
      }
      if (!invisible && name === 'sheep' && context.fur !== undefined && !(meta(entity, definition, 'wool', 0) & 16)) drawEntityModel(this.writer, 'sheep_fur', context, input, { tile: context.fur, tint: DYE_RGB[meta(entity, definition, 'wool', 0) & 15] });
      if (!invisible && ['drowned', 'stray', 'bogged'].includes(name)) {
        const overlay = this.atlas?.entityTiles?.get(`minecraft:entity/${name === 'drowned' ? 'zombie/drowned_outer_layer' : `skeleton/${name === 'bogged' ? 'bogged' : 'stray'}_overlay`}`);
        if (overlay !== undefined) drawEntityModel(this.writer, name === 'drowned' ? 'drowned_outer' : name === 'bogged' ? 'bogged_outer' : 'skeleton_outer', context, input, { tile: overlay });
      }
      if (name === 'slime' && context.skin) drawEntityModel(this.writer, 'slime_outer', context, input, { flags: 64 });
      this.modernEquipment(track, context, input, bodyItem, equipmentItem(7));
      this.layers(track, context, input, resolved.model);
      if (HUMANOIDS.test(name)) this.equipment(track, context, input, native);
      if (name === 'copper_golem' && !invisible) this.equipment(track, context, input, native, true);
      this.stats.nativeModels++;
    } else if (name === 'arrow' || name === 'spectral_arrow') {
      const type = name === 'spectral_arrow' ? 'spectral_arrow' : meta(entity, definition, 'effect_color', -1) >= 0 ? 'tipped_arrow' : 'arrow';
      const tile = this.atlas?.entityTiles?.get(`minecraft:entity/projectiles/${type}`) ?? -1;
      context.rotationMatrix = combineMatrix(rotationMatrix([0, position.yaw - Math.PI / 2, 0]), rotationMatrix([0, 0, position.pitch]));
      this.writer.triangles(arrowGeometry(), context, { matrix: IDENTITY, position: [0, 0, 0], tile, flags: 32, tint: [1, 1, 1] });
      this.stats.nativeModels++;
    } else if (HUMANOIDS.test(name)) humanoid(this.writer, context, definition, posed, swing);
    else if (name === 'creeper') creeper(this.writer, context, swing);
    else if (QUADRUPEDS.test(name)) quadruped(this.writer, context, definition, posed, swing);
    else if (name.includes('spider')) spider(this.writer, context, swing);
    else if (name.includes('boat') || name.includes('minecart')) vehicle(this.writer, context, definition);
    else if (name === 'item') {
      const item = meta(entity, definition, 'item', {}), mesh = this.itemLibrary.get(item, { displayContext: 'ground' });
      context.rotation = [0, 0, 0];
      const age = Number.isFinite(track.visualAgeSeconds)
        ? track.visualAgeSeconds + clamp(time - track.visualAgeAt, 0, .05)
        : Math.max(0, time - (track.createdAt || 0));
      track.lastVisualAge = age;
      const bob = Number.isFinite(entity.bobOffset) ? entity.bobOffset : track.bobOffset || 0;
      if (drawDroppedItem(this.writer, context, item, mesh, { age, bob })) { this.stats.nativeModels++; return; }
      const data = this.itemMaterial(item), tile = data?.tile ?? -1;
      const color = tile >= 0 ? [1, 1, 1] : [0.74, 0.65, 0.39];
      context.position[1] += 0.15 + Math.sin(time * 2 + entity.id * 0.47) * 0.045;
      context.rotation[1] = time * 0.7;
      const count = clamp(Math.ceil(Math.log2(Math.max(1, item.itemCount || 1))) - 1, 1, 5);
      for (let copy = 0; copy < count; copy++) this.writer.box([copy ? Math.sin(copy * 23 + entity.id) * 0.09 : 0, copy ? Math.cos(copy * 13 + entity.id) * 0.06 : 0, copy * 0.018], data?.block ? [0.24, 0.24, 0.24] : [0.24, 0.24, 0.025], color, context, { tile: data?.block ? tile : -1, skin: !data?.block && tile >= 0 ? { tile, rectangles: Array.from({ length: 6 }, () => [0, 0, 1, 1]) } : null });
    } else if (name === 'bee') {
      this.writer.box([0, 0.3, 0], [0.55, 0.45, 0.65], [0.76, 0.56, 0.06], context);
      for (const z of [-0.17, 0.05]) this.writer.box([0, 0.3, z], [0.56, 0.46, 0.07], [0.15, 0.1, 0.04], context);
      for (const side of [-1, 1]) this.writer.box([side * 0.25, 0.59, 0], [0.35, 0.025, 0.4], [0.74, 0.82, 0.88], context, { rotation: [0, 0, side * Math.sin(time * 24) * 0.5], pivot: [side * 0.17, 0.58, 0] });
    } else {
      const size = name.includes('slime') || name === 'magma_cube' ? clamp(meta(entity, definition, 'size', 1), 1, 16) * 0.52 : null;
      this.writer.box([0, (size || definition.height || 0.8) / 2, 0], [size || definition.width || 0.6, size || definition.height || 0.8, size || definition.width || 0.6], size ? [0.34, 0.61, 0.26] : [0.49, 0.45, 0.39], context);
    }
    if (!resolved.model && !['arrow', 'spectral_arrow'].includes(name)) this.stats.approximateModels++;
  }

  update(time, eye, camera = {}) {
    this.stats.dynamicShadows = Boolean(this.renderer.stats?.().dynamicShadows);
    if (!Number.isFinite(time) || !eye || eye.length !== 3 || !Array.from(eye).every(Number.isFinite)) return this.stats;
    this.time = time; this.eye = Array.from(eye); this.inWaterAt = camera.inWaterAt; this.sampleBlock = camera.sampleBlock; this.gameTime = camera.gameTime;
    const localEntityId = Number.isInteger(camera.entityId) ? camera.entityId : null;
    if (localEntityId !== this.localEntityId) { this.localEntityId = localEntityId; this.dirty = true; }
    if (time - this.lastUpload < this.uploadInterval) return this.stats;
    const cameraSignature = [...eye, ...(camera.direction || []), camera.fov || 0, camera.aspect || 0, camera.thirdPerson ? 1 : 0].map((value) => value.toFixed(2)).join(',');
    if (cameraSignature !== this.cameraSignature) this.dirty = true;
    this.cameraSignature = cameraSignature;
    const candidates = [];
    let animated = false;
    for (const track of this.entities.values()) {
      const position = this.sample(track, time);
      if (track.partyJukebox) {
        const block = this.sampleBlock?.(...track.partyJukebox);
        if (Math.hypot(...track.partyJukebox.map((value, axis) => value + .5 - [position.x, position.y, position.z][axis])) >= 3.46
          || block && String(block.name).replace(/^minecraft:/, '') !== 'jukebox') {
          track.partyJukebox = null;
          if (track.entity.partyParrot) { track.entity.partyParrot = false; this.dirty = true; }
        }
      }
      if (/boat|raft/.test(track.definition.name)) {
        track.boatPose = advanceBoatVisual(track, time, (key, fallback) => meta(track.entity, track.definition, key, fallback), this.minecraftVersion, this.gameTime);
        if (track.boatPose.animated) animated = true;
        const submerged = track.entity.isUnderWater ?? nativeBoatUnderWater(position, track.definition, this.sampleBlock);
        if (submerged !== track.boatSubmerged) this.dirty = true;
      }
      if (!this.visible(track, position, camera)) continue;
      const lightFlags = entityLightFlags(track, position, this.getLight);
      if (lightFlags !== track.lightFlags) this.dirty = true;
      track.lightFlags = lightFlags;
      candidates.push({ track, position, lightFlags, distance: this.distance(position) });
      const itemAnimated = track.definition.name === 'item' && (!Number.isFinite(track.visualAgeSeconds)
        || track.lastVisualAge !== track.visualAgeSeconds + clamp(time - track.visualAgeAt, 0, .05));
      if (remainingEntityAnimated(track, time, (key, fallback) => meta(track.entity, track.definition, key, fallback))) animated = true;
      if (/boat|raft/.test(track.definition.name) && ['paddle_left', 'paddle_right'].some(key => meta(track.entity, track.definition, key, false))) animated = true;
      if (itemAnimated || time - track.start < 0.08 || (track.speed > 0 && time - track.lastPacket < 0.3) || time < track.hurtUntil + 0.05 || time < track.attackAt + 0.35 || time < track.deathAt + 1 || ['bee', 'squid', 'glow_squid', 'bat', 'cod', 'salmon', 'pufferfish', 'tropical_fish', 'ghast', 'blaze', 'guardian', 'elder_guardian', 'endermite', 'silverfish', 'wither', 'piglin', 'piglin_brute', 'zombified_piglin', 'camel', 'camel_husk', 'happy_ghast', 'nautilus', 'zombie_nautilus', 'sniffer', 'breeze', 'ender_dragon'].includes(track.definition.name) || ['cow', 'pig', 'chicken'].includes(track.definition.name) && ((track.specialWalk?.speed || 0) > .001 || (track.specialWalk?.oldSpeed || 0) > .001) || track.definition.name === 'chicken' && ((track.entity.grounded ?? track.entity.onGround ?? true) === false || (track.chickenFlap?.speed || 0) > .001 || (track.chickenFlap?.oldSpeed || 0) > .001) || track.definition.name === 'ravager' && time < (track.stunnedAt ?? -Infinity) + 3.05 || ['slime', 'magma_cube'].includes(track.definition.name) && (Boolean(track.entity.onGround) !== track.animationState?.ground || Math.abs(track.animationState?.targetSquish || 0) > .001 || Math.abs(track.animationState?.squish || 0) > .001)) animated = true;
    }
    if (!this.dirty && !animated) return this.stats;
    candidates.sort((a, b) => a.distance - b.distance);
    const visible = candidates.slice(0, this.maxVisible);
    this.meshOrigin = Array.from(eye, value => Math.floor(value / 256) * 256);
    this.writer.reset();
    this.waterMaskWriter.reset();
    this.stats.texturedModels = 0; this.stats.fallbackModels = 0; this.stats.nativeModels = 0; this.stats.approximateModels = 0; this.stats.accountSkins = 0; this.stats.equipmentParts = 0;
    for (const { track, position, lightFlags } of visible) {
      const first = this.writer.length; this.model(track, position, time);
      for (let index = first + 13; index < this.writer.length; index += STRIDE) this.writer.vertices[index] = (this.writer.vertices[index] & ~LIGHT_MASK) | lightFlags;
      track.lightFlags = lightFlags;
    }
    if (this.waterMaskWriter.length) {
      const worldBounds = { min: this.waterMaskWriter.min.map((value, axis) => value + this.meshOrigin[axis]), max: this.waterMaskWriter.max.map((value, axis) => value + this.meshOrigin[axis]) };
      this.renderer.uploadDynamicMesh(this.waterMaskKey, this.waterMaskWriter.vertices.subarray(0, this.waterMaskWriter.length), EMPTY, worldBounds,
        { stride: STRIDE, origin: [...this.meshOrigin], nativeWaterMask: true });
      this.hasWaterMask = true;
    } else if (this.hasWaterMask) { this.renderer.removeMesh(this.waterMaskKey); this.hasWaterMask = false; }
    this.stats.waterMaskVertices = this.waterMaskWriter.length / STRIDE;
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
    this.entities.clear(); this.vehicles.clear(); this.players.clear(); this.itemTags.clear(); this.skinCache.clear(); this.writer.reset(); this.waterMaskWriter.reset();
    if (this.hasMesh) this.renderer.removeMesh(this.key);
    if (this.hasWaterMask) this.renderer.removeMesh(this.waterMaskKey);
    this.hasWaterMask = false; this.stats.waterMaskVertices = 0;
    this.hasMesh = false; this.dirty = false; this.lastUpload = -Infinity;
    this.localEntityId = null;
    Object.assign(this.stats, { tracked: 0, visible: 0, vertices: 0, texturedModels: 0, fallbackModels: 0, nativeModels: 0, approximateModels: 0, accountSkins: 0, equipmentParts: 0 });
  }
}

export function buildEntityPreview({ name, position = [0, 0, 0], origin = [0, 0, 0], yaw = 0, scale = 1, time = 0, metadata = [], nbt = null }, { registry = {}, registries = new Map(), atlas = null, materials = null } = {}) {
  const definition = registry.entities?.find(entity => entity.name === name.replace(/^minecraft:/, ''));
  if (!definition) return null;
  const scene = new EntityScene({ registry, registries, atlas, materials, renderer: { uploadDynamicMesh() {}, removeMesh() {} } });
  const sample = { x: position[0], y: position[1], z: position[2], yaw, pitch: 0, headYaw: yaw };
  const saved = previewEntityData(nbt, definition, registry), byKey = new Map(saved.metadata.map(entry => [entry.key, entry]));
  for (const entry of metadata || []) byKey.set(entry.key, entry);
  const track = { definition, entity: { id: 0, uuid: 'block-entity-preview', entityType: definition.id, ...sample, metadata: [...byKey.values()], equipment: saved.equipment }, phase: 0, lastRendered: sample, lastPacket: 0, speed: 0, hurtUntil: -Infinity, attackAt: -Infinity, deathAt: -Infinity };
  scene.time = time; scene.eye = [...position]; scene.meshOrigin = [...origin]; scene.model(track, sample, time);
  const vertices = scene.writer.vertices.slice(0, scene.writer.length);
  const local = position.map((value, axis) => value - origin[axis]);
  for (let index = 0; index < vertices.length; index += 14) for (let axis = 0; axis < 3; axis++) vertices[index + axis] = local[axis] + (vertices[index + axis] - local[axis]) * scale;
  const bound = value => value.map((v, axis) => local[axis] + (v - local[axis]) * scale);
  return { vertices, origin, bounds: { min: bound(scene.writer.min), max: bound(scene.writer.max) }, source: 'block-entity-preview', model: definition.name };
}
