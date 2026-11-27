"""Compatibility facade re-exporting split ``desktop/agent/`` live-bridge modules."""
from __future__ import annotations

import sys

if __package__:
    from .agent import cloud_rpc, live_client, live_native, qt_bridge, validators
else:
    from agent import cloud_rpc, live_client, live_native, qt_bridge, validators

_SUBMODULES = (cloud_rpc, live_client, live_native, qt_bridge, validators)

EXPORT_TIMEOUT = live_client.EXPORT_TIMEOUT
MAX_BODY = live_client.MAX_BODY
MAX_EXPORT_CHUNK_BYTES = live_client.MAX_EXPORT_CHUNK_BYTES
MAX_PATCH_BYTES = live_client.MAX_PATCH_BYTES
MAX_RELAY_ASSET_BYTES = live_client.MAX_RELAY_ASSET_BYTES
MAX_RESPONSE = live_client.MAX_RESPONSE
MAX_SEARCH_CONTEXT = live_client.MAX_SEARCH_CONTEXT
MAX_SOURCE_PAGE = live_client.MAX_SOURCE_PAGE
REQUEST_TIMEOUT = live_client.REQUEST_TIMEOUT
LiveBridgeError = live_client.LiveBridgeError
LiveTabClient = live_client.LiveTabClient
read_discovery = live_client.read_discovery
_qt_bridge_class = qt_bridge._qt_bridge_class
create_qt_bridge = qt_bridge.create_qt_bridge

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

_PEER_MODULE = (
    "agent_live"
    if __name__ == "desktop.agent_live"
    else ("desktop.agent_live" if __name__ == "agent_live" else None)
)
if _PEER_MODULE and _PEER_MODULE in sys.modules:
    sys.modules[__name__] = sys.modules[_PEER_MODULE]
