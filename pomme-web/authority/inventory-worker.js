import { InventoryRuntime } from './inventory.js';
import { InventoryStorage } from './inventory-storage.js';
import { MAX_PENDING_BYTES, MAX_PENDING_REQUESTS, structuredBytes } from './limits.js';
let runtime, storage, worldKey, queue = Promise.resolve(), requests = 0, pendingBytes = 0, closed = false;
async function dispatch(action, args) {
  if (closed) throw new Error('Browser inventory is closed.');
  if (action === 'init') {
    if (runtime) throw new Error('Browser inventory is already initialized.');
    worldKey = args.worldKey; storage = new InventoryStorage(); await storage.open(); storage.key(args.registry?.version?.minecraftVersion, worldKey);
    try {
      runtime = await InventoryRuntime.create(args);
      const saved = args.snapshot ?? await storage.get(runtime.version, worldKey);
      if (saved) runtime.restore(saved);
      return { restored: !!saved, state: runtime.state() };
    } catch (error) { storage.close(); throw error; }
  }
  if (!runtime) throw new Error('Browser inventory is not initialized.');
  const before = runtime.state().revision; let value;
  switch (action) {
    case 'switch-grid': runtime.switchGrid(args.width, args.height); break;
    case 'set-slot': runtime.setSlot(args.area, args.index, args.stack); break;
    case 'select': runtime.select(args.slot); break;
    case 'click': runtime.click(args.area, args.slot, args.button); break;
    case 'craft': value = runtime.craft(args).batches; break;
    case 'state': break;
    case 'snapshot': value = runtime.snapshot(); break;
    case 'restore': runtime.restore(args.snapshot); break;
    case 'acknowledge-drops': value = runtime.acknowledgeDrops(); break;
    case 'save': value = runtime.snapshot(); await storage.put(worldKey, value); break;
    case 'close': if (args.save !== false) await storage.put(worldKey, runtime.snapshot()); storage.close(); closed = true; break;
    default: throw new Error(`Unknown browser inventory action ${action}.`);
  }
  const state = runtime.state(), changed = state.revision !== before;
  return { value, state, events: changed ? [{ type: 'inventory-update', revision: state.revision }] : [] };
}
self.onmessage = ({ data }) => {
  let bytes;
  try {
    bytes = structuredBytes(data.args);
    if (requests >= MAX_PENDING_REQUESTS || pendingBytes + bytes > MAX_PENDING_BYTES) throw new Error('Browser inventory worker queue exceeds its limit.');
  } catch (error) { self.postMessage({ type: 'result', id: data.id, error: error.message }); return; }
  requests++; pendingBytes += bytes;
  queue = queue.then(async () => {
    try { self.postMessage({ type: 'result', id: data.id, result: await dispatch(data.action, data.args ?? {}) }); }
    catch (error) { self.postMessage({ type: 'result', id: data.id, error: error.message }); }
    finally { requests--; pendingBytes -= bytes; }
  });
};
