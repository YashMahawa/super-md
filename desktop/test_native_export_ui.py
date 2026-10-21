"""Execute the production chooser factory, not a parallel filename helper."""
import os
import unittest
from pathlib import Path
os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
from PySide6.QtCore import QObject, Slot, QUrl, QMetaObject, QEvent
from PySide6.QtGui import QGuiApplication
from PySide6.QtQml import QQmlEngine, QQmlComponent
from PySide6.QtTest import QTest

MAIN = Path(__file__).parent / "qml/Main.qml"

class ExportBackend(QObject):
    def __init__(self):
        super().__init__()
        self.exports = []
    @Slot(str, result=QUrl)
    def defaultExportLocation(self, format):
        return QUrl.fromLocalFile("/tmp/Quiz 2 Ω literal%20." + format)
    @Slot(str, str)
    def exportTo(self, url, format):
        self.exports.append((QUrl(url).toLocalFile(), format))

class NativeExportUiTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.app = QGuiApplication.instance() or QGuiApplication(["Export chooser tests"])
    def setUp(self):
        source = MAIN.read_text()
        factory = source[source.index("    function chooseExportDestination()"):source.index("    function hideExport()")]
        chooser = source[source.index("    Component {\n        id: exportDestinationComponent"):source.index("    AppDialog {\n        id: exportDialog")]
        self.backend = ExportBackend()
        self.engine = QQmlEngine()
        self.engine.rootContext().setContextProperty("studio", self.backend)
        self.component = component = QQmlComponent(self.engine)
        component.setData(('''import QtQuick
import QtQuick.Controls
import QtQuick.Dialogs
ApplicationWindow {
id: window; width: 600; height: 400; visible: true
property string outputFormat: "pdf"
QtObject {id: exportDialog; function close() {}}
''' + factory + chooser + '}').encode(), QUrl.fromLocalFile(str(MAIN)))
        self.window = component.create()
        self.assertIsNotNone(self.window, str(component.errors()))
    def tearDown(self):
        self.window.close()
        self.window.deleteLater()
        self.app.sendPostedEvents(None, QEvent.DeferredDelete)
        self.engine.deleteLater()
        self.app.sendPostedEvents(None, QEvent.DeferredDelete)
    def test_each_export_gets_fresh_chooser_and_captured_format(self):
        for format in ("pdf", "smd", "md", "smd", "pdf"):
            self.window.setProperty("outputFormat", format)
            self.assertTrue(QMetaObject.invokeMethod(self.window, "chooseExportDestination"))
            QTest.qWait(30)
            chooser = self.window.findChild(QObject, "exportDestination")
            self.assertIsNotNone(chooser)
            self.assertEqual(chooser.property("defaultSuffix"), format)
            self.assertIn("*." + format, chooser.property("nameFilters")[0])
            self.assertEqual(chooser.property("selectedFile").toLocalFile(), "/tmp/Quiz 2 Ω literal%20." + format)
            # Options changing/closing must not change an outstanding chooser.
            self.window.setProperty("outputFormat", "pdf" if format != "pdf" else "smd")
            QMetaObject.invokeMethod(chooser, "accepted")
            self.app.sendPostedEvents(None, QEvent.DeferredDelete)
            self.assertEqual(self.backend.exports[-1], ("/tmp/Quiz 2 Ω literal%20." + format, format))
            self.assertIsNone(self.window.findChild(QObject, "exportDestination"))
    def test_requested_portable_format_is_not_reset_when_options_finish_opening(self):
        source = MAIN.read_text()
        export = source[source.index("    AppDialog {\n        id: exportDialog"):source.index("    AppDialog {\n        id: closeDialog")]
        opened = export[export.index("        onOpened:"):]
        self.assertNotIn('outputFormat = "pdf"', opened)

if __name__ == "__main__":
    unittest.main()
