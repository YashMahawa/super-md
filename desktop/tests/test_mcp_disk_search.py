"""Regression tests for disk-note filter forwarding in MCP document_search and CLI call."""
from __future__ import annotations

import base64
import importlib.util
import io
import json
import sys
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path

DESKTOP_DIR = Path(__file__).resolve().parents[1]
if str(DESKTOP_DIR) not in sys.path:
    sys.path.insert(0, str(DESKTOP_DIR))

SAMPLE_SOURCE = (
    "😀 Ward afterward\n"
    "```mermaid\nWard --> X\n```\n"
    "```{.mermaid, fig-width=6}\nward --> Y\n```\n"
    "```svg\n<svg><text>ward</text></svg>\n```\n"
    "ward ward wAr\n"
)


def _write_disk_notes(root: Path, source: str = SAMPLE_SOURCE) -> tuple[str, str]:
    import documents

    (root / "notes.md").write_bytes(source.encode("utf-8"))
    svg_b64 = base64.b64encode(b"<svg xmlns='http://www.w3.org/2000/svg'><circle r='2'/></svg>").decode("ascii")
    (root / "notes.smd").write_bytes(documents.compressed_bundle(source, {"assets/dot.svg": f"data:image/svg+xml;base64,{svg_b64}"}))
    return "notes.md", "notes.smd"


@unittest.skipUnless(importlib.util.find_spec("mcp"), "install desktop/requirements-agent.txt for official SDK transport tests")
class MCPDiskSearchFilterTest(unittest.IsolatedAsyncioTestCase):
    async def test_disk_search_filters_match_document_store_across_md_and_smd(self) -> None:
        from agent_documents import DocumentStore
        from mcp import Client
        from mcp_server import build_mcp_server

        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            notes = _write_disk_notes(root)
            store = DocumentStore([str(root)])
            server, _ = build_mcp_server([str(root)])
            async with Client(server) as client:
                for note_name in notes:
                    with self.subTest(note=note_name):
                        p1 = await client.call_tool("document_search", {"path": note_name, "query": "ward", "limit": 3, "context": 20, "offset": 0})
                        self.assertFalse(p1.is_error)
                        self.assertEqual(p1.structured_content, store.search(note_name, "ward", limit=3, context=20, offset=0))
                        self.assertEqual((p1.structured_content["totalMatches"], p1.structured_content["remainingMatches"], p1.structured_content["truncated"]), (7, 7, True))

                        p2 = await client.call_tool("document_search", {"path": note_name, "query": "ward", "limit": 3, "context": 20, "offset": p1.structured_content["nextOffset"]})
                        self.assertFalse(p2.is_error)
                        self.assertEqual(p2.structured_content, store.search(note_name, "ward", limit=3, context=20, offset=p1.structured_content["nextOffset"]))
                        self.assertEqual((p2.structured_content["remainingMatches"], p2.structured_content["truncated"]), (4, True))

                        p3 = await client.call_tool("document_search", {"path": note_name, "query": "ward", "limit": 3, "context": 20, "offset": p2.structured_content["nextOffset"]})
                        self.assertFalse(p3.is_error)
                        self.assertEqual(p3.structured_content, store.search(note_name, "ward", limit=3, context=20, offset=p2.structured_content["nextOffset"]))
                        self.assertEqual((p3.structured_content["remainingMatches"], p3.structured_content["truncated"], p3.structured_content["nextOffset"]), (1, False, None))

                        done = await client.call_tool("document_search", {"path": note_name, "query": "ward", "limit": 3, "offset": len(SAMPLE_SOURCE)})
                        self.assertFalse(done.is_error)
                        self.assertEqual(done.structured_content, store.search(note_name, "ward", limit=3, offset=len(SAMPLE_SOURCE)))
                        self.assertEqual((done.structured_content["matches"], done.structured_content["totalMatches"], done.structured_content["remainingMatches"], done.structured_content["nextOffset"], done.structured_content["truncated"]), ([], 7, 0, None, False))

                        for kwargs in (
                            {"query": "ward", "case_sensitive": False},
                            {"query": "ward", "case_sensitive": True},
                            {"query": "Ward", "case_sensitive": True},
                            {"query": "ward", "whole_word": False},
                            {"query": "ward", "whole_word": True},
                            {"query": "ward", "exclude_diagrams": False},
                            {"query": "ward", "exclude_diagrams": True},
                            {"query": "w.r", "regex": True, "case_sensitive": True, "exclude_diagrams": True},
                            {"query": "^ward [a-z][a-z][a-z][a-z]", "regex": True, "case_sensitive": True},
                        ):
                            res = await client.call_tool("document_search", {"path": note_name, **kwargs})
                            self.assertFalse(res.is_error, kwargs)
                            self.assertEqual(res.structured_content, store.search(
                                note_name, kwargs["query"], case_sensitive=kwargs.get("case_sensitive", False),
                                whole_word=kwargs.get("whole_word", False), regex=kwargs.get("regex", False),
                                exclude_diagrams=kwargs.get("exclude_diagrams", False)), kwargs)

                        self.assertEqual(store.search(note_name, "ward", case_sensitive=True)["totalMatches"], 5)
                        ww_res = store.search(note_name, "ward", whole_word=True)
                        self.assertEqual((ww_res["totalMatches"], ww_res["matches"][0]["matchOffset"]), (6, 2))
                        self.assertEqual(store.search(note_name, "ward", exclude_diagrams=True)["totalMatches"], 4)

                        combo = {"query": "ward", "limit": 1, "context": 16, "case_sensitive": True, "whole_word": True, "exclude_diagrams": True}
                        c1 = await client.call_tool("document_search", {"path": note_name, "offset": 0, **combo})
                        self.assertFalse(c1.is_error)
                        self.assertEqual(c1.structured_content, store.search(note_name, offset=0, **combo))
                        self.assertEqual((c1.structured_content["totalMatches"], c1.structured_content["truncated"]), (2, True))
                        c2 = await client.call_tool("document_search", {"path": note_name, "offset": c1.structured_content["nextOffset"], **combo})
                        self.assertFalse(c2.is_error)
                        self.assertEqual(c2.structured_content, store.search(note_name, offset=c1.structured_content["nextOffset"], **combo))
                        self.assertIsNone(c2.structured_content["nextOffset"])

    async def test_invalid_disk_search_filters_return_mcp_tool_errors(self) -> None:
        from mcp import Client
        from mcp_server import build_mcp_server

        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            notes = _write_disk_notes(root)
            server, _ = build_mcp_server([str(root)])
            bad_cases = ({"query": "w.+d", "regex": True}, {"query": "ward|after", "regex": True}, {"query": "ward", "offset": -1}, {"query": "ward", "offset": len(SAMPLE_SOURCE) + 1})
            async with Client(server) as client:
                for note_name in notes:
                    for bad_args in bad_cases:
                        with self.subTest(note=note_name, args=bad_args):
                            self.assertTrue((await client.call_tool("document_search", {"path": note_name, **bad_args})).is_error, bad_args)

    def test_cli_call_document_search_matches_cli_search_on_disk_notes(self) -> None:
        import agent_cli

        def run_cli_json(argv: list[str]) -> tuple[int, dict]:
            stream = io.StringIO()
            with redirect_stdout(stream):
                code = agent_cli.main(argv)
            return code, json.loads(stream.getvalue())

        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            notes = _write_disk_notes(root)
            resume = SAMPLE_SOURCE.index("ward ward")
            for note_name in notes:
                with self.subTest(note=note_name):
                    call_code, call_out = run_cli_json(["--root", str(root), "call", "document_search", "--arguments-json", json.dumps(
                        {"path": note_name, "query": "w.r", "limit": 2, "context": 18, "offset": resume, "case_sensitive": True, "regex": True, "exclude_diagrams": True})])
                    search_code, search_out = run_cli_json(["--root", str(root), "search", note_name, "w.r", "--limit", "2", "--context", "18", "--offset", str(resume), "--case-sensitive", "--regex", "--exclude-diagrams"])
                    self.assertEqual((call_code, search_code, call_out["ok"], search_out["ok"]), (0, 0, True, True))
                    self.assertEqual(call_out["result"].get("structured_content", call_out["result"].get("structuredContent")), search_out["result"])

                    ww_code, ww_call = run_cli_json(["--root", str(root), "call", "document_search", "--arguments-json", json.dumps(
                        {"path": note_name, "query": "ward", "limit": 1, "offset": 0, "case_sensitive": True, "whole_word": True, "exclude_diagrams": True})])
                    s_code, ww_search = run_cli_json(["--root", str(root), "search", note_name, "ward", "--limit", "1", "--offset", "0", "--case-sensitive", "--whole-word", "--exclude-diagrams"])
                    self.assertEqual((ww_code, s_code), (0, 0))
                    self.assertEqual(ww_call["result"].get("structured_content", ww_call["result"].get("structuredContent")), ww_search["result"])


if __name__ == "__main__":
    unittest.main()
