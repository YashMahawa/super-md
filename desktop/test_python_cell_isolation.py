"""Isolated multi-window and per-tab Python cell process cleanup tests."""
from __future__ import annotations

import json
import os
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path
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
        self.session = Session(True)
        self.session.settings["python"] = sys.executable
        self.windows: list[QuietStudio] = []

    def tearDown(self):
        for window in reversed(self.windows):
            window.stop()
            window.pool.shutdown(wait=True, cancel_futures=True)
            window._search_pool.shutdown(wait=True, cancel_futures=True)
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
    "import pathlib, subprocess, sys, time\\n"
    "gc = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(30)'])\\n"
    f"pathlib.Path({str(w1_grandchild_pid_file)!r}).write_text(str(gc.pid), encoding='utf-8')\\n"
    f"pathlib.Path({str(w1_ready)!r}).write_text('1', encoding='utf-8')\\n"
    "gc.wait()\\n"
)
child = subprocess.Popen([sys.executable, "-c", inner])
pathlib.Path({str(w1_child_pid_file)!r}).write_text(str(child.pid), encoding="utf-8")
child.wait()
"""
        w2_code = f"""
import pathlib, subprocess, sys, time
helper = subprocess.Popen([
    sys.executable,
    "-c",
    f"import pathlib, time\\n"
    f"deadline = time.monotonic() + 30\\n"
    f"while not pathlib.Path({str(w2_release)!r}).exists() and time.monotonic() < deadline:\\n"
    f"    time.sleep(0.02)\\n",
])
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
        self.assertEqual(window2.busy, 1)

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
child = subprocess.Popen([
    sys.executable,
    "-c",
    f"import pathlib, time\\n"
    f"deadline = time.monotonic() + 30\\n"
    f"while not pathlib.Path({str(release_bc)!r}).exists() and time.monotonic() < deadline:\\n"
    f"    time.sleep(0.02)\\n",
])
pathlib.Path({str(b_pid_file)!r}).write_text(str(child.pid), encoding="utf-8")
child.wait()
print("tab b result")
"""
        code_c = f"""
import pathlib, subprocess, sys
child = subprocess.Popen([
    sys.executable,
    "-c",
    f"import pathlib, time\\n"
    f"deadline = time.monotonic() + 30\\n"
    f"while not pathlib.Path({str(release_bc)!r}).exists() and time.monotonic() < deadline:\\n"
    f"    time.sleep(0.02)\\n",
])
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
            "import signal, time; "
            "hasattr(signal, 'SIGTERM') and signal.signal(signal.SIGTERM, signal.SIG_IGN); "
            "time.sleep(30)"
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


if __name__ == "__main__":
    unittest.main()
