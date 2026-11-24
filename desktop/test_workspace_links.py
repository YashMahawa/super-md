import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
from PySide6.QtCore import QCoreApplication
from PySide6.QtGui import QGuiApplication

from documents import compressed_bundle
from studio import Session
from test_studio import QuietStudio
from workspace_links import WorkspaceLinkCache, WorkspaceLinkError, resolve_workspace_link


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


class WorkspaceLinkResolverUnitTest(unittest.TestCase):
    def test_resolves_relative_links_and_nested_wikilinks_without_writing_index_files(self):
        with tempfile.TemporaryDirectory() as root_dir:
            root = Path(root_dir)
            (root / "Index.md").write_text("# Index\n", encoding="utf-8")
            sub = root / "Research Notes"
            sub.mkdir()
            deep_md = sub / "Concept Map.md"
            deep_md.write_text("# Concept Map\n", encoding="utf-8")
            portable = sub / "Archive Bundle.smd"
            portable.write_text("# Portable\n", encoding="utf-8")
            legacy = sub / "Legacy.fmd"
            legacy.write_text("# Legacy\n", encoding="utf-8")

            cache = WorkspaceLinkCache()
            # Relative link with ./ and .. inside workspace
            self.assertEqual(
                resolve_workspace_link(
                    "./Research Notes/Concept Map.md",
                    wikilink=False,
                    note_path=root / "Index.md",
                    workspace_folder=root,
                    cache=cache,
                ),
                deep_md.resolve(),
            )
            self.assertEqual(
                resolve_workspace_link(
                    "../Index.md",
                    wikilink=False,
                    note_path=deep_md,
                    workspace_folder=root,
                    cache=cache,
                ),
                (root / "Index.md").resolve(),
            )

            # Nested wikilink basename and explicit .smd / .fmd extensions
            self.assertEqual(
                resolve_workspace_link(
                    "Concept Map",
                    wikilink=True,
                    note_path=root / "Index.md",
                    workspace_folder=root,
                    cache=cache,
                ),
                deep_md.resolve(),
            )
            self.assertEqual(
                resolve_workspace_link(
                    "Archive Bundle.smd",
                    wikilink=True,
                    note_path=root / "Index.md",
                    workspace_folder=root,
                    cache=cache,
                ),
                portable.resolve(),
            )
            self.assertEqual(
                resolve_workspace_link(
                    "Legacy.fmd",
                    wikilink=True,
                    note_path=root / "Index.md",
                    workspace_folder=root,
                    cache=cache,
                ),
                legacy.resolve(),
            )

            # Zero vault metadata or index files written anywhere in workspace
            all_names = {p.name for p in root.rglob("*")}
            self.assertEqual(
                all_names,
                {"Index.md", "Research Notes", "Concept Map.md", "Archive Bundle.smd", "Legacy.fmd"},
            )

    def test_rejects_parent_escape_symlinks_and_unsaved_draft_relative_links(self):
        with tempfile.TemporaryDirectory() as outer_dir:
            outer = Path(outer_dir)
            secret = outer / "Outside.md"
            secret.write_text("# Outside\n", encoding="utf-8")
            outside_dir = outer / "OutsideDir"
            outside_dir.mkdir()
            (outside_dir / "Hidden.md").write_text("# Hidden\n", encoding="utf-8")
            vault = outer / "Vault"
            vault.mkdir()
            note = vault / "Note.md"
            note.write_text("# Inside\n", encoding="utf-8")

            cache = WorkspaceLinkCache()

            # Reject .. escaping workspace folder
            with self.assertRaisesRegex(WorkspaceLinkError, "outside"):
                resolve_workspace_link(
                    "../Outside.md",
                    wikilink=False,
                    note_path=note,
                    workspace_folder=vault,
                    cache=cache,
                )

            # Reject .. escaping note's parent folder when no workspace folder is open
            with self.assertRaisesRegex(WorkspaceLinkError, "outside"):
                resolve_workspace_link(
                    "../Outside.md",
                    wikilink=False,
                    note_path=note,
                    workspace_folder=None,
                    cache=cache,
                )

            # Reject symlink targets and symlinked/junction directories inside workspace
            symlink_note = vault / "Symlink.md"
            if _try_create_link(symlink_note, secret, target_is_directory=False):
                with self.assertRaisesRegex(WorkspaceLinkError, "Symlink|not found"):
                    resolve_workspace_link(
                        "./Symlink.md",
                        wikilink=False,
                        note_path=note,
                        workspace_folder=vault,
                        cache=cache,
                    )
            linked_dir = vault / "LinkedDir"
            if _try_create_link(linked_dir, outside_dir, target_is_directory=True):
                with self.assertRaisesRegex(WorkspaceLinkError, "Symlink|not found"):
                    resolve_workspace_link(
                        "./LinkedDir/Hidden.md",
                        wikilink=False,
                        note_path=note,
                        workspace_folder=vault,
                        cache=cache,
                    )
                with self.assertRaisesRegex(WorkspaceLinkError, "Symlink"):
                    resolve_workspace_link(
                        "./Hidden.md",
                        wikilink=False,
                        note_path=linked_dir / "Hidden.md",
                        workspace_folder=vault,
                        cache=cache,
                    )

            # Reject relative link from unsaved draft (note_path="") with clear notice
            with self.assertRaisesRegex(WorkspaceLinkError, "Save this draft"):
                resolve_workspace_link(
                    "./Note.md",
                    wikilink=False,
                    note_path="",
                    workspace_folder=vault,
                    cache=cache,
                )

    def test_allows_os_ancestor_symlink_aliases_while_rejecting_symlinks_inside_workspace(self):
        with tempfile.TemporaryDirectory() as base_dir:
            base = Path(base_dir).resolve()
            real_var = base / "private" / "var" / "folders" / "Vault"
            real_var.mkdir(parents=True)
            alias_var = base / "var"
            if not _try_create_link(alias_var, base / "private" / "var", target_is_directory=True):
                self.skipTest("Directory symlink/junction creation unavailable on this host")

            aliased_vault = alias_var / "folders" / "Vault"
            aliased_index = aliased_vault / "Index.md"
            aliased_sub = aliased_vault / "Sub"
            aliased_sub.mkdir()
            aliased_target = aliased_sub / "Target.md"
            aliased_index.write_text("# Index\n", encoding="utf-8")
            aliased_target.write_text("# Target\n", encoding="utf-8")

            cache = WorkspaceLinkCache()
            # Uncanonicalized note_path + uncanonicalized workspace_folder (macOS /var/folders/...)
            self.assertEqual(
                resolve_workspace_link(
                    "./Sub/Target.md",
                    wikilink=False,
                    note_path=aliased_index,
                    workspace_folder=aliased_vault,
                    cache=cache,
                ),
                aliased_target.resolve(),
            )
            # Mixed uncanonicalized note_path + canonical workspace_folder
            self.assertEqual(
                resolve_workspace_link(
                    "Target",
                    wikilink=True,
                    note_path=aliased_index,
                    workspace_folder=real_var,
                    cache=cache,
                ),
                aliased_target.resolve(),
            )
            # Cache invalidation via uncanonicalized path refreshes subsequent scans
            added = aliased_sub / "Fresh.md"
            added.write_text("# Fresh\n", encoding="utf-8")
            cache.invalidate(aliased_vault)
            self.assertEqual(
                resolve_workspace_link(
                    "Fresh",
                    wikilink=True,
                    note_path=aliased_index,
                    workspace_folder=aliased_vault,
                    cache=cache,
                ),
                added.resolve(),
            )

    def test_bounded_scan_respects_file_cap_and_invalidates_cleanly(self):
        with tempfile.TemporaryDirectory() as root_dir:
            root = Path(root_dir).resolve()
            for idx in range(12):
                (root / f"Note-{idx:02d}.md").write_text(f"# {idx}\n", encoding="utf-8")
            bounded = WorkspaceLinkCache(max_files=5, ttl_seconds=60.0)
            entries = bounded.scan(root)
            self.assertEqual(len(entries), 5)

            added = root / "Note-00-New.md"
            added.write_text("# Added\n", encoding="utf-8")
            bounded.invalidate(root)
            refreshed = bounded.scan(root)
            self.assertTrue(any(item.name == "Note-00-New.md" for item in refreshed))


class StudioWorkspaceLinkIntegrationTest(unittest.TestCase):
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

    def test_following_workspace_links_opens_or_focuses_tabs_retains_edits_updates_recent_and_sends_heading(self):
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
        loads = []
        replies = []
        studio.readerLoad.connect(lambda raw: loads.append(json.loads(raw)))
        studio.replied.connect(lambda req_id, res, err: replies.append((req_id, res, err)))

        studio.openFolder(str(vault))
        studio.openNote(str(first))
        self._wait_until(lambda: studio._current()["path"] == str(first))

        # Make unsaved edits in First.md (with autosave off to verify draft retention in tab)
        studio.settings["autosave"] = False
        first_tab_id = studio.active
        studio.post(
            "edit-1",
            "document_changed",
            json.dumps({"id": first_tab_id, "content": "# First (unsaved draft edit)\n"}),
        )

        loads.clear()
        replies.clear()
        studio.post(
            "link-1",
            "open_workspace_link",
            json.dumps({
                "documentPath": str(first),
                "target": "Second Note",
                "fragment": "Architecture",
                "wikilink": True,
            }),
        )
        self._wait_until(lambda: any(r[0] == "link-1" for r in replies))
        reply = json.loads(next(r[1] for r in replies if r[0] == "link-1"))
        self.assertTrue(reply["opened"])
        self.assertEqual(studio._current()["path"], str(second))
        self.assertEqual(studio.recent[0], str(second))

        # Previous tab retained its unsaved draft!
        first_tab = next(t for t in studio.tabs if t["id"] == first_tab_id)
        self.assertEqual(first_tab["content"], "# First (unsaved draft edit)\n")

        # Emitted pendingHeading once on the initial readerLoad for Second Note
        second_loads = [item for item in loads if item["path"] == str(second)]
        self.assertGreaterEqual(len(second_loads), 1)
        self.assertEqual(second_loads[0]["pendingHeading"]["heading"], "Architecture")
        self.assertEqual(sum(1 for item in second_loads if item.get("pendingHeading")), 1)

        # Jumping back to already-open First.md focuses existing tab (no duplicate) and updates recent
        tab_count = len(studio.tabs)
        replies.clear()
        studio.post(
            "link-2",
            "open_workspace_link",
            json.dumps({
                "documentPath": str(second),
                "target": "../First.md",
                "fragment": "",
                "wikilink": False,
            }),
        )
        self._wait_until(lambda: any(r[0] == "link-2" for r in replies))
        self.assertEqual(len(studio.tabs), tab_count)
        self.assertEqual(studio.active, first_tab_id)
        self.assertEqual(studio._current()["content"], "# First (unsaved draft edit)\n")
        self.assertEqual(studio.recent[0], str(first))

    def test_unsaved_draft_and_missing_target_surface_non_destructive_messages_and_external_urls_validate_scheme(self):
        studio = self.studio
        studio.ready = True
        replies = []
        studio.replied.connect(lambda req_id, res, err: replies.append((req_id, res, err)))

        # Unsaved draft clicking a relative link
        studio.newNote()
        draft_id = studio.active
        studio.post("draft-edit", "document_changed", json.dumps({"id": draft_id, "content": "Keep my draft"}))
        studio.post(
            "unsaved-rel",
            "open_workspace_link",
            json.dumps({
                "documentPath": draft_id,
                "target": "./Other.md",
                "fragment": "",
                "wikilink": False,
            }),
        )
        self._wait_until(lambda: any(r[0] == "unsaved-rel" for r in replies))
        self.assertIn("Save this draft", studio.message)
        self.assertEqual(studio._current()["content"], "Keep my draft")

        # External URL opens only http/https/mailto and never local paths
        with patch("studio.QDesktopServices.openUrl", return_value=True) as open_url:
            studio.post("ext-ok", "open_external_url", json.dumps({"url": "mailto:hello@example.org"}))
            self.assertEqual(open_url.call_count, 1)
            studio.post("ext-bad", "open_external_url", json.dumps({"url": "file:///etc/passwd"}))
            self.assertEqual(open_url.call_count, 1)
        bad_reply = next(r for r in replies if r[0] == "ext-bad")
        self.assertIn("Unsupported external URL scheme", bad_reply[2])

    def test_opens_portable_smd_bundles_noncanonical_doc_refs_and_rejects_bookmark_aliases(self):
        vault = (self.studio.data / "portable-vault").resolve()
        vault.mkdir(parents=True, exist_ok=True)
        index_note = vault / "Index.md"
        index_note.write_text("# Index\n\n- [Deck](sub/study.smd#key-theorem)\n", encoding="utf-8")
        sub = vault / "sub"
        sub.mkdir()
        portable_smd = sub / "study.smd"
        portable_smd.write_bytes(
            compressed_bundle("# Portable Deck\n\n## Key Theorem\n\nProof body.\n", {})
        )

        if os.name == "posix" and hasattr(os, "getxattr"):
            bookmark_alias = vault / "AliasNote.md"
            bookmark_alias.write_bytes(b"book\x00\x00\x00\x00mark\x00\x00\x00\x00# Hidden\n")
            with self.assertRaisesRegex(WorkspaceLinkError, "Symlink|not found"):
                resolve_workspace_link(
                    "AliasNote.md",
                    wikilink=False,
                    note_path=index_note,
                    workspace_folder=vault,
                    cache=self.session.workspace_links,
                )

        studio = self.studio
        studio.ready = True
        loads = []
        replies = []
        studio.readerLoad.connect(lambda raw: loads.append(json.loads(raw)))
        studio.replied.connect(lambda req_id, res, err: replies.append((req_id, res, err)))

        studio.openFolder(str(vault))
        studio.openNote(str(index_note))
        self._wait_until(lambda: studio._current()["path"] == str(index_note))

        noncanonical_ref = str(index_note)
        alias_root = self.studio.data / "vault-alias"
        if _try_create_link(alias_root, vault, target_is_directory=True):
            noncanonical_ref = str(alias_root / index_note.name)

        loads.clear()
        replies.clear()
        studio.post(
            "portable-link",
            "open_relative_note",
            json.dumps({
                "documentPath": noncanonical_ref,
                "target": "sub/study.smd",
                "heading": "key-theorem",
            }),
        )
        self._wait_until(lambda: any(r[0] == "portable-link" for r in replies))
        reply = json.loads(next(r[1] for r in replies if r[0] == "portable-link"))
        self.assertTrue(reply["opened"])
        self.assertEqual(studio._current()["path"], str(portable_smd))
        self.assertTrue(studio._current()["portable"])
        self.assertIn("# Portable Deck", studio._current()["content"])
        portable_loads = [item for item in loads if item["path"] == str(portable_smd)]
        self.assertEqual(portable_loads[0]["pendingHeading"]["heading"], "key-theorem")


if __name__ == "__main__":
    unittest.main()
