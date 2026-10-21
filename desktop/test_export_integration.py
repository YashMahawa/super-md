"""Native Studio PDF-command integration with a private synthetic engine."""
import json
import os
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
from PySide6.QtGui import QGuiApplication
from PySide6.QtCore import QUrl

from studio import Session, Studio


FAKE_ENGINE = '''#!/usr/bin/env python3
import json, os, signal, sys, time
from pathlib import Path

request = json.load(sys.stdin)
stage = Path(sys.argv[2])
mode = request.get("testMode")
if mode == "hang":
    signal.signal(signal.SIGTERM, signal.SIG_IGN)
    rust_temp = stage.with_name(f".{stage.name}.{os.getpid()}.tmp")
    rust_temp.write_bytes(b"owned rust temp")
    Path(request["testMarker"]).write_text("started", encoding="utf-8")
    while True:
        time.sleep(0.05)
elif mode == "invalid":
    stage.write_bytes(b"not a PDF")
elif mode == "valid":
    stage.write_bytes(b"%PDF-1.7\\nsynthetic fixture\\n")
else:
    raise SystemExit("unexpected fake engine mode")
'''


class QuietStudio(Studio):
    def _refresh_theme(self):
        self.system_dark = True


@unittest.skipUnless(os.name == "posix", "fake executable/signal behavior requires POSIX")
class NativePdfIntegrationTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.app = QGuiApplication.instance() or QGuiApplication(["native PDF integration tests"])

    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="supermd-pdf-integration-")
        self.addCleanup(self.temporary.cleanup)
        # macOS exposes its temporary directory through /var -> /private/var.
        # Native file URLs are canonicalized; compare the same actual location.
        self.root = Path(self.temporary.name).resolve()
        self.engine = self.root / "owned-fake-smd-engine"
        self.engine.write_text(FAKE_ENGINE, encoding="utf-8")
        self.engine.chmod(0o700)
        self.session = Session(True)
        self.studio = QuietStudio(True, self.session)
        self.studio._engine = lambda: self.engine
        self._font_patch = patch.object(self.session.font_store, "pdf_assets", return_value={})
        self._font_patch.start()
        self.addCleanup(self._font_patch.stop)
        self.replies = []
        self.studio.replied.connect(lambda identifier, value, error: self.replies.append((identifier, value, error)))

    def tearDown(self):
        self.studio.stop()
        self.studio.pool.shutdown(wait=True, cancel_futures=True)
        self.session.writes.shutdown(wait=True)
        self.app.processEvents()

    def _start_export(self, destination, job_id, mode, **extra):
        self.studio.pending_export = str(destination)
        args = {
            "jobId": job_id,
            "content": "# Synthetic PDF fixture",
            "assets": {},
            "options": {"fontFamily": "Fixture Sans"},
            "testMode": mode,
            **extra,
        }
        self.studio.post(job_id + "-request", "export_pdf_native", json.dumps(args))

    def _await_reply(self, identifier, timeout=5):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            self.app.processEvents()
            matching = [reply for reply in self.replies if reply[0] == identifier]
            if matching:
                return matching[-1]
            time.sleep(.005)
        self.fail(f"Timed out waiting for native reply {identifier!r}")

    def _assert_no_owned_stages(self):
        self.assertEqual(list(self.root.glob(".*.stage.pdf")), [])
        self.assertEqual(list(self.root.glob(".*.stage.pdf.*.tmp")), [])

    def test_valid_pdf_is_promoted_and_registry_entry_is_discarded(self):
        destination = self.root / "report.pdf"
        self._start_export(destination, "valid-job", "valid")

        _, raw, error = self._await_reply("valid-job-request")
        self.assertEqual(error, "")
        self.assertEqual(json.loads(raw), {"path": str(destination)})
        self.assertTrue(destination.read_bytes().startswith(b"%PDF-"))
        self._assert_no_owned_stages()
        self.assertEqual(self.studio._export_jobs._jobs, {})

    def test_export_to_extensionless_url_reaches_the_pdf_writer_with_safe_final_name(self):
        stem = self.root / "Research Notes Ω literal%20.v4"
        destination = Path(str(stem) + ".pdf")
        self.studio.exportTo(QUrl.fromLocalFile(str(stem)).toString(), "pdf")
        self.assertEqual(self.studio.pending_export, str(destination))
        args = {
            "jobId": "export-to-url-job",
            "content": "# Synthetic PDF fixture",
            "assets": {},
            "options": {"fontFamily": "Fixture Sans"},
            "testMode": "valid",
        }
        self.studio.post("export-to-url-request", "export_pdf_native", json.dumps(args))
        _, raw, error = self._await_reply("export-to-url-request")
        self.assertEqual(error, "")
        self.assertEqual(json.loads(raw), {"path": str(destination)})
        self.assertTrue(destination.read_bytes().startswith(b"%PDF-"))
        self.assertFalse(Path(str(stem) + ".smd").exists())
        self._assert_no_owned_stages()

    def test_overlapping_export_selection_keeps_the_original_destination(self):
        first = self.root / "First.pdf"
        second = self.root / "Second.smd"
        self.studio.exportTo(QUrl.fromLocalFile(str(first)).toString(), "pdf")
        self.studio.exportTo(QUrl.fromLocalFile(str(second)).toString(), "smd")
        self.assertEqual(self.studio.pending_export, str(first))
        self.assertIn("already in progress", self.studio.message)
        self.assertFalse(second.exists())

    def test_cross_format_callbacks_never_write_to_the_selected_file(self):
        for command, suffix in (("export_pdf_native", ".smd"), ("export_fmd_native", ".pdf"), ("export_markdown_native", ".smd")):
            destination = self.root / (command + suffix)
            destination.write_bytes(b"preserve existing document")
            self.studio.pending_export = str(destination)
            identifier = command + "-stale"
            self.studio.post(identifier, command, json.dumps({"content": "wrong format", "assets": {}, "save": False}))
            _, raw, error = self._await_reply(identifier)
            self.assertEqual(raw, "null")
            self.assertIn("does not match", error)
            self.assertEqual(destination.read_bytes(), b"preserve existing document")
            self.assertEqual(self.studio._export_jobs._jobs, {})

    def test_invalid_pdf_does_not_overwrite_existing_destination(self):
        destination = self.root / "report.pdf"
        destination.write_bytes(b"pre-existing bytes")
        self._start_export(destination, "invalid-job", "invalid")

        _, raw, error = self._await_reply("invalid-job-request")
        self.assertEqual(raw, "null")
        self.assertEqual(error, "PDF export produced an invalid file")
        self.assertEqual(destination.read_bytes(), b"pre-existing bytes")
        self._assert_no_owned_stages()
        self.assertEqual(self.studio._export_jobs._jobs, {})

    def test_cancel_kills_sigterm_ignoring_process_and_preserves_destination(self):
        destination = self.root / "report.pdf"
        destination.write_bytes(b"pre-existing bytes")
        marker = self.root / "engine-started"
        self._start_export(destination, "cancel-job", "hang", testMarker=str(marker))
        deadline = time.monotonic() + 3
        while not marker.exists() and time.monotonic() < deadline:
            self.app.processEvents()
            time.sleep(.005)
        self.assertTrue(marker.exists(), "fake engine never reached its owned process loop")

        started = time.monotonic()
        self.studio.post("cancel-reply", "cancel_export", json.dumps({"jobId": "cancel-job"}))
        _, cancel_raw, cancel_error = self._await_reply("cancel-reply")
        self.assertEqual(cancel_error, "")
        self.assertEqual(json.loads(cancel_raw), {"cancelled": True})
        _, export_raw, export_error = self._await_reply("cancel-job-request", timeout=4)
        elapsed = time.monotonic() - started

        self.assertLess(elapsed, 3.5, f"cancellation took {elapsed:.2f}s")
        self.assertEqual(export_raw, "null")
        self.assertEqual(export_error, "PDF export cancelled")
        self.assertEqual(destination.read_bytes(), b"pre-existing bytes")
        self._assert_no_owned_stages()
        self.assertEqual(self.studio._export_jobs._jobs, {})
        self.assertEqual(self.studio.busy, 0)


if __name__ == "__main__":
    unittest.main()
