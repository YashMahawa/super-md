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
import urllib.parse
from pathlib import Path

ROOT = Path(__file__).resolve().parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))
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


def _production_reader_edit_action():
    source = MAIN_QML.read_text(encoding="utf-8")
    start = source.index("    function nativeReaderEditAction(action)")
    brace = source.index("{", start)
    depth = 0
    for end in range(brace, len(source)):
        if source[end] == "{": depth += 1
        elif source[end] == "}":
            depth -= 1
            if depth == 0:
                return source[start:end + 1]
    raise AssertionError("Could not extract the production native reader edit action")


def _probe():
    # These must be set before importing/initializing Qt WebEngine.
    os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
    os.environ.setdefault("QT_QUICK_BACKEND", "software")
    os.environ.setdefault("QTWEBENGINE_CHROMIUM_FLAGS", "--disable-gpu --disable-dev-shm-usage")

    from PySide6.QtCore import QEvent, QMetaObject, QPoint, QPointF, QUrl, Qt, QObject, Property, Slot
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
        def __init__(self):super().__init__();self.selection_actions=[];self.reload_requests=0
        @Property(str, constant=True)
        def selectionAssistantLabel(self):return 'ChatGPT'
        @Slot(str,str)
        def selectionAction(self,action,text):self.selection_actions.append((action,text))
        @Slot()
        def reloadReaderSafely(self):self.reload_requests+=1
    palette = SelectionPalette()
    engine.rootContext().setContextProperty("studio", palette)
    engine.addImportPath(str(qml_dir))
    production_block = _production_context_menu_block()
    edit_action = _production_reader_edit_action()
    source = f'''\
import QtQuick
import QtQuick.Controls
import QtWebEngine
import "{qml_dir.as_uri()}" as Production

ApplicationWindow {{
    id: window
    width: 560; height: 600; visible: true; color: "#b32c55"
    property var reader: readerView
    property var viewState: ({{readerReady:true,busy:false}})
    property int contextMenuCount: 0
    property bool pageReady: false
    property bool selectionReady: false
    property bool copyHandled: false
    property bool nativeCopyShortcutTriggered: false
    property string domSelectionText: ""
    property bool mediaPageReady: false
    property bool mediaSelectionPrepared: false
    property bool mediaSelectionCleared: false
    property int diagramX: 0
    property int diagramY: 0
    property int chartX: 0
    property int chartY: 0
    property int copiedCount: 0
    property int mediaMenuCalls: 0
    function prepareMediaSelection() {{
        readerView.runJavaScript("(function(){{const r=document.createRange();r.selectNodeContents(document.getElementById('math'));const s=window.getSelection();s.removeAllRanges();s.addRange(r);const box=document.getElementById('diagram').getBoundingClientRect();const cbox=document.getElementById('chartLabel').getBoundingClientRect();return {{x:Math.round(box.left+box.width/2),y:Math.round(box.top+box.height/2),cx:Math.round(cbox.left+cbox.width/2),cy:Math.round(cbox.top+cbox.height/2)}};}})()", function(res) {{
            if (res) {{
                window.diagramX = res.x
                window.diagramY = res.y
                window.chartX = res.cx
                window.chartY = res.cy
                window.mediaSelectionPrepared = true
            }}
        }})
    }}
    function clearMediaSelection() {{
        readerView.runJavaScript("window.getSelection().removeAllRanges(); true", function(ok) {{
            if (ok) window.mediaSelectionCleared = true
        }})
    }}
    function syncMediaCounts() {{
        readerView.runJavaScript("({{copied: window.copiedCount || 0, media: window.mediaMenuCalls || 0}})", function(res) {{
            if (res) {{
                window.copiedCount = res.copied
                window.mediaMenuCalls = res.media
            }}
        }})
    }}
    function nativeReaderEditAction(action) {{
        {edit_action.split("{", 1)[1].rsplit("}", 1)[0]}
    }}
    function selectDocumentText() {{ readerView.runJavaScript("(function(){{const node=document.getElementById('content').firstChild;const range=document.createRange();range.selectNodeContents(node);const selection=window.getSelection();selection.removeAllRanges();selection.addRange(range);return selection.toString()}})()", function(text) {{ window.selectionReady = text.includes('Synthetic selectable text') }}) }}
    function clearDocumentSelection() {{ readerView.runJavaScript("window.getSelection().removeAllRanges()", function() {{}}) }}
    function readDocumentSelection() {{ readerView.runJavaScript("window.getSelection().toString()", function(text) {{ window.domSelectionText = text }}) }}
    Shortcut {{ sequence: "Ctrl+C"; context: Qt.WindowShortcut; onActivated: {{ window.nativeCopyShortcutTriggered = true; window.nativeReaderEditAction("copy") }} }}
    Rectangle {{ id: toolbarFocusTarget; objectName: "toolbarFocusTarget"; width: 20; height: 20; focus: true; visible: true }}
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
        url: "data:text/html,<html><body style='background:white;color:black;font:24px sans-serif'><p id='content'>Synthetic selectable text for native menu</p><script>document.addEventListener('copy',e=>{{window.nativeCopyHandled=true;e.clipboardData.setData('text/plain','**Rendered source** and $x^2$');e.preventDefault()}})</script></body></html>"
        onLoadingChanged: function(loadRequest) {{
            if (loadRequest.status === WebEngineView.LoadSucceededStatus) {{
                runJavaScript("document.readyState === 'complete' && !!document.getElementById('content')", function(ready) {{
                    if (ready) window.pageReady = true
                }})
                runJavaScript("document.readyState === 'complete' && !!document.getElementById('diagram')", function(ready) {{
                    if (ready) window.mediaPageReady = true
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

        # Preserve a selection while moving native focus to the toolbar, then
        # send a real Ctrl+C through Qt's WindowShortcut and Chromium's Copy
        # action. The document's copy handler stands in for MarkdownPreview's
        # source-serialization onCopy handler and proves that event is reached.
        toolbar = window.findChild(QObject, "toolbarFocusTarget")
        if toolbar is None: raise AssertionError("Could not locate native toolbar focus target")
        window.requestActivate()
        if not QTest.qWaitForWindowActive(window, 1000):
            raise AssertionError("Could not activate the offscreen Qt window for native key testing")
        toolbar.forceActiveFocus()
        QTest.qWait(30)
        QGuiApplication.clipboard().setText("clipboard sentinel")
        window.selectDocumentText()
        deadline = time.monotonic() + 3
        while not window.property("selectionReady") and time.monotonic() < deadline: QTest.qWait(25)
        if not window.property("selectionReady"): raise AssertionError("Could not create a real WebEngine selection")
        selected_text_property = reader.property("selectedText")
        toolbar.forceActiveFocus()
        QTest.qWait(30)
        window.readDocumentSelection()
        QTest.qWait(40)
        QTest.keyClick(window, Qt.Key_C, Qt.KeyboardModifier.ControlModifier)
        deadline = time.monotonic() + 3
        while QGuiApplication.clipboard().text() == "clipboard sentinel" and time.monotonic() < deadline:
            QTest.qWait(25)
        copied_from_key = QGuiApplication.clipboard().text()
        if copied_from_key != "**Rendered source** and $x^2$":
            raise AssertionError(f"Native Ctrl+C did not reach the rendered copy handler: clipboard={copied_from_key!r}, shortcut={window.property('nativeCopyShortcutTriggered')!r}, selected={window.property('domSelectionText')!r}, webengineSelected={selected_text_property!r}")
        window.clearDocumentSelection()
        QTest.qWait(40)
        QTest.keyClick(window, Qt.Key_C, Qt.KeyboardModifier.ControlModifier)
        QTest.qWait(80)
        if QGuiApplication.clipboard().text() != copied_from_key:
            raise AssertionError("Ctrl+C without a DOM selection changed the clipboard")

        # A right-click is dispatched through Chromium's actual context request,
        # not by calling Menu.popup directly.
        context_point = QPoint(180, 120)
        QTest.mouseMove(window, context_point)
        QTest.qWait(100)
        before_menu = window.grabWindow().pixelColor(20, 80).name()
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
        if "Reload" not in labels or any(label in labels for label in ("Save page", "Save page as", "View page source")):
            raise AssertionError(f"Expected the useful Reload action without developer actions, got: {labels!r}")

        # The production component owns the opaque surface; verify the rendered
        # pixels against the contrasting page underneath it.
        background = menu.property("background")
        point = background.mapToScene(QPointF(background.width() - 8, background.height() / 2))
        shot = window.grabWindow()
        if shot.isNull():
            raise AssertionError("Could not capture rendered WebEngine menu")
        if shot.pixelColor(20, 80).name() != before_menu:
            raise AssertionError("Opening the menu painted an unrelated ripple in the top-left document area")
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
        QTest.mouseMove(window, copy.mapToScene(QPointF(copy.width() / 2, copy.height() / 2)).toPoint())
        QTest.qWait(50)
        highlight = copy.property('background')
        shot = window.grabWindow()
        if shot.isNull():
            raise AssertionError("Could not capture hovered context menu item")
        if os.environ.get("SUPERMD_MENU_TEST_OUTPUT"):
            shot.save(os.environ["SUPERMD_MENU_TEST_OUTPUT"])
        def highlight_pixel(x, y):
            point = highlight.mapToScene(QPointF(x, y))
            return shot.pixelColor(round(point.x()), round(point.y())).name()
        if highlight_pixel(highlight.width() / 2, highlight.height() / 2) != palette.palette['surface-high']:
            raise AssertionError(f"Hovered item did not paint its highlight: {highlight_pixel(highlight.width() / 2, highlight.height() / 2)}, hovered={copy.property('hovered')}, highlighted={copy.property('highlighted')}, size={highlight.width()}x{highlight.height()}")
        if highlight_pixel(0, 0) != expected:
            raise AssertionError("Hovered item has square corners instead of exposing menu surface")
        if os.environ.get("SUPERMD_MENU_TEST_OUTPUT"):
            shot.save(os.environ["SUPERMD_MENU_TEST_OUTPUT"])
        copy_point = copy.mapToScene(QPointF(copy.width() / 2, copy.height() / 2))
        QTest.mouseClick(window, Qt.MouseButton.LeftButton, Qt.KeyboardModifier.NoModifier,
                         QPoint(round(copy_point.x()), round(copy_point.y())))
        QTest.qWait(120)
        copied = QGuiApplication.clipboard().text()
        if copied != "**Rendered source** and $x^2$":
            raise AssertionError(f"Select all / Copy did not reach the rendered source handler: {copied!r}")
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
            if not palette.selection_actions or palette.selection_actions[-1]!=(action,menu.property('selectionText')):
                raise AssertionError(f'{action} did not receive the exact selected text: {palette.selection_actions!r}')
        deadline=time.monotonic()+3
        while menu.property('visible') and time.monotonic()<deadline:QTest.qWait(20)
        QTest.mouseClick(window,Qt.RightButton,Qt.NoModifier,context_point)
        deadline=time.monotonic()+3
        while not menu.property('visible') and time.monotonic()<deadline:QTest.qWait(20)
        reload_item=window.findChild(QObject,"reloadMenuItem")
        if reload_item is None:raise AssertionError("Could not locate the safe Reload menu action")
        reload_point=reload_item.mapToScene(QPointF(reload_item.width()/2,reload_item.height()/2)).toPoint()
        QTest.mouseClick(window,Qt.LeftButton,Qt.NoModifier,reload_point)
        if palette.reload_requests!=1:raise AssertionError("Reload did not route through the safe native flush action")

        # Phase 2 (in the same isolated WebEngine process): verify source-aware
        # selection extraction (`window.supermdSelectedText`) and media context
        # menu yielding (`window.supermdMediaMenuAt`) when right-clicking over
        # an unselected image or chart SVG while math/table text is selected.
        deadline = time.monotonic() + 3
        while menu.property("visible") and time.monotonic() < deadline:
            QTest.qWait(20)
        palette.selection_actions.clear()
        media_html = (
            "<html><body style='margin:0;background:white;color:black;font:20px sans-serif'>"
            "<p id='math' style='margin:16px'>Rendered math $P(A|B) = |x|$</p>"
            "<img id='diagram' draggable='false' width='220' height='110' style='display:block;margin:16px;background:#336699' "
            "src='data:image/svg+xml;utf8,<svg xmlns=%22http://www.w3.org/2000/svg%22 width=%22220%22 height=%22110%22><rect width=%22220%22 height=%22110%22 fill=%22%23336699%22/></svg>'/>"
            "<figure class='interactive-chart' style='margin:16px'><svg id='chartSvg' width='220' height='90' style='user-select:none;-webkit-user-select:none'>"
            "<text id='chartLabel' x='20' y='50' font-size='20'>AxisTick</text></svg></figure>"
            "<script>"
            "window.mediaMenuCalls=0;window.copiedCount=0;"
            "window.supermdSelectedText=function(){const s=window.getSelection();return s&&!s.isCollapsed?'| Expr | Value |\\n| --- | --- |\\n| $P(A|B)$ | $|x|$ |':''};"
            "window.supermdMediaMenuAt=function(x,y){if(window.supermdSelectedText().trim().length>0)return false;const el=document.elementFromPoint(x,y);if(el&&(el.id==='diagram'||el.closest('#chartSvg'))){window.mediaMenuCalls++;return true;}return false;};"
            "document.addEventListener('copy',function(e){window.copiedCount++;e.clipboardData.setData('text/plain',window.supermdSelectedText());e.preventDefault();});"
            "</script></body></html>"
        )
        reader.setProperty("url", QUrl("data:text/html;charset=utf-8," + urllib.parse.quote(media_html)))
        deadline = time.monotonic() + 10
        while not window.property("mediaPageReady") and time.monotonic() < deadline:
            QTest.qWait(25)
        if not window.property("mediaPageReady"):
            raise AssertionError("Media selection WebEngine page did not become ready")

        QMetaObject.invokeMethod(window, "prepareMediaSelection")
        deadline = time.monotonic() + 5
        while not window.property("mediaSelectionPrepared") and time.monotonic() < deadline:
            QTest.qWait(20)
        if not window.property("mediaSelectionPrepared"):
            raise AssertionError("Failed to prepare selection in media WebEngine page")
        diagram_pt = QPoint(int(window.property("diagramX")), int(window.property("diagramY")))
        chart_pt = QPoint(int(window.property("chartX")), int(window.property("chartY")))

        QTest.mouseClick(window, Qt.RightButton, Qt.NoModifier, diagram_pt)
        deadline = time.monotonic() + 5
        while not menu.property("visible") and time.monotonic() < deadline:
            QTest.qWait(20)
        if not menu.property("visible"):
            raise AssertionError("Selection context menu did not open when right-clicking diagram with active selection")
        QTest.qWait(60)

        expected_table = "| Expr | Value |\n| --- | --- |\n| $P(A|B)$ | $|x|$ |"
        if menu.property("selectionText") != expected_table:
            raise AssertionError(f"Unexpected selectionText over diagram: {menu.property('selectionText')!r}")

        copy_item = window.findChild(QObject, "copyMenuItem")
        google_item = window.findChild(QObject, "googleMenuItem")
        ask_item = window.findChild(QObject, "assistantMenuItem")
        if not copy_item.property("enabled"):
            raise AssertionError("Copy was not enabled when right-clicking over image with active selection")
        if not google_item.property("visible") or not ask_item.property("visible"):
            raise AssertionError("Search Google / Ask were not visible when right-clicking over image with active selection")

        ask_pt = ask_item.mapToScene(QPointF(ask_item.width() / 2, ask_item.height() / 2)).toPoint()
        QTest.mouseClick(window, Qt.LeftButton, Qt.NoModifier, ask_pt)
        deadline = time.monotonic() + 3
        while not palette.selection_actions and time.monotonic() < deadline:
            QTest.qWait(20)
        if palette.selection_actions != [("assistant", expected_table)]:
            raise AssertionError(f"Ask action received wrong payload: {palette.selection_actions!r}")

        # Re-open over chart SVG text label while selection remains active and trigger Copy
        deadline = time.monotonic() + 3
        while menu.property("visible") and time.monotonic() < deadline:
            QTest.qWait(20)
        QTest.mouseClick(window, Qt.RightButton, Qt.NoModifier, chart_pt)
        deadline = time.monotonic() + 3
        while not menu.property("visible") and time.monotonic() < deadline:
            QTest.qWait(20)
        if menu.property("selectionText") != expected_table:
            raise AssertionError(f"Unexpected selectionText over chart SVG: {menu.property('selectionText')!r}")
        copy_pt = copy_item.mapToScene(QPointF(copy_item.width() / 2, copy_item.height() / 2)).toPoint()
        QTest.mouseClick(window, Qt.LeftButton, Qt.NoModifier, copy_pt)

        deadline = time.monotonic() + 3
        while int(window.property("copiedCount")) < 1 and time.monotonic() < deadline:
            QMetaObject.invokeMethod(window, "syncMediaCounts")
            QTest.qWait(30)
        if int(window.property("copiedCount")) < 1:
            raise AssertionError("Copy action over media did not invoke reader copy listener")

        # Clear selection, then right-click #diagram -> media menu handles it and readerContextMenu stays closed
        QMetaObject.invokeMethod(window, "clearMediaSelection")
        deadline = time.monotonic() + 3
        while not window.property("mediaSelectionCleared") and time.monotonic() < deadline:
            QTest.qWait(20)
        QTest.mouseClick(window, Qt.RightButton, Qt.NoModifier, diagram_pt)
        deadline = time.monotonic() + 3
        while int(window.property("mediaMenuCalls")) < 1 and time.monotonic() < deadline:
            QMetaObject.invokeMethod(window, "syncMediaCounts")
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


class WebEngineContextMenuTest(unittest.TestCase):
    def test_main_qml_routes_real_context_requests_to_only_reader_actions(self):
        handler = _production_context_menu_block()
        self.assertIn("request.accepted = true", handler)
        self.assertIn("supermdMediaMenuAt", handler)
        self.assertIn("if (!handled) readerContextMenu.popup(x, y)", handler)
        self.assertIn('text: "Copy"', handler)
        self.assertIn('text: "Select all"', handler)
        self.assertIn("triggerWebAction(WebEngineView.Copy)", handler)
        self.assertIn("triggerWebAction(WebEngineView.SelectAll)", handler)
        self.assertIn('text: "Reload"', handler)
        self.assertIn("studio.reloadReaderSafely()", handler)
        self.assertNotIn('text: "Save page', handler)
        from shortcuts import default_shortcuts
        self.assertIn("Ctrl+C", default_shortcuts()["copy"])
        self.assertIn("reader.triggerWebAction(WebEngineView.Copy)", _production_reader_edit_action())

    def test_run_tests_watchdog_budget_covers_macos_arm64_within_ci_step_timeout(self):
        if str(ROOT) not in sys.path:
            sys.path.insert(0, str(ROOT))
        import run_tests
        self.assertEqual(run_tests.suite_watchdog_seconds("darwin", "arm64"), 420)
        self.assertLess(run_tests.suite_watchdog_seconds("darwin", "arm64"), 480)
        self.assertEqual(run_tests.suite_watchdog_seconds("darwin", "x86_64"), 720)
        self.assertEqual(run_tests.suite_watchdog_seconds("linux", "x86_64"), 240)
        self.assertEqual(run_tests.suite_watchdog_seconds("win32", "AMD64"), 240)

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
            timeout=45,
        )
        self.assertEqual(result.returncode, 0,
                         f"WebEngine child probe failed ({result.returncode})\nstdout:\n{result.stdout}\nstderr:\n{result.stderr}")


if __name__ == "__main__" and len(sys.argv) > 1 and sys.argv[1] == "--probe":
    _probe()
elif __name__ == "__main__":
    unittest.main()
