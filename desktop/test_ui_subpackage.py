import ast
import importlib
import os
import subprocess
import sys
import textwrap
import unittest
from pathlib import Path
from unittest import mock

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

DESKTOP_DIR = Path(__file__).resolve().parent
REPO_ROOT = DESKTOP_DIR.parent

UI_MODULES = (
    "theme",
    "shortcuts",
    "fonts",
    "native_frame",
    "reader_edits",
    "reader_gestures",
    "selection_actions",
)


def _clean_python_env() -> dict[str, str]:
    env = {
        key: value
        for key, value in os.environ.items()
        if key not in ("PYTHONPATH", "PYTHONSAFEPATH")
    }
    env["QT_QPA_PLATFORM"] = "offscreen"
    return env


class UiSubpackageTest(unittest.TestCase):
    def test_desktop_init_absent_and_ui_init_is_empty(self):
        self.assertFalse((DESKTOP_DIR / "__init__.py").exists())
        ui_init = DESKTOP_DIR / "ui" / "__init__.py"
        self.assertTrue(ui_init.is_file())
        self.assertEqual(ui_init.stat().st_size, 0)

    def test_root_shims_alias_ui_subpackage_module_objects(self):
        prefix = f"{__package__}." if __package__ else ""
        for mod in UI_MODULES:
            with self.subTest(module=mod):
                canonical_name = f"{prefix}ui.{mod}"
                alias_name = f"{prefix}{mod}"
                canonical = importlib.import_module(canonical_name)
                alias = importlib.import_module(alias_name)
                self.assertIs(alias, canonical)
                self.assertIs(sys.modules[alias_name], sys.modules[canonical_name])
                self.assertEqual(
                    Path(canonical.__file__).resolve(),
                    DESKTOP_DIR / "ui" / f"{mod}.py",
                )
                sys.modules.pop(alias_name, None)
                try:
                    reimported = importlib.import_module(alias_name)
                    self.assertIs(reimported, canonical)
                    self.assertIs(sys.modules[alias_name], sys.modules[canonical_name])
                finally:
                    sys.modules[alias_name] = sys.modules[canonical_name]

    def test_mock_patch_on_theme_propagates_to_ui_theme(self):
        prefix = f"{__package__}." if __package__ else ""
        theme_name = f"{prefix}theme"
        importlib.import_module(theme_name)
        ui_theme = importlib.import_module(f"{prefix}ui.theme")
        with (
            mock.patch(f"{theme_name}.subprocess.run") as run,
            mock.patch(f"{theme_name}.sys.platform", "linux"),
        ):
            run.return_value.returncode = 0
            run.return_value.stdout = "'prefer-dark'"
            self.assertTrue(ui_theme.detect_system_dark("Unknown"))
            run.return_value.stdout = "'prefer-light'"
            self.assertFalse(ui_theme.detect_system_dark("Unknown"))

    def test_clean_subprocess_repo_root_desktop_imports_without_desktop_on_sys_path(self):
        script = textwrap.dedent(
            f"""
            import importlib
            import sys
            from pathlib import Path
            from unittest import mock

            repo_root = Path({str(REPO_ROOT)!r}).resolve()
            desktop_dir = Path({str(DESKTOP_DIR)!r}).resolve()
            ui_modules = {UI_MODULES!r}

            def resolved_sys_path():
                return {{(Path(entry) if entry else Path.cwd()).resolve() for entry in sys.path}}

            assert repo_root in resolved_sys_path(), sys.path
            assert desktop_dir not in resolved_sys_path(), sys.path

            import desktop
            from desktop import (
                fonts,
                native_frame,
                reader_edits,
                reader_gestures,
                selection_actions,
                shortcuts,
                theme,
            )

            imported = {{
                "theme": theme,
                "shortcuts": shortcuts,
                "fonts": fonts,
                "native_frame": native_frame,
                "reader_edits": reader_edits,
                "reader_gestures": reader_gestures,
                "selection_actions": selection_actions,
            }}
            for mod, alias in imported.items():
                canonical = importlib.import_module(f"desktop.ui.{{mod}}")
                assert alias is canonical, mod
                assert getattr(desktop, mod) is canonical, mod
                assert sys.modules[f"desktop.{{mod}}"] is sys.modules[f"desktop.ui.{{mod}}"], mod
                assert Path(canonical.__file__).resolve() == desktop_dir / "ui" / f"{{mod}}.py", mod
                sys.modules.pop(f"desktop.{{mod}}", None)
                delattr(desktop, mod)
                reimported = importlib.import_module(f"desktop.{{mod}}")
                assert reimported is canonical, mod
                assert getattr(desktop, mod) is canonical, mod
                assert sys.modules[f"desktop.{{mod}}"] is canonical, mod

            with (
                mock.patch("desktop.theme.subprocess.run") as run,
                mock.patch("desktop.theme.sys.platform", "linux"),
            ):
                run.return_value.returncode = 0
                run.return_value.stdout = "'prefer-dark'"
                assert importlib.import_module("desktop.ui.theme").detect_system_dark("Unknown") is True

            assert shortcuts.default_shortcuts()["save"] == ["Ctrl+S"]
            import tempfile
            with tempfile.TemporaryDirectory() as tmp:
                assert fonts.FontStore(tmp).families == {{}}
            assert "ui" not in sys.modules, list(sys.modules)
            assert not any(name.startswith("ui.") for name in sys.modules), list(sys.modules)
            assert desktop_dir not in resolved_sys_path(), sys.path
            """
        )
        result = subprocess.run(
            [sys.executable, "-c", script],
            cwd=REPO_ROOT,
            env=_clean_python_env(),
            capture_output=True,
            text=True,
        )
        self.assertEqual(
            result.returncode,
            0,
            f"Repo-root subprocess failed:\nstdout:\n{result.stdout}\nstderr:\n{result.stderr}",
        )

    def test_clean_subprocess_flat_desktop_imports_without_repo_root_on_sys_path(self):
        script = textwrap.dedent(
            f"""
            import importlib
            import sys
            from pathlib import Path
            from unittest import mock

            repo_root = Path({str(REPO_ROOT)!r}).resolve()
            desktop_dir = Path({str(DESKTOP_DIR)!r}).resolve()
            ui_modules = {UI_MODULES!r}

            def resolved_sys_path():
                return {{(Path(entry) if entry else Path.cwd()).resolve() for entry in sys.path}}

            assert desktop_dir in resolved_sys_path(), sys.path
            assert repo_root not in resolved_sys_path(), sys.path

            for mod in ui_modules:
                alias = importlib.import_module(mod)
                canonical = importlib.import_module(f"ui.{{mod}}")
                assert alias is canonical, mod
                assert sys.modules[mod] is sys.modules[f"ui.{{mod}}"], mod
                assert Path(canonical.__file__).resolve() == desktop_dir / "ui" / f"{{mod}}.py", mod
                sys.modules.pop(mod, None)
                reimported = importlib.import_module(mod)
                assert reimported is canonical, mod
                assert sys.modules[mod] is canonical, mod

            with (
                mock.patch("theme.subprocess.run") as run,
                mock.patch("theme.sys.platform", "linux"),
            ):
                run.return_value.returncode = 0
                run.return_value.stdout = "'prefer-dark'"
                assert importlib.import_module("ui.theme").detect_system_dark("Unknown") is True

            assert importlib.import_module("shortcuts").default_shortcuts()["save"] == ["Ctrl+S"]
            import tempfile
            with tempfile.TemporaryDirectory() as tmp:
                assert importlib.import_module("fonts").FontStore(tmp).families == {{}}
            assert "desktop" not in sys.modules, list(sys.modules)
            assert not any(name.startswith("desktop.") for name in sys.modules), list(sys.modules)
            assert repo_root not in resolved_sys_path(), sys.path
            """
        )
        result = subprocess.run(
            [sys.executable, "-c", script],
            cwd=DESKTOP_DIR,
            env=_clean_python_env(),
            capture_output=True,
            text=True,
        )
        self.assertEqual(
            result.returncode,
            0,
            f"Flat-desktop subprocess failed:\nstdout:\n{result.stdout}\nstderr:\n{result.stderr}",
        )

    def test_ui_modules_have_zero_dual_import_shims_or_depth_assumptions(self):
        ui_files = sorted((DESKTOP_DIR / "ui").glob("*.py"))
        self.assertEqual({path.stem for path in ui_files}, {"__init__", *UI_MODULES})
        for path in ui_files:
            tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
            for node in ast.walk(tree):
                if isinstance(node, ast.ExceptHandler) and node.type is not None:
                    caught = node.type.elts if isinstance(node.type, ast.Tuple) else [node.type]
                    names = {item.id for item in caught if isinstance(item, ast.Name)}
                    self.assertFalse(names & {"ImportError", "ModuleNotFoundError"}, path.name)
                if isinstance(node, ast.Name):
                    self.assertNotEqual(node.id, "__file__", path.name)
                if isinstance(node, ast.Attribute):
                    self.assertNotEqual(node.attr, "with_name", path.name)
                    if node.attr == "parent" and isinstance(node.value, ast.Attribute):
                        self.assertNotEqual(node.value.attr, "parent", path.name)


if __name__ == "__main__":
    unittest.main()
