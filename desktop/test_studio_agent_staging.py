"""Focused unit tests for extracted desktop/studio_agent_staging.py behind the Studio facade."""
from __future__ import annotations

import ast, contextlib, hashlib, json, os, tempfile, threading, time, unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
os.environ.setdefault("QT_QUICK_BACKEND", "software")

from PySide6.QtGui import QGuiApplication
from PySide6.QtQuickControls2 import QQuickStyle

from latest_writes import LatestWriteExecutor
import studio as studio_module
import studio_agent_staging
from studio import Session, Studio


class QuietStudio(Studio):
    def _refresh_theme(self):
        self.system_dark = True


class StudioAgentStagingUnitTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if QGuiApplication.instance() is None:
            QQuickStyle.setStyle("Material")
        cls.app = QGuiApplication.instance() or QGuiApplication(["Super MD studio_agent_staging tests"])

    def make_studio(self, root: Path | None = None):
        session = Session(True, data=root)
        studio = QuietStudio(True, session)
        studio.settings.update(welcomed=True, autosave=True)
        studio._emit(False)
        return session, studio

    def dispose(self, session: Session, studio: Studio):
        studio.stop()
        studio.pool.shutdown(wait=True, cancel_futures=True)
        session.writes.shutdown(wait=True)
        self.app.processEvents()

    def test_module_boundary_has_no_studio_lookup_sys_modules_or_import_error_and_honors_collaborator_patches(self):
        tree = ast.parse(Path(studio_agent_staging.__file__).read_text(encoding="utf-8"), filename=studio_agent_staging.__file__)
        self.assertFalse(hasattr(studio_agent_staging, "_studio_module"))
        for node in ast.walk(tree):
            if isinstance(node, ast.FunctionDef):
                self.assertNotEqual(node.name, "_studio_module")
            elif isinstance(node, ast.Name):
                self.assertNotIn(node.id, {"_studio_module", "ImportError", "sys"})
            elif isinstance(node, ast.Attribute):
                self.assertNotEqual(node.attr, "_studio_module")
                self.assertFalse(isinstance(node.value, ast.Name) and node.value.id == "sys")
            elif isinstance(node, ast.Import):
                self.assertTrue(all(a.name not in {"sys", "studio", "desktop.studio"} for a in node.names))
            elif isinstance(node, ast.ImportFrom):
                self.assertNotIn(node.module, {"sys", "studio", "desktop.studio"})
                self.assertTrue(all(a.name != "studio" for a in node.names))
            elif isinstance(node, ast.ExceptHandler) and node.type is not None:
                self.assertNotIn("ImportError", ast.unparse(node.type))

        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            writes = LatestWriteExecutor()
            try:
                calls: list[str] = []
                real_stage, real_json, real_write = studio_module.stage_atomic_json, studio_module.atomic_json, studio_module.atomic_write
                base = {"assets": {}, "saved_assets": {}, "assets_dirty": False, "portable": False, "conflict": False, "agent_staged": False, "agent_unreviewed": False, "agent_edits": []}
                bg_tab = {"id": "t-bg", "name": "Bg.md", "path": "", "content": "# v0\n", "saved": "# v0\n", **base}
                (root / "recovery.json").write_bytes(b'[{"id":"prior"}]')
                proxy = SimpleNamespace(data=root, window_id="w-c", tabs=[bg_tab], active="t-a", retired=False, writes=writes, session=SimpleNamespace(drafts={}), settings={}, _agent_jump_tab_id="")

                @contextlib.contextmanager
                def unintercepted_stage(_target_path, *, abort_check=None):
                    calls.append("stage_atomic_json")
                    yield SimpleNamespace(intercepted=False, abort_check=abort_check)

                def aborting_json(path, payload):
                    calls.append("atomic_json")
                    Path(path).write_text(json.dumps(payload), encoding="utf-8")
                    bg_tab["content"] = "# concurrent edit\n"

                with (
                    patch.object(studio_module, "stage_atomic_json", side_effect=unintercepted_stage),
                    patch.object(studio_module, "atomic_json", side_effect=aborting_json),
                    patch.object(studio_module, "atomic_write", side_effect=lambda p, d: (calls.append("atomic_write"), real_write(p, d))[1]),
                ):
                    with self.assertRaisesRegex(ValueError, "Live tab revision changed"):
                        Studio._stage_inactive_patch_tab_sync(proxy, "t-bg", "# v0\n", "# v1\n", [{"index": 0}], True)
                self.assertEqual((calls, (root / "recovery.json").read_bytes()), (["stage_atomic_json", "atomic_json", "atomic_write"], b'[{"id":"prior"}]'))

                bg_tab["content"], calls[:] = "# v0\n", []
                with (
                    patch.object(studio_module, "stage_atomic_json", wraps=lambda *a, **kw: (calls.append("stage"), real_stage(*a, **kw))[1]),
                    patch.object(studio_module, "atomic_json", wraps=lambda *a, **kw: (calls.append("json"), real_json(*a, **kw))[1]),
                ):
                    res = Studio._stage_inactive_patch_tab_sync(proxy, "t-bg", "# v0\n", "# v1\n", [{"index": 0}], True)
                self.assertEqual((calls, res["changed"], bg_tab["content"]), (["stage", "json"], True, "# v1\n"))
            finally:
                writes.shutdown(wait=True)

    def test_bound_agent_edits_enforces_60_step_and_2mb_caps_and_append_monotonic_seq(self):
        many = [{"seq": idx, "before": f"b{idx}", "after": f"a{idx}"} for idx in range(1, 75)]
        bounded_count = Studio._bound_agent_edits(many)
        self.assertEqual((len(bounded_count), bounded_count[0]["seq"], bounded_count[-1]["seq"]), (60, 15, 74))

        chunk = "x" * 600_000
        oversized = [{"seq": 1, "before": chunk, "after": chunk}, {"seq": 2, "before": chunk, "after": chunk}, {"seq": 3, "before": "s", "after": "t"}]
        self.assertEqual([item["seq"] for item in Studio._bound_agent_edits(oversized)], [2, 3])
        self.assertEqual(len(Studio._bound_agent_edits([{"seq": 9, "before": chunk * 2, "after": chunk * 2}])), 1)

        proxy = SimpleNamespace(_agent_edit_seq=2)
        tab = {"agent_edits": [{"seq": 10, "before": "v0", "after": "v1"}]}
        Studio._append_agent_edit(proxy, tab, "v1", "v2")
        Studio._append_agent_edit(proxy, tab, "v2", "v3")
        self.assertEqual(([item["seq"] for item in tab["agent_edits"]], proxy._agent_edit_seq), ([10, 11, 12], 12))

    def test_activate_tab_state_and_clear_agent_staging_handle_autosave_and_unbound_proxies(self):
        started: list[int] = []
        proxy = SimpleNamespace(_agent_jump_tab_id="tab-bg", settings={"autosave": True}, autosave_timer=SimpleNamespace(start=started.append))
        dirty_saved_tab = {
            "id": "tab-bg", "path": "/tmp/note.md", "content": "edited", "saved": "original",
            "assets": {}, "saved_assets": {}, "assets_dirty": False, "conflict": False,
            "agent_staged": True, "agent_unreviewed": True,
        }
        Studio._activate_tab_state(proxy, dirty_saved_tab)
        self.assertEqual((proxy._agent_jump_tab_id, dirty_saved_tab["agent_staged"], dirty_saved_tab["agent_unreviewed"], started), ("", False, True, [900]))

        started.clear()
        conflicted_tab = {**dirty_saved_tab, "agent_staged": True, "conflict": True}
        Studio._activate_tab_state(proxy, conflicted_tab)
        self.assertEqual((conflicted_tab["agent_staged"], started), (False, []))

        clear_proxy = SimpleNamespace(_agent_jump_tab_id="tab-bg")
        staged_tab = {"id": "tab-bg", "agent_staged": True, "agent_unreviewed": True}
        Studio._clear_agent_staging(clear_proxy, staged_tab)
        self.assertEqual((staged_tab["agent_staged"], staged_tab["agent_unreviewed"], clear_proxy._agent_jump_tab_id), (False, False, ""))
        Studio._clear_agent_staging(clear_proxy, None)

    def test_agent_connection_and_jump_snapshots_and_dismiss_agent_jump(self):
        emits: list[bool] = []
        bridge = SimpleNamespace(enabled=False, cloudClient=SimpleNamespace(enabled=False))
        proxy = SimpleNamespace(
            session=SimpleNamespace(agent_bridge=bridge), settings={"cloudAgentEnabled": False},
            cloudAgentStatus="Disconnected.", agentAccessStatus="Ready on 127.0.0.1",
            _cloud_revocation_pending=False, _agent_cloud_error="", _agent_jump_tab_id="tab-2", active="tab-1",
            tabs=[{"id": "tab-1", "name": "Active.md"}, {"id": "tab-2", "name": "Background.md"}], _emit=emits.append,
        )
        self.assertEqual(Studio._agent_connection_snapshot(proxy), {"visible": False, "state": "off", "label": "", "detail": ""})
        bridge.enabled = True
        self.assertEqual((Studio._agent_connection_snapshot(proxy)["state"], Studio._agent_connection_snapshot(proxy)["label"]), ("local", "AI live"))
        bridge.cloudClient.enabled = True
        for status, expected in (
            ("Connecting to relay…", ("connecting", "AI connecting…")),
            ("Reconnecting: timeout", ("retrying", "AI retrying…")),
            ("Connected to relay", ("connected", "AI connected")),
        ):
            proxy.cloudAgentStatus = status
            snap = Studio._agent_connection_snapshot(proxy)
            self.assertEqual((snap["state"], snap["label"]), expected)

        bridge.cloudClient.enabled = False
        proxy.settings["cloudAgentEnabled"] = True
        proxy._agent_cloud_error = "Relay dropped"
        proxy.cloudAgentStatus = "Disconnected."
        self.assertEqual(Studio._agent_connection_snapshot(proxy)["state"], "retrying")
        proxy._cloud_revocation_pending = True
        revoking = Studio._agent_connection_snapshot(proxy)
        self.assertEqual((revoking["state"], revoking["label"]), ("connecting", "Disconnecting…"))

        self.assertEqual(Studio._agent_jump_snapshot(proxy), {"id": "tab-2", "name": "Background.md"})
        Studio.dismissAgentJump(proxy)
        self.assertEqual((proxy._agent_jump_tab_id, Studio._agent_jump_snapshot(proxy), emits), ("", None, [False]))

    def test_sync_inactive_staging_persists_recovery_supports_unbound_proxy_and_rolls_back_on_failure(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            note_file = root / "Bg.md"
            note_file.write_text("# Disk v0\n", encoding="utf-8")
            writes = LatestWriteExecutor()
            try:
                base = {"assets": {}, "saved_assets": {}, "assets_dirty": False, "portable": False, "conflict": False, "agent_staged": False, "agent_unreviewed": False, "agent_edits": []}
                active_tab = {"id": "t1", "name": "Act.md", "path": "", "content": "# Act\n", "saved": "# Act\n", **base}
                bg_tab = {"id": "t2", "name": "Bg.md", "path": str(note_file), "content": "# Disk v0\n", "saved": "# Disk v0\n", **base}
                proxy = SimpleNamespace(
                    data=root, window_id="w-proxy", tabs=[active_tab, bg_tab], active="t1", retired=False,
                    writes=writes, session=SimpleNamespace(drafts={}), settings={"autosave": True},
                    _agent_jump_tab_id="", _emit=lambda **_kw: None,
                )
                with patch.object(studio_module, "atomic_json", side_effect=OSError("disk full")):
                    with self.assertRaisesRegex(RuntimeError, "Could not save draft recovery snapshot"):
                        Studio._stage_inactive_patch_tab_sync(proxy, "t2", "# Disk v0\n", "# Staged v1\n", [{"index": 0}], True)
                self.assertEqual((bg_tab["content"], bg_tab["agent_staged"], (root / "recovery.json").exists()), ("# Disk v0\n", False, False))

                res = Studio._stage_inactive_patch_tab_sync(proxy, "t2", "# Disk v0\n", "# Staged v1\n", [{"index": 0}], True)
                self.assertTrue(res["changed"] and bg_tab["agent_staged"] and bg_tab["agent_unreviewed"])
                self.assertEqual((proxy.active, proxy._agent_jump_tab_id, note_file.read_text(encoding="utf-8")), ("t1", "t2", "# Disk v0\n"))
                self.assertEqual(json.loads((root / "recovery.json").read_text(encoding="utf-8"))[0]["content"], "# Staged v1\n")

                with self.assertRaisesRegex(ValueError, "Live tab revision changed; inspect it again before editing"):
                    Studio._stage_inactive_patch_tab_sync(proxy, "t2", "# Disk v0\n", "# Staged v2\n", [{"index": 0}], True)

                renamed, real_json, seen_paths = root / "BgRenamed.md", studio_module.atomic_json, []
                with patch.object(studio_module, "atomic_json", side_effect=lambda p, payload: (seen_paths.append(payload[0]["path"]), real_json(p, payload), bg_tab.__setitem__("path", str(renamed)) if len(seen_paths) == 1 else None)[1]):
                    Studio._stage_inactive_patch_tab_sync(proxy, "t2", "# Staged v1\n", "# Staged v2\n", [{"index": 0}], True)
                self.assertEqual((seen_paths, json.loads((root / "recovery.json").read_text(encoding="utf-8"))[0]["path"]), ([str(note_file), str(renamed)], str(renamed)))
            finally:
                writes.shutdown(wait=True)

    def test_async_inactive_staging_revision_conflict_cancellation_rollback_and_serialized_queue(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            bg1_file, bg2_file = root / "Bg1.md", root / "Bg2.md"
            bg1_file.write_text("# Bg1 v0\n", encoding="utf-8")
            bg2_file.write_text("# Bg2 v0\n", encoding="utf-8")
            session, studio = self.make_studio(root)
            try:
                act = studio._note("Active.md", "# Active\n")
                bg1 = studio._note("Bg1.md", "# Bg1 v0\n", str(bg1_file), saved="# Bg1 v0\n")
                bg2 = studio._note("Bg2.md", "# Bg2 v0\n", str(bg2_file), saved="# Bg2 v0\n")
                studio.tabs, studio.active = [act, bg1, bg2], act["id"]

                with self.assertRaises(ValueError) as conflict_ctx:
                    studio._stage_inactive_patch_tab_async({"tabId": bg1["id"], "expectedRevision": "0" * 64, "operations": []}, lambda *_a: None)
                conflict_payload = json.loads(str(conflict_ctx.exception))
                self.assertEqual(conflict_payload["error"], "Revision conflict; inspect the current note before retrying")
                self.assertEqual(conflict_payload["currentRevision"], hashlib.sha256(b"# Bg1 v0\n").hexdigest())

                real_atomic_json = studio_module.atomic_json
                recovery_path = (session.data / "recovery.json").resolve()
                write_entered, release_cancel = threading.Event(), threading.Event()
                cancel_holder, cancel_outcome = [], []

                def gated_cancel_write(path, payload):
                    if Path(path).resolve() == recovery_path:
                        write_entered.set()
                        release_cancel.wait(3.0)
                    return real_atomic_json(path, payload)

                rev_bg1 = hashlib.sha256(b"# Bg1 v0\n").hexdigest()
                with patch.object(studio_module, "atomic_json", side_effect=gated_cancel_write):
                    studio._stage_inactive_patch_tab_async(
                        {"tabId": bg1["id"], "expectedRevision": rev_bg1, "operations": [{"type": "replace", "old": "# Bg1 v0", "new": "# Bg1 cancelled"}]},
                        lambda res, err: cancel_outcome.append((res, err)), register_cancel=cancel_holder.append,
                    )
                    self.assertTrue(write_entered.wait(2.0))
                    self.assertFalse(cancel_holder[0]())
                    release_cancel.set()
                    deadline = time.monotonic() + 2.0
                    while not cancel_outcome and time.monotonic() < deadline:
                        self.app.processEvents()
                        time.sleep(0.005)
                    session.writes.flush(timeout=2.0)

                self.assertIsNone(cancel_outcome[0][0])
                self.assertIn("Could not save draft recovery snapshot", cancel_outcome[0][1])
                self.assertEqual((bg1["content"], bg1["agent_staged"], recovery_path.exists()), ("# Bg1 v0\n", False, False))

                in_flight = max_in_flight = 0
                pending_callbacks, done_results = [], []
                real_submit = studio._submit_exact_recovery_write

                def spy_submit(write_action, on_done, **kwargs):
                    nonlocal in_flight, max_in_flight
                    in_flight += 1
                    max_in_flight = max(max_in_flight, in_flight)

                    def wrapped_done(outcome_tuple, err_str):
                        nonlocal in_flight
                        in_flight -= 1
                        on_done(outcome_tuple, err_str)

                    pending_callbacks.append((write_action, wrapped_done, kwargs))

                rev_bg2 = hashlib.sha256(b"# Bg2 v0\n").hexdigest()
                with patch.object(studio, "_submit_exact_recovery_write", side_effect=spy_submit):
                    studio._stage_inactive_patch_tab_async(
                        {"tabId": bg1["id"], "expectedRevision": rev_bg1, "operations": [{"type": "replace", "old": "# Bg1 v0", "new": "# Bg1 v1"}]},
                        lambda res, err: done_results.append(("bg1", res, err)),
                    )
                    studio._stage_inactive_patch_tab_async(
                        {"tabId": bg2["id"], "expectedRevision": rev_bg2, "operations": [{"type": "replace", "old": "# Bg2 v0", "new": "# Bg2 v1"}]},
                        lambda res, err: done_results.append(("bg2", res, err)),
                    )
                    self.assertEqual(len(pending_callbacks), 1)
                    act1, cb1, kw1 = pending_callbacks.pop(0)
                    real_submit(act1, cb1, **kw1)
                    deadline = time.monotonic() + 2.0
                    while len(pending_callbacks) < 1 and time.monotonic() < deadline:
                        self.app.processEvents()
                        time.sleep(0.005)
                    self.assertEqual(len(pending_callbacks), 1)
                    act2, cb2, kw2 = pending_callbacks.pop(0)
                    real_submit(act2, cb2, **kw2)
                    while len(done_results) < 2 and time.monotonic() < deadline:
                        self.app.processEvents()
                        time.sleep(0.005)

                self.assertEqual((max_in_flight, [item[0] for item in done_results]), (1, ["bg1", "bg2"]))
                self.assertTrue(all(item[2] is None and item[1]["changed"] for item in done_results))
                self.assertEqual((studio.active, studio._agent_jump_tab_id), (act["id"], bg2["id"]))
                self.assertTrue(bg1["agent_staged"] and bg1["agent_unreviewed"] and bg2["agent_staged"] and bg2["agent_unreviewed"])
                self.assertEqual((bg1_file.read_text(encoding="utf-8"), bg2_file.read_text(encoding="utf-8")), ("# Bg1 v0\n", "# Bg2 v0\n"))
                stage_spy: list[str] = []
                real_stage = studio_module.stage_atomic_json
                with patch.object(studio_module, "stage_atomic_json", wraps=lambda *a, **kw: (stage_spy.append("stage"), real_stage(*a, **kw))[1]):
                    studio._stage_inactive_patch_tab_sync(bg1["id"], "# Bg1 v1\n", "# Bg1 v2\n", [{"index": 0}], True)
                self.assertEqual((stage_spy, bg1["content"]), (["stage"], "# Bg1 v2\n"))
            finally:
                self.dispose(session, studio)


if __name__ == "__main__":
    unittest.main()
