"""Authenticated local/cloud MCP server for Super MD documents.

The MCP SDK is imported only when this module is invoked, so ordinary desktop
startup and the standalone CLI do not load the MCP, ASGI, or Qt runtimes.
"""
from __future__ import annotations

import argparse
import hmac
import base64
import json
import os
import re
import sys
from pathlib import Path
from typing import Any

try:
    from . import documents
    from .agent_documents import AgentDocumentError, DocumentStore, RevisionConflict, validate_patch_operations
except ImportError:  # python desktop/mcp_server.py
    import documents
    from agent_documents import AgentDocumentError, DocumentStore, RevisionConflict, validate_patch_operations


class BearerAuth:
    """Small ASGI gate that protects every HTTP route before MCP dispatch."""

    def __init__(self, app, token: str):
        self.app = app
        self.expected = token.encode("utf-8")

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        headers = {key.lower(): value for key, value in scope.get("headers", [])}
        supplied = headers.get(b"authorization", b"")
        valid = supplied.startswith(b"Bearer ") and hmac.compare_digest(supplied[7:], self.expected)
        if not valid:
            body = b"Unauthorized"
            await send({"type": "http.response.start", "status": 401,
                        "headers": [(b"content-type", b"text/plain; charset=utf-8"),
                                    (b"content-length", str(len(body)).encode()),
                                    (b"www-authenticate", b"Bearer")]})
            await send({"type": "http.response.body", "body": body})
            return
        await self.app(scope, receive, send)


def build_mcp_server(roots: list[str], live_client=None):
    """Create the SDK server and its single shared, root-restricted operation layer."""
    from mcp.server import MCPServer
    from mcp.types import ImageContent, TextContent

    store = DocumentStore(roots, allow_empty=live_client is not None)
    server = MCPServer(
        "Super MD", instructions=("Use bounded reads and search before editing. "
                                  "Every edit requires the current SHA-256 revision; "
                                  "inspect again after a revision conflict."),
    )

    def live_id(target: str) -> str | None:
        if not target.startswith("tab:"):
            return None
        if not target[4:]:
            raise AgentDocumentError("Live tab target is missing its session-qualified id")
        return target[4:]

    def live_call(method: str, *args, **kwargs):
        if live_client is None:
            raise AgentDocumentError("Live tabs are unavailable in this server; use the desktop app's agent bridge")
        callback = getattr(live_client, method, None)
        if not callable(callback):
            raise AgentDocumentError(f"This server does not support live operation {method}")
        try:
            return callback(*args, **kwargs)
        except AgentDocumentError:
            raise
        except Exception as error:
            if any(term in str(error).casefold() for term in ("revision", "stale", "changed since")):
                raise RevisionConflict("Live tab changed since it was read; inspect the current tab and retry") from error
            # Local bridge exceptions can contain endpoint details or headers.
            raise AgentDocumentError(f"Live tab operation failed ({type(error).__name__})") from error

    def bounded_result(value: dict, limit: int = 64_000) -> dict:
        try:
            encoded = json.dumps(value, ensure_ascii=False, separators=(",", ":"))
        except (TypeError, ValueError) as error:
            raise AgentDocumentError("Live bridge returned a non-JSON value") from error
        if len(encoded.encode("utf-8")) > limit:
            raise AgentDocumentError("Live bridge result exceeded the 64 KB tool-output limit")
        return value

    def live_outline(tab_id: str) -> dict:
        result = live_call("outline_tab", tab_id)
        if not isinstance(result, dict):
            raise AgentDocumentError("Live bridge returned invalid outline metadata")
        headings = result.get("headings", result.get("outline"))
        if not isinstance(headings, list) or len(headings) > 5000:
            raise AgentDocumentError("Live bridge returned an invalid or oversized heading outline")
        return {"headings": headings, "revision": result.get("revision"),
                "sourceLength": result.get("sourceLength", result.get("totalLength"))}

    def normalize_live_heading(item: dict) -> dict:
        start = item.get("start", item.get("offset", item.get("charOffset")))
        if not isinstance(start, int) or isinstance(start, bool) or start < 0:
            raise AgentDocumentError("Live outline entry is missing a valid character offset")
        level = item.get("level")
        if not isinstance(level, int) or isinstance(level, bool) or not 1 <= level <= 6:
            raise AgentDocumentError("Live outline entry is missing a valid heading level")
        return {"index": item.get("index", 0), "level": level, "title": str(item.get("title", ""))[:300],
                "line": item.get("line"), "start": start}

    def read_live_tab(tab_id: str, offset: int, limit: int, view: str, heading: int | None = None) -> dict:
        params = {"offset": offset, "limit": limit, "view": view}
        if heading is not None:
            params["heading"] = heading
        result = live_call("read_tab", tab_id, **params)
        if not isinstance(result, dict):
            raise AgentDocumentError("Live bridge returned invalid source text")
        markdown = result.get("markdown", result.get("text"))
        if not isinstance(markdown, str) or len(markdown.encode("utf-8")) > 64_000:
            raise AgentDocumentError("Live bridge returned source outside the 64 KB tool-output bound")
        start = result.get("start", result.get("offset", offset))
        end = result.get("end", start + len(markdown))
        if (not isinstance(start, int) or isinstance(start, bool) or start < 0 or
                not isinstance(end, int) or isinstance(end, bool) or end < start):
            raise AgentDocumentError("Live bridge returned invalid source offsets")
        response = {key: result[key] for key in ("revision", "id", "title", "path", "format", "isDirty")
                    if key in result}
        response.update({"start": start, "end": end,
                         "markdown": markdown, "view": view,
                         "returned_chars": len(markdown)})
        omissions = result.get("svg_omissions", result.get("omissions", []))
        if isinstance(omissions, list):
            response["svg_omissions"] = omissions[:20]
        total = result.get("totalLength", result.get("total_chars"))
        if isinstance(total, int) and not isinstance(total, bool) and total >= 0:
            total = result.get("total_chars", total)
            response["total_chars"] = total
            next_offset = result.get("next_offset", end if end < total else None)
            if next_offset is not None and (not isinstance(next_offset, int) or isinstance(next_offset, bool)
                                             or next_offset < end or next_offset > total):
                raise AgentDocumentError("Live bridge returned an invalid next_offset")
            response["next_offset"] = next_offset
            response["truncated"] = response["next_offset"] is not None
        return response

    def as_image_blocks(data: bytes, mime_type: str, metadata: dict) -> list[Any]:
        if mime_type not in ("image/png", "image/jpeg"):
            raise AgentDocumentError("MCP viewport images must be PNG or JPEG")
        if not isinstance(data, bytes) or not data or len(data) > 8 * 1024 * 1024:
            raise AgentDocumentError("Image data must be non-empty and no larger than 8 MB")
        if mime_type == "image/png" and not data.startswith(b"\x89PNG\r\n\x1a\n"):
            raise AgentDocumentError("Renderer returned data that is not a PNG image")
        if mime_type == "image/jpeg" and not data.startswith(b"\xff\xd8\xff"):
            raise AgentDocumentError("Renderer returned data that is not a JPEG image")
        return [TextContent(type="text", text=json.dumps(metadata, ensure_ascii=False, separators=(",", ":"))),
                ImageContent(type="image", data=base64.b64encode(data).decode("ascii"), mime_type=mime_type)]

    def as_asset_image_blocks(data: bytes, mime_type: str, metadata: dict) -> list[Any]:
        if not isinstance(data, bytes) or not data or len(data) > 8 * 1024 * 1024:
            raise AgentDocumentError("Image data must be non-empty and no larger than 8 MB")
        if mime_type not in documents.MIMES.values():
            raise AgentDocumentError("Asset MIME type is not supported by Super MD")
        if mime_type == "image/png" and not data.startswith(b"\x89PNG\r\n\x1a\n"):
            raise AgentDocumentError("Asset bytes are not a PNG image")
        if mime_type == "image/jpeg" and not data.startswith(b"\xff\xd8\xff"):
            raise AgentDocumentError("Asset bytes are not a JPEG image")
        return [TextContent(type="text", text=json.dumps(metadata, ensure_ascii=False, separators=(",", ":"))),
                ImageContent(type="image", data=base64.b64encode(data).decode("ascii"), mime_type=mime_type)]

    @server.tool()
    def list_sessions() -> dict[str, Any]:
        """List currently open desktop tabs, including unsaved source and revision IDs."""
        if live_client is None:
            return {"sessions": [], "count": 0, "available": False}
        response = live_call("list_tabs")
        tabs = response.get("tabs", response.get("sessions", [])) if isinstance(response, dict) else response
        if not isinstance(tabs, list) or len(tabs) > 200:
            raise AgentDocumentError("Live bridge returned an invalid or oversized tab list")
        sessions = []
        for tab in tabs:
            if not isinstance(tab, dict) or not tab.get("id"):
                continue
            row = {"id": str(tab["id"])[:300], "target": "tab:" + str(tab["id"])[:300]}
            for key, maximum in (("windowId", 128), ("title", 200), ("path", 300), ("format", 24), ("revision", 64)):
                value = tab.get(key)
                if isinstance(value, str):
                    row[key] = value[:maximum]
            if isinstance(tab.get("isDirty"), bool):
                row["isDirty"] = tab["isDirty"]
            if isinstance(tab.get("active"), bool):
                row["active"] = tab["active"]
            if isinstance(tab.get("sourceLength"), int):
                row["sourceLength"] = tab["sourceLength"]
            sessions.append(row)
        return {"sessions": sessions[:32], "count": len(sessions), "truncated": len(sessions) > 32,
                "available": True}

    @server.tool()
    def document_inspect(path: str) -> dict[str, Any]:
        """Return a document digest, bounded heading outline, and asset metadata."""
        tab_id = live_id(path)
        if tab_id is not None:
            result = live_call("read_tab", tab_id, offset=0, limit=1)
            if not isinstance(result, dict):
                raise AgentDocumentError("Live bridge returned invalid tab metadata")
            outline = live_outline(tab_id)
            if result.get("revision") and outline.get("revision") and result["revision"] != outline["revision"]:
                raise RevisionConflict("The open note changed while its outline was being read; inspect again")
            allowed = ("id", "windowId", "title", "path", "format", "isDirty", "sourceLength",
                       "revision", "outline", "outline_truncated", "assets", "asset_count")
            metadata = {key: result[key] for key in allowed if key in result}
            headings = outline["headings"]
            metadata["outline"] = [normalize_live_heading(item) for item in headings[:80] if isinstance(item, dict)]
            metadata["outline_truncated"] = len(headings) > 80
            metadata["heading_count"] = len(headings)
            metadata["target"] = path
            if isinstance(metadata.get("assets"), list):
                metadata["assets"] = [
                    {key: item.get(key) for key in ("id", "name", "mime", "mime_type", "bytes", "sha256") if key in item}
                    for item in metadata["assets"][:40] if isinstance(item, dict)
                ]
            else:
                asset_page = live_call("read_tab", tab_id, offset=0, limit=1, asset_offset=0, asset_limit=40)
                if isinstance(asset_page, dict):
                    raw_assets = asset_page.get("assets", [])
                    if isinstance(raw_assets, list):
                        metadata["assets"] = [{key: item.get(key) for key in
                                               ("id", "name", "mime", "mime_type", "bytes", "sha256") if key in item}
                                              for item in raw_assets[:40] if isinstance(item, dict)]
                    metadata["asset_count"] = asset_page.get("assetCount", len(metadata.get("assets", [])))
            return bounded_result(metadata)
        return store.inspect(path)

    @server.tool()
    def document_read(path: str, offset: int = 0, limit: int = 12000,
                      heading: int | None = None, view: str = "prose") -> dict[str, Any]:
        """Read a bounded source page; fenced SVG bodies are elided unless view='source'."""
        if view not in ("prose", "source"):
            raise AgentDocumentError("view must be 'prose' or 'source'")
        tab_id = live_id(path)
        if tab_id is not None:
            if not 1 <= limit <= 12000 or offset < 0:
                raise AgentDocumentError("limit must be 1–12,000 and offset must be nonnegative")
            section_end = None
            if heading is not None:
                outline = live_outline(tab_id)
                headings = [normalize_live_heading(item) for item in outline["headings"] if isinstance(item, dict)]
                if not isinstance(heading, int) or isinstance(heading, bool) or not 0 <= heading < len(headings):
                    raise AgentDocumentError("heading index is not present in the current tab outline")
                selected = headings[heading]
                offset = selected["start"]
                section_end = next((item["start"] for item in headings[heading + 1:]
                                    if item["level"] <= selected["level"]), outline.get("sourceLength"))
            response = read_live_tab(tab_id, offset, limit, view, heading=heading)
            response["target"] = path
            if section_end is not None:
                section_end = max(offset, section_end)
                response["total_chars"] = section_end - offset
                response["next_offset"] = response["end"] if response["end"] < section_end else None
                response["truncated"] = response["next_offset"] is not None
                response["heading"] = {key: selected[key] for key in ("index", "level", "title", "line")}
            return bounded_result(response)
        return store.read(path, offset=offset, limit=limit, heading=heading, view=view)

    @server.tool()
    def document_search(path: str, query: str, limit: int = 10, context: int = 100) -> dict[str, Any]:
        """Find case-insensitive matches and short source snippets."""
        tab_id = live_id(path)
        if tab_id is not None:
            if not query or len(query) > 500 or not 1 <= limit <= 25 or not 0 <= context <= 500:
                raise AgentDocumentError("query must be 1–500 characters, limit 1–25, context 0–500")
            result = live_call("search_tab", tab_id, query=query, limit=limit, context=context)
            if not isinstance(result, dict) or not isinstance(result.get("matches"), list):
                raise AgentDocumentError("Live bridge returned invalid search results")
            result = dict(result)
            clean_matches = []
            for item in result["matches"][:limit]:
                if not isinstance(item, dict):
                    continue
                match = {key: item[key] for key in ("offset", "line", "start", "end", "snippet") if key in item}
                if "snippet" not in match and isinstance(item.get("text"), str):
                    match["snippet"] = item["text"]
                clean_matches.append(match)
            result["matches"] = clean_matches
            result["target"] = path
            for match in result["matches"]:
                if isinstance(match.get("snippet"), str):
                    match["snippet"] = match["snippet"][:1100]
            return bounded_result(result)
        return store.search(path, query, limit=limit, context=context)

    @server.tool()
    def document_action(action: str, path: str | None = None, content: str | None = None,
                        title: str | None = None, output_path: str | None = None, filename: str | None = None,
                        format: str | None = None,
                        options: dict[str, Any] | None = None,
                        expected_revision: str | None = None,
                        repair_indices: list[int] | None = None, job_id: str | None = None,
                        device_id: str | None = None, diagram_id: str | None = None,
                        offset: int = 0, limit: int = 12000) -> dict[str, Any]:
        """Create/open/save/export notes, read context/diagrams, review fixes, or poll."""
        if action == "create":
            if path is None or content is None:
                raise AgentDocumentError("create requires path and content")
            return store.create(path, content)
        if action == "create_document":
            if live_client is None:
                raise AgentDocumentError("create_document requires a live desktop session")
            if not isinstance(content, str) or len(content.encode("utf-8")) > 20_000_000:
                raise AgentDocumentError("create_document requires UTF-8 content up to 20 MB")
            format = format or "md"
            if format not in ("md", "smd"):
                raise AgentDocumentError("format must be md or smd")
            if title is not None and (not isinstance(title, str) or len(title) > 160 or "\0" in title):
                raise AgentDocumentError("title must be at most 160 characters")
            result = live_call("document_action", None, "create_document", content=content,
                               title=title, format=format, device_id=device_id)
            if not isinstance(result, dict):
                raise AgentDocumentError("Desktop returned invalid created-tab metadata")
            return bounded_result(result)
        if action == "save_document":
            if path is None or live_id(path) is None:
                raise AgentDocumentError("save_document requires a current tab target")
            if not isinstance(expected_revision, str) or not re.fullmatch(r"[0-9a-f]{64}", expected_revision):
                raise AgentDocumentError("save_document requires expected_revision from document_inspect")
            format = format or "md"
            if format not in ("md", "smd"):
                raise AgentDocumentError("format must be md or smd")
            if title:
                raise AgentDocumentError("Use filename for save_document; title applies to create_document")
            if filename is not None and (not isinstance(filename, str) or not filename or len(filename) > 160
                                         or Path(filename).name != filename or filename in (".", "..")):
                raise AgentDocumentError("filename must be a safe basename")
            result = live_call("document_action", live_id(path), "save_document", expected_revision=expected_revision,
                               filename=filename, format=format)
            if not isinstance(result, dict):
                raise AgentDocumentError("Desktop returned invalid save status")
            return bounded_result(result)
        if action == "open_document":
            if live_client is None:
                raise AgentDocumentError("open_document requires a live desktop session")
            if path and live_id(path) is not None:
                target_id = live_id(path)
                result = live_call("document_action", target_id, "open_document")
                if not isinstance(result, dict):
                    raise AgentDocumentError("Desktop returned invalid open status")
                return bounded_result({**result, "target": path, "opened": True})
            if filename is None and path is not None:
                filename = path
            if not isinstance(filename, str) or not filename or len(filename) > 300 or \
                    Path(filename).name != filename or filename in (".", ".."):
                raise AgentDocumentError("open_document accepts only a bridge-owned basename or an open tab target")
            result = live_call("document_action", None, "open_document", filename=filename,
                               device_id=device_id)
            if not isinstance(result, dict):
                raise AgentDocumentError("Desktop returned invalid open status")
            return bounded_result(result)
        if action in ("export", "export_document"):
            if path is None or format not in ("pdf", "smd", "md"):
                raise AgentDocumentError("export requires a source path and format pdf, smd, or md")
            tab_id = live_id(path)
            if tab_id is not None:
                if not isinstance(expected_revision, str) or not re.fullmatch(r"[0-9a-f]{64}", expected_revision):
                    raise AgentDocumentError("Live export requires expected_revision from document_inspect")
                if options is not None and (not isinstance(options, dict) or
                                            len(json.dumps(options, ensure_ascii=False).encode("utf-8")) > 8000):
                    raise AgentDocumentError("Export options must be an object no larger than 8 KB")
                if format != "pdf" and options:
                    raise AgentDocumentError("PDF options apply only to PDF export")
                if filename is not None and (not isinstance(filename, str) or not filename or len(filename) > 160
                                              or Path(filename).name != filename or filename in (".", "..")):
                    raise AgentDocumentError("filename must be a safe basename")
                result = live_call("document_action", tab_id, "export_document", format=format,
                                   options=options, expected_revision=expected_revision, filename=filename)
                if not isinstance(result, dict):
                    raise AgentDocumentError("Live export returned invalid status")
                return bounded_result({key: value for key, value in result.items()
                                   if key in ("jobId", "status", "filename", "format", "bytes", "sha256", "path")})
            if output_path is None:
                raise AgentDocumentError("Filesystem export requires output_path inside an allowed root")
            if format != "pdf" and options:
                raise AgentDocumentError("PDF options apply only to PDF export")
            try:
                from .agent_exports import export_pdf, export_smd
            except ImportError:
                from agent_exports import export_pdf, export_smd
            if format == "pdf":
                return export_pdf(store, path, output_path, options=options)
            if options:
                raise AgentDocumentError("PDF options apply only to PDF export")
            if format == "smd":
                return export_smd(store, path, output_path)
            # Markdown export preserves the exact Markdown content and refuses overwrite.
            markdown, _assets, _portable, _raw = store._load(store.resolve(path))
            return store.create(output_path, markdown)
        if action == "job_status":
            if not isinstance(job_id, str) or not job_id or len(job_id) > 300:
                raise AgentDocumentError("job_status requires a jobId returned by a live export")
            result = live_call("document_action", None, "job_status", job_id=job_id)
            if not isinstance(result, dict):
                raise AgentDocumentError("Desktop returned invalid export job status")
            return bounded_result(result)
        if action == "list_diagrams":
            if path is None or live_id(path) is None:
                raise AgentDocumentError("list_diagrams requires an open desktop tab target")
            result = live_call("document_action", live_id(path), "list_diagrams")
            if not isinstance(result, dict) or not isinstance(result.get("diagrams"), list):
                raise AgentDocumentError("Desktop returned invalid diagram metadata")
            result = dict(result)
            result["diagrams"] = result["diagrams"][:50]
            result["target"] = path
            return bounded_result(result)
        if action == "get_diagram":
            if path is None or live_id(path) is None:
                raise AgentDocumentError("get_diagram requires an open desktop tab target")
            if not isinstance(diagram_id, str) or not diagram_id or len(diagram_id) > 200:
                raise AgentDocumentError("diagram_id must come from list_diagrams")
            if not isinstance(expected_revision, str) or not re.fullmatch(r"[0-9a-f]{64}", expected_revision):
                raise AgentDocumentError("get_diagram requires expected_revision from list_diagrams or document_inspect")
            if not 0 <= offset <= 20_000_000 or not 1 <= limit <= 12_000:
                raise AgentDocumentError("diagram offset must be nonnegative and limit must be 1–12,000")
            result = live_call("document_action", live_id(path), "get_diagram", diagram_id=diagram_id,
                               expected_revision=expected_revision, offset=offset, limit=limit)
            if not isinstance(result, dict):
                raise AgentDocumentError("Desktop returned invalid diagram source")
            result["target"] = path
            return bounded_result(result, 64_000)
        if action in ("get_context", "latex_review", "latex_apply"):
            if path is None or live_id(path) is None:
                raise AgentDocumentError(f"{action} is available for open desktop tabs only")
            if action == "latex_apply":
                if not isinstance(expected_revision, str) or not re.fullmatch(r"[0-9a-f]{64}", expected_revision):
                    raise AgentDocumentError("latex_apply requires expected_revision from latex_review")
                if not isinstance(repair_indices, list) or not repair_indices or len(repair_indices) > 40:
                    raise AgentDocumentError("latex_apply requires 1–40 selected repair indices")
                if any(not isinstance(index, int) or isinstance(index, bool) or index < 0 for index in repair_indices):
                    raise AgentDocumentError("repair_indices must be nonnegative integer indices")
                params = {"expected_revision": expected_revision, "repair_indices": repair_indices}
            else:
                params = {}
            result = live_call("document_action", live_id(path), action, **params)
            if not isinstance(result, dict):
                raise AgentDocumentError("Live document action returned invalid status")
            return bounded_result(result, 24_000)
        if action == "list_devices":
            if live_client is None:
                return {"devices": [], "count": 0, "available": False}
            result = live_call("list_devices")
            if not isinstance(result, dict):
                raise AgentDocumentError("Device list is unavailable")
            return bounded_result(result)
        raise AgentDocumentError("Unsupported document action")

    @server.tool()
    def document_patch(path: str, expected_revision: str, operations: list[dict[str, Any]]) -> dict[str, Any]:
        """Apply exact-text or 1-based line edits atomically against a SHA-256 revision."""
        tab_id = live_id(path)
        if tab_id is not None:
            validate_patch_operations(operations)
            if not re.fullmatch(r"[0-9a-f]{64}", expected_revision):
                raise AgentDocumentError("expected_revision must be the SHA-256 from the current tab")
            result = live_call("patch_tab", tab_id, expected_revision=expected_revision, operations=operations)
            if not isinstance(result, dict):
                raise AgentDocumentError("Live bridge returned invalid patch status")
            status = {key: result[key] for key in
                      ("revision", "previous_revision", "saved", "characters", "operations", "id", "title")
                      if key in result}
            status["target"] = path
            return bounded_result(status)
        return store.patch(path, expected_revision=expected_revision, operations=operations)

    @server.tool()
    def document_assets(path: str, offset: int = 0, limit: int = 50,
                        action: str = "list", asset_name: str | None = None,
                        expected_revision: str | None = None, asset_id: str | None = None,
                        asset_path: str | None = None) -> Any:
        """List assets, replace by stable ID, or extract one image as MCP image content."""
        tab_id = live_id(path)
        if action == "list":
            if tab_id is not None:
                if not 1 <= limit <= 50 or offset < 0:
                    raise AgentDocumentError("asset offset must be nonnegative and limit must be 1–50")
                result = live_call("read_tab", tab_id, offset=0, limit=1,
                                   asset_offset=offset, asset_limit=limit)
                if isinstance(result, dict) and "assets" in result:
                    all_assets = result["assets"]
                    if not isinstance(all_assets, list):
                        raise AgentDocumentError("Live bridge returned invalid asset metadata")
                    next_offset = result.get("assetsNextOffset")
                    return {"target": path, "revision": result.get("revision"), "assets": all_assets[:limit],
                            "total": result.get("assetCount", len(all_assets)), "next_offset": next_offset}
                raise AgentDocumentError("Live bridge does not expose asset metadata for this tab yet")
            return store.assets(path, offset=offset, limit=limit)
        if action == "replace":
            if not asset_path or not isinstance(expected_revision, str) or not re.fullmatch(r"[0-9a-f]{64}", expected_revision):
                raise AgentDocumentError("replace requires asset_path and expected_revision from document_inspect")
            if tab_id is not None:
                if not asset_id and not asset_name:
                    raise AgentDocumentError("replace requires asset_id from document_assets")
                resolved_asset_path = str(store.resolve(asset_path))
                result = live_call("document_action", tab_id, "replace_tab_asset",
                                   asset_name=asset_id or asset_name, asset_path=resolved_asset_path,
                                   expected_revision=expected_revision)
                if not isinstance(result, dict):
                    raise AgentDocumentError("Live bridge returned invalid asset replacement status")
                status = {key: result[key] for key in
                          ("asset", "assetId", "revision", "previous_revision", "saved", "changed") if key in result}
                status["target"] = path
                return bounded_result(status)
            return store.replace_asset(path, asset_id or asset_name or "", asset_path,
                                       expected_revision=expected_revision)
        if action != "extract" or not asset_name:
            raise AgentDocumentError("action must be 'list', 'replace', or 'extract' with an asset_id/name")
        if tab_id is not None:
            if not expected_revision or not re.fullmatch(r"[0-9a-f]{64}", expected_revision):
                raise AgentDocumentError("Image extraction requires the SHA-256 from document_inspect")
            image = live_call("get_tab_image", tab_id, asset_name=asset_name,
                              expected_revision=expected_revision)
            if not isinstance(image, dict):
                raise AgentDocumentError("Live bridge returned invalid image data")
            metadata = {key: image[key] for key in ("asset", "mime_type", "bytes", "sha256", "revision") if key in image}
            metadata["target"] = path
            return as_asset_image_blocks(image.get("data"), image.get("mime_type", ""), metadata)
        if not expected_revision:
            raise AgentDocumentError("Image extraction requires expected_revision from document_inspect")
        info = store.inspect(path)
        if info["revision"] != expected_revision:
            raise RevisionConflict("Document changed since it was read; inspect again before extracting")
        asset = store.read_asset(path, asset_name, expected_revision=expected_revision)
        mime, data = asset["mime_type"], asset["data"]
        # Pass verified, app-supported asset types as true MCP image blocks.
        # Viewport snapshots stay raster-only, but explicit SVG extraction can
        # preserve the SVG MIME and bytes without interpreting or rendering it.
        return as_asset_image_blocks(data, mime, {"target": path, "asset": asset_name,
                                                   "mime_type": mime, "bytes": len(data),
                                                   "sha256": asset["sha256"],
                                                   "revision": expected_revision})

    @server.tool()
    def document_attach_asset(path: str, asset_path: str, expected_revision: str,
                              name: str | None = None) -> dict[str, Any]:
        """Embed one bounded image file in a portable SMD note."""
        tab_id = live_id(path)
        if tab_id is not None:
            asset_path = str(store.resolve(asset_path))
            if not re.fullmatch(r"[0-9a-f]{64}", expected_revision):
                raise AgentDocumentError("expected_revision must be the SHA-256 from the current tab")
            result = live_call("attach_tab", tab_id, asset_path=asset_path,
                               expected_revision=expected_revision, name=name)
            if not isinstance(result, dict):
                raise AgentDocumentError("Live bridge returned invalid asset status")
            status = {key: result[key] for key in
                      ("asset", "revision", "previous_revision", "saved", "id", "title") if key in result}
            status["target"] = path
            return bounded_result(status)
        return store.attach_asset(path, asset_path, expected_revision=expected_revision, name=name)

    @server.tool()
    def document_view(path: str, width: int = 1600, diagram_id: str | None = None,
                      expected_revision: str | None = None) -> Any:
        """Return a current viewport or one requested rendered diagram as MCP image content."""
        tab_id = live_id(path)
        if tab_id is None:
            raise AgentDocumentError("Viewport rendering is available for open desktop tabs only")
        if not 64 <= width <= 1600:
            raise AgentDocumentError("width must be between 64 and 1,600 pixels")
        if diagram_id is not None:
            if not isinstance(diagram_id, str) or not diagram_id or len(diagram_id) > 200:
                raise AgentDocumentError("diagram_id must come from list_diagrams")
            if not isinstance(expected_revision, str) or not re.fullmatch(r"[0-9a-f]{64}", expected_revision):
                raise AgentDocumentError("Diagram image requires expected_revision from list_diagrams")
            image = live_call("document_action", tab_id, "get_diagram_image", diagram_id=diagram_id,
                              expected_revision=expected_revision, width=width)
        else:
            image = live_call("render_tab", tab_id, width=width)
        if not isinstance(image, dict):
            raise AgentDocumentError("Live renderer returned invalid image data")
        if diagram_id is not None:
            rendered_width, rendered_height = image.get("width"), image.get("height")
            if rendered_width is not None and (not isinstance(rendered_width, int) or isinstance(rendered_width, bool)
                                               or not 1 <= rendered_width <= width):
                raise AgentDocumentError("Diagram image width exceeds the requested bound")
            if rendered_height is not None and (not isinstance(rendered_height, int) or isinstance(rendered_height, bool)
                                                or not 1 <= rendered_height <= 8192):
                raise AgentDocumentError("Diagram image height exceeds the supported bound")
            metadata = {key: image[key] for key in ("revision", "diagramId", "width", "height", "mime_type", "bytes")
                        if key in image}
            metadata["target"] = path
            return as_image_blocks(image.get("data"), image.get("mime_type", ""), metadata)
        rendered_width, rendered_height = image.get("width"), image.get("height")
        if (not isinstance(rendered_width, int) or isinstance(rendered_width, bool) or
                not isinstance(rendered_height, int) or isinstance(rendered_height, bool) or
                not 1 <= rendered_width <= width or not 1 <= rendered_height <= 8192):
            raise AgentDocumentError("Live renderer returned dimensions outside the requested viewport bounds")
        metadata = {key: image[key] for key in ("revision", "width", "height", "title", "id", "mime_type", "bytes")
                    if key in image}
        metadata["target"] = path
        return as_image_blocks(image.get("data"), image.get("mime_type", ""), metadata)

    return server, store


def _token(args) -> str:
    token = os.environ.get("SUPERMD_MCP_TOKEN", "")
    if args.token_file:
        token_path = Path(args.token_file).expanduser()
        if token_path.is_symlink():
            raise ValueError("Refusing a symlink token file")
        if os.name == "posix" and token_path.stat().st_mode & 0o077:
            raise ValueError("Token file must not be readable by group or other users (chmod 600)")
        token = token_path.read_text(encoding="utf-8").strip()
    if len(token) < 32:
        raise ValueError("HTTP MCP requires SUPERMD_MCP_TOKEN or --token-file with a token of at least 32 characters")
    return token


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Super MD MCP server")
    parser.add_argument("--root", action="append", default=[], help="Explicit allowed workspace root (repeatable); optional for live-only")
    parser.add_argument("--transport", choices=("stdio", "streamable-http"), default="stdio")
    parser.add_argument("--host", default="127.0.0.1", help="HTTP bind address; defaults to loopback")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--token-file", help="Read HTTP bearer token from this file (never pass token on command line)")
    parser.add_argument("--live-sessions-dir", help="Opt in to currently open desktop tabs from this private discovery folder")
    parser.add_argument("--allow-host", action="append", help="Exact HTTP Host allowlist entry; repeatable for public/proxy deployment")
    parser.add_argument("--allow-origin", action="append", help="Exact browser Origin allowlist entry; repeatable")
    args = parser.parse_args(argv)
    try:
        live_client = None
        if args.live_sessions_dir:
            try:
                from .agent_live_client import MultiSessionLiveClient
            except ImportError:
                from agent_live_client import MultiSessionLiveClient
            live_client = MultiSessionLiveClient(args.live_sessions_dir)
        if not args.root and live_client is None:
            raise ValueError("Provide at least one --root or --live-sessions-dir")
        server, _ = build_mcp_server(args.root, live_client=live_client)
        if args.transport == "stdio":
            server.run(transport="stdio")
            return 0

        is_loopback = args.host in ("127.0.0.1", "localhost", "::1")
        if not 1 <= args.port <= 65535:
            raise ValueError("port must be between 1 and 65535")
        token = _token(args)
        from mcp.server.transport_security import TransportSecuritySettings
        import uvicorn

        kwargs = {"host": args.host, "port": args.port,
                  "streamable_http_path": "/mcp", "max_request_body_size": 2 * 1024 * 1024}
        if is_loopback:
            if args.allow_host or args.allow_origin:
                raise ValueError("Loopback mode uses the SDK's built-in localhost DNS-rebinding protection; remove allowlists")
            kwargs["host"] = args.host
        else:
            if not args.allow_host:
                raise ValueError("Non-loopback HTTP requires explicit --allow-host entries")
            kwargs["transport_security"] = TransportSecuritySettings(
                allowed_hosts=args.allow_host,
                allowed_origins=args.allow_origin or [],
            )
        app = BearerAuth(server.streamable_http_app(**kwargs), token)
        # Single worker only: agent edits use process-local operations plus
        # stable filesystem locks, and no public/multi-user deployment is implied.
        uvicorn.run(app, host=args.host, port=args.port, access_log=False,
                    timeout_keep_alive=10, limit_concurrency=64, log_level="warning")
        return 0
    except (ValueError, OSError, ImportError) as exc:
        print(f"Super MD MCP server: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
