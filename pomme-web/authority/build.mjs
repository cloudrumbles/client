import { spawnSync } from 'node:child_process';
import { copyFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const directory = fileURLToPath(new URL('./', import.meta.url));
for (const args of [['test', '--locked'], ['build', '--locked', '--release', '--target', 'wasm32-unknown-unknown']]) {
  const result = spawnSync('cargo', args, { cwd: directory, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
copyFileSync(new URL('./target/wasm32-unknown-unknown/release/pomme_browser_authority.wasm', import.meta.url), new URL('./authority.wasm', import.meta.url));
console.log('Built authority/authority.wasm');
