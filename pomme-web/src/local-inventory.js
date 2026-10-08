import { InventoryAuthority } from '../authority/inventory-client.js';
import { loadNativeCraftingData } from '../authority/native-crafting-data.js';
import { ServerGameplay } from './gameplay.js';
import { LocalInventorySession } from './local-inventory-session.js';
const HOTBAR = ['grass_block', 'stone', 'oak_planks', 'sand', 'oak_leaves', 'glowstone'];

class LocalGameplay extends ServerGameplay {
  renderInventory() {
    super.renderInventory();
    const footer = [...this.ui.inventory.children].find(node => node.tagName === 'P');
    if (footer) footer.textContent = 'Left click picks up or places a stack. Right click splits or places one item. Shift click the crafting result to make more.';
    this.ui['container-options'].replaceChildren();
    const layout = this.ui.slots;
    if (layout.dataset.menu === 'player') for (const button of layout.querySelectorAll('[data-slot]')) {
      const slot = Number(button.dataset.slot); if (slot >= 5 && slot <= 8 || slot === 45) button.disabled = true;
    }
  }
  renderCreative() {
    const query = this.ui['creative-search'].value.toLowerCase().trim();
    const filtered = this.registry.items.filter(item => item.name.includes(query) || item.displayName.toLowerCase().includes(query)).slice(0, 72);
    this.ui['creative-items'].replaceChildren(...filtered.map(item => {
      const button = this.slotButton(this.selectedSlot + 36); this.fillSlot(button, { present: true, itemId: item.id, itemCount: item.stackSize });
      button.dataset.creativeItem = item.name;
      button.addEventListener('click', () => this.session.setCreativeSlot(item.id, item.stackSize, this.selectedSlot)); return button;
    }));
  }
  key(event) {
    if ([this.controls.chat, this.controls.command, this.controls.advancements, this.controls.playerList, this.controls.drop, this.controls.offhand].includes(event.code)) return this.blocking;
    return super.key(event);
  }
}

/** Imported-world creative inventory backed by the portable authoritative engine. */
export class LocalInventory {
  static async open(options) {
    const current = options.isCurrent ?? (() => true);
    if (!options.jar || !current()) return null;
    let data;
    // A texture-only pack is still useful for building even without native recipes.
    try { data = await loadNativeCraftingData(options.jar, { registry: options.registry }); } catch { return null; }
    if (!current()) return null;
    const local = new LocalInventory(options);
    try {
      local.authority = await InventoryAuthority.open({ registry: options.registry, data, worldKey: options.worldKey,
        onEvents: () => local.accept(), onError: error => { if (local.current()) local.status(error.message); } });
      if (!local.current()) { await local.close({ save: false }); return null; }
      if (!local.authority.initial.restored) {
        for (const [index, name] of HOTBAR.entries()) {
          const item = options.registry.items.find(item => item.name === name); if (!item) continue;
          await local.authority.setSlot('player', index, { present: true, itemId: item.id, itemCount: item.stackSize });
          if (!local.current()) { await local.close({ save: false }); return null; }
        }
      }
      if (!local.current()) { await local.close({ save: false }); return null; }
      local.session = new LocalInventorySession(local, options.registry, options.player);
      local.session.accept(local.authority.state);
      if (!local.current()) { await local.close({ save: false }); return null; }
      local.gameplay = new LocalGameplay({ session: local.session, registry: options.registry, player: options.player, world: options.world, onStatus: message => local.status(message) });
      local.gameplay.root.classList.add('local-inventory-ui');
      local.gameplay.style.textContent += '.local-inventory-ui .server-hud,.local-inventory-ui .server-xp{display:none}.local-inventory-ui .server-menu[hidden]{display:none!important}';
      local.gameplay.ui.hotbar.setAttribute('aria-label', 'Local inventory hotbar');
      local.gameplay.ui.creative.querySelector('p').textContent = 'Choose an item for your selected hotbar slot.';
      local.gameplay.state(local.session.state); local.gameplay.inventory(local.session.windows.get(0)); local.gameplay.setAssets(options.assets);
      if (local.authority.state.width === 3) {
        // A saved open table remains intact until the user opens or closes a menu.
        local.session.windowId = 1; local.session.state.windowId = 1;
        local.session.menus.set(1, { inventoryType: 'crafting' });
        local.session.accept(local.authority.state);
        local.gameplay.event({ type: 'window', windowId: 1, inventoryType: 'crafting', title: 'Crafting table' });
      }
      local.notifySelection(); return local;
    } catch (error) { await local.close({ save: false }); throw error; }
  }
  constructor({ registry, world, isCurrent = () => true, onStatus = () => {}, onSelectedBlock = () => {} }) {
    this.registry = registry; this.world = world; this.isCurrent = isCurrent; this.onStatus = onStatus; this.onSelectedBlock = onSelectedBlock;
    this.blocks = new Map(); for (const block of registry.blocks) for (let id = block.minStateId; id <= block.maxStateId; id++) this.blocks.set(id, block);
    this.items = new Map(registry.items.map(item => [item.id, item])); this.blockNames = new Map(registry.blocks.map(block => [block.name, block]));
    this.pending = Promise.resolve(); this.pendingCount = 0; this.closed = false; this.lastSelected = undefined;
  }
  current() { return !this.closed && this.isCurrent(); }
  status(message) { if (this.current()) this.onStatus(message); }
  accept() { if (this.current() && this.session && this.authority?.state) this.session.accept(this.authority.state); }
  heldBlock() {
    const state = this.authority?.state, stack = state?.player[state.selected];
    return stack?.present && stack.itemCount > 0 ? this.blockNames.get(this.items.get(stack.itemId)?.name)?.defaultState ?? null : null;
  }
  notifySelection() {
    if (!this.current()) return;
    const selected = this.heldBlock(); if (this.lastSelected === selected) return;
    this.lastSelected = selected; this.onSelectedBlock(selected);
  }
  canRun({ closingMenu = false } = {}) { return this.current() && this.pendingCount < (closingMenu ? 128 : 127); }
  dispatch(action) {
    if (!this.canRun()) { this.status('Inventory is busy. Try the action again.'); return false; }
    void this.run(action).catch(() => {}); return true;
  }
  run(action, { closingMenu = false } = {}) {
    if (!this.current()) return Promise.resolve(false);
    if (!this.canRun({ closingMenu })) { this.status('Inventory is busy. Try the action again.'); return Promise.resolve(false); }
    this.pendingCount++;
    const operation = this.pending.then(async () => {
      const result = await action(); this.accept(); return result;
    });
    this.pending = operation.catch(error => { this.status(error.message); }).finally(() => this.pendingCount--);
    void operation.catch(() => {}); return operation;
  }
  async useBlock(x, y, z) {
    if (!this.current()) return false;
    const state = this.world?.core?.block_get?.(x, y, z) ?? this.world?.block_get?.(x, y, z) ?? this.world?.getBlock?.(x, y, z);
    if (this.blocks.get(state)?.name !== 'crafting_table') return false;
    const changed = await this.run(() => this.authority.switchGrid(3));
    if (!this.current()) return false;
    if (changed === false || this.authority.state.width !== 3) throw new Error('Inventory is busy. Try opening the table again.');
    this.session.windowId = 1; this.session.state.windowId = 1; this.session.menus.set(1, { inventoryType: 'crafting' });
    this.session.accept(this.authority.state);
    this.gameplay.event({ type: 'window', windowId: 1, inventoryType: 'crafting', titleComponent: { translate: 'container.crafting', fallback: 'Crafting table' } });
    return true;
  }
  async save() { if (this.closed) return; return this.run(() => this.authority.save()); }
  close({ save = true } = {}) {
    if (this.closePromise) return this.closePromise;
    // Gate input, callbacks and DOM synchronously; accepted operations still finish
    // against their old private worker before its own world-key save commits.
    this.closed = true; this.gameplay?.close();
    this.closePromise = this.pending.then(async () => {
      if (!this.authority) return;
      if (save) { try { await this.authority.switchGrid(2); } catch {} }
      await this.authority.close({ save });
    });
    return this.closePromise;
  }
}
