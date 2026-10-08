# Portable inventory and ordinary crafting

`InventoryAuthority` owns a separate browser worker running Rust/WASM stack
transactions and IndexedDB persistence. It does not require Pumpkin, SteelMC,
Java, sockets or a native process. Its state includes a 2×2 or 3×3 crafting grid,
36 ordinary player inventory slots, four retained armor slots, a retained offhand
slot, the cursor, selected hotbar slot and an acknowledged drop queue.

Implemented operations are ordinary left/right pickup and placement in the grid
and main inventory, shaped and shapeless recipe matching, taking a complete
crafting result onto the cursor, and repeated result quick moves into the player
inventory. Input consumption, remainder placement/merging, inventory overflow,
and partial output moves follow the native result-slot call chain. Equipment
slots are retained through saves but their placement rules are not simulated.
Changing or closing a crafting grid returns the cursor and inputs through native
live-player menu-close rules before the atomic grid change.

Imported worlds use this worker through `src/local-inventory.js` and the existing
inventory/container UI. E opens the native 2×2 player grid; using an imported
crafting-table block opens the native 3×3 grid. Creative item selection, ordinary
clicks, result quick moves, selected hand and saves use confirmed WASM state.
The production loader reads recipes from the cached original client JAR. A
texture-only pack without these recipes leaves the existing building controls
available. Local mode remains creative building; health, food and experience are
not simulated or displayed by this adapter.

The native recipe/tag loader reads the user's matching original Java client JAR.
It supports 1.20.4 and 1.21.11 and returns an explicit list of unsupported special
recipes. In the original JARs used for validation, it loads 822 ordinary 1.20.4
recipes and 1,026 ordinary 1.21.11 recipes. Embedded experimental datapacks are
not enabled. It preserves recipe output components, including suspicious stew
stock effects, and resolves native item tags. It rejects mismatched JAR versions.
Original JAR archives and decompiled classes remain private. Production recipe
data comes from the user-provided JAR.

This module is an inventory foundation, not a complete single-player server.
Special crafting/transmutation, recipe-book placement/unlocking, survival
permissions, equipment effects, creative click modes, dragging, quick-moving
ordinary input slots, bundles, container interactions, furnaces, brewing,
statistics, advancements and dropped-item entity spawning are not implemented
here. Advanced click modes and the remaining gameplay rules still require native
authority before claiming complete imported-world gameplay parity.

## Source verification

The matching structure follows SteelMC commit
`9142c96cfe72441c6050d98800cbb395dc92e964`:

- `steel-registry/src/recipe/crafting/{mod,matching}.rs`: trim the occupied input
  rectangle; require matching shaped dimensions; mirror horizontally; assign
  overlapping shapeless ingredients without greedy matching.
- `steel-core/src/inventory/slots/crafting_slots.rs`: recompute results and consume
  ingredients from the positioned grid.

The remaining-item and partial quick-move behavior was checked directly against
mapped native 1.21.11 `ResultSlot`, `CraftingInput`, `ShapedRecipePattern`,
`CraftingMenu`, `Inventory`, and `CraftingRecipe`. The pinned Pumpkin crafting
implementation was also inspected; its remainder callback is incomplete, so this
module uses the verified native remainder call chain rather than inheriting that
omission. Remainder resource names in `native-remainders.js` are generated from
native 1.20.4 and 1.21.11 `Items` registration declarations. To reproduce them
using privately mapped/decompiled source:

```sh
node authority/scripts/extract-remainders.mjs \
  1.20.4=/private/1.20.4/Items.java \
  1.21.11=/private/1.21.11/Items.java
```

## API and state ownership

```js
import { loadNativeCraftingData } from './authority/native-crafting-data.js';
import { InventoryAuthority } from './authority/inventory-client.js';
const data = await loadNativeCraftingData(userMinecraftJar, { registry });
const inventory = await InventoryAuthority.open({
  registry, data, worldKey, width: 2,
  onEvents(events, state) { /* Render the confirmed authoritative state. */ },
});
await inventory.setSlot('player', 0, originalNativeStack);
await inventory.click('player', 0, 0);
await inventory.click('grid', 3, 1);
const result = await inventory.craft({ destination: 'cursor', batches: 1 });
await inventory.switchGrid(3); // Returns cursor/grid inputs before opening 3×3.
await inventory.save();
await inventory.close();
```

`setSlot` is an explicit source-state/creative loading operation; it is not a
survival item-grant rule. Native player indices are hotbar `0..8`, main inventory
`9..35`, retained armor `36..39`, and retained offhand `40`. Grid slots use row-major
indices. Empty native AIR stacks normalize to empty. Count and opaque native
component/NBT data survive saves, including `BigInt` and typed arrays. Stacks with
different components remain distinct. Minecraft component identifiers normalize
their optional namespace prefix before comparison. Modern component removals
follow native patch order, including the one-item fallback when `max_stack_size`
is removed. `craft` returns the completed recipe count;
zero means no matching recipe or no destination capacity. An invalid operation or
an exhausted memory bound rejects without consuming inputs.

`state` exposes the confirmed slots, cursor, result, recipe ID, revision and drop
queue. World interaction code must represent every pending drop as its native
item entity before calling `acknowledgeDrops`; saving retains unacknowledged drops.
Closing immediately suppresses events from queued old-world requests; every
concurrent `close()` caller waits for the same persisted shutdown. Snapshots
include the native Minecraft version and a SHA-256 fingerprint of item identities,
limits, recipes and remainders. A different native data set or invalid component/
stack references is rejected before committing a restore.

## Bounds and verification

The Rust engine bounds native item IDs at 65,536, recipes at 8,192, ingredient
memberships at 262,144, each ingredient at 4,096 alternatives, a transaction at
64 recipe batches and pending drops at 64 stacks. Shapeless assignment visits at
most 9×512 bounded states per recipe. A full drop queue rejects the complete
transaction atomically. The JS component table has at most 4,096 entries and a
4 MiB bound for stored component payload and canonical identity keys, plus the
fixed empty entry. Transport
permits at most 128 outstanding requests and 32 MiB of outstanding request data.
IndexedDB retains at most eight inventories and 32 MiB globally; world identities
follow the existing 4,096-character imported-world limit.

From `pomme-web`, after `node authority/build.mjs`:

```sh
node --test authority/tests/inventory.test.mjs
node authority/tests/inventory.browser.mjs
node --test tests/local-inventory.test.mjs
node tests/local-inventory.browser.mjs
POMME_MINECRAFT_JAR=/private/minecraft-1.21.11-client.jar \
  node authority/tests/inventory.browser.mjs
POMME_MINECRAFT_JAR=/private/minecraft-1.20.4-client.jar \
  POMME_MINECRAFT_VERSION=1.20.4 node authority/tests/inventory.browser.mjs
POMME_MINECRAFT_JAR=/private/minecraft-1.21.11-client.jar \
  node tests/local-inventory.browser.mjs
```

Native Rust tests cover translated/mirrored patterns, overlapping shapeless
ingredients, component separation, partial output moves, input/remainder routing,
full-drop rollback and corrupted restore rollback. Real WASM fixtures cover both
supported versions. Actual Chromium worker/IndexedDB tests verify source-derived
cake buckets, 1.21.11 stew components, saved inventory reopen and closed-event
suppression. Browser proofs use the real module and WASM binary; no gameplay
server process or GPU is involved.
The standalone local UI proof exercises actual DOM clicks, both grid sizes,
selected-hand persistence, native menu close, stale-bootstrap cancellation and
optional recipe fallback. Its report explicitly distinguishes generated mechanical
CI fixtures from recipes loaded out of a private original JAR. The main imported
world proof also exercises this production UI against the actual saved world.
