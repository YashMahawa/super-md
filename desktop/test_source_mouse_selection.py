"""Real Qt input regression for CodeMirror selection in the source view."""
from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import unittest
import uuid
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parent
NOTE_TEXT = "Continuous mouse selection probe"


def _probe(mode: str, zoom: float = 95.59963715447921, fullscreen: bool = False) -> int:
    os.environ["QT_QPA_PLATFORM"] = "offscreen"
    os.environ["QT_QUICK_BACKEND"] = "software"
    os.environ.setdefault("QTWEBENGINE_DISABLE_SANDBOX", "1")
    os.environ.setdefault("QTWEBENGINE_CHROMIUM_FLAGS", "--disable-gpu --disable-dev-shm-usage")

    from PySide6.QtCore import QFile, QIODevice, QMetaObject, QObject, QPoint, QPointF, QUrl, Qt, Q_ARG
    from PySide6.QtQml import QQmlApplicationEngine
    from PySide6.QtQuickControls2 import QQuickStyle
    from PySide6.QtTest import QTest
    from PySide6.QtWebEngineQuick import QtWebEngineQuick
    from PySide6.QtWidgets import QApplication

    QQuickStyle.setStyle("Material")
    QtWebEngineQuick.initialize()
    app = QApplication(["Super MD source mouse selection test"])

    sys.path.insert(0, str(ROOT))
    from reader_gestures import ReaderGestures
    from studio import Session, Studio

    with tempfile.TemporaryDirectory(prefix="supermd-source-selection-") as temp_dir:
        target_text = NOTE_TEXT
        content = "# Mouse selection probe\n" + target_text + "\nSecond line after the selection.\n"
        session = Session(True)
        session.settings["welcomed"] = True
        session.settings["newNoteLocation"] = temp_dir
        studio = Studio(True, session)
        studio.settings["normalZoom"] = zoom
        studio.settings["fullZoom"] = zoom
        tab = studio.tabs[0]
        tab["name"] = "Mouse selection probe.md"
        tab["content"] = content
        tab["saved"] = tab["content"]
        studio.mode = mode
        # The test is about the native mouse path after the source view is ready;
        # the production app sets this through the reader-ready handshake.
        studio.ready = True

        channel = QFile(":/qtwebchannel/qwebchannel.js")
        if not channel.open(QIODevice.OpenModeFlag.ReadOnly):
            raise RuntimeError("Qt WebChannel runtime unavailable")
        engine = QQmlApplicationEngine()
        engine.rootContext().setContextProperty("studio", studio)
        engine.rootContext().setContextProperty("readerUrl", QUrl.fromLocalFile(str(ROOT.parent / "dist" / "qt-reader.html")))
        engine.rootContext().setContextProperty("channelScript", bytes(channel.readAll()).decode())
        engine.rootContext().setContextProperty("brandUrl", QUrl.fromLocalFile(str(ROOT.parent / "public" / "brand-mark-fixed.svg")))
        engine.load(QUrl.fromLocalFile(str(ROOT / "qml" / "Main.qml")))
        if not engine.rootObjects():
            raise RuntimeError("Production Main.qml did not load")

        window = engine.rootObjects()[0]
        studio.host_window = window
        if fullscreen:
            window.showFullScreen()
        else:
            window.show()
        studio._emit()
        reader = window.findChild(QObject, "documentReader")
        if reader is None:
            raise RuntimeError("Production WebEngine reader was not found")
        gestures = ReaderGestures(window, reader, lambda _script: None)

        def run_script(script: str, timeout: float = 20) -> dict:
            deadline = __import__("time").monotonic() + timeout
            request = uuid.uuid4().hex
            wrapped = "(()=>{try{" + script + ";document.title=JSON.stringify({request:" + json.dumps(request) + ",value:JSON.parse(document.title)})}catch(error){document.title=JSON.stringify({request:" + json.dumps(request) + ",error:String(error)})}})()"
            while __import__("time").monotonic() < deadline:
                # WebEngine dispatch is asynchronous. A slower renderer may
                # still expose the prior geometry/result in its title; never
                # mistake that for this request's acknowledged response.
                QMetaObject.invokeMethod(window, "runDocumentScript", Qt.ConnectionType.DirectConnection, Q_ARG("QVariant", wrapped))
                # Evaluations sent before the initial document exists may be
                # dropped. Retry this same request without accepting an older
                # query's reply or flooding the renderer with queued scripts.
                attempt_deadline = min(deadline, __import__("time").monotonic() + .5)
                while __import__("time").monotonic() < attempt_deadline:
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
            raise AssertionError(f"The production WebEngine reader did not return the probe result: title={reader.property('title')!r}")

        geometry_script = "(()=>{document.title=JSON.stringify({ready:false});const phrase=" + json.dumps(target_text) + ";const visible=el=>{const r=el.getBoundingClientRect(),s=getComputedStyle(el);return r.width>10&&r.height>8&&s.display!=='none'&&s.visibility!=='hidden'&&s.opacity!=='0'};const makeRange=root=>{const w=document.createTreeWalker(root,NodeFilter.SHOW_TEXT),nodes=[];let joined='',n;while(n=w.nextNode()){nodes.push({node:n,start:joined.length});joined+=n.nodeValue}const at=joined.indexOf(phrase);if(at<0)return null;const point=offset=>{const item=nodes.find(x=>offset>=x.start&&offset<=x.start+x.node.nodeValue.length);return item?[item.node,offset-item.start]:null};const a=point(at),b=point(at+phrase.length);if(!a||!b)return null;const r=document.createRange();r.setStart(a[0],a[1]);r.setEnd(b[0],b[1]);return r};let range=null;const line=[...document.querySelectorAll('.cm-line')].find(x=>x.textContent.includes(phrase)&&visible(x));if(line)range=makeRange(line);if(!range){const body=document.body;if(!body)return 'waiting';const w=document.createTreeWalker(body,NodeFilter.SHOW_TEXT);let n;while(n=w.nextNode()){const at=n.nodeValue.indexOf(phrase);if(at<0)continue;const r=document.createRange();r.setStart(n,at);r.setEnd(n,at+phrase.length);const b=r.getBoundingClientRect();if(b.width>10&&b.height>8){range=r;break}}}if(!range){document.title=JSON.stringify({ready:false});return 'waiting'}const rs=[...range.getClientRects()].filter(r=>r.width>1&&r.height>1);if(!rs.length||document.fonts.status!=='loaded'){document.title=JSON.stringify({ready:false});return 'waiting'}document.title=JSON.stringify({ready:true,first:{x:rs[0].x,y:rs[0].y,w:rs[0].width,h:rs[0].height},last:{x:rs[rs.length-1].x,y:rs[rs.length-1].y,w:rs[rs.length-1].width,h:rs[rs.length-1].height}});return 'ready'})()"

        def drag(mode: str, reverse: bool = False) -> dict:
            geometry = run_script(geometry_script)
            if "first" not in geometry:
                raise AssertionError(f"Source selection geometry unavailable in {mode}: {geometry}")
            reader_origin = reader.mapToGlobal(QPointF(0, 0))
            reader_left = window.mapFromGlobal(QPoint(round(reader_origin.x()), round(reader_origin.y())))
            # Each direction is a fresh selection. Starting the reverse drag
            # inside the previous highlight can invoke native text drag/drop,
            # which deliberately moves text rather than starting a new range.
            QTest.mouseClick(window, Qt.MouseButton.LeftButton, Qt.KeyboardModifier.NoModifier,
                             QPoint(round(reader_left.x() + geometry["first"]["x"] + 1),
                                    round(reader_left.y() + geometry["first"]["y"] - 30)), delay=80)
            geometry = run_script(geometry_script)
            left = QPoint(round(reader_left.x() + geometry["first"]["x"] + 1), round(reader_left.y() + geometry["first"]["y"] + geometry["first"]["h"] / 2))
            right = QPoint(round(reader_left.x() + geometry["last"]["x"] + geometry["last"]["w"] - 1), round(reader_left.y() + geometry["last"]["y"] + geometry["last"]["h"] / 2))
            start, end = (right, left) if reverse else (left, right)
            QTest.mousePress(window, Qt.MouseButton.LeftButton, Qt.KeyboardModifier.NoModifier, start, delay=80)
            distance = end.x() - start.x()
            steps = max(2, min(32, abs(distance) // 12))
            for step in range(1, steps + 1):
                point = QPoint(round(start.x() + distance * step / steps), round(start.y() + (end.y() - start.y()) * step / steps))
                QTest.mouseMove(window, point, delay=20)
            QTest.mouseRelease(window, Qt.MouseButton.LeftButton, Qt.KeyboardModifier.NoModifier, end, delay=80)
            QTest.qWait(120)
            result_script = "document.title=JSON.stringify({selection:window.getSelection()?.toString(),status:document.querySelector('.source-editor-status')?.textContent||''})"
            return run_script(result_script)

        def held_drag(start: QPoint, end: QPoint, *, hold_ms: int = 0, step_ms: int = 20) -> None:
            QTest.mousePress(window, Qt.MouseButton.LeftButton, Qt.KeyboardModifier.NoModifier, start, delay=80)
            if hold_ms:
                QTest.qWait(hold_ms)
            dx, dy = end.x() - start.x(), end.y() - start.y()
            steps = max(2, min(32, abs(dx) // 12))
            for step in range(1, steps + 1):
                point = QPoint(round(start.x() + dx * step / steps), round(start.y() + dy * step / steps))
                QTest.mouseMove(window, point, delay=step_ms)
            QTest.mouseRelease(window, Qt.MouseButton.LeftButton, Qt.KeyboardModifier.NoModifier, end, delay=80)
            QTest.qWait(120)

        forward = drag(mode, False)
        reverse = drag(mode, True)
        for direction, result in (("forward", forward), ("reverse", reverse)):
            if result.get("selection") != target_text:
                raise AssertionError(f"Qt mouse drag did not select all {len(target_text)} target characters in {mode} {direction}: {result}")

        # Exercise the path that differs from a clean drag: first create a
        # short selection, then start another held drag inside that selection.
        selection_result_script = "document.title=JSON.stringify({selection:window.getSelection()?.toString(),status:document.querySelector('.source-editor-status')?.textContent||''})"
        geometry = run_script(geometry_script)
        origin = reader.mapToGlobal(QPointF(0, 0))
        reader_left = window.mapFromGlobal(QPoint(round(origin.x()), round(origin.y())))
        base_left = round(reader_left.x() + geometry["first"]["x"] + 1)
        base_right = round(reader_left.x() + geometry["last"]["x"] + geometry["last"]["w"] - 1)
        base_y = round(reader_left.y() + geometry["first"]["y"] + geometry["first"]["h"] / 2)
        # Clear the whole-line selection on an unselected heading line first.
        QTest.mouseClick(window, Qt.MouseButton.LeftButton, Qt.KeyboardModifier.NoModifier,
                         QPoint(base_left, base_y - 30), delay=80)
        partial_end = QPoint(base_left + max(8, round((base_right - base_left) * 2.2 / len(target_text))), base_y)
        held_drag(QPoint(base_left, base_y), partial_end)
        partial = run_script(selection_result_script)
        pixel_delta = None
        selected_pixel = unselected_pixel = None
        if mode in ("editor", "split"):
            pixel_geometry = run_script("document.title=JSON.stringify((()=>{const s=window.getSelection(),r=s?.rangeCount?s.getRangeAt(0):null,line=document.querySelector('.cm-activeLine');if(!r||!line)return {selection:s?.toString()||'',ready:false};const a=r.getBoundingClientRect(),b=line.getBoundingClientRect();return {selection:s.toString(),ready:true,selected:{x:a.x,y:a.y,w:a.width,h:a.height},active:{x:b.x,y:b.y,w:b.width,h:b.height}}})())")
            frame = window.grabWindow()
            if frame.isNull():
                raise AssertionError(f"Could not capture native source selection pixels in {mode}")
            if not pixel_geometry.get("ready") or pixel_geometry.get("selection") != partial.get("selection"):
                raise AssertionError(f"Source selection pixel geometry is unavailable in {mode}: {pixel_geometry}; selection={partial}")
            selected_rect, active_rect = pixel_geometry["selected"], pixel_geometry["active"]
            reader_origin = reader.mapToGlobal(QPointF(0, 0))
            reader_left = window.mapFromGlobal(QPoint(round(reader_origin.x()), round(reader_origin.y())))
            ratio = frame.devicePixelRatio()
            # Compare dominant colors over the selection and an empty region
            # on the same active line. Opaque .cm-activeLine used to cover the
            # selection rectangle and make these background colors identical.
            def frame_rect(x: float, y: float, width: float, height: float) -> tuple[int, int, int, int]:
                return (round((reader_left.x() + x) * ratio), round((reader_left.y() + y) * ratio),
                        round(width * ratio), round(height * ratio))

            def dominant(rect: tuple[int, int, int, int]) -> str:
                x, y, width, height = rect
                pixels = [frame.pixelColor(px, py).name()
                          for px in range(max(0, x), min(frame.width(), x + width))
                          for py in range(max(0, y), min(frame.height(), y + height))]
                if not pixels:
                    raise AssertionError(f"Selection color sample is outside the native frame in {mode}: {rect}, {frame.width()}x{frame.height()}")
                return Counter(pixels).most_common(1)[0][0]

            selected_box = frame_rect(selected_rect["x"], active_rect["y"],
                                      selected_rect["w"], active_rect["h"])
            empty_width = min(32, active_rect["w"] - selected_rect["x"] - selected_rect["w"] - 8)
            if empty_width < 8:
                raise AssertionError(f"Active line has no empty comparison area in {mode}: {pixel_geometry}")
            empty_box = frame_rect(active_rect["x"] + active_rect["w"] - empty_width - 4,
                                   active_rect["y"], empty_width, active_rect["h"])
            selected_pixel = dominant(selected_box)
            unselected_pixel = dominant(empty_box)
            selected_rgb = tuple(int(selected_pixel[i:i + 2], 16) for i in (1, 3, 5))
            unselected_rgb = tuple(int(unselected_pixel[i:i + 2], 16) for i in (1, 3, 5))
            pixel_delta = max(abs(a - b) for a, b in zip(selected_rgb, unselected_rgb))
            if pixel_delta < 5:
                raise AssertionError(f"Partial source selection is not visibly distinct from the active-line fill in {mode}: selected={selected_pixel}, unselected={unselected_pixel}, delta={pixel_delta}, geometry={pixel_geometry}")
        held_drag(QPoint(base_left + 2, base_y), QPoint(base_right, base_y))
        selected_drag = run_script(selection_result_script)

        # A longer native-style gesture: hold still, then move for >1 second.
        QTest.mouseClick(window, Qt.MouseButton.LeftButton, Qt.KeyboardModifier.NoModifier,
                         QPoint(base_left, base_y - 30), delay=80)
        held_drag(QPoint(base_left, base_y), QPoint(base_right, base_y), hold_ms=1200, step_ms=45)
        long_drag = run_script(selection_result_script)
        if long_drag.get("selection") != target_text:
            raise AssertionError(f"Long-held native drag failed in {mode}: {long_drag}")

        # Release beyond the WebEngine viewport, then begin a fresh selection.
        viewport_origin = reader.mapToGlobal(QPointF(0, 0))
        viewport_exit = QPoint(min(window.width() - 8, base_right + 24),
                               window.mapFromGlobal(QPoint(round(viewport_origin.x()), round(viewport_origin.y()))).y() - 8)
        QTest.mousePress(window, Qt.MouseButton.LeftButton, Qt.KeyboardModifier.NoModifier,
                         QPoint(base_left, base_y), delay=80)
        QTest.mouseMove(window, viewport_exit, delay=120)
        QTest.mouseRelease(window, Qt.MouseButton.LeftButton, Qt.KeyboardModifier.NoModifier,
                           viewport_exit, delay=80)
        QTest.qWait(120)
        QTest.mouseClick(window, Qt.MouseButton.LeftButton, Qt.KeyboardModifier.NoModifier,
                         QPoint(base_left, base_y - 30), delay=80)
        held_drag(QPoint(base_left, base_y), QPoint(base_right, base_y))
        after_outside_release = run_script(selection_result_script)
        if after_outside_release.get("selection") != target_text:
            raise AssertionError(f"A drag released outside the reader blocked the next selection in {mode}: {after_outside_release}")
        print(json.dumps({"probe": "preselected-drag", "mode": mode,
                          "partialLength": len(partial.get("selection", "")),
                          "afterStartInsideSelectionLength": len(selected_drag.get("selection", "")),
                          "afterLongHeldDragLength": len(long_drag.get("selection", "")),
                          "afterOutsideReleaseLength": len(after_outside_release.get("selection", "")),
                          "partialSelectionPixelDelta": pixel_delta,
                          "partialSelectedPixel": selected_pixel,
                          "activeLinePixel": unselected_pixel,
                          "partialStatus": partial.get("status"),
                          "afterStatus": selected_drag.get("status"),
                          "longStatus": long_drag.get("status"),
                          "outsideStatus": after_outside_release.get("status")}))

        keyboard = None
        if mode == "editor":
            QTest.keyClick(window, Qt.Key.Key_Left)
            QTest.keyClick(window, Qt.Key.Key_Right, Qt.KeyboardModifier.ShiftModifier)
            QTest.keyClick(window, Qt.Key.Key_Right, Qt.KeyboardModifier.ShiftModifier)
            keyboard = run_script("document.title=JSON.stringify({status:document.querySelector('.source-editor-status')?.textContent||''})")
            if "2 selected" not in keyboard.get("status", ""):
                raise AssertionError(f"Shift+arrow selection changed in source view: {keyboard}")

        print(json.dumps({"ok": True, "mode": mode, "targetLength": len(target_text),
                          "forwardStatus": forward["status"], "reverseStatus": reverse["status"],
                          "keyboard": keyboard["status"] if keyboard else None}))
        window.close()
        studio.stop()
        studio.pool.shutdown(wait=False, cancel_futures=True)
        session.writes.shutdown(wait=False)
        del gestures
    return 0


class SourceMouseSelectionTest(unittest.TestCase):
    def test_production_qml_accepts_native_mouse_drag_in_both_directions(self) -> None:
        if "--probe" in sys.argv:
            raise unittest.SkipTest("probe subprocess only")
        env = dict(os.environ, QT_QPA_PLATFORM="offscreen", QT_QUICK_BACKEND="software")
        for mode, fullscreen in (("editor", False), ("reader", False), ("live", False), ("split", False), ("editor", True)):
            command = [sys.executable, str(Path(__file__).resolve()), "--probe", "--mode", mode]
            if fullscreen:
                command.append("--fullscreen")
            completed = subprocess.run(command, cwd=ROOT,
                                       env=env, text=True, encoding="utf-8", errors="strict",
                                       capture_output=True, timeout=60)
            self.assertEqual(completed.returncode, 0, f"{mode}, fullscreen={fullscreen}: {completed.stdout}{completed.stderr}")
            result = json.loads(completed.stdout.strip().splitlines()[-1])
            self.assertTrue(result.get("ok"), result)


if __name__ == "__main__" and "--probe" in sys.argv:
    mode = sys.argv[sys.argv.index("--mode") + 1] if "--mode" in sys.argv else "editor"
    zoom = float(sys.argv[sys.argv.index("--zoom") + 1]) if "--zoom" in sys.argv else 95.59963715447921
    raise SystemExit(_probe(mode, zoom, "--fullscreen" in sys.argv))
if __name__ == "__main__":
    unittest.main()
