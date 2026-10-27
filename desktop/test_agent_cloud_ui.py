"""Cloud pairing revocation must stay responsive and erase local credentials."""
from __future__ import annotations
import os, threading, time, unittest
os.environ.setdefault("QT_QPA_PLATFORM","offscreen")
from PySide6.QtGui import QGuiApplication
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

if __name__=="__main__": unittest.main()
