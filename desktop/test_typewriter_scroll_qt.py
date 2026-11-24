"""Real Qt + QtWebEngine integration test for typewriter scroll centering and QWebChannel sync."""
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

ROOT = Path(__file__).resolve().parent


def _probe(screenshot_path: str | None = None) -> int:
    os.environ["QT_QPA_PLATFORM"] = "offscreen"
    os.environ["QT_QUICK_BACKEND"] = "software"
    os.environ.setdefault("QTWEBENGINE_DISABLE_SANDBOX", "1")
    os.environ.setdefault("QTWEBENGINE_CHROMIUM_FLAGS", "--disable-gpu --disable-dev-shm-usage")

    from PySide6.QtCore import QFile, QIODevice, QMetaObject, QObject, QUrl, Qt, Q_ARG
    from PySide6.QtQml import QQmlApplicationEngine
    from PySide6.QtQuickControls2 import QQuickStyle
    from PySide6.QtTest import QTest
    from PySide6.QtWebEngineQuick import QtWebEngineQuick
    from PySide6.QtWidgets import QApplication

    QQuickStyle.setStyle("Material")
    QtWebEngineQuick.initialize()
    app = QApplication(["Super MD typewriter scroll Qt test"])

    sys.path.insert(0, str(ROOT))
    from studio import Session, Studio

    with tempfile.TemporaryDirectory(prefix="supermd-typewriter-qt-") as temp_dir:
        lines = "\n".join(f"Line {i + 1}: Long-form study note paragraph {i + 1}." for i in range(90))
        session = Session(True)
        session.settings["welcomed"] = True
        session.settings["newNoteLocation"] = temp_dir
        session.settings["python"] = sys.executable
        studio = Studio(True, session)
        tab = studio.tabs[0]
        tab["name"] = "Typewriter probe.md"
        tab["content"] = lines
        tab["saved"] = lines
        studio.mode = "editor"
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
        window.setProperty("width", 1120)
        window.setProperty("height", 700)
        studio.host_window = window
        window.show()
        studio._emit()
        reader = window.findChild(QObject, "documentReader")
        if reader is None:
            raise RuntimeError("Production WebEngine reader was not found")

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

        # Wait for CodeMirror source editor to mount with typewriter off by default.
        initial = run_script(
            "(()=>{const s=document.querySelector('.cm-scroller'),b=[...document.querySelectorAll('.source-editor-status button')].find(x=>x.textContent==='Typewriter');"
            "if(!s||!b||s.clientHeight<=0){document.title=JSON.stringify({ready:false});return;}"
            "document.title=JSON.stringify({ready:true,pressed:b.getAttribute('aria-pressed')});})()"
        )
        if initial["pressed"] != "false" or studio.settings["typewriterScroll"] is not False:
            raise AssertionError(f"Expected typewriterScroll off by default: {initial}, studio={studio.settings['typewriterScroll']}")

        # Jump cursor to bottom of document while typewriter is off (active line sits near bottom edge, not centered).
        before_toggle = run_script(
            "(()=>{const s=document.querySelector('.cm-scroller');window.dispatchEvent(new CustomEvent('supermd-goto-offset',{detail:999999}));"
            "const a=document.querySelector('.cm-activeLine');if(!s||!a){document.title=JSON.stringify({ready:false});return;}"
            "const sr=s.getBoundingClientRect(),ar=a.getBoundingClientRect();"
            "document.title=JSON.stringify({ready:true,error:Math.abs((ar.top+ar.height/2)-(sr.top+sr.height/2))});})()"
        )
        if before_toggle["error"] < 60:
            raise AssertionError(f"Expected uncentered bottom line before enabling typewriter mode: {before_toggle}")

        # Trigger Qt's native Main.qml shortcut action ("typewriter_scroll") and wait past rAF anchor frames.
        QMetaObject.invokeMethod(window, "activateShortcut", Qt.ConnectionType.DirectConnection, Q_ARG("QVariant", "typewriter_scroll"))
        for _ in range(16):
            app.processEvents()
            QTest.qWait(15)

        if studio.settings["typewriterScroll"] is not True:
            raise AssertionError("Expected Main.qml typewriter_scroll shortcut to enable studio.settings['typewriterScroll']")

        centered = run_script(
            "(()=>{const s=document.querySelector('.cm-scroller'),a=document.querySelector('.cm-activeLine'),"
            "b=[...document.querySelectorAll('.source-editor-status button')].find(x=>x.textContent==='Typewriter');"
            "if(!s||!a||!b||b.getAttribute('aria-pressed')!=='true'){document.title=JSON.stringify({ready:false});return;}"
            "const sr=s.getBoundingClientRect(),ar=a.getBoundingClientRect();"
            "document.title=JSON.stringify({ready:true,pressed:b.getAttribute('aria-pressed'),"
            "error:Math.abs((ar.top+ar.height/2)-(sr.top+sr.height/2)),scrollTop:s.scrollTop});})()"
        )
        if centered["error"] >= 32:
            raise AssertionError(f"Active line did not remain centered after Qt shortcut toggle: {centered}")

        if screenshot_path:
            for _ in range(8):
                app.processEvents()
                QTest.qWait(20)
            frame = window.grabWindow()
            if not frame.isNull():
                frame.save(screenshot_path)

        # Navigate to a mid-document line via supermd-goto-offset, then dispatch ArrowDown on focused .cm-content so CodeMirror centers it.
        mid_offset = sum(len(f"Line {i + 1}: Long-form study note paragraph {i + 1}.\n") for i in range(44))
        run_script(
            f"(()=>{{window.dispatchEvent(new CustomEvent('supermd-goto-offset',{{detail:{mid_offset}}}));"
            "const c=document.querySelector('.cm-content');if(!c){document.title=JSON.stringify({ready:false});return;}"
            "c.focus();c.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown',code:'ArrowDown',bubbles:true,cancelable:true}));"
            "document.title=JSON.stringify({ready:true});})()"
        )
        for _ in range(8):
            app.processEvents()
            QTest.qWait(15)

        mid_centered = run_script(
            "(()=>{const s=document.querySelector('.cm-scroller'),a=document.querySelector('.cm-activeLine');"
            "if(!s||!a){document.title=JSON.stringify({ready:false});return;}"
            "const sr=s.getBoundingClientRect(),ar=a.getBoundingClientRect();"
            "document.title=JSON.stringify({ready:true,error:Math.abs((ar.top+ar.height/2)-(sr.top+sr.height/2))});})()"
        )
        if mid_centered["error"] >= 32:
            raise AssertionError(f"Mid-document line did not center on ArrowDown in QtWebEngine: {mid_centered}")

        # Click the status-bar Typewriter button inside QtWebEngine and verify QWebChannel syncs back to Studio without jumping.
        run_script(
            "(()=>{const a=document.querySelector('.cm-activeLine'),b=[...document.querySelectorAll('.source-editor-status button')].find(x=>x.textContent==='Typewriter');"
            "window.__beforeTop=a.getBoundingClientRect().top;b.click();document.title=JSON.stringify({ready:true});})()"
        )
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline and studio.settings["typewriterScroll"] is not False:
            app.processEvents()
            QTest.qWait(15)
        if studio.settings["typewriterScroll"] is not False:
            raise AssertionError("Status bar click inside QtWebEngine did not sync typewriterScroll=False to Studio")

        after_off = run_script(
            "(()=>{const a=document.querySelector('.cm-activeLine'),b=[...document.querySelectorAll('.source-editor-status button')].find(x=>x.textContent==='Typewriter');"
            "document.title=JSON.stringify({ready:true,pressed:b.getAttribute('aria-pressed'),drift:Math.abs(a.getBoundingClientRect().top-window.__beforeTop)});})()"
        )
        if after_off["pressed"] != "false" or after_off["drift"] >= 6:
            raise AssertionError(f"Expected status bar toggle off without visual jump: {after_off}")

        print(json.dumps({"ok": True, "centeredError": centered["error"], "midCenteredError": mid_centered["error"], "disableDrift": after_off["drift"]}), flush=True)
        window.close()
        del engine
        studio.stop()
        studio.pool.shutdown(wait=False, cancel_futures=True)
        session.writes.shutdown(wait=False)
    os._exit(0)


class TypewriterScrollQtTest(unittest.TestCase):
    def test_qt_shortcut_and_reader_status_toggle_center_without_anchor_snapback(self) -> None:
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
    shot = sys.argv[sys.argv.index("--screenshot") + 1] if "--screenshot" in sys.argv else None
    raise SystemExit(_probe(shot))
if __name__ == "__main__":
    unittest.main()
