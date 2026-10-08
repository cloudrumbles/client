import { BROWSER_PROTOCOL_VERSIONS } from './protocol-compat.js';

/** Connect the world picker to the loopback server lifecycle service. */
export class SingleplayerClient {
  constructor({ url = 'http://127.0.0.1:5175', fetch = globalThis.fetch.bind(globalThis) } = {}) {
    const endpoint = new URL(url);
    if (!['http:', 'https:'].includes(endpoint.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(endpoint.hostname) || endpoint.username || endpoint.password) throw new Error('Local worlds require a service URL on localhost.');
    this.url = endpoint.href.replace(/\/$/, ''); this.fetch = fetch; this.controlToken = null;
  }

  async request(method, path, body, timeoutMs = 10000) {
    if (method === 'POST' && !this.controlToken) await this.status();
    const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await this.fetch(`${this.url}${path}`, { method, mode: 'cors', credentials: 'omit', cache: 'no-store', signal: controller.signal,
        headers: method === 'POST' ? { 'Content-Type': 'application/json', 'X-Pomme-Singleplayer-Token': this.controlToken } : {},
        ...(method === 'POST' ? { body: JSON.stringify(body ?? {}) } : {}) });
      let result;
      try { result = await response.json(); } catch { throw new Error('The local worlds service returned an invalid response.'); }
      if (!response.ok) { if (response.status === 403) this.controlToken = null; throw new Error(result.error || `The local world action failed (${response.status}).`); }
      return result;
    } catch (error) {
      if (error.name === 'AbortError') throw new Error('The local world action timed out. Check the server status before trying again.');
      if (error instanceof TypeError) throw new Error('Cannot reach local worlds. Start the local worlds service, then refresh the world list.');
      throw error;
    } finally { clearTimeout(timeout); }
  }

  async status() {
    const status = await this.request('GET', '/status');
    if (status.service !== 'pomme-singleplayer') throw new Error('This URL is not the local worlds service.');
    if (typeof status.controlToken === 'string') this.controlToken = status.controlToken;
    return { ...status, supportedVersion: BROWSER_PROTOCOL_VERSIONS.includes(status.version) };
  }

  async listWorlds() { return (await this.request('GET', '/worlds')).worlds; }
  async createWorld(options) { return (await this.request('POST', '/worlds', options)).world; }
  async importWorld(sourceDirectory, options = {}) { return (await this.request('POST', '/worlds/import', { ...options, sourceDirectory }, 130000)).world; }
  async startWorld(id, options = {}) {
    if (!/^[a-f\d-]{36}$/.test(id)) throw new Error('Invalid local world ID.');
    return this.request('POST', `/worlds/${id}/start`, options, 130000);
  }
  async stopWorld() { return this.request('POST', '/stop', {}, 35000); }
}

export const SingleplayerService = SingleplayerClient;
