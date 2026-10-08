# Actor-stage validation evidence

These files preserve two different source checkpoints. Publishing evidence does not change their measured build revisions.

- `frozen-2e278c08/` is the original clean actor checkpoint, source head `2e278c08eb24e54ec163155aeec002b403305662`. It includes the 120-frame original Photon capture, native and pack screenshots, baby/legacy screenshots, exact CI result, Linux build manifest, and SHA-256 provenance. The summary records the separate 40-frame baby and legacy runs. These are the original results; they do not prove the later material fix.
- The material-fix directory records clean source head `79f639df7e3c71f585aa72f56eac4b435398e423`. Its focused synthetic shader fixture exercises `vec3` and `vec4 mc_Entity` through both mesh attributes and real actor uniforms. The source repair is commit `8a4cd759f1039d253a01733f780dfc4bb7237f93`; a separate device-properties lifetime correction is commit `79f639df7e3c71f585aa72f56eac4b435398e423`. No actor coverage is added.

The frozen checkpoint's `vec4` alias mismatch is reproduced separately in `vec4-mismatch.vsh` and `vec4-mismatch.log`: even a read of `.x` fails compilation because the conditional operands have different dimensions. The fix preserves the declared input type, uses `vec4(pomme_ActorMaterial, 1.0)` only for a declared vec4 input, and keeps the native RGB vertex format. The [Vulkan vertex-input specification](https://docs.vulkan.org/spec/latest/chapters/fxvertex.html) defines default values for missing components; the new GPU fixture checks W=1 on the mesh and actor paths.

The Photon captures use `SH_SKYLIGHT=false`; complete compute/storage and Iris compatibility were not implemented at either actor source checkpoint. All GPU results here use Mesa llvmpipe software Vulkan. GTX 1650 Ti performance, 60 FPS, and Iris image parity remain untested. Pack timing samples exclude forward actors/UI/presentation and are not total gameplay FPS. The original pack and Minecraft assets are not included.

Reproduce the new regression from the clean material-fix source head:

```sh
cargo test --locked --release -p pomme-shaderpack --features vulkan --lib
VK_INSTANCE_LAYERS=VK_LAYER_KHRONOS_validation \
  VK_LOADER_DEBUG=layer,error POMME_ACTOR_EVIDENCE=/tmp/actor-material-evidence \
  cargo test --locked --release -p pomme-shaderpack --features vulkan \
  --test actor_vulkan -- --ignored --nocapture --test-threads=1
```

A working Vulkan driver and validation-layer installation are required for the explicitly ignored GPU tests. The evidence JSON records the executable's embedded build revision and the device, and provenance hashes identify the exact PNG/log/JSON files.
