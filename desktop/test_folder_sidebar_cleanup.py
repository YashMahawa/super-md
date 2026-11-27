"""Tests for clean FolderSidebar chrome and default-on non-note subfolder filtering."""
import json
import os
import shutil
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest import mock

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
os.environ.setdefault("QT_QUICK_BACKEND", "software")

from PySide6.QtCore import QEvent, QMetaObject, QObject, QUrl
from PySide6.QtGui import QGuiApplication
from PySide6.QtQml import QQmlComponent, QQmlEngine
from PySide6.QtQuickControls2 import QQuickStyle
from PySide6.QtTest import QTest

_DESKTOP_DIR = str(Path(__file__).resolve().parent)
if _DESKTOP_DIR not in sys.path:
    sys.path.insert(0, _DESKTOP_DIR)

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
        # Prime workspace link cache (#64) while workspace has 0 notes so invalidation on create/save/reconcile is exercised
        self.assertEqual(self.session.workspace_links.scan(self.workspace), ())

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

        # Workspace link cache (#64) stays synchronized across folder note creation, Save As, and external reconcile
        resolved_summary = studio_mod.resolve_workspace_link(
            "Summary",
            wikilink=True,
            note_path=self.workspace / "HiddenDrafts" / "First Idea.md",
            workspace_folder=self.workspace,
            cache=self.session.workspace_links,
        )
        self.assertEqual(canonical_path_str(resolved_summary), canonical_path_str(saved_target / "Summary.txt"))
        resolved_clip = studio_mod.resolve_workspace_link(
            "WebClip",
            wikilink=True,
            note_path=self.workspace / "HiddenDrafts" / "First Idea.md",
            workspace_folder=self.workspace,
            cache=self.session.workspace_links,
        )
        self.assertEqual(canonical_path_str(resolved_clip), canonical_path_str(ext_file))

    def test_small_scan_budget_preserves_unresolved_and_later_note_folders(self):
        # Early folders completely scanned before budget exhaustion (no notes -> hidden)
        (self.workspace / "00_EmptyBeforeBudget").mkdir()
        early_asset = self.workspace / "01_AssetBeforeBudget"
        early_asset.mkdir()
        (early_asset / "diagram.png").write_bytes(b"\x89PNG\r\n")

        # Heavy non-note folder that exhausts the small shared scan budget mid-directory
        noisy_assets = self.workspace / "02_NoisyAssets"
        noisy_assets.mkdir()
        for idx in range(10):
            (noisy_assets / f"asset_{idx:02d}.bin").write_bytes(b"\x00")

        # Later folders with valid .md, .txt, and .smd notes that appear after budget exhaustion
        later_md = self.workspace / "03_LaterMarkdown"
        later_md.mkdir()
        (later_md / "Lecture.md").write_text("# Lecture\n", encoding="utf-8")

        later_nested = self.workspace / "04_LaterNested" / "Unit 1"
        later_nested.mkdir(parents=True)
        (later_nested / "Notes.txt").write_text("Chapter 1\n", encoding="utf-8")

        later_portable = self.workspace / "05_LaterPortable"
        later_portable.mkdir()
        (later_portable / "StudyPack.smd").write_bytes(b"{}")

        # Direct helper verification: resolved note-free folders return False & memoize False,
        # while unresolved folders return True without caching False.
        memo: dict[str, bool] = {}
        budget = [3]
        self.assertFalse(studio_mod._directory_has_visible_note(self.workspace / "00_EmptyBeforeBudget", depth=1, budget=budget, memo=memo))
        self.assertFalse(studio_mod._directory_has_visible_note(early_asset, depth=1, budget=budget, memo=memo))
        self.assertEqual(budget, [1])
        self.assertIs(memo[studio_mod.folder_ops.normalize_path_key(early_asset)], False)

        # 02_NoisyAssets has 10 files > remaining budget 1 -> unresolved -> kept visible (True), not memoized False
        self.assertTrue(studio_mod._directory_has_visible_note(noisy_assets, depth=1, budget=budget, memo=memo))
        self.assertEqual(budget, [0])
        self.assertNotIn(studio_mod.folder_ops.normalize_path_key(noisy_assets), memo)

        # Subsequent valid-note folder with exhausted budget [0] stays visible (True)
        self.assertTrue(studio_mod._directory_has_visible_note(later_md, depth=1, budget=budget, memo=memo))
        self.assertNotIn(studio_mod.folder_ops.normalize_path_key(later_md), memo)

        # Boundary case: make sibling traversal order deterministic independently of filesystem
        # os.scandir order and verify both traversal orders while retaining exact exhaustion
        # and unknown-folder visibility checks.
        parent_boundary = self.root / "BoundaryWorkspace" / "CourseRoot"
        exact_slides = parent_boundary / "01_ExactSlides"
        exact_slides.mkdir(parents=True)
        (exact_slides / "a.pdf").write_bytes(b"%PDF\n")
        (exact_slides / "b.pdf").write_bytes(b"%PDF\n")
        sibling_notes = parent_boundary / "02_Homework"
        sibling_notes.mkdir(parents=True)
        (sibling_notes / "hw1.md").write_text("# HW 1\n", encoding="utf-8")

        real_scandir = studio_mod.os.scandir

        class _OrderedScandir:
            def __init__(self, target=None, *, reverse: bool = False):
                self._raw = real_scandir(target)
                self._it = iter(sorted(self._raw, key=lambda entry: entry.name, reverse=reverse))

            def __iter__(self):
                return self

            def __next__(self):
                return next(self._it)

            def close(self):
                self._raw.close()

            def __enter__(self):
                return self

            def __exit__(self, exc_type, exc, tb):
                self.close()
                return False

        # Order 1: 01_ExactSlides visited before 02_Homework.
        # 2 entries in CourseRoot + 2 entries in 01_ExactSlides = 4 exact budget units;
        # 01_ExactSlides resolves False, while 02_Homework sees budget == 0 (unresolved),
        # keeping both CourseRoot and 02_Homework visible without caching False.
        boundary_memo: dict[str, bool] = {}
        boundary_budget = [4]
        with mock.patch.object(
            studio_mod.os, "scandir", side_effect=lambda target=None: _OrderedScandir(target, reverse=False)
        ):
            self.assertTrue(
                studio_mod._directory_has_visible_note(
                    parent_boundary, depth=1, budget=boundary_budget, memo=boundary_memo
                )
            )
            self.assertEqual(boundary_budget, [0])
            self.assertIs(boundary_memo[studio_mod.folder_ops.normalize_path_key(exact_slides)], False)
            self.assertNotIn(studio_mod.folder_ops.normalize_path_key(sibling_notes), boundary_memo)
            self.assertNotIn(studio_mod.folder_ops.normalize_path_key(parent_boundary), boundary_memo)
            self.assertFalse(
                studio_mod._directory_has_visible_note(
                    exact_slides, depth=2, budget=boundary_budget, memo=boundary_memo
                )
            )
            self.assertTrue(
                studio_mod._directory_has_visible_note(
                    sibling_notes, depth=2, budget=boundary_budget, memo=boundary_memo
                )
            )

        # Order 2: 02_Homework visited before 01_ExactSlides.
        # Note-bearing sibling resolves True first, confirming CourseRoot visible before exhausting budget.
        reverse_memo: dict[str, bool] = {}
        reverse_budget = [4]
        with mock.patch.object(
            studio_mod.os, "scandir", side_effect=lambda target=None: _OrderedScandir(target, reverse=True)
        ):
            self.assertTrue(
                studio_mod._directory_has_visible_note(
                    parent_boundary, depth=1, budget=reverse_budget, memo=reverse_memo
                )
            )
            self.assertEqual(reverse_budget, [1])
            self.assertIs(reverse_memo[studio_mod.folder_ops.normalize_path_key(sibling_notes)], True)
            self.assertIs(reverse_memo[studio_mod.folder_ops.normalize_path_key(parent_boundary)], True)
            self.assertNotIn(studio_mod.folder_ops.normalize_path_key(exact_slides), reverse_memo)

        # End-to-end Studio._load_tree() small-budget fixture
        self.studio._folder_tree_scan_budget = 6
        self.studio.openFolder(str(self.workspace))
        self._wait_for(
            lambda: self._rels()
            == [
                "02_NoisyAssets",
                "03_LaterMarkdown",
                "04_LaterNested",
                "05_LaterPortable",
            ]
        )

        # Expanding later folders under the small budget still reveals their nested folders and notes
        self.studio.toggleDirectory(str(later_md))
        self._wait_for(lambda: "03_LaterMarkdown/Lecture.md" in self._rels())
        self.studio.toggleDirectory(str(self.workspace / "04_LaterNested"))
        self._wait_for(lambda: "04_LaterNested/Unit 1" in self._rels())
        self.studio.toggleDirectory(str(later_nested))
        self._wait_for(lambda: "04_LaterNested/Unit 1/Notes.txt" in self._rels())

    def test_folder_sidebar_qml_removes_clutter_and_highlights_active_note(self):
        empty_dir = self.workspace / "EmptySelectionDir"
        empty_dir.mkdir()
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
    property var sidebarState: JSON.parse(studio.sidebarSnapshot)
    property var shortcutLabels: JSON.parse(studio.shortcutLabels || "{}")
    property int contextMenuCount: 0
    property int modalDialogCount: 0
    FolderSidebar {
        id: sidebar
        anchors.fill: parent
        anchors.margins: 12
        viewState: window.viewState
        sidebarState: window.sidebarState
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
            self.assertEqual(
                [item["name"] for item in json.loads(self.studio.sidebarSnapshot)["files"]],
                ["Chapter 1.md", "Overview.md"],
            )

            self.studio.openNote(str(self.workspace / "Overview.md"))
            self._wait_for(lambda: Path(self.studio._current()["path"]).name == "Overview.md")
            QTest.qWait(40)
            self.assertTrue(sidebar.property("activeTabPath").endswith("Overview.md"))

            # Toggling hideNonNoteFolders off exposes EmptySelectionDir in sidebarSnapshot; re-enabling resets stale selection.
            self.studio.setting("hideNonNoteFolders", "false")
            self._wait_for(
                lambda: "EmptySelectionDir" in [item["name"] for item in json.loads(self.studio.sidebarSnapshot)["files"]]
            )
            QTest.qWait(30)
            sidebar.setProperty("selectedPath", canonical_path_str(empty_dir))
            sidebar.setProperty("selectedName", "EmptySelectionDir")
            sidebar.setProperty("selectedDirectory", True)

            self.studio.setting("hideNonNoteFolders", "true")
            self._wait_for(
                lambda: "EmptySelectionDir" not in [item["name"] for item in json.loads(self.studio.sidebarSnapshot)["files"]]
            )
            QTest.qWait(30)
            self.assertEqual(sidebar.property("selectedPath"), "")
            self.assertEqual(sidebar.property("selectedName"), "")
            self.assertFalse(bool(sidebar.property("selectedDirectory")))

            # Selecting a visible note and switching/closing folder also resets FolderSidebar selection.
            sidebar.setProperty("selectedPath", canonical_path_str(self.workspace / "Overview.md"))
            sidebar.setProperty("selectedName", "Overview.md")
            sidebar.setProperty("selectedDirectory", False)
            self.studio.closeFolder()
            QTest.qWait(30)
            self.assertEqual(sidebar.property("selectedPath"), "")
            self.assertEqual(sidebar.property("selectedName"), "")
            self.assertFalse(bool(sidebar.property("selectedDirectory")))
        finally:
            win.close()
            win.deleteLater()
            self.app.sendPostedEvents(None, QEvent.Type.DeferredDelete)
            engine.deleteLater()
            self.app.sendPostedEvents(None, QEvent.Type.DeferredDelete)


if __name__ == "__main__":
    unittest.main()
