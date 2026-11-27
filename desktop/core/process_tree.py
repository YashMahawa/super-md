"""Shared OS process-tree containment primitives for Desktop subprocess helpers."""
from __future__ import annotations

from collections.abc import Callable
import contextlib
import ctypes
import os
import signal
import subprocess
import threading
import time
from pathlib import Path


JOB_OBJECT_EXTENDED_LIMIT_INFO_CLASS = 9
JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000
CREATE_SUSPENDED = 0x00000004


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


class JobObjectExtendedLimitInformation(ctypes.Structure):
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


def load_kernel32():
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


def load_ntdll():
    global _WIN_NTDLL
    if _WIN_NTDLL is not None:
        return _WIN_NTDLL
    ntdll = ctypes.WinDLL("ntdll", use_last_error=True)
    ntdll.NtResumeProcess.argtypes = [ctypes.c_void_p]
    ntdll.NtResumeProcess.restype = ctypes.c_int32
    _WIN_NTDLL = ntdll
    return ntdll


def resume_windows_process(process, *, ntdll=None) -> bool:
    proc_handle = int(getattr(process, "_handle", 0) or 0)
    if not proc_handle:
        return False
    try:
        api = load_ntdll() if ntdll is None else ntdll
        status = api.NtResumeProcess(ctypes.c_void_p(proc_handle))
        return int(status) >= 0
    except Exception:
        return False


class WindowsJob:
    """Anonymous Windows Job Object confining cleanup to one owned subprocess tree."""

    def __init__(self, handle: int, kernel32):
        self._handle: int | None = handle
        self._kernel32 = kernel32
        self._assigned = False
        self._lock = threading.Lock()

    @classmethod
    def create(cls, kernel32=None) -> WindowsJob | None:
        try:
            api = load_kernel32() if kernel32 is None else kernel32
            handle = api.CreateJobObjectW(None, None)
            if not handle:
                return None
            info = JobObjectExtendedLimitInformation()
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
            ok = api.SetInformationJobObject(
                ctypes.c_void_p(handle),
                JOB_OBJECT_EXTENDED_LIMIT_INFO_CLASS,
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


def contained_spawn_kwargs(os_name: str | None = None) -> dict:
    resolved = os.name if os_name is None else os_name
    if resolved == "nt":
        flags = (
            getattr(subprocess, "CREATE_NO_WINDOW", 0x08000000)
            | getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0x00000200)
            | getattr(subprocess, "CREATE_SUSPENDED", CREATE_SUSPENDED)
        )
        return {"creationflags": flags}
    return {"start_new_session": True}


def posix_safe_pgid(pgid: int | None, *, own_pgid: int | None = None) -> bool:
    if not isinstance(pgid, int) or isinstance(pgid, bool) or pgid <= 1:
        return False
    if own_pgid is None:
        try:
            own_pgid = os.getpgrp()
        except AttributeError:
            return False
    return pgid != own_pgid


def posix_pgid_alive(pgid: int | None, *, killpg_fn=None, own_pgid: int | None = None) -> bool:
    if not posix_safe_pgid(pgid, own_pgid=own_pgid):
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


def terminate_posix_tree(
    process,
    pgid: int | None,
    *,
    grace: float = 0.2,
    killpg_fn=None,
    own_pgid: int | None = None,
) -> None:
    caller = os.killpg if killpg_fn is None else killpg_fn
    use_pgid = posix_safe_pgid(pgid, own_pgid=own_pgid)
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
        group_alive = posix_pgid_alive(pgid, killpg_fn=caller, own_pgid=own_pgid) if use_pgid else False
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


def reap_owned_process(process) -> None:
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


def terminate_windows_tree(process, win_job: WindowsJob | None) -> None:
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


class OwnedProcessTree:
    """Owns and confines cleanup to the process tree spawned for one helper run."""

    def __init__(
        self,
        process,
        *,
        os_name: str | None = None,
        pgid: int | None = None,
        win_job: WindowsJob | None = None,
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
                terminate_windows_tree(self.process, self._win_job)
            else:
                terminate_posix_tree(self.process, self._pgid, grace=self._grace)

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
                if posix_pgid_alive(self._pgid):
                    terminate_posix_tree(self.process, self._pgid, grace=min(0.15, self._grace))


def spawn_contained_process(
    command: list[str],
    *,
    cwd: str | None = None,
    env: dict | None = None,
    stdout_path: Path | None = None,
    stderr_path: Path | None = None,
    label: str = "helper",
    is_cancelled: Callable[[], bool] | None = None,
    on_cancelled: Callable[[], BaseException] | None = None,
    controller_cls: type[OwnedProcessTree] = OwnedProcessTree,
    os_name: str | None = None,
    popen_fn=None,
    kernel32=None,
    ntdll=None,
) -> OwnedProcessTree:
    resolved_os = os.name if os_name is None else os_name
    spawner = subprocess.Popen if popen_fn is None else popen_fn
    win_job: WindowsJob | None = None
    if resolved_os == "nt":
        win_job = WindowsJob.create(kernel32=kernel32)
        if win_job is None:
            raise RuntimeError(f"Could not create Windows Job Object for {label}")
    try:
        with contextlib.ExitStack() as stack:
            stdout_target = (
                stack.enter_context(open(stdout_path, "wb"))
                if stdout_path is not None
                else subprocess.DEVNULL
            )
            stderr_target = (
                stack.enter_context(open(stderr_path, "wb"))
                if stderr_path is not None
                else subprocess.DEVNULL
            )
            popen_kwargs: dict = {
                "stdin": subprocess.DEVNULL,
                "stdout": stdout_target,
                "stderr": stderr_target,
                "env": env,
            }
            if cwd is not None:
                popen_kwargs["cwd"] = cwd
            popen_kwargs.update(contained_spawn_kwargs(resolved_os))
            process = spawner(command, **popen_kwargs)
    except Exception:
        if win_job is not None:
            win_job.close(terminate=False)
        raise
    if resolved_os == "nt":
        assert win_job is not None
        if is_cancelled is not None and is_cancelled():
            win_job.close(terminate=False)
            reap_owned_process(process)
            raise (on_cancelled() if on_cancelled is not None else RuntimeError(f"{label} cancelled"))
        if not win_job.assign(process):
            win_job.close(terminate=False)
            reap_owned_process(process)
            raise RuntimeError(f"Could not assign {label} process to Windows Job Object")
        if is_cancelled is not None and is_cancelled():
            win_job.close(terminate=True)
            reap_owned_process(process)
            raise (on_cancelled() if on_cancelled is not None else RuntimeError(f"{label} cancelled"))
        if not resume_windows_process(process, ntdll=ntdll):
            win_job.close(terminate=True)
            reap_owned_process(process)
            raise RuntimeError(f"Could not start contained {label} process")
        return controller_cls(process, os_name=resolved_os, win_job=win_job)
    return controller_cls(process, os_name=resolved_os, pgid=process.pid)


def read_tail(path: Path, limit: int = 16384) -> str:
    try:
        with open(path, "rb") as handle:
            handle.seek(0, os.SEEK_END)
            size = handle.tell()
            handle.seek(max(0, size - limit))
            return handle.read(limit).decode("utf-8", errors="replace")
    except OSError:
        return ""
