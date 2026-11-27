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
MAX_MARKDOWN = 20_000_000
MAX_IMAGE = 25_000_000
MAX_TOTAL_IMAGES = 75_000_000
MAX_ASSETS = 512
GZIP_MAGIC = b"\x1f\x8b"
PORTABLE_COMPRESSLEVEL = 3
_SAFE_ASSET_FILENAME = re.compile(r"(?!\.\.?\Z)[A-Za-z0-9._-]{1,150}")
_SAFE_COMPAT_ASSET_FILENAME = re.compile(r"(?!\.\.?\Z)[A-Za-z0-9._-]{1,159}")
_SAFE_ASSET_NAME = re.compile(r"assets/(?!\.\.?\Z)[A-Za-z0-9._-]{1,159}")


def is_valid_asset_filename(filename: str) -> bool:
    return isinstance(filename, str) and _SAFE_ASSET_FILENAME.fullmatch(filename) is not None


def is_valid_compat_asset_filename(filename: str) -> bool:
    return isinstance(filename, str) and _SAFE_COMPAT_ASSET_FILENAME.fullmatch(filename) is not None


def is_valid_new_asset_key(name: str) -> bool:
    return isinstance(name, str) and name.startswith("assets/") and is_valid_asset_filename(name[7:])


def is_valid_asset_key(name: str) -> bool:
    return isinstance(name, str) and name.startswith("assets/") and is_valid_compat_asset_filename(name[7:])
_MAX_CACHED_ASSETS = 512
_MAX_CACHED_CHARS = 110_000_000
_VALIDATED_LOCK = threading.Lock()
_VALIDATED_ASSETS: OrderedDict[int, tuple[str, str, int]] = OrderedDict()
_VALIDATED_CHARS = 0
_MAX_RECENT_PORTABLE = 8
_RECENT_PORTABLE_FILES: OrderedDict[tuple[int, int, int, int], tuple[str, str, dict[str, str], bool]] = OrderedDict()


_B64_DECODE_CHUNK = 262_144    # 256 KiB chars (multiple of 4)
_B64_ENCODE_CHUNK = 196_608    # 192 KiB bytes (multiple of 3)


def decode_base64_chunked(encoded: str, max_bytes: int | None = None, *, start: int = 0) -> bytes:
    """Strictly decode base64 in bounded slices so large images never monopolize the GIL."""
    if not isinstance(encoded, str):
        raise ValueError("Expected a base64 string")
    end = len(encoded)
    total_chars = end - start
    if total_chars <= _B64_DECODE_CHUNK:
        decoded = base64.b64decode(encoded if start == 0 else encoded[start:], validate=True)
        if max_bytes is not None and len(decoded) > max_bytes:
            raise ValueError(f"Decoded data exceeds {max_bytes} bytes")
        return decoded
    parts: list[bytes] = []
    decoded_len = 0
    for offset in range(start, end, _B64_DECODE_CHUNK):
        chunk = encoded[offset:offset + _B64_DECODE_CHUNK]
        if offset + _B64_DECODE_CHUNK < end and "=" in chunk:
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


def _validate_base64_len(encoded: str, max_bytes: int, start: int = 0) -> int:
    end = len(encoded)
    if end <= start:
        return 0
    decoded_len = 0
    for offset in range(start, end, _B64_DECODE_CHUNK):
        chunk = encoded[offset:offset + _B64_DECODE_CHUNK]
        if offset + _B64_DECODE_CHUNK < end and "=" in chunk:
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


def _cache_portable_file(
    stat_key: tuple[int, int, int, int],
    sha256_hex: str,
    markdown: str,
    assets: dict[str, str],
    *,
    assets_decoded: bool,
) -> None:
    if sum(len(v) for v in assets.values()) > _MAX_CACHED_CHARS:
        return
    with _VALIDATED_LOCK:
        existing = _RECENT_PORTABLE_FILES.pop(stat_key, None)
        if existing is not None and existing[0] == sha256_hex and existing[3] and not assets_decoded:
            assets = existing[2]
            assets_decoded = True
        _RECENT_PORTABLE_FILES[stat_key] = (sha256_hex, markdown, dict(assets), assets_decoded)
        while len(_RECENT_PORTABLE_FILES) > _MAX_RECENT_PORTABLE:
            _RECENT_PORTABLE_FILES.popitem(last=False)


def _lookup_verified_portable_file(
    path: Path, stat_key: tuple[int, int, int, int]
) -> tuple[str, str, dict[str, str], bool] | None:
    with _VALIDATED_LOCK:
        entry = _RECENT_PORTABLE_FILES.get(stat_key)
    if entry is None:
        return None
    expected_sha, markdown, assets, assets_decoded = entry
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
    return expected_sha, markdown, dict(assets), assets_decoded


def _encoded_byte_bound(data: str, start: int = 0) -> int:
    length = len(data) - start
    if length <= 0:
        return 0
    padding = 2 if data.endswith("==") else 1 if data.endswith("=") else 0
    return (length // 4) * 3 - padding


def _parse_image_header(data: str) -> tuple[str, int, int]:
    if not isinstance(data, str) or not data.startswith("data:"):
        raise ValueError("Expected a base64 image")
    comma = data.find(",", 5, 128)
    if comma < 0:
        comma = data.find(",", 128)
        if comma < 0:
            raise ValueError("Expected a base64 image")
    header = data[:comma]
    if not header.endswith(";base64"):
        raise ValueError("Expected a base64 image")
    encoded_start = comma + 1
    encoded_len = len(data) - encoded_start
    if encoded_len % 4 != 0 or (encoded_len >= 3 and data.endswith("===")):
        raise ValueError("Invalid base64 image")
    mime = header[5:-7]
    max_encoded = ((MAX_IMAGE + 2) // 3) * 4
    estimated = _encoded_byte_bound(data, encoded_start)
    if mime not in MIMES.values() or encoded_len > max_encoded or estimated > MAX_IMAGE:
        raise ValueError("Unsupported image or image exceeds 25 MB")
    return mime, encoded_start, estimated


def _lookup_validated_asset(data: str) -> tuple[str, int] | None:
    if not isinstance(data, str):
        return None
    key = id(data)
    with _VALIDATED_LOCK:
        entry = _VALIDATED_ASSETS.get(key)
        if entry is not None and entry[0] is data:
            _VALIDATED_ASSETS.move_to_end(key)
            return entry[1], entry[2]
    return None


def _validated_image_meta(data: str) -> tuple[str, int]:
    if not isinstance(data, str):
        raise ValueError("Expected a base64 image")
    cached = _lookup_validated_asset(data)
    if cached is not None:
        return cached
    mime, encoded_start, _ = _parse_image_header(data)
    decoded_len = _validate_base64_len(data, MAX_IMAGE, encoded_start)
    _cache_validated_asset(data, mime, decoded_len)
    return mime, decoded_len


def _is_cached_validated_asset(data: str) -> bool:
    return _lookup_validated_asset(data) is not None


def image_data(data: str) -> tuple[str, bytes]:
    mime, encoded_start, _ = _parse_image_header(data)
    result = decode_base64_chunked(data, start=encoded_start)
    if len(result) > MAX_IMAGE:
        raise ValueError("Image exceeds 25 MB")
    _cache_validated_asset(data, mime, len(result))
    return mime, result

def bundle(
    markdown: str,
    assets: dict[str, str],
    *,
    validated_assets: dict[str, str] | None = None,
) -> dict:
    value = {"format": "supermd-smd", "version": 1, "markdown": markdown, "assets": assets}
    validate_envelope(value)
    total = 0
    for name, data in assets.items():
        cached_meta = _lookup_validated_asset(data)
        if cached_meta is None and validated_assets is not None:
            prior = validated_assets.get(name)
            if prior is not None and prior == data:
                prior_meta = _lookup_validated_asset(prior)
                if prior_meta is not None:
                    _cache_validated_asset(data, prior_meta[0], prior_meta[1])
                    cached_meta = prior_meta
        if cached_meta is not None:
            _, size = cached_meta
        else:
            _, size = _validated_image_meta(data)
        total += size
        if total > MAX_TOTAL_IMAGES:
            raise ValueError("Assets exceed 75 MB")
    return value

def validate_envelope(value: dict) -> None:
    if (not isinstance(value, dict) or set(value) != {"format", "version", "markdown", "assets"}
            or value["format"] not in ("supermd-smd", "supermd-fmd")
            or isinstance(value["version"], bool) or value["version"] != 1):
        raise ValueError("Unsupported portable note format/version")
    if (not isinstance(value["markdown"], str) or len(value["markdown"].encode("utf-8")) > MAX_MARKDOWN
            or not isinstance(value["assets"], dict) or len(value["assets"]) > MAX_ASSETS):
        raise ValueError("Portable note is too large or malformed")
    total = 0
    for name, data in value["assets"].items():
        if not is_valid_asset_key(name):
            raise ValueError("Unsafe asset name")
        mime, _, estimated = _parse_image_header(data)
        if MIMES.get(name.rsplit(".", 1)[-1].lower()) != mime:
            raise ValueError("Image MIME does not match its extension")
        total += estimated
        if total > MAX_TOTAL_IMAGES:
            raise ValueError("Assets exceed 75 MB")


def validate(value: dict) -> None:
    validate_envelope(value)
    total = 0
    for data in value["assets"].values():
        _, decoded_len = _validated_image_meta(data)
        total += decoded_len
        if total > MAX_TOTAL_IMAGES:
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

def _write_gzip_json(target, value: dict, *, _trusted_ascii_assets: bool = False) -> None:
    """Write deterministic gzip with an empty filename and fixed timestamp."""
    compressor = zlib.compressobj(PORTABLE_COMPRESSLEVEL, zlib.DEFLATED, 16 + zlib.MAX_WBITS)
    header_buf = bytearray()
    header_written = False
    length = 0

    def emit(raw_chunk: bytes) -> None:
        nonlocal header_written
        if not raw_chunk:
            return
        if not header_written:
            header_buf.extend(raw_chunk)
            if len(header_buf) < 10:
                return
            header_written = True
            header_buf[4:8] = b"\x00\x00\x00\x00"
            header_buf[9] = 255
            target.write(bytes(header_buf))
            header_buf.clear()
            return
        target.write(raw_chunk)

    def write_bytes(data: bytes) -> None:
        nonlocal length
        length += len(data)
        if length > MAX_FILE:
            raise ValueError("SMD JSON exceeds 120 MB")
        emit(compressor.compress(data))

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
        ascii_chunk = 1_048_576
        for name, data in assets.items():
            if (type(name) is str and type(data) is str
                    and (_trusted_ascii_assets or (is_valid_asset_key(name) and _is_cached_validated_asset(data)))):
                write_bytes((b"" if first else b",") + b'"' + name.encode("ascii") + b'":"')
                end = len(data)
                if end <= ascii_chunk:
                    write_bytes(data.encode("ascii"))
                else:
                    for offset in range(0, end, ascii_chunk):
                        write_bytes(data[offset:offset + ascii_chunk].encode("ascii"))
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
        emit(compressor.flush())
        return

    class BoundedTextWriter:
        def write(self, text):
            write_bytes(text.encode("utf-8"))
            return len(text)
    json.dump(value, BoundedTextWriter(), ensure_ascii=False, separators=(",", ":"))
    emit(compressor.flush())

def compressed_bundle(
    markdown: str,
    assets: dict[str, str],
    *,
    validated_assets: dict[str, str] | None = None,
) -> bytes:
    value = bundle(markdown, assets, validated_assets=validated_assets)
    import io
    output = io.BytesIO()
    _write_gzip_json(output, value, _trusted_ascii_assets=True)
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
    delay = 0.005
    while True:
        try:
            os.replace(source, target)
            return
        except PermissionError as error:
            remaining = deadline - time.monotonic()
            if getattr(error, "winerror", None) not in (5, 32) or remaining <= 0:
                raise
            time.sleep(min(delay, remaining))
            delay = min(0.04, delay * 2)

def write_portable(
    path: Path,
    markdown: str,
    assets: dict[str, str],
    *,
    validated_assets: dict[str, str] | None = None,
) -> None:
    """Atomically save the unchanged v1 JSON envelope in deterministic gzip."""
    value = bundle(markdown, assets, validated_assets=validated_assets)
    hasher = hashlib.sha256()
    handle, temporary = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=path.parent)
    try:
        with os.fdopen(handle, "wb", buffering=_B64_DECODE_CHUNK) as raw:
            if os.name != "nt" and hasattr(os, "fchmod"):
                try:
                    st_mode = path.stat().st_mode
                except FileNotFoundError:
                    pass
                else:
                    os.fchmod(raw.fileno(), stat.S_IMODE(st_mode))

            class _HashingWriter:
                def write(self, data: bytes) -> int:
                    hasher.update(data)
                    return raw.write(data)

                def flush(self) -> None:
                    raw.flush()

            _write_gzip_json(_HashingWriter(), value, _trusted_ascii_assets=True)
            if raw.tell() > MAX_FILE:
                raise ValueError("Compressed SMD exceeds 120 MB")
            raw.flush()
            os.fsync(raw.fileno())
        _replace_with_windows_sharing_retry(temporary, path)
        try:
            st = path.stat()
            _cache_portable_file(
                (st.st_dev, st.st_ino, st.st_size, st.st_mtime_ns),
                hasher.hexdigest(),
                markdown,
                assets,
                assets_decoded=True,
            )
        except OSError:
            pass
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def open_note(path: Path, *, decode_assets: bool = True) -> tuple[str, dict[str, str], bool]:
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
            expected_sha, markdown, assets, cached_decoded = cached
            if decode_assets and (not cached_decoded or not all(_is_cached_validated_asset(v) for v in assets.values())):
                validate({"format": "supermd-smd", "version": 1, "markdown": markdown, "assets": assets})
                _cache_portable_file(stat_key, expected_sha, markdown, assets, assets_decoded=True)
            return markdown, assets, True
        hasher = hashlib.sha256()
        try:
            value = json.loads(_gzip_json_input(path, hasher=hasher))
        except (json.JSONDecodeError, UnicodeDecodeError, zlib.error, OSError, EOFError) as error:
            raise ValueError("This compressed portable note is damaged") from error
        if decode_assets:
            validate(value)
        else:
            validate_envelope(value)
        try:
            after = path.stat()
            if (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns) == stat_key:
                _cache_portable_file(
                    stat_key, hasher.hexdigest(), value["markdown"], value["assets"], assets_decoded=decode_assets
                )
        except OSError:
            pass
        return value["markdown"], value["assets"], True
    return _decode_text_note(path.read_text(encoding="utf-8-sig"), path, decode_assets=decode_assets)

def decode_note_bytes(raw: bytes, path: Path, *, decode_assets: bool = True) -> tuple[str, dict[str, str], bool]:
    """Decode the exact snapshot used for an agent's revision, without rereading."""
    if len(raw) > MAX_FILE:
        raise ValueError("Note exceeds 120 MB")
    if raw.startswith(GZIP_MAGIC):
        try:
            value = json.loads(_gzip_json_input(path, raw))
        except (json.JSONDecodeError, UnicodeDecodeError, zlib.error, OSError, EOFError) as error:
            raise ValueError("This compressed portable note is damaged") from error
        if decode_assets:
            validate(value)
        else:
            validate_envelope(value)
        return value["markdown"], value["assets"], True
    return _decode_text_note(raw.decode("utf-8-sig"), path, decode_assets=decode_assets)

def _decode_text_note(raw: str, path: Path, *, decode_assets: bool = True) -> tuple[str, dict[str, str], bool]:
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
                if decode_assets:
                    validate(value)
                else:
                    validate_envelope(value)
                return value["markdown"], value["assets"], True
    return raw, {}, False


MAX_SEARCH_MARKDOWN_BYTES = 20_000_000
_PORTABLE_FORMATS = ("supermd-smd", "supermd-fmd")
_PORTABLE_ENVELOPE_RE = re.compile(r'^\ufeff?\s*\{\s*"format"\s*:\s*"supermd-(?:smd|fmd)"')


def _read_bounded_utf8_stream(path: Path, *, is_gzip: bool):
    import codecs
    utf8 = codecs.getincrementaldecoder("utf-8")(errors="strict")
    if not is_gzip:
        total = 0
        with path.open("rb") as source:
            while chunk := source.read(65536):
                total += len(chunk)
                if total > MAX_FILE:
                    raise ValueError("Portable note exceeds size limit")
                yield utf8.decode(chunk, final=False)
            tail = utf8.decode(b"", final=True)
            if tail:
                yield tail
        return
    decoder = zlib.decompressobj(16 + zlib.MAX_WBITS)
    compressed_total = inflated_total = 0
    with path.open("rb") as source:
        while chunk := source.read(32768):
            compressed_total += len(chunk)
            if compressed_total > MAX_FILE:
                raise ValueError("Compressed portable note exceeds size limit")
            pending = chunk
            while pending:
                decoded = decoder.decompress(pending, min(65536, MAX_FILE - inflated_total + 1))
                inflated_total += len(decoded)
                if inflated_total > MAX_FILE or decoder.unused_data or (decoder.unconsumed_tail and not decoded):
                    raise ValueError("Invalid or oversized compressed portable stream")
                if decoded:
                    yield utf8.decode(decoded, final=False)
                pending = decoder.unconsumed_tail
        tail_bytes = decoder.flush(65536)
        inflated_total += len(tail_bytes)
        if inflated_total > MAX_FILE:
            raise ValueError("Inflated portable note exceeds size limit")
        tail_text = utf8.decode(tail_bytes, final=True)
        if tail_text:
            yield tail_text


def _extract_portable_markdown(chunks, max_markdown_bytes: int = MAX_SEARCH_MARKDOWN_BYTES) -> str | None:
    """Extract `markdown` from a v1 portable JSON envelope and stop before `assets` payloads."""
    decoder = json.JSONDecoder()
    iterator = iter(chunks)
    buf = ""
    idx = 0

    def pull(min_extra: int = 1) -> bool:
        nonlocal buf, idx
        if idx > 65536:
            buf = buf[idx:]
            idx = 0
        added = 0
        pieces: list[str] = []
        for piece in iterator:
            if piece:
                pieces.append(piece)
                added += len(piece)
                if added >= min_extra:
                    break
        if not pieces:
            return False
        buf += "".join(pieces)
        return True

    def decode_next():
        nonlocal idx
        while True:
            while idx < len(buf) and buf[idx] in " \t\r\n":
                idx += 1
            if idx >= len(buf) and not pull():
                raise ValueError("Unexpected EOF in portable JSON")
            try:
                val, idx = decoder.raw_decode(buf, idx)
                return val
            except json.JSONDecodeError:
                if not pull(max(65536, len(buf) - idx)):
                    raise

    if not pull():
        return None
    while idx < len(buf) and buf[idx] in "\ufeff \t\r\n":
        idx += 1
    if idx >= len(buf) or buf[idx] != "{":
        return None
    idx += 1
    fmt = version = markdown = None
    while True:
        while idx < len(buf) and buf[idx] in " \t\r\n":
            idx += 1
        if idx >= len(buf) and not pull():
            return None
        if buf[idx] == "}":
            break
        key = decode_next()
        if not isinstance(key, str):
            return None
        while idx < len(buf) and buf[idx] in " \t\r\n":
            idx += 1
        if (idx >= len(buf) and not pull()) or buf[idx] != ":":
            return None
        idx += 1
        val = decode_next()
        if key == "format":
            if val not in _PORTABLE_FORMATS:
                return None
            fmt = val
        elif key == "version":
            if isinstance(val, bool) or val != 1:
                return None
            version = val
        elif key == "markdown":
            if not isinstance(val, str) or len(val.encode("utf-8")) > max_markdown_bytes:
                return None
            markdown = val
        if fmt in _PORTABLE_FORMATS and version == 1 and isinstance(markdown, str):
            return markdown
        while idx < len(buf) and buf[idx] in " \t\r\n":
            idx += 1
        if idx >= len(buf) and not pull():
            return None
        sep = buf[idx]
        idx += 1
        if sep == "}":
            break
        if sep != ",":
            return None
    return markdown if fmt in _PORTABLE_FORMATS and version == 1 and isinstance(markdown, str) else None


def read_searchable_markdown(path: str | os.PathLike[str], max_text_bytes: int = MAX_SEARCH_MARKDOWN_BYTES) -> str | None:
    """Read searchable Markdown from plain or portable (.smd/.fmd) notes by content without decoding images."""
    raw_path = os.fspath(path)
    try:
        info = os.lstat(raw_path)
        if stat.S_ISLNK(info.st_mode) or not stat.S_ISREG(info.st_mode) or info.st_size > MAX_FILE:
            return None
        stat_key = (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns)
        if _RECENT_PORTABLE_FILES:
            with _VALIDATED_LOCK:
                cached = _RECENT_PORTABLE_FILES.get(stat_key)
            if cached is not None and len(cached[1].encode("utf-8")) <= max_text_bytes:
                return cached[1]
        with open(raw_path, "rb") as handle:
            head = handle.read(8192)
            if not head:
                return ""
            if not head.startswith(GZIP_MAGIC):
                if b"\x00" in head:
                    return None
                leading = head.lstrip(b"\xef\xbb\xbf \t\r\n")
                if leading and not leading.startswith(b"{"):
                    if info.st_size > max_text_bytes:
                        return None
                    raw = head if info.st_size <= len(head) else head + handle.read(max_text_bytes + 1 - len(head))
                    if len(raw) > max_text_bytes or (len(raw) > len(head) and b"\x00" in raw[len(head):]):
                        return None
                    text = raw.decode("utf-8-sig", errors="replace")
                    return text.replace("\r\n", "\n").replace("\r", "\n") if "\r" in text else text
    except OSError:
        return None
    path_obj = path if isinstance(path, Path) else Path(raw_path)
    if head.startswith(GZIP_MAGIC):
        try:
            return _extract_portable_markdown(_read_bounded_utf8_stream(path_obj, is_gzip=True), max_text_bytes)
        except (ValueError, json.JSONDecodeError, UnicodeDecodeError, zlib.error, OSError, EOFError):
            return None
    head_text = head.decode("utf-8-sig", errors="replace")
    if head_text.lstrip().startswith("{"):
        try:
            extracted = _extract_portable_markdown(_read_bounded_utf8_stream(path_obj, is_gzip=False), max_text_bytes)
        except (ValueError, json.JSONDecodeError, UnicodeDecodeError, OSError):
            if _PORTABLE_ENVELOPE_RE.match(head_text):
                return None
        else:
            if extracted is not None:
                return extracted
            if _PORTABLE_ENVELOPE_RE.match(head_text):
                return None
    if info.st_size > max_text_bytes:
        return None
    try:
        with open(raw_path, encoding="utf-8-sig", errors="replace") as text_handle:
            return text_handle.read()
    except OSError:
        return None

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

def _write_json_str(raw, text: str) -> None:
    if type(text) is str and _is_cached_validated_asset(text):
        raw.write(b'"')
        for offset in range(0, len(text), _B64_DECODE_CHUNK):
            raw.write(text[offset:offset + _B64_DECODE_CHUNK].encode("ascii"))
        raw.write(b'"')
        return
    if len(text) <= _B64_DECODE_CHUNK:
        raw.write(json.dumps(text, ensure_ascii=False).encode("utf-8", errors="backslashreplace"))
        return
    plain = text if type(text) is str else str(text)
    raw.write(b'"')
    for offset in range(0, len(plain), _B64_DECODE_CHUNK):
        chunk = json.dumps(plain[offset:offset + _B64_DECODE_CHUNK], ensure_ascii=False)[1:-1]
        raw.write(chunk.encode("utf-8", errors="backslashreplace"))
    raw.write(b'"')


def _write_json_value(raw, value, seen: set[int]) -> None:
    if isinstance(value, str):
        _write_json_str(raw, value)
    elif value is None:
        raw.write(b"null")
    elif value is True:
        raw.write(b"true")
    elif value is False:
        raw.write(b"false")
    elif isinstance(value, (int, float)):
        raw.write(json.dumps(value).encode("ascii"))
    elif isinstance(value, (list, tuple)):
        marker = id(value)
        if marker in seen:
            raise ValueError("Circular reference detected")
        seen.add(marker)
        try:
            raw.write(b"[")
            for idx, item in enumerate(value):
                if idx:
                    raw.write(b", ")
                _write_json_value(raw, item, seen)
            raw.write(b"]")
        finally:
            seen.remove(marker)
    elif isinstance(value, dict):
        marker = id(value)
        if marker in seen:
            raise ValueError("Circular reference detected")
        seen.add(marker)
        try:
            raw.write(b"{")
            first = True
            for key, item in value.items():
                if not first:
                    raw.write(b", ")
                first = False
                if isinstance(key, str):
                    _write_json_str(raw, key)
                elif key is None:
                    raw.write(b'"null"')
                elif key is True:
                    raw.write(b'"true"')
                elif key is False:
                    raw.write(b'"false"')
                elif isinstance(key, (int, float)):
                    raw.write(b'"' + json.dumps(key).encode("ascii") + b'"')
                else:
                    raise TypeError(f"keys must be str, int, float, bool or None, not {type(key).__name__}")
                raw.write(b": ")
                _write_json_value(raw, item, seen)
            raw.write(b"}")
        finally:
            seen.remove(marker)
    else:
        raise TypeError(f"Object of type {type(value).__name__} is not JSON serializable")


_ATOMIC_JSON_STAGE_TLS = threading.local()


class _StagedAtomicJsonScope:
    """Defer the final atomic rename of ``target_path`` until the caller commits."""

    def __init__(self, target_path: Path, abort_check=None):
        self.target = Path(target_path).resolve()
        self.abort_check = abort_check
        self.intercepted = False
        self.temporary: str | None = None
        self._previous = None

    def __enter__(self):
        self._previous = getattr(_ATOMIC_JSON_STAGE_TLS, "active", None)
        _ATOMIC_JSON_STAGE_TLS.active = self
        return self

    def __exit__(self, exc_type, exc, tb):
        _ATOMIC_JSON_STAGE_TLS.active = self._previous
        if exc_type is not None:
            self.discard()
        return False

    def publish(self, destination: Path | None = None) -> None:
        temp = self.temporary
        if temp is None:
            return
        self.temporary = None
        try:
            _replace_with_windows_sharing_retry(temp, destination or self.target)
        finally:
            if os.path.exists(temp):
                os.unlink(temp)

    def discard(self) -> None:
        temp = self.temporary
        self.temporary = None
        if temp is not None and os.path.exists(temp):
            try:
                os.unlink(temp)
            except OSError:
                pass


def stage_atomic_json(target_path: Path, *, abort_check=None) -> _StagedAtomicJsonScope:
    return _StagedAtomicJsonScope(target_path, abort_check=abort_check)


def atomic_json(path: Path, value) -> None:
    """Write ordered recovery without full-workspace JSON + UTF-8 copies or long GIL holds."""
    path_obj = Path(path)
    stage_scope = getattr(_ATOMIC_JSON_STAGE_TLS, "active", None)
    capture_stage = (
        stage_scope is not None
        and not stage_scope.intercepted
        and path_obj.resolve() == stage_scope.target
    )
    if capture_stage:
        stage_scope.intercepted = True
        if callable(stage_scope.abort_check) and stage_scope.abort_check():
            return
    handle, temporary = tempfile.mkstemp(prefix=f".{path_obj.name}.", suffix=".tmp", dir=path_obj.parent)
    handed_off = False
    try:
        with os.fdopen(handle, "wb", buffering=_B64_DECODE_CHUNK) as file:
            if path_obj.exists() and hasattr(os, "fchmod"):
                os.fchmod(file.fileno(), stat.S_IMODE(path_obj.stat().st_mode))
            _write_json_value(file, value, set())
            file.flush()
            os.fsync(file.fileno())
        if capture_stage:
            stage_scope.temporary = temporary
            handed_off = True
            return
        _replace_with_windows_sharing_retry(temporary, path_obj)
    finally:
        if not handed_off and os.path.exists(temporary):
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
