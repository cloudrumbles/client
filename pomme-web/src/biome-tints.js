/** Native 1.20.4 tint rules, independently implemented from GrassColor,
 * FoliageColor, Biome, BlockColors, and ClientLevel.calculateBlockTint.
 * The compact factual table contains climate numbers and RGB constants only;
 * textures always come from the user's resource pack. */
export const TINT_KIND = Object.freeze({ NONE: 0, GRASS: 1, FOLIAGE: 2, WATER: 3, GRASS_BELOW: 4 });
const CLIMATE = {
  "badlands": [2,0,4159204,9470285,10387789,"none",12564309,11445290],
  "bamboo_jungle": [0.95,0.9,4159204,null,null,"none",5884220,3193611],
  "basalt_deltas": [2,0,4159204,null,null,"none",12564309,11445290],
  "beach": [0.8,0.4,4159204,null,null,"none",9551193,7842607],
  "birch_forest": [0.6,0.6,4159204,null,null,"none",8960870,7055680],
  "cherry_grove": [0.5,0.8,6141935,11983713,11983713,"none",8633197,6531400],
  "cold_ocean": [0.5,0.5,4020182,null,null,"none",9353585,7448397],
  "crimson_forest": [2,0,4159204,null,null,"none",12564309,11445290],
  "dark_forest": [0.7,0.8,4159204,null,null,"dark_forest",7979098,5877296],
  "deep_cold_ocean": [0.5,0.5,4020182,null,null,"none",9353585,7448397],
  "deep_dark": [0.8,0.4,4159204,null,null,"none",9551193,7842607],
  "deep_frozen_ocean": [0.5,0.5,3750089,null,null,"none",9353585,7448397],
  "deep_lukewarm_ocean": [0.5,0.5,4566514,null,null,"none",9353585,7448397],
  "deep_ocean": [0.5,0.5,4159204,null,null,"none",9353585,7448397],
  "desert": [2,0,4159204,null,null,"none",12564309,11445290],
  "dripstone_caves": [0.8,0.4,4159204,null,null,"none",9551193,7842607],
  "end_barrens": [0.5,0.5,4159204,null,null,"none",9353585,7448397],
  "end_highlands": [0.5,0.5,4159204,null,null,"none",9353585,7448397],
  "end_midlands": [0.5,0.5,4159204,null,null,"none",9353585,7448397],
  "eroded_badlands": [2,0,4159204,9470285,10387789,"none",12564309,11445290],
  "flower_forest": [0.7,0.8,4159204,null,null,"none",7979098,5877296],
  "forest": [0.7,0.8,4159204,null,null,"none",7979098,5877296],
  "frozen_ocean": [0,0.5,3750089,null,null,"none",8434839,6332795],
  "frozen_peaks": [-0.7,0.9,4159204,null,null,"none",8434839,6332795],
  "frozen_river": [0,0.5,3750089,null,null,"none",8434839,6332795],
  "grove": [-0.2,0.8,4159204,null,null,"none",8434839,6332795],
  "ice_spikes": [0,0.5,4159204,null,null,"none",8434839,6332795],
  "jagged_peaks": [-0.7,0.9,4159204,null,null,"none",8434839,6332795],
  "jungle": [0.95,0.9,4159204,null,null,"none",5884220,3193611],
  "lukewarm_ocean": [0.5,0.5,4566514,null,null,"none",9353585,7448397],
  "lush_caves": [0.5,0.5,4159204,null,null,"none",9353585,7448397],
  "mangrove_swamp": [0.8,0.9,3832426,null,9285927,"swamp",6997070,4568097],
  "meadow": [0.5,0.8,937679,null,null,"none",8633197,6531400],
  "mushroom_fields": [0.9,1,4159204,null,null,"none",5622079,2865935],
  "nether_wastes": [2,0,4159204,null,null,"none",12564309,11445290],
  "ocean": [0.5,0.5,4159204,null,null,"none",9353585,7448397],
  "old_growth_birch_forest": [0.6,0.6,4159204,null,null,"none",8960870,7055680],
  "old_growth_pine_taiga": [0.3,0.8,4159204,null,null,"none",8829055,6858079],
  "old_growth_spruce_taiga": [0.25,0.8,4159204,null,null,"none",8828803,6857828],
  "plains": [0.8,0.4,4159204,null,null,"none",9551193,7842607],
  "river": [0.5,0.5,4159204,null,null,"none",9353585,7448397],
  "savanna": [2,0,4159204,null,null,"none",12564309,11445290],
  "savanna_plateau": [2,0,4159204,null,null,"none",12564309,11445290],
  "small_end_islands": [0.5,0.5,4159204,null,null,"none",9353585,7448397],
  "snowy_beach": [0.05,0.3,4020182,null,null,"none",8631699,6595192],
  "snowy_plains": [0,0.5,4159204,null,null,"none",8434839,6332795],
  "snowy_slopes": [-0.3,0.9,4159204,null,null,"none",8434839,6332795],
  "snowy_taiga": [-0.5,0.4,4020182,null,null,"none",8434839,6332795],
  "soul_sand_valley": [2,0,4159204,null,null,"none",12564309,11445290],
  "sparse_jungle": [0.95,0.8,4159204,null,null,"none",6604607,4110351],
  "stony_peaks": [1,0.3,4159204,null,null,"none",10141259,8563742],
  "stony_shore": [0.2,0.3,4159204,null,null,"none",9090697,7185259],
  "sunflower_plains": [0.8,0.4,4159204,null,null,"none",9551193,7842607],
  "swamp": [0.8,0.9,6388580,null,6975545,"swamp",6997070,4568097],
  "taiga": [0.25,0.8,4159204,null,null,"none",8828803,6857828],
  "the_end": [0.5,0.5,4159204,null,null,"none",9353585,7448397],
  "the_void": [0.5,0.5,4159204,null,null,"none",9353585,7448397],
  "warm_ocean": [0.5,0.5,4445678,null,null,"none",9353585,7448397],
  "warped_forest": [2,0,4159204,null,null,"none",12564309,11445290],
  "windswept_forest": [0.2,0.3,4159204,null,null,"none",9090697,7185259],
  "windswept_gravelly_hills": [0.2,0.3,4159204,null,null,"none",9090697,7185259],
  "windswept_hills": [0.2,0.3,4159204,null,null,"none",9090697,7185259],
  "windswept_savanna": [2,0,4159204,null,null,"none",12564309,11445290],
  "wooded_badlands": [2,0,4159204,9470285,10387789,"none",12564309,11445290]
};
const clamp = value => Math.max(0, Math.min(1, value));

/** The native lookup uses a fixed 256-column texture, truncating toward zero. */
export function sampleColormap(map, temperature, downfall, fallback = 0x48b518) {
  if (!map?.pixelsRGBA || !Number.isInteger(map.width) || !Number.isInteger(map.height)) return fallback;
  const t = clamp(Math.fround(temperature)), d = clamp(Math.fround(downfall));
  const index = ((Math.trunc((1 - d * t) * 255) << 8) | Math.trunc((1 - t) * 255)) * 4;
  if (index + 2 >= map.pixelsRGBA.length) return fallback;
  const pixels = map.pixelsRGBA;
  return pixels[index] << 16 | pixels[index + 1] << 8 | pixels[index + 2];
}

export function createBiomeTints(registry, colormaps = null, definitions = null) {
  const supplied = definitions instanceof Map ? definitions : new Map(Object.entries(definitions ?? {}));
  const biomes = (registry?.biomes ?? []).slice(0, 4096).map(biome => {
    const name = String(biome.name).replace(/^minecraft:/, '');
    const known = CLIMATE[name] ?? [biome.temperature ?? .8, biome.downfall ?? .4, 4159204, null, null, 'none'];
    const definition = supplied.get(biome.name) ?? supplied.get(`minecraft:${name}`) ?? supplied.get(name);
    const temperature = definition?.temperature ?? known[0], downfall = definition?.downfall ?? known[1];
    const effects = definition?.effects ?? biome.effects ?? {};
    const grass = effects.grass_color ?? known[3] ?? sampleColormap(colormaps?.grass, temperature, downfall, known[6] ?? 0x7cbd6b);
    const foliage = effects.foliage_color ?? known[4] ?? sampleColormap(colormaps?.foliage, temperature, downfall, known[7] ?? 0x48b518);
    const water = effects.water_color ?? known[2];
    const modifier = effects.grass_color_modifier ?? known[5];
    return { id: biome.id, grass: grass >>> 0 & 0xffffff, foliage: foliage >>> 0 & 0xffffff, water: water >>> 0 & 0xffffff,
      modifier: modifier === 'dark_forest' ? 1 : modifier === 'swamp' ? 2 : 0 };
  });
  return { biomes, defaultBiome: registry?.biomes?.find(biome => biome.name.replace(/^minecraft:/, '') === 'plains')?.id ?? 0 };
}

export function applyBiomeTints(core, configuration, { blendRadius = 2, seed = 0n } = {}) {
  if (!core.biome_tints_register) return;
  if (!Number.isInteger(blendRadius) || blendRadius < 0 || blendRadius > 7) throw new Error('Biome blend radius must be between 0 and 7.');
  core.biome_tints_clear();
  for (const biome of configuration.biomes) {
    if (!core.biome_tints_register(biome.id, biome.grass, biome.foliage, biome.water, biome.modifier)) throw new Error(`Invalid biome tint definition ${biome.id}.`);
  }
  if (!core.world_set_biome_default(configuration.defaultBiome) || !core.world_set_biome_blend_radius(blendRadius)) throw new Error('WASM rejected biome tint configuration.');
  setBiomeSeed(core, seed);
}
export function setBiomeSeed(core, seed) {
  const value = BigInt.asUintN(64, BigInt(seed ?? 0));
  if (core.world_set_biome_seed && !core.world_set_biome_seed(Number(value & 0xffffffffn), Number(value >> 32n))) throw new Error('WASM rejected biome seed.');
}

export const tintComponents = color => [color >>> 16 & 255, color >>> 8 & 255, color & 255].map(channel => channel / 255);
/** Item BlockColors have no world/position and use the native fixed defaults. */
export function defaultBiomeTint(kind, colormaps = null) {
  return tintComponents(kind === 1 || kind === 4 ? sampleColormap(colormaps?.grass, .5, 1, 0x7cbd6b) : kind === 2 ? 4764952 : 0xffffff);
}
/** Guava SHA256.hashLong is little-endian for both input and asLong output. */
export async function hashBiomeSeed(rawSeed, crypto = globalThis.crypto) {
  const bytes = new Uint8Array(8); new DataView(bytes.buffer).setBigUint64(0, BigInt.asUintN(64, BigInt(rawSeed)), true);
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  return new DataView(hash).getBigInt64(0, true);
}

const unsignedLong = value => BigInt.asUintN(64, value);
const biomeLcg = (seed, salt) => unsignedLong(seed * (seed * 6364136223846793005n + 1442695040888963407n) + salt);
function nativeBiomeQuart(seed, position) {
  const cell = position.map(value => Math.floor((value - 2) / 4)), fractions = position.map(value => ((value - 2) % 4 + 4) % 4 / 4);
  let selected = cell, best = Infinity;
  for (let corner = 0; corner < 8; corner++) {
    const offset = cell.map((_value, axis) => (corner & (4 >> axis)) ? 1 : 0), quart = cell.map((value, axis) => value + offset[axis]);
    let state = seed;
    for (const value of [...quart, ...quart]) state = biomeLcg(state, BigInt(value));
    const jitter = [];
    for (let axis = 0; axis < 3; axis++) { jitter.push((Number((BigInt.asIntN(64, state) >> 24n) & 1023n) / 1024 - .5) * .9); if (axis < 2) state = biomeLcg(state, seed); }
    const square = axis => (fractions[axis] - offset[axis] + jitter[axis]) ** 2;
    const distance = square(2) + square(1) + square(0);
    if (distance < best) { best = distance; selected = quart; }
  }
  return selected;
}
let swampPermutation;
function swampNoise(x, z) {
  if (!swampPermutation) {
    let seed = (2345n ^ 0x5deece66dn) & ((1n << 48n) - 1n);
    const next = bits => { seed = (seed * 0x5deece66dn + 11n) & ((1n << 48n) - 1n); return Number(seed >> BigInt(48 - bits)); };
    for (let i = 0; i < 3; i++) { next(26); next(27); }
    swampPermutation = Uint8Array.from({ length: 256 }, (_value, index) => index);
    for (let i = 0; i < 256; i++) {
      const bound = 256 - i;
      let value;
      if ((bound & (bound - 1)) === 0) value = Math.floor(bound * next(31) / 2147483648);
      else { let bits; do { bits = next(31); value = bits % bound; } while (((bits - value + bound - 1) | 0) < 0); }
      const old = swampPermutation[i]; swampPermutation[i] = swampPermutation[i + value]; swampPermutation[i + value] = old;
    }
  }
  const p = value => swampPermutation[(value % 256 + 256) % 256], f = (Math.sqrt(3) - 1) * .5, g = (3 - Math.sqrt(3)) / 6;
  const skew = (x + z) * f, i = Math.floor(x + skew), j = Math.floor(z + skew), unskew = (i + j) * g;
  const x0 = x - (i - unskew), z0 = z - (j - unskew), di = x0 > z0 ? 1 : 0, dj = 1 - di;
  const gradients = [[1,1],[-1,1],[1,-1],[-1,-1],[1,0],[-1,0],[1,0],[-1,0],[0,1],[0,-1],[0,1],[0,-1]];
  const corner = (dx, dz, px, pz) => {
    let t = .5 - px * px - pz * pz; if (t < 0) return 0;
    const gradient = gradients[p(i + dx + p(j + dz)) % 12]; t *= t;
    return t * t * (gradient[0] * px + gradient[1] * pz);
  };
  return 70 * (corner(0, 0, x0, z0) + corner(di, dj, x0 - di + g, z0 - dj + g) + corner(1, 1, x0 - 1 + 2 * g, z0 - 1 + 2 * g));
}

/** Exact CPU fallback for compact distant meshes; browser workers use WASM. */
export function createBiomeSampler(configuration, { seed = 0n, blendRadius = 2, columns = [] } = {}) {
  const colors = new Map(configuration.biomes.map(biome => [biome.id, biome]));
  const records = new Map(columns.map(column => [`${column.x},${column.z}`, column]));
  const samples = new Map(), tints = new Map(); seed = unsignedLong(BigInt(seed));
  const biomeAt = position => {
    const key = position.join(','); if (samples.has(key)) return samples.get(key);
    const quart = nativeBiomeQuart(seed, position), cx = Math.floor(quart[0] / 4), cz = Math.floor(quart[2] / 4), record = records.get(`${cx},${cz}`);
    const minQuartY = (record?.minY ?? -64) / 4, quartHeight = (record?.height ?? 384) / 4;
    const qy = Math.max(minQuartY, Math.min(minQuartY + quartHeight - 1, quart[1]));
    const index = ((qy - minQuartY) * 4 + ((quart[2] % 4 + 4) % 4)) * 4 + ((quart[0] % 4 + 4) % 4);
    const id = record?.biomes?.[index] ?? configuration.defaultBiome;
    const biome = colors.get(id) ?? colors.get(configuration.defaultBiome) ?? { grass: 0x7cbd6b, foliage: 0x48b518, water: 4159204, modifier: 0 };
    if (samples.size < 131072) samples.set(key, biome);
    return biome;
  };
  return (x, y, z, kind) => {
    if (!kind) return [1, 1, 1]; if (kind === 4) { y--; kind = 1; }
    const key = `${x},${y},${z},${kind}`; if (tints.has(key)) return tints.get(key);
    const sum = [0, 0, 0];
    for (let sz = z - blendRadius; sz <= z + blendRadius; sz++) for (let sx = x - blendRadius; sx <= x + blendRadius; sx++) {
      const biome = biomeAt([sx, y, sz]); let color = biome[['', 'grass', 'foliage', 'water'][kind]];
      if (kind === 1) { if (biome.modifier === 1) color = ((color & 0xfefefe) + 2634762) >> 1; else if (biome.modifier === 2) color = swampNoise(sx * .0225, sz * .0225) < -.1 ? 5011004 : 6975545; }
      sum[0] += color >>> 16 & 255; sum[1] += color >>> 8 & 255; sum[2] += color & 255;
    }
    const count = (blendRadius * 2 + 1) ** 2, value = sum.map(channel => Math.floor(channel / count) / 255);
    if (tints.size < 131072) tints.set(key, value); return value;
  };
}
