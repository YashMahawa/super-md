import os
import unittest
from pathlib import Path
os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
from PySide6.QtCore import QUrl, QEvent, QObject
from PySide6.QtGui import QGuiApplication
from PySide6.QtQml import QQmlEngine, QQmlComponent
from PySide6.QtTest import QTest
from test_studio import QuietStudio

class SidebarToggleTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):cls.app=QGuiApplication.instance() or QGuiApplication(["Sidebar motion tests"])
    def test_icon_morphs_and_respects_motion_preference(self):
        studio=QuietStudio(True);engine=QQmlEngine();engine.rootContext().setContextProperty("studio",studio)
        component=QQmlComponent(engine);component.setData(b'''import QtQuick
import QtQuick.Controls
ApplicationWindow { width: 240; height: 120; visible: true
 SidebarToggle { id: toggle; anchors.centerIn: parent; onClicked: expanded=!expanded }
}''',QUrl.fromLocalFile(str(Path(__file__).parent/"qml/sidebar-test.qml")))
        self.assertFalse(component.isError(),str(component.errors()));window=component.create();self.assertIsNotNone(window)
        try:
            QTest.qWait(30);button=window.findChild(QObject,"sidebarToggle")
            self.assertIsNotNone(button);button.clicked.emit();QTest.qWait(55)
            self.assertGreater(button.property("expansion"),0);self.assertLess(button.property("expansion"),1)
            QTest.qWait(220);self.assertEqual(button.property("expansion"),0)
            studio.settings["motion"]=False;studio._emit(False);button.clicked.emit();QTest.qWait(20)
            self.assertEqual(button.property("expansion"),1)
        finally:
            window.close();window.deleteLater();self.app.sendPostedEvents(None,QEvent.Type.DeferredDelete)
            engine.deleteLater();self.app.sendPostedEvents(None,QEvent.Type.DeferredDelete)
            studio.stop();studio.pool.shutdown(wait=True);studio.session.writes.shutdown(wait=True)
