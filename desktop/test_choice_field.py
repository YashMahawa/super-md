"""Exercise the real Qt popup placement, including its clipped settings viewport."""
import json
import os
import unittest
from pathlib import Path

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
from PySide6.QtCore import QObject, Property, QUrl, QMetaObject, Qt, QEvent, QPoint
from PySide6.QtGui import QGuiApplication
from PySide6.QtQml import QQmlEngine, QQmlComponent
from PySide6.QtQuickControls2 import QQuickStyle
from PySide6.QtTest import QTest


class Palette(QObject):
    @Property(str, constant=True)
    def snapshot(self):
        return json.dumps({"settings": {"motion": False}, "colors": {
            "text": "#201a17", "primary": "#8c4b2b", "surface": "#fff8f5", "surface-high": "#f6e6de",
            "surface-low": "#fff1eb", "outline": "#88756b", "muted": "#786a62",
            "primary-container": "#ffdbca", "on-primary-container": "#351000"}})
    @Property("QVariantMap", constant=True)
    def palette(self): return json.loads(self.snapshot)["colors"]
    @Property(bool, constant=True)
    def motionEnabled(self): return json.loads(self.snapshot)["settings"]["motion"]


class ChoiceFieldTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if QGuiApplication.instance() is None:
            QQuickStyle.setStyle("Material")
        cls.app = QGuiApplication.instance() or QGuiApplication(["Choice field tests"])

    def setUp(self):
        self.engine = QQmlEngine()
        self.palette = Palette()
        self.engine.rootContext().setContextProperty("studio", self.palette)
        self.component = component = QQmlComponent(self.engine)
        component.setData(b'''
import QtQuick
import QtQuick.Controls
ApplicationWindow {
    width: 520; height: 480; visible: true
    property real fieldY: 220
    property real viewportHeight: 320
    property int selected: 0
    property string geometry: JSON.stringify({
        visible: choice.popup.visible, x: choice.popup.x, y: choice.popup.y,
        width: choice.popup.width, height: choice.popup.height,
        index: choice.currentIndex, contentY: choice.popup.contentItem.contentY,
        listHeight: choice.popup.availableHeight
    })
    function openMenu() { choice.revealChoices() }
    function closeMenu() { choice.popup.close() }
    Rectangle {
        id: viewport; x: 40; y: 60; width: 440; height: viewportHeight
        ChoiceField {
            id: choice; x: 12; y: fieldY; width: 416; viewportItem: viewport
            model: Array.from({length: 20}, (_, i) => "Font " + i)
            currentIndex: selected
        }
    }
}
''', QUrl.fromLocalFile(str(Path(__file__).parent / "qml" / "choice-test.qml")))
        self.assertFalse(component.isError(), str(component.errors()))
        self.window = component.create()
        self.assertIsNotNone(self.window, str(component.errors()))
        QTest.qWait(30)

    def tearDown(self):
        self.window.close()
        self.window.deleteLater()
        self.app.sendPostedEvents(None, QEvent.Type.DeferredDelete)
        self.engine.deleteLater()
        self.app.sendPostedEvents(None, QEvent.Type.DeferredDelete)

    def open_menu(self):
        QMetaObject.invokeMethod(self.window, "openMenu")
        QTest.qWait(50)
        geometry = json.loads(self.window.property("geometry"))
        self.assertTrue(geometry["visible"])
        self.assertEqual(geometry["x"], 52)
        self.assertEqual(geometry["width"], 416)
        self.assertGreaterEqual(geometry["y"], 66)
        self.assertLessEqual(geometry["y"] + geometry["height"],
                             60 + self.window.property("viewportHeight") - 6)
        return geometry

    def test_short_menu_stays_below_field_instead_of_covering_section_labels(self):
        self.window.setProperty("fieldY", 154)
        menu = self.open_menu()
        self.assertEqual(menu["y"], 60 + 154 + 48 + 6)
        self.assertEqual(menu["height"], 104)

    def test_near_bottom_opens_above_but_stays_inside_scroll_viewport(self):
        menu = self.open_menu()
        self.assertLess(menu["y"], 60 + 220)
        self.assertLessEqual(menu["y"] + menu["height"], 60 + 220 - 6)

    def test_last_font_remains_reachable_and_keyboard_selection_works(self):
        self.window.setProperty("fieldY", 154)
        self.window.setProperty("selected", 19)
        menu = self.open_menu()
        self.assertLessEqual(menu["contentY"], 19 * 44)
        self.assertGreaterEqual(menu["contentY"] + menu["listHeight"], 20 * 44)
        QTest.keyClick(self.window, Qt.Key.Key_Up)
        QTest.keyClick(self.window, Qt.Key.Key_Return)
        QTest.qWait(30)
        geometry = json.loads(self.window.property("geometry"))
        self.assertEqual(geometry["index"], 18)
        self.assertFalse(geometry["visible"])

    def test_smaller_viewport_repositions_an_open_menu_without_spilling(self):
        self.window.setProperty("fieldY", 100)
        self.open_menu()
        self.window.setProperty("viewportHeight", 210)
        QTest.qWait(30)
        menu = json.loads(self.window.property("geometry"))
        self.assertTrue(menu["visible"])
        self.assertGreaterEqual(menu["y"], 66)
        self.assertLessEqual(menu["y"] + menu["height"], 264)

    def test_clicking_outside_dismisses_overlay_menu(self):
        self.open_menu()
        QTest.mouseClick(self.window, Qt.MouseButton.LeftButton,
                         Qt.KeyboardModifier.NoModifier, QPoint(20, 20))
        QTest.qWait(30)
        self.assertFalse(json.loads(self.window.property("geometry"))["visible"])

    def test_menu_closes_when_its_settings_window_is_hidden(self):
        self.open_menu()
        self.window.setVisible(False)
        QTest.qWait(30)
        self.assertFalse(json.loads(self.window.property("geometry"))["visible"])


if __name__ == "__main__":
    unittest.main()
