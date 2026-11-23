from __future__ import annotations

import os
import runpy
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest.mock import patch


HOOK = Path(__file__).parent / "pyinstaller_hooks" / "hook-PySide6.QtWebEngineCore.py"


class FakeQtLibraryInfo:
    version = [6, 11, 2]

    def __init__(self, framework: Path, *, fail: bool = False):
        self.location = {"LibrariesPath": str(framework.parent)}
        self.framework = framework
        self.fail = fail
        self.seen_versions = None
        self.seen_other = None
        self.seen_fd = None

    def collect_qtwebengine_files(self):
        self.seen_versions = qt_hooks.os.listdir(self.framework / "Versions")
        self.seen_other = qt_hooks.os.listdir(self.framework / "Helpers")
        if hasattr(self, "list_fd"):
            self.seen_fd = qt_hooks.os.listdir(self.list_fd)
        if self.fail:
            raise RuntimeError("collector failed")
        return [("helper-binary", "helper-destination")], [("resource-file", "resource-destination")]


def fake_pyinstaller_modules(info: FakeQtLibraryInfo):
    global qt_hooks
    pyinstaller = types.ModuleType("PyInstaller")
    utils = types.ModuleType("PyInstaller.utils")
    hooks = types.ModuleType("PyInstaller.utils.hooks")
    qt_hooks = types.ModuleType("PyInstaller.utils.hooks.qt")
    qt_hooks.os = os
    qt_hooks.pyside6_library_info = info
    qt_hooks.add_qt6_dependencies = lambda _hook: (["dependency"], [], [])
    pyinstaller.utils = utils
    utils.hooks = hooks
    hooks.qt = qt_hooks
    modules = {
        "PyInstaller": pyinstaller,
        "PyInstaller.utils": utils,
        "PyInstaller.utils.hooks": hooks,
        "PyInstaller.utils.hooks.qt": qt_hooks,
    }
    return modules


class PyInstallerQtWebEngineHookTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.framework = Path(self.temp.name) / "Qt/lib/QtWebEngineCore.framework"
        (self.framework / "Versions/A").mkdir(parents=True)
        (self.framework / "Versions/A/QtWebEngineCore").write_bytes(b"framework binary")
        (self.framework / "Versions/Resources/Helpers").mkdir(parents=True)
        (self.framework / "Helpers/QtWebEngineProcess.app/Contents/MacOS").mkdir(parents=True)
        (self.framework / "Resources").mkdir()
        self.info = FakeQtLibraryInfo(self.framework)

    def tearDown(self):
        self.temp.cleanup()

    def run_hook(self, platform="darwin"):
        original_sys_path = sys.path[:]
        try:
            with patch.dict(sys.modules, fake_pyinstaller_modules(self.info)), patch("sys.platform", platform):
                return runpy.run_path(str(HOOK))
        finally:
            sys.path[:] = original_sys_path

    def test_darwin_hook_filters_only_target_framework_versions_and_restores_listdir(self):
        original_listdir = os.listdir
        result = self.run_hook()
        self.assertIs(os.listdir, original_listdir)
        self.assertEqual(self.info.seen_versions, ["A", "Current"] if (self.framework / "Versions/Current").exists()
                         else ["A"])
        self.assertEqual(self.info.seen_other,
                         ["QtWebEngineProcess.app"])
        self.assertEqual(result["binaries"], [("helper-binary", "helper-destination")])
        self.assertEqual(result["datas"], [("resource-file", "resource-destination")])
        self.assertEqual(result["hiddenimports"], ["dependency", "PySide6.QtPrintSupport"])

    def test_darwin_hook_restores_listdir_when_upstream_collection_fails(self):
        self.info.fail = True
        original_listdir = os.listdir
        with self.assertRaisesRegex(RuntimeError, "collector failed"):
            self.run_hook()
        self.assertIs(os.listdir, original_listdir)

    def test_other_platform_passes_framework_version_entries_unchanged(self):
        original_listdir = os.listdir
        expected_versions = original_listdir(self.framework / "Versions")
        result = self.run_hook("linux")
        self.assertIs(os.listdir, original_listdir)
        self.assertEqual(self.info.seen_versions, expected_versions)
        self.assertEqual(self.info.seen_other, ["QtWebEngineProcess.app"])
        self.assertEqual(result["binaries"], [("helper-binary", "helper-destination")])

    @unittest.skipUnless(os.name == "posix", "directory file descriptors are POSIX-only")
    def test_filter_wrapper_preserves_os_listdir_file_descriptor_support(self):
        with tempfile.TemporaryDirectory() as directory:
            Path(directory, "entry").touch()
            fd = os.open(directory, os.O_RDONLY)
            try:
                self.info.list_fd = fd
                self.run_hook()
                self.assertEqual(self.info.seen_fd, ["entry"])
            finally:
                os.close(fd)


if __name__ == "__main__":
    unittest.main()
