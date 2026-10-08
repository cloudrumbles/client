The live acquire integration test exercises the production renderer and pack
engine. It injects `OutOfDateKHR` after a real frame fence wait and successful
pack preparation, before calling `vkAcquireNextImageKHR`. The ordinary production
error branch cancels the prepared capture and marks the swapchain dirty. Real
swapchain recreation follows, and the next prepare must finish without waiting
on timestamp queries that were never submitted.

The three faults occur before the first pack submission, after its first real
recreation (still before any pack submission), and after a successful submission
followed by an actual `Window::request_inner_size` resize and normal winit event.
The driver verifies the ordered production events, the changed surface extent,
subsequent successful submissions, exactly N captured samples, and absence of
Vulkan validation errors. A watchdog catches query hangs. This is a live manual
integration check; ordinary cargo tests cannot create its required window/world.

Build and run on a Vulkan-capable display with a usable world and owned assets:

```sh
cargo build --release --locked -p pomme-client --no-default-features \
  --features renderer-fault-injection
VK_INSTANCE_LAYERS=VK_LAYER_KHRONOS_validation \
python3 pomme-client/tests/acquire_fault_integration.py \
  --binary target/release/pomme-client --output /tmp/acquire-fault-result -- \
  --launch-token /path/to/launcher-created-token --version 26.3 \
  --username NativePhoton --assets-dir /path/to/assets \
  --versions-dir /path/to/versions --game-dir /path/to/game \
  --quick-access-multiplayer 127.0.0.1:25577 --renderer-path shared \
  --shader-pack /path/to/Photon --shader-profile low \
  --shader-option SH_SKYLIGHT=false --shader-width 320 --shader-height 180
```

Supply the usual launcher token and connection arguments for your environment.
The output directory must be new. `VK_LAYER_PATH` may be required for a custom
SDK installation. The test terminates its own client process after collecting
the bounded capture. Its trace contains at most 512 events. The hook is absent
from builds without `renderer-fault-injection`; QA builds activate it only when
`POMME_TEST_ACQUIRE_TRACE` names the trace file.

Software Vulkan validates lifecycle correctness. Target GPU performance and
hardware-specific driver behavior require separate GTX 1650 Ti runs.
