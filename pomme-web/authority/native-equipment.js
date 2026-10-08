// Native player-capable default slots, verified by executing the original
// mapped 1.20.4/1.21.11 item registry (scripts/extract-equipment.mjs).
// BODY/SADDLE components do not select a usable player equipment slot.
const HEAD = ['carved_pumpkin', 'turtle_helmet', 'skeleton_skull', 'wither_skeleton_skull', 'player_head', 'zombie_head', 'creeper_head', 'dragon_head', 'piglin_head'];
const MATERIALS = ['leather', 'chainmail', 'iron', 'diamond', 'golden', 'netherite'];
export function nativeEquipmentDefaults(version) {
  if (!['1.20.4', '1.21.11'].includes(version)) throw new Error('Native equipment data is unavailable for this version.');
  const result = new Map(HEAD.map(name => [name, 4])); result.set('elytra', 3); result.set('shield', 5);
  for (const material of version === '1.21.11' ? [...MATERIALS, 'copper'] : MATERIALS) for (const [suffix, slot] of [['boots', 1], ['leggings', 2], ['chestplate', 3], ['helmet', 4]]) result.set(`${material}_${suffix}`, slot);
  return result;
}
