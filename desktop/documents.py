"""Portable SMD compatibility and bounded asset access, without Qt dependencies."""
import base64
import json
import os
import re
import stat
import tempfile
from pathlib import Path

MIMES = {"png": "image/png", "jpg": "image/jpeg", "jpeg": "image/jpeg", "svg": "image/svg+xml", "gif": "image/gif", "webp": "image/webp", "avif": "image/avif"}
MAX_FILE = 120_000_000
MAX_IMAGE = 25_000_000

def image_data(data: str) -> tuple[str, bytes]:
    header, encoded = data.split(",", 1)
    if not header.startswith("data:") or not header.endswith(";base64"):
        raise ValueError("Expected a base64 image")
    mime = header[5:-7]
    if mime not in MIMES.values() or len(encoded) > MAX_IMAGE * 4 // 3 + 4:
        raise ValueError("Unsupported image or image exceeds 25 MB")
    result = base64.b64decode(encoded, validate=True)
    if len(result) > MAX_IMAGE:
        raise ValueError("Image exceeds 25 MB")
    return mime, result

def bundle(markdown: str, assets: dict[str, str]) -> dict:
    value = {"format": "supermd-smd", "version": 1, "markdown": markdown, "assets": assets}
    validate(value)
    return value

def validate(value: dict) -> None:
    if set(value) != {"format", "version", "markdown", "assets"} or value["format"] not in ("supermd-smd", "supermd-fmd") or value["version"] != 1:
        raise ValueError("Unsupported portable note format/version")
    if not isinstance(value["markdown"], str) or len(value["markdown"].encode()) > 20_000_000 or not isinstance(value["assets"], dict) or len(value["assets"]) > 512:
        raise ValueError("Portable note is too large or malformed")
    total = 0
    for name, data in value["assets"].items():
        if not re.fullmatch(r"assets/[A-Za-z0-9._-]{1,150}", name) or name.rsplit("/", 1)[1] in (".", ".."):
            raise ValueError("Unsafe asset name")
        mime, decoded = image_data(data)
        if MIMES.get(name.rsplit(".", 1)[-1].lower()) != mime:
            raise ValueError("Image MIME does not match its extension")
        total += len(decoded)
        if total > 75_000_000:
            raise ValueError("Assets exceed 75 MB")

def open_note(path: Path) -> tuple[str, dict[str, str], bool]:
    if path.stat().st_size > MAX_FILE:
        raise ValueError("Note exceeds 120 MB")
    raw = path.read_text(encoding="utf-8-sig")
    if path.suffix.lower() in (".smd", ".fmd") and raw.lstrip().startswith("{"):
        try:
            value = json.loads(raw)
        except json.JSONDecodeError:
            # A Markdown note starting with a brace is not necessarily a bundle.
            if '"supermd-' in raw[:200]:
                raise ValueError("This portable note is damaged")
        else:
            if isinstance(value, dict) and "format" in value:
                validate(value)
                return value["markdown"], value["assets"], True
    return raw, {}, False

def atomic_write(path: Path, data: bytes) -> None:
    # Same-filesystem replace is atomic; a cancelled/failed write leaves the old note intact.
    handle, temporary = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=path.parent)
    try:
        with os.fdopen(handle, "wb") as file:
            if path.exists() and hasattr(os,"fchmod"):
                os.fchmod(file.fileno(),stat.S_IMODE(path.stat().st_mode))
            file.write(data)
            file.flush()
            os.fsync(file.fileno())
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)

def materialize_assets(root: Path, assets: dict[str,str]) -> None:
    """Save a portable note as Markdown without dropping its pictures or overwriting others."""
    bundle("",assets)
    root = root.resolve()
    decoded = []
    for name,data in assets.items():
        path = (root/name).resolve()
        if not path.is_relative_to(root):
            raise ValueError("Image destination is outside the note folder")
        _,raw = image_data(data)
        if path.exists() and (path.stat().st_size != len(raw) or path.read_bytes() != raw):
            raise ValueError(f"An unrelated image already exists at {name}; choose another folder")
        decoded.append((path,raw))
    for path,raw in decoded:
        path.parent.mkdir(parents=True,exist_ok=True)
        if not path.exists():
            atomic_write(path,raw)
