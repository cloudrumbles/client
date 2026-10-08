// Execute privately mapped original classes to verify native equipment defaults.
// No original JAR, class, decompile or texture enters the repository.
import assert from 'node:assert/strict';
import { readdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, delimiter } from 'node:path';
import { spawnSync } from 'node:child_process';
import { nativeEquipmentDefaults } from '../native-equipment.js';
const jar = process.env.POMME_MAPPED_JAR, libraries = process.env.POMME_JAVA_LIBRARIES, version = process.env.POMME_MINECRAFT_VERSION ?? '1.21.11';
if (!jar || !libraries || !['1.20.4', '1.21.11'].includes(version)) throw new Error('Supply private mapped JAR, matching Java libraries and a supported version.');
async function jars(root) { const result = []; for (const entry of await readdir(root, { withFileTypes: true })) { const path = join(root, entry.name); if (entry.isDirectory()) result.push(...await jars(path)); else if (entry.name.endsWith('.jar')) result.push(path); } return result; }
const directory = await mkdtemp(join(tmpdir(), 'pomme-native-equipment-'));
const source = `import net.minecraft.SharedConstants; import net.minecraft.server.Bootstrap;
import net.minecraft.core.registries.BuiltInRegistries; import net.minecraft.world.item.ItemStack;
import net.minecraft.world.entity.EquipmentSlot; ${version === '1.20.4' ? 'import net.minecraft.world.entity.LivingEntity;' : 'import net.minecraft.core.component.DataComponents;'}
public class NativeEquipmentDefaults {
 public static void main(String[]args) {
  SharedConstants.tryDetectVersion(); Bootstrap.bootStrap();
  for(var item:BuiltInRegistries.ITEM) {
   ItemStack stack=new ItemStack(item);
   ${version === '1.20.4' ? 'EquipmentSlot slot=LivingEntity.getEquipmentSlotForItem(stack);' : 'var component=stack.get(DataComponents.EQUIPPABLE); EquipmentSlot slot=component==null?EquipmentSlot.MAINHAND:component.slot();'}
   if(slot!=EquipmentSlot.MAINHAND)System.out.println("EQUIPMENT_DEFAULT "+BuiltInRegistries.ITEM.getKey(item)+" "+slot.getName());
  }
 }
}`;
try {
  const file = join(directory, 'NativeEquipmentDefaults.java'); await writeFile(file, source);
  const result = spawnSync(process.env.JAVA_PATH ?? '/usr/bin/java', ['-cp', [jar, ...await jars(libraries)].join(delimiter), file], { encoding: 'utf8', timeout: 60000, maxBuffer: 4 * 1024 * 1024 });
  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
  const defaults = Object.fromEntries([...result.stdout.matchAll(/EQUIPMENT_DEFAULT (\S+) (\S+)/g)].map(([, name, slot]) => [name.replace(/^minecraft:/, ''), slot]));
  assert.ok(Object.keys(defaults).length > 20);
  const ids = { feet: 1, legs: 2, chest: 3, head: 4, offhand: 5 }, player = Object.fromEntries(Object.entries(defaults).filter(([, slot]) => slot in ids).map(([name, slot]) => [name, ids[slot]]));
  assert.deepEqual(Object.fromEntries(nativeEquipmentDefaults(version)), player);
  console.log(JSON.stringify({ version, source: 'private original mapped native equipment defaults', dependencyStubs: false, declarationsMatchNativePlayerSlots: true, defaults }, null, 2));
} finally { await rm(directory, { recursive: true, force: true }); }
