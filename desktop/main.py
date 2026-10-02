"""Super MD's native Qt Quick desktop entry point (no Tauri window host)."""
import argparse
import os
import sys
import subprocess
from pathlib import Path
from PySide6.QtCore import QFile, QIODevice, QUrl, QTimer, QMetaObject, Q_ARG, QObject, QEvent
from PySide6.QtGui import QGuiApplication, QIcon, QFont, QFontDatabase
from PySide6.QtQml import QQmlApplicationEngine
from PySide6.QtQuickControls2 import QQuickStyle
from PySide6.QtWebEngineQuick import QtWebEngineQuick
from studio import Session, Studio, ROOT
from instance import InstanceBroker

def main():
    if len(sys.argv) > 1 and sys.argv[1] in ("read", "inspect", "assets", "extract", "pack", "export", "export-json", "doctor"):
        executable = "smd-engine.exe" if sys.platform == "win32" else "smd-engine"
        candidates = (ROOT / "desktop" / executable, ROOT / "smd-core/target/release" / executable,
                      ROOT / "smd-core/target/debug" / executable)
        engine = next((path for path in candidates if path.is_file()), None)
        if engine is None:
            print("Native PDF/portable engine is missing from this installation", file=sys.stderr)
            return 1
        return subprocess.call([str(engine), *sys.argv[1:]])
    parser = argparse.ArgumentParser(description="Super MD native Qt desktop")
    parser.add_argument("note", nargs="?")
    parser.add_argument("--test-state", action="store_true", help="Isolated preferences and recovery for UI tests")
    parser.add_argument("--quit-after", type=int, default=0, help=argparse.SUPPRESS)
    parser.add_argument("--smoke", action="store_true", help=argparse.SUPPRESS)
    parser.add_argument("--visual-smoke", action="store_true", help=argparse.SUPPRESS)
    parser.add_argument("--version", action="store_true")
    args = parser.parse_args()
    if args.version:
        import json
        print("Super MD " + json.loads((ROOT / "desktop/build-info.json").read_text())["version"] if (ROOT / "desktop/build-info.json").exists() else "Super MD native development")
        return 0
    if args.visual_smoke:
        args.smoke = True
        args.test_state = True
    QQuickStyle.setStyle("Material")
    QtWebEngineQuick.initialize()
    app = QGuiApplication(sys.argv)
    for file in (ROOT / "smd-core" / "fonts").glob("NotoSans-*.ttf"):
        QFontDatabase.addApplicationFont(str(file))
    app.setFont(QFont("Noto Sans",11))
    app.setApplicationName("super-md-qt" if args.test_state else "super-md")
    app.setOrganizationName("SuperMD")
    app.setDesktopFileName("dev.supermd.studio-test" if args.test_state else "dev.supermd.studio")
    app.setWindowIcon(QIcon(str(ROOT / "public" / "brand-mark-fixed.svg")))
    broker = None if args.test_state else InstanceBroker(app)
    if broker and not broker.claim_or_forward(args.note):
        return 0
    channel = QFile(":/qtwebchannel/qwebchannel.js")
    if not channel.open(QIODevice.OpenModeFlag.ReadOnly):
        raise RuntimeError("Qt WebChannel runtime is unavailable")
    channel_script = bytes(channel.readAll()).decode()
    engines, studios = [], []
    session = Session(args.test_state)
    def create_window(note=None):
        engine = QQmlApplicationEngine()
        studio = Studio(args.test_state,session)
        if args.smoke:
            studio.settings["welcomed"] = True
            studio.mode = "reader"
        studio.newWindowRequested.connect(create_window)
        engine.rootContext().setContextProperty("studio", studio)
        engine.rootContext().setContextProperty("readerUrl", QUrl.fromLocalFile(str(ROOT / "dist" / "qt-reader.html")))
        engine.rootContext().setContextProperty("channelScript", channel_script)
        engine.rootContext().setContextProperty("brandUrl", QUrl.fromLocalFile(str(ROOT / "public" / "brand-mark-fixed.svg")))
        engine.load(QUrl.fromLocalFile(str(ROOT / "desktop" / "qml" / "Main.qml")))
        if not engine.rootObjects():
            raise RuntimeError("Native QML window could not be loaded")
        # The user's laptop screen is preferred without changing active desktop focus.
        window = engine.rootObjects()[0]
        laptop = next((s for s in app.screens() if s.name().startswith(("eDP", "LVDS"))), None)
        if laptop:
            window.setScreen(laptop)
            rect = laptop.availableGeometry()
            window.setPosition(rect.x() + max(0,(rect.width()-window.width())//2), rect.y()+max(0,(rect.height()-window.height())//2))
        window.show()
        engines.append(engine)
        studios.append(studio)
        if args.smoke:
            def verify():
                script = "window.SuperMD?.post('smoke','export_failed',JSON.stringify({error:'SMOKE:'+JSON.stringify({headings:document.querySelectorAll('h1').length,math:document.querySelectorAll('.katex').length,charts:document.querySelectorAll('.interactive-chart svg').length,surfaces:document.querySelectorAll('.surface-chart').length,answers:document.querySelectorAll('details.callout').length,zoom:getComputedStyle(document.documentElement).getPropertyValue('--workspace-scale')})}))"
                QMetaObject.invokeMethod(window,"runDocumentScript",Q_ARG("QVariant",script))
            def result():
                if studio.message.startswith("SMOKE:"):
                    print(studio.message,flush=True)
                    window.grabWindow().save("/tmp/supermd-qt-smoke.png")
                    valid = all(value in studio.message for value in ('"headings":1','"math":1','"charts":2','"surfaces":1','"answers":1'))
                    zoom = window.findChild(QObject,"zoomPercentage")
                    valid = valid and zoom is not None and zoom.property("height") == 36
                    if not valid or not args.visual_smoke:
                        app.exit(0 if valid else 2)
                else:
                    print(f"SMOKE FAILED: reader ready={studio.ready}",flush=True)
                    app.exit(2)
            QTimer.singleShot(8000,verify)
            QTimer.singleShot(10000,result)
            if args.visual_smoke:
                # Exercise presented Qt pixels, not just generated tokens or QML parsing.
                def capture(name):
                    if not window.grabWindow().save(f"/tmp/supermd-qt-{name}.png"):
                        app.exit(2)
                QTimer.singleShot(10500,lambda:studio.setting("theme",'"light"'))
                QTimer.singleShot(12000,lambda:capture("light"))
                QTimer.singleShot(12500,lambda:window.setProperty("settingsOpen",True))
                QTimer.singleShot(14000,lambda:capture("light-settings"))
                def dropdown():
                    choice = window.findChild(QObject,"readingFontChoice")
                    if choice is None:
                        app.exit(2)
                    else:
                        if not QMetaObject.invokeMethod(choice,"revealChoices"):
                            app.exit(2)
                QTimer.singleShot(14500,dropdown)
                def capture_dropdown():
                    popup = window.findChild(QObject,"readingFontChoicePopup")
                    capture("font-dropdown")
                    if popup is None or not popup.property("visible"):
                        print("DROPDOWN SMOKE FAILED: menu is not visible",flush=True)
                        app.exit(2)
                        return
                    print(f"DROPDOWN SMOKE: y={popup.property('y')} height={popup.property('height')}",flush=True)
                QTimer.singleShot(15500,capture_dropdown)
                QTimer.singleShot(16000,lambda:studio.setting("theme",'"dark"'))
                QTimer.singleShot(17000,lambda:capture("dark-settings"))
                def narrow():
                    window.setProperty("settingsOpen",False)
                    window.setWidth(800)
                    studio.setting("theme",'"black"')
                QTimer.singleShot(17500,narrow)
                QTimer.singleShot(19000,lambda:capture("black-narrow"))
                def surface_view():
                    window.setWidth(1320)
                    studio.setting("theme",'"system"')
                    QTimer.singleShot(500,lambda:QMetaObject.invokeMethod(window,"runDocumentScript",Q_ARG("QVariant","document.querySelector('.surface-chart')?.scrollIntoView({block:'center',behavior:'instant'})")))
                QTimer.singleShot(20000,surface_view)
                QTimer.singleShot(21500,lambda:capture("3d-surface"))
                report = studio.data/"native-render.pdf"
                QTimer.singleShot(22000,lambda:studio.exportTo(str(report),"pdf"))
                def pdf_result():
                    if studio.message == "Exported native-render.pdf" and report.exists() and report.stat().st_size>10000:
                        print(f"PDF SMOKE PASSED: {report}",flush=True)
                        app.exit(0)
                    else:
                        print(f"PDF SMOKE FAILED: {studio.message}",flush=True)
                        app.exit(2)
                QTimer.singleShot(28000,pdf_result)
        if note:
            studio.openNote(str(note))
    create_window(args.note)
    if broker:
        broker.requested.connect(lambda note: create_window(note or None))
    if args.quit_after:
        QTimer.singleShot(args.quit_after, app.quit)
    status = app.exec()
    for studio in studios:
        studio.stop()
    # Destroy QML contexts while their Python backend objects are still alive.
    for engine in engines:
        engine.deleteLater()
    app.sendPostedEvents(None,QEvent.Type.DeferredDelete)
    for studio in studios:
        studio.pool.shutdown(wait=False,cancel_futures=True)
        # Don't cancel a user's pending save or final recovery write.
    session.writes.shutdown(wait=True)
    if broker:
        broker.close()
    return status

if __name__ == "__main__":
    sys.exit(main())
