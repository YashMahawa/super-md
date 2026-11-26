"""Focused unit tests for unified rename pipelines and portable .smd asset-staging helpers."""
from __future__ import annotations
import base64, hashlib, os, shutil, sys, tempfile, time, unittest
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
import documents, folder_ops, studio_assets_rename
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
        self.temp_dir = Path(tempfile.mkdtemp(prefix="supermd-assets-rename-"))
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
        write_calls: list[Path] = []
        real_write_portable = documents.write_portable
        with patch("studio.write_portable", side_effect=lambda p, md, a: (write_calls.append(Path(p)), real_write_portable(p, md, a))[1]):
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
        with patch("studio.atomic_write", side_effect=lambda p, data: (atomic_calls.append(Path(p)), real_atomic_write(p, data))[1]):
            self.studio.createFolderNote(str(self.open_root), "Patched Note", "md")
            self._wait_for(lambda: self.studio.busy == 0 and (self.open_root / "Patched Note.md").is_file())
        self.assertIn((self.open_root / "Patched Note.md").resolve(), [p.resolve() for p in atomic_calls])
        _, saved_assets, is_portable = open_note(smd_path)
        self.assertTrue(is_portable)
        self.assertEqual(set(saved_assets), {"assets/diagram.svg", "assets/pixel.png"})


if __name__ == "__main__":
    unittest.main()
