from __future__ import annotations

import hashlib
import base64
import os
import tempfile
import time
import unittest
from pathlib import Path

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
os.environ.setdefault("QT_QUICK_BACKEND", "software")

from PySide6.QtGui import QGuiApplication
from studio import Session, Studio
from documents import open_note, write_portable


class QuietStudio(Studio):
    def _refresh_theme(self):
        self.system_dark = True


class AgentSessionIntegrityTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.app = QGuiApplication.instance() or QGuiApplication(["Super MD agent session tests"])

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.session = Session(True)
        self.studio = QuietStudio(True, self.session)
        self.studio.settings["newNoteLocation"] = str(self.root)

    def tearDown(self):
        self.studio.stop()
        self.studio.pool.shutdown(wait=True, cancel_futures=True)
        self.session.writes.shutdown(wait=True)
        self.app.processEvents()
        self.temp.cleanup()

    def _tab_for(self, path: Path):
        content, assets, portable = open_note(path)
        tab = self.studio._note(path.name, content, str(path), content, assets, portable)
        self.studio.tabs.append(tab)
        self.studio.active = tab["id"]
        self.studio._agent_open_paths.add(str(path.resolve()))
        return tab

    def _save(self, tab, **extra):
        return self.studio._agent_document_action({
            "action": "save_document", "tabId": tab["id"],
            "expectedRevision": hashlib.sha256(tab["content"].encode()).hexdigest(), **extra,
        })

    def _await_closed(self, tab_id):
        deadline = time.monotonic() + 3
        while any(tab["id"] == tab_id for tab in self.studio.tabs) and time.monotonic() < deadline:
            self.app.processEvents()
            time.sleep(0.005)
        self.assertFalse(any(tab["id"] == tab_id for tab in self.studio.tabs))

    def _register_export(self, path: Path, job_id: str, fmt: str, data: bytes):
        path.write_bytes(data)
        info = path.stat()
        self.studio._agent_job_records[job_id] = {
            "jobId": job_id, "action": "export_document", "status": "completed",
            "filename": path.name, "format": fmt, "path": str(path), "bytes": len(data),
            "sha256": hashlib.sha256(data).hexdigest(),
            "_fingerprint": {"device": info.st_dev, "inode": info.st_ino,
                             "size": info.st_size, "mtimeNs": info.st_mtime_ns},
        }

    def test_save_existing_markdown_updates_original_path_without_copying(self):
        path = self.root / "original.md"
        path.write_text("# Old\n", encoding="utf-8")
        tab = self._tab_for(path)
        tab["content"] = "# Updated\n"

        result = self._save(tab)

        canonical_path = str(path.resolve())
        self.assertEqual(result["path"], canonical_path)
        self.assertFalse(result["pathChanged"])
        self.assertEqual((result["oldPath"], result["newPath"]), (canonical_path, canonical_path))
        self.assertEqual(path.read_text(encoding="utf-8"), "# Updated\n")
        self.assertEqual(tab["path"], canonical_path)
        self.assertEqual(list(self.root.glob("original (*).md")), [])

    def test_save_existing_portable_note_updates_text_and_unsaved_assets_in_place(self):
        path = self.root / "portable.smd"
        svg = "<svg xmlns=\"http://www.w3.org/2000/svg\"><text>kept</text></svg>".encode()
        assets = {"assets/diagram.svg": "data:image/svg+xml;base64," + base64.b64encode(svg).decode()}
        replacement_svg = "<svg xmlns=\"http://www.w3.org/2000/svg\"><text>updated</text></svg>".encode()
        revised_assets = {"assets/diagram.svg": "data:image/svg+xml;base64," + base64.b64encode(replacement_svg).decode()}
        write_portable(path, "# Before\n", assets)
        tab = self._tab_for(path)
        tab["content"] = "# After\n"
        tab["assets"] = revised_assets

        result = self._save(tab)

        content, saved_assets, portable = open_note(path)
        canonical_path = str(path.resolve())
        self.assertEqual(result["path"], canonical_path)
        self.assertFalse(result["pathChanged"])
        self.assertEqual((content, saved_assets, portable), ("# After\n", revised_assets, True))
        self.assertEqual(tab["path"], canonical_path)
        self.assertEqual(tab["saved_assets"], revised_assets)

    def test_save_portable_copy_as_markdown_materializes_image_assets(self):
        path = self.root / "portable-source.smd"
        png = base64.b64decode(
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lS8AAAAASUVORK5CYII=")
        assets = {"assets/diagram.png": "data:image/png;base64," + base64.b64encode(png).decode("ascii")}
        content = "# Portable figure\n\n![diagram](assets/diagram.png)\n"
        write_portable(path, content, assets)
        tab = self._tab_for(path)

        result = self._save(tab, filename="markdown-copy.md", saveAs=True, format="md")

        target = Path(result["path"])
        self.assertEqual(target.name, "markdown-copy.md")
        self.assertTrue(result["pathChanged"])
        self.assertEqual(target.read_text(encoding="utf-8"), content)
        self.assertEqual((target.parent / "assets" / "diagram.png").read_bytes(), png)
        reopened_content, reopened_assets, reopened_portable = open_note(target)
        self.assertEqual(reopened_content, content)
        self.assertEqual(reopened_assets, {})
        self.assertFalse(reopened_portable)
        self.assertEqual(open_note(path), (content, assets, True))

    def test_saving_empty_untitled_markdown_keeps_markdown_extension(self):
        tab = self.studio._note("Untitled.md", "", "", "", {}, False)
        self.studio.tabs.append(tab)

        result = self._save(tab)

        self.assertEqual(result["format"], "md")
        self.assertEqual(Path(result["path"]).name, "Untitled.md")
        self.assertEqual(Path(result["path"]).read_text(encoding="utf-8"), "")

    def test_export_chunks_roundtrip_formats_and_metadata_without_paths(self):
        artifacts = [
            ("résumé draft.pdf", "pdf", b"%PDF-1.7\n" + bytes(range(256)) * 3, "application/pdf"),
            ("note with spaces.smd", "smd", b"PK\x03\x04portable-notes", "application/x-supermd"),
            ("日本語.md", "md", "# Café 🧪\nbody\n".encode("utf-8"), "text/markdown"),
        ]
        for index, (filename, fmt, data, mime) in enumerate(artifacts):
            with self.subTest(format=fmt):
                path = self.root / filename
                job_id = f"export-{index}"
                self._register_export(path, job_id, fmt, data)
                self.assertTrue(self.studio._agent_job_status(job_id)["downloadable"])
                pieces = []
                offset = 0
                while True:
                    chunk = self.studio._agent_export_chunk(job_id, offset, 173)
                    self.assertEqual(chunk["filename"], filename)
                    self.assertEqual(chunk["format"], fmt)
                    self.assertEqual(chunk["mimeType"], mime)
                    self.assertEqual(chunk["bytes"], len(data))
                    self.assertEqual(chunk["sha256"], hashlib.sha256(data).hexdigest())
                    self.assertNotIn("path", chunk)
                    self.assertEqual(chunk["offset"], offset)
                    part = base64.b64decode(chunk["body"], validate=True)
                    pieces.append(part)
                    if chunk["nextOffset"] is None:
                        break
                    self.assertEqual(chunk["nextOffset"], offset + len(part))
                    offset = chunk["nextOffset"]
                self.assertEqual(b"".join(pieces), data)

    def test_export_chunks_require_completed_export_and_unchanged_file(self):
        data = b"completed artifact"
        path = self.root / "export.pdf"
        job_id = "registered-export"
        self._register_export(path, job_id, "pdf", data)
        self.studio._agent_job_records["opened-note"] = {
            "jobId": "opened-note", "action": "open_document", "status": "completed",
            "path": str(path), "format": "md", "bytes": len(data),
        }
        self.assertNotIn("downloadable", self.studio._agent_job_status("opened-note"))
        with self.assertRaisesRegex(ValueError, "unavailable or is not an export"):
            self.studio._agent_export_chunk("unknown")
        with self.assertRaisesRegex(ValueError, "unavailable or is not an export"):
            self.studio._agent_export_chunk("opened-note")
        with self.assertRaisesRegex(ValueError, "not completed"):
            self.studio._agent_job_records[job_id]["status"] = "running"
            self.studio._agent_export_chunk(job_id)
        self.studio._agent_job_records[job_id]["status"] = "completed"
        with self.assertRaisesRegex(ValueError, "offset must be between"):
            self.studio._agent_export_chunk(job_id, len(data) + 1)
        with self.assertRaisesRegex(ValueError, "limit must be between"):
            self.studio._agent_export_chunk(job_id, 0, 524_289)
        with self.assertRaisesRegex(ValueError, "offset must be a nonnegative"):
            self.studio._agent_export_chunk(job_id, True)
        path.write_bytes(b"changed artifact length")
        with self.assertRaisesRegex(ValueError, "changed after completion"):
            self.studio._agent_export_chunk(job_id)

    def test_outside_change_blocks_in_place_save_and_preserves_both_versions(self):
        path = self.root / "external.md"
        path.write_text("# Original\n", encoding="utf-8")
        tab = self._tab_for(path)
        tab["content"] = "# Agent draft\n"
        path.write_text("# External edit\n", encoding="utf-8")

        with self.assertRaisesRegex(ValueError, "changed outside Super MD"):
            self._save(tab)

        self.assertEqual(path.read_text(encoding="utf-8"), "# External edit\n")
        self.assertEqual(tab["content"], "# Agent draft\n")

    def test_explicit_save_as_uses_new_target_without_overwriting_existing_file(self):
        source = self.root / "source.md"
        source.write_text("# Source\n", encoding="utf-8")
        occupied = self.root / "taken.md"
        occupied.write_text("# Keep\n", encoding="utf-8")
        tab = self._tab_for(source)
        tab["content"] = "# Saved elsewhere\n"

        result = self._save(tab, filename="taken.md")

        self.assertTrue(result["pathChanged"])
        self.assertEqual(result["oldPath"], str(source.resolve()))
        self.assertEqual(result["newPath"], result["path"])
        self.assertEqual(occupied.read_text(encoding="utf-8"), "# Keep\n")
        self.assertEqual(Path(result["path"]).read_text(encoding="utf-8"), "# Saved elsewhere\n")
        self.assertEqual(source.read_text(encoding="utf-8"), "# Source\n")

    def test_inactive_document_can_be_saved_without_stealing_focus(self):
        path = self.root / "inactive.md"
        path.write_text("# Before\n", encoding="utf-8")
        target = self._tab_for(path)
        target["content"] = "# Saved inactive\n"
        active = self.studio._note("Active.md", "# Keep active\n", "", "# Keep active\n")
        self.studio.tabs.append(active)
        self.studio.active = active["id"]

        result = self._save(target)

        self.assertEqual(result["path"], str(path.resolve()))
        self.assertEqual(path.read_text(encoding="utf-8"), "# Saved inactive\n")
        self.assertEqual(self.studio.active, active["id"])

    def test_agent_save_fails_fast_while_gui_autosave_is_in_flight(self):
        path = self.root / "busy.md"
        path.write_text("# Saved snapshot\n", encoding="utf-8")
        tab = self._tab_for(path)
        tab["content"] = "# Current draft\n"
        # Rejected saves must retain even a noncanonical, valid path spelling.
        # This also exercises the macOS /var and Windows short-path invariant
        # on platforms whose temporary directory has no built-in alias.
        tab["path"] = str(path.parent) + os.sep + "." + os.sep + path.name
        original_path = tab["path"]
        original_saved = tab["saved"]
        original_content = tab["content"]
        self.studio.saving.add(tab["id"])
        try:
            for options in ({}, {"filename": "copy.md", "saveAs": True}):
                with self.subTest(options=options):
                    with self.assertRaisesRegex(ValueError, "save is already in progress"):
                        self._save(tab, **options)
                    self.assertEqual(path.read_text(encoding="utf-8"), "# Saved snapshot\n")
                    self.assertEqual(tab["path"], original_path)
                    self.assertEqual(tab["saved"], original_saved)
                    self.assertEqual(tab["content"], original_content)
                    self.assertFalse((self.root / "copy.md").exists())
        finally:
            self.studio.saving.discard(tab["id"])

    def test_failed_markdown_save_as_removes_only_its_empty_reserved_target(self):
        path = self.root / "portable.smd"
        svg = b"<svg xmlns=\"http://www.w3.org/2000/svg\"><text>note</text></svg>"
        assets = {"assets/diagram.svg": "data:image/svg+xml;base64," + base64.b64encode(svg).decode()}
        write_portable(path, "# Figure\n", assets)
        target_asset = self.root / "assets" / "diagram.svg"
        target_asset.parent.mkdir()
        target_asset.write_bytes(b"unrelated asset")
        tab = self._tab_for(path)
        tab["content"] = "# Edited figure\n"
        before = (tab["path"], tab["name"], tab["saved"], dict(tab["assets"]))

        with self.assertRaisesRegex(ValueError, "unrelated image already exists"):
            self._save(tab, filename="copy.md", saveAs=True, format="md")

        reserved = self.root / "copy.md"
        self.assertFalse(reserved.exists())
        self.assertEqual(target_asset.read_bytes(), b"unrelated asset")
        self.assertEqual((tab["path"], tab["name"], tab["saved"], tab["assets"]), before)

    def test_create_background_keeps_active_tab_and_returns_naming_metadata(self):
        active = self.studio._current()
        result = self.studio._agent_document_action({
            "action": "create_document", "filename": "scratch.smd", "content": "# Draft\n",
            "background": True,
        })

        created = next(tab for tab in self.studio.tabs if tab["id"] == result["tabId"])
        self.assertEqual(self.studio.active, active["id"])
        self.assertFalse(result["active"])
        self.assertEqual((result["path"], result["format"], result["sourceLength"]), ("", "smd", 8))
        self.assertEqual(created["name"], "scratch.smd")
        self.assertFalse((self.root / "scratch.smd").exists())

    def test_invalid_background_flags_fail_before_create_or_open_mutation(self):
        original = self.studio._current()
        count = len(self.studio.tabs)
        with self.assertRaisesRegex(ValueError, "background must be a boolean"):
            self.studio._agent_document_action({"action": "create_document", "content": "# Nope", "background": "yes"})
        self.assertEqual(len(self.studio.tabs), count)
        self.assertEqual(self.studio.active, original["id"])

        path = self.root / "should-not-open.md"
        path.write_text("# No\n", encoding="utf-8")
        with self.assertRaisesRegex(ValueError, "background must be a boolean"):
            self.studio._agent_document_action({"action": "open_document", "filename": str(path), "background": 1})
        self.assertEqual(len(self.studio.tabs), count)
        self.assertEqual(self.studio.active, original["id"])
        self.assertNotIn(str(path.resolve()), self.studio._agent_open_paths)

    def test_activate_document_switches_to_existing_draft_without_losing_content(self):
        original = self.studio._current()
        draft = self.studio._note("Draft.md", "# Kept draft\n", "", "")
        self.studio.tabs.append(draft)

        result = self.studio._agent_document_action({"action": "activate_document", "tabId": draft["id"]})

        self.assertEqual(self.studio.active, draft["id"])
        self.assertEqual(draft["content"], "# Kept draft\n")
        self.assertEqual(result["revision"], hashlib.sha256(draft["content"].encode()).hexdigest())
        self.assertTrue(result["active"])
        self.assertNotEqual(self.studio.active, original["id"])

    def test_open_background_accepts_approved_root_and_rejects_symlink(self):
        note_path = self.root / "readable.md"
        note_path.write_text("# Read me\n", encoding="utf-8")
        original = self.studio._current()
        result = self.studio._agent_document_action({
            "action": "open_document", "filename": str(note_path), "background": True,
        })
        self.assertEqual(result["status"], "opening")
        self.assertFalse(result["active"])
        canonical_note_path = str(note_path.resolve())

        deadline = time.monotonic() + 3
        while not any(tab["path"] == canonical_note_path for tab in self.studio.tabs) and time.monotonic() < deadline:
            self.app.processEvents()
            time.sleep(0.005)
        self.assertTrue(any(tab["path"] == canonical_note_path for tab in self.studio.tabs))
        self.assertEqual(self.studio.active, original["id"])
        job = self.studio._agent_job_status(result["jobId"])
        self.assertEqual(job["status"], "completed")
        self.assertEqual(job["path"], canonical_note_path)
        self.assertEqual(job["sourceLength"], len("# Read me\n"))
        self.assertEqual(job["revision"], hashlib.sha256(b"# Read me\n").hexdigest())
        self.assertFalse(job["active"])
        outside = Path(self.temp.name).parent / (Path(self.temp.name).name + "-outside.md")
        outside.write_text("# Outside\n", encoding="utf-8")
        link = self.root / "escape.md"
        try:
            link.symlink_to(outside)
            with self.assertRaisesRegex(ValueError, "approved agent note roots"):
                self.studio._agent_document_action({"action": "open_document", "filename": str(link), "background": True})
        finally:
            outside.unlink(missing_ok=True)

    def test_patch_tab_edits_inactive_native_buffer_without_focus_change(self):
        active = self.studio._current()
        target = self.studio._note("Inactive.md", "# Before\n", "", "# Before\n")
        self.studio.tabs.append(target)
        expected = hashlib.sha256(target["content"].encode()).hexdigest()

        result = self.studio._agent_document_action({
            "action": "patch_tab", "tabId": target["id"], "expectedRevision": expected,
            "operations": [{"type": "replace", "old": "Before", "new": "After"}],
        })

        self.assertEqual(self.studio.active, active["id"])
        self.assertEqual(target["content"], "# After\n")
        self.assertEqual(result["applied"], 1)
        self.assertEqual(result["sourceLength"], len(target["content"]))
        self.assertEqual(result["operation_results"][0]["operationIndex"], 0)

    def test_close_requires_revision_and_preserves_discarded_dirty_note(self):
        tab = self.studio._current()
        tab["name"] = "Draft.md"
        tab["content"] = "# Unsaved\n"
        revision = hashlib.sha256(tab["content"].encode()).hexdigest()

        with self.assertRaisesRegex(ValueError, "unsaved changes"):
            self.studio._agent_document_action({"action": "close_document", "tabId": tab["id"],
                                                "expectedRevision": revision})
        response = self.studio._agent_document_action({"action": "close_document", "tabId": tab["id"],
                                                       "expectedRevision": revision, "discardChanges": True})

        self.assertIn(response["status"], ("closing", "closed"))
        self._await_closed(tab["id"])
        self.assertNotEqual(self.studio.active, tab["id"])
        self.assertTrue(self.studio.tabs, "closing the last note leaves an untitled tab")


if __name__ == "__main__":
    unittest.main()
