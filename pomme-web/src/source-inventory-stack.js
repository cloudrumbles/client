import { planSourceInventoryBootstrap } from './source-level-inventory.js';
import { structuredBytes } from '../authority/limits.js';

/** Reuse exactly the inventory save-codec boundary for a source ItemStack.
 * Entity/container callers supply a typed native compound, never preview data.
 * Source identity and any unsupported payload remain available for deferral. */
export function planSourceInventoryStack(record, { registry, componentDecoders = new Map(), version = registry?.version?.minecraftVersion, dataVersion = registry?.version?.dataVersion } = {}) {
  structuredBytes(record, 4 * 1024 * 1024);
  const source = structuredClone(record), entry = source?.type === 10 ? structuredClone(source) : { type: 10, value: {} };
  entry.value.Slot = { type: 1, value: 0 };
  const descriptor = { format: 'java-player-inventory-v1', present: true, version, dataVersion, player: { type: 10, value: {
    SelectedItemSlot: { type: 3, value: 0 }, Inventory: { type: 9, value: { elementType: 10, entries: [entry] } },
  } } };
  const plan = planSourceInventoryBootstrap(descriptor, { registry, componentDecoders });
  if (source?.type !== 10) plan.diagnostics.unshift({ reason: 'Native source item is not a compound.' });
  const result = { stack: plan.player[0], ready: plan.ready, deferred: plan.deferred, diagnostics: plan.diagnostics, source };
  structuredBytes(result, 4 * 1024 * 1024); return result;
}
