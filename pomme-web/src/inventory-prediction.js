import { menuName } from './container-ui.js';

const empty = () => ({ present: false });
const has = stack => stack?.present !== false && (stack?.itemCount || 0) > 0;
const copy = stack => has(stack) ? { ...stack } : empty();
const amount = (stack, count) => count > 0 ? { ...stack, present: true, itemCount: count } : empty();
function canonical(value) {
  if (typeof value === 'bigint') return ['bigint', String(value)];
  if (ArrayBuffer.isView(value)) return Array.from(value);
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}
const json = value => JSON.stringify(canonical(value));
const componentType = entry => String(entry.type).replace('minecraft:', '');
const removedType = entry => String(entry?.type || entry).replace('minecraft:', '');
const unwrap = value => Array.isArray(value) ? value.map(unwrap) : value && typeof value === 'object' ? value.type && 'value' in value ? unwrap(value.value?.type && 'value' in value.value ? value.value.value : value.value) : Object.fromEntries(Object.entries(value).map(([key, item]) => [key, unwrap(item)])) : value;
const FUEL_NAMES = new Set(['lava_bucket', 'coal_block', 'blaze_rod', 'coal', 'charcoal', 'bamboo_mosaic', 'bamboo_mosaic_stairs', 'bamboo_mosaic_slab', 'note_block', 'bookshelf', 'chiseled_bookshelf', 'lectern', 'jukebox', 'chest', 'trapped_chest', 'crafting_table', 'daylight_detector', 'bow', 'fishing_rod', 'ladder', 'wooden_shovel', 'wooden_sword', 'wooden_spear', 'wooden_hoe', 'wooden_axe', 'wooden_pickaxe', 'stick', 'bowl', 'dried_kelp_block', 'crossbow', 'bamboo', 'dead_bush', 'short_dry_grass', 'tall_dry_grass', 'scaffolding', 'loom', 'barrel', 'cartography_table', 'fletching_table', 'smithing_table', 'composter', 'azalea', 'flowering_azalea', 'mangrove_roots', 'leaf_litter']);
const FUEL_TAGS = ['logs', 'bamboo_blocks', 'planks', 'wooden_stairs', 'wooden_slabs', 'wooden_trapdoors', 'wooden_pressure_plates', 'wooden_shelves', 'wooden_fences', 'fence_gates', 'banners', 'signs', 'hanging_signs', 'wooden_doors', 'boats', 'wool', 'wooden_buttons', 'saplings', 'wool_carpets'];
const BREWING_INGREDIENTS = new Set(['nether_wart', 'redstone', 'glowstone_dust', 'fermented_spider_eye', 'gunpowder', 'dragon_breath', 'sugar', 'rabbit_foot', 'glistering_melon_slice', 'spider_eye', 'pufferfish', 'magma_cream', 'golden_carrot', 'blaze_powder', 'ghast_tear', 'turtle_helmet', 'phantom_membrane', 'stone', 'slime_block', 'cobweb', 'breeze_rod']);
export function isFurnaceFuel(definition, tags = new Map()) {
  return definition && !tags.get('minecraft:non_flammable_wood')?.has(definition.id) && (FUEL_NAMES.has(definition.name) || FUEL_TAGS.some(tag => tags.get(`minecraft:${tag}`)?.has(definition.id)));
}
export function sameStack(a, b) {
  if (!has(a) || !has(b) || a.itemId !== b.itemId) return false;
  const modern = Array.isArray(a.components) || Array.isArray(b.components);
  return json(stackParts(a, modern)) === json(stackParts(b, modern));
}
function stackParts(stack, modern = Array.isArray(stack.components), depth = 0) {
  const value = item => {
    if (depth > 16) return null;
    if (Array.isArray(item)) return item.map(value);
    if (!item || typeof item !== 'object' || ArrayBuffer.isView(item)) return item;
    if ('itemCount' in item) return has(item) ? { itemId: item.itemId, itemCount: item.itemCount, ...stackParts(item, true, depth + 1) } : null;
    return Object.fromEntries(Object.entries(item).map(([key, item]) => [key, value(item)]));
  };
  return { nbt: modern ? null : stack.nbtData?.type === 'compound' ? { type: 'compound', value: stack.nbtData.value } : stack.nbtData ?? null,
    components: (stack.components || []).map(entry => ({ type: componentType(entry), data: value(entry.data) })).sort((a, b) => a.type.localeCompare(b.type)), removed: (stack.removeComponents || []).map(removedType).sort() };
}
export function stackLimit(stack, definitions) {
  const override = stack?.components?.find(entry => componentType(entry) === 'max_stack_size')?.data;
  return Number.isInteger(override) && override > 0 ? Math.min(99, override) : definitions.get(stack?.itemId)?.stackSize || 64;
}
export function stackable(stack, definitions, modern = Array.isArray(stack?.components)) {
  if (stackLimit(stack, definitions) <= 1) return false;
  const definition = definitions.get(stack?.itemId), nbt = unwrap(stack?.nbtData);
  if (!modern) return !(definition?.maxDurability > 0 && !nbt?.Unbreakable && nbt?.Damage > 0);
  const removed = new Set((stack.removeComponents || []).map(removedType));
  const durability = removed.has('max_damage') ? 0 : component(stack, 'max_damage')?.data ?? definition?.maxDurability ?? 0;
  const unbreakable = !removed.has('unbreakable') && Boolean(component(stack, 'unbreakable'));
  const damage = removed.has('damage') ? 0 : component(stack, 'damage')?.data || 0;
  return !(durability > 0 && !unbreakable && damage > 0);
}

const REMAINDERS = new Map([['water_bucket', 'bucket'], ['lava_bucket', 'bucket'], ['milk_bucket', 'bucket'], ['dragon_breath', 'glass_bottle'], ['honey_bottle', 'glass_bottle']]);
const definitionNames = new WeakMap();
function namesFor(definitions) {
  let names = definitionNames.get(definitions);
  if (!names) { names = new Map([...definitions.values()].map(item => [item.name, item])); definitionNames.set(definitions, names); }
  return names;
}
const patternCount = stack => unwrap(stack?.nbtData)?.BlockEntityTag?.Patterns?.length || 0;

// Ingredient.test compares item IDs, including for stacks with custom NBT.
export function matchesCraftingRecipe(recipe, grid, width, definitions) {
  const data = recipe.data || {}, type = recipe.type?.replace('minecraft:', ''), occupied = grid.filter(has);
  const accepts = (ingredient, stack) => has(stack) ? ingredient?.some(item => item.itemId === stack.itemId) : !ingredient?.length;
  if (type === 'crafting_shaped') {
    const ingredients = Array.isArray(data.ingredients?.[0]?.[0]) ? data.ingredients.flat() : data.ingredients;
    if (!(data.width > 0 && data.height > 0) || data.width > width || data.height > grid.length / width) return false;
    for (let top = 0; top <= grid.length / width - data.height; top++) for (let left = 0; left <= width - data.width; left++) for (const mirror of [false, true]) {
      let match = true;
      for (let index = 0; index < grid.length && match; index++) {
        const x = index % width - left, y = Math.floor(index / width) - top;
        const ingredient = x >= 0 && x < data.width && y >= 0 && y < data.height ? ingredients?.[(mirror ? data.width - x - 1 : x) + y * data.width] : [];
        match = accepts(ingredient, grid[index]);
      }
      if (match) return true;
    }
    return false;
  }
  if (type === 'crafting_shapeless') {
    const ingredients = data.ingredients || [];
    if (occupied.length !== ingredients.length || ingredients.length > 9) return false;
    const match = (index, used) => index === ingredients.length || occupied.some((stack, position) => !(used & 1 << position) && accepts(ingredients[index], stack) && match(index + 1, used | 1 << position));
    return match(0, 0);
  }
  if (type === 'crafting_special_bookcloning') {
    const originals = occupied.filter(stack => definitions.get(stack.itemId)?.name === 'written_book');
    return originals.length === 1 && originals[0].nbtData != null && occupied.length > 1 && occupied.every(stack => ['written_book', 'writable_book'].includes(definitions.get(stack.itemId)?.name));
  }
  if (type === 'crafting_special_bannerduplicate') {
    return occupied.length === 2 && occupied[0].itemId === occupied[1].itemId && /_banner$/.test(definitions.get(occupied[0].itemId)?.name || '') && occupied.every(stack => patternCount(stack) <= 6) && occupied.filter(stack => patternCount(stack) > 0).length === 1;
  }
  return false;
}

export function craftingRemainders(grid, { modern, recipes, width, definitions }) {
  // 1.21.11 ResultSlot deliberately uses only default item remainders on the
  // client. Recipe displays are presentation and cannot select a recipe.
  const recipe = modern ? null : [...recipes.values()].find(value => matchesCraftingRecipe(value, grid, width, definitions));
  if (!modern && !recipe) return null;
  const names = namesFor(definitions), type = recipe?.type?.replace('minecraft:', '');
  return grid.map(stack => {
    const name = definitions.get(stack.itemId)?.name, remainder = names.get(REMAINDERS.get(name));
    if (remainder) return { present: true, itemId: remainder.id, itemCount: 1 };
    if (type === 'crafting_special_bookcloning' && name === 'written_book' || type === 'crafting_special_bannerduplicate' && patternCount(stack) > 0) return amount(stack, 1);
    return empty();
  });
}

const component = (stack, type) => stack?.components?.find(entry => componentType(entry) === type);
const isBundleItem = (stack, definitions) => /(?:^|_)bundle$/.test(definitions.get(stack?.itemId)?.name || '');
function legacyContents(stack, definitions) {
  const names = namesFor(definitions), list = stack?.nbtData?.type === 'compound' ? stack.nbtData.value?.Items?.value?.value || [] : stack?.nbtData?.Items || [];
  return Array.isArray(list) ? list.slice(0, 128).flatMap(entry => {
    const value = unwrap(entry), definition = names.get(String(value.id || '').replace('minecraft:', ''));
    if (!definition || !(value.Count > 0)) return [];
    const rawTag = entry?.tag;
    return [{ present: true, itemId: definition.id, itemCount: value.Count, nbtData: rawTag?.type ? rawTag : value.tag }];
  }) : [];
}
export function bundleContents(stack, definitions, modern = true) {
  if (modern) return (component(stack, 'bundle_contents')?.data?.contents || []).slice(0, 128).filter(has).map(copy);
  return legacyContents(stack, definitions);
}
function nbtTag(value) {
  if (value?.type && 'value' in value) return structuredClone(value);
  if (typeof value === 'string') return { type: 'string', value };
  if (typeof value === 'number') return { type: Number.isInteger(value) ? 'int' : 'double', value };
  if (typeof value === 'bigint') return { type: 'long', value };
  if (Array.isArray(value)) return { type: 'list', value: { type: value.length ? nbtTag(value[0]).type : 'end', value: value.map(item => nbtTag(item).value) } };
  return { type: 'compound', value: Object.fromEntries(Object.entries(value || {}).map(([key, item]) => [key, nbtTag(item)])) };
}
function withBundleContents(stack, contents, definitions, modern) {
  if (modern) {
    const components = [...(stack.components || []).filter(entry => componentType(entry) !== 'bundle_contents'), ...(contents.length ? [{ type: 'bundle_contents', data: { contents } }] : [])];
    return { ...stack, components, addedComponentCount: components.length, bundleSelectedItem: -1 };
  }
  const tag = nbtTag(stack.nbtData || {}), value = tag.value;
  if (contents.length) value.Items = { type: 'list', value: { type: 'compound', value: contents.map(item => ({ id: { type: 'string', value: `minecraft:${definitions.get(item.itemId).name}` }, Count: { type: 'byte', value: item.itemCount }, ...(item.nbtData ? { tag: nbtTag(item.nbtData) } : {}) })) } };
  else delete value.Items;
  return { ...stack, nbtData: Object.keys(value).length ? { ...tag, name: stack.nbtData?.name || '' } : undefined };
}
const gcd = (a, b) => { while (b) [a, b] = [b, a % b]; return a; };
const fraction = (numerator, denominator = 1n) => { const divisor = gcd(numerator, denominator); return [numerator / divisor, denominator / divisor]; };
const add = (a, b) => fraction(a[0] * b[1] + b[0] * a[1], a[1] * b[1]);
function bundleWeight(stack, definitions, modern, depth = 0) {
  if (depth > 16) return [1n, 1n];
  const bundled = modern ? component(stack, 'bundle_contents') || isBundleItem(stack, definitions) && !stack.removeComponents?.some(entry => removedType(entry) === 'bundle_contents') : isBundleItem(stack, definitions);
  if (bundled) return bundleContents(stack, definitions, modern).reduce((weight, item) => { const unit = bundleWeight(item, definitions, modern, depth + 1); return add(weight, [unit[0] * BigInt(item.itemCount), unit[1]]); }, [1n, 16n]);
  const bees = modern ? component(stack, 'bees')?.data?.bees : ['beehive', 'bee_nest'].includes(definitions.get(stack.itemId)?.name) ? unwrap(stack.nbtData)?.BlockEntityTag?.Bees : [];
  if (bees?.length) return [1n, 1n];
  const limit = stackLimit(stack, definitions);
  return modern ? [1n, BigInt(limit)] : [BigInt(Math.floor(64 / limit)), 64n];
}
export function bundleCapacity(bundle, item, definitions, modern = true) {
  const total = bundleContents(bundle, definitions, modern).reduce((weight, stack) => { const unit = bundleWeight(stack, definitions, modern); return add(weight, [unit[0] * BigInt(stack.itemCount), unit[1]]); }, [0n, 1n]);
  const unit = bundleWeight(item, definitions, modern);
  return total[0] >= total[1] || unit[0] <= 0n ? 0 : Number((total[1] - total[0]) * unit[1] / (total[1] * unit[0]));
}
export function bundleView(stack, definitions, { modern = true, componentId = modern ? 48 : null } = {}) {
  if (!has(stack) || !isBundleItem(stack, definitions)) return null;
  const contents = bundleContents(stack, definitions, modern), count = contents.length;
  const total = contents.reduce((weight, item) => { const unit = bundleWeight(item, definitions, modern); return add(weight, [unit[0] * BigInt(item.itemCount), unit[1]]); }, [0n, 1n]);
  const partial = count % 4, shown = Math.min(count, (count > 12 ? 11 : 12) - (partial ? 4 - partial : 0));
  const rows = Math.ceil(Math.min(12, count) / 4), overflow = count > 12;
  const cells = Array.from({ length: rows * 4 }, () => null), first = cells.length - shown - (overflow ? 1 : 0);
  for (let index = 0; index < shown; index++) cells[first + index] = { index, stack: contents[index] };
  const hiddenCount = contents.slice(shown).reduce((count, item) => count + item.itemCount, 0);
  if (overflow) cells[cells.length - 1] = { surplus: hiddenCount };
  const tooltip = component(stack, 'tooltip_display')?.data;
  return { contents, cells, shown, selected: modern ? stack.bundleSelectedItem ?? -1 : -1, weight: Number(total[0]) / Number(total[1]),
    full: total[0] >= total[1], fill: Math.max(0, Math.min(94, Number(total[0] * 94n / total[1]))), hiddenCount,
    tooltipVisible: !stack.removeComponents?.some(type => removedType(type) === 'bundle_contents') && !tooltip?.hideTooltip && !tooltip?.hiddenComponents?.includes(componentId) };
}

function bundleInsert(bundle, item, definitions, modern) {
  const name = definitions.get(item?.itemId)?.name || '';
  if (!has(item) || /(?:^|_)shulker_box$/.test(name)) return { bundle, item, inserted: 0 };
  const count = Math.min(item.itemCount, bundleCapacity(bundle, item, definitions, modern));
  if (!count) return { bundle, item, inserted: 0 };
  const contents = bundleContents(bundle, definitions, modern);
  const matching = (!modern ? !isBundleItem(item, definitions) : stackable(item, definitions, true)) ? contents.findIndex(stack => sameStack(item, stack)) : -1;
  const previous = matching >= 0 ? contents.splice(matching, 1)[0].itemCount : 0;
  contents.unshift(amount(item, previous + count));
  return { bundle: withBundleContents(bundle, contents, definitions, modern), item: amount(item, item.itemCount - count), inserted: count };
}
function bundleRemove(bundle, definitions, modern) {
  const contents = bundleContents(bundle, definitions, modern);
  const selected = modern && Number.isInteger(bundle.bundleSelectedItem) && bundle.bundleSelectedItem >= 0 && bundle.bundleSelectedItem < contents.length ? bundle.bundleSelectedItem : 0;
  const item = contents.splice(selected, 1)[0] || empty();
  return { bundle: withBundleContents(bundle, contents, definitions, modern), item };
}

// Behavioral port of AbstractContainerMenu.doClick and moveItemStackTo.
export function predictInventoryClick({ window, slot, button, mode, menu = {}, definitions, playerWindow, creative = false, modern = false, tags = new Map(), recipes = new Map(), properties = new Map(), drag = null, selectedSlot = 0 }) {
  const slots = window.slots.map(copy), original = window.slots, playerSlots = playerWindow?.slots.map(copy) || [];
  let cursor = copy(window.cursor), nextDrag = drag;
  const name = window.windowId === 0 ? 'player' : menuName(menu.inventoryType);
  const count = name === 'player' ? 9 : name === 'lectern' ? slots.length : slots.length - 36;
  const itemName = stack => definitions.get(stack?.itemId)?.name || '';
  const tagged = (stack, tag) => tags.get(`minecraft:${tag}`)?.has(stack.itemId) || false;
  const fuel = stack => isFurnaceFuel(definitions.get(stack?.itemId), tags);
  const ingredientHas = (ingredient, stack) => ingredient?.some(entry => entry.itemId === stack.itemId);
  const recipeInput = (type, stack, key = 'ingredient') => [...recipes.values()].some(recipe => recipe.type === `minecraft:${type}` && ingredientHas(recipe.data?.[key], stack));
  const property = (key, stack, recipeType, ingredientKey = 'ingredient') => modern ? properties.get(`minecraft:${key}`)?.has(stack.itemId) || false : recipeInput(recipeType, stack, ingredientKey);
  const canSmelt = stack => property(`${name}_input`, stack, { furnace: 'smelting', blast_furnace: 'blasting', smoker: 'smoking' }[name]);
  const armorIndex = stack => {
    const item = itemName(stack), category = definitions.get(stack?.itemId)?.enchantCategories || [];
    if (category.includes('armor_head') || /(?:_helmet|_head|_skull)$/.test(item) || item === 'carved_pumpkin') return 5;
    if (category.includes('armor_chest') || /_chestplate$/.test(item) || item === 'elytra') return 6;
    if (category.includes('armor_legs') || /_leggings$/.test(item)) return 7;
    if (category.includes('armor_feet') || /_boots$/.test(item)) return 8;
    return -1;
  };
  const output = index => name === 'player' || name === 'crafting' ? index === 0 : ({ anvil: 2, merchant: 2, furnace: 2, blast_furnace: 2, smoker: 2, grindstone: 2, cartography_table: 2, loom: 3, smithing: 3, stonecutter: 1, crafter_3x3: 45 })[name] === index;
  const max = (index, stack) => Math.min(stackLimit(stack, definitions), name === 'player' && index >= 5 && index <= 8 || name === 'horse' && index < 2 || name === 'enchantment' && index === 0 || name === 'brewing_stand' && index < 3 || ['furnace', 'blast_furnace', 'smoker'].includes(name) && index === 1 && itemName(stack) === 'bucket' ? 1 : modern ? 99 : 64);
  const mayPlace = (index, stack) => {
    if (!has(stack) || output(index) || name === 'lectern') return false;
    if (name === 'player' && index >= 5 && index <= 8) return armorIndex(stack) === index;
    if (name === 'horse' && index < 2) {
      const horse = menu.horseType || 'horse', item = itemName(stack);
      if (index === 0) return (menu.saddleEnabled ?? !/llama/.test(horse)) && item === 'saddle' && (menu.modern || !has(slots[index]));
      return /llama/.test(horse) ? /_carpet$/.test(item) : (menu.armorEnabled ?? (horse === 'horse' || menu.modern && horse === 'zombie_horse')) && /_horse_armor$/.test(item);
    }
    if (index >= count || name === 'player') return true;
    const item = itemName(stack);
    if (name === 'enchantment' && index === 1) return item === 'lapis_lazuli';
    if (name === 'beacon') return tagged(stack, 'beacon_payment_items') || ['netherite_ingot', 'emerald', 'diamond', 'gold_ingot', 'iron_ingot'].includes(item);
    if (name === 'brewing_stand') return index < 3 ? ['potion', 'splash_potion', 'lingering_potion', 'glass_bottle'].includes(item) : index === 4 ? item === 'blaze_powder' : BREWING_INGREDIENTS.has(item) && (modern || !['stone', 'slime_block', 'cobweb', 'breeze_rod'].includes(item));
    if (['furnace', 'blast_furnace', 'smoker'].includes(name) && index === 1) return fuel(stack) || item === 'bucket';
    if (name === 'cartography_table') return index === 0 ? item === 'filled_map' : ['paper', 'map', 'glass_pane'].includes(item);
    if (name === 'grindstone') return Boolean(definitions.get(stack.itemId)?.maxDurability) || item === 'enchanted_book' || Boolean(unwrap(stack.nbtData)?.Enchantments?.length) || Boolean(stack.components?.find(entry => componentType(entry) === 'enchantments')?.data?.enchantments?.length);
    if (name === 'smithing') return index === 0 ? property('smithing_template', stack, 'smithing_transform', 'template') || !modern && recipeInput('smithing_trim', stack, 'template') : index === 1 ? property('smithing_base', stack, 'smithing_transform', 'base') || !modern && recipeInput('smithing_trim', stack, 'base') : property('smithing_addition', stack, 'smithing_transform', 'addition') || !modern && recipeInput('smithing_trim', stack, 'addition');
    if (name === 'loom') return index === 0 ? /_banner$/.test(item) : index === 1 ? /_dye$/.test(item) : /_banner_pattern$/.test(item);
    return true;
  };
  const mayPickup = index => {
    if (name !== 'player' || index < 5 || index > 8 || creative) return true;
    const stack = slots[index], nbt = unwrap(stack?.nbtData);
    return !((nbt?.Enchantments || nbt?.value?.Enchantments?.value?.value || []).some(entry => String(entry.id?.value || entry.id).endsWith('binding_curse')));
  };
  const move = (stack, indices) => {
    let remaining = stack.itemCount;
    for (const index of indices) if (stackable(stack, definitions, modern) && sameStack(stack, slots[index]) && mayPlace(index, stack)) {
      const take = Math.max(0, Math.min(remaining, max(index, stack) - slots[index].itemCount));
      if (take) { slots[index] = amount(stack, slots[index].itemCount + take); remaining -= take; }
      if (!remaining) break;
    }
    for (const index of indices) if (remaining && !has(slots[index]) && mayPlace(index, stack)) {
      const take = Math.min(remaining, max(index, stack)); slots[index] = amount(stack, take); remaining -= take;
    }
    return amount(stack, remaining);
  };
  const range = (start, end, reverse = false) => { const result = Array.from({ length: Math.max(0, end - start) }, (_, i) => start + i); return reverse ? result.reverse() : result; };
  const addToPlayer = stack => {
    const inventoryIndices = name === 'player' ? [...range(36, 45), ...range(9, 36)] : [...range(count + 27, slots.length), ...range(count, count + 27)];
    let remaining = stack.itemCount;
    const selected = name === 'player' ? 36 + selectedSlot : count + 27 + selectedSlot;
    const mergeSlot = index => { if (remaining && stackable(stack, definitions, modern) && sameStack(stack, slots[index])) {
      const take = Math.max(0, Math.min(remaining, stackLimit(stack, definitions) - slots[index].itemCount));
      slots[index] = amount(stack, slots[index].itemCount + take); remaining -= take;
    } };
    mergeSlot(selected);
    const offhand = name === 'player' ? slots[45] : playerSlots[45];
    if (remaining && stackable(stack, definitions, modern) && sameStack(stack, offhand)) {
      const take = Math.max(0, Math.min(remaining, stackLimit(stack, definitions) - offhand.itemCount));
      if (name === 'player') slots[45] = amount(stack, offhand.itemCount + take); else playerSlots[45] = amount(stack, offhand.itemCount + take);
      remaining -= take;
    }
    for (const index of inventoryIndices) if (index !== selected) mergeSlot(index);
    for (const index of inventoryIndices) if (remaining && !has(slots[index])) { const take = Math.min(remaining, stackLimit(stack, definitions)); slots[index] = amount(stack, take); remaining -= take; }
  };
  const onTake = index => {
    if (index !== 0 || !['player', 'crafting'].includes(name)) return;
    const width = name === 'player' ? 2 : 3, grid = slots.slice(1, 1 + width * width);
    const remainders = craftingRemainders(grid, { modern, recipes, width, definitions });
    if (!remainders) return;
    for (let offset = 0; offset < grid.length; offset++) {
      const index = offset + 1, remainder = remainders[offset];
      if (has(slots[index])) slots[index] = amount(slots[index], slots[index].itemCount - 1);
      if (!has(remainder)) continue;
      if (!has(slots[index])) slots[index] = remainder;
      else if (sameStack(slots[index], remainder)) slots[index] = amount(remainder, remainder.itemCount + slots[index].itemCount);
      else addToPlayer(remainder);
    }
  };
  const bundleEnabled = stack => isBundleItem(stack, definitions) && (!modern || !stack.removeComponents?.some(type => removedType(type) === 'bundle_contents'));
  const bundleClick = () => {
    const target = slots[slot];
    if (bundleEnabled(cursor) && ((!modern && button === 1) || modern && (button === 0 && has(target) || button === 1 && !has(target)))) {
      if (!has(target)) {
        const removed = bundleRemove(cursor, definitions, modern);
        let remainder = removed.item;
        if (has(remainder) && mayPlace(slot, remainder)) { const take = Math.min(max(slot, remainder), remainder.itemCount); slots[slot] = amount(remainder, take); remainder = amount(remainder, remainder.itemCount - take); }
        cursor = has(remainder) ? bundleInsert(removed.bundle, remainder, definitions, modern).bundle : removed.bundle;
      } else if (mayPickup(slot)) {
        const capacity = bundleCapacity(cursor, target, definitions, modern);
        // Slot.tryRemove forbids a partial transfer from non-modifiable slots.
        if (mayPlace(slot, target) || capacity >= target.itemCount) {
          const inserted = bundleInsert(cursor, amount(target, Math.min(capacity, target.itemCount)), definitions, modern);
          if (inserted.inserted) { cursor = inserted.bundle; slots[slot] = amount(target, target.itemCount - inserted.inserted); onTake(slot); }
        }
      }
      return true;
    }
    if (!bundleEnabled(target)) return false;
    const modifiable = mayPickup(slot) && mayPlace(slot, target);
    if ((!modern && button === 1 && modifiable) || modern && (button === 0 && has(cursor) || button === 1 && !has(cursor))) {
      if (modifiable) {
        if (!has(cursor)) { const removed = bundleRemove(target, definitions, modern); slots[slot] = removed.bundle; cursor = removed.item; }
        else { const inserted = bundleInsert(target, cursor, definitions, modern); slots[slot] = inserted.bundle; cursor = inserted.item; }
      }
      return true;
    }
    if (modern) slots[slot] = { ...target, bundleSelectedItem: -1 };
    return false;
  };
  const valid = slot >= 0 && slot < slots.length;
  if (mode !== 5 && drag) { nextDrag = null; return finish(); }
  if (mode === 5) {
    const header = button & 3, kind = button >> 2 & 3;
    if (!has(cursor) || kind > 2 || kind === 2 && !creative) nextDrag = null;
    else if (header === 0) nextDrag = drag ? null : { kind, slots: new Set() };
    else if (header === 1 && drag?.kind === kind && valid && mayPlace(slot, cursor) && (!has(slots[slot]) || sameStack(slots[slot], cursor) && slots[slot].itemCount <= stackLimit(cursor, definitions)) && (kind === 2 || cursor.itemCount > drag.slots.size)) {
      nextDrag = { kind, slots: new Set(drag.slots) }; nextDrag.slots.add(slot);
    } else if (header === 2 && drag?.kind === kind) {
      if (drag.slots.size === 1) return predictInventoryClick({ window, slot: [...drag.slots][0], button: kind, mode: 0, menu, definitions, playerWindow, creative, modern, tags, recipes, properties, selectedSlot });
      let remainder = cursor.itemCount;
      for (const index of drag.slots) if (mayPlace(index, cursor) && (!has(slots[index]) || sameStack(slots[index], cursor))) {
        const old = has(slots[index]) ? slots[index].itemCount : 0;
        const target = Math.min(max(index, cursor), old + (kind === 0 ? Math.floor(cursor.itemCount / drag.slots.size) : kind === 1 ? 1 : stackLimit(cursor, definitions)));
        slots[index] = amount(cursor, target); remainder -= target - old;
      }
      cursor = amount(cursor, remainder); nextDrag = null;
    } else nextDrag = null;
  } else if (mode === 0 && (button === 0 || button === 1)) {
    if (slot === -999 && has(cursor)) cursor = amount(cursor, button === 0 ? 0 : cursor.itemCount - 1);
    else if (valid) {
      if (bundleClick()) return finish();
      const target = slots[slot];
      if (!has(cursor) && has(target) && mayPickup(slot)) {
        const take = button === 1 ? Math.ceil(target.itemCount / 2) : target.itemCount;
        cursor = amount(target, take); slots[slot] = amount(target, target.itemCount - take); onTake(slot);
      } else if (has(cursor) && mayPlace(slot, cursor) && (!has(target) || sameStack(cursor, target))) {
        const previous = has(target) ? target.itemCount : 0, take = Math.max(0, Math.min(max(slot, cursor) - previous, button === 1 ? 1 : cursor.itemCount));
        if (take) { slots[slot] = amount(cursor, previous + take); cursor = amount(cursor, cursor.itemCount - take); }
      } else if (has(cursor) && has(target) && mayPickup(slot)) {
        if (mayPlace(slot, cursor) && cursor.itemCount <= max(slot, cursor)) { slots[slot] = cursor; cursor = target; onTake(slot); }
        else if (sameStack(cursor, target) && cursor.itemCount + target.itemCount <= stackLimit(cursor, definitions)) { cursor = amount(cursor, cursor.itemCount + target.itemCount); slots[slot] = empty(); onTake(slot); }
      }
    }
  } else if (mode === 1 && valid && has(slots[slot]) && mayPickup(slot) && (button === 0 || button === 1)) {
    let target;
    if (name === 'player') {
      const equipment = armorIndex(slots[slot]);
      target = slot < 9 ? range(9, 45, slot === 0) : equipment >= 0 && !has(slots[equipment]) ? [equipment] : itemName(slots[slot]) === 'shield' && !has(slots[45]) ? [45] : slot < 36 ? range(36, 45) : range(9, 36);
    } else if (slot < count) target = range(count, slots.length, output(slot) || name === 'horse' || name === 'enchantment' || name === 'brewing_stand' || name.startsWith('generic_') || ['hopper', 'shulker_box', 'crafter_3x3'].includes(name));
    else if (name === 'merchant') target = slot < count + 27 ? range(count + 27, slots.length) : range(count, count + 27);
    else if (['furnace', 'blast_furnace', 'smoker'].includes(name)) target = canSmelt(slots[slot]) ? [0] : fuel(slots[slot]) ? [1] : slot < count + 27 ? range(count + 27, slots.length) : range(count, count + 27);
    else if (name === 'brewing_stand') target = itemName(slots[slot]) === 'blaze_powder' ? [4] : mayPlace(3, slots[slot]) ? [3] : mayPlace(0, slots[slot]) && slots[slot].itemCount === 1 ? [0, 1, 2] : slot < count + 27 ? range(count + 27, slots.length) : range(count, count + 27);
    else if (name === 'enchantment') target = itemName(slots[slot]) === 'lapis_lazuli' ? [1] : !has(slots[0]) ? [0] : [];
    else if (name === 'horse') target = [1, 0, ...range(2, count)].filter(index => mayPlace(index, slots[slot]));
    else target = range(0, count).filter(index => mayPlace(index, slots[slot]));
    const remaining = move(slots[slot], target);
    const taken = slots[slot].itemCount - (remaining.itemCount || 0);
    if (remaining.itemCount === slots[slot].itemCount && slot >= count && !['player', 'lectern'].includes(name)) slots[slot] = move(slots[slot], slot < count + 27 ? range(count + 27, slots.length) : range(count, count + 27));
    else slots[slot] = remaining;
    if (taken) { onTake(slot); if (slot === 0 && ['player', 'crafting'].includes(name)) slots[slot] = empty(); }
  } else if (mode === 2 && valid && (button >= 0 && button <= 8 || button === 40)) {
    const globalIndex = button === 40 ? 45 : 36 + button;
    const index = name === 'player' ? globalIndex : button === 40 ? -1 : count + 27 + button;
    const hotbar = copy(index >= 0 ? slots[index] : playerSlots[globalIndex]), target = slots[slot];
    if (index !== slot && mayPickup(slot) && (!has(hotbar) || mayPlace(slot, hotbar))) {
      const limit = max(slot, hotbar);
      if (!has(hotbar) || hotbar.itemCount <= limit) {
        slots[slot] = hotbar; if (index >= 0) slots[index] = target; else playerSlots[globalIndex] = target;
        if (has(target)) onTake(slot);
      } else {
        slots[slot] = amount(hotbar, limit);
        if (index >= 0) slots[index] = amount(hotbar, hotbar.itemCount - limit); else playerSlots[globalIndex] = amount(hotbar, hotbar.itemCount - limit);
        if (has(target)) move(target, name === 'player' ? range(9, 45) : range(count, slots.length));
        if (has(target)) onTake(slot);
      }
    }
  } else if (mode === 3 && creative && !has(cursor) && valid && has(slots[slot])) cursor = amount(slots[slot], stackLimit(slots[slot], definitions));
  else if (mode === 4 && !has(cursor) && valid && has(slots[slot]) && mayPickup(slot)) { slots[slot] = amount(slots[slot], button === 0 ? slots[slot].itemCount - 1 : 0); onTake(slot); }
  else if (mode === 6 && has(cursor) && valid && (!has(slots[slot]) || !mayPickup(slot))) {
    for (let pass = 0; pass < 2; pass++) for (const index of range(0, slots.length, button !== 0)) {
      const target = slots[index];
      if (!sameStack(cursor, target) || !mayPickup(index) || output(index) || name === 'merchant' || pass === 0 && target.itemCount === stackLimit(target, definitions)) continue;
      const take = Math.min(target.itemCount, stackLimit(cursor, definitions) - cursor.itemCount);
      if (take > 0) { slots[index] = amount(target, target.itemCount - take); cursor = amount(cursor, cursor.itemCount + take); }
    }
  }
  return finish();
  function finish() {
    return { changedSlots: slots.flatMap((stack, index) => json(stack) === json(copy(original[index])) ? [] : [{ location: index, item: stack }]), cursorItem: cursor,
      playerChanges: playerSlots.flatMap((stack, index) => json(stack) === json(copy(playerWindow?.slots[index])) ? [] : [{ location: index, item: stack }]), drag: nextDrag };
  }
}
