"""Unit tests for studio_exports and preserved Studio save/durability invariants."""
from __future__ import annotations

import base64
import hashlib
import json
import os
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
from PySide6.QtGui import QGuiApplication

import studio
import studio_exports
from documents import open_note, write_portable
from studio import Session, Studio

PNG_1X1 = (
    "data:image/png;base64,"
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="
)
FAKE_PDF_ENGINE = """#!/usr/bin/env python3
import sys
from pathlib import Path
Path(sys.argv[2]).write_bytes(b"%PDF-1.7\\nstudio_exports fixture\\n")
"""


class QuietStudio(Studio):
    def __init__(self, isolated: bool = False, session: Session | None = None):
        session = session or Session(isolated)
        if not session.settings.get("python"):
            session.settings["python"] = sys.executable
        super().__init__(isolated, session)

    def _refresh_theme(self):
        self.system_dark = True


class StudioExportsSliceTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.app = QGuiApplication.instance() or QGuiApplication(["studio_exports tests"])

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="supermd-studio-exports-")
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name).resolve()
        self.session = Session(isolated=True, data=self.root / "appdata")
        self.studio = QuietStudio(isolated=True, session=self.session)
        self.replies: list[tuple[str, str, str]] = []
        self.studio.replied.connect(lambda req_id, payload, err: self.replies.append((req_id, payload, err)))

    def tearDown(self):
        self.studio.stop()
        self.studio.pool.shutdown(wait=True, cancel_futures=True)
        self.session.writes.shutdown(wait=True)
        self.app.processEvents()

    def _drain(self, predicate, timeout: float = 5.0):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            self.app.processEvents()
            if predicate():
                return
            time.sleep(0.005)
        self.fail("Timed out waiting for async operation")

    def test_export_destination_and_default_locations_preserve_save_as_separation(self):
        with self.assertRaisesRegex(ValueError, "Legacy .fmd"):
            studio.export_destination(str(self.root / "legacy.fmd"), "smd")
        for bad_name, fmt in (("a.pdf", "md"), ("a.smd", "pdf"), ("a.markdown", "smd"), ("a.zip", "md")):
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

        redirected = self.root / "patched.smd"
        with patch("studio.local_path", MagicMock(return_value=redirected)) as lp_mock:
            self.assertEqual(studio.export_destination("file:///ignored", "smd"), redirected)
            lp_mock.assert_called_once_with("file:///ignored")

        out_dir, external_dir = self.root / "outputs", self.root / "external"
        out_dir.mkdir()
        external_dir.mkdir()
        self.studio.settings["newNoteLocation"] = str(out_dir)
        external_note = external_dir / "Outside.md"
        external_note.write_text("# Outside\n", encoding="utf-8")
        self.studio._open_note(str(external_note), explicit=True)
        self._drain(lambda: any(t.get("path") == str(external_note) for t in self.studio.tabs))

        self.assertEqual(Path(self.studio.defaultSaveAsFolder().toLocalFile()), external_dir)
        self.assertEqual(Path(self.studio.defaultSaveAsLocation("Copy.md").toLocalFile()), external_dir / "Copy.md")
        self.assertEqual(Path(self.studio.defaultExportLocation("mdzip").toLocalFile()), out_dir / "Outside.zip")
        self.assertEqual(
            Path(self.studio.defaultThemeExportLocation("Warm.supermd-theme.json").toLocalFile()),
            out_dir / "Warm.supermd-theme.json",
        )

    def test_standalone_exports_refresh_sidebar_for_notes_without_mutating_tab_state(self):
        workspace_dir = self.root / "vault"
        workspace_dir.mkdir()
        original = workspace_dir / "Source.md"
        original.write_text("# Source\n", encoding="utf-8")
        self.studio.openFolder(str(workspace_dir))
        self.studio._open_note(str(original), explicit=True)
        self._drain(lambda: any(t.get("path") == str(original) for t in self.studio.tabs))
        tab = self.studio._current()
        tab["content"] = "# Unsaved edit\n"

        exported_smd = workspace_dir / "Bundle.smd"
        calls: list[tuple] = []
        real_write_portable = write_portable

        def strict_three_arg_write_portable(path, markdown, assets):
            calls.append((Path(path), markdown))
            return real_write_portable(path, markdown, assets)

        with patch("studio.write_portable", side_effect=strict_three_arg_write_portable):
            self.studio.exportTo(str(exported_smd), "smd")
            self.studio.post("exp-smd", "export_fmd_native", json.dumps({
                "id": tab["id"], "save": False, "content": "# Exported bundle\n",
                "assets": {"assets/img.png": PNG_1X1},
            }))
            self._drain(lambda: any(r[0] == "exp-smd" for r in self.replies))
        self._drain(lambda: any(item["path"] == str(exported_smd) for item in self.studio.files))

        _, raw_smd, err_smd = [r for r in self.replies if r[0] == "exp-smd"][-1]
        self.assertEqual((err_smd, json.loads(raw_smd), len(calls)), ("", {"path": str(exported_smd)}, 1))
        self.assertEqual((tab["path"], tab["saved"]), (str(original), "# Source\n"))

        self.studio.exportTo(str(original), "md")
        self.studio.post("exp-same", "export_markdown_native", json.dumps({
            "id": tab["id"], "archive": False, "content": "bad", "assets": {},
        }))
        self._drain(lambda: any(r[0] == "exp-same" for r in self.replies))
        self.assertIn("must not overwrite", [r for r in self.replies if r[0] == "exp-same"][-1][2])

        exported_md = workspace_dir / "Derived.md"
        self.studio.exportTo(str(exported_md), "md")
        self.studio.post("exp-md", "export_markdown_native", json.dumps({
            "id": tab["id"], "archive": False, "content": "# Derived\n", "assets": {},
        }))
        self._drain(lambda: any(r[0] == "exp-md" for r in self.replies))
        self._drain(lambda: any(item["path"] == str(exported_md) for item in self.studio.files))
        self.assertEqual(exported_md.read_text(encoding="utf-8"), "# Derived\n")

        if os.name == "posix":
            engine = self.root / "fake-smd-engine"
            engine.write_text(FAKE_PDF_ENGINE, encoding="utf-8")
            engine.chmod(0o700)
            self.studio._engine = lambda: engine
            exported_pdf = workspace_dir / "Derived.pdf"
            with patch.object(self.session.font_store, "pdf_assets", return_value={}):
                self.studio.exportTo(str(exported_pdf), "pdf")
                self.studio.post("exp-pdf", "export_pdf_native", json.dumps({
                    "id": tab["id"], "jobId": "pdf-1", "content": "# Derived\n",
                    "assets": {}, "options": {"fontFamily": "Manrope"},
                }))
                self._drain(lambda: any(r[0] == "exp-pdf" for r in self.replies))
            self.assertTrue(exported_pdf.read_bytes().startswith(b"%PDF-"))
            self.assertEqual(self.studio.message, "Exported Derived.pdf")

    def test_agent_export_revision_checks_chunk_streaming_and_tamper_guards(self):
        export_dir = self.root / "exports"
        export_dir.mkdir()
        self.studio.settings["newNoteLocation"] = str(export_dir)
        tab = self.studio._current()
        tab["content"] = "# Live note\nBody text\n"
        rev = hashlib.sha256(tab["content"].encode("utf-8")).hexdigest()

        with self.assertRaisesRegex(ValueError, "Live tab revision changed"):
            self.studio._agent_export_native("bad-rev", {
                "id": tab["id"], "format": "md", "expectedRevision": "0" * 64,
                "content": tab["content"], "assets": {},
            })

        self.studio._agent_export_native("agent-md", {
            "id": tab["id"], "format": "md", "expectedRevision": rev,
            "filename": "Summary.md", "content": tab["content"], "assets": {},
        })
        job_id = json.loads([r for r in self.replies if r[0] == "agent-md"][-1][1])["jobId"]
        self._drain(lambda: self.studio._agent_job_status(job_id).get("status") == "completed")

        status = self.studio._agent_job_status(job_id)
        self.assertTrue(status["downloadable"])
        chunk = self.studio._agent_export_chunk(job_id, 0, 1024)
        self.assertEqual((base64.b64decode(chunk["body"]).decode("utf-8"), chunk["nextOffset"]), (tab["content"], None))

        Path(status["path"]).write_text("tampered after completion", encoding="utf-8")
        with self.assertRaisesRegex(ValueError, "Export artifact changed after completion"):
            self.studio._agent_export_chunk(job_id, 0, 64)

        reserved = export_dir / "Orphan.md"
        reserved.write_bytes(b"")
        self.studio.pending_export = str(reserved)
        self.studio._agent_exports["orphan-req"] = {"path": str(reserved), "format": "md", "jobId": "j-orphan"}
        studio_exports.cleanup_failed_post_agent_export(self.studio, "orphan-req")
        self.assertEqual((self.studio.pending_export, reserved.exists()), ("", False))

    def test_preserved_studio_durability_invariants_remain_intact(self):
        smd_path = self.root / "Portable.smd"
        asset_str = str(PNG_1X1)
        write_portable(smd_path, "# Initial\n![](assets/a.png)\n", {"assets/a.png": asset_str})
        self.studio._open_note(str(smd_path), explicit=True)
        self._drain(lambda: any(t.get("path") == str(smd_path) for t in self.studio.tabs))
        tab = self.studio._current()
        tab["assets"]["assets/a.png"] = asset_str
        original_id = id(tab["assets"]["assets/a.png"])
        self.studio.post("save-smd", "export_fmd_native", json.dumps({
            "id": tab["id"], "save": True, "originalContent": tab["content"],
            "content": "# Updated\n![](assets/a.png)\n", "assets": {"assets/a.png": str(PNG_1X1)},
        }))
        self._drain(lambda: any(r[0] == "save-smd" for r in self.replies))
        self.assertEqual(id(tab["assets"]["assets/a.png"]), original_id)

        md_path = self.root / "Draft.md"
        md_path.write_text("clean baseline", encoding="utf-8")
        self.studio._open_note(str(md_path), explicit=True)
        self._drain(lambda: any(t.get("path") == str(md_path) for t in self.studio.tabs))
        md_tab = self.studio._current()
        md_tab["content"] = "unsaved edits survive failure"
        self.studio._recover()
        self.session.writes.flush(timeout=3)
        with patch("studio.atomic_write", side_effect=OSError("disk full")):
            self.studio._save_text(md_tab, md_path, automatic=False)
            self._drain(lambda: md_tab["id"] not in self.studio.saving and self.studio.busy == 0)
        self.session.writes.flush(timeout=3)
        self.assertEqual((md_tab["saved"], md_tab["content"]), ("clean baseline", "unsaved edits survive failure"))
        recovered = json.loads((self.session.data / "recovery.json").read_text(encoding="utf-8"))
        self.assertTrue(any(item.get("content") == "unsaved edits survive failure" for item in recovered))

        good_rev = hashlib.sha256(md_tab["content"].encode("utf-8")).hexdigest()
        with self.assertRaisesRegex(ValueError, "Live tab revision changed"):
            self.studio._prepare_save_document({"tabId": md_tab["id"], "expectedRevision": "f" * 64})
        md_path.write_text("concurrent external edit", encoding="utf-8")
        prepared = self.studio._prepare_save_document({"tabId": md_tab["id"], "expectedRevision": good_rev})
        with self.assertRaisesRegex(ValueError, "changed outside Super MD"):
            Studio._run_prepared_write_sync(self.studio, prepared)
        self.assertEqual(open_note(md_path)[0], "concurrent external edit")


if __name__ == "__main__":
    unittest.main()
