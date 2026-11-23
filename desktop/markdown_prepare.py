"""Prepare self-contained Markdown exports from an allowed note folder."""
from __future__ import annotations

import base64
import re
import urllib.parse
from dataclasses import dataclass
from pathlib import Path

try:
    from . import documents
    from .agent_documents import AgentDocumentError, _symlink_component
except ImportError:
    import documents
    from agent_documents import AgentDocumentError, _symlink_component

_GENERATED = re.compile(r"^assets/(?:import|image)-[a-z0-9-]+\.(?:png|jpe?g|svg|gif|webp|avif)$", re.I)
_MIME_EXT = {value: key for key, value in documents.MIMES.items()}
_IMAGE = re.compile(r"!\[(?P<alt>(?:\\.|[^\]\\\n])*)\]\(\s*(?:<(?P<angle>[^>\n]+)>|(?P<bare>[^\s)]+))(?:\s+(?:\"[^\"]*\"|'[^']*'|\([^)]*\)))?\s*\)")
_IMAGE_REF = re.compile(r"!\[(?P<alt>(?:\\.|[^\]\\\n])*)\](?:\s*\[(?P<label>[^\]\n]*)\])?")
_LINK = re.compile(r"(?<!!)\[(?P<label>(?:\\.|[^\]\\\n])*)\]\(\s*(?:<(?P<angle>[^>\n]+)>|(?P<bare>[^\s)]+))(?:\s+(?:\"[^\"]*\"|'[^']*'|\([^)]*\)))?\s*\)")
_LINK_REF = re.compile(r"(?<!!)\[(?P<label>(?:\\.|[^\]\\\n])*)\](?:\s*\[(?P<ref>[^\]\n]*)\])")
_DEFINITION = re.compile(r"(?m)^[ \t]{0,3}\[(?P<label>[^\]\n]+)\]:[ \t]*(?:<(?P<angle>[^>\n]+)>|(?P<bare>\S+))")
_WIKI = re.compile(r"!\[\[(?P<source>[^\]|]+)(?:\|(?P<alt>[^\]]+))?\]\]")
_FENCE = re.compile(r"^ {0,3}(`{3,}|~{3,})")


@dataclass(frozen=True)
class _Ref:
    source: str
    start: int
    end: int
    kind: str
    alt: str = ""
    definition: tuple[int, int, int, int] | None = None  # line start/end, destination start/end


def _mask_code(markdown: str) -> str:
    chars = list(markdown)
    offset = 0
    fence_char = ""
    fence_size = 0
    for line in markdown.splitlines(keepends=True):
        body = line.rstrip("\r\n")
        match = _FENCE.match(body)
        mask = bool(fence_char)
        if match:
            marker = match.group(1)
            if not fence_char:
                fence_char, fence_size = marker[0], len(marker)
                mask = True
            elif marker[0] == fence_char and len(marker) >= fence_size:
                mask = True
                fence_char = ""
                fence_size = 0
        if mask:
            for index in range(offset, offset + len(line)):
                if chars[index] not in "\r\n":
                    chars[index] = " "
        offset += len(line)
    visible = "".join(chars)
    # Mask inline code runs while preserving every source offset.
    for match in re.finditer(r"(`+)(?!`)(.*?)\1", visible, re.S):
        start, end = match.span()
        if "\n" in match.group(2):
            continue
        visible = visible[:start] + re.sub(r"[^\r\n]", " ", visible[start:end]) + visible[end:]
    return visible


def _normalize_label(value: str) -> str:
    return " ".join(value.casefold().split())


def _references(markdown: str) -> list[_Ref]:
    visible = _mask_code(markdown)
    definitions: dict[str, tuple[str, tuple[int, int, int, int]]] = {}
    for match in _DEFINITION.finditer(visible):
        source = match.group("angle") or match.group("bare")
        destination_start, destination_end = (match.span("angle") if match.group("angle") else match.span("bare"))
        line_start = visible.rfind("\n", 0, match.start()) + 1
        line_end = visible.find("\n", match.end())
        if line_end < 0:
            line_end = len(visible)
        else:
            line_end += 1
        definitions[_normalize_label(match.group("label"))] = (source, (line_start, line_end, destination_start, destination_end))
    result: list[_Ref] = []
    occupied: list[tuple[int, int]] = []

    def add(match, kind: str, source: str, alt: str = "", definition=None):
        result.append(_Ref(source, *match.span(), kind, alt, definition))
        occupied.append(match.span())

    for match in _IMAGE.finditer(visible):
        source = match.group("angle") or match.group("bare")
        add(match, "image", source, match.group("alt"))
    for match in _IMAGE_REF.finditer(visible):
        if any(start <= match.start() < end for start, end in occupied):
            continue
        # Inline images were handled above; ordinary bracket links are not images.
        if match.end() < len(visible) and visible[match.end()] == "(":
            continue
        label = match.group("label") or match.group("alt")
        target = definitions.get(_normalize_label(label))
        if target:
            add(match, "reference", target[0], match.group("alt"), target[1])
    for match in _WIKI.finditer(visible):
        if any(start <= match.start() < end for start, end in occupied):
            continue
        add(match, "wiki", match.group("source"), match.group("alt") or match.group("source"))
    for match in _LINK.finditer(visible):
        source = match.group("angle") or match.group("bare")
        if re.search(r"\.(?:svg|mmd|mermaid)(?:[?#]|$)", source, re.I):
            add(match, "source-link", source)
    for match in _LINK_REF.finditer(visible):
        if any(start <= match.start() < end for start, end in occupied):
            continue
        label = match.group("ref") or match.group("label")
        target = definitions.get(_normalize_label(label))
        if target and re.search(r"\.(?:svg|mmd|mermaid)(?:[?#]|$)", target[0], re.I):
            add(match, "source-link-reference", target[0], "", target[1])
    for match in _DEFINITION.finditer(visible):
        # Definitions used as direct diagrams need a range for replacing their source line,
        # even when there is no image reference use (ordinary Markdown link destinations).
        pass
    return sorted(result, key=lambda item: item.start)


def _safe_relative(source: str) -> str | None:
    if not source or source.startswith(("/", "\\")) or re.match(r"^[a-z][a-z\d+.-]*:", source, re.I):
        return None
    decoded = urllib.parse.unquote(source.split("#", 1)[0].split("?", 1)[0])
    if "\\" in decoded or "\0" in decoded:
        return None
    parts = [part for part in decoded.split("/") if part and part != "."]
    if not parts or any(part == ".." or re.search(r'[<>:"|?*\x00-\x1f]', part) or part.endswith((".", " "))
                        or re.match(r"^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)", part, re.I)
                        for part in parts):
        return None
    return "/".join(parts)


def _read_local(note_dir: Path, source: str, *, text: bool = False) -> tuple[str, bytes] | str:
    relative = _safe_relative(source)
    if not relative:
        raise AgentDocumentError(f"Cannot safely resolve asset path {source[:180]!r}")
    candidate = (note_dir / urllib.parse.unquote(relative)).absolute()
    if _symlink_component(candidate):
        raise AgentDocumentError(f"Symlink asset paths are not allowed: {source[:180]!r}")
    try:
        path = candidate.resolve(strict=True)
    except OSError as error:
        raise AgentDocumentError(f"Local asset is unavailable: {source[:180]!r}") from error
    if not path.is_relative_to(note_dir) or not path.is_file():
        raise AgentDocumentError("Asset is outside the note folder")
    size_limit = 2_000_000 if text else documents.MAX_IMAGE
    if path.stat().st_size > size_limit:
        raise AgentDocumentError(f"Local {'diagram source' if text else 'image'} exceeds {size_limit // 1_000_000} MB")
    try:
        return path.read_text(encoding="utf-8") if text else (documents.MIMES.get(path.suffix.lower().lstrip("."), ""), path.read_bytes())
    except (OSError, UnicodeError) as error:
        raise AgentDocumentError(f"Local asset could not be read: {source[:180]!r}") from error


def _fence(source: str, language: str) -> str:
    longest = max((len(match.group(0)) for match in re.finditer(r"`+", source)), default=0)
    fence = "`" * max(3, longest + 1)
    return f"\n\n{fence}{language}\n{source.rstrip()}\n{fence}\n\n"


def prepare_markdown_export(store: DocumentStore, source_value: str, markdown: str,
                            embedded: dict[str, str]) -> tuple[str, dict[str, str]]:
    """Inline vector/diagram source and return referenced raster data URLs."""
    source = store.resolve(source_value)
    note_dir = source.parent.resolve(strict=True)
    references = _references(markdown)
    reserved: set[str] = set()
    for ref in references:
        path = _safe_relative(ref.source)
        if path and not _GENERATED.fullmatch(path) and not re.search(r"\.(?:svg|mmd|mermaid)$", path, re.I):
            reserved.add(path)
    assets: dict[str, str] = {}
    edits: list[tuple[int, int, str]] = []
    definitions_to_remove: dict[int, tuple[int, int, int, int]] = {}
    allocated: dict[str, str] = {}
    used = set(reserved)
    next_index = 0

    def generated_name(key: str, extension: str) -> str:
        nonlocal next_index
        if key in allocated:
            return allocated[key]
        while True:
            next_index += 1
            name = f"image{next_index}.{extension}"
            if name not in used:
                used.add(name)
                allocated[key] = name
                return name

    for ref in references:
        raw = ref.source.strip()
        lower = raw.lower()
        if lower.startswith(("http://", "https://", "//")):
            continue
        if re.search(r"\.(?:mmd|mermaid)(?:[?#]|$)", raw, re.I):
            if raw in embedded:
                raise AgentDocumentError("Mermaid source files cannot be embedded as image assets")
            diagram = _read_local(note_dir, raw, text=True)
            edits.append((ref.start, ref.end, _fence(diagram, "mermaid")))
            if ref.definition:
                definitions_to_remove[ref.definition[0]] = ref.definition
            continue
        if raw.startswith("data:"):
            try:
                mime, payload = documents.image_data(raw)
            except ValueError as error:
                raise AgentDocumentError("Markdown export contains an invalid embedded image") from error
        elif raw in embedded:
            mime, payload = documents.image_data(embedded[raw])
        else:
            mime, payload = _read_local(note_dir, raw)
        if not mime or mime not in documents.MIMES.values():
            raise AgentDocumentError(f"Unsupported image type for {raw[:180]!r}")
        extension = Path(_safe_relative(raw) or "").suffix.lower().lstrip(".")
        if mime == "image/svg+xml":
            try:
                svg = payload.decode("utf-8")
            except UnicodeDecodeError as error:
                raise AgentDocumentError(f"SVG source is not UTF-8: {raw[:180]!r}") from error
            edits.append((ref.start, ref.end, _fence(svg, "svg")))
            if ref.definition:
                definitions_to_remove[ref.definition[0]] = ref.definition
            continue
        if mime == "image/jpeg" and extension not in ("jpg", "jpeg"):
            extension = "jpg"
        elif mime != "image/jpeg" and documents.MIMES.get(extension) != mime:
            extension = _MIME_BY_TYPE[mime]
        if not extension:
            extension = _MIME_BY_TYPE[mime]
        relative = _safe_relative(raw)
        generated = raw.startswith("data:") or not relative or bool(_GENERATED.fullmatch(relative))
        output_name = generated_name(relative or raw, extension) if generated else relative
        data_url = f"data:{mime};base64,{base64.b64encode(payload).decode('ascii')}"
        if output_name in assets and assets[output_name] != data_url:
            raise AgentDocumentError(f"Markdown asset destination collision: {output_name}")
        assets[output_name] = data_url
        if generated or ref.kind == "wiki":
            if ref.kind == "reference" and ref.definition:
                start, end = ref.definition[2], ref.definition[3]
                edits.append((start, end, f"<{output_name}>"))
            else:
                alt = re.sub(r"[\r\n]+", " ", ref.alt or Path(raw).name or "Image").replace("]", r"\]")
                edits.append((ref.start, ref.end, f"![{alt}](<{output_name}>)"))
    for definition in definitions_to_remove.values():
        start, end = definition[0], definition[1]
        edits.append((start, end, ""))
    content = markdown
    for start, end, value in sorted(edits, reverse=True):
        content = content[:start] + value + content[end:]
    return content, assets


_MIME_BY_TYPE = {value: key for key, value in documents.MIMES.items()}
