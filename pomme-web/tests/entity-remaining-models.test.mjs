import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { EntityScene, MeshWriter } from '../src/entities.js';
import { bakedEntityModel, drawEntityModel } from '../src/entity-models.js';
import { REMAINING_ENTITY_MODELS as MODELS } from '../src/entity-remaining-model-data.js';
import { REMAINING_ENTITY_KEYFRAMES as KEYS } from '../src/entity-remaining-keyframe-data.js';
import { consumeRemainingStatus, mannequinProfile, mannequinSkinPatch, prepareRemainingEntity, remainingEntityAnimated, resolveRemainingEntity } from '../src/entity-remaining-models.js';
import { previewEntityData } from '../src/entity-preview.js';
import { drawEquippedItem } from '../src/entity-item-rendering.js';
import { FULLBRIGHT, EMISSIVE_TRANSLUCENT, actorEyeFlags } from '../src/actor-layers.js';
import { textureProfile } from './entity-fixtures.mjs';
import { PlayerSkinCache } from '../src/entity-skins.js';
import { rgbaPNG } from './entity-fixtures.mjs';

const registry = JSON.parse(await readFile(new URL('../data/1.21.11-registry.json', import.meta.url)));
const definition = name => registry.entities.find(e => e.name === name);
const metadata = (name, values) => Object.entries(values).map(([key,value]) => {
  const index = definition(name).metadataKeys.indexOf(key); assert.ok(index >= 0, `${name}/${key}`); return { key: index, value };
});
const paths = ['parrot/parrot_red_blue','parrot/parrot_blue','parrot/parrot_green','parrot/parrot_yellow_blue','parrot/parrot_grey',
  'phantom','phantom_eyes','tadpole/tadpole','armadillo','armadillo/armadillo','armadillo/armadillo_baby','creaking/creaking','creaking/creaking_eyes',
  'warden/warden','warden/warden_bioluminescent_layer','warden/warden_pulsating_spots_1','warden/warden_pulsating_spots_2','warden/warden_heart',
  ...['copper_golem','exposed_copper_golem','weathered_copper_golem','oxidized_copper_golem'].flatMap(n => [`copper_golem/${n}`,`copper_golem/${n}_eyes`]),
  'skeleton/bogged','skeleton/bogged_overlay','skeleton/parched','zombie/zombie','player/slim/alex','player/wide/steve',
  ...['oak','spruce','birch','jungle','acacia','dark_oak','mangrove','cherry','pale_oak','bamboo'].flatMap(n => [`boat/${n}`,`chest_boat/${n}`])];
const tiles = new Map(paths.map((p,i) => [`minecraft:entity/${p}`,i]));
const atlas = { entityTiles: tiles, tiles: paths.map(path => ({ width: /boat/.test(path) ? 128 : path.startsWith('warden') ? 128 : path.startsWith('parrot') ? 32 : path.startsWith('tadpole') ? 16 : 64,
  height: path.startsWith('chest_boat') || path.startsWith('warden') ? 128 : /parrot|skeleton\//.test(path) ? 32 : path.startsWith('tadpole') ? 16 : 64 })) };
const context = { position: [0,0,0], rotation: [0,0,0], scale: 1, skin: { tile: 0, sheet: [64,64] } };
const verts = mesh => Array.from({length: mesh.length / 14}, (_,i) => mesh.subarray(i*14,i*14+14));
const layer = (mesh,path) => verts(mesh).filter(v => v[12] === tiles.get(`minecraft:entity/${path}`));
const extent = (mesh,axis) => { const values=verts(mesh).map(v=>v[axis]); return Math.max(...values)-Math.min(...values); };
const approx = (a,b,e=1e-6) => assert.ok(Math.abs(a-b)<e, `${a} != ${b}`);
function fixture(name, values={}, options={}) {
  const uploads=[], r={...registry, version:{minecraftVersion:options.version??'1.21.11'}}, scene=new EntityScene({ registry:r, atlas, renderer:{
    uploadDynamicMesh(key,opaque){ uploads.push(opaque.slice()); }, removeMesh() {},
  } });
  const entity={id:1,uuid:options.uuid??'01234567-89ab-cdef-0123-456789abcdef',entityType:definition(name).id,x:0,y:0,z:0,yaw:0,pitch:0,
    grounded:options.grounded??true,metadata:metadata(name,values),equipment:options.equipment??[]};
  scene.consume({type:'spawn',entity});
  const update=(time, eye=[0,2,8], camera={})=>{scene.update(time,eye,camera);return uploads.at(-1)??new Float32Array();};
  return {scene,entity,uploads,update};
}
function native(name, values={}, model=name, track={}) {
  Object.assign(track,{definition:definition(name),entity:track.entity??{id:1,grounded:true},createdAt:0});
  return {track, at:(time, extras={})=>prepareRemainingEntity(track,{family:name,nativeModel:model,minecraftVersion:'1.21.11',time,worldSpeed:0,pitch:0,headYaw:0,...extras},
    (key,fallback)=>values[key]??fallback,extras)};
}

test('remaining native facts have complete hierarchies, nondegenerate faces and valid animation bones',()=>{
  for(const [name,data] of Object.entries(MODELS)) {
    const model=bakedEntityModel(name);assert.ok(model,name);
    data.parts.forEach((part,i)=>{
      assert.ok(part.parent===null||part.parent<i,`${name}/${part.name}`);
      for(const cube of model.parts[i].geometry) for(let at=0;at<cube.length;at+=8) {
        assert.ok([...cube.subarray(at,at+8)].every(Number.isFinite),name);
        approx(Math.hypot(...cube.subarray(at+3,at+6)),1);
        assert.ok(cube[at+6]>=0&&cube[at+6]<=1&&cube[at+7]>=0&&cube[at+7]<=1,`${name} UV`);
      }
    });
  }
  for(const [family, group] of Object.entries(KEYS)) {
    const names=new Set(MODELS[family==='armadillo_baby'?'armadillo_baby_modern':family].parts.map(p=>p.name));
    for(const animation of Object.values(group)) for(const channel of animation.channels) {
      assert.ok(names.has(channel.bone),`${family}/${channel.bone}`);
      assert.ok(channel.keys.every(k=>k.slice(0,4).every(Number.isFinite)));
      assert.ok(channel.keys.every((k,i)=>!i||k[0]>=channel.keys[i-1][0]));
    }
  }
  assert.equal(MODELS.warden.parts.filter(p=>p.cubes.length).length,10);
  assert.equal(KEYS.copper_golem.COPPER_GOLEM_CHEST_INTERACTION_ITEM_DROP.length,3);
});

test('armadillo hides body geometry while retaining its children and follows native shell thresholds',()=>{
  const values={armadillo_state:1}, n=native('armadillo',values);
  assert.ok(n.at(0).hiddenParts.has('cube'));
  assert.ok(n.at(.25).hiddenParts.has('cube'));
  const rolled=n.at(.3);assert.ok(rolled.skipDrawParts.has('body'));assert.ok(!rolled.hiddenParts.has('head'));
  assert.ok(rolled.hiddenParts.has('tail'));assert.ok(!rolled.hiddenParts.has('right_front_leg'));
  const writer=new MeshWriter();drawEntityModel(writer,'armadillo',context,rolled,{skipDrawParts:rolled.skipDrawParts,hiddenParts:rolled.hiddenParts});
  assert.ok(writer.length>36*14,'shell, head, ears and front legs survive skipDraw');
  values.armadillo_state=3; assert.ok(n.at(.4).skipDrawParts.has('body'));
  assert.ok(!n.at(1.75).skipDrawParts.has('body'));
  values.armadillo_state=0;const look=n.at(2,{pitch:1,headYaw:-2});
  approx(look.keyframes.get('head').rotation[0],25*Math.PI/180);approx(look.keyframes.get('head').rotation[1],-32.5*Math.PI/180);
});

test('armadillo 26.1 baby uses its distinct native geometry, sheet and keyframes without a second shrink',()=>{
  const adult=fixture('armadillo'), old=fixture('armadillo',{baby:true}), modern=fixture('armadillo',{baby:true},{version:'26.1'});
  const a=adult.update(.1),b=old.update(.1),c=modern.update(.1);
  approx(extent(b,0)/extent(a,0),.6);assert.notDeepEqual(c,b);
  assert.equal(modern.scene.skinFor('armadillo',modern.entity,definition('armadillo')).model,'armadillo_baby_modern');
  assert.ok(layer(c,'armadillo/armadillo_baby').length>0);
  assert.notDeepEqual(KEYS.armadillo_baby.ARMADILLO_BABY_WALK,KEYS.armadillo.ARMADILLO_WALK);
});

test('native texture paths follow the original archive version for armadillos and every copper oxidation layer',()=>{
  assert.equal(resolveRemainingEntity('armadillo',()=>false,'1.21.11').assetId,'minecraft:entity/armadillo');
  assert.equal(resolveRemainingEntity('armadillo',()=>false,'26.1').assetId,'minecraft:entity/armadillo/armadillo');
  assert.equal(resolveRemainingEntity('phantom',()=>false,'1.21.11').assetId,'minecraft:entity/phantom');
  assert.equal(resolveRemainingEntity('phantom',()=>false,'26.1').assetId,'minecraft:entity/phantom/phantom');
  const prefixes=['copper_golem','exposed_copper_golem','weathered_copper_golem','oxidized_copper_golem'];
  const suffixes=['','_exposed','_weathered','_oxidized'];
  for(let weather=0;weather<4;weather++) for(const version of ['1.21.11','26.1']) {
    const n=native('copper_golem',{weather_state:weather,mob_flags:1});
    const p=n.at(.1,{minecraftVersion:version});
    const body=version==='26.1'?`copper_golem${suffixes[weather]}`:prefixes[weather];
    const eyes=version==='26.1'?`copper_golem_eyes${suffixes[weather]}`:`${prefixes[weather]}_eyes`;
    assert.equal(resolveRemainingEntity('copper_golem',(key,fallback)=>key==='weather_state'?weather:fallback,version).assetId,`minecraft:entity/copper_golem/${body}`);
    assert.ok(p.nativeLayers.some(layer=>layer.path===`minecraft:entity/copper_golem/${eyes}`));
  }
});

test('native walk and flap states reach the same pose at 30 and 120 render frames per second',()=>{
  for(const family of ['parrot','armadillo','creaking','warden','copper_golem']) {
    const run=rate=>{const n=native(family,{},family,{entity:{id:2,grounded:family!=='parrot'}});let pose;
      for(let frame=0;frame<=rate;frame++)pose=n.at(frame/rate,{worldSpeed:1.25});return {pose:pose.keyframes,walk:n.track.specialWalk,flap:n.track.parrotFlap};};
    assert.deepEqual(run(30),run(120),family);
  }
});

test('parrot native variants, sitting and flight retain the original rest pose and terminal cache',()=>{
  for(let variant=0;variant<5;variant++)assert.equal(resolveRemainingEntity('parrot',(k,f)=>k==='variant'?variant:f,'1.21.11').assetId,`minecraft:entity/parrot/parrot_${['red_blue','blue','green','yellow_blue','grey'][variant]}`);
  const sit=native('parrot',{flags:1});const p=sit.at(1);approx(p.keyframes.get('body').translation[1],1.9);
  approx(p.keyframes.get('left_leg').rotation[0],1.5707964);assert.equal(remainingEntityAnimated(sit.track,1,(k,f)=>k==='flags'?1:f),false);
  const flight=native('parrot',{},'parrot',{entity:{id:1,grounded:false}});flight.at(0);const flying=flight.at(.4);
  approx(flying.keyframes.get('left_leg').rotation[0],.6981317);assert.ok(flying.keyframes.get('left_wing').rotation[2]<0);
  const party=native('parrot',{flags:1},'parrot',{entity:{id:1,grounded:true,partyParrot:true}}),dancing=party.at(.2);
  approx(dancing.keyframes.get('head').translation[1],Math.sin(4));
  approx(dancing.keyframes.get('left_leg').rotation[2],-.34906584);
  assert.equal(remainingEntityAnimated(party.track,.2,(k,f)=>k==='flags'?1:f),true,'native party pose takes priority over sitting');
});

test('native jukebox events animate nearby parrots and clear party state at the source radius or removed block',()=>{
  const f=fixture('parrot',{flags:1});const sitting=f.update(.1);
  f.scene.consume({type:'record',position:[0,0,0],playing:true});const party=f.update(.2,[0,2,8],{sampleBlock:()=>({name:'jukebox'})});
  assert.notDeepEqual(party,sitting);assert.equal(f.scene.entities.get(1).entity.partyParrot,true);
  f.scene.consume({type:'record',position:[0,0,0],playing:false});f.update(.3);
  assert.equal(f.scene.entities.get(1).entity.partyParrot,false);
  f.scene.consume({type:'record',position:[0,0,0],playing:true});f.update(.4,[0,2,8],{sampleBlock:()=>({name:'air'})});
  assert.equal(f.scene.entities.get(1).entity.partyParrot,false);
  f.scene.consume({type:'record',position:[0,0,0],playing:true});
  f.scene.consume({type:'update',entity:{...f.entity,x:4.1}});f.update(.6,[0,2,8],{sampleBlock:()=>({name:'jukebox'})});
  assert.equal(f.scene.entities.get(1).entity.partyParrot,false);
});

test('phantom native size/pitch and coincident eyes preserve invisible and NO_OVERLAY behavior',()=>{
  const small=fixture('phantom'),large=fixture('phantom',{size:4}),s=small.update(.1),l=large.update(.1);approx(extent(l,0)/extent(s,0),1.6);
  const eyes=layer(s,'phantom_eyes'),body=layer(s,'phantom');assert.equal(eyes.length,body.length);
  eyes.forEach((v,i)=>assert.deepEqual([...v.slice(0,6)],[...body[i].slice(0,6)]));
  small.scene.consume({type:'status',id:1,status:2});const hurt=small.update(.2);
  assert.ok(layer(hurt,'phantom').some(v=>v[7]<1));assert.ok(layer(hurt,'phantom_eyes').every(v=>v[6]===1&&v[7]===1&&v[8]===1));
  const hidden=fixture('phantom',{shared_flags:32}).update(.1);assert.equal(layer(hidden,'phantom').length,0);assert.equal(layer(hidden,'phantom_eyes').length,eyes.length);
  const n=native('phantom');assert.equal(n.at(.3).keyframes.has('head'),false,'native fixed head rest is not overwritten');
});

test('tadpole native dry-land tail swing is one and a half times its water amplitude',()=>{
  const n=native('tadpole'),wet=n.at(.2,{inWater:true}),dry=n.at(.2,{inWater:false});
  approx(dry.keyframes.get('tail').rotation[1]/wet.keyframes.get('tail').rotation[1],1.5);
  const f=fixture('tadpole'),a=f.update(.2,[0,1,4],{inWaterAt:()=>true}),b=f.update(.4,[0,1,4],{inWaterAt:()=>false});assert.notDeepEqual(a,b);
});

test('warden emits the native part subsets and quantized alpha, with timed tendril and heart pulses',()=>{
  const n=native('warden');const initial=n.at(0);
  const bio=initial.nativeLayers.find(l=>l.path.endsWith('bioluminescent_layer'));assert.deepEqual([...bio.parts],['head','left_arm','right_arm','left_leg','right_leg']);
  assert.equal(bio.flags,32|FULLBRIGHT|EMISSIVE_TRANSLUCENT);assert.equal(bio.noOverlay,false);
  assert.equal(initial.nativeLayers.find(l=>l.path.endsWith('spots_1')).alpha,63/255);
  consumeRemainingStatus(n.track,61,0);const tendril=n.at(.2).nativeLayers.find(l=>l.path==='minecraft:entity/warden/warden');
  assert.deepEqual([...tendril.parts],['left_tendril','right_tendril']);assert.equal(tendril.alpha,153/255);
  assert.ok(!n.at(.55).nativeLayers.some(l=>l.path==='minecraft:entity/warden/warden'));
  const pulse=n.at(2).nativeLayers.find(l=>l.path.endsWith('warden_heart'));assert.equal(pulse.alpha,1);assert.deepEqual([...pulse.parts],['body']);
  assert.ok(!n.at(2.55).nativeLayers.some(l=>l.path.endsWith('warden_heart')));
});

test('warden native attack, roar and sonic boom animate the same source hierarchy',()=>{
  const n=native('warden',{pose:11});n.at(0);const roar=n.at(.5).keyframes;
  const base=native('warden').at(.5).keyframes;assert.notDeepEqual(roar,base);
  n.track.attackAt=.5;consumeRemainingStatus(n.track,62,.5);assert.notDeepEqual(n.at(.8).keyframes,roar);
  const f=fixture('warden');const mesh=f.update(.1);const glow=verts(mesh).filter(v=>(v[13]&EMISSIVE_TRANSLUCENT)!==0);
  assert.ok(glow.some(v=>Math.abs(v[9]-Math.floor(Math.cos(2*.045)*.25*255)/255)<1e-6));
  assert.ok(glow.every(v=>Math.abs(v[9]*255-Math.round(v[9]*255))<1e-5));
});

test('creaking movement lock, invulnerability and teardown select native channels and eye visibility',()=>{
  const values={can_move:false,is_active:true},n=native('creaking',values);n.at(0);const locked=n.at(.2,{worldSpeed:2});
  assert.equal(locked.walkSpeed,0);assert.equal(locked.nativeLayers[0].parts.has('head'),true);
  values.can_move=true;const moving=n.at(.4,{worldSpeed:2});assert.ok(moving.walkSpeed>1,'native creaking walk scale can exceed one');
  consumeRemainingStatus(n.track,66,.4);assert.notDeepEqual(n.at(.5).keyframes,moving.keyframes);
  values.is_tearing_down=true;const death=n.at(.6);assert.ok(death.suppressDeathRotation&&death.suppressHurt);
  const f=fixture('creaking',{is_active:true});const visible=f.update(.1);assert.equal(layer(visible,'creaking/creaking_eyes').length,96);
  const hidden=fixture('creaking',{is_active:true,shared_flags:32}).update(.1);assert.equal(layer(hidden,'creaking/creaking').length,0);assert.equal(layer(hidden,'creaking/creaking_eyes').length,96);
});

test('copper golem source oxide sheets, held-arm clamps, interaction channels and idle caching are native',()=>{
  for(let oxide=0;oxide<4;oxide++) {
    const n=fixture('copper_golem',{weather_state:oxide}),mesh=n.update(.1);assert.equal(n.scene.stats.fallbackModels,0);
    assert.ok(layer(mesh,`copper_golem/${['copper_golem','exposed_copper_golem','weathered_copper_golem','oxidized_copper_golem'][oxide]}_eyes`).length>0);
  }
  const values={mob_flags:1},n=native('copper_golem',values);const held=n.at(0,{hasHands:true});
  assert.equal(held.copperGolemState,'idle');assert.ok(held.keyframes.get('right_arm').rotation[0]<=-.87266463);
  assert.ok(held.keyframes.get('left_arm').rotation[1]>=.1134464);
  values.copper_golem_state=3;n.at(.1,{hasHands:true});assert.notDeepEqual(n.at(.6,{hasHands:true}).keyframes,held.keyframes);
  const f=fixture('copper_golem',{mob_flags:1});f.update(.1);const count=f.uploads.length;f.update(.5);f.update(1);assert.equal(f.uploads.length,count);
});

test('copper golem held items apply its native hand transform before the common layer offset',()=>{
  const mesh={parts:[{vertices:new Float32Array([0,0,0,0,1,0,0,0]),tile:0,tint:[1,1,1],flags:32}],display:{thirdperson_righthand:{},thirdperson_lefthand:{}}};
  const arm={matrix:[1,0,0,0,1,0,0,0,1],position:[.5,1.125,.125]};
  for(const side of [-1,1]) {
    let call;const writer={triangles(v,c,options){call=options;}};
    assert.ok(drawEquippedItem(writer,context,mesh,arm,{family:'copper_golem',copperGolemState:'idle'},side));
    call.position.forEach((v,i)=>approx(v,[.5,.5,.0625][i]));approx(Math.hypot(...call.matrix.slice(0,3)),1);
    drawEquippedItem(writer,context,mesh,arm,{family:'copper_golem',copperGolemState:'dropping_item'},side);
    call.position.forEach((v,i)=>approx(v,[.5-.06875-side*.034375,.609375,-.046875][i]));approx(Math.hypot(...call.matrix.slice(0,3)),.55);
  }
});

test('copper golem renders actual held meshes with NO_OVERLAY and omits humanoid armor slots',()=>{
  const item=name=>({present:true,itemId:registry.items.find(i=>i.name===name).id,itemCount:1});
  const f=fixture('copper_golem',{mob_flags:1},{equipment:[{slot:0,item:item('copper_ingot')},{slot:4,item:item('iron_chestplate')}]});
  const vertices=new Float32Array([0,0,0,0,1,0,0,0, .1,0,0,0,1,0,1,0, 0,0,.1,0,1,0,0,1]);
  f.scene.itemLibrary.get=()=>({parts:[{vertices,tile:99,tint:[1,1,1],flags:32}],display:{thirdperson_righthand:{}}});
  const first=f.update(.1);assert.equal(f.scene.stats.equipmentParts,1);assert.equal(verts(first).filter(v=>v[12]===99).length,3);
  f.scene.consume({type:'status',id:1,status:2});const hurt=f.update(.2);
  assert.ok(verts(hurt).filter(v=>v[12]===99).every(v=>v[6]===1&&v[7]===1&&v[8]===1));
});

test('bogged shearing removes its six native mushroom planes and retains the distinct .2 clothing shell',()=>{
  const a=fixture('bogged').update(.1),b=fixture('bogged',{sheared:true}).update(.1);
  assert.equal(layer(a,'skeleton/bogged').length-layer(b,'skeleton/bogged').length,72);
  assert.ok(layer(b,'skeleton/bogged_overlay').length>0);
  assert.deepEqual(MODELS.bogged_outer.parts[0].cubes.map(c=>c.inflate),[.2,.7]);
  assert.ok(MODELS.bogged_outer.parts.slice(1).every(p=>p.cubes[0].inflate===.2));
});

test('modern typed boats and rafts use native geometry and wood sheets instead of a fallback vehicle',()=>{
  for(const name of registry.entities.map(e=>e.name).filter(n=>/_(?:chest_)?(?:boat|raft)$/.test(n))) {
    const f=fixture(name),mesh=f.update(.1);assert.equal(f.scene.stats.nativeModels,1,name);assert.equal(f.scene.stats.fallbackModels,0,name);assert.ok(mesh.length>0,name);
  }
  const f=fixture('bamboo_raft',{paddle_left:true});const a=f.update(.1),b=f.update(.3);assert.notDeepEqual(a,b);
  assert.equal(f.scene.skinFor('bamboo_raft',f.entity,definition('bamboo_raft')).model,'raft_modern');
});

test('boat bubble and damage tilt reach native meshes and settle back to a cached rest pose',()=>{
  const steady=fixture('oak_boat'),bubble=fixture('oak_boat',{bubble_time:60}),hurt=fixture('oak_boat',{hurt:8,damage:20,hurtdir:1});
  const rest=steady.update(.25),wave=bubble.update(.25),tilt=hurt.update(.25);
  assert.notDeepEqual(wave,rest);assert.notDeepEqual(tilt,rest);
  bubble.scene.entities.get(1).entity.isUnderWater=true;bubble.scene.dirty=true;
  assert.deepEqual(bubble.update(.3),steady.update(.3),'modern submerged boat suppresses only native bubble wobble');
  const stopped=fixture('oak_boat',{bubble_time:60});stopped.update(.25);
  stopped.scene.consume({type:'update',entity:{...stopped.entity,metadata:metadata('oak_boat',{bubble_time:0})}});
  stopped.update(.8);const settled=stopped.update(.9),uploads=stopped.scene.stats.uploads;
  assert.deepEqual(settled,steady.update(.9));stopped.update(1.1);
  assert.equal(stopped.scene.stats.uploads,uploads,'settled boat retains its mesh');
});

test('native boat patch has its own depth channel, follows hull-top submersion and never appears on rafts',()=>{
  const uploads=[],removed=[],scene=new EntityScene({registry,atlas,renderer:{supportsNativeWaterMask:true,
    uploadDynamicMesh(key,vertices,_transparent,bounds,options){uploads.push({key,vertices:vertices.slice(),bounds,options});},removeMesh(key){removed.push(key);}}});
  const offset=[4194304,0,-4194304],boat=definition('oak_boat');
  const entity={id:1,entityType:boat.id,x:offset[0],y:0,z:offset[2],metadata:[]};
  scene.consume({type:'spawn',entity});scene.update(.1,[offset[0],2,offset[2]+8],{sampleBlock:()=>({name:'water',fluid:{kind:'water',height:.5}})});
  const patch=uploads.find(upload=>upload.options.nativeWaterMask);assert.ok(patch);
  assert.equal(patch.key,'__minecraft_boat_water_mask');assert.equal(patch.vertices.length,36*14);
  assert.deepEqual(patch.options.origin,[4194304,0,-4194304]);
  assert.ok(patch.vertices.every(Number.isFinite));assert.equal(scene.stats.waterMaskVertices,36);
  assert.ok(patch.bounds.min[0]>offset[0]-2&&patch.bounds.max[0]<offset[0]+2);
  const count=uploads.length;scene.update(.2,[offset[0],2,offset[2]+8],{sampleBlock:()=>({name:'water',fluid:{kind:'water',height:.5}})});
  assert.equal(uploads.length,count,'stable native hull mask retains its vertex buffer');
  scene.update(.3,[offset[0],2,offset[2]+8],{sampleBlock:()=>({name:'water',fluid:{kind:'water',height:1}})});
  assert.ok(removed.includes('__minecraft_boat_water_mask'));assert.equal(scene.stats.waterMaskVertices,0);
  scene.clear();scene.consume({type:'spawn',entity:{...entity,entityType:definition('bamboo_raft').id}});
  scene.update(.4,[offset[0],2,offset[2]+8]);assert.equal(scene.stats.waterMaskVertices,0);
});

test('mannequin has the native empty-profile skin independent of spawn UUID, player layers and source scale',()=>{
  const a=fixture('mannequin',{}, {uuid:'00000000-0000-0000-0000-00000000000f'}),b=fixture('mannequin',{}, {uuid:'00000000-0000-0000-0000-000000000010'});
  const x=a.update(.1),y=b.update(.1);assert.deepEqual(x,y);assert.ok(layer(x,'player/slim/alex').length>0);assert.equal(a.scene.stats.nativeModels,1);
  const hidden=fixture('mannequin',{player_mode_customisation:0}).update(.1);assert.ok(hidden.length<x.length);
  const player=fixture('player',{}, {uuid:'00000000-0000-0000-0000-000000000000'}).update(.1);assert.deepEqual(x,player);
  const prop=textureProfile('x','https://textures.minecraft.net/texture/'+'a'.repeat(64)).player.properties[0];
  assert.deepEqual(mannequinProfile({properties:{textures:[{value:prop.value,signature:'original'}]}}).properties,[{name:'textures',value:prop.value,signature:'original'}]);
  const giant=fixture('giant').update(.1),zombie=fixture('zombie').update(.1);approx(extent(giant,1)/extent(zombie,1),6);
});

test('mannequin signed profile properties use the existing native account-skin cache and correct arm width',async()=>{
  const property=textureProfile('x','https://textures.minecraft.net/texture/'+'b'.repeat(64),false).player.properties[0];
  const f=fixture('mannequin',{profile:{properties:{textures:[{value:property.value,signature:'source-signature'}]}}});
  const rgba=new Uint8Array(64*64*4).fill(255),bytes=rgbaPNG(64,64,rgba);let request;
  f.scene.skinCache=new PlayerSkinCache({appendTile:()=>77,fetchSkin:async(url)=>{request=url;return {ok:true,arrayBuffer:async()=>bytes.buffer};},onReady:()=>{f.scene.dirty=true;}});
  f.update(.1);assert.ok(layer(f.uploads.at(-1),'player/slim/alex').length>0,'native default while the profile resolves');
  await [...f.scene.skinCache.skins.values()][0].promise;
  const rendered=f.update(.2);assert.equal(request,'https://textures.minecraft.net/texture/'+'b'.repeat(64));
  const resolved=f.scene.skinFor('mannequin',f.entity,definition('mannequin'));
  assert.equal(resolved.model,'player');assert.equal(resolved.skin.tile,77);assert.ok(verts(rendered).some(v=>v[12]===77));
  f.scene.skinCache.clear();
});

test('mannequin native resource skin patch independently overrides supplied body and model fields',()=>{
  const wide=fixture('mannequin',{profile:{skinPatch:{body:'minecraft:entity/player/wide/steve',model:'wide'}}});
  const w=wide.update(.1),resolved=wide.scene.skinFor('mannequin',wide.entity,definition('mannequin'));
  assert.equal(resolved.model,'player');assert.equal(resolved.skin.tile,tiles.get('minecraft:entity/player/wide/steve'));
  assert.ok(layer(w,'player/wide/steve').length>0);
  const narrow=fixture('mannequin',{profile:{texture:'entity/player/wide/steve',model:'slim'}});
  narrow.update(.1);assert.equal(narrow.scene.skinFor('mannequin',narrow.entity,definition('mannequin')).model,'player_slim');
  const modelOnly=fixture('mannequin',{profile:{skinPatch:{model:'wide'}}});modelOnly.update(.1);
  assert.equal(modelOnly.scene.skinFor('mannequin',modelOnly.entity,definition('mannequin')).model,'player');
  assert.deepEqual(mannequinSkinPatch({skinPatch:{body:'https://example.invalid/skin.png',model:'unknown'}},atlas),{tile:undefined,slim:undefined});
});

test('saved native family variants and mannequin customization survive preview normalization',()=>{
  const value=(name,nbt,key)=>previewEntityData(nbt,definition(name),registry).metadata.find(e=>e.key===definition(name).metadataKeys.indexOf(key))?.value;
  assert.equal(value('armadillo',{state:'scared'},'armadillo_state'),'scared');
  assert.equal(value('copper_golem',{weather_state:'oxidized'},'weather_state'),3);
  assert.equal(value('parrot',{Variant:4,Sitting:true,Owner:'native'},'variant'),4);assert.equal(value('parrot',{Sitting:true,Owner:'native'},'flags'),5);
  assert.equal(value('phantom',{size:4},'size'),4);assert.equal(value('bogged',{sheared:true},'sheared'),true);
  assert.equal(value('mannequin',{hidden_layers:['hat','left_sleeve'],main_hand:'left',pose:'crouching'},'player_mode_customisation'),59);
  assert.equal(value('mannequin',{main_hand:'left'},'player_main_hand'),0);assert.equal(value('mannequin',{pose:'crouching'},'pose'),5);
});

test('new native model families retain identical subblocks before Float32 at extreme coordinates',()=>{
  const offset=[4194304,2000000000,-4194304];
  for(const family of ['warden','creaking','copper_golem','armadillo','phantom','mannequin','pale_oak_chest_boat']) {
    const origin=fixture(family),distant=fixture(family);
    Object.assign(distant.entity,{x:offset[0],y:offset[1],z:offset[2]});
    distant.scene.consume({type:'spawn',entity:distant.entity});
    const a=origin.update(.1),b=distant.update(.1,[offset[0],offset[1]+2,offset[2]+8]);
    assert.deepEqual(a,b,family);assert.ok(new Set(verts(b).map(v=>v[1])).size>3,family);
    assert.ok(extent(b,1)>.1,family);
  }
});
