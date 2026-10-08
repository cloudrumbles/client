// Reads a privately decompiled, mapped native Items.java. No native source is
// copied into the distribution; this emits registry resource identifiers only.
import { readFile, writeFile } from 'node:fs/promises';
const entries = [];
for (const argument of process.argv.slice(2)) {
  const split = argument.indexOf('=');
  if (split < 1) throw new Error('Usage: node extract-remainders.mjs <version>=<Items.java> ...');
  const version = argument.slice(0, split), source = await readFile(argument.slice(split + 1), 'utf8'), names = new Map(), remainders = [];
  for (const match of source.matchAll(/public static final Item (\w+) = Items\.registerItem\("([a-z0-9_]+)"[^;]*;/g)) names.set(match[1], match[2]);
  for (const match of source.matchAll(/public static final Item (\w+) = Items\.registerItem\("([a-z0-9_]+)"[^;]*?\.craftRemainder\((\w+)\)[^;]*;/g)) {
    const target = names.get(match[3]); if (!target) throw new Error(`Unknown native remainder field ${match[3]}`);
    remainders.push([`minecraft:${match[2]}`, `minecraft:${target}`]);
  }
  if (!remainders.length) throw new Error(`No native remainder declarations found for ${version}`);
  entries.push([version, Object.fromEntries(remainders)]);
}
await writeFile(new URL('../native-remainders.js', import.meta.url), `// Generated resource identifiers from mapped native Items registrations.\n// Regenerate with authority/scripts/extract-remainders.mjs; see inventory README.\nexport const nativeRemainders = ${JSON.stringify(Object.fromEntries(entries), null, 2)};\n`);
