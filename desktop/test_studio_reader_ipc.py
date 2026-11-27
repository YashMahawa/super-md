"""Unit tests for extracted desktop/studio_reader_ipc.py WebChannel IPC command router."""
from __future__ import annotations

import base64, json, os, sys, tempfile, time, unittest, zipfile
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
os.environ.setdefault("QT_QUICK_BACKEND", "software")

from PySide6.QtCore import QBuffer, QByteArray, QIODevice
from PySide6.QtGui import QColor, QGuiApplication, QImage

import documents, folder_ops, pending_python, python_runtime, studio_reader_ipc
from studio import DEFAULT_PDF, Session, Studio

SVG_DATA = "data:image/svg+xml;base64," + base64.b64encode(
    b"<svg xmlns='http://www.w3.org/2000/svg' width='16' height='16'><rect width='16' height='16'/></svg>"
).decode("ascii")


def _png_b64() -> str:
    img = QImage(4, 4, QImage.Format.Format_RGBA8888)
    img.fill(QColor(20, 120, 200))
    arr = QByteArray()
    buf = QBuffer(arr)
    buf.open(QIODevice.OpenModeFlag.WriteOnly)
    img.save(buf, "PNG")
    return base64.b64encode(bytes(arr)).decode("ascii")


class QuietStudio(Studio):
    def _refresh_theme(self):
        self.system_dark = True


class StudioReaderIpcTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.app = QGuiApplication.instance() or QGuiApplication(["studio_reader_ipc tests"])
        cls.png_b64 = _png_b64()

    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory(prefix="supermd-reader-ipc-")
        self.root = Path(folder_ops.canonical_path_str(self.temp_dir.name))
        self.session = Session(True, data=self.root / "data")
        self.session.settings.update(python=sys.executable, welcomed=True, autosave=False, newNoteLocation=str(self.root))
        self.studio = QuietStudio(True, self.session)
        self.replies: dict[str, tuple[str, str]] = {}
        self.studio.replied.connect(lambda req_id, payload, err: self.replies.__setitem__(req_id, (payload, err)))

    def tearDown(self):
        if not self.studio.retired:
            self.studio.stop()
        self.studio.pool.shutdown(wait=True, cancel_futures=True)
        self.studio._search_pool.shutdown(wait=True, cancel_futures=True)
        self.session.writes.shutdown(wait=True)
        self.app.processEvents()
        self.temp_dir.cleanup()

    def _wait_reply(self, req_id: str, timeout: float = 4.0) -> tuple[str, str]:
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            self.app.processEvents()
            if req_id in self.replies:
                return self.replies[req_id]
            time.sleep(0.005)
        self.app.processEvents()
        self.assertIn(req_id, self.replies)
        return self.replies[req_id]

    @staticmethod
    def _norm(path: str | Path) -> str:
        return os.path.normcase(str(Path(path).resolve(strict=False)))

    def test_media_agent_bridge_cancel_ready_banners_chrome_and_clipboard(self):
        media_dir = self.root / "downloads"
        media_dir.mkdir()
        with patch.object(self.studio, "_media_download_directory", return_value=media_dir):
            self.studio.post("m-ok", "save_media_native", json.dumps({"mimeType": "image/png", "filename": "plot.png", "body": self.png_b64}))
            payload, err = self._wait_reply("m-ok")
            self.assertEqual(err, "")
            self.assertTrue(Path(json.loads(payload)["path"]).is_file())
            self.studio.post("m-bad", "save_media_native", "x" * 36_100_001)
            self.assertIn("exceeds 25 MB", self._wait_reply("m-bad")[1])

        completed: list[tuple] = []
        self.session.agent_bridge = SimpleNamespace(
            complete=lambda rid, res, err="", window_id="": completed.append((rid, res, err, window_id)),
            has_pending=lambda rid, wid, _kind, tid: rid in ("rb-err", "rb-cap") and wid == self.studio.window_id and tid == "t1",
        )
        self.studio.post("ar-1", "agent_result", json.dumps({"result": {"ok": 1}, "error": {"bad": True}}))
        self.assertEqual(completed[-1], ("ar-1", {"ok": 1}, "Live tab operation failed", self.studio.window_id))
        self.studio.post("rb-ignore", "agent_render_bounds", json.dumps({"tabId": "other", "error": "ignored"}))
        self.assertEqual(len(completed), 1)
        self.studio.post("rb-err", "agent_render_bounds", json.dumps({"tabId": "t1", "error": "bounds failed"}))
        self.assertEqual(completed[-1], ("rb-err", None, "bounds failed", self.studio.window_id))
        with patch.object(self.studio, "_begin_agent_viewport_capture", side_effect=ValueError("no window")):
            self.studio.post("rb-cap", "agent_render_bounds", json.dumps({"tabId": "t1"}))
        self.assertEqual(completed[-1], ("rb-cap", None, "no window", self.studio.window_id))

        job = self.studio._export_jobs.register("pdf-job-1")
        self.studio.post("cx-ok", "cancel_export", json.dumps({"jobId": "pdf-job-1"}))
        self.assertTrue(json.loads(self._wait_reply("cx-ok")[0])["cancelled"])
        self.assertTrue(job.cancelled.is_set())
        self.studio.post("cx-bad", "cancel_export", json.dumps({"jobId": ""}))
        self.assertIn("Invalid PDF export job id", self._wait_reply("cx-bad")[1])

        tab = self.studio._current()
        self.studio._last_reader_text = (tab["id"], "stale")
        self.studio._last_reader_agent_seq[tab["id"]] = 3
        self.studio.post("rr", "reader_ready", "{}")
        self.assertEqual((self._wait_reply("rr"), self.studio.ready, self.studio._last_reader_agent_seq), (("true", ""), True, {}))
        self.assertEqual(self.studio._last_reader_text, (tab["id"], tab["content"]))

        with patch.object(self.studio, "_emit", wraps=self.studio._emit) as emit_spy:
            self.studio.post("ab-1", "agent_banner_shown", json.dumps({"id": tab["id"]}))
            self.studio.post("ab-2", "agent_banner_shown", json.dumps({"id": tab["id"]}))
            self.assertEqual((tab["agent_unreviewed"], emit_spy.call_count), (True, 1))
            self.studio.post("ab-3", "agent_banner_dismissed", json.dumps({"id": tab["id"]}))
            self.studio.post("ab-4", "agent_banner_dismissed", json.dumps({"id": tab["id"]}))
            self.assertEqual((tab["agent_unreviewed"], emit_spy.call_count), (False, 2))

        chrome_actions: list[str] = []
        self.studio.chromeRequested.connect(chrome_actions.append)
        self.studio.fullscreen = False
        self.studio.post("ch-win", "reader_chrome", json.dumps({"action": "toggle"}))
        self.studio.fullscreen = True
        self.studio.post("ch-full", "reader_chrome", json.dumps({"action": "hide"}))
        self.studio.post("ch-bad", "reader_chrome", json.dumps({"action": "nope"}))
        self.assertEqual(chrome_actions, ["hide"])
        self.assertIn("Invalid reading chrome action", self._wait_reply("ch-bad")[1])

        self.studio.post("ct-ok", "copy_text", json.dumps({"text": "Copied snippet"}))
        self.assertEqual((self._wait_reply("ct-ok"), QGuiApplication.clipboard().text()), (("true", ""), "Copied snippet"))
        self.studio.post("ci-ok", "copy_image_native", json.dumps({"mimeType": "image/png", "body": self.png_b64}))
        self.assertEqual(self._wait_reply("ci-ok"), ("true", ""))
        self.assertFalse(QGuiApplication.clipboard().image().isNull())
        self.studio.post("ci-bad", "copy_image_native", json.dumps({"mimeType": "image/png", "body": "***"}))
        self.assertIn("not valid base64", self._wait_reply("ci-bad")[1])

    def test_reading_position_outline_flushed_resync_conflict_asset_and_links(self):
        note_a, note_b = self.root / "Alpha.md", self.root / "Beta.md"
        note_a.write_text("# Alpha\n", encoding="utf-8")
        note_b.write_text("# Beta\n\n## Details\n", encoding="utf-8")
        tab = self.studio._current()
        tab.update(name="Untitled.smd", path="", portable=True, content="", saved="")

        self.studio.post("out-smd", "document_outline", json.dumps({
            "id": tab["id"], "headings": [{"id": "h1", "title": '  Quantum: "Notes"?  ', "level": 1}],
        }))
        self.assertEqual((self._wait_reply("out-smd"), tab["name"], self.studio._outline_revision), (("true", ""), "Quantum Notes.smd", 1))

        tab.update(path=str(note_a), name="Alpha.md", portable=False, content="# Alpha\n", saved="# Alpha\n")
        self.studio.post("pos-ok", "reading_position", json.dumps({
            "id": tab["id"], "location": {"top": 42.5, "offset": 12, "zoom": 110, "mode": "live"},
        }))
        self.assertEqual((self._wait_reply("pos-ok"), self.session.locations[str(note_a)]["top"]), (("true", ""), 42.5))
        self.studio.post("pos-bad", "reading_position", json.dumps({
            "id": tab["id"], "location": {"top": True, "offset": 0, "zoom": 100, "mode": "live"},
        }))
        self.assertIn("Invalid reading position", self._wait_reply("pos-bad")[1])

        op = {"action": "reload_reader", "target": "", "token": "tok-1"}
        self.studio.flush_operation = op
        self.studio.post("fl-stale", "document_flushed", json.dumps({"id": tab["id"], "content": "ignored", "operation": {"action": "save", "target": "", "token": "old"}}))
        self.assertEqual(tab["content"], "# Alpha\n")
        self.studio.post("fl-ok", "document_flushed", json.dumps({"id": tab["id"], "content": "# Flushed\n", "operation": op, "viewId": tab["id"], "viewState": {"scrollTop": 88}}))
        self.assertEqual((tab["content"], tab["viewState"], self.studio.flush_operation), ("# Flushed\n", {"scrollTop": 88}, None))

        self.studio.post("sync-0", "document_sync", json.dumps({"id": tab["id"], "epoch": "e1", "revision": 0, "content": "# Flushed\n"}))
        self.assertTrue(json.loads(self._wait_reply("sync-0")[0])["accepted"])
        self.studio.post("resync-conflict", "document_resync", json.dumps({"id": tab["id"], "epoch": "e1", "revision": 0, "bases": ["# Stale\n"], "content": "# Diverged draft\n"}))
        resync_reply = json.loads(self._wait_reply("resync-conflict")[0])
        self.assertEqual((resync_reply["accepted"], resync_reply["draftSaved"]), (False, True))
        conflict_files = list((self.studio.data / "reader-conflicts").glob("*.json"))
        self.assertEqual(len(conflict_files), 1)
        self.assertEqual(json.loads(conflict_files[0].read_text(encoding="utf-8"))["content"], "# Diverged draft\n")

        with patch("studio.atomic_json", side_effect=OSError("disk full")):
            self.studio.post("resync-err", "document_resync", json.dumps({"id": tab["id"], "epoch": "e1", "revision": 0, "bases": ["# Stale\n"], "content": "# Unsaved\n"}))
            self.assertEqual(json.loads(self._wait_reply("resync-err")[0])["draftSaved"], False)

        tab["assets"]["assets/icon.png"] = "data:image/png;base64," + self.png_b64
        self.studio.post("ra-ok", "resolve_reader_asset", json.dumps({"documentPath": tab["id"], "source": "assets/icon.png"}))
        self.assertEqual(json.loads(self._wait_reply("ra-ok")[0])["mime"], "image/png")
        tab["assets"]["assets/icon.svg"] = SVG_DATA
        self.studio.post("ra-svg", "resolve_reader_asset", json.dumps({"documentPath": tab["id"], "source": "assets/icon.svg"}))
        self.assertTrue(bool(self._wait_reply("ra-svg")[1]))

        opened_urls: list[str] = []
        with patch("studio.QDesktopServices.openUrl", side_effect=lambda qurl: opened_urls.append(qurl.toString()) or True):
            self.studio.post("url-ok", "open_external_url", json.dumps({"url": "https://example.com/docs"}))
            self.studio.post("url-bad", "open_external_url", json.dumps({"url": "javascript:alert(1)"}))
        self.assertEqual(opened_urls, ["https://example.com/docs"])
        self.assertIn("Unsupported external URL scheme", self._wait_reply("url-bad")[1])

        self.studio.folder = str(self.root)
        with patch("studio.resolve_workspace_link", return_value=note_b) as link_spy:
            self.studio.post("wl-ok", "open_workspace_link", json.dumps({"documentPath": str(note_a), "target": "Beta", "wikilink": True, "fragment": "details"}))
            wl_payload = json.loads(self._wait_reply("wl-ok")[0])
        self.assertEqual((link_spy.call_count, wl_payload["opened"], self._norm(wl_payload["path"])), (1, True, self._norm(note_b)))

    def test_run_python_exports_failed_agent_cleanup_and_proxy(self):
        note_path = self.root / "Notebook.md"
        note_path.write_text("# Notebook\n", encoding="utf-8")
        tab = self.studio._current()
        tab.update(name="Notebook.md", path=str(note_path), content="# Notebook\n", saved="# Notebook\n")
        ctx = {"document": tab["id"], "cell": "c1", "interpreter": sys.executable}
        cell_out = {"stdout": "42\n", "stderr": "", "images": [], "ok": True}

        with patch.object(self.studio, "_python", return_value=cell_out), \
             patch.object(self.session.python_outputs, "store", side_effect=OSError("cache read-only")):
            self.studio.post("py-fallback", "run_python", json.dumps({"id": tab["id"], "code": "print(42)", "context": ctx}))
            py_res = json.loads(self._wait_reply("py-fallback")[0])
        self.assertTrue(py_res["provenance"]["unsaved"] and pending_python.matches("print(42)", cell_out, ctx))
        pending_python.forget("print(42)", ctx)

        with patch.object(self.studio, "_python", side_effect=python_runtime.PythonCellCancelled("stopped")):
            self.studio.post("py-cancel", "run_python", json.dumps({"id": tab["id"], "code": "while True: pass"}))
            self.assertEqual(self._wait_reply("py-cancel"), ("null", "Python cell cancelled"))

        md_out, zip_out, smd_out, pdf_out = (self.root / n for n in ("out.md", "out.zip", "out.smd", "out.pdf"))
        self.studio.pending_export = str(md_out)
        self.studio.post("ex-md", "export_markdown_native", json.dumps({"id": tab["id"], "content": "# Out\n", "assets": {}}))
        self.assertEqual(self._norm(json.loads(self._wait_reply("ex-md")[0])["path"]), self._norm(md_out))

        self.studio.pending_export = str(zip_out)
        self.studio.post("ex-zip", "export_markdown_native", json.dumps({"id": tab["id"], "content": "![a](assets/a.svg)\n", "assets": {"assets/a.svg": SVG_DATA}, "archive": True}))
        self._wait_reply("ex-zip")
        with zipfile.ZipFile(zip_out) as zf:
            self.assertTrue(any(name.endswith(".md") for name in zf.namelist()))

        portable_calls: list[Path] = []
        with patch("studio.write_portable", side_effect=lambda p, c, a: (portable_calls.append(Path(p)), documents.write_portable(p, c, a))[1]):
            self.studio.pending_export = str(smd_out)
            self.studio.post("ex-smd", "export_fmd_native", json.dumps({"id": tab["id"], "content": "# Portable\n", "assets": {}, "save": False}))
            self.assertEqual(self._norm(json.loads(self._wait_reply("ex-smd")[0])["path"]), self._norm(smd_out))
        self.assertEqual(len(portable_calls), 1)

        class FakePopen:
            pid, returncode = 9999, 0
            def __init__(self, cmd, **_kw): Path(cmd[2]).write_bytes(b"%PDF-1.7\n%%EOF\n")
            def wait(self, timeout=None): return 0

        with patch.object(self.studio, "_engine", return_value=self.root / "fake-engine"), patch("studio.subprocess.Popen", side_effect=FakePopen):
            self.studio.pending_export = str(pdf_out)
            self.studio.post("ex-pdf", "export_pdf_native", json.dumps({"id": tab["id"], "content": "# PDF\n", "assets": {}, "options": dict(DEFAULT_PDF)}))
            self.assertEqual(self._norm(json.loads(self._wait_reply("ex-pdf")[0])["path"]), self._norm(pdf_out))
        self.assertTrue(pdf_out.read_bytes().startswith(b"%PDF-"))

        reserved_async, reserved_sync = self.root / "reserved-async.smd", self.root / "reserved-sync.smd"
        reserved_async.write_bytes(b"")
        reserved_sync.write_bytes(b"")
        self.studio._agent_job_records["j-async"] = {"jobId": "j-async", "status": "running"}
        self.studio._agent_exports["ae-async"] = {"path": str(reserved_async), "format": "smd", "jobId": "j-async"}
        with patch("studio.write_portable", side_effect=OSError("disk full")):
            self.studio.pending_export = str(reserved_async)
            self.studio.post("ae-async", "export_fmd_native", json.dumps({"id": tab["id"], "content": "x", "assets": {}, "save": False}))
            deadline = time.monotonic() + 3.0
            while "ae-async" in self.studio._agent_exports and time.monotonic() < deadline:
                self.app.processEvents()
                time.sleep(0.005)
        self.assertEqual((reserved_async.exists(), self.studio._agent_job_records["j-async"]["status"]), (False, "failed"))

        self.studio._agent_exports["ae-sync"] = {"path": str(reserved_sync), "format": "smd", "jobId": "j-sync"}
        self.studio.pending_export = str(reserved_sync)
        self.studio.post("ae-sync", "export_fmd_native", "{not-json")
        self.assertEqual((reserved_sync.exists(), self.studio.pending_export), (False, ""))

        submitted: list[tuple] = []
        with patch.object(self.studio, "_submit", side_effect=lambda work, done, *rest: submitted.append((work, done, rest))):
            self.studio.pending_export = str(md_out)
            self.studio.post("sub-1", "export_markdown_native", json.dumps({"id": tab["id"], "content": "# X\n", "assets": {}}))
        self.assertEqual(submitted[0][2], (True, self.studio.writes))

        proxy_replies: list[tuple] = []
        proxy = SimpleNamespace(
            retired=False, tabs=[{"id": "p1", "agent_unreviewed": False}],
            recovery_timer=SimpleNamespace(start=lambda _ms: None), _emit=lambda *_a: None,
            replied=SimpleNamespace(emit=lambda *args: proxy_replies.append(args)),
        )
        Studio._post(proxy, "p-req", "agent_banner_shown", json.dumps({"id": "p1"}))
        self.assertEqual((proxy.tabs[0]["agent_unreviewed"], proxy_replies), (True, [("p-req", "true", "")]))


if __name__ == "__main__":
    unittest.main()
