"""Qt smoke for the settings page and its focusable shortcut recorder."""
import json
import os
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
os.environ.setdefault("QT_QUICK_BACKEND", "software")

from PySide6.QtCore import QEvent, QPointF, QUrl, Qt
from PySide6.QtGui import QGuiApplication, QKeySequence
from PySide6.QtQml import QQmlComponent, QQmlEngine
from PySide6.QtQuick import QQuickWindow  # noqa: F401
from PySide6.QtQuickControls2 import QQuickStyle
from PySide6.QtTest import QTest

from studio import Session
from test_studio import QuietStudio

QML_DIR = Path(__file__).parent / "qml"
MAIN_QML = QML_DIR / "Main.qml"


def _production_text_editor_focus():
    source = MAIN_QML.read_text(encoding="utf-8")
    start = source.index("    function nativeTextEditorFocused()")
    brace = source.index("{", start)
    depth = 0
    for end in range(brace, len(source)):
        if source[end] == "{": depth += 1
        elif source[end] == "}":
            depth -= 1
            if depth == 0:
                return source[start:end + 1]
    raise AssertionError("Could not extract the production native text focus check")


def _production_shortcut_enabled():
    source = MAIN_QML.read_text(encoding="utf-8")
    start = source.index("    function shortcutEnabled(action)")
    brace = source.index("{", start)
    depth = 0
    for end in range(brace, len(source)):
        if source[end] == "{": depth += 1
        elif source[end] == "}":
            depth -= 1
            if depth == 0:
                return source[start:end + 1]
    raise AssertionError("Could not extract the production shortcut enablement check")


class ShortcutSettingsSmokeTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if QQuickStyle.name() != "Material":
            QQuickStyle.setStyle("Material")
        cls.app = QGuiApplication.instance() or QGuiApplication(["shortcut settings smoke"])

    def setUp(self):
        self._discover_patch = patch("python_runtime.discover", return_value=[])
        self.discover_mock = self._discover_patch.start()
        self.addCleanup(self._discover_patch.stop)
        self.session = Session(True)
        self.studio = QuietStudio(True, self.session)
        self.engine = QQmlEngine()
        self.engine.rootContext().setContextProperty("studio", self.studio)
        focus_function = _production_text_editor_focus().replace("window.activeFocusItem", "host.activeFocusItem")
        shortcut_enabled_function = _production_shortcut_enabled().replace("window.", "host.")
        source = f'''import QtQuick
import QtQuick.Controls
import QtQuick.Controls.Material
import "."
ApplicationWindow {{
    id: host
    width: 960; height: 700; visible: true
    property var viewState: JSON.parse(studio.snapshot)
    property var shortcutBindings: JSON.parse(studio.shortcutBindings)
    property bool capturingShortcut: false
    property bool triggered: false
    property bool copyShortcutTriggered: false
    property bool newNoteShortcutTriggered: false
    property int modalDialogCount: 0
    Material.theme: viewState.dark ? Material.Dark : Material.Light
    {focus_function}
    {shortcut_enabled_function}
    Popup {{ id: contentsPopup }}
    SettingsPage {{ anchors.fill: parent; viewState: host.viewState }}
    TextField {{ objectName: "nativeTextField"; x: 12; y: 12; width: 220; height: 40; text: "native clipboard"; selectByMouse: true }}
    Shortcut {{ sequence: "Ctrl+C"; enabled: !host.nativeTextEditorFocused(); onActivated: host.copyShortcutTriggered = true }}
    Shortcut {{ sequence: "Ctrl+N"; enabled: host.shortcutEnabled("new_note"); onActivated: host.newNoteShortcutTriggered = true }}
    Shortcut {{ sequence: host.shortcutBindings.find.length ? host.shortcutBindings.find[0] : ""; enabled: !host.capturingShortcut; onActivated: host.triggered = true }}
}}'''
        self.component = QQmlComponent(self.engine)
        self.component.setData(source.encode(), QUrl.fromLocalFile(str(QML_DIR / "shortcut-settings-smoke.qml")))
        self.assertFalse(self.component.isError(), "\n".join(error.toString() for error in self.component.errors()))
        self.window = self.component.create()
        self.assertIsNotNone(self.window, "\n".join(error.toString() for error in self.component.errors()))
        QTest.qWait(50)

    def tearDown(self):
        self.window.close()
        self.window.deleteLater()
        self.app.sendPostedEvents(None, QEvent.Type.DeferredDelete)
        self.engine.deleteLater()
        self.app.sendPostedEvents(None, QEvent.Type.DeferredDelete)
        self.studio.stop()
        self.studio.pool.shutdown(wait=True)
        self.session.writes.shutdown(wait=True)

    def named_item(self, name):
        pending = [self.window.contentItem()]
        while pending:
            item = pending.pop()
            if item.objectName() == name: return item
            pending.extend(item.childItems())
        return None

    def choose_shortcut_settings(self):
        page = self.window.findChild(object, "settingsPage")
        self.assertIsNotNone(page)
        section = self.named_item("settingsSection_shortcuts")
        self.assertIsNotNone(section)
        point = section.mapToScene(QPointF(section.width() / 2, section.height() / 2)).toPoint()
        QTest.mouseClick(self.window, Qt.MouseButton.LeftButton, Qt.KeyboardModifier.NoModifier, point)
        QTest.qWait(40)
        self.assertEqual(page.property("section"), "shortcuts")
        self.assertIsNone(self.window.findChild(object, "shortcutsPopup"), "Shortcut editing belongs in Settings, without a nested popup")
        return page

    def test_shortcut_editor_is_in_settings_category_and_captures_validates_and_resets(self):
        page = self.choose_shortcut_settings()
        actions = json.loads(self.studio.shortcutActions)
        default_bindings = {
            action["id"]: self.studio.shortcutSequences(action["id"])
            for action in actions
        }
        for action in actions:
            self.assertIsNotNone(self.named_item("shortcutRecorder_" + action["id"]))
        for format_action in ("bold", "italic", "inline_code", "link", "heading", "list", "quote", "inline_math"):
            self.assertIn(format_action, default_bindings)
        self.assertIn("Italic", self.studio.setShortcut("bold", "Ctrl+I"))
        self.assertEqual(self.studio.setShortcut("bold", "Ctrl+Alt+B"), "")
        self.assertEqual(self.studio.shortcutSequences("bold"), ["Ctrl+Alt+B"])
        self.assertEqual(self.studio.setShortcut("bold", ""), "")
        self.assertEqual(self.studio.shortcutSequences("bold"), [])
        emitted_calls = []
        self.studio.readerCall.connect(emitted_calls.append)
        self.studio.command("format_bold")
        self.assertIn("window.supermdFormat?.('bold')", emitted_calls)
        self.assertEqual(self.studio.resetShortcuts(), "")
        # Main.qml's Settings dialog is the single modal. Picking its shortcuts
        # category must not add another modal layer over the settings page.
        self.window.setProperty("modalDialogCount", 1)
        self.assertEqual(self.window.property("modalDialogCount"), 1)
        recorder = self.named_item("shortcutRecorder_find")
        scroll = self.window.findChild(object, "settingsScroll")
        self.assertIsNotNone(recorder)
        self.assertIsNotNone(scroll)
        self.assertTrue(recorder.isVisible())
        self.assertEqual(recorder.property("value"), self.studio.shortcutLabel("find"))
        scroll_content = scroll.property("contentItem")
        self.assertGreater(scroll_content.property("contentHeight"), scroll.height(), "The in-page shortcut list must remain scrollable")
        top = recorder.mapToItem(scroll_content, QPointF(0, 0)).y()
        scroll_content.setProperty("contentY", max(0, top - 24))
        QTest.qWait(60)
        visible_top = recorder.mapToItem(scroll, QPointF(0, 0)).y()
        self.assertGreaterEqual(visible_top, 0, "Scrolling must bring the recorder inside the settings viewport")
        self.assertLessEqual(visible_top + recorder.height(), scroll.height())
        point = recorder.mapToScene(QPointF(recorder.width() / 2, recorder.height() / 2)).toPoint()
        QTest.mouseClick(self.window, Qt.MouseButton.LeftButton, Qt.KeyboardModifier.NoModifier, point)
        QTest.qWait(20)
        self.assertTrue(recorder.property("recording"), "Clicking a shortcut row must start key capture")
        self.assertTrue(self.window.property("capturingShortcut"))
        QTest.keyClick(self.window, Qt.Key.Key_K, Qt.KeyboardModifier.ControlModifier | Qt.KeyboardModifier.AltModifier)
        QTest.qWait(40)
        self.assertFalse(self.window.property("capturingShortcut"))
        self.assertEqual(self.studio.shortcutSequences("find"), ["Ctrl+Alt+K"])
        self.assertFalse(self.window.property("triggered"), "The app shortcut must stay suppressed while recording a binding")
        self.assertEqual(recorder.property("value"), "⌥⌘K" if sys.platform == "darwin" else "Ctrl+Alt+K")

        original = self.studio.shortcutSequences("find")
        open_combo = QKeySequence(self.studio.shortcutSequences("open")[0])[0]
        point = recorder.mapToScene(QPointF(recorder.width() / 2, recorder.height() / 2)).toPoint()
        QTest.mouseClick(self.window, Qt.MouseButton.LeftButton, Qt.KeyboardModifier.NoModifier, point)
        QTest.keyClick(self.window, open_combo.key(), open_combo.keyboardModifiers())
        QTest.qWait(40)
        self.assertEqual(self.studio.shortcutSequences("find"), original, "Conflicting shortcuts must leave the existing binding unchanged")
        self.assertIn("Open note", page.property("shortcutMessage"), "Validation feedback should remain visible inline")

        self.assertEqual(self.studio.setShortcut("find", "Ctrl+Alt+L"), "")
        reset = self.named_item("resetShortcuts")
        self.assertIsNotNone(reset)
        scroll_content.setProperty("contentY", max(0, scroll_content.property("contentHeight") - scroll.height()))
        QTest.qWait(60)
        point = reset.mapToScene(QPointF(reset.width() / 2, reset.height() / 2)).toPoint()
        QTest.mouseClick(self.window, Qt.MouseButton.LeftButton, Qt.KeyboardModifier.NoModifier, point)
        QTest.qWait(40)
        self.assertEqual(
            {action_id: self.studio.shortcutSequences(action_id) for action_id in default_bindings},
            default_bindings,
            "The in-page reset control must restore every default binding",
        )
        self.assertEqual(self.window.property("modalDialogCount"), 1)

    def test_settings_categories_keep_controls_reachable_at_window_sizes(self):
        page = self.window.findChild(object, "settingsPage")
        self.assertIsNotNone(page)
        for width, height in ((1280, 720), (1920, 1080), (900, 560)):
            self.window.resize(width, height)
            for section, control_name in (("appearance", "settingsScroll"), ("reading", "readingFontChoice"), ("writing", "writingAutosave"), ("python", "pythonPath"), ("storage", "inspectAppStorage"), ("updates", "openLatestGitHubRelease"), ("shortcuts", "shortcutRecorder_find")):
                page.setProperty("section", section)
                QTest.qWait(20)
                control = self.named_item(control_name)
                self.assertIsNotNone(control, f"{section} controls must exist at {width}x{height}")
                self.assertTrue(control.isVisible(), f"{section} controls must be reachable at {width}x{height}")

    def test_native_settings_text_copy_keeps_the_qml_editor_shortcut(self):
        field = self.named_item("nativeTextField")
        self.assertIsNotNone(field)
        field.forceActiveFocus()
        QTest.keyClick(self.window, Qt.Key.Key_A, Qt.KeyboardModifier.ControlModifier)
        QGuiApplication.clipboard().setText("clipboard sentinel")
        QTest.keyClick(self.window, Qt.Key.Key_C, Qt.KeyboardModifier.ControlModifier)
        QTest.qWait(40)
        self.assertFalse(self.window.property("copyShortcutTriggered"), "The app-level reader copy action must yield to native text inputs")
        self.assertEqual(QGuiApplication.clipboard().text(), "native clipboard", "Ctrl+C must copy the selected QML field text")

    def test_application_shortcuts_stay_inside_settings_modal(self):
        self.window.setProperty("modalDialogCount", 1)
        QTest.keyClick(self.window, Qt.Key.Key_N, Qt.KeyboardModifier.ControlModifier)
        QTest.qWait(40)
        self.assertFalse(self.window.property("newNoteShortcutTriggered"), "A modal settings dialog must disable background app actions")
        self.window.setProperty("modalDialogCount", 0)
        QTest.keyClick(self.window, Qt.Key.Key_N, Qt.KeyboardModifier.ControlModifier)
        QTest.qWait(40)
        self.assertTrue(self.window.property("newNoteShortcutTriggered"), "The app action should reactivate when the modal closes")

    def test_python_discovery_defers_until_python_section_is_opened(self):
        page = self.window.findChild(object, "settingsPage")
        self.assertIsNotNone(page)
        self.assertEqual(page.property("section"), "appearance")
        self.discover_mock.assert_not_called()
        page.setProperty("section", "python")
        deadline = 40
        while not self.discover_mock.called and deadline > 0:
            QTest.qWait(25)
            deadline -= 1
        self.discover_mock.assert_called_once()
        page.setProperty("section", "reading")
        QTest.qWait(20)
        page.setProperty("section", "python")
        QTest.qWait(40)
        self.discover_mock.assert_called_once()

    def test_appearance_settings_expose_bundled_presets_saved_themes_and_scoped_file_actions(self):
        import custom_theme
        from unittest.mock import patch
        page = self.window.findChild(object, "settingsPage")
        self.assertIsNotNone(page)
        page.setProperty("section", "appearance")
        QTest.qWait(30)
        preset_choice = self.named_item("bundledThemeChoice")
        self.assertIsNotNone(preset_choice)
        self.assertEqual(preset_choice.property("count"), 17, "Built-in appearance plus 16 bundled presets must be selectable")
        edit_btn = self.named_item("editThemeFile")
        reload_btn = self.named_item("reloadThemeFile")
        self.assertIsNotNone(edit_btn)
        self.assertIsNotNone(reload_btn)
        self.assertFalse(edit_btn.isVisible())
        self.assertFalse(reload_btn.isVisible())

        source = self.studio.data / "imported-ui.supermd-theme.json"
        source.write_text(json.dumps({**custom_theme.TEMPLATE, "name": "UI Imported"}))
        pending = []
        with patch.object(self.studio, "_engine", return_value=Path("unused-theme-engine")), patch.object(
            self.studio, "_submit", side_effect=lambda action, done, *_: pending.append((action, done))
        ), patch("custom_theme.read", side_effect=lambda _, p: json.loads(Path(p).read_text())):
            self.studio.importCustomTheme(str(source))
            while pending:
                action, done = pending.pop(0)
                done(action(), None)
        QTest.qWait(40)
        self.assertTrue(edit_btn.isVisible())
        self.assertTrue(reload_btn.isVisible())
        saved_entry = self.studio.savedThemes[0]
        self.assertIsNotNone(self.named_item("deleteSavedTheme_" + saved_entry["id"]))

        pending = []
        with patch.object(self.studio, "_engine", return_value=Path("unused-theme-engine")), patch.object(
            self.studio, "_submit", side_effect=lambda action, done, *_: pending.append((action, done))
        ), patch("custom_theme.read", side_effect=lambda _, p: json.loads(Path(p).read_text())):
            self.studio.selectBundledTheme("study-desk")
            while pending:
                action, done = pending.pop(0)
                done(action(), None)
        QTest.qWait(40)
        self.assertFalse(edit_btn.isVisible(), "Bundled presets must hide external file edit/reload actions")
        self.assertFalse(reload_btn.isVisible())
        self.assertIsNotNone(self.named_item("deleteSavedTheme_" + saved_entry["id"]), "Saved imported themes remain available while a preset is active")

    def test_writing_typewriter_scroll_switch_and_shortcut_row_sync_with_studio(self):
        page = self.window.findChild(object, "settingsPage")
        self.assertIsNotNone(page)
        page.setProperty("section", "writing")
        QTest.qWait(30)
        switch = self.named_item("writingTypewriterScroll")
        self.assertIsNotNone(switch)
        self.assertTrue(switch.isVisible())
        self.assertFalse(self.studio.settings["typewriterScroll"])
        self.assertFalse(switch.property("checked"))
        point = switch.mapToScene(QPointF(switch.width() / 2, switch.height() / 2)).toPoint()
        QTest.mouseClick(self.window, Qt.MouseButton.LeftButton, Qt.KeyboardModifier.NoModifier, point)
        QTest.qWait(40)
        self.assertTrue(self.studio.settings["typewriterScroll"])
        self.window.setProperty("viewState", json.loads(self.studio.snapshot))
        QTest.qWait(20)
        self.assertTrue(switch.property("checked"))
        QTest.mouseClick(self.window, Qt.MouseButton.LeftButton, Qt.KeyboardModifier.NoModifier, point)
        QTest.qWait(40)
        self.assertFalse(self.studio.settings["typewriterScroll"])

        self.choose_shortcut_settings()
        recorder = self.named_item("shortcutRecorder_typewriter_scroll")
        self.assertIsNotNone(recorder)
        self.assertEqual(self.studio.shortcutSequences("typewriter_scroll"), ["Ctrl+Alt+T"])

    def test_direct_mode_shortcuts_appear_in_settings_and_gate_split_below_1000px(self):
        from PySide6.QtCore import QMetaObject, Q_ARG, Q_RETURN_ARG

        def enabled(action):
            return QMetaObject.invokeMethod(
                self.window,
                "shortcutEnabled",
                Q_RETURN_ARG("QVariant"),
                Q_ARG("QVariant", action),
            )

        self.choose_shortcut_settings()
        for action_id, expected in (
            ("new_folder_note", ["Ctrl+Alt+N"]),
            ("new_subfolder", ["Ctrl+Alt+Shift+N"]),
            ("rename_entry", ["F2"]),
            ("mode_live", ["Ctrl+Alt+1"]),
            ("mode_editor", ["Ctrl+Alt+2"]),
            ("mode_reader", ["Ctrl+Alt+3"]),
            ("mode_split", ["Ctrl+Alt+4"]),
        ):
            self.assertIsNotNone(self.named_item("shortcutRecorder_" + action_id))
            self.assertEqual(self.studio.shortcutSequences(action_id), expected)

        # At 960px (< 1000px), Live/Source/Read and folder actions are enabled while Split is gated off.
        self.assertEqual(self.window.width(), 960)
        self.assertTrue(enabled("new_folder_note"))
        self.assertTrue(enabled("new_subfolder"))
        self.assertTrue(enabled("rename_entry"))
        self.assertTrue(enabled("mode_live"))
        self.assertTrue(enabled("mode_editor"))
        self.assertTrue(enabled("mode_reader"))
        self.assertFalse(enabled("mode_split"))

        # Widening >= 1000px enables Split mode shortcut.
        self.window.resize(1120, 700)
        QTest.qWait(30)
        self.assertTrue(enabled("mode_split"))

        # Modal dialogs (including folder create/rename dialogs) and reader/fullscreen overlays suppress direct mode shortcuts.
        self.window.setProperty("modalDialogCount", 1)
        self.assertFalse(enabled("new_folder_note"))
        self.assertFalse(enabled("rename_entry"))
        self.assertFalse(enabled("mode_live"))
        self.assertFalse(enabled("mode_split"))
        self.window.setProperty("modalDialogCount", 0)

        overlay_state = json.loads(self.studio.snapshot)
        overlay_state["readerOverlay"] = True
        self.window.setProperty("viewState", overlay_state)
        self.assertFalse(enabled("mode_reader"))
        overlay_state["readerOverlay"] = False
        overlay_state["fullscreen"] = True
        self.window.setProperty("viewState", overlay_state)
        self.assertFalse(enabled("mode_editor"))

        # Clearing a mode shortcut marks its label Disabled cleanly and remapping updates it without touching folder shortcuts.
        self.assertEqual(self.studio.setShortcut("mode_reader", ""), "")
        self.assertEqual(self.studio.shortcutLabel("mode_reader"), "Disabled")
        self.assertEqual(self.studio.setShortcut("mode_reader", "Ctrl+Alt+9"), "")
        self.assertIn("9", self.studio.shortcutLabel("mode_reader"))
        self.assertEqual(self.studio.shortcutSequences("new_folder_note"), ["Ctrl+Alt+N"])
        self.assertEqual(self.studio.shortcutSequences("rename_entry"), ["F2"])

    def test_python_discovery_waits_for_visible_python_section_and_rescans_on_demand(self):
        from unittest.mock import patch

        session = Session(True)
        studio = QuietStudio(True, session)
        engine = QQmlEngine()
        engine.rootContext().setContextProperty("studio", studio)
        source = '''import QtQuick
import QtQuick.Controls
import QtQuick.Controls.Material
import "."
ApplicationWindow {
    id: host
    width: 960; height: 700; visible: true
    property var viewState: JSON.parse(studio.snapshot)
    property bool settingsOpen: false
    property int modalDialogCount: 0
    onSettingsOpenChanged: settingsOpen ? settingsDialog.open() : settingsDialog.close()
    Material.theme: viewState.dark ? Material.Dark : Material.Light
    AppDialog {
        id: settingsDialog
        objectName: "settingsDialog"
        width: Math.min(840, host.width - 48)
        height: Math.min(760, host.height - 48)
        padding: 0
        onClosed: host.settingsOpen = false
        SettingsPage { ownerPopup: settingsDialog; viewState: host.viewState; anchors.fill: parent; onBack: host.settingsOpen = false }
    }
}'''
        component = QQmlComponent(engine)
        component.setData(source.encode(), QUrl.fromLocalFile(str(QML_DIR / "deferred-python-settings-smoke.qml")))
        self.assertFalse(component.isError(), "\n".join(error.toString() for error in component.errors()))
        with patch.object(studio, "refreshPython", wraps=studio.refreshPython) as refresh_spy, patch(
            "python_runtime.discover", return_value=[{"path": sys.executable, "label": "System Python 3.12", "detail": "ready", "matplotlib": True, "managed": False, "venv": False}]
        ) as discover_mock:
            dialog_window = component.create()
            self.assertIsNotNone(dialog_window)
            try:
                QTest.qWait(40)
                page = dialog_window.findChild(object, "settingsPage")
                dialog = dialog_window.findChild(object, "settingsDialog")
                self.assertIsNotNone(page)
                self.assertIsNotNone(dialog)
                self.assertFalse(dialog.property("visible"))
                self.assertFalse(studio.pythonBusy)
                self.assertEqual(refresh_spy.call_count, 0)
                self.assertEqual(discover_mock.call_count, 0)

                # Selecting "python" while settingsDialog remains closed must not scan.
                page.setProperty("section", "python")
                QTest.qWait(30)
                self.assertEqual(refresh_spy.call_count, 0)
                page.setProperty("section", "appearance")
                QTest.qWait(20)

                # Opening Settings on "appearance" and switching to "shortcuts" spawns 0 scans.
                dialog_window.setProperty("settingsOpen", True)
                QTest.qWait(40)
                self.assertTrue(dialog.property("visible"))
                self.assertEqual(refresh_spy.call_count, 0)
                page.setProperty("section", "shortcuts")
                QTest.qWait(30)
                self.assertEqual(refresh_spy.call_count, 0)
                self.assertEqual(discover_mock.call_count, 0)

                # Switching section to "python" while visible calls studio.refreshPython() once.
                page.setProperty("section", "python")
                QTest.qWait(60)
                self.assertEqual(refresh_spy.call_count, 1)
                self.assertEqual(discover_mock.call_count, 1)

                # Switching away and back does not trigger redundant automatic scans.
                page.setProperty("section", "appearance")
                QTest.qWait(20)
                page.setProperty("section", "python")
                QTest.qWait(40)
                self.assertEqual(refresh_spy.call_count, 1)

                # Clicking "Scan again" explicitly rescans.
                scroll = dialog_window.findChild(object, "settingsScroll")
                self.assertIsNotNone(scroll)
                scroll_content = scroll.property("contentItem")
                scroll_content.setProperty("contentY", max(0, scroll_content.property("contentHeight") - scroll.height()))
                QTest.qWait(40)
                rescan = dialog_window.findChild(object, "rescanPython")
                self.assertIsNotNone(rescan)
                self.assertTrue(rescan.property("enabled"))
                point = rescan.mapToScene(QPointF(rescan.width() / 2, rescan.height() / 2)).toPoint()
                QTest.mouseClick(dialog_window, Qt.MouseButton.LeftButton, Qt.KeyboardModifier.NoModifier, point)
                QTest.qWait(60)
                self.assertEqual(refresh_spy.call_count, 2)
                self.assertEqual(discover_mock.call_count, 2)
            finally:
                dialog_window.close()
                dialog_window.deleteLater()
                self.app.sendPostedEvents(None, QEvent.Type.DeferredDelete)
                engine.deleteLater()
                self.app.sendPostedEvents(None, QEvent.Type.DeferredDelete)
                studio.stop()
                studio.pool.shutdown(wait=True)
                session.writes.shutdown(wait=True)

    def test_main_qml_with_closed_settings_spawns_zero_python_probes(self):
        import subprocess

        probe_code = r'''
import json, os, sys
from pathlib import Path
from unittest.mock import patch

os.environ["QT_QPA_PLATFORM"] = "offscreen"
os.environ["QT_QUICK_BACKEND"] = "software"
os.environ.setdefault("QTWEBENGINE_DISABLE_SANDBOX", "1")
os.environ.setdefault("QTWEBENGINE_CHROMIUM_FLAGS", "--disable-gpu --disable-dev-shm-usage")

from PySide6.QtCore import QFile, QIODevice, QObject, QUrl
from PySide6.QtQml import QQmlApplicationEngine
from PySide6.QtQuickControls2 import QQuickStyle
from PySide6.QtTest import QTest
from PySide6.QtWebEngineQuick import QtWebEngineQuick
from PySide6.QtWidgets import QApplication

QQuickStyle.setStyle("Material")
QtWebEngineQuick.initialize()
app = QApplication(["main qml startup python probe test"])

root = Path(sys.argv[1]).resolve()
sys.path.insert(0, str(root))
import python_runtime
from studio import Session, Studio

probes = []
with patch("python_runtime.probe", side_effect=lambda *args, **kwargs: probes.append(args)):
    for initial_python in ("", sys.executable):
        session = Session(True)
        session.settings["python"] = initial_python
        studio = Studio(True, session)
        channel = QFile(":/qtwebchannel/qwebchannel.js")
        assert channel.open(QIODevice.OpenModeFlag.ReadOnly)
        engine = QQmlApplicationEngine()
        engine.rootContext().setContextProperty("studio", studio)
        engine.rootContext().setContextProperty("readerUrl", QUrl("about:blank"))
        engine.rootContext().setContextProperty("channelScript", bytes(channel.readAll()).decode())
        engine.rootContext().setContextProperty("brandUrl", QUrl.fromLocalFile(str(root.parent / "public" / "brand-mark-fixed.svg")))
        engine.load(QUrl.fromLocalFile(str(root / "qml" / "Main.qml")))
        assert engine.rootObjects(), "Main.qml failed to load"
        window = engine.rootObjects()[0]
        assert window.property("settingsOpen") is False
        assert window.findChild(QObject, "settingsPage") is not None
        QTest.qWait(80)
        assert studio.pythonBusy is False
        assert bool(studio.settings["python"])
        window.close()
        del engine
        studio.stop()
        studio.pool.shutdown(wait=True, cancel_futures=True)
        session.writes.shutdown(wait=True)

print(json.dumps({"probes": len(probes)}), flush=True)
os._exit(0)
'''
        completed = subprocess.run(
            [sys.executable, "-c", probe_code, str(Path(__file__).resolve().parent)],
            capture_output=True,
            text=True,
            timeout=60,
        )
        self.assertEqual(completed.returncode, 0, f"{completed.stdout}\n{completed.stderr}")
        payload = json.loads(completed.stdout.strip().splitlines()[-1])
        self.assertEqual(payload["probes"], 0)

    def test_main_qml_routes_mode_and_folder_shortcuts_and_suppresses_modes_in_folder_modals(self):
        import subprocess

        script = r'''
import json, os, shutil, sys, tempfile
from pathlib import Path

os.environ["QT_QPA_PLATFORM"] = "offscreen"
os.environ["QT_QUICK_BACKEND"] = "software"
os.environ.setdefault("QTWEBENGINE_DISABLE_SANDBOX", "1")
os.environ.setdefault("QTWEBENGINE_CHROMIUM_FLAGS", "--disable-gpu --disable-dev-shm-usage")

from PySide6.QtCore import QFile, QIODevice, QMetaObject, QObject, QUrl, Q_ARG, Q_RETURN_ARG
from PySide6.QtQml import QQmlApplicationEngine
from PySide6.QtQuickControls2 import QQuickStyle
from PySide6.QtTest import QTest
from PySide6.QtWebEngineQuick import QtWebEngineQuick
from PySide6.QtWidgets import QApplication

QQuickStyle.setStyle("Material")
QtWebEngineQuick.initialize()
app = QApplication(["main qml mode + folder shortcuts test"])

root = Path(sys.argv[1]).resolve()
sys.path.insert(0, str(root))
from studio import Session, Studio

temp_folder = Path(tempfile.mkdtemp(prefix="supermd-main-shortcuts-"))
try:
    session = Session(True)
    session.settings["python"] = sys.executable
    session.settings["welcomed"] = True
    session.settings["motion"] = False
    studio = Studio(True, session)
    studio.openFolder(str(temp_folder))
    channel = QFile(":/qtwebchannel/qwebchannel.js")
    assert channel.open(QIODevice.OpenModeFlag.ReadOnly)
    engine = QQmlApplicationEngine()
    engine.rootContext().setContextProperty("studio", studio)
    engine.rootContext().setContextProperty("readerUrl", QUrl("about:blank"))
    engine.rootContext().setContextProperty("channelScript", bytes(channel.readAll()).decode())
    engine.rootContext().setContextProperty("brandUrl", QUrl.fromLocalFile(str(root.parent / "public" / "brand-mark-fixed.svg")))
    engine.load(QUrl.fromLocalFile(str(root / "qml" / "Main.qml")))
    assert engine.rootObjects(), "Main.qml failed to load"
    window = engine.rootObjects()[0]
    window.show()
    QTest.qWait(60)

    def activate(action):
        assert QMetaObject.invokeMethod(window, "activateShortcut", Q_ARG("QVariant", action))

    def is_enabled(action):
        return bool(QMetaObject.invokeMethod(window, "shortcutEnabled", Q_RETURN_ARG("QVariant"), Q_ARG("QVariant", action)))

    window.resize(1280, 820)
    QTest.qWait(30)
    for action, expected_mode in (("mode_editor", "editor"), ("mode_reader", "reader"), ("mode_split", "split"), ("mode_live", "live")):
        assert is_enabled(action), action
        activate(action)
        QTest.qWait(20)
        assert studio.mode == expected_mode, (action, studio.mode)

    # Below 1000px, mode_split is disabled while other mode and folder shortcuts remain active.
    window.resize(900, 720)
    QTest.qWait(30)
    assert not is_enabled("mode_split")
    assert is_enabled("mode_reader")
    assert is_enabled("new_folder_note")
    assert is_enabled("new_subfolder")
    assert is_enabled("rename_entry")

    # Triggering #87 new_folder_note opens sidebar on folder section and opens createFolderItemDialog, gating mode shortcuts.
    window.setProperty("sidebar", False)
    window.setProperty("sidebarSection", "contents")
    activate("new_folder_note")
    QTest.qWait(40)
    assert window.property("sidebar") is True
    assert window.property("sidebarSection") == "folder"
    create_dialog = window.findChild(QObject, "createFolderItemDialog")
    assert create_dialog is not None and bool(create_dialog.property("visible"))
    assert not is_enabled("mode_live")
    create_dialog.close()
    QTest.qWait(30)
    assert is_enabled("mode_live")

    # Triggering #87 rename_entry opens tabFallbackRenameDialog on the unsaved active tab and gates mode shortcuts while open.
    activate("rename_entry")
    QTest.qWait(40)
    fallback_rename = window.findChild(QObject, "tabFallbackRenameDialog")
    assert fallback_rename is not None and bool(fallback_rename.property("visible"))
    assert not is_enabled("mode_editor")
    fallback_rename.close()
    QTest.qWait(30)

    window.close()
    del engine
    studio.stop()
    studio.pool.shutdown(wait=True, cancel_futures=True)
    studio._search_pool.shutdown(wait=True, cancel_futures=True)
    session.writes.shutdown(wait=True)
finally:
    shutil.rmtree(temp_folder, ignore_errors=True)

print(json.dumps({"ok": True}), flush=True)
os._exit(0)
'''
        completed = subprocess.run(
            [sys.executable, "-c", script, str(Path(__file__).resolve().parent)],
            capture_output=True,
            text=True,
            timeout=60,
        )
        self.assertEqual(completed.returncode, 0, f"{completed.stdout}\n{completed.stderr}")
        self.assertTrue(json.loads(completed.stdout.strip().splitlines()[-1])["ok"])


if __name__ == "__main__":
    unittest.main()
