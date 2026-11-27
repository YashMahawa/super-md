"""Loopback HTTP server, discovery lifecycle, and lazy Qt signal/slot bridge."""
from __future__ import annotations

import hashlib
import hmac
import http.server
import json
import os
import secrets
import socketserver
import sys
import threading
import uuid
from pathlib import Path
from typing import Any

try:
    from . import cloud_rpc as _cloud
    from . import live_client as _lc
    from . import live_native as _native
except ImportError:
    from agent import cloud_rpc as _cloud
    from agent import live_client as _lc
    from agent import live_native as _native

_LIST_TAB_KEYS = ("id", "windowId", "title", "path", "format", "isDirty", "sourceLength", "revision", "active")
_ACTIVE_VIEW_ACTIONS = ("render_tab", "get_context", "get_diagram_image", "latex_review", "latex_apply", "export_document")
_FLUSH_NATIVE_ACTIONS = (
    "get_tab_image", "read_tab", "search_tab", "outline_tab", "patch_tab",
    "activate_document", "close_document", "list_diagrams", "get_diagram",
    "replace_tab_asset", "asset_action", "save_document", "open_document",
)


class _LoopbackHTTPServer(http.server.ThreadingHTTPServer):
    def server_bind(self):
        socketserver.TCPServer.server_bind(self)
        self.server_name, self.server_port = str(self.server_address[0]), int(self.server_address[1])


def _is_window_visible(studio) -> bool:
    host = getattr(studio, "host_window", None) if studio is not None else None
    return host is None or bool(host.isVisible())


def _qt_bridge_class():
    """Create the Qt subclass only in the GUI process."""
    from PySide6.QtCore import QObject, Qt, Signal, Slot

    class QtBridge(QObject):
        _dispatch = Signal(str)
        enabledChanged = Signal()
        cloudStatusChanged = Signal(str)

        def __init__(self, session, data_dir: Path):
            super().__init__()
            self.session, self.data_dir = session, Path(data_dir)
            self.discovery_dir = self.data_dir / "agent-sessions"
            self.discovery_path: Path | None = None
            self.session_id, self.token = uuid.uuid4().hex, ""
            self.server: http.server.ThreadingHTTPServer | None = None
            self.thread: threading.Thread | None = None
            self._lock = threading.RLock()
            self._pending: dict[str, dict[str, Any]] = {}
            self._dispatches: dict[str, tuple[str, str, str]] = {}
            self._enabled = False
            try:
                from ..agent_cloud import CloudRelayClient
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
            self.token, bridge = secrets.token_urlsafe(48), self

            class Handler(http.server.BaseHTTPRequestHandler):
                protocol_version, server_version = "HTTP/1.1", "SuperMDLive/1"

                def setup(self):
                    super().setup()
                    self.connection.settimeout(5.0)

                def log_message(self, *_args):
                    return

                def _reply(self, status: int, value: dict[str, Any]):
                    body = json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
                    self.send_response(status)
                    for key, val in (("Content-Type", "application/json; charset=utf-8"), ("Content-Length", str(len(body))),
                                     ("Cache-Control", "no-store"), ("Connection", "close")):
                        self.send_header(key, val)
                    self.end_headers()
                    self.wfile.write(body)

                def do_POST(self):
                    if self.path != "/v1/request":
                        return self._reply(404, {"error": "not found"})
                    port = bridge.server.server_port
                    if self.headers.get("Host", "").lower() not in (f"127.0.0.1:{port}", f"localhost:{port}"):
                        return self._reply(403, {"error": "invalid host"})
                    origin = self.headers.get("Origin")
                    if origin and origin not in (f"http://127.0.0.1:{port}", f"http://localhost:{port}"):
                        return self._reply(403, {"error": "invalid origin"})
                    supplied = self.headers.get("Authorization", "")
                    if not supplied.startswith("Bearer ") or not hmac.compare_digest(supplied[7:], bridge.token):
                        return self._reply(401, {"error": "unauthorized"})
                    try:
                        length = int(self.headers.get("Content-Length", "-1"))
                    except ValueError:
                        length = -1
                    if not 0 <= length <= _lc.MAX_BODY:
                        return self._reply(413, {"error": "request body exceeds 2 MB"})
                    try:
                        payload = json.loads(self.rfile.read(length).decode("utf-8"))
                        if not isinstance(payload, dict):
                            raise TypeError("request must be a JSON object")
                        self._reply(200, {"result": bridge._call_gui(payload)})
                    except TimeoutError:
                        self._reply(504, {"error": "desktop request timed out"})
                    except (ValueError, TypeError) as error:
                        self._reply(400, {"error": str(error)[:1000]})
                    except Exception as error:  # noqa: BLE001
                        self._reply(500, {"error": f"desktop request failed ({type(error).__name__})"})

            self.server = _LoopbackHTTPServer(("127.0.0.1", 0), Handler)
            self.server.daemon_threads = True
            self.server.timeout, self.server.request_queue_size = 0.5, 8
            self.discovery_path = self.discovery_dir / f"{self.session_id}.json"
            payload = {"version": 1, "sessionId": self.session_id, "pid": os.getpid(), "platform": sys.platform,
                       "displayName": "This computer", "host": "127.0.0.1", "port": self.server.server_port, "token": self.token}
            temp = self.discovery_path.with_suffix(".tmp")
            fd = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            try:
                with os.fdopen(fd, "w", encoding="utf-8") as stream:
                    json.dump(payload, stream, separators=(",", ":"))
                    stream.flush()
                    os.fsync(stream.fileno())
                os.replace(temp, self.discovery_path)
                if os.name != "nt":
                    os.chmod(self.discovery_path, 0o600)
            finally:
                temp.unlink(missing_ok=True)
            self._enabled = True
            self.thread = threading.Thread(target=self.server.serve_forever, name="supermd-agent-live", daemon=True)
            self.thread.start()
            self.enabledChanged.emit()
            return self.status()

        def status(self) -> dict[str, Any]:
            return {"enabled": self._enabled, "endpoint": self.endpoint, "sessionId": self.session_id if self._enabled else "",
                    "discoveryPath": str(self.discovery_path) if self._enabled and self.discovery_path else ""}

        def stop(self):
            self.cloudClient.stop()
            self._enabled = False
            server, self.server = self.server, None
            if server:
                server.shutdown()
                server.server_close()
            if self.discovery_path:
                self.discovery_path.unlink(missing_ok=True)
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
                for request_id, _ in cancelled:
                    self._pending.pop(request_id, None)
                cancelled_ids = {request_id for request_id, _ in cancelled}
                for child_id, owner in list(self._dispatches.items()):
                    if owner[0] in cancelled_ids:
                        self._dispatches.pop(child_id, None)
            for _, value in cancelled:
                value["error"] = "Cloud live access was disabled"
                value["event"].set()

        def _remote_call_gui(self, payload: dict[str, Any]) -> dict[str, Any]:
            return self._call_gui({**payload, "_cloud": True})

        _cloud_tab_parts = staticmethod(_cloud.cloud_tab_parts)
        _canonical_cloud_result = staticmethod(_cloud.canonical_cloud_result)

        def handle_cloud_request(self, message: dict[str, Any]) -> dict[str, Any]:
            return _cloud.translate_cloud_request(message, self._remote_call_gui, lambda: self.cloudClient._config)

        def _call_gui(self, payload: dict[str, Any]) -> dict[str, Any]:
            if not self._enabled:
                raise ValueError("Live desktop access is disabled")
            action = _native.validate_live_gui_payload(payload)
            request_id, event = uuid.uuid4().hex, threading.Event()
            with self._lock:
                if len(self._pending) >= 16:
                    raise ValueError("The desktop is handling its maximum number of live-agent requests")
                self._pending[request_id] = {"event": event, "payload": payload, "result": None, "error": None,
                                             "cloud": bool(payload.get("_cloud"))}
            self._dispatch.emit(request_id)
            if not event.wait(_lc.EXPORT_TIMEOUT if action == "export_document" else _lc.REQUEST_TIMEOUT):
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
                raise TypeError("Live tab handler returned an invalid result")
            if len(json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode("utf-8")) > _lc.MAX_RESPONSE:
                raise ValueError("Live desktop response exceeds 12 MB")
            return value

        def _bind_window(self, request_id: str, window_id: str) -> bool:
            with self._lock:
                entry = self._pending.get(request_id)
                if entry is None:
                    return False
                entry["window_id"] = window_id
                return True

        def _emit_to_studio(self, request_id: str, studio, request: dict[str, Any]) -> bool:
            encoded = json.dumps(request, ensure_ascii=False, separators=(",", ":"))
            if not self._bind_window(request_id, studio.window_id):
                return False
            studio.agentRequest.emit(encoded)
            return True

        @Slot(str)
        def _handle_request(self, request_id: str):
            with self._lock:
                pending = self._pending.get(request_id)
            if pending is None:
                return
            payload, action = pending["payload"], pending["payload"]["action"]
            try:
                if action == "list_tabs":
                    candidates = [studio for studio in self.session.windows.values() if not studio.retired]
                    if not candidates:
                        raise ValueError("No desktop windows are open")
                    with self._lock:
                        parent = self._pending.get(request_id)
                        if parent is None:
                            return
                        parent.update(expected=len(candidates), aggregate=[], completed=0, fallback={})
                    for studio in candidates:
                        visible = _is_window_visible(studio)
                        tab_rows = [{"id": t["id"], "windowId": studio.window_id, "title": t["name"], "path": t["path"],
                                     "format": "smd" if t.get("portable") or str(t["path"]).lower().endswith(".smd") else "markdown",
                                     "isDirty": t["content"] != t["saved"], "sourceLength": len(t["content"]),
                                     "revision": hashlib.sha256(t["content"].encode("utf-8")).hexdigest(),
                                     "active": visible and t["id"] == studio.active} for t in studio.tabs]
                        child_id = uuid.uuid4().hex
                        with self._lock:
                            self._dispatches[child_id] = (request_id, studio.window_id, "list")
                            if request_id in self._pending:
                                self._pending[request_id]["fallback"][studio.window_id] = tab_rows
                        studio.agentRequest.emit(json.dumps({"action": "list_tabs", "requestId": child_id, "tabs": tab_rows,
                                                             "windowId": studio.window_id, "activeTabId": studio.active if visible else ""},
                                                            ensure_ascii=False, separators=(",", ":")))
                    return
                if action == "create_document" or (action == "open_document" and not payload.get("tabId")):
                    req_win = payload.get("windowId")
                    studio = next((w for w in self.session.windows.values()
                                   if not w.retired and (not req_win or w.window_id == req_win)), None)
                    if studio is None:
                        raise ValueError("No desktop window is available")
                    if self._bind_window(request_id, studio.window_id):
                        self._flush_then_native(request_id, studio, payload)
                    return
                if action in ("job_status", "export_chunk"):
                    req_win, origin_tab, job_id = payload.get("windowId"), payload.get("tabId"), payload.get("jobId")
                    valid_windows = [
                        w for w in self.session.windows.values()
                        if not w.retired and job_id in getattr(w, "_agent_job_records", {})
                        and (action != "export_chunk" or getattr(w, "_agent_job_records", {}).get(job_id, {}).get("action") == "export_document")
                    ]
                    studio = next((w for w in valid_windows if (not req_win or w.window_id == req_win)
                                   and (not origin_tab or any(t["id"] == origin_tab for t in w.tabs))), None)
                    if studio is None and not req_win and not origin_tab and len(valid_windows) == 1:
                        studio = valid_windows[0]
                    if studio is None:
                        raise ValueError("No desktop window is available")
                    if not self._bind_window(request_id, studio.window_id):
                        return
                    result = (studio._agent_export_chunk(job_id, payload.get("offset", 0), payload.get("limit", 262_144))
                              if action == "export_chunk" else studio._agent_job_status(job_id))
                    self.complete(request_id, result, window_id=studio.window_id)
                    return
                tab_id, req_win = payload.get("tabId"), payload.get("windowId")
                if not isinstance(tab_id, str) or not tab_id or len(tab_id) > 128:
                    raise ValueError("tabId is required")
                studio = next((w for w in self.session.windows.values()
                               if not w.retired and (not req_win or w.window_id == req_win)
                               and any(t["id"] == tab_id for t in w.tabs)), None)
                if studio is None:
                    raise ValueError("The requested live tab is no longer open")
                if tab_id != studio.active and action in _ACTIVE_VIEW_ACTIONS:
                    raise ValueError("This action needs the active reader view; activate the target tab explicitly first")
                if action in _FLUSH_NATIVE_ACTIONS:
                    self._flush_then_native(request_id, studio, payload)
                    return
                self._emit_to_studio(request_id, studio, {**payload, "requestId": request_id})
            except Exception as error:  # noqa: BLE001
                self.complete(request_id, None, str(error))

        def _flush_then_native(self, parent_id: str, studio, _payload: dict[str, Any]):
            child_id = uuid.uuid4().hex
            with self._lock:
                if parent_id not in self._pending:
                    return
                self._dispatches[child_id] = (parent_id, studio.window_id, "native")
            studio.agentRequest.emit(json.dumps({"action": "flush_current", "requestId": child_id,
                                                 "tabId": studio.active, "windowId": studio.window_id},
                                                ensure_ascii=False, separators=(",", ":")))

        def _native_result(self, payload: dict[str, Any], studio) -> dict[str, Any]:
            return _native.native_result(payload, studio, metadata_fn=self._asset_metadata, asset_action_fn=self._asset_action_native)

        def _asset_metadata(self, tab: dict[str, Any], offset: int = 0, limit: int = 50) -> list[dict[str, Any]]:
            return _native.asset_metadata(tab, offset, limit)

        def _asset_action_native(self, args: dict[str, Any], studio) -> dict[str, Any]:
            return _native.asset_action_native(args, studio, metadata_fn=self._asset_metadata)

        _is_async_native_action = staticmethod(_native.is_async_native_action)
        _verify_native_write_revision = staticmethod(_native.verify_native_write_revision)

        def _finish_pending(self, request_id: str, result: Any, error: str = "", *, expected_window: str = "") -> bool:
            with self._lock:
                pending = self._pending.get(request_id)
                if pending is None or (expected_window and pending.get("window_id") and expected_window != pending["window_id"]):
                    return False
                pending["result"], pending["error"] = result, (str(error)[:1000] if error else "")
                event = pending["event"]
            event.set()
            return True

        def complete(self, request_id: str, result: Any, error: str = "", window_id: str = ""):
            with self._lock:
                dispatch = self._dispatches.get(request_id)
                if dispatch is not None:
                    parent_id, expected_window, dispatch_type = dispatch
                    if window_id != expected_window:
                        return False
                    self._dispatches.pop(request_id, None)
                    pending = self._pending.get(parent_id)
                    if pending is None:
                        return False
                    payload = pending["payload"]
                    fallback = list(pending.get("fallback", {}).get(expected_window, [])) if dispatch_type == "list" else []
                else:
                    parent_id, expected_window, dispatch_type = request_id, window_id, ""
                    pending = self._pending.get(request_id)
                    if pending is None or (pending.get("window_id") and window_id != pending["window_id"]):
                        return False
                    payload, fallback = pending["payload"], []

            if dispatch_type == "native":
                if error:
                    return self._finish_pending(parent_id, None, str(error)[:1000])
                studio = self.session.windows.get(expected_window)
                try:
                    if studio is None or studio.retired:
                        raise ValueError("The target desktop window was closed")
                    visible = _is_window_visible(studio)
                    if payload["action"] in ("list_diagrams", "get_diagram"):
                        target = next((tab for tab in studio.tabs if tab["id"] == payload.get("tabId")), None)
                        if target is None:
                            raise ValueError("The requested live tab is no longer open")
                        request = ({**payload, "requestId": parent_id} if visible and payload.get("tabId") == studio.active else {
                            **payload, "requestId": parent_id, "_snapshot": True, "content": target["content"],
                            "path": target.get("path", ""), "python": studio.settings.get("python", "embedded")})
                        return self._emit_to_studio(parent_id, studio, request)
                    if payload["action"] == "patch_tab" and visible and payload.get("tabId") == studio.active:
                        return self._emit_to_studio(parent_id, studio, {**payload, "requestId": parent_id})
                    async_handler = getattr(studio, "_agent_document_action_async", None)
                    if self._is_async_native_action(payload) and callable(async_handler):
                        self._verify_native_write_revision(payload, studio)
                        if not self._bind_window(parent_id, studio.window_id):
                            return False
                        async_handler(payload, lambda res, err: self._finish_pending(
                            parent_id, res, err or "", expected_window=studio.window_id))
                        return True
                    executed = self._native_result(payload, studio)
                except Exception as failure:  # noqa: BLE001
                    return self._finish_pending(parent_id, None, str(failure)[:1000])
                return self._finish_pending(parent_id, executed)

            if dispatch_type == "list":
                rows = result.get("tabs") if isinstance(result, dict) else None
                fallback_by_id = {row.get("id"): row for row in fallback if isinstance(row, dict)}
                owner_visible = _is_window_visible(self.session.windows.get(expected_window))
                merged_rows = ([m for row in rows if isinstance(row, dict)
                                if (m := {**fallback_by_id.get(row.get("id"), {}),
                                          **{k: row[k] for k in _LIST_TAB_KEYS if k in row},
                                          **({} if owner_visible else {"active": False})}).get("id")]
                               if isinstance(rows, list) else list(fallback))
                event = None
                with self._lock:
                    parent_entry = self._pending.get(parent_id)
                    if parent_entry is None:
                        return False
                    parent_entry["aggregate"].extend(merged_rows)
                    parent_entry["completed"] += 1
                    if parent_entry["completed"] >= parent_entry["expected"]:
                        parent_entry["result"], parent_entry["error"] = {"tabs": parent_entry["aggregate"][:200]}, ""
                        event = parent_entry["event"]
                if event is not None:
                    event.set()
                return True

            result, error = _native.finalize_renderer_result(
                payload, result, error, self.session.windows.get(window_id), window_id)
            return self._finish_pending(request_id, result, error, expected_window=window_id)

        def has_pending(self, request_id: str, window_id: str, action: str, tab_id: str) -> bool:
            with self._lock:
                pending = self._pending.get(request_id)
                if pending is None or pending.get("window_id") != window_id:
                    return False
                payload = pending.get("payload", {})
                return payload.get("action") == action and payload.get("tabId") == tab_id

    return QtBridge


def create_qt_bridge(session, data_dir: str | os.PathLike[str]):
    """Create the GUI bridge without importing Qt in CLI/MCP-only processes."""
    return _qt_bridge_class()(session, Path(data_dir))
