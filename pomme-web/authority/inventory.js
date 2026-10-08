import { structuredBytes } from './limits.js';
import { nativeEquipmentDefaults } from './native-equipment.js';
const MAX_COMPONENT_BYTES = 4 * 1024 * 1024, MAX_COMPONENTS = 4096, STAGE_WORDS = 65536;
const empty = () => ({ present: false });
const canonical = (value, depth = 0) => {
  if (depth > 64) throw new Error('Inventory components exceed their depth limit.');
  if (value === null || value === undefined) return ['null'];
  if (typeof value === 'bigint') return ['bigint', String(value)];
  if (typeof value === 'number') { if (!Number.isFinite(value)) throw new Error('Inventory components require finite numbers.'); return ['number', value]; }
  if (typeof value === 'string' || typeof value === 'boolean') return [typeof value, value];
  if (ArrayBuffer.isView(value)) return ['view', value.constructor.name, Array.from(new Uint8Array(value.buffer, value.byteOffset, value.byteLength))];
  if (value instanceof ArrayBuffer) return ['buffer', Array.from(new Uint8Array(value))];
  if (Array.isArray(value)) return ['array', value.map(entry => canonical(entry, depth + 1))];
  if (typeof value === 'object') return ['object', Object.keys(value).sort().map(key => [key, canonical(value[key], depth + 1)])];
  throw new Error('Unsupported inventory component value.');
};
const componentName = type => typeof type === 'string' && !type.includes(':') ? `minecraft:${type}` : type;
function metadata(stack) {
  const result = {};
  for (const [key, value] of Object.entries(stack)) if (!['present', 'itemId', 'itemCount'].includes(key) && value != null && !(Array.isArray(value) && !value.length)) result[key] = value;
  const removed = new Set((result.removeComponents ?? []).map(componentName));
  if (result.components) {
    const additions = new Map(result.components.map(entry => [componentName(entry.type), { ...entry, type: componentName(entry.type) }]));
    for (const type of removed) additions.delete(type);
    result.components = [...additions.values()].sort((a, b) => String(a.type).localeCompare(String(b.type)));
    if (!result.components.length) delete result.components;
  }
  if (removed.size) result.removeComponents = [...removed].sort(); else delete result.removeComponents;
  return result;
}
function nativeMetadata(stack, item, version) {
  const fields = metadata(stack);
  if (version === '1.20.4' && fields.nbtData && (fields.nbtData.type === 'compound' && fields.nbtData.value && Object.keys(fields.nbtData.value).length === 0 || Object.keys(fields.nbtData).length === 0)) delete fields.nbtData;
  if (version !== '1.20.4' && fields.components) {
    // DataComponentMap compares effective values, so adding an unchanged
    // native default is a no-op patch. Keep unknown defaults opaque.
    const defaults = { 'minecraft:max_stack_size': item.stackSize, ...(item.maxDurability ? { 'minecraft:max_damage': item.maxDurability, 'minecraft:damage': 0 } : {}) };
    fields.components = fields.components.filter(entry => !Object.hasOwn(defaults, entry.type) || entry.data !== defaults[entry.type]);
    if (!fields.components.length) delete fields.components;
  }
  return fields;
}
/** Identity used by native stack interning and ground-item merge decisions.
 * Known native defaults need the matching item/version; counts are excluded. */
export function nativeInventoryStackIdentity(stack, item, version) {
  if (!stack || stack.present === false || !stack.itemCount) return null;
  integer(stack.itemId, 0, 65535, 'identity item');
  const fields = item && version ? nativeMetadata(stack, item, version) : metadata(stack);
  structuredBytes(fields, MAX_COMPONENT_BYTES);
  return JSON.stringify(canonical([stack.itemId, fields]));
}
export function nativeInventoryStackDamaged(stack, item, version) {
  if (!stack || stack.present === false || !stack.itemCount) return false;
  const fields = metadata(stack);
  if (version === '1.20.4') {
    const tag = fields.nbtData?.type === 'compound' ? fields.nbtData.value : fields.nbtData;
    const value = entry => entry && typeof entry === 'object' && 'value' in entry ? entry.value : entry;
    const damage = Number(value(tag?.Damage) ?? 0), unbreakable = Number(value(tag?.Unbreakable) ?? 0) << 24 >> 24;
    return Boolean(item.maxDurability && !unbreakable && damage > 0);
  }
  const added = new Map((fields.components ?? []).map(component => [component.type, component.data])), removed = new Set(fields.removeComponents ?? []);
  const component = (name, fallback) => removed.has(`minecraft:${name}`) ? undefined : added.has(`minecraft:${name}`) ? added.get(`minecraft:${name}`) : fallback;
  const maximum = component('max_damage', item.maxDurability), damage = component('damage', item.maxDurability ? 0 : undefined);
  return maximum !== undefined && damage !== undefined && component('unbreakable') === undefined && Number(maximum) > 0 && Number(damage) > 0;
}
function stackLimit(fields, item, version) {
  // Native DataComponentPatch.decode applies removals after additions, and
  // modern ItemStack.getMaxStackSize defaults a missing component to one.
  if (version !== '1.20.4' && fields.removeComponents?.includes('minecraft:max_stack_size')) return 1;
  return fields.components?.find(entry => entry.type === 'minecraft:max_stack_size')?.data ?? item.stackSize;
}
/** Native ItemStack limit after component namespace and patch-order normalization. */
export function nativeInventoryStackLimit(stack, item, version) {
  return integer(stackLimit(metadata(stack), item, version), 1, 99, 'stack limit');
}
async function fingerprint(registry, data) {
  const bytes = new TextEncoder().encode(JSON.stringify(canonical([registry.version.minecraftVersion, registry.items.map(item => [item.id, item.name, item.stackSize]), data.recipes, [...data.remainders].sort((a, b) => a[0] - b[0])])));
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), byte => byte.toString(16).padStart(2, '0')).join('');
}
const integer = (value, min, max, action) => { if (!Number.isInteger(value) || value < min || value > max) throw new Error(`Invalid inventory ${action}.`); return value; };

/** Separate authoritative stack state inside the same portable WASM binary. */
export class InventoryRuntime {
  static async create({ registry, data, width = 2, height = width, wasmBytes, wasmUrl = new URL('./authority.wasm', import.meta.url) } = {}) {
    if (data?.version !== registry?.version?.minecraftVersion || !Array.isArray(data.recipes) || !(data.remainders instanceof Map)) throw new Error('Inventory requires matching native crafting data.');
    structuredBytes(data, 16 * 1024 * 1024);
    const bytes = wasmBytes ?? await (await fetch(wasmUrl)).arrayBuffer(), { instance } = await WebAssembly.instantiate(bytes, {});
    const runtime = new InventoryRuntime(instance.exports, registry), definitions = runtime.definitions;
    runtime.fingerprint = await fingerprint(registry, data);
    for (const item of definitions.values()) runtime.accept(runtime.core.inventory_register_item(item.id, item.stackSize, 0xffffffff), 'native item registration');
    const air = registry.items.find(item => item.name === 'air');
    if (!air) throw new Error('Native item registry has no air entry.');
    runtime.accept(runtime.core.inventory_empty_item(air.id), 'native empty item');
    for (const [id, remainder] of data.remainders) {
      const item = definitions.get(id); if (!item || !definitions.has(remainder)) throw new Error('Unknown native inventory remainder.');
      runtime.accept(runtime.core.inventory_register_item(item.id, item.stackSize, remainder), 'native remainder registration');
    }
    data.recipes.forEach((recipe, key) => {
      const kind = recipe.type === 'crafting_shaped' ? 1 : recipe.type === 'crafting_shapeless' ? 2 : 0;
      if (!kind) throw new Error('Inventory only accepts shaped and shapeless native recipes.');
      const words = [kind, recipe.width, recipe.height, key, ...runtime.stackWords(recipe.result), recipe.ingredients.length];
      for (const ids of recipe.ingredients) words.push(ids.length, ...ids);
      runtime.stage(words); runtime.accept(runtime.core.inventory_register_recipe(words.length), `recipe ${recipe.id}`); runtime.recipeIds.push(recipe.id);
      runtime.baselineResults.push({ item: recipe.result.itemId, fields: nativeMetadata(recipe.result, definitions.get(recipe.result.itemId), runtime.version) });
    });
    runtime.baselineComponents = runtime.components.map(value => JSON.stringify(canonical(value)));
    runtime.reset(width, height); return runtime;
  }
  constructor(core, registry) {
    this.core = core; this.version = registry.version.minecraftVersion; this.definitions = new Map(registry.items.map(item => [item.id, item])); this.recipeIds = []; this.baselineResults = [];
    this.components = [{}]; this.componentKeys = new Map([['{}', 0]]); this.componentBytes = 0;
  }
  accept(value, action) { if (!value) throw new Error(`Browser inventory rejected ${action}.`); }
  stage(words) {
    if (words.length > STAGE_WORDS || words.some(word => !Number.isInteger(word) || word < 0 || word > 0xffffffff)) throw new Error('Invalid or oversized native inventory ABI data.');
    new Uint32Array(this.core.memory.buffer, this.core.inventory_stage_ptr(), words.length).set(words);
  }
  intern(value) {
    if (!Object.keys(value).length) return 0;
    const metadataBytes = structuredBytes(value, MAX_COMPONENT_BYTES), key = JSON.stringify(canonical(value)), bytes = metadataBytes + key.length * 2;
    const existing = this.componentKeys.get(key); if (existing !== undefined) return existing;
    if (this.components.length >= MAX_COMPONENTS || this.componentBytes + bytes > MAX_COMPONENT_BYTES) throw new Error('Inventory components exceed their memory limit.');
    const id = this.components.length; this.components.push(structuredClone(value)); this.componentKeys.set(key, id); this.componentBytes += bytes; return id;
  }
  stackWords(stack) {
    if (!stack || stack.present === false || stack.itemCount === 0) return [0, 0, 0, 0];
    const item = this.definitions.get(stack.itemId); if (!item) throw new Error('Unknown native inventory item ID.');
    if (item.name === 'air') return [0, 0, 0, 0];
    const count = integer(stack.itemCount, 1, 99, 'stack count'), fields = nativeMetadata(stack, item, this.version);
    const limit = integer(stackLimit(fields, item, this.version), 1, 99, 'stack limit');
    return [item.id, count, this.intern(fields), limit];
  }
  readStack(words) {
    const [itemId, itemCount, components] = words; if (!itemCount) return empty();
    if (!this.components[components]) throw new Error('Inventory save contains an unknown component reference.');
    return { present: true, itemId, itemCount, ...structuredClone(this.components[components]) };
  }
  output(count) { return new Uint32Array(this.core.memory.buffer, this.core.inventory_output_ptr(), count).slice(); }
  reset(width = 2, height = width) { integer(width, 2, 3, 'grid width'); integer(height, 2, 3, 'grid height'); this.accept(this.core.inventory_reset(width, height), 'crafting grid'); }
  switchGrid(width = 2, height = width, { allowDrops = true } = {}) {
    integer(width, 2, 3, 'grid width'); integer(height, 2, 3, 'grid height');
    const checkpoint = allowDrops ? null : this.transactionCheckpoint();
    this.accept(this.core.inventory_change_grid(width, height), 'closing crafting grid');
    if (checkpoint && this.state().drops.length > checkpoint.words[6]) {
      this.rollbackTransaction(checkpoint);
      throw new Error('Move carried items and crafting ingredients into inventory slots before closing this menu.');
    }
    return this.state();
  }
  bootstrapPlayer(player, selected = 0) {
    if (!Array.isArray(player) || player.length !== 41) throw new Error('Source inventory requires all native player slots.');
    integer(selected, 0, 8, 'source selected slot');
    const words = this.output(this.core.inventory_snapshot());
    if (words[5] !== 0 || words[6] !== 0 || Array.from({ length: 51 }, (_, index) => words[8 + index * 4]).some(Boolean)) throw new Error('Source inventory can only initialize an empty unsaved authority.');
    const components = this.components.length, keys = new Map(this.componentKeys), bytes = this.componentBytes;
    try {
      for (let index = 0; index < player.length; index++) words.set(this.stackWords(player[index]), 7 + (9 + index) * 4);
      words[4] = selected; words[5] = 1;
      this.stage(words); this.accept(this.core.inventory_restore(words.length), 'source player inventory');
    } catch (error) {
      this.components.length = components; this.componentKeys = keys; this.componentBytes = bytes; throw error;
    }
    return this.state();
  }
  setSlot(area, index, stack) { this.accept(this.core.inventory_slot_set(this.area(area), integer(index, 0, 40, 'slot'), ...this.stackWords(stack)), 'slot data'); return this.state(); }
  area(value) { const id = { grid: 0, player: 1, cursor: 2 }[value]; if (id === undefined) throw new Error('Invalid inventory slot area.'); return id; }
  select(slot) { this.accept(this.core.inventory_selected(integer(slot, 0, 8, 'selected slot')), 'selected slot'); }
  pickup(stack, { creative = false } = {}) {
    const item = this.definitions.get(stack?.itemId); if (!item || item.name === 'air') throw new Error('Pickup requires a nonempty native item.');
    const checkpoint = this.transactionCheckpoint();
    try {
      const words = this.stackWords(stack), remaining = this.core.inventory_pickup(...words, Number(Boolean(creative)) | (nativeInventoryStackDamaged(stack, item, this.version) ? 2 : 0));
      if (remaining < 0) throw new Error('Browser inventory rejected native pickup.');
      // Inventory.add can reject a valid ground stack when all slots are full.
      // Its opaque metadata then belongs only to the actor, never the inventory.
      if (remaining === words[1]) this.rollbackTransaction(checkpoint);
      return { moved: words[1] - remaining, remaining, state: this.state() };
    } catch (error) { this.rollbackTransaction(checkpoint); throw error; }
  }
  click(area, slot, button = 0) { this.accept(this.core.inventory_click(this.area(area), integer(slot, 0, 35, 'click slot'), integer(button, 0, 1, 'mouse button')), 'click'); return this.state(); }
  menuClick(slot, { button = 0, mode = 0, creative = true, allowDrops = false, width } = {}) {
    if (typeof this.core.inventory_menu_click !== 'function') throw new Error('This inventory authority does not contain native menu transactions.');
    if (!this.equipmentRegistered) {
      const defaults = nativeEquipmentDefaults(this.version);
      for (const item of this.definitions.values()) this.accept(this.core.inventory_item_equipment(item.id, defaults.get(item.name) ?? 0), 'native equipment default');
      this.equipmentRegistered = true;
    }
    // Equippable patches and bundle click overrides require their own native
    // component/item behavior. Retain these stacks without guessing that logic.
    const state = this.state(), stacks = [...state.grid, ...state.player, state.cursor];
    if (width !== undefined && state.width !== integer(width, 2, 3, 'menu width')) throw new Error('This native inventory menu has already closed.');
    if (stacks.some(stack => stack.present && (stack.components?.some(entry => componentName(entry.type) === 'minecraft:equippable') || stack.removeComponents?.some(type => componentName(type) === 'minecraft:equippable')))) throw new Error('This source equipment component still needs native menu conversion.');
    const target = slot === 0 ? state.result : slot > 0 && slot <= state.width * state.width ? state.grid[slot - 1] : state.width === 2 ? state.player[slot >= 36 && slot < 45 ? slot - 36 : slot === 45 ? 40 : slot >= 5 && slot <= 8 ? 44 - slot : slot] : state.player[slot >= 37 ? slot - 37 : slot - 1];
    if (mode === 0 && [target, state.cursor].some(stack => stack?.present && /^(?:[a-z_]+_)?bundle$/.test(this.definitions.get(stack.itemId)?.name ?? ''))) throw new Error('Bundle item click behavior is not yet available in local inventory.');
    const index = slot === -999 ? slot : integer(slot, 0, 45, 'menu slot');
    const result = this.core.inventory_menu_click(index, integer(button, 0, 40, 'menu button'), integer(mode, 0, 6, 'menu mode'), Number(Boolean(creative)) | (this.version === '1.20.4' ? 0 : 2) | (allowDrops ? 4 : 0));
    if (result === -2) throw new Error(allowDrops ? 'Browser inventory transaction exceeds its drop queue limit.' : 'This menu action needs world item drop authority.');
    if (result < 0) throw new Error('Browser inventory rejected the native menu input.');
    return this.state();
  }
  craft({ destination = 'cursor', batches = 1 } = {}) {
    const target = { cursor: 0, inventory: 1 }[destination]; if (target === undefined) throw new Error('Invalid inventory crafting destination.');
    const count = this.core.inventory_craft(target, integer(batches, 1, 64, 'crafting batch'));
    if (count < 0) throw new Error('Browser inventory transaction exceeds its drop queue limit.'); return { batches: count, state: this.state() };
  }
  state() {
    const words = this.output(this.core.inventory_read()), drops = words[6], recipeKey = words[7 + (51 + drops) * 4];
    const stacks = Array.from({ length: 51 + drops }, (_, index) => this.readStack(words.subarray(7 + index * 4, 11 + index * 4)));
    return { width: words[2], height: words[3], selected: words[4], revision: words[5], grid: stacks.slice(0, words[2] * words[3]), player: stacks.slice(9, 50), cursor: stacks[50], drops: stacks.slice(51),
      recipeId: recipeKey === 0xffffffff ? null : this.recipeIds[recipeKey], result: this.readStack(words.subarray(words.length - 4)) };
  }
  snapshot() { return { schema: 1, version: this.version, fingerprint: this.fingerprint, words: this.output(this.core.inventory_snapshot()), components: structuredClone(this.components) }; }
  transactionCheckpoint() { return { words: this.output(this.core.inventory_snapshot()), components: structuredClone(this.components), keys: new Map(this.componentKeys), bytes: this.componentBytes }; }
  rollbackTransaction(checkpoint) {
    this.stage(checkpoint.words); this.accept(this.core.inventory_restore(checkpoint.words.length), 'transaction rollback');
    this.components = checkpoint.components; this.componentKeys = checkpoint.keys; this.componentBytes = checkpoint.bytes;
  }
  restore(snapshot) {
    if (snapshot?.schema !== 1 || snapshot.version !== this.version || snapshot.fingerprint !== this.fingerprint) throw new Error('Inventory save belongs to different native item/recipe data.');
    if (!(snapshot.words instanceof Uint32Array) || snapshot.words.length < 211 || snapshot.words.length > 467 || !Array.isArray(snapshot.components) || snapshot.components.length < 1 || snapshot.components.length > MAX_COMPONENTS) throw new Error('Invalid inventory save.');
    const components = structuredClone(snapshot.components).map(value => value && typeof value === 'object' && !Array.isArray(value) ? metadata(value) : value); let bytes = 0; const keys = new Map();
    if (!components[0] || typeof components[0] !== 'object' || Object.keys(components[0]).length) throw new Error('Invalid inventory base components.');
    components.forEach((value, index) => {
      if (!value || typeof value !== 'object' || Array.isArray(value) || index && !Object.keys(value).length) throw new Error('Invalid saved inventory components.');
      const canonicalKey = JSON.stringify(canonical(value)), key = index ? canonicalKey : '{}';
      if (index) bytes += structuredBytes(value, MAX_COMPONENT_BYTES) + canonicalKey.length * 2;
      if (keys.has(key)) throw new Error('Duplicate saved inventory components.'); keys.set(key, index);
    });
    const missingBaseline = this.baselineResults.filter(({ fields }) => !keys.has(Object.keys(fields).length ? JSON.stringify(canonical(fields)) : '{}'));
    const byDefaults = new Map();
    for (const { item, fields } of missingBaseline) {
      const definition = this.definitions.get(item), signature = `${definition.stackSize}:${definition.maxDurability ?? 0}`;
      let normalized = byDefaults.get(signature);
      if (!normalized) { normalized = new Set(components.map(value => { const fields = nativeMetadata(value, definition, this.version); return Object.keys(fields).length ? JSON.stringify(canonical(fields)) : '{}'; })); byDefaults.set(signature, normalized); }
      if (!normalized.has(Object.keys(fields).length ? JSON.stringify(canonical(fields)) : '{}')) throw new Error('Inventory save changes native recipe result components.');
    }
    if (bytes > MAX_COMPONENT_BYTES) throw new Error('Inventory save components exceed their memory limit.');
    for (let offset = 7; offset < snapshot.words.length; offset += 4) {
      if (!snapshot.words[offset + 1]) continue;
      const fields = components[snapshot.words[offset + 2]], item = this.definitions.get(snapshot.words[offset]);
      if (!fields) throw new Error('Inventory save contains an unknown component reference.');
      if (!item || item.name === 'air' || snapshot.words[offset + 3] !== stackLimit(fields, item, this.version)) throw new Error('Inventory save changes native stack limits.');
    }
    // Migrate old accepted patch-representation IDs to effective known-default
    // identities without changing counts or unknown component/NBT payloads.
    const words = snapshot.words.slice(), migrated = this.components.slice(0, this.baselineComponents.length).map(value => structuredClone(value)), migratedKeys = new Map(); let migratedBytes = 0;
    migrated.forEach((value, index) => { const encoded = JSON.stringify(canonical(value)); migratedKeys.set(index ? encoded : '{}', index); if (index) migratedBytes += structuredBytes(value, MAX_COMPONENT_BYTES) + encoded.length * 2; });
    for (let offset = 7; offset < words.length; offset += 4) {
      if (!words[offset + 1]) continue;
      const fields = nativeMetadata(components[words[offset + 2]], this.definitions.get(words[offset]), this.version), encoded = Object.keys(fields).length ? JSON.stringify(canonical(fields)) : '{}';
      let id = migratedKeys.get(encoded);
      if (id === undefined) {
        const cost = structuredBytes(fields, MAX_COMPONENT_BYTES) + encoded.length * 2;
        if (migrated.length >= MAX_COMPONENTS || migratedBytes + cost > MAX_COMPONENT_BYTES) throw new Error('Inventory save components exceed their memory limit.');
        id = migrated.length; migrated.push(fields); migratedKeys.set(encoded, id); migratedBytes += cost;
      }
      words[offset + 2] = id;
    }
    this.stage(words); this.accept(this.core.inventory_restore(words.length), 'saved inventory');
    this.components = migrated; this.componentKeys = migratedKeys; this.componentBytes = migratedBytes; return this.state();
  }
  acknowledgeDrops({ count, expectedRevision } = {}) {
    const state = this.state(), drops = state.drops; count ??= drops.length; expectedRevision ??= state.revision;
    this.accept(this.core.inventory_ack_drops_prefix(integer(count, 0, 64, 'drop acknowledgment count'), integer(expectedRevision, 0, 0xffffffff, 'drop acknowledgment revision')), 'drop acknowledgment');
    return drops.slice(0, count);
  }
}
