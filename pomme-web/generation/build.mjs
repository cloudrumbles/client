import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, readdir, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const directory = fileURLToPath(new URL('./', import.meta.url));
const source = resolve(directory, 'target/source');
const output = resolve(directory, 'pkg');
const archive = 'pumpkin-1.21.11-upstream.tar.gz';
const archiveHash = 'a58c0ac04e2f097d5ffe6f85cba3f1360a17bcdd0de12c6e7fd4fea532cc43a8';
const bindgenVersion = '0.2.129';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const inputs = ['Cargo.toml', 'Cargo.lock', 'rust-toolchain.toml', 'build.rs', 'browser-platform.patch', 'build.mjs', archive];
for (const entry of await readdir(resolve(directory, 'src'), { recursive: true, withFileTypes: true })) {
  if (entry.isFile()) inputs.push(resolve(entry.parentPath, entry.name).slice(directory.length));
}
inputs.sort();
const digest = createHash('sha256');
for (const file of inputs) { digest.update(file); digest.update(await readFile(resolve(directory, file))); }
const inputHash = digest.digest('hex');
if (hash(await readFile(resolve(directory, archive))) !== archiveHash) throw new Error('Pinned Pumpkin source archive checksum does not match.');
const artifacts = ['pomme_upstream_generation_wasm.js', 'pomme_upstream_generation_wasm_bg.wasm'];
if (!process.argv.includes('--rebuild') && !process.argv.includes('--prepare-only')) {
  try {
    const previous = JSON.parse(await readFile(resolve(output, 'BUILD.json')));
    if (previous.inputHash === inputHash && (await Promise.all(artifacts.map(async file => hash(await readFile(resolve(output, file))) === previous.artifacts[file]))).every(Boolean)) {
      console.log('Verified cached native generation WASM. Use --rebuild to compile the corresponding source.');
      process.exit(0);
    }
  } catch {}
}
function run(command, args, cwd = directory) {
  const result = spawnSync(command, args, { cwd, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} exited with status ${result.status}.`);
}
await mkdir(resolve(directory, 'target'), { recursive: true });
await rm(source, { recursive: true, force: true });
await mkdir(source, { recursive: true });
run('tar', ['-xzf', resolve(directory, archive), '-C', source, '--strip-components=1']);
run('git', ['init', '--quiet'], source);
run('git', ['apply', '--unsafe-paths', resolve(directory, 'browser-platform.patch')], source);
if (process.argv.includes('--prepare-only')) { console.log('Prepared exact patched native source.'); process.exit(0); }
run('cargo', ['build', '--locked', '--release', '--target', 'wasm32-unknown-unknown', '--lib']);
let bindgen = process.env.WASM_BINDGEN ?? 'wasm-bindgen';
const version = spawnSync(bindgen, ['--version'], { encoding: 'utf8' });
if (version.status !== 0 && !process.env.WASM_BINDGEN) {
  const tools = resolve(directory, 'target/tools');
  run('cargo', ['install', 'wasm-bindgen-cli', '--locked', '--version', bindgenVersion, '--root', tools]);
  bindgen = resolve(tools, 'bin', process.platform === 'win32' ? 'wasm-bindgen.exe' : 'wasm-bindgen');
} else if (version.stdout?.trim() !== `wasm-bindgen ${bindgenVersion}`) {
  throw new Error(`Native generation requires wasm-bindgen ${bindgenVersion}. Set WASM_BINDGEN to that executable.`);
}
await mkdir(output, { recursive: true });
const target = process.env.CARGO_TARGET_DIR ? resolve(directory, process.env.CARGO_TARGET_DIR) : resolve(directory, 'target');
run(bindgen, ['--target', 'web', '--out-dir', output, resolve(target, 'wasm32-unknown-unknown/release/pomme_upstream_generation_wasm.wasm')]);
const metadata = { minecraftVersion: '1.21.11', sourceCommit: '70b31323967bb99fd4feefab8e96124be369cd6f', upstreamLicense: 'MIT', upstreamArchiveSHA256: archiveHash, stages: ['biomes', 'noise', 'surface'], inputHash, artifacts: {} };
for (const file of artifacts) metadata.artifacts[file] = hash(await readFile(resolve(output, file)));
await writeFile(resolve(output, 'BUILD.json'), JSON.stringify(metadata, null, 2));
console.log('Built native Minecraft 1.21.11 terrain generation WASM.');
