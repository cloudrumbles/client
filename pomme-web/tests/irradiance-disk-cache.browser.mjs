import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';

const profile = await mkdtemp(join(tmpdir(), 'pomme-irradiance-disk-')), errors = [], measurements = [];
let context;
const launch = async () => {
  context = await chromium.launchPersistentContext(profile, { executablePath: process.env.CHROMIUM_PATH ?? '/usr/bin/chromium', headless: true,
    args: ['--no-sandbox', '--disable-gpu'] });
  const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
  await page.route('**/__irradiance-disk-proof', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Lighting disk cache proof</title>' }));
  await page.goto(new URL('/__irradiance-disk-proof', process.env.POMME_URL ?? 'http://127.0.0.1:5173').href);
  await page.evaluate(async () => {
    const workerText = `import { IrradianceDiskCache } from '${location.origin}/src/irradiance-disk-cache.js';
      let cache, release, gated=false;const wait=new Promise(resolve=>release=resolve), originalPut=IDBObjectStore.prototype.put;let fail=false;
      IDBObjectStore.prototype.put=function(...args){if(fail&&this.name==='angles'){fail=false;throw new DOMException('Injected quota failure','QuotaExceededError');}return originalPut.apply(this,args);};
      const request=value=>new Promise((resolve,reject)=>{value.onsuccess=()=>resolve(value.result);value.onerror=()=>reject(value.error);});
      const done=transaction=>new Promise((resolve,reject)=>{transaction.oncomplete=resolve;transaction.onerror=transaction.onabort=()=>reject(transaction.error);});
      onmessage=async event=>{const {id,action,args=[]}=event.data;try{let result;
        if(action==='init'){cache=new IrradianceDiskCache({maxContexts:2,maxAngles:3,maxEntries:6,crypto:{subtle:{digest:async(...args)=>{if(gated)await wait;return crypto.subtle.digest(...args);}}}});result=true;}
        else if(action==='gate'){gated=true;result=true;}
        else if(action==='release'){gated=false;release();result=true;}
        else if(action==='fail'){fail=true;result=true;}
        else if(action==='status'){result={closed:cache.closed,...cache.stats()};}
        else if(action==='inspect'){const db=await cache.open(),tx=db.transaction(['sources','sourceMetadata','angles','angleMetadata','budget']),completed=done(tx);result=await Promise.all(['sources','sourceMetadata','angles','angleMetadata','budget'].map(name=>request(tx.objectStore(name).getAll())));await completed;}
        else if(action==='tamper'){const db=await cache.open(),tx=db.transaction('angles','readwrite'),completed=done(tx),store=tx.objectStore('angles'),record=await request(store.get(args));record.entry.rgb[0]^=1;store.put(record);await completed;result=true;}
        else result=await cache[action](...args);
        postMessage({id,result});}catch(error){postMessage({id,error:String(error.stack??error)});}};`;
    const p = window.proof = { workers: [], nextId: 0, requests: new Map(), workerUrl: URL.createObjectURL(new Blob([workerText], { type: 'application/javascript' })) };
    p.worker = async () => { const worker = new Worker(p.workerUrl, { type: 'module' }); p.workers.push(worker);
      worker.onmessage = ({ data }) => { const request = p.requests.get(data.id); p.requests.delete(data.id); if (data.error) request.reject(new Error(data.error)); else request.resolve(data.result); };
      worker.onerror = event => { for (const request of p.requests.values()) request.reject(new Error(event.message)); p.requests.clear(); };
      await p.call(worker, 'init'); return worker; };
    p.call = (worker, action, ...args) => new Promise((resolve, reject) => { const id = ++p.nextId; p.requests.set(id, { resolve, reject }); worker.postMessage({ id, action, args }); });
    p.value = (angle = 0, runs = false) => { const cells = 4096, localData = new Uint16Array(cells * 4), alpha = new Uint16Array(cells);
      for (let cell = 0; cell < cells; cell++) { localData.set([cell & 1 ? 0x3000 : 0, 0x3400, 0x3800, 0x3800], cell * 4); alpha[cell] = cell & 1 ? 0 : 0x3c00; }
      const entry = runs ? { rgb: Uint16Array.of(angle, 0x3000, 0x3400), lengths: Uint32Array.of(cells) } : { rgb: Uint16Array.from({ length: cells * 3 }, (_, at) => (at + angle) % 0x3801) };
      entry.bytes = entry.rgb.byteLength + (entry.lengths?.byteLength ?? 0); return { localData, alpha, entry, stats: { cells, algorithm: 'browser exact fixture' } }; };
    p.equal = (left, right) => left?.length === right?.length && left.every((value, index) => value === right[index]);
    p.assertValue = (actual, expected) => {
      if (!actual || !p.equal(actual.localData, expected.localData) || !p.equal(actual.alpha, expected.alpha) || !p.equal(actual.entry.rgb, expected.entry.rgb)
        || Boolean(actual.entry.lengths) !== Boolean(expected.entry.lengths) || actual.entry.lengths && !p.equal(actual.entry.lengths, expected.entry.lengths)) throw new Error('Persisted lighting bits differ.'); };
    p.accounting = state => { const [sources, metadata, angles, angleMetadata, [budget]] = state;
      if (sources.length !== budget.contexts || metadata.length !== budget.contexts || angles.length !== budget.entries || angleMetadata.length !== budget.entries
        || budget.bytes !== metadata.reduce((sum, value) => sum + value.bytes, 0) + angleMetadata.reduce((sum, value) => sum + value.bytes, 0)
        || budget.bytes > 64 * 1024 * 1024 || budget.contexts > 2 || budget.entries > 6) throw new Error('Actual IndexedDB accounting is inconsistent.');
      return { contexts: budget.contexts, entries: budget.entries, bytes: budget.bytes }; };
    p.a = await p.worker(); p.b = await p.worker();
    p.key = ordinal => ordinal.toString(16).padStart(64, '0');
  }); return page;
};
try {
  let page = await launch();
  const first = await page.evaluate(async () => {
    const p = window.proof, record = p.value(0), results = await Promise.all([p.call(p.a, 'put', p.key(1), 0, record), p.call(p.b, 'put', p.key(1), 1, p.value(1, true))]);
    if (!results.every(value => value?.persisted) || results.reduce((sum, value) => sum + value.bytes, 0) !== record.localData.byteLength + record.alpha.byteLength + record.entry.bytes + p.value(1, true).entry.bytes) throw new Error('Concurrent workers must store shared lighting only once.');
    await p.call(p.a, 'put', p.key(1), 2, p.value(2)); p.assertValue(await p.call(p.b, 'get', p.key(1), 0), record);
    await p.call(p.b, 'put', p.key(1), 3, p.value(3)); if (await p.call(p.a, 'get', p.key(1), 1)) throw new Error('Native IndexedDB per-source LRU did not evict the untouched angle.');
    await p.call(p.a, 'put', p.key(2), 0, record); await p.call(p.b, 'get', p.key(1), 0); await p.call(p.b, 'put', p.key(3), 0, record);
    if (await p.call(p.a, 'get', p.key(2), 0)) throw new Error('Cross-worker source touch must order context eviction.');
    const before = p.accounting(await p.call(p.a, 'inspect')); await p.call(p.a, 'fail'); if (await p.call(p.a, 'put', p.key(4), 0, record)) throw new Error('Injected quota failure must return a cache miss.');
    const after = p.accounting(await p.call(p.a, 'inspect')); if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error('Failed actual IndexedDB write changed accounting.');
    p.assertValue(await p.call(p.b, 'get', p.key(1), 0), record); p.assertValue(await p.call(p.b, 'get', p.key(3), 0), record);
    const save = indexedDB.open('native-authority-cache-proof', 1); save.onupgradeneeded = () => save.result.createObjectStore('worlds');
    const database = await new Promise((resolve, reject) => { save.onsuccess = () => resolve(save.result); save.onerror = () => reject(save.error); });
    const transaction = database.transaction('worlds', 'readwrite'); transaction.objectStore('worlds').put({ blocks: 'keep', inventory: 'keep' }, 'world');
    await new Promise((resolve, reject) => { transaction.oncomplete = resolve; transaction.onabort = transaction.onerror = () => reject(transaction.error); }); database.close();
    await p.call(p.a, 'gate'); const pending = p.call(p.a, 'put', p.key(1), 4, p.value(4, true));
    const pendingStatus = await p.call(p.a, 'status'); if (pendingStatus.diskPending !== 1) throw new Error('Accepted pending disk I/O should be observable.');
    const close = p.call(p.a, 'close'), closed = await p.call(p.a, 'status'); if (!closed.closed || closed.diskPending !== 1 || await p.call(p.a, 'put', p.key(5), 0, record)) throw new Error('Close must gate new cache work while draining accepted work.');
    await p.call(p.a, 'release'); const write = await pending; await close; await p.call(p.b, 'close');
    for (const worker of p.workers) worker.terminate(); URL.revokeObjectURL(p.workerUrl);
    return { initialWrites: results, finalWrite: write, accounting: after, actualWorkerConcurrentAtomicWrites: true, quotaRollback: true, closeWaitsAcceptedWrites: true };
  }); measurements.push(...first.initialWrites.map(value => ({ writeMs: value.writeMs, bytes: value.bytes })), { writeMs: first.finalWrite.writeMs, bytes: first.finalWrite.bytes });
  await context.close(); context = null;
  // A new Chromium process reads the same on-disk origin/profile after all
  // original JavaScript objects and workers have been destroyed.
  page = await launch();
  const reopened = await page.evaluate(async () => {
    const p = window.proof, dense = await p.call(p.a, 'get', p.key(1), 0), compressed = await p.call(p.a, 'get', p.key(1), 4);
    p.assertValue(dense, p.value(0)); p.assertValue(compressed, p.value(4, true)); p.assertValue(await p.call(p.a, 'get', p.key(3), 0), p.value(0));
    const accounting = p.accounting(await p.call(p.a, 'inspect'));
    await p.call(p.a, 'tamper', p.key(1), 0); if (await p.call(p.b, 'get', p.key(1), 0)) throw new Error('A structurally valid corrupted RGB payload must fail its checksum.');
    await p.call(p.a, 'clear'); const cleared = p.accounting(await p.call(p.b, 'inspect')); if (cleared.contexts || cleared.entries || cleared.bytes) throw new Error('Explicit cache clear must remove all lighting records.');
    const save = indexedDB.open('native-authority-cache-proof', 1), database = await new Promise((resolve, reject) => { save.onsuccess = () => resolve(save.result); save.onerror = () => reject(save.error); });
    const read = database.transaction('worlds').objectStore('worlds').get('world'), authority = await new Promise((resolve, reject) => { read.onsuccess = () => resolve(read.result); read.onerror = () => reject(read.error); }); database.close();
    if (authority?.blocks !== 'keep' || authority.inventory !== 'keep') throw new Error('Lighting cache clear altered world authority storage.');
    const stats = await p.call(p.a, 'status'); await p.call(p.a, 'close'); await p.call(p.b, 'close'); for (const worker of p.workers) worker.terminate(); URL.revokeObjectURL(p.workerUrl);
    return { dense: { readMs: dense.readMs, bytes: dense.bytes }, compressed: { readMs: compressed.readMs, bytes: compressed.bytes }, accounting, stats,
      exactBitsAcrossBrowserProcessRestart: true, checksumCorruptionBecomesMiss: true, disposableClearPreservesAuthority: true };
  }); measurements.push({ readMs: reopened.dense.readMs, bytes: reopened.dense.bytes }, { readMs: reopened.compressed.readMs, bytes: reopened.compressed.bytes });
  assert.deepEqual(errors, []);
  const report = { validation: 'passed', backend: 'actual Chromium Workers/IndexedDB, two browser processes with persisted profile',
    ...first, ...reopened, measurements, gpuUsed: false, measuredOnTargetHardware: false, target60FPSVerified: false,
    note: 'Disk I/O and SHA-256 validation timings only; this fixture makes no rendering or hardware frame-rate claim.' };
  await mkdir('test-results', { recursive: true }); await writeFile('test-results/irradiance-disk-cache.json', JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2));
} finally { await context?.close(); await rm(profile, { recursive: true, force: true }); }
