export const MENU_TYPES = ['generic_9x1', 'generic_9x2', 'generic_9x3', 'generic_9x4', 'generic_9x5', 'generic_9x6', 'generic_3x3', 'crafter_3x3', 'anvil', 'beacon', 'blast_furnace', 'brewing_stand', 'crafting', 'enchantment', 'furnace', 'grindstone', 'hopper', 'lectern', 'loom', 'merchant', 'shulker_box', 'smithing', 'smoker', 'cartography_table', 'stonecutter'];

export function menuName(type) {
  if (Number.isInteger(type)) return MENU_TYPES[type] || `unknown_${type}`;
  return String(type || 'container').replace('minecraft:', '');
}

const range = (start, count) => Array.from({ length: count }, (_, i) => start + i);

export function containerLayout(windowId, type, totalSlots, metadata = {}) {
  if (windowId === 0) return { name: 'player', containerSlots: 9, groups: [
    { name: 'Crafting grid', slots: [1, 2, 3, 4], columns: 2 },
    { name: 'Crafting result', slots: [0], columns: 1 },
    { name: 'Armor', slots: [5, 6, 7, 8], columns: 4 },
    { name: 'Inventory', slots: range(9, 27), columns: 9 },
    { name: 'Hotbar', slots: range(36, 9), columns: 9 },
    { name: 'Offhand', slots: [45], columns: 1 },
  ] };
  const name = menuName(type), count = name === 'lectern' ? totalSlots : Math.max(0, totalSlots - 36);
  if (name === 'crafter_3x3') return { name, containerSlots: 9, groups: [
    { name: 'Crafter grid', slots: range(0, 9), columns: 3 }, { name: 'Crafting preview', slots: [45], columns: 1 },
    { name: 'Your inventory', slots: range(9, 27), columns: 9 }, { name: 'Your hotbar', slots: range(36, 9), columns: 9 },
  ] };
  let groups;
  switch (name) {
    case 'horse': groups = [{ name: 'Saddle', slots: [0], columns: 1 }, { name: /llama/.test(metadata.horseType || '') ? 'Carpet' : 'Mount armor', slots: [1], columns: 1 }, { name: 'Mount storage', slots: range(2, Math.max(0, count - 2)), columns: Math.max(1, metadata.inventoryColumns || (count - 2) / 3) }]; break;
    case 'crafting': groups = [{ name: 'Crafting grid', slots: range(1, 9), columns: 3 }, { name: 'Crafting result', slots: [0], columns: 1 }]; break;
    case 'anvil': groups = [{ name: 'Item · material', slots: [0, 1], columns: 2 }, { name: 'Result', slots: [2], columns: 1 }]; break;
    case 'smithing': groups = [{ name: 'Template · equipment · material', slots: [0, 1, 2], columns: 3 }, { name: 'Result', slots: [3], columns: 1 }]; break;
    case 'enchantment': groups = [{ name: 'Item · lapis lazuli', slots: [0, 1], columns: 2 }]; break;
    case 'merchant': groups = [{ name: 'Payment', slots: [0, 1], columns: 2 }, { name: 'Trade result', slots: [2], columns: 1 }]; break;
    case 'furnace': case 'blast_furnace': case 'smoker': groups = [{ name: 'Ingredient · fuel', slots: [0, 1], columns: 2 }, { name: 'Result', slots: [2], columns: 1 }]; break;
    case 'brewing_stand': groups = [{ name: 'Bottles', slots: [0, 1, 2], columns: 3 }, { name: 'Ingredient · blaze powder', slots: [3, 4], columns: 2 }]; break;
    case 'grindstone': case 'cartography_table': groups = [{ name: 'Inputs', slots: [0, 1], columns: 2 }, { name: 'Result', slots: [2], columns: 1 }]; break;
    case 'loom': groups = [{ name: 'Banner · dye · pattern', slots: [0, 1, 2], columns: 3 }, { name: 'Result', slots: [3], columns: 1 }]; break;
    case 'stonecutter': groups = [{ name: 'Input', slots: [0], columns: 1 }, { name: 'Result', slots: [1], columns: 1 }]; break;
    case 'beacon': groups = [{ name: 'Payment', slots: [0], columns: 1 }]; break;
    default: groups = [{ name: 'Container', slots: range(0, count), columns: ['generic_3x3', 'crafter_3x3'].includes(name) ? 3 : name === 'hopper' ? 5 : 9 }];
  }
  const seen = new Set();
  groups = groups.map((group) => ({ ...group, slots: group.slots.filter((slot) => slot < count && !seen.has(slot) && seen.add(slot)) })).filter((group) => group.slots.length);
  const extra = range(0, count).filter((slot) => !seen.has(slot));
  if (extra.length) groups.push({ name: 'Additional container slots', slots: extra, columns: 9 });
  if (name !== 'lectern') {
    groups.push({ name: 'Your inventory', slots: range(count, Math.min(27, totalSlots - count)), columns: 9 });
    groups.push({ name: 'Your hotbar', slots: range(count + 27, Math.max(0, totalSlots - count - 27)), columns: 9 });
  }
  return { name, containerSlots: count, groups };
}

export function recipeMatchesMenu(recipe, name) {
  const type = recipe.type?.replace('minecraft:', '') || '';
  if (name === 'crafting' || name === 'player') return type.startsWith('crafting_') && (name !== 'player' || (recipe.data?.width || 0) <= 2 && (recipe.data?.height || 0) <= 2 && (type !== 'crafting_shapeless' || (recipe.data?.ingredients?.length || 0) <= 4));
  return ({ furnace: 'smelting', blast_furnace: 'blasting', smoker: 'smoking', stonecutter: 'stonecutting', smithing: 'smithing_transform' })[name] === type;
}

export function tradePrice(trade, definition) {
  const base = trade.inputItem1?.itemCount || 0;
  const demand = Math.max(0, Math.floor(base * (trade.demand || 0) * (trade.priceMultiplier || 0)));
  return Math.max(1, Math.min(definition?.stackSize || 64, base + demand + (trade.specialPrice || 0)));
}

// ScrollWheelHandler uses only the sign of accumulated whole wheel steps.
export function nextBundleSelection(wheel, selected, shown) {
  if (!shown || !wheel) return selected;
  let next = Math.max(-1, selected - Math.sign(wheel));
  while (next < 0) next += shown;
  return next % shown;
}
export class BundleWheel {
  constructor() { this.x = 0; this.y = 0; }
  step(x, y) {
    if (this.x && Math.sign(x) !== Math.sign(this.x)) this.x = 0;
    if (this.y && Math.sign(y) !== Math.sign(this.y)) this.y = 0;
    this.x += x; this.y += y;
    const wholeX = Math.trunc(this.x), wholeY = Math.trunc(this.y);
    this.x -= wholeX; this.y -= wholeY;
    return wholeY || -wholeX || 0;
  }
}

export const BANNER_PATTERNS = ['base', 'square_bottom_left', 'square_bottom_right', 'square_top_left', 'square_top_right', 'stripe_bottom', 'stripe_top', 'stripe_left', 'stripe_right', 'stripe_center', 'stripe_middle', 'stripe_downright', 'stripe_downleft', 'small_stripes', 'cross', 'straight_cross', 'triangle_bottom', 'triangle_top', 'triangles_bottom', 'triangles_top', 'diagonal_left', 'diagonal_right', 'diagonal_up_left', 'diagonal_up_right', 'circle', 'rhombus', 'half_vertical', 'half_horizontal', 'half_vertical_right', 'half_horizontal_bottom', 'border', 'curly_border', 'gradient', 'gradient_up', 'bricks', 'globe', 'creeper', 'skull', 'flower', 'mojang', 'piglin'];
