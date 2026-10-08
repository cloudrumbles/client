// Optional original-JAR differential. A real native living entity supplies the
// LivingEntity API; no dependency stubs, browser or graphics context is used.
import assert from 'node:assert/strict';
import { readdir, mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';
import { join, delimiter } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { nativeNightVisionScale, NativeDarknessFactor } from '../src/environment-effects.js';
const jar = process.env.POMME_MAPPED_JAR, libraries = process.env.POMME_JAVA_LIBRARIES, version = process.env.POMME_MINECRAFT_VERSION ?? '1.21.11';
if (!jar || !libraries || !['1.20.4', '1.21.11', '26.1'].includes(version)) throw new Error('Set private POMME_MAPPED_JAR, POMME_JAVA_LIBRARIES and supported POMME_MINECRAFT_VERSION.');
async function jars(root) { const output = []; for (const entry of await readdir(root, { withFileTypes: true })) { const path = join(root, entry.name); if (entry.isDirectory()) output.push(...await jars(path)); else if (entry.name.endsWith('.jar')) output.push(path); } return output; }
const legacy = version === '1.20.4', times = [...Array.from({ length: 27 }, (_, i) => 100 - i), ...Array.from({ length: 23 }, (_, i) => 22 - i), -1];
const nightTimes = [-2147483648, -2, -1, 0, 1, 5, 199, 200, 201, 2147483647], partials = [0, .125, .5, .999, 1];
const factorCall = (instance, partial) => legacy ? `${instance}.getFactorData().map(factor->factor.getFactor(entity,${partial})).orElse(0f)` : `${instance}.getBlendFactor(entity,${partial})`;
const source = `import java.util.*;import net.minecraft.world.entity.EntityType;import net.minecraft.world.entity.decoration.ArmorStand;import net.minecraft.world.entity.LivingEntity;import net.minecraft.world.effect.*;import net.minecraft.client.renderer.GameRenderer;
public class NativeFogEffectsProof { public static void main(String[] args)throws Exception {
 java.io.PrintStream out=System.out;net.minecraft.SharedConstants.tryDetectVersion();net.minecraft.server.Bootstrap.bootStrap();System.setOut(out);
 var entity=new ArmorStand(EntityType.ARMOR_STAND,null);var effectsField=LivingEntity.class.getDeclaredField("activeEffects");effectsField.setAccessible(true);Map effects=(Map)effectsField.get(entity);
 int[] nightTimes={${nightTimes.join(',')}};float[] partials={${partials.map(value => `${value}f`).join(',')}};
 for(int time:nightTimes){var instance=new MobEffectInstance(MobEffects.NIGHT_VISION,time);effects.put(MobEffects.NIGHT_VISION,instance);for(float partial:partials)System.out.println("N "+time+" "+partial+" "+Integer.toUnsignedString(Float.floatToRawIntBits(GameRenderer.getNightVisionScale(entity,partial))));}
 var duration=MobEffectInstance.class.getDeclaredField("duration");duration.setAccessible(true);var instance=new MobEffectInstance(MobEffects.DARKNESS,100);
 int[] times={${times.join(',')}};for(int i=0;i<times.length;i++){duration.setInt(instance,${legacy ? 'times[i]' : 'times[i]==-1?-1:times[i]+1'});${legacy ? 'instance.getFactorData().orElseThrow().tick(instance);' : 'instance.tickClient();'}for(float partial:partials)System.out.println("D "+i+" "+partial+" "+Integer.toUnsignedString(Float.floatToRawIntBits(${factorCall('instance', 'partial')})));}
 ${legacy ? `var saved=new MobEffectInstance.FactorData(22,.25f,1f,.5f,8,.45f,true);var restored=new MobEffectInstance(MobEffects.DARKNESS,50,0,false,true,true,null,Optional.of(saved));saved.tick(restored);for(float partial:partials)System.out.println("R 0 "+partial+" "+Integer.toUnsignedString(Float.floatToRawIntBits(${factorCall('restored', 'partial')})));` : `for(int time:new int[]{23,22,-1}){var immediate=new MobEffectInstance(MobEffects.DARKNESS,time);immediate.skipBlending();for(float partial:partials)System.out.println("S "+time+" "+partial+" "+Integer.toUnsignedString(Float.floatToRawIntBits(${factorCall('immediate', 'partial')})));}var refreshed=new MobEffectInstance(MobEffects.DARKNESS,100);refreshed.copyBlendState(instance);for(float partial:partials)System.out.println("R 0 "+partial+" "+Integer.toUnsignedString(Float.floatToRawIntBits(${factorCall('refreshed', 'partial')})));`}
 }}
`;
const temp = await mkdtemp(join(tmpdir(), 'pomme-native-fog-effects-'));
try {
 const file = join(temp, 'NativeFogEffectsProof.java'); await writeFile(file, source);
 const classpath = [jar, ...await jars(libraries)].join(delimiter);
 if (process.env.POMME_JAVA_COMPILER) {
  const compiled = spawnSync('/usr/bin/java', ['-jar', process.env.POMME_JAVA_COMPILER, '-25', '-cp', classpath, '-d', temp, file], { encoding: 'utf8', timeout: 60000, maxBuffer: 1024 * 1024 });
  assert.equal(compiled.status, 0, `${compiled.stderr}\n${compiled.stdout}`);
 }
 const result = spawnSync(process.env.JAVA_PATH ?? '/usr/bin/java', ['-cp', [temp, classpath].join(delimiter), process.env.POMME_JAVA_COMPILER ? 'NativeFogEffectsProof' : file], { encoding: 'utf8', timeout: 60000, maxBuffer: 1024 * 1024 });
 assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
 const bits = value => { const bytes = new DataView(new ArrayBuffer(4)); bytes.setFloat32(0, value); return bytes.getUint32(0); };
 const factor = new NativeDarknessFactor({ version }), values = [];
 for (const time of times) { factor.tick(time); values.push(partials.map(value => bits(factor.sample(value)))); }
 const restored = legacy ? new NativeDarknessFactor({ version, factorData: { padding_duration: 22, factor_start: .25, factor_target: 1, factor_current: .5, ticks_active: 8, factor_previous_frame: .45, had_effect_last_tick: true } }) : new NativeDarknessFactor({ version });
 if (legacy) restored.tick(50); else restored.copyFrom(factor);
 let count = 0; const mismatches = [];
 for (const line of result.stdout.split('\n')) {
  const [kind, key, at, expected] = line.split(' '); if (!['N', 'D', 'R', 'S'].includes(kind)) continue;
  const index = partials.findIndex(value => Math.fround(value) === Math.fround(Number(at))); assert.ok(index >= 0);
  const actual = kind === 'N' ? bits(nativeNightVisionScale(Number(key), Number(at), version)) : kind === 'D' ? values[Number(key)][index] : kind === 'R' ? bits(restored.sample(Number(at))) : bits(new NativeDarknessFactor({ version, shouldBlend: false, remainingDuration: Number(key) }).sample(Number(at)));
  count++; if (actual !== Number(expected)) mismatches.push({ kind, key, at, actual, expected: Number(expected) });
 }
 assert.deepEqual(mismatches, []); assert.equal(count, nightTimes.length * partials.length + times.length * partials.length + partials.length * (legacy ? 1 : 4));
 const report = { validation: 'passed', version, source: 'private original named classes and matching libraries', dependencyStubs: false,
  originalLivingEntityConstructed: true, nativeGameRendererNightVisionExecuted: true, nativeMobEffectFactorTickAndPartialExecuted: true, floatBitSamples: count, gpuUsed: false, mismatches };
 await mkdir('test-results', { recursive: true }); await writeFile(`test-results/environment-effects-native-java-${version}.json`, JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2));
} finally { await rm(temp, { recursive: true, force: true }); }
