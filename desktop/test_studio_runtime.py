"""Unit tests for desktop/studio_runtime.py behind the Studio facade."""
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
from PySide6.QtCore import QUrl
from PySide6.QtGui import QGuiApplication
import studio as studio_module
import updates
from studio import Session, Studio

class QuietStudio(Studio):
    def _refresh_theme(self):
        self.system_dark = True

def _asset(name: str, version: str = "9.9.9") -> dict:
    return {"version": version, "name": name, "size": 4,
            "url": f"{updates.REPO}/releases/download/v{version}/{name}",
            "checksums": f"{updates.REPO}/releases/download/v{version}/SHA256SUMS"}

class StudioRuntimeTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.app = QGuiApplication.instance() or QGuiApplication(["studio runtime tests"])

    def setUp(self):
        self.session = Session(True)
        self.session.settings["python"] = sys.executable
        self.studio = QuietStudio(True, self.session)
        self.session.writes.flush(timeout=3)

    def tearDown(self):
        self.studio.stop()
        self.studio.pool.shutdown(wait=True, cancel_futures=True)
        self.studio._search_pool.shutdown(wait=True, cancel_futures=True)
        self.session.writes.shutdown(wait=True)
        self.app.processEvents()

    def _capture_submit(self):
        jobs = []
        return jobs, patch.object(self.studio, "_submit", side_effect=lambda action, done, *_: jobs.append((action, done)))

    def test_storage_inspection_cancel_and_sanitized_error_fallback(self):
        jobs, submit_patch = self._capture_submit()
        report = {"status": "complete", "cancelled": False, "truncated": False, "scannedEntries": 4, "categories": []}
        with submit_patch, patch.object(studio_module, "inspect_storage", return_value=report) as inspect_mock:
            self.studio.inspectStorage()
            self.assertTrue(self.studio.storageBusy)
            self.assertEqual(json.loads(self.studio.storageReport)["status"], "scanning")
            self.studio.inspectStorage()
            self.assertEqual(len(jobs), 1)
            action, done = jobs.pop()
            done(action(), None)
            inspect_mock.assert_called_once()
        self.assertFalse(self.studio.storageBusy)
        self.assertEqual(json.loads(self.studio.storageReport)["scannedEntries"], 4)

        with submit_patch, patch.object(studio_module, "inspect_storage", side_effect=OSError("/secret/home/file")):
            self.studio.inspectStorage()
            self.studio.cancelStorageInspection()
            self.assertTrue(self.studio._storage_cancel_event.is_set())
            action, done = jobs.pop()
            try:
                value, err = action(), None
            except OSError as exc:
                value, err = None, str(exc)
            done(value, err)
        parsed = json.loads(self.studio.storageReport)
        self.assertEqual((self.studio.storageBusy, parsed["status"], parsed["cancelled"]), (False, "partial", True))
        self.assertNotIn("/secret/home", self.studio.storageReport)

    def test_clear_storage_category_guards_and_completion(self):
        jobs, submit_patch = self._capture_submit()
        with submit_patch:
            self.studio.clearStorageCategory("recovery")
            self.assertEqual(self.studio.storageCleanupStatus, "This storage category is protected.")
            self.studio.update_path = "/verified/installer"
            self.studio.clearStorageCategory("update-state")
            self.assertEqual(self.studio.storageCleanupStatus, "Cleanup is unavailable while storage or updates are in use.")
            self.studio.update_path = ""
            self.studio.storage_busy = True
            self.studio.clearStorageCategory("execution-results")
            self.assertEqual(jobs, [])
            self.studio.storage_busy = False
            with patch.object(studio_module, "clear_storage_category", return_value={"cleared": True}) as clear_mock, \
                 patch.object(self.studio, "inspectStorage") as inspect_spy:
                self.studio.clearStorageCategory("execution-results")
                self.assertTrue(self.studio.storageCleanupBusy)
                action, done = jobs.pop()
                done(action(), None)
                clear_mock.assert_called_once_with(self.studio.data, "execution-results")
                inspect_spy.assert_called_once_with()
                self.assertFalse(self.studio.storageCleanupBusy)
                self.assertIn("Temporary app data cleared", self.studio.storageCleanupStatus)
                self.studio.clearStorageCategory("update-state")
                _, done = jobs.pop()
                done(None, "permission denied")
                self.assertIn("Cleanup failed", self.studio.storageCleanupStatus)

    def test_app_version_release_link_restore_download_and_desktop_integration(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "package.json").write_text('{"version": "2.4.6"}', encoding="utf-8")
            (root / "desktop").mkdir()
            (root / "desktop/build-info.json").write_text('{"version": "2.4.7"}', encoding="utf-8")
            with patch.object(studio_module, "ROOT", root):
                self.assertEqual(self.studio.appVersion, "2.4.6")
                with patch("studio.sys.frozen", True, create=True):
                    self.assertEqual(self.studio.appVersion, "2.4.7")
        with patch("studio.QDesktopServices.openUrl", return_value=False) as open_url:
            self.studio.openLatestGitHubRelease()
            open_url.assert_called_once_with(QUrl(updates.REPO + "/releases/latest"))
            self.assertIn("Could not open", self.studio.message)

        jobs, submit_patch = self._capture_submit()
        saved = {"path": "/downloads/Super-MD_9.9.9_amd64.AppImage", "release": _asset("Super-MD_9.9.9_amd64.AppImage")}
        self.studio.settings["checkUpdates"] = True
        with submit_patch, patch("updates.load_ready", return_value=saved), patch("studio.QTimer.singleShot") as timer:
            self.studio._restore_update()
            action, done = jobs.pop()
            done(action(), None)
            self.assertEqual((self.studio.update_path, self.studio.updateStatus), (saved["path"], "Verified update ready in Downloads."))
            timer.assert_called_once()
        with submit_patch, patch("app_integration.available", return_value=True), \
             patch("app_integration.integrate_current", return_value="/local/bin/super-md") as integrate:
            self.studio.setDesktopIntegration(False)
            self.assertFalse(self.studio.settings["desktopIntegration"])
            self.studio.setDesktopIntegration(True)
            action, done = jobs.pop()
            done(action(), None)
            integrate.assert_called_once_with(self.studio.appVersion)
            self.assertTrue(self.studio.settings["desktopIntegration"])
            self.assertIn("Added to Applications", self.studio.updateStatus)
            self.studio.setDesktopIntegration(True)
            _, done = jobs.pop()
            done(None, "launcher conflict")
            self.assertEqual(self.studio.updateStatus, "Desktop integration failed: launcher conflict")
        self.studio.update_path = ""
        self.studio.update_info = saved["release"]
        with submit_patch, patch("updates.download", return_value="/downloads/verified.AppImage") as dl_mock:
            self.studio.downloadUpdate()
            action, done = jobs.pop()
            done(action(), None)
            dl_mock.assert_called_once()
            self.assertEqual(self.studio.update_path, "/downloads/verified.AppImage")
            self.assertIn("Verified update ready", self.studio.updateStatus)

    def test_check_updates_retention_and_install_update_variants(self):
        jobs, submit_patch = self._capture_submit()
        info = _asset("Super-MD_9.9.9_amd64.AppImage")
        self.studio.update_info = info
        self.studio.update_path = "/verified/Super-MD_9.9.9_amd64.AppImage"
        with submit_patch:
            self.studio.checkUpdates()
            _, done = jobs.pop()
            done((info, None), None)
            self.assertIn("already downloaded", self.studio.updateStatus)
            self.studio.checkUpdates()
            _, done = jobs.pop()
            done((None, None), None)
            self.assertEqual(self.studio.update_path, "/verified/Super-MD_9.9.9_amd64.AppImage")
        with patch("app_integration.available", return_value=False), patch("studio.QDesktopServices.openUrl", return_value=True) as open_url:
            self.studio.installUpdate()
            open_url.assert_called_once_with(QUrl(updates.REPO + "/releases/latest"))
            self.assertIn("package-managed", self.studio.updateStatus)
        self.studio.update_info = {"version": "bad"}
        self.studio.installUpdate()
        self.assertIn("invalid", self.studio.updateStatus)
        self.studio.update_info = _asset("Super-MD_9.9.9_amd64.deb")
        self.studio.update_path = "/verified/Super-MD_9.9.9_amd64.deb"
        mismatched = {"path": self.studio.update_path, "release": _asset("Super-MD_9.9.8_amd64.deb", "9.9.8")}
        with submit_patch, patch("updates.load_ready", return_value=mismatched):
            self.studio.installUpdate()
            action, done = jobs.pop()
            with self.assertRaises(ValueError) as ctx:
                action()
            done(None, str(ctx.exception))
            self.assertIn("no longer matches", self.studio.updateStatus)

        cases = (
            ("Super-MD_9.9.9_amd64.AppImage", "appimage", True, "Close and reopen"),
            ("Super-MD_9.9.9_x64-setup.exe", "windows", (True, 4321), "Installer opened"),
            ("Super-MD_9.9.9_x64-setup.exe", "windows", (False, 0), "Could not open"),
            ("Super-MD_9.9.9_amd64.deb", "deb", True, "Package installer opened"),
            ("Super-MD-9.9.9-1.x86_64.rpm", "rpm", True, "Package installer opened"),
            ("Super-MD_9.9.9_aarch64.dmg", "macos", True, "Disk image opened"),
        )
        for name, kind, open_ret, expected in cases:
            self.studio.update_path = "/verified/" + name
            self.studio.update_info = _asset(name)
            saved = {"path": self.studio.update_path, "release": self.studio.update_info}
            with self.subTest(name=name, open_ret=open_ret), submit_patch, \
                 patch("app_integration.available", return_value=True), patch("updates.load_ready", return_value=saved), \
                 patch("app_integration.install_appimage", return_value="/opt/app") as app_inst, \
                 patch("studio.QProcess.startDetached", return_value=open_ret) as start_proc, \
                 patch("studio.QDesktopServices.openUrl", return_value=open_ret) as open_url:
                self.studio.installUpdate()
                action, done = jobs.pop()
                done(action(), None)
                self.assertIn(expected, self.studio.updateStatus)
                if kind == "appimage":
                    app_inst.assert_called_once()
                elif kind == "windows":
                    start_proc.assert_called_once_with(self.studio.update_path, [])
                else:
                    open_url.assert_called_once_with(QUrl.fromLocalFile(self.studio.update_path))

    def test_python_folders_default_refresh_install_setup_and_shutdown_guards(self):
        note_dir = Path(self.studio.data, "other", "dir")
        self.studio.folder = str(Path(self.studio.data, "notes"))
        self.studio.tabs = [self.studio._note("a.md", path=str(note_dir / "a.md")), self.studio._note("Untitled.md")]
        self.assertEqual(self.studio._python_folders(), [self.studio.folder, str(note_dir)])
        proxy = SimpleNamespace(retired=False, settings={"python": ""}, data=self.studio.data, _preferences=lambda notify=True: None, _emit=lambda *_a: None)
        with patch("python_runtime.default_python", return_value="/venv/bin/python"):
            Studio._choose_default_python(proxy)
        self.assertEqual(proxy.settings["python"], "/venv/bin/python")

        jobs, submit_patch = self._capture_submit()
        with submit_patch, patch.object(self.studio.pool, "_shutdown", True):
            self.studio.refreshPython()
            self.studio.installPythonPackages(sys.executable)
            self.studio.setupPython()
            self.assertEqual((jobs, self.studio.pythonBusy), ([], False))
        for choices, expected in (
            ([], "No Python found"),
            ([{"path": "/bin/python3", "matplotlib": False}], "numpy and matplotlib are missing"),
            ([{"path": "/bin/python3", "matplotlib": True}], ""),
        ):
            with submit_patch, patch("python_runtime.discover", return_value=choices):
                self.studio.refreshPython()
                action, done = jobs.pop()
                done(action(), None)
                self.assertIn(expected, self.studio.pythonStatus) if expected else self.assertEqual(self.studio.pythonStatus, "")
        with submit_patch, patch("python_runtime.install_packages", return_value="/custom/python") as install_mock, \
             patch("python_runtime.setup_environment", return_value="/managed/python") as setup_mock, \
             patch.object(self.studio, "refreshPython") as refresh_spy:
            self.studio.installPythonPackages("/base/python")
            self.assertEqual(self.studio.pythonStatus, "Preparing to install numpy and matplotlib")
            action, done = jobs.pop()
            done(action(), None)
            install_mock.assert_called_once_with("/base/python", self.studio.pythonProgress.emit)
            self.assertEqual((self.studio.settings["python"], refresh_spy.call_count), ("/custom/python", 1))
            self.studio.setupPython()
            self.assertEqual(self.studio.pythonStatus, "Preparing Python setup")
            action, done = jobs.pop()
            done(action(), None)
            setup_mock.assert_called_once_with(self.studio.data / "python-env", self.studio.pythonProgress.emit)
            self.assertEqual((self.studio.settings["python"], refresh_spy.call_count), ("/managed/python", 2))
            self.assertEqual(self.studio.pythonStatus, "Python with numpy and matplotlib is ready")

if __name__ == "__main__":
    unittest.main()
