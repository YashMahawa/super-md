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
        for required_id in ("new_folder_note", "new_subfolder", "rename_entry", "search_folder"):
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
        QTest.qWait(40)
        sidebar = host_win.findChild(QObject, "folderSidebar")
        self.assertIsNotNone(sidebar)
        sidebar_search_btn = host_win.findChild(QObject, "sidebarFolderSearchButton")
        self.assertIsNotNone(sidebar_search_btn)
        self.assertTrue(QMetaObject.invokeMethod(sidebar_search_btn, "click"))
        self.assertTrue(self.studio.folderSearchState["open"])
        self.studio.closeFolderSearch()
        self.assertFalse(self.studio.folderSearchState["open"])
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


if __name__ == "__main__":
    unittest.main()
