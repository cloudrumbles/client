// Acceptance vectors derived from original 1.20.4/1.21.11 AbstractContainerMenu,
// InventoryMenu, CraftingMenu and Slot call chains. These are mechanical fixtures,
// not extracted original assets and not a claim that the current local adapter
// implements every action. Indices are native menu indices, not storage indices.
const stack = (name, count, fields = {}) => ({ name, count, ...fields });
const click = (slot, mode, button = 0) => ({ slot, mode, button });
const drag = (kind, slots) => [click(-999, 5, kind << 2), ...slots.map(slot => click(slot, 5, kind << 2 | 1)), click(-999, 5, kind << 2 | 2)];
export const nativeMenuActionFixtures = [
  { name: 'player main quick move prefers hotbar forward', width: 2, slots: { 9: stack('oak_planks', 10) }, clicks: [click(9, 1)], expected: { slots: { 9: null, 36: stack('oak_planks', 10) } } },
  { name: 'player hotbar quick move prefers main forward', width: 2, slots: { 36: stack('oak_planks', 10) }, clicks: [click(36, 1)], expected: { slots: { 9: stack('oak_planks', 10), 36: null } } },
  { name: 'player grid quick move merges before empty slot', width: 2, slots: { 1: stack('oak_planks', 10), 12: stack('oak_planks', 60) }, clicks: [click(1, 1)], expected: { slots: { 1: null, 9: stack('oak_planks', 6), 12: stack('oak_planks', 64) } } },
  { name: 'table main quick move fills grid before hotbar', width: 3, slots: { 10: stack('oak_planks', 10) }, clicks: [click(10, 1)], expected: { slots: { 1: stack('oak_planks', 10), 10: null } } },
  { name: 'table hotbar quick move fills grid before main', width: 3, slots: { 37: stack('oak_planks', 10) }, clicks: [click(37, 1)], expected: { slots: { 1: stack('oak_planks', 10), 37: null } } },
  { name: 'table full grid main quick move falls back to hotbar', width: 3, slots: { ...Object.fromEntries(Array.from({ length: 9 }, (_, i) => [i + 1, stack('stone', 64)])), 10: stack('oak_planks', 10) }, clicks: [click(10, 1)], expected: { slots: { 10: null, 37: stack('oak_planks', 10) } } },
  { name: 'table grid quick move goes to main forward', width: 3, slots: { 1: stack('oak_planks', 10) }, clicks: [click(1, 1)], expected: { slots: { 1: null, 10: stack('oak_planks', 10) } } },
  { name: 'number swap exchanges grid with native hotbar', width: 2, slots: { 1: stack('oak_planks', 3), 36: stack('stone', 8) }, clicks: [click(1, 2)], expected: { slots: { 1: stack('stone', 8), 36: stack('oak_planks', 3) } } },
  { name: 'same physical hotbar swap preserves stack', width: 2, slots: { 36: stack('oak_planks', 3) }, clicks: [click(36, 2)], expected: { slots: { 36: stack('oak_planks', 3) } } },
  { name: 'player offhand swap maps button40 to player40', width: 2, slots: { 9: stack('oak_planks', 3), 45: stack('stone', 8) }, clicks: [click(9, 2, 40)], expected: { slots: { 9: stack('stone', 8), 45: stack('oak_planks', 3) } } },
  { name: 'table offhand swap accesses retained player40', width: 3, slots: { 10: stack('oak_planks', 3) }, offhand: stack('stone', 8), clicks: [click(10, 2, 40)], expected: { slots: { 10: stack('stone', 8) }, offhand: stack('oak_planks', 3) } },
  { name: 'left drag divides evenly and preserves remainder', width: 2, cursor: stack('oak_planks', 10), clicks: drag(0, [9, 10, 11]), expected: { slots: { 9: stack('oak_planks', 3), 10: stack('oak_planks', 3), 11: stack('oak_planks', 3) }, cursor: stack('oak_planks', 1) } },
  { name: 'right drag places one per distinct slot', width: 2, cursor: stack('oak_planks', 10), clicks: drag(1, [9, 10, 9, 11]), expected: { slots: { 9: stack('oak_planks', 1), 10: stack('oak_planks', 1), 11: stack('oak_planks', 1) }, cursor: stack('oak_planks', 7) } },
  { name: 'left drag caps a slot without redistributing its share', width: 2, slots: { 9: stack('oak_planks', 63) }, cursor: stack('oak_planks', 10), clicks: drag(0, [9, 10, 11]), expected: { slots: { 9: stack('oak_planks', 64), 10: stack('oak_planks', 3), 11: stack('oak_planks', 3) }, cursor: stack('oak_planks', 3) } },
  { name: 'single left drag delegates to ordinary pickup', width: 2, cursor: stack('oak_planks', 10), clicks: drag(0, [9]), expected: { slots: { 9: stack('oak_planks', 10) }, cursor: null } },
  { name: 'single right drag delegates to one-item pickup', width: 2, cursor: stack('oak_planks', 10), clicks: drag(1, [9]), expected: { slots: { 9: stack('oak_planks', 1) }, cursor: stack('oak_planks', 9) } },
  { name: 'single creative middle drag delegates invalid pickup button2', width: 2, cursor: stack('oak_planks', 10), clicks: drag(2, [9]), expected: { slots: { 9: null }, cursor: stack('oak_planks', 10) } },
  { name: 'multiple creative middle drag fills native limits', width: 2, cursor: stack('oak_planks', 10), clicks: drag(2, [9, 10]), expected: { slots: { 9: stack('oak_planks', 64), 10: stack('oak_planks', 64) }, cursor: null }, createsCreativeItems: true },
  { name: 'interrupted drag consumes the interrupting click', width: 2, cursor: stack('oak_planks', 10), clicks: [click(-999, 5), click(9, 5, 1), click(10, 0)], expected: { slots: { 9: null, 10: null }, cursor: stack('oak_planks', 10) } },
  { name: 'double collect takes partial stacks before full stacks', width: 2, slots: { 9: stack('oak_planks', 64), 10: stack('oak_planks', 20), 11: stack('oak_planks', 40) }, cursor: stack('oak_planks', 10), clicks: [click(12, 6)], expected: { slots: { 9: stack('oak_planks', 64), 10: null, 11: stack('oak_planks', 6) }, cursor: stack('oak_planks', 64) } },
  { name: 'reverse double collect reverses native menu order', width: 2, slots: { 9: stack('oak_planks', 20), 10: stack('oak_planks', 40) }, cursor: stack('oak_planks', 10), clicks: [click(12, 6, 1)], expected: { slots: { 9: stack('oak_planks', 6), 10: null }, cursor: stack('oak_planks', 64) } },
  { name: 'double collect on occupied pickup slot does nothing', width: 2, slots: { 9: stack('oak_planks', 20), 10: stack('oak_planks', 40) }, cursor: stack('oak_planks', 10), clicks: [click(9, 6)], expected: { slots: { 9: stack('oak_planks', 20), 10: stack('oak_planks', 40) }, cursor: stack('oak_planks', 10) } },
  { name: 'double collect excludes generated crafting result', width: 2, slots: { 1: stack('oak_log', 1) }, cursor: stack('oak_planks', 10), clicks: [click(9, 6)], expected: { slots: { 0: stack('oak_planks', 4), 1: stack('oak_log', 1) }, cursor: stack('oak_planks', 10) } },
  { name: 'Q drops one native input without cursor mutation', width: 2, slots: { 9: stack('oak_planks', 10) }, clicks: [click(9, 4)], expected: { slots: { 9: stack('oak_planks', 9) }, cursor: null, drops: [stack('oak_planks', 1)] } },
  { name: 'control Q drops a complete ordinary stack', width: 2, slots: { 9: stack('oak_planks', 10) }, clicks: [click(9, 4, 1)], expected: { slots: { 9: null }, cursor: null, drops: [stack('oak_planks', 10)] } },
  { name: 'Q with occupied cursor does nothing', width: 2, slots: { 9: stack('oak_planks', 10) }, cursor: stack('stone', 1), clicks: [click(9, 4)], expected: { slots: { 9: stack('oak_planks', 10) }, cursor: stack('stone', 1), drops: [] } },
  { name: 'left outside drops the complete cursor', width: 2, cursor: stack('oak_planks', 10), clicks: [click(-999, 0)], expected: { cursor: null, drops: [stack('oak_planks', 10)] } },
  { name: 'right outside drops one from cursor', width: 2, cursor: stack('oak_planks', 10), clicks: [click(-999, 0, 1)], expected: { cursor: stack('oak_planks', 9), drops: [stack('oak_planks', 1)] } },
  { name: 'result number swap to empty hotbar consumes one recipe', width: 2, slots: { 1: stack('oak_log', 2) }, clicks: [click(0, 2)], expected: { slots: { 0: stack('oak_planks', 4), 1: stack('oak_log', 1), 36: stack('oak_planks', 4) } } },
  { name: 'result number swap refuses occupied hotbar', width: 2, slots: { 1: stack('oak_log', 2), 36: stack('stone', 8) }, clicks: [click(0, 2)], expected: { slots: { 0: stack('oak_planks', 4), 1: stack('oak_log', 2), 36: stack('stone', 8) } } },
  { name: 'right result container takes full output and consumes one recipe', width: 2, slots: { 1: stack('oak_log', 1) }, clicks: [click(0, 0, 1)], expected: { slots: { 0: null, 1: null }, cursor: stack('oak_planks', 4) } },
  { name: 'result cannot partially merge into almost-full cursor', width: 2, slots: { 1: stack('oak_log', 1) }, cursor: stack('oak_planks', 62), clicks: [click(0, 0)], expected: { slots: { 0: stack('oak_planks', 4), 1: stack('oak_log', 1) }, cursor: stack('oak_planks', 62) } },
  { name: 'result Q container takes full output and consumes one recipe', width: 2, slots: { 1: stack('oak_log', 1) }, clicks: [click(0, 4)], expected: { slots: { 0: null, 1: null }, drops: [stack('oak_planks', 4)] } },
  { name: 'modern result control Q repeats same-item result until input exhausted', width: 2, versions: ['1.21.11'], slots: { 1: stack('oak_log', 3) }, clicks: [click(0, 4, 1)], expected: { slots: { 0: null, 1: null }, drops: [stack('oak_planks', 4), stack('oak_planks', 4), stack('oak_planks', 4)] } },
  { name: 'legacy result control Q takes exactly one complete output', width: 2, versions: ['1.20.4'], slots: { 1: stack('oak_log', 3) }, clicks: [click(0, 4, 1)], expected: { slots: { 0: stack('oak_planks', 4), 1: stack('oak_log', 2) }, drops: [stack('oak_planks', 4)] } },
  { name: 'component limit clone retains effective max16', width: 2, versions: ['1.21.11'], slots: { 9: stack('oak_planks', 1, { components: [{ type: 'max_stack_size', data: 16 }] }) }, clicks: [click(9, 3)], expected: { cursor: stack('oak_planks', 16, { components: [{ type: 'minecraft:max_stack_size', data: 16 }] }) }, createsCreativeItems: true },
  { name: 'removed component clone retains native fallback one', width: 2, versions: ['1.21.11'], slots: { 9: stack('oak_planks', 1, { removeComponents: ['max_stack_size'] }) }, clicks: [click(9, 3)], expected: { cursor: stack('oak_planks', 1, { removeComponents: ['minecraft:max_stack_size'] }) }, createsCreativeItems: true },
];

export function resolveNativeMenuFixture(fixture, registry) {
  const items = new Map(registry.items.map(item => [item.name, item]));
  const resolve = value => {
    if (!value) return { present: false };
    const { name, count, ...fields } = value, item = items.get(name);
    if (!item) throw new Error(`Native menu fixture references missing ${name}.`);
    return { present: true, itemId: item.id, itemCount: count, ...structuredClone(fields) };
  };
  const slots = values => Object.fromEntries(Object.entries(values ?? {}).map(([index, value]) => [index, resolve(value)]));
  return { ...fixture, slots: slots(fixture.slots), cursor: resolve(fixture.cursor), offhand: resolve(fixture.offhand), expected: {
    ...fixture.expected, slots: slots(fixture.expected.slots),
    ...('cursor' in fixture.expected ? { cursor: resolve(fixture.expected.cursor) } : {}),
    ...('offhand' in fixture.expected ? { offhand: resolve(fixture.expected.offhand) } : {}),
    ...('drops' in fixture.expected ? { drops: fixture.expected.drops.map(resolve) } : {}),
  } };
}
