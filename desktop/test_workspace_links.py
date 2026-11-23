import json
import os
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
from PySide6.QtGui import QGuiApplication

from studio import Session
from test_studio import QuietStudio
from workspace_links import WorkspaceLinkCache, WorkspaceLinkError, resolve_workspace_link


class WorkspaceLinkResolverUnitTest(unittest.TestCase):
    def test_resolves_relative_links_and_nested_wikilinks_without_writing_index_files(self):
        with tempfile.TemporaryDirectory() as root_dir:
            root = Path(root_dir)
            (root / "Index.md").write_text("# Index\n")
            sub = root / "Research Notes"
            sub.mkdir()
            deep_md = sub / "Concept Map.md"
            deep_md.write_text("# Concept Map\n")
            portable = sub / "Archive Bundle.smd"
            portable.write_text("# Portable\n")
            legacy = sub / "Legacy.fmd"
            legacy.write_text("# Legacy\n")

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
            secret.write_text("# Outside\n")
            vault = outer / "Vault"
            vault.mkdir()
            note = vault / "Note.md"
            note.write_text("# Inside\n")
            symlink_note = vault / "Symlink.md"
            symlink_note.symlink_to(secret)

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

            # Reject symlink targets and symlinked directories
            with self.assertRaisesRegex(WorkspaceLinkError, "Symlink|not found"):
                resolve_workspace_link(
                    "./Symlink.md",
                    wikilink=False,
                    note_path=note,
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

    def test_bounded_scan_respects_file_cap_and_invalidates_cleanly(self):
        with tempfile.TemporaryDirectory() as root_dir:
            root = Path(root_dir).resolve()
            for idx in range(12):
                (root / f"Note-{idx:02d}.md").write_text(f"# {idx}\n")
            bounded = WorkspaceLinkCache(max_files=5, ttl_seconds=60.0)
            entries = bounded.scan(root)
            self.assertEqual(len(entries), 5)

            added = root / "Note-00-New.md"
            added.write_text("# Added\n")
            bounded.invalidate(root)
            refreshed = bounded.scan(root)
            self.assertTrue(any(item.name == "Note-00-New.md" for item in refreshed))


class StudioWorkspaceLinkIntegrationTest(unittest.TestCase):
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

    def test_following_workspace_links_opens_or_focuses_tabs_retains_edits_updates_recent_and_sends_heading(self):
        with tempfile.TemporaryDirectory() as vault_dir:
            vault = Path(vault_dir)
            first = vault / "First.md"
            first.write_text("# First\n\nSee [[Second Note#Architecture]]\n")
            nested = vault / "Specs"
            nested.mkdir()
            second = nested / "Second Note.md"
            second.write_text("# Second Note\n\n## Architecture\n\nDetails.\n")

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


if __name__ == "__main__":
    unittest.main()
