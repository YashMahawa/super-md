"""Regression for the compact-window overflow menu, on an isolated Qt display."""
import os
import textwrap
import unittest
from pathlib import Path

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
from PySide6.QtCore import QEvent, QObject, QUrl, QPointF, QMetaObject
from PySide6.QtGui import QGuiApplication, QColor
from PySide6.QtQml import QQmlEngine, QQmlComponent
from PySide6.QtQuickControls2 import QQuickStyle
from PySide6.QtTest import QTest
from PySide6.QtSvg import QSvgRenderer
from test_choice_field import Palette

QML_DIR=Path(__file__).parent/"qml"
MAIN=QML_DIR/"Main.qml"

def compact_source():
    qml=MAIN.read_text()
    start=qml.index('                ActionButton {\n                    visible: window.width < 1060; glyph: "More"')
    end=qml.index('                ActionButton { text: window.width < 1060 ? "" : "Export";',start)
    return textwrap.dedent(qml[start:end]).rstrip()

class CompactMenuTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if QGuiApplication.instance() is None:QQuickStyle.setStyle("Material")
        cls.app=QGuiApplication.instance() or QGuiApplication(["Compact actions test"])

    def setUp(self):
        self.engine=QQmlEngine()
        self.palette=Palette()
        self.engine.rootContext().setContextProperty("studio",self.palette)
        self.component=QQmlComponent(self.engine)
        code='''
import QtQuick
import QtQuick.Controls
ApplicationWindow {
    id: window
    width: 840; height: 480; visible: true; color: "#b32c55"
    property int contextMenuCount: 0
    property int modalDialogCount: 0
    property int exportActions: 0
    function showExport(sharing) { exportActions++ }
    function openMenu() { noteActions.popup() }
    Item { x: window.width - 78; y: 64; width: 66; height: 54
        %s
        Hint { objectName: "compactTestHint"; requested: true; text: "96%%" }
    }
}
''' % compact_source()
        self.component.setData(code.encode(),QUrl.fromLocalFile(str(QML_DIR/"compact-actions-test.qml")))
        self.assertFalse(self.component.isError(),str(self.component.errors()))
        self.window=self.component.create()
        self.assertIsNotNone(self.window,str(self.component.errors()))
        QTest.qWait(80)
    def tearDown(self):
        self.window.close();self.window.deleteLater()
        self.app.sendPostedEvents(None,QEvent.Type.DeferredDelete)
        self.engine.deleteLater();self.app.sendPostedEvents(None,QEvent.Type.DeferredDelete)

    def test_compact_menu_has_opaque_surface_and_renders_icons(self):
        QTest.qWait(650)
        hint=self.window.findChild(QObject,"compactTestHint")
        self.assertIsNotNone(hint)
        self.assertTrue(hint.property("visible"),"The hint should appear before the menu")
        QMetaObject.invokeMethod(self.window,"openMenu")
        QTest.qWait(160)
        menu=self.window.findChild(QObject,"compactNoteActions")
        self.assertIsNotNone(menu)
        self.assertTrue(menu.property("visible"))
        self.assertEqual(self.window.property("contextMenuCount"),1)
        self.assertFalse(hint.property("visible"),"Overflow menus must hide tooltip bubbles")
        self.assertEqual(menu.property("implicitWidth"),250)
        backing=menu.property("background")
        upper=backing.mapToScene(QPointF(0,0))
        self.assertGreaterEqual(upper.x(),0)
        self.assertLessEqual(upper.x()+backing.width(),self.window.width()+1,"Compact menu must stay inside narrow windows")
        center=backing.mapToScene(QPointF(3,backing.height()/2))
        image=self.window.grabWindow()
        actual=image.pixelColor(round(center.x()),round(center.y()))
        self.assertEqual(actual,QColor(self.palette.palette["surface-low"]),
                         "Compact actions need an opaque, palette-matched background")
        for filename in ("Image.svg","Bug.svg","ShareNetwork.svg"):
            self.assertTrue(QSvgRenderer(str(QML_DIR.parent/"icons"/filename)).isValid(),filename)
        menu.close();QTest.qWait(40)
        self.assertEqual(self.window.property("contextMenuCount"),0)

if __name__=="__main__":unittest.main()
