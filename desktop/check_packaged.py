"""Exercise the packaged executable, not the developer's Python environment.

Checks private user-data roots, CLI/math/portable export, presented WebEngine
pixels, automatic graphics recovery, and background service lifecycle.
Never loads or writes a user's notes.
"""
import argparse
import base64
import ctypes
import json
import gzip
import os
from pathlib import Path
import shutil
import signal
import subprocess
import sys
import tempfile
import time

def macos_qtwebengine_process_path(app_bundle: Path) -> Path:
    """Return the QtWebEngineProcess path searched by the frozen macOS app."""
    return (Path(app_bundle) / "Contents/Frameworks/PySide6/Qt/lib/QtWebEngineCore.framework/"
            "Helpers/QtWebEngineProcess.app/Contents/MacOS/QtWebEngineProcess")


def require_macos_qtwebengine_process(app_bundle: Path) -> Path:
    """Fail packaged-app checks when PyInstaller omitted Qt's WebEngine child."""
    helper = macos_qtwebengine_process_path(app_bundle)
    if not helper.is_file() or not os.access(helper, os.X_OK):
        raise RuntimeError(f"Packaged macOS app is missing or has a non-executable QtWebEngineProcess at {helper}")
    return helper


APPDATA_OVERRIDE_ENV = "SUPERMD_APPDATA_DIR"
SMOKE_RUN_ID_ENV = "SUPERMD_SMOKE_RUN_ID"
SMOKE_SPAWN_LOG_ENV = "SUPERMD_SMOKE_SPAWN_LOG"

CREATE_SUSPENDED = 0x00000004
CREATE_NO_WINDOW = 0x08000000
PROCESS_QUERY_LIMITED_INFORMATION = 0x00001000
STILL_ACTIVE = 259
JOB_OBJECT_EXTENDED_LIMIT_INFO_CLASS = 9
JOB_OBJECT_LIMIT_BREAKAWAY_OK = 0x00000800
JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000


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


def _win_kernel32():
    global _WIN_KERNEL32
    if _WIN_KERNEL32 is not None:
        return _WIN_KERNEL32
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel32.OpenProcess.argtypes = [ctypes.c_uint32, ctypes.c_int, ctypes.c_uint32]
    kernel32.OpenProcess.restype = ctypes.c_void_p
    kernel32.GetExitCodeProcess.argtypes = [ctypes.c_void_p, ctypes.POINTER(ctypes.c_ulong)]
    kernel32.GetExitCodeProcess.restype = ctypes.c_int
    kernel32.CreateJobObjectW.argtypes = [ctypes.c_void_p, ctypes.c_wchar_p]
    kernel32.CreateJobObjectW.restype = ctypes.c_void_p
    kernel32.SetInformationJobObject.argtypes = [ctypes.c_void_p, ctypes.c_int, ctypes.c_void_p, ctypes.c_uint32]
    kernel32.SetInformationJobObject.restype = ctypes.c_int
    kernel32.AssignProcessToJobObject.argtypes = [ctypes.c_void_p, ctypes.c_void_p]
    kernel32.AssignProcessToJobObject.restype = ctypes.c_int
    kernel32.IsProcessInJob.argtypes = [ctypes.c_void_p, ctypes.c_void_p, ctypes.POINTER(ctypes.c_int)]
    kernel32.IsProcessInJob.restype = ctypes.c_int
    kernel32.TerminateJobObject.argtypes = [ctypes.c_void_p, ctypes.c_uint32]
    kernel32.TerminateJobObject.restype = ctypes.c_int
    kernel32.CloseHandle.argtypes = [ctypes.c_void_p]
    kernel32.CloseHandle.restype = ctypes.c_int
    _WIN_KERNEL32 = kernel32
    return kernel32


def _win_ntdll():
    global _WIN_NTDLL
    if _WIN_NTDLL is not None:
        return _WIN_NTDLL
    ntdll = ctypes.WinDLL("ntdll", use_last_error=True)
    ntdll.NtResumeProcess.argtypes = [ctypes.c_void_p]
    ntdll.NtResumeProcess.restype = ctypes.c_int32
    _WIN_NTDLL = ntdll
    return ntdll


class _WindowsSmokeJob:
    """Anonymous Windows Job Object confining packaged smoke cleanup to test-spawned processes."""

    def __init__(self, handle: int, kernel32, ntdll):
        self._handle: int | None = handle
        self._kernel32 = kernel32
        self._ntdll = ntdll
        self._assigned = False

    @classmethod
    def create(cls, *, kernel32=None, ntdll=None) -> "_WindowsSmokeJob":
        api = _win_kernel32() if kernel32 is None else kernel32
        nt_api = _win_ntdll() if ntdll is None else ntdll
        handle = api.CreateJobObjectW(None, None)
        if not handle:
            raise RuntimeError("Could not create Windows Job Object for packaged service smoke")
        info = _JobObjectExtendedLimitInformation()
        info.BasicLimitInformation.LimitFlags = (
            JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | JOB_OBJECT_LIMIT_BREAKAWAY_OK
        )
        ok = api.SetInformationJobObject(
            ctypes.c_void_p(handle),
            JOB_OBJECT_EXTENDED_LIMIT_INFO_CLASS,
            ctypes.byref(info),
            ctypes.sizeof(info),
        )
        if not ok:
            api.CloseHandle(ctypes.c_void_p(handle))
            raise RuntimeError("Could not configure Windows Job Object for packaged service smoke")
        return cls(int(handle), api, nt_api)

    def assign(self, process) -> bool:
        if self._handle is None:
            return False
        proc_handle = int(getattr(process, "_handle", 0) or 0)
        if not proc_handle:
            return False
        ok = self._kernel32.AssignProcessToJobObject(
            ctypes.c_void_p(self._handle),
            ctypes.c_void_p(proc_handle),
        )
        if not ok:
            return False
        self._assigned = True
        return True

    def resume(self, process) -> bool:
        proc_handle = int(getattr(process, "_handle", 0) or 0)
        if not proc_handle:
            return False
        return int(self._ntdll.NtResumeProcess(ctypes.c_void_p(proc_handle))) >= 0

    def contains_pid(self, pid: int) -> bool:
        if self._handle is None or pid <= 0:
            return False
        proc_handle = self._kernel32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, int(pid))
        if not proc_handle:
            return False
        try:
            in_job = ctypes.c_int(0)
            ok = self._kernel32.IsProcessInJob(
                ctypes.c_void_p(proc_handle),
                ctypes.c_void_p(self._handle),
                ctypes.byref(in_job),
            )
            return bool(ok and in_job.value)
        finally:
            self._kernel32.CloseHandle(ctypes.c_void_p(proc_handle))

    def run_command(
        self,
        cmd: list[str],
        *,
        env: dict[str, str],
        timeout: int,
        popen_fn=subprocess.Popen,
    ) -> subprocess.CompletedProcess[str]:
        flags = getattr(subprocess, "CREATE_SUSPENDED", CREATE_SUSPENDED) | getattr(
            subprocess, "CREATE_NO_WINDOW", CREATE_NO_WINDOW
        )
        proc = popen_fn(
            cmd,
            env=env,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            errors="replace",
            creationflags=flags,
        )
        try:
            if not self.assign(proc):
                proc.kill()
                proc.communicate(timeout=5)
                raise RuntimeError("Could not assign packaged service command to Windows Job Object")
            if not self.resume(proc):
                proc.kill()
                proc.communicate(timeout=5)
                raise RuntimeError("Could not resume packaged service command in Windows Job Object")
            stdout, stderr = proc.communicate(timeout=timeout)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.communicate(timeout=5)
            raise
        return subprocess.CompletedProcess(cmd, proc.returncode, stdout, stderr)

    def close(self, *, terminate: bool = False) -> None:
        handle, self._handle = self._handle, None
        if handle is None:
            return
        try:
            if terminate and self._assigned:
                self._kernel32.TerminateJobObject(ctypes.c_void_p(handle), 1)
        finally:
            self._kernel32.CloseHandle(ctypes.c_void_p(handle))


def _same_path(first: Path, second: Path) -> bool:
    return os.path.normcase(str(Path(first).resolve())) == os.path.normcase(str(Path(second).resolve()))


def _path_within(candidate: Path, parent: Path) -> bool:
    norm_candidate = Path(os.path.normcase(str(Path(candidate).resolve())))
    norm_parent = Path(os.path.normcase(str(Path(parent).resolve())))
    return norm_candidate == norm_parent or norm_candidate.is_relative_to(norm_parent)


def service_executables(executable: Path, *, platform: str = sys.platform) -> tuple[Path, Path]:
    """Return ``(cli_executable, gui_executable)`` for the packaged build."""
    executable = Path(executable).resolve()
    if platform == "win32":
        cli = executable if executable.name.lower() == "super-md-cli.exe" else executable.with_name("super-md-cli.exe")
        gui = executable if executable.name.lower() == "super-md.exe" else executable.with_name("super-md.exe")
        if not cli.is_file() or not gui.is_file():
            raise RuntimeError(f"Packaged Windows build must include both {gui} and {cli}")
        return cli.resolve(), gui.resolve()
    if not executable.is_file():
        raise RuntimeError(f"Packaged executable does not exist: {executable}")
    return executable, executable


def service_appdata_path(root: Path, env: dict[str, str], *, platform: str = sys.platform) -> tuple[Path, dict[str, str]]:
    """Build an isolated environment and expected Qt ``AppDataLocation`` under ``root``."""
    root = Path(root).resolve()
    home = root / "service-home"
    data = root / "service-data"
    config = root / "service-config"
    cache = root / "service-cache"
    for directory in (home, data, config, cache):
        directory.mkdir(parents=True, exist_ok=True)
    service_env = dict(
        env,
        HOME=str(home),
        XDG_DATA_HOME=str(data),
        XDG_CONFIG_HOME=str(config),
        XDG_CACHE_HOME=str(cache),
        QML_DISK_CACHE_PATH=str(cache / "qmlcache"),
        QT_QUICK_BACKEND="software",
    )
    service_env.pop(APPDATA_OVERRIDE_ENV, None)
    service_env.pop("CFFIXED_USER_HOME", None)
    service_env.pop("QT_WAYLAND_CLIENT_BUFFER_INTEGRATION", None)
    if platform == "darwin":
        for sub in ("Library/Application Support", "Library/Caches", "Library/Preferences"):
            (home / sub).mkdir(parents=True, exist_ok=True)
        service_env["CFFIXED_USER_HOME"] = str(home)
        return (home / "Library/Application Support/SuperMD/super-md").resolve(), service_env
    if platform == "win32":
        roaming = home / "AppData/Roaming"
        local = home / "AppData/Local"
        temp = root / "service-temp"
        for directory in (roaming, local, temp):
            directory.mkdir(parents=True, exist_ok=True)
        appdata = (roaming / "SuperMD/super-md").resolve()
        service_env["USERPROFILE"] = str(home)
        service_env["APPDATA"] = str(roaming)
        service_env["LOCALAPPDATA"] = str(local)
        service_env["TEMP"] = str(temp)
        service_env["TMP"] = str(temp)
        service_env[APPDATA_OVERRIDE_ENV] = str(appdata)
        return appdata, service_env
    return (data / "SuperMD/super-md").resolve(), service_env


def _pid_alive(pid: int) -> bool:
    if pid <= 0:
        return False
    if os.name == "nt":
        kernel32 = _win_kernel32()
        handle = kernel32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, int(pid))
        if not handle:
            return False
        try:
            exit_code = ctypes.c_ulong()
            if not kernel32.GetExitCodeProcess(ctypes.c_void_p(handle), ctypes.byref(exit_code)):
                return False
            return exit_code.value == STILL_ACTIVE
        finally:
            kernel32.CloseHandle(ctypes.c_void_p(handle))
    try:
        os.kill(int(pid), 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True


def _pgid_alive(pgid: int) -> bool:
    if os.name == "nt" or pgid <= 0:
        return False
    try:
        os.killpg(int(pgid), 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True


def _read_lock_pid(appdata: Path) -> tuple[int, int | None]:
    lock_file = appdata / "native-instance.lock"
    lines = lock_file.read_text(encoding="utf-8").splitlines()
    if not lines or not lines[0].strip().isdigit():
        raise RuntimeError(f"Expected numeric PID in {lock_file}, got {lines[:1]!r}")
    pid = int(lines[0].strip())
    pgid = None
    if os.name != "nt":
        try:
            pgid = os.getpgid(pid)
        except OSError:
            pgid = None
    return pid, pgid


def _linux_pid_has_token(pid: int, token: str) -> bool | None:
    if not sys.platform.startswith("linux") or pid <= 0 or not token:
        return None
    try:
        raw = Path(f"/proc/{pid}/environ").read_bytes()
    except OSError:
        return None
    expected = f"{SMOKE_RUN_ID_ENV}={token}".encode("ascii")
    return expected in raw.split(b"\x00")


def _linux_pids_with_token(token: str) -> list[tuple[int, int | None]]:
    if not sys.platform.startswith("linux") or not token:
        return []
    proc_root = Path("/proc")
    if not proc_root.is_dir():
        return []
    expected = f"{SMOKE_RUN_ID_ENV}={token}".encode("ascii")
    own_pid = os.getpid()
    own_uid = os.getuid()
    matches: list[tuple[int, int | None]] = []
    try:
        entries = list(proc_root.iterdir())
    except OSError:
        return []
    for entry in entries:
        if not entry.name.isdigit():
            continue
        pid = int(entry.name)
        if pid <= 0 or pid == own_pid:
            continue
        try:
            if entry.stat().st_uid != own_uid:
                continue
            raw = (entry / "environ").read_bytes()
        except OSError:
            continue
        if expected not in raw.split(b"\x00"):
            continue
        try:
            pgid = os.getpgid(pid)
        except OSError:
            pgid = None
        matches.append((pid, pgid))
    return matches


def _stop_process_tree(pid: int | None, pgid: int | None) -> None:
    if os.name == "nt":
        if not pid or not _pid_alive(pid):
            return
        subprocess.run(["taskkill", "/PID", str(pid)], capture_output=True, check=False, timeout=10)
        deadline = time.monotonic() + 5.0
        while time.monotonic() < deadline and _pid_alive(pid):
            time.sleep(0.1)
        if _pid_alive(pid):
            subprocess.run(["taskkill", "/PID", str(pid), "/T", "/F"], capture_output=True, check=False, timeout=10)
            force_deadline = time.monotonic() + 5.0
            while time.monotonic() < force_deadline and _pid_alive(pid):
                time.sleep(0.1)
        return
    own_pgid = os.getpgrp()
    if pgid and pgid != own_pgid and _pgid_alive(pgid):
        try:
            os.killpg(int(pgid), signal.SIGTERM)
        except OSError:
            pass
    if pid and _pid_alive(pid):
        try:
            os.kill(int(pid), signal.SIGTERM)
        except OSError:
            pass
    deadline = time.monotonic() + 5.0
    while time.monotonic() < deadline:
        pid_running = bool(pid and _pid_alive(pid))
        pgid_running = bool(pgid and pgid != own_pgid and _pgid_alive(pgid))
        if not pid_running and not pgid_running:
            return
        time.sleep(0.1)
    if pgid and pgid != own_pgid and _pgid_alive(pgid):
        try:
            os.killpg(int(pgid), signal.SIGKILL)
        except OSError:
            pass
    elif pid and _pid_alive(pid):
        try:
            os.kill(int(pid), signal.SIGKILL)
        except OSError:
            pass
    kill_deadline = time.monotonic() + 3.0
    while time.monotonic() < kill_deadline:
        if not (pid and _pid_alive(pid)) and not (pgid and pgid != own_pgid and _pgid_alive(pgid)):
            return
        time.sleep(0.05)


class _OwnedSmokeTracker:
    """Tracks only daemon processes spawned by this smoke run for safe cleanup."""

    def __init__(
        self,
        root: Path,
        appdata: Path,
        *,
        smoke_token: str,
        spawn_log: Path,
        win_job: _WindowsSmokeJob | None = None,
    ):
        self.root = root
        self.appdata = appdata
        self.smoke_token = smoke_token
        self.spawn_log = spawn_log
        self.win_job = win_job
        self.owned_pids: dict[int, int | None] = {}
        self.retired_pids: set[int] = set()

    def sync_spawn_log(self) -> None:
        if self.spawn_log.is_symlink() or not self.spawn_log.is_file():
            return
        own_pid = os.getpid()
        try:
            lines = self.spawn_log.read_text(encoding="utf-8", errors="replace").splitlines()
        except OSError:
            return
        for line in lines:
            if not line.strip():
                continue
            try:
                entry = json.loads(line)
            except ValueError:
                continue
            if not isinstance(entry, dict) or entry.get("token") != self.smoke_token:
                continue
            pid = entry.get("pid")
            if not isinstance(pid, int) or isinstance(pid, bool) or pid <= 0 or pid == own_pid:
                continue
            if pid in self.retired_pids:
                continue
            if self.win_job is not None and _pid_alive(pid) and not self.win_job.contains_pid(pid):
                continue
            raw_pgid = entry.get("pgid")
            pgid = raw_pgid if isinstance(raw_pgid, int) and not isinstance(raw_pgid, bool) and raw_pgid > 0 else None
            self.owned_pids.setdefault(pid, pgid)

    def is_owned_daemon(self, pid: int, pgid: int | None) -> bool:
        if pid <= 0 or pid == os.getpid():
            return False
        self.sync_spawn_log()
        if os.name == "nt":
            if self.win_job is not None and not self.win_job.contains_pid(pid):
                return False
            return pid in self.owned_pids
        own_pgid = os.getpgrp()
        spawn_match = pid in self.owned_pids or (
            pgid is not None
            and pgid != own_pgid
            and (
                pgid in self.owned_pids
                or any(rec_pgid == pgid for rec_pgid in self.owned_pids.values() if rec_pgid is not None)
            )
        )
        if not spawn_match:
            return False
        token_match = _linux_pid_has_token(pid, self.smoke_token)
        if token_match is False:
            return False
        return True

    def verify_started(
        self,
        started: dict[str, object],
        *,
        expected_action: str,
        log_tail_fn,
    ) -> tuple[Path, int, int | None]:
        start_result = started.get("result") if isinstance(started.get("result"), dict) else {}
        if (
            not started.get("ok")
            or start_result.get("running") is not True
            or start_result.get("action") != expected_action
        ):
            raise RuntimeError(f"Packaged service failed to start: {started}{log_tail_fn()}")
        expected_sessions = (self.appdata / "qt-studio" / "agent-sessions").resolve()
        sessions_raw = str(start_result.get("sessionsDirectory", ""))
        sessions_dir = Path(sessions_raw).resolve() if sessions_raw else Path()
        if not sessions_raw or not _same_path(sessions_dir, expected_sessions):
            raise RuntimeError(f"Packaged service used unexpected sessionsDirectory {sessions_dir} != {expected_sessions}")
        session_files = list(expected_sessions.glob("*.json"))
        if len(session_files) != 1:
            raise RuntimeError(f"Expected 1 live discovery session file in {expected_sessions}")
        try:
            session_info = json.loads(session_files[0].read_text(encoding="utf-8"))
        except (OSError, ValueError) as error:
            raise RuntimeError(f"Invalid live discovery session file {session_files[0]}: {error}") from error
        discovery_pid = session_info.get("pid") if isinstance(session_info, dict) else None
        if not isinstance(discovery_pid, int) or isinstance(discovery_pid, bool) or discovery_pid <= 0:
            raise RuntimeError(f"Expected numeric daemon pid in {session_files[0]}, got {discovery_pid!r}")
        lock_pid, lock_pgid = _read_lock_pid(self.appdata)
        if lock_pid != discovery_pid:
            raise RuntimeError(
                f"Packaged service lock PID {lock_pid} did not match live discovery PID {discovery_pid}"
            )
        if not self.is_owned_daemon(lock_pid, lock_pgid):
            raise RuntimeError(
                f"Refusing to adopt unowned process {lock_pid} from {self.appdata / 'native-instance.lock'}"
            )
        if not _pid_alive(lock_pid):
            raise RuntimeError(f"Packaged service PID {lock_pid} is not alive after start{log_tail_fn()}")
        self.owned_pids[lock_pid] = lock_pgid
        return expected_sessions, lock_pid, lock_pgid

    def mark_stopped(self, pid: int, pgid: int | None) -> None:
        self.retired_pids.add(pid)
        self.owned_pids.pop(pid, None)
        if pgid is not None:
            for candidate_pid, candidate_pgid in list(self.owned_pids.items()):
                if candidate_pgid == pgid and not _pid_alive(candidate_pid):
                    self.retired_pids.add(candidate_pid)
                    self.owned_pids.pop(candidate_pid, None)

    def cleanup(self) -> None:
        self.sync_spawn_log()
        for tok_pid, tok_pgid in _linux_pids_with_token(self.smoke_token):
            if tok_pid not in self.retired_pids:
                self.owned_pids.setdefault(tok_pid, tok_pgid)
        try:
            for pid, pgid in list(self.owned_pids.items()):
                if os.name == "nt":
                    if self.win_job is None or self.win_job.contains_pid(pid):
                        _stop_process_tree(pid, None)
                else:
                    _stop_process_tree(pid, pgid)
        finally:
            if self.win_job is not None:
                self.win_job.close(terminate=True)
                if os.name == "nt" and self.owned_pids:
                    wait_deadline = time.monotonic() + 3.0
                    while time.monotonic() < wait_deadline and any(
                        _pid_alive(pid) for pid in self.owned_pids
                    ):
                        time.sleep(0.05)


def check_service_smoke(executable: Path, root: Path, env: dict[str, str]) -> dict[str, object]:
    """Verify packaged service start, status, note forwarding, and clean stop in disposable state."""
    root = Path(root).resolve()
    root.mkdir(parents=True, exist_ok=True)
    cli_exe, gui_exe = service_executables(executable)
    appdata, service_env = service_appdata_path(root, env)
    if not _path_within(appdata, root):
        raise RuntimeError(f"Refusing packaged service smoke outside disposable root: {appdata} not in {root}")
    smoke_token = os.urandom(16).hex()
    spawn_log = root / "spawned-daemons.jsonl"
    service_env[SMOKE_RUN_ID_ENV] = smoke_token
    service_env[SMOKE_SPAWN_LOG_ENV] = str(spawn_log)
    win_job = _WindowsSmokeJob.create() if os.name == "nt" else None
    tracker = _OwnedSmokeTracker(
        root,
        appdata,
        smoke_token=smoke_token,
        spawn_log=spawn_log,
        win_job=win_job,
    )

    def service_log_tail() -> str:
        log_file = appdata / "background-service.log"
        if not log_file.is_file():
            return ""
        return "\n--- background-service.log ---\n" + log_file.read_text(encoding="utf-8", errors="replace")[-4000:]

    def run_service(exe: Path, *cmd_args: object, timeout: int = 60) -> subprocess.CompletedProcess[str]:
        cmd = [str(exe), *map(str, cmd_args)]
        if win_job is not None:
            proc = win_job.run_command(cmd, env=service_env, timeout=timeout)
        else:
            proc = subprocess.run(
                cmd,
                env=service_env,
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                timeout=timeout,
            )
        if proc.returncode:
            raise RuntimeError(
                f"Packaged service command failed ({proc.returncode}): {(exe.name, *cmd_args)}\n"
                f"{proc.stdout}\n{proc.stderr}{service_log_tail()}"
            )
        return proc

    def run_cli_json(*cmd_args: object, timeout: int = 60) -> dict[str, object]:
        proc = run_service(cli_exe, *cmd_args, timeout=timeout)
        try:
            payload = json.loads(proc.stdout)
        except ValueError as error:
            raise RuntimeError(f"Expected JSON from {cmd_args}, got: {proc.stdout!r}\n{proc.stderr}") from error
        if not isinstance(payload, dict):
            raise RuntimeError(f"Expected JSON object from {cmd_args}, got: {payload!r}")
        return payload

    try:
        settings_path = appdata / "qt-studio" / "settings.json"
        settings_path.parent.mkdir(parents=True, exist_ok=True)
        settings_path.write_text(
            json.dumps({
                "settings": {
                    "keepInBackground": True,
                    "agentAccessEnabled": True,
                    "welcomed": True,
                    "checkUpdates": False,
                },
                "recent": [],
                "pinned": [],
            }),
            encoding="utf-8",
        )

        initial = run_cli_json("agent", "service", "status", timeout=30)
        if initial != {"ok": True, "result": {"running": False, "action": "status"}}:
            raise RuntimeError(f"Unexpected initial packaged service status: {initial}")

        started = run_cli_json("agent", "service", "start", timeout=60)
        sessions_dir, active_pid, active_pgid = tracker.verify_started(
            started, expected_action="start", log_tail_fn=service_log_tail
        )

        status = run_cli_json("agent", "service", "status", timeout=30)
        if status != {"ok": True, "result": {"running": True, "action": "status", "agentAccess": True}}:
            raise RuntimeError(f"Unexpected running packaged service status: {status}")

        stopped = run_cli_json("agent", "service", "stop", timeout=30)
        if stopped != {"ok": True, "result": {"running": False, "action": "stop", "quitRequested": True}}:
            raise RuntimeError(f"Unexpected headless packaged service stop response: {stopped}")
        if list(sessions_dir.glob("*.json")):
            raise RuntimeError("Packaged service stop did not revoke live discovery session files")

        stop_deadline = time.monotonic() + 15.0
        clean_exit = False
        own_pgid = os.getpgrp() if os.name != "nt" else None
        while time.monotonic() < stop_deadline:
            lock_gone = not (appdata / "native-instance.lock").exists()
            pid_gone = not _pid_alive(active_pid)
            pgid_gone = os.name == "nt" or active_pgid in (None, own_pgid) or not _pgid_alive(active_pgid)
            if lock_gone and pid_gone and pgid_gone:
                post_stop = run_cli_json("agent", "service", "status", timeout=30)
                if post_stop == {"ok": True, "result": {"running": False, "action": "status"}}:
                    clean_exit = True
                    break
            time.sleep(0.1)
        if not clean_exit:
            raise RuntimeError(f"Packaged service daemon (pid={active_pid}) did not exit cleanly after stop{service_log_tail()}")
        first_pid = active_pid
        tracker.mark_stopped(active_pid, active_pgid)

        forwarded_note = root / "Forwarded service note.md"
        forwarded_body = "# Forwarded service note\n\nPackaged IPC handoff: $e^{i\\pi} + 1 = 0$.\n"
        forwarded_note.write_text(forwarded_body, encoding="utf-8")

        restarted = run_cli_json("agent", "service", "start", timeout=60)
        sessions_dir, active_pid, active_pgid = tracker.verify_started(
            restarted, expected_action="start", log_tail_fn=service_log_tail
        )
        if active_pid == first_pid:
            raise RuntimeError(f"Expected fresh daemon PID after stop->start, still got {active_pid}")

        run_service(gui_exe, forwarded_note, timeout=60)
        resolved_note = str(forwarded_note.resolve())
        forward_deadline = time.monotonic() + 15.0
        forwarded_tab: dict[str, object] | None = None
        while time.monotonic() < forward_deadline:
            listed = run_cli_json("agent", "live", "--sessions-dir", sessions_dir, "list", timeout=15)
            tabs = (listed.get("result") or {}).get("tabs", []) if isinstance(listed.get("result"), dict) else []
            matched = next(
                (
                    tab for tab in tabs
                    if isinstance(tab, dict)
                    and (tab.get("title") == forwarded_note.name or str(tab.get("path") or "") == resolved_note)
                ),
                None,
            )
            if matched is not None:
                forwarded_tab = matched
                break
            time.sleep(0.1)
        if forwarded_tab is None or not isinstance(forwarded_tab.get("id"), str):
            raise RuntimeError(f"Forwarded note did not appear in packaged live session tabs{service_log_tail()}")

        read_back = run_cli_json(
            "agent", "live", "--sessions-dir", sessions_dir, "read", forwarded_tab["id"], "--view", "source", timeout=15
        )
        read_result = read_back.get("result") if isinstance(read_back.get("result"), dict) else {}
        if not read_back.get("ok") or read_result.get("markdown") != forwarded_body:
            raise RuntimeError(f"Forwarded note source mismatch in packaged live session: {read_back}")

        open_window_stop = run_cli_json("agent", "service", "stop", timeout=30)
        if open_window_stop != {"ok": True, "result": {"running": False, "action": "stop", "quitRequested": False}}:
            raise RuntimeError(
                f"Expected service stop with visible forwarded window to preserve open window: {open_window_stop}"
            )
        if not _pid_alive(active_pid):
            raise RuntimeError("Service stop unexpectedly killed visible GUI window after note forwarding")

        return {"serviceSmoke": True, "forwardedNote": forwarded_note.name}
    finally:
        tracker.cleanup()



def check(executable: Path, version: str, graphics: str) -> None:
    executable = executable.resolve()
    if sys.platform == "darwin":
        require_macos_qtwebengine_process(executable.parents[2])
    folder = tempfile.mkdtemp(prefix="supermd-packaged-check-")
    try:
        root = Path(folder)
        env = dict(os.environ, XDG_CONFIG_HOME=str(root / "config"),
                   XDG_DATA_HOME=str(root / "data"), XDG_CACHE_HOME=str(root / "cache"),
                   APPIMAGE_EXTRACT_AND_RUN="1")
        env.pop("PYTHONPATH", None)
        env.pop("PYTHONHOME", None)
        for name in ("QT_QUICK_BACKEND", "QSG_RHI_BACKEND", "QTWEBENGINE_CHROMIUM_FLAGS"):
            env.pop(name, None)
        if graphics == "missing-wayland-egl":
            env["QT_QPA_PLATFORM"] = "wayland"
            env["QT_WAYLAND_CLIENT_BUFFER_INTEGRATION"] = "missing-supermd-egl"

        def run(*args, timeout=180):
            result = subprocess.run([str(executable), *map(str,args)], env=env,
                                    capture_output=True, text=True, timeout=timeout)
            if result.returncode:
                raise RuntimeError(f"Packaged command failed ({result.returncode}): {args}\n{result.stdout}\n{result.stderr}")
            return result

        identity = run("--version")
        # Windowed Windows builds may have no stdout. GUI/report and CLI outputs
        # below remain mandatory; they cannot succeed by merely exiting early.
        if identity.stdout.strip() and f"Super MD {version}" not in identity.stdout:
            raise RuntimeError(f"Unexpected packaged version: {identity.stdout}")
        # CI Python's compiled OpenSSL paths may not exist on the destination
        # machine. Exercise the frozen interpreter with those paths unavailable,
        # not the developer's Python or a runner's conveniently installed roots.
        tls_output = root / "tls-result.json"
        saved_env = env.copy()
        try:
            env["SSL_CERT_FILE"] = str(root / "absent-host-ca.pem")
            env["SSL_CERT_DIR"] = str(root / "absent-host-ca-directory")
            run("--tls-probe", tls_output, timeout=30)
        finally:
            env.clear()
            env.update(saved_env)
        tls_evidence = json.loads(tls_output.read_text(encoding="utf-8"))
        if not tls_evidence.get("checkHostname") or not tls_evidence.get("verifyRequired") or tls_evidence.get("x509_ca",0) <= 20:
            raise RuntimeError(f"Packaged verified TLS trust store failed: {tls_evidence}")
        run("doctor")
        note = root / "Fresh machine.md"
        (root / "figure.svg").write_text('<svg xmlns="http://www.w3.org/2000/svg" width="80" height="40" viewBox="0 0 80 40"><rect width="80" height="40" fill="#3476ad"/></svg>',encoding='utf-8')
        note.write_text("# Fresh machine\n\nMath: $E=mc^2$.\n\n"
                        "Native symbols: $x\\circledast_N h$, $\\oplus\\otimes\\partial\\hbar$; "
                        "literal $\\text{ast.circle}$.\n\n"
                        "> [!tip] Portable\n> A local check.\n\n"
                        "| Name | Value |\n|---|---|\n| x | $x^2$ |\n\n![Embedded figure](figure.svg)\n", encoding="utf-8")
        portable, pdf = root / "Fresh machine.smd", root / "Fresh machine.pdf"
        run("pack", note, portable)
        encoded = portable.read_bytes()
        if not encoded.startswith(b"\x1f\x8b"):
            raise RuntimeError("Portable CLI must produce compressed SMD by default")
        packed = json.loads(gzip.decompress(encoded))
        if packed["format"] != "supermd-smd" or len(packed["assets"]) != 1:
            raise RuntimeError("Portable CLI did not produce a valid note")
        run("export", portable, pdf)
        legacy = root / "Legacy portable.fmd"
        legacy.write_text(json.dumps({**packed, "format":"supermd-fmd"}), encoding="utf-8")
        run("inspect", legacy)
        if not pdf.read_bytes().startswith(b"%PDF-") or pdf.stat().st_size < 10000:
            raise RuntimeError("Packaged native math/PDF engine failed")
        report = root / "presented.json"
        theme=root/"Smoke theme.json"
        theme.write_text(json.dumps({"format":"supermd-theme","version":1,"name":"Packaged theme check","accent":"violet","variants":{"light":{"colors":{},"background":{"pattern":"dots","color":"#7255a5","opacity":.05,"spacing":24}}},"metrics":{"headingWeight":800,"controlRadius":16}}),encoding="utf-8")
        theme_data=json.loads(theme.read_text(encoding="utf-8"))
        art='<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 300"><circle cx="280" cy="90" r="65" fill="#665599"/><path d="M0 250L250 0" stroke="#aa6677" stroke-width="4"/></svg>'
        theme_data["variants"]["light"]["artwork"]={"reader":{"image":"data:image/svg+xml;base64,"+base64.b64encode(art.encode()).decode(),"opacity":.08,"fit":"cover"}}
        theme.write_text(json.dumps(theme_data),encoding="utf-8")
        args = ["--test-state", "--smoke", "--smoke-theme",str(theme),"--smoke-report", str(report), "--quit-after", "40000"]
        if graphics == "software":
            args.append("--safe-graphics")
        result = run(*args, timeout=60)
        if not report.exists():
            raise RuntimeError(f"No presented-pixel evidence from packaged app\n{result.stdout}\n{result.stderr}")
        evidence = json.loads(report.read_text(encoding="utf-8"))
        if not evidence.get("ok") or evidence.get("readerColors",0) <= 20:
            raise RuntimeError(f"Document did not paint: {evidence}")
        if evidence.get("theme")!="Packaged theme check":raise RuntimeError("Packaged custom-theme validator or native/reader bridge failed")
        if '"themeArt":true' not in evidence.get("content",""):raise RuntimeError("Packaged embedded theme artwork did not reach the reader")
        if '"mermaid":1' not in evidence.get("content",""):raise RuntimeError("Packaged fallback Mermaid sandbox did not render in the Qt reader")
        if graphics != "auto" and evidence.get("software") is not True:
            raise RuntimeError("Required graphics fallback was not selected")
        service_evidence = check_service_smoke(executable, root, env)
        print(json.dumps({"executable":str(executable),"version":version,"graphics":graphics,
                          "software":evidence.get("software"),
                          "readerColors":evidence['readerColors'],"pdfBytes":pdf.stat().st_size,
                          "trustedCAsWithoutHostPaths":tls_evidence['x509_ca'],
                          "serviceSmoke":service_evidence["serviceSmoke"]}))
    finally:
        shutil.rmtree(folder, ignore_errors=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("executable",type=Path)
    parser.add_argument("version")
    parser.add_argument("--graphics",choices=("auto","software","missing-wayland-egl"),default="software")
    args = parser.parse_args()
    check(args.executable,args.version,args.graphics)
