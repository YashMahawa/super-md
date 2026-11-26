"""MCP tool definitions and shared DocumentStore/live-tab registration."""
from __future__ import annotations

import base64
import sys
from pathlib import Path
from typing import Any

_DESKTOP_DIR = str(Path(__file__).resolve().parents[1])
if _DESKTOP_DIR not in sys.path:
    sys.path.insert(0, _DESKTOP_DIR)

try:
    from .. import agent_documents as _ad
except ImportError:
    import agent_documents as _ad

from . import mcp_live_helpers as _lh
from . import validators as _v
from .context_normalizer import bounded_properties

AgentDocumentError, DocumentStore, RevisionConflict = _ad.AgentDocumentError, _ad.DocumentStore, _ad.RevisionConflict
sys.modules.setdefault("agent.validators", _v)
sys.modules.setdefault("desktop.agent.validators", _v)
_ASSET_KEYS = ("id", "name", "mime", "mime_type", "bytes", "sha256")


def _pick(data: dict[str, Any], keys: tuple[str, ...]) -> dict[str, Any]:
    return {k: data[k] for k in keys if k in data}


def _require_safe_basename(filename: Any, *, message: str) -> None:
    if filename is not None and (not isinstance(filename, str) or not filename or len(filename) > 160
                                 or Path(filename).name != filename or filename in (".", "..") or "\0" in filename):
        raise AgentDocumentError(message)


def _require_live_tab(path: str | None, message: str) -> str:
    if (tab_id := _lh.live_id(path) if path is not None else None) is None:
        raise AgentDocumentError(message)
    return tab_id


def _require_page(offset: int, limit: int, max_limit: int, message: str, *, max_offset: int | None = None) -> None:
    _v.require_nonneg_int(offset, field="offset", max_value=max_offset, error_cls=AgentDocumentError, message=message)
    _v.require_int_range(limit, 1, max_limit, field="limit", error_cls=AgentDocumentError, message=message)


def build_mcp_server(roots: list[str], live_client=None):
    """Create the SDK server and its single shared, root-restricted operation layer."""
    from mcp.server import MCPServer
    from mcp.types import ImageContent

    store = DocumentStore(roots, allow_empty=live_client is not None)
    server = MCPServer("Super MD", instructions=("Use bounded reads and search before editing. Every edit requires the current SHA-256 revision; "
                                                 "inspect again after a revision conflict."))
    live_call = _lh.make_live_caller(live_client)

    def _call_dict(method: str, *args: Any, _error: str, **kwargs: Any) -> dict[str, Any]:
        if not isinstance(result := live_call(method, *args, **kwargs), dict):
            raise AgentDocumentError(_error)
        return result

    @server.tool()
    def list_sessions() -> dict[str, Any]:
        """List currently open desktop tabs, including unsaved source and revision IDs."""
        if live_client is None:
            return {"sessions": [], "count": 0, "available": False, "reason": _lh.LIVE_UNAVAILABLE_REASON}
        response = live_call("list_tabs")
        if not isinstance(tabs := response.get("tabs", response.get("sessions", [])) if isinstance(response, dict) else response, list) or len(tabs) > 200:
            raise AgentDocumentError("Live bridge returned an invalid or oversized tab list")
        sessions = [
            {"id": (tid := str(t["id"])[:300]), "target": f"tab:{tid}",
             **{k: t[k][:m] for k, m in (("windowId", 128), ("title", 200), ("path", 300), ("format", 24), ("revision", 64)) if isinstance(t.get(k), str)},
             **{k: t[k] for k in ("isDirty", "active") if isinstance(t.get(k), bool)},
             **({"sourceLength": t["sourceLength"]} if isinstance(t.get("sourceLength"), int) else {})}
            for t in tabs if isinstance(t, dict) and t.get("id")
        ]
        available = response["available"] if isinstance(response, dict) and isinstance(response.get("available"), bool) else bool(sessions)
        result: dict[str, Any] = {"sessions": sessions[:32], "count": len(sessions), "truncated": len(sessions) > 32, "available": available}
        if not available:
            reason = response.get("reason") if isinstance(response, dict) and isinstance(response.get("reason"), str) else ""
            result["reason"] = reason[:500] if reason else _lh.LIVE_UNAVAILABLE_REASON
        return result

    @server.tool()
    def document_inspect(path: str) -> dict[str, Any]:
        """Return a document digest, bounded heading outline, and asset metadata."""
        if (tab_id := _lh.live_id(path)) is None:
            return store.inspect(path)
        result = _call_dict("read_tab", tab_id, offset=0, limit=1, _error="Live bridge returned invalid tab metadata")
        outline = _lh.live_outline(live_call, tab_id)
        if result.get("revision") and outline.get("revision") and result["revision"] != outline["revision"]:
            raise RevisionConflict("The open note changed while its outline was being read; inspect again")
        metadata = _pick(result, ("id", "windowId", "title", "path", "format", "isDirty", "sourceLength", "revision", "outline", "outline_truncated", "assets", "asset_count"))
        if (live_props := bounded_properties(result.get("properties"))) is not None:
            metadata["properties"] = live_props
        headings = outline["headings"]
        metadata.update({"outline": [_lh.normalize_live_heading(i) for i in headings[:80] if isinstance(i, dict)],
                         "outline_truncated": outline["truncated"] or len(headings) > 80, "heading_count": outline["total"], "target": path})
        if isinstance(metadata.get("assets"), list):
            metadata["assets"] = [_pick(item, _ASSET_KEYS) for item in metadata["assets"][:40] if isinstance(item, dict)]
        elif isinstance(asset_page := live_call("read_tab", tab_id, offset=0, limit=1, asset_offset=0, asset_limit=40), dict):
            if result.get("revision") and asset_page.get("revision") and result["revision"] != asset_page["revision"]:
                raise RevisionConflict("The open note changed while its assets were being read; inspect again")
            if isinstance(raw_assets := asset_page.get("assets", []), list):
                metadata["assets"] = [_pick(item, _ASSET_KEYS) for item in raw_assets[:40] if isinstance(item, dict)]
            metadata["asset_count"] = asset_page.get("assetCount", len(metadata.get("assets", [])))
        return _lh.bounded_result(metadata)

    @server.tool()
    def document_read(path: str, offset: int = 0, limit: int = 12000, heading: int | str | None = None, view: str = "prose") -> dict[str, Any]:
        """Read a bounded source page; fenced SVG bodies are elided unless view='source'."""
        if view not in ("prose", "source"):
            raise AgentDocumentError("view must be 'prose' or 'source'")
        if (tab_id := _lh.live_id(path)) is None:
            return store.read(path, offset=offset, limit=limit, heading=heading, view=view)
        _require_page(offset, limit, 12_000, "limit must be 1–12,000 and offset must be nonnegative")
        _v.require_heading_selector(heading, error_cls=AgentDocumentError)
        return _lh.bounded_result({**_lh.read_live_tab(live_call, tab_id, offset, limit, view, heading=heading), "target": path})

    @server.tool()
    def document_search(path: str, query: str, limit: int = 10, context: int = 100, offset: int = 0,
                        case_sensitive: bool = False, whole_word: bool = False, regex: bool = False,
                        exclude_diagrams: bool = False) -> dict[str, Any]:
        """Find paginated source matches with optional word, case, regex and diagram filters."""
        tab_id = _lh.live_id(path)
        if tab_id is None:
            return store.search(
                path,
                query,
                limit=limit,
                offset=offset,
                context=context,
                case_sensitive=case_sensitive,
                whole_word=whole_word,
                regex=regex,
                exclude_diagrams=exclude_diagrams,
            )
        flags = (("case_sensitive", case_sensitive), ("whole_word", whole_word), ("regex", regex), ("exclude_diagrams", exclude_diagrams))
        try:
            _v.require_search_params(query, limit, context, offset, max_offset=20_000_000, flags=flags, error_cls=AgentDocumentError)
        except AgentDocumentError as exc:
            raise AgentDocumentError("query, limit, context, offset, or search flags are invalid") from exc
        result = live_call("search_tab", tab_id, query=query, limit=limit, context=context, offset=offset,
                           case_sensitive=case_sensitive, whole_word=whole_word, regex=regex, exclude_diagrams=exclude_diagrams)
        if not isinstance(result, dict) or not isinstance(result.get("matches"), list):
            raise AgentDocumentError("Live bridge returned invalid search results")
        mkeys = ("offset", "line", "start", "end", "snippet", "matchOffset", "matchLength", "snippetOffset")
        clean_matches = []
        for item in result["matches"][:limit]:
            if isinstance(item, dict):
                match = _pick(item, mkeys)
                if isinstance(snip := match.get("snippet", item.get("text")), str):
                    match["snippet"] = snip[:1100]
                clean_matches.append(match)
        return _lh.bounded_result({**result, "matches": clean_matches, "target": path})

    @server.tool()
    def document_action(action: str, path: str | None = None, content: str | None = None, title: str | None = None,
                        output_path: str | None = None, filename: str | None = None, format: str | None = None,
                        options: dict[str, Any] | None = None, background: bool = False, save_as: bool = False,
                        discard_changes: bool = False, expected_revision: str | None = None,
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
            _require_safe_basename(filename, message="filename must be a safe naming hint")
            fmt = ("smd" if Path(title or filename or "").suffix.lower() == ".smd" else "md") if format is None else format
            _v.require_bool_flags({"background": background}, ("background",), error_cls=AgentDocumentError)
            return _lh.bounded_result(_call_dict("document_action", None, "create_document", content=content, title=title or "",
                                                 filename=filename or "", format=fmt, background=background, device_id=device_id,
                                                 _error="Desktop returned invalid created-tab metadata"))
        if action == "save_document":
            tab_id = _require_live_tab(path, "save_document requires a current tab target")
            _v.require_sha256_revision(expected_revision, error_cls=AgentDocumentError, message="save_document requires expected_revision from document_inspect")
            if format is not None and format not in ("md", "smd"):
                raise AgentDocumentError("format must be md or smd")
            if title:
                raise AgentDocumentError("Use filename for save_document; title applies to create_document")
            _require_safe_basename(filename, message="filename must be a safe basename")
            _v.require_bool_flags({"save_as": save_as}, ("save_as",), error_cls=AgentDocumentError)
            return _lh.bounded_result(_call_dict("document_action", tab_id, "save_document", expected_revision=expected_revision,
                                                 filename=filename or "", format=format, save_as=save_as, _error="Desktop returned invalid save status"))
        if action == "open_document":
            if live_client is None:
                raise AgentDocumentError("open_document requires a live desktop session")
            _v.require_bool_flags({"background": background}, ("background",), error_cls=AgentDocumentError)
            if path and _lh.live_id(path) is not None:
                return _lh.bounded_result({**_call_dict("document_action", _lh.live_id(path), "open_document", background=background, _error="Desktop returned invalid open status"), "target": path, "opened": True})
            if not isinstance(fname := path if filename is None and path is not None else filename, str) or not fname or len(fname) > 4096 or "\0" in fname:
                raise AgentDocumentError("open_document requires a bounded path, basename, or open tab target")
            return _lh.bounded_result(_call_dict("document_action", None, "open_document", filename=fname, background=background, device_id=device_id, _error="Desktop returned invalid open status"))
        if action == "activate_document":
            return _lh.bounded_result({**_call_dict("document_action", _require_live_tab(path, "activate_document requires an open desktop tab target"), "activate_document", _error="Desktop returned invalid activation metadata"), "target": path})
        if action == "close_document":
            tab_id = _require_live_tab(path, "close_document requires an open desktop tab target")
            _v.require_sha256_revision(expected_revision, error_cls=AgentDocumentError, message="close_document requires expected_revision from document_inspect")
            _v.require_bool_flags({"discard_changes": discard_changes}, ("discard_changes",), error_cls=AgentDocumentError)
            return _lh.bounded_result({**_call_dict("document_action", tab_id, "close_document", expected_revision=expected_revision, discard_changes=discard_changes, _error="Desktop returned invalid close status"), "target": path})
        if action in ("export", "export_document"):
            if path is None or format not in ("pdf", "smd", "md"):
                raise AgentDocumentError("export requires a source path and format pdf, smd, or md")
            if (tab_id := _lh.live_id(path)) is not None:
                _v.require_sha256_revision(expected_revision, error_cls=AgentDocumentError, message="Live export requires expected_revision from document_inspect")
                try:
                    _v.require_export_params(format, options=options, error_cls=AgentDocumentError)
                except AgentDocumentError as exc:
                    raise (AgentDocumentError("Export options must be an object no larger than 8 KB") if "smaller than 8 KB" in str(exc) else exc) from exc
                if format != "pdf" and options:
                    raise AgentDocumentError("PDF options apply only to PDF export")
                _require_safe_basename(filename, message="filename must be a safe basename")
                res = _call_dict("document_action", tab_id, "export_document", format=format, options=options, expected_revision=expected_revision, filename=filename, _error="Live export returned invalid status")
                return _lh.bounded_result(_pick(res, ("jobId", "status", "filename", "format", "bytes", "sha256", "path")))
            if output_path is None:
                raise AgentDocumentError("Filesystem export requires output_path inside an allowed root")
            if format != "pdf" and options:
                raise AgentDocumentError("PDF options apply only to PDF export")
            try:
                from ..agent_exports import export_pdf, export_smd
            except ImportError:
                from agent_exports import export_pdf, export_smd
            return export_pdf(store, path, output_path, options=options) if format == "pdf" else (export_smd(store, path, output_path) if format == "smd" else store.create(output_path, store.read_markdown(path)))
        if action == "job_status":
            _v.require_identifier(job_id, field="job_id", max_len=300, error_cls=AgentDocumentError, message="job_status requires a live jobId")
            return _lh.bounded_result(_call_dict("document_action", None, "job_status", job_id=job_id, _error="Desktop returned invalid export job status"))
        if action == "list_diagrams":
            tab_id, dlimit = _require_live_tab(path, "list_diagrams requires an open desktop tab target"), (80 if limit is None else limit)
            _require_page(offset, dlimit, 80, "diagram offset must be nonnegative and limit must be 1–80", max_offset=20_000_000)
            _v.require_optional_sha256_revision(expected_revision, error_cls=AgentDocumentError, message="list_diagrams expected_revision must be a SHA-256 revision")
            if not isinstance(result := live_call("document_action", tab_id, "list_diagrams", expected_revision=expected_revision, offset=offset, limit=dlimit), dict) or not isinstance(result.get("diagrams"), list):
                raise AgentDocumentError("Desktop returned invalid diagram metadata")
            return _lh.bounded_result({**result, "target": path})
        if action == "outline":
            tab_id, olimit = _require_live_tab(path, "outline requires an open desktop tab target"), (80 if limit is None else limit)
            _require_page(offset, olimit, 80, "outline offset must be nonnegative and limit must be 1–80", max_offset=20_000_000)
            if not isinstance(result := live_call("outline_tab", tab_id, offset=offset, limit=olimit), dict) or not isinstance(result.get("headings"), list):
                raise AgentDocumentError("Desktop returned invalid outline metadata")
            return _lh.bounded_result({**result, "target": path})
        if action == "get_diagram":
            tab_id, dlimit = _require_live_tab(path, "get_diagram requires an open desktop tab target"), (12_000 if limit is None else limit)
            _v.require_diagram_id(diagram_id, max_len=200, require_prefix=False, error_cls=AgentDocumentError, message="diagram_id must come from list_diagrams")
            _v.require_sha256_revision(expected_revision, error_cls=AgentDocumentError, message="get_diagram requires expected_revision from list_diagrams or document_inspect")
            _require_page(offset, dlimit, 12_000, "diagram offset must be nonnegative and limit must be 1–12,000", max_offset=20_000_000)
            return _lh.bounded_result({**_call_dict("document_action", tab_id, "get_diagram", diagram_id=diagram_id, expected_revision=expected_revision, offset=offset, limit=dlimit, _error="Desktop returned invalid diagram source"), "target": path}, 64_000)
        if action in ("get_context", "latex_review", "latex_apply"):
            tab_id, params = _require_live_tab(path, f"{action} is available for open desktop tabs only"), {}
            if action == "latex_apply":
                _v.require_sha256_revision(expected_revision, error_cls=AgentDocumentError, message="latex_apply requires expected_revision from latex_review")
                if not isinstance(repair_indices, list) or not 1 <= len(repair_indices) <= 40:
                    raise AgentDocumentError("latex_apply requires 1–40 selected repair indices")
                for idx in repair_indices:
                    _v.require_nonneg_int(idx, field="repair_indices", error_cls=AgentDocumentError, message="repair_indices must be nonnegative integer indices")
                params = {"expected_revision": expected_revision, "repair_indices": repair_indices}
            res = _call_dict("document_action", tab_id, action, _error="Live document action returned invalid status", **params)
            if action == "get_context" and "properties" in res:
                res = dict(res)
                if (props := bounded_properties(res.get("properties"))) is not None:
                    res["properties"] = props
                else:
                    res.pop("properties", None)
            return _lh.bounded_result(res, 24_000)
        if action == "list_devices":
            return {"devices": [], "count": 0, "available": False, "reason": _lh.LIVE_UNAVAILABLE_REASON} if live_client is None else _lh.bounded_result(_call_dict("list_devices", _error="Device list is unavailable"))
        raise AgentDocumentError("Unsupported document action")

    @server.tool()
    def document_patch(path: str, expected_revision: str, operations: list[dict[str, Any]]) -> dict[str, Any]:
        """Apply exact-text or 1-based line edits atomically against a SHA-256 revision."""
        if (tab_id := _lh.live_id(path)) is None:
            return store.patch(path, expected_revision=expected_revision, operations=operations)
        _ad.validate_patch_operations(operations)
        _v.require_sha256_revision(expected_revision, error_cls=AgentDocumentError, message="expected_revision must be the SHA-256 from the current tab")
        result = _call_dict("patch_tab", tab_id, expected_revision=expected_revision, operations=operations, _error="Live bridge returned invalid patch status")
        keys = ("revision", "previous_revision", "saved", "characters", "sourceLength", "operations", "applied", "operation_results", "changed", "isDirty", "id", "tabId", "title")
        return _lh.bounded_result({**_pick(result, keys), "target": path})

    @server.tool()
    def document_assets(path: str, offset: int = 0, limit: int = 50, action: str = "list", asset_name: str | None = None,
                        expected_revision: str | None = None, asset_id: str | None = None, asset_path: str | None = None,
                        source_offset: int = 0, source_limit: int = 12000) -> Any:
        """List/replace assets; extract SVG as paginated XML text, raster as MCP image."""
        tab_id = _lh.live_id(path)
        if action == "list":
            if tab_id is None:
                return store.assets(path, offset=offset, limit=limit)
            _require_page(offset, limit, 50, "asset offset must be nonnegative and limit must be 1–50")
            if isinstance(result := live_call("read_tab", tab_id, offset=0, limit=1, asset_offset=offset, asset_limit=limit), dict) and "assets" in result:
                if not isinstance(all_assets := result["assets"], list):
                    raise AgentDocumentError("Live bridge returned invalid asset metadata")
                return {"target": path, "revision": result.get("revision"), "assets": all_assets[:limit], "total": result.get("assetCount", len(all_assets)), "next_offset": result.get("assetsNextOffset")}
            raise AgentDocumentError("Live bridge does not expose asset metadata for this tab yet")
        if action == "replace":
            if not asset_path:
                raise AgentDocumentError("replace requires asset_path and expected_revision from document_inspect")
            _v.require_sha256_revision(expected_revision, error_cls=AgentDocumentError, message="replace requires asset_path and expected_revision from document_inspect")
            if tab_id is None:
                return store.replace_asset(path, asset_id or asset_name or "", asset_path, expected_revision=expected_revision)
            if not asset_id and not asset_name:
                raise AgentDocumentError("replace requires asset_id from document_assets")
            result = _call_dict("document_action", tab_id, "replace_tab_asset", asset_name=asset_id or asset_name,
                                asset_path=_lh.resolve_live_asset_path(store, asset_path), expected_revision=expected_revision,
                                _error="Live bridge returned invalid asset replacement status")
            status = _pick(result, ("asset", "assetName", "assetId", "revision", "previous_revision", "saved", "changed", "bytes", "mimeType"))
            if "asset" not in status and "assetName" in result:
                status["asset"] = result["assetName"]
            if "saved" not in status and "changed" in result:
                status["saved"] = bool(result["changed"])
            return _lh.bounded_result({**status, "target": path})
        if action != "extract" or not asset_name:
            raise AgentDocumentError("action must be 'list', 'replace', or 'extract' with an asset_id/name")
        if tab_id is not None:
            _v.require_sha256_revision(expected_revision, error_cls=AgentDocumentError, message="Image extraction requires the SHA-256 from document_inspect")
            image = _call_dict("get_tab_image", tab_id, asset_name=asset_name, expected_revision=expected_revision, _error="Live bridge returned invalid image data")
            metadata, mime, data = {**_pick(image, ("asset", "mime_type", "bytes", "sha256", "revision")), "target": path}, image.get("mime_type", ""), image.get("data")
        else:
            if not expected_revision:
                raise AgentDocumentError("Image extraction requires expected_revision from document_inspect")
            asset = store.read_asset(path, asset_name, expected_revision=expected_revision)
            mime, data = asset["mime_type"], asset["data"]
            metadata = {"target": path, "asset": asset_name, "mime_type": mime, "bytes": len(data), "sha256": asset["sha256"], "revision": expected_revision}
        return _lh.svg_source_blocks(data, metadata, source_offset, source_limit) if mime == "image/svg+xml" else _lh.as_asset_image_blocks(data, mime, metadata)

    @server.tool()
    def document_attach_asset(path: str, asset_path: str, expected_revision: str, name: str | None = None) -> dict[str, Any]:
        """Embed one bounded image file in a portable SMD note."""
        if (tab_id := _lh.live_id(path)) is None:
            return store.attach_asset(path, asset_path, expected_revision=expected_revision, name=name)
        asset_path = _lh.resolve_live_asset_path(store, asset_path)
        _v.require_sha256_revision(expected_revision, error_cls=AgentDocumentError, message="expected_revision must be the SHA-256 from the current tab")
        result = _call_dict("attach_tab", tab_id, asset_path=asset_path, expected_revision=expected_revision, name=name, _error="Live bridge returned invalid asset status")
        return _lh.bounded_result({**_pick(result, ("asset", "revision", "previous_revision", "saved", "id", "title")), "target": path})

    @server.tool()
    def document_view(path: str, width: int = 1600, diagram_id: str | None = None, expected_revision: str | None = None) -> Any:
        """Return a current viewport or one requested rendered diagram as MCP image content."""
        if (tab_id := _lh.live_id(path)) is None:
            if diagram_id is not None:
                raise AgentDocumentError("Use the background service for individual rendered frames, or extract the original asset")
            _v.require_viewport_width(width, min_width=320, max_width=1600, error_cls=AgentDocumentError, message="Offline preview width must be between 320 and 1,600 pixels")
            try:
                from ..offline_view import render_offline
            except ImportError:
                from offline_view import render_offline
            return [ImageContent(type="image", data=base64.b64encode(render_offline(store, path, width=width, expected_revision=expected_revision)).decode(), mimeType="image/png")]
        _v.require_viewport_width(width, min_width=64, max_width=1600, error_cls=AgentDocumentError)
        if diagram_id is not None:
            _v.require_diagram_id(diagram_id, max_len=200, require_prefix=False, error_cls=AgentDocumentError, message="diagram_id must come from list_diagrams")
            _v.require_sha256_revision(expected_revision, error_cls=AgentDocumentError, message="Diagram image requires expected_revision from list_diagrams")
            image = _call_dict("document_action", tab_id, "get_diagram_image", diagram_id=diagram_id, expected_revision=expected_revision, width=width, _error="Live renderer returned invalid image data")
            rw, rh = image.get("width"), image.get("height")
            if rw is not None and (not isinstance(rw, int) or isinstance(rw, bool) or not 1 <= rw <= width):
                raise AgentDocumentError("Diagram image width exceeds the requested bound")
            if rh is not None and (not isinstance(rh, int) or isinstance(rh, bool) or not 1 <= rh <= 8192):
                raise AgentDocumentError("Diagram image height exceeds the supported bound")
            keys: tuple[str, ...] = ("revision", "diagramId", "width", "height", "mime_type", "bytes")
        else:
            image = _call_dict("render_tab", tab_id, width=width, _error="Live renderer returned invalid image data")
            rw, rh = image.get("width"), image.get("height")
            if not isinstance(rw, int) or isinstance(rw, bool) or not isinstance(rh, int) or isinstance(rh, bool) or not 1 <= rw <= width or not 1 <= rh <= 8192:
                raise AgentDocumentError("Live renderer returned dimensions outside the requested viewport bounds")
            keys = ("revision", "width", "height", "title", "id", "mime_type", "bytes")
        return _lh.as_image_blocks(image.get("data"), image.get("mime_type", ""), {**_pick(image, keys), "target": path})

    @server.tool()
    def view_current(path: str | None = None, tabId: str | None = None, deviceId: str | None = None,
                     width: int | None = None, quality: str = "standard", includeImage: bool = True,
                     include_image: bool | None = None) -> list[Any]:
        """Use FIRST for the current Super MD page or highlighted text. Returns readingContext JSON and an optional viewport image."""
        return _lh.run_view_current(live_client, live_call, path=path, tabId=tabId, deviceId=deviceId,
                                    width=width, quality=quality, includeImage=includeImage, include_image=include_image)

    return server, store


if __name__ in ("agent.mcp_tools", "desktop.agent.mcp_tools"):
    sys.modules.setdefault("agent.mcp_tools", sys.modules[__name__])
    sys.modules.setdefault("desktop.agent.mcp_tools", sys.modules[__name__])
