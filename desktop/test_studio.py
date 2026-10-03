import json
import os
import time
import unittest
from pathlib import Path
os.environ.setdefault("QT_QPA_PLATFORM","offscreen")
from PySide6.QtGui import QGuiApplication
from PySide6.QtCore import QUrl
from studio import Session, Studio

class QuietStudio(Studio):
    def _refresh_theme(self):
        self.system_dark = True

class StudioTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.app = QGuiApplication.instance() or QGuiApplication(["Super MD tests"])

    def setUp(self):
        self.session = Session(True)
        self.windows = []
        self.studio = self.window()

    def window(self):
        window = QuietStudio(True,self.session)
        self.windows.append(window)
        return window

    def flush(self):
        self.session.writes.submit(lambda:None).result(timeout=3)
        self.app.processEvents()

    def await_idle(self):
        deadline = time.monotonic()+3
        while self.studio.busy and time.monotonic()<deadline:
            self.app.processEvents()
            time.sleep(.005)
        self.assertEqual(self.studio.busy,0)
        self.flush()

    def tearDown(self):
        for window in self.windows:
            window.stop()
            window.pool.shutdown(wait=True,cancel_futures=True)
        self.session.writes.shutdown(wait=True)
        self.app.processEvents()

    def test_cancel_then_discard_closes_once_without_prompt_loop(self):
        studio = self.studio
        studio.newNote()
        studio._current()["content"] = "Unsaved work"
        closed = []
        studio.allowClose.connect(lambda:closed.append(True))
        self.assertFalse(studio.requestWindowClose())
        studio.resolveClose("cancel")
        self.assertEqual(studio._current()["content"],"Unsaved work")
        self.assertEqual(closed,[])
        self.assertFalse(studio.requestWindowClose())
        studio.resolveClose("discard")
        self.assertEqual(closed,[True])
        self.assertTrue(studio.requestWindowClose())

    def test_open_with_folder_routes_to_sidebar_without_discarding_notes(self):
        studio = self.studio
        folder = studio.data / "Notes with spaces Ω"
        folder.mkdir()
        (folder / "Algebra.md").write_text("# Algebra")
        ids = [t["id"] for t in studio.tabs]
        studio._current()["content"] = "Unsaved draft"
        studio.openPath(QUrl.fromLocalFile(str(folder)).toString())
        deadline = time.monotonic() + 3
        while not studio.files and time.monotonic() < deadline:
            self.app.processEvents(); time.sleep(.005)
        self.assertEqual(studio.folder, str(folder.resolve()))
        self.assertEqual([entry["name"] for entry in studio.files], ["Algebra.md"])
        self.assertEqual([t["id"] for t in studio.tabs], ids)
        self.assertEqual(studio._current()["content"], "Unsaved draft")
        self.assertTrue(studio.settings["welcomed"])

    def test_invalid_folder_does_not_clear_the_existing_folder(self):
        studio = self.studio
        studio.folder = str(studio.data)
        studio.openFolder(str(studio.data / "missing"))
        self.assertEqual(studio.folder, str(studio.data))
        self.assertIn("existing local folder", studio.message)

    def test_open_with_note_still_opens_markdown(self):
        path = self.studio.data / "A note.md"
        path.write_text("# Open me", encoding="utf-8")
        self.studio.openPath(str(path))
        self.await_idle()
        self.assertEqual(self.studio._current()["path"], str(path.resolve()))
        self.assertEqual(self.studio._current()["content"], "# Open me")

    def test_save_then_close_commits_the_file_before_closing(self):
        studio = self.studio
        path = studio.data/"saved.md"
        studio.newNote()
        studio._current().update(content="# Keep this",path=str(path))
        closed = []
        studio.allowClose.connect(lambda:closed.append(path.read_text()))
        self.assertFalse(studio.requestWindowClose())
        studio.resolveClose("save")
        self.await_idle()
        self.assertEqual(closed,["# Keep this"])

    def test_window_recovery_does_not_clobber_other_window(self):
        first,second = self.studio,self.window()
        first._current()["content"] = "First draft"
        second._current()["content"] = "Second draft"
        first._recover(); second._recover(); self.flush()
        recovered = json.loads((first.data/"recovery.json").read_text())
        self.assertEqual({t["content"] for t in recovered},{"First draft","Second draft"})
        second._current()["saved"] = second._current()["content"]
        second._recover(); self.flush()
        recovered = json.loads((first.data/"recovery.json").read_text())
        self.assertEqual([t["content"] for t in recovered],["First draft"])

    def test_close_folder_keeps_tabs_and_fullscreen_zoom_is_independent(self):
        studio = self.studio
        ids = [t["id"] for t in studio.tabs]
        studio.folder = str(studio.data)
        studio.closeFolder()
        self.assertEqual([t["id"] for t in studio.tabs],ids)
        self.assertEqual(studio.folder,"")
        studio.setZoom(130)
        studio.setFullscreen(True); studio.setZoom(210)
        studio.setFullscreen(False)
        self.assertEqual(json.loads(studio.snapshot)["zoom"],130)

    def test_empty_untitled_is_not_recovered_or_prompted(self):
        self.studio.newNote()
        self.studio._current()["content"] = " \n\t"
        self.studio._recover(); self.flush()
        self.assertEqual(json.loads((self.studio.data / "recovery.json").read_text()), [])
        self.assertTrue(self.studio.requestWindowClose())

    def test_autosave_commits_existing_note_and_pauses_for_external_edits(self):
        studio=self.studio
        path=studio.data / "autosave.md"
        path.write_text("original",encoding="utf-8")
        studio._current().update(path=str(path),content="first edit",saved="original")
        studio._autosave()
        deadline=time.monotonic()+3
        while studio.saving and time.monotonic()<deadline:
            self.app.processEvents();time.sleep(.005)
        self.assertEqual(path.read_text(),"first edit")
        self.assertEqual(studio._current()["saved"],"first edit")
        path.write_text("external edit",encoding="utf-8")
        studio._current()["content"]="second edit"
        studio._autosave()
        deadline=time.monotonic()+3
        while studio.saving and time.monotonic()<deadline:
            self.app.processEvents();time.sleep(.005)
        self.assertEqual(path.read_text(),"external edit")
        self.assertEqual(studio._current()["content"],"second edit")
        self.assertIn("changed",studio.message)

    def test_reorder_keeps_active_note_and_portable_assets(self):
        studio = self.studio
        studio.newNote(); studio.newNote()
        note = studio._current()
        note.update(content="![image](smd-asset:x)", assets={"x": "image bytes"}, portable=True)
        studio.receiveTab(studio.window_id, note["id"], 0)
        self.assertIs(studio.tabs[0], note)
        self.assertEqual(studio.active, note["id"])
        self.assertEqual(note["assets"], {"x": "image bytes"})

    def test_window_transfer_flushes_latest_text_and_recovers_exactly_once(self):
        source, target = self.studio, self.window()
        note = source._current()
        note.update(assets={"image": "bytes"}, portable=True)
        source.ready = True
        target.receiveTab(source.window_id, note["id"], 0)
        self.assertIn(note, source.tabs)
        operation = dict(source.flush_operation)
        source.post("flush", "document_flushed", json.dumps({"id": note["id"], "content": "last keystroke", "operation": operation}))
        self.assertNotIn(note, source.tabs)
        self.assertIs(target.tabs[0], note)
        self.assertEqual(target.active, note["id"])
        self.assertEqual(note["content"], "last keystroke")
        self.assertEqual(note["assets"], {"image": "bytes"})
        self.flush()
        recovered = json.loads((source.data / "recovery.json").read_text())
        self.assertEqual([t["content"] for t in recovered], ["last keystroke"])

    def test_closed_or_busy_destination_cannot_lose_the_source_tab(self):
        source, target = self.studio, self.window()
        source.ready = True
        note = source._current()
        target.receiveTab(source.window_id, note["id"], 0)
        operation = dict(source.flush_operation)
        target.stop()
        source.post("flush", "document_flushed", json.dumps({"id": note["id"], "content": "keep me", "operation": operation}))
        self.assertIn(note, source.tabs)
        third = self.window(); third.busy = 1
        third.receiveTab(source.window_id, note["id"], 0)
        self.assertIn(note, source.tabs)
        self.assertIsNone(source.flush_operation)

    def test_detach_is_a_flush_then_request_not_a_destructive_close(self):
        studio = self.studio
        studio.ready = True
        requests = []
        studio.detachedWindowRequested.connect(lambda window, tab: requests.append((window, tab)))
        studio.detachTab(studio.active)
        operation = dict(studio.flush_operation)
        studio.post("flush", "document_flushed", json.dumps({"id": studio.active, "content": "unsaved", "operation": operation}))
        self.assertEqual(requests, [(studio.window_id, studio.active)])
        self.assertEqual(studio._current()["content"], "unsaved")

    def test_share_markdown_uses_the_final_reader_snapshot_and_releases_tab_moves(self):
        path = self.studio.data / "shared.md"
        self.studio.exportTo(str(path), "md")
        self.assertFalse(self.studio._can_move())
        self.studio.post("export", "export_markdown_native", json.dumps({"id": self.studio.active, "content": "the final edit"}))
        self.await_idle()
        self.assertEqual(path.read_text(), "the final edit")
        self.assertTrue(self.studio._can_move())

    def test_settings_sync_and_invalid_themes_cannot_corrupt_the_ui(self):
        second = self.window()
        self.studio.setting("theme",'"light"')
        self.assertEqual(second.settings["theme"],"light")
        self.studio.setting("theme",'"not-a-theme"')
        self.studio.setting("size",'NaN')
        self.assertEqual(second.settings["theme"],"light")
        self.assertEqual(second.settings["size"],18)

    def test_zoom_sends_a_delta_not_the_document_and_remembers_mode(self):
        self.studio.ready = True
        loads, calls = [], []
        self.studio.readerLoad.connect(loads.append)
        self.studio.readerCall.connect(calls.append)
        self.studio.setZoom(175)
        self.assertEqual(loads, [])
        self.assertEqual(calls, ["window.supermdSetZoom?.(175)"])
        self.studio.setMode("reader")
        self.assertEqual(self.window().mode, "reader")

    def test_outline_names_untitled_notes_and_sets_export_filename(self):
        self.studio.newNote()
        self.studio.post("outline", "document_outline", json.dumps({"id": self.studio.active, "headings": [{"id":"energy", "title":"Energy / work", "level":1,"offset":0}]}))
        self.assertEqual(self.studio._current()["name"], "Energy  work.md")
        self.assertTrue(QUrl(self.studio.defaultExportLocation("pdf")).toLocalFile().endswith("Energy  work.pdf"))
        self.assertEqual(json.loads(self.studio.snapshot)["outline"][0]["id"], "energy")

    def test_close_waits_for_final_editor_snapshot(self):
        studio = self.studio
        studio.ready = True
        prompts,closed = [],[]
        studio.closeRequested.connect(prompts.append)
        studio.allowClose.connect(lambda:closed.append(True))
        studio.closeWindowSafely()
        self.assertEqual(prompts,[])
        operation = dict(studio.flush_operation)
        studio.post("flush","document_flushed",json.dumps({"id":studio.active,"content":"The last keystroke","operation":operation}))
        self.assertEqual(prompts,["Welcome.md"])
        self.assertEqual(closed,[])
        studio.resolveClose("discard")
        self.assertEqual(closed,[True])

    def test_stale_flush_cannot_close_a_later_operation(self):
        studio = self.studio
        studio.ready = True
        studio.closeWindowSafely()
        previous = dict(studio.flush_operation)
        studio.resolveFlush("cancel")
        studio.saveSafely()
        studio.post("flush","document_flushed",json.dumps({"id":studio.active,"content":"Stale draft","operation":previous}))
        self.assertNotEqual(studio._current()["content"],"Stale draft")
        self.assertEqual(studio.flush_operation["action"],"save")
