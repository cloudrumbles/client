# Photon effect audit

Reviewed public Photon commit [`15458c0937f8647c37eb6a501bef5eb3bf3da31b`](https://github.com/sixthsurge/photon/tree/15458c0937f8647c37eb6a501bef5eb3bf3da31b), dated 2026-07-26. This client uses its own WebGPU renderer and cannot execute an Iris shader pack directly.

Source metadata: [Photon license at the reviewed commit](https://github.com/sixthsurge/photon/blob/15458c0937f8647c37eb6a501bef5eb3bf3da31b/LICENSE), copyright 2021–2025 Benjamin Stott. The current effect uses independently written WebGPU code for the percentage-closer soft-shadow technique described by Fernando, *Percentage-Closer Soft Shadows*, NVIDIA, SIGGRAPH 2005. No Photon shader code, textures, or other assets are included in this implementation.

## One bounded improvement

Photon's `shaders/include/lighting/shadows/pcss.glsl` searches for blockers and filters a variable penumbra. Before this change, the client used one hardware comparison at low quality and a fixed 3×3 comparison kernel at balanced/high quality. The fixed kernel gave nearby and distant casters equally wide transitions.

The directional-light filter estimates caster/receiver separation from the existing cached shadow depths and orthographic light transform. Stable disk samples soften distant shadows while preserving a narrow contact edge. Low quality retains its original hardware comparison. Balanced uses at most five blocker reads plus eight point-depth comparisons; high uses nine plus twelve. That is a maximum of 13 or 21 depth-texture reads. A receiver-plane calculation corrects each sampled texel's comparison depth. Keeping a single reference for a hardware 2×2 comparison caused steep surfaces to shadow themselves in the private control; explicit point comparisons remove that error without adding reads. The filter uses the current static/dynamic shadow textures and adds no pass, texture, buffer, geometry upload, or shadow-cache invalidation. Its fixed sampling pattern adds no per-frame noise.

A separate guard avoids the terrain shadow function when its direct-light contribution is provably zero: a back-facing normal, native sky-light zero, no dimension skylight, or weather sun multiplier zero. Nighttime remains eligible because the renderer also uses the shadow map for moonlight. This guard does not change the water shader's shadow eligibility. Water uses its actual geometric plane for offset depth correction and retains the animated normal for shadow bias.

The effect and guard are integrated. Their GPU controls demonstrate wider distant penumbras, unchanged low-quality pixels, exact camera/shadow depth, deterministic fixed-input sampling, and retained geometry/shadow caches. Eight signed receiver slopes retain exact shadow profiles and remain fully lit without blockers. The guard eliminates all calls in the five zero-contribution cases at each quality, while 21 full renderer cases retain identical HDR, depth, and shadow pixels. These controls run on the available software WebGPU adapter; they do not establish GTX 1650 Ti performance. The soft-shadow improvement also has a cost: the short, noisy software run increased warmed high-quality opaque pass times from about 22.7–23.0 ms to 24.8–26.6 ms. These are diagnostic samples, not a hardware performance prediction.

## Repeating daylight and storage

The current shadow map already persists across unchanged frames. Its key includes caster revision, quantized sun angle, camera region, and quality. A normal 20-minute day has 240 angle buckets, so unchanged terrain does not rebuild shadow depth 60 times per second.

Retaining all 240 high-quality 2048×2048 depth maps would require 3.75 GiB before dynamic shadows, geometry, and scene targets. Balanced 1536×1536 maps would require 2.11 GiB. A small recent-map cache is useful for repeated time jumps but cannot hold every normal-day bucket until the next day. Disk caching needs an actual comparison of storage read, decompression, and GPU restore against rendering the existing caster bundles. A private diagnostic, excluded from this checkpoint, measured those phases in nine exact-image rounds on the software adapter. A 16 MiB map compressed to 745,890 bytes; reading took about 1.9–2.2 ms, decompression 39–41 ms and GPU restore 31–36 ms, versus 38–44 ms to render fresh shadow depth. This result supports keeping shadow storage experimental; it is not a target-hardware prediction. The normal renderer adds no diagnostic shadow readback or persistent shadow-depth cache.

## Remaining visual gaps

The current renderer has cached ambient and bounce irradiance, an HDR environment, directional shadows, water reflection/refraction, temporal reconstruction, bloom, and tone mapping. Those features do not establish Photon visual parity. Substantial gaps remain in ground-truth ambient occlusion and bent normals, cloud lighting/weather profiles, LabPBR normal/roughness/metal response, voxel light propagation and volumetric scattering, depth-dependent water absorption, and histogram exposure with broad bloom pyramids.

The existing per-pass GPU profiler can identify their cost on the target machine before increasing shader work. A 60 FPS claim still requires a qualified run on the requested Nvidia 1650 Ti, with resolution, quality, world workload, and frame-time percentiles recorded.
