"""Authenticated local/cloud MCP server for Super MD documents.

The MCP SDK is imported only when this module is invoked, so ordinary desktop
startup and the standalone CLI do not load the MCP, ASGI, or Qt runtimes.
"""
from __future__ import annotations

import argparse
import hmac
import base64
import inspect
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


def _valid_diagram_id(value: Any) -> bool:
    return (isinstance(value, str) and value.startswith("diagram:")
            and 9 <= len(value) <= 128 and value.isprintable())


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

    def live_outline(tab_id: str, offset: int = 0, limit: int = 80) -> dict:
        result = live_call("outline_tab", tab_id, offset=offset, limit=limit)
        if not isinstance(result, dict):
            raise AgentDocumentError("Live bridge returned invalid outline metadata")
        headings = result.get("headings", result.get("outline"))
        if not isinstance(headings, list) or len(headings) > 5000:
            raise AgentDocumentError("Live bridge returned an invalid or oversized heading outline")
        return {"headings": headings, "revision": result.get("revision"),
                "sourceLength": result.get("sourceLength", result.get("documentLength", result.get("totalLength"))),
                "total": result.get("total", len(headings)), "offset": result.get("offset", offset),
                "nextOffset": result.get("nextOffset"), "truncated": result.get("truncated", False)}

    def normalize_live_heading(item: dict) -> dict:
        start = item.get("start", item.get("offset", item.get("charOffset")))
        if not isinstance(start, int) or isinstance(start, bool) or start < 0:
            raise AgentDocumentError("Live outline entry is missing a valid character offset")
        level = item.get("level")
        if not isinstance(level, int) or isinstance(level, bool) or not 1 <= level <= 6:
            raise AgentDocumentError("Live outline entry is missing a valid heading level")
        return {"index": item.get("index", 0), "level": level, "title": str(item.get("title", ""))[:300],
                "line": item.get("line"), "start": start}

    def read_live_tab(tab_id: str, offset: int, limit: int, view: str,
                      heading: int | str | None = None) -> dict:
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
        response.update({key: result[key] for key in ("heading", "sectionStart", "sectionEnd", "documentLength")
                         if key in result})
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

    def svg_source_blocks(data: bytes, metadata: dict, offset: int = 0, limit: int = 12000) -> list[Any]:
        """Expose original SVG XML as paginated text, not an unsupported MCP image MIME.

        MCP clients commonly reject image/svg+xml in ImageContent, preventing
        agents from inspecting or restyling an embedded vector illustration.
        """
        if not isinstance(data, bytes) or not data or len(data) > 25 * 1024 * 1024:
            raise AgentDocumentError("SVG asset must be nonempty and no larger than 25 MB")
        if not isinstance(offset, int) or isinstance(offset, bool) or offset < 0:
            raise AgentDocumentError("SVG source offset must be nonnegative")
        if not isinstance(limit, int) or isinstance(limit, bool) or not 1 <= limit <= 12000:
            raise AgentDocumentError("SVG source limit must be 1–12000 characters")
        try:
            source = data.decode("utf-8")
        except UnicodeDecodeError as error:
            raise AgentDocumentError("SVG source must be valid UTF-8") from error
        if "<svg" not in source[:4096].lower():
            raise AgentDocumentError("Asset does not contain SVG source")
        page = source[offset:offset + limit]
        end = offset + len(page)
        return [TextContent(type="text", text=json.dumps({**metadata, "source": page,
                "offset": offset, "totalLength": len(source),
                "next_offset": end if end < len(source) else None,
                "truncated": end < len(source)}, ensure_ascii=False))]

    live_unavailable_reason = (
        "Live Agent Access is disabled or Super MD is not running. "
        "Ask the user to open Super MD and enable Live Agent Access in Settings → AI agents."
    )

    def resolve_live_asset_path(raw_path: str) -> str:
        if not isinstance(raw_path, str) or not 1 <= len(raw_path.strip()) <= 4096 or "\0" in raw_path:
            raise AgentDocumentError("asset_path must be a non-empty file path")
        if store.roots:
            return str(store.resolve(raw_path))
        return str(Path(raw_path).expanduser())

    @server.tool()
    def list_sessions() -> dict[str, Any]:
        """List currently open desktop tabs, including unsaved source and revision IDs."""
        if live_client is None:
            return {"sessions": [], "count": 0, "available": False, "reason": live_unavailable_reason}
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
        available = (response["available"]
                     if isinstance(response, dict) and isinstance(response.get("available"), bool)
                     else bool(sessions))
        result: dict[str, Any] = {
            "sessions": sessions[:32],
            "count": len(sessions),
            "truncated": len(sessions) > 32,
            "available": available,
        }
        if not available:
            reason = response.get("reason") if isinstance(response, dict) and isinstance(response.get("reason"), str) else ""
            result["reason"] = reason[:500] if reason else live_unavailable_reason
        return result

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
            metadata["outline_truncated"] = outline["truncated"] or len(headings) > 80
            metadata["heading_count"] = outline["total"]
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
                      heading: int | str | None = None, view: str = "prose") -> dict[str, Any]:
        """Read a bounded source page; fenced SVG bodies are elided unless view='source'."""
        if view not in ("prose", "source"):
            raise AgentDocumentError("view must be 'prose' or 'source'")
        tab_id = live_id(path)
        if tab_id is not None:
            if (not isinstance(offset, int) or isinstance(offset, bool) or offset < 0
                    or not isinstance(limit, int) or isinstance(limit, bool) or not 1 <= limit <= 12000):
                raise AgentDocumentError("limit must be 1–12,000 and offset must be nonnegative")
            if heading is not None and not (
                    isinstance(heading, int) and not isinstance(heading, bool) and heading >= 0
                    or isinstance(heading, str) and bool(heading.strip()) and len(heading) <= 300):
                raise AgentDocumentError("heading must be an outline index, exact title, slug, or numbered heading prefix")
            response = read_live_tab(tab_id, offset, limit, view, heading=heading)
            response["target"] = path
            return bounded_result(response)
        return store.read(path, offset=offset, limit=limit, heading=heading, view=view)

    @server.tool()
    def document_search(path: str, query: str, limit: int = 10, context: int = 100,
                        offset: int = 0, case_sensitive: bool = False,
                        whole_word: bool = False, regex: bool = False,
                        exclude_diagrams: bool = False) -> dict[str, Any]:
        """Find paginated source matches with optional word, case, regex and diagram filters."""
        tab_id = live_id(path)
        if tab_id is not None:
            if (not isinstance(query, str) or not query or len(query) > 500 or
                    not isinstance(limit, int) or isinstance(limit, bool) or not 1 <= limit <= 25 or
                    not isinstance(context, int) or isinstance(context, bool) or not 0 <= context <= 500 or
                    not isinstance(offset, int) or isinstance(offset, bool) or not 0 <= offset <= 20_000_000 or
                    any(not isinstance(value, bool) for value in (case_sensitive, whole_word, regex, exclude_diagrams))):
                raise AgentDocumentError("query, limit, context, offset, or search flags are invalid")
            result = live_call("search_tab", tab_id, query=query, limit=limit, context=context,
                               offset=offset, case_sensitive=case_sensitive, whole_word=whole_word,
                               regex=regex, exclude_diagrams=exclude_diagrams)
            if not isinstance(result, dict) or not isinstance(result.get("matches"), list):
                raise AgentDocumentError("Live bridge returned invalid search results")
            result = dict(result)
            clean_matches = []
            for item in result["matches"][:limit]:
                if not isinstance(item, dict):
                    continue
                match = {key: item[key] for key in ("offset", "line", "start", "end", "snippet",
                                                     "matchOffset", "matchLength", "snippetOffset") if key in item}
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
                        background: bool = False, save_as: bool = False,
                        discard_changes: bool = False,
                        expected_revision: str | None = None,
                        repair_indices: list[int] | None = None, job_id: str | None = None,
                        device_id: str | None = None, diagram_id: str | None = None,
                        offset: int = 0, limit: int | None = None) -> dict[str, Any]:
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
            if format is not None and format not in ("md", "smd"):
                raise AgentDocumentError("format must be md or smd")
            if title is not None and (not isinstance(title, str) or len(title) > 160 or "\0" in title):
                raise AgentDocumentError("title must be at most 160 characters")
            if filename is not None and (not isinstance(filename, str) or not filename or len(filename) > 160 or
                                         Path(filename).name != filename or filename in (".", "..") or "\0" in filename):
                raise AgentDocumentError("filename must be a safe naming hint")
            naming_hint = title or filename or ""
            if format is None:
                format = "smd" if Path(naming_hint).suffix.lower() == ".smd" else "md"
            if not isinstance(background, bool):
                raise AgentDocumentError("background must be a boolean")
            result = live_call("document_action", None, "create_document", content=content,
                               title=title or "", filename=filename or "", format=format, background=background,
                               device_id=device_id)
            if not isinstance(result, dict):
                raise AgentDocumentError("Desktop returned invalid created-tab metadata")
            return bounded_result(result)
        if action == "save_document":
            if path is None or live_id(path) is None:
                raise AgentDocumentError("save_document requires a current tab target")
            if not isinstance(expected_revision, str) or not re.fullmatch(r"[0-9a-f]{64}", expected_revision):
                raise AgentDocumentError("save_document requires expected_revision from document_inspect")
            if format is not None and format not in ("md", "smd"):
                raise AgentDocumentError("format must be md or smd")
            if title:
                raise AgentDocumentError("Use filename for save_document; title applies to create_document")
            if filename is not None and (not isinstance(filename, str) or not filename or len(filename) > 160
                                         or Path(filename).name != filename or filename in (".", "..")):
                raise AgentDocumentError("filename must be a safe basename")
            if not isinstance(save_as, bool):
                raise AgentDocumentError("save_as must be a boolean")
            result = live_call("document_action", live_id(path), "save_document", expected_revision=expected_revision,
                               filename=filename or "", format=format, save_as=save_as)
            if not isinstance(result, dict):
                raise AgentDocumentError("Desktop returned invalid save status")
            return bounded_result(result)
        if action == "open_document":
            if live_client is None:
                raise AgentDocumentError("open_document requires a live desktop session")
            if path and live_id(path) is not None:
                target_id = live_id(path)
                if not isinstance(background, bool):
                    raise AgentDocumentError("background must be a boolean")
                result = live_call("document_action", target_id, "open_document", background=background)
                if not isinstance(result, dict):
                    raise AgentDocumentError("Desktop returned invalid open status")
                return bounded_result({**result, "target": path, "opened": True})
            if filename is None and path is not None:
                filename = path
            if not isinstance(filename, str) or not filename or len(filename) > 4096 or "\0" in filename:
                raise AgentDocumentError("open_document requires a bounded path, basename, or open tab target")
            if not isinstance(background, bool):
                raise AgentDocumentError("background must be a boolean")
            result = live_call("document_action", None, "open_document", filename=filename,
                               background=background, device_id=device_id)
            if not isinstance(result, dict):
                raise AgentDocumentError("Desktop returned invalid open status")
            return bounded_result(result)
        if action == "activate_document":
            if path is None or live_id(path) is None:
                raise AgentDocumentError("activate_document requires an open desktop tab target")
            result = live_call("document_action", live_id(path), "activate_document")
            if not isinstance(result, dict):
                raise AgentDocumentError("Desktop returned invalid activation metadata")
            return bounded_result({**result, "target": path})
        if action == "close_document":
            if path is None or live_id(path) is None:
                raise AgentDocumentError("close_document requires an open desktop tab target")
            if not isinstance(expected_revision, str) or not re.fullmatch(r"[0-9a-f]{64}", expected_revision):
                raise AgentDocumentError("close_document requires expected_revision from document_inspect")
            if not isinstance(discard_changes, bool):
                raise AgentDocumentError("discard_changes must be a boolean")
            result = live_call("document_action", live_id(path), "close_document",
                               expected_revision=expected_revision, discard_changes=discard_changes)
            if not isinstance(result, dict):
                raise AgentDocumentError("Desktop returned invalid close status")
            return bounded_result({**result, "target": path})
        if action in ("export", "export_document"):
            if path is None or format not in ("pdf", "smd", "md", "mdzip"):
                raise AgentDocumentError("export requires a source path and format pdf, smd, md, or mdzip")
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
            if format == "mdzip":
                raise AgentDocumentError("Filesystem export supports pdf, smd, or md; mdzip requires a live tab")
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
            markdown = store.read_markdown(path)
            return store.create(output_path, markdown)
        if action == "job_status":
            if not isinstance(job_id, str) or not job_id or len(job_id) > 300:
                raise AgentDocumentError("job_status requires a live jobId")
            result = live_call("document_action", None, "job_status", job_id=job_id)
            if not isinstance(result, dict):
                raise AgentDocumentError("Desktop returned invalid export job status")
            return bounded_result(result)
        if action == "list_diagrams":
            if path is None or live_id(path) is None:
                raise AgentDocumentError("list_diagrams requires an open desktop tab target")
            diagram_limit = 80 if limit is None else limit
            if (not isinstance(offset, int) or isinstance(offset, bool) or not 0 <= offset <= 20_000_000
                    or not isinstance(diagram_limit, int) or isinstance(diagram_limit, bool)
                    or not 1 <= diagram_limit <= 80):
                raise AgentDocumentError("diagram offset must be nonnegative and limit must be 1–80")
            if expected_revision is not None and (not isinstance(expected_revision, str)
                                                  or not re.fullmatch(r"[0-9a-f]{64}", expected_revision)):
                raise AgentDocumentError("list_diagrams expected_revision must be a SHA-256 revision")
            result = live_call("document_action", live_id(path), "list_diagrams",
                               expected_revision=expected_revision, offset=offset, limit=diagram_limit)
            if not isinstance(result, dict) or not isinstance(result.get("diagrams"), list):
                raise AgentDocumentError("Desktop returned invalid diagram metadata")
            result = dict(result)
            result["target"] = path
            return bounded_result(result)
        if action == "outline":
            if path is None or live_id(path) is None:
                raise AgentDocumentError("outline requires an open desktop tab target")
            outline_limit = 80 if limit is None else limit
            if (not isinstance(offset, int) or isinstance(offset, bool) or not 0 <= offset <= 20_000_000
                    or not isinstance(outline_limit, int) or isinstance(outline_limit, bool)
                    or not 1 <= outline_limit <= 80):
                raise AgentDocumentError("outline offset must be nonnegative and limit must be 1–80")
            result = live_call("outline_tab", live_id(path), offset=offset, limit=outline_limit)
            if not isinstance(result, dict) or not isinstance(result.get("headings"), list):
                raise AgentDocumentError("Desktop returned invalid outline metadata")
            result = dict(result)
            result["target"] = path
            return bounded_result(result)
        if action == "get_diagram":
            if path is None or live_id(path) is None:
                raise AgentDocumentError("get_diagram requires an open desktop tab target")
            if not _valid_diagram_id(diagram_id):
                raise AgentDocumentError("diagram_id must come from list_diagrams")
            if not isinstance(expected_revision, str) or not re.fullmatch(r"[0-9a-f]{64}", expected_revision):
                raise AgentDocumentError("get_diagram requires expected_revision from list_diagrams or document_inspect")
            diagram_limit = 12_000 if limit is None else limit
            if not isinstance(offset, int) or isinstance(offset, bool) or not 0 <= offset <= 20_000_000 or not isinstance(diagram_limit, int) or isinstance(diagram_limit, bool) or not 1 <= diagram_limit <= 12_000:
                raise AgentDocumentError("diagram offset must be nonnegative and limit must be 1–12,000")
            result = live_call("document_action", live_id(path), "get_diagram", diagram_id=diagram_id,
                               expected_revision=expected_revision, offset=offset, limit=diagram_limit)
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
                return {"devices": [], "count": 0, "available": False, "reason": live_unavailable_reason}
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
                      ("revision", "previous_revision", "saved", "characters", "sourceLength", "operations",
                       "applied", "operation_results", "changed", "isDirty", "id", "tabId", "title")
                      if key in result}
            status["target"] = path
            return bounded_result(status)
        return store.patch(path, expected_revision=expected_revision, operations=operations)

    @server.tool()
    def document_assets(path: str, offset: int = 0, limit: int = 50,
                        action: str = "list", asset_name: str | None = None,
                        expected_revision: str | None = None, asset_id: str | None = None,
                        asset_path: str | None = None, source_offset: int = 0,
                        source_limit: int = 12000) -> Any:
        """List/replace assets; extract SVG as paginated XML text, raster as MCP image."""
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
                resolved_asset_path = resolve_live_asset_path(asset_path)
                result = live_call("document_action", tab_id, "replace_tab_asset",
                                   asset_name=asset_id or asset_name, asset_path=resolved_asset_path,
                                   expected_revision=expected_revision)
                if not isinstance(result, dict):
                    raise AgentDocumentError("Live bridge returned invalid asset replacement status")
                status = {key: result[key] for key in
                          ("asset", "assetName", "assetId", "revision", "previous_revision", "saved", "changed", "bytes", "mimeType")
                          if key in result}
                if "asset" not in status and "assetName" in result:
                    status["asset"] = result["assetName"]
                if "saved" not in status and "changed" in result:
                    status["saved"] = bool(result["changed"])
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
            if image.get("mime_type") == "image/svg+xml":
                return svg_source_blocks(image.get("data"), metadata, source_offset, source_limit)
            return as_asset_image_blocks(image.get("data"), image.get("mime_type", ""), metadata)
        if not expected_revision:
            raise AgentDocumentError("Image extraction requires expected_revision from document_inspect")
        asset = store.read_asset(path, asset_name, expected_revision=expected_revision)
        mime, data = asset["mime_type"], asset["data"]
        # Pass verified, app-supported asset types as true MCP image blocks.
        # Viewport snapshots stay raster-only, but explicit SVG extraction can
        # preserve the SVG MIME and bytes without interpreting or rendering it.
        metadata = {"target": path, "asset": asset_name, "mime_type": mime,
                    "bytes": len(data), "sha256": asset["sha256"], "revision": expected_revision}
        if mime == "image/svg+xml":
            return svg_source_blocks(data, metadata, source_offset, source_limit)
        return as_asset_image_blocks(data, mime, metadata)

    @server.tool()
    def document_attach_asset(path: str, asset_path: str, expected_revision: str,
                              name: str | None = None) -> dict[str, Any]:
        """Embed one bounded image file in a portable SMD note."""
        tab_id = live_id(path)
        if tab_id is not None:
            asset_path = resolve_live_asset_path(asset_path)
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
            if diagram_id is not None:raise AgentDocumentError("Use the background service for individual rendered frames, or extract the original asset")
            if not 320 <= width <= 1600:raise AgentDocumentError("Offline preview width must be between 320 and 1,600 pixels")
            from offline_view import render_offline
            body=render_offline(store,path,width=width,expected_revision=expected_revision)
            return [ImageContent(type="image",data=base64.b64encode(body).decode(),mimeType="image/png")]
        if not 64 <= width <= 1600:
            raise AgentDocumentError("width must be between 64 and 1,600 pixels")
        if diagram_id is not None:
            if not _valid_diagram_id(diagram_id):
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

    def _bounded_text(value: Any, limit: int) -> str | None:
        return value[:limit] if isinstance(value, str) else None

    def _safe_int(value: Any) -> int | None:
        return value if isinstance(value, int) and not isinstance(value, bool) else None

    def _normalize_reading_context(context: dict[str, Any]) -> dict[str, Any]:
        source_length = _safe_int(context.get("sourceLength"))
        visible_source = context.get("visibleSource")
        if source_length is None or source_length < 0 or not isinstance(visible_source, dict):
            return dict(context)
        start = _safe_int(visible_source.get("start"))
        end = _safe_int(visible_source.get("end"))
        if start is None or end is None or start < 0 or end < start or end > source_length:
            return dict(context)
        updated = dict(context)
        updated["visibleSource"] = {
            **visible_source,
            "total_chars": source_length,
            "next_offset": end if end < source_length else None,
            "truncated": end < source_length,
        }
        return updated

    def _bounded_diagrams(value: Any) -> list[dict[str, Any]] | None:
        if not isinstance(value, list):
            return None
        items: list[dict[str, Any]] = []
        for raw in value[:30]:
            if not isinstance(raw, dict):
                continue
            item: dict[str, Any] = {}
            for key in ("id", "kind"):
                text = _bounded_text(raw.get(key), 128)
                if text is not None:
                    item[key] = text
            for key in ("sourceStart", "sourceEnd", "sourceChars"):
                num = _safe_int(raw.get(key))
                if num is not None:
                    item[key] = num
            preview = _bounded_text(raw.get("preview"), 160)
            if preview is not None:
                item["preview"] = preview
            deck_title = _bounded_text(raw.get("deckTitle"), 200)
            if deck_title is not None:
                item["deckTitle"] = deck_title
            step_label = _bounded_text(raw.get("stepLabel"), 200)
            if step_label is not None:
                item["stepLabel"] = step_label
            step_index = _safe_int(raw.get("stepIndex"))
            if step_index is not None and step_index >= 0:
                item["stepIndex"] = step_index
            step_count = _safe_int(raw.get("stepCount"))
            if step_count is not None and step_count >= 1:
                item["stepCount"] = step_count
            if isinstance(raw.get("activeStep"), bool):
                item["activeStep"] = raw["activeStep"]
            asset_ref = _bounded_text(raw.get("assetReference"), 512)
            if (asset_ref is not None and not asset_ref.lower().startswith("data:")
                    and "base64," not in asset_ref.lower()):
                item["assetReference"] = asset_ref
            items.append(item)
        return items

    def _bounded_active_step(value: Any) -> dict[str, Any] | None:
        if not isinstance(value, dict):
            return None
        deck_title = _bounded_text(value.get("deckTitle"), 200)
        step_index = _safe_int(value.get("stepIndex"))
        step_count = _safe_int(value.get("stepCount"))
        if deck_title is None or step_index is None or step_index < 0 or step_count is None or step_count < 1:
            return None
        result: dict[str, Any] = {
            "deckTitle": deck_title,
            "stepIndex": step_index,
            "stepCount": step_count,
            "activeStep": value.get("activeStep") is not False,
        }
        step_label = _bounded_text(value.get("stepLabel"), 200)
        if step_label is not None:
            result["stepLabel"] = step_label
        if isinstance(value.get("expanded"), bool):
            result["expanded"] = value["expanded"]
        return result

    def _bounded_python_cells(value: Any) -> list[dict[str, Any]] | None:
        if not isinstance(value, list):
            return None
        cells: list[dict[str, Any]] = []
        for raw in value[:8]:
            if not isinstance(raw, dict) or not isinstance(raw.get("ok"), bool):
                continue
            entry: dict[str, Any] = {"ok": raw["ok"]}
            for key in ("ordinal", "sourceStart", "sourceEnd"):
                num = _safe_int(raw.get(key))
                if num is not None and num >= 0:
                    entry[key] = num
            stdout = _bounded_text(raw.get("stdout"), 500)
            if stdout is not None:
                entry["stdout"] = stdout
            if raw.get("stdoutTruncated") is True or (isinstance(raw.get("stdout"), str) and len(raw["stdout"]) > 500):
                entry["stdoutTruncated"] = True
            stderr = _bounded_text(raw.get("stderr"), 500)
            if stderr is not None:
                entry["stderr"] = stderr
            if raw.get("stderrTruncated") is True or (isinstance(raw.get("stderr"), str) and len(raw["stderr"]) > 500):
                entry["stderrTruncated"] = True
            if isinstance(raw.get("figureIds"), list):
                entry["figureIds"] = [
                    fid for fid in raw["figureIds"]
                    if isinstance(fid, str) and fid.startswith("diagram:python:") and len(fid) <= 128
                ][:16]
            cells.append(entry)
        return cells or None

    def _viewport_contexts(image: dict[str, Any], tab_id: str,
                           expected_revision: str) -> tuple[dict[str, Any], dict[str, Any] | None]:
        nested = image.get("context") if isinstance(image.get("context"), dict) else None
        metadata = image.get("metadata") if isinstance(image.get("metadata"), dict) else None
        source = nested if nested is not None else image
        raw_tab_id = source.get("tabId") if isinstance(source.get("tabId"), str) and source.get("tabId") else (
            metadata.get("tabId") if metadata and isinstance(metadata.get("tabId"), str) else None
        )
        source_revision = source.get("revision")
        revision_matches = not isinstance(source_revision, str) or source_revision == expected_revision
        capture_ctx: dict[str, Any] = {
            "tabId": tab_id,
            "revision": expected_revision,
            "contextRevisionMatches": revision_matches,
        }
        if raw_tab_id and raw_tab_id != tab_id:
            capture_ctx["nativeTabId"] = raw_tab_id
        if isinstance(source_revision, str) and source_revision != expected_revision:
            capture_ctx["contextRevision"] = source_revision
        mode = _bounded_text(source.get("mode", metadata.get("mode") if metadata else None), 64)
        if mode is not None:
            capture_ctx["mode"] = mode
        zoom = source.get("zoom", metadata.get("zoom") if metadata else None)
        if isinstance(zoom, (int, float)) and not isinstance(zoom, bool):
            capture_ctx["zoom"] = zoom
        raw_reading = source.get("reading", metadata.get("reading") if metadata else None)
        if isinstance(raw_reading, dict):
            reading: dict[str, Any] = {}
            for key in ("offset", "scrollFraction"):
                val = raw_reading.get(key)
                if isinstance(val, (int, float)) and not isinstance(val, bool):
                    reading[key] = val
            heading = _bounded_text(raw_reading.get("heading"), 300)
            if heading is not None:
                reading["heading"] = heading
            vis_text = _bounded_text(raw_reading.get("visibleText"), 2000)
            if vis_text is not None:
                reading["visibleText"] = vis_text
            capture_ctx["reading"] = reading
        raw_selection = source.get("selection", metadata.get("selection") if metadata else None)
        if isinstance(raw_selection, dict):
            sel_text = _bounded_text(raw_selection.get("text"), 2000)
            capture_ctx["selection"] = {} if sel_text is None else {"text": sel_text}
        raw_viewport = source.get("viewport", metadata.get("viewport") if metadata else None)
        if isinstance(raw_viewport, dict):
            vp = {
                key: raw_viewport[key]
                for key in ("x", "y", "width", "height", "viewportWidth", "viewportHeight", "devicePixelRatio")
                if isinstance(raw_viewport.get(key), (int, float)) and not isinstance(raw_viewport.get(key), bool)
            }
            capture_ctx["viewport"] = vp
        active_step = _bounded_active_step(source.get("activeStep", metadata.get("activeStep") if metadata else None))
        if active_step is not None:
            capture_ctx["activeStep"] = active_step
        source_length = _safe_int(source.get("sourceLength"))
        normalized_src = source.get("visibleSource")
        if source_length is not None and source_length >= 0 and isinstance(normalized_src, dict):
            normalized_src = _normalize_reading_context({"sourceLength": source_length, "visibleSource": normalized_src}).get("visibleSource")
        visible_source: dict[str, Any] | None = None
        preview_truncated = False
        if isinstance(normalized_src, dict) and isinstance(normalized_src.get("text"), str):
            text_chars = normalized_src["text"]
            returned_text = text_chars[:12_000]
            preview_truncated = len(text_chars) > len(returned_text)
            visible_source = {"text": returned_text}
            source_range: dict[str, Any] = {}
            if preview_truncated:
                visible_source["previewTruncated"] = True
                source_range["previewTruncated"] = True
            start = _safe_int(normalized_src.get("start"))
            for key in ("start", "end", "total_chars", "next_offset", "truncated", "view"):
                alt = normalized_src.get("totalChars") if key == "total_chars" else (
                    normalized_src.get("nextOffset") if key == "next_offset" else None
                )
                field = normalized_src[key] if key in normalized_src else alt
                if key in ("end", "next_offset") and preview_truncated:
                    if start is not None:
                        visible_source[key] = start + len(returned_text)
                        source_range[key] = start + len(returned_text)
                elif key == "truncated" and preview_truncated:
                    visible_source[key] = True
                    source_range[key] = True
                elif (_safe_int(field) is not None or isinstance(field, bool)
                        or (key == "next_offset" and field is None)
                        or (key == "view" and isinstance(field, str))):
                    visible_source[key] = field
                    source_range[key] = field
            if source_range:
                capture_ctx["sourceRange"] = source_range
        diagrams = _bounded_diagrams(source.get("diagrams"))
        python_cells = _bounded_python_cells(source.get("pythonCells"))
        coherent = (revision_matches and visible_source is not None and not preview_truncated
                    and isinstance(source_revision, str) and source_revision == expected_revision)
        captured_reading: dict[str, Any] | None = None
        if coherent and visible_source is not None:
            captured_reading = {**capture_ctx, "visibleSource": visible_source}
            if source_length is not None and source_length >= 0:
                captured_reading["sourceLength"] = source_length
            if diagrams is not None:
                captured_reading["diagrams"] = diagrams
            if python_cells is not None:
                captured_reading["pythonCells"] = python_cells
        return capture_ctx, captured_reading

    @server.tool()
    def view_current(path: str | None = None, tabId: str | None = None,
                     deviceId: str | None = None, width: int | None = None,
                     quality: str = "standard", includeImage: bool = True,
                     include_image: bool | None = None) -> list[Any]:
        """Use FIRST for the current Super MD page or highlighted text. Returns readingContext JSON and an optional viewport image."""
        if quality not in ("standard", "high"):
            raise AgentDocumentError("quality must be 'standard' or 'high'")
        want_image = includeImage if include_image is None else include_image
        if not isinstance(want_image, bool):
            raise AgentDocumentError("includeImage must be a boolean")
        if width is not None and (not isinstance(width, int) or isinstance(width, bool) or not 64 <= width <= 1600):
            raise AgentDocumentError("width must be between 64 and 1,600 pixels")
        if deviceId is not None:
            if not isinstance(deviceId, str) or not deviceId or len(deviceId) > 128:
                raise AgentDocumentError("deviceId must be a valid device identifier")
            if deviceId != "local":
                raise AgentDocumentError("Local MCP server only serves deviceId 'local'")

        requested = path if path is not None else tabId
        if requested is not None:
            if not isinstance(requested, str) or not requested.strip() or len(requested) > 512:
                raise AgentDocumentError("view_current requires a valid open tab target")
            resolved_tab = live_id(requested) if requested.startswith("tab:") else requested
            if not resolved_tab:
                raise AgentDocumentError("view_current requires an open desktop tab target")
            target = requested if requested.startswith("tab:") else f"tab:{resolved_tab}"
        else:
            listed = live_call("list_tabs")
            raw_tabs = listed.get("tabs", listed.get("sessions", [])) if isinstance(listed, dict) else listed
            if not isinstance(raw_tabs, list):
                raise AgentDocumentError("Live bridge returned an invalid tab list")
            valid_tabs = [t for t in raw_tabs if isinstance(t, dict) and isinstance(t.get("id"), str) and t["id"]]
            active_tabs = [t for t in valid_tabs if t.get("active") is True]
            chosen = (active_tabs[0] if len(active_tabs) == 1
                      else valid_tabs[0] if len(active_tabs) == 0 and len(valid_tabs) == 1
                      else None)
            if chosen is None:
                if len(active_tabs) > 1 or len(valid_tabs) > 1:
                    raise AgentDocumentError(
                        "Could not choose a tab safely: provide path or tabId when multiple tabs are open or active")
                raise AgentDocumentError("No open tab was returned by the desktop app")
            resolved_tab = str(chosen["id"])[:300]
            target = f"tab:{resolved_tab}"

        raw_context = live_call("document_action", resolved_tab, "get_context", limit=4000)
        if not isinstance(raw_context, dict):
            raise AgentDocumentError("Live bridge returned invalid reading context")
        revision = raw_context.get("revision")
        if not isinstance(revision, str) or not re.fullmatch(r"[0-9a-f]{64}", revision):
            raise AgentDocumentError("The app returned invalid reading context for the selected tab")
        normalized = _normalize_reading_context(raw_context)
        if "diagrams" in normalized:
            bounded_diags = _bounded_diagrams(normalized.get("diagrams"))
            if bounded_diags is not None:
                normalized["diagrams"] = bounded_diags
        if "activeStep" in normalized:
            bounded_step = _bounded_active_step(normalized.get("activeStep"))
            if bounded_step is not None:
                normalized["activeStep"] = bounded_step
            else:
                normalized.pop("activeStep", None)
        if "pythonCells" in normalized:
            bounded_cells = _bounded_python_cells(normalized.get("pythonCells"))
            if bounded_cells is not None:
                normalized["pythonCells"] = bounded_cells
            else:
                normalized.pop("pythonCells", None)
        raw_ctx_tab = normalized.get("tabId")
        reading_context = dict(normalized)
        if isinstance(raw_ctx_tab, str) and raw_ctx_tab and raw_ctx_tab != resolved_tab:
            reading_context["nativeTabId"] = raw_ctx_tab
        reading_context["tabId"] = resolved_tab
        reading_context["target"] = target

        image_block = None
        preview_info: dict[str, Any] | None = None
        capture_context: dict[str, Any] | None = None
        final_reading_context = reading_context
        reading_context_source = "context_read"
        aligned: bool | None = None

        if want_image:
            edge = width if width is not None else (1600 if quality == "high" else 1000)
            desired_format = "png" if quality == "high" else "jpeg"
            render_cb = getattr(live_client, "render_tab", None)
            supports_format = False
            if callable(render_cb):
                try:
                    params = inspect.signature(render_cb).parameters
                    supports_format = "image_format" in params or any(
                        p.kind == inspect.Parameter.VAR_KEYWORD for p in params.values()
                    )
                except (TypeError, ValueError):
                    supports_format = False
            if supports_format:
                image = live_call("render_tab", resolved_tab, width=edge, image_format=desired_format)
            else:
                image = live_call("render_tab", resolved_tab, width=edge)
            if not isinstance(image, dict):
                raise AgentDocumentError("Live renderer returned invalid image data")
            if image.get("revision") != revision:
                raise RevisionConflict(
                    "The reading tab changed while its viewport was being captured; request the current view again")
            rendered_width, rendered_height = image.get("width"), image.get("height")
            if (not isinstance(rendered_width, int) or isinstance(rendered_width, bool)
                    or not isinstance(rendered_height, int) or isinstance(rendered_height, bool)
                    or not 1 <= rendered_width <= edge or not 1 <= rendered_height <= 8192):
                raise AgentDocumentError("Live renderer returned dimensions outside the requested viewport bounds")
            mime_type = image.get("mime_type", "")
            raw_bytes = image.get("data")
            verified_blocks = as_image_blocks(raw_bytes, mime_type, {"revision": revision})
            image_block = next(block for block in verified_blocks if isinstance(block, ImageContent))
            preview_info = {
                "mimeType": mime_type,
                "byteLength": len(raw_bytes),
                "width": rendered_width,
                "height": rendered_height,
                "previewOnly": mime_type == "image/jpeg",
            }
            capture_context, captured_reading = _viewport_contexts(image, resolved_tab, revision)
            if captured_reading is not None:
                final_reading_context = {**captured_reading, "target": target}
                reading_context_source = "viewport_capture"
                aligned = True
            else:
                init_offset = reading_context.get("reading", {}).get("offset") if isinstance(reading_context.get("reading"), dict) else None
                cap_offset = capture_context.get("reading", {}).get("offset") if isinstance(capture_context.get("reading"), dict) else None
                if isinstance(init_offset, (int, float)) and isinstance(cap_offset, (int, float)):
                    aligned = capture_context.get("contextRevisionMatches") is True and init_offset == cap_offset

        payload: dict[str, Any] = {
            "deviceId": "local",
            "target": target,
            "tabId": resolved_tab,
            "revision": revision,
            "quality": quality,
            "readingContext": final_reading_context,
            "readingContextSource": reading_context_source,
        }
        if aligned is not None:
            payload["readingContextAlignedWithCapture"] = aligned
        if capture_context is not None:
            payload["captureContext"] = capture_context
        if preview_info is not None:
            payload["imagePreview"] = preview_info
        text = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
        if len(text.encode("utf-8")) > 48 * 1024:
            raise AgentDocumentError("The current reading context exceeds the bounded response size")
        return ([image_block] if image_block is not None else []) + [TextContent(type="text", text=text)]

    server._normalize_reading_context = _normalize_reading_context  # type: ignore[attr-defined]
    server._viewport_contexts = _viewport_contexts  # type: ignore[attr-defined]
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
