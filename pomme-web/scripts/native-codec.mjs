import minecraftData from 'minecraft-data';

// 26.1 BundleContents uses ItemStackTemplate.STREAM_CODEC, whose item/count
// order and non-empty layout differ from Slot. Install before protocol caches.
export function installNativeCodecs(version) {
  if (version !== '26.1') return;
  const protocol = minecraftData(version).protocol;
  const fields = protocol.types.SlotComponent[1].find(field => field.name === 'data').type[1].fields;
  const contents = fields.bundle_contents[1].find(field => field.name === 'contents');
  contents.type[1].type = 'ItemStackTemplate';
}
