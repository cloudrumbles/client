# Portable voxel core

This dependency-free Rust crate supplies the actual browser simulation and terrain
geometry. It is a standalone workspace because the existing native client uses
Vulkan and platform libraries. It currently generates a bounded editable demo
world, not a complete Minecraft Java protocol or world-format implementation.

Build with stable Rust:

```sh
rustup target add wasm32-unknown-unknown
cargo test --manifest-path pomme-web/core/Cargo.toml
cargo build --manifest-path pomme-web/core/Cargo.toml --target wasm32-unknown-unknown --release
cp pomme-web/core/target/wasm32-unknown-unknown/release/pomme_web_core.wasm pomme-web/public/core.wasm
```

The browser instantiates this module without imports. All exports are C ABI values,
and `memory` is exported automatically by the Rust wasm target. Calls and reads
must happen on a single JS thread or worker. Refresh typed-array views after calls
that allocate because WebAssembly memory can grow.

The world is 128 × 64 × 128 blocks with 64 chunks, each 16 × 64 × 16. Chunk index is
`floor(z / 16) * 8 + floor(x / 16)`. Block IDs are air 0, grass 1, dirt 2, stone 3,
wood 4, leaves 5, sand 6, water 7 and glow 8. Leaves are opaque in this first core.

| Export | Contract |
| --- | --- |
| `world_init(seed: u32)` | Reset/generate the world; all chunks become dirty. |
| `world_width/height/depth/chunk_count/chunk_size()` | Return the fixed dimensions. |
| `block_get(x: i32, y: i32, z: i32) -> u32` | Out-of-bounds reads return air. |
| `block_set(x, y, z, id: u32) -> u32` | Return 1 when changed, otherwise 0. Reject invalid IDs/bounds. |
| `block_solid(id: u32) -> u32` | Water and air do not collide. |
| `terrain_height(x: i32, z: i32) -> u32` | First air above ground, excluding trees and water; 0 for empty/outside. |
| `world_revision() -> u32` | Increases only on successful edits. |
| `chunk_revision(index: u32) -> u32` | Revision of its latest invalidation, including neighbour AO changes. |
| `mesh_dirty(index: u32) -> u32` | Whether this chunk must be remeshed. |
| `mesh_chunk(index: u32, water: u32) -> u32` | Generate opaque (0) or water (1) mesh; return vertex count. |
| `mesh_ptr() -> u32` | Pointer to float32 vertices: position3, normal3, color3, AO1. |
| `mesh_clean(index: u32)` | Mark clean after copying **both** opaque and water meshes to GPU buffers. |
| `collides_aabb(min_x, min_y, min_z, max_x, max_y, max_z: f32) -> u32` | Solid-voxel AABB collision. Horizontal boundaries/floor collide; upper sky is open. |
| `ray_cast(ox, oy, oz, dx, dy, dz, max_distance: f32) -> u32` | Exact voxel DDA; normalize direction; skip water; return hit flag. |
| `ray_hit_ptr() -> u32` | Pointer to int32 `[x, y, z, previous_x, previous_y, previous_z, block_id]`. |

Mesh pointers remain valid only until the next `mesh_chunk`/`world_init` call. Copy
vertices before meshing the next surface. AABB contact uses a 0.0001-block tolerance.
Ray results remain valid until the next ray query or world reset.

The mesher greedily combines adjacent faces with equal materials and uniform AO.
Faces with different AO at their corners remain separate to preserve lighting.
AO and geometry are cached in the renderer. Editing at a chunk corner invalidates
diagonal neighbours as well as side neighbours because AO samples those cells.
Sun position and camera movement do not invalidate these static meshes.
