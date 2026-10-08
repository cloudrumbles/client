import { createRenderer } from './renderer.js';
import { recordGpuBenchmarkSample } from './gpu-profile.js';
import { loadCore } from './wasm.js';
import { Player } from './player.js';
import { ResolutionController, summarizeFrames, summarizeGpuTimes } from './performance.js';
import { BrowserWorld } from './world.js';
import { loadMinecraftRegistry } from './registry.js';
import { loadResourcePack } from './assets.js';
import { importAnvil, importLevelDat, validateImportBounds } from './anvil.js';
import { MinecraftSession, simplifyNbt } from './minecraft.js';
import { MinecraftAudio } from './audio.js';
import { MinecraftEffects } from './effects.js';
import { BlockEntityScene } from './block-entities.js';
import { SingleplayerClient } from './singleplayer.js';
import { SignEditor } from './sign-editor.js';
import { vehicleStateFromEntity } from './vehicle.js';
import { ServerResourcePacks } from './server-packs.js';
import { FirstPersonScene } from './first-person.js';
import { MinecraftMaps } from './maps.js';
import { hashBiomeSeed } from './biome-tints.js';
import { setLanguage } from './text.js';
import { fluidState } from './movement.js';
import { BROWSER_PROTOCOL_VERSIONS } from './protocol-compat.js';
import { EntityScene } from './entities.js';
import { ServerGameplay } from './gameplay.js';
import { storeResourcePack, restoreResourcePack } from './pack-store.js';
import { AuthorityWorldBridge } from '../authority/bridge.js';
import { BreakingOverlay } from './breaking-overlay.js';
import { readSourceLevelInventory, unavailableSourceLevelInventory, storeSourceLevelInventory, restoreSourceLevelInventory } from './source-level-inventory.js';

const $ = id => document.getElementById(id);
const seed = 1650;
let saveKey = 'pomme-web-world-v1';
const keys = new Set();
const edits = new Map();
let renderer, core, player, world, registry, pack, session, entities, gameplay, audio, effects, blockEntities, signEditor, serverPacks, firstPerson, maps, ready = false, locked = false;
let mode = 'demo', operations = Promise.resolve(), serverDimension = null, serverStatus = null, loadingWorld = false;
let selected = 1, scale = 0.85, phase = 0.22, revision = 0;
let controller = new ResolutionController(scale);
let lastTime = 0, accumulator = 0, hudAt = 0, frames = [], benchmark = null, lastResult = null;
let saveTimer;
let worldAge = 0n, worldAgeAt = 0;
const gameTime = () => worldAge + BigInt(Math.max(0, Math.floor((performance.now() - worldAgeAt) / 50)));
let saveDirty = false;
let localWorldClient = null, localWorldActive = false, userPackFile = null, packIsServer = false, connectionEpoch = 0;
let resourcePackSaving = Promise.resolve();
let serverMapKey = '';
let importedAuthority = null, authorityEpoch = 0, authorityClosing = Promise.resolve(), authoritySaveTimer;
let localInventory = null, inventoryEpoch = 0, inventoryClosing = Promise.resolve();
let sourceInventorySaving = Promise.resolve();
let breaking = null, localBreakingId = null, breakingClock = 0;
let worldResetting = Promise.resolve();
let authoritySaving = null, authorityIngestDepth = 0, authorityColumnsRunning = false;
const authorityColumns = new Map();

function closeImportedInventory() {
  inventoryEpoch++;
  const previous = localInventory; localInventory = null;
  if (previous && gameplay === previous.gameplay) gameplay = null;
  const closing = previous ? previous.close() : Promise.resolve();
  inventoryClosing = Promise.all([inventoryClosing.catch(authorityWarning), closing]).then(() => {});
  return inventoryClosing;
}
async function saveImportedInventory() {
  const inventory = localInventory;
  if (!inventory || inventory.closed) return;
  try { await inventory.save(); }
  catch (error) { if (localInventory === inventory && !inventory.closed) throw error; }
}
async function openImportedInventory(guard = () => true, sourceInventory) {
  await inventoryClosing;
  if (!guard() || mode !== 'import' || session) return null;
  const epoch = connectionEpoch, generation = world.generation, token = ++inventoryEpoch;
  const current = () => guard() && connectionEpoch === epoch && world.generation === generation && inventoryEpoch === token && mode === 'import' && !session;
  await sourceInventorySaving.catch(error => { if (current()) status(`Source inventory cache unavailable: ${error.message}`); });
  if (!current()) return null;
  if (sourceInventory == null) {
    try { sourceInventory = await restoreSourceLevelInventory(world.worldKey, { isCurrent: current }); }
    catch (error) { if (current()) status(`Source inventory unavailable: ${error.message}`); return null; }
  }
  if (!current()) return null;
  const file = userPackFile || await restoreResourcePack();
  if (!current() || !file) return null;
  let inventory;
  try {
    const { LocalInventory } = await import('./local-inventory.js');
    if (!current()) return null;
    inventory = await LocalInventory.open({ registry, jar: file, worldKey: world.worldKey, player, world, assets: pack, sourceInventory,
      isCurrent: current, onStatus: message => { if (current()) status(message); },
      onSelectedBlock: id => { if (current()) select(id); } });
    if (!current()) { await inventory?.close({ save: false }); return null; }
    localInventory = inventory;
    if (inventory) {
      gameplay = inventory.gameplay;
      player.onFlyingChange = value => { if (current()) inventory.session.setFlying(value); };
    }
    return inventory;
  } catch (error) {
    await inventory?.close({ save: false }).catch(() => {});
    if (current()) status(`Local inventory unavailable: ${error.message}`);
    return null;
  }
}

function clearBreaking() {
  breaking?.destroy(); breaking = null; localBreakingId = null; breakingClock = 0;
}
function updateBreaking(dt) {
  if (!breaking) return;
  breakingClock += dt * 20;
  const tick = Math.floor(breakingClock), id = session?.state.entityId;
  const digging = mode === 'server' && locked && !benchmark && !gameplay?.blocking && !signEditor?.blocking ? gameplay?.digging : null;
  if (localBreakingId !== null && (!digging || id !== localBreakingId)) { breaking.progress(localBreakingId, null, -1, tick); localBreakingId = null; }
  if (digging && Number.isInteger(id)) {
    localBreakingId = id;
    breaking.localProgress(id, [digging.x, digging.y, digging.z], digging.elapsed / digging.duration, tick);
  }
  breaking.update({ eye: player.eye, tick });
}

function retireAuthorityOverlays(blocks) {
  for (const block of blocks) edits.delete(block.slice(0, 3).join(','));
  saveDirty = true; flushSave();
}
function authorityCurrent(bridge) {
  return importedAuthority === bridge && bridge.current() && mode === 'import' && !session;
}
function authorityWarning(error) {
  if (error?.code === 'AUTHORITY_STALE_WORLD' || error?.name === 'AbortError') return;
  status(`Imported block authority: ${error.message}`); console.error(error);
}
async function persistAuthority(bridge = importedAuthority) {
  if (!bridge || !authorityCurrent(bridge)) return;
  if (authoritySaving?.bridge === bridge) { await authoritySaving.promise; if (!authorityCurrent(bridge)) return; }
  const epoch = connectionEpoch, generation = world.generation;
  const pending = [...world.overlays.values()].flatMap(changes => [...changes.entries()])
    .filter(([, block]) => bridge.covers(block[0], block[1], block[2]));
  const promise = bridge.save();
  const saving = { bridge, promise }; authoritySaving = saving;
  try {
    await promise;
    if (!authorityCurrent(bridge) || epoch !== connectionEpoch || generation !== world.generation) return;
    const retired = [];
    for (const [key, block] of pending) {
      const columnKey = `${Math.floor(block[0] / 16)},${Math.floor(block[2] / 16)}`, changes = world.overlays.get(columnKey);
      // A newer tick may have changed this position while IndexedDB was saving.
      if (changes?.get(key) !== block) continue;
      changes.delete(key); if (!changes.size) world.overlays.delete(columnKey);
      retired.push(block);
    }
    if (retired.length) retireAuthorityOverlays(retired);
  } catch (error) {
    if (authorityCurrent(bridge)) throw error;
  } finally { if (authoritySaving === saving) authoritySaving = null; }
}
function scheduleAuthoritySave() {
  clearTimeout(authoritySaveTimer);
  const bridge = importedAuthority;
  if (bridge) authoritySaveTimer = setTimeout(() => { void persistAuthority(bridge).catch(authorityWarning); }, 300);
}
function closeImportedAuthority({ save = true } = {}) {
  const inventoryClosed = closeImportedInventory();
  authorityEpoch++; clearTimeout(authoritySaveTimer); authorityColumns.clear();
  const previous = importedAuthority; importedAuthority = null;
  // close() gates callbacks immediately, before its asynchronous save finishes.
  const closing = previous ? previous.close({ save }) : Promise.resolve();
  authorityClosing = Promise.all([authorityClosing.catch(authorityWarning), closing, inventoryClosed]).then(() => {});
  return authorityClosing;
}
async function updateAuthorityRunning() {
  const bridge = importedAuthority;
  if (!bridge || !authorityCurrent(bridge)) return;
  try {
    if (!document.hidden && ready && !loadingWorld && !benchmark) await bridge.authority.start();
    else { await bridge.authority.pause(); if (authorityCurrent(bridge)) await persistAuthority(bridge); }
  } catch (error) { if (authorityCurrent(bridge)) throw error; }
}
function queueAuthorityColumn(column) {
  const bridge = importedAuthority;
  if (!bridge || !authorityCurrent(bridge) || loadingWorld || authorityIngestDepth || !world.contains(column.x, column.z)) return;
  // Only the active near window is retained while one worker request runs.
  const key = `${column.x},${column.z}`;
  if (authorityColumns.size >= 256 && !authorityColumns.has(key)) return;
  authorityColumns.set(key, column);
  if (authorityColumnsRunning) return;
  authorityColumnsRunning = true;
  void (async () => {
    try {
      while (authorityColumns.size && authorityCurrent(bridge)) {
        const [nextKey] = authorityColumns.keys(), current = world.columns.get(nextKey);
        authorityColumns.delete(nextKey);
        if (!current || !world.contains(current.x, current.z)) continue;
        await bridge.loadColumn(current);
        if (authorityCurrent(bridge)) scheduleAuthoritySave();
      }
    } catch (error) { if (authorityCurrent(bridge)) authorityWarning(error); }
    finally {
      authorityColumnsRunning = false;
      const next = authorityColumns.values().next().value;
      if (next) queueAuthorityColumn(next);
    }
  })();
}
async function openImportedAuthority(guard = () => true) {
  if (mode !== 'import' || !guard()) return null;
  await authorityClosing;
  if (!guard()) return null;
  const epoch = connectionEpoch, generation = world.generation, token = ++authorityEpoch, targetWorld = world;
  const current = () => guard() && connectionEpoch === epoch && world === targetWorld && targetWorld.generation === generation && authorityEpoch === token && mode === 'import' && !session;
  const mirror = {
    get columns() { return targetWorld.columns; }, get overlays() { return targetWorld.overlays; },
    setBlock: (...args) => targetWorld.setBlock(...args), dirtyLighting: (...args) => targetWorld.dirtyLighting(...args),
    ingestColumn: column => {
      authorityIngestDepth++;
      try { targetWorld.ingestColumn(column); } finally { authorityIngestDepth--; }
    },
  };
  let bridge;
  try {
    bridge = await AuthorityWorldBridge.open({ world: mirror, registry, worldKey: world.worldKey,
      minY: core.world_min_y(), height: core.world_height(), center: player.position, autoTick: false, isCurrent: current,
      onRetireOverlays: blocks => { if (current()) retireAuthorityOverlays(blocks); },
      onEvents: () => { if (current()) scheduleAuthoritySave(); },
      onError: error => { if (current()) authorityWarning(error); },
    });
    if (!current()) { await bridge.close({ save: false }); return null; }
    importedAuthority = bridge;
    if (!bridge.authority.initial.restored) {
      await bridge.authority.setTime(BigInt(Math.floor(phase * 24000)), $('cycle').checked);
      if (!current()) return null;
      await persistAuthority(bridge);
    } else phase = Number((bridge.state.daytime % 24000n + 24000n) % 24000n) / 24000;
    if (!current()) return null;
    worldAge = bridge.state.age; worldAgeAt = performance.now();
    return bridge;
  } catch (error) {
    if (bridge) await bridge.close({ save: false });
    if (importedAuthority === bridge) importedAuthority = null;
    if (current()) authorityWarning(error);
    return null;
  }
}

function fail(error) {
  const message = error instanceof Error ? error.message : String(error);
  ready = false;
  if (benchmark) finishBenchmark(true);
  // GPU failure can make mesh-removal APIs throw during teardown. Finish the
  // independent cleanup steps and preserve the original error for the user.
  for (const cleanup of [() => detachServer(), () => effects?.destroy(), () => audio?.destroy(), () => world?.destroy(), () => renderer?.destroy()]) {
    try { cleanup(); } catch {}
  }
  for (const id of ['play', 'resume', 'benchmark']) $(id).disabled = true;
  $('error').hidden = false; $('error').textContent = message;
  $('world-status').textContent = 'Stopped';
  if (document.pointerLockElement) document.exitPointerLock();
  console.error(error);
  document.documentElement.dataset.engine = 'error';
}
function persistedEdits() {
  try {
    const stored = JSON.parse(localStorage.getItem(saveKey) ?? '[]');
    if (!Array.isArray(stored)) return [];
    return stored.filter(b => Array.isArray(b) && b.length === 4 && b.every(Number.isInteger) && b[3] >= 0 && b[3] <= (mode === 'demo' ? 8 : 65535) && (mode !== 'demo' || (b[0] >= 0 && b[0] < 128 && b[1] >= 0 && b[1] < 64 && b[2] >= 0 && b[2] < 128)));
  } catch { return []; }
}
function flushSave() {
  clearTimeout(saveTimer);
  if (!saveDirty) return;
  try { localStorage.setItem(saveKey, JSON.stringify([...edits.values()])); saveDirty = false; }
  catch { $('world-status').textContent = 'Save storage is full; this session remains playable'; }
}
function saveImportedLocation() {
  if (mode !== 'import' || !ready || loadingWorld || benchmark) return;
  try {
    const previous = JSON.parse(localStorage.getItem('pomme-last-import') || 'null');
    if (previous?.worldKey === world.worldKey) localStorage.setItem('pomme-last-import', JSON.stringify({ ...previous, spawn: player.position, phase }));
  } catch {}
}
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flushSave, 300);
}
function edit(x, y, z, id) {
  const bridge = importedAuthority;
  if (mode === 'import' && bridge?.covers(x, y, z)) {
    const previous = core.block_get(x, y, z);
    return (async () => {
      try {
        const result = await bridge.setBlock(x, y, z, id);
        if (!authorityCurrent(bridge) || !result.handled) return false;
        audio?.blockAction({ kind: id === 0 ? 'break' : 'place', x, y, z, stateId: id === 0 ? previous : id });
        await persistAuthority(bridge);
        return authorityCurrent(bridge);
      } catch (error) { if (authorityCurrent(bridge)) throw error; return false; }
    })();
  }
  const previous = core.block_get(x, y, z);
  if (mode === 'server' || !world.setBlock(x, y, z, id)) return false;
  audio?.blockAction({ kind: id === 0 ? 'break' : 'place', x, y, z, stateId: id === 0 ? previous : id });
  const block = [x, y, z, id];
  edits.set(`${x},${y},${z}`, block);
  saveDirty = true;
  // Invalidate shadows when the worker uploads the corresponding geometry.
  save();
  return true;
}
async function useImportedBlock(x, y, z) {
  const epoch = connectionEpoch, generation = world.generation;
  const inventory = localInventory;
  if (mode === 'import' && inventory) {
    try {
      const handled = await inventory.useBlock(x, y, z);
      if (epoch !== connectionEpoch || generation !== world.generation || localInventory !== inventory || inventory.closed) return false;
      if (handled) return true;
    } catch (error) { if (localInventory === inventory && !inventory.closed) throw error; return false; }
  }
  const bridge = importedAuthority;
  if (mode !== 'import' || !bridge || !bridge.covers(x, y, z)) return false;
  try {
    const handled = await bridge.useBlock(x, y, z);
    if (!authorityCurrent(bridge) || !handled) return false;
    await persistAuthority(bridge);
    return authorityCurrent(bridge);
  } catch (error) { if (authorityCurrent(bridge)) throw error; return false; }
}
async function placeImported(hit, id) {
  if (!hit) return false;
  id ??= localInventory ? localInventory.heldBlock() : selected;
  const epoch = connectionEpoch, generation = world.generation;
  if (!keys.has('ShiftLeft') && !keys.has('ShiftRight') && await useImportedBlock(...hit.slice(0, 3))) return true;
  if (epoch !== connectionEpoch || generation !== world.generation || mode === 'server') return false;
  if (!Number.isInteger(id) || id <= 0) return false;
  const [x, y, z] = hit.slice(3, 6);
  return player.intersectsBlock(x, y, z) ? false : edit(x, y, z, id);
}
function select(id) {
  selected = id;
  document.querySelectorAll('[data-block]').forEach(button => {
    const active = Number(button.dataset.block) === id;
    button.classList.toggle('selected', active); button.setAttribute('aria-pressed', String(active));
  });
}
function status(message) { $('world-status').textContent = message; }
function enqueue(action, { propagate = false } = {}) {
  const pending = operations.then(action);
  operations = pending.catch(error => { loadingWorld = false; status(error.message); console.error(error); });
  return propagate ? pending : operations;
}
function switchSaveKey(next) { flushSave(); edits.clear(); saveDirty = false; saveKey = next; }
function nativeHotbar() {
  const names = ['grass_block', 'stone', 'oak_planks', 'sand', 'oak_leaves', 'glowstone'];
  document.querySelectorAll('[data-block]').forEach((button, index) => {
    button.dataset.block = registry.blocks.find(block => block.name === names[index])?.defaultState ?? 0;
  });
  select(Number(document.querySelector('[data-block]').dataset.block));
}
function sceneBiome(x, y, z) {
  const column = world.columns.get(`${Math.floor(x / 16)},${Math.floor(z / 16)}`);
  const section = column?.sections.find(entry => entry.sectionY === Math.floor(y / 16));
  const index = ((Math.floor(y / 4) % 4 + 4) % 4) * 16 + ((Math.floor(z / 4) % 4 + 4) % 4) * 4 + ((Math.floor(x / 4) % 4 + 4) % 4);
  const id = section?.biomes?.[index];
  return registry?.biomes.find(biome => biome.id === id) ?? null;
}
function sceneLight(x, y, z) {
  const column = world.columns.get(`${Math.floor(x / 16)},${Math.floor(z / 16)}`), sy = Math.floor(y / 16);
  const section = column?.sections.find(entry => entry.sectionY === sy);
  const index = ((y % 16 + 16) % 16) * 256 + ((z % 16 + 16) % 16) * 16 + ((x % 16 + 16) % 16);
  const value = bytes => bytes ? bytes[index >> 1] >> ((index & 1) * 4) & 15 : null;
  return { sky: value(column?.light?.sky?.get(sy) ?? section?.skyLight) ?? (world.hasSkylight ? 15 : 0), block: value(column?.light?.block?.get(sy) ?? section?.blockLight) ?? 0 };
}
function configureMaps({ resetAtlas = false } = {}) {
  const mapKey = mode === 'server' ? serverMapKey : world.worldKey || mode;
  if (registry && (!maps || maps.worldKey !== mapKey || maps.registry !== registry)) {
    void maps?.close();
    const nextMaps = new MinecraftMaps({ renderer, registry, worldKey: mapKey, onStatus: message => { if (maps === nextMaps) status(message); },
      onChange: () => {
        if (maps !== nextMaps) return;
        if (entities) entities.dirty = true;
        if (firstPerson) firstPerson.dirty = true;
      } });
    maps = nextMaps;
    void maps.ready();
  }
  if (resetAtlas || maps?.atlas !== pack?.atlas) maps?.setAssets(pack?.atlas);
}
function refreshScenes() {
  clearBreaking();
  blockEntities?.clear(); effects?.destroy();
  setLanguage(pack?.languages ?? null);
  const materials = world.materialRegistry?.materials ?? pack?.materials;
  if (materials && pack?.atlas && renderer.uploadBreakingMesh && renderer.removeBreakingMesh) breaking = new BreakingOverlay({
    world, renderer, materials, atlas: pack.atlas, version: registry?.version.minecraftVersion ?? '1.20.4',
  });
  const playerType = registry?.entities.find(definition => definition.name === 'player')?.id;
  configureMaps();
  player.setMaterials(mode === 'demo' ? null : materials);
  blockEntities = registry ? new BlockEntityScene({ renderer, registry, materials, atlas: pack?.atlas,
    maxY: world.bounds().max[1], getGameTime: gameTime,
    getPartialTick: () => Math.max(0, (performance.now() - worldAgeAt) % 50) / 50,
    getTint: (x, y, z, kind) => world.tintAt(x, y, z, kind), getLight: sceneLight,
    getNearbyPlayers: () => [player.position, ...[...(session?.entities.values() ?? [])].filter(entity => entity.entityType === playerType).map(entity => [entity.x, entity.y, entity.z])],
    getState: (x, y, z) => core.block_get(x, y, z), setVisualOverride: (...args) => world.setVisualOverride(...args) }) : null;
  player.setCollisionProvider((bounds, options) => blockEntities?.collisionBoxes(bounds, options ?? {}) ?? [],
    (bounds, options) => blockEntities?.collisionEntries(bounds, options ?? {}) ?? []);
  effects = new MinecraftEffects({ renderer, registry, materials, atlas: pack?.atlas,
    collides: (min, max) => Boolean(core.collides_aabb(...min, ...max)),
    isAir: (x, y, z) => {
      const id = core.block_get(x, y, z);
      const name = materials?.get(id)?.name ?? registry?.blocks.find(block => id >= block.minStateId && id <= block.maxStateId)?.name;
      return /^(?:minecraft:)?(?:air|cave_air|void_air)$/.test(name ?? '');
    },
    getHeight: (x, z) => core.terrain_height(x, z), getBiome: sceneBiome, getLight: sceneLight });
  if (!audio) audio = new MinecraftAudio({ registry, getEntityPosition: id => id === session?.state.entityId ? player.position : (() => { const e = session?.entities.get(id); return e ? [e.x, e.y, e.z] : null; })() });
  audio.registry = registry;
  audio.applyPack(pack?.audioFiles ?? new Map(), { replaceAll: true });
  firstPerson?.clear();
  firstPerson = registry ? new FirstPersonScene({ renderer, registry, materials, atlas: pack?.atlas, maps }) : null;
  const profile = session?.players.get(session.state.uuid); if (profile) firstPerson?.setProfile(profile);
  if (entities) entities.maps = maps;
  gameplay?.setAssets?.({ atlas: pack?.atlas, materials: pack?.materials, maps });
  signEditor?.setAssets(pack?.atlas);
  for (const column of world.columns.values()) blockEntities?.loadColumn(column);
}
async function resetWorld(options, guard = () => true) {
  clearBreaking();
  const closing = closeImportedAuthority();
  // World.reset closes several stores asynchronously. Serialize resets so an
  // older import cannot finish rebuilding the core after a newer connection.
  const pending = worldResetting.catch(() => {}).then(async () => {
    await closing;
    if (!guard()) return;
    blockEntities?.clear(); effects?.clear();
    clearPlayerState();
    await world.reset({ atlas: pack?.atlas, colormaps: pack?.atlas?.colormaps, biomeDefinitions: pack?.atlas?.biomeDefinitions, biomeSeed: session?.state.biomeSeed ?? 0n, ...options });
    if (guard()) refreshScenes();
  });
  worldResetting = pending;
  await pending;
}
function updateRidingState({ teleport = false } = {}) {
  const slots = session?.windows.get(0)?.slots ?? [];
  const heldItems = [slots[36 + (session?.state.selectedSlot ?? 0)], slots[45]].filter(slot => slot?.present).map(slot => registry.items.find(item => item.id === slot.itemId)?.name).filter(Boolean);
  const state = vehicleStateFromEntity(session?.entities.get(session.state.vehicleId), registry, session?.state.entityId, { heldItems, worldAge: gameTime() });
  player.setVehicle(state ? { ...state, teleport } : null);
}
function applyPlayerState(state) {
  player.setEffects(state.effects);
  const sleepingPosition = state.sleepingPosition;
  player.setSleeping(state.status === 'playing' && (state.pose === 2 || state.pose === 'sleeping' || Boolean(sleepingPosition)), { position: sleepingPosition ? [sleepingPosition.x, sleepingPosition.y, sleepingPosition.z] : null });
  if (state.gliding !== undefined) player.setFallFlying(state.gliding);
  player.inputMultiplier = state.usingItem ? 0.2 : 1;
  const inventory = session.windows.get(0)?.slots ?? [];
  const armor = new Map((state.equipment ?? []).map(entry => [entry.slot, entry.item]));
  const boots = armor.get(2) ?? inventory[8], chest = armor.get(4) ?? inventory[6];
  const enchantments = simplifyNbt(boots?.nbtData)?.Enchantments ?? [];
  const level = id => Number(enchantments.find(entry => entry.id === `minecraft:${id}` || entry.id === id)?.lvl) || 0;
  const bootsName = registry.items.find(item => item.id === boots?.itemId)?.name;
  const chestName = registry.items.find(item => item.id === chest?.itemId)?.name;
  player.setEquipment({ leatherBoots: boots?.present && bootsName === 'leather_boots', depthStrider: level('depth_strider'), soulSpeed: level('soul_speed'), elytra: chest?.present && chestName === 'elytra' && (simplifyNbt(chest.nbtData)?.Damage ?? 0) < 431 });
  updateRidingState();
  const profile = session.players.get(state.uuid); if (profile && firstPerson?.profile?.uuid !== profile.uuid) firstPerson?.setProfile(profile);
  audio?.setMusicMode(state.status === 'playing' ? state.dimension?.includes('nether') ? 'nether' : state.dimension?.includes('the_end') ? 'end' : state.gameMode === 1 ? 'creative' : 'game' : 'menu');
}
function packStatus(next, warning = '') {
  $('pack-status').textContent = next ? `${next.materials.size.toLocaleString()} block states · ${next.atlas.tiles.length} textures${next.diagnostics.unsupportedStates ? ` · ${next.diagnostics.unsupportedStates} placeholder states` : ''}${warning}` : 'Import your client JAR or a resource pack for Minecraft textures.';
}
async function selectRegistryVersion(version, { guard = () => true, reloadPack = true } = {}) {
  if (!BROWSER_PROTOCOL_VERSIONS.includes(version)) throw new Error(`Supported Java versions: ${BROWSER_PROTOCOL_VERSIONS.join(', ')}.`);
  if (registry?.version.minecraftVersion === version) return true;
  const nextRegistry = await loadMinecraftRegistry({ url: `/data/${version}-registry.json` });
  if (!guard()) return false;
  let nextPack = null;
  if (reloadPack && pack) {
    const file = userPackFile || await restoreResourcePack();
    if (!guard()) return false;
    if (file) nextPack = await loadResourcePack(file, { registry: nextRegistry });
    if (!guard()) return false;
  }
  renderer.setTextureAtlas(nextPack?.atlas ?? { pixels: new Uint8Array([255, 255, 255, 255]), width: 1, height: 1 });
  registry = nextRegistry; pack = nextPack;
  setLanguage(nextPack?.languages ?? null); packStatus(nextPack);
  return true;
}
async function loadPack(file, { version } = {}) {
  const epoch = connectionEpoch;
  let nextRegistry = registry;
  if (version && version !== registry?.version.minecraftVersion) {
    if (session || mode === 'import' && world.columns.size) throw new Error('Select assets for the current world’s Java version.');
    if (!BROWSER_PROTOCOL_VERSIONS.includes(version)) throw new Error(`Supported Java versions: ${BROWSER_PROTOCOL_VERSIONS.join(', ')}.`);
    nextRegistry = await loadMinecraftRegistry({ url: `/data/${version}-registry.json` });
  }
  nextRegistry ??= await loadMinecraftRegistry();
  if (epoch !== connectionEpoch) return null;
  const overlays = serverPacks ? [...serverPacks.packs.values()].filter(entry => entry.file && !entry.discarded).map(entry => entry.file) : [];
  status('Loading block models and textures…');
  const next = await loadResourcePack([file, ...overlays], { registry: nextRegistry });
  if (epoch !== connectionEpoch) return next;
  await installPack(next, '', { guard: () => epoch === connectionEpoch, nextRegistry });
  if (epoch !== connectionEpoch || pack !== next) return next;
  // Atlas admission can reject a large pack. Keep the last accepted file and
  // persistent cache intact until the renderer has installed this one.
  userPackFile = file;
  packIsServer = overlays.length > 0;
  const saving = resourcePackSaving.catch(() => {}).then(async () => {
    if (epoch === connectionEpoch && userPackFile === file) await storeResourcePack(file);
  });
  resourcePackSaving = saving;
  let cacheWarning = '';
  try { await saving; } catch (error) { cacheWarning = ` · cache unavailable: ${error.message}`; }
  if (epoch === connectionEpoch && pack === next) packStatus(next, cacheWarning);
  return next;
}
async function installPack(next, cacheWarning = '', { guard = () => true, nextRegistry = registry } = {}) {
  if (!guard()) return;
  renderer.setTextureAtlas(next?.atlas ?? { pixels: new Uint8Array([255, 255, 255, 255]), width: 1, height: 1 });
  registry = nextRegistry;
  pack = next;
  packStatus(next, cacheWarning);
  if (mode !== 'demo') {
    const columns = [...world.columns.values()], bounds = world.bounds();
    await resetWorld({ registry, materials: next?.materials, minY: bounds.min[1], height: bounds.max[1] - bounds.min[1], originX: bounds.min[0] / 16, originZ: bounds.min[2] / 16, hasSkylight: world.hasSkylight, worldKey: world.worldKey, mode }, guard);
    if (!guard()) return;
    if (mode === 'import') world.setOverlay(persistedEdits());
    for (const column of columns) world.ingestColumn(column);
    if (mode === 'import') {
      await openImportedAuthority(guard);
      if (!guard()) return;
      await openImportedInventory(guard);
      if (!guard()) return;
      await updateAuthorityRunning();
    }
    entities?.clear();
    if (mode === 'server' && session) {
      entities = new EntityScene({ renderer, registry, registries: session.adapter.registries, materials: next?.materials ?? world.materialRegistry.materials, atlas: next?.atlas,
        getLight: position => sceneLight(...position.map(Math.floor)) });
      entities.maps = maps;
      for (const profile of session.players.values()) entities.consume({ type: 'player-info', player: profile });
      entities.consume({ type: 'tags', tags: [{ tagType: 'minecraft:item', tags: [...session.itemTags].map(([tagName, entries]) => ({ tagName, entries: [...entries] })) }] });
      for (const entity of session.entities.values()) entities.consume({ type: 'spawn', entity });
      applyPlayerState(session.state);
      updateFireworkBoost();
    }
  } else { refreshScenes(); audio?.setMusicMode('menu'); }
  status(next ? 'Minecraft textures and models loaded' : 'Using native materials without imported textures');
  return next;
}
function clearPlayerState() { if (!player) return; player.setVehicle(null); player.setFallFlying(false); player.setFireworkBoost(false); player.setSleeping(false); player.setEffects([]); }
function updateFireworkBoost() {
  player.setFireworkBoost(Boolean(session && [...session.entities.values()].some(entity => {
    const definition = registry.entities.find(definition => definition.id === entity.entityType);
    const key = definition?.metadataKeys?.indexOf('attached_to_target') ?? 9;
    return definition?.name === 'firework_rocket' && entity.metadata?.some(entry => entry.key === (key >= 0 ? key : 9) && entry.value === session.state.entityId);
  })));
}
function detachServer() {
  clearBreaking();
  void closeImportedAuthority().catch(authorityWarning);
  const epoch = ++connectionEpoch;
  const previous = session, previousPacks = serverPacks; session = null; serverPacks = null;
  previousPacks?.destroy(); previous?.disconnect();
  if (player) {
    player.onWakeRequest = null; player.onFlyingChange = null; player.onVehicleMove = null; player.onVehicleJump = null; player.onFallFlyingChange = null;
  }
  gameplay?.close(); gameplay = null; signEditor?.destroy(); signEditor = null;
  entities?.clear(); entities = null; firstPerson?.clear(); blockEntities?.clear(); effects?.clear(); clearPlayerState(); keys.clear(); ready = false;
  $('connection-status').textContent = 'Disconnected'; $('disconnect').hidden = true;
  audio?.stop(); audio?.setMusicMode('menu');
  return epoch;
}
async function restoreBasePack(epoch) {
  if (packIsServer) {
    const base = userPackFile || await restoreResourcePack();
    if (connectionEpoch !== epoch) return;
    const next = base ? await loadResourcePack(base, { registry }) : null;
    if (connectionEpoch !== epoch) return;
    packIsServer = false;
    await installPack(next, '', { guard: () => connectionEpoch === epoch });
  }
}
async function leaveServer() {
  await restoreBasePack(detachServer());
}
async function resumeImported() {
  const saved = JSON.parse(localStorage.getItem('pomme-last-import') || 'null');
  if (!saved?.worldKey || !Array.isArray(saved.spawn) || !saved.spawn.every(Number.isFinite)) throw new Error('No saved Java world is available.');
  registry ??= await loadMinecraftRegistry();
  if (!pack) { const cached = await restoreResourcePack(); if (cached) await loadPack(cached); }
  await leaveServer();
  const epoch = connectionEpoch;
  const active = () => connectionEpoch === epoch && !session;
  if (saved.version && !await selectRegistryVersion(saved.version, { guard: () => connectionEpoch === epoch })) return;
  mode = 'import'; loadingWorld = true; ready = false;
  switchSaveKey(`pomme-web-edits:${saved.worldKey}`);
  await resetWorld({ registry, materials: pack?.materials, minY: saved.minY, height: saved.height, hasSkylight: saved.hasSkylight,
    originX: Math.floor(saved.spawn[0] / 16) - 8, originZ: Math.floor(saved.spawn[2] / 16) - 8, worldKey: saved.worldKey, biomeSeed: BigInt(saved.biomeSeed ?? 0), mode }, active);
  if (!active()) return;
  world.setOverlay(persistedEdits());
  if (!world.store.keys().length) throw new Error('The saved chunks were evicted from browser storage. Import the region files again.');
  await world.restoreNearColumns();
  if (!active()) return;
  nativeHotbar(); player.setPosition(saved.spawn); player.fly = false;
  for (const block of persistedEdits()) { world.setBlock(...block); edits.set(block.slice(0, 3).join(','), block); }
  phase = saved.phase ?? 0.22;
  await openImportedAuthority(active);
  if (!active()) return;
  await openImportedInventory(active);
  if (!active()) return;
  loadingWorld = false; ready = true;
  await updateAuthorityRunning();
  $('play').disabled = false; $('welcome').hidden = true; $('pause').hidden = false;
  status(`${saved.name} · restored from browser storage`);
}
async function importFiles(files, { version, minY, height, hasSkylight = true } = {}) {
  await leaveServer();
  const epoch = connectionEpoch, active = () => connectionEpoch === epoch && !session;
  if (document.pointerLockElement) document.exitPointerLock();
  const regions = [...files].filter(file => /\.mca$/i.test(file.name));
  if (!regions.length) throw new Error('Select one or more r.x.z.mca files from your Java world’s region folder.');
  if (regions.length > 64 || regions.reduce((sum, file) => sum + file.size, 0) > 256 * 1024 * 1024) throw new Error('Import at most 64 region files, totaling 256 MB.');
  const level = [...files].find(file => file.name === 'level.dat');
  const metadata = level ? await importLevelDat(level) : null;
  if (!active()) return null;
  let sourceInventory = null;
  if (level) {
    try { sourceInventory = await readSourceLevelInventory(level); }
    catch (error) {
      if (!active()) return null;
      // Preserve a defer marker so resume cannot treat a source parse failure
      // as an absent inventory and write starter slots over that source.
      sourceInventory = unavailableSourceLevelInventory(error, { version: metadata?.version, dataVersion: metadata?.dataVersion });
      status(`Source inventory preserved for later loading: ${error.message}`);
    }
  }
  if (!active()) return null;
  const targetVersion = version ?? (BROWSER_PROTOCOL_VERSIONS.includes(metadata?.version) ? metadata.version : registry?.version.minecraftVersion ?? '1.20.4');
  if (!await selectRegistryVersion(targetVersion, { guard: active })) return null;
  const explicitBounds = minY !== undefined || height !== undefined;
  if (explicitBounds && (minY === undefined || height === undefined)) throw new Error('Supply both minY and height for a custom imported dimension.');
  let dimension = validateImportBounds(minY ?? -64, height ?? 384);
  const first = /^r\.(-?\d+)\.(-?\d+)\.mca$/i.exec(regions[0].name);
  if (!first) throw new Error('Keep the original r.x.z.mca region filenames.');
  const spawn = metadata?.spawn ?? [Number(first[1]) * 512 + 8, 100, Number(first[2]) * 512 + 8];
  mode = 'import'; serverDimension = null;
  const dimensionKey = explicitBounds ? `${dimension.minY}:${dimension.height}` : 'source-bounds';
  const worldKey = `import:${targetVersion}:${dimensionKey}:${hasSkylight ? 'sky' : 'no-sky'}:${regions.map(file => `${file.name}:${file.size}:${file.lastModified}`).sort().join('|')}`;
  if (sourceInventory) {
    const saving = storeSourceLevelInventory(worldKey, sourceInventory, { isCurrent: active });
    sourceInventorySaving = Promise.all([sourceInventorySaving.catch(() => {}), saving]).then(() => {});
    void sourceInventorySaving.catch(() => {});
  }
  switchSaveKey(`pomme-web-edits:${worldKey}`);
  loadingWorld = true; ready = false; $('play').disabled = true;
  const biomeSeed = metadata?.seed === undefined ? 0n : await hashBiomeSeed(metadata.seed);
  await resetWorld({ registry, materials: pack?.materials, ...dimension, hasSkylight,
    originX: Math.floor(spawn[0] / 16) - 8, originZ: Math.floor(spawn[2] / 16) - 8, worldKey, biomeSeed, mode }, active);
  if (!active()) return null;
  world.setOverlay(persistedEdits());
  nativeHotbar();
  let count = 0, skipped = 0, firstOccupied = null, receivedSections = 0;
  const onBounds = async inferred => {
    if (!active() || explicitBounds) return;
    const low = dimension.minY, high = low + dimension.height, inferredHigh = inferred.minY + inferred.height;
    if (inferred.minY >= low && inferredHigh <= high) return;
    const firstOutside = receivedSections === 0 && (inferred.minY >= high || inferredHigh <= low);
    const next = firstOutside ? inferred : { minY: Math.min(low, inferred.minY), height: Math.max(high, inferredHigh) - Math.min(low, inferred.minY) };
    validateImportBounds(next.minY, next.height);
    await world.flushImportColumn();
    if (!active()) return;
    const bounds = world.bounds(), columns = [...world.columns.values()], overlays = [...world.overlays.values()].flatMap(changes => [...changes.values()]);
    dimension = { minY: next.minY, height: next.height };
    await resetWorld({ registry, materials: pack?.materials, ...dimension, hasSkylight, originX: bounds.min[0] / 16, originZ: bounds.min[2] / 16,
      worldKey, biomeSeed, mode: 'import' }, active);
    if (!active()) return;
    world.setOverlay(overlays);
    for (const column of columns) world.ingestColumn(column);
    await world.restoreNearColumns();
    if (!active()) return;
    // Reduced far records carry dimension bounds. Rebuild earlier columns from
    // the exact cache instead of discarding them when this source expands.
    for (const key of world.store.keys()) {
      if (!active()) return;
      const [x, z] = key.split(',').map(Number);
      if (world.columns.has(key)) continue;
      const column = await world.store.get(x, z);
      if (!active()) return;
      if (column) await world.distant.ingest(column);
    }
  };
  for (const file of regions) {
    const match = /^r\.(-?\d+)\.(-?\d+)\.mca$/i.exec(file.name);
    if (!match) throw new Error(`Invalid region filename: ${file.name}`);
    status(`Importing ${file.name}…`);
    const result = await importAnvil(file, { regionX: Number(match[1]), regionZ: Number(match[2]), registry,
      ...(explicitBounds ? dimension : {}), onBounds, onSection: section => {
      if (!active()) return;
      receivedSections++;
      if (!firstOccupied) {
        const index = section.states.findIndex(id => !(world.materialRegistry.materials.get(id)?.flags & 128));
        if (index >= 0) firstOccupied = [section.cx * 16 + index % 16 + 0.5, 100, section.cz * 16 + (Math.floor(index / 16) % 16) + 0.5];
      }
      return world.ingestSection(section);
    }, onColumn: column => {
      if (!active()) return;
      const stored = world.columns.get(`${column.x},${column.z}`);
      if (stored) {
        stored.blockEntities = column.blockEntities;
        for (const section of column.sections) {
          const target = stored.sections.find(entry => entry.sectionY === section.sectionY);
          if (target) target.biomes = section.biomes;
          if (section.biomes) world.loadSectionBiomes(column.x, section.sectionY, column.z, section.biomes);
        }
      }
      blockEntities?.loadColumn(column);
    } });
    if (!active()) return null;
    count += result.chunks; skipped += result.diagnostics.skippedChunks.length;
    await new Promise(resolve => setTimeout(resolve, 0));
  }
  if (!active()) return null;
  await world.finishImport();
  if (!active()) return null;
  for (const block of persistedEdits()) { world.setBlock(...block); edits.set(block.slice(0, 3).join(','), block); }
  if (!metadata || !core.world_column_loaded(Math.floor(spawn[0] / 16), Math.floor(spawn[2] / 16))) {
    if (!firstOccupied) throw new Error('The selected region files contain no visible terrain.');
    spawn.splice(0, 3, ...firstOccupied); world.updateCamera(spawn);
    await world.restoreNearColumns();
    if (!active()) return null;
    spawn[1] = core.terrain_height(Math.floor(spawn[0]), Math.floor(spawn[2])) + 2;
  }
  player.setPosition(spawn); player.fly = false;
  phase = metadata?.dayTime != null ? Number(BigInt(metadata.dayTime) % 24000n) / 24000 : 0.22;
  await openImportedAuthority(active);
  if (!active()) return null;
  await openImportedInventory(active, sourceInventory);
  if (!active()) return null;
  loadingWorld = false; ready = true;
  await updateAuthorityRunning();
  if (!active()) return null;
  $('play').disabled = false; $('welcome').hidden = true; $('pause').hidden = false;
  try { localStorage.setItem('pomme-last-import', JSON.stringify({ worldKey, version: registry.version.minecraftVersion, ...dimension, hasSkylight,
    spawn: player.position, phase, biomeSeed: String(biomeSeed), name: metadata?.name || 'Java world' })); } catch {}
  const scope = importedAuthority?.stats();
  status(`${metadata?.name || 'Java world'} · ${count} chunks imported${skipped ? ` · ${skipped} unsupported entries` : ''}${scope ? ` · ${scope.sections} sections with lever/button/lamp ticks` : ' · local block editing'} ` .trim());
  return { chunks: count, skipped };
}
async function connectServer(options) {
  const epoch = detachServer(), version = options.version || '1.20.4';
  await authorityClosing;
  if (connectionEpoch !== epoch) return null;
  await restoreBasePack(epoch);
  if (connectionEpoch !== epoch) return null;
  if (!await selectRegistryVersion(version, { guard: () => connectionEpoch === epoch })) return null;
  mode = 'server'; serverDimension = null; serverStatus = null; switchSaveKey('pomme-web-server-no-local-edits');
  serverMapKey = `server:${options.host}:${options.port || 25565}:${version}`;
  renderer.setTextureAtlas(pack?.atlas ?? { pixels: new Uint8Array([255, 255, 255, 255]), width: 1, height: 1 });
  configureMaps({ resetAtlas: true });
  ready = false;
  $('connection-status').textContent = 'Connecting…'; $('account-code').hidden = true;
  const connectedRegistry = registry;
  const active = () => connectionEpoch === epoch && session === connectedSession && mode === 'server';
  const serverQueue = action => enqueue(async () => { if (active()) return action(); });
  const connectedSession = new MinecraftSession({ registry: connectedRegistry, getPlayer: () => player,
    onState: state => {
      if (!active()) return;
      if (state.status === 'disconnected') {
        ready = false; clearPlayerState();
        const manager = serverPacks; serverPacks = null; manager?.destroy(); connectionEpoch++;
        enqueue(async () => { if (session === connectedSession) await leaveServer(); });
        return;
      }
      $('connection-status').textContent = `${state.status}${state.reason ? ` · ${state.reason}` : ''}`;
      $('disconnect').hidden = state.status === 'disconnected'; gameplay?.state(state); applyPlayerState(state);
      const dimensionKey = `${state.dimension}:${state.minY}:${state.height}:${state.hasSkylight}`;
      if (state.status === 'loading' && (serverStatus !== 'loading' || serverDimension !== dimensionKey)) {
        const preserveLevel = state.preserveLevel && serverDimension === dimensionKey;
        serverDimension = dimensionKey;
        ready = false;
        serverQueue(async () => {
          if (preserveLevel) {
            // The native client replaces its local player while retaining the
            // ClientLevel, chunks and remote entities on same-dimension respawn.
            clearPlayerState();
            signEditor?.close(false);
            firstPerson?.clear();
            player.setPosition(player.position, state.respawnPosition ?? { yaw: 0, pitch: 0 });
            if (state.respawnPosition?.velocity) player.velocity = [...state.respawnPosition.velocity];
          } else {
            entities?.clear();
            await resetWorld({ registry: connectedRegistry, materials: pack?.materials, minY: state.minY, height: state.height, hasSkylight: state.hasSkylight, worldKey: `server:${options.host}:${options.port || 25565}:${state.dimension}`, mode }, active);
          }
          if (!active()) return;
          gameplay?.state(connectedSession.state); applyPlayerState(connectedSession.state); updateFireworkBoost();
          nativeHotbar();
        });
      }
      serverStatus = state.status;
      if (state.status === 'playing') { $('welcome').hidden = true; $('pause').hidden = locked; }
    },
    onColumn: column => serverQueue(() => world.ingestColumn(column)),
    onBlock: block => serverQueue(() => world.setBlock(block.x, block.y, block.z, block.stateId)),
    onUnload: column => serverQueue(() => world.unload(column.x, column.z)),
    onPosition: position => serverQueue(() => {
      player.setPosition([position.x, position.y, position.z], position);
      if (position.velocity) player.velocity = [position.velocity.x * 20, position.velocity.y * 20, position.velocity.z * 20];
      connectedSession.acknowledgePosition?.(position.teleportId);
      world.updateCamera(player.eye); ready = true;
    }),
    onTime: time => { if (!active()) return; worldAge = time.worldAge; worldAgeAt = performance.now(); phase = ((Number(time.timeOfDay) / 24000) + 1) % 1; $('cycle').checked = time.daylightCycle; },
    onInventory: inventory => { if (!active()) return; gameplay?.inventory(inventory); applyPlayerState(session.state); },
    onEntity: event => serverQueue(() => {
      entities?.consume(event);
      if (event.type === 'player-info' && event.player.uuid === session.state.uuid) firstPerson?.setProfile(event.player);
      if (event.entity?.id === session.state.vehicleId || event.type === 'remove' && event.id === session.state.vehicleId) updateRidingState({ teleport: event.teleport });
      updateFireworkBoost();
      if (event.type === 'spawn' && registry.entities.find(entity => entity.id === event.entity.entityType)?.name === 'lightning_bolt') effects?.event({ type: 'lightning' });
    }),
    onEvent: event => {
      if (!active()) return;
      if (event.type === 'player-velocity') {
        serverQueue(() => { gameplay?.event(event); connectedSession.acknowledgeMotion?.(event.motionRevision); });
        return;
      }
      gameplay?.event(event);
      if (event.type === 'tags' || event.type === 'registry') entities?.consume(event);
      if (event.type === 'break-progress') breaking?.event(event, Math.floor(breakingClock));
      if (event.type === 'resource-pack' || event.type === 'remove-resource-pack') {
        if (event.type === 'resource-pack' && (options.resourcePacks || $('server-packs').value) === 'prompt') { keys.clear(); if (document.pointerLockElement) document.exitPointerLock(); }
        void serverPacks?.event(event).catch(error => status(error.message));
      }
      if (event.type === 'open-sign') { keys.clear(); signEditor?.consume(event); }
      effects?.event(event);
      if (event.type === 'map') maps?.consume(event);
      if (event.type === 'block-entity' || event.type === 'block-action') serverQueue(() => { if (event.type === 'block-entity') world.setBlockEntity(event); blockEntities?.consume(event); });
      if (event.type === 'sound') audio?.playPacket(event.name, event.data);
      else if (event.type === 'stop-sound') audio?.stopPacket(event.data);
      else if (event.type === 'world-event') audio?.worldEvent?.(event.data);
      if (event.type === 'light') serverQueue(() => world.loadLight(event.x, event.z, event.light));
      if (event.type === 'msa-code') {
        $('account-code').hidden = false; $('account-code-text').textContent = event.userCode;
        const url = new URL(event.verificationUri || 'https://www.microsoft.com/link');
        if (url.protocol === 'https:') $('account-link').href = url.href;
      } else if (event.type === 'error') { $('connection-status').textContent = event.message; status(event.message); }
    },
  });
  session = connectedSession;
  const manager = new ServerResourcePacks({ session: connectedSession, gatewayUrl: options.gateway || $('server-gateway').value,
    preference: options.resourcePacks || $('server-packs').value, onStatus: message => { if (active()) status(message); },
    applyPacks: files => enqueue(async () => {
      const current = () => active() && serverPacks === manager && !manager.closed;
      if (!current()) return;
      const base = userPackFile || await restoreResourcePack();
      if (!current()) return;
      const stack = [...(base ? [base] : []), ...files];
      const next = stack.length ? await loadResourcePack(stack, { registry: connectedRegistry }) : null;
      if (!current()) return;
      await installPack(next, '', { guard: current });
      if (current()) packIsServer = files.length > 0;
    }, { propagate: true }) });
  serverPacks = manager;
  gameplay = new ServerGameplay({ session, registry, player, world, onStatus: status, getEntities: () => entities, onBlockSound: event => audio?.blockAction(event) });
  signEditor?.destroy();
  signEditor = new SignEditor({ session, atlas: pack?.atlas,
    getEntity: (x, y, z) => blockEntities?.entities.get(`${x},${y},${z}`),
    getMaterial: (x, y, z) => world.materialRegistry?.materials.get(core.block_get(x, y, z)),
    onClose: () => { keys.clear(); } });
  entities = new EntityScene({ renderer, registry, registries: session.adapter.registries, materials: pack?.materials, atlas: pack?.atlas,
    getLight: position => sceneLight(...position.map(Math.floor)) });
  entities.maps = maps;
  gameplay.setAssets?.({ atlas: pack?.atlas, materials: pack?.materials, maps });
  player.onWakeRequest = () => session.packet('entity_action', { entityId: session.state.entityId, actionId: 'stop_sleeping', jumpBoost: 0 });
  player.onFlyingChange = value => session.setFlying(value);
  player.onVehicleMove = vehicle => session.moveVehicle(vehicle);
  player.onVehicleJump = ({ power }) => session.packet('entity_action', { entityId: session.state.entityId, actionId: 'start_riding_jump', jumpBoost: power });
  player.onFallFlyingChange = active => { if (active) session.packet('entity_action', { entityId: session.state.entityId, actionId: 'start_fall_flying', jumpBoost: 0 }); };
  await session.connect(options.gateway || $('server-gateway').value, options);
  return session;
}
async function lock() {
  if (!ready) return;
  audio?.unlock();
  try { await $('world').requestPointerLock(); }
  catch { $('world-status').textContent = 'Click Enter world again to capture the mouse'; }
}
function startBenchmark() {
  if (!ready || benchmark) return;
  if (mode === 'server') { $('benchmark-status').textContent = 'Disconnect before running the fixed camera benchmark.'; return; }
  benchmark = { start: performance.now(), frames: [], gpu: [], gpuPasses: [], saved: { position: [...player.position], yaw: player.yaw, pitch: player.pitch, phase, adaptive: $('adaptive').checked, cycle: $('cycle').checked } };
  void updateAuthorityRunning().catch(authorityWarning);
  // Hold settings constant so exported runs are reproducible and comparable.
  $('adaptive').checked = false; $('cycle').checked = false; phase = 0.22;
  $('welcome').hidden = true; $('pause').hidden = true;
  for (const id of ['quality', 'resolution', 'adaptive', 'cycle', 'sun']) $(id).disabled = true;
  $('benchmark-status').textContent = 'Running fixed camera route: 30 seconds';
  $('benchmark').disabled = true;
}
function finishBenchmark(cancelled = false, cancellationReason = 'tab hidden or renderer stopped') {
  if (!benchmark) return;
  const stats = renderer.stats();
  lastResult = { schemaVersion: 2, build: 'pomme-web-minecraft', timestamp: new Date().toISOString(), seed, worldMode: mode, worldRevision: core.world_revision(), editCount: edits.size, cancelled, durationSeconds: (performance.now() - benchmark.start) / 1000, quality: $('quality').value, outputPixels: [$('world').width, $('world').height], renderPixels: [stats.renderWidth, stats.renderHeight], scale, dayPhase: phase, clock: 'requestAnimationFrame intervals (includes browser pacing)', frames: summarizeFrames(benchmark.frames), gpuClock: benchmark.gpu.length ? 'WebGPU timestamp-query' : 'unavailable', gpu: summarizeGpuTimes(benchmark.gpu), renderer: stats, distantTerrain: world.distant?.stats(), userAgent: navigator.userAgent, limits: 'WebGPU shaders inspired by Photon; original GLSL packs and Java mods are not directly loaded. Hardware results must be measured on the target GPU.' };
  if (cancelled) lastResult.cancellationReason = cancellationReason;
  lastResult.samples = { frameIntervalsMs: [...benchmark.frames], gpuDurationsMs: [...benchmark.gpu], gpuPasses: [...benchmark.gpuPasses] };
  lastResult.gpuProfileCapture = { warmupSeconds: 2, routeSeconds: 30, timestampUnit: 'nanoseconds; exact decimal strings',
    sampleWindow: 'CPU submission time', pendingReadbacksAtFinish: stats.gpuProfile.gpuProfiler.inFlight };
  lastResult.localLighting = world.lightingStats();
  lastResult.cachedIrradiance = world.irradiance?.stats();
  const saved = benchmark.saved;
  player.position = saved.position; player.yaw = saved.yaw; player.pitch = saved.pitch; phase = saved.phase;
  $('adaptive').checked = saved.adaptive; $('cycle').checked = saved.cycle;
  $('pause').hidden = locked; $('welcome').hidden = true;
  for (const id of ['quality', 'resolution', 'adaptive', 'cycle', 'sun']) $(id).disabled = false;
  $('benchmark-status').textContent = cancelled ? `Benchmark cancelled: ${cancellationReason}` : `${lastResult.frames?.averageFps.toFixed(1) ?? '—'} FPS · p95 ${lastResult.frames?.p95Ms.toFixed(1) ?? '—'} ms`;
  benchmark = null; $('benchmark').disabled = false; $('export-results').disabled = false;
  void updateAuthorityRunning().catch(authorityWarning);
}
function exportResult() {
  if (!lastResult) return;
  const url = URL.createObjectURL(new Blob([JSON.stringify(lastResult, null, 2)], { type: 'application/json' }));
  const link = document.createElement('a'); link.href = url; link.download = `pomme-web-benchmark-${Date.now()}.json`; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function frame(now) {
  if (!renderer || document.documentElement.dataset.engine === 'error') return;
  const elapsedMs = lastTime ? now - lastTime : 1000 / 60;
  lastTime = now;
  const dt = Math.min(elapsedMs / 1000, 0.25);
  try { if (ready && !document.hidden) {
    frames.push(elapsedMs); if (frames.length > 180) frames.shift();
    if (benchmark) {
      const t = (now - benchmark.start) / 1000;
      const angle = t * Math.PI * 2 / 30;
      const center = mode === 'demo' ? [64, 38, 64] : benchmark.saved.position;
      player.position = [center[0] + Math.sin(angle) * 31, center[1] + Math.sin(angle * 2) * 4, center[2] + Math.cos(angle) * 31];
      player.yaw = -angle; player.pitch = -0.37;
      if (t > 2) {
        benchmark.frames.push(elapsedMs);
      }
      if (t >= 30) finishBenchmark();
    } else {
      if (importedAuthority && authorityCurrent(importedAuthority)) {
        worldAge = importedAuthority.state.age; worldAgeAt = now;
        if ($('cycle').checked) phase = Number((importedAuthority.state.daytime % 24000n + 24000n) % 24000n) / 24000;
      } else if ($('cycle').checked) phase = (phase + Math.min(elapsedMs, 250) / 1_200_000) % 1;
      accumulator += dt;
      while (accumulator >= 1 / 120) { player.step(1 / 120, locked && !gameplay?.blocking && !signEditor?.blocking ? keys : new Set()); accumulator -= 1 / 120; }
      world.updateCamera(player.eye);
      session?.tick(player, dt, locked && !gameplay?.blocking && !signEditor?.blocking ? keys : new Set()); gameplay?.tick(dt);
      blockEntities?.update(now / 1000, player.eye, { direction: player.direction, fov: 75 * Math.PI / 180, aspect: $('world').width / $('world').height });
      player.applyBlockMotions?.(blockEntities?.drainBlockMotions?.() ?? []);
      effects?.tick(dt, { eye: player.eye, direction: player.direction, timeSeconds: now / 1000, hasSkylight: mode === 'server' ? session.state.hasSkylight : world.hasSkylight });
      audio?.updateListener({ eye: player.eye, direction: player.direction }); audio?.localTick?.(dt, { player, world, keys, session }); audio?.tick();
      const inventorySession = session ?? localInventory?.session;
      const slots = inventorySession?.windows.get(0)?.slots ?? [];
      const light = sceneLight(...player.eye.map(Math.floor));
      firstPerson?.update(now / 1000, { eye: player.eye, direction: player.direction, yaw: player.yaw, pitch: player.pitch,
        state: inventorySession?.state ?? { gameMode: 1, health: 20 }, mainHand: slots[36 + (inventorySession?.state.selectedSlot ?? 0)], offHand: slots[45],
        attack: Boolean(gameplay?.holding), use: Boolean(inventorySession?.state.usingItem), useHand: inventorySession?.state.usingHand ?? 0,
        visible: inventorySession?.state.status === 'playing' && !player.sleeping,
        leftHanded: Boolean(inventorySession?.state.leftHanded), invisible: Boolean(inventorySession?.state.invisible), skyLight: light.sky, blockLight: light.block });
      entities?.update(now / 1000, player.eye, { direction: player.direction, fov: 75 * Math.PI / 180, aspect: $('world').width / $('world').height, entityId: session?.state.entityId, gameTime: gameTime(),
        inWaterAt: position => {
          const point = position.map(Math.floor), material = world.materialRegistry?.materials.get(core.block_get(...point));
          const fluid = fluidState(material, material?.flags ?? 0);
          return fluid.kind === 'water' && position[1] < point[1] + fluid.height;
        } });
      if ($('adaptive').checked) {
        const next = controller.update(Math.max(elapsedMs, renderer.stats().lastGpuMs ?? 0), now, Number($('resolution').value));
        if (Math.abs(next - scale) > 0.001) { scale = next; renderer.resize(scale); }
      }
    }
  } } catch (error) { fail(error); return; }
  try { if (ready && !document.hidden) updateBreaking(dt); }
  catch (error) { fail(error); return; }
  // The renderer tracks actual geometry changes; empty worker results only
  // advance the application's diagnostic revision and preserve HDR history.
  try {
    if (ready) world.irradiance?.update({ eye: player.eye, dayPhase: phase, columns: world.columns });
    renderer.render({ eye: player.eye, yaw: player.yaw, pitch: player.pitch, timeSeconds: now / 1000, gameTime: gameTime(), dayPhase: phase, quality: $('quality').value, scale, weather: effects?.weather() });
  }
  catch (error) { fail(error); return; }
  if (now - hudAt > 500) {
    hudAt = now;
    const report = summarizeFrames(frames), stats = renderer.stats();
    $('fps').textContent = report ? report.averageFps.toFixed(0) : '—';
    $('frame-time').textContent = report ? `${report.p95Ms.toFixed(1)} ms p95` : '— ms';
    $('gpu-time').textContent = stats.gpuMs == null ? 'unavailable' : `${stats.gpuMs.toFixed(1)} ms`;
    $('geometry').textContent = `${stats.visibleChunks ?? 0}/${stats.totalChunks ?? 0} chunks · ${Math.round((stats.triangles ?? 0) / 1000)}k triangles`;
    $('shadow-cache').textContent = `${stats.shadowUpdates ?? 0} updates${stats.shadowCached ? ' · reused' : ''}`;
    $('render-scale').textContent = `${Math.round(scale * 100)}% · ${stats.renderWidth}×${stats.renderHeight}`;
  }
  requestAnimationFrame(frame);
}

async function boot() {
  if (!navigator.gpu) throw new Error('WebGPU is unavailable. Use a current Chrome or Edge on HTTPS or localhost, with hardware acceleration enabled.');
  $('play').disabled = true; $('export-results').disabled = true;
  const stored = persistedEdits();
  core = await loadCore(seed);
  for (const b of stored) { core.block_set(...b); edits.set(b.slice(0, 3).join(','), b); }
  player = new Player(core);
  renderer = await createRenderer($('world'), { onStatus: message => { $('world-status').textContent = message; }, onGpuSample: sample => recordGpuBenchmarkSample(benchmark, sample) });
  renderer.resize(scale);
  world = new BrowserWorld({ core, renderer,
    onMesh: () => { revision++; },
    onColumn: column => { blockEntities?.loadColumn(column); queueAuthorityColumn(column); },
    onBlock: block => { breaking?.blockChanged(block, block.stateId); blockEntities?.consume({ type: 'block', ...block }); },
    onUnload: column => { breaking?.removeColumn(column.x, column.z); blockEntities?.removeColumn(column.x, column.z); },
    onReady: () => {
      ready = mode === 'demo' || (mode === 'server' && session?.state.status === 'playing') || (mode === 'import' && !loadingWorld);
      $('play').disabled = !ready; $('world-status').textContent = mode === 'server' ? 'World ready' : 'World ready · edits saved on this device';
      document.documentElement.dataset.engine = 'ready';
    }, onError: fail, onStatus: status,
  });
  world.initDemo(seed, stored);
  try { $('resume-import').hidden = !localStorage.getItem('pomme-last-import'); } catch {}
  window.pomme = { get core() { return core; }, get player() { return player; }, get renderer() { return renderer; }, get breaking() { return breaking; }, get world() { return world; }, get authority() { return importedAuthority; }, get localInventory() { return localInventory; }, get session() { return session; }, get gameplay() { return gameplay; }, get entities() { return entities; }, get blockEntities() { return blockEntities; }, get signEditor() { return signEditor; }, get serverPacks() { return serverPacks; }, get firstPerson() { return firstPerson; }, get maps() { return maps; }, get effects() { return effects; }, get audio() { return audio; }, get registry() { return registry; }, get assets() { return pack; }, get mode() { return mode; }, connectServer, importFiles, resumeImported, loadPack, edit, useBlock: useImportedBlock, place: placeImported, saveAuthority: persistAuthority, saveInventory: saveImportedInventory, startBenchmark, get benchmark() { return lastResult; }, get ready() { return ready; }, get revision() { return revision; } };
  requestAnimationFrame(frame);
}

$('play').addEventListener('click', lock); $('resume').addEventListener('click', lock);
$('world').addEventListener('click', () => { if (!locked) lock(); });
document.addEventListener('pointerlockchange', () => {
  locked = document.pointerLockElement === $('world'); keys.clear();
  if (!locked) gameplay?.mouseUp();
  if (locked) $('world').focus();
  $('welcome').hidden = locked || ready || !!benchmark; $('pause').hidden = locked || !ready || !!benchmark;
});
document.addEventListener('mousemove', event => { if (locked && !benchmark) player.look(event.movementX, event.movementY); });
document.addEventListener('keydown', event => {
  audio?.unlock();
  if (signEditor?.blocking) { signEditor.key(event); keys.clear(); return; }
  if (player?.sleeping && event.code === 'Escape') { player.requestWake(); event.preventDefault(); return; }
  if (gameplay?.key(event)) { if (gameplay.blocking) keys.clear(); return; }
  if (event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement) return;
  if (event.code === 'KeyE' && locked) { document.exitPointerLock(); return; }
  if (!locked) return;
  if (['Space', 'KeyW', 'KeyA', 'KeyS', 'KeyD'].includes(event.code)) event.preventDefault();
  const inputCode = gameplay ? gameplay.controlCode(event.code) : event.code;
  if (inputCode) keys.add(inputCode);
  if (inputCode === 'Space' && !event.repeat && !player.grounded) player.startFallFlying();
  const buttons = [...document.querySelectorAll('[data-block]')];
  const index = Number(event.key) - 1;
  if (index >= 0 && index < buttons.length) select(Number(buttons[index].dataset.block));
});
document.addEventListener('keyup', event => { gameplay?.key(event); const inputCode = gameplay ? gameplay.controlCode(event.code) : event.code; if (inputCode) keys.delete(inputCode); });
window.addEventListener('blur', () => { keys.clear(); gameplay?.mouseUp(); });
window.addEventListener('pagehide', flushSave);
window.addEventListener('pagehide', saveImportedLocation);
window.addEventListener('pagehide', () => {
  const bridge = importedAuthority;
  if (bridge && authorityCurrent(bridge)) void bridge.authority.pause().then(() => persistAuthority(bridge))
    .catch(error => { if (authorityCurrent(bridge)) authorityWarning(error); });
});
window.addEventListener('pagehide', () => { void saveImportedInventory().catch(authorityWarning); });
window.addEventListener('pageshow', () => { void updateAuthorityRunning().catch(authorityWarning); });
setInterval(() => { saveImportedLocation(); void persistAuthority().catch(authorityWarning); void saveImportedInventory().catch(authorityWarning); }, 10000);
document.addEventListener('visibilitychange', () => {
  lastTime = 0; frames = [];
  if (document.hidden) { keys.clear(); gameplay?.mouseUp(); finishBenchmark(true); }
  void updateAuthorityRunning().catch(authorityWarning);
});
$('world').addEventListener('contextmenu', event => event.preventDefault());
$('world').addEventListener('mousedown', event => {
  if (!locked || benchmark || (event.button !== 0 && event.button !== 2)) return;
  const hit = player.target();
  if (event.button === 0) firstPerson?.swing(0, performance.now() / 1000);
  if (signEditor?.blocking) return;
  if (mode === 'server') { gameplay?.mouseDown(event.button, hit); return; }
  if (!hit) return;
  const action = event.button === 0 ? edit(...hit.slice(0, 3), 0) : placeImported(hit);
  void Promise.resolve(action).catch(authorityWarning);
});
document.addEventListener('mouseup', event => gameplay?.mouseUp(event.button));
document.querySelectorAll('[data-block]').forEach(button => button.addEventListener('click', () => select(Number(button.dataset.block))));
$('settings-toggle').addEventListener('click', () => { $('settings').hidden = !$('settings').hidden; $('settings-toggle').setAttribute('aria-expanded', String(!$('settings').hidden)); });
$('resolution').addEventListener('input', () => { scale = Number($('resolution').value); controller = new ResolutionController(scale); renderer?.resize(scale); });
$('sun').addEventListener('input', () => {
  phase = Number($('sun').value); $('cycle').checked = false;
  const bridge = importedAuthority;
  if (bridge) void bridge.authority.setTime(BigInt(Math.floor(phase * 24000)), false).then(() => persistAuthority(bridge)).catch(authorityWarning);
});
$('cycle').addEventListener('change', () => {
  const bridge = importedAuthority;
  if (bridge) void bridge.authority.setTime(BigInt(Math.floor(phase * 24000)), $('cycle').checked).then(() => persistAuthority(bridge)).catch(authorityWarning);
});
$('benchmark').addEventListener('click', startBenchmark); $('export-results').addEventListener('click', exportResult);
$('worlds-toggle').addEventListener('click', () => { $('worlds').hidden = !$('worlds').hidden; $('worlds-toggle').setAttribute('aria-expanded', String(!$('worlds').hidden)); });
$('resource-pack').addEventListener('change', event => { const file = event.target.files[0]; if (file) enqueue(() => loadPack(file)); });
$('world-files').addEventListener('change', event => enqueue(() => importFiles([...event.target.files])).then(() => { $('resume-import').hidden = !localStorage.getItem('pomme-last-import'); }));
$('resume-import').addEventListener('click', () => enqueue(resumeImported));
async function refreshLocalWorlds(selectedId = '') {
  const url = $('singleplayer-service').value.trim();
  if (!localWorldClient || localWorldClient.url !== url) localWorldClient = new SingleplayerClient({ url });
  const info = await localWorldClient.status(), worlds = await localWorldClient.listWorlds();
  $('singleplayer-world').replaceChildren(...worlds.map(world => { const option = document.createElement('option'); option.value = world.id; option.textContent = `${world.name} · ${world.gameMode} · ${world.version}`; return option; }));
  if (selectedId) $('singleplayer-world').value = selectedId;
  $('singleplayer-status').textContent = info.compatibilityError || `${worlds.length} saved worlds · Java ${info.version || info.supportedVersion}`;
  return localWorldClient;
}
$('singleplayer-refresh').addEventListener('click', () => enqueue(() => refreshLocalWorlds()));
$('singleplayer-create').addEventListener('click', () => enqueue(async () => {
  const client = await refreshLocalWorlds();
  const gameMode = $('singleplayer-mode').value;
  const created = await client.createWorld({ name: $('singleplayer-name').value, seed: $('singleplayer-seed').value, gameMode: gameMode === 'hardcore' ? 'survival' : gameMode, hardcore: gameMode === 'hardcore', difficulty: gameMode === 'hardcore' ? 'hard' : 'normal' });
  await refreshLocalWorlds(created.id);
}));
$('singleplayer-form').addEventListener('submit', event => {
  event.preventDefault(); enqueue(async () => {
    const client = localWorldClient || await refreshLocalWorlds();
    const endpoint = await client.startWorld($('singleplayer-world').value, { username: $('server-username').value.trim() });
    await connectServer({ ...endpoint, gateway: $('server-gateway').value });
    localWorldActive = true; $('singleplayer-stop').hidden = false;
    $('singleplayer-status').textContent = `${endpoint.world?.name || 'Local world'} · running`;
  });
});
$('singleplayer-stop').addEventListener('click', () => enqueue(async () => {
  await leaveServer();
  const result = await localWorldClient.stopWorld(); localWorldActive = false;
  $('singleplayer-stop').hidden = true; $('singleplayer-status').textContent = result.saved ? 'World saved' : 'World stopped';
  mode = 'import'; ready = false; audio?.setMusicMode('menu');
}));
$('server-form').addEventListener('submit', event => {
  event.preventDefault();
  enqueue(() => connectServer({ host: $('server-host').value.trim(), port: Number($('server-port').value), username: $('server-username').value.trim(), auth: $('server-auth').value, version: $('server-version').value, resourcePacks: $('server-packs').value, gateway: $('server-gateway').value }));
});
$('disconnect').addEventListener('click', () => { const epoch = detachServer(); enqueue(() => restoreBasePack(epoch)); });
window.addEventListener('resize', () => { if (benchmark) finishBenchmark(true, 'window size changed'); renderer?.resize(scale); });
boot().catch(fail);
