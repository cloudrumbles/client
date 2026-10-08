// Source-backed diagnostic only: use a private WASM instance and original JAR.
// The native plant model must remain in the cutout pass while its FluidState
// participates in water surface continuity. No application code is patched.
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { loadResourcePack, MATERIAL_FLAGS as F } from '../src/assets.js';
import { applyMaterials, activateMaterials } from '../src/registry.js';
import { copyMesh } from '../src/wasm.js';

const registry = JSON.parse(await readFile(new URL('../data/1.21.11-registry.json', import.meta.url)));
const jar = process.env.POMME_MINECRAFT_JAR || '/workspace/scratch/minecraft-1.21.11-client.jar';
const pack = await loadResourcePack(await readFile(jar), { registry });
const compiled = await WebAssembly.compile(await readFile(new URL('../public/core.wasm', import.meta.url)));
const plants = ['seagrass', 'tall_seagrass', 'kelp', 'kelp_plant'];
const water = [...pack.materials.values()].find(m => m.name === 'minecraft:water' && Number(m.properties.level) === 0);
assert.ok(water && water.flags & F.FLUID);
const report = { source: '1.20.4 SeagrassBlock/TallSeagrassBlock/KelpBlock/KelpPlantBlock.getFluidState return Fluids.WATER.getSource(false); LiquidBlockRenderer.shouldRenderFace rejects neighbor same FluidState type', registry: '1.21.11', originalAssets: true, cases: [] };

async function fixture(plant, { changePlantFlag = false, omitContainedFluid = false } = {}) {
  const { exports: core } = await WebAssembly.instantiate(compiled);
  assert.equal(core.world_reset(0, 16, 0, 0, 1, 1), 1);
  const materials = new Map(pack.materials);
  if (changePlantFlag) materials.set(plant.id, { ...plant, flags: plant.flags | F.FLUID });
  if (omitContainedFluid) materials.set(plant.id, { ...plant, fluid: null });
  const active = applyMaterials(core, materials); activateMaterials(core, materials, [water.id, plant.id], active);
  const blocks = new Uint16Array(4096).fill(water.id), pointer = core.world_stage_ptr();
  if (plant.id !== water.id) blocks[(8 * 16 + 8) * 16 + 8] = plant.id;
  new Uint16Array(core.memory.buffer, pointer, 4096).set(blocks);
  assert.equal(core.world_load_section(0, 0, 0, pointer, 4096), 1);
  const solid = copyMesh(core, 0, false), liquid = copyMesh(core, 0, true);
  // Entire triangle within the center plant voxel, including shared boundary.
  let cavityVertices = 0, plantInSolid = 0, plantInLiquid = 0;
  for (const [mesh, liquidPass] of [[solid, false], [liquid, true]]) for (let at = 0; at < mesh.length; at += 42) {
    const triangle = mesh.subarray(at, at + 42), boundsInside = [0, 14, 28].every(v => [0, 1, 2].every(axis => triangle[v + axis] >= 8 - .002 && triangle[v + axis] <= 9 + .002));
    if (!boundsInside) continue;
    const tile = Math.round(triangle[12]);
    if ([water.fluid.stillTile, water.fluid.flowTile].includes(tile)) cavityVertices += 3;
    else if (liquidPass) plantInLiquid += 3;
    else plantInSolid += 3;
  }
  return { solidVertices: solid.length / 14, liquidVertices: liquid.length / 14, cavityVertices, plantInSolid, plantInLiquid };
}

report.allWater = await fixture(water);
assert.equal(report.allWater.cavityVertices, 0);
for (const name of plants) {
  const material = [...pack.materials.values()].find(m => m.name === `minecraft:${name}`);
  assert.ok(material && material.flags & F.CUSTOM_MODEL && !(material.flags & F.FLUID));
  assert.deepEqual(material.fluid, { kind: 1, level: 0, stillTile: water.fluid.stillTile, flowTile: water.fluid.flowTile });
  const actual = await fixture(material), missingFluidCounterexample = await fixture(material, { omitContainedFluid: true }), flagOnlyCounterexample = await fixture(material, { changePlantFlag: true });
  assert.equal(actual.cavityVertices, 0, `${name}: native FluidState removes all six internal water faces`);
  assert.equal(actual.liquidVertices, report.allWater.liquidVertices, 'submerged plant does not fragment the merged fluid boundary');
  assert.equal(missingFluidCounterexample.cavityVertices, 36, 'missing contained-fluid metadata recreates all six incorrect internal faces');
  assert.ok(actual.plantInSolid > 0, `${name}: native imported cutout geometry exists`);
  assert.equal(flagOnlyCounterexample.cavityVertices, 0);
  assert.equal(flagOnlyCounterexample.plantInSolid, 0, 'FLUID flag alone incorrectly moves cutout plant into water shader');
  assert.ok(flagOnlyCounterexample.plantInLiquid > 0);
  report.cases.push({ name, stateId: material.id, flags: material.flags, properties: material.properties, actual, missingFluidCounterexample, flagOnlyCounterexample });
}
await mkdir('test-results', { recursive: true });
await writeFile('test-results/water-plant-diagnostic.json', JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
