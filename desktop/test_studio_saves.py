"""Focused unit tests for studio_saves: unified conflict checks, post-save sync, and export_destination."""
from __future__ import annotations

import base64
import hashlib
import json
import os
import shutil
import sys
import tempfile
import time
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
os.environ.setdefault("QT_QUICK_BACKEND", "software")
from PySide6.QtGui import QGuiApplication

import documents
import studio
import studio_saves
from documents import open_note, write_portable
from studio import Session, Studio

TINY_PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAX+XDSwAAAABJRU5ErkJggg=="
ALT_PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg=="
TINY_DATA_URL = f"data:image/png;base64,{TINY_PNG_B64}"
ALT_DATA_URL = f"data:image/png;base64,{ALT_PNG_B64}"


class StudioSavesTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.app = QGuiApplication.instance() or QGuiApplication([])

    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory(prefix="supermd-studio-saves-")
        self.root = Path(self.temp_dir.name).resolve()
        self.session = Session(isolated=True)
        self.session.settings["python"] = sys.executable
        self.session.settings["newNoteLocation"] = str(self.root)
        self.session.settings["autosave"] = False
        self.studio = Studio(isolated=True, session=self.session)
        self.studio.folder = str(self.root)
        deadline = time.monotonic() + 0.25
        while time.monotonic() < deadline and self.studio._theme_running:
            self.app.processEvents()
            time.sleep(0.005)
        self.app.processEvents()

    def tearDown(self):
        if not self.studio.retired:
            self.studio.stop()
        self.studio.pool.shutdown(wait=True)
        self.session.writes.shutdown(wait=True)
        shutil.rmtree(self.session.data, ignore_errors=True)
        self.temp_dir.cleanup()

    def _pump_until(self, predicate, timeout: float = 5.0) -> None:
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            self.app.processEvents()
            if predicate():
                return
            time.sleep(0.002)
        self.app.processEvents()
        self.assertTrue(predicate(), "Timed out waiting for async save completion")

    def _open_smd_tab(self, path: Path, text: str, assets: dict[str, str]) -> dict:
        write_portable(path, text, assets)
        tab = self.studio._note(path.name, text, str(path), text, dict(assets), True)
        self.studio.tabs = [tab]
        self.studio.active = tab["id"]
        return tab

    def test_save_text_manual_vs_automatic_conflict_and_decode_skip(self):
        note_path = self.root / "study.smd"
        tab = self._open_smd_tab(note_path, "# Initial\n", {"assets/fig.png": str(TINY_DATA_URL)})
        conflicts: list[str] = []
        self.studio.saveConflictRequested.connect(conflicts.append)

        tab["content"] = "# Updated\n"
        with patch.object(documents.base64, "b64decode", wraps=base64.b64decode) as b64_spy:
            self.studio._save_text(tab, note_path, automatic=False)
            self._pump_until(lambda: tab["id"] not in self.studio.saving and tab["saved"] == "# Updated\n")
            self.assertEqual(b64_spy.call_count, 0)
        self.assertIn(str(note_path), self.studio.note_file_stamps)
        self.assertFalse(tab["conflict"])

        write_portable(note_path, "# External edit\n", {"assets/fig.png": TINY_DATA_URL})
        tab["content"] = "# Local draft\n"
        self.studio._save_text(tab, note_path, automatic=True)
        self._pump_until(lambda: tab["id"] not in self.studio.saving and tab["conflict"])
        self.assertEqual(self.studio.message, studio_saves.AUTOSAVE_CONFLICT_MESSAGE)
        self.assertEqual(conflicts, [])

        tab["conflict"] = False
        self.studio._save_text(tab, note_path, automatic=False)
        self._pump_until(lambda: tab["id"] not in self.studio.saving and tab["conflict"])
        self.assertEqual(self.studio.message, studio_saves.MANUAL_CONFLICT_MESSAGE)
        self.assertEqual(conflicts, ["study.smd"])

        conflicts.clear()
        tab["conflict"] = False
        note_path.unlink()
        self.studio._save_text(tab, note_path, automatic=True)
        self._pump_until(lambda: tab["id"] not in self.studio.saving and tab["conflict"])
        self.assertEqual(conflicts, [])

        tab["conflict"] = False
        self.studio._save_text(tab, note_path, automatic=False)
        self._pump_until(lambda: tab["id"] not in self.studio.saving and note_path.is_file())
        self.assertFalse(tab["conflict"])
        self.assertEqual(open_note(note_path)[0], "# Local draft\n")

    def test_prepare_save_document_drift_checks_three_arg_patch_and_proxy(self):
        note_path = self.root / "agent.smd"
        tab = self._open_smd_tab(note_path, "# V1\n", {"assets/a.png": TINY_DATA_URL})
        tab["content"] = "# V2\n"
        rev = hashlib.sha256(tab["content"].encode("utf-8")).hexdigest()

        for mutate in (
            lambda: write_portable(note_path, "# Disk text drift\n", {"assets/a.png": TINY_DATA_URL}),
            lambda: write_portable(note_path, "# V1\n", {"assets/a.png": ALT_DATA_URL}),
            lambda: note_path.write_bytes(b"# Plain markdown masquerading as smd\n"),
        ):
            mutate()
            prepared = Studio._prepare_save_document(self.studio, {"tabId": tab["id"], "expectedRevision": rev})
            with self.assertRaisesRegex(ValueError, "changed outside Super MD"):
                Studio._run_prepared_write_sync(self.studio, prepared)
            write_portable(note_path, "# V1\n", {"assets/a.png": TINY_DATA_URL})

        three_arg_calls: list[Path] = []
        orig_write_portable = studio.write_portable

        def strict_three_arg_write_portable(path, markdown, assets):
            three_arg_calls.append(Path(path))
            return orig_write_portable(path, markdown, assets)

        save_as_dir = self.root / "exported"
        save_as_dir.mkdir()
        self.studio.settings["newNoteLocation"] = str(save_as_dir)
        with patch("studio.write_portable", side_effect=strict_three_arg_write_portable), \
             patch.object(self.session.workspace_links, "invalidate", wraps=self.session.workspace_links.invalidate) as inv_spy, \
             patch.object(self.studio, "_refresh_open_folder_trees", wraps=self.studio._refresh_open_folder_trees) as refresh_spy:
            res = Studio._run_prepared_write_sync(
                self.studio,
                Studio._prepare_save_document(self.studio, {"tabId": tab["id"], "expectedRevision": rev}),
            )
            self.assertFalse(res["pathChanged"])
            self.assertEqual(three_arg_calls, [note_path.resolve()])
            inv_spy.assert_not_called()
            refresh_spy.assert_not_called()

            res2 = Studio._run_prepared_write_sync(
                self.studio,
                Studio._prepare_save_document(
                    self.studio,
                    {"tabId": tab["id"], "expectedRevision": rev, "saveAs": True, "filename": "copy.smd"},
                ),
            )
            self.assertTrue(res2["pathChanged"])
            inv_spy.assert_called_once_with(save_as_dir.resolve())
            refresh_spy.assert_called_once_with(Path(res2["newPath"]), str(note_path.resolve()))

        proxy_md = self.root / "proxy.md"
        proxy_copy = self.root / "proxy-copy.md"
        proxy_md.write_text("old", encoding="utf-8")
        proxy_tab = {
            "id": "t1", "name": "proxy.md", "path": str(proxy_md), "content": "new",
            "saved": "old", "assets": {}, "saved_assets": {}, "assets_dirty": False, "portable": False,
        }
        proxy = SimpleNamespace(
            window_id="w1", tabs=[proxy_tab], active="t1", saving=set(),
            note_file_stamps={}, _agent_open_paths=set(), _agent_owned_files=set(),
            settings={"autosave": False}, _recover=lambda: None, _emit=lambda *a, **k: None,
            _agent_export_path=lambda _fn, _fmt, _tab: (proxy_copy.write_bytes(b""), proxy_copy)[1],
        )
        new_rev = hashlib.sha256(b"new").hexdigest()
        out = Studio._run_prepared_write_sync(proxy, Studio._prepare_save_document(proxy, {"tabId": "t1", "expectedRevision": new_rev}))
        self.assertEqual(proxy_md.read_text(encoding="utf-8"), "new")
        self.assertEqual(out["newPath"], str(proxy_md.resolve()))
        out_copy = Studio._run_prepared_write_sync(
            proxy,
            Studio._prepare_save_document(proxy, {"tabId": "t1", "expectedRevision": new_rev, "saveAs": True, "filename": "proxy-copy.md"}),
        )
        self.assertTrue(out_copy["pathChanged"])
        self.assertEqual(proxy_copy.read_text(encoding="utf-8"), "new")

    def test_export_fmd_native_conflict_overwrite_and_save_as_sync(self):
        note_path = self.root / "portable.smd"
        preserved_str = "data:image/png;base64," + "".join([TINY_PNG_B64])
        tab = self._open_smd_tab(note_path, "# Base\n", {"assets/keep.png": preserved_str})
        self.studio.ready = True

        replies: list[tuple[str, str, str]] = []
        conflicts: list[str] = []
        reader_calls: list[str] = []
        self.studio.replied.connect(lambda rid, res, err: replies.append((rid, res, err)))
        self.studio.saveConflictRequested.connect(conflicts.append)
        self.studio.readerCall.connect(reader_calls.append)

        write_portable(note_path, "# Disk changed\n", {"assets/keep.png": preserved_str})
        tab["content"] = "# Reader edit\n"
        payload = {"save": True, "content": "# Reader edit\n", "originalContent": "# Reader edit\n",
                   "assets": {"assets/keep.png": str(TINY_DATA_URL)}}
        self.studio._post("r1", "export_fmd_native", json.dumps(payload))
        self._pump_until(lambda: len(replies) == 1)
        self.assertEqual(json.loads(replies[0][1]), {"saved": False, "conflict": True})
        self.assertEqual(conflicts, ["portable.smd"])
        self.assertTrue(tab["conflict"])

        self.studio.resolveConflict("overwrite")
        self.assertTrue(self.studio.flush_operation and self.studio.flush_operation["action"] == "overwrite_conflict")
        op = self.studio.flush_operation
        self.studio.flush_operation = None
        self.studio._after_flush(op)
        self.assertIn(tab["id"], self.studio._force_overwrite_ids)
        self.assertIn("window.supermdPortable?.(true)", reader_calls)

        with patch.object(self.session.reader_assets, "revoke_tab", wraps=self.session.reader_assets.revoke_tab) as revoke_spy:
            overwrite_payload = {
                "save": True, "content": "# Reader edit\n", "originalContent": "# Reader edit\n",
                "assets": {"assets/keep.png": TINY_DATA_URL + "", "assets/added.png": ALT_DATA_URL},
            }
            self.studio._post("r2", "export_fmd_native", json.dumps(overwrite_payload))
            self._pump_until(lambda: len(replies) == 2)
            revoke_spy.assert_called_once_with(self.studio.window_id, tab["id"])
        self.assertFalse(tab["conflict"])
        self.assertIs(tab["assets"]["assets/keep.png"], preserved_str)
        self.assertEqual(open_note(note_path)[0], "# Reader edit\n")

        same_copy_str = tab["assets"]["assets/keep.png"]
        self.studio.saveAs(str(note_path))
        same_save_as_payload = {
            "save": False, "content": "# Same path save-as\n", "originalContent": "# Reader edit\n",
            "assets": {"assets/keep.png": TINY_DATA_URL + ""},
        }
        self.studio._post("r3", "export_fmd_native", json.dumps(same_save_as_payload))
        self._pump_until(lambda: len(replies) == 3)
        self.assertIs(tab["assets"]["assets/keep.png"], same_copy_str)

        sub = self.root / "nested"
        sub.mkdir()
        dest = sub / "renamed.smd"
        with patch.object(self.session.workspace_links, "invalidate", wraps=self.session.workspace_links.invalidate) as inv_spy, \
             patch.object(self.studio, "_refresh_open_folder_trees", wraps=self.studio._refresh_open_folder_trees) as refresh_spy:
            self.studio.saveAs(str(dest))
            self.studio._post("r4", "export_fmd_native", json.dumps(same_save_as_payload))
            self._pump_until(lambda: len(replies) == 4)
            inv_spy.assert_called_once_with(sub)
            refresh_spy.assert_called_once_with(str(dest))
        self.assertEqual(tab["path"], str(dest))
        self.assertEqual(self.studio.recent[0], str(dest))
        self.assertIn(str(dest.resolve()), self.studio._agent_open_paths)
        self.assertEqual(self.studio.pending_save_as, "")

        md_save_as = sub / "renamed-copy.md"
        exported_smd = sub / "standalone.smd"
        exported_md = sub / "standalone.md"
        exported_zip = sub / "bundle.zip"
        with patch.object(self.studio, "_refresh_open_folder_trees", wraps=self.studio._refresh_open_folder_trees) as refresh_spy:
            self.studio._save_text(tab, md_save_as, automatic=False, force_overwrite=True)
            self._pump_until(lambda: tab["id"] not in self.studio.saving and tab["path"] == str(md_save_as))
            refresh_spy.assert_called_once_with(md_save_as, str(dest))
            refresh_spy.reset_mock()

            self.studio.exportTo(str(exported_smd), "smd")
            self.studio._post("r5", "export_fmd_native", json.dumps({"save": False, "content": "# Export\n", "assets": {}}))
            self._pump_until(lambda: len(replies) == 5)
            refresh_spy.assert_called_once_with(str(exported_smd))
            self.assertEqual(self.studio.message, "Exported standalone.smd")
            refresh_spy.reset_mock()

            self.studio.exportTo(str(exported_md), "md")
            self.studio._post("r6", "export_markdown_native", json.dumps({"archive": False, "content": "# Export\n", "assets": {}}))
            self._pump_until(lambda: len(replies) == 6)
            refresh_spy.assert_called_once_with(str(exported_md))
            self.assertEqual(self.studio.message, "Exported standalone.md")
            refresh_spy.reset_mock()

            self.studio.exportTo(str(exported_zip), "mdzip")
            self.studio._post("r7", "export_markdown_native", json.dumps({"archive": True, "content": "# Export\n", "assets": {}}))
            self._pump_until(lambda: len(replies) == 7)
            refresh_spy.assert_not_called()
            self.assertEqual(self.studio.message, "Exported bundle.zip")

    def test_export_destination_edge_cases_and_local_path_lookup(self):
        with self.assertRaisesRegex(ValueError, "Legacy .fmd"):
            studio.export_destination(str(self.root / "old.fmd"), "smd")
        for bad_name, fmt in (
            ("out.pdf", "smd"), ("out.smd", "pdf"), ("out.md", "pdf"),
            ("out.markdown", "smd"), ("out.txt", "mdzip"), ("out.zip", "md"),
        ):
            with self.assertRaisesRegex(ValueError, "Choose a filename ending in"):
                studio.export_destination(str(self.root / bad_name), fmt)
        with self.assertRaisesRegex(ValueError, "Unsupported export format"):
            studio.export_destination(str(self.root / "out.html"), "html")
        with self.assertRaisesRegex(ValueError, "Choose a file destination"):
            studio.export_destination(str(self.root), "pdf")

        dotted = self.root / "release.v1.2"
        self.assertEqual(studio.export_destination(str(dotted), "pdf"), self.root / "release.v1.2.pdf")
        (self.root / "release.v1.2.pdf").write_bytes(b"%PDF-1.4")
        with self.assertRaisesRegex(ValueError, "already exists"):
            studio.export_destination(str(dotted), "pdf")
        self.assertEqual(studio.export_destination(str(self.root / "release.v1.2.pdf"), "pdf"), self.root / "release.v1.2.pdf")

        redirected = self.root / "via_patch.smd"
        with patch("studio.local_path", MagicMock(return_value=redirected)) as lp_mock:
            self.assertEqual(studio.export_destination("file:///ignored", "smd"), redirected)
            lp_mock.assert_called_once_with("file:///ignored")


if __name__ == "__main__":
    unittest.main()
