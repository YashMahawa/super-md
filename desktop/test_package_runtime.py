import ast
import importlib
import os
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


if __name__ == "__main__":
    unittest.main()
