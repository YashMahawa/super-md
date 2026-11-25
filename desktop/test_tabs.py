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
    id: host
    width: 700; height: 180; visible: true
    property var viewState: JSON.parse(studio.snapshot)
    Connections {
        target: studio
        function onChanged() { host.viewState = JSON.parse(studio.snapshot) }
    }
    TabStrip { width: parent.width; viewState: host.viewState }
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
        enter = QDragEnterEvent(point, Qt.DropAction.MoveAction, mime, Qt.MouseButton.LeftButton, Qt.KeyboardModifier.NoModifier)
        self.app.sendEvent(self.window, enter)
        move = QDragMoveEvent(point, Qt.DropAction.MoveAction, mime, Qt.MouseButton.LeftButton, Qt.KeyboardModifier.NoModifier)
        self.app.sendEvent(self.window, move)
        drop = QDropEvent(QPointF(point), Qt.DropAction.MoveAction, mime, Qt.MouseButton.LeftButton, Qt.KeyboardModifier.NoModifier)
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

    def test_tabs_and_plus_share_the_strip_vertical_center(self):
        items = [self.window.contentItem()]
        tabs, plus = [], None
        while items:
            item = items.pop()
            if item.objectName() == "noteTab": tabs.append(item)
            if item.objectName() == "newTabButton": plus = item
            items.extend(item.childItems())
        self.assertEqual(len(tabs), len(self.studio.tabs))
        self.assertIsNotNone(plus)
        self.assertEqual(plus.property("text"), "")
        self.assertEqual(plus.property("glyph"), "Plus")
        for item in [*tabs, plus]:
            self.assertAlmostEqual(item.y() + item.height() / 2, 24, delta=.5)

    def _strip_and_active_tab(self):
        strip = self.window.findChild(QQuickItem, "tabStrip")
        self.assertIsNotNone(strip)
        items = [strip]
        active_item = None
        while items:
            item = items.pop()
            if item.objectName() == "noteTab" and item.property("isActive"):
                active_item = item
                break
            items.extend(item.childItems())
        self.assertIsNotNone(active_item)
        return strip, strip.property("contentItem"), active_item

    def _assert_active_tab_revealed(self, context):
        strip, flickable, active_item = self._strip_and_active_tab()
        content_x = float(flickable.property("contentX"))
        viewport_width = float(strip.property("availableWidth") or strip.width())
        self.assertGreaterEqual(
            active_item.x() + 0.5,
            content_x,
            f"Active tab left edge clipped ({context}): x={active_item.x()}, contentX={content_x}",
        )
        self.assertLessEqual(
            active_item.x() + active_item.width() - 0.5,
            content_x + viewport_width,
            f"Active tab right edge clipped ({context}): right={active_item.x() + active_item.width()}, viewportRight={content_x + viewport_width}",
        )

    def test_overflowing_strip_reveals_active_tab_on_create_switch_move_reopen_and_resize(self):
        # Create enough wide tabs to overflow the 700px window horizontally.
        for index in range(8):
            self.studio.newNote()
            self.studio.renameNote(self.studio.active, f"Chapter {index + 1} Architecture Overview")
        QTest.qWait(60)
        strip, flickable, _ = self._strip_and_active_tab()
        self.assertGreater(float(flickable.property("contentWidth")), strip.width())
        self.assertGreater(float(flickable.property("contentX")), 0)
        self._assert_active_tab_revealed("after creating overflowing rightmost tab")

        # Switching to tab 1 via tabNumber scrolls all the way back to the left.
        self.studio.tabNumber(1)
        QTest.qWait(60)
        self._assert_active_tab_revealed("after switching to tab 1")
        self.assertLessEqual(float(flickable.property("contentX")), 20)

        # Cycling backward from tab 1 wraps to the rightmost tab and reveals it.
        self.studio.cycleTab(-1)
        QTest.qWait(60)
        self._assert_active_tab_revealed("after cycling wrap to last tab")

        # Moving the active tab repeatedly to the left keeps it inside the viewport.
        for _ in range(7):
            self.studio.moveActiveTab(-1)
            QTest.qWait(30)
            self._assert_active_tab_revealed("while moving active tab left")

        # Jump to the last tab, close it, then reopen it and confirm both stay visible.
        self.studio.selectTab(self.studio.tabs[-1]["id"])
        QTest.qWait(50)
        self._assert_active_tab_revealed("after selecting last tab")
        self.studio.closeTabSafely(self.studio.active)
        QTest.qWait(50)
        self._assert_active_tab_revealed("after closing rightmost tab")
        self.studio.reopenTab()
        QTest.qWait(60)
        self._assert_active_tab_revealed("after reopening closed tab")

        # Narrowing the window while on a right-side tab re-reveals the active tab.
        self.window.resize(460, 180)
        QTest.qWait(60)
        self._assert_active_tab_revealed("after narrowing window")
