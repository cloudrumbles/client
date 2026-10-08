import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { EntityScene, MeshWriter } from '../src/entities.js';
import { bakedEntityModel, drawEntityModel } from '../src/entity-models.js';
import { MODERN_ENTITY_MODELS } from '../src/entity-modern-model-data.js';
import { MODERN_ENTITY_KEYFRAMES } from '../src/entity-modern-keyframe-data.js';
import { prepareModernEntity, resolveModernEntity } from '../src/entity-modern-models.js';

const registry = JSON.parse(await readFile(new URL('../data/1.21.11-registry.json', import.meta.url)));
const definition = name => registry.entities.find(entity => entity.name === name);
const metadata = (name, values) => Object.entries(values).map(([key, value]) => ({ key: definition(name).metadataKeys.indexOf(key), value }));
const paths = ['ghast/happy_ghast', 'ghast/happy_ghast_baby', 'ghast/happy_ghast_ropes', 'equipment/happy_ghast_body/red_harness',
  'nautilus/nautilus', 'nautilus/nautilus_baby', 'nautilus/zombie_nautilus', 'nautilus/zombie_nautilus_coral',
  'equipment/nautilus_body/copper', 'equipment/nautilus_saddle/saddle', 'camel/camel_husk', 'equipment/camel_husk_saddle/saddle',
  'cow/temperate_cow', 'cow/warm_cow', 'cow/cold_cow', 'pig/temperate_pig', 'pig/warm_pig', 'pig/cold_pig',
  'chicken/temperate_chicken', 'chicken/warm_chicken', 'chicken/cold_chicken',
  'enderman/enderman', 'enderman/enderman_eyes', 'spider/spider', 'spider_eyes', 'breeze/breeze', 'breeze/breeze_eyes', 'breeze/breeze_wind',
  'enderdragon/dragon', 'enderdragon/dragon_eyes', 'zombie/zombie', 'armor/iron_layer_1'];
const tiles = new Map(paths.map((path, index) => [`minecraft:entity/${path}`, index]));
const atlas = { entityTiles: tiles, tiles: paths.map(path => ({ width: path.includes('camel') ? 128 : 64, height: path.includes('camel') ? 128 : 64 })) };
function fixture(name, values = {}, equipment = [], registries = new Map()) {
  const uploads = [], scene = new EntityScene({ registry, registries, atlas, renderer: {
    uploadDynamicMesh(key, opaque, liquid, bounds, format) { uploads.push({ mesh: opaque.slice(), bounds, format }); }, removeMesh() {},
  } });
  const entity = { id: 1, entityType: definition(name).id, x: 0, y: 0, z: 0, yaw: 0, pitch: 0, metadata: metadata(name, values), equipment };
  scene.consume({ type: 'spawn', entity });
  const update = time => { scene.update(time, [0, 2, 8]); return uploads.at(-1)?.mesh ?? new Float32Array(); };
  return { scene, entity, uploads, update };
}
const item = name => ({ present: true, itemId: registry.items.find(entry => entry.name === name).id, itemCount: 1 });
const equipment = (slot, name) => ({ slot, item: item(name) });
function vertices(mesh, tile) { return Array.from({ length: mesh.length / 14 }, (_, index) => mesh.subarray(index * 14, index * 14 + 14)).filter(vertex => tile === undefined || vertex[12] === tile); }
const dimensions = mesh => [0, 1, 2].map(axis => { const values = vertices(mesh).map(vertex => vertex[axis]); return Math.max(...values) - Math.min(...values); });
const layer = (mesh, path) => vertices(mesh, tiles.get(`minecraft:entity/${path}`));

test('modern native body and inherited equipment facts retain complete hierarchies, normalized UVs and unit normals', () => {
  for (const [name, data] of Object.entries(MODERN_ENTITY_MODELS)) {
    const model = bakedEntityModel(name); assert.ok(model, name);
    for (let index = 0; index < data.parts.length; index++) {
      const part = data.parts[index]; assert.ok(part.parent === null || part.parent < index, `${name}/${part.name}`);
      for (const cube of model.parts[index].geometry) for (let at = 0; at < cube.length; at += 8) {
        assert.ok([...cube.subarray(at, at + 8)].every(Number.isFinite), name);
        assert.ok(Math.abs(Math.hypot(...cube.subarray(at + 3, at + 6)) - 1) < 1e-6, name);
        assert.ok(cube[at + 6] >= 0 && cube[at + 6] <= 1 && cube[at + 7] >= 0 && cube[at + 7] <= 1, name);
      }
    }
  }
  assert.equal(MODERN_ENTITY_MODELS.zombie_nautilus_coral.parts.length, 18);
  assert.deepEqual(MODERN_ENTITY_MODELS.nautilus.sheet, [128, 128]);
  assert.deepEqual(MODERN_ENTITY_MODELS.nautilus_baby.sheet, [64, 64]);
  assert.notDeepEqual(MODERN_ENTITY_MODELS.nautilus.parts[1].cubes[0].size, MODERN_ENTITY_MODELS.nautilus_baby.parts[1].cubes[0].size);
});

test('happy ghast uses native fourfold scale, separate baby shell and equipment squeeze without a second baby shrink', () => {
  const adult = fixture('happy_ghast'), grown = adult.update(.1);
  assert.equal(adult.scene.stats.nativeModels, 1); assert.equal(adult.scene.stats.fallbackModels, 0);
  assert.equal(dimensions(grown)[0], 4);
  const baby = fixture('happy_ghast', { baby: true }), small = baby.update(.1);
  assert.ok(Math.abs(dimensions(small)[0] - .95) < 1e-6);
  assert.ok(layer(small, 'ghast/happy_ghast_baby').length > layer(grown, 'ghast/happy_ghast').length);
  const equipped = fixture('happy_ghast', {}, [equipment(6, 'red_harness')]), mesh = equipped.update(.1);
  const body = layer(mesh, 'ghast/happy_ghast');
  assert.equal(Math.max(...body.map(v => v[0])) - Math.min(...body.map(v => v[0])), 3.75);
  assert.ok(layer(mesh, 'equipment/happy_ghast_body/red_harness').length > 0);
});

test('happy ghast goggles use native parent-scaled ridden poses, leash ropes obey the synchronized flag and harness tag', () => {
  const f = fixture('happy_ghast', { is_leash_holder: true }, [equipment(6, 'red_harness')]);
  const harnessId = item('red_harness').itemId;
  f.scene.consume({ type: 'tags', tags: [{ tagType: 'minecraft:item', tags: [{ tagName: 'minecraft:harnesses', entries: [harnessId] }] }] });
  const ropes = f.update(.1); assert.equal(layer(ropes, 'ghast/happy_ghast_ropes').length, 360);
  f.scene.consume({ type: 'tags', tags: [{ tagType: 'minecraft:item', tags: [{ tagName: 'minecraft:harnesses', entries: [] }] }] });
  assert.equal(layer(f.update(.2), 'ghast/happy_ghast_ropes').length, 0);
  const track = { definition: definition('happy_ghast'), createdAt: 5 };
  const input = { family: 'happy_ghast', time: 5, young: false };
  assert.equal(prepareModernEntity(track, { ...input }, { ridden: false }).keyframes.get('goggles').translation[1], -20);
  assert.equal(prepareModernEntity(track, { ...input }, { ridden: true }).keyframes.get('goggles').rotation[0], 0);
  const young = prepareModernEntity(track, { ...input, young: true }, {}).keyframes.get('goggles');
  assert.ok(Math.abs(young.translation[1] - (-5 * 4 * .2375 ** 2)) < 1e-12);
  assert.equal(prepareModernEntity(track, { ...input }).keyframes.get('tentacle0').rotation[0], .4);
});

test('nautilus native swim channels preserve idle motion, clamp body gaze and run independently of render frequency', () => {
  assert.equal(MODERN_ENTITY_KEYFRAMES.nautilus.SWIMMING.channels.length, 6);
  const run = frequency => {
    const track = { definition: definition('nautilus'), createdAt: 0 }; let result;
    for (let frame = 0; frame <= frequency; frame++) result = prepareModernEntity(track,
      { family: 'nautilus', time: frame / frequency, worldSpeed: 1.25, pitch: 1, headYaw: -1 });
    return { keyframes: result.keyframes, walk: track.specialWalk };
  };
  const slow = run(30), fast = run(120); assert.deepEqual(slow, fast);
  assert.equal(slow.keyframes.get('body').rotation[0], Math.PI / 18);
  assert.equal(slow.keyframes.get('body').rotation[1], -Math.PI / 18);
  const f = fixture('nautilus'); const start = f.update(.1), next = f.update(.4);
  assert.notDeepEqual(start, next); assert.equal(f.scene.stats.texturedModels, 1);
});

test('nautilus saddle/body slots are distinct and baby source model omits equipment rather than shrinking the adult sheet', () => {
  const gear = [equipment(6, 'copper_nautilus_armor'), equipment(7, 'saddle')];
  const adult = fixture('nautilus', {}, gear), grown = adult.update(.1);
  assert.equal(layer(grown, 'equipment/nautilus_body/copper').length, 240);
  assert.equal(layer(grown, 'equipment/nautilus_saddle/saddle').length, 192);
  const baby = fixture('nautilus', { baby: true }, gear), small = baby.update(.1);
  assert.equal(layer(small, 'equipment/nautilus_body/copper').length, 0);
  assert.equal(layer(small, 'equipment/nautilus_saddle/saddle').length, 0);
  assert.equal(layer(small, 'nautilus/nautilus_baby').length, 240);
});

test('server variant IDs select full namespace assets and warm coral hierarchy, even when IDs differ from bootstrap order', () => {
  const registries = new Map([['minecraft:zombie_nautilus_variant', [
    { id: 17, key: 'example:ocean', value: { model: 'warm', asset_id: 'example:entity/ocean_nautilus' } },
  ]]]);
  const f = fixture('zombie_nautilus', { variant: 17 }, [], registries);
  const customAtlas = { ...atlas, entityTiles: new Map([...tiles, ['example:entity/ocean_nautilus', 99]]), tiles: [...atlas.tiles] };
  customAtlas.tiles[99] = { width: 128, height: 128 }; f.scene.setAtlas(customAtlas);
  const coral = f.update(.1); assert.equal(vertices(coral, 99).length, 336); assert.equal(f.scene.stats.fallbackModels, 0);
  f.scene.consume({ type: 'update', entity: { ...f.entity, equipment: [equipment(6, 'stone')] } });
  assert.equal(vertices(f.update(.2), 99).length, 240, 'any native body item hides corals');
  f.scene.consume({ type: 'registry', codec: { 'minecraft:zombie_nautilus_variant': { value: [{ id: 17, name: 'example:ocean', element: { asset_id: 'minecraft:entity/nautilus/zombie_nautilus' } }] } } });
  assert.equal(layer(f.update(.3), 'nautilus/zombie_nautilus').length, 240);
  f.scene.clear(); assert.equal(registries.size, 1, 'shared session registries survive scene cleanup');
});

test('camel husk reuses native camel articulated poses and its own modern saddle sheet', () => {
  const f = fixture('camel_husk', {}, [equipment(7, 'saddle')]);
  const standing = f.update(.1); assert.ok(layer(standing, 'camel/camel_husk').length > 100);
  assert.ok(layer(standing, 'equipment/camel_husk_saddle/saddle').length > 0);
  f.scene.consume({ type: 'update', entity: { ...f.entity, metadata: metadata('camel_husk', { last_pose_change_tick: -1000n }) } });
  f.scene.update(.2, [0, 2, 8], { gameTime: 1045n }); assert.notDeepEqual(f.uploads.at(-1).mesh, standing);
  assert.equal(f.scene.stats.nativeModels, 1); assert.equal(f.scene.stats.approximateModels, 0);
});

test('invisible original actors retain only native eye/wind or equipment layers and NO_OVERLAY damage colors', () => {
  for (const [family, expected] of [['enderman', ['enderman/enderman_eyes']], ['spider', ['spider_eyes']],
    ['breeze', ['breeze/breeze_eyes', 'breeze/breeze_wind']], ['ender_dragon', ['enderdragon/dragon_eyes']],
    ['happy_ghast', ['equipment/happy_ghast_body/red_harness']], ['nautilus', ['equipment/nautilus_body/copper']],
    ['camel_husk', ['equipment/camel_husk_saddle/saddle']]]) {
    const gear = family === 'happy_ghast' ? [equipment(6, 'red_harness')] : family === 'nautilus' ? [equipment(6, 'copper_nautilus_armor')] : family === 'camel_husk' ? [equipment(7, 'saddle')] : [];
    const f = fixture(family, { shared_flags: 32 }, gear); const mesh = f.update(.1);
    assert.ok(mesh.length > 0, family);
    assert.deepEqual(new Set(vertices(mesh).map(vertex => vertex[12])), new Set(expected.map(path => tiles.get(`minecraft:entity/${path}`))), family);
    f.scene.consume({ type: 'status', id: 1, status: 2 }); const damaged = f.update(.2);
    assert.ok(vertices(damaged).every(vertex => vertex[6] === 1 && vertex[7] === 1 && vertex[8] === 1), family);
  }
  const zombie = fixture('zombie', {}, [equipment(4, 'iron_chestplate')]); zombie.update(.1);
  zombie.scene.consume({ type: 'status', id: 1, status: 2 });
  const armor = layer(zombie.update(.2), 'armor/iron_layer_1'); assert.ok(armor.length > 0);
  assert.ok(armor.every(vertex => vertex[7] === 1 && vertex[8] === 1));
});

test('modern farm variants use matching native models and sheets while legacy versions retain original paths', () => {
  for (const family of ['cow', 'pig', 'chicken']) for (const [variant, temperature] of [[0, 'temperate'], [1, 'warm'], [2, 'cold']]) {
    const f = fixture(family, { variant }); const mesh = f.update(.1);
    assert.equal(f.scene.stats.fallbackModels, 0, `${family}/${temperature}`);
    assert.ok(layer(mesh, `${family}/${temperature}_${family}`).length > 0);
    const resolved = f.scene.skinFor(family, f.entity, definition(family));
    assert.equal(resolved.model, `${family}_${temperature === 'cold' ? 'cold' : family === 'cow' && temperature === 'warm' ? 'warm' : 'modern'}`);
  }
  assert.equal(resolveModernEntity('cow', () => 0, new Map(), '1.20.4'), null);
  assert.equal(resolveModernEntity('cow', () => 0, new Map(), '1.21'), null);
  assert.equal(resolveModernEntity('pig', () => 0, new Map(), '1.21.4'), null);
  assert.equal(MODERN_ENTITY_MODELS.cow_modern.parts[0].cubes.length, 4);
  assert.equal(MODERN_ENTITY_MODELS.cow_cold.parts.length, 8);
  assert.equal(MODERN_ENTITY_MODELS.chicken_cold.parts.find(part => part.name === 'body').cubes[1].size[0], 0);
});

test('modern cow and chicken babies use current native head offsets and body scale', () => {
  const writer = new MeshWriter(), context = { position: [0, 0, 0], rotation: [0, 0, 0], scale: 1 };
  drawEntityModel(writer, 'cow_modern', context, { family: 'cow', swing: 0, young: true }, { parts: new Set(['head']) });
  const mesh = writer.vertices.slice(0, writer.length), minZ = Math.min(...vertices(mesh).map(vertex => vertex[2]));
  assert.ok(Math.abs(minZ - (-7 - 8 + 6) / 16) < 1e-7);
  assert.deepEqual(MODERN_ENTITY_MODELS.chicken_modern.nativeBabyTransform, [1, 5, 2, 1 / 1.99, 24]);
});

test('26.1 farms select distinct native baby bodies, baby_asset_id and changed adult texture paths', () => {
  for (const [family, sheet] of [['cow',[64,64]], ['pig',[32,32]], ['chicken',[16,16]]]) {
    const resolved = resolveModernEntity(family, key => key === 'baby' ? true : 2, new Map(), '26.1');
    assert.equal(resolved.model, `${family}_baby_modern`);
    assert.equal(resolved.assetId, `minecraft:entity/${family}/${family}_cold_baby`);
    assert.deepEqual(bakedEntityModel(resolved.model).sheet, sheet);
    assert.deepEqual(MODERN_ENTITY_MODELS[resolved.model].nativeBabyTransform, [1,0,0,1,0]);
    const adult = resolveModernEntity(family, () => 0, new Map(), '26.1');
    assert.equal(adult.assetId, `minecraft:entity/${family}/${family}_temperate`);
  }
  const variants = new Map([['minecraft:pig_variant', [{ id: 19, key: 'example:pig', value: {
    asset_id: 'example:entity/pig', baby_asset_id: 'example:entity/piglet', model: 'cold',
  } }]]]);
  assert.equal(resolveModernEntity('pig', key => key === 'baby' ? true : 19, variants, '26.1').assetId, 'example:entity/piglet');
});

test('26.1 baby camel selects its distinct sheet and six native animations without an adult body transform', async () => {
  const { prepareSpecialEntity } = await import('../src/entity-keyframes.js');
  const resolved = resolveModernEntity('camel', key => key === 'baby', new Map(), '26.1');
  assert.equal(resolved.model, 'camel_baby_modern'); assert.equal(resolved.assetId, 'minecraft:entity/camel/camel_baby');
  assert.equal(MODERN_ENTITY_MODELS.camel_baby_modern.parts[0].name, 'root');
  assert.equal(Object.keys(MODERN_ENTITY_KEYFRAMES.camel_baby).length, 6);
  const track = { definition: definition('camel'), entity: { id: 1 }, createdAt: 0 };
  const input = { nativeCamelBaby: true, family: 'camel', time: 1, young: true, pitch: 0, headYaw: 0, worldSpeed: 0 };
  const pose = prepareSpecialEntity(track, input, key => key === 'last_pose_change_tick' ? -1000n : false, 1045n);
  assert.equal(pose.keyframes.get('body').translation[1], 13.35, 'native baby sit13.25 plus idle .1');
});

test('modern saved SpawnData retains registry variant names, pose long and named equipment slots', async () => {
  const { previewEntityData } = await import('../src/entity-preview.js');
  const saved = previewEntityData({ variant: 'minecraft:warm', equipment: { body: { id: 'minecraft:copper_nautilus_armor', count: 1 }, saddle: { id: 'minecraft:saddle', count: 1 } } }, definition('zombie_nautilus'), registry);
  assert.equal(saved.metadata.find(entry => entry.key === definition('zombie_nautilus').metadataKeys.indexOf('variant')).value, 'minecraft:warm');
  assert.deepEqual(saved.equipment.map(entry => entry.slot), [6,7]);
  const camel = previewEntityData({ Age: -1, LastPoseTick: -1000n, equipment: { saddle: { id: 'minecraft:saddle', count: 1 } } }, definition('camel'), registry);
  assert.equal(camel.metadata.find(entry => entry.key === definition('camel').metadataKeys.indexOf('last_pose_change_tick')).value, -1000n);
  const zombie = previewEntityData({ ArmorItems: [{ id: 'minecraft:iron_boots', Count: 1 }], equipment: { feet: { id: 'minecraft:diamond_boots', count: 1 }, mainhand: { id: 'minecraft:bow', count: 1, components: { 'minecraft:custom_name': 'Source' } } } }, definition('zombie'), registry);
  assert.equal(zombie.equipment.filter(entry => entry.slot === 2).length, 1);
  assert.equal(zombie.equipment.find(entry => entry.slot === 2).item.itemId, item('diamond_boots').itemId);
  assert.deepEqual(zombie.equipment.find(entry => entry.slot === 0).item.components, [{ type: 'custom_name', data: 'Source' }]);
});

test('modern humanoid equipment reads moved original sheets, copper material and component leather dye without damage overlay', () => {
  const gearAtlas = { ...atlas, entityTiles: new Map(tiles), tiles: [...atlas.tiles] };
  for (const [tile, path] of [[70,'equipment/humanoid/copper'],[71,'equipment/humanoid/leather'],[72,'equipment/humanoid/leather_overlay']]) {
    gearAtlas.entityTiles.set(`minecraft:entity/${path}`,tile); gearAtlas.tiles[tile] = { width:64,height:32 };
  }
  const copper = fixture('zombie', { shared_flags:32 }, [equipment(4,'copper_chestplate')]); copper.scene.setAtlas(gearAtlas);
  assert.ok(vertices(copper.update(.1),70).length > 0);
  const leatherItem = { ...item('leather_chestplate'), components: [{ type:'dyed_color', data: 0x336699 }] };
  const leather = fixture('zombie', { shared_flags:32 }, [{ slot:4,item:leatherItem }]); leather.scene.setAtlas(gearAtlas); leather.update(.1);
  leather.scene.consume({type:'status',id:1,status:2}); const mesh = leather.update(.2);
  const dyed = vertices(mesh,71); assert.ok(dyed.length > 0);
  assert.deepEqual([...dyed[0].subarray(6,9)], [.2,.4,.6].map(Math.fround));
  assert.ok(vertices(mesh,72).every(vertex => vertex[6] === 1 && vertex[7] === 1 && vertex[8] === 1));
});

test('zombie nautilus cannot render a baby and 26.1 camel husk keeps its native adult-only renderer', () => {
  const adult = fixture('zombie_nautilus'), baby = fixture('zombie_nautilus', { baby:true });
  assert.deepEqual(baby.update(.1), adult.update(.1), 'ZombieNautilus.isBaby always returns false');
  const oldBaby = fixture('camel_husk', { baby:true }), modernBaby = fixture('camel_husk', { baby:true }, [equipment(7,'saddle')]);
  modernBaby.scene.minecraftVersion = '26.1';
  const grown = fixture('camel_husk'); grown.scene.minecraftVersion = '26.1';
  const originalHeight = dimensions(oldBaby.update(.1))[1], modern = modernBaby.update(.1);
  assert.ok(dimensions(modern)[1] > originalHeight * 2);
  assert.equal(layer(modern, 'equipment/camel_husk_saddle/saddle').length, 0);
  assert.deepEqual(modern, grown.update(.1));
});

test('farm walk smoothing settles after movement and resumes the static batch cache', () => {
  const f = fixture('cow'); f.update(.1);
  f.scene.consume({type:'update',entity:{...f.entity,x:.2}}); f.update(.2);
  f.scene.consume({type:'update',entity:{...f.entity,x:.4}}); f.update(.3);
  assert.ok(f.scene.entities.get(1).specialWalk.speed > 0);
  const movingUploads = f.scene.stats.uploads;
  for(let tick=8;tick<=40;tick++) f.update(tick/20);
  assert.ok(f.scene.stats.uploads > movingUploads, 'native gait is allowed to settle after packets stop');
  const settled = f.scene.stats.uploads; f.update(2.1); f.update(2.2);
  assert.equal(f.scene.stats.uploads,settled,'idle farm actors retain the cached dynamic batch');
});

test('native chicken flight flaps at20Hz, settles on ground, and skips long idle gaps in constant space', () => {
  const run = frequency => {
    const track = { definition:definition('chicken'),entity:{grounded:false},createdAt:0 }; let pose;
    for(let frame=0;frame<=frequency;frame++) pose=prepareModernEntity(track,{family:'chicken',modernFarm:true,time:frame/frequency,worldSpeed:0});
    return {track,pose};
  };
  const slow=run(30),fast=run(120);
  assert.ok(Math.abs(slow.pose.chickenFlapAngle-fast.pose.chickenFlapAngle)<1e-12);
  assert.ok(Math.abs(slow.track.chickenFlap.flap-36)<1e-12);
  slow.track.entity.grounded=true;
  const settled=prepareModernEntity(slow.track,{family:'chicken',modernFarm:true,time:10000,worldSpeed:0});
  assert.equal(settled.chickenFlapAngle,0); assert.equal(slow.track.chickenFlap.tick,200000);
  const f=fixture('chicken'); f.scene.consume({type:'update',entity:{...f.entity,grounded:false}});
  const wings=f.update(.1); assert.notDeepEqual(f.update(.25),wings);
});
