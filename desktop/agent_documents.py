"""Safe, bounded document operations shared by the Super MD agent CLI and MCP.

This module deliberately depends only on the Python standard library and the
Qt-free :mod:`documents` format helpers.
"""
from __future__ import annotations

import base64
import hashlib
import json
import mimetypes
import os
import re
import stat
import sys
import tempfile
import threading
import unicodedata
from collections import OrderedDict
from contextlib import contextmanager
from dataclasses import dataclass, field
from pathlib import Path
from typing import Iterator

try:  # package import and direct-script import are both supported
    from . import documents, frontmatter
except ImportError:
    import documents
    import frontmatter

MAX_PAGE_CHARS = 12_000
MAX_SEARCH_RESULTS = 25
MAX_OUTLINE_PAGE = 80
MAX_QUERY_CHARS = 500
MAX_ASSET_BYTES = documents.MAX_IMAGE
MAX_ENVELOPE_CACHE_BYTES = 128 * 1024 * 1024
_HEADING = re.compile(r"^(#{1,6})[ \t]+(.+?)[ \t]*#*[ \t]*$")
_FENCE = re.compile(r"^\s{0,3}(`{3,}|~{3,})")
_LOCK_GUARD = threading.Lock()


@dataclass
class _CachedEnvelope:
    stat_key: tuple[int, int, int, int] | None
    path_str: str
    text: str
    assets: dict[str, str]
    portable: bool
    revision: str
    raw_size: int
    envelope_bytes: int = 0
    decoded_bytes: int = 0
    decoded_assets: OrderedDict[str, tuple[str, bytes, str]] = field(default_factory=OrderedDict)

    def __post_init__(self) -> None:
        if self.envelope_bytes <= 0:
            self.envelope_bytes = (
                sys.getsizeof(self.text)
                + sys.getsizeof(self.revision)
                + sum(sys.getsizeof(name) + sys.getsizeof(data) for name, data in self.assets.items())
            )

    @property
    def total_bytes(self) -> int:
        return self.envelope_bytes + self.decoded_bytes


class AgentDocumentError(ValueError):
    """An expected, safe-to-report error from the document interface."""


class RevisionConflict(AgentDocumentError):
    """The document changed after the caller inspected its revision."""


def digest_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def validate_patch_operations(operations: list[dict]) -> None:
    """Validate the transport-independent patch envelope before either backend applies it."""
    if not isinstance(operations, list) or not 1 <= len(operations) <= 100:
        raise AgentDocumentError("Provide 1–100 patch operations")
    try:
        if len(json.dumps(operations, ensure_ascii=False, separators=(",", ":")).encode("utf-8")) > 64_000:
            raise AgentDocumentError("Patch operations exceed 64 KB")
    except (TypeError, UnicodeError) as exc:
        raise AgentDocumentError("Patch operations must contain valid JSON text") from exc
    for index, operation in enumerate(operations):
        fail = lambda message: AgentDocumentError(f"operations[{index}]: {message}")
        if not isinstance(operation, dict):
            raise fail("Each patch operation must be an object")
        kind = operation.get("type")
        allowed = ({"type", "old", "new", "count", "expectedCount"} if kind == "replace" else
                   {"type", "start_line", "end_line", "text"} if kind == "lines" else
                   {"type", "line", "text"} if kind == "insert" else {"type"})
        unknown = next((key for key in operation if key not in allowed), None)
        if unknown is not None:
            expected = ", ".join(sorted(allowed))
            raise fail(f"Unknown field '{unknown}'; expected {expected}")
        if kind == "replace":
            old, new = operation.get("old"), operation.get("new")
            if not isinstance(old, str) or not old:
                raise fail("replace.old must be non-empty text")
            if not isinstance(new, str):
                raise fail("replace.new must be text")
            expected_count = operation.get("expectedCount")
            if "expectedCount" in operation and (not isinstance(expected_count, int) or isinstance(expected_count, bool) or expected_count < 1):
                raise fail("replace.expectedCount must be a positive integer")
            count = operation.get("count", "all" if isinstance(expected_count, int) and not isinstance(expected_count, bool) and expected_count > 1 else 1)
            if not ((isinstance(count, int) and not isinstance(count, bool) and count == 1) or count == "all"):
                raise fail("replace.count must be 1 or 'all'")
        elif kind == "lines":
            start, end, replacement = operation.get("start_line"), operation.get("end_line"), operation.get("text")
            if (not isinstance(start, int) or isinstance(start, bool) or
                    not isinstance(end, int) or isinstance(end, bool) or start < 1 or end < start):
                raise fail("Line range must be 1-based, inclusive, with end_line >= start_line")
            if not isinstance(replacement, str):
                raise fail("lines.text must be text")
        elif kind == "insert":
            line, replacement = operation.get("line"), operation.get("text")
            if not isinstance(line, int) or isinstance(line, bool) or line < 1:
                raise fail("insert.line must be a positive 1-based line number")
            if not isinstance(replacement, str):
                raise fail("insert.text must be text")
        else:
            raise fail("Patch type must be 'replace', 'lines' or 'insert'")


def apply_patch_operations_detailed(source: str, operations: list[dict]) -> tuple[str, list[dict]]:
    """Apply a validated batch sequentially and report Unicode code-point ranges."""
    validate_patch_operations(operations)
    edited = source
    summaries = []
    for index, operation in enumerate(operations):
        previous = edited
        kind = operation["type"]
        if kind == "replace":
            old, replacement = operation["old"], operation["new"]
            expected_count = operation.get("expectedCount")
            count = operation.get("count", "all" if isinstance(expected_count, int) and expected_count > 1 else 1)
            occurrences = edited.count(old)
            if occurrences < 1 or (count == 1 and occurrences != 1) or (expected_count is not None and occurrences != expected_count):
                expected = expected_count if expected_count is not None else ("one" if count == 1 else "at least one")
                raise AgentDocumentError(f"operations[{index}]: Exact replacement expected {expected} match; found {occurrences}")
            start_index = edited.index(old)
            last_index = edited.rfind(old) if count == "all" else start_index
            start_offset, end_offset = start_index, last_index + len(old)
            edited = edited.replace(old, replacement, 1 if count == 1 else -1)
        else:
            parts = edited.splitlines(keepends=True)
            if not parts and edited == "":
                parts = []
            if kind == "insert":
                start = operation["line"]
                if start > len(parts) + 1:
                    raise AgentDocumentError(f"operations[{index}]: insert.line must be between 1 and {len(parts) + 1}")
                end = start
                replacement = operation["text"]
                if start == len(parts) + 1 and parts and not re.search(r"[\r\n\v\f\x85\u2028\u2029]$", parts[-1]):
                    delimiter = re.search(r"\r\n|[\r\n\v\f\x85\u2028\u2029]", edited)
                    replacement = (delimiter.group(0) if delimiter else "\n") + replacement
                start_offset = sum(map(len, parts[:start - 1]))
                end_offset = start_offset
                edited = "".join(parts[:start - 1]) + replacement + "".join(parts[start - 1:])
            else:
                start, end, replacement = operation["start_line"], operation["end_line"], operation["text"]
                if start > len(parts) + 1 or end > len(parts) + 1:
                    raise AgentDocumentError(f"operations[{index}]: Line range must be 1-based, inclusive, with end_line <= line_count + 1")
                start_offset = sum(map(len, parts[:start - 1]))
                end_offset = sum(map(len, parts[:min(end, len(parts))]))
                replacement_parts = replacement.splitlines(keepends=True)
                if replacement and not replacement.endswith(("\n", "\r")) and end <= len(parts):
                    target = parts[start - 1:min(end, len(parts))]
                    if target and target[-1].endswith("\n"):
                        replacement_parts[-1] += "\n"
                edited = "".join(parts[:start - 1] + replacement_parts + parts[min(end, len(parts)):])
        if len(edited.encode("utf-8")) > 20_000_000:
            raise AgentDocumentError(f"operations[{index}]: Edited Markdown exceeds the 20 MB limit")
        summaries.append({"operationIndex": index, "type": kind, "startOffset": start_offset,
                          "endOffset": end_offset, "deltaChars": len(edited) - len(previous)})
    return edited, summaries


def _symlink_component(path: Path) -> Path | None:
    """Find a symlink in an absolute path without resolving through it."""
    absolute = Path(os.path.abspath(path))
    current = Path(absolute.anchor)
    for component in absolute.parts[1:]:
        current /= component
        try:
            if stat.S_ISLNK(current.lstat().st_mode):
                return current
        except FileNotFoundError:
            break
    return None


class DocumentStore:
    """A collection of explicitly allowed roots and bounded note operations."""

    MAX_CACHE_BYTES = MAX_ENVELOPE_CACHE_BYTES

    def __init__(self, roots: list[str | os.PathLike[str]], *, allow_empty: bool = False,
                 max_cache_bytes: int | None = None):
        if not roots and not allow_empty:
            raise AgentDocumentError("At least one explicit workspace root is required")
        normalized: list[Path] = []
        aliases: list[tuple[Path, Path]] = []
        for value in roots:
            supplied = Path(os.path.abspath(Path(value).expanduser()))
            root = supplied.resolve(strict=True)
            if not root.is_dir():
                raise AgentDocumentError(f"Workspace root is not a directory: {root}")
            if root not in normalized:
                normalized.append(root)
            if supplied != root:
                aliases.append((supplied, root))
        self.roots = tuple(normalized)
        self._root_aliases = tuple(sorted(aliases, key=lambda pair: len(pair[0].parts), reverse=True))
        self._cache_lock = threading.Lock()
        self._cache: OrderedDict[tuple[int, int, int, int], _CachedEnvelope] = OrderedDict()
        self._cache_bytes = 0
        self._max_cache_bytes = self.MAX_CACHE_BYTES if max_cache_bytes is None else max(0, max_cache_bytes)

    def resolve(self, value: str | os.PathLike[str], *, must_exist: bool = True) -> Path:
        """Resolve a caller path under one configured root; reject symlinks."""
        raw = Path(value).expanduser()
        candidates = [raw] if raw.is_absolute() else [root / raw for root in self.roots]
        for candidate in candidates:
            absolute = Path(os.path.abspath(candidate))
            # macOS exposes /var through /private/var. Preserve the caller's
            # explicitly configured root spelling without permitting symlinks
            # inside that workspace or following a root retargeted afterward.
            for alias, canonical in self._root_aliases:
                if absolute == alias or alias in absolute.parents:
                    absolute = canonical / absolute.relative_to(alias)
                    break
            root = next((r for r in self.roots if absolute == r or r in absolute.parents), None)
            if root is None:
                continue
            linked = _symlink_component(absolute)
            if linked is not None:
                raise AgentDocumentError(f"Symlink paths are not allowed: {linked}")
            if must_exist and not absolute.exists():
                continue
            if not must_exist and not absolute.parent.is_dir():
                continue
            # Recheck after existence and require lexical containment too. The
            # parent folders are deliberately not created by agent writes.
            try:
                resolved = absolute.resolve(strict=must_exist)
            except (OSError, RuntimeError):
                continue
            if resolved == root or root in resolved.parents:
                return absolute
        raise AgentDocumentError("Path is outside the configured workspace roots or does not exist")

    @staticmethod
    def _read_raw(path: Path) -> bytes:
        try:
            with path.open("rb") as stream:
                data = stream.read(documents.MAX_FILE + 1)
        except OSError as exc:
            raise AgentDocumentError(f"Could not read document: {exc.strerror or 'I/O error'}") from exc
        if len(data) > documents.MAX_FILE:
            raise AgentDocumentError("Document exceeds the 120 MB file limit")
        return data

    @staticmethod
    def _try_stat_key(path: Path) -> tuple[int, int, int, int] | None:
        try:
            info = os.stat(path, follow_symlinks=False)
        except OSError:
            return None
        if not stat.S_ISREG(info.st_mode):
            return None
        return (info.st_dev, info.st_ino, info.st_mtime_ns, info.st_size)

    def _evict_key_locked(self, key: tuple[int, int, int, int]) -> None:
        removed = self._cache.pop(key, None)
        if removed is not None:
            self._cache_bytes -= removed.total_bytes

    def _invalidate_path_locked(self, path: Path, extra_key: tuple[int, int, int, int] | None = None) -> None:
        path_str = str(path)
        if extra_key is not None:
            self._evict_key_locked(extra_key)
        for key, entry in list(self._cache.items()):
            if entry.path_str == path_str:
                self._evict_key_locked(key)

    def _enforce_cache_budget_locked(self, *, preserve: _CachedEnvelope | None = None) -> None:
        budget = max(0, self._max_cache_bytes)
        if self._cache_bytes <= budget:
            return
        for key in list(self._cache.keys()):
            if self._cache_bytes <= budget:
                return
            entry = self._cache[key]
            if entry is preserve:
                continue
            self._evict_key_locked(key)
        if preserve is not None and preserve.stat_key in self._cache and self._cache_bytes > budget:
            while preserve.decoded_assets and self._cache_bytes > budget:
                _, (_, payload, _) = preserve.decoded_assets.popitem(last=False)
                delta = len(payload)
                preserve.decoded_bytes -= delta
                self._cache_bytes -= delta
            if self._cache_bytes > budget:
                self._evict_key_locked(preserve.stat_key)

    def _cache_put_locked(self, entry: _CachedEnvelope) -> None:
        key = entry.stat_key
        if key is None:
            return
        self._invalidate_path_locked(Path(entry.path_str), key)
        budget = max(0, self._max_cache_bytes)
        if entry.envelope_bytes > budget:
            return
        self._cache[key] = entry
        self._cache_bytes += entry.total_bytes
        self._enforce_cache_budget_locked(preserve=entry)

    def _cache_lookup(self, path: Path, key: tuple[int, int, int, int] | None) -> _CachedEnvelope | None:
        if key is None:
            return None
        with self._cache_lock:
            entry = self._cache.get(key)
            if entry is None:
                return None
            if key[1] == 0 and entry.path_str != str(path):
                return None
            self._cache.move_to_end(key)
            return entry

    def _load_entry(self, path: Path) -> _CachedEnvelope:
        before_stat = self._try_stat_key(path)
        if before_stat is not None and before_stat[3] > documents.MAX_FILE:
            raise AgentDocumentError("Document exceeds the 120 MB file limit")
        cached = self._cache_lookup(path, before_stat)
        if cached is not None:
            return cached
        raw = self._read_raw(path)
        after_stat = self._try_stat_key(path)
        try:
            text, assets, portable = documents.decode_note_bytes(raw, path, decode_assets=False)
        except (ValueError, OSError, UnicodeError) as exc:
            raise AgentDocumentError(str(exc)) from exc
        revision = digest_bytes(raw)
        stable = before_stat is not None and after_stat == before_stat and len(raw) == before_stat[3]
        entry = _CachedEnvelope(
            stat_key=before_stat if stable else None,
            path_str=str(path),
            text=text,
            assets=dict(assets),
            portable=portable,
            revision=revision,
            raw_size=len(raw),
        )
        with self._cache_lock:
            if stable:
                self._cache_put_locked(entry)
            else:
                self._invalidate_path_locked(path, before_stat)
                if after_stat is not None:
                    self._evict_key_locked(after_stat)
        return entry

    def _decode_entry_asset(self, entry: _CachedEnvelope, asset_name: str) -> tuple[str, bytes, str]:
        with self._cache_lock:
            cached = entry.decoded_assets.get(asset_name)
            if cached is not None:
                entry.decoded_assets.move_to_end(asset_name)
                if entry.stat_key is not None and self._cache.get(entry.stat_key) is entry:
                    self._cache.move_to_end(entry.stat_key)
                return cached
        mime, payload = documents.image_data(entry.assets[asset_name])
        record = (mime, payload, digest_bytes(payload))
        with self._cache_lock:
            existing = entry.decoded_assets.get(asset_name)
            if existing is not None:
                entry.decoded_assets.move_to_end(asset_name)
                return existing
            in_cache = entry.stat_key is not None and self._cache.get(entry.stat_key) is entry
            entry.decoded_assets[asset_name] = record
            entry.decoded_bytes += len(payload)
            if in_cache:
                self._cache.move_to_end(entry.stat_key)
                self._cache_bytes += len(payload)
                self._enforce_cache_budget_locked(preserve=entry)
        return record

    def _entry_asset_metadata(self, entry: _CachedEnvelope, *, offset: int = 0, limit: int = 50) -> list[dict]:
        result = []
        for name in list(entry.assets.keys())[offset:offset + limit]:
            try:
                mime, payload, sha256 = self._decode_entry_asset(entry, name)
                result.append(_asset_record(name, mime, len(payload), sha256))
            except (ValueError, TypeError):
                result.append(_asset_record(name, invalid=True))
        return result

    def _record_written_snapshot(
        self,
        path: Path,
        *,
        old_stat: tuple[int, int, int, int] | None,
        text: str,
        assets: dict[str, str],
        portable: bool,
        data: bytes,
        revision: str,
        prior_decoded: dict[str, tuple[str, bytes, str]] | None = None,
    ) -> None:
        new_stat = self._try_stat_key(path)
        can_cache = (
            new_stat is not None
            and new_stat[3] == len(data)
            and (portable or not text.lstrip().startswith("{"))
        )
        decoded_map: OrderedDict[str, tuple[str, bytes, str]] = OrderedDict()
        decoded_bytes = 0
        if can_cache and prior_decoded:
            for name, record in prior_decoded.items():
                if name in assets:
                    decoded_map[name] = record
                    decoded_bytes += len(record[1])
        with self._cache_lock:
            self._invalidate_path_locked(path, old_stat)
            if can_cache:
                entry = _CachedEnvelope(
                    stat_key=new_stat,
                    path_str=str(path),
                    text=text,
                    assets=dict(assets),
                    portable=portable,
                    revision=revision,
                    raw_size=len(data),
                    decoded_bytes=decoded_bytes,
                    decoded_assets=decoded_map,
                )
                self._cache_put_locked(entry)

    def _load(self, path: Path) -> tuple[str, dict[str, str], bool, bytes]:
        with _path_lock(path):
            before_stat = self._try_stat_key(path)
            cached = self._cache_lookup(path, before_stat)
            raw = self._read_raw(path)
            after_stat = self._try_stat_key(path)
            if (cached is not None and before_stat is not None and after_stat == before_stat
                    and len(raw) == cached.raw_size and digest_bytes(raw) == cached.revision):
                if cached.portable:
                    try:
                        documents.validate({
                            "format": "supermd-smd", "version": 1,
                            "markdown": cached.text, "assets": cached.assets,
                        })
                    except ValueError as exc:
                        raise AgentDocumentError(str(exc)) from exc
                return cached.text, dict(cached.assets), cached.portable, raw
            try:
                text, assets, portable = documents.decode_note_bytes(raw, path)
            except (ValueError, OSError, UnicodeError) as exc:
                raise AgentDocumentError(str(exc)) from exc
            stable = before_stat is not None and after_stat == before_stat and len(raw) == before_stat[3]
            with self._cache_lock:
                if stable:
                    entry = _CachedEnvelope(
                        stat_key=before_stat,
                        path_str=str(path),
                        text=text,
                        assets=dict(assets),
                        portable=portable,
                        revision=digest_bytes(raw),
                        raw_size=len(raw),
                    )
                    self._cache_put_locked(entry)
                else:
                    self._invalidate_path_locked(path, before_stat)
                    if after_stat is not None:
                        self._evict_key_locked(after_stat)
            return text, dict(assets), portable, raw

    def read_markdown(self, path_value: str) -> str:
        path = self.resolve(path_value)
        with _path_lock(path):
            return self._load_entry(path).text

    def inspect(self, path_value: str) -> dict:
        path = self.resolve(path_value)
        with _path_lock(path):
            entry = self._load_entry(path)
            assets = self._entry_asset_metadata(entry, limit=40)
        fm_end, props = frontmatter.parse_frontmatter(entry.text)
        outline = outline_source(entry.text, _fm_end=fm_end)
        headings = outline["headings"]
        result = {
            "path": self.display_path(path), "format": "smd" if entry.portable or path.suffix.lower() == ".smd" else "markdown",
            "portable": entry.portable, "revision": entry.revision, "sha256": entry.revision,
            "bytes": entry.raw_size, "characters": len(entry.text), "lines": len(entry.text.splitlines()),
            "heading_count": outline["total"], "headings": headings,
            "headings_truncated": outline["truncated"], "next_heading_offset": outline["nextOffset"],
            "assets": assets, "asset_count": len(entry.assets),
        }
        if props is not None:
            result["properties"] = props
        return result

    def outline(self, path_value: str, *, offset: int = 0, limit: int = MAX_OUTLINE_PAGE) -> dict:
        path = self.resolve(path_value)
        with _path_lock(path):
            entry = self._load_entry(path)
        return {"path": self.display_path(path), "revision": entry.revision, **outline_source(entry.text, offset, limit)}

    def read(self, path_value: str, *, offset: int = 0, limit: int = MAX_PAGE_CHARS,
             heading: int | str | None = None, view: str = "prose") -> dict:
        path = self.resolve(path_value)
        with _path_lock(path):
            entry = self._load_entry(path)
        text = entry.text
        if not isinstance(offset, int) or offset < 0 or offset > len(text):
            raise AgentDocumentError("offset must be between 0 and the document character count")
        if not isinstance(limit, int) or limit < 1 or limit > MAX_PAGE_CHARS:
            raise AgentDocumentError(f"limit must be between 1 and {MAX_PAGE_CHARS}")
        if view not in ("prose", "source"):
            raise AgentDocumentError("view must be 'prose' or 'source'")
        document_length = len(text)
        section_start, section_end = 0, document_length
        headings, spans = _read_headings_and_svg_spans(
            text,
            include_headings=heading is not None,
            include_svg=view == "prose",
        )
        if heading is not None:
            item = resolve_heading(headings, heading)
            section_start, section_end = item["sectionStart"], item["sectionEnd"]
        if offset > section_end:
            raise AgentDocumentError(f"offset must be within the selected section (sectionEnd {section_end})")
        start = offset if heading is None else max(section_start, offset)
        end = section_end
        offset = start
        page_end = (_prose_page_end(offset, limit, end, spans) if view == "prose"
                    else min(end, offset + limit))
        page_text = text[offset:page_end]
        omitted = []
        if view == "prose":
            page_text, omitted = _elide_svg_page(text, offset, page_end, spans)
        return {"path": self.display_path(path), "revision": entry.revision, "start": offset,
                "end": page_end, "total_chars": section_end - section_start, "next_offset": page_end if page_end < end else None,
                "truncated": page_end < end, "view": view, "text": page_text,
                "returned_chars": len(page_text), "svg_omissions": omitted,
                "sectionStart": section_start, "sectionEnd": section_end, "documentLength": document_length}

    def search(self, path_value: str, query: str, *, limit: int = 10, context: int = 100,
               offset: int = 0, case_sensitive: bool = False, whole_word: bool = False,
               regex: bool = False, exclude_diagrams: bool = False) -> dict:
        path = self.resolve(path_value)
        with _path_lock(path):
            entry = self._load_entry(path)
        result = search_source(entry.text, query, limit, context, offset, case_sensitive, whole_word, regex, exclude_diagrams)
        return {"path": self.display_path(path), "revision": entry.revision, "query": query, **result}

    def create(self, path_value: str, content: str, *, expected_absent: bool = True) -> dict:
        path = self.resolve(path_value, must_exist=False)
        if not isinstance(content, str) or len(content.encode("utf-8")) > 20_000_000:
            raise AgentDocumentError("content must be UTF-8 text no larger than 20 MB")
        if path.exists():
            raise RevisionConflict("A file already exists at this path; creation never overwrites")
        portable = path.suffix.lower() == ".smd"
        data = _serialize(path, content, {}, portable=portable)
        revision = digest_bytes(data)
        with _path_lock(path):
            if path.exists():
                raise RevisionConflict("A file was created at this path while this request was running")
            _create_once(path, data)
            self._record_written_snapshot(
                path, old_stat=None, text=content, assets={}, portable=portable, data=data, revision=revision,
            )
        return {"path": self.display_path(path), "revision": revision, "sha256": revision,
                "bytes": len(data), "characters": len(content), "created": True}

    def patch(self, path_value: str, *, expected_revision: str, operations: list[dict]) -> dict:
        path = self.resolve(path_value)
        if not expected_revision or not re.fullmatch(r"[0-9a-f]{64}", expected_revision):
            raise AgentDocumentError("expected_revision must be the 64-character SHA-256 from inspect/read")
        validate_patch_operations(operations)
        with _path_lock(path):
            entry = self._load_entry(path)
            actual = entry.revision
            if actual != expected_revision:
                raise RevisionConflict("Document changed since it was read; inspect it again before editing")
            edited, operation_results = apply_patch_operations_detailed(entry.text, operations)
            if len(edited.encode("utf-8")) > 20_000_000:
                raise AgentDocumentError("Edited Markdown exceeds the 20 MB limit")
            data = _serialize(path, edited, entry.assets, portable=entry.portable)
            # Recheck immediately before atomic replace to catch ordinary
            # external writers that do not participate in our lock protocol.
            if digest_bytes(self._read_raw(path)) != expected_revision:
                with self._cache_lock:
                    self._invalidate_path_locked(path, entry.stat_key)
                raise RevisionConflict("Document changed during the edit; no changes were saved")
            with self._cache_lock:
                prior_decoded = dict(entry.decoded_assets)
            _atomic_replace(path, data)
            new_revision = digest_bytes(data)
            self._record_written_snapshot(
                path, old_stat=entry.stat_key, text=edited, assets=entry.assets,
                portable=entry.portable, data=data, revision=new_revision, prior_decoded=prior_decoded,
            )
        return {"path": self.display_path(path), "previous_revision": actual,
                "revision": new_revision, "sha256": new_revision, "bytes": len(data),
                "characters": len(edited), "operations": len(operations), "applied": len(operation_results),
                "operation_results": operation_results, "saved": True}

    def assets(self, path_value: str, *, offset: int = 0, limit: int = 50) -> dict:
        path = self.resolve(path_value)
        with _path_lock(path):
            entry = self._load_entry(path)
            if not isinstance(offset, int) or not isinstance(limit, int) or offset < 0 or not 1 <= limit <= 50:
                raise AgentDocumentError("asset offset must be nonnegative and limit must be 1–50")
            page = self._entry_asset_metadata(entry, offset=offset, limit=limit)
        next_offset = offset + len(page)
        total = len(entry.assets)
        return {"path": self.display_path(path), "revision": entry.revision, "assets": page,
                "total": total, "next_offset": next_offset if next_offset < total else None}

    def read_asset(self, path_value: str, asset_name: str, *, expected_revision: str) -> dict:
        """Return explicitly requested embedded bytes, never part of metadata reads."""
        path = self.resolve(path_value)
        with _path_lock(path):
            entry = self._load_entry(path)
            revision = entry.revision
            if revision != expected_revision:
                raise RevisionConflict("Document changed since it was read; inspect again before extracting")
            if asset_name not in entry.assets:
                raise AgentDocumentError("Asset not found; call document_assets for exact names")
            try:
                mime, payload, sha256 = self._decode_entry_asset(entry, asset_name)
            except ValueError as exc:
                raise AgentDocumentError(str(exc)) from exc
            return {"asset": asset_name, "mime_type": mime, "data": payload,
                    "bytes": len(payload), "sha256": sha256, "revision": revision}

    def attach_asset(self, path_value: str, asset_path_value: str, *, expected_revision: str,
                     name: str | None = None) -> dict:
        path = self.resolve(path_value)
        asset_path = self.resolve(asset_path_value)
        if asset_path.stat().st_size > MAX_ASSET_BYTES:
            raise AgentDocumentError("Asset exceeds 25 MB")
        raw_asset = self._read_raw(asset_path)
        if len(raw_asset) > MAX_ASSET_BYTES:
            raise AgentDocumentError("Asset exceeds 25 MB")
        ext = asset_path.suffix.lower().lstrip(".")
        mime = documents.MIMES.get(ext)
        if mime is None:
            raise AgentDocumentError("Asset type must be PNG, JPEG, SVG, GIF, WebP, or AVIF")
        filename = name or asset_path.name
        asset_sha = digest_bytes(raw_asset)
        if name is None and not documents.is_valid_asset_filename(filename):
            original_ext = Path(filename).suffix
            stem = re.sub(r"[^A-Za-z0-9._-]+", "-", Path(filename).stem).strip(".-_") or "asset"
            filename = f"{stem[:120]}-{asset_sha[:8]}{original_ext}"
        if not documents.is_valid_asset_filename(filename):
            raise AgentDocumentError("Asset name must be a simple filename (letters, digits, dot, underscore, hyphen)")
        named_ext = Path(filename).suffix.lower().lstrip(".")
        if not named_ext:
            filename += "." + ext
            if not documents.is_valid_asset_filename(filename):
                raise AgentDocumentError("Asset name must be a simple filename (letters, digits, dot, underscore, hyphen)")
        elif documents.MIMES.get(named_ext) != mime:
            raise AgentDocumentError("Asset name extension must match the image type")
        asset_key = "assets/" + filename
        data_url = f"data:{mime};base64," + documents.encode_base64_chunked(raw_asset)
        documents._cache_validated_asset(data_url, mime, len(raw_asset))
        with _path_lock(path):
            entry = self._load_entry(path)
            if entry.revision != expected_revision:
                raise RevisionConflict("Document changed since it was read; inspect it again before editing")
            if not entry.portable:
                raise AgentDocumentError("Attach is for portable .smd notes; create/copy as .smd to keep assets self-contained")
            if asset_key in entry.assets:
                raise AgentDocumentError(f"An asset named {asset_key} already exists; choose another name")
            updated = dict(entry.assets)
            updated[asset_key] = data_url
            data = _serialize(path, entry.text, updated, portable=True)
            if digest_bytes(self._read_raw(path)) != expected_revision:
                with self._cache_lock:
                    self._invalidate_path_locked(path, entry.stat_key)
                raise RevisionConflict("Document changed during the edit; no changes were saved")
            with self._cache_lock:
                prior_decoded = dict(entry.decoded_assets)
            prior_decoded[asset_key] = (mime, raw_asset, asset_sha)
            _atomic_replace(path, data)
            new_revision = digest_bytes(data)
            self._record_written_snapshot(
                path, old_stat=entry.stat_key, text=entry.text, assets=updated,
                portable=True, data=data, revision=new_revision, prior_decoded=prior_decoded,
            )
        return {"path": self.display_path(path), "asset": _asset_record(asset_key, mime, len(raw_asset), asset_sha),
                "previous_revision": expected_revision, "revision": new_revision, "saved": True}

    def replace_asset(self, path_value: str, asset_id: str, asset_path_value: str, *,
                      expected_revision: str) -> dict:
        """Replace bytes for one stable asset reference without changing note text or other assets."""
        path = self.resolve(path_value)
        asset_path = self.resolve(asset_path_value)
        if asset_path.stat().st_size > MAX_ASSET_BYTES:
            raise AgentDocumentError("Replacement asset exceeds 25 MB")
        raw_asset = self._read_raw(asset_path)
        if len(raw_asset) > MAX_ASSET_BYTES:
            raise AgentDocumentError("Replacement asset exceeds 25 MB")
        mime = documents.MIMES.get(asset_path.suffix.lower().lstrip("."))
        if mime is None:
            raise AgentDocumentError("Replacement type must be PNG, JPEG, SVG, GIF, WebP, or AVIF")
        if not isinstance(asset_id, str) or not asset_id or len(asset_id) > 256:
            raise AgentDocumentError("asset_id must be an exact ID or asset name from document_assets")
        with _path_lock(path):
            entry = self._load_entry(path)
            revision = entry.revision
            if revision != expected_revision:
                raise RevisionConflict("Document changed since it was read; inspect again before replacing an asset")
            asset_name = _resolve_asset_id(entry.assets, asset_id)
            if not entry.portable:
                raise AgentDocumentError("Asset replacement requires a portable .smd note")
            extension_mime = documents.MIMES.get(asset_name.rsplit(".", 1)[-1].lower())
            if extension_mime != mime:
                raise AgentDocumentError("Replacement image must keep the current asset MIME type and extension")
            try:
                old_mime, old_data, old_sha = self._decode_entry_asset(entry, asset_name)
            except ValueError as exc:
                raise AgentDocumentError(str(exc)) from exc
            if old_mime != mime:
                raise AgentDocumentError("Asset reference MIME type is inconsistent with its extension")
            if old_data == raw_asset:
                return {"path": self.display_path(path), "asset": _asset_record(asset_name, old_mime, len(old_data), old_sha),
                        "previous_revision": revision, "revision": revision, "saved": False, "changed": False}
            updated = dict(entry.assets)
            new_url = f"data:{mime};base64," + documents.encode_base64_chunked(raw_asset)
            documents._cache_validated_asset(new_url, mime, len(raw_asset))
            updated[asset_name] = new_url
            data = _serialize(path, entry.text, updated, portable=True)
            if digest_bytes(self._read_raw(path)) != expected_revision:
                with self._cache_lock:
                    self._invalidate_path_locked(path, entry.stat_key)
                raise RevisionConflict("Document changed during replacement; no changes were saved")
            new_sha = digest_bytes(raw_asset)
            with self._cache_lock:
                prior_decoded = dict(entry.decoded_assets)
            prior_decoded[asset_name] = (mime, raw_asset, new_sha)
            _atomic_replace(path, data)
            new_revision = digest_bytes(data)
            self._record_written_snapshot(
                path, old_stat=entry.stat_key, text=entry.text, assets=updated,
                portable=True, data=data, revision=new_revision, prior_decoded=prior_decoded,
            )
        return {"path": self.display_path(path), "asset": _asset_record(asset_name, mime, len(raw_asset), new_sha),
                "previous_revision": revision, "revision": new_revision, "saved": True, "changed": True}

    def extract_asset(self, path_value: str, asset_name: str, output_value: str, *,
                      expected_revision: str) -> dict:
        path = self.resolve(path_value)
        output = self.resolve(output_value, must_exist=False)
        if output == path:
            raise AgentDocumentError("Extraction output must be a separate path")
        with _path_lock(path):
            entry = self._load_entry(path)
            if entry.revision != expected_revision:
                raise RevisionConflict("Document changed since it was read; inspect it again before extracting")
            if asset_name not in entry.assets:
                raise AgentDocumentError("Asset not found; call document_assets for exact names")
            try:
                _, payload, sha256 = self._decode_entry_asset(entry, asset_name)
            except ValueError as exc:
                raise AgentDocumentError(str(exc)) from exc
            if len(payload) > MAX_ASSET_BYTES:
                raise AgentDocumentError("Asset exceeds 25 MB")
        with _path_lock(output):
            if output.exists():
                raise RevisionConflict("Extraction never overwrites an existing file")
            _create_once(output, payload)
        return {"path": self.display_path(output), "asset": asset_name, "bytes": len(payload),
                "sha256": sha256, "extracted": True}

    def display_path(self, path: Path) -> str:
        for root in self.roots:
            try:
                return str(path.relative_to(root))
            except ValueError:
                pass
        return str(path)


def _asset_record(
    name: str,
    mime: str | None = None,
    size: int | None = None,
    sha256: str | None = None,
    *,
    invalid: bool = False,
) -> dict:
    record = {
        "id": hashlib.sha256(name.encode("utf-8")).hexdigest(),
        "name": name,
        "mime": mime,
        "bytes": size,
        "sha256": sha256,
    }
    if invalid:
        record["invalid"] = True
    return record


def _asset_metadata(assets: dict[str, str], *, offset: int = 0, limit: int = 50) -> list[dict]:
    result = []
    for name, data in list(assets.items())[offset:offset + limit]:
        try:
            mime, payload = documents.image_data(data)
            result.append(_asset_record(name, mime, len(payload), digest_bytes(payload)))
        except (ValueError, TypeError):
            result.append(_asset_record(name, invalid=True))
    return result


def _resolve_asset_id(assets: dict[str, str], asset_id: str) -> str:
    if asset_id in assets:
        return asset_id
    matches = [name for name in assets if hashlib.sha256(name.encode("utf-8")).hexdigest() == asset_id]
    if len(matches) != 1:
        raise AgentDocumentError("Asset ID is not present in the current document")
    return matches[0]


_SVG_FENCE_LANGUAGES = frozenset({"svg", "svg+xml", "image/svg+xml"})
_DIAGRAM_FENCE_LANGUAGES = _SVG_FENCE_LANGUAGES | {"mermaid", "smd-chart"}
_BRACED_FENCE_HEAD = re.compile(r"^\.?([A-Za-z][A-Za-z0-9_-]*)(?:$|[\s,#])")


def normalize_fence_language(raw_info: str) -> str:
    trimmed = raw_info.strip()
    if len(trimmed) >= 4 and trimmed.startswith("{") and trimmed.endswith("}"):
        match = _BRACED_FENCE_HEAD.match(trimmed[1:-1].strip())
        if match:
            lower = match.group(1).casefold()
            if lower in ("python", "py", "mermaid"):
                return lower
    parts = trimmed.split(None, 1)
    return parts[0].casefold() if parts else ""


@dataclass(frozen=True)
class _FencedSpan:
    fence_start: int
    fence_end: int
    body_start: int
    body_end: int
    line_start: int
    line_end: int
    is_svg: bool
    is_diagram: bool
    language: str = ""

    def to_svg_dict(self) -> dict:
        return {
            "start": self.body_start,
            "end": self.body_end,
            "line_start": self.line_start,
            "line_end": self.line_end,
        }


@dataclass
class _OpenFence:
    char: str
    size: int
    fence_start: int
    body_start: int
    line_start: int
    language: str = ""
    svg_tagged: bool = False
    diagram_tagged: bool = False
    probe: list[str] = field(default_factory=list)

    def is_svg(self) -> bool:
        return self.svg_tagged or "".join(self.probe).lstrip().lower().startswith("<svg")

    def to_span(self, *, fence_end: int, body_end: int, line_end: int) -> _FencedSpan:
        is_svg = self.is_svg()
        return _FencedSpan(
            fence_start=self.fence_start,
            fence_end=fence_end,
            body_start=self.body_start,
            body_end=body_end,
            line_start=self.line_start,
            line_end=max(self.line_start, line_end),
            is_svg=is_svg,
            is_diagram=self.diagram_tagged or is_svg,
            language=self.language,
        )


def _step_fence_boundary(
    body: str,
    opened: _OpenFence | None,
    *,
    offset: int,
    line_len: int,
    line_number: int,
    inspect_info: bool,
) -> tuple[bool, _OpenFence | None, _FencedSpan | None]:
    """Parse one line for CommonMark fence boundaries."""
    match = _FENCE.match(body)
    if match is None:
        return False, opened, None
    marker = match.group(1)
    if opened is None:
        language = normalize_fence_language(body[match.end():]) if inspect_info else ""
        svg_tagged = language in _SVG_FENCE_LANGUAGES
        return True, _OpenFence(
            char=marker[0],
            size=len(marker),
            fence_start=offset,
            body_start=offset + line_len,
            line_start=line_number + 1,
            language=language,
            svg_tagged=svg_tagged,
            diagram_tagged=svg_tagged or language in _DIAGRAM_FENCE_LANGUAGES,
        ), None
    if marker[0] == opened.char and len(marker) >= opened.size:
        closed = (
            opened.to_span(
                fence_end=offset + line_len,
                body_end=offset,
                line_end=line_number - 1,
            )
            if inspect_info else None
        )
        return True, None, closed
    return True, opened, None


def _scan_read_only(
    text: str,
    *,
    collect_headings: bool = False,
    collect_fences: bool = False,
    fm_end: int | None = None,
) -> tuple[list[dict], list[_FencedSpan]]:
    has_fences = "```" in text or "~~~" in text
    if not collect_headings and not (collect_fences and has_fences):
        return [], []
    resolved_fm_end = (
        (frontmatter.frontmatter_end(text) if text.startswith(("---", "\ufeff---")) else 0)
        if fm_end is None else fm_end
    )
    headings: list[dict] = []
    fences: list[_FencedSpan] = []
    offset = 0
    line_number = 1
    opened: _OpenFence | None = None
    for line in text.splitlines(keepends=True):
        line_len = len(line)
        if offset < resolved_fm_end:
            offset += line_len
            line_number += 1
            continue
        body = line.rstrip("\r\n")
        if has_fences:
            is_fence_line, opened, closed = _step_fence_boundary(
                body,
                opened,
                offset=offset,
                line_len=line_len,
                line_number=line_number,
                inspect_info=collect_fences,
            )
            if closed is not None:
                fences.append(closed)
            if is_fence_line:
                offset += line_len
                line_number += 1
                continue
        if opened is None:
            if collect_headings:
                match = _HEADING.match(body)
                if match:
                    headings.append({
                        "index": len(headings),
                        "level": len(match.group(1)),
                        "title": match.group(2)[:300],
                        "line": line_number,
                        "start": offset,
                    })
        elif collect_fences and not opened.svg_tagged and len(opened.probe) < 4:
            opened.probe.append(body[:512])
        offset += line_len
        line_number += 1
    if opened is not None and collect_fences:
        fences.append(
            opened.to_span(
                fence_end=len(text),
                body_end=len(text),
                line_end=line_number - 1,
            )
        )
    return headings, fences


def _read_headings_and_svg_spans(
    text: str,
    *,
    include_headings: bool,
    include_svg: bool,
) -> tuple[list[dict], list[dict]]:
    found, fences = _scan_read_only(
        text,
        collect_headings=include_headings,
        collect_fences=include_svg,
    )
    headings = _heading_sections(text, found) if include_headings else []
    svg_spans = [span.to_svg_dict() for span in fences if span.is_svg] if include_svg else []
    return headings, svg_spans


def _headings(text: str, *, include_internal: bool = False, fm_end: int | None = None) -> list[dict]:
    found, _ = _scan_read_only(text, collect_headings=True, fm_end=fm_end)
    if include_internal:
        return _heading_sections(text, found)
    return [{k: v for k, v in item.items() if k != "start"} for item in found]


def _heading_sections(text: str, headings: list[dict]) -> list[dict]:
    """Add code-point section bounds using the next same-or-higher-level heading."""
    section_ends = [len(text)] * len(headings)
    stack: list[int] = []
    for heading in headings:
        while stack and headings[stack[-1]]["level"] >= heading["level"]:
            section_ends[stack.pop()] = heading["start"]
        stack.append(heading["index"])
    return [{**heading, "sectionStart": heading["start"], "sectionEnd": section_ends[index]}
            for index, heading in enumerate(headings)]


def outline_source(
    source: str,
    offset: int = 0,
    limit: int = MAX_OUTLINE_PAGE,
    *,
    _fm_end: int | None = None,
) -> dict:
    """Pure bounded outline page with code-point positions and section ranges."""
    if not isinstance(source, str):
        raise AgentDocumentError("source must be text")
    headings = _headings(source, include_internal=True, fm_end=_fm_end)
    if not isinstance(offset, int) or isinstance(offset, bool) or not 0 <= offset <= len(headings):
        raise AgentDocumentError("outline offset must be between 0 and the heading count")
    if not isinstance(limit, int) or isinstance(limit, bool) or not 1 <= limit <= MAX_OUTLINE_PAGE:
        raise AgentDocumentError(f"outline limit must be between 1 and {MAX_OUTLINE_PAGE}")
    end = min(len(headings), offset + limit)
    return {"headings": headings[offset:end], "offset": offset, "total": len(headings),
            "nextOffset": end if end < len(headings) else None, "truncated": end < len(headings),
            "documentLength": len(source)}


def _heading_slug(title: str) -> str:
    decomposed = unicodedata.normalize("NFKD", title.lower())
    parts: list[str] = []
    current: list[str] = []
    for char in decomposed:
        if unicodedata.category(char)[0] in ("L", "N"):
            current.append(char)
        elif current:
            parts.append("".join(current))
            current.clear()
    if current:
        parts.append("".join(current))
    return "-".join(parts)


def _ambiguous_heading(selector: str, matches: list[dict]) -> AgentDocumentError:
    candidates = "; ".join(f"{item['index']}: {item['title'][:80]} (line {item['line']})"
                            for item in matches[:5])
    if len(matches) > 5:
        candidates += "; …"
    return AgentDocumentError(f"Heading selector '{selector[:80]}' is ambiguous ({len(matches)} matches); "
                              f"candidates: {candidates}. Use an outline index or a more specific exact title/slug.")


def resolve_heading(headings: list[dict], selector: int | str) -> dict:
    """Resolve a zero-based outline index or an exact title, slug, or section number."""
    if isinstance(selector, int) and not isinstance(selector, bool):
        if 0 <= selector < len(headings):
            return headings[selector]
        raise AgentDocumentError(f"Heading index {selector} is not present in this document")
    if not isinstance(selector, str) or not selector.strip() or len(selector) > 300:
        raise AgentDocumentError("heading must be an outline index or exact title, slug, or numbered heading prefix")
    query = selector.strip()
    exact = [item for item in headings if item["title"] == query]
    if len(exact) == 1:
        return exact[0]
    if len(exact) > 1:
        raise _ambiguous_heading(query, exact)
    slug = _heading_slug(query)
    slug_matches = [item for item in headings if _heading_slug(item["title"]) == slug]
    if len(slug_matches) == 1:
        return slug_matches[0]
    if len(slug_matches) > 1:
        raise _ambiguous_heading(query, slug_matches)
    if re.fullmatch(r"\d+(?:\.\d+)*", query):
        numbered = [item for item in headings
                    if re.match(r"^" + re.escape(query) + r"(?:$|[\s:)\-—]|\.(?=\s))", item["title"])]
        if len(numbered) == 1:
            return numbered[0]
        if len(numbered) > 1:
            raise _ambiguous_heading(query, numbered)
    raise AgentDocumentError(f"No heading matches '{query[:80]}'; use an exact title, slug, or outline index")


def section_source(source: str, selector: int | str) -> dict:
    """Return the exact source range for one heading and its nested subsections."""
    if not isinstance(source, str):
        raise AgentDocumentError("source must be text")
    heading = resolve_heading(_headings(source, include_internal=True), selector)
    start, end = heading["sectionStart"], heading["sectionEnd"]
    return {"text": source[start:end], "sectionStart": start, "sectionEnd": end,
            "documentLength": len(source)}


def _word_character(value: str) -> bool:
    return value == "_" or (bool(value) and unicodedata.category(value)[0] in ("L", "N"))


_INLINE_SVG_OPEN = re.compile(r"<svg\b[^>]*>", re.IGNORECASE)
_INLINE_SVG_CLOSE = re.compile(r"</svg\s*>", re.IGNORECASE)


def diagram_spans(text: str, *, include_inline_svg: bool = False) -> list[dict]:
    """Return diagram body ranges as code-point `{start, end}` offsets; end is exclusive."""
    _, fences = _scan_read_only(text, collect_fences=True)
    spans = [{"start": span.body_start, "end": span.body_end} for span in fences if span.is_diagram]
    if not include_inline_svg:
        return spans
    if "<" in text:
        cursor = 0
        fence_idx = 0
        while True:
            open_match = _INLINE_SVG_OPEN.search(text, cursor)
            if open_match is None:
                break
            start = open_match.start()
            while fence_idx < len(fences) and fences[fence_idx].fence_end <= start:
                fence_idx += 1
            if fence_idx < len(fences) and fences[fence_idx].fence_start <= start < fences[fence_idx].fence_end:
                cursor = fences[fence_idx].fence_end
                continue
            if open_match.group(0).rstrip().endswith("/>"):
                spans.append({"start": start, "end": open_match.end()})
                cursor = open_match.end()
                continue
            close_match = _INLINE_SVG_CLOSE.search(text, open_match.end())
            end = close_match.end() if close_match is not None else len(text)
            spans.append({"start": start, "end": end})
            cursor = end
    unique = {(item["start"], item["end"]) for item in spans}
    return [{"start": start, "end": end} for start, end in sorted(unique)]


def search_source(source: str, query: str, limit: int = 10, context: int = 100, offset: int = 0,
                  case_sensitive: bool = False, whole_word: bool = False, regex: bool = False,
                  exclude_diagrams: bool = False) -> dict:
    """Search a Markdown snapshot without file or UI access; offsets are code points."""
    if not isinstance(source, str):
        raise AgentDocumentError("source must be text")
    if not isinstance(query, str) or not query or len(query) > MAX_QUERY_CHARS:
        raise AgentDocumentError(f"query must contain 1–{MAX_QUERY_CHARS} characters")
    if not isinstance(offset, int) or isinstance(offset, bool) or offset < 0 or offset > len(source):
        raise AgentDocumentError("offset must be between 0 and the document character count")
    if (not isinstance(limit, int) or isinstance(limit, bool) or not 1 <= limit <= MAX_SEARCH_RESULTS or
            not isinstance(context, int) or isinstance(context, bool) or not 0 <= context <= 500):
        raise AgentDocumentError("limit must be 1–25 and context 0–500")
    if any(not isinstance(value, bool) for value in (case_sensitive, whole_word, regex, exclude_diagrams)):
        raise AgentDocumentError("case_sensitive, whole_word, regex and exclude_diagrams must be booleans")
    if regex:
        escaped = False
        in_class = False
        for char in query:
            if escaped:
                if char.isdigit() or char == "k":
                    raise AgentDocumentError("regex supports no backreferences")
                if not in_class and char in ("b", "B"):
                    raise AgentDocumentError("regex supports no zero-width word-boundary assertions")
                escaped = False
            elif char == "\\":
                escaped = True
            elif char == "[":
                in_class = True
            elif char == "]":
                in_class = False
            elif not in_class and char in "*+?{}()|":
                raise AgentDocumentError("regex supports literals, dot, character classes and anchors only; quantifiers, groups and alternation are not supported")
        if escaped:
            raise AgentDocumentError("regex ends with an incomplete escape")
        try:
            pattern = re.compile(query, re.MULTILINE | (0 if case_sensitive else re.IGNORECASE))
        except re.error as exc:
            raise AgentDocumentError("regex is not valid in the supported safe subset") from exc
        if pattern.search("") is not None:
            raise AgentDocumentError("regex must match at least one character")
    else:
        pattern = re.compile(re.escape(query), re.MULTILINE | (0 if case_sensitive else re.IGNORECASE))
    spans = diagram_spans(source) if exclude_diagrams else []
    matches = []
    total = 0
    remaining = 0
    cursor = 0
    span_idx = 0
    while True:
        match = pattern.search(source, cursor)
        if match is None:
            break
        start, end = match.span()
        if end <= start:
            cursor = start + 1
            continue
        cursor = end
        if whole_word and ((start > 0 and _word_character(source[start - 1])) or
                           (end < len(source) and _word_character(source[end]))):
            continue
        if exclude_diagrams:
            while span_idx < len(spans) and spans[span_idx]["end"] <= start:
                span_idx += 1
            if span_idx < len(spans) and start < spans[span_idx]["end"] and end > spans[span_idx]["start"]:
                continue
        total += 1
        if start < offset:
            continue
        remaining += 1
        if len(matches) < limit:
            left, right = max(0, start - context), min(len(source), end + context)
            matches.append({"offset": start, "line": source.count("\n", 0, start) + 1,
                            "start": left, "end": right, "snippet": source[left:right],
                            "matchOffset": start, "matchLength": end - start, "snippetOffset": left})
    next_offset = (matches[-1]["matchOffset"] + matches[-1]["matchLength"]
                   if remaining > len(matches) and matches else None)
    return {"matches": matches, "totalMatches": total, "remainingMatches": remaining,
            "nextOffset": next_offset, "truncated": remaining > len(matches)}


def _svg_spans(text: str) -> list[dict]:
    _, fences = _scan_read_only(text, collect_fences=True)
    return [span.to_svg_dict() for span in fences if span.is_svg]


def _prose_page_end(start: int, limit: int, max_end: int, spans: list[dict]) -> int:
    """Consume a page of visible prose, skipping SVG bodies without pagination loops."""
    cursor = start
    remaining = limit
    for span in spans:
        if span["end"] <= cursor or span["start"] >= max_end:
            continue
        if span["start"] > cursor:
            plain_end = min(span["start"], max_end)
            consumed = min(plain_end - cursor, remaining)
            cursor += consumed
            remaining -= consumed
            if remaining == 0:
                return cursor
        # The omitted source is consumed at zero prose budget cost. Clamp to
        # the caller's heading/document boundary.
        cursor = min(max_end, max(cursor, span["end"]))
        if cursor >= max_end:
            return max_end
    return min(max_end, cursor + remaining)


def _elide_svg_page(text: str, start: int, end: int, spans: list[dict] | None = None) -> tuple[str, list[dict]]:
    pieces = []
    omissions = []
    cursor = start
    for span in _svg_spans(text) if spans is None else spans:
        left, right = max(start, span["start"]), min(end, span["end"])
        if left >= right:
            continue
        pieces.append(text[cursor:left])
        omitted = {"source_start": span["start"], "source_end": span["end"],
                   "line_start": span["line_start"], "line_end": span["line_end"],
                   "omitted_chars": span["end"] - span["start"],
                   "omitted_lines": max(1, span["line_end"] - span["line_start"] + 1)}
        omissions.append(omitted)
        pieces.append(f"[SVG omitted: {omitted['omitted_chars']} chars, source lines "
                      f"{omitted['line_start']}–{omitted['line_end']}]\n")
        cursor = right
    pieces.append(text[cursor:end])
    return "".join(pieces), omissions


def _serialize(path: Path, text: str, assets: dict[str, str], *, portable: bool | None = None) -> bytes:
    use_portable = (path.suffix.lower() == ".smd") if portable is None else portable
    if use_portable:
        try:
            return documents.compressed_bundle(text, assets)
        except ValueError as exc:
            raise AgentDocumentError(str(exc)) from exc
    if assets:
        raise AgentDocumentError("A Markdown file cannot embed portable assets")
    return text.encode("utf-8")


@contextmanager
def _path_lock(path: Path) -> Iterator[None]:
    """Stable inter-process advisory lock outside user workspaces."""
    uid = str(getattr(os, "getuid", lambda: "user")())
    folder = Path(tempfile.gettempdir()) / f"supermd-agent-locks-{uid}"
    folder.mkdir(mode=0o700, parents=True, exist_ok=True)
    if folder.is_symlink():
        raise AgentDocumentError("Unsafe agent lock directory")
    if os.name == "posix" and folder.stat().st_uid != os.getuid():
        raise AgentDocumentError("Agent lock directory is owned by another user")
    try:
        folder.chmod(0o700)
    except OSError:
        pass
    lock_path = folder / (hashlib.sha256(os.fsencode(path)).hexdigest() + ".lock")
    flags = os.O_RDWR | os.O_CREAT
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    try:
        with _LOCK_GUARD:
            descriptor = os.open(lock_path, flags, 0o600)
        handle = os.fdopen(descriptor, "r+b")
    except OSError as exc:
        raise AgentDocumentError("Could not acquire the document edit lock") from exc
    try:
        if os.name == "nt":
            import msvcrt
            handle.seek(0)
            if handle.read(1) == b"":
                handle.write(b"0"); handle.flush()
            handle.seek(0)
            msvcrt.locking(handle.fileno(), msvcrt.LK_LOCK, 1)
        else:
            import fcntl
            fcntl.flock(handle.fileno(), fcntl.LOCK_EX)
        yield
    finally:
        if os.name == "nt":
            import msvcrt
            handle.seek(0); msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
        else:
            import fcntl
            fcntl.flock(handle.fileno(), fcntl.LOCK_UN)
        handle.close()


def _atomic_replace(path: Path, data: bytes) -> None:
    handle, temporary = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".agent-tmp", dir=path.parent)
    try:
        with os.fdopen(handle, "wb") as stream:
            if path.exists() and hasattr(os, "fchmod"):
                os.fchmod(stream.fileno(), stat.S_IMODE(path.stat().st_mode))
            stream.write(data); stream.flush(); os.fsync(stream.fileno())
        # Symlink may have appeared after initial path validation.
        if _symlink_component(path) is not None:
            raise AgentDocumentError("Refusing to replace a symlink path")
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def _create_once(path: Path, data: bytes) -> None:
    handle, temporary = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".agent-new", dir=path.parent)
    try:
        with os.fdopen(handle, "wb") as stream:
            stream.write(data); stream.flush(); os.fsync(stream.fileno())
        if _symlink_component(path) is not None:
            raise AgentDocumentError("Refusing to create through a symlink path")
        # A hard-link publishes the fully written temporary file atomically and
        # fails if another process created the target in the meantime.
        os.link(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)
