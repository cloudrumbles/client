const empty = () => ({ present: false });

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
    if (!Number.isInteger(index) || index !== -999 && (index < 0 || index > 45) || !Number.isInteger(mode) || mode < 0 || mode > 6 || !Number.isInteger(button) || button < 0 || button > 40) return false;
    if (!this.owner.itemAdapter && (mode === 4 || index === -999 && mode !== 5)) { this.owner.status('World item drops are not available yet. Move this stack into a slot.'); return false; }
    if (windowId === 0 && index >= 5 && index <= 8) return false;
    return this.owner.dispatch(() => this.owner.menuClick(index, { mode, button, width: windowId === 1 ? 3 : 2, creative: true }));
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
    if (!this.owner.canRun({ closingMenu: true })) return false;
    const closing = this.owner.run(async () => {
      const state = await this.owner.switchGrid(2);
      if (this.owner.current()) {
        this.windowId = 0; this.state.windowId = 0; this.menus.clear(); this.owner.gameplay?.state(this.state);
      }
      return state;
    }, { closingMenu: true });
    void closing.catch(() => {
      if (!this.owner.current()) return;
      this.accept(this.owner.authority.state);
      this.owner.gameplay?.openPanel('inventory');
    });
    return true;
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
  dropItem(entireStack = false) {
    if (!this.owner.current() || !this.owner.itemAdapter) return false;
    return this.owner.dispatch(() => {
      const state = this.owner.authority.state;
      return this.owner.menuClick(state.selected + (state.width === 3 ? 37 : 36), { mode: 4, button: entireStack ? 1 : 0, creative: true });
    });
  }
  swapHands() {
    if (!this.owner.current()) return false;
    return this.owner.dispatch(() => {
      const state = this.owner.authority.state;
      return this.owner.menuClick(state.selected + (state.width === 3 ? 37 : 36), { mode: 2, button: 40, creative: true });
    });
  }
  dig() { return false; }
  place() { return false; }
  cancelDig() { return false; }
  releaseItem() { return false; }
}
