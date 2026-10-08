# Original shader-pack runtime (experimental)

This Rust executable runs original OptiFine/Iris-style GLSL programs in a desktop
OpenGL compatibility context. Photon is an external, replaceable input. The host
implements pack preprocessing and rendering contracts; it contains no Photon-like
replacement effects and does not bundle Photon or Minecraft assets.

**This is a rendering integration milestone, not a playable Photon client.**
Pomme's existing Vulkan gameplay client, Azalea-based protocol and SteelMC
singleplayer remain separate. The current scene input is a deterministic block
fixture. Full live-world/entity/UI integration, Iris image parity and GTX 1650 Ti
performance qualification remain open. See [implementation status](IMPLEMENTATION.md).

## Build and run

On Debian/Ubuntu, install a C/C++ build toolchain, `cpp`, `pkg-config`, development
headers for X11/Wayland, and an OpenGL/EGL driver. For software checks, install
`libegl1`, `libgl1`, `libgl1-mesa-dri` and `xvfb`. Use the repository's pinned Rust
toolchain; `cargo` picks up `rust-toolchain.toml`. This package does not build
SteelMC, download game assets or require the launcher.

```sh
cargo build -p pomme-shaderpack --release --locked
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
