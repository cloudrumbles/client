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
public class BundleNativeProof {
 static void print(String key, BundleContents value) {
  int hash=BundleContents.CODEC.encodeStart(HashOps.CRC32C_INSTANCE,value).getOrThrow().asInt();
  System.out.println("HASH "+key+" "+hash);
  ByteBuf bytes=Unpooled.buffer(); RegistryFriendlyByteBuf buffer=new RegistryFriendlyByteBuf(bytes,RegistryAccess.fromRegistryOfRegistries(BuiltInRegistries.REGISTRY));
  BundleContents.STREAM_CODEC.encode(buffer,value); System.out.println("WIRE "+key+" "+ByteBufUtil.hexDump(bytes));
 }
 public static void main(String[] args) {
  SharedConstants.tryDetectVersion(); Bootstrap.bootStrap();
  print("empty",new BundleContents(List.of()));
  print("stone1",new BundleContents(List.of(new ItemStack(Items.STONE,1))));
  print("stone12",new BundleContents(List.of(new ItemStack(Items.STONE,12))));
  print("varint_boundary",new BundleContents(List.of(new ItemStack(Items.WAXED_EXPOSED_CUT_COPPER_STAIRS,1),new ItemStack(Items.WAXED_WEATHERED_CUT_COPPER_STAIRS,99))));
  print("stone64",new BundleContents(List.of(new ItemStack(Items.STONE,64))));
  print("stone12dirt3",new BundleContents(List.of(new ItemStack(Items.STONE,12),new ItemStack(Items.DIRT,3))));
  ItemStack custom=new ItemStack(Items.STONE,98); custom.set(DataComponents.MAX_STACK_SIZE,99);
  print("stone98max99",new BundleContents(List.of(custom)));
  ItemStack nested=new ItemStack(Items.BUNDLE); nested.set(DataComponents.BUNDLE_CONTENTS,new BundleContents(List.of(new ItemStack(Items.STONE,8))));
  print("nested",new BundleContents(List.of(nested,new ItemStack(Items.DIRT,52))));
  ItemStack removed=new ItemStack(Items.DIAMOND_PICKAXE); removed.remove(DataComponents.DAMAGE);
  print("removed_damage",new BundleContents(List.of(removed)));
 }
}