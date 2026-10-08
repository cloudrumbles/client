# Original shader-pack runtime (experimental)

The native client translates original OptiFine/Iris-style GLSL to an explicit
Vulkan ABI and executes the selected pack in its existing gameplay window.
Photon remains an external, replaceable directory or ZIP; the host does not
bundle its sources or substitute Photon-like effects. An optional OpenGL host
remains available for compatibility/reference tests.

**This is a working single-window prototype, with compatibility and performance
work remaining.** Actual chunk meshes, stitched resource atlas, block/sky light,
camera, time, weather and climate drive the Vulkan pack graph. Existing native
entities, held items, particles, weather geometry and UI draw afterwards with
shared scene depth; those forward draws do not yet use the pack's corresponding
geometry programs or contribute to its shadows/postprocessing. Full Iris visual
parity, Voxy-style distant terrain and GTX 1650 Ti qualification remain open.
See [implementation status](IMPLEMENTATION.md).

## Build and run

On Debian/Ubuntu, install a Vulkan loader/driver, a C/C++ build toolchain, `cpp`, `pkg-config`, development
headers for X11/Wayland, and an OpenGL/EGL driver. For software checks, install
`libegl1`, `libgl1`, `libgl1-mesa-dri` and `xvfb`. Use the repository's pinned Rust
toolchain; `cargo` picks up `rust-toolchain.toml`. This package does not build
SteelMC, download game assets or require the launcher.

```sh
cargo build -p pomme-shaderpack --release --features vulkan --locked
cargo test -p pomme-shaderpack --locked
cargo test -p pomme-shaderpack --test pack_inputs -- --ignored
cargo clippy -p pomme-shaderpack --all-targets -- -D warnings
```

The last test command requires actual EGL desktop OpenGL 4.3 compatibility support
and exercises driver compilation, changed settings, failed reload and geometry
replacement. The usual unit-test command leaves that context-dependent test
ignored. A generated GL-binding documentation example is also ignored.

Fetch the original Photon revision used for validation:

```sh
git clone https://github.com/sixthsurge/photon.git /tmp/photon
git -C /tmp/photon checkout 15458c0937f8647c37eb6a501bef5eb3bf3da31b
./target/release/pomme-shaderpack \
  --pack /tmp/photon --profile low --option SH_SKYLIGHT=false \
  --window --width 1280 --height 720
```

Controls: WASD/space/left shift move, arrow keys look, 1/2/3 change time,
G toggles rain, R reloads the selected pack, Escape closes. Pack selection uses
`--pack` with a directory or ZIP. Failed reloads preserve the active pack.
`--window-frames 40 --output output` performs a bounded window/presentation check
and saves a screenshot and window manifest. `--inspect` writes the resolved pack
manifest without creating a GPU context. `POMME_CPP` can select a GNU-compatible
preprocessor executable.

The `SH_SKYLIGHT=false` override is recorded, not applied secretly. Original
Photon's skylight compute program needs 36,860 bytes of shared memory; llvmpipe
in this container reports 32,768 and rejects the linked program. Attempt the
unmodified setting on the target driver separately. Custom images/SSBOs are not
implemented, so the ultra colored-light profile is unsupported.

For optional vanilla fixture textures, use your own installed 1.21.11 client JAR:

```sh
./target/release/pomme-pack-atlas \
  --client-jar /path/to/1.21.11.jar --output /tmp/fixture-atlas.png
./target/release/pomme-shaderpack \
  --pack /tmp/photon --profile medium --option SH_SKYLIGHT=false \
  --atlas /tmp/fixture-atlas.png --scene water --frames 120 --warmup 60 \
  --width 640 --height 360 --output photon-water
```

The helper extracts grass, stone, leaves and the first water animation frame.
Without `--atlas`, the same fixture uses four flat diagnostic tiles. Neither mode
is a production resource-pack atlas or a full Minecraft world.

## Live Minecraft 26.3 client

Build the client with the optional host, using an existing launcher installation
for the version's extracted JAR assets and asset-index/object directories:

```sh
cargo build -p pomme-client --no-default-features --features shader-packs --locked
./target/debug/pomme-client --version 26.3 --username NativePhoton \
  --assets-dir /path/to/assets --versions-dir /path/to/versions \
  --game-dir /path/to/test-game --quick-access-multiplayer 127.0.0.1:25577 \
  --shader-pack /tmp/photon --shader-profile low \
  --shader-option SH_SKYLIGHT=false --shader-option SHADER_AO=0 \
  --shader-width 640 --shader-height 360 --shader-frames 120 \
  --shader-output live-26.3
```

Use an authorized local vanilla 26.3 server (Java 25). Movement, mouse look,
inventory and the original pack appear in one Vulkan window. F6 reloads the pack;
F7 cycles repeated `--shader-alternate-pack /path/to/pack` arguments. A failed
compatible reload retains the active pack. If command recording fails, the client
discards the unsubmitted pack state, consumes the acquired semaphore and rebuilds
the swapchain; native rendering resumes with an explicit error. F6 retries the
selected pack. Internal pack resolution fits the
requested shader width/height within the window aspect ratio; resize rebuilds
its targets. `--shader-frames` captures pass evidence and leaves gameplay running.
F2 captures the complete native window, including UI and forward actors.

For the separate GL reference viewport, add `--shader-reference-window`; R/P
operate in that window. Standalone GL mode accepts `--alternate-pack` and
`--minecraft-version 26.3`. Vulkan does not use a GL window or CPU pixel bridge.

To execute the original pack graph on a Vulkan device without a display:

```sh
./target/release/pomme-pack-vulkan --pack /tmp/photon --profile low \
  --option SH_SKYLIGHT=false --render --width 640 --height 360 \
  --frames 120 --output vulkan-photon
```

Omit `--render` to export translated GLSL, SPIR-V and the resource ABI for
inspection. This compiler output is diagnostic; execution/visual tests are also
required. The Vulkan path rejects active compute, custom images/SSBOs and unknown
active inputs until their corresponding execution contracts are implemented.
`SH_SKYLIGHT=false` is an explicit, recorded setting for this path.

The adapter retains block-state predicates, normals, tangent/handedness, mid-UV,
color and separate light in auxiliary CPU meshing data; the existing 16-byte
Vulkan vertex format stays intact. When a pack is selected, greedy terrain quads
are disabled to preserve the pack's atlas UV contract. Geometry/atlas changes
invalidate history; old atlas UV meshes are discarded on resource reload. Vanilla
dimension changes select world0/world-1/world1 programs. Modded dimensions fail
explicitly until their mapping is implemented. This prototype retains all loaded
section geometry in the pack graph; section culling/batching and animation parity
need further work before performance qualification.

## Reproducible measurements

```sh
python3 tools/native/benchmark_shaderpack.py \
  --pack /tmp/photon --preset photon-low-compat \
  --atlas /tmp/fixture-atlas.png --output native-benchmarks
```

The runner executes day, night, rain, water, cave, orbit and state-change scenes
sequentially, saving each image, complete pack hash/options, device/driver/
extensions/limits, input state and raw per-pass GPU/CPU samples. Provisional
low/medium/high comparison presets live in `tools/native/photon-presets.json`.
They are quality/cost starting points, not measured 60 FPS presets. The pinned
Photon profiles reference an undeclared `GTAO` option; this is reported and ignored,
and these comparison presets set the declared `SHADER_AO` option explicitly.

Measurements serialize every frame with GPU timer-query readback and exclude
presentation. Do not convert these offscreen intervals into a gameplay-FPS claim.
Warmup is configurable; pack temporal effects can still be settling after a short
run. The state-change sequence performs a time command, rain change, teleport,
a real fixture geometry deletion, light change and material change, then records
the associated history invalidations. Continuous orbit uses previous camera
matrices. No disk lighting cache or unsupported NVIDIA extension is required.

The [checked-in evidence](validation/README.md) records software execution only.
Target acceptance requires the physical GTX 1650 Ti, release builds, laptop driver/
power/thermal conditions, a fixed live Minecraft world and reference Iris visuals.
