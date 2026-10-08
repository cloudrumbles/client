import { InventoryRuntime } from './inventory.js';
import { InventoryStorage } from './inventory-storage.js';
import { InventoryItemTransactions } from './inventory-items.js';
import { MAX_PENDING_BYTES, MAX_PENDING_REQUESTS, structuredBytes } from './limits.js';
let runtime, itemTransactions, storage, worldKey, queue = Promise.resolve(), requests = 0, pendingBytes = 0, closed = false;
async function dispatch(action, args) {
  if (closed) throw new Error('Browser inventory is closed.');
  if (action === 'init') {
    if (runtime) throw new Error('Browser inventory is already initialized.');
    worldKey = args.worldKey; storage = new InventoryStorage(); await storage.open(); storage.key(args.registry?.version?.minecraftVersion, worldKey);
    try {
      runtime = await InventoryRuntime.create(args);
      const saved = args.snapshot ?? await storage.get(runtime.version, worldKey);
      if (saved) runtime.restore(saved);
      itemTransactions = new InventoryItemTransactions({ runtime, storage, worldKey, registry: args.registry, worldItems: saved?.worldItems });
      const companion = saved?.worldItems;
      return { restored: !!saved, worldItemsRestored: !!companion && (companion.initialized === true || companion.revision > 0 || companion.tick > 0 || companion.nextId > 1 || companion.items?.length > 0 || companion.deferred?.length > 0), state: runtime.state(), worldItems: itemTransactions.state() };
    } catch (error) { storage.close(); throw error; }
  }
  if (!runtime) throw new Error('Browser inventory is not initialized.');
  const before = runtime.state().revision; let value;
  switch (action) {
    case 'bootstrap-player': runtime.bootstrapPlayer(args.player, args.selected); break;
    case 'switch-grid': runtime.switchGrid(args.width, args.height, args.options); break;
    case 'set-slot': runtime.setSlot(args.area, args.index, args.stack); break;
    case 'select': runtime.select(args.slot); break;
    case 'click': runtime.click(args.area, args.slot, args.button); break;
    case 'menu-click': runtime.menuClick(args.slot, args.options); break;
    case 'craft': value = runtime.craft(args).batches; break;
    case 'state': break;
    case 'snapshot': value = itemTransactions.snapshot(); break;
    case 'restore': {
      const checkpoint = runtime.transactionCheckpoint(), previous = itemTransactions.state();
      try { if (args.snapshot.worldItems !== undefined) itemTransactions.restore(args.snapshot.worldItems); runtime.restore(args.snapshot); }
      catch (error) { runtime.rollbackTransaction(checkpoint); itemTransactions.restore(previous); throw error; }
      break;
    }
    case 'world-items': value = itemTransactions.state(); break;
    case 'world-items-commit': value = await itemTransactions.transaction('commit', args); break;
    case 'world-items-pickup': value = await itemTransactions.transaction('pickup', args); break;
    case 'world-items-drop': value = await itemTransactions.transaction('drop', args); break;
    case 'world-items-deliver': value = await itemTransactions.transaction('deliver', args); break;
    case 'world-items-grid': value = await itemTransactions.transaction('grid', args); break;
    case 'acknowledge-drops': value = runtime.acknowledgeDrops(); break;
    case 'save': value = itemTransactions.snapshot(); await storage.put(worldKey, value); break;
    case 'close': if (args.save !== false) await storage.put(worldKey, itemTransactions.snapshot()); storage.close(); closed = true; break;
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
