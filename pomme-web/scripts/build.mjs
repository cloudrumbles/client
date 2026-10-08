import { spawnSync } from 'node:child_process';
import { mkdirSync, copyFileSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import minecraftData from 'minecraft-data';
import { writeFileSync } from 'node:fs';
const core = fileURLToPath(new URL('../core/', import.meta.url));
for (const args of [['test', '--locked'], ['build', '--locked', '--release', '--target', 'wasm32-unknown-unknown']]) {
  const result = spawnSync('cargo', args, { cwd: core, stdio: 'inherit' });
  if (result.error) throw new Error(`Cargo unavailable. Install Rust stable and wasm32-unknown-unknown. ${result.error.message}`);
  if (result.status !== 0) process.exit(result.status ?? 1);
}
mkdirSync(new URL('../public/', import.meta.url), { recursive: true });
copyFileSync(new URL('../core/target/wasm32-unknown-unknown/release/pomme_web_core.wasm', import.meta.url), new URL('../public/core.wasm', import.meta.url));
const authorityBuild = spawnSync(process.execPath, [fileURLToPath(new URL('../authority/build.mjs', import.meta.url))], { stdio: 'inherit' });
if (authorityBuild.error) throw authorityBuild.error;
if (authorityBuild.status !== 0) process.exit(authorityBuild.status ?? 1);
mkdirSync(new URL('../data/', import.meta.url), { recursive: true });
mkdirSync(new URL('../vendor/', import.meta.url), { recursive: true });
const blockSounds = JSON.parse(readFileSync(new URL('../src/block-sounds.json', import.meta.url)));
for (const version of ['1.20.4', '1.21.11', '26.1']) {
  const registry = minecraftData(version);
  if (!registry?.protocol) throw new Error(`Missing Minecraft ${version} schema.`);
  writeFileSync(new URL(`../data/${version}-registry.json`, import.meta.url), JSON.stringify({ version: registry.version, blocks: registry.blocksArray, items: registry.itemsArray, entities: registry.entitiesArray, biomes: registry.biomesArray, sounds: registry.soundsArray, particles: registry.particlesArray, effects: registry.effectsArray, blockSounds, collisionShapes: registry.blockCollisionShapes }));
}
copyFileSync(new URL('../node_modules/fflate/esm/browser.js', import.meta.url), new URL('../vendor/fflate.js', import.meta.url));
copyFileSync(new URL('../node_modules/fflate/LICENSE', import.meta.url), new URL('../vendor/fflate.LICENSE', import.meta.url));
copyFileSync(new URL('../licenses/minecraft-data.NOTICE', import.meta.url), new URL('../data/minecraft-data.NOTICE', import.meta.url));
console.log('Built public/core.wasm');
