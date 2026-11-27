"""Qt-free synchronous HTTP client and discovery helpers for live desktop tabs."""
from __future__ import annotations

import base64
import json
import os
import sys
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

from .validators import (
    require_diagram_id,
    require_export_params,
    require_heading_selector,
    require_identifier,
    require_image_format,
    require_int_range,
    require_nonneg_int,
    require_optional_sha256_revision,
    require_repair_indices,
    require_search_params,
    require_sha256_revision,
    require_viewport_width,
)

MAX_BODY = 2 * 1024 * 1024
MAX_RESPONSE = 12 * 1024 * 1024
REQUEST_TIMEOUT = 12.0
EXPORT_TIMEOUT = 180.0
MAX_SOURCE_PAGE = 12_000
MAX_PATCH_BYTES = 64_000
MAX_SEARCH_CONTEXT = 500
MAX_RELAY_ASSET_BYTES = 1024 * 1024
MAX_EXPORT_CHUNK_BYTES = 524_288


class LiveBridgeError(RuntimeError):
    """The desktop is unavailable or rejected a live-tab request."""


def read_discovery(path: str | os.PathLike[str]) -> dict[str, Any]:
    """Read one protected bridge discovery record without printing its token."""
    discovery_path = Path(path).expanduser()
    try:
        if discovery_path.is_symlink() or not discovery_path.is_file():
            raise LiveBridgeError("Live bridge discovery file is unsafe")
        if os.name != "nt" and discovery_path.stat().st_mode & 0o077:
            raise LiveBridgeError("Live bridge discovery file is not private")
        data = json.loads(discovery_path.read_text(encoding="utf-8"))
    except LiveBridgeError:
        raise
    except (OSError, ValueError, TypeError) as error:
        raise LiveBridgeError("Live desktop session is unavailable") from error
    if (not isinstance(data, dict) or data.get("version") != 1
            or data.get("host") != "127.0.0.1"
            or isinstance(data.get("port"), bool)
            or not isinstance(data.get("port"), int)
            or not 1 <= data["port"] <= 65535
            or not isinstance(data.get("token"), str)
            or len(data["token"]) < 40
            or not isinstance(data.get("sessionId"), str)):
        raise LiveBridgeError("Live desktop session record is invalid")
    return data


class LiveTabClient:
    """Synchronous MCP adapter for the desktop's authenticated local bridge."""

    def __init__(self, discovery: dict[str, Any] | str | os.PathLike[str], timeout: float = REQUEST_TIMEOUT):
        self.discovery = read_discovery(discovery) if isinstance(discovery, (str, os.PathLike)) else dict(discovery)
        self.timeout = min(max(float(timeout), 0.2), REQUEST_TIMEOUT)
        self.base_url = f"http://127.0.0.1:{self.discovery['port']}/v1/request"

    def _call(self, action: str, _timeout: float | None = None, **params: Any) -> dict[str, Any]:
        payload = json.dumps({"action": action, **params}, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        if len(payload) > MAX_BODY:
            raise LiveBridgeError("Live tab request exceeds the 2 MB limit")
        request = urllib.request.Request(
            self.base_url, data=payload, method="POST",
            headers={"Content-Type": "application/json", "Authorization": "Bearer " + self.discovery["token"]},
        )
        try:
            with urllib.request.urlopen(request, timeout=min(max(_timeout or self.timeout, 0.2), EXPORT_TIMEOUT)) as response:
                body = response.read(MAX_RESPONSE + 1)
                if len(body) > MAX_RESPONSE:
                    raise LiveBridgeError("Live tab response exceeds the 12 MB limit")
        except urllib.error.HTTPError as error:
            if error.code == 401:
                raise LiveBridgeError("Live desktop authorization failed") from None
            try:
                detail = json.loads(error.read(4096).decode("utf-8"))
                if isinstance(detail, dict) and isinstance(detail.get("error"), str):
                    raise LiveBridgeError(detail["error"][:2000]) from None
            except (ValueError, UnicodeError, OSError):
                pass
            raise LiveBridgeError(f"Live desktop request failed (HTTP {error.code})") from None
        except (OSError, TimeoutError, urllib.error.URLError) as error:
            raise LiveBridgeError("Live desktop is unavailable or did not respond in time") from error
        try:
            result = json.loads(body.decode("utf-8"))
        except (UnicodeDecodeError, ValueError) as error:
            raise LiveBridgeError("Live desktop returned an invalid response") from error
        if not isinstance(result, dict):
            raise LiveBridgeError("Live desktop returned an invalid response")
        if result.get("error"):
            raise LiveBridgeError(str(result["error"])[:1000])
        value = result.get("result")
        if not isinstance(value, dict):
            raise LiveBridgeError("Live desktop returned an invalid result")
        if action in ("render_tab", "get_tab_image", "get_diagram_image"):
            encoded = value.pop("data", None)
            if not isinstance(encoded, str) or len(encoded) > 8 * 1024 * 1024 * 4 // 3 + 16:
                raise LiveBridgeError("Live viewport image is invalid or oversized")
            try:
                value["data"] = base64.b64decode(encoded, validate=True)
            except (ValueError, base64.binascii.Error) as error:
                raise LiveBridgeError("Live viewport image is invalid") from error
        return value

    def list_tabs(self) -> dict[str, Any]:
        return self._call("list_tabs")

    @staticmethod
    def _window_params(window_id: str | None) -> dict[str, str]:
        if window_id is None:
            return {}
        require_identifier(window_id, field="window_id", error_cls=LiveBridgeError,
                           message="window_id must be a non-empty window identifier")
        return {"windowId": window_id}

    def read_tab(self, tab_id: str, offset: int = 0, limit: int = MAX_SOURCE_PAGE,
                 window_id: str | None = None, asset_offset: int = 0, asset_limit: int = 0,
                 view: str = "prose", heading: int | str | None = None) -> dict[str, Any]:
        require_nonneg_int(offset, error_cls=LiveBridgeError)
        require_int_range(limit, 1, MAX_SOURCE_PAGE, error_cls=LiveBridgeError)
        require_nonneg_int(asset_offset, field="asset_offset", error_cls=LiveBridgeError)
        require_int_range(asset_limit, 0, 50, field="asset_limit", error_cls=LiveBridgeError)
        if view not in ("prose", "source"):
            raise LiveBridgeError("view must be prose or source")
        require_heading_selector(heading, error_cls=LiveBridgeError)
        return self._call("read_tab", tabId=tab_id, offset=offset, limit=limit,
                          assetOffset=asset_offset, assetLimit=asset_limit, view=view,
                          **({"heading": heading} if heading is not None else {}),
                          **self._window_params(window_id))

    def search_tab(self, tab_id: str, query: str, limit: int = 10, context: int = 100,
                   window_id: str | None = None, *, offset: int = 0, case_sensitive: bool = False,
                   whole_word: bool = False, regex: bool = False, exclude_diagrams: bool = False) -> dict[str, Any]:
        require_search_params(query, limit, context, offset, error_cls=LiveBridgeError, flags={
            "caseSensitive": case_sensitive, "wholeWord": whole_word,
            "regex": regex, "excludeDiagrams": exclude_diagrams,
        })
        return self._call("search_tab", tabId=tab_id, query=query, limit=limit, context=context,
                          offset=offset, caseSensitive=case_sensitive, wholeWord=whole_word,
                          regex=regex, excludeDiagrams=exclude_diagrams, **self._window_params(window_id))

    def outline_tab(self, tab_id: str, window_id: str | None = None, offset: int = 0, limit: int = 80) -> dict[str, Any]:
        require_nonneg_int(offset, error_cls=LiveBridgeError)
        require_int_range(limit, 1, 80, error_cls=LiveBridgeError)
        return self._call("outline_tab", tabId=tab_id, offset=offset, limit=limit, **self._window_params(window_id))

    def list_diagrams(self, tab_id: str, window_id: str | None = None,
                      expected_revision: str | None = None, offset: int = 0, limit: int = 80) -> dict[str, Any]:
        require_nonneg_int(offset, error_cls=LiveBridgeError)
        require_int_range(limit, 1, 80, error_cls=LiveBridgeError)
        params: dict[str, Any] = {"tabId": tab_id, "offset": offset, "limit": limit, **self._window_params(window_id)}
        if require_optional_sha256_revision(expected_revision, error_cls=LiveBridgeError) is not None:
            params["expectedRevision"] = expected_revision
        return self._call("list_diagrams", **params)

    def get_diagram(self, tab_id: str, diagram_id: str, expected_revision: str,
                    offset: int = 0, limit: int = MAX_SOURCE_PAGE, window_id: str | None = None) -> dict[str, Any]:
        require_diagram_id(diagram_id, error_cls=LiveBridgeError, message="diagram_id must be a diagram source reference")
        require_sha256_revision(expected_revision, error_cls=LiveBridgeError)
        require_nonneg_int(offset, error_cls=LiveBridgeError)
        require_int_range(limit, 1, MAX_SOURCE_PAGE, error_cls=LiveBridgeError)
        return self._call("get_diagram", tabId=tab_id, diagramId=diagram_id, expectedRevision=expected_revision,
                          offset=offset, limit=limit, **self._window_params(window_id))

    def get_diagram_image(self, tab_id: str, diagram_id: str, expected_revision: str,
                          window_id: str | None = None, width: int = 1600) -> dict[str, Any]:
        require_viewport_width(width, error_cls=LiveBridgeError)
        return self._call("get_diagram_image", tabId=tab_id, diagramId=diagram_id,
                          expectedRevision=expected_revision, width=width, **self._window_params(window_id))

    def attach_tab(self, tab_id: str, *, asset_path: str, expected_revision: str,
                   name: str | None = None, window_id: str | None = None) -> dict[str, Any]:
        require_identifier(asset_path, field="asset_path", max_len=4096, error_cls=LiveBridgeError,
                           message="asset_path must be a local image file path")
        require_sha256_revision(expected_revision, error_cls=LiveBridgeError)
        if name is not None and (not isinstance(name, str) or len(name.encode("utf-8")) > 256):
            raise LiveBridgeError("name must be a short asset filename")
        return self._call("asset_action", tabId=tab_id, assetAction="attach", assetPath=asset_path,
                          **({"assetName": name} if name else {}), expectedRevision=expected_revision,
                          **self._window_params(window_id))

    def get_tab_image(self, tab_id: str, *, asset_name: str, expected_revision: str,
                      window_id: str | None = None) -> dict[str, Any]:
        require_identifier(asset_name, field="asset_name", max_len=256, error_cls=LiveBridgeError)
        require_sha256_revision(expected_revision, error_cls=LiveBridgeError)
        return self._call("get_tab_image", tabId=tab_id, assetName=asset_name,
                          expectedRevision=expected_revision, **self._window_params(window_id))

    def get_context(self, tab_id: str, window_id: str | None = None, limit: int = 6000) -> dict[str, Any]:
        require_int_range(limit, 1, MAX_SOURCE_PAGE, error_cls=LiveBridgeError)
        return self._call("get_context", tabId=tab_id, limit=limit, **self._window_params(window_id))

    def latex_review(self, tab_id: str, window_id: str | None = None) -> dict[str, Any]:
        return self._call("latex_review", tabId=tab_id, **self._window_params(window_id))

    def latex_apply(self, tab_id: str, expected_revision: str, repair_indices: list[int],
                    window_id: str | None = None) -> dict[str, Any]:
        require_sha256_revision(expected_revision, error_cls=LiveBridgeError)
        require_repair_indices(repair_indices, error_cls=LiveBridgeError)
        return self._call("latex_apply", tabId=tab_id, expectedRevision=expected_revision,
                          repairIndices=repair_indices, **self._window_params(window_id))

    def export_document(self, tab_id: str, format: str = "pdf", options: dict[str, Any] | None = None,
                        filename: str | None = None, expected_revision: str | None = None,
                        window_id: str | None = None) -> dict[str, Any]:
        require_export_params(format, options=options, filename=filename, error_cls=LiveBridgeError)
        require_sha256_revision(expected_revision, error_cls=LiveBridgeError)
        return self._call("export_document", tabId=tab_id, format=format, options=options or {},
                          filename=filename or "", expectedRevision=expected_revision,
                          **self._window_params(window_id))

    def job_status(self, tab_id: str, job_id: str, window_id: str | None = None) -> dict[str, Any]:
        require_identifier(job_id, field="job_id", error_cls=LiveBridgeError)
        params = {"jobId": job_id, **self._window_params(window_id)}
        if tab_id:
            params["tabId"] = tab_id
        return self._call("job_status", **params)

    def document_action(self, tab_id: str, action: str, window_id: str | None = None, **params: Any) -> dict[str, Any]:
        """Dispatch one constrained live-tab action used by MCP document_action."""
        if action == "get_context":
            return self.get_context(tab_id, window_id=window_id, limit=params.get("limit", 6000))
        if action == "latex_review":
            return self.latex_review(tab_id, window_id=window_id)
        if action == "latex_apply":
            return self.latex_apply(tab_id, expected_revision=params.get("expected_revision", ""),
                                    repair_indices=params.get("repair_indices", []), window_id=window_id)
        if action == "export_document":
            return self.export_document(
                tab_id, format=params.get("format", "pdf"), options=params.get("options"),
                filename=params.get("filename"), expected_revision=params.get("expected_revision"),
                window_id=window_id,
            )
        if action == "job_status":
            return self.job_status(tab_id or "", params.get("job_id", ""), window_id=window_id)
        if action == "export_chunk":
            job_id = require_identifier(params.get("job_id", ""), field="job_id", error_cls=LiveBridgeError)
            offset = require_nonneg_int(params.get("offset", 0), error_cls=LiveBridgeError,
                                        message="offset must be a nonnegative byte offset")
            limit = require_int_range(params.get("limit", 262_144), 1, MAX_EXPORT_CHUNK_BYTES,
                                      error_cls=LiveBridgeError, message="limit must be between 1 and 524,288 bytes")
            return self._call("export_chunk", jobId=job_id, offset=offset, limit=limit, **self._window_params(window_id))
        if action == "list_diagrams":
            return self.list_diagrams(tab_id, window_id=window_id, expected_revision=params.get("expected_revision"),
                                      offset=params.get("offset", 0), limit=params.get("limit", 80))
        if action == "get_diagram":
            return self.get_diagram(tab_id, params.get("diagram_id", ""), params.get("expected_revision", ""),
                                    offset=params.get("offset", 0), limit=params.get("limit", MAX_SOURCE_PAGE),
                                    window_id=window_id)
        if action == "get_diagram_image":
            return self.get_diagram_image(tab_id, params.get("diagram_id", ""), params.get("expected_revision", ""),
                                          window_id=window_id, width=params.get("width", 1600))
        if action == "attach_tab_asset":
            return self.attach_tab(tab_id, asset_path=params.get("asset_path", ""),
                                   expected_revision=params.get("expected_revision", ""),
                                   name=params.get("name"), window_id=window_id)
        if action == "replace_tab_asset":
            return self._call("replace_tab_asset", tabId=tab_id, assetName=params.get("asset_name", ""),
                              assetPath=params.get("asset_path", ""),
                              expectedRevision=params.get("expected_revision", ""), **self._window_params(window_id))
        if action in ("create_document", "save_document", "open_document", "activate_document", "close_document"):
            payload: dict[str, Any] = {"action": action, "tabId": tab_id or ""}
            if action == "create_document":
                payload.update(content=params.get("content", ""), title=params.get("title", ""),
                               filename=params.get("filename", ""))
                if params.get("format") is not None:
                    payload["format"] = params["format"]
            if action in ("save_document", "close_document"):
                payload["expectedRevision"] = params.get("expected_revision", "")
            if action in ("save_document", "open_document"):
                payload["filename"] = params.get("filename", "")
            if action == "save_document" and params.get("format") is not None:
                payload["format"] = params["format"]
            for external, internal in (("background", "background"), ("save_as", "saveAs"),
                                       ("discard_changes", "discardChanges")):
                if external in params:
                    payload[internal] = params[external]
            payload.update(self._window_params(window_id))
            return self._call_payload(payload)
        raise LiveBridgeError("Unsupported live document action")

    def _call_payload(self, payload: dict[str, Any]) -> dict[str, Any]:
        action = payload.pop("action")
        return self._call(action, **payload)

    def patch_tab(self, tab_id: str, expected_revision: str, operations: list[dict[str, Any]],
                  window_id: str | None = None) -> dict[str, Any]:
        require_sha256_revision(expected_revision, error_cls=LiveBridgeError)
        if not isinstance(operations, list) or len(operations) > 100:
            raise LiveBridgeError("operations must contain at most 100 edits")
        if len(json.dumps(operations, ensure_ascii=False).encode("utf-8")) > MAX_PATCH_BYTES:
            raise LiveBridgeError("Patch operations exceed the 64 KB limit")
        return self._call("patch_tab", tabId=tab_id, expectedRevision=expected_revision,
                          operations=operations, **self._window_params(window_id))

    def render_tab(self, tab_id: str, width: int = 1600, window_id: str | None = None,
                   image_format: str = "png") -> dict[str, Any]:
        require_viewport_width(width, error_cls=LiveBridgeError)
        require_image_format(image_format, error_cls=LiveBridgeError)
        return self._call("render_tab", tabId=tab_id, width=width,
                          imageFormat=image_format, **self._window_params(window_id))


_PEER_MODULE = (
    "agent.live_client"
    if __name__ == "desktop.agent.live_client"
    else ("desktop.agent.live_client" if __name__ == "agent.live_client" else None)
)
if _PEER_MODULE and _PEER_MODULE in sys.modules:
    sys.modules[__name__] = sys.modules[_PEER_MODULE]
