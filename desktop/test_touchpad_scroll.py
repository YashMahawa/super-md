"""Qt WheelHandler and real QtWebEngine routing tests for touchpad nested scroll, chaining, and note zoom."""
from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import time
import unittest
import uuid
from pathlib import Path

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
os.environ.setdefault("QT_QUICK_BACKEND", "software")

from PySide6.QtCore import QEvent, QPoint, QPointF, QUrl, Qt
from PySide6.QtGui import QGuiApplication, QPointingDevice, QWheelEvent
from PySide6.QtQml import QQmlComponent, QQmlEngine
from PySide6.QtQuick import QQuickWindow  # noqa: F401
from PySide6.QtTest import QTest

ROOT = Path(__file__).resolve().parent
QML_DIR = ROOT / "qml"
MAIN_QML = QML_DIR / "Main.qml"


def _production_wheel_overlay() -> str:
    source = MAIN_QML.read_text(encoding="utf-8")
    start = source.index('MouseArea {\n                        objectName: "readerWheelOverlay"')
    brace = source.index("{", start)
    depth = 0
    for end in range(brace, len(source)):
        if source[end] == "{":
            depth += 1
        elif source[end] == "}":
            depth -= 1
            if depth == 0:
                return source[start : end + 1]
    raise AssertionError("Could not extract readerWheelOverlay from Main.qml")


class TouchpadWheelHandlerTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.app = QGuiApplication.instance() or QGuiApplication(["touchpad wheel handler test"])

    def setUp(self):
        self.engine = QQmlEngine()
        wheel_overlay = _production_wheel_overlay()
        qml = f"""import QtQuick
Window {{
    id: host
    width: 640
    height: 480
    visible: true
    property var scripts: []
    property int fallthroughWheelCount: 0
    property int fallthroughClickCount: 0
    QtObject {{
        id: reader
        function runJavaScript(code) {{
            host.scripts = host.scripts.concat([code])
        }}
    }}
    Item {{
        objectName: "readerSurface"
        anchors.fill: parent
        MouseArea {{
            objectName: "chromiumDelegateStub"
            anchors.fill: parent
            z: 0
            acceptedButtons: Qt.AllButtons
            onClicked: host.fallthroughClickCount++
            onWheel: function(wheel) {{
                wheel.accepted = true
                host.fallthroughWheelCount++
            }}
        }}
        {wheel_overlay}
    }}
}}
"""
        self.component = QQmlComponent(self.engine)
        self.component.setData(qml.encode("utf-8"), QUrl.fromLocalFile(str(QML_DIR / "touchpad-wheel-smoke.qml")))
        self.assertFalse(self.component.isError(), "\n".join(e.toString() for e in self.component.errors()))
        self.window = self.component.create()
        self.assertIsNotNone(self.window)
        QTest.qWait(30)

    def tearDown(self):
        self.window.close()
        self.window.deleteLater()
        self.app.sendPostedEvents(None, QEvent.Type.DeferredDelete)
        self.engine.deleteLater()
        self.app.sendPostedEvents(None, QEvent.Type.DeferredDelete)

    def _send_wheel(
        self,
        pixel_delta: QPoint,
        angle_delta: QPoint,
        modifiers: Qt.KeyboardModifier = Qt.KeyboardModifier.NoModifier,
        buttons: Qt.MouseButton = Qt.MouseButton.NoButton,
        device_type: QPointingDevice.DeviceType = QPointingDevice.DeviceType.TouchPad,
    ) -> QWheelEvent:
        self._device = QPointingDevice(
            "test-device",
            1,
            device_type,
            QPointingDevice.PointerType.Generic,
            QPointingDevice.Capability.Position | QPointingDevice.Capability.PixelScroll | QPointingDevice.Capability.Scroll,
            2,
            0,
        )
        pos = QPointF(240.0, 180.0)
        event = QWheelEvent(
            pos,
            pos,
            pixel_delta,
            angle_delta,
            buttons,
            modifiers,
            Qt.ScrollPhase.ScrollUpdate,
            False,
            Qt.MouseEventSource.MouseEventSynthesizedBySystem,
            self._device,
        )
        QGuiApplication.sendEvent(self.window, event)
        return event

    def test_touchpad_pixel_deltas_route_to_native_wheel_without_cross_axis_angle_bleed(self):
        # Pure horizontal pixelDelta with non-zero vertical angleDelta jitter must keep dy == 0.
        ev = self._send_wheel(QPoint(-28, 0), QPoint(-336, -12))
        self.assertTrue(ev.isAccepted())
        self.assertEqual(self.window.property("fallthroughWheelCount"), 0)
        scripts = self.window.property("scripts").toVariant()
        self.assertEqual(len(scripts), 1)
        self.assertIn("window.supermdNativeWheel?.(28,0,", scripts[0])
        self.assertTrue(scripts[0].endswith(",false)"))

        # Diagonal touchpad scroll routes both negated pixel deltas and local point.
        ev2 = self._send_wheel(QPoint(12, -45), QPoint(144, -540))
        self.assertTrue(ev2.isAccepted())
        self.assertEqual(self.window.property("fallthroughWheelCount"), 0)
        scripts = self.window.property("scripts").toVariant()
        self.assertEqual(len(scripts), 2)
        self.assertIn("window.supermdNativeWheel?.(-12,45,", scripts[1])
        point_json = scripts[1].split(",", 2)[2].rsplit(",", 1)[0]
        self.assertEqual(json.loads(point_json), {"x": 240, "y": 180})

    def test_ctrl_modifier_routes_note_zoom_and_plain_mouse_notch_falls_through(self):
        # Ctrl + touchpad/wheel consumes before Chromium zoom and sets held=true, modifier=true.
        zoom_ev = self._send_wheel(
            QPoint(0, 36),
            QPoint(0, 120),
            modifiers=Qt.KeyboardModifier.ControlModifier,
        )
        self.assertTrue(zoom_ev.isAccepted())
        self.assertEqual(self.window.property("fallthroughWheelCount"), 0)
        scripts = self.window.property("scripts").toVariant()
        self.assertEqual(len(scripts), 1)
        self.assertIn("window.supermdNativeWheel?.(0,-36,", scripts[0])
        self.assertTrue(scripts[0].endswith(",true,true)"))

        # Unmodified mouse wheel notches without pixelDelta fall through to the z:0 Chromium delegate.
        self._send_wheel(
            QPoint(0, 0),
            QPoint(0, -120),
            device_type=QPointingDevice.DeviceType.Mouse,
        )
        self.assertEqual(self.window.property("fallthroughWheelCount"), 1)
        self.assertEqual(len(self.window.property("scripts").toVariant()), 1)

        # Left and right clicks pass straight through acceptedButtons: Qt.NoButton.
        QTest.mouseClick(self.window, Qt.MouseButton.LeftButton, Qt.KeyboardModifier.NoModifier, QPoint(240, 180))
        QTest.mouseClick(self.window, Qt.MouseButton.RightButton, Qt.KeyboardModifier.NoModifier, QPoint(240, 180))
        self.assertEqual(self.window.property("fallthroughClickCount"), 2)


def _webengine_probe(screenshot_dir: str | None = None) -> int:
    os.environ["QT_QPA_PLATFORM"] = "offscreen"
    os.environ["QT_QUICK_BACKEND"] = "software"
    os.environ.setdefault("QTWEBENGINE_DISABLE_SANDBOX", "1")
    os.environ.setdefault("QTWEBENGINE_CHROMIUM_FLAGS", "--disable-gpu --disable-dev-shm-usage")

    from PySide6.QtCore import QFile, QIODevice, QMetaObject, QObject, QPoint, QPointF, QUrl, Qt, Q_ARG
    from PySide6.QtGui import QGuiApplication, QPointingDevice, QWheelEvent
    from PySide6.QtQml import QQmlApplicationEngine
    from PySide6.QtQuickControls2 import QQuickStyle
    from PySide6.QtTest import QTest
    from PySide6.QtWebEngineCore import QWebEngineProfile
    from PySide6.QtWebEngineQuick import QtWebEngineQuick
    from PySide6.QtWidgets import QApplication

    sys.path.insert(0, str(ROOT))
    from reader_assets import READER_SCHEME, ReaderBundleSchemeHandler, reader_bundle_url, register_reader_schemes
    from studio import Session, Studio

    QQuickStyle.setStyle("Material")
    register_reader_schemes()
    QtWebEngineQuick.initialize()
    app = QApplication(["Super MD touchpad scroll QtWebEngine probe"])
    bundle_handler = ReaderBundleSchemeHandler(ROOT.parent / "dist", app)
    QWebEngineProfile.defaultProfile().installUrlSchemeHandler(READER_SCHEME.encode("ascii"), bundle_handler)

    deck = {
        "title": "Derivation Study Deck",
        "steps": [
            {
                "label": "Step 1: Inner Study Scroll",
                "diagram": {
                    "width": 220,
                    "height": 150,
                    "nodes": [
                        {"id": "s1", "label": "Touchpad", "x": 60, "y": 75},
                        {"id": "s2", "label": "Chain", "x": 165, "y": 75},
                    ],
                    "edges": [{"from": "s1", "to": "s2", "label": "dy"}],
                },
                "markdown": "\n".join(
                    f"- Study note item {i + 1}: nested scroll stays inside the study card until reaching its boundary."
                    for i in range(28)
                ),
            },
            {
                "label": "Step 2: Zoom Intact",
                "diagram": {"width": 220, "height": 150, "nodes": [{"id": "z", "label": "Zoom", "x": 110, "y": 75}], "edges": []},
                "markdown": "Ctrl+wheel and pinch still zoom the note cleanly.",
            },
        ],
    }
    compact_table = "| Metric | Value |\n| --- | --- |\n| alpha | 0.05 |\n| power | 0.92 |"
    headers = " | ".join(f"Series_{i + 1}_Header" for i in range(12))
    sep = " | ".join("---" for _ in range(12))
    row = " | ".join(f"value_{i + 1}_wide_entry" for i in range(12))
    wide_code = "const pipeline = " + " + ".join(f"stage_{i}_metric" for i in range(26)) + ";"
    py_lines = "\n".join(f"acc_{i} = {i} * 3  # {'wide_comment_' * 10}" for i in range(44))
    filler = ("\n\n".join(f"Filler paragraph {i + 1}: " + ("scrollable note body text " * 14) for i in range(24)))
    markdown = (
        f"# Qt Touchpad Nested Scroll\n\n"
        f"{compact_table}\n\n"
        f"| {headers} |\n| {sep} |\n| {row} |\n| {row} |\n\n"
        f"```ts\n{wide_code}\n```\n\n"
        f"```python {{.run}}\n{py_lines}\n```\n\n"
        f"```smd-steps\n{json.dumps(deck)}\n```\n\n"
        f"{filler}\n"
    )

    with tempfile.TemporaryDirectory(prefix="supermd-touchpad-qt-") as temp_dir:
        session = Session(True)
        session.settings["welcomed"] = True
        session.settings["python"] = sys.executable
        session.settings["newNoteLocation"] = temp_dir
        studio = Studio(True, session)
        tab = studio.tabs[0]
        tab["name"] = "Touchpad scroll.md"
        tab["content"] = markdown
        tab["saved"] = markdown
        studio.mode = "reader"
        studio.ready = True

        channel = QFile(":/qtwebchannel/qwebchannel.js")
        if not channel.open(QIODevice.OpenModeFlag.ReadOnly):
            raise RuntimeError("Qt WebChannel runtime unavailable")
        engine = QQmlApplicationEngine()
        engine.rootContext().setContextProperty("studio", studio)
        engine.rootContext().setContextProperty("readerUrl", reader_bundle_url())
        engine.rootContext().setContextProperty("channelScript", bytes(channel.readAll()).decode())
        engine.rootContext().setContextProperty("brandUrl", QUrl.fromLocalFile(str(ROOT.parent / "public" / "brand-mark-fixed.svg")))
        engine.load(QUrl.fromLocalFile(str(QML_DIR / "Main.qml")))
        if not engine.rootObjects():
            raise RuntimeError("Production Main.qml did not load")

        window = engine.rootObjects()[0]
        window.setProperty("width", 1220)
        window.setProperty("height", 1040)
        studio.host_window = window
        window.show()
        studio._emit()
        reader = window.findChild(QObject, "documentReader")
        if reader is None:
            raise RuntimeError("Production WebEngine reader was not found")

        touchpad = QPointingDevice(
            "qt-touchpad",
            2,
            QPointingDevice.DeviceType.TouchPad,
            QPointingDevice.PointerType.Generic,
            QPointingDevice.Capability.Position | QPointingDevice.Capability.PixelScroll | QPointingDevice.Capability.Scroll,
            2,
            0,
        )

        def run_script(script: str, timeout: float = 20) -> dict:
            deadline = time.monotonic() + timeout
            request = uuid.uuid4().hex
            wrapped = (
                "(()=>{try{"
                + script
                + ";document.title=JSON.stringify({request:"
                + json.dumps(request)
                + ",value:JSON.parse(document.title)})}catch(error){document.title=JSON.stringify({request:"
                + json.dumps(request)
                + ",error:String(error)})}})()"
            )
            last_pending = None
            while time.monotonic() < deadline:
                QMetaObject.invokeMethod(window, "runDocumentScript", Qt.ConnectionType.DirectConnection, Q_ARG("QVariant", wrapped))
                attempt_deadline = min(deadline, time.monotonic() + 0.5)
                while time.monotonic() < attempt_deadline:
                    app.processEvents()
                    QTest.qWait(10)
                    title = reader.property("title")
                    if not isinstance(title, str) or not title.startswith("{"):
                        continue
                    response = json.loads(title)
                    if response.get("request") != request:
                        continue
                    if response.get("error"):
                        raise AssertionError(response["error"])
                    value = response["value"]
                    if value.get("ready") is not False:
                        return value
                    last_pending = value
                    break
            raise AssertionError(
                f"WebEngine reader did not return probe result: last={last_pending!r} title={reader.property('title')!r}"
            )

        def send_touchpad(
            local_x: float,
            local_y: float,
            px_dx: int,
            px_dy: int,
            modifiers=Qt.KeyboardModifier.NoModifier,
            wait_steps: int = 2,
        ):
            scene_pt = reader.mapToScene(QPointF(local_x, local_y))
            ev = QWheelEvent(
                scene_pt,
                scene_pt,
                QPoint(px_dx, px_dy),
                QPoint(px_dx * 8, px_dy * 8),
                Qt.MouseButton.NoButton,
                modifiers,
                Qt.ScrollPhase.ScrollUpdate,
                False,
                Qt.MouseEventSource.MouseEventSynthesizedBySystem,
                touchpad,
            )
            QGuiApplication.sendEvent(window, ev)
            for _ in range(wait_steps):
                app.processEvents()
                QTest.qWait(10)

        def arm_and_scroll_target(
            target_expr: str,
            offset_x: float,
            offset_y: float,
            px_dx: int,
            px_dy: int,
            min_left: float = 0,
            min_top: float = 0,
            scroll_into_view: bool = False,
        ) -> dict:
            prep = run_script(
                f"(()=>{{const rd=document.querySelector('.android-reading'),compactTb=rd?.querySelectorAll('.markdown-body table')?.[0],"
                f"el=({target_expr});"
                f"if(!rd||!compactTb||!el){{document.title=JSON.stringify({{ready:false}});return;}}"
                f"if({json.dumps(scroll_into_view)})el.scrollIntoView({{block:'center'}});"
                f"window.__smdIndicatorProbe?.cleanup?.();"
                f"const state={{scrollEvents:0,activeOnScroll:false,compactActiveOnScroll:false}};"
                f"const onScroll=()=>{{if(el.scrollLeft<{min_left}||el.scrollTop<{min_top})return;"
                f"state.scrollEvents+=1;state.activeOnScroll=state.activeOnScroll||el.classList.contains('scroll-indicator-active');"
                f"state.compactActiveOnScroll=state.compactActiveOnScroll||compactTb.classList.contains('scroll-indicator-active');}};"
                f"el.addEventListener('scroll',onScroll);"
                f"window.__smdIndicatorProbe={{state,cleanup:()=>el.removeEventListener('scroll',onScroll)}};"
                f"const r=el.getBoundingClientRect();"
                f"document.title=JSON.stringify({{ready:true,x:r.left+{offset_x},y:r.top+{offset_y},"
                f"rdTopBefore:rd.scrollTop,rdLeftBefore:rd.scrollLeft,"
                f"maxTop:el.scrollHeight-el.clientHeight,maxLeft:el.scrollWidth-el.clientWidth}});}})()"
            )
            send_touchpad(prep["x"], prep["y"], px_dx, px_dy)
            observed = run_script(
                f"(()=>{{const rd=document.querySelector('.android-reading'),compactTb=rd?.querySelectorAll('.markdown-body table')?.[0],"
                f"el=({target_expr}),probe=window.__smdIndicatorProbe;"
                f"if(!rd||!compactTb||!el||el.scrollLeft<{min_left}||el.scrollTop<{min_top}||!(probe?.state?.scrollEvents>0))"
                f"{{document.title=JSON.stringify({{ready:false,left:el?.scrollLeft,top:el?.scrollTop,"
                f"scrollEvents:probe?.state?.scrollEvents??0,liveActive:el?.classList?.contains('scroll-indicator-active')??false}});return;}}"
                f"const liveActive=el.classList.contains('scroll-indicator-active');"
                f"const activeOnScroll=Boolean(probe?.state?.activeOnScroll);"
                f"const compactActive=compactTb.classList.contains('scroll-indicator-active')||Boolean(probe?.state?.compactActiveOnScroll);"
                f"probe?.cleanup?.();"
                f"document.title=JSON.stringify({{ready:true,left:el.scrollLeft,top:el.scrollTop,"
                f"liveActive,activeOnScroll,scrollEvents:probe?.state?.scrollEvents??0,compactActive,"
                f"rdTop:rd.scrollTop,rdLeft:rd.scrollLeft,rdTopBefore:{prep['rdTopBefore']}}});}})()"
            )
            observed["maxTop"] = prep["maxTop"]
            observed["x"] = prep["x"]
            observed["y"] = prep["y"]
            return observed

        def verify_mode_geometry_and_semantics(mode_label: str, width_ratio_cap: float) -> dict:
            info = run_script(
                "(()=>{const rd=document.querySelector('.android-reading'),tables=rd?.querySelectorAll('.markdown-body table'),"
                "pre=rd?.querySelector('.code-disclosure pre'),py=rd?.querySelector('.python-source');"
                "if(!rd||!tables||tables.length<2||!pre||!py){document.title=JSON.stringify({ready:false});return;}"
                "const c=tables[0],w=tables[1],cr=c.getBoundingClientRect(),br=c.closest('.markdown-body').getBoundingClientRect(),"
                "th=c.querySelector('thead tr th:last-child')?.getBoundingClientRect(),"
                "cs=getComputedStyle(c),ws=getComputedStyle(w);"
                "if(!th||w.scrollWidth-w.clientWidth<=80||pre.scrollWidth-pre.clientWidth<=80||py.scrollHeight<=py.clientHeight||py.scrollWidth<=py.clientWidth)"
                "{document.title=JSON.stringify({ready:false});return;}"
                "document.title=JSON.stringify({ready:true,"
                "semantics:{compactTag:c.tagName,wideTag:w.tagName,compactDisplay:cs.display,wideDisplay:ws.display,"
                "compactOverflowStyle:cs.overflowX,wideOverflowStyle:ws.overflowX,"
                "compactHeaders:c.querySelectorAll('thead th').length,compactRows:c.querySelectorAll('tbody tr').length,"
                "compactCells:c.querySelectorAll('tbody td').length,wideHeaders:w.querySelectorAll('thead th').length,"
                "wideRows:w.querySelectorAll('tbody tr').length},"
                "compact:{width:cr.width,bodyWidth:br.width,rightGap:Math.abs(cr.right-th.right),"
                "overflowX:c.scrollWidth-c.clientWidth,scrollbarH:c.offsetHeight-c.clientHeight},"
                "overflow:{wideLeft:w.scrollWidth-w.clientWidth,wideScrollbarH:w.offsetHeight-w.clientHeight,"
                "preLeft:pre.scrollWidth-pre.clientWidth,preScrollbarH:pre.offsetHeight-pre.clientHeight,"
                "pyLeft:py.scrollWidth-py.clientWidth,pyTop:py.scrollHeight-py.clientHeight,"
                "pyScrollbarW:py.offsetWidth-py.clientWidth,pyScrollbarH:py.offsetHeight-py.clientHeight}});})()"
            )
            sem = info["semantics"]
            if (
                sem["compactTag"] != "TABLE"
                or sem["wideTag"] != "TABLE"
                or sem["compactDisplay"] != "block"
                or sem["wideDisplay"] != "block"
                or sem["compactOverflowStyle"] != "auto"
                or sem["wideOverflowStyle"] != "auto"
                or sem["compactHeaders"] != 2
                or sem["compactRows"] != 2
                or sem["compactCells"] != 4
                or sem["wideHeaders"] != 12
                or sem["wideRows"] != 2
            ):
                raise AssertionError(f"Expected preserved native table semantics in {mode_label}: {sem}")
            comp = info["compact"]
            if (
                comp["width"] >= comp["bodyWidth"] * width_ratio_cap
                or comp["rightGap"] > 2
                or comp["overflowX"] > 1
                or comp["scrollbarH"] != 0
            ):
                raise AssertionError(f"Expected compact table shrink-wrap without empty width or gutter in {mode_label}: {comp}")
            ov = info["overflow"]
            if (
                ov["wideScrollbarH"] != 16
                or ov["preScrollbarH"] != 16
                or ov["pyScrollbarW"] != 16
                or ov["pyScrollbarH"] != 16
            ):
                raise AssertionError(f"Expected 16px native Qt scrollbar lanes on overflowing table/code regions in {mode_label}: {ov}")
            return info

        def verify_presented_frame(mode_label: str, screenshot_name: str | None = None) -> None:
            if screenshot_dir and screenshot_name:
                # Re-arm the three already-scrolled nested regions together right before grabbing so none of the
                # 650ms transient markers expires across sequential event-loop waits prior to screenshot capture.
                run_script(
                    "(()=>{const rd=document.querySelector('.android-reading'),tb=rd.querySelectorAll('.markdown-body table')[1],"
                    "pre=rd.querySelector('.code-disclosure pre'),py=rd.querySelector('.python-source');"
                    "rd.scrollTop=0;[tb,pre,py].forEach(el=>el.dispatchEvent(new Event('scroll')));"
                    "document.title=JSON.stringify({ready:tb.classList.contains('scroll-indicator-active')&&"
                    "pre.classList.contains('scroll-indicator-active')&&py.classList.contains('scroll-indicator-active')});})()"
                )
            for _ in range(3):
                app.processEvents()
                QTest.qWait(15)
            frame = window.grabWindow()
            if frame.isNull() or frame.width() < 1200 or frame.height() < 1000:
                raise AssertionError(f"Expected presented QtWebEngine frame in {mode_label}: {frame.width()}x{frame.height()}")
            if screenshot_dir and screenshot_name:
                out_dir = Path(screenshot_dir)
                out_dir.mkdir(parents=True, exist_ok=True)
                frame.save(str(out_dir / screenshot_name))

        run_script(
            "(()=>{const py=document.querySelector('.python-source'),tables=document.querySelectorAll('.markdown-body table'),"
            "st=document.querySelector('.step-cards-notes'),rd=document.querySelector('.android-reading');"
            "if(!py||tables.length<2||!st||!rd||py.scrollHeight<=py.clientHeight||tables[1].scrollWidth<=tables[1].clientWidth)"
            "{document.title=JSON.stringify({ready:false});return;}"
            "rd.scrollTop=0;document.title=JSON.stringify({ready:true});})()"
        )
        verify_mode_geometry_and_semantics("reader", 0.55)

        # 1. Read mode: observe .python-source movement + active indicator immediately after its own input, then chain at bottom.
        py_mid = arm_and_scroll_target(
            "document.querySelector('.python-source')",
            80,
            40,
            -60,
            -70,
            min_left=40,
            min_top=50,
        )
        if (
            py_mid["left"] < 40
            or py_mid["top"] < 50
            or not py_mid["liveActive"]
            or not py_mid["activeOnScroll"]
            or py_mid["compactActive"]
            or py_mid["rdTop"] != 0
        ):
            raise AssertionError(f"Expected inner python scroll + immediate active indicator without outer scroll: {py_mid}")

        send_touchpad(py_mid["x"], py_mid["y"], 0, -(int(py_mid["maxTop"]) + 180), wait_steps=4)
        py_chained = run_script(
            "(()=>{const py=document.querySelector('.python-source'),rd=document.querySelector('.android-reading');"
            "if(rd.scrollTop<100){document.title=JSON.stringify({ready:false});return;}"
            "document.title=JSON.stringify({ready:true,pyRem:Math.abs(py.scrollHeight-py.clientHeight-py.scrollTop),rdTop:rd.scrollTop});})()"
        )
        if py_chained["pyRem"] > 2 or py_chained["rdTop"] < 100:
            raise AssertionError(f"Expected python boundary chaining to .android-reading: {py_chained}")

        # 2. Read mode: observe fenced <pre> movement + active indicator + vertical chain immediately after its own input.
        pre_after = arm_and_scroll_target(
            "document.querySelector('.code-disclosure pre')",
            80,
            24,
            -115,
            -75,
            min_left=80,
            scroll_into_view=True,
        )
        if (
            pre_after["left"] < 80
            or not pre_after["liveActive"]
            or not pre_after["activeOnScroll"]
            or pre_after["compactActive"]
            or pre_after["rdTop"] <= pre_after["rdTopBefore"] + 45
            or pre_after["rdLeft"] != 0
        ):
            raise AssertionError(f"Expected fenced pre horizontal scroll + immediate active indicator + vertical chain: {pre_after}")

        # 3. Read mode: observe wide table movement + active indicator + vertical chain immediately after its own input.
        tb_after = arm_and_scroll_target(
            "document.querySelectorAll('.markdown-body table')[1]",
            80,
            30,
            -120,
            -90,
            min_left=90,
            scroll_into_view=True,
        )
        if (
            tb_after["left"] < 90
            or not tb_after["liveActive"]
            or not tb_after["activeOnScroll"]
            or tb_after["compactActive"]
            or tb_after["rdTop"] <= tb_after["rdTopBefore"] + 50
            or tb_after["rdLeft"] != 0
        ):
            raise AssertionError(f"Expected wide table horizontal scroll + immediate active indicator + vertical chain under centerLock: {tb_after}")

        if screenshot_dir:
            vis_pts = run_script(
                "(()=>{const rd=document.querySelector('.android-reading'),tb=document.querySelectorAll('.markdown-body table')[1],"
                "pre=document.querySelector('.code-disclosure pre'),py=document.querySelector('.python-source');"
                "rd.scrollTop=0;tb.scrollLeft=0;pre.scrollLeft=0;py.scrollTop=0;py.scrollLeft=0;"
                "const tr=tb.getBoundingClientRect(),cr=pre.getBoundingClientRect(),pr=py.getBoundingClientRect();"
                "document.title=JSON.stringify({ready:true,tx:tr.left+80,ty:tr.top+28,cx:cr.left+80,cy:cr.top+24,px:pr.left+80,py:pr.top+40});})()"
            )
            send_touchpad(vis_pts["tx"], vis_pts["ty"], -120, 0)
            send_touchpad(vis_pts["cx"], vis_pts["cy"], -120, 0)
            send_touchpad(vis_pts["px"], vis_pts["py"], -60, -70)
        verify_presented_frame("reader", "qt-reader-table-width-and-scroll-indicators.png")

        # 4. Study step-cards notes scroll internally first, then chain at boundary, and Ctrl+wheel zooms note without scrolling notes.
        st_geom = run_script(
            "(()=>{const st=document.querySelector('.step-cards-notes'),rd=document.querySelector('.android-reading');"
            "st.scrollIntoView({block:'center'});const sr=st.getBoundingClientRect();"
            "document.title=JSON.stringify({ready:true,x:sr.left+60,y:sr.top+60,maxTop:st.scrollHeight-st.clientHeight,rdTop:rd.scrollTop});})()"
        )
        send_touchpad(st_geom["x"], st_geom["y"], 0, -55, wait_steps=4)
        st_mid = run_script(
            "(()=>{const st=document.querySelector('.step-cards-notes'),rd=document.querySelector('.android-reading');"
            "if(st.scrollTop<35){document.title=JSON.stringify({ready:false});return;}"
            "document.title=JSON.stringify({ready:true,stTop:st.scrollTop,rdTop:rd.scrollTop});})()"
        )
        if st_mid["stTop"] < 35 or abs(st_mid["rdTop"] - st_geom["rdTop"]) > 2:
            raise AssertionError(f"Expected study notes interior scroll before chaining: {st_mid} vs {st_geom}")

        send_touchpad(st_geom["x"], st_geom["y"], 0, 120, modifiers=Qt.KeyboardModifier.ControlModifier, wait_steps=4)
        zoomed = run_script(
            "(()=>{const page=document.querySelector('.document-page'),st=document.querySelector('.step-cards-notes');"
            "if(Number(page.dataset.scale)<=1.15){document.title=JSON.stringify({ready:false});return;}"
            "document.title=JSON.stringify({ready:true,scale:Number(page.dataset.scale),stTop:st.scrollTop});})()"
        )
        if zoomed["scale"] <= 1.15 or abs(zoomed["stTop"] - st_mid["stTop"]) > 2:
            raise AssertionError(f"Expected Ctrl+touchpad over study region to zoom note without scrolling study notes: {zoomed}")

        # 5. Reset zoom and scroll anchor to top, then verify compact table shrink-wrap, semantics, and per-gesture
        # nested overflow indicators immediately after each target's own input in Live and Split modes.
        studio.setZoom(100)
        run_script(
            "(()=>{const rd=document.querySelector('.android-reading'),page=document.querySelector('.document-page');"
            "if(!rd||!page||Math.abs(Number(page.dataset.scale||1)-1)>0.05){document.title=JSON.stringify({ready:false});return;}"
            "rd.scrollTop=0;document.title=JSON.stringify({ready:true});})()"
        )
        for _ in range(4):
            app.processEvents()
            QTest.qWait(20)
        mode_results = {}
        for mode_name in ("live", "split"):
            studio.setMode(mode_name)
            for _ in range(10):
                app.processEvents()
                QTest.qWait(25)
            # Wait until the target mode DOM is mounted, then pin scrollTop=0 after anchor restoration settles.
            run_script(
                f"(()=>{{const rd=document.querySelector('.android-reading'),tables=rd?.querySelectorAll('.markdown-body table'),"
                f"pre=rd?.querySelector('.code-disclosure pre'),py=rd?.querySelector('.python-source'),needCm={json.dumps(mode_name == 'split')},"
                f"needLive={json.dumps(mode_name == 'live')};"
                f"if(!rd||!tables||tables.length<2||!pre||!py||(needCm&&!document.querySelector('.cm-scroller'))||(needLive&&!rd.querySelector('.live-document'))||tables[1].scrollWidth-tables[1].clientWidth<=80||pre.scrollWidth-pre.clientWidth<=80||py.scrollHeight<=py.clientHeight)"
                f"{{document.title=JSON.stringify({{ready:false}});return;}}"
                f"rd.scrollTop=0;tables[1].scrollLeft=0;pre.scrollLeft=0;py.scrollTop=0;py.scrollLeft=0;"
                f"document.title=JSON.stringify({{ready:true}});}})()"
            )
            for _ in range(4):
                app.processEvents()
                QTest.qWait(20)
            run_script("(()=>{const rd=document.querySelector('.android-reading');rd.scrollTop=0;document.title=JSON.stringify({ready:true});})()")
            verify_mode_geometry_and_semantics(mode_name, 0.6)

            mode_tb = arm_and_scroll_target(
                "document.querySelector('.android-reading').querySelectorAll('.markdown-body table')[1]",
                60,
                26,
                -110,
                0,
                min_left=70,
            )
            if mode_tb["left"] < 70 or not mode_tb["liveActive"] or not mode_tb["activeOnScroll"] or mode_tb["compactActive"]:
                raise AssertionError(f"Expected wide table scroll + immediate active indicator in {mode_name}: {mode_tb}")

            mode_pre = arm_and_scroll_target(
                "document.querySelector('.android-reading .code-disclosure pre')",
                60,
                24,
                -110,
                0,
                min_left=70,
            )
            if mode_pre["left"] < 70 or not mode_pre["liveActive"] or not mode_pre["activeOnScroll"] or mode_pre["compactActive"]:
                raise AssertionError(f"Expected fenced pre scroll + immediate active indicator in {mode_name}: {mode_pre}")

            mode_py = arm_and_scroll_target(
                "document.querySelector('.android-reading .python-source')",
                60,
                36,
                -55,
                -65,
                min_left=35,
                min_top=40,
            )
            if (
                mode_py["left"] < 35
                or mode_py["top"] < 40
                or not mode_py["liveActive"]
                or not mode_py["activeOnScroll"]
                or mode_py["compactActive"]
            ):
                raise AssertionError(f"Expected python source scroll + immediate active indicator in {mode_name}: {mode_py}")

            verify_presented_frame(mode_name, f"qt-{mode_name}-table-width-and-scroll-indicators.png")
            mode_results[mode_name] = {
                "tbLeft": mode_tb["left"],
                "tbLiveActive": mode_tb["liveActive"],
                "tbActiveOnScroll": mode_tb["activeOnScroll"],
                "preLeft": mode_pre["left"],
                "preLiveActive": mode_pre["liveActive"],
                "preActiveOnScroll": mode_pre["activeOnScroll"],
                "pyLeft": mode_py["left"],
                "pyTop": mode_py["top"],
                "pyLiveActive": mode_py["liveActive"],
                "pyActiveOnScroll": mode_py["activeOnScroll"],
                "compactActive": mode_tb["compactActive"] or mode_pre["compactActive"] or mode_py["compactActive"],
            }

        print(
            json.dumps(
                {
                    "ok": True,
                    "pyMid": py_mid,
                    "preAfter": pre_after,
                    "tbAfter": tb_after,
                    "zoomScale": zoomed["scale"],
                    "modes": mode_results,
                }
            ),
            flush=True,
        )
        window.close()
        del engine
        studio.stop()
        studio.pool.shutdown(wait=False, cancel_futures=True)
        session.writes.shutdown(wait=False)
    os._exit(0)


class TouchpadScrollQtWebEngineTest(unittest.TestCase):
    def test_real_webengine_touchpad_routes_code_table_study_and_preserves_zoom(self) -> None:
        if "--probe" in sys.argv:
            raise unittest.SkipTest("probe subprocess only")
        if not (ROOT.parent / "dist" / "qt-reader.html").is_file():
            raise unittest.SkipTest("dist/qt-reader.html not built")
        env = dict(os.environ, QT_QPA_PLATFORM="offscreen", QT_QUICK_BACKEND="software")
        completed = subprocess.run(
            [sys.executable, str(Path(__file__).resolve()), "--probe"],
            cwd=ROOT,
            env=env,
            text=True,
            encoding="utf-8",
            errors="strict",
            capture_output=True,
            timeout=60,
        )
        self.assertEqual(completed.returncode, 0, f"{completed.stdout}{completed.stderr}")
        result = json.loads(completed.stdout.strip().splitlines()[-1])
        self.assertTrue(result.get("ok"), result)
        self.assertGreaterEqual(result["tbAfter"]["left"], 90, result)
        self.assertTrue(result["tbAfter"]["liveActive"] and result["tbAfter"]["activeOnScroll"], result)
        self.assertFalse(result["tbAfter"]["compactActive"], result)
        self.assertGreaterEqual(result["preAfter"]["left"], 80, result)
        self.assertTrue(result["preAfter"]["liveActive"] and result["preAfter"]["activeOnScroll"], result)
        self.assertFalse(result["preAfter"]["compactActive"], result)
        self.assertGreaterEqual(result["pyMid"]["left"], 40, result)
        self.assertGreaterEqual(result["pyMid"]["top"], 50, result)
        self.assertTrue(result["pyMid"]["liveActive"] and result["pyMid"]["activeOnScroll"], result)
        self.assertFalse(result["pyMid"]["compactActive"], result)
        self.assertGreater(result["zoomScale"], 1.15, result)
        for mode_name in ("live", "split"):
            mode_data = result["modes"][mode_name]
            self.assertGreaterEqual(mode_data["tbLeft"], 70, (mode_name, mode_data))
            self.assertTrue(mode_data["tbLiveActive"] and mode_data["tbActiveOnScroll"], (mode_name, mode_data))
            self.assertGreaterEqual(mode_data["preLeft"], 70, (mode_name, mode_data))
            self.assertTrue(mode_data["preLiveActive"] and mode_data["preActiveOnScroll"], (mode_name, mode_data))
            self.assertGreaterEqual(mode_data["pyLeft"], 35, (mode_name, mode_data))
            self.assertGreaterEqual(mode_data["pyTop"], 40, (mode_name, mode_data))
            self.assertTrue(mode_data["pyLiveActive"] and mode_data["pyActiveOnScroll"], (mode_name, mode_data))
            self.assertFalse(mode_data["compactActive"], (mode_name, mode_data))


if __name__ == "__main__" and "--probe" in sys.argv:
    shot_dir = sys.argv[sys.argv.index("--screenshots") + 1] if "--screenshots" in sys.argv else None
    raise SystemExit(_webengine_probe(shot_dir))
if __name__ == "__main__":
    unittest.main()
