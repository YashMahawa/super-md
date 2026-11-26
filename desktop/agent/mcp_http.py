"""HTTP bearer gate, token loader, and CLI entrypoint for the Super MD MCP server."""
from __future__ import annotations

import argparse
import hmac
import os
import sys
from pathlib import Path

_DESKTOP_DIR = str(Path(__file__).resolve().parents[1])
if _DESKTOP_DIR not in sys.path:
    sys.path.insert(0, _DESKTOP_DIR)

from .mcp_tools import build_mcp_server


class BearerAuth:
    def __init__(self, app, token: str):
        self.app, self.expected = app, token.encode("utf-8")

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        supplied = {k.lower(): v for k, v in scope.get("headers", [])}.get(b"authorization", b"")
        if not (supplied.startswith(b"Bearer ") and hmac.compare_digest(supplied[7:], self.expected)):
            body = b"Unauthorized"
            hdrs = [(b"content-type", b"text/plain; charset=utf-8"), (b"content-length", str(len(body)).encode()), (b"www-authenticate", b"Bearer")]
            await send({"type": "http.response.start", "status": 401, "headers": hdrs})
            await send({"type": "http.response.body", "body": body})
            return
        await self.app(scope, receive, send)


def _token(args) -> str:
    token = os.environ.get("SUPERMD_MCP_TOKEN", "")
    if args.token_file:
        token_path = Path(args.token_file).expanduser()
        if token_path.is_symlink():
            raise ValueError("Refusing a symlink token file")
        if os.name == "posix" and token_path.stat().st_mode & 0o077:
            raise ValueError("Token file must not be readable by group or other users (chmod 600)")
        token = token_path.read_text(encoding="utf-8").strip()
    if len(token) < 32:
        raise ValueError("HTTP MCP requires SUPERMD_MCP_TOKEN or --token-file with a token of at least 32 characters")
    return token


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Super MD MCP server")
    parser.add_argument("--root", action="append", default=[], help="Explicit allowed workspace root (repeatable); optional for live-only")
    parser.add_argument("--transport", choices=("stdio", "streamable-http"), default="stdio")
    parser.add_argument("--host", default="127.0.0.1", help="HTTP bind address; defaults to loopback")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--token-file", help="Read HTTP bearer token from this file (never pass token on command line)")
    parser.add_argument("--live-sessions-dir", help="Opt in to currently open desktop tabs from this private discovery folder")
    parser.add_argument("--allow-host", action="append", help="Exact HTTP Host allowlist entry; repeatable for public/proxy deployment")
    parser.add_argument("--allow-origin", action="append", help="Exact browser Origin allowlist entry; repeatable")
    args = parser.parse_args(argv)
    try:
        live_client = None
        if args.live_sessions_dir:
            try:
                from ..agent_live_client import MultiSessionLiveClient
            except ImportError:
                from agent_live_client import MultiSessionLiveClient
            live_client = MultiSessionLiveClient(args.live_sessions_dir)
        if not args.root and live_client is None:
            raise ValueError("Provide at least one --root or --live-sessions-dir")
        server, _ = build_mcp_server(args.root, live_client=live_client)
        if args.transport == "stdio":
            server.run(transport="stdio")
            return 0
        if not 1 <= args.port <= 65535:
            raise ValueError("port must be between 1 and 65535")
        token = _token(args)
        import uvicorn
        from mcp.server.transport_security import TransportSecuritySettings
        kwargs = {"host": args.host, "port": args.port, "streamable_http_path": "/mcp", "max_request_body_size": 2 * 1024 * 1024}
        if args.host in ("127.0.0.1", "localhost", "::1"):
            if args.allow_host or args.allow_origin:
                raise ValueError("Loopback mode uses the SDK's built-in localhost DNS-rebinding protection; remove allowlists")
        elif not args.allow_host:
            raise ValueError("Non-loopback HTTP requires explicit --allow-host entries")
        else:
            kwargs["transport_security"] = TransportSecuritySettings(allowed_hosts=args.allow_host, allowed_origins=args.allow_origin or [])
        uvicorn.run(BearerAuth(server.streamable_http_app(**kwargs), token), host=args.host, port=args.port,
                    access_log=False, timeout_keep_alive=10, limit_concurrency=64, log_level="warning")
        return 0
    except (ValueError, OSError, ImportError) as exc:
        print(f"Super MD MCP server: {exc}", file=sys.stderr)
        return 2


if __name__ in ("agent.mcp_http", "desktop.agent.mcp_http"):
    sys.modules.setdefault("agent.mcp_http", sys.modules[__name__])
    sys.modules.setdefault("desktop.agent.mcp_http", sys.modules[__name__])
