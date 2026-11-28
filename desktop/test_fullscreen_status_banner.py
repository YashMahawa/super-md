"""Desktop fullscreen status banner and Studio messageRevision coverage."""
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
os.environ.setdefault("QT_QUICK_BACKEND", "software")

from PySide6.QtCore import QEvent, QObject, Property, QUrl
from PySide6.QtGui import QGuiApplication
from PySide6.QtQml import QQmlComponent, QQmlEngine
from PySide6.QtQuick import QQuickItem
from PySide6.QtQuickControls2 import QQuickStyle
from PySide6.QtTest import QTest

ROOT = Path(__file__).resolve().parent
import sys
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))


class PaletteStub(QObject):
    @Property("QVariantMap", constant=True)
    def palette(self):
        return {
            "text": "#201a17",
            "muted": "#69564c",
            "primary": "#8c4b2b",
            "on-primary": "#ffffff",
            "surface": "#fff8f5",
            "surface-low": "#f8d7c5",
            "surface-high": "#eac1ac",
            "outline": "#88756b",
            "primary-container": "#e9cab8",
        }

    @Property(bool, constant=True)
    def motionEnabled(self):
        return False


class FullscreenStatusBannerTest(unittest.TestCase):
    def test_studio_snapshot_increments_message_revision_even_for_repeated_messages(self):
        _app = QGuiApplication.instance() or QGuiApplication(["studio message revision"])
        from studio import Studio

        with tempfile.TemporaryDirectory() as home:
            with patch.dict(os.environ, {"HOME": home, "XDG_CONFIG_HOME": home, "XDG_DATA_HOME": home}):
                studio = Studio(isolated=True)
                try:
                    initial = json.loads(studio.snapshot)
                    self.assertEqual(initial["message"], "")
                    self.assertEqual(initial["messageRevision"], 0)

                    with patch("studio.QDesktopServices.openUrl", return_value=True):
                        studio.selectionAction("assistant", "Theorem: $|x| \\ge 0$")
                    first = json.loads(studio.snapshot)
                    self.assertIn("Selected text copied", first["message"])
                    self.assertEqual(first["messageRevision"], 1)

                    # Repeating the exact same Ask action increments messageRevision again
                    with patch("studio.QDesktopServices.openUrl", return_value=True):
                        studio.selectionAction("assistant", "Theorem: $|x| \\ge 0$")
                    second = json.loads(studio.snapshot)
                    self.assertEqual(second["message"], first["message"])
                    self.assertEqual(second["messageRevision"], 2)

                    # Clearing message does not advance revision; subsequent error advances it
                    studio.message = ""
                    cleared = json.loads(studio.snapshot)
                    self.assertEqual(cleared["message"], "")
                    self.assertEqual(cleared["messageRevision"], 2)

                    studio.selectionAction("assistant", "x" * 1_000_001)
                    errored = json.loads(studio.snapshot)
                    self.assertEqual(errored["message"], "Select a smaller excerpt.")
                    self.assertEqual(errored["messageRevision"], 3)
                finally:
                    studio.stop()
                    studio.pool.shutdown(wait=True)

    def test_banner_displays_transient_messages_and_busy_state_only_while_footer_hidden(self):
        QQuickStyle.setStyle("Material")
        app = QGuiApplication.instance() or QGuiApplication(["fullscreen banner qml"])
        engine = QQmlEngine()
        palette = PaletteStub()
        engine.rootContext().setContextProperty("studio", palette)
        qml_dir = ROOT / "qml"
        engine.addImportPath(str(qml_dir))

        component = QQmlComponent(engine)
        source = b"""\
import QtQuick
import QtQuick.Controls

ApplicationWindow {
    id: win
    width: 720
    height: 420
    visible: true
    color: "#fff8f5"
    FullscreenStatusBanner {
        id: banner
        objectName: "fullscreenStatusBanner"
        anchors.horizontalCenter: parent.horizontalCenter
        anchors.bottom: parent.bottom
        anchors.bottomMargin: 20
        maxWidth: Math.min(680, parent.width - 48)
        dismissInterval: 140
        footerHidden: false
        busy: false
        message: "Saved"
        messageRevision: 1
    }
}
"""
        component.setData(source, QUrl.fromLocalFile(str(qml_dir / "fullscreen-banner-test.qml")))
        self.assertFalse(component.isError(), str(component.errors()))
        window = component.create()
        self.assertIsNotNone(window)
        try:
            QTest.qWait(30)
            banner = window.findChild(QQuickItem, "fullscreenStatusBanner")
            label = window.findChild(QObject, "fullscreenStatusLabel")
            spinner = window.findChild(QQuickItem, "fullscreenStatusSpinner")
            self.assertFalse(banner.property("visible"))

            # Entering fullscreen does not flash stale pre-fullscreen status message
            banner.setProperty("footerHidden", True)
            QTest.qWait(30)
            self.assertFalse(banner.property("visible"))

            # Ask/Save/Error message in fullscreen shows banner with painted pixels, then auto-dismisses
            banner.setProperty("message", "Copied selected text. Paste it into ChatGPT in your browser.")
            banner.setProperty("messageRevision", 2)
            QTest.qWait(30)
            self.assertTrue(banner.property("visible"))
            self.assertEqual(label.property("text"), "Copied selected text. Paste it into ChatGPT in your browser.")
            self.assertFalse(spinner.property("visible"))

            image = window.grabWindow()
            cx = int(banner.mapToScene(banner.boundingRect().center()).x())
            cy = int(banner.mapToScene(banner.boundingRect().center()).y())
            self.assertNotEqual(image.pixelColor(cx, cy).name(), "#fff8f5")

            # Wait past dismissInterval (140ms) -> banner auto-dismisses
            QTest.qWait(220)
            self.assertFalse(banner.property("visible"))

            # Repeated identical message with incremented revision re-displays banner
            banner.setProperty("messageRevision", 3)
            QTest.qWait(25)
            self.assertTrue(banner.property("visible"))
            QTest.qWait(220)
            self.assertFalse(banner.property("visible"))

            # Busy state stays visible beyond dismissInterval until busy clears, then displays final message
            banner.setProperty("busy", True)
            QTest.qWait(220)
            self.assertTrue(banner.property("visible"))
            self.assertEqual(label.property("text"), "Preparing document\u2026")
            self.assertTrue(spinner.property("visible"))

            banner.setProperty("message", "Exported Study.pdf")
            banner.setProperty("messageRevision", 4)
            banner.setProperty("busy", False)
            QTest.qWait(30)
            self.assertTrue(banner.property("visible"))
            self.assertEqual(label.property("text"), "Exported Study.pdf")
            self.assertFalse(spinner.property("visible"))

            QTest.qWait(220)
            self.assertFalse(banner.property("visible"))
        finally:
            window.close()
            window.deleteLater()
            app.sendPostedEvents(None, QEvent.Type.DeferredDelete)
            engine.deleteLater()
            app.sendPostedEvents(None, QEvent.Type.DeferredDelete)


if __name__ == "__main__":
    unittest.main()
