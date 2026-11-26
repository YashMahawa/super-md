"""MCP live-tab helper adapters, media block builders, and view_current runner."""
from __future__ import annotations

import base64
import inspect
import json
import sys
from collections.abc import Callable
from pathlib import Path
from typing import Any

_DESKTOP_DIR = str(Path(__file__).resolve().parents[1])
if _DESKTOP_DIR not in sys.path:
    sys.path.insert(0, _DESKTOP_DIR)

try:
    from .. import documents
    from ..agent_documents import AgentDocumentError, DocumentStore, RevisionConflict
except ImportError:
    import documents
    from agent_documents import AgentDocumentError, DocumentStore, RevisionConflict

from .context_normalizer import normalize_initial_reading_context, viewport_contexts
from .validators import (
    require_bool_flags,
    require_identifier,
    require_int_range,
    require_nonneg_int,
    require_sha256_revision,
    require_viewport_width,
)

LIVE_UNAVAILABLE_REASON = (
    "Live Agent Access is disabled or Super MD is not running. "
    "Ask the user to open Super MD and enable Live Agent Access in Settings → AI agents."
)


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
    result = live_call("outline_tab", tab_id, offset=offset, limit=limit)
    if not isinstance(result, dict):
        raise AgentDocumentError("Live bridge returned invalid outline metadata")
    headings = result.get("headings", result.get("outline"))
    if not isinstance(headings, list) or len(headings) > 5000:
        raise AgentDocumentError("Live bridge returned an invalid or oversized heading outline")
    return {
        "headings": headings, "revision": result.get("revision"),
        "sourceLength": result.get("sourceLength", result.get("documentLength", result.get("totalLength"))),
        "total": result.get("total", len(headings)), "offset": result.get("offset", offset),
        "nextOffset": result.get("nextOffset"), "truncated": result.get("truncated", False),
    }


def normalize_live_heading(item: dict[str, Any]) -> dict[str, Any]:
    start = item.get("start", item.get("offset", item.get("charOffset")))
    if not isinstance(start, int) or isinstance(start, bool) or start < 0:
        raise AgentDocumentError("Live outline entry is missing a valid character offset")
    level = item.get("level")
    if not isinstance(level, int) or isinstance(level, bool) or not 1 <= level <= 6:
        raise AgentDocumentError("Live outline entry is missing a valid heading level")
    return {"index": item.get("index", 0), "level": level,
            "title": str(item.get("title", ""))[:300], "line": item.get("line"), "start": start}


def read_live_tab(
    live_call: Callable[..., Any], tab_id: str, offset: int, limit: int, view: str,
    heading: int | str | None = None,
) -> dict[str, Any]:
    params: dict[str, Any] = {"offset": offset, "limit": limit, "view": view}
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
    if (not isinstance(start, int) or isinstance(start, bool) or start < 0
            or not isinstance(end, int) or isinstance(end, bool) or end < start):
        raise AgentDocumentError("Live bridge returned invalid source offsets")
    keys = ("revision", "id", "title", "path", "format", "isDirty",
            "heading", "sectionStart", "sectionEnd", "documentLength")
    response = {key: result[key] for key in keys if key in result}
    response.update({"start": start, "end": end, "markdown": markdown, "view": view, "returned_chars": len(markdown)})
    omissions = result.get("svg_omissions", result.get("omissions", []))
    if isinstance(omissions, list):
        response["svg_omissions"] = omissions[:20]
    total = result.get("totalLength", result.get("total_chars"))
    if isinstance(total, int) and not isinstance(total, bool) and total >= 0:
        total = result.get("total_chars", total)
        response["total_chars"] = total
        next_offset = result.get("next_offset", end if end < total else None)
        if next_offset is not None and (
            not isinstance(next_offset, int) or isinstance(next_offset, bool) or next_offset < end or next_offset > total
        ):
            raise AgentDocumentError("Live bridge returned an invalid next_offset")
        response["next_offset"] = next_offset
        response["truncated"] = next_offset is not None
    return response


def _wrap_raster_blocks(data: bytes, mime_type: str, metadata: dict[str, Any], *, prefix: str) -> list[Any]:
    from mcp.types import ImageContent, TextContent

    if not isinstance(data, bytes) or not data or len(data) > 8 * 1024 * 1024:
        raise AgentDocumentError("Image data must be non-empty and no larger than 8 MB")
    if mime_type == "image/png" and not data.startswith(b"\x89PNG\r\n\x1a\n"):
        raise AgentDocumentError(f"{prefix} not a PNG image")
    if mime_type == "image/jpeg" and not data.startswith(b"\xff\xd8\xff"):
        raise AgentDocumentError(f"{prefix} not a JPEG image")
    return [
        TextContent(type="text", text=json.dumps(metadata, ensure_ascii=False, separators=(",", ":"))),
        ImageContent(type="image", data=base64.b64encode(data).decode("ascii"), mime_type=mime_type),
    ]


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
    require_nonneg_int(offset, field="offset", error_cls=AgentDocumentError, message="SVG source offset must be nonnegative")
    require_int_range(limit, 1, 12_000, field="limit", error_cls=AgentDocumentError, message="SVG source limit must be 1–12000 characters")
    try:
        source = data.decode("utf-8")
    except UnicodeDecodeError as error:
        raise AgentDocumentError("SVG source must be valid UTF-8") from error
    if "<svg" not in source[:4096].lower():
        raise AgentDocumentError("Asset does not contain SVG source")
    page = source[offset:offset + limit]
    end = offset + len(page)
    return [TextContent(type="text", text=json.dumps({
        **metadata, "source": page, "offset": offset, "totalLength": len(source),
        "next_offset": end if end < len(source) else None, "truncated": end < len(source),
    }, ensure_ascii=False))]


def resolve_live_asset_path(store: DocumentStore, raw_path: str) -> str:
    if not isinstance(raw_path, str) or not 1 <= len(raw_path.strip()) <= 4096 or "\0" in raw_path:
        raise AgentDocumentError("asset_path must be a non-empty file path")
    expanded = Path(raw_path).expanduser()
    if not expanded.is_absolute() and any(
        part not in (".", "..") and part.startswith(".") for part in expanded.parts
    ):
        raise AgentDocumentError("Hidden files and directories are not allowed")
    if store.roots:
        try:
            return str(store.resolve(raw_path))
        except AgentDocumentError as error:
            if "outside the configured workspace roots" not in str(error):
                raise
    return str(expanded)


def run_view_current(
    live_client: Any, live_call: Callable[..., Any], *,
    path: str | None = None, tabId: str | None = None, deviceId: str | None = None,
    width: int | None = None, quality: str = "standard", includeImage: bool = True,
    include_image: bool | None = None,
) -> list[Any]:
    from mcp.types import ImageContent, TextContent

    if quality not in ("standard", "high"):
        raise AgentDocumentError("quality must be 'standard' or 'high'")
    want_image = includeImage if include_image is None else include_image
    require_bool_flags({"includeImage": want_image}, ("includeImage",), error_cls=AgentDocumentError)
    if width is not None:
        require_viewport_width(width, min_width=64, max_width=1600, error_cls=AgentDocumentError)
    if deviceId is not None:
        require_identifier(deviceId, field="deviceId", max_len=128, error_cls=AgentDocumentError,
                           message="deviceId must be a valid device identifier")
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
                  else valid_tabs[0] if len(active_tabs) == 0 and len(valid_tabs) == 1 else None)
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
    revision = require_sha256_revision(raw_context.get("revision"), error_cls=AgentDocumentError,
                                       message="The app returned invalid reading context for the selected tab")
    reading_context = normalize_initial_reading_context(raw_context, resolved_tab=resolved_tab, target=target)
    image_block = preview_info = capture_context = aligned = None
    final_reading_context, reading_context_source = reading_context, "context_read"

    if want_image:
        edge = width if width is not None else (1600 if quality == "high" else 1000)
        desired_format = "png" if quality == "high" else "jpeg"
        render_cb = getattr(live_client, "render_tab", None)
        supports_format = False
        if callable(render_cb):
            try:
                params = inspect.signature(render_cb).parameters
                supports_format = "image_format" in params or any(
                    p.kind == inspect.Parameter.VAR_KEYWORD for p in params.values())
            except (TypeError, ValueError):
                supports_format = False
        image = (live_call("render_tab", resolved_tab, width=edge, image_format=desired_format)
                 if supports_format else live_call("render_tab", resolved_tab, width=edge))
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
        mime_type, raw_bytes = image.get("mime_type", ""), image.get("data")
        verified_blocks = as_image_blocks(raw_bytes, mime_type, {"revision": revision})
        image_block = next(block for block in verified_blocks if isinstance(block, ImageContent))
        preview_info = {
            "mimeType": mime_type, "byteLength": len(raw_bytes),
            "width": rendered_width, "height": rendered_height, "previewOnly": mime_type == "image/jpeg",
        }
        capture_context, captured_reading = viewport_contexts(image, resolved_tab, revision)
        if captured_reading is not None:
            merged_reading = (
                {**captured_reading, "properties": reading_context["properties"]}
                if "properties" in reading_context and "properties" not in captured_reading
                else captured_reading
            )
            final_reading_context, reading_context_source, aligned = {**merged_reading, "target": target}, "viewport_capture", True
        else:
            init_offset = reading_context.get("reading", {}).get("offset") if isinstance(reading_context.get("reading"), dict) else None
            cap_offset = capture_context.get("reading", {}).get("offset") if isinstance(capture_context.get("reading"), dict) else None
            if isinstance(init_offset, (int, float)) and isinstance(cap_offset, (int, float)):
                aligned = capture_context.get("contextRevisionMatches") is True and init_offset == cap_offset

    payload: dict[str, Any] = {
        "deviceId": "local", "target": target, "tabId": resolved_tab, "revision": revision,
        "quality": quality, "readingContext": final_reading_context, "readingContextSource": reading_context_source,
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


if __name__ in ("agent.mcp_live_helpers", "desktop.agent.mcp_live_helpers"):
    sys.modules.setdefault("agent.mcp_live_helpers", sys.modules[__name__])
    sys.modules.setdefault("desktop.agent.mcp_live_helpers", sys.modules[__name__])
