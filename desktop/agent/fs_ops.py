"""Symlink guards, envelope caching, bundle serialization, locks, and atomic writes."""
from __future__ import annotations

import hashlib
import os
import stat
import sys
import tempfile
import threading
from collections import OrderedDict
from contextlib import contextmanager
from dataclasses import dataclass, field
from pathlib import Path
from typing import Iterator

try:
    from .. import documents
except ImportError:
    import documents

try:
    from .source_ops import AgentDocumentError
except ImportError:
    from agent.source_ops import AgentDocumentError

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
            asset_bytes = sum(sys.getsizeof(k) + sys.getsizeof(v) for k, v in self.assets.items())
            self.envelope_bytes = sys.getsizeof(self.text) + sys.getsizeof(self.revision) + asset_bytes

    @property
    def total_bytes(self) -> int:
        return self.envelope_bytes + self.decoded_bytes


class _EnvelopeCache:
    """Byte-bounded LRU cache for stat-verified note envelopes and decoded assets."""

    _cache_lock: threading.Lock
    _cache: OrderedDict[tuple[int, int, int, int], _CachedEnvelope]
    _cache_bytes: int
    _max_cache_bytes: int

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

    def _cache_put_locked(self, entry: _CachedEnvelope) -> None:
        if entry.stat_key is None:
            return
        self._invalidate_path_locked(Path(entry.path_str), entry.stat_key)
        if entry.envelope_bytes > max(0, self._max_cache_bytes):
            return
        self._cache[entry.stat_key] = entry
        self._cache_bytes += entry.total_bytes
        self._enforce_cache_budget_locked(preserve=entry)

    def _cache_lookup(self, path: Path, key: tuple[int, int, int, int] | None) -> _CachedEnvelope | None:
        if key is None:
            return None
        with self._cache_lock:
            entry = self._cache.get(key)
            if entry is None or (key[1] == 0 and entry.path_str != str(path)):
                return None
            self._cache.move_to_end(key)
            return entry

    def _record_written_snapshot(
        self, path: Path, *, old_stat: tuple[int, int, int, int] | None, text: str,
        assets: dict[str, str], portable: bool, data: bytes, revision: str,
        prior_decoded: dict[str, tuple[str, bytes, str]] | None = None,
    ) -> None:
        new_stat = self._try_stat_key(path)
        can_cache = (new_stat is not None and new_stat[3] == len(data)
                     and (portable or not text.lstrip().startswith("{")))
        decoded_map = OrderedDict(
            (name, rec) for name, rec in (prior_decoded or {}).items() if can_cache and name in assets
        )
        decoded_bytes = sum(len(rec[1]) for rec in decoded_map.values())
        with self._cache_lock:
            self._invalidate_path_locked(path, old_stat)
            if can_cache:
                self._cache_put_locked(_CachedEnvelope(
                    stat_key=new_stat, path_str=str(path), text=text, assets=dict(assets),
                    portable=portable, revision=revision, raw_size=len(data),
                    decoded_bytes=decoded_bytes, decoded_assets=decoded_map,
                ))


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


def _read_raw(path: Path) -> bytes:
    try:
        with path.open("rb") as stream:
            data = stream.read(documents.MAX_FILE + 1)
    except OSError as exc:
        raise AgentDocumentError(f"Could not read document: {exc.strerror or 'I/O error'}") from exc
    if len(data) > documents.MAX_FILE:
        raise AgentDocumentError("Document exceeds the 120 MB file limit")
    return data


def _try_stat_key(path: Path) -> tuple[int, int, int, int] | None:
    try:
        info = os.stat(path, follow_symlinks=False)
    except OSError:
        return None
    return (info.st_dev, info.st_ino, info.st_mtime_ns, info.st_size) if stat.S_ISREG(info.st_mode) else None


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
