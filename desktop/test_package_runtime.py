import ast
import importlib
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from package_runtime import (portable_binaries, wayland_dependencies, linux_support_binaries,
                             X11_SUPPORT, qtwebengine_framework_version, qtwebengine_framework_entries,
                             macos_qtwebengine_process_path, require_macos_qtwebengine_process)


class PackageRuntimeTest(unittest.TestCase):
    def test_linux_explicitly_bundles_xcb_helpers_but_not_graphics_driver_abi(self):
        entries=linux_support_binaries(lambda name:"/usr/lib/"+name,"linux")
        self.assertEqual(entries,[("/usr/lib/"+name,".") for name in X11_SUPPORT])
        self.assertIn("libxcb-icccm.so.4",X11_SUPPORT)
        self.assertFalse(any("libGL" in name or "libEGL" in name or "libstdc++" in name for name in X11_SUPPORT))
        self.assertEqual(linux_support_binaries(lambda _:None,"darwin"),[])
        with self.assertRaisesRegex(RuntimeError,"Missing Linux build dependency"):
            linux_support_binaries(lambda _:None,"linux")
    def test_both_linux_packages_require_wayland_client_cursor_and_server(self):
        self.assertEqual(wayland_dependencies("deb"),
                         ["libwayland-client0", "libwayland-cursor0", "libwayland-server0"])
        self.assertEqual(wayland_dependencies("rpm"),
                         ["libwayland-client.so.0()(64bit)", "libwayland-cursor.so.0()(64bit)",
                          "libwayland-server.so.0()(64bit)"])

    def test_unknown_dependency_format_is_not_silently_accepted(self):
        with self.assertRaises(ValueError):
            wayland_dependencies("windows")

    def test_linux_does_not_override_host_driver_cpp_or_unwind_libraries(self):
        host = [(name, "/build/" + name, "BINARY") for name in
                ("libstdc++.so.6", "libstdc++.so.6.0.30", "libgcc_s.so.1",
                 "nested/libstdc++.so.6")]
        application = [(name, "/build/" + name, "BINARY") for name in
                       ("libQt6Core.so.6", "libpython3.13.so.1.0", "smd-engine", "libgccjit.so.0")]
        self.assertEqual(portable_binaries(host + application, "linux"), application)
        self.assertEqual(len(host), 4)

    def test_windows_and_macos_keep_their_existing_runtime_packaging(self):
        entries = [("libstdc++.so.6", "/build/runtime", "BINARY")]
        for platform in ("win32", "darwin"):
            self.assertEqual(portable_binaries(entries, platform), entries)

    def test_macos_webengine_version_selection_ignores_resources_directory(self):
        with tempfile.TemporaryDirectory() as directory:
            framework = Path(directory) / "QtWebEngineCore.framework"
            (framework / "Versions/A").mkdir(parents=True)
            (framework / "Versions/A/QtWebEngineCore").write_bytes(b"framework binary")
            (framework / "Versions/Resources/Helpers").mkdir(parents=True)
            self.assertEqual(qtwebengine_framework_version(framework), "A")
            self.assertEqual(qtwebengine_framework_entries(["A", "Resources", "Current"], "A"),
                             ["A", "Current"])

    def test_macos_packaged_inventory_requires_webengine_process_in_framework_helper_path(self):
        with tempfile.TemporaryDirectory() as directory:
            app = Path(directory) / "Super MD.app"
            helper = macos_qtwebengine_process_path(app)
            with self.assertRaisesRegex(RuntimeError, "missing or has a non-executable"):
                require_macos_qtwebengine_process(app)
            helper.parent.mkdir(parents=True)
            helper.write_bytes(b"QtWebEngineProcess")
            helper.chmod(0o755)
            self.assertEqual(require_macos_qtwebengine_process(app), helper)
            if os.name == "posix":
                helper.chmod(0o644)
                with self.assertRaisesRegex(RuntimeError, "non-executable"):
                    require_macos_qtwebengine_process(app)

    def test_root_shim_aliases_scripts_subpackage_module_object(self):
        canonical = importlib.import_module("scripts.package_runtime")
        alias = importlib.import_module("package_runtime")
        self.assertIs(alias, canonical)
        self.assertIs(sys.modules["package_runtime"], sys.modules["scripts.package_runtime"])
        self.assertEqual(
            Path(canonical.__file__).resolve(),
            Path(__file__).resolve().parent / "scripts" / "package_runtime.py",
        )

        sys.modules.pop("package_runtime", None)
        try:
            reimported_alias = importlib.import_module("package_runtime")
            self.assertIs(reimported_alias, canonical)
            self.assertIs(sys.modules["package_runtime"], canonical)

            sys.modules.pop("package_runtime", None)
            reloaded_canonical = importlib.reload(canonical)
            reloaded_alias = importlib.import_module("package_runtime")
            self.assertIs(reloaded_alias, reloaded_canonical)
            self.assertIs(sys.modules["package_runtime"], reloaded_canonical)
        finally:
            sys.modules["package_runtime"] = sys.modules["scripts.package_runtime"]

    def test_mock_patch_on_root_alias_updates_scripts_subpackage_callers(self):
        scripts_runtime = importlib.import_module("scripts.package_runtime")
        with mock.patch("package_runtime.X11_SUPPORT", ("libxcb-test.so.0",)):
            self.assertEqual(scripts_runtime.X11_SUPPORT, ("libxcb-test.so.0",))
            self.assertEqual(
                scripts_runtime.linux_support_binaries(lambda name: f"/usr/lib/{name}", "linux"),
                [("/usr/lib/libxcb-test.so.0", ".")],
            )
        self.assertIn("libxcb-icccm.so.4", scripts_runtime.X11_SUPPORT)

    def test_pyinstaller_spec_and_hook_import_scripts_package_runtime(self):
        desktop_dir = Path(__file__).resolve().parent
        for entry_script in (
            "package.py",
            "check_packaged.py",
            "check_packaged_mcp.py",
            "check_bundled_python.py",
            "check_update_install.py",
        ):
            self.assertTrue((desktop_dir / entry_script).is_file(), f"Missing {entry_script}")

        for relative_path in (
            Path("package.py"),
            Path("super-md.spec"),
            Path("pyinstaller_hooks") / "hook-PySide6.QtWebEngineCore.py",
        ):
            target_path = desktop_dir / relative_path
            source = target_path.read_text(encoding="utf-8")
            if relative_path == Path("super-md.spec"):
                self.assertIn('pathex=[str(root / "desktop")]', source)
            imports = [
                node.module
                for node in ast.walk(ast.parse(source, filename=str(target_path)))
                if isinstance(node, ast.ImportFrom)
            ]
            self.assertIn("scripts.package_runtime", imports, f"Expected scripts.package_runtime in {relative_path}")
            self.assertNotIn("package_runtime", imports, f"Unexpected bare package_runtime in {relative_path}")

    def test_clean_subprocess_repository_root_and_flat_import_modes(self):
        desktop_dir = Path(__file__).resolve().parent
        repo_root = desktop_dir.parent
        clean_env = {k: v for k, v in os.environ.items() if k != "PYTHONPATH"}

        repo_root_probe = """
import pathlib
import runpy
import sys
import types
from unittest import mock

from desktop import package, package_runtime
import desktop as desktop_ns
import desktop.package_runtime as dotted_alias
from desktop.package_runtime import wayland_dependencies
from desktop.scripts import package_runtime as scripts_canonical

assert package_runtime is dotted_alias
assert package_runtime is scripts_canonical
assert desktop_ns.package_runtime is scripts_canonical
assert sys.modules["desktop.package_runtime"] is scripts_canonical
assert pathlib.Path(scripts_canonical.__file__).resolve().name == "package_runtime.py"
assert pathlib.Path(scripts_canonical.__file__).resolve().parent.name == "scripts"
assert wayland_dependencies("deb") == ["libwayland-client0", "libwayland-cursor0", "libwayland-server0"]
assert package.ROOT == pathlib.Path.cwd().resolve()

with mock.patch("desktop.package_runtime.X11_SUPPORT", ("libxcb-test.so.0",)):
    assert scripts_canonical.X11_SUPPORT == ("libxcb-test.so.0",)
    assert scripts_canonical.linux_support_binaries(lambda n: "/usr/lib/" + n, "linux") == [
        ("/usr/lib/libxcb-test.so.0", ".")
    ]

# Verify the flat PyInstaller hook also runs cleanly from repo root with PYTHONPATH cleared.
pyinstaller = types.ModuleType("PyInstaller")
utils = types.ModuleType("PyInstaller.utils")
hooks = types.ModuleType("PyInstaller.utils.hooks")
qt_hooks = types.ModuleType("PyInstaller.utils.hooks.qt")
qt_hooks.os = __import__("os")
qt_hooks.pyside6_library_info = types.SimpleNamespace(version=None, location={"LibrariesPath": ""})
qt_hooks.add_qt6_dependencies = lambda _hook: ([], [], [])
pyinstaller.utils = utils
utils.hooks = hooks
hooks.qt = qt_hooks
with mock.patch.dict(
    sys.modules,
    {
        "PyInstaller": pyinstaller,
        "PyInstaller.utils": utils,
        "PyInstaller.utils.hooks": hooks,
        "PyInstaller.utils.hooks.qt": qt_hooks,
    },
):
    hook_ns = runpy.run_path("desktop/pyinstaller_hooks/hook-PySide6.QtWebEngineCore.py")
    assert callable(hook_ns["qtwebengine_framework_version"])
    assert callable(hook_ns["qtwebengine_framework_entries"])
"""
        repo_completed = subprocess.run(
            [sys.executable, "-c", repo_root_probe],
            cwd=repo_root,
            env=clean_env,
            capture_output=True,
            text=True,
            check=False,
            timeout=20,
        )
        self.assertEqual(
            repo_completed.returncode,
            0,
            repo_completed.stdout + "\n" + repo_completed.stderr,
        )

        flat_probe = """
import pathlib
import sys
import tempfile
from unittest import mock

import package
import package_runtime
import scripts.package_runtime as scripts_canonical
from package_runtime import wayland_dependencies

assert package_runtime is scripts_canonical
assert sys.modules["package_runtime"] is scripts_canonical
assert wayland_dependencies("rpm") == [
    "libwayland-client.so.0()(64bit)",
    "libwayland-cursor.so.0()(64bit)",
    "libwayland-server.so.0()(64bit)",
]
assert package.ROOT == pathlib.Path.cwd().resolve().parent

with tempfile.TemporaryDirectory() as meipass:
    with (
        mock.patch.object(sys, "frozen", True, create=True),
        mock.patch.object(sys, "_MEIPASS", meipass, create=True),
    ):
        from core.paths import resource_root

        assert resource_root() == pathlib.Path(meipass) / "resources"
        assert package_runtime.portable_binaries([("libQt6Core.so.6", "/b", "BINARY")], "linux") == [
            ("libQt6Core.so.6", "/b", "BINARY")
        ]
"""
        flat_completed = subprocess.run(
            [sys.executable, "-c", flat_probe],
            cwd=desktop_dir,
            env=clean_env,
            capture_output=True,
            text=True,
            check=False,
            timeout=20,
        )
        self.assertEqual(
            flat_completed.returncode,
            0,
            flat_completed.stdout + "\n" + flat_completed.stderr,
        )


if __name__ == "__main__":
    unittest.main()
