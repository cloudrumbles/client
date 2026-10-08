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
Vulkan validation errors. Validation requires both the layer request and an
actual loader `Insert instance layer "VK_LAYER_KHRONOS_validation"` log entry.
Missing activation proof or a layer-load failure produces `unverified` with
`validation_errors: null` and fails the check. The driver enables
`VK_LOADER_DEBUG=layer` for its own child process and retains the proof lines.
A watchdog catches query hangs. This is a live manual
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
the bounded capture. The QA feature writes `vulkan-live.complete.json` after
the screenshot and capture writes return; these writes are not atomic. The
driver waits within its timeout for a complete marker and JSON, matching file
lengths/revision/sample bound, and a full PNG chunk stream with valid CRCs and
IEND. It also verifies a fully parsed trace snapshot before termination, saved
as `verified-events.jsonl`; the raw trace may gain later shutdown events.
Its trace contains at most 512 events. The hook is absent
from builds without `renderer-fault-injection`; QA builds activate it only when
`POMME_TEST_ACQUIRE_TRACE` names the trace file.

CI executes the driver's activation and partial-capture selftests and compiles,
lints, and runs the client tests with `renderer-fault-injection` enabled. Run
the driver selftests locally with:

```sh
python3 -B -m unittest discover -s pomme-client/tests \
  -p 'test_acquire_fault_integration.py' -v
```

Software Vulkan validates lifecycle correctness. Target GPU performance and
hardware-specific driver behavior require separate GTX 1650 Ti runs.
