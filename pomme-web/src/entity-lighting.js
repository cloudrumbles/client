const clampNibble = (value, fallback) => Number.isFinite(value) ? Math.max(0, Math.min(15, Math.floor(value))) : fallback;
const metadata = (track, name, fallback = 0) => track.entity.metadata?.find(entry => entry.key === track.definition.metadataKeys?.indexOf(name))?.value ?? fallback;

export function entityLightProbe(track, position) {
  const name = track.definition.name, young = Boolean(metadata(track, 'baby'));
  let height = Number(track.definition.eyeHeight) || (track.definition.height || 1) * .85;
  if (name === 'player') { const pose = metadata(track, 'pose'); height = [1, 3, 4].includes(pose) ? .4 : pose === 5 ? 1.27 : pose === 2 ? .2 : 1.62; }
  if (name.includes('guardian')) height = track.definition.height * .5;
  if (young) height *= .5;
  return [position.x, position.y + height, position.z];
}

export function entityLightFlags(track, position, getLight) {
  const sample = getLight?.(entityLightProbe(track, position));
  const sky = clampNibble(sample?.sky ?? sample?.skyLight, 15);
  let block = clampNibble(sample?.block ?? sample?.blockLight, 0);
  // Original renderer overrides: fire, blazes, magma cubes and the wither
  // retain a block-light value of fifteen even in a dark cave.
  if ((metadata(track, 'shared_flags') & 1) || ['blaze', 'magma_cube', 'wither'].includes(track.definition.name)) block = 15;
  return 512 | (sky << 10) | (block << 14);
}
