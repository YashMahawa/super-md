"""Focused unit tests for desktop/studio_snapshots.py behind the Studio facade."""
from __future__ import annotations
import ast, json, os, shutil, tempfile, threading, unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
os.environ.setdefault("QT_QUICK_BACKEND", "software")

from PySide6.QtCore import QFileSystemWatcher, QTimer
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

def _exception_names(handler_type: ast.expr | None) -> set[str]:
    if isinstance(handler_type, ast.Name):
        return {handler_type.id}
    if isinstance(handler_type, ast.Attribute):
        return {handler_type.attr}
    if isinstance(handler_type, ast.Tuple):
        return {n for elt in handler_type.elts for n in _exception_names(elt)}
    return set()

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
            if getattr(win, "_python_pool", None) is not None:
                win._python_pool.shutdown(wait=True, cancel_futures=True)
        session.writes.shutdown(wait=True)
        self.app.processEvents()
        shutil.rmtree(data_dir, ignore_errors=True)

    def test_ast_module_boundary_has_zero_studio_back_imports_or_dynamic_shims(self):
        path = Path(studio_snapshots.__file__).resolve()
        source = path.read_text(encoding="utf-8")
        self.assertLess(len(source.splitlines()), 600)
        self.assertFalse(hasattr(studio_snapshots, "_studio_module"))
        tree = ast.parse(source, filename=str(path))
        forbidden_modules = {"studio", "desktop.studio", "importlib", "shiboken6"}
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                for alias in node.names:
                    self.assertNotIn(alias.name, forbidden_modules)
                    self.assertNotIn(alias.name.split(".", 1)[0], forbidden_modules)
            elif isinstance(node, ast.ImportFrom):
                if node.module:
                    self.assertNotIn(node.module, forbidden_modules)
                    self.assertNotIn(node.module.split(".", 1)[0], {"studio", "importlib", "shiboken6"})
                for alias in node.names:
                    self.assertNotIn(alias.name, forbidden_modules)
            elif isinstance(node, ast.Attribute):
                self.assertFalse(isinstance(node.value, ast.Name) and node.value.id == "sys" and node.attr == "modules")
            elif isinstance(node, ast.Name):
                self.assertNotEqual(node.id, "_studio_module")
            elif isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                self.assertNotEqual(node.name, "_studio_module")
            elif isinstance(node, ast.Try):
                for handler in node.handlers:
                    self.assertFalse(_exception_names(handler.type) & {"ImportError", "ModuleNotFoundError"})

    def test_slice_memoization_and_selective_invalidation_across_sidebar_and_snapshot(self):
        session, win = self._make_window()
        try:
            win.folder = "/workspace"
            win.files = [{"name": "Note.md", "path": "/workspace/Note.md", "directory": False, "expanded": False}]
            win._current()["outline"] = [{"title": "Intro", "level": 1, "offset": 0}]
            win._outline_revision = 1
            session.recent, session.pinned = ["/workspace/Note.md"], ["/workspace/Note.md"]

            sidebar_first = win.sidebarSnapshot
            tabs_first = win.tabsSnapshot
            snap_first = json.loads(win.snapshot)
            self.assertEqual(win.activeTabId, win.active)
            caches = (win._folder_slice_cache, win._outline_slice_cache, win._recent_slice_cache, win._pinned_slice_cache, win._tabs_slice_cache, win._colors_slice_cache)

            win.busy, win.message = 1, "Working"
            snap_second = json.loads(win.snapshot)
            self.assertEqual((snap_second["busy"], snap_second["message"], snap_first["outline"]), (True, "Working", snap_second["outline"]))
            self.assertIs(win.sidebarSnapshot, sidebar_first)
            self.assertIs(win.tabsSnapshot, tabs_first)
            self.assertEqual((win._folder_slice_cache, win._outline_slice_cache, win._recent_slice_cache, win._pinned_slice_cache, win._tabs_slice_cache, win._colors_slice_cache), caches)

            win._current()["content"] = "# Dirty edit"
            _ = win.snapshot
            self.assertIsNot(win._tabs_slice_cache, caches[4])
            self.assertIsNot(win.tabsSnapshot, tabs_first)
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
            self.assertFalse(win._folder_search_pending)
            win._folder_search_pending = True
            self.assertIsNone(win._python_pool)
            python_pool_calls = []
            win._python_pool = SimpleNamespace(shutdown=lambda *, wait=True, cancel_futures=False: python_pool_calls.append((wait, cancel_futures)))
            empty_export, nonempty_export = session.data / "reserved-empty.pdf", session.data / "keep.pdf"
            empty_export.write_bytes(b"")
            nonempty_export.write_bytes(b"pdf")
            win._agent_exports = {"a": {"path": str(empty_export)}, "b": {"path": str(nonempty_export)}}
            win._opening_paths["/tmp/opening.md"] = 1
            win.position_timer.start(60000)
            win.preference_timer.start(60000)
            retired_calls, rename_cleanups = [], []
            win._pending_write_retirements["w1"] = lambda: retired_calls.append(win.window_id in session.windows)
            session._pending_rename_cleanups["r1"] = lambda: rename_cleanups.append("cleaned")

            with patch.object(win, "_save_positions") as save_pos, patch.object(win, "_preferences") as prefs, patch.object(peer, "_recover") as peer_recover:
                win.stop()
                self.assertEqual((save_pos.call_count, peer_recover.call_count), (1, 1))
                prefs.assert_called_once_with(False)

            self.assertTrue(win.retired and storage_cancel.is_set() and folder_cancel.is_set() and not win._folder_search_pending)
            self.assertEqual(python_pool_calls, [(False, True)])
            self.assertEqual((empty_export.exists(), nonempty_export.exists(), retired_calls, win._opening_paths, rename_cleanups), (False, True, [False], {}, []))
            self.assertEqual((win.note_watcher, win.palette_watcher, win.custom_theme_watcher), (studio._STOPPED_WATCHER,) * 3)
            self.assertFalse(win.theme_timer.isActive() or win.window_id in session.windows)
            peer.stop()
            self.assertEqual(rename_cleanups, ["cleaned"])
        finally:
            self._dispose(session, win, peer)

    def test_simple_namespace_unbound_calls_and_patched_studio_collaborators(self):
        palette_box = [{"surface": "#111111", "primary": "#3366ff"}]
        sidebar_sig, tabs_sig, active_sig, changed_sig = _SignalSpy(), _SignalSpy(), _SignalSpy(), _SignalSpy()
        deleted_later = []
        fake_watcher = SimpleNamespace(files=lambda: [], directories=lambda: [], deleteLater=lambda: deleted_later.append(True))
        ns = SimpleNamespace(
            retired=False, active="t1", folder="", folder_filter="", _folder_searching=False,
            tabs=[{"id": "t1", "name": "Doc.md", "path": "", "content": "x", "saved": "x", "portable": False}],
            files=[], recent=["/a.md"], closed_tabs=[], settings={"normalZoom": 100, "fullZoom": 110},
            mode="live", fullscreen=False, reader_overlay=False, image_overlay=False, ready=False,
            busy=0, message="", session=SimpleNamespace(pinned=["/a.md"]), note_watcher=fake_watcher,
            sidebarChanged=sidebar_sig, tabsChanged=tabs_sig, activeTabChanged=active_sig,
            changed=changed_sig, _tokens=lambda: (True, palette_box[0]),
        )
        Studio._emit(ns, False)
        Studio._notify_sidebar(ns)
        Studio._notify_tabs(ns)
        self.assertEqual((len(sidebar_sig.calls), len(tabs_sig.calls), len(active_sig.calls), len(changed_sig.calls)), (1, 1, 1, 1))
        self.assertEqual((json.loads(Studio.tabsSnapshot.fget(ns))[0]["id"], Studio.activeTabId.fget(ns)), ("t1", "t1"))
        palette_box[0] = {"surface": "#222222", "primary": "#ff6633"}
        self.assertEqual(json.loads(Studio.snapshot.fget(ns))["colors"]["surface"], "#222222")
        self.assertEqual(json.loads(Studio.sidebarSnapshot.fget(ns))["pinned"], ["/a.md"])
        studio_snapshots.stop_window(ns)
        self.assertTrue(ns._retired and deleted_later)
        self.assertIs(ns.note_watcher, studio_snapshots._DEFAULT_STOPPED_WATCHER)

        fake_root = Path(tempfile.mkdtemp(prefix="supermd-root-"))
        try:
            (fake_root / "public").mkdir(parents=True)
            (fake_root / "public/brand-mark-fixed.svg").write_text("<svg id='patched'/>", encoding="utf-8")
            created_timers, created_watchers, deleted_watchers, py_jobs, preview_events = [], [], [], [], []
            base_session = Session(True, data=fake_root / "data")
            base_session.settings.update(welcomed=True, autosave=False, theme="dark")

            class ProxyTimer(QTimer):
                def __init__(self, *args):
                    super().__init__(*args)
                    created_timers.append(self)

            class ProxyWatcher(QFileSystemWatcher):
                def __init__(self, *args):
                    super().__init__(*args)
                    created_watchers.append(self)

            class FakePyRuntime:
                default_python = staticmethod(lambda _env_dir: "")
                @staticmethod
                def PythonJobRegistry():
                    reg = studio_snapshots.python_runtime.PythonJobRegistry()
                    py_jobs.append(reg)
                    return reg

            class FakeOfflineView:
                @staticmethod
                def PreviewJobRegistry():
                    return SimpleNamespace(
                        retain_tabs=lambda ids: preview_events.append(("retain", list(ids))),
                        cancel_all=lambda retire=False: preview_events.append(("cancel", retire)),
                    )

            class FakeCustomTheme:
                @staticmethod
                def reader(*_args):
                    return {"marker": "patched-theme"}

            class FakeShiboken:
                @staticmethod
                def isValid(_obj):
                    return True
                @staticmethod
                def delete(obj):
                    deleted_watchers.append(obj)
                    obj.deleteLater()

            win = None
            with (
                patch.object(studio, "ROOT", fake_root),
                patch("studio.Session", side_effect=lambda _iso: base_session) as session_mock,
                patch("studio.QTimer", ProxyTimer),
                patch("studio.QFileSystemWatcher", ProxyWatcher),
                patch("studio.read_system_palette", return_value=("dark", {"primary": "#123456"})) as palette_mock,
                patch("studio.python_runtime", FakePyRuntime),
                patch("studio.offline_view", FakeOfflineView),
                patch("studio.custom_theme", FakeCustomTheme),
                patch("studio.shiboken6", FakeShiboken),
            ):
                try:
                    win = QuietStudio(True)
                    self.assertEqual((win._brand_svg, session_mock.call_count, palette_mock.call_count), ("<svg id='patched'/>", 1, 1))
                    self.assertEqual((win.system_mode, win.system_colors, len(created_watchers), len(py_jobs)), ("dark", {"primary": "#123456"}, 3, 1))
                    self.assertGreaterEqual(len(created_timers), 9)
                    loads = []
                    win.readerLoad.connect(lambda raw: loads.append(json.loads(raw)))
                    win.ready = True
                    win._emit(True)
                    self.assertEqual(loads[-1]["customStyle"], {"marker": "patched-theme"})
                    win.stop()
                    self.assertEqual(len(deleted_watchers), 3)
                    self.assertIn(("cancel", True), preview_events)
                    self.assertTrue(any(kind == "retain" for kind, _ in preview_events))
                finally:
                    self._dispose(base_session, *([win] if win is not None else ()))
        finally:
            shutil.rmtree(fake_root, ignore_errors=True)
