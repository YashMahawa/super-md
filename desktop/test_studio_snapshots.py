"""Focused unit tests for desktop/studio_snapshots.py behind the Studio facade."""
from __future__ import annotations
import json, os, shutil, tempfile, threading, unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
os.environ.setdefault("QT_QUICK_BACKEND", "software")

from PySide6.QtGui import QGuiApplication
import studio, studio_snapshots
from studio import Session, Studio

class QuietStudio(Studio):
    def _refresh_theme(self):
        self.system_dark = True

class _SignalSpy:
    def __init__(self):
        self.calls = []
    def emit(self, *args):
        self.calls.append(args)

class StudioSnapshotsTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.app = QGuiApplication.instance() or QGuiApplication(["studio-snapshots-tests"])

    def _make_window(self, root: Path | None = None):
        session = Session(True, data=root)
        session.settings.update(welcomed=True, autosave=False, theme="dark")
        return session, QuietStudio(True, session)

    def _dispose(self, session: Session, *windows: Studio):
        data_dir = session.data
        for win in windows:
            win.stop()
            win.pool.shutdown(wait=True, cancel_futures=True)
            win._search_pool.shutdown(wait=True, cancel_futures=True)
        session.writes.shutdown(wait=True)
        self.app.processEvents()
        shutil.rmtree(data_dir, ignore_errors=True)

    def test_slice_memoization_and_selective_invalidation_across_sidebar_and_snapshot(self):
        session, win = self._make_window()
        try:
            win.folder = "/workspace"
            win.files = [{"name": "Note.md", "path": "/workspace/Note.md", "directory": False, "expanded": False}]
            win._current()["outline"] = [{"title": "Intro", "level": 1, "offset": 0}]
            win._outline_revision = 1
            session.recent, session.pinned = ["/workspace/Note.md"], ["/workspace/Note.md"]

            sidebar_first = win.sidebarSnapshot
            snap_first = json.loads(win.snapshot)
            caches = (win._folder_slice_cache, win._outline_slice_cache, win._recent_slice_cache, win._pinned_slice_cache, win._tabs_slice_cache, win._colors_slice_cache)

            win.busy, win.message = 1, "Working"
            snap_second = json.loads(win.snapshot)
            self.assertEqual((snap_second["busy"], snap_second["message"], snap_first["outline"]), (True, "Working", snap_second["outline"]))
            self.assertIs(win.sidebarSnapshot, sidebar_first)
            self.assertEqual((win._folder_slice_cache, win._outline_slice_cache, win._recent_slice_cache, win._pinned_slice_cache, win._tabs_slice_cache, win._colors_slice_cache), caches)

            win._current()["content"] = "# Dirty edit"
            _ = win.snapshot
            self.assertIsNot(win._tabs_slice_cache, caches[4])
            self.assertIs(win.sidebarSnapshot, sidebar_first)

            win._current()["outline"] = [{"title": "Updated", "level": 1, "offset": 0}]
            win._outline_revision += 1
            self.assertIsNot(win.sidebarSnapshot, sidebar_first)
            self.assertIs(win._folder_slice_cache, caches[0])
        finally:
            self._dispose(session, win)

    def test_emit_state_delivers_content_unchanged_and_incremental_pending_agent_edits(self):
        session, win = self._make_window()
        try:
            self.assertFalse(win.deferReaderActivation)
            loads = []
            win.readerLoad.connect(lambda raw: loads.append(json.loads(raw)))
            win.ready = True
            tab = win._current()
            tab["content"], tab["agent_unreviewed"] = "# Initial\n\nBody", True
            tab["agent_edits"] = [{"seq": 1, "before": "# Initial", "after": "# Initial\n\nBody"}]

            win._emit(True)
            self.assertEqual((loads[-1]["content"], loads[-1]["portable"], loads[-1]["agentUnreviewed"], [e["seq"] for e in loads[-1]["pendingAgentEdits"]]), ("# Initial\n\nBody", False, True, [1]))
            self.assertNotIn("contentUnchanged", loads[-1])

            tab["portable"] = True
            win._emit(True)
            self.assertEqual((loads[-1]["contentUnchanged"], loads[-1]["portable"]), (True, True))
            self.assertFalse("content" in loads[-1] or "pendingAgentEdits" in loads[-1])

            tab["agent_edits"].append({"seq": 2, "before": "# Initial\n\nBody", "after": "# Initial\n\nRevised"})
            tab["content"] = "# Initial\n\nRevised"
            win._emit(True)
            self.assertEqual((loads[-1]["content"], [e["seq"] for e in loads[-1]["pendingAgentEdits"]]), ("# Initial\n\nRevised", [2]))
        finally:
            self._dispose(session, win)

    def test_stop_window_cleans_timers_watchers_empty_exports_and_retired_callbacks(self):
        session, win = self._make_window()
        peer = QuietStudio(True, session)
        try:
            storage_cancel, folder_cancel = threading.Event(), threading.Event()
            win._storage_cancel_event, win._folder_search_cancel = storage_cancel, folder_cancel
            empty_export, nonempty_export = session.data / "reserved-empty.pdf", session.data / "keep.pdf"
            empty_export.write_bytes(b"")
            nonempty_export.write_bytes(b"pdf")
            win._agent_exports = {"a": {"path": str(empty_export)}, "b": {"path": str(nonempty_export)}}
            win.position_timer.start(60000)
            win.preference_timer.start(60000)
            retired_calls = []
            win._pending_write_retirements["w1"] = lambda: retired_calls.append("ran")

            with patch.object(win, "_save_positions") as save_pos, patch.object(win, "_preferences") as prefs, patch.object(peer, "_recover") as peer_recover:
                win.stop()
                self.assertEqual((save_pos.call_count, peer_recover.call_count), (1, 1))
                prefs.assert_called_once_with(False)

            self.assertTrue(win.retired and storage_cancel.is_set() and folder_cancel.is_set())
            self.assertEqual((empty_export.exists(), nonempty_export.exists(), retired_calls), (False, True, ["ran"]))
            self.assertEqual((win.note_watcher, win.palette_watcher, win.custom_theme_watcher), (studio._STOPPED_WATCHER,) * 3)
            self.assertFalse(win.theme_timer.isActive() or win.window_id in session.windows)
        finally:
            self._dispose(session, win, peer)

    def test_simple_namespace_proxy_calls_and_patched_studio_root(self):
        palette_box = [{"surface": "#111111", "primary": "#3366ff"}]
        sidebar_sig, changed_sig = _SignalSpy(), _SignalSpy()
        ns = SimpleNamespace(
            retired=False, active="t1", folder="", folder_filter="", _folder_searching=False,
            tabs=[{"id": "t1", "name": "Doc.md", "path": "", "content": "x", "saved": "x", "portable": False}],
            files=[], recent=["/a.md"], closed_tabs=[], settings={"normalZoom": 100, "fullZoom": 110},
            mode="live", fullscreen=False, reader_overlay=False, image_overlay=False, ready=False,
            busy=0, message="", session=SimpleNamespace(pinned=["/a.md"]),
            sidebarChanged=sidebar_sig, changed=changed_sig, _tokens=lambda: (True, palette_box[0]),
        )
        studio_snapshots.emit_state(ns, load=False)
        studio_snapshots.notify_sidebar(ns)
        self.assertEqual((len(sidebar_sig.calls), len(changed_sig.calls)), (1, 1))
        palette_box[0] = {"surface": "#222222", "primary": "#ff6633"}
        self.assertEqual(json.loads(studio_snapshots.window_snapshot(ns))["colors"]["surface"], "#222222")
        self.assertEqual(json.loads(studio_snapshots.sidebar_snapshot(ns))["pinned"], ["/a.md"])

        with tempfile.TemporaryDirectory(prefix="supermd-root-") as tmp:
            fake_root = Path(tmp)
            (fake_root / "public").mkdir(parents=True)
            (fake_root / "public/brand-mark-fixed.svg").write_text("<svg id='patched'/>", encoding="utf-8")
            with patch.object(studio, "ROOT", fake_root):
                session, win = self._make_window()
                try:
                    self.assertEqual(win._brand_svg, "<svg id='patched'/>")
                finally:
                    self._dispose(session, win)
