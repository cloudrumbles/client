# Cow, Chest and held-item pack geometry slice

The shared renderer lowers real native Cow (adult/baby and loaded texture variants),
Chest and supported held-item assets into replaceable pack stages. Legacy retains
the previous forward rendering comparison. Other mobs, item entities, block entity
kinds, empty-hand skin, particles and weather remain explicit gaps and native
forward draws. This is a narrow material lowering slice, not complete actor parity.

`pomme-shaderpack::geometry` separates immutable `Arc` meshes/textures/materials
from per-frame part transforms, anchor, block/sky nibbles, tint and overlay. Native
baking, Cow animation, Chest facing/lid easing and item display/swing/eat/bob
functions are reused. Actual normals, UV-derived tangents/handedness and mid-UVs
are retained. The adapter translates native overlay retention alpha into Iris's
blend coefficient. Model reflections adjust tangent handedness in the GPU ABI.
The renderer reads published chunk light data; unknown light or missing real
textures/checkerboard sprites create reported gaps instead of fabricated inputs.

Meshes and textures upload once per asset lease. GPU caches retain their source
Arcs, preventing pointer reuse or stale UV/texture identity. Rebuilt atlas/item
assets obtain new identities. Caches are bounded to 512 mesh/texture assets per
pack engine, with explicit capacity errors; per-frame part draws are bounded to
4096. Uniform storage grows only for a fence-completed frame slot and is then
reused. Poses and lighting use dynamic per-draw offsets, so multiple animated
parts do not overwrite the uniforms of earlier recorded draws. Terrain's existing
whole-scene flatten/reupload/device-idle path is separate, unchanged performance
debt.

The complete Iris `ProgramId` fallback parent table is adapted under LGPL-3.0-only
in `stages.rs`, with exact upstream revision, corresponding source and notice in
`third_party/iris`. Vitrail's mapped fallback table was cross-checked. No Java
translator or AGPL dependency is bundled. Only the implemented dispatch subset
runs: shadow terrain, shadow entities/block, terrain, opaque entities/block/hand,
deferred, water/translucent entities/block/hand, composite/final. Resolved source
names control pack directives; requested names retain category identity. Active
unsupported resources/inputs still fail explicitly.

World draws use the frozen camera and native anchor-relative poses; hands retain
a separate HUD-FOV projection and Iris's `MC_HAND_DEPTH=0.125` compression.
`depthtex2` records opaque world before hand; `depthtex1` includes opaque hand before
translucents; `depthtex0` retains complete pack geometry. Hand geometry never casts
world shadows. `shadowEntities`/`shadowBlockEntities` control Cow/Chest shadow
submissions. Successful lowering alone suppresses those inputs in the later
forward passes. HUD/menu and inventory preview remain outside world postprocessing.

Pack entity/item IDs come from selected `entity.properties`/`item.properties`;
Chest IDs use the actual block-state descriptor and `block.properties` predicates.
Unmapped entity/item names retain Iris's -1 ID. The current host still does not
advertise `IS_IRIS`; packs may restrict use of `currentRenderedItemId` to that
branch (Photon does). Full Iris host capability/uniform semantics, PBR maps,
animated atlas parity and all remaining geometry categories are follow-up work.
Base Photon sky compute and Ultra storage remain rejected, rather than omitted.
Live checks use explicit `SH_SKYLIGHT=false`, and optional explicit actor-shadow
settings, recorded in evidence.

Capture evidence contains per-stage requested/resolved names, draw/vertex counts,
material IDs, CPU snapshot/lowering/pack preparation costs and mesh/texture upload
bytes. These are pass and preparation measurements, not gameplay FPS. Ordinary
play constructs/retains no capture JSON. `--shader-frames N` (1–10,000) captures
exactly N submitted frames; prepared samples become query-readable only after
successful queue submission and fence completion. Out-of-date acquisition cancels
unsubmitted state. Files are finalized once at the bound, and retained data is
released. Closing early does not finalize an incomplete capture.

## Reproduce

```sh
cargo test --locked --no-default-features -p pomme-client -p pomme-shaderpack \
  --features pomme-client/shader-packs
cargo clippy --locked --no-default-features -p pomme-client -p pomme-shaderpack \
  --features pomme-client/shader-packs --all-targets -- -D warnings
cargo test --locked -p pomme-shaderpack --features vulkan --test actor_vulkan \
  -- --ignored --nocapture
cargo build --release --locked --no-default-features -p pomme-client --features shader-packs
```

The Vulkan fixture requires a driver; enable the Khronos validation layer and
check its log for zero validation errors. It asserts actual texture/light/normal/
material rasterization through fallback stages, cutout coverage, actor shadows,
hand shadow exclusion, distinct world/hand depth snapshots, and zero repeated
asset upload bytes. The ordinary suite leaves GPU and installed-assets tests
ignored. Real game-assets test command:

```sh
POMME_ACTOR_ASSETS=/path/to/versions/26.3/extracted/assets \
  cargo test --no-default-features -p pomme-client --features shader-packs \
  official_cow_and_chest_textures_lower_exact_decoded_rgba -- --ignored
```

Launch through the existing native launcher/auth contract and game assets. Add
`--renderer-path shared --shader-pack /path/to/photon --shader-profile low
--shader-option SH_SKYLIGHT=false --shader-option ENTITY_SHADOWS=true
--shader-option BLOCK_ENTITY_SHADOWS=true --shader-frames 120
--shader-output /path/to/evidence`. Compare `--renderer-path legacy` with identical
pack settings and scene. Software-driver evidence does not qualify GTX 1650 Ti,
1080p/60 FPS, full default presets or Iris pixel parity. Live validation results
are reported with the review checkpoint rather than inferred from shader compilation.
