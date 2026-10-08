# Imported player inventory bootstrap

`source-level-inventory.js` reads and plans source inventory for the imported
world's local WASM authority. `readSourceLevelInventory`
reads a bounded original gzip `level.dat` and captures only the typed
`Data.Player` subtree plus native data/version identity. Numeric/list/array NBT
types remain explicit, including signed bytes and BigInt longs. Packed/inflated
levels are limited to16MiB; source/player planning state is limited to4MiB, depth64,
one million NBT elements and4096 inventory records. No original save is modified.

`planSourceInventoryBootstrap(source, {registry})` prepares native player slots,
selected hotbar, diagnostics and an all-or-nothing `ready` flag. It retains the
complete typed source descriptor. Unsupported conversions never become fake
protocol component data, and a non-ready plan must not be partially installed.

## Original source rules

| Rule | Original1.20.4 | Original1.21.11 |
|---|---|---|
| Inventory record slot | `getByte("Slot") &255` | `ItemStackWithSlot.CODEC`, unsigned byte, default0 |
| Main/hotbar | Slot0..35 | Slot0..35 |
| Armor | Slot100..103 → player36..39 | `Player.equipment` feet/legs/chest/head → player36..39 |
| Offhand | Signed Slot-106 becomes150 → player40 | `Player.equipment.offhand` → player40 |
| Count | Signed-byte `Count`, missing/invalid default0 | Native integer `count`1..99, missing/invalid fallback1 |
| Empty duplicate entry | Skip; earlier stack survives | A valid AIR stack replaces earlier stack with empty |
| Damageable legacy item | Materialize nonnegative integer `tag.Damage` | Native component patch/defaults |

The player main/hotbar layout retains native ordering0..8 and9..35. Modern
`Inventory.load` accepts only slots0..35; legacy equipment entries100/150 are
ignored in that list. Modern `LivingEntity.readAdditionalSaveData` loads its
separate `EntityEquipment.CODEC` map before player inventory load.
`PlayerEquipment.get(MAINHAND)` redirects to the selected inventory stack, so the
equipment map's mainhand value does not override player source selection.

Original1.21.11 `ItemStack.MAP_CODEC` uses `Item.CODEC`,
`ExtraCodecs.intRange(1,99).fieldOf("count").orElse(1)`, and
`DataComponentPatch.CODEC.optionalFieldOf("components", EMPTY)`. A source patch
is a map of persistent component save-codec values; removed keys start with`!`
and encode a unit/empty compound. It is a different representation from wire
component data. Known maximum-stack-size additions/removals are converted
explicitly, including namespace aliases and the native removed-component
fallback1. Other components require an injected, verified source codec decoder.
Their exact typed payloads remain in the deferred/source records until then.

Native partial codec error recovery is not fully implemented here; ambiguous
patches and unported component codecs defer the whole bootstrap. Source versions
that differ from the selected registry need native data fixing first. Counts
above the portable99 bound, invalid selected slots, unretained modern body/saddle
equipment, and legacy PlayerHeadItem tag verification also defer. The original
1.20.4 class scan found only Item(default) and PlayerHeadItem implementations of
`verifyTagAfterLoad`; the player-head hook is deliberately not guessed.

## Import and reopen

1. At `main.importFiles`, read `level.dat` with the isolated source helper and
   retain the descriptor beside source metadata, under the current import epoch.
   `importLevelDat` currently returns spawn/version/seed/time and discards Player.
2. Pass the matching descriptor to `LocalInventory.open` without changing network
   session identity. After `InventoryAuthority.open`, bootstrap only when
   `initial.restored` is false. A saved native authority inventory always wins.
3. For a present, ready source plan, install its entire player array and selected
   slot before UI construction. Check the current world guard after every await;
   a stale candidate must close with`save:false`. Explicit source empty slots
   must remain empty. Use starter creative building slots only when there is no
   source player inventory.
4. Do not install a partial deferred plan. Retain the source descriptor for its
   future native codec conversion and leave imported building available. Do not
   represent unsupported source stacks as protocol components or source amounts
   as item grants. The UI remains creative building until survival is ported.
5. `storeSourceLevelInventory` and `restoreSourceLevelInventory` use a separate
   bounded IndexedDB cache for BigInt/typed-array-capable bootstrap metadata.
   The cache retains up to eight world identities and32MiB in total, with4MiB
   per source and eight queued writes. Existing
   `pomme-last-import` JSON stores only dimension/spawn/clock identity and cannot
   serialize this source descriptor directly. Once a native inventory save
   exists, resume uses that save and must not reapply the original inventory.

The nine CPU tests exercise both source formats, native duplicate/count rules,
typed legacy NBT, explicit modern maximum patches, deferred components and exact
WASM save/reopen. Source input remains unchanged. The optional independent
`authority/tests/native-inventory-codec-java.mjs` executes original1.21.11
`ItemStack.CODEC`, `DataComponentPatch.CODEC` and `ItemStackWithSlot.CODEC` with
the matching original libraries and no dependency stubs. It independently passed
count fallback, maximum namespace alias/removal, unsigned/missing slots and
unknown item rejection. It does not execute the entire player load.

`tests/source-inventory.browser.mjs` runs the actual UI, worker, WASM and
IndexedDB without a GPU. Both private original recipe JAR versions passed source
selection and explicit empty slots, native source component identity, retained
armor/offhand, save/reopen precedence and stale candidate cancellation. The
player NBT is a generated mechanical fixture, not an original player save.
Modern unported components remain typed in the source cache and leave building
available without saving a replacement starter inventory.

`unavailableSourceLevelInventory(error,{version,dataVersion})` stores a bounded
defer marker after a malformed or over-limit source read. It distinguishes an
unread source from a source with no Player inventory, so import/resume still leaves
building available and cannot save replacement starter slots. The marker retains
the failure reason; it does not claim to retain a rejected raw source payload.
The original file remains untouched. An existing authoritative save still wins.

`source-inventory-stack.js` exposes `planSourceInventoryStack` for typed native
item records from other containers/entities. It reuses this same source-codec
planner and returns stack, ready, deferred, diagnostics and the original typed
record. Callers must supply the original source version/dataVersion; visual
preview stack conversions are unsuitable for authoritative source bootstrap.

```sh
node --test tests/source-level-inventory.test.mjs
POMME_MAPPED_JAR=/private/1.21.11/client-named.jar \
  POMME_JAVA_LIBRARIES=/private/1.21.11/libraries \
  node authority/tests/native-inventory-codec-java.mjs
```
