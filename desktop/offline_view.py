"""Bounded subprocess rendering for offline and background note previews."""
from __future__ import annotations

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
from pathlib import Path


DEFAULT_PREVIEW_TIMEOUT = 55.0
_MAX_DIAGNOSTIC_BYTES = 16384

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
    """Anonymous Windows Job Object confining cleanup to one preview helper tree."""

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


def _preview_spawn_kwargs(os_name: str | None = None) -> dict:
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


def _terminate_posix_preview(
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


def _terminate_windows_preview(process, win_job: _WindowsJob | None) -> None:
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


class _PreviewProcessController:
    """Owns and confines cleanup to the process tree spawned for one preview."""

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
                _terminate_windows_preview(self.process, self._win_job)
            else:
                _terminate_posix_preview(self.process, self._pgid, grace=self._grace)

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
                    _terminate_posix_preview(self.process, self._pgid, grace=min(0.15, self._grace))


class PreviewCancelled(RuntimeError):
    """Raised when an offline or background preview is cancelled by tab or window close."""


class PreviewJob:
    """Per-preview cancellation handle; marks cancellation promptly while owned workers wait."""

    def __init__(self, tab_id: str = ""):
        self.tab_id = tab_id
        self.cancelled = threading.Event()
        self._lock = threading.Lock()

    def check(self) -> None:
        if self.cancelled.is_set():
            raise PreviewCancelled("Preview cancelled")

    def cancel(self) -> bool:
        with self._lock:
            if self.cancelled.is_set():
                return False
            self.cancelled.set()
            return True


class PreviewJobRegistry:
    """Thread-safe registry of active background preview helpers scoped to one Studio window."""

    def __init__(self):
        self._lock = threading.RLock()
        self._jobs: set[PreviewJob] = set()
        self._retired = False

    def register(self, tab_id: str = "") -> PreviewJob:
        job = PreviewJob(tab_id)
        with self._lock:
            if self._retired:
                job.cancelled.set()
            else:
                self._jobs.add(job)
        return job

    def discard(self, job: PreviewJob | None) -> None:
        if job is None:
            return
        with self._lock:
            self._jobs.discard(job)

    def active_count(self, tab_id: str | None = None) -> int:
        with self._lock:
            if tab_id is None:
                return len(self._jobs)
            return sum(1 for job in self._jobs if job.tab_id == tab_id)

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


def _spawn_preview_process(
    command: list[str],
    *,
    stdout_path: Path,
    stderr_path: Path,
    env: dict | None = None,
    job: PreviewJob | None = None,
    os_name: str | None = None,
    popen_fn=None,
    kernel32=None,
    ntdll=None,
) -> _PreviewProcessController:
    resolved_os = os.name if os_name is None else os_name
    spawner = subprocess.Popen if popen_fn is None else popen_fn
    win_job: _WindowsJob | None = None
    if resolved_os == "nt":
        win_job = _WindowsJob.create(kernel32=kernel32)
        if win_job is None:
            raise RuntimeError("Could not create Windows Job Object for offline preview")
    try:
        with open(stdout_path, "wb") as stdout_handle, open(stderr_path, "wb") as stderr_handle:
            process = spawner(
                command,
                stdin=subprocess.DEVNULL,
                stdout=stdout_handle,
                stderr=stderr_handle,
                env=env,
                **_preview_spawn_kwargs(resolved_os),
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
            raise PreviewCancelled("Preview cancelled")
        if not win_job.assign(process):
            win_job.close(terminate=False)
            _reap_owned_process(process)
            raise RuntimeError("Could not assign offline preview process to Windows Job Object")
        if job is not None and job.cancelled.is_set():
            win_job.close(terminate=True)
            _reap_owned_process(process)
            raise PreviewCancelled("Preview cancelled")
        if not _resume_windows_process(process, ntdll=ntdll):
            win_job.close(terminate=True)
            _reap_owned_process(process)
            raise RuntimeError("Could not start contained offline preview process")
        return _PreviewProcessController(process, os_name=resolved_os, win_job=win_job)
    return _PreviewProcessController(process, os_name=resolved_os, pgid=process.pid)


def _read_tail(path: Path, limit: int = _MAX_DIAGNOSTIC_BYTES) -> str:
    try:
        with open(path, "rb") as handle:
            handle.seek(0, os.SEEK_END)
            size = handle.tell()
            handle.seek(max(0, size - limit))
            return handle.read(limit).decode("utf-8", errors="replace")
    except OSError:
        return ""


def _extract_structured_error(stdout_text: str) -> str | None:
    for candidate in reversed([line.strip() for line in stdout_text.splitlines() if line.strip()]):
        try:
            payload = json.loads(candidate)
        except ValueError:
            continue
        if isinstance(payload, dict) and payload.get("ok") is False:
            error_obj = payload.get("error")
            if isinstance(error_obj, dict) and isinstance(error_obj.get("message"), str) and error_obj["message"].strip():
                return error_obj["message"].strip()
            if isinstance(error_obj, str) and error_obj.strip():
                return error_obj.strip()
    return None


def _format_preview_failure(stdout_path: Path, stderr_path: Path) -> str:
    stdout_tail = _read_tail(stdout_path)
    stderr_tail = _read_tail(stderr_path)
    structured = _extract_structured_error(stdout_tail)
    if structured:
        return structured[-1000:]
    combined = "\n".join(part for part in (stdout_tail.strip(), stderr_tail.strip()) if part)
    if combined:
        return combined[-1000:]
    return "Preview helper exited without producing a valid PNG image"


def _agent_cli_command() -> list[str]:
    if getattr(sys, "frozen", False):
        return [sys.executable, "agent"]
    return [sys.executable, str(Path(__file__).with_name("agent_cli.py"))]


def _run_preview_helper(
    command: list[str],
    target: Path,
    directory: Path,
    *,
    label: str,
    timeout: float = DEFAULT_PREVIEW_TIMEOUT,
    job: PreviewJob | None = None,
    env: dict | None = None,
) -> bytes:
    if job is not None:
        job.check()
    stdout_path = directory / "stdout.txt"
    stderr_path = directory / "stderr.txt"
    controller = _spawn_preview_process(
        command,
        stdout_path=stdout_path,
        stderr_path=stderr_path,
        env=env,
        job=job,
    )
    deadline = time.monotonic() + max(0.01, float(timeout))
    step = 0.02 if job is not None else 0.1
    try:
        while True:
            if job is not None and job.cancelled.is_set():
                controller.terminate()
                raise PreviewCancelled(f"{label} cancelled")
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                controller.terminate()
                raise ValueError(f"{label} timed out after {timeout:g} seconds")
            if controller.wait_step(min(step, remaining)):
                break
        if job is not None and job.cancelled.is_set():
            controller.terminate()
            raise PreviewCancelled(f"{label} cancelled")
    finally:
        controller.cleanup()

    if controller.process.returncode or not target.is_file():
        raise ValueError(f"{label} failed: {_format_preview_failure(stdout_path, stderr_path)}")
    data = target.read_bytes()
    if len(data) < 24 or not data.startswith(b"\x89PNG\r\n\x1a\n"):
        raise ValueError(f"{label} failed: {_format_preview_failure(stdout_path, stderr_path)}")
    return data


def render_offline(
    store,
    path_value,
    *,
    width: int = 1200,
    expected_revision: str | None = None,
    timeout: float = DEFAULT_PREVIEW_TIMEOUT,
    job: PreviewJob | None = None,
) -> bytes:
    path = store.resolve(path_value)
    raw = path.read_bytes()
    revision = hashlib.sha256(raw).hexdigest()
    if expected_revision and expected_revision != revision:
        raise ValueError("Revision conflict; inspect the note again")
    with tempfile.TemporaryDirectory(prefix="supermd-preview-", ignore_cleanup_errors=True) as directory:
        root_dir = Path(directory)
        target = root_dir / "preview.png"
        command = list(_agent_cli_command())
        for root in store.roots:
            command += ["--root", str(root)]
        command += ["--root", directory, "preview", str(path), str(target), "--width", str(width)]
        data = _run_preview_helper(
            command,
            target,
            root_dir,
            label="Offline reader preview",
            timeout=timeout,
            job=job,
        )
        if path.read_bytes() != raw:
            raise ValueError("The source changed while rendering; retry")
        return data


def render_live_snapshot(
    content,
    assets,
    source_path,
    *,
    width: int = 1200,
    heading: str | None = None,
    view: dict | None = None,
    timeout: float = DEFAULT_PREVIEW_TIMEOUT,
    job: PreviewJob | None = None,
) -> bytes:
    with tempfile.TemporaryDirectory(prefix="supermd-live-preview-", ignore_cleanup_errors=True) as directory:
        root = Path(directory)
        source = Path(source_path) if source_path else root / "Untitled.md"
        if not source_path:
            source.write_text("", encoding="utf-8")
        snapshot = root / "snapshot.json"
        snapshot.write_text(
            json.dumps({"content": content, "assets": assets, "view": view or {}}),
            encoding="utf-8",
        )
        target = root / "preview.png"
        command = list(_agent_cli_command())
        command += [
            "--root",
            str(source.parent),
            "--root",
            directory,
            "preview",
            str(source),
            str(target),
            "--snapshot",
            str(snapshot),
            "--width",
            str(max(320, width)),
        ]
        if heading:
            command += ["--heading", heading]
        return _run_preview_helper(
            command,
            target,
            root,
            label="Background preview",
            timeout=timeout,
            job=job,
        )
