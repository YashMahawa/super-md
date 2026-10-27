"""Verify that a frozen desktop executable exposes a working MCP stdio server."""
from __future__ import annotations

import argparse
import asyncio
import tempfile
from pathlib import Path

from mcp import Client
from mcp.client.stdio import StdioServerParameters


async def verify(binary: Path) -> None:
    with tempfile.TemporaryDirectory(prefix="supermd-packaged-mcp-") as directory:
        root = Path(directory)
        note = root / "protocol.md"
        note.write_text("# Packaged protocol check\n\nMCP is alive.\n", encoding="utf-8")
        params = StdioServerParameters(command=str(binary), args=["agent", "mcp", "--root", str(root)])
        async with Client(params) as client:
            tools = await client.list_tools()
            names = {tool.name for tool in tools.tools}
            if "document_inspect" not in names or len(names) > 9:
                raise RuntimeError(f"Packaged MCP tool list is invalid: {sorted(names)}")
            result = await client.call_tool("document_inspect", {"path": note.name})
            if result.is_error or result.structured_content is None:
                detail = result.content[0].text if result.content else "no tool output"
                raise RuntimeError(f"Packaged MCP inspect failed: {detail}")
            if result.structured_content.get("characters") != len(note.read_text(encoding="utf-8")):
                raise RuntimeError("Packaged MCP returned incorrect document metadata")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("binary", type=Path, help="Frozen super-md executable (console launcher on Windows)")
    args = parser.parse_args()
    binary = args.binary.resolve(strict=True)
    asyncio.run(verify(binary))
    print("Packaged MCP stdio protocol check passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
