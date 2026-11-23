"""Isolated WebEngine verification for source-aware selection actions and media menu yielding."""
import os
import subprocess
import sys
import time
import unittest
import urllib.parse
from pathlib import Path

ROOT = Path(__file__).resolve().parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))


def _probe():
    os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
    os.environ.setdefault("QT_QUICK_BACKEND", "software")
    os.environ.setdefault("QTWEBENGINE_CHROMIUM_FLAGS", "--disable-gpu --disable-dev-shm-usage")

    from PySide6.QtCore import QEvent, QMetaObject, QObject, QPoint, QPointF, Property, QUrl, Qt, Slot
    from PySide6.QtQml import QQmlComponent, QQmlEngine
    from PySide6.QtQuickControls2 import QQuickStyle
    from PySide6.QtTest import QTest
    from PySide6.QtWebEngineQuick import QtWebEngineQuick
    from PySide6.QtWidgets import QApplication

    QQuickStyle.setStyle("Material")
    QtWebEngineQuick.initialize()
    app = QApplication.instance() or QApplication(["selection context reader probe"])

    from test_choice_field import Palette
    from test_webengine_context_menu import _production_context_menu_block

    class SelectionPalette(Palette):
        def __init__(self):
            super().__init__()
            self.selection_actions = []
            self.reload_requests = 0

        @Property(str, constant=True)
        def selectionAssistantLabel(self):
            return "ChatGPT"

        @Slot(str, str)
        def selectionAction(self, action, text):
            self.selection_actions.append((action, text))

        @Slot()
        def reloadReaderSafely(self):
            self.reload_requests += 1

    qml_dir = ROOT / "qml"
    engine = QQmlEngine()
    palette = SelectionPalette()
    engine.rootContext().setContextProperty("studio", palette)
    engine.addImportPath(str(qml_dir))
    production_block = _production_context_menu_block()

    html = (
        "<html><body style='margin:0;background:white;color:black;font:20px sans-serif'>"
        "<p id='math' style='margin:16px'>Rendered math $P(A|B) = |x|$</p>"
        "<img id='diagram' draggable='false' width='220' height='120' style='display:block;margin:16px;background:#336699' "
        "src='data:image/svg+xml;utf8,<svg xmlns=%22http://www.w3.org/2000/svg%22 width=%22220%22 height=%22120%22><rect width=%22220%22 height=%22120%22 fill=%22%23336699%22/></svg>'/>"
        "<script>"
        "window.mediaMenuCalls=0;window.copiedCount=0;"
        "window.supermdSelectedText=function(){const s=window.getSelection();return s&&!s.isCollapsed?'| Expr | Value |\\n| --- | --- |\\n| $P(A|B)$ | $|x|$ |':''};"
        "window.supermdMediaMenuAt=function(x,y){if(window.supermdSelectedText().trim().length>0)return false;const el=document.elementFromPoint(x,y);if(el&&el.id==='diagram'){window.mediaMenuCalls++;return true;}return false;};"
        "document.addEventListener('copy',function(e){window.copiedCount++;e.clipboardData.setData('text/plain',window.supermdSelectedText());e.preventDefault();});"
        "</script></body></html>"
    )

    source = f"""\
import QtQuick
import QtQuick.Controls
import QtWebEngine
import "{qml_dir.as_uri()}" as Production

ApplicationWindow {{
    id: window
    width: 620; height: 680; visible: true
    property var reader: readerView
    property var viewState: ({{readerReady:true,busy:false}})
    property int contextMenuCount: 0
    property bool pageReady: false
    property bool selectionPrepared: false
    property bool selectionCleared: false
    property int diagramX: 0
    property int diagramY: 0
    property int copiedCount: 0
    property int mediaMenuCalls: 0
    function prepareSelection() {{
        readerView.runJavaScript("(function(){{const r=document.createRange();r.selectNodeContents(document.getElementById('math'));const s=window.getSelection();s.removeAllRanges();s.addRange(r);const box=document.getElementById('diagram').getBoundingClientRect();return {{x:Math.round(box.left+box.width/2),y:Math.round(box.top+box.height/2)}};}})()", function(res) {{
            if (res) {{
                window.diagramX = res.x
                window.diagramY = res.y
                window.selectionPrepared = true
            }}
        }})
    }}
    function clearSelection() {{
        readerView.runJavaScript("window.getSelection().removeAllRanges(); true", function(ok) {{
            if (ok) window.selectionCleared = true
        }})
    }}
    function syncCounts() {{
        readerView.runJavaScript("({{copied: window.copiedCount || 0, media: window.mediaMenuCalls || 0}})", function(res) {{
            if (res) {{
                window.copiedCount = res.copied
                window.mediaMenuCalls = res.media
            }}
        }})
    }}
    WebEngineView {{
        id: readerView; objectName: "documentReader"
        anchors.fill: parent
        url: {repr("data:text/html;charset=utf-8," + urllib.parse.quote(html))}
        onLoadingChanged: function(loadRequest) {{
            if (loadRequest.status === WebEngineView.LoadSucceededStatus) {{
                runJavaScript("!!document.getElementById('diagram')", function(ok) {{ if (ok) window.pageReady = true }})
            }}
        }}
        {production_block}
    }}
}}
"""
    component = QQmlComponent(engine)
    component.setData(source.encode("utf-8"), QUrl.fromLocalFile(str(qml_dir / "selection-context-probe.qml")))
    if component.isError():
        raise AssertionError("Probe QML failed: " + "\n".join(str(e) for e in component.errors()))
    window = component.create()
    if window is None:
        raise AssertionError("Probe window failed to create")
    try:
        window.show()
        window.requestActivate()
        deadline = time.monotonic() + 10
        while not window.property("pageReady") and time.monotonic() < deadline:
            QTest.qWait(25)
        if not window.property("pageReady"):
            raise AssertionError("WebEngine page did not become ready")

        # Select #math, then right-click directly over #diagram (where request.selectedText is empty!)
        QMetaObject.invokeMethod(window, "prepareSelection")
        deadline = time.monotonic() + 5
        while not window.property("selectionPrepared") and time.monotonic() < deadline:
            QTest.qWait(20)
        if not window.property("selectionPrepared"):
            raise AssertionError("Failed to prepare selection in WebEngine")
        diagram_pt = QPoint(int(window.property("diagramX")), int(window.property("diagramY")))

        menu = window.findChild(QObject, "readerContextMenu")
        QTest.mouseClick(window, Qt.RightButton, Qt.NoModifier, diagram_pt)
        deadline = time.monotonic() + 5
        while not menu.property("visible") and time.monotonic() < deadline:
            QTest.qWait(20)
        if not menu.property("visible"):
            raise AssertionError("Selection context menu did not open when right-clicking diagram with active selection")
        QTest.qWait(60)

        expected = "| Expr | Value |\n| --- | --- |\n| $P(A|B)$ | $|x|$ |"
        if menu.property("selectionText") != expected:
            raise AssertionError(f"Unexpected selectionText: {menu.property('selectionText')!r}")

        copy_item = window.findChild(QObject, "copyMenuItem")
        google_item = window.findChild(QObject, "googleMenuItem")
        ask_item = window.findChild(QObject, "assistantMenuItem")
        if not copy_item.property("enabled"):
            raise AssertionError("Copy was not enabled when right-clicking over image with active selection")
        if not google_item.property("visible") or not ask_item.property("visible"):
            raise AssertionError("Search Google / Ask were not visible when right-clicking over image with active selection")

        # Trigger Ask ChatGPT... and verify serialized Markdown/LaTeX is passed to studio.selectionAction
        ask_pt = ask_item.mapToScene(QPointF(ask_item.width() / 2, ask_item.height() / 2)).toPoint()
        QTest.mouseClick(window, Qt.LeftButton, Qt.NoModifier, ask_pt)
        deadline = time.monotonic() + 3
        while not palette.selection_actions and time.monotonic() < deadline:
            QTest.qWait(20)
        if palette.selection_actions != [("assistant", expected)]:
            raise AssertionError(f"Ask action received wrong payload: {palette.selection_actions!r}")

        # Re-open over diagram while selection remains active and trigger Copy
        deadline = time.monotonic() + 3
        while menu.property("visible") and time.monotonic() < deadline:
            QTest.qWait(20)
        QTest.mouseClick(window, Qt.RightButton, Qt.NoModifier, diagram_pt)
        deadline = time.monotonic() + 3
        while not menu.property("visible") and time.monotonic() < deadline:
            QTest.qWait(20)
        copy_pt = copy_item.mapToScene(QPointF(copy_item.width() / 2, copy_item.height() / 2)).toPoint()
        QTest.mouseClick(window, Qt.LeftButton, Qt.NoModifier, copy_pt)

        deadline = time.monotonic() + 3
        while int(window.property("copiedCount")) < 1 and time.monotonic() < deadline:
            QMetaObject.invokeMethod(window, "syncCounts")
            QTest.qWait(30)
        if int(window.property("copiedCount")) < 1:
            raise AssertionError("Copy action over image did not invoke reader copy listener")

        # Clear selection, then right-click #diagram -> media menu handles it and readerContextMenu stays closed
        QMetaObject.invokeMethod(window, "clearSelection")
        deadline = time.monotonic() + 3
        while not window.property("selectionCleared") and time.monotonic() < deadline:
            QTest.qWait(20)
        QTest.mouseClick(window, Qt.RightButton, Qt.NoModifier, diagram_pt)
        deadline = time.monotonic() + 3
        while int(window.property("mediaMenuCalls")) < 1 and time.monotonic() < deadline:
            QMetaObject.invokeMethod(window, "syncCounts")
            QTest.qWait(25)
        if int(window.property("mediaMenuCalls")) != 1:
            raise AssertionError(f"Expected media menu to handle unselected diagram right-click, got {window.property('mediaMenuCalls')}")
        if menu.property("visible"):
            raise AssertionError("readerContextMenu opened despite supermdMediaMenuAt returning true")
    finally:
        window.close()
        window.deleteLater()
        app.sendPostedEvents(None, QEvent.Type.DeferredDelete)
        engine.deleteLater()
        app.sendPostedEvents(None, QEvent.Type.DeferredDelete)


class SelectionContextReaderTest(unittest.TestCase):
    def test_source_aware_selection_and_media_menu_yielding_in_webengine(self):
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
            timeout=35,
        )
        self.assertEqual(
            result.returncode,
            0,
            f"Selection WebEngine probe failed ({result.returncode})\nstdout:\n{result.stdout}\nstderr:\n{result.stderr}",
        )


if __name__ == "__main__" and len(sys.argv) > 1 and sys.argv[1] == "--probe":
    _probe()
elif __name__ == "__main__":
    unittest.main()
