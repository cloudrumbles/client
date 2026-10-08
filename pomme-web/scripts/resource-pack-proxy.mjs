import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const constantEquals = (left, right) => { const a = Buffer.from(left ?? ''), b = Buffer.from(right ?? ''); return a.length === b.length && timingSafeEqual(a, b); };
const legacyUUID = value => { const hex = createHash('sha1').update(value).digest('hex').slice(0, 32); return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`; };

export function validPackURL(value) {
  if (typeof value !== 'string' || value.length > 8192) throw new Error('Invalid resource pack URL');
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || !url.hostname) throw new Error('Server resource packs require an HTTP or HTTPS URL without credentials');
  url.hash = ''; return url;
}
export function publicAddress(address) {
  if (isIP(address) === 4) {
    const [a, b, c] = address.split('.').map(Number);
    return a !== 0 && a !== 10 && a !== 127 && a < 224 && !(a === 169 && b === 254) && !(a === 100 && b >= 64 && b <= 127) && !(a === 172 && b >= 16 && b <= 31) && !(a === 192 && (b === 168 || b === 0 && c === 0)) && !(a === 198 && (b === 18 || b === 19));
  }
  if (isIP(address) !== 6) return false;
  const normalized = address.toLowerCase();
  if (normalized.startsWith('::ffff:')) return publicAddress(normalized.slice(7));
  return normalized !== '::' && normalized !== '::1' && !/^(?:f[cd]|fe[89ab]|ff|2001:db8:)/.test(normalized);
}

async function addressFor(url, allowPrivateHosts, resolver, signal) {
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  const addresses = isIP(host) ? [{ address: host, family: isIP(host) }] : await new Promise((resolve, reject) => {
    const abort = () => reject(new Error('Resource pack DNS request cancelled'));
    if (signal.aborted) { abort(); return; }
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve().then(() => resolver(host, { all: true, verbatim: true })).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
  if (!addresses.length || !allowPrivateHosts.has(host) && addresses.some(entry => !publicAddress(entry.address))) throw new Error('The server pack URL resolves to a private network address');
  return addresses[0];
}

/** The HTTP route can download only capabilities created by a server packet. */
export function createResourcePackProxy({ token = '', allowedOrigins = [], allowPrivateHosts = [], maxBytes = 256 * 1024 * 1024, maxTotalBytes = 512 * 1024 * 1024, maxPacks = 64, timeoutMs = 60000, capabilityLifetimeMs = 15 * 60 * 1000, maxRedirects = 3, resolver = lookup, now = Date.now } = {}) {
  const entries = new Map(), byConnection = new Map(), hosts = new Set(allowPrivateHosts.map(host => host.toLowerCase()));
  let cachedBytes = 0, inFlightBytes = 0, activeDownloads = 0, closed = false;
  function remove(entry) {
    if (!entry || !entries.delete(entry.capability)) return;
    entry.controller?.abort(); if (entry.buffer) cachedBytes -= entry.buffer.length;
    const connection = byConnection.get(entry.connectionId); if (connection?.get(entry.uuid) === entry) connection.delete(entry.uuid);
    if (!connection?.size) byConnection.delete(entry.connectionId);
  }
  function cleanup(connectionId) {
    if (connectionId === undefined) { for (const entry of [...entries.values()]) remove(entry); return; }
    for (const entry of byConnection.get(connectionId)?.values() ?? []) remove(entry);
  }
  function removeAdvertisedPack(uuid, connectionId) {
    if (uuid === undefined || uuid === null) return cleanup(connectionId);
    remove(byConnection.get(connectionId)?.get(uuid));
  }
  function registerAdvertisedPack(packet, connectionId) {
    const uuid = packet.uuid ?? legacyUUID(`${packet.url ?? ''}:${packet.hash ?? ''}`);
    if (closed || typeof connectionId !== 'string' || !connectionId || !UUID.test(uuid)) return { ...packet, uuid, downloadError: 'Invalid resource pack request identity', downloadStatus: 5 };
    removeAdvertisedPack(uuid, connectionId);
    let url;
    try { url = validPackURL(packet.url); }
    catch (error) { return { ...packet, uuid, downloadError: error.message, downloadStatus: 5 }; }
    if (packet.hash && !/^[0-9a-f]{40}$/i.test(packet.hash)) return { ...packet, uuid, downloadError: 'Invalid resource pack SHA-1', downloadStatus: 2 };
    for (const entry of [...entries.values()]) if (entry.expiresAt <= now()) remove(entry);
    if (entries.size >= maxPacks) return { ...packet, uuid, downloadError: 'Too many advertised resource packs', downloadStatus: 2 };
    const capability = randomBytes(32).toString('hex'), expiresAt = now() + capabilityLifetimeMs;
    const entry = { capability, uuid, connectionId, url, hash: packet.hash?.toLowerCase() ?? '', expiresAt, controller: null, pending: null, buffer: null };
    entries.set(capability, entry);
    if (!byConnection.has(connectionId)) byConnection.set(connectionId, new Map());
    byConnection.get(connectionId).set(uuid, entry);
    return { ...packet, uuid, download: { path: `/resource-pack/${uuid}?capability=${capability}`, expiresAt, maxBytes } };
  }
  async function fetchURL(url, signal, budget, redirects = 0) {
    const address = await addressFor(url, hosts, resolver, signal);
    if (signal.aborted) throw new Error('Resource pack request cancelled');
    return new Promise((resolve, reject) => {
      const request = (url.protocol === 'https:' ? httpsRequest : httpRequest)(url, {
        signal, headers: { Accept: 'application/zip, application/octet-stream', 'Accept-Encoding': 'identity', 'User-Agent': 'Pomme-Web resource-pack client' },
        lookup: (_host, options, callback) => callback(null, ...(options.all ? [[address]] : [address.address, address.family])),
      }, response => {
        if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
          response.resume();
          if (redirects >= maxRedirects || !response.headers.location) { reject(new Error('Resource pack redirect limit exceeded')); return; }
          let destination;
          try { destination = validPackURL(new URL(response.headers.location, url).href); } catch (error) { reject(error); return; }
          resolve(fetchURL(destination, signal, budget, redirects + 1)); return;
        }
        if (response.statusCode !== 200) { response.resume(); reject(new Error(`Resource pack server returned HTTP ${response.statusCode}`)); return; }
        const declared = Number(response.headers['content-length']);
        if (Number.isFinite(declared) && declared > maxBytes || response.headers['content-encoding'] && response.headers['content-encoding'] !== 'identity') { response.destroy(); reject(new Error('Resource pack exceeds the download limit or uses unsupported HTTP compression')); return; }
        const chunks = []; let length = 0;
        response.on('data', chunk => {
          length += chunk.length;
          if (length > maxBytes || cachedBytes + inFlightBytes + chunk.length > maxTotalBytes) { response.destroy(new Error('Resource pack exceeds the download or total memory limit')); return; }
          chunks.push(chunk); budget.bytes += chunk.length; inFlightBytes += chunk.length;
        });
        response.once('end', () => { if (!length) reject(new Error('Resource pack download was empty')); else resolve(Buffer.concat(chunks, length)); });
        response.once('error', reject);
        response.once('aborted', () => reject(new Error('Resource pack download was interrupted')));
      });
      request.setTimeout(timeoutMs, () => request.destroy(new Error('Resource pack download timed out'))); request.once('error', reject); request.end();
    });
  }
  async function download(entry) {
    if (entry.buffer) return entry.buffer;
    if (entry.pending) return entry.pending;
    if (activeDownloads >= 4) throw new Error('Too many active resource pack downloads');
    entry.controller = new AbortController(); const timer = setTimeout(() => entry.controller.abort(), timeoutMs); timer.unref?.(); activeDownloads++;
    const budget = { bytes: 0 };
    entry.pending = fetchURL(entry.url, entry.controller.signal, budget).then(buffer => {
      if (!entries.has(entry.capability)) throw new Error('Resource pack request expired');
      if (entry.hash && createHash('sha1').update(buffer).digest('hex') !== entry.hash) throw new Error('Resource pack SHA-1 does not match the server request');
      if (cachedBytes + buffer.length > maxTotalBytes) throw new Error('Resource pack cache exceeds its memory limit');
      entry.buffer = buffer; cachedBytes += buffer.length; return buffer;
    }).finally(() => { clearTimeout(timer); activeDownloads--; inFlightBytes -= budget.bytes; entry.pending = null; entry.controller = null; });
    return entry.pending;
  }
  async function handleRequest(req, res, originAllowlist = allowedOrigins) {
    let url;
    try { url = new URL(req.url, 'http://gateway.local'); } catch { return false; }
    if (!url.pathname.startsWith('/resource-pack/')) return false;
    const origins = originAllowlist instanceof Set ? originAllowlist : new Set(originAllowlist);
    const origin = req.headers.origin;
    const headers = { 'Cache-Control': 'no-store', 'Cross-Origin-Resource-Policy': 'cross-origin', 'X-Content-Type-Options': 'nosniff' };
    if (!origins.has(origin) || !constantEquals(url.searchParams.get('token'), token)) { res.writeHead(403, headers).end('Resource pack access denied'); return true; }
    Object.assign(headers, { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' });
    if (req.method === 'OPTIONS') { res.writeHead(204, { ...headers, 'Access-Control-Allow-Methods': 'GET', 'Access-Control-Max-Age': '60' }).end(); return true; }
    if (req.method !== 'GET') { res.writeHead(405, { ...headers, Allow: 'GET' }).end(); return true; }
    const capability = url.searchParams.get('capability'), entry = entries.get(capability), uuid = url.pathname.slice('/resource-pack/'.length);
    if (!entry || uuid !== entry.uuid || entry.expiresAt <= now()) { if (entry?.expiresAt <= now()) remove(entry); res.writeHead(404, headers).end('The server pack request is no longer active'); return true; }
    try {
      const buffer = await download(entry);
      res.writeHead(200, { ...headers, 'Content-Type': 'application/zip', 'Content-Length': buffer.length, 'X-Resource-Pack-SHA1': createHash('sha1').update(buffer).digest('hex') }); res.end(buffer);
    } catch (error) { if (!res.destroyed) res.writeHead(502, { ...headers, 'Content-Type': 'text/plain' }).end(error.message); }
    return true;
  }
  return { registerAdvertisedPack, removeAdvertisedPack, handleRequest, cleanup, stats: () => ({ advertisedPacks: entries.size, activeDownloads, inFlightBytes, cachedBytes, maxBytes, maxTotalBytes }), close() { closed = true; cleanup(); } };
}
