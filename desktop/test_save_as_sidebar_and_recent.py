"""Desktop Save As open-folder ancestor expansion, portable/existing note saves, and canonical recent/pinned deduplication."""
from __future__ import annotations

import base64
import hashlib
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
os.environ.setdefault("QT_QUICK_BACKEND", "software")

from PySide6.QtCore import QEvent, QMetaObject, QObject, QStandardPaths, QUrl
from PySide6.QtGui import QGuiApplication
from PySide6.QtQml import QQmlComponent, QQmlEngine
from PySide6.QtQuick import QQuickItem
from PySide6.QtQuickControls2 import QQuickStyle
from PySide6.QtTest import QTest

sys.path.insert(0, str(Path(__file__).resolve().parent))
import documents
import folder_ops
import studio as studio_mod
from studio import Session, Studio

MAIN = Path(__file__).resolve().parent / "qml" / "Main.qml"


class QuietStudio(Studio):
    def _refresh_theme(self):
        self.system_dark = True


def _assert_same_path(
    test_case: unittest.TestCase,
    actual: str | os.PathLike[str],
    expected: str | os.PathLike[str],
) -> None:
    test_case.assertTrue(
        folder_ops.same_path(actual, expected),
        f"Expected canonical path match:\n  actual:   {actual}\n  expected: {expected}",
    )
    test_case.assertEqual(
        folder_ops._pure_path(str(actual)).name,
        folder_ops._pure_path(str(expected)).name,
    )


def _try_make_dir_link(link_path: Path, target_dir: Path) -> bool:
    try:
        link_path.symlink_to(target_dir, target_is_directory=True)
        return True
    except OSError:
        if os.name == "nt":
            proc = subprocess.run(
                ["cmd", "/c", "mklink", "/J", str(link_path), str(target_dir)],
                capture_output=True,
                text=True,
                check=False,
            )
            return proc.returncode == 0
        return False


class SaveAsSidebarAndRecentTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if QGuiApplication.instance() is None:
            QQuickStyle.setStyle("Material")
        cls.app = QGuiApplication.instance() or QGuiApplication(["Save As sidebar and recent tests"])

    def setUp(self):
        self.temp_dir = Path(tempfile.mkdtemp(prefix="supermd-save-as-"))
        self.root = Path(folder_ops.canonical_path_str(self.temp_dir))
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
                win._suspend_watches_for_prefix(str(self.root), is_dir=True)
                win.stop()
            win.pool.shutdown(wait=True, cancel_futures=True)
            win._search_pool.shutdown(wait=True, cancel_futures=True)
            win.deleteLater()
        self.session.writes.shutdown(wait=True)
        self.app.sendPostedEvents(None, QEvent.Type.DeferredDelete)
        self.app.processEvents()
        shutil.rmtree(self.temp_dir, ignore_errors=True)

    def assertSamePath(self, actual: str | os.PathLike[str], expected: str | os.PathLike[str]) -> None:
        _assert_same_path(self, actual, expected)

    def make_window(self) -> QuietStudio:
        win = QuietStudio(True, session=self.session)
        self.windows.append(win)
        return win

    def flush_writes(self) -> None:
        self.session.writes.submit(lambda: None).result(timeout=5)
        self.app.processEvents()

    def wait_until(self, predicate, timeout: float = 4.0) -> None:
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

    @staticmethod
    def _sidebar_files(win: Studio) -> list[dict]:
        return json.loads(win.sidebarSnapshot)["files"]

    @staticmethod
    def _has_file_entry(entries: list[dict], expected_path: Path, *, directory: bool | None = None) -> bool:
        for entry in entries:
            if folder_ops.same_path(entry["path"], expected_path):
                if directory is None or bool(entry["directory"]) is directory:
                    return True
        return False

    @staticmethod
    def _has_watched_dir(win: Studio, expected_dir: Path) -> bool:
        return any(folder_ops.same_path(item, expected_dir) for item in win.note_watcher.directories())

    def test_save_and_save_as_expand_collapsed_ancestors_across_windows_and_persist_startup(self):
        workspace_dir = self.root / "Workspace"
        nested_dir = workspace_dir / "Semester 1" / "Week 2"
        nested_dir.mkdir(parents=True)
        (workspace_dir / "Semester 1" / "Overview.md").write_text("# Semester 1\n", encoding="utf-8")
        archive_dir = workspace_dir / "Archive" / "Spring"
        archive_dir.mkdir(parents=True)
        other_dir = self.root / "Other Project"
        (other_dir / "Hidden").mkdir(parents=True)
        preferred_dir = self.root / "Explicit Inbox"
        preferred_dir.mkdir()

        with self._patch_downloads():
            win1 = self.make_window()
            win2 = self.make_window()
            win3 = self.make_window()

            win1.openFolder(str(workspace_dir))
            win2.openFolder(str(workspace_dir))
            win3.openFolder(str(other_dir))
            self.wait_until(
                lambda: self._has_file_entry(self._sidebar_files(win1), workspace_dir / "Semester 1", directory=True)
                and self._has_file_entry(self._sidebar_files(win2), workspace_dir / "Semester 1", directory=True)
            )
            # Subfolders start collapsed and empty Archive is hidden by hideNonNoteFolders (#151).
            self.assertFalse(self._has_file_entry(self._sidebar_files(win1), nested_dir))
            self.assertFalse(self._has_file_entry(self._sidebar_files(win2), nested_dir))
            self.assertFalse(self._has_file_entry(self._sidebar_files(win1), workspace_dir / "Archive"))
            self.assertFalse(self._has_file_entry(self._sidebar_files(win2), workspace_dir / "Archive"))

            # Explicit newNoteLocation preference precedence (#134) remains intact over open folder.
            win1.setNoteLocation(str(preferred_dir))
            self.assertSamePath(win1.defaultSaveFolder().toLocalFile(), preferred_dir)
            self.assertSamePath(
                win1.defaultSaveLocation("Untitled.md").toLocalFile(),
                preferred_dir / "Untitled.md",
            )
            win1.settings["newNoteLocation"] = ""
            self.assertSamePath(win1.defaultSaveFolder().toLocalFile(), workspace_dir)

            # 1. Untitled Markdown note saved into collapsed Semester 1/Week 2 via QUrl string.
            tab1 = win1._current()
            tab1["content"] = "# Lecture 1\n\n Eigenvalues"
            lecture_md = nested_dir / "Lecture 1.md"
            win1.saveAs(QUrl.fromLocalFile(str(lecture_md)).toString())
            self.wait_until(
                lambda: not win1.saving
                and lecture_md.is_file()
                and self._has_file_entry(self._sidebar_files(win1), lecture_md, directory=False)
                and self._has_file_entry(self._sidebar_files(win2), lecture_md, directory=False)
            )
            self.assertSamePath(tab1["path"], lecture_md)
            self.assertTrue(self._has_watched_dir(win1, workspace_dir / "Semester 1"))
            self.assertTrue(self._has_watched_dir(win1, nested_dir))
            self.assertTrue(self._has_watched_dir(win2, nested_dir))
            # Unrelated window 3 remains collapsed on its own workspace.
            self.assertFalse(self._has_file_entry(self._sidebar_files(win3), other_dir / "Hidden" / "Nope.md"))
            self.assertEqual(len(win3.expanded), 1)

            # Save As on existing note defaults to its existing parent directory (Week 2).
            self.assertSamePath(win1.defaultSaveAsFolder().toLocalFile(), nested_dir)
            self.assertSamePath(
                win1.defaultSaveAsLocation(tab1["name"]).toLocalFile(),
                lecture_md,
            )

            # 2. Collapse Semester 1 in win1, then Save As existing note onto the SAME canonical file:
            # Save As still re-expands its collapsed destination ancestors in win1.
            win1.toggleDirectory(str(workspace_dir / "Semester 1"))
            self.wait_until(lambda: not self._has_file_entry(self._sidebar_files(win1), lecture_md))
            tab1["content"] = "# Lecture 1\n\nUpdated in place via Save As"
            win1.saveAs(QUrl.fromLocalFile(str(lecture_md)).toString())
            self.wait_until(
                lambda: not win1.saving
                and self._has_file_entry(self._sidebar_files(win1), lecture_md, directory=False)
            )
            self.assertEqual(lecture_md.read_text(encoding="utf-8"), "# Lecture 1\n\nUpdated in place via Save As")

            # 3. Save As existing note into another collapsed branch (Archive/Spring) expands it in both windows.
            copy_md = archive_dir / "Lecture 1 Copy.md"
            win1.saveAs(QUrl.fromLocalFile(str(copy_md)).toString())
            self.wait_until(
                lambda: not win1.saving
                and copy_md.is_file()
                and self._has_file_entry(self._sidebar_files(win1), copy_md, directory=False)
                and self._has_file_entry(self._sidebar_files(win2), copy_md, directory=False)
            )
            self.assertSamePath(win1.recent[0], copy_md)
            self.assertSamePath(win1.recent[1], lecture_md)

            # 4. Restart session and verify expanded ancestor chains persist in startup.json.
            self.session.quitting = True
            for win in (win1, win2, win3):
                win._suspend_watches_for_prefix(str(self.root), is_dir=True)
                win.stop()
            self.flush_writes()

            restored_session = Session(True, data=self.data_dir)
            restored_session.settings["python"] = sys.executable
            restored_win1 = QuietStudio(True, session=restored_session)
            restored_win2 = QuietStudio(True, session=restored_session)
            try:
                self.wait_until(
                    lambda: self._has_file_entry(self._sidebar_files(restored_win1), copy_md, directory=False)
                    and self._has_file_entry(self._sidebar_files(restored_win2), copy_md, directory=False)
                    and self._has_file_entry(self._sidebar_files(restored_win1), lecture_md, directory=False)
                )
            finally:
                for rw in (restored_win1, restored_win2):
                    rw._suspend_watches_for_prefix(str(self.root), is_dir=True)
                    rw.stop()
                    rw.pool.shutdown(wait=True, cancel_futures=True)
                    rw._search_pool.shutdown(wait=True, cancel_futures=True)
                    rw.deleteLater()
                restored_session.writes.shutdown(wait=True)
                self.app.sendPostedEvents(None, QEvent.Type.DeferredDelete)

    def test_portable_smd_save_and_save_as_expand_ancestors_and_deduplicate_recent(self):
        workspace_dir = self.root / "Portable Workspace"
        offline_dir = workspace_dir / "Bundles" / "Offline"
        live_dir = workspace_dir / "Bundles" / "Interactive"
        final_dir = workspace_dir / "Bundles" / "Final"
        md_export_dir = workspace_dir / "Bundles" / "Markdown Copy"
        for directory in (offline_dir, live_dir, final_dir, md_export_dir):
            directory.mkdir(parents=True)
        index_md = workspace_dir / "Index.md"
        index_md.write_text("# Portable Index\n", encoding="utf-8")

        png_bytes = b"\x89PNG\r\n\x1a\n" + (b"portable-asset-bytes-" * 8)
        png_data_url = "data:image/png;base64," + base64.b64encode(png_bytes).decode("ascii")
        svg_data_url = "data:image/svg+xml;base64," + base64.b64encode(b"<svg xmlns='http://www.w3.org/2000/svg'/>").decode("ascii")

        win1 = self.make_window()
        win2 = self.make_window()
        win1.openFolder(str(workspace_dir))
        win2.openFolder(str(workspace_dir))
        self.wait_until(
            lambda: self._has_file_entry(self._sidebar_files(win1), index_md, directory=False)
            and self._has_file_entry(self._sidebar_files(win2), index_md, directory=False)
        )
        self.assertFalse(self._has_file_entry(self._sidebar_files(win1), workspace_dir / "Bundles"))

        # 1. Offline (_save_text) portable .smd save on untitled note into collapsed subfolder.
        win1.ready = False
        tab = win1._current()
        tab.update(
            content="# Offline Bundle\n\n![chart](assets/chart.png)",
            assets={"assets/chart.png": png_data_url},
        )
        offline_smd = offline_dir / "Offline Packet.smd"
        win1.saveAs(QUrl.fromLocalFile(str(offline_smd)).toString())
        self.wait_until(
            lambda: not win1.saving
            and offline_smd.is_file()
            and self._has_file_entry(self._sidebar_files(win1), offline_smd, directory=False)
            and self._has_file_entry(self._sidebar_files(win2), offline_smd, directory=False)
        )
        self.assertTrue(tab["portable"])
        self.assertSamePath(tab["path"], offline_smd)
        self.assertEqual(
            documents.open_note(offline_smd),
            ("# Offline Bundle\n\n![chart](assets/chart.png)", {"assets/chart.png": png_data_url}, True),
        )
        self.assertTrue(any(folder_ops.same_path(k, offline_smd) for k in win1.note_file_stamps))

        # 2. Live reader-ready (export_fmd_native save_as) Save As on existing portable note into collapsed folder.
        win1.ready = True
        reader_calls: list[str] = []
        win1.readerCall.connect(reader_calls.append)
        live_smd = live_dir / "Lab Ω.smd"
        win1.saveAs(QUrl.fromLocalFile(str(live_smd)).toString())
        self.assertIn("window.supermdPortable?.(false)", reader_calls)
        win1.post(
            "save-as-live-1",
            "export_fmd_native",
            json.dumps({
                "id": tab["id"],
                "save": False,
                "content": "# Live Bundle\n\n![chart](assets/chart.png)\n![vec](assets/vec.svg)",
                "originalContent": tab["content"],
                "assets": {"assets/chart.png": png_data_url, "assets/vec.svg": svg_data_url},
            }),
        )
        self.wait_until(
            lambda: win1.busy == 0
            and not win1.saving
            and live_smd.is_file()
            and self._has_file_entry(self._sidebar_files(win1), live_smd, directory=False)
            and self._has_file_entry(self._sidebar_files(win2), live_smd, directory=False)
        )
        self.assertSamePath(tab["path"], live_smd)
        self.assertSamePath(win1.recent[0], live_smd)
        self.assertTrue(any(folder_ops.same_path(k, live_smd) for k in win1.note_file_stamps))

        # 3. Live reader-ready Save As on existing .smd note to Final folder when recent already holds a .. alias.
        final_smd = final_dir / "Lab Ω Final.smd"
        dotdot_alias = str(workspace_dir / "Bundles" / "Interactive" / ".." / "Final" / "Lab Ω Final.smd")
        self.session.recent = [str(offline_smd), dotdot_alias]
        win1.saveAs(QUrl.fromLocalFile(str(final_smd)).toString())
        win1.post(
            "save-as-live-2",
            "export_fmd_native",
            json.dumps({
                "id": tab["id"],
                "save": False,
                "content": "# Final Bundle\n\n![chart](assets/chart.png)",
                "originalContent": tab["content"],
                "assets": {"assets/chart.png": png_data_url},
            }),
        )
        self.wait_until(
            lambda: win1.busy == 0
            and not win1.saving
            and final_smd.is_file()
            and self._has_file_entry(self._sidebar_files(win1), final_smd, directory=False)
            and self._has_file_entry(self._sidebar_files(win2), final_smd, directory=False)
        )
        matches = [item for item in win1.recent if folder_ops.same_path(item, final_smd)]
        self.assertEqual(len(matches), 1, f"Expected deduplicated recent list, got: {win1.recent}")
        self.assertSamePath(win1.recent[0], final_smd)

        # 4. Save As existing .smd note to .md in another collapsed folder materializes assets & expands ancestors.
        converted_md = md_export_dir / "Lab Ω.md"
        win1.saveAs(QUrl.fromLocalFile(str(converted_md)).toString())
        self.wait_until(
            lambda: not win1.saving
            and converted_md.is_file()
            and self._has_file_entry(self._sidebar_files(win1), converted_md, directory=False)
            and self._has_file_entry(self._sidebar_files(win2), converted_md, directory=False)
        )
        self.assertFalse(tab["portable"])
        self.assertTrue((md_export_dir / "assets" / "chart.png").is_file())
        self.assertSamePath(win1.recent[0], converted_md)

    def test_save_as_canonical_recent_and_pinned_deduplication_and_symlink_rejection(self):
        workspace_dir = self.root / "Dedupe Workspace"
        sub_dir = workspace_dir / "Topics" / "Calculus"
        sub_dir.mkdir(parents=True)
        hidden_real_dir = workspace_dir / "Hidden Real"
        hidden_real_dir.mkdir()
        outside_dir = self.root / "Outside Target"
        outside_dir.mkdir()

        target_md = sub_dir / "Limits.md"
        target_md.write_text("# Old Limits\n", encoding="utf-8")
        other_md = workspace_dir / "Overview.md"
        other_md.write_text("# Overview\n", encoding="utf-8")

        win = self.make_window()
        win.openFolder(str(workspace_dir))
        self.wait_until(
            lambda: self._has_file_entry(self._sidebar_files(win), workspace_dir / "Topics", directory=True)
        )
        self.assertFalse(self._has_file_entry(self._sidebar_files(win), target_md))

        # Seed pinned and recent with non-canonical .. and QUrl slash variants of target_md.
        non_canon_dotdot = str(workspace_dir / "Topics" / "Calculus" / ".." / "Calculus" / "Limits.md")
        qurl_local = QUrl.fromLocalFile(str(target_md)).toLocalFile()
        self.session.pinned = [non_canon_dotdot]
        self.session.recent = [non_canon_dotdot, str(other_md), qurl_local]

        # Open Overview.md, then Save As over Limits.md: pinned & recent must canonicalize and deduplicate.
        tab = win._current()
        tab.update(
            name="Overview.md",
            path=str(other_md),
            content="# Replaced Limits\n",
            saved="# Overview\n",
        )
        win.saveAs(QUrl.fromLocalFile(str(target_md)).toString())
        self.wait_until(
            lambda: not win.saving
            and target_md.read_text(encoding="utf-8") == "# Replaced Limits\n"
            and self._has_file_entry(self._sidebar_files(win), target_md, directory=False)
        )
        sidebar = json.loads(win.sidebarSnapshot)
        matching_recent = [p for p in sidebar["recent"] if folder_ops.same_path(p, target_md)]
        matching_pinned = [p for p in sidebar["pinned"] if folder_ops.same_path(p, target_md)]
        self.assertEqual(len(matching_recent), 1, sidebar["recent"])
        self.assertEqual(len(matching_pinned), 1, sidebar["pinned"])
        # RecentNotes.qml checks list.pinned.includes(modelData) by exact string membership.
        self.assertIn(matching_recent[0], sidebar["pinned"])

        # Ordinary in-place save() on an already-saved note must NOT churn recent ordering.
        self.session.pinned = []
        win.recent = [str(other_md), folder_ops.canonical_path_str(target_md)]
        before_recent = list(win.recent)
        tab["content"] = "# In-place edit\n"
        win._save_text(tab, Path(tab["path"]), automatic=False)
        self.wait_until(lambda: not win.saving and tab["saved"] == "# In-place edit\n")
        self.assertEqual(win.recent, before_recent)

        # Symlink/junction directories inside the open workspace must NOT expand in sidebar.
        ext_link = workspace_dir / "External Link"
        intra_link = workspace_dir / "Intra Link"
        if _try_make_dir_link(ext_link, outside_dir):
            win.newNote()
            ext_tab = win._current()
            ext_tab["content"] = "# Via External Symlink"
            win.saveAs(str(ext_link / "Escaped.md"))
            self.wait_until(lambda: not win.saving and (outside_dir / "Escaped.md").is_file())
            self.assertFalse(any(folder_ops.same_path(p, ext_link) for p in win.expanded))
            self.assertFalse(any(folder_ops.same_path(p, outside_dir) for p in win.expanded))

        if _try_make_dir_link(intra_link, hidden_real_dir):
            win.newNote()
            intra_tab = win._current()
            intra_tab["content"] = "# Via Intra Symlink"
            win.saveAs(str(intra_link / "ViaLink.md"))
            self.wait_until(lambda: not win.saving and (hidden_real_dir / "ViaLink.md").is_file())
            self.assertFalse(any(folder_ops.same_path(p, intra_link) for p in win.expanded))
            self.assertFalse(any(folder_ops.same_path(p, hidden_real_dir) for p in win.expanded))
            self.assertFalse(self._has_file_entry(self._sidebar_files(win), hidden_real_dir / "ViaLink.md"))

        # Direct unit check of _dedupe_path_list for relative labels + Windows slash/case normalization.
        self.assertEqual(
            studio_mod._dedupe_path_list(["Notes λ.md", "Notes λ.md", "Other.md"]),
            ["Notes λ.md", "Other.md"],
        )
        with patch.object(os, "name", "nt"), patch.object(
            folder_ops,
            "normalize_path_key",
            side_effect=lambda raw: str(raw).replace("\\", "/").rstrip("/").lower(),
        ):
            deduped_win = studio_mod._dedupe_path_list([
                "C:/Users/Alice/Workspace/Note.md",
                r"C:\Users\Alice\Workspace\Note.md",
                r"c:\users\alice\workspace\Other.md",
            ])
            self.assertEqual(len(deduped_win), 2)
            self.assertEqual(deduped_win[0], "C:/Users/Alice/Workspace/Note.md")

    def test_agent_save_note_expands_collapsed_ancestors_in_open_workspace(self):
        workspace_dir = self.root / "Agent Workspace"
        agent_sub = workspace_dir / "Research" / "2026"
        agent_sub.mkdir(parents=True)
        readme_md = workspace_dir / "README.md"
        readme_md.write_text("# Agent Workspace\n", encoding="utf-8")

        win = self.make_window()
        win.openFolder(str(workspace_dir))
        self.wait_until(
            lambda: self._has_file_entry(self._sidebar_files(win), readme_md, directory=False)
        )
        self.assertFalse(self._has_file_entry(self._sidebar_files(win), workspace_dir / "Research"))
        self.assertFalse(self._has_file_entry(self._sidebar_files(win), agent_sub))

        tab = win._current()
        tab["content"] = "# Agent Note\n"
        win.settings["newNoteLocation"] = str(agent_sub)
        agent_target = agent_sub / "Agent Summary.md"
        expected_rev = hashlib.sha256(tab["content"].encode("utf-8")).hexdigest()
        prepared = win._prepare_save_document({
            "tabId": tab["id"],
            "expectedRevision": expected_rev,
            "filename": "Agent Summary.md",
            "format": "md",
            "saveAs": True,
        })
        Studio._run_prepared_write_sync(win, prepared)
        self.wait_until(
            lambda: self._has_file_entry(self._sidebar_files(win), agent_target, directory=False)
        )
        self.assertTrue(self._has_watched_dir(win, agent_sub))


class SaveAsQmlSidebarIntegrationTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if QGuiApplication.instance() is None:
            QQuickStyle.setStyle("Material")
        cls.app = QGuiApplication.instance() or QGuiApplication(["Save As QML integration tests"])

    def assertSamePath(self, actual: str | os.PathLike[str], expected: str | os.PathLike[str]) -> None:
        _assert_same_path(self, actual, expected)

    def setUp(self):
        self.temp_dir = Path(tempfile.mkdtemp(prefix="supermd-save-as-qml-"))
        self.root = Path(folder_ops.canonical_path_str(self.temp_dir))
        self.data_dir = self.root / "app-data"
        self.workspace_dir = self.root / "Course Folder"
        self.unit4_dir = self.workspace_dir / "Semester 2" / "Unit 4"
        self.unit5_dir = self.workspace_dir / "Semester 2" / "Unit 5"
        self.unit4_dir.mkdir(parents=True)
        self.unit5_dir.mkdir(parents=True)
        (self.workspace_dir / "Semester 2" / "Syllabus.md").write_text("# Semester 2\n", encoding="utf-8")

        self.session = Session(True, data=self.data_dir)
        self.session.settings["welcomed"] = True
        self.session.settings["python"] = sys.executable
        self.session.settings["newNoteLocation"] = ""
        self.studio = QuietStudio(True, session=self.session)
        self.studio.openFolder(str(self.workspace_dir))

        source = MAIN.read_text(encoding="utf-8")
        factory = source[source.index("    function chooseSaveDestination("):source.index("    function showExport(")]
        save_handlers = source[
            source.index("        function onSaveRequested(name)"):
            source.index("        function onSaveConflictRequested(name)")
        ]
        chooser = source[
            source.index("    Component {\n        id: saveDestinationComponent"):
            source.index("    Component {\n        id: exportDestinationComponent")
        ]

        self.qml_warnings: list[str] = []
        self.engine = QQmlEngine()

        def _capture_warnings(warnings):
            for warning in warnings:
                self.qml_warnings.append(warning.toString())

        self._warning_handler = _capture_warnings
        self.engine.warnings.connect(self._warning_handler)
        self.engine.rootContext().setContextProperty("studio", self.studio)

        qml_doc = f"""import QtQuick
import QtQuick.Controls
import QtQuick.Layouts
import QtQuick.Dialogs

ApplicationWindow {{
    id: window
    width: 720
    height: 560
    visible: true
    property var viewState: JSON.parse(studio.snapshot)
    property var sidebarState: JSON.parse(studio.sidebarSnapshot)
    property var shortcutLabels: JSON.parse(studio.shortcutLabels)
    property int contextMenuCount: 0
    property int modalDialogCount: 0
    QtObject {{ id: flushDialog; function close() {{}} }}
    QtObject {{ id: closeDialog; property bool visible: false; function close() {{}} }}

    Connections {{
        target: studio
        function onChanged() {{ window.viewState = JSON.parse(studio.snapshot) }}
        function onSidebarChanged() {{ window.sidebarState = JSON.parse(studio.sidebarSnapshot) }}
{save_handlers}
    }}

{factory}
{chooser}

    ColumnLayout {{
        anchors.fill: parent
        FolderSidebar {{
            id: folderSidebar
            objectName: "folderSidebar"
            Layout.fillWidth: true
            Layout.fillHeight: true
            viewState: window.viewState
            sidebarState: window.sidebarState
            shortcutLabels: window.shortcutLabels
        }}
        RecentNotes {{
            id: recentNotes
            objectName: "sidebarRecentNotes"
            Layout.fillWidth: true
            Layout.preferredHeight: 160
            model: window.sidebarState.recent
            pinned: window.sidebarState.pinned
            onOpenRequested: path => studio.openNote(path)
            onPinRequested: path => studio.pinRecent(path)
        }}
    }}
}}
"""
        self.component = QQmlComponent(self.engine)
        self.component.setData(qml_doc.encode("utf-8"), QUrl.fromLocalFile(str(MAIN)))
        self.window = self.component.create()
        self.assertIsNotNone(self.window, str(self.component.errors()))

    def tearDown(self):
        try:
            self.engine.warnings.disconnect(self._warning_handler)
        except (RuntimeError, TypeError):
            pass
        if self.window is not None:
            self.window.close()
            self.window.deleteLater()
        if not self.studio.retired:
            self.studio._suspend_watches_for_prefix(str(self.root), is_dir=True)
            self.studio.stop()
        self.studio.pool.shutdown(wait=True, cancel_futures=True)
        self.studio._search_pool.shutdown(wait=True, cancel_futures=True)
        self.studio.deleteLater()
        self.session.writes.shutdown(wait=True)
        self.app.sendPostedEvents(None, QEvent.Type.DeferredDelete)
        self.engine.deleteLater()
        self.app.sendPostedEvents(None, QEvent.Type.DeferredDelete)
        self.app.processEvents()
        shutil.rmtree(self.temp_dir, ignore_errors=True)

    def wait_until(self, predicate, timeout: float = 4.0) -> None:
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            self.app.processEvents()
            if predicate():
                return
            time.sleep(0.01)
        self.app.processEvents()
        self.assertTrue(predicate())

    def test_qml_main_save_and_save_as_integration_updates_folder_sidebar_and_recent_notes(self):
        self.wait_until(
            lambda: any(
                folder_ops.same_path(e["path"], self.workspace_dir / "Semester 2")
                for e in json.loads(self.studio.sidebarSnapshot)["files"]
            )
        )

        # 1. Untitled Save -> QML FileDialog seeded with open folder; user chooses nested Unit 4/Study Guide.md.
        tab = self.studio._current()
        tab["content"] = "# Study Guide\n\nIntegration test"
        self.studio.save()
        QTest.qWait(30)
        chooser = self.window.findChild(QObject, "saveDestination")
        self.assertIsNotNone(chooser)
        self.assertSamePath(chooser.property("currentFolder").toLocalFile(), self.workspace_dir)
        self.assertSamePath(chooser.property("selectedFile").toLocalFile(), self.workspace_dir / "Untitled.md")

        guide_md = self.unit4_dir / "Study Guide.md"
        chooser.setProperty("selectedFile", QUrl.fromLocalFile(str(guide_md)))
        QMetaObject.invokeMethod(chooser, "accepted")
        self.app.sendPostedEvents(None, QEvent.Type.DeferredDelete)

        self.wait_until(
            lambda: guide_md.is_file()
            and any(
                folder_ops.same_path(e["path"], guide_md)
                for e in self.window.property("sidebarState").toVariant()["files"]
            )
        )

        # Pin Study Guide.md, inject a non-canonical .. alias in pinned/recent, then Save As onto Study Guide.md.
        self.studio.pinRecent(str(guide_md))
        QTest.qWait(20)
        dotdot_guide = str(self.workspace_dir / "Semester 2" / "Unit 4" / ".." / "Unit 4" / "Study Guide.md")
        self.session.pinned = [dotdot_guide]
        self.session.recent = [dotdot_guide]

        self.studio.saveAsRequested.emit(tab["name"])
        QTest.qWait(30)
        chooser2 = self.window.findChild(QObject, "saveDestination")
        self.assertIsNotNone(chooser2)
        self.assertSamePath(chooser2.property("currentFolder").toLocalFile(), self.unit4_dir)
        self.assertSamePath(chooser2.property("selectedFile").toLocalFile(), guide_md)
        QMetaObject.invokeMethod(chooser2, "accepted")
        self.app.sendPostedEvents(None, QEvent.Type.DeferredDelete)

        self.wait_until(lambda: not self.studio.saving)
        QTest.qWait(30)
        sidebar_state = self.window.property("sidebarState").toVariant()
        self.assertEqual(len(sidebar_state["recent"]), 1)
        self.assertSamePath(sidebar_state["recent"][0], guide_md)
        self.assertIn(sidebar_state["recent"][0], sidebar_state["pinned"])

        # Verify RecentNotes QML delegate renders isPinned and the pinned indicator after canonical deduplication.
        recent_list = self.window.findChild(QQuickItem, "sidebarRecentNotes")
        self.assertIsNotNone(recent_list)
        QTest.qWait(50)
        visual_items: list[QQuickItem] = []
        stack = [recent_list]
        while stack:
            item = stack.pop()
            visual_items.append(item)
            stack.extend(item.childItems())
        pinned_entries = [
            item for item in visual_items
            if item.objectName() == "recentNoteEntry" and bool(item.property("isPinned"))
        ]
        pinned_indicators = [
            item for item in visual_items
            if item.objectName() == "recentPinnedIndicator" and item.isVisible()
        ]
        self.assertEqual(len(pinned_entries), 1)
        self.assertEqual(len(pinned_indicators), 1)

        # 2. Save As existing note as portable .smd into collapsed Unit 5 subfolder.
        self.studio.ready = False
        guide_smd = self.unit5_dir / "Study Guide.smd"
        self.studio.saveAsRequested.emit(tab["name"])
        QTest.qWait(30)
        chooser3 = self.window.findChild(QObject, "saveDestination")
        self.assertIsNotNone(chooser3)
        chooser3.setProperty("selectedFile", QUrl.fromLocalFile(str(guide_smd)))
        QMetaObject.invokeMethod(chooser3, "accepted")
        self.app.sendPostedEvents(None, QEvent.Type.DeferredDelete)

        self.wait_until(
            lambda: guide_smd.is_file()
            and any(
                folder_ops.same_path(e["path"], guide_smd)
                for e in self.window.property("sidebarState").toVariant()["files"]
            )
        )
        sidebar_after = self.window.property("sidebarState").toVariant()
        # Pinned guide_md stays first, newly saved guide_smd is second, zero duplicates.
        self.assertEqual(len(sidebar_after["recent"]), 2)
        self.assertSamePath(sidebar_after["recent"][0], guide_md)
        self.assertSamePath(sidebar_after["recent"][1], guide_smd)

        bad_warnings = [
            w for w in self.qml_warnings
            if any(token in w for token in ("TypeError", "ReferenceError", "Error:"))
        ]
        self.assertEqual(bad_warnings, [], f"Unexpected QML errors: {bad_warnings}")


if __name__ == "__main__":
    unittest.main()
