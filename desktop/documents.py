"""Portable SMD compatibility and bounded asset access, without Qt dependencies."""
import base64
from collections import OrderedDict
import gzip
import hashlib
import json
import os
import re
import stat
import tempfile
import threading
import zlib
from pathlib import Path

MIMES = {"png": "image/png", "jpg": "image/jpeg", "jpeg": "image/jpeg", "svg": "image/svg+xml", "gif": "image/gif", "webp": "image/webp", "avif": "image/avif"}
MAX_FILE = 120_000_000
MAX_IMAGE = 25_000_000
GZIP_MAGIC = b"\x1f\x8b"
PORTABLE_COMPRESSLEVEL = 3
_SAFE_ASSET_NAME = re.compile(r"assets/[A-Za-z0-9._-]{1,150}")
_MAX_CACHED_ASSETS = 512
_MAX_CACHED_CHARS = 110_000_000
_VALIDATED_LOCK = threading.Lock()
_VALIDATED_ASSETS: OrderedDict[int, tuple[str, str, int]] = OrderedDict()
_VALIDATED_CHARS = 0
_MAX_RECENT_PORTABLE = 8
_RECENT_PORTABLE_FILES: OrderedDict[tuple[int, int, int, int], tuple[str, str, dict[str, str]]] = OrderedDict()


_B64_DECODE_CHUNK = 262_144    # 256 KiB chars (multiple of 4)
_B64_ENCODE_CHUNK = 196_608    # 192 KiB bytes (multiple of 3)


def decode_base64_chunked(encoded: str, max_bytes: int | None = None) -> bytes:
    """Strictly decode base64 in bounded slices so large images never monopolize the GIL."""
    if not isinstance(encoded, str):
        raise ValueError("Expected a base64 string")
    total_chars = len(encoded)
    if total_chars <= _B64_DECODE_CHUNK:
        decoded = base64.b64decode(encoded, validate=True)
        if max_bytes is not None and len(decoded) > max_bytes:
            raise ValueError(f"Decoded data exceeds {max_bytes} bytes")
        return decoded
    parts: list[bytes] = []
    decoded_len = 0
    for offset in range(0, total_chars, _B64_DECODE_CHUNK):
        chunk = encoded[offset:offset + _B64_DECODE_CHUNK]
        if offset + _B64_DECODE_CHUNK < total_chars and "=" in chunk:
            raise base64.binascii.Error("Excess data after padding")
        piece = base64.b64decode(chunk, validate=True)
        decoded_len += len(piece)
        if max_bytes is not None and decoded_len > max_bytes:
            raise ValueError(f"Decoded data exceeds {max_bytes} bytes")
        if piece:
            parts.append(piece)
    return b"".join(parts)


def encode_base64_chunked(raw: bytes) -> str:
    """Encode bytes to ASCII base64 in 3-byte-aligned slices so large payloads yield the GIL."""
    if len(raw) <= _B64_ENCODE_CHUNK:
        return base64.b64encode(raw).decode("ascii")
    return "".join(
        base64.b64encode(raw[offset:offset + _B64_ENCODE_CHUNK]).decode("ascii")
        for offset in range(0, len(raw), _B64_ENCODE_CHUNK)
    )


def _validate_base64_len(encoded: str, max_bytes: int) -> int:
    total_chars = len(encoded)
    if total_chars == 0:
        return 0
    decoded_len = 0
    for offset in range(0, total_chars, _B64_DECODE_CHUNK):
        chunk = encoded[offset:offset + _B64_DECODE_CHUNK]
        if offset + _B64_DECODE_CHUNK < total_chars and "=" in chunk:
            raise ValueError("Expected a base64 image")
        piece = base64.b64decode(chunk, validate=True)
        decoded_len += len(piece)
        if decoded_len > max_bytes:
            raise ValueError("Image exceeds 25 MB")
    return decoded_len


def _cache_validated_asset(data: str, mime: str, decoded_len: int) -> None:
    global _VALIDATED_CHARS
    data_len = len(data)
    if data_len > _MAX_CACHED_CHARS:
        return
    key = id(data)
    with _VALIDATED_LOCK:
        existing = _VALIDATED_ASSETS.pop(key, None)
        if existing is not None:
            _VALIDATED_CHARS -= len(existing[0])
        _VALIDATED_ASSETS[key] = (data, mime, decoded_len)
        _VALIDATED_CHARS += data_len
        while len(_VALIDATED_ASSETS) > _MAX_CACHED_ASSETS or _VALIDATED_CHARS > _MAX_CACHED_CHARS:
            _, evicted = _VALIDATED_ASSETS.popitem(last=False)
            _VALIDATED_CHARS -= len(evicted[0])


def _cache_portable_file(stat_key: tuple[int, int, int, int], sha256_hex: str, markdown: str, assets: dict[str, str]) -> None:
    if sum(len(v) for v in assets.values()) > _MAX_CACHED_CHARS:
        return
    with _VALIDATED_LOCK:
        _RECENT_PORTABLE_FILES.pop(stat_key, None)
        _RECENT_PORTABLE_FILES[stat_key] = (sha256_hex, markdown, dict(assets))
        while len(_RECENT_PORTABLE_FILES) > _MAX_RECENT_PORTABLE:
            _RECENT_PORTABLE_FILES.popitem(last=False)


def _lookup_verified_portable_file(path: Path, stat_key: tuple[int, int, int, int]) -> tuple[str, dict[str, str]] | None:
    with _VALIDATED_LOCK:
        entry = _RECENT_PORTABLE_FILES.get(stat_key)
    if entry is None:
        return None
    expected_sha, markdown, assets = entry
    hasher = hashlib.sha256()
    total = 0
    try:
        with path.open("rb") as source:
            while chunk := source.read(1_048_576):
                total += len(chunk)
                if total > MAX_FILE:
                    return None
                hasher.update(chunk)
        after = path.stat()
    except OSError:
        return None
    if (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns) != stat_key or hasher.hexdigest() != expected_sha:
        return None
    with _VALIDATED_LOCK:
        current = _RECENT_PORTABLE_FILES.get(stat_key)
        if current is not None and current[0] == expected_sha:
            _RECENT_PORTABLE_FILES.move_to_end(stat_key)
    return markdown, dict(assets)


def _validated_image_meta(data: str) -> tuple[str, int]:
    if not isinstance(data, str):
        raise ValueError("Expected a base64 image")
    key = id(data)
    with _VALIDATED_LOCK:
        entry = _VALIDATED_ASSETS.get(key)
        if entry is not None and entry[0] is data:
            _VALIDATED_ASSETS.move_to_end(key)
            return entry[1], entry[2]
    header, sep, encoded = data.partition(",")
    if not sep or not header.startswith("data:") or not header.endswith(";base64"):
        raise ValueError("Expected a base64 image")
    mime = header[5:-7]
    if mime not in MIMES.values() or len(encoded) > MAX_IMAGE * 4 // 3 + 4:
        raise ValueError("Unsupported image or image exceeds 25 MB")
    decoded_len = _validate_base64_len(encoded, MAX_IMAGE)
    _cache_validated_asset(data, mime, decoded_len)
    return mime, decoded_len


def _is_cached_validated_asset(data: str) -> bool:
    if not isinstance(data, str):
        return False
    with _VALIDATED_LOCK:
        entry = _VALIDATED_ASSETS.get(id(data))
        return entry is not None and entry[0] is data


def image_data(data: str) -> tuple[str, bytes]:
    header, encoded = data.split(",", 1)
    if not header.startswith("data:") or not header.endswith(";base64"):
        raise ValueError("Expected a base64 image")
    mime = header[5:-7]
    if mime not in MIMES.values() or len(encoded) > MAX_IMAGE * 4 // 3 + 4:
        raise ValueError("Unsupported image or image exceeds 25 MB")
    result = decode_base64_chunked(encoded)
    if len(result) > MAX_IMAGE:
        raise ValueError("Image exceeds 25 MB")
    _cache_validated_asset(data, mime, len(result))
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
        if not isinstance(name, str) or not _SAFE_ASSET_NAME.fullmatch(name) or name.rsplit("/", 1)[1] in (".", ".."):
            raise ValueError("Unsafe asset name")
        mime, decoded_len = _validated_image_meta(data)
        if MIMES.get(name.rsplit(".", 1)[-1].lower()) != mime:
            raise ValueError("Image MIME does not match its extension")
        total += decoded_len
        if total > 75_000_000:
            raise ValueError("Assets exceed 75 MB")

def _gzip_json_input(path: Path, raw: bytes | None = None, hasher=None) -> bytearray:
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
            if hasher is not None:
                hasher.update(chunk)
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
    with gzip.GzipFile(fileobj=target, mode="wb", filename="", mtime=0, compresslevel=PORTABLE_COMPRESSLEVEL) as compressed:
        length = 0

        def write_bytes(data: bytes) -> None:
            nonlocal length
            length += len(data)
            if length > MAX_FILE:
                raise ValueError("SMD JSON exceeds 120 MB")
            compressed.write(data)

        assets = value.get("assets")
        if (list(value.keys()) == ["format", "version", "markdown", "assets"]
                and isinstance(value["format"], str)
                and isinstance(value["version"], int) and not isinstance(value["version"], bool)
                and isinstance(value["markdown"], str)
                and isinstance(assets, dict)):
            head = (
                '{"format":' + json.dumps(value["format"], ensure_ascii=False, separators=(",", ":"))
                + ',"version":' + str(value["version"])
                + ',"markdown":' + json.dumps(value["markdown"], ensure_ascii=False, separators=(",", ":"))
                + ',"assets":{'
            ).encode("utf-8")
            write_bytes(head)
            first = True
            for name, data in assets.items():
                if (isinstance(name, str) and _SAFE_ASSET_NAME.fullmatch(name)
                        and _is_cached_validated_asset(data)):
                    write_bytes((b"" if first else b",") + b'"' + name.encode("ascii") + b'":"')
                    for offset in range(0, len(data), _B64_DECODE_CHUNK):
                        write_bytes(data[offset:offset + _B64_DECODE_CHUNK].encode("ascii"))
                    write_bytes(b'"')
                else:
                    entry = (
                        ("" if first else ",")
                        + json.dumps(name, ensure_ascii=False, separators=(",", ":"))
                        + ":"
                        + json.dumps(data, ensure_ascii=False, separators=(",", ":"))
                    ).encode("utf-8")
                    write_bytes(entry)
                first = False
            write_bytes(b"}}")
            return

        class BoundedTextWriter:
            def write(self, text):
                write_bytes(text.encode("utf-8"))
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

def _replace_with_windows_sharing_retry(source: str, target: Path) -> None:
    """Preserve atomic replacement despite brief Windows AV/indexer file locks.

    Only transient sharing/access-denied errors are retried, for at most one
    second. Other errors fail immediately and the caller cleans up its temp.
    """
    if os.name != "nt":
        os.replace(source, target)
        return
    import time
    deadline = time.monotonic() + 1.0
    while True:
        try:
            os.replace(source, target)
            return
        except PermissionError as error:
            if getattr(error, "winerror", None) not in (5, 32) or time.monotonic() >= deadline:
                raise
            time.sleep(0.04)

def write_portable(path: Path, markdown: str, assets: dict[str, str]) -> None:
    """Atomically save the unchanged v1 JSON envelope in deterministic gzip."""
    value = bundle(markdown, assets)
    hasher = hashlib.sha256()
    handle, temporary = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=path.parent)
    try:
        with os.fdopen(handle, "wb") as raw:
            if path.exists() and hasattr(os, "fchmod"):
                os.fchmod(raw.fileno(), stat.S_IMODE(path.stat().st_mode))

            class _HashingWriter:
                def write(self, data: bytes) -> int:
                    hasher.update(data)
                    return raw.write(data)

                def flush(self) -> None:
                    raw.flush()

            _write_gzip_json(_HashingWriter(), value)
            if raw.tell() > MAX_FILE:
                raise ValueError("Compressed SMD exceeds 120 MB")
            raw.flush()
            os.fsync(raw.fileno())
        _replace_with_windows_sharing_retry(temporary, path)
        try:
            st = path.stat()
            _cache_portable_file((st.st_dev, st.st_ino, st.st_size, st.st_mtime_ns), hasher.hexdigest(), markdown, assets)
        except OSError:
            pass
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)

def open_note(path: Path) -> tuple[str, dict[str, str], bool]:
    before = path.stat()
    size = before.st_size
    if size > MAX_FILE:
        raise ValueError("Note exceeds 120 MB")
    stat_key = (before.st_dev, before.st_ino, size, before.st_mtime_ns)
    with path.open("rb") as source:
        is_gzip = source.read(2) == GZIP_MAGIC
    if is_gzip:
        cached = _lookup_verified_portable_file(path, stat_key)
        if cached is not None:
            return cached[0], cached[1], True
        hasher = hashlib.sha256()
        try:
            value = json.loads(_gzip_json_input(path, hasher=hasher))
        except (json.JSONDecodeError, UnicodeDecodeError, zlib.error, OSError, EOFError) as error:
            raise ValueError("This compressed portable note is damaged") from error
        validate(value)
        try:
            after = path.stat()
            if (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns) == stat_key:
                _cache_portable_file(stat_key, hasher.hexdigest(), value["markdown"], value["assets"])
        except OSError:
            pass
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
        _replace_with_windows_sharing_retry(temporary, path)
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
        _replace_with_windows_sharing_retry(temporary,path)
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
