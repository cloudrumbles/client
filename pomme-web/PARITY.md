# Minecraft parity and reference sources

Full Minecraft parity is **not yet established**. A working feature and a
passing smoke test are evidence for that feature, not evidence that all vanilla
edge cases are implemented. This checklist separates client work from server
simulation and records the source needed for exact comparisons.

## Version and server boundaries

The original browser protocol is Java **1.20.4 / 765**. The additional adapters
target **1.21.11 / 774** and **26.1 / 775**, using the matching
`minecraft-protocol` codec and native block/item/entity registries. Registry IDs
are not translated by relabelling a version string.

Pumpkin's current source at
[`1a6a6e6f158e0ef143b18299d20aaeeb2a285881`](https://github.com/Pumpkin-MC/Pumpkin/tree/1a6a6e6f158e0ef143b18299d20aaeeb2a285881)
targets Java **26.3 / 777** exclusively. Both `CURRENT_MC_VERSION` and
`LOWEST_SUPPORTED_MC_VERSION` name 26.3 in
[`crates/pumpkin-data/src/generated/packet.rs`](https://github.com/Pumpkin-MC/Pumpkin/blob/1a6a6e6f158e0ef143b18299d20aaeeb2a285881/crates/pumpkin-data/src/generated/packet.rs).
The installed `minecraft-data` 3.117.0 lists 26.3 in version metadata but has no
26.3 gameplay schema; `minecraftData('26.3')` returns `null`. Current rolling
Pumpkin binaries therefore cannot be represented as a supported client version.

The compatible Pumpkin integration uses
[`70b31323967bb99fd4feefab8e96124be369cd6f`](https://github.com/Pumpkin-MC/Pumpkin/tree/70b31323967bb99fd4feefab8e96124be369cd6f),
whose Cargo workspace targets **1.21.11**. It builds with stable Rust:

```sh
git clone https://github.com/Pumpkin-MC/Pumpkin.git
cd Pumpkin
git checkout 70b31323967bb99fd4feefab8e96124be369cd6f
cargo build --locked -p pumpkin \
  --config 'profile.dev.package.pumpkin-world.opt-level=3'
```

The pinned 1.21.11 commit is MIT-licensed; current rolling Pumpkin is GPL-3.0.
The exact source revision's original notice is preserved. Its plugin API has separate licenses. This client does not
bundle the Pumpkin executable, copyrighted Minecraft assets, account profiles
or a server JAR. Pumpkin's Wasm plugin host is a plugin runtime; it does not make
the server itself a browser-compatible WebAssembly program.

The imported-world browser path now has a separate Rust/WASM authority worker
for a bounded button/lever/lamp simulation and native scheduled updates. It
persists exact remaining delays and updates the render world through guarded
events. A second worker owns inventory/crafting transactions using recipes and
tags extracted from the user's matching JAR. These are implemented slices;
they do not establish an integrated vanilla server, mob AI or native generation.
See [authority/README.md](./authority/README.md) and
[authority/INVENTORY.md](./authority/INVENTORY.md).

`scripts/singleplayer.mjs` manages a real local server process, private saves,
loopback networking, startup status, graceful save/stop and reopen. The browser
talks to its control service and the TCP gateway. Running the entire authoritative
server inside the browser remains separate work: Pumpkin's filesystem,
threading, Tokio sockets and world-generation scheduling need browser bindings.
The existing native Pomme `pomme-singleplayer` integration embeds SteelMC over an
in-memory transport; that Rust/native transport is not presently the browser
singleplayer backend.

## Evidence checklist

| Area | Implemented evidence | Remaining exact comparisons |
| --- | --- | --- |
| Protocol and worlds | Native full-height chunks, section palettes, light arrays, dimension configuration, block changes, unloads and compressed Anvil imports | All negotiated protocol versions, datapack-driven limits, registries and experimental data; compatibility fixtures beyond the named versions |
| Movement | Native block collision shapes, fixed ticks, partial-block stepping, fluids, unloaded-chunk barriers and authoritative teleports | Differential trajectories for every status effect, vehicle, surface, pose and movement mode against the corresponding original client |
| Gameplay | Server-confirmed mining/placement, hotbar, creative inventory, container clicks, chat, combat, respawn and local server lifecycle | Every item interaction, menu, recipe-book behavior, advancement and server transaction edge case |
| Entities and block entities | Actual server entity updates, interpolation, resource-pack textures and dynamic render batches; native block-entity NBT and actions where ported | Every entity model, equipment layer, skin, pose, animation, display entity and block-entity specialization |
| Presentation | HDR lighting, shadows, atmospheric sky, water reflections, temporal upscaling and resource-pack textures; client effects/audio/HUD features where ported | Exact original particle, weather, sound, UI, accessibility, localization, text and first-person presentation behavior |
| Saves and simulation | Real Pumpkin process with native world generation, ticks and disk saves; copied imports preserve original saves; bounded WASM block ticks and inventory/crafting persist in browser storage | Pumpkin's own unfinished vanilla mechanics; complete browser-hosted authoritative server; deterministic vanilla save/worldgen comparison |
| Shader performance | Cached terrain shadow coverage and sky lighting, persistent geometry, LOD terrain, bounded screen effects and GPU timing exports | Original Photon shader compatibility and image comparisons; measurements on the user's GTX 1650 Ti at the stated resolution and settings |

Renderer tests use actual WebGPU readbacks in Chromium. The software adapter
available in CI can verify rendering and invalidation behavior, but cannot
establish a 60 FPS hardware result on the user's NVIDIA GPU. Nvidium's NV mesh
shader API is not exposed by browser WebGPU. Sodium, Iris and Voxy techniques
are adapted where documented; their Java/OpenGL mods are not loaded into
WebAssembly by this client. The mesher now includes a Rust adaptation of latest
Sodium's array light-cache lifecycle, pinned to
`8aa723c69af6ce40255862df6c3bf8c6cca9d883` with the original source and notices in
`core/third_party/sodium`. The project has since moved to native Rust/Vulkan;
[the goal document](https://github.com/cloudrumbles/client/blob/feat/wasm-webgpu-client/NATIVE_RENDERING_GOAL.md)
records that direction and the native work still outstanding.

Pumpkin's
[`README`](https://github.com/Pumpkin-MC/Pumpkin/blob/1a6a6e6f158e0ef143b18299d20aaeeb2a285881/README.md)
marks world generation, redstone, combat, mob AI and other mechanics as active
work. Using Pumpkin as the local authority does not establish vanilla server
parity for those systems.

## Original-source comparisons

Original code is not currently an unavailable prerequisite. Mojang's public
[version manifest](https://piston-meta.mojang.com/mc/game/version_manifest_v2.json)
provides client/server JARs and official mappings. These can be downloaded and
inspected locally without committing or redistributing the original code.
Minecraft assets must continue to come from the user's own installed version or
selected pack.

For an exact port, follow the entry method through every superclass and helper,
including tick order, rounding, predicates and side effects. These are concrete
reference entry points for the browser work; compare the matching target version
instead of assuming names or rules are unchanged between versions:

| Work | Original Mojang-mapped entry points |
| --- | --- |
| Client world lifecycle | `Minecraft`, `ClientLevel`, `ClientChunkCache`, `ClientPacketListener`, `ClientConfigurationPacketListener` |
| Movement and prediction | `LocalPlayer`, `AbstractClientPlayer`, `Player`, `LivingEntity`, `Entity`, `MultiPlayerGameMode` |
| Terrain and atmosphere | `GameRenderer`, `LevelRenderer`, `LightTexture`, `DimensionSpecialEffects`, `FogRenderer` |
| Entities and equipment | `EntityRenderDispatcher`, `LivingEntityRenderer`, `PlayerRenderer`, `ItemRenderer`, `ItemInHandRenderer` and each entity renderer/model |
| Animated block entities | `BlockEntityRenderDispatcher`, `ChestRenderer`, `SignRenderer`, `BannerRenderer`, `SkullBlockRenderer`, `PistonHeadRenderer` and their block-entity state |
| Effects and audio | `ParticleEngine`, concrete particle providers, `SoundManager`, `SoundEngine`, `MusicManager` |
| Screens and inventory | `Gui`, `AbstractContainerScreen`, `InventoryScreen`, `CreativeModeInventoryScreen`, `ChatScreen`, `AbstractContainerMenu`, `RecipeBookComponent` |
| Integrated simulation | `IntegratedServer`, `MinecraftServer`, `ServerLevel`, `ServerChunkCache`, `ChunkMap`, `DistanceManager`, `ServerGamePacketListenerImpl` |
| World mechanics | `NoiseBasedChunkGenerator`, `NaturalSpawner`, `LevelTicks`, `RecipeManager`, `LootTable`, concrete block/item/entity behaviors |

Pumpkin contributes inspectable Rust references for the same systems. Relevant
source-backed adapter differences in the 1.21.11 integration are
[`pumpkin-protocol/src/java/client/play/chunk_data.rs`](https://github.com/Pumpkin-MC/Pumpkin/blob/70b31323967bb99fd4feefab8e96124be369cd6f/pumpkin-protocol/src/java/client/play/chunk_data.rs)
(implicit palette word counts),
[`pumpkin-protocol/src/codec/item_stack_seralizer.rs`](https://github.com/Pumpkin-MC/Pumpkin/blob/70b31323967bb99fd4feefab8e96124be369cd6f/pumpkin-protocol/src/codec/item_stack_seralizer.rs)
(component stacks and inventory hashes),
[`pumpkin-data/src/data_component_impl.rs`](https://github.com/Pumpkin-MC/Pumpkin/blob/70b31323967bb99fd4feefab8e96124be369cd6f/pumpkin-data/src/data_component_impl.rs)
(CRC32C HashOps tests), and
[`assets/screens.json`](https://github.com/Pumpkin-MC/Pumpkin/blob/70b31323967bb99fd4feefab8e96124be369cd6f/assets/screens.json)
(menu registry order). Unsupported component hashes are not invented; the
server supplies the authoritative correction.

Configuration registries retain their native NBT types. Pumpkin serializes the
dimension bounds as NBT longs, so the adapter resolves `min_y`, `height` and
`logical_height` to exact safe integers before allocating or decoding sections.
Other NBT longs retain their full representation. Local command permissions use
Pumpkin's own offline identity algorithm from
[`pumpkin/src/net/mod.rs`](https://github.com/Pumpkin-MC/Pumpkin/blob/70b31323967bb99fd4feefab8e96124be369cd6f/pumpkin/src/net/mod.rs),
rather than assuming the vanilla offline UUID calculation.

## Actual browser verification

The local-server test needs a compatible Pumpkin build, a built browser client
and the development HTTP server already running:

```sh
POMME_PUMPKIN_BINARY=/absolute/path/to/Pumpkin/target/debug/pumpkin \
POMME_PUMPKIN_VERSION=1.21.11 POMME_SOFTWARE_GPU=1 \
node tests/singleplayer.browser.mjs
```

This opens Chromium through Playwright, joins the actual server, verifies native
negative-Y chunks/light, updates a block through a server command, exercises
creative and container inventory packets, saves/stops and reopens the same world.
It writes a screenshot and `test-results/pumpkin-singleplayer.json`. An optional
`POMME_MINECRAFT_JAR` selects a local asset JAR for the visual test. The test uses a
temporary private save, does not distribute assets, and does not infer complete
parity from its passing cases.

The 2026-10-08 run passed against the historical Pumpkin build above and the
official 1.21.11 client JAR (SHA-1
`ba2df812c2d12e0219c489c4cd9a5e1f0760f5bd`). Chromium decoded and rendered native
30 initial columns with bounds `[-64, 384]` and 690 light sections, then completed
49 columns for the requested view. It changed a block via
the server, transferred a creative stack between hotbar slots, stopped without
forcing the process, and reopened the same save. The new login received the
persisted block and transferred inventory from the server. Four Anvil region
files were written, and no browser errors occurred. The adapter and lifecycle
suite also passed all nine cases.

The screenshot captures the completed requested view and the software WebGPU
adapter; it establishes the native asset/render path and gameplay round trip.
It does not establish complete world rendering, full vanilla behavior, visual
equivalence to Photon, or target-hardware frame rates.

The imported-world authority proof separately read all four saved Pumpkin
regions: 529 chunks, no skips. Native button/lamp deadlines survive save/reopen;
retired overlays, out-of-scope local edits, native pack reload and stale bootstrap
cancellation remain consistent. Incremental source admission retains earlier
chunks, including custom positive/negative vertical ranges and no-skylight
dimensions. Original-JAR inventory proofs cover ordinary recipe extraction
(822 recipes in 1.20.4 and 1,026 in 1.21.11), cake bucket remainders and modern
component-preserving save/reopen.

Source-backed GPU proofs compare native contained-fluid geometry, six ordinary
and extreme vertical dimensions, articulated special entity families, copper
chest lids and all four copper statue poses, lectern books, revealed brushable
items, pot rest/wobble and sign styling/fullbright. Native eye blend fixtures
also check legacy additive versus modern translucent compositing, low-alpha
texels, coplanar depth, wind depth writes and camera face ordering. These
feature-specific comparisons do not establish complete visual parity.

Both original asset versions pass hanging-sign chain/UV/alpha, text, native
collision and WASM picking checks. Private 1.21.11 readbacks also compare native
arms, swords, held maps and entity previews at Y=0 and Y=±2,000,000,000; vertices
and HDR pixels remain identical. Font checks cover native spaces, ordered pack
fallback and bounded provider-reference expansion. Per-pass GPU profiling
proves cache-hit omissions and identical color/depth with profiling enabled.

Additional original-JAR 1.21.11 and 26.1 proofs cover adult/baby Happy Ghast,
Nautilus, Zombie Nautilus, Camel Husk and farm-animal variants, equipment and
version-specific texture/animation selection. Source-backed conduit/beam checks
cover native wind phase boundaries, cage backfaces, beam heights/alpha and cached
shadow omission. These compare feature-specific geometry and GPU readbacks;
they are not complete Java-renderer screenshot comparisons.

Block destruction checks exercise all ten native texture stages, native
source/destination blending, depth preservation, retained mesh uploads and local
temporal rejection. Actual main-app protocol fixtures cover local mining,
remote stages, cancellation, replacement, reload and disconnect. Animated
block-entity destruction templates and all partial occlusion cases remain
incomplete.

Typed player inventory bootstrap and native menu actions pass actual DOM,
worker, WASM and IndexedDB checks with both 1.20.4 and 1.21.11 recipe sources.
Supported source metadata is retained; unsupported components defer initialization.
Atomic inventory/item-sidecar storage checks cover exact rollback and durable
reopen. Local ground-item integration now includes source actors, native fixed
ticks, drops and pickups; production lifecycle validation is tracked separately
from the worker/storage proof. Whole-world folder imports include separate modern
entity regions. Bare terrain selections cover only actors in the selected terrain
files. Saved initialized actor history takes precedence over later source files.

Incremental LOD tests cover retained mip arrays, unchanged-level revisions,
conservative shared-face culling and original-JAR GPU checks across six dimension
bounds. Removing physically interior faces changes a small number of shadow-edge
pixels relative to the old closed-cell baseline; the independent exposed-surface
reference retains identical color and depth.
