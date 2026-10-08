import { createServer } from 'node:http';
import { connect as connectTcp, isIP } from 'node:net';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { pathToFileURL, domainToASCII } from 'node:url';
import { timingSafeEqual, randomUUID } from 'node:crypto';
import { mkdirSync, chmodSync } from 'node:fs';
import minecraftProtocol from 'minecraft-protocol';
import minecraftData from 'minecraft-data';
import { WebSocket, WebSocketServer } from 'ws';
import { BROWSER_PROTOCOL_VERSIONS } from '../src/protocol-compat.js';
import { createResourcePackProxy } from './resource-pack-proxy.mjs';
import { installNativeCodecs } from './native-codec.mjs';

for (const version of BROWSER_PROTOCOL_VERSIONS) installNativeCodecs(version);

export const SUPPORTED_VERSION = '1.20.4';
export const DEFAULT_ORIGINS = ['http://127.0.0.1:5173', 'http://localhost:5173'];
const MAX_BROWSER_MESSAGE = 1024 * 1024;
const MAX_BACKPRESSURE = 8 * 1024 * 1024;
const SAFE_PACKETS = new Set([
  'teleport_confirm', 'chunk_batch_received', 'client_command', 'settings',
  'position', 'position_look', 'look', 'flying', 'block_dig', 'block_place',
  'use_item', 'use_entity', 'held_item_slot', 'entity_action', 'arm_animation',
  'window_click', 'close_window', 'set_creative_slot', 'enchant_item',
  'pick_item', 'craft_recipe_request', 'recipe_book', 'displayed_recipe',
  'name_item', 'select_trade', 'set_beacon_effect', 'update_sign', 'set_slot_state', 'edit_book', 'select_bundle_item',
  'resource_pack_receive', 'abilities', 'vehicle_move', 'steer_boat',
  'steer_vehicle', 'pong', 'ping_request', 'tab_complete', 'advancement_tab', 'player_loaded', 'player_input',
]);
function allowedPacketNames(version, state = 'play') {
  const packetMapping = minecraftData(version)?.protocol[state]?.toServer?.types.packet[1][0].type[1].mappings || {};
  return new Set(Object.values(packetMapping).filter(name => SAFE_PACKETS.has(name)));
}

/** Preserve protocol bytes and 64-bit integers across the JSON transport. */
export function encodeValue(value, depth = 0) {
  if (depth > 96) throw new Error('Packet nesting exceeds the transport limit.');
  if (typeof value === 'bigint') return { __bigint: value.toString() };
  if (Buffer.isBuffer(value)) return { __bytes: value.toString('base64') };
  if (ArrayBuffer.isView(value)) return { __bytes: Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString('base64') };
  if (value instanceof ArrayBuffer) return { __bytes: Buffer.from(value).toString('base64') };
  if (Array.isArray(value)) return value.map(entry => encodeValue(entry, depth + 1));
  if (value && typeof value === 'object') {
    const result = Object.create(null);
    for (const [key, entry] of Object.entries(value)) result[key] = encodeValue(entry, depth + 1);
    return result;
  }
  return value;
}

export function decodeValue(value, depth = 0) {
  if (depth > 96) throw new Error('Packet nesting exceeds the transport limit.');
  if (Array.isArray(value)) return value.map(entry => decodeValue(entry, depth + 1));
  if (value && typeof value === 'object') {
    const keys = Object.keys(value);
    if (keys.length === 1 && keys[0] === '__bigint') {
      if (typeof value.__bigint !== 'string' || !/^-?\d{1,30}$/.test(value.__bigint)) throw new Error('Invalid 64-bit integer encoding.');
      return BigInt(value.__bigint);
    }
    if (keys.length === 1 && keys[0] === '__bytes') {
      if (typeof value.__bytes !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value.__bytes)) throw new Error('Invalid binary packet encoding.');
      return Buffer.from(value.__bytes, 'base64');
    }
    const result = Object.create(null);
    for (const [key, entry] of Object.entries(value)) result[key] = decodeValue(entry, depth + 1);
    return result;
  }
  if (typeof value === 'number' && !Number.isFinite(value)) throw new Error('Packet numbers must be finite.');
  return value;
}

function normalizeDestination(message) {
  if (typeof message.host !== 'string' || message.host.length > 253) throw new Error('Enter a server hostname or IP address.');
  let host = message.host.trim().toLowerCase();
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
  if (!isIP(host)) {
    host = domainToASCII(host);
    if (!host || !/^(?=.{1,253}$)[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(host) || host.includes('..')) throw new Error('Invalid server hostname.');
  }
  const port = message.port ?? 25565;
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Server port must be between 1 and 65535.');
  const version = message.version || SUPPORTED_VERSION;
  if (!BROWSER_PROTOCOL_VERSIONS.includes(version) || !minecraftData(version)?.protocol) throw new Error(`This gateway supports Java ${BROWSER_PROTOCOL_VERSIONS.join(', ')}.`);
  return { host, port, version };
}

function endpointKey({ host, port }) { return `${host}:${port}`; }
function destinationSet(entries) {
  return new Set(entries.map(entry => {
    if (typeof entry === 'object' && entry) return endpointKey(normalizeDestination(entry));
    const url = new URL(`minecraft://${entry}`);
    return endpointKey(normalizeDestination({ host: url.hostname, port: url.port ? Number(url.port) : 25565 }));
  }));
}
function sameToken(received, expected) {
  if (!expected) return true;
  if (typeof received !== 'string') return false;
  const left = Buffer.from(received), right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

function disconnectText(reason) {
  if (typeof reason === 'string') {
    try { return disconnectText(JSON.parse(reason)); } catch { return reason; }
  }
  if (reason?.type && reason.value !== undefined) return disconnectText(reason.value);
  if (reason && typeof reason === 'object') {
    if (reason.text) return disconnectText(reason.text);
    if (reason.translate) return disconnectText(reason.translate);
    return JSON.stringify(encodeValue(reason));
  }
  return 'Minecraft connection closed';
}

/** Local gateway: minecraft-protocol owns TCP, compression, encryption and auth. */
export async function createGateway({
  host = '127.0.0.1', port = 5174, allowedOrigins = DEFAULT_ORIGINS,
  allowDestinations = [], token = '', maxConnections = 8,
  allowPackPrivateHosts = ['127.0.0.1', 'localhost', '::1'],
  profilesFolder = resolve(homedir(), '.cache', 'pomme-web', 'minecraft-profiles'),
} = {}) {
  const destinations = destinationSet(allowDestinations);
  const loopback = ['127.0.0.1', '::1', 'localhost'].includes(host);
  if (!loopback && (!token || destinations.size === 0)) throw new Error('A remotely bound gateway requires GATEWAY_TOKEN and GATEWAY_DESTINATIONS.');
  if (!Array.isArray(allowedOrigins) || allowedOrigins.length === 0) throw new Error('An explicit browser origin allowlist is required.');
  const origins = new Set(allowedOrigins);
  const packProxy = createResourcePackProxy({ token, allowedOrigins, allowPrivateHosts: allowPackPrivateHosts });
  const server = createServer(async (req, res) => {
    if (await packProxy.handleRequest(req, res, origins)) return;
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ service: 'pomme-minecraft-gateway', version: SUPPORTED_VERSION, versions: BROWSER_PROTOCOL_VERSIONS, transport: 'named-json', authentication: ['offline', 'microsoft'] }));
  });
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_BROWSER_MESSAGE, perMessageDeflate: false });
  server.on('upgrade', (request, socket, head) => {
    let url;
    try { url = new URL(request.url, 'http://gateway.local'); } catch { socket.destroy(); return; }
    if (!origins.has(request.headers.origin) || !sameToken(url.searchParams.get('token'), token)) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); return;
    }
    if (wss.clients.size >= maxConnections) {
      socket.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n'); return;
    }
    wss.handleUpgrade(request, socket, head, ws => wss.emit('connection', ws, request));
  });

  wss.on('connection', ws => {
    const connectionId = randomUUID();
    let client = null, connectTimer, ended = false, pinging = false, closingClient = false, disconnectReason = null;
    let messages = 0, rateWindow = Date.now();
    const stopClient = reason => {
      if (client && !closingClient && !client.ended) { closingClient = true; client.end(reason); }
    };
    const send = message => {
      if (ws.readyState !== WebSocket.OPEN) return false;
      try {
        const payload = JSON.stringify(encodeValue(message));
        if (Buffer.byteLength(payload) + ws.bufferedAmount > MAX_BACKPRESSURE) {
          ws.close(1013, 'Browser cannot keep up with Minecraft packets.');
          stopClient('Browser transport backpressure');
          return false;
        }
        ws.send(payload);
        return true;
      } catch (error) {
        ws.close(1011, 'Packet cannot be transported.');
        stopClient('Packet transport error');
        return false;
      }
    };
    const reportError = error => send({ type: 'error', message: error instanceof Error ? error.message : String(error) });
    const finish = reason => {
      clearTimeout(connectTimer);
      if (ended) return;
      ended = true;
      send({ type: 'disconnected', reason: disconnectReason ?? (typeof reason === 'string' ? reason : 'Minecraft connection closed') });
    };
    const destination = message => {
      const target = normalizeDestination(message);
      if (destinations.size && !destinations.has(endpointKey(target))) throw new Error('This Minecraft destination is not allowed by the gateway.');
      return target;
    };
    const tcpConnector = target => upstream => {
      // Authentication may finish after the browser has already disconnected.
      if (ws.readyState !== WebSocket.OPEN || ended) { upstream.end('Browser disconnected during authentication'); return; }
      const socket = connectTcp({ host: target.host, port: target.port });
      socket.setTimeout(15000, () => socket.destroy(new Error('Minecraft TCP connection timed out.')));
      socket.once('connect', () => socket.setTimeout(0));
      upstream.setSocket(socket);
    };
    ws.on('message', async (raw, binary) => {
      try {
        if (Date.now() - rateWindow >= 1000) { rateWindow = Date.now(); messages = 0; }
        if (++messages > 500) throw new Error('Too many browser messages.');
        if (binary) throw new Error('Use the named JSON gateway transport.');
        const message = JSON.parse(raw.toString());
        if (!message || typeof message !== 'object' || Array.isArray(message)) throw new Error('Invalid gateway message.');
        if (message.type === 'connect') {
          if (client) throw new Error('Open a new WebSocket to change Minecraft servers.');
          const target = destination(message);
          const auth = message.auth ?? 'offline';
          if (!['offline', 'microsoft'].includes(auth)) throw new Error('Authentication must be offline or microsoft.');
          if (typeof message.username !== 'string' || (auth === 'offline' ? !/^[A-Za-z0-9_]{1,16}$/.test(message.username) : !/^[^\x00-\x1f\x7f]{1,254}$/.test(message.username))) throw new Error('Enter a valid Minecraft username or Microsoft account hint.');
          if (auth === 'microsoft') {
            // The auth library persists refresh tokens here; keep the directory
            // private rather than relying on the process's default umask.
            mkdirSync(profilesFolder, { recursive: true, mode: 0o700 });
            chmodSync(profilesFolder, 0o700);
          }
          ended = false;
          send({ type: 'connecting', ...target, auth });
          client = minecraftProtocol.createClient({
            ...target, auth, username: message.username, profilesFolder,
            keepAlive: true, hideErrors: true,
            clientSettings: { viewDistance: 8 },
            connect: tcpConnector(target),
            onMsaCode: code => send({ type: 'msa-code', verificationUri: code.verification_uri, userCode: code.user_code, message: code.message, expiresIn: code.expires_in }),
          });
          connectTimer = setTimeout(() => {
            reportError(new Error(auth === 'microsoft' ? 'Microsoft sign-in timed out.' : 'Minecraft login timed out.'));
            stopClient('Login timed out'); finish('Login timed out');
          }, auth === 'microsoft' ? 15 * 60 * 1000 : 30000);
          client.on('packet', (data, meta, raw) => {
            // The 1.20.4 codec labels the final respawn data-to-keep byte as a
            // boolean. Restore its two native bits before the browser sees it.
            if (target.version === '1.20.4' && meta.name === 'respawn' && meta.state === 'play' && raw?.length) data.copyMetadata = raw.at(-1);
            if (meta.name === 'disconnect' || meta.name === 'kick_disconnect') disconnectReason = disconnectText(data.reason);
            if (meta.name === 'add_resource_pack' || meta.name === 'resource_pack_send') data = packProxy.registerAdvertisedPack(data, connectionId);
            if (meta.name === 'remove_resource_pack') packProxy.removeAdvertisedPack(data.uuid, connectionId);
            if (meta.state === 'play' || meta.state === 'configuration' || meta.name === 'disconnect') send({ type: 'packet', name: meta.name, state: meta.state, data });
          });
          client.once('playerJoin', () => {
            clearTimeout(connectTimer);
            send({ type: 'connected', version: target.version, username: client.username, uuid: client.uuid, keepAliveManaged: true });
          });
          client.on('error', error => { reportError(error); stopClient('Minecraft connection error'); finish(error.message); });
          client.on('end', finish);
        } else if (message.type === 'packet') {
          if (!client || !['play', 'configuration'].includes(client.state) || ended) throw new Error('Minecraft is not connected.');
          if (!allowedPacketNames(client.version, client.state).has(message.name)) throw new Error('This serverbound packet is not supported by the browser gateway.');
          if (!message.data || typeof message.data !== 'object' || Array.isArray(message.data)) throw new Error('Packet data must be an object.');
          client.write(message.name, decodeValue(message.data));
        } else if (message.type === 'chat') {
          if (!client || client.state !== 'play' || ended || typeof client.chat !== 'function') throw new Error('Minecraft chat is not connected.');
          if (typeof message.text !== 'string' || message.text.length < 1 || message.text.length > 256 || /[\x00-\x1f\x7f]/.test(message.text)) throw new Error('Chat must contain 1–256 printable characters.');
          client.chat(message.text);
        } else if (message.type === 'ping') {
          if (pinging) throw new Error('A Minecraft status request is already running.');
          const target = destination(message);
          pinging = true;
          try {
            const data = await minecraftProtocol.ping({ ...target, closeTimeout: 10000, noPongTimeout: 3000, connect: tcpConnector(target) });
            send({ type: 'status', ...target, data });
          } finally { pinging = false; }
        } else if (message.type === 'disconnect') {
          stopClient('Browser disconnected'); finish('Browser disconnected');
        } else throw new Error('Unknown gateway message type.');
      } catch (error) { reportError(error); }
    });
    ws.on('error', () => { clearTimeout(connectTimer); stopClient('Browser transport error'); });
    ws.on('close', () => { packProxy.cleanup(connectionId); clearTimeout(connectTimer); ended = true; stopClient('Browser disconnected'); });
    send({ type: 'gateway-ready', version: SUPPORTED_VERSION, keepAliveManaged: true });
  });
  await new Promise((resolveReady, reject) => { server.once('error', reject); server.listen(port, host, resolveReady); });
  return {
    server, wss, packProxy, address: server.address(),
    async close() {
      packProxy.close();
      for (const socket of wss.clients) socket.terminate();
      await new Promise(resolveClosed => wss.close(resolveClosed));
      await new Promise(resolveClosed => server.close(resolveClosed));
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const gateway = await createGateway({
      host: process.env.GATEWAY_HOST ?? '127.0.0.1', port: Number(process.env.GATEWAY_PORT ?? 5174),
      allowedOrigins: process.env.GATEWAY_ORIGINS ? process.env.GATEWAY_ORIGINS.split(',').map(s => s.trim()).filter(Boolean) : DEFAULT_ORIGINS,
      allowDestinations: process.env.GATEWAY_DESTINATIONS?.split(',').map(s => s.trim()).filter(Boolean) ?? [],
      token: process.env.GATEWAY_TOKEN ?? '',
      allowPackPrivateHosts: process.env.GATEWAY_PACK_HOSTS?.split(',').map(s => s.trim()).filter(Boolean) ?? ['127.0.0.1', 'localhost', '::1'],
      profilesFolder: process.env.GATEWAY_PROFILES ?? resolve(homedir(), '.cache', 'pomme-web', 'minecraft-profiles'),
    });
    const address = gateway.address;
    console.log(`Pomme Java ${SUPPORTED_VERSION} gateway: ws://${address.address.includes(':') ? `[${address.address}]` : address.address}:${address.port}`);
    process.once('SIGINT', async () => { await gateway.close(); process.exit(0); });
    process.once('SIGTERM', async () => { await gateway.close(); process.exit(0); });
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
