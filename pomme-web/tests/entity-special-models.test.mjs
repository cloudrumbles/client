import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { EntityScene, buildEntityPreview } from '../src/entities.js';
import { bakedEntityModel, drawEntityModel, entityModelNames } from '../src/entity-models.js';
import { SPECIAL_ENTITY_MODELS } from '../src/entity-special-model-data.js';
import { ENTITY_KEYFRAMES } from '../src/entity-keyframe-data.js';
import { sampleEntityKeyframes, prepareSpecialEntity, prepareDragon } from '../src/entity-keyframes.js';
import { actorEyeFlags, FULLBRIGHT, EYES_ADDITIVE, EYES_TRANSLUCENT, EMISSIVE_TRANSLUCENT, WIND_TRANSLUCENT } from '../src/actor-layers.js';

const registry = JSON.parse(await readFile(new URL('../data/1.21.11-registry.json', import.meta.url)));
const definition = name => registry.entities.find(entity => entity.name === name);
const meta = (name, values) => Object.entries(values).map(([key, value]) => ({ key: definition(name).metadataKeys.indexOf(key), value }));
function fixture(name, metadata = []) {
  const uploads = [], scene = new EntityScene({ registry, renderer: { uploadDynamicMesh(key, opaque, liquid, bounds, format) { uploads.push({ opaque: opaque.slice(), bounds, format }); }, removeMesh() {} } });
  const entity = { id: 1, entityType: definition(name).id, x: 0, y: 0, z: 0, yaw: 0, pitch: 0, metadata };
  scene.consume({ type: 'spawn', entity });
  return { scene, entity, uploads };
}

test('missing large mobs now have exact source sheets, cuboids and complete articulated hierarchies', () => {
  for (const [name, sheet] of Object.entries({ camel: [128,128], ravager: [128,128], sniffer: [192,192], breeze: [32,32], ender_dragon: [256,256] })) {
    assert.ok(entityModelNames().includes(name)); assert.deepEqual(bakedEntityModel(name).sheet, sheet);
    const f = fixture(name); f.scene.update(.1, [0, 2, 8]);
    assert.equal(f.scene.stats.nativeModels, 1, name); assert.equal(f.scene.stats.approximateModels, 0, name);
    assert.ok(f.uploads[0].opaque.length / 14 > 100, name);
    assert.ok(f.uploads[0].opaque.every(Number.isFinite), name);
  }
  const camel = SPECIAL_ENTITY_MODELS.camel;
  assert.equal(camel.parts[camel.parts.find(part => part.name === 'head').parent].name, 'body');
  assert.deepEqual(camel.parts.find(part => part.name === 'head').cubes[0].size, [7,8,19]);
  assert.deepEqual(SPECIAL_ENTITY_MODELS.sniffer.parts.find(part => part.name === 'body').cubes[0].size, [25,29,40]);
  assert.equal(SPECIAL_ENTITY_MODELS.ender_dragon.parts.filter(part => part.name.startsWith('neck')).length, 5);
  assert.equal(SPECIAL_ENTITY_MODELS.ender_dragon.parts.filter(part => part.name.startsWith('tail')).length, 12);
});

test('native keyframes honor right-key Catmull-Rom, loop time, positional signs and additive scale', () => {
  const linear = { length: 1, looping: true, channels: [{ bone: 'head', target: 'position', keys: [[0,0,2,4,false],[1,2,4,6,false]] }] };
  assert.deepEqual(sampleEntityKeyframes(linear, .5).get('head').translation, [1,-3,5]);
  assert.deepEqual(sampleEntityKeyframes(linear, 1.5), sampleEntityKeyframes(linear, .5));
  const curve = { length: 3, channels: [{ bone: 'head', target: 'rotation', keys: [[0,0,0,0,false],[1,10,0,0,false],[2,0,0,0,true],[3,0,0,0,false]] }] };
  assert.ok(Math.abs(sampleEntityKeyframes(curve, 1.5).get('head').rotation[0] - 5.625 * Math.PI / 180) < 1e-12);
  const baby = sampleEntityKeyframes(ENTITY_KEYFRAMES.sniffer.BABY_TRANSFORM, 0).get('head');
  assert.ok(baby.scale.every(value => Math.abs(value - .2) < 1e-12));
  assert.deepEqual(baby.translation, [0,-1,1]);
});

test('camel game-age timestamps choose sit, stand and saddle parts while baby geometry uses native scale', () => {
  const f = fixture('camel', meta('camel', { last_pose_change_tick: -1000n }));
  f.scene.update(.1, [0, 2, 8], { gameTime: 1000n }); const standingHeight = f.uploads.at(-1).bounds.max[1];
  f.scene.update(.2, [0, 2, 8], { gameTime: 1045n }); const sittingHeight = f.uploads.at(-1).bounds.max[1];
  assert.ok(sittingHeight < standingHeight - .5, `${standingHeight} → ${sittingHeight}`);
  const baseVertices = f.scene.stats.vertices;
  f.scene.consume({ type: 'update', entity: { ...f.entity, metadata: meta('camel', { last_pose_change_tick: -1000n, flags: 4 }) } });
  f.scene.update(.3, [0, 2, 8], { gameTime: 1045n }); assert.ok(f.scene.stats.vertices > baseVertices);
  const writer = { triangles() {} }, context = { skin: { tile: 0 } };
  const adult = drawEntityModel(writer, 'camel', context, { family: 'camel', swing: 0 });
  const young = drawEntityModel(writer, 'camel', context, { family: 'camel', young: true, swing: 0 });
  assert.equal(adult.model.parts.length, young.model.parts.length);
  const babyTrack = { definition: definition('camel'), entity: { id: 2 }, createdAt: 0 };
  const pose = prepareSpecialEntity(babyTrack, { family: 'camel', time: .1, phase: 0, speed: 0, worldSpeed: 0, pitch: 0, headYaw: 10 }, key => key === 'dash' ? true : 0, 1000n);
  assert.equal(pose.headYaw, Math.PI / 6); assert.ok(pose.pitch > Math.PI / 5);
});

test('native sniffer states and ravager status39 animate beyond the common walking pose', () => {
  const sniffer = fixture('sniffer', meta('sniffer', { state: 0 })); sniffer.scene.update(.1, [0, 2, 8]);
  const idle = sniffer.uploads.at(-1).opaque;
  sniffer.scene.consume({ type: 'update', entity: { ...sniffer.entity, metadata: meta('sniffer', { state: 5 }) } });
  sniffer.scene.update(.2, [0, 2, 8]); sniffer.scene.update(1.2, [0, 2, 8]);
  assert.notDeepEqual(sniffer.uploads.at(-1).opaque, idle);
  const ravager = fixture('ravager'); ravager.scene.update(.1, [0, 2, 8]); const calm = ravager.uploads.at(-1).opaque;
  ravager.scene.consume({ type: 'status', id: 1, status: 39 }); ravager.scene.update(.2, [0, 2, 8]);
  assert.notDeepEqual(ravager.uploads.at(-1).opaque, calm);
  assert.equal(ravager.scene.entities.get(1).stunnedAt, .1);
});

test('Breeze retains distinct body, translucent scrolling wind and emissive eye sheets', () => {
  const f = fixture('breeze');
  f.scene.setAtlas({ entityTiles: new Map([['minecraft:entity/breeze/breeze', 1], ['minecraft:entity/breeze/breeze_wind', 2], ['minecraft:entity/breeze/breeze_eyes', 3]]),
    tiles: [{}, { width: 32, height: 32 }, { width: 128, height: 128 }, { width: 32, height: 32 }] });
  f.scene.update(.1, [0, 2, 8]);
  const first = f.uploads.at(-1).opaque;
  for (const [tile, flag] of [[1,32],[2,WIND_TRANSLUCENT],[3,EMISSIVE_TRANSLUCENT]]) {
    const vertices = Array.from({ length: first.length / 14 }, (_, index) => first.subarray(index * 14, index * 14 + 14)).filter(vertex => vertex[12] === tile);
    assert.ok(vertices.length > 0); assert.ok(vertices.every(vertex => vertex[13] & flag));
    if (tile === 3) assert.ok(vertices.every(vertex => vertex[13] & FULLBRIGHT));
    if (tile !== 1) assert.ok(vertices.every(vertex => vertex[13] === Math.fround(vertex[13])), 'actor flags survive the Float32 and light merge');
  }
  f.scene.update(.2, [0, 2, 8]); const next = f.uploads.at(-1).opaque;
  const uv = array => Array.from({ length: array.length / 14 }, (_, index) => array.subarray(index * 14, index * 14 + 14)).find(vertex => vertex[12] === 2)[10];
  assert.ok(Math.abs(uv(next) - uv(first) - .04) < 1e-6, 'native wind scrolls at .02 texture widths per tick');
});

test('native eyes select version-specific blending without inflating the matching body geometry', () => {
  for (const [name, path] of [['spider','spider_eyes'],['enderman','enderman/enderman_eyes'],['ender_dragon','enderdragon/dragon_eyes']]) {
    for (const [version, flag] of [['1.20.4',EYES_ADDITIVE],['1.21.11',EYES_TRANSLUCENT]]) {
      const f = fixture(name); f.scene.minecraftVersion = version;
      const skin = name === 'spider' ? 'spider/spider' : name === 'enderman' ? 'enderman/enderman' : 'enderdragon/dragon';
      f.scene.setAtlas({ entityTiles: new Map([[`minecraft:entity/${skin}`,1],[`minecraft:entity/${path}`,2]]), tiles: [{},{width:256,height:256},{width:256,height:256}] });
      f.scene.update(.1,[0,2,8]); const vertices = f.uploads.at(-1).opaque;
      const body = [], eyes = [];
      for (let at = 0; at < vertices.length; at += 14) {
        const vertex = vertices.subarray(at, at+14);
        if (vertex[12] === 1) body.push([...vertex.subarray(0,6)]);
        else if (vertex[12] === 2) { eyes.push([...vertex.subarray(0,6)]); assert.equal(vertex[13] & actorEyeFlags(version), actorEyeFlags(version)); assert.ok(vertex[13] & flag); }
      }
      assert.ok(eyes.length > 0); assert.deepEqual(eyes,body, `${name} ${version} uses native coincident eye surfaces`);
    }
  }
});

test('native NO_OVERLAY eye and wind surfaces retain their colors while the damaged body flashes', () => {
  for (const [name,skin,eyes,wind] of [['spider','spider/spider','spider_eyes'], ['enderman','enderman/enderman','enderman/enderman_eyes'],
    ['ender_dragon','enderdragon/dragon','enderdragon/dragon_eyes'], ['breeze','breeze/breeze','breeze/breeze_eyes','breeze/breeze_wind']]) {
    const f = fixture(name);
    const tiles = new Map([[`minecraft:entity/${skin}`,1],[`minecraft:entity/${eyes}`,2]]); if (wind) tiles.set(`minecraft:entity/${wind}`,3);
    f.scene.setAtlas({ entityTiles: tiles, tiles: [{},{width:256,height:256},{width:256,height:256},{width:128,height:128}] });
    f.scene.update(.1,[0,2,8]); const before = f.uploads.at(-1).opaque;
    f.scene.consume({ type: 'status', id: 1, status: 2 }); f.scene.update(.2,[0,2,8]); const after = f.uploads.at(-1).opaque;
    const colors = (mesh,tile) => { const result = []; for (let at = 0; at < mesh.length; at += 14) if (mesh[at+12] === tile) result.push([...mesh.subarray(at+6,at+9)]); return result; };
    assert.notDeepEqual(colors(before,1),colors(after,1),name);
    assert.deepEqual(colors(before,2),colors(after,2),name);
    if (wind) assert.deepEqual(colors(before,3),colors(after,3),name);
  }
});

test('dragon history is 64 ticks, source flap/links are frame independent and reset with a removed entity', () => {
  const sampleAt = time => ({ x: time * 2, y: 5 + time * .1, z: 0, yaw: time * .2 });
  const run = fps => {
    const track = { definition: definition('ender_dragon'), entity: { id: 1 } }; let input;
    for (let frame = 0; frame <= fps * 2; frame++) {
      const time = frame / fps; input = { time };
      prepareDragon(track, input, sampleAt(time), () => 0, sampleAt);
    }
    return { track, input };
  };
  const slow = run(60), fast = run(144);
  assert.equal(slow.track.dragonHistory.values.byteLength, 1024);
  assert.deepEqual(slow.track.dragonHistory.values, fast.track.dragonHistory.values);
  assert.ok(Math.abs(slow.track.dragonHistory.flap - fast.track.dragonHistory.flap) < 1e-12);
  assert.deepEqual(slow.input.dragonTransforms, fast.input.dragonTransforms);
  assert.equal([...slow.input.dragonTransforms.keys()].filter(name => name.startsWith('tail')).length, 12);
  const f = fixture('ender_dragon'); f.scene.update(.1, [0,2,8]);
  assert.equal(f.scene.entities.get(1).dragonHistory.values.length, 128);
  f.scene.consume({ type: 'remove', id: 1 }); assert.equal(f.scene.entities.size, 0);
});

test('dragon flight uses historical renderer yaw and tilt plus the modern body-bank pivot', () => {
  const sampleAt = time => ({ x: time, y: 5 + time * .1, z: 0, yaw: time * .2 });
  const track = { definition: definition('ender_dragon'), entity: { id: 1 } }; let input;
  for (let frame = 0; frame <= 40; frame++) {
    const time = frame / 20; input = { time, minecraftVersion: '1.21.11' };
    prepareDragon(track,input,sampleAt(time),()=>0,sampleAt);
  }
  assert.ok(Math.abs(input.dragonYaw - sampleAt(1.6).yaw) < 1e-12);
  assert.ok(Math.abs(input.dragonTilt - (sampleAt(1.7).y - sampleAt(1.45).y) * Math.PI / 18) < 1e-12);
  assert.deepEqual(input.dragonTransforms.get('dragon_body').offset,[0,3,8]);
  assert.deepEqual(input.dragonTransforms.get('body').offset,[0,1,0]);
  assert.deepEqual(input.dragonTransforms.get('left_wing').offset,[12,2,-6]);
  const legacy = { time: 2, minecraftVersion: '1.20.4' };
  prepareDragon(track,legacy,sampleAt(2),()=>0,sampleAt);
  assert.equal(legacy.dragonTransforms.get('dragon_body').offset,null);
});

test('native actors, item frames and spawner previews retain subblocks before Float32 at extreme signed Y', () => {
  for (const name of ['player','camel','ender_dragon','item_frame']) {
    const render = shift => {
      const f = fixture(name); f.entity.y = shift;
      if (name === 'item_frame') {
        f.entity.metadata = meta(name,{item:{present:true,itemId:registry.items.find(item=>item.name==='filled_map').id,itemCount:1}});
        f.scene.setMaps({ tileForItem:()=>({tile:1}) });
      }
      f.scene.consume({ type: 'update', entity: f.entity }); f.scene.update(.1,[0,shift+2,8]);
      return f.uploads.at(-1);
    };
    const normal = render(0);
    for (const shift of [2_000_000_000,-2_000_000_000]) {
      const high = render(shift);
      assert.deepEqual(high.opaque,normal.opaque, `${name} native relative vertices at Y${shift}`);
      assert.equal(high.format.origin[1],shift);
      assert.ok(Math.abs(high.bounds.max[1]-high.bounds.min[1]-(normal.bounds.max[1]-normal.bounds.min[1])) < 1e-6);
    }
  }
  const preview = shift => buildEntityPreview({ name:'zombie',position:[0,shift,0],origin:[0,shift,0],scale:.7 },{registry});
  const normal = preview(0);
  for (const shift of [2_000_000_000,-2_000_000_000]) {
    const high = preview(shift);
    assert.deepEqual(high.vertices,normal.vertices);
    assert.deepEqual(high.bounds,normal.bounds);
    assert.ok(high.bounds.max[1]-high.bounds.min[1] > .5,'native spawner keeps its fractional limb and head height');
  }
});
