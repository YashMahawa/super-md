"""Headless command-line access to explicitly enabled live desktop tabs."""
from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path
from typing import Any

try:
    from .agent_stdio import configure_stdio
except ImportError:  # python desktop/agent_live_cli.py
    from agent_stdio import configure_stdio

MAX_OUTPUT = 64_000
MAX_INPUT = 64_000
MAX_CONTENT = 20_000_000
MAX_IMAGE = 8 * 1024 * 1024
MAX_ASSET_INPUT = 25 * 1024 * 1024
ASSET_EXTENSIONS = {
    "image/png": ".png", "image/jpeg": ".jpg", "image/svg+xml": ".svg",
    "image/gif": ".gif", "image/webp": ".webp", "image/avif": ".avif",
}


class _CLIError(ValueError):
    pass


class _JSONArgumentParser(argparse.ArgumentParser):
    def error(self, message):
        raise _CLIError(message)


def _emit(value: dict[str, Any]) -> None:
    configure_stdio(stdin=False, stderr=False)
    encoded = json.dumps(value, ensure_ascii=False, separators=(",", ":"))
    if len(encoded.encode("utf-8")) > MAX_OUTPUT:
        raise _CLIError("Response exceeded 64 KB; request a smaller page")
    sys.stdout.write(encoded + "\n")


def _parser() -> argparse.ArgumentParser:
    parser = _JSONArgumentParser(description="Inspect and edit tabs in an enabled Super MD desktop session")
    parser.add_argument("--sessions-dir", required=True,
                        help="Private live-session discovery directory copied from Super MD setup")
    sub = parser.add_subparsers(dest="command", required=True)

    sub.add_parser("list", help="List currently open tabs")

    context = sub.add_parser("context", help="Read the current reader viewport and selection")
    context.add_argument("tab")
    context.add_argument("--limit", type=int, default=6000)

    read = sub.add_parser("read", help="Read a bounded page of the live Markdown source")
    read.add_argument("tab")
    read.add_argument("--offset", type=int, default=0)
    read.add_argument("--limit", type=int, default=12_000)
    read.add_argument("--view", choices=("prose", "source"), default="prose")

    search = sub.add_parser("search", help="Search text in one open tab")
    search.add_argument("tab")
    search.add_argument("query")
    search.add_argument("--limit", type=int, default=10)
    search.add_argument("--context", type=int, default=100)

    patch = sub.add_parser("patch", help="Patch an active tab; run activate first if needed")
    patch.add_argument("tab")
    patch.add_argument("--revision", required=True)
    ops = patch.add_mutually_exclusive_group(required=True)
    ops.add_argument("--operations-json")
    ops.add_argument("--operations-file")

    create = sub.add_parser("create", help="Create a new unsaved live tab")
    create.add_argument("--content-file", required=True)
    create.add_argument("--title")
    create.add_argument("--format", choices=("md", "smd"), default="md")

    save = sub.add_parser("save", help="Save an active tab without overwriting an existing file")
    save.add_argument("tab")
    save.add_argument("--revision", required=True)
    save.add_argument("--filename")
    save.add_argument("--format", choices=("md", "smd"), default="md")

    activate = sub.add_parser("activate", help="Flush the current draft, then activate another listed tab")
    activate.add_argument("tab")

    export = sub.add_parser("export", help="Export an active tab; run activate first if needed")
    export.add_argument("tab")
    export.add_argument("format", choices=("pdf", "smd", "md"))
    export.add_argument("--revision", required=True)
    export.add_argument("--filename")
    exp_options = export.add_mutually_exclusive_group()
    exp_options.add_argument("--options-json")
    exp_options.add_argument("--options-file")

    job = sub.add_parser("job", help="Read an export job's current status")
    job.add_argument("job_id")

    latex_review = sub.add_parser("latex-review", help="Review proposed LaTeX repairs")
    latex_review.add_argument("tab")

    latex_apply = sub.add_parser("latex-apply", help="Apply selected reviewed LaTeX repairs")
    latex_apply.add_argument("tab")
    latex_apply.add_argument("--revision", required=True)
    latex_apply.add_argument("--indices", required=True,
                             help="Comma-separated repair indexes returned by latex-review")

    diagrams = sub.add_parser("diagrams", help="List rendered diagram source references")
    diagrams.add_argument("tab")
    diagrams.add_argument("--revision")

    diagram = sub.add_parser("diagram", help="Read a bounded source page for one diagram")
    diagram.add_argument("tab")
    diagram.add_argument("diagram_id")
    diagram.add_argument("--revision", required=True)
    diagram.add_argument("--offset", type=int, default=0)
    diagram.add_argument("--limit", type=int, default=12_000)

    diagram_image = sub.add_parser("diagram-image", help="Save one rendered diagram as an image")
    diagram_image.add_argument("tab")
    diagram_image.add_argument("diagram_id")
    diagram_image.add_argument("output")
    diagram_image.add_argument("--revision", required=True)
    diagram_image.add_argument("--width", type=int, default=1600)

    assets = sub.add_parser("assets", help="List bounded metadata for embedded assets")
    assets.add_argument("tab")
    assets.add_argument("--offset", type=int, default=0)
    assets.add_argument("--limit", type=int, default=50)

    extract = sub.add_parser("extract", help="Save one embedded image asset")
    extract.add_argument("tab")
    extract.add_argument("asset_name")
    extract.add_argument("output")
    extract.add_argument("--revision", required=True)

    attach = sub.add_parser("attach", help="Attach a local image to an active portable note")
    attach.add_argument("tab")
    attach.add_argument("asset_path")
    attach.add_argument("--revision", required=True)
    attach.add_argument("--name")

    replace_asset = sub.add_parser("replace-asset", help="Replace one embedded image asset")
    replace_asset.add_argument("tab")
    replace_asset.add_argument("asset_id")
    replace_asset.add_argument("asset_path")
    replace_asset.add_argument("--revision", required=True)

    snapshot = sub.add_parser("snapshot", help="Capture an active tab's rendered viewport as an image")
    snapshot.add_argument("tab")
    snapshot.add_argument("output")
    snapshot.add_argument("--width", type=int, default=1600)
    return parser


def _read_limited(path: str, limit: int, label: str) -> str:
    target = Path(path).expanduser()
    if target.is_symlink() or not target.is_file():
        raise _CLIError(f"{label} must be a regular file")
    if target.stat().st_size > limit:
        raise _CLIError(f"{label} exceeds the {limit} byte limit")
    try:
        return target.read_text(encoding="utf-8")
    except UnicodeDecodeError as error:
        raise _CLIError(f"{label} must be UTF-8 text") from error


def _json_object_or_array(text: str, label: str):
    if len(text.encode("utf-8")) > MAX_INPUT:
        raise _CLIError(f"{label} exceeds the 64 KB limit")
    try:
        return json.loads(text)
    except json.JSONDecodeError as error:
        raise _CLIError(f"Invalid {label} JSON at character {error.pos}") from error


def _native_id(value: str) -> str:
    # MCP and list output use `session:window:tab`; reject malformed targets
    # before they reach the authenticated native bridge.
    if not isinstance(value, str) or not value or len(value) > 400:
        raise _CLIError("A live tab ID from `agent live list` is required")
    return value[4:] if value.startswith("tab:") else value


def _write_image(path: str, image: dict[str, Any]) -> dict[str, Any]:
    return _write_media(path, image, {"image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp"},
                        label="viewport image")


def _write_media(path: str, image: dict[str, Any], extensions: dict[str, str], *, label: str) -> dict[str, Any]:
    data = image.get("data")
    mime = image.get("mime_type") or image.get("mimeType")
    if not isinstance(data, bytes) or not 0 < len(data) <= MAX_IMAGE:
        raise _CLIError(f"Desktop returned an invalid or oversized {label}")
    extension = extensions.get(mime)
    if extension is None:
        raise _CLIError(f"Desktop returned an unsupported {label} format")
    target = Path(path).expanduser()
    if not target.suffix:
        target = target.with_suffix(extension)
    elif target.suffix.lower() not in ({extension} | ({".jpeg"} if extension == ".jpg" else set())):
        raise _CLIError(f"Output extension must match {mime} ({extension})")
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    fd = os.open(target, flags, 0o600)
    try:
        with os.fdopen(fd, "wb") as stream:
            stream.write(data)
    except Exception:
        try:
            target.unlink()
        except OSError:
            pass
        raise
    return {"path": str(target.resolve()), "mimeType": mime, "bytes": len(data),
            "width": image.get("width"), "height": image.get("height"),
            "revision": image.get("revision")}


def _asset_input(path: str, label: str) -> str:
    target = Path(path).expanduser()
    if target.is_symlink() or not target.is_file():
        raise _CLIError(f"{label} must be a regular local file")
    extension = target.suffix.lower().lstrip(".")
    mime_by_extension = {suffix.lstrip("."): mime for mime, suffix in ASSET_EXTENSIONS.items()}
    mime_by_extension.update({"jpeg": "image/jpeg"})
    mime = mime_by_extension.get(extension)
    if mime is None:
        raise _CLIError(f"{label} must be PNG, JPEG, SVG, GIF, WebP, or AVIF")
    try:
        size = target.stat().st_size
    except OSError as error:
        raise _CLIError(f"{label} is unavailable") from error
    if size <= 0 or size > MAX_ASSET_INPUT:
        raise _CLIError(f"{label} must be between 1 byte and 25 MB")
    return str(target.resolve(strict=True))


def _parse_indices(value: str) -> list[int]:
    if not value.strip():
        return []
    try:
        indices = [int(part.strip()) for part in value.split(",")]
    except ValueError as error:
        raise _CLIError("--indices must be comma-separated nonnegative integers") from error
    if len(indices) > 40 or any(index < 0 for index in indices) or len(set(indices)) != len(indices):
        raise _CLIError("--indices must contain up to 40 unique nonnegative indexes")
    return indices


def main(argv: list[str] | None = None) -> int:
    configure_stdio()
    try:
        args = _parser().parse_args(sys.argv[1:] if argv is None else argv)
        try:
            from .agent_live_client import MultiSessionLiveClient
        except ImportError:
            from agent_live_client import MultiSessionLiveClient
        client = MultiSessionLiveClient(args.sessions_dir)
        tab = _native_id(getattr(args, "tab", "")) if getattr(args, "tab", None) else None

        if args.command == "list":
            result = client.list_tabs()
        elif args.command == "context":
            result = client.document_action(tab, "get_context", limit=args.limit)
        elif args.command == "read":
            result = client.read_tab(tab, offset=args.offset, limit=args.limit, view=args.view)
        elif args.command == "search":
            result = client.search_tab(tab, args.query, limit=args.limit, context=args.context)
        elif args.command == "patch":
            ops_text = args.operations_json if args.operations_json is not None else _read_limited(args.operations_file, MAX_INPUT, "operations file")
            operations = _json_object_or_array(ops_text, "operations")
            if not isinstance(operations, list):
                raise _CLIError("Patch operations must be a JSON array")
            result = client.patch_tab(tab, expected_revision=args.revision, operations=operations)
        elif args.command == "create":
            content = _read_limited(args.content_file, MAX_CONTENT, "content file")
            result = client.document_action(None, "create_document", content=content,
                                            title=args.title, format=args.format)
        elif args.command == "save":
            result = client.document_action(tab, "save_document", expected_revision=args.revision,
                                            filename=args.filename, format=args.format)
        elif args.command == "activate":
            result = client.document_action(tab, "open_document", filename="")
        elif args.command == "export":
            options_text = None
            if args.options_json is not None:
                options_text = args.options_json
            elif args.options_file:
                options_text = _read_limited(args.options_file, 16_000, "options file")
            options = _json_object_or_array(options_text, "options") if options_text else {}
            if not isinstance(options, dict):
                raise _CLIError("Export options must be a JSON object")
            result = client.document_action(tab, "export_document", format=args.format,
                                            expected_revision=args.revision, filename=args.filename,
                                            options=options)
        elif args.command == "job":
            # A CLI invocation is intentionally stateless, so the MCP adapter's
            # in-memory job alias table is unavailable on subsequent commands.
            # Export IDs use `session-id:raw-job-id`; the bridge owns lookup by
            # raw ID and does not require the source tab to stay selected.
            client.list_tabs()
            session_id, separator, raw_job_id = args.job_id.partition(":")
            if not separator or not session_id or not raw_job_id:
                raise _CLIError("Job ID must be copied from a live export result")
            saved = client._sessions.get(session_id)
            if not saved:
                raise _CLIError("Export session is no longer available")
            live_client, _tab_map = saved
            result = live_client.document_action("", "job_status", job_id=raw_job_id)
        elif args.command == "latex-review":
            result = client.document_action(tab, "latex_review")
        elif args.command == "latex-apply":
            result = client.document_action(tab, "latex_apply", expected_revision=args.revision,
                                            repair_indices=_parse_indices(args.indices))
        elif args.command == "diagrams":
            result = client.document_action(tab, "list_diagrams", expected_revision=args.revision)
        elif args.command == "diagram":
            result = client.document_action(tab, "get_diagram", diagram_id=args.diagram_id,
                                            expected_revision=args.revision,
                                            offset=args.offset, limit=args.limit)
        elif args.command == "diagram-image":
            if not 64 <= args.width <= 1600:
                raise _CLIError("--width must be between 64 and 1,600 pixels")
            image = client.document_action(tab, "get_diagram_image", diagram_id=args.diagram_id,
                                           expected_revision=args.revision, width=args.width)
            result = _write_media(args.output, image, {"image/png": ".png"}, label="diagram image")
        elif args.command == "assets":
            if args.offset < 0 or not 1 <= args.limit <= 50:
                raise _CLIError("--offset must be nonnegative and --limit must be between 1 and 50")
            metadata = client.read_tab(tab, offset=0, limit=1,
                                      asset_offset=args.offset, asset_limit=args.limit)
            result = {key: metadata[key] for key in
                      ("revision", "assets", "assetCount", "assetsNextOffset") if key in metadata}
        elif args.command == "extract":
            image = client.get_tab_image(tab, asset_name=args.asset_name, expected_revision=args.revision)
            result = _write_media(args.output, image, ASSET_EXTENSIONS, label="embedded asset")
            result.update({key: image[key] for key in ("asset", "sha256") if key in image})
        elif args.command == "attach":
            asset_path = _asset_input(args.asset_path, "Asset")
            result = client.attach_tab(tab, asset_path=asset_path,
                                       expected_revision=args.revision, name=args.name)
        elif args.command == "replace-asset":
            asset_path = _asset_input(args.asset_path, "Replacement asset")
            result = client.document_action(tab, "replace_tab_asset", asset_name=args.asset_id,
                                            asset_path=asset_path, expected_revision=args.revision)
        elif args.command == "snapshot":
            image = client.render_tab(tab, width=args.width)
            result = _write_image(args.output, image)
        else:
            raise _CLIError("Unsupported live command")
        _emit({"ok": True, "result": result})
        return 0
    except _CLIError as error:
        _emit({"ok": False, "error": {"type": "UsageError", "message": str(error)[:1000]}})
        return 2
    except (ValueError, OSError, UnicodeError, TypeError) as error:
        try:
            _emit({"ok": False, "error": {"type": type(error).__name__, "message": str(error)[:1000]}})
        except _CLIError:
            sys.stdout.write('{"ok":false,"error":{"type":"CLIError","message":"Response exceeded output bound"}}\n')
        return 2
    except Exception as error:
        # Bridge and network adapters use their own exception classes. Keep
        # failures machine-readable without a traceback or transport details.
        try:
            _emit({"ok": False, "error": {"type": type(error).__name__, "message": str(error)[:1000] or "Live request failed"}})
        except _CLIError:
            sys.stdout.write('{"ok":false,"error":{"type":"CLIError","message":"Response exceeded output bound"}}\n')
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
