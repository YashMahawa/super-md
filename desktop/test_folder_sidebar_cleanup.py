"""Tests for clean FolderSidebar chrome and default-on non-note subfolder filtering."""
import json
import os
import shutil
import tempfile
import time
import unittest
from pathlib import Path

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
os.environ.setdefault("QT_QUICK_BACKEND", "software")

from PySide6.QtCore import QEvent, QMetaObject, QObject, QUrl
from PySide6.QtGui import QGuiApplication
from PySide6.QtQml import QQmlComponent, QQmlEngine
from PySide6.QtQuickControls2 import QQuickStyle
from PySide6.QtTest import QTest

import studio as studio_mod
from folder_ops import canonical_path_str, normalized_relpath
from studio import DEFAULTS, Session
from test_studio import QuietStudio


class FolderSidebarCleanupTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if QGuiApplication.instance() is None:
            QQuickStyle.setStyle("Material")
        cls.app = QGuiApplication.instance() or QGuiApplication(["FolderSidebarCleanupTest"])

    def setUp(self):
        self.temp_dir = Path(canonical_path_str(tempfile.mkdtemp(prefix="supermd-sidebar-cleanup-")))
        self.root = self.temp_dir
        self.data_dir = self.root / "app-data"
        self.workspace = self.root / "Workspace"
        self.workspace.mkdir(parents=True)
        self.session = Session(True, data=self.data_dir)
        self.studio = QuietStudio(True, self.session)

    def tearDown(self):
        self.studio.stop()
        self.studio.pool.shutdown(wait=True, cancel_futures=True)
        self.studio._search_pool.shutdown(wait=True, cancel_futures=True)
        self.studio.deleteLater()
        self.session.writes.shutdown(wait=True)
        self.app.sendPostedEvents(None, QEvent.Type.DeferredDelete)
        self.app.processEvents()
        shutil.rmtree(self.temp_dir, ignore_errors=True)

    def _wait_for(self, predicate, timeout: float = 4.0):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            self.app.processEvents()
            if predicate():
                return
            QTest.qWait(15)
        self.app.processEvents()
        self.assertTrue(predicate(), "Timed out waiting for condition")

    def _rels(self, win=None) -> list[str]:
        target = win or self.studio
        return [normalized_relpath(entry["path"], self.workspace) for entry in target.files]

    def test_default_hides_non_note_subfolders_while_preserving_nested_note_ancestors(self):
        self.assertIs(DEFAULTS["hideNonNoteFolders"], True)
        self.assertIs(self.studio.settings["hideNonNoteFolders"], True)

        # Subfolders with no .md, .smd, or .txt notes (empty or other file types)
        (self.workspace / "EmptyDrafts").mkdir()
        images_dir = self.workspace / "Assets" / "Diagrams"
        images_dir.mkdir(parents=True)
        (images_dir / "diagram.png").write_bytes(b"\x89PNG\r\n")
        (images_dir / "slides.pdf").write_bytes(b"%PDF-1.4\n")
        code_dir = self.workspace / "Scripts"
        code_dir.mkdir()
        (code_dir / "build.py").write_text("print('hi')\n", encoding="utf-8")
        (code_dir / "config.json").write_text("{}\n", encoding="utf-8")
        other_ext_dir = self.workspace / "OtherMarkdownExt"
        other_ext_dir.mkdir()
        (other_ext_dir / "legacy.markdown").write_text("# Legacy\n", encoding="utf-8")

        # Deeply nested .md, .smd, and .txt notes under ancestor folders with no direct notes
        nested_md = self.workspace / "Courses" / "Semester 1" / "Linear Algebra"
        nested_md.mkdir(parents=True)
        (nested_md / "1.1 Vectors.md").write_text("# Vectors\n", encoding="utf-8")
        # Sibling asset-only folder inside Semester 1 must stay hidden
        nested_slides = self.workspace / "Courses" / "Semester 1" / "SlidesOnly"
        nested_slides.mkdir(parents=True)
        (nested_slides / "week1.pdf").write_bytes(b"%PDF-1.4\n")

        portable_dir = self.workspace / "PortableVault"
        portable_dir.mkdir()
        (portable_dir / "StudyPack.smd").write_bytes(b"{}")

        plain_txt_dir = self.workspace / "Scratch"
        plain_txt_dir.mkdir()
        (plain_txt_dir / "todo.txt").write_text("Buy chalk\n", encoding="utf-8")

        (self.workspace / "README.md").write_text("# Root\n", encoding="utf-8")

        self.studio.openFolder(str(self.workspace))
        self._wait_for(lambda: len(self.studio.files) == 4)
        self.assertEqual(
            self._rels(),
            ["Courses", "PortableVault", "Scratch", "README.md"],
        )

        # Expanding Courses -> Semester 1 preserves ancestor chain and hides SlidesOnly
        self.studio.toggleDirectory(str(self.workspace / "Courses"))
        self._wait_for(lambda: "Courses/Semester 1" in self._rels())
        self.studio.toggleDirectory(str(self.workspace / "Courses" / "Semester 1"))
        self._wait_for(lambda: "Courses/Semester 1/Linear Algebra" in self._rels())
        self.assertNotIn("Courses/Semester 1/SlidesOnly", self._rels())

    def test_settings_toggle_reveals_and_rehides_subfolders_and_persists(self):
        (self.workspace / "EmptyFolder").mkdir()
        media_dir = self.workspace / "MediaOnly"
        media_dir.mkdir()
        (media_dir / "photo.png").write_bytes(b"\x89PNG\r\n")
        notes_dir = self.workspace / "Notes"
        notes_dir.mkdir()
        (notes_dir / "Lecture.md").write_text("# Lecture\n", encoding="utf-8")

        self.studio.openFolder(str(self.workspace))
        self._wait_for(lambda: self._rels() == ["Notes"])

        qml_dir = (Path(studio_mod.__file__).parent / "qml").resolve()
        engine = QQmlEngine()
        engine.rootContext().setContextProperty("studio", self.studio)
        component = QQmlComponent(engine)
        wrapper_qml = """
import QtQuick
import QtQuick.Controls
import QtQuick.Controls.Material
ApplicationWindow {
    id: window
    width: 920
    height: 700
    visible: true
    property var viewState: JSON.parse(studio.snapshot)
    property int contextMenuCount: 0
    property int modalDialogCount: 0
    Connections {
        target: studio
        function onChanged() { window.viewState = JSON.parse(studio.snapshot) }
    }
    SettingsPage {
        id: settingsPage
        anchors.fill: parent
        viewState: window.viewState
        section: "writing"
    }
}
"""
        component.setData(wrapper_qml.encode("utf-8"), QUrl.fromLocalFile(str(qml_dir / "settings-folder-filter-test.qml")))
        self.assertFalse(component.isError(), str(component.errors()))
        win = component.create()
        self.assertIsNotNone(win, str(component.errors()))
        try:
            QTest.qWait(40)
            toggle = win.findChild(QObject, "writingHideNonNoteFolders")
            self.assertIsNotNone(toggle)
            self.assertTrue(toggle.property("checked"))

            # Toggling off in Settings immediately shows EmptyFolder and MediaOnly
            QMetaObject.invokeMethod(toggle, "click")
            self._wait_for(lambda: self._rels() == ["EmptyFolder", "MediaOnly", "Notes"])
            self.assertFalse(self.studio.settings["hideNonNoteFolders"])

            self.session.writes.flush()
            saved = json.loads((self.data_dir / "settings.json").read_text(encoding="utf-8"))
            self.assertIs(saved["settings"]["hideNonNoteFolders"], False)
            reloaded = Session(True, data=self.data_dir)
            try:
                self.assertIs(reloaded.settings["hideNonNoteFolders"], False)
            finally:
                reloaded.writes.shutdown(wait=True)

            # Toggling back on hides EmptyFolder and MediaOnly again
            QMetaObject.invokeMethod(toggle, "click")
            self._wait_for(lambda: self._rels() == ["Notes"])
            self.assertTrue(self.studio.settings["hideNonNoteFolders"])
        finally:
            win.close()
            win.deleteLater()
            self.app.sendPostedEvents(None, QEvent.Type.DeferredDelete)
            engine.deleteLater()
            self.app.sendPostedEvents(None, QEvent.Type.DeferredDelete)

    def test_hidden_subfolder_becomes_visible_when_note_is_created_saved_or_added_externally(self):
        created_target = self.workspace / "HiddenDrafts"
        created_target.mkdir()
        saved_target = self.workspace / "Research" / "Papers"
        saved_target.mkdir(parents=True)
        (saved_target / "reference.pdf").write_bytes(b"%PDF-1.4\n")
        external_target = self.workspace / "Inbox" / "Clipped"
        external_target.mkdir(parents=True)

        self.studio.openFolder(str(self.workspace))
        QTest.qWait(60)
        self._wait_for(lambda: self.studio.files == [])

        # Collapsed/hidden subdirectories must not hold OS directory watches at rest (prevents Win32 rename locks)
        watched_dirs = {canonical_path_str(d) for d in self.studio.note_watcher.directories()}
        self.assertEqual(watched_dirs, {canonical_path_str(self.workspace)})

        # 1. Creating a note via createFolderNote reveals HiddenDrafts
        self.studio.createFolderNote(str(created_target), "First Idea", "md")
        self._wait_for(lambda: "HiddenDrafts" in self._rels() and "HiddenDrafts/First Idea.md" in self._rels())

        # 2. Saving an untitled note via saveAs (.txt) into Research/Papers reveals ancestor Research
        self.studio.newNote()
        self.studio._current()["content"] = "Plain text summary\n"
        self.studio.saveAs(str(saved_target / "Summary.txt"))
        self._wait_for(lambda: self.studio.busy == 0 and "Research" in self._rels())
        self.studio.toggleDirectory(str(self.workspace / "Research"))
        self._wait_for(lambda: "Research/Papers" in self._rels())

        # 3. External note file added on disk inside Inbox/Clipped reveals Inbox upon workspace change
        ext_file = Path(canonical_path_str(external_target)) / "WebClip.smd"
        ext_file.write_bytes(b"{}")
        self.studio._external_note_changed(str(self.workspace))
        self._wait_for(lambda: "Inbox" in self._rels())
        self.studio.toggleDirectory(str(self.workspace / "Inbox"))
        self._wait_for(lambda: "Inbox/Clipped" in self._rels())

    def test_folder_sidebar_qml_removes_clutter_and_highlights_active_note(self):
        (self.workspace / "Overview.md").write_text("# Overview\n", encoding="utf-8")
        (self.workspace / "Chapter 1.md").write_text("# Chapter 1\n", encoding="utf-8")

        qml_dir = (Path(studio_mod.__file__).parent / "qml").resolve()
        engine = QQmlEngine()
        engine.rootContext().setContextProperty("studio", self.studio)
        component = QQmlComponent(engine)
        wrapper_qml = """
import QtQuick
import QtQuick.Controls
import QtQuick.Controls.Material
ApplicationWindow {
    id: window
    width: 300
    height: 560
    visible: true
    property var viewState: JSON.parse(studio.snapshot)
    property var shortcutLabels: JSON.parse(studio.shortcutLabelsJson || "{}")
    property int contextMenuCount: 0
    property int modalDialogCount: 0
    Connections {
        target: studio
        function onChanged() { window.viewState = JSON.parse(studio.snapshot) }
    }
    FolderSidebar {
        id: sidebar
        anchors.fill: parent
        anchors.margins: 12
        viewState: window.viewState
        shortcutLabels: window.shortcutLabels
    }
}
"""
        component.setData(wrapper_qml.encode("utf-8"), QUrl.fromLocalFile(str(qml_dir / "clean-sidebar-test.qml")))
        self.assertFalse(component.isError(), str(component.errors()))
        win = component.create()
        self.assertIsNotNone(win, str(component.errors()))
        try:
            QTest.qWait(40)
            sidebar = win.findChild(QObject, "folderSidebar")
            open_btn = win.findChild(QObject, "openFolderSidebarButton")
            header_bar = win.findChild(QObject, "folderHeaderBar")
            self.assertIsNone(win.findChild(QObject, "folderFilterField"))
            self.assertIsNone(win.findChild(QObject, "headerNewSubfolderButton"))
            self.assertTrue(open_btn.property("visible"))
            self.assertFalse(header_bar.property("visible"))

            self.studio.openFolder(str(self.workspace))
            self._wait_for(lambda: len(self.studio.files) == 2)
            QTest.qWait(40)
            self.assertFalse(open_btn.property("visible"))
            self.assertTrue(header_bar.property("visible"))

            self.studio.openNote(str(self.workspace / "Overview.md"))
            self._wait_for(lambda: Path(self.studio._current()["path"]).name == "Overview.md")
            QTest.qWait(40)
            self.assertTrue(sidebar.property("activeTabPath").endswith("Overview.md"))
        finally:
            win.close()
            win.deleteLater()
            self.app.sendPostedEvents(None, QEvent.Type.DeferredDelete)
            engine.deleteLater()
            self.app.sendPostedEvents(None, QEvent.Type.DeferredDelete)


if __name__ == "__main__":
    unittest.main()
