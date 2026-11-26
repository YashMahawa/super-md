"""Qt-free payload validation and native tab execution helpers for the live bridge."""
from __future__ import annotations

import base64
import hashlib
import importlib
import json
from collections.abc import Callable
from typing import Any

try:
    from . import live_client as _lc
    from . import validators as _v
except ImportError:
    from agent import live_client as _lc
    from agent import validators as _v

LIVE_GUI_ACTIONS = frozenset({
    "list_tabs", "read_tab", "search_tab", "outline_tab", "patch_tab", "render_tab", "get_tab_image",
    "get_diagram_image", "get_context", "latex_review", "latex_apply", "export_document", "create_document",
    "save_document", "open_document", "activate_document", "close_document", "job_status", "export_chunk",
    "list_diagrams", "get_diagram", "replace_tab_asset", "asset_action",
})
_SUPPORTED_INLINE_MIMES = frozenset({"image/png", "image/jpeg", "image/gif", "image/webp", "image/avif", "image/svg+xml"})


def _agent_docs():
    parent = __package__.rpartition(".")[0] if __package__ else ""
    return importlib.import_module(f"{parent}.agent_documents" if parent else "agent_documents")


def _image_data_fn():
    parent = __package__.rpartition(".")[0] if __package__ else ""
    return importlib.import_module(f"{parent}.documents" if parent else "documents").image_data


def _conflict_error(revision: str, source: str) -> str:
    return json.dumps({"error": "Revision conflict; inspect the current note before retrying",
                       "currentRevision": revision, "sourceLength": len(source)})


def validate_live_gui_payload(payload: dict[str, Any]) -> str:
    """Validate an incoming GUI bridge request payload before queuing Qt dispatch."""
    action = payload.get("action")
    if action not in LIVE_GUI_ACTIONS:
        raise ValueError("Unsupported live-tab operation")
    if action not in ("list_tabs", "create_document", "open_document", "job_status", "export_chunk"):
        _v.require_identifier(payload.get("tabId"), field="tabId")
    if action == "create_document":
        content, title = payload.get("content", ""), payload.get("title", "")
        if not isinstance(content, str) or len(content.encode("utf-8")) > 20_000_000:
            raise ValueError("New document content must be under 20 MB")
        if not isinstance(title, str) or len(title) > 160 or any(c in title for c in ("/", "\\", "\0")):
            raise ValueError("title must be a short filename")
        _v.require_export_params(payload.get("format", "md"), filename=payload.get("filename", ""),
                                 allowed_formats=("md", "smd"), require_safe_basename=True)
    elif action == "save_document":
        _v.require_sha256_revision(payload.get("expectedRevision"), field="expectedRevision", hex_only=False)
        _v.require_export_params(payload.get("format", "md"), allowed_formats=("md", "smd"))
    elif action == "open_document":
        filename = payload.get("filename")
        if not isinstance(filename, str) or len(filename) > 4096 or "\0" in filename:
            raise ValueError("filename must identify an approved note path or be empty to activate a listed tab")
        if not filename and not payload.get("tabId"):
            raise ValueError("An empty filename requires a listed live tab target")
    elif action == "close_document":
        _v.require_sha256_revision(payload.get("expectedRevision"), field="expectedRevision")
    _v.require_bool_flags(payload, ("background", "saveAs", "discardChanges"))
    if action in ("job_status", "export_chunk"):
        _v.require_identifier(payload.get("jobId"), field="jobId")
        if action == "export_chunk":
            _v.require_nonneg_int(payload.get("offset", 0), message="offset must be a nonnegative byte offset")
            _v.require_int_range(payload.get("limit", 262_144), 1, _lc.MAX_EXPORT_CHUNK_BYTES,
                                 message="limit must be between 1 and 524,288 bytes")
    if action == "read_tab":
        _v.require_nonneg_int(payload.get("offset", 0))
        _v.require_int_range(payload.get("limit", _lc.MAX_SOURCE_PAGE), 1, _lc.MAX_SOURCE_PAGE)
        _v.require_nonneg_int(payload.get("assetOffset", 0), field="assetOffset")
        _v.require_int_range(payload.get("assetLimit", 0), 0, 50, field="assetLimit")
        if payload.get("view", "prose") not in ("prose", "source"):
            raise ValueError("view must be prose or source")
        _v.require_heading_selector(payload.get("heading"))
    elif action == "search_tab":
        _v.require_search_params(payload.get("query"), payload.get("limit", 10),
                                 payload.get("context", 100), payload.get("offset", 0))
        _v.require_bool_flags(payload, ("caseSensitive", "wholeWord", "regex", "excludeDiagrams"))
    elif action == "outline_tab":
        _v.require_nonneg_int(payload.get("offset", 0))
        _v.require_int_range(payload.get("limit", 80), 1, 80)
    elif action == "patch_tab":
        _v.require_sha256_revision(payload.get("expectedRevision"), field="expectedRevision")
        operations = payload.get("operations")
        _agent_docs().validate_patch_operations(operations)
        if len(json.dumps(operations, ensure_ascii=False).encode("utf-8")) > _lc.MAX_PATCH_BYTES:
            raise ValueError("Patch operations exceed the 64 KB limit")
    elif action in ("render_tab", "get_diagram_image"):
        if action == "render_tab":
            _v.require_viewport_width(payload.get("width", 1600))
        _v.require_image_format(payload.get("imageFormat", "png"), field="imageFormat")
    elif action == "get_tab_image":
        _v.require_identifier(payload.get("assetName"), field="assetName", max_len=256)
        _v.require_sha256_revision(payload.get("expectedRevision"), field="expectedRevision")
    if action in ("get_diagram", "get_diagram_image"):
        _v.require_diagram_id(payload.get("diagramId"))
        _v.require_sha256_revision(payload.get("expectedRevision"), field="expectedRevision")
        if action == "get_diagram":
            _v.require_nonneg_int(payload.get("offset", 0))
            _v.require_int_range(payload.get("limit", _lc.MAX_SOURCE_PAGE), 1, _lc.MAX_SOURCE_PAGE)
    elif action == "list_diagrams":
        _v.require_optional_sha256_revision(payload.get("expectedRevision"), field="expectedRevision")
        _v.require_nonneg_int(payload.get("offset", 0), field="diagram offset")
        _v.require_int_range(payload.get("limit", 80), 1, 80, field="diagram limit")
    elif action == "replace_tab_asset":
        if not isinstance(payload.get("assetName"), str) or not isinstance(payload.get("assetPath"), str):
            raise ValueError("assetName and assetPath are required")
        _v.require_sha256_revision(payload.get("expectedRevision"), field="expectedRevision")
    elif action == "asset_action":
        if payload.get("assetAction") not in ("list", "source", "attach"):
            raise ValueError("assetAction must be list, source, or attach")
        _v.require_sha256_revision(payload.get("expectedRevision"), field="expectedRevision")
        kind, name = payload["assetAction"], payload.get("assetName")
        if (kind in ("source", "attach")
                and (not isinstance(name, str) or not name or len(name.encode("utf-8")) > 256)
                and not (kind == "attach" and isinstance(payload.get("assetPath"), str) and payload.get("assetPath"))):
            raise ValueError("assetName is required")
        if kind == "attach":
            inline = isinstance(payload.get("body"), str)
            local_path = isinstance(payload.get("assetPath"), str) and bool(payload.get("assetPath"))
            if inline == local_path:
                raise ValueError("Attach exactly one of base64 body or local assetPath")
            if inline and payload.get("mimeType") not in _SUPPORTED_INLINE_MIMES:
                raise ValueError("Attaching an asset requires a supported image mimeType")
            if inline and len(payload["body"]) > 1_400_000:
                raise ValueError("Asset body must be at most 1 MiB")
            if local_path and len(payload["assetPath"]) > 4096:
                raise ValueError("Asset path is too long")
        if kind == "list":
            _v.require_nonneg_int(payload.get("offset", 0), max_value=512)
            _v.require_int_range(payload.get("limit", 50), 1, 50)
    elif action == "get_context":
        _v.require_int_range(payload.get("limit", 6000), 1, _lc.MAX_SOURCE_PAGE)
    elif action == "latex_apply":
        _v.require_sha256_revision(payload.get("expectedRevision"), field="expectedRevision")
        _v.require_repair_indices(payload.get("repairIndices"), field="repairIndices")
    elif action == "export_document":
        _v.require_export_params(payload.get("format"), options=payload.get("options", {}),
                                 filename=payload.get("filename", ""), require_safe_basename=True)
        _v.require_sha256_revision(payload.get("expectedRevision"), field="expectedRevision")
    return action


def asset_metadata(tab: dict[str, Any], offset: int = 0, limit: int = 50) -> list[dict[str, Any]]:
    try:
        return _agent_docs()._asset_metadata(tab.get("assets", {}), offset=offset, limit=limit)
    except Exception:  # noqa: BLE001
        return []


def asset_action_native(args: dict[str, Any], studio, *,
                        metadata_fn: Callable[[dict[str, Any], int, int], list[dict[str, Any]]] = asset_metadata) -> dict[str, Any]:
    tab_id = args.get("tabId")
    tab = next((item for item in studio.tabs if item["id"] == tab_id), None)
    if tab is None:
        raise ValueError("The requested live tab is no longer open")
    revision = hashlib.sha256(tab["content"].encode("utf-8")).hexdigest()
    if args.get("expectedRevision") != revision:
        raise ValueError("Live tab revision changed; inspect it again before using an asset")
    assets, action = tab.get("assets", {}), args.get("assetAction")
    try:
        image_data = _image_data_fn()
    except ImportError as error:
        raise ValueError("Portable asset handling is unavailable") from error
    if action == "list":
        offset, limit = args.get("offset", 0), args.get("limit", 50)
        page = [{"id": i.get("id"), "name": i.get("name"), "mimeType": i.get("mime"), "bytes": i.get("bytes"),
                 "sha256": i.get("sha256"), **({"invalid": True} if i.get("invalid") else {})}
                for i in metadata_fn(tab, offset, limit)]
        total = len(assets)
        return {"tabId": tab_id, "revision": revision, "assets": page, "total": total,
                "nextOffset": offset + len(page) if offset + len(page) < total else None}
    if action == "source":
        val = args.get("assetName", "")
        prefixed = val if val.startswith("assets/") else "assets/" + val
        name = val if val in assets else (
            prefixed if prefixed in assets else next((k for k in assets if hashlib.sha256(k.encode("utf-8")).hexdigest() == val), ""))
        if not name:
            raise ValueError("Asset is not present in the current note")
        try:
            mime, raw = image_data(assets[name])
        except (ValueError, TypeError) as error:
            raise ValueError("The embedded image is invalid") from error
        if not 1 <= len(raw) <= _lc.MAX_RELAY_ASSET_BYTES:
            raise ValueError("Original asset retrieval is limited to 1 MiB")
        return {"tabId": tab_id, "revision": revision, "assetName": name, "mimeType": mime,
                "bytes": len(raw), "sha256": hashlib.sha256(raw).hexdigest(), "body": base64.b64encode(raw).decode("ascii")}
    if action != "attach":
        raise ValueError("Unsupported asset action")
    return studio._agent_document_action(args)


def is_async_native_action(payload: dict[str, Any]) -> bool:
    action = payload.get("action")
    return action in ("save_document", "replace_tab_asset") or (action == "asset_action" and payload.get("assetAction") == "attach")


def verify_native_write_revision(payload: dict[str, Any], studio) -> None:
    target = next((tab for tab in studio.tabs if tab["id"] == payload.get("tabId")), None)
    if target is None:
        raise ValueError("The requested live tab is no longer open")
    source = target["content"]
    current_revision = hashlib.sha256(source.encode("utf-8")).hexdigest()
    expected = payload.get("expectedRevision")
    if payload.get("action") == "asset_action":
        if expected != current_revision:
            raise ValueError("Live tab revision changed; inspect it again before using an asset")
        return
    if expected is not None and expected != current_revision:
        raise ValueError(_conflict_error(current_revision, source))


def _read_tab_page(source: str, payload: dict[str, Any]) -> dict[str, Any]:
    offset, limit = payload.get("offset", 0), payload.get("limit", _lc.MAX_SOURCE_PAGE)
    heading, view = payload.get("heading"), payload.get("view", "prose")
    try:
        docs = _agent_docs()
    except ImportError:
        docs = None
    read_source = getattr(docs, "read_source", None)
    if callable(read_source):
        try:
            return read_source(source, offset=offset, limit=limit, heading=heading, view=view)
        except docs.AgentDocumentError as exc:
            raise ValueError(str(exc)) from exc
    if offset > len(source):
        raise ValueError("offset must be between 0 and the document character count")
    section_start, section_end, selected_heading, spans = 0, len(source), None, None
    if heading is not None:
        if docs is None:
            raise ValueError("Heading outlines are unavailable")
        try:
            headings, precomputed = docs._read_headings_and_svg_spans(source, include_headings=True, include_svg=view == "prose")
            selected_heading = docs.resolve_heading(headings, heading)
        except docs.AgentDocumentError as exc:
            raise ValueError(str(exc)) from exc
        section_start, section_end = selected_heading["sectionStart"], selected_heading["sectionEnd"]
        if offset > section_end:
            raise ValueError(f"offset must be within the selected section (sectionEnd {section_end})")
        offset, spans = max(section_start, offset), (precomputed if view == "prose" else None)
    end, omitted = min(section_end, offset + limit), []
    if view == "prose" and docs is not None:
        try:
            spans = docs._svg_spans(source) if spans is None else spans
            end = docs._prose_page_end(offset, limit, section_end, spans)
            page_text, omitted = docs._elide_svg_page(source, offset, end, spans)
        except Exception:  # noqa: BLE001
            page_text = source[offset:end]
    else:
        page_text = source[offset:end]
    page: dict[str, Any] = {
        "start": offset, "end": end, "total_chars": section_end - section_start, "truncated": end < section_end,
        "next_offset": end if end < section_end else None, "view": view, "text": page_text, "returned_chars": len(page_text),
        "svg_omissions": omitted, "sectionStart": section_start, "sectionEnd": section_end, "documentLength": len(source),
    }
    if selected_heading is not None:
        page["heading"] = {key: selected_heading[key] for key in ("index", "level", "title", "line")}
    return page


def native_result(payload: dict[str, Any], studio, *,
                  metadata_fn: Callable[[dict[str, Any], int, int], list[dict[str, Any]]] = asset_metadata,
                  asset_action_fn: Callable[[dict[str, Any], Any], dict[str, Any]] | None = None) -> dict[str, Any]:
    action = payload["action"]
    if action == "asset_action":
        return asset_action_fn(payload, studio) if asset_action_fn else asset_action_native(payload, studio, metadata_fn=metadata_fn)
    if action in ("create_document", "save_document", "open_document", "activate_document",
                  "close_document", "patch_tab", "replace_tab_asset"):
        if action in ("save_document", "close_document", "patch_tab", "replace_tab_asset"):
            verify_native_write_revision(payload, studio)
        return studio._agent_document_action(payload)
    tab_id = payload["tabId"]
    target = next((tab for tab in studio.tabs if tab["id"] == tab_id), None)
    if target is None:
        raise ValueError("The requested live tab is no longer open")
    source = target["content"]
    revision = hashlib.sha256(source.encode("utf-8")).hexdigest()
    if payload.get("expectedRevision") is not None and payload["expectedRevision"] != revision:
        raise ValueError(_conflict_error(revision, source))
    common = {
        "tabId": tab_id, "windowId": studio.window_id, "revision": revision, "sourceLength": len(source),
        "title": target["name"], "path": target["path"], "isDirty": target["content"] != target["saved"],
        "format": "smd" if target.get("portable") or str(target["path"]).lower().endswith(".smd") else "markdown",
    }
    if action == "read_tab":
        page = _read_tab_page(source, payload)
        asset_offset, asset_limit = payload.get("assetOffset", 0), payload.get("assetLimit", 0)
        assets = metadata_fn(target, asset_offset, asset_limit) if asset_limit else []
        asset_count = len(target.get("assets", {}))
        result = {**common, "offset": page["start"], "markdown": page["text"], "omissions": page["svg_omissions"],
                  "totalLength": page["documentLength"], **page, "assetCount": asset_count}
        if asset_limit:
            result.update(assets=assets, assetsNextOffset=asset_offset + len(assets) if asset_offset + len(assets) < asset_count else None)
        return result
    if action == "search_tab":
        return {**common, **_agent_docs().search_source(
            source, payload["query"], limit=payload.get("limit", 10), context=payload.get("context", 100), offset=payload.get("offset", 0),
            case_sensitive=payload.get("caseSensitive", False), whole_word=payload.get("wholeWord", False),
            regex=payload.get("regex", False), exclude_diagrams=payload.get("excludeDiagrams", False))}
    if action == "outline_tab":
        return {**common, **_agent_docs().outline_source(source, payload.get("offset", 0), payload.get("limit", 80))}
    if action == "get_tab_image":
        if payload["expectedRevision"] != revision:
            raise ValueError("Live tab revision changed; inspect again before extracting the image")
        assets, asset_name = target.get("assets", {}), payload["assetName"]
        if asset_name not in assets:
            raise ValueError("Asset not found; list exact names with document_assets")
        try:
            mime_type, data = _image_data_fn()(assets[asset_name])
        except (ValueError, TypeError, KeyError, ImportError) as error:
            raise ValueError("The selected asset is invalid") from error
        if not data or len(data) > 8 * 1024 * 1024:
            raise ValueError("Live asset images are limited to 8 MB")
        return {**common, "asset": asset_name, "mime_type": mime_type, "bytes": len(data),
                "sha256": hashlib.sha256(data).hexdigest(), "data": base64.b64encode(data).decode("ascii")}
    raise ValueError("Unsupported native live-tab operation")


def finalize_renderer_result(payload: dict[str, Any], result: Any, error: str, studio, window_id: str) -> tuple[Any, str]:
    tab_id, expected = payload.get("tabId"), payload.get("expectedRevision")
    target = next((tab for tab in studio.tabs if tab["id"] == tab_id), None) if studio else None
    current_rev = hashlib.sha256(target["content"].encode("utf-8")).hexdigest() if target is not None else ""
    if payload.get("action") == "patch_tab":
        if not error:
            if target is None or not isinstance(result, dict):
                error = "The requested live tab is no longer open"
            elif result.get("revision") != current_rev:
                error = _conflict_error(current_rev, target["content"])
            else:
                ops = {"operation_results": result["operations"]} if "operations" in result else {}
                result = {"tabId": tab_id, "windowId": window_id, **ops, **result, "sourceLength": len(target["content"])}
        elif target is not None and expected != current_rev:
            error = _conflict_error(current_rev, target["content"])
    if not error and payload.get("action") in ("list_diagrams", "get_diagram", "get_diagram_image"):
        if target is None:
            error = "The requested live tab is no longer open"
        elif not isinstance(result, dict):
            error = "Diagram handler returned an invalid result"
        elif result.get("revision") != current_rev or (expected and expected != current_rev):
            error = "Live tab changed while its diagrams were being read; inspect again"
    return result, error
