"""Unit tests for extracted desktop/studio_saves.py conflict checks, staging guards, locations, and proxies."""
from __future__ import annotations

import ast, base64, hashlib, json, os, shutil, sys, tempfile, time, unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
os.environ.setdefault("QT_QUICK_BACKEND", "software")

from PySide6.QtCore import QStandardPaths
from PySide6.QtGui import QGuiApplication

import documents, folder_ops, studio as studio_mod, studio_saves
from documents import open_note, write_portable
from studio import Session, Studio

SVG_A = "data:image/svg+xml;base64," + base64.b64encode(b"<svg xmlns='http://www.w3.org/2000/svg'><text>A</text></svg>").decode()
SVG_B = "data:image/svg+xml;base64," + base64.b64encode(b"<svg xmlns='http://www.w3.org/2000/svg'><text>B</text></svg>").decode()


class QuietStudio(Studio):
    def _refresh_theme(self):
        self.system_dark = True


class StudioSavesTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.app = QGuiApplication.instance() or QGuiApplication(["studio_saves tests"])

    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory(prefix="supermd-saves-")
        self.root = Path(folder_ops.canonical_path_str(self.temp_dir.name))
        self.session = Session(True, data=self.root / "data")
        self.session.settings.update(python=sys.executable, welcomed=True, autosave=False, newNoteLocation="")
        self.studio = QuietStudio(True, self.session)

    def tearDown(self):
        if not self.studio.retired:
            self.studio.stop()
        self.studio.pool.shutdown(wait=True, cancel_futures=True)
        self.studio._search_pool.shutdown(wait=True, cancel_futures=True)
        self.session.writes.shutdown(wait=True)
        self.app.processEvents()
        self.temp_dir.cleanup()

    def _wait_until(self, predicate, timeout: float = 3.0):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            self.app.processEvents()
            if predicate():
                return
            time.sleep(0.005)
        self.app.processEvents()
        self.assertTrue(predicate())

    @staticmethod
    def _rev(text: str) -> str:
        return hashlib.sha256(text.encode("utf-8")).hexdigest()

    def test_module_boundary_has_no_studio_lookup_sys_modules_or_importerror_handlers(self):
        source = Path(studio_saves.__file__).read_text(encoding="utf-8")
        tree = ast.parse(source)
        self.assertNotIn("_studio_module", source)
        self.assertFalse(hasattr(studio_saves, "_studio_module"))
        self.assertFalse(hasattr(studio_saves, "sys"))
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                for alias in node.names:
                    self.assertNotIn(alias.name, ("studio", "desktop.studio", "importlib"))
            elif isinstance(node, ast.ImportFrom):
                self.assertNotIn(node.module, ("studio", "desktop.studio", "importlib"))
                for alias in node.names:
                    self.assertNotIn(alias.name, ("studio", "importlib"))
            elif isinstance(node, ast.Attribute):
                self.assertFalse(
                    isinstance(node.value, ast.Name) and node.value.id == "sys" and node.attr == "modules",
                    "studio_saves must not inspect sys.modules",
                )
            elif isinstance(node, ast.ExceptHandler):
                self.assertFalse(
                    isinstance(node.type, ast.Name) and node.type.id == "ImportError",
                    "studio_saves must use __package__ imports rather than ImportError handlers",
                )

    def test_unified_disk_conflicts_across_save_text_prepare_save_and_portable_export(self):
        conflicts: list[str] = []
        self.studio.saveConflictRequested.connect(conflicts.append)

        # 1. _save_text: automatic pause vs manual saveConflictRequested + missing file handling
        md_path = self.root / "note.md"
        md_path.write_text("base\n", encoding="utf-8")
        tab = self.studio._current()
        tab.update(name="note.md", path=str(md_path), content="draft\n", saved="base\n")

        md_path.write_text("external\n", encoding="utf-8")
        self.studio._save_text(tab, md_path, automatic=True)
        self._wait_until(lambda: not self.studio.saving)
        self.assertTrue(tab["conflict"])
        self.assertIn("Autosave paused", self.studio.message)
        self.assertEqual(conflicts, [])
        self.assertEqual(md_path.read_text(encoding="utf-8"), "external\n")

        tab["conflict"] = False
        self.studio._save_text(tab, md_path, automatic=False)
        self._wait_until(lambda: not self.studio.saving)
        self.assertTrue(tab["conflict"])
        self.assertEqual(conflicts, ["note.md"])

        # Missing file is a conflict for automatic autosave, but manual save recreates it cleanly.
        tab["conflict"] = False
        md_path.unlink()
        self.studio._save_text(tab, md_path, automatic=True)
        self._wait_until(lambda: not self.studio.saving)
        self.assertTrue(tab["conflict"])
        self.assertFalse(md_path.exists())
        tab["conflict"] = False
        self.studio._save_text(tab, md_path, automatic=False)
        self._wait_until(lambda: not self.studio.saving)
        self.assertFalse(tab["conflict"])
        self.assertEqual(md_path.read_text(encoding="utf-8"), "draft\n")

        # 2. _prepare_save_document: content, asset, and portable-envelope drift + reserved file cleanup
        smd_path = self.root / "agent.smd"
        write_portable(smd_path, "# V1\n", {"assets/a.svg": SVG_A})
        smd_tab = self.studio._note("agent.smd", "# V2\n", str(smd_path), "# V1\n", {"assets/a.svg": SVG_A}, True)
        self.studio.tabs.append(smd_tab)
        rev = self._rev("# V2\n")

        write_portable(smd_path, "# V1\n", {"assets/a.svg": SVG_B})
        with self.assertRaisesRegex(ValueError, "changed outside Super MD"):
            self.studio._agent_document_action({"action": "save_document", "tabId": smd_tab["id"], "expectedRevision": rev})

        # Portable -> plain text drift with identical markdown text is also caught via expected_portable.
        smd_path.write_text("# V1\n", encoding="utf-8")
        no_asset_tab = self.studio._note("plain-drift.smd", "# V2\n", str(smd_path), "# V1\n", {}, True)
        self.studio.tabs.append(no_asset_tab)
        with self.assertRaisesRegex(ValueError, "changed outside Super MD"):
            self.studio._agent_document_action({"action": "save_document", "tabId": no_asset_tab["id"], "expectedRevision": rev})

        # Reserved save-as file is cleaned up and removed from _agent_owned_files on write failure or abort().
        self.studio.settings["newNoteLocation"] = str(self.root)
        with patch("studio.write_portable", side_effect=OSError("io boom")):
            with self.assertRaisesRegex(OSError, "io boom"):
                self.studio._agent_document_action({
                    "action": "save_document", "tabId": smd_tab["id"], "expectedRevision": rev,
                    "filename": "failed-copy.smd", "saveAs": True,
                })
        self.assertFalse((self.root / "failed-copy.smd").exists())
        self.assertNotIn(str((self.root / "failed-copy.smd").resolve()), self.studio._agent_owned_files)

        _, _, _, abort_fn = Studio._prepare_save_document(self.studio, {
            "tabId": smd_tab["id"], "expectedRevision": rev, "filename": "aborted-copy.smd", "saveAs": True,
        })
        self.assertTrue((self.root / "aborted-copy.smd").exists())
        abort_fn()
        self.assertFalse((self.root / "aborted-copy.smd").exists())
        self.assertNotIn(str((self.root / "aborted-copy.smd").resolve()), self.studio._agent_owned_files)

        # 3. Portable export_fmd_native: save=True conflict vs force_overwrite
        live_smd = self.root / "live.smd"
        write_portable(live_smd, "# Base\n", {"assets/a.svg": SVG_A})
        live_tab = self.studio._note("live.smd", "# Edited\n", str(live_smd), "# Base\n", {"assets/a.svg": SVG_A}, True)
        self.studio.tabs.append(live_tab)
        self.studio.active = live_tab["id"]
        self.studio.ready = True
        write_portable(live_smd, "# External\n", {"assets/a.svg": SVG_A})
        replies: list[tuple[str, str, str]] = []
        self.studio.replied.connect(lambda rid, val, err: replies.append((rid, val, err)))
        conflicts.clear()

        self.studio.post("p1", "export_fmd_native", json.dumps({
            "id": live_tab["id"], "save": True, "content": "# Edited\n",
            "originalContent": "# Edited\n", "assets": {"assets/a.svg": SVG_A},
        }))
        self._wait_until(lambda: len(replies) == 1)
        self.assertEqual(json.loads(replies[0][1]), {"saved": False, "conflict": True})
        self.assertTrue(live_tab["conflict"])
        self.assertEqual(conflicts, ["live.smd"])

        self.studio._save_current(force_overwrite=True)
        self.assertIn(live_tab["id"], self.studio._force_overwrite_ids)
        self.studio.post("p2", "export_fmd_native", json.dumps({
            "id": live_tab["id"], "save": True, "content": "# Edited\n",
            "originalContent": "# Edited\n", "assets": {"assets/a.svg": SVG_A},
        }))
        self._wait_until(lambda: len(replies) == 2 and not live_tab["conflict"])
        self.assertEqual(open_note(live_smd)[0], "# Edited\n")

    def test_agent_staging_invariants_across_autosave_explicit_saves_and_reload(self):
        self.studio.settings["autosave"] = True
        self.studio.settings["newNoteLocation"] = str(self.root)
        active = self.studio._current()
        staged_path = self.root / "staged.md"
        staged_path.write_text("v0\n", encoding="utf-8")
        tab = self.studio._note("staged.md", "v1\n", str(staged_path), "v0\n")
        other_tab = self.studio._note("other.md", "o1\n")
        self.studio.tabs.extend([tab, other_tab])
        self.studio.active = active["id"]

        def mark_staged(target_tab: dict, jump_id: str | None = None):
            target_tab["agent_staged"] = True
            target_tab["agent_unreviewed"] = True
            self.studio._agent_jump_tab_id = target_tab["id"] if jump_id is None else jump_id

        # _autosave skips agent_staged and _staging_tabs; _prepare_save_document rejects _staging_tabs
        mark_staged(tab)
        self.studio._autosave()
        self.app.processEvents()
        self.assertEqual(staged_path.read_text(encoding="utf-8"), "v0\n")

        tab["agent_staged"] = False
        self.studio._staging_tabs.add(tab["id"])
        self.studio._autosave()
        self.assertNotIn(tab["id"], self.studio.saving)
        with self.assertRaisesRegex(ValueError, "already staging"):
            Studio._prepare_save_document(self.studio, {"tabId": tab["id"], "expectedRevision": self._rev(tab["content"])})
        self.studio._staging_tabs.discard(tab["id"])

        # 1. Explicit _save_text clears staging and matching jump id (preserving unrelated jump id)
        mark_staged(tab, jump_id=other_tab["id"])
        self.studio._save_text(tab, staged_path, automatic=False)
        self._wait_until(lambda: not self.studio.saving)
        self.assertFalse(tab["agent_staged"] or tab["agent_unreviewed"])
        self.assertEqual(self.studio._agent_jump_tab_id, other_tab["id"])

        # 2. _prepare_save_document clears staging and matching jump id
        tab["content"] = "v2\n"
        mark_staged(tab)
        self.studio._agent_document_action({"action": "save_document", "tabId": tab["id"], "expectedRevision": self._rev("v2\n")})
        self.assertFalse(tab["agent_staged"] or tab["agent_unreviewed"])
        self.assertEqual(self.studio._agent_jump_tab_id, "")

        # 3. Portable export_fmd_native (save & save_as) clears staging
        smd_file = self.root / "staged.smd"
        write_portable(smd_file, "s0\n", {})
        smd_tab = self.studio._note("staged.smd", "s1\n", str(smd_file), "s0\n", {}, True)
        self.studio.tabs.append(smd_tab)
        self.studio.ready = True
        mark_staged(smd_tab)
        self.studio.post("ps1", "export_fmd_native", json.dumps({
            "id": smd_tab["id"], "save": True, "content": "s1\n", "originalContent": "s1\n", "assets": {},
        }))
        self._wait_until(lambda: not smd_tab["agent_staged"])
        self.assertFalse(smd_tab["agent_unreviewed"])
        self.assertEqual(self.studio._agent_jump_tab_id, "")

        copy_smd = self.root / "staged-copy.smd"
        mark_staged(smd_tab)
        self.studio.active = smd_tab["id"]
        self.studio.saveAs(str(copy_smd))
        self.studio.post("ps2", "export_fmd_native", json.dumps({
            "id": smd_tab["id"], "save": False, "content": "s1\n", "originalContent": "s1\n", "assets": {},
        }))
        self._wait_until(lambda: smd_tab["path"] == str(copy_smd) and not self.studio.saving)
        self.assertFalse(smd_tab["agent_staged"] or smd_tab["agent_unreviewed"])

        # 4. resolveConflict("reload") flushes when ready, archives dirty draft without staging flags, and clears staging
        staged_path.write_text("reloaded disk\n", encoding="utf-8")
        tab["content"] = "unsaved\n"
        tab["conflict"] = True
        self.studio.active = tab["id"]
        mark_staged(tab)
        self.studio.resolveConflict("reload")
        self.assertEqual(self.studio.flush_operation["action"], "reload_conflict")
        op = self.studio.flush_operation
        self.studio.flush_operation = None
        self.studio.flush_timer.stop()
        self.studio._after_flush(op)
        self._wait_until(lambda: not tab["conflict"] and self.studio.busy == 0)
        self.assertEqual(tab["content"], "reloaded disk\n")
        self.assertFalse(tab["agent_staged"] or tab["agent_unreviewed"])
        self.assertEqual(len(self.studio.closed_tabs), 1)

    def test_save_vs_save_as_locations_and_folder_tree_refreshes(self):
        downloads = self.root / "Downloads"
        workspace = self.root / "Workspace"
        custom = self.root / "Custom"
        external = self.root / "External"
        for directory in (downloads, workspace, custom, external):
            directory.mkdir()
        existing_note = external / "Note.md"
        existing_note.write_text("# Note\n", encoding="utf-8")

        orig_writable = QStandardPaths.writableLocation
        with patch.object(
            QStandardPaths, "writableLocation",
            side_effect=lambda loc: str(downloads) if loc == QStandardPaths.StandardLocation.DownloadLocation else orig_writable(loc),
        ):
            self.assertTrue(folder_ops.same_path(self.studio.defaultSaveFolder().toLocalFile(), downloads))
            self.studio.folder = str(workspace)
            self.assertTrue(folder_ops.same_path(self.studio.defaultSaveFolder().toLocalFile(), workspace))
            self.studio.settings["newNoteLocation"] = str(custom)
            self.assertTrue(folder_ops.same_path(self.studio.defaultSaveLocation("Draft.md").toLocalFile(), custom / "Draft.md"))

            tab = self.studio._current()
            tab.update(name="Note.md", path=str(existing_note), content="# Note\n", saved="# Note\n")
            self.assertTrue(folder_ops.same_path(self.studio.defaultSaveAsFolder().toLocalFile(), external))
            shutil.rmtree(external)
            self.assertTrue(folder_ops.same_path(self.studio.defaultSaveAsFolder().toLocalFile(), custom))
            if os.name != "nt":
                padded = self.root / " Padded Folder "
                padded.mkdir()
                self.assertEqual(studio_saves.existing_save_directory(padded), padded)
                self.studio.settings["newNoteLocation"] = str(padded)
                self.assertEqual(self.studio.defaultSaveFolder().toLocalFile(), str(padded))
                self.studio.settings["newNoteLocation"] = str(custom)

        refreshes: list[tuple] = []
        invalidations: list[str] = []
        with (
            patch.object(self.studio, "_refresh_open_folder_trees", side_effect=lambda *c: refreshes.append(c)),
            patch.object(self.studio, "_invalidate_folder_index", side_effect=lambda p=None: invalidations.append(str(p))),
        ):
            # In-place save invalidates index on explicit save (not autosave) and skips tree refresh; Save As refreshes across all 3 pipelines.
            target_md = workspace / "First.md"
            self.studio.saveAs(str(target_md))
            self._wait_until(lambda: not self.studio.saving and tab["path"] == str(target_md))
            self.assertEqual(len(refreshes), 1)
            self.assertIn(str(target_md), invalidations)

            invalidations.clear()
            tab["content"] = "# Autosaved\n"
            self.studio._save_text(tab, target_md, automatic=True)
            self._wait_until(lambda: not self.studio.saving)
            self.assertEqual(invalidations, [])
            tab["content"] = "# In place\n"
            self.studio._save_text(tab, target_md, automatic=False)
            self._wait_until(lambda: not self.studio.saving)
            self.assertEqual(len(refreshes), 1)
            self.assertEqual(invalidations, [str(target_md)])

            self.studio.settings["newNoteLocation"] = str(workspace)
            self.studio._agent_document_action({
                "action": "save_document", "tabId": tab["id"],
                "expectedRevision": self._rev("# In place\n"), "filename": "AgentCopy.md", "saveAs": True,
            })
            self.assertEqual(len(refreshes), 2)

            self.studio.ready = True
            target_smd = workspace / "PortableCopy.smd"
            self.studio.saveAs(str(target_smd))
            self.studio.post("ps-tree", "export_fmd_native", json.dumps({
                "id": tab["id"], "save": False, "content": "# In place\n", "originalContent": "# In place\n", "assets": {},
            }))
            self._wait_until(lambda: tab["path"] == str(target_smd) and not self.studio.saving)
            self.assertEqual(len(refreshes), 3)

            self.studio.saveAs(str(target_smd))
            self.studio.post("ps-same", "export_fmd_native", json.dumps({
                "id": tab["id"], "save": False, "content": "# Overwritten\n", "originalContent": "# In place\n", "assets": {},
            }))
            self._wait_until(lambda: tab["saved"] == "# Overwritten\n" and not self.studio.saving)
            self.assertEqual(len(refreshes), 4)

    def test_preserve_unchanged_assets_3arg_write_portable_and_simplenamespace_unbound_calls(self):
        shared_str = str(SVG_A)
        merged = studio_mod._preserve_unchanged_assets({"assets/a.svg": shared_str}, {"assets/a.svg": str(SVG_A), "assets/b.svg": SVG_B})
        self.assertIs(merged["assets/a.svg"], shared_str)
        self.assertEqual(merged["assets/b.svg"], SVG_B)

        # Unbound Studio._prepare_save_document + Studio._run_prepared_write_sync on SimpleNamespace with 3-arg write_portable patch
        smd_dest = self.root / "proxy.smd"
        write_portable(smd_dest, "old\n", {"assets/a.svg": SVG_A})
        calls: list[tuple[Path, str]] = []

        def three_arg_write(path, content, assets):
            calls.append((Path(path), content))
            return documents.write_portable(path, content, assets)

        proxy_tab = {
            "id": "t1", "name": "proxy.smd", "path": str(smd_dest), "content": "new\n",
            "saved": "old\n", "assets": {"assets/a.svg": SVG_A}, "saved_assets": {"assets/a.svg": SVG_A},
            "assets_dirty": False, "portable": True, "conflict": False,
            "agent_staged": True, "agent_unreviewed": True,
        }
        recovered: list[bool] = []
        emitted: list[bool] = []
        proxy = SimpleNamespace(
            tabs=[proxy_tab], active="t1", window_id="win-proxy", folder=str(self.root),
            settings={"newNoteLocation": str(self.root), "autosave": False},
            saving=set(), _agent_owned_files=set(), _agent_open_paths=set(), _agent_jump_tab_id="t1",
            _recover=lambda: recovered.append(True), _emit=lambda *a, **kw: emitted.append(True),
        )
        with patch("studio.write_portable", side_effect=three_arg_write):
            prepared = Studio._prepare_save_document(proxy, {"tabId": "t1", "expectedRevision": self._rev("new\n")})
            result = Studio._run_prepared_write_sync(proxy, prepared)

        self.assertEqual(len(calls), 1)
        self.assertEqual(result["windowId"], "win-proxy")
        self.assertFalse(result["isDirty"])
        self.assertEqual(proxy_tab["saved"], "new\n")
        self.assertFalse(proxy_tab["agent_staged"] or proxy_tab["agent_unreviewed"])
        self.assertEqual(proxy._agent_jump_tab_id, "")
        self.assertEqual((len(recovered), len(emitted)), (1, 1))
        self.assertTrue(folder_ops.same_path(studio_saves.note_save_directory(proxy), self.root))

        # Studio facade wrappers forward explicit local_path and QTimer.singleShot collaborators
        redirected_md = self.root / "redirected.md"
        with patch("studio.local_path", return_value=redirected_md) as lp_mock:
            self.studio.saveAs("ignored.md")
            self._wait_until(lambda: not self.studio.saving)
        lp_mock.assert_called_once_with("ignored.md")
        self.assertEqual(self.studio._current()["path"], str(redirected_md))

        scheduled: list[tuple[int, object]] = []
        close_proxy = SimpleNamespace(
            requestWindowClose=lambda: True, _recover=lambda: recovered.append(True),
            allowClose=SimpleNamespace(emit=lambda: None),
        )
        with patch("studio.QTimer.singleShot", side_effect=lambda ms, cb: scheduled.append((ms, cb))):
            Studio._after_flush(close_proxy, {"action": "close_window", "target": ""})
        self.assertEqual(scheduled, [(0, close_proxy.allowClose.emit)])

        with patch.object(self.studio._python_jobs, "cancel_tab") as cancel_tab_mock:
            self.studio._after_flush({"action": "reload_reader", "target": ""})
        cancel_tab_mock.assert_called_once_with(self.studio.active)

        self.studio._folder_search_open = True
        self.studio._folder_search_query = "needle"
        self.studio._folder_search_pending = True
        with patch.object(self.studio, "_start_folder_search") as start_search_mock:
            self.studio._after_flush({"action": "sync_for_search", "target": ""})
        start_search_mock.assert_not_called()


if __name__ == "__main__":
    unittest.main()
