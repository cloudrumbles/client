// The gateway owns Minecraft TCP, encryption, compression and authentication.
// This module stays browser-only; packet buffers do not depend on Node Buffer.
export function encodeGatewayValue(value) {
  if (typeof value === 'bigint') return { __bigint: value.toString() };
  if (value instanceof Uint8Array || value instanceof ArrayBuffer) {
    const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
    let binary = '';
    for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
    return { __bytes: btoa(binary) };
  }
  if (Array.isArray(value)) return value.map(encodeGatewayValue);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, encodeGatewayValue(item)]));
  return value;
}

export function decodeGatewayValue(value) {
  if (Array.isArray(value)) return value.map(decodeGatewayValue);
  if (value && typeof value === 'object') {
    if (typeof value.__bigint === 'string' && Object.keys(value).length === 1) return BigInt(value.__bigint);
    if (typeof value.__bytes === 'string' && Object.keys(value).length === 1) {
      const binary = atob(value.__bytes);
      return Uint8Array.from(binary, (char) => char.charCodeAt(0));
    }
    // Support Buffer.toJSON from older gateways while preserving arbitrary NBT.
    if (value.type === 'Buffer' && Array.isArray(value.data)) return Uint8Array.from(value.data);
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, decodeGatewayValue(item)]));
  }
  return value;
}

export class GatewayTransport {
  constructor({ onMessage = () => {}, onClose = () => {}, onError = () => {}, socketFactory = (url) => new WebSocket(url) } = {}) {
    this.onMessage = onMessage;
    this.onClose = onClose;
    this.onError = onError;
    this.socketFactory = socketFactory;
    this.socket = null;
    this.pendingReject = null;
  }

  connect(url, options) {
    this.close();
    const socket = this.socketFactory(url);
    this.socket = socket;
    return new Promise((resolve, reject) => {
      this.pendingReject = reject;
      socket.addEventListener('open', () => {
        if (this.socket !== socket) return;
        this.pendingReject = null;
        this.send({ type: 'connect', ...options, version: options.version || '1.20.4' });
        resolve();
      }, { once: true });
      socket.addEventListener('message', (event) => {
        if (this.socket !== socket) return;
        try { this.onMessage(decodeGatewayValue(JSON.parse(event.data))); }
        catch (error) { this.onError(new Error(`Invalid gateway packet: ${error.message}`)); }
      });
      socket.addEventListener('error', () => {
        if (this.socket !== socket) return;
        this.pendingReject = null;
        const error = new Error('Cannot reach the Minecraft WebSocket gateway.');
        this.onError(error);
        reject(error);
      });
      socket.addEventListener('close', (event) => {
        if (this.socket !== socket) return;
        this.socket = null;
        this.pendingReject = null;
        this.onClose({ code: event.code, reason: event.reason || 'Gateway connection closed.' });
        reject(new Error(event.reason || 'Gateway connection closed before connecting.'));
      });
    });
  }

  send(message) {
    if (!this.socket || this.socket.readyState !== 1) return false;
    this.socket.send(JSON.stringify(encodeGatewayValue(message)));
    return true;
  }

  packet(name, data = {}) { return this.send({ type: 'packet', name, data }); }

  close() {
    const socket = this.socket;
    const reject = this.pendingReject;
    this.pendingReject = null;
    this.socket = null;
    if (socket && socket.readyState < 2) socket.close(1000, 'Client disconnected.');
    if (reject) { const error = new Error('Connection cancelled.'); error.name = 'AbortError'; reject(error); }
  }
}
