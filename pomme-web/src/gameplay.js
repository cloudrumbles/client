import { simplifyNbt } from './minecraft.js';
import { rayBoxDistance } from './entities.js';

const TOOL_SPEED = { wooden: 2, stone: 4, iron: 6, diamond: 8, netherite: 9, golden: 12 };
const SPRINT_SPEED_MODIFIER = '662a6b8d-da3e-4c1c-8813-96ea6097278d';
const itemEnchants = (slot) => simplifyNbt(slot?.nbtData)?.Enchantments || [];
const enchant = (slot, name) => itemEnchants(slot).find((item) => item.id === name || item.id === `minecraft:${name}`)?.lvl || 0;

export function blockBreakSeconds(block, item, slot, { haste = 0, fatigue = 0, underwater = false, aquaAffinity = false, grounded = true } = {}) {
  if (!block || block.hardness < 0 || block.diggable === false) return Infinity;
  if (block.hardness === 0) return 0.05;
  const tool = /^(wooden|stone|iron|diamond|netherite|golden)_(pickaxe|axe|shovel|hoe)$/.exec(item?.name || '');
  let speed = tool && block.material?.includes(`mineable/${tool[2]}`) ? TOOL_SPEED[tool[1]] : 1;
  if (item?.name === 'shears') {
    if (/cobweb|leaves|vine/.test(block.name)) speed = 15;
    else if (block.name.endsWith('_wool')) speed = 5;
  } else if (item?.name?.endsWith('_sword')) speed = block.name === 'cobweb' ? 15 : 1.5;
  if (speed > 1) { const efficiency = enchant(slot, 'efficiency'); if (efficiency) speed += efficiency * efficiency + 1; }
  speed *= 1 + 0.2 * haste;
  if (fatigue > 0) speed *= [1, 0.3, 0.09, 0.0027, 0.00081][Math.min(fatigue, 4)];
  if (underwater && !aquaAffinity) speed /= 5;
  if (!grounded) speed /= 5;
  const canHarvest = !block.harvestTools || Boolean(block.harvestTools[slot?.itemId]);
  const ticks = Math.max(1, Math.ceil(block.hardness * (canHarvest ? 30 : 100) / speed));
  return ticks / 20;
}

const STYLE = `
.server-play-ui{position:fixed;inset:0;pointer-events:none;z-index:25;color:#edf6f4;font:13px system-ui,sans-serif}.server-play-ui [hidden]{display:none!important}.server-hud{position:absolute;left:50%;bottom:115px;transform:translateX(-50%);padding:8px 13px;border-radius:8px;background:#0b182ac2;display:flex;gap:18px;white-space:nowrap}.server-hotbar{position:absolute;left:50%;bottom:20px;transform:translateX(-50%);display:grid;grid-template-columns:repeat(9,60px);gap:5px;pointer-events:auto;padding:7px;border:1px solid #60788b73;border-radius:12px;background:#0b182add}.server-slot{position:relative;min-height:58px;background:#233448;color:#edf6f4;border:1px solid #647a8a55;border-radius:5px;font:inherit;padding:8px 4px;cursor:pointer}.server-slot.selected{border:2px solid #b9e8db;background:#345151}.server-slot-name{display:block;font-size:10px;line-height:1.2;overflow:hidden}.server-slot-count{position:absolute;right:4px;bottom:3px;font-weight:700;font-size:12px}.server-slot-key{position:absolute;left:4px;top:2px;color:#afc4ce;font-size:10px}.server-chat-log{position:absolute;bottom:130px;left:20px;width:min(430px,42vw);max-height:160px;overflow:hidden;text-shadow:0 1px 2px #000;line-height:1.5}.server-chat-line{background:#07131c8a;border-radius:3px;padding:2px 7px;margin-top:3px;overflow-wrap:anywhere}.server-chat-entry{position:absolute;bottom:21px;left:20px;width:min(600px,75vw);display:flex;gap:8px;pointer-events:auto;background:#102132;padding:9px;border:1px solid #718695;border-radius:8px}.server-chat-entry input{min-width:0;flex:1;background:#162f41;color:white;border:1px solid #6d8792;padding:8px;font:inherit}.server-chat-entry button,.server-menu button:not(.server-slot){border:1px solid #658b8a;background:#244946;color:#edf6f4;border-radius:5px;padding:8px;font:inherit;cursor:pointer}.server-menu{position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);width:min(650px,90vw);max-height:85vh;overflow:auto;pointer-events:auto;background:#102132f5;border:1px solid #648084;border-radius:14px;padding:20px;box-shadow:0 24px 100px #0008}.server-menu-head{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:12px}.server-menu h2{font-size:20px;margin:0}.server-menu p{color:#b8cbd3;font-size:12px;line-height:1.5}.server-inventory-grid{display:grid;grid-template-columns:repeat(9,minmax(0,1fr));gap:4px;margin:8px 0 15px}.server-creative-search{width:100%;box-sizing:border-box;background:#1b3347;border:1px solid #678291;color:white;padding:9px;font:inherit;margin:8px 0}.server-cursor-stack{font-size:12px;color:#bfe9d9;margin:5px 0}.server-dig{position:absolute;top:calc(50% + 28px);left:calc(50% - 45px);width:90px;height:4px;background:#182b36;border-radius:3px}.server-dig span{display:block;height:100%;width:100%;transform-origin:left;background:#c8e4da;border-radius:3px}.server-death{width:min(400px,88vw);text-align:center}.server-death button{margin-top:15px}.server-request{font-size:11px;color:#c8d8de;max-width:220px;white-space:normal}.server-crafting-note{margin:8px 0 2px}
@media(max-width:680px){.server-hotbar{grid-template-columns:repeat(9,1fr);width:93vw;bottom:10px}.server-slot{min-height:47px;padding:9px 2px}.server-hud{bottom:88px}.server-chat-log{bottom:120px;left:10px;width:70vw}.server-menu{padding:12px}.server-slot-name{font-size:9px}}
`;

function hitInfo(hit) {
  if (!hit) return null;
  const array = Array.isArray(hit) || ArrayBuffer.isView(hit);
  return array ? { x: hit[0], y: hit[1], z: hit[2], stateId: hit[6], hit } : { x: hit.x, y: hit.y, z: hit.z, stateId: hit.stateId ?? hit.id, hit };
}
const sameTarget = (a, b) => a && b && a.x === b.x && a.y === b.y && a.z === b.z && a.stateId === b.stateId;

export class ServerGameplay {
  constructor({ session, registry, player, world, getEntities = () => null, onStatus = () => {} }) {
    this.session = session; this.registry = registry; this.player = player; this.world = world; this.onStatus = onStatus;
    this.getEntities = getEntities;
    this.lastJumpPress = -Infinity;
    this.currentState = { ...session.state };
    this.windows = new Map(); this.selectedSlot = 0; this.digging = null; this.awaitingBlock = null;
    this.holding = false; this.placing = false; this.digCooldown = 0; this.placeCooldown = 0;
    this.menu = null; this.hoverSlot = null; this.chatMessages = []; this.active = false;
    this.items = new Map(registry.items.map((item) => [item.id, item]));
    this.itemsByName = new Map(registry.items.map((item) => [item.name, item]));
    this.blocks = new Map();
    for (const block of registry.blocks) for (let state = block.minStateId; state <= block.maxStateId; state++) this.blocks.set(state, block);
    this.originalHotbar = document.getElementById('hotbar');
    this.style = document.createElement('style'); this.style.textContent = STYLE;
    document.head.append(this.style);
    this.root = document.createElement('div'); this.root.className = 'server-play-ui'; this.root.hidden = true;
    this.root.innerHTML = `<div class="server-hud" role="status"><span data-ui="health"></span><span data-ui="food"></span><span data-ui="level"></span><span class="server-request" data-ui="request"></span></div><nav class="server-hotbar" aria-label="Server inventory hotbar" data-ui="hotbar"></nav><div class="server-chat-log" role="log" aria-label="Server chat" data-ui="chat-log"></div><form class="server-chat-entry" data-ui="chat-entry" hidden><input aria-label="Chat message or command" maxlength="256" autocomplete="off" /><button type="submit">Send</button></form><section class="server-menu" role="dialog" aria-modal="true" aria-label="Inventory" data-ui="inventory" hidden><div class="server-menu-head"><h2 data-ui="inventory-title">Inventory</h2><button type="button" data-ui="inventory-close" aria-label="Close inventory">Close</button></div><div class="server-cursor-stack" data-ui="cursor"></div><div data-ui="slots"></div><section data-ui="creative" hidden><h3>Creative items</h3><p>Choose an item for your selected hotbar slot. Server inventory updates remain authoritative.</p><input class="server-creative-search" aria-label="Find creative item" placeholder="Search items…" data-ui="creative-search" /><div class="server-inventory-grid" data-ui="creative-items"></div></section><p>Left click picks up or places a stack. Right click splits or places one item. Shift click moves a stack.</p></section><section class="server-menu server-death" role="dialog" aria-modal="true" aria-label="You died" data-ui="death" hidden><h2>You died</h2><p data-ui="death-message">The server reported that your health reached zero.</p><button type="button" data-ui="respawn">Respawn</button></section><div class="server-dig" data-ui="dig" hidden><span></span></div>`;
    document.body.append(this.root);
    this.ui = Object.fromEntries([...this.root.querySelectorAll('[data-ui]')].map((node) => [node.dataset.ui, node]));
    this.hotbarButtons = Array.from({ length: 9 }, (_, slot) => {
      const button = this.slotButton(36 + slot); button.classList.add('server-hotbar-slot');
      button.addEventListener('click', () => { this.session.selectHotbar(slot); });
      this.ui.hotbar.append(button); return button;
    });
    this.ui['inventory-close'].addEventListener('click', () => this.closePanel());
    this.ui['creative-search'].addEventListener('input', () => this.renderCreative());
    this.ui['chat-entry'].addEventListener('submit', (event) => {
      event.preventDefault(); const input = this.ui['chat-entry'].querySelector('input');
      if (this.session.chat(input.value)) { input.value = ''; this.closePanel(); }
    });
    this.ui.respawn.addEventListener('click', () => { this.session.respawn(); this.ui.respawn.disabled = true; this.ui['death-message'].textContent = 'Waiting for the server to respawn you…'; });
    this.root.addEventListener('contextmenu', (event) => event.preventDefault());
    this.root.addEventListener('keydown', (event) => { if (this.key(event)) event.stopPropagation(); });
    this.renderHotbar();
  }

  get blocking() { return Boolean(this.menu || !this.ui.death.hidden); }
  readBlock(x, y, z) { return this.world?.block_get?.(x, y, z) ?? this.world?.getBlock?.(x, y, z) ?? this.world?.core?.block_get?.(x, y, z); }
  target() { return hitInfo(this.player?.target?.()); }
  currentItem() { return this.windows.get(0)?.slots[36 + this.selectedSlot] || { present: false }; }

  slotButton(slot) {
    const button = document.createElement('button'); button.type = 'button'; button.className = 'server-slot'; button.dataset.slot = slot;
    button.innerHTML = '<span class="server-slot-key"></span><span class="server-slot-name"></span><span class="server-slot-count"></span>';
    button.addEventListener('mouseenter', () => { this.hoverSlot = slot; });
    button.addEventListener('mouseleave', () => { if (this.hoverSlot === slot) this.hoverSlot = null; });
    return button;
  }

  fillSlot(button, item, key = '') {
    const definition = item?.present ? this.items.get(item.itemId) : null;
    button.querySelector('.server-slot-key').textContent = key;
    button.querySelector('.server-slot-name').textContent = definition?.displayName || (item?.present ? `Item ${item.itemId}` : '');
    button.querySelector('.server-slot-count').textContent = item?.present && item.itemCount > 1 ? String(item.itemCount) : '';
    button.title = definition?.displayName || 'Empty slot';
    button.setAttribute('aria-label', `${button.title}, slot ${Number(button.dataset.slot) + 1}${item?.present ? `, ${item.itemCount} items` : ''}`);
  }

  state(state) {
    const previouslyActive = this.active;
    this.currentState = { ...state }; this.selectedSlot = state.selectedSlot || 0;
    this.active = ['loading', 'playing', 'connected'].includes(state.status);
    this.root.hidden = !this.active;
    if (this.originalHotbar) this.originalHotbar.hidden = this.active;
    if (!this.active && previouslyActive) { this.mouseUp(); this.closePanel(false); }
    this.ui.health.textContent = `♥ ${Math.max(0, state.health ?? 20).toFixed(0)} / 20`;
    this.ui.food.textContent = `Food ${state.food ?? 20} / 20`;
    this.ui.level.textContent = `Level ${state.experienceLevel || 0}`;
    this.player.fly = Boolean(state.flying);
    this.player.noclip = state.gameMode === 3;
    this.player.canSprint = state.gameMode === 1 || state.gameMode === 3 || state.food > 6;
    this.player.flyingSpeed = state.flyingSpeed || 0.05;
    const movement = state.attributes?.find((attribute) => /(?:generic\.)?movement_speed$/.test(attribute.name));
    if (movement) {
      // Player.tick applies the 1.3 sprint factor from current input. The
      // server's movement attribute contains that same vanilla modifier while
      // sprinting, so exclude it from the base speed rather than applying it
      // twice. Other speed effects and plugin modifiers remain authoritative.
      const modifiers = (movement.modifiers || []).filter((mod) => !(mod.operation === 2 && String(mod.uuid).toLowerCase() === SPRINT_SPEED_MODIFIER));
      let value = movement.value + modifiers.filter((mod) => mod.operation === 0).reduce((sum, mod) => sum + mod.amount, 0);
      value += value * modifiers.filter((mod) => mod.operation === 1).reduce((sum, mod) => sum + mod.amount, 0);
      for (const modifier of modifiers.filter((mod) => mod.operation === 2)) value *= 1 + modifier.amount;
      this.player.movementMultiplier = Math.max(0, value / 0.1);
    } else {
      const speed = state.effects?.find((effect) => effect.id === 0)?.amplifier;
      const slowness = state.effects?.find((effect) => effect.id === 1)?.amplifier;
      this.player.movementMultiplier = (1 + (speed === undefined ? 0 : 0.2 * (speed + 1))) * Math.max(0, 1 - (slowness === undefined ? 0 : 0.15 * (slowness + 1)));
    }
    this.ui.creative.hidden = state.gameMode !== 1;
    if ((state.health ?? 20) <= 0 && this.active) this.showDeath();
    else { this.ui.death.hidden = true; this.ui.respawn.disabled = false; }
    this.renderHotbar();
  }

  inventory(window) {
    this.windows.set(window.windowId, { ...window, slots: [...window.slots] });
    this.selectedSlot = window.selectedSlot ?? this.selectedSlot;
    if (window.windowId === 0) this.renderHotbar();
    if (this.menu === 'inventory') this.renderInventory();
  }

  event(event) {
    if (event.type === 'chat') {
      if (event.actionBar) { this.onStatus(event.text); return; }
      this.chatMessages.push(String(event.text)); if (this.chatMessages.length > 80) this.chatMessages.shift();
      this.ui['chat-log'].replaceChildren(...this.chatMessages.slice(-5).map((text) => { const line = document.createElement('div'); line.className = 'server-chat-line'; line.textContent = text; return line; }));
    } else if (event.type === 'death') {
      if (event.text) this.ui['death-message'].textContent = event.text;
      this.showDeath();
    } else if (event.type === 'window') {
      this.ui['inventory-title'].textContent = event.title || 'Container';
      this.openPanel('inventory');
    } else if (event.type === 'close-window') this.closePanel();
    else if (event.type === 'player-velocity') {
      // Protocol velocities are blocks/tick. Player physics uses metres/second.
      this.player.velocity = [event.velocity.x * 20, event.velocity.y * 20, event.velocity.z * 20];
    } else if (event.type === 'player-damage') {
      this.ui.health.animate?.([{ color: '#ff7c70', transform: 'scale(1.15)' }, { color: '#edf6f4', transform: 'scale(1)' }], { duration: 400 });
    }
    else if (event.type === 'error') this.onStatus(event.message);
  }

  renderHotbar() {
    const inventory = this.windows.get(0);
    this.hotbarButtons.forEach((button, index) => {
      this.fillSlot(button, inventory?.slots[36 + index], String(index + 1));
      button.classList.toggle('selected', index === this.selectedSlot); button.setAttribute('aria-pressed', String(index === this.selectedSlot));
    });
  }

  renderInventory() {
    const id = this.currentState.windowId || 0, window = this.windows.get(id);
    const slots = this.ui.slots; slots.replaceChildren();
    if (!window) { slots.textContent = 'Waiting for the server inventory…'; return; }
    const group = (title, indexes) => {
      const label = document.createElement('p'); label.className = 'server-crafting-note'; label.textContent = title;
      const grid = document.createElement('div'); grid.className = 'server-inventory-grid';
      for (const index of indexes) {
        const button = this.slotButton(index); this.fillSlot(button, window.slots[index]);
        button.addEventListener('click', (event) => this.session.clickWindow(index, { mode: event.shiftKey ? 1 : 0, button: 0, windowId: id }));
        button.addEventListener('contextmenu', (event) => { event.preventDefault(); this.session.clickWindow(index, { button: 1, windowId: id }); });
        grid.append(button);
      }
      slots.append(label, grid);
    };
    if (id === 0) {
      group('Crafting result · crafting grid · armor', Array.from({ length: 9 }, (_, index) => index));
      group('Inventory', Array.from({ length: 27 }, (_, index) => index + 9));
      group('Hotbar · offhand', [...Array.from({ length: 9 }, (_, index) => index + 36), 45]);
    } else {
      const count = Math.max(0, window.slots.length - 36);
      group('Container', Array.from({ length: count }, (_, index) => index));
      group('Your inventory', Array.from({ length: 36 }, (_, index) => index + count));
    }
    const carried = window.cursor;
    this.ui.cursor.textContent = carried?.present ? `Carrying ${carried.itemCount} × ${this.items.get(carried.itemId)?.displayName || `item ${carried.itemId}`}` : 'No stack carried';
    if (this.currentState.gameMode === 1) this.renderCreative();
  }

  renderCreative() {
    const query = this.ui['creative-search'].value.toLowerCase().trim();
    const filtered = this.registry.items.filter((item) => item.name.includes(query) || item.displayName.toLowerCase().includes(query)).slice(0, 72);
    this.ui['creative-items'].replaceChildren(...filtered.map((item) => {
      const button = this.slotButton(this.selectedSlot + 36); this.fillSlot(button, { present: true, itemId: item.id, itemCount: item.stackSize });
      button.addEventListener('click', () => {
        if (this.session.setCreativeSlot(item.id, item.stackSize, this.selectedSlot)) {
          this.ui.request.textContent = `Requested ${item.displayName} in slot ${this.selectedSlot + 1}`;
          this.onStatus(`Creative item request sent: ${item.displayName}`);
        }
      });
      return button;
    }));
  }

  openPanel(name) {
    this.mouseUp(); this.menu = name;
    this.ui.inventory.hidden = name !== 'inventory'; this.ui['chat-entry'].hidden = name !== 'chat';
    if (document.pointerLockElement) document.exitPointerLock();
    if (name === 'inventory') { if (!(this.currentState.windowId || 0)) this.ui['inventory-title'].textContent = 'Inventory'; this.renderInventory(); this.ui['inventory-close'].focus(); }
    else this.ui['chat-entry'].querySelector('input').focus();
  }

  closePanel(resume = true) {
    const wasInventory = this.menu === 'inventory';
    this.menu = null; this.ui.inventory.hidden = true; this.ui['chat-entry'].hidden = true; this.hoverSlot = null;
    if (wasInventory) this.session.closeWindow();
    if (resume && this.active && this.currentState.health > 0) document.getElementById('world')?.requestPointerLock?.()?.catch?.(() => {});
  }

  showDeath() { this.mouseUp(); this.closePanel(false); this.ui.death.hidden = false; if (document.pointerLockElement) document.exitPointerLock(); }

  breakDuration(target) {
    const block = this.blocks.get(target.stateId ?? this.readBlock(target.x, target.y, target.z));
    const slot = this.currentItem(), item = slot.present ? this.items.get(slot.itemId) : null;
    const eye = this.player.eye || [this.player.position[0], this.player.position[1] + 1.62, this.player.position[2]];
    const eyeBlock = this.blocks.get(this.readBlock(...eye.map(Math.floor)));
    const effects = this.currentState.effects || [];
    const effectLevel = (name, id) => { const effect = effects.find((item) => item.name === name || item.id === id); return effect ? effect.amplifier + 1 : 0; };
    return blockBreakSeconds(block, item, slot, { grounded: Boolean(this.player.grounded), underwater: /water|bubble_column|kelp|seagrass/.test(eyeBlock?.name || ''), aquaAffinity: enchant(this.windows.get(0)?.slots[5], 'aqua_affinity') > 0, haste: effectLevel('haste', 2), fatigue: effectLevel('mining_fatigue', 3) });
  }

  startDig(target) {
    if (!target || sameTarget(target, this.awaitingBlock)) return;
    const duration = this.currentState.gameMode === 1 ? 0 : this.breakDuration(target);
    if (!Number.isFinite(duration)) { this.onStatus('This block cannot be mined with the current mode.'); return; }
    if (!this.session.dig(target.hit, { phase: 'start' })) return;
    if (duration === 0) {
      this.session.dig(target.hit, { phase: 'finish' }); this.awaitingBlock = target; this.digCooldown = 0.25;
    } else { this.digging = { ...target, elapsed: 0, duration }; this.ui.dig.hidden = false; }
  }

  mouseDown(button, hit) {
    if (!this.active || this.currentState.status !== 'playing' || this.blocking) return false;
    const entityReach = this.currentState.gameMode === 1 ? 5 : 3;
    const entityHit = this.getEntities()?.pick(this.player.eye, this.player.direction, entityReach);
    if (entityHit) {
      const block = hitInfo(hit);
      const blockDistance = block ? rayBoxDistance(this.player.eye, this.player.direction, [block.x, block.y, block.z], [block.x + 1, block.y + 1, block.z + 1]) : Infinity;
      if (entityHit.distance < (blockDistance ?? Infinity)) hit = entityHit;
    }
    if (hit?.entityId !== undefined) return button === 0 ? this.session.attackEntity(hit.entityId) : this.session.interactEntity(hit.entityId, { point: hit.localPoint });
    if (button === 0) { this.holding = true; this.awaitingBlock = null; this.startDig(hitInfo(hit)); return true; }
    if (button === 2) { this.placing = true; this.placeCooldown = 0.2; this.session.place(hit); return true; }
    if (button === 1 && this.currentState.gameMode === 1) {
      const block = this.blocks.get(hitInfo(hit)?.stateId), item = block && this.itemsByName.get(block.name);
      if (item) this.session.setCreativeSlot(item.id, item.stackSize); return true;
    }
    return false;
  }

  mouseUp(button = -1) {
    if (button === 0 || button === -1) {
      this.holding = false; this.awaitingBlock = null;
      if (this.digging) this.session.cancelDig();
      this.digging = null; this.ui.dig.hidden = true;
    }
    if (button === 2 || button === -1) { if (this.placing) this.session.releaseItem(); this.placing = false; }
  }

  tick(dt) {
    if (!this.active || this.currentState.status !== 'playing' || this.blocking) { if (this.holding || this.placing) this.mouseUp(); return; }
    this.digCooldown = Math.max(0, this.digCooldown - dt);
    if (this.holding) {
      const target = this.target();
      if (this.digging && !sameTarget(target, this.digging)) { this.session.cancelDig(); this.digging = null; this.ui.dig.hidden = true; }
      if (!this.digging && this.digCooldown <= 0) this.startDig(target);
      if (this.digging) {
        this.digging.elapsed += dt;
        this.ui.dig.querySelector('span').style.transform = `scaleX(${Math.min(1, this.digging.elapsed / this.digging.duration)})`;
        if (this.digging.elapsed >= this.digging.duration) {
          this.session.dig(this.digging.hit, { phase: 'finish' }); this.awaitingBlock = this.digging; this.digging = null; this.digCooldown = 0.25; this.ui.dig.hidden = true;
        }
      }
    }
    if (this.placing) {
      this.placeCooldown -= dt;
      const item = this.items.get(this.currentItem().itemId);
      if (this.placeCooldown <= 0 && item && this.registry.blocks.some((block) => block.name === item.name)) { this.session.place(this.player.target()); this.placeCooldown = 0.2; }
    }
  }

  key(event) {
    if (!this.active) return false;
    const down = event.type !== 'keyup';
    if (event.code === 'Escape' && this.menu) { if (down) this.closePanel(); event.preventDefault(); return true; }
    if (['INPUT', 'TEXTAREA', 'SELECT'].includes(event.target?.tagName)) return true;
    if (!this.ui.death.hidden) return true;
    if (event.code === 'ShiftLeft' || event.code === 'ShiftRight') { if (!event.repeat) this.session.sneak(down); return false; }
    if (event.code === 'ControlLeft' || event.code === 'ControlRight') { if (!event.repeat) this.session.sprint(down); return false; }
    if (!down) return Boolean(['KeyE', 'KeyT', 'Slash', 'KeyQ', 'KeyF'].includes(event.code) || /^Digit[1-9]$/.test(event.code));
    if (event.repeat) return this.blocking;
    if (/^Digit[1-9]$/.test(event.code)) {
      const slot = Number(event.code.slice(-1)) - 1;
      if (this.menu === 'inventory' && this.hoverSlot !== null) this.session.clickWindow(this.hoverSlot, { mode: 2, button: slot });
      else this.session.selectHotbar(slot);
      event.preventDefault(); return true;
    }
    if (event.code === 'KeyE') { this.menu === 'inventory' ? this.closePanel() : this.openPanel('inventory'); event.preventDefault(); return true; }
    if (event.code === 'KeyT' || event.code === 'Slash') { this.openPanel('chat'); if (event.code === 'Slash') this.ui['chat-entry'].querySelector('input').value = '/'; event.preventDefault(); return true; }
    if (this.blocking) return true;
    if (event.code === 'Space' && this.currentState.canFly && !event.repeat) {
      const now = performance.now();
      if (now - this.lastJumpPress < 280) { this.session.setFlying(!this.currentState.flying); this.lastJumpPress = -Infinity; }
      else this.lastJumpPress = now;
      return false;
    }
    if (event.code === 'KeyQ') { this.session.dropItem(event.ctrlKey); event.preventDefault(); return true; }
    if (event.code === 'KeyF') { this.session.swapHands(); event.preventDefault(); return true; }
    return false;
  }

  close() { this.mouseUp(); this.closePanel(false); this.root.remove(); this.style.remove(); if (this.originalHotbar) this.originalHotbar.hidden = false; }
}
