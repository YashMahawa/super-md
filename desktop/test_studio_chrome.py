"""Focused unit tests for desktop/studio_chrome.py behind the Studio facade."""
import ast
import copy
import inspect
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
os.environ.setdefault("QT_QUICK_BACKEND", "software")

from PySide6.QtCore import QUrl, Qt
from PySide6.QtGui import QGuiApplication

import custom_theme
import studio as studio_mod
import studio_chrome
from studio import DEFAULT_PDF, Session, Studio
from test_studio import QuietStudio


class StudioChromeTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.app = QGuiApplication.instance() or QGuiApplication(["studio_chrome tests"])

    def setUp(self):
        self.session = Session(True)
        self.session.settings["python"] = sys.executable
        self.windows: list[Studio] = []
        self.studio = self._new_window()

    def _new_window(self) -> QuietStudio:
        win = QuietStudio(True, self.session)
        self.windows.append(win)
        return win

    def tearDown(self):
        for win in self.windows:
            win.stop()
            win.pool.shutdown(wait=True, cancel_futures=True)
            win._search_pool.shutdown(wait=True, cancel_futures=True)
        self.session.writes.shutdown(wait=True)
        self.app.processEvents()

    def _run_theme_sync(self, call, *, reader=None):
        pending = []
        read_fn = reader or (lambda _engine, path: json.loads(Path(path).read_text(encoding="utf-8")))
        with (
            patch.object(self.studio, "_engine", return_value=Path("unused-engine")),
            patch.object(self.studio, "_submit", side_effect=lambda action, done, *_: pending.append((action, done))),
            patch("custom_theme.read", side_effect=read_fn),
        ):
            call()
            while pending:
                action, done = pending.pop(0)
                done(action(), None)

    def test_explicit_dependencies_and_zero_studio_module_lookups(self):
        self.assertFalse(hasattr(studio_chrome, "_studio_module"))
        tree = ast.parse(inspect.getsource(studio_chrome))
        imported = {
            alias.name for node in ast.walk(tree) if isinstance(node, (ast.Import, ast.ImportFrom)) for alias in node.names
        } | {node.module for node in ast.walk(tree) if isinstance(node, ast.ImportFrom) and node.module}
        self.assertFalse({"studio", "desktop.studio", "sys"} & imported)

        self.assertEqual(studio_chrome.theme_metrics({"metrics": {"controlRadius": 14}}), {"controlRadius": 14, "contentRadius": 16})
        self.assertEqual((studio_chrome.custom_theme_name(None), studio_chrome.custom_theme_name({"name": "Solar"})), ("Built-in appearance", "Solar"))
        self.assertEqual((studio_chrome.custom_theme_active(None), studio_chrome.custom_theme_active(custom_theme.TEMPLATE)), (False, True))
        self.assertFalse(studio_chrome.motion_enabled({"motion": False}))
        art_theme = {
            **custom_theme.TEMPLATE,
            "variants": {"dark": {"artwork": {"reader": {"image": "data:image/svg+xml;base64,PHN2Zy8+", "opacity": 0.14, "fit": "cover"}}}},
        }
        self.assertIn("pattern", studio_chrome.theme_background(custom_theme.TEMPLATE, self.studio.settings, dark=True))
        self.assertIn("reader", studio_chrome.theme_artwork(art_theme, self.studio.settings, fullscreen=False, dark=True))
        self.assertIn("find", json.loads(studio_chrome.shortcut_bindings(self.studio.settings)))
        self.assertIn("find", json.loads(studio_chrome.shortcut_labels(self.studio.settings)))
        captured = json.loads(studio_chrome.capture_shortcut(Qt.Key.Key_F.value, Qt.KeyboardModifier.ControlModifier.value))
        self.assertEqual(captured, {"sequence": "Ctrl+F", "error": ""})

    def test_token_caching_and_simplenamespace_proxy_support(self):
        with patch.object(studio_mod, "tokens", wraps=studio_mod.tokens) as token_spy:
            first, second = self.studio._tokens(), self.studio._tokens()
            self.assertIs(first, second)
            self.assertEqual(token_spy.call_count, 1)
            self.studio.setting("accent", '"rose"')
            self.assertIsNot(first, self.studio._tokens())
            self.assertGreaterEqual(token_spy.call_count, 2)

        proxy = SimpleNamespace(
            settings=copy.deepcopy(self.studio.settings),
            session=SimpleNamespace(custom_theme=None, theme_revision=0, windows={}),
            fullscreen=False, system_dark=True, system_colors={}, system_mode="dark",
        )
        self.assertTrue(Studio._dark(proxy))
        self.assertIn("primary", Studio._colors(proxy))
        self.assertTrue(Studio.shortcutLabel(proxy, "find"))

    def test_bundled_themes_and_palette_watch_respect_explicit_dependencies(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            themes_dir = root / "public" / "themes"
            themes_dir.mkdir(parents=True)
            (themes_dir / "custom-root.supermd-theme.json").write_text(json.dumps({**custom_theme.TEMPLATE, "name": "Custom Root Preset"}), encoding="utf-8")
            palette_file = root / "kdeglobals"
            palette_file.write_text("[General]\n", encoding="utf-8")
            with patch.object(studio_mod, "ROOT", root):
                self.assertTrue(any(item["id"] == "custom-root" and item["name"] == "Custom Root Preset" for item in self.studio.bundledThemes))
                results = []
                self._run_theme_sync(lambda: self.studio._apply_bundled_theme("custom-root", callback=lambda res, err: results.append((res, err))))
                self.assertEqual(results, [({"id": "custom-root", "name": "Custom Root Preset"}, "")])
                self.assertEqual(self.studio.activeThemeKind, "preset")

            with patch.object(studio_mod, "system_palette_paths", return_value=[palette_file]):
                self.studio._watch_palette()
                self.assertIn(str(palette_file), self.studio.palette_watcher.files())

    def test_custom_theme_lifecycle_persistence_and_studio_patches(self):
        second = self._new_window()
        src_a = self.studio.data / "one.supermd-theme.json"
        src_b = self.studio.data / "two.supermd-theme.json"
        src_a.write_text(json.dumps({**custom_theme.TEMPLATE, "name": "Theme One"}), encoding="utf-8")
        src_b.write_text(json.dumps({**custom_theme.TEMPLATE, "name": "Theme Two"}), encoding="utf-8")

        self.studio.setting("patternKind", '"paws"')
        with patch("studio.local_path", wraps=studio_mod.local_path) as lp_spy, patch("studio.atomic_json", wraps=studio_mod.atomic_json) as aj_spy:
            self._run_theme_sync(lambda: self.studio.importCustomTheme(str(src_a)))
            self.assertEqual(lp_spy.call_count, 1)
            self.assertGreaterEqual(aj_spy.call_count, 3)

        self.assertEqual((self.studio.customThemeName, second.customThemeName), ("Theme One", "Theme One"))
        self.assertEqual(self.studio.settings["patternKind"], "")
        self.assertTrue((self.studio.data / "theme.json").is_file())
        self.assertEqual(json.loads((self.studio.data / "theme-source.json").read_text(encoding="utf-8")), {"path": str(src_a)})
        saved_a_id = self.studio.savedThemes[0]["id"]

        with patch("studio.QDesktopServices.openUrl", return_value=True) as open_url:
            self.studio.editCustomTheme()
            self.assertEqual(open_url.call_args.args[0], QUrl.fromLocalFile(str(src_a)))

        self._run_theme_sync(lambda: self.studio.importCustomTheme(str(src_b)))
        self.assertEqual(len(self.studio.savedThemes), 2)

        self.studio.setting("patternKind", '"grid"')
        self._run_theme_sync(lambda: self.studio.selectBundledTheme("study-desk"))
        self.assertEqual((self.studio.activeThemeKind, self.studio.settings["patternKind"]), ("preset", ""))
        self.assertFalse((self.studio.data / "theme-source.json").exists())

        self._run_theme_sync(lambda: self.studio.selectSavedTheme(saved_a_id))
        self.assertEqual(self.studio.activeThemeId, saved_a_id)
        self.assertTrue((self.studio.data / "theme-source.json").is_file())
        src_a.write_text(json.dumps({**custom_theme.TEMPLATE, "name": "Theme One Edited"}), encoding="utf-8")
        self.studio.setting("patternKind", '"dots"')
        self._run_theme_sync(self.studio.reloadCustomTheme)
        self.assertEqual((self.studio.customThemeName, self.studio.settings["patternKind"]), ("Theme One Edited", ""))

        self.studio.setting("patternKind", '"paws"')
        self.studio.deleteSavedTheme(saved_a_id)
        self.assertEqual((self.studio.activeThemeKind, self.studio.settings["patternKind"]), ("builtin", ""))
        self.assertFalse((self.studio.data / "theme.json").exists())
        self.assertEqual([item["name"] for item in self.studio.savedThemes], ["Theme Two"])

        self._run_theme_sync(lambda: self.studio.selectSavedTheme(self.studio.savedThemes[0]["id"]))
        self.studio.setting("patternKind", '"paws"')
        self.studio.resetCustomTheme()
        self.assertEqual((self.studio.activeThemeKind, self.studio.customThemeName, self.studio.settings["patternKind"]), ("builtin", "Built-in appearance", ""))
        self.assertFalse((self.studio.data / "theme.json").exists())

    def test_shortcuts_validation_and_cross_window_notification(self):
        other = self._new_window()
        events_a, events_b = [], []
        self.studio.shortcutsChanged.connect(lambda: events_a.append(1))
        other.shortcutsChanged.connect(lambda: events_b.append(1))

        self.assertEqual(self.studio.setShortcut("nonexistent", "Ctrl+Alt+Z"), "Unknown shortcut action.")
        self.assertEqual(self.studio.setShortcut("find", "NotAKeySequence+++"), "Invalid key combination.")
        self.assertIn("Save note", self.studio.setShortcut("find", "Ctrl+S"))
        self.assertEqual((events_a, events_b), ([], []))

        self.assertEqual(self.studio.setShortcut("find", "Ctrl+Alt+F"), "")
        self.assertEqual((len(events_a), len(events_b)), (1, 1))
        self.assertEqual(other.shortcutSequences("find"), ["Ctrl+Alt+F"])
        self.assertEqual(self.studio.resetShortcuts(), "")
        self.assertEqual((len(events_a), len(events_b)), (2, 2))

    def test_preserved_window_settings_and_theme_export_behavior(self):
        with patch("studio.sys.platform", "linux"), patch("studio.platform.freedesktop_os_release", return_value={"ID": "fedora"}), patch.dict(os.environ, {"XDG_CURRENT_DESKTOP": "GNOME"}):
            self.assertEqual((self.studio.fedoraWindowFrame, self.studio.showToolbarWindowControls), (True, True))

        self.studio.setting("keepInBackground", "true")
        self.studio.setting("keepInBackground", '"not-a-bool"')
        self.studio.setting("restorePosition", "false")
        self.studio.setting("centerLock", "true")
        self.assertEqual((self.studio.settings["keepInBackground"], self.studio.settings["restorePosition"], self.studio.settings["centerLock"]), (True, False, True))
        self.studio.setting("pdf", json.dumps({"pageSize": "a4"}))
        self.assertEqual(set(self.studio.settings["pdf"]), set(DEFAULT_PDF))

        export_target = self.studio.data / "shared.supermd-theme.json"
        self.studio.exportCustomTheme(str(export_target))
        self.assertTrue(export_target.is_file())
        self.assertTrue(self.studio.defaultThemeExportLocation("Solar.supermd-theme.json").toLocalFile().endswith("Solar.supermd-theme.json"))


if __name__ == "__main__":
    unittest.main()
