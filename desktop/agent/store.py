"""Bounded workspace document store and portable asset operations."""
from __future__ import annotations

import os
import re
import sys
import threading
from collections import OrderedDict
from pathlib import Path

from . import fs_ops, patches, source_ops

AgentDocumentError, RevisionConflict = source_ops.AgentDocumentError, source_ops.RevisionConflict

if "." in (__package__ or ""):
    from .. import documents, frontmatter
else:
    import documents
    import frontmatter

MAX_ASSET_BYTES, MAX_ENVELOPE_CACHE_BYTES = fs_ops.MAX_ASSET_BYTES, fs_ops.MAX_ENVELOPE_CACHE_BYTES


def _asset_metadata(assets: dict[str, str], *, offset: int = 0, limit: int = 50) -> list[dict]:
    result = []
    for name, data in list(assets.items())[offset:offset + limit]:
        try:
            mime, payload = documents.image_data(data)
            result.append(fs_ops._asset_record(name, mime, len(payload), _agent_documents.digest_bytes(payload)))
        except (ValueError, TypeError):
            result.append(fs_ops._asset_record(name, invalid=True))
    return result


class DocumentStore:
    """A collection of explicitly allowed roots and bounded note operations."""

    MAX_CACHE_BYTES = MAX_ENVELOPE_CACHE_BYTES
    _read_raw = staticmethod(fs_ops._read_raw)
    _try_stat_key = staticmethod(fs_ops._try_stat_key)

    def __init__(self, roots: list[str | os.PathLike[str]], *, allow_empty: bool = False,
                 max_cache_bytes: int | None = None):
        if not roots and not allow_empty:
            raise AgentDocumentError("At least one explicit workspace root is required")
        normalized: list[Path] = []
        aliases: list[tuple[Path, Path]] = []
        for value in roots:
            raw_root = fs_ops._clean_path_input(value, error="At least one explicit workspace root is required")
            supplied = Path(os.path.abspath(Path(raw_root).expanduser()))
            root = Path(fs_ops._clean_path_input(supplied.resolve(strict=True), error="At least one explicit workspace root is required"))
            if not root.is_dir():
                raise AgentDocumentError(f"Workspace root is not a directory: {root}")
            if root not in normalized:
                normalized.append(root)
            if supplied != root:
                aliases.append((supplied, root))
        self.roots = tuple(normalized)
        self._root_aliases = tuple(sorted(aliases, key=lambda pair: len(pair[0].parts), reverse=True))
        self._cache_lock = threading.Lock()
        self._cache: OrderedDict[tuple[int, int, int, int], fs_ops._CachedEnvelope] = OrderedDict()
        self._cache_bytes = 0
        self._max_cache_bytes = self.MAX_CACHE_BYTES if max_cache_bytes is None else max(0, max_cache_bytes)

    def resolve(self, value: str | os.PathLike[str], *, must_exist: bool = True) -> Path:
        """Resolve a caller path under one configured root; reject symlinks and hidden entries."""
        raw = Path(fs_ops._clean_path_input(value, error="Path is outside the configured workspace roots or does not exist")).expanduser()
        if not raw.is_absolute() and any(part not in (".", "..") and part.startswith(".") for part in raw.parts):
            raise AgentDocumentError("Hidden files and directories are not allowed")
        candidates = [raw] if raw.is_absolute() else [root / raw for root in self.roots]
        for candidate in candidates:
            raw_candidate = candidate
            for alias, canonical in self._root_aliases:
                if len(raw_candidate.parts) >= len(alias.parts) and raw_candidate.parts[:len(alias.parts)] == alias.parts:
                    tail = raw_candidate.parts[len(alias.parts):]
                    raw_candidate = canonical.joinpath(*tail) if tail else canonical
                    break
            absolute = Path(os.path.abspath(candidate))
            # macOS exposes /var through /private/var; preserve approved root spelling.
            for alias, canonical in self._root_aliases:
                if absolute == alias or alias in absolute.parents:
                    absolute = canonical / absolute.relative_to(alias)
                    break
            root = next((r for r in self.roots if absolute == r or r in absolute.parents), None)
            if root is None:
                continue
            if (len(raw_candidate.parts) >= len(root.parts) and raw_candidate.parts[:len(root.parts)] == root.parts
                    and any(part not in (".", "..") and part.startswith(".") for part in raw_candidate.parts[len(root.parts):])):
                raise AgentDocumentError("Hidden files and directories are not allowed")
            linked = fs_ops._symlink_component(absolute)
            if linked is not None:
                raise AgentDocumentError(f"Symlink paths are not allowed: {linked}")
            if any(part.startswith(".") for part in absolute.relative_to(root).parts):
                raise AgentDocumentError("Hidden files and directories are not allowed")
            if must_exist and not absolute.exists():
                continue
            if not must_exist and not absolute.parent.is_dir():
                continue
            try:
                resolved = absolute.resolve(strict=must_exist)
            except (OSError, RuntimeError):
                continue
            if resolved == root or root in resolved.parents:
                if any(part.startswith(".") for part in resolved.relative_to(root).parts):
                    raise AgentDocumentError("Hidden files and directories are not allowed")
                return absolute
        raise AgentDocumentError("Path is outside the configured workspace roots or does not exist")

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

    def _enforce_cache_budget_locked(self, *, preserve: fs_ops._CachedEnvelope | None = None) -> None:
        budget = max(0, self._max_cache_bytes)
        for key in list(self._cache.keys()):
            if self._cache_bytes <= budget:
                return
            if self._cache[key] is not preserve:
                self._evict_key_locked(key)
        if preserve is not None and preserve.stat_key in self._cache and self._cache_bytes > budget:
            while preserve.decoded_assets and self._cache_bytes > budget:
                _, (_, payload, _) = preserve.decoded_assets.popitem(last=False)
                preserve.decoded_bytes -= len(payload)
                self._cache_bytes -= len(payload)
            if self._cache_bytes > budget:
                self._evict_key_locked(preserve.stat_key)

    def _cache_put_locked(self, entry: fs_ops._CachedEnvelope) -> None:
        if entry.stat_key is None:
            return
        self._invalidate_path_locked(Path(entry.path_str), entry.stat_key)
        if entry.envelope_bytes > max(0, self._max_cache_bytes):
            return
        self._cache[entry.stat_key] = entry
        self._cache_bytes += entry.total_bytes
        self._enforce_cache_budget_locked(preserve=entry)

    def _cache_lookup(self, path: Path, key: tuple[int, int, int, int] | None) -> fs_ops._CachedEnvelope | None:
        if key is None:
            return None
        with self._cache_lock:
            entry = self._cache.get(key)
            if entry is None or (key[1] == 0 and entry.path_str != str(path)):
                return None
            self._cache.move_to_end(key)
            return entry

    def _load_entry(self, path: Path) -> fs_ops._CachedEnvelope:
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
        revision = _agent_documents.digest_bytes(raw)
        stable = before_stat is not None and after_stat == before_stat and len(raw) == before_stat[3]
        entry = fs_ops._CachedEnvelope(stat_key=before_stat if stable else None, path_str=str(path), text=text,
                                       assets=dict(assets), portable=portable, revision=revision, raw_size=len(raw))
        with self._cache_lock:
            if stable:
                self._cache_put_locked(entry)
            else:
                self._invalidate_path_locked(path, before_stat)
                if after_stat is not None:
                    self._evict_key_locked(after_stat)
        return entry

    def _decode_entry_asset(self, entry: fs_ops._CachedEnvelope, asset_name: str) -> tuple[str, bytes, str]:
        with self._cache_lock:
            cached = entry.decoded_assets.get(asset_name)
            if cached is not None:
                entry.decoded_assets.move_to_end(asset_name)
                if entry.stat_key is not None and self._cache.get(entry.stat_key) is entry:
                    self._cache.move_to_end(entry.stat_key)
                return cached
        mime, payload = documents.image_data(entry.assets[asset_name])
        record = (mime, payload, _agent_documents.digest_bytes(payload))
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

    def _entry_asset_metadata(self, entry: fs_ops._CachedEnvelope, *, offset: int = 0, limit: int = 50) -> list[dict]:
        result = []
        for name in list(entry.assets.keys())[offset:offset + limit]:
            try:
                mime, payload, sha256 = self._decode_entry_asset(entry, name)
                result.append(fs_ops._asset_record(name, mime, len(payload), sha256))
            except (ValueError, TypeError):
                result.append(fs_ops._asset_record(name, invalid=True))
        return result

    def _record_written_snapshot(self, path: Path, *, old_stat: tuple[int, int, int, int] | None, text: str,
                                 assets: dict[str, str], portable: bool, data: bytes, revision: str,
                                 prior_decoded: dict[str, tuple[str, bytes, str]] | None = None) -> None:
        new_stat = self._try_stat_key(path)
        can_cache = new_stat is not None and new_stat[3] == len(data) and (portable or not text.lstrip().startswith("{"))
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
                self._cache_put_locked(fs_ops._CachedEnvelope(
                    stat_key=new_stat, path_str=str(path), text=text, assets=dict(assets), portable=portable,
                    revision=revision, raw_size=len(data), decoded_bytes=decoded_bytes, decoded_assets=decoded_map))

    def _write_checked(self, path: Path, entry: fs_ops._CachedEnvelope, *, text: str, assets: dict[str, str],
                       portable: bool, expected_revision: str, conflict_msg: str,
                       extra_asset: tuple[str, str, bytes, str | None] | None = None) -> tuple[bytes, str, str | None]:
        data = fs_ops._serialize(path, text, assets, portable=portable)
        if _agent_documents.digest_bytes(self._read_raw(path)) != expected_revision:
            with self._cache_lock:
                self._invalidate_path_locked(path, entry.stat_key)
            raise RevisionConflict(conflict_msg)
        extra_sha: str | None = None
        with self._cache_lock:
            prior_decoded = dict(entry.decoded_assets)
        if extra_asset is not None:
            asset_key, mime, raw_asset, given_sha = extra_asset
            extra_sha = _agent_documents.digest_bytes(raw_asset) if given_sha is None else given_sha
            prior_decoded[asset_key] = (mime, raw_asset, extra_sha)
        fs_ops._atomic_replace(path, data)
        new_revision = _agent_documents.digest_bytes(data)
        self._record_written_snapshot(path, old_stat=entry.stat_key, text=text, assets=assets,
                                      portable=portable, data=data, revision=new_revision, prior_decoded=prior_decoded)
        return data, new_revision, extra_sha

    def _read_image_input(self, asset_path_value: str, *, size_label: str, type_label: str) -> tuple[Path, bytes, str, str]:
        asset_path = self.resolve(asset_path_value)
        if asset_path.stat().st_size > MAX_ASSET_BYTES:
            raise AgentDocumentError(f"{size_label} exceeds 25 MB")
        raw_asset = self._read_raw(asset_path)
        if len(raw_asset) > MAX_ASSET_BYTES:
            raise AgentDocumentError(f"{size_label} exceeds 25 MB")
        ext = asset_path.suffix.lower().lstrip(".")
        mime = fs_ops._asset_mime_for_name(asset_path)
        if mime is None:
            raise AgentDocumentError(f"{type_label} type must be PNG, JPEG, SVG, GIF, WebP, or AVIF")
        return asset_path, raw_asset, ext, mime

    def _load(self, path: Path) -> tuple[str, dict[str, str], bool, bytes]:
        with fs_ops._path_lock(path):
            before_stat = self._try_stat_key(path)
            cached = self._cache_lookup(path, before_stat)
            raw = self._read_raw(path)
            after_stat = self._try_stat_key(path)
            if (cached is not None and before_stat is not None and after_stat == before_stat
                    and len(raw) == cached.raw_size and _agent_documents.digest_bytes(raw) == cached.revision):
                if cached.portable:
                    try:
                        documents.validate({"format": "supermd-smd", "version": 1, "markdown": cached.text, "assets": cached.assets})
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
                    self._cache_put_locked(fs_ops._CachedEnvelope(
                        stat_key=before_stat, path_str=str(path), text=text, assets=dict(assets),
                        portable=portable, revision=_agent_documents.digest_bytes(raw), raw_size=len(raw)))
                else:
                    self._invalidate_path_locked(path, before_stat)
                    if after_stat is not None:
                        self._evict_key_locked(after_stat)
            return text, dict(assets), portable, raw

    def read_markdown(self, path_value: str) -> str:
        path = self.resolve(path_value)
        with fs_ops._path_lock(path):
            return self._load_entry(path).text

    def inspect(self, path_value: str) -> dict:
        path = self.resolve(path_value)
        with fs_ops._path_lock(path):
            entry = self._load_entry(path)
            assets = self._entry_asset_metadata(entry, limit=40)
        parse_fm = getattr(frontmatter, "parse_frontmatter", None)
        if parse_fm is not None:
            fm_end, props = parse_fm(entry.text)
            outline = (source_ops.outline_source(entry.text, _fm_end=fm_end)
                       if "_fm_end" in source_ops.outline_source.__code__.co_varnames
                       else source_ops.outline_source(frontmatter.mask_frontmatter(entry.text) if fm_end else entry.text))
        else:
            props, outline = None, source_ops.outline_source(entry.text)
        result = {
            "path": self.display_path(path), "format": "smd" if entry.portable or path.suffix.lower() == ".smd" else "markdown",
            "portable": entry.portable, "revision": entry.revision, "sha256": entry.revision, "bytes": entry.raw_size,
            "characters": len(entry.text), "lines": len(entry.text.splitlines()), "heading_count": outline["total"],
            "headings": outline["headings"], "headings_truncated": outline["truncated"],
            "next_heading_offset": outline["nextOffset"], "assets": assets, "asset_count": len(entry.assets),
        }
        if props is not None:
            result["properties"] = props
        return result

    def outline(self, path_value: str, *, offset: int = 0, limit: int = source_ops.MAX_OUTLINE_PAGE) -> dict:
        path = self.resolve(path_value)
        with fs_ops._path_lock(path):
            entry = self._load_entry(path)
        return {"path": self.display_path(path), "revision": entry.revision, **source_ops.outline_source(entry.text, offset, limit)}

    def read(self, path_value: str, *, offset: int = 0, limit: int = source_ops.MAX_PAGE_CHARS,
             heading: int | str | None = None, view: str = "prose") -> dict:
        path = self.resolve(path_value)
        with fs_ops._path_lock(path):
            entry = self._load_entry(path)
        page = source_ops.read_source(entry.text, offset=offset, limit=limit, heading=heading, view=view)
        page.pop("heading", None)
        return {"path": self.display_path(path), "revision": entry.revision, **page}

    def search(self, path_value: str, query: str, *, limit: int = 10, context: int = 100,
               offset: int = 0, case_sensitive: bool = False, whole_word: bool = False,
               regex: bool = False, exclude_diagrams: bool = False) -> dict:
        path = self.resolve(path_value)
        with fs_ops._path_lock(path):
            entry = self._load_entry(path)
        result = source_ops.search_source(
            entry.text, query, limit, context, offset, case_sensitive, whole_word, regex, exclude_diagrams)
        return {"path": self.display_path(path), "revision": entry.revision, "query": query, **result}

    def create(self, path_value: str, content: str, *, expected_absent: bool = True) -> dict:
        path = self.resolve(path_value, must_exist=False)
        if not isinstance(content, str) or len(content.encode("utf-8")) > patches.MAX_AGENT_NOTE_BYTES:
            raise AgentDocumentError("content must be UTF-8 text no larger than 20 MB")
        if path.exists():
            raise RevisionConflict("A file already exists at this path; creation never overwrites")
        portable = path.suffix.lower() == ".smd"
        data = fs_ops._serialize(path, content, {}, portable=portable)
        revision = _agent_documents.digest_bytes(data)
        with fs_ops._path_lock(path):
            if path.exists():
                raise RevisionConflict("A file was created at this path while this request was running")
            fs_ops._create_once(path, data)
            self._record_written_snapshot(path, old_stat=None, text=content, assets={}, portable=portable, data=data, revision=revision)
        return {"path": self.display_path(path), "revision": revision, "sha256": revision,
                "bytes": len(data), "characters": len(content), "created": True}

    def patch(self, path_value: str, *, expected_revision: str, operations: list[dict]) -> dict:
        path = self.resolve(path_value)
        if not expected_revision or not re.fullmatch(r"[0-9a-f]{64}", expected_revision):
            raise AgentDocumentError("expected_revision must be the 64-character SHA-256 from inspect/read")
        patches.validate_patch_operations(operations)
        with fs_ops._path_lock(path):
            entry = self._load_entry(path)
            actual = entry.revision
            if actual != expected_revision:
                raise RevisionConflict("Document changed since it was read; inspect it again before editing")
            edited, operation_results = patches.apply_patch_operations_detailed(entry.text, operations, _validated=True)
            if len(edited.encode("utf-8")) > patches.MAX_AGENT_NOTE_BYTES:
                raise AgentDocumentError("Edited Markdown exceeds the 20 MB limit")
            data, new_revision, _ = self._write_checked(
                path, entry, text=edited, assets=entry.assets, portable=entry.portable, expected_revision=expected_revision,
                conflict_msg="Document changed during the edit; no changes were saved")
        return {"path": self.display_path(path), "previous_revision": actual, "revision": new_revision, "sha256": new_revision,
                "bytes": len(data), "characters": len(edited), "operations": len(operations), "applied": len(operation_results),
                "operation_results": operation_results, "saved": True}

    def assets(self, path_value: str, *, offset: int = 0, limit: int = 50) -> dict:
        path = self.resolve(path_value)
        with fs_ops._path_lock(path):
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
        with fs_ops._path_lock(path):
            entry = self._load_entry(path)
            if entry.revision != expected_revision:
                raise RevisionConflict("Document changed since it was read; inspect again before extracting")
            if asset_name not in entry.assets:
                raise AgentDocumentError("Asset not found; call document_assets for exact names")
            try:
                mime, payload, sha256 = self._decode_entry_asset(entry, asset_name)
            except ValueError as exc:
                raise AgentDocumentError(str(exc)) from exc
            return {"asset": asset_name, "mime_type": mime, "data": payload,
                    "bytes": len(payload), "sha256": sha256, "revision": entry.revision}

    def attach_asset(self, path_value: str, asset_path_value: str, *, expected_revision: str, name: str | None = None) -> dict:
        path = self.resolve(path_value)
        asset_path, raw_asset, ext, mime = self._read_image_input(asset_path_value, size_label="Asset", type_label="Asset")
        asset_sha = _agent_documents.digest_bytes(raw_asset)
        asset_key = fs_ops._validate_asset_name(name, asset_path, mime, asset_sha, ext=ext)
        data_url = f"data:{mime};base64," + documents.encode_base64_chunked(raw_asset)
        documents._cache_validated_asset(data_url, mime, len(raw_asset))
        with fs_ops._path_lock(path):
            entry = self._load_entry(path)
            if entry.revision != expected_revision:
                raise RevisionConflict("Document changed since it was read; inspect it again before editing")
            if not entry.portable:
                raise AgentDocumentError("Attach is for portable .smd notes; create/copy as .smd to keep assets self-contained")
            if asset_key in entry.assets:
                raise AgentDocumentError(f"An asset named {asset_key} already exists; choose another name")
            _, new_revision, _ = self._write_checked(
                path, entry, text=entry.text, assets={**entry.assets, asset_key: data_url}, portable=True,
                expected_revision=expected_revision, conflict_msg="Document changed during the edit; no changes were saved",
                extra_asset=(asset_key, mime, raw_asset, asset_sha))
        return {"path": self.display_path(path), "asset": fs_ops._asset_record(asset_key, mime, len(raw_asset), asset_sha),
                "previous_revision": expected_revision, "revision": new_revision, "saved": True}

    def replace_asset(self, path_value: str, asset_id: str, asset_path_value: str, *, expected_revision: str) -> dict:
        """Replace bytes for one stable asset reference without changing note text or other assets."""
        path = self.resolve(path_value)
        _, raw_asset, _, mime = self._read_image_input(asset_path_value, size_label="Replacement asset", type_label="Replacement")
        if not isinstance(asset_id, str) or not asset_id or len(asset_id) > 256:
            raise AgentDocumentError("asset_id must be an exact ID or asset name from document_assets")
        with fs_ops._path_lock(path):
            entry = self._load_entry(path)
            revision = entry.revision
            if revision != expected_revision:
                raise RevisionConflict("Document changed since it was read; inspect again before replacing an asset")
            asset_name = fs_ops._resolve_asset_id(entry.assets, asset_id)
            if not entry.portable:
                raise AgentDocumentError("Asset replacement requires a portable .smd note")
            if documents.MIMES.get(asset_name.rsplit(".", 1)[-1].lower()) != mime:
                raise AgentDocumentError("Replacement image must keep the current asset MIME type and extension")
            try:
                old_mime, old_data, old_sha = self._decode_entry_asset(entry, asset_name)
            except ValueError as exc:
                raise AgentDocumentError(str(exc)) from exc
            if old_mime != mime:
                raise AgentDocumentError("Asset reference MIME type is inconsistent with its extension")
            if old_data == raw_asset:
                return {"path": self.display_path(path), "asset": fs_ops._asset_record(asset_name, old_mime, len(old_data), old_sha),
                        "previous_revision": revision, "revision": revision, "saved": False, "changed": False}
            new_url = f"data:{mime};base64," + documents.encode_base64_chunked(raw_asset)
            documents._cache_validated_asset(new_url, mime, len(raw_asset))
            _, new_revision, new_sha = self._write_checked(
                path, entry, text=entry.text, assets={**entry.assets, asset_name: new_url}, portable=True,
                expected_revision=expected_revision, conflict_msg="Document changed during replacement; no changes were saved",
                extra_asset=(asset_name, mime, raw_asset, None))
        return {"path": self.display_path(path), "asset": fs_ops._asset_record(asset_name, mime, len(raw_asset), new_sha),
                "previous_revision": revision, "revision": new_revision, "saved": True, "changed": True}

    def extract_asset(self, path_value: str, asset_name: str, output_value: str, *, expected_revision: str) -> dict:
        path = self.resolve(path_value)
        output = self.resolve(output_value, must_exist=False)
        if output == path:
            raise AgentDocumentError("Extraction output must be a separate path")
        with fs_ops._path_lock(path):
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
        with fs_ops._path_lock(output):
            if output.exists():
                raise RevisionConflict("Extraction never overwrites an existing file")
            fs_ops._create_once(output, payload)
        return {"path": self.display_path(output), "asset": asset_name, "bytes": len(payload),
                "sha256": sha256, "extracted": True}

    def display_path(self, path: Path) -> str:
        for root in self.roots:
            try:
                return str(path.relative_to(root))
            except ValueError:
                pass
        return str(path)


_PEER_MODULE = "agent.store" if __name__ == "desktop.agent.store" else ("desktop.agent.store" if __name__ == "agent.store" else None)
if _PEER_MODULE and _PEER_MODULE in sys.modules:
    sys.modules[__name__] = sys.modules[_PEER_MODULE]
elif "." in (__package__ or ""):
    from .. import agent_documents as _agent_documents
else:
    import agent_documents as _agent_documents
