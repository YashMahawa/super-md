"""Conformance tests verifying Python agent layers against docs/agent-contract.json."""
from __future__ import annotations

import base64
import hashlib
import importlib
import importlib.util
import io
import json
import os
import re
import sys
import tempfile
import time
import unittest
import zipfile
from pathlib import Path
from typing import Any

CONTRACT_PATH = Path(__file__).resolve().parents[2] / "docs" / "agent-contract.json"
DESKTOP_DIR = Path(__file__).resolve().parents[1]
PNG_1X1 = base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO6pX+0AAAAASUVORK5CYII=")


class AgentContractTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
        os.environ.setdefault("QT_QUICK_BACKEND", "software")
        if importlib.util.find_spec("agent_live") is None:
            saved = list(sys.path)
            sys.path.insert(0, str(DESKTOP_DIR))
            cls.addClassCleanup(lambda: sys.path.__setitem__(slice(None), saved))
        cls.contract = json.loads(CONTRACT_PATH.read_text(encoding="utf-8"))

    def _recording_client(self) -> tuple[Any, list[tuple[str, dict[str, Any]]], Any]:
        agent_live = importlib.import_module("agent_live")
        calls: list[tuple[str, dict[str, Any]]] = []
        rec_cls = type("_Rec", (agent_live.LiveTabClient,), {
            "__init__": lambda self: None, "_call": lambda self, action, **p: (calls.append((action, p)) or {"ok": True}),
        })
        return rec_cls(), calls, agent_live

    def test_export_formats_and_live_mdzip_archive_roundtrip(self) -> None:
        formats, cli = self.contract["exportFormats"], importlib.import_module("agent_live_cli")
        sub = next(a for a in cli._parser()._actions if getattr(a, "choices", None) and "export" in a.choices).choices
        self.assertEqual(tuple(next(a for a in sub["export"]._actions if a.dest == "format").choices), tuple(formats["live"]))
        for cmd in ("create", "save"):
            self.assertEqual(tuple(next(a for a in sub[cmd]._actions if a.dest == "format").choices), tuple(formats["createAndSave"]))
        client, calls, agent_live = self._recording_client()
        rev = "a" * self.contract["revision"]["length"]
        for fmt in formats["live"]:
            client.export_document("tab-1", format=fmt, expected_revision=rev)
        self.assertEqual([c[1]["format"] for c in calls], formats["live"])
        with self.assertRaises(agent_live.LiveBridgeError):
            client.export_document("tab-1", format="docx", expected_revision=rev)
        from PySide6.QtGui import QGuiApplication
        studio_mod = importlib.import_module("studio")
        app = QGuiApplication.instance() or QGuiApplication(["contract-test"])
        with tempfile.TemporaryDirectory() as tmp:
            session = studio_mod.Session(True)
            session.settings["python"] = sys.executable
            studio = studio_mod.Studio(True, session)
            studio.settings["newNoteLocation"] = tmp
            try:
                md, assets = "# Archive\n\n![dot](assets/pic.png)\n", {"assets/pic.png": "data:image/png;base64," + base64.b64encode(PNG_1X1).decode("ascii")}
                tab = studio._note("Archive.smd", md, "", md, assets, True)
                studio.tabs.append(tab)
                studio.active, replies = tab["id"], []
                studio.replied.connect(lambda _rid, res, _err: replies.append(res))
                studio._agent_export_native("req-1", {"id": tab["id"], "format": "mdzip", "filename": "bundle", "content": md,
                                                      "assets": assets, "expectedRevision": hashlib.sha256(md.encode("utf-8")).hexdigest(), "options": {}})
                job_id, deadline = json.loads(replies[-1])["jobId"], time.monotonic() + 5.0
                while studio._agent_job_status(job_id)["status"] == "running" and time.monotonic() < deadline:
                    app.processEvents()
                    time.sleep(0.01)
                self.assertEqual(studio._agent_job_status(job_id)["status"], "completed")
                chunk = studio._agent_export_chunk(job_id, 0, self.contract["pagination"]["exportChunkMaxBytes"])
                self.assertEqual((chunk["format"], chunk["mimeType"]), ("mdzip", "application/zip"))
                with zipfile.ZipFile(io.BytesIO(base64.b64decode(chunk["body"]))) as zf:
                    self.assertTrue({"bundle.md", "assets/pic.png"}.issubset(zf.namelist()))
                self.assertEqual(cli._download_export(type("DL", (), {"document_action": lambda _s, _t, _a, **_k: chunk})(), job_id, str(Path(tmp) / "dl.zip"))["format"], "mdzip")
            finally:
                studio.stop()
                studio.pool.shutdown(wait=True, cancel_futures=True)
                session.writes.shutdown(wait=True)
                app.processEvents()

    def test_mcp_export_and_diagram_id_contract(self) -> None:
        docs_mod = importlib.import_module("agent_documents")
        client, _, agent_live = self._recording_client()
        ids, rev = self.contract["identifiers"], "b" * self.contract["revision"]["length"]
        valid_ids = [ids["diagramIdPrefix"] + "1", ids["diagramIdPrefix"] + "a" * (ids["diagramIdMax"] - 8)]
        invalid_ids = ["diagram:", "diagram:" + "a" * (ids["diagramIdMax"] - 7), "fig:12345", "diagram:1\n", "diagram:1\x00"]
        for did in valid_ids:
            client.get_diagram("t1", did, rev)
            client.get_diagram_image("t1", did, rev)
        for bad in invalid_ids:
            for fn in (client.get_diagram, client.get_diagram_image):
                with self.assertRaises(agent_live.LiveBridgeError):
                    fn("t1", bad, rev)
        fake_live = type("_FakeLive", (), {"document_action": lambda _s, _t, action, **p: (
            {"jobId": "j1", "status": "running", "filename": "out", "format": p["format"]} if action == "export_document" else
            {"revision": rev, "diagramId": p["diagram_id"], "source": "graph TD", "start": 0, "end": 8} if action == "get_diagram" else
            {"data": PNG_1X1, "mime_type": "image/png", "revision": rev, "diagramId": p["diagram_id"], "width": 1, "height": 1, "bytes": 68}
            if action == "get_diagram_image" else {"tabId": "t1", "revision": rev, "status": "ok"}
        )})()
        with tempfile.TemporaryDirectory() as root:
            (Path(root) / "note.md").write_text("# Disk\n", encoding="utf-8")
            tools = importlib.import_module("mcp_server").build_mcp_server([root], live_client=fake_live)[0]._tool_manager._tools
            doc_action, doc_view = tools["document_action"].fn, tools["document_view"].fn
            for fmt in self.contract["exportFormats"]["live"]:
                self.assertEqual(doc_action("export_document", path="tab:t1", format=fmt, expected_revision=rev)["format"], fmt)
            with self.assertRaisesRegex(docs_mod.AgentDocumentError, "mdzip requires a live tab"):
                doc_action("export", path="note.md", output_path="out.zip", format="mdzip")
            for fmt in ("md", "smd"):
                self.assertEqual(Path(doc_action("export", path="note.md", output_path=f"copy.{fmt}", format=fmt)["path"]).name, f"copy.{fmt}")
            for fmt in self.contract["exportFormats"]["createAndSave"]:
                doc_action("create_document", content="# Hi", format=fmt)
                doc_action("save_document", path="tab:t1", format=fmt, expected_revision=rev)
            for bad_fmt in ("pdf", "mdzip"):
                for call in (lambda f=bad_fmt: doc_action("create_document", content="# Hi", format=f),
                             lambda f=bad_fmt: doc_action("save_document", path="tab:t1", format=f, expected_revision=rev)):
                    with self.assertRaises(docs_mod.AgentDocumentError):
                        call()
            for did in valid_ids:
                self.assertEqual((doc_action("get_diagram", path="tab:t1", diagram_id=did, expected_revision=rev)["diagramId"],
                                  bool(doc_view(path="tab:t1", diagram_id=did, expected_revision=rev))), (did, True))
            for bad in invalid_ids:
                for call in (lambda d=bad: doc_action("get_diagram", path="tab:t1", diagram_id=d, expected_revision=rev),
                             lambda d=bad: doc_view(path="tab:t1", diagram_id=d, expected_revision=rev)):
                    with self.assertRaises(docs_mod.AgentDocumentError):
                        call()

    def test_bounds_and_view_current_fixtures_conformance(self) -> None:
        docs_mod = importlib.import_module("agent_documents")
        client, calls, agent_live = self._recording_client()
        c, rev, op = self.contract, "c" * self.contract["revision"]["length"], {"type": "replace", "old": "a", "new": "b"}
        self.assertTrue(re.fullmatch(c["revision"]["lowercaseHexPattern"], "0123456789abcdef" * 4) and not re.fullmatch(c["revision"]["lowercaseHexPattern"], "A" * 64))
        self.assertEqual((docs_mod.MAX_PAGE_CHARS, agent_live.MAX_SOURCE_PAGE, docs_mod.MAX_OUTLINE_PAGE, agent_live.MAX_EXPORT_CHUNK_BYTES),
                         (c["pagination"]["readPageMaxChars"], c["pagination"]["readPageMaxChars"], c["pagination"]["outlineMaxLimit"], c["pagination"]["exportChunkMaxBytes"]))
        client.read_tab("t1", heading=0)
        client.read_tab("t1", heading="h" * c["heading"]["desktopMaxChars"])
        with self.assertRaises(agent_live.LiveBridgeError):
            client.read_tab("t1", heading="h" * (c["heading"]["desktopMaxChars"] + 1))
        client.search_tab("t1", "q" * c["search"]["queryMaxChars"], limit=c["search"]["limitMax"], context=c["search"]["contextMax"],
                          offset=5, case_sensitive=True, whole_word=True, regex=True, exclude_diagrams=True)
        self.assertTrue(all(calls[-1][1][flag] for flag in c["search"]["booleanFlags"]))
        for bad_kw in ({"query": ""}, {"query": "q" * 501}, {"query": "q", "limit": 0}, {"query": "q", "limit": 26}, {"query": "q", "context": 501}, {"query": "q", "offset": -1}):
            with self.assertRaises(agent_live.LiveBridgeError):
                client.search_tab("t1", **bad_kw)
        docs_mod.validate_patch_operations([op] * c["mutations"]["maxPatchOperations"])
        with self.assertRaises(docs_mod.AgentDocumentError):
            docs_mod.validate_patch_operations([op] * (c["mutations"]["maxPatchOperations"] + 1))
        client.latex_apply("t1", rev, list(range(c["mutations"]["repairIndicesMax"])))
        for bad_idx in ([], list(range(c["mutations"]["repairIndicesMax"] + 1)), [1, 1]):
            with self.assertRaises(agent_live.LiveBridgeError):
                client.latex_apply("t1", rev, bad_idx)
        for fmt in c["viewport"]["imageFormats"]:
            client.render_tab("t1", width=c["viewport"]["minWidth"], image_format=fmt)
            client.render_tab("t1", width=c["viewport"]["maxWidth"], image_format=fmt)
        for bad_vp in ({"width": c["viewport"]["minWidth"] - 1}, {"width": c["viewport"]["maxWidth"] + 1}, {"image_format": "bmp"}):
            with self.assertRaises(agent_live.LiveBridgeError):
                client.render_tab("t1", **bad_vp)
        try:
            norm = importlib.import_module("agent.context_normalizer")
            normalize_reading, viewport_ctxs = norm._normalize_reading_context, norm._viewport_contexts
        except ImportError:
            srv, _ = importlib.import_module("mcp_server").build_mcp_server([], live_client=object())
            normalize_reading, viewport_ctxs = srv._normalize_reading_context, srv._viewport_contexts
        fx = {item["name"]: item for item in c["viewCurrent"]["fixtures"]}
        self.assertEqual(normalize_reading(fx["legacy_pagination_repair"]["readingContextInput"])["visibleSource"], fx["legacy_pagination_repair"]["expectedVisibleSource"])
        cap_ctx, cap_read = viewport_ctxs(fx["coherent_viewport_capture"]["imageInput"], fx["coherent_viewport_capture"]["requestedTab"], fx["coherent_viewport_capture"]["expectedRevision"])
        self.assertEqual((cap_read is not None, cap_ctx["sourceRange"], cap_ctx["nativeTabId"]),
                         (fx["coherent_viewport_capture"]["expectedHasCoherentCapturedSource"], fx["coherent_viewport_capture"]["expectedCaptureSourceRange"], fx["coherent_viewport_capture"]["expectedNativeTabId"]))
        stale_ctx, stale_read = viewport_ctxs(fx["stale_revision_viewport_capture"]["imageInput"], fx["stale_revision_viewport_capture"]["requestedTab"], fx["stale_revision_viewport_capture"]["expectedRevision"])
        self.assertEqual((stale_read is not None, stale_ctx["contextRevisionMatches"]),
                         (fx["stale_revision_viewport_capture"]["expectedHasCoherentCapturedSource"], fx["stale_revision_viewport_capture"]["expectedContextRevisionMatches"]))
