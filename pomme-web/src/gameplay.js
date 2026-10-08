import { simplifyNbt, textComponent } from './minecraft.js';
import { rayBoxDistance } from './entities.js';
import { ServerHud, effectText } from './server-hud.js';
import { containerLayout, recipeMatchesMenu, tradePrice, BANNER_PATTERNS, BundleWheel, nextBundleSelection } from './container-ui.js';
import { bundleView } from './inventory-prediction.js';
import { renderTextComponent } from './text.js';
import { ItemIcons } from './item-icons.js';
import { ServerProgress, STATISTIC_CATEGORIES } from './server-progress.js';
import { BookDraft, bookContent } from './books.js';

const TOOL_SPEED = { wooden: 2, stone: 4, iron: 6, diamond: 8, netherite: 9, golden: 12 };
const SPRINT_SPEED_MODIFIER = '662a6b8d-da3e-4c1c-8813-96ea6097278d';
const itemEnchants = (slot) => simplifyNbt(slot?.nbtData)?.Enchantments || [];
const enchant = (slot, name) => itemEnchants(slot).find((item) => item.id === name || item.id === `minecraft:${name}`)?.lvl || 0;
const DEFAULT_CONTROLS = { forward: 'KeyW', back: 'KeyS', left: 'KeyA', right: 'KeyD', jump: 'Space', sneak: 'ShiftLeft', sprint: 'ControlLeft', inventory: 'KeyE', chat: 'KeyT', command: 'Slash', drop: 'KeyQ', offhand: 'KeyF', playerList: 'Tab', advancements: 'KeyL' };
const canonicalControls = { forward: 'KeyW', back: 'KeyS', left: 'KeyA', right: 'KeyD', jump: 'Space', sneak: 'ShiftLeft', sprint: 'ControlLeft' };
const controlLabel = (code) => code.replace(/^Key|^Digit/, '').replace('Left', ' (left)').replace('Right', ' (right)');

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
.server-actionbar{position:absolute;bottom:105px;left:50%;transform:translateX(-50%);max-width:80vw;text-align:center;text-shadow:0 2px 2px #000;font-size:16px}.server-titles{position:absolute;top:40%;left:10%;width:80%;text-align:center;text-shadow:0 3px 3px #000}.server-title{font-size:clamp(30px,5vw,64px);font-weight:700}.server-subtitle{font-size:clamp(18px,3vw,30px)}.server-bossbars{position:absolute;top:12px;left:50%;width:min(440px,60vw);transform:translateX(-50%);display:grid;gap:10px}.server-bossbar{text-align:center;text-shadow:0 1px 1px #000;font-weight:600}.server-bossbar progress{display:block;width:100%;height:12px;margin-top:3px;accent-color:var(--boss-color)}.server-scoreboard{position:absolute;right:12px;top:35%;min-width:150px;max-width:30vw;background:#101622b8;padding:10px;line-height:1.6;text-shadow:0 1px 1px #000}.server-scoreboard strong{display:block;text-align:center}.server-score-row{display:flex;justify-content:space-between;gap:20px}.server-score-number{color:#ff8181}.server-playerlist{position:absolute;top:60px;left:50%;transform:translateX(-50%);width:min(720px,90vw);background:#101622e8;padding:14px;text-align:center}.server-playerlist-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:3px;margin:8px 0}.server-player-row{display:flex;justify-content:space-between;gap:12px;padding:4px 8px;background:#203343b8;text-align:left}.server-player-ping{color:#b5ccbd;font-size:11px}.server-effects{position:absolute;right:12px;top:12px;display:grid;gap:4px;text-align:right}.server-effect{background:#101622b8;padding:4px 8px;border-radius:3px}.server-xp{position:absolute;bottom:104px;left:50%;transform:translateX(-50%);width:min(540px,88vw);height:5px;accent-color:#9cdb64}.server-air{color:#9cdbf3}.server-container-options{display:grid;gap:8px;margin:12px 0}.server-container-options input{background:#1b3347;color:white;border:1px solid #678291;padding:9px;font:inherit;box-sizing:border-box}.server-recipes{display:grid;grid-template-columns:repeat(auto-fit,minmax(145px,1fr));gap:5px;max-height:190px;overflow:auto}.server-recipes button,.server-trades button{text-align:left}.server-trades{display:grid;gap:5px}.server-inventory-grid[data-columns="1"]{max-width:70px}.server-inventory-grid[data-columns="2"]{max-width:150px}.server-inventory-grid[data-columns="3"]{max-width:230px}.server-inventory-grid[data-columns="4"]{max-width:300px}.server-controls{display:grid;grid-template-columns:1fr 1fr;gap:6px}.server-controls button{display:flex;justify-content:space-between;gap:15px}.server-effects-title{font-size:11px;color:#b7c7d1}.server-status-bars{display:flex;gap:7px;align-items:center}.server-recipe-help{font-size:11px;color:#b7c7d1}.server-container-meter{display:flex;gap:12px;align-items:center}.server-container-meter progress{width:140px;accent-color:#eda657}
.server-slot-icon{display:block;margin:auto;width:32px;height:32px;image-rendering:pixelated;object-fit:contain}.server-slot.has-icon .server-slot-name{font-size:8px;white-space:nowrap;text-overflow:ellipsis}.server-slot.enchanted{box-shadow:inset 0 0 12px #ab6bd548}.server-slot-durability{position:absolute;bottom:2px;left:8px;width:calc(100% - 16px);height:3px;background:#051015}.server-slot-durability span{display:block;height:100%;background:#70d566}
.server-menu{z-index:2}.server-inventory-grid .server-slot{min-height:44px;padding:5px 4px}.server-inventory-layout[data-menu="crafting"],.server-inventory-layout[data-menu="player"]{display:grid;grid-template-columns:1fr 1fr;gap:0 16px;align-items:center}.server-inventory-layout[data-menu="crafting"] .server-slot-group:nth-child(n+3),.server-inventory-layout[data-menu="player"] .server-slot-group:nth-child(n+3){grid-column:1/-1}.server-play-ui[data-panel="inventory"] .server-titles,.server-play-ui[data-panel="controls"] .server-titles{visibility:hidden}
.server-progress-tabs{display:flex;gap:5px;flex-wrap:wrap;margin-bottom:12px}.server-progress-tabs button[aria-selected="true"]{background:#426853!important;border-color:#b9e8db!important}.server-advancement-scroll{overflow:auto;max-height:52vh;background:#0c1924;border:1px solid #60798b;border-radius:6px}.server-advancement-tree{position:relative;min-height:250px}.server-advancement-tree svg{position:absolute;inset:0;pointer-events:none}.server-advancement-card{position:absolute;width:170px;min-height:85px;box-sizing:border-box;padding:10px;background:#273a4e;border:1px solid #728b9e;border-radius:6px}.server-advancement-card.complete{border-color:#aed17a;background:#2d4739}.server-advancement-card h3{font-size:13px;margin:0 0 5px}.server-advancement-card p{font-size:11px;line-height:1.4;margin:5px 0}.server-advancement-card progress{width:100%;accent-color:#a9d06d;height:7px}.server-advancement-icon{float:left;width:26px;height:26px;image-rendering:pixelated;margin-right:8px}.server-statistics-table{border-collapse:collapse;width:100%;font-size:12px}.server-statistics-table th,.server-statistics-table td{padding:7px 10px;border-bottom:1px solid #5a74824a;text-align:left}.server-statistics-table td:last-child,.server-statistics-table th:last-child{text-align:right}.server-advancement-toast{position:absolute;top:10px;right:12px;max-width:280px;background:#132231f2;border:1px solid #d5cf8b;padding:12px;border-radius:7px;z-index:3}.server-advancement-toast strong{display:block;color:#dbe1a4;margin-bottom:5px}.server-progress-panel{width:min(850px,92vw)}.server-progress-content{overflow:auto;max-height:61vh}
.server-book-panel{width:min(440px,90vw);background:#e2d5b5;color:#29241d}.server-book-panel p{color:#514538}.server-book-page{box-sizing:border-box;width:100%;height:280px;overflow:auto;white-space:pre-wrap;background:#f4e9d1;color:#29241d;border:1px solid #ac9874;padding:18px;font:16px/1.5 Georgia,serif;resize:none}.server-book-actions{display:flex;gap:8px;justify-content:center;margin-top:12px}.server-book-panel input{box-sizing:border-box;width:100%;padding:10px;font:inherit;border:1px solid #ac9874;background:#f4e9d1;color:#29241d}.server-play-ui[data-panel="advancements"] .server-titles,.server-play-ui[data-panel="statistics"] .server-titles,.server-play-ui[data-panel="book"] .server-titles{visibility:hidden}
`;

function hitInfo(hit) {
  if (!hit) return null;
  const array = Array.isArray(hit) || ArrayBuffer.isView(hit);
  return array ? { x: hit[0], y: hit[1], z: hit[2], stateId: hit[6], hit } : { x: hit.x, y: hit.y, z: hit.z, stateId: hit.stateId ?? hit.id, hit };
}
const sameTarget = (a, b) => a && b && a.x === b.x && a.y === b.y && a.z === b.z && a.stateId === b.stateId;

export class ServerGameplay {
  constructor({ session, registry, player, world, getEntities = () => null, onStatus = () => {}, onBlockSound = () => {} }) {
    this.session = session; this.registry = registry; this.player = player; this.world = world; this.onStatus = onStatus;
    this.getEntities = getEntities;
    this.onBlockSound = onBlockSound;
    this.lastJumpPress = -Infinity;
    this.currentState = { ...session.state };
    this.windows = new Map(); this.selectedSlot = 0; this.digging = null; this.awaitingBlock = null;
    this.holding = false; this.placing = false; this.digCooldown = 0; this.placeCooldown = 0;
    this.menu = null; this.hoverSlot = null; this.chatMessages = []; this.active = false;
    this.bundleWheel = new BundleWheel(); this.bundleHover = null;
    this.hud = new ServerHud(); this.windowMetadata = new Map(); this.windowProperties = new Map(); this.windowTrades = new Map(); this.anvilNames = new Map();
    this.progress = new ServerProgress(); this.statisticsCategory = 8;
    this.book = null;
    this.recipes = new Map(); this.unlockedRecipes = new Set(); this.recipeSearch = ''; this.recipeBookKnown = false; this.hudRefresh = 0; this.hudRevision = -1; this.bannerPatternTags = new Map();
    this.controls = { ...DEFAULT_CONTROLS }; this.captureControls = null;
    try { const saved = JSON.parse(localStorage.getItem('pomme-server-controls') || '{}'); for (const key of Object.keys(DEFAULT_CONTROLS)) if (typeof saved[key] === 'string') this.controls[key] = saved[key]; } catch {}
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
    const overlays = document.createElement('div');
    overlays.innerHTML = '<div class="server-actionbar" data-ui="actionbar" hidden></div><div class="server-titles" data-ui="titles" hidden><div class="server-title" data-ui="title"></div><div class="server-subtitle" data-ui="subtitle"></div></div><div class="server-bossbars" data-ui="bossbars"></div><aside class="server-scoreboard" aria-label="Server scoreboard" data-ui="scoreboard" hidden></aside><aside class="server-playerlist" aria-label="Player list" data-ui="playerlist" hidden></aside><aside class="server-effects" aria-label="Status effects" data-ui="effects"></aside><progress class="server-xp" data-ui="xp" max="1" value="0" aria-label="Experience progress"></progress>';
    this.root.append(overlays);
    this.bundleTooltip = document.createElement('aside'); this.bundleTooltip.className = 'server-bundle-tooltip'; this.bundleTooltip.hidden = true; this.bundleTooltip.setAttribute('role', 'tooltip'); this.root.append(this.bundleTooltip);
    this.style.textContent += '.server-bundle-tooltip{position:fixed;width:112px;padding:8px;background:#160e25f5;border:2px solid #6c40a2;border-radius:4px;box-shadow:0 5px 20px #0008;pointer-events:none;z-index:5;font:10px system-ui,sans-serif}.server-bundle-grid{display:grid;grid-template-columns:repeat(4,24px);grid-auto-rows:24px;width:96px}.server-bundle-cell{position:relative;display:grid;place-items:center;box-sizing:border-box;background:#342e41;border:1px solid #6e627f}.server-bundle-cell:empty{background:none;border-color:transparent}.server-bundle-cell.selected{outline:2px solid #edd4ff;outline-offset:-2px;background:#655379}.server-bundle-cell img{width:16px;height:16px;image-rendering:pixelated}.server-bundle-count{position:absolute;bottom:0;right:1px;color:white;text-shadow:1px 1px #000}.server-bundle-selected{display:block;font-size:11px;margin-bottom:5px;color:#f0ddff}.server-bundle-meter{position:relative;box-sizing:border-box;width:96px;height:13px;margin-top:4px;border:1px solid #ddd;background:#252331;overflow:hidden}.server-bundle-meter-fill{height:100%;background:#7187ff}.server-bundle-meter.full .server-bundle-meter-fill{background:#ff5555}.server-bundle-meter-label{position:absolute;inset:0;text-align:center;line-height:11px;color:white;text-shadow:1px 1px #000}.server-bundle-description{margin:0 0 4px;color:#aaa;line-height:1.3}.server-slot-bundle-meter{background:#080811}.server-slot-bundle-meter span{background:#7187ff}.server-slot-bundle-meter.full span{background:#ff5555}';
    for (const node of overlays.querySelectorAll('[data-ui]')) this.ui[node.dataset.ui] = node;
    this.ui.air = document.createElement('span'); this.ui.air.className = 'server-air'; this.ui.health.after(this.ui.air);
    this.ui['container-options'] = document.createElement('div'); this.ui['container-options'].className = 'server-container-options'; this.ui.slots.after(this.ui['container-options']);
    const controlsButton = document.createElement('button'); controlsButton.type = 'button'; controlsButton.textContent = 'Controls'; controlsButton.dataset.ui = 'controls-open';
    controlsButton.addEventListener('click', () => this.openPanel('controls')); this.ui['inventory-close'].before(controlsButton);
    this.ui['controls-panel'] = document.createElement('section'); this.ui['controls-panel'].className = 'server-menu'; this.ui['controls-panel'].hidden = true; this.ui['controls-panel'].setAttribute('aria-label', 'Controls'); this.ui['controls-panel'].setAttribute('role', 'dialog');
    this.root.append(this.ui['controls-panel']);
    this.ui['progress-panel'] = document.createElement('section'); this.ui['progress-panel'].className = 'server-menu server-progress-panel'; this.ui['progress-panel'].hidden = true; this.ui['progress-panel'].setAttribute('role', 'dialog'); this.ui['progress-panel'].setAttribute('aria-modal', 'true'); this.root.append(this.ui['progress-panel']);
    this.ui.toast = document.createElement('aside'); this.ui.toast.className = 'server-advancement-toast'; this.ui.toast.hidden = true; this.ui.toast.setAttribute('role', 'status'); this.root.append(this.ui.toast);
    this.ui['book-panel'] = document.createElement('section'); this.ui['book-panel'].className = 'server-menu server-book-panel'; this.ui['book-panel'].hidden = true; this.ui['book-panel'].setAttribute('role', 'dialog'); this.ui['book-panel'].setAttribute('aria-label', 'Book'); this.root.append(this.ui['book-panel']);
    for (const [panel, label] of [['advancements', 'Advancements'], ['statistics', 'Statistics']]) {
      const button = document.createElement('button'); button.type = 'button'; button.textContent = label; button.dataset.ui = `${panel}-open`; button.addEventListener('click', () => this.openPanel(panel)); this.ui['inventory-close'].before(button);
    }
    this.onWindowBlur = () => { this.mouseUp(); this.clearBundleHover(); this.ui.playerlist.hidden = true; this.session.sneak(false); this.session.sprint(false); };
    window.addEventListener('blur', this.onWindowBlur);
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
    this.onInventoryPointerDown = event => {
      if (this.menu !== 'inventory' || event.button > 2 || event.button === 1 && this.currentState.gameMode !== 1 || event.shiftKey || !this.windows.get(this.currentState.windowId || 0)?.cursor?.present) return;
      const target = event.target.closest?.('[data-ui="slots"] [data-slot]');
      if (!target) return;
      event.preventDefault();
      const slot = Number(target.dataset.slot);
      this.inventoryDrag = { windowId: this.currentState.windowId || 0, kind: event.button === 2 ? 1 : event.button === 1 ? 2 : 0, first: slot, visited: new Set(), active: false, doubleClick: event.button === 0 && this.inventoryLastClick?.slot === slot && performance.now() - this.inventoryLastClick.time < 300 };
    };
    this.onInventoryPointerMove = event => {
      const drag = this.inventoryDrag;
      const target = event.target.closest?.('[data-ui="slots"] [data-slot]');
      if (!drag || !target) return;
      const slot = Number(target.dataset.slot);
      if (slot === drag.first || drag.visited.has(slot)) return;
      if (!drag.active) {
        drag.active = true;
        this.session.clickWindow(-999, { windowId: drag.windowId, mode: 5, button: drag.kind << 2 });
        this.session.clickWindow(drag.first, { windowId: drag.windowId, mode: 5, button: drag.kind << 2 | 1 });
        drag.visited.add(drag.first);
      }
      drag.visited.add(slot);
      this.session.clickWindow(slot, { windowId: drag.windowId, mode: 5, button: drag.kind << 2 | 1 });
    };
    this.onInventoryPointerUp = event => {
      const drag = this.inventoryDrag; if (!drag) return;
      this.inventoryDrag = null; this.ignoreInventoryClickUntil = performance.now() + 100;
      const target = event.target.closest?.('[data-ui="slots"] [data-slot]');
      if (drag.active) this.session.clickWindow(-999, { windowId: drag.windowId, mode: 5, button: drag.kind << 2 | 2 });
      else this.session.clickWindow(target ? Number(target.dataset.slot) : -999, { windowId: drag.windowId, button: drag.kind, mode: drag.doubleClick ? 6 : 0 });
      this.inventoryLastClick = { slot: target ? Number(target.dataset.slot) : -999, time: performance.now() };
    };
    this.root.addEventListener('pointerdown', this.onInventoryPointerDown);
    this.root.addEventListener('pointermove', this.onInventoryPointerMove);
    document.addEventListener('pointerup', this.onInventoryPointerUp);
    this.onBundleWheel = event => {
      const button = event.target.closest?.('[data-ui="slots"] [data-slot]');
      if (this.menu !== 'inventory' || !button || !this.session.adapter?.modern) return;
      const slot = Number(button.dataset.slot), id = this.currentState.windowId || 0, stack = this.windows.get(id)?.slots[slot];
      const view = bundleView(stack, this.items, { componentId: this.session.adapter.bundleComponentId });
      if (!view?.shown) return;
      const divisor = event.deltaMode === 1 ? 3 : event.deltaMode === 2 ? 1 : 100;
      const wheel = this.bundleWheel.step(event.deltaX / divisor, -event.deltaY / divisor);
      if (wheel) { const selected = nextBundleSelection(wheel, view.selected, view.shown); if (selected !== view.selected) this.session.selectBundleItem(slot, selected, id); }
      event.preventDefault(); event.stopPropagation(); this.renderBundleTooltip();
    };
    this.root.addEventListener('wheel', this.onBundleWheel, { passive: false });
    this.renderHotbar();
  }

  get blocking() { return Boolean(this.menu || !this.ui.death.hidden); }
  controlCode(code) {
    for (const [action, canonical] of Object.entries(canonicalControls)) if (this.controls[action] === code || ((action === 'sneak' || action === 'sprint') && code === this.controls[action].replace('Left', 'Right'))) return canonical;
    return Object.values(canonicalControls).includes(code) ? null : code;
  }
  readBlock(x, y, z) { return this.world?.block_get?.(x, y, z) ?? this.world?.getBlock?.(x, y, z) ?? this.world?.core?.block_get?.(x, y, z); }
  target() { return hitInfo(this.player?.target?.()); }
  currentItem() { return this.windows.get(0)?.slots[36 + this.selectedSlot] || { present: false }; }

  slotButton(slot) {
    const button = document.createElement('button'); button.type = 'button'; button.className = 'server-slot'; button.dataset.slot = slot;
    button.innerHTML = '<span class="server-slot-key"></span><span class="server-slot-name"></span><span class="server-slot-count"></span>';
    button.addEventListener('mouseenter', () => {
      this.hoverSlot = slot;
      if (this.menu === 'inventory' && button.closest('[data-ui="slots"]')) {
        const old = this.bundleHover; this.bundleHover = { slot, windowId: this.currentState.windowId || 0 };
        if (old && (old.slot !== slot || old.windowId !== this.bundleHover.windowId)) this.session.selectBundleItem(old.slot, -1, old.windowId);
        this.renderBundleTooltip();
      }
    });
    button.addEventListener('mouseleave', () => {
      if (this.hoverSlot === slot) this.hoverSlot = null;
      if (!this.rebuildingInventory && this.bundleHover?.slot === slot && !button.matches(':hover')) this.clearBundleHover();
    });
    return button;
  }

  fillSlot(button, item, key = '') {
    const definition = item?.present ? this.items.get(item.itemId) : null;
    const nbt = simplifyNbt(item?.nbtData), customName = textComponent(nbt?.display?.Name || '');
    button.querySelector('.server-slot-key').textContent = key;
    button.querySelector('.server-slot-name').textContent = customName || definition?.displayName || (item?.present ? `Item ${item.itemId}` : '');
    button.querySelector('.server-slot-count').textContent = item?.present && item.itemCount > 1 ? String(item.itemCount) : '';
    const lore = (nbt?.display?.Lore || []).map(textComponent), enchantments = [...itemEnchants(item), ...(nbt?.StoredEnchantments || [])];
    button.title = [customName || definition?.displayName || 'Empty slot', ...lore, ...enchantments.map((entry) => `${String(entry.id).replace('minecraft:', '').replaceAll('_', ' ')} ${entry.lvl}`)].join('\n');
    button.classList.toggle('enchanted', enchantments.length > 0 || Boolean(nbt?.StoredEnchantments?.length));
    button.querySelector('.server-slot-icon')?.remove(); button.querySelector('.server-slot-durability')?.remove();
    const icon = this.itemIcons?.url(definition);
    button.classList.toggle('has-icon', Boolean(icon));
    if (icon) { const image = document.createElement('img'); image.className = 'server-slot-icon'; image.src = icon; image.alt = ''; image.draggable = false; button.querySelector('.server-slot-name').before(image); }
    if (definition?.maxDurability && nbt?.Damage > 0) {
      const bar = document.createElement('span'); bar.className = 'server-slot-durability'; const level = document.createElement('span'); level.style.width = `${Math.max(0, 1 - nbt.Damage / definition.maxDurability) * 100}%`; bar.append(level); button.append(bar);
      button.title += `\nDurability: ${Math.max(0, definition.maxDurability - nbt.Damage)} / ${definition.maxDurability}`;
    }
    const bundle = this.session.adapter?.modern && bundleView(item, this.items, { componentId: this.session.adapter.bundleComponentId });
    if (bundle?.weight > 0) {
      const bar = document.createElement('span'); bar.className = `server-slot-durability server-slot-bundle-meter${bundle.full ? ' full' : ''}`;
      const fill = document.createElement('span'); fill.style.width = `${Math.min(13, 1 + Math.floor(bundle.weight * 12)) / 13 * 100}%`; bar.append(fill); button.append(bar);
    }
    button.setAttribute('aria-label', `${button.title}, slot ${Number(button.dataset.slot) + 1}${item?.present ? `, ${item.itemCount} items` : ''}`);
  }

  clearBundleHover() {
    const previous = this.bundleHover; this.bundleHover = null; this.bundleTooltip.hidden = true;
    if (previous && this.session.adapter?.modern) this.session.selectBundleItem(previous.slot, -1, previous.windowId);
  }

  renderBundleTooltip() {
    const hover = this.bundleHover;
    const stack = hover && this.windows.get(hover.windowId)?.slots[hover.slot];
    const view = this.session.adapter?.modern && bundleView(stack, this.items, { componentId: this.session.adapter.bundleComponentId });
    this.bundleTooltip.hidden = this.menu !== 'inventory' || !view?.tooltipVisible;
    if (this.bundleTooltip.hidden) return;
    this.bundleTooltip.replaceChildren();
    if (view.selected >= 0 && view.contents[view.selected]) {
      const item = view.contents[view.selected], selected = document.createElement('strong'); selected.className = 'server-bundle-selected';
      const custom = item.components?.find(component => component.type === 'custom_name')?.data;
      renderTextComponent(selected, custom ?? { text: this.items.get(item.itemId)?.displayName || 'Item' });
      this.bundleTooltip.append(selected);
    }
    if (!view.contents.length) { const description = document.createElement('p'); description.className = 'server-bundle-description'; description.textContent = textComponent({ translate: 'item.minecraft.bundle.empty.description', fallback: 'Bundles let you store different items together.' }); this.bundleTooltip.append(description); }
    else {
      const grid = document.createElement('div'); grid.className = 'server-bundle-grid'; grid.setAttribute('aria-label', 'Bundle contents');
      for (const entry of view.cells) {
        const cell = document.createElement('span'); cell.className = 'server-bundle-cell';
        if (entry?.stack) {
          const definition = this.items.get(entry.stack.itemId); cell.dataset.bundleIndex = entry.index; cell.classList.toggle('selected', entry.index === view.selected); cell.setAttribute('aria-label', `${definition?.displayName || 'Item'}, ${entry.stack.itemCount} items`);
          const url = this.itemIcons?.url(definition);
          if (url) { const image = document.createElement('img'); image.src = url; image.alt = ''; cell.append(image); }
          else cell.append(document.createTextNode((definition?.displayName || '?').slice(0, 2)));
          if (entry.stack.itemCount > 1) { const count = document.createElement('span'); count.className = 'server-bundle-count'; count.textContent = entry.stack.itemCount; cell.append(count); }
        } else if (entry?.surplus) { cell.textContent = `+${entry.surplus}`; cell.dataset.bundleSurplus = entry.surplus; cell.setAttribute('aria-label', `${entry.surplus} more items`); }
        grid.append(cell);
      }
      this.bundleTooltip.append(grid);
    }
    const meter = document.createElement('div'); meter.className = `server-bundle-meter${view.full ? ' full' : ''}`; meter.setAttribute('role', 'meter'); meter.setAttribute('aria-label', 'Bundle capacity'); meter.setAttribute('aria-valuemin', '0'); meter.setAttribute('aria-valuemax', '1'); meter.setAttribute('aria-valuenow', String(view.weight));
    const fill = document.createElement('div'); fill.className = 'server-bundle-meter-fill'; fill.style.width = `${view.fill}px`; meter.append(fill);
    if (!view.contents.length || view.full) { const label = document.createElement('span'); label.className = 'server-bundle-meter-label'; label.textContent = textComponent({ translate: view.full ? 'item.minecraft.bundle.full' : 'item.minecraft.bundle.empty', fallback: view.full ? 'Full' : 'Empty' }); meter.append(label); }
    this.bundleTooltip.append(meter);
    const anchor = this.ui.slots.querySelector(`[data-slot="${hover.slot}"]`)?.getBoundingClientRect();
    if (anchor) { const rect = this.bundleTooltip.getBoundingClientRect(); this.bundleTooltip.style.left = `${Math.max(8, Math.min(innerWidth - rect.width - 8, anchor.right + 8))}px`; this.bundleTooltip.style.top = `${Math.max(8, Math.min(innerHeight - rect.height - 8, anchor.top))}px`; }
  }

  setAssets({ atlas, materials } = {}) {
    this.itemIcons = atlas?.pixelsRGBA ? new ItemIcons(atlas, materials, this.registry) : null;
    this.hud.refreshLanguage(); this.renderHud(); this.renderChat(); this.renderToast();
    this.renderHotbar(); if (this.menu === 'inventory') this.renderInventory();
    if (['advancements', 'statistics'].includes(this.menu)) this.renderProgress();
    if (this.menu === 'book') this.renderBook();
  }

  state(state) {
    const previouslyActive = this.active;
    this.currentState = { ...state, effects: (state.effects || []).map((effect) => ({ ...effect })) }; this.selectedSlot = state.selectedSlot || 0;
    this.active = ['loading', 'playing', 'connected'].includes(state.status);
    this.root.hidden = !this.active;
    if (this.originalHotbar) this.originalHotbar.hidden = this.active;
    if (!this.active && previouslyActive) { this.mouseUp(); this.closePanel(false); }
    this.ui.health.textContent = `♥ ${Math.max(0, state.health ?? 20).toFixed(0)} / 20`;
    this.ui.food.textContent = `Food ${state.food ?? 20} / 20`;
    this.ui.level.textContent = `Level ${state.experienceLevel || 0}`;
    if (this.ui.xp) this.ui.xp.value = Math.max(0, Math.min(1, state.experience || 0));
    if (this.ui.air) { this.ui.air.hidden = (state.airSupply ?? 300) >= 300; this.ui.air.textContent = `Air ${Math.max(0, Math.ceil((state.airSupply ?? 300) / 30))} / 10`; }
    if (state.absorption > 0) this.ui.health.textContent += ` + ${Math.ceil(state.absorption)} absorption`;
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
    if (this.hud) this.renderHud();
  }

  inventory(window) {
    this.windows.set(window.windowId, { ...window, slots: [...window.slots] });
    this.selectedSlot = window.selectedSlot ?? this.selectedSlot;
    if (window.windowId === 0) this.renderHotbar();
    if (this.menu === 'inventory') this.renderInventory();
  }

  event(event) {
    if (event.type === 'hud') { this.hud.packet(event.name, event.data); this.renderHud(); }
    else if (event.type === 'open-book') this.openBook(event.hand);
    else if (event.type === 'advancements') {
      const previousTab = this.progress.selectedTab; this.progress.advancement(event);
      if (this.menu === 'advancements') { this.renderProgress(); if (previousTab !== this.progress.selectedTab && this.progress.selectedTab) this.session.packet('advancement_tab', { action: 0, tabId: this.progress.selectedTab }); }
      this.renderToast();
    }
    else if (event.type === 'advancement-tab') { this.progress.selectedTab = event.id; if (this.menu === 'advancements') this.renderProgress(); }
    else if (event.type === 'statistics') { this.progress.stats(event.entries); if (this.menu === 'statistics') this.renderProgress(); }
    else if (event.type === 'tags') {
      const registry = event.tags?.find((entry) => entry.tagType === 'minecraft:banner_pattern');
      if (registry) this.bannerPatternTags = new Map(registry.tags.map((tag) => [tag.tagName, tag.entries]));
      if (this.menu === 'inventory') this.renderContainerOptions();
    }
    else if (event.type === 'player-list') { this.hud.players = event.players; this.renderHud(); }
    else if (event.type === 'window-properties') {
      const properties = this.windowProperties.get(event.windowId) || new Map();
      properties.set(event.property, event.value); this.windowProperties.set(event.windowId, properties);
      if (this.menu === 'inventory' && event.windowId === (this.currentState.windowId || 0)) {
        this.renderContainerOptions(); this.renderCrafterSlots();
      }
    } else if (event.type === 'trades') {
      this.windowTrades.set(event.windowId, event); if (this.menu === 'inventory') this.renderContainerOptions();
    } else if (event.type === 'recipes') {
      this.recipes = new Map((event.recipes || []).map((recipe) => [recipe.recipeId, recipe])); if (this.menu === 'inventory') this.renderContainerOptions();
    } else if (event.type === 'unlock-recipes') {
      this.recipeBookKnown = true;
      if (event.action === 0) this.unlockedRecipes.clear();
      for (const recipe of event.recipes1 || []) event.action === 2 ? this.unlockedRecipes.delete(recipe) : this.unlockedRecipes.add(recipe);
      if (this.menu === 'inventory') this.renderContainerOptions();
    } else if (event.type === 'chat') {
      if (event.actionBar) { this.hud.action(event.text, event.component); this.renderHud(); return; }
      this.chatMessages.push(event.component ?? { text: String(event.text) }); if (this.chatMessages.length > 80) this.chatMessages.shift();
      this.renderChat();
    } else if (event.type === 'death') {
      if (event.text || event.component) renderTextComponent(this.ui['death-message'], event.component ?? { text: event.text });
      this.showDeath();
    } else if (event.type === 'window') {
      this.windowMetadata.set(event.windowId, event); this.windowProperties.delete(event.windowId); this.windowTrades.delete(event.windowId); this.anvilNames.delete(event.windowId);
      renderTextComponent(this.ui['inventory-title'], event.titleComponent ?? { text: event.title || 'Container' });
      this.openPanel('inventory');
    } else if (event.type === 'close-window') this.closePanel(false, false);
    else if (event.type === 'player-velocity') {
      // Protocol velocities are blocks/tick. Player physics uses metres/second.
      const delta = [event.velocity.x * 20, event.velocity.y * 20, event.velocity.z * 20];
      this.player.velocity = event.additive ? delta.map((value, axis) => this.player.velocity[axis] + value) : delta;
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

  renderHud() {
    const hud = this.hud;
    renderTextComponent(this.ui.actionbar, hud.actionBarComponent ?? hud.actionBar); this.ui.actionbar.hidden = hud.actionRemaining <= 0;
    renderTextComponent(this.ui.title, hud.titleComponent ?? hud.title); renderTextComponent(this.ui.subtitle, hud.subtitleComponent ?? hud.subtitle);
    this.ui.titles.hidden = hud.titleRemaining <= 0; this.ui.titles.style.opacity = hud.titleOpacity;
    const colors = ['#e88ec3', '#70a1f2', '#ee6565', '#87d369', '#e3d66d', '#b789e8', '#f7f7f7'];
    this.ui.bossbars.replaceChildren(...[...hud.bossBars.values()].slice(0, 6).map((bar) => {
      const node = document.createElement('div'); node.className = 'server-bossbar'; node.dataset.boss = bar.entityUUID; renderTextComponent(node, bar.titleComponent ?? bar.title);
      node.style.setProperty('--boss-color', colors[bar.color] || colors[5]);
      const meter = document.createElement('progress'); meter.max = 1; meter.value = bar.health; meter.setAttribute('aria-label', `${bar.title} health`);
      node.append(meter); return node;
    }));
    const sidebar = hud.sidebarComponents(this.currentState.username);
    this.ui.scoreboard.hidden = !sidebar;
    this.ui.scoreboard.replaceChildren();
    if (sidebar) {
      const heading = document.createElement('strong'); renderTextComponent(heading, sidebar.titleComponent); this.ui.scoreboard.append(heading);
      for (const row of sidebar.rows) { const node = document.createElement('div'); node.className = 'server-score-row'; const name = document.createElement('span'); renderTextComponent(name, row.nameComponent); const value = document.createElement('span'); value.className = 'server-score-number'; renderTextComponent(value, row.valueComponent); node.append(name, value); this.ui.scoreboard.append(node); }
    }
    const header = document.createElement('div'); renderTextComponent(header, hud.headerComponent ?? hud.header);
    const footer = document.createElement('div'); renderTextComponent(footer, hud.footerComponent ?? hud.footer);
    const players = document.createElement('div'); players.className = 'server-playerlist-grid';
    for (const player of hud.playerList()) {
      const row = document.createElement('div'); row.className = 'server-player-row'; const name = document.createElement('span'); renderTextComponent(name, player.displayComponent ?? player.display); if (player.gamemode === 3) name.style.fontStyle = 'italic';
      const right = document.createElement('span'); right.className = 'server-player-ping'; const score = document.createElement('span'); renderTextComponent(score, player.scoreComponent ?? player.score);
      if (score.textContent) right.append(score, document.createTextNode(' · ')); right.append(document.createTextNode(`${Math.max(0, player.latency || 0)} ms`)); row.append(name, right); players.append(row);
    }
    this.ui.playerlist.replaceChildren(header, players, footer);
    this.renderEffects(); this.hudRevision = hud.revision;
  }

  renderChat() {
    this.ui['chat-log'].replaceChildren(...this.chatMessages.slice(-5).map(component => { const line = document.createElement('div'); line.className = 'server-chat-line'; renderTextComponent(line, component); return line; }));
  }

  renderEffects() {
    this.ui.effects.replaceChildren(...(this.currentState.effects || []).filter((effect) => effect.showIcon !== false).map((effect) => {
      const node = document.createElement('div'); node.className = 'server-effect'; node.textContent = effectText(effect); return node;
    }));
  }

  renderInventory() {
    const id = this.currentState.windowId || 0, window = this.windows.get(id);
    const metadata = this.windowMetadata.get(id); if (metadata) renderTextComponent(this.ui['inventory-title'], metadata.titleComponent ?? { text: metadata.title || 'Container' });
    const slots = this.ui.slots; this.rebuildingInventory = true; slots.replaceChildren(); this.rebuildingInventory = false;
    if (!window) { slots.textContent = 'Waiting for the server inventory…'; return; }
    const group = (title, indexes, columns) => {
      const label = document.createElement('p'); label.className = 'server-crafting-note'; label.textContent = title;
      const grid = document.createElement('div'); grid.className = 'server-inventory-grid';
      grid.style.gridTemplateColumns = `repeat(${columns}, minmax(0,1fr))`; grid.dataset.columns = columns;
      for (const index of indexes) {
        const button = this.slotButton(index); this.fillSlot(button, window.slots[index]);
        button.addEventListener('click', (event) => {
          if (event.detail >= 2 || this.inventoryDrag || performance.now() < (this.ignoreInventoryClickUntil || 0)) return;
          if (slots.dataset.menu === 'crafter_3x3' && index === 45) return;
          if (slots.dataset.menu === 'crafter_3x3' && index < 9 && !window.slots[index]?.present && !window.cursor?.present) {
            this.session.packet('set_slot_state', { slot_id: index, window_id: id, state: this.windowProperties.get(id)?.get(index) === 1 }); return;
          }
          this.session.clickWindow(index, { mode: event.shiftKey ? 1 : 0, button: 0, windowId: id });
          this.inventoryLastClick = { slot: index, time: performance.now() };
        });
        button.addEventListener('contextmenu', (event) => { event.preventDefault(); if (!this.inventoryDrag && performance.now() >= (this.ignoreInventoryClickUntil || 0)) this.session.clickWindow(index, { button: 1, windowId: id }); });
        button.addEventListener('auxclick', event => { if (event.button === 1 && !this.inventoryDrag && performance.now() >= (this.ignoreInventoryClickUntil || 0)) { event.preventDefault(); this.session.clickWindow(index, { mode: 3, windowId: id }); } });
        button.addEventListener('dblclick', () => { if (performance.now() >= (this.ignoreInventoryClickUntil || 0)) this.session.clickWindow(index, { mode: 6, button: 0, windowId: id }); });
        grid.append(button);
      }
      const section = document.createElement('section'); section.className = 'server-slot-group'; section.append(label, grid); slots.append(section);
    };
    const layout = containerLayout(id, this.windowMetadata.get(id)?.inventoryType, window.slots.length, this.windowMetadata.get(id));
    slots.className = 'server-inventory-layout'; slots.dataset.menu = layout.name;
    for (const section of layout.groups) group(section.name, section.slots, section.columns);
    const carried = window.cursor;
    this.ui.cursor.textContent = carried?.present ? `Carrying ${carried.itemCount} × ${this.items.get(carried.itemId)?.displayName || `item ${carried.itemId}`}` : 'No stack carried';
    this.renderBundleTooltip();
    if (this.currentState.gameMode === 1) this.renderCreative();
    this.renderContainerOptions();
    this.renderCrafterSlots();
  }

  renderCrafterSlots() {
    if (this.ui.slots.dataset.menu !== 'crafter_3x3') return;
    const properties = this.windowProperties.get(this.currentState.windowId || 0);
    for (const slot of this.ui.slots.querySelectorAll('[data-slot]')) {
      const index = Number(slot.dataset.slot); if (index >= 9) continue;
      const disabled = properties?.get(index) === 1; slot.classList.toggle('crafter-disabled', disabled);
      slot.setAttribute('aria-label', `Crafter slot ${index + 1}${disabled ? ', disabled' : ''}. Empty slots toggle when clicked.`);
      slot.style.background = disabled ? '#542f35' : '';
    }
  }

  containerButton(button, windowId = this.currentState.windowId || 0) { return this.session.packet('enchant_item', { windowId, enchantment: button }); }

  renderContainerOptions() {
    const id = this.currentState.windowId || 0, window = this.windows.get(id);
    const options = this.ui['container-options'];
    const focused = options.contains(document.activeElement) ? document.activeElement.dataset.field : null;
    const selection = focused ? [document.activeElement.selectionStart, document.activeElement.selectionEnd] : null;
    options.replaceChildren(); if (!window) return;
    const name = containerLayout(id, this.windowMetadata.get(id)?.inventoryType, window.slots.length).name;
    const properties = this.windowProperties.get(id) || new Map();
    const note = (text) => { const node = document.createElement('p'); node.className = 'server-crafting-note'; renderTextComponent(node, typeof text === 'string' ? { text } : text); options.append(node); };
    const button = (text, click, disabled = false) => { const node = document.createElement('button'); node.type = 'button'; node.textContent = text; node.disabled = disabled; node.addEventListener('click', click); return node; };
    const meter = (label, value, max) => { const row = document.createElement('div'); row.className = 'server-container-meter'; const text = document.createElement('span'); text.textContent = `${label}: ${value} / ${max}`; const progress = document.createElement('progress'); progress.max = Math.max(1, max); progress.value = Math.max(0, value); progress.setAttribute('aria-label', label); row.append(text, progress); options.append(row); };
    if (name === 'anvil') {
      const input = document.createElement('input'); input.type = 'text'; input.maxLength = 50; input.setAttribute('aria-label', 'Rename item'); input.dataset.field = 'anvil-name';
      const source = window.slots[0], definition = this.items.get(source?.itemId);
      input.value = this.anvilNames.get(id) ?? textComponent(simplifyNbt(source?.nbtData)?.display?.Name || definition?.displayName || '');
      input.disabled = !source?.present;
      input.addEventListener('input', () => { this.anvilNames.set(id, input.value); this.session.packet('name_item', { name: input.value }); });
      options.append(input); const cost = properties.get(0) || 0;
      note(cost >= 40 && this.currentState.gameMode !== 1 ? 'Too expensive!' : `Repair cost: ${cost} experience level${cost === 1 ? '' : 's'}`);
    } else if (name === 'enchantment') {
      for (let index = 0; index < 3; index++) {
        const cost = properties.get(index) || 0, enchantment = properties.get(4 + index), level = properties.get(7 + index);
        const definition = this.registry.enchantments?.find((entry) => entry.id === enchantment);
        const label = definition?.displayName || (enchantment >= 0 ? `Enchantment ${enchantment}` : 'Unknown enchantment');
        const available = cost > 0 && window.slots[0]?.present && (this.currentState.gameMode === 1 || ((this.currentState.experienceLevel || 0) >= cost && (window.slots[1]?.itemCount || 0) >= index + 1));
        options.append(button(`${index + 1}. ${label}${level > 0 ? ` ${level}` : ''}… · Requires level ${cost} · Costs ${index + 1} lapis and level${index ? 's' : ''}`, () => this.containerButton(index, id), !available));
      }
    } else if (name === 'merchant') {
      const data = this.windowTrades.get(id);
      if (!data) note('Waiting for the server’s trade offers…');
      else {
        note(`Villager level ${data.villagerLevel} · ${data.experience} experience${data.canRestock ? ' · Can restock' : ''}`);
        const trades = document.createElement('div'); trades.className = 'server-trades';
        data.trades.forEach((trade, index) => {
          const itemName = (slot) => this.items.get(slot?.itemId)?.displayName || `Item ${slot?.itemId}`;
          const extra = trade.inputItem2?.present ? ` + ${trade.inputItem2.itemCount} ${itemName(trade.inputItem2)}` : '';
          const exhausted = trade.tradeDisabled || trade.nbTradeUses >= trade.maximumNbTradeUses;
          const label = `${tradePrice(trade, this.items.get(trade.inputItem1?.itemId))} ${itemName(trade.inputItem1)}${extra} → ${trade.outputItem.itemCount} ${itemName(trade.outputItem)}${exhausted ? ' · Out of stock' : ''}`;
          const select = button(label, () => { this.session.packet('select_trade', { slot: index }); }, exhausted); select.dataset.trade = index; trades.append(select);
        }); options.append(trades);
      }
    } else if (['furnace', 'blast_furnace', 'smoker'].includes(name)) {
      meter('Fuel remaining', properties.get(0) || 0, properties.get(1) || 0);
      meter('Cooking progress', properties.get(2) || 0, properties.get(3) || 0);
    } else if (name === 'brewing_stand') {
      meter('Brewing ticks remaining', properties.get(0) || 0, 400); meter('Blaze powder fuel', properties.get(1) || 0, 20);
    } else if (name === 'lectern') {
      const pages = bookContent(window.slots[0]).pages, page = Math.max(0, properties.get(0) || 0);
      note({ translate: 'book.pageIndicator', fallback: 'Page %1$s of %2$s', with: [page + 1, Math.max(1, pages.length)] });
      const content = document.createElement('div'); content.className = 'server-crafting-note'; renderTextComponent(content, pages[page] ?? { text: '' }); options.append(content);
      options.append(button('Previous page', () => this.containerButton(1, id), page <= 0), button('Next page', () => this.containerButton(2, id), pages.length > 0 && page >= pages.length - 1), button('Take book', () => this.containerButton(3, id)));
    } else if (name === 'beacon') {
      const effects = [[0, 'Speed', 1], [2, 'Haste', 1], [10, 'Resistance', 2], [7, 'Jump boost', 2], [4, 'Strength', 3]];
      const select = document.createElement('select'); select.setAttribute('aria-label', 'Beacon primary effect');
      for (const [effect, label, required] of effects) { const option = document.createElement('option'); option.value = effect; option.textContent = label; option.disabled = (properties.get(0) || 0) < required; select.append(option); }
      select.value = properties.get(1) >= 0 ? String(properties.get(1)) : '0';
      const secondary = document.createElement('select'); secondary.setAttribute('aria-label', 'Beacon secondary effect');
      for (const [value, label] of [['none', 'No secondary effect'], ['9', 'Regeneration'], ['same', 'Primary effect II']]) { const option = document.createElement('option'); option.value = value; option.textContent = label; secondary.append(option); }
      secondary.disabled = (properties.get(0) || 0) < 4;
      options.append(select, secondary, button('Confirm beacon effects', () => {
        const primary = Number(select.value), second = secondary.disabled || secondary.value === 'none' ? undefined : secondary.value === 'same' ? primary : Number(secondary.value);
        this.session.packet('set_beacon_effect', { primary_effect: primary, secondary_effect: second });
      }, !window.slots[0]?.present || (properties.get(0) || 0) < 1));
    } else if (name === 'crafter_3x3') {
      note(properties.get(9) === 1 ? 'Powered by redstone' : 'Waiting for a redstone pulse');
      note('Click an empty grid slot while carrying no item to enable or disable it. The last slot previews the recipe.');
    } else if (name === 'loom') {
      const patternItem = this.items.get(window.slots[2]?.itemId)?.name;
      const tag = patternItem?.endsWith('_banner_pattern') ? `minecraft:pattern_item/${patternItem.replace('_banner_pattern', '')}` : 'minecraft:no_item_required';
      const patterns = this.bannerPatternTags.get(tag) || [];
      if (!patterns.length) note('Waiting for the server’s banner pattern tags.');
      else {
        const list = document.createElement('div'); list.className = 'server-recipes';
        const ready = Boolean(window.slots[0]?.present && window.slots[1]?.present);
        patterns.forEach((pattern, index) => {
          const label = (BANNER_PATTERNS[pattern] || `Pattern ${pattern}`).replaceAll('_', ' ');
          const choose = button(label, () => this.containerButton(index, id), !ready); choose.dataset.pattern = index; list.append(choose);
        }); options.append(list);
      }
    }
    const recipes = [...this.recipes.values()].filter((recipe) => recipeMatchesMenu(recipe, name) && (name !== 'stonecutter' || !this.session.adapter?.modern || recipe.source === 'stonecutter') && (name === 'stonecutter' || !this.recipeBookKnown || this.unlockedRecipes.has(recipe.recipeId)));
    if (recipes.length && ['player', 'crafting', 'furnace', 'blast_furnace', 'smoker', 'stonecutter'].includes(name)) {
      const input = document.createElement('input'); input.type = 'search'; input.placeholder = 'Search recipes…'; input.setAttribute('aria-label', 'Search recipes'); input.dataset.field = 'recipe-search'; input.value = this.recipeSearch;
      input.addEventListener('input', () => { this.recipeSearch = input.value; this.renderContainerOptions(); }); options.append(input);
      const list = document.createElement('div'); list.className = 'server-recipes';
      let eligible = recipes;
      if (name === 'stonecutter') {
        const description = (recipe) => { const item = this.items.get(recipe.data.result.itemId); return `${this.itemsByName.has(item?.name) && this.registry.blocks.some((block) => block.name === item?.name) ? 'block' : 'item'}.minecraft.${item?.name || ''}`; };
        eligible = recipes.filter((recipe) => recipe.data?.ingredient?.some((ingredient) => ingredient.present && ingredient.itemId === window.slots[0]?.itemId));
        if (!this.session.adapter?.modern) eligible.sort((a, b) => description(a) < description(b) ? -1 : description(a) > description(b) ? 1 : 0);
      }
      eligible.forEach((recipe, index) => {
        const result = recipe.data?.result, label = this.items.get(result?.itemId)?.displayName || String(recipe.recipeId).replace('minecraft:', '').replaceAll('_', ' ');
        if (!`${label} ${recipe.recipeId}`.toLowerCase().includes(this.recipeSearch.toLowerCase())) return;
        const select = button(`${result?.itemCount > 1 ? `${result.itemCount} × ` : ''}${label}`, (event) => {
          if (name === 'stonecutter') this.containerButton(index, id);
          else this.session.craftRecipe(recipe.recipeId, { windowId: id, makeAll: event.shiftKey });
          if (!this.session.adapter?.modern || recipe.source === 'book') this.session.packet('displayed_recipe', { recipeId: recipe.recipeId });
        }); select.dataset.recipe = recipe.recipeId; list.append(select);
      }); options.append(list);
      note(name === 'stonecutter' ? 'Choose a recipe, then collect the confirmed result slot.' : 'Click to place ingredients. Shift click requests all available sets. Collect the server’s confirmed result slot.');
    }
    if (focused) {
      const field = [...options.querySelectorAll('[data-field]')].find((node) => node.dataset.field === focused);
      if (field) { field.focus(); if (selection && field.type !== 'search' && selection[0] !== null) field.setSelectionRange(...selection); }
    }
  }

  renderControls() {
    const panel = this.ui['controls-panel']; panel.replaceChildren();
    const title = document.createElement('h2'); title.textContent = 'Controls'; const grid = document.createElement('div'); grid.className = 'server-controls';
    for (const [action, code] of Object.entries(this.controls)) {
      const button = document.createElement('button'); button.type = 'button'; button.dataset.control = action;
      button.textContent = `${action.replace(/([A-Z])/g, ' $1')}: ${this.captureControls === action ? 'Press a key…' : controlLabel(code)}`;
      button.addEventListener('click', () => { this.captureControls = action; this.renderControls(); }); grid.append(button);
    }
    const reset = document.createElement('button'); reset.type = 'button'; reset.textContent = 'Reset defaults'; reset.addEventListener('click', () => { this.controls = { ...DEFAULT_CONTROLS }; this.captureControls = null; try { localStorage.removeItem('pomme-server-controls'); } catch {} this.renderControls(); });
    const close = document.createElement('button'); close.type = 'button'; close.textContent = 'Done'; close.addEventListener('click', () => this.openPanel('inventory'));
    panel.append(title, grid, reset, close);
  }

  renderProgress() {
    const panel = this.ui['progress-panel']; panel.replaceChildren();
    panel.setAttribute('aria-label', this.menu === 'advancements' ? 'Advancements' : 'Statistics');
    const header = document.createElement('div'); header.className = 'server-menu-head'; const title = document.createElement('h2'); title.textContent = this.menu === 'advancements' ? 'Advancements' : 'Statistics';
    const close = document.createElement('button'); close.type = 'button'; close.textContent = 'Close'; close.setAttribute('aria-label', 'Close progress'); close.addEventListener('click', () => this.closePanel()); header.append(title, close); panel.append(header);
    const tabs = document.createElement('nav'); tabs.className = 'server-progress-tabs'; tabs.setAttribute('role', 'tablist'); panel.append(tabs);
    const content = document.createElement('div'); content.className = 'server-progress-content'; panel.append(content);
    if (this.menu === 'statistics') {
      STATISTIC_CATEGORIES.forEach((category, index) => {
        const button = document.createElement('button'); button.type = 'button'; button.textContent = category; button.setAttribute('role', 'tab'); button.setAttribute('aria-selected', String(this.statisticsCategory === index));
        button.addEventListener('click', () => { this.statisticsCategory = index; this.renderProgress(); }); tabs.append(button);
      });
      if (!this.progress.statisticsReceived) { content.textContent = 'Waiting for the server’s statistics…'; return; }
      const rows = this.progress.statisticRows(this.registry, this.statisticsCategory);
      if (!rows.length) { content.textContent = 'No statistics have been reported in this category.'; return; }
      const table = document.createElement('table'); table.className = 'server-statistics-table'; const head = document.createElement('thead'); const heading = document.createElement('tr');
      for (const text of ['Statistic', 'Value']) { const cell = document.createElement('th'); cell.textContent = text; heading.append(cell); } head.append(heading); table.append(head);
      const body = document.createElement('tbody');
      for (const row of rows) { const record = document.createElement('tr'); const name = document.createElement('td'); name.textContent = row.name; const value = document.createElement('td'); value.textContent = row.formatted; record.append(name, value); body.append(record); } table.append(body); content.append(table);
      return;
    }
    const roots = this.progress.roots();
    if (!roots.length) { content.textContent = 'No advancements have been sent by this server.'; return; }
    if (!roots.some((root) => root.id === this.progress.selectedTab)) this.progress.selectedTab = roots[0].id;
    for (const root of roots) {
      const button = document.createElement('button'); button.type = 'button'; renderTextComponent(button, this.progress.titleComponent(root.id)); button.setAttribute('role', 'tab'); button.dataset.advancementTab = root.id; button.setAttribute('aria-selected', String(root.id === this.progress.selectedTab));
      button.addEventListener('click', () => { this.progress.selectedTab = root.id; this.session.packet('advancement_tab', { action: 0, tabId: root.id }); this.renderProgress(); }); tabs.append(button);
    }
    const scroll = document.createElement('div'); scroll.className = 'server-advancement-scroll'; const tree = document.createElement('div'); tree.className = 'server-advancement-tree'; scroll.append(tree); content.append(scroll);
    const nodes = this.progress.visible(this.progress.selectedTab), coordinates = new Map();
    const xMin = Math.min(0, ...nodes.map((node) => node.displayData.xCord)), yMin = Math.min(0, ...nodes.map((node) => node.displayData.yCord));
    for (const node of nodes) coordinates.set(node.id, [(node.displayData.xCord - xMin) * 205 + 15, (node.displayData.yCord - yMin) * 140 + 15]);
    const width = Math.max(450, ...[...coordinates.values()].map(([x]) => x + 195)), height = Math.max(250, ...[...coordinates.values()].map(([, y]) => y + 135));
    tree.style.width = `${width}px`; tree.style.height = `${height}px`;
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); svg.setAttribute('width', width); svg.setAttribute('height', height); tree.append(svg);
    for (const node of nodes) {
      const [x, y] = coordinates.get(node.id), parent = coordinates.get(node.parentId);
      if (parent) { const line = document.createElementNS(svg.namespaceURI, 'path'); line.setAttribute('d', `M${parent[0] + 170},${parent[1] + 42} H${x - 10} V${y + 42} H${x}`); line.setAttribute('fill', 'none'); line.setAttribute('stroke', '#8799ac'); line.setAttribute('stroke-width', '2'); svg.append(line); }
      const card = document.createElement('article'); card.className = 'server-advancement-card'; card.dataset.advancement = node.id; const completion = this.progress.completion(node.id); card.classList.toggle('complete', completion.complete); card.style.left = `${x}px`; card.style.top = `${y}px`;
      const icon = this.itemIcons?.url(this.items.get(node.displayData.icon?.itemId));
      if (icon) { const image = document.createElement('img'); image.className = 'server-advancement-icon'; image.alt = ''; image.src = icon; card.append(image); }
      const heading = document.createElement('h3'); renderTextComponent(heading, this.progress.titleComponent(node.id)); const description = document.createElement('p'); renderTextComponent(description, this.progress.descriptionComponent(node.id)); const meter = document.createElement('progress'); meter.max = Math.max(1, completion.total); meter.value = completion.done;
      meter.setAttribute('aria-label', `${heading.textContent}: ${completion.done} / ${completion.total} requirements`); card.append(heading, description, meter); tree.append(card);
    }
  }

  renderToast() {
    const toast = this.progress.toasts[0], node = toast && this.progress.advancements.get(toast.id);
    this.ui.toast.hidden = !node; this.ui.toast.replaceChildren(); if (!node) return;
    const title = document.createElement('strong'); renderTextComponent(title, this.progress.toastComponent(node.id));
    const name = document.createElement('span'); renderTextComponent(name, this.progress.titleComponent(node.id)); this.ui.toast.append(title, name);
  }

  openBook(hand = 0) {
    const source = this.windows.get(0)?.slots[hand === 1 ? 45 : 36 + this.selectedSlot];
    const definition = this.items.get(source?.itemId);
    if (!source?.present || !['writable_book', 'written_book'].includes(definition?.name)) { this.onStatus('The server opened a book that has not arrived in your inventory yet.'); return false; }
    this.book = new BookDraft(source, { hand, hotbarSlot: this.selectedSlot, editable: definition.name === 'writable_book' });
    this.openPanel('book'); return true;
  }

  saveBook(sign = false) {
    const draft = this.book, source = this.windows.get(0)?.slots[draft?.inventorySlot === 40 ? 45 : 36 + (draft?.inventorySlot || 0)];
    if (!draft?.matches(source) || draft.inventorySlot !== 40 && this.selectedSlot !== draft.inventorySlot) { this.onStatus('The held book changed on the server. Close it and reopen the confirmed book.'); return false; }
    const packet = draft.packet(sign);
    if (packet && !this.session.packet('edit_book', packet)) return false;
    if (sign && !packet) return false;
    this.closePanel(); return true;
  }

  renderBook() {
    const panel = this.ui['book-panel'], book = this.book; panel.replaceChildren(); if (!book) return;
    const title = document.createElement('h2'); renderTextComponent(title, book.signing ? { translate: 'book.editTitle', fallback: 'Sign book' } : book.title ? { text: String(book.title) } : { translate: book.editable ? 'item.minecraft.writable_book' : 'item.minecraft.written_book', fallback: book.editable ? 'Book and quill' : 'Written book' }); panel.append(title);
    const page = document.createElement('p'); renderTextComponent(page, book.signing ? { translate: 'book.finalizeWarning', fallback: 'Signing makes this book permanent.' } : { text: '', extra: [book.pageIndicator(), ...(book.author ? [{ text: ' · ' }, book.byAuthor()] : [])] }); panel.append(page);
    const actions = document.createElement('div'); actions.className = 'server-book-actions';
    const button = (label, click, disabled = false) => { const node = document.createElement('button'); node.type = 'button'; renderTextComponent(node, typeof label === 'string' ? { text: label } : label); node.disabled = disabled; node.addEventListener('click', click); return node; };
    if (book.signing) {
      const input = document.createElement('input'); input.maxLength = 15; input.value = book.title; input.setAttribute('aria-label', 'Book title');
      const finalize = button({ translate: 'book.finalizeButton', fallback: 'Sign and close' }, () => this.saveBook(true), !book.title.trim()); input.addEventListener('input', () => { book.title = input.value; finalize.disabled = !input.value.trim(); }); panel.append(input);
      actions.append(button({ translate: 'gui.cancel', fallback: 'Cancel signing' }, () => { book.signing = false; this.renderBook(); }), finalize); panel.append(actions); input.focus(); return;
    }
    const content = document.createElement(book.editable ? 'textarea' : 'div'); content.className = 'server-book-page';
    if (book.editable) { content.maxLength = 1023; content.value = book.text(); content.setAttribute('aria-label', `Book page ${book.page + 1}`); content.addEventListener('input', () => book.setPage(content.value)); }
    else book.render(content); panel.append(content);
    actions.append(button('Previous page', () => { book.previous(); this.renderBook(); }, book.page === 0), button('Next page', () => { book.next(); this.renderBook(); }, book.page >= book.pages.length - 1 && (!book.editable || book.pages.length >= 100)));
    if (book.editable) actions.append(button({ translate: 'book.signButton', fallback: 'Sign' }, () => { book.signing = true; this.renderBook(); }), button({ translate: 'gui.done', fallback: 'Done' }, () => this.saveBook()));
    else actions.append(button({ translate: 'gui.done', fallback: 'Done' }, () => this.closePanel())); panel.append(actions);
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
    if (name !== 'inventory') this.clearBundleHover();
    if (this.menu === 'advancements' && name !== 'advancements') this.session.packet('advancement_tab', { action: 1 });
    if (this.menu === 'inventory' && name !== 'inventory' && name !== 'controls') this.session.closeWindow();
    this.mouseUp(); this.menu = name;
    this.root.dataset.panel = name;
    this.ui.inventory.hidden = name !== 'inventory'; this.ui['chat-entry'].hidden = name !== 'chat';
    this.ui['controls-panel'].hidden = name !== 'controls'; this.captureControls = null;
    this.ui['progress-panel'].hidden = !['advancements', 'statistics'].includes(name);
    this.ui['book-panel'].hidden = name !== 'book';
    if (document.pointerLockElement) document.exitPointerLock();
    if (name === 'inventory') { if (!(this.currentState.windowId || 0)) this.ui['inventory-title'].textContent = 'Inventory'; this.renderInventory(); this.ui['inventory-close'].focus(); }
    else if (name === 'controls') this.renderControls();
    else if (name === 'book') this.renderBook();
    else if (name === 'advancements' || name === 'statistics') {
      if (name === 'statistics') this.session.packet('client_command', { actionId: 'request_stats' });
      this.renderProgress();
      if (name === 'advancements' && this.progress.selectedTab) this.session.packet('advancement_tab', { action: 0, tabId: this.progress.selectedTab });
      this.ui['progress-panel'].querySelector('button')?.focus();
    }
    else this.ui['chat-entry'].querySelector('input').focus();
  }

  closePanel(resume = true, notifyServer = true) {
    this.clearBundleHover();
    this.inventoryDrag = null;
    this.inventoryLastClick = null;
    const wasInventory = this.menu === 'inventory' || this.menu === 'controls';
    if (this.menu === 'advancements' && notifyServer) this.session.packet('advancement_tab', { action: 1 });
    this.menu = null; this.ui.inventory.hidden = true; this.ui['chat-entry'].hidden = true; this.hoverSlot = null;
    delete this.root.dataset.panel;
    this.ui['controls-panel'].hidden = true; this.captureControls = null;
    this.ui['progress-panel'].hidden = true;
    this.ui['book-panel'].hidden = true; this.book = null;
    if (wasInventory && notifyServer) this.session.closeWindow();
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
    } else { this.digging = { ...target, elapsed: 0, duration, nextSound: 0 }; this.ui.dig.hidden = false; }
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
    if (button === 2) {
      this.placing = true; this.placeCooldown = 0.2; this.session.place(hit);
      const item = this.items.get(this.currentItem().itemId), block = this.blocks.get(hitInfo(hit)?.stateId);
      const opensContainer = /chest|barrel|furnace|smoker|crafting_table|enchanting_table|anvil|grindstone|stonecutter|cartography_table|brewing_stand|loom|lectern|beacon|crafter|shulker_box|hopper|dispenser|dropper/.test(block?.name || '');
      if (item?.name === 'writable_book' && (!opensContainer || this.currentState.sneaking)) this.openBook(0);
      return true;
    }
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
    this.hud.tick(dt);
    this.ui.titles.style.opacity = this.hud.titleOpacity;
    this.hudRefresh += dt;
    const firstToast = this.progress.toasts[0]; this.progress.tick(dt); if (firstToast !== this.progress.toasts[0]) this.renderToast();
    for (const effect of this.currentState.effects || []) if (effect.duration > 0) effect.duration = Math.max(0, effect.duration - dt * 20);
    if (this.hudRevision !== this.hud.revision) this.renderHud();
    else if (this.hudRefresh >= 0.2) this.renderEffects();
    if (this.hudRefresh >= 0.2) this.hudRefresh %= 0.2;
    if (!this.active || this.currentState.status !== 'playing' || this.blocking) { if (this.holding || this.placing) this.mouseUp(); return; }
    this.digCooldown = Math.max(0, this.digCooldown - dt);
    if (this.holding) {
      const target = this.target();
      if (this.digging && !sameTarget(target, this.digging)) { this.session.cancelDig(); this.digging = null; this.ui.dig.hidden = true; }
      if (!this.digging && this.digCooldown <= 0) this.startDig(target);
      if (this.digging) {
        this.digging.elapsed += dt;
        if (this.digging.elapsed >= this.digging.nextSound) {
          const { x, y, z, stateId } = this.digging; this.onBlockSound({ kind: 'hit', x, y, z, stateId });
          this.digging.nextSound = (Math.floor(this.digging.elapsed / 0.2) + 1) * 0.2;
        }
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
    if (this.menu === 'book' && this.book?.signing && event.code === 'Enter' && down) { this.saveBook(true); event.preventDefault(); return true; }
    if (this.captureControls) {
      if (down && !event.repeat) {
        if (event.code !== 'Escape') { this.controls[this.captureControls] = event.code; try { localStorage.setItem('pomme-server-controls', JSON.stringify(this.controls)); } catch {} }
        this.captureControls = null; this.renderControls();
      }
      event.preventDefault(); return true;
    }
    if (event.code === this.controls.playerList && (!this.blocking || !down)) { this.ui.playerlist.hidden = !down; event.preventDefault(); return true; }
    if (event.code === 'Escape' && this.menu) { if (down) this.closePanel(); event.preventDefault(); return true; }
    if (['INPUT', 'TEXTAREA', 'SELECT'].includes(event.target?.tagName)) return true;
    if (!this.ui.death.hidden) return true;
    if (this.controlCode(event.code) === 'ShiftLeft') { if (!event.repeat) this.session.sneak(down); return this.blocking; }
    if (this.controlCode(event.code) === 'ControlLeft') { if (!event.repeat) this.session.sprint(down); return this.blocking; }
    if (!down) return Boolean([this.controls.inventory, this.controls.chat, this.controls.command, this.controls.drop, this.controls.offhand, this.controls.advancements].includes(event.code) || /^Digit[1-9]$/.test(event.code));
    if (event.repeat) return this.blocking;
    if (/^Digit[1-9]$/.test(event.code)) {
      const slot = Number(event.code.slice(-1)) - 1;
      if (this.menu === 'inventory' && this.hoverSlot !== null) this.session.clickWindow(this.hoverSlot, { mode: 2, button: slot });
      else this.session.selectHotbar(slot);
      event.preventDefault(); return true;
    }
    if (event.code === this.controls.inventory) { this.menu === 'inventory' || this.menu === 'controls' ? this.closePanel() : this.openPanel('inventory'); event.preventDefault(); return true; }
    if (event.code === this.controls.chat || event.code === this.controls.command) { this.openPanel('chat'); if (event.code === this.controls.command) this.ui['chat-entry'].querySelector('input').value = '/'; event.preventDefault(); return true; }
    if (event.code === this.controls.advancements) { this.menu === 'advancements' ? this.closePanel() : this.openPanel('advancements'); event.preventDefault(); return true; }
    if (this.menu === 'inventory' && this.hoverSlot !== null) {
      if (event.code === this.controls.drop) { this.session.clickWindow(this.hoverSlot, { mode: 4, button: event.ctrlKey ? 1 : 0 }); event.preventDefault(); return true; }
      if (event.code === this.controls.offhand) { this.session.clickWindow(this.hoverSlot, { mode: 2, button: 40 }); event.preventDefault(); return true; }
    }
    if (this.blocking) return true;
    if (this.controlCode(event.code) === 'Space' && this.currentState.canFly && !event.repeat) {
      const now = performance.now();
      if (now - this.lastJumpPress < 280) { this.session.setFlying(!this.currentState.flying); this.lastJumpPress = -Infinity; }
      else this.lastJumpPress = now;
      return false;
    }
    if (event.code === this.controls.drop) { this.session.dropItem(event.ctrlKey); event.preventDefault(); return true; }
    if (event.code === this.controls.offhand) { this.session.swapHands(); event.preventDefault(); return true; }
    return false;
  }

  close() { this.mouseUp(); this.closePanel(false); window.removeEventListener('blur', this.onWindowBlur); document.removeEventListener('pointerup', this.onInventoryPointerUp); this.root.removeEventListener('wheel', this.onBundleWheel); this.root.remove(); this.style.remove(); if (this.originalHotbar) this.originalHotbar.hidden = false; }
}
