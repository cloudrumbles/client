Native compute/storage checkpoint 8d8f41bb29b0e2e83a7eab8a3f2e60e12dbc685f
Linux x86_64; native client and standalone Vulkan pack host. No embedded server.

Build from the exact project source:
  mkdir source
  tar -xzf project-source.tar.gz -C source
  tar -xzf SteelMC-submodule-source.tar.gz -C source/third_party/SteelMC
  cd source
  cargo build --release --locked --no-default-features -p pomme-client --features shader-packs
  cargo build --release --locked -p pomme-shaderpack --features vulkan --bin pomme-pack-vulkan

Alternatively clone https://github.com/cloudrumbles/client.git, checkout 8d8f41bb29b0e2e83a7eab8a3f2e60e12dbc685f,
and initialize its pinned submodules. Use rust-toolchain.toml and Cargo.lock.
Rust registry and Git dependency source archives preserve the locked sources;
they are not a configured offline Cargo vendor tree. COPYING, LICENSE,
THIRD_PARTY_LICENSES.md, Iris LGPL source notices and dependency inventory accompany
this distribution. Preserve applicable source, attribution and distribution
obligations when redistributing. Source versions and archive SHA-256 are recorded.
The bundled libshaderc is Debian2025.2-1; runtime-source/shaderc preserves its
matching source package separately from shaderc-sys's vendored2025.3 source.
Runtime component source versions are recorded from Debian Built-Using; a complete
provided set contains matching glslang/SPIRV-Tools and build headers. No claim of
bit-for-bit rebuild reproducibility is made.

Requirements: glibc>=2.39, libstdc++/libgcc, Vulkan1.2 loader and driver supporting
its required features (including drawIndirectFirstInstance), GNU-compatible cpp,
native X11/Wayland window libraries, libudev and OpenAL/audio dependencies.
OpenGL/EGL compatibility is for the separate reference host, not this Vulkan run.
Wrappers select the bundled libshaderc using a relocatable LD_LIBRARY_PATH.

Native Minecraft26.3 uses your owned assets/extracted version data and an external
vanilla26.3 server. The release launcher contract consumes the supplied launch-token
file; use your launcher normally, or a unique existing temporary launch file for
an authorized local test. Example with your paths and server:
  ./run-native.sh --launch-token /path/to/temporary-launch-file --version 26.3 \
    --username NativeCompute --assets-dir /path/to/assets --versions-dir /path/to/versions \
    --game-dir /path/to/game --quick-access-multiplayer 127.0.0.1:25577 \
    --renderer-path shared --shader-pack /path/to/photon --shader-profile low \
    --shader-width 640 --shader-height 360
Add --shader-frames 120 --shader-output /path/to/capture for bounded diagnostics.
Ordinary play omits --shader-frames. F6 reloads; F7 cycles --shader-alternate-pack.

Standalone original-pack Vulkan graph (headless; not Minecraft gameplay FPS):
  ./run-vulkan.sh --pack /path/to/photon --profile low --minecraft-version 26.3 \
    --render --warmup 8 --frames 120 --width 640 --height 360 \
    --atlas /path/to/your-fixture-atlas.png --output /path/to/graph-output
Use --scenario state-changes to exercise history invalidation. Without --atlas,
the standalone fixture uses explicit diagnostic flat tiles, not game textures.
The standalone no-render path compiles/inspects the pack without rendering.

These Vulkan examples retain Photon's default SH_SKYLIGHT enabled: there is no
SH_SKYLIGHT=false override. This checkpoint implements a bounded fixed-dispatch,
image2D compute/storage path; unsupported forms/profiles remain explicit errors.
Consult the exact source's pomme-shaderpack/IMPLEMENTATION.md and included evidence
for supported programs, settings and limits. The optional GL host remains separate.
Full Iris parity, other actor kinds/weather/particles and broader pack compatibility
are not qualified. GPU data in evidence identifies its actual software driver.
GTX1650Ti performance, 60FPS and total gameplay FPS are unverified.

Photon, Mojang/Minecraft JARs/assets, Java server and all private Voxy/Avvai sources
are unbundled. Obtain external packs/assets under their own terms. Project source
includes the preserved browser checkpoint and its licensed upstream source.
manifest.json hashes every supplied binary, source archive, notice and evidence
file. Package provenance records the measured source head separately from any
later evidence-publication commit. Evidence is copied unchanged; older revisions,
if supplied, remain explicitly identified in its revision inventory.
