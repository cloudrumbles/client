This evidence records the live production acquire fault check at clean source
`e9f3e7a41b1aa61ace14ac80735e57d51af00fd8`. This branch adds evidence only; PR6
retains that exact source head.

The 26.3 client connected as `FaultPhoton` to the owned creative world, rendered
original Photon low with `SH_SKYLIGHT=false`, and injected three failures at
the real acquire site's existing cancellation branch. All three recovered;
the real window resize changed 854×480 to 870×496; exactly 20 samples completed.
The complete child-process log positively records insertion of the Khronos
validation instance layer (line 34). It contains zero validation errors.

- `result.json` records the verified result, exact revision and binary SHA256.
- `verified-events.jsonl` is the complete production trace snapshot parsed and
  checked before termination; `acquire-events.jsonl` retains the raw trace.
- `client-validation.log` is the full merged loader/stdout/stderr log.
- `capture/` contains the bounded JSON, PNG and QA completion marker.
- `provenance.json`, compiler versions and `release-build-stamped.log` record
  the source tree, build, external pack revision/hash, environment and checks.
- `python-selftests.log` records nine passing activation/partial-capture tests.
- `run-live-clean.sh` records the local live command; its launcher token is
  created temporarily and removed, never stored here.

The shared target initially reused another worktree's build-script revision.
That preliminary run is excluded. Touching the unchanged isolated
`pomme-shaderpack/build.rs` forced a fresh stamp; the repeated capture's revision
was explicitly asserted equal to the clean source head before publication.
Use a fresh target directory or force the build-script timestamp when rebuilding
multiple worktrees in one target.

CI run [37786632158](https://github.com/cloudrumbles/client/actions/runs/37786632158)
is at the same exact source head. At evidence publication it is in progress,
with the Python selftest and optional feature checks explicitly configured.
Their execution is not claimed passed until the workflow reports it.

This qualifies the software Vulkan host lifecycle on llvmpipe, including the
production prepare/cancel/recreate/submit path. The injected result precedes
`vkAcquireNextImageKHR`; it is not an actual hardware-driver OutOfDate event.
GTX 1650 Ti behavior and performance remain untested. Pack-pass timestamps
exclude actors/UI/presentation and are not gameplay FPS.

An independent reviewer can validate these saved records without starting a
client (from this evidence branch's repository root):

```sh
PYTHONPATH=pomme-client/tests python3 -B - <<'PY'
import hashlib, json
from pathlib import Path
from acquire_fault_integration import read_completed_capture, validation_status, verify
p = Path('validation/acquire-fault/e9f3e7a')
c = read_completed_capture(p / 'capture', 20)
assert c is not None
events = [json.loads(line) for line in (p / 'verified-events.jsonl').read_text().splitlines()]
assert verify(events, c, 20)['revision'] == 'e9f3e7a41b1aa61ace14ac80735e57d51af00fd8'
s = validation_status({'VK_INSTANCE_LAYERS': 'VK_LAYER_KHRONOS_validation'},
                      (p / 'client-validation.log').read_text())
assert s['validation_status'] == 'verified' and s['validation_errors'] == 0
for name, digest in json.loads((p / 'provenance.json').read_text())['files_sha256'].items():
    assert hashlib.sha256((p / name).read_bytes()).hexdigest() == digest, name
print('Saved capture, trace, layer proof and file hashes verified')
PY
```

Live rerun prerequisites and generic build instructions remain in
`pomme-client/tests/ACQUIRE_FAULT_INTEGRATION.md`; the original pack and game
assets stay external to this evidence.
