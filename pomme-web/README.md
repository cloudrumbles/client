# Pomme browser client

An executable first milestone toward a Minecraft-compatible WASM/WebGPU client.
This build is an editable procedural voxel sandbox. It does **not** yet connect
to Minecraft servers, open Anvil saves, load vanilla assets, run the Photon pack,
or provide Voxy's full LOD system. The native Pomme client remains available.

## Run

Install Rust stable with the browser target, then:

```sh
rustup target add wasm32-unknown-unknown --toolchain stable
cd pomme-web
npm ci
npm run build
npm run dev
```

Open `http://127.0.0.1:5173` in a current desktop Chrome or Edge with WebGPU and
hardware acceleration. WASM has no external imports or generated JS bindings.
No Minecraft assets or account credentials are required for this sandbox.
WASD moves, mouse looks, Space jumps/swims, Shift sprints, left click removes,
right click places, 1–6 selects materials, E/Escape releases the cursor.
Edits are saved in this origin's local storage and survive reloads.

A prebuilt browser bundle already contains `public/core.wasm`. After extracting
that bundle, run `node scripts/serve.mjs`; Rust and npm install are only needed
to rebuild or test the sources.

The core is a standalone Cargo workspace with its own stable toolchain, avoiding
the native client's Vulkan, audio, and SteelMC build dependencies. The native
workspace's pinned nightly and dependencies are unchanged. The implementation
uses original procedural materials rather than redistributing Minecraft assets
or copying Photon, Sodium, Iris, Voxy, or Nvidium source code.

## What is implemented

- Rust/WASM deterministic voxel world, collision, DDA block picking, bounded
  editing, visible-face greedy meshing, and baked vertex ambient occlusion.
- Worker-side meshing with incremental dirty chunks, including diagonal
  neighbours needed for ambient-occlusion correctness.
- Retained GPU chunk buffers, CPU frustum culling, directional shadow caching,
  cached sky/cloud environment lighting, HDR daylight/fog, reflective animated
  water, bloom and tone mapping.
- Day/night controls, render scale, three quality levels, adaptive resolution,
  measured frame intervals, and optional GPU timestamps.
- A repeatable 30-second camera benchmark with JSON export; no 60 FPS assertion
  is made without a run on the target hardware.

## Test

```sh
npm run build             # Rust tests plus WASM release build
npm test                 # frame statistics and resolution controller
npm run test:browser      # start dev server separately; uses Chromium
```

For environments without a GPU, `POMME_SOFTWARE_GPU=1 npm run test:browser`
selects Chromium SwiftShader. Its results validate rendering and invalidation,
not NVIDIA performance. Set `CHROMIUM_PATH` if Chromium is not at
`/usr/bin/chromium`; set `POMME_URL` to test another origin.

## Verify the 1650 Ti target

Use the laptop plugged in, browser hardware acceleration enabled, and verify
that Chrome/Edge selected the NVIDIA adapter. Start at 1920×1080, Balanced,
85% render scale. Open Settings, run Benchmark, export results. Benchmarking
disables adaptation and the day cycle during the run, uses a fixed camera route,
and discards the first two seconds. The exported adapter information and
render/output dimensions identify what was actually measured.

The 60 FPS criterion is frame pacing within a 16.67 ms budget, including p95/p99
stalls, rather than occasional 60+ FPS. Lower resolution helps fragment-bound
effects; lower shadow resolution helps shadow work. Neither fixes a slow main
thread. GPU times are reported only when timestamp-query is supported; CPU
command encoding time and animation-frame intervals are different measurements.

Current adaptation uses frame intervals and can react to browser scheduling or
CPU load, not only GPU load. It is a first controller, with hysteresis and a
50–100% clamp. The benchmark holds resolution constant for useful comparisons.

## Next implementation milestones

1. Extract portable block registries, model baking, world/chunk storage, movement
   and gameplay from the native client; replace sandbox materials with loaded
   resource-pack models. Keep a versioned platform interface for file/network,
   authentication and audio rather than importing native dependencies into WASM.
2. Add versioned Minecraft packet decoding and a separately deployed,
   authenticated WebSocket-to-TCP gateway. Browsers cannot open arbitrary TCP
   sockets to Java servers; gateway auth and destination controls must be designed
   before deployment. Test real login, chunk updates, inventories and entities.
3. Implement persistent multiresolution terrain: sparse LOD hierarchy,
   asynchronous reduction, bounded IndexedDB/GPU caches, changed-block propagation
   and watertight transitions. Distant multiplayer terrain must come from visited
   chunks, imported worlds, or a server-side data provider.
4. Implement a documented shader render graph and material contract. Running the
   original Photon pack requires emulating its Iris/OpenGL inputs and passes;
   the current renderer only implements a small selection of similar effects.
   Add temporal reprojection, higher-quality clouds and reflections, and static
   indirect-light caches incrementally, measuring each feature on the 1650 Ti.
5. Add protocol/gameplay parity, persistent full saves, audio, UI and touch
   support; test browser/device limits and the shared native path. Benchmark busy
   cities, foliage, water, block edits and rapid world traversal, not just this
   small terrain scene.

See [lighting cache design](./LIGHTING.md) for what can safely be reused.
