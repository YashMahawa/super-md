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
import unittest
from pathlib import Path
from unittest.mock import patch

DESKTOP_DIR = Path(__file__).resolve().parents[1]
if str(DESKTOP_DIR) not in sys.path:
    sys.path.insert(0, str(DESKTOP_DIR))


@unittest.skipUnless(importlib.util.find_spec("mcp"), "install desktop/requirements-agent.txt for official SDK transport tests")
class AgentMCPSplitCoordinationTest(unittest.IsolatedAsyncioTestCase):
    async def test_rooted_mcp_delegates_live_smd_asset_bounds_to_studio(self) -> None:
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
                await asyncio.sleep(0.01)
            return await task

        with tempfile.TemporaryDirectory() as folder:
            base = Path(folder)
            note_dir, outside_dir, ws_root = base / "note-folder", base / "outside-folder", base / "approved-workspace"
            for d in (note_dir, outside_dir, ws_root):
                d.mkdir()
            smd_path, note_local, outside_svg = note_dir / "study.smd", note_dir / "fig3.svg", outside_dir / "secret.svg"
            write_portable(smd_path, "# Study note\n", {})
            for p, body in ((note_local, b"<svg xmlns='http://www.w3.org/2000/svg'><polygon points='0,0 4,0 2,4'/></svg>"),
                            (outside_svg, b"<svg xmlns='http://www.w3.org/2000/svg'><path d='M0 0'/></svg>"),
                            (ws_root / "workspace-fig.svg", b"<svg xmlns='http://www.w3.org/2000/svg'><ellipse rx='3' ry='2'/></svg>")):
                p.write_bytes(body)
            escape_link = note_dir / "escape.svg"
            if os.name == "posix":
                escape_link.symlink_to(outside_svg)
            session = Session(isolated=True)
            session.settings["python"] = sys.executable
            bridge = create_qt_bridge(session, session.data)
            session.agent_bridge = bridge
            studio = QuietStudio(True, session)
            note = studio._note(smd_path.name, "# Study note\n", str(smd_path.resolve()), "# Study note\n", {}, True)
            studio.tabs, studio.active, studio.mode, studio.folder = [note], note["id"], "live", str(ws_root)

            def handle_native(raw):
                req = json.loads(raw)
                try:
                    res = {"flushed": True} if req["action"] == "flush_current" else (
                        studio._attach_tab_asset_native(req) if req["action"] == "asset_action" else studio._agent_document_action(req))
                    bridge.complete(req["requestId"], res, window_id=studio.window_id)
                except (ValueError, OSError, KeyError, RuntimeError) as err:
                    bridge.complete(req["requestId"], None, str(err), window_id=studio.window_id)

            studio.agentRequest.connect(handle_native)
            try:
                studio.setAgentAccessEnabled(True)
                rooted_server, _ = build_mcp_server([str(ws_root)], live_client=MultiSessionLiveClient(bridge.discovery_dir))
                async with Client(rooted_server) as client:
                    sessions = await call_with_qt(client.call_tool("list_sessions", {}))
                    entry = next(i for i in sessions.structured_content["sessions"] if i.get("path") == str(smd_path.resolve()))
                    target, rev = entry["target"], entry["revision"]
                    for bad in (".hidden.svg", str(outside_svg), *([str(escape_link)] if os.name == "posix" else [])):
                        self.assertTrue((await call_with_qt(client.call_tool("document_attach_asset", {"path": target, "asset_path": bad, "expected_revision": rev}))).is_error, bad)
                    for asset, name in ((str(note_local), "note-local.svg"), ("workspace-fig.svg", "ws-fig.svg")):
                        ok = await call_with_qt(client.call_tool("document_attach_asset", {"path": target, "asset_path": asset, "expected_revision": rev, "name": name}))
                        self.assertFalse(ok.is_error, ok.content[0].text if ok.content else "")
            finally:
                studio.stop()
                studio.pool.shutdown(wait=True, cancel_futures=True)
                bridge.stop()
                session.writes.shutdown(wait=True)
                studio.deleteLater()
                app.sendPostedEvents(None, QEvent.Type.DeferredDelete)
                app.processEvents()
                shutil.rmtree(session.data, ignore_errors=True)

    async def test_live_metadata_is_bounded_redacted_and_revision_bound(self) -> None:
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

    async def test_shared_validators_preserve_accepted_input_errors_and_limits(self) -> None:
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
        self.assertEqual((mcap["contextRevisionMatches"], "properties" in mcap, mread), (False, False, None))


if __name__ == "__main__":
    unittest.main()
