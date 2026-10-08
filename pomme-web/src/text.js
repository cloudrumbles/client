// Minecraft 1.20.4 Language.loadFromJson, TranslatableContents.decomposeTemplate,
// ComponentSerialization.createFromList and StringDecomposer.iterateFormatted.
// Translation data comes from the user's resource packs; none is bundled here.
const MAX_DEPTH = 64, MAX_NODES = 8192, MAX_CHARACTERS = 65536, MAX_SEGMENTS = 2048;
const MAX_LANGUAGE_ENTRIES = 100000, MAX_LANGUAGE_BYTES = 8 * 1024 * 1024;
const NBT_TYPES = new Set(['byte', 'short', 'int', 'long', 'float', 'double', 'string', 'list', 'compound', 'byteArray', 'intArray', 'longArray']);
const COLORS = Object.freeze({ black: '#000000', dark_blue: '#0000aa', dark_green: '#00aa00', dark_aqua: '#00aaaa', dark_red: '#aa0000', dark_purple: '#aa00aa', gold: '#ffaa00', gray: '#aaaaaa', dark_gray: '#555555', blue: '#5555ff', green: '#55ff55', aqua: '#55ffff', red: '#ff5555', light_purple: '#ff55ff', yellow: '#ffff55', white: '#ffffff' });
const COLOR_CODES = Object.keys(COLORS);
const DECORATIONS = Object.freeze({ k: 'obfuscated', l: 'bold', m: 'strikethrough', n: 'underlined', o: 'italic' });
const STYLE_FLAGS = ['bold', 'italic', 'underlined', 'strikethrough', 'obfuscated'];
const EMPTY_STYLE = Object.freeze({});
// These two chat envelopes retain the existing client behavior before import.
const CHAT_ENVELOPES = Object.freeze({ 'chat.type.text': '<%s> %s', 'chat.type.announcement': '[%s] %s' });
let translations = new Map(), currentLanguage = 'en_us', languageRevision = 0;

function entries(value) { return value instanceof Map ? value.entries() : value && typeof value === 'object' && !Array.isArray(value) ? Object.entries(value) : []; }
function languageTable(languages, name) { return languages instanceof Map ? languages.get(name) : languages?.[name]; }

/** Apply English fallback, then the selected imported language. Null clears it. */
export function setLanguage(languages, options = {}) {
  const selected = (typeof options === 'string' ? options : options.language) || 'en_us';
  currentLanguage = /^[a-z0-9_-]{1,32}$/.test(selected) ? selected : 'en_us';
  const next = new Map(); let bytes = 0;
  const english = languageTable(languages, 'en_us'), localized = languageTable(languages, currentLanguage);
  // Accept a flat table as well, which is convenient for a single JSON file.
  const tables = english || localized ? [english, currentLanguage === 'en_us' ? null : localized] : [languages];
  for (const table of tables) for (const [key, value] of entries(table)) {
    if (typeof key !== 'string' || key.length > 1024 || value === null || !['string', 'number', 'boolean'].includes(typeof value)) continue;
    // Vanilla permits %d/%f in language JSON, but components only format %s.
    const text = String(value).replace(/%(\d+\$)?[\d.]*[df]/g, '%$1s');
    if (text.length > MAX_CHARACTERS || (!next.has(key) && next.size >= MAX_LANGUAGE_ENTRIES)) continue;
    const growth = (key.length + text.length - (next.has(key) ? key.length + next.get(key).length : 0)) * 2;
    if (bytes + growth > MAX_LANGUAGE_BYTES) continue;
    next.set(key, text); bytes += growth;
  }
  translations = next; languageRevision++;
  return { language: currentLanguage, entries: next.size, bytes, revision: languageRevision };
}

export function getLanguage() { return { language: currentLanguage, entries: translations.size, revision: languageRevision }; }

/** Normalize a packet's serialized component before embedding it in another. */
export function parseTextComponent(value) {
  const tagged = value && typeof value === 'object' && NBT_TYPES.has(value.type) && Object.hasOwn(value, 'value');
  value = unwrap(value);
  if (!tagged && typeof value === 'string' && value.length <= 1024 * 1024 && /^[\s]*[\[{\"]/.test(value)) { try { return JSON.parse(value); } catch {} }
  return value;
}

/** Native Style.withStyle parent semantics, including explicit false flags. */
export function withTextStyle(value, rawStyle) {
  return { text: '', ...componentStyle(unwrap(rawStyle), EMPTY_STYLE), extra: [parseTextComponent(value)] };
}

/** Native ChatType.Bound/ChatTypeDecoration, including dynamic server types. */
export class MinecraftChatTypes {
  constructor() { this.types = new Map(); }
  clear() { this.types.clear(); }
  loadRegistry(rawCodec) {
    const codec = unwrap(rawCodec), registry = unwrap(codec?.['minecraft:chat_type']);
    if (!registry) return false;
    const list = unwrap(registry.value ?? registry.entries ?? registry);
    if (!Array.isArray(list)) return false;
    const next = new Map();
    for (const rawEntry of list.slice(0, 4096)) {
      const entry = unwrap(rawEntry), id = unwrap(entry?.id), definition = unwrap(entry?.element ?? entry?.value);
      if (Number.isInteger(id) && id >= 0 && id <= 65535 && definition && typeof definition === 'object') next.set(id, definition);
    }
    this.types = next; return true;
  }
  decorate(content, { type = 0, name = '', target = null } = {}) {
    const holder = unwrap(type);
    const definition = typeof holder === 'object' && holder !== null && holder.data ? unwrap(holder.data) : this.types.get(typeof holder === 'object' && holder !== null ? unwrap(holder.chatType ?? holder.id) : holder);
    const decoration = unwrap(definition?.chat), key = unwrap(decoration?.translation_key ?? decoration?.translationKey), parameters = unwrap(decoration?.parameters);
    const values = { content: parseTextComponent(content) ?? { text: '' }, sender: parseTextComponent(name) ?? { text: '' }, target: parseTextComponent(target) ?? { text: '' } };
    if (typeof key !== 'string' || key.length > 1024 || !Array.isArray(parameters) || parameters.length > 16) return { translate: 'chat.type.text', with: [values.sender, values.content] };
    const resolved = [];
    for (const raw of parameters) {
      const parameter = unwrap(raw), parameterName = typeof parameter === 'number' ? ['content', 'sender', 'target'][parameter] : parameter;
      if (!Object.hasOwn(values, parameterName)) return { translate: 'chat.type.text', with: [values.sender, values.content] };
      resolved.push(values[parameterName]);
    }
    return withTextStyle({ translate: key, with: resolved }, unwrap(decoration.style));
  }
}

// Unwrap only real NBT tags, not modern component objects such as type:'text'.
function unwrap(value) {
  const seen = new Set();
  for (let depth = 0; depth < MAX_DEPTH && value && typeof value === 'object' && !Array.isArray(value); depth++) {
    if (!NBT_TYPES.has(value.type) || !Object.hasOwn(value, 'value')) break;
    if (seen.has(value)) return null;
    seen.add(value); value = value.value;
  }
  return value;
}

function color(value) { return typeof value === 'string' ? COLORS[value] || (/^#[0-9a-f]{6}$/i.test(value) ? value.toLowerCase() : null) : null; }
function componentStyle(value, inherited) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return inherited;
  const next = { ...inherited };
  const c = color(unwrap(value.color)); if (c) next.color = c;
  for (const flag of STYLE_FLAGS) { const setting = unwrap(value[flag]); if (typeof setting === 'boolean' || setting === 0 || setting === 1) next[flag] = !!setting; }
  const font = unwrap(value.font); if (typeof font === 'string' && /^[a-z0-9_.-]+:[a-z0-9_./-]{1,128}$/.test(font)) next.font = font;
  return next;
}
function sameStyle(a, b) { return a.color === b.color && a.font === b.font && STYLE_FLAGS.every(flag => a[flag] === b[flag]); }

function templateParts(template, args) {
  const parts = [], pattern = /%(?:(\d+)\$)?([A-Za-z%]|$)/g;
  let previous = 0, argument = 0, match;
  while ((match = pattern.exec(template))) {
    const literal = template.slice(previous, match.index);
    if (literal.includes('%')) return null;
    if (literal) parts.push({ text: literal });
    if (match[0] === '%%') parts.push({ text: '%' });
    else if (match[2] === 's') {
      const index = match[1] === undefined ? argument++ : Number(match[1]) - 1;
      if (!Number.isSafeInteger(index) || index < 0 || index >= args.length) return null;
      parts.push({ argument: args[index] });
    } else return null;
    if (parts.length > MAX_NODES) return null;
    previous = pattern.lastIndex;
  }
  const literal = template.slice(previous);
  if (literal.includes('%')) return null;
  if (literal) parts.push({ text: literal });
  return parts;
}

/** Native component styles and translation arguments, with bounded traversal. */
export function textSegments(input, options = {}) {
  const segments = [], path = new Set(); let nodes = 0, remaining = MAX_CHARACTERS;
  const push = (text, style) => {
    if (!remaining || segments.length >= MAX_SEGMENTS || !text) return;
    text = text.slice(0, remaining); remaining -= text.length;
    const previous = segments.at(-1);
    if (previous && sameStyle(previous.style, style)) previous.text += text;
    else segments.push({ text, style: { ...style } });
  };
  const append = (text, base) => {
    if (options.legacyFormatting === false || !text.includes('\u00a7')) { push(text, base); return; }
    let style = base, start = 0;
    for (let i = 0; i < text.length; i++) if (text[i] === '\u00a7') {
      push(text.slice(start, i), style);
      if (!remaining || segments.length >= MAX_SEGMENTS) return;
      if (i + 1 >= text.length) return;
      const code = text[++i].toLowerCase(), colorIndex = parseInt(code, 16);
      if (/^[0-9a-f]$/.test(code)) {
        style = { ...style, color: COLORS[COLOR_CODES[colorIndex]] };
        for (const flag of STYLE_FLAGS) style[flag] = false;
      } else if (DECORATIONS[code]) style = { ...style, [DECORATIONS[code]]: true };
      else if (code === 'r') style = base;
      start = i + 1;
    }
    push(text.slice(start), style);
  };
  const visit = (raw, inherited, depth, argument = false) => {
    if (depth > MAX_DEPTH || ++nodes > MAX_NODES || !remaining || segments.length >= MAX_SEGMENTS) return;
    const value = unwrap(raw);
    if (value === null || value === undefined) { if (argument) append('null', inherited); return; }
    if (typeof value !== 'object') { append(String(value), inherited); return; }
    if (path.has(value) || ArrayBuffer.isView(value)) return;
    path.add(value);
    if (Array.isArray(value)) {
      // A JSON list copies its first component and appends the remaining ones.
      const parent = componentStyle(unwrap(value[0]), inherited);
      for (const child of value) {
        if (nodes >= MAX_NODES || !remaining || segments.length >= MAX_SEGMENTS) break;
        visit(child, parent, depth + 1);
      }
    } else {
      const style = componentStyle(value, inherited), literal = unwrap(value.text), key = unwrap(value.translate);
      if (literal !== undefined && literal !== null) append(String(literal), style);
      else if (typeof key === 'string') {
        const fallback = unwrap(value.fallback), template = (translations.get(key) ?? (typeof fallback === 'string' ? fallback : CHAT_ENVELOPES[key] ?? key)).slice(0, MAX_CHARACTERS);
        const rawArgs = unwrap(value.with), args = Array.isArray(rawArgs) ? rawArgs : [];
        const parts = templateParts(template, args);
        if (!parts) append(template, style);
        else for (const part of parts) {
          if (nodes >= MAX_NODES || !remaining || segments.length >= MAX_SEGMENTS) break;
          if (Object.hasOwn(part, 'text')) append(part.text, style);
          else visit(part.argument, style, depth + 1, true);
        }
      } else {
        const keybind = unwrap(value.keybind), score = unwrap(value.score), selector = unwrap(value.selector), nbt = unwrap(value.nbt);
        if (typeof keybind === 'string') append(String(options.resolveKeybind?.(keybind) ?? translations.get(keybind) ?? keybind), style);
        else if (score && typeof score === 'object') {
          const resolved = options.resolveScore?.(score) ?? unwrap(score.value); if (resolved !== undefined && resolved !== null) append(String(resolved), style);
        } else if (typeof selector === 'string' && options.resolveSelector) visit(options.resolveSelector(selector, value), style, depth + 1);
        else if (typeof nbt === 'string' && options.resolveNbt) visit(options.resolveNbt(nbt, value), style, depth + 1);
      }
      const extra = unwrap(value.extra); if (Array.isArray(extra)) for (const child of extra) {
        if (nodes >= MAX_NODES || !remaining || segments.length >= MAX_SEGMENTS) break;
        visit(child, style, depth + 1);
      }
    }
    path.delete(value);
  };
  // Serialized packet components are JSON strings. Strings inside a component
  // or a translation's primitive arguments stay literal, as in the native codec.
  input = parseTextComponent(input);
  visit(input, EMPTY_STYLE, 0);
  return segments;
}

/** Preserve the existing plain-text API used by protocol, HUD and menus. */
export function textComponent(value, options = {}) { return textSegments(value, { ...options, legacyFormatting: false }).map(segment => segment.text).join(''); }

/** Render imported/server text without HTML, script, URL or font injection. */
export function renderTextComponent(element, value, options = {}) {
  const segments = textSegments(value, options), document = element.ownerDocument;
  const children = segments.map(({ text, style }) => {
    const span = document.createElement('span'); span.textContent = text;
    if (style.color) span.style.color = style.color;
    if (style.bold !== undefined) span.style.fontWeight = style.bold ? 'bold' : 'normal';
    if (style.italic !== undefined) span.style.fontStyle = style.italic ? 'italic' : 'normal';
    if (style.underlined !== undefined || style.strikethrough !== undefined) span.style.textDecoration = [style.underlined ? 'underline' : '', style.strikethrough ? 'line-through' : ''].filter(Boolean).join(' ') || 'none';
    if (style.obfuscated) span.dataset.obfuscated = 'true';
    if (style.font) span.dataset.minecraftFont = style.font;
    return span;
  });
  element.replaceChildren(...children); return segments;
}
