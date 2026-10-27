"""Headless, token-conscious Super MD document CLI (stdlib + documents.py only)."""
from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

try:
    from .agent_documents import AgentDocumentError, DocumentStore
except ImportError:  # python desktop/agent_cli.py
    from agent_documents import AgentDocumentError, DocumentStore


class _UsageError(Exception):
    pass


class _JSONArgumentParser(argparse.ArgumentParser):
    def error(self, message):
        sys.stdout.write(json.dumps({"ok": False, "error": {"type": "UsageError", "message": message[:1000]}},
                                     separators=(",", ":")) + "\n")
        raise _UsageError(message)


def _parser() -> argparse.ArgumentParser:
    parser = _JSONArgumentParser(description="Bounded, revision-guarded Super MD note operations")
    parser.add_argument("--root", action="append", required=True, help="Explicit workspace root (repeatable)")
    sub = parser.add_subparsers(dest="command", required=True)
    for command in ("inspect", "read", "search", "create", "patch", "assets", "attach", "replace-asset",
                    "extract", "export"):
        p = sub.add_parser(command)
        p.add_argument("path", help="Path relative to a configured root, or an absolute path inside one")
        if command == "read":
            p.add_argument("--offset", type=int, default=0)
            p.add_argument("--limit", type=int, default=12000)
            p.add_argument("--heading", type=int, help="Read the indexed heading section (0-based from inspect)")
            p.add_argument("--view", choices=("prose", "source"), default="prose",
                           help="Elide fenced SVG bodies by default; use source for exact Markdown")
        elif command == "search":
            p.add_argument("query")
            p.add_argument("--limit", type=int, default=10)
            p.add_argument("--context", type=int, default=100)
        elif command == "create":
            group = p.add_mutually_exclusive_group(required=True)
            group.add_argument("--content")
            group.add_argument("--stdin", action="store_true", help="Read UTF-8 Markdown from stdin")
            group.add_argument("--content-file", help="Read content from a file inside a configured root")
        elif command == "patch":
            p.add_argument("--revision", required=True, help="SHA-256 revision returned by inspect/read")
            p.add_argument("--operations-json", help="JSON array of replace/lines operations")
            p.add_argument("--operations-file", help="Read that JSON array from an allowed file")
        elif command == "attach":
            p.add_argument("asset_path")
            p.add_argument("--revision", required=True)
            p.add_argument("--name")
        elif command == "replace-asset":
            p.add_argument("asset_id", help="Stable id or exact name from assets metadata")
            p.add_argument("asset_path", help="Replacement image inside an allowed root")
            p.add_argument("--revision", required=True)
        elif command == "assets":
            p.add_argument("--offset", type=int, default=0)
            p.add_argument("--limit", type=int, default=50)
        elif command == "extract":
            p.add_argument("asset_name")
            p.add_argument("output_path")
            p.add_argument("--revision", required=True)
        elif command == "export":
            p.add_argument("format", choices=("smd", "pdf"))
            p.add_argument("output_path", help="New output file path inside an allowed root")
            p.add_argument("--engine", help="Path to the native smd-engine executable")
            p.add_argument("--font-dir", help="Optional directory of TTF/OTF assets for PDF export")
            p.add_argument("--options-json", help="PDF export options object; see docs/AGENT-INTERFACE.md")
            p.add_argument("--options-file", help="Read the PDF export options object from an allowed file")
    return parser


def _emit(value: dict) -> None:
    # Exactly one bounded JSON record is written to stdout on success or failure.
    encoded = json.dumps(value, ensure_ascii=False, separators=(",", ":"))
    if len(encoded.encode("utf-8")) > 64_000:
        raise AgentDocumentError("Response exceeded the 64 KB output limit; request a smaller page")
    sys.stdout.write(encoded + "\n")


def main(argv: list[str] | None = None) -> int:
    argv = list(sys.argv[1:] if argv is None else argv)
    # Packaged `super-md agent mcp ...` shares this lightweight entry point
    # without importing Qt; stdio remains reserved for MCP protocol traffic.
    if argv and argv[0] == "mcp":
        try:
            from .mcp_server import main as mcp_main
        except ImportError:
            from mcp_server import main as mcp_main
        return mcp_main(argv[1:])
    if argv and argv[0] == "live":
        try:
            from .agent_live_cli import main as live_main
        except ImportError:
            from agent_live_cli import main as live_main
        return live_main(argv[1:])
    parser = _parser()
    try:
        args = parser.parse_args(argv)
    except _UsageError:
        return 2
    try:
        store = DocumentStore(args.root)
        if args.command == "inspect":
            result = store.inspect(args.path)
        elif args.command == "read":
            result = store.read(args.path, offset=args.offset, limit=args.limit, heading=args.heading, view=args.view)
        elif args.command == "search":
            result = store.search(args.path, args.query, limit=args.limit, context=args.context)
        elif args.command == "create":
            if args.stdin:
                raw = sys.stdin.buffer.read(20_000_001)
                if len(raw) > 20_000_000:
                    raise AgentDocumentError("stdin content exceeds the 20 MB limit")
                try:
                    content = raw.decode("utf-8")
                except UnicodeDecodeError as exc:
                    raise AgentDocumentError("stdin content must be UTF-8") from exc
            elif args.content_file:
                content_path = store.resolve(args.content_file)
                if content_path.stat().st_size > 20_000_000:
                    raise AgentDocumentError("content file exceeds the 20 MB limit")
                content = content_path.read_text(encoding="utf-8")
            else:
                content = args.content
            result = store.create(args.path, content)
        elif args.command == "patch":
            if bool(args.operations_json) == bool(args.operations_file):
                raise AgentDocumentError("Provide exactly one of --operations-json or --operations-file")
            if args.operations_file:
                operations_path = store.resolve(args.operations_file)
                if operations_path.stat().st_size > 64_000:
                    raise AgentDocumentError("Patch operation file exceeds 64 KB")
                operations_json = operations_path.read_text(encoding="utf-8")
            else:
                operations_json = args.operations_json
            if len(operations_json.encode("utf-8")) > 64_000:
                raise AgentDocumentError("Patch operation JSON exceeds 64 KB")
            try:
                operations = json.loads(operations_json)
            except json.JSONDecodeError as exc:
                raise AgentDocumentError(f"Invalid patch JSON at character {exc.pos}") from exc
            result = store.patch(args.path, expected_revision=args.revision, operations=operations)
        elif args.command == "assets":
            result = store.assets(args.path, offset=args.offset, limit=args.limit)
        elif args.command == "attach":
            result = store.attach_asset(args.path, args.asset_path, expected_revision=args.revision, name=args.name)
        elif args.command == "replace-asset":
            result = store.replace_asset(args.path, args.asset_id, args.asset_path, expected_revision=args.revision)
        elif args.command == "extract":
            result = store.extract_asset(args.path, args.asset_name, args.output_path, expected_revision=args.revision)
        elif args.command == "export":
            if args.format == "smd" and (args.options_json or args.options_file or args.font_dir):
                raise AgentDocumentError("PDF options and font-dir apply only to PDF export")
            if bool(args.options_json) and bool(args.options_file):
                raise AgentDocumentError("Provide only one of --options-json or --options-file")
            options = None
            options_json = args.options_json
            if args.options_file:
                options_path = store.resolve(args.options_file)
                if options_path.stat().st_size > 16_000:
                    raise AgentDocumentError("PDF options file exceeds 16 KB")
                options_json = options_path.read_text(encoding="utf-8")
            if options_json:
                if len(options_json.encode("utf-8")) > 16_000:
                    raise AgentDocumentError("PDF options JSON exceeds 16 KB")
                try:
                    options = json.loads(options_json)
                except json.JSONDecodeError as exc:
                    raise AgentDocumentError(f"Invalid PDF options JSON at character {exc.pos}") from exc
                if not isinstance(options, dict):
                    raise AgentDocumentError("PDF options must be a JSON object")
            try:
                from .agent_exports import export_pdf, export_smd
            except ImportError:
                from agent_exports import export_pdf, export_smd
            if args.format == "pdf":
                result = export_pdf(store, args.path, args.output_path, options=options,
                                    engine=args.engine, font_dir=args.font_dir)
            else:
                result = export_smd(store, args.path, args.output_path, engine=args.engine)
        else:
            raise AgentDocumentError("Unknown command")
        _emit({"ok": True, "result": result})
        return 0
    except (ValueError, OSError, UnicodeError, TypeError) as exc:
        try:
            _emit({"ok": False, "error": {"type": type(exc).__name__, "message": str(exc)}})
        except AgentDocumentError:
            sys.stdout.write('{"ok":false,"error":{"type":"AgentDocumentError","message":"Response exceeded output bound"}}\n')
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
