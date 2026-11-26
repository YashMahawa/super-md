import ast
import importlib
import os
import sys
import unittest
from pathlib import Path
from unittest import mock

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

DESKTOP_DIR = Path(__file__).resolve().parent
if str(DESKTOP_DIR) not in sys.path:
    sys.path.insert(0, str(DESKTOP_DIR))

UI_MODULES = (
    "theme",
    "shortcuts",
    "fonts",
    "native_frame",
    "reader_edits",
    "reader_gestures",
    "selection_actions",
)


class UiSubpackageTest(unittest.TestCase):
    def test_desktop_init_absent_and_ui_init_is_empty(self):
        self.assertFalse((DESKTOP_DIR / "__init__.py").exists())
        ui_init = DESKTOP_DIR / "ui" / "__init__.py"
        self.assertTrue(ui_init.is_file())
        self.assertEqual(ui_init.stat().st_size, 0)

    def test_root_shims_alias_ui_subpackage_module_objects(self):
        for mod in UI_MODULES:
            with self.subTest(module=mod):
                canonical = importlib.import_module(f"ui.{mod}")
                alias = importlib.import_module(mod)
                self.assertIs(alias, canonical)
                self.assertIs(sys.modules[mod], sys.modules[f"ui.{mod}"])
                self.assertEqual(
                    Path(canonical.__file__).resolve(),
                    DESKTOP_DIR / "ui" / f"{mod}.py",
                )
                sys.modules.pop(mod, None)
                try:
                    reimported = importlib.import_module(mod)
                    self.assertIs(reimported, canonical)
                    self.assertIs(sys.modules[mod], sys.modules[f"ui.{mod}"])
                finally:
                    sys.modules[mod] = sys.modules[f"ui.{mod}"]

    def test_mock_patch_on_theme_propagates_to_ui_theme(self):
        importlib.import_module("theme")
        ui_theme = importlib.import_module("ui.theme")
        with mock.patch("theme.subprocess.run") as run, mock.patch("theme.sys.platform", "linux"):
            run.return_value.returncode = 0
            run.return_value.stdout = "'prefer-dark'"
            self.assertTrue(ui_theme.detect_system_dark("Unknown"))
            run.return_value.stdout = "'prefer-light'"
            self.assertFalse(ui_theme.detect_system_dark("Unknown"))

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
