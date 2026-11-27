"""Desktop tests for durable inactive-tab patch_tab recovery acknowledgment, timeouts, retries, and closed-window lifecycle."""
from __future__ import annotations

import hashlib
import json
import os
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest.mock import patch

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
os.environ.setdefault("QT_QUICK_BACKEND", "software")

from PySide6.QtCore import QObject
from PySide6.QtQuickControls2 import QQuickStyle
from PySide6.QtTest import QTest
from PySide6.QtWidgets import QApplication

import agent_live
import documents as documents_module
import studio as studio_module
from core.background_service import BackgroundService
from studio import ROOT, Session, Studio


class QuietStudio(Studio):
    def _refresh_theme(self):
        self.system_dark = True


class _DummyApp(QObject):
    def __init__(self):
        super().__init__()
        self.ended = False
        self.keep = False

    def setQuitOnLastWindowClosed(self, value: bool):
        self.keep = not value

    def quit(self):
        self.ended = True


class _VisibleHost:
    def __init__(self, visible: bool = True):
        self._visible = visible

    def isVisible(self) -> bool:
        return self._visible

    def show(self):
        self._visible = True

    def hide(self):
        self._visible = False


class DesktopAgentStagingRecoveryTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if QApplication.instance() is None:
            QQuickStyle.setStyle("Material")
        cls.app = QApplication.instance() or QApplication(["Super MD desktop agent staging recovery tests"])

    def make_studio(self, root: Path | None = None):
        session = Session(True, data=root)
        studio = QuietStudio(True, session)
        studio.settings["welcomed"] = True
        studio.settings["autosave"] = True
        studio._emit(False)
        return session, studio

    def dispose(self, session: Session, studio: Studio):
        studio.stop()
        studio.pool.shutdown(wait=True, cancel_futures=True)
        session.writes.shutdown(wait=True)
        self.app.processEvents()

    def _start_live_bridge(self, session: Session, studio: Studio):
        bridge = agent_live.create_qt_bridge(session, session.data)
        session.agent_bridge = bridge

        def on_agent_request(raw: str):
            request = json.loads(raw)
            rid = request["requestId"]
            action = request["action"]
            if action == "flush_current":
                bridge.complete(rid, {"flushed": True}, window_id=studio.window_id)
            elif action == "list_tabs":
                bridge.complete(rid, {"tabs": request["tabs"]}, window_id=studio.window_id)

        studio.agentRequest.connect(on_agent_request)
        bridge.start()
        client = agent_live.LiveTabClient(bridge.discovery_path, timeout=10.0)
        return bridge, client

    def _call_client_pumping_qt(self, fn, timeout: float = 8.0):
        outcome: dict = {}
        done = threading.Event()

        def worker():
            try:
                outcome["result"] = fn()
            except BaseException as exc:
                outcome["error"] = exc
            finally:
                done.set()

        thread = threading.Thread(target=worker, daemon=True)
        thread.start()
        deadline = time.monotonic() + timeout
        while not done.is_set() and time.monotonic() < deadline:
            self.app.processEvents()
            time.sleep(0.005)
        self.app.processEvents()
        thread.join(timeout=1.0)
        self.assertTrue(done.is_set(), "LiveTabClient call did not finish before timeout")
        if "error" in outcome:
            raise outcome["error"]
        return outcome.get("result")

    def test_inactive_tab_patch_stages_recovery_pauses_autosave_until_activated_or_saved(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            active_file = root / "Active.md"
            bg_file = root / "Background.md"
            manual_file = root / "ManualSave.md"
            active_initial = "# Active Note\n\nUser is typing here.\n"
            bg_initial = "# Background Note\n\nOriginal disk text.\n"
            manual_initial = "# Manual Note\n\nStep 0.\n"
            active_file.write_text(active_initial, encoding="utf-8")
            bg_file.write_text(bg_initial, encoding="utf-8")
            manual_file.write_text(manual_initial, encoding="utf-8")

            session, studio = self.make_studio(root)
            try:
                active_tab = studio._note("Active.md", active_initial, str(active_file), saved=active_initial)
                bg_tab = studio._note("Background.md", bg_initial, str(bg_file), saved=bg_initial)
                manual_tab = studio._note("ManualSave.md", manual_initial, str(manual_file), saved=manual_initial)
                studio.tabs = [active_tab, bg_tab, manual_tab]
                studio.active = active_tab["id"]
                studio.ready = True
                studio._emit(True)

                expected_rev = hashlib.sha256(bg_initial.encode("utf-8")).hexdigest()
                patch_result = studio._agent_document_action({
                    "action": "patch_tab",
                    "tabId": bg_tab["id"],
                    "expectedRevision": expected_rev,
                    "operations": [{"type": "replace", "old": "Original disk text.", "new": "Staged AI text."}],
                })
                self.assertTrue(patch_result["changed"])
                self.assertEqual(studio.active, active_tab["id"])
                self.assertTrue(bg_tab["agent_staged"])

                recovery_path = root / "recovery.json"
                self.assertTrue(recovery_path.is_file())
                data = json.loads(recovery_path.read_text(encoding="utf-8"))
                recovered = next((item for item in data if item["id"] == bg_tab["id"]), None)
                self.assertIsNotNone(recovered)
                self.assertIn("Staged AI text.", recovered["content"])
                self.assertTrue(recovered["agent_staged"])

                # Autosave skips staged inactive tabs so disk stays untouched until user activates or saves.
                studio._autosave()
                QTest.qWait(60)
                self.assertEqual(bg_file.read_text(encoding="utf-8"), bg_initial)

                # Selecting the tab clears agent_staged and resumes normal autosave to disk.
                studio.selectTab(bg_tab["id"])
                self.assertEqual(studio.active, bg_tab["id"])
                self.assertFalse(bg_tab["agent_staged"])
                studio._autosave()
                save_deadline = time.monotonic() + 2.0
                while time.monotonic() < save_deadline and bg_file.read_text(encoding="utf-8") == bg_initial:
                    self.app.processEvents()
                    time.sleep(0.01)
                self.assertIn("Staged AI text.", bg_file.read_text(encoding="utf-8"))

                # Explicit save_document on a staged inactive tab writes directly to disk and clears agent_staged.
                manual_rev0 = hashlib.sha256(manual_initial.encode("utf-8")).hexdigest()
                studio._agent_document_action({
                    "action": "patch_tab",
                    "tabId": manual_tab["id"],
                    "expectedRevision": manual_rev0,
                    "operations": [{"type": "replace", "old": "Step 0.", "new": "Step 1."}],
                })
                self.assertTrue(manual_tab["agent_staged"])
                self.assertEqual(manual_file.read_text(encoding="utf-8"), manual_initial)

                manual_rev1 = hashlib.sha256(manual_tab["content"].encode("utf-8")).hexdigest()
                saved = studio._agent_document_action({
                    "action": "save_document",
                    "tabId": manual_tab["id"],
                    "expectedRevision": manual_rev1,
                })
                self.assertFalse(saved["isDirty"])
                self.assertFalse(manual_tab["agent_staged"])
                self.assertEqual(studio.active, bg_tab["id"])
                self.assertEqual(manual_file.read_text(encoding="utf-8"), "# Manual Note\n\nStep 1.\n")
            finally:
                self.dispose(session, studio)

    def test_inactive_patch_tab_delayed_recovery_write_waits_for_exact_commit_without_focus_steal(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            active_file = root / "Active.md"
            bg_file = root / "Background.md"
            active_initial = "# Active\n\nFocused note.\n"
            bg_initial = "# Background\n\nBefore delayed stage.\n"
            active_file.write_text(active_initial, encoding="utf-8")
            bg_file.write_text(bg_initial, encoding="utf-8")

            session, studio = self.make_studio(root)
            bridge = None
            try:
                active_tab = studio._note("Active.md", active_initial, str(active_file), saved=active_initial)
                bg_tab = studio._note("Background.md", bg_initial, str(bg_file), saved=bg_initial)
                studio.tabs = [active_tab, bg_tab]
                studio.active = active_tab["id"]
                studio.ready = True
                studio._emit(True)
                bridge, client = self._start_live_bridge(session, studio)

                real_atomic_json = studio_module.atomic_json
                write_started = threading.Event()
                release_write = threading.Event()
                recovery_path = (session.data / "recovery.json").resolve()

                def gated_atomic_json(path, payload):
                    if Path(path).resolve() == recovery_path:
                        write_started.set()
                        self.assertTrue(release_write.wait(5.0))
                    return real_atomic_json(path, payload)

                expected_rev = hashlib.sha256(bg_initial.encode("utf-8")).hexdigest()
                call_done = threading.Event()
                call_box: dict = {}

                with patch.object(studio_module, "atomic_json", side_effect=gated_atomic_json):
                    def run_patch():
                        try:
                            call_box["result"] = client.patch_tab(
                                bg_tab["id"],
                                expected_rev,
                                [{"type": "replace", "old": "Before delayed stage.", "new": "After delayed stage."}],
                                window_id=studio.window_id,
                            )
                        except BaseException as exc:
                            call_box["error"] = exc
                        finally:
                            call_done.set()

                    worker = threading.Thread(target=run_patch, daemon=True)
                    worker.start()

                    wait_deadline = time.monotonic() + 3.0
                    while not write_started.is_set() and time.monotonic() < wait_deadline:
                        self.app.processEvents()
                        time.sleep(0.005)
                    self.assertTrue(write_started.is_set(), "Expected recovery.json write to begin")

                    # Pump Qt events while the recovery write is held open:
                    # patch_tab MUST NOT return prematurely, UI stays responsive,
                    # focus stays on Active.md, and uncommitted content is not exposed in memory.
                    ui_ticks = 0
                    hold_until = time.monotonic() + 0.08
                    while time.monotonic() < hold_until:
                        self.app.processEvents()
                        ui_ticks += 1
                        time.sleep(0.005)
                    self.assertGreater(ui_ticks, 3)
                    self.assertFalse(call_done.is_set(), "patch_tab returned before recovery.json committed")
                    self.assertFalse(recovery_path.exists())
                    self.assertEqual(studio.active, active_tab["id"])
                    self.assertEqual(bg_tab["content"], bg_initial)
                    self.assertEqual(bg_file.read_text(encoding="utf-8"), bg_initial)

                    # Release the recovery write and verify exact commit before acknowledgment.
                    release_write.set()
                    finish_deadline = time.monotonic() + 3.0
                    while not call_done.is_set() and time.monotonic() < finish_deadline:
                        self.app.processEvents()
                        time.sleep(0.005)
                    worker.join(timeout=1.0)

                self.assertNotIn("error", call_box)
                result = call_box["result"]
                expected_after = "# Background\n\nAfter delayed stage.\n"
                self.assertTrue(result["changed"])
                self.assertEqual(result["revision"], hashlib.sha256(expected_after.encode("utf-8")).hexdigest())

                # Immediately on return, recovery.json already holds the exact staged snapshot.
                self.assertTrue(recovery_path.is_file())
                recovered = json.loads(recovery_path.read_text(encoding="utf-8"))
                bg_entry = next(item for item in recovered if item["id"] == bg_tab["id"])
                self.assertEqual(bg_entry["content"], expected_after)
                self.assertTrue(bg_entry["agent_staged"])

                # Staged content is preserved, focus never moved, and autosave skips staged tab.
                self.assertEqual(studio.active, active_tab["id"])
                self.assertEqual(bg_tab["content"], expected_after)
                self.assertTrue(bg_tab["agent_staged"])
                studio._autosave()
                QTest.qWait(40)
                self.assertEqual(bg_file.read_text(encoding="utf-8"), bg_initial)
            finally:
                if bridge is not None:
                    bridge.stop()
                self.dispose(session, studio)

    def test_inactive_patch_tab_failed_write_never_strands_memory_edit_and_retry_succeeds(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            active_file = root / "Active.md"
            bg_file = root / "Background.md"
            active_initial = "# Active\n\nKeep focus here.\n"
            bg_v0 = "# Background\n\nVersion 0 on disk.\n"
            active_file.write_text(active_initial, encoding="utf-8")
            bg_file.write_text(bg_v0, encoding="utf-8")

            session, studio = self.make_studio(root)
            bridge = None
            try:
                active_tab = studio._note("Active.md", active_initial, str(active_file), saved=active_initial)
                bg_tab = studio._note("Background.md", bg_v0, str(bg_file), saved=bg_v0)
                studio.tabs = [active_tab, bg_tab]
                studio.active = active_tab["id"]
                studio.ready = True
                studio._emit(True)
                bridge, client = self._start_live_bridge(session, studio)

                real_atomic_json = studio_module.atomic_json
                recovery_path = (session.data / "recovery.json").resolve()
                fail_recovery = True

                def flaky_atomic_json(path, payload):
                    if fail_recovery and Path(path).resolve() == recovery_path:
                        raise OSError("/private/secret/recovery.json: No space left on device")
                    return real_atomic_json(path, payload)

                rev_v0 = hashlib.sha256(bg_v0.encode("utf-8")).hexdigest()
                ops_v1 = [{"type": "replace", "old": "Version 0 on disk.", "new": "Version 1 staged."}]

                with patch.object(studio_module, "atomic_json", side_effect=flaky_atomic_json):
                    # 1. Forced failure on v0 -> v1 reports recoverable failure without stranding memory-only edit.
                    with self.assertRaises(agent_live.LiveBridgeError) as first_err:
                        self._call_client_pumping_qt(
                            lambda: client.patch_tab(bg_tab["id"], rev_v0, ops_v1, window_id=studio.window_id)
                        )
                    err_msg = str(first_err.exception)
                    self.assertIn("Could not save draft recovery snapshot", err_msg)
                    self.assertNotIn("/private/secret", err_msg)
                    self.assertNotIn("revision", err_msg.casefold())

                    self.assertEqual(studio.active, active_tab["id"])
                    self.assertEqual(bg_tab["content"], bg_v0)
                    self.assertFalse(bg_tab["agent_staged"])
                    self.assertFalse(recovery_path.exists())
                    self.assertEqual(bg_file.read_text(encoding="utf-8"), bg_v0)

                    # 2. Retry with the SAME expectedRevision succeeds once recovery writes are healthy.
                    fail_recovery = False
                    res_v1 = self._call_client_pumping_qt(
                        lambda: client.patch_tab(bg_tab["id"], rev_v0, ops_v1, window_id=studio.window_id)
                    )
                    bg_v1 = "# Background\n\nVersion 1 staged.\n"
                    rev_v1 = hashlib.sha256(bg_v1.encode("utf-8")).hexdigest()
                    self.assertEqual(res_v1["revision"], rev_v1)
                    self.assertEqual(studio.active, active_tab["id"])
                    self.assertEqual(bg_tab["content"], bg_v1)
                    self.assertTrue(bg_tab["agent_staged"])

                    recovered_v1 = json.loads(recovery_path.read_text(encoding="utf-8"))
                    entry_v1 = next(item for item in recovered_v1 if item["id"] == bg_tab["id"])
                    self.assertEqual(entry_v1["content"], bg_v1)
                    self.assertEqual(bg_file.read_text(encoding="utf-8"), bg_v0)

                    # 3. Forced failure on v1 -> v2 preserves already-committed staged v1 in both memory and recovery.json.
                    fail_recovery = True
                    ops_v2 = [{"type": "replace", "old": "Version 1 staged.", "new": "Version 2 staged."}]
                    with self.assertRaises(agent_live.LiveBridgeError) as second_err:
                        self._call_client_pumping_qt(
                            lambda: client.patch_tab(bg_tab["id"], rev_v1, ops_v2, window_id=studio.window_id)
                        )
                    self.assertIn("Could not save draft recovery snapshot", str(second_err.exception))
                    self.assertEqual(studio.active, active_tab["id"])
                    self.assertEqual(bg_tab["content"], bg_v1)
                    self.assertTrue(bg_tab["agent_staged"])
                    recovered_still_v1 = json.loads(recovery_path.read_text(encoding="utf-8"))
                    self.assertEqual(
                        next(item for item in recovered_still_v1 if item["id"] == bg_tab["id"])["content"],
                        bg_v1,
                    )

                    # 4. Retry v1 -> v2 with rev_v1 succeeds and preserves staged content + no focus steal.
                    fail_recovery = False
                    res_v2 = self._call_client_pumping_qt(
                        lambda: client.patch_tab(bg_tab["id"], rev_v1, ops_v2, window_id=studio.window_id)
                    )
                    bg_v2 = "# Background\n\nVersion 2 staged.\n"
                    self.assertEqual(res_v2["revision"], hashlib.sha256(bg_v2.encode("utf-8")).hexdigest())
                    self.assertEqual(studio.active, active_tab["id"])
                    self.assertEqual(bg_tab["content"], bg_v2)
                    self.assertTrue(bg_tab["agent_staged"])
                    recovered_v2 = json.loads(recovery_path.read_text(encoding="utf-8"))
                    self.assertEqual(
                        next(item for item in recovered_v2 if item["id"] == bg_tab["id"])["content"],
                        bg_v2,
                    )
                    studio._autosave()
                    QTest.qWait(40)
                    self.assertEqual(bg_file.read_text(encoding="utf-8"), bg_v0)
            finally:
                if bridge is not None:
                    bridge.stop()
                self.dispose(session, studio)

    def test_inactive_patch_tab_superseded_write_restages_or_reports_superseded_and_allows_retry(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            active_file = root / "Active.md"
            bg_file = root / "Background.md"
            active_initial = "# Active\n\nInitial active.\n"
            bg_initial = "# Background\n\nStep A.\n"
            active_file.write_text(active_initial, encoding="utf-8")
            bg_file.write_text(bg_initial, encoding="utf-8")

            session, studio = self.make_studio(root)
            bridge = None
            try:
                active_tab = studio._note("Active.md", active_initial, str(active_file), saved=active_initial)
                bg_tab = studio._note("Background.md", bg_initial, str(bg_file), saved=bg_initial)
                studio.tabs = [active_tab, bg_tab]
                studio.active = active_tab["id"]
                studio.ready = True
                studio._emit(True)
                bridge, client = self._start_live_bridge(session, studio)

                real_atomic_json = studio_module.atomic_json
                recovery_path = (session.data / "recovery.json").resolve()

                # Part A: Single overlapping _recover() supersedes attempt 1; Studio re-stages combined drafts cleanly.
                superseded_once = False

                def supersede_first_stage(path, payload):
                    nonlocal superseded_once
                    real_atomic_json(path, payload)
                    if (
                        not superseded_once
                        and Path(path).resolve() == recovery_path
                        and any(item.get("id") == bg_tab["id"] for item in payload)
                    ):
                        superseded_once = True
                        active_tab["content"] = "# Active\n\nConcurrent user edit.\n"
                        session.writes.submit_latest(
                            "recovery",
                            lambda: real_atomic_json(
                                recovery_path,
                                studio._combined_recovery_drafts(studio._window_recovery_drafts()),
                            ),
                        )

                rev_a = hashlib.sha256(bg_initial.encode("utf-8")).hexdigest()
                with patch.object(studio_module, "atomic_json", side_effect=supersede_first_stage):
                    res_b = self._call_client_pumping_qt(
                        lambda: client.patch_tab(
                            bg_tab["id"],
                            rev_a,
                            [{"type": "replace", "old": "Step A.", "new": "Step B."}],
                            window_id=studio.window_id,
                        )
                    )
                self.assertTrue(superseded_once)
                bg_step_b = "# Background\n\nStep B.\n"
                rev_b = hashlib.sha256(bg_step_b.encode("utf-8")).hexdigest()
                self.assertEqual(res_b["revision"], rev_b)
                self.assertEqual(studio.active, active_tab["id"])
                session.writes.flush(timeout=2.0)
                combined_on_disk = {item["id"]: item for item in json.loads(recovery_path.read_text(encoding="utf-8"))}
                self.assertEqual(combined_on_disk[active_tab["id"]]["content"], "# Active\n\nConcurrent user edit.\n")
                self.assertEqual(combined_on_disk[bg_tab["id"]]["content"], bg_step_b)
                self.assertTrue(combined_on_disk[bg_tab["id"]]["agent_staged"])

                # Part B: Continuous supersession across bounded attempts reports superseded accurately without mutating tab.
                studio._max_agent_stage_attempts = 2
                always_supersede = True

                def supersede_every_stage(path, payload):
                    real_atomic_json(path, payload)
                    if (
                        always_supersede
                        and Path(path).resolve() == recovery_path
                        and any(item.get("id") == bg_tab["id"] and "Step C." in item.get("content", "") for item in payload)
                    ):
                        session.writes.submit_latest(
                            "recovery",
                            lambda: real_atomic_json(
                                recovery_path,
                                studio._combined_recovery_drafts(studio._window_recovery_drafts()),
                            ),
                        )

                ops_c = [{"type": "replace", "old": "Step B.", "new": "Step C."}]
                with patch.object(studio_module, "atomic_json", side_effect=supersede_every_stage):
                    with self.assertRaises(agent_live.LiveBridgeError) as sup_err:
                        self._call_client_pumping_qt(
                            lambda: client.patch_tab(bg_tab["id"], rev_b, ops_c, window_id=studio.window_id)
                        )
                    sup_msg = str(sup_err.exception)
                    self.assertIn("superseded", sup_msg)
                    self.assertNotIn("revision", sup_msg.casefold())

                    # Previous staged Step B remains intact in both memory and recovery.json; focus stays on Active.md.
                    session.writes.flush(timeout=2.0)
                    self.assertEqual(studio.active, active_tab["id"])
                    self.assertEqual(bg_tab["content"], bg_step_b)
                    self.assertTrue(bg_tab["agent_staged"])
                    after_sup = {item["id"]: item for item in json.loads(recovery_path.read_text(encoding="utf-8"))}
                    self.assertEqual(after_sup[bg_tab["id"]]["content"], bg_step_b)

                    # Once supersession stops, retrying with the same rev_b succeeds cleanly.
                    always_supersede = False
                    res_c = self._call_client_pumping_qt(
                        lambda: client.patch_tab(bg_tab["id"], rev_b, ops_c, window_id=studio.window_id)
                    )
                    bg_step_c = "# Background\n\nStep C.\n"
                    self.assertEqual(res_c["revision"], hashlib.sha256(bg_step_c.encode("utf-8")).hexdigest())
                    self.assertEqual(studio.active, active_tab["id"])
                    self.assertEqual(bg_tab["content"], bg_step_c)
                    after_retry = {item["id"]: item for item in json.loads(recovery_path.read_text(encoding="utf-8"))}
                    self.assertEqual(after_retry[bg_tab["id"]]["content"], bg_step_c)
                    self.assertEqual(bg_file.read_text(encoding="utf-8"), bg_initial)
            finally:
                if bridge is not None:
                    bridge.stop()
                self.dispose(session, studio)

    def test_direct_agent_document_action_patch_tab_waits_fails_cleanly_and_retries(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            active_file = root / "Active.md"
            bg_file = root / "Background.md"
            active_initial = "# Active\n"
            bg_initial = "# Background\n\nDirect call.\n"
            active_file.write_text(active_initial, encoding="utf-8")
            bg_file.write_text(bg_initial, encoding="utf-8")

            session, studio = self.make_studio(root)
            try:
                active_tab = studio._note("Active.md", active_initial, str(active_file), saved=active_initial)
                bg_tab = studio._note("Background.md", bg_initial, str(bg_file), saved=bg_initial)
                studio.tabs = [active_tab, bg_tab]
                studio.active = active_tab["id"]

                real_atomic_json = studio_module.atomic_json
                recovery_path = (session.data / "recovery.json").resolve()
                rev0 = hashlib.sha256(bg_initial.encode("utf-8")).hexdigest()
                ops = [{"type": "replace", "old": "Direct call.", "new": "Direct staged."}]

                # 1. Forced write failure raises RuntimeError, leaves memory + disk clean, and allows same-revision retry.
                with patch.object(
                    studio_module,
                    "atomic_json",
                    side_effect=lambda path, payload: (
                        (_ for _ in ()).throw(OSError("forced failure"))
                        if Path(path).resolve() == recovery_path
                        else real_atomic_json(path, payload)
                    ),
                ):
                    with self.assertRaisesRegex(RuntimeError, "Could not save draft recovery snapshot"):
                        studio._agent_document_action({
                            "action": "patch_tab",
                            "tabId": bg_tab["id"],
                            "expectedRevision": rev0,
                            "operations": ops,
                        })
                self.assertEqual(bg_tab["content"], bg_initial)
                self.assertFalse(bg_tab["agent_staged"])
                self.assertFalse(recovery_path.exists())
                self.assertEqual(studio.active, active_tab["id"])

                # 2. Delayed write blocks return until recovery.json is durably written, then retry succeeds.
                write_started = threading.Event()
                release_write = threading.Event()
                finished = threading.Event()
                box: dict = {}

                def delayed_atomic_json(path, payload):
                    if Path(path).resolve() == recovery_path:
                        write_started.set()
                        self.assertTrue(release_write.wait(5.0))
                    return real_atomic_json(path, payload)

                with patch.object(studio_module, "atomic_json", side_effect=delayed_atomic_json):
                    t = threading.Thread(
                        target=lambda: (
                            box.setdefault(
                                "result",
                                studio._agent_document_action({
                                    "action": "patch_tab",
                                    "tabId": bg_tab["id"],
                                    "expectedRevision": rev0,
                                    "operations": ops,
                                }),
                            ),
                            finished.set(),
                        ),
                        daemon=True,
                    )
                    t.start()
                    self.assertTrue(write_started.wait(2.0))
                    time.sleep(0.05)
                    self.assertFalse(finished.is_set())
                    self.assertEqual(bg_tab["content"], bg_initial)
                    release_write.set()
                    self.assertTrue(finished.wait(2.0))
                    t.join(timeout=1.0)

                expected_after = "# Background\n\nDirect staged.\n"
                self.assertEqual(box["result"]["revision"], hashlib.sha256(expected_after.encode("utf-8")).hexdigest())
                self.assertEqual(bg_tab["content"], expected_after)
                self.assertTrue(bg_tab["agent_staged"])
                self.assertEqual(studio.active, active_tab["id"])
                recovered = {item["id"]: item for item in json.loads(recovery_path.read_text(encoding="utf-8"))}
                self.assertEqual(recovered[bg_tab["id"]]["content"], expected_after)
                self.assertEqual(bg_file.read_text(encoding="utf-8"), bg_initial)
            finally:
                self.dispose(session, studio)

    def test_direct_patch_tab_timeout_is_atomic_with_recovery_publication_for_running_and_queued_writes(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            state_dir = root / "state"
            notes_dir = root / "notes"
            notes_dir.mkdir(parents=True, exist_ok=True)
            active_file = notes_dir / "Active.md"
            bg_file = notes_dir / "Background.md"
            active_saved = "# Active\n\nSaved baseline.\n"
            active_dirty = "# Active\n\nUnsaved active draft.\n"
            bg_initial = "# Background\n\nOriginal paragraph.\n"
            active_file.write_text(active_saved, encoding="utf-8")
            bg_file.write_text(bg_initial, encoding="utf-8")

            session, studio = self.make_studio(state_dir)
            try:
                studio._agent_stage_sync_timeout = 0.08
                active_tab = studio._note("Active.md", active_dirty, str(active_file), saved=active_saved)
                bg_tab = studio._note("Background.md", bg_initial, str(bg_file), saved=bg_initial)
                studio.tabs = [active_tab, bg_tab]
                studio.active = active_tab["id"]
                studio._recover()
                session.writes.flush(timeout=2.0)

                recovery_path = (session.data / "recovery.json").resolve()
                rev0 = hashlib.sha256(bg_initial.encode("utf-8")).hexdigest()

                def assert_recovery_excludes_rejected(marker: str, expected_bg: str | None = None):
                    raw_text = recovery_path.read_text(encoding="utf-8")
                    self.assertNotIn(marker, raw_text)
                    entries = {item["id"]: item for item in json.loads(raw_text)}
                    self.assertEqual(entries[active_tab["id"]]["content"], active_dirty)
                    if expected_bg is None:
                        self.assertNotIn(bg_tab["id"], entries)
                    else:
                        self.assertEqual(entries[bg_tab["id"]]["content"], expected_bg)
                    self.assertEqual(list(session.data.glob(".recovery.json.*.tmp")), [])

                    restarted_session, restarted_studio = self.make_studio(state_dir)
                    try:
                        restored_by_id = {item["id"]: item for item in restarted_studio.tabs}
                        self.assertNotIn(marker, json.dumps(restarted_studio.tabs))
                        if expected_bg is None:
                            self.assertNotIn(bg_tab["id"], restored_by_id)
                        else:
                            self.assertEqual(restored_by_id[bg_tab["id"]]["content"], expected_bg)
                    finally:
                        self.dispose(restarted_session, restarted_studio)

                # 1. Running write held at an inside-writer barrier inside documents._write_json_value past timeout.
                real_write_json = documents_module._write_json_value
                inside_writer = threading.Event()
                release_running = threading.Event()
                hold_inside = True

                def held_write_json(raw, value, seen):
                    if (
                        hold_inside
                        and isinstance(value, list)
                        and any(isinstance(it, dict) and "Rejected running patch." in it.get("content", "") for it in value)
                    ):
                        inside_writer.set()
                        self.assertTrue(release_running.wait(5.0))
                    return real_write_json(raw, value, seen)

                running_ops = [{"type": "replace", "old": "Original paragraph.", "new": "Rejected running patch."}]
                call_err: list[BaseException] = []
                with patch.object(documents_module, "_write_json_value", side_effect=held_write_json):
                    worker = threading.Thread(
                        target=lambda: self._capture_exception(
                            call_err,
                            lambda: studio._agent_document_action({
                                "action": "patch_tab",
                                "tabId": bg_tab["id"],
                                "expectedRevision": rev0,
                                "operations": running_ops,
                            }),
                        ),
                        daemon=True,
                    )
                    worker.start()
                    self.assertTrue(inside_writer.wait(2.0))
                    worker.join(timeout=2.0)
                    self.assertFalse(worker.is_alive())
                    self.assertEqual(len(call_err), 1)
                    self.assertIsInstance(call_err[0], RuntimeError)
                    self.assertIn("Could not save draft recovery snapshot", str(call_err[0]))

                    # Release the in-flight writer and drain completely: rejected patch must never be published.
                    hold_inside = False
                    release_running.set()
                    session.writes.flush(timeout=2.0)

                self.assertEqual(bg_file.read_text(encoding="utf-8"), bg_initial)
                self.assertEqual(bg_tab["content"], bg_initial)
                self.assertFalse(bg_tab["agent_staged"])
                self.assertEqual(studio.active, active_tab["id"])
                assert_recovery_excludes_rejected("Rejected running patch.", expected_bg=None)

                # 2. Queued write held behind an earlier ordered-writer job past timeout.
                fifo_started = threading.Event()
                release_fifo = threading.Event()
                blocker = session.writes.submit(lambda: (fifo_started.set(), self.assertTrue(release_fifo.wait(5.0))))
                self.assertTrue(fifo_started.wait(2.0))

                queued_ops = [{"type": "replace", "old": "Original paragraph.", "new": "Rejected queued patch."}]
                with self.assertRaisesRegex(RuntimeError, "Could not save draft recovery snapshot"):
                    studio._agent_document_action({
                        "action": "patch_tab",
                        "tabId": bg_tab["id"],
                        "expectedRevision": rev0,
                        "operations": queued_ops,
                    })

                release_fifo.set()
                blocker.result(timeout=2.0)
                session.writes.flush(timeout=2.0)

                self.assertEqual(bg_file.read_text(encoding="utf-8"), bg_initial)
                self.assertEqual(bg_tab["content"], bg_initial)
                self.assertFalse(bg_tab["agent_staged"])
                assert_recovery_excludes_rejected("Rejected queued patch.", expected_bg=None)

                # 3. Same-revision retry with rev0 succeeds cleanly and persists v1 to recovery.json.
                retry_ops = [{"type": "replace", "old": "Original paragraph.", "new": "Accepted v1 patch."}]
                res_v1 = studio._agent_document_action({
                    "action": "patch_tab",
                    "tabId": bg_tab["id"],
                    "expectedRevision": rev0,
                    "operations": retry_ops,
                })
                bg_v1 = "# Background\n\nAccepted v1 patch.\n"
                rev1 = hashlib.sha256(bg_v1.encode("utf-8")).hexdigest()
                self.assertEqual(res_v1["revision"], rev1)
                self.assertEqual(bg_tab["content"], bg_v1)
                self.assertTrue(bg_tab["agent_staged"])
                self.assertEqual(studio.active, active_tab["id"])
                self.assertEqual(bg_file.read_text(encoding="utf-8"), bg_initial)
                assert_recovery_excludes_rejected("Rejected", expected_bg=bg_v1)

                # 4. Holding studio.atomic_json past timeout on v1 -> v2 preserves committed v1 in recovery.json, and retry with rev1 succeeds.
                real_atomic_json = studio_module.atomic_json
                atomic_entered = threading.Event()
                release_atomic = threading.Event()
                hold_atomic = True

                def held_studio_atomic_json(path, payload):
                    if hold_atomic and Path(path).resolve() == recovery_path:
                        atomic_entered.set()
                        self.assertTrue(release_atomic.wait(5.0))
                    return real_atomic_json(path, payload)

                v2_rejected_ops = [{"type": "replace", "old": "Accepted v1 patch.", "new": "Rejected v2 patch."}]
                v2_err: list[BaseException] = []
                with patch.object(studio_module, "atomic_json", side_effect=held_studio_atomic_json):
                    worker2 = threading.Thread(
                        target=lambda: self._capture_exception(
                            v2_err,
                            lambda: studio._agent_document_action({
                                "action": "patch_tab",
                                "tabId": bg_tab["id"],
                                "expectedRevision": rev1,
                                "operations": v2_rejected_ops,
                            }),
                        ),
                        daemon=True,
                    )
                    worker2.start()
                    self.assertTrue(atomic_entered.wait(2.0))
                    worker2.join(timeout=2.0)
                    self.assertFalse(worker2.is_alive())
                    self.assertEqual(len(v2_err), 1)
                    self.assertIn("Could not save draft recovery snapshot", str(v2_err[0]))

                    hold_atomic = False
                    release_atomic.set()
                    session.writes.flush(timeout=2.0)

                self.assertEqual(bg_tab["content"], bg_v1)
                assert_recovery_excludes_rejected("Rejected v2 patch.", expected_bg=bg_v1)

                v2_retry_ops = [{"type": "replace", "old": "Accepted v1 patch.", "new": "Accepted v2 patch."}]
                res_v2 = studio._agent_document_action({
                    "action": "patch_tab",
                    "tabId": bg_tab["id"],
                    "expectedRevision": rev1,
                    "operations": v2_retry_ops,
                })
                bg_v2 = "# Background\n\nAccepted v2 patch.\n"
                self.assertEqual(res_v2["revision"], hashlib.sha256(bg_v2.encode("utf-8")).hexdigest())
                self.assertEqual(bg_tab["content"], bg_v2)
                self.assertEqual(bg_file.read_text(encoding="utf-8"), bg_initial)
                assert_recovery_excludes_rejected("Rejected", expected_bg=bg_v2)
            finally:
                self.dispose(session, studio)

    def test_live_bridge_patch_tab_timeout_aborts_inflight_recovery_write_and_allows_retry(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            state_dir = root / "state"
            notes_dir = root / "notes"
            notes_dir.mkdir(parents=True, exist_ok=True)
            active_file = notes_dir / "Active.md"
            bg_file = notes_dir / "Background.md"
            active_initial = "# Active\n\nFocus stays here.\n"
            bg_initial = "# Background\n\nAsync baseline.\n"
            active_file.write_text(active_initial, encoding="utf-8")
            bg_file.write_text(bg_initial, encoding="utf-8")

            session, studio = self.make_studio(state_dir)
            bridge = None
            try:
                active_tab = studio._note("Active.md", active_initial, str(active_file), saved=active_initial)
                bg_tab = studio._note("Background.md", bg_initial, str(bg_file), saved=bg_initial)
                studio.tabs = [active_tab, bg_tab]
                studio.active = active_tab["id"]
                studio.ready = True
                studio._emit(True)
                bridge, client = self._start_live_bridge(session, studio)

                real_atomic_json = studio_module.atomic_json
                recovery_path = (session.data / "recovery.json").resolve()
                rev0 = hashlib.sha256(bg_initial.encode("utf-8")).hexdigest()
                entered = threading.Event()
                release = threading.Event()
                hold = True

                def held_atomic_json(path, payload):
                    if hold and Path(path).resolve() == recovery_path:
                        entered.set()
                        self.assertTrue(release.wait(5.0))
                    return real_atomic_json(path, payload)

                rejected_ops = [{"type": "replace", "old": "Async baseline.", "new": "Rejected bridge timeout."}]
                with patch.object(agent_live, "REQUEST_TIMEOUT", 0.12), patch.object(
                    studio_module, "atomic_json", side_effect=held_atomic_json
                ):
                    with self.assertRaises(agent_live.LiveBridgeError) as timeout_err:
                        self._call_client_pumping_qt(
                            lambda: client.patch_tab(bg_tab["id"], rev0, rejected_ops, window_id=studio.window_id)
                        )
                    self.assertIn("timed out", str(timeout_err.exception).casefold())
                    self.assertTrue(entered.is_set())

                    hold = False
                    release.set()
                    session.writes.flush(timeout=2.0)
                    QTest.qWait(50)

                self.assertEqual(bg_tab["content"], bg_initial)
                self.assertFalse(bg_tab["agent_staged"])
                self.assertEqual(studio.active, active_tab["id"])
                self.assertFalse(recovery_path.exists())

                retry_ops = [{"type": "replace", "old": "Async baseline.", "new": "Accepted after bridge retry."}]
                res = self._call_client_pumping_qt(
                    lambda: client.patch_tab(bg_tab["id"], rev0, retry_ops, window_id=studio.window_id)
                )
                expected_after = "# Background\n\nAccepted after bridge retry.\n"
                self.assertEqual(res["revision"], hashlib.sha256(expected_after.encode("utf-8")).hexdigest())
                self.assertEqual(bg_tab["content"], expected_after)
                self.assertTrue(bg_tab["agent_staged"])
                self.assertEqual(studio.active, active_tab["id"])
                recovered = {item["id"]: item for item in json.loads(recovery_path.read_text(encoding="utf-8"))}
                self.assertEqual(recovered[bg_tab["id"]]["content"], expected_after)
                self.assertEqual(bg_file.read_text(encoding="utf-8"), bg_initial)
            finally:
                if bridge is not None:
                    bridge.stop()
                self.dispose(session, studio)

    def test_closed_window_lifecycle_suspends_live_access_and_aborts_inflight_staged_patch_tab(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            state_dir = root / "state"
            notes_dir = root / "notes"
            notes_dir.mkdir(parents=True, exist_ok=True)
            active_file = notes_dir / "Active.md"
            bg_file = notes_dir / "Background.md"
            active_initial = "# Active\n\nOpen window note.\n"
            bg_initial = "# Background\n\nClosed window baseline.\n"
            active_file.write_text(active_initial, encoding="utf-8")
            bg_file.write_text(bg_initial, encoding="utf-8")

            session, studio = self.make_studio(state_dir)
            bridge = None
            dummy_app = _DummyApp()
            try:
                session.settings["keepInBackground"] = True
                session.settings["agentAccessEnabled"] = True
                studio.host_window = _VisibleHost(visible=True)
                active_tab = studio._note("Active.md", active_initial, str(active_file), saved=active_initial)
                bg_tab = studio._note("Background.md", bg_initial, str(bg_file), saved=bg_initial)
                studio.tabs = [active_tab, bg_tab]
                studio.active = active_tab["id"]
                studio.ready = True
                studio._emit(True)

                bridge, client = self._start_live_bridge(session, studio)
                with patch("core.background_service.QSystemTrayIcon.isSystemTrayAvailable", return_value=False):
                    service = BackgroundService(dummy_app, session, ROOT, lambda _: None, force=False)
                session.background = service
                self.assertTrue(service.enabled)
                self.assertTrue(bridge.enabled)

                real_atomic_json = studio_module.atomic_json
                recovery_path = (session.data / "recovery.json").resolve()
                rev0 = hashlib.sha256(bg_initial.encode("utf-8")).hexdigest()
                entered = threading.Event()
                release = threading.Event()
                hold = True

                def held_atomic_json(path, payload):
                    if hold and Path(path).resolve() == recovery_path:
                        entered.set()
                        self.assertTrue(release.wait(5.0))
                    return real_atomic_json(path, payload)

                inflight_ops = [{"type": "replace", "old": "Closed window baseline.", "new": "Aborted on close."}]
                call_done = threading.Event()
                call_box: dict = {}

                with patch.object(studio_module, "atomic_json", side_effect=held_atomic_json):
                    def run_patch():
                        try:
                            call_box["result"] = client.patch_tab(
                                bg_tab["id"],
                                rev0,
                                inflight_ops,
                                window_id=studio.window_id,
                            )
                        except BaseException as exc:
                            call_box["error"] = exc
                        finally:
                            call_done.set()

                    worker = threading.Thread(target=run_patch, daemon=True)
                    worker.start()

                    wait_deadline = time.monotonic() + 3.0
                    while not entered.is_set() and time.monotonic() < wait_deadline:
                        self.app.processEvents()
                        time.sleep(0.005)
                    self.assertTrue(entered.is_set())

                    # Closing the last visible window without --background --agent-access suspends live access
                    # (#65 lifecycle) and cancels the in-flight staged recovery commit.
                    studio.host_window.hide()
                    service.handle_window_visibility(studio)
                    self.assertFalse(bridge.enabled)

                    hold = False
                    release.set()
                    finish_deadline = time.monotonic() + 3.0
                    while not call_done.is_set() and time.monotonic() < finish_deadline:
                        self.app.processEvents()
                        time.sleep(0.005)
                    worker.join(timeout=1.0)
                    session.writes.flush(timeout=2.0)
                    QTest.qWait(40)

                self.assertIn("error", call_box)
                self.assertEqual(bg_tab["content"], bg_initial)
                self.assertFalse(bg_tab["agent_staged"])
                self.assertFalse(recovery_path.exists())

                # While the window remains hidden without forced CLI background access, live bridge stays off.
                with self.assertRaises(agent_live.LiveBridgeError):
                    client.list_tabs()

                # Reopening the window restores live agent access (#65) and allows same-revision retry.
                studio.host_window.show()
                service.handle_window_visibility(studio)
                self.assertTrue(bridge.enabled)

                reopened_client = agent_live.LiveTabClient(bridge.discovery_path, timeout=10.0)
                retry_ops = [{"type": "replace", "old": "Closed window baseline.", "new": "Staged after reopen."}]
                res = self._call_client_pumping_qt(
                    lambda: reopened_client.patch_tab(bg_tab["id"], rev0, retry_ops, window_id=studio.window_id)
                )
                expected_after = "# Background\n\nStaged after reopen.\n"
                self.assertEqual(res["revision"], hashlib.sha256(expected_after.encode("utf-8")).hexdigest())
                self.assertEqual(bg_tab["content"], expected_after)
                self.assertTrue(bg_tab["agent_staged"])
                recovered = {item["id"]: item for item in json.loads(recovery_path.read_text(encoding="utf-8"))}
                self.assertEqual(recovered[bg_tab["id"]]["content"], expected_after)
                self.assertEqual(bg_file.read_text(encoding="utf-8"), bg_initial)
            finally:
                if bridge is not None:
                    bridge.stop()
                self.dispose(session, studio)

    @staticmethod
    def _capture_exception(sink: list[BaseException], fn):
        try:
            fn()
        except BaseException as exc:
            sink.append(exc)


if __name__ == "__main__":
    unittest.main()
