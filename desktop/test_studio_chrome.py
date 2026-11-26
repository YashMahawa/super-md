"""Focused unit tests for desktop/studio_chrome.py behind the Studio facade."""
import copy
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

from PySide6.QtCore import QUrl
from PySide6.QtGui import QGuiApplication

import custom_theme
import studio as studio_mod
import studio_chrome
from studio import DEFAULT_PDF, DEFAULTS, Session, Studio
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

    def test_token_caching_and_simplenamespace_proxy_support(self):
        with patch.object(studio_mod, "tokens", wraps=studio_mod.tokens) as token_spy:
            first, second = self.studio._tokens(), self.studio._tokens()
            self.assertIs(first, second)
            self.assertEqual(token_spy.call_count, 1)
            self.studio.setting("accent", '"rose"')
            self.assertIsNot(first, self.studio._tokens())
            self.assertGreaterEqual(token_spy.call_count, 2)

        proxy = SimpleNamespace(
            settings=copy.deepcopy(DEFAULTS),
            session=SimpleNamespace(custom_theme=None, theme_revision=0, windows={}),
            fullscreen=False, system_dark=True, system_colors={}, system_mode="dark",
            readerCall=SimpleNamespace(emit=lambda *_: None),
        )
        self.assertTrue(Studio._dark(proxy))
        self.assertIn("primary", Studio._colors(proxy))
        Studio.setting(proxy, "size", "24")
        self.assertEqual(proxy.settings["size"], 24.0)

    def test_bundled_themes_respect_patched_studio_root(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            themes_dir = root / "public" / "themes"
            themes_dir.mkdir(parents=True)
            (themes_dir / "custom-root.supermd-theme.json").write_text(json.dumps({**custom_theme.TEMPLATE, "name": "Custom Root Preset"}), encoding="utf-8")
            with patch.object(studio_mod, "ROOT", root):
                self.assertTrue(any(item["id"] == "custom-root" and item["name"] == "Custom Root Preset" for item in self.studio.bundledThemes))
                results = []
                self._run_theme_sync(lambda: self.studio._apply_bundled_theme("custom-root", callback=lambda res, err: results.append((res, err))))
                self.assertEqual(results, [({"id": "custom-root", "name": "Custom Root Preset"}, "")])
                self.assertEqual(self.studio.activeThemeKind, "preset")

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

        self._run_theme_sync(lambda: self.studio.importCustomTheme(str(src_b)))
        self.assertEqual(len(self.studio.savedThemes), 2)

        self.studio.setting("patternKind", '"grid"')
        self._run_theme_sync(lambda: self.studio.selectBundledTheme("study-desk"))
        self.assertEqual(self.studio.activeThemeKind, "preset")
        self.assertFalse((self.studio.data / "theme-source.json").exists())
        self.assertEqual(self.studio.settings["patternKind"], "")

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

    def test_linux_window_chrome_selection_edit_zoom_and_setting_bounds(self):
        with patch("studio.sys.platform", "linux"), patch("studio.platform.freedesktop_os_release", return_value={"ID": "fedora"}), patch.dict(os.environ, {"XDG_CURRENT_DESKTOP": "GNOME"}):
            self.assertEqual((self.studio.fedoraWindowFrame, self.studio.showToolbarWindowControls), (True, True))
        with patch("studio.sys.platform", "linux"), patch("studio.platform.freedesktop_os_release", side_effect=OSError("missing")), patch.dict(os.environ, {"XDG_CURRENT_DESKTOP": "sway"}):
            self.assertEqual((self.studio.fedoraWindowFrame, self.studio.showToolbarWindowControls), (False, True))

        src = self.studio.data / "editable.supermd-theme.json"
        src.write_text("{}", encoding="utf-8")
        self.session.active_theme_kind, self.session.theme_source = "saved", str(src)
        with patch("studio.QDesktopServices.openUrl", return_value=True) as open_url:
            self.studio.selectionAction("google", "matrix rank")
            self.assertIn("www.google.com", open_url.call_args.args[0].toString())
            self.studio.editCustomTheme()
            self.assertEqual(open_url.call_args.args[0], QUrl.fromLocalFile(str(src)))

        calls = []
        self.studio.readerCall.connect(calls.append)
        with patch("studio.time.time", return_value=1700000002.5):
            self.studio.setZoom(999)
            self.studio.setZoom(10)
        self.assertEqual(calls, ["window.supermdSetZoom?.(300,1700000002500)", "window.supermdSetZoom?.(40,1700000002500)"])

        for key, raw, expected in (("size", "2", 6.0), ("size", "99", 32.0), ("width", "99999", 5000), ("widthPercent", "10", 50.0), ("lineHeight", "9.5", 2.2)):
            self.studio.setting(key, raw)
            self.assertEqual(self.studio.settings[key], expected)

        before_window = dict(self.studio.settings["window"])
        self.studio.setting("window", json.dumps({"width": 900, "height": 700, "maximized": True}))
        self.assertEqual(self.studio.settings["window"], before_window)
        self.studio.setting("pdf", json.dumps({"pageSize": "a4"}))
        self.assertEqual(set(self.studio.settings["pdf"]), set(DEFAULT_PDF))
        with patch("python_runtime.validate", side_effect=ValueError("Python missing")):
            self.studio.setting("python", json.dumps("/bad/python"))
        self.assertEqual(self.studio.python_status, "Python missing")
        self.assertIs(studio_chrome._studio_module(), studio_mod)


if __name__ == "__main__":
    unittest.main()
