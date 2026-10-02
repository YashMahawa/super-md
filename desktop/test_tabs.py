"""Native Qt drop events must reach the real QML strip and preserve ownership."""
import json
import os
import unittest
from pathlib import Path
os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
from PySide6.QtCore import QUrl, QMimeData, QPoint, QPointF, Qt, QEvent
from PySide6.QtGui import QGuiApplication, QDragEnterEvent, QDragMoveEvent, QDropEvent
from PySide6.QtQml import QQmlEngine, QQmlComponent
from PySide6.QtQuick import QQuickItem
from PySide6.QtTest import QTest
from studio import Session
from test_studio import QuietStudio

class NativeTabsTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.app = QGuiApplication.instance() or QGuiApplication(["Native tab tests"])

    def setUp(self):
        self.session = Session(True)
        self.studio = QuietStudio(True, self.session)
        self.studio.newNote(); self.studio.newNote()
        self.engine = QQmlEngine()
        self.engine.rootContext().setContextProperty("studio", self.studio)
        self.component = QQmlComponent(self.engine)
        self.component.setData(b'''
import QtQuick
import QtQuick.Controls
ApplicationWindow {
    width: 700; height: 180; visible: true
    TabStrip { width: parent.width; viewState: JSON.parse(studio.snapshot) }
}
''', QUrl.fromLocalFile(str(Path(__file__).parent / "qml/tab-test.qml")))
        self.assertFalse(self.component.isError(), str(self.component.errors()))
        self.window = self.component.create()
        self.assertIsNotNone(self.window)
        QTest.qWait(50)

    def tearDown(self):
        self.window.close(); self.window.deleteLater()
        self.app.sendPostedEvents(None, QEvent.Type.DeferredDelete)
        self.engine.deleteLater()
        self.app.sendPostedEvents(None, QEvent.Type.DeferredDelete)
        self.studio.stop(); self.studio.pool.shutdown(wait=True)
        self.session.writes.shutdown(wait=True)

    def drop(self, payload):
        mime = QMimeData(); mime.setData("application/x-supermd-tab", json.dumps(payload).encode())
        point = QPoint(20, 20)
        enter = QDragEnterEvent(point, Qt.MoveAction, mime, Qt.LeftButton, Qt.NoModifier)
        self.app.sendEvent(self.window, enter)
        move = QDragMoveEvent(point, Qt.MoveAction, mime, Qt.LeftButton, Qt.NoModifier)
        self.app.sendEvent(self.window, move)
        drop = QDropEvent(QPointF(point), Qt.MoveAction, mime, Qt.LeftButton, Qt.NoModifier)
        self.app.sendEvent(self.window, drop)
        QTest.qWait(30)
        return drop.isAccepted()

    def test_native_drop_reorders_instead_of_opening_a_file(self):
        note = self.studio.tabs[-1]
        active = self.studio.active
        self.assertTrue(self.drop({"window": self.studio.window_id, "tab": note["id"]}))
        self.assertIs(self.studio.tabs[0], note)
        self.assertEqual(self.studio.active, active)

    def test_forged_or_stale_ids_are_not_accepted(self):
        original = list(self.studio.tabs)
        self.assertFalse(self.drop({"window": "foreign", "tab": "not-open"}))
        self.assertEqual(self.studio.tabs, original)

    def test_drag_hint_is_a_real_rendered_card(self):
        # Repeater delegates belong to a visual tree, not necessarily the
        # window's QObject ownership tree.
        items = [self.window.contentItem()]
        preview = None
        while items:
            item = items.pop()
            if item.objectName() == "tabDragPreview":
                preview = item
                break
            items.extend(item.childItems())
        self.assertIsNotNone(preview)
        result = preview.grabToImage()
        for _ in range(40):
            if not result.image().isNull(): break
            QTest.qWait(25)
        image = result.image()
        self.assertFalse(image.isNull())
        self.assertEqual((image.width(), image.height()), (320, 190))
        colors = {image.pixelColor(x, y).rgba() for x in range(0, 320, 8) for y in range(0, 190, 8)}
        self.assertGreater(len(colors), 3, "The tab tear-off preview must contain painted text and a card, not an empty image")
