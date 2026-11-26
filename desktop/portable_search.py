"""Bounded portable (.smd/.fmd) Markdown search scanner and single-member gzip streaming."""
from __future__ import annotations

import codecs
import json
import os
import re
import stat
import zlib
from pathlib import Path
from typing import Callable, Iterator

GZIP_MAGIC = b"\x1f\x8b"
MAX_SEARCH_MARKDOWN_BYTES = 20_000_000
_PORTABLE_FORMATS = ("supermd-smd", "supermd-fmd")
_PORTABLE_ENVELOPE_RE = re.compile(r'^\ufeff?\s*\{\s*"format"\s*:\s*"supermd-(?:smd|fmd)"')


def iter_single_member_gzip_chunks(
    source,
    *,
    max_bytes: int,
    read_chunk_size: int = 65536,
    max_decompress_chunk: int = 0,
    hasher=None,
    label: str = "portable note",
) -> Iterator[bytes]:
    """Inflate one gzip member in bounded chunks, rejecting truncation, oversize payloads, and trailing data."""
    decoder = zlib.decompressobj(16 + zlib.MAX_WBITS)
    compressed_total = 0
    inflated_total = 0
    queued_chunk: bytes | None = None
    at_eof = False
    while not at_eof:
        if queued_chunk is not None:
            chunk = queued_chunk
            queued_chunk = None
        else:
            chunk = source.read(read_chunk_size)
        if not chunk:
            break
        compressed_total += len(chunk)
        if compressed_total > max_bytes:
            raise ValueError(f"Compressed {label} exceeds size limit")
        if hasher is not None:
            hasher.update(chunk)
        pending = chunk
        while pending:
            remaining = max_bytes - inflated_total
            bound = max(1, remaining + 1)
            limit = min(max_decompress_chunk, bound) if max_decompress_chunk > 0 else bound
            decoded = decoder.decompress(pending, limit)
            inflated_total += len(decoded)
            if inflated_total > max_bytes:
                raise ValueError(f"Inflated {label} exceeds size limit")
            if decoder.unused_data:
                raise ValueError(f"{label} gzip stream contains trailing or concatenated data")
            pending = decoder.unconsumed_tail
            if pending and not decoded:
                raise ValueError(f"Inflated {label} exceeds size limit")
            if not pending:
                if decoder.eof:
                    extra = source.read(read_chunk_size)
                    if extra:
                        compressed_total += len(extra)
                        if compressed_total > max_bytes:
                            raise ValueError(f"Compressed {label} exceeds size limit")
                        raise ValueError(f"{label} gzip stream contains trailing or concatenated data")
                    at_eof = True
                elif len(chunk) < read_chunk_size:
                    next_chunk = source.read(read_chunk_size)
                    if not next_chunk:
                        raise ValueError(f"{label} gzip stream is truncated")
                    queued_chunk = next_chunk
            if decoded:
                yield decoded
    if not decoder.eof:
        raise ValueError(f"{label} gzip stream is truncated")
    flush_bound = max(1, max_bytes - inflated_total + 1)
    flush_limit = min(max_decompress_chunk, flush_bound) if max_decompress_chunk > 0 else flush_bound
    tail = decoder.flush(flush_limit)
    inflated_total += len(tail)
    if inflated_total > max_bytes:
        raise ValueError(f"Inflated {label} exceeds size limit")
    if decoder.unused_data or decoder.unconsumed_tail:
        raise ValueError(f"{label} gzip stream contains trailing or concatenated data")
    if tail:
        yield tail


def _read_bounded_utf8_stream(path: Path, *, is_gzip: bool, max_file_bytes: int) -> Iterator[str]:
    utf8 = codecs.getincrementaldecoder("utf-8")(errors="strict")
    with path.open("rb") as source:
        if not is_gzip:
            total = 0
            while chunk := source.read(65536):
                total += len(chunk)
                if total > max_file_bytes:
                    raise ValueError("Portable note exceeds size limit")
                yield utf8.decode(chunk, final=False)
        else:
            for decoded in iter_single_member_gzip_chunks(
                source,
                max_bytes=max_file_bytes,
                read_chunk_size=32768,
                max_decompress_chunk=65536,
                label="portable note",
            ):
                yield utf8.decode(decoded, final=False)
        tail = utf8.decode(b"", final=True)
        if tail:
            yield tail


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


def read_searchable_markdown(
    path: str | os.PathLike[str],
    max_text_bytes: int = MAX_SEARCH_MARKDOWN_BYTES,
    *,
    max_file_bytes: int,
    cache_lookup: Callable[[tuple[int, int, int, int]], str | None] | None = None,
) -> str | None:
    """Read searchable Markdown from plain or portable (.smd/.fmd) notes by content without decoding images."""
    raw_path = os.fspath(path)
    try:
        info = os.lstat(raw_path)
        if stat.S_ISLNK(info.st_mode) or not stat.S_ISREG(info.st_mode) or info.st_size > max_file_bytes:
            return None
        if cache_lookup is not None:
            stat_key = (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns)
            cached = cache_lookup(stat_key)
            if cached is not None and len(cached.encode("utf-8")) <= max_text_bytes:
                return cached
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
            return _extract_portable_markdown(
                _read_bounded_utf8_stream(path_obj, is_gzip=True, max_file_bytes=max_file_bytes),
                max_text_bytes,
            )
        except (ValueError, json.JSONDecodeError, UnicodeDecodeError, zlib.error, OSError, EOFError):
            return None
    head_text = head.decode("utf-8-sig", errors="replace")
    if head_text.lstrip().startswith("{"):
        try:
            extracted = _extract_portable_markdown(
                _read_bounded_utf8_stream(path_obj, is_gzip=False, max_file_bytes=max_file_bytes),
                max_text_bytes,
            )
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
