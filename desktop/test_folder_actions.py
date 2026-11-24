import json
import os
import shutil
import sys
import tempfile
import time
import unittest
from pathlib import Path
from typing import Any

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
os.environ.setdefault("QT_QUICK_BACKEND", "software")

from PySide6.QtCore import QEvent, QMetaObject, QObject, QUrl
from PySide6.QtGui import QColor, QGuiApplication, QImage
from PySide6.QtQml import QQmlComponent, QQmlEngine
from PySide6.QtQuickControls2 import QQuickStyle
from PySide6.QtTest import QTest

from documents import open_note
from folder_ops import (
    canonical_path_str,
    is_system_trash_destination,
    linked_local_images,
    list_subfolders_lazy,
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
        trashed_paths = [
            getattr(win, "_last_trashed_path", "")
            for win in self.windows
            if getattr(win, "_last_trashed_path", "")
        ]
        for win in self.windows:
            win.stop()
            win.pool.shutdown(wait=True, cancel_futures=True)
        self.session.writes.shutdown(wait=True)
        self.app.processEvents()
        if self._prev_xdg is None:
            os.environ.pop("XDG_DATA_HOME", None)
        else:
            os.environ["XDG_DATA_HOME"] = self._prev_xdg
        if sys.platform in ("darwin", "win32"):
            for trashed in trashed_paths:
                try:
                    trashed_p = Path(trashed)
                    if trashed_p.exists() and not same_path(trashed_p, Path.home()):
                        if trashed_p.is_dir():
                            shutil.rmtree(trashed_p, ignore_errors=True)
                        else:
                            trashed_p.unlink(missing_ok=True)
                except OSError:
                    pass
        shutil.rmtree(self.temp_dir, ignore_errors=True)
        shutil.rmtree(self.session.data, ignore_errors=True)

    def _new_window(self) -> QuietStudio:
        win = QuietStudio(True, self.session)
        self.windows.append(win)
        return win

    def _norm(self, path: str | os.PathLike[str]) -> str:
        return normalize_path_key(path)

    def _norm_list(self, paths) -> list[str]:
        return [normalize_path_key(p) for p in paths]

    def _rel_posix(self, path: str | os.PathLike[str]) -> str:
        return normalized_relpath(path, self.open_root)

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
        self.assertEqual(self._norm(folder_default.parent), self._norm(self.open_root))
        self.assertEqual(folder_default.name, "Draft Idea.md")

        # With explicit newNoteLocation -> honors newNoteLocation over open_folder
        configured_dir = self.temp_dir / "configured-notes"
        configured_dir.mkdir()
        self.studio.setNoteLocation(str(configured_dir))
        explicit_default = Path(QUrl(self.studio.defaultSaveLocation("Draft Idea.md")).toLocalFile())
        self.assertEqual(self._norm(explicit_default.parent), self._norm(configured_dir))
        self.assertEqual(explicit_default.name, "Draft Idea.md")

        # Clearing newNoteLocation returns defaultSaveLocation to open_folder
        self.studio.clearNoteLocation()
        self.assertEqual(self.studio.settings["newNoteLocation"], "")
        restored_default = Path(QUrl(self.studio.defaultSaveLocation("Draft Idea.md")).toLocalFile())
        self.assertEqual(self._norm(restored_default.parent), self._norm(self.open_root))

        # Dotted note titles preserve full stem on defaultExportLocation
        self.studio._current()["name"] = "1.2 Linear Algebra.md"
        self.assertEqual(note_stem("1.2 Linear Algebra.md"), "1.2 Linear Algebra")
        pdf_default = Path(QUrl(self.studio.defaultExportLocation("pdf")).toLocalFile())
        self.assertEqual(pdf_default.name, "1.2 Linear Algebra.pdf")

    def test_create_md_smd_and_subfolder_auto_opens_and_expands_parent(self):
        self.studio.openFolder(str(self.open_root))
        self._wait_for(lambda: same_path(self.studio.folder, self.open_root))

        # Create subfolder at root
        self.studio.createSubfolder(str(self.open_root), "Research")
        research_dir = Path(canonical_path_str(self.open_root / "Research"))
        self._wait_for(lambda: research_dir.is_dir() and self.studio.busy == 0 and self._norm(research_dir) in self._norm_list(self.studio.expanded))

        # Collapse Research first so we verify note creation expands its parent folder
        self.studio.toggleDirectory(str(research_dir))
        self._wait_for(lambda: self._norm(research_dir) not in self._norm_list(self.studio.expanded))

        # Create Markdown note inside subfolder -> auto-opens in active tab & expands Research
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

        # Create Portable (.smd) note inside nested subfolder
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

    def test_validation_preserves_extension_and_rejects_invalid_or_duplicate_names(self):
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

        # Duplicate rejection in Studio
        (self.open_root / "First.md").write_text("# First\n", encoding="utf-8")
        (self.open_root / "Second.md").write_text("# Second\n", encoding="utf-8")
        self.studio.openFolder(str(self.open_root))
        self.studio.renameEntry(str(self.open_root / "Second.md"), "First")
        self._wait_for(lambda: self.studio.busy == 0 and "already exists" in self.studio.message.lower())
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
        self.studio.toggleDirectory(str(sub))
        self._wait_for(lambda: "Projects/Backlog.md" in [self._rel_posix(f["path"]) for f in self.studio.files])

        # Open Roadmap.md in both windows, pin it, and record reading position + startup entry
        self.studio.openNote(str(open_note_file))
        other_win.openNote(str(open_note_file))
        resolved_open = canonical_path_str(open_note_file)
        self._wait_for(lambda: same_path(self.studio._current()["path"], resolved_open))
        self._wait_for(lambda: same_path(other_win._current()["path"], resolved_open))
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
        resolved_closed = canonical_path_str(closed_note_file)
        self.studio.recent = [resolved_closed] + self.studio.recent
        self.studio.pinRecent(resolved_closed)

        # 1. Rename closed note without typing extension
        self.studio.renameEntry(str(closed_note_file), "Sprint Backlog")
        renamed_closed = Path(canonical_path_str(sub / "Sprint Backlog.md"))
        self._wait_for(
            lambda: renamed_closed.is_file()
            and not closed_note_file.exists()
            and self.studio.busy == 0
            and self._norm(renamed_closed) in self._norm_list(self.session.pinned)
            and "Projects/Sprint Backlog.md" in [self._rel_posix(f["path"]) for f in self.studio.files]
        )
        self.assertIn(self._norm(renamed_closed), self._norm_list(self.session.pinned))
        self.assertIn(self._norm(renamed_closed), self._norm_list(self.studio.recent))
        self.assertNotIn(self._norm(resolved_closed), self._norm_list(self.studio.recent))
        self.assertIn("Projects/Sprint Backlog.md", [self._rel_posix(f["path"]) for f in self.studio.files])

        # 2. Rename parent folder "Projects" -> "Archive" and verify open tabs across windows, recents, pins, reading positions, and workspace entries
        self.studio.renameEntry(str(sub), "Archive")
        new_sub = Path(canonical_path_str(self.open_root / "Archive"))
        new_open_path = canonical_path_str(new_sub / "Roadmap.md")
        new_closed_path = canonical_path_str(new_sub / "Sprint Backlog.md")
        self._wait_for(
            lambda: self.studio.busy == 0
            and same_path(self.studio._current()["path"], new_open_path)
            and same_path(other_win._current()["path"], new_open_path)
            and "Archive/Sprint Backlog.md" in [self._rel_posix(f["path"]) for f in self.studio.files]
        )
        self.assertIn(self._norm(new_open_path), self._norm_list(self.session.pinned))
        self.assertIn(self._norm(new_closed_path), self._norm_list(self.session.pinned))
        self.assertIn(self._norm(new_open_path), self._norm_list(self.studio.recent))
        self.assertIn(self._norm(new_open_path), self._norm_list(self.session.locations.keys()))
        self.assertNotIn(self._norm(resolved_open), self._norm_list(self.session.locations.keys()))
        self.assertEqual(self._norm_list(self.session.startup_paths), [self._norm(new_open_path)])
        self.assertEqual(self._norm(self.session.startup_active), self._norm(new_open_path))
        workspace_paths = [
            self._norm(entry["path"])
            for entries in self.session.workspace.values()
            for entry in entries
            if entry.get("path")
        ]
        self.assertIn(self._norm(new_open_path), workspace_paths)
        self.assertNotIn(self._norm(resolved_open), workspace_paths)
        self.assertIn("Archive/Roadmap.md", [self._rel_posix(f["path"]) for f in self.studio.files])
        self.assertIn("Archive/Sprint Backlog.md", [self._rel_posix(f["path"]) for f in self.studio.files])

    def test_move_blocks_self_descendant_and_handles_linked_local_images(self):
        assets_dir = self.open_root / "assets"
        assets_dir.mkdir()
        img = QImage(4, 4, QImage.Format.Format_ARGB32)
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
        self._wait_for(lambda: same_path(self.studio._current()["path"], note_path))

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
        lazy_expanded = list_subfolders_lazy(self.open_root, {canonical_path_str(parent_folder)})
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
        moved_note = Path(canonical_path_str(child_folder / "Report.md"))
        copied_chart = child_folder / "assets" / "chart.png"
        self._wait_for(lambda: moved_note.is_file() and self.studio.busy == 0 and same_path(self.studio._current()["path"], moved_note))
        self.assertTrue(copied_chart.is_file())
        self.assertEqual(copied_chart.read_bytes(), chart_png.read_bytes())

    def test_symlink_outside_open_folder_is_rejected(self):
        outside_dir = self.temp_dir / "outside-secret"
        outside_dir.mkdir()
        outside_file = outside_dir / "secret.md"
        outside_file.write_text("top secret", encoding="utf-8")

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

    def test_trash_preserves_dirty_drafts_and_uses_system_trash_without_folder_artifacts(self):
        sub = self.open_root / "Drafts"
        sub.mkdir()
        dirty_note = sub / "Unfinished.md"
        dirty_note.write_text("Saved baseline\n", encoding="utf-8")

        self.studio.openFolder(str(self.open_root))
        self.studio.openNote(str(dirty_note))
        resolved_dirty = canonical_path_str(dirty_note)
        self._wait_for(lambda: same_path(self.studio._current()["path"], resolved_dirty))
        tab_id = self.studio.active
        self.studio.pinRecent(resolved_dirty)
        self.studio._current()["content"] = "Saved baseline\n\nImportant unsaved paragraph!\n"
        self.studio._emit()

        # Trash the parent folder containing the dirty open note
        resolved_sub = canonical_path_str(sub)
        self.studio.trashEntry(str(sub))
        self._wait_for(
            lambda: not sub.exists()
            and self.studio.busy == 0
            and all(t["id"] != tab_id for t in self.studio.tabs)
            and bool(self.studio._last_trashed_source)
        )

        # Verify OS-native Trash handled the item and zero hidden/.trash artifacts exist in open_root
        self.assertEqual(self._norm(self.studio._last_trashed_source), self._norm(resolved_sub))
        self.assertEqual(self.studio.message, "Moved to Trash: Drafts (unsaved edits preserved in closed notes)")
        self.assertFalse(sub.exists())
        self.assertFalse(dirty_note.exists())
        if sys.platform.startswith("linux"):
            trash_files = list((self.xdg_data / "Trash" / "files").glob("*"))
            self.assertTrue(len(trash_files) >= 1)
            self.assertTrue(is_system_trash_destination(self.studio._last_trashed_path, self.open_root))
            self.assertTrue(Path(self.studio._last_trashed_path).exists())
            self.assertFalse(same_path(Path(self.studio._last_trashed_path).parent, self.open_root))
        elif sys.platform == "darwin":
            self.assertTrue(
                is_system_trash_destination(self.studio._last_trashed_path, self.open_root),
                f"Expected macOS Trash destination, got: {self.studio._last_trashed_path}",
            )
            trashed_dest = Path(self.studio._last_trashed_path)
            try:
                trashed_exists = trashed_dest.exists()
            except PermissionError:
                # macOS TCC restricts stat() inside ~/.Trash without Full Disk Access,
                # confirming resultingItemURL points inside the system Trash folder.
                trashed_exists = True
            self.assertTrue(trashed_exists)
        elif os.name == "nt":
            import ctypes
            import ctypes.wintypes

            class _SHQUERYRBINFO(ctypes.Structure):
                if ctypes.sizeof(ctypes.c_void_p) == 4:
                    _pack_ = 1
                _fields_ = [
                    ("cbSize", ctypes.wintypes.DWORD),
                    ("i64Size", ctypes.c_int64),
                    ("i64NumItems", ctypes.c_int64),
                ]

            sh_query_rb = ctypes.windll.shell32.SHQueryRecycleBinW
            sh_query_rb.argtypes = [ctypes.wintypes.LPCWSTR, ctypes.POINTER(_SHQUERYRBINFO)]
            sh_query_rb.restype = ctypes.c_long
            rb_info = _SHQUERYRBINFO(cbSize=ctypes.sizeof(_SHQUERYRBINFO))
            drive_root = self.open_root.anchor or str(self.open_root)
            hr = sh_query_rb(drive_root, ctypes.byref(rb_info))
            self.assertEqual(hr, 0)
            self.assertGreaterEqual(rb_info.i64NumItems, 1)
            if self.studio._last_trashed_path:
                self.assertTrue(is_system_trash_destination(self.studio._last_trashed_path, self.open_root))
                trashed_dest = Path(self.studio._last_trashed_path)
                try:
                    trashed_exists = trashed_dest.exists()
                except PermissionError:
                    trashed_exists = True
                self.assertTrue(trashed_exists)
        else:
            self.assertTrue(is_system_trash_destination(self.studio._last_trashed_path, self.open_root))
            trashed_dest = Path(self.studio._last_trashed_path)
            self.assertTrue(trashed_dest.exists())
        self._assert_no_hidden_or_vault_artifacts()
        self.assertNotIn(self._norm(resolved_dirty), self._norm_list(self.studio.recent))
        self.assertNotIn(self._norm(resolved_dirty), self._norm_list(self.session.pinned))
        self.assertTrue(any("Important unsaved paragraph!" in d["content"] for d in self.session.drafts.get("deleted-notes", [])))

        # Reopen closed tab recovers the full unsaved draft detached from the deleted path
        self.assertTrue(len(self.studio.closed_tabs) >= 1)
        self.studio.reopenTab()
        self._wait_for(lambda: self.studio._current()["id"] == tab_id)
        self.assertIn("Important unsaved paragraph!", self.studio._current()["content"])
        self.assertEqual(self.studio._current()["path"], "")

        # Verify portable Trash path classifier across macOS, Linux, Windows, and in-folder traps
        self.assertTrue(is_system_trash_destination("/Users/runner/.Trash/Drafts", "/Users/runner/work/notes"))
        self.assertTrue(is_system_trash_destination("/Volumes/External/.Trashes/501/Drafts", "/Volumes/External/notes"))
        self.assertTrue(is_system_trash_destination("/home/runner/.local/share/Trash/files/Drafts", "/home/runner/notes"))
        self.assertTrue(is_system_trash_destination("/mnt/data/.Trash-1000/files/Drafts", "/mnt/data/notes"))
        self.assertTrue(is_system_trash_destination(r"C:\$Recycle.Bin\S-1-5-21-1000\Drafts", r"C:\Users\runner\notes"))
        self.assertFalse(is_system_trash_destination("/Users/runner/work/notes/.Trash/Drafts", "/Users/runner/work/notes"))
        self.assertFalse(is_system_trash_destination("/home/runner/notes/.trash/Drafts", "/home/runner/notes"))
        self.assertFalse(is_system_trash_destination("/home/runner/notes/Trash/files/Drafts", "/home/runner/notes"))
        self.assertFalse(is_system_trash_destination("", "/Users/runner/work/notes"))

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
