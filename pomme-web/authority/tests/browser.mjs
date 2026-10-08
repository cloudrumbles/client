import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';
const errors = [];
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] });
try {
  const page = await browser.newPage(); page.on('pageerror', error => errors.push(error.message));
  await page.goto(new URL('/authority/runtime.js', process.env.POMME_URL ?? 'http://127.0.0.1:5173').href);
  const result = await page.evaluate(async () => {
    const [{ BrowserAuthority }, { registryStates }] = await Promise.all([import('/authority/client.js'), import('/src/anvil.js')]);
    const registry = await (await fetch('/data/1.21.11-registry.json')).json(), native = registryStates(registry), changes = [];
    const check = (value, message) => { if (!value) throw new Error(message); };
    const stone = registry.blocks.find(block => block.name === 'stone').defaultState;
    const lamp = native.lookup('redstone_lamp', { lit: 'false' }), lit = native.lookup('redstone_lamp', { lit: 'true' });
    const off = native.lookup('stone_button', { face: 'floor', facing: 'north', powered: 'false' }), on = native.lookup('stone_button', { face: 'floor', facing: 'north', powered: 'true' });
    const key = `browser-proof-${crypto.randomUUID()}`;
    let authority = await BrowserAuthority.open({ registry, worldKey: key, onEvents: events => changes.push(...events) });
    let bridgeProof;
    try {
      const blocks = new Uint16Array(4096); blocks.fill(stone, 0, 256);
      const biomes = new Uint32Array(64).fill(registry.biomes.find(biome => biome.name === 'plains').id);
      await authority.loadColumns([{ x: 0, z: 0, sections: [{ sectionY: 0, blocks, biomes }], blockEntities: [{ x: 8, y: 1, z: 8, nbt: { id: 'minecraft:chest' } }] }]);
      check(await authority.useBlock(0, 0, 0) === false, 'Unsupported use returns false so normal placement can continue.');
      await authority.setBlock(2, 1, 2, off); await authority.setBlock(3, 1, 2, lamp); await authority.useBlock(2, 1, 2); await authority.step(7);
      check(await authority.blockAt(2, 1, 2) === on, 'Worker must own the pressed native button.'); check(await authority.blockAt(3, 1, 2) === lit, 'Worker must immediately light adjacent lamp.');
      const initial = { age: String(authority.state.age), pendingTicks: authority.state.pendingTicks, events: changes.length };
      await authority.close(); authority = await BrowserAuthority.open({ registry, worldKey: key, onEvents: events => changes.push(...events) });
      check(authority.initial.restored && authority.state.age === 7n && authority.state.pendingTicks === 1, 'IndexedDB must restore world clock and pending scheduled tick.');
      await authority.step(12); check(await authority.blockAt(2, 1, 2) === on, 'Saved button delay must not restart or expire early.'); await authority.step();
      check(await authority.blockAt(2, 1, 2) === off && await authority.blockAt(3, 1, 2) === lit, 'Button releases on native tick 20; lamp retains its delayed turnoff.');
      await authority.step(4); check(await authority.blockAt(3, 1, 2) === lamp, 'Lamp must turn off after its native four ticks.');
      const count = changes.length; await authority.step(100); check(changes.length === count, 'Unchanging blocks must emit no redundant renderer mutations.');
      const columns = await authority.columns(); check(columns.length === 1 && columns[0].sections[0].blocks.length === 4096, 'Renderer bridge receives restored native sections.');
      check(columns[0].sections[0].biomes[0] === biomes[0] && columns[0].blockEntities[0].nbt.id === 'minecraft:chest', 'Native biome and block entity metadata must survive reopen.');
      await authority.start(); await new Promise(resolve => setTimeout(resolve, 165)); await authority.pause(); check(authority.state.age >= 127n, 'Actual browser timer must drive the WASM authority at 20 Hz.');
      const final = { age: String(authority.state.age), pendingTicks: authority.state.pendingTicks, sections: authority.state.sections };
      const eventCount = changes.length, queued = authority.setBlock(4, 1, 2, stone), closed = authority.close();
      await Promise.all([queued, closed]); check(changes.length === eventCount, 'Closing must immediately gate pending old-world events.');
      const [{ BrowserWorld }, { AuthorityWorldBridge }] = await Promise.all([import('/src/world.js'), import('/authority/bridge.js')]);
      const worldKey = `${key}-bridge`, wasm = await (await fetch('/public/core.wasm')).arrayBuffer();
      const makeWorld = async () => {
        const core = (await WebAssembly.instantiate(wasm, {})).instance.exports;
        const world = new BrowserWorld({ core, renderer: { removeChunk() {}, configureWorld() {}, uploadChunk() {} }, onError: error => { throw error; } });
        await world.reset({ registry, minY: 0, height: 64, width: 4, depth: 4, originX: 0, originZ: 0, worldKey, mode: 'import' }); return world;
      };
      const nativeSky = new Uint8Array(2048).fill(0xee), nativeBlock = new Uint8Array(2048).fill(0x11);
      const nativeLight = { sky: new Map([[0, nativeSky]]), block: new Map([[0, nativeBlock]]) };
      const columnA = { x: 0, z: 0, light: nativeLight, sections: [{ sectionY: 0, blocks: blocks.slice(), biomes, skyLight: nativeSky, blockLight: nativeBlock }], heightmaps: { testSourceMetadata: true } }, columnB = { x: 1, z: 0, sections: [{ sectionY: 0, blocks: blocks.slice(), biomes }] };
      let world = await makeWorld(), bridge = await AuthorityWorldBridge.open({ world, registry, minY: 0, height: 64, worldKey, columns: [columnA] });
      try {
        check(world.columns.get('0,0').sections[0].skyLight === nativeSky && world.columns.get('0,0').sections[0].blockLight === nativeBlock && world.columns.get('0,0').light === nativeLight, 'Initial authority attachment must preserve original native light arrays.');
        check(world.columns.get('0,0').heightmaps.testSourceMetadata, 'Source metadata remains available after authority attachment.');
        await bridge.setBlock(5, 1, 5, stone); check(world.core.block_get(5, 1, 5) === stone, 'Accepted authority edits must reach the real renderer WASM world.');
        await bridge.close(); world.destroy(); world = await makeWorld();
        const added = { x: 0, z: 0, sections: [{ sectionY: 1, blocks: blocks.slice(), biomes }] };
        world.setOverlay([[5, 1, 5, 0], [2, 48, 2, stone]]);
        const retired = [];
        bridge = await AuthorityWorldBridge.open({ world, registry, minY: 0, height: 64, worldKey, columns: [columnA, columnB, added], onRetireOverlays: edits => retired.push(...edits) });
        check(world.core.block_get(5, 1, 5) === stone, 'Reimported original sections must retain saved authoritative edits.');
        check(retired.length === 1 && retired[0][0] === 5 && world.overlays.get('0,0').has('2,48,2'), 'Covered stale overlays must retire while unrelated out-of-scope overlays survive.');
        check(world.core.block_get(21, 0, 5) === stone && world.core.block_get(5, 16, 5) === stone, 'Unrelated newly imported columns and sections must remain loaded.');
        await bridge.loadColumn(columnA); check(world.core.block_get(5, 1, 5) === stone, 'Incremental import must also retain existing authoritative edits.');
        check(await bridge.useBlock(5, 0, 5) === false, 'Bridge preserves right-click placement fallback on unsupported ordinary blocks.');
        check(bridge.sources.size === 0, 'Bridge must not retain full source columns after bootstrap.');
        bridgeProof = { realBrowserWorld: true, nativeWasmMirror: true, restoredEditPreserved: true, unrelatedSectionsPreserved: true, nativeLightPreserved: true, staleCoveredOverlaysRetired: true, outsideOverlaysPreserved: true, sourceColumnRetention: 0, columns: (await bridge.authority.columns()).length };
        await bridge.close(); world.destroy(); world = await makeWorld();
        bridge = await AuthorityWorldBridge.open({ world, registry, minY: 0, height: 64, worldKey: `${worldKey}-limited`, columns: [columnA, columnB, added], maxSections: 1 });
        check(bridge.stats().sections === 1 && !bridge.stats().complete, 'Authority residency is explicit and bounded.');
        check(world.core.block_get(21, 0, 5) === stone && world.core.block_get(5, 16, 5) === stone, 'A full authority scope must preserve every unrelated imported section.');
        const outside = await bridge.setBlock(21, 1, 5, stone); check(outside.handled === false && await bridge.useBlock(21, 1, 5) === false, 'Out-of-scope edits and uses explicitly permit the existing import fallback.');
        bridgeProof.partialScopePreservesImports = true; bridgeProof.outOfScopeFallback = true;
      } finally { await bridge.close(); world.destroy(); }
      return { validation: 'passed', backend: 'Browser Worker + Rust/WASM + IndexedDB', nativeVersion: registry.version.minecraftVersion, initial, final, changedStates: changes.map(event => event.stateId), nativeProcessRequired: false, unchangedBlocksEmitNoChanges: true, metadataPersisted: true, closedEventsSuppressed: true, bridge: bridgeProof };
    } finally { await authority.close(); }
  });
  assert.deepEqual(errors, []); await mkdir('test-results', { recursive: true }); await writeFile('test-results/browser-authority.json', JSON.stringify(result, null, 2)); console.log(JSON.stringify(result, null, 2));
} finally { await browser.close(); }
