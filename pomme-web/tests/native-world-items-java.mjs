// Optional independent ItemEntity differential. Execute original private mapped
// classes with their matching libraries; no copied game source or Java stubs.
import assert from 'node:assert/strict';
import { readFile, readdir, mkdtemp, writeFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, delimiter } from 'node:path';
import { spawnSync } from 'node:child_process';
import { LocalWorldItems } from '../src/local-world-items.js';
import { appendWorldItemDrops, createWorldItemsSnapshot, mergeWorldItemPair } from '../src/local-world-items-state.js';
const root = process.env.POMME_NATIVE_REFERENCE_ROOT;
if (!root) throw new Error('Set POMME_NATIVE_REFERENCE_ROOT to your private original mapped JARs and libraries.');
async function jars(path) { const result = []; for (const entry of await readdir(path, { withFileTypes: true })) { const child = join(path, entry.name); if (entry.isDirectory()) result.push(...await jars(child)); else if (entry.name.endsWith('.jar')) result.push(child); } return result; }
const directory = await mkdtemp(join(tmpdir(), 'pomme-native-items-')), report = [];
try {
  for (const version of ['1.20.4', '1.21.11']) {
    const modern = version !== '1.20.4', file = join(directory, 'NativeItemProof.java');
    await writeFile(file, `import net.minecraft.SharedConstants;import net.minecraft.server.Bootstrap;
import net.minecraft.world.entity.item.ItemEntity;import net.minecraft.world.entity.EntityType;import net.minecraft.world.item.ItemStack;import net.minecraft.world.item.Items;
import net.minecraft.world.phys.Vec3;import net.minecraft.nbt.*;${modern ? 'import net.minecraft.core.component.DataComponents;import net.minecraft.world.level.storage.TagValueInput;import net.minecraft.util.ProblemReporter;import net.minecraft.core.HolderLookup;import java.util.stream.Stream;' : ''}
public class NativeItemProof {
 static void require(boolean value,String label){if(!value)throw new AssertionError(label);}
 static void field(ItemEntity item,String name,int value)throws Exception{var f=ItemEntity.class.getDeclaredField(name);f.setAccessible(true);f.setInt(item,value);}
 static int field(ItemEntity item,String name)throws Exception{var f=ItemEntity.class.getDeclaredField(name);f.setAccessible(true);return f.getInt(item);}
 public static void main(String[]args)throws Exception {
  SharedConstants.tryDetectVersion();Bootstrap.bootStrap();
  require(ItemEntity.areMergable(new ItemStack(Items.OAK_PLANKS,32),new ItemStack(Items.OAK_PLANKS,32)),"sum64");
  require(!ItemEntity.areMergable(new ItemStack(Items.OAK_PLANKS,32),new ItemStack(Items.OAK_PLANKS,33)),"sum65");
  ItemStack source=new ItemStack(Items.OAK_PLANKS,30),merged=ItemEntity.merge(new ItemStack(Items.OAK_PLANKS,20),source,64);
  require(merged.getCount()==50&&source.getCount()==0,"transfer");
  ItemEntity item=new ItemEntity(EntityType.ITEM,null);item.setDeltaMovement(new Vec3(.1,0,.2));
  var water=ItemEntity.class.getDeclaredMethod("setUnderwaterMovement");water.setAccessible(true);water.invoke(item);var w=item.getDeltaMovement();
  item.setDeltaMovement(new Vec3(.1,0,.2));var lava=ItemEntity.class.getDeclaredMethod("setUnderLavaMovement");lava.setAccessible(true);lava.invoke(item);var l=item.getDeltaMovement();
  item.setPos(.5,.5,.5);var below=ItemEntity.class.getDeclaredMethod("getBlockPosBelowThatAffectsMyMovement");below.setAccessible(true);require(((net.minecraft.core.BlockPos)below.invoke(item)).getY()==-1,"item slab friction position");
  ItemEntity first=new ItemEntity(EntityType.ITEM,null),second=new ItemEntity(EntityType.ITEM,null);first.setItem(new ItemStack(Items.OAK_PLANKS,30));second.setItem(new ItemStack(Items.OAK_PLANKS,20));
  field(first,"age",100);field(second,"age",10);field(first,"pickupDelay",3);field(second,"pickupDelay",10);
  var merge=ItemEntity.class.getDeclaredMethod("tryToMerge",ItemEntity.class);merge.setAccessible(true);merge.invoke(first,second);
  field(first,"age",field(first,"age")+1);require(first.getItem().getCount()==50&&field(first,"age")==11&&field(first,"pickupDelay")==10&&second.isRemoved(),"ordered merge fields");
  CompoundTag numeric=new CompoundTag();numeric.putFloat("Age",-.2f);numeric.putLong("PickupDelay",65535L);numeric.putInt("NoGravity",256);numeric.putDouble("OnGround",-.2);
  ${modern ? `var input=TagValueInput.create(ProblemReporter.DISCARDING,HolderLookup.Provider.create(Stream.empty()),numeric);
  require(input.getShortOr("Age",(short)0)==-1&&input.getShortOr("PickupDelay",(short)0)==-1&&!input.getBooleanOr("NoGravity",false)&&input.getBooleanOr("OnGround",false),"modern NumericTag fields");
  ListTag uuidList=new ListTag();for(int i=0;i<4;i++)uuidList.add(IntTag.valueOf(i==3?1:0));numeric.put("Owner",uuidList);
  require(TagValueInput.create(ProblemReporter.DISCARDING,HolderLookup.Provider.create(Stream.empty()),numeric).read("Owner",net.minecraft.core.UUIDUtil.CODEC).orElseThrow().toString().equals("00000000-0000-0000-0000-000000000001"),"UUID numeric list codec");
  uuidList=new ListTag();uuidList.add(FloatTag.valueOf(-.2f));uuidList.add(FloatTag.valueOf(0));uuidList.add(FloatTag.valueOf(0));uuidList.add(FloatTag.valueOf(1));numeric.put("Owner",uuidList);
  require(TagValueInput.create(ProblemReporter.DISCARDING,HolderLookup.Provider.create(Stream.empty()),numeric).read("Owner",net.minecraft.core.UUIDUtil.CODEC).orElseThrow().toString().equals("00000000-0000-0000-0000-000000000001"),"UUID number intValue truncates");
  numeric.put("Owner",new IntArrayTag(new int[]{0,0,0,1,2}));System.out.println("UUID_LONG_RESULT "+TagValueInput.create(ProblemReporter.DISCARDING,HolderLookup.Provider.create(Stream.empty()),numeric).read("Owner",net.minecraft.core.UUIDUtil.CODEC));
  ListTag floats=new ListTag();floats.add(FloatTag.valueOf(-20.5f));floats.add(FloatTag.valueOf(100));floats.add(FloatTag.valueOf(3.5f));numeric.put("Pos",floats);
  require(TagValueInput.create(ProblemReporter.DISCARDING,HolderLookup.Provider.create(Stream.empty()),numeric).read("Pos",Vec3.CODEC).orElse(Vec3.ZERO).equals(new Vec3(-20.5,100,3.5)),"float Vec3 codec");
  numeric.put("Pos",new IntArrayTag(new int[]{1,2,3,4}));require(TagValueInput.create(ProblemReporter.DISCARDING,HolderLookup.Provider.create(Stream.empty()),numeric).read("Pos",Vec3.CODEC).orElse(Vec3.ZERO).equals(new Vec3(1,2,3)),"overlong array partial Vec3");
  ListTag shortList=new ListTag();shortList.add(DoubleTag.valueOf(7));numeric.put("Pos",shortList);require(TagValueInput.create(ProblemReporter.DISCARDING,HolderLookup.Provider.create(Stream.empty()),numeric).read("Pos",Vec3.CODEC).orElse(Vec3.ZERO).equals(Vec3.ZERO),"short Vec3 default");` : `require(numeric.getShort("Age")==-1&&numeric.getShort("PickupDelay")==-1&&!numeric.getBoolean("NoGravity")&&numeric.getBoolean("OnGround"),"legacy NumericTag fields");
  ListTag floats=new ListTag();floats.add(FloatTag.valueOf(-20.5f));floats.add(FloatTag.valueOf(100));floats.add(FloatTag.valueOf(3.5f));numeric.put("Pos",floats);require(numeric.getList("Pos",6).getDouble(0)==0,"legacy float list rejected");
  ListTag shortList=new ListTag();shortList.add(DoubleTag.valueOf(7));numeric.put("Pos",shortList);require(numeric.getList("Pos",6).getDouble(0)==7&&numeric.getList("Pos",6).getDouble(1)==0,"legacy short list per-axis default");`}
  ${modern ? `ItemStack explicit=new ItemStack(Items.OAK_PLANKS,1);explicit.set(DataComponents.MAX_STACK_SIZE,64);
  require(ItemEntity.areMergable(new ItemStack(Items.OAK_PLANKS,1),explicit),"max64 baseline");
  ItemStack sword=new ItemStack(Items.DIAMOND_SWORD,1),damage=sword.copy();damage.set(DataComponents.DAMAGE,0);damage.set(DataComponents.MAX_DAMAGE,sword.getMaxDamage());
  require(ItemStack.isSameItemSameComponents(sword,damage),"damage baseline");damage.remove(DataComponents.DAMAGE);require(!ItemStack.isSameItemSameComponents(sword,damage),"removed damage differs");
  ItemStack a=new ItemStack(Items.OAK_PLANKS,70),b=new ItemStack(Items.OAK_PLANKS,1);a.set(DataComponents.MAX_STACK_SIZE,99);b.set(DataComponents.MAX_STACK_SIZE,99);
  require(ItemEntity.areMergable(a,b),"max99 sum71");ItemStack capped=ItemEntity.merge(a,b,64);require(capped.getCount()==64&&b.getCount()==7,"negative native transfer");
  first=new ItemEntity(EntityType.ITEM,null);second=new ItemEntity(EntityType.ITEM,null);a.setCount(64);b.setCount(1);first.setItem(a);second.setItem(b);field(first,"age",100);field(second,"age",10);field(first,"pickupDelay",5);field(second,"pickupDelay",9);merge.invoke(first,second);
  require(first.getItem().getCount()==64&&second.getItem().getCount()==1&&field(first,"age")==10&&field(first,"pickupDelay")==9,"zero transfer metadata");` : `ItemStack explicit=new ItemStack(Items.OAK_PLANKS,1);explicit.setTag(new CompoundTag());require(ItemEntity.areMergable(new ItemStack(Items.OAK_PLANKS,1),explicit),"empty legacy tag baseline");`}
  System.out.println("NATIVE_ITEM_RESULT "+w.x+" "+w.y+" "+w.z+" "+l.x+" "+l.y+" "+l.z);
 }
}`);
    const classpath = [join(root, version, 'client-named.jar'), ...await jars(join(root, version, 'libraries'))].join(delimiter);
    if (process.env.POMME_ECJ_JAR) {
      const compiled = spawnSync(process.env.POMME_COMPILER_JAVA_PATH ?? '/usr/bin/java', ['-jar', process.env.POMME_ECJ_JAR, '-21', '-proc:none', '-cp', classpath, '-d', directory, file], { encoding: 'utf8', timeout: 60000, maxBuffer: 4 * 1024 * 1024 });
      assert.equal(compiled.status, 0, `${compiled.stdout}\n${compiled.stderr}`);
    }
    const result = spawnSync(process.env.POMME_JAVA_PATH ?? '/usr/bin/java', ['-cp', process.env.POMME_ECJ_JAR ? `${directory}${delimiter}${classpath}` : classpath,
      process.env.POMME_ECJ_JAR ? 'NativeItemProof' : file], { encoding: 'utf8', timeout: 60000, maxBuffer: 4 * 1024 * 1024 });
    assert.equal(result.status, 0, `${version}\n${result.stdout}\n${result.stderr}`);
    const match = result.stdout.match(/NATIVE_ITEM_RESULT ([^\n]+)/); assert.ok(match); const native = match[1].trim().split(/\s+/).map(Number);
    const registry = JSON.parse(await readFile(new URL(`../data/${version}-registry.json`, import.meta.url)));
    const stack = count => ({ present: true, itemId: registry.items.find(item => item.name === 'oak_planks').id, itemCount: count });
    for (const [index, kind] of ['water', 'lava'].entries()) {
      const snapshot = appendWorldItemDrops(createWorldItemsSnapshot(registry), [stack(1)], { position: [.5, .25, .5], velocity: [.1, 0, .2], pickupDelay: 0 }, registry);
      const scene = new LocalWorldItems({ registry, snapshot, sample: () => ({ flags: 4, material: { name: kind, flags: 4, collisionBoxes: [] }, fluid: { kind, height: 1, flow: [0, 0, 0] } }) });
      scene.step(); const actual = scene.state.items[0];
      assert.equal(actual.position[0], .5 + native[index * 3]); assert.equal(actual.position[1], .25 + native[index * 3 + 1]); assert.equal(actual.position[2], .5 + native[index * 3 + 2]);
    }
    const a = appendWorldItemDrops(createWorldItemsSnapshot(registry), [stack(20), stack(30)], { position: [.5, 1, .5], velocity: [0, 0, 0], pickupDelay: 0 }, registry);
    const merged = mergeWorldItemPair(a.items[0], a.items[1], registry); assert.equal(merged.target.stack.itemCount, 50); assert.equal(merged.source.stack.itemCount, 0);
    report.push({ version, originalItemEntityMethodsExecuted: true, dependencyStubs: false, wholeLevelTickExecuted: false,
      nativeBuoyancy: { water: native.slice(0, 3), lava: native.slice(3) }, sum64Accepted: true, sum65Rejected: true,
      knownDefaultIdentityChecked: true, orderedMergeMetadataChecked: true, nativeSourceNumericFieldsChecked: true, nativeSourceVectorCodecChecked: true, nativeHalfSlabFrictionPositionChecked: true,
      ...(modern ? { nativeNumericListUuidChecked: true, nativeOverlongUuid: result.stdout.match(/UUID_LONG_RESULT ([^\n]+)/)?.[1], damageZeroDefaultChecked: true, removedDamageDifferent: true, nativeMax99NegativeTransfer: [64, 7], nativeMax99ZeroTransferMetadata: { age: 10, pickupDelay: 9 } } : { emptyLegacyTagDefaultChecked: true }) });
  }
  await mkdir('test-results', { recursive: true }); await writeFile('test-results/native-world-items-java.json', JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2));
} finally { await rm(directory, { recursive: true, force: true }); }
