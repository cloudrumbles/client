import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import minecraftProtocol from 'minecraft-protocol';
import minecraftData from 'minecraft-data';
import { WebSocket } from 'ws';
import { createGateway, encodeValue, decodeValue } from '../scripts/gateway.mjs';

function inbox(socket) {
  const received = [], pending = new Set();
  socket.on('message', raw => {
    const message = decodeValue(JSON.parse(raw.toString()));
    received.push(message);
    for (const waiter of pending) {
      if (waiter.predicate(message)) { clearTimeout(waiter.timer); pending.delete(waiter); waiter.resolve(message); }
    }
  });
  return {
    received,
    waitFor(predicate, timeout = 10000) {
      const found = received.find(predicate);
      if (found) return Promise.resolve(found);
      return new Promise((resolve, reject) => {
        const waiter = { predicate, resolve, timer: setTimeout(() => { pending.delete(waiter); reject(new Error(`Gateway message timeout; received ${received.map(m => m.type + (m.name ? `:${m.name}` : '')).join(', ')}`)); }, timeout) };
        pending.add(waiter);
      });
    },
  };
}

function websocket(gateway, origin = 'http://127.0.0.1:5173', suffix = '') {
  return new WebSocket(`ws://127.0.0.1:${gateway.address.port}/${suffix}`, { origin });
}

function signedLong(value) { return Array.isArray(value) ? (BigInt(value[0]) << 32n) + BigInt(value[1] >>> 0) : BigInt(value); }

test('gateway transport preserves nested bytes, signed long arrays and BigInt', () => {
  const source = { blob: Buffer.from([0, 127, 128, 255]), long: -9223372036854775808n, nbt: { value: [[-1, 4294967295], 9223372036854775807n] } };
  const restored = decodeValue(JSON.parse(JSON.stringify(encodeValue(source))));
  assert.deepEqual(restored.blob, source.blob);
  assert.equal(restored.long, source.long);
  assert.deepEqual(restored.nbt.value, source.nbt.value);
  assert.throws(() => decodeValue({ __bytes: 'not base64!' }), /binary/);
  assert.throws(() => decodeValue({ __bigint: '12.3' }), /integer/);
});

test('gateway requires trusted origins, remote restrictions and destination allowlists', async t => {
  await assert.rejects(createGateway({ host: '0.0.0.0', port: 0 }), /remotely bound/);
  const gateway = await createGateway({ port: 0, token: 'test-session', allowDestinations: ['127.0.0.1:25565'] });
  t.after(() => gateway.close());
  const foreign = websocket(gateway, 'https://example.com', '?token=test-session');
  await assert.rejects(once(foreign, 'open'), /403/);
  const noToken = websocket(gateway);
  await assert.rejects(once(noToken, 'open'), /403/);
  const socket = websocket(gateway, 'http://127.0.0.1:5173', '?token=test-session');
  t.after(() => socket.terminate());
  const messages = inbox(socket);
  await once(socket, 'open');
  socket.send(JSON.stringify({ type: 'connect', host: '127.0.0.1', port: 25566, username: 'Pomme', auth: 'offline', version: '1.20.4' }));
  const denied = await messages.waitFor(m => m.type === 'error');
  assert.match(denied.message, /destination is not allowed/);
});

test('gateway joins an actual Java 1.20.4 protocol server, forwards registry/chunks and maintains keepalive', { timeout: 20000 }, async t => {
  const data = minecraftData('1.20.4');
  const server = minecraftProtocol.createServer({ host: '127.0.0.1', port: 0, version: '1.20.4', 'online-mode': false, keepAlive: false, hideErrors: true, motd: 'Pomme gateway integration', maxPlayers: 4 });
  const serverErrors = [];
  server.on('error', error => serverErrors.push(error.message));
  await once(server, 'listening');
  const mcPort = server.socketServer.address().port;
  t.after(async () => {
    // Avoid minecraft-protocol Server.close() calling end() twice on a client
    // whose server kick has already begun; the second call leaves a 30s timer.
    for (const client of Object.values(server.clients)) client.socket?.destroy();
    await new Promise(resolveClosed => server.socketServer.close(resolveClosed));
  });
  const gateway = await createGateway({ port: 0, allowDestinations: [`127.0.0.1:${mcPort}`] });
  t.after(() => gateway.close());
  const socket = websocket(gateway);
  t.after(() => socket.terminate());
  const messages = inbox(socket);
  await once(socket, 'open');

  socket.send(JSON.stringify({ type: 'ping', host: '127.0.0.1', port: mcPort, version: '1.20.4' }));
  const status = await messages.waitFor(m => m.type === 'status');
  assert.equal(status.data.version.protocol, data.version.version);
  assert.equal(status.data.description.text, 'Pomme gateway integration');

  let joined;
  const keepAlive = new Promise(resolve => server.on('playerJoin', client => client.on('keep_alive', resolve)));
  const position = new Promise(resolve => server.on('playerJoin', client => client.on('position', resolve)));
  const teleport = new Promise(resolve => server.on('playerJoin', client => client.on('teleport_confirm', resolve)));
  const batchAck = new Promise(resolve => server.on('playerJoin', client => client.on('chunk_batch_received', resolve)));
  const chat = new Promise(resolve => server.on('playerJoin', client => client.on('chat_message', resolve)));
  // A valid singleton-paletted chunk: 24 sections, each with stone blocks and a
  // single biome. It travels through the real packet serializer + compression.
  const section = Buffer.from([0x10, 0x00, 0x00, data.blocksByName.stone.defaultState, 0x00, 0x00, 0x01, 0x00]);
  const chunkBytes = Buffer.concat(Array.from({ length: 24 }, () => section));
  server.on('playerJoin', client => {
    joined = client;
    client.write('login', { ...data.loginPacket, entityId: 42, gameMode: 1, hashedSeed: -9223372036854775808n });
    client.write('position', { x: 8, y: 65, z: 8, yaw: 0, pitch: 0, flags: 0, teleportId: 7 });
    client.write('chunk_batch_start', {});
    client.write('map_chunk', { x: 0, z: 0, heightmaps: { type: 'compound', value: {} }, chunkData: chunkBytes, blockEntities: [], skyLightMask: [], blockLightMask: [], emptySkyLightMask: [], emptyBlockLightMask: [], skyLight: [], blockLight: [] });
    client.write('chunk_batch_finished', { batchSize: 1 });
    client.write('keep_alive', { keepAliveId: 9223372036854775807n });
  });
  socket.send(JSON.stringify({ type: 'connect', host: '127.0.0.1', port: mcPort, username: 'PommeTest', auth: 'offline', version: '1.20.4' }));
  const connected = await messages.waitFor(m => m.type === 'connected');
  assert.equal(connected.version, '1.20.4');
  assert.equal(connected.keepAliveManaged, true);
  const registry = await messages.waitFor(m => m.type === 'packet' && m.name === 'registry_data');
  assert.equal(registry.state, 'configuration');
  assert.ok(registry.data.codec.value['minecraft:dimension_type']);
  const login = await messages.waitFor(m => m.type === 'packet' && m.name === 'login');
  assert.equal(login.data.entityId, 42);
  assert.equal(signedLong(login.data.hashedSeed), -9223372036854775808n);
  const chunk = await messages.waitFor(m => m.type === 'packet' && m.name === 'map_chunk');
  assert.deepEqual(chunk.data.chunkData, chunkBytes);
  const alive = await keepAlive;
  assert.equal(signedLong(alive.keepAliveId), 9223372036854775807n);

  socket.send(JSON.stringify({ type: 'packet', name: 'teleport_confirm', data: { teleportId: 7 } }));
  socket.send(JSON.stringify({ type: 'packet', name: 'chunk_batch_received', data: { chunksPerTick: 16 } }));
  socket.send(JSON.stringify({ type: 'packet', name: 'position', data: { x: 9, y: 65, z: 8, onGround: true } }));
  socket.send(JSON.stringify({ type: 'chat', text: 'Hello from the browser' }));
  assert.equal((await teleport).teleportId, 7);
  assert.equal((await batchAck).chunksPerTick, 16);
  assert.equal((await position).x, 9);
  assert.equal((await chat).message, 'Hello from the browser');
  assert.equal(joined.username, 'PommeTest');
  socket.send(JSON.stringify({ type: 'packet', name: 'set_protocol', data: {} }));
  assert.match((await messages.waitFor(m => m.type === 'error')).message, /serverbound packet/);
  assert.deepEqual(serverErrors, []);
  joined.end('Integration server closing');
  const disconnected = await messages.waitFor(m => m.type === 'disconnected');
  assert.equal(disconnected.reason, 'Integration server closing');
});
