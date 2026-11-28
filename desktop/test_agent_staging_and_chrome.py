"""Desktop tests for top-bar agent connection pill, inactive-tab draft staging, tab badges, and jump bar."""
from __future__ import annotations

import hashlib
import json
import os
import tempfile
import textwrap
import time
import unittest
from pathlib import Path

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
os.environ.setdefault("QT_QUICK_BACKEND", "software")

from PySide6.QtCore import QEvent, QObject, QPointF, QUrl, Qt
from PySide6.QtQml import QQmlComponent, QQmlEngine
from PySide6.QtQuickControls2 import QQuickStyle
from PySide6.QtTest import QTest
from PySide6.QtWidgets import QApplication

import agent_cloud
import studio as studio_module
from studio import Session, Studio

QML_DIR = Path(__file__).parent / "qml"
MAIN_QML = QML_DIR / "Main.qml"


class QuietStudio(Studio):
    def _refresh_theme(self):
        self.system_dark = True

    def _choose_default_python(self, emit=True):
        self.python_status = "No Python interpreter configured."


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
    pill_end = source.index("                ActionButton { objectName: \"findInNoteButton\"", pill_start)
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
        if QApplication.instance() is None:
            QQuickStyle.setStyle("Material")
        cls.app = QApplication.instance() or QApplication(["Super MD desktop agent staging tests"])

    def make_studio(self, root: Path | None = None):
        session = Session(True, data=root)
        studio = QuietStudio(True, session)
        studio.settings["welcomed"] = True
        studio.settings["autosave"] = True
        studio._emit(False)
        return session, studio

    def dispose(self, session: Session, studio: Studio):
        for win in list(session.windows.values()):
            if not win.retired:
                win.stop()
            win.pool.shutdown(wait=True, cancel_futures=True)
            win._search_pool.shutdown(wait=True, cancel_futures=True)
        if not studio.retired:
            studio.stop()
        studio.pool.shutdown(wait=True, cancel_futures=True)
        studio._search_pool.shutdown(wait=True, cancel_futures=True)
        session.writes.shutdown(wait=True)
        self.app.processEvents()

    @staticmethod
    def _canonical_root(tmp: str) -> Path:
        return Path(studio_module.folder_ops.canonical_path_str(tmp))

    def _read_text_with_sharing_retry(self, path: Path, *, timeout: float = 2.0) -> str:
        deadline = time.monotonic() + timeout
        while True:
            try:
                return path.read_text(encoding="utf-8")
            except FileNotFoundError:
                raise
            except (PermissionError, OSError):
                if time.monotonic() >= deadline:
                    raise
                self.app.processEvents()
                time.sleep(0.01)

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
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp:
            root = self._canonical_root(tmp)
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
                        data = json.loads(self._read_text_with_sharing_retry(recovery_path))
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
                self.assertEqual(self._read_text_with_sharing_retry(bg_file), bg_initial)

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
                save_deadline = time.monotonic() + 3.0
                while time.monotonic() < save_deadline and self._read_text_with_sharing_retry(bg_file) == bg_initial:
                    self.app.processEvents()
                    time.sleep(0.01)
                self.assertIn("Staged AI text.", self._read_text_with_sharing_retry(bg_file))

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
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp:
            root = self._canonical_root(tmp)
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
                self.assertEqual(self._read_text_with_sharing_retry(bg_file), "# Step 0\n")

                # Explicit agent save writes to disk and clears staging
                rev = hashlib.sha256(bg_tab["content"].encode("utf-8")).hexdigest()
                saved = studio._agent_document_action({
                    "action": "save_document",
                    "tabId": bg_tab["id"],
                    "expectedRevision": rev,
                })
                self.assertFalse(saved["isDirty"])
                self.assertFalse(bg_tab["agent_staged"])
                self.assertEqual(self._read_text_with_sharing_retry(bg_file), "# Step 65\n")
            finally:
                self.dispose(session, studio)

    def test_dirty_draft_save_and_restore_with_current_reader_preserves_reversible_coauthoring(self):
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp:
            root = self._canonical_root(tmp)
            state_dir = root / "state"
            state_dir.mkdir(parents=True, exist_ok=True)
            note_file = root / "DraftNote.md"
            disk_initial = "# Draft Note\n\nSaved on disk.\n"
            dirty_draft = "# Draft Note\n\nUnsaved user draft.\n"
            ai_coauthored = "# Draft Note\n\nUnsaved user draft.\n\n## AI Summary\n\nReversible coauthoring.\n"
            note_file.write_text(disk_initial, encoding="utf-8")

            session, studio = self.make_studio(state_dir)
            retired_first = False
            try:
                studio.settings["autosave"] = False
                note_tab = studio._note("DraftNote.md", disk_initial, str(note_file), saved=disk_initial)
                studio.tabs = [note_tab]
                studio.active = note_tab["id"]

                reader_loads: list[dict] = []
                studio.readerLoad.connect(lambda payload: reader_loads.append(json.loads(payload)))
                studio.post("r-ready-1", "reader_ready", "{}")
                self.assertTrue(reader_loads)
                reader_loads.clear()

                # 1. User edits note in the current reader, leaving an unsaved dirty draft.
                studio.post(
                    "r-edit-1",
                    "document_changed",
                    json.dumps({"id": note_tab["id"], "content": dirty_draft}),
                )
                self.assertTrue(studio._is_dirty(note_tab))
                self.assertEqual(self._read_text_with_sharing_retry(note_file), disk_initial)

                # 2. Active reader applies an AI patch on top of the dirty draft and notifies Studio.
                studio.post(
                    "r-edit-2",
                    "document_changed",
                    json.dumps({"id": note_tab["id"], "content": ai_coauthored}),
                )
                studio.post(
                    "r-banner-1",
                    "agent_banner_shown",
                    json.dumps({
                        "id": note_tab["id"],
                        "before": dirty_draft,
                        "after": ai_coauthored,
                    }),
                )
                self.assertTrue(note_tab["agent_unreviewed"])
                self.assertEqual(len(note_tab["agent_edits"]), 1)
                self.assertEqual(note_tab["agent_edits"][0]["before"], dirty_draft)
                self.assertEqual(note_tab["agent_edits"][0]["after"], ai_coauthored)

                # Subsequent emits in the same reader session must not replay pendingAgentEdits twice.
                reader_loads.clear()
                studio._emit(True)
                self.assertTrue(reader_loads)
                self.assertNotIn("pendingAgentEdits", reader_loads[-1])

                # Persist recovery/session while disk still holds disk_initial.
                self.dispose(session, studio)
                retired_first = True
                self.assertEqual(self._read_text_with_sharing_retry(note_file), disk_initial)

                # 3. Restore Studio session and connect a fresh current reader.
                restored_session, restored_studio = self.make_studio(state_dir)
                try:
                    restored_studio.settings["autosave"] = False
                    restored_tab = next(item for item in restored_studio.tabs if item["id"] == note_tab["id"])
                    self.assertEqual(restored_tab["content"], ai_coauthored)
                    self.assertEqual(restored_tab["saved"], disk_initial)
                    self.assertTrue(restored_studio._is_dirty(restored_tab))
                    self.assertTrue(restored_tab["agent_unreviewed"])
                    self.assertEqual(len(restored_tab["agent_edits"]), 1)

                    restored_loads: list[dict] = []
                    restored_studio.readerLoad.connect(
                        lambda payload: restored_loads.append(json.loads(payload))
                    )
                    restored_studio.post("r-ready-2", "reader_ready", "{}")
                    self.assertTrue(restored_loads)
                    initial_load = restored_loads[-1]
                    self.assertEqual(initial_load["id"], restored_tab["id"])
                    self.assertEqual(initial_load["content"], ai_coauthored)
                    self.assertTrue(initial_load["agentUnreviewed"])
                    self.assertEqual(len(initial_load["pendingAgentEdits"]), 1)
                    self.assertEqual(initial_load["pendingAgentEdits"][0]["before"], dirty_draft)
                    self.assertEqual(initial_load["pendingAgentEdits"][0]["after"], ai_coauthored)

                    # 4. Current reader undoes AI edit back to the dirty user draft, then saves cleanly.
                    restored_studio.post(
                        "r-undo-1",
                        "document_changed",
                        json.dumps({"id": restored_tab["id"], "content": dirty_draft}),
                    )
                    restored_studio.post(
                        "r-dismiss-1",
                        "agent_banner_dismissed",
                        json.dumps({"id": restored_tab["id"]}),
                    )
                    self.assertFalse(restored_tab["agent_unreviewed"])
                    self.assertTrue(restored_studio._is_dirty(restored_tab))

                    restored_studio.save()
                    save_deadline = time.monotonic() + 3.0
                    while time.monotonic() < save_deadline and (
                        self._read_text_with_sharing_retry(note_file) != dirty_draft
                        or restored_studio._is_dirty(restored_tab)
                    ):
                        self.app.processEvents()
                        time.sleep(0.01)
                    self.assertEqual(self._read_text_with_sharing_retry(note_file), dirty_draft)
                    self.assertFalse(restored_studio._is_dirty(restored_tab))
                finally:
                    self.dispose(restored_session, restored_studio)
            finally:
                if not retired_first:
                    self.dispose(session, studio)


if __name__ == "__main__":
    unittest.main()
