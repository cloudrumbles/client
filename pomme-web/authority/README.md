# Browser authority

This isolated Rust/WASM engine runs authoritative block state and scheduled ticks
inside a browser worker. It needs no native server process. It currently supports
lever toggles, stone and polished blackstone button releases after 20 ticks, wooden
button releases after 30 ticks, adjacent/support-block redstone power, redstone
blocks, and redstone lamp turnoff after four ticks. Other native states are retained
and editable; their block behavior is not simulated yet.

The portable translation follows Pumpkin commit
`70b31323967bb99fd4feefab8e96124be369cd6f`:

- `pumpkin-world/src/tick/scheduler.rs` and `tick/mod.rs`: duplicate tick keys,
  256-slot delay ring, priority and insertion ordering.
- `pumpkin/src/world/time.rs` and `world/mod.rs`: 20 Hz world clock and block tick
  call chain.
- `pumpkin/src/block/blocks/redstone/{lever,buttons,redstone_lamp,redstone_block,mod}.rs`:
  powered-state transitions, delayed release/turnoff, weak and support-block power.

Stone/wood button distinctions were also checked against native 1.21.11
`ButtonBlock`, and SteelMC commit `9142c96cfe72441c6050d98800cbb395dc92e964`
`steel-core/src/behavior/blocks/redstone/{button_block,redstone_lamp_block}.rs`.
Pumpkin's blackstone button delay currently differs from native; this engine uses
native's 20 ticks. The crate links neither native server and contains no original
Minecraft assets or decompiled source.

## Build and test

From `pomme-web`:

```sh
node authority/build.mjs
node --test authority/tests/*.test.mjs
node authority/tests/browser.mjs
```

The build uses the authority directory's stable toolchain and copies its portable
binary to `authority/authority.wasm`. This does not change the native client's
nightly toolchain. The browser test needs the ordinary development HTTP server. It
verifies actual worker/WASM execution, IndexedDB save/reopen with remaining tick
delays, real `BrowserWorld` mirroring, imported section preservation and lifecycle
event suppression. Its renderer adapter records mesh uploads; GPU image quality
is covered by the separate renderer tests.

## Integration

```js
import { AuthorityWorldBridge } from './authority/bridge.js';
const bridge = await AuthorityWorldBridge.open({
  world, registry, columns, worldKey, minY, height,
  autoTick: true,
  onEvents(events, state) { /* Events already applied to BrowserWorld. */ },
  onRetireOverlays(edits) { /* Remove these coordinates from legacy saved overlays. */ },
  onError(error) { /* Report or stop the local authority. */ },
});
const mutation = await bridge.setBlock(x, y, z, nativeStateId);
if (!mutation.handled) world.setBlock(x, y, z, nativeStateId);
const handled = await bridge.useBlock(x, y, z);
if (!handled) { /* Continue normal right-click placement. */ }
await bridge.close();
```

Operations enqueue synchronously and return promises; confirmation and native
state events arrive from the authority worker before those promises resolve.
`useBlock` resolves to a boolean: true for supported lever/button use and false for
an ordinary block, unknown position or other unsupported behavior. A rejected
promise denotes an invalid request or exhausted bound. `setBlock` resolves to
`{handled:true,events,state,value}` inside its authority scope and
`{handled:false,events:[]}` outside it, allowing the existing imported-world editor
to handle the latter. `covers(x,y,z)` and `stats()` expose that scope. Events contain
`{type:'block-update',x,y,z,stateId}`; clocks are signed 64-bit `BigInt`s.

`BrowserAuthority.open()` provides the lower-level worker API: `loadSection`,
`loadColumns`, `blockAt`, `setBlock`, `useBlock`, `step`, `start`, `pause`, `setTime`,
`snapshot`, `restore`, `sections`, `columns`, `save` and `close`. Workers start paused
unless `autoTick` is set. `close({save:false})` discards only the unsaved changes.
`column(x,z)` exports only that column; incremental bridge imports use this query
instead of copying the whole resident world.
Snapshots include native version, block sections, remaining scheduled ticks, clocks,
biomes and block entity metadata. Restoring a different version is rejected.
`AuthorityWorldBridge` keeps rendering all imported sections and admits up to
`maxSections` (default 1,024) for browser authority, in batches of 32 sections.
An optional `center` player position prioritizes nearby columns at initial admission.
It adds missing sections on reopen without replacing saved edits. `loadColumn`
has the same preservation rule; `{overwrite:true}` explicitly replaces matching
covered sections. Exhausting this scope leaves the rest of the existing import
editor working. It does not evict or migrate scheduled ticks to new regions yet.

Close immediately suppresses old-world events while completing the queued save;
pause immediately gates automatic tick events and stops its timer before resolving.
Unchanging blocks emit no redundant state events. Source and active-world light
arrays and metadata survive bridge attachment; changed restored columns request
real lighting recomputation. Covered legacy overlays are retired before ingestion
so they cannot overwrite restored authority. Other overlays remain in place.
Bootstrap saves the authority snapshot successfully to IndexedDB first; an
incremental import with covered overlays also saves before retiring them. A failed
save leaves those overlays intact.
Original light arrays are not carried into the authority save; the normal imported
world store retains them. The bridge releases all original column references after
bootstrap and keeps only a bounded lightweight section catalog thereafter.

## Current bounds and remaining work

The engine retains at most 1,024 sections (8 MiB of raw states), 65,536 pending ticks
and 65,536 coalesced block changes. It checks mutation headroom before changing
blocks and before each simulated tick. The bridge does not delete an imported
section merely because it was absent from a prior save. Requests are capped at 128
pending calls (one slot reserved for close) and 32 MiB, metadata at 4 MiB, a save at
16 MiB, and persistent worlds
at eight/32 MiB with oldest-save eviction. Browser timers catch up at most five ticks
per callback; they do not advance time while paused or closed.

This is a concrete browser-authoritative slice, not full singleplayer parity.
Terrain generation, entities/AI, survival inventories/crafting, fluids, dust,
repeaters/comparators, placement/support validation, arrow-sensitive wooden buttons,
block entity ticking and multiplayer packet serving remain to be ported. Native
registry IDs and collision data are used for all three client versions; solidity
for this slice recognizes opaque full-cube conductors. The existing managed native
Pumpkin server remains necessary for complete available singleplayer behavior.

SteelMC source is available in the pinned submodule. Its current native call chain
is `pomme-singleplayer::launch → drive` (a native thread and two Tokio runtimes),
`serve → Server::run → WorldTickWorkers::spawn → World::tick_game` (native worker
threads), with Rayon generation/encoding pools, filesystem storage and native
protocol/authentication dependencies. Those boundaries need browser worker,
IndexedDB/OPFS and in-memory transport adapters before the complete server can be
built for `wasm32-unknown-unknown`.
