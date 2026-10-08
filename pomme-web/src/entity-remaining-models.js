import { REMAINING_ENTITY_MODELS } from './entity-remaining-model-data.js';
import { REMAINING_ENTITY_KEYFRAMES } from './entity-remaining-keyframe-data.js';
import { advanceWalk, sampleEntityKeyframes } from './entity-keyframes.js';
import { actorEyeFlags, FULLBRIGHT, EMISSIVE_TRANSLUCENT } from './actor-layers.js';

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const empty = () => ({ rotation: [0, 0, 0], translation: [0, 0, 0], scale: [0, 0, 0] });
const PARROTS = ['red_blue', 'blue', 'green', 'yellow_blue', 'grey'];
const COPPER = ['copper_golem', 'exposed_copper_golem', 'weathered_copper_golem', 'oxidized_copper_golem'];
const COPPER_CALENDAR = ['', '_exposed', '_weathered', '_oxidized'];
const calendarVersion = version => Number.parseInt(version, 10) >= 26;
const copperTexture = (weather, version, eyes = false) => calendarVersion(version)
  ? `copper_golem${eyes ? '_eyes' : ''}${COPPER_CALENDAR[weather] ?? ''}`
  : `${COPPER[weather] ?? COPPER[0]}${eyes ? '_eyes' : ''}`;
const EMISSIVE = 32 | FULLBRIGHT | EMISSIVE_TRANSLUCENT;
const alpha8 = v => Math.floor(clamp(v, 0, 1) * 255) / 255;

// The network profile uses a flat property list; its persistent codec stores
// PropertyMap as a name-to-list map. Both retain the original signed values.
export function mannequinProfile(value) {
  if (typeof value === 'string') return { name: value, properties: [] };
  if (!value || typeof value !== 'object') return undefined;
  if (Array.isArray(value.properties)) return value;
  const properties = Object.entries(value.properties || {}).flatMap(([name, entries]) =>
    (Array.isArray(entries) ? entries : [entries]).filter(entry => entry && typeof entry.value === 'string').map(entry => ({ ...entry, name })));
  return { ...value, properties };
}

// PlayerSkin.Patch references resources already supplied by the active pack.
// Its body/model fields override resolved account skin fields independently.
export function mannequinSkinPatch(value, atlas) {
  if (!value || typeof value !== 'object') return null;
  const patch = value.skinPatch ?? value;
  const id = patch.body ?? patch.texture;
  const qualified = typeof id === 'string' && id.length <= 512 && /^(?:[a-z0-9_.-]+:)?[a-z0-9/._-]+$/.test(id)
    ? id.includes(':') ? id : `minecraft:${id}` : undefined;
  const tile = qualified ? atlas?.entityTiles?.get(qualified) ?? atlas?.tileByName?.get(qualified) : undefined;
  const model = patch.model;
  const slim = model === 'slim' || model === 1 ? true : model === 'wide' || model === 0 ? false : undefined;
  return { tile, slim };
}

export function resolveRemainingEntity(name, metadata, version) {
  const boat = /^(oak|spruce|birch|jungle|acacia|dark_oak|mangrove|cherry|pale_oak|bamboo)_(chest_)?(boat|raft)$/.exec(name);
  if (boat) {
    const chest = Boolean(boat[2]), raft = boat[1] === 'bamboo';
    return { model: `${chest ? 'chest_' : ''}${raft ? 'raft' : 'boat'}_modern`,
      assetId: `minecraft:entity/${chest ? 'chest_boat' : 'boat'}/${boat[1]}`, height: chest ? 128 : 64 };
  }
  if (name === 'parrot') return { model: name, assetId: `minecraft:entity/parrot/parrot_${PARROTS[metadata('variant', 0)] ?? 'red_blue'}`, height: 32 };
  if (name === 'phantom') return { model: name, assetId: `minecraft:entity/${calendarVersion(version) ? 'phantom/phantom' : 'phantom'}`, height: 64 };
  if (name === 'tadpole') return { model: name, assetId: 'minecraft:entity/tadpole/tadpole', height: 16 };
  if (name === 'warden') return { model: name, assetId: 'minecraft:entity/warden/warden', height: 128 };
  if (name === 'creaking') return { model: name, assetId: 'minecraft:entity/creaking/creaking', height: 64 };
  if (name === 'copper_golem') return { model: name, assetId: `minecraft:entity/copper_golem/${copperTexture(metadata('weather_state', 0), version)}`, height: 64 };
  if (name === 'armadillo') {
    const baby = Boolean(metadata('baby', false)), calendar = calendarVersion(version);
    return { model: baby ? calendar ? 'armadillo_baby_modern' : 'armadillo_baby' : name,
      assetId: `minecraft:entity/${calendar ? `armadillo/armadillo${baby ? '_baby' : ''}` : 'armadillo'}`, height: 64 };
  }
  if (name === 'bogged') return { model: name, assetId: 'minecraft:entity/skeleton/bogged', height: 32 };
  if (name === 'parched') return { model: 'skeleton', assetId: 'minecraft:entity/skeleton/parched', height: 32 };
  if (name === 'giant') return { model: 'zombie', assetId: 'minecraft:entity/zombie/zombie', height: 64 };
  return null;
}

export function consumeRemainingStatus(track, status, time) {
  if (![61, 62, 64, 66].includes(status)) return;
  (track.nativeEvents ??= new Map()).set(status, time);
}

function stateAge(track, key, value, time) {
  const states = track.remainingStates ??= new Map();
  let state = states.get(key);
  if (!state || state.value !== value) { state = { value, at: time }; states.set(key, state); }
  return Math.max(0, time - state.at);
}

function parrotFlap(track, age) {
  const tick = Math.floor(age), partial = age - tick;
  const state = track.parrotFlap ??= { tick: 0, flap: 0, speed: 0, flapping: 1, oldFlap: 0, oldSpeed: 0 };
  const count = Math.max(0, tick - state.tick);
  const grounded = track.entity.grounded ?? track.entity.onGround ?? false;
  const speedDecreases = grounded || Number.isInteger(track.entity.vehicleId);
  if (count) {
    if (grounded) {
      state.oldFlap = state.flap + 18 * state.flapping * (1 - .9 ** (count - 1));
      state.flap += 18 * state.flapping * (1 - .9 ** count); state.flapping *= .9 ** count;
    } else {
      state.oldFlap = state.flap + 1.8 * (count - 1); state.flap += 1.8 * count; state.flapping = .9;
    }
    state.oldSpeed = speedDecreases ? Math.max(0, state.speed - .3 * (count - 1)) : count === 1 ? state.speed : 1;
    state.speed = speedDecreases ? Math.max(0, state.speed - .3 * count) : 1;
    state.tick = tick;
  }
  return (Math.sin(state.oldFlap + (state.flap - state.oldFlap) * partial) + 1)
    * (state.oldSpeed + (state.speed - state.oldSpeed) * partial);
}

function wardenPulses(track, age, anger, time) {
  const tick = Math.floor(age), partial = age - tick;
  const state = track.wardenPulses ??= { tick: 0, heart: 0, oldHeart: 0 };
  const delay = 40 - Math.floor(clamp(Number(anger) / 80, 0, 1) * 30);
  if (tick - state.tick > 40) { state.tick = tick - 40; state.heart = 0; }
  while (state.tick < tick) {
    state.tick++;
    if (state.tick % delay === 0) state.heart = 10;
    state.oldHeart = state.heart; state.heart = Math.max(0, state.heart - 1);
  }
  const tendrilAge = (time - (track.nativeEvents?.get(61) ?? -Infinity)) * 20;
  return { heart: (state.oldHeart + (state.heart - state.oldHeart) * partial) / 10,
    tendril: clamp((10 - tendrilAge) / 10, 0, 1) };
}

function creakingBlink(track, ticks) {
  const state = track.creakingBlink ??= { tick: 0, next: 0, glowing: false, seed: track.entity.id >>> 0 };
  // The native server removes a heart-bound teardown after 45 ticks. The
  // blink's random ranges are native; its unsynchronized seed is local.
  while (state.tick < Math.min(45, ticks)) {
    state.tick++;
    if (state.tick > state.next) {
      state.seed = (Math.imul(state.seed, 1664525) + 1013904223) >>> 0;
      const lo = state.glowing ? 2 : Math.floor(state.tick / 4), hi = state.glowing ? 8 : Math.floor(state.tick / 2);
      state.next = state.tick + lo + state.seed % (hi - lo + 1); state.glowing = !state.glowing;
    }
  }
  return state.glowing;
}

const copperIdle = (track, time) => {
  const at = track.remainingStates?.get('copperState')?.at ?? time;
  const period = 200 + Math.abs(Math.imul(track.entity.id || 0, 1103515245)) % 40;
  const ticks = (time - at) * 20;
  return ticks < period + 1 ? -1 : ((ticks - period - 1) % (period + 11)) / 20;
};

export function remainingEntityAnimated(track, time, metadata) {
  const family = track.definition.name;
  if (['phantom', 'tadpole', 'warden'].includes(family)) return true;
  const walking = (track.specialWalk?.speed ?? 0) > .001 || (track.specialWalk?.oldSpeed ?? 0) > .001;
  if (family === 'parrot') return walking || Boolean(track.entity.partyParrot) || !(metadata('flags', 0) & 1)
    && ((track.entity.grounded ?? track.entity.onGround ?? false) === false || (track.parrotFlap?.speed ?? 0) > .001 || (track.parrotFlap?.oldSpeed ?? 0) > .001);
  if (family === 'armadillo') {
    const state = track.remainingStates?.get('armadillo'), elapsed = time - (state?.at ?? time);
    return walking || state?.value === 'rolling' && elapsed < .55 || state?.value === 'unrolling' && elapsed < 1.55
      || state?.value === 'scared' && time < (track.nativeEvents?.get(64) ?? -Infinity) + 2.55;
  }
  if (family === 'creaking') return walking || time < (track.attackAt ?? -Infinity) + .8
    || time < (track.nativeEvents?.get(66) ?? -Infinity) + .45
    || Boolean(metadata('is_tearing_down', false)) && time < (track.remainingStates?.get('creakingDeath')?.at ?? time) + 2.3;
  if (family === 'copper_golem') {
    if (walking || track.remainingStates?.get('copperState')?.value !== 'idle') return true;
    if (metadata('mob_flags', 0) & 1) return false;
    const phase = copperIdle(track, time);
    return phase >= 0 && phase < 3.5 || (track.copperIdleElapsed ?? -1) >= 0 && (track.copperIdleElapsed ?? -1) < 3.5;
  }
  return false;
}

/** Source-defined model poses. Local unsynchronized clocks start at spawn. */
export function prepareRemainingEntity(track, input, metadata, { inWater = true, hasHands = false } = {}) {
  const family = track.definition.name, time = input.time;
  const data = REMAINING_ENTITY_MODELS[input.nativeModel]; if (!data) return input;
  const rest = new Map(data.parts.map(p => [p.name, p.rotation])), result = new Map();
  const pose = name => { const value = result.get(name) ?? empty(); result.set(name, value); return value; };
  const setRotation = (name, values) => { const initial = rest.get(name) ?? [0, 0, 0]; pose(name).rotation = values.map((v, i) => v - initial[i]); };
  const translate = (name, delta) => { const p = pose(name); p.translation = p.translation.map((v, i) => v + delta[i]); };
  const age = Math.max(0, time - (track.createdAt ?? 0)) * 20;
  const group = REMAINING_ENTITY_KEYFRAMES[family === 'armadillo' && input.nativeModel === 'armadillo_baby_modern' ? 'armadillo_baby' : family];
  const apply = (name, seconds, weight = 1) => sampleEntityKeyframes(group?.[name], seconds, weight, result);
  input.nativePoseOnly = true; input.nativeLayers = [];
  input.hiddenParts ??= new Set(); input.skipDrawParts ??= new Set();
  const layer = (path, parts, flags, alpha = 1, noOverlay = true) => {
    if (alpha > 1e-5) input.nativeLayers.push({ path: `minecraft:entity/${path}`, parts, flags, alpha: alpha8(alpha), noOverlay });
  };
  if (family === 'phantom') {
    const cycle = ((track.entity.id || 0) * 3 + age) * 7.448451 * Math.PI / 180;
    for (const side of ['left', 'right']) for (const part of ['base', 'tip']) {
      const p = `${side}_wing_${part}`, r = [...rest.get(p)]; r[2] = Math.cos(cycle) * 16 * Math.PI / 180 * (side === 'left' ? 1 : -1); setRotation(p, r);
    }
    for (const part of ['tail_base', 'tail_tip']) setRotation(part, [-(5 + Math.cos(cycle * 2) * 5) * Math.PI / 180, 0, 0]);
    input.phantomScale = 1 + .15 * Number(metadata('size', 0));
    layer(calendarVersion(input.minecraftVersion) ? 'phantom/phantom_eyes' : 'phantom_eyes', undefined, actorEyeFlags(input.minecraftVersion));
  } else if (family === 'tadpole') {
    setRotation('tail', [0, -(inWater ? 1 : 1.5) * .25 * Math.sin(age * .3), 0]);
  } else if (family === 'parrot') {
    advanceWalk(track, input);
    const grounded = track.entity.grounded ?? track.entity.onGround ?? false;
    const sitting = Boolean(metadata('flags', 0) & 1), party = Boolean(track.entity.partyParrot);
    const flap = parrotFlap(track, age);
    setRotation('head', [input.pitch || 0, input.headYaw || 0, 0]);
    if (sitting && !party) {
      for (const part of ['head', 'tail', 'body', 'left_wing', 'right_wing', 'left_leg', 'right_leg']) translate(part, [0, 1.9, 0]);
      pose('tail').rotation[0] += .5235988;
      for (const [side, sign] of [['left', -1], ['right', 1]]) {
        setRotation(`${side}_wing`, [rest.get(`${side}_wing`)[0], -Math.PI, sign * .0873]);
        pose(`${side}_leg`).rotation[0] += 1.5707964;
      }
    } else {
      setRotation('left_wing', [rest.get('left_wing')[0], -Math.PI, -.0873 - flap]);
      setRotation('right_wing', [rest.get('right_wing')[0], -Math.PI, .0873 + flap]);
      if (party) {
        for (const part of ['head', 'body', 'tail', 'left_wing', 'right_wing']) translate(part, [Math.cos(age), Math.sin(age), 0]);
        setRotation('head', [0, 0, .4 * Math.sin(age)]);
        pose('left_leg').rotation[2] = -.34906584; pose('right_leg').rotation[2] = .34906584;
      } else {
        for (const part of ['head', 'tail', 'body', 'left_wing', 'right_wing', 'left_leg', 'right_leg']) translate(part, [0, flap * .3, 0]);
        pose('tail').rotation[0] += .3 * Math.cos(input.walkPhase * .6662) * input.walkSpeed;
        if (grounded) {
          pose('left_leg').rotation[0] += 1.4 * Math.cos(input.walkPhase * .6662) * input.walkSpeed;
          pose('right_leg').rotation[0] += 1.4 * Math.cos(input.walkPhase * .6662 + Math.PI) * input.walkSpeed;
        } else { pose('left_leg').rotation[0] += .6981317; pose('right_leg').rotation[0] += .6981317; }
      }
    }
  } else if (family === 'armadillo') {
    const names = ['idle', 'rolling', 'scared', 'unrolling'], raw = metadata('armadillo_state', 0);
    const state = typeof raw === 'string' ? raw.replace(/^.*:/, '').toLowerCase() : names[Number(raw)] ?? 'idle';
    const elapsed = stateAge(track, 'armadillo', state, time), ticks = Math.floor(elapsed * 20);
    const hiding = state === 'scared' || state === 'rolling' && ticks > 5 || state === 'unrolling' && ticks < 26;
    if (hiding) { input.skipDrawParts.add('body'); for (const name of ['left_hind_leg', 'right_hind_leg', 'tail']) input.hiddenParts.add(name); }
    else { input.hiddenParts.add('cube'); setRotation('head', [clamp(input.pitch || 0, -22.5 * Math.PI / 180, 25 * Math.PI / 180), clamp(input.headYaw || 0, -32.5 * Math.PI / 180, 32.5 * Math.PI / 180), 0]); }
    advanceWalk(track, input); const prefix = input.nativeModel === 'armadillo_baby_modern' ? 'ARMADILLO_BABY_' : 'ARMADILLO_';
    apply(`${prefix}WALK`, input.walkPhase * 16.5 / 20, Math.min(1, input.walkSpeed * 2.5));
    if (state === 'rolling') apply(`${prefix}ROLL_UP`, elapsed);
    if (state === 'unrolling') apply(`${prefix}ROLL_OUT`, elapsed);
    if (state === 'scared') apply(`${prefix}PEEK`, track.nativeEvents?.has(64) ? Math.max(0, time - track.nativeEvents.get(64)) : 2.5 + elapsed);
  } else if (family === 'creaking') {
    input.walkTargetScale = 1.25; input.walkMax = 3;
    advanceWalk(track, input, Boolean(metadata('can_move', true)));
    setRotation('head', [input.pitch || 0, input.headYaw || 0, 0]);
    if (metadata('can_move', true)) apply('CREAKING_WALK', input.walkPhase / 20, Math.min(1, input.walkSpeed));
    if (time < (track.attackAt ?? -Infinity) + .75) apply('CREAKING_ATTACK', time - track.attackAt);
    if (time < (track.nativeEvents?.get(66) ?? -Infinity) + .4) apply('CREAKING_INVULNERABLE', time - track.nativeEvents.get(66));
    const dying = Boolean(metadata('is_tearing_down', false)), deathAge = stateAge(track, 'creakingDeath', dying, time);
    if (dying) { apply('CREAKING_DEATH', deathAge); input.suppressDeathRotation = true; input.suppressHurt = true; }
    if (dying ? creakingBlink(track, Math.floor(deathAge * 20)) : metadata('is_active', false)) layer('creaking/creaking_eyes', new Set(['head']), actorEyeFlags(input.minecraftVersion));
  } else if (family === 'warden') {
    advanceWalk(track, input);
    const weight = Math.min(.5, 3 * input.walkSpeed), phase = input.walkPhase * .8662, c = Math.cos(phase), s = Math.sin(phase), limited = Math.min(.35, weight);
    setRotation('head', [(input.pitch || 0) + 1.2 * Math.cos(phase + Math.PI / 2) * limited + .06 * Math.sin(age * .1), input.headYaw || 0, .3 * s * weight + .06 * Math.cos(age * .1)]);
    setRotation('body', [c * limited + .025 * Math.cos(age * .1), 0, .1 * s * weight + .025 * Math.sin(age * .1)]);
    setRotation('left_leg', [c * weight, 0, 0]); setRotation('right_leg', [Math.cos(phase + Math.PI) * weight, 0, 0]);
    setRotation('left_arm', [-.8 * c * weight, 0, 0]); setRotation('right_arm', [-.8 * s * weight, 0, 0]);
    const pulses = wardenPulses(track, age, metadata('client_anger_level', 0), time), tendril = pulses.tendril * Math.cos(age * 2.25) * Math.PI * .1;
    setRotation('left_tendril', [tendril, 0, 0]); setRotation('right_tendril', [-tendril, 0, 0]);
    const poseId = metadata('pose', 0), elapsed = stateAge(track, 'wardenPose', poseId, time);
    const animation = { 11: 'WARDEN_ROAR', 12: 'WARDEN_SNIFF', 13: 'WARDEN_EMERGE', 14: 'WARDEN_DIG' }[poseId];
    if (animation) apply(animation, elapsed);
    if (Number.isFinite(track.attackAt)) apply('WARDEN_ATTACK', time - track.attackAt);
    if (track.nativeEvents?.has(62)) apply('WARDEN_SONIC_BOOM', time - track.nativeEvents.get(62));
    const parts = new Set(['body', 'head', 'left_arm', 'right_arm', 'left_leg', 'right_leg']);
    layer('warden/warden_bioluminescent_layer', new Set([...parts].filter(p => p !== 'body')), EMISSIVE, 1, false);
    layer('warden/warden_pulsating_spots_1', parts, EMISSIVE, Math.max(0, Math.cos(age * .045) * .25), false);
    layer('warden/warden_pulsating_spots_2', parts, EMISSIVE, Math.max(0, Math.cos(age * .045 + Math.PI) * .25), false);
    layer('warden/warden', new Set(['left_tendril', 'right_tendril']), EMISSIVE, pulses.tendril, false);
    layer('warden/warden_heart', new Set(['body']), EMISSIVE, pulses.heart, false);
  } else if (family === 'copper_golem') {
    advanceWalk(track, input); setRotation('head', [input.pitch || 0, input.headYaw || 0, 0]);
    apply(hasHands ? 'COPPER_GOLEM_WALK_ITEM' : 'COPPER_GOLEM_WALK', input.walkPhase * 2 / 20, Math.min(1, input.walkSpeed * 2.5));
    if (hasHands) for (const [side, sign] of [['right', -1], ['left', 1]]) {
      const p = pose(`${side}_arm`); p.rotation[0] = Math.min(p.rotation[0], -.87266463);
      p.rotation[1] = sign < 0 ? Math.min(p.rotation[1], -.1134464) : Math.max(p.rotation[1], .1134464);
      p.rotation[2] = sign < 0 ? Math.min(p.rotation[2], -.064577185) : Math.max(p.rotation[2], .064577185);
    }
    const names = ['idle', 'getting_item', 'getting_no_item', 'dropping_item', 'dropping_no_item'], raw = metadata('copper_golem_state', 0);
    const state = typeof raw === 'string' ? raw.replace(/^.*:/, '').toLowerCase() : names[Number(raw)] ?? 'idle';
    input.copperGolemState = state;
    const elapsed = stateAge(track, 'copperState', state, time);
    const selected = { getting_item: 'COPPER_GOLEM_CHEST_INTERACTION_NOITEM_GET', getting_no_item: 'COPPER_GOLEM_CHEST_INTERACTION_NOITEM_NOGET', dropping_item: 'COPPER_GOLEM_CHEST_INTERACTION_ITEM_DROP', dropping_no_item: 'COPPER_GOLEM_CHEST_INTERACTION_ITEM_NODROP' }[state];
    if (selected) apply(selected, elapsed);
    else if (!(metadata('mob_flags', 0) & 1)) {
      track.copperIdleElapsed = copperIdle(track, time);
      if (track.copperIdleElapsed >= 0) apply('COPPER_GOLEM_IDLE', track.copperIdleElapsed);
    }
    layer(`copper_golem/${copperTexture(metadata('weather_state', 0), input.minecraftVersion, true)}`, undefined, actorEyeFlags(input.minecraftVersion));
  }
  input.keyframes = result; return input;
}
