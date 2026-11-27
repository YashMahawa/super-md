"""Unit tests for desktop/studio_agent_actions.py extracted behind the Studio facade."""
from __future__ import annotations
import ast, base64, hashlib, os, sys, tempfile, unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
os.environ.setdefault("QT_QUICK_BACKEND", "software")
from PySide6.QtCore import QBuffer, QByteArray, QIODevice, QPointF
from PySide6.QtGui import QColor, QGuiApplication, QImage
import studio_agent_actions
from studio import Session, Studio


def _sha(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()

def _png_bytes(width: int = 80, height: int = 60, color: str = "#2255aa") -> bytes:
    img = QImage(width, height, QImage.Format.Format_ARGB32)
    img.fill(QColor(color))
    arr = QByteArray()
    buf = QBuffer(arr)
    buf.open(QIODevice.OpenModeFlag.WriteOnly)
    img.save(buf, "PNG")
    return bytes(arr)

class QuietStudio(Studio):
    def __init__(self, isolated: bool = True, session: Session | None = None):
        session = session or Session(isolated)
        session.settings.setdefault("python", sys.executable)
        super().__init__(isolated, session)
    def _refresh_theme(self):
        self.system_dark = True

class _FakeBridge:
    def __init__(self, pending: set[tuple[str, str, str, str]] | None = None):
        self.pending = pending if pending is not None else set()
        self.completed: list[tuple[str, object, str, str]] = []
    def has_pending(self, req_id: str, win_id: str, action: str, tab_id: str) -> bool:
        return (req_id, win_id, action, tab_id) in self.pending
    def complete(self, req_id: str, result: object = None, error: str = "", *, window_id: str = "") -> None:
        self.pending = {item for item in self.pending if item[0] != req_id}
        self.completed.append((req_id, result, error, window_id))

class _FakeSignal:
    def __init__(self): self.connected: list = []
    def connect(self, fn, *_args): self.connected.append(fn)
    def disconnect(self, fn): self.connected.remove(fn)

class _FakeReader:
    def __init__(self, w: float = 800, h: float = 600, offset: tuple[float, float] = (20, 40)):
        self._w, self._h, self._ox, self._oy = w, h, offset[0], offset[1]
    def width(self) -> float: return self._w
    def height(self) -> float: return self._h
    def mapToScene(self, pt: QPointF) -> QPointF: return QPointF(pt.x() + self._ox, pt.y() + self._oy)

class _FakeWindow:
    def __init__(self, *, visible: bool = True, reader: object = None, image: QImage | None = None, w: int = 1000, h: int = 800):
        self._visible, self._reader, self._image, self._w, self._h = visible, reader, image, w, h
        self.frameSwapped = _FakeSignal()
        self.updated = 0
    def isVisible(self) -> bool: return self._visible
    def property(self, name: str): return self._reader if name == "reader" else None
    def findChild(self, _cls, _name: str): return None
    def update(self) -> None: self.updated += 1
    def width(self) -> int: return self._w
    def height(self) -> int: return self._h
    def grabWindow(self): return self._image


class StudioAgentActionsTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.app = QGuiApplication.instance() or QGuiApplication(["Super MD studio_agent_actions tests"])

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

    def test_command_routes_reader_actions_window_signal_and_unknown_noop(self):
        src = Path(studio_agent_actions.__file__).read_text(encoding="utf-8")
        self.assertNotIn("_studio_module", src)
        self.assertFalse(hasattr(studio_agent_actions, "_studio_module"))
        for node in ast.walk(ast.parse(src)):
            if isinstance(node, ast.Import):
                self.assertTrue(all(a.name not in ("studio", "desktop.studio", "importlib") for a in node.names))
            elif isinstance(node, ast.ImportFrom):
                self.assertNotIn(node.module, ("studio", "desktop.studio", "importlib"))
                self.assertTrue(all(a.name != "studio" for a in node.names))
            elif isinstance(node, ast.Attribute):
                self.assertFalse(isinstance(node.value, ast.Name) and node.value.id == "sys" and node.attr == "modules")
            elif isinstance(node, ast.ExceptHandler):
                self.assertFalse(isinstance(node.type, ast.Name) and node.type.id == "ImportError")
        calls, windows = [], []
        self.studio.readerCall.connect(calls.append)
        self.studio.newWindowRequested.connect(lambda: windows.append(True))
        for action in ("find", "replace", "format_bold", "format_inline_math", "undo"):
            self.studio.command(action)
        self.studio.command("window")
        self.studio.command("unknown_action")
        self.assertEqual(calls, [
            "window.supermdFind?.()", "window.supermdFind?.(true)",
            "window.supermdFormat?.('bold')", "window.supermdFormat?.('inline_math')",
            "window.supermdHistory?.('undo')",
        ])
        self.assertEqual(len(windows), 1)
        proxy_calls = []
        proxy = SimpleNamespace(readerCall=SimpleNamespace(emit=proxy_calls.append),
                                newWindowRequested=SimpleNamespace(emit=lambda: proxy_calls.append("win")))
        Studio.command(proxy, "replace")
        Studio.command(proxy, "window")
        self.assertEqual(proxy_calls, ["window.supermdFind?.(true)", "win"])

    def test_agent_export_path_validates_sanitizes_reserves_collisions_and_honors_qstandardpaths(self):
        tab = {"name": "Quarterly / Report?.md"}
        for bad in ("../escape.pdf", "sub/file.pdf", "sub\\file.pdf", "bad\0name.pdf"):
            with self.assertRaisesRegex(ValueError, "basename"):
                self.studio._agent_export_path(bad, "pdf", tab)
        first = self.studio._agent_export_path("  ..My*Report?!!.pdf ", "pdf", tab)
        second = self.studio._agent_export_path("MyReport.pdf", "pdf", tab)
        third = self.studio._agent_export_path("...", "md", {"name": ""})
        self.assertEqual((first.name, second.name, third.name), ("MyReport.pdf", "MyReport (2).pdf", "Super MD export.md"))
        self.assertTrue(first.exists() and second.exists() and third.exists())

        dl = self.root / "downloads"
        dl.mkdir()
        self.studio.settings["newNoteLocation"] = ""
        with patch("studio.QStandardPaths.writableLocation", return_value=str(dl)):
            via_dl = self.studio._agent_export_path("FromDownloads", "smd", tab)
        self.assertEqual(via_dl, dl / "FromDownloads.smd")

        self.studio.settings["newNoteLocation"] = str(self.root / "missing-dir")
        with self.assertRaisesRegex(ValueError, "configured export folder is unavailable"):
            self.studio._agent_export_path("Report.pdf", "pdf", tab)

    def test_document_actions_create_activate_close_guards_open_eviction_and_patch_routing(self):
        active_id = self.studio.active
        fg = self.studio._agent_document_action({"action": "create_document", "title": "Spec.md", "content": "# Spec\n"})
        self.assertEqual((fg["active"], fg["format"], fg["title"], self.studio.active), (True, "md", "Spec.md", fg["tabId"]))
        bg = self.studio._agent_document_action({"action": "create_document", "filename": "Deck.md", "format": "smd", "content": "# Deck\n", "background": True})
        self.assertEqual((bg["active"], bg["format"], bg["title"], self.studio.active), (False, "smd", "Deck.smd", fg["tabId"]))
        activated = self.studio._agent_document_action({"action": "activate_document", "tabId": active_id})
        self.assertEqual((activated["active"], self.studio.active), (True, active_id))
        spec_tab = next(t for t in self.studio.tabs if t["id"] == fg["tabId"])
        spec_rev = _sha(spec_tab["content"])
        self.studio._staging_tabs.add(spec_tab["id"])
        try:
            with self.assertRaisesRegex(ValueError, "already staging"):
                self.studio._agent_document_action({"action": "close_document", "tabId": spec_tab["id"], "expectedRevision": spec_rev})
        finally:
            self.studio._staging_tabs.discard(spec_tab["id"])
        with self.assertRaisesRegex(ValueError, "Live tab revision changed"):
            self.studio._agent_document_action({"action": "close_document", "tabId": spec_tab["id"], "expectedRevision": "0" * 64})
        with self.assertRaisesRegex(ValueError, "unsaved changes"):
            self.studio._agent_document_action({"action": "close_document", "tabId": spec_tab["id"], "expectedRevision": spec_rev})
        closed = self.studio._agent_document_action({"action": "close_document", "tabId": spec_tab["id"], "expectedRevision": spec_rev, "discardChanges": True})
        self.assertIn(closed["status"], ("closing", "closed"))

        outside = Path(self.temp.name).parent / f"{self.root.name}-outside.md"
        outside.write_text("# Outside\n", encoding="utf-8")
        try:
            with self.assertRaisesRegex(ValueError, "approved agent note roots"):
                self.studio._agent_document_action({"action": "open_document", "filename": str(outside)})
        finally:
            outside.unlink(missing_ok=True)

        existing_file = self.root / "Existing.md"
        existing_file.write_text("# Existing\n", encoding="utf-8")
        existing_tab = self.studio._note("Existing.md", "# Existing\n", str(existing_file.resolve()), "# Existing\n")
        self.studio.tabs.append(existing_tab)
        reused = self.studio._agent_document_action({"action": "open_document", "filename": "Existing.md", "background": True})
        self.assertEqual((reused["tabId"], reused["isDirty"]), (existing_tab["id"], False))

        queued_file = self.root / "Queued.md"
        queued_file.write_text("# Queued\n", encoding="utf-8")
        self.studio._agent_job_records = {f"j{i}": {"status": "running"} for i in range(20)}
        with self.assertRaisesRegex(ValueError, "20 active agent jobs"):
            self.studio._agent_document_action({"action": "open_document", "filename": str(queued_file), "background": True})
        self.studio._agent_job_records["j0"]["status"] = "completed"
        with patch.object(self.studio, "_open_note") as open_mock:
            opened = self.studio._agent_document_action({"action": "open_document", "filename": str(queued_file), "background": True})
        self.assertEqual((opened["status"], len(self.studio._agent_job_records)), ("opening", 20))
        self.assertNotIn("j0", self.studio._agent_job_records)
        self.assertEqual((open_mock.call_count, open_mock.call_args.kwargs.get("explicit"), open_mock.call_args.kwargs.get("background")), (1, False, True))

        cur = self.studio._current()
        patched_active = self.studio._agent_document_action({
            "action": "patch_tab", "tabId": cur["id"], "expectedRevision": _sha(cur["content"]),
            "operations": [{"type": "insert", "line": 1, "text": "# Header\n"}],
        })
        self.assertTrue(patched_active["changed"] and cur["agent_unreviewed"])
        noop_inactive = self.studio._agent_document_action({
            "action": "patch_tab", "tabId": existing_tab["id"], "expectedRevision": _sha(existing_tab["content"]),
            "operations": [{"type": "replace", "old": "# Existing", "new": "# Existing"}],
        })
        self.assertEqual((noop_inactive["changed"], noop_inactive["isDirty"]), (False, False))
        with patch.object(self.studio, "_stage_inactive_patch_tab_sync", return_value={"staged": True}) as stage_mock:
            staged = self.studio._agent_document_action({
                "action": "patch_tab", "tabId": existing_tab["id"], "expectedRevision": _sha(existing_tab["content"]),
                "operations": [{"type": "replace", "old": "Existing", "new": "Changed"}],
            })
        self.assertEqual(staged, {"staged": True})
        stage_mock.assert_called_once()
        proxy_saved = SimpleNamespace(saving=set(), _prepare_save_document=lambda a: (a["tabId"], lambda: "ok", lambda v, _e: {"saved": v}, lambda: None))
        self.assertEqual(studio_agent_actions.agent_document_action(proxy_saved, {"action": "save_document", "tabId": "t1"}), {"saved": "ok"})
        with patch.object(Studio, "_prepare_save_document", return_value=("t2", lambda: "s", lambda v, _e: {"via": v}, lambda: None)):
            self.assertEqual(self.studio._agent_document_action({"action": "save_document", "tabId": "t2"}), {"via": "s"})

    def test_viewport_capture_guards_background_fallback_live_crop_encoding_and_revision_race(self):
        tab = self.studio._current()
        tab["content"] = "# Viewport\n"
        rev, req_id = _sha(tab["content"]), "req-vp"
        bridge = _FakeBridge({(req_id, self.studio.window_id, "render_tab", tab["id"])})
        self.session.agent_bridge = bridge
        valid_vp = {"x": 0, "y": 0, "width": 400, "height": 300, "viewportWidth": 400, "viewportHeight": 300}
        base = {"requestId": req_id, "tabId": tab["id"], "revision": rev, "context": {"revision": rev, "viewport": valid_vp}}

        for bad, pattern in (
            ({"requestId": "wrong"}, "request is invalid"),
            ({**base, "revision": "short"}, "missing its live tab revision"),
            ({**base, "context": {"revision": "f" * 64}}, "does not match"),
            ({**base, "context": {"revision": rev, "viewport": {**valid_vp, "x": -5}}}, "outside the visible page"),
            ({**base, "width": 32}, "between 64 and 1,600"),
            ({**base, "imageFormat": "webp"}, "png or jpeg"),
        ):
            self.studio.host_window = _FakeWindow(visible=True)
            with self.assertRaisesRegex(ValueError, pattern):
                self.studio._begin_agent_viewport_capture(req_id, bad)

        self.studio.host_window = _FakeWindow(visible=False)
        with patch("offline_view.render_live_snapshot", return_value=_png_bytes(120, 90)), patch.object(
            self.studio, "_submit", side_effect=lambda work, done, *_a: done(work(), None)
        ):
            self.studio._begin_agent_viewport_capture(req_id, {**base, "imageFormat": "jpeg"})
        self.assertEqual((bridge.completed[-1][1]["mime_type"], bridge.completed[-1][1]["renderedFrom"]), ("image/jpeg", "background-preview"))
        self.assertFalse(QImage.fromData(base64.b64decode(bridge.completed[-1][1]["data"]), "JPEG").isNull())

        frame = QImage(1000, 800, QImage.Format.Format_ARGB32)
        frame.fill(QColor("#118844"))
        win = _FakeWindow(visible=True, reader=_FakeReader(800, 600, (50, 50)), image=frame, w=1000, h=800)
        self.studio.host_window = win
        timers = []
        for fmt, expected_mime in (("png", "image/png"), ("jpeg", "image/jpeg")):
            bridge.pending.add((req_id, self.studio.window_id, "render_tab", tab["id"]))
            with patch("studio.QTimer.singleShot", side_effect=lambda ms, cb: timers.append((ms, cb))):
                self.studio._begin_agent_viewport_capture(req_id, {**base, "width": 200, "imageFormat": fmt})
            self.assertEqual((self.studio._agent_viewport_capture is not None, len(win.frameSwapped.connected)), (True, 1))
            timers.pop()[1]()
            self.assertEqual((self.studio._agent_viewport_capture, win.frameSwapped.connected), (None, []))
            out = bridge.completed[-1][1]
            self.assertEqual((out["mime_type"], max(out["width"], out["height"])), (expected_mime, 200))

        self.studio._clear_agent_viewport_capture({"requestId": "other"})
        def mutating_grab():
            tab["content"] = "# Mutated mid-grab\n"
            return frame

        win.grabWindow = mutating_grab
        bridge.pending.add((req_id, self.studio.window_id, "render_tab", tab["id"]))
        with patch("studio.QTimer.singleShot"):
            self.studio._begin_agent_viewport_capture(req_id, base)
        self.studio._clear_agent_viewport_capture({"requestId": "other"})
        self.assertIsNotNone(self.studio._agent_viewport_capture)
        self.studio._agent_viewport_frame_swapped()
        self.assertIsNone(self.studio._agent_viewport_capture)
        self.assertIn("changed while its viewport was being captured", bridge.completed[-1][2])

        rev2 = _sha(tab["content"])
        base2 = {**base, "revision": rev2, "context": {"revision": rev2, "viewport": valid_vp}}
        win.grabWindow = lambda: frame
        bridge.pending.add((req_id, self.studio.window_id, "render_tab", tab["id"]))
        with patch("studio.QTimer.singleShot"), patch.object(QImage, "save", return_value=False):
            self.studio._begin_agent_viewport_capture(req_id, base2)
            self.studio._agent_viewport_frame_swapped()
        self.assertEqual(bridge.completed[-1][2], "Could not encode the live viewport as PNG")


if __name__ == "__main__":
    unittest.main()
