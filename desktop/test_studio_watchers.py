"""Focused unit tests for studio_watchers guards, reconciliation, reload, and SimpleNamespace doubles."""
from __future__ import annotations

import os, shutil, sys, tempfile, threading, unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
os.environ.setdefault("QT_QUICK_BACKEND", "software")

ROOT = Path(__file__).resolve().parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from PySide6.QtGui import QGuiApplication
import studio, studio_watchers
from documents import write_portable


class StudioWatchersUnitTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.app = QGuiApplication.instance() or QGuiApplication(["StudioWatchersUnitTests"])

    def setUp(self):
        self.temp_dir = Path(tempfile.mkdtemp(prefix="supermd-watchers-"))

    def tearDown(self):
        shutil.rmtree(self.temp_dir, ignore_errors=True)

    def test_stopped_file_watcher_rebound_and_noop_methods(self):
        sentinel = studio_watchers._STOPPED_WATCHER
        self.assertIs(studio._STOPPED_WATCHER, sentinel)
        self.assertIs(studio._StoppedFileWatcher, studio_watchers._StoppedFileWatcher)
        self.assertEqual((sentinel.files(), sentinel.directories()), ([], []))
        self.assertFalse(sentinel.addPath("/tmp/a.md") or sentinel.removePath("/tmp/a.md"))
        self.assertEqual(sentinel.addPaths(("/tmp/a.md", "/tmp/b.md")), ["/tmp/a.md", "/tmp/b.md"])
        self.assertEqual(sentinel.removePaths(("/tmp/a.md",)), ["/tmp/a.md"])

    def test_matches_watch_suspension_distinguishes_path_vs_watch_target_parent(self):
        parent = str(self.temp_dir / "notes")
        old_file, new_file = str(Path(parent) / "old.md"), str(Path(parent) / "new.md")
        ev = threading.Event()
        susp = [(old_file, parent, False, ev, new_file)]
        double = SimpleNamespace(session=SimpleNamespace(_watch_suspensions=susp))
        self.assertFalse(studio_watchers._matches_watch_suspension("", susp, include_parent=True))
        self.assertTrue(studio_watchers.is_path_suspended(double, old_file))
        self.assertTrue(studio_watchers.is_path_suspended(double, new_file))
        self.assertFalse(studio_watchers.is_path_suspended(double, parent))
        self.assertTrue(studio_watchers.is_watch_target_suspended(double, parent))
        ev.set()
        self.assertFalse(studio_watchers.is_watch_target_suspended(double, old_file))

    def test_has_session_path_reference_checks_all_live_stores_and_skips_retired_windows(self):
        paths = [str(self.temp_dir / f"n{i}.md") for i in range(7)]
        double = SimpleNamespace(
            note_identities={paths[0]: (1, 1)}, recent=[paths[2]],
            session=SimpleNamespace(
                pinned=[paths[1]], locations={paths[3]: {"top": 2}},
                windows={"r": SimpleNamespace(retired=True, tabs=[{"path": paths[4]}]), "l": SimpleNamespace(retired=False, tabs=[{"path": paths[5]}])},
                workspace={"w": [{"path": paths[6]}]},
            ),
        )
        for idx in (0, 1, 2, 3, 5, 6):
            self.assertTrue(studio_watchers.has_session_path_reference(double, paths[idx]))
        self.assertFalse(studio_watchers.has_session_path_reference(double, paths[4]))
        self.assertFalse(studio_watchers.has_session_path_reference(double, ""))

    def test_location_changed_rename_and_delete_recover_dirty_draft_and_invalidate_links(self):
        old_path, new_path = self.temp_dir / "draft.md", self.temp_dir / "renamed.md"
        new_path.write_text("# Saved\n", encoding="utf-8")
        invalidated: list[str | None] = []
        tab = {"id": "t1", "name": "draft.md", "path": str(old_path), "content": "# Saved\n", "saved": "# Saved\n", "conflict": False}
        session = SimpleNamespace(
            locations={str(old_path): {"top": 4}}, pinned=[str(old_path)], drafts={},
            workspace={"w1": [{"path": str(old_path)}]}, workspace_links=SimpleNamespace(invalidate=lambda folder=None: invalidated.append(folder)),
        )
        double = SimpleNamespace(
            tabs=[tab], active="t1", recent=[str(old_path)], folder="",
            note_file_stamps={str(old_path): (1, 1)}, session=session, message="",
        )

        studio_watchers.location_changed(double, str(old_path), str(new_path))
        st_new = new_path.stat()
        self.assertEqual((tab["path"], tab["name"]), (str(new_path), "renamed.md"))
        self.assertEqual(double.note_file_stamps, {str(new_path): (st_new.st_mtime_ns, st_new.st_size)})
        self.assertEqual(session.locations, {str(new_path): {"top": 4}})
        self.assertEqual((session.pinned, double.recent), ([str(new_path)], [str(new_path)]))
        self.assertEqual(session.workspace["w1"][0]["path"], str(new_path))

        tab["content"] = "# Unsaved local work\n"
        new_path.unlink()
        studio_watchers.location_changed(double, str(new_path), "")
        self.assertEqual((double.tabs, double.note_file_stamps, session.locations, session.pinned, double.recent), ([], {}, {}, [], []))
        recovered = session.drafts["deleted-notes"]
        self.assertEqual((len(recovered), recovered[0]["name"], recovered[0]["path"]), (1, "Recovered renamed.md", ""))
        self.assertEqual(recovered[0]["content"], "# Unsaved local work\n")
        self.assertEqual(invalidated, [None, None])

    def test_reload_changed_content_clean_reload_asset_revocation_conflict_and_monkeypatches(self):
        smd = self.temp_dir / "note.smd"
        url_keep, url_v1, url_v2 = "data:image/svg+xml;base64,PHN2Zy8+", "data:image/png;base64,AA==", "data:image/png;base64,AQ=="
        write_portable(smd, "# V1\n", {"assets/keep.svg": url_keep, "assets/pic.png": url_v1})
        tab = {
            "id": "t1", "name": "note.smd", "path": str(smd), "content": "# V1\n", "saved": "# V1\n",
            "assets": {"assets/keep.svg": url_keep, "assets/pic.png": url_v1},
            "saved_assets": {"assets/keep.svg": url_keep, "assets/pic.png": url_v1},
            "assets_dirty": False, "portable": True, "conflict": False,
        }
        revoked, emitted = [], []
        double = SimpleNamespace(
            window_id="win-1", tabs=[tab], active="t1", saving=set(), note_file_stamps={},
            session=SimpleNamespace(reader_assets=SimpleNamespace(revoke_tab=lambda w, t: revoked.append((w, t)))),
            _emit=lambda *a, **kw: emitted.append((a, kw)),
        )
        write_portable(smd, "# V2\n", {"assets/keep.svg": str(url_keep), "assets/pic.png": url_v2})
        with patch.object(studio, "open_note", wraps=studio.open_note) as spy_open:
            studio_watchers.reload_changed_content(double, {str(smd)})
        self.assertEqual((spy_open.call_count, tab["content"], tab["assets"]["assets/pic.png"]), (1, "# V2\n", url_v2))
        self.assertIs(tab["assets"]["assets/keep.svg"], url_keep)
        self.assertEqual((revoked, emitted[-1]), ([("win-1", "t1")], ((), {"load": True})))

        tab["content"] = "# Local dirty edit\n"
        write_portable(smd, "# V3 external\n", {"assets/keep.svg": url_keep, "assets/pic.png": url_v2})
        studio_watchers.reload_changed_content(double, {str(smd)})
        self.assertEqual((tab["conflict"], tab["content"], emitted[-1]), (True, "# Local dirty edit\n", ((False,), {})))

    def test_external_changed_and_refresh_honor_studio_local_path_file_events_and_submit_patches(self):
        note = self.temp_dir / "sub" / "ext.md"
        note.parent.mkdir(parents=True)
        note.write_text("# Ext\n", encoding="utf-8")
        emitted_locs, submitted, tree_loads = [], [], []
        double = SimpleNamespace(
            folder=str(self.temp_dir), external_paths=set(), note_identities={str(note): (9, 9)}, tabs=[{"path": str(note)}],
            session=SimpleNamespace(locationChanged=SimpleNamespace(emit=lambda o, n: emitted_locs.append((o, n)))),
            _reload_changed_content=lambda changed: None,
            _load_tree=lambda: tree_loads.append(True),
            _submit=lambda action, done, busy=True: (submitted.append(busy), done(action(), None)),
        )
        with patch.object(studio, "local_path", side_effect=lambda p: Path(p)):
            studio_watchers.external_note_changed(double, str(note))
        self.assertEqual(double.external_paths, {str(note)})
        with patch.object(studio.file_events, "reconcile", return_value={str(note): ""}) as spy_rec:
            studio_watchers.refresh_external_notes(double)
        self.assertEqual((spy_rec.call_count, submitted, emitted_locs, tree_loads), (1, [False], [(str(note), "")], [True]))


if __name__ == "__main__":
    unittest.main()
