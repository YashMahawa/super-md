"""Authenticated, loopback-only bridge to the current desktop reader tabs.

The synchronous :class:`LiveTabClient` is safe to import from the headless MCP
process: Qt is imported lazily, only when the desktop-side QObject is created.
"""
from __future__ import annotations

import base64
import hmac
import http.server
import hashlib
import json
import os
import re
import secrets
import sys
import threading
import time
import urllib.error
import urllib.request
import uuid
from pathlib import Path
from typing import Any

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
        if not isinstance(window_id, str) or not window_id or len(window_id) > 128:
            raise LiveBridgeError("window_id must be a non-empty window identifier")
        return {"windowId": window_id}

    def read_tab(self, tab_id: str, offset: int = 0, limit: int = 12_000,
                 window_id: str | None = None, asset_offset: int = 0, asset_limit: int = 0,
                 view: str = "prose", heading: int | str | None = None) -> dict[str, Any]:
        if not isinstance(offset, int) or isinstance(offset, bool) or offset < 0:
            raise LiveBridgeError("offset must be a nonnegative integer")
        if not isinstance(limit, int) or isinstance(limit, bool) or not 1 <= limit <= MAX_SOURCE_PAGE:
            raise LiveBridgeError("limit must be between 1 and 12,000")
        if not isinstance(asset_offset, int) or isinstance(asset_offset, bool) or asset_offset < 0:
            raise LiveBridgeError("asset_offset must be a nonnegative integer")
        if not isinstance(asset_limit, int) or isinstance(asset_limit, bool) or not 0 <= asset_limit <= 50:
            raise LiveBridgeError("asset_limit must be between 0 and 50")
        if view not in ("prose", "source"):
            raise LiveBridgeError("view must be prose or source")
        if heading is not None and not (
                isinstance(heading, int) and not isinstance(heading, bool) and heading >= 0
                or isinstance(heading, str) and bool(heading.strip()) and len(heading) <= 300):
            raise LiveBridgeError("heading must be an outline index, exact title, slug, or numbered heading prefix")
        return self._call("read_tab", tabId=tab_id, offset=offset, limit=limit,
                          assetOffset=asset_offset, assetLimit=asset_limit, view=view,
                          **({"heading": heading} if heading is not None else {}),
                          **self._window_params(window_id))

    def search_tab(self, tab_id: str, query: str, limit: int = 10, context: int = 100,
                   window_id: str | None = None, *, offset: int = 0, case_sensitive: bool = False,
                   whole_word: bool = False, regex: bool = False, exclude_diagrams: bool = False) -> dict[str, Any]:
        if not isinstance(query, str) or not query or len(query) > 500:
            raise LiveBridgeError("query must contain between 1 and 500 characters")
        if not isinstance(limit, int) or isinstance(limit, bool) or not 1 <= limit <= 25:
            raise LiveBridgeError("limit must be between 1 and 25")
        if not isinstance(context, int) or isinstance(context, bool) or not 0 <= context <= MAX_SEARCH_CONTEXT:
            raise LiveBridgeError("context must be between 0 and 500")
        return self._call("search_tab", tabId=tab_id, query=query, limit=limit, context=context, offset=offset,
                          caseSensitive=case_sensitive, wholeWord=whole_word, regex=regex, excludeDiagrams=exclude_diagrams,
                          **self._window_params(window_id))

    def outline_tab(self, tab_id: str, window_id: str | None = None,
                    offset: int = 0, limit: int = 80) -> dict[str, Any]:
        if not isinstance(offset, int) or isinstance(offset, bool) or offset < 0:
            raise LiveBridgeError("offset must be a nonnegative integer")
        if not isinstance(limit, int) or isinstance(limit, bool) or not 1 <= limit <= 80:
            raise LiveBridgeError("limit must be between 1 and 80")
        return self._call("outline_tab", tabId=tab_id, offset=offset, limit=limit,
                          **self._window_params(window_id))

    def list_diagrams(self, tab_id: str, window_id: str | None = None,
                      expected_revision: str | None = None, offset: int = 0, limit: int = 80) -> dict[str, Any]:
        if not isinstance(offset, int) or isinstance(offset, bool) or offset < 0:
            raise LiveBridgeError("offset must be a nonnegative integer")
        if not isinstance(limit, int) or isinstance(limit, bool) or not 1 <= limit <= 80:
            raise LiveBridgeError("limit must be between 1 and 80")
        params = {"tabId": tab_id, "offset": offset, "limit": limit, **self._window_params(window_id)}
        if expected_revision is not None:
            if not isinstance(expected_revision, str) or len(expected_revision) != 64:
                raise LiveBridgeError("expected_revision must be the current SHA-256 revision")
            params["expectedRevision"] = expected_revision
        return self._call("list_diagrams", **params)

    def get_diagram(self, tab_id: str, diagram_id: str, expected_revision: str,
                    offset: int = 0, limit: int = 12_000,
                    window_id: str | None = None) -> dict[str, Any]:
        if not isinstance(diagram_id, str) or not diagram_id.startswith("diagram:") or len(diagram_id) > 100:
            raise LiveBridgeError("diagram_id must be a diagram source reference")
        if not isinstance(expected_revision, str) or len(expected_revision) != 64:
            raise LiveBridgeError("expected_revision must be the current SHA-256 revision")
        if not isinstance(offset, int) or isinstance(offset, bool) or offset < 0:
            raise LiveBridgeError("offset must be a nonnegative integer")
        if not isinstance(limit, int) or isinstance(limit, bool) or not 1 <= limit <= MAX_SOURCE_PAGE:
            raise LiveBridgeError("limit must be between 1 and 12,000")
        return self._call("get_diagram", tabId=tab_id, diagramId=diagram_id,
                          expectedRevision=expected_revision, offset=offset, limit=limit,
                          **self._window_params(window_id))

    def get_diagram_image(self, tab_id: str, diagram_id: str, expected_revision: str,
                          window_id: str | None = None, width: int = 1600) -> dict[str, Any]:
        if not isinstance(width, int) or isinstance(width, bool) or not 64 <= width <= 1600:
            raise LiveBridgeError("width must be between 64 and 1,600 pixels")
        return self._call("get_diagram_image", tabId=tab_id, diagramId=diagram_id,
                          expectedRevision=expected_revision, width=width, **self._window_params(window_id))

    def attach_tab(self, tab_id: str, *, asset_path: str, expected_revision: str,
                   name: str | None = None, window_id: str | None = None) -> dict[str, Any]:
        if not isinstance(asset_path, str) or not asset_path or len(asset_path) > 4096:
            raise LiveBridgeError("asset_path must be a local image file path")
        if not isinstance(expected_revision, str) or len(expected_revision) != 64:
            raise LiveBridgeError("expected_revision must be the current SHA-256 revision")
        if name is not None and (not isinstance(name, str) or len(name.encode("utf-8")) > 256):
            raise LiveBridgeError("name must be a short asset filename")
        return self._call("asset_action", tabId=tab_id, assetAction="attach", assetPath=asset_path,
                          **({"assetName": name} if name else {}), expectedRevision=expected_revision,
                          **self._window_params(window_id))

    def get_tab_image(self, tab_id: str, *, asset_name: str, expected_revision: str,
                      window_id: str | None = None) -> dict[str, Any]:
        if not isinstance(asset_name, str) or not asset_name or len(asset_name) > 256:
            raise LiveBridgeError("asset_name is required")
        if not isinstance(expected_revision, str) or len(expected_revision) != 64:
            raise LiveBridgeError("expected_revision must be the current SHA-256 revision")
        return self._call("get_tab_image", tabId=tab_id, assetName=asset_name,
                          expectedRevision=expected_revision, **self._window_params(window_id))

    def get_context(self, tab_id: str, window_id: str | None = None, limit: int = 6000) -> dict[str, Any]:
        if not isinstance(limit, int) or isinstance(limit, bool) or not 1 <= limit <= 12_000:
            raise LiveBridgeError("limit must be between 1 and 12,000")
        return self._call("get_context", tabId=tab_id, limit=limit, **self._window_params(window_id))

    def latex_review(self, tab_id: str, window_id: str | None = None) -> dict[str, Any]:
        return self._call("latex_review", tabId=tab_id, **self._window_params(window_id))

    def latex_apply(self, tab_id: str, expected_revision: str, repair_indices: list[int],
                    window_id: str | None = None) -> dict[str, Any]:
        if not isinstance(expected_revision, str) or len(expected_revision) != 64:
            raise LiveBridgeError("expected_revision must be the current SHA-256 revision")
        if (not isinstance(repair_indices, list) or len(repair_indices) > 40
                or any(not isinstance(value, int) or isinstance(value, bool) or value < 0 for value in repair_indices)
                or len(set(repair_indices)) != len(repair_indices)):
            raise LiveBridgeError("repair_indices must be up to 40 unique nonnegative repair indexes")
        return self._call("latex_apply", tabId=tab_id, expectedRevision=expected_revision,
                          repairIndices=repair_indices, **self._window_params(window_id))

    def export_document(self, tab_id: str, format: str = "pdf", options: dict[str, Any] | None = None,
                        filename: str | None = None, expected_revision: str | None = None,
                        window_id: str | None = None) -> dict[str, Any]:
        if format not in ("pdf", "smd", "md"):
            raise LiveBridgeError("format must be pdf, smd, or md")
        if not isinstance(expected_revision, str) or len(expected_revision) != 64:
            raise LiveBridgeError("expected_revision must be the current SHA-256 revision")
        if options is not None:
            if not isinstance(options, dict) or len(json.dumps(options, ensure_ascii=False).encode("utf-8")) > 8_000:
                raise LiveBridgeError("Export options must be an object smaller than 8 KB")
        if filename is not None and (not isinstance(filename, str) or len(filename) > 160):
            raise LiveBridgeError("filename must be a short basename")
        return self._call("export_document", tabId=tab_id, format=format, options=options or {},
                          filename=filename or "", expectedRevision=expected_revision,
                          **self._window_params(window_id))

    def job_status(self, tab_id: str, job_id: str, window_id: str | None = None) -> dict[str, Any]:
        if not isinstance(job_id, str) or not job_id or len(job_id) > 128:
            raise LiveBridgeError("job_id is required")
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
            return self.export_document(tab_id, format=params.get("format", "pdf"),
                                        options=params.get("options"), filename=params.get("filename"),
                                        expected_revision=params.get("expected_revision"), window_id=window_id)
        if action == "job_status":
            return self.job_status(tab_id or "", params.get("job_id", ""), window_id=window_id)
        if action == "export_chunk":
            job_id, offset, limit = params.get("job_id", ""), params.get("offset", 0), params.get("limit", 262_144)
            if not isinstance(job_id, str) or not job_id or len(job_id) > 128:
                raise LiveBridgeError("job_id is required")
            if not isinstance(offset, int) or isinstance(offset, bool) or offset < 0:
                raise LiveBridgeError("offset must be a nonnegative byte offset")
            if not isinstance(limit, int) or isinstance(limit, bool) or not 1 <= limit <= MAX_EXPORT_CHUNK_BYTES:
                raise LiveBridgeError("limit must be between 1 and 524,288 bytes")
            return self._call("export_chunk", jobId=job_id, offset=offset, limit=limit,
                              **self._window_params(window_id))
        if action == "list_diagrams":
            return self.list_diagrams(tab_id, window_id=window_id,
                                      expected_revision=params.get("expected_revision"),
                                      offset=params.get("offset", 0), limit=params.get("limit", 80))
        if action == "get_diagram":
            return self.get_diagram(tab_id, params.get("diagram_id", ""),
                                    params.get("expected_revision", ""),
                                    offset=params.get("offset", 0), limit=params.get("limit", 12_000),
                                    window_id=window_id)
        if action == "get_diagram_image":
            return self.get_diagram_image(tab_id, params.get("diagram_id", ""),
                                          params.get("expected_revision", ""), window_id=window_id,
                                          width=params.get("width", 1600))
        if action == "attach_tab_asset":
            return self.attach_tab(tab_id, asset_path=params.get("asset_path", ""),
                                   expected_revision=params.get("expected_revision", ""),
                                   name=params.get("name"), window_id=window_id)
        if action == "replace_tab_asset":
            return self._call("replace_tab_asset", tabId=tab_id, assetName=params.get("asset_name", ""),
                              assetPath=params.get("asset_path", ""),
                              expectedRevision=params.get("expected_revision", ""),
                              **self._window_params(window_id))
        if action in ("create_document", "save_document", "open_document", "activate_document", "close_document"):
            payload = {"action": action, "tabId": tab_id or ""}
            if action == "create_document":
                payload.update(content=params.get("content", ""), title=params.get("title", ""),
                               filename=params.get("filename", ""))
                if params.get("format") is not None: payload["format"] = params["format"]
            if action in ("save_document", "close_document"):
                payload["expectedRevision"] = params.get("expected_revision", "")
            if action in ("save_document", "open_document"):
                payload["filename"] = params.get("filename", "")
            if action == "save_document" and params.get("format") is not None:
                payload["format"] = params["format"]
            for external, internal in (("background", "background"), ("save_as", "saveAs"), ("discard_changes", "discardChanges")):
                if external in params: payload[internal] = params[external]
            payload.update(self._window_params(window_id))
            return self._call_payload(payload)
        raise LiveBridgeError("Unsupported live document action")

    def _call_payload(self, payload: dict[str, Any]) -> dict[str, Any]:
        action = payload.pop("action")
        return self._call(action, **payload)

    def patch_tab(self, tab_id: str, expected_revision: str, operations: list[dict[str, Any]],
                  window_id: str | None = None) -> dict[str, Any]:
        if not isinstance(expected_revision, str) or len(expected_revision) != 64:
            raise LiveBridgeError("expected_revision must be the current SHA-256 revision")
        if not isinstance(operations, list) or len(operations) > 100:
            raise LiveBridgeError("operations must contain at most 100 edits")
        if len(json.dumps(operations, ensure_ascii=False).encode("utf-8")) > MAX_PATCH_BYTES:
            raise LiveBridgeError("Patch operations exceed the 64 KB limit")
        return self._call("patch_tab", tabId=tab_id, expectedRevision=expected_revision, operations=operations,
                          **self._window_params(window_id))

    def render_tab(self, tab_id: str, width: int = 1600, window_id: str | None = None,
                   image_format: str = "png") -> dict[str, Any]:
        if not isinstance(width, int) or isinstance(width, bool) or not 64 <= width <= 1600:
            raise LiveBridgeError("width must be between 64 and 1,600 pixels")
        if image_format not in ("png", "jpeg"):
            raise LiveBridgeError("image_format must be png or jpeg")
        return self._call("render_tab", tabId=tab_id, width=width, imageFormat=image_format,
                          **self._window_params(window_id))


def _qt_bridge_class():
    """Create the Qt subclass only in the GUI process."""
    from PySide6.QtCore import QObject, Signal, Slot, Qt

    class QtBridge(QObject):
        _dispatch = Signal(str)
        enabledChanged = Signal()
        cloudStatusChanged = Signal(str)

        def __init__(self, session, data_dir: Path):
            super().__init__()
            self.session = session
            self.data_dir = Path(data_dir)
            self.discovery_dir = self.data_dir / "agent-sessions"
            self.discovery_path: Path | None = None
            self.session_id = uuid.uuid4().hex
            self.token = ""
            self.server: http.server.ThreadingHTTPServer | None = None
            self.thread: threading.Thread | None = None
            self._lock = threading.RLock()
            self._pending: dict[str, dict[str, Any]] = {}
            self._dispatches: dict[str, tuple[str, str, str]] = {}
            self._enabled = False
            try:
                from .agent_cloud import CloudRelayClient
            except ImportError:
                from agent_cloud import CloudRelayClient
            self.cloudClient = CloudRelayClient(self.handle_cloud_request, self.cloudStatusChanged.emit)
            self._dispatch.connect(self._handle_request, Qt.ConnectionType.QueuedConnection)

        @property
        def enabled(self) -> bool:
            return self._enabled

        @property
        def endpoint(self) -> str:
            return f"http://127.0.0.1:{self.server.server_port}/v1/request" if self.server else ""

        def start(self) -> dict[str, Any]:
            if self._enabled:
                return self.status()
            if self.discovery_dir.is_symlink():
                raise ValueError("Live bridge discovery directory must not be a symlink")
            self.discovery_dir.mkdir(parents=True, exist_ok=True)
            if os.name != "nt":
                os.chmod(self.discovery_dir, 0o700)
            self.token = secrets.token_urlsafe(48)
            bridge = self

            class Handler(http.server.BaseHTTPRequestHandler):
                protocol_version = "HTTP/1.1"
                server_version = "SuperMDLive/1"

                def setup(self):
                    super().setup()
                    self.connection.settimeout(5.0)

                def log_message(self, *_args):
                    return

                def _reply(self, status: int, value: dict[str, Any]):
                    body = json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
                    self.send_response(status)
                    self.send_header("Content-Type", "application/json; charset=utf-8")
                    self.send_header("Content-Length", str(len(body)))
                    self.send_header("Cache-Control", "no-store")
                    self.send_header("Connection", "close")
                    self.end_headers()
                    self.wfile.write(body)

                def do_POST(self):
                    if self.path != "/v1/request":
                        self._reply(404, {"error": "not found"})
                        return
                    host = self.headers.get("Host", "").lower()
                    if host not in (f"127.0.0.1:{bridge.server.server_port}", f"localhost:{bridge.server.server_port}"):
                        self._reply(403, {"error": "invalid host"})
                        return
                    origin = self.headers.get("Origin")
                    if origin and origin not in (f"http://127.0.0.1:{bridge.server.server_port}", f"http://localhost:{bridge.server.server_port}"):
                        self._reply(403, {"error": "invalid origin"})
                        return
                    supplied = self.headers.get("Authorization", "")
                    if not supplied.startswith("Bearer ") or not hmac.compare_digest(supplied[7:], bridge.token):
                        self._reply(401, {"error": "unauthorized"})
                        return
                    try:
                        length = int(self.headers.get("Content-Length", "-1"))
                    except ValueError:
                        length = -1
                    if not 0 <= length <= MAX_BODY:
                        self._reply(413, {"error": "request body exceeds 2 MB"})
                        return
                    try:
                        payload = json.loads(self.rfile.read(length).decode("utf-8"))
                        if not isinstance(payload, dict):
                            raise ValueError("request must be a JSON object")
                        result = bridge._call_gui(payload)
                        self._reply(200, {"result": result})
                    except TimeoutError:
                        self._reply(504, {"error": "desktop request timed out"})
                    except (ValueError, TypeError) as error:
                        self._reply(400, {"error": str(error)[:1000]})
                    except Exception as error:
                        self._reply(500, {"error": f"desktop request failed ({type(error).__name__})"})

            self.server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
            self.server.daemon_threads = True
            self.server.timeout = 0.5
            self.server.request_queue_size = 8
            self.token = secrets.token_urlsafe(48)
            self.discovery_path = self.discovery_dir / f"{self.session_id}.json"
            payload = {"version": 1, "sessionId": self.session_id, "pid": os.getpid(),
                       "platform": sys.platform, "displayName": "This computer",
                       "host": "127.0.0.1", "port": self.server.server_port, "token": self.token}
            temp = self.discovery_path.with_suffix(".tmp")
            flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
            fd = os.open(temp, flags, 0o600)
            try:
                with os.fdopen(fd, "w", encoding="utf-8") as stream:
                    json.dump(payload, stream, separators=(",", ":"))
                    stream.flush()
                    os.fsync(stream.fileno())
                os.replace(temp, self.discovery_path)
                if os.name != "nt":
                    os.chmod(self.discovery_path, 0o600)
            finally:
                try:
                    temp.unlink()
                except OSError:
                    pass
            self._enabled = True
            self.thread = threading.Thread(target=self.server.serve_forever, name="supermd-agent-live", daemon=True)
            self.thread.start()
            self.enabledChanged.emit()
            return self.status()

        def status(self) -> dict[str, Any]:
            return {"enabled": self._enabled, "endpoint": self.endpoint,
                    "sessionId": self.session_id if self._enabled else "",
                    "discoveryPath": str(self.discovery_path) if self._enabled and self.discovery_path else ""}

        def stop(self):
            self.cloudClient.stop()
            self._enabled = False
            server, self.server = self.server, None
            if server:
                server.shutdown()
                server.server_close()
            if self.discovery_path:
                try:
                    self.discovery_path.unlink()
                except OSError:
                    pass
                self.discovery_path = None
            with self._lock:
                pending = list(self._pending.values())
                self._pending.clear()
                self._dispatches.clear()
            for item in pending:
                item["error"] = "Live desktop session was disabled"
                item["event"].set()
            self.token = ""
            self.enabledChanged.emit()

        def start_cloud(self, config: dict[str, Any]):
            if not self._enabled:
                self.start()
            self.cloudClient.start(config)

        def stop_cloud(self):
            self.cloudClient.stop()
            with self._lock:
                cancelled = [(key, value) for key, value in self._pending.items() if value.get("cloud")]
                for request_id, value in cancelled:
                    self._pending.pop(request_id, None)
                    value["error"] = "Cloud live access was disabled"
                    value["event"].set()
                cancelled_ids = {request_id for request_id, _ in cancelled}
                for child_id, owner in list(self._dispatches.items()):
                    if owner[0] in cancelled_ids:
                        self._dispatches.pop(child_id, None)

        def _remote_call_gui(self, payload: dict[str, Any]) -> dict[str, Any]:
            request = dict(payload)
            request["_cloud"] = True
            return self._call_gui(request)

        @staticmethod
        def _cloud_tab_parts(tab_id: str) -> tuple[str | None, str]:
            if not isinstance(tab_id, str):
                return None, ""
            if ":" not in tab_id:
                return None, tab_id
            window_id, raw_id = tab_id.split(":", 1)
            return (window_id or None), raw_id

        @staticmethod
        def _canonical_cloud_result(result: dict[str, Any]) -> dict[str, Any]:
            result = dict(result)
            raw, window = result.get("tabId"), result.get("windowId")
            if isinstance(raw, str) and raw and isinstance(window, str) and window and not raw.startswith(window + ":"):
                result["nativeTabId"] = raw
                result["tabId"] = window + ":" + raw
            return result

        def handle_cloud_request(self, message: dict[str, Any]) -> dict[str, Any]:
            """Translate the relay's constrained RPC envelope into local actions."""
            action = message.get("action")
            tab_id = message.get("tabId", "")
            window_id, raw_tab_id = self._cloud_tab_parts(tab_id) if tab_id else (None, "")
            window_id = message.get("windowId") or window_id
            payload: dict[str, Any] = {"action": action}
            if action in ("list_tabs",):
                result = self._remote_call_gui(payload)
                for row in result.get("tabs", []):
                    row["tabId"] = f"{row.get('windowId', '')}:{row.get('id', '')}"
                    row["id"] = row["tabId"]
                return result
            if action in ("read_tab", "search_tab", "patch_tab", "render_tab", "list_diagrams", "get_diagram", "get_diagram_image", "replace_tab_asset", "asset_action"):
                payload.update({"tabId": raw_tab_id, "windowId": window_id})
                forwarded_fields = (("expectedRevision", "expectedRevision"), ("operations", "operations"),
                                           ("offset", "offset"), ("limit", "limit"), ("query", "query"),
                                           ("context", "context"), ("width", "width"),
                                           ("caseSensitive", "caseSensitive"), ("wholeWord", "wholeWord"),
                                           ("regex", "regex"), ("excludeDiagrams", "excludeDiagrams"),
                                           ("diagramId", "diagramId"),
                                           ("assetName", "assetName"), ("assetPath", "assetPath"),
                                           ("assetAction", "assetAction"), ("mimeType", "mimeType"), ("body", "body"),
                                           ("view", "view"), ("heading", "heading"))
                if action == "render_tab":
                    forwarded_fields += (("imageFormat", "imageFormat"),)
                elif action == "get_diagram_image":
                    forwarded_fields += (("imageFormat", "imageFormat"),)
                for external, internal in forwarded_fields:
                    if external in message:
                        payload[internal] = message[external]
                return self._canonical_cloud_result(self._remote_call_gui(payload))
            if action == "document_action":
                doc_action = message.get("documentAction")
                options = message.get("options") if isinstance(message.get("options"), dict) else {}
                payload = {"windowId": window_id}
                if doc_action == "create":
                    filename = options.get("filename", "")
                    inferred_format = "smd" if isinstance(filename, str) and filename.lower().endswith(".smd") else "md"
                    payload.update(action="create_document", content=message.get("content", ""),
                                   title=options.get("title", ""), filename=filename,
                                   background=options.get("background", False),
                                   format=options.get("format", inferred_format))
                elif doc_action == "export":
                    payload.update(action="export_document", tabId=raw_tab_id,
                                   expectedRevision=message.get("expectedRevision"),
                                   format=options.get("format", "pdf"), options={key: value for key, value in options.items() if key not in ("format", "filename")},
                                   filename=options.get("filename", ""))
                elif doc_action in ("latexfix", "latex_review", "latex_apply"):
                    indices = message.get("repairIndices", options.get("repairIndices"))
                    apply = doc_action == "latex_apply" or (doc_action == "latexfix" and indices is not None)
                    payload.update(action="latex_apply" if apply else "latex_review", tabId=raw_tab_id)
                    if apply: payload.update(expectedRevision=message.get("expectedRevision"), repairIndices=indices)
                elif doc_action in ("activate", "close"):
                    payload.update(action=doc_action + "_document", tabId=raw_tab_id)
                    if doc_action == "close": payload.update(expectedRevision=message.get("expectedRevision"), discardChanges=options.get("discardChanges", False))
                elif doc_action == "open":
                    payload.update(action="open_document", tabId=raw_tab_id,
                                   filename=options.get("filename", ""), background=options.get("background", False))
                elif doc_action == "save":
                    payload.update(action="save_document", tabId=raw_tab_id,
                                   expectedRevision=message.get("expectedRevision"),
                                   filename=options.get("filename", ""), saveAs=options.get("saveAs", False))
                    if "format" in options: payload["format"] = options["format"]
                elif doc_action == "snapshot":
                    payload.update(action="render_tab", tabId=raw_tab_id, width=options.get("width", 1600))
                elif doc_action == "outline":
                    payload.update(action="outline_tab", tabId=raw_tab_id,
                                   offset=options.get("offset", 0), limit=options.get("limit", 80))
                elif doc_action == "get_context":
                    payload.update(action="get_context", tabId=raw_tab_id, limit=options.get("limit", 6000))
                elif doc_action == "job_status":
                    payload.update(action="job_status", tabId=raw_tab_id,
                                   jobId=message.get("jobId", options.get("jobId", "")))
                elif doc_action == "export_chunk":
                    payload.update(action="export_chunk", jobId=message.get("jobId", ""),
                                   offset=message.get("offset", 0), limit=message.get("limit", 262_144))
                else:
                    raise ValueError("Unsupported native document action")
                return self._canonical_cloud_result(self._remote_call_gui(payload))
            if action == "list_devices":
                return {"devices": [{"deviceId": self.cloudClient._config["deviceId"],
                                     "displayName": self.cloudClient._config["displayName"],
                                     "platform": "desktop", "status": "connected"}]}
            raise ValueError("Unsupported relay action")

        def _call_gui(self, payload: dict[str, Any]) -> dict[str, Any]:
            if not self._enabled:
                raise ValueError("Live desktop access is disabled")
            action = payload.get("action")
            if action not in ("list_tabs", "read_tab", "search_tab", "outline_tab", "patch_tab", "render_tab",
                              "get_tab_image", "get_diagram_image", "get_context", "latex_review", "latex_apply", "export_document",
                              "create_document", "save_document", "open_document", "activate_document", "close_document", "job_status", "export_chunk",
                              "list_diagrams", "get_diagram", "replace_tab_asset", "asset_action"):
                raise ValueError("Unsupported live-tab operation")
            if action not in ("list_tabs", "create_document", "open_document", "job_status", "export_chunk"):
                tab_id = payload.get("tabId")
                if not isinstance(tab_id, str) or not tab_id or len(tab_id) > 128:
                    raise ValueError("tabId is required")
            if action == "create_document":
                content = payload.get("content", "")
                title = payload.get("title", "")
                if not isinstance(content, str) or len(content.encode("utf-8")) > 20_000_000:
                    raise ValueError("New document content must be under 20 MB")
                if not isinstance(title, str) or len(title) > 160 or any(c in title for c in ("/", "\\", "\0")):
                    raise ValueError("title must be a short filename")
                if payload.get("format", "md") not in ("md", "smd"):
                    raise ValueError("format must be md or smd")
                filename = payload.get("filename", "")
                if not isinstance(filename, str) or len(filename) > 160 or any(c in filename for c in ("/", "\\", "\0")):
                    raise ValueError("filename must be a short basename")
            elif action == "save_document":
                revision = payload.get("expectedRevision")
                if not isinstance(revision, str) or len(revision) != 64:
                    raise ValueError("expectedRevision must be the current SHA-256 revision")
                if payload.get("format", "md") not in ("md", "smd"):
                    raise ValueError("format must be md or smd")
            elif action == "open_document":
                filename = payload.get("filename")
                if not isinstance(filename, str) or len(filename) > 4096 or "\0" in filename:
                    raise ValueError("filename must identify an approved note path or be empty to activate a listed tab")
                if not filename and not payload.get("tabId"):
                    raise ValueError("An empty filename requires a listed live tab target")
            elif action == "close_document":
                revision = payload.get("expectedRevision")
                if not isinstance(revision, str) or not re.fullmatch("[0-9a-f]{64}", revision):
                    raise ValueError("expectedRevision must be the current SHA-256 revision")
            for flag in ("background", "saveAs", "discardChanges"):
                if flag in payload and not isinstance(payload[flag], bool):
                    raise ValueError(flag + " must be a boolean")
            if action in ("job_status", "export_chunk"):
                job_id = payload.get("jobId")
                if not isinstance(job_id, str) or not job_id or len(job_id) > 128:
                    raise ValueError("jobId is required")
                if action == "export_chunk":
                    offset, limit = payload.get("offset", 0), payload.get("limit", 262_144)
                    if not isinstance(offset, int) or isinstance(offset, bool) or offset < 0:
                        raise ValueError("offset must be a nonnegative byte offset")
                    if not isinstance(limit, int) or isinstance(limit, bool) or not 1 <= limit <= MAX_EXPORT_CHUNK_BYTES:
                        raise ValueError("limit must be between 1 and 524,288 bytes")
            if action == "read_tab":
                offset, limit = payload.get("offset", 0), payload.get("limit", MAX_SOURCE_PAGE)
                asset_offset, asset_limit = payload.get("assetOffset", 0), payload.get("assetLimit", 0)
                if not isinstance(offset, int) or isinstance(offset, bool) or offset < 0:
                    raise ValueError("offset must be a nonnegative integer")
                if not isinstance(limit, int) or isinstance(limit, bool) or not 1 <= limit <= MAX_SOURCE_PAGE:
                    raise ValueError("limit must be between 1 and 12,000")
                if not isinstance(asset_offset, int) or isinstance(asset_offset, bool) or asset_offset < 0:
                    raise ValueError("assetOffset must be a nonnegative integer")
                if not isinstance(asset_limit, int) or isinstance(asset_limit, bool) or not 0 <= asset_limit <= 50:
                    raise ValueError("assetLimit must be between 0 and 50")
                if payload.get("view", "prose") not in ("prose", "source"):
                    raise ValueError("view must be prose or source")
                heading = payload.get("heading")
                if heading is not None and not (
                        isinstance(heading, int) and not isinstance(heading, bool) and heading >= 0
                        or isinstance(heading, str) and bool(heading.strip()) and len(heading) <= 300):
                    raise ValueError("heading must be an outline index, exact title, slug, or numbered heading prefix")
            elif action == "search_tab":
                query, limit, context = payload.get("query"), payload.get("limit", 10), payload.get("context", 100)
                if not isinstance(query, str) or not query or len(query) > 500:
                    raise ValueError("query must contain between 1 and 500 characters")
                if not isinstance(limit, int) or isinstance(limit, bool) or not 1 <= limit <= 25:
                    raise ValueError("limit must be between 1 and 25")
                if not isinstance(context, int) or isinstance(context, bool) or not 0 <= context <= MAX_SEARCH_CONTEXT:
                    raise ValueError("context must be between 0 and 500")
                if not isinstance(payload.get("offset", 0), int) or isinstance(payload.get("offset", 0), bool) or payload.get("offset", 0) < 0:
                    raise ValueError("offset must be a nonnegative integer")
                for flag in ("caseSensitive", "wholeWord", "regex", "excludeDiagrams"):
                    if flag in payload and not isinstance(payload[flag], bool): raise ValueError(flag + " must be a boolean")
            elif action == "outline_tab":
                offset, limit = payload.get("offset", 0), payload.get("limit", 80)
                if not isinstance(offset, int) or isinstance(offset, bool) or offset < 0:
                    raise ValueError("offset must be a nonnegative integer")
                if not isinstance(limit, int) or isinstance(limit, bool) or not 1 <= limit <= 80:
                    raise ValueError("limit must be between 1 and 80")
            elif action == "patch_tab":
                revision, operations = payload.get("expectedRevision"), payload.get("operations")
                if not isinstance(revision, str) or len(revision) != 64 or any(c not in "0123456789abcdef" for c in revision):
                    raise ValueError("expectedRevision must be the current SHA-256 revision")
                try:
                    from .agent_documents import validate_patch_operations
                except ImportError:
                    from agent_documents import validate_patch_operations
                validate_patch_operations(operations)
                if len(json.dumps(operations, ensure_ascii=False).encode("utf-8")) > MAX_PATCH_BYTES:
                    raise ValueError("Patch operations exceed the 64 KB limit")
            elif action == "render_tab":
                width = payload.get("width", 1600)
                if not isinstance(width, int) or isinstance(width, bool) or not 64 <= width <= 1600:
                    raise ValueError("width must be between 64 and 1,600 pixels")
                if payload.get("imageFormat", "png") not in ("png", "jpeg"):
                    raise ValueError("imageFormat must be png or jpeg")
            elif action == "get_diagram_image":
                if payload.get("imageFormat", "png") not in ("png", "jpeg"):
                    raise ValueError("imageFormat must be png or jpeg")
            elif action == "get_tab_image":
                asset_name, revision = payload.get("assetName"), payload.get("expectedRevision")
                if not isinstance(asset_name, str) or not asset_name or len(asset_name) > 256:
                    raise ValueError("assetName is required")
                if not isinstance(revision, str) or len(revision) != 64 or any(c not in "0123456789abcdef" for c in revision):
                    raise ValueError("expectedRevision must be the current SHA-256 revision")
            if action in ("get_diagram", "get_diagram_image"):
                diagram_id, revision = payload.get("diagramId"), payload.get("expectedRevision")
                if not isinstance(diagram_id, str) or not diagram_id.startswith("diagram:") or len(diagram_id) > 100:
                    raise ValueError("diagramId is invalid")
                if not isinstance(revision, str) or len(revision) != 64 or any(c not in "0123456789abcdef" for c in revision):
                    raise ValueError("expectedRevision must be the current SHA-256 revision")
                if action == "get_diagram":
                    offset, limit = payload.get("offset", 0), payload.get("limit", MAX_SOURCE_PAGE)
                    if not isinstance(offset, int) or isinstance(offset, bool) or offset < 0:
                        raise ValueError("offset must be a nonnegative integer")
                    if not isinstance(limit, int) or isinstance(limit, bool) or not 1 <= limit <= MAX_SOURCE_PAGE:
                        raise ValueError("limit must be between 1 and 12,000")
            elif action == "list_diagrams":
                revision = payload.get("expectedRevision")
                if revision is not None and (not isinstance(revision, str) or len(revision) != 64
                        or any(c not in "0123456789abcdef" for c in revision)):
                    raise ValueError("expectedRevision must be the current SHA-256 revision")
                if isinstance(payload.get("offset", 0), bool) or not isinstance(payload.get("offset", 0), int) or payload.get("offset", 0) < 0:
                    raise ValueError("diagram offset must be a nonnegative integer")
                if isinstance(payload.get("limit", 80), bool) or not isinstance(payload.get("limit", 80), int) or not 1 <= payload.get("limit", 80) <= 80:
                    raise ValueError("diagram limit must be between 1 and 80")
            elif action == "replace_tab_asset":
                if not isinstance(payload.get("assetName"), str) or not isinstance(payload.get("assetPath"), str):
                    raise ValueError("assetName and assetPath are required")
                revision = payload.get("expectedRevision")
                if not isinstance(revision, str) or len(revision) != 64 or any(c not in "0123456789abcdef" for c in revision):
                    raise ValueError("expectedRevision must be the current SHA-256 revision")
            elif action == "asset_action":
                if payload.get("assetAction") not in ("list", "source", "attach"):
                    raise ValueError("assetAction must be list, source, or attach")
                revision = payload.get("expectedRevision")
                if not isinstance(revision, str) or len(revision) != 64 or any(c not in "0123456789abcdef" for c in revision):
                    raise ValueError("expectedRevision must be the current SHA-256 revision")
                kind = payload["assetAction"]
                name = payload.get("assetName")
                if kind in ("source", "attach") and (not isinstance(name, str) or not name or len(name.encode("utf-8")) > 256):
                    if not (kind == "attach" and isinstance(payload.get("assetPath"), str) and payload.get("assetPath")):
                        raise ValueError("assetName is required")
                if kind == "attach":
                    inline = isinstance(payload.get("body"), str)
                    local_path = isinstance(payload.get("assetPath"), str) and bool(payload.get("assetPath"))
                    if inline == local_path:
                        raise ValueError("Attach exactly one of base64 body or local assetPath")
                    if inline and (payload.get("mimeType") not in ("image/png", "image/jpeg", "image/gif", "image/webp", "image/avif", "image/svg+xml")):
                        raise ValueError("Attaching an asset requires a supported image mimeType")
                    if inline and len(payload["body"]) > 1_400_000:
                        raise ValueError("Asset body must be at most 1 MiB")
                    if local_path and len(payload["assetPath"]) > 4096:
                        raise ValueError("Asset path is too long")
                if kind == "list":
                    offset, limit = payload.get("offset", 0), payload.get("limit", 50)
                    if not isinstance(offset, int) or isinstance(offset, bool) or not 0 <= offset <= 512:
                        raise ValueError("offset must be between 0 and 512")
                    if not isinstance(limit, int) or isinstance(limit, bool) or not 1 <= limit <= 50:
                        raise ValueError("limit must be between 1 and 50")
            elif action == "get_context":
                limit = payload.get("limit", 6000)
                if not isinstance(limit, int) or isinstance(limit, bool) or not 1 <= limit <= 12_000:
                    raise ValueError("limit must be between 1 and 12,000")
            elif action == "latex_apply":
                revision, indices = payload.get("expectedRevision"), payload.get("repairIndices")
                if not isinstance(revision, str) or len(revision) != 64 or any(c not in "0123456789abcdef" for c in revision):
                    raise ValueError("expectedRevision must be the current SHA-256 revision")
                if (not isinstance(indices, list) or len(indices) > 40
                        or any(not isinstance(value, int) or isinstance(value, bool) or value < 0 for value in indices)
                        or len(set(indices)) != len(indices)):
                    raise ValueError("repairIndices must be up to 40 unique nonnegative repair indexes")
            elif action == "export_document":
                if payload.get("format") not in ("pdf", "smd", "md"):
                    raise ValueError("format must be pdf, smd, or md")
                revision = payload.get("expectedRevision")
                if not isinstance(revision, str) or len(revision) != 64 or any(c not in "0123456789abcdef" for c in revision):
                    raise ValueError("expectedRevision must be the current SHA-256 revision")
                options = payload.get("options", {})
                if not isinstance(options, dict) or len(json.dumps(options, ensure_ascii=False).encode("utf-8")) > 8_000:
                    raise ValueError("Export options must be an object smaller than 8 KB")
                filename = payload.get("filename", "")
                if not isinstance(filename, str) or len(filename) > 160 or any(c in filename for c in ("/", "\\", "\0")):
                    raise ValueError("filename must be a short basename")
            request_id = uuid.uuid4().hex
            event = threading.Event()
            with self._lock:
                if len(self._pending) >= 16:
                    raise ValueError("The desktop is handling its maximum number of live-agent requests")
                self._pending[request_id] = {"event": event, "payload": payload, "result": None, "error": None,
                                             "cloud": bool(payload.get("_cloud"))}
            self._dispatch.emit(request_id)
            wait_timeout = EXPORT_TIMEOUT if action == "export_document" else REQUEST_TIMEOUT
            if not event.wait(wait_timeout):
                with self._lock:
                    self._pending.pop(request_id, None)
                    for child_id, owner in list(self._dispatches.items()):
                        if owner[0] == request_id:
                            self._dispatches.pop(child_id, None)
                raise TimeoutError
            with self._lock:
                result = self._pending.pop(request_id, None)
            if result is None:
                raise ValueError("Live desktop request was cancelled")
            if result["error"]:
                raise ValueError(str(result["error"]))
            value = result["result"]
            if not isinstance(value, dict):
                raise ValueError("Live tab handler returned an invalid result")
            encoded = json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
            if len(encoded) > MAX_RESPONSE:
                raise ValueError("Live desktop response exceeds 12 MB")
            return value

        @Slot(str)
        def _handle_request(self, request_id: str):
            with self._lock:
                pending = self._pending.get(request_id)
            if pending is None:
                return
            payload = pending["payload"]
            action = payload["action"]
            try:
                immediate = None
                if action == "list_tabs":
                    candidates = [studio for studio in self.session.windows.values() if not studio.retired]
                    if not candidates:
                        raise ValueError("No desktop windows are open")
                    with self._lock:
                        parent = self._pending.get(request_id)
                        if parent is None:
                            return
                        parent["expected"] = len(candidates)
                        parent["aggregate"] = []
                        parent["completed"] = 0
                        parent["fallback"] = {}
                    for studio in candidates:
                        tab_rows = []
                        for tab in studio.tabs:
                            source = tab["content"]
                            tab_rows.append({"id": tab["id"], "windowId": studio.window_id,
                                             "title": tab["name"], "path": tab["path"],
                                             "format": "smd" if tab.get("portable") or str(tab["path"]).lower().endswith(".smd") else "markdown",
                                             "isDirty": tab["content"] != tab["saved"],
                                             "sourceLength": len(source),
                                             "revision": __import__("hashlib").sha256(source.encode("utf-8")).hexdigest(),
                                             "active": tab["id"] == studio.active})
                        child_id = uuid.uuid4().hex
                        with self._lock:
                            self._dispatches[child_id] = (request_id, studio.window_id, "list")
                            if request_id in self._pending:
                                self._pending[request_id]["fallback"][studio.window_id] = tab_rows
                        request = {"action": "list_tabs", "requestId": child_id, "tabs": tab_rows,
                                   "windowId": studio.window_id, "activeTabId": studio.active}
                        studio.agentRequest.emit(json.dumps(request, ensure_ascii=False, separators=(",", ":")))
                    return
                elif action == "create_document":
                    requested_window = payload.get("windowId")
                    studio = next((window for window in self.session.windows.values()
                                   if not window.retired and (not requested_window or window.window_id == requested_window)), None)
                    if studio is None:
                        raise ValueError("No desktop window is available")
                    with self._lock:
                        self._pending[request_id]["window_id"] = studio.window_id
                    self._flush_then_native(request_id, studio, payload)
                    return
                else:
                    tab_id = payload.get("tabId")
                    if action in ("job_status", "export_chunk"):
                        requested_window = payload.get("windowId")
                        origin_tab = payload.get("tabId")
                        studio = next((window for window in self.session.windows.values()
                                       if not window.retired and (not requested_window or window.window_id == requested_window)
                                       and (not origin_tab or any(tab["id"] == origin_tab for tab in window.tabs))
                                       and payload.get("jobId") in getattr(window, "_agent_job_records", {})
                                       and (action != "export_chunk" or
                                            getattr(window, "_agent_job_records", {}).get(payload.get("jobId"), {}).get("action") == "export_document")), None)
                        if studio is None and not requested_window and not origin_tab:
                            candidates = [window for window in self.session.windows.values() if not window.retired
                                          and payload.get("jobId") in getattr(window, "_agent_job_records", {})
                                          and (action != "export_chunk" or
                                               getattr(window, "_agent_job_records", {}).get(payload.get("jobId"), {}).get("action") == "export_document")]
                            studio = candidates[0] if len(candidates) == 1 else None
                        if studio is None:
                            raise ValueError("No desktop window is available")
                        with self._lock:
                            self._pending[request_id]["window_id"] = studio.window_id
                        result = (studio._agent_export_chunk(payload.get("jobId"), payload.get("offset", 0),
                                                            payload.get("limit", 262_144))
                                  if action == "export_chunk" else studio._agent_job_status(payload.get("jobId")))
                        self.complete(request_id, result, window_id=studio.window_id)
                        return
                    if action == "open_document" and not payload.get("tabId"):
                        requested_window = payload.get("windowId")
                        studio = next((window for window in self.session.windows.values()
                                       if not window.retired and (not requested_window or window.window_id == requested_window)), None)
                        if studio is None:
                            raise ValueError("No desktop window is available")
                        with self._lock:
                            self._pending[request_id]["window_id"] = studio.window_id
                        self._flush_then_native(request_id, studio, payload)
                        return
                    if not isinstance(tab_id, str) or not tab_id or len(tab_id) > 128:
                        raise ValueError("tabId is required")
                    requested_window = payload.get("windowId")
                    owner = next((window for window in self.session.windows.values()
                                  if not window.retired
                                  and (not requested_window or window.window_id == requested_window)
                                  and any(tab["id"] == tab_id for tab in window.tabs)), None)
                    if owner is None:
                        raise ValueError("The requested live tab is no longer open")
                    if tab_id != owner.active and action in ("render_tab", "get_context", "get_diagram_image", "latex_review", "latex_apply", "export_document"):
                        raise ValueError("This action needs the active reader view; activate the target tab explicitly first")
                    studio = owner
                if action in ("get_tab_image", "read_tab", "search_tab", "outline_tab", "patch_tab", "activate_document", "close_document"):
                    self._flush_then_native(request_id, studio, payload)
                    return
                if action in ("list_diagrams", "get_diagram", "get_diagram_image"):
                    if action != "get_diagram_image":
                        self._flush_then_native(request_id, studio, payload)
                        return
                    request = {**payload, "requestId": request_id}
                    with self._lock:
                        self._pending[request_id]["window_id"] = studio.window_id
                    studio.agentRequest.emit(json.dumps(request, ensure_ascii=False, separators=(",", ":")))
                    return
                if action == "replace_tab_asset":
                    self._flush_then_native(request_id, studio, payload)
                    return
                if action == "asset_action":
                    self._flush_then_native(request_id, studio, payload)
                    return
                if action in ("save_document", "open_document"):
                    self._flush_then_native(request_id, studio, payload)
                    return
                if immediate is not None:
                    self.complete(request_id, immediate)
                else:
                    request = {**payload, "requestId": request_id}
                    with self._lock:
                        if request_id in self._pending:
                            self._pending[request_id]["window_id"] = studio.window_id
                    studio.agentRequest.emit(json.dumps(request, ensure_ascii=False, separators=(",", ":")))
            except Exception as error:
                self.complete(request_id, None, str(error))

        def _flush_then_native(self, parent_id: str, studio, payload: dict[str, Any]):
            child_id = uuid.uuid4().hex
            with self._lock:
                if parent_id not in self._pending:
                    return
                self._dispatches[child_id] = (parent_id, studio.window_id, "native")
            studio.agentRequest.emit(json.dumps({"action": "flush_current", "requestId": child_id,
                                                 "tabId": studio.active, "windowId": studio.window_id},
                                                ensure_ascii=False, separators=(",", ":")))

        def _native_result(self, payload: dict[str, Any], studio) -> dict[str, Any]:
            action = payload["action"]
            if action == "asset_action":
                return self._asset_action_native(payload, studio)
            if action in ("create_document", "save_document", "open_document", "activate_document", "close_document", "patch_tab", "replace_tab_asset"):
                if action in ("save_document", "close_document", "patch_tab", "replace_tab_asset"):
                    target = next((tab for tab in studio.tabs if tab["id"] == payload.get("tabId")), None)
                    if target is None:
                        raise ValueError("The requested live tab is no longer open")
                    source = target["content"]
                    current_revision = hashlib.sha256(source.encode("utf-8")).hexdigest()
                    expected = payload.get("expectedRevision")
                    if expected is not None and expected != current_revision:
                        raise ValueError(json.dumps({"error": "Revision conflict; inspect the current note before retrying",
                                                     "currentRevision": current_revision,
                                                     "sourceLength": len(source)}))
                return studio._agent_document_action(payload)
            tab_id = payload["tabId"]
            target = next((tab for tab in studio.tabs if tab["id"] == tab_id), None)
            if target is None:
                raise ValueError("The requested live tab is no longer open")
            source = target["content"]
            revision = hashlib.sha256(source.encode("utf-8")).hexdigest()
            if payload.get("expectedRevision") is not None and payload["expectedRevision"] != revision:
                raise ValueError(json.dumps({"error": "Revision conflict; inspect the current note before retrying", "currentRevision": revision, "sourceLength": len(source)}))
            common = {"tabId": tab_id, "windowId": studio.window_id, "revision": revision,
                      "sourceLength": len(source), "title": target["name"], "path": target["path"],
                      "format": "smd" if target.get("portable") or str(target["path"]).lower().endswith(".smd") else "markdown",
                      "isDirty": target["content"] != target["saved"]}
            if action == "read_tab":
                offset, limit = payload.get("offset", 0), payload.get("limit", MAX_SOURCE_PAGE)
                if offset > len(source):
                    raise ValueError("offset must be between 0 and the document character count")
                view = payload.get("view", "prose")
                section_start, section_end = 0, len(source)
                heading = payload.get("heading")
                selected_heading = None
                if heading is not None:
                    try:
                        try:
                            from .agent_documents import _headings, resolve_heading
                        except ImportError:
                            from agent_documents import _headings, resolve_heading
                        selected_heading = resolve_heading(_headings(source, include_internal=True), heading)
                        section_start = selected_heading["sectionStart"]
                        section_end = selected_heading["sectionEnd"]
                        if offset > section_end:
                            raise ValueError(f"offset must be within the selected section (sectionEnd {section_end})")
                        offset = max(section_start, offset)
                    except ImportError:
                        raise ValueError("Heading outlines are unavailable") from None
                spans = []
                end = min(section_end, offset + limit)
                if view == "prose":
                    try:
                        try:
                            from .agent_documents import _prose_page_end, _svg_spans
                        except ImportError:
                            from agent_documents import _prose_page_end, _svg_spans
                        spans = _svg_spans(source)
                        end = _prose_page_end(offset, limit, section_end, spans)
                    except Exception:
                        spans = []
                page_text = source[offset:end]
                omitted = []
                if view == "prose":
                    try:
                        try:
                            from .agent_documents import _elide_svg_page
                        except ImportError:
                            from agent_documents import _elide_svg_page
                        page_text, omitted = _elide_svg_page(source, offset, end, spans)
                    except Exception:
                        omitted = []
                asset_offset, asset_limit = payload.get("assetOffset", 0), payload.get("assetLimit", 0)
                assets = self._asset_metadata(target, asset_offset, asset_limit) if asset_limit else []
                asset_count = len(target.get("assets", {}))
                result = {**common, "offset": offset, "start": offset, "end": end,
                          "markdown": page_text, "text": page_text, "view": view,
                          "omissions": omitted, "totalLength": len(source), "total_chars": section_end - section_start,
                          "sectionStart": section_start, "sectionEnd": section_end, "documentLength": len(source),
                          "next_offset": end if end < section_end else None, "truncated": end < section_end,
                          "returned_chars": len(page_text), "svg_omissions": omitted, "assetCount": asset_count}
                if selected_heading is not None:
                    result["heading"] = {key: selected_heading[key] for key in ("index", "level", "title", "line")}
                if asset_limit:
                    result.update({"assets": assets,
                                   "assetsNextOffset": asset_offset + len(assets) if asset_offset + len(assets) < asset_count else None})
                return result
            if action == "search_tab":
                try:
                    from .agent_documents import search_source
                except ImportError:
                    from agent_documents import search_source
                return {**common, **search_source(source, payload["query"], limit=payload.get("limit", 10), context=payload.get("context", 100),
                       offset=payload.get("offset", 0), case_sensitive=payload.get("caseSensitive", False), whole_word=payload.get("wholeWord", False),
                       regex=payload.get("regex", False), exclude_diagrams=payload.get("excludeDiagrams", False))}
            if action == "outline_tab":
                try:
                    from .agent_documents import outline_source
                except ImportError:
                    from agent_documents import outline_source
                return {**common, **outline_source(source, payload.get("offset", 0), payload.get("limit", 80))}
            if action == "get_tab_image":
                if payload["expectedRevision"] != revision:
                    raise ValueError("Live tab revision changed; inspect again before extracting the image")
                assets = target.get("assets", {})
                asset_name = payload["assetName"]
                if asset_name not in assets:
                    raise ValueError("Asset not found; list exact names with document_assets")
                try:
                    try:
                        from .documents import image_data
                    except ImportError:
                        from documents import image_data
                    mime_type, data = image_data(assets[asset_name])
                except (ValueError, TypeError, KeyError) as error:
                    raise ValueError("The selected asset is invalid") from error
                if not data or len(data) > 8 * 1024 * 1024:
                    raise ValueError("Live asset images are limited to 8 MB")
                return {**common, "asset": asset_name, "mime_type": mime_type,
                        "bytes": len(data), "sha256": hashlib.sha256(data).hexdigest(),
                        "data": base64.b64encode(data).decode("ascii")}
            raise ValueError("Unsupported native live-tab operation")

        def _asset_metadata(self, tab: dict[str, Any], offset: int = 0, limit: int = 50) -> list[dict[str, Any]]:
            try:
                try:
                    from .agent_documents import _asset_metadata
                except ImportError:
                    from agent_documents import _asset_metadata
                return _asset_metadata(tab.get("assets", {}), offset=offset, limit=limit)
            except Exception:
                return []

        def _asset_action_native(self, args: dict[str, Any], studio) -> dict[str, Any]:
            tab_id = args.get("tabId")
            tab = next((item for item in studio.tabs if item["id"] == tab_id), None)
            if tab is None:
                raise ValueError("The requested live tab is no longer open")
            revision = hashlib.sha256(tab["content"].encode("utf-8")).hexdigest()
            if args.get("expectedRevision") != revision:
                raise ValueError("Live tab revision changed; inspect it again before using an asset")
            assets = tab.get("assets", {})
            action = args.get("assetAction")
            try:
                try:
                    from .documents import image_data, open_note, write_portable, MIMES
                except ImportError:
                    from documents import image_data, open_note, write_portable, MIMES
            except ImportError as error:
                raise ValueError("Portable asset handling is unavailable") from error

            def resolve_name(value: str) -> str:
                if value in assets:
                    return value
                name = value if value.startswith("assets/") else "assets/" + value
                if name in assets:
                    return name
                return next((key for key in assets if hashlib.sha256(key.encode("utf-8")).hexdigest() == value), "")

            if action == "list":
                offset, limit = args.get("offset", 0), args.get("limit", 50)
                page = [{"id": item.get("id"), "name": item.get("name"), "mimeType": item.get("mime"),
                         "bytes": item.get("bytes"), "sha256": item.get("sha256"), **({"invalid": True} if item.get("invalid") else {})}
                        for item in self._asset_metadata(tab, offset, limit)]
                total = len(assets)
                next_offset = offset + len(page) if offset + len(page) < total else None
                return {"tabId": tab_id, "revision": revision, "assets": page,
                        "total": total, "nextOffset": next_offset}
            if action == "source":
                name = resolve_name(args.get("assetName", ""))
                if not name:
                    raise ValueError("Asset is not present in the current note")
                try:
                    mime, raw = image_data(assets[name])
                except (ValueError, TypeError) as error:
                    raise ValueError("The embedded image is invalid") from error
                if not 1 <= len(raw) <= MAX_RELAY_ASSET_BYTES:
                    raise ValueError("Original asset retrieval is limited to 1 MiB")
                return {"tabId": tab_id, "revision": revision, "assetName": name, "mimeType": mime,
                        "bytes": len(raw), "sha256": hashlib.sha256(raw).hexdigest(),
                        "body": base64.b64encode(raw).decode("ascii")}
            if action != "attach":
                raise ValueError("Unsupported asset action")
            return studio._agent_document_action(args)

        def complete(self, request_id: str, result: Any, error: str = "", window_id: str = ""):
            with self._lock:
                dispatch = self._dispatches.pop(request_id, None)
                if dispatch:
                    parent_id, expected_window, dispatch_type = dispatch
                    if window_id != expected_window:
                        return False
                    pending = self._pending.get(parent_id)
                    if pending is None:
                        return False
                    if dispatch_type == "native":
                        if error:
                            pending["error"] = str(error)[:1000]
                        else:
                            studio = self.session.windows.get(expected_window)
                            try:
                                if studio is None or studio.retired:
                                    raise ValueError("The target desktop window was closed")
                                if pending["payload"]["action"] in ("list_diagrams", "get_diagram"):
                                    payload = pending["payload"]
                                    target = next((tab for tab in studio.tabs if tab["id"] == payload.get("tabId")), None)
                                    if target is None: raise ValueError("The requested live tab is no longer open")
                                    pending["window_id"] = studio.window_id
                                    request = {**payload, "requestId": parent_id, "_snapshot": True, "content": target["content"]}
                                    studio.agentRequest.emit(json.dumps(request, ensure_ascii=False, separators=(",", ":")))
                                    return True
                                if (pending["payload"]["action"] == "patch_tab"
                                        and pending["payload"].get("tabId") == studio.active):
                                    # Let the active reader apply through its editor/history path. Native
                                    # patches remain appropriate for inactive tabs, where no reader view
                                    # exists and switching tabs would disturb the user's current draft.
                                    pending["window_id"] = studio.window_id
                                    request = {**pending["payload"], "requestId": parent_id}
                                    studio.agentRequest.emit(json.dumps(request, ensure_ascii=False, separators=(",", ":")))
                                    return True
                                pending["result"] = self._native_result(pending["payload"], studio)
                            except Exception as failure:
                                pending["error"] = str(failure)[:1000]
                        pending["event"].set()
                        return True
                    rows = result.get("tabs") if isinstance(result, dict) else None
                    fallback = pending.get("fallback", {}).get(expected_window, [])
                    fallback_by_id = {row.get("id"): row for row in fallback if isinstance(row, dict)}
                    if isinstance(rows, list):
                        for row in rows:
                            if not isinstance(row, dict):
                                continue
                            merged = dict(fallback_by_id.get(row.get("id"), {}))
                            merged.update({key: row[key] for key in (
                                "id", "windowId", "title", "path", "format", "isDirty",
                                "sourceLength", "revision", "active") if key in row})
                            if merged.get("id"):
                                pending["aggregate"].append(merged)
                    else:
                        # Preserve the native snapshot if a renderer is not
                        # ready, while still listing the currently open tab.
                        pending["aggregate"].extend(fallback)
                    pending["completed"] += 1
                    if pending["completed"] < pending["expected"]:
                        return True
                    pending["result"] = {"tabs": pending["aggregate"][:200]}
                    pending["error"] = ""
                    pending["event"].set()
                    return True
                pending = self._pending.get(request_id)
                if pending is None:
                    return False
                if pending.get("window_id") and window_id != pending["window_id"]:
                    return False
                if not error and pending["payload"].get("action") == "patch_tab":
                    studio = self.session.windows.get(window_id)
                    tab_id = pending["payload"].get("tabId")
                    target = next((tab for tab in studio.tabs if tab["id"] == tab_id), None) if studio else None
                    if target is None or not isinstance(result, dict):
                        error = "The requested live tab is no longer open"
                    else:
                        current_revision = hashlib.sha256(target["content"].encode("utf-8")).hexdigest()
                        returned_revision = result.get("revision")
                        if returned_revision != current_revision:
                            error = json.dumps({"error": "Revision conflict; inspect the current note before retrying",
                                                "currentRevision": current_revision,
                                                "sourceLength": len(target["content"])})
                        else:
                            result = dict(result)
                            result.setdefault("tabId", tab_id)
                            result.setdefault("windowId", window_id)
                            result["sourceLength"] = len(target["content"])
                            if "operations" in result:
                                result.setdefault("operation_results", result["operations"])
                elif error and pending["payload"].get("action") == "patch_tab":
                    studio = self.session.windows.get(window_id)
                    tab_id = pending["payload"].get("tabId")
                    target = next((tab for tab in studio.tabs if tab["id"] == tab_id), None) if studio else None
                    expected = pending["payload"].get("expectedRevision")
                    if target is not None:
                        current_revision = hashlib.sha256(target["content"].encode("utf-8")).hexdigest()
                        if expected != current_revision:
                            error = json.dumps({"error": "Revision conflict; inspect the current note before retrying",
                                                "currentRevision": current_revision,
                                                "sourceLength": len(target["content"])})
                if not error and pending["payload"].get("action") in ("list_diagrams", "get_diagram", "get_diagram_image"):
                    studio = self.session.windows.get(window_id)
                    tab_id = pending["payload"].get("tabId")
                    target = next((tab for tab in studio.tabs if tab["id"] == tab_id), None) if studio else None
                    if target is None:
                        error = "The requested live tab is no longer open"
                    elif not isinstance(result, dict):
                        error = "Diagram handler returned an invalid result"
                    else:
                        revision = hashlib.sha256(target["content"].encode("utf-8")).hexdigest()
                        expected = pending["payload"].get("expectedRevision")
                        if result.get("revision") != revision or expected and expected != revision:
                            error = "Live tab changed while its diagrams were being read; inspect again"
                pending["result"] = result
                pending["error"] = str(error)[:1000] if error else ""
                pending["event"].set()
                return True

        def has_pending(self, request_id: str, window_id: str, action: str, tab_id: str) -> bool:
            """Confirm an asynchronous renderer callback still owns its request."""
            with self._lock:
                pending=self._pending.get(request_id)
                if pending is None or pending.get("window_id")!=window_id:
                    return False
                payload=pending.get("payload",{})
                return payload.get("action")==action and payload.get("tabId")==tab_id

    return QtBridge


def create_qt_bridge(session, data_dir: str | os.PathLike[str]):
    """Create the GUI bridge without importing Qt in CLI/MCP-only processes."""
    return _qt_bridge_class()(session, Path(data_dir))
