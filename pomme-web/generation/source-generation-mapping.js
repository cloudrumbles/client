export const SOURCE_VERSION = '1.21.11';
export const SOURCE_COMMIT = '70b31323967bb99fd4feefab8e96124be369cd6f';
export function mapSourceRegistry(source, target) {
  if (source?.minecraftVersion !== SOURCE_VERSION || source.sourceCommit !== SOURCE_COMMIT || target?.version !== SOURCE_VERSION)
    throw new Error('Source generation requires the exact Minecraft 1.21.11 registry.');
  if (!Array.isArray(source.states) || source.states.length < 1 || source.states.length > 65536 || !Array.isArray(source.biomes) || source.biomes.length > 256 || !Array.isArray(target.biomes) || target.biomes.length > 4096 || typeof target.lookup !== 'function') throw new Error('Invalid source generation registry.');
  const states = new Uint16Array(source.states.length), knownStates = new Uint8Array(source.states.length);
  for (const state of source.states) {
    if (!Number.isInteger(state.id) || state.id < 0 || state.id >= states.length || knownStates[state.id]) throw new Error('Invalid source state ID.');
    const id = target.lookup(state.name, state.properties);
    if (!Number.isInteger(id) || id < 0 || id > 65535) throw new Error(`Unsupported source state: ${state.name} ${JSON.stringify(state.properties)}`);
    states[state.id] = id; knownStates[state.id] = 1;
  }
  if (knownStates.some(value => !value)) throw new Error('Incomplete source state registry.');
  const names = new Map(target.biomes.map(biome => [biome.name.includes(':') ? biome.name : `minecraft:${biome.name}`, biome.id]));
  const biomes = new Uint32Array(256), knownBiomes = new Uint8Array(256);
  for (const biome of source.biomes) {
    const id = names.get(biome.name);
    if (!Number.isInteger(biome.id) || biome.id < 0 || biome.id > 255 || knownBiomes[biome.id] || !Number.isInteger(id) || id < 0 || id > 4294967295) throw new Error(`Unsupported source biome: ${biome.name}`);
    biomes[biome.id] = id; knownBiomes[biome.id] = 1;
  }
  return { states, knownStates, biomes, knownBiomes };
}
export function mapGeneratedColumn(result, mapping) {
  if (!(result.blocks instanceof Uint16Array) || !(result.biomes instanceof Uint8Array) || !Number.isInteger(result.minY) || result.minY % 16 || !Number.isInteger(result.height) || result.height < 16 || result.height > 1024 || result.height % 16 || result.blocks.length !== result.height * 256 || result.biomes.length !== result.height * 4 || !Number.isInteger(result.x) || !Number.isInteger(result.z)) throw new Error('Invalid source generation column.');
  const sections = [];
  for (let offset = 0; offset < result.height / 16; offset++) {
    const states = new Uint16Array(4096), biomes = new Uint32Array(64);
    for (let index = 0; index < 4096; index++) {
      const source = result.blocks[offset * 4096 + index];
      if (!mapping.knownStates[source]) throw new Error(`Unregistered generated state ID: ${source}`);
      states[index] = mapping.states[source];
    }
    for (let index = 0; index < 64; index++) {
      const source = result.biomes[offset * 64 + index];
      if (!mapping.knownBiomes[source]) throw new Error(`Unregistered generated biome ID: ${source}`);
      biomes[index] = mapping.biomes[source];
    }
    sections.push({ cx: result.x, cz: result.z, sectionY: result.minY / 16 + offset, states, biomes });
  }
  return { x: result.x, z: result.z, minY: result.minY, height: result.height, sections, sourceVersion: SOURCE_VERSION, sourceCommit: SOURCE_COMMIT, generationStage: result.stage };
}
