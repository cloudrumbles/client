import { MODERN_ENTITY_MODELS } from './entity-modern-model-data.js';
import { MODERN_ENTITY_KEYFRAMES } from './entity-modern-keyframe-data.js';
import { advanceWalk, sampleEntityKeyframes } from './entity-keyframes.js';

const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
const transform = () => ({ rotation: [0, 0, 0], translation: [0, 0, 0], scale: [0, 0, 0] });
const asset = id => String(id).includes(':') ? String(id) : `minecraft:${id}`;
const DEFAULT_NAUTILUS = [
  { key: 'minecraft:temperate', value: { asset_id: 'minecraft:entity/nautilus/zombie_nautilus' } },
  { key: 'minecraft:warm', value: { model: 'warm', asset_id: 'minecraft:entity/nautilus/zombie_nautilus_coral' } },
];
// Bootstrap order is only a local-preview fallback. Live registry IDs and asset
// namespaces always come from the server's configuration packets.
const FARM_VARIANTS = Object.fromEntries(['cow', 'pig', 'chicken'].map(name => [name,
  ['temperate', 'warm', 'cold'].map(temperature => ({ key: `minecraft:${temperature}`, value: {
    asset_id: `minecraft:entity/${name}/${temperature}_${name}`,
    model: temperature === 'cold' ? 'cold' : name === 'cow' && temperature === 'warm' ? 'warm' : 'normal',
  } })),
]));

function variantData(registries, registryId, raw, defaults) {
  const entries = registries.get(registryId) ?? defaults;
  const id = raw?.variantId ?? raw?.id ?? raw;
  const entry = typeof id === 'string'
    ? entries.find(value => asset(value.key ?? value.name) === asset(id))
    : entries.find(value => value.id === Number(id)) ?? entries[Number(id)];
  return raw?.variantData ?? entry?.value ?? entry?.element ?? {};
}

function chickenFlap(track, age) {
  const tick = Math.floor(age), partial = age - tick;
  const state = track.chickenFlap ??= { tick: 0, flap: 0, speed: 0, flapping: 1, oldFlap: 0, oldSpeed: 0 };
  const count = Math.max(0, tick - state.tick);
  const grounded = track.entity?.grounded ?? track.entity?.onGround ?? true;
  if (count) {
    if (grounded) {
      // Closed form of the native .9 decay: an idle pause costs constant work.
      const previous = state.flapping;
      state.oldFlap = state.flap + 18 * previous * (1 - .9 ** (count - 1));
      state.flap += 18 * previous * (1 - .9 ** count);
      state.flapping *= .9 ** count;
      state.oldSpeed = Math.max(0, state.speed - .3 * (count - 1));
      state.speed = Math.max(0, state.speed - .3 * count);
    } else {
      state.oldFlap = state.flap + 1.8 * (count - 1);
      state.flap += 1.8 * count; state.flapping = .9;
      state.oldSpeed = count === 1 ? state.speed : 1;
      state.speed = 1;
    }
    state.tick = tick;
  }
  return (Math.sin(state.oldFlap + (state.flap - state.oldFlap) * partial) + 1)
    * (state.oldSpeed + (state.speed - state.oldSpeed) * partial);
}

export function resolveModernEntity(name, metadata, registries = new Map(), version = '1.21.11') {
  const baby = Boolean(metadata('baby', false));
  if (name === 'camel' && baby && Number.parseInt(version, 10) >= 26) return { model: 'camel_baby_modern', assetId: 'minecraft:entity/camel/camel_baby', height: 64 };
  if (name === 'happy_ghast') return { model: baby ? 'happy_ghast_baby' : 'happy_ghast', assetId: `minecraft:entity/ghast/happy_ghast${baby ? '_baby' : ''}`, height: 64 };
  if (name === 'nautilus') return { model: baby ? 'nautilus_baby' : 'nautilus', assetId: `minecraft:entity/nautilus/nautilus${baby ? '_baby' : ''}`, height: baby ? 64 : 128 };
  if (name === 'camel_husk') return { model: 'camel', assetId: 'minecraft:entity/camel/camel_husk', height: 128 };
  if (FARM_VARIANTS[name]) {
    const minor = /^1\.(\d+)/.exec(version)?.[1];
    if (Number(minor) < 21 || /^1\.21(?:\.[0-4])?$/.test(version)) return null;
    const modernBaby = Number.parseInt(version, 10) >= 26;
    const defaults = modernBaby ? FARM_VARIANTS[name].map(entry => {
      const temperature = entry.key.split(':')[1];
      return { ...entry, value: { ...entry.value, asset_id: `minecraft:entity/${name}/${name}_${temperature}`, baby_asset_id: `minecraft:entity/${name}/${name}_${temperature}_baby` } };
    }) : FARM_VARIANTS[name];
    const data = variantData(registries, `minecraft:${name}_variant`, metadata('variant', 0), defaults);
    const suffix = data.model === 'cold' ? 'cold' : name === 'cow' && data.model === 'warm' ? 'warm' : 'modern';
    const nativeBaby = modernBaby && baby;
    return { model: nativeBaby ? `${name}_baby_modern` : `${name}_${suffix}`,
      assetId: asset((nativeBaby ? data.baby_asset_id : data.asset_id) ?? defaults[0].value.asset_id),
      height: nativeBaby && name !== 'cow' ? name === 'pig' ? 32 : 16 : name === 'chicken' ? 32 : 64 };
  }
  if (name !== 'zombie_nautilus') return null;
  const data = variantData(registries, 'minecraft:zombie_nautilus_variant', metadata('variant', 0), DEFAULT_NAUTILUS);
  return { model: data.model === 'warm' ? 'zombie_nautilus_coral' : 'nautilus', assetId: asset(data.asset_id ?? 'minecraft:entity/nautilus/zombie_nautilus'), height: 128 };
}

export function prepareModernEntity(track, input, { bodyItem, ridden = false } = {}) {
  const family = track.definition.name;
  const result = input.keyframes ?? new Map();
  const age = Math.max(0, input.time - (track.createdAt ?? 0)) * 20;
  if (family === 'happy_ghast') {
    for (let index = 0; index < 9; index++) {
      const pose = transform(); pose.rotation[0] = .2 * Math.sin(age * .3 + index) + .4;
      result.set(`tentacle${index}`, pose);
    }
    if (bodyItem?.present) {
      const pose = transform(); pose.scale = [-.0625, -.0625, -.0625]; result.set('body', pose);
    }
    const goggles = transform();
    const model = MODERN_ENTITY_MODELS[input.young ? 'happy_ghast_baby_harness' : 'happy_ghast_harness'];
    if (!ridden) {
      goggles.rotation[0] = -.7854;
      goggles.translation[1] = -5 * model.parts.find(part => part.name === 'goggles').scale;
    }
    result.set('goggles', goggles);
  } else if (family === 'nautilus' || family === 'zombie_nautilus') {
    advanceWalk(track, input);
    sampleEntityKeyframes(MODERN_ENTITY_KEYFRAMES.nautilus.SWIMMING,
      (input.walkPhase + age / 5) * 2 / 20, Math.min(1, (input.walkSpeed + .2) * 3), result);
    const body = result.get('body') ?? transform();
    body.rotation[0] += clamp(input.pitch || 0, -Math.PI / 18, Math.PI / 18);
    body.rotation[1] += clamp(input.headYaw || 0, -Math.PI / 18, Math.PI / 18);
    result.set('body', body);
  } else if (input.modernFarm) {
    advanceWalk(track, input);
    if (family === 'chicken') input.chickenFlapAngle = chickenFlap(track, age);
  }
  input.keyframes = result;
  return input;
}
