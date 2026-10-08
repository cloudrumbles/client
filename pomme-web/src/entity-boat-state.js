import { nativeSin } from './native-beams.js';

const f = Math.fround;
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const numeric = value => Number.isFinite(Number(value)) ? Number(value) : 0;
const modernVersion = version => Number.parseInt(version, 10) >= 26 || Number(/^1\.(\d+)/.exec(version)?.[1]) > 20;
const lerp = (partial, before, after) => f(f(before) + f(f(partial) * f(f(after) - f(before))));
function longFloat(value) {
  const negative = value < 0n, magnitude = negative ? -value : value;
  const shift = Math.max(0, magnitude.toString(2).length - 24);
  let significand = magnitude >> BigInt(shift);
  if (shift) {
    const remainder = magnitude - (significand << BigInt(shift)), half = 1n << BigInt(shift - 1);
    if (remainder > half || remainder === half && (significand & 1n)) significand++;
  }
  return f((negative ? -1 : 1) * Number(significand) * 2 ** shift);
}

// Factual BoatModel water_patch geometry is identical in the supplied legacy
// and modern sources. Texture coordinates are unused by the depth-only pass.
export const BOAT_WATER_PATCH_MODEL = { sheet: [128, 64], rebase: 0, parts: [{
  name: 'water_patch', parent: null, offset: [0, -3, 1], rotation: [1.5707964, 0, 0], scale: 1,
  cubes: [{ origin: [-14, -9, -3], size: [28, 16, 3], uv: [0, 0], inflate: 0, mirror: false }],
}] };

// AbstractBoat.tickBubbleColumn runs at 20 TPS, independently of render rate.
// The native client initializes unsynchronized bubble animation at spawn.
export function advanceBoatVisual(track, time, metadata, version = '1.20.4', gameTime) {
  const age = Math.max(0, (time - (track.createdAt ?? time)) * 20), tick = Math.floor(age), partial = f(age - tick);
  const state = track.boatVisual ??= { tick: 0, strength: 0, beforeAngle: 0, angle: 0, hurt: null, damage: null };
  const bubbling = numeric(metadata('bubble_time', 0)) > 0;
  const modern = modernVersion(String(version));
  let clock;
  try { if (gameTime !== undefined && gameTime !== null) clock = BigInt.asIntN(64, BigInt(gameTime)); } catch {}
  const wave = at => modern ? .5 * (at | 0) : f(.5 * (clock === undefined ? f(at) : longFloat(BigInt.asIntN(64, clock + BigInt(at - tick)))));
  // Once its bounded native ramp has converged, only the last two ticks are
  // needed to retain the exact interpolation endpoints after a long pause.
  if (tick - state.tick > 32) {
    state.tick = tick - 2; state.strength = bubbling ? 1 : 0;
    state.angle = f(f(10 * f(Math.sin(wave(state.tick)))) * state.strength);
  }
  while (state.tick < tick) {
    state.tick++; state.strength = f(clamp(f(state.strength + f(bubbling ? .05 : -.1)), 0, 1));
    state.beforeAngle = state.angle;
    state.angle = f(f(10 * f(Math.sin(wave(state.tick)))) * state.strength);
  }
  for (const key of ['hurt', 'damage']) {
    const value = Math.max(0, numeric(metadata(key, 0)));
    if (state[key]?.value !== value) state[key] = { value, tick };
  }
  const hurt = f(Math.max(0, state.hurt.value - (tick - state.hurt.tick)) - partial);
  const damage = Math.max(0, f(Math.max(0, state.damage.value - (tick - state.damage.tick)) - partial));
  const direction = numeric(metadata('hurtdir', 1));
  const hurtDegrees = hurt > 0 ? f(f(f(f(nativeSin(hurt, modern) * hurt) * damage) / 10) * direction) : 0;
  return { hurtRadians: f(hurtDegrees * f(Math.PI / 180)), bubbleDegrees: lerp(partial, state.beforeAngle, state.angle),
    animated: hurt > 0 || state.strength > 0 || bubbling };
}

// Original Quaternionf.setAngleAxis(angle,1,0,1) intentionally retains the
// source's nonunit axis. JOML forms its matrix from all four squared values.
export function boatBubbleMatrix(degrees) {
  const half = f(f(degrees) * f(Math.PI / 180)) * .5, s = f(Math.sin(half)), w = f(Math.cos(half));
  const s2 = f(s * s), w2 = f(w * w), sw2 = f(f(s * w) * 2), ss2 = f(s2 * 2);
  return [w2, -sw2, ss2, sw2, f(w2 - ss2), -sw2, ss2, sw2, w2];
}

// AbstractBoat.isUnderwater checks water touching the top of its AABB, not
// the entity's feet or center. Both flowing/source statuses hide the patch.
export function nativeBoatUnderWater(position, definition, sampleBlock) {
  if (typeof sampleBlock !== 'function') return false;
  const width = Number(definition?.width) || 1.375, height = Number(definition?.height) || .5625;
  if (!Number.isFinite(width) || width <= 0 || width > 4 || !Number.isFinite(height) || height <= 0 || height > 4) return false;
  const minX = Math.floor(position.x - width / 2), maxX = Math.ceil(position.x + width / 2);
  const minZ = Math.floor(position.z - width / 2), maxZ = Math.ceil(position.z + width / 2);
  const top = position.y + height, threshold = top + .001;
  for (let x = minX; x < maxX; x++) for (let y = Math.floor(top); y < Math.ceil(threshold); y++) for (let z = minZ; z < maxZ; z++) {
    const fluid = sampleBlock(x, y, z)?.fluid;
    if (fluid?.kind === 'water' && Number.isFinite(fluid.height) && threshold < f(f(y) + f(fluid.height))) return true;
  }
  return false;
}
