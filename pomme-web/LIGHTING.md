# Reuse work that has not changed

Minecraft terrain usually changes slowly. Predictable sun motion lets the engine
schedule lighting updates. The camera still changes visibility, reflection rays
and projected pixels, while water, clouds, weather and entities can move
independently. The client caches intermediate world/light results and reconstructs
the camera image from them.

## Implemented cache boundaries

| Result | Reuse | Invalidation |
| --- | --- | --- |
| Full native sections | Sparse WASM near window; compressed IndexedDB imports | Actual edits, server chunks/unloads or world identity |
| Terrain surface geometry | Worker mesh and retained GPU buffers | Changed section/block and boundary/AO neighbours |
| Vertex ambient occlusion | Computed during meshing | Nearby geometry changes |
| Native sky/block light | Packed per-section arrays | Authoritative server light packets or local edit propagation |
| Local propagated light | Background 3×3-column solves; bounded cache | Source/opacity/emission revisions |
| Distant terrain | Persisted 4/8/16m cells and retained regional meshes | Actual source columns/edits, near coverage or LOD selection |
| Static directional shadows | Retained terrain depth | Sun-angle bucket, geometry inside the light frustum, coverage region, quality or atlas |
| Dynamic shadows | Static depth copied; only entity casters drawn, at most 30 Hz | Dynamic geometry/light coverage; removal restores static depth |
| Sky/cloud environment | Retained HDR direction map sampled by sky/water | Sun bucket, cloud-wind bucket, camera region or quality |
| Animated texture pixels | Predecoded native frame sequences | Their `.mcmeta` clock advances to a different frame |
| Temporal HDR history | Reprojected previous samples at output resolution | Depth mismatch/disocclusion, edits, cuts, lighting jumps, world/atlas/resolution changes |
| Visible HDR color/depth and reflection rays | Scaled rasterization with temporal accumulation | Current camera frame |

## Terrain and sunlight

The sun updates cached shadow depth at quantized angles. Direct shading uses the
current direction, so this is an approximation with small shadow-motion steps.
Terrain edits invalidate shadows when replacement geometry reaches the renderer.
Uploads and removals outside the cached light frustum preserve the shadow map.
Camera rotation reuses the depth map; moving outside its coverage triggers a new
map. The cache tracks actual geometry/light state rather than a fixed day/night
texture reused after the world changes.

Balanced clouds update the environment at one-second wind intervals, High at
half-second intervals. High integrates six cloud-density slices during these
cache updates. Camera turns sample the same environment. Low omits clouds.
Entity animation leaves static terrain depth intact; its separate combined depth
layer is refreshed with bounded dynamic draws. Transparent glass does not become
an opaque shadow caster.

The native server provides per-section sky/block light. Local imported-world
edits use a separate worker that propagates emission and attenuated sky light
through known neighboring columns. Unknown columns block propagation. Jobs are
debounced, have a bounded source halo, reject stale revisions, and maintain one
in-flight solve rather than accumulating an edit backlog. Light results update
both WASM copies and the persistent source column. They do not run every frame
or depend on the camera or sun phase.

Distant light remains approximate: compact LOD uses exposed full-sky lighting and
does not retain the complete propagated near light field. Terrain reductions are
conservative and column boundaries are closed, but transitions are stepped rather
than a full watertight Voxy hierarchy. Unknown terrain is never invented.

## Camera-dependent work

The renderer still shades new visible pixels, evaluates bounded on-screen water
reflection rays and resolves transparency. Screen-space reflections cannot see
geometry outside the current image; the cached environment provides the fallback.
Low disables SSR and temporal accumulation. Balanced/High jitter the projection,
reproject HDR history, validate depth, clamp neighborhoods and reject reactive
water/animated materials/entities. These effects need fresh samples in newly
revealed regions. Temporal upscaling reconstructs at output resolution from the
scaled render targets; it is an implemented algorithm, not DLSS or an external
shader-pack compatibility layer.

## Memory and verification

One 2048² 32-bit shadow map uses 16 MiB. Precomputing 240 sun positions would use
3.75 GiB before terrain, textures, entities and postprocessing, and edits would
invalidate portions of that data. The implementation instead retains static and
combined dynamic maps plus bounded light/terrain caches.

The complete imported 1.20.4 atlas uses 16 MiB of GPU texture storage, with under
1 MiB of predecoded animated frames. Distant meshes are capped at 64 MiB and
resident coarse voxel records at 32 MiB. Full imported chunk storage uses a
32 MiB decoded LRU and a 512 MiB disk budget; the active near window is separate.
Renderer statistics expose actual geometry, render-target and atlas allocations.

Tests inspect actual GPU texture/depth readbacks to prove terrain reflections,
animated atlas changes, transparent background preservation, dynamic shadow
removal and unchanged rendering at a 30-million-block translation. Browser tests
also verify cache invalidation and real Minecraft data/gameplay. These correctness
checks use SwiftShader here. The 16.67 ms target and Photon-level visual quality
still require measurement and comparison on the user's NVIDIA 1650 Ti.
