import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import textwrap
import threading
import time
import unittest
from unittest import mock

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
os.environ.setdefault("QT_QUICK_BACKEND", "software")

DESKTOP = Path(__file__).resolve().parent
if str(DESKTOP) not in sys.path:
    sys.path.insert(0, str(DESKTOP))

from PySide6.QtTest import QTest
from PySide6.QtWidgets import QApplication

import file_events
import folder_ops
import studio
from studio import Session, Studio
from workspace_links import resolve_workspace_link


class QuietStudio(Studio):
    def _choose_default_python(self, emit=True):
        self.python_status = "No Python interpreter configured."


class RenameWatcherAndShutdownTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.app = QApplication.instance() or QApplication([])

    def setUp(self):
        self.session = Session(True)
        self.studio = QuietStudio(True, self.session)
        raw_workspace = self.studio.data / "Workspace"
        raw_workspace.mkdir(parents=True, exist_ok=True)
        self.workspace = Path(folder_ops.canonical_path_str(raw_workspace))
        (self.workspace / "Overview.md").write_text("# Overview\n\nInitial overview", encoding="utf-8")
        (self.workspace / "Reading.md").write_text("# Reading\n\nChapter list", encoding="utf-8")
        sub = self.workspace / "Coursework"
        sub.mkdir()
        (sub / "Week 1.md").write_text("# Week 1\n\nIntro notes", encoding="utf-8")

    def tearDown(self):
        data_dir = self.studio.data
        for win in list(self.session.windows.values()):
            if not win.retired:
                win.stop()
            win.pool.shutdown(wait=True, cancel_futures=True)
            win._search_pool.shutdown(wait=True, cancel_futures=True)
        if not self.studio.retired:
            self.studio.stop()
        self.studio.pool.shutdown(wait=True, cancel_futures=True)
        self.studio._search_pool.shutdown(wait=True, cancel_futures=True)
        self.session.writes.shutdown(wait=True)
        self.app.processEvents()
        shutil.rmtree(data_dir, ignore_errors=True)

    def _retire_window(self, win: Studio):
        if not win.retired:
            win.stop()
        win.pool.shutdown(wait=True, cancel_futures=True)
        win._search_pool.shutdown(wait=True, cancel_futures=True)

    def wait_until(self, predicate, timeout=5.0):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            self.app.processEvents()
            if predicate():
                return
            QTest.qWait(15)
        self.app.processEvents()
        self.assertTrue(predicate(), "Timed out waiting for condition")

    def _settle_watchers(self):
        QTest.qWait(40)
        self.app.processEvents()
        if self.studio.external_timer.isActive():
            self.studio.external_timer.stop()
            self.studio._refresh_external_notes()
        QTest.qWait(30)
        self.app.processEvents()

    def _same_path_list(self, actual, expected) -> bool:
        return len(actual) == len(expected) and all(
            folder_ops.same_path(a, b) for a, b in zip(actual, expected)
        )

    def _contains_path(self, paths, candidate) -> bool:
        return any(folder_ops.same_path(p, candidate) for p in paths)

    def test_rename_holds_suspension_until_ui_rebind_and_guards_parent_watcher_notifications(self):
        overview = self.workspace / "Overview.md"
        coursework = self.workspace / "Coursework"
        week1 = coursework / "Week 1.md"

        self.studio.openFolder(str(self.workspace))
        self.studio.toggleDirectory(str(coursework))
        self.wait_until(lambda: any(f["name"] == "Week 1.md" for f in self.studio.files))

        self.studio.openNote(str(overview))
        self.wait_until(lambda: folder_ops.same_path(self.studio._current()["path"], overview))
        overview_tab_id = self.studio.active
        self.studio.post(
            "dirty-overview",
            "document_changed",
            json.dumps({"id": overview_tab_id, "content": "# Overview\n\nUnsaved overview revision"}),
        )
        self.studio.post(
            "pos-overview",
            "reading_position",
            json.dumps({
                "id": overview_tab_id,
                "location": {"top": 3, "offset": 0.25, "zoom": 100, "mode": "live"},
            }),
        )
        self.studio.pinRecent(str(overview))
        self.studio._save_positions()
        self.studio._recover()
        self.session.writes.flush(timeout=3.0)
        self._settle_watchers()

        held_completions: list[object] = []
        completion_queued = threading.Event()
        orig_on_rename_completed = self.session._on_rename_completed

        def defer_rename_completion(payload):
            held_completions.append(payload)
            completion_queued.set()

        renamed_overview = self.workspace / "Course Overview.md"
        pre_rename_known = dict(self.studio.note_identities)
        self.assertTrue(any(folder_ops.same_path(k, overview) for k in pre_rename_known))

        self.session.renameCompleted.disconnect(orig_on_rename_completed)
        self.session.renameCompleted.connect(defer_rename_completion)
        try:
            # 1. Note rename: hold UI completion while pre-queued reconcile & live parent notifications fire.
            reconcile_gate = threading.Event()
            reconcile_finished = threading.Event()
            orig_reconcile = file_events.reconcile

            def gated_reconcile(known, changed):
                reconcile_gate.wait(timeout=3.0)
                try:
                    return orig_reconcile(known, changed)
                finally:
                    reconcile_finished.set()

            with mock.patch.object(file_events, "reconcile", side_effect=gated_reconcile):
                self.studio.external_paths = {str(self.workspace)}
                self.studio._refresh_external_notes()

                self.studio.renameNote(overview_tab_id, "Course Overview.md")
                self.session.writes.flush(timeout=3.0)
                self.wait_until(lambda: completion_queued.is_set())

                self.assertFalse(overview.exists())
                self.assertTrue(renamed_overview.is_file())
                active_susp = self.studio._active_watch_suspensions()
                self.assertEqual(len(active_susp), 1)
                file_susp_event = active_susp[0][3]
                self.assertFalse(file_susp_event.is_set())

                self.studio._emit(False)
                watched_now = self.studio.note_watcher.files() + self.studio.note_watcher.directories()
                for w_path in watched_now:
                    self.assertFalse(folder_ops.same_path(w_path, str(overview)))
                    self.assertFalse(folder_ops.same_path(w_path, str(renamed_overview)))
                    self.assertFalse(folder_ops.same_path(w_path, str(self.workspace)))

                self.studio.note_watcher.directoryChanged.emit(str(self.workspace))
                self.studio._external_note_changed(str(self.workspace))
                self.assertEqual(self.studio.external_paths, set())
                self.studio.external_paths = {str(self.workspace)}
                self.studio._refresh_external_notes()
                reconcile_gate.set()
                self.assertTrue(reconcile_finished.wait(timeout=3.0))
                QTest.qWait(40)
                self.app.processEvents()

                self.assertTrue(any(t["id"] == overview_tab_id for t in self.studio.tabs))
                self.assertEqual(self.session.drafts.get("deleted-notes", []), [])
                self.assertTrue(self._same_path_list(self.session.pinned, [overview]))

            self.assertEqual(len(held_completions), 1)
            orig_on_rename_completed(held_completions.pop())
            self.session.writes.flush(timeout=3.0)
            self.wait_until(
                lambda: self._same_path_list(self.session.pinned, [renamed_overview])
                and any(f["name"] == "Course Overview.md" for f in self.studio.files)
            )

            self.assertTrue(file_susp_event.is_set())
            self.assertEqual(self.studio._active_watch_suspensions(), [])
            renamed_tab = next((t for t in self.studio.tabs if t["id"] == overview_tab_id), None)
            self.assertIsNotNone(renamed_tab)
            assert renamed_tab is not None
            self.assertTrue(folder_ops.same_path(renamed_tab["path"], renamed_overview))
            self.assertEqual(renamed_tab["content"], "# Overview\n\nUnsaved overview revision")
            self.assertFalse(renamed_tab.get("conflict"))
            self.assertTrue(self._same_path_list(self.session.pinned, [renamed_overview]))
            self.assertTrue(self._contains_path(self.studio.recent, renamed_overview))
            self.assertFalse(self._contains_path(self.studio.recent, overview))
            self.assertTrue(any(folder_ops.same_path(k, renamed_overview) for k in self.session.locations))
            self.assertFalse(any(folder_ops.same_path(k, overview) for k in self.session.locations))
            self.assertFalse(any(folder_ops.same_path(k, overview) for k in self.studio.note_identities))
            self.assertTrue(any(folder_ops.same_path(k, renamed_overview) for k in self.studio.note_identities))
            watched_after_file = self.studio.note_watcher.files() + self.studio.note_watcher.directories()
            self.assertTrue(any(folder_ops.same_path(w_path, str(renamed_overview)) for w_path in watched_after_file))
            self.assertTrue(any(folder_ops.same_path(w_path, str(self.workspace)) for w_path in watched_after_file))

            startup_data = json.loads((self.studio.data / "startup.json").read_text(encoding="utf-8"))
            recovery_data = json.loads((self.studio.data / "recovery.json").read_text(encoding="utf-8"))
            self.assertTrue(any(folder_ops.same_path(p, renamed_overview) for p in startup_data["paths"]))
            self.assertFalse(any(folder_ops.same_path(p, overview) for p in startup_data["paths"]))
            self.assertEqual(len(recovery_data), 1)
            self.assertTrue(folder_ops.same_path(recovery_data[0]["path"], renamed_overview))
            self.assertEqual(recovery_data[0]["content"], "# Overview\n\nUnsaved overview revision")
            self.assertEqual(self.session.drafts.get("deleted-notes", []), [])

            # 2. Folder rename: verify parent-directory notifications & pre-queued reconcile do not clobber child note.
            completion_queued.clear()
            self.studio.openNote(str(week1))
            self.wait_until(lambda: folder_ops.same_path(self.studio._current()["path"], week1))
            week1_tab_id = self.studio.active
            self.studio.post(
                "dirty-week1",
                "document_changed",
                json.dumps({"id": week1_tab_id, "content": "# Week 1\n\nUnsaved seminar notes"}),
            )
            self.studio.post(
                "pos-week1",
                "reading_position",
                json.dumps({
                    "id": week1_tab_id,
                    "location": {"top": 7, "offset": 0.5, "zoom": 100, "mode": "live"},
                }),
            )
            self.studio.pinRecent(str(week1))
            self.studio._save_positions()
            self.studio._recover()
            self.session.writes.flush(timeout=3.0)
            self._settle_watchers()

            seminars = self.workspace / "Seminars"
            remapped_week1 = seminars / "Week 1.md"
            dir_reconcile_gate = threading.Event()
            dir_reconcile_done = threading.Event()

            def gated_dir_reconcile(known, changed):
                dir_reconcile_gate.wait(timeout=3.0)
                try:
                    return orig_reconcile(known, changed)
                finally:
                    dir_reconcile_done.set()

            with mock.patch.object(file_events, "reconcile", side_effect=gated_dir_reconcile):
                self.studio.external_paths = {str(coursework), str(self.workspace)}
                self.studio._refresh_external_notes()

                self.studio.renameEntry(str(coursework), "Seminars")
                self.session.writes.flush(timeout=3.0)
                self.wait_until(lambda: completion_queued.is_set())

                self.assertFalse(coursework.exists())
                self.assertTrue(remapped_week1.is_file())
                dir_susp = self.studio._active_watch_suspensions()
                self.assertEqual(len(dir_susp), 1)
                dir_susp_event = dir_susp[0][3]
                self.assertFalse(dir_susp_event.is_set())

                self.studio.note_watcher.directoryChanged.emit(str(self.workspace))
                self.studio.note_watcher.directoryChanged.emit(str(coursework))
                self.studio._external_note_changed(str(self.workspace))
                self.studio._external_note_changed(str(coursework))
                self.assertEqual(self.studio.external_paths, set())
                self.studio.external_paths = {str(self.workspace), str(coursework)}
                self.studio._refresh_external_notes()
                dir_reconcile_gate.set()
                self.assertTrue(dir_reconcile_done.wait(timeout=3.0))
                QTest.qWait(40)
                self.app.processEvents()

                self.assertTrue(any(t["id"] == week1_tab_id for t in self.studio.tabs))
                self.assertEqual(self.session.drafts.get("deleted-notes", []), [])

            self.assertEqual(len(held_completions), 1)
            orig_on_rename_completed(held_completions.pop())
            self.session.writes.flush(timeout=3.0)
            self.wait_until(
                lambda: self._same_path_list(self.session.pinned, [renamed_overview, remapped_week1])
                and any(f["name"] == "Seminars" for f in self.studio.files)
            )

            self.assertTrue(dir_susp_event.is_set())
            self.assertEqual(self.studio._active_watch_suspensions(), [])
            week1_tab = next((t for t in self.studio.tabs if t["id"] == week1_tab_id), None)
            self.assertIsNotNone(week1_tab)
            assert week1_tab is not None
            self.assertTrue(folder_ops.same_path(week1_tab["path"], remapped_week1))
            self.assertEqual(week1_tab["content"], "# Week 1\n\nUnsaved seminar notes")
            self.assertFalse(week1_tab.get("conflict"))
            self.assertTrue(any(folder_ops.same_path(k, remapped_week1) for k in self.session.locations))
            self.assertFalse(any(folder_ops.same_path(k, week1) for k in self.session.locations))
            self.assertFalse(any(folder_ops.same_path(k, week1) for k in self.studio.note_identities))
            self.assertTrue(any(folder_ops.same_path(k, remapped_week1) for k in self.studio.note_identities))

            startup_after_dir = json.loads((self.studio.data / "startup.json").read_text(encoding="utf-8"))
            recovery_after_dir = json.loads((self.studio.data / "recovery.json").read_text(encoding="utf-8"))
            self.assertTrue(any(folder_ops.same_path(p, remapped_week1) for p in startup_after_dir["paths"]))
            self.assertFalse(any(folder_ops.same_path(p, week1) for p in startup_after_dir["paths"]))
            recovery_by_id = {entry["id"]: entry for entry in recovery_after_dir}
            self.assertIn(week1_tab_id, recovery_by_id)
            self.assertTrue(folder_ops.same_path(recovery_by_id[week1_tab_id]["path"], remapped_week1))
            self.assertEqual(recovery_by_id[week1_tab_id]["content"], "# Week 1\n\nUnsaved seminar notes")
            self.assertEqual(self.session.drafts.get("deleted-notes", []), [])
        finally:
            try:
                self.session.renameCompleted.disconnect(defer_rename_completion)
            except (RuntimeError, TypeError):
                pass
            self.session.renameCompleted.connect(orig_on_rename_completed)

    def test_windows_rename_retry_keeps_watches_suspended_across_windows(self):
        overview = self.workspace / "Overview.md"
        coursework = self.workspace / "Coursework"
        self.studio.openFolder(str(self.workspace))
        self.studio.toggleDirectory(str(coursework))
        self.wait_until(lambda: any(f["name"] == "Week 1.md" for f in self.studio.files))
        self.studio.openNote(str(overview))
        self.wait_until(lambda: folder_ops.same_path(self.studio._current()["path"], overview))
        active_id = self.studio.active
        self.studio.pinRecent(str(overview))
        self._settle_watchers()

        second_studio = QuietStudio(True, self.session)
        try:
            second_studio.openFolder(str(self.workspace))
            self.wait_until(lambda: len(second_studio.files) >= 3)

            renamed_overview = self.workspace / "Course Overview.md"
            watched_across_windows: list[tuple[list[str], list[str]]] = []
            orig_rename = Path.rename
            attempts = 0
            attempt0_started = threading.Event()
            main_thread_emitted = threading.Event()

            def spy_multiwindow_rename(self_path, target):
                nonlocal attempts
                watched_across_windows.append((
                    list(self.studio.note_watcher.files() + self.studio.note_watcher.directories()),
                    list(second_studio.note_watcher.files() + second_studio.note_watcher.directories()),
                ))
                if attempts == 0:
                    attempts += 1
                    attempt0_started.set()
                    main_thread_emitted.wait(timeout=2.0)
                    err = PermissionError(13, "Sharing violation")
                    err.winerror = 32
                    raise err
                if attempts == 1:
                    attempts += 1
                    err = PermissionError(13, "Access denied")
                    err.winerror = 5
                    raise err
                return orig_rename(self_path, target)

            with (
                mock.patch.object(studio, "_is_windows", return_value=True),
                mock.patch.object(Path, "rename", spy_multiwindow_rename),
            ):
                self.studio.renameNote(active_id, "Course Overview.md")
                self.assertTrue(attempt0_started.wait(timeout=2.0))
                self.studio._emit(False)
                second_studio._emit(False)
                main_thread_emitted.set()
                self.wait_until(
                    lambda: renamed_overview.is_file()
                    and any(f["name"] == "Course Overview.md" for f in self.studio.files)
                    and any(f["name"] == "Course Overview.md" for f in second_studio.files)
                    and self._same_path_list(self.session.pinned, [renamed_overview])
                )
            self.assertEqual(len(watched_across_windows), 3)
            for first_watched, second_watched in watched_across_windows:
                for watched_path in first_watched + second_watched:
                    self.assertFalse(folder_ops.same_path(watched_path, str(overview)))
                    self.assertFalse(folder_ops.same_path(watched_path, str(self.workspace)))
        finally:
            self._retire_window(second_studio)

    def test_multi_window_initiating_window_retirement_hands_off_rename_to_surviving_window(self):
        reading = self.workspace / "Reading.md"
        renamed_reading = self.workspace / "Assigned Reading.md"

        self.studio.openFolder(str(self.workspace))
        self.wait_until(lambda: len(self.studio.files) == 3)
        self.studio.openNote(str(reading))
        self.wait_until(lambda: folder_ops.same_path(self.studio._current()["path"], reading))
        reading_tab_id = self.studio.active
        self.studio.post(
            "dirty-reading",
            "document_changed",
            json.dumps({"id": reading_tab_id, "content": "# Reading\n\nAnnotated chapter notes"}),
        )
        self.studio.pinRecent(str(reading))
        self._settle_watchers()

        initiator = QuietStudio(True, self.session)
        initiator.openFolder(str(self.workspace))
        self.wait_until(lambda: len(initiator.files) == 3)

        orig_rename = Path.rename
        worker_entered = threading.Event()
        allow_worker_finish = threading.Event()

        def gated_rename(self_path, target):
            worker_entered.set()
            allow_worker_finish.wait(timeout=3.0)
            return orig_rename(self_path, target)

        try:
            with mock.patch.object(Path, "rename", gated_rename):
                initiator.renameEntry(str(reading), "Assigned Reading")
                self.assertTrue(worker_entered.wait(timeout=3.0))
                active_susp = self.studio._active_watch_suspensions()
                self.assertEqual(len(active_susp), 1)
                multi_susp_event = active_susp[0][3]

                self._retire_window(initiator)
                self.assertFalse(multi_susp_event.is_set())

                allow_worker_finish.set()
                self.wait_until(
                    lambda: renamed_reading.is_file()
                    and multi_susp_event.is_set()
                    and self._same_path_list(self.session.pinned, [renamed_reading])
                    and any(f["name"] == "Assigned Reading.md" for f in self.studio.files)
                )
                self.session.writes.flush(timeout=3.0)

            self.assertEqual(self.studio._active_watch_suspensions(), [])
            self.assertEqual(self.session._pending_rename_cleanups, {})
            surviving_tab = next((t for t in self.studio.tabs if t["id"] == reading_tab_id), None)
            self.assertIsNotNone(surviving_tab)
            assert surviving_tab is not None
            self.assertTrue(folder_ops.same_path(surviving_tab["path"], renamed_reading))
            self.assertEqual(surviving_tab["content"], "# Reading\n\nAnnotated chapter notes")
            self.assertTrue(any(folder_ops.same_path(k, renamed_reading) for k in self.studio.note_identities))
            watched_survivor = self.studio.note_watcher.files() + self.studio.note_watcher.directories()
            self.assertTrue(any(folder_ops.same_path(w, str(renamed_reading)) for w in watched_survivor))
            self.assertTrue(any(folder_ops.same_path(w, str(self.workspace)) for w in watched_survivor))
            recovery_data = json.loads((self.studio.data / "recovery.json").read_text(encoding="utf-8"))
            self.assertEqual(len(recovery_data), 1)
            self.assertTrue(folder_ops.same_path(recovery_data[0]["path"], renamed_reading))
        finally:
            allow_worker_finish.set()
            if not initiator.retired:
                self._retire_window(initiator)

    def _run_isolated_shutdown_reopen_scenario(self, *, finish_before_stop: bool, rename_folder: bool = False):
        temp_root = Path(tempfile.mkdtemp(prefix="supermd-quit-reopen-")).resolve()
        try:
            state_dir = temp_root / "state"
            workspace_dir = temp_root / "workspace"
            state_dir.mkdir(parents=True, exist_ok=True)
            workspace_dir.mkdir(parents=True, exist_ok=True)
            workspace_canon = Path(folder_ops.canonical_path_str(workspace_dir))

            if rename_folder:
                old_dir = workspace_canon / "Drafts"
                old_dir.mkdir()
                old_note = old_dir / "Draft.md"
                new_dir = workspace_canon / "Published"
                new_note = new_dir / "Draft.md"
            else:
                old_dir = None
                old_note = workspace_canon / "Draft.md"
                new_dir = None
                new_note = workspace_canon / "Renamed.md"

            saved_text = "# Draft\n\nSaved baseline paragraph."
            unsaved_text = "# Draft\n\nUnsaved draft edits retained across normal quit."
            old_note.write_text(saved_text, encoding="utf-8")

            env = {
                **os.environ,
                "QT_QPA_PLATFORM": "offscreen",
                "QT_QUICK_BACKEND": "software",
                "SUPERMD_TEST_DESKTOP": str(DESKTOP),
                "SUPERMD_TEST_STATE_DIR": str(state_dir),
                "SUPERMD_TEST_WORKSPACE": str(workspace_canon),
                "SUPERMD_TEST_OLD_NOTE": str(old_note),
                "SUPERMD_TEST_OLD_DIR": str(old_dir) if old_dir else "",
                "SUPERMD_TEST_UNSAVED_TEXT": unsaved_text,
                "SUPERMD_TEST_FINISH_BEFORE_STOP": "1" if finish_before_stop else "0",
                "SUPERMD_TEST_RENAME_FOLDER": "1" if rename_folder else "0",
            }

            quit_script = textwrap.dedent(
                """
                import json, os, sys, threading, time
                from pathlib import Path
                from unittest import mock

                sys.path.insert(0, os.environ["SUPERMD_TEST_DESKTOP"])
                from PySide6.QtCore import QTimer
                from PySide6.QtWidgets import QApplication
                import folder_ops
                from studio import Session, Studio

                class QuietStudio(Studio):
                    def _choose_default_python(self, emit=True):
                        self.python_status = "No Python interpreter configured."

                app = QApplication([])
                session = Session(False, data=Path(os.environ["SUPERMD_TEST_STATE_DIR"]))
                app.aboutToQuit.connect(lambda: setattr(session, "quitting", True))
                st = QuietStudio(False, session)

                workspace = Path(os.environ["SUPERMD_TEST_WORKSPACE"])
                old_note = Path(os.environ["SUPERMD_TEST_OLD_NOTE"])
                old_dir = Path(os.environ["SUPERMD_TEST_OLD_DIR"]) if os.environ["SUPERMD_TEST_OLD_DIR"] else None
                unsaved_text = os.environ["SUPERMD_TEST_UNSAVED_TEXT"]
                finish_before_stop = os.environ["SUPERMD_TEST_FINISH_BEFORE_STOP"] == "1"
                rename_folder = os.environ["SUPERMD_TEST_RENAME_FOLDER"] == "1"

                st.openFolder(str(workspace))
                if rename_folder and old_dir is not None:
                    st.toggleDirectory(str(old_dir))
                st.openNote(str(old_note))

                worker_entered = threading.Event()
                allow_disk_rename = threading.Event()
                disk_renamed = threading.Event()
                orig_rename = Path.rename

                def gated_rename(self_path, target):
                    worker_entered.set()
                    allow_disk_rename.wait(timeout=5.0)
                    result = orig_rename(self_path, target)
                    disk_renamed.set()
                    return result

                patcher = mock.patch.object(Path, "rename", gated_rename)
                patcher.start()

                def poll_ready_and_rename():
                    if not folder_ops.same_path(st._current().get("path", ""), old_note):
                        QTimer.singleShot(15, poll_ready_and_rename)
                        return
                    if not st.files:
                        QTimer.singleShot(15, poll_ready_and_rename)
                        return
                    tab_id = st.active
                    st.pinRecent(str(old_note))
                    st.post(
                        "pos-quit",
                        "reading_position",
                        json.dumps({
                            "id": tab_id,
                            "location": {"top": 6, "offset": 0.42, "zoom": 110, "mode": "live"},
                        }),
                    )
                    st.post(
                        "dirty-quit",
                        "document_changed",
                        json.dumps({"id": tab_id, "content": unsaved_text}),
                    )
                    if rename_folder and old_dir is not None:
                        st.renameEntry(str(old_dir), "Published")
                    else:
                        st.renameNote(tab_id, "Renamed.md")

                    def wait_worker_then_quit():
                        if not worker_entered.is_set():
                            QTimer.singleShot(10, wait_worker_then_quit)
                            return
                        app.quit()

                    QTimer.singleShot(5, wait_worker_then_quit)

                QTimer.singleShot(0, poll_ready_and_rename)
                status = app.exec()

                # Normal quit left app.exec(); no Qt event loop will service queued signals after this point.
                assert old_note.is_file(), "Expected old path to exist when app.exec() exited"

                if finish_before_stop:
                    # Worker finishes after app.exec() exits, before Studio.stop() runs;
                    # Session.renameCompleted sits unserviced in Qt's event queue.
                    allow_disk_rename.set()
                    assert disk_renamed.wait(timeout=3.0), "Expected disk rename to finish before stop()"
                    time.sleep(0.02)
                    st.stop()
                    st.pool.shutdown(wait=False, cancel_futures=True)
                    st._search_pool.shutdown(wait=False, cancel_futures=True)
                    session.writes.shutdown(wait=True)
                else:
                    # Exact main.py shutdown order: Studio.stop() runs first while worker is still blocked,
                    # then the worker completes the real filesystem rename during session.writes.shutdown(wait=True).
                    st.stop()
                    assert old_note.is_file(), "Expected rename to still be in flight after Studio.stop()"

                    def release_during_writer_drain():
                        deadline = time.monotonic() + 2.0
                        while time.monotonic() < deadline and not getattr(session.writes, "_shutdown", False):
                            time.sleep(0.005)
                        allow_disk_rename.set()

                    releaser = threading.Thread(target=release_during_writer_drain, daemon=True)
                    releaser.start()
                    st.pool.shutdown(wait=False, cancel_futures=True)
                    st._search_pool.shutdown(wait=False, cancel_futures=True)
                    session.writes.shutdown(wait=True)
                    releaser.join(timeout=2.0)
                    assert disk_renamed.is_set(), "Expected disk rename to complete during writer shutdown drain"

                patcher.stop()
                sys.exit(status)
                """
            )

            proc1 = subprocess.run(
                [sys.executable, "-c", quit_script],
                env=env,
                capture_output=True,
                text=True,
                timeout=30,
            )
            self.assertEqual(
                proc1.returncode,
                0,
                f"Quit subprocess failed:\nSTDOUT:\n{proc1.stdout}\nSTDERR:\n{proc1.stderr}",
            )

            # 1. Filesystem contains only the renamed item, with saved baseline on disk.
            self.assertFalse(old_note.exists())
            if old_dir is not None:
                self.assertFalse(old_dir.exists())
            self.assertTrue(new_note.is_file())
            self.assertEqual(new_note.read_text(encoding="utf-8"), saved_text)

            # 2. All four persisted JSON files refer to new_note / new_dir, never old_note / old_dir.
            startup_json = json.loads((state_dir / "startup.json").read_text(encoding="utf-8"))
            settings_json = json.loads((state_dir / "settings.json").read_text(encoding="utf-8"))
            positions_json = json.loads((state_dir / "reading-positions.json").read_text(encoding="utf-8"))
            recovery_json = json.loads((state_dir / "recovery.json").read_text(encoding="utf-8"))

            self.assertTrue(self._same_path_list(startup_json["paths"], [new_note]))
            self.assertFalse(self._contains_path(startup_json["paths"], old_note))
            self.assertTrue(folder_ops.same_path(startup_json["active"], new_note))
            self.assertEqual(len(startup_json["tabs"]), 1)
            self.assertTrue(folder_ops.same_path(startup_json["tabs"][0]["path"], new_note))
            self.assertEqual(len(startup_json["windows"]), 1)
            self.assertTrue(folder_ops.same_path(startup_json["windows"][0]["active"], new_note))
            self.assertTrue(folder_ops.same_path(startup_json["windows"][0]["tabs"][0]["path"], new_note))
            if new_dir is not None and old_dir is not None:
                self.assertTrue(self._contains_path(startup_json["expanded"], new_dir))
                self.assertFalse(self._contains_path(startup_json["expanded"], old_dir))

            self.assertTrue(self._same_path_list(settings_json["pinned"], [new_note]))
            self.assertTrue(self._contains_path(settings_json["recent"], new_note))
            self.assertFalse(self._contains_path(settings_json["recent"], old_note))

            matched_pos_keys = [k for k in positions_json if folder_ops.same_path(k, new_note)]
            self.assertEqual(len(matched_pos_keys), 1)
            self.assertFalse(any(folder_ops.same_path(k, old_note) for k in positions_json))
            self.assertEqual(
                positions_json[matched_pos_keys[0]],
                {"top": 6, "offset": 0.42, "zoom": 110, "mode": "live"},
            )

            self.assertEqual(len(recovery_json), 1)
            self.assertTrue(folder_ops.same_path(recovery_json[0]["path"], new_note))
            self.assertEqual(recovery_json[0]["name"], new_note.name)
            self.assertEqual(recovery_json[0]["content"], unsaved_text)
            self.assertEqual(recovery_json[0]["saved"], saved_text)

            # 3. Fresh process loads the same state files and restores renamed note, pin, reading position, and draft.
            reopen_script = textwrap.dedent(
                """
                import json, os, sys
                from pathlib import Path

                sys.path.insert(0, os.environ["SUPERMD_TEST_DESKTOP"])
                from PySide6.QtCore import QTimer
                from PySide6.QtWidgets import QApplication
                from studio import Session, Studio

                class QuietStudio(Studio):
                    def _choose_default_python(self, emit=True):
                        self.python_status = "No Python interpreter configured."

                app = QApplication([])
                session = Session(False, data=Path(os.environ["SUPERMD_TEST_STATE_DIR"]))
                loads = []
                st = QuietStudio(False, session)
                st.readerLoad.connect(lambda payload: loads.append(json.loads(payload)))

                attempts = 0
                def check_restored():
                    global attempts
                    attempts += 1
                    if st._restoring_paths and attempts < 60:
                        QTimer.singleShot(15, check_restored)
                        return
                    st.ready = True
                    st._emit(True)
                    current = st._current()
                    report = {
                        "tabs": [
                            {
                                "id": t["id"],
                                "name": t["name"],
                                "path": t["path"],
                                "content": t["content"],
                                "saved": t["saved"],
                                "dirty": st._is_dirty(t),
                                "conflict": bool(t.get("conflict")),
                            }
                            for t in st.tabs
                        ],
                        "activePath": current.get("path", ""),
                        "activeName": current.get("name", ""),
                        "pinned": list(session.pinned),
                        "recent": list(st.recent),
                        "locations": dict(session.locations),
                        "expanded": sorted(st.expanded),
                        "lastReaderLoad": loads[-1] if loads else None,
                    }
                    print("REOPEN_REPORT:" + json.dumps(report))
                    st.stop()
                    st.pool.shutdown(wait=False, cancel_futures=True)
                    st._search_pool.shutdown(wait=False, cancel_futures=True)
                    session.writes.shutdown(wait=True)
                    app.quit()

                QTimer.singleShot(30, check_restored)
                sys.exit(app.exec())
                """
            )

            proc2 = subprocess.run(
                [sys.executable, "-c", reopen_script],
                env=env,
                capture_output=True,
                text=True,
                timeout=30,
            )
            self.assertEqual(
                proc2.returncode,
                0,
                f"Reopen subprocess failed:\nSTDOUT:\n{proc2.stdout}\nSTDERR:\n{proc2.stderr}",
            )
            report_line = next(
                (line for line in proc2.stdout.splitlines() if line.startswith("REOPEN_REPORT:")),
                None,
            )
            self.assertIsNotNone(report_line, f"Missing REOPEN_REPORT in stdout:\n{proc2.stdout}")
            assert report_line is not None
            report = json.loads(report_line.removeprefix("REOPEN_REPORT:"))

            self.assertTrue(folder_ops.same_path(report["activePath"], new_note))
            self.assertEqual(report["activeName"], new_note.name)
            self.assertEqual(len(report["tabs"]), 1)
            self.assertTrue(folder_ops.same_path(report["tabs"][0]["path"], new_note))
            self.assertEqual(report["tabs"][0]["name"], new_note.name)
            self.assertEqual(report["tabs"][0]["content"], unsaved_text)
            self.assertEqual(report["tabs"][0]["saved"], saved_text)
            self.assertTrue(report["tabs"][0]["dirty"])
            self.assertFalse(report["tabs"][0]["conflict"])
            self.assertTrue(self._same_path_list(report["pinned"], [new_note]))
            self.assertTrue(self._contains_path(report["recent"], new_note))
            self.assertFalse(self._contains_path(report["recent"], old_note))
            reopen_pos_keys = [k for k in report["locations"] if folder_ops.same_path(k, new_note)]
            self.assertEqual(len(reopen_pos_keys), 1)
            self.assertEqual(
                report["locations"][reopen_pos_keys[0]],
                {"top": 6, "offset": 0.42, "zoom": 110, "mode": "live"},
            )
            self.assertIsNotNone(report["lastReaderLoad"])
            self.assertEqual(
                report["lastReaderLoad"]["readingLocation"],
                {"top": 6, "offset": 0.42, "zoom": 110, "mode": "live"},
            )
            self.assertEqual(report["lastReaderLoad"]["content"], unsaved_text)
            if new_dir is not None and old_dir is not None:
                self.assertTrue(self._contains_path(report["expanded"], new_dir))
                self.assertFalse(self._contains_path(report["expanded"], old_dir))
        finally:
            shutil.rmtree(temp_root, ignore_errors=True)

    def test_rename_refreshes_note_stamps_invalidates_workspace_links_and_reuses_open_tab(self):
        overview = self.workspace / "Overview.md"
        reading = self.workspace / "Reading.md"
        coursework = self.workspace / "Coursework"
        week1 = coursework / "Week 1.md"

        self.studio.openFolder(str(self.workspace))
        self.studio.toggleDirectory(str(coursework))
        self.wait_until(lambda: any(f["name"] == "Week 1.md" for f in self.studio.files))

        self.studio.openNote(str(overview))
        self.wait_until(lambda: folder_ops.same_path(self.studio._current()["path"], overview))
        overview_tab_id = self.studio.active
        st_overview = overview.stat()
        self.studio.note_file_stamps[str(overview)] = (st_overview.st_mtime_ns, st_overview.st_size)

        self.studio.post(
            "dirty-overview-link",
            "document_changed",
            json.dumps({"id": overview_tab_id, "content": "# Overview\n\nUnsaved draft preserved across link reuse"}),
        )

        self.studio.openNote(str(reading))
        self.wait_until(lambda: folder_ops.same_path(self.studio._current()["path"], reading))
        reading_tab_id = self.studio.active

        # Prime workspace_links cache before rename.
        resolved_before = resolve_workspace_link(
            "Overview",
            wikilink=True,
            note_path=str(reading),
            workspace_folder=str(self.workspace),
            cache=self.session.workspace_links,
        )
        self.assertTrue(folder_ops.same_path(resolved_before, overview))

        # Rename Overview.md -> Course Overview.md while Reading.md is active.
        renamed_overview = self.workspace / "Course Overview.md"
        self.studio.renameNote(overview_tab_id, "Course Overview.md")
        self.session.writes.flush(timeout=3.0)
        self.wait_until(
            lambda: renamed_overview.is_file()
            and any(f["name"] == "Course Overview.md" for f in self.studio.files)
        )

        # #105: note_file_stamps evicted old key and recorded refreshed stat for renamed path.
        self.assertFalse(any(folder_ops.same_path(k, overview) for k in self.studio.note_file_stamps))
        matched_stamps = [v for k, v in self.studio.note_file_stamps.items() if folder_ops.same_path(k, renamed_overview)]
        self.assertEqual(len(matched_stamps), 1)
        st_renamed = renamed_overview.stat()
        self.assertEqual(matched_stamps[0], (st_renamed.st_mtime_ns, st_renamed.st_size))

        # #64: workspace_links cache invalidated; [[Course Overview]] resolves and reuses existing dirty open tab.
        replies: list[tuple[str, str, str]] = []
        self.studio.replied.connect(lambda req_id, payload, err: replies.append((req_id, payload, err)))
        tab_count_before = len(self.studio.tabs)
        self.studio.post(
            "open-renamed-wikilink",
            "open_workspace_link",
            json.dumps({
                "id": reading_tab_id,
                "target": "Course Overview",
                "wikilink": True,
                "fragment": "",
            }),
        )
        self.wait_until(lambda: any(r[0] == "open-renamed-wikilink" for r in replies))
        _, raw_payload, err = next(r for r in replies if r[0] == "open-renamed-wikilink")
        self.assertEqual(err, "")
        parsed = json.loads(raw_payload)
        self.assertTrue(parsed["opened"])
        self.assertEqual(parsed["id"], overview_tab_id)
        self.assertEqual(len(self.studio.tabs), tab_count_before)
        self.assertEqual(self.studio.active, overview_tab_id)
        self.assertEqual(self.studio._current()["content"], "# Overview\n\nUnsaved draft preserved across link reuse")

        # Also verify folder rename updates child note_file_stamps and invalidates workspace_links.
        self.studio.openNote(str(week1))
        self.wait_until(lambda: folder_ops.same_path(self.studio._current()["path"], week1))
        week1_tab_id = self.studio.active
        st_week1 = week1.stat()
        self.studio.note_file_stamps[str(week1)] = (st_week1.st_mtime_ns, st_week1.st_size)
        resolved_week1_before = resolve_workspace_link(
            "Coursework/Week 1",
            wikilink=True,
            note_path=str(reading),
            workspace_folder=str(self.workspace),
            cache=self.session.workspace_links,
        )
        self.assertTrue(folder_ops.same_path(resolved_week1_before, week1))

        seminars = self.workspace / "Seminars"
        remapped_week1 = seminars / "Week 1.md"
        self.studio.renameEntry(str(coursework), "Seminars")
        self.session.writes.flush(timeout=3.0)
        self.wait_until(
            lambda: remapped_week1.is_file()
            and any(f["name"] == "Seminars" for f in self.studio.files)
        )
        self.assertFalse(any(folder_ops.same_path(k, week1) for k in self.studio.note_file_stamps))
        matched_week1_stamps = [v for k, v in self.studio.note_file_stamps.items() if folder_ops.same_path(k, remapped_week1)]
        self.assertEqual(len(matched_week1_stamps), 1)
        resolved_week1_after = resolve_workspace_link(
            "Seminars/Week 1",
            wikilink=True,
            note_path=str(reading),
            workspace_folder=str(self.workspace),
            cache=self.session.workspace_links,
        )
        self.assertTrue(folder_ops.same_path(resolved_week1_after, remapped_week1))
        self.assertEqual(week1_tab_id, self.studio.active)

    def test_final_window_shutdown_writer_drain_persists_renamed_note_for_reopen(self):
        self._run_isolated_shutdown_reopen_scenario(finish_before_stop=False, rename_folder=False)

    def test_final_window_shutdown_unserviced_signal_and_folder_rename_persist_for_reopen(self):
        self._run_isolated_shutdown_reopen_scenario(finish_before_stop=True, rename_folder=False)
        self._run_isolated_shutdown_reopen_scenario(finish_before_stop=False, rename_folder=True)


if __name__ == "__main__":
    unittest.main()
