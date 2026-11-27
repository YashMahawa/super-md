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

from core.paths import DESKTOP_DIR, RESOURCE_ROOT, SOURCE_ROOT, resource_root


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


if __name__ == "__main__":
    unittest.main()
