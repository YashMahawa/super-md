"""Focused unit tests for studio_watchers guards, reconciliation, reload, and explicit collaborators."""
from __future__ import annotations

import ast, inspect, os, shutil, sys, tempfile, threading, unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
os.environ.setdefault("QT_QUICK_BACKEND", "software")

ROOT = Path(__file__).resolve().parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from PySide6.QtGui import QGuiApplication
import folder_ops, studio, studio_watchers
from documents import open_note, write_portable
from studio import Studio


class StudioWatchersUnitTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.app = QGuiApplication.instance() or QGuiApplication(["StudioWatchersUnitTests"])

    def setUp(self):
        self._raw_temp_dir = tempfile.mkdtemp(prefix="supermd-watchers-")
        self.temp_dir = Path(folder_ops.canonical_path_str(self._raw_temp_dir))

    def tearDown(self):
        shutil.rmtree(self.temp_dir, ignore_errors=True)
        shutil.rmtree(self._raw_temp_dir, ignore_errors=True)

    def test_explicit_dependencies_and_zero_studio_or_sys_modules_lookups(self):
        self.assertFalse(hasattr(studio_watchers, "_studio_module"))
        source = inspect.getsource(studio_watchers)
        self.assertNotIn("_studio" + "_module", source)
        self.assertNotIn("sys." + "modules", source)
        tree = ast.parse(source)
        imported = {
            alias.name for node in ast.walk(tree)
            if isinstance(node, (ast.Import, ast.ImportFrom)) for alias in node.names
        } | {node.module for node in ast.walk(tree) if isinstance(node, ast.ImportFrom) and node.module}
        self.assertFalse({"studio", "desktop.studio", "sys"} & imported)
        self.assertFalse([
            node for node in ast.walk(tree)
            if isinstance(node, ast.Try) and any(isinstance(sub, (ast.Import, ast.ImportFrom)) for sub in ast.walk(node))
        ])
        top_funcs = {node.name for node in tree.body if isinstance(node, ast.FunctionDef)}
        for cmp_node in (n for n in ast.walk(tree) if isinstance(n, ast.Compare)):
            for op, comp in zip(cmp_node.ops, cmp_node.comparators):
                if isinstance(op, (ast.Is, ast.IsNot)) and isinstance(comp, ast.Name):
                    self.assertNotIn(comp.id, top_funcs)

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
        tab = {
            "id": "t1", "name": "draft.md", "path": str(old_path), "content": "# Saved\n", "saved": "# Saved\n",
            "assets": {"assets/a.png": "data:image/png;base64,AA=="}, "saved_assets": {"assets/a.png": "data:image/png;base64,AA=="},
            "assets_dirty": False, "conflict": False,
        }
        session = SimpleNamespace(
            locations={str(old_path): {"top": 4}}, pinned=[str(old_path)], drafts={},
            workspace={"w1": [{"path": str(old_path)}]}, workspace_links=SimpleNamespace(invalidate=lambda folder=None: invalidated.append(folder)),
        )
        double = SimpleNamespace(
            tabs=[tab], active="t1", recent=[str(old_path)], folder="",
            note_file_stamps={str(old_path): (1, 1)}, session=session, message="",
        )

        with patch.object(studio, "folder_ops", wraps=studio.folder_ops) as spy_ops:
            Studio._location_changed(double, str(old_path), str(new_path))
        self.assertGreater(spy_ops.same_path.call_count, 0)
        st_new = new_path.stat()
        self.assertEqual((tab["path"], tab["name"]), (str(new_path), "renamed.md"))
        self.assertEqual(double.note_file_stamps, {str(new_path): (st_new.st_mtime_ns, st_new.st_size)})
        self.assertEqual(session.locations, {str(new_path): {"top": 4}})
        self.assertEqual((session.pinned, double.recent), ([str(new_path)], [str(new_path)]))
        self.assertEqual(session.workspace["w1"][0]["path"], str(new_path))

        tab["assets"] = {"assets/a.png": "data:image/png;base64,AQ=="}
        new_path.unlink()
        studio_watchers.location_changed(double, str(new_path), "")
        self.assertEqual((double.tabs, double.note_file_stamps, session.locations, session.pinned, double.recent), ([], {}, {}, [], []))
        recovered = session.drafts["deleted-notes"]
        self.assertEqual((len(recovered), recovered[0]["name"], recovered[0]["path"]), (1, "Recovered renamed.md", ""))
        self.assertEqual(recovered[0]["assets"]["assets/a.png"], "data:image/png;base64,AQ==")
        self.assertEqual(invalidated, [None, None])

    def test_studio_wrappers_forward_collaborators_for_watch_external_refresh_and_reload(self):
        smd = self.temp_dir / "note.smd"
        url_keep, url_v1, url_v2 = "data:image/svg+xml;base64,PHN2Zy8+", "data:image/png;base64,AA==", "data:image/png;base64,AQ=="
        write_portable(smd, "# V1\n", {"assets/keep.svg": url_keep, "assets/pic.png": url_v1})
        tab = {
            "id": "t1", "name": "note.smd", "path": str(smd), "content": "# V1\n", "saved": "# V1\n",
            "assets": {"assets/keep.svg": url_keep, "assets/pic.png": url_v1},
            "saved_assets": {"assets/keep.svg": url_keep, "assets/pic.png": url_v1},
            "assets_dirty": False, "portable": True, "conflict": False,
        }
        revoked, emitted, watched_added = [], [], []
        watcher = SimpleNamespace(
            files=lambda: [], directories=lambda: [],
            addPaths=lambda paths: (watched_added.extend(paths), [])[1], removePaths=lambda paths: [],
        )
        double = SimpleNamespace(
            window_id="win-1", tabs=[tab], active="t1", saving=set(), note_file_stamps={},
            folder=self.temp_dir.as_uri(), expanded=set(), recent=[], note_watcher=watcher,
            external_paths=set(), note_identities={str(smd): (9, 9)},
            session=SimpleNamespace(
                reader_assets=SimpleNamespace(revoke_tab=lambda w, t: revoked.append((w, t))),
                locationChanged=SimpleNamespace(emit=lambda o, n: None),
            ),
            _emit=lambda *a, **kw: emitted.append((a, kw)),
            _load_tree=lambda: None,
        )
        with patch.object(studio, "local_path", wraps=studio.local_path) as spy_lp:
            Studio._watch_notes(double, force=True)
            Studio._external_note_changed(double, str(smd))
        self.assertEqual(spy_lp.call_count, 2)
        self.assertIn(str(smd), watched_added)
        self.assertIn(str(self.temp_dir), watched_added)
        self.assertEqual(double.external_paths, {str(smd)})
        double.folder = str(self.temp_dir)

        write_portable(smd, "# V2\n", {"assets/keep.svg": str(url_keep), "assets/pic.png": url_v2})
        with patch.object(studio, "open_note", wraps=studio.open_note) as spy_open, patch.object(
            studio, "_preserve_unchanged_assets", wraps=studio._preserve_unchanged_assets
        ) as spy_preserve:
            Studio._reload_changed_content(double, {str(smd)})
        self.assertEqual((spy_open.call_count, spy_preserve.call_count, tab["content"], tab["assets"]["assets/pic.png"]), (1, 1, "# V2\n", url_v2))
        self.assertIs(tab["assets"]["assets/keep.svg"], url_keep)
        self.assertEqual((revoked, emitted[-1]), ([("win-1", "t1")], ((), {"load": True})))

        rec_calls = []
        with patch.object(studio, "file_events", SimpleNamespace(reconcile=lambda k, c: (rec_calls.append((k, c)), {})[1])):
            Studio._refresh_external_notes(double)
        self.assertEqual(len(rec_calls), 1)

        tab["content"] = "# Local dirty edit\n"
        write_portable(smd, "# V3 external\n", {"assets/keep.svg": url_keep, "assets/pic.png": url_v2})
        Studio._reload_changed_content(double, {str(smd)})
        self.assertEqual((tab["conflict"], tab["content"], emitted[-1]), (True, "# Local dirty edit\n", ((False,), {})))

    def test_direct_explicit_collaborator_injection_on_simplenamespace_doubles(self):
        note = self.temp_dir / "sub" / "ext.md"
        note.parent.mkdir(parents=True)
        note.write_text("# Ext\n", encoding="utf-8")
        lp_calls, id_calls, rec_calls, open_calls, preserve_calls, tree_loads, emitted_locs = [], [], [], [], [], [], []
        custom_ops = SimpleNamespace(
            same_path=folder_ops.same_path,
            matches_path_prefix=folder_ops.matches_path_prefix,
        )
        custom_fe = SimpleNamespace(
            identity=lambda p: (id_calls.append(p), (7, 7))[1],
            reconcile=lambda known, changed: (rec_calls.append((dict(known), set(changed))), {str(note): ""})[1],
        )
        tab = {
            "id": "t1", "name": "ext.md", "path": str(note), "content": "# V1\n", "saved": "# V1\n",
            "assets": {"assets/x.svg": "data:image/svg+xml;base64,PHN2Zy8+"},
            "saved_assets": {"assets/x.svg": "data:image/svg+xml;base64,PHN2Zy8+"},
            "assets_dirty": False, "portable": False, "conflict": False,
        }
        double = SimpleNamespace(
            folder=str(self.temp_dir), expanded={note.parent.as_uri()}, recent=[], tabs=[tab], active="t1",
            saving=set(), external_paths=set(), note_identities={}, note_file_stamps={},
            session=SimpleNamespace(locationChanged=SimpleNamespace(emit=lambda o, n: emitted_locs.append((o, n)))),
            _reload_changed_content=lambda changed: None,
            _load_tree=lambda: tree_loads.append(True),
        )
        custom_lp = lambda p: (lp_calls.append(p), studio_watchers._default_local_path(p))[1]
        studio_watchers.watch_notes(double, force=True, local_path_fn=custom_lp, file_events_mod=custom_fe, folder_ops_mod=custom_ops)
        self.assertEqual(double.note_identities, {str(note): (7, 7)})
        raw_note = Path(self._raw_temp_dir) / "sub" / "ext.md"
        studio_watchers.external_note_changed(double, str(raw_note), local_path_fn=custom_lp, folder_ops_mod=custom_ops)
        self.assertEqual(double.external_paths, {str(note)})
        studio_watchers.refresh_external_notes(double, file_events_mod=custom_fe, folder_ops_mod=custom_ops)
        self.assertEqual((len(rec_calls), emitted_locs, tree_loads), (1, [(str(note), "")], [True]))
        studio_watchers.refresh_external_notes(double, file_events_mod=custom_fe, folder_ops_mod=custom_ops)
        self.assertEqual((len(rec_calls), emitted_locs, tree_loads), (2, [(str(note), ""), (str(note), "")], [True, True]))

        note.write_text("# V2\n", encoding="utf-8")
        studio_watchers.reload_changed_content(
            double, {str(note)},
            open_note_fn=lambda p: (open_calls.append(p), open_note(p))[1],
            folder_ops_mod=custom_ops,
            preserve_assets_fn=lambda old, new: (preserve_calls.append((old, new)), dict(new))[1],
        )
        self.assertEqual((len(open_calls), len(preserve_calls), tab["content"]), (1, 1, "# V2\n"))
        self.assertGreaterEqual(len(lp_calls), 2)


if __name__ == "__main__":
    unittest.main()
