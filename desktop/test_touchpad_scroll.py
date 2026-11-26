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
    headers = " | ".join(f"Series_{i + 1}_Header" for i in range(12))
    sep = " | ".join("---" for _ in range(12))
    row = " | ".join(f"value_{i + 1}_wide_entry" for i in range(12))
    py_lines = "\n".join(f"acc_{i} = {i} * 3  # {'wide_comment_' * 10}" for i in range(44))
    filler = ("\n\n".join(f"Filler paragraph {i + 1}: " + ("scrollable note body text " * 14) for i in range(24)))
    markdown = (
        f"# Qt Touchpad Nested Scroll\n\n"
        f"```python {{.run}}\n{py_lines}\n```\n\n"
        f"| {headers} |\n| {sep} |\n| {row} |\n| {row} |\n\n"
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
        window.setProperty("width", 1120)
        window.setProperty("height", 760)
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
                    break
            raise AssertionError(f"WebEngine reader did not return probe result: title={reader.property('title')!r}")

        def send_touchpad(local_x: float, local_y: float, px_dx: int, px_dy: int, modifiers=Qt.KeyboardModifier.NoModifier):
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
            for _ in range(6):
                app.processEvents()
                QTest.qWait(15)

        geom = run_script(
            "(()=>{const py=document.querySelector('.python-source'),tb=document.querySelector('.markdown-body table'),"
            "st=document.querySelector('.step-cards-notes'),rd=document.querySelector('.android-reading');"
            "if(!py||!tb||!st||!rd||py.scrollHeight<=py.clientHeight||tb.scrollWidth<=tb.clientWidth){document.title=JSON.stringify({ready:false});return;}"
            "const pr=py.getBoundingClientRect();"
            "document.title=JSON.stringify({ready:true,py:{x:pr.left+80,y:pr.top+60,maxTop:py.scrollHeight-py.clientHeight}});})()"
        )

        # 1. Touchpad scroll inside .python-source scrolls inner code without moving outer .android-reading, then chains at bottom.
        send_touchpad(geom["py"]["x"], geom["py"]["y"], -60, -70)
        py_mid = run_script(
            "(()=>{const py=document.querySelector('.python-source'),rd=document.querySelector('.android-reading');"
            "document.title=JSON.stringify({ready:true,pyLeft:py.scrollLeft,pyTop:py.scrollTop,rdTop:rd.scrollTop});})()"
        )
        if py_mid["pyLeft"] < 40 or py_mid["pyTop"] < 50 or py_mid["rdTop"] != 0:
            raise AssertionError(f"Expected inner python scroll without outer scroll: {py_mid}")

        send_touchpad(geom["py"]["x"], geom["py"]["y"], 0, -(int(geom["py"]["maxTop"]) + 180))
        py_chained = run_script(
            "(()=>{const py=document.querySelector('.python-source'),rd=document.querySelector('.android-reading');"
            "document.title=JSON.stringify({ready:true,pyRem:Math.abs(py.scrollHeight-py.clientHeight-py.scrollTop),rdTop:rd.scrollTop});})()"
        )
        if py_chained["pyRem"] > 2 or py_chained["rdTop"] < 100:
            raise AssertionError(f"Expected python boundary chaining to .android-reading: {py_chained}")

        # 2. Diagonal touchpad scroll over wide table scrolls table horizontally and chains vertical delta to .android-reading.
        tb_geom = run_script(
            "(()=>{const tb=document.querySelector('.markdown-body table'),rd=document.querySelector('.android-reading');"
            "tb.scrollIntoView({block:'center'});const tr=tb.getBoundingClientRect();"
            "document.title=JSON.stringify({ready:true,x:tr.left+80,y:tr.top+30,rdTop:rd.scrollTop});})()"
        )
        send_touchpad(tb_geom["x"], tb_geom["y"], -120, -90)
        tb_after = run_script(
            "(()=>{const tb=document.querySelector('.markdown-body table'),rd=document.querySelector('.android-reading');"
            "document.title=JSON.stringify({ready:true,tbLeft:tb.scrollLeft,rdTop:rd.scrollTop,rdLeft:rd.scrollLeft});})()"
        )
        if tb_after["tbLeft"] < 90 or tb_after["rdTop"] <= tb_geom["rdTop"] + 50 or tb_after["rdLeft"] != 0:
            raise AssertionError(f"Expected wide table horizontal scroll + vertical chain under centerLock: {tb_after}")

        if screenshot_dir:
            out_dir = Path(screenshot_dir)
            out_dir.mkdir(parents=True, exist_ok=True)
            for _ in range(6):
                app.processEvents()
                QTest.qWait(20)
            window.grabWindow().save(str(out_dir / "qt-touchpad-code-table-scroll.png"))

        # 3. Study step-cards notes scroll internally first, then chain at boundary, and Ctrl+wheel zooms note without scrolling notes.
        st_geom = run_script(
            "(()=>{const st=document.querySelector('.step-cards-notes'),rd=document.querySelector('.android-reading');"
            "st.scrollIntoView({block:'center'});const sr=st.getBoundingClientRect();"
            "document.title=JSON.stringify({ready:true,x:sr.left+60,y:sr.top+60,maxTop:st.scrollHeight-st.clientHeight,rdTop:rd.scrollTop});})()"
        )
        send_touchpad(st_geom["x"], st_geom["y"], 0, -55)
        st_mid = run_script(
            "(()=>{const st=document.querySelector('.step-cards-notes'),rd=document.querySelector('.android-reading');"
            "document.title=JSON.stringify({ready:true,stTop:st.scrollTop,rdTop:rd.scrollTop});})()"
        )
        if st_mid["stTop"] < 35 or abs(st_mid["rdTop"] - st_geom["rdTop"]) > 2:
            raise AssertionError(f"Expected study notes interior scroll before chaining: {st_mid} vs {st_geom}")

        send_touchpad(st_geom["x"], st_geom["y"], 0, 120, modifiers=Qt.KeyboardModifier.ControlModifier)
        zoomed = run_script(
            "(()=>{const page=document.querySelector('.document-page'),st=document.querySelector('.step-cards-notes');"
            "document.title=JSON.stringify({ready:true,scale:Number(page.dataset.scale),stTop:st.scrollTop});})()"
        )
        if zoomed["scale"] <= 1.15 or abs(zoomed["stTop"] - st_mid["stTop"]) > 2:
            raise AssertionError(f"Expected Ctrl+touchpad over study region to zoom note without scrolling study notes: {zoomed}")

        if screenshot_dir:
            for _ in range(6):
                app.processEvents()
                QTest.qWait(20)
            window.grabWindow().save(str( Path(screenshot_dir) / "qt-touchpad-study-and-zoom.png"))

        print(json.dumps({"ok": True, "pyMid": py_mid, "tbAfter": tb_after, "zoomScale": zoomed["scale"]}), flush=True)
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


if __name__ == "__main__" and "--probe" in sys.argv:
    shot_dir = sys.argv[sys.argv.index("--screenshots") + 1] if "--screenshots" in sys.argv else None
    raise SystemExit(_webengine_probe(shot_dir))
if __name__ == "__main__":
    unittest.main()
