import java.util.*;
import io.netty.buffer.*;
import net.minecraft.network.RegistryFriendlyByteBuf;
import net.minecraft.core.RegistryAccess;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.SharedConstants;
import net.minecraft.server.Bootstrap;
import net.minecraft.util.HashOps;
import net.minecraft.world.item.*;
import net.minecraft.world.item.component.BundleContents;
import net.minecraft.core.component.DataComponents;
import net.minecraft.core.component.DataComponentPatch;
public class BundleNativeProof {
 static void print(String key, BundleContents value) {
  int hash=BundleContents.CODEC.encodeStart(HashOps.CRC32C_INSTANCE,value).getOrThrow().asInt();
  System.out.println("HASH "+key+" "+hash);
  ByteBuf bytes=Unpooled.buffer(); RegistryFriendlyByteBuf buffer=new RegistryFriendlyByteBuf(bytes,RegistryAccess.fromRegistryOfRegistries(BuiltInRegistries.REGISTRY));
  BundleContents.STREAM_CODEC.encode(buffer,value); System.out.println("WIRE "+key+" "+ByteBufUtil.hexDump(bytes));
 }
 public static void main(String[] args) {
  SharedConstants.tryDetectVersion(); Bootstrap.bootStrap();
  for (String hex : List.of("0100010000", "0101000000")) { ByteBuf bytes=Unpooled.wrappedBuffer(ByteBufUtil.decodeHexDump(hex+"55")); RegistryFriendlyByteBuf buffer=new RegistryFriendlyByteBuf(bytes,RegistryAccess.fromRegistryOfRegistries(BuiltInRegistries.REGISTRY)); try { BundleContents.STREAM_CODEC.decode(buffer); throw new AssertionError("invalid accepted"); } catch (IllegalStateException expected) { System.out.println("INVALID "+hex+" "+bytes.readerIndex()+" "+bytes.getUnsignedByte(bytes.readerIndex())); }}
  print("empty",new BundleContents(List.of()));
  print("stone1",new BundleContents(List.of(new ItemStackTemplate(Items.STONE,1))));
  print("stone12",new BundleContents(List.of(new ItemStackTemplate(Items.STONE,12))));
  print("varint_boundary",new BundleContents(List.of(new ItemStackTemplate(Items.WAXED_EXPOSED_CUT_COPPER_STAIRS,1),new ItemStackTemplate(Items.WAXED_WEATHERED_CUT_COPPER_STAIRS,99))));
  print("stone64",new BundleContents(List.of(new ItemStackTemplate(Items.STONE,64))));
  print("stone12dirt3",new BundleContents(List.of(new ItemStackTemplate(Items.STONE,12),new ItemStackTemplate(Items.DIRT,3))));
  ItemStackTemplate custom=new ItemStackTemplate(Items.STONE.builtInRegistryHolder(),98,DataComponentPatch.builder().set(DataComponents.MAX_STACK_SIZE,99).build());
  print("stone98max99",new BundleContents(List.of(custom)));
  ItemStackTemplate nested=new ItemStackTemplate(Items.BUNDLE,DataComponentPatch.builder().set(DataComponents.BUNDLE_CONTENTS,new BundleContents(List.of(new ItemStackTemplate(Items.STONE,8)))).build());
  print("nested",new BundleContents(List.of(nested,new ItemStackTemplate(Items.DIRT,52))));
  ItemStackTemplate removed=new ItemStackTemplate(Items.DIAMOND_PICKAXE,DataComponentPatch.builder().remove(DataComponents.DAMAGE).build());
  print("removed_damage",new BundleContents(List.of(removed)));
 }
}