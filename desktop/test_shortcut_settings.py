"""Qt smoke for the settings page and its focusable shortcut recorder."""
import json
import os
import sys
import unittest
from pathlib import Path

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
os.environ.setdefault("QT_QUICK_BACKEND", "software")

from PySide6.QtCore import QEvent, QPointF, QUrl, Qt
from PySide6.QtGui import QGuiApplication, QKeySequence
from PySide6.QtQml import QQmlComponent, QQmlEngine
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
        QQuickStyle.setStyle("Material")
        cls.app = QGuiApplication.instance() or QGuiApplication(["shortcut settings smoke"])

    def setUp(self):
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
        QTest.keyClick(self.window, Qt.Key_K, Qt.KeyboardModifier.ControlModifier | Qt.KeyboardModifier.AltModifier)
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
            for section, control_name in (("appearance", "settingsScroll"), ("reading", "readingFontChoice"), ("writing", "writingAutosave"), ("python", "pythonPath"), ("system", "inspectAppStorage"), ("shortcuts", "shortcutRecorder_find")):
                page.setProperty("section", section)
                QTest.qWait(20)
                control = self.named_item(control_name)
                self.assertIsNotNone(control, f"{section} controls must exist at {width}x{height}")
                self.assertTrue(control.isVisible(), f"{section} controls must be reachable at {width}x{height}")

    def test_native_settings_text_copy_keeps_the_qml_editor_shortcut(self):
        field = self.named_item("nativeTextField")
        self.assertIsNotNone(field)
        field.forceActiveFocus()
        QTest.keyClick(self.window, Qt.Key_A, Qt.KeyboardModifier.ControlModifier)
        QGuiApplication.clipboard().setText("clipboard sentinel")
        QTest.keyClick(self.window, Qt.Key_C, Qt.KeyboardModifier.ControlModifier)
        QTest.qWait(40)
        self.assertFalse(self.window.property("copyShortcutTriggered"), "The app-level reader copy action must yield to native text inputs")
        self.assertEqual(QGuiApplication.clipboard().text(), "native clipboard", "Ctrl+C must copy the selected QML field text")

    def test_application_shortcuts_stay_inside_settings_modal(self):
        self.window.setProperty("modalDialogCount", 1)
        QTest.keyClick(self.window, Qt.Key_N, Qt.KeyboardModifier.ControlModifier)
        QTest.qWait(40)
        self.assertFalse(self.window.property("newNoteShortcutTriggered"), "A modal settings dialog must disable background app actions")
        self.window.setProperty("modalDialogCount", 0)
        QTest.keyClick(self.window, Qt.Key_N, Qt.KeyboardModifier.ControlModifier)
        QTest.qWait(40)
        self.assertTrue(self.window.property("newNoteShortcutTriggered"), "The app action should reactivate when the modal closes")


if __name__ == "__main__":
    unittest.main()
