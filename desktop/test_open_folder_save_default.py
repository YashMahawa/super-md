"""Desktop open-folder save defaults with configured fallback (8cbbd3e1 / a1056ca2), Save As, preserved exports/themes, sidebar refresh, and portal delivery."""
from __future__ import annotations

import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

from PySide6.QtCore import QEvent, QMetaObject, QObject, QStandardPaths, QUrl, Signal, Slot
from PySide6.QtGui import QGuiApplication
from PySide6.QtQml import QQmlComponent, QQmlEngine
from PySide6.QtQuickControls2 import QQuickStyle
from PySide6.QtTest import QTest

if QGuiApplication.instance() is None:
    QQuickStyle.setStyle("Material")

sys.path.insert(0, str(Path(__file__).resolve().parent))
import folder_ops
from studio import Session, Studio

MAIN = Path(__file__).resolve().parent / "qml" / "Main.qml"


class QuietStudio(Studio):
    def _refresh_theme(self):
        self.system_dark = True


class OpenFolderSaveDefaultTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.app = QGuiApplication.instance() or QGuiApplication(["Open-folder save default tests"])

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="supermd-open-save-default-")
        self.root = Path(folder_ops.canonical_path_str(self.temp.name))
        self.data_dir = self.root / "app-data"
        self.downloads_dir = self.root / "Downloads"
        self.downloads_dir.mkdir(parents=True, exist_ok=True)
        self.session = Session(True, data=self.data_dir)
        self.session.settings["welcomed"] = True
        self.session.settings["python"] = sys.executable
        self.session.settings["newNoteLocation"] = ""
        self.windows: list[QuietStudio] = []

    def tearDown(self):
        for win in list(self.windows):
            if not win.retired:
                win.stop()
            win.pool.shutdown(wait=True, cancel_futures=True)
            win._search_pool.shutdown(wait=True, cancel_futures=True)
        self.session.writes.shutdown(wait=True)
        self.app.processEvents()
        self.temp.cleanup()

    def assertSamePath(self, actual: str | os.PathLike[str], expected: str | os.PathLike[str]):
        self.assertTrue(
            folder_ops.same_path(actual, expected),
            f"Expected same path:\n  actual:   {actual}\n  expected: {expected}",
        )
        self.assertEqual(Path(actual).name, Path(expected).name)

    def flush_writes(self):
        self.session.writes.submit(lambda: None).result(timeout=5)
        self.app.processEvents()

    def make_window(self) -> QuietStudio:
        win = QuietStudio(True, session=self.session)
        self.windows.append(win)
        return win

    def wait_until(self, predicate, timeout: float = 3.0):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            self.app.processEvents()
            if predicate():
                return
            time.sleep(0.01)
        self.app.processEvents()
        self.assertTrue(predicate())

    def _patch_downloads(self):
        original = QStandardPaths.writableLocation

        def fake_writable(location):
            if location == QStandardPaths.StandardLocation.DownloadLocation:
                return str(self.downloads_dir)
            return original(location)

        return patch.object(QStandardPaths, "writableLocation", side_effect=fake_writable)

    def test_untitled_note_defaults_to_open_workspace_folder_even_when_configured_fallback_is_set(self):
        course_dir = self.root / "Course Notes"
        course_dir.mkdir()
        other_dir = self.root / "Research Lab"
        other_dir.mkdir()
        configured_fallback = self.root / "Configured Inbox"
        configured_fallback.mkdir()

        with self._patch_downloads():
            win1 = self.make_window()
            meta = win1.metaObject()
            for signature in (
                "defaultSaveFolder()",
                "defaultSaveLocation(QString)",
                "defaultSaveAsFolder()",
                "defaultSaveAsLocation(QString)",
                "defaultExportLocation(QString)",
                "defaultThemeExportLocation(QString)",
            ):
                self.assertEqual(meta.method(meta.indexOfMethod(signature)).typeName(), "QUrl")

            # Without open folder or configured fallback, untitled note defaults to Downloads.
            self.assertSamePath(win1.defaultSaveFolder().toLocalFile(), self.downloads_dir)
            self.assertSamePath(
                win1.defaultSaveLocation("Untitled.md").toLocalFile(),
                self.downloads_dir / "Untitled.md",
            )

            # Configure a fallback directory: without an open folder, untitled note uses configured fallback.
            win1.setNoteLocation(str(configured_fallback))
            self.assertSamePath(win1.defaultSaveFolder().toLocalFile(), configured_fallback)
            self.assertSamePath(
                win1.defaultSaveLocation("Untitled.md").toLocalFile(),
                configured_fallback / "Untitled.md",
            )

            # Explicitly opening a workspace folder in win1 makes newly saved untitled notes default to win1's open folder.
            win1.openFolder(str(course_dir))
            self.assertSamePath(win1.defaultSaveFolder().toLocalFile(), course_dir)
            self.assertSamePath(
                win1.defaultSaveLocation("Untitled.md").toLocalFile(),
                course_dir / "Untitled.md",
            )
            self.assertSamePath(
                win1.defaultSaveAsLocation("1.2 Linear Algebra.md").toLocalFile(),
                course_dir / "1.2 Linear Algebra.md",
            )

            # Multi-window isolation: win2 without an open folder uses the configured fallback;
            # once win2 opens other_dir, win2 defaults to other_dir while win1 keeps course_dir.
            win2 = self.make_window()
            self.assertSamePath(win2.defaultSaveFolder().toLocalFile(), configured_fallback)
            win2.openFolder(str(other_dir))
            self.assertSamePath(win2.defaultSaveFolder().toLocalFile(), other_dir)
            self.assertSamePath(
                win2.defaultSaveLocation("Draft.smd").toLocalFile(),
                other_dir / "Draft.smd",
            )
            self.assertSamePath(win1.defaultSaveFolder().toLocalFile(), course_dir)

            # Startup-restored open workspace folders also take precedence for untitled note saves.
            self.session.quitting = True
            win1.stop()
            win2.stop()
            self.flush_writes()

            restored_session = Session(True, data=self.data_dir)
            restored_session.settings["python"] = sys.executable
            restored_win1 = QuietStudio(True, session=restored_session)
            restored_win2 = QuietStudio(True, session=restored_session)
            try:
                self.assertSamePath(restored_win1.defaultSaveFolder().toLocalFile(), course_dir)
                self.assertSamePath(
                    restored_win1.defaultSaveLocation("Untitled.md").toLocalFile(),
                    course_dir / "Untitled.md",
                )
                self.assertSamePath(restored_win2.defaultSaveFolder().toLocalFile(), other_dir)
                self.assertSamePath(
                    restored_win2.defaultSaveLocation("Untitled.md").toLocalFile(),
                    other_dir / "Untitled.md",
                )
            finally:
                for rw in (restored_win1, restored_win2):
                    rw.stop()
                    rw.pool.shutdown(wait=True, cancel_futures=True)
                    rw._search_pool.shutdown(wait=True, cancel_futures=True)
                restored_session.writes.shutdown(wait=True)

    def test_unavailable_or_closed_open_folder_preserves_configured_fallback_then_downloads(self):
        transient_open = self.root / "Transient Workspace"
        transient_open.mkdir()
        configured_fallback = self.root / "Configured Notes"
        configured_fallback.mkdir()
        real_target = self.root / "Real Target"
        real_target.mkdir()
        symlink_dir = self.root / "Symlink Workspace"
        created_link = False
        try:
            symlink_dir.symlink_to(real_target, target_is_directory=True)
            created_link = True
        except OSError:
            if os.name == "nt":
                proc = subprocess.run(
                    ["cmd", "/c", "mklink", "/J", str(symlink_dir), str(real_target)],
                    capture_output=True,
                    text=True,
                )
                created_link = proc.returncode == 0
            else:
                raise

        with self._patch_downloads():
            win = self.make_window()
            win.setNoteLocation(str(configured_fallback))
            win.openFolder(str(transient_open))
            self.assertSamePath(win.defaultSaveFolder().toLocalFile(), transient_open)

            # Closing the workspace folder preserves the configured fallback.
            win.closeFolder()
            self.assertSamePath(win.defaultSaveFolder().toLocalFile(), configured_fallback)
            self.assertSamePath(
                win.defaultSaveLocation("Untitled.md").toLocalFile(),
                configured_fallback / "Untitled.md",
            )

            # Re-open transient_open, then remove it externally -> falls back to configured_fallback.
            win.openFolder(str(transient_open))
            self.assertSamePath(win.defaultSaveFolder().toLocalFile(), transient_open)
            shutil.rmtree(transient_open)
            self.assertSamePath(win.defaultSaveFolder().toLocalFile(), configured_fallback)
            self.assertSamePath(
                win.defaultSaveLocation("Untitled.md").toLocalFile(),
                configured_fallback / "Untitled.md",
            )

            # Replace deleted directory path with a regular file -> still falls back to configured_fallback.
            transient_open.write_text("not a directory", encoding="utf-8")
            self.assertSamePath(win.defaultSaveFolder().toLocalFile(), configured_fallback)

            # Symlink/junction folder is rejected -> preserves configured_fallback.
            if created_link:
                win.folder = str(symlink_dir)
                self.assertSamePath(win.defaultSaveFolder().toLocalFile(), configured_fallback)

            # Resetting or removing configured_fallback falls back cleanly to Downloads, then Path.home().
            shutil.rmtree(configured_fallback)
            self.assertSamePath(win.defaultSaveFolder().toLocalFile(), self.downloads_dir)
            configured_fallback.mkdir()
            self.assertSamePath(win.defaultSaveFolder().toLocalFile(), configured_fallback)
            win.clearNoteLocation()
            self.assertEqual(win.settings["newNoteLocation"], "")
            self.assertSamePath(win.defaultSaveFolder().toLocalFile(), self.downloads_dir)

            shutil.rmtree(self.downloads_dir)
            self.assertSamePath(win.defaultSaveFolder().toLocalFile(), Path.home())

    def test_save_as_prefers_existing_note_parent_and_saving_untitled_note_refreshes_open_folder_tree(self):
        workspace_dir = self.root / "Workspace"
        subfolder = workspace_dir / "Week 2"
        subfolder.mkdir(parents=True)
        configured_fallback = self.root / "Configured Fallback"
        configured_fallback.mkdir()
        external_dir = self.root / "External Notes"
        external_dir.mkdir()
        existing_note = external_dir / "1.2 Eigenvalues.md"
        existing_note.write_text("# Eigenvalues\n", encoding="utf-8")

        with self._patch_downloads():
            win = self.make_window()
            win.setNoteLocation(str(configured_fallback))
            win.openFolder(str(workspace_dir))
            self.wait_until(lambda: any(entry["name"] == "Week 2" for entry in win.files))

            # Save an untitled note directly into a subfolder of the open workspace -> tree expands and lists it.
            win._current()["content"] = "# Lecture Notes\n"
            saved_untitled = subfolder / "2.1 Orthogonal Bases.md"
            win.saveAs(QUrl.fromLocalFile(str(saved_untitled)).toString())
            self.wait_until(
                lambda: folder_ops.same_path(win._current()["path"], saved_untitled)
                and any(entry["name"] == "2.1 Orthogonal Bases.md" for entry in win.files)
            )
            self.assertTrue(saved_untitled.is_file())

            # Open an existing note outside workspace_dir -> Save As starts in its own parent directory.
            win.openNote(str(existing_note))
            self.wait_until(lambda: folder_ops.same_path(win._current()["path"], existing_note))
            self.assertSamePath(win.defaultSaveAsFolder().toLocalFile(), external_dir)
            self.assertSamePath(
                win.defaultSaveAsLocation(win._current()["name"]).toLocalFile(),
                external_dir / "1.2 Eigenvalues.md",
            )

            # If the existing note's parent disappears, Save As falls back to open workspace -> configured -> Downloads.
            shutil.rmtree(external_dir)
            self.assertSamePath(win.defaultSaveAsFolder().toLocalFile(), workspace_dir)
            shutil.rmtree(workspace_dir)
            self.assertSamePath(win.defaultSaveAsFolder().toLocalFile(), configured_fallback)
            shutil.rmtree(configured_fallback)
            self.assertSamePath(win.defaultSaveAsFolder().toLocalFile(), self.downloads_dir)

    def test_export_and_theme_destinations_keep_configured_fallback_when_folder_is_open(self):
        workspace_dir = self.root / "Active Course"
        workspace_dir.mkdir()
        configured_dir = self.root / "Custom Exports"
        configured_dir.mkdir()

        with self._patch_downloads():
            win = self.make_window()
            win.openFolder(str(workspace_dir))
            self.assertSamePath(
                win.defaultSaveLocation("Untitled.md").toLocalFile(),
                workspace_dir / "Untitled.md",
            )
            for fmt, expected_name in (
                ("pdf", "Untitled.pdf"),
                ("smd", "Untitled.smd"),
                ("md", "Untitled.md"),
                ("mdzip", "Untitled.zip"),
            ):
                self.assertSamePath(
                    win.defaultExportLocation(fmt).toLocalFile(),
                    self.downloads_dir / expected_name,
                )
            self.assertSamePath(
                win.defaultThemeExportLocation("My theme.supermd-theme.json").toLocalFile(),
                self.downloads_dir / "My theme.supermd-theme.json",
            )

            win.setNoteLocation(str(configured_dir))
            # Untitled note still defaults to the explicitly open workspace folder,
            # while exports and theme exports honor configured_dir!
            self.assertSamePath(
                win.defaultSaveLocation("Untitled.md").toLocalFile(),
                workspace_dir / "Untitled.md",
            )
            self.assertSamePath(
                win.defaultExportLocation("pdf").toLocalFile(),
                configured_dir / "Untitled.pdf",
            )
            self.assertSamePath(
                win.defaultThemeExportLocation("My theme.supermd-theme.json").toLocalFile(),
                configured_dir / "My theme.supermd-theme.json",
            )


class SaveDialogQmlUiTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.app = QGuiApplication.instance() or QGuiApplication(["Save chooser QML tests"])

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="supermd-save-qml-")
        self.root = Path(folder_ops.canonical_path_str(self.temp.name))
        self.open_folder = self.root / "Open Folder"
        self.open_folder.mkdir()
        self.note_folder = self.root / "Existing Note Folder"
        self.note_folder.mkdir()
        self.downloads = self.root / "Downloads"
        self.downloads.mkdir()

        source = MAIN.read_text(encoding="utf-8")
        factory = source[source.index("    function chooseSaveDestination("):source.index("    function chooseExportDestination(")]
        save_handlers = source[
            source.index("        function onSaveRequested(name)"):
            source.index("        function onSaveConflictRequested(name)")
        ]
        theme_handler = next(
            line for line in source.splitlines() if "function onThemeExportRequested()" in line
        )
        handlers = save_handlers + theme_handler + "\n"
        theme_dialog = next(
            line for line in source.splitlines() if "id:themeExportDialog" in line
        )
        chooser = source[
            source.index("    Component {\n        id: saveDestinationComponent"):
            source.index("    Component {\n        id: exportDestinationComponent")
        ]

        class SaveBackend(QObject):
            saveRequested = Signal(str)
            saveAsRequested = Signal(str)
            themeExportRequested = Signal()

            def __init__(self, outer: SaveDialogQmlUiTest):
                super().__init__()
                self.outer = outer
                self.saved: list[str] = []
                self.resolved: list[str] = []
                self.exported_themes: list[str] = []
                self.save_dir = outer.open_folder
                self.save_as_dir = outer.note_folder
                self.theme_dir = outer.downloads

            @Slot(result=QUrl)
            def defaultSaveFolder(self):
                return QUrl.fromLocalFile(str(self.save_dir))

            @Slot(str, result=QUrl)
            def defaultSaveLocation(self, name):
                return QUrl.fromLocalFile(str(self.save_dir / name))

            @Slot(result=QUrl)
            def defaultSaveAsFolder(self):
                return QUrl.fromLocalFile(str(self.save_as_dir))

            @Slot(str, result=QUrl)
            def defaultSaveAsLocation(self, name):
                return QUrl.fromLocalFile(str(self.save_as_dir / name))

            @Slot(str, result=QUrl)
            def defaultThemeExportLocation(self, name):
                return QUrl.fromLocalFile(str(self.theme_dir / name))

            @Slot(str)
            def saveAs(self, url):
                self.saved.append(QUrl(url).toLocalFile())

            @Slot(str)
            def resolveClose(self, choice):
                self.resolved.append(choice)

            @Slot(str)
            def exportCustomTheme(self, url):
                self.exported_themes.append(QUrl(url).toLocalFile())

        self.backend = SaveBackend(self)
        self.engine = QQmlEngine()
        self.engine.rootContext().setContextProperty("studio", self.backend)
        self.component = QQmlComponent(self.engine)
        qml_doc = f"""import QtQuick
import QtQuick.Controls
import QtQuick.Dialogs
ApplicationWindow {{
    id: window
    width: 640
    height: 420
    visible: true
    property var viewState: ({{ portable: false }})
    property bool sharing: false
    property string outputFormat: "pdf"
    QtObject {{ id: flushDialog; function close() {{}} }}
    QtObject {{ id: closeDialog; property bool visible: false; function close() {{}} }}
    QtObject {{ id: saveConflictDialog; property string title: ""; property bool visible: false; function open() {{}} }}
    QtObject {{ id: noteFolderDialog; function open() {{}} }}
    QtObject {{ id: exportDialog; function open() {{}} }}
    QtObject {{ id: folderDialog; function open() {{}} }}
    QtObject {{ id: fontDialog; function open() {{}} }}
    QtObject {{ id: themeDialog; function open() {{}} }}
    {theme_dialog}
{factory}
    Connections {{
        target: studio
{handlers}
    }}
{chooser}
}}
"""
        self.component.setData(qml_doc.encode("utf-8"), QUrl.fromLocalFile(str(MAIN)))
        self.window = self.component.create()
        self.assertIsNotNone(self.window, str(self.component.errors()))

    def tearDown(self):
        self.window.close()
        self.window.deleteLater()
        self.app.sendPostedEvents(None, QEvent.Type.DeferredDelete)
        self.engine.deleteLater()
        self.app.sendPostedEvents(None, QEvent.Type.DeferredDelete)
        self.temp.cleanup()

    def test_save_and_save_as_create_fresh_dialogs_and_preserve_theme_export(self):
        self.backend.saveRequested.emit("Untitled.md")
        QTest.qWait(30)
        chooser = self.window.findChild(QObject, "saveDestination")
        self.assertIsNotNone(chooser)
        self.assertEqual(chooser.property("title"), "Save note")
        self.assertEqual(Path(chooser.property("currentFolder").toLocalFile()), self.open_folder)
        self.assertEqual(Path(chooser.property("selectedFile").toLocalFile()), self.open_folder / "Untitled.md")
        self.assertTrue(chooser.property("nameFilters")[0].startswith("Markdown"))
        QMetaObject.invokeMethod(chooser, "accepted")
        self.app.sendPostedEvents(None, QEvent.Type.DeferredDelete)
        self.assertEqual(self.backend.saved[-1], str(self.open_folder / "Untitled.md"))
        self.assertIsNone(self.window.findChild(QObject, "saveDestination"))

        self.window.setProperty("viewState", {"portable": True})
        self.backend.saveAsRequested.emit("Bundle Ω.smd")
        QTest.qWait(30)
        chooser2 = self.window.findChild(QObject, "saveDestination")
        self.assertIsNotNone(chooser2)
        self.assertEqual(chooser2.property("title"), "Save as")
        self.assertEqual(Path(chooser2.property("currentFolder").toLocalFile()), self.note_folder)
        self.assertEqual(Path(chooser2.property("selectedFile").toLocalFile()), self.note_folder / "Bundle Ω.smd")
        self.assertTrue(chooser2.property("nameFilters")[0].startswith("Portable Super MD"))
        QMetaObject.invokeMethod(chooser2, "rejected")
        self.app.sendPostedEvents(None, QEvent.Type.DeferredDelete)
        self.assertEqual(self.backend.resolved, ["cancel"])
        self.assertIsNone(self.window.findChild(QObject, "saveDestination"))

        self.backend.themeExportRequested.emit()
        QTest.qWait(20)
        for child in self.window.children():
            if child.property("title") == "Export editable theme":
                self.assertEqual(
                    Path(child.property("selectedFile").toLocalFile()),
                    self.downloads / "My theme.supermd-theme.json",
                )
                QMetaObject.invokeMethod(child, "accepted")
                break
        else:
            self.fail("themeExportDialog not found")
        self.assertEqual(
            self.backend.exported_themes,
            [str(self.downloads / "My theme.supermd-theme.json")],
        )


class SaveLocationPortalTest(unittest.TestCase):
    @unittest.skipUnless(
        sys.platform.startswith("linux") and shutil.which("dbus-run-session"),
        "Linux portal protocol",
    )
    def test_portal_receives_open_folder_and_configured_fallback_across_consecutive_saves(self):
        with tempfile.TemporaryDirectory(prefix="supermd-save-portal-") as tmp:
            canon_tmp = Path(folder_ops.canonical_path_str(tmp))
            open_dir = canon_tmp / "Open Course"
            open_dir.mkdir()
            fallback_dir = canon_tmp / "Configured Fallback"
            fallback_dir.mkdir()

            environment = dict(
                os.environ,
                QT_QPA_PLATFORM="offscreen",
                QT_QUICK_BACKEND="software",
                QT_QPA_PLATFORMTHEME="xdgdesktopportal",
                XDG_CURRENT_DESKTOP="",
                SUPERMD_TEST_OPEN_DIR=str(open_dir),
                SUPERMD_TEST_FALLBACK_DIR=str(fallback_dir),
            )
            environment.pop("DISPLAY", None)
            environment.pop("WAYLAND_DISPLAY", None)
            result = subprocess.run(
                ["dbus-run-session", "--", sys.executable, __file__, "--portal-server"],
                env=environment,
                capture_output=True,
                text=True,
                timeout=25,
            )
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            payload = json.loads(
                next(line[7:] for line in result.stdout.splitlines() if line.startswith("RESULT:"))
            )
            self.assertEqual(
                payload["calls"],
                [
                    {
                        "title": "Save note",
                        "folder": str(open_dir),
                        "name": "Untitled.md",
                    },
                    {
                        "title": "Save note",
                        "folder": str(fallback_dir),
                        "name": "1.2 Lecture Ω.md",
                    },
                ],
            )
            self.assertEqual(
                payload["saved"],
                [
                    str(open_dir / "Untitled.md"),
                    str(fallback_dir / "1.2 Lecture Ω.md"),
                ],
            )


def _decode_portal_folder(raw) -> str:
    if raw is None:
        return ""
    data = bytes(raw).rstrip(b"\x00")
    return os.fsdecode(data)


def _portal_server() -> int:
    from PySide6.QtCore import ClassInfo, Property, QCoreApplication, QProcess, QTimer
    from PySide6.QtDBus import QDBusConnection, QDBusObjectPath

    app = QCoreApplication([])
    bus = QDBusConnection.sessionBus()
    calls: list[dict[str, str]] = []
    requests: list[QObject] = []

    @ClassInfo(**{"D-Bus Interface": "org.freedesktop.portal.Request"})
    class Request(QObject):
        Response = Signal("uint", "QVariantMap")

    @ClassInfo(**{"D-Bus Interface": "org.freedesktop.portal.FileChooser"})
    class Portal(QObject):
        @Property(int, constant=True)
        def version(self):
            return 4

        @Slot(str, str, "QVariantMap", result=QDBusObjectPath)
        def SaveFile(self, _parent, title, options):
            folder = _decode_portal_folder(options.get("current_folder"))
            name = options.get("current_name", "")
            calls.append({"title": title, "folder": folder, "name": name})
            req_path = f"/org/freedesktop/portal/desktop/request/save/{len(calls)}"
            req = Request()
            requests.append(req)
            assert bus.registerObject(req_path, req, QDBusConnection.RegisterOption.ExportAllSignals)
            dest = Path(folder) / name if folder else Path("/tmp") / name
            uri = QUrl.fromLocalFile(str(dest)).toString(QUrl.ComponentFormattingOption.FullyEncoded)
            QTimer.singleShot(40, lambda: req.Response.emit(0, {"uris": [uri]}))
            return QDBusObjectPath(req_path)

    portal = Portal()
    assert bus.registerService("org.freedesktop.portal.Desktop")
    assert bus.registerObject(
        "/org/freedesktop/portal/desktop",
        portal,
        QDBusConnection.RegisterOption.ExportAllSlots | QDBusConnection.RegisterOption.ExportAllProperties,
    )
    child = QProcess()
    child.setProcessChannelMode(QProcess.ProcessChannelMode.SeparateChannels)

    def finished(code, _status):
        output = bytes(child.readAllStandardOutput()).decode()
        error = bytes(child.readAllStandardError()).decode()
        if code == 0 and output.startswith("SAVED:"):
            print(
                "RESULT:" + json.dumps({"calls": calls, "saved": json.loads(output[6:])}),
                flush=True,
            )
        else:
            print(output + error, flush=True)
        app.exit(code)

    child.finished.connect(finished)
    child.start(sys.executable, [__file__, "--portal-client"])
    QTimer.singleShot(18000, lambda: (child.kill(), app.exit(2)))
    return app.exec()


def _portal_client() -> int:
    from PySide6.QtCore import QTimer
    from PySide6.QtWidgets import QApplication

    app = QApplication([])
    open_dir = Path(os.environ["SUPERMD_TEST_OPEN_DIR"])
    fallback_dir = Path(os.environ["SUPERMD_TEST_FALLBACK_DIR"])
    saved: list[str] = []

    class Backend(QObject):
        saveRequested = Signal(str)
        saveAsRequested = Signal(str)

        def __init__(self):
            super().__init__()
            self.active_dir = open_dir

        @Slot(result=QUrl)
        def defaultSaveFolder(self):
            return QUrl.fromLocalFile(str(self.active_dir))

        @Slot(str, result=QUrl)
        def defaultSaveLocation(self, name):
            return QUrl.fromLocalFile(str(self.active_dir / name))

        @Slot(result=QUrl)
        def defaultSaveAsFolder(self):
            return QUrl.fromLocalFile(str(self.active_dir))

        @Slot(str, result=QUrl)
        def defaultSaveAsLocation(self, name):
            return QUrl.fromLocalFile(str(self.active_dir / name))

        @Slot(str)
        def saveAs(self, url):
            saved.append(QUrl(url).toLocalFile())
            QTimer.singleShot(50, step)

        @Slot(str)
        def resolveClose(self, _choice):
            app.exit(3)

    source = MAIN.read_text(encoding="utf-8")
    factory = source[source.index("    function chooseSaveDestination("):source.index("    function chooseExportDestination(")]
    handlers = source[
        source.index("        function onSaveRequested(name)"):
        source.index("        function onSaveConflictRequested(name)")
    ]
    chooser = source[
        source.index("    Component {\n        id: saveDestinationComponent"):
        source.index("    Component {\n        id: exportDestinationComponent")
    ]

    engine = QQmlEngine()
    backend = Backend()
    engine.rootContext().setContextProperty("studio", backend)
    component = QQmlComponent(engine)
    component.setData(
        f"""import QtQuick
import QtQuick.Controls
import QtQuick.Dialogs
ApplicationWindow {{
    id: window
    width: 500
    height: 400
    visible: true
    property var viewState: ({{ portable: false }})
{factory}
    Connections {{
        target: studio
{handlers}
    }}
{chooser}
}}
""".encode("utf-8"),
        QUrl.fromLocalFile(str(MAIN)),
    )
    window = component.create()
    assert window is not None, str(component.errors())

    def step():
        if len(saved) == 0:
            backend.active_dir = open_dir
            backend.saveRequested.emit("Untitled.md")
        elif len(saved) == 1:
            backend.active_dir = fallback_dir
            backend.saveRequested.emit("1.2 Lecture Ω.md")
        else:
            print("SAVED:" + json.dumps(saved), flush=True)
            app.quit()

    QTimer.singleShot(200, step)
    QTimer.singleShot(15000, lambda: app.exit(2))
    return app.exec()


if __name__ == "__main__":
    if "--portal-server" in sys.argv:
        sys.exit(_portal_server())
    if "--portal-client" in sys.argv:
        sys.exit(_portal_client())
    unittest.main()
