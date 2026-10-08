# Pomme Minecraft browser client

A Java edition browser client with a Rust/WebAssembly world and a WebGPU
renderer. It connects to Java servers through a local Node gateway, imports
modern Anvil regions, and loads user-provided Minecraft resource packs. The
native Vulkan client remains available separately.

## Run

```sh
rustup target add wasm32-unknown-unknown --toolchain stable
cd pomme-web
npm ci
npm run build
npm run dev
```

Open `http://127.0.0.1:5173` in desktop Chrome or Edge with WebGPU and hardware
acceleration. A prebuilt bundle includes WASM, the registry and browser libraries;
run `node scripts/serve.mjs` to use it without installing Rust or npm dependencies.
Server connections additionally need `npm ci` and `npm run gateway` in another
terminal. Node 24 is the tested runtime.

The gateway negotiates Java 1.20.4, 1.21.11 and 26.1 with their matching
protocol codecs and block/item/entity registries. Select the actual server
version in the connection form. Current Pumpkin 26.3 needs a newer codec;
the supported Pumpkin reference is commit `70b31323967bb99fd4feefab8e96124be369cd6f`
for 1.21.11. See [PARITY.md](./PARITY.md) for the exact version boundaries.

`npm run bundle` packages the built client into `dist/pomme-browser.zip`, with
source, dependencies' notices and build metadata. Extract it, enter
`pomme-browser`, and run the server command above.

Open **Worlds & servers**. Import your own matching client JAR or resource-pack ZIP
for textures and models. Minecraft assets are not distributed with this project.
The procedural demo works without assets.

For multiplayer, enter the Java server address and use
`ws://127.0.0.1:5174` as the gateway. Select Microsoft authentication for online
servers and complete the official device-code sign-in. Offline authentication is
for servers configured to accept it. The gateway manages TCP, encryption,
compression, configuration and keepalive; the browser manages gameplay. Account
profiles remain in the gateway's private local cache, outside this repository.

Server resource packs can prompt, apply automatically or be declined. Downloads
go through the local gateway, verify the advertised SHA-1 and apply in server
order over your selected base pack. Removing a pack or disconnecting restores
the base pack. `GATEWAY_PACK_HOSTS` permits explicitly selected private pack
hosts beyond the default loopback hosts.

For **Singleplayer**, start `npm run singleplayer` alongside the gateway.
Configure `POMME_PUMPKIN_BINARY` and `POMME_PUMPKIN_VERSION=1.21.11` for the
compatible Pumpkin executable, or `POMME_SINGLEPLAYER_JAR` for your own Java
1.20.4 server JAR and `POMME_SINGLEPLAYER_EULA` pointing to your accepted
`eula.txt`. The local service creates
separate saves and performs graceful save/stop/reopen. This service runs the
authoritative simulation on your computer; the rendering/world client runs in
the browser.

For local exploration/building, select `r.x.z.mca` files from a Java world's
`region` folder and optionally `level.dat`. Imports preserve native IDs, negative
coordinates and source build heights, including custom dimensions. Full chunks, resource packs, lighting and edits are
cached locally; **Resume saved Java world** restores the last import. The browser
cache does not write back to the original Java save. Imported worlds currently
provide creative building with a bounded Rust/WASM simulation for buttons,
levers, redstone lamps and their scheduled updates. A separate WASM inventory
uses native recipes and tags from the selected matching client JAR, with 2×2
player crafting, 3×3 crafting tables and persistent native stack components.
Server-side world generation, mobs and survival simulation come from a connected
server. [authority/README.md](./authority/README.md) and
[authority/INVENTORY.md](./authority/INVENTORY.md) describe the browser authority's scope.

## Controls

WASD moves, mouse looks, Space jumps/swims, Ctrl sprints, Shift sneaks.
Left click mines/attacks; right click places/uses/interacts. In multiplayer, 1–9
selects the hotbar, E opens inventory, T opens chat, Q drops, F swaps hands, and a
double Space toggles flight when the server allows it. Escape releases the mouse.
Imported worlds with native crafting data use E for inventory and 1–9 for the
hotbar. The procedural building hotbar uses 1–6; E releases its cursor.
Keyboard and mouse are required.

## Implemented systems

- Sparse 16³ WASM sections, uniform-section compression, native u16 states,
  moving near-world windows, exact block collision shapes and model picking.
  Double-precision queries and relative GPU coordinates preserve small geometry
  near the Minecraft world border.
- Worker greedy meshing, boundary-face culling, baked ambient occlusion,
  retained GPU buffers and frustum culling. Unchanged terrain is not remeshed or
  uploaded every frame. Bounded WebGPU render bundles reuse stable terrain and
  shadow draw commands as the camera moves.
- Versioned Java login, native chunks/light, dimension changes, movement/teleports,
  server-authoritative mining/placement, confirmed inventory/container UI,
  creative item selection, chat, effects, knockback, combat, abilities and respawn.
- Resource-pack inheritance, variants/multipart models, actual UVs, alpha-tested
  foliage, translucent glass/ice, 51 native texture animations with the complete
  official 1.20.4 assets, and static block-entity forms. Those assets bake 26,632
  of 26,644 state forms; moving pistons need their block-entity animation data.
  The matching 1.21.11 assets bake 29,659 of 29,671 forms, including all copper
  chest oxidation/wax variants and four native copper-golem statue poses.
- Source-derived articulated entity models, equipment/held-item layers, native
  player skin overlays and bounded account-skin loading. Interpolated entity
  batches have dynamic shadows over retained static terrain shadows.
  First-person arms/items use their own HDR pass and preserve the terrain cache.
  Arms, held maps and entity preview meshes retain their native geometry at
  extreme valid vertical coordinates by subtracting the origin before Float32.
  Uncovered entity models use explicit color fallbacks.
  Camel, ravager, sniffer, Breeze and Ender Dragon use native model hierarchies
  and source-derived animation data. Eye blending follows the selected version;
  Breeze wind uses native alpha and depth writes. Translucent actor faces sort
  with the camera, while stable views reuse the sorted buffers.
- Native block-entity NBT/actions, animated chest/shulker lids, front/back sign
  glyphs and editing, banner patterns, decorated-pot sherds, moving pistons,
  player heads and beacon beams. Visual replacement meshes preserve the
  authoritative block IDs, light, saves and physics.
  Lectern books, brushable-block items, decorated-pot wobble and styled/glowing
  sign glyphs have source-backed native model and timing checks.
  Hanging signs use native wall, ceiling and attached chain meshes, UVs and
  two-sided alpha behavior. Bitmap and spacing fonts follow provider and pack
  priority, with bounded reference expansion and fallback glyphs.
- Imported OGG positional audio, streaming music, native sound categories,
  particles, block fragments, rain/snow and lightning, with bounded caches.
- Titles/action bars, boss bars, scoreboards, player list, experience, effects,
  native container layouts/actions, trades, recipes, advancements/statistics,
  readable/editable books and key rebinding.
- Source-derived fixed-tick movement for fluids, surfaces, status effects,
  climbing, swimming/crawling, elytra/fireworks, sleeping and supported mounts.
- Native map color patches, held/frame decorations and labels, and persistent
  explored regions. Changed maps update their atlas tiles without rebuilding
  terrain or shadows.
- Native packed sky/block lighting. Imported local block edits trigger bounded
  background light propagation; light and geometry results stay cached between
  changes. Server lighting remains authoritative. A bounded worker cache adds
  colored emitter transport and one material-colored sunlight bounce; changes
  invalidate the affected cache, and stable frames reuse both GPU volumes.
- Native persistent distant terrain inspired by Voxy: conservative 4/8/16m
  reductions of received/imported columns, grouped 4×4, with 2,048 selected
  columns, a 64 MiB geometry budget, 32 MiB voxel residency and 128 MiB disk cache.
  Unknown terrain stays empty. Sparse visited terrain can span kilometers; dense
  coverage is limited by these budgets. Coarse transitions can show steps, custom
  models become cubes, and distant lighting/materials remain approximate.
- HDR sunlight/fog, cached directional shadows and sky/cloud lighting, High
  volumetric clouds, animated reflective/refractive water, bounded screen-space
  terrain reflections, emissive lava, bloom and tone mapping. Balanced/High use
  depth-validated temporal accumulation/upscaling with history rejection after
  edits, cuts, lighting jumps, world changes and resolution changes.

These are built-in browser implementations of useful techniques from Sodium,
Iris, Voxy and Nvidium. Their Java/OpenGL renderers are not loaded as mods.
WebGPU does not expose Nvidium's NVIDIA mesh-shader extension. The WGSL renderer
provides Photon-inspired effects; it does not execute the original Photon GLSL
pack or claim visual parity.

Full Minecraft parity remains unverified. Remaining work includes every entity
model/pose, item interaction, particle specialization, transaction edge case,
text/accessibility option and complete browser-hosted authoritative simulation. Pumpkin
also has its own unfinished vanilla mechanics. Transparent geometry uses chunk
sorting. Anvil pre-1.16 packed arrays, external MCC chunks and LZ4 regions are
reported as unsupported. [PARITY.md](./PARITY.md) records sources and evidence.

## Validation

```sh
npm run build             # Rust tests and release WASM
npm test                  # Actual WASM, protocol, assets, storage, physics
npm run test:renderer     # Real GPU pixel/depth readback checks
npm run test:lighting     # Local light worker, edits and persistence
npm run test:minecraft    # Browser → gateway → Java protocol server; imports/reload
npm run test:gameplay     # HUD, native menus/actions, books and progress screens
npm run test:effects      # Actual Web Audio decoding and WebGPU weather/particles
npm run test:entities     # Native models, account skins, armor and animation pixels
npm run test:server-packs # Download verification, ordering, acceptance and removal
npm run test:maps         # Native map palette/icons, patch pixels and shadow reuse
npm run test:first-person # Arm/item pixels, hand depth and retained world shadows
npm run test:integration  # Queued resets, respawns and resource-pack lifecycle
npm run test:biomes       # Native biome tint pixels and cached colored LOD
npm run test:dynamic-collision # Native piston/shulker geometry and player pushes
npm run test:portals      # Projected portal layers, native clock and cache reuse
npm run test:text         # Imported translations and safe styled text
npm run test:bundles      # Cached versus direct GPU HDR/depth equivalence
npm run test:irradiance   # Colored light, material bounce and cache invalidation
npm run test:authority    # Browser WASM ticks and saved scheduled-block behavior
npm run test:authority-inventory # WASM click/craft/components and save/reopen
npm run test:inventory    # Native transaction prediction and actual DOM menus
npm run test:import-authority # Imported app ticks/inventory and reload boundaries
npm run test:actor-layers # Native blending, face sorting, depth and origin changes
npm run test:fullbright   # Glowing glyph HDR without sunlight/material emission
npm run test:gpu-profile  # Per-pass timestamps, cache omissions and pixel equivalence
npm run test:recipes      # Modern recipe displays and actual outgoing wire codecs
npm run test:text-ui      # Styled native text across HUD, chat, books and signs
npm run test:browser      # Demo, cache invalidation, controls and benchmark
```

Native asset checks also accept `POMME_MINECRAFT_JAR` and run with
`npm run test:block-entities`, `npm run test:block-entity-completion`,
`npm run test:contained-fluid`, `npm run test:entity-special-models`,
`npm run test:hanging-signs`, `npm run test:first-person-dimensions`,
`npm run test:distant-dimensions` and `npm run test:near-dimensions`.
The dimension and hanging-sign suites require that private JAR
and verify small geometry, native biome tints and cache reuse across ordinary
and extreme valid vertical bounds. Original assets are read locally.

Start the dev server separately. `POMME_SOFTWARE_GPU=1` uses Chromium SwiftShader;
`CHROMIUM_PATH` selects the browser executable and `POMME_URL` selects the origin.
Software rendering verifies behavior, not NVIDIA speed. Fixtures are original
and include actual Minecraft protocol serialization and compressed Anvil NBT.
CI builds WASM, runs Rust formatting/Clippy, unit tests and all browser checks.

## The 1650 Ti / 60 FPS target

Start at 1920×1080, Balanced and 85% render scale. Adaptive resolution uses frame
intervals and available GPU timestamps, with hysteresis and a 50–100% clamp.
Lower scales still reconstruct to output resolution through temporal upscaling.
Check the exported adapter information to confirm the NVIDIA GPU was selected.

The 30-second benchmark holds settings and day phase constant, follows a camera
route and discards the first two seconds. Export includes adapter, world mode,
render/output dimensions, raw GPU samples and frame p50/p95/p99. Per-pass samples
include frame IDs, exact timestamp strings and durations for each executed
shadow, sky, terrain, actor, water, effect, hand and postprocessing pass. Cached
or disabled passes are absent from that frame's sample. A fixed three-buffer
readback ring bounds timing storage and never waits in the rendering loop.
For a real-world
run, import a representative region or disconnect after loading server terrain.
Benchmarking is disabled while connected so its camera route does not send fake
player movement to a server.

The command-line runner selects the matching native registry from your private
JAR, imports saved terrain, and records source hashes and raw samples:

```sh
npm run benchmark -- --jar /path/client.jar --region /path/r.0.0.mca \
  --level /path/level.dat --width 1920 --height 1080 \
  --quality balanced --scale 0.85 --output test-results/1650ti.json
```

It launches a visible Chromium window with the normal hardware backend. It
rejects software adapters for hardware verification and requires an exposed
1650 Ti model, at least 60 average FPS and p95 frame time at most 16.67 ms.
Available GPU timestamps must also meet that budget. Anonymous hardware results
remain unverified; `--software-smoke --headless` checks only the harness.

60 FPS on a 1650 Ti is an unverified target. This execution environment exposes
SwiftShader only. A target-hardware run is required before claiming a 16.67 ms
frame budget or Photon-level quality at that rate. Dense foliage, water, entity
crowds, rapid traversal and block edits need separate measurements.

See [LIGHTING.md](./LIGHTING.md) for cache boundaries and why predictable sunlight
can reuse lighting work while camera-dependent rendering continues each frame.
