import asyncio
import hashlib
import io
import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

from PySide6.QtCore import QEvent, QObject, QPointF, QStandardPaths, Qt, QUrl, Signal
from PySide6.QtQml import QQmlComponent, QQmlEngine
from PySide6.QtQuick import QQuickItem
from PySide6.QtTest import QTest
from PySide6.QtWidgets import QApplication

import agent_cloud
import agent_live
from agent_live_client import MultiSessionLiveClient
import mcp_server
import updates
from background_service import BackgroundService
from instance import InstanceBroker
from studio import ROOT, Session
from test_studio import QuietStudio

QML_DIR = Path(__file__).resolve().parent / "qml"
DESKTOP_DIR = Path(__file__).resolve().parent


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

    def isVisible(self):
        return self._visible

    def show(self):
        self._visible = True

    def hide(self):
        self._visible = False


class _FakeRelaySocket:
    def __init__(self, config):
        self.config = config
        self.closed = threading.Event()
        self._sent_registration = False

    def recv(self, timeout=1):
        if not self._sent_registration:
            self._sent_registration = True
            return json.dumps({
                "type": "registered",
                "groupId": self.config["groupId"],
                "deviceId": self.config["deviceId"],
            })
        if self.closed.wait(timeout=min(float(timeout), 0.1)):
            return None
        raise TimeoutError

    def send(self, _payload):
        pass

    def close(self, **_kwargs):
        self.closed.set()


class BackgroundTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.qt_app = QApplication.instance() or QApplication(["BackgroundTests"])

    def _pump(self, rounds=8):
        for _ in range(rounds):
            self.qt_app.processEvents()
            time.sleep(0.005)

    def _make_session(self):
        session = Session(True)
        session.agent_bridge = agent_live.create_qt_bridge(session, session.data)
        self.addCleanup(lambda: shutil.rmtree(session.data, ignore_errors=True))
        self.addCleanup(session.writes.shutdown, wait=True)
        self.addCleanup(session.agent_bridge.stop)
        return session

    def _make_studio(self, session, *, visible=True):
        studio = QuietStudio(True, session)
        studio.host_window = _VisibleHost(visible=visible)
        self.addCleanup(lambda: (studio.stop(), studio.pool.shutdown(wait=True)))
        return studio

    def _write_test_pairing(self, studio):
        pairing = agent_cloud.new_pairing("https://relay.example.com")
        agent_cloud.write_cloud_config(studio._agent_cloud_config_path, agent_cloud.device_config(pairing))
        client = studio.session.agent_bridge.cloudClient
        client.enroll_fn = lambda _cfg: None
        client.connect_factory = _FakeRelaySocket

    def test_background_quit_waits_for_every_note_flush(self):
        app = App()
        a, b = Owner("a"), Owner("b")
        session = SimpleNamespace(windows={"a": a, "b": b}, recent=[])
        with patch("background_service.QSystemTrayIcon.isSystemTrayAvailable", return_value=False):
            service = BackgroundService(app, session, Path("."), lambda _: None, force=True)
        self.assertTrue(service.enabled)
        self.assertTrue(app.keep)
        service.quit()
        self.assertTrue(a.requested and b.requested)
        self.assertEqual(service.waiting, {"a", "b"})
        a.allowClose.emit()
        self.assertEqual(service.waiting, {"b"})
        self.assertFalse(app.ended)
        b.allowClose.emit()
        self.assertFalse(service.waiting)

    def test_default_settings_disable_tray_residency_quit_cleanly_and_revoke_tokens(self):
        app = App()
        session = self._make_session()
        self.assertIs(session.settings["keepInBackground"], False)
        studio = self._make_studio(session, visible=True)

        # Validate Studio.setting boolean enforcement for keepInBackground.
        for invalid in ("\"yes\"", "1", "null", "[]", "{}"):
            studio.setting("keepInBackground", invalid)
            self.assertIs(session.settings["keepInBackground"], False)

        # Even when a system tray exists on the desktop, default settings keep residency off.
        with patch("background_service.QSystemTrayIcon.isSystemTrayAvailable", return_value=True), \
             patch("background_service.QSystemTrayIcon") as tray_cls:
            tray_cls.isSystemTrayAvailable.return_value = True
            session.background = BackgroundService(app, session, ROOT, lambda _: None, force=False)
            self.assertFalse(session.background.enabled)
            self.assertFalse(studio.backgroundEnabled)
            self.assertFalse(app.keep)
            tray_cls.assert_not_called()

        # Enable live + real CloudRelayClient with fake relay transport, then close with default settings.
        self._write_test_pairing(studio)
        studio.setAgentAccessEnabled(True)
        studio.setCloudAgentEnabled(True)
        discovery_path = session.agent_bridge.discovery_path
        self.assertIsNotNone(discovery_path)
        self.assertTrue(discovery_path.is_file())
        self.assertTrue(session.agent_bridge.cloudClient.enabled)

        studio.host_window.hide()
        session.background.handle_window_visibility(studio)
        # App shutdown triggers agent_bridge.stop() via aboutToQuit / post-exec cleanup.
        session.agent_bridge.stop()

        self.assertTrue(studio.retired)
        self.assertEqual(session.windows, {})
        self.assertFalse(discovery_path.exists())
        self.assertFalse(session.agent_bridge.enabled)
        self.assertFalse(session.agent_bridge.cloudClient.enabled)
        self.assertEqual(session.agent_bridge.cloudClient.status, "Off")

    def test_keep_in_background_hides_last_window_revokes_tokens_and_restores_on_reopen(self):
        app = App()
        session = self._make_session()
        studio = self._make_studio(session, visible=True)
        self._write_test_pairing(studio)

        with patch("background_service.QSystemTrayIcon.isSystemTrayAvailable", return_value=False):
            session.background = BackgroundService(app, session, ROOT, lambda _: None, force=False)
            self.assertFalse(session.background.enabled)
            self.assertFalse(app.keep)

            studio.setting("keepInBackground", "true")
            self._pump()
            self.assertTrue(session.settings["keepInBackground"])
            self.assertTrue(session.background.enabled)
            self.assertTrue(studio.backgroundEnabled)
            self.assertTrue(app.keep)

            studio.setAgentAccessEnabled(True)
            studio.setCloudAgentEnabled(True)
            first_discovery = session.agent_bridge.discovery_path
            first_token = session.agent_bridge.token
            self.assertTrue(first_discovery.is_file())
            self.assertTrue(session.agent_bridge.cloudClient.enabled)

            # Closing the last window hides it, keeps Studio resident, and revokes tokens + stops CloudRelayClient.
            studio.host_window.hide()
            session.background.handle_window_visibility(studio)
            self.assertFalse(studio.retired)
            self.assertIn(studio.window_id, session.windows)
            self.assertFalse(first_discovery.exists())
            self.assertFalse(session.agent_bridge.enabled)
            self.assertFalse(session.agent_bridge.cloudClient.enabled)
            self.assertEqual(session.agent_bridge.cloudClient.status, "Off")
            self.assertTrue(session.settings["agentAccessEnabled"])
            self.assertTrue(session.settings["cloudAgentEnabled"])

            # Reopening the hidden window restores live access with a fresh token and reconnects CloudRelayClient.
            studio.host_window.show()
            session.background.handle_window_visibility(studio)
            self.assertTrue(session.agent_bridge.enabled)
            self.assertIsNotNone(session.agent_bridge.discovery_path)
            self.assertTrue(session.agent_bridge.discovery_path.is_file())
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
        self.assertTrue(discovery.is_file())

        session.background.handle_window_visibility(studio)
        self.assertFalse(studio.retired)
        self.assertTrue(session.agent_bridge.enabled)
        self.assertTrue(discovery.is_file())

    def test_appimage_install_update_bypasses_tray_hiding_so_close_quits_old_process(self):
        app = App()
        session = self._make_session()
        studio = self._make_studio(session, visible=True)
        with patch("background_service.QSystemTrayIcon.isSystemTrayAvailable", return_value=False):
            session.background = BackgroundService(app, session, ROOT, lambda _: None, force=False)
            studio.setting("keepInBackground", "true")
            self.assertTrue(studio.backgroundEnabled)
            self.assertTrue(app.keep)

            installer = session.data / "Super.MD_9.9.9_amd64.AppImage"
            installer.write_bytes(b"verified-appimage")
            release = {
                "version": "9.9.9",
                "asset": {"name": installer.name, "size": installer.stat().st_size, "url": "https://github.com/YashMahawa/super-md/releases/download/v9.9.9/" + installer.name},
                "sha256": hashlib.sha256(installer.read_bytes()).hexdigest(),
            }
            studio.update_info = release
            studio.update_path = str(installer)

            with patch.object(QuietStudio, "desktopIntegrationAvailable", new_callable=lambda: property(lambda self: True)), \
                 patch.object(updates, "installer_kind", return_value="appimage"), \
                 patch.object(updates, "load_ready", return_value={"path": str(installer), "release": release}), \
                 patch("studio.app_integration.install_appimage", return_value=str(installer)):
                studio.installUpdate()
                deadline = time.monotonic() + 3
                while studio.update_running and time.monotonic() < deadline:
                    self._pump(2)

            self.assertTrue(session.update_installed)
            self.assertIn("Close and reopen Super MD", studio.update_status)
            self.assertFalse(studio.backgroundEnabled)
            self.assertFalse(session.background.enabled)
            self.assertFalse(app.keep)

            studio.host_window.hide()
            session.background.handle_window_visibility(studio)
            self.assertTrue(studio.retired)
            self.assertEqual(session.windows, {})

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
                    json.loads(raw)["requestId"],
                    {"tabs": json.loads(raw).get("tabs", [])},
                    "",
                    window_id=owner.window_id,
                )
            )

        live_client = MultiSessionLiveClient(session.agent_bridge.discovery_dir)
        server, _ = mcp_server.build_mcp_server([], live_client=live_client)

        def mcp_window_ids():
            from mcp import Client
            result = {}
            done = []

            def call():
                async def run_call():
                    async with Client(server) as client:
                        reply = await client.call_tool("list_sessions", {})
                        return reply.structured_content

                try:
                    result["data"] = asyncio.run(run_call())
                finally:
                    done.append(True)

            worker = threading.Thread(target=call, daemon=True)
            worker.start()
            deadline = time.monotonic() + 5
            while not done and time.monotonic() < deadline:
                self._pump(2)
            worker.join(timeout=1)
            return {row["windowId"] for row in result["data"]["sessions"]}

        self.assertEqual(mcp_window_ids(), {first.window_id, second.window_id, third.window_id})
        self.assertTrue(second.hasOtherOpenWindows())

        # 1. Closing a secondary window retires it immediately while keeping primary window + live tokens active.
        second.host_window.hide()
        session.background.handle_window_visibility(second)
        self.assertTrue(second.retired)
        self.assertNotIn(second.window_id, session.windows)
        self.assertTrue(session.agent_bridge.enabled)
        self.assertEqual(mcp_window_ids(), {first.window_id, third.window_id})

        # 2. Moving the last tab out of third window via _move_tab emits allowClose and retires third window.
        moved_tab_id = third.tabs[0]["id"]
        third.tabs[0]["content"] = "# Transferred note\n"

        def on_third_allow_close():
            self.assertTrue(third.hasOtherOpenWindows())
            third.host_window.hide()
            session.background.handle_window_visibility(third)

        third.allowClose.connect(on_third_allow_close)
        self.assertTrue(third._move_tab(first, moved_tab_id, 0))
        self._pump()

        self.assertTrue(third.retired)
        self.assertNotIn(third.window_id, session.windows)
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
        qml_source = """
import QtQuick
import QtQuick.Controls
import QtQuick.Controls.Material
ApplicationWindow {
    id: host
    width: 960; height: 720; visible: true
    property var viewState: JSON.parse(studio.snapshot)
    SettingsPage { id: settings; anchors.fill: parent; viewState: host.viewState }
}
"""
        component.setData(qml_source.encode("utf-8"), QUrl.fromLocalFile(str(QML_DIR / "tray-settings-test.qml")))
        self.assertFalse(component.isError(), "\n".join(err.toString() for err in component.errors()))
        window = component.create()
        self.assertIsNotNone(window)
        try:
            QTest.qWait(40)

            def find_named(name):
                stack = [window.contentItem()]
                while stack:
                    item = stack.pop()
                    if item.objectName() == name:
                        return item
                    stack.extend(item.childItems())
                return None

            writing_btn = find_named("settingsSection_writing")
            self.assertIsNotNone(writing_btn)
            pt = writing_btn.mapToScene(QPointF(writing_btn.width() / 2, writing_btn.height() / 2)).toPoint()
            QTest.mouseClick(window, Qt.MouseButton.LeftButton, Qt.KeyboardModifier.NoModifier, pt)
            QTest.qWait(40)

            toggle = find_named("keepInBackgroundSwitch")
            self.assertIsNotNone(toggle)
            self.assertIsInstance(toggle, QQuickItem)
            self.assertFalse(bool(toggle.property("checked")))
            self.assertFalse(session.background.enabled)

            with patch("background_service.QSystemTrayIcon.isSystemTrayAvailable", return_value=False):
                pt_toggle = toggle.mapToScene(QPointF(toggle.width() / 2, toggle.height() / 2)).toPoint()
                QTest.mouseClick(window, Qt.MouseButton.LeftButton, Qt.KeyboardModifier.NoModifier, pt_toggle)
                QTest.qWait(40)
                self.assertTrue(session.settings["keepInBackground"])
                self.assertTrue(session.background.enabled)
                self.assertTrue(app.keep)

                QTest.mouseClick(window, Qt.MouseButton.LeftButton, Qt.KeyboardModifier.NoModifier, pt_toggle)
                QTest.qWait(40)
                self.assertFalse(session.settings["keepInBackground"])
                self.assertFalse(session.background.enabled)
                self.assertFalse(app.keep)
        finally:
            window.close()
            window.deleteLater()
            self.qt_app.sendPostedEvents(None, QEvent.Type.DeferredDelete)
            engine.deleteLater()
            self.qt_app.sendPostedEvents(None, QEvent.Type.DeferredDelete)


class InstanceBrokerAndServiceCliTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.qt_app = QApplication.instance() or QApplication(["InstanceBrokerAndServiceCliTests"])

    def setUp(self):
        self.temp_appdata = Path(tempfile.mkdtemp(prefix="supermd-ipc-")).resolve()
        self._orig_writable = QStandardPaths.writableLocation
        self.appdata_patcher = patch.object(
            QStandardPaths,
            "writableLocation",
            side_effect=lambda kind: str(self.temp_appdata)
            if kind == QStandardPaths.AppDataLocation
            else self._orig_writable(kind),
        )
        self.appdata_patcher.start()
        self.session = Session(True)
        self.session.agent_bridge = agent_live.create_qt_bridge(self.session, self.session.data)
        self.studio = QuietStudio(True, self.session)
        self.studio.host_window = _VisibleHost(visible=True)
        self.app_stub = App()
        self.tray_patcher = patch("background_service.QSystemTrayIcon.isSystemTrayAvailable", return_value=False)
        self.tray_patcher.start()
        self.session.background = BackgroundService(self.app_stub, self.session, ROOT, lambda _: None, force=False)
        self.broker = InstanceBroker(self.qt_app, service_handler=self.session.background.handle_service_request)
        self.assertTrue(self.broker.claim_or_forward(None))

    def tearDown(self):
        self.broker.close()
        self.session.agent_bridge.stop()
        self.studio.stop()
        self.studio.pool.shutdown(wait=True)
        self.session.writes.shutdown(wait=True)
        self.tray_patcher.stop()
        self.appdata_patcher.stop()
        shutil.rmtree(self.session.data, ignore_errors=True)
        shutil.rmtree(self.temp_appdata, ignore_errors=True)

    def _run_child_python(self, code_snippet: str):
        env = {**os.environ, "QT_QPA_PLATFORM": "offscreen", "PYTHONPATH": str(DESKTOP_DIR)}
        proc = subprocess.Popen(
            [sys.executable, "-c", code_snippet],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            env=env,
        )
        deadline = time.monotonic() + 8
        while proc.poll() is None and time.monotonic() < deadline:
            self.qt_app.processEvents()
            time.sleep(0.005)
        stdout, stderr = proc.communicate(timeout=2)
        self.qt_app.processEvents()
        return proc.returncode, stdout, stderr

    def _run_service_cli(self, action: str):
        script = f"""
import os, sys
from unittest.mock import patch
from PySide6.QtCore import QStandardPaths
orig = QStandardPaths.writableLocation
with patch.object(QStandardPaths, "writableLocation", side_effect=lambda k: {str(self.temp_appdata)!r} if k == QStandardPaths.AppDataLocation else orig(k)):
    import background_cli, agent_cli
    with patch.object(background_cli.subprocess, "Popen", side_effect=AssertionError("Unexpected Popen")):
        raise SystemExit(agent_cli.main(["service", {action!r}]))
"""
        code, stdout, stderr = self._run_child_python(script)
        self.assertTrue(stdout.strip(), f"Empty CLI output; stderr={stderr}")
        return code, json.loads(stdout)

    def test_note_forwarding_preserves_single_instance_lock_and_ok_ack(self):
        forwarded = []
        self.broker.requested.connect(forwarded.append)
        note_path = self.temp_appdata / "hello.md"
        note_path.write_text("# Hello\n", encoding="utf-8")

        script = f"""
import json
from unittest.mock import patch
from PySide6.QtCore import QCoreApplication, QStandardPaths
app = QCoreApplication(["super-md"])
orig = QStandardPaths.writableLocation
with patch.object(QStandardPaths, "writableLocation", side_effect=lambda k: {str(self.temp_appdata)!r} if k == QStandardPaths.AppDataLocation else orig(k)):
    from instance import InstanceBroker
    broker = InstanceBroker()
    print(json.dumps({{"claimed": broker.claim_or_forward({str(note_path)!r})}}))
"""
        code, stdout, stderr = self._run_child_python(script)
        self.assertEqual(code, 0, stderr)
        self.assertIs(json.loads(stdout)["claimed"], False)
        self.assertEqual(forwarded, [str(note_path.resolve())])

    def test_service_status_reports_false_for_standard_gui_and_true_when_background_enabled(self):
        code, payload = self._run_service_cli("status")
        self.assertEqual(code, 0)
        self.assertTrue(payload["ok"])
        self.assertIs(payload["result"]["running"], False)
        self.assertIs(payload["result"]["agentAccess"], False)

        self.studio.setting("keepInBackground", "true")
        code, payload = self._run_service_cli("status")
        self.assertEqual(code, 0)
        self.assertIs(payload["result"]["running"], True)

    def test_service_start_refuses_unconsented_gui_escalation_and_succeeds_after_consent(self):
        code, payload = self._run_service_cli("start")
        self.assertEqual(code, 2)
        self.assertFalse(payload["ok"])
        self.assertEqual(payload["error"]["type"], "ValueError")
        self.assertIn("Settings", payload["error"]["message"])
        self.assertFalse(self.session.settings["agentAccessEnabled"])
        self.assertFalse(self.session.agent_bridge.enabled)
        self.assertFalse(self.session.background.enabled)

        # Once the user explicitly enables live agent access in the GUI session, service start is permitted.
        self.studio.setAgentAccessEnabled(True)
        code, payload = self._run_service_cli("start")
        self.assertEqual(code, 0)
        self.assertTrue(payload["ok"])
        self.assertTrue(payload["result"]["running"])
        self.assertEqual(payload["result"]["sessionsDirectory"], str(self.session.agent_bridge.discovery_dir))
        self.assertTrue(self.session.background.enabled)

    def test_service_stop_disables_background_without_quitting_open_gui_windows(self):
        self.studio.setting("keepInBackground", "true")
        self.session.background.set_forced(True)
        self.assertTrue(self.session.background.enabled)

        code, payload = self._run_service_cli("stop")
        self.assertEqual(code, 0)
        self.assertTrue(payload["ok"])
        self.assertFalse(payload["result"]["running"])
        self.assertFalse(payload["result"]["quitRequested"])
        self.assertFalse(self.session.background.enabled)
        self.assertFalse(self.session.settings["keepInBackground"])
        self.assertFalse(self.session.background.quitting)
        self.assertFalse(self.studio.retired)
        self.assertTrue(self.studio.host_window.isVisible())
        self.assertFalse(self.app_stub.ended)

    def test_service_stop_quits_headless_background_daemon_when_no_gui_windows_are_open(self):
        self.studio.host_window.hide()
        self.session.background.set_forced(True)
        with patch.object(self.studio, "closeWindowSafely", side_effect=self.studio.allowClose.emit):
            code, payload = self._run_service_cli("stop")
            self.qt_app.processEvents()
        self.assertEqual(code, 0)
        self.assertTrue(payload["ok"])
        self.assertFalse(payload["result"]["running"])
        self.assertTrue(payload["result"]["quitRequested"])
        self.assertTrue(self.session.background.quitting)
        self.assertTrue(self.app_stub.ended)

    def test_service_cli_handles_absent_instance_and_cold_start_polling(self):
        # Close the active broker so no instance is listening on the local socket.
        self.broker.close()
        code, status_payload = self._run_service_cli("status")
        self.assertEqual(code, 0)
        self.assertIs(status_payload["result"]["running"], False)

        code, stop_payload = self._run_service_cli("stop")
        self.assertEqual(code, 0)
        self.assertEqual(stop_payload["result"], {"running": False, "action": "stop", "quitRequested": False})

        # Simulate cold-start: Popen triggers our main-thread broker to begin listening with running=True.
        spawned_commands = []

        script = f"""
import json, os, sys
from unittest.mock import MagicMock, patch
from PySide6.QtCore import QStandardPaths
orig = QStandardPaths.writableLocation
marker = {str(self.temp_appdata / 'spawned.json')!r}
def fake_popen(cmd, **kwargs):
    with open(marker, 'w', encoding='utf-8') as f:
        json.dump(cmd, f)
    return MagicMock()
with patch.object(QStandardPaths, "writableLocation", side_effect=lambda k: {str(self.temp_appdata)!r} if k == QStandardPaths.AppDataLocation else orig(k)):
    import background_cli, agent_cli
    with patch.object(background_cli.subprocess, "Popen", side_effect=fake_popen):
        raise SystemExit(agent_cli.main(["service", "start"]))
"""
        env = {**os.environ, "QT_QPA_PLATFORM": "offscreen", "PYTHONPATH": str(DESKTOP_DIR)}
        proc = subprocess.Popen(
            [sys.executable, "-c", script],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            env=env,
        )
        marker_file = self.temp_appdata / "spawned.json"
        deadline = time.monotonic() + 8
        while proc.poll() is None and time.monotonic() < deadline:
            if marker_file.is_file() and not spawned_commands:
                spawned_commands.append(json.loads(marker_file.read_text(encoding="utf-8")))
                self.session.settings["agentAccessEnabled"] = True
                self.session.agent_bridge.start()
                self.session.background.set_forced(True)
                self.assertTrue(self.broker.claim_or_forward(None))
            self.qt_app.processEvents()
            time.sleep(0.01)
        stdout, stderr = proc.communicate(timeout=2)

        self.assertEqual(proc.returncode, 0, f"stdout={stdout} stderr={stderr}")
        started = json.loads(stdout)
        self.assertTrue(started["ok"])
        self.assertTrue(started["result"]["running"])
        self.assertIn("--background", spawned_commands[0])
        self.assertIn("--agent-access", spawned_commands[0])


if __name__ == "__main__":
    unittest.main()

