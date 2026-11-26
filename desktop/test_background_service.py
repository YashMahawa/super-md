import asyncio, hashlib, json, os, shutil, subprocess, sys, tempfile, threading, time, unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

from PySide6.QtCore import QEvent, QLockFile, QObject, QPointF, QStandardPaths, Qt, QTimer, QUrl, Signal
from PySide6.QtNetwork import QLocalServer
from PySide6.QtQml import QQmlComponent, QQmlEngine
from PySide6.QtQuick import QQuickItem
from PySide6.QtQuickControls2 import QQuickStyle
from PySide6.QtTest import QTest
from PySide6.QtWidgets import QApplication

import agent_cloud, agent_live, background_cli, mcp_server, python_runtime, updates
from agent_live import LiveTabClient
from agent_live_client import MultiSessionLiveClient
from background_service import BackgroundService
from documents import atomic_json, open_note, write_portable
from instance import InstanceBroker
from studio import ROOT, Session
from test_studio import QuietStudio

DESKTOP_DIR = Path(__file__).resolve().parent
QML_DIR = DESKTOP_DIR / "qml"


class App(QObject):
    def __init__(self):
        super().__init__()
        self.ended = False
        self.keep = False

    def setQuitOnLastWindowClosed(self, value):
        self.keep = not value

    def quit(self):
        self.ended = True


class Owner(QObject):
    allowClose = Signal()

    def __init__(self, key):
        super().__init__()
        self.window_id = key
        self.retired = False
        self.requested = False

    def closeWindowSafely(self):
        self.requested = True


class _VisibleHost:
    def __init__(self, visible=True):
        self._visible = visible

    def isVisible(self): return self._visible
    def show(self): self._visible = True
    def hide(self): self._visible = False


class _FakeRelaySocket:
    def __init__(self, config):
        self.config = config
        self.closed = threading.Event()
        self._registered = False

    def recv(self, timeout=1):
        if not self._registered:
            self._registered = True
            return json.dumps({"type": "registered", "groupId": self.config["groupId"], "deviceId": self.config["deviceId"]})
        if self.closed.wait(timeout=min(float(timeout), 0.1)):
            return None
        raise TimeoutError

    def send(self, _payload): pass
    def close(self, **_kwargs): self.closed.set()


class BackgroundTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if QApplication.instance() is None:
            QQuickStyle.setStyle("Material")
        cls.qt_app = QApplication.instance() or QApplication(["BackgroundTests"])

    def _pump(self, rounds=8):
        for _ in range(rounds):
            self.qt_app.processEvents()
            time.sleep(0.005)

    def _make_session(self):
        session = Session(True)
        session.settings["python"] = sys.executable
        session.agent_bridge = agent_live.create_qt_bridge(session, session.data)
        self.addCleanup(lambda: shutil.rmtree(session.data, ignore_errors=True))
        self.addCleanup(session.writes.shutdown, wait=True)
        self.addCleanup(session.agent_bridge.stop)
        return session

    def _make_studio(self, session, *, visible=True):
        studio = QuietStudio(True, session)
        studio.host_window = _VisibleHost(visible=visible)
        self.addCleanup(lambda: (studio.stop(), studio.pool.shutdown(wait=True, cancel_futures=True)))
        return studio

    def _write_test_pairing(self, studio):
        pairing = agent_cloud.new_pairing("https://relay.example.com")
        agent_cloud.write_cloud_config(studio._agent_cloud_config_path, agent_cloud.device_config(pairing))
        client = studio.session.agent_bridge.cloudClient
        client.enroll_fn = lambda _cfg: None
        client.connect_factory = _FakeRelaySocket

    def test_background_quit_waits_for_every_note_flush_and_resets_on_cancel(self):
        app = App()
        a, b = Owner("a"), Owner("b")
        session = SimpleNamespace(windows={"a": a, "b": b}, recent=[])
        with patch("background_service.QSystemTrayIcon.isSystemTrayAvailable", return_value=False):
            service = BackgroundService(app, session, Path("."), lambda _: None, force=True)
        self.assertTrue(service.enabled and app.keep)
        service.quit()
        self.assertTrue(a.requested and b.requested)
        self.assertEqual(service.waiting, {"a", "b"})
        a.allowClose.emit()
        self.assertEqual(service.waiting, {"b"})
        self.assertFalse(app.ended)
        b.allowClose.emit()
        self.assertFalse(service.waiting)
        self._pump(2)
        self.assertTrue(app.ended)

        # Cancelling a dirty-note or reader-flush prompt during tray Quit restores residency.
        app2 = App()
        real_session = self._make_session()
        studio = self._make_studio(real_session, visible=True)
        with patch("background_service.QSystemTrayIcon.isSystemTrayAvailable", return_value=False):
            real_session.background = BackgroundService(app2, real_session, ROOT, lambda _: None, force=False)
            studio.setting("keepInBackground", "true")
            studio.tabs[0]["content"] = "# Unsaved\n"
            real_session.background.quit()
            self.assertTrue(real_session.background.quitting)
            self.assertEqual(studio.pending_close, "window")
            self.assertFalse(studio.backgroundEnabled)

            studio.resolveClose("cancel")
            self.assertFalse(real_session.background.quitting)
            self.assertEqual(real_session.background.waiting, set())
            self.assertTrue(studio.backgroundEnabled)
            # Subsequent allowClose (e.g. closing to tray) must NOT trigger stale app.quit.
            studio.allowClose.emit()
            self._pump(4)
            self.assertFalse(app2.ended)

    def test_default_settings_disable_tray_residency_quit_cleanly_and_revoke_tokens(self):
        app = App()
        session = self._make_session()
        self.assertIs(session.settings["keepInBackground"], False)
        studio = self._make_studio(session, visible=True)
        for invalid in ('"yes"', "1", "null", "[]", "{}"):
            studio.setting("keepInBackground", invalid)
            self.assertIs(session.settings["keepInBackground"], False)

        with patch("background_service.QSystemTrayIcon") as tray_cls:
            tray_cls.isSystemTrayAvailable.return_value = True
            session.background = BackgroundService(app, session, ROOT, lambda _: None, force=False)
            self.assertFalse(session.background.enabled or studio.backgroundEnabled or app.keep)
            tray_cls.assert_not_called()

        self._write_test_pairing(studio)
        studio.setAgentAccessEnabled(True)
        studio.setCloudAgentEnabled(True)
        discovery_path = session.agent_bridge.discovery_path
        self.assertTrue(discovery_path and discovery_path.is_file() and session.agent_bridge.cloudClient.enabled)

        studio.host_window.hide()
        session.background.handle_window_visibility(studio)
        session.agent_bridge.stop()
        self.assertTrue(studio.retired)
        self.assertEqual(session.windows, {})
        self.assertFalse(discovery_path.exists() or session.agent_bridge.enabled or session.agent_bridge.cloudClient.enabled)

    def test_keep_in_background_hides_last_window_revokes_tokens_and_restores_on_reopen(self):
        app = App()
        session = self._make_session()
        studio = self._make_studio(session, visible=True)
        self._write_test_pairing(studio)
        with patch("background_service.QSystemTrayIcon.isSystemTrayAvailable", return_value=False):
            session.background = BackgroundService(app, session, ROOT, lambda _: None, force=False)
            studio.setting("keepInBackground", "true")
            self._pump()
            self.assertTrue(session.background.enabled and studio.backgroundEnabled and app.keep)

            studio.setAgentAccessEnabled(True)
            studio.setCloudAgentEnabled(True)
            first_discovery, first_token = session.agent_bridge.discovery_path, session.agent_bridge.token
            self.assertTrue(first_discovery.is_file() and session.agent_bridge.cloudClient.enabled)

            studio.host_window.hide()
            session.background.handle_window_visibility(studio)
            self.assertFalse(studio.retired)
            self.assertFalse(first_discovery.exists() or session.agent_bridge.enabled or session.agent_bridge.cloudClient.enabled)
            self.assertTrue(session.settings["agentAccessEnabled"] and session.settings["cloudAgentEnabled"])

            studio.host_window.show()
            session.background.handle_window_visibility(studio)
            self.assertTrue(session.agent_bridge.enabled and session.agent_bridge.discovery_path.is_file())
            self.assertNotEqual(session.agent_bridge.token, first_token)
            self.assertTrue(session.agent_bridge.cloudClient.enabled)

    def test_headless_background_agent_access_preserves_tokens_without_gui_windows(self):
        app = App()
        session = self._make_session()
        session.settings["agentAccessEnabled"] = True
        with patch("background_service.QSystemTrayIcon.isSystemTrayAvailable", return_value=False):
            session.background = BackgroundService(app, session, ROOT, lambda _: None, force=True)
        studio = self._make_studio(session, visible=False)
        session.agent_bridge.start()
        discovery = session.agent_bridge.discovery_path
        session.background.handle_window_visibility(studio)
        self.assertFalse(studio.retired)
        self.assertTrue(session.agent_bridge.enabled and discovery.is_file())

        # Even after WebEngine marks a hidden headless window `ready = True` with an unsaved draft,
        # CLI `service stop` flushes/persists recovery state and quits without opening a modal close prompt.
        studio.tabs[0]["content"] = "# Unsaved headless draft\n\n$$E = mc^2$$\n"
        studio.ready = True
        studio.readerCall.connect(
            lambda js: studio.post(
                "flush-1",
                "document_flushed",
                json.dumps(
                    {
                        "id": studio.tabs[0]["id"],
                        "content": studio.tabs[0]["content"],
                        "operation": studio.flush_operation,
                    }
                ),
            )
            if "supermdFlush" in js and studio.flush_operation
            else None
        )
        stop_reply = session.background.handle_service_request("stop")
        self._pump(6)
        self.assertEqual(stop_reply, {"ok": True, "running": False, "stopped": True, "quitRequested": True})
        self.assertEqual(studio.pending_close, "")
        self.assertFalse(studio.host_window.isVisible())
        self.assertTrue(app.ended)
        studio.stop()
        session.writes.shutdown(wait=True)
        recovered = json.loads((session.data / "recovery.json").read_text(encoding="utf-8"))
        self.assertTrue(any("Unsaved headless draft" in tab.get("content", "") for tab in recovered))

        # When a hidden offscreen renderer is occluded/suspended (e.g. on macOS/Windows) and never
        # answers `supermdFlush`, `_on_flush_timeout` must still recover drafts and quit without
        # showing a modal flush dialog.
        app_occluded = App()
        session_occluded = self._make_session()
        session_occluded.settings["agentAccessEnabled"] = True
        with patch("background_service.QSystemTrayIcon.isSystemTrayAvailable", return_value=False):
            session_occluded.background = BackgroundService(
                app_occluded, session_occluded, ROOT, lambda _: None, force=True
            )
        studio_occluded = self._make_studio(session_occluded, visible=False)
        studio_occluded.tabs[0]["content"] = "# Occluded hidden draft\n\n$$\\nabla \\cdot B = 0$$\n"
        studio_occluded.ready = True
        flush_failed_events = []
        studio_occluded.flushFailed.connect(flush_failed_events.append)
        stop_occluded = session_occluded.background.handle_service_request("stop")
        self.assertEqual(stop_occluded, {"ok": True, "running": False, "stopped": True, "quitRequested": True})
        self.assertIsNotNone(studio_occluded.flush_operation)
        studio_occluded._on_flush_timeout()
        self._pump(6)
        self.assertEqual(flush_failed_events, [])
        self.assertFalse(studio_occluded.host_window.isVisible())
        self.assertTrue(app_occluded.ended)
        studio_occluded.stop()
        session_occluded.writes.shutdown(wait=True)
        recovered_occluded = json.loads((session_occluded.data / "recovery.json").read_text(encoding="utf-8"))
        self.assertTrue(any("Occluded hidden draft" in tab.get("content", "") for tab in recovered_occluded))

    def test_install_update_bypasses_tray_hiding_across_desktop_installers(self):
        for kind in ("appimage", "windows", "macos"):
            app = App()
            session = self._make_session()
            studio = self._make_studio(session, visible=True)
            with patch("background_service.QSystemTrayIcon.isSystemTrayAvailable", return_value=False):
                session.background = BackgroundService(app, session, ROOT, lambda _: None, force=False)
                studio.setting("keepInBackground", "true")
                suffix = {"appimage": "amd64.AppImage", "windows": "x64-setup.exe", "macos": "universal.dmg"}[kind]
                installer = session.data / f"Super.MD_9.9.9_{suffix}"
                installer.write_bytes(b"verified-installer")
                release = {
                    "version": "9.9.9",
                    "asset": {"name": installer.name, "size": installer.stat().st_size, "url": f"https://github.com/YashMahawa/super-md/releases/download/v9.9.9/{installer.name}"},
                    "sha256": hashlib.sha256(installer.read_bytes()).hexdigest(),
                }
                studio.update_info, studio.update_path = release, str(installer)
                with patch.object(QuietStudio, "desktopIntegrationAvailable", new_callable=lambda: property(lambda _s: True)), \
                     patch.object(updates, "installer_kind", return_value=kind), \
                     patch.object(updates, "load_ready", return_value={"path": str(installer), "release": release}), \
                     patch("studio.app_integration.install_appimage", return_value=str(installer)), \
                     patch("studio.QProcess.startDetached", return_value=(True, 1234)), \
                     patch("studio.QDesktopServices.openUrl", return_value=True):
                    studio.installUpdate()
                    deadline = time.monotonic() + 3
                    while studio.update_running and time.monotonic() < deadline:
                        self._pump(2)

                self.assertTrue(session.update_installed, kind)
                self.assertFalse(studio.backgroundEnabled or session.background.enabled or app.keep, kind)
                studio.host_window.hide()
                session.background.handle_window_visibility(studio)
                self.assertTrue(studio.retired, kind)

    def test_secondary_window_close_and_move_tab_retire_window_from_mcp_list_sessions(self):
        app = App()
        session = self._make_session()
        with patch("background_service.QSystemTrayIcon.isSystemTrayAvailable", return_value=False):
            session.background = BackgroundService(app, session, ROOT, lambda _: None, force=False)
        first = self._make_studio(session, visible=True)
        first.setting("keepInBackground", "true")
        first.setAgentAccessEnabled(True)
        second = self._make_studio(session, visible=True)
        third = self._make_studio(session, visible=True)

        for owner in (first, second, third):
            owner.agentRequest.connect(
                lambda raw, owner=owner: session.agent_bridge.complete(
                    json.loads(raw)["requestId"], {"tabs": json.loads(raw).get("tabs", [])}, "", window_id=owner.window_id
                )
            )
        server, _ = mcp_server.build_mcp_server([], live_client=MultiSessionLiveClient(session.agent_bridge.discovery_dir))

        def mcp_window_ids():
            from mcp import Client
            holder, done = {}, []
            def call():
                async def run_call():
                    async with Client(server) as client:
                        return (await client.call_tool("list_sessions", {})).structured_content
                try: holder["data"] = asyncio.run(run_call())
                finally: done.append(True)
            worker = threading.Thread(target=call, daemon=True)
            worker.start()
            deadline = time.monotonic() + 5
            while not done and time.monotonic() < deadline:
                self._pump(2)
            worker.join(timeout=1)
            return {row["windowId"] for row in holder["data"]["sessions"]}

        self.assertEqual(mcp_window_ids(), {first.window_id, second.window_id, third.window_id})
        second.host_window.hide()
        session.background.handle_window_visibility(second)
        self.assertTrue(second.retired and second.pool._shutdown and session.agent_bridge.enabled)
        self.assertEqual(mcp_window_ids(), {first.window_id, third.window_id})

        moved_tab_id = third.tabs[0]["id"]
        third.tabs[0]["content"] = "# Transferred note\n"
        third.allowClose.connect(lambda: (third.host_window.hide(), session.background.handle_window_visibility(third)))
        self.assertTrue(third._move_tab(first, moved_tab_id, 0))
        self._pump()
        self.assertTrue(third.retired)
        self.assertEqual(mcp_window_ids(), {first.window_id})
        self.assertIn(moved_tab_id, [tab["id"] for tab in first.tabs])

    def test_settings_page_qml_switch_toggles_keep_in_background_dynamically(self):
        app = App()
        session = self._make_session()
        studio = self._make_studio(session, visible=True)
        with patch("background_service.QSystemTrayIcon.isSystemTrayAvailable", return_value=False):
            session.background = BackgroundService(app, session, ROOT, lambda _: None, force=False)
        engine = QQmlEngine()
        engine.rootContext().setContextProperty("studio", studio)
        component = QQmlComponent(engine)
        qml = b'import QtQuick\nimport QtQuick.Controls\nimport QtQuick.Controls.Material\nApplicationWindow{id:h;width:960;height:720;visible:true;property var viewState:JSON.parse(studio.snapshot);SettingsPage{anchors.fill:parent;viewState:h.viewState}}'
        with patch.object(python_runtime, "discover", return_value=[]):
            component.setData(qml, QUrl.fromLocalFile(str(QML_DIR / "tray-settings-test.qml")))
            self.assertFalse(component.isError(), "\n".join(err.toString() for err in component.errors()))
            window = component.create()
        try:
            QTest.qWait(40)
            def find_named(name):
                stack = [window.contentItem()]
                while stack:
                    item = stack.pop()
                    if item.objectName() == name: return item
                    stack.extend(item.childItems())
                return None
            writing = find_named("settingsSection_writing")
            QTest.mouseClick(window, Qt.MouseButton.LeftButton, Qt.KeyboardModifier.NoModifier, writing.mapToScene(QPointF(writing.width() / 2, writing.height() / 2)).toPoint())
            QTest.qWait(40)
            toggle = find_named("keepInBackgroundSwitch")
            self.assertIsInstance(toggle, QQuickItem)
            self.assertFalse(bool(toggle.property("checked")))
            scroll = find_named("settingsScroll")
            if scroll is not None:
                scroll_content = scroll.property("contentItem")
                if scroll_content is not None:
                    top = toggle.mapToItem(scroll_content, QPointF(0, 0)).y()
                    scroll_content.setProperty("contentY", max(0.0, top - 48.0))
                    QTest.qWait(40)
            with patch("background_service.QSystemTrayIcon.isSystemTrayAvailable", return_value=False):
                pt = toggle.mapToScene(QPointF(toggle.width() / 2, toggle.height() / 2)).toPoint()
                QTest.mouseClick(window, Qt.MouseButton.LeftButton, Qt.KeyboardModifier.NoModifier, pt)
                QTest.qWait(40)
                self.assertTrue(session.settings["keepInBackground"] and session.background.enabled and app.keep)
                QTest.mouseClick(window, Qt.MouseButton.LeftButton, Qt.KeyboardModifier.NoModifier, pt)
                QTest.qWait(40)
                self.assertFalse(session.settings["keepInBackground"] or session.background.enabled or app.keep)
        finally:
            window.close()
            window.deleteLater()
            self.qt_app.sendPostedEvents(None, QEvent.Type.DeferredDelete)
            engine.deleteLater()
            self.qt_app.sendPostedEvents(None, QEvent.Type.DeferredDelete)

    def test_daemon_command_resolves_windows_gui_and_linux_appimage_executables(self):
        with tempfile.TemporaryDirectory(prefix="supermd-cmd-") as tmp:
            root = Path(tmp)
            cli_exe, gui_exe = root / "super-md-cli.exe", root / "super-md.exe"
            cli_exe.write_bytes(b"cli")
            gui_exe.write_bytes(b"gui")
            win_cmd = background_cli._daemon_command(executable=cli_exe, frozen=True, platform="win32")
            self.assertEqual(win_cmd, [str(gui_exe.resolve()), "--background", "--agent-access"])

            appdir = root / "mount"
            mounted = appdir / "usr/bin/super-md"
            mounted.parent.mkdir(parents=True)
            mounted.write_bytes(b"bin")
            appimage = root / "Super.MD.AppImage"
            appimage.write_bytes(b"appimage")
            linux_cmd = background_cli._daemon_command(
                executable=mounted, frozen=True, platform="linux", env={"APPIMAGE": str(appimage), "APPDIR": str(appdir)}
            )
            self.assertEqual(linux_cmd, [str(appimage.resolve()), "--background", "--agent-access"])

    def test_upgrade_migration_preserves_legacy_background_and_agent_settings_without_opting_in_reader_only_users(self):
        root_temp = Path(tempfile.mkdtemp(prefix="supermd-upgrade-")).resolve()
        self.addCleanup(lambda: shutil.rmtree(root_temp, ignore_errors=True))
        orig_writable = QStandardPaths.writableLocation

        def make_env(profile_name: str) -> Path:
            appdata = (root_temp / profile_name).resolve()
            (appdata / "qt-studio").mkdir(parents=True, exist_ok=True)
            return appdata

        # 1. Pre-#41 user who had agentAccessEnabled:true in settings.json (no keepInBackground key),
        #    Unicode note paths, widthPercent:80 legacy default, and custom PDF/font settings.
        appdata_agent = make_env("Profile Α — Agent User (2026)")
        pinned_note = str(appdata_agent / "Δ-field derivations (v2).smd")
        recent_note = str(appdata_agent / "日本語ノート — 量子統計力学.md")
        atomic_json(
            appdata_agent / "qt-studio" / "settings.json",
            {
                "settings": {
                    "font": "IBM Plex Serif",
                    "size": 17.5,
                    "widthPercent": 80,
                    "agentAccessEnabled": True,
                    "cloudAgentEnabled": False,
                    "pdf": {"paperSize": "A4", "margins": "wide"},
                },
                "pinned": [pinned_note],
                "recent": [pinned_note, recent_note],
            },
        )
        with patch.object(
            QStandardPaths,
            "writableLocation",
            side_effect=lambda k, p=appdata_agent: str(p) if k == QStandardPaths.StandardLocation.AppDataLocation else orig_writable(k),
        ):
            upgraded_session = Session(False)
            try:
                self.assertIs(upgraded_session.settings["keepInBackground"], True)
                self.assertIs(upgraded_session.settings["agentAccessEnabled"], True)
                self.assertEqual(upgraded_session.settings["widthPercent"], 90)
                self.assertEqual(upgraded_session.settings["font"], "IBM Plex Serif")
                self.assertEqual(upgraded_session.settings["pdf"]["paperSize"], "A4")
                self.assertEqual(upgraded_session.pinned, [pinned_note])
                self.assertEqual(upgraded_session.recent, [pinned_note, recent_note])
                persisted = json.loads((appdata_agent / "qt-studio" / "settings.json").read_text(encoding="utf-8"))
                self.assertIs(persisted["settings"]["keepInBackground"], True)
                self.assertIs(persisted["settings"]["agentAccessEnabled"], True)
                app_stub = App()
                with patch("background_service.QSystemTrayIcon.isSystemTrayAvailable", return_value=False):
                    svc = BackgroundService(app_stub, upgraded_session, ROOT, lambda _: None, force=False)
                self.assertTrue(svc.enabled and app_stub.keep)

                # Once the upgraded user explicitly turns keepInBackground off, later launches respect False
                # even if legacy background-service.log and agent-sessions artifacts still exist on disk.
                (appdata_agent / "background-service.log").write_text("legacy daemon started\n", encoding="utf-8")
                (appdata_agent / "qt-studio" / "agent-sessions").mkdir(parents=True, exist_ok=True)
                with patch.object(python_runtime, "discover", return_value=[]), patch.object(
                    QuietStudio, "_restore_update", lambda _self: None
                ):
                    studio = QuietStudio(False, upgraded_session)
                    try:
                        studio.setting("keepInBackground", "false")
                    finally:
                        studio.stop()
                        studio.pool.shutdown(wait=True, cancel_futures=True)
            finally:
                upgraded_session.writes.shutdown(wait=True)

            reopened_after_opt_out = Session(False)
            try:
                self.assertIs(reopened_after_opt_out.settings["keepInBackground"], False)
            finally:
                reopened_after_opt_out.writes.shutdown(wait=True)

        # 2. Pre-#41 headless `super-md agent service start` user who never saved GUI settings.json,
        #    leaving only <AppDataLocation>/background-service.log and qt-studio/agent-sessions/.
        appdata_headless = make_env("Profile Β — Headless Service Only")
        (appdata_headless / "background-service.log").write_text(
            "Super MD: accelerated graphics unavailable; using software rendering.\n",
            encoding="utf-8",
        )
        (appdata_headless / "qt-studio" / "agent-sessions").mkdir(parents=True, exist_ok=True)
        self.assertFalse((appdata_headless / "qt-studio" / "settings.json").exists())
        with patch.object(
            QStandardPaths,
            "writableLocation",
            side_effect=lambda k, p=appdata_headless: str(p) if k == QStandardPaths.StandardLocation.AppDataLocation else orig_writable(k),
        ):
            headless_upgraded = Session(False)
            try:
                self.assertIs(headless_upgraded.settings["keepInBackground"], True)
                persisted_headless = json.loads(
                    (appdata_headless / "qt-studio" / "settings.json").read_text(encoding="utf-8")
                )
                self.assertIs(persisted_headless["settings"]["keepInBackground"], True)
            finally:
                headless_upgraded.writes.shutdown(wait=True)

        # 3. Pre-#41 cloud-paired user (cloudAgentEnabled:true + agent-cloud.json).
        appdata_cloud = make_env("Profile Γ — Cloud Relay")
        pairing = agent_cloud.new_pairing("https://relay.supermd.example")
        agent_cloud.write_cloud_config(
            appdata_cloud / "qt-studio" / "agent-cloud.json",
            agent_cloud.device_config(pairing),
        )
        atomic_json(
            appdata_cloud / "qt-studio" / "settings.json",
            {"settings": {"cloudAgentEnabled": True, "theme": "dark"}, "recent": [], "pinned": []},
        )
        with patch.object(
            QStandardPaths,
            "writableLocation",
            side_effect=lambda k, p=appdata_cloud: str(p) if k == QStandardPaths.StandardLocation.AppDataLocation else orig_writable(k),
        ):
            cloud_upgraded = Session(False)
            try:
                self.assertIs(cloud_upgraded.settings["keepInBackground"], True)
                self.assertIs(cloud_upgraded.settings["cloudAgentEnabled"], True)
            finally:
                cloud_upgraded.writes.shutdown(wait=True)

        # 4. Pre-#41 ordinary reader-only user, malformed explicit keepInBackground values,
        #    and corrupted settings.json preservation.
        appdata_reader = make_env("Profile Δ — Reader Only")
        atomic_json(
            appdata_reader / "qt-studio" / "settings.json",
            {
                "settings": {
                    "theme": "sepia",
                    "font": "Literata",
                    "agentAccessEnabled": False,
                    "cloudAgentEnabled": False,
                },
                "recent": [recent_note],
                "pinned": [],
            },
        )
        with patch.object(
            QStandardPaths,
            "writableLocation",
            side_effect=lambda k, p=appdata_reader: str(p) if k == QStandardPaths.StandardLocation.AppDataLocation else orig_writable(k),
        ):
            reader_upgraded = Session(False)
            try:
                self.assertIs(reader_upgraded.settings["keepInBackground"], False)
            finally:
                reader_upgraded.writes.shutdown(wait=True)

            for malformed in ("true", 1, ["true"], {"enabled": True}):
                atomic_json(
                    appdata_reader / "qt-studio" / "settings.json",
                    {"settings": {"keepInBackground": malformed, "agentAccessEnabled": True}},
                )
                malformed_session = Session(False)
                try:
                    self.assertIs(malformed_session.settings["keepInBackground"], False)
                finally:
                    malformed_session.writes.shutdown(wait=True)

            corrupt_bytes = b'{"settings": {"agentAccessEnabled": true, "broken": '
            (appdata_reader / "qt-studio" / "settings.json").write_bytes(corrupt_bytes)
            (appdata_reader / "background-service.log").write_text("daemon log\n", encoding="utf-8")
            corrupt_session = Session(False)
            try:
                self.assertIs(corrupt_session.settings["keepInBackground"], True)
                self.assertEqual((appdata_reader / "qt-studio" / "settings.json").read_bytes(), corrupt_bytes)
            finally:
                corrupt_session.writes.shutdown(wait=True)

        # 5. Fresh post-#41 CLI `service start` creates background-service.log with SUPERMD_FRESH_SERVICE_LOG=1:
        #    even if the user stops the service immediately without saving any note, subsequent normal GUI
        #    launches (without SUPERMD_FRESH_SERVICE_LOG) preserve keepInBackground=False and agentAccessEnabled=False.
        appdata_fresh_cli = make_env("Profile Ε — Fresh Post-41 CLI Service")
        (appdata_fresh_cli / "background-service.log").write_text("", encoding="utf-8")
        with patch.object(
            QStandardPaths,
            "writableLocation",
            side_effect=lambda k, p=appdata_fresh_cli: str(p) if k == QStandardPaths.StandardLocation.AppDataLocation else orig_writable(k),
        ):
            with patch.dict(os.environ, {"SUPERMD_FRESH_SERVICE_LOG": "1"}):
                first_cli_session = Session(False)
                try:
                    self.assertIs(first_cli_session.settings["keepInBackground"], False)
                    self.assertIs(first_cli_session.settings["agentAccessEnabled"], False)
                finally:
                    first_cli_session.writes.shutdown(wait=True)
            reopened_gui_session = Session(False)
            try:
                self.assertIs(reopened_gui_session.settings["keepInBackground"], False)
                self.assertIs(reopened_gui_session.settings["agentAccessEnabled"], False)
            finally:
                reopened_gui_session.writes.shutdown(wait=True)


_HEADLESS_DAEMON_BOOTSTRAP = """
import os, sys, time
from pathlib import Path

os.environ["QT_QPA_PLATFORM"] = "offscreen"
os.environ["QT_QUICK_BACKEND"] = "software"
os.environ.setdefault("QTWEBENGINE_CHROMIUM_FLAGS", "--disable-gpu --disable-dev-shm-usage")
os.environ.setdefault("QTWEBENGINE_DISABLE_SANDBOX", "1")

appdata = os.environ["SUPERMD_TEST_APPDATA"]
downloads = os.environ["SUPERMD_TEST_DOWNLOADS"]
desktop_dir = os.environ["SUPERMD_TEST_DESKTOP_DIR"]
cache_dir = str(Path(appdata) / "cache")
xdg_data_dir = str(Path(appdata) / "xdg-data")
Path(cache_dir).mkdir(parents=True, exist_ok=True)
Path(xdg_data_dir).mkdir(parents=True, exist_ok=True)
os.environ["XDG_CACHE_HOME"] = cache_dir
os.environ["XDG_DATA_HOME"] = xdg_data_dir
if desktop_dir not in sys.path:
    sys.path.insert(0, desktop_dir)

import graphics_runtime
graphics_runtime.configure(safe=True)

from PySide6.QtCore import QStandardPaths
from PySide6.QtWidgets import QSystemTrayIcon
import python_runtime

orig_writable = QStandardPaths.writableLocation
def _patched_writable(kind):
    if kind in (QStandardPaths.StandardLocation.AppDataLocation, QStandardPaths.StandardLocation.AppLocalDataLocation):
        return appdata
    if kind == QStandardPaths.StandardLocation.DownloadLocation:
        return downloads
    if kind in (QStandardPaths.StandardLocation.CacheLocation, QStandardPaths.StandardLocation.GenericCacheLocation):
        return cache_dir
    return orig_writable(kind)

QStandardPaths.writableLocation = staticmethod(_patched_writable)
QSystemTrayIcon.isSystemTrayAvailable = staticmethod(lambda: False)
python_runtime.discover = lambda *_a, **_kw: []

from studio import Studio
Studio._restore_update = lambda self: None

import main as desktop_main
sys.argv = [str(Path(desktop_dir) / "main.py"), "--background", "--agent-access", "--safe-graphics"]
desktop_main._exit_process(desktop_main.main())
"""


_IPC_WORKER = """
import contextlib, io, json, os, subprocess as real_subprocess, sys, threading, time
from unittest.mock import MagicMock, patch
from PySide6.QtCore import QCoreApplication, QStandardPaths
app = QCoreApplication.instance() or QCoreApplication(["super-md"])
orig = QStandardPaths.writableLocation
import agent_cli, background_cli
from instance import InstanceBroker
_spawned_lock = threading.Lock()
_spawned_procs = []
def _reap_loop():
    while True:
        with _spawned_lock:
            alive = []
            for p in _spawned_procs:
                if p.poll() is None:
                    alive.append(p)
            _spawned_procs[:] = alive
        time.sleep(0.03)
threading.Thread(target=_reap_loop, daemon=True).start()
cin, cout = sys.stdin, sys.stdout
for raw in cin:
    cmd = json.loads(raw)
    if cmd["kind"] == "quit":
        with _spawned_lock:
            lingering = list(_spawned_procs)
        for p in lingering:
            if p.poll() is None:
                try: p.terminate()
                except Exception: pass
        break
    appdata = cmd["appdata"]
    with patch.object(QStandardPaths, "writableLocation", side_effect=lambda k, p=appdata: p if k == QStandardPaths.StandardLocation.AppDataLocation else orig(k)):
        if cmd["kind"] == "claim":
            broker = InstanceBroker()
            try:
                claimed = broker.claim_or_forward(
                    cmd.get("note"),
                    defer_listen=bool(cmd.get("deferListen", False)),
                    open_existing=bool(cmd.get("openExisting", True)),
                )
            finally:
                if broker.lock.isLocked():
                    broker.close()
                else:
                    broker.stop_accepting()
                broker.deleteLater()
            cout.write(json.dumps({"claimed": claimed}) + "\\n"); cout.flush()
        else:
            out, err, marker = io.StringIO(), io.StringIO(), cmd.get("spawnMarker")
            real_spawn = cmd.get("realSpawn")
            orig_popen = real_subprocess.Popen
            call_procs = []
            def _write_marker(path, data):
                tmp = path + ".tmp"
                with open(tmp, "w", encoding="utf-8") as fh:
                    fh.write(json.dumps(data))
                os.replace(tmp, path)
            def fake_popen(spawn_cmd, **kwargs):
                if real_spawn:
                    env = dict(kwargs.get("env") or os.environ)
                    env["SUPERMD_TEST_APPDATA"] = appdata
                    env["SUPERMD_TEST_DOWNLOADS"] = cmd["downloads"]
                    env["SUPERMD_TEST_DESKTOP_DIR"] = cmd["desktopDir"]
                    for ek, ev in (cmd.get("extraEnv") or {}).items():
                        env[str(ek)] = str(ev)
                    os.makedirs(appdata, exist_ok=True)
                    bootstrap_file = os.path.join(appdata, f"_daemon_bootstrap_{time.monotonic_ns()}.py")
                    with open(bootstrap_file, "w", encoding="utf-8") as bfh:
                        bfh.write(cmd["daemonBootstrap"])
                    popen_kw = {
                        "stdin": kwargs.get("stdin"),
                        "stdout": kwargs.get("stdout"),
                        "stderr": kwargs.get("stderr"),
                        "env": env,
                        "start_new_session": kwargs.get("start_new_session", False),
                        "creationflags": kwargs.get("creationflags", 0),
                    }
                    if "process_group" in kwargs:
                        popen_kw["process_group"] = kwargs["process_group"]
                    proc = orig_popen([sys.executable, "-u", bootstrap_file], **popen_kw)
                    call_procs.append(proc)
                    if marker:
                        _write_marker(marker, {"cmd": spawn_cmd, "pid": proc.pid})
                    return proc
                if not marker: raise AssertionError("Unexpected Popen")
                _write_marker(marker, spawn_cmd); return MagicMock()
            try:
                with patch.object(background_cli.subprocess, "Popen", side_effect=fake_popen), patch.object(sys, "stdin", io.StringIO("")), contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
                    try: code = agent_cli.main(["service", cmd["action"]])
                    except SystemExit as exc: code = exc.code if isinstance(exc.code, int) else 1
                    except Exception as exc: err.write(repr(exc)); code = 1
            finally:
                if call_procs:
                    with _spawned_lock:
                        _spawned_procs.extend(call_procs)
            cout.write(json.dumps({"code": code, "stdout": out.getvalue(), "stderr": err.getvalue()}) + "\\n"); cout.flush()
"""


class InstanceBrokerAndServiceCliTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if QApplication.instance() is None:
            QQuickStyle.setStyle("Material")
        cls.qt_app = QApplication.instance() or QApplication(["InstanceBrokerAndServiceCliTests"])
        cls._worker = subprocess.Popen(
            [sys.executable, "-u", "-c", _IPC_WORKER],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            text=True, encoding="utf-8",
            env={
                **os.environ,
                "QT_QPA_PLATFORM": "offscreen",
                "PYTHONPATH": str(DESKTOP_DIR),
                "PYTHONUTF8": "1",
                "PYTHONIOENCODING": "utf-8",
            },
        )

    @classmethod
    def tearDownClass(cls):
        worker = getattr(cls, "_worker", None)
        if not worker: return
        try:
            if worker.poll() is None and worker.stdin:
                worker.stdin.write('{"kind":"quit"}\n')
                worker.stdin.flush()
                worker.wait(timeout=3)
        except Exception:
            pass
        if worker.poll() is None:
            worker.kill()
        try: worker.communicate(timeout=2)
        except Exception: pass

    def setUp(self):
        self.temp_appdata = Path(tempfile.mkdtemp(prefix="supermd-ipc-")).resolve()
        self.addCleanup(lambda: shutil.rmtree(self.temp_appdata, ignore_errors=True))
        orig = QStandardPaths.writableLocation
        self._orig_writable = orig
        patcher = patch.object(QStandardPaths, "writableLocation", side_effect=lambda k: str(self.temp_appdata) if k == QStandardPaths.StandardLocation.AppDataLocation else orig(k))
        patcher.start()
        self.addCleanup(patcher.stop)
        self.session = Session(True)
        self.session.settings["python"] = sys.executable
        self.addCleanup(lambda: shutil.rmtree(self.session.data, ignore_errors=True))
        self.addCleanup(self.session.writes.shutdown, wait=True)
        self.session.agent_bridge = agent_live.create_qt_bridge(self.session, self.session.data)
        self.addCleanup(self.session.agent_bridge.stop)
        self.studio = QuietStudio(True, self.session)
        self.studio.host_window = _VisibleHost(visible=True)
        self.addCleanup(lambda: (self.studio.stop(), self.studio.pool.shutdown(wait=True, cancel_futures=True)))
        self.app_stub = App()
        tray_patch = patch("background_service.QSystemTrayIcon.isSystemTrayAvailable", return_value=False)
        tray_patch.start()
        self.addCleanup(tray_patch.stop)
        self.session.background = BackgroundService(self.app_stub, self.session, ROOT, lambda _: None, force=False)
        self.broker = InstanceBroker(self.qt_app, service_handler=self.session.background.handle_service_request)
        self.addCleanup(self.broker.close)
        self.assertTrue(self.broker.claim_or_forward(None))

    def _call(self, payload: dict, *, on_tick=None, timeout: float = 8.0) -> dict:
        self.assertIsNone(self._worker.poll(), "IPC worker exited unexpectedly")
        reply, errors = {}, []
        def reader():
            try:
                self._worker.stdin.write(json.dumps(payload) + "\n")
                self._worker.stdin.flush()
                line = self._worker.stdout.readline()
                if not line:
                    raise RuntimeError(f"IPC worker EOF: {self._worker.stderr.read() if self._worker.poll() is not None else ''}")
                reply["data"] = json.loads(line)
            except BaseException as exc:
                errors.append(exc)
        thread = threading.Thread(target=reader, daemon=True)
        thread.start()
        deadline = time.monotonic() + timeout
        while thread.is_alive() and time.monotonic() < deadline:
            if on_tick: on_tick()
            self.qt_app.processEvents()
            time.sleep(0.005)
        thread.join(timeout=1)
        self.qt_app.processEvents()
        if errors: raise errors[0]
        self.assertIn("data", reply, "IPC worker timed out")
        return reply["data"]

    def _service(self, action: str):
        res = self._call({"kind": "service", "action": action, "appdata": str(self.temp_appdata)})
        return res["code"], json.loads(res["stdout"])

    def test_note_forwarding_preserves_single_instance_lock_and_ok_ack(self):
        forwarded = []
        self.broker.requested.connect(forwarded.append)
        note_path = self.temp_appdata / "hello.md"
        note_path.write_text("# Hello\n", encoding="utf-8")
        res = self._call({"kind": "claim", "note": str(note_path), "appdata": str(self.temp_appdata)})
        self.assertIs(res["claimed"], False)
        self.assertEqual(forwarded, [str(note_path.resolve())])

    def test_service_status_start_and_stop_respect_gui_consent_and_open_windows(self):
        code, status = self._service("status")
        self.assertEqual((code, status["result"]["running"], status["result"]["agentAccess"]), (0, False, False))

        # Refuses unconsented background escalation on an open GUI window.
        code, denied = self._service("start")
        self.assertEqual(code, 2)
        self.assertFalse(denied["ok"] or self.session.agent_bridge.enabled or self.session.background.enabled)

        # Succeeds once the user explicitly enables live agent access in the GUI session.
        self.studio.setting("keepInBackground", "true")
        self.studio.setAgentAccessEnabled(True)
        code, started = self._service("start")
        self.assertEqual(code, 0)
        self.assertTrue(started["result"]["running"] and self.session.background.enabled)
        self.assertEqual(started["result"]["sessionsDirectory"], str(self.session.agent_bridge.discovery_dir))

        # Stopping while a GUI window is visible disables background mode without closing the window.
        code, stopped = self._service("stop")
        self.assertEqual((code, stopped["result"]["running"], stopped["result"]["quitRequested"]), (0, False, False))
        self.assertFalse(self.session.background.enabled or self.session.settings["keepInBackground"] or self.app_stub.ended)
        self.assertTrue(self.studio.host_window.isVisible() and not self.studio.retired)

        # Stopping when no GUI windows are visible quits the headless/hidden daemon cleanly.
        self.studio.host_window.hide()
        self.session.background.set_forced(True)
        with patch.object(self.studio, "closeWindowSafely", side_effect=self.studio.allowClose.emit):
            code, quit_res = self._service("stop")
            self.qt_app.processEvents()
        self.assertEqual((code, quit_res["result"]["running"], quit_res["result"]["quitRequested"]), (0, False, True))
        self.assertTrue(self.session.background.quitting and self.app_stub.ended)

    def test_service_cli_handles_absent_instance_shutdown_handoff_and_cold_start_polling(self):
        # Simulate aboutToQuit closing the IPC server shortly before lock release.
        self.broker.server.close()
        self.assertEqual(self._service("status")[1]["result"]["running"], False)
        release_state = {"started": time.monotonic(), "unlocked": False}
        def release_soon():
            if not release_state["unlocked"] and time.monotonic() - release_state["started"] >= 0.15:
                release_state["unlocked"] = True
                self.broker.lock.unlock()
        claim_res = self._call({"kind": "claim", "note": None, "appdata": str(self.temp_appdata)}, on_tick=release_soon)
        self.assertIs(claim_res["claimed"], True)
        self.broker.close()
        self.assertEqual(self._service("stop")[1]["result"], {"running": False, "action": "stop", "quitRequested": False})

        # Simulate cold start where InstanceBroker binds QLocalServer immediately in claim_or_forward(),
        # then main.py blocks >2.0s initializing WebEngine/QML before entering app.exec().
        spawned, cold_state, marker = [], {}, self.temp_appdata / "spawned.json"
        def bring_up_daemon():
            if marker.is_file() and not spawned:
                spawned.append(json.loads(marker.read_text(encoding="utf-8")))
                cold_state["bound_at"] = time.monotonic()
                self.broker.server.newConnection.disconnect(self.broker.accept)
                self.assertTrue(self.broker.claim_or_forward(None))
            elif spawned and not cold_state.get("event_loop_ready") and time.monotonic() - cold_state["bound_at"] >= 2.4:
                cold_state["event_loop_ready"] = True
                self.session.settings["agentAccessEnabled"] = True
                self.session.agent_bridge.start()
                self.session.background.set_forced(True)
                self.broker.server.newConnection.connect(self.broker.accept)
                self.broker.accept()

        res = self._call({"kind": "service", "action": "start", "appdata": str(self.temp_appdata), "spawnMarker": str(marker)}, on_tick=bring_up_daemon, timeout=12.0)
        self.assertEqual(res["code"], 0, res)
        self.assertTrue(json.loads(res["stdout"])["result"]["running"])
        self.assertIn("--background", spawned[0])
        self.assertIn("--agent-access", spawned[0])

    def _service_for_appdata(self, appdata: Path, action: str, **extra):
        log_path = appdata / "background-service.log"
        diag_path = appdata / "daemon-diag.log"
        try:
            res = self._call(
                {"kind": "service", "action": action, "appdata": str(appdata), **extra},
                timeout=75.0 if extra.get("realSpawn") else 15.0,
            )
        except AssertionError as exc:
            log_tail = log_path.read_text(encoding="utf-8", errors="replace")[-3000:] if log_path.is_file() else ""
            diag_tail = diag_path.read_text(encoding="utf-8", errors="replace")[-2000:] if diag_path.is_file() else ""
            raise AssertionError(f"{exc}; log={log_tail}; diag={diag_tail}") from exc
        log_tail = log_path.read_text(encoding="utf-8", errors="replace")[-2000:] if log_path.is_file() else ""
        diag_tail = diag_path.read_text(encoding="utf-8", errors="replace")[-2000:] if diag_path.is_file() else ""
        self.assertTrue(res["stdout"].strip(), f"Empty CLI output; stderr={res['stderr']}; log={log_tail}; diag={diag_tail}")
        return res["code"], json.loads(res["stdout"])

    def _dispatch_headless_live_request(self, studio, raw_request: str):
        req = json.loads(raw_request)
        action = req.get("action")
        bridge = studio.session.agent_bridge
        if action == "list_tabs":
            bridge.complete(req["requestId"], {"tabs": req.get("tabs", [])}, "", window_id=studio.window_id)
        elif action == "flush_current":
            bridge.complete(req["requestId"], {"ok": True}, "", window_id=studio.window_id)
        else:
            bridge.complete(req["requestId"], None, f"Unexpected headless request: {action}", window_id=studio.window_id)

    def _live_call(self, client: LiveTabClient, action: str, **kwargs) -> dict:
        holder, errs, done = {}, [], []
        def run_client():
            try:
                holder["result"] = client._call(action, **kwargs)
            except BaseException as exc:
                errs.append(exc)
            finally:
                done.append(True)
        worker = threading.Thread(target=run_client, daemon=True)
        worker.start()
        deadline = time.monotonic() + 8.0
        while not done and time.monotonic() < deadline:
            self.qt_app.processEvents()
            time.sleep(0.005)
        worker.join(timeout=1.0)
        self.qt_app.processEvents()
        if errs:
            raise errs[0]
        self.assertIn("result", holder, f"LiveTabClient({action}) timed out")
        return holder["result"]

    def test_cli_service_matrix_against_no_instance_with_unicode_appdata(self):
        self.broker.close()
        unicode_appdata = (self.temp_appdata / "Super MD — Ελληνικά & 日本語 (2026)").resolve()
        unicode_appdata.mkdir(parents=True, exist_ok=True)

        code, status_payload = self._service_for_appdata(unicode_appdata, "status")
        self.assertEqual(code, 0)
        self.assertEqual(status_payload, {"ok": True, "result": {"running": False, "action": "status"}})

        code, stop_payload = self._service_for_appdata(unicode_appdata, "stop")
        self.assertEqual(code, 0)
        self.assertEqual(
            stop_payload,
            {"ok": True, "result": {"running": False, "action": "stop", "quitRequested": False}},
        )

        marker = unicode_appdata / "cold-spawn.json"
        with patch.object(
            QStandardPaths,
            "writableLocation",
            side_effect=lambda kind: str(unicode_appdata)
            if kind == QStandardPaths.StandardLocation.AppDataLocation
            else self._orig_writable(kind),
        ):
            cold_broker = InstanceBroker(self.qt_app, service_handler=self.session.background.handle_service_request)
            self.addCleanup(cold_broker.close)

            def on_cold_tick():
                if marker.is_file() and not cold_broker.server.isListening():
                    self.session.settings["agentAccessEnabled"] = True
                    self.session.agent_bridge.start()
                    self.session.background.set_forced(True)
                    self.assertTrue(cold_broker.claim_or_forward(None))

            res = self._call(
                {
                    "kind": "service",
                    "action": "start",
                    "appdata": str(unicode_appdata),
                    "spawnMarker": str(marker),
                },
                on_tick=on_cold_tick,
                timeout=10.0,
            )
            self.assertEqual(res["code"], 0)
            self.assertEqual(
                json.loads(res["stdout"]),
                {
                    "ok": True,
                    "result": {
                        "running": True,
                        "action": "start",
                        "sessionsDirectory": str(unicode_appdata / "qt-studio" / "agent-sessions"),
                    },
                },
            )
            self.assertTrue((unicode_appdata / "background-service.log").is_file())

    def test_cli_service_matrix_against_gui_instance_with_keep_in_background_off(self):
        rich_draft = (
            "# Navier–Stokes Regularity Notes (Draft)\n\n"
            "$$\\partial_t u + (u \\cdot \\nabla)u = -\\nabla p + \\nu \\Delta u$$\n\n"
            "| Regime | Reynolds $Re$ | Behavior |\n|---|---:|---|\n| Laminar | 120 | Stable |\n"
        )
        self.studio._current().update(
            name="Navier-Stokes — Draft.md",
            content=rich_draft,
            saved="# Navier–Stokes Regularity Notes\n",
        )
        self.assertIs(self.session.settings["keepInBackground"], False)
        self.assertFalse(self.session.background.enabled or self.session.agent_bridge.enabled)

        code, status_payload = self._service("status")
        self.assertEqual(code, 0)
        self.assertEqual(
            status_payload,
            {"ok": True, "result": {"running": False, "action": "status", "agentAccess": False}},
        )

        code, start_payload = self._service("start")
        self.assertEqual(code, 2)
        self.assertFalse(start_payload["ok"])
        self.assertEqual(start_payload["error"]["type"], "ValueError")
        self.assertIn("Settings", start_payload["error"]["message"])
        self.assertFalse(self.session.background.enabled or self.session.agent_bridge.enabled)

        code, stop_payload = self._service("stop")
        self.assertEqual(code, 0)
        self.assertEqual(
            stop_payload,
            {"ok": True, "result": {"running": False, "action": "stop", "quitRequested": False}},
        )
        self.assertTrue(self.studio.host_window.isVisible() and not self.studio.retired)
        self.assertEqual(self.studio._current()["content"], rich_draft)

    def test_cli_service_matrix_against_gui_instance_with_keep_in_background_on(self):
        portable_png = (
            "data:image/png;base64,"
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg=="
        )
        portable_note = self.temp_appdata / "Spectroscopy — λ=532nm.smd"
        markdown_body = (
            "# Raman Spectroscopy Run (λ = 532 nm)\n\n"
            "![Calibration peak](assets/peak-532nm.png)\n\n"
            "$$I(\\omega) = I_0 \\frac{\\Gamma^2}{(\\omega - \\omega_0)^2 + \\Gamma^2}$$\n"
        )
        write_portable(portable_note, markdown_body, {"assets/peak-532nm.png": portable_png})
        self.studio._current().update(
            name=portable_note.name,
            path=str(portable_note),
            content=markdown_body + "\n- Unsaved baseline correction note\n",
            saved=markdown_body,
            assets={"assets/peak-532nm.png": portable_png},
            saved_assets={"assets/peak-532nm.png": portable_png},
            portable=True,
        )

        self.studio.setting("keepInBackground", "true")
        self.assertIs(self.session.settings["keepInBackground"], True)
        self.assertFalse(self.session.settings["agentAccessEnabled"] or self.session.agent_bridge.enabled)

        code, status_before = self._service("status")
        self.assertEqual(code, 0)
        self.assertEqual(
            status_before,
            {"ok": True, "result": {"running": True, "action": "status", "agentAccess": False}},
        )

        code, start_payload = self._service("start")
        self.assertEqual(code, 0)
        self.assertEqual(
            start_payload,
            {
                "ok": True,
                "result": {
                    "running": True,
                    "action": "start",
                    "sessionsDirectory": str(self.session.agent_bridge.discovery_dir),
                },
            },
        )
        self.assertTrue(self.session.agent_bridge.enabled and self.session.agent_bridge.discovery_path.is_file())

        self.studio.host_window.hide()
        self.session.background.handle_window_visibility(self.studio)
        self.assertTrue(self.session.agent_bridge.enabled)

        code, status_during = self._service("status")
        self.assertEqual(code, 0)
        self.assertEqual(
            status_during,
            {"ok": True, "result": {"running": True, "action": "status", "agentAccess": True}},
        )

        self.studio.host_window.show()
        self.session.background.handle_window_visibility(self.studio)
        code, stop_open = self._service("stop")
        self.assertEqual(code, 0)
        self.assertEqual(
            stop_open,
            {"ok": True, "result": {"running": False, "action": "stop", "quitRequested": False}},
        )
        self.assertFalse(
            self.session.background.enabled
            or self.session.settings["keepInBackground"]
            or self.session.agent_bridge.enabled
        )
        self.assertTrue(self.studio.host_window.isVisible())
        self.assertIn("Unsaved baseline correction", self.studio._current()["content"])

        self.studio.setting("keepInBackground", "true")
        self.studio.host_window.hide()
        self.session.background.handle_window_visibility(self.studio)
        code, hidden_status = self._service("status")
        self.assertEqual(code, 0)
        self.assertEqual(
            hidden_status,
            {"ok": True, "result": {"running": True, "action": "status", "agentAccess": False}},
        )
        with patch.object(self.studio, "closeWindowSafely", side_effect=self.studio.allowClose.emit):
            code, hidden_stop = self._service("stop")
            self.qt_app.processEvents()
        self.assertEqual(code, 0)
        self.assertEqual(
            hidden_stop,
            {"ok": True, "result": {"running": False, "action": "stop", "quitRequested": True}},
        )
        self.assertTrue(self.app_stub.ended)

    def test_cli_service_matrix_and_migration_for_running_headless_background_agent_access_instance(self):
        self.broker.close()
        daemon_appdata = (self.temp_appdata / "Headless Daemon — Δt & 漢字").resolve()
        daemon_downloads = (self.temp_appdata / "Exports — Δt").resolve()
        daemon_appdata.mkdir(parents=True, exist_ok=True)
        daemon_downloads.mkdir(parents=True, exist_ok=True)
        spawn_marker = daemon_appdata / "real-daemon-spawn.json"

        def cleanup_real_daemon():
            if not spawn_marker.is_file():
                return
            try:
                pid = json.loads(spawn_marker.read_text(encoding="utf-8")).get("pid")
            except Exception:
                pid = None
            if not pid:
                return
            try:
                if os.name == "nt":
                    subprocess.run(["taskkill", "/PID", str(pid), "/T", "/F"], capture_output=True, check=False)
                else:
                    import signal
                    os.kill(pid, signal.SIGTERM)
            except OSError:
                pass

        self.addCleanup(cleanup_real_daemon)

        # Phase 1: An ALREADY-RUNNING pre-#41 headless `--background --agent-access` daemon
        # (pre-#41 `ok\n` IPC socket + live QtBridge + background-service.log + no keepInBackground in settings.json)
        # continues serving the upgraded CLI (`status`, `start`, live note edits, `stop`) and migrates cleanly on restart.
        (daemon_appdata / "background-service.log").write_text(
            "Super MD pre-#41 headless background daemon started\n",
            encoding="utf-8",
        )
        legacy_settings_payload = {
            "settings": {
                "font": "IBM Plex Sans",
                "theme": "dark",
                "widthPercent": 92,
                "widthMigrated": True,
            },
            "recent": [],
            "pinned": [],
        }
        (daemon_appdata / "qt-studio").mkdir(parents=True, exist_ok=True)
        atomic_json(daemon_appdata / "qt-studio" / "settings.json", legacy_settings_payload)

        legacy_socket_name = "supermd-qt-" + hashlib.sha256(str(daemon_appdata).encode()).hexdigest()[:20]
        QLocalServer.removeServer(legacy_socket_name)
        legacy_server = QLocalServer(self.qt_app)
        legacy_server.setSocketOptions(QLocalServer.SocketOption.UserAccessOption)
        legacy_wire_actions = []

        with patch.object(
            QStandardPaths,
            "writableLocation",
            side_effect=lambda kind: str(daemon_appdata)
            if kind == QStandardPaths.StandardLocation.AppDataLocation
            else self._orig_writable(kind),
        ), patch.object(python_runtime, "discover", return_value=[]), patch.object(
            QuietStudio, "_restore_update", lambda _self: None
        ):
            legacy_session = Session(False)
            legacy_session.settings["python"] = sys.executable
            legacy_session.agent_bridge = agent_live.create_qt_bridge(legacy_session, legacy_session.data)
            legacy_studio = QuietStudio(False, legacy_session)
            legacy_studio.host_window = _VisibleHost(visible=False)
            legacy_studio.tabs[0]["name"] = "Covariant Conservation.md"
            legacy_studio.tabs[0]["content"] = "# Conservation Law\n\n$$\\nabla_\\mu T^{\\mu\\nu} = 0$$\n"
            legacy_initial_revision = hashlib.sha256(
                legacy_studio.tabs[0]["content"].encode("utf-8")
            ).hexdigest()
            legacy_studio.agentRequest.connect(
                lambda raw, owner=legacy_studio: self._dispatch_headless_live_request(owner, raw)
            )
            legacy_session.agent_bridge.start()
            # Restore authentic pre-#41 on-disk settings.json (no `keepInBackground` key yet while old process runs).
            atomic_json(daemon_appdata / "qt-studio" / "settings.json", legacy_settings_payload)

        def cleanup_legacy_headless():
            legacy_server.close()
            QLocalServer.removeServer(legacy_socket_name)
            legacy_session.agent_bridge.stop()
            legacy_studio.stop()
            legacy_studio.pool.shutdown(wait=True, cancel_futures=True)
            legacy_session.writes.shutdown(wait=True)

        self.addCleanup(cleanup_legacy_headless)

        def accept_legacy_headless():
            while legacy_server.hasPendingConnections():
                sock = legacy_server.nextPendingConnection()
                buf = bytearray()

                def on_legacy_read(sock=sock, buf=buf):
                    buf.extend(bytes(sock.readAll()))
                    if b"\n" not in buf:
                        return
                    req = json.loads(buf.split(b"\n", 1)[0])
                    if set(req) == {"service"} and req["service"] in ("start", "status", "quit"):
                        legacy_wire_actions.append(req["service"])
                        sock.write(b"ok\n")
                        sock.flush()
                        sock.waitForBytesWritten(500)
                        sock.disconnectFromServer()
                        if req["service"] == "quit":
                            legacy_session.agent_bridge.stop()
                            legacy_server.close()
                            QLocalServer.removeServer(legacy_socket_name)
                        return
                    sock.disconnectFromServer()

                sock.readyRead.connect(on_legacy_read)
                sock.disconnected.connect(sock.deleteLater)
                on_legacy_read()

        legacy_server.newConnection.connect(accept_legacy_headless)
        self.assertTrue(legacy_server.listen(legacy_socket_name))

        code, pre_upgrade_status = self._service_for_appdata(daemon_appdata, "status")
        self.assertEqual(code, 0)
        self.assertEqual(pre_upgrade_status, {"ok": True, "result": {"running": True, "action": "status"}})

        # Upgraded CLI `service start` against running pre-#41 headless instance must NOT spawn a duplicate process.
        code, pre_upgrade_start = self._service_for_appdata(daemon_appdata, "start")
        self.assertEqual(code, 0)
        self.assertFalse(spawn_marker.exists())
        expected_sessions_dir = daemon_appdata / "qt-studio" / "agent-sessions"
        self.assertEqual(
            pre_upgrade_start,
            {
                "ok": True,
                "result": {
                    "running": True,
                    "action": "start",
                    "sessionsDirectory": str(expected_sessions_dir),
                },
            },
        )

        # Live agent operations continue uninterrupted against the running pre-#41 headless instance.
        legacy_discovery_files = list(expected_sessions_dir.glob("*.json"))
        self.assertEqual(len(legacy_discovery_files), 1)
        legacy_live_client = self._live_call(
            LiveTabClient(legacy_discovery_files[0]),
            "patch_tab",
            tabId=legacy_studio.tabs[0]["id"],
            expectedRevision=legacy_initial_revision,
            operations=[
                {
                    "type": "replace",
                    "old": "$$\\nabla_\\mu T^{\\mu\\nu} = 0$$",
                    "new": "$$\\nabla_\\mu T^{\\mu\\nu} = F^{\\nu\\lambda} J_\\lambda$$",
                }
            ],
        )
        self.assertTrue(legacy_live_client["changed"])
        self.assertIn("F^{\\nu\\lambda} J_\\lambda", legacy_studio.tabs[0]["content"])

        # Stopping the pre-#41 headless instance via upgraded CLI sends `"quit"` and revokes its discovery file.
        code, pre_upgrade_stop = self._service_for_appdata(daemon_appdata, "stop")
        self.assertEqual(code, 0)
        self.assertEqual(
            pre_upgrade_stop,
            {"ok": True, "result": {"running": False, "action": "stop", "quitRequested": True}},
        )
        self.assertEqual(legacy_wire_actions, ["status", "start", "quit"])
        self.assertEqual(list(expected_sessions_dir.glob("*.json")), [])
        cleanup_legacy_headless()
        self.assertNotIn(
            "keepInBackground",
            json.loads((daemon_appdata / "qt-studio" / "settings.json").read_text(encoding="utf-8"))["settings"],
        )

        # Phase 2: Post-upgrade `service start` spawns the real post-#41 headless `--background --agent-access` daemon,
        # migrates persisted settings (`keepInBackground: True`), and serves live `.smd` agent operations.
        code, start_payload = self._service_for_appdata(
            daemon_appdata,
            "start",
            realSpawn=True,
            downloads=str(daemon_downloads),
            desktopDir=str(DESKTOP_DIR),
            daemonBootstrap=_HEADLESS_DAEMON_BOOTSTRAP,
            spawnMarker=str(spawn_marker),
        )
        self.assertEqual(
            code,
            0,
            f"payload={start_payload}; log={(daemon_appdata / 'background-service.log').read_text(encoding='utf-8', errors='replace') if (daemon_appdata / 'background-service.log').is_file() else ''}",
        )
        self.assertTrue(start_payload["ok"] and start_payload["result"]["running"])
        sessions_dir = Path(start_payload["result"]["sessionsDirectory"])
        self.assertEqual(sessions_dir, expected_sessions_dir)
        spawn_info = json.loads(spawn_marker.read_text(encoding="utf-8"))
        self.assertIn("--background", spawn_info["cmd"])
        self.assertIn("--agent-access", spawn_info["cmd"])
        migrated_disk_settings = json.loads(
            (daemon_appdata / "qt-studio" / "settings.json").read_text(encoding="utf-8")
        )["settings"]
        self.assertIs(migrated_disk_settings["keepInBackground"], True)
        self.assertEqual(migrated_disk_settings["font"], "IBM Plex Sans")
        self.assertEqual(migrated_disk_settings["theme"], "dark")

        code, status_payload = self._service_for_appdata(daemon_appdata, "status")
        self.assertEqual(code, 0)
        self.assertEqual(
            status_payload,
            {"ok": True, "result": {"running": True, "action": "status", "agentAccess": True}},
        )

        code, second_start = self._service_for_appdata(daemon_appdata, "start")
        self.assertEqual(code, 0)
        self.assertEqual(
            second_start,
            {
                "ok": True,
                "result": {
                    "running": True,
                    "action": "start",
                    "sessionsDirectory": str(sessions_dir),
                },
            },
        )

        discovery_files = list(sessions_dir.glob("*.json"))
        self.assertEqual(len(discovery_files), 1)
        client = LiveTabClient(discovery_files[0])
        scientific_markdown = (
            "# Magnetohydrodynamics Equilibrium — ∇×B = μ₀J\n\n"
            "## Grad–Shafranov Formulation\n\n"
            "$$\\Delta^* \\psi = -\\mu_0 R^2 \\frac{dp}{d\\psi} - F(\\psi)\\frac{dF}{d\\psi}$$\n\n"
            "```mermaid\nflowchart LR\n  Plasma[Plasma Core] --> Limiter[Divertor Target]\n```\n\n"
            "| Shot | $B_T$ (T) | $I_p$ (MA) |\n|---|---:|---:|\n| #10421 | 5.3 | 15.0 |\n"
        )
        created = client._call(
            "create_document",
            title="MHD Equilibrium — Iter",
            content=scientific_markdown,
            format="smd",
            background=False,
        )
        self.assertEqual(created["format"], "smd")
        self.assertTrue(created["isDirty"])
        read_back = client.read_tab(created["tabId"], view="source")
        self.assertIn("Grad–Shafranov Formulation", read_back["markdown"])

        patched = client._call(
            "patch_tab",
            tabId=created["tabId"],
            expectedRevision=created["revision"],
            operations=[
                {
                    "type": "replace",
                    "old": "| #10421 | 5.3 | 15.0 |",
                    "new": "| #10421 | 5.3 | 15.0 |\n| #10422 | 5.4 | 15.2 |",
                }
            ],
        )
        self.assertTrue(patched["changed"])

        saved = client._call(
            "save_document",
            tabId=created["tabId"],
            expectedRevision=patched["revision"],
            filename="mhd-equilibrium.smd",
            saveAs=True,
            format="smd",
        )
        saved_path = Path(saved["path"])
        self.assertTrue(saved_path.is_file())
        disk_md, disk_assets, disk_portable = open_note(saved_path)
        self.assertTrue(disk_portable)
        self.assertEqual(disk_assets, {})
        self.assertIn("| #10422 | 5.4 | 15.2 |", disk_md)

        # Phase 3: Immediate `stop` -> `start` handoff must never attach to a dying daemon or leave running:False;
        # it waits for shutdown and spawns a fresh live daemon with a rotated discovery token.
        first_pid = spawn_info["pid"]
        first_discovery_name = discovery_files[0].name
        code, stop_payload = self._service_for_appdata(daemon_appdata, "stop")
        self.assertEqual(code, 0)
        self.assertEqual(
            stop_payload,
            {"ok": True, "result": {"running": False, "action": "stop", "quitRequested": True}},
        )
        # Live discovery token must be revoked synchronously as soon as `service stop` returns.
        self.assertEqual(list(sessions_dir.glob("*.json")), [])

        code, restart_payload = self._service_for_appdata(
            daemon_appdata,
            "start",
            realSpawn=True,
            downloads=str(daemon_downloads),
            desktopDir=str(DESKTOP_DIR),
            daemonBootstrap=_HEADLESS_DAEMON_BOOTSTRAP,
            spawnMarker=str(spawn_marker),
        )
        self.assertEqual(
            code,
            0,
            f"payload={restart_payload}; log={(daemon_appdata / 'background-service.log').read_text(encoding='utf-8', errors='replace') if (daemon_appdata / 'background-service.log').is_file() else ''}",
        )
        self.assertTrue(restart_payload["ok"] and restart_payload["result"]["running"])
        restarted_info = json.loads(spawn_marker.read_text(encoding="utf-8"))
        self.assertNotEqual(restarted_info["pid"], first_pid)
        restarted_discovery = list(sessions_dir.glob("*.json"))
        self.assertEqual(len(restarted_discovery), 1)
        self.assertNotEqual(restarted_discovery[0].name, first_discovery_name)

        code, final_stop = self._service_for_appdata(daemon_appdata, "stop")
        self.assertEqual(code, 0)
        self.assertEqual(
            final_stop,
            {"ok": True, "result": {"running": False, "action": "stop", "quitRequested": True}},
        )

        from instance import is_process_exit_clear
        lock_probe = QLockFile(str(daemon_appdata / "native-instance.lock"))
        lock_probe.setStaleLockTime(0)
        deadline = time.monotonic() + 10.0
        fully_stopped = False
        while time.monotonic() < deadline:
            _, post_status = self._service_for_appdata(daemon_appdata, "status")
            if not post_status["result"]["running"] and lock_probe.tryLock(0):
                lock_probe.unlock()
                if is_process_exit_clear(daemon_appdata):
                    fully_stopped = True
                    break
            time.sleep(0.05)
        self.assertTrue(fully_stopped, "Headless daemon did not exit and release lock promptly after service stop")
        self.assertEqual(list(sessions_dir.glob("*.json")), [])
        recovered_tabs = json.loads((daemon_appdata / "qt-studio" / "recovery.json").read_text(encoding="utf-8"))
        self.assertTrue(any("F^{\\nu\\lambda} J_\\lambda" in tab.get("content", "") for tab in recovered_tabs))

        with patch.object(
            QStandardPaths,
            "writableLocation",
            side_effect=lambda kind: str(daemon_appdata)
            if kind == QStandardPaths.StandardLocation.AppDataLocation
            else self._orig_writable(kind),
        ):
            reopened = Session(False)
            try:
                self.assertIs(reopened.settings["keepInBackground"], True)
            finally:
                reopened.writes.shutdown(wait=True)

    def test_cli_service_matrix_against_legacy_ok_protocol_instance_and_malformed_replies(self):
        self.broker.close()
        legacy_appdata = (self.temp_appdata / "Legacy v0.4 Instance — Mixed Update").resolve()
        legacy_appdata.mkdir(parents=True, exist_ok=True)
        socket_name = "supermd-qt-" + hashlib.sha256(str(legacy_appdata).encode()).hexdigest()[:20]
        QLocalServer.removeServer(socket_name)

        received_wire_actions = []
        held_sockets = []
        reply_mode = {"kind": "legacy_ok"}
        server = QLocalServer(self.qt_app)
        server.setSocketOptions(QLocalServer.SocketOption.UserAccessOption)

        def accept_legacy():
            while server.hasPendingConnections():
                sock = server.nextPendingConnection()
                buf = bytearray()

                def on_read(sock=sock, buf=buf):
                    buf.extend(bytes(sock.readAll()))
                    if b"\n" not in buf:
                        return
                    req = json.loads(buf.split(b"\n", 1)[0])
                    mode = reply_mode["kind"]
                    if mode == "legacy_ok":
                        # Pre-#41 InstanceBroker contract: ONLY ("start", "status", "quit") are accepted.
                        if set(req) == {"service"} and req["service"] in ("start", "status", "quit"):
                            received_wire_actions.append(req["service"])
                            sock.write(b"ok\n")
                            sock.flush()
                            sock.waitForBytesWritten(500)
                        sock.disconnectFromServer()
                    elif mode == "shutdown_close":
                        sock.disconnectFromServer()
                    elif mode == "hung":
                        held_sockets.append(sock)
                    elif mode == "garbage":
                        sock.write(b"not-valid-json-and-not-ok\n")
                        sock.flush()
                        sock.waitForBytesWritten(500)
                        sock.disconnectFromServer()
                    elif mode == "json_array":
                        sock.write(b"[1, 2, 3]\n")
                        sock.flush()
                        sock.waitForBytesWritten(500)
                        sock.disconnectFromServer()

                sock.readyRead.connect(on_read)
                sock.disconnected.connect(sock.deleteLater)
                on_read()

        def cleanup_legacy_server():
            for s in held_sockets:
                try:
                    s.disconnectFromServer()
                except RuntimeError:
                    pass
            server.close()
            QLocalServer.removeServer(socket_name)

        server.newConnection.connect(accept_legacy)
        self.assertTrue(server.listen(socket_name))
        self.addCleanup(cleanup_legacy_server)

        # 1. `status` against old-protocol instance replying `ok\n`
        code, status_payload = self._service_for_appdata(legacy_appdata, "status")
        self.assertEqual(code, 0)
        self.assertEqual(status_payload, {"ok": True, "result": {"running": True, "action": "status"}})

        # 2. `start` against old-protocol instance replying `ok\n` (no duplicate Popen)
        code, start_payload = self._service_for_appdata(legacy_appdata, "start")
        self.assertEqual(code, 0)
        self.assertEqual(
            start_payload,
            {
                "ok": True,
                "result": {
                    "running": True,
                    "action": "start",
                    "sessionsDirectory": str(legacy_appdata / "qt-studio" / "agent-sessions"),
                },
            },
        )

        # 3. `stop` against old-protocol instance sends wire action `"quit"` and parses `ok\n` cleanly
        code, stop_payload = self._service_for_appdata(legacy_appdata, "stop")
        self.assertEqual(code, 0)
        self.assertEqual(
            stop_payload,
            {"ok": True, "result": {"running": False, "action": "stop", "quitRequested": True}},
        )
        self.assertEqual(received_wire_actions, ["status", "start", "quit"])

        # 4. Shutting-down peer closing socket cleanly reports running:False; hung/malformed peers fail loudly.
        reply_mode["kind"] = "shutdown_close"
        code, closing_payload = self._service_for_appdata(legacy_appdata, "status")
        self.assertEqual(code, 0)
        self.assertEqual(closing_payload, {"ok": True, "result": {"running": False, "action": "status"}})

        for broken_mode, expected_fragment in (
            ("hung", "did not respond"),
            ("garbage", "Invalid response"),
            ("json_array", "Invalid response"),
        ):
            reply_mode["kind"] = broken_mode
            code, err_payload = self._service_for_appdata(legacy_appdata, "status")
            self.assertEqual(code, 2)
            self.assertFalse(err_payload["ok"])
            self.assertEqual(err_payload["error"]["type"], "ValueError")
            self.assertIn(expected_fragment, err_payload["error"]["message"])

    def test_hidden_occluded_reader_live_ops_and_post_unlock_teardown_restart(self):
        self.broker.close()
        from instance import is_process_exit_clear

        occluded_appdata = (self.temp_appdata / "Occluded Hidden Daemon & C++ Teardown").resolve()
        occluded_downloads = (self.temp_appdata / "Occluded Downloads").resolve()
        occluded_appdata.mkdir(parents=True, exist_ok=True)
        occluded_downloads.mkdir(parents=True, exist_ok=True)
        spawn_marker = occluded_appdata / "spawn.json"
        ready_marker = occluded_appdata / "reader-ready.txt"
        sim_singleton = occluded_appdata / "sim-cpp-singleton.lock"

        def cleanup_daemon():
            if not spawn_marker.is_file():
                return
            try:
                pid = json.loads(spawn_marker.read_text(encoding="utf-8")).get("pid")
            except Exception:
                pid = None
            if not pid:
                return
            try:
                if os.name == "nt":
                    subprocess.run(["taskkill", "/PID", str(pid), "/T", "/F"], capture_output=True, check=False)
                else:
                    import signal
                    os.kill(pid, signal.SIGTERM)
            except OSError:
                pass

        self.addCleanup(cleanup_daemon)

        occluded_teardown_bootstrap = (
            """
import os, sys, time
_dd = os.environ["SUPERMD_TEST_DESKTOP_DIR"]
if _dd not in sys.path:
    sys.path.insert(0, _dd)
from instance import _try_lock_lifecycle
_sim_fd = os.open(os.environ["SUPERMD_TEST_SIM_SINGLETON"], os.O_RDWR | os.O_CREAT, 0o600)
_sim_fh = os.fdopen(_sim_fd, "r+b")
if _sim_fh.seek(0, os.SEEK_END) == 0:
    _sim_fh.write(b"\\0")
    _sim_fh.flush()
if not _try_lock_lifecycle(_sim_fh):
    sys.stderr.write("FATAL: Previous daemon still tearing down C++ resources after broker.close()!\\n")
    sys.exit(1)
"""
            + _HEADLESS_DAEMON_BOOTSTRAP.replace(
                "from studio import Studio\nStudio._restore_update = lambda self: None",
                """from PySide6.QtCore import QTimer
from studio import Studio
Studio._restore_update = lambda self: None
_orig_init = Studio.__init__
def _occluded_init(self, *args, **kwargs):
    _orig_init(self, *args, **kwargs)
    def _force_hidden_ready():
        if getattr(self, "host_window", None) is not None and not self.host_window.isVisible():
            self.ready = True
            self._emit(False)
            self.readerCall.emit("window.supermdAgentRequest = function(){}; window.supermdFlush = function(){};")
            Path(os.environ["SUPERMD_TEST_READY_MARKER"]).write_text("ready", encoding="utf-8")
    QTimer.singleShot(50, _force_hidden_ready)
Studio.__init__ = _occluded_init
_orig_post = Studio.post
def _occluded_post(self, id, command, raw):
    _orig_post(self, id, command, raw)
    if command == "reader_ready" and getattr(self, "host_window", None) is not None and not self.host_window.isVisible():
        self.readerCall.emit("window.supermdAgentRequest = function(){}; window.supermdFlush = function(){};")
Studio.post = _occluded_post""",
            ).replace(
                "desktop_main._exit_process(desktop_main.main())",
                """rc = desktop_main.main()
time.sleep(0.45)
desktop_main._exit_process(rc)""",
            )
        )

        extra_env = {
            "SUPERMD_TEST_SIM_SINGLETON": str(sim_singleton),
            "SUPERMD_TEST_READY_MARKER": str(ready_marker),
        }

        code, start_payload = self._service_for_appdata(
            occluded_appdata,
            "start",
            realSpawn=True,
            downloads=str(occluded_downloads),
            desktopDir=str(DESKTOP_DIR),
            daemonBootstrap=occluded_teardown_bootstrap,
            spawnMarker=str(spawn_marker),
            extraEnv=extra_env,
        )
        self.assertEqual(
            code,
            0,
            f"payload={start_payload}; log={(occluded_appdata / 'background-service.log').read_text(encoding='utf-8', errors='replace') if (occluded_appdata / 'background-service.log').is_file() else ''}",
        )
        first_pid = json.loads(spawn_marker.read_text(encoding="utf-8"))["pid"]
        sessions_dir = Path(start_payload["result"]["sessionsDirectory"])

        ready_deadline = time.monotonic() + 10.0
        while not ready_marker.is_file() and time.monotonic() < ready_deadline:
            time.sleep(0.05)
        self.assertTrue(ready_marker.is_file(), "Hidden daemon Studio did not enter forced ready state")

        discovery_files = list(sessions_dir.glob("*.json"))
        self.assertEqual(len(discovery_files), 1)
        client = LiveTabClient(discovery_files[0], timeout=3.0)

        listed = client.list_tabs()
        self.assertGreaterEqual(len(listed["tabs"]), 1)
        self.assertTrue(all(not tab.get("active") for tab in listed["tabs"]))

        created = client._call(
            "create_document",
            title="Occluded Hidden Daemon Note",
            content="# Occluded Hidden Note\n\n$$\\oint E \\cdot dl = -\\frac{d\\Phi_B}{dt}$$\n",
            format="smd",
            background=False,
        )
        read_back = client.read_tab(created["tabId"], view="source")
        self.assertIn("\\Phi_B", read_back["markdown"])
        patched = client._call(
            "patch_tab",
            tabId=created["tabId"],
            expectedRevision=created["revision"],
            operations=[{"type": "replace", "old": "# Occluded Hidden Note", "new": "# Occluded Hidden Note (Patched)"}],
        )
        self.assertTrue(patched["changed"])
        saved = client._call(
            "save_document",
            tabId=created["tabId"],
            expectedRevision=patched["revision"],
            filename="occluded-note.smd",
            saveAs=True,
            format="smd",
        )
        self.assertTrue(Path(saved["path"]).is_file())

        # Immediate `stop` -> `start` must wait for Daemon 1's post-broker.close() exit teardown (0.45s)
        # before spawning Daemon 2, never colliding on exclusive process-lifetime OS resources.
        code, stop_payload = self._service_for_appdata(occluded_appdata, "stop")
        self.assertEqual(code, 0)
        self.assertTrue(stop_payload["result"]["quitRequested"])

        code, restart_payload = self._service_for_appdata(
            occluded_appdata,
            "start",
            realSpawn=True,
            downloads=str(occluded_downloads),
            desktopDir=str(DESKTOP_DIR),
            daemonBootstrap=occluded_teardown_bootstrap,
            spawnMarker=str(spawn_marker),
            extraEnv=extra_env,
        )
        self.assertEqual(
            code,
            0,
            f"payload={restart_payload}; log={(occluded_appdata / 'background-service.log').read_text(encoding='utf-8', errors='replace') if (occluded_appdata / 'background-service.log').is_file() else ''}",
        )
        second_pid = json.loads(spawn_marker.read_text(encoding="utf-8"))["pid"]
        self.assertNotEqual(second_pid, first_pid)

        code, final_stop = self._service_for_appdata(occluded_appdata, "stop")
        self.assertEqual(code, 0)
        self.assertTrue(final_stop["result"]["quitRequested"])
        lock_probe = QLockFile(str(occluded_appdata / "native-instance.lock"))
        lock_probe.setStaleLockTime(0)
        deadline = time.monotonic() + 10.0
        stopped = False
        while time.monotonic() < deadline:
            if lock_probe.tryLock(0):
                lock_probe.unlock()
                if is_process_exit_clear(occluded_appdata):
                    stopped = True
                    break
            time.sleep(0.05)
        self.assertTrue(stopped, "Restarted daemon did not fully exit after final stop")
        with patch.object(
            QStandardPaths,
            "writableLocation",
            side_effect=lambda kind: str(occluded_appdata)
            if kind == QStandardPaths.StandardLocation.AppDataLocation
            else self._orig_writable(kind),
        ):
            fresh_reopened = Session(False)
            try:
                self.assertIs(fresh_reopened.settings["keepInBackground"], False)
                self.assertIs(fresh_reopened.settings["agentAccessEnabled"], False)
            finally:
                fresh_reopened.writes.shutdown(wait=True)

    def test_lazy_reader_profile_teardown_and_vanished_closing_peer_start_handoff(self):
        # 1. Verify _run_teardown never touches QWebEngineProfile.defaultProfile() when a headless
        #    background daemon never initialized a visible reader window (avoiding macOS persistent
        #    profile lock contention and WebEngineContext teardown stalls), removes the scheme handler
        #    when reader_profile_initialized=True, releases the broker after QML teardown, and exits
        #    cleanly via sys.exit after flushing stdio. Run in an isolated subprocess because importing
        #    `main` loads QtWebEngineQuick.
        probe_script = "\n".join(
            [
                "import sys",
                "from types import SimpleNamespace",
                "from unittest.mock import MagicMock, patch",
                f"sys.path.insert(0, {str(DESKTOP_DIR)!r})",
                "import main as desktop_main",
                "events = []",
                "fake_app = MagicMock()",
                "fake_app.sendPostedEvents.side_effect = lambda *_a: events.append('deferred_delete')",
                "fake_studio = MagicMock()",
                "fake_studio.stop.side_effect = lambda: events.append('studio_stop')",
                "fake_engine = MagicMock()",
                "fake_engine.rootObjects.return_value = []",
                "fake_engine.deleteLater.side_effect = lambda: events.append('engine_delete')",
                "fake_session = SimpleNamespace(",
                "    agent_bridge=MagicMock(stop=lambda: events.append('bridge_stop')),",
                "    writes=MagicMock(shutdown=lambda wait=True: events.append(('writes_shutdown', wait))),",
                "    background=None,",
                ")",
                "fake_broker = MagicMock()",
                "fake_broker.close.side_effect = lambda: events.append('broker_close')",
                "fake_handler = MagicMock()",
                "with patch.object(desktop_main, 'sys', SimpleNamespace(platform='linux', stdout=sys.stdout, stderr=sys.stderr, exit=MagicMock())) as m_linux_sys, patch.object(desktop_main.QWebEngineProfile, 'defaultProfile') as m_profile:",
                "    desktop_main._run_teardown(fake_app, fake_session, [fake_studio], [fake_engine], fake_handler, fake_broker, reader_profile_initialized=False)",
                "    assert not m_profile.called, 'Headless teardown must not initialize QWebEngineProfile.defaultProfile()'",
                "    assert events == ['bridge_stop', 'studio_stop', ('writes_shutdown', True), 'engine_delete', 'deferred_delete', 'broker_close', 'deferred_delete'], events",
                "    desktop_main._exit_process(0)",
                "    assert m_linux_sys.exit.call_args_list == [((0,), {})], m_linux_sys.exit.call_args_list",
                "events.clear()",
                "with patch.object(desktop_main, 'sys', SimpleNamespace(platform='linux', stdout=sys.stdout, stderr=sys.stderr, exit=MagicMock())), patch.object(desktop_main.QWebEngineProfile, 'defaultProfile') as m_profile2:",
                "    desktop_main._run_teardown(fake_app, fake_session, [], [], fake_handler, None, reader_profile_initialized=True)",
                "    m_profile2.return_value.removeUrlSchemeHandler.assert_called_once_with(fake_handler)",
                "events.clear()",
                "with patch.object(desktop_main, 'sys', SimpleNamespace(platform='darwin', stdout=sys.stdout, stderr=sys.stderr, exit=MagicMock())) as m_darwin_sys, patch.object(desktop_main.QWebEngineProfile, 'defaultProfile') as m_profile_darwin, patch.object(desktop_main.os, '_exit') as m_os_exit:",
                "    desktop_main._run_teardown(fake_app, fake_session, [fake_studio], [fake_engine], fake_handler, fake_broker, reader_profile_initialized=True)",
                "    assert not m_profile_darwin.called, 'Darwin teardown must skip WebEngineContext/QQuickWebEngineView destruction before os._exit'",
                "    assert events == ['bridge_stop', 'studio_stop', ('writes_shutdown', True), 'broker_close'], events",
                "    assert desktop_main._DARWIN_EXIT_ANCHOR, 'Darwin teardown must anchor Qt/WebEngine wrappers against GC'",
                "    assert desktop_main._TEARDOWN_COMPLETED is True",
                "    desktop_main._exit_process(0)",
                "    assert m_os_exit.call_args_list == [((0,), {})], m_os_exit.call_args_list",
                "    assert not m_darwin_sys.exit.called",
                "    desktop_main._DARWIN_EXIT_ANCHOR.clear()",
                "    desktop_main._TEARDOWN_COMPLETED = False",
                "    desktop_main._exit_process(0)",
                "    assert m_darwin_sys.exit.call_args_list == [((0,), {})], m_darwin_sys.exit.call_args_list",
            ]
        )
        probe = subprocess.run(
            [sys.executable, "-c", probe_script],
            capture_output=True,
            text=True,
            timeout=20,
        )
        self.assertEqual(probe.returncode, 0, probe.stderr or probe.stdout)

        # 1b. Verify deferred start_listening(), open_existing=False duplicate --background suppression,
        #     and automatic _ensure_listening() recovery when BSD/macOS XNU ECONNABORTED drops QLocalServer
        #     (errorString non-empty) without reopening an intentionally closed server (errorString empty).
        deferred_appdata = (self.temp_appdata / "Deferred Broker And XNU Recovery").resolve()
        deferred_appdata.mkdir(parents=True, exist_ok=True)
        with patch.object(
            QStandardPaths,
            "writableLocation",
            side_effect=lambda k: str(deferred_appdata)
            if k == QStandardPaths.StandardLocation.AppDataLocation
            else self._orig_writable(k),
        ):
            deferred_broker = InstanceBroker(self.qt_app, service_handler=self.session.background.handle_service_request)
            self.addCleanup(deferred_broker.close)
            forwarded_notes = []
            deferred_broker.requested.connect(forwarded_notes.append)
            self.assertTrue(deferred_broker.claim_or_forward(None, defer_listen=True))
            self.assertFalse(deferred_broker.server.isListening())
            self.assertTrue(deferred_broker.lock.isLocked())

            # Duplicate --background launch while primary finishes QML startup and calls start_listening():
            # open_existing=False must return False without emitting `requested` to pop a visible window.
            deferred_state = {"started_at": time.monotonic(), "listening": False}

            def start_deferred_soon():
                if not deferred_state["listening"] and time.monotonic() - deferred_state["started_at"] >= 0.12:
                    deferred_state["listening"] = True
                    deferred_broker.start_listening()

            dup_res = self._call(
                {
                    "kind": "claim",
                    "note": None,
                    "appdata": str(deferred_appdata),
                    "deferListen": True,
                    "openExisting": False,
                },
                on_tick=start_deferred_soon,
                timeout=8.0,
            )
            self.assertIs(dup_res.get("claimed"), False)
            self.assertTrue(deferred_broker.server.isListening())
            self.assertEqual(forwarded_notes, [])

            # Simulate BSD/macOS XNU QLocalServerPrivate::closeServer() after ECONNABORTED (errorString non-empty):
            # _ensure_listening() must re-bind the server automatically while self.lock remains held.
            deferred_broker.server.close()
            self.assertFalse(deferred_broker.server.isListening())
            with patch.object(deferred_broker.server, "errorString", return_value="QLocalServer::accept: Software caused connection abort"):
                deferred_broker._ensure_listening()
            self.assertTrue(deferred_broker.server.isListening())

            # _ensure_listening() must never drain listenSocket behind an already-queued macOS
            # QCFSocketNotifier `_q_onNewConnection` activation (which would block in ::accept()).
            from PySide6.QtCore import QMetaObject
            from PySide6.QtNetwork import QLocalSocket
            cfsock_client = QLocalSocket()
            cfsock_client.connectToServer(deferred_broker.name)
            self.assertTrue(cfsock_client.waitForConnected(500))
            deferred_broker._ensure_listening()
            QMetaObject.invokeMethod(deferred_broker.server, "_q_onNewConnection")
            cfsock_client.write(b'{"service":"status"}\n')
            cfsock_client.flush()
            cfsock_client.waitForBytesWritten(500)
            self.qt_app.processEvents()
            cfsock_reply = bytes(cfsock_client.readAll())
            while b"\n" not in cfsock_reply and cfsock_client.waitForReadyRead(500):
                cfsock_reply += bytes(cfsock_client.readAll())
            cfsock_client.disconnectFromServer()
            self.assertEqual(json.loads(cfsock_reply.decode("utf-8"))["ok"], True)

            # Intentional server.close() (empty errorString) must stay closed until stop_accepting/close.
            deferred_broker.server.close()
            deferred_broker._ensure_listening()
            self.assertFalse(deferred_broker.server.isListening())
            deferred_broker.close()

        # 2. Simulate macOS XNU closing-socket race during `service start`:
        #    the initial client connect writes to a dying server (e.g. UnknownSocketError / empty read
        #    while the server was briefly still bound), and while that read fails both the server
        #    socket and native-instance.lock vanish. `service start` must treat the vanished peer
        #    as stopped and spawn the replacement daemon instead of failing with exit code 2.
        self.broker.close()
        vanished_appdata = (self.temp_appdata / "Vanished Peer On Start").resolve()
        vanished_appdata.mkdir(parents=True, exist_ok=True)
        socket_name = "supermd-qt-" + hashlib.sha256(str(vanished_appdata).encode()).hexdigest()[:20]
        QLocalServer.removeServer(socket_name)

        dying_server = QLocalServer(self.qt_app)
        dying_server.setSocketOptions(QLocalServer.SocketOption.UserAccessOption)
        held = []
        dying_state = {"second_at": None, "closed": False}

        def close_dying():
            if dying_state["closed"]:
                return
            dying_state["closed"] = True
            for s in held:
                s.abort()
            dying_server.close()
            QLocalServer.removeServer(socket_name)

        def on_dying_connect():
            while dying_server.hasPendingConnections():
                sock = dying_server.nextPendingConnection()
                held.append(sock)
                if len(held) == 2 and dying_state["second_at"] is None:
                    dying_state["second_at"] = time.monotonic()
                    QTimer.singleShot(20, close_dying)

        dying_server.newConnection.connect(on_dying_connect)
        self.assertTrue(dying_server.listen(socket_name))
        self.addCleanup(lambda: (dying_server.close(), QLocalServer.removeServer(socket_name)))

        spawned, marker = [], vanished_appdata / "vanished-spawn.json"

        def advance_vanish_race():
            if dying_state["second_at"] is not None and not dying_state["closed"] and time.monotonic() - dying_state["second_at"] >= 0.02:
                close_dying()
            if marker.is_file() and not spawned:
                spawned.append(json.loads(marker.read_text(encoding="utf-8")))
                with patch.object(
                    QStandardPaths,
                    "writableLocation",
                    side_effect=lambda k: str(vanished_appdata)
                    if k == QStandardPaths.StandardLocation.AppDataLocation
                    else self._orig_writable(k),
                ):
                    fresh_replacement = InstanceBroker(
                        self.qt_app, service_handler=self.session.background.handle_service_request
                    )
                    self.addCleanup(fresh_replacement.close)
                    self.session.settings["agentAccessEnabled"] = True
                    self.session.agent_bridge.start()
                    self.session.background.set_forced(True)
                    self.assertTrue(fresh_replacement.claim_or_forward(None))

        res = self._call(
            {
                "kind": "service",
                "action": "start",
                "appdata": str(vanished_appdata),
                "spawnMarker": str(marker),
            },
            on_tick=advance_vanish_race,
            timeout=15.0,
        )
        self.assertEqual(res["code"], 0, res)
        self.assertTrue(json.loads(res["stdout"])["result"]["running"])
        self.assertEqual(len(spawned), 1)


if __name__ == "__main__":
    unittest.main()
