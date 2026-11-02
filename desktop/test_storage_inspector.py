import json
import os
import tempfile
import threading
import time
import unittest
from types import SimpleNamespace
from pathlib import Path
from unittest.mock import patch

from storage_inspector import inspect_storage, clear_storage_category

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
from PySide6.QtGui import QGuiApplication
import studio as studio_module
from studio import Session, Studio


class StorageInspectorTest(unittest.TestCase):
    def test_reports_only_known_categories_and_aggregated_sizes(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / "closed-notes" / "nested").mkdir(parents=True)
            (root / "closed-notes" / "nested" / "snapshot.json").write_bytes(b"12345")
            (root / "recovery.json").write_bytes(b"draft")
            (root / "derived-python").mkdir()
            (root / "derived-python" / "result.png").write_bytes(b"pixels")
            (root / "python-env" / "bin").mkdir(parents=True)
            (root / "python-env" / "bin" / "python").write_bytes(b"runtime")
            (root / "fonts").mkdir()
            (root / "fonts" / "custom.ttf").write_bytes(b"font")
            (root / "settings.json").write_bytes(b"{}!")
            (root / "outside-category").mkdir()
            (root / "outside-category" / "ignored.bin").write_bytes(b"not scanned")

            report = inspect_storage(root)
            categories = {row["id"]: row for row in report["categories"]}

            self.assertEqual(report["status"], "complete")
            self.assertEqual(categories["recovery"]["bytes"], 10)
            self.assertEqual(categories["recovery"]["files"], 2)
            self.assertEqual(categories["execution-results"]["bytes"], 6)
            self.assertEqual(categories["python-runtime"]["files"], 1)
            self.assertEqual(categories["fonts-themes"]["files"], 1)
            self.assertEqual(categories["workspace"]["bytes"], 3)
            self.assertNotIn("outside-category", json.dumps(report))
            self.assertNotIn(temporary, json.dumps(report))
            self.assertEqual(categories["recovery"]["classification"], "preserved")
            self.assertEqual(categories["execution-results"]["classification"], "clearable")

    @unittest.skipUnless(hasattr(os, "symlink"), "symlinks unavailable")
    def test_skips_symlinked_files_and_directories(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / "closed-notes").mkdir()
            outside = root / "outside"
            outside.mkdir()
            (outside / "secret").write_bytes(b"do not count")
            (root / "closed-notes" / "linked-dir").symlink_to(outside, target_is_directory=True)
            (root / "closed-notes" / "linked-file").symlink_to(outside / "secret")

            row = next(row for row in inspect_storage(root)["categories"] if row["id"] == "recovery")
            self.assertEqual((row["bytes"], row["files"]), (0, 0))

    def test_bounds_entries_and_depth_as_partial_not_complete(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            nested = root / "derived-python" / "a" / "b"
            nested.mkdir(parents=True)
            (nested / "result").write_bytes(b"x")

            limited = inspect_storage(root, max_entries=1)
            self.assertEqual(limited["status"], "partial")
            self.assertTrue(limited["truncated"])
            depth_limited = inspect_storage(root, max_depth=0)
            self.assertEqual(depth_limited["status"], "partial")
            self.assertEqual(next(row for row in depth_limited["categories"] if row["id"] == "execution-results")["files"], 0)

    def test_cancellation_returns_partial_report_and_never_mutates_data(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / "recovery.json").write_text("keep", encoding="utf-8")
            event = threading.Event()
            event.set()

            report = inspect_storage(root, event)
            self.assertEqual(report["status"], "partial")
            self.assertTrue(report["cancelled"])
            self.assertEqual((root / "recovery.json").read_text(encoding="utf-8"), "keep")

    def test_cleanup_only_disposable_categories(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "derived-python").mkdir()
            (root / "derived-python" / "temporary.svg").write_bytes(b"preview")
            (root / "updates").mkdir()
            (root / "updates" / "cached.json").write_text("cached")
            (root / "closed-notes").mkdir()
            (root / "closed-notes" / "critical.md").write_text("keep")
            (root / "settings.json").write_text("settings")
            self.assertTrue(clear_storage_category(root,"execution-results")["cleared"])
            self.assertFalse((root / "derived-python").exists())
            self.assertTrue((root / "closed-notes" / "critical.md").exists())
            self.assertTrue(clear_storage_category(root,"update-state")["cleared"])
            self.assertFalse((root / "updates").exists())
            for category in ("recovery","workspace","python-runtime", "../outside"):
                with self.assertRaises(ValueError):clear_storage_category(root,category)
            self.assertEqual((root / "settings.json").read_text(),"settings")

    def test_windows_cleanup_fallback_checks_reparse_points_without_following(self):
        # Simulate Windows' non-descriptor rmtree path on this Linux runner.
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp)
            target=root / "derived-python"
            target.mkdir()
            (target / "generated.svg").write_bytes(b"temporary")
            windows_os=SimpleNamespace(name="nt", walk=os.walk)
            with patch("storage_inspector.os",windows_os), patch("storage_inspector.shutil.rmtree.avoids_symlink_attacks",False):
                self.assertTrue(clear_storage_category(root,"execution-results")["cleared"])
            self.assertFalse(target.exists())
            target.mkdir()
            outside=root / "outside";outside.mkdir()
            (outside / "keep").write_text("safe")
            (target / "linked").symlink_to(outside,target_is_directory=True)
            with patch("storage_inspector.os",windows_os), patch("storage_inspector.shutil.rmtree.avoids_symlink_attacks",False):
                with self.assertRaises(ValueError):clear_storage_category(root,"execution-results")
            self.assertEqual((outside / "keep").read_text(),"safe")

    @unittest.skipUnless(hasattr(os,"symlink"),"symlinks unavailable")
    def test_cleanup_refuses_linked_root_or_target(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp) / "app";outside=Path(tmp) / "outside"
            root.mkdir();outside.mkdir()
            (outside / "protected").write_text("keep")
            (root / "derived-python").symlink_to(outside, target_is_directory=True)
            with self.assertRaises(ValueError):clear_storage_category(root,"execution-results")
            (Path(tmp) / "linked-root").symlink_to(root,target_is_directory=True)
            with self.assertRaises(ValueError):clear_storage_category(Path(tmp) / "linked-root","execution-results")
            self.assertEqual((outside / "protected").read_text(),"keep")

    def test_missing_app_data_is_an_empty_complete_inventory(self):
        with tempfile.TemporaryDirectory() as temporary:
            report = inspect_storage(Path(temporary) / "not-created")
        self.assertEqual(report["status"], "complete")
        self.assertTrue(all(row["bytes"] == row["files"] == 0 for row in report["categories"]))

    @classmethod
    def setUpClass(cls):
        cls.app = QGuiApplication.instance() or QGuiApplication(["storage inspector tests"])

    def test_studio_runs_inspection_off_ui_path_and_publishes_safe_report(self):
        session = Session(True)
        studio = Studio(True, session)
        report = inspect_storage(session.data)
        with patch.object(studio_module, "inspect_storage", return_value=report):
            studio.inspectStorage()
            deadline = time.monotonic() + 2
            while studio.storageBusy and time.monotonic() < deadline:
                self.app.processEvents()
                time.sleep(.005)
        self.assertFalse(studio.storageBusy)
        self.assertEqual(json.loads(studio.storageReport)["status"], "complete")
        self.assertFalse(studio.retired)
        studio.stop()
        studio.pool.shutdown(wait=True, cancel_futures=True)
        session.writes.shutdown(wait=True)


if __name__ == "__main__":
    unittest.main()
