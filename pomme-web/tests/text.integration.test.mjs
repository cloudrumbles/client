import assert from 'node:assert/strict';
import test from 'node:test';
import { MinecraftChatTypes, parseTextComponent, setLanguage, textComponent, textSegments, withTextStyle } from '../src/text.js';
import { ServerHud, effectText } from '../src/server-hud.js';
import { ServerProgress } from '../src/server-progress.js';
import { BookDraft } from '../src/books.js';
import { signPlainMessage, signTextColor } from '../src/sign-editor.js';

test.beforeEach(() => setLanguage(null));

test('anonymous-NBT string components stay literal when their text happens to be valid JSON', () => {
  const jsonLooking = { type: 'string', value: '{"text":"literal JSON"}' };
  assert.equal(textComponent(jsonLooking), '{"text":"literal JSON"}');
  assert.equal(textComponent({ text: '', extra: [parseTextComponent(jsonLooking)] }), '{"text":"literal JSON"}');
  assert.equal(textComponent(withTextStyle('{"text":"Legacy serialized component"}', { color: 'red' })), 'Legacy serialized component');
});

test('HUD preserves raw styled components and translates existing messages again after a pack reload', () => {
  setLanguage({ title: 'First %s' });
  const hud = new ServerHud(), component = { translate: 'title', color: 'red', bold: true, with: ['world'] };
  hud.packet('set_title_text', { text: component }); hud.packet('set_title_subtitle', { text: { text: 'Subtitle', italic: true } });
  hud.action('Pre-flattened text', component); hud.packet('boss_bar', { action: 0, entityUUID: 'boss', title: component, health: 1 });
  assert.equal(hud.title, 'First world'); assert.equal(hud.actionBar, 'First world'); assert.equal(hud.titleComponent, component);
  assert.equal(textSegments(hud.titleComponent)[0].style.color, '#ff5555');
  const revision = hud.revision; setLanguage({ title: 'Reloaded %s' }); hud.tick(0);
  assert.equal(hud.title, 'Reloaded world'); assert.equal(hud.actionBar, 'Reloaded world'); assert.equal(hud.bossBars.get('boss').title, 'Reloaded world'); assert.ok(hud.revision > revision);
  hud.packet('clear_titles', { reset: false }); assert.equal(hud.titleComponent, ''); assert.equal(hud.subtitleComponent, '');
});

test('team names inherit native team color while explicit prefixes and number formats keep their own styles', () => {
  const hud = new ServerHud();
  hud.packet('scoreboard_objective', { name: 'score', action: 0, displayText: { text: 'Score', color: 'aqua' }, number_format: null });
  hud.packet('scoreboard_display_objective', { position: 1, name: 'score' });
  hud.packet('teams', { mode: 0, team: 'red', formatting: 12, prefix: { text: '[R]', color: 'gold' }, suffix: { text: '!', underlined: true }, players: ['Alex'] });
  hud.packet('scoreboard_score', { scoreName: 'score', itemName: 'Alex', value: 7 });
  const first = hud.sidebarComponents('Steve');
  assert.equal(textComponent(first.titleComponent), 'Score');
  assert.deepEqual(textSegments(first.rows[0].nameComponent).map(({ text, style }) => [text, style.color]), [['[R]', '#ffaa00'], ['Alex', '#ff5555'], ['!', '#ff5555']]);
  assert.equal(textSegments(first.rows[0].valueComponent)[0].style.color, '#ff5555');
  hud.packet('scoreboard_score', { scoreName: 'score', itemName: 'Alex', value: 8, number_format: 1, styling: { type: 'compound', value: { color: { type: 'string', value: 'green' }, bold: { type: 'byte', value: 1 } } } });
  const styled = textSegments(hud.sidebarComponents('Steve').rows[0].valueComponent)[0];
  assert.deepEqual(styled, { text: '8', style: { color: '#55ff55', bold: true } });
  hud.packet('scoreboard_score', { scoreName: 'score', itemName: 'Alex', value: 8, number_format: 2, styling: { text: 'Fixed', color: 'blue' } });
  assert.equal(textComponent(hud.sidebarComponents('Steve').rows[0].valueComponent), 'Fixed');
  hud.packet('scoreboard_score', { scoreName: 'score', itemName: 'Alex', value: 8, number_format: 0 }); assert.equal(textComponent(hud.sidebarComponents('Steve').rows[0].valueComponent), '');
});

test('native list score defaults are yellow and explicit display names retain style instead of team decoration', () => {
  const hud = new ServerHud(); hud.players = [{ name: 'Alex', displayName: { text: 'Alias', italic: true } }];
  hud.packet('scoreboard_objective', { name: 'score', action: 0, displayText: { text: 'Score' } }); hud.packet('scoreboard_display_objective', { position: 0, name: 'score' });
  hud.packet('scoreboard_score', { scoreName: 'score', itemName: 'Alex', value: 5 });
  assert.equal(textSegments(hud.playerList()[0].displayComponent)[0].style.italic, true);
  assert.equal(textSegments(hud.playerList()[0].scoreComponent)[0].style.color, '#ffff55');
});

test('written books retain page component styles, while writable pages retain literal JSON-looking input', () => {
  const page = { translate: 'page', color: 'green', with: [{ text: 'Alex', bold: true }, 9n] };
  setLanguage({ page: '%s / %s' });
  const slot = { present: true, itemId: 1, components: [{ type: 'written_book_content', data: { author: 'Alex', rawTitle: 'Book', pages: [{ content: page }] } }] };
  const book = new BookDraft(slot); assert.equal(book.text(), 'Alex / 9'); assert.equal(book.matches(slot), true);
  assert.equal(textSegments(book.component())[0].style.bold, true); assert.equal(textSegments(book.component())[0].style.color, '#55ff55');
  assert.equal(textComponent(book.pageIndicator()), 'Page 1 of 1'); assert.equal(textComponent(book.byAuthor()), 'by Alex');
  const draft = new BookDraft({ itemId: 1, nbtData: { pages: ['{"text":"literal"}'] } }, { editable: true }); assert.equal(textComponent(draft.component()), '{"text":"literal"}');
});

test('advancement and statistic labels resolve pack translations without losing raw title or description styles', () => {
  setLanguage({ title: 'Imported advancement', desc: 'Imported description', 'block.minecraft.stone': 'Imported stone', 'item.minecraft.apple': 'Imported apple', 'stat.minecraft.jump': 'Imported jumps', 'advancements.toast.challenge': 'Imported challenge' });
  const progress = new ServerProgress(); progress.advancement({ reset: true, advancementMapping: [{ key: 'root', value: { displayData: { title: { translate: 'title', color: 'gold' }, description: { translate: 'desc', italic: true }, frameType: 1, flags: {} } } }] });
  assert.equal(textComponent(progress.titleComponent('root')), 'Imported advancement'); assert.equal(textSegments(progress.descriptionComponent('root'))[0].style.italic, true); assert.equal(textComponent(progress.toastComponent('root')), 'Imported challenge');
  const registry = { blocks: [{ id: 1, name: 'stone' }], items: [{ id: 1, name: 'stone' }, { id: 2, name: 'apple' }], entities: [] };
  progress.stats([{ categoryId: 1, statisticId: 1, value: 1 }, { categoryId: 1, statisticId: 2, value: 2 }, { categoryId: 8, statisticId: 21, value: 3 }]);
  assert.deepEqual(progress.statisticRows(registry, 1).map(row => row.name), ['Imported apple', 'Imported stone']); assert.equal(progress.statisticRows(registry, 8)[0].name, 'Imported jumps');
});

test('native sign editing uses translated plain strings and exact DyeColor text colors instead of texture colors', () => {
  setLanguage({ sign: '%s!' }); assert.equal(signPlainMessage({ translate: 'sign', color: 'red', bold: true, with: ['Alex'] }), 'Alex!');
  assert.equal(signTextColor('red', true), 0xff0000); assert.equal(signTextColor('red', false), 0x660000); assert.equal(signTextColor('white', false), 0x666666); assert.equal(signTextColor('black', true), 0);
  setLanguage({ 'effect.minecraft.water_breathing': 'Water Breathing', 'potion.potency.1': 'II', 'potion.withAmplifier': '%s %s' }); assert.equal(effectText({ id: 12, name: 'water_breathing', amplifier: 1, duration: 1200 }), 'Water Breathing II 1:00');
});

test('native dynamic chat types preserve sender/target parameter order, whisper styles, and modern holders', () => {
  setLanguage({ incoming: '%s whispers %s', team: '[%s] <%s> %s', custom: '%s via %s' });
  const types = new MinecraftChatTypes();
  assert.equal(types.loadRegistry({ 'minecraft:dimension_type': { value: [] } }), false);
  assert.equal(types.loadRegistry({ 'minecraft:chat_type': { value: [
    { id: 2, element: { chat: { translation_key: 'incoming', parameters: ['sender', 'content'], style: { color: 'gray', italic: true } } } },
    { id: 4, element: { chat: { translation_key: 'team', parameters: ['target', 'sender', 'content'], style: {} } } },
  ] } }), true);
  const incoming = types.decorate({ text: 'Hello', bold: true }, { type: 2, name: { text: 'Alex' } });
  assert.equal(textComponent(incoming), 'Alex whispers Hello');
  assert.equal(textSegments(incoming)[0].style.color, '#aaaaaa'); assert.equal(textSegments(incoming)[0].style.italic, true); assert.equal(textSegments(incoming).at(-1).style.bold, true);
  assert.equal(textComponent(types.decorate('Hi', { type: { chatType: 4 }, name: 'Alex', target: 'Red' })), '[Red] <Alex> Hi');
  assert.equal(textComponent(types.decorate('Hi', { type: { chatType: 4 }, name: 'Alex' })), '[] <Alex> Hi');
  const inline = types.decorate('Hello', { type: { data: { chat: { translationKey: 'custom', parameters: ['content', 'sender'], style: { color: 'aqua' } } } }, name: 'Alex' });
  assert.equal(textComponent(inline), 'Hello via Alex'); assert.equal(textSegments(inline)[0].style.color, '#55ffff');
  types.clear(); assert.equal(textComponent(types.decorate('Hello', { type: 4, name: 'Alex' })), '<Alex> Hello');
});
