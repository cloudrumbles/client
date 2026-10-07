# Pomme Minecraft browser client

A Java edition 1.20.4 browser client with a Rust/WebAssembly world and a WebGPU
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

`npm run bundle` packages the built client into `dist/pomme-browser.zip`, with
source, dependencies' notices and build metadata. Extract it, enter
`pomme-browser`, and run the server command above.

Open **Worlds & servers**. Import your own 1.20.4 client JAR or resource-pack ZIP
for textures and models. Minecraft assets are not distributed with this project.
The procedural demo works without assets.

For multiplayer, enter the Java server address and use
`ws://127.0.0.1:5174` as the gateway. Select Microsoft authentication for online
servers and complete the official device-code sign-in. Offline authentication is
for servers configured to accept it. The gateway manages TCP, encryption,
compression, configuration and keepalive; the browser manages gameplay. Account
profiles remain in the gateway's private local cache, outside this repository.

For local exploration/building, select `r.x.z.mca` files from a Java world's
`region` folder and optionally `level.dat`. Imports preserve native IDs, negative
coordinates and Y=-64..319. Full chunks, resource packs, lighting and edits are
cached locally; **Resume saved Java world** restores the last import. The browser
cache does not write back to the original Java save. Imported worlds currently
provide exploration/building; server-side world generation, mobs and survival
simulation come from a connected server.

## Controls

WASD moves, mouse looks, Space jumps/swims, Ctrl sprints, Shift sneaks.
Left click mines/attacks; right click places/uses/interacts. In multiplayer, 1–9
selects the hotbar, E opens inventory, T opens chat, Q drops, F swaps hands, and a
double Space toggles flight when the server allows it. Escape releases the mouse.
The procedural/local building hotbar uses 1–6; E also releases the cursor there.
Keyboard and mouse are required.

## Implemented systems

- Sparse 16³ WASM sections, uniform-section compression, native u16 states,
  moving near-world windows, exact block collision shapes and model picking.
  Double-precision queries and relative GPU coordinates preserve small geometry
  near the Minecraft world border.
- Worker greedy meshing, boundary-face culling, baked ambient occlusion,
  retained GPU buffers and frustum culling. Unchanged terrain is not remeshed or
  uploaded every frame.
- Java 1.20.4 login, native chunks/light, dimension changes, movement/teleports,
  server-authoritative mining/placement, confirmed inventory/container UI,
  creative item selection, chat, effects, knockback, combat, abilities and respawn.
- Resource-pack inheritance, variants/multipart models, actual UVs, alpha-tested
  foliage, translucent glass/ice, 51 native texture animations with the complete
  official 1.20.4 assets, and static block-entity forms. Those assets bake 26,632
  of 26,644 state forms; moving pistons need their block-entity animation data.
- Interpolated articulated server entities with imported textures for common
  mobs/default players, bounded entity batches and dynamic shadows over retained
  static terrain shadows. Uncovered entity models use explicit color fallbacks.
- Native packed sky/block lighting. Imported local block edits trigger bounded
  background light propagation; light and geometry results stay cached between
  changes. Server lighting remains authoritative.
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

Remaining Minecraft parity includes server/resource-pack negotiation beyond this
version, the full set of entity/equipment models and account skins, dynamic
block-entity text/patterns/animations, particles/weather/audio, and a local
singleplayer server. Transparent geometry uses chunk sorting, not a complete
order-independent refraction system. Anvil pre-1.16 packed arrays, external MCC
chunks and LZ4 regions are reported as unsupported.

## Validation

```sh
npm run build             # Rust tests and release WASM
npm test                  # Actual WASM, protocol, assets, storage, physics
npm run test:renderer     # Real GPU pixel/depth readback checks
npm run test:lighting     # Local light worker, edits and persistence
npm run test:minecraft    # Browser → gateway → Java protocol server; imports/reload
npm run test:browser      # Demo, cache invalidation, controls and benchmark
```

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
render/output dimensions, raw GPU samples and frame p50/p95/p99. For a real-world
run, import a representative region or disconnect after loading server terrain.
Benchmarking is disabled while connected so its camera route does not send fake
player movement to a server.

60 FPS on a 1650 Ti is an unverified target. This execution environment exposes
SwiftShader only. A target-hardware run is required before claiming a 16.67 ms
frame budget or Photon-level quality at that rate. Dense foliage, water, entity
crowds, rapid traversal and block edits need separate measurements.

See [LIGHTING.md](./LIGHTING.md) for cache boundaries and why predictable sunlight
can reuse lighting work while camera-dependent rendering continues each frame.
