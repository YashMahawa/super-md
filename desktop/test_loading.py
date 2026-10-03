"""The native loading treatment paints, morphs and honors reduced motion."""
import os
import unittest
from pathlib import Path
os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
from PySide6.QtCore import QUrl, QObject, QEvent
from PySide6.QtGui import QGuiApplication
from PySide6.QtQml import QQmlEngine, QQmlComponent
from PySide6.QtTest import QTest
from test_studio import QuietStudio

class LoadingTest(unittest.TestCase):
    def test_presented_shape_is_visible_and_reduced_motion_is_static(self):
        app=QGuiApplication.instance() or QGuiApplication(["Loading tests"])
        studio=QuietStudio(True);engine=QQmlEngine();engine.rootContext().setContextProperty("studio",studio)
        component=QQmlComponent(engine)
        component.setData(b'import QtQuick\nimport QtQuick.Controls\nApplicationWindow {width:160;height:120;visible:true;ExpressiveLoading {anchors.centerIn:parent;motion:false}}',QUrl.fromLocalFile(str(Path(__file__).parent/"qml/loading-test.qml")))
        self.assertFalse(component.isError(),str(component.errors()));window=component.create()
        try:
            QTest.qWait(30);indicator=window.findChild(QObject,"expressiveLoading")
            self.assertIsNotNone(indicator);self.assertEqual(indicator.property("phase"),0)
            image=indicator.grabToImage()
            for _ in range(50):
                if not image.image().isNull():break
                QTest.qWait(10)
            painted=image.image();self.assertFalse(painted.isNull())
            self.assertGreater(len({painted.pixelColor(x,y).rgba() for x in range(painted.width()) for y in range(painted.height())}),3,"The loading shape must actually paint")
            indicator.setProperty("phase",1.5);QTest.qWait(20)
            image2=indicator.grabToImage()
            for _ in range(50):
                if not image2.image().isNull():break
                QTest.qWait(10)
            self.assertNotEqual(painted,image2.image(),"Different loading phases must present different shapes")
            QTest.qWait(40);self.assertEqual(indicator.property("phase"),1.5)
            indicator.setProperty("running",False);self.assertFalse(indicator.property("visible"))
        finally:
            window.close();window.deleteLater();app.sendPostedEvents(None,QEvent.Type.DeferredDelete)
            engine.deleteLater();app.sendPostedEvents(None,QEvent.Type.DeferredDelete)
            studio.stop();studio.pool.shutdown(wait=True);studio.session.writes.shutdown(wait=True)
