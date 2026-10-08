import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { randomBytes, randomUUID, timingSafeEqual, createHash } from 'node:crypto';
import { mkdir, readdir, readFile, writeFile, rename, stat, realpath, cp, lstat, rm } from 'node:fs/promises';
import { resolve, dirname, join, sep } from 'node:path';
import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { createServer as createTcpServer, connect } from 'node:net';
import minecraftData from 'minecraft-data';

export const SINGLEPLAYER_VERSION = '1.20.4';
const WORLD_ID = /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/;
const GAME_MODES = new Set(['survival', 'creative', 'adventure', 'spectator']);
const DIFFICULTIES = new Set(['peaceful', 'easy', 'normal', 'hard']);
const sleep = ms => new Promise(done => setTimeout(done, ms));

export function serverFromEnvironment(env = process.env) {
  if (env.POMME_SINGLEPLAYER_JAR) return {
    kind: 'vanilla', version: env.POMME_SINGLEPLAYER_VERSION ?? SINGLEPLAYER_VERSION,
    jar: resolve(env.POMME_SINGLEPLAYER_JAR), command: env.POMME_JAVA ?? 'java',
    memoryMiB: Number(env.POMME_SINGLEPLAYER_MEMORY ?? 1024),
    eulaPath: env.POMME_SINGLEPLAYER_EULA ? resolve(env.POMME_SINGLEPLAYER_EULA) : undefined,
  };
  if (env.POMME_PUMPKIN_BINARY) return {
    kind: 'pumpkin', version: env.POMME_PUMPKIN_VERSION ?? '26.3',
    command: resolve(env.POMME_PUMPKIN_BINARY), args: [],
    configurationFormat: env.POMME_PUMPKIN_CONFIG ?? (env.POMME_PUMPKIN_VERSION === '1.21.11' ? 'split' : 'merged'),
    viewDistance: Number(env.POMME_SINGLEPLAYER_VIEW_DISTANCE ?? 8),
    simulationDistance: Number(env.POMME_SINGLEPLAYER_SIMULATION_DISTANCE ?? 6),
  };
  return null;
}

export function compatibilityError(server, clientVersion = SINGLEPLAYER_VERSION) {
  if (!server) return 'Configure POMME_SINGLEPLAYER_JAR with your Java 1.20.4 server JAR before starting a local world.';
  if (server.version !== clientVersion) return `${server.kind === 'pumpkin' ? 'Pumpkin' : 'The configured server'} targets Java ${server.version}; this browser client targets Java ${clientVersion}. A version label does not translate packets, registries, world data or game rules.`;
  if (!['vanilla', 'pumpkin', 'custom'].includes(server.kind)) return 'The local server kind must be vanilla, pumpkin or custom.';
  if (typeof server.command !== 'string' || !server.command) return 'Configure a local server executable.';
  return null;
}

async function availablePort() {
  const socket = createTcpServer();
  await new Promise((done, fail) => { socket.once('error', fail); socket.listen(0, '127.0.0.1', done); });
  const port = socket.address().port;
  await new Promise((done, fail) => socket.close(error => error ? fail(error) : done()));
  return port;
}

function offlineUuid(username) {
  const bytes = createHash('md5').update(`OfflinePlayer:${username}`).digest();
  bytes[6] = (bytes[6] & 15) | 48; bytes[8] = (bytes[8] & 63) | 128;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function pumpkinOfflineUuid(username) {
  // Pumpkin net::offline_uuid uses the first 16 SHA-256 bytes unchanged.
  const hex = createHash('sha256').update(username).digest('hex').slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function varInt(value) {
  const bytes = [];
  do { let byte = value & 127; value >>>= 7; if (value) byte |= 128; bytes.push(byte); } while (value);
  return Buffer.from(bytes);
}

function readVarInt(buffer, start = 0) {
  let value = 0;
  for (let offset = 0; offset < 5; offset++) {
    if (start + offset >= buffer.length) return null;
    const byte = buffer[start + offset]; value |= (byte & 127) << (offset * 7);
    if (!(byte & 128)) return { value: value >>> 0, end: start + offset + 1 };
  }
  throw new Error('The local server returned an invalid status packet length.');
}

/** Status is deliberately independent of the gameplay codec version. */
export function pingSingleplayerServer(port, protocolVersion) {
  return new Promise((done, fail) => {
    const socket = connect({ host: '127.0.0.1', port });
    let incoming = Buffer.alloc(0), settled = false;
    const finish = (error, status) => { if (settled) return; settled = true; socket.destroy(); error ? fail(error) : done(status); };
    socket.setTimeout(1000, () => finish(new Error('Local server status timed out.')));
    socket.once('error', error => finish(error));
    socket.once('end', () => finish(new Error('The local server closed its status connection.')));
    socket.once('connect', () => {
      const host = Buffer.from('127.0.0.1'), portBytes = Buffer.alloc(2); portBytes.writeUInt16BE(port);
      const handshake = Buffer.concat([varInt(0), varInt(protocolVersion), varInt(host.length), host, portBytes, varInt(1)]);
      socket.write(Buffer.concat([varInt(handshake.length), handshake, Buffer.from([1, 0])]));
    });
    socket.on('data', chunk => {
      try {
        if (incoming.length + chunk.length > 1024 * 1024) throw new Error('The local server status exceeds the packet limit.');
        incoming = Buffer.concat([incoming, chunk]);
        const frame = readVarInt(incoming);
        if (!frame) return;
        if (frame.value > 1024 * 1024) throw new Error('The local server status exceeds the packet limit.');
        if (incoming.length < frame.end + frame.value) return;
        const packet = incoming.subarray(frame.end, frame.end + frame.value), id = readVarInt(packet);
        if (!id || id.value !== 0) throw new Error('The local server returned an unexpected status packet.');
        const string = readVarInt(packet, id.end);
        if (!string || string.end + string.value !== packet.length) throw new Error('The local server returned a malformed status response.');
        finish(null, JSON.parse(packet.subarray(string.end).toString('utf8')));
      } catch (error) { finish(error); }
    });
  });
}

/** Own one server process and its private, persistent saves. */
export class SingleplayerManager {
  constructor({ savesDir = resolve(homedir(), '.local', 'share', 'pomme-web', 'saves'), server = serverFromEnvironment(), clientVersion = SINGLEPLAYER_VERSION, protocolVersion = minecraftData(clientVersion)?.version.version, startupTimeoutMs = 120000, stopTimeoutMs = 30000 } = {}) {
    this.savesDir = resolve(savesDir); this.server = server; this.clientVersion = clientVersion;
    this.protocolVersion = protocolVersion; this.startupTimeoutMs = startupTimeoutMs; this.stopTimeoutMs = stopTimeoutMs;
    this.active = null; this.lastError = null; this.lastLogs = []; this.closed = false;
  }

  status() {
    const active = this.active;
    return { service: 'pomme-singleplayer', version: this.clientVersion, configured: !!this.server,
      backend: this.server ? { kind: this.server.kind, version: this.server.version } : null,
      compatibilityError: compatibilityError(this.server, this.clientVersion),
      phase: active?.phase ?? 'stopped', worldId: active?.world?.id ?? null,
      host: active ? '127.0.0.1' : null, port: active?.port ?? null,
      error: this.lastError, logs: active?.logs.slice(-40) ?? this.lastLogs.slice(-40) };
  }

  worldPath(id) {
    if (typeof id !== 'string' || !WORLD_ID.test(id)) throw new Error('Invalid local world ID.');
    return join(this.savesDir, id);
  }

  async readWorld(id) {
    const directory = this.worldPath(id);
    const resolved = await realpath(directory);
    const root = await realpath(this.savesDir);
    if (resolved !== join(root, id) || !resolved.startsWith(root + sep)) throw new Error('The world path must stay inside the saves folder.');
    const file = join(directory, 'pomme-world.json');
    if ((await stat(file)).size > 16384 || (await lstat(file)).isSymbolicLink()) throw new Error('Invalid local world metadata.');
    const world = JSON.parse(await readFile(file, 'utf8'));
    if (world.id !== id || world.schema !== 1 || !GAME_MODES.has(world.gameMode) || !DIFFICULTIES.has(world.difficulty)) throw new Error('Invalid local world metadata.');
    return world;
  }

  async writeWorld(world) {
    const path = join(this.worldPath(world.id), 'pomme-world.json');
    const temporary = `${path}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(world, null, 2) + '\n', { mode: 0o600 });
    await rename(temporary, path);
  }

  async listWorlds() {
    await mkdir(this.savesDir, { recursive: true, mode: 0o700 });
    const worlds = [];
    for (const directory of await readdir(this.savesDir, { withFileTypes: true })) {
      if (!directory.isDirectory() || !WORLD_ID.test(directory.name)) continue;
      try { worlds.push(await this.readWorld(directory.name)); } catch { /* Ignore unrelated or incomplete save folders. */ }
    }
    return worlds.sort((a, b) => (b.lastPlayed ?? b.createdAt).localeCompare(a.lastPlayed ?? a.createdAt));
  }

  async createWorld({ name = 'New World', seed = '', gameMode = 'survival', difficulty = 'normal', allowCommands = false, hardcore = false } = {}) {
    if (this.closed) throw new Error('The local server manager is closed.');
    if (typeof name !== 'string' || !name.trim() || name.length > 128 || /[\x00-\x1f\x7f]/.test(name)) throw new Error('World names must contain 1 to 128 printable characters.');
    if (typeof seed !== 'string' || seed.length > 128 || /[\x00-\x1f\x7f]/.test(seed)) throw new Error('World seeds must contain at most 128 printable characters.');
    if (!GAME_MODES.has(gameMode) || !DIFFICULTIES.has(difficulty) || typeof allowCommands !== 'boolean' || typeof hardcore !== 'boolean') throw new Error('Invalid world game mode, difficulty or commands option.');
    const world = { schema: 1, id: randomUUID(), name: name.trim(), seed, gameMode: hardcore ? 'survival' : gameMode, difficulty: hardcore ? 'hard' : difficulty, allowCommands, hardcore, version: this.clientVersion, createdAt: new Date().toISOString(), lastPlayed: null };
    await mkdir(this.savesDir, { recursive: true, mode: 0o700 });
    await mkdir(this.worldPath(world.id), { mode: 0o700 });
    await this.writeWorld(world);
    return world;
  }

  /** Copy a selected Anvil save instead of modifying its original folder. */
  async importWorld(sourceDirectory, options = {}) {
    const source = await realpath(sourceDirectory);
    if (!(await stat(join(source, 'level.dat'))).isFile()) throw new Error('Select a Minecraft save folder containing level.dat.');
    let entries = 0, bytes = 0;
    const inspect = async directory => {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        if (++entries > 100000) throw new Error('The selected save contains too many files.');
        const path = join(directory, entry.name);
        if (entry.isSymbolicLink()) throw new Error('Save imports cannot contain symbolic links.');
        if (entry.isDirectory()) await inspect(path);
        else if (entry.isFile()) { bytes += (await stat(path)).size; if (bytes > 32 * 1024 ** 3) throw new Error('The selected save exceeds the 32 GiB import limit.'); }
        else throw new Error('Save imports can only contain regular files and folders.');
      }
    };
    await inspect(source);
    const world = await this.createWorld(options);
    try {
      await cp(source, join(this.worldPath(world.id), 'world'), { recursive: true, errorOnExist: true, force: false, filter: path => path !== join(source, 'session.lock') });
      world.imported = true; await this.writeWorld(world);
    } catch (error) { await rm(this.worldPath(world.id), { recursive: true, force: true }); throw error; }
    return world;
  }

  async configureWorld(world, port, username) {
    const directory = this.worldPath(world.id), backend = this.server;
    const viewDistance = backend.viewDistance ?? 8, simulationDistance = backend.simulationDistance ?? 6;
    if (![viewDistance, simulationDistance].every(value => Number.isInteger(value) && value >= 2 && value <= 32)) throw new Error('Local view and simulation distances must be 2 to 32 chunks.');
    if (backend.kind === 'vanilla') {
      if (!backend.jar || !(await stat(backend.jar)).isFile()) throw new Error('The configured Minecraft server JAR does not exist.');
      const eulaPath = backend.eulaPath ?? join(dirname(backend.jar), 'eula.txt');
      let eula;
      try { eula = await readFile(eulaPath, 'utf8'); } catch { throw new Error('The selected server needs an existing eula.txt with eula=true. Pomme does not accept license terms on your behalf.'); }
      if (!/^\s*eula\s*=\s*true\s*$/mi.test(eula)) throw new Error('The selected server eula.txt does not record acceptance.');
      await writeFile(join(directory, 'eula.txt'), eula, { mode: 0o600 });
      const memory = backend.memoryMiB ?? 1024;
      if (!Number.isInteger(memory) || memory < 512 || memory > 16384) throw new Error('Local server memory must be 512 to 16384 MiB.');
      const escapeProperty = value => String(value).replace(/\\/g, '\\\\').replace(/[=:#!]/g, character => `\\${character}`).replace(/^ /, '\\ ');
      const properties = { 'server-ip': '127.0.0.1', 'server-port': port, 'online-mode': false, 'enforce-secure-profile': false, 'enable-rcon': false, 'enable-query': false, 'max-players': 1, 'view-distance': viewDistance, 'simulation-distance': simulationDistance, 'spawn-protection': 0, 'level-name': 'world', 'level-seed': world.seed, gamemode: world.gameMode, difficulty: world.difficulty, hardcore: Boolean(world.hardcore), motd: world.name, 'sync-chunk-writes': true };
      await writeFile(join(directory, 'server.properties'), Object.entries(properties).map(([key, value]) => `${key}=${escapeProperty(value)}`).join('\n') + '\n', { mode: 0o600 });
      await writeFile(join(directory, 'ops.json'), JSON.stringify(world.allowCommands ? [{ uuid: offlineUuid(username), name: username, level: 4, bypassesPlayerLimit: false }] : []), { mode: 0o600 });
      return ['-Xms512M', `-Xmx${memory}M`, '-jar', backend.jar, 'nogui'];
    }
    if (backend.kind === 'pumpkin') {
      const capitalize = value => value[0].toUpperCase() + value.slice(1);
      const text = `seed = ${JSON.stringify(world.seed)}\ndefault_gamemode = ${JSON.stringify(capitalize(world.gameMode))}\ndefault_difficulty = ${JSON.stringify(capitalize(world.difficulty))}\nhardcore = ${Boolean(world.hardcore)}\ndefault_level_name = "world"\nspawn_protection = 0\n\n[world.chunk]\ntype = "anvil"\n\n[world.chunk.compression]\nalgorithm = "ZLib"\nlevel = 6\n\n[networking.java]\naddress = "127.0.0.1:${port}"\nonline_mode = false\nencryption = false\nmax_players = 1\nview_distance = ${viewDistance}\nsimulation_distance = ${simulationDistance}\nmotd = ${JSON.stringify(world.name)}\n\n[networking.bedrock]\nenabled = false\n\n[networking.management]\nenabled = false\n\n[telemetry]\nenabled = false\n`;
      if (backend.configurationFormat === 'split' || backend.version === '1.21.11') {
        await mkdir(join(directory, 'config'), { recursive: true, mode: 0o700 });
        const basic = `java_edition = true\njava_edition_address = "127.0.0.1:${port}"\nbedrock_edition = false\nseed = ${JSON.stringify(world.seed)}\nmax_players = 1\nview_distance = ${viewDistance}\nsimulation_distance = ${simulationDistance}\ndefault_gamemode = ${JSON.stringify(capitalize(world.gameMode))}\ndefault_difficulty = ${JSON.stringify(capitalize(world.difficulty))}\nhardcore = ${Boolean(world.hardcore)}\ndefault_level_name = "world"\nonline_mode = false\nencryption = false\nmotd = ${JSON.stringify(world.name)}\n`;
        const features = '[world.chunk]\ntype = "anvil"\n\n[world.chunk.compression]\nalgorithm = "ZLib"\nlevel = 6\n\n[networking.rcon]\nenabled = false\n\n[networking.query]\nenabled = false\n';
        await writeFile(join(directory, 'config', 'configuration.toml'), basic, { mode: 0o600 });
        await writeFile(join(directory, 'config', 'features.toml'), features, { mode: 0o600 });
      } else await writeFile(join(directory, 'pumpkin.toml'), text, { mode: 0o600 });
      await mkdir(join(directory, 'data'), { recursive: true, mode: 0o700 });
      const bypassKey = backend.configurationFormat === 'split' || backend.version === '1.21.11' ? 'bypasses_player_limit' : 'bypassesPlayerLimit';
      await writeFile(join(directory, 'data', 'ops.json'), JSON.stringify(world.allowCommands ? [{ uuid: pumpkinOfflineUuid(username), name: username, level: 4, [bypassKey]: false }] : []), { mode: 0o600 });
    }
    return (backend.args ?? []).map(value => String(value).replaceAll('{port}', String(port)).replaceAll('{world}', directory));
  }

  async startWorld(id, { username = 'Pomme' } = {}) {
    if (this.closed) throw new Error('The local server manager is closed.');
    if (this.active) throw new Error('Save and stop the current world before opening another.');
    const issue = compatibilityError(this.server, this.clientVersion);
    if (issue) throw new Error(issue);
    if (!Number.isInteger(this.protocolVersion)) throw new Error('The configured client protocol number is unknown.');
    if (typeof username !== 'string' || !/^[A-Za-z0-9_]{1,16}$/.test(username)) throw new Error('Use a Minecraft player name with 1 to 16 letters, numbers or underscores.');
    const active = { phase: 'starting', world: null, port: null, child: null, logs: [], exit: null };
    this.active = active; this.lastError = null; this.lastLogs = [];
    try {
      active.world = await this.readWorld(id);
      if (active.world.version !== this.clientVersion) throw new Error(`This world was created for Java ${active.world.version}.`);
      active.port = await availablePort();
      const args = await this.configureWorld(active.world, active.port, username);
      if (this.active !== active || active.phase !== 'starting') throw new Error('Local world startup was cancelled.');
      const child = spawn(this.server.command, args, { cwd: this.worldPath(id), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, shell: false, env: { ...process.env, POMME_SINGLEPLAYER_WORLD: this.worldPath(id), POMME_SINGLEPLAYER_PORT: String(active.port) } });
      active.child = child;
      child.stdin.on('error', () => {});
      let line = '';
      const log = chunk => {
        line = (line + chunk.toString()).slice(-32768);
        const lines = line.split(/\r?\n/); line = lines.pop();
        active.logs.push(...lines.map(value => value.slice(0, 2048))); active.logs.splice(0, Math.max(0, active.logs.length - 128));
      };
      child.stdout.on('data', log); child.stderr.on('data', log);
      active.exited = new Promise(done => {
        child.once('error', error => { active.exit = { error: error.message }; done(active.exit); });
        child.once('exit', (code, signal) => { active.exit = { code, signal }; done(active.exit); });
      });
      const deadline = Date.now() + this.startupTimeoutMs;
      let status;
      while (Date.now() < deadline && !active.exit && active.phase === 'starting' && this.active === active) {
        try { status = await pingSingleplayerServer(active.port, this.protocolVersion); } catch { await sleep(150); continue; }
        if (status.version?.protocol !== this.protocolVersion) throw new Error(`The local server reports Java ${status.version?.name ?? 'unknown'} (protocol ${status.version?.protocol ?? 'unknown'}); this client requires protocol ${this.protocolVersion}.`);
        break;
      }
      if (!status) throw new Error(active.exit ? `The local server exited during startup: ${active.logs.slice(-8).join('\n') || active.exit.error || active.exit.code}` : 'The local server did not become ready before the startup timeout.');
      if (this.active !== active || active.phase !== 'starting' || active.exit) throw new Error('Local world startup was cancelled.');
      active.phase = 'running'; active.world.lastPlayed = new Date().toISOString();
      await this.writeWorld(active.world);
      active.exited.then(exit => {
        if (this.active !== active || active.phase === 'stopping') return;
        this.lastLogs = active.logs.slice();
        this.lastError = `The local server stopped unexpectedly (${exit.error ?? exit.code ?? exit.signal}).`;
        this.active = null;
      });
      return { world: active.world, host: '127.0.0.1', port: active.port, version: this.clientVersion, auth: 'offline', username };
    } catch (error) {
      this.lastError = error.message;
      if (this.active === active) await this.stopWorld();
      throw error;
    }
  }

  async stopWorld() {
    const active = this.active;
    if (!active) return { saved: true, stopped: true };
    if (active.stopping) return active.stopping;
    active.phase = 'stopping';
    active.stopping = (async () => {
      let forced = false;
      if (active.child && !active.exit) {
        active.child.stdin.write('stop\n');
        let timeout;
        await Promise.race([active.exited, new Promise(done => { timeout = setTimeout(done, this.stopTimeoutMs); })]);
        clearTimeout(timeout);
        if (!active.exit) {
          forced = true; active.child.kill('SIGTERM');
          await Promise.race([active.exited, sleep(2000)]);
          if (!active.exit) { active.child.kill('SIGKILL'); await active.exited; }
        }
      }
      this.lastLogs = active.logs.slice();
      if (this.active === active) this.active = null;
      const saved = !forced && (!active.exit || active.exit.code === 0);
      if (!saved) this.lastError = 'The local server did not finish a clean save; inspect its log before reopening the world.';
      return { saved, stopped: true, forced };
    })();
    return active.stopping;
  }

  async close() { this.closed = true; return this.stopWorld(); }
}

/** Browser control stays on loopback and only accepts the client origin. */
export async function createSingleplayerService({ manager = new SingleplayerManager(), host = '127.0.0.1', port = 5175, origins = ['http://127.0.0.1:5173', 'http://localhost:5173'] } = {}) {
  if (!['127.0.0.1', '::1', 'localhost'].includes(host)) throw new Error('The singleplayer service must bind to loopback.');
  const trustedOrigins = new Set(origins), token = randomBytes(32).toString('hex');
  const server = createServer(async (request, response) => {
    const origin = request.headers.origin, trusted = trustedOrigins.has(origin);
    const finish = (status, value) => { response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); response.end(JSON.stringify(value)); };
    if (origin && !trusted) { finish(403, { error: 'This browser origin is not allowed.' }); return; }
    if (trusted) { response.setHeader('Access-Control-Allow-Origin', origin); response.setHeader('Vary', 'Origin'); }
    if (request.method === 'OPTIONS') { response.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS'); response.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Pomme-Singleplayer-Token'); response.writeHead(trusted ? 204 : 403); response.end(); return; }
    try {
      const path = new URL(request.url, 'http://singleplayer.local').pathname;
      if (request.method === 'GET' && path === '/status') { finish(200, { ...manager.status(), ...(trusted ? { controlToken: token } : {}) }); return; }
      if (request.method === 'GET' && path === '/worlds') { finish(200, { worlds: await manager.listWorlds() }); return; }
      const supplied = request.headers['x-pomme-singleplayer-token'];
      if (request.method !== 'POST' || !trusted || typeof supplied !== 'string' || supplied.length !== token.length || !timingSafeEqual(Buffer.from(supplied), Buffer.from(token))) { finish(403, { error: 'Local world actions require the client origin and control token.' }); return; }
      let raw = '', size = 0;
      for await (const chunk of request) { size += chunk.length; if (size > 32768) throw new Error('The local world request is too large.'); raw += chunk.toString('utf8'); }
      const body = raw ? JSON.parse(raw) : {};
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('Local world requests must be JSON objects.');
      if (path === '/worlds') { finish(201, { world: await manager.createWorld(body) }); return; }
      if (path === '/worlds/import') {
        if (typeof body.sourceDirectory !== 'string' || !body.sourceDirectory || body.sourceDirectory.length > 4096) throw new Error('Select a local Minecraft save folder.');
        const { sourceDirectory, ...options } = body;
        finish(201, { world: await manager.importWorld(sourceDirectory, options) }); return;
      }
      if (path === '/stop') { finish(200, await manager.stopWorld()); return; }
      const match = /^\/worlds\/([^/]+)\/start$/.exec(path);
      if (match) { finish(200, await manager.startWorld(match[1], body)); return; }
      finish(404, { error: 'Unknown local world action.' });
    } catch (error) { finish(400, { error: error.message }); }
  });
  await new Promise((done, fail) => { server.once('error', fail); server.listen(port, host, done); });
  return { manager, address: server.address(), close: async () => { await manager.close(); await new Promise((done, fail) => { server.closeIdleConnections(); server.close(error => error ? fail(error) : done()); }); } };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const server = serverFromEnvironment();
  const service = await createSingleplayerService({ manager: new SingleplayerManager({ savesDir: process.env.POMME_SAVES_DIR, server, clientVersion: process.env.POMME_SINGLEPLAYER_CLIENT_VERSION ?? server?.version ?? SINGLEPLAYER_VERSION }), port: Number(process.env.POMME_SINGLEPLAYER_PORT ?? 5175) });
  console.log(`Pomme local worlds: http://127.0.0.1:${service.address.port}`);
  let closing = false;
  const stop = async () => { if (closing) return; closing = true; await service.close(); process.exit(0); };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
}
