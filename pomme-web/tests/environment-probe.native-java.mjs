// Optional differential against private original named classes and libraries.
// No game implementation or assets are stored in this test.
import assert from 'node:assert/strict';
import { readdir, mkdtemp, writeFile, rm, mkdir } from 'node:fs/promises';
import { join, delimiter } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { ENVIRONMENT_EASINGS, compileEnvironmentEase } from '../src/environment-easing.js';
import { NativeFogAttributeProbe, WATER_FOG_ATTRIBUTES as A, applyWaterFogModifier } from '../src/environment-probe.js';
const jar = process.env.POMME_MAPPED_JAR, libraries = process.env.POMME_JAVA_LIBRARIES, version = process.env.POMME_MINECRAFT_VERSION ?? '1.21.11';
if (!jar || !libraries) throw new Error('Set POMME_MAPPED_JAR and POMME_JAVA_LIBRARIES to private native 1.21.11 classes/libraries.');
async function jars(root) { const result = []; for (const entry of await readdir(root, { withFileTypes: true })) { const path = join(root, entry.name); if (entry.isDirectory()) result.push(...await jars(path)); else if (entry.name.endsWith('.jar')) result.push(path); } return result; }
const scratch = await mkdtemp(join(tmpdir(), 'pomme-native-environment-'));
const floatCases = [
  ['add', .85], ['subtract', .85], ['multiply', .85], ['minimum', 70], ['maximum', 120], ['alpha_blend', { value: 100, alpha: .25 }], ['alpha_blend', 100],
].map(([modifier, argument]) => ({ base: 96, entry: { modifier, argument } }));
const colorCases = [
  ['#fa8020', 'add', '#10a020'], ['#fa8020', 'subtract', '#ffff40'], ['#ff8040', 'multiply', '#8080ff'],
  ['#ff0000', 'alpha_blend', '#800000ff'], ['#ff0000', 'alpha_blend', '#000000ff'], ['#ffffff', 'blend_to_gray', { brightness: .5, factor: 1 }], ['#6abc18', 'blend_to_gray', { brightness: .85, factor: .371 }],
].map(([base, modifier, argument]) => ({ base, entry: { modifier, argument } }));
const fp = value => `${Number(value)}f`, intColor = value => value.length === 7 ? `0xff${value.slice(1)}` : `0x${value.slice(1)}`;
const floatJava = floatCases.map(({ base, entry }, i) => `System.out.println("F ${i} "+Integer.toUnsignedString(Float.floatToRawIntBits(FloatModifier.${entry.modifier.toUpperCase()}.apply(${fp(base)},${entry.modifier === 'alpha_blend' ? `new FloatWithAlpha(${fp(typeof entry.argument === 'number' ? entry.argument : entry.argument.value)},${fp(typeof entry.argument === 'number' ? 1 : entry.argument.alpha)})` : fp(entry.argument)}))));`).join('\n');
const colorJava = colorCases.map(({ base, entry }, i) => `System.out.println("C ${i} "+Integer.toUnsignedString(ColorModifier.${entry.modifier === 'multiply' ? 'MULTIPLY_RGB' : entry.modifier.toUpperCase()}.apply(${intColor(base)},${entry.modifier === 'blend_to_gray' ? `new ColorModifier.BlendToGray(${fp(entry.argument.brightness)},${fp(entry.argument.factor)})` : intColor(entry.argument)})));`).join('\n');
const positions = [[0, 0, 0], [.25, 2, -.5], [-16.5, 40000.125, 32.25], [2000000000.5, -32.75, -2000000000.5], [-2000000000.5, 2000000000.25, 2000000000.5]];
const source = `import java.util.*; import net.minecraft.world.attribute.*; import net.minecraft.world.attribute.modifier.*; import net.minecraft.util.*; import net.minecraft.world.phys.Vec3;
public class NativeEnvironmentProof {
 public static void main(String[] args) throws Exception {
  java.io.PrintStream proofOut=System.out;net.minecraft.SharedConstants.tryDetectVersion();net.minecraft.server.Bootstrap.bootStrap();System.setOut(proofOut);
  String[] names=${JSON.stringify(ENVIRONMENT_EASINGS).replaceAll('[', '{').replaceAll(']', '}')};
  for(String name:names) { EasingType ease=(EasingType)EasingType.class.getField(name.toUpperCase(Locale.ROOT)).get(null);
   for(int i=0;i<=100;i++) {float x=(float)i/100f;System.out.println("E "+name+" "+x+" "+Integer.toUnsignedString(Float.floatToRawIntBits(ease.apply(x))));}
  }
  float[][] controls={{.42f,0f,.58f,1f},{.1f,-2f,.9f,2f},{0f,0f,0f,1f}};
  for(int c=0;c<controls.length;c++){float[] p=controls[c];EasingType ease=EasingType.cubicBezier(p[0],p[1],p[2],p[3]);for(int i=0;i<=100;i++){float x=(float)i/100f;System.out.println("B "+c+" "+x+" "+Integer.toUnsignedString(Float.floatToRawIntBits(ease.apply(x))));}}
  ${floatJava}
  ${colorJava}
  var color=EnvironmentAttribute.builder(AttributeTypes.RGB_COLOR).defaultValue(0xff050533).spatiallyInterpolated().build();
  var start=EnvironmentAttribute.builder(AttributeTypes.FLOAT).defaultValue(-8f).spatiallyInterpolated().build();
  var end=EnvironmentAttribute.builder(AttributeTypes.FLOAT).defaultValue(96f).spatiallyInterpolated().build();
  EnvironmentAttributeMap[] maps={EnvironmentAttributeMap.builder().set(color,0xff203040).modify(end,FloatModifier.ADD,-4f).build(),EnvironmentAttributeMap.builder().set(color,0xffc01020).modify(end,FloatModifier.MULTIPLY,.85f).build(),EnvironmentAttributeMap.builder().set(color,0xfff0f0f0).set(start,-32f).set(end,64f).build(),EnvironmentAttributeMap.builder().modify(end,FloatModifier.MINIMUM,80f).build(),EnvironmentAttributeMap.CODEC.parse(com.mojang.serialization.JsonOps.INSTANCE,new com.google.gson.JsonObject()).getOrThrow(),EnvironmentAttributeMap.CODEC.parse(com.mojang.serialization.JsonOps.INSTANCE,new com.google.gson.JsonObject()).getOrThrow()};
  double[][] positions=${JSON.stringify(positions).replaceAll('[', '{').replaceAll(']', '}')};
  for(int i=0;i<positions.length;i++){double[] pos=positions[i];SpatialAttributeInterpolator blend=new SpatialAttributeInterpolator();GaussianSampler.sample(new Vec3(pos[0],pos[1],pos[2]).scale(.25),(x,y,z)->maps[Math.floorMod(x+y+z,6)],blend::accumulate);
   System.out.println("G "+i+" "+Integer.toUnsignedString(blend.applyAttributeLayer(color,0xff050533))+" "+Integer.toUnsignedString(Float.floatToRawIntBits(blend.applyAttributeLayer(start,-8f)))+" "+Integer.toUnsignedString(Float.floatToRawIntBits(blend.applyAttributeLayer(end,100f))));}
  var track=new KeyframeTrack<Float>(List.of(new Keyframe<Float>(2,20f),new Keyframe<Float>(6,60f)),EasingType.LINEAR).bakeSampler(Optional.of(10),LerpFunction.ofFloat());
  long[] times={-1L,2L,4L,6L,10L,Long.MIN_VALUE,Long.MAX_VALUE};for(long time:times)System.out.println("T "+time+" "+Integer.toUnsignedString(Float.floatToRawIntBits(track.sample(time))));
 }
}`;
try {
  const path = join(scratch, 'NativeEnvironmentProof.java'); await writeFile(path, source);
  const classpath = [jar, ...await jars(libraries)].join(delimiter);
  if (process.env.POMME_JAVA_COMPILER) {
    const compiled = spawnSync('/usr/bin/java', ['-jar', process.env.POMME_JAVA_COMPILER, '-25', '-cp', classpath, '-d', scratch, path], { encoding: 'utf8', timeout: 60000, maxBuffer: 4 * 1024 * 1024 });
    assert.equal(compiled.status, 0, `${compiled.stderr}\n${compiled.stdout}`);
  }
  const result = spawnSync(process.env.JAVA_PATH ?? '/usr/bin/java', ['-cp', [scratch, classpath].join(delimiter), process.env.POMME_JAVA_COMPILER ? 'NativeEnvironmentProof' : path], { encoding: 'utf8', timeout: 60000, maxBuffer: 4 * 1024 * 1024 });
  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
  const bits = value => { const bytes = new ArrayBuffer(4), view = new DataView(bytes); view.setFloat32(0, value); return view.getUint32(0); };
  const controls = [[.42, 0, .58, 1], [.1, -2, .9, 2], [0, 0, 0, 1]], mismatches = []; let samples = 0, modifiers = 0, gaussianValues = 0, timelineValues = 0;
  const definitions = [
    { attributes: { [A.color]: '#203040', [A.end]: { modifier: 'add', argument: -4 } } },
    { attributes: { [A.color]: '#c01020', [A.end]: { modifier: 'multiply', argument: .85 } } },
    { attributes: { [A.color]: '#f0f0f0', [A.start]: -32, [A.end]: 64 } },
    { attributes: { [A.end]: { modifier: 'minimum', argument: 80 } } },
    { attributes: {} }, { attributes: {} },
  ];
  for (const line of result.stdout.split('\n')) {
    const [kind, key, x, expected, last] = line.split(' ');
    if (kind === 'E' || kind === 'B') {
      const actual = bits(compileEnvironmentEase(kind === 'E' ? key : { cubic_bezier: controls[Number(key)] })(Number(x)));
      samples++; if (actual !== Number(expected)) mismatches.push({ kind, key, x, actual, expected: Number(expected) });
    } else if (kind === 'F' || kind === 'C') {
      const { base, entry } = (kind === 'F' ? floatCases : colorCases)[Number(key)], actual = applyWaterFogModifier(kind === 'F' ? 'float' : 'color', base, entry);
      const encoded = kind === 'F' ? bits(actual) : actual;
      modifiers++; if (encoded !== Number(x)) mismatches.push({ kind, key, actual: encoded, expected: Number(x) });
    } else if (kind === 'G') {
      const p = new NativeFogAttributeProbe({ version, dimensionAttributes: { [A.end]: 100 }, getNoiseBiome: (qx, qy, qz) => { const id = ((qx + qy + qz) % 6 + 6) % 6; return { name: `example:biome_${id}`, definition: definitions[id] }; } });
      p.tick({ position: positions[Number(key)] }); const values = p.sample();
      const actual = [(values.waterFogColor | 0xff000000) >>> 0, bits(values.waterFogStart), bits(values.waterFogEnd)], reference = [x, expected, last].map(Number);
      gaussianValues += 3; if (actual.some((value, i) => value !== reference[i])) mismatches.push({ kind, key, actual, expected: reference });
    } else if (kind === 'T') {
      const p = new NativeFogAttributeProbe({ version, getNoiseBiome: () => ({ name: 'minecraft:plains' }), timelines: [{ period_ticks: 10, tracks: { [A.end]: { keyframes: [{ ticks: 2, value: 20 }, { ticks: 6, value: 60 }] } } }] });
      p.tick({ position: [0, 0, 0], dayTime: BigInt(key) }); const actual = bits(p.sample().waterFogEnd); timelineValues++;
      if (actual !== Number(x)) mismatches.push({ kind, key, actual, expected: Number(x) });
    }
  }
  assert.deepEqual(mismatches, []); assert.equal(samples, (ENVIRONMENT_EASINGS.length + 3) * 101);
  assert.equal(modifiers, 14); assert.equal(gaussianValues, 15); assert.equal(timelineValues, 7);
  const report = { validation: 'passed', version, source: 'private original named classes + matching original libraries', dependencyStubs: false,
    nativeEasingTypeExecuted: true, nativeGaussianSamplerExecuted: true, nativeSpatialAttributeInterpolatorExecuted: true, nativeModifierClassesExecuted: true, nativeKeyframeTrackSamplerExecuted: true,
    nativeEnvironmentAttributeProbeExecuted: false, nativeCameraExecuted: false, gpuUsed: false,
    nativeEasings: ENVIRONMENT_EASINGS.length, nativeBezierCurves: 3, easingFloatBitSamples: samples, modifierValues: modifiers, gaussianValues, timelineValues, mismatches };
  await mkdir('test-results', { recursive: true }); await writeFile(`test-results/environment-probe-native-java-${version}.json`, JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2));
} finally { await rm(scratch, { recursive: true, force: true }); }
