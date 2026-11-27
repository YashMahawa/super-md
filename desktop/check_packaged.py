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
    """Build an isolated environment and expected Qt ``AppDataLocation`` for service smoke."""
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
        QT_QUICK_BACKEND="software",
    )
    service_env.pop("CFFIXED_USER_HOME", None)
    service_env.pop("QT_WAYLAND_CLIENT_BUFFER_INTEGRATION", None)
    if platform == "darwin":
        for sub in ("Library/Application Support", "Library/Caches", "Library/Preferences"):
            (home / sub).mkdir(parents=True, exist_ok=True)
        service_env["CFFIXED_USER_HOME"] = str(home)
        return (home / "Library/Application Support/SuperMD/super-md").resolve(), service_env
    if platform == "win32":
        roaming = env.get("APPDATA") or os.environ.get("APPDATA")
        if not roaming:
            raise RuntimeError("APPDATA is not set for Windows packaged service check")
        return Path(roaming).resolve() / "SuperMD/super-md", service_env
    return (data / "SuperMD/super-md").resolve(), service_env


def _pid_alive(pid: int) -> bool:
    if pid <= 0:
        return False
    if os.name == "nt":
        kernel32 = ctypes.windll.kernel32
        handle = kernel32.OpenProcess(0x1000, False, int(pid))
        if not handle:
            return False
        try:
            exit_code = ctypes.c_ulong()
            if not kernel32.GetExitCodeProcess(handle, ctypes.byref(exit_code)):
                return False
            return exit_code.value == 259
        finally:
            kernel32.CloseHandle(handle)
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


def _try_read_lock_pid(*candidates: Path) -> tuple[int | None, int | None]:
    for candidate in candidates:
        lock_file = candidate / "native-instance.lock"
        if lock_file.is_file():
            try:
                return _read_lock_pid(candidate)
            except (OSError, RuntimeError):
                continue
    return None, None


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


def check_service_smoke(executable: Path, root: Path, env: dict[str, str]) -> dict[str, object]:
    """Verify packaged service start, status, note forwarding, and clean stop in disposable state."""
    cli_exe, gui_exe = service_executables(executable)
    appdata, service_env = service_appdata_path(root, env)

    def service_log_tail() -> str:
        log_file = appdata / "background-service.log"
        if not log_file.is_file():
            return ""
        return "\n--- background-service.log ---\n" + log_file.read_text(encoding="utf-8", errors="replace")[-4000:]

    def run_service(exe: Path, *cmd_args: object, timeout: int = 60) -> subprocess.CompletedProcess[str]:
        proc = subprocess.run(
            [str(exe), *map(str, cmd_args)],
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

    win_backup: Path | None = None
    win_had_parent = appdata.parent.exists()
    if sys.platform == "win32":
        pre = run_cli_json("agent", "service", "status", timeout=30)
        pre_result = pre.get("result") if isinstance(pre.get("result"), dict) else {}
        if pre_result.get("running") or (appdata / "native-instance.lock").exists():
            raise RuntimeError("Refusing packaged service check while a Super MD instance is already running")
        if appdata.exists():
            win_backup = root / "windows-appdata-backup"
            shutil.move(str(appdata), str(win_backup))

    active_pid: int | None = None
    active_pgid: int | None = None
    try:
        settings_path = appdata / "qt-studio" / "settings.json"
        settings_path.parent.mkdir(parents=True, exist_ok=True)
        settings_path.write_text(
            json.dumps({
                "settings": {
                    "keepInBackground": True,
                    "agentAccessEnabled": True,
                    "welcomed": True,
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
        start_result = started.get("result") if isinstance(started.get("result"), dict) else {}
        sessions_raw = str(start_result.get("sessionsDirectory", ""))
        sessions_dir = Path(sessions_raw).resolve() if sessions_raw else Path()
        actual_appdata = sessions_dir.parents[1] if sessions_raw and len(sessions_dir.parents) >= 2 else appdata
        active_pid, active_pgid = _try_read_lock_pid(appdata, actual_appdata)
        if not started.get("ok") or start_result.get("running") is not True or start_result.get("action") != "start":
            raise RuntimeError(f"Packaged service failed to start: {started}{service_log_tail()}")
        expected_sessions = (appdata / "qt-studio" / "agent-sessions").resolve()
        if not sessions_raw or sessions_dir != expected_sessions:
            raise RuntimeError(f"Packaged service used unexpected sessionsDirectory {sessions_dir} != {expected_sessions}")
        if len(list(sessions_dir.glob("*.json"))) != 1:
            raise RuntimeError(f"Expected 1 live discovery session file in {sessions_dir}")
        active_pid, active_pgid = _read_lock_pid(appdata)
        if not _pid_alive(active_pid):
            raise RuntimeError(f"Packaged service PID {active_pid} is not alive after start{service_log_tail()}")

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
        active_pid, active_pgid = None, None

        forwarded_note = root / "Forwarded service note.md"
        forwarded_body = "# Forwarded service note\n\nPackaged IPC handoff: $e^{i\\pi} + 1 = 0$.\n"
        forwarded_note.write_text(forwarded_body, encoding="utf-8")

        restarted = run_cli_json("agent", "service", "start", timeout=60)
        restart_result = restarted.get("result") if isinstance(restarted.get("result"), dict) else {}
        active_pid, active_pgid = _try_read_lock_pid(appdata)
        if not restarted.get("ok") or restart_result.get("running") is not True:
            raise RuntimeError(f"Packaged service failed to restart for note forwarding: {restarted}{service_log_tail()}")
        active_pid, active_pgid = _read_lock_pid(appdata)
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
        _stop_process_tree(active_pid, active_pgid)
        if sys.platform == "win32":
            cleanup_deadline = time.monotonic() + 5.0
            while appdata.exists() and time.monotonic() < cleanup_deadline:
                shutil.rmtree(appdata, ignore_errors=True)
                if appdata.exists():
                    time.sleep(0.1)
            if win_backup is not None and win_backup.exists():
                appdata.parent.mkdir(parents=True, exist_ok=True)
                shutil.move(str(win_backup), str(appdata))
            elif not win_had_parent and appdata.parent.exists():
                try:
                    appdata.parent.rmdir()
                except OSError:
                    pass



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
