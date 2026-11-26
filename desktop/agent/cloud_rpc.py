"""Qt-free cloud relay RPC translation helpers for live desktop tabs."""
from __future__ import annotations

from collections.abc import Callable
from typing import Any

_DIRECT_TAB_ACTIONS = (
    "read_tab", "search_tab", "patch_tab", "render_tab", "list_diagrams",
    "get_diagram", "get_diagram_image", "replace_tab_asset", "asset_action",
)
_BASE_FORWARDED_FIELDS = (
    "expectedRevision", "operations", "offset", "limit", "query", "context",
    "width", "caseSensitive", "wholeWord", "regex", "excludeDiagrams",
    "diagramId", "assetName", "assetPath", "assetAction", "mimeType",
    "body", "view", "heading",
)


def cloud_tab_parts(tab_id: str) -> tuple[str | None, str]:
    """Split an optional ``windowId:tabId`` cloud identifier into its local components."""
    if not isinstance(tab_id, str):
        return None, ""
    if ":" not in tab_id:
        return None, tab_id
    window_id, raw_id = tab_id.split(":", 1)
    return (window_id or None), raw_id


def canonical_cloud_result(result: dict[str, Any]) -> dict[str, Any]:
    """Qualify returned ``tabId`` values with ``windowId:`` for relay callers."""
    result = dict(result)
    raw, window = result.get("tabId"), result.get("windowId")
    if isinstance(raw, str) and raw and isinstance(window, str) and window and not raw.startswith(window + ":"):
        result["nativeTabId"] = raw
        result["tabId"] = window + ":" + raw
    return result


def translate_cloud_request(
    message: dict[str, Any],
    call_gui: Callable[[dict[str, Any]], dict[str, Any]],
    device_config_getter: Callable[[], dict[str, Any]],
) -> dict[str, Any]:
    """Translate the relay's constrained RPC envelope into local GUI bridge actions."""
    action = message.get("action")
    tab_id = message.get("tabId", "")
    window_id, raw_tab_id = cloud_tab_parts(tab_id) if tab_id else (None, "")
    window_id = message.get("windowId") or window_id
    payload: dict[str, Any] = {"action": action}
    if action in ("list_tabs",):
        result = call_gui(payload)
        for row in result.get("tabs", []):
            row["tabId"] = f"{row.get('windowId', '')}:{row.get('id', '')}"
            row["id"] = row["tabId"]
        return result
    if action in _DIRECT_TAB_ACTIONS:
        payload.update({"tabId": raw_tab_id, "windowId": window_id})
        fields = _BASE_FORWARDED_FIELDS + (("imageFormat",) if action in ("render_tab", "get_diagram_image") else ())
        for key in fields:
            if key in message:
                payload[key] = message[key]
        return canonical_cloud_result(call_gui(payload))
    if action == "document_action":
        doc_action = message.get("documentAction")
        options = message.get("options") if isinstance(message.get("options"), dict) else {}
        payload = {"windowId": window_id}
        if doc_action == "create":
            filename = options.get("filename", "")
            inferred = "smd" if isinstance(filename, str) and filename.lower().endswith(".smd") else "md"
            payload.update(action="create_document", content=message.get("content", ""),
                           title=options.get("title", ""), filename=filename,
                           background=options.get("background", False), format=options.get("format", inferred))
        elif doc_action == "export":
            payload.update(
                action="export_document", tabId=raw_tab_id, expectedRevision=message.get("expectedRevision"),
                format=options.get("format", "pdf"), filename=options.get("filename", ""),
                options={key: value for key, value in options.items() if key not in ("format", "filename")},
            )
        elif doc_action in ("latexfix", "latex_review", "latex_apply"):
            indices = message.get("repairIndices", options.get("repairIndices"))
            apply = doc_action == "latex_apply" or (doc_action == "latexfix" and indices is not None)
            payload.update(action="latex_apply" if apply else "latex_review", tabId=raw_tab_id)
            if apply:
                payload.update(expectedRevision=message.get("expectedRevision"), repairIndices=indices)
        elif doc_action in ("activate", "close"):
            payload.update(action=doc_action + "_document", tabId=raw_tab_id)
            if doc_action == "close":
                payload.update(expectedRevision=message.get("expectedRevision"),
                               discardChanges=options.get("discardChanges", False))
        elif doc_action == "open":
            payload.update(action="open_document", tabId=raw_tab_id, filename=options.get("filename", ""),
                           background=options.get("background", False))
        elif doc_action == "save":
            payload.update(action="save_document", tabId=raw_tab_id,
                           expectedRevision=message.get("expectedRevision"),
                           filename=options.get("filename", ""), saveAs=options.get("saveAs", False))
            if "format" in options:
                payload["format"] = options["format"]
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
        return canonical_cloud_result(call_gui(payload))
    if action == "list_devices":
        config = device_config_getter()
        return {"devices": [{"deviceId": config["deviceId"], "displayName": config["displayName"],
                             "platform": "desktop", "status": "connected"}]}
    raise ValueError("Unsupported relay action")
