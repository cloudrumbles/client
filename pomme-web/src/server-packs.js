import { textComponent } from './minecraft.js';

export const PACK_STATUS = Object.freeze({ SUCCESS: 0, DECLINED: 1, DOWNLOAD_FAILED: 2, ACCEPTED: 3, DOWNLOADED: 4, INVALID_URL: 5, RELOAD_FAILED: 6, DISCARDED: 7 });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function resourcePackDownloadURL(gatewayUrl, request) {
  const gateway = new URL(gatewayUrl);
  if (gateway.protocol === 'ws:') gateway.protocol = 'http:';
  else if (gateway.protocol === 'wss:') gateway.protocol = 'https:';
  if (!['http:', 'https:'].includes(gateway.protocol)) throw new Error('Invalid Minecraft gateway URL');
  const path = request.download?.path;
  if (typeof path !== 'string' || !path.startsWith(`/resource-pack/${request.uuid}?`)) throw new Error('The gateway did not authorize this server pack download');
  const url = new URL(path, gateway);
  if (url.origin !== gateway.origin || !/^[a-f0-9]{64}$/.test(url.searchParams.get('capability') ?? '')) throw new Error('Invalid server pack download capability');
  const token = gateway.searchParams.get('token'); if (token) url.searchParams.set('token', token);
  return url.href;
}

export async function fetchResourcePack(url, { fetcher = globalThis.fetch, signal, maxBytes = 256 * 1024 * 1024, hash = '', onProgress = () => {} } = {}) {
  const response = await fetcher(url, { signal, credentials: 'omit', referrerPolicy: 'no-referrer' });
  if (!response.ok) { const message = (await response.text()).slice(0, 512); throw new Error(message || `Resource pack download returned HTTP ${response.status}`); }
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) throw new Error('Server resource pack exceeds the file limit');
  const chunks = []; let length = 0;
  if (response.body) {
    const reader = response.body.getReader();
    try {
      for (;;) {
        if (signal?.aborted) throw signal.reason ?? new DOMException('Resource pack cancelled', 'AbortError');
        const { value, done } = await reader.read(); if (done) break;
        length += value.length; if (length > maxBytes) throw new Error('Server resource pack exceeds the file limit');
        chunks.push(value); onProgress(length, declared || null);
      }
    } catch (error) { await reader.cancel().catch(() => {}); throw error; }
    finally { reader.releaseLock(); }
  } else { const value = new Uint8Array(await response.arrayBuffer()); if (value.length > maxBytes) throw new Error('Server resource pack exceeds the file limit'); chunks.push(value); length = value.length; }
  if (!length) throw new Error('Server resource pack was empty');
  const bytes = new Uint8Array(length); let cursor = 0; for (const chunk of chunks) { bytes.set(chunk, cursor); cursor += chunk.length; }
  if (hash) {
    if (!/^[0-9a-f]{40}$/i.test(hash)) throw new Error('Invalid server resource pack SHA-1');
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-1', bytes));
    const actual = Array.from(digest, value => value.toString(16).padStart(2, '0')).join('');
    if (actual !== hash.toLowerCase()) throw new Error('Server resource pack SHA-1 does not match');
  }
  return bytes;
}

/** Native server pack choice/statuses and ordered stacks; no arbitrary URL fetch. */
export class ServerResourcePacks {
  constructor({ session, gatewayUrl, preference = 'prompt', applyPacks = async () => {}, onStatus = () => {}, fetcher = globalThis.fetch, document = globalThis.document, prompt = null, maxBytes = 256 * 1024 * 1024, maxTotalBytes = 256 * 1024 * 1024, maxPacks = 64 } = {}) {
    this.session = session; this.gatewayUrl = gatewayUrl; this.preference = preference; this.applyPacks = applyPacks; this.onStatus = onStatus; this.fetcher = fetcher; this.document = document; this.promptHandler = prompt;
    this.maxBytes = maxBytes; this.maxTotalBytes = maxTotalBytes; this.maxPacks = maxPacks;
    this.packs = new Map(); this.tail = Promise.resolve(); this.revision = 0; this.generation = 0; this.dialog = null; this.dialogClose = null; this.closed = false; this.bytes = 0;
  }
  status(request, result) {
    if (request.discarded && result !== PACK_STATUS.DISCARDED || request.lastStatus === result) return;
    request.lastStatus = result;
    this.session?.packet('resource_pack_receive', { uuid: request.uuid, result });
  }
  current(request) { return !this.closed && this.packs.get(request.uuid) === request && !request.discarded; }
  event(event) {
    if (this.closed) return Promise.resolve();
    if (event.type === 'remove-resource-pack') return this.remove(event.uuid);
    if (event.type !== 'resource-pack') return Promise.resolve();
    const request = { ...event, controller: new AbortController(), discarded: false, loaded: false, file: null, bytes: 0, lastStatus: null };
    if (!UUID.test(request.uuid ?? '')) { this.onStatus('The server sent an invalid resource pack identity.'); return Promise.resolve(); }
    const previous = this.packs.get(request.uuid), replacedLoadedPack = Boolean(previous?.file); if (previous) this.discard(previous);
    if (this.packs.size >= this.maxPacks) { this.status(request, PACK_STATUS.DOWNLOAD_FAILED); this.onStatus('Too many server resource packs.'); return Promise.resolve(); }
    this.packs.set(request.uuid, request); this.revision++;
    const operation = this.tail.then(async () => { if (replacedLoadedPack) await this.reload(); await this.add(request); }); this.tail = operation.catch(error => this.onStatus(error.message)); return operation;
  }
  async decide(request) {
    if (this.preference === 'enabled') return true;
    if (this.preference === 'disabled' && !request.forced) return false;
    if (this.promptHandler) return Boolean(await this.promptHandler(request, request.controller.signal));
    if (!this.document) return false;
    return new Promise(resolve => {
      const doc = this.document, dialog = doc.createElement('dialog'); this.dialog = dialog;
      dialog.className = 'pomme-server-resource-pack'; dialog.setAttribute('aria-labelledby', 'server-resource-pack-heading');
      dialog.style.cssText = 'color:#e8e8df;background:#171c20;border:2px solid #7d8989;padding:24px;max-width:540px;width:calc(100% - 48px);font:inherit;box-shadow:0 16px 60px #000b;';
      const heading = doc.createElement('h2'); heading.id = 'server-resource-pack-heading'; heading.textContent = request.forced ? 'This server requires a resource pack' : 'Server resource pack';
      const message = doc.createElement('p'); message.textContent = textComponent(request.promptMessage) || 'Use the textures, models and sounds requested by this server?';
      const source = doc.createElement('p'); source.textContent = request.url; source.style.cssText = 'overflow-wrap:anywhere;color:#a8b5b4;font-size:13px';
      const consequence = doc.createElement('p'); consequence.textContent = request.forced ? 'Declining this pack disconnects you from this server.' : 'You can keep playing with your current resource packs if you decline.';
      const actions = doc.createElement('div'); actions.style.cssText = 'display:flex;gap:12px;justify-content:flex-end;margin-top:20px';
      const accept = doc.createElement('button'); accept.textContent = 'Download and use'; accept.type = 'button'; accept.dataset.action = 'accept';
      const decline = doc.createElement('button'); decline.textContent = request.forced ? 'Disconnect' : 'Decline'; decline.type = 'button'; decline.dataset.action = 'decline';
      for (const button of [decline, accept]) button.style.cssText = 'font:inherit;color:inherit;background:#354345;border:1px solid #899897;padding:10px 14px;cursor:pointer';
      let finished = false;
      const close = accepted => { if (finished) return; finished = true; request.controller.signal.removeEventListener('abort', abort); dialog.close?.(); dialog.remove(); if (this.dialog === dialog) { this.dialog = null; this.dialogClose = null; } resolve(accepted); };
      const abort = () => close(false); this.dialogClose = close;
      accept.onclick = () => close(true); decline.onclick = () => close(false); dialog.addEventListener('cancel', event => { event.preventDefault(); close(false); });
      request.controller.signal.addEventListener('abort', abort, { once: true });
      actions.append(decline, accept); dialog.append(heading, message, source, consequence, actions); doc.body.append(dialog); dialog.showModal(); accept.focus();
      if (doc.pointerLockElement) doc.exitPointerLock?.();
    });
  }
  async add(request) {
    if (!this.current(request)) return;
    let url;
    try {
      const advertised = new URL(request.url);
      if (!['http:', 'https:'].includes(advertised.protocol) || advertised.username || advertised.password) throw new Error('The server pack URL is invalid');
      if (request.downloadError) { this.status(request, request.downloadStatus ?? PACK_STATUS.INVALID_URL); this.onStatus(request.downloadError); return; }
      url = resourcePackDownloadURL(this.gatewayUrl, request);
    } catch (error) { this.status(request, PACK_STATUS.INVALID_URL); this.onStatus(error.message); return; }
    const accepted = await this.decide(request);
    if (!this.current(request)) return;
    if (!accepted) {
      this.status(request, PACK_STATUS.DECLINED); this.packs.delete(request.uuid); this.revision++;
      if (request.forced) { this.onStatus('Disconnected: this server requires its resource pack.'); this.session?.disconnect(); }
      return;
    }
    this.status(request, PACK_STATUS.ACCEPTED); this.onStatus('Downloading server resource pack…');
    try {
      const bytes = await fetchResourcePack(url, { fetcher: this.fetcher, signal: request.controller.signal, maxBytes: Math.min(this.maxBytes, request.download.maxBytes ?? this.maxBytes), hash: request.hash ?? '', onProgress: (loaded, total) => this.onStatus(`Downloading server resource pack: ${(loaded / 1048576).toFixed(1)} MB${total ? ` / ${(total / 1048576).toFixed(1)} MB` : ''}`) });
      if (!this.current(request)) return;
      if (this.bytes + bytes.length > this.maxTotalBytes) throw new Error('Server resource packs exceed the total file limit');
      request.file = new File([bytes], `server-${request.uuid}.zip`, { type: 'application/zip' }); request.bytes = bytes.length; this.bytes += bytes.length; this.revision++;
      this.status(request, PACK_STATUS.DOWNLOADED);
    } catch (error) { if (this.current(request)) { this.status(request, PACK_STATUS.DOWNLOAD_FAILED); this.onStatus(`Server resource pack download failed: ${error.message}`); } return; }
    try { await this.reload(); }
    catch (error) {
      if (!this.current(request)) return;
      this.status(request, PACK_STATUS.RELOAD_FAILED); this.onStatus(`Server resource pack could not be loaded: ${error.message}`);
      this.bytes -= request.bytes; request.file = null; request.bytes = 0; this.revision++;
      try { await this.reload(); } catch (restoreError) { this.onStatus(restoreError.message); }
    }
  }
  async reload() {
    for (;;) {
      if (this.closed) return;
      const revision = this.revision, active = [...this.packs.values()].filter(request => request.file && !request.discarded);
      await this.applyPacks(active.map(request => request.file), { revision });
      if (this.closed) return;
      if (revision !== this.revision) continue;
      for (const request of active) if (!request.loaded && this.current(request)) { request.loaded = true; this.status(request, PACK_STATUS.SUCCESS); }
      this.onStatus(active.length ? `Using ${active.length} server resource pack${active.length === 1 ? '' : 's'}.` : 'Using your local resource packs.'); return;
    }
  }
  discard(request) {
    if (request.discarded) return;
    request.discarded = true; request.controller.abort(); this.status(request, PACK_STATUS.DISCARDED);
    this.bytes -= request.bytes; request.bytes = 0; request.file = null; this.packs.delete(request.uuid); this.revision++;
  }
  remove(uuid) {
    const selected = uuid === undefined || uuid === null ? [...this.packs.values()] : [this.packs.get(uuid)].filter(Boolean);
    for (const request of selected) this.discard(request);
    const operation = this.tail.then(() => this.reload()); this.tail = operation.catch(error => this.onStatus(error.message)); return operation;
  }
  clear({ reload = true } = {}) {
    this.generation++; for (const request of [...this.packs.values()]) this.discard(request);
    this.dialogClose?.(false);
    if (!reload) return Promise.resolve();
    const operation = this.tail.then(() => this.reload()); this.tail = operation.catch(error => this.onStatus(error.message)); return operation;
  }
  stats() { return { requested: this.packs.size, loaded: [...this.packs.values()].filter(request => request.loaded).length, bytes: this.bytes, preference: this.preference, prompting: this.dialog !== null }; }
  files() { return [...this.packs.values()].filter(request => request.file && !request.discarded).map(request => request.file); }
  destroy() { this.closed = true; return this.clear({ reload: false }); }
}
