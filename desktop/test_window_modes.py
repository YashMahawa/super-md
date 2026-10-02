"""Use actual Qt windows to verify fullscreen does not lose maximized state."""
import os
import time
import unittest
from pathlib import Path

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
from PySide6.QtCore import QUrl, QMetaObject, Q_ARG, QEvent, Qt
from PySide6.QtGui import QGuiApplication
from PySide6.QtQml import QQmlEngine, QQmlComponent
from PySide6.QtTest import QTest


class WindowModesTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.app = QGuiApplication.instance() or QGuiApplication(["Window mode tests"])

    def setUp(self):
        self.engine = QQmlEngine()
        self.component = QQmlComponent(self.engine)
        self.component.setData(b'''
import QtQuick
import QtQuick.Controls
ApplicationWindow {
    id: testWindow
    width: 900; height: 600; visible: true
    property int remembered: modes.restoreVisibility
    property bool studying: modes.fullscreen
    function study(enabled) { modes.setFullscreen(enabled) }
    WindowModes { id: modes; host: testWindow }
    Shortcut { sequence: "F11"; onActivated: modes.setFullscreen(!modes.fullscreen) }
    Shortcut { sequence: "Escape"; enabled: modes.fullscreen; onActivated: modes.setFullscreen(false) }
}
''', QUrl.fromLocalFile(str(Path(__file__).parent / "qml/window-mode-test.qml")))
        self.assertFalse(self.component.isError(), str(self.component.errors()))
        self.window = self.component.create()
        self.assertIsNotNone(self.window, str(self.component.errors()))
        self.window.showNormal()
        QTest.qWait(30)

    def tearDown(self):
        self.window.close()
        self.window.deleteLater()
        self.app.sendPostedEvents(None, QEvent.Type.DeferredDelete)
        self.engine.deleteLater()
        self.app.sendPostedEvents(None, QEvent.Type.DeferredDelete)

    def study(self, enabled):
        self.assertTrue(QMetaObject.invokeMethod(self.window, "study", Q_ARG("QVariant", enabled)))
        QTest.qWait(30)
        self.assertEqual(self.window.property("studying"), enabled)

    def expect_visibility(self, expected):
        # Native window-state notifications can arrive after fullscreenChanged.
        deadline = time.monotonic() + 1
        while self.window.visibility() != expected and time.monotonic() < deadline:
            QTest.qWait(10)
        self.assertEqual(self.window.visibility(), expected)

    def test_normal_window_restores_normal_after_fullscreen(self):
        self.expect_visibility(self.window.Visibility.Windowed)
        self.study(True)
        self.study(False)
        self.expect_visibility(self.window.Visibility.Windowed)

    def test_maximized_window_restores_maximized_after_fullscreen(self):
        self.window.showMaximized()
        QTest.qWait(30)
        self.study(True)
        self.study(True)  # repeated entry must not overwrite the remembered state
        self.study(False)
        self.expect_visibility(self.window.Visibility.Maximized)

    def test_external_fullscreen_is_reflected(self):
        self.window.showFullScreen()
        QTest.qWait(30)
        self.assertTrue(self.window.property("studying"))
        self.window.showNormal()
        QTest.qWait(30)
        self.assertFalse(self.window.property("studying"))

    def test_keyboard_fullscreen_and_escape(self):
        self.window.requestActivate()
        QTest.qWait(50)
        QTest.keyClick(self.window, Qt.Key.Key_F11)
        QTest.qWait(50)
        self.assertTrue(self.window.property("studying"))
        QTest.keyClick(self.window, Qt.Key.Key_Escape)
        QTest.qWait(50)
        self.assertFalse(self.window.property("studying"))
        self.expect_visibility(self.window.Visibility.Windowed)
