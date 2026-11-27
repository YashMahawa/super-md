"""Isolated multi-window and per-tab Python cell process cleanup tests."""
from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path, PureWindowsPath
from unittest.mock import patch

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
from PySide6.QtCore import QTimer
from PySide6.QtGui import QGuiApplication

import offline_view
import python_runtime
from studio import Session
from test_python_runtime import _best_effort_kill, _pid_alive, _read_nonempty, _wait_pid_exit, _warm_interpreter_once
from test_studio import QuietStudio


class PythonCellIsolationTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.app = QGuiApplication.instance() or QGuiApplication(["Python cell isolation tests"])
        _warm_interpreter_once()

    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(
            prefix="supermd-cell-isolation-", ignore_cleanup_errors=True
        )
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name).resolve()
        self.session = Session(True, self.root / "session")
        self.session.settings["python"] = sys.executable
        self.windows: list[QuietStudio] = []

    def tearDown(self):
        for window in reversed(self.windows):
            window.stop()
            window.pool.shutdown(wait=True, cancel_futures=True)
            window._search_pool.shutdown(wait=True, cancel_futures=True)
            if window._python_pool is not None:
                window._python_pool.shutdown(wait=True, cancel_futures=True)
        self.session.writes.shutdown(wait=True)
        self.app.processEvents()

    def _new_window(self) -> tuple[QuietStudio, list[tuple[str, str, str]]]:
        studio = QuietStudio(True, self.session)
        studio.settings["python"] = sys.executable
        replies: list[tuple[str, str, str]] = []
        studio.replied.connect(lambda req_id, raw, err: replies.append((req_id, raw, err)))
        self.windows.append(studio)
        return studio, replies

    def _await_file(self, path: Path, timeout: float = 25.0) -> str:
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            self.app.processEvents()
            text = _read_nonempty(path)
            if text:
                return text
            time.sleep(0.01)
        self.fail(f"Timed out waiting for marker file {path}")

    def _await_reply(
        self, replies: list[tuple[str, str, str]], req_id: str, timeout: float = 25.0
    ) -> tuple[str, str, str]:
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            self.app.processEvents()
            matches = [entry for entry in replies if entry[0] == req_id]
            if matches:
                return matches[-1]
            time.sleep(0.01)
        self.fail(f"Timed out waiting for reply {req_id!r}")

    def test_retiring_one_window_cleans_up_its_cell_tree_while_another_windows_execution_keeps_running(self):
        window1, _ = self._new_window()
        window2, replies2 = self._new_window()

        w1_child_pid_file = self.root / "w1-child.pid"
        w1_grandchild_pid_file = self.root / "w1-grandchild.pid"
        w1_ready = self.root / "w1-ready.txt"
        w2_child_pid_file = self.root / "w2-child.pid"
        w2_ready = self.root / "w2-ready.txt"
        w2_release = self.root / "w2-release.txt"

        w1_code = f"""
import pathlib, subprocess, sys
inner = (
    "import pathlib, subprocess, sys\\n"
    "gc = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(30)'])\\n"
    "pathlib.Path(sys.argv[1]).write_text(str(gc.pid), encoding='utf-8')\\n"
    "pathlib.Path(sys.argv[2]).write_text('1', encoding='utf-8')\\n"
    "gc.wait()\\n"
)
child = subprocess.Popen([
    sys.executable,
    "-c",
    inner,
    {str(w1_grandchild_pid_file)!r},
    {str(w1_ready)!r},
])
pathlib.Path({str(w1_child_pid_file)!r}).write_text(str(child.pid), encoding="utf-8")
child.wait()
"""
        w2_code = f"""
import pathlib, subprocess, sys
helper_script = (
    "import pathlib, sys, time\\n"
    "release = pathlib.Path(sys.argv[1])\\n"
    "deadline = time.monotonic() + 30\\n"
    "while not release.exists() and time.monotonic() < deadline:\\n"
    "    time.sleep(0.02)\\n"
)
helper = subprocess.Popen([sys.executable, "-c", helper_script, {str(w2_release)!r}])
pathlib.Path({str(w2_child_pid_file)!r}).write_text(str(helper.pid), encoding="utf-8")
pathlib.Path({str(w2_ready)!r}).write_text("1", encoding="utf-8")
helper.wait()
print("window 2 completed cleanly")
"""
        tab1 = window1._current()
        tab2 = window2._current()
        ctx1 = {"document": tab1["id"], "cell": "0", "interpreter": sys.executable}
        ctx2 = {"document": tab2["id"], "cell": "0", "interpreter": sys.executable}

        window1.post("w1-run", "run_python", json.dumps({"code": w1_code, "context": ctx1}))
        window2.post("w2-run", "run_python", json.dumps({"code": w2_code, "context": ctx2}))

        self._await_file(w1_ready)
        self._await_file(w2_ready)
        w1_child_pid = int(self._await_file(w1_child_pid_file))
        w1_grandchild_pid = int(self._await_file(w1_grandchild_pid_file))
        w2_child_pid = int(self._await_file(w2_child_pid_file))
        for pid in (w1_child_pid, w1_grandchild_pid, w2_child_pid):
            self.addCleanup(_best_effort_kill, pid)

        self.assertTrue(_pid_alive(w1_child_pid))
        self.assertTrue(_pid_alive(w1_grandchild_pid))
        self.assertTrue(_pid_alive(w2_child_pid))

        # Retire window 1: stop() must return promptly on the Qt thread while its worker reaps the cell tree.
        stop_started = time.monotonic()
        window1.stop()
        self.assertLess(time.monotonic() - stop_started, 1.0)
        self.assertTrue(_wait_pid_exit(w1_child_pid, timeout=6.0))
        self.assertTrue(_wait_pid_exit(w1_grandchild_pid, timeout=6.0))
        self.assertTrue(_pid_alive(w2_child_pid), "another window's child process must keep running")
        self.assertEqual(window2.busy, 0)
        self.assertEqual(window2._python_jobs.active_count(), 1)

        w2_release.write_text("done", encoding="utf-8")
        _, raw2, err2 = self._await_reply(replies2, "w2-run")
        self.assertEqual(err2, "")
        payload2 = json.loads(raw2)
        self.assertTrue(payload2["ok"])
        self.assertEqual(payload2["stdout"], "window 2 completed cleanly\n")
        self.assertTrue(payload2["provenance"]["verified"])
        self.assertEqual(window2.busy, 0)

    def test_closing_one_tab_cleans_up_only_that_tabs_cell_while_sibling_tab_and_other_window_keep_running(self):
        window1, replies1 = self._new_window()
        window2, replies2 = self._new_window()

        # Give window1 two saved/clean tabs with content so _remove_tab exercises async closed-note preservation too.
        note_a = self.root / "note-a.md"
        note_b = self.root / "note-b.md"
        note_c = self.root / "note-c.md"
        note_a.write_text("```python\nprint('a')\n```\n", encoding="utf-8")
        note_b.write_text("```python\nprint('b')\n```\n", encoding="utf-8")
        note_c.write_text("```python\nprint('c')\n```\n", encoding="utf-8")

        tab_a = window1._note("note-a.md", note_a.read_text(), str(note_a), note_a.read_text())
        tab_b = window1._note("note-b.md", note_b.read_text(), str(note_b), note_b.read_text())
        window1.tabs = [tab_a, tab_b]
        window1.active = tab_a["id"]

        tab_c = window2._note("note-c.md", note_c.read_text(), str(note_c), note_c.read_text())
        window2.tabs = [tab_c]
        window2.active = tab_c["id"]

        a_pid_file = self.root / "tab-a.pid"
        b_pid_file = self.root / "tab-b.pid"
        c_pid_file = self.root / "tab-c.pid"
        release_bc = self.root / "release-bc.txt"

        code_a = f"""
import pathlib, subprocess, sys
child = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(30)"])
pathlib.Path({str(a_pid_file)!r}).write_text(str(child.pid), encoding="utf-8")
child.wait()
"""
        code_b = f"""
import pathlib, subprocess, sys
wait_script = (
    "import pathlib, sys, time\\n"
    "release = pathlib.Path(sys.argv[1])\\n"
    "deadline = time.monotonic() + 30\\n"
    "while not release.exists() and time.monotonic() < deadline:\\n"
    "    time.sleep(0.02)\\n"
)
child = subprocess.Popen([sys.executable, "-c", wait_script, {str(release_bc)!r}])
pathlib.Path({str(b_pid_file)!r}).write_text(str(child.pid), encoding="utf-8")
child.wait()
print("tab b result")
"""
        code_c = f"""
import pathlib, subprocess, sys
wait_script = (
    "import pathlib, sys, time\\n"
    "release = pathlib.Path(sys.argv[1])\\n"
    "deadline = time.monotonic() + 30\\n"
    "while not release.exists() and time.monotonic() < deadline:\\n"
    "    time.sleep(0.02)\\n"
)
child = subprocess.Popen([sys.executable, "-c", wait_script, {str(release_bc)!r}])
pathlib.Path({str(c_pid_file)!r}).write_text(str(child.pid), encoding="utf-8")
child.wait()
print("window 2 tab c result")
"""
        ctx_a = {"document": str(note_a), "cell": "0", "interpreter": sys.executable}
        ctx_b = {"document": str(note_b), "cell": "0", "interpreter": sys.executable}
        ctx_c = {"document": str(note_c), "cell": "0", "interpreter": sys.executable}

        window1.post("run-a", "run_python", json.dumps({"id": tab_a["id"], "code": code_a, "context": ctx_a}))
        window1.post("run-b", "run_python", json.dumps({"id": tab_b["id"], "code": code_b, "context": ctx_b}))
        window2.post("run-c", "run_python", json.dumps({"id": tab_c["id"], "code": code_c, "context": ctx_c}))

        pid_a = int(self._await_file(a_pid_file))
        pid_b = int(self._await_file(b_pid_file))
        pid_c = int(self._await_file(c_pid_file))
        for pid in (pid_a, pid_b, pid_c):
            self.addCleanup(_best_effort_kill, pid)

        window1.message = "Keep existing status"
        window1.closeTab(tab_a["id"])

        # Even before Qt event pumping finishes closed-note snapshot I/O, tab A's worker reaps its child.
        self.assertTrue(_wait_pid_exit(pid_a, timeout=6.0))
        self.assertTrue(_pid_alive(pid_b), "sibling tab's execution must keep running")
        self.assertTrue(_pid_alive(pid_c), "other window's execution must keep running")

        _, raw_a, err_a = self._await_reply(replies1, "run-a")
        self.assertEqual(raw_a, "null")
        self.assertEqual(err_a, "Python cell cancelled")
        self.assertEqual(window1.message, "Keep existing status")
        self.assertIsNone(self.session.python_outputs.load(code_a, ctx_a))

        release_bc.write_text("release", encoding="utf-8")
        _, raw_b, err_b = self._await_reply(replies1, "run-b")
        _, raw_c, err_c = self._await_reply(replies2, "run-c")
        self.assertEqual(err_b, "")
        self.assertEqual(err_c, "")
        self.assertEqual(json.loads(raw_b)["stdout"], "tab b result\n")
        self.assertEqual(json.loads(raw_c)["stdout"], "window 2 tab c result\n")
        self.assertEqual(window1.busy, 0)
        self.assertEqual(window2.busy, 0)

    def test_closing_tab_and_other_window_stay_responsive_while_child_cleanup_drains(self):
        window1, replies1 = self._new_window()
        window2, replies2 = self._new_window()

        note_a = self.root / "draining-a.md"
        note_b = self.root / "sibling-b.md"
        note_c = self.root / "win2-c.md"
        note_a.write_text("# Draining Tab A\n", encoding="utf-8")
        note_b.write_text("# Sibling Tab B\n", encoding="utf-8")
        note_c.write_text("# Window 2 Tab C\n", encoding="utf-8")

        tab_a = window1._note("draining-a.md", note_a.read_text(), str(note_a), note_a.read_text())
        tab_b = window1._note("sibling-b.md", note_b.read_text(), str(note_b), note_b.read_text())
        window1.tabs = [tab_a, tab_b]
        window1.active = tab_a["id"]

        tab_c = window2._note("win2-c.md", note_c.read_text(), str(note_c), note_c.read_text())
        window2.tabs = [tab_c]
        window2.active = tab_c["id"]

        pid_a1_file = self.root / "drain-a1.pid"
        pid_a2_file = self.root / "drain-a2.pid"
        child_snippet = (
            "import signal, time\n"
            "try:\n"
            "    signal.signal(signal.SIGTERM, signal.SIG_IGN)\n"
            "except Exception:\n"
            "    pass\n"
            "time.sleep(30)\n"
        )
        code_a1 = (
            "import pathlib, subprocess, sys\n"
            f"child = subprocess.Popen([sys.executable, '-c', {child_snippet!r}])\n"
            f"pathlib.Path({str(pid_a1_file)!r}).write_text(str(child.pid), encoding='utf-8')\n"
            "child.wait()\n"
        )
        code_a2 = (
            "import pathlib, subprocess, sys\n"
            f"child = subprocess.Popen([sys.executable, '-c', {child_snippet!r}])\n"
            f"pathlib.Path({str(pid_a2_file)!r}).write_text(str(child.pid), encoding='utf-8')\n"
            "child.wait()\n"
        )

        qt_tid = threading.get_ident()
        terminate_tids: list[int] = []
        both_draining = threading.Barrier(3)
        allow_drain_finish = threading.Event()
        drain_finished_count = 0
        drain_lock = threading.Lock()
        orig_terminate = python_runtime._CellProcessController.terminate

        def slow_draining_terminate(controller):
            nonlocal drain_finished_count
            terminate_tids.append(threading.get_ident())
            try:
                both_draining.wait(timeout=25)
            except threading.BrokenBarrierError:
                pass
            allow_drain_finish.wait(timeout=30)
            try:
                return orig_terminate(controller)
            finally:
                with drain_lock:
                    drain_finished_count += 1

        with patch.object(python_runtime._CellProcessController, "terminate", slow_draining_terminate):
            window1.post("drain-1", "run_python", json.dumps({"id": tab_a["id"], "code": code_a1}))
            window1.post("drain-2", "run_python", json.dumps({"id": tab_a["id"], "code": code_a2}))

            pid_a1 = int(self._await_file(pid_a1_file))
            pid_a2 = int(self._await_file(pid_a2_file))
            self.addCleanup(_best_effort_kill, pid_a1)
            self.addCleanup(_best_effort_kill, pid_a2)

            # Close tab_a on the Qt thread: must mark cancellation and return promptly without waiting on cleanup.
            close_started = time.monotonic()
            window1.closeTab(tab_a["id"])
            close_elapsed = time.monotonic() - close_started
            self.assertLess(close_elapsed, 1.0, "closeTab blocked the Qt thread on child cleanup")
            self.assertNotIn(qt_tid, terminate_tids)

            # Wait until both owned worker threads are actively inside child cleanup draining.
            both_draining.wait(timeout=25)
            self.assertNotIn(qt_tid, terminate_tids)
            self.assertTrue(_pid_alive(pid_a1))
            self.assertTrue(_pid_alive(pid_a2))

            # While child cleanup is still draining in window1, tab_a finishes closing (including async closed-note save).
            tab_close_deadline = time.monotonic() + 8.0
            while any(t["id"] == tab_a["id"] for t in window1.tabs) and time.monotonic() < tab_close_deadline:
                self.app.processEvents()
                time.sleep(0.01)
            self.assertEqual([t["id"] for t in window1.tabs], [tab_b["id"]])
            self.assertEqual(len(window1.closed_tabs), 1)
            with drain_lock:
                self.assertEqual(drain_finished_count, 0, "tab close must complete before child cleanup finishes draining")

            # Meanwhile, window2 remains responsive on both the shared Qt event loop and its own Python cell worker pool.
            qt_pong = False

            def mark_pong():
                nonlocal qt_pong
                qt_pong = True

            pong_started = time.monotonic()
            QTimer.singleShot(0, mark_pong)
            while not qt_pong and time.monotonic() - pong_started < 2.0:
                self.app.processEvents()
                time.sleep(0.005)
            self.assertTrue(qt_pong, "Qt event loop stalled while child cleanup was draining")
            self.assertLess(time.monotonic() - pong_started, 1.0)

            window2.newNote()
            self.assertEqual(len(window2.tabs), 2)
            window2.selectTab(tab_c["id"])
            self.assertEqual(json.loads(window2.snapshot)["active"], tab_c["id"])

            ctx_c = {"document": str(note_c), "cell": "0", "interpreter": sys.executable}
            window2.post(
                "w2-while-draining",
                "run_python",
                json.dumps({"id": tab_c["id"], "code": "print('window 2 responsive')", "context": ctx_c}),
            )
            _, raw_w2, err_w2 = self._await_reply(replies2, "w2-while-draining")
            self.assertEqual(err_w2, "")
            payload_w2 = json.loads(raw_w2)
            self.assertTrue(payload_w2["ok"])
            self.assertEqual(payload_w2["stdout"], "window 2 responsive\n")
            self.assertTrue(payload_w2["provenance"]["verified"])

            # Confirm window1's child cleanup is STILL draining at this point, then let it finish and verify cleanup.
            with drain_lock:
                self.assertEqual(drain_finished_count, 0)
            self.assertTrue(_pid_alive(pid_a1))
            self.assertTrue(_pid_alive(pid_a2))

            allow_drain_finish.set()
            self.assertTrue(_wait_pid_exit(pid_a1, timeout=6.0))
            self.assertTrue(_wait_pid_exit(pid_a2, timeout=6.0))
            self.assertEqual(self._await_reply(replies1, "drain-1")[1:], ("null", "Python cell cancelled"))
            self.assertEqual(self._await_reply(replies1, "drain-2")[1:], ("null", "Python cell cancelled"))
            self.assertEqual(window1.busy, 0)
            self.assertEqual(window2.busy, 0)

    def test_dirty_tab_close_prompt_cancel_keeps_cell_running_until_discard_confirmed(self):
        window1, replies1 = self._new_window()
        dirty = window1._note("Dirty.md", "unsaved code", "", "")
        other = window1._note("Other.md", "", "", "")
        window1.tabs = [dirty, other]
        window1.active = dirty["id"]

        pid_file = self.root / "dirty-cell.pid"
        code = f"""
import pathlib, subprocess, sys
child = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(30)"])
pathlib.Path({str(pid_file)!r}).write_text(str(child.pid), encoding="utf-8")
child.wait()
"""
        window1.post("dirty-run", "run_python", json.dumps({"id": dirty["id"], "code": code}))
        child_pid = int(self._await_file(pid_file))
        self.addCleanup(_best_effort_kill, child_pid)

        # Prompting on a dirty tab and clicking Cancel must NOT stop the running cell.
        window1.closeTab(dirty["id"])
        self.assertEqual(window1.pending_close, dirty["id"])
        window1.resolveClose("cancel")
        self.assertEqual(window1.pending_close, "")
        self.assertTrue(_pid_alive(child_pid))

        # Confirming Discard removes the tab and terminates its cell tree.
        window1.closeTab(dirty["id"])
        window1.resolveClose("discard")
        self.assertTrue(_wait_pid_exit(child_pid, timeout=6.0))
        _, raw, err = self._await_reply(replies1, "dirty-run")
        self.assertEqual((raw, err), ("null", "Python cell cancelled"))
        self.assertEqual(window1.busy, 0)

    def test_studio_run_python_descendant_retaining_streams_preserves_verified_result_and_clears_busy(self):
        window1, replies1 = self._new_window()
        tab = window1._current()
        pid_file = self.root / "stream-holder.pid"
        done_file = self.root / "stream-cell-done.txt"
        code = f"""
import pathlib, subprocess, sys, time
holder = subprocess.Popen(
    [
        sys.executable,
        "-c",
        "import sys, time; "
        "sys.stdout and (sys.stdout.write('keep-open\\\\n'), sys.stdout.flush()); "
        "sys.stderr and (sys.stderr.write('keep-err\\\\n'), sys.stderr.flush()); "
        "time.sleep(30)",
    ],
    stdout=sys.__stdout__,
    stderr=sys.__stderr__,
)
pathlib.Path({str(pid_file)!r}).write_text(str(holder.pid), encoding="utf-8")
print("verified ordinary result")
pathlib.Path({str(done_file)!r}).write_text(str(time.monotonic()), encoding="utf-8")
"""
        ctx = {"document": tab["id"], "cell": "0", "interpreter": sys.executable}
        window1.post("stream-run", "run_python", json.dumps({"id": tab["id"], "code": code, "context": ctx}))
        _, raw, err = self._await_reply(replies1, "stream-run", timeout=25.0)
        drain_elapsed = time.monotonic() - float(self._await_file(done_file, timeout=5.0))

        holder_pid = int(self._await_file(pid_file, timeout=5.0))
        self.addCleanup(_best_effort_kill, holder_pid)

        self.assertLess(drain_elapsed, 10.0)
        self.assertEqual(err, "")
        payload = json.loads(raw)
        self.assertTrue(payload["ok"])
        self.assertEqual(payload["stdout"], "verified ordinary result\n")
        self.assertTrue(payload["provenance"]["verified"])
        self.assertEqual(window1.busy, 0)
        self.assertTrue(_wait_pid_exit(holder_pid, timeout=6.0))

    def test_package_setup_and_preview_processes_stay_separate_from_cell_cleanup(self):
        window1, replies1 = self._new_window()
        tab_a = window1._note("A.md", "# A", "", "# A")
        tab_b = window1._note("B.md", "# B", "", "# B")
        window1.tabs = [tab_a, tab_b]
        window1.active = tab_a["id"]

        setup_started = threading.Event()
        setup_release = threading.Event()
        cell_pid_file = self.root / "cell-during-setup.pid"

        def controlled_setup(managed, report=lambda text: None):
            setup_started.set()
            setup_release.wait(5)
            return sys.executable

        cell_code = f"""
import pathlib, subprocess, sys
child = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(30)"])
pathlib.Path({str(cell_pid_file)!r}).write_text(str(child.pid), encoding="utf-8")
child.wait()
"""
        with patch.object(python_runtime, "setup_environment", side_effect=controlled_setup):
            window1.setupPython()
            self.assertTrue(setup_started.wait(2))
            window1.post("cell-a", "run_python", json.dumps({"id": tab_a["id"], "code": cell_code}))
            cell_pid = int(self._await_file(cell_pid_file))
            self.addCleanup(_best_effort_kill, cell_pid)

            # Closing tab A kills tab A's cell tree without disturbing package setup.
            window1.closeTab(tab_a["id"])
            self.assertTrue(_wait_pid_exit(cell_pid, timeout=6.0))
            self.assertTrue(window1.python_busy)
            _, raw_cell, err_cell = self._await_reply(replies1, "cell-a")
            self.assertEqual((raw_cell, err_cell), ("null", "Python cell cancelled"))

            setup_release.set()
            deadline = time.monotonic() + 3
            while window1.python_busy and time.monotonic() < deadline:
                self.app.processEvents()
                time.sleep(0.01)
            self.assertFalse(window1.python_busy)
            self.assertEqual(window1.settings["python"], sys.executable)

        # Offline reader preview helper stays independent of PythonJobRegistry.
        self.assertFalse(hasattr(offline_view, "PythonJobRegistry"))

    def test_stop_python_stops_specific_cell_leaving_independent_cell_and_other_window_responsive(self):
        window1, replies1 = self._new_window()
        window2, replies2 = self._new_window()

        tab1 = window1._current()
        tab2 = window2._current()
        ctx_cell0 = {"document": tab1["id"], "cell": "0", "interpreter": sys.executable}
        ctx_cell1 = {"document": tab1["id"], "cell": "1", "interpreter": sys.executable}
        ctx_win2 = {"document": tab2["id"], "cell": "0", "interpreter": sys.executable}

        # Seed a verified output for cell 0 and confirm it is persisted before re-running and stopping.
        window1.post(
            "seed-0",
            "run_python",
            json.dumps({"id": tab1["id"], "jobId": "seed-job-0", "code": "print('verified baseline')", "context": ctx_cell0}),
        )
        _, raw_seed, err_seed = self._await_reply(replies1, "seed-0")
        self.assertEqual(err_seed, "")
        self.assertEqual(json.loads(raw_seed)["stdout"], "verified baseline\n")
        self.assertTrue(json.loads(raw_seed)["provenance"]["verified"])

        c0_child_file = self.root / "stop-c0-child.pid"
        c0_grand_file = self.root / "stop-c0-grand.pid"
        c1_ready = self.root / "stop-c1.ready"
        c1_release = self.root / "stop-c1.release"
        c1_child_file = self.root / "stop-c1-child.pid"
        w2_ready = self.root / "stop-w2.ready"
        w2_release = self.root / "stop-w2.release"
        w2_child_file = self.root / "stop-w2-child.pid"

        def _build_c0_code(child_path: str, grand_path: str) -> str:
            return f"""
import pathlib, subprocess, sys
helper = '''
import pathlib, subprocess, sys
grand = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(30)"])
pathlib.Path(sys.argv[1]).write_text(str(grand.pid), encoding="utf-8")
grand.wait()
'''
child = subprocess.Popen([sys.executable, "-c", helper, {grand_path!r}])
pathlib.Path({child_path!r}).write_text(str(child.pid), encoding="utf-8")
child.wait()
"""

        # Regression check for Windows temp paths containing \U escapes (e.g. C:\Users\runneradmin\...).
        win_probe_ns: dict[str, object] = {}
        win_snippet = _build_c0_code(
            str(PureWindowsPath(r"C:\Users\runneradmin\AppData\Local\Temp\stop-c0-child.pid")),
            str(PureWindowsPath(r"C:\Users\runneradmin\AppData\Local\Temp\stop-c0-grand.pid")),
        )
        compile(win_snippet, "<win-code-c0>", "exec")
        exec(win_snippet.split("child = subprocess.Popen", 1)[0], win_probe_ns)
        compile(str(win_probe_ns["helper"]), "<win-helper>", "exec")

        code_c0 = _build_c0_code(str(c0_child_file), str(c0_grand_file))
        code_c1 = f"""
import pathlib, subprocess, sys, time
child = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(30)"])
pathlib.Path({str(c1_child_file)!r}).write_text(str(child.pid), encoding="utf-8")
pathlib.Path({str(c1_ready)!r}).write_text("ready", encoding="utf-8")
deadline = time.monotonic() + 20
while not pathlib.Path({str(c1_release)!r}).exists() and time.monotonic() < deadline:
    time.sleep(0.02)
child.terminate()
child.wait(timeout=5)
print("independent cell 1 completed")
"""
        code_w2 = f"""
import pathlib, subprocess, sys, time
child = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(30)"])
pathlib.Path({str(w2_child_file)!r}).write_text(str(child.pid), encoding="utf-8")
pathlib.Path({str(w2_ready)!r}).write_text("ready", encoding="utf-8")
deadline = time.monotonic() + 20
while not pathlib.Path({str(w2_release)!r}).exists() and time.monotonic() < deadline:
    time.sleep(0.02)
child.terminate()
child.wait(timeout=5)
print("window 2 cell completed")
"""
        window1.post("run-c0", "run_python", json.dumps({"id": tab1["id"], "jobId": "job-c0", "code": code_c0, "context": ctx_cell0}))
        window1.post("run-c1", "run_python", json.dumps({"id": tab1["id"], "jobId": "job-c1", "code": code_c1, "context": ctx_cell1}))
        window2.post("run-w2", "run_python", json.dumps({"id": tab2["id"], "jobId": "job-w2", "code": code_w2, "context": ctx_win2}))

        c0_child_pid = int(self._await_file(c0_child_file))
        c0_grand_pid = int(self._await_file(c0_grand_file))
        c1_child_pid = int(self._await_file(c1_child_file))
        w2_child_pid = int(self._await_file(w2_child_file))
        self._await_file(c1_ready)
        self._await_file(w2_ready)
        for pid in (c0_child_pid, c0_grand_pid, c1_child_pid, w2_child_pid):
            self.addCleanup(_best_effort_kill, pid)

        # Cross-window stop attempts never touch another window's cell jobs.
        window1.post("stop-foreign", "stop_python", json.dumps({"jobId": "job-w2"}))
        _, raw_foreign, err_foreign = self._await_reply(replies1, "stop-foreign")
        self.assertEqual((json.loads(raw_foreign), err_foreign), ({"stopped": False}, ""))
        self.assertTrue(_pid_alive(w2_child_pid))

        # Stop only cell 0 in window1: non-blocking on Qt thread, reaps cell 0's tree, preserves last verified output.
        stop_t0 = time.monotonic()
        window1.post("stop-c0", "stop_python", json.dumps({"jobId": "job-c0"}))
        self.assertLess(time.monotonic() - stop_t0, 0.25)
        _, raw_stop, err_stop = self._await_reply(replies1, "stop-c0")
        self.assertEqual((json.loads(raw_stop), err_stop), ({"stopped": True}, ""))

        _, raw_c0, err_c0 = self._await_reply(replies1, "run-c0")
        self.assertEqual((raw_c0, err_c0), ("null", "Python cell cancelled"))
        self.assertTrue(_wait_pid_exit(c0_child_pid, timeout=6.0))
        self.assertTrue(_wait_pid_exit(c0_grand_pid, timeout=6.0))

        # Cell 0's last verified output remains intact in session.python_outputs.
        window1.post("load-0", "load_python_output", json.dumps({"source": "print('verified baseline')", "context": ctx_cell0}))
        _, raw_loaded, err_loaded = self._await_reply(replies1, "load-0")
        self.assertEqual(err_loaded, "")
        loaded_payload = json.loads(raw_loaded)
        self.assertEqual(loaded_payload["stdout"], "verified baseline\n")
        self.assertTrue(loaded_payload["provenance"]["verified"])

        # Independent cell 1 (same note!) and window 2 stay alive and complete with verified outputs.
        self.assertTrue(_pid_alive(c1_child_pid))
        self.assertTrue(_pid_alive(w2_child_pid))
        c1_release.write_text("done", encoding="utf-8")
        w2_release.write_text("done", encoding="utf-8")

        _, raw_c1, err_c1 = self._await_reply(replies1, "run-c1")
        _, raw_w2, err_w2 = self._await_reply(replies2, "run-w2")
        self.assertEqual(err_c1, "")
        self.assertEqual(err_w2, "")
        self.assertEqual(json.loads(raw_c1)["stdout"], "independent cell 1 completed\n")
        self.assertTrue(json.loads(raw_c1)["provenance"]["verified"])
        self.assertEqual(json.loads(raw_w2)["stdout"], "window 2 cell completed\n")
        self.assertTrue(json.loads(raw_w2)["provenance"]["verified"])

    def test_save_export_and_tab_controls_stay_usable_while_python_cells_run(self):
        window1, replies1 = self._new_window()
        window2, _replies2 = self._new_window()

        note_path = self.root / "active-note.md"
        note_path.write_text("# Initial\n", encoding="utf-8")
        sibling_path = self.root / "sibling-note.md"
        sibling_path.write_text("# Sibling\n", encoding="utf-8")
        movable_path = self.root / "movable-note.md"
        movable_path.write_text("# Movable\n", encoding="utf-8")

        tab_run = window1._note("active-note.md", "# Initial\n", str(note_path), "# Initial\n")
        tab_sibling = window1._note("sibling-note.md", "# Sibling\n", str(sibling_path), "# Sibling\n")
        tab_movable = window1._note("movable-note.md", "# Movable\n", str(movable_path), "# Movable\n")
        window1.tabs = [tab_run, tab_sibling, tab_movable]
        window1.active = tab_run["id"]

        # Saturate _python_pool with 4 concurrent cells to prove Save, Export, and tab controls never block or starve.
        release_cells = self.root / "release-busy-cells.txt"
        ready_files = [self.root / f"busy-cell-{i}.ready" for i in range(4)]
        for i, ready_file in enumerate(ready_files):
            code = f"""
import pathlib, time
pathlib.Path({str(ready_file)!r}).write_text("ready", encoding="utf-8")
deadline = time.monotonic() + 20
while not pathlib.Path({str(release_cells)!r}).exists() and time.monotonic() < deadline:
    time.sleep(0.02)
print("cell-{i}-done")
"""
            ctx = {"document": str(note_path), "cell": str(i), "interpreter": sys.executable}
            window1.post(f"bg-{i}", "run_python", json.dumps({"id": tab_run["id"], "jobId": f"bg-job-{i}", "code": code, "context": ctx}))

        for ready_file in ready_files:
            self._await_file(ready_file)

        # Window-wide busy remains false so QML Save, Save as, Export, StudyControls, and tab drags stay enabled.
        self.assertEqual(window1.busy, 0)
        self.assertFalse(json.loads(window1.snapshot)["busy"])
        self.assertTrue(window1.canReceiveTab(window1.window_id, tab_sibling["id"]))
        self.assertTrue(window2.canReceiveTab(window1.window_id, tab_movable["id"]))

        # 1. Ordinary Save succeeds while all 4 Python cells are running.
        tab_run["content"] = "# Updated while Python cell runs\n"
        window1.saveSafely()
        deadline = time.monotonic() + 5.0
        while (window1.saving or window1.message != "Saved") and time.monotonic() < deadline:
            self.app.processEvents()
            time.sleep(0.01)
        self.assertEqual(note_path.read_text(encoding="utf-8"), "# Updated while Python cell runs\n")
        self.assertEqual(window1.message, "Saved")

        # 2. Ordinary Markdown Export succeeds while all 4 Python cells are running.
        exported_md = self.root / "exported-while-running.md"
        window1.pending_export = str(exported_md)
        window1.post(
            "exp-md",
            "export_markdown_native",
            json.dumps({"id": tab_run["id"], "content": tab_run["content"], "assets": {}}),
        )
        _, raw_exp, err_exp = self._await_reply(replies1, "exp-md")
        self.assertEqual(err_exp, "")
        self.assertEqual(Path(json.loads(raw_exp)["path"]), exported_md)
        self.assertEqual(exported_md.read_text(encoding="utf-8"), "# Updated while Python cell runs\n")

        # 3. Tab controls (newNote, selectTab, reorder, cross-window move, close sibling tab) stay usable while cells run.
        window1.newNote()
        self.assertEqual(len(window1.tabs), 4)
        created_tab_id = window1.active
        window1.selectTab(tab_sibling["id"])
        self.assertEqual(window1.active, tab_sibling["id"])
        window1.receiveTab(window1.window_id, tab_sibling["id"], 0)
        self.assertEqual(window1.tabs[0]["id"], tab_sibling["id"])
        window2.receiveTab(window1.window_id, tab_movable["id"], 0)
        self.assertTrue(any(t["id"] == tab_movable["id"] for t in window2.tabs))
        window1.closeTab(created_tab_id)
        self.assertFalse(any(t["id"] == created_tab_id for t in window1.tabs))
        window1.selectTab(tab_run["id"])
        self.assertEqual(window1.active, tab_run["id"])

        # All 4 running cells in tab_run were undisturbed and finish with verified outputs.
        self.assertEqual(window1._python_jobs.active_count(tab_run["id"]), 4)
        release_cells.write_text("done", encoding="utf-8")
        for i in range(4):
            _, raw_bg, err_bg = self._await_reply(replies1, f"bg-{i}")
            self.assertEqual(err_bg, "")
            self.assertEqual(json.loads(raw_bg)["stdout"], f"cell-{i}-done\n")
            self.assertTrue(json.loads(raw_bg)["provenance"]["verified"])

    @unittest.skipUnless(
        (Path(__file__).resolve().parent.parent / "dist" / "qt-reader.html").is_file(),
        "Build the Qt reader before real WebEngine integration tests",
    )
    def test_real_desktop_reader_stop_button_cancels_cell_and_retains_verified_output(self):
        env = dict(
            os.environ,
            QT_QPA_PLATFORM="offscreen",
            QT_QUICK_BACKEND="software",
            QTWEBENGINE_DISABLE_SANDBOX="1",
            QTWEBENGINE_CHROMIUM_FLAGS="--disable-gpu --disable-dev-shm-usage",
        )
        result = subprocess.run(
            [sys.executable, str(Path(__file__).resolve()), "--probe-stop", str(self.root)],
            cwd=Path(__file__).resolve().parent,
            env=env,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="strict",
            timeout=120,
        )
        lines = [line for line in result.stdout.splitlines() if line.startswith("{")]
        self.assertTrue(lines, f"real stop probe emitted no JSON report:\n{result.stdout}\n{result.stderr}")
        report = json.loads(lines[-1])
        self.assertEqual(result.returncode, 0, f"real stop probe failed: {report}\n{result.stderr}")
        self.assertTrue(report["ok"], report)
        self.assertFalse(report["busyWhileRunning"])
        self.assertTrue(report["cell0StoppedChildExited"])
        self.assertIn("Baseline checksum: 42 (verified)", report["cell0RetainedOutput"])
        self.assertEqual(report["cell0ErrorText"], "")
        self.assertIn("Independent cell finished: 99", report["cell1FinalOutput"])
        self.assertEqual(report["window2Stdout"], "window2-ok\n")

    def test_real_reader_stop_probe_teardown_allows_close_and_skips_darwin_webengine_gc(self):
        from types import SimpleNamespace
        from unittest.mock import MagicMock

        global _PROBE_DARWIN_TEARDOWN_DONE
        events: list[object] = []

        def _make_fakes():
            events.clear()
            _PROBE_DARWIN_EXIT_ANCHOR.clear()
            fake_app = MagicMock()
            fake_app.sendPostedEvents.side_effect = lambda *_a: events.append("deferred_delete")
            fake_studio = MagicMock()
            fake_studio._python_pool = MagicMock()
            fake_studio.stop.side_effect = lambda: events.append("studio_stop")
            fake_window2 = MagicMock()
            fake_window2._python_pool = None
            fake_window2.stop.side_effect = lambda: events.append("window2_stop")
            fake_session = SimpleNamespace(
                writes=MagicMock(shutdown=lambda wait=True: events.append(("writes_shutdown", wait)))
            )
            props: dict[str, object] = {"closingAllowed": False, "intentionalShutdown": False}
            fake_loader = MagicMock()
            fake_window = MagicMock()
            fake_window.setProperty.side_effect = lambda k, v: props.__setitem__(k, v)
            fake_window.findChild.return_value = fake_loader
            fake_window.close.side_effect = lambda: events.append(
                ("window_close", props["closingAllowed"], props["intentionalShutdown"])
            )
            fake_engine = MagicMock()
            fake_engine.deleteLater.side_effect = lambda: events.append("engine_delete")
            fake_handler = MagicMock()
            fake_handler.deleteLater.side_effect = lambda: events.append("handler_delete")
            return fake_app, fake_session, (fake_window2, fake_studio), fake_engine, fake_window, fake_handler

        # Non-Darwin: must set intentionalShutdown + closingAllowed BEFORE window.close() and remove scheme handler.
        app_l, sess_l, studios_l, eng_l, win_l, handler_l = _make_fakes()
        mock_profile_l = MagicMock()
        with (
            patch.object(sys, "platform", "linux"),
            patch("PySide6.QtWebEngineCore.QWebEngineProfile.defaultProfile", return_value=mock_profile_l),
        ):
            _teardown_real_reader_stop_probe(
                app=app_l,
                session=sess_l,
                studios=studios_l,
                engine=eng_l,
                window=win_l,
                bundle_handler=handler_l,
            )
            self.assertIn(("window_close", True, True), events)
            mock_profile_l.removeUrlSchemeHandler.assert_called_once_with(handler_l)
            self.assertTrue(_PROBE_DARWIN_TEARDOWN_DONE)
            with self.assertRaises(SystemExit) as cm:
                _exit_probe_process(0)
            self.assertEqual(cm.exception.code, 0)

        # Darwin: must flush studios/writes, anchor Qt/WebEngine wrappers without touching WebEngine destructors, and os._exit.
        app_d, sess_d, studios_d, eng_d, win_d, handler_d = _make_fakes()
        with (
            patch.object(sys, "platform", "darwin"),
            patch("PySide6.QtWebEngineCore.QWebEngineProfile.defaultProfile") as mock_profile_d,
            patch("os._exit", side_effect=SystemExit(0)) as mock_os_exit,
        ):
            _teardown_real_reader_stop_probe(
                app=app_d,
                session=sess_d,
                studios=studios_d,
                engine=eng_d,
                window=win_d,
                bundle_handler=handler_d,
            )
            self.assertEqual(
                events,
                ["window2_stop", "studio_stop", ("writes_shutdown", True)],
            )
            self.assertFalse(mock_profile_d.called)
            self.assertFalse(win_d.close.called)
            self.assertTrue(_PROBE_DARWIN_EXIT_ANCHOR)
            self.assertTrue(_PROBE_DARWIN_TEARDOWN_DONE)
            with self.assertRaises(SystemExit):
                _exit_probe_process(0)
            mock_os_exit.assert_called_once_with(0)
        _PROBE_DARWIN_EXIT_ANCHOR.clear()
        _PROBE_DARWIN_TEARDOWN_DONE = False


_PROBE_DARWIN_EXIT_ANCHOR: list[object] = []
_PROBE_DARWIN_TEARDOWN_DONE = False


def _exit_probe_process(status: int) -> None:
    sys.stdout.flush()
    sys.stderr.flush()
    if sys.platform == "darwin" and _PROBE_DARWIN_TEARDOWN_DONE:
        os._exit(int(status))
    raise SystemExit(int(status))


def _teardown_real_reader_stop_probe(
    *,
    app,
    session,
    studios: tuple,
    engine,
    window,
    bundle_handler,
    child_pid: int = 0,
) -> None:
    global _PROBE_DARWIN_TEARDOWN_DONE
    if child_pid:
        _best_effort_kill(child_pid)
    for w in studios:
        if w is None:
            continue
        w.stop()
        w.pool.shutdown(wait=True, cancel_futures=True)
        w._search_pool.shutdown(wait=True, cancel_futures=True)
        if w._python_pool is not None:
            w._python_pool.shutdown(wait=True, cancel_futures=True)
    if session is not None:
        session.writes.shutdown(wait=True)
    if sys.platform == "darwin":
        # Match desktop/main.py: destroying QQuickWebEngineView / WebEngineContext
        # during headless macOS exit can block indefinitely waiting on a mid-spawn
        # QtWebEngineProcess Mach port. Flush all Python/disk state first, anchor
        # Qt/WebEngine wrappers against GC, and terminate via os._exit.
        _PROBE_DARWIN_EXIT_ANCHOR[:] = [
            app,
            session,
            list(studios),
            engine,
            window,
            bundle_handler,
        ]
        _PROBE_DARWIN_TEARDOWN_DONE = True
        return
    from PySide6.QtCore import QEvent, QObject
    from PySide6.QtWebEngineCore import QWebEngineProfile

    if window is not None:
        try:
            window.setProperty("intentionalShutdown", True)
            window.setProperty("closingAllowed", True)
            loader = window.findChild(QObject, "documentReaderLoader")
            if loader is not None:
                loader.setProperty("active", False)
            window.close()
        except RuntimeError:
            pass
    if engine is not None:
        engine.deleteLater()
    if app is not None:
        app.sendPostedEvents(None, QEvent.Type.DeferredDelete)
    if bundle_handler is not None:
        try:
            QWebEngineProfile.defaultProfile().removeUrlSchemeHandler(bundle_handler)
        except RuntimeError:
            pass
        bundle_handler.deleteLater()
    for w in studios:
        if w is not None:
            w.host_window = None
    if app is not None:
        app.sendPostedEvents(None, QEvent.Type.DeferredDelete)
    _PROBE_DARWIN_TEARDOWN_DONE = True


def _real_reader_stop_probe(directory: str, screenshot_path: str = "") -> int:
    import traceback

    os.environ["QT_QPA_PLATFORM"] = "offscreen"
    os.environ["QT_QUICK_BACKEND"] = "software"
    os.environ.setdefault("QTWEBENGINE_CHROMIUM_FLAGS", "--disable-gpu --disable-dev-shm-usage")
    os.environ.setdefault("QTWEBENGINE_DISABLE_SANDBOX", "1")
    from PySide6.QtCore import QFile, QIODevice, QMetaObject, QObject, QUrl, Qt, Q_ARG
    from PySide6.QtQml import QQmlApplicationEngine
    from PySide6.QtQuickControls2 import QQuickStyle
    from PySide6.QtTest import QTest
    from PySide6.QtWebEngineCore import QWebEngineProfile
    from PySide6.QtWebEngineQuick import QtWebEngineQuick
    from PySide6.QtWidgets import QApplication
    from reader_assets import READER_SCHEME, ReaderBundleSchemeHandler, reader_bundle_url, register_reader_schemes

    desktop_root = Path(__file__).resolve().parent
    QQuickStyle.setStyle("Material")
    register_reader_schemes()
    QtWebEngineQuick.initialize()
    app = QApplication(["Super MD Python Stop integration"])
    bundle_handler = ReaderBundleSchemeHandler(desktop_root.parent / "dist", app)
    QWebEngineProfile.defaultProfile().installUrlSchemeHandler(READER_SCHEME.encode("ascii"), bundle_handler)

    temp = Path(directory).resolve()
    temp.mkdir(parents=True, exist_ok=True)
    session = Session(True, temp / "probe-session")
    session.settings["python"] = sys.executable
    session.settings["newNoteLocation"] = str(temp)

    studio = QuietStudio(True, session)
    studio.settings["python"] = sys.executable
    studio.settings["readingMode"] = "live"
    studio.settings["welcomed"] = True
    studio.mode = "live"

    window2 = QuietStudio(True, session)
    window2.settings["python"] = sys.executable
    w2_replies: list[tuple[str, str, str]] = []
    window2.replied.connect(lambda req_id, raw, err: w2_replies.append((req_id, raw, err)))

    c0_gate = temp / "c0-long.gate"
    c0_ready = temp / "c0-long.ready"
    c0_child_pid = temp / "c0-child.pid"
    c1_gate = temp / "c1-long.gate"
    c1_ready = temp / "c1-long.ready"
    c1_release = temp / "c1-release.txt"
    w2_ready = temp / "w2.ready"
    w2_release = temp / "w2-release.txt"

    note_path = temp / "Simulation Notebook.md"
    sibling_path = temp / "Field Notes.md"
    sibling_path.write_text("# Field Notes\n\nSecondary open tab.\n", encoding="utf-8")
    cell0_code = (
        "import pathlib, subprocess, sys\n"
        "if pathlib.Path('c0-long.gate').exists():\n"
        "    child = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(30)'])\n"
        "    pathlib.Path('c0-child.pid').write_text(str(child.pid), encoding='utf-8')\n"
        "    pathlib.Path('c0-long.ready').write_text('1', encoding='utf-8')\n"
        "    child.wait()\n"
        "print('Baseline checksum: 42 (verified)')\n"
    )
    cell1_code = (
        "import pathlib, time\n"
        "if pathlib.Path('c1-long.gate').exists():\n"
        "    pathlib.Path('c1-long.ready').write_text('1', encoding='utf-8')\n"
        "    deadline = time.monotonic() + 25\n"
        "    while not pathlib.Path('c1-release.txt').exists() and time.monotonic() < deadline:\n"
        "        time.sleep(0.02)\n"
        "print('Independent cell finished: 99')\n"
    )
    markdown = (
        "# Orbital Trajectory Verification\n\n"
        "Verify the baseline telemetry digest, then run long-horizon sampling while keeping the independent solver cell active.\n\n"
        f"```python\n{cell0_code}```\n\n"
        f"```python\n{cell1_code}```\n"
    )
    note_path.write_text(markdown, encoding="utf-8")

    tab = studio._current()
    tab.update(name=note_path.name, path=str(note_path), content=markdown, saved=markdown)
    sibling = studio._note("Field Notes.md", "# Field Notes\n\nSecondary open tab.\n", str(sibling_path), "# Field Notes\n\nSecondary open tab.\n")
    studio.tabs.append(sibling)

    engine = None
    window = None
    child_pid = 0
    try:
        channel = QFile(":/qtwebchannel/qwebchannel.js")
        if not channel.open(QIODevice.OpenModeFlag.ReadOnly):
            raise RuntimeError("Qt WebChannel runtime unavailable")
        channel_script = bytes(channel.readAll()).decode()

        engine = QQmlApplicationEngine()
        engine.rootContext().setContextProperty("studio", studio)
        engine.rootContext().setContextProperty("readerUrl", reader_bundle_url())
        engine.rootContext().setContextProperty("channelScript", channel_script)
        engine.rootContext().setContextProperty("brandUrl", QUrl.fromLocalFile(str(desktop_root.parent / "public" / "brand-mark-fixed.svg")))
        engine.load(QUrl.fromLocalFile(str(desktop_root / "qml" / "Main.qml")))
        if not engine.rootObjects():
            raise RuntimeError("Main.qml failed to load")
        window = engine.rootObjects()[0]
        window.setProperty("width", 1220)
        window.setProperty("height", 860)
        studio.host_window = window
        window.show()
        studio._emit()

        reader = window.findChild(QObject, "documentReader")
        if reader is None:
            raise RuntimeError("documentReader WebEngineView not found")

        def run_js(script: str) -> None:
            ok = QMetaObject.invokeMethod(window, "runDocumentScript", Qt.ConnectionType.DirectConnection, Q_ARG("QVariant", script))
            if not ok:
                raise RuntimeError("runDocumentScript invocation failed")

        def pump_until(predicate, timeout: float = 25.0, desc: str = "condition"):
            deadline = time.monotonic() + timeout
            while time.monotonic() < deadline:
                app.processEvents()
                value = predicate()
                if value:
                    return value
                QTest.qWait(15)
            raise TimeoutError(f"Timed out waiting for {desc}; reader title={reader.property('title')!r}")

        pump_until(lambda: studio.ready, desc="studio.ready")
        # Wait for both PythonCell run buttons to mount in Live mode, then run Cell 0 once to produce a verified baseline output.
        run_js(
            "(()=>{"
            "const poll=()=>{"
            "const runs=document.querySelectorAll('.python-cell button.python-run');"
            "if(runs.length>=2){runs[0].click();document.title='probe:baseline-clicked';return;}"
            "setTimeout(poll,30);};poll();})()"
        )
        pump_until(lambda: reader.property("title") == "probe:baseline-clicked", desc="initial cell buttons")

        run_js(
            "(()=>{"
            "const poll=()=>{"
            "const c0=document.querySelectorAll('.python-cell')[0];"
            "const out=c0?.querySelector('.cell-output')?.textContent||'';"
            "const busy=c0?.querySelector('button.python-stop');"
            "if(out.includes('Baseline checksum: 42 (verified)')&&!busy){document.title='probe:baseline-verified';return;}"
            "setTimeout(poll,30);};poll();})()"
        )
        pump_until(lambda: reader.property("title") == "probe:baseline-verified", desc="baseline verified output")

        # Arm long-running gates on Cell 0, Cell 1, and Window 2, then click Run on both Cell 0 and Cell 1.
        c0_gate.write_text("1", encoding="utf-8")
        c1_gate.write_text("1", encoding="utf-8")
        w2_code = (
            "import pathlib, time\n"
            f"pathlib.Path({str(w2_ready)!r}).write_text('1', encoding='utf-8')\n"
            "deadline = time.monotonic() + 25\n"
            f"while not pathlib.Path({str(w2_release)!r}).exists() and time.monotonic() < deadline:\n"
            "    time.sleep(0.02)\n"
            "print('window2-ok')\n"
        )
        w2_tab = window2._current()
        window2.post("w2-run", "run_python", json.dumps({"id": w2_tab["id"], "jobId": "w2-job", "code": w2_code}))

        run_js(
            "(()=>{"
            "const initCells=document.querySelectorAll('.python-cell');"
            "initCells[0].querySelector('button.python-run').click();"
            "initCells[1].querySelector('button.python-run').click();"
            "const poll=()=>{"
            "const cells=document.querySelectorAll('.python-cell');"
            "const s0=cells[0]?.querySelector('button.python-stop');"
            "const s1=cells[1]?.querySelector('button.python-stop');"
            "const out0=cells[0]?.querySelector('.cell-output')?.textContent||'';"
            "if(s0&&s1&&out0.includes('Baseline checksum: 42 (verified)')){"
            "const lb=cells[0].closest('.live-block');"
            "if(lb){lb.dispatchEvent(new PointerEvent('pointerover',{bubbles:true,pointerType:'mouse'}));}"
            "document.title='probe:both-running';return;}"
            "setTimeout(poll,25);};poll();})()"
        )
        pump_until(lambda: reader.property("title") == "probe:both-running", desc="both cells showing Stop")
        pump_until(lambda: _read_nonempty(c0_ready) and _read_nonempty(c1_ready) and _read_nonempty(w2_ready), desc="worker ready files")
        child_pid = int(_read_nonempty(c0_child_pid))
        busy_while_running = bool(json.loads(studio.snapshot)["busy"])

        if screenshot_path:
            end_frame = time.monotonic() + 0.35
            while time.monotonic() < end_frame:
                app.processEvents()
                QTest.qWait(20)
            img = window.grabWindow()
            img.save(screenshot_path)

        # Click Stop ONLY on Cell 0; Cell 1 and Window 2 must stay alive and complete cleanly.
        run_js(
            "(()=>{"
            "document.querySelectorAll('.python-cell')[0].querySelector('button.python-stop').click();"
            "const poll=()=>{"
            "const cells=document.querySelectorAll('.python-cell');"
            "const s0=cells[0]?.querySelector('button.python-stop');"
            "const s1=cells[1]?.querySelector('button.python-stop');"
            "if(!s0&&s1){"
            "const out0=cells[0]?.querySelector('.cell-output')?.textContent||'';"
            "const err0=cells[0]?.querySelector('.cell-error,.cell-output.failed')?.textContent||'';"
            "document.title='probe:c0-stopped:'+JSON.stringify({out0,err0});return;}"
            "setTimeout(poll,25);};poll();})()"
        )
        stopped_title = pump_until(
            lambda: reader.property("title") if str(reader.property("title") or "").startswith("probe:c0-stopped:") else "",
            desc="Cell 0 Stop completion while Cell 1 continues",
        )
        c0_dom = json.loads(str(stopped_title).split("probe:c0-stopped:", 1)[1])
        c0_child_exited = _wait_pid_exit(child_pid, timeout=5.0)

        # Release Cell 1 and Window 2 and confirm both finish with verified outputs.
        c1_release.write_text("go", encoding="utf-8")
        w2_release.write_text("go", encoding="utf-8")
        run_js(
            "(()=>{"
            "const poll=()=>{"
            "const c1=document.querySelectorAll('.python-cell')[1];"
            "const s1=c1?.querySelector('button.python-stop');"
            "const out1=c1?.querySelector('.cell-output')?.textContent||'';"
            "if(!s1&&out1.includes('Independent cell finished: 99')){"
            "document.title='probe:c1-done:'+JSON.stringify({out1});return;}"
            "setTimeout(poll,25);};poll();})()"
        )
        c1_title = pump_until(
            lambda: reader.property("title") if str(reader.property("title") or "").startswith("probe:c1-done:") else "",
            desc="Cell 1 completion",
        )
        c1_dom = json.loads(str(c1_title).split("probe:c1-done:", 1)[1])
        w2_entry = pump_until(lambda: w2_replies[-1] if w2_replies else None, desc="Window 2 reply")
        w2_payload = json.loads(w2_entry[1])

        report = {
            "ok": True,
            "busyWhileRunning": busy_while_running,
            "cell0StoppedChildExited": c0_child_exited,
            "cell0RetainedOutput": c0_dom["out0"],
            "cell0ErrorText": c0_dom["err0"],
            "cell1FinalOutput": c1_dom["out1"],
            "window2Stdout": w2_payload.get("stdout", ""),
        }
        print(json.dumps(report), flush=True)
        return 0
    except Exception:
        traceback.print_exc()
        return 1
    finally:
        _teardown_real_reader_stop_probe(
            app=app,
            session=session,
            studios=(window2, studio),
            engine=engine,
            window=window,
            bundle_handler=bundle_handler,
            child_pid=child_pid,
        )


if __name__ == "__main__":
    if len(sys.argv) >= 3 and sys.argv[1] == "--probe-stop":
        shot = sys.argv[3] if len(sys.argv) >= 4 else ""
        _exit_probe_process(_real_reader_stop_probe(sys.argv[2], shot))
    unittest.main()
