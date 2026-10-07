/** Strict, allocation-bounded Minecraft Java NBT decoder (big-endian). */
export function decodeNBT(input, options = {}) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const limits = { maxBytes: 64 * 1024 * 1024, maxDepth: 64, maxElements: 8_000_000, ...options };
  if (bytes.byteLength > limits.maxBytes) throw new Error('NBT exceeds the byte limit');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let offset = 0, elements = 0;
  const need = n => { if (n < 0 || offset + n > bytes.length) throw new Error('Truncated NBT'); };
  const u8 = () => { need(1); return view.getUint8(offset++); };
  const i8 = () => { need(1); return view.getInt8(offset++); };
  const i16 = () => { need(2); const n = view.getInt16(offset); offset += 2; return n; };
  const i32 = () => { need(4); const n = view.getInt32(offset); offset += 4; return n; };
  const string = () => {
    need(2); const n = view.getUint16(offset); offset += 2; need(n);
    let result;
    const encoded = bytes.subarray(offset, offset + n);
    try { result = decoder.decode(encoded); }
    catch {
      // Java DataOutput.writeUTF uses modified UTF-8: NUL is C0 80 and
      // supplementary characters use two independently encoded surrogates.
      const units = [];
      for (let i = 0; i < encoded.length;) {
        const a = encoded[i++];
        if (a < 128) { units.push(a); continue; }
        const b = encoded[i++];
        if (b === undefined || (b & 192) !== 128) throw new Error('NBT contains invalid UTF-8');
        if ((a & 224) === 192) {
          const unit = (a & 31) << 6 | b & 63;
          if (unit < 128 && !(a === 192 && b === 128)) throw new Error('NBT contains invalid UTF-8');
          units.push(unit);
        } else if ((a & 240) === 224) {
          const c = encoded[i++];
          if (c === undefined || (c & 192) !== 128) throw new Error('NBT contains invalid UTF-8');
          const unit = (a & 15) << 12 | (b & 63) << 6 | c & 63;
          if (unit < 2048) throw new Error('NBT contains invalid UTF-8');
          units.push(unit);
        } else if ((a & 248) === 240) {
          const c = encoded[i++], d = encoded[i++];
          if (c === undefined || d === undefined || (c & 192) !== 128 || (d & 192) !== 128) throw new Error('NBT contains invalid UTF-8');
          const point = (a & 7) << 18 | (b & 63) << 12 | (c & 63) << 6 | d & 63;
          if (point < 65536 || point > 0x10ffff) throw new Error('NBT contains invalid UTF-8');
          units.push(0xd800 + ((point - 65536) >> 10), 0xdc00 + ((point - 65536) & 1023));
        } else throw new Error('NBT contains invalid UTF-8');
      }
      result = '';
      for (let i = 0; i < units.length; i += 8192) result += String.fromCharCode(...units.slice(i, i + 8192));
    }
    offset += n; return result;
  };
  const count = (width = 1) => {
    const n = i32();
    if (n < 0 || n > limits.maxElements - elements) throw new Error('NBT array/list exceeds the element limit');
    elements += n; need(n * width); return n;
  };
  function value(type, depth) {
    if (depth > limits.maxDepth) throw new Error('NBT nesting exceeds the depth limit');
    if (++elements > limits.maxElements) throw new Error('NBT exceeds the element limit');
    switch (type) {
      case 1: return i8();
      case 2: return i16();
      case 3: return i32();
      case 4: { need(8); const n = view.getBigInt64(offset); offset += 8; return n; }
      case 5: { need(4); const n = view.getFloat32(offset); offset += 4; return n; }
      case 6: { need(8); const n = view.getFloat64(offset); offset += 8; return n; }
      case 7: { const n = count(); const result = bytes.slice(offset, offset + n); offset += n; return result; }
      case 8: return string();
      case 9: {
        const elementType = u8(), n = count(0);
        if (elementType > 12 || (elementType === 0 && n !== 0)) throw new Error('Invalid NBT list type');
        const result = new Array(n);
        for (let i = 0; i < n; i++) result[i] = value(elementType, depth + 1);
        return result;
      }
      case 10: {
        // Null prototype prevents untrusted tag names from altering prototypes.
        const result = Object.create(null);
        while (true) {
          const childType = u8();
          if (childType === 0) return result;
          if (childType > 12) throw new Error('Invalid NBT tag type');
          const name = string();
          if (Object.hasOwn(result, name)) throw new Error(`Duplicate NBT tag: ${name}`);
          result[name] = value(childType, depth + 1);
        }
      }
      case 11: { const n = count(4), result = new Int32Array(n); for (let i = 0; i < n; i++) result[i] = i32(); return result; }
      case 12: {
        const n = count(8), result = new BigInt64Array(n);
        for (let i = 0; i < n; i++) { result[i] = view.getBigInt64(offset); offset += 8; }
        return result;
      }
      default: throw new Error(`Invalid NBT tag type: ${type}`);
    }
  }
  const type = u8();
  if (type === 0 || type > 12) throw new Error('Invalid NBT root type');
  const name = options.named === false ? '' : string();
  const result = value(type, 0);
  if (options.allowTrailing !== true && offset !== bytes.length) throw new Error('Trailing bytes after NBT root');
  return { name, value: result, bytesRead: offset, type };
}
