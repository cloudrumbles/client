import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { createResourcePackProxy, publicAddress, validPackURL } from '../scripts/resource-pack-proxy.mjs';
import { ServerResourcePacks, PACK_STATUS, fetchResourcePack, resourcePackDownloadURL } from '../src/server-packs.js';

const origin = 'http://127.0.0.1:5173', uuid = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', secondUUID = '11111111-2222-3333-4444-555555555555';
const sha1 = bytes => createHash('sha1').update(bytes).digest('hex');
const capability = '1'.repeat(64);
const advertised = (id = uuid, extra = {}) => ({ type: 'resource-pack', uuid: id, url: 'https://packs.example/test.zip', hash: '', forced: false, download: { path: `/resource-pack/${id}?capability=${capability}`, maxBytes: 4096 }, ...extra });
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`)));
const close = server => new Promise(resolve => server.close(resolve));

test('resource pack proxy accepts only advertised UUID/capability routes, exact origins/tokens, and verified bounded bytes', async () => {
  const bytes = new Uint8Array([80, 75, 3, 4, 5, 6]); let upstreamRequests = 0;
  const upstream = createServer((req, res) => { upstreamRequests++; res.writeHead(200, { 'Content-Length': bytes.length }); res.end(bytes); });
  const upstreamURL = await listen(upstream);
  const proxy = createResourcePackProxy({ token: 'gateway-token', allowedOrigins: [origin], allowPrivateHosts: ['127.0.0.1'], maxBytes: 32, maxTotalBytes: 64 });
  const gateway = createServer(async (req, res) => { if (!await proxy.handleRequest(req, res)) res.writeHead(404).end(); }); const gatewayURL = await listen(gateway);
  try {
    const pack = proxy.registerAdvertisedPack({ uuid, url: upstreamURL + '/actual.zip', hash: sha1(bytes) }, 'minecraft-connection');
    const route = new URL(pack.download.path, gatewayURL); route.searchParams.set('token', 'gateway-token');
    const denied = await fetch(route, { headers: { Origin: 'https://untrusted.example' } }); assert.equal(denied.status, 403); assert.equal(upstreamRequests, 0);
    const missingToken = new URL(route); missingToken.searchParams.delete('token'); assert.equal((await fetch(missingToken, { headers: { Origin: origin } })).status, 403);
    const unknown = new URL(route); unknown.searchParams.set('capability', '2'.repeat(64)); assert.equal((await fetch(unknown, { headers: { Origin: origin } })).status, 404);
    const response = await fetch(route, { headers: { Origin: origin } }); assert.equal(response.status, 200);
    assert.deepEqual(new Uint8Array(await response.arrayBuffer()), bytes); assert.equal(response.headers.get('access-control-allow-origin'), origin); assert.equal(response.headers.get('x-resource-pack-sha1'), sha1(bytes));
    assert.equal(proxy.stats().cachedBytes, bytes.length);
    await fetch(route, { headers: { Origin: origin } }); assert.equal(upstreamRequests, 1, 'Repeated capability reads reuse verified bytes');
    proxy.cleanup('minecraft-connection'); assert.equal(proxy.stats().cachedBytes, 0); assert.equal((await fetch(route, { headers: { Origin: origin } })).status, 404);
  } finally { proxy.close(); await close(gateway); await close(upstream); }
});

test('pack download proxy enforces SHA-1, size, redirect/private-address rules, and URL protocols', async () => {
  const upstream = createServer((req, res) => {
    if (req.url === '/redirect') { res.writeHead(302, { Location: '/zip' }); res.end(); }
    else if (req.url === '/oversized') { res.writeHead(200, { 'Content-Length': 10000 }); res.end(new Uint8Array(10000)); }
    else res.end(new Uint8Array([80, 75, 3, 4]));
  }); const upstreamURL = await listen(upstream);
  const proxy = createResourcePackProxy({ allowedOrigins: [origin], allowPrivateHosts: ['127.0.0.1'], maxBytes: 32, maxTotalBytes: 64 });
  const gateway = createServer(async (req, res) => { if (!await proxy.handleRequest(req, res)) res.writeHead(404).end(); }); const gatewayURL = await listen(gateway);
  const fetchPack = async (path, hash = '') => { const pack = proxy.registerAdvertisedPack({ uuid, url: upstreamURL + path, hash }, 'a'); return fetch(new URL(pack.download.path, gatewayURL), { headers: { Origin: origin } }); };
  try {
    assert.equal((await fetchPack('/redirect')).status, 200);
    const mismatch = await fetchPack('/zip', '0'.repeat(40)); assert.equal(mismatch.status, 502); assert.match(await mismatch.text(), /SHA-1/);
    const large = await fetchPack('/oversized'); assert.equal(large.status, 502); assert.match(await large.text(), /limit/);
    assert.equal(proxy.registerAdvertisedPack({ uuid, url: 'file:///secret.txt', hash: '' }, 'a').downloadStatus, PACK_STATUS.INVALID_URL);
    assert.throws(() => validPackURL('https://user:secret@example.com/pack.zip'), /credentials/);
    for (const address of ['127.0.0.1', '10.2.3.4', '172.20.1.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '::1', 'fc00::1', 'fe80::1', '::ffff:127.0.0.1']) assert.equal(publicAddress(address), false, address);
    for (const address of ['1.1.1.1', '8.8.8.8', '2001:4860:4860::8888']) assert.equal(publicAddress(address), true, address);
  } finally { proxy.close(); await close(gateway); await close(upstream); }
});

test('resource pack DNS/HTTP work is bounded and revoked capabilities stop active downloads', async () => {
  const proxy = createResourcePackProxy({ allowedOrigins: [origin], timeoutMs: 25, resolver: () => new Promise(() => {}) });
  const gateway = createServer(async (req, res) => { await proxy.handleRequest(req, res); }); const gatewayURL = await listen(gateway);
  try {
    const pack = proxy.registerAdvertisedPack({ uuid, url: 'https://never-resolves.example/pack.zip', hash: '' }, 'a');
    const response = await fetch(new URL(pack.download.path, gatewayURL), { headers: { Origin: origin } }); assert.equal(response.status, 502); assert.match(await response.text(), /cancelled/);
    assert.equal(proxy.stats().activeDownloads, 0); assert.equal(proxy.stats().inFlightBytes, 0);
  } finally { proxy.close(); await close(gateway); }
});

test('browser manager sends actual accepted/downloaded/success statuses and applies ordered server stacks and removal', async () => {
  const packets = [], applied = [], bytes = new Uint8Array([80, 75, 3, 4]);
  const session = { packet: (name, data) => packets.push({ name, ...data }) };
  const manager = new ServerResourcePacks({ session, gatewayUrl: 'ws://127.0.0.1:5174/?token=secret', preference: 'enabled', fetcher: async url => { assert.ok(url.includes('token=secret')); assert.ok(url.includes('capability=')); return new Response(bytes); }, applyPacks: async files => applied.push(files.map(file => file.name)) });
  await manager.event(advertised(uuid, { hash: sha1(bytes) }));
  assert.deepEqual(packets.map(packet => packet.result), [3, 4, 0]); assert.equal(manager.stats().loaded, 1);
  await manager.event(advertised(secondUUID)); assert.equal(applied.at(-1).length, 2); assert.ok(applied.at(-1)[0].includes(uuid)); assert.ok(applied.at(-1)[1].includes(secondUUID));
  await manager.event({ type: 'remove-resource-pack', uuid }); assert.deepEqual(applied.at(-1), [`server-${secondUUID}.zip`]); assert.equal(packets.at(-1).result, 7);
  await manager.clear(); assert.deepEqual(applied.at(-1), []); assert.equal(manager.stats().bytes, 0);
});

test('pack choice declines optional packs without fetching and explains required-pack consequence via prompt before disconnect', async () => {
  const packets = []; let fetches = 0, prompts = 0, disconnected = 0;
  const manager = new ServerResourcePacks({ session: { packet: (name, data) => packets.push(data), disconnect: () => disconnected++ }, gatewayUrl: 'ws://localhost:5174', preference: 'disabled', fetcher: async () => { fetches++; return new Response(new Uint8Array([1])); }, prompt: async request => { assert.equal(request.forced, true); prompts++; return false; } });
  await manager.event(advertised()); assert.equal(fetches, 0); assert.equal(prompts, 0); assert.equal(packets.at(-1).result, 1); assert.equal(disconnected, 0);
  await manager.event(advertised(secondUUID, { forced: true })); assert.equal(prompts, 1); assert.equal(disconnected, 1); assert.equal(packets.at(-1).result, 1);
});

test('browser pack failures distinguish invalid URL, download/hash failures, and reload failures with base restoration', async () => {
  const packets = [], applied = [];
  const manager = new ServerResourcePacks({ session: { packet: (name, data) => packets.push(data) }, gatewayUrl: 'ws://localhost:5174', preference: 'enabled', fetcher: async () => new Response(new Uint8Array([80, 75, 3, 4])), applyPacks: async files => { applied.push(files.length); if (files.length) throw new Error('Malformed imported ZIP'); } });
  await manager.event(advertised(uuid, { url: 'file:///secret' })); assert.equal(packets.at(-1).result, 5);
  await manager.event(advertised(uuid, { hash: '0'.repeat(40) })); assert.equal(packets.at(-1).result, 2);
  await manager.event(advertised(uuid)); assert.deepEqual(packets.slice(-3).map(packet => packet.result), [3, 4, 6]); assert.deepEqual(applied, [1, 0]);
  assert.equal(manager.stats().bytes, 0);
});

test('pack removal cancels an active prompt/download without late success or accidental decline', async () => {
  const packets = []; let promptStarted;
  const started = new Promise(resolve => { promptStarted = resolve; });
  const manager = new ServerResourcePacks({ session: { packet: (name, data) => packets.push(data) }, gatewayUrl: 'ws://localhost:5174', preference: 'prompt', prompt: (request, signal) => new Promise(resolve => { promptStarted(); signal.addEventListener('abort', () => resolve(false)); }) });
  const pending = manager.event(advertised()); await started;
  await manager.event({ type: 'remove-resource-pack', uuid }); await pending;
  assert.deepEqual(packets.map(packet => packet.result), [7]); assert.equal(manager.stats().requested, 0);
});

test('browser download capabilities cannot select other origins and streamed bytes/hash stay bounded', async () => {
  assert.throws(() => resourcePackDownloadURL('ws://localhost:5174', advertised(uuid, { download: { path: 'https://evil.example/resource-pack/file' } })), /authorize/);
  await assert.rejects(() => fetchResourcePack('http://test', { fetcher: async () => new Response(new Uint8Array(100)), maxBytes: 10 }), /file limit/);
  await assert.rejects(() => fetchResourcePack('http://test', { fetcher: async () => new Response(new Uint8Array([1, 2])), hash: '0'.repeat(40) }), /SHA-1/);
});

test('destroying a manager during asset reload never starts a second reload or sends a late success', async () => {
  const packets = []; let started, release, reloads = 0;
  const entering = new Promise(resolve => { started = resolve; });
  const manager = new ServerResourcePacks({ session: { packet: (name, data) => packets.push(data) }, gatewayUrl: 'ws://localhost:5174', preference: 'enabled', fetcher: async () => new Response(new Uint8Array([1])), applyPacks: () => { reloads++; started(); return new Promise(resolve => { release = resolve; }); } });
  const adding = manager.event(advertised()); await entering; await manager.destroy(); release(); await adding;
  assert.equal(reloads, 1); assert.deepEqual(packets.map(packet => packet.result), [3, 4, 7]); assert.equal(manager.files().length, 0);
});
