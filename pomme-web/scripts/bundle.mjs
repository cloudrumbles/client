import { readFile, readdir, mkdir, writeFile, stat } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { zipSync, strToU8 } from 'fflate';

const root = fileURLToPath(new URL('../', import.meta.url));
const output = resolve(process.argv[2] ?? `${root}/dist/pomme-browser.zip`);
const files = {};
const excluded = new Set(['target', 'node_modules', 'test-results', 'dist', '.git']);
async function collect(relative) {
  const path = resolve(root, relative), info = await stat(path);
  if (info.isDirectory()) {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      if (!excluded.has(entry.name) && !entry.isSymbolicLink()) await collect(`${relative}/${entry.name}`);
    }
  } else if (info.isFile()) files[`pomme-browser/${relative}`] = new Uint8Array(await readFile(path));
}
for (const required of ['public/core.wasm', 'authority/authority.wasm', 'data/1.20.4-registry.json', 'data/1.21.11-registry.json', 'data/26.1-registry.json', 'vendor/fflate.js']) {
  try { await stat(resolve(root, required)); }
  catch { throw new Error(`Missing ${required}. Run npm run build before bundling.`); }
}
for (const entry of ['index.html', 'src', 'public', 'data', 'vendor', 'scripts', 'licenses', 'core', 'authority', 'tests', 'package.json', 'package-lock.json', 'README.md', 'LIGHTING.md', 'PARITY.md', '.gitignore']) await collect(entry);
for (const entry of ['docs', 'generation']) {
  try { await stat(resolve(root, entry)); } catch { continue; }
  await collect(entry);
}
files['pomme-browser/LICENSE'] = new Uint8Array(await readFile(new URL('../../LICENSE', import.meta.url)));
let commit = 'unknown', modified = null;
try {
  commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  modified = !!execFileSync('git', ['status', '--porcelain', '--', '.'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
} catch {}
files['pomme-browser/BUILD.json'] = strToU8(JSON.stringify({
  builtAt: new Date().toISOString(), commit, modified,
  minecraftVersions: ['1.20.4', '1.21.11', '26.1'], backend: 'Rust/WASM + WebGPU',
  targetHardware: { gpu: 'NVIDIA GeForce GTX 1650 Ti', fps: 60, verified: false },
  assets: 'Load your own Minecraft client JAR or resource-pack ZIP.',
  run: 'node scripts/serve.mjs',
}, null, 2));
await mkdir(dirname(output), { recursive: true });
await writeFile(output, zipSync(files, { level: 9 }));
console.log(`Bundled ${Object.keys(files).length} files: ${output}`);
