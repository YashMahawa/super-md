"""Desktop tests for top-bar agent connection pill, inactive-tab draft staging, tab badges, and jump bar."""
from __future__ import annotations

import hashlib
import json
import os
import tempfile
import textwrap
import threading
import time
import unittest
from pathlib import Path
from unittest.mock import patch

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
os.environ.setdefault("QT_QUICK_BACKEND", "software")

from PySide6.QtCore import QEvent, QObject, QPointF, QUrl, Qt
from PySide6.QtGui import QGuiApplication
from PySide6.QtQml import QQmlComponent, QQmlEngine
from PySide6.QtQuick import QQuickItem
from PySide6.QtQuickControls2 import QQuickStyle
from PySide6.QtTest import QTest

import agent_cloud
import agent_live
import studio as studio_module
from studio import Session, Studio

QML_DIR = Path(__file__).parent / "qml"
MAIN_QML = QML_DIR / "Main.qml"


class QuietStudio(Studio):
    def _refresh_theme(self):
        self.system_dark = True


def _find_quick_items(root, object_name: str):
    found = []
    start = root.contentItem() if hasattr(root, "contentItem") and callable(root.contentItem) else root
    stack = [start]
    while stack:
        item = stack.pop()
        if item is None:
            continue
        if item.objectName() == object_name:
            found.append(item)
        if hasattr(item, "childItems"):
            stack.extend(item.childItems())
    return found


def _extract_agent_pill_and_jump_qml() -> tuple[str, str, str]:
    source = MAIN_QML.read_text(encoding="utf-8")
    fn_start = source.index("    function openAgentSettings() {")
    fn_end = source.index("    function nativeTextEditorFocused()", fn_start)
    open_fn = textwrap.dedent(source[fn_start:fn_end]).strip()

    pill_start = source.index("                Rectangle {\n                    id: agentStatusPill")
    pill_end = source.index("                ActionButton { glyph: \"MagnifyingGlass\"", pill_start)
    pill_qml = textwrap.dedent(source[pill_start:pill_end]).strip()

    jump_start = source.index("        Rectangle {\n            id: agentJumpBar")
    jump_end = source.index("        Rectangle { width: parent.width; height: 1;", jump_start)
    jump_qml = textwrap.dedent(source[jump_start:jump_end]).strip()
    return open_fn, pill_qml, jump_qml


class FakeCloudClient:
    def __init__(self, enabled=False, connected=False, error=""):
        self.enabled = enabled
        self.connected = connected
        self._error = error

    @property
    def status(self) -> str:
        if not self.enabled:
            return "Disconnected."
        if self.connected:
            return "Connected to relay"
        if self._error:
            return f"Reconnecting to relay: {self._error}"
        return "Connecting to relay…"

    def status_dict(self):
        return {
            "enabled": self.enabled,
            "connected": self.connected,
            "lastError": self._error,
            "serverOrigin": "https://relay.example.test",
            "deviceId": "dev-1",
            "groupId": "grp-1",
        }


class FakeAgentBridge:
    def __init__(self, local_enabled=False, cloud_enabled=False, cloud_connected=False, cloud_error=""):
        self.enabled = local_enabled
        self.cloudClient = FakeCloudClient(cloud_enabled, cloud_connected, cloud_error)

    def status(self):
        return {"enabled": self.enabled, "endpoint": "http://127.0.0.1:43111/agent", "cloud": self.cloudClient.status_dict()}


class DesktopAgentStagingAndChromeTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if QGuiApplication.instance() is None:
            QQuickStyle.setStyle("Material")
        cls.app = QGuiApplication.instance() or QGuiApplication(["Super MD desktop agent staging tests"])

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

    def test_connection_pill_updates_across_local_and_cloud_states_and_links_to_agent_settings(self):
        session, studio = self.make_studio()
        engine = QQmlEngine()
        window = None
        try:
            open_fn, pill_qml, jump_qml = _extract_agent_pill_and_jump_qml()
            engine.rootContext().setContextProperty("studio", studio)
            qml = f"""
import QtQuick
import QtQuick.Controls
import QtQuick.Controls.Material
import QtQuick.Layouts
import "."
ApplicationWindow {{
    id: window
    width: 1120; height: 720; visible: true
    property var viewState: JSON.parse(studio.snapshot)
    property var shortcutLabels: JSON.parse(studio.shortcutLabels)
    property bool settingsOpen: false
    property bool capturingShortcut: false
    property int contextMenuCount: 0
    property int modalDialogCount: 0
    Connections {{
        target: studio
        function onChanged() {{ window.viewState = JSON.parse(studio.snapshot) }}
    }}
    onSettingsOpenChanged: {{
        if (settingsOpen && !settingsDialog.visible) settingsDialog.open()
        else if (!settingsOpen && settingsDialog.visible) settingsDialog.close()
    }}
    {open_fn}
    Column {{
        width: parent.width
        RowLayout {{
            width: parent.width
            height: 48
            {pill_qml}
        }}
        TabStrip {{
            width: parent.width
            viewState: window.viewState
            shortcutLabels: window.shortcutLabels
        }}
        {jump_qml}
    }}
    AppDialog {{
        id: settingsDialog
        objectName: "settingsDialog"
        width: 760; height: 640; padding: 0
        onClosed: settingsOpen = false
        SettingsPage {{ id: settingsPageItem; objectName: "settingsPage"; ownerPopup: settingsDialog; viewState: window.viewState; anchors.fill: parent; onBack: settingsOpen = false }}
    }}
}}
"""
            component = QQmlComponent(engine)
            component.setData(qml.encode("utf-8"), QUrl.fromLocalFile(str(QML_DIR / "agent-chrome-smoke.qml")))
            self.assertFalse(component.isError(), "\n".join(err.toString() for err in component.errors()))
            window = component.create()
            self.assertIsNotNone(window)
            QTest.qWait(40)

            pill = window.findChild(QObject, "agentStatusPill")
            settings_page = window.findChild(QObject, "settingsPage")
            self.assertIsNotNone(pill)
            self.assertIsNotNone(settings_page)
            self.assertFalse(pill.property("visible"))

            # 1. Local MCP access enabled -> visible immediately without opening Settings
            studio.settings["agentAccessEnabled"] = True
            session.agent_bridge = FakeAgentBridge(local_enabled=True)
            studio._emit(False)
            self.app.processEvents()
            self.assertTrue(pill.property("visible"))
            self.assertEqual(pill.property("connectionState"), "local")
            self.assertEqual(pill.property("statusText"), "AI live")

            # 2. Cloud connecting
            config = agent_cloud.device_config(agent_cloud.new_pairing("https://relay.example.test"))
            agent_cloud.write_cloud_config(studio._agent_cloud_config_path, config)
            studio.settings["cloudAgentEnabled"] = True
            session.agent_bridge = FakeAgentBridge(local_enabled=True, cloud_enabled=True, cloud_connected=False, cloud_error="")
            studio._cloud_status_changed({"connected": False, "lastError": ""})
            self.app.processEvents()
            self.assertTrue(pill.property("visible"))
            self.assertEqual(pill.property("connectionState"), "connecting")
            self.assertEqual(pill.property("statusText"), "AI connecting…")

            # 3. Cloud connected
            session.agent_bridge.cloudClient.connected = True
            studio._cloud_status_changed({"connected": True, "lastError": ""})
            self.app.processEvents()
            self.assertEqual(pill.property("connectionState"), "connected")
            self.assertEqual(pill.property("statusText"), "AI connected")

            # 4. Cloud retrying
            session.agent_bridge.cloudClient.connected = False
            session.agent_bridge.cloudClient._error = "network timeout"
            studio._cloud_status_changed({"connected": False, "lastError": "network timeout"})
            self.app.processEvents()
            self.assertEqual(pill.property("connectionState"), "retrying")
            self.assertEqual(pill.property("statusText"), "AI retrying…")

            # 5. Cloud disconnected while cloud opt-in remains enabled with an auto-connect/disconnect error
            session.agent_bridge.cloudClient.enabled = False
            studio._agent_cloud_error = "Cloud relay disconnected"
            studio._cloud_status_changed({"connected": False, "lastError": ""})
            self.app.processEvents()
            self.assertEqual(pill.property("connectionState"), "retrying")

            # 6. Turning off both cloud and local hides the pill cleanly
            studio.settings["cloudAgentEnabled"] = False
            studio._agent_cloud_error = ""
            session.agent_bridge.enabled = False
            studio._emit(False)
            self.app.processEvents()
            self.assertFalse(pill.property("visible"))

            # Re-enable local to click the visible pill and verify it opens Settings -> "agents"
            session.agent_bridge.enabled = True
            studio.settings["agentAccessEnabled"] = True
            studio._emit(False)
            self.app.processEvents()
            QTest.qWait(20)
            self.assertTrue(pill.property("visible"))

            # Clicking the pill opens Settings directly to the "agents" section
            self.assertEqual(settings_page.property("section"), "appearance")
            center = pill.mapToItem(None, QPointF(pill.property("width") / 2, pill.property("height") / 2))
            QTest.mouseClick(window, Qt.MouseButton.LeftButton, Qt.KeyboardModifier.NoModifier, center.toPoint())
            QTest.qWait(40)
            self.assertTrue(window.property("settingsOpen"))
            self.assertEqual(settings_page.property("section"), "agents")
        finally:
            if window is not None:
                window.close()
                window.deleteLater()
            self.app.sendPostedEvents(None, QEvent.Type.DeferredDelete)
            engine.deleteLater()
            self.app.sendPostedEvents(None, QEvent.Type.DeferredDelete)
            self.dispose(session, studio)

    def test_inactive_tab_patch_stages_recovery_pauses_autosave_shows_badge_and_jump_without_focus_steal(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            active_file = root / "Active.md"
            bg_file = root / "Background.md"
            active_initial = "# Active Note\n\nUser is typing here.\n"
            bg_initial = "# Background Note\n\nOriginal disk text.\n"
            active_file.write_text(active_initial, encoding="utf-8")
            bg_file.write_text(bg_initial, encoding="utf-8")

            session, studio = self.make_studio(root)
            engine = QQmlEngine()
            window = None
            try:
                active_tab = studio._note("Active.md", active_initial, str(active_file), saved=active_initial)
                bg_tab = studio._note("Background.md", bg_initial, str(bg_file), saved=bg_initial)
                studio.tabs = [active_tab, bg_tab]
                studio.active = active_tab["id"]
                studio._emit(True)

                open_fn, pill_qml, jump_qml = _extract_agent_pill_and_jump_qml()
                engine.rootContext().setContextProperty("studio", studio)
                qml = f"""
import QtQuick
import QtQuick.Controls
import QtQuick.Controls.Material
import QtQuick.Layouts
import "."
ApplicationWindow {{
    id: window
    width: 1120; height: 480; visible: true
    property var viewState: JSON.parse(studio.snapshot)
    property var shortcutLabels: JSON.parse(studio.shortcutLabels)
    property bool settingsOpen: false
    property int contextMenuCount: 0
    property int modalDialogCount: 0
    Connections {{
        target: studio
        function onChanged() {{ window.viewState = JSON.parse(studio.snapshot) }}
    }}
    {open_fn}
    Column {{
        width: parent.width
        TabStrip {{
            width: parent.width
            viewState: window.viewState
            shortcutLabels: window.shortcutLabels
        }}
        {jump_qml}
    }}
}}
"""
                component = QQmlComponent(engine)
                component.setData(qml.encode("utf-8"), QUrl.fromLocalFile(str(QML_DIR / "agent-jump-smoke.qml")))
                self.assertFalse(component.isError(), "\n".join(err.toString() for err in component.errors()))
                window = component.create()
                self.assertIsNotNone(window)
                QTest.qWait(40)

                jump_bar = window.findChild(QObject, "agentJumpBar")
                jump_btn = window.findChild(QObject, "agentJumpButton")
                self.assertIsNotNone(jump_bar)
                self.assertIsNotNone(jump_btn)
                self.assertFalse(jump_bar.property("visible"))

                reader_loads = []
                studio.ready = True
                studio.readerLoad.connect(lambda payload: reader_loads.append(json.loads(payload)))

                # Patch the inactive tab via _agent_document_action("patch_tab")
                expected_rev = hashlib.sha256(bg_initial.encode("utf-8")).hexdigest()
                t0 = time.monotonic()
                patch_result = studio._agent_document_action({
                    "action": "patch_tab",
                    "tabId": bg_tab["id"],
                    "expectedRevision": expected_rev,
                    "operations": [{"type": "replace", "old": "Original disk text.", "new": "Staged AI text."}],
                })
                self.assertTrue(patch_result["changed"])

                # Wait for async recovery write and verify it completes in < 1.2s
                deadline = t0 + 1.2
                recovery_path = root / "recovery.json"
                recovered = None
                while time.monotonic() < deadline:
                    self.app.processEvents()
                    if recovery_path.exists():
                        data = json.loads(recovery_path.read_text(encoding="utf-8"))
                        match = next((item for item in data if item["id"] == bg_tab["id"]), None)
                        if match and "Staged AI text." in match["content"]:
                            recovered = match
                            break
                    time.sleep(0.01)
                elapsed = time.monotonic() - t0
                self.assertIsNotNone(recovered, "Inactive-tab edit was not persisted to recovery.json within 1.2s")
                self.assertLess(elapsed, 1.2)
                self.assertTrue(recovered["agent_staged"])
                self.assertTrue(recovered["agent_unreviewed"])
                self.assertEqual(len(recovered["agent_edits"]), 1)

                # Focus and active tab MUST remain on Active.md
                self.assertEqual(studio.active, active_tab["id"])

                # Even if autosave timer fires, zero automatic disk writes occur on Background.md!
                studio._autosave()
                QTest.qWait(80)
                self.assertEqual(bg_file.read_text(encoding="utf-8"), bg_initial)

                # Background tab badge ("AI") and Jump bar are visible
                QTest.qWait(30)
                snap = json.loads(studio.snapshot)
                bg_snap = next(item for item in snap["tabs"] if item["id"] == bg_tab["id"])
                self.assertTrue(bg_snap["agentEdited"])
                self.assertTrue(jump_bar.property("visible"))
                badges = [b for b in _find_quick_items(window, "agentTabBadge") if b.property("visible")]
                self.assertEqual(len(badges), 1)

                # Clicking Jump activates Background.md, clears agent_staged, hides jump bar,
                # delivers pendingAgentEdits + agentUnreviewed to readerLoad, and resumes autosave!
                reader_loads.clear()
                jump_center = jump_btn.mapToItem(None, QPointF(jump_btn.property("width") / 2, jump_btn.property("height") / 2))
                QTest.mouseClick(window, Qt.MouseButton.LeftButton, Qt.KeyboardModifier.NoModifier, jump_center.toPoint())
                QTest.qWait(30)
                self.assertEqual(studio.active, bg_tab["id"])
                self.assertFalse(bg_tab["agent_staged"])
                self.assertTrue(bg_tab["agent_unreviewed"])
                self.assertFalse(jump_bar.property("visible"))
                bg_loads = [item for item in reader_loads if item.get("id") == bg_tab["id"]]
                self.assertTrue(bg_loads)
                load_payload = bg_loads[0]
                self.assertEqual(load_payload["id"], bg_tab["id"])
                self.assertTrue(load_payload["agentUnreviewed"])
                self.assertEqual(len(load_payload["pendingAgentEdits"]), 1)
                self.assertIn("Staged AI text.", load_payload["pendingAgentEdits"][0]["after"])
                for follow_up in bg_loads[1:]:
                    self.assertTrue(follow_up.get("agentUnreviewed"))
                    self.assertNotIn("pendingAgentEdits", follow_up)

                # Now that the user opened the tab, autosave resumes and writes to disk
                studio._autosave()
                save_deadline = time.monotonic() + 2.0
                while time.monotonic() < save_deadline and bg_file.read_text(encoding="utf-8") == bg_initial:
                    self.app.processEvents()
                    time.sleep(0.01)
                self.assertIn("Staged AI text.", bg_file.read_text(encoding="utf-8"))

                # Dismissing the in-note agent banner clears agent_unreviewed
                studio.post("req-1", "agent_banner_dismissed", json.dumps({"id": bg_tab["id"]}))
                self.assertFalse(bg_tab["agent_unreviewed"])
            finally:
                if window is not None:
                    window.close()
                    window.deleteLater()
                self.app.sendPostedEvents(None, QEvent.Type.DeferredDelete)
                engine.deleteLater()
                self.app.sendPostedEvents(None, QEvent.Type.DeferredDelete)
                self.dispose(session, studio)

    def test_manual_save_clears_staging_and_agent_edit_history_is_bounded_to_60_steps(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            bg_file = root / "ManualSave.md"
            bg_file.write_text("# Step 0\n", encoding="utf-8")
            session, studio = self.make_studio(root)
            try:
                active_tab = studio._note("Active.md", "# Active\n")
                bg_tab = studio._note("ManualSave.md", "# Step 0\n", str(bg_file), saved="# Step 0\n")
                studio.tabs = [active_tab, bg_tab]
                studio.active = active_tab["id"]

                for step in range(1, 66):
                    rev = hashlib.sha256(bg_tab["content"].encode("utf-8")).hexdigest()
                    studio._agent_document_action({
                        "action": "patch_tab",
                        "tabId": bg_tab["id"],
                        "expectedRevision": rev,
                        "operations": [{"type": "replace", "old": f"# Step {step - 1}", "new": f"# Step {step}"}],
                    })

                self.assertEqual(len(bg_tab["agent_edits"]), 60)
                self.assertEqual(bg_tab["agent_edits"][0]["seq"], 6)
                self.assertEqual(bg_tab["agent_edits"][-1]["seq"], 65)
                self.assertTrue(bg_tab["agent_staged"])
                self.assertEqual(bg_file.read_text(encoding="utf-8"), "# Step 0\n")

                # Explicit agent save writes to disk and clears staging
                rev = hashlib.sha256(bg_tab["content"].encode("utf-8")).hexdigest()
                saved = studio._agent_document_action({
                    "action": "save_document",
                    "tabId": bg_tab["id"],
                    "expectedRevision": rev,
                })
                self.assertFalse(saved["isDirty"])
                self.assertFalse(bg_tab["agent_staged"])
                self.assertEqual(bg_file.read_text(encoding="utf-8"), "# Step 65\n")
            finally:
                self.dispose(session, studio)

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
                self.assertTrue(bg_entry["agent_unreviewed"])

                # Staged content is preserved, focus never moved, and autosave skips staged tab.
                self.assertEqual(studio.active, active_tab["id"])
                self.assertEqual(bg_tab["content"], expected_after)
                self.assertTrue(bg_tab["agent_staged"])
                self.assertEqual(studio._agent_jump_tab_id, bg_tab["id"])
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
                    self.assertFalse(bg_tab["agent_unreviewed"])
                    self.assertEqual(bg_tab["agent_edits"], [])
                    self.assertEqual(studio._agent_jump_tab_id, "")
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
                    self.assertTrue(bg_tab["agent_unreviewed"])
                    self.assertEqual(len(bg_tab["agent_edits"]), 1)

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
                    self.assertEqual(len(bg_tab["agent_edits"]), 1)
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
                    self.assertEqual(len(bg_tab["agent_edits"]), 2)
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
                            lambda: real_atomic_json(recovery_path, studio._combined_recovery_drafts(studio._window_recovery_drafts())),
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
                            lambda: real_atomic_json(recovery_path, studio._combined_recovery_drafts(studio._window_recovery_drafts())),
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


if __name__ == "__main__":
    unittest.main()
