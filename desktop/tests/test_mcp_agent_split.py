"""End-to-end tests for the desktop/agent MCP split, shared validators, CLI common, and #124/#154 coordination."""
from __future__ import annotations

import asyncio
import base64
import importlib.util
import io
import json
import os
import shutil
import subprocess
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest.mock import patch

DESKTOP_DIR = Path(__file__).resolve().parents[1]
if str(DESKTOP_DIR) not in sys.path:
    sys.path.insert(0, str(DESKTOP_DIR))


@unittest.skipUnless(importlib.util.find_spec("mcp"), "install desktop/requirements-agent.txt for official SDK transport tests")
class AgentMCPSplitCoordinationTest(unittest.TestCase):
    def test_rooted_mcp_delegates_live_smd_asset_bounds_to_studio(self) -> None:
        asyncio.run(self._run_rooted_mcp_delegates_live_smd_asset_bounds_to_studio())

    async def _run_rooted_mcp_delegates_live_smd_asset_bounds_to_studio(self) -> None:
        from agent_live import create_qt_bridge
        from agent_live_client import MultiSessionLiveClient
        from documents import write_portable
        from mcp import Client
        from mcp_server import build_mcp_server
        from PySide6.QtCore import QEvent
        from PySide6.QtGui import QGuiApplication
        from studio import Session, Studio

        app = QGuiApplication.instance() or QGuiApplication([])

        class QuietStudio(Studio):
            def _refresh_theme(self):
                self.system_dark = True

        async def call_with_qt(coro):
            task = asyncio.create_task(coro)
            while not task.done():
                app.processEvents()
                await asyncio.sleep(0.003)
            return await task

        with tempfile.TemporaryDirectory() as folder:
            base = Path(folder).resolve(strict=True)
            note_dir, outside_dir, ws_root, other_ws = base / "note-folder", base / "outside-folder", base / "approved-workspace", base / "other-workspace"
            # Win32 strips trailing spaces on directory creation; leading spaces are valid on Windows and POSIX.
            ws_space = base / ("Study notes " if os.name != "nt" else " Study notes")
            ws_decoy = base / "Study notes"
            for d in (note_dir, outside_dir, ws_root, other_ws, ws_space, ws_decoy):
                d.mkdir()
            smd_path, sibling_md, ws_md = note_dir / "study.smd", note_dir / "sibling.md", ws_root / "ws-note.md"
            note_local, outside_svg = note_dir / "fig3.svg", outside_dir / "secret.svg"
            note_shared, ws_shared, note_repl, ws_repl = note_dir / "shared.svg", ws_root / "shared.svg", note_dir / "repl.svg", ws_root / "repl.svg"
            space_svg, decoy_svg = ws_space / "spaced.svg", ws_decoy / "spaced.svg"
            write_portable(smd_path, "# Study note\n", {})
            sibling_md.write_text("# Sibling private\n", encoding="utf-8")
            ws_md.write_text("# Workspace note\n", encoding="utf-8")
            for p, body in (
                (note_local, b"<svg xmlns='http://www.w3.org/2000/svg'><polygon points='0,0 4,0 2,4'/></svg>"),
                (outside_svg, b"<svg xmlns='http://www.w3.org/2000/svg'><path d='M0 0'/></svg>"),
                (ws_root / "workspace-fig.svg", b"<svg xmlns='http://www.w3.org/2000/svg'><ellipse rx='3' ry='2'/></svg>"),
                (note_shared, b"<svg xmlns='http://www.w3.org/2000/svg'><circle id='from-note-dir' r='11'/></svg>"),
                (ws_shared, b"<svg xmlns='http://www.w3.org/2000/svg'><rect id='from-ws-root' width='99' height='99'/></svg>"),
                (note_repl, b"<svg xmlns='http://www.w3.org/2000/svg'><circle id='repl-from-note-dir' r='7'/></svg>"),
                (ws_repl, b"<svg xmlns='http://www.w3.org/2000/svg'><rect id='repl-from-ws-root' width='77' height='77'/></svg>"),
                (space_svg, b"<svg xmlns='http://www.w3.org/2000/svg'><circle id='from-spaced-root' r='5'/></svg>"),
                (decoy_svg, b"<svg xmlns='http://www.w3.org/2000/svg'><rect id='from-decoy-root' width='5' height='5'/></svg>"),
            ):
                p.write_bytes(body)
            escape_link = note_dir / "escape.svg"
            if os.name == "posix":
                escape_link.symlink_to(outside_svg)
            session = Session(isolated=True)
            session.settings["python"] = sys.executable
            bridge = create_qt_bridge(session, session.data)
            session.agent_bridge = bridge
            studio = QuietStudio(True, session)
            studio.openFolder(str(ws_root))
            studio.openNote(str(smd_path))
            for _ in range(200):
                app.processEvents()
                if any(t.get("path") == str(smd_path.resolve()) for t in studio.tabs):
                    break
                await asyncio.sleep(0.01)
            studio.mode = "live"

            def handle_native(raw):
                req = json.loads(raw)
                try:
                    if req["action"] == "flush_current":
                        res = {"flushed": True}
                    elif req["action"] == "asset_action":
                        res = studio._attach_tab_asset_native(req)
                    elif req["action"] == "replace_tab_asset":
                        res = studio._replace_tab_asset_native(req)
                    else:
                        res = studio._agent_document_action(req)
                    bridge.complete(req["requestId"], res, window_id=studio.window_id)
                except (ValueError, OSError, KeyError, RuntimeError) as err:
                    bridge.complete(req["requestId"], None, str(err), window_id=studio.window_id)

            studio.agentRequest.connect(handle_native)
            try:
                studio.setAgentAccessEnabled(True)
                # User single-note grant never expands _agent_mcp_roots() to note_dir.
                self.assertEqual(studio._agent_mcp_roots(), [str(ws_root.resolve())])
                rooted_server, _ = build_mcp_server(studio._agent_mcp_roots(), live_client=MultiSessionLiveClient(bridge.discovery_dir))
                async with Client(rooted_server) as client:
                    sessions = await call_with_qt(client.call_tool("list_sessions", {}))
                    entry = next(i for i in sessions.structured_content["sessions"] if i.get("path") == str(smd_path.resolve()))
                    target, rev = entry["target"], entry["revision"]
                    # Sibling note in user-opened note's folder is rejected by open_document.
                    self.assertTrue((await call_with_qt(client.call_tool("document_action", {"action": "open_document", "path": str(sibling_md)}))).is_error)
                    for bad in (".hidden.svg", str(outside_svg), *([str(escape_link)] if os.name == "posix" else [])):
                        self.assertTrue((await call_with_qt(client.call_tool("document_attach_asset", {"path": target, "asset_path": bad, "expected_revision": rev}))).is_error, bad)
                    for asset, name in ((str(note_local), "note-local.svg"), ("workspace-fig.svg", "ws-fig.svg")):
                        ok = await call_with_qt(client.call_tool("document_attach_asset", {"path": target, "asset_path": asset, "expected_revision": rev, "name": name}))
                        self.assertFalse(ok.is_error, ok.content[0].text if ok.content else "")
                        rev = ok.structured_content["revision"]
                    # Relative asset present in BOTH originating note folder and --root resolves from originating note folder first.
                    attached_shared = await call_with_qt(client.call_tool("document_attach_asset", {"path": target, "asset_path": "shared.svg", "expected_revision": rev, "name": "shared.svg"}))
                    self.assertFalse(attached_shared.is_error, attached_shared.content[0].text if attached_shared.content else "")
                    rev, shared_id = attached_shared.structured_content["revision"], attached_shared.structured_content["asset"]["name"]
                    extracted_shared = await call_with_qt(client.call_tool("document_assets", {"path": target, "action": "extract", "asset_name": shared_id, "expected_revision": rev}))
                    self.assertIn("from-note-dir", json.loads(extracted_shared.content[0].text)["source"])
                    replaced_shared = await call_with_qt(client.call_tool("document_assets", {"path": target, "action": "replace", "asset_id": shared_id, "asset_path": "repl.svg", "expected_revision": rev}))
                    self.assertFalse(replaced_shared.is_error, replaced_shared.content[0].text if replaced_shared.content else "")
                    rev = (replaced_shared.structured_content or json.loads(replaced_shared.content[0].text))["revision"]
                    extracted_repl = await call_with_qt(client.call_tool("document_assets", {"path": target, "action": "extract", "asset_name": shared_id, "expected_revision": rev}))
                    self.assertIn("repl-from-note-dir", json.loads(extracted_repl.content[0].text)["source"])
                    # Automation-opened tab under ws_root is immediately revoked when Studio switches roots, while user-opened study.smd stays live.
                    opened_ws = await call_with_qt(client.call_tool("document_action", {"action": "open_document", "path": "ws-note.md", "background": True}))
                    self.assertFalse(opened_ws.is_error, opened_ws.content[0].text if opened_ws.content else "")
                    for _ in range(200):
                        app.processEvents()
                        if any(t.get("path") == str(ws_md.resolve()) for t in studio.tabs):
                            break
                        await asyncio.sleep(0.01)
                    before_switch = await call_with_qt(client.call_tool("list_sessions", {}))
                    ws_target = next(s["target"] for s in before_switch.structured_content["sessions"] if s.get("path") == str(ws_md.resolve()))
                    studio.openFolder(str(other_ws))
                    after_switch = await call_with_qt(client.call_tool("list_sessions", {}))
                    listed_targets = {s["target"] for s in after_switch.structured_content["sessions"]}
                    self.assertIn(target, listed_targets)
                    self.assertNotIn(ws_target, listed_targets)
                    self.assertTrue((await call_with_qt(client.call_tool("document_read", {"path": ws_target}))).is_error)
                    self.assertFalse((await call_with_qt(client.call_tool("document_read", {"path": target}))).is_error)
                    # Outer-whitespace approved root preserves exact identity and rejects stripped-name decoy.
                    self.assertFalse(os.path.samefile(ws_space, ws_decoy))
                    studio.openFolder(str(ws_space))
                    spaced_server, _ = build_mcp_server(studio._agent_mcp_roots(), live_client=MultiSessionLiveClient(bridge.discovery_dir))
                    async with Client(spaced_server) as spaced_client:
                        self.assertTrue((await call_with_qt(spaced_client.call_tool("document_attach_asset", {"path": target, "asset_path": str(decoy_svg), "expected_revision": rev, "name": "decoy.svg"}))).is_error)
                        ok_sp = await call_with_qt(spaced_client.call_tool("document_attach_asset", {"path": target, "asset_path": str(space_svg), "expected_revision": rev, "name": "spaced.svg"}))
                        self.assertFalse(ok_sp.is_error, ok_sp.content[0].text if ok_sp.content else "")
                        self.assertIn("from-spaced-root", json.loads((await call_with_qt(spaced_client.call_tool("document_assets", {"path": target, "action": "extract", "asset_name": ok_sp.structured_content["asset"]["name"], "expected_revision": ok_sp.structured_content["revision"]}))).content[0].text)["source"])
            finally:
                studio.stop()
                studio.pool.shutdown(wait=True, cancel_futures=True)
                bridge.stop()
                session.writes.shutdown(wait=True)
                studio.deleteLater()
                app.sendPostedEvents(None, QEvent.Type.DeferredDelete)
                app.processEvents()
                shutil.rmtree(session.data, ignore_errors=True)

    def test_live_metadata_is_bounded_redacted_and_revision_bound(self) -> None:
        asyncio.run(self._run_live_metadata_is_bounded_redacted_and_revision_bound())

    async def _run_live_metadata_is_bounded_redacted_and_revision_bound(self) -> None:
        from mcp import Client
        from mcp_server import build_mcp_server

        png = base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO6pX+0AAAAASUVORK5CYII=")
        jpeg, rev = b"\xff\xd8\xff\xe0\x00\x10JFIF\x00\x01\x01\x00\x00\x01\x00\x01\x00\x00\xff\xd9", "a" * 64
        expected = {"title": "Path Integrals & Symmetries", "author": "Richard Feynman, Emmy Noether", "authors": ["Richard Feynman", "Emmy Noether"], "tags": ["quantum", "physics"]}
        vs = {"text": "---\ntitle: Path Integrals & Symmetries\n---\n", "start": 0, "end": 43, "total_chars": 64, "next_offset": 43, "truncated": True}

        class FakeLive:
            capture_has_props, render_revision, outline_revision, asset_page_revision, omit_inline_assets = True, rev, rev, rev, False

            def read_tab(self, tab_id, offset=0, limit=1, **kw):
                if "asset_limit" in kw:
                    return {"revision": self.asset_page_revision, "assets": [], "assetCount": 0}
                base = {"id": tab_id, "windowId": "w1", "title": "Path Integrals", "format": "markdown", "isDirty": True, "sourceLength": 64, "revision": rev, "properties": {**expected, "subtitle": "Hidden", "date": "2026-03-15", "secret": "x"}}
                return base if self.omit_inline_assets else {**base, "assets": [], "asset_count": 0}

            def outline_tab(self, tab_id, offset=0, limit=80):
                return {"revision": self.outline_revision, "headings": [{"index": 0, "level": 1, "title": "Lecture 1", "offset": 44}], "total": 1, "truncated": False}

            def document_action(self, tab_id, action, **kw):
                return {"tabId": tab_id, "revision": rev, "sourceLength": 64, "mode": "reader", "visibleSource": vs, "properties": {**expected, "subtitle": "Hidden", "aliases": ["Secret"]}, "reading": {"offset": 0, "heading": "H", "visibleText": "T"}}

            def render_tab(self, tab_id, width=1000, image_format="jpeg"):
                ctx = {"tabId": tab_id, "revision": self.render_revision, "sourceLength": 64, "mode": "reader", "visibleSource": vs, **({"properties": {**expected, "secret": "x"}} if self.capture_has_props else {})}
                return {"tabId": tab_id, "revision": self.render_revision, "mime_type": "image/png" if image_format == "png" else "image/jpeg", "data": png if image_format == "png" else jpeg, "width": 1, "height": 1, "context": ctx}

        fake = FakeLive()
        server, _ = build_mcp_server([], live_client=fake)
        async with Client(server) as client:
            ins = await client.call_tool("document_inspect", {"path": "tab:w1:t1"})
            self.assertEqual((ins.is_error, ins.structured_content["properties"], ins.structured_content["revision"]), (False, expected, rev))
            ctx = await client.call_tool("document_action", {"action": "get_context", "path": "tab:w1:t1"})
            self.assertEqual((ctx.is_error, ctx.structured_content["properties"]), (False, expected))
            self.assertEqual(json.loads((await client.call_tool("view_current", {"tabId": "w1:t1", "includeImage": False})).content[0].text)["readingContext"]["properties"], expected)
            with_img = json.loads((await client.call_tool("view_current", {"tabId": "w1:t1", "includeImage": True})).content[1].text)
            self.assertEqual((with_img["readingContext"]["properties"], with_img["captureContext"]["properties"]), (expected, expected))
            fake.capture_has_props = False
            self.assertEqual(json.loads((await client.call_tool("view_current", {"tabId": "w1:t1", "includeImage": True, "quality": "high"})).content[1].text)["readingContext"]["properties"], expected)
            fake.outline_revision = "b" * 64
            self.assertTrue((await client.call_tool("document_inspect", {"path": "tab:w1:t1"})).is_error)
            fake.outline_revision, fake.omit_inline_assets, fake.asset_page_revision = rev, True, "c" * 64
            self.assertTrue((await client.call_tool("document_inspect", {"path": "tab:w1:t1"})).is_error)
            fake.asset_page_revision, fake.render_revision = rev, "d" * 64
            self.assertTrue((await client.call_tool("view_current", {"tabId": "w1:t1", "includeImage": True})).is_error)

    def test_shared_validators_preserve_accepted_input_errors_and_limits(self) -> None:
        asyncio.run(self._run_shared_validators_preserve_accepted_input_errors_and_limits())

    async def _run_shared_validators_preserve_accepted_input_errors_and_limits(self) -> None:
        from agent_documents import AgentDocumentError
        from mcp import Client
        from mcp_server import build_mcp_server

        rev = "a" * 64

        class LimitLive:
            applied, oversized_context = [], False

            def search_tab(self, tab_id, **kw):
                return {"revision": rev, "matches": []}

            def document_action(self, tab_id, action, **kw):
                if action == "latex_apply":
                    self.applied.append(kw["repair_indices"])
                    return {"revision": "b" * 64, "applied": kw["repair_indices"]}
                if action == "export_document":
                    return {"jobId": "job-1", "status": "running", "format": kw["format"]}
                text = "x" * 25_000 if self.oversized_context else "ok"
                return {"revision": rev, "sourceLength": len(text), "visibleSource": {"text": text, "start": 0, "end": len(text)}}

        live = LimitLive()
        server, _ = build_mcp_server([], live_client=live)
        tools = {tool.name: tool.fn for tool in server._tool_manager.list_tools()}
        for fn_name, kw, pattern in (
            ("document_action", {"action": "latex_apply", "path": "tab:w:t", "expected_revision": rev, "repair_indices": []}, "1–40 selected repair indices"),
            ("document_action", {"action": "latex_apply", "path": "tab:w:t", "expected_revision": rev, "repair_indices": [-1]}, "nonnegative integer indices"),
            ("document_search", {"path": "tab:w:t", "query": "x", "limit": 26}, "query, limit, context, offset, or search flags are invalid"),
            ("document_action", {"action": "export", "path": "tab:w:t", "format": "pdf", "expected_revision": rev, "options": {"note": "x" * 8_100}}, "no larger than 8 KB"),
        ):
            with self.assertRaisesRegex(AgentDocumentError, pattern):
                tools[fn_name](**kw)
        async with Client(server) as client:
            dup = await client.call_tool("document_action", {"action": "latex_apply", "path": "tab:w:t", "expected_revision": rev, "repair_indices": [0, 0, 2]})
            self.assertEqual((dup.is_error, live.applied[-1]), (False, [0, 0, 2]))
            for bad in ({"action": "latex_apply", "path": "tab:w:t", "expected_revision": rev, "repair_indices": []},
                        {"action": "latex_apply", "path": "tab:w:t", "expected_revision": rev, "repair_indices": [-1]},
                        {"action": "export", "path": "tab:w:t", "format": "pdf", "expected_revision": rev, "options": {"note": "x" * 8_100}}):
                self.assertTrue((await client.call_tool("document_action", bad)).is_error)
            self.assertTrue((await client.call_tool("document_search", {"path": "tab:w:t", "query": "x", "limit": 26})).is_error)
            live.oversized_context = True
            self.assertTrue((await client.call_tool("document_action", {"action": "get_context", "path": "tab:w:t"})).is_error)
            with self.assertRaisesRegex(AgentDocumentError, "64 KB tool-output limit"):
                tools["document_action"](action="get_context", path="tab:w:t")


class AgentMCPExtractionUnitTest(unittest.TestCase):
    def test_mcp_facade_cli_common_and_headless_import_isolation(self) -> None:
        import agent_cli
        import agent_live_cli
        import mcp_server
        from agent import cli_common, mcp_http, mcp_tools
        from agent_documents import AgentDocumentError

        for a, b in ((mcp_server.BearerAuth, mcp_http.BearerAuth), (mcp_server.build_mcp_server, mcp_tools.build_mcp_server), (mcp_server._token, mcp_http._token), (mcp_server.main, mcp_http.main)):
            self.assertIs(a, b)
        check = ("from desktop import mcp_server as pm, agent_cli as pc; import mcp_server as fm, agent_cli as fc, sys; "
                 "from desktop.agent import validators as pv, cli_common as pcc; from agent import validators as fv, cli_common as fcc; "
                 "assert pm is fm and pc is fc and pv is fv and pcc is fcc and 'PySide6' not in sys.modules and 'mcp' not in sys.modules")
        res = subprocess.run([sys.executable, "-c", check], cwd=DESKTOP_DIR.parent, capture_output=True, text=True, check=False)
        self.assertEqual(res.returncode, 0, res.stderr)
        for raw, exp in ((None, None), ("0", 0), ("14", 14), ("7.4", "7.4"), ("Intro", "Intro")):
            self.assertEqual(cli_common.heading_selector(raw), exp)
        with patch("sys.stdout", io.StringIO()) as cli_out, self.assertRaises(agent_cli._UsageError):
            agent_cli._parser().parse_args(["--root", "/tmp", "read"])
        self.assertEqual(json.loads(cli_out.getvalue())["error"]["type"], "UsageError")
        with patch("sys.stdout", io.StringIO()) as live_out, self.assertRaises(agent_live_cli._CLIError):
            agent_live_cli._parser().parse_args(["--sessions-dir", "/tmp", "read"])
        self.assertEqual(live_out.getvalue(), "")
        with patch("sys.stdout", io.StringIO()):
            with self.assertRaises(AgentDocumentError):
                agent_cli._emit({"payload": "x" * 65_000})
            with self.assertRaises(agent_live_cli._CLIError):
                agent_live_cli._emit({"payload": "x" * 65_000})
        with tempfile.TemporaryDirectory() as d:
            (Path(d) / "entry.md").write_text("# Entry\nBody\n", encoding="utf-8")
            for cmd in ([sys.executable, str(DESKTOP_DIR / "agent_cli.py"), "--root", d, "inspect", "entry.md"], [sys.executable, "-m", "desktop.agent_cli", "--root", d, "inspect", "entry.md"],
                        [sys.executable, str(DESKTOP_DIR / "mcp_server.py"), "--help"], [sys.executable, "-m", "desktop.mcp_server", "--help"], [sys.executable, "-m", "desktop.agent_live_cli", "--help"]):
                self.assertEqual(subprocess.run(cmd, cwd=DESKTOP_DIR.parent, capture_output=True, text=True, check=False).returncode, 0)

    def test_context_normalizer_bounds_and_viewport_coherence(self) -> None:
        from agent import context_normalizer as cn

        props = cn.bounded_properties({"title": "  " + ("T" * 350) + "  ", "authors": ["  Alice  ", ""] + [f"A{i}" for i in range(25)], "tags": ["  math  "] + [f"t{i}" for i in range(60)], "subtitle": "secret"})
        self.assertEqual((len(props["title"]), len(props["authors"]), len(props["tags"]), "subtitle" in props), (298, 20, 50, False))
        self.assertIsNone(cn.bounded_properties({"subtitle": "hidden-only"}))
        norm = cn.normalize_reading_context({"sourceLength": 100, "properties": {"subtitle": "h"}, "visibleSource": {"text": "# Heading", "start": 0, "end": 9}})
        self.assertEqual(("properties" in norm, norm["visibleSource"]["total_chars"], norm["visibleSource"]["next_offset"], norm["visibleSource"]["truncated"]), (False, 100, 9, True))
        diags = cn.bounded_diagrams([{"id": "d1", "kind": "mermaid", "assetReference": "data:image/png;base64,x"}, {"id": "d2", "kind": "svg", "assetReference": "assets/fig.svg", "activeStep": True}])
        self.assertEqual(("assetReference" in diags[0], diags[1]["assetReference"]), (False, "assets/fig.svg"))
        self.assertIsNone(cn.bounded_active_step({"deckTitle": "D", "stepIndex": -1, "stepCount": 2}))
        cells = cn.bounded_python_cells([{"ok": True, "ordinal": 0, "stdout": "x" * 505, "figureIds": ["diagram:python:10:0", "diagram:other:1"]}])
        self.assertEqual((len(cells[0]["stdout"]), cells[0]["stdoutTruncated"], cells[0]["figureIds"]), (500, True, ["diagram:python:10:0"]))
        rev = "a" * 64
        init = cn.normalize_initial_reading_context({"tabId": "raw", "revision": rev, "sourceLength": 20, "properties": {"title": "Doc", "aliases": ["x"]}, "visibleSource": {"text": "hello", "start": 0, "end": 5}, "activeStep": {"bad": True}}, resolved_tab="s:w:raw", target="tab:s:w:raw")
        self.assertEqual((init["nativeTabId"], init["tabId"], init["properties"], "activeStep" in init), ("raw", "s:w:raw", {"title": "Doc"}, False))
        cap, cread = cn.viewport_contexts({"tabId": "raw", "revision": rev, "sourceLength": 20, "properties": {"title": "Doc", "subtitle": "h"}, "visibleSource": {"text": "hello", "start": 0, "end": 5}}, "s:w:raw", rev)
        self.assertEqual((cap["contextRevisionMatches"], cap["properties"], cread["properties"], cread["visibleSource"]["next_offset"]), (True, {"title": "Doc"}, {"title": "Doc"}, 5))
        mcap, mread = cn.viewport_contexts({"tabId": "raw", "revision": "b" * 64, "sourceLength": 20, "properties": {"title": "Stale"}, "visibleSource": {"text": "hello", "start": 0, "end": 5}}, "s:w:raw", rev)
        self.assertEqual((mcap["contextRevisionMatches"], mcap["properties"], mread), (False, {"title": "Stale"}, None))

    def test_resolve_live_asset_path_uses_shared_validators(self) -> None:
        from agent import mcp_live_helpers as lh
        from agent import validators as v
        from agent_documents import AgentDocumentError, DocumentStore

        store = DocumentStore([], allow_empty=True)
        self.assertEqual(lh.resolve_live_asset_path(store, r"\\?\  spaced\fig.svg "), r"  spaced\fig.svg ")
        with self.assertRaisesRegex(AgentDocumentError, "non-empty"):
            lh.resolve_live_asset_path(store, r"\\?\   ")
        with self.assertRaisesRegex(AgentDocumentError, "Hidden"):
            lh.resolve_live_asset_path(store, ".secret/fig.svg")
        with tempfile.TemporaryDirectory() as folder:
            base = Path(folder).resolve(strict=True)
            fig = base / "fig.svg"
            fig.write_text("<svg/>", encoding="utf-8")
            with patch.object(Path, "is_junction", lambda p: p == fig, create=True), self.assertRaisesRegex(AgentDocumentError, "Symbolic links"):
                lh.resolve_live_asset_path(store, str(fig))
            if os.name == "posix":
                priv = base / "private" / "var"
                (priv / "notes" / ".hidden").mkdir(parents=True)
                real_fig = priv / "notes" / "ok.svg"
                real_fig.write_text("<svg/>", encoding="utf-8")
                hidden_fig = priv / "notes" / ".hidden" / "secret.svg"
                hidden_fig.write_text("<svg/>", encoding="utf-8")
                note_md = priv / "notes" / "doc.md"
                note_md.write_text("# Doc\n", encoding="utf-8")
                hidden_md = priv / "notes" / ".hidden" / "doc.md"
                hidden_md.write_text("# Hidden\n", encoding="utf-8")
                alias_var = base / "var"
                alias_var.symlink_to(priv)
                esc = priv / "notes" / "esc.svg"
                esc.symlink_to(fig)
                aliases = ((str(alias_var), str(priv)),)
                ws_store = DocumentStore([str(priv / "notes")])
                with patch.object(v, "SYSTEM_PATH_ALIASES", aliases):
                    self.assertEqual(lh.resolve_live_asset_path(store, str(alias_var / "notes" / "ok.svg")), str(alias_var / "notes" / "ok.svg"))
                    self.assertEqual(lh.resolve_live_asset_path(ws_store, str(alias_var / "notes" / "ok.svg")), str(alias_var / "notes" / "ok.svg"))
                    with self.assertRaisesRegex(AgentDocumentError, "Hidden"):
                        lh.resolve_live_asset_path(ws_store, str(alias_var / "notes" / ".hidden" / "secret.svg"))
                    with self.assertRaisesRegex(AgentDocumentError, "Symbolic links"):
                        lh.resolve_live_asset_path(store, str(alias_var / "notes" / "esc.svg"))
                if importlib.util.find_spec("PySide6"):
                    from studio import Studio

                    stub = types.SimpleNamespace(folder=str(alias_var / "notes"), settings={}, tabs=[], _agent_open_paths=(), _agent_owned_files=())
                    self.assertTrue(Studio._agent_path_allowed(stub, alias_var / "notes" / "doc.md", _system_aliases=aliases))
                    self.assertEqual(Studio._resolve_agent_open_path(stub, str(alias_var / "notes" / "doc.md"), _system_aliases=aliases), note_md.resolve())
                    self.assertFalse(Studio._agent_path_allowed(stub, alias_var / "notes" / ".hidden" / "doc.md", _system_aliases=aliases))


if __name__ == "__main__":
    unittest.main()
