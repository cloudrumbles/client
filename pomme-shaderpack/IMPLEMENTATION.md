# Native rendering implementation status

## Vulkan game-window milestone

The `shader-packs` feature now uses the existing gameplay Vulkan device by
default. Original Photon GLSL is preprocessed, transformed to GLSL 450 explicit
stage/resource interfaces and compiled to Vulkan 1.2 SPIR-V. The backend executes
prepare, shadow, terrain, deferred, water, composite and final programs on GPU
images, with std140 uniform encoding, optimized active-input reflection,
descriptor sets, HDR MRT, depth copies, flip histories, custom PNG/raw 3D textures,
per-attachment blends, mipmaps, barriers and timestamp queries. A GPU compositor
presents the pack's display-encoded color with the correct SRGB conversion and
writes its scene depth into the main game render pass. It uses no GL window or
CPU pixel transfer. F6 reload/F7 selection rebuild the selected original pack.

Actual Photon low-profile graph execution has passed Vulkan validation on Mesa
llvmpipe, followed by a 40-frame vanilla 26.3 world run with 81 loaded columns,
entities, inventory and frozen server time. CPU material resolution was moved
from every vertex to each palette entry after the first live upload stalled.
Validation also exposed and repaired an existing item push-constant stage-mask
mismatch. These are software checks, not physical GTX 1650 Ti measurements.

Geometry stages now include the narrow Cow/Chest/held-item native asset path
on the shared renderer, using the licensed Iris fallback table and per-draw
light/material/pose uniforms. Pack settings govern Cow/Chest shadows; first-person
hands do not cast world shadows. Other actors, empty-hand skin, weather geometry,
particles and UI remain forward. This is not complete actor or Iris parity.
See `pomme-client/ACTOR_PACK_STAGES.md` for exact coverage and checks. The native
Vulkan graph now executes original explicit-dispatch compute programs, including
Photon's default sky-light compute, through shared typed uniforms, samplers and
formatted 2D color-image bindings. Associated computes precede fragments;
standalone slots remain present. Storage aliases preserve the current color-buffer
front and synchronize writes before subsequent compute and graphics reads.
Generic array-varying locations carry the original sky-light coefficients to
their graphics consumer. Dispatch records and raw diagnostic readback accompany
normal timestamp measurements.

Custom images/SSBOs, graphics storage writes, geometry shaders, optional shader
capabilities, all host uniforms/stage fallbacks, animated atlas parity and Iris
visual parity remain open. Unsupported active resources fail explicitly. Packed HDR can
use a wider RGBA16F target if the device cannot filter/blit that packed format;
the substitution is reported. No shader effect is rewritten for Photon.

Voxy-style persistent distant terrain is an explicit acceptance requirement.
Current Voxy `dev` was inspected at `534d58ec8b4aa412ef314b884295552c69d480a6`;
its notice says "All rights reserved. Do not redistribute." The public client
checkout contains no Voxy source/port. A separate local port assessment preserves
that notice and compares its voxel reduction to the original Java implementation;
10,000 randomized reductions match. This is not LOD rendering or persistent
streaming. A distributable Voxy port needs permitted source/authorization; the
requested distant terrain remains unfinished. Unreceived multiplayer terrain
must remain unknown.

## OpenGL reference host, implemented and exercised

- Original GLSL driver compilation/linking and ordered prepare, shadow, terrain,
  deferred, water, composite and final execution. Compute entry points with
  explicit `workGroups` and 2D color image bindings have a preliminary host path;
  Photon's skylight compute path failed the available software driver's limit.
- Directory/ZIP inputs, deterministic SHA-256 over all source/resource files,
  dimension fallback, recursive includes, profile inheritance, explicit option
  overrides and custom uniform/variable expressions with vectors and smoothing.
- HDR MRT color buffers, depth/shadow inputs, flip/ping-pong histories, mipmaps,
  pack custom PNG/3D raw textures, texture metadata and per-attachment blend state.
- Static/live vertex buffers reused across frames, cached uniform/attribute
  reflection, cached option regular expressions, explicit geometry replacement.
- Current/previous camera transforms and conservative temporal invalidation for
  camera cuts, world/light/material revisions, time/day commands, rain/wetness
  changes and pack reload. Shadows are rendered each frame; no unmeasured shadow
  cache is enabled.
- Material IDs read from the selected pack's `block.properties` for actual block names and property predicates, rather than Photon-specific host IDs.
- Native window controls/presentation and surfaceless EGL screenshot/measurement
  mode; software window smoke checks and a live 1.21.11 server-world check presented
  40 frames through Xvfb.
- Existing Vulkan renderer now queries/enables indirect features explicitly and
  falls back to bounded fixed indirect draws when count/multi-draw is unavailable.

## Compatibility and integration limits

This is a partial pack host. It does not provide full OptiFine/Iris parity:
custom images/SSBOs, geometry shaders, arbitrary compute workgroup
expressions, all shader stages/fallback rules, block tags/modded
registries and Minecraft-named custom texture resources remain unsupported.
Unimplemented programs outside the host stage list are not executed. Unknown active
uniforms/resource types and malformed enabled conditions fail rather than receive
placeholder values. Includes are expanded before conditional preprocessing, so an
inactive include must still exist. Buffer declarations are read from pack source;
conditional conflicting declarations need a more complete directive resolver.

Fixture host inputs use a plains environment, simplified sky/block-light and eye
state, a fixed projection and four texture tiles. Water is a raised fixture pool,
with internal faces and a still texture. These are ABI/visual checks, not reference
Minecraft-world images. No entity, particle, held-item, weather geometry, game HUD,
menu or inventory is submitted to this renderer. Reference Iris screenshots have
not been compared. Visual inspection confirms rendered clouds, terrain, shadows
and different time states but does not certify their physical or pixel accuracy.

The new adapter uses the existing meshing/chunk lifecycle and event loop. It
preserves separate sky/block light, block states, normals, tangents, mid-UV and
material metadata alongside the existing compact Vulkan vertices. It tracks
section upload epochs (including empty-section tombstones), unloads, world clears
and atlas rebuilds. Camera, FOV, third-person offset, underwater state, sky time,
rain, eye light and biome temperature/downfall come from the actual game. Selected
Minecraft version is passed to pack preprocessing. Vanilla dimension transitions
reload the matching program set. The optional GL reference viewport follows the Vulkan game's
inputs. The default pack path now executes inside the main Vulkan window. Actors, transparent sorting,
animated atlas updates, held items, biome ID/category parity, overlays/UI and resize
handling remain work. Pack R reload and P switching preserve the active pack on
failure. No Photon-specific effects or material IDs are baked into this adapter.

Minecraft 26.3 (protocol 777) is the primary integration target. This repository
already has embedded 26.3 protocol/registry tables and a joinable translator to
its pinned Azalea 26.2 / protocol 776 layout, with known passenger-teleport and
new-component/parser limitations documented in `net/translate.rs`. Current
upstream Azalea revision `8041a14706fbdb2b8c481d2e8960d7411e850796` directly
reports 26.3 / 777, and Pumpkin revision
`5ede4c217f4f74499cf52a748eac65d9437f2eaf` defines 26.3 / 777. Those observations
are source capability evidence, not tests of every upstream gameplay feature.
The pinned backend remains in place to preserve this client's existing translation
and tests. Official vanilla 26.3 is used for end-to-end validation, with Java 25.
The saved Pumpkin browser generator and SteelMC integration are preserved.

The direct OpenGL path establishes pack execution using its original legacy GLSL
ABI. The Vulkan backend above adds binding/matrix ABI translation, real image/pass
execution and synchronization; compiling GLSL to SPIR-V alone would not implement
these contracts. No Vulkan/GL
CPU-readback bridge was added because it would create an unqualified performance
bottleneck before the world inputs are complete.

## Capability and optimization decisions

[NVIDIA's Vulkan driver documentation](https://developer.nvidia.com/vulkan-driver/)
lists the GTX 1650 Ti notebook GPU in its Turing support set. Device model support
is not proof that a particular driver enables each feature. The Vulkan fix queries
`drawIndirectFirstInstance`, `multiDrawIndirect`, `drawIndirectCount` and
`maxDrawIndirectCount`; core Vulkan 1.2 and first-instance support are required by
the existing section renderer. Count/multi-draw have actual bounded alternatives.
See the [Vulkan feature contracts](https://docs.vulkan.org/refpages/latest/refpages/source/VkPhysicalDeviceFeatures.html).

[Nvidium's actual capability check](https://github.com/MCRcortex/nvidium/blob/f2028b2ba9a5dc95d69e73a9eaeadcb447367d7d/src/main/java/me/cortex/nvidium/Nvidium.java)
requires all six of `GL_NV_mesh_shader`,
`GL_NV_uniform_buffer_unified_memory`, `GL_NV_vertex_buffer_unified_memory`,
`GL_NV_representative_fragment_test`, `GL_ARB_sparse_buffer` and
`GL_NV_bindless_multi_draw_indirect`; it also disables persistent sparse addressable
buffers on Linux. The benchmark reports missing extensions, but this host does not
use Nvidium's rendering algorithm or require those extensions. Its ordinary VBO
OpenGL path is the implemented alternative. No mesh-shader support or speedup is
inferred solely from Turing's name.

On llvmpipe, Photon `deferred1` (clouds) was the largest measured GPU pass in the
checked-in software runs. That observation only prioritizes investigation; it says
nothing about the 1650 Ti's ordering. The comparison presets control resolution,
shadow resolution and pack settings. The implementation caches static vertices
and reflection/preprocessing work where inputs are stable. More culling, batching,
LUT/lighting reuse, persistent LOD, disk caches and indirect/mesh rendering must be
selected from target-hardware profiles and correctness comparisons. Full-frame
ping-pong copies currently preserve discarded/partial writes and are a profiling
candidate; they cannot be dropped indiscriminately.

## Source references

This branch preserves the browser checkpoint and its existing notices. No Photon,
Iris, Nvidium, Voxy or new Sodium implementation source is bundled in this runtime.
The selected Photon input is [sixthsurge/photon](https://github.com/sixthsurge/photon)
revision `15458c0937f8647c37eb6a501bef5eb3bf3da31b`; pack options/textures/programs
remain external. Host contracts were checked against the
[Iris shader documentation](https://shaders.properties/current/reference/shadersproperties/custom_uniforms/)
and original pack directives. Keep the pack's existing notices when distributing
its source; the executable archive contains only this project's runtime and notices.

The existing native networking uses canonical
[azalea-rs/azalea](https://github.com/azalea-rs/azalea), locked to revision
`ffedf17c9b6ff9fbafbf7e0d14c8d2366b2d0a32` in Cargo.lock. The existing browser generator uses canonical
[Pumpkin-MC/Pumpkin](https://github.com/Pumpkin-MC/Pumpkin) with its saved source,
patch and MIT notice. No duplicate protocol/world generator was introduced.
The retained browser Sodium attribution is at revision
`8aa723c69af6ce40255862df6c3bf8c6cca9d883`; no new native port is claimed.
