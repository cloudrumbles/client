export const MAX_PENDING_REQUESTS = 128, MAX_PENDING_BYTES = 32 * 1024 * 1024, MAX_METADATA_BYTES = 4 * 1024 * 1024;

/** Bounded accounting covers shared references and rejects excessively deep data. */
export function structuredBytes(value, limit = MAX_PENDING_BYTES) {
  const queue = [[value, 0]], seen = new Set(); let bytes = 0, visited = 0;
  while (queue.length) {
    const [entry, depth] = queue.pop();
    if (++visited > 300000 || depth > 64) throw new Error('Browser authority structured data exceeds its complexity limit.');
    if (entry == null) bytes += 4;
    else if (typeof entry === 'string') bytes += entry.length * 2;
    else if (typeof entry !== 'object') bytes += 8;
    else if (ArrayBuffer.isView(entry)) bytes += entry.byteLength;
    else if (entry instanceof ArrayBuffer) bytes += entry.byteLength;
    else {
      if (seen.has(entry)) continue;
      seen.add(entry); bytes += 16;
      if (entry instanceof Map) for (const [key, item] of entry) queue.push([key, depth + 1], [item, depth + 1]);
      else if (entry instanceof Set) for (const item of entry) queue.push([item, depth + 1]);
      else for (const [key, item] of Object.entries(entry)) { bytes += key.length * 2; queue.push([item, depth + 1]); }
    }
    if (bytes > limit) throw new Error('Browser authority structured data exceeds its memory limit.');
  }
  return bytes;
}
export function columnMetadata(column) {
  const { x, z, blockEntities, heightmaps } = column;
  return { x, z, ...(blockEntities ? { blockEntities } : {}), ...(heightmaps ? { heightmaps } : {}), sections: column.sections.map(({ sectionY, biomes }) => ({ sectionY, ...(biomes ? { biomes } : {}) })) };
}
