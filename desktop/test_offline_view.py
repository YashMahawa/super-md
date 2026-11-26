"""Process containment, artifact preservation, and multi-window isolation tests for Desktop offline preview helpers."""
from __future__ import annotations

import ast
import base64
import ctypes
import hashlib
import json
import os
import signal
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent))
os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

from PySide6.QtCore import QByteArray, QBuffer, QIODevice, QObject, Signal
from PySide6.QtGui import QColor, QImage
from PySide6.QtWidgets import QApplication

from agent_documents import DocumentStore
from core import process_tree
from folder_ops import same_path
import offline_view
import python_runtime
from studio import Session, Studio


def _sample_png_bytes(width: int = 64, height: int = 48) -> bytes:
    image = QImage(width, height, QImage.Format.Format_RGBA8888)
    image.fill(QColor("#1688dd"))
    encoded = QByteArray()
    buf = QBuffer(encoded)
    buf.open(QIODevice.OpenModeFlag.WriteOnly)
    image.save(buf, "PNG")
    return bytes(encoded)


def _pid_alive(pid: int) -> bool:
    if pid <= 0:
        return False
    if os.name == "nt":
        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel32.OpenProcess.argtypes = [ctypes.c_uint32, ctypes.c_int, ctypes.c_uint32]
        kernel32.OpenProcess.restype = ctypes.c_void_p
        kernel32.GetExitCodeProcess.argtypes = [ctypes.c_void_p, ctypes.POINTER(ctypes.c_uint32)]
        kernel32.GetExitCodeProcess.restype = ctypes.c_int
        kernel32.CloseHandle.argtypes = [ctypes.c_void_p]
        kernel32.CloseHandle.restype = ctypes.c_int
        handle = kernel32.OpenProcess(0x1000, 0, pid)
        if not handle:
            return False
        try:
            code = ctypes.c_uint32(0)
            if not kernel32.GetExitCodeProcess(ctypes.c_void_p(handle), ctypes.byref(code)):
                return False
            return code.value == 259  # STILL_ACTIVE
        finally:
            kernel32.CloseHandle(ctypes.c_void_p(handle))
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    try:
        waited, _ = os.waitpid(pid, os.WNOHANG)
        if waited == pid:
            return False
    except ChildProcessError:
        pass
    if sys.platform.startswith("linux"):
        try:
            stat_text = Path(f"/proc/{pid}/stat").read_text(encoding="utf-8")
            state = stat_text.rsplit(")", 1)[1].split()[0]
            if state == "Z":
                return False
        except OSError:
            return False
    return True


def _best_effort_kill(pid: int) -> None:
    if pid <= 0:
        return
    if os.name == "nt":
        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel32.OpenProcess.argtypes = [ctypes.c_uint32, ctypes.c_int, ctypes.c_uint32]
        kernel32.OpenProcess.restype = ctypes.c_void_p
        kernel32.TerminateProcess.argtypes = [ctypes.c_void_p, ctypes.c_uint32]
        kernel32.TerminateProcess.restype = ctypes.c_int
        kernel32.CloseHandle.argtypes = [ctypes.c_void_p]
        kernel32.CloseHandle.restype = ctypes.c_int
        handle = kernel32.OpenProcess(0x0001, 0, pid)
        if handle:
            try:
                kernel32.TerminateProcess(ctypes.c_void_p(handle), 1)
            finally:
                kernel32.CloseHandle(ctypes.c_void_p(handle))
        return
    try:
        os.kill(pid, signal.SIGKILL)
    except OSError:
        pass


def _read_nonempty(path: Path) -> str | None:
    try:
        text = path.read_text(encoding="utf-8").strip()
    except OSError:
        return None
    return text or None


def _await_file(path: Path, timeout: float = 20.0) -> str:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        value = _read_nonempty(path)
        if value is not None:
            return value
        time.sleep(0.02)
    raise AssertionError(f"Timed out waiting for marker file {path}")


def _wait_until(predicate, timeout: float = 20.0, *, pump_app: QApplication | None = None) -> bool:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if pump_app is not None:
            pump_app.processEvents()
        if predicate():
            return True
        time.sleep(0.02)
    if pump_app is not None:
        pump_app.processEvents()
    return bool(predicate())


class _RecordingBridge(QObject):
    enabledChanged = Signal()
    cloudStatusChanged = Signal()

    def __init__(self):
        super().__init__()
        self.lock = threading.Lock()
        self.completions: dict[str, tuple[object, str, str]] = {}

    def complete(self, request_id: str, result: object, error: str = "", *, window_id: str = "") -> None:
        with self.lock:
            self.completions[request_id] = (result, error, window_id)

    def get(self, request_id: str):
        with self.lock:
            return self.completions.get(request_id)


def _write_fake_agent_cli(script_path: Path) -> None:
    """Create a deterministic cross-platform CLI helper speaking agent_cli.py preview args."""
    script_path.write_text(
        """import json, os, subprocess, sys, time
from pathlib import Path

args = sys.argv[1:]
idx = args.index("preview")
source = Path(args[idx + 1])
output = Path(args[idx + 2])
snapshot_path = None
if "--snapshot" in args:
    snapshot_path = Path(args[args.index("--snapshot") + 1])

content = source.read_text(encoding="utf-8") if source.is_file() else ""
if snapshot_path is not None and snapshot_path.is_file():
    content = json.loads(snapshot_path.read_text(encoding="utf-8")).get("content", content)

spec = {}
for line in content.splitlines():
    if line.startswith("SPEC:"):
        spec = json.loads(line[5:])
        break

mode = spec.get("mode", "ok")
png_b64 = spec.get("png_b64", "")
helper_pid_file = spec.get("helper_pid_file")
child_pid_file = spec.get("child_pid_file")
release_file = spec.get("release_file")
retain_streams = bool(spec.get("retain_streams", False))

if helper_pid_file:
    Path(helper_pid_file).write_text(str(os.getpid()), encoding="utf-8")

child = None
if child_pid_file:
    kwargs = {"stdin": subprocess.DEVNULL}
    if not retain_streams:
        kwargs["stdout"] = subprocess.DEVNULL
        kwargs["stderr"] = subprocess.DEVNULL
    child = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(60)"], **kwargs)
    Path(child_pid_file).write_text(str(child.pid), encoding="utf-8")

if spec.get("mutate_source"):
    source.write_text(content + "\\nmutated\\n", encoding="utf-8")

if release_file:
    release_path = Path(release_file)
    deadline = time.monotonic() + float(spec.get("sleep", 30))
    while not release_path.exists() and time.monotonic() < deadline:
        time.sleep(0.02)
elif mode == "sleep":
    time.sleep(float(spec.get("sleep", 60)))
elif mode == "json_error":
    sys.stdout.write(json.dumps({"ok": False, "error": {"code": "preview_error", "message": spec.get("message", "Structured preview failure")}}) + "\\n")
    sys.stdout.flush()
    sys.exit(1)
elif mode == "stderr_crash":
    sys.stderr.write(spec.get("stderr", "Fatal QtWebEngine helper crash\\n"))
    sys.stderr.flush()
    sys.exit(134)

if png_b64:
    import base64
    output.write_bytes(base64.b64decode(png_b64))
sys.stdout.write(json.dumps({"ok": True, "result": {"output": str(output)}}) + "\\n")
sys.stdout.flush()
""",
        encoding="utf-8",
    )


class OfflinePreviewContainmentTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.app = QApplication.instance() or QApplication([])
        cls.png_b64 = base64.b64encode(_sample_png_bytes()).decode("ascii")

    def setUp(self):
        self.spawned_pids: list[int] = []
        self.unrelated_procs: list[subprocess.Popen] = []

    def tearDown(self):
        for proc in self.unrelated_procs:
            try:
                proc.kill()
                proc.wait(timeout=2)
            except Exception:
                pass
        for pid in self.spawned_pids:
            _best_effort_kill(pid)

    def _start_unrelated_process(self) -> subprocess.Popen:
        kwargs = {"start_new_session": True} if os.name != "nt" else {
            "creationflags": getattr(subprocess, "CREATE_NO_WINDOW", 0x08000000)
            | getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0x00000200)
        }
        proc = subprocess.Popen(
            [sys.executable, "-c", "import time; time.sleep(60)"],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            **kwargs,
        )
        self.unrelated_procs.append(proc)
        return proc

    def test_offline_view_keeps_separate_ownership_from_python_runtime_and_package_setup(self):
        self.assertFalse(hasattr(offline_view, "PythonJobRegistry"))
        self.assertTrue(hasattr(offline_view, "PreviewJobRegistry"))
        self.assertFalse(hasattr(python_runtime, "PreviewJobRegistry"))
        self.assertIsNot(offline_view.PreviewJobRegistry, python_runtime.PythonJobRegistry)
        self.assertIsNot(offline_view.PreviewCancelled, python_runtime.PythonCellCancelled)

        # Both modules share the core.process_tree platform containment primitive without copying
        # Windows API loaders, NtResumeProcess wrappers, or Job Object lifecycle classes.
        self.assertTrue(issubclass(offline_view._PreviewProcessController, process_tree.OwnedProcessTree))
        self.assertTrue(issubclass(python_runtime._CellProcessController, process_tree.OwnedProcessTree))
        self.assertIs(python_runtime._WindowsJob, process_tree.WindowsJob)
        self.assertIs(offline_view._preview_spawn_kwargs, process_tree.contained_spawn_kwargs)
        self.assertIs(python_runtime._cell_spawn_kwargs, process_tree.contained_spawn_kwargs)

        forbidden_defs = {
            "_load_kernel32",
            "_load_ntdll",
            "_resume_windows_process",
            "_WindowsJob",
            "_JobObjectBasicLimitInformation",
            "_JobObjectExtendedLimitInformation",
        }
        for mod in (offline_view, python_runtime):
            tree = ast.parse(Path(mod.__file__).read_text(encoding="utf-8"), filename=mod.__file__)
            defined = {
                node.name
                for node in tree.body
                if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef))
            }
            self.assertEqual(defined & forbidden_defs, set(), f"{mod.__name__} duplicated {defined & forbidden_defs}")

    def test_preserves_artifacts_revision_checks_and_useful_stdout_or_stderr_errors(self):
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as folder:
            root = Path(folder)
            fake_cli = root / "fake_agent_cli.py"
            _write_fake_agent_cli(fake_cli)
            store = DocumentStore([folder])

            with mock.patch.object(offline_view, "_agent_cli_command", return_value=[sys.executable, str(fake_cli)]):
                # 1. Successful offline preview + descendant retaining stdout/stderr streams does not hang,
                #    and lingering preview helper descendants are reaped on completion.
                child_marker = root / "stream_child.pid"
                ok_note = root / "ok.md"
                ok_spec = {"mode": "ok", "png_b64": self.png_b64, "child_pid_file": str(child_marker), "retain_streams": True}
                ok_note.write_text("# Preview\nSPEC:" + json.dumps(ok_spec) + "\n", encoding="utf-8")
                expected_rev = hashlib.sha256(ok_note.read_bytes()).hexdigest()

                started = time.monotonic()
                artifact = offline_view.render_offline(store, str(ok_note), width=800, expected_revision=expected_rev, timeout=10)
                elapsed = time.monotonic() - started
                self.assertLess(elapsed, 8.0)
                self.assertTrue(artifact.startswith(b"\x89PNG\r\n\x1a\n"))
                decoded = QImage.fromData(artifact, "PNG")
                self.assertEqual((decoded.width(), decoded.height()), (64, 48))

                stream_child_pid = int(_await_file(child_marker))
                self.spawned_pids.append(stream_child_pid)
                self.assertTrue(_wait_until(lambda: not _pid_alive(stream_child_pid), timeout=5.0))

                # 2. Revision conflict before helper launch.
                with self.assertRaisesRegex(ValueError, "Revision conflict"):
                    offline_view.render_offline(store, str(ok_note), expected_revision="0" * 64)

                # 3. Source mutation during render is rejected.
                mut_note = root / "mut.md"
                mut_note.write_text("# Mut\nSPEC:" + json.dumps({"mode": "ok", "png_b64": self.png_b64, "mutate_source": True}) + "\n", encoding="utf-8")
                with self.assertRaisesRegex(ValueError, "The source changed while rendering; retry"):
                    offline_view.render_offline(store, str(mut_note), timeout=10)

                # 4. Structured JSON error from agent_cli stdout is preserved clearly.
                err_note = root / "json_err.md"
                err_note.write_text("# Err\nSPEC:" + json.dumps({"mode": "json_error", "message": "Heading 'Missing' was not found"}) + "\n", encoding="utf-8")
                with self.assertRaisesRegex(ValueError, "Offline reader preview failed: Heading 'Missing' was not found"):
                    offline_view.render_offline(store, str(err_note), timeout=10)

                # 5. Raw crash diagnostics on stderr (with empty stdout) are preserved.
                crash_spec = "# Crash\nSPEC:" + json.dumps({"mode": "stderr_crash", "stderr": "Fatal QtWebEngineProcess Zygote error: missing sandbox"})
                with self.assertRaisesRegex(ValueError, "Background preview failed: .*Fatal QtWebEngineProcess Zygote error"):
                    offline_view.render_live_snapshot(crash_spec, {}, "", width=900, timeout=10)

    def test_preview_timeout_cleans_helper_process_tree_without_affecting_sibling_or_unrelated_processes(self):
        unrelated = self._start_unrelated_process()
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as folder:
            root = Path(folder)
            fake_cli = root / "fake_agent_cli.py"
            _write_fake_agent_cli(fake_cli)

            timed_helper = root / "timed_helper.pid"
            timed_child = root / "timed_child.pid"
            sibling_helper = root / "sibling_helper.pid"
            sibling_child = root / "sibling_child.pid"
            sibling_release = root / "sibling_release.txt"

            timed_content = "SPEC:" + json.dumps({
                "mode": "sleep",
                "sleep": 60,
                "helper_pid_file": str(timed_helper),
                "child_pid_file": str(timed_child),
                "retain_streams": True,
            })
            sibling_content = "SPEC:" + json.dumps({
                "png_b64": self.png_b64,
                "helper_pid_file": str(sibling_helper),
                "child_pid_file": str(sibling_child),
                "release_file": str(sibling_release),
            })

            sibling_result: dict[str, object] = {}

            def run_sibling():
                try:
                    sibling_result["bytes"] = offline_view.render_live_snapshot(
                        sibling_content, {}, "", width=800, timeout=25
                    )
                except Exception as exc:  # pragma: no cover
                    sibling_result["error"] = exc

            with mock.patch.object(offline_view, "_agent_cli_command", return_value=[sys.executable, str(fake_cli)]):
                sibling_thread = threading.Thread(target=run_sibling, daemon=True)
                sibling_thread.start()
                sib_pid = int(_await_file(sibling_helper))
                sib_child_pid = int(_await_file(sibling_child))
                self.spawned_pids.extend([sib_pid, sib_child_pid])
                self.assertTrue(_pid_alive(sib_pid))
                self.assertTrue(_pid_alive(sib_child_pid))

                with self.assertRaisesRegex(ValueError, "Background preview timed out after 1.5 seconds"):
                    offline_view.render_live_snapshot(timed_content, {}, "", width=800, timeout=1.5)

                t_pid = int(_await_file(timed_helper))
                t_child_pid = int(_await_file(timed_child))
                self.spawned_pids.extend([t_pid, t_child_pid])

                # Timed-out helper AND its descendant process must both be terminated,
                # while the sibling preview tree and unrelated subprocess stay alive.
                self.assertTrue(_wait_until(lambda: not _pid_alive(t_pid) and not _pid_alive(t_child_pid), timeout=8.0))
                self.assertTrue(_pid_alive(sib_pid))
                self.assertTrue(_pid_alive(sib_child_pid))
                self.assertIsNone(unrelated.poll())

                # Concurrent sibling preview completes with its PNG artifact intact once released.
                sibling_release.write_text("done", encoding="utf-8")
                sibling_thread.join(timeout=20)
                self.assertNotIn("error", sibling_result)
                self.assertTrue(isinstance(sibling_result.get("bytes"), bytes) and sibling_result["bytes"].startswith(b"\x89PNG\r\n\x1a\n"))
                self.assertTrue(_wait_until(lambda: not _pid_alive(sib_child_pid), timeout=8.0))
                self.assertIsNone(unrelated.poll())

    def test_studio_tab_and_window_close_cancel_only_owned_background_previews(self):
        unrelated = self._start_unrelated_process()
        with (
            tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as data_dir,
            tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as notes_dir,
            tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as alias_dir,
        ):
            previous_home = os.environ.get("SUPERMD_DATA_HOME")
            os.environ["SUPERMD_DATA_HOME"] = data_dir
            root = Path(notes_dir)
            open_root = root
            if os.name != "nt":
                candidate_alias = Path(alias_dir) / "raw-notes-link"
                try:
                    candidate_alias.symlink_to(root, target_is_directory=True)
                    open_root = candidate_alias
                except OSError:
                    open_root = root
            fake_cli = root / "fake_agent_cli.py"
            _write_fake_agent_cli(fake_cli)

            session = Session(isolated=True)
            bridge = _RecordingBridge()
            session.agent_bridge = bridge
            window1 = Studio(isolated=True, session=session)
            window2 = Studio(isolated=True, session=session)
            try:
                tab_a_helper = root / "tab_a_helper.pid"
                tab_a_child = root / "tab_a_child.pid"
                tab_b_helper = root / "tab_b_helper.pid"
                tab_b_release = root / "tab_b_release.txt"
                win2_helper = root / "win2_helper.pid"
                win2_child = root / "win2_child.pid"
                win2_release = root / "win2_release.txt"

                (root / "a.md").write_text(
                    "# A\nSPEC:" + json.dumps({
                        "mode": "sleep",
                        "sleep": 60,
                        "helper_pid_file": str(tab_a_helper),
                        "child_pid_file": str(tab_a_child),
                    }),
                    encoding="utf-8",
                )
                (root / "b.md").write_text(
                    "# B\nSPEC:" + json.dumps({
                        "png_b64": self.png_b64,
                        "helper_pid_file": str(tab_b_helper),
                        "release_file": str(tab_b_release),
                    }),
                    encoding="utf-8",
                )
                (root / "w2.md").write_text(
                    "# W2\nSPEC:" + json.dumps({
                        "png_b64": self.png_b64,
                        "helper_pid_file": str(win2_helper),
                        "child_pid_file": str(win2_child),
                        "release_file": str(win2_release),
                    }),
                    encoding="utf-8",
                )
                note_a = open_root / "a.md"
                note_b = open_root / "b.md"
                note_w2 = open_root / "w2.md"

                window1.openNote(str(note_a))
                window1.openNote(str(note_b))
                window2.openNote(str(note_w2))
                self.assertTrue(
                    _wait_until(
                        lambda: any(same_path(t.get("path", ""), note_a) for t in window1.tabs)
                        and any(same_path(t.get("path", ""), note_b) for t in window1.tabs)
                        and any(same_path(t.get("path", ""), note_w2) for t in window2.tabs),
                        pump_app=self.app,
                    )
                )
                tab_a = next(t for t in window1.tabs if same_path(t.get("path", ""), note_a))
                tab_b = next(t for t in window1.tabs if same_path(t.get("path", ""), note_b))
                tab_w2 = next(t for t in window2.tabs if same_path(t.get("path", ""), note_w2))

                window1.selectTab(tab_a["id"])
                window2.selectTab(tab_w2["id"])
                rev_a = window1._agent_viewport_revision(tab_a["id"])
                rev_w2 = window2._agent_viewport_revision(tab_w2["id"])

                with mock.patch.object(offline_view, "_agent_cli_command", return_value=[sys.executable, str(fake_cli)]):
                    window1._capture_background_preview("req-a", tab_a["id"], rev_a, {"revision": rev_a}, {"width": 800})
                    window2._capture_background_preview("req-w2", tab_w2["id"], rev_w2, {"revision": rev_w2}, {"width": 800})

                    pid_a = int(_await_file(tab_a_helper))
                    pid_a_child = int(_await_file(tab_a_child))
                    pid_w2 = int(_await_file(win2_helper))
                    pid_w2_child = int(_await_file(win2_child))
                    self.spawned_pids.extend([pid_a, pid_a_child, pid_w2, pid_w2_child])

                    # Both preview trees are live before closing tab_a.
                    self.assertTrue(_pid_alive(pid_a))
                    self.assertTrue(_pid_alive(pid_a_child))
                    self.assertTrue(_pid_alive(pid_w2))
                    self.assertTrue(_pid_alive(pid_w2_child))

                    # Closing tab_a in window1 returns promptly without blocking Qt, kills tab_a's helper tree,
                    # activates tab_b cleanly, and leaves window2 and unrelated subprocesses running cleanly.
                    close_started = time.monotonic()
                    window1.closeTab(tab_a["id"])
                    self.assertLess(time.monotonic() - close_started, 1.0)

                    self.assertTrue(
                        _wait_until(
                            lambda: not _pid_alive(pid_a)
                            and not _pid_alive(pid_a_child)
                            and bridge.get("req-a") is not None
                            and window1.active == tab_b["id"],
                            pump_app=self.app,
                        )
                    )
                    self.assertTrue(_pid_alive(pid_w2))
                    self.assertTrue(_pid_alive(pid_w2_child))
                    self.assertIsNone(unrelated.poll())

                    res_a, err_a, owner_a = bridge.get("req-a")
                    self.assertIsNone(res_a)
                    self.assertIn("cancelled", err_a.lower())
                    self.assertEqual(owner_a, window1.window_id)
                    self.assertEqual(window1.message, "")

                    # Remaining tab_b in window1 and concurrent tab_w2 in window2 complete with valid PNG artifacts.
                    rev_b = window1._agent_viewport_revision(tab_b["id"])
                    window1._capture_background_preview("req-b", tab_b["id"], rev_b, {"revision": rev_b}, {"width": 800})
                    pid_b = int(_await_file(tab_b_helper))
                    self.spawned_pids.append(pid_b)
                    self.assertTrue(_pid_alive(pid_b))

                    tab_b_release.write_text("done", encoding="utf-8")
                    win2_release.write_text("done", encoding="utf-8")

                    self.assertTrue(
                        _wait_until(
                            lambda: bridge.get("req-b") is not None and bridge.get("req-w2") is not None,
                            pump_app=self.app,
                        )
                    )
                    res_b, err_b, _ = bridge.get("req-b")
                    res_w2, err_w2, _ = bridge.get("req-w2")
                    self.assertEqual(err_b, "")
                    self.assertEqual(err_w2, "")
                    self.assertEqual(res_b["renderedFrom"], "background-preview")
                    self.assertEqual(res_w2["renderedFrom"], "background-preview")
                    self.assertEqual((res_b["width"], res_b["height"]), (64, 48))
                    self.assertEqual((res_w2["width"], res_w2["height"]), (64, 48))
                    self.assertTrue(_wait_until(lambda: not _pid_alive(pid_w2_child), timeout=8.0))
                    self.assertIsNone(unrelated.poll())

                    # Now start another long preview in window1 and another in window2, then close window1 via stop():
                    # window1's preview helper tree is terminated while window2 and unrelated subprocesses stay unaffected.
                    win1_close_helper = root / "win1_close_helper.pid"
                    win1_close_child = root / "win1_close_child.pid"
                    win2_keep_helper = root / "win2_keep_helper.pid"
                    win2_keep_child = root / "win2_keep_child.pid"
                    win2_keep_release = root / "win2_keep_release.txt"

                    tab_b["content"] = "# B2\nSPEC:" + json.dumps({
                        "mode": "sleep",
                        "sleep": 60,
                        "helper_pid_file": str(win1_close_helper),
                        "child_pid_file": str(win1_close_child),
                    })
                    tab_w2["content"] = "# W2-2\nSPEC:" + json.dumps({
                        "png_b64": self.png_b64,
                        "helper_pid_file": str(win2_keep_helper),
                        "child_pid_file": str(win2_keep_child),
                        "release_file": str(win2_keep_release),
                    })
                    rev_b2 = window1._agent_viewport_revision(tab_b["id"])
                    rev_w2_2 = window2._agent_viewport_revision(tab_w2["id"])

                    window1._capture_background_preview("req-b2", tab_b["id"], rev_b2, {"revision": rev_b2}, {"width": 800})
                    window2._capture_background_preview("req-w2-2", tab_w2["id"], rev_w2_2, {"revision": rev_w2_2}, {"width": 800})

                    pid_w1_close = int(_await_file(win1_close_helper))
                    pid_w1_close_child = int(_await_file(win1_close_child))
                    pid_w2_keep = int(_await_file(win2_keep_helper))
                    pid_w2_keep_child = int(_await_file(win2_keep_child))
                    self.spawned_pids.extend([pid_w1_close, pid_w1_close_child, pid_w2_keep, pid_w2_keep_child])

                    self.assertTrue(_pid_alive(pid_w1_close))
                    self.assertTrue(_pid_alive(pid_w1_close_child))
                    self.assertTrue(_pid_alive(pid_w2_keep))
                    self.assertTrue(_pid_alive(pid_w2_keep_child))

                    stop_started = time.monotonic()
                    window1.stop()
                    self.assertLess(time.monotonic() - stop_started, 1.0)

                    self.assertTrue(
                        _wait_until(
                            lambda: not _pid_alive(pid_w1_close) and not _pid_alive(pid_w1_close_child),
                            pump_app=self.app,
                        )
                    )
                    self.assertTrue(_pid_alive(pid_w2_keep))
                    self.assertTrue(_pid_alive(pid_w2_keep_child))
                    self.assertIsNone(unrelated.poll())

                    win2_keep_release.write_text("done", encoding="utf-8")
                    self.assertTrue(_wait_until(lambda: bridge.get("req-w2-2") is not None, pump_app=self.app))
                    res_w2_2, err_w2_2, _ = bridge.get("req-w2-2")
                    self.assertEqual(err_w2_2, "")
                    self.assertEqual(res_w2_2["renderedFrom"], "background-preview")
                    self.assertEqual((res_w2_2["width"], res_w2_2["height"]), (64, 48))
                    self.assertTrue(_wait_until(lambda: not _pid_alive(pid_w2_keep_child), timeout=8.0))
                    self.assertIsNone(unrelated.poll())
            finally:
                for win in (window1, window2):
                    win.stop()
                    win.pool.shutdown(wait=True, cancel_futures=True)
                    win._search_pool.shutdown(wait=True, cancel_futures=True)
                session.writes.shutdown()
                if previous_home is None:
                    os.environ.pop("SUPERMD_DATA_HOME", None)
                else:
                    os.environ["SUPERMD_DATA_HOME"] = previous_home

    def test_posix_and_windows_job_containment_contracts_without_taskkill(self):
        # 1. POSIX pgid safety never signals own process group or invalid pgids.
        calls: list[tuple[int, int]] = []
        proc = mock.MagicMock()
        proc.poll.side_effect = [None, 0]
        offline_view._terminate_posix_preview(
            proc,
            777,
            own_pgid=777,
            killpg_fn=lambda pg, sig: calls.append((pg, sig)),
        )
        self.assertEqual(calls, [])
        proc.terminate.assert_called_once()

        # 2. Windows pre-resume Job Object ordering: CreateJobObjectW -> Popen(CREATE_SUSPENDED)
        #    -> AssignProcessToJobObject -> NtResumeProcess, with zero taskkill calls.
        events: list[str] = []

        class FakeKernel32:
            def CreateJobObjectW(self, _sec, _name):
                events.append("create_job")
                return 101

            def SetInformationJobObject(self, _h, _cls, _info, _size):
                events.append("configure_job")
                return 1

            def AssignProcessToJobObject(self, _job, _proc):
                events.append("assign_job")
                return 1

            def TerminateJobObject(self, _job, _code):
                events.append("terminate_job")
                return 1

            def CloseHandle(self, _h):
                events.append("close_handle")
                return 1

        class FakeNtdll:
            def NtResumeProcess(self, _proc):
                events.append("resume_process")
                return 0

        fake_proc = mock.MagicMock()
        fake_proc._handle = 555
        fake_proc.pid = 4242
        fake_proc.poll.return_value = None

        def fake_popen(cmd, **kwargs):
            events.append(f"popen:{kwargs.get('creationflags', 0):#x}")
            self.assertTrue(kwargs["creationflags"] & offline_view._CREATE_SUSPENDED)
            return fake_proc

        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as folder:
            out_file = Path(folder) / "stdout.txt"
            err_file = Path(folder) / "stderr.txt"
            controller = offline_view._spawn_preview_process(
                ["fake-preview"],
                stdout_path=out_file,
                stderr_path=err_file,
                os_name="nt",
                popen_fn=fake_popen,
                kernel32=FakeKernel32(),
                ntdll=FakeNtdll(),
            )
            self.assertEqual(
                events[:5],
                [
                    "create_job",
                    "configure_job",
                    f"popen:{offline_view._preview_spawn_kwargs('nt')['creationflags']:#x}",
                    "assign_job",
                    "resume_process",
                ],
            )
            controller.terminate()
            self.assertIn("terminate_job", events)
            self.assertIn("close_handle", events)

            # Assignment failure aborts via owned handle before NtResumeProcess is ever called.
            fail_events: list[str] = []

            class FailAssignKernel32(FakeKernel32):
                def AssignProcessToJobObject(self, _job, _proc):
                    fail_events.append("assign_failed")
                    return 0

            class NeverResumeNtdll:
                def NtResumeProcess(self, _proc):  # pragma: no cover
                    fail_events.append("resumed_uncontained")
                    return 0

            unassigned_proc = mock.MagicMock()
            unassigned_proc._handle = 777
            unassigned_proc.poll.return_value = None

            with self.assertRaisesRegex(RuntimeError, "Could not assign offline preview process"):
                offline_view._spawn_preview_process(
                    ["fake-preview"],
                    stdout_path=out_file,
                    stderr_path=err_file,
                    os_name="nt",
                    popen_fn=lambda *_a, **_kw: unassigned_proc,
                    kernel32=FailAssignKernel32(),
                    ntdll=NeverResumeNtdll(),
                )
            self.assertEqual(fail_events, ["assign_failed"])
            unassigned_proc.kill.assert_called_once()

            # NtResumeProcess failure terminates the Job Object and reaps via owned handle.
            resume_fail_events: list[str] = []

            class ResumeFailKernel32(FakeKernel32):
                def TerminateJobObject(self, _job, _code):
                    resume_fail_events.append("terminate_job")
                    return 1

                def CloseHandle(self, _h):
                    resume_fail_events.append("close_handle")
                    return 1

            class FailResumeNtdll:
                def NtResumeProcess(self, _proc):
                    resume_fail_events.append("resume_failed")
                    return -1

            unresumed_proc = mock.MagicMock()
            unresumed_proc._handle = 888
            unresumed_proc.poll.return_value = None

            with self.assertRaisesRegex(RuntimeError, "Could not start contained offline preview process"):
                offline_view._spawn_preview_process(
                    ["fake-preview"],
                    stdout_path=out_file,
                    stderr_path=err_file,
                    os_name="nt",
                    popen_fn=lambda *_a, **_kw: unresumed_proc,
                    kernel32=ResumeFailKernel32(),
                    ntdll=FailResumeNtdll(),
                )
            self.assertEqual(resume_fail_events, ["resume_failed", "terminate_job", "close_handle"])
            unresumed_proc.kill.assert_called_once()

            # Pre-resume cancellation aborts before NtResumeProcess and raises PreviewCancelled (not PythonCellCancelled).
            cancelled_job = offline_view.PreviewJob("tab-1")
            cancelled_job.cancel()
            cancelled_proc = mock.MagicMock()
            cancelled_proc._handle = 999
            cancelled_proc.poll.return_value = None

            with self.assertRaises(offline_view.PreviewCancelled):
                offline_view._spawn_preview_process(
                    ["fake-preview"],
                    stdout_path=out_file,
                    stderr_path=err_file,
                    job=cancelled_job,
                    os_name="nt",
                    popen_fn=lambda *_a, **_kw: cancelled_proc,
                    kernel32=FakeKernel32(),
                    ntdll=NeverResumeNtdll(),
                )
            cancelled_proc.kill.assert_called_once()

            for mod in (offline_view, process_tree):
                self.assertNotIn("taskkill", Path(mod.__file__).read_text(encoding="utf-8").lower())


if __name__ == "__main__":
    unittest.main()
