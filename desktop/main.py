"""Super MD's native Qt Quick desktop entry point (no Tauri window host)."""
import argparse
import os
import sys
import subprocess
from pathlib import Path
from PySide6.QtCore import QFile, QIODevice, QUrl, QTimer, QMetaObject, Q_ARG, QObject, QEvent, Signal
from PySide6.QtGui import QGuiApplication, QIcon, QFont, QFontDatabase
from PySide6.QtQml import QQmlApplicationEngine
from PySide6.QtQuickControls2 import QQuickStyle
from PySide6.QtWebEngineQuick import QtWebEngineQuick
from studio import Session, Studio, ROOT
from instance import InstanceBroker

class StudioApplication(QGuiApplication):
    openRequested = Signal(str)

    def event(self, event):
        # Native macOS open events target the application. Do not install a
        # Python global event filter over Qt Quick/WebEngine's internal objects:
        # PySide's wrapper creation can itself send events and recurse.
        if event.type() == QEvent.Type.FileOpen:
            path = event.file() or (event.url().toLocalFile() if event.url().isLocalFile() else "")
            if path:
                self.openRequested.emit(path)
                return True
        return super().event(event)

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
    if sys.platform.startswith("linux"):
        # Let Qt use the desktop's portal chooser (including its Wayland parent
        # handle), not a toolkit-built file/folder browser. The plugin is bundled.
        os.environ["QT_QPA_PLATFORMTHEME"] = "xdgdesktopportal"
    QQuickStyle.setStyle("Material")
    QtWebEngineQuick.initialize()
    QGuiApplication.setApplicationName("super-md-qt" if args.test_state else "super-md")
    QGuiApplication.setOrganizationName("SuperMD")
    QGuiApplication.setDesktopFileName("dev.supermd.studio-test" if args.test_state else "dev.supermd.studio")
    app = StudioApplication(sys.argv)
    for file in (ROOT / "smd-core" / "fonts").glob("NotoSans-*.ttf"):
        QFontDatabase.addApplicationFont(str(file))
    app.setFont(QFont("Noto Sans",11))
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
    def detach_window(source_id, tab_id):
        source = session.windows.get(source_id)
        if not source or not source._can_move(): return
        try:
            destination = create_window()
        except Exception as error:
            source.message = f"Could not create a window: {error}"
            source._emit(False)
            return
        destination.mode = source.mode
        welcome, active = destination.tabs, destination.active
        destination.tabs = []
        last = len(source.tabs) == 1
        if source._move_tab(destination, tab_id, 0):
            if last: QTimer.singleShot(0, source.allowClose.emit)
        else:
            destination.tabs, destination.active = welcome, active
            QTimer.singleShot(0, destination.allowClose.emit)
    def create_window(note=None):
        engine = QQmlApplicationEngine()
        studio = Studio(args.test_state,session)
        if args.smoke:
            studio.settings["welcomed"] = True
            studio.mode = "reader"
        studio.newWindowRequested.connect(create_window)
        studio.detachedWindowRequested.connect(detach_window)
        engine.rootContext().setContextProperty("studio", studio)
        engine.rootContext().setContextProperty("readerUrl", QUrl.fromLocalFile(str(ROOT / "dist" / "qt-reader.html")))
        engine.rootContext().setContextProperty("channelScript", channel_script)
        engine.rootContext().setContextProperty("brandUrl", QUrl.fromLocalFile(str(ROOT / "public" / "brand-mark-fixed.svg")))
        engine.load(QUrl.fromLocalFile(str(ROOT / "desktop" / "qml" / "Main.qml")))
        if not engine.rootObjects():
            studio.stop()
            studio.pool.shutdown(wait=False, cancel_futures=True)
            engine.deleteLater()
            raise RuntimeError("Native QML window could not be loaded")
        # The user's laptop screen is preferred without changing active desktop focus.
        window = engine.rootObjects()[0]
        studio.host_window = window
        def retire_window():
            if not window.isVisible() and not studio.retired:
                studio.stop()
                if engine in engines: engines.remove(engine)
                engine.deleteLater()
        window.visibleChanged.connect(lambda: QTimer.singleShot(0, retire_window))
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
                    fullscreen = window.findChild(QObject,"fullscreenButton")
                    valid = valid and fullscreen is not None and fullscreen.property("text") == "" and fullscreen.property("availableHeight") >= 24
                    if fullscreen:
                        print(f"FULLSCREEN ICON: availableHeight={fullscreen.property('availableHeight')} padding={fullscreen.property('topPadding')}/{fullscreen.property('bottomPadding')}",flush=True)
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
                    scroll = window.findChild(QObject,"settingsScroll")
                    choice = window.findChild(QObject,"readingFontChoice")
                    capture("font-dropdown")
                    if popup is None or not popup.property("visible"):
                        print("DROPDOWN SMOKE FAILED: menu is not visible",flush=True)
                        app.exit(2)
                        return
                    if scroll.property("width") - choice.property("width") < 24:
                        print("SCROLL GUTTER SMOKE FAILED: settings controls overlap the scrollbar",flush=True)
                        app.exit(2)
                        return
                    print(f"DROPDOWN SMOKE: y={popup.property('y')} height={popup.property('height')}",flush=True)
                QTimer.singleShot(15500,capture_dropdown)
                QTimer.singleShot(16000,lambda:studio.setting("theme",'"dark"'))
                QTimer.singleShot(17000,lambda:capture("dark-settings"))
                def narrow():
                    changed = window.setProperty("settingsOpen",False)
                    window.setWidth(800)
                    studio.setting("theme",'"black"')
                    print(f"NARROW SMOKE: settingsChanged={changed} settingsOpen={window.property('settingsOpen')} theme={studio.settings['theme']}",flush=True)
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
                QTimer.singleShot(24000,lambda:studio.setMode("editor"))
                def source_capture():
                    dialog = window.findChild(QObject,"settingsDialog")
                    capture("source")
                    if window.property("settingsOpen") or dialog.property("visible"):
                        print(f"SOURCE SMOKE FAILED: settingsOpen={window.property('settingsOpen')} dialogVisible={dialog.property('visible')} theme={studio.settings['theme']}",flush=True)
                        app.exit(2)
                QTimer.singleShot(25500,source_capture)
                QTimer.singleShot(26000,lambda:QMetaObject.invokeMethod(window,"showExport",Q_ARG("QVariant",False)))
                def export_capture(name):
                    capture(name)
                    panel = window.findChild(QObject,"exportPdfControls")
                    numbers = panel.findChild(QObject,"pdfPageNumbers") if panel else None
                    if panel is None or not panel.property("visible") or panel.property("width") < 200 or numbers is None or not numbers.property("visible"):
                        print(f"PDF OPTIONS SMOKE FAILED: panel={panel} numbers={numbers}",flush=True)
                        app.exit(2)
                QTimer.singleShot(27500,lambda:export_capture("export-options"))
                QTimer.singleShot(28000,lambda:QMetaObject.invokeMethod(window,"hideExport"))
                QTimer.singleShot(29000,lambda:QMetaObject.invokeMethod(window,"showExport",Q_ARG("QVariant",True)))
                QTimer.singleShot(30500,lambda:export_capture("share-options"))
                def pdf_result():
                    if studio.message == "Exported native-render.pdf" and report.exists() and report.stat().st_size>10000:
                        print(f"PDF SMOKE PASSED: {report}",flush=True)
                        app.exit(0)
                    else:
                        print(f"PDF SMOKE FAILED: {studio.message}",flush=True)
                        app.exit(2)
                QTimer.singleShot(32000,pdf_result)
        if note:
            studio.openPath(str(note))
        return studio
    create_window(args.note)
    if broker:
        broker.requested.connect(lambda note: create_window(note or None))
    app.openRequested.connect(create_window)
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
