import minecraftData from 'minecraft-data';

// 26.1 BundleContents uses ItemStackTemplate.STREAM_CODEC, whose item/count
// order and non-empty layout differ from Slot. Install before protocol caches.
export function installNativeCodecs(version) {
  if (version !== '26.1') return;
  const protocol = minecraftData(version).protocol;
  // The dependency's historical VarLong aliases its32-bit VarInt. World
  // clock packets require all64 source bits; ProtoDef supplies that codec.
  protocol.types.varlong = 'varint64';
  const fields = protocol.types.SlotComponent[1].find(field => field.name === 'data').type[1].fields;
  const contents = fields.bundle_contents[1].find(field => field.name === 'contents');
  contents.type[1].type = 'ItemStackTemplate';
}
