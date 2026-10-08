import { AuthorityRuntime } from './runtime.js';
import { AuthorityStorage } from './storage.js';
import { MAX_PENDING_REQUESTS, MAX_METADATA_BYTES, structuredBytes, columnMetadata } from './limits.js';
let runtime, storage, worldKey, timer, elapsed = 0, previous = 0, queued = 0;
let chain = Promise.resolve(), metadata = new Map();
const emit = () => ({ events: runtime.events(), state: runtime.state() });
function stop() { clearInterval(timer); timer = null; elapsed = 0; }
function start() {
  if (timer) return;
  previous = performance.now();
  timer = setInterval(() => {
    try {
      const now = performance.now(); elapsed += Math.min(250, Math.max(0, now - previous)); previous = now;
      const ticks = Math.min(5, Math.floor(elapsed / 50)); if (!ticks) return;
      elapsed -= ticks * 50; runtime.step(ticks); postMessage({ type: 'tick', ...emit() });
    } catch (error) { stop(); postMessage({ type: 'failure', message: error.message }); }
  }, 25);
}
function snapshot() { return { ...runtime.snapshot(), metadata: [...metadata.values()] }; }
function restore(saved) {
  const records = saved.metadata ?? [];
  structuredBytes(records, MAX_METADATA_BYTES);
  if (!Array.isArray(records) || records.length > 1024 || records.some(column => !Number.isInteger(column.x) || !Number.isInteger(column.z) || !Array.isArray(column.sections) || column.sections.length > 256 || column.sections.some(section => !Number.isInteger(section.sectionY) || section.biomes && (!(section.biomes instanceof Uint32Array) || section.biomes.length !== 64)))) throw new Error('Invalid saved authority column metadata.');
  runtime.restore(saved); metadata = new Map(records.map(column => [`${column.x},${column.z}`, column]));
}
function sections() {
  return runtime.sections().map(section => ({ ...metadata.get(`${section.x},${section.z}`)?.sections.find(entry => entry.sectionY === section.sectionY), ...section }));
}
function column(x, z) {
  const native = runtime.column(x, z), stored = metadata.get(`${x},${z}`);
  return { ...stored, ...native, sections: native.sections.map(section => ({ ...stored?.sections.find(entry => entry.sectionY === section.sectionY), ...section })) };
}
function loadColumns(columns) {
  if (!Array.isArray(columns) || columns.length > 1024) throw new Error('Invalid authority column batch.');
  const next = new Map(metadata);
  for (const column of columns) {
    const key = `${column.x},${column.z}`, previous = next.get(key), incoming = columnMetadata(column), sectionMetadata = new Map((previous?.sections ?? []).map(section => [section.sectionY, section]));
    for (const section of incoming.sections) sectionMetadata.set(section.sectionY, section);
    next.set(key, { ...previous, ...incoming, sections: [...sectionMetadata.values()] });
  }
  structuredBytes([...next.values()], MAX_METADATA_BYTES);
  for (const column of columns) for (const section of column.sections) runtime.loadSection(column.x, section.sectionY, column.z, section.blocks);
  metadata = next;
}
async function handle({ action, args }) {
  if (action === 'init') {
    stop(); runtime = await AuthorityRuntime.create(args); worldKey = args.worldKey;
    storage = new AuthorityStorage(); await storage.open();
    const saved = args.snapshot ?? await storage.get(runtime.version, worldKey);
    if (saved) restore(saved);
    if (args.autoTick) start();
    return { ...emit(), restored: Boolean(saved) };
  }
  if (!runtime) throw new Error('Browser authority is not initialized.');
  let value;
  switch (action) {
    case 'load-section': loadColumns([{ x: args.x, z: args.z, sections: [{ sectionY: args.sectionY, blocks: args.blocks }] }]); break;
    case 'load-columns': loadColumns(args.columns); break;
    case 'set-block': runtime.setBlock(args.x, args.y, args.z, args.stateId); break;
    case 'use-block': value = runtime.useBlock(args.x, args.y, args.z); break;
    case 'get-block': value = runtime.blockAt(args.x, args.y, args.z); break;
    case 'step': runtime.step(args.ticks); break;
    case 'set-time': runtime.setTime(args.time, args.daylight); break;
    case 'snapshot': value = snapshot(); break;
    case 'restore': restore(args.snapshot); break;
    case 'sections': value = sections(); break;
    case 'columns': value = [...metadata.values()]; break;
    case 'column': value = column(args.x, args.z); break;
    case 'start': start(); break;
    case 'pause': stop(); break;
    case 'save': await storage.put(worldKey, snapshot()); value = { saved: true }; break;
    case 'close': stop(); if (args.save) await storage.put(worldKey, snapshot()); storage.close(); break;
    default: throw new Error(`Unknown browser authority operation: ${action}`);
  }
  return { ...emit(), value };
}
self.onmessage = ({ data }) => {
  if (queued >= MAX_PENDING_REQUESTS) { postMessage({ type: 'result', id: data.id, error: 'Browser authority request queue is full.' }); return; }
  queued++;
  chain = chain.then(async () => {
    try { postMessage({ type: 'result', id: data.id, result: await handle(data) }); }
    catch (error) { postMessage({ type: 'result', id: data.id, error: error.message }); }
    finally { queued--; }
  });
};
