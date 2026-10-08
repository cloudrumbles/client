# Native Vulkan shader-pack compute evidence

Source under qualification: 8d8f41bb29b0e2e83a7eab8a3f2e60e12dbc685f, stacked on PR5 79f639df7e3c71f585aa72f56eac4b435398e423.

This evidence uses the original external Photon revision 15458c0937f8647c37eb6a501bef5eb3bf3da31b, content hash c286e149eed07ca55685a0d1b7df49b45921b20401bb9ffb2f9baea9c57a2845. It is not a replacement shader. SH skylight is enabled by pack defaults; every captured frame records the actual deferred4_a dispatch. Shader-pack/Mojang sources and assets are not bundled.

The container has no physical GTX 1650 Ti and uses Mesa llvmpipe software Vulkan. Timestamp scopes exclude remaining forward actors, UI, presentation and game work; these results do not establish gameplay FPS or the 60 FPS target. Shared-memory logical bytes are reflected data size, not a measured driver allocation.

Original pack shader source translates through the generic ABI. Per-program storage-image read/write and memory qualifiers remain local while descriptor identity is canonical across the graph. The GPU fixture exercises a write-only producer and coherent read-only consumer, associated and standalone stages, setup persistence, aliasing and dependent fragment output.

Native screenshots and captures demonstrate the limited supported actor set (adult/baby cows, chest and held block), not every Minecraft actor or Iris visual parity. Routine remeshing currently resets all temporal buffers; a later native-window screenshot at predecessor 2627b8f showed a cloud checker pattern, separately preserved as a known issue. Complete Photon parity, custom image/SSBO ultra LPV, Voxy integration and physical GPU tests remain open.

Directories and exact passed/failed/unrun checks are enumerated in provenance.json. Validation errors are zero only when loader output proves VK_LAYER_KHRONOS_validation was inserted.
