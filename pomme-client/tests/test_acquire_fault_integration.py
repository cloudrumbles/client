"""Selftests for the live driver's evidence and non-atomic capture handling."""

import json
from pathlib import Path
import struct
import tempfile
import unittest
import zlib

from acquire_fault_integration import (
    VALIDATION_LAYER,
    png_complete,
    read_completed_capture,
    validation_status,
)


def chunk(kind, data):
    return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data))


def image():
    return b"\x89PNG\r\n\x1a\n" + b"".join([
        chunk(b"IHDR", struct.pack(">IIBBBBB", 1, 1, 8, 6, 0, 0, 0)),
        chunk(b"IDAT", zlib.compress(b"\x00\xff\xff\xff\xff")),
        chunk(b"IEND", b""),
    ])


class ValidationEvidenceTests(unittest.TestCase):
    def test_missing_layer_request_cannot_claim_zero_errors(self):
        status = validation_status({}, "")
        self.assertEqual(status["validation_status"], "unverified")
        self.assertIsNone(status["validation_errors"])

    def test_request_and_manifest_loading_are_not_activation(self):
        log = 'Found manifest VK_LAYER_KHRONOS_validation\nLoading layer library libVkLayer_khronos_validation.so'
        status = validation_status({"VK_INSTANCE_LAYERS": VALIDATION_LAYER}, log)
        self.assertEqual(status["validation_status"], "unverified")
        self.assertIsNone(status["validation_errors"])

    def test_inserted_layer_proves_activation_and_counts_errors(self):
        proof = '[Vulkan Loader] INFO | LAYER: Insert instance layer "VK_LAYER_KHRONOS_validation" (libVkLayer_khronos_validation.so)'
        env = {"VK_INSTANCE_LAYERS": VALIDATION_LAYER}
        clean = validation_status(env, proof)
        self.assertEqual(clean["validation_status"], "verified")
        self.assertEqual(clean["validation_errors"], 0)
        self.assertEqual(clean["validation_activation_proof"], [proof])
        broken = validation_status(env, proof + "\nValidation Error: [ VUID-example ]")
        self.assertEqual(broken["validation_errors"], 1)

    def test_failed_layer_overrides_insert_message(self):
        log = 'Insert instance layer "VK_LAYER_KHRONOS_validation"\nFailed to load VK_LAYER_KHRONOS_validation'
        status = validation_status({"VK_INSTANCE_LAYERS": VALIDATION_LAYER}, log)
        self.assertEqual(status["validation_status"], "unverified")
        self.assertIsNone(status["validation_errors"])
        self.assertEqual(len(status["validation_layer_failures"]), 1)


class CaptureCompletionTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name)
        self.capture = {"revision": "example-revision", "samples": [{}] * 20}
        self.data = json.dumps(self.capture).encode()
        self.png = image()
        self.marker = {
            "event": "capture_completed", "samples": 20,
            "revision": "example-revision", "json_bytes": len(self.data),
            "png_bytes": len(self.png),
        }
        (self.path / "vulkan-live.json").write_bytes(self.data)
        (self.path / "vulkan-live.png").write_bytes(self.png)

    def write_marker(self):
        (self.path / "vulkan-live.complete.json").write_text(json.dumps(self.marker))

    def test_files_existing_without_marker_are_incomplete(self):
        self.assertIsNone(read_completed_capture(self.path, 20))

    def test_partial_marker_and_json_wait_for_complete_write(self):
        (self.path / "vulkan-live.complete.json").write_text('{"event":')
        self.assertIsNone(read_completed_capture(self.path, 20))
        self.write_marker()
        (self.path / "vulkan-live.json").write_bytes(self.data[:-1])
        self.assertIsNone(read_completed_capture(self.path, 20))
        (self.path / "vulkan-live.json").write_bytes(self.data)
        self.assertEqual(read_completed_capture(self.path, 20), self.capture)

    def test_partial_png_and_wrong_length_wait_for_complete_write(self):
        self.write_marker()
        (self.path / "vulkan-live.png").write_bytes(self.png[:-5])
        self.assertIsNone(read_completed_capture(self.path, 20))
        (self.path / "vulkan-live.png").write_bytes(self.png)
        self.marker["json_bytes"] += 1
        self.write_marker()
        self.assertIsNone(read_completed_capture(self.path, 20))

    def test_full_length_corrupt_png_is_not_accepted(self):
        self.write_marker()
        damaged = bytearray(self.png)
        damaged[45] ^= 1
        (self.path / "vulkan-live.png").write_bytes(damaged)
        self.assertIsNone(read_completed_capture(self.path, 20))
        self.assertFalse(png_complete(self.png + b"partial tail"))

    def test_complete_capture_checks_revision_and_exact_bound(self):
        self.write_marker()
        self.assertEqual(read_completed_capture(self.path, 20), self.capture)
        with self.assertRaisesRegex(AssertionError, "bound mismatch"):
            read_completed_capture(self.path, 19)
        self.marker["revision"] = "other-revision"
        self.write_marker()
        with self.assertRaisesRegex(AssertionError, "revision mismatch"):
            read_completed_capture(self.path, 20)


if __name__ == "__main__":
    unittest.main()
