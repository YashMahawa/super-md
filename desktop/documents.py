"""Portable SMD compatibility and bounded asset access, without Qt dependencies."""
import base64
import gzip
import json
import os
import re
import stat
import tempfile
import zlib
from pathlib import Path

MIMES = {"png": "image/png", "jpg": "image/jpeg", "jpeg": "image/jpeg", "svg": "image/svg+xml", "gif": "image/gif", "webp": "image/webp", "avif": "image/avif"}
MAX_FILE = 120_000_000
MAX_IMAGE = 25_000_000
GZIP_MAGIC = b"\x1f\x8b"

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

def _gzip_json_input(path: Path, raw: bytes | None = None) -> bytearray:
    """Inflate one gzip member, bounding output and rejecting trailing members/data."""
    decoder = zlib.decompressobj(16 + zlib.MAX_WBITS)
    output = bytearray()
    compressed_size = 0
    import io
    with (io.BytesIO(raw) if raw is not None else path.open("rb")) as source:
        while chunk := source.read(64 * 1024):
            compressed_size += len(chunk)
            if compressed_size > MAX_FILE:
                raise ValueError("Compressed SMD exceeds 120 MB")
            pending = chunk
            while pending:
                remaining = MAX_FILE - len(output)
                decoded = decoder.decompress(pending, remaining + 1)
                output.extend(decoded)
                if len(output) > MAX_FILE:
                    raise ValueError("Inflated SMD exceeds 120 MB")
                if decoder.unused_data:
                    raise ValueError("SMD gzip stream contains trailing or concatenated data")
                pending = decoder.unconsumed_tail
                if pending and not decoded:
                    raise ValueError("Inflated SMD exceeds 120 MB")
        if not decoder.eof:
            raise ValueError("SMD gzip stream is truncated")
        tail = decoder.flush(MAX_FILE - len(output) + 1)
        output.extend(tail)
        if len(output) > MAX_FILE:
            raise ValueError("Inflated SMD exceeds 120 MB")
        if decoder.unused_data or decoder.unconsumed_tail:
            raise ValueError("SMD gzip stream contains trailing or concatenated data")
    return output

def _write_gzip_json(target, value: dict) -> None:
    """Write deterministic gzip with an empty filename and fixed timestamp."""
    import io
    with gzip.GzipFile(fileobj=target, mode="wb", filename="", mtime=0, compresslevel=9) as compressed:
        class BoundedTextWriter:
            def __init__(self): self.length = 0
            def write(self, text):
                data = text.encode("utf-8")
                self.length += len(data)
                if self.length > MAX_FILE: raise ValueError("SMD JSON exceeds 120 MB")
                compressed.write(data)
                return len(text)
        json.dump(value, BoundedTextWriter(), ensure_ascii=False, separators=(",", ":"))

def compressed_bundle(markdown: str, assets: dict[str, str]) -> bytes:
    value = bundle(markdown, assets)
    import io
    output = io.BytesIO()
    _write_gzip_json(output, value)
    data = output.getvalue()
    if len(data) > MAX_FILE:
        raise ValueError("Compressed SMD exceeds 120 MB")
    return data

def write_portable(path: Path, markdown: str, assets: dict[str, str]) -> None:
    """Atomically save the unchanged v1 JSON envelope in deterministic gzip."""
    value = bundle(markdown, assets)
    handle, temporary = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=path.parent)
    try:
        with os.fdopen(handle, "wb") as raw:
            if path.exists() and hasattr(os, "fchmod"):
                os.fchmod(raw.fileno(), stat.S_IMODE(path.stat().st_mode))
            _write_gzip_json(raw, value)
            if raw.tell() > MAX_FILE:
                raise ValueError("Compressed SMD exceeds 120 MB")
            raw.flush()
            os.fsync(raw.fileno())
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)

def open_note(path: Path) -> tuple[str, dict[str, str], bool]:
    size = path.stat().st_size
    if size > MAX_FILE:
        raise ValueError("Note exceeds 120 MB")
    with path.open("rb") as source:
        is_gzip = source.read(2) == GZIP_MAGIC
    if is_gzip:
        try:
            value = json.loads(_gzip_json_input(path))
        except (json.JSONDecodeError, UnicodeDecodeError, zlib.error, OSError, EOFError) as error:
            raise ValueError("This compressed portable note is damaged") from error
        validate(value)
        return value["markdown"], value["assets"], True
    return _decode_text_note(path.read_text(encoding="utf-8-sig"), path)

def decode_note_bytes(raw: bytes, path: Path) -> tuple[str, dict[str, str], bool]:
    """Decode the exact snapshot used for an agent's revision, without rereading."""
    if len(raw) > MAX_FILE:
        raise ValueError("Note exceeds 120 MB")
    if raw.startswith(GZIP_MAGIC):
        try:
            value = json.loads(_gzip_json_input(path, raw))
        except (json.JSONDecodeError, UnicodeDecodeError, zlib.error, OSError, EOFError) as error:
            raise ValueError("This compressed portable note is damaged") from error
        validate(value)
        return value["markdown"], value["assets"], True
    return _decode_text_note(raw.decode("utf-8-sig"), path)

def _decode_text_note(raw: str, path: Path) -> tuple[str, dict[str, str], bool]:
    # Sharing providers and browsers may rename a portable note to .txt/.json,
    # or omit its extension. The validated envelope, not a filename, is decisive.
    if raw.lstrip().startswith("{"):
        try:
            value = json.loads(raw)
        except json.JSONDecodeError:
            # A Markdown note starting with a brace is not necessarily a bundle.
            if re.search(r'"format"\s*:\s*"supermd-(?:smd|fmd)"', raw[:65536]):
                raise ValueError("This portable note is damaged")
        else:
            if isinstance(value, dict) and (value.get("format") in ("supermd-smd", "supermd-fmd") or path.suffix.lower() in (".smd", ".fmd") and "format" in value):
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

def atomic_json(path: Path, value) -> None:
    """Write ordered recovery without full-workspace JSON + UTF-8 copies."""
    handle, temporary = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=path.parent)
    try:
        with os.fdopen(handle, "w", encoding="utf-8", errors="backslashreplace") as file:
            if path.exists() and hasattr(os,"fchmod"):
                os.fchmod(file.fileno(),stat.S_IMODE(path.stat().st_mode))
            json.dump(value,file,ensure_ascii=False)
            file.flush();os.fsync(file.fileno())
        os.replace(temporary,path)
    finally:
        if os.path.exists(temporary):os.unlink(temporary)

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
