# Reuse work that has not changed

The world often stays still, but the image does not. Camera position changes
visibility, reflection directions and projected pixels. A moving sun changes
direct light and shadow locations. Water, clouds, weather and entities change
independently. Static terrain is an opportunity to reuse intermediate results,
not a reason to reuse the entire final frame while the player is moving.

## Implemented cache boundaries

| Result | Reuse | Invalidation |
| --- | --- | --- |
| Voxel terrain | Seeded world retained in WASM | Actual block edits |
| Chunk surface geometry | Worker mesh and GPU buffer retained | Changed chunk and nearby chunks needed for boundary faces/AO |
| Vertex ambient occlusion | Computed while meshing | Nearby geometry edits |
| Directional shadow map | Retained depth texture | Quantized sun direction, world geometry revision, shadow coverage region, or quality change |
| Sky/cloud environment | Bounded retained HDR texture; also sampled by water | Quantized sun direction, cloud wind time bucket, camera region, or quality change |
| HDR color/depth | Rendered at scaled resolution | Every visible frame |

Shadows intentionally update at quantized sun directions rather than every
animation frame. This is approximate: shadow motion steps, and direct-light
shading between updates uses the continuously moving sun. Angular steps and
shadow resolution can be reduced if artifacts outweigh the saved work. World
edits invalidate the shadow cache when replacement geometry arrives, so the
shadow map matches the geometry actually rendered.

Sky/cloud cache textures use 0.25–4 MiB depending on quality. Balanced updates
moving clouds at one-second intervals; High at half-second intervals. Turning
the camera reuses the same texture. Low has no clouds and only needs solar or
region changes. This is approximate too: cloud motion steps between updates.

The first renderer has static terrain as its only shadow caster. Adding moving
entities requires either a dynamic shadow layer combined with the retained
terrain layer, or invalidating the combined shadow map. Without that change,
entities would cast stale shadows. A light moving to a new position also needs
its cache invalidated.

## Future caches

For indirect light, retain low-resolution world-space irradiance probes or voxel
light data and update dirty regions. Static block lights can be solved when their
source or surrounding geometry changes. Sun/sky light can be represented by a
small directional basis, with more frequent updates near the camera.

For expensive screen effects, temporal reprojection reuses earlier samples with
depth/normal/motion validation. Newly revealed pixels need fresh shading;
history must be rejected after edits, camera cuts, significant lighting changes
and resolution changes. Temporal upscaling is not implemented in this milestone.

Precomputing a complete day of shadow maps is less attractive on a 4 GB GPU:
one 2048² 32-bit depth map occupies 16 MiB; 240 sun positions would already occupy
3.75 GiB before terrain, textures, browser allocations or postprocessing.
Local edits would invalidate affected precomputed states. Sparse light caches
and demand-driven shadow updates give more useful reuse for the memory budget.

Predictable solar motion can schedule updates and prefetch the next cache state.
It cannot eliminate camera-dependent rasterization, visibility and reflections.
The target is a stable 16.67 ms frame budget with each cache validated against
the exact world/light state it represents.
