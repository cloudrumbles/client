import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Player } from '../src/player.js';
import { ServerGameplay } from '../src/gameplay.js';
import { ServerHud, effectText } from '../src/server-hud.js';
import { containerLayout, recipeMatchesMenu, tradePrice } from '../src/container-ui.js';
import { ServerProgress, statisticValue } from '../src/server-progress.js';
import { BookDraft, bookContent } from '../src/books.js';

const SPRINT_UUID = '662a6b8d-da3e-4c1c-8813-96ea6097278d';
const PLUGIN_UUID = '10000000-0000-4000-8000-000000000001';

function subject(state) {
  const core = {
    world_origin_x: () => -128, world_origin_z: () => -128,
    world_width: () => 256, world_depth: () => 256, world_height: () => 384,
    world_min_y: () => -64, world_column_loaded: () => 1,
    terrain_height: () => 0,
    collides_aabb: (_x0, y0) => Number(y0 < -0.0001),
  };
  const player = new Player(core); player.setPosition([0, 0, 0]);
  // Exercise the actual server-state bridge without needing a DOM constructor.
  const gameplay = {
    player, root: {}, active: false,
    ui: { health: {}, food: {}, level: {}, creative: {}, death: {}, respawn: {} },
    renderHotbar() {},
  };
  ServerGameplay.prototype.state.call(gameplay, { status: 'playing', gameMode: 0, health: 20, food: 20, ...state });
  return player;
}

function distance(player, keys = ['KeyW']) {
  for (let tick = 0; tick < 40; tick++) player.step(0.05, new Set(keys));
  return -player.position[2];
}

function attributes(modifiers, value = 0.1) {
  return [{ name: 'minecraft:generic.movement_speed', value, modifiers }];
}

test('server sprint attribute updates preserve the actual 1.3 locomotion factor', () => {
  const walk = subject({ attributes: attributes([]) });
  const sprint = subject({ attributes: attributes([{ uuid: SPRINT_UUID.toUpperCase(), operation: 2, amount: 0.30000001192092896 }]) });
  const released = subject({ attributes: attributes([{ uuid: SPRINT_UUID, operation: 2, amount: 0.3 }]) });
  const walkingDistance = distance(walk);
  assert.ok(Math.abs(distance(sprint, ['KeyW', 'ControlLeft']) / walkingDistance - 1.3) < 0.00001);
  assert.equal(distance(released), walkingDistance, 'stale server sprint metadata does not accelerate released sprint input');
  assert.equal(sprint.movementMultiplier, 1);
});

test('sprint normalization retains plugin and potion modifiers with vanilla attribute operation order', () => {
  const baseline = distance(subject({}));
  const player = subject({
    effects: [{ id: 0, amplifier: 0 }, { id: 1, amplifier: 0 }],
    attributes: attributes([
      { uuid: SPRINT_UUID, operation: 2, amount: 0.3 },
      { uuid: PLUGIN_UUID, operation: 0, amount: 0.02 },
      { uuid: '10000000-0000-4000-8000-000000000002', operation: 1, amount: 0.5 },
      { uuid: '10000000-0000-4000-8000-000000000003', operation: 1, amount: 0.25 },
      { uuid: '91aeaa56-376b-4498-935b-2f7f68070635', operation: 2, amount: 0.2 },
      { uuid: '7107de5e-7ce8-4030-940e-514c1f160890', operation: 2, amount: -0.15 },
    ]),
  });
  const expected = (0.1 + 0.02) * (1 + 0.5 + 0.25) * 1.2 * 0.85 / 0.1;
  assert.ok(Math.abs(distance(player) / baseline - expected) < 0.00001);
  assert.ok(Math.abs(player.movementMultiplier - expected) < 0.0000001);
});

test('a plugin speed boost of 0.3 remains distinct from the vanilla sprint UUID', () => {
  const baseline = distance(subject({}));
  const player = subject({ attributes: attributes([{ uuid: PLUGIN_UUID, operation: 2, amount: 0.3 }]) });
  assert.ok(Math.abs(distance(player, ['KeyW', 'ControlLeft']) / baseline - 1.69) < 0.00001);
});

test('effects provide base speed when no movement attribute exists', () => {
  const baseline = distance(subject({}));
  const player = subject({ effects: [{ id: 0, amplifier: 1 }, { id: 1, amplifier: 0 }] });
  assert.ok(Math.abs(distance(player) / baseline - 1.4 * 0.85) < 0.00001);
});

const text = (value) => ({ type: 'compound', value: { text: { type: 'string', value } } });

test('server titles use native tick timing, negative timing preservation, and clear/reset packets', () => {
  const hud = new ServerHud();
  hud.packet('set_title_time', { fadeIn: 4, stay: 10, fadeOut: 6 });
  hud.packet('set_title_subtitle', { text: text('Stay alive') });
  hud.packet('set_title_text', { text: text('Night') });
  assert.equal(hud.title, 'Night'); assert.equal(hud.subtitle, 'Stay alive'); assert.equal(hud.titleRemaining, 1); assert.equal(hud.titleOpacity, 0);
  hud.tick(0.1); assert.equal(hud.titleOpacity, 0.5);
  hud.tick(0.4); assert.equal(hud.titleOpacity, 1);
  hud.tick(0.35); assert.ok(Math.abs(hud.titleOpacity - 0.5) < 1e-10);
  hud.packet('set_title_time', { fadeIn: -1, stay: 20, fadeOut: -1 });
  assert.deepEqual(hud.titleTimes, { fadeIn: 4, stay: 20, fadeOut: 6 });
  hud.packet('clear_titles', { reset: true }); assert.equal(hud.titleOpacity, 0); assert.equal(hud.subtitle, ''); assert.deepEqual(hud.titleTimes, { fadeIn: 10, stay: 70, fadeOut: 20 });
});

test('bossbar updates retain unaffected fields and action bars expire during open menus', () => {
  const hud = new ServerHud();
  hud.packet('boss_bar', { entityUUID: 'dragon', action: 0, title: text('Dragon'), health: 0.9, color: 5, dividers: 0, flags: 1 });
  hud.packet('boss_bar', { entityUUID: 'dragon', action: 2, health: 0.4 });
  assert.equal(hud.bossBars.get('dragon').title, 'Dragon'); assert.equal(hud.bossBars.get('dragon').health, 0.4);
  hud.packet('boss_bar', { entityUUID: 'dragon', action: 4, color: 2, dividers: 2 });
  assert.equal(hud.bossBars.get('dragon').color, 2); assert.equal(hud.bossBars.get('dragon').flags, 1);
  hud.action('Sleeping'); hud.tick(2.9); assert.ok(hud.actionRemaining > 0); hud.tick(0.2); assert.equal(hud.actionRemaining, 0);
  hud.packet('boss_bar', { entityUUID: 'dragon', action: 1 }); assert.equal(hud.bossBars.size, 0);
});

test('scoreboard mirrors native objective/removal/team/number-format semantics', () => {
  const hud = new ServerHud();
  hud.packet('scoreboard_objective', { name: 'kills', action: 0, displayText: text('Kills'), type: 0, number_format: null });
  hud.packet('scoreboard_display_objective', { position: 1, name: 'kills' });
  hud.packet('teams', { team: 'red', mode: 0, prefix: text('[Red] '), suffix: text('!'), formatting: 12, players: ['Alex'] });
  for (const [itemName, value] of [['Alex', 12], ['Steve', 9], ['#hidden', 99]]) hud.packet('scoreboard_score', { scoreName: 'kills', itemName, value });
  assert.deepEqual(hud.sidebar('Steve'), { title: 'Kills', rows: [{ name: '[Red] Alex!', value: '12' }, { name: 'Steve', value: '9' }] });
  hud.packet('scoreboard_score', { scoreName: 'kills', itemName: 'Steve', value: 10, number_format: 2, styling: text('★★') });
  assert.equal(hud.sidebar('Steve').rows[1].value, '★★');
  hud.packet('reset_score', { entity_name: 'Steve', objective_name: null }); assert.equal(hud.sidebar('Steve').rows.length, 1);
  hud.packet('teams', { team: 'red', mode: 4, players: ['Alex'] }); assert.equal(hud.sidebar('Alex').rows[0].name, 'Alex');
  hud.packet('scoreboard_objective', { name: 'redKills', action: 0, displayText: text('Team score'), number_format: 0 });
  hud.packet('scoreboard_display_objective', { position: 15, name: 'redKills' });
  hud.packet('teams', { team: 'red', mode: 3, players: ['Alex'] });
  assert.equal(hud.sidebar('Alex').title, 'Team score');
  hud.packet('scoreboard_objective', { name: 'redKills', action: 1 }); assert.equal(hud.sidebar('Alex').title, 'Kills');
});

test('player list excludes unlisted users and decorates team names with native objective scores', () => {
  const hud = new ServerHud();
  hud.players = [{ uuid: 'a', name: 'Alex', listed: true, gamemode: 0, latency: 22 }, { uuid: 'b', name: 'Steve', listed: true, gamemode: 3, displayName: text('Spectator') }, { uuid: 'c', name: 'Hidden', listed: false }];
  hud.packet('scoreboard_objective', { name: 'ping', action: 0, displayText: text('Score') });
  hud.packet('scoreboard_display_objective', { position: 0, name: 'ping' });
  hud.packet('scoreboard_score', { scoreName: 'ping', itemName: 'Alex', value: 3 });
  assert.deepEqual(hud.playerList().map(({ display, score }) => [display, score]), [['Alex', '3'], ['Spectator', '']]);
});

test('native container layouts partition actual slots without inventing container indexes', () => {
  for (const [id, type, count] of [[0, undefined, 46], [1, 12, 46], [2, 21, 40], [3, 14, 39], [4, 11, 41], [5, 19, 39], [6, 6, 45], [7, 17, 1], [8, 5, 90], [9, 7, 46]]) {
    const layout = containerLayout(id, type, count), indexes = layout.groups.flatMap((group) => group.slots);
    assert.equal(new Set(indexes).size, count, `${layout.name} exposes every native slot once`);
    assert.deepEqual([...indexes].sort((a, b) => a - b), Array.from({ length: count }, (_, index) => index));
  }
  assert.deepEqual(containerLayout(1, 12, 46).groups[0], { name: 'Crafting grid', slots: [1, 2, 3, 4, 5, 6, 7, 8, 9], columns: 3 });
  assert.deepEqual(containerLayout(1, 21, 40).groups[0].slots, [0, 1, 2]);
  assert.equal(containerLayout(1, 17, 1).groups.length, 1);
  assert.deepEqual(containerLayout(1, 7, 46).groups[1].slots, [45]);
});

test('advancement requirement groups use native AND of OR semantics and hidden nodes await completion', () => {
  const progress = new ServerProgress();
  progress.advancement({ reset: true, advancementMapping: [
    { key: 'root', value: { parentId: null, displayData: { title: text('Root'), flags: {}, xCord: 0, yCord: 0 }, requirements: [['start']] } },
    { key: 'secret', value: { parentId: 'root', displayData: { title: text('Secret'), flags: { hidden: 1, show_toast: 1 }, xCord: 1, yCord: 0 }, requirements: [['stone', 'deepslate'], ['diamond']] } },
  ], identifiers: [], progressMapping: [{ key: 'secret', value: [{ criterionIdentifier: 'stone', criterionProgress: 0n }, { criterionIdentifier: 'diamond', criterionProgress: null }] }] });
  assert.deepEqual(progress.completion('secret'), { done: 1, total: 2, complete: false });
  assert.deepEqual(progress.visible('root').map((node) => node.id), ['root']);
  progress.advancement({ reset: false, advancementMapping: [], identifiers: [], progressMapping: [{ key: 'secret', value: [{ criterionIdentifier: 'deepslate', criterionProgress: null }, { criterionIdentifier: 'stone', criterionProgress: 0n }, { criterionIdentifier: 'diamond', criterionProgress: 1690000000000n }] }] });
  assert.deepEqual(progress.completion('secret'), { done: 2, total: 2, complete: true });
  assert.deepEqual(progress.visible('root').map((node) => node.id), ['root', 'secret']);
  assert.equal(progress.toasts.length, 1); progress.tick(5.1); assert.equal(progress.toasts.length, 0);
  progress.advancement({ reset: false, advancementMapping: [], identifiers: ['root'], progressMapping: [] });
  assert.equal(progress.advancements.size, 0); assert.equal(progress.progress.size, 0);
});

test('server statistics accumulate partial updates and use native numeric registry categories/units', () => {
  const progress = new ServerProgress(), registry = { blocks: [{ id: 1, displayName: 'Stone' }], items: [{ id: 10, displayName: 'Apple' }], entities: [{ id: 3, name: 'pig' }] };
  progress.stats([{ categoryId: 0, statisticId: 1, value: 12 }, { categoryId: 1, statisticId: 10, value: 3 }, { categoryId: 6, statisticId: 3, value: 1 }, { categoryId: 8, statisticId: 1, value: 1200 }]);
  progress.stats([{ categoryId: 0, statisticId: 1, value: 13 }]);
  assert.equal(progress.statisticRows(registry, 0)[0].name, 'Stone'); assert.equal(progress.statisticRows(registry, 0)[0].formatted, '13');
  assert.equal(progress.statisticRows(registry, 1)[0].name, 'Apple'); assert.equal(progress.statisticRows(registry, 6)[0].name, 'pig');
  assert.equal(progress.statisticRows(registry, 8)[0].formatted, '1.00 min');
  assert.equal(statisticValue(8, 6, 250000), '2.50 km'); assert.equal(statisticValue(8, 23, 145), '14.50');
});

test('book drafts preserve authoritative inventory, trim empty trailing pages, and use native inventory slots', () => {
  const source = { present: true, itemId: 100, nbtData: { pages: ['Original page'], title: '', author: '' } };
  const draft = new BookDraft(source, { hotbarSlot: 3, editable: true });
  assert.equal(draft.packet(), null); draft.setPage('A new page'); draft.next();
  assert.deepEqual(draft.packet(), { hand: 3, pages: ['A new page'], title: undefined });
  assert.deepEqual(source.nbtData.pages, ['Original page']); assert.equal(draft.matches(source), true);
  draft.title = '  Hello book  '; assert.deepEqual(draft.packet(true), { hand: 3, pages: ['A new page'], title: 'Hello book' });
  assert.equal(draft.matches({ ...source, nbtData: { pages: ['Another server book'] } }), false);
  const offhand = new BookDraft(source, { hand: 1, editable: true }); offhand.setPage('Offhand'); assert.equal(offhand.packet().hand, 40);
});

test('book readers decode legacy and modern native book components without enabling written book editing', () => {
  const slot = { present: true, itemId: 100, components: [{ type: 'written_book_content', data: { rawTitle: 'Adventure', author: 'Alex', generation: 1, pages: [{ content: text('Native component page'), filteredContent: null }] } }] };
  assert.equal(bookContent(slot).author, 'Alex'); const book = new BookDraft(slot);
  assert.equal(book.text(), 'Native component page'); assert.equal(book.packet(true), null);
});

test('recipe grid limits count alternative ingredients once and trade prices use demand/discount clamps', () => {
  const alternatives = Array.from({ length: 12 }, () => ({ present: true, itemId: 1 }));
  assert.equal(recipeMatchesMenu({ type: 'minecraft:crafting_shapeless', data: { ingredients: [alternatives, alternatives] } }, 'player'), true);
  assert.equal(recipeMatchesMenu({ type: 'minecraft:crafting_shaped', data: { width: 3, height: 1 } }, 'player'), false);
  assert.equal(recipeMatchesMenu({ type: 'minecraft:smelting' }, 'furnace'), true);
  assert.equal(tradePrice({ inputItem1: { itemCount: 10 }, demand: 4, priceMultiplier: 0.2, specialPrice: -2 }, { stackSize: 64 }), 16);
  assert.equal(tradePrice({ inputItem1: { itemCount: 2 }, specialPrice: -20 }, { stackSize: 16 }), 1);
  assert.equal(tradePrice({ inputItem1: { itemCount: 20 }, demand: 20, priceMultiplier: 0.2 }, { stackSize: 64 }), 64);
  assert.equal(effectText({ id: 12, amplifier: 1, duration: 1201 }), 'Water breathing 2 1:01');
});

test('configurable movement controls release canonical keys and retain alternate modifier keys', () => {
  const gameplay = { controls: { forward: 'ArrowUp', back: 'KeyS', left: 'KeyA', right: 'KeyD', jump: 'Space', sneak: 'ShiftLeft', sprint: 'ControlLeft' } };
  assert.equal(ServerGameplay.prototype.controlCode.call(gameplay, 'ArrowUp'), 'KeyW');
  assert.equal(ServerGameplay.prototype.controlCode.call(gameplay, 'KeyW'), null);
  assert.equal(ServerGameplay.prototype.controlCode.call(gameplay, 'ShiftRight'), 'ShiftLeft');
  assert.equal(ServerGameplay.prototype.controlCode.call(gameplay, 'F3'), 'F3');
});
