"""Verification of non-blocking portable saves, asset updates, media exports, and bridge lock contention."""
from __future__ import annotations

import base64
import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest.mock import patch

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
os.environ.setdefault("QT_QUICK_BACKEND", "software")
from PySide6.QtGui import QGuiApplication

import agent_live
import documents
import reader_assets
from documents import open_note, write_portable
from studio import Session, Studio

PNG_HEADER = b"\x89PNG\r\n\x1a\n"
SMALL_PNG = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAX+XDSwAAAABJRU5ErkJggg=="
)


def _sized_png_bytes(size_bytes: int) -> bytes:
    if size_bytes <= len(SMALL_PNG):
        return SMALL_PNG
    filler_len = size_bytes - len(SMALL_PNG) - 12
    chunk_type = b"tEXt"
    payload = b"pad\x00" + (b"A" * max(0, filler_len - 4))
    import struct
    import zlib
    ancillary = struct.pack(">I", len(payload)) + chunk_type + payload + struct.pack(">I", zlib.crc32(chunk_type + payload) & 0xFFFFFFFF)
    # Insert ancillary chunk right before IEND (last 12 bytes of SMALL_PNG).
    return SMALL_PNG[:-12] + ancillary + SMALL_PNG[-12:]


class NonBlockingSavesTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.app = QGuiApplication.instance() or QGuiApplication([])

    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory(prefix="supermd-nonblocking-")
        self.root = Path(self.temp_dir.name).resolve()
        self.session = Session(isolated=True)
        self.session.settings["python"] = sys.executable
        self.session.settings["newNoteLocation"] = str(self.root)
        self.session.settings["autosave"] = False
        self.studio = Studio(isolated=True, session=self.session)
        self.studio.folder = str(self.root)
        self.bridge = agent_live.create_qt_bridge(self.session, self.session.data)
        self.session.agent_bridge = self.bridge
        self.flush_count = 0

        def on_agent_request(raw: str):
            request = json.loads(raw)
            rid = request["requestId"]
            action = request["action"]
            if action == "flush_current":
                self.flush_count += 1
                pending_text = getattr(self, "_unflushed_editor_text", None)
                if pending_text is not None:
                    active_tab = next((t for t in self.studio.tabs if t["id"] == self.studio.active), None)
                    if active_tab is not None:
                        active_tab["content"] = pending_text
                    self._unflushed_editor_text = None
                self.bridge.complete(rid, {"flushed": True}, window_id=self.studio.window_id)
            elif action == "list_tabs":
                self.bridge.complete(rid, {"tabs": request["tabs"]}, window_id=self.studio.window_id)

        self.studio.agentRequest.connect(on_agent_request)
        self.bridge.start()
        self.client = agent_live.LiveTabClient(self.bridge.discovery_path, timeout=15.0)
        deadline = time.monotonic() + 0.25
        while time.monotonic() < deadline:
            self.app.processEvents()
            if not self.studio._theme_running:
                break
            time.sleep(0.005)
        self.app.processEvents()

    def tearDown(self):
        try:
            self.bridge.stop()
        except Exception:
            pass
        try:
            if not self.studio.retired:
                self.studio.stop()
        except Exception:
            pass
        self.studio.pool.shutdown(wait=True)
        self.session.writes.shutdown(wait=True)
        shutil.rmtree(self.session.data, ignore_errors=True)
        self.temp_dir.cleanup()

    def _pump_until(self, predicate, timeout: float = 10.0) -> None:
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            self.app.processEvents()
            if predicate():
                return
            time.sleep(0.002)
        self.app.processEvents()
        self.assertTrue(predicate(), "Timed out waiting for asynchronous condition")

    def _measure_max_ui_stall_until(self, predicate, timeout: float = 15.0) -> float:
        max_iter_ms = 0.0
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            t0 = time.perf_counter()
            self.app.processEvents()
            elapsed_ms = (time.perf_counter() - t0) * 1000.0
            if elapsed_ms > max_iter_ms:
                max_iter_ms = elapsed_ms
            if predicate():
                return max_iter_ms
            time.sleep(0.002)
        self.fail("Timed out waiting for background operation")

    @staticmethod
    def _rev(text: str) -> str:
        return hashlib.sha256(text.encode("utf-8")).hexdigest()

    def test_concurrent_local_and_cloud_reads_complete_during_active_25mb_save_with_low_lock_wait(self):
        large_png = _sized_png_bytes(24_500_000)
        asset_url = "data:image/png;base64," + base64.b64encode(large_png).decode("ascii")
        note_path = self.root / "heavy.smd"
        initial_md = "# Heavy Note\n\n![Figure](assets/figure.png)\n"
        write_portable(note_path, initial_md, {"assets/figure.png": asset_url})

        tab = self.studio._note(note_path.name, initial_md, str(note_path), initial_md, {"assets/figure.png": asset_url}, True)
        self.studio.tabs = [tab]
        self.studio.active = tab["id"]

        # Stage pending editor keystrokes that must flush on the UI thread before queuing the save.
        flushed_md = initial_md + "\nFlushed paragraph before background save.\n"
        self._unflushed_editor_text = flushed_md
        expected_rev = self._rev(flushed_md)

        write_entered = threading.Event()
        allow_write_finish = threading.Event()
        real_write_portable = studio_write_portable = documents.write_portable

        def gated_write_portable(path, markdown, assets):
            write_entered.set()
            allow_write_finish.wait(timeout=10.0)
            return studio_write_portable(path, markdown, assets)

        save_outcome: dict = {}

        def run_save():
            try:
                save_outcome["result"] = self.client.document_action(tab["id"], "save_document", expected_revision=expected_rev)
            except Exception as exc:
                save_outcome["error"] = exc

        with patch("studio.write_portable", side_effect=gated_write_portable):
            save_thread = threading.Thread(target=run_save, daemon=True)
            save_thread.start()

            max_stall_enter = self._measure_max_ui_stall_until(write_entered.is_set, timeout=10.0)
            self.assertLess(max_stall_enter, 50.0, f"UI thread stalled for {max_stall_enter:.1f} ms while queuing 25 MB save")
            self.assertIn(tab["id"], self.studio.saving)
            self.assertGreaterEqual(self.flush_count, 1)

            # Measure raw QtBridge._lock acquisition latency while the 25 MB save is active.
            t_lock = time.perf_counter()
            with self.bridge._lock:
                pass
            lock_wait_ms = (time.perf_counter() - t_lock) * 1000.0
            self.assertLess(lock_wait_ms, 10.0, f"QtBridge._lock waited {lock_wait_ms:.2f} ms during active save")

            # Run concurrent local HTTP read + list AND cloud relay read while save is still blocked in disk I/O!
            read_outcomes: dict = {}

            def run_concurrent_reads():
                t0 = time.perf_counter()
                local_read = self.client.read_tab(tab["id"], offset=0, limit=500)
                local_list = self.client.list_tabs()
                cloud_read = self.bridge.handle_cloud_request({
                    "action": "read_tab",
                    "tabId": f"{self.studio.window_id}:{tab['id']}",
                    "offset": 0,
                    "limit": 500,
                })
                read_outcomes["elapsed_ms"] = (time.perf_counter() - t0) * 1000.0
                read_outcomes["local_read"] = local_read
                read_outcomes["local_list"] = local_list
                read_outcomes["cloud_read"] = cloud_read

            reader_thread = threading.Thread(target=run_concurrent_reads, daemon=True)
            reader_thread.start()
            self._pump_until(lambda: not reader_thread.is_alive(), timeout=5.0)
            reader_thread.join(timeout=1.0)

            self.assertIn("local_read", read_outcomes)
            self.assertFalse(save_outcome, "Concurrent reads must finish BEFORE the 25 MB save completes")
            self.assertIn("Flushed paragraph", read_outcomes["local_read"]["text"])
            self.assertEqual(len(read_outcomes["local_list"]["tabs"]), 1)
            self.assertIn("Flushed paragraph", read_outcomes["cloud_read"]["text"])

            # Simulate the user typing new edits while the 25 MB save writes in the background.
            typed_during_save = flushed_md + "Typed smoothly while saving in background.\n"
            self.studio.post("edit-1", "document_changed", json.dumps({"id": tab["id"], "content": typed_during_save}))
            self.assertEqual(tab["content"], typed_during_save)

            # Release the 25 MB disk write and measure UI-thread stall until completion.
            allow_write_finish.set()
            max_stall_finish = self._measure_max_ui_stall_until(lambda: not save_thread.is_alive(), timeout=15.0)
            save_thread.join(timeout=1.0)

        self.assertNotIn("error", save_outcome, save_outcome)
        self.assertLess(max_stall_finish, 50.0, f"UI thread stalled for {max_stall_finish:.1f} ms during 25 MB save completion")
        self.assertNotIn(tab["id"], self.studio.saving)
        # Concurrent typing must be preserved in tab["content"] while tab["saved"] matches what hit disk.
        self.assertEqual(tab["content"], typed_during_save)
        self.assertEqual(tab["saved"], flushed_md)
        self.assertTrue( save_outcome["result"]["isDirty"] )
        disk_md, disk_assets, disk_portable = open_note(note_path)
        self.assertTrue(disk_portable)
        self.assertEqual(disk_md, flushed_md)
        self.assertEqual(set(disk_assets), {"assets/figure.png"})
        _ = real_write_portable

    def test_async_attach_and_replace_tab_assets_stay_off_ui_thread_and_revoke_stale_grants(self):
        note_path = self.root / "assets-note.smd"
        initial_png = _sized_png_bytes(2_200_000)
        initial_url = "data:image/png;base64," + base64.b64encode(initial_png).decode("ascii")
        markdown = "# Diagrams\n\n![Existing](assets/existing.png)\n"
        write_portable(note_path, markdown, {"assets/existing.png": initial_url})

        tab = self.studio._note(note_path.name, markdown, str(note_path), markdown, {"assets/existing.png": initial_url}, True)
        self.studio.tabs = [tab]
        self.studio.active = tab["id"]

        # Register a reader_assets grant that must be invalidated upon asset mutation.
        resolved = reader_assets.resolve_source(tab, "assets/existing.png")
        grant_url = self.session.reader_assets.register(
            self.studio.window_id,
            tab["id"],
            "assets/existing.png",
            resolved,
        )
        assert grant_url is not None
        token = grant_url.split("://", 1)[1].split("?", 1)[0]
        self.assertIsNotNone(self.session.reader_assets.lookup(token, resolved["fingerprint"]))

        reader_calls: list[str] = []
        self.studio.readerCall.connect(reader_calls.append)

        attach_file = self.root / "new-chart.png"
        attach_bytes = _sized_png_bytes(2_500_000)
        attach_file.write_bytes(attach_bytes)

        rev = self._rev(markdown)
        attach_outcome: dict = {}

        def do_attach():
            attach_outcome["res"] = self.client.document_action(
                tab["id"], "attach_tab_asset", asset_path=str(attach_file), name="chart.png", expected_revision=rev
            )

        t = threading.Thread(target=do_attach, daemon=True)
        t.start()
        stall_attach = self._measure_max_ui_stall_until(lambda: not t.is_alive(), timeout=15.0)
        t.join(timeout=1.0)

        self.assertLess(stall_attach, 50.0, f"UI thread stalled for {stall_attach:.1f} ms during 2.5 MB asset attach")
        self.assertEqual(attach_outcome["res"]["assetName"], "assets/chart.png")
        self.assertIn("assets/chart.png", tab["assets"])
        # Immutable payload string must be shared, not duplicated, between assets and saved_assets.
        self.assertIs(tab["assets"]["assets/chart.png"], tab["saved_assets"]["assets/chart.png"])
        self.assertIsNone(self.session.reader_assets.lookup(token, resolved["fingerprint"]))
        self.assertTrue(any("supermd-assets-changed" in call for call in reader_calls))

        # Re-register grant and test async replace_tab_asset.
        resolved_2 = reader_assets.resolve_source(tab, "assets/existing.png")
        grant_url_2 = self.session.reader_assets.register(
            self.studio.window_id,
            tab["id"],
            "assets/existing.png",
            resolved_2,
        )
        assert grant_url_2 is not None
        token_2 = grant_url_2.split("://", 1)[1].split("?", 1)[0]
        replacement_file = self.root / "updated-existing.png"
        replacement_bytes = _sized_png_bytes(2_300_000)
        replacement_file.write_bytes(replacement_bytes)
        reader_calls.clear()

        replace_outcome: dict = {}

        def do_replace():
            replace_outcome["res"] = self.client.document_action(
                tab["id"], "replace_tab_asset", asset_name="assets/existing.png",
                asset_path=str(replacement_file), expected_revision=rev
            )

        t2 = threading.Thread(target=do_replace, daemon=True)
        t2.start()
        stall_replace = self._measure_max_ui_stall_until(lambda: not t2.is_alive(), timeout=15.0)
        t2.join(timeout=1.0)

        self.assertLess(stall_replace, 50.0, f"UI thread stalled for {stall_replace:.1f} ms during 2.3 MB asset replacement")
        self.assertTrue(replace_outcome["res"]["changed"])
        self.assertIsNone(self.session.reader_assets.lookup(token_2, resolved_2["fingerprint"]))
        self.assertTrue(any("supermd-assets-changed" in call for call in reader_calls))
        _, disk_assets, _ = open_note(note_path)
        self.assertEqual(documents.image_data(disk_assets["assets/existing.png"])[1], replacement_bytes)
        self.assertEqual(documents.image_data(disk_assets["assets/chart.png"])[1], attach_bytes)

        # Verify Rust smd-engine CLI opens the written .smd with identical Markdown and image bytes if built.
        engine_candidates = [
            Path(__file__).resolve().parents[1] / "smd-core/target/release/smd-engine",
            Path(__file__).resolve().parents[1] / "smd-core/target/debug/smd-engine",
        ]
        engine = next((cand for cand in engine_candidates if cand.is_file()), None)
        if engine is not None:
            read_proc = subprocess.run(
                [str(engine), "read", str(note_path)],
                capture_output=True,
                timeout=30,
                check=False,
            )
            self.assertEqual(read_proc.returncode, 0, read_proc.stderr.decode("utf-8", errors="replace"))
            self.assertEqual(read_proc.stdout.decode("utf-8"), markdown)

            inspect_proc = subprocess.run(
                [str(engine), "inspect", str(note_path)],
                capture_output=True,
                timeout=30,
                check=False,
            )
            self.assertEqual(inspect_proc.returncode, 0, inspect_proc.stderr.decode("utf-8", errors="replace"))
            inspected = json.loads(inspect_proc.stdout.decode("utf-8"))
            self.assertEqual(inspected["format"], "supermd-smd")
            self.assertEqual(inspected["version"], 1)
            self.assertEqual({a["name"]: a["bytes"] for a in inspected["assets"]},
                             {"assets/existing.png": len(replacement_bytes), "assets/chart.png": len(attach_bytes)})

            extracted_chart = self.root / "extracted-chart.png"
            extract_proc = subprocess.run(
                [str(engine), "extract", str(note_path), "assets/chart.png", str(extracted_chart)],
                capture_output=True,
                timeout=30,
                check=False,
            )
            self.assertEqual(extract_proc.returncode, 0, extract_proc.stderr.decode("utf-8", errors="replace"))
            self.assertEqual(extracted_chart.read_bytes(), attach_bytes)

            pdf_out = self.root / "rendered.pdf"
            export_proc = subprocess.run(
                [str(engine), "export", str(note_path), str(pdf_out)],
                capture_output=True,
                timeout=30,
                check=False,
            )
            self.assertEqual(export_proc.returncode, 0, export_proc.stderr.decode("utf-8", errors="replace"))
            self.assertTrue(pdf_out.read_bytes().startswith(b"%PDF-"))

    def test_overlapping_saves_and_asset_mutations_fail_immediately_with_conflict(self):
        note_path = self.root / "conflict.smd"
        asset_url = "data:image/png;base64," + base64.b64encode(SMALL_PNG).decode("ascii")
        markdown = "# Conflict Check\n"
        write_portable(note_path, markdown, {"assets/pic.png": asset_url})

        tab = self.studio._note(note_path.name, markdown, str(note_path), markdown, {"assets/pic.png": asset_url}, True)
        self.studio.tabs = [tab]
        self.studio.active = tab["id"]
        replacement = self.root / "other.png"
        replacement.write_bytes(_sized_png_bytes(4096))

        started = threading.Event()
        release = threading.Event()
        real_write = documents.write_portable

        def slow_write(path, md, assets):
            started.set()
            release.wait(timeout=10.0)
            return real_write(path, md, assets)

        rev = self._rev(markdown)
        first_save: dict = {}

        def run_first():
            first_save["res"] = self.client.document_action(tab["id"], "save_document", expected_revision=rev)

        with patch("studio.write_portable", side_effect=slow_write):
            t1 = threading.Thread(target=run_first, daemon=True)
            t1.start()
            self._pump_until(started.is_set, timeout=5.0)
            self.assertIn(tab["id"], self.studio.saving)

            # Overlapping agent save, attach, and replace must all fail immediately without waiting on release!
            for call in (
                lambda: self.client.document_action(tab["id"], "save_document", expected_revision=rev),
                lambda: self.client.document_action(tab["id"], "attach_tab_asset", asset_path=str(replacement),
                                                    name="second.png", expected_revision=rev),
                lambda: self.client.document_action(tab["id"], "replace_tab_asset", asset_name="assets/pic.png",
                                                    asset_path=str(replacement), expected_revision=rev),
            ):
                errors: list[Exception] = []
                probe = threading.Thread(target=lambda fn=call: self._capture_error(fn, errors), daemon=True)
                t0 = time.perf_counter()
                probe.start()
                self._pump_until(lambda: not probe.is_alive(), timeout=2.0)
                elapsed_ms = (time.perf_counter() - t0) * 1000.0
                self.assertEqual(len(errors), 1)
                self.assertIn("save is already in progress", str(errors[0]))
                self.assertLess(elapsed_ms, 500.0)

            release.set()
            self._pump_until(lambda: not t1.is_alive(), timeout=5.0)
            t1.join(timeout=1.0)

        self.assertEqual(first_save["res"]["path"], str(note_path))
        self.assertNotIn(tab["id"], self.studio.saving)
        self.assertEqual(set(tab["assets"]), {"assets/pic.png"})

    @staticmethod
    def _capture_error(fn, sink: list[Exception]) -> None:
        try:
            fn()
        except Exception as exc:
            sink.append(exc)

    def test_replace_tab_asset_rejects_unsaved_markdown_edits_before_modifying_disk(self):
        note_path = self.root / "dirty-replace.smd"
        asset_url = "data:image/png;base64," + base64.b64encode(SMALL_PNG).decode("ascii")
        saved_md = "# Saved Version\n\n![Pic](assets/pic.png)\n"
        write_portable(note_path, saved_md, {"assets/pic.png": asset_url})
        original_disk_bytes = note_path.read_bytes()

        dirty_md = saved_md + "\nUnsaved Markdown edit in buffer.\n"
        tab = self.studio._note(note_path.name, dirty_md, str(note_path), saved_md, {"assets/pic.png": asset_url}, True)
        self.studio.tabs = [tab]
        self.studio.active = tab["id"]

        replacement = self.root / "replacement.png"
        replacement.write_bytes(_sized_png_bytes(8192))
        dirty_rev = self._rev(dirty_md)

        errors: list[Exception] = []
        worker = threading.Thread(
            target=lambda: self._capture_error(
                lambda: self.client.document_action(
                    tab["id"], "replace_tab_asset",
                    asset_name="assets/pic.png", asset_path=str(replacement), expected_revision=dirty_rev
                ),
                errors,
            ),
            daemon=True,
        )
        worker.start()
        self._pump_until(lambda: not worker.is_alive(), timeout=5.0)
        worker.join(timeout=1.0)

        self.assertEqual(len(errors), 1)
        self.assertIn("Save the note before replacing a portable asset", str(errors[0]))
        self.assertEqual(note_path.read_bytes(), original_disk_bytes)
        self.assertEqual(tab["content"], dirty_md)
        self.assertEqual(tab["saved"], saved_md)
        self.assertEqual(tab["assets"]["assets/pic.png"], asset_url)

    def test_standalone_25mb_media_export_runs_on_write_queue_without_blocking_ui(self):
        # 1. Verify full Qt @Slot marshalling + dispatch stays < 50 ms for a 5 MB 4K diagram PNG.
        diagram_5mb = _sized_png_bytes(5_000_000)
        raw_5mb = json.dumps({
            "body": base64.b64encode(diagram_5mb).decode("ascii"),
            "mimeType": "image/png",
            "filename": "Diagram4K.png",
        })
        replies: list[tuple[str, str, str]] = []
        self.studio.replied.connect(lambda rid, payload, err: replies.append((rid, payload, err)))

        t_slot = time.perf_counter()
        self.studio.post("media-5mb", "save_media_native", raw_5mb)
        slot_ms = (time.perf_counter() - t_slot) * 1000.0
        self.assertLess(slot_ms, 50.0, f"5 MB save_media_native slot call blocked GUI for {slot_ms:.1f} ms")
        stall_5mb = self._measure_max_ui_stall_until(lambda: len(replies) == 1, timeout=15.0)
        self.assertLess(stall_5mb, 50.0, f"UI loop stalled for {stall_5mb:.1f} ms during 5 MB media export")
        self.assertEqual(replies[0][2], "")
        self.assertEqual(Path(json.loads(replies[0][1])["path"]).read_bytes(), diagram_5mb)

        # 2. Verify maximum 25 MB media export dispatches in < 50 ms and never stalls the UI event loop >= 50 ms.
        replies.clear()
        media_bytes = _sized_png_bytes(25_000_000)
        raw_25mb = json.dumps({
            "body": base64.b64encode(media_bytes).decode("ascii"),
            "mimeType": "image/png",
            "filename": "HighResDiagram.png",
        })
        t0 = time.perf_counter()
        self.studio._post("media-25mb", "save_media_native", raw_25mb)
        post_ms = (time.perf_counter() - t0) * 1000.0
        self.assertLess(post_ms, 50.0, f"save_media_native blocked GUI _post() for {post_ms:.1f} ms")
        self.assertEqual(replies, [], "25 MB media write should complete asynchronously on session.writes")

        max_stall = self._measure_max_ui_stall_until(lambda: len(replies) == 1, timeout=15.0)
        self.assertLess(max_stall, 50.0, f"UI loop stalled for {max_stall:.1f} ms during 25 MB media export")

        rid, raw_payload, err = replies[0]
        self.assertEqual(rid, "media-25mb")
        self.assertEqual(err, "")
        parsed = json.loads(raw_payload)
        self.assertEqual(parsed["filename"], "HighResDiagram.png")
        self.assertEqual(parsed["bytes"], 25_000_000)
        self.assertEqual(Path(parsed["path"]).read_bytes(), media_bytes)

        # Verify background validation failure reports through replied without clobbering pending_close.
        replies.clear()
        self.studio.pending_close = "keep-pending"
        self.studio.post(
            "media-bad-sig",
            "save_media_native",
            json.dumps({"body": base64.b64encode(b"not-a-png").decode("ascii"), "mimeType": "image/png", "filename": "bad.png"}),
        )
        self._pump_until(lambda: len(replies) == 1, timeout=5.0)
        self.assertEqual(replies[0][0], "media-bad-sig")
        self.assertEqual(replies[0][1], "null")
        self.assertIn("Media bytes do not match", replies[0][2])
        self.assertEqual(self.studio.pending_close, "keep-pending")

    def test_failed_async_save_as_cleans_reservation_and_window_close_drains_cleanly(self):
        # 1. Failed background saveAs cleans up reserved 0-byte file.
        tab = self.studio._note("Draft.smd", "# Draft\n", "", "", {}, True)
        self.studio.tabs = [tab]
        self.studio.active = tab["id"]
        rev = self._rev("# Draft\n")

        with patch("studio.write_portable", side_effect=OSError("disk full")):
            errors: list[Exception] = []
            worker = threading.Thread(
                target=lambda: self._capture_error(
                    lambda: self.client.document_action(
                        tab["id"], "save_document", expected_revision=rev, filename="reserved-fail.smd", save_as=True
                    ),
                    errors,
                ),
                daemon=True,
            )
            worker.start()
            self._pump_until(lambda: not worker.is_alive(), timeout=5.0)
            worker.join(timeout=1.0)

        self.assertEqual(len(errors), 1)
        self.assertIn("disk full", str(errors[0]))
        self.assertFalse((self.root / "reserved-fail.smd").exists())

        # 2. Closing/retiring a window during an active background save wakes the caller and drains cleanly.
        entered = threading.Event()
        finish = threading.Event()
        real_write = documents.write_portable

        def gated_write(path, md, assets):
            entered.set()
            finish.wait(timeout=5.0)
            return real_write(path, md, assets)

        retire_errors: list[Exception] = []
        with patch("studio.write_portable", side_effect=gated_write):
            retire_thread = threading.Thread(
                target=lambda: self._capture_error(
                    lambda: self.client.document_action(
                        tab["id"], "save_document", expected_revision=rev, filename="closing-save.smd", save_as=True
                    ),
                    retire_errors,
                ),
                daemon=True,
            )
            retire_thread.start()
            self._pump_until(entered.is_set, timeout=5.0)

            # Retire the window while the background write is still running on session.writes.
            t_stop = time.perf_counter()
            self.studio.stop()
            self._pump_until(lambda: not retire_thread.is_alive(), timeout=2.0)
            stop_wait_ms = (time.perf_counter() - t_stop) * 1000.0
            self.assertLess(stop_wait_ms, 500.0)
            self.assertEqual(len(retire_errors), 1)
            self.assertIn("window was closed", str(retire_errors[0]))

            # Let the queued write finish and verify shutdown drains without deadlocking.
            finish.set()
            self.session.writes.shutdown(wait=True)

        self.assertTrue((self.root / "closing-save.smd").is_file())
        self.assertEqual(open_note(self.root / "closing-save.smd")[0], "# Draft\n")


if __name__ == "__main__":
    unittest.main()
