"""PyInstaller QtWebEngine hook with a macOS framework-version correction."""
import os
import sys
from pathlib import Path

from PyInstaller.utils.hooks import qt as qt_hooks
from PyInstaller.utils.hooks.qt import add_qt6_dependencies, pyside6_library_info

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from package_runtime import qtwebengine_framework_entries, qtwebengine_framework_version


if pyside6_library_info.version is not None:
    if pyside6_library_info.version < [6, 2, 2]:
        raise SystemExit("ERROR: PyInstaller's QtWebEngine support requires Qt6 6.2.2 or later!")

    hiddenimports, binaries, datas = add_qt6_dependencies(__file__)

    framework = Path(pyside6_library_info.location["LibrariesPath"]) / "QtWebEngineCore.framework"
    if sys.platform == "darwin" and framework.is_dir():
        versions_path = framework / "Versions"
        selected_version = qtwebengine_framework_version(framework)
        original_listdir = qt_hooks.os.listdir
        versions_key = os.path.normcase(os.path.abspath(versions_path))

        def listdir_without_resource_alias(path):
            entries = original_listdir(path)
            try:
                path_key = os.path.normcase(os.path.abspath(os.fspath(path)))
            except TypeError:
                # os.listdir also accepts an open directory fd.
                return entries
            if path_key == versions_key:
                return qtwebengine_framework_entries(entries, selected_version)
            return entries

        # PyInstaller 6.22 treats the wheel's `Versions/Resources` directory
        # as another framework version and sorts it after `A`. Filter only this
        # framework's version listing while its upstream collector runs.
        qt_hooks.os.listdir = listdir_without_resource_alias
        try:
            webengine_binaries, webengine_datas = pyside6_library_info.collect_qtwebengine_files()
        finally:
            qt_hooks.os.listdir = original_listdir
    else:
        webengine_binaries, webengine_datas = pyside6_library_info.collect_qtwebengine_files()

    binaries += webengine_binaries
    datas += webengine_datas
    hiddenimports += ["PySide6.QtPrintSupport"]
