import test from 'node:test';
import assert from 'node:assert/strict';
import { BrowserWorld } from '../src/world.js';

class FakeWorker {
  messages = [];
  postMessage(message) { this.messages.push(message); }
  terminate() { this.terminated = true; }
}
function fixture() {
  const originalWorker = globalThis.Worker;
  globalThis.Worker = FakeWorker;
  const core = {
    world_origin_x: () => 0, world_origin_z: () => 0, world_min_y: () => 0,
    world_width: () => 16, world_depth: () => 16, world_height: () => 16,
    world_unload_column: () => true,
  };
  const world = new BrowserWorld({core,renderer:{}});
  const close = () => { world.destroy(); globalThis.Worker = originalWorker; };
  return {world,close};
}
const column = x => ({x,z:0,sections:[]});

test('long exploration keeps no visited-column revision tombstones while advancing the global source token', () => {
  const {world,close} = fixture();
  try {
    for(let x=0;x<10000;x++) {
      const source = column(x); world.sourceChanged(source); world.columns.set(`${x},0`,source);
      world.unload(x,0);
    }
    assert.equal(world.columns.size,0); assert.equal(world.sourceRevisions.size,0);
    assert.equal(world.sourceRevision,20000);
    assert.equal(world.worker.messages.at(-1).type,'unload');
  } finally {close();}
});

test('unload and reload reject an old light response without retaining a tombstone', () => {
  const {world,close} = fixture();
  try {
    world.mode = 'import'; world.registry = {blocks:[]}; world.materialRegistry = {materials:new Map()}; world.startLocalLighting();
    const original = column(0); world.sourceChanged(original); world.columns.set('0,0',original);
    const revision = world.sourceRevision, worker = world.lightingWorker;
    world.lightingInFlight = {id:1,revision,targets:['0,0'],columns:new Map([['0,0',original]]),started:performance.now()};
    world.unload(0,0); assert.equal(world.sourceRevisions.size,0);
    const replacement = column(0); world.sourceChanged(replacement); world.columns.set('0,0',replacement);
    assert.ok(world.sourceRevisions.get('0,0') > revision);
    const applied = []; world.loadLight = (...args) => applied.push(args);
    const result = {x:0,z:0,sky:new Map(),block:new Map()};
    worker.onmessage({data:{type:'light-result',generation:world.generation,id:1,revision,results:[result],elapsedMs:1}});
    assert.equal(applied.length,0); assert.equal(world.lightingMetrics.discardedJobs,1);
    world.lightingInFlight = {id:2,revision:world.sourceRevision,targets:['0,0'],columns:new Map([['0,0',replacement]]),started:performance.now()};
    worker.onmessage({data:{type:'light-result',generation:world.generation,id:2,revision:world.sourceRevision,results:[result],elapsedMs:1}});
    assert.equal(applied.length,1); assert.equal(applied[0][3].column,replacement);
  } finally {close();}
});

test('imported columns outside the near window retire their source token after exact persistence', async () => {
  const {world,close} = fixture();
  try {
    world.mode = 'import';
    const source = column(2); world.sourceChanged(source); world.columns.set('2,0',source); world.importColumnKey = '2,0';
    const saved = []; world.store = {put:async value => saved.push(value),close:async()=>{}};
    await world.flushImportColumn();
    assert.equal(saved[0],source); assert.equal(world.columns.size,0); assert.equal(world.sourceRevisions.size,0); assert.equal(world.sourceRevision,1);
  } finally {close();}
});
