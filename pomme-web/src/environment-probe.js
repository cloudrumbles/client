// Native 1.20.4 BiomeManager water-fog lookup and 1.21.11 environment attribute
// layers, Gaussian biome sampling and lazy partial-tick probe interpolation.
// Source data is supplied by the user's biome/dimension/timeline registries.
import { nativeBiomeQuart } from './biome-tints.js';
import { compileEnvironmentEase } from './environment-easing.js';

const f = Math.fround, EMPTY = Object.freeze({});
const clamp = (x, low, high) => Math.max(low, Math.min(high, x));
const lerp = (t, a, b) => f(f(a) + f(f(t) * f(f(b) - f(a))));
const names = ['minecraft:visual/water_fog_color', 'minecraft:visual/water_fog_start_distance', 'minecraft:visual/water_fog_end_distance', 'minecraft:visual/fog_color', 'minecraft:visual/fog_start_distance', 'minecraft:visual/fog_end_distance', 'minecraft:visual/sky_fog_end_distance', 'minecraft:visual/cloud_fog_end_distance', 'minecraft:visual/sky_color', 'minecraft:visual/sunrise_sunset_color', 'minecraft:visual/sun_angle'];
const kinds = ['color', 'float', 'float', 'color', 'float', 'float', 'float', 'float', 'color', 'argb', 'angle'];
const isColor = index => kinds[index] === 'color' || kinds[index] === 'argb';
const nonnegative = new Set([2, 5, 6, 7]);
export const ATMOSPHERIC_FOG_ATTRIBUTES = Object.freeze({ color: names[3], start: names[4], end: names[5], skyEnd: names[6], cloudEnd: names[7], skyColor: names[8], sunriseSunsetColor: names[9], sunAngle: names[10] });
export const WATER_FOG_ATTRIBUTES = Object.freeze({ color: names[0], start: names[1], end: names[2] });
export const ENVIRONMENT_PROBE_LIMITS = Object.freeze({ biomes: 4096, timelines: 32, keyframesPerTrack: 1024, gaussianSamples: 216, diagnostics: 32 });
const defaults = [0xff050533, -8, 96, 0xff000000, 0, 1024, 512, 2048, 0xff000000, 0, 0];
const gaussian = [0, 1, 4, 6, 4, 1, 0];
const resource = value => typeof value === 'string' && /^(?:[a-z0-9_.-]+:)?[a-z0-9_./-]{1,128}$/.test(value) ? value.includes(':') ? value : `minecraft:${value}` : null;
const attribute = (map, name) => map?.[name] ?? map?.[name.replace(/^minecraft:/, '')];
const numeric = value => { if (!Number.isFinite(value) || !Number.isFinite(f(value))) throw new Error('Native fog attribute requires a finite float.'); return f(value); };
function color(value, alpha = false, allowRGBVector = false) {
  if (Number.isInteger(value) && value >= -2147483648 && value <= 0xffffffff) return value >>> 0;
  if (Array.isArray(value) && (value.length === (alpha ? 4 : 3) || alpha && allowRGBVector && value.length === 3)) {
    const channel = at => clamp(Math.floor(f(numeric(at) * 255)), -2147483648, 2147483647);
    return pack([value.length === 4 ? channel(value[3]) : 255, ...value.slice(0, 3).map(channel)]);
  }
  if (typeof value !== 'string' || !(alpha ? /^#[a-f0-9]{8}$/i : /^#[a-f0-9]{6}$/i).test(value)) throw new Error('Native fog color requires its RGB/ARGB save codec.');
  return (Number.parseInt(value.slice(1), 16) | (alpha ? 0 : 0xff000000)) >>> 0;
}
const channels = value => [value >>> 24, value >>> 16 & 255, value >>> 8 & 255, value & 255];
const pack = values => (values[0] << 24 | values[1] << 16 | values[2] << 8 | values[3]) >>> 0;
export function nativeFogColorLerp(amount, left, right) {
  const a = channels(left), b = channels(right), t = f(amount);
  return pack(a.map((value, axis) => value + Math.floor(f(t * f(b[axis] - value)))));
}
function argument(kind, modifier, value) {
  if (kind === 'color' || kind === 'argb') {
    if (modifier === 'blend_to_gray') {
      const brightness = numeric(value?.brightness), factor = numeric(value?.factor);
      if (brightness < 0 || brightness > 1 || factor < 0 || factor > 1) throw new Error('Native gray blend parameters are outside [0,1].');
      return { brightness, factor };
    }
    return color(value, modifier === 'alpha_blend' || kind === 'argb' && (modifier === 'override' || modifier === 'multiply'), kind === 'argb' && modifier === 'multiply');
  }
  if (modifier === 'alpha_blend') {
    const alpha = numeric(typeof value === 'number' ? 1 : value?.alpha ?? 1); if (alpha < 0 || alpha > 1) throw new Error('Native float alpha is outside [0,1].');
    return { value: numeric(typeof value === 'number' ? value : value?.value), alpha };
  }
  return numeric(value);
}
function modifierName(value, kind) {
  const id = typeof value === 'string' ? value.replace(/^minecraft:/, '') : 'override';
  const supported = kind === 'color' || kind === 'argb' ? ['override', 'alpha_blend', 'add', 'subtract', 'multiply', 'blend_to_gray'] : ['override', 'alpha_blend', 'add', 'subtract', 'multiply', 'minimum', 'maximum'];
  if (!supported.includes(id)) throw new Error(`Unsupported native water-fog modifier: ${String(value).slice(0, 128)}`);
  return id;
}
function apply(kind, modifier, base, value) {
  if (modifier === 'override') return value;
  if (kind === 'float' || kind === 'angle') {
    if (modifier === 'alpha_blend') return lerp(value.alpha, base, value.value);
    if (modifier === 'add') return f(base + value);
    if (modifier === 'subtract') return f(base - value);
    if (modifier === 'multiply') return f(base * value);
    if (modifier === 'minimum') return Math.min(base, value);
    return Math.max(base, value);
  }
  const a = channels(base), b = modifier === 'blend_to_gray' ? null : channels(value);
  if (modifier === 'add' || modifier === 'subtract') return pack(a.map((channel, i) => i ? clamp(channel + (modifier === 'add' ? b[i] : -b[i]), 0, 255) : channel));
  if (modifier === 'multiply') return pack(a.map((channel, i) => Math.trunc(channel * b[i] / 255)));
  if (modifier === 'alpha_blend') {
    if (b[0] === 255) return value;
    if (b[0] === 0) return base;
    const alpha = b[0] + Math.trunc(a[0] * (255 - b[0]) / 255);
    return pack([alpha, ...a.slice(1).map((channel, i) => Math.trunc((b[i + 1] * b[0] + channel * (alpha - b[0])) / alpha))]);
  }
  const gray = Math.trunc(f(f(f(a[1] * f(.3)) + f(a[2] * f(.59))) + f(a[3] * f(.11))));
  const scaled = clamp(Math.trunc(f(gray * value.brightness)), 0, 255);
  return nativeFogColorLerp(value.factor, base, pack([a[0], scaled, scaled, scaled]));
}
export function applyWaterFogModifier(kind, base, entry) {
  if (!['color', 'float'].includes(kind)) throw new Error('Unknown water-fog attribute type.');
  const explicit = entry && typeof entry === 'object' && !Array.isArray(entry);
  if (explicit && (typeof entry.modifier !== 'string' || !Object.hasOwn(entry, 'argument'))) throw new Error('Native attribute entry requires modifier and argument fields.');
  const modifier = modifierName(explicit ? entry.modifier : 'override', kind);
  return apply(kind, modifier, kind === 'color' ? color(base) : numeric(base), argument(kind, modifier, explicit ? entry.argument : entry));
}
export function applyAtmosphericWeatherAttribute(kind, value, { rain = 0, thunder = 0 } = {}) {
  if (!['fog', 'sky', 'sunrise'].includes(kind)) throw new Error('Unknown native atmospheric weather attribute.');
  if (![rain, thunder].every(level => Number.isFinite(level) && level >= 0 && level <= 1)) throw new Error('Native atmospheric weather levels are outside [0,1].');
  let color = value >>> 0;
  for (const [level, brightness, factor, multiplier] of [[f(f(rain) - f(thunder)), f(.6), f(.75), 0xff7f7f99], [f(thunder), f(.24), f(.94), 0xff3f3f4c]]) {
    if (level <= 0) continue;
    const changed = kind === 'sky' ? apply('color', 'blend_to_gray', color, { brightness, factor }) : apply('color', 'multiply', color, multiplier);
    color = nativeFogColorLerp(level, color, changed);
  }
  return color;
}
function compileEntry(raw, kind) {
  const explicit = raw && typeof raw === 'object' && !Array.isArray(raw);
  if (explicit && (typeof raw.modifier !== 'string' || !Object.hasOwn(raw, 'argument'))) throw new Error('Native attribute entry requires modifier and argument fields.');
  const modifier = modifierName(explicit ? raw.modifier : 'override', kind);
  const value = argument(kind, modifier, explicit ? raw.argument : raw);
  return base => apply(kind, modifier, base, value);
}
function mixArgument(kind, modifier, t, a, b) {
  if (modifier === 'blend_to_gray') return { brightness: lerp(t, a.brightness, b.brightness), factor: lerp(t, a.factor, b.factor) };
  if (kind === 'float' && modifier === 'alpha_blend') return { value: lerp(t, a.value, b.value), alpha: lerp(t, a.alpha, b.alpha) };
  return kind === 'color' || kind === 'argb' ? nativeFogColorLerp(t, a, b) : lerp(t, a, b);
}
function compileTrack(track, kind, period) {
  if (!track || !Array.isArray(track.keyframes) || !track.keyframes.length || track.keyframes.length > ENVIRONMENT_PROBE_LIMITS.keyframesPerTrack) throw new Error('Native water-fog track exceeds its keyframe bound.');
  const modifier = modifierName(track.modifier, kind), ease = compileEnvironmentEase(track.ease);
  let previous = -1;
  const frames = track.keyframes.map(frame => {
    if (!Number.isInteger(frame.ticks) || frame.ticks < 0 || frame.ticks > 2147483647 || period !== null && frame.ticks > period || frame.ticks < previous) throw new Error('Invalid native water-fog keyframe order/range.');
    previous = frame.ticks; return { ticks: frame.ticks, value: argument(kind, modifier, frame.value) };
  });
  // Preserve the actual codec's adjacent-equality counter, including its
  // first/last comparison, rather than substituting a stricter save validator.
  let equal = 0; previous = frames.at(-1).ticks;
  if (frames.length > 1) for (const frame of frames) { if (frame.ticks === previous) { if (++equal > 2) throw new Error('Native water-fog track has excess equal-tick keyframes.'); } else equal = 0; previous = frame.ticks; }
  const segments = [];
  if (frames.length === 1) segments.push({ from: frames[0], to: frames[0] });
  else {
    const first = frames[0], last = frames.at(-1);
    if (period !== null) segments.push({ from: { ...last, ticks: last.ticks - period }, to: first });
    for (let i = 1; i < frames.length; i++) segments.push({ from: frames[i - 1], to: frames[i] });
    if (period !== null) segments.push({ from: last, to: { ...first, ticks: first.ticks + period } });
  }
  return (base, dayTime) => {
    const at = period === null ? dayTime : (dayTime % BigInt(period) + BigInt(period)) % BigInt(period);
    const { from, to } = segments.find(segment => at < BigInt(segment.to.ticks)) ?? segments.at(-1);
    const value = at <= BigInt(from.ticks) ? from.value : at >= BigInt(to.ticks) ? to.value : mixArgument(kind, modifier, ease(f(f(Number(at - BigInt(from.ticks))) / f(to.ticks - from.ticks))), from.value, to.value);
    return apply(kind, modifier, base, value);
  };
}

// Source factual exceptions in vanilla biome JSON; every normal biome uses the
// native default. Each built-in biome still has its own attribute-map identity.
const vanillaNames = new Set('badlands bamboo_jungle basalt_deltas beach birch_forest cherry_grove cold_ocean crimson_forest dark_forest deep_cold_ocean deep_dark deep_frozen_ocean deep_lukewarm_ocean deep_ocean desert dripstone_caves end_barrens end_highlands end_midlands eroded_badlands flower_forest forest frozen_ocean frozen_peaks frozen_river grove ice_spikes jagged_peaks jungle lukewarm_ocean lush_caves mangrove_swamp meadow mushroom_fields nether_wastes ocean old_growth_birch_forest old_growth_pine_taiga old_growth_spruce_taiga pale_garden plains river savanna savanna_plateau small_end_islands snowy_beach snowy_plains snowy_slopes snowy_taiga soul_sand_valley sparse_jungle stony_peaks stony_shore sunflower_plains swamp taiga the_end the_void warm_ocean warped_forest windswept_forest windswept_gravelly_hills windswept_hills windswept_savanna wooded_badlands'.split(' '));
const specialColors = { lukewarm_ocean: 0x041633, deep_lukewarm_ocean: 0x041633, warm_ocean: 0x041f33, swamp: 0x232317, mangrove_swamp: 0x4d7a60 };
const modernColors = { ...specialColors, cherry_grove: 0x5db7ef, pale_garden: 0x556980 };
const builtinTimelines = new Set(['minecraft:day', 'minecraft:moon', 'minecraft:early_game', 'minecraft:villager_schedule']);
const builtinTags = { 'minecraft:universal': ['minecraft:villager_schedule'], 'minecraft:in_overworld': ['#minecraft:universal', 'minecraft:day', 'minecraft:moon', 'minecraft:early_game'], 'minecraft:in_end': ['#minecraft:universal'], 'minecraft:in_nether': ['#minecraft:universal'] };

/** Read exact loaded quart biomes; modern network IDs/definitions take precedence. */
export function createFogBiomeLookup({ world, registry, registries = new Map(), definitions = new Map() } = {}) {
  const supplied = definitions instanceof Map ? definitions : new Map(Object.entries(definitions ?? {}));
  const fallback = registry?.biomes?.find(biome => biome.name.replace(/^minecraft:/, '') === 'plains')?.id ?? 0;
  if ((registry?.biomes?.length ?? 0) > ENVIRONMENT_PROBE_LIMITS.biomes || supplied.size > ENVIRONMENT_PROBE_LIMITS.biomes) throw new Error('Native fog biome registry exceeds its bound.');
  const named = new Map((registry?.biomes ?? []).map(biome => [biome.id, biome]));
  let previousEntries, remoteById = new Map(), remoteDefault = fallback;
  return (qx, qy, qz) => {
    if (![qx, qy, qz].every(Number.isInteger)) throw new Error('Native fog requires integral quart coordinates.');
    const minY = world?.core?.world_min_y?.() ?? world?.minY ?? -64, height = world?.core?.world_height?.() ?? world?.height ?? 384;
    const y = clamp(qy, minY / 4, (minY + height) / 4 - 1), column = world?.columns?.get(`${Math.floor(qx / 4)},${Math.floor(qz / 4)}`);
    const section = column?.sections?.find(section => section.sectionY === Math.floor(y / 4));
    const entries = registries.get('minecraft:worldgen/biome');
    if (entries && entries.length > ENVIRONMENT_PROBE_LIMITS.biomes) throw new Error('Native server fog biome registry exceeds its bound.');
    if (entries !== previousEntries) {
      if (entries !== undefined && !Array.isArray(entries)) throw new Error('Native server fog biome registry requires ordered entries.');
      const next = new Map(); let plains;
      for (const [index, entry] of (entries ?? []).entries()) {
        const id = entry?.id ?? index;
        if (!entry || !Number.isInteger(id) || id < 0 || id > 2147483647 || next.has(id)) throw new Error('Native server fog biome IDs are invalid or duplicated.');
        next.set(id, entry); if (resource(entry.key ?? entry.name) === 'minecraft:plains') plains = id;
      }
      previousEntries = entries; remoteById = next; remoteDefault = entries === undefined ? fallback : plains;
    }
    const index = ((y % 4 + 4) % 4) * 16 + ((qz % 4 + 4) % 4) * 4 + ((qx % 4 + 4) % 4), id = section?.biomes?.[index] ?? remoteDefault;
    // Native network IDs belong to the transmitted registry. A missing entry
    // cannot be interpreted using a different version's static numeric IDs.
    const remote = remoteById.get(id), biome = entries === undefined ? named.get(id) : remote;
    const name = resource(biome?.key ?? biome?.name);
    return { id, name, definition: remote?.value ?? remote?.element ?? supplied.get(name) ?? supplied.get(name?.replace(/^minecraft:/, '')) ?? biome?.definition ?? (biome?.effects || biome?.attributes ? biome : undefined) };
  };
}

/** Sources are immutable between registry/pack transactions. Reset on a new
 * player/world/dimension; leave water-vision timing to EnvironmentFog. */
export class NativeFogAttributeProbe {
  constructor({ version = '1.20.4', getNoiseBiome, seed = 0n, dimensionId = 'minecraft:overworld', dimensionAttributes,
    timelines = [], timelineDefinitions = new Map(), timelineTags = new Map(), closerWaterFog } = {}) {
    if (!['1.20.4', '1.21.11', '26.1'].includes(version) || typeof getNoiseBiome !== 'function') throw new Error('Fog probe requires a supported native version and noise-biome reader.');
    if (typeof seed !== 'bigint' && !Number.isSafeInteger(seed)) throw new Error('Native fog biome seed requires an integral source long.');
    this.version = version; this.getNoiseBiome = getNoiseBiome; this.seed = BigInt.asIntN(64, BigInt(seed)); this.closerWaterFog = closerWaterFog;
    this.maps = new WeakMap(); this.identities = new WeakMap(); this.builtinBiomes = new Map(); this.dimension = dimensionAttributes ?? EMPTY;
    this.identity(this.dimension);
    this.dimensionKnown = dimensionAttributes !== undefined || ['minecraft:overworld', 'minecraft:overworld_caves', 'minecraft:the_nether', 'minecraft:the_end'].includes(resource(dimensionId));
    this.timelineDefinitions = timelineDefinitions instanceof Map ? timelineDefinitions : new Map(Object.entries(timelineDefinitions));
    this.timelineTags = timelineTags instanceof Map ? timelineTags : new Map(Object.entries(timelineTags));
    if (this.timelineDefinitions.size > 4096 || this.timelineTags.size > 4096) throw new Error('Native fog timeline registry exceeds its bound.');
    this.timelineSources = []; this.missingTimelineSources = []; this.timelineReferences = 0;
    this.expandTimelines(timelines); this.reset();
  }
  reset() { this.position = null; this.playerPosition = null; this.dayTime = 0n; this.weights = new Map(); this.probes = new Map(); this.diagnostics = []; }
  warn(reason) { if (!this.diagnostics.includes(reason) && this.diagnostics.length < ENVIRONMENT_PROBE_LIMITS.diagnostics) this.diagnostics.push(reason); }
  expandTimelines(entries, seen = new Set(), depth = 0) {
    const values = typeof entries === 'string' ? [entries] : entries;
    if (!Array.isArray(values) || values.length > ENVIRONMENT_PROBE_LIMITS.timelines || depth > 16) throw new Error('Native fog timeline/tag references exceed their bound.');
    for (const entry of values) {
      if (++this.timelineReferences > 256) throw new Error('Native fog has too many timeline/tag references.');
      if (typeof entry === 'string' && entry.startsWith('#')) {
        const tag = resource(entry.slice(1)); if (!tag || seen.has(tag)) throw new Error('Invalid or cyclic native fog timeline tag.');
        const data = this.timelineTags.get(tag) ?? builtinTags[tag];
        if (!data) { this.missingTimelineSources.push(`Missing native timeline tag ${tag}.`); continue; }
        const next = new Set(seen); next.add(tag); this.expandTimelines(Array.isArray(data) ? data : data.values, next, depth + 1); continue;
      }
      const reference = typeof entry === 'object' && entry && typeof entry.id === 'string' ? entry.id : entry;
      if (reference !== entry) {
        const name = reference.startsWith('#') ? resource(reference.slice(1)) : resource(reference);
        const known = reference.startsWith('#') ? this.timelineTags.has(name) || Object.hasOwn(builtinTags, name) : this.timelineDefinitions.has(name) || builtinTimelines.has(name);
        if (entry.required === false && !known) continue;
        this.expandTimelines([reference], seen, depth); continue;
      }
      const id = typeof entry === 'string' ? resource(entry) : null, raw = id ? this.timelineDefinitions.get(id) : entry;
      if (!raw && builtinTimelines.has(id)) continue; // These original tracks have no water-fog attributes.
      if (!raw) { this.missingTimelineSources.push(`Missing native timeline ${String(id).slice(0, 128)}.`); continue; }
      if (this.timelineSources.length >= ENVIRONMENT_PROBE_LIMITS.timelines) throw new Error('Native fog has too many expanded timelines.');
      const period = raw.period_ticks ?? null;
      if (period !== null && (!Number.isInteger(period) || period <= 0 || period > 2147483647)) throw new Error('Native timeline period must be a positive int.');
      const tracks = names.map((name, i) => { const track = attribute(raw.tracks, name); return track === undefined ? null : compileTrack(track, kinds[i], period); });
      this.timelineSources.push({ tracks, clock: this.version === '26.1' ? resource(raw.clock) : null });
    }
  }
  definition(biome) {
    if (biome?.definition) return biome.definition;
    const name = biome?.name?.replace(/^minecraft:/, '');
    if (!biome?.name?.startsWith('minecraft:') || !vanillaNames.has(name) || this.version === '1.20.4' && name === 'pale_garden') { this.warn(`Missing source biome definition ${String(biome?.name).slice(0, 128)}.`); return { attributes: EMPTY }; }
    let definition = this.builtinBiomes.get(name);
    if (!definition) {
      const attributes = { __native_biome_identity: name };
      if (modernColors[name] !== undefined) attributes[names[0]] = modernColors[name];
      if (name === 'swamp' || name === 'mangrove_swamp') attributes[names[2]] = { modifier: 'multiply', argument: .85 };
      definition = { attributes, effects: { water_fog_color: specialColors[name] ?? 0x050533 } }; this.builtinBiomes.set(name, definition);
    }
    return definition;
  }
  compiled(map) {
    if (!map || typeof map !== 'object' || Array.isArray(map)) throw new Error('Native water-fog attributes require a source map.');
    let compiled = this.maps.get(map);
    if (!compiled) { compiled = names.map((name, i) => { const raw = attribute(map, name); return raw === undefined ? null : compileEntry(raw, kinds[i]); }); this.maps.set(map, compiled); }
    return compiled;
  }
  identity(map) {
    if (!map || typeof map !== 'object' || Array.isArray(map)) throw new Error('Native water-fog attributes require a source map.');
    let identity = this.identities.get(map);
    if (!identity) {
      const size = Object.keys(map).length; if (size > 4096) throw new Error('Native water-fog attribute map exceeds its bound.');
      // An explicitly decoded empty map has its own native object identity;
      // only an absent map uses the shared EMPTY default.
      identity = map; this.identities.set(map, identity);
    }
    return identity;
  }
  tick({ position, playerPosition = position, dayTime = 0n, clocks, weather = {} } = {}) {
    if (![position, playerPosition].every(value => value?.length === 3 && Array.from(value).every(Number.isFinite)) || typeof dayTime !== 'bigint' && !Number.isSafeInteger(dayTime)) throw new Error('Native fog probe requires finite camera/player positions and integral source day time.');
    if (clocks !== undefined && (!(clocks instanceof Map) || clocks.size > 4096)) throw new Error('Native fog world clocks require a bounded source map.');
    const rain = weather.rain ?? 0, thunder = weather.thunder ?? 0;
    if (![rain, thunder].every(level => Number.isFinite(level) && level >= 0 && level <= 1)) throw new Error('Native atmospheric weather levels are outside [0,1].');
    this.position = Array.from(position); this.playerPosition = Array.from(playerPosition); this.dayTime = BigInt.asIntN(64, BigInt(dayTime)); this.clocks = clocks; this.weather = { rain: f(rain), thunder: f(thunder) }; this.diagnostics = []; this.weights.clear();
    if (!this.dimensionKnown) this.warn('Missing source dimension water-fog attributes.');
    for (const missing of this.missingTimelineSources) this.warn(missing);
    for (const [name, probe] of this.probes) { if (probe.current === null) this.probes.delete(name); else { probe.previous = probe.current; probe.current = null; } }
    if (this.version === '1.20.4') return;
    const point = this.position.map(value => value / 4 - .5), cell = point.map(Math.floor), fractions = point.map((value, i) => value - cell[i]);
    for (let z = 0; z < 6; z++) for (let x = 0; x < 6; x++) for (let y = 0; y < 6; y++) {
      const weight = [x, y, z].reduce((value, at, axis) => value * (gaussian[at + 1] + fractions[axis] * (gaussian[at] - gaussian[at + 1])), 1);
      const definition = this.definition(this.getNoiseBiome(cell[0] - 2 + x, cell[1] - 2 + y, cell[2] - 2 + z)), raw = definition.attributes ?? EMPTY;
      const map = this.identity(raw);
      this.weights.set(map, (this.weights.get(map) ?? 0) + weight);
    }
  }
  sampleLegacyAtmosphere(brightnessFactors = [1, 1, 1]) {
    if (this.version !== '1.20.4' || !this.position) throw new Error('Legacy atmosphere requires its native camera tick.');
    const point = this.position.map(value => (value - 2) * .25), cell = point.map(Math.floor), fractions = point.map((value, axis) => value - cell[axis]);
    const fog = [0, 0, 0], sky = [0, 0, 0]; let total = 0;
    for (let x = 0; x < 6; x++) for (let y = 0; y < 6; y++) for (let z = 0; z < 6; z++) {
      const weight = [x, y, z].reduce((value, at, axis) => value * (gaussian[at + 1] + fractions[axis] * (gaussian[at] - gaussian[at + 1])), 1);
      const biome = this.getNoiseBiome(cell[0] - 2 + x, cell[1] - 2 + y, cell[2] - 2 + z), definition = this.definition(biome);
      const fogColor = definition.effects?.fog_color, skyColor = definition.effects?.sky_color;
      if (fogColor === undefined || skyColor === undefined) this.warn(`Missing legacy atmospheric colors for ${String(biome?.name).slice(0, 128)}.`);
      const a = channels(color(fogColor ?? 0)).slice(1), b = channels(color(skyColor ?? 0)).slice(1);
      total += weight;
      for (let axis = 0; axis < 3; axis++) { fog[axis] += a[axis] / 255 * brightnessFactors[axis] * weight; sky[axis] += b[axis] / 255 * weight; }
    }
    return { fogColor: fog.map(value => value * (1 / total)), skyColor: sky.map(value => value * (1 / total)), fogBrightnessApplied: true };
  }
  compute(index) {
    let value = defaults[index]; const dimension = this.compiled(this.dimension)[index]; if (dimension) value = dimension(value);
    let blended = null, total = 0;
    for (const [map, weight] of this.weights) {
      const modifier = this.compiled(map)[index], sample = modifier ? modifier(value) : value; total += weight;
      blended = blended === null ? sample : isColor(index) ? nativeFogColorLerp(f(weight / total), blended, sample) : lerp(f(weight / total), blended, sample);
    }
    if (blended !== null) value = blended;
    for (const { tracks, clock } of this.timelineSources) if (tracks[index]) {
      const sourceTime = clock && this.clocks ? this.clocks.get(clock) : this.dayTime;
      if (sourceTime === undefined) { this.warn(`Missing native timeline world clock ${clock}.`); continue; }
      if (typeof sourceTime !== 'bigint' && !Number.isSafeInteger(sourceTime)) throw new Error('Native timeline world clock requires its integral source long.');
      value = tracks[index](value, BigInt.asIntN(64, BigInt(sourceTime)));
    }
    if (index === 3 || index === 8 || index === 9) value = applyAtmosphericWeatherAttribute(index === 3 ? 'fog' : index === 8 ? 'sky' : 'sunrise', value, this.weather);
    value = nonnegative.has(index) ? Math.max(0, value) : value;
    if (!Number.isFinite(value)) throw new Error('Native fog attribute overflowed its finite render range.');
    return value;
  }
  value(index, partialTick) {
    let probe = this.probes.get(index);
    if (!probe) { const value = this.compute(index); probe = { previous: value, current: value }; this.probes.set(index, probe); }
    else if (probe.current === null) probe.current = this.compute(index);
    if (kinds[index] === 'angle') {
      let difference = f(f(probe.current) - f(probe.previous)) % 360;
      if (difference >= 180) difference -= 360; if (difference < -180) difference += 360;
      return Math.abs(difference) >= 90 ? probe.current : f(f(probe.previous) + f(f(partialTick) * f(difference)));
    }
    return isColor(index) ? nativeFogColorLerp(partialTick, probe.previous, probe.current) : lerp(partialTick, probe.previous, probe.current);
  }
  sampleAtmosphere(partialTick = 0) {
    if (!this.position || !Number.isFinite(partialTick) || partialTick < 0 || partialTick > 1) throw new Error('Native atmospheric probe requires its tick and partial tick.');
    if (this.version === '1.20.4') throw new Error('Legacy atmosphere uses its original double Gaussian color sampler.');
    return { fogColor: this.value(3, f(partialTick)), fogStart: this.value(4, f(partialTick)), fogEnd: this.value(5, f(partialTick)), skyFogEnd: this.value(6, f(partialTick)), cloudFogEnd: this.value(7, f(partialTick)), skyColor: this.value(8, f(partialTick)), sunriseSunsetColor: this.value(9, f(partialTick)), sunAngle: this.value(10, f(partialTick)) };
  }
  sample(partialTick = 0) {
    if (!this.position) throw new Error('Tick the native fog probe before reading its values.');
    if (!Number.isFinite(partialTick) || partialTick < 0 || partialTick > 1) throw new Error('Native fog partial tick is outside [0,1].');
    if (this.version === '1.20.4') {
      const quart = nativeBiomeQuart(this.seed, this.position.map(Math.floor)), biome = this.getNoiseBiome(...quart), definition = this.definition(biome);
      const value = definition.effects?.water_fog_color ?? definition.waterFogColor;
      if (value === undefined) this.warn(`Missing legacy water-fog color for ${String(biome?.name).slice(0, 128)}.`);
      // Legacy FogRenderer samples color at the camera, but its closer-fog tag
      // at LocalPlayer.blockPosition(), which can select a different biome.
      const playerQuart = nativeBiomeQuart(this.seed, this.playerPosition.map(Math.floor));
      const playerBiome = playerQuart.every((value, axis) => value === quart[axis]) ? biome : this.getNoiseBiome(...playerQuart);
      return { waterFogColor: color(value ?? 0x050533) & 0xffffff, waterFogStart: -8, waterFogEnd: 96,
        closerWaterFog: this.closerWaterFog ? Boolean(this.closerWaterFog(playerBiome)) : ['minecraft:swamp', 'minecraft:mangrove_swamp'].includes(playerBiome?.name),
        resolved: this.diagnostics.length === 0, diagnostics: this.diagnostics.slice() };
    }
    return { waterFogColor: this.value(0, f(partialTick)) & 0xffffff, waterFogStart: this.value(1, f(partialTick)), waterFogEnd: this.value(2, f(partialTick)),
      closerWaterFog: false, resolved: this.diagnostics.length === 0, diagnostics: this.diagnostics.slice() };
  }
}
