"""Focused unit tests for extracted desktop/studio_tabs.py domain helpers and Studio facade."""
from __future__ import annotations

import json, os, shutil, sys, tempfile, time, unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
os.environ.setdefault("QT_QUICK_BACKEND", "software")

from PySide6.QtCore import QCoreApplication, QPoint, QPointF, Qt
from PySide6.QtGui import QGuiApplication
from PySide6.QtQuickControls2 import QQuickStyle

import folder_ops
from studio import Session, Studio, _same_closed_revision, _snapshot_tab_state
from test_studio import QuietStudio


def _wait_until(predicate, timeout: float = 3.0) -> bool:
    app = QCoreApplication.instance()
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if app is not None:
            app.processEvents()
        if predicate():
            return True
        time.sleep(0.01)
    return bool(predicate())


class StudioTabsTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if QGuiApplication.instance() is None:
            QQuickStyle.setStyle("Material")
        cls.app = QGuiApplication.instance() or QGuiApplication(["Studio tabs unit tests"])

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="supermd-studio-tabs-")
        self.root = Path(self.temp.name).resolve()
        self.session = Session(True)
        self.session.settings["python"] = sys.executable
        self.studio = QuietStudio(True, self.session)
        self.extra_windows: list[QuietStudio] = []

    def tearDown(self):
        for win in reversed([self.studio, *self.extra_windows]):
            win.stop()
            win._search_pool.shutdown(wait=True, cancel_futures=True)
            win.pool.shutdown(wait=True, cancel_futures=True)
        self.session.writes.shutdown(wait=True)
        shutil.rmtree(self.session.data, ignore_errors=True)
        self.temp.cleanup()

    def _new_window(self) -> QuietStudio:
        win = QuietStudio(True, self.session)
        self.extra_windows.append(win)
        return win

    def test_note_dirty_pin_recent_current_seeded_find_and_unbound_proxies(self):
        proxy = SimpleNamespace(tabs=[], active="")
        self.assertEqual((Studio._current(proxy)["id"], Studio._current(proxy)["name"]), ("", "Super MD"))
        img = "data:image/png;base64,AAAA"
        note = Studio._note(proxy, "Doc.smd", "# Hi\n", "/tmp/doc.smd", "# Hi\n", {"a.png": img}, True)
        self.assertEqual((note["agent_staged"], note["agent_unreviewed"], note["agent_edits"]), (False, False, []))
        self.assertIsNot(note["assets"], note["saved_assets"])
        self.assertFalse(Studio._is_dirty(proxy, note))

        snap = _snapshot_tab_state({**note, "outline": [{"text": "Hi"}], "viewState": {"y": 12}}, include_view_state=False)
        self.assertNotIn("viewState", snap)
        self.assertIs(snap["assets"]["a.png"], img)
        self.assertTrue(_same_closed_revision(snap, dict(snap)))

        note["assets"]["b.png"] = img
        self.assertTrue(Studio._is_dirty(proxy, note))
        note["saved_assets"] = dict(note["assets"])
        note["assets_dirty"] = True
        self.assertTrue(Studio._is_dirty(proxy, note))
        note["assets_dirty"] = False
        note["content"] = "# Changed\n"
        self.assertTrue(Studio._is_dirty(proxy, note))

        first = self.root / "first.md"
        first.write_text("# First\n", encoding="utf-8")
        second = self._new_window()
        self.studio.openNote(str(first))
        self.assertTrue(_wait_until(lambda: any(t["path"] == str(first) for t in self.studio.tabs)))
        sidebar_hits: list[int] = []
        second.sidebarChanged.connect(lambda: sidebar_hits.append(1))
        self.studio.pinRecent(str(first))
        self.assertEqual(len(self.studio.pinnedRecent), 1)
        self.assertGreaterEqual(len(sidebar_hits), 1)
        self.studio.pinRecent(str(first))
        self.assertEqual(self.studio.pinnedRecent, [])

        self.studio._pending_seeded_find = {"tabId": "", "path": str(first), "query": "First", "caseSensitive": True, "sourceStart": 2, "sourceEnd": 7, "matchText": "First"}
        self.assertEqual(self.studio._consume_seeded_find(self.studio._current()), {"query": "First", "caseSensitive": True, "sourceStart": 2, "sourceEnd": 7, "matchText": "First"})
        self.assertIsNone(self.studio._pending_seeded_find)
        proxy._pending_seeded_find = {"tabId": note["id"], "path": "", "query": "Hi", "caseSensitive": False, "sourceStart": -1, "sourceEnd": 2}
        self.assertEqual(Studio._consume_seeded_find(proxy, note), {"query": "Hi", "caseSensitive": False})

    def test_open_note_reuse_startup_restore_pending_heading_folder_redirect_and_navigation(self):
        vault = self.root / "vault"
        vault.mkdir()
        alpha, beta, gamma = vault / "alpha.md", vault / "beta.md", vault / "gamma.md"
        alpha.write_text("# Alpha\n\n## Details\n", encoding="utf-8")
        beta.write_text("# Beta\n", encoding="utf-8")
        gamma.write_text("# Gamma\n", encoding="utf-8")

        picker_hits: list[int] = []
        self.studio.folderPickerRequested.connect(lambda: picker_hits.append(1))
        with patch("studio.sys.platform", "darwin"):
            self.studio.chooseFolder()
        self.assertEqual(len(picker_hits), 1)

        self.studio._open_note(str(vault), explicit=True)
        self.assertEqual(self.studio.folder, folder_ops.canonical_path_str(vault))

        self.studio._startup_placeholder_ids = {self.studio.tabs[0]["id"]}
        self.studio._restoring_paths = {str(beta), str(alpha)}
        self.studio._startup_entries = [{"path": str(alpha), "id": "a"}, {"path": str(beta), "id": "b"}]
        self.studio._startup_active = str(beta)
        gen = self.studio._activation_generation
        self.studio._open_note(str(beta), explicit=False, activation_generation=gen)
        self.studio._open_note(str(alpha), explicit=False, activation_generation=gen)
        self.assertTrue(_wait_until(lambda: {t["path"] for t in self.studio.tabs} == {str(alpha), str(beta)}))
        self.assertEqual(([t["path"] for t in self.studio.tabs], self.studio._current()["path"]), ([str(alpha), str(beta)], str(beta)))
        beta_id = self.studio.active

        self.studio.openPath(str(alpha))
        self.studio._open_note(str(alpha), explicit=True, pending_heading="Details")
        self.assertEqual(len(self.studio.tabs), 2)
        alpha_tab = next(t for t in self.studio.tabs if t["path"] == str(alpha))
        self.assertEqual((self.studio.active, alpha_tab.get("pendingHeading")), (alpha_tab["id"], "Details"))

        self.studio.newNote()
        untitled_id = self.studio.active
        alpha_tab.update(content="# Alpha staged\n", agent_staged=True, agent_unreviewed=True)
        self.studio._agent_jump_tab_id = alpha_tab["id"]
        self.studio.settings["autosave"] = True
        self.studio.autosave_timer.stop()
        self.studio.selectTab(alpha_tab["id"])
        self.assertEqual((alpha_tab["agent_staged"], self.studio._agent_jump_tab_id, alpha_tab.get("pendingHeading")), (False, "", None))
        self.assertTrue(self.studio.autosave_timer.isActive())
        self.studio.autosave_timer.stop()

        self.studio.cycleTab(1)
        self.assertEqual(self.studio.active, beta_id)
        self.studio.cycleTab(1)
        self.assertEqual(self.studio.active, untitled_id)
        self.studio.moveActiveTab(-1)
        self.assertEqual(self.studio.tabs[1]["id"], untitled_id)
        self.studio.tabNumber(1)
        self.assertEqual(self.studio.active, alpha_tab["id"])
        self.studio.tabNumber(9)
        self.assertEqual(self.studio.active, beta_id)
        self.studio._open_note(str(gamma), explicit=True, background=True)
        self.assertTrue(_wait_until(lambda: any(t["path"] == str(gamma) for t in self.studio.tabs)))
        self.assertEqual(self.studio.active, beta_id)

    def test_tab_drag_move_preview_and_cross_window_transfer(self):
        target = self._new_window()
        self.studio.tabs[0]["content"] = "x" * 1000
        first_id = self.studio.tabs[0]["id"]
        self.assertEqual((len(self.studio.tabPreview(first_id)), self.studio.tabPreview("missing")), (900, ""))

        self.studio._staging_tabs.add(first_id)
        self.assertEqual((self.studio._can_move(), target.canReceiveTab(self.studio.window_id, first_id)), (False, False))
        self.studio._staging_tabs.clear()
        self.assertEqual((self.studio._can_move(), target.canReceiveTab(self.studio.window_id, first_id)), (True, True))

        self.studio.newNote()
        second_tab = self.studio._current()
        second_tab.update(content="Dirty portable body", assets={"fig.png": "data:image/png;base64,BBBB"}, assets_dirty=True)
        second_id = second_tab["id"]
        self.studio.receiveTab(self.studio.window_id, second_id, 0)
        self.assertEqual([t["id"] for t in self.studio.tabs], [second_id, first_id])

        with patch.object(self.studio, "_flush") as flush_spy:
            target.receiveTab(self.studio.window_id, second_id, 1)
        self.assertEqual((flush_spy.call_args.args[0], json.loads(flush_spy.call_args.args[1])), ("move_tab", {"window": target.window_id, "tab": second_id, "index": 1}))

        self.assertTrue(self.studio._move_tab(target, second_id, 0))
        self.assertIs(target.tabs[0], second_tab)
        self.assertEqual(target.active, second_id)
        self.assertTrue(all(d["id"] != second_id for d in self.session.drafts.get(self.studio.window_id, [])))

        scheduled: list = []
        with patch("studio.QTimer.singleShot", side_effect=lambda ms, fn: scheduled.append((ms, fn))):
            self.studio.finishTabDrag(first_id, int(Qt.DropAction.MoveAction.value))
            self.studio.finishTabDrag(first_id, int(Qt.DropAction.IgnoreAction.value))
        self.assertEqual((len(scheduled), scheduled[0][0]), (1, 150))

        with patch.object(self.studio, "detachTab") as detach_spy:
            with patch("studio.QGuiApplication.mouseButtons", return_value=Qt.MouseButton.LeftButton):
                scheduled[0][1]()
            fake_strip = SimpleNamespace(mapFromGlobal=lambda _pt: QPointF(10.0, 5.0), width=lambda: 100.0, height=lambda: 30.0)
            self.studio.host_window = SimpleNamespace(isVisible=lambda: True, findChild=lambda _cls, name: fake_strip if name == "tabStrip" else None)
            with patch("studio.QGuiApplication.mouseButtons", return_value=Qt.MouseButton.NoButton), patch("studio.QCursor.pos", return_value=QPoint(25, 15)):
                scheduled[0][1]()
            detach_spy.assert_not_called()
            self.studio.host_window = None
            with patch("studio.QGuiApplication.mouseButtons", return_value=Qt.MouseButton.NoButton), patch("studio.QCursor.pos", return_value=QPoint(500, 500)):
                scheduled[0][1]()
            detach_spy.assert_called_once_with(first_id)

    def test_close_tab_reopen_and_window_close_resolutions(self):
        saved_note = self.root / "saved.md"
        saved_note.write_text("# Original\n", encoding="utf-8")
        self.studio.openNote(str(saved_note))
        self.assertTrue(_wait_until(lambda: any(t["path"] == str(saved_note) for t in self.studio.tabs)))
        tab = next(t for t in self.studio.tabs if t["path"] == str(saved_note))
        tab_id = tab["id"]
        tab["content"] = "# Unsaved edit\n"
        self.studio._agent_jump_tab_id = tab_id
        self.studio._last_reader_agent_seq[tab_id] = 7

        close_prompts: list[str] = []
        self.studio.closeRequested.connect(close_prompts.append)
        self.studio.closeTab(tab_id)
        self.assertEqual((self.studio.pending_close, close_prompts), (tab_id, ["saved.md"]))
        self.studio.resolveClose("cancel")
        self.assertEqual(self.studio.pending_close, "")

        self.studio.pending_close = tab_id
        with patch.object(self.studio, "save") as save_spy:
            self.studio.resolveClose("save")
        save_spy.assert_called_once()

        self.studio.pending_close = tab_id
        self.studio.resolveClose("discard")
        self.assertTrue(_wait_until(lambda: all(t["id"] != tab_id for t in self.studio.tabs) and len(self.studio.closed_tabs) == 1))
        self.assertEqual((self.studio._agent_jump_tab_id, tab_id in self.studio._last_reader_agent_seq), ("", False))

        self.studio.reopenTab()
        self.assertTrue(_wait_until(lambda: any(t["id"] == tab_id for t in self.studio.tabs)))
        reopened = next(t for t in self.studio.tabs if t["id"] == tab_id)
        self.assertEqual((reopened["agent_staged"], reopened["agent_unreviewed"], reopened["agent_edits"]), (False, False, []))
        self.assertEqual((reopened["content"], reopened["saved"], self.studio.closed_tabs), ("# Unsaved edit\n", "# Original\n", []))
        reopened["saved"] = reopened["content"]

        self.studio.newNote()
        self.studio._current()["content"] = "Window close draft"
        allow_closes: list[int] = []
        cancel_quits: list[int] = []
        self.studio.allowClose.connect(lambda: allow_closes.append(1))
        self.session.background = SimpleNamespace(_stopping_from_cli=True, cancel_quit=lambda: cancel_quits.append(1))
        self.studio.host_window = SimpleNamespace(isVisible=lambda: False)
        self.assertTrue(self.studio.requestWindowClose())
        self.studio.host_window = None
        self.assertFalse(self.studio.requestWindowClose())
        self.assertEqual(self.studio.pending_close, "window")
        self.studio.resolveClose("cancel")
        self.assertEqual((self.studio.pending_close, cancel_quits), ("", [1]))
        self.assertFalse(self.studio.requestWindowClose())
        self.studio.resolveClose("discard")
        self.assertEqual((len(allow_closes), len(self.studio.closed_tabs)), (1, 1))
        self.assertEqual(self.session.closed_note_store.load(self.studio.closed_tabs[0])["content"], "Window close draft")
