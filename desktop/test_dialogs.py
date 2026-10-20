"""Presented software-rendered pixels and real rename/popup lifecycle."""
import json
import os
import unittest
from pathlib import Path

os.environ.setdefault('QT_QPA_PLATFORM','offscreen')
from PySide6.QtCore import QObject, QUrl, QEvent, QPoint, QPointF, Qt
from PySide6.QtGui import QGuiApplication, QColor
from PySide6.QtQml import QQmlEngine, QQmlComponent
from PySide6.QtQuickControls2 import QQuickStyle
from PySide6.QtTest import QTest
from studio import Session
from test_studio import QuietStudio

class DialogTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if QGuiApplication.instance() is None:QQuickStyle.setStyle('Material')
        cls.app=QGuiApplication.instance() or QGuiApplication(['Dialog painting tests'])

    def setUp(self):
        self.session=Session(True);self.session.settings.update(theme='dark',accent='rose',motion=False,welcomed=True)
        self.studio=QuietStudio(True,self.session)
        self.studio.tabs=[self.studio._note('Study.md','# Keep this note',saved='# Keep this note')]
        self.studio.active=self.studio.tabs[0]['id']
        self.engine=QQmlEngine();self.engine.rootContext().setContextProperty('studio',self.studio)
        self.component=QQmlComponent(self.engine)
        self.component.setData(b'''
import QtQuick
import QtQuick.Controls
import QtQuick.Controls.Material
ApplicationWindow {
    id:host
    width:900;height:640;visible:true;color:"#263f48"
    property var viewState:JSON.parse(studio.snapshot)
    property int contextMenuCount:0
    property int modalDialogCount:0
    Material.theme:viewState.dark?Material.Dark:Material.Light
    Material.primary:viewState.colors.primary
    Material.accent:viewState.colors.primary
    Material.background:viewState.colors.surface
    Material.foreground:viewState.colors.text
    TabStrip {width:parent.width;viewState:host.viewState}
}
''',QUrl.fromLocalFile(str(Path(__file__).parent/'qml/dialog-test.qml')))
        self.assertFalse(self.component.isError(),str(self.component.errors()))
        self.window=self.component.create();self.assertIsNotNone(self.window,str(self.component.errors()));QTest.qWait(50)

    def tearDown(self):
        self.window.close();self.window.deleteLater();self.app.sendPostedEvents(None,QEvent.Type.DeferredDelete)
        self.engine.deleteLater();self.app.sendPostedEvents(None,QEvent.Type.DeferredDelete)
        self.studio.stop();self.studio.pool.shutdown(wait=True);self.session.writes.shutdown(wait=True)

    def items(self,item=None):
        item=item or self.window.contentItem()
        yield item
        for child in item.childItems():yield from self.items(child)

    def named(self,name):
        found=self.window.findChild(QObject,name)
        if found is not None:return found
        for item in self.items():
            if item.objectName()==name:return item
            found=item.findChild(QObject,name)
            if found is not None:return found
        return None

    def open_rename(self):
        tab=next(item for item in self.items() if item.objectName()=='noteTab')
        QTest.mouseClick(self.window,Qt.RightButton,Qt.NoModifier,tab.mapToScene(QPointF(70,20)).toPoint());QTest.qWait(40)
        action=next(item for item in self.items() if item.property('text')=='Rename note')
        QTest.mouseClick(self.window,Qt.LeftButton,Qt.NoModifier,action.mapToScene(QPointF(60,action.height()/2)).toPoint());QTest.qWait(300)
        if os.environ.get('SUPERMD_DIALOG_TEST_OUTPUT'):self.window.grabWindow().save(os.environ['SUPERMD_DIALOG_TEST_OUTPUT'])
        dialog=self.named('renameDialog');self.assertIsNotNone(dialog);self.assertTrue(dialog.property('visible'))
        return dialog

    def pixel(self,image,point):
        scale=image.width()/self.window.width()
        return image.pixelColor(round(point.x()*scale),round(point.y()*scale))

    def test_modal_scrim_darkens_instead_of_washing_out_the_page(self):
        point=QPointF(20,600);before=self.pixel(self.window.grabWindow(),point)
        self.open_rename();after=self.pixel(self.window.grabWindow(),point)
        for old,new in zip(before.getRgb()[:3],after.getRgb()[:3]):self.assertLessEqual(new,old*.75+3,'Modal dimming must darken every channel, never add a white veil')

    def test_rename_body_is_one_opaque_surface_in_software_rendering(self):
        dialog=self.open_rename();background=dialog.property('background');image=self.window.grabWindow()
        if os.environ.get('SUPERMD_DIALOG_TEST_OUTPUT'):image.save(os.environ['SUPERMD_DIALOG_TEST_OUTPUT'])
        point=background.mapToScene(QPointF(8,background.height()/2))
        self.assertEqual(self.pixel(image,point).name(),QColor(self.studio.palette['surface-low']).name(),'The middle of the dialog must paint, not reveal the dimmed document')

    def test_rename_draft_survives_snapshot_refresh(self):
        self.open_rename();field=self.named('renameField');field.setProperty('text','My pending name.md')
        self.studio._emit(False);QTest.qWait(60)
        dialog=self.named('renameDialog');self.assertIsNotNone(dialog);self.assertTrue(dialog.property('visible'),'An unrelated snapshot must not destroy an open rename dialog')
        self.assertEqual(self.named('renameField').property('text'),'My pending name.md')

    def test_accept_renames_the_intended_note_and_escape_cancels(self):
        self.open_rename();self.assertEqual(self.window.property('modalDialogCount'),1)
        self.named('renameField').setProperty('text','Renamed.md')
        QTest.keyClick(self.window,Qt.Key_Return);QTest.qWait(80)
        self.assertEqual(self.studio.tabs[0]['name'],'Renamed.md')
        self.assertFalse(self.named('renameDialog').property('visible'));self.assertEqual(self.window.property('modalDialogCount'),0)
        self.open_rename();self.named('renameField').setProperty('text','Not committed.md')
        QTest.keyClick(self.window,Qt.Key_Escape);QTest.qWait(80)
        self.assertEqual(self.studio.tabs[0]['name'],'Renamed.md');self.assertEqual(self.window.property('modalDialogCount'),0)

    def test_light_dark_and_black_palettes_keep_surface_opaque(self):
        dialog=self.open_rename()
        for mode in ('light','dark','black'):
            self.studio.setting('theme',json.dumps(mode));QTest.qWait(50)
            background=dialog.property('background');image=self.window.grabWindow()
            self.assertEqual(self.pixel(image,background.mapToScene(QPointF(8,background.height()/2))).name(),QColor(self.studio.palette['surface-low']).name())

    def test_imported_theme_is_used_by_the_whole_dialog(self):
        self.session.custom_theme={'accent':'violet','variants':{'dark':{'colors':{'surface':'#241f33','surface-low':'#342c44','primary':'#e8b4d0'}}}}
        self.session.theme_revision+=1
        self.studio._emit(False)
        dialog=self.open_rename();background=dialog.property('background');image=self.window.grabWindow()
        self.assertEqual(self.studio.palette['surface-low'],'#342c44')
        self.assertEqual(self.pixel(image,background.mapToScene(QPointF(8,background.height()/2))).name(),'#342c44')

if __name__=='__main__':unittest.main()
