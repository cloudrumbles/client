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
| Terrain GPU draw commands | Bounded render-bundle LRU for visible terrain and shadow casters | Visible mesh set, retained buffers, pipeline or texture bindings |
| Vertex ambient occlusion | Computed during meshing | Nearby geometry changes |
| Native sky/block light | Packed per-section arrays | Authoritative server light packets or local edit propagation |
| Colored local light and diffuse bounce | Bounded near-world textures, losslessly compressed sun-angle entries and persistent IndexedDB cache | Actual source blocks/light, material tables, source band or algorithm changes; a repeated sun angle can restore an existing result |
| Local propagated light | Background 3×3-column solves; bounded cache | Source/opacity/emission revisions |
| Distant terrain | Persisted 4/8/16m cells and retained regional meshes | Actual source columns/edits, near coverage or LOD selection |
| Static directional shadows | Retained terrain depth | Sun-angle bucket, geometry inside the light frustum, coverage region, quality or atlas |
| Dynamic shadows | Static depth copied; only entity casters drawn, at most 30 Hz | Dynamic geometry/light coverage; removal restores static depth |
| Sky/cloud environment | Retained HDR direction map sampled by sky/water | Sun bucket, cloud-wind bucket, camera region or quality |
| Animated texture pixels | Predecoded native frame sequences | Their `.mcmeta` clock advances to a different frame |
| Block-breaking overlays | Separate retained mesh and native destruction stage | A tracked block, stage or baked model changes; terrain and shadow buffers stay cached |
| Map terrain, decorations and labels | Persisted color bytes and held/frame atlas tiles | Map patches, decoration updates, world identity or resource-pack reload |
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

Fullbright beacon/gateway beams are omitted from dynamic shadow draws. Animating
these meshes preserves cached shadows, including when an opaque actor shares the
scene. Mixed or unknown mesh flags remain conservative shadow casters. Breaking
overlays retain depth and use a local temporal rejection mask; removing a crack
rejects its last visible footprint for one frame without resetting all history.

First-person arms/items render after the world with separate depth behavior.
They do not enter world visibility or shadow-caster lists. Stationary hand
geometry is retained, while animation and item changes update only its buffer.
Weather changes invalidate quantized sky lighting, and lightning is transient.

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

Coarse edits update retained mip arrays incrementally. Unchanged selected mip
levels preserve their mesh revisions, and known solid neighbors within each
regional batch remove shared interior faces. Unknown, partial and mixed cells
retain their conservative boundaries.

The colored-light cache preserves native scalar block-light intensity. It adds
artistic source hues and one material-colored sun bounce using nearby voxel
barriers. Two unfiltered 48×32×48 RGBA16F volumes use 1.125 MiB; they update only
when a completed worker result changes. Unknown cells retain the scalar fallback,
and individual voxel loads prevent color interpolation through solid walls. The
solver retains one bounded source mirror and one in-flight job. Sun-only changes
reuse local light propagation, while rain attenuates bounce when shading.
Repeated angles reuse exact half-float RGB bits. One source context retains at
most 240 angles and 32 MiB of compressed RGB plus shared visibility. The persistent
cache keeps shared local light/visibility once per source and at most 64 MiB,
eight source contexts and 1,920 angle records. SHA-256 identifies the algorithm,
material tables, coordinates, blocks, known cells and native light; time of day
selects an angle within that source. Edits and pack changes select another source.
The worker reads the next periodic angle ahead of time when available. A time
command can request any stored angle without discarding correct entries.
Quota denial, missing/corrupt entries and storage errors fall back to computation.
Old world epochs cannot publish results after an asynchronous read.

The full 48×32×48 synthetic-band CPU proof retains all 240 angles in 8.24 MiB instead
of 135 MiB of raw bounce data and reproduces every half-float bit on the next cycle.
This is one scene's compression result, not a universal ratio or hardware FPS
measurement. Actual Chromium Worker/IndexedDB tests survive browser process
restart, and renderer readbacks preserve exact HDR pixels after worker restart.
RAM/decode, IndexedDB read/write and GPU timing remain separate measurements.
This is an approximate bounce field: short occlusion rays and averaged material
colors do not establish physical GI or original Photon image parity. Material
bounce currently uses imported face colors without per-position biome adjustment.

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
Putting these maps on disk avoids retaining all of them in GPU memory, but adds
read/decompression/upload work and an initial GPU readback/write cost. A private
diagnostic, excluded from this checkpoint, compared actual shadow rendering with
that complete restore path and found restoration slower on the software adapter;
normal frames perform no diagnostic shadow readbacks. Hardware/storage
caches affect those timings, so a warm IndexedDB test cannot establish cold NVMe
latency on another computer.

The complete imported 1.20.4 atlas uses approximately 32 MiB of GPU texture
storage after entity, item, font, particle and map textures, with under 1 MiB
of predecoded animated frames. Runtime skins/maps use a padded atlas extension
with a 64 MiB allocation cap. Distant meshes are capped at 64 MiB and
resident coarse voxel records at 32 MiB. Full imported chunk storage uses a
32 MiB decoded LRU and a 512 MiB disk budget; the active near window is separate.
Renderer statistics expose actual geometry, render-target and atlas allocations.

GPU profiling records fourteen ordered rendering stages using a fixed query
set and three asynchronous readback buffers, totaling 896 bytes of GPU buffer
storage. Cache hits omit the corresponding pass timestamps. Benchmark exports
retain frame IDs, submission times, exact nanosecond strings and per-pass
durations; pending readbacks and dropped samples are reported separately.
Profiling-on and profiling-off readbacks preserve identical HDR and depth pixels.

Tests inspect actual GPU texture/depth readbacks to prove terrain reflections,
animated atlas changes, transparent background preservation, dynamic shadow
removal and unchanged rendering at a 30-million-block translation. Browser tests
also verify cache invalidation and real Minecraft data/gameplay. These correctness
checks use SwiftShader here. The 16.67 ms target and Photon-level visual quality
still require measurement and comparison on the user's NVIDIA 1650 Ti.
