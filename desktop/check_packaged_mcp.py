"""Verify that a frozen desktop executable exposes a working MCP stdio server."""
from __future__ import annotations

import argparse
import asyncio
import base64
import gzip
import io
import json
import os
import struct
import subprocess
import sys
import tempfile
from pathlib import Path
import zlib

from mcp import Client
from mcp.client.stdio import StdioServerParameters


def _png_chunk(kind: bytes, payload: bytes) -> bytes:
    body = kind + payload
    return struct.pack(">I", len(payload)) + body + struct.pack(">I", zlib.crc32(body) & 0xffffffff)


def _portable_image_fixture() -> bytes:
    svg = b"<svg xmlns='http://www.w3.org/2000/svg' width='40' height='20'><rect width='40' height='20' fill='#386a57'/></svg>"
    png = (b"\x89PNG\r\n\x1a\n" +
           _png_chunk(b"IHDR", struct.pack(">IIBBBBB", 1, 1, 8, 2, 0, 0, 0)) +
           _png_chunk(b"IDAT", zlib.compress(b"\x00\xff\x20\x10")) +
           _png_chunk(b"IEND", b""))
    unused = b"<svg xmlns='http://www.w3.org/2000/svg'/>"
    markdown = "# Portable export check\n\n![vector](<assets/diagram.svg>)\n\n![pixel](<assets/pixel.png>)\n"
    envelope = {"format": "supermd-smd", "version": 1, "markdown": markdown, "assets": {
        "assets/diagram.svg": "data:image/svg+xml;base64," + base64.b64encode(svg).decode("ascii"),
        "assets/pixel.png": "data:image/png;base64," + base64.b64encode(png).decode("ascii"),
        "assets/unused.svg": "data:image/svg+xml;base64," + base64.b64encode(unused).decode("ascii"),
    }}
    output = io.BytesIO()
    with gzip.GzipFile(fileobj=output, mode="wb", filename="", mtime=0, compresslevel=9) as stream:
        stream.write(json.dumps(envelope, ensure_ascii=False, separators=(",", ":")).encode("utf-8"))
    return output.getvalue()


async def verify(binary: Path) -> None:
    with tempfile.TemporaryDirectory(prefix="supermd-packaged-mcp-") as directory:
        root = Path(directory)
        note = root / "protocol.md"
        source = "# Packaged protocol check\n\nMCP is alive. 🧭 東京\n"
        note.write_bytes(source.encode("utf-8"))
        cli = subprocess.run([str(binary), "agent", "--root", str(root), "read", note.name, "--view", "source"],
                             capture_output=True, timeout=30, check=True,
                             env={**os.environ, "PYTHONIOENCODING": "cp1252"})
        if json.loads(cli.stdout.decode("utf-8"))["result"]["text"] != source:
            raise RuntimeError("Packaged CLI did not preserve UTF-8 source over redirected stdio")
        portable = root / "portable.smd"
        portable_bytes = _portable_image_fixture()
        portable.write_bytes(portable_bytes)
        server_env = None
        if sys.platform == "darwin":
            # The distributed SDK must initialize and serve tools without a
            # Homebrew OpenSSL provider directory on the recipient's Mac.
            modules = root / "empty-openssl-modules"
            modules.mkdir()
            server_env = {"OPENSSL_MODULES": str(modules)}
        params = StdioServerParameters(command=str(binary), args=["agent", "mcp", "--root", str(root)], env=server_env)
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
            for format, filename, magic in (("smd", "Protocol portable.smd", b"\x1f\x8b"), ("pdf", "Protocol print.pdf", b"%PDF-")):
                exported = await client.call_tool("document_action", {"action":"export", "path":note.name, "format":format, "output_path":filename})
                if exported.is_error:
                    detail = exported.content[0].text if exported.content else "no tool output"
                    raise RuntimeError(f"Packaged MCP {format} export failed: {detail}")
                if not (root / filename).read_bytes().startswith(magic):
                    raise RuntimeError(f"Packaged MCP returned invalid {format} bytes")
            exported_portable = await client.call_tool("document_action", {
                "action": "export", "path": portable.name, "format": "pdf", "output_path": "MCP portable.pdf"})
            if exported_portable.is_error:
                detail = exported_portable.content[0].text if exported_portable.content else "no tool output"
                raise RuntimeError(f"Packaged MCP portable image PDF export failed: {detail}")
            if not (root / "MCP portable.pdf").read_bytes().startswith(b"%PDF-"):
                raise RuntimeError("Packaged MCP portable image export returned invalid PDF bytes")

        portable_cli = subprocess.run(
            [str(binary), "agent", "--root", str(root), "export", portable.name, "pdf", "CLI portable.pdf"],
            cwd=root, capture_output=True, timeout=60, check=True,
            env={**os.environ, "PYTHONIOENCODING": "cp1252"})
        if not json.loads(portable_cli.stdout.decode("utf-8")).get("ok"):
            raise RuntimeError("Packaged CLI portable image PDF export returned an unsuccessful result")
        if not (root / "CLI portable.pdf").read_bytes().startswith(b"%PDF-"):
            raise RuntimeError("Packaged CLI portable image export returned invalid PDF bytes")
        if portable.read_bytes() != portable_bytes:
            raise RuntimeError("Packaged portable PDF export modified its compressed SMD source")


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
