"""Focused unit tests for extracted desktop/studio_workspace.py domain helpers and Studio facade."""
from __future__ import annotations

import json, os, shutil, sys, tempfile, time, unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
os.environ.setdefault("QT_QUICK_BACKEND", "software")

from PySide6.QtCore import QCoreApplication, QEvent, QObject, QUrl
from PySide6.QtGui import QGuiApplication
from PySide6.QtQml import QQmlComponent, QQmlEngine
from PySide6.QtQuickControls2 import QQuickStyle

import folder_ops
import studio as studio_mod
from studio import Session, Studio
from test_studio import QuietStudio


def _wait_until(predicate, timeout: float = 3.0) -> bool:
    app = QCoreApplication.instance()
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if app is not None:
            app.processEvents()
        if predicate():
            return True
        time.sleep(0.01)
    return bool(predicate())


class StudioWorkspaceTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if QGuiApplication.instance() is None:
            QQuickStyle.setStyle("Material")
        cls.app = QGuiApplication.instance() or QGuiApplication(["Studio workspace unit tests"])

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="supermd-studio-workspace-")
        self.root = Path(folder_ops.canonical_path_str(self.temp.name))
        self.session = Session(True)
        self.session.settings["python"] = sys.executable
        self.studio = QuietStudio(True, self.session)

    def tearDown(self):
        self.studio.stop()
        self.studio._search_pool.shutdown(wait=True, cancel_futures=True)
        self.studio.pool.shutdown(wait=True, cancel_futures=True)
        self.session.writes.shutdown(wait=True)
        shutil.rmtree(self.session.data, ignore_errors=True)
        self.temp.cleanup()

    def test_open_toggle_restore_and_close_folder_exclude_hidden_and_links_and_invalidate_cache(self):
        vault, outside = self.root / "vault", self.root / "outside"
        for sub in (vault / "topics" / "deep", vault / ".hidden_dir", vault / "junction_dir", outside):
            sub.mkdir(parents=True, exist_ok=True)
        (outside / "secret.md").write_text("# Secret\n", encoding="utf-8")
        for rel, text in (
            ("alpha.md", "# Alpha\n"),
            (".hidden.md", "# Hidden\n"),
            (".hidden_dir/inside.md", "# Hidden Dir\n"),
            ("topics/beta.smd", "# Beta\n"),
            ("topics/deep/gamma.txt", "Gamma\n"),
            ("junction_dir/junc.md", "# Junction\n"),
        ):
            (vault / rel).write_text(text, encoding="utf-8")
        (vault / "ignore.png").write_bytes(b"not-a-note")
        try:
            (vault / "symlink_note.md").symlink_to(outside / "secret.md")
            (vault / "symlink_dir").symlink_to(outside, target_is_directory=True)
        except OSError:
            pass

        orig_is_link = folder_ops._is_link_or_junction
        junction_str = str((vault / "junction_dir").resolve())
        sidebar_signals: list[int] = []
        self.studio.sidebarChanged.connect(lambda: sidebar_signals.append(1))

        def fake_is_link(p):
            return str(Path(p).resolve(strict=False)) == junction_str or orig_is_link(Path(p))

        with (
            patch.object(studio_mod.folder_ops, "_is_link_or_junction", side_effect=fake_is_link),
            patch.object(self.session.workspace_links, "invalidate", wraps=self.session.workspace_links.invalidate) as spy_inv,
        ):
            rev_before = self.studio._files_revision
            self.studio.openFolder(str(vault))
            self.assertTrue(_wait_until(lambda: len(self.studio.files) == 2))
            self.assertGreater(self.studio._files_revision, rev_before)
            self.assertGreaterEqual(len(sidebar_signals), 1)
            spy_inv.assert_called_with(self.studio.folder)
            self.assertEqual([e["name"] for e in self.studio.files], ["topics", "alpha.md"])

            topics = vault / "topics"
            self.studio.toggleDirectory(str(topics))
            self.assertTrue(_wait_until(lambda: any(e["name"] == "beta.smd" for e in self.studio.files)))
            self.assertEqual(
                [(e["name"], e["depth"], e["expanded"]) for e in self.studio.files],
                [("topics", 0, True), ("deep", 1, False), ("beta.smd", 1, False), ("alpha.md", 0, False)],
            )
            self.studio.toggleDirectory(str(topics))
            self.assertTrue(_wait_until(lambda: all(e["name"] != "beta.smd" for e in self.studio.files)))

            spy_inv.reset_mock()
            self.studio._restore_workspace_folder(str(vault), [str(topics), str(vault / "junction_dir"), str(outside)])
            self.assertTrue(_wait_until(lambda: any(e["name"] == "beta.smd" for e in self.studio.files)))
            self.assertEqual(self.studio.expanded, {folder_ops.canonical_path_str(vault), folder_ops.canonical_path_str(topics)})
            spy_inv.assert_called_once_with(self.studio.folder)

            spy_inv.reset_mock()
            rev_pre_close = self.studio._files_revision
            self.studio.closeFolder()
            self.assertEqual((self.studio.folder, self.studio.files, self.studio.expanded), ("", [], set()))
            self.assertGreater(self.studio._files_revision, rev_pre_close)
            spy_inv.assert_called_once_with(folder_ops.canonical_path_str(vault))

    def test_folder_visibility_toggle_scan_budget_pinned_dirs_watches_and_picker(self):
        vault = self.root / "visibility_vault"
        for sub in (
            vault / "00_Empty",
            vault / "01_LegacyMarkdown",
            vault / "02_HeavyAssets",
            vault / "03_NotesMd",
            vault / "04_PortableSmd",
            vault / "05_Nested" / "TxtDir",
        ):
            sub.mkdir(parents=True, exist_ok=True)
        (vault / "01_LegacyMarkdown" / "doc.markdown").write_text("# Legacy\n", encoding="utf-8")
        for idx in range(8):
            (vault / "02_HeavyAssets" / f"img_{idx}.png").write_bytes(b"\x89PNG\r\n")
        (vault / "03_NotesMd" / "note.md").write_text("# Note\n", encoding="utf-8")
        (vault / "04_PortableSmd" / "pack.smd").write_bytes(b"{}")
        (vault / "05_Nested" / "TxtDir" / "plain.txt").write_text("Plain\n", encoding="utf-8")

        self.assertEqual(studio_mod.FOLDER_TREE_NOTE_SUFFIXES, frozenset({".md", ".smd", ".txt"}))
        self.studio.openFolder(str(vault))
        self.assertTrue(_wait_until(lambda: [e["name"] for e in self.studio.files] == ["03_NotesMd", "04_PortableSmd", "05_Nested"]))
        self.assertEqual(
            {folder_ops.canonical_path_str(d) for d in self.studio.note_watcher.directories()},
            {folder_ops.canonical_path_str(vault)},
        )

        # Single visibility toggle reveals empty/asset/.markdown subfolders and note rows, then rehides them.
        self.studio.setting("hideNonNoteFolders", "false")
        self.assertTrue(_wait_until(lambda: "00_Empty" in [e["name"] for e in self.studio.files]))
        self.studio.toggleDirectory(str(vault / "01_LegacyMarkdown"))
        self.assertTrue(_wait_until(lambda: "doc.markdown" in [e["name"] for e in self.studio.files]))
        self.studio.setting("hideNonNoteFolders", "true")
        self.assertTrue(_wait_until(lambda: [e["name"] for e in self.studio.files] == ["03_NotesMd", "04_PortableSmd", "05_Nested"]))

        # Small scan budget keeps unresolved folder (02_HeavyAssets) and subsequent valid note folders visible.
        self.studio._folder_tree_scan_budget = 4
        self.studio._load_tree()
        self.assertTrue(
            _wait_until(lambda: [e["name"] for e in self.studio.files] == ["02_HeavyAssets", "03_NotesMd", "04_PortableSmd", "05_Nested"])
        )
        self.studio._folder_tree_scan_budget = None

        # Newly created empty subfolder stays pinned until collapsed.
        self.studio.createSubfolder(str(vault), "99_PinnedDrafts")
        self.assertTrue(_wait_until(lambda: "99_PinnedDrafts" in [e["name"] for e in self.studio.files]))
        self.studio.toggleDirectory(str(vault / "99_PinnedDrafts"))
        self.assertTrue(_wait_until(lambda: "99_PinnedDrafts" not in [e["name"] for e in self.studio.files]))

        # FolderSidebar selection and active-note highlighting carry cleanly through the extracted helpers.
        qml_dir = (Path(studio_mod.__file__).parent / "qml").resolve()
        engine = QQmlEngine()
        engine.rootContext().setContextProperty("studio", self.studio)
        comp = QQmlComponent(engine)
        comp.setData(
            b"import QtQuick\nimport QtQuick.Controls\nApplicationWindow { id: window; visible: true; width: 300; height: 520\n"
            b"property var viewState: JSON.parse(studio.snapshot)\n"
            b"property var sidebarState: JSON.parse(studio.sidebarSnapshot)\n"
            b"property var shortcutLabels: JSON.parse(studio.shortcutLabels || '{}')\n"
            b"FolderSidebar { anchors.fill: parent; viewState: window.viewState; sidebarState: window.sidebarState; shortcutLabels: window.shortcutLabels } }\n",
            QUrl.fromLocalFile(str(qml_dir / "workspace-selection-check.qml")),
        )
        win = comp.create()
        self.assertIsNotNone(win, str(comp.errors()))
        try:
            sidebar = win.findChild(QObject, "folderSidebar")
            self.studio.openNote(str(vault / "03_NotesMd" / "note.md"))
            self.assertTrue(_wait_until(lambda: str(sidebar.property("activeTabPath")).endswith("note.md")))
            self.studio.setting("hideNonNoteFolders", "false")
            self.assertTrue(_wait_until(lambda: "00_Empty" in [e["name"] for e in json.loads(self.studio.sidebarSnapshot)["files"]]))
            sidebar.setProperty("selectedPath", folder_ops.canonical_path_str(vault / "00_Empty"))
            sidebar.setProperty("selectedDirectory", True)
            self.studio.setting("hideNonNoteFolders", "true")
            self.assertTrue(_wait_until(lambda: sidebar.property("selectedPath") == "" and not bool(sidebar.property("selectedDirectory"))))
            self.studio.toggleDirectory(str(vault / "03_NotesMd"))
            self.assertTrue(_wait_until(lambda: any(e["name"] == "note.md" for e in json.loads(self.studio.sidebarSnapshot)["files"])))
            sidebar.setProperty("selectedPath", folder_ops.canonical_path_str(vault / "03_NotesMd" / "note.md"))
            self.studio.toggleDirectory(str(vault / "03_NotesMd"))
            self.assertTrue(_wait_until(lambda: sidebar.property("selectedPath") == ""))
            sidebar.setProperty("selectedPath", folder_ops.canonical_path_str(vault / "03_NotesMd"))
            sidebar.setProperty("selectedDirectory", True)
            self.studio.closeFolder()
            self.assertTrue(_wait_until(lambda: sidebar.property("selectedPath") == "" and not bool(sidebar.property("selectedDirectory"))))
        finally:
            win.close(); win.deleteLater(); engine.deleteLater()
            self.app.sendPostedEvents(None, QEvent.Type.DeferredDelete)

        # Closing folder releases folder directory watches; native picker signal stays intact.
        self.assertNotIn(
            folder_ops.canonical_path_str(vault),
            {folder_ops.canonical_path_str(d) for d in self.studio.note_watcher.directories()},
        )
        picker_requests: list[int] = []
        self.studio.folderPickerRequested.connect(lambda: picker_requests.append(1))
        with patch.object(studio_mod.sys, "platform", "darwin"):
            self.studio.chooseFolder()
        self.assertEqual(picker_requests, [1])

    def test_subfolder_filter_matches_ancestors_discards_stale_generations_and_restores_tree(self):
        vault = self.root / "course_notes"
        (vault / "Physics" / "Optics").mkdir(parents=True)
        (vault / "History").mkdir()
        (vault / "Overview.md").write_text("# Overview\n", encoding="utf-8")
        (vault / "Physics" / "Optics" / "Fresnel Diffraction.md").write_text("# Fresnel\n", encoding="utf-8")
        (vault / "History" / "Archive.md").write_text("# Archive\n", encoding="utf-8")

        self.studio.openFolder(str(vault))
        self.assertTrue(_wait_until(lambda: len(self.studio.files) == 3))
        self.studio.toggleDirectory(str(vault / "History"))
        self.assertTrue(_wait_until(lambda: any(e["name"] == "Archive.md" for e in self.studio.files)))

        submitted: list[tuple] = []
        with patch.object(self.studio, "_submit", side_effect=lambda action, done, *args: submitted.append((action, done, args))):
            self.studio.setFolderFilter("FRESNEL")
            self.assertTrue(self.studio._folder_searching and self.studio.filter_timer.isActive())
            self.studio._start_subfolder_search()
            stale_action, stale_done, stale_args = submitted.pop()
            self.assertEqual(stale_args, (False, self.studio._search_pool))
            stale_result = stale_action()

            self.studio.setFolderFilter("overview")
            self.studio._start_subfolder_search()
            fresh_action, fresh_done, _ = submitted.pop()

            stale_done(stale_result, None)
            self.assertNotEqual([e["name"] for e in self.studio.files], ["Physics", "Optics", "Fresnel Diffraction.md"])

            fresh_done(fresh_action(), None)
            self.assertFalse(self.studio._folder_searching)
            self.assertEqual([e["name"] for e in self.studio.files], ["Overview.md"])

        self.studio.setFolderFilter("fresnel")
        self.assertTrue(_wait_until(lambda: (
            not self.studio.filter_timer.isActive() and not self.studio._folder_searching
            and [e["name"] for e in self.studio.files] == ["Physics", "Optics", "Fresnel Diffraction.md"]
        )))
        self.studio.setFolderFilter("   ")
        self.assertTrue(_wait_until(lambda: [e["name"] for e in self.studio.files] == ["History", "Archive.md", "Physics", "Overview.md"]))

    def test_workspace_search_lifecycle_batches_generation_guard_and_match_flush(self):
        note = self.root / "study.md"
        note.write_text("# Study\n\nHamiltonian operator on line 3.\n", encoding="utf-8")
        self.studio.openFolder(str(self.root))
        self.assertTrue(_wait_until(lambda: len(self.studio.files) == 1))
        self.studio.ready = True

        self.studio.openFolderSearch()
        self.assertEqual(self.studio.flush_operation["action"], "sync_for_search")
        self.assertTrue(self.studio.folderSearchState["open"] and self.studio.folderSearchState["hasFolder"])

        captured_calls: list[tuple] = []
        with patch("studio.stream_text_search", side_effect=lambda *a, **kw: captured_calls.append((a, kw))):
            self.studio.updateFolderSearch("Hamiltonian", True, True)
            self.assertTrue(_wait_until(lambda: len(captured_calls) == 1))
            gen = self.studio._folder_search_generation
            self.studio._on_workspace_search_batch(gen - 1, [{"name": "stale.md"}], 99, True, True)
            self.assertEqual(self.studio.folderSearchState["matches"], [])

            self.studio._on_workspace_search_batch(gen, [{"name": "study.md", "line": 3}], 1, False, False)
            self.studio._on_workspace_search_batch(gen, [{"name": "study.md", "line": 7}], 2, True, True)
            state = self.studio.folderSearchState
            self.assertEqual([m["line"] for m in state["matches"]], [3, 7])
            self.assertEqual((state["scannedFiles"], state["truncated"], state["scanning"]), (2, True, True))

        self.studio.cancelWorkspaceSearch()
        self.assertFalse(self.studio.folderSearchState["open"])
        self.assertEqual(self.studio.folderSearchState["matches"], [])
        self.assertIsNone(self.studio.flush_operation)

        self.studio.openFolderSearch()
        self.studio.openFolderSearchMatch("tab-42", str(note), "Hamiltonian", True, 10, 21, "Hamiltonian")
        self.assertFalse(self.studio.folderSearchState["open"])
        self.assertEqual(self.studio.flush_operation["action"], "open_search_match")
        self.assertEqual(
            json.loads(self.studio.flush_operation["target"]),
            {"tabId": "tab-42", "path": str(note), "query": "Hamiltonian", "caseSensitive": True,
             "sourceStart": 10, "sourceEnd": 21, "matchText": "Hamiltonian"},
        )

    def test_unbound_simplenamespace_proxies_and_local_path_monkeypatch(self):
        dir_a, dir_b = self.root / "win_a", self.root / "win_b"
        (dir_a / "sub").mkdir(parents=True)
        (dir_a / "empty_sub").mkdir()
        dir_b.mkdir()
        (dir_a / "note_a.md").write_text("# A\n", encoding="utf-8")
        (dir_a / "sub" / "nested.txt").write_text("Nested\n", encoding="utf-8")

        refreshed: list[str] = []
        win_a = SimpleNamespace(folder=folder_ops.canonical_path_str(dir_a), retired=False, _load_tree=lambda: refreshed.append("a"))
        win_b = SimpleNamespace(folder=folder_ops.canonical_path_str(dir_b), retired=False, _load_tree=lambda: refreshed.append("b"))
        win_r = SimpleNamespace(folder=folder_ops.canonical_path_str(dir_a), retired=True, _load_tree=lambda: refreshed.append("r"))
        owner = SimpleNamespace(session=SimpleNamespace(windows={"a": win_a, "b": win_b, "r": win_r}))

        self.assertTrue(Studio._is_within_open_folder(win_a, dir_a / "sub" / "doc.md"))
        self.assertFalse(Studio._is_within_open_folder(win_a, dir_b / "other.md"))
        Studio._refresh_open_folder_trees(owner, dir_a / "sub" / "doc.md")
        self.assertEqual(refreshed, ["a"])

        standalone = SimpleNamespace(
            folder="", files=[], expanded=set(), folder_filter="", _folder_searching=False,
            _search_generation=0, _search_cancel=None, filter_timer=None, settings={}, session=SimpleNamespace(),
        )
        with patch("studio._raw_local_path", side_effect=lambda _raw: str(dir_a)) as spy_raw:
            Studio.openFolder(standalone, "custom://redirected-folder")
            spy_raw.assert_called_once_with("custom://redirected-folder")
        self.assertEqual(standalone.folder, str(studio_mod._canonical_approved_directory(dir_a)))
        self.assertEqual([e["name"] for e in standalone.files], ["sub", "note_a.md"])
        Studio.closeFolder(standalone)
        self.assertEqual((standalone.folder, standalone.files), ("", []))

    def test_canonical_native_folder_paths_preserve_outer_whitespace_and_reject_links(self):
        # Win32 strips trailing spaces on directory creation; leading spaces work on Windows and leading/trailing on POSIX.
        ws_name = " Workspace " if os.name != "nt" else " Workspace"
        sub_name = " Sub " if os.name != "nt" else " Sub"
        ws_dir = self.root / ws_name
        sub_dir = ws_dir / sub_name
        decoy_ws = self.root / "Workspace"
        outside = self.root / "outside"
        for d in (sub_dir, decoy_ws, outside / "nested"):
            d.mkdir(parents=True, exist_ok=True)
        self.assertFalse(os.path.samefile(ws_dir, decoy_ws))
        (ws_dir / "Root.md").write_text("# Root\n", encoding="utf-8")
        (sub_dir / "Nested.md").write_text("# Nested\n", encoding="utf-8")
        (decoy_ws / "Decoy.md").write_text("# Decoy\n", encoding="utf-8")
        (outside / "nested" / "Leak.md").write_text("# Leak\n", encoding="utf-8")

        symlink_root = self.root / "symlink_ws"
        symlink_sub = ws_dir / "symlink_sub"
        links_ok = False
        try:
            symlink_root.symlink_to(outside, target_is_directory=True)
            symlink_sub.symlink_to(outside / "nested", target_is_directory=True)
            links_ok = True
        except OSError:
            pass

        ws_canon = str(studio_mod._canonical_approved_directory(ws_dir))
        sub_canon = str(studio_mod._canonical_approved_directory(sub_dir))
        decoy_canon = str(studio_mod._canonical_approved_directory(decoy_ws))
        self.studio.openFolder(QUrl.fromLocalFile(str(ws_dir)).toString())
        self.assertEqual(self.studio.folder, ws_canon)
        self.assertNotEqual(self.studio.folder, decoy_canon)
        self.assertTrue(_wait_until(lambda: [e["name"] for e in self.studio.files] == [sub_name, "Root.md"]))

        for invalid in ("", "   ") + ((str(symlink_root), str(symlink_root / "nested")) if links_ok else ()):
            self.studio.openFolder(invalid)
            self.assertEqual(self.studio.folder, ws_canon)

        self.studio.toggleDirectory("")
        self.studio.toggleDirectory("   ")
        if links_ok:
            self.studio.toggleDirectory(str(symlink_sub))
        self.assertEqual(self.studio.expanded, {ws_canon})

        self.studio.toggleDirectory(QUrl.fromLocalFile(str(sub_dir)).toString())
        self.assertEqual(self.studio.expanded, {ws_canon, sub_canon})
        self.assertTrue(_wait_until(lambda: any(e["name"] == "Nested.md" for e in self.studio.files)))

        restored_expanded = [sub_canon, str(decoy_ws)] + ([str(symlink_sub)] if links_ok else [])
        self.studio.closeFolder()
        if links_ok:
            self.studio._restore_workspace_folder(str(symlink_root / "nested"), [])
            self.assertEqual(self.studio.folder, "")
        self.studio._restore_workspace_folder(ws_canon, restored_expanded)
        self.assertEqual(self.studio.folder, ws_canon)
        self.assertEqual(self.studio.expanded, {ws_canon, sub_canon})

    def test_watcher_suspension_holds_across_tree_loads_and_reconciles_after_release(self):
        vault = self.root / "vault"
        sub = vault / "Topics"
        renamed_sub = vault / "RenamedTopics"
        sub.mkdir(parents=True)
        note = sub / "Lecture.md"
        note.write_text("# Lecture\n", encoding="utf-8")

        self.studio.openFolder(str(vault))
        self.assertTrue(_wait_until(lambda: len(self.studio.files) == 1))
        self.studio.toggleDirectory(str(sub))
        self.assertTrue(_wait_until(lambda: any(e["name"] == "Lecture.md" for e in self.studio.files)))
        self.studio.openNote(str(note))
        self.assertTrue(_wait_until(lambda: any(folder_ops.same_path(t["path"], note) for t in self.studio.tabs)))

        resume = self.studio._hold_watches_for_rename(str(sub), is_dir=True, new_path=str(renamed_sub))
        try:
            watched_mid = {folder_ops.canonical_path_str(p) for p in (self.studio.note_watcher.files() + self.studio.note_watcher.directories())}
            for suspended in (vault, sub, note):
                self.assertNotIn(folder_ops.canonical_path_str(suspended), watched_mid)

            sub.rename(renamed_sub)
            self.studio._load_tree()
            self.assertTrue(_wait_until(lambda: any(e["name"] == "RenamedTopics" for e in self.studio.files)))
            watched_after_tree = {folder_ops.canonical_path_str(p) for p in (self.studio.note_watcher.files() + self.studio.note_watcher.directories())}
            for suspended in (vault, sub, renamed_sub, note, renamed_sub / "Lecture.md"):
                self.assertNotIn(folder_ops.canonical_path_str(suspended), watched_after_tree)

            self.studio.external_paths = {str(sub), str(note), str(vault)}
            self.studio._refresh_external_notes()
            self.app.processEvents()
            self.assertTrue(any(folder_ops.same_path(t["path"], note) for t in self.studio.tabs))
        finally:
            self.studio._sync_path_change(
                str(sub), str(renamed_sub), is_dir=True, on_rebound=resume.set
            )

        rebound_note = str(renamed_sub / "Lecture.md")
        self.assertTrue(any(folder_ops.same_path(t["path"], rebound_note) for t in self.studio.tabs))
        watched_rebound = {folder_ops.canonical_path_str(p) for p in (self.studio.note_watcher.files() + self.studio.note_watcher.directories())}
        self.assertIn(folder_ops.canonical_path_str(vault), watched_rebound)
        self.assertIn(folder_ops.canonical_path_str(renamed_sub), watched_rebound)
        self.assertIn(folder_ops.canonical_path_str(rebound_note), watched_rebound)


if __name__ == "__main__":
    unittest.main()
