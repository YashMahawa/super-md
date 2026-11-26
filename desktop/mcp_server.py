"""Authenticated local/cloud MCP server compatibility facade for Super MD documents.

The MCP SDK is imported lazily when server builders or HTTP transports run, so
ordinary desktop startup and the standalone CLI do not load MCP, ASGI, or Qt.
"""
from __future__ import annotations

try:
    from .agent.mcp_http import BearerAuth, _token, main
    from .agent.mcp_tools import build_mcp_server
except ImportError:  # python desktop/mcp_server.py
    from agent.mcp_http import BearerAuth, _token, main
    from agent.mcp_tools import build_mcp_server

__all__ = ["BearerAuth", "_token", "build_mcp_server", "main"]


if __name__ == "__main__":
    raise SystemExit(main())
