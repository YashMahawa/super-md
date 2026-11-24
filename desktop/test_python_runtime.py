"""Python cell runtimes: interpreter validation, file-based runs and discovery."""
from concurrent.futures import ThreadPoolExecutor
import os
import stat
import sys
import tempfile
import threading
import unittest
from pathlib import Path
from unittest.mock import patch

import python_runtime


def _make_fake_python(path: Path) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(b"#!/bin/sh\nexit 0\n")
    path.chmod(path.stat().st_mode | stat.S_IXUSR)
    return path


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

    def test_candidates_deduplicate_same_dir_symlinks_while_retaining_distinct_virtualenvs(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            home = root / "home"
            home.mkdir()
            base_bin = root / "system" / ("Scripts" if os.name == "nt" else "bin")
            real_python = _make_fake_python(base_bin / ("python.exe" if os.name == "nt" else "python3.12"))
            managed = root / "managed"
            proj_a = root / "proj-a"
            proj_b = root / "proj-b"
            if os.name != "nt":
                (base_bin / "python3").symlink_to(real_python.name)
                (base_bin / "python").symlink_to("python3")
                for prefix in (managed, proj_a / ".venv", proj_b / ".venv"):
                    bin_dir = prefix / "bin"
                    bin_dir.mkdir(parents=True)
                    (bin_dir / "python3").symlink_to(real_python)
                    (bin_dir / "python").symlink_to("python3")
                with (
                    patch("python_runtime.Path.home", return_value=home),
                    patch.dict(os.environ, {"VIRTUAL_ENV": "", "CONDA_PREFIX": ""}, clear=False),
                    patch("python_runtime.shutil.which", side_effect=lambda name: str(base_bin / name) if (base_bin / name).exists() else None),
                    patch("python_runtime.frozen", return_value=True),
                ):
                    paths = python_runtime.candidates(managed, [str(proj_a), str(proj_b)])
                chosen = [p for p in paths if p.is_relative_to(root)]
                self.assertEqual(
                    chosen,
                    [
                        managed / "bin" / "python3",
                        proj_a / ".venv" / "bin" / "python3",
                        proj_b / ".venv" / "bin" / "python3",
                        base_bin / "python3",
                    ],
                )
            else:
                alias = _make_fake_python(base_bin / "python3.exe")
                for prefix in (managed, proj_a / ".venv", proj_b / ".venv"):
                    _make_fake_python(prefix / "Scripts" / "python.exe")
                with (
                    patch("python_runtime.Path.home", return_value=home),
                    patch.dict(os.environ, {"VIRTUAL_ENV": "", "CONDA_PREFIX": "", "LOCALAPPDATA": str(root / "appdata")}, clear=False),
                    patch("python_runtime.shutil.which", side_effect=lambda name: str(alias) if name == "python3" else (str(real_python) if name == "python" else None)),
                    patch("python_runtime.os.path.realpath", return_value=str(real_python)),
                    patch("python_runtime.frozen", return_value=True),
                ):
                    paths = python_runtime.candidates(managed, [str(proj_a), str(proj_b)])
                self.assertEqual(
                    paths,
                    [
                        managed / "Scripts" / "python.exe",
                        proj_a / ".venv" / "Scripts" / "python.exe",
                        proj_b / ".venv" / "Scripts" / "python.exe",
                        alias,
                    ],
                )

    def test_default_python_resolves_priority_order_without_subprocesses(self):
        with tempfile.TemporaryDirectory() as folder, patch(
            "python_runtime.subprocess.run",
            side_effect=AssertionError("default_python must not spawn subprocesses"),
        ):
            root = Path(folder)
            bin_sub = "Scripts" if sys.platform == "win32" else "bin"
            exe_name = "python.exe" if sys.platform == "win32" else "python3"
            managed = root / "python-env"
            venv = root / "active-venv"
            conda = root / "active-conda"
            path_dir = root / "path-bin"
            managed_py = _make_fake_python(managed / bin_sub / exe_name)
            venv_py = _make_fake_python(venv / bin_sub / exe_name)
            conda_py = _make_fake_python(conda / bin_sub / exe_name)
            path_py = _make_fake_python(path_dir / exe_name)

            with patch("python_runtime.bundled_available", return_value=True):
                self.assertEqual(python_runtime.default_python(managed), python_runtime.BUNDLED)

            with (
                patch("python_runtime.bundled_available", return_value=False),
                patch.dict(os.environ, {"VIRTUAL_ENV": str(venv), "CONDA_PREFIX": str(conda)}, clear=False),
            ):
                self.assertEqual(python_runtime.default_python(managed), os.path.abspath(managed_py))

            managed_py.unlink()
            with (
                patch("python_runtime.bundled_available", return_value=False),
                patch.dict(os.environ, {"VIRTUAL_ENV": str(venv), "CONDA_PREFIX": str(conda)}, clear=False),
            ):
                self.assertEqual(python_runtime.default_python(managed), os.path.abspath(venv_py))

            with (
                patch("python_runtime.bundled_available", return_value=False),
                patch.dict(os.environ, {"VIRTUAL_ENV": "", "CONDA_PREFIX": str(conda)}, clear=False),
            ):
                self.assertEqual(python_runtime.default_python(managed), os.path.abspath(conda_py))

            with (
                patch("python_runtime.bundled_available", return_value=False),
                patch("python_runtime.frozen", return_value=False),
                patch.dict(os.environ, {"VIRTUAL_ENV": "", "CONDA_PREFIX": ""}, clear=False),
            ):
                self.assertEqual(python_runtime.default_python(managed), os.path.abspath(sys.executable))

            with (
                patch("python_runtime.bundled_available", return_value=False),
                patch("python_runtime.frozen", return_value=True),
                patch.dict(os.environ, {"VIRTUAL_ENV": "", "CONDA_PREFIX": ""}, clear=False),
                patch("python_runtime.shutil.which", side_effect=lambda name: str(path_py) if name == "python3" else None),
            ):
                self.assertEqual(python_runtime.default_python(managed), os.path.abspath(path_py))

            with (
                patch("python_runtime.bundled_available", return_value=False),
                patch("python_runtime.frozen", return_value=True),
                patch.dict(os.environ, {"VIRTUAL_ENV": "", "CONDA_PREFIX": ""}, clear=False),
                patch("python_runtime.shutil.which", return_value=None),
            ):
                self.assertEqual(python_runtime.default_python(managed), "")

    def test_concurrent_discover_and_preferred_coalesce_matching_inflight_scans(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            managed = root / "python-env"
            fake_py = _make_fake_python(root / "venv" / ("Scripts/python.exe" if os.name == "nt" else "bin/python3"))
            started = threading.Event()
            release = threading.Event()
            calls = 0
            lock = threading.Lock()

            def slow_probe(executable: str, timeout: float = 6) -> dict:
                nonlocal calls
                with lock:
                    calls += 1
                started.set()
                release.wait(5)
                return {
                    "version": "3.12.0",
                    "prefix": str(fake_py.parent.parent),
                    "venv": True,
                    "matplotlib": True,
                    "numpy": True,
                    "venvModule": True,
                }

            with (
                patch("python_runtime.bundled_available", return_value=False),
                patch("python_runtime.candidates", return_value=[fake_py]),
                patch("python_runtime.probe", side_effect=slow_probe),
            ):
                with ThreadPoolExecutor(max_workers=3) as pool:
                    first = pool.submit(python_runtime.discover, managed, [])
                    self.assertTrue(started.wait(2))
                    second = pool.submit(python_runtime.discover, managed, ())
                    third = pool.submit(python_runtime.preferred, managed)
                    threading.Event().wait(0.05)
                    release.set()
                    res_first = first.result(timeout=5)
                    res_second = second.result(timeout=5)
                    res_preferred = third.result(timeout=5)

                self.assertEqual(calls, 1)
                self.assertEqual(res_first, res_second)
                self.assertIsNot(res_first, res_second)
                self.assertIsNot(res_first[0], res_second[0])
                self.assertEqual(res_preferred, str(fake_py))

                rescan = python_runtime.discover(managed)
                self.assertEqual(calls, 2)
                self.assertEqual(rescan[0]["path"], str(fake_py))


if __name__ == "__main__":
    unittest.main()
