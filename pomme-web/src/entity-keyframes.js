import { ENTITY_KEYFRAMES } from './entity-keyframe-data.js';
import { MODERN_ENTITY_KEYFRAMES } from './entity-modern-keyframe-data.js';

const TAU = Math.PI * 2;
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const wrap = angle => ((angle + Math.PI) % TAU + TAU) % TAU - Math.PI;
const empty = () => ({ rotation: [0, 0, 0], translation: [0, 0, 0], scale: [0, 0, 0] });
const catmull = (a, b, c, d, t) => .5 * (2 * b + (c - a) * t + (2 * a - 5 * b + 4 * c - d) * t * t + (3 * b - a - 3 * c + d) * t * t * t);

/** Native linear/Catmull-Rom channels, including the right key's interpolation. */
export function sampleEntityKeyframes(animation, seconds, weight = 1, result = new Map()) {
  if (!animation || !Number.isFinite(seconds) || !Number.isFinite(weight)) return result;
  const clock = animation.looping && animation.length > 0 ? ((seconds % animation.length) + animation.length) % animation.length : Math.max(0, seconds);
  for (const channel of animation.channels) {
    const keys = channel.keys; if (!keys.length) continue;
    let left = 0; while (left + 1 < keys.length && keys[left + 1][0] <= clock) left++;
    const right = Math.min(left + 1, keys.length - 1), a = keys[left], b = keys[right];
    const fraction = right === left ? 0 : clamp((clock - a[0]) / (b[0] - a[0]), 0, 1);
    const transform = result.get(channel.bone) ?? empty(); result.set(channel.bone, transform);
    const target = channel.target === 'position' ? transform.translation : transform[channel.target];
    for (let axis = 0; axis < 3; axis++) {
      let value = b[4] ? catmull(keys[Math.max(0, left - 1)][axis + 1], a[axis + 1], b[axis + 1], keys[Math.min(keys.length - 1, right + 1)][axis + 1], fraction)
        : a[axis + 1] + (b[axis + 1] - a[axis + 1]) * fraction;
      if (channel.target === 'rotation') value *= Math.PI / 180;
      else if (channel.target === 'position' && axis === 1) value = -value;
      else if (channel.target === 'scale') value -= 1;
      target[axis] += value * weight;
    }
  }
  return result;
}

function changedAt(track, key, value, time) {
  const states = track.specialStates ??= new Map();
  let state = states.get(key);
  if (!state || state.value !== value) { state = { value, previous: state?.value, at: time }; states.set(key, state); }
  return Math.max(0, time - state.at);
}
function long(value) {
  try {
    if (Array.isArray(value) && value.length === 2) return (BigInt(value[0]) << 32n) | BigInt(value[1] >>> 0);
    return BigInt(value);
  } catch { return 0n; }
}

export function advanceWalk(track, input, enabled = true) {
  const tick = Math.floor(input.time * 20), partial = input.time * 20 - tick;
  const state = track.specialWalk ??= { tick, speed: 0, oldSpeed: 0, position: 0 };
  if (tick - state.tick > 100) state.tick = tick - 100;
  const target = enabled ? Math.min(1, Math.max(0, input.worldSpeed || 0) * (input.family === 'camel' ? .3 : .2)) : 0;
  while (state.tick < tick) {
    state.tick++; state.oldSpeed = state.speed; state.speed += (target - state.speed) * .4; state.position += state.speed;
  }
  input.walkSpeed = state.oldSpeed + (state.speed - state.oldSpeed) * partial;
  input.walkPhase = state.position - state.speed * (1 - partial);
}

/** Native state selection; unknown world ages use a local preview transition. */
export function prepareSpecialEntity(track, input, metadata, gameTime) {
  const family = track.definition.name === 'camel_husk' ? 'camel' : track.definition.name, time = input.time, result = new Map();
  const animations = input.nativeCamelBaby ? MODERN_ENTITY_KEYFRAMES.camel_baby : ENTITY_KEYFRAMES[family];
  const apply = (name, seconds, weight = 1) => sampleEntityKeyframes(animations?.[name], seconds, weight, result);
  if (family === 'camel') {
    const poseTick = long(metadata('last_pose_change_tick', 0)), sitting = poseTick < 0n;
    let poseTicks = changedAt(track, 'camelPose', String(poseTick), time) * 20;
    if (gameTime !== undefined && gameTime !== null) poseTicks = clamp(Number(long(gameTime) - (poseTick < 0n ? -poseTick : poseTick)), -12000, 12000);
    input.pitch = clamp(input.pitch, -25 * Math.PI / 180, 45 * Math.PI / 180);
    input.headYaw = clamp(input.headYaw, -Math.PI / 6, Math.PI / 6);
    const dashing = Boolean(metadata('dash', false));
    const dashAge = changedAt(track, 'camelDash', dashing, time);
    advanceWalk(track, input, !sitting && !dashing);
    if (dashing) input.pitch = clamp(input.pitch + Math.max(0, 55 - dashAge * 20) / 55 * Math.PI / 4, -25 * Math.PI / 180, 70 * Math.PI / 180);
    if (sitting && poseTicks >= 0) apply(poseTicks < 40 ? 'CAMEL_SIT' : 'CAMEL_SIT_POSE', poseTicks < 40 ? poseTicks / 20 : (poseTicks - 40) / 20);
    else {
      if (poseTick !== 0n && poseTicks >= 0 && poseTicks < 52) apply('CAMEL_STANDUP', poseTicks / 20);
      if (dashing) apply('CAMEL_DASH', dashAge);
      else apply('CAMEL_WALK', input.walkPhase * 2 / 20, Math.min(1, input.walkSpeed * 2.5));
    }
    // Native idle restarts every 80..119 ticks. Its unsynchronized random
    // choice is seeded locally, so rendering frequency cannot change it.
    const period = (80 + Math.abs(Math.imul(track.entity.id || 0, 1103515245)) % 40) / 20;
    apply('CAMEL_IDLE', Math.max(0, time - (track.createdAt ?? 0)) % period);
  } else if (family === 'sniffer') {
    const raw = metadata('state', 0), names = ['IDLING', 'FEELING_HAPPY', 'SCENTING', 'SNIFFING', 'SEARCHING', 'DIGGING', 'RISING'];
    const state = typeof raw === 'string' ? raw.toUpperCase().replace(/^.*:/, '') : names[Number(raw)] ?? 'IDLING';
    const elapsed = changedAt(track, 'snifferState', state, time);
    advanceWalk(track, input);
    apply(state === 'SEARCHING' ? 'SNIFFER_SNIFF_SEARCH' : 'SNIFFER_WALK', input.walkPhase * 9 / 20, Math.min(1, input.walkSpeed * 100));
    const animation = { FEELING_HAPPY: 'SNIFFER_HAPPY', SCENTING: 'SNIFFER_SNIFFSNIFF', SNIFFING: 'SNIFFER_LONGSNIFF', DIGGING: 'SNIFFER_DIG', RISING: 'SNIFFER_STAND_UP' }[state];
    if (animation) apply(animation, elapsed);
    if (input.young) apply('BABY_TRANSFORM', 0);
  } else if (family === 'breeze') {
    const pose = metadata('pose', 0), elapsed = changedAt(track, 'breezePose', pose, time);
    apply('IDLE', Math.max(0, time - (track.createdAt ?? 0)));
    const animation = { 6: 'JUMP', 15: 'SLIDE', 16: 'SHOOT', 17: 'INHALE' }[pose];
    if (animation) apply(animation, elapsed);
    else if (track.specialStates.get('breezePose').previous === 15 && elapsed < .1) apply('SLIDE_BACK', elapsed);
  } else if (family === 'ravager') {
    advanceWalk(track, input);
    input.attackTicks = Math.max(0, 10 - (time - track.attackAt) * 20);
    const elapsed = (time - (track.stunnedAt ?? -Infinity)) * 20;
    input.stunnedTicks = Math.max(0, 40 - elapsed);
    input.roarTicks = elapsed >= 40 ? Math.max(0, 60 - elapsed) : 0;
  }
  input.keyframes = result;
  return input;
}

/** A bounded 64-tick dragon history and the native five/twelve link equations. */
export function prepareDragon(track, input, position, metadata, sampleAt = () => position) {
  const tick = Math.floor(input.time * 20), partial = input.time * 20 - tick;
  let history = track.dragonHistory;
  if (!history) {
    history = track.dragonHistory = { tick, cursor: 0, values: new Float64Array(128), flap: 0, oldFlap: 0, last: { ...position } };
    for (let i = 0; i < 64; i++) { history.values[i * 2] = position.yaw; history.values[i * 2 + 1] = position.y; }
  }
  if (tick - history.tick > 64) history.tick = tick - 64;
  const phase = Number(metadata('phase', 10)), sitting = [5, 6, 7].includes(phase);
  while (history.tick < tick) {
    history.tick++; history.oldFlap = history.flap;
    const point = sampleAt(history.tick / 20), horizontal = Math.hypot(point.x - history.last.x, point.z - history.last.z), vertical = point.y - history.last.y;
    history.flap += sitting ? .1 : .2 / (horizontal * 10 + 1) * 2 ** clamp(vertical, -8, 8);
    history.cursor = (history.cursor + 1) & 63;
    history.values[history.cursor * 2] = point.yaw; history.values[history.cursor * 2 + 1] = point.y;
    history.last = { ...point };
  }
  const sample = delay => {
    const a = ((history.cursor - delay) & 63) * 2, b = ((history.cursor - delay - 1) & 63) * 2;
    return [history.values[a] + wrap(history.values[b] - history.values[a]) * (1 - partial), history.values[a + 1] + (history.values[b + 1] - history.values[a + 1]) * (1 - partial)];
  };
  const flap = history.oldFlap + (history.flap - history.oldFlap) * partial, cycle = flap * TAU;
  const bobValue = Math.sin(cycle - 1) + 1, bob = (bobValue * bobValue + bobValue * 2) * .05;
  const transforms = new Map(), make = (name, rotation, offset) => transforms.set(name, { rotation, offset });
  make('dragon_root', [bob * 2 * Math.PI / 180, 0, 0], [0, -32 + bob * 16, -48]);
  make('jaw', [(Math.sin(cycle) + 1) * .2, 0, 0], null);
  const reference = sample(6), turn = wrap(sample(5)[0] - sample(10)[0]), centerYaw = wrap(sample(5)[0] + turn / 2);
  const version = input.minecraftVersion ?? '1.20.4';
  const minor = /^1\.(\d+)/.exec(version)?.[1], modern = Number.parseInt(version, 10) >= 26 || Number(minor) > 20;
  make('dragon_body', [0, 0, -turn * 1.5], modern ? [0, 3, 8] : null);
  // Modern cube origins moved down one pixel while the banking pivot moved
  // from the legacy renderer's intermediary to the native body pose.
  if (modern) make('body', [0, 0, 0], [0, 1, 0]);
  let x = 0, y = 20, z = -12;
  for (let index = 0; index < 5; index++) {
    const past = sample(5 - index), bend = sitting ? index : past[1] - reference[1];
    const rotation = [Math.cos(index * .45 + cycle) * .15 + bend * Math.PI / 180 * 7.5, wrap(past[0] - reference[0]) * 1.5, -wrap(past[0] - centerYaw) * 1.5];
    make(`neck${index}`, rotation, [x, y, z]);
    y += Math.sin(rotation[0]) * 10; z -= Math.cos(rotation[1]) * Math.cos(rotation[0]) * 10; x -= Math.sin(rotation[1]) * Math.cos(rotation[0]) * 10;
  }
  const now = sample(0);
  make('head', [(sitting ? 6 : 0) * Math.PI / 180 * 7.5, wrap(now[0] - reference[0]), -wrap(now[0] - centerYaw)], [x, y, z]);
  for (const side of ['left', 'right']) {
    const sign = side === 'left' ? 1 : -1;
    make(`${side}_wing`, [.125 - Math.cos(cycle) * .2, -.25 * sign, -(Math.sin(cycle) + .125) * .8 * sign], modern ? [12 * sign, 2, -6] : null);
    make(`${side}_wing_tip`, [0, 0, (Math.sin(cycle + 2) + .5) * .75 * sign], null);
    for (const [part, angle] of [['front_leg', 1.3 + bob * .1], ['front_leg_tip', -.5 - bob * .1], ['front_foot', .75 + bob * .1], ['hind_leg', 1 + bob * .1], ['hind_leg_tip', .5 + bob * .1], ['hind_foot', .75 + bob * .1]]) make(`${side}_${part}`, [angle, 0, 0], modern && part === 'front_leg' ? [12 * sign, 17, -6] : modern && part === 'hind_leg' ? [16 * sign, 13, 34] : null);
  }
  x = 0; y = 10; z = 60; let bend = 0; const tailReference = sample(11);
  for (let index = 0; index < 12; index++) {
    const past = sample(12 + index); bend += Math.sin(index * .45 + cycle) * .05;
    const rotation = [bend + (past[1] - tailReference[1]) * Math.PI / 180 * 7.5, wrap(past[0] - tailReference[0]) * 1.5 + Math.PI, wrap(past[0] - centerYaw) * 1.5];
    make(`tail${index}`, rotation, [x, y, z]);
    y += Math.sin(rotation[0]) * 10; z -= Math.cos(rotation[1]) * Math.cos(rotation[0]) * 10; x -= Math.sin(rotation[1]) * Math.cos(rotation[0]) * 10;
  }
  input.dragonTransforms = transforms;
  input.dragonTurn = turn;
  input.dragonYaw = sample(7)[0];
  input.dragonTilt = (sample(5)[1] - sample(10)[1]) * 10 * Math.PI / 180;
  return input;
}
