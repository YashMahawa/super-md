"""Authenticated, loopback-only bridge compatibility facade for desktop reader tabs."""
from __future__ import annotations

try:
    from .agent.live_client import (
        EXPORT_TIMEOUT,
        MAX_BODY,
        MAX_EXPORT_CHUNK_BYTES,
        MAX_PATCH_BYTES,
        MAX_RELAY_ASSET_BYTES,
        MAX_RESPONSE,
        MAX_SEARCH_CONTEXT,
        MAX_SOURCE_PAGE,
        REQUEST_TIMEOUT,
        LiveBridgeError,
        LiveTabClient,
        read_discovery,
    )
    from .agent.qt_bridge import _qt_bridge_class, create_qt_bridge
except ImportError:
    from agent.live_client import (
        EXPORT_TIMEOUT,
        MAX_BODY,
        MAX_EXPORT_CHUNK_BYTES,
        MAX_PATCH_BYTES,
        MAX_RELAY_ASSET_BYTES,
        MAX_RESPONSE,
        MAX_SEARCH_CONTEXT,
        MAX_SOURCE_PAGE,
        REQUEST_TIMEOUT,
        LiveBridgeError,
        LiveTabClient,
        read_discovery,
    )
    from agent.qt_bridge import _qt_bridge_class, create_qt_bridge

__all__ = [
    "EXPORT_TIMEOUT",
    "MAX_BODY",
    "MAX_EXPORT_CHUNK_BYTES",
    "MAX_PATCH_BYTES",
    "MAX_RELAY_ASSET_BYTES",
    "MAX_RESPONSE",
    "MAX_SEARCH_CONTEXT",
    "MAX_SOURCE_PAGE",
    "REQUEST_TIMEOUT",
    "LiveBridgeError",
    "LiveTabClient",
    "_qt_bridge_class",
    "create_qt_bridge",
    "read_discovery",
]
