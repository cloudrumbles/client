import assert from 'node:assert/strict';
import test from 'node:test';
import { getLanguage, renderTextComponent, setLanguage, textComponent, textSegments } from '../src/text.js';

test.beforeEach(() => setLanguage(null));

test('imported English and selected language apply key-wise fallback and native numeric format normalization', () => {
  const status = setLanguage(new Map([
    ['en_us', { joined: '%s joined', count: '%1$02d items, %2$.1f weight', missing: 'English fallback', bool: true }],
    ['de_de', { joined: '%s ist da' }],
  ]), { language: 'de_de' });
  assert.equal(status.language, 'de_de'); assert.equal(status.entries, 4);
  assert.equal(textComponent({ translate: 'joined', with: [{ text: 'Alex' }] }), 'Alex ist da');
  assert.equal(textComponent({ translate: 'missing' }), 'English fallback');
  assert.equal(textComponent({ translate: 'count', with: [4, 1.5] }), '4 items, 1.5 weight');
  assert.equal(textComponent({ translate: 'bool' }), 'true');
  assert.equal(getLanguage().entries, 4);
  setLanguage(null); assert.equal(textComponent({ translate: 'joined', with: ['Alex'] }), 'joined');
});

test('native indexed placeholders do not advance the implicit argument cursor, and percent is literal', () => {
  setLanguage({ mixed: '%2$s / %s / %s / %1$s / %%' });
  assert.equal(textComponent({ translate: 'mixed', with: ['A', 'B'] }), 'B / A / B / A / %');
  assert.equal(textComponent({ translate: 'custom', fallback: '%s has %2$s points', with: ['Alex', 7] }), 'Alex has 7 points');
  assert.equal(textComponent({ translate: 'custom', with: ['ignored'] }), 'custom');
  assert.equal(textComponent({ translate: 'chat.type.text', with: [{ text: 'Alex' }, { text: 'Hello' }] }), '<Alex> Hello');
  assert.equal(textComponent({ translate: 'chat.type.announcement', with: ['Server', 'Hello'] }), '[Server] Hello');
});

test('a malformed translation displays the entire raw template without partial substitutions', () => {
  for (const template of ['A %s B %q', '%0$s', '%2$s', '%2147483648$s', '%', '%1$%', '95% good', '% s']) {
    setLanguage({ broken: template });
    assert.equal(textComponent({ translate: 'broken', with: ['argument'] }), template, template);
  }
  setLanguage({ empty: '' }); assert.equal(textComponent({ translate: 'empty', fallback: 'ignored' }), '');
  assert.equal(textComponent({ translate: 'null', fallback: '%s', with: [null] }), 'null');
});

test('NBT component packets, primitive arguments and serialized top-level JSON follow native codecs', () => {
  const packet = { type: 'compound', value: {
    translate: { type: 'string', value: 'joined' },
    with: { type: 'list', value: { type: 'compound', value: [{ text: { type: 'string', value: 'Alex' } }] } },
    extra: { type: 'list', value: { type: 'string', value: ['!', '?'] } },
  } };
  setLanguage({ joined: '%s joined' }); assert.equal(textComponent(packet), 'Alex joined!?');
  assert.equal(textComponent('{"text":"JSON", "extra":["!"]}'), 'JSON!');
  assert.equal(textComponent('"JSON string"'), 'JSON string');
  assert.equal(textComponent({ translate: 'primitive', fallback: '%s %s %s', with: ['{"text":"literal"}', false, 99n] }), '{"text":"literal"} false 99');
  assert.equal(textComponent({ text: 'Parent', extra: ['{"text":"literal"}'] }), 'Parent{"text":"literal"}');
  assert.equal(textComponent({ type: 'string', value: 'Legacy NBT string' }), 'Legacy NBT string');
  assert.equal(textComponent('[broken JSON'), '[broken JSON');
});

test('translation arguments and list children inherit their parent style and can explicitly clear it', () => {
  setLanguage({ greeting: '%s greeted %s.' });
  const segments = textSegments({ translate: 'greeting', color: 'gold', bold: true, with: [{ text: 'Alex', color: 'red' }, { text: 'Steve', bold: false }], extra: [{ text: '!', italic: true }] });
  assert.deepEqual(segments, [
    { text: 'Alex', style: { color: '#ff5555', bold: true } },
    { text: ' greeted ', style: { color: '#ffaa00', bold: true } },
    { text: 'Steve', style: { color: '#ffaa00', bold: false } },
    { text: '.', style: { color: '#ffaa00', bold: true } },
    { text: '!', style: { color: '#ffaa00', bold: true, italic: true } },
  ]);
  assert.deepEqual(textSegments([{ text: 'A', color: '#123456' }, { text: 'B' }, { text: 'C', color: 'white' }]), [
    { text: 'AB', style: { color: '#123456' } }, { text: 'C', style: { color: '#ffffff' } },
  ]);
});

test('legacy formatting affects rendered spans while plain protocol text retains the native string', () => {
  const component = { text: 'A\u00a7cR\u00a7lB\u00a7rZ\u00a7x?', color: 'gold', italic: true };
  const segments = textSegments(component);
  assert.equal(segments.map(part => part.text).join(''), 'ARBZ?');
  assert.equal(segments[1].style.color, '#ff5555'); assert.equal(segments[1].style.italic, false);
  assert.equal(segments[2].style.bold, true);
  assert.deepEqual(segments.at(-1).style, { color: '#ffaa00', italic: true });
  assert.equal(textComponent(component), component.text);
  assert.equal(textSegments('tail\u00a7').map(part => part.text).join(''), 'tail');
});

test('unresolved server-side score, selector and NBT content is empty; explicit contexts can resolve it', () => {
  assert.equal(textComponent({ score: { name: 'Alex', objective: 'points', value: '7' } }), '7');
  assert.equal(textComponent({ score: { name: 'Alex', objective: 'points' } }), '');
  assert.equal(textComponent({ selector: '@a' }), ''); assert.equal(textComponent({ nbt: 'Items[0]', storage: 'test:store' }), '');
  assert.equal(textComponent({ keybind: 'key.forward' }, { resolveKeybind: () => 'W' }), 'W');
  assert.equal(textComponent({ selector: '@a' }, { resolveSelector: () => [{ text: 'Alex' }, ', ', { text: 'Steve' }] }), 'Alex, Steve');
  assert.equal(textComponent({ nbt: 'Items[0]' }, { resolveNbt: () => ({ text: 'Resolved' }) }), 'Resolved');
});

test('cycles, deep components, huge strings and many style changes stay bounded', () => {
  const cyclic = { text: 'Safe' }; cyclic.extra = [cyclic]; assert.equal(textComponent(cyclic), 'Safe');
  const nbtCycle = { type: 'compound' }; nbtCycle.value = nbtCycle; assert.equal(textComponent(nbtCycle), '');
  let deep = { text: 'Too deep' }; for (let i = 0; i < 1000; i++) deep = { extra: [deep] }; assert.equal(textComponent(deep), '');
  assert.equal(textComponent('x'.repeat(200000)).length, 65536);
  const parts = textSegments(Array.from({ length: 50000 }, (_, i) => ({ text: 'X', color: i % 2 ? 'red' : 'gold' })));
  assert.equal(parts.length, 2048);
  const manyEmpty = Array.from({ length: 50000 }, () => ({ text: '' })); manyEmpty.push({ text: 'Past budget' }); assert.equal(textComponent(manyEmpty), '');
});

test('language tables reject nested values and cap stored data without losing imported valid keys', () => {
  const table = { valid: 'Imported', invalid: { text: 'No' }, null: null, oversized: 'a'.repeat(65537), ['k'.repeat(1025)]: 'No' };
  const status = setLanguage(table); assert.equal(status.entries, 1);
  assert.equal(textComponent({ translate: 'valid' }), 'Imported');
  assert.equal(textComponent({ translate: 'invalid' }), 'invalid');
  const bounded = setLanguage({ key: 'value' }, { language: '../../escape' }); assert.equal(bounded.language, 'en_us');
});

test('DOM rendering uses text nodes and validated CSS only, with no click or hover execution', () => {
  const calls = [], element = { ownerDocument: { createElement(tag) { const span = { tag, style: {}, dataset: {}, textContent: '' }; calls.push(span); return span; } }, replaceChildren(...children) { this.children = children; } };
  renderTextComponent(element, { text: '<img src=x onerror=alert(1)>', color: 'url(javascript:evil)', font: 'evil:url()', clickEvent: { action: 'open_url', value: 'javascript:evil' }, extra: [{ text: 'Safe', color: 'green', bold: true }] });
  assert.equal(calls[0].textContent, '<img src=x onerror=alert(1)>'); assert.deepEqual(calls[0].style, {}); assert.deepEqual(calls[0].dataset, {});
  assert.deepEqual(calls[1].style, { color: '#55ff55', fontWeight: 'bold' }); assert.equal(element.children.length, 2);
});
