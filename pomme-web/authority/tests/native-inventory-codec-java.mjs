// Optional native 1.21.11 codec differential. Original private classes and their
// matching libraries execute directly; no dependency stubs or copied game source.
import assert from 'node:assert/strict';
import { readdir, mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, delimiter } from 'node:path';
import { spawnSync } from 'node:child_process';
const jar = process.env.POMME_MAPPED_JAR, libraries = process.env.POMME_JAVA_LIBRARIES;
if (!jar || !libraries) throw new Error('Set POMME_MAPPED_JAR and POMME_JAVA_LIBRARIES to private native 1.21.11 classes/libraries.');
async function jars(root) { const entries = await readdir(root, { withFileTypes: true }), result = []; for (const entry of entries) { const path = join(root, entry.name); if (entry.isDirectory()) result.push(...await jars(path)); else if (entry.name.endsWith('.jar')) result.push(path); } return result; }
const directory = await mkdtemp(join(tmpdir(), 'pomme-native-inventory-codec-'));
const source = `import net.minecraft.SharedConstants; import net.minecraft.server.Bootstrap;
import net.minecraft.nbt.*; import net.minecraft.resources.RegistryOps; import net.minecraft.core.RegistryAccess; import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.world.ItemStackWithSlot; import net.minecraft.world.item.ItemStack;
public class NativeInventoryCodecProof {
 static RegistryOps<Tag> ops;
 static CompoundTag stack(Integer count) {CompoundTag tag=new CompoundTag();tag.putString("id","minecraft:oak_planks");if(count!=null)tag.putInt("count",count);return tag;}
 static ItemStack parse(CompoundTag tag) {return ItemStack.CODEC.parse(ops,tag).getOrThrow();}
 static void equal(int actual,int expected,String message) {if(actual!=expected)throw new AssertionError(message+" "+actual+" != "+expected);}
 public static void main(String[]args) {
  SharedConstants.tryDetectVersion();Bootstrap.bootStrap();ops=RegistryOps.create(NbtOps.INSTANCE,RegistryAccess.fromRegistryOfRegistries(BuiltInRegistries.REGISTRY));
  for(Integer count:new Integer[]{null,0,-1,100})equal(parse(stack(count)).getCount(),1,"Native count fallback");
  equal(parse(stack(99)).getCount(),99,"Native ordinary codec permits count99");
  CompoundTag narrow=stack(1),patch=new CompoundTag();patch.putInt("max_stack_size",16);narrow.put("components",patch);equal(parse(narrow).getMaxStackSize(),16,"Native alias maximum");
  CompoundTag removed=stack(1),removal=new CompoundTag();removal.put("!minecraft:max_stack_size",new CompoundTag());removed.put("components",removal);equal(parse(removed).getMaxStackSize(),1,"Native removed maximum fallback");
  CompoundTag unsigned=stack(1);unsigned.putByte("Slot",(byte)-106);var slotted=ItemStackWithSlot.CODEC.parse(ops,unsigned).getOrThrow();equal(slotted.slot(),150,"Native unsigned byte slot");if(slotted.isValidInContainer(36))throw new AssertionError("Legacy equipment index must be rejected by modern main inventory");
  var absent=ItemStackWithSlot.CODEC.parse(ops,stack(1)).getOrThrow();equal(absent.slot(),0,"Native missing slot fallback");
  CompoundTag unknown=stack(1);unknown.putString("id","minecraft:no_such_source_item");if(ItemStack.CODEC.parse(ops,unknown).result().isPresent())throw new AssertionError("Unknown native item ID must fail");
  System.out.println("NATIVE_INVENTORY_CODEC_OK countMissing=1 countInvalid=1 maxAlias=16 maxRemoved=1 unsignedSlot=150 missingSlot=0 unknownItemRejected=true");
 }
}`;
try {
  const file = join(directory, 'NativeInventoryCodecProof.java'); await writeFile(file, source);
  const result = spawnSync(process.env.JAVA_PATH ?? '/usr/bin/java', ['-cp', [jar, ...await jars(libraries)].join(delimiter), file], { encoding: 'utf8', timeout: 60000, maxBuffer: 4 * 1024 * 1024 });
  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`); assert.match(result.stdout, /NATIVE_INVENTORY_CODEC_OK/);
  // The ordinary source helper vectors run separately against the actual WASM.
  // This report documents only the independent Java codec checks performed above.
  const report = { validation: 'passed', version: '1.21.11', source: 'private original mapped classes + matching original libraries', nativeItemStackCodecExecuted: true,
    nativeComponentPatchCodecExecuted: true, nativeItemStackWithSlotCodecExecuted: true, dependencyStubs: false, fullPlayerInventoryLoadExecuted: false,
    missingCount: 1, invalidCounts: [0, -1, 100], invalidCountFallback: 1, componentNamespaceAliasLimit: 16, removedMaximumLimit: 1, signedSourceSlot: -106, nativeUnsignedSlot: 150, missingSlot: 0, unknownItemRejected: true };
  await mkdir('test-results', { recursive: true }); await writeFile('test-results/native-inventory-codec-java.json', JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2));
} finally { await rm(directory, { recursive: true, force: true }); }
