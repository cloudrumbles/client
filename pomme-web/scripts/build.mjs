import { spawnSync } from 'node:child_process';
import { mkdirSync, copyFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const core = fileURLToPath(new URL('../core/', import.meta.url));
for (const args of [['test', '--locked'], ['build', '--locked', '--release', '--target', 'wasm32-unknown-unknown']]) {
  const result = spawnSync('cargo', args, { cwd: core, stdio: 'inherit' });
  if (result.error) throw new Error(`Cargo unavailable. Install Rust stable and wasm32-unknown-unknown. ${result.error.message}`);
  if (result.status !== 0) process.exit(result.status ?? 1);
}
mkdirSync(new URL('../public/', import.meta.url), { recursive: true });
copyFileSync(new URL('../core/target/wasm32-unknown-unknown/release/pomme_web_core.wasm', import.meta.url), new URL('../public/core.wasm', import.meta.url));
console.log('Built public/core.wasm');
