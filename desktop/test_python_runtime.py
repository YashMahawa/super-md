"""Python cell runtimes: interpreter validation, file-based runs and discovery."""
from concurrent.futures import ThreadPoolExecutor
import ctypes
import os
import signal
import stat
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest.mock import patch

import python_runtime


def _pid_alive(pid: int) -> bool:
    if not isinstance(pid, int) or pid <= 0:
        return False
    if os.name == "nt":
        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel32.OpenProcess.argtypes = [ctypes.c_uint32, ctypes.c_int, ctypes.c_uint32]
        kernel32.OpenProcess.restype = ctypes.c_void_p
        kernel32.WaitForSingleObject.argtypes = [ctypes.c_void_p, ctypes.c_uint32]
        kernel32.WaitForSingleObject.restype = ctypes.c_uint32
        kernel32.CloseHandle.argtypes = [ctypes.c_void_p]
        kernel32.CloseHandle.restype = ctypes.c_int
        handle = kernel32.OpenProcess(0x00100000 | 0x1000, 0, pid)
        if not handle:
            return False
        try:
            return kernel32.WaitForSingleObject(ctypes.c_void_p(handle), 0) == 0x00000102
        finally:
            kernel32.CloseHandle(ctypes.c_void_p(handle))
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    stat_file = Path(f"/proc/{pid}/stat")
    if stat_file.is_file():
        try:
            text = stat_file.read_text(encoding="utf-8", errors="replace")
            state = text.rsplit(")", 1)[-1].split()[0]
            if state == "Z":
                return False
        except (OSError, IndexError):
            pass
    return True


def _wait_pid_exit(pid: int, timeout: float = 3.0) -> bool:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if not _pid_alive(pid):
            return True
        time.sleep(0.02)
    return not _pid_alive(pid)


def _best_effort_kill(pid: int) -> None:
    if not _pid_alive(pid):
        return
    try:
        if os.name == "nt":
            subprocess.run(
                ["taskkill", "/F", "/T", "/PID", str(pid)],
                stdin=subprocess.DEVNULL,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                timeout=5,
            )
        else:
            os.kill(pid, signal.SIGKILL)
    except Exception:
        pass


def _make_fake_python(path: Path) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(b"#!/bin/sh\nexit 0\n")
    path.chmod(path.stat().st_mode | stat.S_IXUSR)
    return path


class PythonRuntimeTest(unittest.TestCase):
    def test_rejects_executables_that_are_not_python(self):
        for path in ("/bin/sh", "/usr/bin/env", "", "definitely-not-python"):
            with self.subTest(path=path), self.assertRaises(ValueError):
                python_runtime.validate(path)
        self.assertEqual(python_runtime.validate(sys.executable), sys.executable)

    def test_bundled_runtime_is_only_offered_by_frozen_builds(self):
        self.assertFalse(python_runtime.bundled_available())
        with self.assertRaises(ValueError):
            python_runtime.validate(python_runtime.BUNDLED)

    def test_runs_in_note_folder_and_reports_clean_tracebacks(self):
        with tempfile.TemporaryDirectory() as folder:
            Path(folder, "data.txt").write_text("42", encoding="utf-8")
            result = python_runtime.run(sys.executable, "print(open('data.txt').read())\nx = 1\nraise ValueError('broken cell')", cwd=folder)
        self.assertFalse(result["ok"])
        self.assertEqual(result["stdout"].strip(), "42")
        self.assertIn("Line 3: raise ValueError('broken cell')", result["stderr"])
        self.assertIn("ValueError: broken cell", result["stderr"])
        self.assertNotIn("supermd-cell", result["stderr"])

    def test_oversized_cells_and_timeouts_are_refused(self):
        with self.assertRaises(ValueError):
            python_runtime.run(sys.executable, "#" * (python_runtime.MAX_CODE + 1))
        with self.assertRaisesRegex(ValueError, "stopped after 1 seconds"):
            python_runtime.run(sys.executable, "import time\ntime.sleep(5)", timeout=1)

    def test_discovery_finds_this_interpreter_and_project_virtualenvs(self):
        with tempfile.TemporaryDirectory() as folder:
            venv = Path(folder, ".venv", "Scripts" if os.name == "nt" else "bin")
            venv.mkdir(parents=True)
            paths = [str(path) for path in python_runtime.candidates(Path(folder, "managed"), [folder])]
        self.assertTrue(any(os.path.samefile(path, sys.executable) for path in paths if os.path.exists(path)))
        self.assertTrue(all(python_runtime.NAME.match(Path(path).name) for path in paths))

    def test_candidates_deduplicate_same_dir_symlinks_while_retaining_distinct_virtualenvs(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            home = root / "home"
            home.mkdir()
            base_bin = root / "system" / ("Scripts" if os.name == "nt" else "bin")
            real_python = _make_fake_python(base_bin / ("python.exe" if os.name == "nt" else "python3.12"))
            managed = root / "managed"
            proj_a = root / "proj-a"
            proj_b = root / "proj-b"
            if os.name != "nt":
                (base_bin / "python3").symlink_to(real_python.name)
                (base_bin / "python").symlink_to("python3")
                for prefix in (managed, proj_a / ".venv", proj_b / ".venv"):
                    bin_dir = prefix / "bin"
                    bin_dir.mkdir(parents=True)
                    (bin_dir / "python3").symlink_to(real_python)
                    (bin_dir / "python").symlink_to("python3")
                with (
                    patch("python_runtime.Path.home", return_value=home),
                    patch.dict(os.environ, {"VIRTUAL_ENV": "", "CONDA_PREFIX": ""}, clear=False),
                    patch("python_runtime.shutil.which", side_effect=lambda name: str(base_bin / name) if (base_bin / name).exists() else None),
                    patch("python_runtime.frozen", return_value=True),
                ):
                    paths = python_runtime.candidates(managed, [str(proj_a), str(proj_b)])
                chosen = [p for p in paths if p.is_relative_to(root)]
                self.assertEqual(
                    chosen,
                    [
                        managed / "bin" / "python3",
                        proj_a / ".venv" / "bin" / "python3",
                        proj_b / ".venv" / "bin" / "python3",
                        base_bin / "python3",
                    ],
                )
            else:
                alias = _make_fake_python(base_bin / "python3.exe")
                for prefix in (managed, proj_a / ".venv", proj_b / ".venv"):
                    _make_fake_python(prefix / "Scripts" / "python.exe")
                with (
                    patch("python_runtime.Path.home", return_value=home),
                    patch.dict(os.environ, {"VIRTUAL_ENV": "", "CONDA_PREFIX": "", "LOCALAPPDATA": str(root / "appdata")}, clear=False),
                    patch("python_runtime.shutil.which", side_effect=lambda name: str(alias) if name == "python3" else (str(real_python) if name == "python" else None)),
                    patch("python_runtime.os.path.realpath", return_value=str(real_python)),
                    patch("python_runtime.frozen", return_value=True),
                ):
                    paths = python_runtime.candidates(managed, [str(proj_a), str(proj_b)])
                self.assertEqual(
                    paths,
                    [
                        managed / "Scripts" / "python.exe",
                        proj_a / ".venv" / "Scripts" / "python.exe",
                        proj_b / ".venv" / "Scripts" / "python.exe",
                        alias,
                    ],
                )

    def test_default_python_resolves_priority_order_without_subprocesses(self):
        with tempfile.TemporaryDirectory() as folder, patch(
            "python_runtime.subprocess.run",
            side_effect=AssertionError("default_python must not spawn subprocesses"),
        ):
            root = Path(folder)
            bin_sub = "Scripts" if sys.platform == "win32" else "bin"
            exe_name = "python.exe" if sys.platform == "win32" else "python3"
            managed = root / "python-env"
            venv = root / "active-venv"
            conda = root / "active-conda"
            path_dir = root / "path-bin"
            managed_py = _make_fake_python(managed / bin_sub / exe_name)
            venv_py = _make_fake_python(venv / bin_sub / exe_name)
            conda_py = _make_fake_python(conda / bin_sub / exe_name)
            path_py = _make_fake_python(path_dir / exe_name)

            with patch("python_runtime.bundled_available", return_value=True):
                self.assertEqual(python_runtime.default_python(managed), python_runtime.BUNDLED)

            with (
                patch("python_runtime.bundled_available", return_value=False),
                patch.dict(os.environ, {"VIRTUAL_ENV": str(venv), "CONDA_PREFIX": str(conda)}, clear=False),
            ):
                self.assertEqual(python_runtime.default_python(managed), os.path.abspath(managed_py))

            managed_py.unlink()
            with (
                patch("python_runtime.bundled_available", return_value=False),
                patch.dict(os.environ, {"VIRTUAL_ENV": str(venv), "CONDA_PREFIX": str(conda)}, clear=False),
            ):
                self.assertEqual(python_runtime.default_python(managed), os.path.abspath(venv_py))

            with (
                patch("python_runtime.bundled_available", return_value=False),
                patch.dict(os.environ, {"VIRTUAL_ENV": "", "CONDA_PREFIX": str(conda)}, clear=False),
            ):
                self.assertEqual(python_runtime.default_python(managed), os.path.abspath(conda_py))

            with (
                patch("python_runtime.bundled_available", return_value=False),
                patch("python_runtime.frozen", return_value=False),
                patch.dict(os.environ, {"VIRTUAL_ENV": "", "CONDA_PREFIX": ""}, clear=False),
            ):
                self.assertEqual(python_runtime.default_python(managed), os.path.abspath(sys.executable))

            with (
                patch("python_runtime.bundled_available", return_value=False),
                patch("python_runtime.frozen", return_value=True),
                patch.dict(os.environ, {"VIRTUAL_ENV": "", "CONDA_PREFIX": ""}, clear=False),
                patch("python_runtime.shutil.which", side_effect=lambda name: str(path_py) if name == "python3" else None),
            ):
                self.assertEqual(python_runtime.default_python(managed), os.path.abspath(path_py))

            with (
                patch("python_runtime.bundled_available", return_value=False),
                patch("python_runtime.frozen", return_value=True),
                patch.dict(os.environ, {"VIRTUAL_ENV": "", "CONDA_PREFIX": ""}, clear=False),
                patch("python_runtime.shutil.which", return_value=None),
            ):
                self.assertEqual(python_runtime.default_python(managed), "")

    def test_concurrent_discover_and_preferred_coalesce_matching_inflight_scans(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            managed = root / "python-env"
            fake_py = _make_fake_python(root / "venv" / ("Scripts/python.exe" if os.name == "nt" else "bin/python3"))
            started = threading.Event()
            release = threading.Event()
            calls = 0
            lock = threading.Lock()

            def slow_probe(executable: str, timeout: float = 6) -> dict:
                nonlocal calls
                with lock:
                    calls += 1
                started.set()
                release.wait(5)
                return {
                    "version": "3.12.0",
                    "prefix": str(fake_py.parent.parent),
                    "venv": True,
                    "matplotlib": True,
                    "numpy": True,
                    "venvModule": True,
                }

            with (
                patch("python_runtime.bundled_available", return_value=False),
                patch("python_runtime.candidates", return_value=[fake_py]),
                patch("python_runtime.probe", side_effect=slow_probe),
            ):
                with ThreadPoolExecutor(max_workers=3) as pool:
                    first = pool.submit(python_runtime.discover, managed, [])
                    self.assertTrue(started.wait(2))
                    second = pool.submit(python_runtime.discover, managed, ())
                    third = pool.submit(python_runtime.preferred, managed)
                    threading.Event().wait(0.05)
                    release.set()
                    res_first = first.result(timeout=5)
                    res_second = second.result(timeout=5)
                    res_preferred = third.result(timeout=5)

                self.assertEqual(calls, 1)
                self.assertEqual(res_first, res_second)
                self.assertIsNot(res_first, res_second)
                self.assertIsNot(res_first[0], res_second[0])
                self.assertEqual(res_preferred, str(fake_py))

                rescan = python_runtime.discover(managed)
                self.assertEqual(calls, 2)
                self.assertEqual(rescan[0]["path"], str(fake_py))

    def test_preserves_ordinary_results_and_reports_os_stderr_on_abrupt_exit(self):
        ok_res = python_runtime.run(
            sys.executable,
            "import sys\nprint('alpha')\nsys.stderr.write('warn-line\\n')",
        )
        self.assertTrue(ok_res["ok"])
        self.assertEqual(ok_res["stdout"], "alpha\n")
        self.assertEqual(ok_res["stderr"], "warn-line\n")
        self.assertEqual(ok_res["images"], [])

        with self.assertRaisesRegex(ValueError, "abrupt native failure"):
            python_runtime.run(
                sys.executable,
                "import os\nos.write(2, b'abrupt native failure\\n')\nos._exit(3)",
            )

    def test_owned_descendant_retaining_output_streams_cannot_keep_cell_busy(self):
        with tempfile.TemporaryDirectory() as folder:
            pid_file = Path(folder) / "descendant.pid"
            code = f"""
import pathlib, subprocess, sys
child = subprocess.Popen([
    sys.executable,
    "-c",
    "import sys, time; sys.stdout.write('child-out\\\\n'); sys.stderr.write('child-err\\\\n'); "
    "sys.stdout.flush(); sys.stderr.flush(); time.sleep(30)",
])
pathlib.Path({str(pid_file)!r}).write_text(str(child.pid), encoding="utf-8")
print("ordinary cell value:", 6 * 7)
"""
            started = time.monotonic()
            result = python_runtime.run(sys.executable, code, timeout=10, cwd=folder)
            elapsed = time.monotonic() - started
            descendant_pid = int(pid_file.read_text(encoding="utf-8").strip())
            self.addCleanup(_best_effort_kill, descendant_pid)

            self.assertLess(elapsed, 4.0, f"cell stayed busy for {elapsed:.2f}s waiting on descendant streams")
            self.assertTrue(result["ok"])
            self.assertEqual(result["stdout"], "ordinary cell value: 42\n")
            self.assertEqual(result["stderr"], "")
            self.assertTrue(_wait_pid_exit(descendant_pid, timeout=2.0))

    @unittest.skipUnless(os.name == "posix", "POSIX SIGTERM-ignoring descendant check")
    def test_sigterm_ignoring_descendant_retaining_streams_still_returns_promptly(self):
        with tempfile.TemporaryDirectory() as folder:
            pid_file = Path(folder) / " stubborn.pid".replace(" ", "")
            ready_file = Path(folder) / "ready.txt"
            code = f"""
import pathlib, subprocess, sys, time
child = subprocess.Popen([
    sys.executable,
    "-c",
    "import pathlib, signal, sys, time; "
    "signal.signal(signal.SIGTERM, signal.SIG_IGN); "
    f"pathlib.Path({str(ready_file)!r}).write_text('1', encoding='utf-8'); "
    "sys.stdout.write('held\\\\n'); sys.stdout.flush(); time.sleep(30)",
])
pathlib.Path({str(pid_file)!r}).write_text(str(child.pid), encoding="utf-8")
deadline = time.monotonic() + 3
while not pathlib.Path({str(ready_file)!r}).exists() and time.monotonic() < deadline:
    time.sleep(0.01)
print("preserved output")
"""
            started = time.monotonic()
            result = python_runtime.run(sys.executable, code, timeout=10, cwd=folder)
            elapsed = time.monotonic() - started
            stubborn_pid = int(pid_file.read_text(encoding="utf-8").strip())
            self.addCleanup(_best_effort_kill, stubborn_pid)

            self.assertLess(elapsed, 4.0)
            self.assertTrue(result["ok"])
            self.assertEqual(result["stdout"], "preserved output\n")
            self.assertTrue(_wait_pid_exit(stubborn_pid, timeout=2.0))

    def test_timeout_cleanup_is_confined_to_timed_out_cell_process_tree(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            child_pid_file = root / "timed-out-child.pid"
            grandchild_pid_file = root / "timed-out-grandchild.pid"
            ready_file = root / "tree-ready.txt"
            other_started = root / "other-started.txt"

            timed_out_code = f"""
import pathlib, subprocess, sys
script = (
    "import pathlib, subprocess, sys, time\\n"
    "gc = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(30)'])\\n"
    f"pathlib.Path({str(grandchild_pid_file)!r}).write_text(str(gc.pid), encoding='utf-8')\\n"
    f"pathlib.Path({str(ready_file)!r}).write_text('ready', encoding='utf-8')\\n"
    "gc.wait()\\n"
)
child = subprocess.Popen([sys.executable, "-c", script])
pathlib.Path({str(child_pid_file)!r}).write_text(str(child.pid), encoding="utf-8")
child.wait()
"""
            other_code = f"""
import pathlib, time
pathlib.Path({str(other_started)!r}).write_text("running", encoding="utf-8")
time.sleep(1.2)
print("unrelated cell survived")
"""
            with ThreadPoolExecutor(max_workers=2) as pool:
                slow_future = pool.submit(python_runtime.run, sys.executable, timed_out_code, 0.7, str(root))
                other_future = pool.submit(python_runtime.run, sys.executable, other_code, 10, str(root))

                deadline = time.monotonic() + 4
                while (not ready_file.exists() or not other_started.exists()) and time.monotonic() < deadline:
                    time.sleep(0.01)

                with self.assertRaisesRegex(ValueError, "Python cell stopped after 0.7 seconds"):
                    slow_future.result(timeout=6)

                child_pid = int(child_pid_file.read_text(encoding="utf-8").strip())
                grandchild_pid = int(grandchild_pid_file.read_text(encoding="utf-8").strip())
                self.addCleanup(_best_effort_kill, child_pid)
                self.addCleanup(_best_effort_kill, grandchild_pid)

                self.assertTrue(_wait_pid_exit(child_pid, timeout=2.0))
                self.assertTrue(_wait_pid_exit(grandchild_pid, timeout=2.0))

                other_result = other_future.result(timeout=6)
                self.assertTrue(other_result["ok"])
                self.assertEqual(other_result["stdout"], "unrelated cell survived\n")

    def test_job_registry_confines_tab_and_window_cancellation(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            win1_jobs = python_runtime.PythonJobRegistry()
            win2_jobs = python_runtime.PythonJobRegistry()
            job_tab_a = win1_jobs.register("tab-a")
            job_tab_b = win1_jobs.register("tab-b")
            job_win2 = win2_jobs.register("tab-a")

            marker_a = root / "a.pid"
            marker_b = root / "b.ready"
            marker_w2 = root / "w2.ready"
            release_b = root / "b.release"
            release_w2 = root / "w2.release"

            code_a = f"""
import pathlib, subprocess, sys
child = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(30)"])
pathlib.Path({str(marker_a)!r}).write_text(str(child.pid), encoding="utf-8")
child.wait()
"""
            code_b = f"""
import pathlib, time
pathlib.Path({str(marker_b)!r}).write_text("1", encoding="utf-8")
deadline = time.monotonic() + 8
while not pathlib.Path({str(release_b)!r}).exists() and time.monotonic() < deadline:
    time.sleep(0.02)
print("window 1 tab b finished")
"""
            code_w2 = f"""
import pathlib, time
pathlib.Path({str(marker_w2)!r}).write_text("1", encoding="utf-8")
deadline = time.monotonic() + 8
while not pathlib.Path({str(release_w2)!r}).exists() and time.monotonic() < deadline:
    time.sleep(0.02)
print("window 2 tab a finished")
"""
            with ThreadPoolExecutor(max_workers=3) as pool:
                fut_a = pool.submit(python_runtime.run, sys.executable, code_a, 15, str(root), job=job_tab_a)
                fut_b = pool.submit(python_runtime.run, sys.executable, code_b, 15, str(root), job=job_tab_b)
                fut_w2 = pool.submit(python_runtime.run, sys.executable, code_w2, 15, str(root), job=job_win2)

                deadline = time.monotonic() + 5
                while not (marker_a.exists() and marker_b.exists() and marker_w2.exists()) and time.monotonic() < deadline:
                    time.sleep(0.01)

                pid_a = int(marker_a.read_text(encoding="utf-8").strip())
                self.addCleanup(_best_effort_kill, pid_a)

                self.assertEqual(win1_jobs.cancel_tab("tab-a"), 1)
                with self.assertRaises(python_runtime.PythonCellCancelled):
                    fut_a.result(timeout=4)
                self.assertTrue(_wait_pid_exit(pid_a, timeout=2.0))
                self.assertFalse(job_tab_b.cancelled.is_set())
                self.assertFalse(job_win2.cancelled.is_set())

                release_b.write_text("go", encoding="utf-8")
                res_b = fut_b.result(timeout=4)
                self.assertEqual(res_b["stdout"], "window 1 tab b finished\n")
                win1_jobs.discard(job_tab_a)
                win1_jobs.discard(job_tab_b)

                self.assertEqual(win1_jobs.cancel_all(retire=True), 0)
                self.assertFalse(job_win2.cancelled.is_set())
                release_w2.write_text("go", encoding="utf-8")
                res_w2 = fut_w2.result(timeout=4)
                self.assertEqual(res_w2["stdout"], "window 2 tab a finished\n")
                win2_jobs.discard(job_win2)

    def test_posix_platform_backend_guards_own_pgid_and_isolates_target_group(self):
        self.assertEqual(python_runtime._cell_spawn_kwargs("posix"), {"start_new_session": True})
        self.assertFalse(python_runtime._posix_safe_pgid(None, own_pgid=500))
        self.assertFalse(python_runtime._posix_safe_pgid(0, own_pgid=500))
        self.assertFalse(python_runtime._posix_safe_pgid(1, own_pgid=500))
        self.assertFalse(python_runtime._posix_safe_pgid(500, own_pgid=500))
        self.assertTrue(python_runtime._posix_safe_pgid(901, own_pgid=500))

        signals_sent: list[tuple[int, int]] = []
        alive_groups = {901, 902}

        class FakeProc:
            def __init__(self, pid: int, ignore_term: bool = False):
                self.pid = pid
                self.ignore_term = ignore_term
                self.running = True
                self.terminated = 0
                self.killed = 0

            def poll(self):
                return None if self.running else 0

            def terminate(self):
                self.terminated += 1
                if not self.ignore_term:
                    self.running = False

            def kill(self):
                self.killed += 1
                self.running = False

            def wait(self, timeout=None):
                self.running = False
                return 0

        proc1 = FakeProc(901, ignore_term=True)
        proc2 = FakeProc(902)

        def fake_killpg(pgid: int, sig: int):
            if pgid not in alive_groups:
                raise ProcessLookupError(pgid)
            if sig == 0:
                return
            signals_sent.append((pgid, sig))
            if sig == getattr(signal, "SIGKILL", 9):
                alive_groups.discard(pgid)
                if pgid == 901:
                    proc1.running = False

        python_runtime._terminate_posix_cell(proc1, 901, grace=0.03, killpg_fn=fake_killpg, own_pgid=500)
        self.assertEqual(
            signals_sent,
            [(901, getattr(signal, "SIGTERM", 15)), (901, getattr(signal, "SIGKILL", 9))],
        )
        self.assertIn(902, alive_groups)
        self.assertTrue(proc2.running)

        # Unsafe pgid matching own_pgid must never invoke killpg; falls back to direct process only.
        signals_sent.clear()
        unsafe_proc = FakeProc(500)
        python_runtime._terminate_posix_cell(unsafe_proc, 500, grace=0.01, killpg_fn=fake_killpg, own_pgid=500)
        self.assertEqual(signals_sent, [])
        self.assertEqual(unsafe_proc.terminated, 1)

    def test_windows_platform_job_object_and_taskkill_fallback_isolate_target_cell(self):
        expected_flags = getattr(subprocess, "CREATE_NO_WINDOW", 0x08000000) | getattr(
            subprocess, "CREATE_NEW_PROCESS_GROUP", 0x00000200
        )
        self.assertEqual(python_runtime._cell_spawn_kwargs("nt"), {"creationflags": expected_flags})

        class FakeKernel32:
            def __init__(self, fail_assign: bool = False):
                self.next_handle = 1000
                self.fail_assign = fail_assign
                self.created: list[int] = []
                self.limit_flags: dict[int, int] = {}
                self.assigned: dict[int, int] = {}
                self.terminated: list[tuple[int, int]] = []
                self.closed: list[int] = []

            def CreateJobObjectW(self, attrs, name):
                self.next_handle += 1
                self.created.append(self.next_handle)
                return self.next_handle

            def SetInformationJobObject(self, handle, info_class, info_ptr, size):
                self.assert_info_size = size
                info = ctypes.cast(
                    info_ptr, ctypes.POINTER(python_runtime._JobObjectExtendedLimitInformation)
                ).contents
                self.limit_flags[int(handle.value)] = int(info.BasicLimitInformation.LimitFlags)
                return 1 if info_class == 9 else 0

            def AssignProcessToJobObject(self, job_handle, proc_handle):
                if self.fail_assign:
                    return 0
                self.assigned[int(job_handle.value)] = int(proc_handle.value)
                return 1

            def TerminateJobObject(self, job_handle, exit_code):
                self.terminated.append((int(job_handle.value), int(exit_code)))
                return 1

            def CloseHandle(self, handle):
                self.closed.append(int(handle.value))
                return 1

        class FakeWinProc:
            def __init__(self, pid: int, handle: int, running: bool = True):
                self.pid = pid
                self._handle = handle
                self.running = running
                self.killed = 0

            def poll(self):
                return None if self.running else 0

            def kill(self):
                self.killed += 1
                self.running = False

            def wait(self, timeout=None):
                self.running = False
                return 0

        api = FakeKernel32()
        win1_job = python_runtime._WindowsJob.create(kernel32=api)
        win2_job = python_runtime._WindowsJob.create(kernel32=api)
        self.assertIsNotNone(win1_job)
        self.assertIsNotNone(win2_job)
        proc1 = FakeWinProc(4100, 0xABCD01)
        proc2 = FakeWinProc(4200, 0xABCD02)
        self.assertTrue(win1_job.assign(proc1))
        self.assertTrue(win2_job.assign(proc2))
        self.assertEqual(api.limit_flags[1001], python_runtime._JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE)
        self.assertEqual(api.assigned, {1001: 0xABCD01, 1002: 0xABCD02})

        ctrl1 = python_runtime._CellProcessController(proc1, os_name="nt", win_job=win1_job)
        ctrl2 = python_runtime._CellProcessController(proc2, os_name="nt", win_job=win2_job)
        ctrl1.terminate()
        ctrl1.cleanup()  # Idempotent: must not double-close handle 1001.

        self.assertEqual(api.terminated, [(1001, 1)])
        self.assertEqual(api.closed, [1001])
        self.assertNotIn(1002, [h for h, _ in api.terminated])
        self.assertTrue(proc2.running)
        ctrl2.cleanup()

        # Fallback path when nested Job Object assignment fails: closes job handle and uses taskkill only on live PID.
        fallback_api = FakeKernel32(fail_assign=True)
        failed_job = python_runtime._WindowsJob.create(kernel32=fallback_api)
        proc_fallback = FakeWinProc(5100, 0xDEAD01, running=True)
        self.assertFalse(failed_job.assign(proc_fallback))
        self.assertEqual(fallback_api.closed, [1001])

        commands: list[list[str]] = []

        def fake_run(cmd, **_kwargs):
            commands.append(cmd)
            proc_fallback.running = False

        python_runtime._terminate_windows_cell(proc_fallback, None, run_cmd=fake_run)
        self.assertEqual(commands, [["taskkill", "/F", "/T", "/PID", "5100"]])

        # Already-exited process must never invoke taskkill on a potentially recycled PID.
        commands.clear()
        exited_proc = FakeWinProc(5200, 0xDEAD02, running=False)
        python_runtime._terminate_windows_cell(exited_proc, None, run_cmd=fake_run)
        self.assertEqual(commands, [])

    def test_package_setup_remains_separate_from_cell_job_registry(self):
        with tempfile.TemporaryDirectory() as folder:
            managed = Path(folder) / "python-env"
            fake_base = _make_fake_python(Path(folder) / "base" / ("python.exe" if os.name == "nt" else "python3"))
            fake_env_py = managed / ("Scripts/python.exe" if sys.platform == "win32" else "bin/python3")
            calls: list[list[str]] = []

            def fake_subprocess_run(cmd, *args, **kwargs):
                calls.append(list(cmd))
                if "-m" in cmd and "venv" in cmd:
                    _make_fake_python(fake_env_py)
                return subprocess.CompletedProcess(cmd, 0, stdout="", stderr="")

            with (
                patch(
                    "python_runtime.discover",
                    return_value=[{"path": str(fake_base), "managed": False, "venvModule": True, "matplotlib": False}],
                ),
                patch("python_runtime.subprocess.run", side_effect=fake_subprocess_run),
                patch("python_runtime._spawn_cell_process", side_effect=AssertionError("setup must stay separate from cell runner")),
            ):
                created = python_runtime.setup_environment(managed)
            self.assertEqual(created, str(fake_env_py))
            self.assertEqual(len(calls), 2)


if __name__ == "__main__":
    unittest.main()
