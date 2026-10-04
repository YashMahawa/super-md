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
