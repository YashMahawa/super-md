"""Production export options at laptop and large-monitor sizes, without a real screen."""
import os
import time
import unittest
from pathlib import Path
os.environ.setdefault('QT_QPA_PLATFORM','offscreen')
from PySide6.QtCore import QObject,QUrl,QEvent,QMetaObject
from PySide6.QtGui import QGuiApplication
from PySide6.QtQml import QQmlEngine,QQmlComponent
from PySide6.QtQuickControls2 import QQuickStyle
from PySide6.QtTest import QTest
from test_studio import QuietStudio


class ResponsiveExportTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if QGuiApplication.instance() is None:QQuickStyle.setStyle('Material')
        cls.app=QGuiApplication.instance() or QGuiApplication(['Responsive export tests'])

    def test_production_dialog_resizes_and_uses_real_control_fonts(self):
        self.studio=QuietStudio(True)
        engine=QQmlEngine();engine.rootContext().setContextProperty('studio',self.studio)
        path=Path(__file__).parent/'qml/Main.qml';text=path.read_text()
        block=text[text.index('    AppDialog {\n        id: exportDialog'):text.index('    AppDialog {\n        id: closeDialog')]
        source='''import QtQuick
import QtQuick.Controls
import QtQuick.Controls.Material
import QtQuick.Layouts
ApplicationWindow {
id: window; width:900; height:640; visible:true
property var viewState:JSON.parse(studio.snapshot)
property bool sharing:false
property string outputFormat:"pdf"
property int modalDialogCount:0
property bool exportOpen:true
function chooseExportDestination() {}
'''+block+'Component.onCompleted:exportDialog.open()\n}'
        component=QQmlComponent(engine);component.setData(source.encode(),QUrl.fromLocalFile(str(path)))
        window=component.create()
        try:
            self.assertIsNotNone(window,str(component.errors()));QTest.qWait(80)
            dialog=window.findChild(QObject,'exportDialog');controls=window.findChild(QObject,'exportPdfControls')
            self.assertTrue(dialog.property('visible'))
            self.assertEqual(dialog.property('width'),500)
            small_font=controls.property('controlFont').pixelSize()
            small_height=dialog.property('height')
            window.setWidth(2560);window.setHeight(1440);QTest.qWait(100)
            self.assertEqual(dialog.property('width'),720)
            self.assertGreater(dialog.property('height'),small_height)
            self.assertLessEqual(dialog.property('height'),window.height()-64)
            font=controls.property('controlFont');self.assertEqual(font.pixelSize(),small_font)
            self.assertEqual(font.pixelSize(),14)
            choice=controls.findChild(QObject,'pdfFontChoice')
            self.assertEqual(choice.property('font').pixelSize(),14)
            self.assertGreaterEqual(choice.property('height'),48)
            self.assertEqual(choice.property('scale'),1,'Bigger export controls must not be raster-stretched')
            if os.environ.get('SUPERMD_EXPORT_TEST_OUTPUT'):window.grabWindow().save(os.environ['SUPERMD_EXPORT_TEST_OUTPUT'])
            window.setWidth(660);window.setHeight(480);QTest.qWait(60)
            self.assertLessEqual(dialog.property('width'),window.width()-48)
            self.assertLessEqual(dialog.property('height'),window.height()-64)
            self.assertEqual(controls.property('controlFont').pixelSize(),14)
            QMetaObject.invokeMethod(dialog,'close')
            deadline=time.monotonic()+2
            while dialog.property('visible') and time.monotonic()<deadline:QTest.qWait(20)
            self.assertFalse(dialog.property('visible'))
        finally:
            if window:window.close();window.deleteLater()
            self.app.sendPostedEvents(None,QEvent.DeferredDelete);engine.deleteLater();self.app.sendPostedEvents(None,QEvent.DeferredDelete)
            self.studio.stop();self.studio.pool.shutdown(wait=True);self.studio.session.writes.shutdown(wait=True)

if __name__=='__main__':unittest.main()
