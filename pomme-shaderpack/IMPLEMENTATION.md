# Native rendering implementation status

## Implemented and exercised

- Original GLSL driver compilation/linking and ordered prepare, shadow, terrain,
  deferred, water, composite and final execution. Compute entry points with
  explicit `workGroups` and 2D color image bindings have a preliminary host path;
  Photon's skylight compute path failed the available software driver's limit.
- Directory/ZIP inputs, deterministic SHA-256 over all source/resource files,
  dimension fallback, recursive includes, profile inheritance, explicit option
  overrides and custom uniform/variable expressions with vectors and smoothing.
- HDR MRT color buffers, depth/shadow inputs, flip/ping-pong histories, mipmaps,
  pack custom PNG/3D raw textures, texture metadata and per-attachment blend state.
- Static fixture vertex buffers reused across frames, cached uniform/attribute
  reflection, cached option regular expressions, explicit geometry replacement.
- Current/previous camera transforms and conservative temporal invalidation for
  camera cuts, world/light/material revisions, time/day commands, rain/wetness
  changes and pack reload. Shadows are rendered each frame; no unmeasured shadow
  cache is enabled.
- Material IDs read from the selected pack's `block.properties` for exact fixture
  block names, rather than Photon-specific host IDs.
- Native window controls/presentation and surfaceless EGL screenshot/measurement
  mode; software window smoke check presented eight frames through Xvfb.
- Existing Vulkan renderer now queries/enables indirect features explicitly and
  falls back to bounded fixed indirect draws when count/multi-draw is unavailable.

## Compatibility and integration limits

This is a partial pack host. It does not provide full OptiFine/Iris parity:
custom images/SSBOs, uniform arrays, geometry shaders, arbitrary compute workgroup
expressions, all shader stages/fallback rules, block-state predicates/tags/modded
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

Full game integration needs a world/render adapter to retain separate sky and
block light, block states, normals, tangents and material metadata in native meshing;
the existing 16-byte packed Vulkan vertices have already combined some inputs.
It also needs application/window lifecycle integration, resource-pack rebuilds,
dimension-aware uniforms, actors/transparent sorting/UI, resize handling and shader
selection/reload controls. Reuse the current protocol, chunk lifecycle, physics,
assets and SteelMC integration. Do not replace them with a second implementation.

The direct OpenGL path establishes pack execution using its original legacy GLSL
ABI. The Vulkan gameplay renderer continues separately. A Vulkan shader backend
would additionally require binding/matrix ABI translation and synchronization;
compiling GLSL to SPIR-V alone does not implement these contracts. No Vulkan/GL
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
