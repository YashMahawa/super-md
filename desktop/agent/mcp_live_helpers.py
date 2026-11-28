"""MCP live-tab helper adapters, media block builders, and view_current runner."""
from __future__ import annotations

import base64
import inspect
import json
import os
import sys
from collections.abc import Callable
from pathlib import Path
from typing import Any

if __package__ and "." in __package__:
    from .. import documents
    from ..agent_documents import AgentDocumentError, DocumentStore, RevisionConflict
else:
    import documents
    from agent_documents import AgentDocumentError, DocumentStore, RevisionConflict

from . import validators as _v
from .context_normalizer import normalize_initial_reading_context, viewport_contexts

LIVE_UNAVAILABLE_REASON = ("Live Agent Access is disabled or Super MD is not running. "
                           "Ask the user to open Super MD and enable Live Agent Access in Settings → AI agents.")


def live_id(target: str) -> str | None:
    if not target.startswith("tab:"):
        return None
    if not target[4:]:
        raise AgentDocumentError("Live tab target is missing its session-qualified id")
    return target[4:]


def make_live_caller(live_client: Any) -> Callable[..., Any]:
    def live_call(method: str, *args: Any, **kwargs: Any) -> Any:
        if live_client is None:
            raise AgentDocumentError("Live tabs are unavailable in this server; use the desktop app's agent bridge")
        if not callable(callback := getattr(live_client, method, None)):
            raise AgentDocumentError(f"This server does not support live operation {method}")
        try:
            return callback(*args, **kwargs)
        except AgentDocumentError:
            raise
        except Exception as error:
            if any(term in str(error).casefold() for term in ("revision", "stale", "changed since")):
                raise RevisionConflict("Live tab changed since it was read; inspect the current tab and retry") from error
            raise AgentDocumentError(f"Live tab operation failed ({type(error).__name__})") from error
    return live_call


def bounded_result(value: dict[str, Any], limit: int = 64_000) -> dict[str, Any]:
    try:
        encoded = json.dumps(value, ensure_ascii=False, separators=(",", ":"))
    except (TypeError, ValueError) as error:
        raise AgentDocumentError("Live bridge returned a non-JSON value") from error
    if len(encoded.encode("utf-8")) > limit:
        raise AgentDocumentError("Live bridge result exceeded the 64 KB tool-output limit")
    return value


def live_outline(live_call: Callable[..., Any], tab_id: str, offset: int = 0, limit: int = 80) -> dict[str, Any]:
    if not isinstance(result := live_call("outline_tab", tab_id, offset=offset, limit=limit), dict):
        raise AgentDocumentError("Live bridge returned invalid outline metadata")
    if not isinstance(headings := result.get("headings", result.get("outline")), list) or len(headings) > 5000:
        raise AgentDocumentError("Live bridge returned an invalid or oversized heading outline")
    return {"headings": headings, "revision": result.get("revision"),
            "sourceLength": result.get("sourceLength", result.get("documentLength", result.get("totalLength"))),
            "total": result.get("total", len(headings)), "offset": result.get("offset", offset),
            "nextOffset": result.get("nextOffset"), "truncated": result.get("truncated", False)}


def normalize_live_heading(item: dict[str, Any]) -> dict[str, Any]:
    start, level = item.get("start", item.get("offset", item.get("charOffset"))), item.get("level")
    if not isinstance(start, int) or isinstance(start, bool) or start < 0:
        raise AgentDocumentError("Live outline entry is missing a valid character offset")
    if not isinstance(level, int) or isinstance(level, bool) or not 1 <= level <= 6:
        raise AgentDocumentError("Live outline entry is missing a valid heading level")
    return {"index": item.get("index", 0), "level": level, "title": str(item.get("title", ""))[:300], "line": item.get("line"), "start": start}


def read_live_tab(live_call: Callable[..., Any], tab_id: str, offset: int, limit: int, view: str, heading: int | str | None = None) -> dict[str, Any]:
    if not isinstance(result := live_call("read_tab", tab_id, offset=offset, limit=limit, view=view, **({"heading": heading} if heading is not None else {})), dict):
        raise AgentDocumentError("Live bridge returned invalid source text")
    if not isinstance(markdown := result.get("markdown", result.get("text")), str) or len(markdown.encode("utf-8")) > 64_000:
        raise AgentDocumentError("Live bridge returned source outside the 64 KB tool-output bound")
    start = result.get("start", result.get("offset", offset))
    end = result.get("end", start + len(markdown))
    if not isinstance(start, int) or isinstance(start, bool) or start < 0 or not isinstance(end, int) or isinstance(end, bool) or end < start:
        raise AgentDocumentError("Live bridge returned invalid source offsets")
    keys = ("revision", "id", "title", "path", "format", "isDirty", "heading", "sectionStart", "sectionEnd", "documentLength")
    response = {**{key: result[key] for key in keys if key in result}, "start": start, "end": end, "markdown": markdown, "view": view, "returned_chars": len(markdown)}
    if isinstance(omissions := result.get("svg_omissions", result.get("omissions", [])), list):
        response["svg_omissions"] = omissions[:20]
    if isinstance(total := result.get("totalLength", result.get("total_chars")), int) and not isinstance(total, bool) and total >= 0:
        total = result.get("total_chars", total)
        next_offset = result.get("next_offset", end if end < total else None)
        if next_offset is not None and (not isinstance(next_offset, int) or isinstance(next_offset, bool) or next_offset < end or next_offset > total):
            raise AgentDocumentError("Live bridge returned an invalid next_offset")
        response.update({"total_chars": total, "next_offset": next_offset, "truncated": next_offset is not None})
    return response


def _wrap_raster_blocks(data: bytes, mime_type: str, metadata: dict[str, Any], *, prefix: str) -> list[Any]:
    from mcp.types import ImageContent, TextContent
    if not isinstance(data, bytes) or not data or len(data) > 8 * 1024 * 1024:
        raise AgentDocumentError("Image data must be non-empty and no larger than 8 MB")
    if mime_type == "image/png" and not data.startswith(b"\x89PNG\r\n\x1a\n"):
        raise AgentDocumentError(f"{prefix} not a PNG image")
    if mime_type == "image/jpeg" and not data.startswith(b"\xff\xd8\xff"):
        raise AgentDocumentError(f"{prefix} not a JPEG image")
    return [TextContent(type="text", text=json.dumps(metadata, ensure_ascii=False, separators=(",", ":"))),
            ImageContent(type="image", data=base64.b64encode(data).decode("ascii"), mime_type=mime_type)]


def as_image_blocks(data: bytes, mime_type: str, metadata: dict[str, Any]) -> list[Any]:
    if mime_type not in ("image/png", "image/jpeg"):
        raise AgentDocumentError("MCP viewport images must be PNG or JPEG")
    return _wrap_raster_blocks(data, mime_type, metadata, prefix="Renderer returned data that is")


def as_asset_image_blocks(data: bytes, mime_type: str, metadata: dict[str, Any]) -> list[Any]:
    if not isinstance(data, bytes) or not data or len(data) > 8 * 1024 * 1024:
        raise AgentDocumentError("Image data must be non-empty and no larger than 8 MB")
    if mime_type not in documents.MIMES.values():
        raise AgentDocumentError("Asset MIME type is not supported by Super MD")
    return _wrap_raster_blocks(data, mime_type, metadata, prefix="Asset bytes are")


def svg_source_blocks(data: bytes, metadata: dict[str, Any], offset: int = 0, limit: int = 12000) -> list[Any]:
    from mcp.types import TextContent
    if not isinstance(data, bytes) or not data or len(data) > 25 * 1024 * 1024:
        raise AgentDocumentError("SVG asset must be nonempty and no larger than 25 MB")
    _v.require_nonneg_int(offset, field="offset", error_cls=AgentDocumentError, message="SVG source offset must be nonnegative")
    _v.require_int_range(limit, 1, 12_000, field="limit", error_cls=AgentDocumentError, message="SVG source limit must be 1–12000 characters")
    try:
        source = data.decode("utf-8")
    except UnicodeDecodeError as error:
        raise AgentDocumentError("SVG source must be valid UTF-8") from error
    if "<svg" not in source[:4096].lower():
        raise AgentDocumentError("Asset does not contain SVG source")
    page, end = source[offset:offset + limit], offset + len(source[offset:offset + limit])
    out = {**metadata, "source": page, "offset": offset, "totalLength": len(source), "next_offset": end if end < len(source) else None, "truncated": end < len(source)}
    return [TextContent(type="text", text=json.dumps(out, ensure_ascii=False))]


def resolve_live_asset_path(store: DocumentStore, raw_path: str) -> str:
    if not isinstance(raw_path, str) or not raw_path.strip() or len(raw_path) > 4096 or "\0" in raw_path:
        raise AgentDocumentError("asset_path must be a non-empty file path")
    cleaned = _v.strip_extended_length_prefix(raw_path)
    if not cleaned or not cleaned.strip():
        raise AgentDocumentError("asset_path must be a non-empty file path")
    expanded = os.path.expanduser(cleaned)
    cand = Path(expanded)
    if _v.is_hidden_name(cand.name) or (not cand.is_absolute() and any(_v.is_hidden_name(part) for part in cand.parts)):
        raise AgentDocumentError("Hidden files and directories are not allowed")
    if cand.is_absolute():
        if _v.is_link_or_junction(cand):
            raise AgentDocumentError("Symbolic links are not allowed")
        aliased = _v.rewrite_system_path_alias(Path(os.path.abspath(expanded)))
        if _v.is_link_or_junction(aliased) or _v.has_link_or_junction_component(aliased):
            raise AgentDocumentError("Symbolic links are not allowed")
        if store.roots:
            try:
                store.resolve(aliased)
            except AgentDocumentError as error:
                if "outside the configured workspace roots" not in str(error):
                    raise
    return expanded


def run_view_current(live_client: Any, live_call: Callable[..., Any], *, path: str | None = None, tabId: str | None = None,
                     deviceId: str | None = None, width: int | None = None, quality: str = "standard",
                     includeImage: bool = True, include_image: bool | None = None) -> list[Any]:
    from mcp.types import ImageContent, TextContent
    if quality not in ("standard", "high"):
        raise AgentDocumentError("quality must be 'standard' or 'high'")
    want_image = includeImage if include_image is None else include_image
    _v.require_bool_flags({"includeImage": want_image}, ("includeImage",), error_cls=AgentDocumentError)
    if width is not None:
        _v.require_viewport_width(width, min_width=64, max_width=1600, error_cls=AgentDocumentError)
    if deviceId is not None:
        _v.require_identifier(deviceId, field="deviceId", max_len=128, error_cls=AgentDocumentError, message="deviceId must be a valid device identifier")
        if deviceId != "local":
            raise AgentDocumentError("Local MCP server only serves deviceId 'local'")
    if (requested := path if path is not None else tabId) is not None:
        if not isinstance(requested, str) or not requested.strip() or len(requested) > 512:
            raise AgentDocumentError("view_current requires a valid open tab target")
        if not (resolved_tab := live_id(requested) if requested.startswith("tab:") else requested):
            raise AgentDocumentError("view_current requires an open desktop tab target")
        target = requested if requested.startswith("tab:") else f"tab:{resolved_tab}"
    else:
        listed = live_call("list_tabs")
        if not isinstance(raw_tabs := listed.get("tabs", listed.get("sessions", [])) if isinstance(listed, dict) else listed, list):
            raise AgentDocumentError("Live bridge returned an invalid tab list")
        valid_tabs = [t for t in raw_tabs if isinstance(t, dict) and isinstance(t.get("id"), str) and t["id"]]
        active_tabs = [t for t in valid_tabs if t.get("active") is True]
        chosen = active_tabs[0] if len(active_tabs) == 1 else (valid_tabs[0] if len(active_tabs) == 0 and len(valid_tabs) == 1 else None)
        if chosen is None:
            raise AgentDocumentError("Could not choose a tab safely: provide path or tabId when multiple tabs are open or active"
                                     if len(active_tabs) > 1 or len(valid_tabs) > 1 else "No open tab was returned by the desktop app")
        resolved_tab, target = str(chosen["id"])[:300], f"tab:{str(chosen['id'])[:300]}"
    if not isinstance(raw_context := live_call("document_action", resolved_tab, "get_context", limit=4000), dict):
        raise AgentDocumentError("Live bridge returned invalid reading context")
    revision = _v.require_sha256_revision(raw_context.get("revision"), error_cls=AgentDocumentError, message="The app returned invalid reading context for the selected tab")
    reading_context = normalize_initial_reading_context(raw_context, resolved_tab=resolved_tab, target=target)
    image_block = preview_info = capture_context = aligned = None
    final_reading_context, reading_context_source = reading_context, "context_read"
    if want_image:
        edge, desired_format = width if width is not None else (1600 if quality == "high" else 1000), ("png" if quality == "high" else "jpeg")
        render_cb, supports_format = getattr(live_client, "render_tab", None), False
        if callable(render_cb):
            try:
                params = inspect.signature(render_cb).parameters
                supports_format = "image_format" in params or any(p.kind == inspect.Parameter.VAR_KEYWORD for p in params.values())
            except (TypeError, ValueError):
                supports_format = False
        image = live_call("render_tab", resolved_tab, width=edge, image_format=desired_format) if supports_format else live_call("render_tab", resolved_tab, width=edge)
        if not isinstance(image, dict):
            raise AgentDocumentError("Live renderer returned invalid image data")
        if image.get("revision") != revision:
            raise RevisionConflict("The reading tab changed while its viewport was being captured; request the current view again")
        rw, rh = image.get("width"), image.get("height")
        if not isinstance(rw, int) or isinstance(rw, bool) or not isinstance(rh, int) or isinstance(rh, bool) or not 1 <= rw <= edge or not 1 <= rh <= 8192:
            raise AgentDocumentError("Live renderer returned dimensions outside the requested viewport bounds")
        mime_type, raw_bytes = image.get("mime_type", ""), image.get("data")
        image_block = next(b for b in as_image_blocks(raw_bytes, mime_type, {"revision": revision}) if isinstance(b, ImageContent))
        preview_info = {"mimeType": mime_type, "byteLength": len(raw_bytes), "width": rw, "height": rh, "previewOnly": mime_type == "image/jpeg"}
        capture_context, captured_reading = viewport_contexts(image, resolved_tab, revision)
        if captured_reading is not None:
            merged = {**captured_reading, "properties": reading_context["properties"]} if "properties" in reading_context and "properties" not in captured_reading else captured_reading
            final_reading_context, reading_context_source, aligned = {**merged, "target": target}, "viewport_capture", True
        else:
            init_off = reading_context.get("reading", {}).get("offset") if isinstance(reading_context.get("reading"), dict) else None
            cap_off = capture_context.get("reading", {}).get("offset") if isinstance(capture_context.get("reading"), dict) else None
            if isinstance(init_off, (int, float)) and isinstance(cap_off, (int, float)):
                aligned = capture_context.get("contextRevisionMatches") is True and init_off == cap_off
    payload: dict[str, Any] = {"deviceId": "local", "target": target, "tabId": resolved_tab, "revision": revision, "quality": quality,
                               "readingContext": final_reading_context, "readingContextSource": reading_context_source,
                               **{k: v for k, v in (("readingContextAlignedWithCapture", aligned), ("captureContext", capture_context), ("imagePreview", preview_info)) if v is not None}}
    if len((text := json.dumps(payload, ensure_ascii=False, separators=(",", ":"))).encode("utf-8")) > 48 * 1024:
        raise AgentDocumentError("The current reading context exceeds the bounded response size")
    return ([image_block] if image_block is not None else []) + [TextContent(type="text", text=text)]


if __name__ in ("agent.mcp_live_helpers", "desktop.agent.mcp_live_helpers"):
    sys.modules.setdefault("agent.mcp_live_helpers", sys.modules[__name__])
    sys.modules.setdefault("desktop.agent.mcp_live_helpers", sys.modules[__name__])
