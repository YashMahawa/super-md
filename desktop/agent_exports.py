"""Headless exports through Super MD's native engine; never loads Qt or executes code."""
from __future__ import annotations

import base64
import hashlib
import json
import os
import re
import subprocess
import sys
import tempfile
import urllib.parse
from pathlib import Path
from typing import Any

try:
    from . import documents
    from .agent_documents import AgentDocumentError, DocumentStore, RevisionConflict, _symlink_component
except ImportError:
    import documents
    from agent_documents import AgentDocumentError, DocumentStore, RevisionConflict, _symlink_component

DEFAULT_PDF_OPTIONS = {
    "pageSize": "a4", "margin": 18, "fontSize": 10.5, "lineHeight": 1.55,
    "paragraphSpacing": 1.35, "fontFamily": "Manrope", "pageNumbers": True,
    "themed": False, "themeAccent": "#386a57",
}
PAGE_SIZES = {"a3", "a4", "a5", "a6", "iso-b4", "iso-b5", "iso-b6", "letter", "legal", "tabloid", "executive"}
MAX_PDF = 250_000_000
MAX_EXPORT_REQUEST = 120_000_000
_INLINE_IMAGE = re.compile(r"!\[(?:\\.|[^\]\n])*\]\(\s*(?:<([^>\n]+)>|([^\s)]+))")
_IMAGE_LABEL = re.compile(r"!\[(?:\\.|[^\]\n])*\](?:\s*\[([^\]\n]*)\])?")
_REFERENCE = re.compile(r"(?m)^ {0,3}\[([^\]\n]+)\]:\s*(?:<([^>\n]+)>|(\S+))")
_FENCE = re.compile(r"^\s{0,3}(`{3,}|~{3,})")


def validate_pdf_options(value: dict[str, Any] | None) -> dict[str, Any]:
    options = {**DEFAULT_PDF_OPTIONS, **(value or {})}
    allowed = set(DEFAULT_PDF_OPTIONS)
    unknown = set(options) - allowed
    if unknown:
        raise AgentDocumentError("Unsupported PDF option(s): " + ", ".join(sorted(unknown)))
    if options["pageSize"] not in PAGE_SIZES:
        raise AgentDocumentError("pageSize must be a supported A, ISO B, Letter, Legal, Tabloid, or Executive size")
    for key, low, high in (("margin", 4, 60), ("fontSize", 5, 24),
                           ("lineHeight", 0.9, 2.2), ("paragraphSpacing", 0, 3)):
        number = options[key]
        if isinstance(number, bool) or not isinstance(number, (int, float)) or not low <= number <= high:
            raise AgentDocumentError(f"{key} must be between {low} and {high}")
    if not isinstance(options["fontFamily"], str) or not options["fontFamily"].strip() or len(options["fontFamily"]) > 120:
        raise AgentDocumentError("fontFamily must be a non-empty name up to 120 characters")
    if not isinstance(options["pageNumbers"], bool) or not isinstance(options["themed"], bool):
        raise AgentDocumentError("pageNumbers and themed must be booleans")
    if not isinstance(options["themeAccent"], str) or not re.fullmatch(r"#[0-9A-Fa-f]{6}", options["themeAccent"]):
        raise AgentDocumentError("themeAccent must be a six-digit hexadecimal color")
    return options


def find_engine(explicit: str | os.PathLike[str] | None = None) -> Path:
    if explicit:
        candidate = Path(explicit).expanduser().resolve(strict=True)
        if candidate.is_file():
            return candidate
        raise AgentDocumentError("Native export engine is not a file")
    executable = "smd-engine.exe" if os.name == "nt" else "smd-engine"
    desktop_dir = Path(__file__).resolve().parent
    packaged = (Path(sys._MEIPASS) / "resources" / "desktop" / executable,) if getattr(sys, "frozen", False) else ()
    candidates = (*packaged, desktop_dir / executable, desktop_dir.parent / "smd-core" / "target" / "release" / executable,
                  desktop_dir.parent / "smd-core" / "target" / "debug" / executable)
    for candidate in candidates:
        if candidate.is_file():
            return candidate.resolve()
    raise AgentDocumentError("Native PDF/SMD export engine is unavailable; provide --engine or build smd-core's smd-engine")


def _clean_markdown_images(markdown: str) -> str:
    """Drop fenced code before discovering image sources for offline packaging."""
    kept = []
    fence_char: str | None = None
    fence_size = 0
    for line in markdown.splitlines(keepends=True):
        match = _FENCE.match(line.rstrip("\r\n"))
        if match:
            marker = match.group(1)
            if fence_char is None:
                fence_char, fence_size = marker[0], len(marker)
            elif marker[0] == fence_char and len(marker) >= fence_size:
                fence_char = None
            kept.append("\n" if line.endswith("\n") else "")
        elif fence_char is None:
            kept.append(line)
        else:
            kept.append("\n" if line.endswith("\n") else "")
    return "".join(kept)


def _image_destinations(markdown: str) -> list[str]:
    visible = _clean_markdown_images(markdown)
    references = {}
    for match in _REFERENCE.finditer(visible):
        label = " ".join(match.group(1).casefold().split())
        references[label] = match.group(2) or match.group(3)
    sources = [match.group(1) or match.group(2) for match in _INLINE_IMAGE.finditer(visible)]
    for match in _IMAGE_LABEL.finditer(visible):
        label = match.group(1) or re.search(r"!\[([^\]]*)\]", match.group(0)).group(1)
        normalized = " ".join(label.casefold().split())
        if normalized in references:
            sources.append(references[normalized])
    # Stable unique sequence keeps request sizes down while preserving lookup keys.
    return list(dict.fromkeys(source for source in sources if source))


def _contains_unsupported_diagrams(markdown: str) -> bool:
    fence_char = None
    fence_size = 0
    for line in markdown.splitlines():
        match = _FENCE.match(line)
        if not match:
            continue
        marker = match.group(1)
        if fence_char is None:
            info = line[match.end():].strip().split(None, 1)
            if info and info[0].casefold() in ("mermaid", "smd-chart"):
                return True
            fence_char, fence_size = marker[0], len(marker)
        elif marker[0] == fence_char and len(marker) >= fence_size:
            fence_char = None
    return False


def _resolve_image_assets(store: DocumentStore, note: Path, markdown: str,
                          embedded: dict[str, str]) -> dict[str, str]:
    # Portable SMD stores complete data URLs, whereas export-json accepts raw
    # base64. Send only referenced images, preserving their decoded bytes and
    # avoiding unrelated portable assets in the typesetter request.
    assets: dict[str, str] = {}
    note_dir = note.parent.resolve(strict=True)
    for source in _image_destinations(markdown):
        if source in embedded:
            _mime, payload = documents.image_data(embedded[source])
            assets[source] = base64.b64encode(payload).decode("ascii")
            continue
        if source.startswith("data:"):
            documents.image_data(source)
            assets[source] = source.split(",", 1)[1]
            continue
        if source.lower().startswith(("http://", "https://", "//")):
            raise AgentDocumentError(f"PDF export cannot fetch remote image {source[:180]!r}; embed it first in the app")
        if "://" in source:
            raise AgentDocumentError(f"Unsupported image URL scheme in {source[:160]!r}")
        relative = urllib.parse.unquote(source.split("#", 1)[0].split("?", 1)[0])
        if not relative or Path(relative).is_absolute():
            raise AgentDocumentError("Image path must be relative to its note")
        candidate = (note_dir / relative).absolute()
        if _symlink_component(candidate):
            raise AgentDocumentError(f"Symlink image paths are not allowed: {source[:160]!r}")
        try:
            image = candidate.resolve(strict=True)
        except OSError as exc:
            raise AgentDocumentError(f"Local image is unavailable: {source[:160]!r}") from exc
        if image != note_dir and note_dir not in image.parents:
            raise AgentDocumentError("Image is outside the note's folder")
        if not image.is_file() or image.stat().st_size > documents.MAX_IMAGE:
            raise AgentDocumentError("Local image is missing or exceeds 25 MB")
        mime = documents.MIMES.get(image.suffix.lower().lstrip("."))
        if mime is None:
            raise AgentDocumentError("Local image type must be PNG, JPEG, SVG, GIF, WebP, or AVIF")
        payload = image.read_bytes()
        if len(payload) > documents.MAX_IMAGE:
            raise AgentDocumentError("Local image exceeds 25 MB")
        assets[source] = base64.b64encode(payload).decode("ascii")
    return assets


def _read_font_assets(font_dir: str | os.PathLike[str] | None) -> dict[str, str]:
    if not font_dir:
        return {}
    directory = Path(font_dir).expanduser().resolve(strict=True)
    if not directory.is_dir():
        raise AgentDocumentError("font-dir must be a directory")
    files = sorted([path for path in directory.iterdir() if path.suffix.lower() in (".ttf", ".otf")])
    if len(files) > 32:
        raise AgentDocumentError("PDF font directory exceeds 32 font files")
    total, result = 0, {}
    for path in files:
        if path.is_symlink() or not path.is_file():
            raise AgentDocumentError("PDF font directories cannot contain symlink fonts")
        size = path.stat().st_size
        total += size
        if size <= 0 or size > 20_000_000 or total > 64_000_000:
            raise AgentDocumentError("PDF font assets exceed the per-file or 64 MB total limit")
        result["__font_" + path.name] = base64.b64encode(path.read_bytes()).decode("ascii")
    return result


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        while chunk := stream.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def _publish_create_only(stage: Path, target: Path, *, max_size: int) -> dict:
    size = stage.stat().st_size
    if size <= 0 or size > max_size:
        raise AgentDocumentError(f"Generated output must be between 1 byte and {max_size // 1_000_000} MB")
    if target.exists():
        raise RevisionConflict("Export never overwrites an existing file")
    if _symlink_component(target):
        raise AgentDocumentError("Refusing to publish through a symlink path")
    try:
        os.link(stage, target)
    except FileExistsError as exc:
        raise RevisionConflict("An output file was created while export was running") from exc
    except OSError as exc:
        raise AgentDocumentError("Could not atomically publish export; choose a same-volume output folder") from exc
    return {"path": str(target), "bytes": size, "sha256": _sha256_file(target), "saved": True}


def export_smd(store: DocumentStore, source_value: str, output_value: str, *, engine=None) -> dict:
    source = store.resolve(source_value)
    target = store.resolve(output_value, must_exist=False)
    if source == target:
        raise AgentDocumentError("SMD export output must be a separate file")
    if target.suffix.lower() != ".smd":
        raise AgentDocumentError("SMD export output must use the .smd extension")
    if target.exists():
        raise RevisionConflict("Export never overwrites an existing file")
    markdown, assets, portable, _raw = store._load(source)
    sources = _image_destinations(markdown)
    unresolved = [item for item in sources if item not in assets and not item.startswith("data:")]
    if not unresolved:
        data = documents.compressed_bundle(markdown, assets)
        fd, stage_name = tempfile.mkstemp(prefix=f".{target.name}.", suffix=".stage", dir=target.parent)
        try:
            with os.fdopen(fd, "wb") as stream:
                stream.write(data); stream.flush(); os.fsync(stream.fileno())
            result = _publish_create_only(Path(stage_name), target, max_size=documents.MAX_FILE)
        finally:
            Path(stage_name).unlink(missing_ok=True)
        return {**result, "source": store.display_path(source), "format": "supermd-smd", "assets": len(assets)}
    executable = find_engine(engine)
    fd, stage_name = tempfile.mkstemp(prefix=f".{target.name}.", suffix=".stage.smd", dir=target.parent)
    os.close(fd)
    stage = Path(stage_name)
    stage.unlink(missing_ok=True)
    try:
        completed = subprocess.run([str(executable), "pack", str(source), str(stage)],
                                   stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                   timeout=120, check=False, shell=False)
        if completed.returncode:
            message = completed.stderr.decode("utf-8", errors="replace")[:1000].strip()
            raise AgentDocumentError(message or "Native SMD packing failed")
        result = _publish_create_only(stage, target, max_size=documents.MAX_FILE)
        return {**result, "source": store.display_path(source), "format": "supermd-smd"}
    except subprocess.TimeoutExpired as exc:
        raise AgentDocumentError("SMD export timed out after 120 seconds") from exc
    finally:
        stage.unlink(missing_ok=True)


def export_pdf(store: DocumentStore, source_value: str, output_value: str, *, options=None,
               engine=None, font_dir=None) -> dict:
    source = store.resolve(source_value)
    target = store.resolve(output_value, must_exist=False)
    if source == target:
        raise AgentDocumentError("PDF output must be a separate file")
    if target.suffix.lower() != ".pdf":
        raise AgentDocumentError("PDF output must use the .pdf extension")
    if target.exists():
        raise RevisionConflict("Export never overwrites an existing file")
    normalized = validate_pdf_options(options)
    markdown, embedded, _, _raw = store._load(source)
    if _contains_unsupported_diagrams(markdown):
        raise AgentDocumentError("The native offline PDF engine does not render Mermaid or smd-chart blocks; export this open note from the desktop app")
    assets = _resolve_image_assets(store, source, markdown, embedded)
    assets.update(_read_font_assets(font_dir))
    request = {"content": markdown, "assets": assets, "options": normalized}
    try:
        encoded = json.dumps(request, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    except (TypeError, UnicodeError) as exc:
        raise AgentDocumentError("PDF request must be valid JSON text") from exc
    if len(encoded) > MAX_EXPORT_REQUEST:
        raise AgentDocumentError("PDF request exceeds the 120 MB native engine input limit")
    executable = find_engine(engine)
    fd, stage_name = tempfile.mkstemp(prefix=f".{target.name}.", suffix=".stage.pdf", dir=target.parent)
    os.close(fd)
    Path(stage_name).unlink(missing_ok=True)
    try:
        completed = subprocess.run([str(executable), "export-json", stage_name], input=encoded,
                                   stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=120,
                                   check=False, shell=False)
        if completed.returncode:
            message = completed.stderr.decode("utf-8", errors="replace")[:1000].strip()
            raise AgentDocumentError(message or "Native PDF export failed")
        stage = Path(stage_name)
        with stage.open("rb") as stream:
            if stream.read(5) != b"%PDF-":
                raise AgentDocumentError("Native PDF export produced an invalid PDF")
        result = _publish_create_only(stage, target, max_size=MAX_PDF)
        return {**result, "source": store.display_path(source), "format": "pdf", "options": normalized}
    except subprocess.TimeoutExpired as exc:
        raise AgentDocumentError("PDF export timed out after 120 seconds") from exc
    finally:
        Path(stage_name).unlink(missing_ok=True)
