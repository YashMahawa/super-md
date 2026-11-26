"""Python cell runtimes: the bundled interpreter, detected environments and app-managed setup.

Nothing here runs on open or export. Cells run only after an explicit Run, and
local Python is trusted user code, not a sandbox.
"""
from __future__ import annotations
from collections.abc import Sequence
import ctypes
import json
import os
import re
import shutil
import signal
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path

BUNDLED = "bundled"
CELL_FLAG = "--python-cell"
MAX_CODE = 200_000
MAX_FIGURES = 16
MAX_FIGURE_BYTES = 8_000_000
NAME = re.compile(r"^python(\d+(\.\d+)?)?w?(\.exe)?$", re.IGNORECASE)
CELL_FILENAME = "<Super MD cell>"

# Runs inside the chosen interpreter. Communicates through files, not stdio,
# because windowed (no console) builds have no usable standard streams.
RUNNER = r'''
import sys, json, io, base64, contextlib, traceback
source_path, result_path = sys.argv[-2], sys.argv[-1]
with open(source_path, encoding="utf-8") as handle:
    payload = json.load(handle)
out = io.StringIO(); err = io.StringIO(); images = []; ok = True; plt = None
try:
    try:
        import matplotlib
        matplotlib.use("Agg")
        import matplotlib.pyplot as plt
    except ImportError:
        plt = None
    with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
        exec(compile(payload["code"], "<Super MD cell>", "exec"), {"__name__": "__main__"})
    if plt is not None:
        for number in plt.get_fignums()[:16]:
            data = io.BytesIO()
            plt.figure(number).savefig(data, format="svg", bbox_inches="tight")
            if data.tell() <= 8000000:
                images.append("data:image/svg+xml;base64," + base64.b64encode(data.getvalue()).decode())
except BaseException as error:
    ok = False
    frames = [frame for frame in traceback.extract_tb(error.__traceback__) if frame.filename == "<Super MD cell>"]
    lines = payload["code"].splitlines()
    for frame in frames:
        text = lines[frame.lineno - 1].strip() if frame.lineno and frame.lineno <= len(lines) else ""
        err.write(f"Line {frame.lineno}" + (f": {text}" if text else "") + "\n")
    if isinstance(error, ModuleNotFoundError) and error.name in ("matplotlib", "numpy"):
        err.write(f"{error.name} is not installed for this Python. Choose another interpreter or set one up in Settings > Python.\n")
    else:
        err.write("".join(traceback.format_exception_only(type(error), error)))
finally:
    if plt is not None:
        try: plt.close("all")
        except Exception: pass
with open(result_path, "w", encoding="utf-8") as handle:
    json.dump({"stdout": out.getvalue()[:200000], "stderr": err.getvalue()[:200000], "images": images, "ok": ok}, handle)
'''

PROBE = ("import sys,json,importlib.util as u;print(json.dumps({'version':'%d.%d.%d'%sys.version_info[:3],"
         "'prefix':sys.prefix,'venv':sys.prefix!=getattr(sys,'base_prefix',sys.prefix),"
         "'matplotlib':u.find_spec('matplotlib') is not None,'numpy':u.find_spec('numpy') is not None,"
         "'venvModule':u.find_spec('venv') is not None and u.find_spec('ensurepip') is not None}))")

def frozen() -> bool:
    return bool(getattr(sys, "frozen", False))

def bundled_available() -> bool:
    """Windows and macOS installers ship numpy and matplotlib inside the app."""
    if not frozen():
        return False
    import importlib.util
    return importlib.util.find_spec("matplotlib") is not None

def _no_window() -> dict:
    return {"creationflags": subprocess.CREATE_NO_WINDOW} if sys.platform == "win32" else {}

def clean_environment() -> dict:
    environment = os.environ.copy()
    for key in ("PYTHONHOME", "PYTHONPATH", "PYTHONSTARTUP", "PYTHONINSPECT"):
        environment.pop(key, None)
    if frozen() and sys.platform.startswith("linux"):
        # An external interpreter must not load our embedded Python/Qt libraries.
        if "LD_LIBRARY_PATH_ORIG" in environment:
            environment["LD_LIBRARY_PATH"] = environment["LD_LIBRARY_PATH_ORIG"]
        else:
            environment.pop("LD_LIBRARY_PATH", None)
    environment["PYTHONIOENCODING"] = "utf-8"
    environment["MPLBACKEND"] = "Agg"
    return environment

def validate(executable: str) -> str:
    """Accept only the bundled runtime or an existing executable named like Python."""
    if executable == BUNDLED:
        if not bundled_available():
            raise ValueError("This build has no bundled Python. Choose an interpreter in Settings > Python.")
        return executable
    if not executable:
        raise ValueError("Choose a Python interpreter in Settings > Python first.")
    path = Path(executable).expanduser()
    if not path.is_absolute():
        found = shutil.which(executable)
        if not found:
            raise ValueError(f"Python interpreter not found: {executable}")
        path = Path(found)
    if not NAME.match(path.name):
        raise ValueError("The interpreter must be a Python executable (python, python3 or python.exe)")
    if not path.is_file() or not os.access(path, os.X_OK):
        raise ValueError(f"Python interpreter not found: {path}")
    return str(path)

def _command(executable: str) -> list[str]:
    if executable == BUNDLED:
        return [sys.executable, CELL_FLAG]
    return [executable, "-c", RUNNER]


_JOB_OBJECT_EXTENDED_LIMIT_INFO_CLASS = 9
_JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000
_CREATE_SUSPENDED = 0x00000004


class _JobObjectBasicLimitInformation(ctypes.Structure):
    _fields_ = [
        ("PerProcessUserTimeLimit", ctypes.c_int64),
        ("PerJobUserTimeLimit", ctypes.c_int64),
        ("LimitFlags", ctypes.c_uint32),
        ("MinimumWorkingSetSize", ctypes.c_size_t),
        ("MaximumWorkingSetSize", ctypes.c_size_t),
        ("ActiveProcessLimit", ctypes.c_uint32),
        ("Affinity", ctypes.c_size_t),
        ("PriorityClass", ctypes.c_uint32),
        ("SchedulingClass", ctypes.c_uint32),
    ]


class _IoCounters(ctypes.Structure):
    _fields_ = [
        ("ReadOperationCount", ctypes.c_uint64),
        ("WriteOperationCount", ctypes.c_uint64),
        ("OtherOperationCount", ctypes.c_uint64),
        ("ReadTransferCount", ctypes.c_uint64),
        ("WriteTransferCount", ctypes.c_uint64),
        ("OtherTransferCount", ctypes.c_uint64),
    ]


class _JobObjectExtendedLimitInformation(ctypes.Structure):
    _fields_ = [
        ("BasicLimitInformation", _JobObjectBasicLimitInformation),
        ("IoInfo", _IoCounters),
        ("ProcessMemoryLimit", ctypes.c_size_t),
        ("JobMemoryLimit", ctypes.c_size_t),
        ("PeakProcessMemoryUsed", ctypes.c_size_t),
        ("PeakJobMemoryUsed", ctypes.c_size_t),
    ]


_WIN_KERNEL32 = None
_WIN_NTDLL = None


def _load_kernel32():
    global _WIN_KERNEL32
    if _WIN_KERNEL32 is not None:
        return _WIN_KERNEL32
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel32.CreateJobObjectW.argtypes = [ctypes.c_void_p, ctypes.c_wchar_p]
    kernel32.CreateJobObjectW.restype = ctypes.c_void_p
    kernel32.SetInformationJobObject.argtypes = [
        ctypes.c_void_p,
        ctypes.c_int,
        ctypes.c_void_p,
        ctypes.c_uint32,
    ]
    kernel32.SetInformationJobObject.restype = ctypes.c_int
    kernel32.AssignProcessToJobObject.argtypes = [ctypes.c_void_p, ctypes.c_void_p]
    kernel32.AssignProcessToJobObject.restype = ctypes.c_int
    kernel32.TerminateJobObject.argtypes = [ctypes.c_void_p, ctypes.c_uint32]
    kernel32.TerminateJobObject.restype = ctypes.c_int
    kernel32.CloseHandle.argtypes = [ctypes.c_void_p]
    kernel32.CloseHandle.restype = ctypes.c_int
    _WIN_KERNEL32 = kernel32
    return kernel32


def _load_ntdll():
    global _WIN_NTDLL
    if _WIN_NTDLL is not None:
        return _WIN_NTDLL
    ntdll = ctypes.WinDLL("ntdll", use_last_error=True)
    ntdll.NtResumeProcess.argtypes = [ctypes.c_void_p]
    ntdll.NtResumeProcess.restype = ctypes.c_int32
    _WIN_NTDLL = ntdll
    return ntdll


def _resume_windows_process(process, *, ntdll=None) -> bool:
    proc_handle = int(getattr(process, "_handle", 0) or 0)
    if not proc_handle:
        return False
    try:
        api = _load_ntdll() if ntdll is None else ntdll
        status = api.NtResumeProcess(ctypes.c_void_p(proc_handle))
        return int(status) >= 0
    except Exception:
        return False


class _WindowsJob:
    """Anonymous Windows Job Object confining cleanup to one Python cell's processes."""

    def __init__(self, handle: int, kernel32):
        self._handle: int | None = handle
        self._kernel32 = kernel32
        self._assigned = False
        self._lock = threading.Lock()

    @classmethod
    def create(cls, kernel32=None) -> _WindowsJob | None:
        try:
            api = _load_kernel32() if kernel32 is None else kernel32
            handle = api.CreateJobObjectW(None, None)
            if not handle:
                return None
            info = _JobObjectExtendedLimitInformation()
            info.BasicLimitInformation.LimitFlags = _JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
            ok = api.SetInformationJobObject(
                ctypes.c_void_p(handle),
                _JOB_OBJECT_EXTENDED_LIMIT_INFO_CLASS,
                ctypes.byref(info),
                ctypes.sizeof(info),
            )
            if not ok:
                api.CloseHandle(ctypes.c_void_p(handle))
                return None
            return cls(int(handle), api)
        except Exception:
            return None

    def assign(self, process) -> bool:
        with self._lock:
            handle = self._handle
            if handle is None:
                return False
            proc_handle = int(getattr(process, "_handle", 0) or 0)
            if not proc_handle:
                ok = 0
            else:
                try:
                    ok = self._kernel32.AssignProcessToJobObject(
                        ctypes.c_void_p(handle), ctypes.c_void_p(proc_handle)
                    )
                except Exception:
                    ok = 0
            if not ok:
                self._handle = None
                try:
                    self._kernel32.CloseHandle(ctypes.c_void_p(handle))
                except Exception:
                    pass
                return False
            self._assigned = True
            return True

    def close(self, *, terminate: bool = False) -> None:
        with self._lock:
            handle = self._handle
            if handle is None:
                return
            self._handle = None
            assigned = self._assigned
        try:
            if terminate and assigned:
                self._kernel32.TerminateJobObject(ctypes.c_void_p(handle), 1)
        except Exception:
            pass
        try:
            self._kernel32.CloseHandle(ctypes.c_void_p(handle))
        except Exception:
            pass


def _cell_spawn_kwargs(os_name: str | None = None) -> dict:
    resolved = os.name if os_name is None else os_name
    if resolved == "nt":
        flags = (
            getattr(subprocess, "CREATE_NO_WINDOW", 0x08000000)
            | getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0x00000200)
            | getattr(subprocess, "CREATE_SUSPENDED", _CREATE_SUSPENDED)
        )
        return {"creationflags": flags}
    return {"start_new_session": True}


def _posix_safe_pgid(pgid: int | None, *, own_pgid: int | None = None) -> bool:
    if not isinstance(pgid, int) or isinstance(pgid, bool) or pgid <= 1:
        return False
    if own_pgid is None:
        try:
            own_pgid = os.getpgrp()
        except AttributeError:
            return False
    return pgid != own_pgid


def _posix_pgid_alive(pgid: int | None, *, killpg_fn=None, own_pgid: int | None = None) -> bool:
    if not _posix_safe_pgid(pgid, own_pgid=own_pgid):
        return False
    caller = os.killpg if killpg_fn is None else killpg_fn
    try:
        caller(pgid, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    except OSError:
        return False


def _terminate_posix_cell(
    process,
    pgid: int | None,
    *,
    grace: float = 0.2,
    killpg_fn=None,
    own_pgid: int | None = None,
) -> None:
    caller = os.killpg if killpg_fn is None else killpg_fn
    use_pgid = _posix_safe_pgid(pgid, own_pgid=own_pgid)
    sigterm = getattr(signal, "SIGTERM", 15)
    sigkill = getattr(signal, "SIGKILL", 9)
    if use_pgid:
        try:
            caller(pgid, sigterm)
        except (ProcessLookupError, PermissionError, OSError):
            pass
    elif process is not None and process.poll() is None:
        try:
            process.terminate()
        except OSError:
            pass

    deadline = time.monotonic() + max(0.0, grace)
    while True:
        reaped = process is None or process.poll() is not None
        group_alive = _posix_pgid_alive(pgid, killpg_fn=caller, own_pgid=own_pgid) if use_pgid else False
        if reaped and not group_alive:
            return
        if time.monotonic() >= deadline:
            break
        time.sleep(0.01)

    if use_pgid:
        try:
            caller(pgid, sigkill)
        except (ProcessLookupError, PermissionError, OSError):
            pass
    if process is not None and process.poll() is None:
        try:
            process.kill()
        except OSError:
            pass
    if process is not None and process.poll() is None:
        try:
            process.wait(timeout=2)
        except (OSError, subprocess.TimeoutExpired):
            pass


def _reap_owned_process(process) -> None:
    if process is None:
        return
    was_running = process.poll() is None
    if was_running:
        try:
            process.kill()
        except OSError:
            pass
    if was_running or process.poll() is None:
        try:
            process.wait(timeout=2)
        except (OSError, subprocess.TimeoutExpired):
            pass


def _terminate_windows_cell(process, win_job: _WindowsJob | None) -> None:
    was_running = process is not None and process.poll() is None
    if win_job is not None:
        win_job.close(terminate=True)
    elif was_running:
        try:
            process.kill()
        except OSError:
            pass
    if process is not None and (was_running or process.poll() is None):
        try:
            process.wait(timeout=2)
        except (OSError, subprocess.TimeoutExpired):
            pass


class _CellProcessController:
    """Owns and confines cleanup to the process tree spawned for one Python cell."""

    def __init__(
        self,
        process,
        *,
        os_name: str | None = None,
        pgid: int | None = None,
        win_job: _WindowsJob | None = None,
        grace: float = 0.2,
    ):
        self.process = process
        self._os_name = os.name if os_name is None else os_name
        self._pgid = pgid
        self._win_job = win_job
        self._grace = grace
        self._lock = threading.Lock()
        self._terminated = False

    def wait_step(self, timeout: float) -> bool:
        try:
            self.process.wait(timeout=max(0.0, timeout))
            return True
        except subprocess.TimeoutExpired:
            return False

    def terminate(self) -> None:
        with self._lock:
            if self._terminated:
                return
            self._terminated = True
            if self._os_name == "nt":
                _terminate_windows_cell(self.process, self._win_job)
            else:
                _terminate_posix_cell(self.process, self._pgid, grace=self._grace)

    def cleanup(self) -> None:
        if self.process is not None and self.process.poll() is None:
            self.terminate()
            return
        with self._lock:
            if self._terminated:
                return
            self._terminated = True
            if self._os_name == "nt":
                if self._win_job is not None:
                    self._win_job.close(terminate=True)
            else:
                if _posix_pgid_alive(self._pgid):
                    _terminate_posix_cell(self.process, self._pgid, grace=min(0.15, self._grace))


class PythonCellCancelled(RuntimeError):
    """Raised when a Python cell execution is cancelled by tab or window cleanup."""


class PythonCellJob:
    """Per-cell cancellation handle; marks cancellation promptly while owned workers wait."""

    def __init__(self, tab_id: str = ""):
        self.tab_id = tab_id
        self.cancelled = threading.Event()
        self._lock = threading.Lock()

    def check(self) -> None:
        if self.cancelled.is_set():
            raise PythonCellCancelled("Python cell cancelled")

    def cancel(self) -> bool:
        with self._lock:
            if self.cancelled.is_set():
                return False
            self.cancelled.set()
            return True


class PythonJobRegistry:
    """Thread-safe registry of active Python cell executions scoped to one Studio window."""

    def __init__(self):
        self._lock = threading.RLock()
        self._jobs: set[PythonCellJob] = set()
        self._retired = False

    def register(self, tab_id: str = "") -> PythonCellJob:
        job = PythonCellJob(tab_id)
        with self._lock:
            if self._retired:
                job.cancelled.set()
            else:
                self._jobs.add(job)
        return job

    def discard(self, job: PythonCellJob | None) -> None:
        if job is None:
            return
        with self._lock:
            self._jobs.discard(job)

    def cancel_tab(self, tab_id: str) -> int:
        if not tab_id:
            return 0
        with self._lock:
            targets = tuple(job for job in self._jobs if job.tab_id == tab_id)
        cancelled = 0
        for job in targets:
            if job.cancel():
                cancelled += 1
        return cancelled

    def cancel_all(self, *, retire: bool = False) -> int:
        with self._lock:
            if retire:
                self._retired = True
            targets = tuple(self._jobs)
        cancelled = 0
        for job in targets:
            if job.cancel():
                cancelled += 1
        return cancelled


def _spawn_cell_process(
    command: list[str],
    *,
    cwd: str,
    env: dict,
    stderr_path: Path,
    job: PythonCellJob | None = None,
    os_name: str | None = None,
    popen_fn=None,
    kernel32=None,
    ntdll=None,
) -> _CellProcessController:
    resolved_os = os.name if os_name is None else os_name
    spawner = subprocess.Popen if popen_fn is None else popen_fn
    win_job: _WindowsJob | None = None
    if resolved_os == "nt":
        win_job = _WindowsJob.create(kernel32=kernel32)
        if win_job is None:
            raise RuntimeError("Could not create Windows Job Object for Python cell")
    try:
        with open(stderr_path, "wb") as stderr_handle:
            process = spawner(
                command,
                stdin=subprocess.DEVNULL,
                stdout=subprocess.DEVNULL,
                stderr=stderr_handle,
                env=env,
                cwd=cwd,
                **_cell_spawn_kwargs(resolved_os),
            )
    except Exception:
        if win_job is not None:
            win_job.close(terminate=False)
        raise
    if resolved_os == "nt":
        assert win_job is not None
        if job is not None and job.cancelled.is_set():
            win_job.close(terminate=False)
            _reap_owned_process(process)
            raise PythonCellCancelled("Python cell cancelled")
        if not win_job.assign(process):
            win_job.close(terminate=False)
            _reap_owned_process(process)
            raise RuntimeError("Could not assign Python cell process to Windows Job Object")
        if job is not None and job.cancelled.is_set():
            win_job.close(terminate=True)
            _reap_owned_process(process)
            raise PythonCellCancelled("Python cell cancelled")
        if not _resume_windows_process(process, ntdll=ntdll):
            win_job.close(terminate=True)
            _reap_owned_process(process)
            raise RuntimeError("Could not start contained Python cell process")
        return _CellProcessController(process, os_name=resolved_os, win_job=win_job)
    return _CellProcessController(process, os_name=resolved_os, pgid=process.pid)


def _read_stderr_tail(stderr_path: Path, limit: int = 16384) -> str:
    try:
        with open(stderr_path, "rb") as handle:
            handle.seek(0, os.SEEK_END)
            size = handle.tell()
            handle.seek(max(0, size - limit))
            return handle.read(limit).decode("utf-8", errors="replace")
    except OSError:
        return ""


def run(
    executable: str,
    code: str,
    timeout: float = 90,
    cwd: str | None = None,
    *,
    job: PythonCellJob | None = None,
) -> dict:
    if not isinstance(code, str) or len(code) > MAX_CODE:
        raise ValueError("Python cell exceeds 200 KB")
    if job is not None:
        job.check()
    executable = validate(executable)
    with tempfile.TemporaryDirectory(prefix="supermd-cell-", ignore_cleanup_errors=True) as folder:
        source = Path(folder) / "cell.json"
        result = Path(folder) / "result.json"
        stderr_path = Path(folder) / "stderr.txt"
        source.write_text(json.dumps({"code": code}), encoding="utf-8")
        if job is not None:
            job.check()
        controller = _spawn_cell_process(
            [*_command(executable), str(source), str(result)],
            cwd=cwd if cwd and Path(cwd).is_dir() else folder,
            env=clean_environment(),
            stderr_path=stderr_path,
            job=job,
        )
        try:
            deadline = time.monotonic() + timeout
            while True:
                if job is not None and job.cancelled.is_set():
                    controller.terminate()
                    raise PythonCellCancelled("Python cell cancelled")
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    controller.terminate()
                    if job is not None and job.cancelled.is_set():
                        raise PythonCellCancelled("Python cell cancelled")
                    raise ValueError(f"Python cell stopped after {timeout} seconds")
                step = min(0.02, remaining) if job is not None else remaining
                if controller.wait_step(step):
                    break
            if job is not None:
                job.check()
            if not result.is_file():
                stderr_text = _read_stderr_tail(stderr_path)
                raise ValueError((stderr_text or "Python exited without a result").strip()[-2000:])
            output = json.loads(result.read_text(encoding="utf-8"))
        finally:
            controller.cleanup()
    output["images"] = [image for image in output.get("images", [])[:MAX_FIGURES]
                        if isinstance(image, str) and image.startswith("data:image/svg+xml;base64,") and len(image) <= MAX_FIGURE_BYTES * 4 // 3 + 64]
    return output

def run_bundled_cell(argv: list[str]) -> int:
    """Entry point for `super-md --python-cell source result` inside the frozen app."""
    if len(argv) < 2:
        return 2
    sys.argv = [sys.argv[0], argv[-2], argv[-1]]
    exec(compile(RUNNER, "<Super MD runner>", "exec"), {"__name__": "__supermd_runner__"})
    return 0

def probe(executable: str, timeout: float = 6) -> dict | None:
    try:
        process = subprocess.run([executable, "-c", PROBE], capture_output=True, text=True, timeout=timeout,
                                 env=clean_environment(), stdin=subprocess.DEVNULL, **_no_window())
        if process.returncode:
            return None
        return json.loads(process.stdout.strip().splitlines()[-1])
    except (OSError, ValueError, IndexError, subprocess.SubprocessError):
        return None

def _bin(prefix: Path) -> list[Path]:
    return [prefix / "Scripts" / "python.exe", prefix / "python.exe"] if sys.platform == "win32" else [prefix / "bin" / "python3", prefix / "bin" / "python"]

def _usable_python(path: Path) -> str:
    candidate = Path(os.path.abspath(path.expanduser()))
    sibling = Path(str(candidate).replace("/sbin/", "/bin/"))
    if sibling != candidate and sibling.is_file():
        candidate = sibling
    if NAME.match(candidate.name) and candidate.is_file() and os.access(candidate, os.X_OK):
        return str(candidate)
    return ""

def candidates(managed: Path, folders: Sequence[str] = ()) -> list[Path]:
    home = Path.home()
    found: list[Path] = []
    def add_prefix(prefix: Path):
        for path in _bin(prefix):
            found.append(path)
    add_prefix(managed)
    for variable in ("VIRTUAL_ENV", "CONDA_PREFIX"):
        if os.environ.get(variable):
            add_prefix(Path(os.environ[variable]))
    seen_folders: set[str] = set()
    for folder in folders:
        if not folder:
            continue
        folder_key = os.path.normcase(os.path.abspath(os.fspath(folder)))
        if folder_key in seen_folders:
            continue
        seen_folders.add(folder_key)
        current = Path(folder)
        for _ in range(4):
            for name in (".venv", "venv", "env", ".env"):
                add_prefix(current / name)
            if current.parent == current:
                break
            current = current.parent
    for name in (".venv", "venv", ".virtualenvs", ".local/share/virtualenvs", "envs", ".pyenv/versions"):
        base = home / name
        add_prefix(base)
        if base.is_dir() and name not in (".venv", "venv"):
            try:
                for child in sorted(base.iterdir())[:40]:
                    add_prefix(child)
            except OSError:
                pass
    for name in ("miniconda3", "anaconda3", "miniforge3", "mambaforge", "micromamba", ".conda"):
        base = home / name
        add_prefix(base)
        try:
            for child in sorted((base / "envs").iterdir())[:40]:
                add_prefix(child)
        except OSError:
            pass
    if sys.platform == "win32":
        local = Path(os.environ.get("LOCALAPPDATA", home / "AppData/Local")) / "Programs/Python"
        try:
            found += [child / "python.exe" for child in sorted(local.iterdir(), reverse=True)]
        except OSError:
            pass
    else:
        found += [Path("/opt/homebrew/bin/python3"), Path("/usr/local/bin/python3")]
    for name in ("python3", "python", *(f"python3.{minor}" for minor in range(16, 8, -1))):
        located = shutil.which(name)
        if located:
            found.append(Path(located))
    if not frozen():
        found.append(Path(sys.executable))
    unique: list[Path] = []
    seen: set[tuple[str, str]] = set()
    for path in found:
        sibling = Path(str(path).replace("/sbin/", "/bin/"))
        if sibling != path and sibling.is_file():
            path = sibling  # Merged-/usr systems list python under sbin first on PATH.
        if not path.is_file() or not NAME.match(path.name):
            continue
        key = (
            os.path.normcase(os.path.abspath(os.path.dirname(path))),
            os.path.normcase(os.path.realpath(path)),
        )
        if key not in seen:
            seen.add(key)
            unique.append(path)
    return unique

class _DiscoverFlight:
    def __init__(self) -> None:
        self.event = threading.Event()
        self.result: list[dict] = []
        self.error: BaseException | None = None

_DISCOVER_LOCK = threading.Lock()
_INFLIGHT_DISCOVER: dict[tuple[str, tuple[str, ...]], _DiscoverFlight] = {}

def _discover_key(managed: Path, folders: Sequence[str]) -> tuple[str, tuple[str, ...]]:
    managed_key = os.path.normcase(os.path.abspath(os.fspath(managed)))
    folders_key = tuple(
        dict.fromkeys(os.path.normcase(os.path.abspath(os.fspath(folder))) for folder in folders if folder)
    )
    return (managed_key, folders_key)

def _discover_once(managed: Path, folders: Sequence[str] = ()) -> list[dict]:
    results, prefixes = [], set()
    if bundled_available():
        results.append({"path": BUNDLED, "label": "Built-in Python", "detail": "Included with Super MD: numpy and matplotlib", "matplotlib": True, "managed": False, "venv": False})
    import concurrent.futures
    paths = candidates(managed, folders)
    with concurrent.futures.ThreadPoolExecutor(max_workers=6) as pool:
        infos = list(pool.map(probe, map(str, paths)))
    for path, info in zip(paths, infos):
        if not info:
            continue
        key = (os.path.normcase(info["prefix"]), os.path.normcase(os.path.realpath(path)))
        if key in prefixes:
            continue
        prefixes.add(key)
        is_managed = Path(info["prefix"]).resolve() == managed.resolve() if managed.exists() else False
        kind = "Super MD environment" if is_managed else ("Virtual environment" if info["venv"] else "System Python")
        ready = info["matplotlib"] and info["numpy"]
        missing = [name for name in ("numpy", "matplotlib") if not info[name]]
        packages = "numpy + matplotlib ready" if ready else "needs " + " + ".join(missing)
        location = str(Path(info["prefix"]).name if info["venv"] or is_managed else path)
        results.append({"path": str(path), "label": f"{kind} {info['version']}", "detail": f"{location} · {packages}",
                        "matplotlib": ready, "managed": is_managed, "venv": bool(info["venv"]) or is_managed, "venvModule": info.get("venvModule", False)})
    results.sort(key=lambda item: (item["path"] != BUNDLED, not item["managed"], not item["matplotlib"]))
    return results

def discover(managed: Path, folders: Sequence[str] = ()) -> list[dict]:
    """Detected interpreters, best first: managed env, environments with matplotlib, then the rest."""
    flight_key = _discover_key(managed, folders)
    with _DISCOVER_LOCK:
        flight = _INFLIGHT_DISCOVER.get(flight_key)
        leader = flight is None
        if flight is None:
            flight = _DiscoverFlight()
            _INFLIGHT_DISCOVER[flight_key] = flight
    if leader:
        try:
            flight.result = _discover_once(managed, folders)
        except BaseException as error:
            flight.error = error
        finally:
            with _DISCOVER_LOCK:
                if _INFLIGHT_DISCOVER.get(flight_key) is flight:
                    _INFLIGHT_DISCOVER.pop(flight_key, None)
            flight.event.set()
    else:
        flight.event.wait()
    if flight.error is not None:
        raise flight.error
    return [dict(item) for item in flight.result]

def default_python(managed: Path) -> str:
    """Choose a direct default interpreter without spawning probe subprocesses."""
    if bundled_available():
        return BUNDLED
    direct: list[Path] = list(_bin(managed))
    for variable in ("VIRTUAL_ENV", "CONDA_PREFIX"):
        value = os.environ.get(variable)
        if value:
            direct.extend(_bin(Path(value).expanduser()))
    if not frozen() and sys.executable:
        direct.append(Path(sys.executable))
    for path in direct:
        chosen = _usable_python(path)
        if chosen:
            return chosen
    for name in ("python3", "python", *(f"python3.{minor}" for minor in range(16, 8, -1))):
        located = shutil.which(name)
        if located:
            chosen = _usable_python(Path(located))
            if chosen:
                return chosen
    return ""

def preferred(managed: Path, folders: Sequence[str] = ()) -> str:
    if bundled_available():
        return BUNDLED
    for item in discover(managed, folders):
        if item["matplotlib"]:
            return item["path"]
    return default_python(managed)

def setup_environment(managed: Path, report=lambda text: None) -> str:
    """Create an app-owned virtual environment and install numpy + matplotlib into it."""
    bases = [item for item in discover(managed) if item["path"] != BUNDLED and not item["managed"] and item.get("venvModule")]
    if not bases:
        if sys.platform.startswith("linux"):
            raise ValueError("No Python with venv support was found. Install python3 and python3-venv (Debian/Ubuntu) or python (Arch/Fedora), then try again.")
        raise ValueError("No Python 3 installation was found. Install Python from python.org, then try again.")
    base = bases[0]["path"]
    report("Creating a private Python environment")
    if managed.exists():
        shutil.rmtree(managed, ignore_errors=True)
    managed.parent.mkdir(parents=True, exist_ok=True)
    created = subprocess.run([base, "-m", "venv", str(managed)], capture_output=True, text=True, timeout=180,
                             env=clean_environment(), stdin=subprocess.DEVNULL, **_no_window())
    if created.returncode:
        hint = " Install your distribution's python3-venv package and try again." if "ensurepip" in created.stderr else ""
        raise ValueError((created.stderr.strip().splitlines() or ["Could not create the environment"])[-1] + hint)
    python = next((path for path in _bin(managed) if path.is_file()), None)
    if python is None:
        raise ValueError("The new environment has no Python executable")
    report("Installing numpy and matplotlib (needs internet)")
    installed = subprocess.run([str(python), "-m", "pip", "install", "--disable-pip-version-check", "--no-input", "numpy", "matplotlib"],
                               capture_output=True, text=True, timeout=900, env=clean_environment(), stdin=subprocess.DEVNULL, **_no_window())
    if installed.returncode:
        raise ValueError("pip could not install matplotlib: " + ((installed.stderr.strip().splitlines() or ["check your internet connection"])[-1]))
    return str(python)

def install_packages(executable: str, report=lambda text: None) -> str:
    """Install numpy + matplotlib into an existing virtual environment."""
    executable = validate(executable)
    if executable == BUNDLED:
        return executable
    info = probe(executable)
    if not info:
        raise ValueError("This Python could not be started")
    if not info["venv"]:
        raise ValueError("System Python is managed by your OS. Use Set up Python for a private environment, or install python-numpy and python-matplotlib with your package manager.")
    report("Installing numpy and matplotlib (needs internet)")
    installed = subprocess.run([executable, "-m", "pip", "install", "--disable-pip-version-check", "--no-input", "numpy", "matplotlib"],
                               capture_output=True, text=True, timeout=900, env=clean_environment(), stdin=subprocess.DEVNULL, **_no_window())
    if installed.returncode:
        raise ValueError("pip could not install numpy and matplotlib: " + ((installed.stderr.strip().splitlines() or ["check your internet connection"])[-1]))
    return executable
