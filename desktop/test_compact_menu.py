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
    start=qml.index('                ActionButton {\n                    objectName: "moreActionsButton"; glyph: "More"')
    end=qml.index('                ActionButton { text: window.width < 1060 ? "" : "Export";',start)
    return textwrap.dedent(qml[start:end]).rstrip()

class CompactMenuPalette(Palette):
    def __init__(self):
        super().__init__()
        self.reopened=0
        self.saved_as=0

    from PySide6.QtCore import Slot

    @Slot()
    def reopenTab(self):
        self.reopened+=1

    @Slot()
    def saveAsSafely(self):
        self.saved_as+=1

class CompactMenuTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if QGuiApplication.instance() is None:QQuickStyle.setStyle("Material")
        cls.app=QGuiApplication.instance() or QGuiApplication(["Compact actions test"])

    def setUp(self):
        self.engine=QQmlEngine()
        self.palette=CompactMenuPalette()
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
        for filename in ("Undo.svg","FloppyDisk.svg","Image.svg","Bug.svg","ShareNetwork.svg"):
            self.assertTrue(QSvgRenderer(str(QML_DIR.parent/"icons"/filename)).isValid(),filename)
        menu.close();QTest.qWait(40)
        self.assertEqual(self.window.property("contextMenuCount"),0)

    def test_overflow_menu_is_visible_above_and_below_1060_with_reopen_and_save_as(self):
        button=self.window.findChild(QObject,"moreActionsButton")
        reopen=self.window.findChild(QObject,"reopenClosedTabAction")
        save_as=self.window.findChild(QObject,"saveAsAction")
        self.assertIsNotNone(button)
        self.assertIsNotNone(reopen)
        self.assertIsNotNone(save_as)
        from PySide6.QtCore import Qt
        for width in (840, 1280):
            self.window.setProperty("width", width)
            QTest.qWait(40)
            self.assertTrue(button.property("visible"), f"More button must stay visible at width={width}")
            QTest.mouseClick(self.window, Qt.MouseButton.LeftButton, Qt.KeyboardModifier.NoModifier, button.mapToScene(QPointF(button.width()/2, button.height()/2)).toPoint())
            QTest.qWait(80)
            self.assertTrue(reopen.property("visible"), f"Reopen closed tab must be visible at width={width}")
            self.assertEqual(reopen.property("text"), "Reopen closed tab")
            self.assertTrue(save_as.property("visible"), f"Save as must be visible at width={width}")
            self.assertEqual(save_as.property("text"), "Save as")
            QTest.mouseClick(self.window, Qt.MouseButton.LeftButton, Qt.KeyboardModifier.NoModifier, reopen.mapToScene(QPointF(60, reopen.height()/2)).toPoint())
            QTest.qWait(40)
            QTest.mouseClick(self.window, Qt.MouseButton.LeftButton, Qt.KeyboardModifier.NoModifier, button.mapToScene(QPointF(button.width()/2, button.height()/2)).toPoint())
            QTest.qWait(80)
            QTest.mouseClick(self.window, Qt.MouseButton.LeftButton, Qt.KeyboardModifier.NoModifier, save_as.mapToScene(QPointF(60, save_as.height()/2)).toPoint())
            QTest.qWait(40)
        self.assertEqual(self.palette.reopened, 2)
        self.assertEqual(self.palette.saved_as, 2)

    def test_overflow_menu_items_display_shortcut_hints_when_configured(self):
        engine = QQmlEngine()
        palette = CompactMenuPalette()
        engine.rootContext().setContextProperty("studio", palette)
        component = QQmlComponent(engine)
        code = '''
import QtQuick
import QtQuick.Controls
ApplicationWindow {
    id: window
    width: 840; height: 480; visible: true
    property int contextMenuCount: 0
    property int modalDialogCount: 0
    property var shortcutLabels: ({
        reopen_tab: "Ctrl+Shift+T",
        save_as: "Disabled",
        search_folder: "Ctrl+Shift+F"
    })
    function showExport(sharing) {}
    function openMenu() { noteActions.popup() }
    Item { x: window.width - 78; y: 64; width: 66; height: 54
        %s
    }
}
''' % compact_source()
        component.setData(code.encode(), QUrl.fromLocalFile(str(QML_DIR / "compact-shortcuts-test.qml")))
        self.assertFalse(component.isError(), str(component.errors()))
        win = component.create()
        self.assertIsNotNone(win)
        try:
            QTest.qWait(40)
            QMetaObject.invokeMethod(win, "openMenu")
            QTest.qWait(80)
            reopen = win.findChild(QObject, "reopenClosedTabAction")
            save_as = win.findChild(QObject, "saveAsAction")
            search = win.findChild(QObject, "compactSearchFolderAction")
            self.assertEqual(reopen.property("text"), "Reopen closed tab")
            self.assertTrue(reopen.property("hasShortcutHint"))
            self.assertEqual(reopen.findChild(QObject, "menuShortcutHint").property("text"), "Ctrl+Shift+T")
            self.assertFalse(save_as.property("hasShortcutHint"), "Disabled shortcuts must not render 'Disabled' in menus")
            self.assertTrue(search.property("hasShortcutHint"))
            self.assertEqual(search.findChild(QObject, "menuShortcutHint").property("text"), "Ctrl+Shift+F")
        finally:
            win.close(); win.deleteLater()
            self.app.sendPostedEvents(None, QEvent.Type.DeferredDelete)
            engine.deleteLater(); self.app.sendPostedEvents(None, QEvent.Type.DeferredDelete)

if __name__=="__main__":unittest.main()
