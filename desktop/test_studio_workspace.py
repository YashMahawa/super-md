"""Focused unit tests for extracted desktop/studio_workspace.py domain helpers and Studio facade."""
from __future__ import annotations

import json, os, shutil, sys, tempfile, time, unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
os.environ.setdefault("QT_QUICK_BACKEND", "software")

from PySide6.QtCore import QCoreApplication
from PySide6.QtGui import QGuiApplication
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
        self.root = Path(self.temp.name).resolve()
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
        self.studio.openFolderSearchMatch("tab-42", str(note), "Hamiltonian", True)
        self.assertFalse(self.studio.folderSearchState["open"])
        self.assertEqual(self.studio.flush_operation["action"], "open_search_match")
        self.assertEqual(
            json.loads(self.studio.flush_operation["target"]),
            {"tabId": "tab-42", "path": str(note), "query": "Hamiltonian", "caseSensitive": True},
        )

    def test_unbound_simplenamespace_proxies_and_local_path_monkeypatch(self):
        dir_a, dir_b = self.root / "win_a", self.root / "win_b"
        (dir_a / "sub").mkdir(parents=True)
        dir_b.mkdir()
        (dir_a / "note_a.md").write_text("# A\n", encoding="utf-8")

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
        with patch("studio.local_path", side_effect=lambda _raw: dir_a) as spy_local:
            Studio.openFolder(standalone, "custom://redirected-folder")
            spy_local.assert_called_once_with("custom://redirected-folder")
        self.assertEqual(standalone.folder, folder_ops.canonical_path_str(dir_a))
        self.assertEqual([e["name"] for e in standalone.files], ["sub", "note_a.md"])
        Studio.closeFolder(standalone)
        self.assertEqual((standalone.folder, standalone.files), ("", []))


if __name__ == "__main__":
    unittest.main()
