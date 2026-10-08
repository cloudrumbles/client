import { renderTextComponent, textComponent } from './text.js';

// AbstractSignEditScreen edits Component.getString(), which intentionally drops
// component styles. SignRenderer retains those styles in the world instead.
export const signPlainMessage = message => textComponent(message);
const DYE_TEXT = Object.freeze({ white: 0xffffff, orange: 16738335, magenta: 0xff00ff, light_blue: 10141901, yellow: 0xffff00, lime: 0xbfff00, pink: 16738740, gray: 0x808080, light_gray: 0xd3d3d3, cyan: 65535, purple: 10494192, blue: 255, brown: 9127187, green: 65280, red: 0xff0000, black: 0 });
export function signTextColor(name = 'black', glowing = false) {
  const color = DYE_TEXT[name] ?? 0;
  return glowing ? color : [16, 8, 0].reduce((result, shift) => result | Math.floor((color >> shift & 255) * .4) << shift, 0);
}

export function signLineWidth(line, glyphs) {
  return Array.from(line).reduce((width, character) => width + (glyphs?.get(character)?.advance ?? glyphs?.get('?')?.advance ?? 6), 0);
}

export function sanitizeSignLine(value, { glyphs = null, hanging = false, maximumCharacters = 384 } = {}) {
  const limit = hanging ? 60 : 90; let output = '', width = 0;
  for (const character of String(value ?? '')) {
    const code = character.codePointAt(0); if (code < 32 || code === 127 || character === '\u00a7') continue;
    const advance = glyphs?.get(character)?.advance ?? glyphs?.get('?')?.advance ?? 6;
    if (output.length + character.length > maximumCharacters || width + advance > limit) break;
    output += character; width += advance;
  }
  return output;
}

const STYLE = `.minecraft-sign-editor{position:fixed;inset:0;z-index:40;background:#07131cb0;display:grid;place-items:center;color:#edf6f4;font:14px system-ui,sans-serif}.minecraft-sign-editor[hidden]{display:none}.minecraft-sign-form{width:min(420px,90vw);max-height:90vh;overflow:auto;box-sizing:border-box;background:#102132fa;border:1px solid #65858f;border-radius:12px;padding:22px;box-shadow:0 24px 80px #0008}.minecraft-sign-form h2{margin:0 0 18px;font-size:20px}.minecraft-sign-form canvas{display:block;width:100%;height:110px;image-rendering:pixelated;background:#94734c;border:5px solid #65492f;margin-bottom:16px;box-sizing:border-box}.minecraft-sign-form input{display:block;box-sizing:border-box;width:100%;margin:6px 0;background:#1a3445;border:1px solid #617f8c;border-radius:4px;color:#fff;font:15px monospace;padding:8px}.minecraft-sign-form label{display:block;font-size:12px;color:#b8ccd5}.minecraft-sign-buttons{display:flex;gap:10px;margin-top:18px}.minecraft-sign-buttons button{flex:1;padding:10px;border:1px solid #658b8a;background:#244946;color:#edf6f4;border-radius:5px;font:inherit;cursor:pointer}`;

export class SignEditor {
  constructor({ session = null, atlas = null, getEntity = () => null, getMaterial = () => null, onClose = () => {}, onCommit = null, document: owner = globalThis.document } = {}) {
    if (!owner?.createElement) throw new Error('SignEditor requires a browser document.');
    this.session = session; this.atlas = atlas; this.getEntity = getEntity; this.getMaterial = getMaterial; this.onClose = onClose; this.onCommit = onCommit; this.document = owner; this.current = null; this.glyphTiles = new Map();
    this.style = owner.createElement('style'); this.style.textContent = STYLE; owner.head.append(this.style);
    this.root = owner.createElement('div'); this.root.className = 'minecraft-sign-editor'; this.root.hidden = true; this.root.setAttribute('role', 'dialog'); this.root.setAttribute('aria-modal', 'true');
    const form = owner.createElement('form'); form.className = 'minecraft-sign-form'; this.root.append(form);
    this.title = owner.createElement('h2'); renderTextComponent(this.title, { translate: 'sign.edit', fallback: 'Edit sign' }); this.title.id = 'minecraft-sign-title'; this.root.setAttribute('aria-labelledby', this.title.id); form.append(this.title);
    this.preview = owner.createElement('canvas'); this.preview.width = 320; this.preview.height = 88; this.preview.setAttribute('aria-hidden', 'true'); form.append(this.preview);
    this.inputs = Array.from({ length: 4 }, (_, line) => {
      const label = owner.createElement('label'); label.textContent = `Line ${line + 1}`; const input = owner.createElement('input'); input.type = 'text'; input.autocomplete = 'off'; input.spellcheck = false; input.maxLength = 384; input.setAttribute('aria-label', `Sign line ${line + 1}`); label.append(input); form.append(label);
      input.addEventListener('input', () => { input.value = sanitizeSignLine(input.value, { glyphs: this.atlas?.fontGlyphs, hanging: this.current?.hanging }); this.render(); });
      input.addEventListener('keydown', event => { if (event.code === 'ArrowDown' || event.code === 'Enter' && line < 3) { event.preventDefault(); this.inputs[(line + 1) % 4].focus(); } else if (event.code === 'ArrowUp') { event.preventDefault(); this.inputs[(line + 3) % 4].focus(); } }); return input;
    });
    const buttons = owner.createElement('div'); buttons.className = 'minecraft-sign-buttons'; form.append(buttons);
    this.done = owner.createElement('button'); this.done.type = 'submit'; renderTextComponent(this.done, { translate: 'gui.done', fallback: 'Done' }); buttons.append(this.done);
    this.cancel = owner.createElement('button'); this.cancel.type = 'button'; renderTextComponent(this.cancel, { translate: 'gui.cancel', fallback: 'Cancel' }); this.cancel.addEventListener('click', () => this.close(false)); buttons.append(this.cancel);
    form.addEventListener('submit', event => { event.preventDefault(); this.close(true); }); owner.body.append(this.root);
  }
  get blocking() { return this.current !== null; }
  setAssets(atlas) {
    this.atlas = atlas; this.glyphTiles.clear(); renderTextComponent(this.title, { translate: 'sign.edit', fallback: 'Edit sign' });
    renderTextComponent(this.done, { translate: 'gui.done', fallback: 'Done' }); renderTextComponent(this.cancel, { translate: 'gui.cancel', fallback: 'Cancel' });
    if (this.blocking) this.render();
  }
  consume(event) { if (event?.type === 'open-sign') return this.open(event); return false; }
  open({ x, y, z, location, isFrontText = true, nbt, material } = {}) {
    const position = location ?? { x, y, z }; if (![position.x, position.y, position.z].every(Number.isInteger)) return false;
    const entity = this.getEntity(position.x, position.y, position.z), data = nbt ?? entity?.nbt ?? {}, block = material ?? this.getMaterial(position.x, position.y, position.z), hanging = block?.name?.includes('hanging_sign') || false;
    if (block?.name && !block.name.endsWith('_sign')) return false;
    if (data.is_waxed || data.IsWaxed) return false;
    const text = isFrontText ? data.front_text : data.back_text, messages = text?.messages ?? (isFrontText ? [data.Text1, data.Text2, data.Text3, data.Text4] : []);
    this.current = { position: { ...position }, isFrontText: Boolean(isFrontText), hanging, color: text?.color ?? data.Color ?? 'black', glowing: Boolean(text?.has_glowing_text ?? data.GlowingText) }; this.root.hidden = false; renderTextComponent(this.title, { translate: 'sign.edit', fallback: 'Edit sign' });
    for (let line = 0; line < 4; line++) this.inputs[line].value = sanitizeSignLine(signPlainMessage(messages[line] ?? ''), { glyphs: this.atlas?.fontGlyphs, hanging });
    this.document.exitPointerLock?.(); this.render(); this.inputs[0].focus(); this.inputs[0].select(); return true;
  }
  render() {
    const context = this.preview.getContext('2d'); if (!context || !this.current) return;
    context.clearRect(0, 0, this.preview.width, this.preview.height); context.imageSmoothingEnabled = false;
    const color = `#${signTextColor(this.current.color, this.current.glowing).toString(16).padStart(6, '0')}`;
    for (let line = 0; line < 4; line++) {
      const text = this.inputs[line].value, glyphs = this.atlas?.fontGlyphs;
      if (!glyphs?.size) { context.fillStyle = color; context.font = '14px monospace'; context.textAlign = 'center'; context.fillText(text, 160, 20 + line * 18); continue; }
      let x = (320 - signLineWidth(text, glyphs) * 2) / 2;
      for (const character of text) {
        const glyph = glyphs.get(character) ?? glyphs.get('?'); if (!glyph) continue;
        if (glyph.tile >= 0 && glyph.width > 0) {
          const tile = this.atlas.tiles[glyph.tile]; let sheet = this.glyphTiles.get(glyph.tile);
          if (!sheet) {
            sheet = this.document.createElement('canvas'); sheet.width = tile.width; sheet.height = tile.height; const pixels = new Uint8ClampedArray(tile.width * tile.height * 4);
            for (let y = 0; y < tile.height; y++) { const start = ((tile.y + y) * this.atlas.width + tile.x) * 4; pixels.set(this.atlas.pixelsRGBA.subarray(start, start + tile.width * 4), y * tile.width * 4); }
            const sheetContext = sheet.getContext('2d'); sheetContext.putImageData(new ImageData(pixels, tile.width, tile.height), 0, 0); this.glyphTiles.set(glyph.tile, sheet);
          }
          const [u, v, U, V] = glyph.uv; context.drawImage(sheet, u * tile.width, v * tile.height, (U - u) * tile.width, (V - v) * tile.height, x, 6 + line * 18, glyph.width * 2, glyph.height * 2);
        }
        x += glyph.advance * 2;
      }
    }
    context.globalCompositeOperation = 'source-in'; context.fillStyle = color; context.fillRect(0, 0, 320, 88); context.globalCompositeOperation = 'source-over';
  }
  key(event) { if (!this.blocking) return false; if (event.code === 'Escape' && event.type !== 'keyup') { event.preventDefault(); this.close(true); } return true; }
  close(commit = true) {
    if (!this.current) return;
    const current = this.current, lines = this.inputs.map(input => sanitizeSignLine(input.value, { glyphs: this.atlas?.fontGlyphs, hanging: current.hanging }));
    this.current = null; this.root.hidden = true;
    if (commit) {
      if (this.session) this.session.packet('update_sign', { location: current.position, isFrontText: current.isFrontText, text1: lines[0], text2: lines[1], text3: lines[2], text4: lines[3] });
      this.onCommit?.({ ...current, lines });
    }
    this.onClose(commit);
  }
  destroy() { this.close(false); this.root.remove(); this.style.remove(); this.glyphTiles.clear(); }
}
