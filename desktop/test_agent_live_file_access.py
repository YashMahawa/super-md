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

from PySide6.QtCore import QEvent, QStandardPaths
from PySide6.QtGui import QGuiApplication

from agent_documents import AgentDocumentError, DocumentStore
from agent_live import create_qt_bridge
from agent_live_client import MultiSessionLiveClient
from documents import open_note, write_portable
from mcp_server import build_mcp_server
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


if __name__ == "__main__":
    unittest.main()
