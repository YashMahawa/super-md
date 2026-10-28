import importlib.util
import json
import os
import sys
import tempfile
import unittest
import urllib.error
import urllib.request
from pathlib import Path
from unittest.mock import Mock, patch

from mcp_server import BearerAuth
from agent_live_client import MultiSessionLiveClient


class BearerAuthTest(unittest.IsolatedAsyncioTestCase):
    async def test_http_requires_constant_time_bearer_before_dispatch(self):
        calls = []
        async def app(scope, receive, send):
            calls.append(scope["path"])
            await send({"type": "http.response.start", "status": 204, "headers": []})
            await send({"type": "http.response.body", "body": b""})
        protected = BearerAuth(app, "a" * 40)
        sent = []
        async def receive(): return {"type": "http.request", "body": b"", "more_body": False}
        async def send(message): sent.append(message)
        scope = {"type": "http", "path": "/mcp", "headers": []}
        await protected(scope, receive, send)
        self.assertEqual(sent[0]["status"], 401)
        self.assertEqual(calls, [])
        sent.clear()
        scope["headers"] = [(b"authorization", b"Bearer " + b"a" * 40)]
        await protected(scope, receive, send)
        self.assertEqual(sent[0]["status"], 204)
        self.assertEqual(calls, ["/mcp"])


class MultiSessionLiveClientTest(unittest.TestCase):
    def test_explicit_discovery_is_mapped_to_a_session_qualified_tab_without_token_output(self):
        with tempfile.TemporaryDirectory() as folder:
            directory = Path(folder)
            if os.name == "posix":
                directory.chmod(0o700)
            (directory / "one.json").write_text(json.dumps({"version": 1, "sessionId": "session-one",
                                                              "host": "127.0.0.1", "port": 32123,
                                                              "token": "x" * 48}), encoding="utf-8")
            if os.name == "posix":
                (directory / "one.json").chmod(0o600)
            fake = Mock()
            fake.list_tabs.return_value = {"tabs": [{"id": "tab-local", "windowId": "window-a",
                                                       "title": "Draft", "format": "smd", "isDirty": True, "active": True}]}
            fake.read_tab.return_value = {"tabId": "tab-local", "revision": "a" * 64,
                                          "markdown": "unsaved source", "offset": 0, "totalLength": 14}
            with patch("agent_live_client.LiveTabClient", return_value=fake):
                live = MultiSessionLiveClient(directory)
                tabs = live.list_tabs()["tabs"]
                self.assertEqual(tabs[0]["id"], "session-one:window-a:tab-local")
                self.assertTrue(tabs[0]["active"])
                result = live.read_tab(tabs[0]["id"], offset=0, limit=200)
                self.assertEqual(result["markdown"], "unsaved source")
                fake.read_tab.assert_called_once_with("tab-local", offset=0, limit=200, window_id="window-a",
                                                      asset_offset=0, asset_limit=0, view="prose")

    def test_live_export_job_id_stays_scoped_to_its_session_while_polling(self):
        with tempfile.TemporaryDirectory() as folder:
            directory = Path(folder)
            if os.name == "posix": directory.chmod(0o700)
            (directory / "one.json").write_text(json.dumps({"version": 1, "sessionId": "session-one",
                                                              "host": "127.0.0.1", "port": 32123,
                                                              "token": "x" * 48}), encoding="utf-8")
            if os.name == "posix": (directory / "one.json").chmod(0o600)
            fake = Mock()
            fake.list_tabs.return_value = {"tabs": [{"id": "tab-local", "windowId": "window-a"}]}
            fake.document_action.side_effect = [
                {"jobId": "native-123", "status": "running"},
                {"jobId": "native-123", "status": "completed", "bytes": 123},
                {"tabId": "new-tab", "windowId": "window-a", "title": "Draft", "revision": "c" * 64},
            ]
            with patch("agent_live_client.LiveTabClient", return_value=fake):
                live = MultiSessionLiveClient(directory)
                tab = live.list_tabs()["tabs"][0]["id"]
                queued = live.document_action(tab, "export_document", format="pdf", expected_revision="a" * 64)
                self.assertEqual(queued["jobId"], "session-one:native-123")
                done = live.document_action(None, "job_status", job_id=queued["jobId"])
                self.assertEqual(done["jobId"], queued["jobId"])
                self.assertEqual(done["status"], "completed")
                calls = fake.document_action.call_args_list
                self.assertEqual(calls[0].args, ("tab-local", "export_document"))
                self.assertEqual(calls[0].kwargs["window_id"], "window-a")
                self.assertEqual(calls[1].args, ("tab-local", "job_status"))
                self.assertEqual(calls[1].kwargs["window_id"], "window-a")
                self.assertEqual(calls[1].kwargs["job_id"], "native-123")
                created = live.document_action(None, "create_document", content="# Draft", format="smd",
                                               device_id="local")
                self.assertEqual(created["target"], "tab:session-one:window-a:new-tab")
                self.assertEqual(fake.document_action.call_args_list[2].args, ("", "create_document"))


@unittest.skipUnless(importlib.util.find_spec("mcp"), "install desktop/requirements-agent.txt for official SDK transport tests")
class OfficialMCPClientTest(unittest.IsolatedAsyncioTestCase):
    async def test_live_prose_cursor_uses_consumed_svg_range_not_returned_text_length(self):
        from mcp import Client
        from mcp_server import build_mcp_server

        class Live:
            def list_tabs(self):
                return {"tabs": [{"id": "session:window:tab", "title": "Large SVG"}]}
            def read_tab(self, tab_id, offset=0, limit=12000, view="prose"):
                if offset == 0:
                    return {"revision": "a" * 64, "start": 0, "end": 633_278,
                            "markdown": "# Figure\n[SVG omitted: 633201 chars]\nAfter the drawing.",
                            "totalLength": 700_000, "total_chars": 700_000,
                            "next_offset": 633_278, "view": view,
                            "omissions": [{"source_start": 16, "source_end": 633_217}]}
                return {"revision": "a" * 64, "start": offset, "end": offset + 20,
                        "markdown": "After the drawing.\n", "totalLength": 700_000,
                        "total_chars": 700_000, "next_offset": None, "view": view}

        server, _ = build_mcp_server([], live_client=Live())
        async with Client(server) as client:
            page = await client.call_tool("document_read", {"path": "tab:session:window:tab",
                                                                "offset": 0, "limit": 12_000})
            self.assertEqual(page.structured_content["end"], 633_278)
            self.assertEqual(page.structured_content["next_offset"], 633_278)
            self.assertIn("[SVG omitted:", page.structured_content["markdown"])
            following = await client.call_tool("document_read", {"path": "tab:session:window:tab",
                                                                     "offset": page.structured_content["next_offset"],
                                                                     "limit": 12_000})
            self.assertEqual(following.structured_content["markdown"], "After the drawing.\n")
            self.assertNotIn("[SVG omitted:", following.structured_content["markdown"])

    async def test_live_tab_tools_use_bridge_revisions_and_return_mcp_image_blocks(self):
        import base64
        from mcp import Client
        from mcp.types import ImageContent
        from mcp_server import build_mcp_server

        class FakeLive:
            def __init__(self): self.edits = []; self.actions = []
            def list_tabs(self):
                return {"tabs": [{"id": "session:window:tab", "title": "Unsaved", "isDirty": True,
                                  "format": "smd", "revision": "a" * 64, "active": True}]}
            def read_tab(self, tab_id, offset=0, limit=12000, view="prose"):
                return {"tabId": tab_id, "revision": "a" * 64, "markdown": "# Unsaved\nbody\n"[offset:offset + limit],
                        "offset": offset, "totalLength": 15, "title": "Unsaved", "view": view}
            def search_tab(self, tab_id, query, limit=10, context=100):
                return {"revision": "a" * 64, "matches": [{"line": 2, "text": "body"}]}
            def patch_tab(self, tab_id, expected_revision, operations):
                self.edits.append((tab_id, expected_revision, operations))
                return {"revision": "b" * 64, "previous_revision": expected_revision, "saved": True}
            def render_tab(self, tab_id, width=1600):
                return {"data": base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO6pX+0AAAAASUVORK5CYII="), "mime_type": "image/png",
                        "revision": "a" * 64, "width": width, "height": 1}
            def get_tab_image(self, tab_id, asset_name, expected_revision):
                return {"data": b"<svg xmlns='http://www.w3.org/2000/svg'></svg>",
                        "mime_type": "image/svg+xml", "asset": asset_name,
                        "revision": expected_revision, "bytes": 42, "sha256": "b" * 64}
            def document_action(self, tab_id, action, **params):
                self.actions.append((tab_id, action, params))
                if action == "export_document":
                    return {"jobId": "job-1", "status": "running", "filename": "Unsaved.pdf", "format": "pdf"}
                if action == "job_status":
                    return {"jobId": params["job_id"], "status": "completed", "format": "pdf", "bytes": 100}
                if action == "create_document":
                    return {"tabId": "new-tab", "windowId": "window", "title": params.get("title"),
                            "revision": "c" * 64, "isDirty": True, "format": params["format"]}
                if action == "list_diagrams":
                    return {"revision": "a" * 64, "diagrams": [{"id": "diagram:12", "kind": "mermaid",
                                                                     "sourceStart": 12, "sourceEnd": 30,
                                                                     "sourceChars": 18, "preview": "graph TD"}]}
                if action == "get_diagram":
                    return {"revision": params["expected_revision"], "diagramId": params["diagram_id"],
                            "source": "graph TD\n  A-->B\n", "start": params["offset"],
                            "end": 18, "next_offset": None, "truncated": False}
                if action == "get_diagram_image":
                    return {"data": base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO6pX+0AAAAASUVORK5CYII="),
                            "mime_type": "image/png", "revision": params["expected_revision"],
                            "diagramId": params["diagram_id"], "width": 1, "height": 1, "bytes": 68}
                if action == "replace_tab_asset":
                    return {"asset": params["asset_name"], "assetId": params["asset_name"],
                            "revision": "d" * 64, "previous_revision": params["expected_revision"],
                            "saved": True, "changed": True}
                if action == "get_context":
                    return {"revision": "a" * 64, "visibleSource": {"text": "# Current view", "start": 0,
                                                                         "end": 14, "next_offset": None,
                                                                         "truncated": False},
                            "diagrams": [{"id": "diagram:12", "kind": "mermaid"}]}
                if action == "latex_review":
                    return {"revision": "a" * 64, "repairs": [{"index": 0, "before": "$x", "after": "$x$",
                                                                   "reason": "unclosed math"}], "total": 1}
                if action == "latex_apply":
                    return {"revision": "e" * 64, "applied": params["repair_indices"]}
                return {"status": "ok"}

        live = FakeLive()
        with tempfile.TemporaryDirectory() as asset_root:
            replacement_path = Path(asset_root) / "replacement.svg"
            replacement_path.write_bytes(b"<svg xmlns='http://www.w3.org/2000/svg'></svg>")
            server, _ = build_mcp_server([asset_root], live_client=live)
            await self._exercise_live_tool_surface(server, live, replacement_path)

    async def _exercise_live_tool_surface(self, server, live, replacement_path):
        import base64
        from mcp import Client
        from mcp.types import ImageContent
        async with Client(server) as client:
            tools = await client.list_tools()
            self.assertLessEqual(len(tools.tools), 9)
            tabs = await client.call_tool("list_sessions", {})
            target = tabs.structured_content["sessions"][0]["target"]
            self.assertEqual(target, "tab:session:window:tab")
            self.assertTrue(tabs.structured_content["sessions"][0]["active"])
            read = await client.call_tool("document_read", {"path": target, "offset": 0, "limit": 5})
            self.assertEqual(read.structured_content["markdown"], "# Uns")
            patch = await client.call_tool("document_patch", {
                "path": target, "expected_revision": "a" * 64,
                "operations": [{"type": "replace", "old": "body", "new": "edited"}],
            })
            self.assertTrue(patch.structured_content["saved"])
            self.assertEqual(live.edits[0][0], "session:window:tab")
            image = await client.call_tool("document_view", {"path": target, "width": 500})
            block = next(block for block in image.content if isinstance(block, ImageContent))
            self.assertEqual(block.mime_type, "image/png")
            self.assertEqual(base64.b64decode(block.data), base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO6pX+0AAAAASUVORK5CYII="))
            asset = await client.call_tool("document_assets", {"path": target, "action": "extract",
                                                                 "asset_name": "assets/diagram.svg",
                                                                 "expected_revision": "a" * 64})
            svg_block = next(block for block in asset.content if isinstance(block, ImageContent))
            self.assertEqual(svg_block.mime_type, "image/svg+xml")
            self.assertEqual(base64.b64decode(svg_block.data), b"<svg xmlns='http://www.w3.org/2000/svg'></svg>")
            exported = await client.call_tool("document_action", {"action": "export", "path": target,
                                                                     "format": "pdf", "expected_revision": "a" * 64})
            job_id = exported.structured_content["jobId"]
            status = await client.call_tool("document_action", {"action": "job_status", "job_id": job_id})
            self.assertEqual(status.structured_content["status"], "completed")
            created = await client.call_tool("document_action", {"action": "create_document", "content": "# New",
                                                                    "format": "smd", "title": "New note"})
            self.assertEqual(created.structured_content["tabId"], "new-tab")
            saved = await client.call_tool("document_action", {"action": "save_document", "path": target,
                                                                  "expected_revision": "a" * 64,
                                                                  "filename": "saved.md", "format": "md"})
            self.assertEqual(saved.structured_content["status"], "ok")
            activated = await client.call_tool("document_action", {"action": "open_document", "path": target})
            self.assertTrue(activated.structured_content["opened"])
            diagrams = await client.call_tool("document_action", {"action": "list_diagrams", "path": target})
            diagram_id = diagrams.structured_content["diagrams"][0]["id"]
            diagram = await client.call_tool("document_action", {"action": "get_diagram", "path": target,
                                                                     "diagram_id": diagram_id,
                                                                     "expected_revision": "a" * 64,
                                                                     "offset": 0, "limit": 12000})
            self.assertEqual(diagram.structured_content["source"], "graph TD\n  A-->B\n")
            diagram_image = await client.call_tool("document_view", {"path": target, "diagram_id": diagram_id,
                                                                       "expected_revision": "a" * 64, "width": 500})
            image_block = next(block for block in diagram_image.content if isinstance(block, ImageContent))
            self.assertEqual(image_block.mime_type, "image/png")
            context = await client.call_tool("document_action", {"action": "get_context", "path": target})
            self.assertEqual(context.structured_content["visibleSource"]["text"], "# Current view")
            review = await client.call_tool("document_action", {"action": "latex_review", "path": target})
            applied = await client.call_tool("document_action", {"action": "latex_apply", "path": target,
                                                                     "expected_revision": review.structured_content["revision"],
                                                                     "repair_indices": [0]})
            self.assertEqual(applied.structured_content["applied"], [0])
            replaced_asset = await client.call_tool("document_assets", {"path": target, "action": "replace",
                                                                           "asset_id": "assets/diagram.svg",
                                                                           "asset_path": str(replacement_path),
                                                                           "expected_revision": "a" * 64})
            self.assertFalse(replaced_asset.is_error, replaced_asset.content[0].text if replaced_asset.content else "")
            replacement_status = (replaced_asset.structured_content if replaced_asset.structured_content is not None
                                  else json.loads(replaced_asset.content[0].text))
            self.assertTrue(replacement_status["saved"])

    async def test_stdio_uses_official_client_and_keeps_stdout_protocol_clean(self):
        from mcp import Client
        from mcp.client.stdio import StdioServerParameters
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            note = root / "notes.md"
            svg = "<svg>" + ("<path/>" * 1000) + "</svg>"
            source = "# Protocol proof\n```svg\n" + svg + "\n```\n"
            note.write_bytes(source.encode("utf-8"))
            server_script = Path(__file__).with_name("agent_cli.py")
            params = StdioServerParameters(command=sys.executable,
                                           args=[str(server_script), "mcp", "--root", str(root)])
            async with Client(params) as client:
                tools = await client.list_tools()
                self.assertIn("document_inspect", {tool.name for tool in tools.tools})
                result = await client.call_tool("document_inspect", {"path": "notes.md"})
                self.assertFalse(result.is_error)
                self.assertEqual(result.structured_content["characters"], len(source))
                prose = await client.call_tool("document_read", {"path": "notes.md", "limit": 12000})
                self.assertNotIn("<svg>", prose.structured_content["text"])
                exact = await client.call_tool("document_read", {"path": "notes.md", "limit": 12000, "view": "source"})
                self.assertIn("<svg>", exact.structured_content["text"])

    async def test_streamable_http_uses_official_client_and_rejects_missing_auth(self):
        import socket
        import threading
        import time
        import httpx2
        import uvicorn
        from mcp import Client
        from mcp.client.streamable_http import streamable_http_client
        from mcp_server import BearerAuth, build_mcp_server

        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            (root / "http.md").write_text("# HTTP\n", encoding="utf-8")
            server, _ = build_mcp_server([str(root)])
            token = "test-token-" + "x" * 48
            app = BearerAuth(server.streamable_http_app(max_request_body_size=2 * 1024 * 1024), token)
            with socket.socket() as sock:
                sock.bind(("127.0.0.1", 0)); port = sock.getsockname()[1]
            uv_server = uvicorn.Server(uvicorn.Config(app, host="127.0.0.1", port=port, log_level="critical", access_log=False))
            thread = threading.Thread(target=uv_server.run, daemon=True)
            thread.start()
            try:
                response_status = None
                for _ in range(100):
                    try:
                        try:
                            urllib.request.urlopen(f"http://127.0.0.1:{port}/mcp", timeout=0.2)
                        except urllib.error.HTTPError as error:
                            response_status = error.code
                            break
                    except Exception:
                        time.sleep(0.02)
                self.assertEqual(response_status, 401)
                async with httpx2.AsyncClient(headers={"Authorization": f"Bearer {token}"}) as http_client:
                    transport = streamable_http_client(f"http://127.0.0.1:{port}/mcp", http_client=http_client)
                    async with Client(transport) as client:
                        result = await client.call_tool("document_inspect", {"path": "http.md"})
                        self.assertFalse(result.is_error)
                        self.assertEqual(result.structured_content["format"], "markdown")
            finally:
                uv_server.should_exit = True
                thread.join(timeout=5)


if __name__ == "__main__":
    unittest.main()
