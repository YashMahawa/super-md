"""Focused unit tests for desktop/studio_session.py and Studio/Session facade wrappers."""
from __future__ import annotations

import json, os, shutil, sys, tempfile, threading, time, unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
os.environ.setdefault("QT_QUICK_BACKEND", "software")
from PySide6.QtGui import QGuiApplication

import custom_theme
import studio as studio_module
import studio_session
from closed_notes import ClosedNoteStore
from documents import atomic_json
from studio import Session, Studio


class StudioSessionTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.app = QGuiApplication.instance() or QGuiApplication([])

    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory(prefix="supermd-session-test-")
        self.root = Path(self.temp_dir.name).resolve()

    def tearDown(self):
        self.temp_dir.cleanup()

    def _make_studio(self, session: Session) -> Studio:
        session.settings.update(python=sys.executable, autosave=False)
        st = Studio(isolated=True, session=session)
        deadline = time.monotonic() + 0.25
        while time.monotonic() < deadline and st._theme_running:
            self.app.processEvents()
            time.sleep(0.005)
        self.app.processEvents()
        return st

    def _cleanup(self, session: Session, *studios: Studio) -> None:
        for st in studios:
            if not st.retired:
                st.stop()
            st.pool.shutdown(wait=True)
        session.writes.shutdown(wait=True)
        shutil.rmtree(session.data, ignore_errors=True)

    def test_session_init_patches_corruption_resilience_and_multiwindow_restore(self):
        iso_dir = self.root / "isolated-mkdtemp"
        iso_dir.mkdir()
        with patch("studio.tempfile.mkdtemp", return_value=str(iso_dir)) as mkdtemp_mock:
            iso_session = Session(isolated=True)
        try:
            mkdtemp_mock.assert_called_once_with(prefix="supermd-test-")
            self.assertEqual(iso_session.data, iso_dir.resolve())
        finally:
            iso_session.writes.shutdown(wait=True)

        app_base = self.root / "appdata"
        with patch("studio.QStandardPaths.writableLocation", return_value=str(app_base)):
            std_session = Session(isolated=False)
        try:
            self.assertEqual(std_session.data, (app_base / "qt-studio").resolve())
        finally:
            std_session.writes.shutdown(wait=True)

        corrupt_dir = self.root / "corrupt"
        (corrupt_dir / "closed-notes").mkdir(parents=True)
        for name in ("settings.json", "startup.json", "reading-positions.json", "recovery.json", "closed-notes/index.json"):
            (corrupt_dir / name).write_text("{corrupt", encoding="utf-8")
        resilient = Session(True, corrupt_dir)
        try:
            self.assertTrue(resilient.closed_note_error)
            self.assertEqual((resilient.closed_tabs, resilient.initial_recovery), ([], []))
            self.assertEqual((resilient.settings["agentAccessEnabled"], resilient.settings["cloudAgentEnabled"]), (False, False))
        finally:
            resilient.writes.shutdown(wait=True)

        restore_dir = self.root / "restore"
        restore_dir.mkdir()
        atomic_json(restore_dir / "settings.json", {
            "settings": {"widthPercent": 80, "widthMigrated": False, "agentAccessEnabled": "yes", "cloudAgentEnabled": True},
            "pinned": ["/a.md"], "recent": ["/b.md", "/a.md"],
        })
        atomic_json(restore_dir / "startup.json", {
            "paths": ["/a.md"], "tabs": [{"id": "t1", "path": "/a.md"}],
            "active": "/a.md", "activeId": "t1", "folder": "/ws", "expanded": ["/ws/sub"],
            "windows": [{"tabs": [{"id": "t2", "path": "/b.md"}], "active": "/b.md", "activeId": "t2", "folder": "/ws2", "expanded": ["/ws2/d"]}],
        })
        atomic_json(restore_dir / "reading-positions.json", {f"/n{i}.md": i for i in range(205)})
        atomic_json(restore_dir / "recovery.json", [{"id": "t3", "name": "Draft.md", "content": "# Hi", "path": "", "saved": "", "assets": {}}])
        cstore = ClosedNoteStore(restore_dir / "closed-notes")
        cstore.save_index([cstore.save({"id": "t2", "name": "B.md"}), cstore.save({"id": "closed-keep", "name": "Keep.md"})])

        restored = Session(True, data=restore_dir)
        try:
            self.assertEqual((restored.settings["widthPercent"], restored.settings["agentAccessEnabled"], restored.settings["cloudAgentEnabled"], restored.settings["keepInBackground"], restored.update_installed), (90, False, True, True, False))
            self.assertEqual((restored.recent, len(restored.locations), len(restored.startup_windows)), (["/a.md", "/b.md"], 200, 1))
            self.assertTrue(restored.has_pending_startup_windows())
            restored.settings["startup"] = "empty"
            self.assertFalse(restored.has_pending_startup_windows())
            self.assertEqual([c["id"] for c in restored.closed_tabs], ["closed-keep"])
            self.assertFalse(restored.is_quitting())
            restored.background = SimpleNamespace(quitting=True)
            self.assertTrue(restored.is_quitting())
        finally:
            restored.writes.shutdown(wait=True)

    def test_theme_library_migration_reader_grants_and_agent_stage_fifo(self):
        legacy_dir = self.root / "legacy-theme"
        legacy_dir.mkdir()
        atomic_json(legacy_dir / "theme.json", {**custom_theme.TEMPLATE, "name": "Migrated Theme"})
        atomic_json(legacy_dir / "theme-source.json", {"path": "/ext/theme.json"})
        written_paths: list[Path] = []
        real_atomic_json = studio_module.atomic_json
        with patch("studio.atomic_json", side_effect=lambda p, d: (written_paths.append(Path(p)), real_atomic_json(p, d))[1]):
            migrated = Session(True, legacy_dir)
        try:
            self.assertEqual((migrated.active_theme_kind, migrated.saved_themes[0]["name"], migrated.theme_source, len(written_paths)), ("saved", "Migrated Theme", "/ext/theme.json", 2))
        finally:
            migrated.writes.shutdown(wait=True)

        preset_dir = self.root / "preset-theme"
        preset_dir.mkdir()
        atomic_json(preset_dir / "theme-library.json", {"active": {"kind": "preset", "id": "nord"}, "saved": []})
        preset_session = Session(True, preset_dir)
        studio = self._make_studio(preset_session)
        try:
            self.assertEqual((preset_session.active_theme_kind, preset_session.active_theme_id), ("preset", "nord"))
            note_file, img_file = self.root / "doc.md", self.root / "fig.png"
            note_file.write_text("![f](fig.png)", encoding="utf-8")
            img_file.write_bytes(b"png")
            embedded_str = "data:image/png;base64,AAAA"
            tab = studio._current()
            tab.update(path=str(note_file), assets={"emb.png": embedded_str})
            emb_grant = SimpleNamespace(owner_id=studio.window_id, tab_id=tab["id"], source="emb.png", embedded_identity=studio_module._asset_identity(embedded_str), path="")
            disk_grant = SimpleNamespace(owner_id=studio.window_id, tab_id=tab["id"], source="fig.png", embedded_identity=0, path=str(img_file.resolve()))
            self.assertTrue(preset_session.reader_asset_is_current(emb_grant))
            self.assertEqual(preset_session.reader_asset_payload(emb_grant), embedded_str)
            self.assertTrue(preset_session.reader_asset_is_current(disk_grant))
            tab["assets"]["emb.png"] = "data:image/png;base64," + ("B" * 8)
            self.assertFalse(preset_session.reader_asset_is_current(emb_grant))
            self.assertIsNone(preset_session.reader_asset_payload(emb_grant))
            self.assertFalse(preset_session.reader_asset_source_is_current("missing", tab["id"], "fig.png", 0, ""))

            events: list[str] = []
            preset_session._enqueue_agent_stage(lambda: (events.append("sync-skip"), False)[1])
            preset_session._enqueue_agent_stage(lambda: (events.append("async-1"), True)[1])
            preset_session._enqueue_agent_stage(lambda: (events.append("async-2"), True)[1])
            self.assertEqual((events, preset_session._agent_staging_active), (["sync-skip", "async-1"], True))
            preset_session._advance_agent_stage_queue()
            self.assertEqual(events, ["sync-skip", "async-1", "async-2"])
            preset_session._advance_agent_stage_queue()
            self.assertFalse(preset_session._agent_staging_active)
        finally:
            self._cleanup(preset_session, studio)

    def test_submit_complete_and_unified_write_retirement_guard(self):
        session = Session(True, self.root / "exec")
        studio = self._make_studio(session)
        try:
            outcomes: list[tuple] = []
            studio.pending_close = "tab-1"
            studio._submit(lambda: "ok", lambda val, err: outcomes.append((val, err)), busy=True)
            self.assertGreaterEqual(studio.busy, 1)
            deadline = time.monotonic() + 2.0
            while not outcomes and time.monotonic() < deadline:
                self.app.processEvents()
                time.sleep(0.005)
            self.assertEqual((outcomes, studio.busy), ([("ok", None)], 0))

            completed_signals: list = []
            studio.completed.connect(completed_signals.append)
            studio._submit(lambda: "quiet", studio_session.noop_done, busy=False)
            studio.pool.submit(lambda: None).result(timeout=2)
            self.app.processEvents()
            self.assertEqual(completed_signals, [])

            studio._submit(lambda: (_ for _ in ()).throw(RuntimeError("boom")), studio_module._noop_done, busy=False)
            deadline = time.monotonic() + 2.0
            while studio.message != "boom" and time.monotonic() < deadline:
                self.app.processEvents()
                time.sleep(0.005)
            self.assertEqual((studio.message, studio.pending_close), ("boom", ""))

            enqueued_revs: list[int] = []
            exact_results: list[tuple] = []
            real_atomic = studio_module.atomic_json
            intercepted = False
            with patch.object(studio_module, "atomic_json", side_effect=lambda p, d: real_atomic(p, d)):
                def run_exact():
                    nonlocal intercepted
                    intercepted = studio_module.atomic_json is not real_atomic
                    studio_module.atomic_json(session.data / "exact.json", {"ok": True})
                self.assertTrue(studio._submit_exact_recovery_write(run_exact, lambda res, err: exact_results.append((res, err)), on_enqueued=enqueued_revs.append))
                session.writes.flush(timeout=2.0)
                self.app.processEvents()
            self.assertEqual((intercepted, len(enqueued_revs), exact_results[0][0][0]), (True, 1, "committed"))

            gate_entered, gate_release = threading.Event(), threading.Event()
            retired_calls: list[str] = []
            self.assertTrue(studio._submit_write(
                lambda: (gate_entered.set(), gate_release.wait(2.0)),
                lambda *_: retired_calls.append("unexpected-done"),
                on_retired=lambda: retired_calls.append("inflight-retired"),
            ))
            self.assertTrue(gate_entered.wait(2.0))
            self.assertEqual(len(studio._pending_write_retirements), 1)
            studio.stop()
            gate_release.set()
            self.app.processEvents()
            self.assertFalse(studio._submit_write(lambda: 1, lambda *_: None, on_retired=lambda: retired_calls.append("post-stop-write")))
            self.assertFalse(studio._submit_exact_recovery_write(lambda: None, lambda *_: None, on_retired=lambda: retired_calls.append("post-stop-exact")))
            studio._submit(lambda: 1, lambda *_: retired_calls.append("retired-submit"))
            self.assertEqual(retired_calls, ["inflight-retired", "post-stop-write", "post-stop-exact"])
        finally:
            self._cleanup(session, studio)

    def test_preferences_positions_startup_recovery_and_error_banners(self):
        session = Session(True, self.root / "persist")
        first, second = self._make_studio(session), self._make_studio(session)
        try:
            changed_hits: list[int] = []
            session.changed.connect(lambda: changed_hits.append(1))
            written: list[Path] = []
            real_write = studio_module.atomic_write
            first.settings["agentAccessEnabled"] = True
            session.background = SimpleNamespace(_cli_started_agent_access=True)
            with patch("studio.atomic_write", side_effect=lambda p, d: (written.append(Path(p)), real_write(p, d))[1]):
                first._preferences(notify=True)
                session.locations["/doc.md"] = 42
                first._save_positions()
                session.writes.flush(timeout=2.0)
            self.assertEqual(len(changed_hits), 1)
            self.assertFalse(json.loads((session.data / "settings.json").read_text(encoding="utf-8"))["settings"]["agentAccessEnabled"])
            self.assertTrue({session.data / "settings.json", session.data / "reading-positions.json"}.issubset(written))

            clean_staged = first._note("Staged.md", "clean", "", "clean", {}, True)
            clean_staged["agent_staged"] = True
            clean_unreviewed = first._note("Unrev.md", "clean", "", "clean", {}, True)
            clean_unreviewed["agent_unreviewed"] = True
            blank_untitled = first._note("Untitled.md", "  \n", "", "", {}, True)
            clean_blank = first._note("Untitled.md", "", "", "", {}, True)
            first.tabs = [clean_staged, clean_unreviewed, blank_untitled, clean_blank]
            first.active = clean_staged["id"]
            second_dirty = second._note("Second.md", "edited", "", "", {}, True)
            second.tabs, second.active = [second_dirty], second_dirty["id"]

            first._recover()
            second._recover()
            session.writes.flush(timeout=2.0)
            startup_disk = json.loads((session.data / "startup.json").read_text(encoding="utf-8"))
            self.assertEqual({t["id"] for t in startup_disk["tabs"]}, {clean_staged["id"], clean_unreviewed["id"], blank_untitled["id"], second_dirty["id"]})
            recovery_disk = json.loads((session.data / "recovery.json").read_text(encoding="utf-8"))
            self.assertEqual({t["id"] for t in recovery_disk}, {clean_staged["id"], clean_unreviewed["id"], second_dirty["id"]})

            first._notify_recovery_write("recovery", OSError("no space"))
            self.app.processEvents()
            self.assertIn("Couldn't save draft recovery data", first.message)
            first._notify_recovery_write("recovery", None)
            self.app.processEvents()
            self.assertEqual(first.message, "")
            first.message = "Unrelated notice"
            first._recovery_write_completed(("startup", None), None)
            self.assertEqual(first.message, "Unrelated notice")
        finally:
            self._cleanup(session, first, second)


if __name__ == "__main__":
    unittest.main()
