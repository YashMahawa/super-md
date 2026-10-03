"""Real QML controls preserve native window states and safe-close ownership."""
import os
import unittest
from pathlib import Path
os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
from PySide6.QtCore import QUrl, QEvent, Qt
from PySide6.QtGui import QGuiApplication
from PySide6.QtQml import QQmlEngine, QQmlComponent
from PySide6.QtTest import QTest
from test_studio import QuietStudio

class WindowControlsTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls): cls.app=QGuiApplication.instance() or QGuiApplication(["Caption tests"])
    def test_controls_minimize_restore_and_request_safe_close(self):
        studio=QuietStudio(True)
        engine=QQmlEngine();engine.rootContext().setContextProperty("studio",studio)
        component=QQmlComponent(engine)
        component.setData(b'''import QtQuick
import QtQuick.Controls
ApplicationWindow {
 id: host; width: 700; height: 300; visible: true
 property int closeRequests: 0
 WindowControls { host: host; colors: JSON.parse(studio.snapshot).colors; onCloseRequested: host.closeRequests++ }
}''',QUrl.fromLocalFile(str(Path(__file__).parent/"qml/caption-test.qml")))
        self.assertFalse(component.isError(),str(component.errors()));window=component.create();self.assertIsNotNone(window)
        QTest.qWait(30)
        def click(name):
            stack=[window.contentItem()]
            while stack:
                item=stack.pop()
                if item.objectName()=="windowControl_"+name:
                    self.assertGreaterEqual(item.height()-item.property("topPadding")-item.property("bottomPadding"),24)
                    self.assertGreaterEqual(item.width(),40)
                    result=item.grabToImage()
                    for _ in range(40):
                        if not result.image().isNull():break
                        QTest.qWait(10)
                    image=result.image()
                    self.assertFalse(image.isNull())
                    self.assertGreater(len({image.pixelColor(x,y).rgba() for x in range(image.width()) for y in range(image.height())}),3,"Caption glyph must really paint, not just reserve space")
                    item.clicked.emit();QTest.qWait(30);return
                stack.extend(item.childItems())
            self.fail("Missing window control "+name)
        try:
            self.assertFalse(window.flags() & Qt.WindowType.FramelessWindowHint)
            click("maximize");self.assertEqual(window.visibility(),window.Visibility.Maximized)
            click("maximize");self.assertEqual(window.visibility(),window.Visibility.Windowed)
            click("minimize");self.assertEqual(window.visibility(),window.Visibility.Minimized)
            window.showNormal();QTest.qWait(30)
            click("close");self.assertEqual(window.property("closeRequests"),1);self.assertTrue(window.isVisible())
        finally:
            window.close();window.deleteLater();self.app.sendPostedEvents(None,QEvent.Type.DeferredDelete)
            engine.deleteLater();self.app.sendPostedEvents(None,QEvent.Type.DeferredDelete)
            studio.stop();studio.pool.shutdown(wait=True);studio.session.writes.shutdown(wait=True)
