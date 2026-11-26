"""Authenticated local/cloud MCP server compatibility facade for Super MD documents."""
from __future__ import annotations

import sys
from pathlib import Path

_DESKTOP_DIR = str(Path(__file__).resolve().parent)
if _DESKTOP_DIR not in sys.path:
    sys.path.insert(0, _DESKTOP_DIR)

try:
    from .agent.mcp_http import BearerAuth, _token, main
    from .agent.mcp_tools import build_mcp_server
except ImportError:  # python desktop/mcp_server.py
    from agent.mcp_http import BearerAuth, _token, main
    from agent.mcp_tools import build_mcp_server

if __name__ in ("mcp_server", "desktop.mcp_server"):
    sys.modules.setdefault("mcp_server", sys.modules[__name__])
    sys.modules.setdefault("desktop.mcp_server", sys.modules[__name__])

__all__ = ["BearerAuth", "_token", "build_mcp_server", "main"]

if __name__ == "__main__":
    raise SystemExit(main())
