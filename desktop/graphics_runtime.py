"""Select graphics before Qt starts; a failed driver must not abort the editor.

The probe has no preferences, document access or Chromium sandbox changes. It
paints HTML in a tiny non-activating window in an isolated process, because Qt's RHI
initialization can call abort() rather than raise a catchable Python exception.
"""
from __future__ import annotations

import os
import subprocess
import sys
import tempfile
from pathlib import Path

PROBE_TIMEOUT = 8


def painted_document(image) -> bool:
    """Two HTML-only markers distinguish document pixels from Qt's surface."""
    if image.isNull() or image.width() < 4 or image.height() < 2:
        return False
    y = image.height() // 2
    return (image.pixelColor(image.width() // 4, y).name() == "#3476ad" and
            image.pixelColor(image.width() * 3 // 4, y).name() == "#b34d66")


def command() -> list[str]:
    if getattr(sys, "frozen", False):
        return [sys.executable, "--graphics-probe"]
    return [sys.executable, str(Path(__file__).with_name("main.py")), "--graphics-probe"]


def software_environment(env: dict[str, str]) -> None:
    env["QT_QUICK_BACKEND"] = "software"
    # XCB otherwise tries GLX even when Quick and Chromium render in software.
    # A broken GLX driver can abort there; Wayland ignores this XCB-only knob.
    if sys.platform.startswith("linux"):
        env["QT_XCB_GL_INTEGRATION"] = "none"
    # Chromium and Qt Quick are separate renderers; forcing only one may
    # leave WebEngine blank even though native controls render successfully.
    flags = env.get("QTWEBENGINE_CHROMIUM_FLAGS", "").split()
    if "--disable-gpu" not in flags:
        flags.append("--disable-gpu")
    env["QTWEBENGINE_CHROMIUM_FLAGS"] = " ".join(flags)


def configure(env: dict[str, str] | None = None, *, safe: bool = False, runner=None) -> str:
    env = os.environ if env is None else env
    if safe or env.get("QT_QUICK_BACKEND") == "software":
        software_environment(env)
        return "software"
    runner = subprocess.run if runner is None else runner
    try:
        # A Windows GUI executable has no Python stdout. A private result file
        # preserves acceleration there too; an early exit without painting is
        # never mistaken for a successful probe.
        with tempfile.TemporaryDirectory(prefix="supermd-graphics-") as folder:
            report = Path(folder) / "presented.txt"
            result = runner([*command(), str(report)], env=dict(env), capture_output=True, text=True,
                            timeout=PROBE_TIMEOUT, check=False)
            marker = report.read_text(encoding="utf-8") if report.is_file() else result.stdout
            healthy = result.returncode == 0 and any(
                line.strip() == "SUPERMD_GRAPHICS_OK" for line in (marker or "").splitlines())
    except (OSError, subprocess.TimeoutExpired):
        healthy = False
    if healthy:
        return "accelerated"
    software_environment(env)
    print("Super MD: accelerated graphics unavailable; using software rendering. "
          "Qt Quick and the document renderer remain enabled.", file=sys.stderr, flush=True)
    return "software"


def probe(report: Path | None = None) -> int:
    # Do not import the editor, Session, note loaders or InstanceBroker here.
    # A crashing probe must never acquire the app's single-instance socket.
    if sys.platform != "win32":
        import resource
        resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
    from PySide6.QtCore import QTimer, Qt
    from PySide6.QtGui import QGuiApplication
    from PySide6.QtQml import QQmlApplicationEngine
    from PySide6.QtQuick import QQuickWindow
    from PySide6.QtWebEngineQuick import QtWebEngineQuick

    QtWebEngineQuick.initialize()
    app = QGuiApplication([sys.argv[0]])
    app.setQuitOnLastWindowClosed(False)
    engine = QQmlApplicationEngine()
    engine.loadData(b'''import QtQuick
import QtQuick.Window
import QtWebEngine
Window {
    id: probeWindow
    width: 64; height: 32; color: "#010203"; visible: false
    property bool documentLoaded: false
    WebEngineProfile { id: isolatedProfile; offTheRecord: true }
    WebEngineView {
        anchors.fill: parent
        profile: isolatedProfile
        Component.onCompleted: loadHtml("<!doctype html><html><head><style>html,body{margin:0;width:100%;height:100%;overflow:hidden}body{background:linear-gradient(to right,#3476ad 0%,#3476ad 50%,#b34d66 50%,#b34d66 100%)}</style></head><body></body></html>")
        onLoadingChanged: function(info) {
            if (info.status === WebEngineView.LoadSucceededStatus) probeWindow.documentLoaded = true
        }
    }
}
''')
    if not engine.rootObjects():
        return 1
    window = engine.rootObjects()[0]
    if not isinstance(window, QQuickWindow):
        return 1
    window.setFlags(Qt.WindowType.Tool | Qt.WindowType.FramelessWindowHint |
                    Qt.WindowType.WindowDoesNotAcceptFocus)
    window.setOpacity(0.01)
    panel = next((screen for screen in app.screens()
                  if screen.name().startswith(("eDP", "LVDS"))), app.primaryScreen())
    if panel:
        window.setScreen(panel)
        rect = panel.availableGeometry()
        window.setPosition(rect.left(), rect.top())
    window.show()

    def presented():
        if not window.property("documentLoaded"):
            return
        image = window.grabWindow()
        if not painted_document(image):
            return
        if report is not None:
            report.write_text("SUPERMD_GRAPHICS_OK\n", encoding="utf-8")
        print("SUPERMD_GRAPHICS_OK", flush=True)
        timer.stop()
        window.hide()
        app.exit(0)

    timer = QTimer()
    timer.setInterval(100)
    timer.timeout.connect(presented)
    timer.start()
    QTimer.singleShot(5000, lambda: app.exit(1))
    return app.exec()
