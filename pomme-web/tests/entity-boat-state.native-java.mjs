// Optional source differential against privately supplied original classes.
// The original tickBubbleColumn/getBubbleAngle execute with their dependencies;
// an unconstructed original ClientLevel supplies its constant client-side flag.
import assert from 'node:assert/strict';
import { readFile, readdir, mkdtemp, writeFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, delimiter } from 'node:path';
import { spawnSync } from 'node:child_process';
import { advanceBoatVisual, boatBubbleMatrix } from '../src/entity-boat-state.js';
const root = process.env.POMME_NATIVE_REFERENCE_ROOT;
if (!root) throw new Error('Set POMME_NATIVE_REFERENCE_ROOT to private original mapped JARs and matching libraries.');
async function jars(path) { const result=[]; for(const entry of await readdir(path,{withFileTypes:true})) { const child=join(path,entry.name); if(entry.isDirectory())result.push(...await jars(child));else if(entry.name.endsWith('.jar'))result.push(child); }return result; }
const directory=await mkdtemp(join(tmpdir(),'pomme-native-boats-')),reports=[];
const bits = value => new Uint32Array(Float32Array.of(value).buffer)[0];
try {
  for(const version of ['1.20.4','1.21.11']) {
    const modern=version!=='1.20.4',packageName=`net.minecraft.world.entity.vehicle${modern?'.boat':''}`;
    const file=join(directory,'NativeBoatProof.java');
    await writeFile(file,`import net.minecraft.SharedConstants;import net.minecraft.server.Bootstrap;import net.minecraft.world.entity.Entity;import net.minecraft.world.entity.EntityType;
import ${packageName}.Boat;${modern?`import ${packageName}.AbstractBoat;import net.minecraft.world.item.Items;`:''}import net.minecraft.client.multiplayer.ClientLevel;import org.joml.Quaternionf;import org.joml.Matrix3f;
public class NativeBoatProof {
 public static void main(String[]args)throws Exception {
  SharedConstants.tryDetectVersion();Bootstrap.bootStrap();
  var unsafeField=sun.misc.Unsafe.class.getDeclaredField("theUnsafe");unsafeField.setAccessible(true);var unsafe=(sun.misc.Unsafe)unsafeField.get(null);
  ClientLevel level=(ClientLevel)unsafe.allocateInstance(ClientLevel.class);
  try{var clientSide=net.minecraft.world.level.Level.class.getDeclaredField("isClientSide");clientSide.setAccessible(true);clientSide.setBoolean(level,true);}catch(NoSuchFieldException ignored){}
  ${!modern?`var data=(ClientLevel.ClientLevelData)unsafe.allocateInstance(ClientLevel.ClientLevelData.class);
  var dataField=net.minecraft.world.level.Level.class.getDeclaredField("levelData");dataField.setAccessible(true);dataField.set(level,data);`:''}
  Boat boat=${modern?'new Boat(EntityType.OAK_BOAT,null,()->Items.OAK_BOAT)':'new Boat(EntityType.BOAT,null)'};
  var levelField=Entity.class.getDeclaredField("level");levelField.setAccessible(true);levelField.set(boat,level);
  var bubble=${modern?'AbstractBoat':'Boat'}.class.getDeclaredMethod("tickBubbleColumn");bubble.setAccessible(true);
  var setTime=${modern?'AbstractBoat':'Boat'}.class.getDeclaredMethod("setBubbleTime",int.class);setTime.setAccessible(true);setTime.invoke(boat,60);
  for(int tick=0;tick<=40;tick++) {
   if(tick==20)setTime.invoke(boat,0);
   if(tick>0){${!modern?'data.setGameTime(1000L+tick);':''}boat.tickCount=tick;bubble.invoke(boat);}
   for(float partial:new float[]{0,.25f,.5f,.75f})System.out.println("BOAT_ANGLE "+tick+" "+partial+" "+Integer.toUnsignedString(Float.floatToRawIntBits(boat.getBubbleAngle(partial))));
  }
  ${!modern?`var strength=Boat.class.getDeclaredField("bubbleMultiplier");strength.setAccessible(true);
  for(long clock:new long[]{2147483647L,Long.MIN_VALUE,Long.MAX_VALUE,(1L<<60)+(1L<<36)+1,-((1L<<60)+(1L<<36)+1)}){
   strength.setFloat(boat,.95f);setTime.invoke(boat,60);data.setGameTime(clock);bubble.invoke(boat);
   System.out.println("BOAT_LONG "+clock+" "+Integer.toUnsignedString(Float.floatToRawIntBits(boat.getBubbleAngle(1))));
  }`:''}
  for(float angle:new float[]{-10,-1,0,1,10}){
   var matrix=new Matrix3f().rotation(new Quaternionf().setAngleAxis(angle*((float)Math.PI/180),1,0,1));
   System.out.println("BOAT_MATRIX "+angle+" "+matrix.m00()+" "+matrix.m10()+" "+matrix.m20()+" "+matrix.m01()+" "+matrix.m11()+" "+matrix.m21()+" "+matrix.m02()+" "+matrix.m12()+" "+matrix.m22());
  }
 }
}`);
    const classpath=[join(root,version,'client-named.jar'),...await jars(join(root,version,'libraries'))].join(delimiter);
    const compiler=process.env.POMME_ECJ_JAR;
    if(compiler) {
      const compiled=spawnSync(process.env.POMME_COMPILER_JAVA_PATH??'/usr/bin/java',['-jar',compiler,'-21','-proc:none','-cp',classpath,'-d',directory,file],{encoding:'utf8',timeout:60000,maxBuffer:4*1024*1024});
      assert.equal(compiled.status,0,`${compiled.stdout}\n${compiled.stderr}`);
    }
    const result=spawnSync(process.env.POMME_JAVA_PATH??'/usr/bin/java',['-cp',compiler?`${directory}${delimiter}${classpath}`:classpath,compiler?'NativeBoatProof':file],{encoding:'utf8',timeout:60000,maxBuffer:4*1024*1024});
    assert.equal(result.status,0,`${version}\n${result.stdout}\n${result.stderr}`);
    const track={createdAt:0},values={bubble_time:60},metadata=(key,fallback)=>values[key]??fallback;let angles=0,matrices=0,maxMatrixError=0;
    for(const match of result.stdout.matchAll(/BOAT_ANGLE (\d+) ([\d.]+) (\d+)/g)) {
      const tick=Number(match[1]),partial=Number(match[2]);if(tick===20)values.bubble_time=0;
      assert.equal(bits(advanceBoatVisual(track,(tick+partial)/20,metadata,version,1000n+BigInt(tick)).bubbleDegrees),Number(match[3]),`${version} tick${tick} partial${partial}`);angles++;
    }
    for(const match of result.stdout.matchAll(/BOAT_MATRIX (-?[\d.]+) ([^\n]+)/g)) {
      const native=match[2].trim().split(/\s+/).map(Number),actual=boatBubbleMatrix(Number(match[1]));
      native.forEach((value,index)=>{maxMatrixError=Math.max(maxMatrixError,Math.abs(value-actual[index]));});matrices++;
    }
    let longClocks=0;
    for(const match of result.stdout.matchAll(/BOAT_LONG (-?\d+) (\d+)/g)) {
      const longTrack={createdAt:0,boatVisual:{tick:0,strength:Math.fround(.95),angle:0,beforeAngle:0,hurt:null,damage:null}};
      advanceBoatVisual(longTrack,.05,(key,fallback)=>key==='bubble_time'?60:fallback,version,BigInt(match[1]));
      assert.equal(bits(longTrack.boatVisual.angle),Number(match[2]),`${version} Long${match[1]}`);longClocks++;
    }
    assert.equal(longClocks,modern?0:5);
    assert.equal(angles,164);assert.equal(matrices,5);assert.ok(maxMatrixError<3e-7,`${version} JOML matrix error${maxMatrixError}`);
    reports.push({version,originalBoatMethodsExecuted:true,dependencyStubs:false,wholeLevelTickExecuted:false,angleFloatBitsChecked:angles,legacyLongFloatClocksChecked:longClocks,matrixComponentsChecked:45,maxMatrixError});
  }
  await mkdir('test-results',{recursive:true});await writeFile('test-results/entity-boat-state-native-java.json',JSON.stringify(reports,null,2));console.log(JSON.stringify(reports,null,2));
} finally {await rm(directory,{recursive:true,force:true});}
