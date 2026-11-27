"""Verify desktop subpackage scaffolding, core.paths, nested discovery, and standalone check_packaged.py."""
from __future__ import annotations

import ast
import importlib
import os
import runpy
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from core.paths import (
    APPDATA_OVERRIDE_ENV,
    DESKTOP_DIR,
    RESOURCE_ROOT,
    SOURCE_ROOT,
    appdata_root,
    configured_appdata_root,
    resource_root,
)


class SubpackagePathsTest(unittest.TestCase):
    def test_subpackage_scaffolding_omits_desktop_root_init(self) -> None:
        self.assertFalse((DESKTOP_DIR / "__init__.py").exists())
        for package_name in ("core", "ui", "agent", "tests", "scripts"):
            init_file = DESKTOP_DIR / package_name / "__init__.py"
            self.assertTrue(init_file.is_file(), f"Missing {init_file}")
            module = importlib.import_module(package_name)
            self.assertEqual(Path(module.__file__).resolve(), init_file.resolve())
        for entry_script in (
            "main.py",
            "package.py",
            "run_tests.py",
            "agent_cli.py",
            "check_packaged.py",
            "check_packaged_mcp.py",
            "check_bundled_python.py",
            "check_update_install.py",
        ):
            self.assertTrue((DESKTOP_DIR / entry_script).is_file(), f"Missing {entry_script}")

    def test_core_paths_resolves_source_and_frozen_roots(self) -> None:
        self.assertEqual(DESKTOP_DIR, Path(__file__).resolve().parents[1])
        self.assertEqual(SOURCE_ROOT, DESKTOP_DIR.parent)
        self.assertTrue((SOURCE_ROOT / "package.json").is_file())
        self.assertEqual(RESOURCE_ROOT, SOURCE_ROOT)
        self.assertEqual(resource_root(), SOURCE_ROOT)
        with tempfile.TemporaryDirectory() as meipass:
            with (
                mock.patch.object(sys, "frozen", True, create=True),
                mock.patch.object(sys, "_MEIPASS", meipass, create=True),
            ):
                self.assertEqual(resource_root(), Path(meipass) / "resources")
            root = Path(meipass).resolve()
            fallback_appdata = root / "qt-default-appdata"
            self.assertIsNone(configured_appdata_root({}))
            self.assertEqual(
                appdata_root(writable_location_fn=lambda _loc: str(fallback_appdata), env={}),
                fallback_appdata.resolve(),
            )
            override_dir = root / "disposable-appdata"
            override_env = {APPDATA_OVERRIDE_ENV: str(override_dir)}
            self.assertEqual(configured_appdata_root(override_env), override_dir.resolve())
            self.assertEqual(
                appdata_root(
                    writable_location_fn=lambda _loc: (_ for _ in ()).throw(
                        AssertionError("writableLocation should not be called when SUPERMD_APPDATA_DIR is set")
                    ),
                    env=override_env,
                ),
                override_dir.resolve(),
            )
            with self.assertRaisesRegex(ValueError, "must be an absolute path"):
                configured_appdata_root({APPDATA_OVERRIDE_ENV: "relative/appdata"})
            override_dir.mkdir(parents=True, exist_ok=True)
            symlink_dir = root / "symlink-appdata"
            created_link = False
            try:
                symlink_dir.symlink_to(override_dir, target_is_directory=True)
                created_link = True
            except OSError as exc:
                if sys.platform == "win32" and getattr(exc, "winerror", None) == 1314:
                    proc = subprocess.run(
                        ["cmd", "/c", "mklink", "/J", str(symlink_dir), str(override_dir)],
                        capture_output=True,
                        text=True,
                        check=False,
                    )
                    created_link = proc.returncode == 0
                else:
                    raise
            if created_link:
                with self.assertRaisesRegex(ValueError, "must not be a symlink"):
                    configured_appdata_root({APPDATA_OVERRIDE_ENV: str(symlink_dir)})

    def test_run_tests_discovers_nested_tests_with_top_level_dir(self) -> None:
        captured: dict[str, object] = {}

        class _Result:
            def wasSuccessful(self) -> bool:
                return True

        class _Runner:
            def __init__(self, *args: object, **kwargs: object) -> None:
                pass

            def run(self, _suite: object) -> _Result:
                return _Result()

        def fake_discover(*args: object, **kwargs: object) -> unittest.TestSuite:
            captured["args"] = args
            captured["kwargs"] = kwargs
            return unittest.TestSuite()

        with (
            mock.patch("faulthandler.enable"),
            mock.patch("faulthandler.dump_traceback_later"),
            mock.patch("faulthandler.cancel_dump_traceback_later"),
            mock.patch("unittest.defaultTestLoader.discover", side_effect=fake_discover),
            mock.patch("unittest.TextTestRunner", _Runner),
            mock.patch.object(sys, "exit", wraps=sys.exit),
        ):
            with self.assertRaises(SystemExit) as ctx:
                runpy.run_path(str(DESKTOP_DIR / "run_tests.py"), run_name="__main__")
            self.assertEqual(ctx.exception.code, 0)

        kwargs = dict(captured["kwargs"])
        start_dir = kwargs.get("start_dir") or (captured["args"][0] if captured["args"] else None)
        self.assertEqual(Path(str(start_dir)).resolve(), DESKTOP_DIR)
        self.assertEqual(kwargs.get("pattern"), "test_*.py")
        self.assertEqual(Path(str(kwargs.get("top_level_dir"))).resolve(), DESKTOP_DIR)

        nested_suite = unittest.defaultTestLoader.discover(
            start_dir=str(DESKTOP_DIR / "tests"),
            pattern="test_*.py",
            top_level_dir=str(DESKTOP_DIR),
        )
        self.assertGreater(nested_suite.countTestCases(), 0)

    def test_check_packaged_is_stdlib_only_and_works_without_desktop_sys_path(self) -> None:
        source_path = DESKTOP_DIR / "check_packaged.py"
        tree = ast.parse(source_path.read_text(encoding="utf-8"), filename=str(source_path))
        imported_roots: set[str] = set()
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                for alias in node.names:
                    imported_roots.add(alias.name.split(".", 1)[0])
            elif isinstance(node, ast.ImportFrom):
                self.assertEqual(node.level, 0, "Relative imports are forbidden in standalone check_packaged.py")
                if node.module:
                    imported_roots.add(node.module.split(".", 1)[0])
        non_stdlib = imported_roots - sys.stdlib_module_names
        self.assertEqual(non_stdlib, set())

        with tempfile.TemporaryDirectory() as isolated_dir:
            isolated_root = Path(isolated_dir)
            checks_dir = isolated_root / "checks"
            checks_dir.mkdir()
            shutil.copy2(source_path, checks_dir / "check_packaged.py")
            probe_code = (
                "import os, pathlib, sys\n"
                f"sys.path.insert(0, {str(checks_dir)!r})\n"
                "import check_packaged\n"
                f"assert {str(DESKTOP_DIR)!r} not in [str(pathlib.Path(p).resolve()) for p in sys.path if p]\n"
                f"app = pathlib.Path({str(isolated_root / 'Super MD.app')!r})\n"
                "helper = check_packaged.macos_qtwebengine_process_path(app)\n"
                "try:\n"
                "    check_packaged.require_macos_qtwebengine_process(app)\n"
                "except RuntimeError as exc:\n"
                "    assert 'QtWebEngineProcess' in str(exc)\n"
                "else:\n"
                "    raise AssertionError('Expected missing helper error')\n"
                "helper.parent.mkdir(parents=True)\n"
                "helper.write_bytes(b'helper')\n"
                "helper.chmod(0o755)\n"
                "assert check_packaged.require_macos_qtwebengine_process(app) == helper\n"
                "win_dir = isolated_path = pathlib.Path(app.parent / 'win')\n"
                "win_dir.mkdir()\n"
                "gui_exe, cli_exe = win_dir / 'super-md.exe', win_dir / 'super-md-cli.exe'\n"
                "gui_exe.write_bytes(b'gui')\n"
                "try:\n"
                "    check_packaged.service_executables(gui_exe, platform='win32')\n"
                "except RuntimeError as exc:\n"
                "    assert 'super-md-cli.exe' in str(exc)\n"
                "else:\n"
                "    raise AssertionError('Expected missing super-md-cli.exe error')\n"
                "cli_exe.write_bytes(b'cli')\n"
                "assert check_packaged.service_executables(gui_exe, platform='win32') == (cli_exe.resolve(), gui_exe.resolve())\n"
                "assert check_packaged.service_executables(cli_exe, platform='win32') == (cli_exe.resolve(), gui_exe.resolve())\n"
                "assert check_packaged.service_executables(helper, platform='linux') == (helper.resolve(), helper.resolve())\n"
                "smoke_root = app.parent / 'smoke'\n"
                "linux_appdata, linux_env = check_packaged.service_appdata_path(\n"
                "    smoke_root / 'linux', {'CFFIXED_USER_HOME': '/bad', 'QT_WAYLAND_CLIENT_BUFFER_INTEGRATION': 'bad'}, platform='linux'\n"
                ")\n"
                "assert linux_appdata == (smoke_root / 'linux/service-data/SuperMD/super-md').resolve()\n"
                "assert linux_env['QT_QUICK_BACKEND'] == 'software'\n"
                "assert 'CFFIXED_USER_HOME' not in linux_env and 'QT_WAYLAND_CLIENT_BUFFER_INTEGRATION' not in linux_env\n"
                "mac_appdata, mac_env = check_packaged.service_appdata_path(\n"
                "    smoke_root / 'mac', {'CFFIXED_USER_HOME': '/stale'}, platform='darwin'\n"
                ")\n"
                "expected_mac_home = str((smoke_root / 'mac/service-home').resolve())\n"
                "assert mac_appdata == (smoke_root / 'mac/service-home/Library/Application Support/SuperMD/super-md').resolve()\n"
                "assert mac_env['HOME'] == expected_mac_home and mac_env['CFFIXED_USER_HOME'] == expected_mac_home\n"
                "outside_roaming = smoke_root / 'outside-roaming'\n"
                "win_appdata, win_env = check_packaged.service_appdata_path(\n"
                "    smoke_root / 'win', {'APPDATA': str(outside_roaming), 'CFFIXED_USER_HOME': '/stale'}, platform='win32'\n"
                ")\n"
                "expected_win_home = (smoke_root / 'win/service-home').resolve()\n"
                "expected_win_roaming = (expected_win_home / 'AppData/Roaming').resolve()\n"
                "expected_win_local = (expected_win_home / 'AppData/Local').resolve()\n"
                "expected_win_temp = (smoke_root / 'win/service-temp').resolve()\n"
                "assert win_appdata == (expected_win_roaming / 'SuperMD/super-md').resolve()\n"
                "assert win_env['USERPROFILE'] == str(expected_win_home)\n"
                "assert win_env['APPDATA'] == str(expected_win_roaming)\n"
                "assert win_env['LOCALAPPDATA'] == str(expected_win_local)\n"
                "assert win_env['TEMP'] == str(expected_win_temp) and win_env['TMP'] == str(expected_win_temp)\n"
                "assert win_env['QML_DISK_CACHE_PATH'] == str((smoke_root / 'win/service-cache/qmlcache').resolve())\n"
                "assert win_env['SUPERMD_APPDATA_DIR'] == str(win_appdata)\n"
                "assert not outside_roaming.exists()\n"
                "assert 'CFFIXED_USER_HOME' not in win_env\n"
            )
            env = {k: v for k, v in os.environ.items() if k != "PYTHONPATH"}
            completed = subprocess.run(
                [sys.executable, "-I", "-c", probe_code],
                cwd=isolated_root,
                env=env,
                capture_output=True,
                text=True,
                check=False,
                timeout=15,
            )
            self.assertEqual(completed.returncode, 0, completed.stdout + "\n" + completed.stderr)

    @unittest.skipIf(os.name == "nt", "POSIX process-group cleanup check")
    def test_check_service_smoke_verifies_sessions_root_before_lock_and_preserves_unowned_processes(self) -> None:
        import check_packaged

        clean_env = {
            k: v
            for k, v in os.environ.items()
            if k not in (check_packaged.SMOKE_RUN_ID_ENV, check_packaged.SMOKE_SPAWN_LOG_ENV)
        }
        external_proc = subprocess.Popen(
            [sys.executable, "-c", "import time; time.sleep(60)"],
            env=clean_env,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            start_new_session=True,
        )
        try:
            with tempfile.TemporaryDirectory() as tmp:
                root = Path(tmp).resolve()
                wrong_appdata = root / "wrong-appdata/SuperMD/super-md"
                (wrong_appdata / "qt-studio/agent-sessions").mkdir(parents=True)
                (wrong_appdata / "native-instance.lock").write_text(
                    f"{external_proc.pid}\nsuper-md\n", encoding="utf-8"
                )

                smoke_dir_a = root / "smoke-diverged"
                expected_appdata_a, _ = check_packaged.service_appdata_path(smoke_dir_a, clean_env)
                expected_appdata_a.mkdir(parents=True, exist_ok=True)
                # Invalid lock payload in expected_appdata_a proves sessionsDirectory is checked
                # before _read_lock_pid() is ever called.
                (expected_appdata_a / "native-instance.lock").write_text("not-a-numeric-pid\n", encoding="utf-8")

                spawned_marker = root / "owned-daemon.pid"
                fake_diverged_exe = root / "fake-diverged-super-md"
                fake_diverged_exe.write_text(
                    f"#!{sys.executable}\n"
                    "import json, os, subprocess, sys\n"
                    "from pathlib import Path\n"
                    f"wrong = Path({str(wrong_appdata)!r})\n"
                    f"marker = Path({str(spawned_marker)!r})\n"
                    "args = sys.argv[1:]\n"
                    "if args == ['agent', 'service', 'status']:\n"
                    "    print(json.dumps({'ok': True, 'result': {'running': False, 'action': 'status'}}))\n"
                    "    raise SystemExit(0)\n"
                    "if args == ['agent', 'service', 'start']:\n"
                    "    child_env = dict(os.environ)\n"
                    "    spawn_log = child_env.pop('SUPERMD_SMOKE_SPAWN_LOG', '')\n"
                    "    proc = subprocess.Popen(\n"
                    "        [sys.executable, '-c', 'import time; time.sleep(60)'],\n"
                    "        env=child_env,\n"
                    "        stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,\n"
                    "        start_new_session=True,\n"
                    "    )\n"
                    "    marker.write_text(str(proc.pid), encoding='utf-8')\n"
                    "    if spawn_log:\n"
                    "        with Path(spawn_log).open('a', encoding='utf-8') as handle:\n"
                    "            handle.write(json.dumps({'pid': proc.pid, 'pgid': os.getpgid(proc.pid), 'token': os.environ.get('SUPERMD_SMOKE_RUN_ID', '')}) + '\\n')\n"
                    "    sessions = wrong / 'qt-studio/agent-sessions'\n"
                    "    print(json.dumps({'ok': True, 'result': {'running': True, 'action': 'start', 'sessionsDirectory': str(sessions)}}))\n"
                    "    raise SystemExit(0)\n"
                    "raise SystemExit(1)\n",
                    encoding="utf-8",
                )
                fake_diverged_exe.chmod(0o755)
                with self.assertRaisesRegex(RuntimeError, "unexpected sessionsDirectory"):
                    check_packaged.check_service_smoke(fake_diverged_exe, smoke_dir_a, clean_env)

                owned_pid = int(spawned_marker.read_text(encoding="utf-8").strip())
                self.assertFalse(check_packaged._pid_alive(owned_pid))
                self.assertTrue(check_packaged._pid_alive(external_proc.pid))

                # Even when sessionsDirectory matches expected_sessions, an unowned PID in
                # native-instance.lock / discovery JSON is rejected and never terminated.
                smoke_dir_b = root / "smoke-unowned"
                expected_appdata_b, _ = check_packaged.service_appdata_path(smoke_dir_b, clean_env)
                expected_sessions_b = (expected_appdata_b / "qt-studio/agent-sessions").resolve()
                fake_unowned_exe = root / "fake-unowned-super-md"
                fake_unowned_exe.write_text(
                    f"#!{sys.executable}\n"
                    "import json, sys\n"
                    "from pathlib import Path\n"
                    f"appdata = Path({str(expected_appdata_b)!r})\n"
                    f"sessions = Path({str(expected_sessions_b)!r})\n"
                    f"foreign_pid = {external_proc.pid}\n"
                    "args = sys.argv[1:]\n"
                    "if args == ['agent', 'service', 'status']:\n"
                    "    print(json.dumps({'ok': True, 'result': {'running': False, 'action': 'status'}}))\n"
                    "    raise SystemExit(0)\n"
                    "if args == ['agent', 'service', 'start']:\n"
                    "    sessions.mkdir(parents=True, exist_ok=True)\n"
                    "    (sessions / 'foreign.json').write_text(json.dumps({'pid': foreign_pid}), encoding='utf-8')\n"
                    "    (appdata / 'native-instance.lock').write_text(f'{foreign_pid}\\nsuper-md\\n', encoding='utf-8')\n"
                    "    print(json.dumps({'ok': True, 'result': {'running': True, 'action': 'start', 'sessionsDirectory': str(sessions)}}))\n"
                    "    raise SystemExit(0)\n"
                    "raise SystemExit(1)\n",
                    encoding="utf-8",
                )
                fake_unowned_exe.chmod(0o755)
                with self.assertRaisesRegex(RuntimeError, "Refusing to adopt unowned process"):
                    check_packaged.check_service_smoke(fake_unowned_exe, smoke_dir_b, clean_env)
                self.assertTrue(check_packaged._pid_alive(external_proc.pid))
        finally:
            external_proc.kill()
            external_proc.wait(timeout=5)

    def test_windows_smoke_job_confines_spawned_commands_and_terminates_on_close(self) -> None:
        import ctypes
        import check_packaged

        calls: list[tuple[object, ...]] = []
        job_members = {4242}

        class _FakeKernel32:
            def CreateJobObjectW(self, attrs: object, name: object) -> int:
                calls.append(("CreateJobObjectW", attrs, name))
                return 9001

            def SetInformationJobObject(self, handle: object, info_class: int, info_ptr: object, size: int) -> int:
                info = ctypes.cast(
                    info_ptr, ctypes.POINTER(check_packaged._JobObjectExtendedLimitInformation)
                ).contents
                calls.append(("SetInformationJobObject", info_class, int(info.BasicLimitInformation.LimitFlags), size))
                return 1

            def AssignProcessToJobObject(self, job_handle: object, proc_handle: object) -> int:
                calls.append(("AssignProcessToJobObject", int(job_handle.value), int(proc_handle.value)))
                return 1

            def OpenProcess(self, access: int, inherit: int, pid: int) -> int:
                return 7000 + pid if pid > 0 else 0

            def IsProcessInJob(self, proc_handle: object, job_handle: object, out_ptr: object) -> int:
                pid = int(proc_handle.value) - 7000
                ctypes.cast(out_ptr, ctypes.POINTER(ctypes.c_int)).contents.value = 1 if pid in job_members else 0
                return 1

            def TerminateJobObject(self, handle: object, exit_code: int) -> int:
                calls.append(("TerminateJobObject", int(handle.value), exit_code))
                return 1

            def CloseHandle(self, handle: object) -> int:
                calls.append(("CloseHandle", int(handle.value)))
                return 1

        class _FakeNtdll:
            def NtResumeProcess(self, proc_handle: object) -> int:
                calls.append(("NtResumeProcess", int(proc_handle.value)))
                return 0

        class _FakeProc:
            pid = 4242
            _handle = 8123
            returncode = 0

            def communicate(self, timeout: int | None = None) -> tuple[str, str]:
                calls.append(("communicate", timeout))
                return ('{"ok": true}\n', "")

            def kill(self) -> None:
                calls.append(("kill",))

        captured_popen: dict[str, object] = {}

        def fake_popen(cmd: list[str], **kwargs: object) -> _FakeProc:
            captured_popen["cmd"] = cmd
            captured_popen["kwargs"] = kwargs
            return _FakeProc()

        job = check_packaged._WindowsSmokeJob.create(kernel32=_FakeKernel32(), ntdll=_FakeNtdll())
        completed = job.run_command(
            ["super-md-cli.exe", "agent", "service", "start"],
            env={"SUPERMD_APPDATA_DIR": "C:\\temp\\smoke"},
            timeout=30,
            popen_fn=fake_popen,
        )
        self.assertEqual(completed.returncode, 0)
        self.assertEqual(completed.stdout, '{"ok": true}\n')
        creation_flags = int(captured_popen["kwargs"]["creationflags"])
        self.assertTrue(creation_flags & check_packaged.CREATE_SUSPENDED)
        self.assertTrue(creation_flags & check_packaged.CREATE_NO_WINDOW)
        self.assertTrue(job.contains_pid(4242))
        self.assertFalse(job.contains_pid(9999))
        job.close(terminate=True)

        action_names = [entry[0] for entry in calls]
        self.assertLess(action_names.index("AssignProcessToJobObject"), action_names.index("NtResumeProcess"))
        self.assertLess(action_names.index("NtResumeProcess"), action_names.index("communicate"))
        set_info = next(entry for entry in calls if entry[0] == "SetInformationJobObject")
        self.assertEqual(set_info[1], check_packaged.JOB_OBJECT_EXTENDED_LIMIT_INFO_CLASS)
        self.assertEqual(
            set_info[2],
            check_packaged.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | check_packaged.JOB_OBJECT_LIMIT_BREAKAWAY_OK,
        )
        self.assertIn(("TerminateJobObject", 9001, 1), calls)
        self.assertIn(("CloseHandle", 9001), calls)


if __name__ == "__main__":
    unittest.main()
