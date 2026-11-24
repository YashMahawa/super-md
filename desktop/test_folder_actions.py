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
from PySide6.QtGui import QColor, QGuiApplication, QImage
from PySide6.QtQml import QQmlComponent, QQmlEngine
from PySide6.QtQuickControls2 import QQuickStyle
from PySide6.QtTest import QTest

from documents import open_note
from folder_ops import (
    linked_local_images,
    list_subfolders_lazy,
    resolve_within_open_folder,
    validate_entry_name,
)
from shortcuts import DEFINITIONS
from studio import Session, Studio


class QuietStudio(Studio):
    def _refresh_theme(self):
        self.system_dark = True


class FolderActionsDesktopTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if QGuiApplication.instance() is None:
            QQuickStyle.setStyle("Material")
        cls.app = QGuiApplication.instance() or QGuiApplication(["Super MD folder tests"])

    def setUp(self):
        self.temp_dir = Path(tempfile.mkdtemp(prefix="supermd-folder-test-")).resolve()
        self.xdg_data = self.temp_dir / "xdg-data"
        self.xdg_data.mkdir(parents=True, exist_ok=True)
        self._prev_xdg = os.environ.get("XDG_DATA_HOME")
        os.environ["XDG_DATA_HOME"] = str(self.xdg_data)

        self.open_root = self.temp_dir / "workspace-notes"
        self.open_root.mkdir(parents=True, exist_ok=True)

        self.session = Session(True)
        self.session.settings["autosave"] = False
        self.session.settings["motion"] = False
        self.session.settings["welcomed"] = True
        self.windows: list[QuietStudio] = []
        self.studio = self._new_window()

    def tearDown(self):
        for win in self.windows:
            win.stop()
            win.pool.shutdown(wait=True, cancel_futures=True)
        self.session.writes.shutdown(wait=True)
        self.app.processEvents()
        if self._prev_xdg is None:
            os.environ.pop("XDG_DATA_HOME", None)
        else:
            os.environ["XDG_DATA_HOME"] = self._prev_xdg
        shutil.rmtree(self.temp_dir, ignore_errors=True)
        shutil.rmtree(self.session.data, ignore_errors=True)

    def _new_window(self) -> QuietStudio:
        win = QuietStudio(True, self.session)
        self.windows.append(win)
        return win

    def _wait_for(self, predicate, timeout=5.0):
        deadline = time.monotonic() + timeout
        while not predicate() and time.monotonic() < deadline:
            self.app.processEvents()
            time.sleep(0.005)
        self.app.processEvents()
        self.assertTrue(predicate(), "Timed out waiting for condition")

    def _assert_no_hidden_or_vault_artifacts(self):
        for item in self.open_root.rglob("*"):
            self.assertFalse(
                item.name.startswith("."),
                f"Unexpected hidden file or custom trash created in user folder: {item}",
            )

    def test_open_folder_save_default_and_new_note_location_precedence(self):
        self.studio.newNote()
        self.studio._current()["name"] = "Draft Idea.md"

        # Without open folder or newNoteLocation -> falls back to home/Documents
        initial_default = Path(QUrl(self.studio.defaultSaveLocation("Draft Idea.md")).toLocalFile())
        self.assertEqual(initial_default.name, "Draft Idea.md")

        # With open folder and empty newNoteLocation -> defaults to open_folder
        self.studio.openFolder(str(self.open_root))
        self.assertEqual(self.studio.settings["newNoteLocation"], "")
        folder_default = Path(QUrl(self.studio.defaultSaveLocation("Draft Idea.md")).toLocalFile())
        self.assertEqual(folder_default.parent.resolve(), self.open_root.resolve())
        self.assertEqual(folder_default.name, "Draft Idea.md")

        # With explicit newNoteLocation -> honors newNoteLocation over open_folder
        configured_dir = self.temp_dir / "configured-notes"
        configured_dir.mkdir()
        self.studio.setNoteLocation(str(configured_dir))
        explicit_default = Path(QUrl(self.studio.defaultSaveLocation("Draft Idea.md")).toLocalFile())
        self.assertEqual(explicit_default.parent.resolve(), configured_dir.resolve())
        self.assertEqual(explicit_default.name, "Draft Idea.md")

        # Clearing newNoteLocation returns defaultSaveLocation to open_folder
        self.studio.clearNoteLocation()
        self.assertEqual(self.studio.settings["newNoteLocation"], "")
        restored_default = Path(QUrl(self.studio.defaultSaveLocation("Draft Idea.md")).toLocalFile())
        self.assertEqual(restored_default.parent.resolve(), self.open_root.resolve())

    def test_create_md_smd_and_subfolder_auto_opens_and_expands_parent(self):
        self.studio.openFolder(str(self.open_root))
        self._wait_for(lambda: self.studio.folder == str(self.open_root))

        # Create subfolder at root
        self.studio.createSubfolder(str(self.open_root), "Research")
        research_dir = (self.open_root / "Research").resolve()
        self._wait_for(lambda: research_dir.is_dir())

        # Collapse Research first so we verify note creation expands its parent folder
        self.studio.expanded.discard(str(research_dir))
        self.studio._load_tree()
        self._wait_for(lambda: str(research_dir) not in self.studio.expanded)

        # Create Markdown note inside subfolder -> auto-opens in active tab & expands Research
        self.studio.createFolderNote(str(research_dir), "Quantum Notes", "md")
        md_file = (research_dir / "Quantum Notes.md").resolve()
        self._wait_for(
            lambda: md_file.is_file()
            and self.studio._current()["path"] == str(md_file)
            and any(entry["name"] == "Quantum Notes.md" for entry in self.studio.files)
        )
        self.assertEqual(self.studio._current()["name"], "Quantum Notes.md")
        self.assertFalse(self.studio._current()["portable"])
        self.assertIn(str(research_dir), self.studio.expanded)
        visible_names = [entry["name"] for entry in self.studio.files]
        self.assertIn("Research", visible_names)
        self.assertIn("Quantum Notes.md", visible_names)

        # Create Portable (.smd) note inside nested subfolder
        self.studio.createFolderNote(str(research_dir), "Portable Study", "smd")
        smd_file = (research_dir / "Portable Study.smd").resolve()
        self._wait_for(lambda: smd_file.is_file() and self.studio._current()["path"] == str(smd_file))
        self.assertEqual(self.studio._current()["name"], "Portable Study.smd")
        self.assertTrue(self.studio._current()["portable"])
        markdown, assets, is_portable = open_note(smd_file)
        self.assertTrue(is_portable)
        self.assertEqual(markdown, "")
        self.assertEqual(assets, {})
        self._assert_no_hidden_or_vault_artifacts()

    def test_validation_preserves_extension_and_rejects_invalid_or_duplicate_names(self):
        self.assertEqual(validate_entry_name("Lecture 1", is_directory=False, current_ext=".md"), "Lecture 1.md")
        self.assertEqual(validate_entry_name("Lecture 1.MD", is_directory=False, current_ext=".md"), "Lecture 1.MD")
        self.assertEqual(validate_entry_name("Bundle", is_directory=False, current_ext=".smd"), "Bundle.smd")
        self.assertEqual(validate_entry_name("2026.04 Summary", is_directory=False, current_ext=".md"), "2026.04 Summary.md")

        for bad in ("", "   ", ".", "..", "a/b", "a\\b", "bad\x00name", ".hidden"):
            with self.assertRaises(ValueError):
                validate_entry_name(bad, is_directory=False, current_ext=".md")
            with self.assertRaises(ValueError):
                validate_entry_name(bad, is_directory=True)

        with self.assertRaises(ValueError):
            validate_entry_name("Lecture 1.smd", is_directory=False, current_ext=".md")

        # Duplicate rejection in Studio
        (self.open_root / "First.md").write_text("# First\n", encoding="utf-8")
        (self.open_root / "Second.md").write_text("# Second\n", encoding="utf-8")
        self.studio.openFolder(str(self.open_root))
        self.studio.renameEntry(str(self.open_root / "Second.md"), "First")
        self._wait_for(lambda: "already exists" in self.studio.message.lower())
        self.assertTrue((self.open_root / "Second.md").is_file())

    def test_rename_closed_or_open_items_and_folders_syncs_all_workspace_state(self):
        sub = self.open_root / "Projects"
        sub.mkdir()
        open_note_file = sub / "Roadmap.md"
        closed_note_file = sub / "Backlog.md"
        open_note_file.write_text("# Roadmap\n", encoding="utf-8")
        closed_note_file.write_text("# Backlog\n", encoding="utf-8")

        other_win = self._new_window()
        self.studio.openFolder(str(self.open_root))
        other_win.openFolder(str(self.open_root))

        # Open Roadmap.md in both windows, pin it, and record reading position + startup entry
        self.studio.openNote(str(open_note_file))
        other_win.openNote(str(open_note_file))
        resolved_open = str(open_note_file.resolve())
        self._wait_for(lambda: self.studio._current()["path"] == resolved_open)
        self._wait_for(lambda: other_win._current()["path"] == resolved_open)
        self.studio.pinRecent(resolved_open)
        self.session.locations[resolved_open] = {
            "top": 120.0,
            "offset": 12.0,
            "zoom": 100.0,
            "mode": "live",
        }
        self.session.startup_paths = [resolved_open]
        self.session.startup_active = resolved_open

        # Record closed_note_file in recents & pins too
        resolved_closed = str(closed_note_file.resolve())
        self.studio.recent = [resolved_closed] + self.studio.recent
        self.studio.pinRecent(resolved_closed)

        # 1. Rename closed note without typing extension
        self.studio.renameEntry(str(closed_note_file), "Sprint Backlog")
        renamed_closed = (sub / "Sprint Backlog.md").resolve()
        self._wait_for(lambda: renamed_closed.is_file() and not closed_note_file.exists())
        self.assertIn(str(renamed_closed), self.session.pinned)
        self.assertIn(str(renamed_closed), self.studio.recent)
        self.assertNotIn(resolved_closed, self.studio.recent)

        # 2. Rename parent folder "Projects" -> "Archive" and verify open tabs across windows, recents, pins, reading positions, and workspace entries
        self.studio.renameEntry(str(sub), "Archive")
        new_sub = (self.open_root / "Archive").resolve()
        new_open_path = str((new_sub / "Roadmap.md").resolve())
        new_closed_path = str((new_sub / "Sprint Backlog.md").resolve())
        self._wait_for(lambda: self.studio._current()["path"] == new_open_path)
        self._wait_for(lambda: other_win._current()["path"] == new_open_path)
        self.assertIn(new_open_path, self.session.pinned)
        self.assertIn(new_closed_path, self.session.pinned)
        self.assertIn(new_open_path, self.studio.recent)
        self.assertIn(new_open_path, self.session.locations)
        self.assertNotIn(resolved_open, self.session.locations)
        self.assertEqual(self.session.startup_paths, [new_open_path])
        self.assertEqual(self.session.startup_active, new_open_path)

    def test_move_blocks_self_descendant_and_handles_linked_local_images(self):
        assets_dir = self.open_root / "assets"
        assets_dir.mkdir()
        img = QImage(4, 4, QImage.Format_ARGB32)
        img.fill(QColor("#22aa66"))
        chart_png = assets_dir / "chart.png"
        self.assertTrue(img.save(str(chart_png), "PNG"))

        note_path = self.open_root / "Report.md"
        note_path.write_text("# Report\n\n![Chart](assets/chart.png)\n", encoding="utf-8")

        parent_folder = self.open_root / "2026"
        child_folder = parent_folder / "Q4"
        child_folder.mkdir(parents=True)

        self.studio.openFolder(str(self.open_root))
        self.studio.openNote(str(note_path))
        self._wait_for(lambda: self.studio._current()["path"] == str(note_path.resolve()))

        # Block moving folder into itself or its descendant
        self.studio.requestMoveEntry(str(parent_folder), str(parent_folder))
        self.assertIn("cannot move", self.studio.message.lower())
        self.studio.requestMoveEntry(str(parent_folder), str(child_folder))
        self.assertIn("cannot move", self.studio.message.lower())
        self.assertTrue(parent_folder.is_dir())

        # Lazy subfolder picker only expands requested ancestors and excludes moved folder subtree
        lazy_targets = list_subfolders_lazy(self.open_root, set(), exclude_subtree=parent_folder)
        self.assertEqual([item["name"] for item in lazy_targets], [self.open_root.name, "assets"])
        lazy_unexpanded = list_subfolders_lazy(self.open_root, set())
        self.assertEqual([item["name"] for item in lazy_unexpanded], [self.open_root.name, "2026", "assets"])
        lazy_expanded = list_subfolders_lazy(self.open_root, {str(parent_folder.resolve())})
        self.assertIn("Q4", [item["name"] for item in lazy_expanded])

        # Requesting move of Report.md into 2026/Q4 prompts about linked local image
        linked = linked_local_images(
            note_path,
            note_path.read_text(encoding="utf-8"),
            self.open_root,
            child_folder,
        )
        self.assertEqual(len(linked), 1)
        prompts = []
        self.studio.moveImagesPromptRequested.connect(lambda src, dst, cnt, can_copy: prompts.append((src, dst, cnt, can_copy)))
        self.studio.requestMoveEntry(str(note_path), str(child_folder))
        self._wait_for(lambda: len(prompts) == 1)
        self.assertEqual(prompts[0][2], 1)
        self.assertTrue(prompts[0][3])

        # Confirming move with image_action="copy" copies assets/chart.png to 2026/Q4/assets/chart.png and updates open tab
        self.studio.moveEntry(str(note_path), str(child_folder), "copy")
        moved_note = (child_folder / "Report.md").resolve()
        copied_chart = child_folder / "assets" / "chart.png"
        self._wait_for(lambda: moved_note.is_file() and self.studio._current()["path"] == str(moved_note))
        self.assertTrue(copied_chart.is_file())
        self.assertEqual(copied_chart.read_bytes(), chart_png.read_bytes())

    def test_symlink_outside_open_folder_is_rejected(self):
        outside_dir = self.temp_dir / "outside-secret"
        outside_dir.mkdir()
        outside_file = outside_dir / "secret.md"
        outside_file.write_text("top secret", encoding="utf-8")

        escape_link = self.open_root / "escape"
        escape_link.symlink_to(outside_dir, target_is_directory=True)

        with self.assertRaises(ValueError):
            resolve_within_open_folder(self.open_root, escape_link)
        with self.assertRaises(ValueError):
            resolve_within_open_folder(self.open_root, escape_link / "secret.md")

        self.studio.openFolder(str(self.open_root))
        self.studio.createFolderNote(str(escape_link), "Blocked", "md")
        self._wait_for(lambda: "outside" in self.studio.message.lower() or "symlink" in self.studio.message.lower())
        self.assertFalse((outside_dir / "Blocked.md").exists())

    def test_trash_preserves_dirty_drafts_and_uses_system_trash_without_folder_artifacts(self):
        sub = self.open_root / "Drafts"
        sub.mkdir()
        dirty_note = sub / "Unfinished.md"
        dirty_note.write_text("Saved baseline\n", encoding="utf-8")

        self.studio.openFolder(str(self.open_root))
        self.studio.openNote(str(dirty_note))
        resolved_dirty = str(dirty_note.resolve())
        self._wait_for(lambda: self.studio._current()["path"] == resolved_dirty)
        tab_id = self.studio.active
        self.studio.pinRecent(resolved_dirty)
        self.studio._current()["content"] = "Saved baseline\n\nImportant unsaved paragraph!\n"
        self.studio._emit()

        # Trash the parent folder containing the dirty open note
        self.studio.trashEntry(str(sub))
        self._wait_for(lambda: not sub.exists() and all(t["id"] != tab_id for t in self.studio.tabs))

        # Verify file went to freedesktop system Trash ($XDG_DATA_HOME/Trash), never inside open_root
        trash_files = list((self.xdg_data / "Trash" / "files").glob("*"))
        self.assertTrue(len(trash_files) >= 1)
        self._assert_no_hidden_or_vault_artifacts()
        self.assertNotIn(resolved_dirty, self.studio.recent)
        self.assertNotIn(resolved_dirty, self.session.pinned)

        # Reopen closed tab recovers the full unsaved draft detached from the deleted path
        self.assertTrue(len(self.studio.closed_tabs) >= 1)
        self.studio.reopenTab()
        self._wait_for(lambda: self.studio._current()["id"] == tab_id)
        self.assertIn("Important unsaved paragraph!", self.studio._current()["content"])
        self.assertEqual(self.studio._current()["path"], "")

    def test_customizable_shortcuts_and_folder_sidebar_qml_component_load_cleanly(self):
        shortcut_ids = {item["id"] for item in DEFINITIONS}
        for required_id in ("new_folder_note", "new_subfolder", "rename_entry", "trash_entry"):
            self.assertIn(required_id, shortcut_ids)
            self.assertTrue(len(self.studio.shortcutSequences(required_id)) >= 1)

        self.assertEqual(self.studio.setShortcut("new_folder_note", "Ctrl+Alt+M"), "")
        self.assertEqual(self.studio.shortcutSequences("new_folder_note"), ["Ctrl+Alt+M"])
        self.studio.resetShortcuts()
        self.assertEqual(self.studio.shortcutSequences("new_folder_note"), ["Ctrl+Alt+N"])

        # Verify FolderSidebar.qml compiles and renders cleanly in Qt Quick
        (self.open_root / "Sample.md").write_text("# Sample\n", encoding="utf-8")
        self.studio.openFolder(str(self.open_root))
        self._wait_for(lambda: any(item["name"] == "Sample.md" for item in self.studio.files))

        qml_dir = (Path(__file__).parent / "qml").resolve()
        engine = QQmlEngine()
        engine.rootContext().setContextProperty("studio", self.studio)
        component = QQmlComponent(engine)
        wrapper_qml = """
import QtQuick
import QtQuick.Controls
import QtQuick.Controls.Material
ApplicationWindow {
    id: window
    width: 340
    height: 620
    visible: true
    property var viewState: JSON.parse(studio.snapshot)
    property var shortcutLabels: JSON.parse(studio.shortcutLabelsJson || "{}")
    property int contextMenuCount: 0
    property int modalDialogCount: 0
    Material.theme: viewState.dark ? Material.Dark : Material.Light
    Material.primary: viewState.colors.primary
    Material.accent: viewState.colors.primary
    Material.background: viewState.colors.surface
    Material.foreground: viewState.colors.text
    FolderSidebar {
        id: sidebar
        objectName: "folderSidebar"
        anchors.fill: parent
        anchors.margins: 12
        viewState: window.viewState
        shortcutLabels: window.shortcutLabels
    }
}
"""
        component.setData(wrapper_qml.encode("utf-8"), QUrl.fromLocalFile(str(qml_dir / "folder-sidebar-test.qml")))
        self.assertFalse(component.isError(), str(component.errors()))
        host_win = component.create()
        self.assertIsNotNone(host_win, str(component.errors()))
        QTest.qWait(50)
        sidebar = host_win.findChild(QObject, "folderSidebar")
        self.assertIsNotNone(sidebar)
        self.assertTrue(QMetaObject.invokeMethod(sidebar, "triggerNewFolderNote"))
        QTest.qWait(20)
        grabbed = host_win.grabWindow()
        self.assertFalse(grabbed.isNull())
        host_win.close()
        host_win.deleteLater()
        self.app.sendPostedEvents(None, QEvent.Type.DeferredDelete)
        engine.deleteLater()
        self.app.sendPostedEvents(None, QEvent.Type.DeferredDelete)


if __name__ == "__main__":
    unittest.main()
