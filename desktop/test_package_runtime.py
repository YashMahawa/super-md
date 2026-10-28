import unittest
import os
import tempfile
from pathlib import Path

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


if __name__ == "__main__":
    unittest.main()
