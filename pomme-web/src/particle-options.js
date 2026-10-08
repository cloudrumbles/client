const rgb = color => [(color >>> 16 & 255) / 255, (color >>> 8 & 255) / 255, (color & 255) / 255];
const BLOCK = new Set(['block', 'block_marker', 'falling_dust', 'dust_pillar', 'block_crumble']);

/** Native typed options, shared by modern world and explosion packets. */
export function normalizeParticleOptions(particle, normalizeSlot = value => value) {
  if (!particle || typeof particle.type !== 'string') return particle;
  const name = particle.type.replace(/^minecraft:/, ''), value = particle.data;
  let data = value && typeof value === 'object' ? { ...value } : {};
  if (BLOCK.has(name) && Number.isInteger(value)) data = { blockState: value };
  else if (name === 'item') data = { item: normalizeSlot(value) };
  else if (name === 'dust' && Number.isInteger(value?.color)) {
    const [red, green, blue] = rgb(value.color); data = { red, green, blue, scale: value.scale };
  } else if (name === 'dust_color_transition' && Number.isInteger(value?.fromColor) && Number.isInteger(value?.toColor)) {
    const [fromRed, fromGreen, fromBlue] = rgb(value.fromColor), [toRed, toGreen, toBlue] = rgb(value.toColor);
    data = { fromRed, fromGreen, fromBlue, toRed, toGreen, toBlue, scale: value.scale };
  } else if (['entity_effect', 'tinted_leaves', 'flash'].includes(name) && Number.isInteger(value)) {
    data = { color: rgb(value), ...(name === 'entity_effect' ? { alpha: (value >>> 24) / 255 } : {}) };
  } else if (['effect', 'instant_effect', 'trail'].includes(name) && Number.isInteger(value?.color)) data.color = rgb(value.color);
  else if (name === 'sculk_charge' && typeof value === 'number') data = { roll: value };
  else if (name === 'shriek' && Number.isInteger(value)) data = { delayInTicksBeforeShown: value };
  else if (name === 'vibration' && value?.positionType) data = { ...value, positionType: `minecraft:${value.positionType.replace(/^minecraft:/, '')}`, destination: value.position };
  return { ...particle, data };
}
