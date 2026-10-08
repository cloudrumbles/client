import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeSignLine, signLineWidth } from '../src/sign-editor.js';

const glyphs = new Map([['A', { advance: 6 }], ['i', { advance: 2 }], [' ', { advance: 4 }], ['?', { advance: 6 }], ['😀', { advance: 8 }]]);
test('sign editing enforces native glyph widths for regular/hanging signs without treating Unicode as bytes', () => {
  assert.equal(sanitizeSignLine('A'.repeat(30), { glyphs }), 'A'.repeat(15)); assert.equal(sanitizeSignLine('A'.repeat(30), { glyphs, hanging: true }), 'A'.repeat(10));
  assert.equal(sanitizeSignLine('i'.repeat(90), { glyphs }), 'i'.repeat(45)); assert.equal(signLineWidth('Ai 😀', glyphs), 20); assert.equal(sanitizeSignLine('😀😀', { glyphs, maximumCharacters: 3 }), '😀');
});
test('sign editing filters forbidden control/format characters and keeps spaces/punctuation', () => {
  assert.equal(sanitizeSignLine('A\n\r\t\0\x7f\u00a7 i', { glyphs }), 'A i'); assert.equal(sanitizeSignLine(null, { glyphs }), '');
});
