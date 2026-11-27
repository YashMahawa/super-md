"""Check actual Qt Material label colors, not just semantic palette tokens."""
import json
import os
import unittest
from pathlib import Path
os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
from PySide6.QtCore import QObject, Property, QUrl, QEvent
from PySide6.QtGui import QGuiApplication
from PySide6.QtQml import QQmlEngine, QQmlComponent
from PySide6.QtQuickControls2 import QQuickStyle
from PySide6.QtTest import QTest
from material_color_utilities import get_contrast_ratio

class ModePalette(QObject):
    @Property(str, constant=True)
    def snapshot(self):
        return json.dumps({"settings": {"motion": False}, "colors": {
            "text": "#201a17", "primary": "#8c4b2b", "on-primary": "#ffffff",
            "surface-low": "#f8d7c5", "surface-high": "#eac1ac", "outline": "#88756b"}})
    @Property("QVariantMap", constant=True)
    def palette(self): return json.loads(self.snapshot)["colors"]
    @Property(bool, constant=True)
    def motionEnabled(self): return json.loads(self.snapshot)["settings"]["motion"]

class ModeGroupTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if QGuiApplication.instance() is None:
            QQuickStyle.setStyle("Material")
        cls.app = QGuiApplication.instance() or QGuiApplication(["Mode contrast tests"])

    def test_selected_label_uses_validated_color_not_stock_highlight_override(self):
        engine = QQmlEngine()
        palette = ModePalette()
        engine.rootContext().setContextProperty("studio", palette)
        component = QQmlComponent(engine)
        component.setData(b'''
import QtQuick
import QtQuick.Controls
ApplicationWindow {
    width: 400; height: 100; visible: true
    property string rows: JSON.stringify(group.contentItem.children.filter(b => b.text).map(b => ({
        text: b.text, foreground: b.contentItem.color.toString(), background: b.background.color.toString()
    })))
    ModeGroup {
        id: group; selected: "reader"
        choices: [{key:"live",label:"Live"},{key:"reader",label:"Read"}]
    }
}
''', QUrl.fromLocalFile(str(Path(__file__).parent / "qml/mode-test.qml")))
        window = component.create()
        self.assertIsNotNone(window, str(component.errors()))
        try:
            QTest.qWait(30)
            rows = {row["text"]: row for row in json.loads(window.property("rows"))}
            selected = rows["Read"]
            self.assertEqual(selected["foreground"], "#ffffff")
            self.assertEqual(selected["background"], "#8c4b2b")
            self.assertGreaterEqual(get_contrast_ratio(selected["foreground"], selected["background"]), 4.5)
            self.assertEqual(rows["Live"]["foreground"], "#201a17")
        finally:
            window.close(); window.deleteLater()
            self.app.sendPostedEvents(None, QEvent.Type.DeferredDelete)
            engine.deleteLater()
            self.app.sendPostedEvents(None, QEvent.Type.DeferredDelete)

    def test_mode_buttons_expose_configured_shortcut_hints_and_hide_disabled_bindings(self):
        engine = QQmlEngine()
        palette = ModePalette()
        engine.rootContext().setContextProperty("studio", palette)
        component = QQmlComponent(engine)
        component.setData(b'''
import QtQuick
import QtQuick.Controls
ApplicationWindow {
    id: window
    width: 520; height: 120; visible: true
    property int contextMenuCount: 0
    property int modalDialogCount: 0
    property var shortcutLabels: ({
        mode_live: "Ctrl+Alt+1",
        mode_editor: "Ctrl+Alt+2",
        mode_reader: "Disabled",
        mode_split: "Ctrl+Alt+4"
    })
    function hintWithShortcut(label, key) {
        const raw = window.shortcutLabels[key] || ""
        return raw && raw !== "Disabled" ? label + " (" + raw + ")" : label
    }
    ModeGroup {
        id: group
        selected: "live"
        choices: [
            {key:"live", label:"Live", tooltip: window.hintWithShortcut("Live mode", "mode_live")},
            {key:"editor", label:"Source", tooltip: window.hintWithShortcut("Source mode", "mode_editor")},
            {key:"reader", label:"Read", tooltip: window.hintWithShortcut("Read mode", "mode_reader")},
            {key:"split", label:"Split", tooltip: window.hintWithShortcut("Split mode", "mode_split")}
        ]
    }
}
''', QUrl.fromLocalFile(str(Path(__file__).parent / "qml/mode-hints-test.qml")))
        window = component.create()
        self.assertIsNotNone(window, str(component.errors()))
        try:
            QTest.qWait(30)
            def find_visual(root, name):
                pending = [root]
                while pending:
                    current = pending.pop()
                    if current.objectName() == name:
                        return current
                    pending.extend(current.childItems())
                return None

            content = window.contentItem()
            live_btn = find_visual(content, "modeButton_live")
            editor_btn = find_visual(content, "modeButton_editor")
            reader_btn = find_visual(content, "modeButton_reader")
            split_btn = find_visual(content, "modeButton_split")
            self.assertIsNotNone(live_btn)
            self.assertEqual(live_btn.property("text"), "Live")
            self.assertEqual(
                live_btn.findChild(QObject, "actionHint").property("text"),
                "Live mode (Ctrl+Alt+1)",
            )
            self.assertEqual(
                editor_btn.findChild(QObject, "actionHint").property("text"),
                "Source mode (Ctrl+Alt+2)",
            )
            self.assertEqual(
                reader_btn.findChild(QObject, "actionHint").property("text"),
                "Read mode",
            )
            self.assertEqual(
                split_btn.findChild(QObject, "actionHint").property("text"),
                "Split mode (Ctrl+Alt+4)",
            )
        finally:
            window.close(); window.deleteLater()
            self.app.sendPostedEvents(None, QEvent.Type.DeferredDelete)
            engine.deleteLater()
            self.app.sendPostedEvents(None, QEvent.Type.DeferredDelete)
