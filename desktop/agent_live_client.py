"""Bridge explicitly enabled desktop sessions into one stable MCP tab namespace."""
from __future__ import annotations

import os
import platform
import threading
from pathlib import Path
from typing import Any

try:
    from .agent_live import LiveTabClient, read_discovery
except ImportError:
    from agent_live import LiveTabClient, read_discovery


class MultiSessionLiveClient:
    """Resolve global ``session:window:tab`` ids without exposing bridge tokens."""

    def __init__(self, sessions_dir: str | os.PathLike[str]):
        directory = Path(sessions_dir).expanduser()
        if directory.is_symlink():
            raise ValueError("Live discovery directory must not be a symlink")
        self.directory = directory.resolve(strict=True)
        if not self.directory.is_dir():
            raise ValueError("Live discovery path must be a directory")
        if os.name == "posix" and self.directory.stat().st_mode & 0o077:
            raise ValueError("Live discovery directory must be private (mode 700)")
        self._lock = threading.RLock()
        self._sessions: dict[str, tuple[LiveTabClient, dict[str, tuple[str, str]]]] = {}
        self._jobs: dict[str, tuple[str, LiveTabClient, str, str, str]] = {}
        self._export_jobs: dict[str, tuple[str, LiveTabClient, str, str, str]] = {}

    def _refresh(self) -> list[dict[str, Any]]:
        sessions: dict[str, tuple[LiveTabClient, dict[str, tuple[str, str]]]] = {}
        rows: list[dict[str, Any]] = []
        discovery_files = sorted(self.directory.glob("*.json"))[:64]
        for path in discovery_files:
            if path.is_symlink():
                continue
            try:
                discovery = read_discovery(path)
                session_id = discovery["sessionId"]
                client = LiveTabClient(discovery)
                response = client.list_tabs()
                tabs = response.get("tabs", [])
                if not isinstance(tabs, list):
                    continue
                local_ids: dict[str, tuple[str, str]] = {}
                for tab in tabs[:200]:
                    if not isinstance(tab, dict) or not isinstance(tab.get("id"), str) or not tab["id"]:
                        continue
                    local_id = tab["id"]
                    window_id = str(tab.get("windowId", "window"))[:128]
                    qualified = f"{session_id}:{window_id}:{local_id}"
                    local_ids[qualified] = (local_id, window_id)
                    row = {key: value for key, value in tab.items()
                           if key in ("title", "path", "format", "isDirty", "sourceLength", "revision", "active")}
                    row.update({"id": qualified, "windowId": window_id, "sessionId": session_id})
                    rows.append(row)
                sessions[session_id] = (client, local_ids)
            except Exception:
                # A closed or stale session is omitted. Do not expose discovery
                # contents, authentication material, or exception messages.
                continue
        with self._lock:
            self._sessions = sessions
        return rows

    def list_tabs(self) -> dict[str, Any]:
        return {"tabs": self._refresh()}

    def _route(self, tab_id: str) -> tuple[LiveTabClient, str, str]:
        # MCP document targets are exposed as ``tab:<session>:<window>:<tab>``;
        # list_tabs and the lower-level client use the bare qualified ID.
        if isinstance(tab_id, str) and tab_id.startswith("tab:"):
            tab_id = tab_id[4:]
        with self._lock:
            for _session, (client, local_ids) in self._sessions.items():
                if tab_id in local_ids:
                    local_id, window_id = local_ids[tab_id]
                    return client, local_id, window_id
        # Refreshing lets a newly opened tab be addressed after one list call.
        self._refresh()
        with self._lock:
            for _session, (client, local_ids) in self._sessions.items():
                if tab_id in local_ids:
                    local_id, window_id = local_ids[tab_id]
                    return client, local_id, window_id
        raise ValueError("Live tab is no longer open; call list_sessions again")

    def read_tab(self, tab_id: str, offset: int = 0, limit: int = 12_000,
                 asset_offset: int = 0, asset_limit: int = 0, view: str = "prose",
                 heading: int | str | None = None) -> dict[str, Any]:
        client, local_id, window_id = self._route(tab_id)
        params = {"offset": offset, "limit": limit, "window_id": window_id,
                  "asset_offset": asset_offset, "asset_limit": asset_limit, "view": view}
        if heading is not None:
            params["heading"] = heading
        return client.read_tab(local_id, **params)

    def search_tab(self, tab_id: str, query: str, limit: int = 10, context: int = 100,
                   offset: int = 0, case_sensitive: bool = False, whole_word: bool = False,
                   regex: bool = False, exclude_diagrams: bool = False) -> dict[str, Any]:
        client, local_id, window_id = self._route(tab_id)
        return client.search_tab(local_id, query=query, limit=limit, context=context, offset=offset,
                                 case_sensitive=case_sensitive, whole_word=whole_word, regex=regex,
                                 exclude_diagrams=exclude_diagrams, window_id=window_id)

    def outline_tab(self, tab_id: str, offset: int = 0, limit: int = 80) -> dict[str, Any]:
        client, local_id, window_id = self._route(tab_id)
        method = getattr(client, "outline_tab", None)
        if not callable(method):
            raise ValueError("Live heading outlines are not available from this desktop bridge")
        return method(local_id, window_id=window_id, offset=offset, limit=limit)

    def patch_tab(self, tab_id: str, expected_revision: str, operations: list[dict[str, Any]]) -> dict[str, Any]:
        client, local_id, window_id = self._route(tab_id)
        return client.patch_tab(local_id, expected_revision=expected_revision, operations=operations, window_id=window_id)

    def render_tab(self, tab_id: str, width: int = 1600, image_format: str = "png") -> dict[str, Any]:
        client, local_id, window_id = self._route(tab_id)
        return client.render_tab(local_id, width=width, image_format=image_format, window_id=window_id)

    def get_tab_image(self, tab_id: str, *, asset_name: str, expected_revision: str):
        client, local_id, window_id = self._route(tab_id)
        method = getattr(client, "get_tab_image", None)
        if not callable(method):
            raise ValueError("Live asset images are not available from this desktop bridge")
        return method(local_id, asset_name=asset_name, expected_revision=expected_revision, window_id=window_id)

    def document_action(self, tab_id: str | None, action: str, **params):
        """Dispatch one documented live-document action to its owning window."""
        allowed = {"create_document", "save_document", "open_document", "activate_document", "close_document", "export_document",
                   "job_status", "export_chunk", "get_context", "latex_review", "latex_apply",
                   "list_diagrams", "get_diagram", "get_diagram_image", "replace_tab_asset"}
        if action not in allowed:
            raise ValueError("Unsupported live document action")
        if action == "job_status":
            external_id = params.get("job_id")
            with self._lock:
                saved = self._jobs.get(external_id) if isinstance(external_id, str) else None
            if saved is None:
                raise ValueError("Export job is unknown or expired; start a new export")
            session_id, client, raw_id, local_id, window_id = saved
            result = client.document_action(local_id, action, window_id=window_id, job_id=raw_id)
            if isinstance(result, dict):
                result = dict(result)
                result["jobId"] = external_id
                result_tab_id = result.get("tabId") or result.get("id")
                if isinstance(result_tab_id, str) and result_tab_id and window_id:
                    result["target"] = f"tab:{session_id}:{window_id}:{result_tab_id}"
                if result.get("status") in ("completed", "failed", "cancelled"):
                    with self._lock:
                        self._jobs.pop(external_id, None)
            return result
        if action == "export_chunk":
            external_id = params.get("job_id")
            with self._lock:
                saved = self._export_jobs.get(external_id) if isinstance(external_id, str) else None
            if saved is None:
                raise ValueError("Export artifact job is unknown or expired")
            _session_id, client, raw_id, _local_id, window_id = saved
            return client.document_action("", action, window_id=window_id, job_id=raw_id,
                                          offset=params.get("offset", 0), limit=params.get("limit", 262_144))
        if action == "create_document" or (action == "open_document" and not tab_id):
            self._refresh()
            requested_device = params.pop("device_id", None)
            with self._lock:
                choices = list(self._sessions.items())
            if requested_device not in (None, "local"):
                choices = [(key, item) for key, item in choices if key == requested_device]
            if not choices:
                raise ValueError("No live desktop session is available")
            session_id, (client, _local_ids) = choices[0]
            result = client.document_action("", action, **params)
        else:
            if not tab_id:
                raise ValueError(f"{action} requires a current tab target")
            client, local_id, window_id = self._route(tab_id)
            if action == "open_document" and params.get("filename") is not None:
                filename = params["filename"]
                if filename != "" and (not isinstance(filename, str) or len(filename) > 4096 or "\0" in filename):
                    raise ValueError("open_document filename must be a bounded path or basename")
            result = client.document_action(local_id, action, window_id=window_id, **params)
            session_id = tab_id.split(":", 1)[0]
        if action == "export_document" and isinstance(result, dict):
            raw_id = result.get("jobId")
            if not isinstance(raw_id, str) or not raw_id or len(raw_id) > 128:
                raise ValueError("Desktop returned an invalid export job ID")
            external_id = f"{session_id}:{raw_id}"
            with self._lock:
                saved = (session_id, client, raw_id, local_id, window_id)
                self._jobs[external_id] = saved
                self._export_jobs[external_id] = saved
                while len(self._export_jobs) > 100:
                    self._export_jobs.pop(next(iter(self._export_jobs)))
            result = dict(result)
            result["jobId"] = external_id
        if action == "open_document" and isinstance(result, dict) and result.get("status") == "opening":
            raw_id = result.get("jobId")
            if not isinstance(raw_id, str) or not raw_id or len(raw_id) > 128:
                raise ValueError("Desktop returned an invalid open job ID")
            actual_window_id = result.get("windowId")
            if not isinstance(actual_window_id, str) or not actual_window_id:
                raise ValueError("Desktop returned an invalid open job window")
            external_id = f"{session_id}:{raw_id}"
            with self._lock:
                self._jobs[external_id] = (session_id, client, raw_id, "", actual_window_id)
            result = dict(result)
            result["jobId"] = external_id
        if action in ("create_document", "save_document", "open_document") and isinstance(result, dict):
            raw_tab_id = result.get("tabId") or result.get("id")
            window_id = result.get("windowId")
            if isinstance(raw_tab_id, str) and raw_tab_id and isinstance(window_id, str) and window_id:
                result = dict(result)
                result["target"] = f"tab:{session_id}:{window_id}:{raw_tab_id}"
        return result

    def list_devices(self) -> dict[str, Any]:
        """Report the connected local host as an actionable device without private tokens."""
        return {"devices": [{"id": "local", "name": "This computer",
                              "platform": platform.system().lower(), "available": True,
                              "sessionCount": len(self._refresh())}], "count": 1}

    def attach_tab(self, tab_id: str, *, asset_path: str, expected_revision: str, name: str | None = None):
        client, local_id, window_id = self._route(tab_id)
        method = getattr(client, "attach_tab", None)
        if not callable(method):
            raise ValueError("Attaching files to live tabs is not available from this desktop bridge")
        return method(local_id, asset_path=asset_path, expected_revision=expected_revision, name=name,
                      window_id=window_id)
