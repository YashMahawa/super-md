import ast
import importlib
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

if __package__:
    from .package_runtime import (
        X11_SUPPORT,
        linux_support_binaries,
        macos_qtwebengine_process_path,
        portable_binaries,
        qtwebengine_framework_entries,
        qtwebengine_framework_version,
        require_macos_qtwebengine_process,
        wayland_dependencies,
    )
else:
    from package_runtime import (
        X11_SUPPORT,
        linux_support_binaries,
        macos_qtwebengine_process_path,
        portable_binaries,
        qtwebengine_framework_entries,
        qtwebengine_framework_version,
        require_macos_qtwebengine_process,
        wayland_dependencies,
    )


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
        prefix = f"{__package__}." if __package__ else ""
        canonical_name = f"{prefix}scripts.package_runtime"
        alias_name = f"{prefix}package_runtime"
        canonical = importlib.import_module(canonical_name)
        alias = importlib.import_module(alias_name)
        self.assertIs(alias, canonical)
        self.assertIs(sys.modules[alias_name], sys.modules[canonical_name])
        self.assertEqual(
            Path(canonical.__file__).resolve(),
            Path(__file__).resolve().parent / "scripts" / "package_runtime.py",
        )

        def drop_alias():
            sys.modules.pop(alias_name, None)
            if __package__ and __package__ in sys.modules:
                sys.modules[__package__].__dict__.pop("package_runtime", None)

        drop_alias()
        try:
            reimported_alias = importlib.import_module(alias_name)
            self.assertIs(reimported_alias, canonical)
            self.assertIs(sys.modules[alias_name], canonical)

            drop_alias()
            reloaded_canonical = importlib.reload(canonical)
            reloaded_alias = importlib.import_module(alias_name)
            self.assertIs(reloaded_alias, reloaded_canonical)
            self.assertIs(sys.modules[alias_name], reloaded_canonical)
        finally:
            sys.modules[alias_name] = sys.modules[canonical_name]
            if __package__ and __package__ in sys.modules:
                setattr(sys.modules[__package__], "package_runtime", sys.modules[canonical_name])

    def test_mock_patch_on_root_alias_updates_scripts_subpackage_callers(self):
        prefix = f"{__package__}." if __package__ else ""
        scripts_runtime = importlib.import_module(f"{prefix}scripts.package_runtime")
        with mock.patch(f"{prefix}package_runtime.X11_SUPPORT", ("libxcb-test.so.0",)):
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
        clean_env = {
            k: v for k, v in os.environ.items() if k not in ("PYTHONPATH", "PYTHONHOME")
        }

        def run_probe(code: str, *, cwd: Path) -> None:
            completed = subprocess.run(
                [sys.executable, "-c", code],
                cwd=cwd,
                env=clean_env,
                capture_output=True,
                text=True,
                check=False,
                timeout=20,
            )
            self.assertEqual(
                completed.returncode,
                0,
                completed.stdout + "\n" + completed.stderr,
            )

        # 1. Cold-start `from desktop import package_runtime` from repo root (PYTHONPATH cleared).
        run_probe(
            """
import pathlib
import sys
from unittest import mock

from desktop import package_runtime
import desktop as desktop_ns
from desktop.scripts import package_runtime as scripts_canonical

assert package_runtime is scripts_canonical
assert desktop_ns.package_runtime is scripts_canonical
assert sys.modules["desktop.package_runtime"] is scripts_canonical
assert pathlib.Path(scripts_canonical.__file__).resolve() == (
    pathlib.Path.cwd().resolve() / "desktop" / "scripts" / "package_runtime.py"
)
with mock.patch("desktop.package_runtime.X11_SUPPORT", ("libxcb-test.so.0",)):
    assert scripts_canonical.X11_SUPPORT == ("libxcb-test.so.0",)
    assert scripts_canonical.linux_support_binaries(lambda n: "/usr/lib/" + n, "linux") == [
        ("/usr/lib/libxcb-test.so.0", ".")
    ]
""",
            cwd=repo_root,
        )

        # 2. Cold-start `import desktop.package_runtime` and `from desktop.package_runtime import ...`.
        run_probe(
            """
import sys
import desktop.package_runtime as dotted_alias

assert dotted_alias is sys.modules["desktop.scripts.package_runtime"]
assert sys.modules["desktop.package_runtime"] is dotted_alias
assert dotted_alias.wayland_dependencies("deb") == [
    "libwayland-client0",
    "libwayland-cursor0",
    "libwayland-server0",
]
""",
            cwd=repo_root,
        )
        run_probe(
            """
import pathlib
from desktop.package_runtime import wayland_dependencies
from desktop import package

assert wayland_dependencies("deb") == [
    "libwayland-client0",
    "libwayland-cursor0",
    "libwayland-server0",
]
assert package.ROOT == pathlib.Path.cwd().resolve()
""",
            cwd=repo_root,
        )

        # 3. Cold-start flat PyInstaller hook, package.py & file-spec execution from repo root,
        # including when top-level `scripts` namespace package is already loaded in sys.modules.
        hook_probe_template = """
import importlib.util
import pathlib
import runpy
import sys
import types
from unittest import mock

{preload}
spec = importlib.util.spec_from_file_location("package_runtime", "desktop/package_runtime.py")
shim_mod = importlib.util.module_from_spec(spec)
sys.modules["package_runtime"] = shim_mod
spec.loader.exec_module(shim_mod)
assert callable(sys.modules["package_runtime"].wayland_dependencies)

pkg_ns = runpy.run_path("desktop/package.py")
assert pkg_ns["ROOT"] == pathlib.Path.cwd().resolve()
assert callable(pkg_ns["wayland_dependencies"])

pyinstaller = types.ModuleType("PyInstaller")
utils = types.ModuleType("PyInstaller.utils")
hooks = types.ModuleType("PyInstaller.utils.hooks")
qt_hooks = types.ModuleType("PyInstaller.utils.hooks.qt")
qt_hooks.os = __import__("os")
qt_hooks.pyside6_library_info = types.SimpleNamespace(version=None, location={{"LibrariesPath": ""}})
qt_hooks.add_qt6_dependencies = lambda _hook: ([], [], [])
pyinstaller.utils = utils
utils.hooks = hooks
hooks.qt = qt_hooks
with mock.patch.dict(
    sys.modules,
    {{
        "PyInstaller": pyinstaller,
        "PyInstaller.utils": utils,
        "PyInstaller.utils.hooks": hooks,
        "PyInstaller.utils.hooks.qt": qt_hooks,
    }},
):
    hook_ns = runpy.run_path("desktop/pyinstaller_hooks/hook-PySide6.QtWebEngineCore.py")
    assert callable(hook_ns["qtwebengine_framework_version"])
    assert callable(hook_ns["qtwebengine_framework_entries"])
"""
        run_probe(hook_probe_template.format(preload=""), cwd=repo_root)
        run_probe(hook_probe_template.format(preload="import scripts\n"), cwd=repo_root)

        # 4. Cold-start flat `desktop/` script imports (`PYTHONPATH` cleared).
        run_probe(
            """
import pathlib
import sys
from unittest import mock

import package_runtime
import scripts.package_runtime as scripts_canonical
from package_runtime import wayland_dependencies
import package

assert package_runtime is scripts_canonical
assert sys.modules["package_runtime"] is scripts_canonical
assert wayland_dependencies("rpm") == [
    "libwayland-client.so.0()(64bit)",
    "libwayland-cursor.so.0()(64bit)",
    "libwayland-server.so.0()(64bit)",
]
assert package.ROOT == pathlib.Path.cwd().resolve().parent
with mock.patch("package_runtime.X11_SUPPORT", ("libxcb-test.so.0",)):
    assert scripts_canonical.X11_SUPPORT == ("libxcb-test.so.0",)
""",
            cwd=desktop_dir,
        )

        # 5. Cold-start simulated frozen (`sys.frozen` / `sys._MEIPASS`) import before loading modules.
        run_probe(
            """
import pathlib
import sys
import tempfile
from unittest import mock

with tempfile.TemporaryDirectory() as meipass:
    with (
        mock.patch.object(sys, "frozen", True, create=True),
        mock.patch.object(sys, "_MEIPASS", meipass, create=True),
    ):
        import package_runtime
        from core.paths import resource_root

        assert package_runtime is sys.modules["scripts.package_runtime"]
        assert resource_root() == pathlib.Path(meipass) / "resources"
        assert package_runtime.portable_binaries([("libQt6Core.so.6", "/b", "BINARY")], "linux") == [
            ("libQt6Core.so.6", "/b", "BINARY")
        ]
""",
            cwd=desktop_dir,
        )


if __name__ == "__main__":
    unittest.main()
