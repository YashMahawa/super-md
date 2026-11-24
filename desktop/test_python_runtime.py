"""Python cell runtimes: interpreter validation, file-based runs and discovery."""
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

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

    @unittest.skipIf(os.name == "nt", "POSIX symlink layout test")
    def test_candidates_deduplicates_same_bin_symlinks_while_keeping_distinct_venvs(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            base_bin = root / "base" / "bin"
            base_bin.mkdir(parents=True)
            real_python = base_bin / "python3.12"
            real_python.write_text("#!/bin/sh\n", encoding="utf-8")
            real_python.chmod(0o755)
            (base_bin / "python3").symlink_to("python3.12")
            (base_bin / "python").symlink_to("python3")

            venv_a = root / "proj-a" / ".venv" / "bin"
            venv_b = root / "proj-b" / ".venv" / "bin"
            for venv_bin in (venv_a, venv_b):
                venv_bin.mkdir(parents=True)
                (venv_bin / "python3").symlink_to(real_python)
                (venv_bin / "python").symlink_to("python3")

            managed = root / "managed"
            managed_bin = managed / "bin"
            managed_bin.mkdir(parents=True)
            (managed_bin / "python3").symlink_to(real_python)
            (managed_bin / "python").symlink_to("python3")

            found = python_runtime.candidates(managed, [str(root / "proj-a"), str(root / "proj-b")])
            by_parent = {}
            for candidate in found:
                if candidate.parent in (managed_bin, venv_a, venv_b):
                    by_parent.setdefault(candidate.parent, []).append(candidate.name)
            self.assertEqual(by_parent[managed_bin], ["python3"])
            self.assertEqual(by_parent[venv_a], ["python3"])
            self.assertEqual(by_parent[venv_b], ["python3"])

    def test_preferred_uses_ready_managed_environment_without_full_discovery(self):
        with tempfile.TemporaryDirectory() as folder:
            managed = Path(folder, "python-env")
            candidate = python_runtime._bin(managed)[0]
            candidate.parent.mkdir(parents=True, exist_ok=True)
            candidate.write_text("", encoding="utf-8")
            with patch("python_runtime.bundled_available", return_value=False), patch(
                "python_runtime.probe", return_value={"matplotlib": True, "numpy": True}
            ) as probe_mock, patch(
                "python_runtime.discover", side_effect=AssertionError("discover() should not run when managed env is ready")
            ):
                chosen = python_runtime.preferred(managed)
        self.assertEqual(chosen, str(candidate))
        probe_mock.assert_called_once_with(str(candidate))


if __name__ == "__main__":
    unittest.main()
