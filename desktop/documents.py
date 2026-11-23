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
        _replace_with_windows_sharing_retry(temporary, path)
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


MAX_SEARCH_MARKDOWN_BYTES = 20_000_000
_PORTABLE_FORMATS = ("supermd-smd", "supermd-fmd")
_PORTABLE_ENVELOPE_RE = re.compile(r'^\ufeff?\s*\{\s*"format"\s*:\s*"supermd-(?:smd|fmd)"')


def is_portable_gzip(head: bytes) -> bool:
    return head.startswith(GZIP_MAGIC)


def is_portable_envelope(text_head: str) -> bool:
    return bool(_PORTABLE_ENVELOPE_RE.match(text_head))


def _extract_portable_markdown_from_chunks(chunks, max_markdown_bytes: int = MAX_SEARCH_MARKDOWN_BYTES) -> str | None:
    """Stream-parse a v1 portable JSON envelope and return its markdown without decoding assets."""
    decoder = json.JSONDecoder()
    iterator = iter(chunks)
    buf = ""
    idx = 0

    def compact() -> None:
        nonlocal buf, idx
        if idx > 65536:
            buf = buf[idx:]
            idx = 0

    def pull() -> bool:
        nonlocal buf
        for piece in iterator:
            if piece:
                buf += piece
                return True
        return False

    def skip_ws() -> bool:
        nonlocal idx
        while True:
            while idx < len(buf) and buf[idx] in " \t\r\n":
                idx += 1
            compact()
            if idx < len(buf):
                return True
            if not pull():
                return False

    def find_string_end(start_quote: int, max_chars: int | None = None) -> int:
        pos = start_quote + 1
        while True:
            while pos < len(buf):
                if max_chars is not None and pos - start_quote > max_chars:
                    raise ValueError("Portable string exceeds maximum searchable size")
                ch = buf[pos]
                if ch == "\\":
                    if pos + 1 >= len(buf):
                        if not pull():
                            raise ValueError("Unterminated escape in portable JSON")
                    pos += 2
                    continue
                if ch == '"':
                    return pos
                pos += 1
            if not pull():
                raise ValueError("Unterminated string in portable JSON")

    def read_string(max_chars: int | None = None) -> str:
        nonlocal idx
        if not skip_ws() or buf[idx] != '"':
            raise ValueError("Expected JSON string")
        find_string_end(idx, max_chars=max_chars)
        value, end = decoder.raw_decode(buf, idx)
        idx = end
        compact()
        return value

    def read_primitive():
        nonlocal idx
        if not skip_ws():
            raise ValueError("Unexpected EOF in JSON value")
        if buf[idx] == '"':
            return read_string()
        pos = idx
        while True:
            while pos < len(buf) and buf[pos] not in " \t\r\n,}]":
                pos += 1
            if pos < len(buf) or not pull():
                break
        value, end = decoder.raw_decode(buf, idx)
        idx = end
        compact()
        return value

    def skip_value() -> None:
        nonlocal buf, idx
        if not skip_ws():
            raise ValueError("Unexpected EOF while skipping JSON value")
        ch = buf[idx]
        if ch == '"':
            idx += 1
            esc = False
            while True:
                while idx < len(buf):
                    c = buf[idx]
                    idx += 1
                    if esc:
                        esc = False
                    elif c == "\\":
                        esc = True
                    elif c == '"':
                        compact()
                        return
                compact()
                if not pull():
                    raise ValueError("Unterminated string while skipping JSON value")
        if ch in "{[":
            depth = 0
            in_str = False
            esc = False
            while True:
                while idx < len(buf):
                    c = buf[idx]
                    idx += 1
                    if in_str:
                        if esc:
                            esc = False
                        elif c == "\\":
                            esc = True
                        elif c == '"':
                            in_str = False
                    else:
                        if c == '"':
                            in_str = True
                        elif c in "{[":
                            depth += 1
                        elif c in "}]":
                            depth -= 1
                            if depth == 0:
                                compact()
                                return
                compact()
                if not pull():
                    raise ValueError("Unterminated container while skipping JSON value")
        while True:
            while idx < len(buf) and buf[idx] not in " \t\r\n,}]":
                idx += 1
            compact()
            if idx < len(buf) or not pull():
                return

    if not skip_ws():
        return None
    if buf[idx] == "\ufeff":
        idx += 1
        if not skip_ws():
            return None
    if buf[idx] != "{":
        return None
    idx += 1

    fmt = None
    version = None
    markdown = None

    if not skip_ws():
        return None
    if buf[idx] == "}":
        return None

    while True:
        key = read_string(max_chars=256)
        if not skip_ws() or buf[idx] != ":":
            raise ValueError("Expected ':' in portable JSON object")
        idx += 1
        if key == "format":
            fmt = read_primitive()
            if fmt not in _PORTABLE_FORMATS:
                return None
        elif key == "version":
            version = read_primitive()
            if version is True or version != 1:
                return None
        elif key == "markdown":
            if not skip_ws() or buf[idx] != '"':
                return None
            markdown = read_string(max_chars=max_markdown_bytes * 2 + 64)
            if len(markdown.encode("utf-8")) > max_markdown_bytes:
                return None
        else:
            skip_value()

        if fmt in _PORTABLE_FORMATS and version == 1 and isinstance(markdown, str):
            return markdown

        if not skip_ws():
            return None
        sep = buf[idx]
        idx += 1
        compact()
        if sep == "}":
            break
        if sep != ",":
            raise ValueError("Expected ',' or '}' in portable JSON object")

    if fmt in _PORTABLE_FORMATS and version == 1 and isinstance(markdown, str):
        return markdown
    return None


def _iter_gzip_utf8_chunks(path: Path, max_compressed: int = MAX_FILE, max_inflated: int = MAX_FILE):
    import codecs
    decoder = zlib.decompressobj(16 + zlib.MAX_WBITS)
    utf8 = codecs.getincrementaldecoder("utf-8")(errors="strict")
    compressed_total = 0
    inflated_total = 0
    with path.open("rb") as source:
        while chunk := source.read(32 * 1024):
            compressed_total += len(chunk)
            if compressed_total > max_compressed:
                raise ValueError("Compressed portable note exceeds size limit")
            pending = chunk
            while pending:
                remaining = max_inflated - inflated_total
                if remaining <= 0:
                    raise ValueError("Inflated portable note exceeds size limit")
                decoded = decoder.decompress(pending, min(64 * 1024, remaining + 1))
                inflated_total += len(decoded)
                if inflated_total > max_inflated:
                    raise ValueError("Inflated portable note exceeds size limit")
                if decoded:
                    yield utf8.decode(decoded, final=False)
                if decoder.unused_data:
                    raise ValueError("Concatenated or trailing gzip stream")
                pending = decoder.unconsumed_tail
                if pending and not decoded:
                    raise ValueError("Inflated portable note exceeds size limit")
        tail = decoder.flush(64 * 1024)
        if tail:
            inflated_total += len(tail)
            if inflated_total > max_inflated:
                raise ValueError("Inflated portable note exceeds size limit")
            yield utf8.decode(tail, final=True)
        else:
            final_text = utf8.decode(b"", final=True)
            if final_text:
                yield final_text


def _iter_file_utf8_chunks(path: Path, max_bytes: int = MAX_FILE):
    import codecs
    utf8 = codecs.getincrementaldecoder("utf-8")(errors="strict")
    total = 0
    with path.open("rb") as source:
        while chunk := source.read(64 * 1024):
            total += len(chunk)
            if total > max_bytes:
                raise ValueError("Portable note exceeds size limit")
            yield utf8.decode(chunk, final=False)
        final_text = utf8.decode(b"", final=True)
        if final_text:
            yield final_text


def read_searchable_markdown(path: Path, max_text_bytes: int = MAX_SEARCH_MARKDOWN_BYTES) -> str | None:
    """Read searchable Markdown from plain or portable (.smd/.fmd) notes by content without decoding images."""
    try:
        if path.is_symlink():
            return None
        info = path.stat()
        if not stat.S_ISREG(info.st_mode) or info.st_size > MAX_FILE:
            return None
        with path.open("rb") as handle:
            head = handle.read(8192)
    except OSError:
        return None

    if not head:
        return ""

    if is_portable_gzip(head):
        try:
            return _extract_portable_markdown_from_chunks(_iter_gzip_utf8_chunks(path), max_markdown_bytes=max_text_bytes)
        except (ValueError, json.JSONDecodeError, UnicodeDecodeError, zlib.error, OSError, EOFError):
            return None

    if b"\x00" in head:
        return None

    head_text = head.decode("utf-8-sig", errors="replace")
    if head_text.lstrip().startswith("{"):
        try:
            extracted = _extract_portable_markdown_from_chunks(_iter_file_utf8_chunks(path), max_markdown_bytes=max_text_bytes)
        except (ValueError, json.JSONDecodeError, UnicodeDecodeError, OSError):
            if re.search(r'"format"\s*:\s*"supermd-(?:smd|fmd)"', head_text):
                return None
        else:
            if extracted is not None:
                return extracted
            if is_portable_envelope(head_text):
                return None

    if info.st_size > max_text_bytes:
        return None
    try:
        return path.read_text(encoding="utf-8-sig", errors="replace")
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
