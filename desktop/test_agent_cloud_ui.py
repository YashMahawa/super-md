"""Cloud pairing revocation must stay responsive and erase local credentials."""
from __future__ import annotations
import os, threading, time, unittest
os.environ.setdefault("QT_QPA_PLATFORM","offscreen")
from pathlib import Path
from PySide6.QtCore import QEvent, QObject, QUrl
from PySide6.QtGui import QGuiApplication
from PySide6.QtQml import QQmlComponent, QQmlEngine
from PySide6.QtQuickControls2 import QQuickStyle
from studio import Session, Studio
import agent_cloud

class QuietStudio(Studio):
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
