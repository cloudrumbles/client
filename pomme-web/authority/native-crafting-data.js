import { unzipSync } from '../vendor/fflate.js';
import { nativeRemainders } from './native-remainders.js';
const decode = new TextDecoder(), resource = value => value.includes(':') ? value : `minecraft:${value}`;

/** Read recipe/tag data from the user's matching original Java client JAR. */
export async function loadNativeCraftingData(input, { registry, remainders = nativeRemainders[registry?.version?.minecraftVersion] } = {}) {
  if (!registry?.items?.length || !remainders) throw new Error('Native inventory data requires verified remainder registrations for this Minecraft version.');
  const bytes = input instanceof Uint8Array ? input : input instanceof ArrayBuffer ? new Uint8Array(input) : new Uint8Array(await input.arrayBuffer());
  if (bytes.byteLength > 256 * 1024 * 1024) throw new Error('Native crafting JAR exceeds its file size limit.');
  let inflated = 0;
  const archive = unzipSync(bytes, { filter(entry) {
    const wanted = entry.name === 'version.json' || /^data\/[a-z0-9_.-]+\/(?:recipes?\/.*\.json|tags\/items?\/.*\.json)$/.test(entry.name);
    if (!wanted) return false;
    if (entry.name.split('/').includes('..') || entry.originalSize > 1024 * 1024 || (inflated += entry.originalSize) > 16 * 1024 * 1024) throw new Error('Native crafting archive exceeds its data limit.');
    return true;
  } });
  if (!archive['version.json']) throw new Error('Native crafting requires the matching original Java client JAR with version.json.');
  const version = JSON.parse(decode.decode(archive['version.json'])).id;
  if (version !== registry.version.minecraftVersion) throw new Error(`Native crafting JAR ${version} differs from registry ${registry.version.minecraftVersion}.`);
  const items = new Map(registry.items.map(item => [`minecraft:${item.name}`, item.id])), tags = new Map(), resolved = new Map();
  for (const [path, bytes] of Object.entries(archive)) {
    const match = /^data\/([^/]+)\/tags\/items?\/(.+)\.json$/.exec(path);
    if (match) tags.set(`${match[1]}:${match[2]}`, JSON.parse(decode.decode(bytes)).values);
  }
  function tag(name, visiting = new Set(), depth = 0) {
    if (depth > 32 || visiting.has(name)) throw new Error(`Cyclic or oversized native item tag ${name}.`);
    if (resolved.has(name)) return resolved.get(name);
    const values = tags.get(name); if (!Array.isArray(values)) throw new Error(`Missing native item tag ${name}.`);
    visiting.add(name); const ids = new Set();
    for (const entry of values) {
      const value = typeof entry === 'string' ? entry : entry?.id;
      if (typeof value !== 'string') throw new Error(`Invalid native item tag entry in ${name}.`);
      const ref = resource(value.startsWith('#') ? value.slice(1) : value);
      if (entry?.required === false && (value.startsWith('#') ? !tags.has(ref) : !items.has(ref))) continue;
      for (const id of value.startsWith('#') ? tag(ref, visiting, depth + 1) : [items.get(ref)]) {
        if (!Number.isInteger(id)) throw new Error(`Unknown native item ${ref}.`);
        ids.add(id); if (ids.size > 4096) throw new Error('Native crafting ingredient exceeds its item limit.');
      }
    }
    visiting.delete(name); const result = [...ids].sort((a, b) => a - b); resolved.set(name, result); return result;
  }
  function ingredient(value) {
    if (Array.isArray(value)) return [...new Set(value.flatMap(ingredient))].sort((a, b) => a - b);
    const key = typeof value === 'string' ? value : value?.tag ? `#${value.tag}` : value?.item;
    if (typeof key !== 'string') throw new Error('Unknown native crafting ingredient format.');
    if (key.startsWith('#')) return tag(resource(key.slice(1)));
    const id = items.get(resource(key)); if (!Number.isInteger(id)) throw new Error(`Unknown native crafting item ${key}.`); return [id];
  }
  const recipes = [], unsupported = [];
  for (const path of Object.keys(archive).sort()) {
    const match = /^data\/([^/]+)\/recipes?\/(.+)\.json$/.exec(path); if (!match) continue;
    const native = JSON.parse(decode.decode(archive[path])), id = `${match[1]}:${match[2]}`, type = native.type?.replace('minecraft:', '');
    if (type !== 'crafting_shaped' && type !== 'crafting_shapeless') { if (type?.startsWith('crafting_')) unsupported.push({ id, type }); continue; }
    let width = 1, height = 1, ingredients;
    if (type === 'crafting_shaped') {
      if (!Array.isArray(native.pattern) || native.pattern.length < 1 || native.pattern.length > 3 || native.pattern.some(row => typeof row !== 'string' || row.length < 1 || row.length > 3 || row.length !== native.pattern[0].length)) throw new Error(`Invalid native shaped pattern ${id}.`);
      const pattern = native.pattern, cells = pattern.flatMap((row, y) => [...row].flatMap((char, x) => char === ' ' ? [] : [{ x, y }]));
      if (!cells.length) throw new Error(`Empty native shaped pattern ${id}.`);
      const left = Math.min(...cells.map(cell => cell.x)), right = Math.max(...cells.map(cell => cell.x)), top = Math.min(...cells.map(cell => cell.y)), bottom = Math.max(...cells.map(cell => cell.y));
      width = right - left + 1; height = bottom - top + 1;
      ingredients = [];
      for (let y = top; y <= bottom; y++) for (let x = left; x <= right; x++) {
        const char = pattern[y][x]; ingredients.push(char === ' ' ? [] : ingredient(native.key?.[char]));
      }
    } else {
      if (!Array.isArray(native.ingredients)) throw new Error(`Invalid native shapeless ingredients ${id}.`);
      ingredients = native.ingredients.map(ingredient);
    }
    if (!ingredients.length || ingredients.length > 9) throw new Error(`Native recipe exceeds grid bounds ${id}.`);
    const result = native.result, name = typeof result === 'string' ? result : result?.id ?? result?.item, itemId = typeof name === 'string' ? items.get(resource(name)) : undefined;
    if (!Number.isInteger(itemId)) throw new Error(`Unknown native crafting result ${id}.`);
    recipes.push({ id, type, width, height, ingredients, result: { present: true, itemId, itemCount: typeof result === 'string' ? 1 : result.count ?? 1,
      ...(result.components ? { components: Object.entries(result.components).map(([type, data]) => ({ type, data })) } : {}) } });
    if (recipes.length > 8192) throw new Error('Native crafting recipe count exceeds its limit.');
  }
  const remainderIds = new Map();
  for (const [from, to] of Object.entries(remainders)) {
    const source = items.get(resource(from)), target = items.get(resource(to));
    if (!Number.isInteger(source) || !Number.isInteger(target)) throw new Error(`Unknown native crafting remainder ${from} -> ${to}.`);
    remainderIds.set(source, target);
  }
  return { version, recipes, remainders: remainderIds, unsupported, source: 'user-provided native Java client JAR' };
}
