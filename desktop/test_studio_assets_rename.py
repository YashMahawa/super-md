"""Focused unit tests for unified rename pipelines and portable .smd asset-staging helpers."""
from __future__ import annotations
import ast, base64, hashlib, inspect, os, shutil, sys, tempfile, time, unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
os.environ.setdefault("QT_QUICK_BACKEND", "software")

ROOT = Path(__file__).resolve().parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from PySide6.QtCore import QEvent, QObject
from PySide6.QtGui import QGuiApplication
import documents, folder_ops, studio, studio_assets_rename, studio_portable_assets
from documents import open_note, write_portable
from studio import Session, Studio

PNG_1X1 = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAX+XDSwAAAABJRU5ErkJggg=="
)
SVG_V1 = b"<svg xmlns='http://www.w3.org/2000/svg'><circle r='4'/></svg>"
SVG_V2 = b"<svg xmlns='http://www.w3.org/2000/svg'><rect width='10' height='10'/></svg>"


class QuietStudio(Studio):
    def _refresh_theme(self):
        self.system_dark = True


class MinimalQtStudio(QObject):
    """Lightweight QObject without folder/settings/session attributes, matching QtStudio test doubles."""
    def __init__(self, tabs: list[dict], active: str):
        super().__init__()
        self.tabs, self.active = tabs, active


class StudioAssetsRenameUnitTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.app = QGuiApplication.instance() or QGuiApplication(["StudioAssetsRenameUnitTests"])

    def setUp(self):
        self.temp_dir = Path(folder_ops.canonical_path_str(tempfile.mkdtemp(prefix="supermd-assets-rename-")))
        self.open_root, self.outside_root = self.temp_dir / "workspace", self.temp_dir / "outside"
        self.open_root.mkdir()
        self.outside_root.mkdir()
        self.session = Session(isolated=True)
        self.studio = QuietStudio(True, self.session)

    def tearDown(self):
        self.studio.stop()
        self.studio.pool.shutdown(wait=True, cancel_futures=True)
        self.session.writes.shutdown(wait=True)
        self.studio.deleteLater()
        self.app.sendPostedEvents(None, QEvent.Type.DeferredDelete)
        self.app.processEvents()
        shutil.rmtree(self.session.data, ignore_errors=True)
        shutil.rmtree(self.temp_dir, ignore_errors=True)

    def _wait_for(self, predicate, timeout: float = 5.0):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            self.app.processEvents()
            if predicate():
                return
            time.sleep(0.01)
        self.app.processEvents()
        self.assertTrue(predicate(), "Timed out waiting for condition")

    @staticmethod
    def _rev(text: str) -> str:
        return hashlib.sha256(text.encode("utf-8")).hexdigest()

    def test_explicit_dependencies_and_zero_studio_or_sys_modules_lookups(self):
        for module in (studio_assets_rename, studio_portable_assets):
            self.assertFalse(hasattr(module, "_studio_module"))
            source = inspect.getsource(module)
            self.assertNotIn("sys.modules", source)
            tree = ast.parse(source)
            imported = {
                alias.name for node in ast.walk(tree)
                if isinstance(node, (ast.Import, ast.ImportFrom)) for alias in node.names
            } | {node.module for node in ast.walk(tree) if isinstance(node, ast.ImportFrom) and node.module}
            self.assertFalse({"studio", "desktop.studio", "sys"} & imported)
            top_funcs = {node.name for node in tree.body if isinstance(node, ast.FunctionDef)}
            for cmp_node in (n for n in ast.walk(tree) if isinstance(n, ast.Compare)):
                for op, comp in zip(cmp_node.ops, cmp_node.comparators):
                    if isinstance(op, (ast.Is, ast.IsNot)) and isinstance(comp, ast.Name):
                        self.assertNotIn(comp.id, top_funcs)

    def test_rename_entry_pipeline_handles_folder_note_samestat_links_and_watcher_restore(self):
        sub = self.open_root / "Drafts"
        sub.mkdir()
        note_path, rival_path = sub / "topic.md", sub / "existing.md"
        note_path.write_text("# Topic\n", encoding="utf-8")
        rival_path.write_text("# Existing\n", encoding="utf-8")

        self.studio.openFolder(str(self.open_root))
        self.studio.openNote(str(note_path))
        canon_note = folder_ops.canonical_path_str(note_path)
        self._wait_for(lambda: folder_ops.same_path(self.studio._current()["path"], canon_note))

        self.studio.saving.add(self.studio.active)
        self.studio.renameEntry(str(note_path), "blocked")
        self.assertEqual(self.studio.message, "Wait for the current save to finish.")
        self.studio.saving.clear()

        self.studio.message = ""
        self.studio._staging_tabs.add(self.studio.active)
        self.studio.renameEntry(str(note_path), "blocked-staging")
        self.assertEqual(self.studio.message, "Wait for the current save to finish.")
        self.studio._staging_tabs.clear()

        watch_calls: list[bool] = []
        orig_watch = self.studio._watch_notes
        with patch.object(self.studio, "_watch_notes", wraps=lambda force=False: (watch_calls.append(force), orig_watch(force=force))[1]):
            self.studio.renameEntry(str(note_path), "existing")
            self._wait_for(lambda: self.studio.busy == 0 and self.studio.message == "An item with that name already exists.")
        self.assertIn(True, watch_calls)
        self.assertIsNotNone(self.studio.note_watch_paths)

        with patch.object(folder_ops, "_is_link_or_junction", side_effect=lambda p: Path(p).name == "linked.md"):
            self.studio.renameEntry(str(note_path), "linked")
            self._wait_for(lambda: self.studio.busy == 0 and self.studio.message == "Symlinks are not allowed inside the open folder.")
        self.assertIsNotNone(self.studio.note_watch_paths)

        orig_exists, orig_stat = Path.exists, Path.stat
        case_target = sub / "Topic.md"
        with (
            patch.object(Path, "exists", lambda p, *a, **kw: True if p == case_target else orig_exists(p, *a, **kw)),
            patch.object(Path, "stat", lambda p, *a, **kw: orig_stat(note_path if p == case_target else p, *a, **kw)),
            patch("studio_assets_rename.os.path.samestat", wraps=os.path.samestat) as spy_samestat,
        ):
            self.studio.renameEntry(str(note_path), "Topic")
            self._wait_for(lambda: self.studio.busy == 0 and self.studio.message == "Renamed to Topic.md")
        self.assertGreaterEqual(spy_samestat.call_count, 1)

        self.studio.renameEntry(str(sub), "Published")
        renamed_note = folder_ops.canonical_path_str(self.open_root / "Published" / "Topic.md")
        self._wait_for(
            lambda: self.studio.busy == 0
            and folder_ops.same_path(self.studio._current()["path"], renamed_note)
            and self.studio.message == "Renamed to Published"
        )

    def test_rename_note_outside_folder_untitled_samestat_collision_and_watcher_restore(self):
        untitled = self.studio._current()
        self.assertEqual(untitled["path"], "")
        original_name = untitled["name"]
        self.studio._staging_tabs.add(untitled["id"])
        self.studio.renameNote(untitled["id"], "Blocked By Staging")
        self.assertEqual(untitled["name"], original_name)
        self.studio._staging_tabs.clear()
        self.studio.renameNote(untitled["id"], "Scratch Pad")
        self.assertEqual(untitled["name"], "Scratch Pad.md")

        standalone, collision = self.outside_root / "lecture.md", self.outside_root / "taken.md"
        standalone.write_text("# Lecture\n", encoding="utf-8")
        collision.write_text("# Taken\n", encoding="utf-8")

        self.studio.openNote(str(standalone))
        canon_standalone = folder_ops.canonical_path_str(standalone)
        self._wait_for(lambda: folder_ops.same_path(self.studio._current()["path"], canon_standalone))
        tab_id = self.studio.active

        watch_restores: list[bool] = []
        orig_watch = self.studio._watch_notes
        with patch.object(self.studio, "_watch_notes", wraps=lambda force=False: (watch_restores.append(force), orig_watch(force=force))[1]):
            self.studio.renameNote(tab_id, "taken")
            self._wait_for(lambda: self.studio.busy == 0 and self.studio.message == "A file with that name already exists.")
        self.assertIn(True, watch_restores)
        self.assertIsNotNone(self.studio.note_watch_paths)

        with patch.object(folder_ops, "_is_link_or_junction", side_effect=lambda p: Path(p).name == "badlink.md"):
            self.studio.renameNote(tab_id, "badlink")
            self._wait_for(lambda: self.studio.busy == 0 and self.studio.message == "Symlinks are not allowed.")

        orig_exists, orig_stat = Path.exists, Path.stat
        case_after = self.outside_root / "Lecture.md"
        with (
            patch.object(Path, "exists", lambda p, *a, **kw: True if p == case_after else orig_exists(p, *a, **kw)),
            patch.object(Path, "stat", lambda p, *a, **kw: orig_stat(standalone if p == case_after else p, *a, **kw)),
            patch("studio_assets_rename.os.path.samestat", wraps=os.path.samestat) as spy_samestat,
        ):
            self.studio.renameNote(tab_id, "Lecture")
            self._wait_for(
                lambda: self.studio.busy == 0
                and self.studio.message == "Renamed to Lecture.md"
                and self.studio._current()["name"] == "Lecture.md"
            )
        self.assertGreaterEqual(spy_samestat.call_count, 1)

    def test_portable_asset_staging_conflicts_dirty_noop_patches_and_unbound_proxies(self):
        smd_path = self.open_root / "study.smd"
        markdown = "# Portable Study\n\n![Diag](assets/diagram.svg)\n"
        initial_url = "data:image/svg+xml;base64," + base64.b64encode(SVG_V1).decode("ascii")
        write_portable(smd_path, markdown, {"assets/diagram.svg": initial_url})

        same_svg, next_svg = self.open_root / "same.svg", self.open_root / "next.svg"
        same_svg.write_bytes(SVG_V1)
        next_svg.write_bytes(SVG_V2)

        rev = self._rev(markdown)
        tab = {
            "id": "tab-1", "name": smd_path.name, "path": str(smd_path), "content": markdown,
            "saved": markdown, "portable": True,
            "assets": {"assets/diagram.svg": initial_url},
            "saved_assets": {"assets/diagram.svg": initial_url},
        }
        revoked: list[tuple[str, str]] = []
        proxy = SimpleNamespace(
            tabs=[tab], active="tab-1",
            session=SimpleNamespace(reader_assets=SimpleNamespace(revoke_tab=lambda wid, tid: revoked.append((wid, tid)))),
        )

        tab["content"] = markdown + "\nUnsaved edit\n"
        dirty_rev = self._rev(tab["content"])
        with self.assertRaisesRegex(ValueError, "Save the note before attaching a portable asset"):
            Studio._attach_tab_asset_native(proxy, {
                "tabId": "tab-1", "expectedRevision": dirty_rev,
                "mimeType": "image/png", "body": base64.b64encode(PNG_1X1).decode("ascii"), "assetName": "dot.png",
            })
        with self.assertRaisesRegex(ValueError, "Save the note before replacing a portable asset"):
            Studio._replace_tab_asset_native(proxy, {
                "tabId": "tab-1", "expectedRevision": dirty_rev,
                "assetName": "assets/diagram.svg", "assetPath": str(next_svg),
            })
        tab["content"] = markdown

        asset_sha_id = hashlib.sha256(b"assets/diagram.svg").hexdigest()
        with patch("studio.write_portable", side_effect=AssertionError("must not rewrite unchanged asset")):
            noop = Studio._replace_tab_asset_native(proxy, {
                "tabId": "tab-1", "expectedRevision": rev, "assetName": asset_sha_id, "assetPath": str(same_svg),
            })
        self.assertEqual((noop["changed"], noop["saved"], noop["assetName"]), (False, False, "assets/diagram.svg"))
        self.assertEqual(revoked, [])

        qt_double = MinimalQtStudio([tab], "tab-1")
        for over_cap_name in ("a" * 147, "a" * 147 + ".png"):
            with self.assertRaisesRegex(ValueError, "Asset name must be a simple filename"):
                studio_portable_assets.attach_tab_asset_native(qt_double, {
                    "tabId": "tab-1", "expectedRevision": rev,
                    "mimeType": "image/png", "body": base64.b64encode(PNG_1X1).decode("ascii"), "assetName": over_cap_name,
                })
        self.assertEqual(
            studio_portable_assets.extra_asset_roots(SimpleNamespace(folder=str(self.open_root), settings={"newNoteLocation": str(self.outside_root)})),
            [self.open_root, self.outside_root],
        )
        write_calls: list[Path] = []
        sig_checks: list[str | None] = []
        validated_paths: list[str] = []
        real_write_portable = documents.write_portable
        real_sig = studio._matches_media_signature
        real_validate = studio._validate_local_tab_asset_path
        with (
            patch("studio.write_portable", side_effect=lambda p, md, a: (write_calls.append(Path(p)), real_write_portable(p, md, a))[1]),
            patch("studio._matches_media_signature", side_effect=lambda mime, raw: (sig_checks.append(mime), real_sig(mime, raw))[1]),
            patch("studio._validate_local_tab_asset_path", side_effect=lambda raw_p, *a, **kw: (validated_paths.append(str(raw_p)), real_validate(raw_p, *a, **kw))[1]),
        ):
            attached = Studio._attach_tab_asset_native(qt_double, {
                "tabId": "tab-1", "expectedRevision": rev,
                "mimeType": "image/png", "body": base64.b64encode(PNG_1X1).decode("ascii"), "assetName": "pixel",
            })
            replaced = Studio._replace_tab_asset_native(qt_double, {
                "tabId": "tab-1", "expectedRevision": rev, "assetName": asset_sha_id, "assetPath": str(next_svg),
            })
        self.assertEqual(attached["assetName"], "assets/pixel.png")
        self.assertTrue(replaced["changed"] and replaced["saved"])
        self.assertEqual(write_calls, [smd_path, smd_path])
        self.assertEqual(sig_checks, ["image/png", "image/svg+xml"])
        self.assertEqual(validated_paths, [str(next_svg)])

        direct_attached = studio_portable_assets.attach_tab_asset_native(proxy, {
            "tabId": "tab-1", "expectedRevision": rev,
            "mimeType": "image/png", "body": base64.b64encode(PNG_1X1).decode("ascii"), "assetName": "direct",
        })
        self.assertEqual(direct_attached["assetName"], "assets/direct.png")
        self.assertEqual(len(revoked), 1)

        write_portable(smd_path, markdown + "\nExternal modification\n", tab["saved_assets"])
        with self.assertRaisesRegex(ValueError, "The portable note changed on disk; reopen it before attaching an asset"):
            Studio._attach_tab_asset_native(qt_double, {
                "tabId": "tab-1", "expectedRevision": rev,
                "mimeType": "image/png", "body": base64.b64encode(PNG_1X1).decode("ascii"), "assetName": "extra.png",
            })
        with self.assertRaisesRegex(ValueError, "The portable note changed on disk; reopen it before replacing an asset"):
            Studio._replace_tab_asset_native(qt_double, {
                "tabId": "tab-1", "expectedRevision": rev,
                "assetName": "assets/diagram.svg", "assetPath": str(same_svg),
            })

        self.studio.openFolder(str(self.open_root))
        self._wait_for(lambda: folder_ops.same_path(self.studio.folder, self.open_root))
        real_atomic_write = documents.atomic_write
        atomic_calls: list[Path] = []
        invalidations: list[object] = []
        orig_invalidate = self.session.workspace_links.invalidate
        with (
            patch("studio.atomic_write", side_effect=lambda p, data: (atomic_calls.append(Path(p)), real_atomic_write(p, data))[1]),
            patch.object(self.session.workspace_links, "invalidate", side_effect=lambda root=None: (invalidations.append(root), orig_invalidate(root))[1]),
        ):
            self.studio.createFolderNote(str(self.open_root), "Patched Note", "md")
            self._wait_for(lambda: self.studio.busy == 0 and (self.open_root / "Patched Note.md").is_file())
            self.studio.createSubfolder(str(self.open_root), "Subfolder")
            self._wait_for(
                lambda: self.studio.busy == 0
                and (self.open_root / "Subfolder").is_dir()
                and any(item["name"] == "Subfolder" for item in self.studio.files)
            )
            self.studio.renameEntry(str(self.open_root / "Subfolder"), "RenamedSub")
            self._wait_for(
                lambda: self.studio.busy == 0
                and (self.open_root / "RenamedSub").is_dir()
                and any(item["name"] == "RenamedSub" for item in self.studio.files)
            )
        self.assertEqual(invalidations, [self.studio.folder, self.studio.folder, None])
        self.assertIn((self.open_root / "Patched Note.md").resolve(), [p.resolve() for p in atomic_calls])
        search_restarts: list[str] = []
        seeded_win = SimpleNamespace(
            retired=False, tabs=[], folder=str(self.open_root), expanded=set(), _pinned_visible_dirs=set(),
            _agent_open_paths=set(), _agent_owned_files=set(),
            _folder_search_open=True, _folder_search_query="topic", _folder_search_pending=True,
            _start_folder_search=lambda: search_restarts.append("started"),
            _pending_seeded_find={"path": str(self.open_root / "a.md"), "sourceStart": 10, "sourceEnd": 15, "matchText": "topic"},
            _watch_notes=lambda force=False: None, _recover=lambda: None, _load_tree=lambda: None, _emit=lambda *a: None,
        )
        lightweight = SimpleNamespace(
            folder=str(self.open_root), tabs=[], recent=[], active="", settings={}, message="", _activation_generation=0,
            _agent_open_paths=set(), _agent_owned_files=set(), writes=None,
            session=SimpleNamespace(windows={"w1": seeded_win}, locations={}, pinned=[], workspace={}, startup_paths=[], startup_active="", startup_entries=[]),
            _save_positions=lambda: None, _preferences=lambda notify=True: None, _watch_notes=lambda force=False: None,
            recovery_timer=SimpleNamespace(start=lambda _ms: None), _emit=lambda *a: None, _focus_open_target=lambda _g: None,
            _note=lambda *a: {"id": "n1"}, _submit=lambda work, done, executor=None: done(work(), None),
        )
        studio_assets_rename.sync_path_change(lightweight, str(self.open_root / "a.md"), str(self.open_root / "b.md"), is_dir=False, message="Moved")
        self.assertEqual(search_restarts, [])
        canon_b = folder_ops.canonical_path_str(self.open_root / "b.md")
        self.assertEqual(
            seeded_win._pending_seeded_find,
            {"path": canon_b, "sourceStart": 10, "sourceEnd": 15, "matchText": "topic"},
        )
        seeded_win._folder_search_pending = False
        short_root = self.temp_dir / "RUNNER~1" / "workspace"
        short_prefix, canon_prefix = str(short_root), str(self.open_root)
        seeded_win._pending_seeded_find = {"path": str(short_root / "a.md"), "sourceStart": 2, "sourceEnd": 7, "matchText": "alias"}
        orig_realpath = folder_ops.os.path.realpath
        with patch.object(
            folder_ops.os.path,
            "realpath",
            side_effect=lambda p: orig_realpath(canon_prefix + str(p)[len(short_prefix):]) if str(p).startswith(short_prefix) else orig_realpath(p),
        ):
            studio_assets_rename.sync_path_change(lightweight, str(short_root / "a.md"), str(short_root / "b.md"), is_dir=False, message="Moved")
        self.assertEqual(search_restarts, ["started"])
        self.assertEqual(
            seeded_win._pending_seeded_find,
            {"path": canon_b, "sourceStart": 2, "sourceEnd": 7, "matchText": "alias"},
        )
        studio_assets_rename.create_subfolder(lightweight, str(self.open_root), "DoubleSub")
        studio_assets_rename.create_folder_note(lightweight, str(self.open_root), "DoubleNote", "md")
        self.assertTrue((self.open_root / "DoubleSub").is_dir() and (self.open_root / "DoubleNote.md").is_file())
        src_retry, dst_retry = self.open_root / "DoubleNote.md", self.open_root / "RetriedNote.md"
        real_rename, attempts = Path.rename, []

        def flaky_win_rename(p, target):
            attempts.append(p)
            if len(attempts) == 1:
                err = PermissionError("sharing violation")
                err.winerror = 32
                raise err
            return real_rename(p, target)

        with patch("studio._is_windows", return_value=True), patch.object(Path, "rename", flaky_win_rename):
            evt = self.studio._hold_watches_for_rename(str(src_retry), is_dir=False, new_path=str(dst_retry))
            self.assertFalse(evt.is_set())
            self.assertEqual(len(self.studio._active_watch_suspensions()), 1)
            studio._rename_path_with_windows_retry(src_retry, dst_retry)
            self.studio._sync_path_change(str(src_retry), str(dst_retry), is_dir=False, on_rebound=evt.set)
        self.assertTrue(evt.is_set() and dst_retry.is_file() and len(attempts) == 2)
        self.assertIsNone(self.studio._suspend_watches_for_prefix(str(dst_retry), is_dir=False))
        self.assertEqual(self.studio._active_watch_suspensions(), [])
        _, saved_assets, is_portable = open_note(smd_path)
        self.assertTrue(is_portable)
        self.assertEqual(set(saved_assets), {"assets/diagram.svg", "assets/pixel.png", "assets/direct.png"})


if __name__ == "__main__":
    unittest.main()
