"""Cloud pairing revocation must stay responsive and erase local credentials."""
from __future__ import annotations
import os, sys, threading, time, unittest
os.environ.setdefault("QT_QPA_PLATFORM","offscreen")
from pathlib import Path
from PySide6.QtCore import QEvent, QObject, QUrl
from PySide6.QtGui import QGuiApplication
from PySide6.QtQml import QQmlComponent, QQmlEngine
from PySide6.QtQuickControls2 import QQuickStyle
from studio import Session, Studio
import agent_cloud

class QuietStudio(Studio):
    def __init__(self, isolated: bool = False, session: Session | None = None):
        session = session or Session(isolated)
        if not session.settings.get("python"): session.settings["python"] = sys.executable
        super().__init__(isolated, session)
    def _refresh_theme(self): self.system_dark=True

class CloudRevocationUITests(unittest.TestCase):
    @classmethod
    def setUpClass(cls): cls.app=QGuiApplication.instance() or QGuiApplication(["Super MD cloud revocation tests"])
    def make_studio(self):
        session=Session(True); studio=QuietStudio(True,session)
        config=agent_cloud.device_config(agent_cloud.new_pairing("https://relay.example.test"))
        agent_cloud.write_cloud_config(studio._agent_cloud_config_path,config)
        return session,studio,config
    def dispose(self,session,studio):
        studio.stop(); studio.pool.shutdown(wait=True,cancel_futures=True); session.writes.shutdown(wait=True); self.app.processEvents()
    def wait_for_revoke(self,studio,timeout=3):
        end=time.monotonic()+timeout
        while studio.cloudAgentRevocationPending and time.monotonic()<end:
            self.app.processEvents(); time.sleep(.005)
        self.assertFalse(studio.cloudAgentRevocationPending)
    def test_relay_origin_is_empty_without_pairing_and_preserves_users_custom_server(self):
        session,studio,config=self.make_studio()
        try:
            self.assertEqual(studio.cloudRelayOrigin, "https://relay.example.test")
            self.assertNotIn(config["connectorKey"], studio.cloudRelayOrigin)
            studio._agent_cloud_config_path.unlink()
            self.assertEqual(studio.cloudRelayOrigin, "")
            self.assertEqual(studio.cloudConnectorUrl, "")
        finally:self.dispose(session,studio)
    def test_cloud_autoconnect_reuses_existing_pairing_without_rotating_credentials(self):
        from unittest.mock import Mock
        session, studio, config = self.make_studio()
        bridge = Mock()
        bridge.enabled = False
        bridge.cloudClient.enabled = False
        session.agent_bridge = bridge
        try:
            studio.settings["cloudAgentEnabled"] = True
            studio._restore_cloud_connection()
            bridge.start_cloud.assert_called_once()
            self.assertEqual(bridge.start_cloud.call_args.args[0]["deviceId"], config["deviceId"])
            self.assertEqual(agent_cloud.read_cloud_config(studio._agent_cloud_config_path)["connectorKey"],
                             config["connectorKey"])
            self.assertTrue(studio._cloud_started_local_bridge)
            self.assertEqual(studio._agent_cloud_error, "")
            studio.settings["cloudAgentEnabled"] = False
            studio._restore_cloud_connection()
            bridge.start_cloud.assert_called_once()
        finally:
            self.dispose(session, studio)

    def test_cloud_autoconnect_missing_pairing_shows_error_without_creating_new_pairing(self):
        from unittest.mock import Mock
        session, studio, _ = self.make_studio()
        bridge = Mock()
        bridge.cloudClient.enabled = False
        session.agent_bridge = bridge
        try:
            studio._agent_cloud_config_path.unlink()
            studio.settings["cloudAgentEnabled"] = True
            studio._restore_cloud_connection()
            bridge.start_cloud.assert_not_called()
            self.assertIn("Cloud auto-connect failed", studio.cloudAgentStatus)
            self.assertFalse(studio.cloudAgentConfigured)
        finally:
            self.dispose(session, studio)

    def test_explicit_revoke_runs_off_ui_thread_then_erases_config(self):
        session,studio,config=self.make_studio(); started=threading.Event(); release=threading.Event(); errors=[]
        def revoke(value,timeout):
            self.assertEqual(value["deviceId"],config["deviceId"]); self.assertLessEqual(timeout,10)
            started.set(); release.wait(2)
        try:
            from unittest.mock import patch
            with patch("agent_cloud.revoke",side_effect=revoke):
                studio.revokeCloudAgent()
                self.assertTrue(studio.cloudAgentRevocationPending)
                self.assertTrue(studio.cloudAgentConfigured)
                self.assertTrue(started.wait(1))
                # The caller can continue running the GUI while the network action waits.
                self.app.processEvents()
                release.set(); self.wait_for_revoke(studio)
            self.assertFalse(studio.cloudAgentConfigured)
            self.assertIn("revocation confirmed",studio.cloudAgentStatus)
        finally:
            release.set(); self.dispose(session,studio)
    def test_offline_revoke_still_erases_local_pairing_and_reports_uncertain_result(self):
        session,studio,_config=self.make_studio()
        try:
            from unittest.mock import patch
            with patch("agent_cloud.revoke",side_effect=agent_cloud.CloudPairingError("offline")):
                studio.revokeCloudAgent(); self.wait_for_revoke(studio)
            self.assertFalse(studio.cloudAgentConfigured)
            self.assertIn("could not be confirmed",studio.cloudAgentStatus)
        finally: self.dispose(session,studio)

    def test_create_and_import_pairing_teardown_active_cloud_bridge_and_revoke_old_config(self):
        import json, tempfile
        from unittest.mock import Mock, patch
        session, studio, first_config = self.make_studio()
        bridge = Mock()
        session.agent_bridge = bridge
        revoked_ids: list[str] = []
        revoke_done = threading.Event()
        def record_revoke(value, timeout=8):
            revoked_ids.append(value["deviceId"])
            revoke_done.set()
        try:
            with tempfile.TemporaryDirectory() as tmpdir, patch("agent_cloud.revoke", side_effect=record_revoke):
                bridge.cloudClient.enabled = True
                studio.settings["cloudAgentEnabled"] = True
                studio.settings["agentAccessEnabled"] = False
                studio._cloud_started_local_bridge = True
                self.assertTrue(studio.createAgentPairing("https://relay-two.example.test"))
                self.assertTrue(revoke_done.wait(2))
                bridge.stop_cloud.assert_called_once()
                bridge.stop.assert_called_once()
                self.assertFalse(studio.settings["cloudAgentEnabled"])
                self.assertFalse(studio._cloud_started_local_bridge)
                self.assertEqual(studio.cloudRelayOrigin, "https://relay-two.example.test")
                self.assertEqual(revoked_ids, [first_config["deviceId"]])
                second_config = agent_cloud.read_cloud_config(studio._agent_cloud_config_path)

                revoke_done.clear()
                bridge.reset_mock()
                bridge.cloudClient.enabled = True
                studio.settings["cloudAgentEnabled"] = True
                studio.settings["agentAccessEnabled"] = True
                studio._cloud_started_local_bridge = True
                imported_file = Path(tmpdir) / "imported-pairing.json"
                imported_file.write_text(json.dumps(agent_cloud.new_pairing("https://relay-three.example.test")), encoding="utf-8")
                self.assertTrue(studio.importAgentPairing(imported_file.as_uri()))
                self.assertTrue(revoke_done.wait(2))
                bridge.stop_cloud.assert_called_once()
                bridge.stop.assert_not_called()
                self.assertFalse(studio.settings["cloudAgentEnabled"])
                self.assertFalse(studio._cloud_started_local_bridge)
                self.assertEqual(studio.cloudRelayOrigin, "https://relay-three.example.test")
                self.assertEqual(revoked_ids, [first_config["deviceId"], second_config["deviceId"]])

                studio._cloud_revocation_pending = True
                self.assertFalse(studio.createAgentPairing("https://blocked.example.test"))
                self.assertIn("Wait for desktop pairing revocation to finish", studio._agent_cloud_error)
                self.assertFalse(studio.importAgentPairing(str(imported_file)))
                self.assertEqual(studio.cloudRelayOrigin, "https://relay-three.example.test")
                studio._cloud_revocation_pending = False
        finally:
            self.dispose(session, studio)


class AgentAccessOriginBindingTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if QGuiApplication.instance() is None:
            QQuickStyle.setStyle("Material")
        cls.app=QGuiApplication.instance() or QGuiApplication(["Super MD agent access origin tests"])

    def setUp(self):
        self.session=Session(True)
        self.studio=QuietStudio(True,self.session)
        self.engine=QQmlEngine()
        self.engine.rootContext().setContextProperty("studio",self.studio)
        self.component=QQmlComponent(self.engine)
        self.component.loadUrl(QUrl.fromLocalFile(str(Path(__file__).parent/"qml"/"AgentAccess.qml")))
        self.assertFalse(self.component.isError(),str(self.component.errors()))
        self.view_state={"colors":{"muted":"#786a62","outline":"#88756b","primary":"#8c4b2b"}}
        self.panel=self.component.createWithInitialProperties({"hostStudio":self.studio,"viewState":self.view_state})
        self.assertIsNotNone(self.panel,str(self.component.errors()))
        self.field=self.panel.findChild(QObject,"agentRelayOrigin")
        self.assertIsNotNone(self.field)
        self.app.processEvents()

    def tearDown(self):
        if self.panel is not None:
            self.panel.deleteLater()
        self.app.sendPostedEvents(None,QEvent.Type.DeferredDelete)
        self.engine.deleteLater()
        self.app.sendPostedEvents(None,QEvent.Type.DeferredDelete)
        self.studio.stop()
        self.studio.pool.shutdown(wait=True,cancel_futures=True)
        self.session.writes.shutdown(wait=True)

    def test_origin_field_starts_empty_preserves_draft_and_tracks_custom_pairing(self):
        self.assertEqual(self.studio.cloudRelayOrigin,"")
        self.assertEqual(self.field.property("text"),"")

        first=agent_cloud.device_config(agent_cloud.new_pairing("https://relay.first.example"))
        agent_cloud.write_cloud_config(self.studio._agent_cloud_config_path,first)
        self.studio.changed.emit()
        self.app.processEvents()
        self.assertEqual(self.field.property("text"),"https://relay.first.example")
        self.assertNotIn(first["connectorKey"],self.field.property("text"))

        draft="https://typing.example.test"
        self.field.setProperty("text",draft)
        self.studio.changed.emit()
        self.app.processEvents()
        self.assertEqual(self.field.property("text"),draft)

        second=agent_cloud.device_config(agent_cloud.new_pairing("https://relay.second.example"))
        agent_cloud.write_cloud_config(self.studio._agent_cloud_config_path,second)
        self.studio.changed.emit()
        self.app.processEvents()
        self.assertEqual(self.field.property("text"),"https://relay.second.example")
        self.assertNotIn(second["connectorKey"],self.field.property("text"))

if __name__=="__main__": unittest.main()
