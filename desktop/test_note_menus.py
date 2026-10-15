"""Real hover, tooltip and opaque-menu pixels over a contrasting underlay."""
import os
import unittest
from pathlib import Path
os.environ.setdefault("QT_QPA_PLATFORM","offscreen")
from PySide6.QtCore import QObject,QUrl,QPoint,QPointF,Qt,QEvent
from PySide6.QtGui import QGuiApplication,QColor
from PySide6.QtQml import QQmlEngine,QQmlComponent
from PySide6.QtTest import QTest
from test_choice_field import Palette

class NoteMenuTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):cls.app=QGuiApplication.instance() or QGuiApplication(["Menu paint tests"])
    def setUp(self):
        self.engine=QQmlEngine();self.palette=Palette()
        self.engine.rootContext().setContextProperty("studio",self.palette)
        self.component=QQmlComponent(self.engine)
        self.component.setData(b'''
import QtQuick
import QtQuick.Controls
ApplicationWindow {
    width:540;height:440;visible:true;color:"#b32c55"
    property int contextMenuCount:0
    RecentNotes {x:20;y:20;width:240;height:180;model:["/notes/A study note.md"];onPinRequested: {} }
}
''',QUrl.fromLocalFile(str(Path(__file__).parent/"qml/menu-paint-test.qml")))
        self.assertFalse(self.component.isError(),str(self.component.errors()))
        self.window=self.component.create();self.assertIsNotNone(self.window,str(self.component.errors()));QTest.qWait(50)
    def tearDown(self):
        self.window.close();self.window.deleteLater();self.app.sendPostedEvents(None,QEvent.Type.DeferredDelete)
        self.engine.deleteLater();self.app.sendPostedEvents(None,QEvent.Type.DeferredDelete)
    def test_recent_hover_paints_and_pin_menu_is_opaque_and_suppresses_path_hint(self):
        QTest.mouseMove(self.window,QPoint(400,350));QTest.qWait(30)
        before=self.window.grabWindow().pixelColor(220,40)
        QTest.mouseMove(self.window,QPoint(120,40));QTest.qWait(650)
        after=self.window.grabWindow().pixelColor(220,40)
        self.assertNotEqual(before,after,"Recent rows must have an actual painted hover state")
        self.assertEqual(after,QColor(self.palette.palette["surface-high"]))
        items=[self.window.contentItem()];entry=None
        while items:
            item=items.pop()
            if item.objectName()=="recentNoteEntry":entry=item;break
            items.extend(item.childItems())
        self.assertIsNotNone(entry)
        hints=[o for o in entry.findChildren(QObject) if o.metaObject().indexOfProperty("requested")>=0 and o.property("visible")]
        self.assertEqual(len(hints),1,"Only one file-path tooltip may be visible")
        QTest.mouseClick(self.window,Qt.RightButton,Qt.NoModifier,QPoint(120,40));QTest.qWait(150)
        menu=entry.findChild(QObject,"recentContextMenu")
        self.assertIsNotNone(menu);self.assertTrue(menu.property("visible"));self.assertEqual(self.window.property("contextMenuCount"),1)
        self.assertTrue(all(not hint.property("visible") for hint in hints),"A path hint must disappear while the context menu is open")
        content=menu.property("contentItem");p=content.mapToScene(QPointF(content.width()-14,content.height()/2))
        color=self.window.grabWindow().pixelColor(round(p.x()),round(p.y()))
        self.assertEqual(color,QColor(self.palette.palette["surface-low"]),"The menu must cover the contrasting page beneath it")
        QTest.mouseClick(self.window,Qt.LeftButton,Qt.NoModifier,QPoint(460,350));QTest.qWait(100)
        self.assertFalse(menu.property("visible"));self.assertEqual(self.window.property("contextMenuCount"),0)
