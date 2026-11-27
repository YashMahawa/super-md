"""Tests for Desktop external file-open routing, window eligibility, and startup placeholders."""
from __future__ import annotations

import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest
import uuid

sys.path.insert(0, str(Path(__file__).resolve().parent))

from PySide6.QtCore import QEvent, QFile, QIODevice, QObject, QStandardPaths, QUrl, Slot
from PySide6.QtGui import QFileOpenEvent, QGuiApplication, QWindow
from PySide6.QtQml import QQmlApplicationEngine
from PySide6.QtQuickControls2 import QQuickStyle
from PySide6.QtTest import QTest

import folder_ops
from documents import write_portable
from external_open import ExternalOpenRouter
from instance import InstanceBroker
from studio import ROOT, SAMPLE, Session, Studio


class QuietStudio(Studio):
    def _refresh_theme(self):
        return


def _qt_url_local_path(url: QUrl) -> Path:
    return Path(url.toLocalFile())


class FakeHostWindow(QObject):
    def __init__(self, *, visible: bool = True):
        super().__init__()
        self._visible = visible
        self._visibility = QWindow.Visibility.Windowed if visible else QWindow.Visibility.Hidden
        self.shown = 0
        self.shown_normal = 0
        self.shown_maximized = 0
        self.raised = 0
        self.activated = 0
        self.focused = 0
        self.setProperty("modalDialogCount", 0)
        self.setProperty("closingAllowed", False)
        self.setProperty("intentionalShutdown", False)

    def isVisible(self) -> bool:
        return self._visible

    def visibility(self):
        return self._visibility

    def set_minimized(self) -> None:
        self._visible = True
        self._visibility = QWindow.Visibility.Minimized

    def show(self) -> None:
        self._visible = True
        self._visibility = QWindow.Visibility.Windowed
        self.shown += 1

    def showNormal(self) -> None:
        self._visible = True
        self._visibility = QWindow.Visibility.Windowed
        self.shown_normal += 1

    def showMaximized(self) -> None:
        self._visible = True
        self._visibility = QWindow.Visibility.Maximized
        self.shown_maximized += 1

    def hide(self) -> None:
        self._visible = False
        self._visibility = QWindow.Visibility.Hidden

    def raise_(self) -> None:
        self.raised += 1

    def requestActivate(self) -> None:
        self.activated += 1

    @Slot()
    def focusReader(self) -> None:
        self.focused += 1


class ExternalFileOpenRouterUnitTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.app = QGuiApplication.instance() or QGuiApplication(["External file open unit tests"])

    def setUp(self) -> None:
        self.session = Session(True)
        self.session.settings["welcomed"] = True
        self.studios: list[QuietStudio] = []
        self.hosts: list[FakeHostWindow] = []
        self.router = ExternalOpenRouter(
            self.studios,
            lambda note=None: self._create_window(note),
            app=self.app,
        )

    def tearDown(self) -> None:
        for studio in list(self.studios):
            studio.stop()
            studio.pool.shutdown(wait=True)
            studio._search_pool.shutdown(wait=True)
        self.session.writes.shutdown(wait=True)
        self.app.sendPostedEvents(None, QEvent.Type.DeferredDelete)

    def _create_window(self, note: str | None = None, *, show_window: bool = True) -> QuietStudio:
        studio = QuietStudio(True, self.session)
        studio.ready = True
        host = FakeHostWindow(visible=show_window)
        studio.host_window = host
        self.hosts.append(host)
        self.studios.append(studio)
        self.router.register_window(studio, activated=show_window)
        if note:
            studio.openPath(str(note))
        return studio

    def _wait_for(self, predicate, timeout: float = 3.0) -> None:
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            self.app.processEvents()
            if predicate():
                return
            time.sleep(0.005)
        self.app.processEvents()
        self.assertTrue(predicate(), "Timed out waiting for Studio condition")

    def test_already_open_note_reuses_existing_tab_and_window_across_two_windows(self) -> None:
        win1 = self._create_window()
        alpha = self.session.data / "alpha.md"
        beta = self.session.data / "beta.md"
        gamma = self.session.data / "gamma.md"
        alpha.write_text("# Alpha", encoding="utf-8")
        beta.write_text("# Beta", encoding="utf-8")
        gamma.write_text("# Gamma", encoding="utf-8")

        win1.openPath(str(alpha))
        self._wait_for(lambda: any(t["path"] == str(alpha.resolve()) for t in win1.tabs))
        alpha_id = win1.active
        win1.openNote(str(beta))
        self._wait_for(lambda: any(t["path"] == str(beta.resolve()) for t in win1.tabs))
        self.assertNotEqual(win1.active, alpha_id)

        win2 = self._create_window(str(gamma))
        self._wait_for(lambda: any(t["path"] == str(gamma.resolve()) for t in win2.tabs))
        self.assertEqual(len(self.studios), 2)

        win1_host: FakeHostWindow = win1.host_window
        before_raised, before_activated = win1_host.raised, win1_host.activated

        target_studio = self.router.open_requested(QUrl.fromLocalFile(str(alpha)).toString())
        self.assertIs(target_studio, win1)
        self.assertEqual(len(self.studios), 2)
        self._wait_for(lambda: win1.active == alpha_id and win1_host.focused >= 1)
        self.assertEqual([Path(t["path"]).name for t in win1.tabs], ["alpha.md", "beta.md"])
        self.assertEqual([Path(t["path"]).name for t in win2.tabs], ["gamma.md"])
        self.assertGreater(win1_host.raised, before_raised)
        self.assertGreater(win1_host.activated, before_activated)

        # Symlink pointing to an already-open note also reuses that tab when supported.
        link_path = self.session.data / "alpha-link.md"
        try:
            link_path.symlink_to(alpha)
        except OSError:
            return
        win1.selectTab(next(t["id"] for t in win1.tabs if t["id"] != alpha_id))
        self.router.mark_active(win2)
        routed = self.router.open_requested(str(link_path))
        self.assertIs(routed, win1)
        self.assertEqual(win1.active, alpha_id)
        self.assertEqual(len(self.studios), 2)

    def test_two_windows_route_to_last_active_eligible_window_and_skip_blocked_windows(self) -> None:
        win1 = self._create_window()
        win2 = self._create_window()

        first = self.session.data / "for-win2.md"
        second = self.session.data / "for-win1.md"
        third = self.session.data / "skip-modal-to-win2.md"
        fourth = self.session.data / "all-blocked-new-win.md"
        for idx, p in enumerate((first, second, third, fourth), start=1):
            p.write_text(f"# Note {idx}", encoding="utf-8")

        # Window 2 was created most recently, so it starts as last active.
        self.assertIs(self.router.open_requested(str(first)), win2)
        self._wait_for(lambda: [t["path"] for t in win2.tabs] == [str(first.resolve())])

        # Activate Window 1 via WindowActivate event; even without live focusWindow(),
        # Window 1 remains remembered as the last active Super MD window.
        self.app.sendEvent(win1.host_window, QEvent(QEvent.Type.WindowActivate))
        self.assertIs(self.router.open_requested(str(second)), win1)
        self._wait_for(lambda: [t["path"] for t in win1.tabs] == [str(second.resolve())])

        # Block Window 1 with an open modal dialog -> routes to Window 2 (next active eligible).
        win1.host_window.setProperty("modalDialogCount", 1)
        self.assertIs(self.router.open_requested(str(third)), win2)
        self._wait_for(lambda: str(third.resolve()) in [t["path"] for t in win2.tabs])
        self.assertEqual([t["path"] for t in win1.tabs], [str(second.resolve())])

        # Block Window 2 with a pending close -> no eligible existing window, so creates Window 3.
        win2.pending_close = "window"
        win3 = self.router.open_requested(str(fourth))
        self.assertNotIn(win3, (win1, win2))
        self.assertEqual(len(self.studios), 3)
        self._wait_for(lambda: [t["path"] for t in win3.tabs] == [str(fourth.resolve())])

    def test_untouched_startup_placeholder_removed_while_edited_or_touched_drafts_remain(self) -> None:
        # 1. Untouched startup placeholder is removed when external note opens.
        win_clean = self._create_window()
        self.assertEqual([(t["name"], t["path"]) for t in win_clean.tabs], [("Untitled.md", "")])
        note_a = self.session.data / "clean-open.md"
        note_a.write_text("# Clean Open", encoding="utf-8")
        self.router.open_requested(str(note_a))
        self._wait_for(lambda: any(t["path"] == str(note_a.resolve()) for t in win_clean.tabs))
        self.assertEqual([t["path"] for t in win_clean.tabs], [str(note_a.resolve())])

        # 2. Edited draft in startup tab is never dropped.
        win_draft = self._create_window()
        draft_id = win_draft.tabs[0]["id"]
        win_draft.tabs[0]["content"] = "# Keep this draft"
        note_b = self.session.data / "alongside-draft.md"
        note_b.write_text("# Opened Note", encoding="utf-8")
        self.router.open_requested(str(note_b))
        self._wait_for(lambda: any(t["path"] == str(note_b.resolve()) for t in win_draft.tabs))
        self.assertEqual(len(win_draft.tabs), 2)
        self.assertEqual(win_draft.tabs[0]["id"], draft_id)
        self.assertEqual(win_draft.tabs[0]["content"], "# Keep this draft")
        self.assertEqual(win_draft._current()["path"], str(note_b.resolve()))

        # 3. Renderer edit followed by clearing back to empty still counts as touched and is preserved.
        win_touched = self._create_window()
        touched_id = win_touched.tabs[0]["id"]
        win_touched.post("1", "document_changed", f'{{"id":"{touched_id}","content":"typed"}}')
        win_touched.post("2", "document_changed", f'{{"id":"{touched_id}","content":""}}')
        note_c = self.session.data / "after-touched.md"
        note_c.write_text("# After Touched", encoding="utf-8")
        self.router.open_requested(str(note_c))
        self._wait_for(lambda: any(t["path"] == str(note_c.resolve()) for t in win_touched.tabs))
        self.assertEqual([t["id"] for t in win_touched.tabs], [touched_id, win_touched.active])

        # 4. Failed open (missing file) keeps untouched startup placeholder so tabs are never empty.
        win_error = self._create_window()
        placeholder_id = win_error.tabs[0]["id"]
        self.router.open_requested(str(self.session.data / "does-not-exist.md"))
        for _ in range(10):
            self.app.processEvents()
            time.sleep(0.01)
        self.assertEqual([t["id"] for t in win_error.tabs], [placeholder_id])

    def test_welcome_screen_and_workspace_directory_routing_preserve_expected_tabs(self) -> None:
        # 1. Welcome screen + untouched Welcome.md -> external note dismisses welcome and removes sample placeholder.
        self.session.settings["welcomed"] = False
        win_welcome = self._create_window()
        self.assertFalse(win_welcome.settings["welcomed"])
        self.assertEqual(win_welcome.tabs[0]["name"], "Welcome.md")
        self.assertEqual(win_welcome.tabs[0]["content"], SAMPLE)

        welcome_note = self.session.data / "from-welcome.smd"
        write_portable(welcome_note, "# Portable From Welcome", {})
        self.router.open_requested(str(welcome_note))
        self._wait_for(lambda: any(t["path"] == str(welcome_note.resolve()) for t in win_welcome.tabs))
        self.assertTrue(win_welcome.settings["welcomed"])
        self.assertEqual([t["path"] for t in win_welcome.tabs], [str(welcome_note.resolve())])

        # 2. Welcome screen + edited draft -> draft is preserved when external note arrives.
        self.session.settings["welcomed"] = False
        win_welcome_draft = self._create_window()
        welcome_draft_id = win_welcome_draft.tabs[0]["id"]
        win_welcome_draft.tabs[0]["content"] = "# Edited on welcome"
        second_note = self.session.data / "welcome-keep-draft.md"
        second_note.write_text("# Keep Draft", encoding="utf-8")
        self.router.open_requested(str(second_note))
        self._wait_for(lambda: any(t["path"] == str(second_note.resolve()) for t in win_welcome_draft.tabs))
        self.assertTrue(win_welcome_draft.settings["welcomed"])
        self.assertEqual(len(win_welcome_draft.tabs), 2)
        self.assertEqual(win_welcome_draft.tabs[0]["id"], welcome_draft_id)
        self.assertEqual(win_welcome_draft.tabs[0]["content"], "# Edited on welcome")

        # 3. Welcome screen + explicit "Explore a sample" -> sample is preserved when external note arrives.
        self.session.settings["welcomed"] = False
        win_explored = self._create_window()
        explored_id = win_explored.tabs[0]["id"]
        win_explored.setting("welcomed", "true")
        third_note = self.session.data / "after-explore.md"
        third_note.write_text("# After Explore", encoding="utf-8")
        self.router.open_requested(str(third_note))
        self._wait_for(lambda: any(t["path"] == str(third_note.resolve()) for t in win_explored.tabs))
        self.assertEqual([t["id"] for t in win_explored.tabs], [explored_id, win_explored.active])

        # 4. External workspace directory on Welcome screen routes through openPath & openFolder, preserving tabs.
        self.session.settings["welcomed"] = False
        win_folder = self._create_window()
        folder_signals: list[bool] = []
        win_folder.workspaceFolderDropped.connect(lambda: folder_signals.append(True))
        initial_tab_ids = [t["id"] for t in win_folder.tabs]
        workspace_dir = self.session.data / "external-workspace"
        workspace_dir.mkdir()
        (workspace_dir / "lecture.md").write_text("# Lecture", encoding="utf-8")

        routed_win = self.router.open_requested(str(workspace_dir))
        self.assertIs(routed_win, win_folder)
        self._wait_for(lambda: len(win_folder.files) == 1)
        self.assertTrue(win_folder.settings["welcomed"])
        self.assertEqual(win_folder.folder, folder_ops.canonical_path_str(workspace_dir))
        self.assertEqual([t["id"] for t in win_folder.tabs], initial_tab_ids)
        self.assertEqual(folder_signals, [True])

    def test_hidden_window_and_minimized_window_restoration(self) -> None:
        win = self._create_window(show_window=False)
        self.assertFalse(win.host_window.isVisible())
        note = self.session.data / "into-hidden.md"
        note.write_text("# Hidden Target", encoding="utf-8")

        routed = self.router.open_requested(str(note))
        self.assertIs(routed, win)
        self.assertTrue(win.host_window.isVisible())
        self.assertEqual(win.host_window.shown, 1)
        self._wait_for(lambda: [t["path"] for t in win.tabs] == [str(note.resolve())])

        # Minimized window restores via showNormal() when targeted.
        win.host_window.set_minimized()
        routed_again = self.router.open_requested(str(note))
        self.assertIs(routed_again, win)
        self.assertEqual(win.host_window.shown_normal, 1)

        # Hidden tray/background window with deferred reader activation and maximized window state
        # initializes reader profile, clears _defer_reader_activation, and restores maximized.
        profile_inits: list[bool] = []
        self.session.ensure_reader_profile = lambda: profile_inits.append(True)
        self.session.settings["window"] = {"maximized": True}
        hidden_max = self._create_window(show_window=False)
        hidden_max._defer_reader_activation = True
        woken = self.router.open_requested(None)
        self.assertIs(woken, hidden_max)
        self.assertEqual(profile_inits, [True])
        self.assertFalse(hidden_max._defer_reader_activation)
        self.assertEqual(hidden_max.host_window.shown_maximized, 1)

    def test_outer_whitespace_folder_and_note_paths_preserved_without_stripping(self) -> None:
        win = self._create_window()
        initial_note = self.session.data / "keep-open.md"
        initial_note.write_text("# Keep Open", encoding="utf-8")
        win.openPath(str(initial_note))
        self._wait_for(lambda: [t["path"] for t in win.tabs] == [str(initial_note.resolve())])
        preserved_tab_ids = [t["id"] for t in win.tabs]

        folder_name = "Study folder " if os.name != "nt" else " Study folder"
        decoy_name = "Study folder"
        study_folder = self.session.data / folder_name
        decoy_folder = self.session.data / decoy_name
        study_folder.mkdir()
        decoy_folder.mkdir()
        (study_folder / "expected-study.md").write_text("# Expected Study", encoding="utf-8")
        (decoy_folder / "wrong-decoy.md").write_text("# Decoy", encoding="utf-8")

        self.assertFalse(folder_ops.same_path(study_folder, decoy_folder))
        folder_signals: list[bool] = []
        win.workspaceFolderDropped.connect(lambda: folder_signals.append(True))

        routed_folder_win = self.router.open_requested(str(study_folder))
        self.assertIs(routed_folder_win, win)
        self._wait_for(lambda: [entry["name"] for entry in win.files] == ["expected-study.md"])
        expected_study_folder = Path(folder_ops.strip_extended_length_prefix(str(study_folder.resolve())))
        expected_decoy_folder = Path(folder_ops.strip_extended_length_prefix(str(decoy_folder.resolve())))
        self.assertEqual(win.folder, str(expected_study_folder))
        self.assertEqual(os.fsencode(win.folder), os.fsencode(expected_study_folder))
        self.assertEqual(Path(win.folder).name, folder_name)
        self.assertFalse(folder_ops.same_path(win.folder, decoy_folder))
        self.assertTrue(win.folder.endswith(" ") if os.name != "nt" else win.folder.endswith(" Study folder"))

        save_folder_url = win.defaultSaveFolder()
        save_folder_local = save_folder_url.toLocalFile()
        save_folder_path = _qt_url_local_path(save_folder_url)
        self.assertEqual(save_folder_url, QUrl.fromLocalFile(str(expected_study_folder)))
        self.assertEqual(save_folder_path, expected_study_folder)
        self.assertEqual(os.fsencode(save_folder_path), os.fsencode(expected_study_folder))
        self.assertNotEqual(save_folder_path, expected_decoy_folder)
        self.assertTrue(folder_ops.same_path(save_folder_local, expected_study_folder))
        self.assertFalse(folder_ops.same_path(save_folder_local, decoy_folder))
        self.assertEqual(folder_ops._pure_path(save_folder_local).name, folder_name)
        self.assertTrue(save_folder_local.endswith(" ") if os.name != "nt" else save_folder_local.endswith(" Study folder"))

        save_location_url = win.defaultSaveLocation("Untitled.md")
        save_location_local = save_location_url.toLocalFile()
        save_location_path = _qt_url_local_path(save_location_url)
        expected_save_location = expected_study_folder / "Untitled.md"
        self.assertEqual(save_location_url, QUrl.fromLocalFile(str(expected_save_location)))
        self.assertEqual(save_location_path, expected_save_location)
        self.assertEqual(os.fsencode(save_location_path), os.fsencode(expected_save_location))
        self.assertEqual(folder_ops._pure_path(save_location_local).parent.name, folder_name)
        self.assertEqual(folder_ops._pure_path(save_location_local).name, "Untitled.md")

        self.assertEqual([t["id"] for t in win.tabs], preserved_tab_ids)
        self.assertEqual(folder_signals, [True])

        note_name = " Study note .md " if os.name != "nt" else " Study note.md"
        outer_ws_note = study_folder / note_name
        outer_ws_note.write_text("# Outer Whitespace Note", encoding="utf-8")
        expected_outer_ws_note = Path(folder_ops.strip_extended_length_prefix(str(outer_ws_note.resolve())))
        routed_note_win = self.router.open_requested(str(outer_ws_note))
        self.assertIs(routed_note_win, win)
        self._wait_for(lambda: any(t["path"] == str(expected_outer_ws_note) for t in win.tabs))
        self.assertEqual(win._current()["name"], note_name)
        self.assertEqual(Path(win._current()["path"]).name, note_name)
        self.assertEqual(win._current()["path"], str(expected_outer_ws_note))
        self.assertEqual(os.fsencode(win._current()["path"]), os.fsencode(expected_outer_ws_note))
        self.assertEqual(_qt_url_local_path(win.defaultSaveAsFolder()), expected_study_folder)
        self.assertEqual(_qt_url_local_path(win.defaultSaveAsLocation(note_name)), expected_outer_ws_note)

        # Requesting the same outer-whitespace note again reuses its existing tab.
        win.selectTab(preserved_tab_ids[0])
        reused_win = self.router.open_requested(str(outer_ws_note))
        self.assertIs(reused_win, win)
        self.assertEqual(len(win.tabs), 2)
        self.assertEqual(win._current()["path"], str(expected_outer_ws_note))
        self.assertEqual(os.fsencode(win._current()["path"]), os.fsencode(expected_outer_ws_note))


def _forward_via_broker_client(app_name: str, target: str) -> None:
    QStandardPaths.setTestModeEnabled(True)
    QGuiApplication.setApplicationName(app_name)
    QGuiApplication.setOrganizationName("SuperMD")
    app = QGuiApplication([sys.argv[0]])
    broker = InstanceBroker(app)
    if broker.claim_or_forward(target):
        broker.close()
        raise RuntimeError("Client broker unexpectedly claimed primary lock instead of forwarding")


def _external_route_e2e_probe() -> None:
    from PySide6.QtWebEngineQuick import QtWebEngineQuick
    from main import StudioApplication
    from reader_assets import register_reader_schemes

    QStandardPaths.setTestModeEnabled(True)
    QQuickStyle.setStyle("Material")
    register_reader_schemes()
    QtWebEngineQuick.initialize()

    app_name = "super-md-ext-open-" + uuid.uuid4().hex[:12]
    QGuiApplication.setApplicationName(app_name)
    QGuiApplication.setOrganizationName("SuperMD")
    app = StudioApplication([sys.argv[0]])

    broker = InstanceBroker(app)
    if not broker.claim_or_forward(None):
        raise RuntimeError("Primary InstanceBroker failed to claim fresh test lock")

    with tempfile.TemporaryDirectory(prefix="supermd-ext-route-", ignore_cleanup_errors=True) as tmp:
        tmp_path = Path(tmp)
        probe_html = tmp_path / "probe-reader.html"
        probe_html.write_text(
            "<!doctype html><html><head><meta charset='utf-8'>"
            "<style>body{margin:0;padding:40px 56px;background:#14161a;color:#e8ecf4;"
            "font-family:'Noto Sans',system-ui,sans-serif;line-height:1.65}"
            "h1{margin:0 0 12px;font-size:28px;font-weight:700;color:#f4f7fc}"
            "p{margin:0;color:#b8c0d0;font-size:16px}"
            ".meta{margin-top:16px;font-family:monospace;font-size:13px;color:#8ab4f8}</style></head>"
            "<body><h1 id='heading'>Super MD</h1><p id='body'>Ready</p><div class='meta' id='out'>ready</div>"
            "<script>window.supermdLoad=function(p){"
            "var text=(p.content||'');var lines=text.split('\\n');"
            "document.getElementById('heading').textContent=(lines[0]||'').replace(/^#+\\s*/,'')||'Super MD';"
            "document.getElementById('body').textContent=lines.slice(1).join(' ').trim()||'External file-open route verified.';"
            "document.getElementById('out').textContent=p.path||p.id||'loaded';};"
            "document.title='ready';</script></body></html>",
            encoding="utf-8",
        )

        channel = QFile(":/qtwebchannel/qwebchannel.js")
        if not channel.open(QIODevice.OpenModeFlag.ReadOnly):
            raise RuntimeError("Qt WebChannel runtime unavailable")
        channel_script = bytes(channel.readAll()).decode()

        session = Session(True)
        session.settings["welcomed"] = False  # Start on the Welcome screen!
        session.settings["motion"] = False
        session.settings["python"] = sys.executable

        engines: list[QQmlApplicationEngine] = []
        studios: list[QuietStudio] = []

        def create_window(note: str | None = None, *, show_window: bool = True) -> QuietStudio:
            engine = QQmlApplicationEngine()
            studio = QuietStudio(True, session)
            studio.ready = True
            studio.newWindowRequested.connect(create_window)
            engine.rootContext().setContextProperty("studio", studio)
            engine.rootContext().setContextProperty("readerUrl", QUrl.fromLocalFile(str(probe_html)))
            engine.rootContext().setContextProperty("channelScript", channel_script)
            engine.rootContext().setContextProperty(
                "brandUrl", QUrl.fromLocalFile(str(ROOT / "public" / "brand-mark-fixed.svg"))
            )
            engine.load(QUrl.fromLocalFile(str(ROOT / "desktop" / "qml" / "Main.qml")))
            if not engine.rootObjects():
                raise RuntimeError("Main.qml failed to load in E2E external file-open probe")
            window = engine.rootObjects()[0]
            studio.host_window = window
            if show_window:
                window.show()
            engines.append(engine)
            studios.append(studio)
            router.register_window(studio, activated=show_window)
            if note:
                studio.openPath(str(note))
            return studio

        router = ExternalOpenRouter(studios, lambda note=None: create_window(note), app=app)
        broker.requested.connect(lambda note: router.open_requested(note or None))
        app.openRequested.connect(router.open_requested)

        def pump_until(predicate, timeout: float = 8.0, desc: str = "condition") -> None:
            deadline = time.monotonic() + timeout
            while time.monotonic() < deadline:
                app.processEvents()
                QTest.qWait(15)
                if predicate():
                    return
            app.processEvents()
            if not predicate():
                raise AssertionError(f"Timed out waiting for {desc}")

        def send_broker_open(target_path: str) -> None:
            proc = subprocess.Popen(
                [sys.executable, str(Path(__file__).resolve()), "--broker-client", app_name, target_path],
                env=os.environ.copy(),
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
            )
            deadline = time.monotonic() + 8.0
            while proc.poll() is None and time.monotonic() < deadline:
                app.processEvents()
                QTest.qWait(15)
            out, err = proc.communicate(timeout=2)
            if proc.returncode != 0:
                raise AssertionError(f"Broker client failed ({proc.returncode}): {out}\n{err}")
            app.processEvents()

        def view_state(studio) -> dict:
            raw = studio.host_window.property("viewState")
            return raw.toVariant() if hasattr(raw, "toVariant") else raw

        try:
            # 1. Initial window starts on Welcome screen (!viewState.settings.welcomed).
            win1 = create_window(None)
            pump_until(lambda: not bool(view_state(win1)["settings"]["welcomed"]), desc="welcome screen")
            if win1.tabs[0]["name"] != "Welcome.md":
                raise AssertionError(f"Expected Welcome.md placeholder, got {win1.tabs}")

            # 2. Deliver real QFileOpenEvent to StudioApplication while on Welcome screen:
            #    dismisses Welcome screen, opens first_note in win1, removes untouched Welcome.md!
            first_note = tmp_path / "welcome-external.md"
            first_note.write_text("# Opened From Finder\n\nBody text.", encoding="utf-8")
            app.sendEvent(app, QFileOpenEvent(str(first_note)))
            pump_until(
                lambda: [t["path"] for t in win1.tabs] == [str(first_note.resolve())]
                and bool(view_state(win1)["settings"]["welcomed"]),
                desc="QFileOpenEvent from welcome screen",
            )
            if len(studios) != 1:
                raise AssertionError(f"Expected 1 window after welcome open, got {len(studios)}")

            # 3. Open second window, edit its startup placeholder into an unsaved draft, and send
            #    second_note through real InstanceBroker IPC from a second process:
            #    opens in win2 (last active window) and preserves win2's edited draft!
            win2 = create_window(None)
            draft_id = win2.tabs[0]["id"]
            win2.tabs[0]["content"] = "# Unsaved Draft In Window 2"
            second_note = tmp_path / "broker-second.md"
            second_note.write_text("# Opened Via InstanceBroker", encoding="utf-8")
            send_broker_open(str(second_note))
            pump_until(
                lambda: any(t["path"] == str(second_note.resolve()) for t in win2.tabs),
                desc="InstanceBroker open into active win2",
            )
            if len(studios) != 2:
                raise AssertionError(f"Expected 2 windows, got {len(studios)}")
            if len(win2.tabs) != 2 or win2.tabs[0]["id"] != draft_id or win2.tabs[0]["content"] != "# Unsaved Draft In Window 2":
                raise AssertionError(f"Edited draft in win2 was not preserved: {win2.tabs}")

            # 4. Activate win1 (older window) after win2, then send a new external note via InstanceBroker:
            #    lands in win1 (last active eligible window), not win2!
            app.sendEvent(win1.host_window, QEvent(QEvent.Type.WindowActivate))
            back_to_win1_note = tmp_path / "mru-win1.md"
            back_to_win1_note.write_text("# Routed To Last Active Win1", encoding="utf-8")
            send_broker_open(str(back_to_win1_note))
            pump_until(
                lambda: any(t["path"] == str(back_to_win1_note.resolve()) for t in win1.tabs),
                desc="MRU switchback routes new external note to win1",
            )
            if any(t["path"] == str(back_to_win1_note.resolve()) for t in win2.tabs):
                raise AssertionError("Note unexpectedly opened in win2 after win1 was activated")

            # 5. Create win3 (untouched Untitled.md) and open third_note via QFileOpenEvent:
            #    untouched Untitled.md in win3 is removed!
            win3 = create_window(None)
            if [(t["name"], t["path"]) for t in win3.tabs] != [("Untitled.md", "")]:
                raise AssertionError(f"Expected untouched Untitled.md in win3, got {win3.tabs}")
            third_note = tmp_path / "clean-win3.md"
            third_note.write_text("# Clean Win3 Note", encoding="utf-8")
            app.sendEvent(app, QFileOpenEvent(QUrl.fromLocalFile(str(third_note))))
            pump_until(
                lambda: [t["path"] for t in win3.tabs] == [str(third_note.resolve())],
                desc="untouched Untitled.md replaced in win3",
            )

            # 6. While win3 is last active, send first_note (already open in win1!) via InstanceBroker:
            #    reuses win1's existing tab without duplicating in win3 or creating win4!
            app.sendEvent(win3.host_window, QEvent(QEvent.Type.WindowActivate))
            if win1._current()["path"] == str(first_note.resolve()):
                raise AssertionError("Expected back_to_win1_note to be active in win1 before reusing first_note")

            send_broker_open(str(first_note))
            pump_until(
                lambda: win1._current()["path"] == str(first_note.resolve()),
                desc="already-open note focused in win1 via InstanceBroker",
            )
            if len(studios) != 3:
                raise AssertionError(f"Expected 3 windows after reusing existing tab, got {len(studios)}")
            if [t["path"] for t in win3.tabs] != [str(third_note.resolve())]:
                raise AssertionError(f"win3 tabs unexpectedly changed: {win3.tabs}")

            # 6. Collapse win1's sidebar and switch section away from folder, then open an external
            #    workspace directory via QFileOpenEvent: routes through openPath & openFolder in win1,
            #    reveals folder sidebar, and preserves win1's tabs!
            win1.host_window.setProperty("sidebar", False)
            win1.host_window.setProperty("sidebarSection", "contents")
            win1_tab_ids = [t["id"] for t in win1.tabs]
            workspace_dir = tmp_path / "project-notes"
            workspace_dir.mkdir()
            (workspace_dir / "chapter-01.md").write_text("# Chapter 1", encoding="utf-8")
            (workspace_dir / "chapter-02.md").write_text("# Chapter 2", encoding="utf-8")

            app.sendEvent(app, QFileOpenEvent(QUrl.fromLocalFile(str(workspace_dir))))
            pump_until(
                lambda: win1.folder == folder_ops.canonical_path_str(workspace_dir) and len(win1.files) == 2,
                desc="external workspace directory open in win1",
            )
            if [t["id"] for t in win1.tabs] != win1_tab_ids:
                raise AssertionError(f"Opening workspace directory altered win1 tabs: {win1.tabs}")
            if not bool(win1.host_window.property("sidebar")) or win1.host_window.property("sidebarSection") != "folder":
                raise AssertionError(
                    f"Folder sidebar not revealed: sidebar={win1.host_window.property('sidebar')}, "
                    f"section={win1.host_window.property('sidebarSection')}"
                )

            # 7. Open Settings modal on win1 (modalDialogCount > 0) while win1 is last active, then
            #    deliver fourth_note via QFileOpenEvent: skips modal-blocked win1 and opens in win3!
            win1.host_window.setProperty("settingsOpen", True)
            pump_until(lambda: int(win1.host_window.property("modalDialogCount") or 0) > 0, desc="win1 settings modal")
            fourth_note = tmp_path / "modal-skip.md"
            fourth_note.write_text("# Skipped Modal Win1", encoding="utf-8")
            app.sendEvent(app, QFileOpenEvent(str(fourth_note)))
            pump_until(
                lambda: any(t["path"] == str(fourth_note.resolve()) for t in win3.tabs),
                desc="modal-blocked win1 skipped in favor of eligible win3",
            )
            win1.host_window.setProperty("settingsOpen", False)
            pump_until(
                lambda: int(win1.host_window.property("modalDialogCount") or 0) == 0,
                desc="win1 settings modal closed",
            )

            # 8. Real QFileOpenEvent and real InstanceBroker IPC with valid outer-whitespace
            #    folder ('Study folder ' on POSIX / ' Study folder' on Windows) and note paths:
            #    preserves exact path bytes without stripping or colliding with 'Study folder'.
            app.sendEvent(win1.host_window, QEvent(QEvent.Type.WindowActivate))
            win1.host_window.setProperty("sidebar", False)
            win1_tabs_before_ws_folder = [t["id"] for t in win1.tabs]
            ws_folder_name = "Study folder " if os.name != "nt" else " Study folder"
            ws_folder = tmp_path / ws_folder_name
            ws_decoy = tmp_path / "Study folder"
            ws_folder.mkdir()
            ws_decoy.mkdir()
            (ws_folder / "outer-space-chapter.md").write_text("# Outer Space Chapter", encoding="utf-8")
            (ws_decoy / "wrong-decoy.md").write_text("# Wrong Decoy", encoding="utf-8")
            expected_ws_folder = Path(folder_ops.strip_extended_length_prefix(str(ws_folder.resolve())))

            app.sendEvent(app, QFileOpenEvent(str(ws_folder)))
            pump_until(
                lambda: win1.folder == str(expected_ws_folder)
                and [entry["name"] for entry in win1.files] == ["outer-space-chapter.md"],
                desc="QFileOpenEvent folder with outer whitespace",
            )
            if os.fsencode(win1.folder) != os.fsencode(expected_ws_folder) or Path(win1.folder).name != ws_folder_name:
                raise AssertionError(f"Outer-whitespace folder bytes/basename mismatch: {win1.folder!r}")
            if folder_ops.same_path(win1.folder, ws_decoy):
                raise AssertionError(f"Outer-whitespace folder collided with decoy: {win1.folder!r}")
            e2e_save_folder_local = win1.defaultSaveFolder().toLocalFile()
            if (
                _qt_url_local_path(win1.defaultSaveFolder()) != expected_ws_folder
                or folder_ops._pure_path(e2e_save_folder_local).name != ws_folder_name
                or folder_ops.same_path(e2e_save_folder_local, ws_decoy)
                or _qt_url_local_path(win1.defaultSaveLocation("Untitled.md")) != expected_ws_folder / "Untitled.md"
            ):
                raise AssertionError(f"Outer-whitespace defaultSaveFolder mismatch: {e2e_save_folder_local!r}")
            if [t["id"] for t in win1.tabs] != win1_tabs_before_ws_folder:
                raise AssertionError(f"Opening outer-whitespace folder altered win1 tabs: {win1.tabs}")
            if not bool(win1.host_window.property("sidebar")) or win1.host_window.property("sidebarSection") != "folder":
                raise AssertionError("Outer-whitespace folder did not reveal folder sidebar")

            ws_note_name = " Broker study note .md " if os.name != "nt" else " Broker study note.md"
            ws_note = ws_folder / ws_note_name
            ws_note.write_text("# Outer Whitespace Broker Note", encoding="utf-8")
            expected_ws_note = Path(folder_ops.strip_extended_length_prefix(str(ws_note.resolve())))
            send_broker_open(str(ws_note))
            pump_until(
                lambda: win1._current()["path"] == str(expected_ws_note)
                and win1._current()["name"] == ws_note_name,
                desc="InstanceBroker note with outer whitespace",
            )
            if os.fsencode(win1._current()["path"]) != os.fsencode(expected_ws_note):
                raise AssertionError(f"Outer-whitespace note path bytes mismatch: {win1._current()['path']!r}")
            win1_tab_count = len(win1.tabs)

            # Re-open the same outer-whitespace note via QFileOpenEvent while win3 is active:
            # reuses win1's existing tab without creating a duplicate tab or extra window!
            win1.selectTab(win1_tabs_before_ws_folder[0])
            app.sendEvent(win3.host_window, QEvent(QEvent.Type.WindowActivate))
            app.sendEvent(app, QFileOpenEvent(QUrl.fromLocalFile(str(ws_note))))
            pump_until(
                lambda: win1._current()["path"] == str(expected_ws_note),
                desc="QFileOpenEvent reuse of outer-whitespace note tab",
            )
            if len(win1.tabs) != win1_tab_count or len(studios) != 3:
                raise AssertionError(
                    f"Expected outer-whitespace note tab reuse in win1 without new window: "
                    f"tabs={len(win1.tabs)}, windows={len(studios)}"
                )

            screenshot_out = os.environ.get("SUPERMD_EXT_OPEN_SCREENSHOT", "").strip()
            if screenshot_out:
                for _ in range(10):
                    app.processEvents()
                    QTest.qWait(25)
                win1.host_window.grabWindow().save(screenshot_out, "PNG")
        finally:
            broker.close()
            for studio in list(studios):
                if studio.host_window is not None:
                    studio.host_window.setProperty("closingAllowed", True)
                    studio.host_window.close()
                    studio.host_window.deleteLater()
            app.sendPostedEvents(None, QEvent.Type.DeferredDelete)
            for engine in list(engines):
                engine.deleteLater()
            app.sendPostedEvents(None, QEvent.Type.DeferredDelete)
            for studio in list(studios):
                studio.stop()
                studio.pool.shutdown(wait=True)
                studio._search_pool.shutdown(wait=True)
                studio.deleteLater()
            session.writes.shutdown(wait=True)
            app.sendPostedEvents(None, QEvent.Type.DeferredDelete)
            app.processEvents()


class ExternalFileOpenEndToEndRouteTest(unittest.TestCase):
    def test_actual_qfileopenevent_and_instance_broker_routes_across_welcome_and_multiple_windows(self) -> None:
        env = os.environ.copy()
        env.setdefault("QT_QPA_PLATFORM", "offscreen")
        env.setdefault("QT_QUICK_BACKEND", "software")
        result = subprocess.run(
            [sys.executable, str(Path(__file__).resolve()), "--e2e-route-probe"],
            env=env,
            capture_output=True,
            text=True,
            timeout=90,
        )
        self.assertEqual(
            result.returncode,
            0,
            f"External file-open E2E probe failed ({result.returncode}):\nSTDOUT:\n{result.stdout}\nSTDERR:\n{result.stderr}",
        )


if __name__ == "__main__":
    if len(sys.argv) >= 4 and sys.argv[1] == "--broker-client":
        _forward_via_broker_client(sys.argv[2], sys.argv[3])
        sys.exit(0)
    if "--e2e-route-probe" in sys.argv:
        _external_route_e2e_probe()
        sys.exit(0)
    unittest.main()
