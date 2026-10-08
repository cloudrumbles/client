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
import re
import struct
import subprocess
import time
import zlib


VALIDATION_LAYER = "VK_LAYER_KHRONOS_validation"


def validation_status(environment, log):
    """An environment request or discovered manifest does not prove activation."""
    requested = VALIDATION_LAYER in re.split(r"[:;,\s]+", environment.get("VK_INSTANCE_LAYERS", ""))
    proof = [line for line in log.splitlines() if re.search(
        r'Insert instance layer\s+"' + VALIDATION_LAYER + r'"', line
    )]
    failures = [line for line in log.splitlines() if VALIDATION_LAYER in line and re.search(
        r"failed|not present|not found|cannot|unable|could not", line, re.IGNORECASE
    )]
    errors = [line for line in log.splitlines() if any(
        marker in line for marker in ("VUID-", "Validation Error", "UNASSIGNED-")
    )]
    verified = requested and bool(proof) and not failures
    return {
        "validation_status": "verified" if verified else "unverified",
        "validation_errors": len(errors) if verified else None,
        "validation_layers_requested": environment.get("VK_INSTANCE_LAYERS", ""),
        "validation_activation_proof": proof,
        "validation_layer_failures": failures,
        "validation_messages": errors,
    }


def png_complete(data):
    """Check the written PNG's full chunk stream and CRCs, including final IEND."""
    if not data.startswith(b"\x89PNG\r\n\x1a\n"):
        return False
    offset = 8
    has_header = has_pixels = False
    while offset + 12 <= len(data):
        length = struct.unpack_from(">I", data, offset)[0]
        end = offset + 12 + length
        if end > len(data):
            return False
        kind = data[offset + 4:offset + 8]
        chunk = data[offset + 4:end - 4]
        if zlib.crc32(chunk) != struct.unpack_from(">I", data, end - 4)[0]:
            return False
        if kind == b"IHDR":
            has_header = offset == 8 and length == 13
        elif kind == b"IDAT":
            has_pixels = True
        elif kind == b"IEND":
            return has_header and has_pixels and length == 0 and end == len(data)
        offset = end
    return False


def read_completed_capture(capture_dir, expected_frames):
    """Return a validated snapshot, or None while any final write is incomplete."""
    try:
        marker = json.loads((capture_dir / "vulkan-live.complete.json").read_bytes())
        data = (capture_dir / "vulkan-live.json").read_bytes()
        image = (capture_dir / "vulkan-live.png").read_bytes()
        capture = json.loads(data)
    except (FileNotFoundError, json.JSONDecodeError, UnicodeDecodeError):
        return None
    if len(data) != marker.get("json_bytes") or len(image) != marker.get("png_bytes"):
        return None
    if not png_complete(image):
        return None
    assert marker.get("event") == "capture_completed", "invalid capture completion marker"
    assert marker.get("samples") == len(capture["samples"]) == expected_frames, "capture bound mismatch"
    assert marker.get("revision") == capture["revision"], "capture marker revision mismatch"
    return capture


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
    # Loader output provides positive evidence that the requested layer was
    # inserted into this process's instance, even when the client did not enable
    # it explicitly. Mere availability/loading messages are insufficient.
    env["VK_LOADER_DEBUG"] = "layer"
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
            while True:
                capture = read_completed_capture(capture_dir, args.frames)
                if capture is not None:
                    # Trace writes are non-atomic too. Preserve the complete
                    # snapshot verified before termination, separately from the
                    # raw trace that may gain later events during shutdown.
                    try:
                        trace = trace_path.read_text()
                        events = [json.loads(line) for line in trace.splitlines()]
                    except (FileNotFoundError, json.JSONDecodeError):
                        pass
                    else:
                        result = verify(events, capture, args.frames)
                        (args.output / "verified-events.jsonl").write_text(trace)
                        break
                assert process.poll() is None, f"client exited before capture: {process.returncode}"
                assert time.monotonic() < deadline, "acquire/recreation integration timed out (possible query WAIT hang)"
                time.sleep(0.2)
        finally:
            if process.poll() is None:
                process.terminate()
                try:
                    process.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait(timeout=10)
    validation = (args.output / "client-validation.log").read_text()
    result.update(validation_status(env, validation))
    result["binary_sha256"] = hashlib.sha256(args.binary.read_bytes()).hexdigest()
    result["production_acquire_path"] = True
    result["gpu_query_wait_timeout"] = False
    (args.output / "result.json").write_text(json.dumps(result, indent=2) + "\n")
    print(json.dumps(result, indent=2))
    assert result["validation_status"] == "verified", "validation layer activation unverified; inspect client-validation.log"
    assert result["validation_errors"] == 0, "Vulkan validation reported errors; inspect client-validation.log"


if __name__ == "__main__":
    main()
