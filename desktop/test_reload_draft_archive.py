import json
import os
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
sys.path.insert(0, str(Path(__file__).resolve().parent))

from PySide6.QtGui import QGuiApplication

from closed_notes import ClosedNoteStore
from documents import write_portable
from studio import Session, Studio


class QuietStudio(Studio):
    def _refresh_theme(self):
        self.system_dark = True


class ReloadDraftArchiveTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.app = QGuiApplication.instance() or QGuiApplication(["Super MD tests"])

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.session = Session(True)
        self.studio = QuietStudio(True, self.session)
        self.studio.settings["autosave"] = False
        self.session.writes.flush(timeout=3)

    def tearDown(self):
        self.studio.stop()
        self.studio.pool.shutdown(wait=True, cancel_futures=True)
        self.studio._search_pool.shutdown(wait=True, cancel_futures=True)
        self.session.writes.shutdown(wait=True)
        self.app.processEvents()
        self.temp.cleanup()

    def _wait_for(self, predicate, timeout=5.0):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            self.app.processEvents()
            if predicate():
                return
            time.sleep(0.01)
        self.app.processEvents()
        self.assertTrue(predicate(), "Timed out waiting for condition")

    def _wait_recovery_idle(self):
        self.studio.writes.flush(timeout=5.0)
        self.session.writes.flush(timeout=5.0)
        self.app.processEvents()

    def test_dirty_markdown_and_portable_smd_archive_with_assets_before_reload_and_reopen_cleanly(self):
        md_path = self.root / "Notes.md"
        md_path.write_text("# Disk v1\n", encoding="utf-8")
        tab = self.studio._current()
        tab.update(name="Notes.md", path=str(md_path), content="# Dirty local draft\n\nValuable paragraph.\n", saved="# Disk v1\n", conflict=True)
        md_path.write_text("# Disk v2\n", encoding="utf-8")

        self.studio.resolveConflict("reload")
        self._wait_for(lambda: not tab["conflict"] and self.studio.busy == 0 and tab["content"] == "# Disk v2\n")
        self.assertEqual(tab["saved"], "# Disk v2\n")
        self.assertEqual(len(self.studio.closed_tabs), 1)

        # Reopening while Notes.md is still open restores the archived dirty draft in a separate unbound tab.
        self.studio.reopenTab()
        self._wait_for(lambda: len(self.studio.tabs) == 2)
        reopened_md = next(t for t in self.studio.tabs if t["id"] != tab["id"])
        self.assertEqual(reopened_md["name"], "Recovered Notes.md")
        self.assertEqual(reopened_md["path"], "")
        self.assertEqual(reopened_md["content"], "# Dirty local draft\n\nValuable paragraph.\n")
        self.assertTrue(self.studio._is_dirty(reopened_md))
        self.assertEqual(md_path.read_text(encoding="utf-8"), "# Disk v2\n")

        # Clean reload does not create duplicate recovery snapshots.
        closed_before_clean = list(self.studio.closed_tabs)
        self.studio.selectTab(tab["id"])
        md_path.write_text("# Disk v3\n", encoding="utf-8")
        self.studio.resolveConflict("reload")
        self._wait_for(lambda: tab["content"] == "# Disk v3\n" and self.studio.busy == 0)
        self.assertEqual(self.studio.closed_tabs, closed_before_clean)

        # Dirty portable .smd with modified assets archives both draft markdown and portable assets.
        svg_draft = "data:image/svg+xml;base64,PHN2ZyBpZD0iZHJhZnQiLz4="
        svg_disk = "data:image/svg+xml;base64,PHN2ZyBpZD0iZGlzayIvPg=="
        png_extra = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg=="
        smd_path = self.root / "Figures.smd"
        write_portable(smd_path, "# Disk portable v2\n\n![fig](assets/fig.svg)\n", {"assets/fig.svg": svg_disk})

        self.studio.newNote()
        smd_tab = self.studio._current()
        smd_tab.update(
            name="Figures.smd",
            path=str(smd_path),
            content="# Draft portable\n\n![fig](assets/fig.svg)\n![extra](assets/extra.png)\n",
            saved="# Baseline portable\n",
            assets={"assets/fig.svg": svg_draft, "assets/extra.png": png_extra},
            saved_assets={"assets/fig.svg": svg_draft},
            assets_dirty=True,
            portable=True,
            conflict=True,
        )

        self.studio.resolveConflict("reload")
        self._wait_for(lambda: not smd_tab["conflict"] and self.studio.busy == 0 and smd_tab["content"].startswith("# Disk portable v2"))
        self.assertEqual(smd_tab["assets"], {"assets/fig.svg": svg_disk})
        self.assertFalse(smd_tab["assets_dirty"])
        self.assertEqual(len(self.studio.closed_tabs), 1)

        # Verify persistent ClosedNoteStore snapshot on disk holds both draft text and portable assets across restart.
        restarted_store = ClosedNoteStore(self.session.closed_note_store.root)
        persisted_refs = restarted_store.load_index_strict()
        self.assertEqual(len(persisted_refs), 1)
        persisted_note = restarted_store.load(persisted_refs[0])
        self.assertEqual(persisted_note["name"], "Recovered Figures.smd")
        self.assertEqual(persisted_note["path"], "")
        self.assertTrue(persisted_note["portable"])
        self.assertTrue(persisted_note["assets_dirty"])
        self.assertEqual(persisted_note["content"], "# Draft portable\n\n![fig](assets/fig.svg)\n![extra](assets/extra.png)\n")
        self.assertEqual(persisted_note["assets"], {"assets/fig.svg": svg_draft, "assets/extra.png": png_extra})

        # Reopening restores both markdown and portable assets while Figures.smd remains open with disk content.
        self.studio.reopenTab()
        self._wait_for(lambda: any(t["name"] == "Recovered Figures.smd" for t in self.studio.tabs))
        reopened_smd = next(t for t in self.studio.tabs if t["name"] == "Recovered Figures.smd")
        self.assertEqual(reopened_smd["assets"], {"assets/fig.svg": svg_draft, "assets/extra.png": png_extra})
        self.assertEqual(reopened_smd["content"], "# Draft portable\n\n![fig](assets/fig.svg)\n![extra](assets/extra.png)\n")

    def test_failed_archive_or_failed_reload_keeps_dirty_draft_and_assets_recoverable(self):
        svg_draft = "data:image/svg+xml;base64,PHN2ZyBpZD0ia2VlcCIvPg=="
        svg_disk = "data:image/svg+xml;base64,PHN2ZyBpZD0iZGlzayIvPg=="
        smd_path = self.root / "Important.smd"
        write_portable(smd_path, "# External disk content\n", {"assets/keep.svg": svg_disk})

        tab = self.studio._current()
        tab.update(
            name="Important.smd",
            path=str(smd_path),
            content="# Precious unsaved draft\n\n![keep](assets/keep.svg)\n",
            saved="# Old saved\n",
            assets={"assets/keep.svg": svg_draft},
            saved_assets={},
            assets_dirty=True,
            portable=True,
            conflict=True,
        )

        # 1. Snapshot write failure keeps the open draft + assets intact and persisted in recovery.json.
        with patch.object(self.session.closed_note_store, "save", side_effect=OSError("disk full")):
            self.studio.resolveConflict("reload")
            self._wait_for(lambda: self.studio.busy == 0 and "Could not archive draft before reloading" in self.studio.message)
        self._wait_recovery_idle()
        self.assertEqual(tab["content"], "# Precious unsaved draft\n\n![keep](assets/keep.svg)\n")
        self.assertEqual(tab["assets"], {"assets/keep.svg": svg_draft})
        self.assertTrue(tab["conflict"])
        recovered = json.loads((self.session.data / "recovery.json").read_text(encoding="utf-8"))
        self.assertEqual(len(recovered), 1)
        self.assertEqual(recovered[0]["content"], "# Precious unsaved draft\n\n![keep](assets/keep.svg)\n")
        self.assertEqual(recovered[0]["assets"], {"assets/keep.svg": svg_draft})

        # 2. Index write failure also refuses to overwrite the open tab and keeps recovery.json intact.
        with patch.object(self.session.closed_note_store, "save_index", side_effect=OSError("index locked")):
            self.studio.resolveConflict("reload")
            self._wait_for(lambda: self.studio.busy == 0 and "Could not update closed-note recovery before reloading" in self.studio.message)
        self._wait_recovery_idle()
        self.assertEqual(tab["content"], "# Precious unsaved draft\n\n![keep](assets/keep.svg)\n")
        self.assertEqual(tab["assets"], {"assets/keep.svg": svg_draft})
        self.assertEqual(self.studio.closed_tabs, [])

        # 3. Reload-from-disk failure (corrupt/missing file) leaves the open draft + assets untouched and recoverable.
        smd_path.unlink()
        self.studio.resolveConflict("reload")
        self._wait_for(lambda: self.studio.busy == 0 and "Could not reload note from disk" in self.studio.message)
        self._wait_recovery_idle()
        self.assertEqual(tab["content"], "# Precious unsaved draft\n\n![keep](assets/keep.svg)\n")
        self.assertEqual(tab["assets"], {"assets/keep.svg": svg_draft})
        self.assertEqual(self.studio.closed_tabs, [])
        recovered_after_missing = json.loads((self.session.data / "recovery.json").read_text(encoding="utf-8"))
        self.assertEqual(recovered_after_missing[0]["content"], "# Precious unsaved draft\n\n![keep](assets/keep.svg)\n")
        self.assertEqual(recovered_after_missing[0]["assets"], {"assets/keep.svg": svg_draft})


if __name__ == "__main__":
    unittest.main()
