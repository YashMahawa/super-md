"""Isolated real-WebEngine coverage for the reader's custom context menu.

Qt WebEngine is process-global and can conflict with other Qt Quick tests, so
the actual browser probe runs in a short-lived child process.
"""
import os
import subprocess
import sys
import textwrap
import time
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
    block = block.replace('text: "Search Google";', 'objectName: "googleMenuItem"; text: "Search Google";', 1)
    block = block.replace('text: "Ask " +', 'objectName: "assistantMenuItem"; text: "Ask " +', 1)
    return block


def _probe():
    # These must be set before importing/initializing Qt WebEngine.
    os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
    os.environ.setdefault("QT_QUICK_BACKEND", "software")
    os.environ.setdefault("QTWEBENGINE_CHROMIUM_FLAGS", "--disable-gpu --disable-dev-shm-usage")

    from PySide6.QtCore import QEvent, QPoint, QPointF, QUrl, Qt, QObject, Property, Slot
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
    class SelectionPalette(Palette):
        def __init__(self):super().__init__();self.selection_actions=[]
        @Property(str, constant=True)
        def selectionAssistantLabel(self):return 'ChatGPT'
        @Slot(str,str)
        def selectionAction(self,action,text):self.selection_actions.append((action,text))
    palette = SelectionPalette()
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
    property bool pageReady: false
    property bool selectionReady: false
    function checkSelection() {{ readerView.runJavaScript("window.getSelection().toString()", function(text) {{ selectionReady = text.includes('Synthetic selectable text') }}) }}
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
        onLoadingChanged: function(loadRequest) {{
            if (loadRequest.status === WebEngineView.LoadSucceededStatus) {{
                runJavaScript("document.readyState === 'complete' && !!document.getElementById('content')", function(ready) {{
                    if (ready) window.pageReady = true
                }})
            }}
        }}
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
        window.show()
        window.raise_()
        window.requestActivate()
        deadline = time.monotonic() + 10
        while not window.property("pageReady") and time.monotonic() < deadline:
            QTest.qWait(50)
        if not window.property("pageReady"):
            raise AssertionError("WebEngine page did not reach load-success plus DOM-ready within 10 seconds")
        reader = window.findChild(object, "documentReader")
        menu = window.findChild(object, "readerContextMenu")
        if reader is None or menu is None:
            raise AssertionError("Could not find the real WebEngineView/custom menu objects")

        # A right-click is dispatched through Chromium's actual context request,
        # not by calling Menu.popup directly.
        context_point = QPoint(180, 120)
        QTest.mouseMove(window, context_point)
        QTest.qWait(100)
        before_menu=window.grabWindow().pixelColor(20,80).name()
        QTest.mouseClick(window, Qt.MouseButton.RightButton, Qt.KeyboardModifier.NoModifier, context_point)
        deadline = time.monotonic() + 3
        while not menu.property("visible") and time.monotonic() < deadline:
            QTest.qWait(30)
        if not menu.property("visible"):
            raise AssertionError("Right-click on loaded WebEngine content did not open the custom menu within 3 seconds")
        ripples=[child.metaObject().className() for child in menu.findChildren(QObject) if 'Ripple' in child.metaObject().className()]
        if ripples:
            raise AssertionError(f"Stock material ripple leaked into reader menu: {ripples!r}")
        if menu.property('selectionText'):
            raise AssertionError('Opening an empty-page context menu invented a selection')
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
        if shot.pixelColor(20,80).name()!=before_menu:
            raise AssertionError('Opening the menu painted an unrelated ripple in the top-left document area')
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
        deadline=time.monotonic()+3
        while (menu.property('visible') or not window.property('selectionReady')) and time.monotonic()<deadline:
            window.checkSelection();QTest.qWait(30)
        if not window.property('selectionReady'):raise AssertionError('Select all did not establish native selected text')
        QTest.mouseClick(window, Qt.MouseButton.RightButton, Qt.KeyboardModifier.NoModifier, context_point)
        deadline=time.monotonic()+3
        while not menu.property('visible') and time.monotonic()<deadline:QTest.qWait(30)
        if not menu.property("visible"):
            raise AssertionError("Could not reopen reader menu after selecting page text")
        copy = window.findChild(object, "copyMenuItem")
        if copy is None or not copy.property("enabled"):
            raise AssertionError("Copy did not become enabled after selecting page text")
        if 'Synthetic selectable text' not in menu.property('selectionText'):
            raise AssertionError('Context action did not capture the selected text before menu focus changed')
        window.collectMenuItems()
        if 'Search Google' not in window.property('menuItems') or 'Ask ChatGPT' not in window.property('menuItems'):
            raise AssertionError('Selected-text search actions missing from native reader menu')
        QTest.mouseMove(window,copy.mapToScene(QPointF(copy.width()/2,copy.height()/2)).toPoint())
        QTest.qWait(50)
        highlight=copy.property('background');shot=window.grabWindow()
        if os.environ.get('SUPERMD_MENU_TEST_OUTPUT'):shot.save(os.environ['SUPERMD_MENU_TEST_OUTPUT'])
        def highlight_pixel(x,y):
            point=highlight.mapToScene(QPointF(x,y));return shot.pixelColor(round(point.x()),round(point.y())).name()
        if highlight_pixel(highlight.width()/2,highlight.height()/2)!=palette.palette['surface-high']:
            raise AssertionError(f"Hovered item did not paint its highlight: {highlight_pixel(highlight.width()/2,highlight.height()/2)}, hovered={copy.property('hovered')}, highlighted={copy.property('highlighted')}, size={highlight.width()}x{highlight.height()}")
        if highlight_pixel(0,0)!=expected:
            raise AssertionError('Hovered item has square corners instead of exposing menu surface')
        if os.environ.get('SUPERMD_MENU_TEST_OUTPUT'):shot.save(os.environ['SUPERMD_MENU_TEST_OUTPUT'])
        copy_point = copy.mapToScene(QPointF(copy.width() / 2, copy.height() / 2))
        QTest.mouseClick(window, Qt.MouseButton.LeftButton, Qt.KeyboardModifier.NoModifier,
                         QPoint(round(copy_point.x()), round(copy_point.y())))
        QTest.qWait(120)
        copied = QGuiApplication.clipboard().text()
        if "Synthetic selectable text" not in copied:
            raise AssertionError(f"Select all / Copy did not copy the synthetic page text: {copied!r}")
        for name,action in [('googleMenuItem','google'),('assistantMenuItem','assistant')]:
            deadline=time.monotonic()+3
            while menu.property('visible') and time.monotonic()<deadline:QTest.qWait(20)
            QTest.mouseClick(window,Qt.RightButton,Qt.NoModifier,context_point)
            deadline=time.monotonic()+3
            while not menu.property('visible') and time.monotonic()<deadline:QTest.qWait(20)
            item=window.findChild(QObject,name)
            if not item or not item.property('visible'):raise AssertionError(f'{name} was not available for selected text')
            QTest.mouseClick(window,Qt.LeftButton,Qt.NoModifier,item.mapToScene(QPointF(item.width()/2,item.height()/2)).toPoint())
            deadline=time.monotonic()+3
            while (not palette.selection_actions or palette.selection_actions[-1][0]!=action) and time.monotonic()<deadline:QTest.qWait(20)
            if not palette.selection_actions or palette.selection_actions[-1]!=(action,copied):
                raise AssertionError(f'{action} did not receive the exact selected text: {palette.selection_actions!r}')
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
