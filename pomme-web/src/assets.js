import { unzipSync, unzlibSync } from '../vendor/fflate.js';
import { registryStates } from './anvil.js';
import { copperStatueForm } from './copper-statue.js';
import { hangingSignForm } from './hanging-sign.js';

export const MATERIAL_FLAGS = Object.freeze({ SOLID: 1, AO_OPAQUE: 2, FLUID: 4, EMISSIVE: 8, CUSTOM_MODEL: 16, CUTOUT: 32, BLEND: 64, INVISIBLE: 128, HEIGHT_IGNORED: 256 });

// A block's FluidState is independent of its render shape and collision shape.
// SeagrassBlock, TallSeagrassBlock, KelpBlock and KelpPlantBlock always contain
// source water; SimpleWaterloggedBlock implementations contain it when logged.
export function nativeContainedFluid(name, properties = {}) {
  const bare = name.replace(/^minecraft:/, '');
  const kind = bare === 'lava' ? 2 : bare === 'water' || bare === 'bubble_column'
    || ['seagrass', 'tall_seagrass', 'kelp', 'kelp_plant'].includes(bare)
    || properties.waterlogged === 'true' ? 1 : 0;
  if (!kind) return null;
  const rawLevel = bare === 'water' || bare === 'lava' ? Number(properties.level ?? 0) : 0;
  const level = Number.isInteger(rawLevel) && rawLevel >= 0 && rawLevel <= 15 ? rawLevel : 0;
  return { kind, level };
}
export const FACE_NAMES = Object.freeze(['east', 'west', 'up', 'down', 'south', 'north']);
export const BIOME_TINT = Object.freeze({ NONE: 0, GRASS: 1, FOLIAGE: 2, WATER: 3, UPPER_GRASS: 4 });
const colorFromHex = color => [color >> 16 & 255, color >> 8 & 255, color & 255].map(value => value / 255);
export function nativeBlockTint(name, properties, index) {
  if (index === undefined || index === null || index < 0) return { tintKind: 0, tint: [1, 1, 1] };
  if (['grass_block', 'fern', 'short_grass', 'potted_fern', 'sugar_cane'].includes(name) || name === 'pink_petals' && index !== 0) return { tintKind: 1, tint: [1, 1, 1] };
  if (['tall_grass', 'large_fern'].includes(name)) return { tintKind: properties.half === 'upper' ? 4 : 1, tint: [1, 1, 1] };
  if (['oak_leaves', 'jungle_leaves', 'acacia_leaves', 'dark_oak_leaves', 'mangrove_leaves', 'vine'].includes(name)) return { tintKind: 2, tint: [1, 1, 1] };
  if (['water', 'bubble_column', 'water_cauldron'].includes(name)) return { tintKind: 3, tint: [1, 1, 1] };
  if (name === 'spruce_leaves') return { tintKind: 0, tint: colorFromHex(0x619961) };
  if (name === 'birch_leaves') return { tintKind: 0, tint: colorFromHex(8431445) };
  if (name === 'lily_pad') return { tintKind: 0, tint: colorFromHex(2129968) };
  if (['attached_melon_stem', 'attached_pumpkin_stem'].includes(name)) return { tintKind: 0, tint: colorFromHex(14731036) };
  if (['melon_stem', 'pumpkin_stem'].includes(name)) { const age = Math.max(0, Math.min(7, Number(properties.age) || 0)); return { tintKind: 0, tint: [age * 32, 255 - age * 8, age * 4].map(value => value / 255) }; }
  if (name === 'redstone_wire') {
    const f32 = Math.fround, power = Math.max(0, Math.min(15, Number(properties.power) || 0)), level = f32(power / 15), square = f32(level * level);
    const channels = [f32(f32(level * f32(.6)) + f32(level > 0 ? .4 : .3)), f32(f32(square * f32(.7)) - .5), f32(f32(square * f32(.6)) - f32(.7))];
    return { tintKind: 0, tint: channels.map(value => Math.floor(f32(Math.max(0, Math.min(1, value)) * 255)) / 255) };
  }
  return { tintKind: 0, tint: [1, 1, 1] };
}
const encoder = new TextDecoder('utf-8', { fatal: true });
const qualify = (name, namespace = 'minecraft') => name.includes(':') ? name : `${namespace}:${name}`;
const pathFor = (name, type, namespace = 'minecraft') => {
  const [ns, path] = qualify(name, namespace).split(':');
  if (!/^[a-z0-9_.-]+$/.test(ns) || !/^[a-z0-9_./-]+$/.test(path) || path.split('/').includes('..')) throw new Error('Invalid asset resource location');
  return `assets/${ns}/${type}/${path}`;
};

/** Decode vanilla/resource-pack PNGs without DOM dependencies. Animation uses frame zero. */
export function decodePNG(bytes, { maxPixels = 4_194_304 } = {}) {
  if (!(bytes instanceof Uint8Array) || bytes.length < 33 || ![137, 80, 78, 71, 13, 10, 26, 10].every((n, i) => bytes[i] === n)) throw new Error('Invalid PNG signature');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let width, height, depth, color, palette, transparency, offset = 8, ended = false;
  const idat = [];
  while (offset + 12 <= bytes.length) {
    const length = view.getUint32(offset), type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
    if (length > bytes.length - offset - 12) throw new Error('Truncated PNG chunk');
    const data = bytes.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      if (width !== undefined || length !== 13) throw new Error('Invalid PNG header');
      width = view.getUint32(offset + 8); height = view.getUint32(offset + 12); depth = data[8]; color = data[9];
      if (!width || !height || width * height > maxPixels) throw new Error('PNG exceeds the pixel limit');
      if (data[10] !== 0 || data[11] !== 0 || data[12] !== 0) throw new Error('Interlaced PNG textures are unsupported');
    } else if (type === 'PLTE') palette = data;
    else if (type === 'tRNS') transparency = data;
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') { ended = true; break; }
    offset += length + 12;
  }
  if (!width || !ended || !idat.length) throw new Error('Incomplete PNG');
  const channels = ({ 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 })[color];
  if (!channels || ![1, 2, 4, 8, 16].includes(depth) || (depth < 8 && color !== 0 && color !== 3) || (color === 3 && depth === 16)) throw new Error('Unsupported PNG color format');
  if (color === 3 && (!palette || palette.length % 3)) throw new Error('Indexed PNG is missing its palette');
  const compressed = new Uint8Array(idat.reduce((sum, chunk) => sum + chunk.length, 0));
  let cursor = 0; for (const chunk of idat) { compressed.set(chunk, cursor); cursor += chunk.length; }
  const rowBytes = Math.ceil(width * channels * depth / 8), bpp = Math.max(1, Math.ceil(channels * depth / 8));
  const expected = height * (rowBytes + 1);
  const raw = unzlibSync(compressed, { out: new Uint8Array(expected + 1) });
  if (raw.length !== expected) throw new Error('Invalid PNG decompressed size');
  const scan = new Uint8Array(rowBytes * height);
  const paeth = (a, b, c) => { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); return pa <= pb && pa <= pc ? a : pb <= pc ? b : c; };
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (rowBytes + 1)];
    if (filter > 4) throw new Error('Invalid PNG scanline filter');
    for (let x = 0; x < rowBytes; x++) {
      const a = x >= bpp ? scan[y * rowBytes + x - bpp] : 0;
      const b = y ? scan[(y - 1) * rowBytes + x] : 0;
      const c = y && x >= bpp ? scan[(y - 1) * rowBytes + x - bpp] : 0;
      const predictor = [0, a, b, Math.floor((a + b) / 2), paeth(a, b, c)][filter];
      scan[y * rowBytes + x] = (raw[y * (rowBytes + 1) + x + 1] + predictor) & 255;
    }
  }
  const rgba = new Uint8Array(width * height * 4), sampleMax = 2 ** depth - 1;
  const sample = (x, y, channel = 0) => {
    const bit = (x * channels + channel) * depth, base = y * rowBytes + Math.floor(bit / 8);
    if (depth === 16) return scan[base] * 256 + scan[base + 1];
    return (scan[base] >> (8 - depth - bit % 8)) & sampleMax;
  };
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const i = (y * width + x) * 4, first = sample(x, y);
    if (color === 3) {
      if (first * 3 + 2 >= palette.length) throw new Error('PNG index exceeds its palette');
      rgba.set(palette.subarray(first * 3, first * 3 + 3), i); rgba[i + 3] = transparency?.[first] ?? 255;
    } else {
      const scale = n => Math.round(n * 255 / sampleMax);
      if (color === 0 || color === 4) rgba[i] = rgba[i + 1] = rgba[i + 2] = scale(first);
      else { rgba[i] = scale(first); rgba[i + 1] = scale(sample(x, y, 1)); rgba[i + 2] = scale(sample(x, y, 2)); }
      rgba[i + 3] = color === 4 ? scale(sample(x, y, 1)) : color === 6 ? scale(sample(x, y, 3)) : 255;
      if (transparency && color === 0 && first === (transparency[0] << 8 | transparency[1])) rgba[i + 3] = 0;
      if (transparency && color === 2 && [0, 1, 2].every(c => sample(x, y, c) === (transparency[c * 2] << 8 | transparency[c * 2 + 1]))) rgba[i + 3] = 0;
    }
  }
  return { width, height, pixelsRGBA: rgba };
}

function checkCondition(condition, properties) {
  if (!condition) return true;
  if (condition.OR) return condition.OR.some(c => checkCondition(c, properties));
  if (condition.AND) return condition.AND.every(c => checkCondition(c, properties));
  return Object.entries(condition).every(([key, values]) => `${values}`.split('|').includes(`${properties[key]}`));
}
function selectVariants(blockState, properties) {
  if (Array.isArray(blockState.multipart)) return blockState.multipart.filter(part => checkCondition(part.when, properties)).flatMap(part => [Array.isArray(part.apply) ? part.apply[0] : part.apply]);
  return Object.entries(blockState.variants ?? {}).filter(([key]) => !key || key.split(',').every(pair => {
    const [name, values] = pair.split('='); return values?.split('|').includes(`${properties[name]}`);
  })).flatMap(([, model]) => [Array.isArray(model) ? model[0] : model]);
}
const rotate = (point, axis, degrees, origin = [.5, .5, .5]) => {
  const radians = degrees * Math.PI / 180, c = Math.cos(radians), s = Math.sin(radians);
  const v = point.map((n, i) => n - origin[i]);
  const a = axis === 'x' ? 1 : axis === 'y' ? 2 : 0, b = (a + 1) % 3;
  const aa = v[a]; v[a] = aa * c - v[b] * s; v[b] = aa * s + v[b] * c;
  return v.map((n, i) => n + origin[i]);
};
const normalFor = { east: [1, 0, 0], west: [-1, 0, 0], up: [0, 1, 0], down: [0, -1, 0], south: [0, 0, 1], north: [0, 0, -1] };
function corners(from, to, face) {
  const [x, y, z] = from, [X, Y, Z] = to;
  return ({ east: [[X, y, Z], [X, y, z], [X, Y, z], [X, Y, Z]], west: [[x, y, z], [x, y, Z], [x, Y, Z], [x, Y, z]], up: [[x, Y, Z], [X, Y, Z], [X, Y, z], [x, Y, z]], down: [[x, y, z], [X, y, z], [X, y, Z], [x, y, Z]], south: [[x, y, Z], [X, y, Z], [X, Y, Z], [x, Y, Z]], north: [[X, y, z], [x, y, z], [x, Y, z], [X, Y, z]] })[face];
}
function defaultUV(from, to, face) {
  const [x, y, z] = from, [X, Y, Z] = to;
  return ({ east: [1 - Z, 1 - Y, 1 - z, 1 - y], west: [z, 1 - Y, Z, 1 - y], up: [x, z, X, Z], down: [x, 1 - Z, X, 1 - z], south: [x, 1 - Y, X, 1 - y], north: [1 - X, 1 - Y, 1 - x, 1 - y] })[face];
}
const powerOfTwo = n => 2 ** Math.ceil(Math.log2(Math.max(1, n)));

function textureAnimation(image, metadata) {
  const animation = metadata?.animation;
  if (!animation) return null;
  const frameWidth = animation.width ?? (animation.height === undefined ? Math.min(image.width, image.height) : image.width);
  const frameHeight = animation.height ?? (animation.width === undefined ? Math.min(image.width, image.height) : image.height);
  if (!Number.isInteger(frameWidth) || !Number.isInteger(frameHeight) || frameWidth <= 0 || frameHeight <= 0 || image.width % frameWidth || image.height % frameHeight) throw new Error('Invalid animation frame dimensions');
  const columns = image.width / frameWidth, count = columns * image.height / frameHeight;
  const defaultDuration = animation.frametime ?? 1;
  if (!Number.isInteger(defaultDuration) || defaultDuration < 1) throw new Error('Invalid animation frametime');
  if (animation.frames === undefined && count > 1024) throw new Error('Animation exceeds the frame count limit');
  const entries = animation.frames ?? Array.from({ length: count }, (_, index) => index);
  if (!Array.isArray(entries) || !entries.length || entries.length > 1024) throw new Error('Invalid animation frame sequence');
  const sequence = entries.map(entry => {
    const index = typeof entry === 'number' ? entry : entry?.index, duration = typeof entry === 'number' ? defaultDuration : entry?.time ?? defaultDuration;
    if (!Number.isInteger(index) || index < 0 || index >= count || !Number.isInteger(duration) || duration < 1 || duration > 1_000_000) throw new Error('Invalid animation frame index or duration');
    return { index, duration };
  });
  return { sequence, interpolate: animation.interpolate === true, rect(index) { return { x: index % columns * frameWidth, y: Math.floor(index / columns) * frameHeight, width: frameWidth, height: frameHeight }; } };
}

// Java ModelPart.Cube's 2D box unwrap, ported from the native client's
// block_entity_model.rs. Coordinates stay in the author's nominal sheet size.
function entityCube(from, to, offset, sheet = [64, 64], omit = [], sourceSize = null, tint = null) {
  const [u, v] = offset, [w, h, d] = sourceSize ?? to.map((n, i) => n - from[i]);
  const rects = {
    north: [u + d, v + d, u + d + w, v + d + h], south: [u + 2 * d + w, v + d, u + 2 * d + 2 * w, v + d + h],
    down: [u + d, v, u + d + w, v + d], up: [u + d + w, v + d, u + d + 2 * w, v],
    west: [u, v + d, u + d, v + d + h], east: [u + d + w, v + d, u + 2 * d + w, v + d + h],
  };
  const faces = Object.fromEntries(Object.entries(rects).filter(([face]) => !omit.includes(face)).map(([face, rect]) => {
    // Entity Polygon uses the opposite corner orientation on vertical faces.
    const r = face === 'up' || face === 'down' ? rect : [rect[2], rect[3], rect[0], rect[1]];
    return [face, { texture: '#entity', uv: r.map((n, i) => n / sheet[i % 2] * 16), ...(tint ? { staticTint: tint } : {}) }];
  }));
  return { from, to, faces };
}
const dyeColors = { white: [.95, .95, .95], orange: [.85, .5, .2], magenta: [.7, .3, .85], light_blue: [.4, .6, .85], yellow: [.9, .9, .2], lime: [.5, .8, .1], pink: [.95, .5, .65], gray: [.3, .3, .3], light_gray: [.6, .6, .6], cyan: [.3, .5, .6], purple: [.5, .25, .7], blue: [.2, .3, .7], brown: [.4, .3, .2], green: [.4, .5, .2], red: [.6, .2, .2], black: [.1, .1, .1] };
const yawFor = facing => ({ south: 0, west: 90, north: 180, east: 270 })[facing] ?? 0;

/** Static block-entity forms; their animation/text/pattern data belongs to the world. */
function blockEntityModel(name, properties, tileByName) {
  const statue = copperStatueForm(name, properties, tileByName);
  if (statue) return statue;
  const hanging = hangingSignForm(name, properties, tileByName);
  if (hanging) return hanging;
  let texture, elements, x = 0, y = 0, freeY = 0, kind, additionalTextures = {};
  if (['chest', 'trapped_chest', 'ender_chest'].includes(name) || /^(?:waxed_)?(?:(?:exposed|weathered|oxidized)_)?copper_chest$/.test(name)) {
    kind = 'chest'; const type = name === 'ender_chest' ? 'single' : properties.type ?? 'single';
    const oxidation = /^(?:waxed_)?(?:(exposed|weathered|oxidized)_)?copper_chest$/.exec(name);
    const material = oxidation ? `copper${oxidation[1] ? `_${oxidation[1]}` : ''}` : name === 'ender_chest' ? 'ender' : name === 'trapped_chest' ? 'trapped' : 'normal';
    texture = `minecraft:entity/chest/${material}${type === 'single' ? '' : `_${type}`}`;
    const bx = type === 'left' ? 0 : 1, width = type === 'single' ? 14 : 15;
    const lockX = type === 'left' ? 0 : type === 'right' ? 15 : 7, lockWidth = type === 'single' ? 2 : 1;
    const omit = type === 'left' ? ['west'] : type === 'right' ? ['east'] : [];
    elements = [entityCube([bx, 0, 1], [bx + width, 10, 15], [0, 19], [64, 64], omit), entityCube([bx, 9, 1], [bx + width, 14, 15], [0, 0], [64, 64], omit), entityCube([lockX, 7, 15], [lockX + lockWidth, 11, 16], [0, 0], [64, 64], omit)];
    y = yawFor(properties.facing);
  } else if (name === 'shulker_box' || name.endsWith('_shulker_box')) {
    kind = 'shulker'; const color = name === 'shulker_box' ? '' : `_${name.slice(0, -12)}`;
    texture = `minecraft:entity/shulker/shulker${color}`;
    elements = [entityCube([0, 0, 0], [16, 8, 16], [0, 28]), entityCube([0, 4, 0], [16, 16, 16], [0, 0])];
    const facing = properties.facing ?? 'up';
    x = ({ down: 180, north: 90, south: 270, east: 90, west: 90 })[facing] ?? 0;
    y = facing === 'east' ? 90 : facing === 'west' ? 270 : 0;
  } else if (name.endsWith('_bed')) {
    kind = 'bed'; texture = `minecraft:entity/bed/${name.slice(0, -4)}`;
    const head = properties.part === 'head', v = head ? 0 : 22;
    const mattress = entityCube([0, 3, 0], [16, 9, 16], [0, v]);
    // BedModel's mattress is authored as a 16x16x6 box rotated onto its back.
    const rect = (a, b, c, d, rotation = 0) => ({ texture: '#entity', uv: [a, b, c, d].map(n => n / 4), rotation });
    mattress.faces = { up: rect(6, v + 6, 22, v + 22), down: rect(28, v + 6, 44, v + 22), north: rect(6, v, 22, v + 6), south: rect(22, v + 6, 38, v), west: rect(0, v + 6, 6, v + 22, 90), east: rect(22, v + 6, 28, v + 22, 270) };
    delete mattress.faces[head ? 'south' : 'north'];
    const z = head ? 0 : 13;
    elements = [mattress, entityCube([0, 0, z], [3, 3, z + 3], [50, 0]), entityCube([13, 0, z], [16, 3, z + 3], [50, 6])];
    y = (yawFor(properties.facing) + 180) % 360;
  } else if (name.endsWith('_sign') && !name.includes('hanging')) {
    const wall = name.includes('_wall_');
    const wood = name.replace(/_(?:wall_)?(?:hanging_)?sign$/, '');
    kind = 'sign'; texture = `minecraft:entity/signs/${wood}`;
    const z = wall ? 1 : 22 / 3, Y = wall ? 4 : 28 / 3;
    elements = [entityCube([0, Y, z], [16, Y + 8, z + 4 / 3], [0, 0], [64, 32], [], [24, 12, 2])];
    if (!wall) elements.push(entityCube([22 / 3, 0, 22 / 3], [26 / 3, 28 / 3, 26 / 3], [0, 14], [64, 32], [], [2, 14, 2]));
    if (wall) y = yawFor(properties.facing); else freeY = Number(properties.rotation ?? 0) * 22.5;
  } else if (/(?:skeleton|wither_skeleton)_(?:wall_)?skull$|(?:zombie|creeper|player)_(?:wall_)?head$/.test(name)) {
    kind = 'skull'; const wall = name.includes('_wall_');
    texture = name.startsWith('wither_skeleton') ? 'minecraft:entity/skeleton/wither_skeleton' : name.startsWith('skeleton') ? 'minecraft:entity/skeleton/skeleton' : name.startsWith('zombie') ? 'minecraft:entity/zombie/zombie' : name.startsWith('creeper') ? 'minecraft:entity/creeper/creeper' : 'minecraft:entity/player/wide/steve';
    const sheet = name.startsWith('skeleton') || name.startsWith('wither_skeleton') ? [64, 32] : [64, 64];
    const headFrom = wall ? [4, 4, 8] : [4, 0, 4], headTo = wall ? [12, 12, 16] : [12, 8, 12];
    elements = [entityCube(headFrom, headTo, [0, 0], sheet)];
    // SkullModel.createHumanoidHeadLayer gives player heads their actual hat layer.
    if (name.startsWith('player_')) elements.push(entityCube(headFrom.map(v => v - .25), headTo.map(v => v + .25), [32, 0], sheet, [], [8, 8, 8]));
    if (wall) y = (yawFor(properties.facing) + 180) % 360; else { y = 180; freeY = Number(properties.rotation ?? 0) * 22.5; }
  } else if (name === 'piglin_head' || name === 'piglin_wall_head') {
    kind = 'piglin skull'; texture = 'minecraft:entity/piglin/piglin';
    const wall = name.includes('_wall_'), delta = wall ? [0, 4, 4] : [0, 0, 0];
    const cube = (from, to, uv) => entityCube(from.map((n, i) => n + delta[i]), to.map((n, i) => n + delta[i]), uv);
    elements = [cube([3, 0, 4], [13, 8, 12], [0, 0]), cube([6, 0, 3], [10, 4, 4], [31, 1]), cube([6, 0, 2], [7, 2, 3], [2, 4]), cube([9, 0, 2], [10, 2, 3], [2, 0])];
    for (const [from, to, origin, angle] of [[[2, 2, 5], [3, 7, 9], [3, 6, 7], -30], [[13, 2, 5], [14, 7, 9], [13, 6, 7], 30]]) {
      const ear = cube(from, to, [51, 6]); ear.rotation = { axis: 'z', origin: origin.map((n, i) => n + delta[i]), angle }; elements.push(ear);
    }
    if (wall) y = (yawFor(properties.facing) + 180) % 360; else { y = 180; freeY = Number(properties.rotation ?? 0) * 22.5; }
  } else if (name === 'dragon_head' || name === 'dragon_wall_head') {
    kind = 'dragon skull'; texture = 'minecraft:entity/enderdragon/dragon';
    const wall = name.includes('_wall_'), shift = wall ? [0, 4, 4] : [0, 0, 0];
    const cube = (from, to, uv) => {
      const size = to.map((n, i) => n - from[i]);
      return entityCube(from.map((n, i) => n * .75 + (i === 1 ? 0 : 2) + shift[i]), to.map((n, i) => n * .75 + (i === 1 ? 0 : 2) + shift[i]), uv, [256, 256], [], size);
    };
    elements = [cube([0, 0, 0], [16, 16, 16], [112, 30]), cube([2, 4, -14], [14, 9, 2], [176, 44]), cube([2, 0, -14], [14, 4, 2], [176, 65]), cube([3, 16, 6], [5, 20, 12], [0, 0]), cube([11, 16, 6], [13, 20, 12], [0, 0]), cube([3, 9, -12], [5, 11, -8], [112, 0]), cube([11, 9, -12], [13, 11, -8], [112, 0])];
    if (wall) y = (yawFor(properties.facing) + 180) % 360; else { y = 180; freeY = Number(properties.rotation ?? 0) * 22.5; }
  } else if (name.endsWith('_banner')) {
    kind = 'banner'; texture = 'minecraft:entity/banner_base';
    const wall = name.includes('_wall_'), color = name.replace(/_(?:wall_)?banner$/, ''), tint = dyeColors[color] ?? [1, 1, 1];
    elements = [entityCube([1, 0, wall ? 1 : 7], [15, 28, wall ? 2 : 8], [0, 0], [64, 64], [], [20, 40, 1], tint), entityCube([0, 27, 6], [16, 29, 8], [0, 42], [64, 64])];
    if (!wall) elements.push(entityCube([7, 0, 7], [9, 29, 9], [44, 0], [64, 64], [], [2, 42, 2]));
    if (wall) y = yawFor(properties.facing); else freeY = Number(properties.rotation ?? 0) * 22.5;
  } else if (name === 'conduit') {
    kind = 'conduit'; texture = 'minecraft:entity/conduit/base';
    elements = [entityCube([5, 5, 5], [11, 11, 11], [0, 0], [32, 16])];
  } else if (name === 'decorated_pot') {
    kind = 'decorated pot'; texture = 'minecraft:entity/decorated_pot/decorated_pot_base';
    const side = 'minecraft:entity/decorated_pot/decorated_pot_side';
    if (!tileByName.has(side)) return null;
    additionalTextures.side = side;
    const body = { from: [1, 0, 1], to: [15, 16, 15], faces: Object.fromEntries(['north', 'south', 'west', 'east'].map(face => [face, { texture: '#side', uv: [1, 0, 15, 16] }])) };
    const neck = entityCube([4.1, 17.1, 4.1], [11.9, 19.9, 11.9], [0, 0], [32, 32], [], [8, 3, 8]);
    const rim = entityCube([4.8, 19.8, 4.8], [11.2, 21.2, 11.2], [0, 5], [32, 32], [], [6, 1, 6]);
    for (const part of [neck, rim]) part.rotation = { axis: 'x', angle: 180, origin: [0, 18.5, 8] };
    elements = [body, neck, rim, entityCube([1, 16, 1], [15, 16, 15], [-14, 13], [32, 32]), entityCube([1, 0, 1], [15, 0, 15], [-14, 13], [32, 32])];
    y = (yawFor(properties.facing) + 180) % 360;
  } else if (name === 'end_portal' || name === 'end_gateway') {
    kind = 'portal'; texture = name === 'end_gateway' ? 'minecraft:entity/end_gateway_portal' : 'minecraft:entity/end_portal';
    elements = [{ from: name === 'end_portal' ? [0, 6, 0] : [0, 0, 0], to: name === 'end_portal' ? [16, 12, 16] : [16, 16, 16], faces: Object.fromEntries((name === 'end_portal' ? ['up', 'down'] : FACE_NAMES).map(face => [face, { texture: '#entity', uv: [0, 0, 16, 16], ...(name === 'end_gateway' ? { cullface: face } : {}) }])) }];
  }
  if (!elements || !tileByName.has(texture)) return null;
  return { kind, model: { namespace: 'minecraft', name: `browser_static/${name}`, textures: { entity: texture, ...additionalTextures }, elements, hasElements: true }, x, y, freeY };
}

/** Import user-supplied Java assets. This module ships no Mojang textures. */
export async function loadResourcePack(input, { registry, tileSize = 16, maxPackBytes = 256 * 1024 * 1024, maxInflatedBytes = 256 * 1024 * 1024, maxAnimatedBytes = 64 * 1024 * 1024, maxDecodedTextureBytes = 256 * 1024 * 1024 } = {}) {
  if (!Number.isInteger(tileSize) || tileSize < 8 || tileSize > 256) throw new Error('Invalid atlas tile size');
  const inputs = Array.isArray(input) ? input : [input];
  if (!inputs.length || inputs.length > 64) throw new Error('Resource pack stacks require between one and 64 packs');
  let inflated = 0, packedBytes = 0; const files = new Map(), fontSources = new Map(), soundNamespaces = new Map(), languages = new Map();
  for (const source of inputs) {
    const bytes = source instanceof Uint8Array ? source : source instanceof ArrayBuffer ? new Uint8Array(source) : new Uint8Array(await source.arrayBuffer());
    if ((packedBytes += bytes.length) > maxPackBytes) throw new Error('Resource pack stack exceeds the file size limit');
    const archive = unzipSync(bytes, { filter(entry) {
      const wanted = /(?:^|\/)assets\/[a-z0-9_.-]+\/(?:blockstates\/.*\.json|models\/.*\.json|font\/.*\.json|lang\/[a-z0-9_.-]+\.json|particles\/.*\.json|sounds\.json|sounds\/.*\.ogg|textures\/(?:(?:block|colormap|entity|font|item|particle|environment|map)\/.*|gui\/sprites\/map\/decorations\/[^/]+)\.png(?:\.mcmeta)?)$/.test(entry.name) || /(?:^|\/)data\/[a-z0-9_.-]+\/worldgen\/biome\/[a-z0-9_./-]+\.json$/.test(entry.name);
      if (!wanted) return false;
      if (entry.name.split('/').includes('..') || entry.originalSize > 32 * 1024 * 1024 || (inflated += entry.originalSize) > maxInflatedBytes) throw new Error('Resource archive exceeds its safe asset limits');
      return true;
    } });
    for (const [name, data] of Object.entries(archive)) {
      const start = name.indexOf('assets/') >= 0 ? name.indexOf('assets/') : name.indexOf('data/'), path = name.slice(start), sounds = /^assets\/([^/]+)\/sounds\.json$/.exec(path);
      if (sounds) {
        let definition; try { definition = JSON.parse(encoder.decode(data)); } catch { throw new Error(`Invalid asset JSON: ${path}`); }
        if (!definition || typeof definition !== 'object' || Array.isArray(definition)) throw new Error(`Invalid sound definition: ${path}`);
        const combined = soundNamespaces.get(sounds[1]) ?? Object.create(null);
        for (const [event, value] of Object.entries(definition)) {
          if (!value || typeof value !== 'object' || Array.isArray(value) || !Array.isArray(value.sounds ?? [])) throw new Error(`Invalid sound event: ${event}`);
          const previous = combined[event]; combined[event] = previous && !value.replace ? { ...previous, ...value, sounds: [...(previous.sounds ?? []), ...(value.sounds ?? [])] } : value;
        }
        soundNamespaces.set(sounds[1], combined);
      }
      const language = /^assets\/([^/]+)\/lang\/([a-z0-9_.-]+)\.json$/.exec(path);
      if (language) {
        let definition; try { definition = JSON.parse(encoder.decode(data)); } catch { throw new Error(`Invalid language JSON: ${path}`); }
        if (!definition || typeof definition !== 'object' || Array.isArray(definition)) throw new Error(`Invalid language definition: ${path}`);
        const combined = languages.get(language[2]) ?? Object.create(null);
        for (const [key, value] of Object.entries(definition)) if (typeof value === 'string') combined[key] = value;
        languages.set(language[2], combined);
      }
      if (/^assets\/[^/]+\/font\/.+\.json$/.test(path)) {
        const stack = fontSources.get(path) ?? [];
        stack.push(data); fontSources.set(path, stack);
      }
      files.set(path, data);
    }
  }
  for (const [namespace, definitions] of soundNamespaces) files.set(`assets/${namespace}/sounds.json`, new TextEncoder().encode(JSON.stringify(definitions)));
  if (!files.size) throw new Error('No Minecraft Java block assets found in the ZIP/JAR');
  const diagnostics = { files: files.size, textures: 0, models: 0, supportedStates: 0, unsupportedStates: 0, missingTextures: [], unsupportedModels: [], warnings: [], animatedTextures: 0, animatedBytes: 0, randomVariants: 0, uniqueMaterialModels: 0, exactCollisionStates: 0, staticBlockEntityStates: 0, staticBlockEntityKinds: [], limitations: ['Unknown biome neighbors use a plains fallback until their native biome arrays arrive.', 'Far block-entity models retain static approximations; nearby animations, text, patterns and profiles require their native block-entity data.'] };
  const jsonCache = new Map(), modelCache = new Map();
  function json(path) {
    if (jsonCache.has(path)) return jsonCache.get(path);
    const data = files.get(path);
    if (!data) return null;
    let result;
    try { result = JSON.parse(encoder.decode(data)); }
    catch { throw new Error(`Invalid asset JSON: ${path}`); }
    if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error(`Invalid asset JSON object: ${path}`);
    jsonCache.set(path, result); return result;
  }
  function model(name, stack = []) {
    name = qualify(name);
    if (modelCache.has(name)) return modelCache.get(name);
    if (stack.includes(name) || stack.length > 32) throw new Error(`Cyclic or overly deep model inheritance: ${name}`);
    const own = json(`${pathFor(name, 'models')}.json`);
    if (!own) return null;
    const namespace = name.split(':')[0];
    const parent = own.parent && !own.parent.startsWith('builtin/') ? model(qualify(own.parent, namespace), [...stack, name]) : null;
    const merged = { ...parent, ...own, textures: { ...parent?.textures, ...own.textures }, elements: own.elements ?? parent?.elements ?? [], hasElements: Object.hasOwn(own, 'elements') || !!parent?.hasElements, builtin: own.parent?.startsWith('builtin/') || !!parent?.builtin, namespace, name };
    modelCache.set(name, merged); return merged;
  }
  const textureImages = new Map();
  // Magenta fallback remains explicit and visible when an asset cannot be reproduced.
  const checker = new Uint8Array(tileSize * tileSize * 4);
  for (let y = 0; y < tileSize; y++) for (let x = 0; x < tileSize; x++) checker.set(((x >> 2) + (y >> 2)) % 2 ? [25, 25, 25, 255] : [240, 0, 240, 255], (y * tileSize + x) * 4);
  textureImages.set('__missing__', { width: tileSize, height: tileSize, pixelsRGBA: checker });
  let decodedTextureBytes = checker.length;
  for (const [path, data] of [...files].sort(([a], [b]) => a.localeCompare(b))) {
    const match = /^assets\/([^/]+)\/textures\/(block|entity|font|item|particle|environment|map|gui)\/(.+)\.png$/.exec(path);
    if (!match) continue;
    if (textureImages.size >= 65536) throw new Error('Texture atlas exceeds the tile count limit');
    if (data.length >= 24) {
      const header = new DataView(data.buffer, data.byteOffset, data.byteLength);
      if (decodedTextureBytes + header.getUint32(16) * header.getUint32(20) * 4 > maxDecodedTextureBytes) throw new Error('Decoded resource textures exceed the memory limit');
    }
    try {
      const image = decodePNG(data);
      decodedTextureBytes += image.pixelsRGBA.length;
      const entity = match[2] === 'entity';
      image.entity = entity;
      image.kind = match[2];
      const metadata = files.get(`${path}.mcmeta`);
      if (metadata) {
        try { image.animation = textureAnimation(image, JSON.parse(encoder.decode(metadata))); }
        catch (error) { diagnostics.warnings.push(`${path}.mcmeta: ${error.message}`); }
      }
      if (image.animation) diagnostics.animatedTextures++;
      textureImages.set(`${match[1]}:${match[2]}/${match[3]}`, image);
    } catch (error) { diagnostics.warnings.push(`${path}: ${error.message}`); }
  }
  const dimensions = image => {
    const frame = image.animation?.rect(image.animation.sequence[0].index);
    return image.kind === 'font' || image.kind === 'map' || image.kind === 'gui' ? [frame?.width ?? image.width, frame?.height ?? image.height] : image.entity || image.kind === 'environment' || image.kind === 'item' ? [Math.min(256, frame?.width ?? image.width), Math.min(256, frame?.height ?? image.height)] : [tileSize, tileSize];
  };
  const area = [...textureImages.values()].reduce((sum, image) => { const [w, h] = dimensions(image); return sum + (w + 2) * (h + 2); }, 0);
  const width = powerOfTwo(Math.max(Math.sqrt(area), ...[...textureImages.values()].map(image => dimensions(image)[0] + 2)));
  const placements = new Map(); let shelfX = 0, shelfY = 0, shelfHeight = 0;
  const packingOrder = [...textureImages].sort(([a, first], [b, second]) => dimensions(second)[1] - dimensions(first)[1] || dimensions(second)[0] - dimensions(first)[0] || a.localeCompare(b));
  for (const [name, image] of packingOrder) {
    const [w, h] = dimensions(image);
    if (shelfX + w + 2 > width) { shelfY += shelfHeight; shelfX = 0; shelfHeight = 0; }
    placements.set(name, { x: shelfX + 1, y: shelfY + 1, width: w, height: h });
    shelfX += w + 2; shelfHeight = Math.max(shelfHeight, h + 2);
  }
  const height = powerOfTwo(shelfY + shelfHeight);
  if (width > 8192 || height > 8192) throw new Error('Texture atlas exceeds WebGPU texture limits');
  const pixelsRGBA = new Uint8Array(width * height * 4), tiles = [], tileByName = new Map(), entityTiles = new Map(), itemTiles = new Map(), particleTiles = new Map(), weatherTiles = new Map(), particleFrames = new Map(), fontGlyphs = new Map(), animations = [];
  for (const [name, image] of textureImages) {
    const id = tiles.length, { x, y, width: tileWidth, height: tileHeight } = placements.get(name);
    const frame = image.animation?.rect(image.animation.sequence[0].index) ?? { x: 0, y: 0, width: image.width, height: image.height };
    let translucent = false, cutout = false;
    const colorSum = [0, 0, 0]; let colorSamples = 0;
    for (let dy = -1; dy <= tileHeight; dy++) for (let dx = -1; dx <= tileWidth; dx++) {
      const sx = Math.min(frame.width - 1, Math.floor(Math.max(0, Math.min(tileWidth - 1, dx)) / tileWidth * frame.width));
      const sy = Math.min(frame.height - 1, Math.floor(Math.max(0, Math.min(tileHeight - 1, dy)) / tileHeight * frame.height));
      const source = ((sy + frame.y) * image.width + sx + frame.x) * 4, dest = ((y + dy) * width + x + dx) * 4;
      pixelsRGBA.set(image.pixelsRGBA.subarray(source, source + 4), dest);
      if (dx >= 0 && dx < tileWidth && dy >= 0 && dy < tileHeight) {
        const alpha = image.pixelsRGBA[source + 3];
        if (alpha === 0) cutout = true; else if (alpha < 255) translucent = true;
        if (alpha > 127) { for (let c = 0; c < 3; c++) colorSum[c] += image.pixelsRGBA[source + c] / 255; colorSamples++; }
      }
    }
    tiles.push({ id, name, x, y, width: tileWidth, height: tileHeight, cutout, translucent, averageColor: colorSum.map(n => colorSamples ? n / colorSamples : 1) }); tileByName.set(name, id);
    if (image.entity) entityTiles.set(name, id);
    if (image.kind === 'item') itemTiles.set(name, id);
    if (image.kind === 'particle') particleTiles.set(name, id);
    if (image.kind === 'environment') weatherTiles.set(name, id);
    if (image.animation) {
      const cache = new Map();
      for (const { index } of image.animation.sequence) {
        if (cache.has(index)) continue;
        const needed = tileWidth * tileHeight * 4;
        if (diagnostics.animatedBytes + needed > maxAnimatedBytes) throw new Error('Animated texture frames exceed the memory limit');
        diagnostics.animatedBytes += needed;
        const rect = image.animation.rect(index), pixels = new Uint8Array(needed);
        for (let yy = 0; yy < tileHeight; yy++) for (let xx = 0; xx < tileWidth; xx++) {
          const source = ((rect.y + Math.floor(yy / tileHeight * rect.height)) * image.width + rect.x + Math.floor(xx / tileWidth * rect.width)) * 4;
          pixels.set(image.pixelsRGBA.subarray(source, source + 4), (yy * tileWidth + xx) * 4);
        }
        cache.set(index, pixels);
      }
      animations.push({ tile: id, width: tileWidth, height: tileHeight, frames: image.animation.sequence.map(({ index }) => cache.get(index)), durationsTicks: image.animation.sequence.map(({ duration }) => duration), interpolate: image.animation.interpolate });
    }
  }
  // 26.1 moved the native portal sheet into its own entity directory. Keep the
  // canonical model reference on the actual imported tile, without a pixel copy
  // or loss of its animation metadata; older pack entries retain precedence.
  const calendarPortal = tileByName.get('minecraft:entity/end_portal/end_portal');
  if (!tileByName.has('minecraft:entity/end_portal') && calendarPortal !== undefined) {
    tileByName.set('minecraft:entity/end_portal', calendarPortal); entityTiles.set('minecraft:entity/end_portal', calendarPortal);
  }
  const portalId = tileByName.get('minecraft:entity/end_portal'), portalSkyTile = tileByName.get('minecraft:environment/end_sky');
  if (portalId !== undefined) {
    const portal = tiles[portalId]; portal.portalLayers = 15; portal.portalSkyTile = portalSkyTile ?? -1;
    const name = 'minecraft:entity/end_gateway_portal', id = tiles.length;
    tiles.push({ ...portal, id, name, portalLayers: 16, aliasOf: portalId }); tileByName.set(name, id); entityTiles.set(name, id);
  }
  let fontProviderVisits = 0;
  const fontDefinitionCache = new Map();
  function* fontProviders(name, stack = []) {
    if (++fontProviderVisits > 65536) throw new Error('Font references exceed the provider traversal limit');
    name = qualify(name);
    if (stack.includes(name) || stack.length > 32) throw new Error('Cyclic or overly deep font reference');
    const path = `${pathFor(name, 'font')}.json`, sources = fontSources.get(path);
    if (!sources) return;
    const nested = [...stack, name];
    // Native font definitions merge provider lists across packs. Higher packs
    // get the first opportunity to supply a glyph; every lower pack can fill
    // missing glyphs, including through referenced font definitions.
    for (let source = sources.length - 1; source >= 0; source--) {
      if (++fontProviderVisits > 65536) throw new Error('Font references exceed the provider traversal limit');
      let definition = fontDefinitionCache.get(sources[source]);
      if (!definition) {
        try { definition = JSON.parse(encoder.decode(sources[source])); }
        catch { throw new Error(`Invalid asset JSON: ${path}`); }
        if (!definition || typeof definition !== 'object' || Array.isArray(definition)) throw new Error(`Invalid asset JSON object: ${path}`);
        if (!Array.isArray(definition.providers) || definition.providers.length > 1024) throw new Error('Invalid font providers');
        fontDefinitionCache.set(sources[source], definition);
      }
      for (const provider of definition.providers) {
        if (++fontProviderVisits > 65536) throw new Error('Font references exceed the provider traversal limit');
        if (provider.type === 'reference') yield* fontProviders(provider.id, nested);
        else yield provider;
      }
    }
  }
  for (const provider of fontProviders('minecraft:default')) {
    if (provider.type === 'space') {
      for (const [character, advance] of Object.entries(provider.advances ?? {})) if (Number.isFinite(advance) && !fontGlyphs.has(character)) fontGlyphs.set(character, { tile: -1, advance, width: 0, height: 0, ascent: 0 });
    } else if (provider.type === 'bitmap') {
      const name = qualify(provider.file?.replace(/\.png$/, '') ?? ''), image = textureImages.get(name), tile = tileByName.get(name);
      const rows = provider.chars?.map(row => Array.from(row));
      if (!image || tile === undefined || !rows?.length) continue;
      const columns = rows[0].length, cellWidth = image.width / columns, cellHeight = image.height / rows.length, nominalHeight = provider.height ?? 8;
      if (!columns || rows.some(row => row.length !== columns) || !Number.isInteger(cellWidth) || !Number.isInteger(cellHeight) || !Number.isFinite(nominalHeight) || nominalHeight <= 0 || nominalHeight > 256 || !Number.isFinite(provider.ascent)) throw new Error('Invalid bitmap font grid');
      for (let row = 0; row < rows.length; row++) for (let column = 0; column < columns; column++) {
        const character = rows[row][column]; if (character === '\0' || fontGlyphs.has(character)) continue;
        let inkWidth = 0;
        for (let y = 0; y < cellHeight; y++) for (let x = cellWidth - 1; x >= inkWidth; x--) if (image.pixelsRGBA[((row * cellHeight + y) * image.width + column * cellWidth + x) * 4 + 3]) { inkWidth = x + 1; break; }
        const glyphWidth = inkWidth * nominalHeight / cellHeight;
        fontGlyphs.set(character, { tile, uv: [column / columns, row / rows.length, (column * cellWidth + inkWidth) / image.width, (row + 1) / rows.length], width: glyphWidth, height: nominalHeight, advance: Math.floor(glyphWidth + 0.5) + 1, ascent: provider.ascent });
        if (fontGlyphs.size > 65536) throw new Error('Font exceeds the glyph count limit');
      }
    }
  }
  const audioFiles = new Map(), sounds = new Map(), itemModels = new Map(), blockModels = new Map();
  for (const [path, data] of files) {
    const audio = /^assets\/([^/]+)\/sounds\/(.+)\.ogg$/.exec(path);
    if (audio) audioFiles.set(path, data);
    const soundDefinition = /^assets\/([^/]+)\/sounds\.json$/.exec(path);
    if (soundDefinition) { audioFiles.set(path, data); sounds.set(soundDefinition[1], json(path)); }
    const particle = /^assets\/([^/]+)\/particles\/(.+)\.json$/.exec(path);
    if (particle) {
      const names = json(path)?.textures;
      if (Array.isArray(names) && names.length <= 1024) particleFrames.set(`${particle[1]}:${particle[2]}`, names.map(name => tileByName.get(qualify(name, particle[1]))).filter(id => id !== undefined));
    }
    const item = /^assets\/([^/]+)\/models\/item\/(.+)\.json$/.exec(path);
    if (item) itemModels.set(`${item[1]}:${item[2]}`, json(path));
    const blockModel = /^assets\/([^/]+)\/models\/block\/(.+)\.json$/.exec(path);
    if (blockModel) blockModels.set(`${blockModel[1]}:block/${blockModel[2]}`, json(path));
  }
  diagnostics.textures = tiles.length - 1;
  function texture(name, merged) {
    let current = name, visited = new Set();
    while (current?.startsWith('#')) {
      if (visited.has(current)) throw new Error('Cyclic model texture reference');
      visited.add(current); current = merged.textures?.[current.slice(1)];
    }
    const resolved = current ? qualify(current, merged.namespace) : '__missing__';
    const tile = tileByName.get(resolved);
    if (tile === undefined && !diagnostics.missingTextures.includes(resolved)) diagnostics.missingTextures.push(resolved);
    return tile ?? 0;
  }
  const colormaps = {}, biomeDefinitions = new Map();
  for (const type of ['grass', 'foliage']) {
    const data = files.get(`assets/minecraft/textures/colormap/${type}.png`);
    if (data) try { colormaps[type] = decodePNG(data); } catch (error) { diagnostics.warnings.push(`${type} colormap: ${error.message}`); }
  }
  for (const path of files.keys()) { const match = /^data\/([^/]+)\/worldgen\/biome\/(.+)\.json$/.exec(path); if (match) biomeDefinitions.set(`${match[1]}:${match[2]}`, json(path)); }
  const stateRegistry = registry?.lookup ? registry : registryStates(registry);
  if (!stateRegistry.byId.size) throw new Error('A native Minecraft block state registry is required');
  const materials = new Map(), materialCache = new Map();
  for (const state of stateRegistry.byId.values()) {
    const name = state.name, bare = name.split(':')[1], block = state.block;
    const invisible = ['air', 'cave_air', 'void_air', 'structure_void', 'barrier', 'light'].includes(bare);
    const fluid = bare === 'water' || bare === 'lava' || bare === 'bubble_column';
    const contained = nativeContainedFluid(bare, state.properties);
    const liquidName = contained?.kind === 2 ? 'lava' : 'water';
    const fluidState = contained ? { ...contained,
      stillTile: tileByName.get(`minecraft:block/${liquidName}_still`) ?? 0,
      flowTile: tileByName.get(`minecraft:block/${liquidName}_flow`) ?? tileByName.get(`minecraft:block/${liquidName}_still`) ?? 0 } : null;
    const vegetation = /(?:leaves|log|wood|stem|hyphae|sapling|grass|fern|flower|vine|mushroom|roots|bush)$/.test(bare);
    const shapeRefs = stateRegistry.collisionShapes?.blocks?.[bare];
    const shapeId = Array.isArray(shapeRefs) ? shapeRefs[state.id - block.minStateId] : shapeRefs;
    const exactBoxes = shapeId !== undefined ? stateRegistry.collisionShapes?.shapes?.[shapeId] : undefined;
    if (exactBoxes) diagnostics.exactCollisionStates++;
    let flags = exactBoxes ? (exactBoxes.length ? MATERIAL_FLAGS.SOLID : 0) : (block.boundingBox === 'empty' || fluid ? 0 : MATERIAL_FLAGS.SOLID);
    if (invisible) flags |= MATERIAL_FLAGS.INVISIBLE;
    let emitLight = block.emitLight ?? 0;
    if (state.properties.lit === 'false' || (bare === 'sea_pickle' && state.properties.waterlogged === 'false') || (bare === 'respawn_anchor' && state.properties.charges === '0')) emitLight = 0;
    if (bare === 'light') emitLight = Number(state.properties.level ?? emitLight);
    if (fluid) flags |= MATERIAL_FLAGS.FLUID;
    if (bare === 'lava' || emitLight > 0) flags |= MATERIAL_FLAGS.EMISSIVE;
    if (vegetation) flags |= MATERIAL_FLAGS.HEIGHT_IGNORED;
    const faces = Object.create(null), quads = [], collisionBoxes = [], vertices = [], templateTintKinds = [], parts = [];
    let supported = invisible || fluid, fullCube = false, unsupportedReason = null, particleTile = null;
    const blockState = json(`${pathFor(name, 'blockstates')}.json`);
    let variants = blockState && !invisible && !fluid ? selectVariants(blockState, state.properties) : [];
    const entityForm = !invisible && !fluid ? blockEntityModel(bare, state.properties, tileByName) : null;
    let emptyModels = !variants.length;
    if (entityForm && variants.length) {
      try {
        const sourceModels = variants.map(variant => model(qualify(variant.model, name.split(':')[0])));
        emptyModels = sourceModels.every(source => !source?.elements?.length);
        // Native entity-rendered block models still define their breaking
        // texture. Resolve inherited aliases and pack overrides before the
        // static form replaces their otherwise empty geometry.
        const particleSource = emptyModels && sourceModels.find(source => source?.textures?.particle !== undefined);
        if (particleSource) particleTile = texture('#particle', particleSource);
      }
      catch { emptyModels = false; } // The ordinary model loop reports malformed overrides.
    }
    if (entityForm && emptyModels) {
      variants = [{ model: entityForm.model.name, x: entityForm.x, y: entityForm.y, _freeY: entityForm.freeY, _model: entityForm.model, _entityKind: entityForm.kind }];
      diagnostics.staticBlockEntityStates++;
      if (!diagnostics.staticBlockEntityKinds.includes(entityForm.kind)) diagnostics.staticBlockEntityKinds.push(entityForm.kind);
    }
    if (blockState?.multipart && !variants.length) supported = true; // A valid empty multipart state has no geometry.
    if (!invisible && !fluid && !variants.length && !blockState?.multipart) unsupportedReason = 'No matching blockstate model';
    if (blockState && Object.values(blockState.variants ?? {}).some(Array.isArray)) diagnostics.randomVariants++;
    const materialKey = `${name}|${flags}|${shapeId ?? ''}|${emitLight}|${particleTile ?? ''}|${state.properties.power ?? ''}|${state.properties.age ?? ''}|${state.properties.half ?? ''}|${JSON.stringify(fluidState)}|${JSON.stringify(variants)}`;
    const cachedMaterial = materialCache.get(materialKey);
    if (cachedMaterial) {
      if (cachedMaterial.unsupported) diagnostics.unsupportedStates++; else diagnostics.supportedStates++;
      materials.set(state.id, { ...cachedMaterial, id: state.id, properties: state.properties });
      continue;
    }
    for (const variant of variants) {
      try {
        if (!variant?.model) throw new Error('Blockstate entry has no model');
        const merged = variant._model ?? model(qualify(variant.model, name.split(':')[0]));
        if (!merged) throw new Error(`Missing model: ${variant.model}`);
        if (variant._entityKind && entityForm?.vertices) {
          particleTile ??= tileByName.get(merged.textures.entity);
          const firstVertex = vertices.length / 14;
          for (let i = 0; i < entityForm.vertices.length; i += 14) {
            const vertex = entityForm.vertices.subarray(i, i + 14);
            const position = rotate([...vertex.subarray(0, 3)], 'y', -(variant.y ?? 0) - (variant._freeY ?? 0));
            const normal = rotate([...vertex.subarray(3, 6)], 'y', -(variant.y ?? 0) - (variant._freeY ?? 0), [0, 0, 0]);
            vertices.push(...position, ...normal, ...vertex.subarray(6)); templateTintKinds.push(0);
          }
          if (entityForm.parts) parts.push(...entityForm.parts.map(part => ({ ...part, firstVertex: firstVertex + part.firstVertex })));
          else parts.push({ firstVertex, vertexCount: vertices.length / 14 - firstVertex });
          flags |= MATERIAL_FLAGS.CUTOUT;
          supported = true; continue;
        }
        if (merged.textures?.particle !== undefined) particleTile ??= texture('#particle', merged);
        if (!merged.elements.length) {
          if (/block\/pitcher_crop_top_stage_[012]$/.test(merged.name)) { supported = true; continue; }
          if (merged.builtin || !merged.hasElements) throw new Error(`Unsupported builtin or entity-rendered model: ${variant.model}`);
          supported = true; continue; // Empty crop/air models are intentional.
        }
        if (merged.elements.length > 256) throw new Error('Model exceeds the element limit');
        const stateX = variant.x ?? 0, stateY = variant.y ?? 0;
        if (![0, 90, 180, 270].includes(stateX) || ![0, 90, 180, 270].includes(stateY)) throw new Error('Invalid blockstate rotation');
        const transform = p => rotate(rotate(p, 'x', -stateX), 'y', -stateY - (variant._freeY ?? 0));
        for (const element of merged.elements) {
          const firstVertex = vertices.length / 14;
          if (!Array.isArray(element.from) || !Array.isArray(element.to) || element.from.length !== 3 || element.to.length !== 3 || ![...element.from, ...element.to].every(Number.isFinite)) throw new Error('Invalid model element bounds');
          const from = element.from.map(n => n / 16), to = element.to.map(n => n / 16);
          const rotation = element.rotation;
          if (rotation && (!['x', 'y', 'z'].includes(rotation.axis) || (variant._entityKind ? !Number.isFinite(rotation.angle) || Math.abs(rotation.angle) > 180 : ![-45, -22.5, 0, 22.5, 45].includes(rotation.angle)) || !Array.isArray(rotation.origin))) throw new Error('Invalid model element rotation');
          const local = p => {
            if (!rotation) return p;
            let result = rotate(p, rotation.axis, rotation.angle, rotation.origin.map(n => n / 16));
            if (rotation.rescale) { const scale = 1 / Math.cos(rotation.angle * Math.PI / 180), axis = 'xyz'.indexOf(rotation.axis); result = result.map((n, i) => i === axis ? n : (n - rotation.origin[i] / 16) * scale + rotation.origin[i] / 16); }
            return result;
          };
          const boxPoints = [from[0], to[0]].flatMap(x => [from[1], to[1]].flatMap(y => [from[2], to[2]].map(z => transform(local([x, y, z])))));
          if (flags & MATERIAL_FLAGS.SOLID) collisionBoxes.push([...Array.from({ length: 3 }, (_, i) => Math.min(...boxPoints.map(p => p[i]))), ...Array.from({ length: 3 }, (_, i) => Math.max(...boxPoints.map(p => p[i])))]);
          for (const [face, descriptor] of Object.entries(element.faces ?? {})) {
            if (!FACE_NAMES.includes(face)) throw new Error('Invalid model face');
            const positions = corners(from, to, face).map(p => transform(local(p)));
            const a = positions[1].map((n, i) => n - positions[0][i]), b = positions[2].map((n, i) => n - positions[0][i]);
            let normal = [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
            const length = Math.hypot(...normal); if (length < 1e-10) continue; normal = normal.map(n => n / length);
            const rotatedFace = FACE_NAMES.find(name => normalFor[name].every((n, i) => Math.abs(n - normal[i]) < 1e-6));
            const uv = descriptor.uv ? descriptor.uv.map(n => n / 16) : defaultUV(from, to, face);
            if (uv.length !== 4 || !uv.every(Number.isFinite)) throw new Error('Invalid model face UV');
            const angle = descriptor.rotation ?? 0;
            if (![0, 90, 180, 270].includes(angle)) throw new Error('Invalid model UV rotation');
            const tile = texture(descriptor.texture, merged);
            const coloring = nativeBlockTint(bare, state.properties, descriptor.tintindex), tint = descriptor.staticTint ?? coloring.tint, tintKind = descriptor.staticTint ? 0 : coloring.tintKind;
            const coordinates = [[uv[0], uv[3]], [uv[2], uv[3]], [uv[2], uv[1]], [uv[0], uv[1]]];
            const uvs = coordinates.map((_, i) => coordinates[(i + angle / 90) % 4]);
            if (variant.uvlock && rotatedFace && (stateX || stateY)) {
              // World-oriented UV projection keeps rotated log/stone axes locked.
              for (let i = 0; i < 4; i++) {
                const [x, y, z] = positions[i];
                const projected = ({ east: [1 - z, 1 - y], west: [z, 1 - y], up: [x, z], down: [x, 1 - z], south: [x, 1 - y], north: [1 - x, 1 - y] })[rotatedFace];
                const [u, v] = projected;
                const locked = angle === 90 ? [v, 1 - u] : angle === 180 ? [1 - u, 1 - v] : angle === 270 ? [1 - v, u] : [u, v];
                uvs[i] = [uv[0] + locked[0] * (uv[2] - uv[0]), uv[1] + locked[1] * (uv[3] - uv[1])];
              }
            }
            let faceRotation = angle;
            if (rotatedFace && !rotation) {
              const min = Array.from({ length: 3 }, (_, axis) => Math.min(...positions.map(p => p[axis])));
              const max = Array.from({ length: 3 }, (_, axis) => Math.max(...positions.map(p => p[axis])));
              const canonicalFirst = corners(min, max, rotatedFace)[0];
              const firstIndex = positions.findIndex(p => p.every((n, axis) => Math.abs(n - canonicalFirst[axis]) < 1e-6));
              const coordinateIndex = firstIndex >= 0 ? coordinates.findIndex(p => p.every((n, axis) => Math.abs(n - uvs[firstIndex][axis]) < 1e-6)) : -1;
              if (coordinateIndex >= 0) faceRotation = coordinateIndex * 90;
            }
            let cullface = null;
            if (descriptor.cullface) {
              // Direction.byName returns null for unknown values in Java.
              // Vanilla scaffolding itself uses "bottom" in four descriptors.
              if (normalFor[descriptor.cullface]) {
                const cullNormal = rotate(rotate(normalFor[descriptor.cullface], 'x', -stateX, [0, 0, 0]), 'y', -stateY - (variant._freeY ?? 0), [0, 0, 0]);
                cullface = FACE_NAMES.find(face => normalFor[face].every((n, i) => Math.abs(n - cullNormal[i]) < 1e-6)) ?? null;
              }
            }
            const metadata = { tile, uv, rotation: faceRotation, tint, tintIndex: descriptor.tintindex ?? null, tintKind, cullface, positions, uvs, normal };
            quads.push(metadata);
            if (rotatedFace) faces[rotatedFace] = metadata;
            const cullBits = cullface ? (FACE_NAMES.indexOf(cullface) + 1) << 18 : 0;
            for (const i of [0, 1, 2, 0, 2, 3]) { vertices.push(...positions[i], ...normal, ...tint, 1, ...uvs[i], tile, cullBits); templateTintKinds.push(tintKind); }
          }
          if (variant._entityKind) parts.push({ firstVertex, vertexCount: vertices.length / 14 - firstVertex });
        }
        supported = true;
        fullCube = variants.length === 1 && merged.elements.length === 1 && !merged.elements[0].rotation && merged.elements[0].from.every(n => n === 0) && merged.elements[0].to.every(n => n === 16) && Object.keys(faces).length === 6;
      } catch (error) { unsupportedReason = error.message; }
    }
    if (fluid) {
      const tile = tileByName.get(`minecraft:block/${liquidName}_still`) ?? 0;
      for (const face of FACE_NAMES) faces[face] = { tile, uv: [0, 0, 1, 1], rotation: 0, tint: [1, 1, 1], tintIndex: null, tintKind: liquidName === 'water' ? 3 : 0 };
    }
    const usedTiles = [...new Set(Object.values(faces).map(face => face.tile))].map(id => tiles[id]);
    if (usedTiles.some(tile => tile.cutout)) flags |= MATERIAL_FLAGS.CUTOUT;
    if (usedTiles.some(tile => tile.translucent) || bare === 'water' || bare === 'bubble_column' || /(?:glass|ice)$/.test(bare)) flags |= MATERIAL_FLAGS.BLEND;
    if (fullCube && !(flags & (MATERIAL_FLAGS.CUTOUT | MATERIAL_FLAGS.BLEND))) flags |= MATERIAL_FLAGS.AO_OPAQUE;
    // Grass's tinted overlay is cutout, but its underlying six opaque faces
    // still occlude neighbouring geometry and ambient light.
    const opaqueBoundaryFaces = new Set();
    for (const quad of quads) {
      if (tiles[quad.tile].cutout || tiles[quad.tile].translucent) continue;
      const face = FACE_NAMES.find(face => normalFor[face].every((n, i) => Math.abs(n - quad.normal[i]) < 1e-6));
      if (face && corners([0, 0, 0], [1, 1, 1], face).every(expected => quad.positions.some(p => p.every((n, i) => Math.abs(n - expected[i]) < 1e-6)))) opaqueBoundaryFaces.add(face);
    }
    if (opaqueBoundaryFaces.size === 6 && !(flags & MATERIAL_FLAGS.BLEND)) flags |= MATERIAL_FLAGS.AO_OPAQUE;
    if (variants[0]?._entityKind === 'shulker') flags |= MATERIAL_FLAGS.AO_OPAQUE;
    if (variants[0]?._entityKind === 'portal') { fullCube = false; flags = (flags & ~MATERIAL_FLAGS.AO_OPAQUE) | MATERIAL_FLAGS.EMISSIVE; }
    if (!fullCube && vertices.length) flags |= MATERIAL_FLAGS.CUSTOM_MODEL;
    if (bare === 'moving_piston') {
      flags |= MATERIAL_FLAGS.INVISIBLE;
      supported = false; unsupportedReason = 'Moving piston geometry requires its block entity blockState and progress';
    }
    if (!supported || unsupportedReason) {
      diagnostics.unsupportedStates++;
      if (!diagnostics.unsupportedModels.some(entry => entry.name === name && entry.reason === unsupportedReason)) diagnostics.unsupportedModels.push({ name, reason: unsupportedReason ?? 'Unsupported model' });
      if (!vertices.length && !invisible && bare !== 'moving_piston') {
        fullCube = true;
        for (const face of FACE_NAMES) faces[face] = { tile: 0, uv: [0, 0, 1, 1], rotation: 0, tint: [1, 1, 1] };
        if (flags & MATERIAL_FLAGS.SOLID) { flags |= MATERIAL_FLAGS.AO_OPAQUE; collisionBoxes.push([0, 0, 0, 1, 1, 1]); }
      }
    } else diagnostics.supportedStates++;
    if (exactBoxes) collisionBoxes.splice(0, collisionBoxes.length, ...exactBoxes.map(box => [...box]));
    else if (invisible && flags & MATERIAL_FLAGS.SOLID) collisionBoxes.push([0, 0, 0, 1, 1, 1]);
    if (supported && !vertices.length && !fluid) flags |= MATERIAL_FLAGS.INVISIBLE;
    const vertexFlags = flags | 512 | (15 << 10) | (Math.min(15, Math.max(0, emitLight)) << 14);
    for (let i = 13; i < vertices.length; i += 14) vertices[i] |= vertexFlags;
    const tintColor = faces.up?.tint ?? faces.east?.tint ?? [1, 1, 1];
    const material = { id: state.id, name, properties: state.properties, fluid: fluidState, color: tintColor, flags, faces, particleTile, fullCube, collisionBoxes, emitLight, opacity: block.filterLight, templateVertices: new Float32Array(vertices), templateTintKinds: new Uint8Array(templateTintKinds), model: { quads, parts, rotation: entityForm ? [entityForm.x, entityForm.y + entityForm.freeY, 0] : null, supported: supported && !unsupportedReason, reason: unsupportedReason, staticBlockEntity: variants[0]?._entityKind ?? null }, unsupported: !supported || !!unsupportedReason };
    materials.set(state.id, material); materialCache.set(materialKey, material);
  }
  diagnostics.models = modelCache.size;
  diagnostics.uniqueMaterialModels = materialCache.size;
  return { atlas: { pixelsRGBA, width, height, tileSize, padding: 1, tiles, tileByName, entityTiles, itemTiles, itemModels, blockModels, particleTiles, weatherTiles, particleFrames, fontGlyphs, animations, colormaps, biomeDefinitions }, materials, audioFiles, sounds, languages, diagnostics };
}
