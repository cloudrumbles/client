# Native Vulkan rendering goal

## Goal and platform

Build on Pomme's existing native Rust/Vulkan Minecraft client to deliver
actual, replaceable Photon shader-pack rendering, with **60 FPS on an NVIDIA
GeForce GTX 1650 Ti as an unverified target**. Native Rust is the required
direction. The existing gameplay renderer uses Vulkan; the new compatibility
validation host uses OpenGL to execute original pack GLSL directly. The final
renderer direction remains native Rust/Vulkan; the optional GL viewport is a
compatibility/reference harness, not an architectural replacement. Browser delivery,
WASM and WebGPU are no longer requirements. This is a private project; source
adaptations should retain their exact upstream revision and attribution.

The relevant projects are [Photon](https://github.com/sixthsurge/photon),
[Sodium](https://github.com/CaffeineMC/sodium),
[Iris](https://github.com/IrisShaders/Iris),
[Voxy](https://github.com/MCRcortex/voxy) and
[Nvidium](https://github.com/MCRcortex/nvidium). The intended result combines
shaderpack support, efficient section meshing and lighting, persistent distant
terrain, and GPU-driven rendering in the native client. Use the latest upstream
Sodium when implementation resumes and record the exact revision used.

## What this checkpoint contains

The `pomme-web` implementation preserves the earlier browser work: a Rust/WASM
world and inventory authority, Java protocol gateway, resource-pack and Anvil
imports, retained WebGPU terrain/shadow buffers, temporal lighting, distant
terrain, per-pass profiling, native item persistence and source-derived entity
and environment behavior. The new terrain worker uses a pinned Pumpkin
1.21.11 biome/noise/surface generator with a reproducible source archive,
patch and compiled WASM. Decoration, carvers and full structures are unfinished.

Recent changes add bounded, exact recurring-sun irradiance caching in RAM and
IndexedDB, soft directional shadows, zero-contribution shadow sampling guards,
versioned fog and status effects, additional entity models, and atomic local
item drop/pickup saves. A Rust mesher sampling cache adapts Sodium's
`ArrayLightDataCache` from commit
`8aa723c69af6ce40255862df6c3bf8c6cca9d883`, the latest revision checked for this
checkpoint. Its original source and notices are in
`pomme-web/core/third_party/sodium`.

These changes are browser research and implementation. They do not modify the
native Vulkan renderer, execute the original Photon shaderpack, load the Java
performance mods, or establish complete Minecraft or Photon image parity.
Software WebGPU checks establish bounded correctness; **the 1650 Ti / 60 FPS
target has not been measured**. A distinct native branch now adds original-pack execution in
[pomme-shaderpack](pomme-shaderpack/README.md) and Vulkan indirect-feature fixes.
The pack runtime renders fixtures and a second live-world viewport using the
existing client lifecycle. Minecraft 26.3 is the primary end-to-end target;
1.21.11 remains an older-version regression. Actors/UI remain in the Vulkan
window, and full playable shader integration remains unfinished.
See its [status and limits](pomme-shaderpack/IMPLEMENTATION.md).

## Native implementation plan

1. **Measure the existing Vulkan client.** Record the physical device, driver,
   extensions, enabled features, VRAM usage and GPU timestamp measurements for
   culling, terrain, shadows and postprocessing. Query and enable the required
   indirect-draw features rather than assuming they exist. Keep a working
   fallback when an optional feature is unavailable.
2. **Port useful Sodium and Nvidium techniques.** Adapt the latest Sodium
   neighborhood sampling and meshing lifecycle to native section snapshots.
   Preserve the existing compact terrain vertices, GPU visibility compaction and
   indirect drawing. Investigate task/mesh shaders, hierarchical GPU culling,
   buffer device addresses, descriptor indexing and synchronization improvements
   against the actual 1650 Ti driver. Enable a path only after capability checks
   and timing show a benefit; newer Vulkan features do not all exist on this GPU.
3. **Provide actual shaderpack infrastructure.** The native renderer currently
   uses forward rendering and build-time GLSL-to-SPIR-V compilation. Photon needs
   an Iris-compatible preprocessing/uniform interface, explicit Vulkan bindings,
   HDR and multiple render targets, depth and shadow inputs, ordered
   prepare/deferred/composite/final passes, temporal histories, image formats,
   custom textures and correct coordinate conventions. Preserve real block and
   sky light, AO, normals, material IDs and any required tangent data in the
   terrain interface. Validate the selected original Photon revision against
   reference scenes before describing it as compatible.
4. **Integrate persistent distant terrain.** Use Voxy's data and LOD ideas for
   a bounded native cache and renderer. Define section revisions, streaming,
   persistence, dimension boundaries, visibility, edit invalidation and the
   transition between full geometry and distant terrain. Benchmark memory,
   upload and culling costs with the selected shaderpack.
5. **Reuse predictable lighting.** Cache static geometry, shader pipelines,
   atmosphere/LUT data, unchanged shadow regions and reusable world-space
   lighting. Quantized periodic sunlight can reuse earlier results when the
   caster geometry, materials, world and light direction still match. Moving
   cameras and actors, block edits, weather and screen-space effects require
   their own updates. Time commands select the corresponding cache key rather
   than treating elapsed wall time as validity.
6. **Qualify on the target laptop.** Optimize the slowest measured passes and
   keep correctness controls beside each optimization. Record the Minecraft
   version/world, Photon revision and preset, resolution and render scale, render
   distance, driver, power mode and laptop thermal state. Compare warm and cold
   traversal, edits, weather and time jumps. Publish raw frame intervals and GPU
   timings with the final benchmark report.

## Cache and performance acceptance

At 60 FPS the frame budget is approximately **16.67 ms**. A passing result must
come from the physical GTX 1650 Ti with the workload and visual settings recorded,
including average FPS and frame-time percentiles. A provisional benchmark should
start at 1920×1080; the final render distance and Photon preset remain to be
specified and measured. Software-adapter timings cannot qualify this target.

Disk caching must beat the complete alternative: read, decompression and GPU
upload/restore versus recomputation. A repeating sun path makes cache keys
predictable, but does not guarantee a disk speedup. The browser irradiance cache
is bounded to 32 MiB in RAM and 64 MiB on disk with invalidation and exact half-bit
checks. Shadow-map storage remains an experiment outside the production renderer:
in the software-adapter diagnostic, reading and restoring compressed depth cost
more than rendering the shadow map. Measure both paths on the target machine
before adopting a native disk cache.

## Checkpoint and remaining validation

The submitted PR records the checks run on this checkpoint. Detailed current
browser scope remains in [PARITY.md](pomme-web/PARITY.md), lighting/cache behavior
in [LIGHTING.md](pomme-web/LIGHTING.md), and source/effect boundaries in the
[Photon effect audit](pomme-web/docs/photon-effect-audit.md).

Native Photon compatibility, native Voxy integration, optional Vulkan mesh/task
paths, target GPU profiling and 60 FPS qualification remain future work.
Development is paused after committing and submitting this checkpoint, as
requested.
