import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path

from unittest import mock

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
from PySide6.QtCore import QCoreApplication
from PySide6.QtGui import QGuiApplication

from studio import Session
from test_studio import QuietStudio
import workspace_links
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

    def test_case_insensitive_fs_preserves_exact_case_ranking_and_invalidates_across_case_variants(self):
        with tempfile.TemporaryDirectory() as root_dir:
            root = Path(root_dir).resolve() / "Vault"
            root.mkdir()
            archive = root / "Archive"
            archive.mkdir()
            exact_topic = archive / "Topic.md"
            exact_topic.write_text("# Exact Case Topic\n", encoding="utf-8")
            deep = root / "Specs" / "Deep"
            deep.mkdir(parents=True)
            lower_topic = deep / "topic.md"
            lower_topic.write_text("# Lowercase Topic\n", encoding="utf-8")

            # Simulate macOS APFS case-insensitive VFS lookup + Path.resolve preserving caller casing
            real_stat = Path.stat
            real_is_file = Path.is_file
            real_is_dir = Path.is_dir
            real_samefile = os.path.samefile
            real_scandir = os.scandir

            def _ci_real_target(candidate: Path) -> Path:
                parts = candidate.parts
                if not parts:
                    return candidate
                cur = Path(parts[0])
                for seg in parts[1:]:
                    exact_child = cur / seg
                    try:
                        real_stat(exact_child, follow_symlinks=False)
                        cur = exact_child
                        continue
                    except OSError:
                        pass
                    try:
                        with os.scandir(cur) as it:
                            found = next((e.name for e in it if e.name.casefold() == seg.casefold()), None)
                    except OSError:
                        found = None
                    if found is None:
                        return candidate
                    cur = cur / found
                return cur

            def fake_stat(self_path: Path, *, follow_symlinks: bool = True):
                try:
                    return real_stat(self_path, follow_symlinks=follow_symlinks)
                except OSError:
                    mapped = _ci_real_target(self_path)
                    if mapped != self_path:
                        return real_stat(mapped, follow_symlinks=follow_symlinks)
                    raise

            def fake_is_file(self_path: Path) -> bool:
                return real_is_file(self_path) or real_is_file(_ci_real_target(self_path))

            def fake_is_dir(self_path: Path) -> bool:
                return real_is_dir(self_path) or real_is_dir(_ci_real_target(self_path))

            def fake_canonicalize(path: Path) -> Path:
                mapped = _ci_real_target(path)
                if not real_is_file(mapped) and not real_is_dir(mapped):
                    path.resolve(strict=True)
                # Preserve caller's casing like POSIX realpath() on APFS when fcntl is bypassed
                return Path(os.path.abspath(os.fspath(path)))

            def fake_samefile(a, b) -> bool:
                return real_samefile(_ci_real_target(Path(a)), _ci_real_target(Path(b)))

            def fake_scandir(target_dir):
                return real_scandir(_ci_real_target(Path(target_dir)))

            cache = WorkspaceLinkCache(ttl_seconds=60.0)
            alt_case_root = root.parent / "vault"
            alt_case_note = alt_case_root / "specs" / "deep" / "topic.md"

            with (
                mock.patch.object(Path, "stat", fake_stat),
                mock.patch.object(Path, "is_file", fake_is_file),
                mock.patch.object(Path, "is_dir", fake_is_dir),
                mock.patch.object(workspace_links, "_canonicalize_existing_path", side_effect=fake_canonicalize),
                mock.patch.object(os.path, "samefile", side_effect=fake_samefile),
                mock.patch.object(os, "scandir", side_effect=fake_scandir),
            ):
                # Bare [[Topic]] must NOT match Specs/Deep/topic.md via case-insensitive stat; Archive/Topic.md wins
                resolved_wiki = resolve_workspace_link(
                    "Topic",
                    wikilink=True,
                    note_path=alt_case_note,
                    workspace_folder=alt_case_root,
                    cache=cache,
                )
                self.assertEqual(resolved_wiki.name, "Topic.md")
                self.assertEqual(resolved_wiki.parent.name, "Archive")

                # Explicit relative [Topic](Topic.md) resolves in Specs/Deep with actual on-disk filename casing
                resolved_rel = resolve_workspace_link(
                    "Topic.md",
                    wikilink=False,
                    note_path=alt_case_note,
                    workspace_folder=alt_case_root,
                    cache=cache,
                )
                self.assertEqual(resolved_rel.name, "topic.md")
                self.assertEqual(resolved_rel.parent.name, "Deep")

                # Invalidating with differently-cased folder path evicts the cached scan
                fresh_note = deep / "FreshlyAdded.md"
                fresh_note.write_text("# Fresh\n", encoding="utf-8")
                cache.invalidate(root.parent / "vAuLt")
                resolved_fresh = resolve_workspace_link(
                    "FreshlyAdded",
                    wikilink=True,
                    note_path=alt_case_note,
                    workspace_folder=root,
                    cache=cache,
                )
                self.assertEqual(resolved_fresh, fresh_note)

            # Nested directory case-only rename invalidates/refreshes within TTL even without explicit invalidate()
            live_cache = WorkspaceLinkCache(ttl_seconds=60.0)
            self.assertEqual(
                resolve_workspace_link("Topic", wikilink=True, note_path=root / "Archive" / "Topic.md", workspace_folder=root, cache=live_cache),
                exact_topic.resolve(),
            )
            # Rename Archive/Topic.md -> Archive/topic.md and Specs/Deep/topic.md -> Specs/Deep/Topic.md
            temp_archive = archive / "topic-tmp.md"
            exact_topic.rename(temp_archive)
            lower_archive = archive / "topic.md"
            temp_archive.rename(lower_archive)
            temp_deep = deep / "Topic-tmp.md"
            lower_topic.rename(temp_deep)
            upper_deep = deep / "Topic.md"
            temp_deep.rename(upper_deep)

            self.assertEqual(
                resolve_workspace_link("Topic", wikilink=True, note_path=lower_archive, workspace_folder=root, cache=live_cache),
                upper_deep.resolve(),
            )
            self.assertFalse(any(p.name.startswith(".") for p in root.rglob("*")))


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

        # Case-only rename ("Renamed Spec.md" -> "renamed spec.md") succeeds on case-insensitive & case-sensitive FS
        studio.renameNote(second_tab["id"], "renamed spec.md")
        case_renamed = nested / "renamed spec.md"
        self._wait_until(lambda: second_tab["path"] == str(case_renamed))
        self.assertEqual(second_tab["name"], "renamed spec.md")


if __name__ == "__main__":
    unittest.main()
