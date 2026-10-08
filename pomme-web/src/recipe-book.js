const EMPTY = Object.freeze({ present: false });
const stack = id => Number.isInteger(id) && id >= 0 ? { present: true, itemId: id, itemCount: 1 } : EMPTY;
const tagName = name => name?.includes(':') ? name : `minecraft:${name}`;

// Native SlotDisplay.resolveForStacks: with_remainder displays its input;
// composites concatenate alternatives and tag displays use the current tags.
export function resolveSlotDisplay(display, { normalizeSlot = value => value, tags = new Map(), fuelIds = [] } = {}, depth = 0) {
  if (!display || depth > 16) return [];
  const options = { normalizeSlot, tags, fuelIds }, data = display.data;
  switch (display.type?.replace('minecraft:', '')) {
    case 'empty': return [];
    case 'item': return stack(data).present ? [stack(data)] : [];
    case 'item_stack': { const value = normalizeSlot(data); return value?.present ? [value] : []; }
    case 'tag': return [...(tags.get(tagName(data)) || [])].slice(0, 128).map(stack).filter(value => value.present);
    case 'any_fuel': return fuelIds.slice(0, 128).map(stack).filter(value => value.present);
    case 'with_remainder': return resolveSlotDisplay(data?.input, options, depth + 1);
    case 'composite': return (data || []).slice(0, 128).flatMap(value => resolveSlotDisplay(value, options, depth + 1)).slice(0, 128);
    // The base stack supplies the item represented by a trim display. Native
    // trim components are still supplied on the authoritative result slot.
    case 'smithing_trim': return resolveSlotDisplay(data?.base, options, depth + 1);
    default: return [];
  }
}

/** Modern recipe display IDs are network IDs, independent of resource names. */
export class MinecraftRecipeBook {
  constructor({ normalizeSlot, getTags = () => new Map(), getFuelIds = () => [] } = {}) {
    this.normalizeSlot = normalizeSlot; this.getTags = getTags; this.getFuelIds = getFuelIds;
    this.entries = new Map(); this.stoneCutterRecipes = [];
  }
  clear() { this.entries.clear(); this.stoneCutterRecipes = []; }
  add(entries, replace = false) {
    if (replace) this.entries.clear();
    for (const entry of (entries || []).slice(0, 8192)) if (Number.isInteger(entry.recipe?.displayId) && entry.recipe.displayId >= 0) this.entries.set(entry.recipe.displayId, entry);
  }
  remove(ids) { for (const id of ids || []) this.entries.delete(id); }
  setStoneCutterRecipes(entries) { this.stoneCutterRecipes = (entries || []).slice(0, 8192); }
  snapshot() {
    const options = { normalizeSlot: this.normalizeSlot, tags: this.getTags(), fuelIds: this.getFuelIds() };
    const resolve = display => resolveSlotDisplay(display, options);
    const result = display => resolve(display)[0] || EMPTY;
    const recipes = [];
    for (const entry of this.entries.values()) {
      const native = entry.recipe, display = native.display, data = display?.data;
      if (!display || !data) continue;
      let type = display.type?.replace('minecraft:', '');
      if (type === 'furnace') type = native.category?.startsWith('blast_') ? 'blasting' : native.category?.startsWith('smoker_') ? 'smoking' : native.category === 'campfire' ? 'campfire_cooking' : 'smelting';
      if (type === 'stonecutter') type = 'stonecutting';
      if (type === 'smithing') type = 'smithing_transform';
      recipes.push({ recipeId: native.displayId, displayId: native.displayId, nativeDisplay: display, category: native.category, flags: entry.flags, source: 'book', type: `minecraft:${type}`,
        data: { ...data, width: data.width, height: data.height, ingredients: data.ingredients?.map(resolve), ingredient: data.ingredient ? resolve(data.ingredient) : undefined,
          template: data.template ? resolve(data.template) : undefined, base: data.base ? resolve(data.base) : undefined, addition: data.addition ? resolve(data.addition) : undefined, result: result(data.result) } });
    }
    this.stoneCutterRecipes.forEach((native, index) => {
      const ids = native.input?.ids || [...(options.tags.get(tagName(native.input?.name)) || [])];
      recipes.push({ recipeId: `stonecutter:${index}`, nativeOrder: index, source: 'stonecutter', type: 'minecraft:stonecutting', data: { ingredient: ids.map(stack), result: result(native.slotDisplay) } });
    });
    return recipes;
  }
}
