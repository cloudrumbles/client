const strip = value => String(value || '').replace(/^minecraft:/u, '');
const DYES = ['white', 'orange', 'magenta', 'light_blue', 'yellow', 'lime', 'pink', 'gray', 'light_gray', 'cyan', 'purple', 'blue', 'brown', 'green', 'red', 'black'];

// Saved SpawnData contains the same persistent fields used by vanilla entity
// load methods. Convert only fields represented by the received registry;
// explicit metadata remains authoritative over the saved default.
export function previewEntityData(nbt, definition, registry) {
  nbt ||= {}; const keys = definition.metadataKeys || [], values = new Map(), set = (name, value) => { const key = keys.indexOf(name); if (key >= 0 && value !== undefined) values.set(key, value); };
  const field = (key, source = key, convert = value => value) => { if (nbt[source] !== undefined) set(key, convert(nbt[source])); };
  const name = definition.name, baby = Number(nbt.Age) < 0 || Boolean(nbt.IsBaby ?? nbt.Baby);
  if (baby) set('baby', true);
  field('silent', 'Silent', Boolean); field('no_gravity', 'NoGravity', Boolean); field('health', 'Health', Number);
  field('collar_color', 'CollarColor', Number); field('puff_state', 'PuffState', Number); field('type_variant', 'Variant', Number);
  field('remaining_anger_time', 'AngerTime', Number); field('chest', 'ChestedHorse', Boolean); field('saddle', 'Saddle', Boolean);
  if (name === 'sheep') set('wool', (Number(nbt.Color) & 15) | (nbt.Sheared ? 16 : 0));
  if (name === 'rabbit') field('type', 'RabbitType', Number);
  if (name === 'mooshroom') field('type', 'Type', strip);
  if (name === 'slime' || name === 'magma_cube') field('size', 'Size', value => Math.max(1, Number(value) + 1));
  if (name === 'wither') field('inv', 'Invul', Number);
  if (name === 'armor_stand') {
    set('client_flags', (nbt.Small ? 1 : 0) | (nbt.ShowArms ? 4 : 0) | (nbt.NoBasePlate ? 8 : 0) | (nbt.Marker ? 16 : 0));
    if (nbt.Invisible) set('shared_flags', 32);
    for (const [part, saved] of Object.entries({ head: 'Head', body: 'Body', left_arm: 'LeftArm', right_arm: 'RightArm', left_leg: 'LeftLeg', right_leg: 'RightLeg' })) if (Array.isArray(nbt.Pose?.[saved])) set(`${part}_pose`, nbt.Pose[saved]);
  }
  if (name === 'cat') { field('variant', 'CatType', Number); if (nbt.variant) set('variant', ['tabby', 'black', 'red', 'siamese', 'british_shorthair', 'calico', 'persian', 'ragdoll', 'white', 'jellie', 'all_black'].indexOf(strip(nbt.variant))); }
  if (name === 'wolf' || name === 'cat') set('flags', (nbt.Sitting ? 1 : 0) | (nbt.Owner || nbt.OwnerUUID ? 4 : 0));
  if (name === 'horse') set('flags', (nbt.Tame ? 2 : 0) | (nbt.SaddleItem ? 4 : 0));
  if (name === 'fox') { field('type', 'Type', value => strip(value) === 'snow' ? 1 : 0); set('flags', (nbt.Sitting ? 1 : 0) | (nbt.Crouching ? 4 : 0) | (nbt.Sleeping ? 32 : 0)); }
  if (name === 'frog') field('variant', 'variant', value => ['temperate', 'warm', 'cold'].indexOf(strip(value)));
  if (name === 'axolotl') field('variant', 'Variant', Number);
  if (name === 'llama' || name === 'trader_llama') { field('variant', 'Variant', Number); field('strength', 'Strength', Number); }
  if (name === 'boat' || name === 'chest_boat') field('type', 'Type', value => ['oak', 'spruce', 'birch', 'jungle', 'acacia', 'dark_oak', 'mangrove', 'bamboo', 'cherry'].indexOf(strip(value)));
  if (name === 'shulker') { field('color', 'Color', value => Math.min(16, Math.max(0, Number(value)))); field('attach_face', 'AttachFace', Number); field('peek', 'Peek', Number); }
  if (name === 'goat') { field('has_left_horn', 'HasLeftHorn', Boolean); field('has_right_horn', 'HasRightHorn', Boolean); }
  if (name === 'bee') set('flags', (nbt.HasNectar ? 8 : 0) | (nbt.HasStung ? 4 : 0));
  if (name === 'turtle') { field('has_egg', 'HasEgg', Boolean); field('laying_egg', 'LayingEgg', Boolean); }
  if (name === 'villager' || name === 'zombie_villager') {
    const saved = nbt.VillagerData; if (saved) set('villager_data', { type: ['desert', 'jungle', 'plains', 'savanna', 'snow', 'swamp', 'taiga'].indexOf(strip(saved.type)), profession: ['none', 'armorer', 'butcher', 'cartographer', 'cleric', 'farmer', 'fisherman', 'fletcher', 'leatherworker', 'librarian', 'mason', 'nitwit', 'shepherd', 'toolsmith', 'weaponsmith'].indexOf(strip(saved.profession)), level: Number(saved.level) || 1 });
  }
  const items = new Map((registry.items || []).map(item => [strip(item.name), item.id]));
  const item = saved => { const id = items.get(strip(saved?.id)); return id !== undefined && Number(saved.Count ?? saved.count ?? 1) > 0 ? { present: true, itemId: id, itemCount: Math.max(1, Math.min(127, Number(saved.Count ?? saved.count ?? 1))), nbtData: saved.tag } : { present: false }; };
  const equipment = [];
  for (let hand = 0; hand < 2; hand++) if (nbt.HandItems?.[hand]) equipment.push({ slot: hand, item: item(nbt.HandItems[hand]) });
  for (let armor = 0; armor < 4; armor++) if (nbt.ArmorItems?.[armor]) equipment.push({ slot: armor + 2, item: item(nbt.ArmorItems[armor]) });
  if (nbt.ArmorItem && /horse/u.test(name)) equipment.push({ slot: 4, item: item(nbt.ArmorItem) });
  if (nbt.DecorItem && /llama/u.test(name)) { const color = DYES.indexOf(strip(nbt.DecorItem.id).replace(/_carpet$/u, '')); if (color >= 0) set('swag', color); }
  if (name === 'panda') { const genes = ['normal', 'lazy', 'worried', 'playful', 'brown', 'weak', 'aggressive']; field('main_gene', 'MainGene', value => genes.indexOf(strip(value))); field('hidden_gene', 'HiddenGene', value => genes.indexOf(strip(value))); }
  return { metadata: [...values].map(([key, value]) => ({ key, value })), equipment };
}
