# Original shader-pack temporal history qualification

Source3bfd77c68dfd4df0a1131e921138b440a722c1f5; PR8 stacked on accepted PR7 exact8d8f41b.

Original external Photon15458c0937f8647c37eb6a501bef5eb3bf3da31b remains unbundled. Both native runs use default-enabled SH, low profile, ENTITY_SHADOWS/BLOCK_ENTITY_SHADOWS enabled, same Vanilla26.3 world/camera and320x180 pack resolution. `comparison.json` pins the two capture revisions and describes differing live edit counts. Current content changes preserve Clear=false history, previous matrices and custom smoothing; world/resource/camera identity cuts remain.

`fixtures` contains exact-clean Khronos-validated real Vulkan actor/compute/temporal logs, with actual raster/light/environment/smooth output and an explicit epoch reset. `checks` are precommit checks of the same implementation, explicitly identified by qualification.json; they include an actual EGL OpenGL execution regression. `native-after` and `native-before-8d8f41b` contain full capture JSON, pack-output screenshots and native-window screenshots. Loader output proves validation activation with0diagnostics.

No physicalGTX1650Ti test, FPS claim or full Photon/Iris visual-parity claim. Routine edits no longer clear all pack histories; that establishes the generic host fix, not exact-frame proof of the earlier checker screenshot cause. Protocol time/weather commands and final full CI are still being completed. No restricted Voxy or Mojang/Photon source is bundled.
