// Mechanical shaped/shapeless fixtures verified against the matching native recipe JSON.
export function nativeFixtures(registry) {
  const id = name => registry.items.find(item => item.name === name).id;
  const result = (name, itemCount) => ({ present: true, itemId: id(name), itemCount });
  return { version: registry.version.minecraftVersion, remainders: new Map([[id('milk_bucket'), id('bucket')], [id('honey_bottle'), id('glass_bottle')]]), recipes: [
    { id: 'minecraft:oak_planks', type: 'crafting_shapeless', width: 1, height: 1, ingredients: [[id('oak_log'), id('oak_wood')]], result: result('oak_planks', 4) },
    { id: 'minecraft:stick', type: 'crafting_shaped', width: 1, height: 2, ingredients: [[id('oak_planks')], [id('oak_planks')]], result: result('stick', 4) },
    { id: 'minecraft:crafting_table', type: 'crafting_shaped', width: 2, height: 2, ingredients: Array.from({ length: 4 }, () => [id('oak_planks')]), result: result('crafting_table', 1) },
  ] };
}
