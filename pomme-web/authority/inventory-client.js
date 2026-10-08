import { BrowserAuthority } from './client.js';

/** Bounded transport and lifecycle gates shared with the block authority. */
export class InventoryAuthority {
  static async open(options) {
    const authority = new InventoryAuthority(options);
    const { registry, data, worldKey, snapshot, width, height, wasmBytes, wasmUrl } = options;
    try { authority.initial = await authority.transport.request('init', { registry, data, worldKey, snapshot, width, height, wasmBytes, wasmUrl: wasmUrl?.href ?? wasmUrl }); return authority; }
    catch (error) { authority.transport.destroy(); throw error; }
  }
  constructor({ WorkerClass = globalThis.Worker, onEvents, onError } = {}) {
    const InventoryWorker = class { constructor() { return new WorkerClass(new URL('./inventory-worker.js', import.meta.url), { type: 'module' }); } };
    this.transport = new BrowserAuthority({ WorkerClass: InventoryWorker, onEvents, onError });
  }
  get state() { return this.transport.state; }
  async switchGrid(width = 2, height = width) { return (await this.transport.request('switch-grid', { width, height })).state; }
  async setSlot(area, index, stack) { return (await this.transport.request('set-slot', { area, index, stack })).state; }
  async select(slot) { return (await this.transport.request('select', { slot })).state; }
  async click(area, slot, button = 0) { return (await this.transport.request('click', { area, slot, button })).state; }
  async craft(options) { const result = await this.transport.request('craft', options); return { batches: result.value, state: result.state }; }
  async snapshot() { return (await this.transport.request('snapshot')).value; }
  async restore(snapshot) { return (await this.transport.request('restore', { snapshot })).state; }
  async acknowledgeDrops() { return (await this.transport.request('acknowledge-drops')).value; }
  async save() { return (await this.transport.request('save')).value; }
  close(options) { return this.closePromise ??= this.transport.close(options); }
  destroy() { this.transport.destroy(); }
}
