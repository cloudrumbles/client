# Vulkan execution evidence

This first native game-window run uses the original external Photon revision
`15458c0937f8647c37eb6a501bef5eb3bf3da31b`, low profile, explicit
`SH_SKYLIGHT=false` and `SHADER_AO=0`. The 40 captured frames use the current
single-window Vulkan implementation before its first commit; the raw build
revision is correctly labeled `a6b6eb8+dirty`. This is preliminary evidence,
not a clean-release hardware benchmark or Iris parity claim.

![Original Photon in the native game window, including cow/held item/HUD](main-window.png)

The full window uses original Photon terrain, water, shadow/deferred/composite
passes, GPU color composition and shared depth, followed by existing native
forward entities, held items and UI. Those forward draws are not yet pack-shaded
or included in pack shadows/postprocessing.

`live-low.json` records 40 Vulkan pack frames on llvmpipe (LLVM 19.1.7), internal
320×179 and window 854×480, a local official vanilla 26.3 / protocol 777 server,
81 loaded columns, tracked entities, inventory and all world times exactly 6000.
The game window closed normally after screenshots. GPU timestamp intervals
exclude the native forward draws/UI/presentation and cannot qualify gameplay FPS.
The initial CPU timing fields are zero because that measurement was not yet
implemented; later code records actual command-record CPU time.

Validation reported no Vulkan errors in this completed run. Unused vertex-input
warnings were subsequently removed from the pack pipelines using SPIR-V
reflection. An earlier failed live upload resolved material predicates per vertex;
the palette-resolution fix enabled this completed run. An existing native item
push-constant stage-mask error found in that failed run was also repaired.
The 26.3 configuration decoder still reported one registry-data compound-tag
warning; its change to arbitrary NBT tags is independently under investigation.

The pack-only PNG excludes native forward draws and UI. All assets and pack
sources remain external. These software results do not measure the GTX 1650 Ti
or certify final quality/performance or distant terrain. Reproduction uses the
shader-pack README and the existing live validation world's scene commands.
