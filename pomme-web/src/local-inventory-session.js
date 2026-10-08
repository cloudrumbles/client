import { nativeInventoryStackLimit } from '../authority/inventory.js';
const empty = () => ({ present: false });
const present = stack => stack?.present !== false && (stack?.itemCount ?? 0) > 0;

/** Session-shaped adapter for local creative inventory; no network packets. */
export class LocalInventorySession {
  constructor(owner, registry, player) {
    this.owner = owner; this.registry = registry; this.items = new Map(registry.items.map(item => [item.id, item]));
    this.adapter = { modern: false }; // Bundle interaction belongs to its own authority.
    this.windows = new Map(); this.menus = new Map(); this.windowId = 0;
    this.state = { status: 'playing', username: 'Local player', gameMode: 1, health: 20, food: 20, saturation: 5,
      selectedSlot: 0, windowId: 0, canFly: true, flying: Boolean(player.fly), flyingSpeed: player.flyingSpeed || .05, effects: [], attributes: [] };
  }
  accept(native) {
    this.native = native; this.state.selectedSlot = native.selected; this.state.windowId = this.windowId;
    const slots = Array.from({ length: 46 }, empty); slots[0] = native.width === 2 ? native.result : empty();
    if (native.width === 2) for (let index = 0; index < 4; index++) slots[1 + index] = native.grid[index];
    for (let index = 5; index <= 8; index++) slots[index] = native.player[44 - index];
    for (let index = 9; index <= 35; index++) slots[index] = native.player[index];
    for (let index = 0; index < 9; index++) slots[36 + index] = native.player[index];
    slots[45] = native.player[40];
    this.windows.set(0, { windowId: 0, stateId: native.revision, slots, cursor: native.cursor, selectedSlot: native.selected });
    if (native.width === 3) {
      const table = Array.from({ length: 46 }, empty); table[0] = native.result;
      for (let index = 0; index < 9; index++) table[1 + index] = native.grid[index];
      for (let index = 9; index <= 35; index++) table[index + 1] = native.player[index];
      for (let index = 0; index < 9; index++) table[37 + index] = native.player[index];
      this.windows.set(1, { windowId: 1, stateId: native.revision, slots: table, cursor: native.cursor, selectedSlot: native.selected });
    } else this.windows.delete(1);
    if (!this.owner.current()) return;
    this.owner.gameplay?.state(this.state);
    for (const window of this.windows.values()) this.owner.gameplay?.inventory(window);
    this.owner.notifySelection();
  }
  slot(windowId, index) {
    if (windowId === 0) {
      if (index >= 1 && index <= 4) return ['grid', index - 1];
      if (index >= 9 && index <= 35) return ['player', index];
      if (index >= 36 && index <= 44) return ['player', index - 36];
    } else if (windowId === 1) {
      if (index >= 1 && index <= 9) return ['grid', index - 1];
      if (index >= 10 && index <= 36) return ['player', index - 1];
      if (index >= 37 && index <= 45) return ['player', index - 37];
    }
    return null;
  }
  clickWindow(index, { button = 0, mode = 0, windowId = this.windowId } = {}) {
    if (!this.owner.current() || windowId !== this.windowId || !this.windows.has(windowId)) return false;
    if (index === 0 && (mode === 0 || mode === 1)) {
      return this.owner.dispatch(() => this.owner.authority.craft({ destination: mode === 1 ? 'inventory' : 'cursor', batches: mode === 1 ? 64 : 1 }));
    }
    const slot = this.slot(windowId, index);
    if (mode === 0 && slot && (button === 0 || button === 1)) return this.owner.dispatch(() => this.owner.authority.click(...slot, button));
    if (mode === 3 && slot && !present(this.native.cursor)) {
      const stack = this.windows.get(windowId).slots[index], definition = this.items.get(stack?.itemId);
      if (!present(stack) || !definition) return false;
      const limit = nativeInventoryStackLimit(stack, definition, this.registry.version.minecraftVersion);
      return this.owner.dispatch(() => this.owner.authority.setSlot('cursor', 0, { ...stack, itemCount: limit }));
    }
    if (mode !== 5) this.owner.status('Use left or right click to move this stack. Shift click the crafting result to make more.');
    return false;
  }
  setCreativeSlot(itemId, count, selected = this.state.selectedSlot) {
    if (!this.owner.current() || !this.items.has(itemId) || !Number.isInteger(selected) || selected < 0 || selected > 8 || !Number.isInteger(count) || count < 1 || count > 99) return false;
    return this.owner.dispatch(() => this.owner.authority.setSlot('player', selected, { present: true, itemId, itemCount: count }));
  }
  selectHotbar(slot) {
    if (!this.owner.current() || !Number.isInteger(slot) || slot < 0 || slot > 8) return false;
    return this.owner.dispatch(() => this.owner.authority.select(slot));
  }
  closeWindow() {
    if (!this.owner.current()) return false;
    this.windowId = 0; this.state.windowId = 0; this.menus.clear(); this.owner.gameplay?.state(this.state);
    this.owner.run(() => this.owner.authority.switchGrid(2), { closingMenu: true }); return true;
  }
  setFlying(value) {
    if (!this.owner.current()) return false;
    this.state.flying = Boolean(value); this.owner.gameplay?.state(this.state); return true;
  }
  sneak(value) { this.state.sneaking = Boolean(value); return true; }
  sprint(value) { this.state.sprinting = Boolean(value); return true; }
  packet() { return false; }
  chat() { return false; }
  craftRecipe() { return false; }
  selectBundleItem() { return false; }
  respawn() { return false; }
  dropItem() { return false; }
  swapHands() { return false; }
  dig() { return false; }
  place() { return false; }
  cancelDig() { return false; }
  releaseItem() { return false; }
}
