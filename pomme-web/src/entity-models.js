import { ENTITY_MODELS } from './entity-model-data.js';
import { SPECIAL_ENTITY_MODELS } from './entity-special-model-data.js';

const MODEL_DEFINITIONS = { ...ENTITY_MODELS, ...SPECIAL_ENTITY_MODELS };

const TRIANGLES = [0, 1, 2, 0, 2, 3];
const CACHE = new Map();
const multiply = (a, b) => Array.from({ length: 9 }, (_, index) => {
  const row = Math.floor(index / 3), column = index % 3;
  return a[row * 3] * b[column] + a[row * 3 + 1] * b[3 + column] + a[row * 3 + 2] * b[6 + column];
});
function inverseTranspose(matrix) {
  const [a, b, c, d, e, f, g, h, i] = matrix;
  const cofactor = [e * i - f * h, f * g - d * i, d * h - e * g, c * h - b * i, a * i - c * g, b * g - a * h, b * f - c * e, c * d - a * f, a * e - b * d];
  const determinant = a * cofactor[0] + b * cofactor[1] + c * cofactor[2];
  return Math.abs(determinant) > 1e-12 ? cofactor.map(value => value / determinant) : matrix;
}
export const modelTransform = (point, matrix) => [0, 1, 2].map(axis => matrix[axis * 3] * point[0] + matrix[axis * 3 + 1] * point[1] + matrix[axis * 3 + 2] * point[2]);
function rotation([rx, ry, rz]) {
  const cx = Math.cos(rx), sx = Math.sin(rx), cy = Math.cos(ry), sy = Math.sin(ry), cz = Math.cos(rz), sz = Math.sin(rz);
  return [cz * cy, cz * sy * sx - sz * cx, cz * sy * cx + sz * sx, sz * cy, sz * sy * sx + cz * cx, sz * sy * cx - cz * sx, -sy, cy * sx, cy * cx];
}

export function bakeEntityCube(cube, sheet) {
  const [u, v] = cube.uv, [w, h, d] = cube.size, g = cube.inflate;
  let x0 = (cube.origin[0] - g) / 16, x1 = (cube.origin[0] + w + g) / 16;
  const y0 = -(cube.origin[1] - g) / 16, y1 = -(cube.origin[1] + h + g) / 16;
  const z0 = (cube.origin[2] - g) / 16, z1 = (cube.origin[2] + d + g) / 16;
  if (cube.mirror) [x0, x1] = [x1, x0];
  const t0 = [x0, y0, z0], t1 = [x1, y0, z0], t2 = [x1, y1, z0], t3 = [x0, y1, z0];
  const l0 = [x0, y0, z1], l1 = [x1, y0, z1], l2 = [x1, y1, z1], l3 = [x0, y1, z1];
  const faces = [[t1, t0, t3, t2], [l0, l1, l2, l3], [l1, l0, t0, t1], [t2, t3, l3, l2], [t0, l0, l3, t3], [l1, t1, t2, l2]];
  const rectangles = [[u + d, v + d, u + d + w, v + d + h], [u + 2 * d + w, v + d, u + 2 * d + 2 * w, v + d + h], [u + d, v, u + d + w, v + d], [u + d + w, v + d, u + d + 2 * w, v], [u, v + d, u + d, v + d + h], [u + d + w, v + d, u + 2 * d + w, v + d + h]];
  const vertices = [], center = [(x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2];
  const wrap = (lo, hi, extent) => { const shift = -Math.floor(lo / extent) * extent; return shift && hi + shift <= extent ? [lo + shift, hi + shift] : [lo, hi]; };
  const emit = (points, su, sv, eu, ev) => {
    const corners = points.map((point, index) => ({ point, uv: [[eu, sv], [su, sv], [su, ev], [eu, ev]][index] }));
    if (cube.mirror) corners.reverse();
    const [a, b, c] = corners.map(item => item.point), ab = b.map((value, axis) => value - a[axis]), ac = c.map((value, axis) => value - a[axis]);
    let normal = [ab[1] * ac[2] - ab[2] * ac[1], ab[2] * ac[0] - ab[0] * ac[2], ab[0] * ac[1] - ab[1] * ac[0]];
    const length = Math.hypot(...normal);
    if (length < 1e-12) return;
    normal = normal.map(value => value / length);
    const outward = normal.reduce((sum, value, axis) => sum + value * (a[axis] - center[axis]), 0);
    if (outward < 0) { corners.reverse(); normal = normal.map(value => -value); }
    for (const index of TRIANGLES) vertices.push(...corners[index].point, ...normal, corners[index].uv[0] / sheet[0], corners[index].uv[1] / sheet[1]);
  };
  for (let face = 0; face < 6; face++) {
    const points = faces[face], uv = rectangles[face], [su, eu] = wrap(uv[0], uv[2], sheet[0]);
    const [lo, hi] = wrap(Math.min(uv[1], uv[3]), Math.max(uv[1], uv[3]), sheet[1]);
    const [sv, ev] = uv[1] <= uv[3] ? [lo, hi] : [hi, lo];
    if (!cube.mirror && su >= 0 && su < sheet[0] && eu > sheet[0]) {
      const t = (sheet[0] - su) / (eu - su), mix = (a, b) => a.map((value, axis) => value + (b[axis] - value) * t);
      const m10 = mix(points[1], points[0]), m23 = mix(points[2], points[3]);
      emit([m10, points[1], points[2], m23], su, sv, sheet[0], ev);
      emit([points[0], m10, m23, points[3]], 0, sv, eu - sheet[0], ev);
    } else emit(points, su, sv, eu, ev);
  }
  return new Float32Array(vertices);
}

export function bakedEntityModel(name) {
  if (CACHE.has(name)) return CACHE.get(name);
  const definition = MODEL_DEFINITIONS[name];
  if (!definition) return null;
  const model = bakeCustomModel(definition);
  CACHE.set(name, model); return model;
}

export function bakeCustomModel(definition) {
  return { ...definition, parts: definition.parts.map(part => ({ ...part, geometry: part.cubes.map(cube => bakeEntityCube(cube, definition.sheet)) })) };
}

// AgeableListModel.renderToBuffer applies separate native transforms to the
// head and body. Young mobs retain a larger head instead of shrinking the
// adult mesh uniformly. Values are (head scale, head Y/Z, body scale, body Y).
const AGEABLE = {
  pig: [1, 4, 4, .5, 24], cow: [1, 10, 4, .5, 24], mooshroom: [1, 10, 4, .5, 24], sheep: [1, 8, 4, .5, 24],
  chicken: [1, 5, 2, .5, 24], wolf: [1, 5, 2, .5, 24], fox: [.75, 8, 3.35, .5, 24],
  cat: [.75, 10, 4, .5, 24], ocelot: [.75, 10, 4, .5, 24], goat: [.6, 19, 1, .5, 24],
  turtle: [1 / 6, 120, 0, 1 / 6, 120], panda: [1.5 / 2.7, 23, 4.8, 1 / 3, 49], polar_bear: [1.5 / 2.25, 16, 4, .5, 24],
  zombie: [.75, 16, 0, .5, 24], husk: [.75, 16, 0, .5, 24], drowned: [.75, 16, 0, .5, 24],
  piglin: [.75, 16, 0, .5, 24], zombified_piglin: [.75, 16, 0, .5, 24], armor_stand: [.75, 16, 0, .5, 24],
  camel: [.45, 29.35, 0, .45, 29.35], sniffer: [.5, 24, 0, .5, 24],
};
export const hasNativeBabyTransform = family => Object.hasOwn(AGEABLE, family) || ['rabbit', 'llama', 'trader_llama'].includes(family);
function ageTransform(part, model, input) {
  const family = input.family;
  let head = false, ancestor = part;
  while (ancestor) {
    if (['head', 'head_parts', 'beak', 'red_thing', 'hat', 'hat_rim', 'nose', 'left_ear', 'right_ear'].includes(ancestor.name)) { head = true; break; }
    ancestor = ancestor.parent === null ? null : model.parts[ancestor.parent];
  }
  if (family === 'rabbit') return input.young ? { scale: head ? [.56666666, .56666666, .56666666] : [.4, .4, .4], offset: head ? [0, 22, 2] : [0, 36, 0] } : { scale: [.6, .6, .6], offset: [0, 16, 0] };
  if (!input.young) return null;
  if (family === 'llama' || family === 'trader_llama') return head ? { scale: [.71428573, .64935064, .7936508], offset: [0, 21, 3.52] } : part.name === 'body' ? { scale: [.625, .45454544, .45454544], offset: [0, 33, 0] } : { scale: [.45454544, .41322312, .45454544], offset: [0, 33, 0] };
  const values = AGEABLE[family]; if (!values) return null;
  const factor = head ? values[0] : values[3]; return { scale: [factor, factor, factor], offset: head ? [0, values[1], values[2]] : [0, values[4], 0] };
}

function partAnimation(part, input) {
  let rotation = [...part.rotation], translation = [0, 0, 0];
  const age = (input.time || 0) * 20;
  const side = part.name.startsWith('left') ? -1 : 1;
  if (part.name === 'head' || part.name === 'head_parts' || input.family === 'chicken' && ['beak', 'red_thing'].includes(part.name)) rotation = [(part.name === 'head_parts' ? part.rotation[0] : 0) + (input.pitch || 0), input.headYaw || 0, 0];
  if (part.name.includes('leg')) rotation[0] = input.swing * (part.name.includes('hind') ? -side : side);
  if (part.name.includes('arm')) {
    rotation[0] = input.zombie ? -Math.PI / 2.25 : -input.swing * side;
    if (input.crouching) rotation[0] += 0.4;
    if (input.attack > 0 && part.name.startsWith(input.leftHanded ? 'left' : 'right')) rotation[0] -= Math.sin(Math.sqrt(input.attack) * Math.PI) * 1.2;
  }
  if (input.crouching && input.humanoid) {
    if (part.name === 'head') translation[1] += 4.2;
    if (part.name === 'body' || part.name.includes('arm')) translation[1] += 3.2;
    if (part.name.includes('leg')) translation[2] += 4;
    if (part.name === 'body') rotation[0] = 0.5;
  }
  if (input.sitting && input.humanoid && part.name.includes('leg')) rotation = [-1.4137167, side * Math.PI / 10, side * Math.PI / 40];
  if (input.family === 'spider' && part.name.includes('leg')) {
    rotation[1] += Math.sin(input.phase * 2 + side) * 0.2 * input.speed;
    rotation[2] += Math.cos(input.phase + side) * 0.15 * input.speed;
  }
  if (input.family === 'squid' && part.name.startsWith('tentacle')) rotation[0] = 0.5 + 0.45 * Math.sin(input.time * 3);
  if (input.family === 'fish' && (part.name.includes('tail') || part.name.includes('fin'))) rotation[1] += Math.sin(input.time * 12) * 0.3;
  if (input.family === 'bat' && part.name.includes('wing')) rotation[1] = side * Math.sin(input.time * 12) * 0.8;
  if (input.family === 'ghast' && part.name.startsWith('tentacle')) rotation[0] = .2 * Math.sin(age * .3 + Number(part.name.slice(8))) + .4;
  if (input.family === 'blaze' && part.name.startsWith('part')) {
    const index = Number(part.name.slice(4)), ring = Math.floor(index / 4), radius = [9, 7, 5][ring];
    const angle = [0, .7853982, .47123894][ring] + age * Math.PI * [-.1, .03, -.05][ring] + index % 4 * Math.PI / 2;
    const desired = [Math.cos(angle) * radius, [-2, 2, 11][ring] + Math.cos(ring === 2 ? (index * 1.5 + age) * .5 : (index * 2 + age) * .25), Math.sin(angle) * radius];
    translation = desired.map((value, axis) => value - part.offset[axis]);
  }
  if (input.family === 'endermite' || input.family === 'silverfish') {
    const silver = input.family === 'silverfish', segment = part.name.startsWith('segment') ? Number(part.name.slice(7)) : part.name.startsWith('layer') ? [2, 4, 1][Number(part.name.slice(5))] : null;
    if (segment !== null) {
      const wave = age * .9 + segment * .15 * Math.PI;
      rotation[1] = Math.cos(wave) * Math.PI * (silver ? .05 : .01) * (1 + Math.abs(segment - 2));
      if (part.name !== 'layer0') translation[0] = Math.sin(wave) * Math.PI * (silver ? .2 : .1) * Math.abs(segment - 2);
    }
  }
  if (input.family === 'magma_cube' && part.name.startsWith('cube')) translation[1] = -(4 - Number(part.name.slice(4))) * Math.max(0, input.squish || 0) * 1.7;
  if (input.family === 'guardian' || input.family === 'elder_guardian') {
    if (part.name.startsWith('spike')) {
      const index = Number(part.name.slice(5)), factor = 1 + Math.cos(age * 1.5 + index) * .01 - (1 - (input.spikes || 0)) * .55;
      const x = [0, 0, 8, -8, -8, 8, 8, -8, 0, 0, 8, -8][index], y = [-8, -8, -8, -8, 0, 0, 0, 0, 8, 8, 8, 8][index], z = [8, -8, 0, 0, -8, -8, 8, 8, 8, -8, 0, 0][index];
      translation = [x * factor, 16 + y * factor, z * factor].map((value, axis) => value - part.offset[axis]);
    }
    if (part.name.startsWith('tail')) rotation[1] = Math.sin(input.tail || 0) * Math.PI * .05 * (Number(part.name.slice(4)) + 1);
    if (part.name === 'eye') { translation[0] = input.eyeX || 0; translation[1] = input.eyeY || 0; }
  }
  if (input.family === 'wither') {
    const wave = Math.cos(age * .1), ribcage = (.065 + .05 * wave) * Math.PI;
    if (part.name === 'ribcage') rotation[0] = ribcage;
    if (part.name === 'tail') { rotation[0] = (.265 + .1 * wave) * Math.PI; translation = [-2, 6.9 + Math.cos(ribcage) * 10, -.5 + Math.sin(ribcage) * 10].map((value, axis) => value - part.offset[axis]); }
    if (part.name === 'center_head') rotation = [input.pitch || 0, input.headYaw || 0, 0];
    if (part.name === 'right_head' || part.name === 'left_head') { const angles = input.sideHeads?.[part.name === 'right_head' ? 0 : 1]; if (angles) rotation = [angles.pitch, angles.yaw, 0]; }
  }
  if ((input.family || '').includes('piglin')) {
    const phase = age * .1 + (input.phase || 0) * .5, amount = .08 + (input.speed || 0) * .4;
    if (part.name === 'left_ear') rotation[2] = -.5235988 - Math.cos(phase * 1.2) * amount;
    if (part.name === 'right_ear') rotation[2] = .5235988 + Math.cos(phase) * amount;
    if (input.dancing) {
      const dance = age / 60, wave = Math.sin(dance * 40);
      if (part.name === 'right_ear') rotation[2] = .5235988 + Math.PI / 180 * Math.sin(dance * 30) * 10;
      if (part.name === 'left_ear') rotation[2] = -.5235988 - Math.PI / 180 * Math.cos(dance * 30) * 10;
      if (part.name === 'head') translation = [Math.sin(dance * 10), wave + .4, 0];
      if (part.name.includes('arm')) { rotation[2] = (part.name === 'right_arm' ? 1 : -1) * Math.PI / 180 * (70 + Math.cos(dance * 40) * 10); translation[1] = wave * .5 + 1.5 - part.offset[1]; }
      if (part.name === 'body') translation[1] = wave * .35;
    } else if (input.admiring) {
      if (part.name === 'head') rotation = [.5, 0, 0];
      if (part.name === (input.leftHanded ? 'right_arm' : 'left_arm')) rotation = [-.9, input.leftHanded ? -.5 : .5, 0];
    } else if (input.chargingCrossbow && part.name.includes('arm')) {
      const main = part.name === (input.leftHanded ? 'left_arm' : 'right_arm'), right = !input.leftHanded, charge = Math.min(1, (input.useTicks || 0) / (input.useDuration || 25));
      rotation[0] = main ? -.97079635 : -.97079635 + (-Math.PI / 2 + .97079635) * charge;
      rotation[1] = main ? right ? -.8 : .8 : (.4 + .45 * charge) * (right ? 1 : -1);
    } else if (input.holdingCrossbow && part.name.includes('arm')) {
      const main = part.name === (input.leftHanded ? 'left_arm' : 'right_arm'), right = !input.leftHanded;
      rotation[1] = (main ? right ? -.3 : .3 : right ? .6 : -.6) + (input.headYaw || 0);
      rotation[0] = (main ? -Math.PI / 2 + .1 : -1.5) + (input.pitch || 0);
    } else if (input.family === 'zombified_piglin' && part.name.includes('arm')) {
      const wave = Math.sin((input.attack || 0) * Math.PI), ease = Math.sin((1 - (1 - (input.attack || 0)) ** 2) * Math.PI), sign = part.name === 'right_arm' ? 1 : -1;
      rotation = [-Math.PI / (input.aggressive ? 1.5 : 2.25) + wave * 1.2 - ease * .4 + sign * Math.sin(age * .067) * .05, sign * -(.1 - wave * .6), sign * (Math.cos(age * .09) * .05 + .05)];
    } else if (input.aggressive && part.name.includes('arm')) {
      if (input.attack === 0 && part.name === (input.leftHanded ? 'left_arm' : 'right_arm')) rotation[0] = -1.8;
      if (input.attack > 0) {
        const main = part.name === (input.leftHanded ? 'left_arm' : 'right_arm'), sign = part.name === 'right_arm' ? 1 : -1, wave = Math.sin(input.attack * Math.PI), ease = Math.sin((1 - (1 - input.attack) ** 2) * Math.PI);
        rotation = [(main ? -1.8849558 + Math.cos(age * .09) * .15 : Math.cos(age * .19) * .5) + wave * (main ? 2.2 : 1.2) - ease * .4 + sign * Math.sin(age * .067) * .05, sign * .15707964, sign * (Math.cos(age * .09) * .05 + .05)];
      }
    }
  }
  if (input.family === 'bee') {
    const wave = Math.cos(input.time * 20 * .18);
    if (part.name.includes('wing')) { rotation[1] = 0; rotation[2] = side * Math.cos(input.time * 20 * 120.32113 * Math.PI / 180) * Math.PI * .15; }
    if (part.name.endsWith('_legs')) rotation[0] = Math.PI / 4;
    if (!input.angry) {
      if (part.name === 'bone') { rotation[0] = .1 + wave * Math.PI * .025; translation[1] = -wave * .9; }
      if (part.name.includes('antenna')) rotation[0] = wave * Math.PI * .03;
      if (part.name === 'front_legs') rotation[0] = -wave * Math.PI * .1 + .3926991;
      if (part.name === 'back_legs') rotation[0] = -wave * Math.PI * .05 + .7853982;
    }
  }
  if (input.family === 'shulker') {
    if (part.name === 'lid') {
      const angle = (.5 + (input.peek || 0)) * Math.PI, opening = -1 + Math.sin(angle);
      translation[1] = 16 + Math.sin(angle) * 8 + (angle > Math.PI ? Math.sin(input.time * 2) * .7 : 0) - part.offset[1];
      rotation[1] = input.peek > .3 ? opening ** 4 * Math.PI * .125 : 0;
    }
    if (part.name === 'head') rotation[1] -= Math.PI;
  }
  if (input.sitting && input.family === 'wolf') {
    if (part.name === 'body') { rotation[0] = Math.PI / 4; translation = [0, 4, -2]; }
    if (part.name === 'upper_body') { rotation[0] = 1.2566371; translation = [0, 2, 0]; }
    if (part.name === 'tail') translation = [0, 9, -2];
    if (part.name.includes('hind_leg')) { rotation[0] = Math.PI * 1.5; translation = [0, 6.7, -5]; }
    if (part.name.includes('front_leg')) { rotation[0] = 5.811947; translation = [side * 0.01, 1, 0]; }
  }
  if (input.family === 'wolf' && part.name === 'tail') rotation[0] = Math.PI / 5;
  if (input.sitting && input.family === 'cat') {
    if (part.name === 'body') { rotation[0] = Math.PI / 4; translation = [0, -4, 5]; }
    if (part.name === 'head') translation = [0, -3.3, 1];
    if (part.name === 'tail1') { rotation[0] = 1.7278761; translation = [0, 8, -2]; }
    if (part.name === 'tail2') { rotation[0] = 2.670354; translation = [0, 2, -0.8]; }
    if (part.name.includes('front_leg')) { rotation[0] = -0.15707964; translation = [0, 2, -2]; }
    if (part.name.includes('hind_leg')) { rotation[0] = -Math.PI / 2; translation = [0, 3, -4]; }
  }
  if (part.name.includes('paddle')) {
    const right = part.name === 'right_paddle', rowing = right ? input.paddleRight : input.paddleLeft;
    const phase = rowing ? input.time * Math.PI * 2.5 : 0;
    rotation[0] = -Math.PI / 3 + (Math.PI / 4) * (Math.sin(-phase) + 1) / 2;
    rotation[1] = -Math.PI / 4 + (Math.PI / 2) * (Math.sin(-phase + 1) + 1) / 2;
    if (right) rotation[1] = Math.PI - rotation[1];
  }
  if (input.family === 'armor_stand') {
    const key = ['right_body_stick', 'left_body_stick', 'shoulder_stick'].includes(part.name) ? 'body' : part.name;
    rotation = [...(input.partPoses?.[key] || [0, 0, 0])]; translation = [0, 0, 0];
    if (part.name === 'base_plate') rotation[1] = -(input.bodyYaw || 0);
  }
  if (input.family === 'ravager') {
    if (part.name.includes('leg')) rotation[0] = Math.cos((input.walkPhase ?? input.phase ?? 0) * .6662 + (['left_hind_leg', 'right_front_leg'].includes(part.name) ? Math.PI : 0)) * .4 * (input.walkSpeed ?? input.speed ?? 0);
    const attack = input.attackTicks || 0, stunned = input.stunnedTicks || 0, roar = input.roarTicks || 0;
    if (part.name === 'neck') {
      if (attack > 0) {
        const triangle = (Math.abs((attack % 10) - 5) - 2.5) / 2.5, movement = ((1 + triangle) * .5) ** 3 * 12;
        translation[2] = -12 + movement;
      } else {
        rotation[0] = stunned > 0 ? .21991149 : 0;
        if (stunned > 0) translation[0] = Math.sin(stunned / 4) * 3;
      }
    }
    if (part.name === 'mouth') rotation[0] = attack > 5 ? Math.sin((attack - 4) / 4) * Math.PI * .4 : attack > 0 ? .15707964 * Math.sin(Math.PI * attack / 10)
      : stunned > 0 ? Math.PI * .05 : roar > 0 ? Math.PI / 2 * Math.sin((20 - roar) / 20 * Math.PI / 4) : Math.PI * .01;
  }
  if (['camel', 'sniffer', 'breeze'].includes(input.family) && part.name.includes('leg')) rotation = [...part.rotation];
  const keyframes = input.keyframes?.get(part.name);
  if (keyframes) {
    rotation = rotation.map((value, axis) => value + keyframes.rotation[axis]);
    translation = translation.map((value, axis) => value + keyframes.translation[axis]);
  }
  const dragon = input.dragonTransforms?.get(part.name);
  if (dragon) {
    rotation = dragon.rotation;
    if (dragon.offset) translation = dragon.offset.map((value, axis) => value - part.offset[axis]);
  }
  return { rotation, translation, scale: keyframes?.scale?.map(value => Math.max(.001, 1 + value)) ?? [1, 1, 1] };
}

export function drawEntityModel(writer, name, context, input = {}, options = {}) {
  const model = bakedEntityModel(name);
  if (!model) return null;
  const transforms = [];
  const visibility = [];
  for (let index = 0; index < model.parts.length; index++) {
    const part = model.parts[index], animation = partAnimation(part, input);
    const pivot = part.offset.map((value, axis) => value + animation.translation[axis]);
    const local = rotation([-animation.rotation[0], animation.rotation[1], -animation.rotation[2]]).map((value, index) => value * part.scale * animation.scale[index % 3]);
    const offset = [pivot[0] / 16, ((part.parent === null ? model.rebase ?? 24.016 : 0) - pivot[1]) / 16, pivot[2] / 16];
    let matrix, position;
    if (part.parent === null) {
      matrix = multiply([-1, 0, 0, 0, 1, 0, 0, 0, 1], local); position = [-offset[0], offset[1], offset[2]];
    } else {
      const parent = transforms[part.parent];
      matrix = multiply(parent.matrix, local);
      position = modelTransform(offset, parent.matrix).map((value, axis) => value + parent.position[axis]);
    }
    transforms.push({ matrix, position });
    visibility.push(!options.hiddenParts?.has(part.name) && (part.parent === null || visibility[part.parent]));
    if (!visibility[index]) continue;
    if (options.parts && !options.parts.has(part.name)) continue;
    if (options.hideHat && ['hat', 'hat_rim'].includes(part.name)) continue;
    const age = ageTransform(part, model, input);
    if (age) {
      const rebase = (model.rebase ?? 24.016) / 16;
      matrix = matrix.map((value, index) => value * age.scale[Math.floor(index / 3)]);
      position = position.map((value, axis) => value * age.scale[axis] + (axis === 1 ? rebase * (1 - age.scale[1]) - age.offset[1] * age.scale[1] / 16 : age.offset[axis] * age.scale[axis] / 16));
    }
    for (let cube = 0; cube < part.geometry.length; cube++) {
      if (options.hat === false && part.name === 'head' && cube > 0) continue;
      const layer = part.cubes[cube].layer;
      if (layer && options.playerCustomization !== undefined && !(options.playerCustomization & layer)) continue;
      const normalMatrix = input.keyframes?.size ? inverseTranspose(matrix) : age && age.scale.some(value => value !== age.scale[0]) ? matrix.map((value, index) => value / age.scale[Math.floor(index / 3)] ** 2) : undefined;
      writer.triangles(part.geometry[cube], context, { matrix, position, normalMatrix, tile: options.tile ?? context.skin?.tile ?? -1, tint: options.tint || [1, 1, 1], flags: options.flags ?? 32, inflation: options.inflation ?? 0, reversed: true, uvOffset: options.uvOffset });
    }
  }
  return { model, transforms };
}

export const entityModelNames = () => Object.keys(MODEL_DEFINITIONS);
