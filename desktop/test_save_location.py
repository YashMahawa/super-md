"""Desktop note save-location precedence, unavailable-folder fallbacks, Save As, preserved exports/themes, and portal picker delivery."""
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
from PySide6.QtTest import QTest

sys.path.insert(0, str(Path(__file__).resolve().parent))
import folder_ops
from studio import Session, Studio

MAIN = Path(__file__).resolve().parent / "qml" / "Main.qml"


class QuietStudio(Studio):
    def _refresh_theme(self):
        self.system_dark = True


def _assert_same_path(
    test_case: unittest.TestCase,
    actual: str | os.PathLike[str],
    expected: str | os.PathLike[str],
):
    test_case.assertTrue(
        folder_ops.same_path(actual, expected),
        f"Expected same path:\n  actual:   {actual}\n  expected: {expected}",
    )
    test_case.assertEqual(
        folder_ops._pure_path(str(actual)).name,
        folder_ops._pure_path(str(expected)).name,
    )


class SaveLocationStudioTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.app = QGuiApplication.instance() or QGuiApplication(["Save location tests"])

    def setUp(self):
        self.temp_dir = Path(tempfile.mkdtemp(prefix="supermd-save-loc-"))
        self.root = Path(folder_ops.canonical_path_str(self.temp_dir))
        self.data_dir = self.root / "app-data"
        self.downloads_dir = self.root / "Downloads"
        self.downloads_dir.mkdir(parents=True, exist_ok=True)
        self.session = Session(True, data=self.data_dir)
        self.session.settings["welcomed"] = True
        self.session.settings["newNoteLocation"] = ""
        self.windows: list[QuietStudio] = []

    def assertSamePath(self, actual: str | os.PathLike[str], expected: str | os.PathLike[str]):
        _assert_same_path(self, actual, expected)

    def tearDown(self):
        for win in list(self.windows):
            if not win.retired:
                win.stop()
            win.pool.shutdown(wait=True, cancel_futures=True)
            win._search_pool.shutdown(wait=True, cancel_futures=True)
            win.deleteLater()
        self.session.writes.shutdown(wait=True)
        self.app.sendPostedEvents(None, QEvent.Type.DeferredDelete)
        self.app.processEvents()
        shutil.rmtree(self.temp_dir, ignore_errors=True)

    def _remove_dir_externally(self, win: QuietStudio, directory: Path):
        # Release Windows QFileSystemWatcher directory handles before simulating external
        # folder deletion, while keeping win.folder and open tab paths intact.
        win._suspend_watches_for_prefix(str(directory), is_dir=True)
        self.app.processEvents()
        shutil.rmtree(directory)

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

    def test_untitled_note_uses_open_and_restored_window_folder_when_no_preference_set(self):
        course_dir = self.root / "Course Notes"
        course_dir.mkdir()
        other_dir = self.root / "Research Lab"
        other_dir.mkdir()

        with self._patch_downloads():
            win1 = self.make_window()
            # Without open folder or custom preference, untitled note suggests Downloads.
            self.assertSamePath(win1.defaultSaveFolder().toLocalFile(), self.downloads_dir)
            self.assertSamePath(
                win1.defaultSaveLocation("Untitled.md").toLocalFile(),
                self.downloads_dir / "Untitled.md",
            )

            # Opening a folder in win1 switches untitled save destination to win1's folder.
            win1.openFolder(str(course_dir))
            canon_course = Path(folder_ops.canonical_path_str(course_dir))
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

            requested_names: list[str] = []
            win1.saveRequested.connect(requested_names.append)
            win1.save()
            self.assertEqual(requested_names, ["Untitled.md"])
            self.assertSamePath(win1.defaultSaveFolder().toLocalFile(), canon_course)
            self.assertSamePath(
                win1.defaultSaveLocation("Untitled.md").toLocalFile(),
                canon_course / "Untitled.md",
            )

            # Closing the folder returns untitled note save destination to Downloads; re-opening restores it.
            win1.closeFolder()
            self.assertSamePath(win1.defaultSaveFolder().toLocalFile(), self.downloads_dir)
            win1.openFolder(str(course_dir))
            self.assertSamePath(win1.defaultSaveFolder().toLocalFile(), canon_course)

            # Active window isolation: win2 with a different folder (or no folder) uses its own folder.
            win2 = self.make_window()
            self.assertSamePath(win2.defaultSaveFolder().toLocalFile(), self.downloads_dir)
            win2.openFolder(str(other_dir))
            canon_other = Path(folder_ops.canonical_path_str(other_dir))
            self.assertSamePath(win2.defaultSaveFolder().toLocalFile(), canon_other)
            self.assertSamePath(
                win2.defaultSaveLocation("Draft.smd").toLocalFile(),
                canon_other / "Draft.smd",
            )
            self.assertSamePath(win1.defaultSaveFolder().toLocalFile(), canon_course)

            # Simulate app quit & startup restore: restored open folder is used immediately for untitled save.
            self.session.quitting = True
            win1.stop()
            win2.stop()
            self.flush_writes()

            restored_session = Session(True, data=self.data_dir)
            restored_win1 = QuietStudio(True, session=restored_session)
            restored_win2 = QuietStudio(True, session=restored_session)
            try:
                self.assertSamePath(restored_win1.defaultSaveFolder().toLocalFile(), canon_course)
                self.assertSamePath(
                    restored_win1.defaultSaveLocation("Untitled.md").toLocalFile(),
                    canon_course / "Untitled.md",
                )
                self.assertSamePath(restored_win2.defaultSaveFolder().toLocalFile(), canon_other)
                self.assertSamePath(
                    restored_win2.defaultSaveLocation("Untitled.md").toLocalFile(),
                    canon_other / "Untitled.md",
                )
            finally:
                for rw in (restored_win1, restored_win2):
                    rw.stop()
                    rw.pool.shutdown(wait=True, cancel_futures=True)
                    rw._search_pool.shutdown(wait=True, cancel_futures=True)
                    rw.deleteLater()
                restored_session.writes.shutdown(wait=True)
                self.app.sendPostedEvents(None, QEvent.Type.DeferredDelete)

    def test_explicit_new_note_location_overrides_open_folder_until_cleared_or_unavailable(self):
        open_dir = self.root / "Open Workspace"
        open_dir.mkdir()
        preferred_dir = self.root / "Preferred Inbox"
        preferred_dir.mkdir()

        with self._patch_downloads():
            win = self.make_window()
            win.openFolder(str(open_dir))
            canon_open = Path(folder_ops.canonical_path_str(open_dir))

            win.setNoteLocation(str(preferred_dir))
            self.assertSamePath(win.defaultSaveFolder().toLocalFile(), preferred_dir)
            self.assertSamePath(
                win.defaultSaveLocation("Untitled.md").toLocalFile(),
                preferred_dir / "Untitled.md",
            )
            # Save As on an untitled note also honors the explicit preference.
            self.assertSamePath(
                win.defaultSaveAsLocation("Untitled.md").toLocalFile(),
                preferred_dir / "Untitled.md",
            )

            # If the configured preference directory becomes unavailable, fall back to open folder.
            shutil.rmtree(preferred_dir)
            self.assertSamePath(win.defaultSaveFolder().toLocalFile(), canon_open)
            self.assertSamePath(
                win.defaultSaveLocation("Untitled.md").toLocalFile(),
                canon_open / "Untitled.md",
            )

            # Clearing newNoteLocation explicitly also uses the active window's open folder.
            win.settings["newNoteLocation"] = ""
            self.assertSamePath(win.defaultSaveFolder().toLocalFile(), canon_open)

    def test_unavailable_open_folder_or_symlink_falls_back_to_downloads(self):
        transient_dir = self.root / "Transient Folder"
        transient_dir.mkdir()
        real_target = self.root / "Real Target"
        real_target.mkdir()
        symlink_dir = self.root / "Symlink Folder"
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
            win.openFolder(str(transient_dir))
            self.assertSamePath(
                win.defaultSaveFolder().toLocalFile(),
                folder_ops.canonical_path_str(transient_dir),
            )

            # Delete the open folder while the window is still open -> falls back to Downloads.
            self._remove_dir_externally(win, transient_dir)
            self.assertSamePath(win.defaultSaveFolder().toLocalFile(), self.downloads_dir)
            self.assertSamePath(
                win.defaultSaveLocation("Untitled.md").toLocalFile(),
                self.downloads_dir / "Untitled.md",
            )

            # Replace deleted directory path with a regular file -> still falls back to Downloads.
            transient_dir.write_text("not a directory", encoding="utf-8")
            self.assertSamePath(win.defaultSaveFolder().toLocalFile(), self.downloads_dir)

            # Symlinked/junction self.folder is rejected for open-folder save destination -> falls back to Downloads.
            if created_link:
                win.folder = str(symlink_dir)
                self.assertSamePath(win.defaultSaveFolder().toLocalFile(), self.downloads_dir)

            # If Downloads itself is missing/unavailable, falls back to Path.home().
            shutil.rmtree(self.downloads_dir)
            self.assertSamePath(win.defaultSaveFolder().toLocalFile(), Path.home())

    def test_save_as_from_existing_note_prefers_note_parent_and_handles_missing_parent(self):
        workspace_dir = self.root / "Workspace"
        workspace_dir.mkdir()
        preferred_dir = self.root / "Custom Notes"
        preferred_dir.mkdir()
        note_dir = self.root / "External Subject" / "Week 3"
        note_dir.mkdir(parents=True)
        existing_note = note_dir / "1.2 Eigenvalues.md"
        existing_note.write_text("# Eigenvalues\n", encoding="utf-8")

        with self._patch_downloads():
            win = self.make_window()
            win.openFolder(str(workspace_dir))
            win.setNoteLocation(str(preferred_dir))
            win.openNote(str(existing_note))
            self.wait_until(lambda: folder_ops.same_path(win._current()["path"], existing_note))

            # Save As from an existing note starts in that note's parent directory even when
            # both openFolder and newNoteLocation point elsewhere.
            self.assertSamePath(win.defaultSaveAsFolder().toLocalFile(), note_dir)
            self.assertSamePath(
                win.defaultSaveAsLocation(win._current()["name"]).toLocalFile(),
                note_dir / "1.2 Eigenvalues.md",
            )

            # If the existing note's parent directory is deleted externally, Save As falls back
            # to _note_save_directory() (preferred_dir -> workspace_dir -> Downloads).
            self._remove_dir_externally(win, note_dir)
            self.assertSamePath(win.defaultSaveAsFolder().toLocalFile(), preferred_dir)
            win.settings["newNoteLocation"] = ""
            self.assertSamePath(
                win.defaultSaveAsFolder().toLocalFile(),
                folder_ops.canonical_path_str(workspace_dir),
            )
            self._remove_dir_externally(win, workspace_dir)
            self.assertSamePath(win.defaultSaveAsFolder().toLocalFile(), self.downloads_dir)

    def test_export_and_theme_destinations_are_preserved_when_folder_is_open(self):
        workspace_dir = self.root / "Active Course"
        workspace_dir.mkdir()
        preferred_dir = self.root / "Custom Exports"
        preferred_dir.mkdir()
        saved_dir = self.root / "Saved Lecture"
        saved_dir.mkdir()
        saved_note = saved_dir / "Lecture 4.md"
        saved_note.write_text("# Lecture 4\n", encoding="utf-8")

        with self._patch_downloads():
            win = self.make_window()
            win.openFolder(str(workspace_dir))

            # Untitled note with open folder: note save goes to workspace_dir,
            # while export and theme export still go to Downloads!
            self.assertSamePath(
                win.defaultSaveLocation("Untitled.md").toLocalFile(),
                Path(folder_ops.canonical_path_str(workspace_dir)) / "Untitled.md",
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

            # Even when viewing a saved note in saved_dir, export and theme destinations remain unchanged.
            win.openNote(str(saved_note))
            self.wait_until(lambda: folder_ops.same_path(win._current()["path"], saved_note))
            self.assertSamePath(
                win.defaultExportLocation("pdf").toLocalFile(),
                self.downloads_dir / "Lecture 4.pdf",
            )
            self.assertSamePath(
                win.defaultThemeExportLocation("My theme.supermd-theme.json").toLocalFile(),
                self.downloads_dir / "My theme.supermd-theme.json",
            )

            # When newNoteLocation is configured, export and theme export continue honoring it.
            win.setNoteLocation(str(preferred_dir))
            self.assertSamePath(
                win.defaultExportLocation("pdf").toLocalFile(),
                preferred_dir / "Lecture 4.pdf",
            )
            self.assertSamePath(
                win.defaultThemeExportLocation("My theme.supermd-theme.json").toLocalFile(),
                preferred_dir / "My theme.supermd-theme.json",
            )

    def test_stopping_windows_releases_filesystem_watchers(self):
        def count_inotify() -> int:
            if not Path("/proc/self/fd").is_dir():
                return 0
            total = 0
            for fd in os.listdir("/proc/self/fd"):
                try:
                    if "inotify" in os.readlink(f"/proc/self/fd/{fd}"):
                        total += 1
                except OSError:
                    pass
            return total

        folder_dir = self.root / "Watched Course"
        folder_dir.mkdir()
        before = count_inotify()
        win = self.make_window()
        win.openFolder(str(folder_dir))
        if Path("/proc/self/fd").is_dir():
            self.assertGreater(count_inotify(), before)
        win.stop()
        self.assertEqual(win.note_watcher.files(), [])
        self.assertEqual(win.note_watcher.directories(), [])
        if Path("/proc/self/fd").is_dir():
            self.assertEqual(count_inotify(), before)


class SaveDialogQmlUiTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.app = QGuiApplication.instance() or QGuiApplication(["Save chooser QML tests"])

    def assertSamePath(self, actual: str | os.PathLike[str], expected: str | os.PathLike[str]):
        _assert_same_path(self, actual, expected)

    def setUp(self):
        self.temp_dir = Path(tempfile.mkdtemp(prefix="supermd-save-qml-"))
        self.root = Path(folder_ops.canonical_path_str(self.temp_dir))
        self.open_folder = self.root / "Open Folder"
        self.open_folder.mkdir()
        self.note_folder = self.root / "Existing Note Folder"
        self.note_folder.mkdir()
        self.downloads = self.root / "Downloads"
        self.downloads.mkdir()

        source = MAIN.read_text(encoding="utf-8")
        factory = source[source.index("    function chooseSaveDestination("):source.index("    function showExport(")]
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
        shutil.rmtree(self.temp_dir, ignore_errors=True)

    def test_save_and_save_as_create_fresh_dialogs_and_preserve_theme_export(self):
        # 1. Untitled Save note -> seeded with active window's open folder
        self.backend.saveRequested.emit("Untitled.md")
        QTest.qWait(30)
        chooser = self.window.findChild(QObject, "saveDestination")
        self.assertIsNotNone(chooser)
        self.assertEqual(chooser.property("title"), "Save note")
        self.assertSamePath(chooser.property("currentFolder").toLocalFile(), self.open_folder)
        self.assertSamePath(chooser.property("selectedFile").toLocalFile(), self.open_folder / "Untitled.md")
        self.assertTrue(chooser.property("nameFilters")[0].startswith("Markdown"))
        QMetaObject.invokeMethod(chooser, "accepted")
        self.app.sendPostedEvents(None, QEvent.Type.DeferredDelete)
        self.assertSamePath(self.backend.saved[-1], self.open_folder / "Untitled.md")
        self.assertIsNone(self.window.findChild(QObject, "saveDestination"))

        # 2. Save As on existing portable note -> fresh chooser in note's parent folder with portable filter first
        self.window.setProperty("viewState", {"portable": True})
        self.backend.saveAsRequested.emit("Bundle Ω.smd")
        QTest.qWait(30)
        chooser2 = self.window.findChild(QObject, "saveDestination")
        self.assertIsNotNone(chooser2)
        self.assertEqual(chooser2.property("title"), "Save as")
        self.assertSamePath(chooser2.property("currentFolder").toLocalFile(), self.note_folder)
        self.assertSamePath(chooser2.property("selectedFile").toLocalFile(), self.note_folder / "Bundle Ω.smd")
        self.assertTrue(chooser2.property("nameFilters")[0].startswith("Portable Super MD"))
        QMetaObject.invokeMethod(chooser2, "rejected")
        self.app.sendPostedEvents(None, QEvent.Type.DeferredDelete)
        self.assertEqual(self.backend.resolved, ["cancel"])
        self.assertIsNone(self.window.findChild(QObject, "saveDestination"))

        # 3. Theme export dialog remains bound to defaultThemeExportLocation (Downloads), not save_dir
        self.backend.themeExportRequested.emit()
        QTest.qWait(20)
        # Invoke accepted on themeExportDialog by checking its selectedFile via backend export
        for child in self.window.children():
            if child.property("title") == "Export editable theme":
                self.assertSamePath(
                    child.property("selectedFile").toLocalFile(),
                    self.downloads / "My theme.supermd-theme.json",
                )
                QMetaObject.invokeMethod(child, "accepted")
                break
        else:
            self.fail("themeExportDialog not found")
        self.assertEqual(len(self.backend.exported_themes), 1)
        self.assertSamePath(
            self.backend.exported_themes[0],
            self.downloads / "My theme.supermd-theme.json",
        )


class SaveLocationPortalTest(unittest.TestCase):
    @unittest.skipUnless(
        sys.platform.startswith("linux") and shutil.which("dbus-run-session"),
        "Linux portal protocol",
    )
    def test_portal_receives_open_folder_and_save_as_folder_with_fresh_names(self):
        with tempfile.TemporaryDirectory(prefix="supermd-save-portal-") as tmp:
            canon_tmp = Path(folder_ops.canonical_path_str(tmp))
            open_dir = canon_tmp / "Open Course"
            open_dir.mkdir()
            note_dir = canon_tmp / "Saved Chapter"
            note_dir.mkdir()

            environment = dict(
                os.environ,
                QT_QPA_PLATFORM="offscreen",
                QT_QUICK_BACKEND="software",
                QT_QPA_PLATFORMTHEME="xdgdesktopportal",
                XDG_CURRENT_DESKTOP="",
                SUPERMD_TEST_OPEN_DIR=str(open_dir),
                SUPERMD_TEST_NOTE_DIR=str(note_dir),
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
                        "title": "Save as",
                        "folder": str(note_dir),
                        "name": "1.2 Lecture Ω.md",
                    },
                ],
            )
            self.assertEqual(
                payload["saved"],
                [
                    str(open_dir / "Untitled.md"),
                    str(note_dir / "1.2 Lecture Ω.md"),
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
    from PySide6.QtQuickControls2 import QQuickStyle
    from PySide6.QtWidgets import QApplication

    QQuickStyle.setStyle("Material")
    app = QApplication([])
    open_dir = Path(os.environ["SUPERMD_TEST_OPEN_DIR"])
    note_dir = Path(os.environ["SUPERMD_TEST_NOTE_DIR"])
    saved: list[str] = []

    class Backend(QObject):
        saveRequested = Signal(str)
        saveAsRequested = Signal(str)

        @Slot(result=QUrl)
        def defaultSaveFolder(self):
            return QUrl.fromLocalFile(str(open_dir))

        @Slot(str, result=QUrl)
        def defaultSaveLocation(self, name):
            return QUrl.fromLocalFile(str(open_dir / name))

        @Slot(result=QUrl)
        def defaultSaveAsFolder(self):
            return QUrl.fromLocalFile(str(note_dir))

        @Slot(str, result=QUrl)
        def defaultSaveAsLocation(self, name):
            return QUrl.fromLocalFile(str(note_dir / name))

        @Slot(str)
        def saveAs(self, url):
            saved.append(QUrl(url).toLocalFile())
            QTimer.singleShot(50, step)

        @Slot(str)
        def resolveClose(self, _choice):
            app.exit(3)

    source = MAIN.read_text(encoding="utf-8")
    factory = source[source.index("    function chooseSaveDestination("):source.index("    function showExport(")]
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
            backend.saveRequested.emit("Untitled.md")
        elif len(saved) == 1:
            backend.saveAsRequested.emit("1.2 Lecture Ω.md")
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
