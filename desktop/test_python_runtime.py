"""Python cell runtimes: interpreter validation, file-based runs and discovery."""
import os
import sys
import tempfile
import unittest
from pathlib import Path

import python_runtime


class PythonRuntimeTest(unittest.TestCase):
    def test_rejects_executables_that_are_not_python(self):
        for path in ("/bin/sh", "/usr/bin/env", "", "definitely-not-python"):
            with self.subTest(path=path), self.assertRaises(ValueError):
                python_runtime.validate(path)
        self.assertEqual(python_runtime.validate(sys.executable), sys.executable)

    def test_bundled_runtime_is_only_offered_by_frozen_builds(self):
        self.assertFalse(python_runtime.bundled_available())
        with self.assertRaises(ValueError):
            python_runtime.validate(python_runtime.BUNDLED)

    def test_runs_in_note_folder_and_reports_clean_tracebacks(self):
        with tempfile.TemporaryDirectory() as folder:
            Path(folder, "data.txt").write_text("42", encoding="utf-8")
            result = python_runtime.run(sys.executable, "print(open('data.txt').read())\nx = 1\nraise ValueError('broken cell')", cwd=folder)
        self.assertFalse(result["ok"])
        self.assertEqual(result["stdout"].strip(), "42")
        self.assertIn("Line 3: raise ValueError('broken cell')", result["stderr"])
        self.assertIn("ValueError: broken cell", result["stderr"])
        self.assertNotIn("supermd-cell", result["stderr"])

    def test_oversized_cells_and_timeouts_are_refused(self):
        with self.assertRaises(ValueError):
            python_runtime.run(sys.executable, "#" * (python_runtime.MAX_CODE + 1))
        with self.assertRaisesRegex(ValueError, "stopped after 1 seconds"):
            python_runtime.run(sys.executable, "import time\ntime.sleep(5)", timeout=1)

    def test_discovery_finds_this_interpreter_and_project_virtualenvs(self):
        with tempfile.TemporaryDirectory() as folder:
            venv = Path(folder, ".venv", "Scripts" if os.name == "nt" else "bin")
            venv.mkdir(parents=True)
            paths = [str(path) for path in python_runtime.candidates(Path(folder, "managed"), [folder])]
        self.assertTrue(any(os.path.samefile(path, sys.executable) for path in paths if os.path.exists(path)))
        self.assertTrue(all(python_runtime.NAME.match(Path(path).name) for path in paths))

    def test_isolated_studio_windows_skip_background_default_python_discovery(self):
        os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
        from unittest.mock import patch
        from PySide6.QtGui import QGuiApplication
        from studio import Session
        from test_studio import QuietStudio

        app = QGuiApplication.instance() or QGuiApplication(["python runtime test"])
        session = Session(True)
        with patch.object(QuietStudio, "_choose_default_python") as choose_default:
            isolated_window = QuietStudio(True, session)
            app.processEvents()
            choose_default.assert_not_called()
            production_window = QuietStudio(False, session)
            try:
                app.processEvents()
                choose_default.assert_called_once()
            finally:
                production_window.stop()
                production_window.pool.shutdown(wait=True, cancel_futures=True)
                isolated_window.stop()
                isolated_window.pool.shutdown(wait=True, cancel_futures=True)
                session.writes.shutdown(wait=True)

    def test_suite_watchdog_budget_covers_macos_arm64_and_intel_runners(self):
        import run_tests

        self.assertEqual(run_tests.suite_timeout_for("darwin", "arm64"), 420)
        self.assertEqual(run_tests.suite_timeout_for("darwin", "x86_64"), 720)
        self.assertEqual(run_tests.suite_timeout_for("linux", "x86_64"), 240)
        self.assertEqual(run_tests.suite_timeout_for("win32", "AMD64"), 240)


if __name__ == "__main__":
    unittest.main()
