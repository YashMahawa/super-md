import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
from PySide6.QtCore import QCoreApplication
from PySide6.QtGui import QGuiApplication

from studio import Session
from test_studio import QuietStudio
from workspace_links import WorkspaceLinkCache, resolve_workspace_link


def _try_create_link(link: Path, target: Path, *, target_is_directory: bool = False) -> bool:
    try:
        link.symlink_to(target, target_is_directory=target_is_directory)
        return True
    except (OSError, NotImplementedError) as exc:
        if sys.platform == "win32" and target_is_directory and getattr(exc, "winerror", None) == 1314:
            subprocess.run(
                ["cmd", "/c", "mklink", "/J", str(link), str(target)],
                check=False,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
            return link.exists()
        if sys.platform == "win32" and getattr(exc, "winerror", None) == 1314:
            return False
        raise


class WorkspaceLinkRankingAndCacheTest(unittest.TestCase):
    def test_ranks_nested_wikilinks_deterministically_without_writing_index_files(self):
        with tempfile.TemporaryDirectory() as root_dir:
            root = Path(root_dir).resolve()
            (root / "Index.md").write_text("# Index\n", encoding="utf-8")
            archive = root / "Archive"
            archive.mkdir()
            exact_topic = archive / "Topic.md"
            exact_topic.write_text("# Exact Case Topic\n", encoding="utf-8")
            other_sibling = archive / "Sibling.md"
            other_sibling.write_text("# Other Dir MD\n", encoding="utf-8")

            specs = root / "Specs"
            deep = specs / "Deep"
            deep.mkdir(parents=True)
            (deep / "topic.md").write_text("# Lowercase Topic\n", encoding="utf-8")
            sub_note = specs / "Sub Note.md"
            sub_note.write_text("# Sub Note\n", encoding="utf-8")
            same_dir_smd = specs / "Sibling.smd"
            same_dir_smd.write_text("# Same Dir SMD\n", encoding="utf-8")

            cache = WorkspaceLinkCache()
            # 1. Nested subfolder wikilink resolves from root note
            self.assertEqual(
                resolve_workspace_link("Sub Note", wikilink=True, note_path=root / "Index.md", workspace_folder=root, cache=cache),
                sub_note.resolve(),
            )
            # 2. Exact case ("Topic") beats lowercase ("topic") even when lowercase is closer
            self.assertEqual(
                resolve_workspace_link("Topic", wikilink=True, note_path=deep / "topic.md", workspace_folder=root, cache=cache),
                exact_topic.resolve(),
            )
            # 3. Same-directory match ("Specs/Sibling.smd") beats other-directory ("Archive/Sibling.md") when case matches
            self.assertEqual(
                resolve_workspace_link("Sibling", wikilink=True, note_path=sub_note, workspace_folder=root, cache=cache),
                same_dir_smd.resolve(),
            )
            # 4. Zero hidden metadata or index files written anywhere in the workspace
            self.assertFalse(any(p.name.startswith(".") for p in root.rglob("*")))

    def test_bounded_scan_respects_file_cap_and_invalidates_across_ancestor_aliases(self):
        with tempfile.TemporaryDirectory() as base_dir:
            base = Path(base_dir).resolve()
            real_vault = base / "private" / "Vault"
            real_vault.mkdir(parents=True)
            for idx in range(10):
                (real_vault / f"Note-{idx:02d}.md").write_text(f"# {idx}\n", encoding="utf-8")

            bounded = WorkspaceLinkCache(max_files=4, ttl_seconds=60.0)
            self.assertEqual(len(bounded.scan(real_vault)), 4)

            alias_parent = base / "alias"
            vault_ref = real_vault
            if _try_create_link(alias_parent, base / "private", target_is_directory=True):
                vault_ref = alias_parent / "Vault"

            added = real_vault / "Note-00-Fresh.md"
            added.write_text("# Fresh\n", encoding="utf-8")
            bounded.invalidate(vault_ref)
            self.assertTrue(any(item.name == "Note-00-Fresh.md" for item in bounded.scan(vault_ref)))


class StudioOpenTabJumpTest(unittest.TestCase):
    app: QCoreApplication

    @classmethod
    def setUpClass(cls):
        cls.app = QGuiApplication.instance() or QGuiApplication(["Workspace link tests"])

    def setUp(self):
        self.session = Session(True)
        self.session.settings["python"] = sys.executable
        self.windows = []
        self.studio = self._window()

    def _window(self):
        win = QuietStudio(True, self.session)
        win.settings["python"] = sys.executable
        self.windows.append(win)
        return win

    def _wait_until(self, predicate, timeout=3.0):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            self.app.processEvents()
            if predicate():
                return
            time.sleep(0.01)
        self.app.processEvents()
        self.assertTrue(predicate())

    def tearDown(self):
        for win in self.windows:
            win.stop()
            win.pool.shutdown(wait=True, cancel_futures=True)
        self.session.writes.shutdown(wait=True)
        self.app.processEvents()
        shutil.rmtree(self.session.data, ignore_errors=True)

    def test_nested_wikilink_and_open_tab_jump_retain_drafts_update_recent_and_invalidate_on_rename(self):
        vault = (self.studio.data / "vault").resolve()
        vault.mkdir(parents=True, exist_ok=True)
        first = vault / "First.md"
        first.write_text("# First\n\nSee [[Second Note#Architecture]]\n", encoding="utf-8")
        nested = vault / "Specs"
        nested.mkdir()
        second = nested / "Second Note.md"
        second.write_text("# Second Note\n\n## Architecture\n\nDetails.\n", encoding="utf-8")

        studio = self.studio
        studio.ready = True
        studio.settings["autosave"] = False
        replies = []
        studio.replied.connect(lambda req_id, res, err: replies.append((req_id, res, err)))

        studio.openFolder(str(vault))
        studio.openNote(str(first))
        self._wait_until(lambda: studio._current()["path"] == str(first))
        first_tab_id = studio.active
        studio.post("edit-1", "document_changed", json.dumps({"id": first_tab_id, "content": "# First (unsaved draft)\n"}))

        replies.clear()
        studio.post("link-1", "open_workspace_link", json.dumps({
            "documentPath": str(first),
            "target": "Second Note",
            "fragment": "Architecture",
            "wikilink": True,
        }))
        self._wait_until(lambda: any(r[0] == "link-1" for r in replies))
        self.assertTrue(json.loads(next(r[1] for r in replies if r[0] == "link-1"))["opened"])
        self.assertEqual(studio._current()["path"], str(second))
        self.assertEqual(studio.recent[0], str(second))

        # Jumping back to already-open First.md focuses existing tab, retains draft, and promotes recent[0]
        tab_count = len(studio.tabs)
        replies.clear()
        studio.post("link-2", "open_workspace_link", json.dumps({
            "documentPath": str(second),
            "target": "../First.md",
            "fragment": "",
            "wikilink": False,
        }))
        self._wait_until(lambda: any(r[0] == "link-2" for r in replies))
        self.assertEqual(len(studio.tabs), tab_count)
        self.assertEqual(studio.active, first_tab_id)
        self.assertEqual(studio._current()["content"], "# First (unsaved draft)\n")
        self.assertEqual(studio.recent[0], str(first))

        # Renaming Second Note invalidates workspace_links so the new name resolves immediately
        second_tab = next(t for t in studio.tabs if t["path"] == str(second))
        studio.renameNote(second_tab["id"], "Renamed Spec.md")
        renamed = nested / "Renamed Spec.md"
        self._wait_until(lambda: second_tab["path"] == str(renamed))
        replies.clear()
        studio.post("link-3", "open_workspace_link", json.dumps({
            "documentPath": str(first),
            "target": "Renamed Spec",
            "fragment": "",
            "wikilink": True,
        }))
        self._wait_until(lambda: any(r[0] == "link-3" for r in replies))
        self.assertTrue(json.loads(next(r[1] for r in replies if r[0] == "link-3"))["opened"])
        self.assertEqual(studio._current()["path"], str(renamed))


if __name__ == "__main__":
    unittest.main()
