import json
import os
import time
import unittest
from pathlib import Path
os.environ.setdefault("QT_QPA_PLATFORM","offscreen")
from PySide6.QtGui import QGuiApplication
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

    def test_settings_sync_and_invalid_themes_cannot_corrupt_the_ui(self):
        second = self.window()
        self.studio.setting("theme",'"light"')
        self.assertEqual(second.settings["theme"],"light")
        self.studio.setting("theme",'"not-a-theme"')
        self.studio.setting("size",'NaN')
        self.assertEqual(second.settings["theme"],"light")
        self.assertEqual(second.settings["size"],18)

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
