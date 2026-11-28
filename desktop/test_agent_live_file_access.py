from __future__ import annotations

import asyncio
import base64
import hashlib
import json
import os
import shutil
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
os.environ.setdefault("QT_QUICK_BACKEND", "software")

from PySide6.QtCore import QEvent, QStandardPaths, QUrl
from PySide6.QtGui import QGuiApplication

from agent_documents import AgentDocumentError, DocumentStore
from agent_live import create_qt_bridge
from agent_live_client import MultiSessionLiveClient
from documents import open_note, write_portable
from mcp_server import build_mcp_server
import studio_agent_setup
from studio import Session, Studio, _validate_local_tab_asset_path


PNG_BYTES = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAX+XDSwAAAABJRU5ErkJggg=="
)
SVG_BYTES = b"<svg xmlns='http://www.w3.org/2000/svg'><circle r='4'/></svg>"
SVG_REPLACEMENT_BYTES = b"<svg xmlns='http://www.w3.org/2000/svg'><rect width='6' height='6'/></svg>"


class QuietStudio(Studio):
    def __init__(self, isolated: bool = False, session: Session | None = None):
        session = session or Session(isolated)
        if not session.settings.get("python"):
            session.settings["python"] = sys.executable
        super().__init__(isolated, session)

    def _refresh_theme(self):
        self.system_dark = True


class AgentLiveFileAccessTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.app = QGuiApplication.instance() or QGuiApplication(["Super MD live file access tests"])

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.base = Path(self.temp.name).resolve(strict=True)
        self.session = Session(isolated=True)
        self.session.settings["python"] = sys.executable
        self.studio = QuietStudio(True, self.session)

    def tearDown(self):
        self.studio.stop()
        self.studio.pool.shutdown(wait=True, cancel_futures=True)
        self.session.writes.shutdown(wait=True)
        self.studio.deleteLater()
        self.app.sendPostedEvents(None, QEvent.Type.DeferredDelete)
        self.app.processEvents()
        shutil.rmtree(self.session.data, ignore_errors=True)
        self.temp.cleanup()

    def _rev(self, text: str) -> str:
        return hashlib.sha256(text.encode("utf-8")).hexdigest()

    def _await_tab_path(self, studio: Studio, expected_path: Path, timeout: float = 3.0) -> dict:
        canonical = str(expected_path.resolve(strict=True))
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            matched = next((tab for tab in studio.tabs if tab.get("path") == canonical), None)
            if matched is not None:
                return matched
            self.app.processEvents()
            time.sleep(0.005)
        self.fail(f"Timed out waiting for tab at {canonical}")

    def test_individual_user_opened_note_allows_exact_note_without_broadening_parent_folder(self):
        unapproved_dir = self.base / "standalone-folder"
        unapproved_dir.mkdir()
        opened_note = unapproved_dir / "lecture.md"
        sibling_note = unapproved_dir / "private-sibling.md"
        nested_note = unapproved_dir / "sub" / "nested.md"
        nested_note.parent.mkdir()
        opened_note.write_text("# Lecture\n", encoding="utf-8")
        sibling_note.write_text("# Private sibling\n", encoding="utf-8")
        nested_note.write_text("# Private nested\n", encoding="utf-8")

        self.studio.openNote(str(opened_note))
        tab = self._await_tab_path(self.studio, opened_note)

        # Close the user-opened note; the exact user-approved file remains reopenable in this session.
        self.studio.closeTab(tab["id"])
        deadline = time.monotonic() + 3.0
        while any(t["id"] == tab["id"] for t in self.studio.tabs) and time.monotonic() < deadline:
            self.app.processEvents()
            time.sleep(0.005)

        reopened = self.studio._agent_document_action({
            "action": "open_document",
            "filename": str(opened_note),
            "background": True,
        })
        self.assertEqual(reopened["status"], "opening")
        self._await_tab_path(self.studio, opened_note)

        # Sibling and nested files in the same directory must NOT be accessible without an approved folder root.
        for disallowed in (sibling_note, nested_note):
            with self.subTest(path=disallowed.name):
                self.assertFalse(self.studio._agent_path_allowed(disallowed))
                with self.assertRaisesRegex(ValueError, "approved agent note roots"):
                    self.studio._agent_document_action({
                        "action": "open_document",
                        "filename": str(disallowed),
                        "background": True,
                    })

    def test_approved_workspace_roots_allow_visible_notes_and_exclude_retired_windows(self):
        workspace_a = self.base / "workspace-a"
        workspace_b = self.base / "workspace-b"
        retired_workspace = self.base / "workspace-retired"
        new_notes_dir = self.base / "new-notes"
        outside_dir = self.base / "outside"
        for folder in (workspace_a, workspace_b / "sub", retired_workspace, new_notes_dir, outside_dir):
            folder.mkdir(parents=True, exist_ok=True)

        note_a = workspace_a / "alpha.md"
        note_b = workspace_b / "sub" / "beta.md"
        note_new = new_notes_dir / "gamma.md"
        note_retired = retired_workspace / "old.md"
        note_outside = outside_dir / "secret.md"
        for p in (note_a, note_b, note_new, note_retired, note_outside):
            p.write_text(f"# {p.stem}\n", encoding="utf-8")

        second_studio = QuietStudio(True, self.session)
        retired_studio = QuietStudio(True, self.session)
        try:
            self.studio.openFolder(str(workspace_a))
            second_studio.openFolder(str(workspace_b))
            retired_studio.openFolder(str(retired_workspace))
            retired_studio.stop()
            self.studio.setNoteLocation(str(new_notes_dir))

            for allowed in (str(note_a), "sub/beta.md", str(note_new)):
                with self.subTest(allowed=allowed):
                    res = self.studio._agent_document_action({
                        "action": "open_document",
                        "filename": allowed,
                        "background": True,
                    })
                    self.assertEqual(res["status"], "opening")

            self._await_tab_path(self.studio, note_a)
            self._await_tab_path(self.studio, note_b)
            self._await_tab_path(self.studio, note_new)

            for blocked in (note_retired, note_outside):
                with self.subTest(blocked=blocked.name):
                    self.assertFalse(self.studio._agent_path_allowed(blocked))
                    with self.assertRaisesRegex(ValueError, "approved agent note roots"):
                        self.studio._agent_document_action({
                            "action": "open_document",
                            "filename": str(blocked),
                            "background": True,
                        })
        finally:
            second_studio.stop()
            second_studio.pool.shutdown(wait=True, cancel_futures=True)
            retired_studio.pool.shutdown(wait=True, cancel_futures=True)
            second_studio.deleteLater()
            retired_studio.deleteLater()

    def test_agent_created_and_agent_save_as_notes_never_broaden_open_asset_or_mcp_root_access(self):
        downloads_dir = self.base / "downloads-fallback"
        approved_assets_dir = self.base / "approved-workspace"
        user_dir = self.base / "user-opened"
        for folder in (downloads_dir, approved_assets_dir, user_dir):
            folder.mkdir()

        sibling_secret_md = downloads_dir / "bank-statement.md"
        sibling_secret_md.write_text("# Private statement\n", encoding="utf-8")
        sibling_secret_svg = downloads_dir / "private-id.svg"
        sibling_secret_svg.write_bytes(SVG_BYTES)
        approved_svg = approved_assets_dir / "approved-diagram.svg"
        approved_svg.write_bytes(SVG_BYTES)
        approved_replacement_svg = approved_assets_dir / "approved-diagram-v2.svg"
        approved_replacement_svg.write_bytes(SVG_REPLACEMENT_BYTES)

        with patch.object(QStandardPaths, "writableLocation", return_value=str(downloads_dir)):
            # 1. Agent creates a portable .smd note and saves it with no configured newNoteLocation.
            created = self.studio._agent_document_action({
                "action": "create_document",
                "title": "agent-scratch.smd",
                "format": "smd",
                "content": "# Agent scratch\n",
            })
            saved = self.studio._agent_document_action({
                "action": "save_document",
                "tabId": created["tabId"],
                "expectedRevision": created["revision"],
            })
            saved_path = Path(saved["path"])
            self.assertEqual(saved_path.parent, downloads_dir)

            # Exact agent-created note remains reopenable, even after closing and reopening.
            self.studio._agent_document_action({
                "action": "close_document",
                "tabId": created["tabId"],
                "expectedRevision": saved["revision"],
            })
            deadline = time.monotonic() + 3.0
            while any(t["id"] == created["tabId"] for t in self.studio.tabs) and time.monotonic() < deadline:
                self.app.processEvents()
                time.sleep(0.005)

            reopen_res = self.studio._agent_document_action({
                "action": "open_document",
                "filename": str(saved_path),
                "background": False,
            })
            self.assertEqual(reopen_res["status"], "opening")
            reopened_tab = self._await_tab_path(self.studio, saved_path)
            self.studio.selectTab(reopened_tab["id"])

            # Containing directory (downloads_dir) must NOT be broadened for open_document or MCP roots.
            self.assertNotIn(str(downloads_dir), self.studio._agent_mcp_roots())
            for attempt in (str(sibling_secret_md), sibling_secret_md.name):
                with self.assertRaisesRegex(ValueError, "approved agent note roots"):
                    self.studio._agent_document_action({
                        "action": "open_document",
                        "filename": attempt,
                        "background": True,
                    })

            # Containing directory must NOT be broadened for attach_tab_asset on the agent-created note.
            rev = self._rev(reopened_tab["content"])
            for asset_arg in (str(sibling_secret_svg), sibling_secret_svg.name):
                with self.assertRaisesRegex(ValueError, "inside the current note folder or a configured folder"):
                    self.studio._attach_tab_asset_native({
                        "tabId": reopened_tab["id"],
                        "assetPath": asset_arg,
                        "expectedRevision": rev,
                    })

            # Explicitly approving a workspace folder permits assets from that approved folder,
            # while still blocking assets in the unapproved downloads_dir.
            self.studio.openFolder(str(approved_assets_dir))
            attached = self.studio._attach_tab_asset_native({
                "tabId": reopened_tab["id"],
                "assetPath": str(approved_svg),
                "assetName": "diagram.svg",
                "expectedRevision": rev,
            })
            self.assertEqual(attached["assetName"], "assets/diagram.svg")

            with self.assertRaisesRegex(ValueError, "inside the current note folder or a configured folder"):
                self.studio._replace_tab_asset_native({
                    "tabId": reopened_tab["id"],
                    "assetName": "assets/diagram.svg",
                    "assetPath": str(sibling_secret_svg),
                    "expectedRevision": rev,
                })

            replaced = self.studio._replace_tab_asset_native({
                "tabId": reopened_tab["id"],
                "assetName": "assets/diagram.svg",
                "assetPath": str(approved_replacement_svg),
                "expectedRevision": rev,
            })
            self.assertTrue(replaced["changed"])

            # 2. Agent saveAs on a user-opened tab into downloads_dir must also NOT broaden downloads_dir.
            self.studio.closeFolder()
            user_smd = user_dir / "user-study.smd"
            write_portable(user_smd, "# User study\n", {"assets/diagram.svg": "data:image/svg+xml;base64," + base64.b64encode(SVG_BYTES).decode("ascii")})
            self.studio.openNote(str(user_smd))
            user_tab = self._await_tab_path(self.studio, user_smd)
            self.studio.selectTab(user_tab["id"])
            copied = self.studio._agent_document_action({
                "action": "save_document",
                "tabId": user_tab["id"],
                "filename": "agent-copy.smd",
                "saveAs": True,
                "expectedRevision": self._rev(user_tab["content"]),
            })
            self.assertEqual(Path(copied["path"]).parent, downloads_dir)
            self.assertNotIn(str(downloads_dir), self.studio._agent_mcp_roots())
            with self.assertRaisesRegex(ValueError, "inside the current note folder or a configured folder"):
                self.studio._replace_tab_asset_native({
                    "tabId": user_tab["id"],
                    "assetName": "assets/diagram.svg",
                    "assetPath": str(sibling_secret_svg),
                    "expectedRevision": copied["revision"],
                })

    def test_hidden_entries_rejected_across_live_open_asset_handling_and_document_store(self):
        workspace = self.base / "workspace"
        (workspace / ".obsidian").mkdir(parents=True)
        (workspace / "notes" / ".private").mkdir(parents=True)
        visible_note = workspace / "notes" / "visible.md"
        hidden_file = workspace / ".secret.md"
        hidden_dir_note = workspace / ".obsidian" / "workspace-note.md"
        nested_hidden_note = workspace / "notes" / ".private" / "draft.md"
        for p in (visible_note, hidden_file, hidden_dir_note, nested_hidden_note):
            p.write_text("# Note\n", encoding="utf-8")

        visible_svg = workspace / "notes" / "chart.svg"
        hidden_svg = workspace / ".hidden.svg"
        hidden_dir_svg = workspace / ".obsidian" / "icon.svg"
        nested_hidden_svg = workspace / "notes" / ".private" / "chart.svg"
        for p in (visible_svg, hidden_svg, hidden_dir_svg, nested_hidden_svg):
            p.write_bytes(SVG_BYTES)

        portable_note = workspace / "study.smd"
        markdown = "# Study\n"
        write_portable(
            portable_note,
            markdown,
            {"assets/existing.svg": "data:image/svg+xml;base64," + base64.b64encode(SVG_BYTES).decode("ascii")},
        )

        self.studio.openFolder(str(workspace))
        self.studio.setNoteLocation(str(workspace))
        self.studio.openNote(str(portable_note))
        smd_tab = self._await_tab_path(self.studio, portable_note)
        self.studio.selectTab(smd_tab["id"])
        rev = self._rev(markdown)

        # Visible note opens cleanly.
        self.assertTrue(self.studio._agent_path_allowed(visible_note))

        # Hidden files and files under hidden directories are rejected in live open_document.
        for bad_note in (
            str(hidden_file),
            ".secret.md",
            str(hidden_dir_note),
            ".obsidian/workspace-note.md",
            str(nested_hidden_note),
            str(workspace / ".obsidian" / ".." / "notes" / "visible.md"),
        ):
            with self.subTest(open_target=bad_note):
                with self.assertRaisesRegex(ValueError, "approved agent note roots"):
                    self.studio._agent_document_action({
                        "action": "open_document",
                        "filename": bad_note,
                        "background": True,
                    })

        # Hidden assets are rejected across shared validator, attach, and replace.
        for bad_asset in (
            str(hidden_svg),
            ".hidden.svg",
            str(hidden_dir_svg),
            ".obsidian/icon.svg",
            str(nested_hidden_svg),
            "notes/.private/chart.svg",
        ):
            with self.subTest(asset_target=bad_asset):
                with self.assertRaisesRegex(ValueError, "outside"):
                    _validate_local_tab_asset_path(
                        bad_asset,
                        portable_note,
                        [workspace],
                        unavailable_message="unavailable",
                        outside_message="outside",
                    )
                with self.assertRaisesRegex(ValueError, "inside the current note folder or a configured folder"):
                    self.studio._attach_tab_asset_native({
                        "tabId": smd_tab["id"],
                        "assetPath": bad_asset,
                        "expectedRevision": rev,
                    })
                with self.assertRaisesRegex(ValueError, "inside the current note folder or a configured folder"):
                    self.studio._replace_tab_asset_native({
                        "tabId": smd_tab["id"],
                        "assetName": "assets/existing.svg",
                        "assetPath": bad_asset,
                        "expectedRevision": rev,
                    })

        # Visible asset inside approved workspace succeeds.
        attached = self.studio._attach_tab_asset_native({
            "tabId": smd_tab["id"],
            "assetPath": "notes/chart.svg",
            "expectedRevision": rev,
        })
        self.assertEqual(attached["assetName"], "assets/chart.svg")

        # DocumentStore also rejects hidden files and hidden directories.
        store = DocumentStore([workspace])
        self.assertEqual(store.resolve("notes/visible.md").resolve(), visible_note)
        for bad_rel in (".secret.md", ".obsidian/workspace-note.md", "notes/.private/draft.md", str(hidden_file)):
            with self.subTest(store_target=bad_rel):
                with self.assertRaises(AgentDocumentError):
                    store.resolve(bad_rel)

    def test_mcp_live_bridge_enforces_agent_note_isolation_and_hidden_entry_checks(self):
        from mcp import Client

        async def scenario():
            downloads_dir = self.base / "mcp-downloads"
            workspace_dir = self.base / "mcp-workspace"
            downloads_dir.mkdir()
            (workspace_dir / ".secret").mkdir(parents=True)

            sibling_note = downloads_dir / "private.md"
            sibling_note.write_text("# Private\n", encoding="utf-8")
            sibling_svg = downloads_dir / "private.svg"
            sibling_svg.write_bytes(SVG_BYTES)
            hidden_svg = workspace_dir / ".secret" / "hidden.svg"
            hidden_svg.write_bytes(SVG_BYTES)
            visible_svg = workspace_dir / "visible.svg"
            visible_svg.write_bytes(SVG_BYTES)

            bridge = create_qt_bridge(self.session, self.session.data)
            self.session.agent_bridge = bridge

            def handle_native_request(raw: str):
                request = json.loads(raw)
                try:
                    if request["action"] == "flush_current":
                        result = {"flushed": True}
                    elif request["action"] == "asset_action":
                        result = self.studio._attach_tab_asset_native(request)
                    else:
                        result = self.studio._agent_document_action(request)
                    bridge.complete(request["requestId"], result, window_id=self.studio.window_id)
                except Exception as error:
                    bridge.complete(request["requestId"], None, str(error), window_id=self.studio.window_id)

            self.studio.agentRequest.connect(handle_native_request)

            async def call_with_qt(coro):
                task = asyncio.create_task(coro)
                while not task.done():
                    self.app.processEvents()
                    await asyncio.sleep(0.01)
                return await task

            with patch.object(QStandardPaths, "writableLocation", return_value=str(downloads_dir)):
                try:
                    self.studio.setAgentAccessEnabled(True)
                    live_client = MultiSessionLiveClient(bridge.discovery_dir)
                    server, _ = build_mcp_server([], live_client=live_client)
                    async with Client(server) as client:
                        created = await call_with_qt(client.call_tool("document_action", {
                            "action": "create_document",
                            "title": "mcp-agent.smd",
                            "format": "smd",
                            "content": "# MCP Agent\n",
                        }))
                        self.assertFalse(created.is_error)
                        tab_target = created.structured_content["target"]
                        rev = created.structured_content["revision"]

                        saved = await call_with_qt(client.call_tool("document_action", {
                            "action": "save_document",
                            "path": tab_target,
                            "expected_revision": rev,
                        }))
                        self.assertFalse(saved.is_error)

                        bad_open = await call_with_qt(client.call_tool("document_action", {
                            "action": "open_document",
                            "path": str(sibling_note),
                        }))
                        self.assertTrue(bad_open.is_error)

                        bad_attach = await call_with_qt(client.call_tool("document_attach_asset", {
                            "path": tab_target,
                            "asset_path": str(sibling_svg),
                            "expected_revision": rev,
                        }))
                        self.assertTrue(bad_attach.is_error)

                        self.studio.openFolder(str(workspace_dir))
                        hidden_attach = await call_with_qt(client.call_tool("document_attach_asset", {
                            "path": tab_target,
                            "asset_path": str(hidden_svg),
                            "expected_revision": rev,
                        }))
                        self.assertTrue(hidden_attach.is_error)

                        good_attach = await call_with_qt(client.call_tool("document_attach_asset", {
                            "path": tab_target,
                            "asset_path": str(visible_svg),
                            "expected_revision": rev,
                        }))
                        self.assertFalse(good_attach.is_error)
                finally:
                    bridge.stop()

        asyncio.run(scenario())

    def test_persisted_root_settings_and_agent_created_tabs_restore_safely_across_sessions(self):
        app_data = self.base / "app-data"
        workspace_dir = self.base / "persisted-workspace"
        note_loc_dir = self.base / "persisted-notes"
        downloads_dir = self.base / "persisted-downloads"
        outside_dir = self.base / "persisted-outside"
        for folder in (app_data, workspace_dir, note_loc_dir, downloads_dir, outside_dir):
            folder.mkdir()

        ws_note = workspace_dir / "ws-note.md"
        ws_hidden = workspace_dir / ".ws-hidden.md"
        loc_note = note_loc_dir / "loc-note.md"
        loc_svg = note_loc_dir / "loc-fig.svg"
        dl_secret = downloads_dir / "dl-secret.md"
        dl_svg = downloads_dir / "dl-secret.svg"
        outside_note = outside_dir / "outside.md"
        for p in (ws_note, ws_hidden, loc_note, dl_secret, outside_note):
            p.write_text(f"# {p.stem}\n", encoding="utf-8")
        loc_svg.write_bytes(SVG_BYTES)
        dl_svg.write_bytes(SVG_BYTES)

        # Session 1: configure workspace folder + newNoteLocation, plus an agent-created note in downloads_dir.
        session1 = Session(isolated=False, data=app_data)
        session1.settings["python"] = sys.executable
        studio1 = QuietStudio(False, session1)
        try:
            with patch.object(QStandardPaths, "writableLocation", return_value=str(downloads_dir)):
                created = studio1._agent_document_action({
                    "action": "create_document",
                    "title": "persisted-agent.smd",
                    "format": "smd",
                    "content": "# Persisted agent note\n",
                })
                saved = studio1._agent_document_action({
                    "action": "save_document",
                    "tabId": created["tabId"],
                    "expectedRevision": created["revision"],
                })
                agent_saved_path = Path(saved["path"])
                self.assertEqual(agent_saved_path.parent, downloads_dir)

            studio1.openFolder(str(workspace_dir))
            studio1.setNoteLocation(str(note_loc_dir))
            studio1._recover()
        finally:
            studio1.stop()
            studio1.pool.shutdown(wait=True, cancel_futures=True)
            session1.writes.shutdown(wait=True)
            studio1.deleteLater()
            self.app.sendPostedEvents(None, QEvent.Type.DeferredDelete)
            self.app.processEvents()

        # Session 2: verify persisted workspace folder & newNoteLocation restore, while agent-created note
        # restored from startup.json still does NOT broaden downloads_dir.
        session2 = Session(isolated=False, data=app_data)
        session2.settings["python"] = sys.executable
        studio2 = QuietStudio(False, session2)
        try:
            restored_agent_tab = self._await_tab_path(studio2, agent_saved_path)
            self.assertEqual(studio2.folder, str(workspace_dir))
            self.assertEqual(studio2.settings["newNoteLocation"], str(note_loc_dir))

            self.assertTrue(studio2._agent_path_allowed(ws_note))
            self.assertTrue(studio2._agent_path_allowed(loc_note))
            self.assertTrue(studio2._agent_path_allowed(agent_saved_path))
            self.assertFalse(studio2._agent_path_allowed(ws_hidden))
            self.assertFalse(studio2._agent_path_allowed(dl_secret))
            self.assertFalse(studio2._agent_path_allowed(outside_note))
            self.assertNotIn(str(downloads_dir), studio2._agent_mcp_roots())

            studio2.selectTab(restored_agent_tab["id"])
            rev = self._rev(restored_agent_tab["content"])
            with self.assertRaisesRegex(ValueError, "inside the current note folder or a configured folder"):
                studio2._attach_tab_asset_native({
                    "tabId": restored_agent_tab["id"],
                    "assetPath": str(dl_svg),
                    "expectedRevision": rev,
                })
            attached = studio2._attach_tab_asset_native({
                "tabId": restored_agent_tab["id"],
                "assetPath": str(loc_svg),
                "expectedRevision": rev,
            })
            self.assertEqual(attached["assetName"], "assets/loc-fig.svg")

            # Closing folder persists removal of workspace_dir root while keeping newNoteLocation.
            studio2.closeFolder()
        finally:
            studio2.stop()
            studio2.pool.shutdown(wait=True, cancel_futures=True)
            session2.writes.shutdown(wait=True)
            studio2.deleteLater()
            self.app.sendPostedEvents(None, QEvent.Type.DeferredDelete)
            self.app.processEvents()

        # Session 3: tamper settings.json with a symlinked newNoteLocation -> rejected on load!
        if os.name == "posix":
            symlink_root = self.base / "symlink-note-loc"
            symlink_root.symlink_to(outside_dir)
            settings_file = app_data / "settings.json"
            raw_settings = json.loads(settings_file.read_text(encoding="utf-8"))
            raw_settings["settings"]["newNoteLocation"] = str(symlink_root)
            settings_file.write_text(json.dumps(raw_settings), encoding="utf-8")

            session3 = Session(isolated=False, data=app_data)
            session3.settings["python"] = sys.executable
            studio3 = QuietStudio(False, session3)
            try:
                self.assertEqual(studio3.folder, "")
                self.assertEqual(studio3.settings["newNoteLocation"], "")
                self.assertFalse(studio3._agent_path_allowed(ws_note))
                self.assertFalse(studio3._agent_path_allowed(outside_note))
                studio3.setNoteLocation(str(symlink_root))
                self.assertEqual(studio3.settings["newNoteLocation"], "")
                studio3.openFolder(str(symlink_root))
                self.assertEqual(studio3.folder, "")
            finally:
                studio3.stop()
                studio3.pool.shutdown(wait=True, cancel_futures=True)
                session3.writes.shutdown(wait=True)
                studio3.deleteLater()
                self.app.sendPostedEvents(None, QEvent.Type.DeferredDelete)
                self.app.processEvents()

    def test_generated_mcp_roots_exclude_open_tabs_while_single_note_operations_keep_working(self):
        workspace_dir = self.base / "explicit-workspace"
        configured_dir = self.base / "configured-notes"
        standalone_dir = self.base / "standalone-notes"
        for folder in (workspace_dir, configured_dir, standalone_dir):
            folder.mkdir()

        user_smd = standalone_dir / "authorized.smd"
        sibling_note = standalone_dir / "unapproved-sibling.md"
        local_svg = standalone_dir / "local-figure.svg"
        replacement_svg = standalone_dir / "local-figure-v2.svg"
        write_portable(
            user_smd,
            "# Authorized single note\n",
            {"assets/existing.svg": "data:image/svg+xml;base64," + base64.b64encode(SVG_BYTES).decode("ascii")},
        )
        sibling_note.write_text("# Sibling\n", encoding="utf-8")
        local_svg.write_bytes(SVG_BYTES)
        replacement_svg.write_bytes(SVG_REPLACEMENT_BYTES)

        bridge = create_qt_bridge(self.session, self.session.data)
        self.session.agent_bridge = bridge
        try:
            self.studio.setAgentAccessEnabled(True)
            self.studio.openNote(str(user_smd))
            user_tab = self._await_tab_path(self.studio, user_smd)
            self.studio.selectTab(user_tab["id"])

            # Without workspace/configured roots, an open user tab must NOT add its parent folder to MCP --root.
            self.assertEqual(self.studio._agent_mcp_roots(), [])
            setup_payload = json.loads(self.studio.agentSetupInstructions)
            self.assertNotIn("--root", setup_payload["args"])

            # Configuring workspace and newNoteLocation populates only those explicit directory roots.
            self.studio.openFolder(str(workspace_dir))
            self.studio.setNoteLocation(str(configured_dir))
            self.assertEqual(
                self.studio._agent_mcp_roots(),
                [str(workspace_dir), str(configured_dir)],
            )
            self.assertNotIn(str(standalone_dir), self.studio._agent_mcp_roots())

            # Removing those roots clears MCP --root even though user_smd remains open.
            self.studio.closeFolder()
            self.studio.settings["newNoteLocation"] = ""
            self.assertEqual(self.studio._agent_mcp_roots(), [])

            # Single-note operations on the individually authorized note continue working,
            # while sibling notes in standalone_dir remain blocked.
            self.assertTrue(self.studio._agent_path_allowed(user_smd))
            self.assertFalse(self.studio._agent_path_allowed(sibling_note))

            patched = self.studio._agent_document_action({
                "action": "patch_tab",
                "tabId": user_tab["id"],
                "expectedRevision": self._rev(user_tab["content"]),
                "operations": [{"type": "replace", "old": "# Authorized single note\n", "new": "# Authorized single note\n\nUpdated body.\n"}],
            })
            saved = self.studio._agent_document_action({
                "action": "save_document",
                "tabId": user_tab["id"],
                "expectedRevision": patched["revision"],
            })
            self.assertFalse(saved["pathChanged"])

            attached = self.studio._attach_tab_asset_native({
                "tabId": user_tab["id"],
                "assetPath": str(local_svg),
                "assetName": "added.svg",
                "expectedRevision": saved["revision"],
            })
            self.assertEqual(attached["assetName"], "assets/added.svg")

            replaced = self.studio._replace_tab_asset_native({
                "tabId": user_tab["id"],
                "assetName": "assets/existing.svg",
                "assetPath": str(replacement_svg),
                "expectedRevision": attached["revision"],
            })
            self.assertTrue(replaced["changed"])

            with self.assertRaisesRegex(ValueError, "approved agent note roots"):
                self.studio._agent_document_action({
                    "action": "open_document",
                    "filename": str(sibling_note),
                    "background": True,
                })
        finally:
            bridge.stop()

    def test_removing_approved_root_revokes_automation_opened_tabs_and_preserves_provenance_across_restart(self):
        app_data = self.base / "root-removal-data"
        workspace_a = self.base / "workspace-a"
        workspace_b = self.base / "workspace-b"
        configured_root = self.base / "configured-root"
        standalone_dir = self.base / "standalone-user"
        for folder in (app_data, workspace_a, workspace_b, configured_root, standalone_dir):
            folder.mkdir()

        auto_ws_smd = workspace_a / "auto-opened.smd"
        ws_svg = workspace_a / "ws-fig.svg"
        auto_cfg_md = configured_root / "auto-configured.md"
        user_md = standalone_dir / "user-authorized.md"
        write_portable(
            auto_ws_smd,
            "# Automation workspace note\n",
            {"assets/fig.svg": "data:image/svg+xml;base64," + base64.b64encode(SVG_BYTES).decode("ascii")},
        )
        ws_svg.write_bytes(SVG_REPLACEMENT_BYTES)
        auto_cfg_md.write_text("# Automation configured note\n", encoding="utf-8")
        user_md.write_text("# User authorized note\n", encoding="utf-8")

        session1 = Session(isolated=False, data=app_data)
        session1.settings["python"] = sys.executable
        studio1 = QuietStudio(False, session1)
        bridge = create_qt_bridge(session1, session1.data)
        session1.agent_bridge = bridge

        def handle_native_request(raw: str):
            request = json.loads(raw)
            try:
                if request["action"] == "flush_current":
                    result = {"flushed": True}
                elif request["action"] == "list_tabs":
                    result = {"tabs": request["tabs"]}
                else:
                    result = studio1._agent_document_action(request)
                bridge.complete(request["requestId"], result, window_id=studio1.window_id)
            except Exception as error:
                bridge.complete(request["requestId"], None, str(error), window_id=studio1.window_id)

        studio1.agentRequest.connect(handle_native_request)
        try:
            studio1.setAgentAccessEnabled(True)
            studio1.openFolder(str(workspace_a))
            studio1.setNoteLocation(str(configured_root))
            studio1.openNote(str(user_md))
            user_tab = self._await_tab_path(studio1, user_md)

            # Automation opens notes under workspace_a and configured_root.
            studio1._agent_document_action({
                "action": "open_document",
                "filename": str(auto_ws_smd),
                "background": False,
            })
            studio1._agent_document_action({
                "action": "open_document",
                "filename": str(auto_cfg_md),
                "background": True,
            })
            auto_ws_tab = self._await_tab_path(studio1, auto_ws_smd)
            auto_cfg_tab = self._await_tab_path(studio1, auto_cfg_md)
            self.assertTrue(auto_ws_tab.get("agentOpened"))
            self.assertTrue(auto_cfg_tab.get("agentOpened"))

            # In-place save via automation while workspace_a is approved must NOT promote auto_ws_tab to user-granted.
            patched_ws = studio1._agent_document_action({
                "action": "patch_tab",
                "tabId": auto_ws_tab["id"],
                "expectedRevision": self._rev(auto_ws_tab["content"]),
                "operations": [{"type": "replace", "old": "# Automation workspace note\n", "new": "# Automation workspace note\n\nSaved while approved.\n"}],
            })
            saved_ws = studio1._agent_document_action({
                "action": "save_document",
                "tabId": auto_ws_tab["id"],
                "expectedRevision": patched_ws["revision"],
            })
            self.assertTrue(auto_ws_tab.get("agentOpened"))

            # Switching workspace folder away from workspace_a immediately revokes access to auto_ws_smd!
            studio1.openFolder(str(workspace_b))
            self.assertNotIn(str(workspace_a), studio1._agent_mcp_roots())
            self.assertEqual(
                studio1._agent_mcp_roots(),
                [str(workspace_b), str(configured_root)],
            )
            self.assertFalse(studio1._agent_path_allowed(auto_ws_smd))

            with self.assertRaisesRegex(ValueError, "approved agent note roots"):
                studio1._agent_document_action({
                    "action": "open_document",
                    "filename": str(auto_ws_smd),
                    "background": True,
                })
            with self.assertRaisesRegex(ValueError, "approved agent note roots"):
                studio1._agent_document_action({
                    "action": "open_document",
                    "filename": "",
                    "tabId": auto_ws_tab["id"],
                    "background": True,
                })
            with self.assertRaisesRegex(ValueError, "approved agent note roots"):
                studio1._agent_document_action({
                    "action": "patch_tab",
                    "tabId": auto_ws_tab["id"],
                    "expectedRevision": saved_ws["revision"],
                    "operations": [{"type": "replace", "old": "Saved while approved.", "new": "Blocked edit."}],
                })
            with self.assertRaisesRegex(ValueError, "approved agent note roots"):
                studio1._agent_document_action({
                    "action": "save_document",
                    "tabId": auto_ws_tab["id"],
                    "expectedRevision": saved_ws["revision"],
                })
            studio1.selectTab(auto_ws_tab["id"])
            with self.assertRaisesRegex(ValueError, "approved agent note roots"):
                studio1._attach_tab_asset_native({
                    "tabId": auto_ws_tab["id"],
                    "assetPath": str(ws_svg),
                    "assetName": "extra.svg",
                    "expectedRevision": saved_ws["revision"],
                })
            with self.assertRaisesRegex(ValueError, "approved agent note roots"):
                studio1._replace_tab_asset_native({
                    "tabId": auto_ws_tab["id"],
                    "assetName": "assets/fig.svg",
                    "assetPath": str(ws_svg),
                    "expectedRevision": saved_ws["revision"],
                })

            # Live bridge list_tabs and read_tab also exclude/reject the revoked automation-opened tab.
            from mcp import Client

            async def check_bridge():
                live_client = MultiSessionLiveClient(bridge.discovery_dir)
                server, _ = build_mcp_server([], live_client=live_client)

                async def call_with_qt(coro):
                    task = asyncio.create_task(coro)
                    while not task.done():
                        self.app.processEvents()
                        await asyncio.sleep(0.01)
                    return await task

                async with Client(server) as client:
                    listed = await call_with_qt(client.call_tool("list_sessions", {}))
                    self.assertFalse(listed.is_error)
                    sessions = listed.structured_content.get("sessions", [])
                    listed_paths = [item.get("path") for item in sessions]
                    self.assertNotIn(str(auto_ws_smd), listed_paths)
                    self.assertIn(str(auto_cfg_md), listed_paths)
                    self.assertIn(str(user_md), listed_paths)

                    user_target = next(item["target"] for item in sessions if item.get("path") == str(user_md))
                    revoked_target = user_target.rsplit(":", 1)[0] + ":" + auto_ws_tab["id"]
                    revoked_read = await call_with_qt(client.call_tool("document_read", {
                        "path": revoked_target,
                    }))
                    self.assertTrue(revoked_read.is_error)

            asyncio.run(check_bridge())

            # Removing configured_root revokes auto_cfg_md too, while user_md stays individually authorized!
            studio1.settings["newNoteLocation"] = ""
            studio1.closeFolder()
            studio1._preferences()
            studio1._recover()

            self.assertFalse(studio1._agent_path_allowed(auto_cfg_md))
            with self.assertRaisesRegex(ValueError, "approved agent note roots"):
                studio1._agent_document_action({
                    "action": "patch_tab",
                    "tabId": auto_cfg_tab["id"],
                    "expectedRevision": self._rev(auto_cfg_tab["content"]),
                    "operations": [{"type": "replace", "old": "# Automation configured note\n", "new": "# Blocked\n"}],
                })

            # Individually user-authorized note still supports live operations.
            self.assertTrue(studio1._agent_path_allowed(user_md))
            patched_user = studio1._agent_document_action({
                "action": "patch_tab",
                "tabId": user_tab["id"],
                "expectedRevision": self._rev(user_tab["content"]),
                "operations": [{"type": "replace", "old": "# User authorized note\n", "new": "# User authorized note\n\nStill authorized.\n"}],
            })
            studio1._agent_document_action({
                "action": "save_document",
                "tabId": user_tab["id"],
                "expectedRevision": patched_user["revision"],
            })
        finally:
            bridge.stop()
            studio1.stop()
            studio1.pool.shutdown(wait=True, cancel_futures=True)
            session1.writes.shutdown(wait=True)
            studio1.deleteLater()
            self.app.sendPostedEvents(None, QEvent.Type.DeferredDelete)
            self.app.processEvents()

        # Restarting session preserves agentOpened provenance so removed roots stay revoked!
        session2 = Session(isolated=False, data=app_data)
        session2.settings["python"] = sys.executable
        studio2 = QuietStudio(False, session2)
        try:
            restored_auto_ws = self._await_tab_path(studio2, auto_ws_smd)
            restored_user = self._await_tab_path(studio2, user_md)
            self.assertTrue(restored_auto_ws.get("agentOpened"))
            self.assertFalse(studio2._agent_path_allowed(auto_ws_smd))
            self.assertFalse(studio2._agent_path_allowed(auto_cfg_md))
            self.assertTrue(studio2._agent_path_allowed(user_md))
            with self.assertRaisesRegex(ValueError, "approved agent note roots"):
                studio2._agent_document_action({
                    "action": "patch_tab",
                    "tabId": restored_auto_ws["id"],
                    "expectedRevision": self._rev(restored_auto_ws["content"]),
                    "operations": [{"type": "replace", "old": "Saved while approved.", "new": "Still blocked."}],
                })

            # Explicit user open upgrades auto_ws_smd to an individual user-authorized note!
            studio2.openNote(str(auto_ws_smd))
            self.app.processEvents()
            self.assertFalse(restored_auto_ws.get("agentOpened"))
            self.assertTrue(studio2._agent_path_allowed(auto_ws_smd))
            self.assertTrue(studio2._is_tab_live_authorized(restored_user))
        finally:
            studio2.stop()
            studio2.pool.shutdown(wait=True, cancel_futures=True)
            session2.writes.shutdown(wait=True)
            studio2.deleteLater()
            self.app.sendPostedEvents(None, QEvent.Type.DeferredDelete)
            self.app.processEvents()

    def test_ordered_external_drops_and_link_jumps_enforce_explicit_approval_rules(self):
        drop_dir = self.base / "dropped-notes"
        sibling_dir = self.base / "dropped-folder"
        outside_dir = self.base / "outside-targets"
        link_dir = self.base / "linked-notes"
        for folder in (drop_dir, sibling_dir, outside_dir, link_dir):
            folder.mkdir()

        note_one = drop_dir / "01-first.md"
        note_two = drop_dir / "02-second.md"
        note_three = drop_dir / "03-third.md"
        unopened_sibling = drop_dir / "unopened-sibling.md"
        hidden_note = drop_dir / ".hidden-drop.md"
        outside_secret = outside_dir / "secret.md"
        folder_note = sibling_dir / "inside-folder.md"
        link_source = link_dir / "index.md"
        link_target = link_dir / "chapter-two.md"
        link_sibling = link_dir / "unrelated.md"
        for p in (
            note_one,
            note_two,
            note_three,
            unopened_sibling,
            hidden_note,
            outside_secret,
            folder_note,
            link_source,
            link_target,
            link_sibling,
        ):
            p.write_text(f"# {p.stem}\n\n## Details\n", encoding="utf-8")

        drop_items: list[str] = [str(note_one), str(hidden_note), str(note_two), str(note_three)]
        symlink_note = drop_dir / "symlink-note.md"
        symlink_folder = drop_dir / "symlink-folder"
        if os.name == "posix":
            symlink_note.symlink_to(outside_secret)
            symlink_folder.symlink_to(outside_dir, target_is_directory=True)
            drop_items.insert(2, str(symlink_note))
            self.assertTrue(self.studio.shouldInterceptExternalDrop([str(symlink_folder)], False))
            self.studio.handleExternalDrop([str(symlink_folder)], False)
            self.assertEqual(self.studio.folder, "")
            self.assertFalse(self.studio._agent_path_allowed(outside_secret))

        # 1. Ordered multi-file drop (#118): valid notes open in exact order, hidden/symlink items are skipped,
        # and only the dropped notes receive single-note approval (not drop_dir or unopened_sibling).
        self.studio.handleExternalDrop(drop_items, False)
        tab_one = self._await_tab_path(self.studio, note_one)
        tab_two = self._await_tab_path(self.studio, note_two)
        tab_three = self._await_tab_path(self.studio, note_three)
        deadline = time.monotonic() + 3.0
        while self.studio.active != tab_three["id"] and time.monotonic() < deadline:
            self.app.processEvents()
            time.sleep(0.005)
        opened_order = [
            t["path"]
            for t in self.studio.tabs
            if t["path"] in {str(note_one), str(note_two), str(note_three)}
        ]
        self.assertEqual(opened_order, [str(note_one), str(note_two), str(note_three)])
        self.assertEqual(self.studio.active, tab_three["id"])
        self.assertIn("Skipped", self.studio.message)
        for allowed_drop in (note_one, note_two, note_three):
            self.assertTrue(self.studio._agent_path_allowed(allowed_drop))
        for disallowed_drop in (unopened_sibling, hidden_note, outside_secret):
            self.assertFalse(self.studio._agent_path_allowed(disallowed_drop))
        self.assertEqual(self.studio._agent_mcp_roots(), [])

        # Dropping a real folder approves that folder until closed.
        self.studio.handleExternalDrop([str(sibling_dir)], False)
        self.assertEqual(self.studio.folder, str(sibling_dir))
        self.assertTrue(self.studio._agent_path_allowed(folder_note))
        self.studio.closeFolder()
        self.assertFalse(self.studio._agent_path_allowed(folder_note))

        # 2. Relative link navigation & manual tab selection (#72):
        # Link destination receives single-note approval + pendingHeading without directory grant,
        # and manual selectTab clears pendingHeading.
        replies: list[tuple[str, str, str]] = []
        self.studio.replied.connect(lambda req_id, res, err: replies.append((req_id, res, err)))
        self.studio.openNote(str(link_source))
        self._await_tab_path(self.studio, link_source)
        self.studio.post("rel-link-1", "open_workspace_link", json.dumps({
            "documentPath": str(link_source),
            "target": "chapter-two.md",
            "fragment": "Details",
            "wikilink": False,
        }))
        deadline = time.monotonic() + 3.0
        while not any(r[0] == "rel-link-1" for r in replies) and time.monotonic() < deadline:
            self.app.processEvents()
            time.sleep(0.005)
        target_tab = self._await_tab_path(self.studio, link_target)
        self.assertEqual(self.studio.active, target_tab["id"])
        self.assertIsInstance(target_tab.get("pendingHeading"), dict)
        self.assertEqual(target_tab["pendingHeading"].get("heading"), "Details")
        self.assertTrue(self.studio._agent_path_allowed(link_target))
        self.assertFalse(self.studio._agent_path_allowed(link_sibling))
        self.assertNotIn(str(link_dir), self.studio._agent_mcp_roots())

        self.studio.selectTab(tab_one["id"])
        self.assertIsNone(target_tab.get("pendingHeading"))

    def test_native_picker_outer_whitespace_folder_remains_only_approved_root_across_save_and_restart(self):
        app_data = self.base / "whitespace-app-data"
        downloads_dir = self.base / "whitespace-downloads"
        # Windows Win32 APIs strip trailing spaces on directory creation, whereas leading
        # spaces are valid on Windows and leading/trailing spaces are valid on POSIX.
        selected_note_name = "Study notes " if os.name != "nt" else " Study notes"
        decoy_note_name = "Study notes"
        selected_ws_name = " Workspace " if os.name != "nt" else " Workspace"
        decoy_ws_name = "Workspace"

        selected_note_dir = self.base / selected_note_name
        decoy_note_dir = self.base / decoy_note_name
        selected_ws_dir = self.base / selected_ws_name
        decoy_ws_dir = self.base / decoy_ws_name
        for folder in (app_data, downloads_dir, selected_note_dir, decoy_note_dir, selected_ws_dir, decoy_ws_dir):
            folder.mkdir()

        self.assertNotEqual(selected_note_dir, decoy_note_dir)
        self.assertFalse(os.path.samefile(selected_note_dir, decoy_note_dir))
        self.assertNotEqual(selected_ws_dir, decoy_ws_dir)
        self.assertFalse(os.path.samefile(selected_ws_dir, decoy_ws_dir))

        selected_note = selected_note_dir / "approved-note.md"
        selected_svg = selected_note_dir / "approved-fig.svg"
        decoy_note = decoy_note_dir / "decoy-note.md"
        decoy_svg = decoy_note_dir / "decoy-fig.svg"
        selected_ws_smd = selected_ws_dir / "ws-approved.smd"
        selected_ws_svg = selected_ws_dir / "ws-approved.svg"
        selected_ws_empty_sub = selected_ws_dir / "AssetsOnly"
        selected_ws_notes_sub = selected_ws_dir / "NotesSub"
        selected_ws_empty_sub.mkdir()
        selected_ws_notes_sub.mkdir()
        (selected_ws_empty_sub / "diagram.svg").write_bytes(SVG_BYTES)
        selected_ws_sub_note = selected_ws_notes_sub / "nested-topic.md"
        selected_ws_sub_note.write_text("# Nested topic\n\nOuter whitespace needle match\n", encoding="utf-8")
        decoy_ws_note = decoy_ws_dir / "ws-decoy.md"
        decoy_ws_svg = decoy_ws_dir / "ws-decoy.svg"

        for note_file in (selected_note, decoy_note):
            note_file.write_text(f"# {note_file.stem}\n", encoding="utf-8")
        decoy_ws_note.write_text("# ws-decoy\n\nOuter whitespace needle match\n", encoding="utf-8")
        write_portable(
            selected_ws_smd,
            "# Approved workspace portable note\n",
            {"assets/existing.svg": "data:image/svg+xml;base64," + base64.b64encode(SVG_BYTES).decode("ascii")},
        )
        selected_svg.write_bytes(SVG_REPLACEMENT_BYTES)
        selected_ws_svg.write_bytes(SVG_BYTES)
        decoy_svg.write_bytes(SVG_REPLACEMENT_BYTES)
        decoy_ws_svg.write_bytes(SVG_REPLACEMENT_BYTES)

        expected_note_dir_str = str(selected_note_dir.resolve(strict=True))
        expected_ws_dir_str = str(selected_ws_dir.resolve(strict=True))
        decoy_note_dir_str = str(decoy_note_dir.resolve(strict=True))
        decoy_ws_dir_str = str(decoy_ws_dir.resolve(strict=True))

        # Native QML FolderDialog passes selectedFolder.toString() into setNoteLocation / openFolder.
        picker_note_url = QUrl.fromLocalFile(str(selected_note_dir)).toString()
        picker_ws_url = QUrl.fromLocalFile(str(selected_ws_dir)).toString()

        session1 = Session(isolated=False, data=app_data)
        session1.settings["python"] = sys.executable
        studio1 = QuietStudio(False, session1)
        bridge1 = create_qt_bridge(session1, session1.data)
        session1.agent_bridge = bridge1
        try:
            with patch.object(QStandardPaths, "writableLocation", return_value=str(downloads_dir)):
                studio1.setAgentAccessEnabled(True)
                studio1.setNoteLocation(picker_note_url)
                studio1.openFolder(picker_ws_url)

                # Exact unchanged canonical native paths are stored in memory.
                self.assertEqual(studio1.settings["newNoteLocation"], expected_note_dir_str)
                self.assertEqual(os.fsencode(studio1.settings["newNoteLocation"]), os.fsencode(expected_note_dir_str))
                self.assertEqual(studio1.folder, expected_ws_dir_str)
                self.assertEqual(os.fsencode(studio1.folder), os.fsencode(expected_ws_dir_str))

                # Blank/whitespace-only picker values are rejected without clobbering roots or approving CWD.
                for blank in ("", "   "):
                    studio1.setNoteLocation(blank)
                    studio1.openFolder(blank)
                self.assertEqual(studio1.settings["newNoteLocation"], expected_note_dir_str)
                self.assertEqual(studio1.folder, expected_ws_dir_str)

                # Symlinks (even with outer whitespace in their own name) remain rejected.
                if os.name == "posix":
                    symlink_space = self.base / "Symlink notes "
                    symlink_space.symlink_to(decoy_note_dir, target_is_directory=True)
                    symlink_picker_url = QUrl.fromLocalFile(str(symlink_space)).toString()
                    studio1.setNoteLocation(symlink_picker_url)
                    studio1.openFolder(symlink_picker_url)
                    self.assertEqual(studio1.settings["newNoteLocation"], expected_note_dir_str)
                    self.assertEqual(studio1.folder, expected_ws_dir_str)

                # MCP roots and setup config contain only the exact outer-whitespace directories.
                self.assertEqual(studio1._agent_mcp_roots(), [expected_ws_dir_str, expected_note_dir_str])
                setup_args = json.loads(studio1.agentSetupInstructions)["args"]
                self.assertIn(expected_ws_dir_str, setup_args)
                self.assertIn(expected_note_dir_str, setup_args)
                self.assertNotIn(decoy_ws_dir_str, setup_args)
                self.assertNotIn(decoy_note_dir_str, setup_args)

                # Default save and export locations preserve exact outer whitespace.
                self.assertEqual(Path(studio1.defaultSaveFolder().toLocalFile()), Path(expected_note_dir_str))
                self.assertEqual(
                    Path(studio1.defaultExportLocation("pdf").toLocalFile()).parent,
                    Path(expected_note_dir_str),
                )

                # Selected folders are approved; stripped-name sibling decoys are rejected.
                self.assertTrue(studio1._agent_path_allowed(selected_note))
                self.assertTrue(studio1._agent_path_allowed(selected_ws_smd))
                self.assertFalse(studio1._agent_path_allowed(decoy_note))
                self.assertFalse(studio1._agent_path_allowed(decoy_ws_note))

                for blocked_note in (decoy_note, decoy_ws_note):
                    with self.assertRaisesRegex(ValueError, "approved agent note roots"):
                        studio1._agent_document_action({
                            "action": "open_document",
                            "filename": str(blocked_note),
                            "background": True,
                        })

                studio1._agent_document_action({
                    "action": "open_document",
                    "filename": str(selected_ws_smd),
                    "background": False,
                })
                ws_tab = self._await_tab_path(studio1, selected_ws_smd)
                studio1.selectTab(ws_tab["id"])
                rev = self._rev(ws_tab["content"])

                for blocked_svg in (decoy_svg, decoy_ws_svg):
                    with self.assertRaisesRegex(ValueError, "inside the current note folder or a configured folder"):
                        studio1._attach_tab_asset_native({
                            "tabId": ws_tab["id"],
                            "assetPath": str(blocked_svg),
                            "expectedRevision": rev,
                        })

                attached = studio1._attach_tab_asset_native({
                    "tabId": ws_tab["id"],
                    "assetPath": str(selected_svg),
                    "assetName": "from-note-loc.svg",
                    "expectedRevision": rev,
                })
                self.assertEqual(attached["assetName"], "assets/from-note-loc.svg")

                # #151 folder sidebar filtering & folder search honor the exact outer-whitespace folder
                # and both independent Boolean preferences (keepInBackground & hideNonNoteFolders).
                self.assertIs(studio1.settings["keepInBackground"], False)
                self.assertIs(studio1.settings["hideNonNoteFolders"], True)
                deadline = time.monotonic() + 3.0
                while [f["name"] for f in studio1.files] != ["NotesSub", "ws-approved.smd"] and time.monotonic() < deadline:
                    self.app.processEvents()
                    time.sleep(0.005)
                self.assertEqual([f["name"] for f in studio1.files], ["NotesSub", "ws-approved.smd"])

                studio1.setting("keepInBackground", "true")
                self.assertIs(studio1.settings["keepInBackground"], True)
                self.assertIs(studio1.settings["hideNonNoteFolders"], True)

                studio1.setting("hideNonNoteFolders", "false")
                self.assertIs(studio1.settings["hideNonNoteFolders"], False)
                self.assertIs(studio1.settings["keepInBackground"], True)
                deadline = time.monotonic() + 3.0
                while [f["name"] for f in studio1.files] != ["AssetsOnly", "NotesSub", "ws-approved.smd"] and time.monotonic() < deadline:
                    self.app.processEvents()
                    time.sleep(0.005)
                self.assertEqual([f["name"] for f in studio1.files], ["AssetsOnly", "NotesSub", "ws-approved.smd"])

                studio1.openFolderSearch()
                studio1.updateFolderSearch("Outer whitespace needle match", False, False)
                deadline = time.monotonic() + 3.0
                while studio1._folder_search_scanning and time.monotonic() < deadline:
                    self.app.processEvents()
                    time.sleep(0.005)
                matched_paths = [m["path"] for m in studio1._folder_search_matches]
                self.assertEqual(matched_paths, [str(selected_ws_sub_note.resolve(strict=True))])
                self.assertNotIn(str(decoy_ws_note.resolve(strict=True)), matched_paths)
                studio1.closeFolderSearch()

                studio1._preferences()
                studio1._recover()
        finally:
            bridge1.stop()
            studio1.stop()
            studio1.pool.shutdown(wait=True, cancel_futures=True)
            studio1._search_pool.shutdown(wait=True, cancel_futures=True)
            session1.writes.shutdown(wait=True)
            studio1.deleteLater()
            self.app.sendPostedEvents(None, QEvent.Type.DeferredDelete)
            self.app.processEvents()

        saved_settings_json = json.loads((app_data / "settings.json").read_text(encoding="utf-8"))
        self.assertEqual(saved_settings_json["settings"]["newNoteLocation"], expected_note_dir_str)
        self.assertIs(saved_settings_json["settings"]["keepInBackground"], True)
        self.assertIs(saved_settings_json["settings"]["hideNonNoteFolders"], False)
        self.assertEqual(
            os.fsencode(saved_settings_json["settings"]["newNoteLocation"]),
            os.fsencode(expected_note_dir_str),
        )

        # Session 2: restart from persisted settings.json + startup.json and verify outer whitespace
        # is NOT stripped on reload and the stripped-name siblings remain unapproved.
        session2 = Session(isolated=False, data=app_data)
        session2.settings["python"] = sys.executable
        studio2 = QuietStudio(False, session2)
        try:
            restored_tab = self._await_tab_path(studio2, selected_ws_smd)
            self.assertEqual(session2.settings["newNoteLocation"], expected_note_dir_str)
            self.assertEqual(studio2.settings["newNoteLocation"], expected_note_dir_str)
            self.assertIs(studio2.settings["keepInBackground"], True)
            self.assertIs(studio2.settings["hideNonNoteFolders"], False)
            self.assertEqual(studio2.folder, expected_ws_dir_str)
            self.assertEqual(studio2._agent_mcp_roots(), [expected_ws_dir_str, expected_note_dir_str])
            deadline = time.monotonic() + 3.0
            while [f["name"] for f in studio2.files] != ["AssetsOnly", "NotesSub", "ws-approved.smd"] and time.monotonic() < deadline:
                self.app.processEvents()
                time.sleep(0.005)
            self.assertEqual([f["name"] for f in studio2.files], ["AssetsOnly", "NotesSub", "ws-approved.smd"])
            studio2.setting("hideNonNoteFolders", "true")
            self.assertIs(studio2.settings["hideNonNoteFolders"], True)
            self.assertIs(studio2.settings["keepInBackground"], True)
            deadline = time.monotonic() + 3.0
            while [f["name"] for f in studio2.files] != ["NotesSub", "ws-approved.smd"] and time.monotonic() < deadline:
                self.app.processEvents()
                time.sleep(0.005)
            self.assertEqual([f["name"] for f in studio2.files], ["NotesSub", "ws-approved.smd"])

            self.assertTrue(studio2._agent_path_allowed(selected_note))
            self.assertTrue(studio2._agent_path_allowed(selected_ws_smd))
            self.assertFalse(studio2._agent_path_allowed(decoy_note))
            self.assertFalse(studio2._agent_path_allowed(decoy_ws_note))

            opened = studio2._agent_document_action({
                "action": "open_document",
                "filename": str(selected_note),
                "background": True,
            })
            self.assertEqual(opened["status"], "opening")
            self._await_tab_path(studio2, selected_note)

            for blocked_note in (decoy_note, decoy_ws_note):
                with self.assertRaisesRegex(ValueError, "approved agent note roots"):
                    studio2._agent_document_action({
                        "action": "open_document",
                        "filename": str(blocked_note),
                        "background": True,
                    })

            studio2.selectTab(restored_tab["id"])
            rev2 = self._rev(restored_tab["content"])
            for blocked_svg in (decoy_svg, decoy_ws_svg):
                with self.assertRaisesRegex(ValueError, "inside the current note folder or a configured folder"):
                    studio2._replace_tab_asset_native({
                        "tabId": restored_tab["id"],
                        "assetName": "assets/existing.svg",
                        "assetPath": str(blocked_svg),
                        "expectedRevision": rev2,
                    })
            replaced = studio2._replace_tab_asset_native({
                "tabId": restored_tab["id"],
                "assetName": "assets/existing.svg",
                "assetPath": str(selected_svg),
                "expectedRevision": rev2,
            })
            self.assertTrue(replaced["changed"])

            # DocumentStore constructed from MCP roots also honors only the outer-whitespace folders.
            store = DocumentStore(studio2._agent_mcp_roots())
            self.assertEqual(store.resolve(str(selected_note)).resolve(), selected_note.resolve())
            for blocked_note in (decoy_note, decoy_ws_note):
                with self.assertRaises(AgentDocumentError):
                    store.resolve(str(blocked_note))

            # Dropping a folder URL with outer whitespace also preserves exact directory identity.
            studio2.closeFolder()
            studio2.settings["newNoteLocation"] = ""
            studio2.handleExternalDrop([picker_note_url], False)
            self.assertEqual(studio2.folder, expected_note_dir_str)
            self.assertTrue(studio2._agent_path_allowed(selected_note))
            self.assertFalse(studio2._agent_path_allowed(decoy_note))
        finally:
            studio2.stop()
            studio2.pool.shutdown(wait=True, cancel_futures=True)
            studio2._search_pool.shutdown(wait=True, cancel_futures=True)
            session2.writes.shutdown(wait=True)
            studio2.deleteLater()
            self.app.sendPostedEvents(None, QEvent.Type.DeferredDelete)
            self.app.processEvents()

    def test_exact_recovery_staging_quick_switcher_and_provenance_across_save_reopen_and_restart(self):
        app_data = self.base / "merge-reconciliation-data"
        workspace_a = self.base / "merge-ws-a"
        note_loc_a_name = "Quick notes " if os.name != "nt" else " Quick notes"
        note_loc_a = self.base / note_loc_a_name
        note_loc_decoy = self.base / "Quick notes"
        note_loc_b = self.base / "merge-notes-b"
        downloads_dir = self.base / "merge-downloads"
        user_dir = self.base / "merge-user"
        for folder in (app_data, workspace_a, note_loc_a, note_loc_decoy, note_loc_b, downloads_dir, user_dir):
            folder.mkdir()

        focus_md = user_dir / "active-focus.md"
        user_md = user_dir / "user-approved.md"
        user_sibling_md = user_dir / "user-sibling.md"
        auto_md = workspace_a / "agent-opened.md"
        dl_sibling_md = downloads_dir / "downloads-secret.md"
        loc_a_seed = note_loc_a / "seed-a.md"
        loc_decoy_seed = note_loc_decoy / "decoy-seed.md"
        loc_b_seed = note_loc_b / "seed-b.md"
        for p in (focus_md, user_md, user_sibling_md, auto_md, dl_sibling_md, loc_a_seed, loc_decoy_seed, loc_b_seed):
            p.write_text(f"# {p.stem}\n", encoding="utf-8")

        session1 = Session(isolated=False, data=app_data)
        session1.settings["python"] = sys.executable
        studio1 = QuietStudio(False, session1)
        bridge1 = create_qt_bridge(session1, session1.data)
        session1.agent_bridge = bridge1

        def run_async_action(studio_obj: Studio, payload: dict):
            holder: dict[str, object] = {"done": False, "result": None, "error": None}
            try:
                studio_obj._agent_document_action_async(
                    payload,
                    lambda res, err: holder.update(done=True, result=res, error=err),
                )
            except Exception as exc:
                return None, str(exc)
            deadline = time.monotonic() + 5.0
            while not holder["done"] and time.monotonic() < deadline:
                self.app.processEvents()
                time.sleep(0.005)
            self.assertTrue(holder["done"], f"Async action timed out: {payload.get('action')}")
            return holder["result"], holder["error"]

        try:
            with patch.object(QStandardPaths, "writableLocation", return_value=str(downloads_dir)):
                studio1.setAgentAccessEnabled(True)
                studio1.openNote(str(focus_md))
                focus_tab = self._await_tab_path(studio1, focus_md)
                studio1.openNote(str(user_md))
                user_tab = self._await_tab_path(studio1, user_md)

                # Direct studio_agent_setup.agent_mcp_roots call must exclude open-tab parent folders.
                self.assertEqual(studio_agent_setup.agent_mcp_roots(studio1), [])

                # 1. Filename-switcher (#131) invalidation hooks + outer-whitespace note location.
                picker_loc_a_url = QUrl.fromLocalFile(str(note_loc_a)).toString()
                studio1.setNoteLocation(picker_loc_a_url)
                expected_loc_a = str(note_loc_a.resolve(strict=True))
                self.assertEqual(studio_agent_setup.agent_mcp_roots(studio1), [expected_loc_a])

                cached_entries = session1.folder_note_index.get_entries(expected_loc_a)
                self.assertEqual([e["name"] for e in cached_entries], ["seed-a.md"])
                self.assertIsNotNone(session1.folder_note_index.peek_entries(expected_loc_a))

                # Creating a new note via _save_text invalidates FolderNoteIndex for expected_loc_a.
                created_ui_path = note_loc_a / "ui-saved.md"
                studio1.newNote()
                ui_tab = studio1._current()
                ui_tab["content"] = "# UI saved\n"
                studio1._save_text(ui_tab, created_ui_path, automatic=False)
                deadline = time.monotonic() + 3.0
                while session1.folder_note_index.peek_entries(expected_loc_a) is not None and time.monotonic() < deadline:
                    self.app.processEvents()
                    time.sleep(0.005)
                self.assertIsNone(session1.folder_note_index.peek_entries(expected_loc_a))
                updated_entries = session1.folder_note_index.get_entries(expected_loc_a)
                self.assertEqual(sorted(e["name"] for e in updated_entries), ["seed-a.md", "ui-saved.md"])
                studio1.closeTab(ui_tab["id"])
                deadline = time.monotonic() + 3.0
                while any(t["id"] == ui_tab["id"] for t in studio1.tabs) and time.monotonic() < deadline:
                    self.app.processEvents()
                    time.sleep(0.005)
                studio1.closed_tabs.clear()

                # Switching setNoteLocation invalidates both old and new locations.
                studio1.setNoteLocation(str(note_loc_b))
                self.assertIsNone(session1.folder_note_index.peek_entries(expected_loc_a))
                self.assertEqual(
                    [e["name"] for e in session1.folder_note_index.get_entries(str(note_loc_b))],
                    ["seed-b.md"],
                )
                studio1.settings["newNoteLocation"] = ""

                # 2. Open an automation-opened tab under workspace_a and an agent-created tab in downloads_dir.
                studio1.openFolder(str(workspace_a))
                studio1._agent_document_action({
                    "action": "open_document",
                    "filename": str(auto_md),
                    "background": True,
                })
                auto_tab = self._await_tab_path(studio1, auto_md)

                created_info = studio1._agent_document_action({
                    "action": "create_document",
                    "title": "agent-created-merge.md",
                    "format": "md",
                    "content": "# Agent created\n",
                    "background": True,
                })
                saved_created, save_err = run_async_action(studio1, {
                    "action": "save_document",
                    "tabId": created_info["tabId"],
                    "expectedRevision": created_info["revision"],
                })
                self.assertIsNone(save_err)
                created_path = Path(saved_created["path"])
                self.assertEqual(created_path.parent, downloads_dir)
                created_tab = self._await_tab_path(studio1, created_path)

                # Keep focus_tab active so user_tab, auto_tab, and created_tab all take #276's inactive staging path.
                studio1.selectTab(focus_tab["id"])
                self.assertEqual(studio1.active, focus_tab["id"])

                staged_auto, auto_err = run_async_action(studio1, {
                    "action": "patch_tab",
                    "tabId": auto_tab["id"],
                    "expectedRevision": self._rev(auto_tab["content"]),
                    "operations": [{"type": "replace", "old": "# agent-opened\n", "new": "# agent-opened\n\nStaged v1.\n"}],
                })
                self.assertIsNone(auto_err)
                self.assertTrue(staged_auto["changed"])
                self.assertTrue(auto_tab.get("agent_staged"))
                self.assertTrue(auto_tab.get("agentOpened"))

                # Closing workspace_a immediately revokes exact recovery staging & post-flush dispatch on auto_tab,
                # while inactive user_tab and created_tab continue staging cleanly.
                studio1.closeFolder()
                denied_res, denied_err = run_async_action(studio1, {
                    "action": "patch_tab",
                    "tabId": auto_tab["id"],
                    "expectedRevision": staged_auto["revision"],
                    "operations": [{"type": "replace", "old": "Staged v1.", "new": "Should fail."}],
                })
                self.assertIsNone(denied_res)
                self.assertIn("approved agent note roots", str(denied_err))
                self.assertIn("Staged v1.", auto_tab["content"])

                staged_user, user_err = run_async_action(studio1, {
                    "action": "patch_tab",
                    "tabId": user_tab["id"],
                    "expectedRevision": self._rev(user_tab["content"]),
                    "operations": [{"type": "replace", "old": "# user-approved\n", "new": "# user-approved\n\nUser staged.\n"}],
                })
                self.assertIsNone(user_err)
                self.assertTrue(staged_user["changed"])
                self.assertTrue(user_tab.get("agent_staged"))

                staged_created, created_err = run_async_action(studio1, {
                    "action": "patch_tab",
                    "tabId": created_tab["id"],
                    "expectedRevision": saved_created["revision"],
                    "operations": [{"type": "replace", "old": "# Agent created\n", "new": "# Agent created\n\nCreated staged.\n"}],
                })
                self.assertIsNone(created_err)
                self.assertTrue(staged_created["changed"])
                self.assertTrue(created_tab.get("agent_staged"))

                # 3. Autosave and manual in-place save preserve provenance distinctions and clear agent_staged on manual save.
                studio1.openFolder(str(workspace_a))
                studio1._save_text(auto_tab, auto_md, automatic=True)
                deadline = time.monotonic() + 3.0
                while auto_tab["saved"] != auto_tab["content"] and time.monotonic() < deadline:
                    self.app.processEvents()
                    time.sleep(0.005)
                self.assertTrue(auto_tab.get("agentOpened"))
                self.assertNotIn(str(auto_md), studio1._agent_open_paths)

                auto_tab["content"] = "# agent-opened\n\nManual in-place save.\n"
                auto_tab["agent_staged"] = True
                studio1._save_text(auto_tab, auto_md, automatic=False)
                deadline = time.monotonic() + 3.0
                while auto_tab["saved"] != auto_tab["content"] and time.monotonic() < deadline:
                    self.app.processEvents()
                    time.sleep(0.005)
                self.assertFalse(auto_tab.get("agent_staged"))
                self.assertTrue(auto_tab.get("agentOpened"))
                self.assertNotIn(str(auto_md), studio1._agent_open_paths)

                studio1._save_text(created_tab, created_path, automatic=False)
                deadline = time.monotonic() + 3.0
                while created_tab["saved"] != created_tab["content"] and time.monotonic() < deadline:
                    self.app.processEvents()
                    time.sleep(0.005)
                self.assertFalse(created_tab.get("agent_staged"))
                self.assertTrue(created_tab.get("agentCreated"))
                self.assertNotIn(str(created_path), studio1._agent_open_paths)

                # Stage another inactive edit on auto_tab while workspace_a is approved, then close workspace_a.
                studio1.selectTab(focus_tab["id"])
                restaged_auto, restage_err = run_async_action(studio1, {
                    "action": "patch_tab",
                    "tabId": auto_tab["id"],
                    "expectedRevision": self._rev(auto_tab["content"]),
                    "operations": [{"type": "replace", "old": "Manual in-place save.", "new": "Staged before close & restart."}],
                })
                self.assertIsNone(restage_err)
                self.assertTrue(restaged_auto["changed"])
                self.assertTrue(auto_tab.get("agent_staged"))
                studio1.closeFolder()
                self.assertFalse(studio1._is_tab_live_authorized(auto_tab))

                # 4. Close and reopenTab() preserves provenance across all three categories.
                for closing_id in (user_tab["id"], created_tab["id"], auto_tab["id"]):
                    studio1.closeTab(closing_id)
                    deadline = time.monotonic() + 3.0
                    while any(t["id"] == closing_id for t in studio1.tabs) and time.monotonic() < deadline:
                        self.app.processEvents()
                        time.sleep(0.005)

                for _ in range(3):
                    before_count = len(studio1.tabs)
                    studio1.reopenTab()
                    deadline = time.monotonic() + 3.0
                    while len(studio1.tabs) == before_count and time.monotonic() < deadline:
                        self.app.processEvents()
                        time.sleep(0.005)

                reopened_user = self._await_tab_path(studio1, user_md)
                reopened_created = self._await_tab_path(studio1, created_path)
                reopened_auto = self._await_tab_path(studio1, auto_md)

                self.assertTrue(studio1._agent_path_allowed(user_md))
                self.assertFalse(studio1._agent_path_allowed(user_sibling_md))
                self.assertTrue(studio1._agent_path_allowed(created_path))
                self.assertFalse(studio1._agent_path_allowed(dl_sibling_md))
                self.assertTrue(reopened_created.get("agentCreated"))
                self.assertTrue(reopened_auto.get("agentOpened"))
                self.assertFalse(studio1._agent_path_allowed(auto_md))
                self.assertFalse(studio1._is_tab_live_authorized(reopened_auto))

                # Stage one more inactive edit on reopened_created and re-open workspace_a briefly to stage reopened_auto,
                # then close workspace_a and restart to verify recovery.json + startup.json provenance across restart!
                studio1.openFolder(str(workspace_a))
                studio1.selectTab(focus_tab["id"])
                _, err_a = run_async_action(studio1, {
                    "action": "patch_tab",
                    "tabId": reopened_auto["id"],
                    "expectedRevision": self._rev(reopened_auto["content"]),
                    "operations": [{"type": "replace", "old": "Staged before close & restart.", "new": "Persisted in recovery across restart."}],
                })
                self.assertIsNone(err_a)
                self.assertTrue(reopened_auto.get("agent_staged"))
                studio1.closeFolder()
                studio1._recover()
        finally:
            bridge1.stop()
            studio1.stop()
            studio1.pool.shutdown(wait=True, cancel_futures=True)
            session1.writes.shutdown(wait=True)
            studio1.deleteLater()
            self.app.sendPostedEvents(None, QEvent.Type.DeferredDelete)
            self.app.processEvents()

        # 5. Restart into Session 2 and verify recovery-claimed + startup-restored tabs keep exact provenance.
        session2 = Session(isolated=False, data=app_data)
        session2.settings["python"] = sys.executable
        studio2 = QuietStudio(False, session2)
        try:
            restored_user = self._await_tab_path(studio2, user_md)
            restored_created = self._await_tab_path(studio2, created_path)
            restored_auto = self._await_tab_path(studio2, auto_md)
            deadline = time.monotonic() + 3.0
            while studio2._restoring_paths and time.monotonic() < deadline:
                self.app.processEvents()
                time.sleep(0.005)

            self.assertIn("Persisted in recovery across restart.", restored_auto["content"])
            self.assertTrue(restored_auto.get("agent_staged"))
            self.assertTrue(restored_auto.get("agentOpened"))
            self.assertFalse(studio2._agent_path_allowed(auto_md))
            self.assertFalse(studio2._is_tab_live_authorized(restored_auto))
            with self.assertRaisesRegex(ValueError, "approved agent note roots"):
                studio2._agent_document_action({
                    "action": "patch_tab",
                    "tabId": restored_auto["id"],
                    "expectedRevision": self._rev(restored_auto["content"]),
                    "operations": [{"type": "replace", "old": "Persisted in recovery across restart.", "new": "Blocked after restart."}],
                })

            self.assertTrue(restored_created.get("agentCreated"))
            self.assertTrue(studio2._agent_path_allowed(created_path))
            self.assertFalse(studio2._agent_path_allowed(dl_sibling_md))

            self.assertFalse(restored_user.get("agentCreated"))
            self.assertFalse(restored_user.get("agentOpened"))
            self.assertTrue(studio2._agent_path_allowed(user_md))
            self.assertFalse(studio2._agent_path_allowed(user_sibling_md))

            # Explicit user Save As to a new path promotes only that new user-chosen copy.
            promoted_copy = user_dir / "user-saved-copy.md"
            studio2._save_text(restored_auto, promoted_copy, automatic=False)
            deadline = time.monotonic() + 3.0
            while restored_auto.get("path") != str(promoted_copy) and time.monotonic() < deadline:
                self.app.processEvents()
                time.sleep(0.005)
            self.assertFalse(restored_auto.get("agentOpened"))
            self.assertTrue(studio2._agent_path_allowed(promoted_copy))
            self.assertFalse(studio2._agent_path_allowed(auto_md))
        finally:
            studio2.stop()
            studio2.pool.shutdown(wait=True, cancel_futures=True)
            session2.writes.shutdown(wait=True)
            studio2.deleteLater()
            self.app.sendPostedEvents(None, QEvent.Type.DeferredDelete)
            self.app.processEvents()


if __name__ == "__main__":
    unittest.main()
