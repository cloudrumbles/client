// Optional independent original-Java numeric save getter/codec differential.
// No dependency stubs or copied native source; private JARs remain external.
import assert from 'node:assert/strict';
import { readdir, mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, delimiter } from 'node:path';
import { spawnSync } from 'node:child_process';
import { sourceInventoryNumericVectors } from '../../tests/fixtures/source-inventory-numeric.js';
const root = process.env.POMME_NATIVE_REFERENCE_ROOT;
if (!root) throw new Error('Set POMME_NATIVE_REFERENCE_ROOT to private original mapped JARs and matching libraries.');
async function jars(root) { const result = []; for (const entry of await readdir(root, { withFileTypes: true })) { const path = join(root, entry.name); if (entry.isDirectory()) result.push(...await jars(path)); else if (entry.name.endsWith('.jar')) result.push(path); } return result; }
const literal = value => Number.isNaN(value) ? 'Double.NaN' : value === Infinity ? 'Double.POSITIVE_INFINITY' : value === -Infinity ? 'Double.NEGATIVE_INFINITY' : `${value}d`;
const directory = await mkdtemp(join(tmpdir(), 'pomme-source-numeric-')), report = [];
try {
  for (const version of ['1.20.4', '1.21.11']) {
    const old = version === '1.20.4', file = join(directory, 'NativeSourceNumericProof.java');
    const source = `import net.minecraft.SharedConstants;import net.minecraft.server.Bootstrap;import net.minecraft.nbt.*;import net.minecraft.world.item.ItemStack;
${old ? '' : 'import net.minecraft.world.ItemStackWithSlot;import net.minecraft.resources.RegistryOps;import net.minecraft.core.RegistryAccess;import net.minecraft.core.registries.BuiltInRegistries;'}
public class NativeSourceNumericProof {public static void main(String[]args){SharedConstants.tryDetectVersion();Bootstrap.bootStrap();
${old ? '' : 'var ops=RegistryOps.create(NbtOps.INSTANCE,RegistryAccess.fromRegistryOfRegistries(BuiltInRegistries.REGISTRY));'}
int ordinal=0;${sourceInventoryNumericVectors.map(vector => `{CompoundTag tag=new CompoundTag();tag.putString("id","minecraft:oak_planks");tag.${vector.type === 5 ? 'putFloat' : 'putDouble'}("Slot",${vector.type === 5 ? '(float)' : ''}${literal(vector.value)});tag.put("${old ? 'Count' : 'count'}",tag.get("Slot"));
${old ? 'int integer=tag.getInt("Slot"),slot=tag.getByte("Slot")&255,count=ItemStack.of(tag).getCount();' : 'int integer=NbtOps.INSTANCE.getNumberValue(tag.get("Slot")).getOrThrow().intValue();var stack=ItemStackWithSlot.CODEC.parse(ops,tag).getOrThrow();int slot=stack.slot(),count=stack.stack().getCount();'}
System.out.println("NATIVE_NUMERIC "+ordinal+++" "+integer+" "+slot+" "+count);}`).join('\n')}
}}`;
    await writeFile(file, source);
    const result = spawnSync(process.env.POMME_JAVA_PATH ?? '/usr/bin/java', ['-cp', [join(root, version, 'client-named.jar'), ...await jars(join(root, version, 'libraries'))].join(delimiter), file], { encoding: 'utf8', timeout: 60000, maxBuffer: 4 * 1024 * 1024 });
    assert.equal(result.status, 0, `${version}\n${result.stdout}\n${result.stderr}`);
    const rows = [...result.stdout.matchAll(/NATIVE_NUMERIC (\d+) (-?\d+) (\d+) (-?\d+)/g)]; assert.equal(rows.length, sourceInventoryNumericVectors.length);
    for (const [ordinal, vector] of sourceInventoryNumericVectors.entries()) {
      const actual = rows[ordinal].slice(1).map(Number), signed = vector.legacyByte > 127 ? vector.legacyByte - 256 : vector.legacyByte;
      const count = old ? Math.max(0, signed) : vector.modernInt >= 1 && vector.modernInt <= 99 ? vector.modernInt : 1;
      assert.deepEqual(actual, [ordinal, old ? vector.legacyInt : vector.modernInt, old ? vector.legacyByte : vector.modernByte, count], `${version} ${vector.type}:${vector.value}`);
    }
    report.push({ version, source: 'private original mapped classes and matching libraries', dependencyStubs: false, numericVectors: rows.length, actualItemStackDecoderExecuted: true,
      nativeFloatingGetter: old ? 'Mth.floor then Java byte narrowing' : 'Number.intValue/byteValue through NbtOps and ItemStackWithSlot.CODEC', negativeInfinityAndIntegerUnderflowChecked: true });
  }
  await mkdir('test-results', { recursive: true }); await writeFile('test-results/native-source-numeric-java.json', JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2));
} finally { await rm(directory, { recursive: true, force: true }); }
