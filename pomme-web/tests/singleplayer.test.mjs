import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, mkdir, symlink, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { SingleplayerManager, createSingleplayerService, compatibilityError, pingSingleplayerServer } from '../scripts/singleplayer.mjs';

const require = createRequire(import.meta.url);

async function fixture(t, { version = '1.20.4', crash = false } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'pomme-singleplayer-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const script = join(directory, 'server.mjs');
  await writeFile(script, `
import minecraftProtocol from ${JSON.stringify(pathToFileURL(require.resolve('minecraft-protocol')).href)};
import {readFile,writeFile} from 'node:fs/promises';
const statePath=process.env.POMME_SINGLEPLAYER_WORLD+'/state.json';
let state={starts:0,saves:0};try{state=JSON.parse(await readFile(statePath,'utf8'))}catch{}
state.starts++;await writeFile(statePath,JSON.stringify(state));
const server=minecraftProtocol.createServer({host:'127.0.0.1',port:Number(process.env.POMME_SINGLEPLAYER_PORT),version:${JSON.stringify(version)},'online-mode':false,keepAlive:false,motd:'Persistent fixture',hideErrors:true});
server.on('error',e=>{console.error(e);process.exit(1)});
server.on('listening',()=>{console.log('World is ready');${crash ? 'setTimeout(()=>process.exit(7),500);' : ''}});
process.stdin.setEncoding('utf8');process.stdin.on('data',async data=>{if(!data.includes('stop'))return;state.saves++;await writeFile(statePath,JSON.stringify(state));server.socketServer.close(()=>process.exit(0));});
`);
  const manager = new SingleplayerManager({ savesDir: join(directory, 'saves'), server: { kind: 'custom', version: '1.20.4', command: process.execPath, args: [script] }, startupTimeoutMs: 5000, stopTimeoutMs: 3000 });
  t.after(() => manager.close());
  return { directory, manager };
}

test('local server starts, saves, exits and reopens the same persistent world', { timeout: 15000 }, async t => {
  const { manager } = await fixture(t);
  const world = await manager.createWorld({ name: 'Survival save', seed: '-123', allowCommands: true });
  const opening = manager.startWorld(world.id, { username: 'BrowserTest' });
  await assert.rejects(manager.startWorld(world.id), /Save and stop/);
  const endpoint = await opening;
  assert.equal(endpoint.version, '1.20.4');
  assert.equal((await pingSingleplayerServer(endpoint.port, 765)).description.text, 'Persistent fixture');
  assert.equal(manager.status().phase, 'running');
  assert.equal((await manager.stopWorld()).saved, true);
  await assert.rejects(pingSingleplayerServer(endpoint.port, 765), /ECONNREFUSED/);
  const reopened = new SingleplayerManager({ savesDir: manager.savesDir, server: manager.server, startupTimeoutMs: 5000, stopTimeoutMs: 3000 });
  t.after(() => reopened.close());
  assert.equal((await reopened.listWorlds())[0].id, world.id);
  await reopened.startWorld(world.id);
  assert.equal((await reopened.stopWorld()).saved, true);
  assert.deepEqual(JSON.parse(await readFile(join(manager.worldPath(world.id), 'state.json'), 'utf8')), { starts: 2, saves: 2 });
  assert.ok((await reopened.readWorld(world.id)).lastPlayed);
});

test('a real status response rejects a wrongly labelled server and cleans up its process', { timeout: 10000 }, async t => {
  const { manager } = await fixture(t, { version: '1.20.6' });
  const world = await manager.createWorld();
  await assert.rejects(manager.startWorld(world.id), /requires protocol 765/);
  assert.equal(manager.status().phase, 'stopped');
  assert.match(manager.status().error, /protocol 765/);
  assert.deepEqual(JSON.parse(await readFile(join(manager.worldPath(world.id), 'state.json'), 'utf8')), { starts: 1, saves: 1 });
  assert.match(compatibilityError({ kind: 'pumpkin', version: '26.3', command: 'pumpkin' }), /Java 26.3/);
});

test('unexpected server exits clear the running endpoint and preserve the diagnostic', { timeout: 10000 }, async t => {
  const { manager } = await fixture(t, { crash: true });
  const world = await manager.createWorld();
  await manager.startWorld(world.id);
  const deadline = Date.now() + 3000;
  while (manager.status().phase === 'running' && Date.now() < deadline) await new Promise(done => setTimeout(done, 20));
  assert.equal(manager.status().phase, 'stopped');
  assert.equal(manager.status().port, null);
  assert.match(manager.status().error, /unexpectedly \(7\)/);
});

test('save imports copy the selected world and reject path escapes and symbolic links', async t => {
  const { directory, manager } = await fixture(t);
  const source = join(directory, 'existing-world');
  await mkdir(join(source, 'region'), { recursive: true });
  await writeFile(join(source, 'level.dat'), Buffer.from([10, 0, 0, 0]));
  await writeFile(join(source, 'region', 'r.0.0.mca'), 'original');
  await writeFile(join(source, 'session.lock'), 'do not copy a running lock');
  const world = await manager.importWorld(source, { name: 'Imported' });
  const copied = join(manager.worldPath(world.id), 'world');
  assert.equal(await readFile(join(copied, 'region', 'r.0.0.mca'), 'utf8'), 'original');
  assert.ok(!(await readdir(copied)).includes('session.lock'));
  await writeFile(join(copied, 'region', 'r.0.0.mca'), 'edited copy');
  assert.equal(await readFile(join(source, 'region', 'r.0.0.mca'), 'utf8'), 'original');
  await assert.rejects(manager.readWorld('../existing-world'), /Invalid local world ID/);
  await symlink(source, join(source, 'linked-world'), 'dir');
  await assert.rejects(manager.importWorld(source), /symbolic links/);
  const fakeId = '11111111-1111-4111-8111-111111111111';
  await symlink(source, manager.worldPath(fakeId), 'dir');
  await assert.rejects(manager.readWorld(fakeId), /inside the saves/);
});

test('browser world actions require the trusted origin and session control token', async t => {
  const { manager } = await fixture(t);
  const service = await createSingleplayerService({ manager, port: 0 });
  t.after(() => service.close());
  const endpoint = `http://127.0.0.1:${service.address.port}`, origin = 'http://127.0.0.1:5173';
  const status = await (await fetch(`${endpoint}/status`, { headers: { Origin: origin } })).json();
  assert.equal(typeof status.controlToken, 'string');
  assert.ok(!('controlToken' in await (await fetch(`${endpoint}/status`)).json()));
  assert.equal((await fetch(`${endpoint}/status`, { headers: { Origin: 'https://example.com' } })).status, 403);
  assert.equal((await fetch(`${endpoint}/worlds`, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: '{}' })).status, 403);
  const headers = { Origin: origin, 'Content-Type': 'application/json', 'X-Pomme-Singleplayer-Token': status.controlToken };
  const response = await fetch(`${endpoint}/worlds`, { method: 'POST', headers, body: JSON.stringify({ name: 'Browser-created world', gameMode: 'creative' }) });
  assert.equal(response.status, 201);
  const { world } = await response.json();
  const start = await fetch(`${endpoint}/worlds/${world.id}/start`, { method: 'POST', headers, body: JSON.stringify({ username: 'BrowserTest' }) });
  assert.equal(start.status, 200);
  assert.equal((await start.json()).auth, 'offline');
  assert.equal((await (await fetch(`${endpoint}/stop`, { method: 'POST', headers, body: '{}' })).json()).saved, true);
  assert.equal((await (await fetch(`${endpoint}/worlds`, { headers: { Origin: origin } })).json()).worlds[0].name, 'Browser-created world');
});
