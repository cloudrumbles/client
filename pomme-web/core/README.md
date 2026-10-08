# Portable voxel core

This dependency-free Rust crate supplies the actual browser simulation and terrain
geometry, collision and native light buffers. It is a standalone workspace because
the native client uses Vulkan and platform libraries. JavaScript decodes Java
protocol and Anvil data into native section IDs for this core.

Build with stable Rust:

```sh
cd pomme-web/core
rustup target add wasm32-unknown-unknown
cargo test
cargo clippy --all-targets -- -D warnings
cargo build --target wasm32-unknown-unknown --release
node --test tests/abi.test.mjs
cp target/wasm32-unknown-unknown/release/pomme_web_core.wasm ../public/core.wasm
```

The browser instantiates this module without imports. All exports are C ABI values,
and `memory` is exported automatically by the Rust wasm target. Calls and reads
must happen on a single JS thread or worker. Refresh typed-array views after calls
that allocate because WebAssembly memory can grow.

The generated demo is 128 × 64 × 128 blocks with 64 chunks. Demo chunk index is
`floor(z / 16) * 8 + floor(x / 16)`. Block IDs are air 0, grass 1, dirt 2, stone 3,
wood 4, leaves 5, sand 6, water 7 and glow 8. Leaves are opaque in this first core.

| Export | Contract |
| --- | --- |
| `world_init(seed: u32)` | Reset/generate the world; all chunks become dirty. |
| `world_width/height/depth/chunk_count/chunk_size()` | Return current block dimensions, slot count and chunk size 16. |
| `block_get(x: i32, y: i32, z: i32) -> u32` | Out-of-bounds reads return air. |
| `block_set(x, y, z, id: u32) -> u32` | Return 1 when changed, otherwise 0. Reject invalid IDs/bounds. |
| `block_solid(id: u32) -> u32` | Water and air do not collide. |
| `terrain_height(x: i32, z: i32) -> i32` | First air above ground, excluding height-ignored, invisible and fluid IDs; min_y for empty/outside. |
| `world_revision() -> u32` | Increases once per changed edit, section, light update, rebase or metadata invalidation. |
| `chunk_revision(index: u32) -> u32` | Revision of its latest invalidation, including neighbour AO changes. |
| `mesh_dirty(index: u32) -> u32` | Whether this chunk must be remeshed. |
| `mesh_chunk(index: u32, water: u32) -> u32` | Generate nonfluid (0) or fluid (1) mesh; return vertex count. |
| `mesh_ptr() -> u32` | Pointer to float32 vertices: position3, normal3, color3, AO1, UV2, tileID1, flags1. |
| `mesh_vertex_stride() -> u32` | Current stride: 14 float32 values. |
| `mesh_clean(index: u32)` | Mark clean after copying **both** opaque and water meshes to GPU buffers. |
| `collides_aabb(min_x, min_y, min_z, max_x, max_y, max_z: f64) -> u32` | Exact registered collision-box overlap. Horizontal boundaries/floor collide; upper sky is open. |
| `ray_cast(ox, oy, oz, dx, dy, dz, max_distance: f64) -> u32` | Exact voxel DDA and custom-model triangle picking; normalize direction; skip fluid; return hit flag. |
| `ray_hit_ptr() -> u32` | Pointer to int32 `[x, y, z, previous_x, previous_y, previous_z, block_id]`. |

Mesh pointers remain valid only until the next `mesh_chunk`/`world_init` call. Copy
vertices before meshing the next surface. AABB contact uses a 0.0001-block tolerance.
Ray results remain valid until the next ray query or world reset.

The mesher greedily combines adjacent faces with equal materials, native light and uniform AO.
Faces with different AO at their corners remain separate to preserve lighting.
AO and geometry are cached in the renderer. Editing at a chunk corner invalidates
diagonal neighbours as well as side neighbours because AO samples those cells.
Sun position and camera movement do not invalidate these static meshes.

## Imported worlds and native coordinates

`world_reset(min_y: i32, height, origin_chunk_x: i32, origin_chunk_z: i32,
width_chunks, depth_chunks) -> u32` creates an empty imported window and preserves
prepared registry/models. Return 1 accepted or 0 invalid without changing the
current world. Minimum Y and height must be section-aligned; height is 16–1024,
window at most 32 × 32 chunks. Overworld uses -64 and 384. IDs use all 16 bits.
Nonzero unregistered imported IDs are solid/opaque magenta placeholders. Demo
init restores demo metadata and rejects edits with unregistered IDs above 8.

Native chunk slot is `(cz-origin_chunk_z)*width_chunks+cx-origin_chunk_x`.
`world_rebase(origin_chunk_x, origin_chunk_z)` retains overlapping columns, evicts
the rest and recomputes heights. Interior retained columns keep their dirty flags
and revisions, including pending edits. Entering slots become dirty; retained
neighbors of evicted terrain or light sources become dirty, including diagonal
AO neighbors. A one-column horizontal shift of a fully loaded 16 × 16 window
invalidates 32 slots while preserving 224 interior meshes. Same-origin rebases are
no-ops; nonoverlapping teleports dirty every slot. Queries use native world
coordinates, including negative X/Z/Y. Physics/picking inputs use f64 to preserve
subblock precision near the world border.

**Mesh X/Z positions subtract the integer window origin before float32 conversion;
mesh Y remains native.** Send `[mesh_origin_x(),0,mesh_origin_z()]` with each GPU
upload and retain that origin with the mesh: reusable retained meshes can have
different upload origins after a rebase. `world_min_y()` and `world_origin_x/z()` return native i32 bounds;
`mesh_origin_x/z()` alias those X/Z origins.

Columns hold optional 16³ sections. Air-only sections allocate no block array;
uniform sections hold one ID; mixed sections hold 4096 u16 values. Meshing visits
only stored sections and skips hidden interior layers of completely opaque ones.
Maximum mixed-section payload is 512 MiB at 32 × 32 × 1024, or 192 MiB at height
384; actual allocation follows loaded mixed sections.

| Export | Contract |
| --- | --- |
| `world_stage_ptr/capacity()` | Staging pointer and 4096-u16 capacity. |
| `world_load_section(cx: i32, sy: i32, cz: i32, ptr, len)` | Exactly 4096 u16 native state IDs at staging pointer; order `(localY*16+localZ)*16+localX`; return 1 accepted or 0 invalid. |
| `world_unload_column(cx: i32, cz: i32)` | Remove terrain and lighting; return 1 removed, 0 absent/outside. |
| `world_column_loaded(cx, cz)` | Received column, including air-only sections. |
| `world_section_count()` | Count stored nonempty geometry sections. |
| `block_flags(id)` | Canonical registry material flags. |

Repeated section/light data is accepted without advancing revisions. Bulk updates
invalidate the eight neighbouring column slots once; corner edits invalidate the
diagonal slots needed by AO. A loader can persist evicted columns externally.

## Registry, textures and custom models

Canonical flags: SOLID1, AO_OPAQUE2, FLUID4, EMISSIVE8, CUSTOM_MODEL16, CUTOUT32,
BLEND64, INVISIBLE128, HEIGHT_IGNORED256. Native cave/void air may have nonzero IDs
with INVISIBLE. Invisible barriers can remain solid. Tree metadata can exclude
foliage/trunks from height queries.

| Export | Contract |
| --- | --- |
| `block_register(id,r,g,b: f32,flags)` | Return 1 accepted or 0 invalid; ID 0 always remains invisible/noncolliding. |
| `block_light_emission(id,level)` | Native emission 0–15; emissive metadata defaults to 15 until configured. |
| `block_face_tile(id,face,tile: i32,rotation)` | Face order east0, west1, up2, down3, south4, north5; rotation degrees in multiples of 90. Tile -1 selects procedural material. |
| `block_face_uv(id,face,u0,v0,u1,v1: f32)` | Normalized resource-face UV region; greedy quads repeat across their block width/height. |
| `world_float_stage_ptr/capacity()` | Separate 32768-float32 staging area. |
| `block_model_register(id,ptr,float_count)` | Copy complete stride-14 triangles from float staging. Custom templates replace cube geometry. |
| `block_collision_register(id,ptr,box_count)` | Six local float32 values per AABB: minXYZ,maxXYZ. Zero boxes means no collision. |
| `world_model_float_count()` | Unique pooled model floats, capped at 16 Mi floats (64 MiB). |
| `block_registry_begin/end()` | Batch metadata registration with one invalidation at the outermost end. |
| `block_registry_clear()` | Restore demo metadata and release model/collision pools. |

Identical template arrays share storage across state IDs. Pools persist across
world resets; registry clear/demo init releases them. Custom vertices retain
authored UV, tile and color and receive approximate baked AO. Vertex flag bits
18–20 encode authored cullface: 0 no culling, 1–6 face order above plus one. An
opaque neighbour hides that triangle. Collision boxes can extend beyond a voxel
for fences and rotated shapes, within accepted ±8 bounds; the broad phase expands
to inspect their extent.

## Native lighting

`world_load_light(cx,sy,cz,sky_ptr,block_ptr,len=2048)` accepts packed native light
nibbles. Pointer 0 means missing/preserve that channel; otherwise it must address
2048 bytes inside u16 staging. Use stage pointer for sky and pointer+2048 for
block. Even block indices use the low nibble. Return 1 accepted or 0 invalid.

Lights are sparse and independent of terrain, so an empty adjacent section can
illuminate a face. Faces sample their exterior native voxel. Vertex flags include
LIGHT_PRESENT512, sky bits10–13 and block bits14–17. True zero light stays dark;
models replace their default packed light while preserving cull metadata. Missing
sky defaults to 15 and missing block to 0. `world_set_skylight_default(level)`
accepts 0–15 (0 for dimensions without sky). `world_light_section_count()` reports
stored light sections. The server/Anvil arrays supply propagation; edits await
updated cached light data rather than running a full-world light solver per frame.

`world_set_floor_collision(enabled)` accepts 0 or 1. Demo/reset defaults to a solid
minimum-Y boundary; server worlds can disable it for falling into the End void.
Registered terrain collision still applies when the boundary is disabled.
