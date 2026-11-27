import json
import os
import shutil
import tempfile
import time
import unittest
from pathlib import Path
from typing import Any

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
os.environ.setdefault("QT_QUICK_BACKEND", "software")

from PySide6.QtCore import QEvent, QMetaObject, QObject, QUrl
from PySide6.QtGui import QGuiApplication
from PySide6.QtQml import QQmlComponent, QQmlEngine
from PySide6.QtQuickControls2 import QQuickStyle
from PySide6.QtTest import QTest

from documents import open_note
from folder_ops import (
    canonical_path_str,
    normalize_path_key,
    normalized_relpath,
    note_extension,
    note_stem,
    resolve_within_open_folder,
    same_path,
    validate_entry_name,
)
from shortcuts import DEFINITIONS
from studio import Session, Studio


class QuietStudio(Studio):
    def _refresh_theme(self):
        self.system_dark = True


class FolderActionsDesktopTest(unittest.TestCase):
    app: Any = None

    @classmethod
    def setUpClass(cls):
        if QGuiApplication.instance() is None:
            QQuickStyle.setStyle("Material")
        cls.app = QGuiApplication.instance() or QGuiApplication(["Super MD folder tests"])

    def setUp(self):
        self.temp_dir = Path(canonical_path_str(tempfile.mkdtemp(prefix="supermd-folder-test-")))
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
            win._search_pool.shutdown(wait=True, cancel_futures=True)
        self.session.writes.shutdown(wait=True)
        self.app.processEvents()
        shutil.rmtree(self.temp_dir, ignore_errors=True)

    def _new_window(self) -> QuietStudio:
        win = QuietStudio(True, self.session)
        self.windows.append(win)
        return win

    def _wait_for(self, predicate, timeout: float = 5.0):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            self.app.processEvents()
            if predicate():
                return
            time.sleep(0.01)
        self.app.processEvents()
        self.assertTrue(predicate(), "Timed out waiting for desktop condition")

    def _norm(self, path: str | os.PathLike[str]) -> str:
        return normalize_path_key(path)

    def _norm_list(self, paths) -> list[str]:
        return [normalize_path_key(p) for p in paths]

    def _rel_posix(self, path: str | os.PathLike[str]) -> str:
        return normalized_relpath(path, self.open_root)

    def _assert_no_hidden_or_vault_artifacts(self):
        for item in self.open_root.rglob("*"):
            self.assertFalse(item.name.startswith("."), f"Unexpected hidden artifact in user folder: {item}")

    def test_create_md_smd_and_subfolder_auto_opens_and_expands_parent(self):
        self.studio.openFolder(str(self.open_root))
        self._wait_for(lambda: same_path(self.studio.folder, self.open_root))

        self.studio.createSubfolder(str(self.open_root), "Research")
        research_dir = Path(canonical_path_str(self.open_root / "Research"))
        self._wait_for(
            lambda: research_dir.is_dir()
            and self.studio.busy == 0
            and self._norm(research_dir) in self._norm_list(self.studio.expanded)
        )

        self.studio.toggleDirectory(str(research_dir))
        self._wait_for(lambda: self._norm(research_dir) not in self._norm_list(self.studio.expanded))

        self.studio.createFolderNote(str(research_dir), "Quantum Notes", "md")
        md_file = Path(canonical_path_str(research_dir / "Quantum Notes.md"))
        self._wait_for(
            lambda: md_file.is_file()
            and self.studio.busy == 0
            and same_path(self.studio._current()["path"], md_file)
            and any(entry["name"] == "Quantum Notes.md" for entry in self.studio.files)
        )
        self.assertEqual(self.studio._current()["name"], "Quantum Notes.md")
        self.assertFalse(self.studio._current()["portable"])
        self.assertIn(self._norm(research_dir), self._norm_list(self.studio.expanded))
        visible_rels = [self._rel_posix(entry["path"]) for entry in self.studio.files]
        self.assertIn("Research", visible_rels)
        self.assertIn("Research/Quantum Notes.md", visible_rels)

        self.studio.createFolderNote(str(research_dir), "Portable Study", "smd")
        smd_file = Path(canonical_path_str(research_dir / "Portable Study.smd"))
        self._wait_for(lambda: smd_file.is_file() and self.studio.busy == 0 and same_path(self.studio._current()["path"], smd_file))
        self.assertEqual(self.studio._current()["name"], "Portable Study.smd")
        self.assertTrue(self.studio._current()["portable"])
        markdown, assets, is_portable = open_note(smd_file)
        self.assertTrue(is_portable)
        self.assertEqual(markdown, "")
        self.assertEqual(assets, {})
        self._assert_no_hidden_or_vault_artifacts()

    def test_validation_preserves_extension_dotted_stems_and_rejects_invalid_or_duplicate_names(self):
        self.assertEqual(note_stem("1.2 Linear Algebra.md"), "1.2 Linear Algebra")
        self.studio._current()["name"] = "1.2 Linear Algebra.md"
        pdf_default = Path(QUrl(self.studio.defaultExportLocation("pdf")).toLocalFile())
        self.assertEqual(pdf_default.name, "1.2 Linear Algebra.pdf")

        self.assertEqual(validate_entry_name("Lecture 1", is_directory=False, current_ext=".md"), "Lecture 1.md")
        self.assertEqual(validate_entry_name("Lecture 1.MD", is_directory=False, current_ext=".md"), "Lecture 1.MD")
        self.assertEqual(validate_entry_name("Bundle", is_directory=False, current_ext=".smd"), "Bundle.smd")
        self.assertEqual(validate_entry_name("2026.04 Summary", is_directory=False, current_ext=".md"), "2026.04 Summary.md")
        self.assertEqual(validate_entry_name("README", is_directory=False, current_ext="", has_saved_target=True), "README")

        for bad in ("", "   ", ".", "..", "a/b", "a\\b", "bad\x00name", ".hidden", "bad:name", "trailing."):
            with self.assertRaises(ValueError):
                validate_entry_name(bad, is_directory=False, current_ext=".md")
            with self.assertRaises(ValueError):
                validate_entry_name(bad, is_directory=True)

        with self.assertRaises(ValueError):
            validate_entry_name("Lecture 1.smd", is_directory=False, current_ext=".md")

        (self.open_root / "First.md").write_text("# First\n", encoding="utf-8")
        (self.open_root / "Second.md").write_text("# Second\n", encoding="utf-8")
        self.studio.openFolder(str(self.open_root))
        self.studio.renameEntry(str(self.open_root / "Second.md"), "First")
        self._wait_for(lambda: self.studio.busy == 0 and "already exists" in self.studio.message.lower())
        self.assertTrue((self.open_root / "Second.md").is_file())

    def test_rename_syncs_tabs_recents_pins_positions_and_folder_search_and_seeded_find(self):
        sub = self.open_root / "Projects"
        sub.mkdir()
        open_note_file = sub / "Roadmap.md"
        closed_note_file = sub / "Backlog.md"
        open_note_file.write_text("# Roadmap\n\nMilestoneBeacon in project roadmap.\n", encoding="utf-8")
        closed_note_file.write_text("# Backlog\n\nMilestoneBeacon in sprint backlog.\n", encoding="utf-8")

        other_win = self._new_window()
        self.studio.openFolder(str(self.open_root))
        other_win.openFolder(str(self.open_root))
        self.studio.toggleDirectory(str(sub))
        self._wait_for(lambda: "Projects/Backlog.md" in [self._rel_posix(f["path"]) for f in self.studio.files])

        self.studio.openNote(str(open_note_file))
        other_win.openNote(str(open_note_file))
        resolved_open = canonical_path_str(open_note_file)
        self._wait_for(lambda: same_path(self.studio._current()["path"], resolved_open))
        self._wait_for(lambda: same_path(other_win._current()["path"], resolved_open))
        self.studio.pinRecent(resolved_open)
        self.session.locations[resolved_open] = {"top": 120.0, "offset": 12.0, "zoom": 100.0, "mode": "live"}
        self.session.startup_paths = [resolved_open]
        self.session.startup_active = resolved_open

        resolved_closed = canonical_path_str(closed_note_file)
        self.studio.recent = [resolved_closed] + self.studio.recent
        self.studio.pinRecent(resolved_closed)

        # Open streaming search and arm a pending seeded reader find before renaming
        self.studio.openFolderSearch()
        self.studio.updateFolderSearch("MilestoneBeacon", False, False)
        self._wait_for(
            lambda: not self.studio.folderSearchState["scanning"]
            and len(self.studio.folderSearchState["matches"]) == 2
        )
        other_win._pending_seeded_find = {
            "tabId": other_win.active,
            "path": resolved_open,
            "query": "MilestoneBeacon",
            "caseSensitive": False,
        }

        # 1. Rename closed note without typing extension
        self.studio.renameEntry(str(closed_note_file), "Sprint Backlog")
        renamed_closed = Path(canonical_path_str(sub / "Sprint Backlog.md"))
        self._wait_for(
            lambda: renamed_closed.is_file()
            and not closed_note_file.exists()
            and self.studio.busy == 0
            and not self.studio.folderSearchState["scanning"]
            and "Sprint Backlog.md" in {m["name"] for m in self.studio.folderSearchState["matches"]}
        )
        self.assertIn(self._norm(renamed_closed), self._norm_list(self.session.pinned))
        self.assertIn(self._norm(renamed_closed), self._norm_list(self.studio.recent))
        self.assertIn("Projects/Sprint Backlog.md", [self._rel_posix(f["path"]) for f in self.studio.files])

        # 2. Rename parent folder "Projects" -> "Archive" and verify tabs, metadata, search matches, and seeded find path
        self.studio.renameEntry(str(sub), "Archive")
        new_sub = Path(canonical_path_str(self.open_root / "Archive"))
        new_open_path = canonical_path_str(new_sub / "Roadmap.md")
        new_closed_path = canonical_path_str(new_sub / "Sprint Backlog.md")
        self._wait_for(
            lambda: self.studio.busy == 0
            and same_path(self.studio._current()["path"], new_open_path)
            and same_path(other_win._current()["path"], new_open_path)
            and not self.studio.folderSearchState["scanning"]
            and {m["relative"] for m in self.studio.folderSearchState["matches"]}
            == {"Archive/Roadmap.md", "Archive/Sprint Backlog.md"}
        )
        self.assertIn(self._norm(new_open_path), self._norm_list(self.session.pinned))
        self.assertIn(self._norm(new_closed_path), self._norm_list(self.session.pinned))
        self.assertIn(self._norm(new_open_path), self._norm_list(self.session.locations.keys()))
        self.assertNotIn(self._norm(resolved_open), self._norm_list(self.session.locations.keys()))
        self.assertEqual(self._norm_list(self.session.startup_paths), [self._norm(new_open_path)])
        self.assertEqual(self._norm(other_win._pending_seeded_find["path"]), self._norm(new_open_path))
        self.studio.closeFolderSearch()

    def test_symlink_outside_open_folder_is_rejected(self):
        outside_dir = self.temp_dir / "outside-secret"
        outside_dir.mkdir()
        (outside_dir / "secret.md").write_text("top secret", encoding="utf-8")

        escape_link = self.open_root / "escape"
        try:
            escape_link.symlink_to(outside_dir, target_is_directory=True)
        except OSError as exc:
            if os.name == "nt" and getattr(exc, "winerror", None) == 1314:
                import subprocess

                subprocess.run(["cmd", "/c", "mklink", "/J", str(escape_link), str(outside_dir)], check=True)
            else:
                raise

        with self.assertRaises(ValueError):
            resolve_within_open_folder(self.open_root, escape_link)
        with self.assertRaises(ValueError):
            resolve_within_open_folder(self.open_root, escape_link / "secret.md")

        self.studio.openFolder(str(self.open_root))
        self.studio.createFolderNote(str(escape_link), "Blocked", "md")
        self._wait_for(lambda: "outside" in self.studio.message.lower() or "symlink" in self.studio.message.lower())
        self.assertFalse((outside_dir / "Blocked.md").exists())

    def test_customizable_shortcuts_and_folder_sidebar_qml_preserve_search(self):
        shortcut_ids = {item["id"] for item in DEFINITIONS}
        for required_id in (
            "new_folder_note",
            "new_subfolder",
            "rename_entry",
            "search_folder",
            "mode_live",
            "mode_editor",
            "mode_reader",
            "mode_split",
        ):
            self.assertIn(required_id, shortcut_ids)
            self.assertTrue(len(self.studio.shortcutSequences(required_id)) >= 1)
        self.assertNotIn("trash_entry", shortcut_ids)

        self.assertEqual(self.studio.setShortcut("new_folder_note", "Ctrl+Alt+M"), "")
        self.assertEqual(self.studio.shortcutSequences("new_folder_note"), ["Ctrl+Alt+M"])
        self.studio.resetShortcuts()
        self.assertEqual(self.studio.shortcutSequences("new_folder_note"), ["Ctrl+Alt+N"])

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
    property var shortcutLabels: JSON.parse(studio.shortcutLabels || "{}")
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
        QTest.qWait(40)
        sidebar = host_win.findChild(QObject, "folderSidebar")
        self.assertIsNotNone(sidebar)
        sidebar_search_btn = host_win.findChild(QObject, "sidebarFolderSearchButton")
        self.assertIsNotNone(sidebar_search_btn)
        self.assertTrue(QMetaObject.invokeMethod(sidebar_search_btn, "click"))
        self.assertTrue(self.studio.folderSearchState["open"])
        self.studio.closeFolderSearch()
        self.assertFalse(self.studio.folderSearchState["open"])

        # Customized and Disabled shortcut labels update FolderSidebar tooltips and menu items cleanly.
        host_win.setProperty(
            "shortcutLabels",
            {
                "search_folder": "Disabled",
                "new_folder_note": "Ctrl+Alt+M",
                "new_subfolder": "Disabled",
                "rename_entry": "F2",
            },
        )
        QTest.qWait(20)
        new_item_btn = host_win.findChild(QObject, "headerNewItemButton")
        new_subfolder_btn = host_win.findChild(QObject, "headerNewSubfolderButton")
        open_folder_btn = host_win.findChild(QObject, "openFolderSidebarButton")
        new_md_item = host_win.findChild(QObject, "headerNewMarkdownItem")
        new_sub_item = host_win.findChild(QObject, "headerNewSubfolderItem")
        switch_folder_item = host_win.findChild(QObject, "headerSwitchFolderItem")
        menu_new_md = host_win.findChild(QObject, "menuNewMarkdown")
        menu_new_sub = host_win.findChild(QObject, "menuNewSubfolder")
        rename_item = host_win.findChild(QObject, "menuRenameEntry")
        self.assertIsNone(new_subfolder_btn, "Duplicate subfolder button next to + should be removed")
        self.assertIsNotNone(switch_folder_item)
        self.assertFalse(open_folder_btn.property("visible"), "Open folder button should hide once a folder is open")
        self.assertEqual(sidebar_search_btn.findChild(QObject, "actionHint").property("text"), "Search across notes")
        self.assertEqual(new_item_btn.findChild(QObject, "actionHint").property("text"), "New note in folder (Ctrl+Alt+M)")
        self.assertTrue(new_md_item.property("hasShortcutHint"))
        self.assertEqual(new_md_item.findChild(QObject, "menuShortcutHint").property("text"), "Ctrl+Alt+M")
        self.assertFalse(new_sub_item.property("hasShortcutHint"))
        self.assertTrue(menu_new_md.property("hasShortcutHint"))
        self.assertEqual(menu_new_md.findChild(QObject, "menuShortcutHint").property("text"), "Ctrl+Alt+M")
        self.assertFalse(menu_new_sub.property("hasShortcutHint"))
        self.assertTrue(rename_item.property("hasShortcutHint"))
        self.assertEqual(rename_item.findChild(QObject, "menuShortcutHint").property("text"), "F2")

        self.assertTrue(QMetaObject.invokeMethod(sidebar, "triggerNewFolderNote"))
        QTest.qWait(20)
        grabbed = host_win.grabWindow()
        self.assertFalse(grabbed.isNull())
        host_win.close()
        host_win.deleteLater()
        self.app.sendPostedEvents(None, QEvent.Type.DeferredDelete)
        engine.deleteLater()
        self.app.sendPostedEvents(None, QEvent.Type.DeferredDelete)

    def test_windows_path_normalization_handles_extended_prefixes_and_separators(self):
        import ntpath
        from unittest.mock import patch
        import folder_ops

        with (
            patch.object(folder_ops.os, "name", "nt"),
            patch.object(folder_ops.os.path, "realpath", ntpath.normpath),
            patch.object(folder_ops.os.path, "normpath", ntpath.normpath),
            patch.object(folder_ops.os.path, "normcase", ntpath.normcase),
            patch.object(folder_ops.os, "sep", "\\"),
        ):
            self.assertEqual(
                folder_ops.strip_extended_length_prefix(r"\\?\C:\Users\Runner\Notes\Projects\Sprint Backlog.md"),
                r"C:\Users\Runner\Notes\Projects\Sprint Backlog.md",
            )
            self.assertEqual(
                folder_ops.strip_extended_length_prefix(r"\\?\UNC\server\share\Notes\Sprint Backlog.md"),
                r"\\server\share\Notes\Sprint Backlog.md",
            )
            self.assertTrue(
                folder_ops.matches_path_prefix(
                    r"\\?\c:\Users\Runner\Notes\Projects\Sprint Backlog.md",
                    r"C:/Users/Runner/Notes/Projects",
                    is_directory=True,
                )
            )
            self.assertEqual(
                folder_ops.normalized_relpath(
                    r"\\?\c:\Users\Runner\Notes\Projects\Sprint Backlog.md",
                    r"C:\Users\Runner\Notes",
                ),
                "Projects/Sprint Backlog.md",
            )
            remapped = folder_ops.remap_path_prefix(
                r"\\?\c:\Users\Runner\Notes\Projects\Sprint Backlog.md",
                r"C:\Users\Runner\Notes\Projects",
                r"C:\Users\Runner\Notes\Archive",
                is_directory=True,
            )
            self.assertEqual(
                folder_ops.normalize_path_key(remapped),
                "c:/users/runner/notes/archive/sprint backlog.md",
            )

    def test_existing_extensions_and_dotted_note_titles_across_rename_and_export(self):
        cases = [
            ("1.2 Linear Algebra.md", ".md", "1.2 Linear Algebra"),
            ("2.4 Eigenvalues.markdown", ".markdown", "2.4 Eigenvalues"),
            ("3.1 Bundle.smd", ".smd", "3.1 Bundle"),
            ("3.2 Legacy.fmd", ".fmd", "3.2 Legacy"),
            ("4.1 Plain Notes.txt", ".txt", "4.1 Plain Notes"),
            ("4.2 UPPER.TXT", ".TXT", "4.2 UPPER"),
            ("5.1 Outline.org", ".org", "5.1 Outline"),
            ("README", "", "README"),
            ("Section 1.2", "", "Section 1.2"),
            ("1.2 Linear Algebra", "", "1.2 Linear Algebra"),
        ]
        for filename, expected_ext, expected_stem in cases:
            self.assertEqual(note_extension(filename), expected_ext, filename)
            self.assertEqual(note_stem(filename), expected_stem, filename)

        txt_file = self.open_root / "1.2 Linear Algebra.txt"
        markdown_file = self.open_root / "2.4 Eigenvalues.markdown"
        fmd_file = self.open_root / "3.1 Legacy.fmd"
        upper_txt_file = self.open_root / "4.0 Notes.TXT"
        extensionless_dotted = self.open_root / "Section 1.2"
        txt_file.write_text("Linear algebra text\n", encoding="utf-8")
        markdown_file.write_text("# Eigenvalues\n", encoding="utf-8")
        fmd_file.write_text("# Legacy\n", encoding="utf-8")
        upper_txt_file.write_text("Uppercase extension\n", encoding="utf-8")
        extensionless_dotted.write_text("Extensionless dotted note\n", encoding="utf-8")

        self.studio.openFolder(str(self.open_root))
        self._wait_for(lambda: any(f["name"] == "1.2 Linear Algebra.txt" for f in self.studio.files))

        self.studio.openNote(str(txt_file))
        self._wait_for(lambda: same_path(self.studio._current()["path"], txt_file))
        pdf_default = Path(QUrl(self.studio.defaultExportLocation("pdf")).toLocalFile())
        self.assertEqual(pdf_default.name, "1.2 Linear Algebra.pdf")

        # Rename open .txt note via renameNote to another dotted stem without typing .txt
        self.studio.renameNote(self.studio.active, "1.3 Vector Spaces")
        renamed_txt = self.open_root / "1.3 Vector Spaces.txt"
        self._wait_for(lambda: self.studio.busy == 0 and renamed_txt.is_file() and self.studio._current()["name"] == "1.3 Vector Spaces.txt")

        # Rename .markdown, .fmd, and .TXT entries via renameEntry to dotted stems
        self.studio.renameEntry(str(markdown_file), "2.5 Eigenvectors")
        self._wait_for(lambda: self.studio.busy == 0 and (self.open_root / "2.5 Eigenvectors.markdown").is_file())
        self.studio.renameEntry(str(fmd_file), "3.2 Archive")
        self._wait_for(lambda: self.studio.busy == 0 and (self.open_root / "3.2 Archive.fmd").is_file())
        self.studio.renameEntry(str(upper_txt_file), "4.1 Summary")
        self._wait_for(lambda: self.studio.busy == 0 and (self.open_root / "4.1 Summary.TXT").is_file())

        # Rename saved extensionless dotted title without appending a bogus '.2' suffix
        self.studio.openNote(str(extensionless_dotted))
        self._wait_for(lambda: same_path(self.studio._current()["path"], extensionless_dotted))
        self.studio.renameNote(self.studio.active, "Section 1.3")
        renamed_extensionless = self.open_root / "Section 1.3"
        self._wait_for(
            lambda: self.studio.busy == 0
            and renamed_extensionless.is_file()
            and self.studio._current()["name"] == "Section 1.3"
        )

    def test_restored_workspace_folder_and_recursive_filtering_work_with_create_and_rename(self):
        algebra_dir = self.open_root / "Courses" / "Algebra"
        calculus_dir = self.open_root / "Courses" / "Calculus"
        algebra_dir.mkdir(parents=True)
        calculus_dir.mkdir(parents=True)
        (algebra_dir / "1.2 Basis.txt").write_text("Basis vectors\n", encoding="utf-8")
        (calculus_dir / "2.1 Limits.markdown").write_text("# Limits\n", encoding="utf-8")

        self.session.settings["startup"] = "restore"
        self.studio._preferences()
        self.studio.openFolder(str(self.open_root))
        self._wait_for(lambda: any(item["name"] == "Courses" for item in self.studio.files))
        self.studio.toggleDirectory(str(self.open_root / "Courses"))
        self._wait_for(lambda: any(item["name"] == "Algebra" for item in self.studio.files))
        self.studio._recover()
        self.session.writes.flush()

        restored_session = Session(True, data=self.studio.data)
        restored_win = None
        engine = None
        host_win = None
        try:
            restored_win = QuietStudio(True, restored_session)
            self._wait_for(lambda: any(item["name"] == "Algebra" for item in restored_win.files))
            self.assertTrue(same_path(restored_win.folder, self.open_root))
            # Algebra is collapsed initially on restore while Courses is expanded
            self.assertNotIn(self._norm(algebra_dir), self._norm_list(restored_win.expanded))

            qml_dir = (Path(__file__).parent / "qml").resolve()
            engine = QQmlEngine()
            engine.rootContext().setContextProperty("studio", restored_win)
            component = QQmlComponent(engine)
            wrapper_qml = """
import QtQuick
import QtQuick.Controls
import QtQuick.Controls.Material
ApplicationWindow {
    id: window
    width: 360
    height: 640
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
            component.setData(wrapper_qml.encode("utf-8"), QUrl.fromLocalFile(str(qml_dir / "folder-restore-filter-test.qml")))
            self.assertFalse(component.isError(), str(component.errors()))
            host_win = component.create()
            self.assertIsNotNone(host_win, str(component.errors()))
            QTest.qWait(40)

            filter_field = host_win.findChild(QObject, "folderFilterField")
            empty_state = host_win.findChild(QObject, "folderEmptyState")
            empty_label = host_win.findChild(QObject, "folderEmptyLabel")
            self.assertIsNone(filter_field, "FolderSidebar must not render redundant in-folder file search")
            self.assertIsNotNone(empty_state)
            self.assertFalse(empty_state.property("visible"))
            self.assertEqual(empty_label.property("text"), "No notes in this folder")

            # Backend subfolder filter still works cleanly without mutating expanded state
            expanded_before = set(self._norm_list(restored_win.expanded))
            restored_win.setFolderFilter("1.2")
            self._wait_for(
                lambda: not restored_win._folder_searching
                and not restored_win.filter_timer.isActive()
                and [item["name"] for item in restored_win.files] == ["Courses", "Algebra", "1.2 Basis.txt"]
            )
            self.assertEqual(set(self._norm_list(restored_win.expanded)), expanded_before)

            # Renaming the matched file while filtered refreshes recursive filter results and preserves .txt
            restored_win.renameEntry(str(algebra_dir / "1.2 Basis.txt"), "1.2 Orthonormal Basis")
            self._wait_for(
                lambda: restored_win.busy == 0
                and not restored_win._folder_searching
                and not restored_win.filter_timer.isActive()
                and [item["name"] for item in restored_win.files] == ["Courses", "Algebra", "1.2 Orthonormal Basis.txt"]
            )

            # Clearing filter restores normal tree; renaming restored Courses -> Semesters updates startup.json
            restored_win.setFolderFilter("")
            self._wait_for(lambda: any(item["name"] == "Courses" for item in restored_win.files))
            restored_win.renameEntry(str(self.open_root / "Courses"), "Semesters")
            semesters_dir = self.open_root / "Semesters"
            self._wait_for(lambda: restored_win.busy == 0 and semesters_dir.is_dir())
            restored_session.writes.flush()
            persisted = json.loads((self.studio.data / "startup.json").read_text(encoding="utf-8"))
            self.assertIn(self._norm(semesters_dir), self._norm_list(persisted["expanded"]))
        finally:
            if host_win is not None:
                host_win.close()
                host_win.deleteLater()
                self.app.sendPostedEvents(None, QEvent.Type.DeferredDelete)
            if engine is not None:
                engine.deleteLater()
                self.app.sendPostedEvents(None, QEvent.Type.DeferredDelete)
            if restored_win is not None:
                restored_win.stop()
                restored_win.pool.shutdown(wait=True, cancel_futures=True)
                restored_win._search_pool.shutdown(wait=True, cancel_futures=True)
            restored_session.writes.shutdown(wait=True)


if __name__ == "__main__":
    unittest.main()
