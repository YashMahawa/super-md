import asyncio, hashlib, json, os, shutil, subprocess, sys, tempfile, threading, time, unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

from PySide6.QtCore import QEvent, QObject, QPointF, QStandardPaths, Qt, QUrl, Signal
from PySide6.QtQml import QQmlComponent, QQmlEngine
from PySide6.QtQuick import QQuickItem
from PySide6.QtQuickControls2 import QQuickStyle
from PySide6.QtTest import QTest
from PySide6.QtWidgets import QApplication

import agent_cloud, agent_live, background_cli, mcp_server, python_runtime, updates
from agent_live_client import MultiSessionLiveClient
from background_service import BackgroundService
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


_IPC_WORKER = """
import contextlib, io, json, sys
from unittest.mock import MagicMock, patch
from PySide6.QtCore import QCoreApplication, QStandardPaths
app = QCoreApplication.instance() or QCoreApplication(["super-md"])
orig = QStandardPaths.writableLocation
import agent_cli, background_cli
from instance import InstanceBroker
cin, cout = sys.stdin, sys.stdout
for raw in cin:
    cmd = json.loads(raw)
    if cmd["kind"] == "quit": break
    appdata = cmd["appdata"]
    with patch.object(QStandardPaths, "writableLocation", side_effect=lambda k, p=appdata: p if k == QStandardPaths.AppDataLocation else orig(k)):
        if cmd["kind"] == "claim":
            broker = InstanceBroker()
            claimed = broker.claim_or_forward(cmd.get("note"))
            if claimed: broker.close()
            cout.write(json.dumps({"claimed": claimed}) + "\\n"); cout.flush()
        else:
            out, err, marker = io.StringIO(), io.StringIO(), cmd.get("spawnMarker")
            def fake_popen(spawn_cmd, **_kw):
                if not marker: raise AssertionError("Unexpected Popen")
                open(marker, "w", encoding="utf-8").write(json.dumps(spawn_cmd)); return MagicMock()
            with patch.object(background_cli.subprocess, "Popen", side_effect=fake_popen), patch.object(sys, "stdin", io.StringIO("")), contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
                try: code = agent_cli.main(["service", cmd["action"]])
                except SystemExit as exc: code = exc.code if isinstance(exc.code, int) else 1
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
            env={**os.environ, "QT_QPA_PLATFORM": "offscreen", "PYTHONPATH": str(DESKTOP_DIR)},
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
        patcher = patch.object(QStandardPaths, "writableLocation", side_effect=lambda k: str(self.temp_appdata) if k == QStandardPaths.AppDataLocation else orig(k))
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
        QTimer_released = []
        def release_soon():
            if not QTimer_released:
                QTimer_released.append(True)
                threading.Timer(0.15, self.broker.lock.unlock).start()
        claim_res = self._call({"kind": "claim", "note": None, "appdata": str(self.temp_appdata)}, on_tick=release_soon)
        self.assertIs(claim_res["claimed"], True)
        self.broker.close()
        self.assertEqual(self._service("stop")[1]["result"], {"running": False, "action": "stop", "quitRequested": False})

        spawned, marker = [], self.temp_appdata / "spawned.json"
        def bring_up_daemon():
            if marker.is_file() and not spawned:
                spawned.append(json.loads(marker.read_text(encoding="utf-8")))
                self.session.settings["agentAccessEnabled"] = True
                self.session.agent_bridge.start()
                self.session.background.set_forced(True)
                self.assertTrue(self.broker.claim_or_forward(None))

        res = self._call({"kind": "service", "action": "start", "appdata": str(self.temp_appdata), "spawnMarker": str(marker)}, on_tick=bring_up_daemon, timeout=10.0)
        self.assertEqual(res["code"], 0)
        self.assertTrue(json.loads(res["stdout"])["result"]["running"])
        self.assertIn("--background", spawned[0])
        self.assertIn("--agent-access", spawned[0])


if __name__ == "__main__":
    unittest.main()
