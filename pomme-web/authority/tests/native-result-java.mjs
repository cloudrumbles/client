// Optional differential proof: execute original privately mapped ResultSlot,
// Slot, ResultContainer, ContainerHelper and TransientCraftingContainer bytecode.
// Small mechanical dependency stubs isolate the plain oak-log crafting branch;
// this does not launch Minecraft, execute the whole menu, or verify a recipe engine.
import assert from 'node:assert/strict';
import { readFile, mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { unzipSync } from 'fflate';
const mappedJar = process.env.POMME_MAPPED_JAR;
if (!mappedJar) throw new Error('Set POMME_MAPPED_JAR to a private named original 1.20.4 or 1.21.11 client JAR.');
const version = process.env.POMME_MINECRAFT_VERSION ?? '1.21.11';
assert.ok(['1.20.4', '1.21.11'].includes(version));
const classes = ['world/inventory/Slot', 'world/inventory/ResultSlot', 'world/inventory/ResultContainer', 'world/inventory/TransientCraftingContainer', 'world/ContainerHelper'];
const names = new Set(classes.map(name => `net/minecraft/${name}.class`));
const entries = unzipSync(await readFile(mappedJar), { filter: entry => names.has(entry.name) });
for (const name of names) assert.ok(entries[name], `Missing actual mapped native ${name}.`);
const directory = await mkdtemp(join(tmpdir(), 'pomme-native-result-'));
const stubs = {
  'core/NonNullList': `package net.minecraft.core; public class NonNullList<T> extends java.util.ArrayList<T> { public static <T> NonNullList<T> withSize(int n,T value) { NonNullList<T> list=new NonNullList<>(); for(int i=0;i<n;i++)list.add(value); return list; } }`,
  'resources/Identifier': 'package net.minecraft.resources; public class Identifier {}',
  'resources/ResourceLocation': 'package net.minecraft.resources; public class ResourceLocation {}',
  'nbt/Tag': 'package net.minecraft.nbt; public interface Tag {}',
  'nbt/CompoundTag': 'package net.minecraft.nbt; public class CompoundTag implements Tag {}',
  'nbt/CollectionTag': 'package net.minecraft.nbt; public class CollectionTag extends java.util.ArrayList<Tag> implements Tag {}',
  'nbt/ListTag': 'package net.minecraft.nbt; public class ListTag extends CollectionTag {}',
  'world/Container': `package net.minecraft.world; import net.minecraft.world.item.ItemStack; import net.minecraft.world.entity.player.Player; public interface Container { int getContainerSize(); boolean isEmpty(); ItemStack getItem(int slot); ItemStack removeItem(int slot,int count); ItemStack removeItemNoUpdate(int slot); void setItem(int slot,ItemStack item); void setChanged(); boolean stillValid(Player player); void clearContent(); default int getMaxStackSize(){return ${version === '1.20.4' ? 64 : 99};} }`,
  'world/item/ItemStack': `package net.minecraft.world.item; import net.minecraft.world.entity.player.Player; import net.minecraft.world.level.Level; public class ItemStack { public static final ItemStack EMPTY=new ItemStack(0); private int count; public ItemStack(int n){count=n;} public int getCount(){return count;} public boolean isEmpty(){return count<=0;} public int getMaxStackSize(){return 64;} public void setCount(int n){count=n;} public void grow(int n){count+=n;} public void shrink(int n){count-=n;} public ItemStack split(int n){int take=Math.max(0,Math.min(n,count));count-=take;return new ItemStack(take);} public ItemStack copyWithCount(int n){return new ItemStack(n);} public void onCraftedBy(Player p,int n){} public void onCraftedBy(Level l,Player p,int n){} public static boolean isSameItemSameComponents(ItemStack a,ItemStack b){return true;} public static boolean isSameItemSameTags(ItemStack a,ItemStack b){return true;} }`,
  'world/entity/player/Player': 'package net.minecraft.world.entity.player; import net.minecraft.world.level.Level; import net.minecraft.world.item.ItemStack; import net.minecraft.world.entity.item.ItemEntity; public class Player { private final Level level=new Level(); public Level level(){return level;} public Inventory getInventory(){return new Inventory();} public ItemEntity drop(ItemStack s,boolean random){return null;} }',
  'world/entity/player/Inventory': 'package net.minecraft.world.entity.player; import net.minecraft.world.item.ItemStack; public class Inventory {public boolean add(ItemStack s){return true;}}',
  'world/entity/player/StackedContents': 'package net.minecraft.world.entity.player; import net.minecraft.world.item.ItemStack; public class StackedContents {public void accountSimpleStack(ItemStack s){}}',
  'world/entity/player/StackedItemContents': 'package net.minecraft.world.entity.player; import net.minecraft.world.item.ItemStack; public class StackedItemContents {public void accountSimpleStack(ItemStack s){}}',
  'world/entity/item/ItemEntity': 'package net.minecraft.world.entity.item; public class ItemEntity {}',
  'world/level/Level': 'package net.minecraft.world.level; import net.minecraft.world.item.crafting.RecipeManager; public class Level {public RecipeManager getRecipeManager(){return new RecipeManager();}}',
  'server/level/ServerLevel': 'package net.minecraft.server.level; public class ServerLevel extends net.minecraft.world.level.Level {}',
  'world/item/crafting/RecipeInput': 'package net.minecraft.world.item.crafting; public interface RecipeInput {}',
  'world/item/crafting/Recipe': 'package net.minecraft.world.item.crafting; public interface Recipe<T> {}',
  'world/item/crafting/RecipeHolder': 'package net.minecraft.world.item.crafting; public class RecipeHolder<T> {}',
  'world/item/crafting/RecipeType': 'package net.minecraft.world.item.crafting; public class RecipeType<T> {public static final RecipeType<Object> CRAFTING=new RecipeType<>();}',
  'world/item/crafting/RecipeManager': 'package net.minecraft.world.item.crafting; import net.minecraft.core.NonNullList; import net.minecraft.world.Container; import net.minecraft.world.item.ItemStack; import net.minecraft.world.level.Level; public class RecipeManager {public NonNullList<ItemStack> getRemainingItemsFor(RecipeType<?> type,Container input,Level level){return NonNullList.withSize(input.getContainerSize(),ItemStack.EMPTY);}}',
  'world/item/crafting/CraftingInput': 'package net.minecraft.world.item.crafting; import net.minecraft.world.inventory.CraftingContainer; import net.minecraft.world.item.ItemStack; public class CraftingInput implements RecipeInput {private final CraftingContainer grid; public CraftingInput(CraftingContainer grid){this.grid=grid;} public int width(){return grid.getWidth();} public int height(){return grid.getHeight();} public int size(){return grid.getContainerSize();} public ItemStack getItem(int slot){return grid.getItem(slot);} public record Positioned(CraftingInput input,int left,int top) {} }',
  'world/item/crafting/CraftingRecipe': 'package net.minecraft.world.item.crafting; import net.minecraft.core.NonNullList; import net.minecraft.world.item.ItemStack; public interface CraftingRecipe { static NonNullList<ItemStack> defaultCraftingReminder(CraftingInput input){return NonNullList.withSize(input.size(),ItemStack.EMPTY);} }',
  'world/inventory/CraftingContainer': 'package net.minecraft.world.inventory; import java.util.List; import net.minecraft.world.Container; import net.minecraft.world.item.ItemStack; import net.minecraft.world.item.crafting.CraftingInput; public interface CraftingContainer extends Container {int getWidth(); int getHeight(); List<ItemStack> getItems(); default CraftingInput.Positioned asPositionedCraftInput(){return new CraftingInput.Positioned(new CraftingInput(this),0,0);}}',
  'world/inventory/RecipeCraftingHolder': 'package net.minecraft.world.inventory; import java.util.List; import net.minecraft.world.entity.player.Player; import net.minecraft.world.item.ItemStack; public interface RecipeCraftingHolder {default void awardUsedRecipes(Player p,List<ItemStack> input){}}',
  // Observer substitutes only recipe evaluation, which is already independently
  // checked with the original JAR loader. Actual grid removal invokes this listener.
  'world/inventory/AbstractContainerMenu': 'package net.minecraft.world.inventory; import net.minecraft.world.Container; import net.minecraft.world.item.ItemStack; public class AbstractContainerMenu {public ResultContainer result; public int events; public void slotsChanged(Container input){events++;if(result!=null)result.setItem(0,new ItemStack(input.getItem(0).isEmpty()?0:4));}}',
};
const proof = `import javax.tools.ToolProvider; import java.nio.file.*; import java.util.*; import java.net.*;
public class NativeResultProof {
 public static void main(String[] args)throws Exception {
  Path root=Path.of(args[0]),classes=root.resolve("classes"); List<String> options=new ArrayList<>(List.of("-d",classes.toString(),"-classpath",classes.toString()));
  try(var files=Files.walk(root.resolve("sources"))){files.filter(p->p.toString().endsWith(".java")).forEach(p->options.add(p.toString()));}
  if(ToolProvider.getSystemJavaCompiler().run(null,null,null,options.toArray(String[]::new))!=0)throw new AssertionError("Fixture stub compilation failed");
  try(var loader=new URLClassLoader(new URL[]{classes.toUri().toURL()},null)) {
   Class<?> item=loader.loadClass("net.minecraft.world.item.ItemStack"),container=loader.loadClass("net.minecraft.world.Container"),playerType=loader.loadClass("net.minecraft.world.entity.player.Player"),gridType=loader.loadClass("net.minecraft.world.inventory.CraftingContainer"),menuType=loader.loadClass("net.minecraft.world.inventory.AbstractContainerMenu"),resultType=loader.loadClass("net.minecraft.world.inventory.ResultContainer"),slotType=loader.loadClass("net.minecraft.world.inventory.ResultSlot"),transientType=loader.loadClass("net.minecraft.world.inventory.TransientCraftingContainer");
   Object player=playerType.getConstructor().newInstance();
   for(int requested:new int[]{1,2,4}) {
    Object result=resultType.getConstructor().newInstance(),menu=menuType.getConstructor().newInstance(); menuType.getField("result").set(menu,result);
    Object grid=transientType.getConstructor(menuType,int.class,int.class).newInstance(menu,2,2);
    transientType.getMethod("setItem",int.class,item).invoke(grid,0,item.getConstructor(int.class).newInstance(1));
    Object slot=slotType.getConstructor(playerType,gridType,container,int.class,int.class,int.class).newInstance(player,grid,result,0,0,0);
    Optional<?> taken=(Optional<?>)slotType.getMethod("tryRemove",int.class,int.class,playerType).invoke(slot,requested,Integer.MAX_VALUE,player);
    if(taken.isEmpty() || (int)item.getMethod("getCount").invoke(taken.get())!=4)throw new AssertionError("Native result removal must return all four planks, requested="+requested);
    if(!(boolean)item.getMethod("isEmpty").invoke(resultType.getMethod("getItem",int.class).invoke(result,0)))throw new AssertionError("ResultContainer must empty its result immediately");
    slotType.getMethod("onTake",playerType,item).invoke(slot,player,taken.get());
    if(!(boolean)item.getMethod("isEmpty").invoke(transientType.getMethod("getItem",int.class).invoke(grid,0)))throw new AssertionError("onTake must consume the one input");
    if(!(boolean)item.getMethod("isEmpty").invoke(resultType.getMethod("getItem",int.class).invoke(result,0)))throw new AssertionError("Actual grid listener must recompute the now-empty result");
    if(menuType.getField("events").getInt(menu)!=2)throw new AssertionError("Expected initial grid assignment plus native removal listener");
   }
   Object result=resultType.getConstructor().newInstance(),menu=menuType.getConstructor().newInstance(); menuType.getField("result").set(menu,result);
   Object grid=transientType.getConstructor(menuType,int.class,int.class).newInstance(menu,2,2); transientType.getMethod("setItem",int.class,item).invoke(grid,0,item.getConstructor(int.class).newInstance(1));
   Object slot=slotType.getConstructor(playerType,gridType,container,int.class,int.class,int.class).newInstance(player,grid,result,0,0,0);
   Optional<?> blocked=(Optional<?>)slotType.getMethod("tryRemove",int.class,int.class,playerType).invoke(slot,4,2,player);
   if(blocked.isPresent() || (int)item.getMethod("getCount").invoke(resultType.getMethod("getItem",int.class).invoke(result,0))!=4)throw new AssertionError("Capacity below whole result must preserve input and output");
   System.out.println("native-result-bytecode: passed requested=1,2,4 => whole4; one-log consumed; actual removal listener; partial cursor capacity blocked");
  }
 }
}`;
try {
  for (const [name, bytes] of Object.entries(entries)) { const target = join(directory, 'classes', name); await mkdir(dirname(target), { recursive: true }); await writeFile(target, bytes); }
  for (const [name, source] of Object.entries(stubs)) { const target = join(directory, 'sources/net/minecraft', `${name}.java`); await mkdir(dirname(target), { recursive: true }); await writeFile(target, source); }
  const pair = join(directory, 'sources/com/mojang/datafixers/util/Pair.java'); await mkdir(dirname(pair), { recursive: true }); await writeFile(pair, 'package com.mojang.datafixers.util; public class Pair<A,B> {}');
  const main = join(directory, 'NativeResultProof.java'); await writeFile(main, proof);
  const result = spawnSync(process.env.JAVA_PATH ?? '/usr/bin/java', [main, directory], { encoding: 'utf8', timeout: 30000 });
  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`); assert.match(result.stdout, /native-result-bytecode: passed/);
  const report = { validation: 'passed', version, source: 'private original mapped class bytecode', classes, requestedRemovalCounts: [1, 2, 4], nativeOutputCount: 4, nativeConsumedInputs: 1,
    originalSlotAndResultContainerExecuted: true, originalGridRemovalListenerExecuted: true, partialCursorCapacityBlocked: true, dependencyStubs: true, nativeRecipeEvaluationExecuted: false, fullJavaMenuExecuted: false };
  await mkdir('test-results', { recursive: true }); await writeFile(`test-results/native-result-java-${version}.json`, JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2));
} finally { await rm(directory, { recursive: true, force: true }); }
