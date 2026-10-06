import subprocess
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

import graphics_runtime


class GraphicsRuntimeTest(unittest.TestCase):
    def test_healthy_probe_preserves_platform_backend_and_user_flags(self):
        env = {"QT_QPA_PLATFORM": "wayland", "QSG_RHI_BACKEND": "vulkan",
               "QTWEBENGINE_CHROMIUM_FLAGS": "--enable-smooth-scrolling"}
        original = dict(env)
        run = Mock(return_value=SimpleNamespace(returncode=0, stdout="SUPERMD_GRAPHICS_OK\n"))
        self.assertEqual(graphics_runtime.configure(env, runner=run), "accelerated")
        self.assertEqual(env, original)
        self.assertLessEqual(run.call_args.kwargs["timeout"], 8)

    def test_abort_missing_egl_and_timeout_fall_back_without_disabling_sandbox(self):
        for outcome in (SimpleNamespace(returncode=-6, stdout=""),
                        SimpleNamespace(returncode=134, stdout=""),
                        SimpleNamespace(returncode=0, stdout=""),
                        subprocess.TimeoutExpired("probe", 8), OSError("missing runtime")):
            env = {"QT_QPA_PLATFORM": "wayland", "QTWEBENGINE_CHROMIUM_FLAGS": "--enable-smooth-scrolling"}
            run = Mock(side_effect=outcome) if isinstance(outcome, Exception) else Mock(return_value=outcome)
            self.assertEqual(graphics_runtime.configure(env, runner=run), "software")
            self.assertEqual(env["QT_QPA_PLATFORM"], "wayland")
            self.assertEqual(env["QT_QUICK_BACKEND"], "software")
            self.assertIn("--disable-gpu", env["QTWEBENGINE_CHROMIUM_FLAGS"])
            self.assertNotIn("--no-sandbox", env["QTWEBENGINE_CHROMIUM_FLAGS"])

    def test_explicit_safe_mode_and_existing_software_skip_probe(self):
        for env, safe in (({}, True), ({"QT_QUICK_BACKEND": "software"}, False)):
            run = Mock()
            graphics_runtime.configure(env, safe=safe, runner=run)
            graphics_runtime.configure(env, safe=safe, runner=run)
            run.assert_not_called()
            self.assertEqual(env["QTWEBENGINE_CHROMIUM_FLAGS"].split().count("--disable-gpu"), 1)

    def test_frozen_probe_uses_same_bundle_not_host_python(self):
        with patch("graphics_runtime.sys.frozen", True, create=True):
            self.assertEqual(graphics_runtime.command(), [graphics_runtime.sys.executable, "--graphics-probe"])
        self.assertIn("main.py", graphics_runtime.command()[1])

    def test_windowed_windows_probe_uses_presented_report_without_stdout(self):
        def run(args, **kwargs):
            Path(args[-1]).write_text("SUPERMD_GRAPHICS_OK\n", encoding="utf-8")
            return SimpleNamespace(returncode=0, stdout=None)
        env = {}
        self.assertEqual(graphics_runtime.configure(env, runner=run), "accelerated")
        self.assertEqual(env, {})


if __name__ == "__main__":
    unittest.main()
