"""Capture real Qt portal requests on a private bus, never the user's desktop."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import unittest

MAIN = Path(__file__).parent / "qml/Main.qml"
FORMATS = ["pdf", "smd", "md", "smd"]
NAME = "Quiz 2 Ω literal%20"

class ExportPortalTest(unittest.TestCase):
    @unittest.skipUnless(sys.platform.startswith("linux") and shutil.which("dbus-run-session"), "Linux portal protocol")
    def test_repeated_exports_send_unencoded_names_and_correct_type_to_native_picker(self):
        environment = dict(os.environ, QT_QPA_PLATFORM="offscreen", QT_QUICK_BACKEND="software",
                           QT_QPA_PLATFORMTHEME="xdgdesktopportal", XDG_CURRENT_DESKTOP="")
        environment.pop("DISPLAY", None)
        environment.pop("WAYLAND_DISPLAY", None)
        result = subprocess.run(["dbus-run-session", "--", sys.executable, __file__, "--portal-server"],
                                env=environment, capture_output=True, text=True, timeout=25)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        payload = json.loads(next(line[7:] for line in result.stdout.splitlines() if line.startswith("RESULT:")))
        self.assertEqual(payload["names"], [NAME + "." + format for format in FORMATS])
        self.assertEqual(payload["exports"], [["/tmp/" + NAME + "." + format, format] for format in FORMATS])

def server():
    from PySide6.QtCore import QObject, Slot, Signal, Property, QCoreApplication, QProcess, QTimer, ClassInfo
    from PySide6.QtDBus import QDBusConnection, QDBusObjectPath
    app = QCoreApplication([])
    bus = QDBusConnection.sessionBus()
    names, requests = [], []

    @ClassInfo(**{"D-Bus Interface": "org.freedesktop.portal.Request"})
    class Request(QObject):
        Response = Signal("uint", "QVariantMap")

    @ClassInfo(**{"D-Bus Interface": "org.freedesktop.portal.FileChooser"})
    class Portal(QObject):
        @Property(int, constant=True)
        def version(self): return 4
        @Slot(str, str, "QVariantMap", result=QDBusObjectPath)
        def SaveFile(self, parent, title, options):
            from PySide6.QtCore import QUrl
            name = options["current_name"]
            names.append(name)
            path = "/org/freedesktop/portal/desktop/request/test/" + str(len(names))
            request = Request()
            requests.append(request)
            assert bus.registerObject(path, request, QDBusConnection.ExportAllSignals)
            url = QUrl.fromLocalFile("/tmp/" + name).toString(QUrl.FullyEncoded)
            QTimer.singleShot(50, lambda: request.Response.emit(0, {"uris": [url]}))
            return QDBusObjectPath(path)

    portal = Portal()
    assert bus.registerService("org.freedesktop.portal.Desktop")
    assert bus.registerObject("/org/freedesktop/portal/desktop", portal,
                              QDBusConnection.ExportAllSlots | QDBusConnection.ExportAllProperties)
    child = QProcess()
    child.setProcessChannelMode(QProcess.SeparateChannels)
    def finished(code, _status):
        output = bytes(child.readAllStandardOutput()).decode()
        error = bytes(child.readAllStandardError()).decode()
        if code == 0 and output.startswith("EXPORTS:"):
            print("RESULT:" + json.dumps({"names": names, "exports": json.loads(output[8:])}), flush=True)
        else:
            print(output + error, flush=True)
        app.exit(code)
    child.finished.connect(finished)
    child.start(sys.executable, [__file__, "--portal-client"])
    def timeout():
        child.kill()
        app.exit(2)
    QTimer.singleShot(18000, timeout)
    return app.exec()

def client():
    from PySide6.QtCore import QObject, Slot, QUrl, QTimer, QMetaObject
    from PySide6.QtWidgets import QApplication
    from PySide6.QtQml import QQmlEngine, QQmlComponent
    from PySide6.QtQuickControls2 import QQuickStyle
    QQuickStyle.setStyle("Material")
    app = QApplication([])
    exports = []
    class Backend(QObject):
        @Slot(str, result=QUrl)
        def defaultExportLocation(self, format):
            return QUrl.fromLocalFile("/tmp/" + NAME + "." + format)
        @Slot(str, str)
        def exportTo(self, url, format):
            exports.append([QUrl(url).toLocalFile(), format])
            QTimer.singleShot(50, next_export)
    engine = QQmlEngine()
    backend = Backend()
    engine.rootContext().setContextProperty("studio", backend)
    source = MAIN.read_text()
    factory = source[source.index("    function chooseExportDestination()"):source.index("    function hideExport()")]
    chooser = source[source.index("    Component {\n        id: exportDestinationComponent"):source.index("    AppDialog {\n        id: exportDialog")]
    component = QQmlComponent(engine)
    component.setData(('''import QtQuick
import QtQuick.Controls
import QtQuick.Dialogs
ApplicationWindow {id: window; width: 500; height: 400; visible: true
property string outputFormat: "pdf"
QtObject {id: exportDialog; function close() {}}
''' + factory + chooser + '}').encode(), QUrl.fromLocalFile(str(MAIN)))
    window = component.create()
    assert window is not None, str(component.errors())
    def next_export():
        if len(exports) == len(FORMATS):
            print("EXPORTS:" + json.dumps(exports), flush=True)
            app.quit()
            return
        window.setProperty("outputFormat", FORMATS[len(exports)])
        QMetaObject.invokeMethod(window, "chooseExportDestination")
    QTimer.singleShot(200, next_export)
    QTimer.singleShot(15000, lambda: app.exit(2))
    return app.exec()

if __name__ == "__main__":
    if "--portal-server" in sys.argv: sys.exit(server())
    if "--portal-client" in sys.argv: sys.exit(client())
    unittest.main()
