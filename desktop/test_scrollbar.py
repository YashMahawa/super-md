"""Use real Qt controls to verify idle/scroll/hover visibility and stable gutters."""
import os
import unittest
from pathlib import Path
os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
from PySide6.QtCore import QUrl, QEvent, QPoint
from PySide6.QtGui import QGuiApplication
from PySide6.QtQml import QQmlEngine, QQmlComponent
from PySide6.QtTest import QTest
from test_choice_field import Palette

class ScrollBarTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.app = QGuiApplication.instance() or QGuiApplication(["Scroll indicator tests"])

    def setUp(self):
        self.engine = QQmlEngine()
        self.palette = Palette()
        self.engine.rootContext().setContextProperty("studio", self.palette)
        self.component = QQmlComponent(self.engine)
        self.component.setData(b'''
import QtQuick
import QtQuick.Controls
ApplicationWindow {
    width: 320; height: 320; visible: true
    property bool scrolling: false
    readonly property real indicatorOpacity: indicator.opacity
    readonly property real gutterWidth: indicator.width
    readonly property bool overGutter: indicator.hovered
    ExpressiveScrollBar {
        id: indicator; x: 304; width: 16; height: 320
        orientation: Qt.Vertical; size: .25; position: .25
        active: scrolling
    }
}
''', QUrl.fromLocalFile(str(Path(__file__).parent / "qml/scroll-test.qml")))
        self.assertFalse(self.component.isError(), str(self.component.errors()))
        self.window = self.component.create()
        self.assertIsNotNone(self.window)
        QTest.qWait(30)
        QTest.mouseMove(self.window, QPoint(100, 100))
        QTest.qWait(30)

    def tearDown(self):
        self.window.close(); self.window.deleteLater()
        self.app.sendPostedEvents(None, QEvent.Type.DeferredDelete)
        self.engine.deleteLater()
        self.app.sendPostedEvents(None, QEvent.Type.DeferredDelete)

    def test_scroll_indicator_hides_when_idle_without_collapsing_gutter(self):
        width = self.window.property("gutterWidth")
        self.assertEqual(self.window.property("indicatorOpacity"), 0)
        self.window.setProperty("scrolling", True); QTest.qWait(30)
        self.assertEqual(self.window.property("indicatorOpacity"), 1)
        self.window.setProperty("scrolling", False); QTest.qWait(30)
        self.assertEqual(self.window.property("indicatorOpacity"), 0)
        self.assertEqual(self.window.property("gutterWidth"), width)

    def test_hovering_the_gutter_reveals_the_hidden_scrollbar(self):
        QTest.mouseMove(self.window, QPoint(312, 120)); QTest.qWait(30)
        self.assertTrue(self.window.property("overGutter"))
        self.assertEqual(self.window.property("indicatorOpacity"), 1)
        QTest.mouseMove(self.window, QPoint(100, 100)); QTest.qWait(30)
        self.assertFalse(self.window.property("overGutter"))
        self.assertEqual(self.window.property("indicatorOpacity"), 0)
