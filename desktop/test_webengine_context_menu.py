"""Isolated real-WebEngine coverage for the reader's custom context menu.

Qt WebEngine is process-global and can conflict with other Qt Quick tests, so
the actual browser probe runs in a short-lived child process.
"""
import os
import subprocess
import sys
import textwrap
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent
MAIN_QML = ROOT / "qml" / "Main.qml"


def _production_context_menu_block():
    source = MAIN_QML.read_text(encoding="utf-8")
    begin = source.index("                    onContextMenuRequested: function(request)")
    end = source.index("                    WheelHandler {", begin)
    block = textwrap.dedent(source[begin:end]).rstrip()
    # The test imports the production component under an alias and adds only
    # object names needed to send pointer events to the two real menu actions.
    block = block.replace("NoteContextMenu {", "Production.NoteContextMenu {", 1)
    block = block.replace('text: "Copy";', 'objectName: "copyMenuItem"; text: "Copy";', 1)
    block = block.replace('text: "Select all";', 'objectName: "selectAllMenuItem"; text: "Select all";', 1)
    return block


def _probe():
    # These must be set before importing/initializing Qt WebEngine.
    os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
    os.environ.setdefault("QT_QUICK_BACKEND", "software")
    os.environ.setdefault("QTWEBENGINE_CHROMIUM_FLAGS", "--disable-gpu --disable-dev-shm-usage")

    from PySide6.QtCore import QEvent, QPoint, QPointF, QUrl, Qt
    from PySide6.QtGui import QGuiApplication
    from PySide6.QtWidgets import QApplication
    from PySide6.QtQml import QQmlComponent, QQmlEngine
    from PySide6.QtQuickControls2 import QQuickStyle
    from PySide6.QtTest import QTest
    from PySide6.QtWebEngineQuick import QtWebEngineQuick

    # Keep initialization order aligned with the real application entrypoint.
    QQuickStyle.setStyle("Material")
    QtWebEngineQuick.initialize()
    app = QApplication.instance() or QApplication(["isolated WebEngine menu probe"])

    from test_choice_field import Palette

    qml_dir = ROOT / "qml"
    engine = QQmlEngine()
    palette = Palette()
    engine.rootContext().setContextProperty("studio", palette)
    engine.addImportPath(str(qml_dir))
    production_block = _production_context_menu_block()
    source = f'''\
import QtQuick
import QtQuick.Controls
import QtWebEngine
import "{qml_dir.as_uri()}" as Production

ApplicationWindow {{
    id: window
    width: 560; height: 420; visible: true; color: "#b32c55"
    property var reader: readerView
    property int contextMenuCount: 0
    property string menuItems: ""
    function collectMenuItems() {{
        let names = []
        for (let i = 0; i < readerContextMenu.count; ++i)
            names.push(readerContextMenu.itemAt(i).text)
        menuItems = names.join("|")
    }}
    WebEngineView {{
        id: readerView; objectName: "documentReader"
        anchors.fill: parent
        url: "data:text/html,<html><body style='background:white;color:black;font:24px sans-serif'><p id='content'>Synthetic selectable text for native menu</p></body></html>"
        {production_block}
    }}
}}
'''
    component = QQmlComponent(engine)
    component.setData(source.encode(), QUrl.fromLocalFile(str(qml_dir / "webengine-menu-test.qml")))
    if component.isError():
        raise AssertionError("Test QML failed to compile: " + "\n".join(str(e) for e in component.errors()))
    window = component.create()
    if window is None:
        raise AssertionError("Test QML failed to create: " + "\n".join(str(e) for e in component.errors()))
    try:
        QTest.qWait(600)
        reader = window.findChild(object, "documentReader")
        menu = window.findChild(object, "readerContextMenu")
        if reader is None or menu is None:
            raise AssertionError("Could not find the real WebEngineView/custom menu objects")

        # A right-click is dispatched through Chromium's actual context request,
        # not by calling Menu.popup directly.
        context_point = QPoint(180, 120)
        QTest.mouseClick(window, Qt.MouseButton.RightButton, Qt.KeyboardModifier.NoModifier, context_point)
        QTest.qWait(250)
        if not menu.property("visible"):
            raise AssertionError("Right-click on WebEngine content did not open the custom menu")
        window.collectMenuItems()
        labels = window.property("menuItems").split("|")
        if "Copy" not in labels or "Select all" not in labels:
            raise AssertionError(f"Expected Copy/Select all menu actions, got {labels!r}")
        if any(label in labels for label in ("Reload", "Save page", "Save page as")):
            raise AssertionError(f"Browser-only actions leaked into the reader menu: {labels!r}")

        # The production component owns the opaque surface; verify the rendered
        # pixels against the contrasting page underneath it.
        background = menu.property("background")
        point = background.mapToScene(QPointF(background.width() - 8, background.height() / 2))
        shot = window.grabWindow()
        if shot.isNull():
            raise AssertionError("Could not capture rendered WebEngine menu")
        pixel = shot.pixelColor(round(point.x()), round(point.y()))
        expected = palette.palette["surface-low"]
        if pixel.name().lower() != expected.lower():
            raise AssertionError(f"Context menu background pixel was {pixel.name()}, expected opaque surface {expected}")

        # Exercise the WebEngine actions through actual menu-item pointer input.
        select_all = window.findChild(object, "selectAllMenuItem")
        if select_all is None:
            raise AssertionError("Could not locate Select all action")
        select_point = select_all.mapToScene(QPointF(select_all.width() / 2, select_all.height() / 2))
        QTest.mouseClick(window, Qt.MouseButton.LeftButton, Qt.KeyboardModifier.NoModifier,
                         QPoint(round(select_point.x()), round(select_point.y())))
        QTest.qWait(80)
        QTest.mouseClick(window, Qt.MouseButton.RightButton, Qt.KeyboardModifier.NoModifier, context_point)
        QTest.qWait(120)
        if not menu.property("visible"):
            raise AssertionError("Could not reopen reader menu after selecting page text")
        copy = window.findChild(object, "copyMenuItem")
        if copy is None or not copy.property("enabled"):
            raise AssertionError("Copy did not become enabled after selecting page text")
        copy_point = copy.mapToScene(QPointF(copy.width() / 2, copy.height() / 2))
        QTest.mouseClick(window, Qt.MouseButton.LeftButton, Qt.KeyboardModifier.NoModifier,
                         QPoint(round(copy_point.x()), round(copy_point.y())))
        QTest.qWait(120)
        copied = QGuiApplication.clipboard().text()
        if "Synthetic selectable text" not in copied:
            raise AssertionError(f"Select all / Copy did not copy the synthetic page text: {copied!r}")
    finally:
        window.close()
        window.deleteLater()
        app.sendPostedEvents(None, QEvent.Type.DeferredDelete)
        engine.deleteLater()
        app.sendPostedEvents(None, QEvent.Type.DeferredDelete)


class WebEngineContextMenuTest(unittest.TestCase):
    def test_main_qml_routes_real_context_requests_to_only_reader_actions(self):
        handler = _production_context_menu_block()
        self.assertIn("request.accepted = true", handler)
        self.assertIn("readerContextMenu.popup(request.position.x, request.position.y)", handler)
        self.assertIn('text: "Copy"', handler)
        self.assertIn('text: "Select all"', handler)
        self.assertIn("triggerWebAction(WebEngineView.Copy)", handler)
        self.assertIn("triggerWebAction(WebEngineView.SelectAll)", handler)
        self.assertNotIn('text: "Reload"', handler)
        self.assertNotIn('text: "Save page', handler)

    def test_real_webengine_right_click_menu_in_isolated_process(self):
        env = os.environ.copy()
        env.setdefault("QT_QPA_PLATFORM", "offscreen")
        env.setdefault("QT_QUICK_BACKEND", "software")
        env.setdefault("QTWEBENGINE_CHROMIUM_FLAGS", "--disable-gpu --disable-dev-shm-usage")
        result = subprocess.run(
            [sys.executable, str(Path(__file__).resolve()), "--probe"],
            cwd=ROOT,
            env=env,
            capture_output=True,
            text=True,
            timeout=30,
        )
        self.assertEqual(result.returncode, 0,
                         f"WebEngine child probe failed ({result.returncode})\nstdout:\n{result.stdout}\nstderr:\n{result.stderr}")


if __name__ == "__main__" and len(sys.argv) > 1 and sys.argv[1] == "--probe":
    _probe()
elif __name__ == "__main__":
    unittest.main()
