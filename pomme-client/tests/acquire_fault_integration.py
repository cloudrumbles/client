#!/usr/bin/env python3
"""Drive a real client/window/Vulkan/world through three acquire failures.

Build with renderer-fault-injection, supply ordinary launch/world/pack arguments
after --. A display, Vulkan driver, and usable world connection are required.
"""

import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import time


def verify(events, capture, expected_frames):
    faults = [i for i, event in enumerate(events) if event["event"] == "injected_out_of_date"]
    assert len(faults) == 3, f"expected three injected acquire failures, got {len(faults)}"
    assert [events[i]["scenario"] for i in faults] == [
        "before_first_submission",
        "after_recreation_before_submission",
        "after_window_resize_and_submission",
    ]
    for i in faults:
        fault = events[i]
        assert events[i - 1]["event"] == "prepared", "fault did not follow real preparation"
        assert events[i + 1]["event"] == "cancelled", "real acquire branch did not cancel"
        assert events[i + 1]["injected"] is True
        assert events[i - 1]["slot"] == fault["slot"] == events[i + 1]["slot"]
        assert any(event["event"] == "recreated" for event in events[i + 2 :]), "no recovery recreation"
    assert events[faults[0]]["pack_submissions"] == 0
    assert events[faults[1]]["pack_submissions"] == 0
    assert events[faults[1]]["recreations"] > events[faults[0]]["recreations"]
    assert events[faults[2]]["pack_submissions"] >= 1
    assert any(event["event"] == "submitted" for event in events[faults[2] + 1 :])
    resized = next(event for event in events if event["event"] == "resize_requested")
    assert any(
        event["event"] == "recreated" and event["size"] == resized["to"]
        for event in events[: faults[2]]
    ), "third failure did not follow the requested real window resize"
    assert len(capture["samples"]) == expected_frames, "capture did not complete exact submitted bound"
    return {
        "faults": [events[i] for i in faults],
        "resize": resized,
        "captured_samples": len(capture["samples"]),
        "revision": capture["revision"],
        "device": capture["device"],
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--binary", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--frames", type=int, default=20)
    parser.add_argument("--timeout", type=float, default=300)
    parser.add_argument("client_args", nargs=argparse.REMAINDER)
    args = parser.parse_args()
    assert 4 <= args.frames <= 100, "integration capture requires 4..100 frames"
    forwarded = args.client_args[1:] if args.client_args[:1] == ["--"] else args.client_args
    assert not any(arg.startswith(("--shader-frames", "--shader-output")) for arg in forwarded)
    args.output.mkdir(parents=True, exist_ok=False)
    trace_path = args.output.resolve() / "acquire-events.jsonl"
    capture_dir = args.output.resolve() / "capture"
    env = os.environ.copy()
    env["POMME_TEST_ACQUIRE_TRACE"] = str(trace_path)
    command = [
        str(args.binary.resolve()),
        *forwarded,
        "--shader-frames", str(args.frames),
        "--shader-output", str(capture_dir),
    ]
    deadline = time.monotonic() + args.timeout
    with (args.output / "client-validation.log").open("w") as output:
        process = subprocess.Popen(command, env=env, stdout=output, stderr=subprocess.STDOUT)
        try:
            while not (
                (capture_dir / "vulkan-live.json").is_file()
                and (capture_dir / "vulkan-live.png").is_file()
            ):
                assert process.poll() is None, f"client exited before capture: {process.returncode}"
                assert time.monotonic() < deadline, "acquire/recreation integration timed out (possible query WAIT hang)"
                time.sleep(0.2)
            # Final writes are atomic; keep the live loop going briefly so the
            # trace records another submission after all injected failures.
            time.sleep(0.5)
        finally:
            if process.poll() is None:
                process.terminate()
                try:
                    process.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait(timeout=10)
    events = [json.loads(line) for line in trace_path.read_text().splitlines()]
    capture = json.loads((capture_dir / "vulkan-live.json").read_text())
    result = verify(events, capture, args.frames)
    validation = (args.output / "client-validation.log").read_text()
    errors = [line for line in validation.splitlines() if any(
        marker in line for marker in ("VUID-", "Validation Error", "UNASSIGNED-")
    )]
    assert not errors, f"Vulkan validation reported {len(errors)} errors; inspect client-validation.log"
    result["validation_errors"] = len(errors)
    result["validation_layers"] = env.get("VK_INSTANCE_LAYERS", "")
    result["binary_sha256"] = hashlib.sha256(args.binary.read_bytes()).hexdigest()
    result["production_acquire_path"] = True
    result["gpu_query_wait_timeout"] = False
    (args.output / "result.json").write_text(json.dumps(result, indent=2) + "\n")
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
