"""Tray-owned application lifetime; closing a window preserves its live note session when opted in."""
from pathlib import Path
from PySide6.QtCore import QObject, QTimer
from PySide6.QtGui import QIcon
from PySide6.QtWidgets import QSystemTrayIcon, QMenu


class BackgroundService(QObject):
    def __init__(self, app, session, root, open_window, *, force=False):
        super().__init__(app)
        self.app = app
        self.session = session
        self.root = Path(root)
        self.open_window = open_window
        self.forced = bool(force)
        self.quitting = False
        self.waiting = set()
        self.enabled = False
        self.tray = None
        self.menu = None
        self.recents = None
        changed = getattr(self.session, "changed", None)
        if changed is not None and hasattr(changed, "connect"):
            changed.connect(self.sync)
        self.sync()

    def _ensure_tray(self):
        if self.tray is not None or not QSystemTrayIcon.isSystemTrayAvailable():
            return
        self.tray = QSystemTrayIcon(QIcon(str(self.root / "public/brand-mark-fixed.svg")), self)
        self.tray.setToolTip("Super MD — background service")
        menu = QMenu()
        self.menu = menu
        menu.addAction("Open Super MD", lambda: self.open_window(None))
        self.recents = menu.addMenu("Recent notes")
        self.recents.aboutToShow.connect(self.rebuild_recent)
        menu.addSeparator()
        menu.addAction("Quit Super MD", self.quit)
        self.tray.setContextMenu(menu)
        self.tray.activated.connect(
            lambda reason: self.open_window(None)
            if reason in (QSystemTrayIcon.Trigger, QSystemTrayIcon.DoubleClick)
            else None
        )

    def sync(self):
        settings = getattr(self.session, "settings", None)
        keep_in_background = isinstance(settings, dict) and settings.get("keepInBackground") is True
        update_installed = getattr(self.session, "update_installed", False) is True
        should_enable = (self.forced or keep_in_background) and not update_installed
        previous = self.enabled
        self.enabled = should_enable
        self.app.setQuitOnLastWindowClosed(not should_enable)
        if should_enable:
            self._ensure_tray()
            if self.tray is not None and not self.tray.isVisible():
                self.tray.show()
        elif self.tray is not None:
            self.tray.hide()
        if previous != self.enabled:
            for studio in list(getattr(self.session, "windows", {}).values()):
                if not getattr(studio, "retired", False) and hasattr(studio, "_emit"):
                    studio._emit(False)

    def set_forced(self, forced: bool):
        self.forced = bool(forced)
        self.sync()

    def disable(self):
        self.forced = False
        self.sync()

    def visible_windows(self):
        return [
            studio
            for studio in getattr(self.session, "windows", {}).values()
            if not getattr(studio, "retired", False)
            and getattr(studio, "host_window", None) is not None
            and studio.host_window.isVisible()
        ]

    def suspend_gui_agent_access(self):
        if self.forced:
            return
        bridge = getattr(self.session, "agent_bridge", None)
        if bridge is not None:
            bridge.stop()

    def restore_agent_access(self, studio=None):
        if self.quitting or getattr(self.session, "quitting", False):
            return
        settings = getattr(self.session, "settings", None)
        bridge = getattr(self.session, "agent_bridge", None)
        if not isinstance(settings, dict) or bridge is None:
            return
        if settings.get("agentAccessEnabled") is True and not bridge.enabled:
            bridge.start()
        if settings.get("cloudAgentEnabled") is True and not bridge.cloudClient.enabled:
            target = studio or next(
                (s for s in getattr(self.session, "windows", {}).values() if not getattr(s, "retired", False)),
                None,
            )
            if target is not None and hasattr(target, "_restore_cloud_connection"):
                target._restore_cloud_connection()

    def handle_window_visibility(self, studio, *, engines=None, studios=None, engine=None):
        window = getattr(studio, "host_window", None)
        if window is None or getattr(studio, "retired", False):
            return
        if window.isVisible():
            self.restore_agent_access(studio)
            return
        has_other_window = any(
            other is not studio and not getattr(other, "retired", False)
            for other in getattr(self.session, "windows", {}).values()
        )
        if not studio.backgroundEnabled or has_other_window:
            studio.stop()
            if studios is not None and studio in studios:
                studios.remove(studio)
            if engines is not None and engine is not None and engine in engines:
                engines.remove(engine)
            if engine is not None and hasattr(engine, "deleteLater"):
                engine.deleteLater()
            return
        if not self.visible_windows():
            self.suspend_gui_agent_access()

    def handle_service_request(self, action: str) -> dict:
        bridge = getattr(self.session, "agent_bridge", None)
        settings = getattr(self.session, "settings", None)
        running = bool(self.enabled and not self.quitting)
        agent_enabled = bool(bridge and bridge.enabled)
        if action == "status":
            return {"ok": True, "running": running, "agentAccess": agent_enabled}
        if action == "start":
            consented = isinstance(settings, dict) and settings.get("agentAccessEnabled") is True
            if not consented:
                return {
                    "ok": False,
                    "running": running,
                    "agentAccess": False,
                    "error": "Super MD is already open without live agent access. Enable live agent access in Settings -> AI agents first.",
                }
            self.set_forced(True)
            if bridge is not None and not bridge.enabled:
                bridge.start()
            sessions_dir = str(bridge.discovery_dir) if bridge is not None else ""
            return {
                "ok": True,
                "running": bool(self.enabled and not self.quitting),
                "agentAccess": bool(bridge and bridge.enabled),
                "sessionsDirectory": sessions_dir,
            }
        if action in ("stop", "quit"):
            open_gui_windows = self.visible_windows()
            if open_gui_windows:
                if isinstance(settings, dict) and settings.get("keepInBackground") is True:
                    settings["keepInBackground"] = False
                    owner = open_gui_windows[0]
                    if hasattr(owner, "_preferences"):
                        owner._preferences()
                self.disable()
                return {
                    "ok": True,
                    "running": False,
                    "stopped": running,
                    "quitRequested": False,
                }
            self.disable()
            self.quit()
            return {
                "ok": True,
                "running": False,
                "stopped": True,
                "quitRequested": True,
            }
        return {"ok": False, "running": running, "error": f"Unsupported service action: {action}"}

    def rebuild_recent(self):
        self.recents.clear()
        for path in self.session.recent[:10]:
            action = self.recents.addAction(Path(path).name, lambda checked=False, path=path: self.open_window(path))
            action.setToolTip(path)
        if not self.session.recent:
            self.recents.addAction("No recent notes").setEnabled(False)

    def quit(self):
        self.quitting = True
        owners = [s for s in self.session.windows.values() if not s.retired]
        self.waiting = {s.window_id for s in owners}
        if not owners:
            QTimer.singleShot(0, self.app.quit)
            return
        for studio in owners:
            key = studio.window_id
            def ready(key=key):
                self.waiting.discard(key)
                if not self.waiting:
                    QTimer.singleShot(0, self.app.quit)
            studio.allowClose.connect(ready)
            window = getattr(studio, "host_window", None)
            if window is not None and not window.isVisible():
                window.show()
            studio.closeWindowSafely()
