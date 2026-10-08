# Shared scene renderer checkpoint (contract v2)

Contract v2 adds the narrow Cow/Chest/held-item pack geometry slice described in
[ACTOR_PACK_STAGES.md](ACTOR_PACK_STAGES.md). The immutable input checkpoint below
remains its foundation. Successful actor inputs now carry retained native assets
and per-frame poses into the pack graph; other categories remain native forward.

This is the first vertical slice of the parent-owned incremental replacement plan.
`--renderer-path shared` (default) freezes native camera, sky/time/weather, near
terrain draw references, entity/item/block-entity inputs, particles and hand poses
before recording. These inputs drive the existing Vulkan pipelines. Networking,
world storage, assets, inventory, model baking and GPU allocation stay in their
existing owners. `--renderer-path legacy` retains immediate inputs and the previous
camera/pack update order for comparisons. The shared path refreshes the far plane
before both backends capture their camera.

`renderer/scene.rs` owns the typed contract and its version. Published frames are
`Arc<SceneSnapshot>`. Every category has an explicit material domain. Near indexed
terrain records solid, cutout and water ranges independently; actor draw inputs
retain their native model/texture identity and per-primitive coverage choices.
An item entity is an entity geometry input with an item material domain. Distant
terrain is explicitly empty here. It will be populated by actual Voxy geometry in
Milestone 3, rather than treating a resident near mesh as far LOD.

The snapshot includes monotonic frame serial and world, terrain, atlas, model and
surface epochs. Recording rejects stale resource epochs before GPU work. Near
terrain topology is retained until uploads/unloads change its epoch. GPU slices
remain owned by `ChunkBufferStore`, retired under its existing in-flight fences.
CPU snapshots do not own a second Vulkan device and cannot submit stale GPU ranges.
Scene capture and submission are synchronous in this slice; asynchronous mesh and
upload scheduling belongs to Milestone 4.

The pack adapter retains immutable `WorldSnapshot` references to accepted section
payloads, material names, atlas bytes, dimension and frame environment. Sections
and unchanged material tables share allocations. Replacing or unloading a section,
changing a material or clearing a dimension cannot mutate an older retained frame.
The Vulkan adapter now consumes this captured input outside the live-world mutex.
Its JSON evidence includes scene versions, category input counts, camera clip
planes, depth convention and pack section/world generations. Counts are inputs,
not visible primitives or measured draw counts.

The authoritative native camera is right handed, anchor relative, with Vulkan Y
and forward depth in [0,1], cleared to 1. All world forward draws, frustum tests,
weather/particle billboards and first-person camera effects read the same frozen
Camera. The pack derives its legacy GL matrices from that Camera and translates
clip depth at its existing ABI boundary. Hands retain their existing separate
projection/depth-clear behavior; they do not redefine the world camera. HUD/menu
and inventory previews draw afterwards under their existing UI cameras.

This does **not** complete unified material/mesh lowering or Milestone 2. Cow,
Chest and supported held-item meshes have a pack path; remaining actor kinds,
empty-hand skin, particles and weather execute their native forward pipelines. Distant geometry is not yet connected. Shader
compute/storage support and Iris image parity remain open. Iris geometry fallback
relationships are now ported with their license/notice; the dispatch subset remains
limited to implemented geometry categories.
The live Photon check uses the existing explicit `SH_SKYLIGHT=false` restriction;
it is not the complete preset requested for Milestone 2. Neither backend's
software-adapter timings qualify the GTX 1650 Ti / 60 FPS target.

## Reuse assessment, before changing the translator

Canonical sources inspected on 2026-10-08:

- Vitrail: `https://github.com/avpbynf/vitrail-shaders`,
  `f42e5489c6abff655781b40bebc70338bada3039`, LGPL-3.0-only (`LICENSE`,
  `GPL-3.0.txt`, per-file Iris/Kroppeb attribution in `NOTICE`).
- Iris: `https://github.com/IrisShaders/Iris`, default `26.1` branch,
  `bff1e69cb6c5519d8745784aa9c8b92984de67e7`, LGPL-3.0 (`LICENSE`);
  `LICENSE-DEPENDENCIES` separately identifies glsl-transformer's AGPLv3.

These are Java host integrations, not callable Rust libraries. Vitrail's renderer
uses Mojang `GpuDevice`/`CommandEncoder`, Java mixins, LWJGL and VMA; Iris's renderer
uses Minecraft integration and OpenGL. The following exact source map records
candidate contracts/components for the parent's next review. The initial contract-v1 checkpoint copied no implementation. Contract v2 ports
Iris ProgramId fallback data into `pomme-shaderpack/src/stages.rs`, with its
LGPL-3.0-only license and notice in `pomme-shaderpack/third_party/iris`. Any later
port must record the source files, changes and corresponding notices; a Java
transformer dependency is not silently relabeled as LGPL.

| Native responsibility | Pinned Vitrail source (`common/src/main/java/dev/vitrail/`) | Pinned Iris source (`common/src/main/java/net/irisshaders/iris/`) | Assessment |
|---|---|---|---|
| Geometry/stage identities and actor dispatch | `pack/model/RenderStage.java`, `render/EntityDraw.java`, `render/BlockEntityGeometry.java`, `render/HandDraw.java`, `render/ParticleProgram.java` | `pipeline/WorldRenderingPhase.java`, `pipeline/programs/ShaderKey.java`, `pathways/HandRenderer.java` | Stage ordinals are a pack ABI; native category IDs must not be passed as those ordinals. Native actor snapshots preserve current draw data, but no pack-stage lowering is implemented yet. |
| Missing-stage inheritance | `pack/model/ProgramFallbacks.java` | `shaderpack/loading/ProgramId.java` | Portable source table, with existing Vitrail attribution to Iris. Current native hard stage list is incomplete. |
| Legacy GLSL to Vulkan | `glsl/ProgramTranslator.java`, `glsl/LegacyGlsl.java`, `glsl/VertexInputs.java`, `glsl/VaryingSplit.java`, `glsl/SharedMemory.java` | `pipeline/transform/transformer/VanillaTransformer.java` | Vitrail translates linked stages together, including common uniform/varying interfaces. Token/compiler modules can be evaluated separately from game hooks; they have not been ported or executed here. |
| World vs per-draw view/projection | `uniform/ViewSource.java`, `uniform/ClipSpace.java`, `render/ViewMatrices.java` | `pipeline/transform/transformer/VanillaTransformer.java`, `pathways/HandRenderer.java` | World reprojection matrices and hand/pass matrices are distinct. Vitrail's source backend is **reversed** Vulkan Z: its `w-2z` conversion cannot be copied into this client's forward-Z backend. |
| Compute ordering and storage | `render/PackCompute.java`, `render/storage/StorageImages.java`, `render/storage/StorageBuffers.java`, `render/storage/GpuRecording.java` | `pipeline/CompositeRenderer.java`, `gl/program/ComputeProgram.java`, `gl/buffer/ShaderStorageBufferHolder.java` | Chained computes run before their fullscreen stage, with storage/image/texture barriers. Vitrail's documented deferred-shadow scheduling and allocation limits are divergences to verify, not native acceptance evidence. |
| Formats, target flips and sampler aliases | `pack/model/TargetFormat.java`, `pack/target/TargetSchedule.java`, `pack/target/SamplerPlan.java` | `gl/texture/InternalTextureFormat.java`, `targets/BufferFlipper.java`, `samplers/IrisSamplers.java` | Portable contracts to compare against the existing runtime. No new format/alias/flip behavior is claimed here. |

Photon's pinned `program/d4a_generate_sky_sh.csh` declares a 256-thread workgroup
and a shared `vec3[256][9]` array. Whether its compiled shared-memory layout fits
an exact device, and whether Vitrail's MoltenVK-only `SharedMemory` rewrite applies with
its required single-workgroup dispatch and storage-barrier semantics,
remain Milestone 2 investigations. Skipping that compute is not full Photon
compatibility. File hashes and permanent source links are recorded in
`renderer-source-map.json`. Vitrail README claims and source comments are reuse evidence, not
validation of this Rust client.

## Reproduce this slice

```sh
cargo test --locked --no-default-features -p pomme-client -p pomme-shaderpack \
  --features pomme-client/shader-packs
cargo clippy --locked --no-default-features -p pomme-client -p pomme-shaderpack \
  --features pomme-client/shader-packs --all-targets -- -D warnings
cargo build --release --locked --no-default-features -p pomme-client \
  --features shader-packs
```

Use the existing launcher/data/auth arguments from the native build instructions,
adding `--renderer-path shared` or `--renderer-path legacy`. With a pack, use
`--shader-frames` and `--shader-output` for immutable scene evidence. This is a
review checkpoint on `native/shared-scene-contract`; public PR 2 and the private
Voxy worktree are preserved independently.
