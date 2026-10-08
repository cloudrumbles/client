# Native menu action acceptance vectors

`src/inventory/menu.rs` implements ordinary native menu transactions. The local
worker/session dispatches supported UI input through this ABI. Its acceptance
data set is `tests/native-menu-action-fixtures.js`; these vectors run against the
actual WASM in both supported versions. Their stacks use
native resource names; `resolveNativeMenuFixture` resolves the selected version's
actual item IDs. Indices are native player/crafting menu indices. The expected
fields are sparse assertions; omitted slots must retain their source state.

The sources are privately mapped original 1.20.4 and 1.21.11
`AbstractContainerMenu.doClick`, `InventoryMenu.quickMoveStack`,
`CraftingMenu.quickMoveStack`, `Slot.tryRemove/safeTake/safeInsert`,
`ResultSlot.remove/onTake`, `ResultContainer.removeItem`,
`TransientCraftingContainer.removeItem`, and `ContainerHelper.takeItem`.
Original source and class archives stay outside the repository.

## Movement and swapping

Native `moveItemStackTo` merges matching item/component stacks first, in the
requested direction. It then moves into the first eligible empty slot and stops
that call. `doClick(QUICK_MOVE)` repeats while the source remains the same item.

| Menu/source | Native destination indices | Direction |
|---|---|---|
| Player result 0 | 9..44 | reverse |
| Player grid 1..4 | 9..44 | forward |
| Player armor 5..8 | 9..44 | forward |
| Player main 9..35 | eligible empty equipment, then 36..44 | forward |
| Player hotbar 36..44 | eligible empty equipment, then 9..35 | forward |
| Player offhand 45 | 9..44 | forward |
| Table result 0 | 10..45 | reverse |
| Table grid 1..9 | 10..45 | forward |
| Table main 10..36 | 1..9, then 37..45 if no grid move | forward |
| Table hotbar 37..45 | 1..9, then 10..36 if no grid move | forward |

Player equipment eligibility must use original version-specific item equipment
data. Name suffixes are insufficient, especially with modern equippable component
patches. Equipment effects/binding conditions are separate from ordinary storage.

SWAP accepts native hotbar button0..8 and offhand button40. The offhand is native
player index40 even when the current table menu has no offhand slot. An empty
destination hotbar can take a result and consume one recipe. A populated hotbar
cannot place its existing stack into the non-placeable result. Ordinary swaps
honor destination limits; an oversized replacement splits, then returns the
displaced stack through `Inventory.add` and drop routing. Cursor state is retained.

## Dragging and collecting

QUICK_CRAFT has header `button & 3` and kind `(button >> 2) & 3`. Header0 starts,
header1 adds eligible slots and header2 ends. Kind0 divides the original cursor
count evenly, kind1 puts one in each slot, kind2 fills limits with creative
materials. Duplicate targets are a set. A clipped target's unused share stays on
the cursor; it is not redistributed. A single target delegates to PICKUP with
the drag kind as mouse button, including the no-op invalid button2 case. A
non-drag action during a drag resets the state and consumes that interrupting
action. Invalid state transitions reset without moving items.

PICKUP_ALL requires a nonempty cursor and an empty or non-pickable clicked slot.
It scans native menu order (reverse for button1), taking partial stacks on pass0
and full stacks on pass1 until the cursor reaches its native component limit.
Crafting result slots are excluded by each menu's `canTakeItemForPickAll`.
Native component identity remains part of every merge/collect decision. Existing
opaque component identity uses the same canonical namespace/removal boundary as
the rest of the portable inventory. Modern equippable patches and bundle click
overrides still require their own item behavior and explicitly defer relevant
menu input. Gear effects/binding mechanics are not claimed as ported survival.

## Result helper trace

Both original versions take the full result on an empty-cursor right click. The
complete helper chain matters:

1. `doClick(PICKUP, button1)` requests `ceil(resultCount/2)` with capacity
   `Integer.MAX_VALUE` through `Slot.tryRemove`.
2. `Slot.allowModification` is false for a result because `mayPlace` is false.
   `tryRemove` blocks the call only when its **capacity** is below the entire
   existing result count. It otherwise calls `ResultSlot.remove(requested)`.
3. `ResultSlot.remove` records the requested count, then invokes `Slot.remove`.
   `Slot.remove` calls the underlying `ResultContainer.removeItem`.
4. `ResultContainer.removeItem` ignores the requested amount. It calls
   `ContainerHelper.takeItem`, which removes and returns the **whole** result.
5. The menu assigns that whole output to its cursor and invokes `onTake`.
   `ResultSlot.onTake` removes one input per occupied crafting cell and handles
   native remainders. `TransientCraftingContainer.removeItem` immediately calls
   `menu.slotsChanged`; subsequent result state is recomputed from the new inputs.

For a one-log → four-plank recipe and an initially empty cursor, right result
click therefore ends with cursor4, empty input and empty result. A cursor of62
planks has capacity2, so the entire four-plank result remains blocked; it does
not consume the log or move a partial result. Q on a result also requests one
but receives the entire result from its result container.

`tests/native-result-java.mjs` independently executes the original mapped
`Slot`, `ResultSlot`, `ResultContainer`, `ContainerHelper` and
`TransientCraftingContainer` bytecode. Both original versions passed requests
1/2/4 → whole4, one-input consumption, actual grid removal listener invocation
and capacity2 rejection. Small dependency stubs isolate plain inputs and provide
an observer for recipe reevaluation. The report explicitly excludes full Java
menu/recipe-engine execution; the original JAR recipe loader/WASM proofs verify
the matching recipe separately.

## Throwing and version-specific behavior

Ordinary THROW requires an empty cursor. Button0 takes one from an input slot;
button1 takes the stack. Outside PICKUP `slot=-999` drops the whole cursor for
button0 or one for button1. A result container returns whole output in either
case. Original1.21.11 button1 THROW repeats while refreshed output has the same
item; original1.20.4 executes only one take. The data vectors keep this version
difference explicit.

The portable inventory's bounded pending drop queue records authoritative stack
transfers, but world item spawning/pickup/despawn authority is still absent.
Production drop controls must stay disabled until a real world drop consumer
commits each entity before acknowledging that queue. A full queue must roll back
the whole accepted inventory transaction rather than silently deleting items.

CLONE uses the original stack's effective native maximum, preserves component
identity, requires creative materials and requires an empty cursor. Cloning
executes inside the same native menu transaction as the other actions. The
exported `nativeInventoryStackLimit` helper remains available to other callers.

`tests/native-menu-ui.browser.mjs` passed actual DOM/worker/WASM/IndexedDB shift,
number/offhand/F swaps, dragging, double collection, full right result pickup and
save/reopen with both private original recipe JAR versions. It uses no GPU.
The production native menu path keeps `allowDrops:false`; Q and outside cursor
drops remain disabled. Explicit test calls with `allowDrops:true` validate the
bounded pending queue and version-specific native result THROW dispatch, without
claiming world entity spawning, creative drop cooldowns or full survival.

`native-equipment.js` registers exact default player destinations rather than
guessing suffixes at runtime. The optional extractor executes both original
native item registries and compares every usable player destination against these
declarations. Modern BODY/SADDLE defaults do not select a usable player slot.

Run the private helper differential from `pomme-web`:

```sh
POMME_MAPPED_JAR=/private/1.21.11/client-named.jar \
  node authority/tests/native-result-java.mjs
POMME_MAPPED_JAR=/private/1.20.4/client-named.jar \
  POMME_MINECRAFT_VERSION=1.20.4 node authority/tests/native-result-java.mjs
```
