import unittest

from package_runtime import portable_binaries, wayland_dependencies


class PackageRuntimeTest(unittest.TestCase):
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


if __name__ == "__main__":
    unittest.main()
