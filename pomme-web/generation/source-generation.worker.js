import init from './pkg/pomme_upstream_generation_wasm.js';
const wasm = await init();
const manifestLength = wasm.generator_manifest_len(), manifestPointer = wasm.generator_manifest_ptr();
const bytes = new Uint8Array(wasm.memory.buffer, manifestPointer, manifestLength);
postMessage({ type: 'ready', manifest: JSON.parse(new TextDecoder().decode(bytes)) });
let busy = false;
const yieldTurn = () => new Promise(resolve => setTimeout(resolve, 0));
self.onmessage = async ({ data }) => {
  if (data.type !== 'generate') return;
  const { id, epoch, worldKey, seed, dimension, x, z, stage = 'surface', budgetMs = 12 } = data;
  if (busy) { postMessage({ type: 'error', id, epoch, worldKey, seed, dimension, message: 'Generation worker already has an active job.' }); return; }
  busy = true;
  try {
    if (!['noise', 'surface'].includes(stage) || !wasm.generator_begin(BigInt(seed), dimension, x, z)) throw new Error('Invalid native generation request.');
    const durations = [], targetStage = stage === 'surface' ? 3 : 2;
    for (let nativeStage = 1; nativeStage <= targetStage; nativeStage++) {
      const before = performance.now();
      if (wasm.generator_advance() !== nativeStage) throw new Error('Native generation stage was rejected.');
      const durationMs = performance.now() - before; durations.push(durationMs);
      postMessage({ type: 'progress', id, epoch, worldKey, seed, dimension, nativeStage, durationMs, exceededBudget: durationMs > budgetMs });
      await yieldTurn();
    }
    const length = wasm.generator_extract();
    if (!length) throw new Error('Native source generation produced no data.');
    const blocks = new Uint16Array(wasm.memory.buffer, wasm.generator_blocks_ptr(), length).slice();
    const biomes = new Uint8Array(wasm.memory.buffer, wasm.generator_biomes_ptr(), wasm.generator_biomes_len()).slice();
    postMessage({ type: 'column', id, epoch, worldKey, seed, dimension, x, z, stage, minY: wasm.generator_min_y(), height: wasm.generator_height(), blocks, biomes, durations }, [blocks.buffer, biomes.buffer]);
  } catch (error) { postMessage({ type: 'error', id, epoch, worldKey, seed, dimension, message: error.message, fatal: error instanceof WebAssembly.RuntimeError }); if (error instanceof WebAssembly.RuntimeError) { self.close(); return; } }
  finally { wasm.generator_cancel(); busy = false; }
};
