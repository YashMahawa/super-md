"""Filesystem locks, atomic writes, note cache entries, and portable asset helpers."""
from __future__ import annotations

import hashlib
import os
import re
import stat
import sys
import tempfile
import threading
from collections import OrderedDict
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import dataclass, field
from pathlib import Path

from .source_ops import AgentDocumentError

if "." in (__package__ or ""):
    from .. import documents
else:
    import documents

MAX_ASSET_BYTES = documents.MAX_IMAGE
MAX_ENVELOPE_CACHE_BYTES = 128 * 1024 * 1024
_LOCK_GUARD = threading.Lock()
_PATH_LOCKS_GUARD = _LOCK_GUARD


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


_NoteCacheEntry = _CachedEnvelope


def digest_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


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


def _try_stat_key(path: Path) -> tuple[int, int, int, int] | None:
    try:
        info = os.stat(path, follow_symlinks=False)
    except OSError:
        return None
    if not stat.S_ISREG(info.st_mode):
        return None
    return (info.st_dev, info.st_ino, info.st_mtime_ns, info.st_size)


_file_identity = _try_stat_key


def _read_raw(path: Path) -> bytes:
    try:
        with path.open("rb") as stream:
            data = stream.read(documents.MAX_FILE + 1)
    except OSError as exc:
        raise AgentDocumentError(f"Could not read document: {exc.strerror or 'I/O error'}") from exc
    if len(data) > documents.MAX_FILE:
        raise AgentDocumentError("Document exceeds the 120 MB file limit")
    return data


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
                handle.write(b"0")
                handle.flush()
            handle.seek(0)
            msvcrt.locking(handle.fileno(), msvcrt.LK_LOCK, 1)
        else:
            import fcntl
            fcntl.flock(handle.fileno(), fcntl.LOCK_EX)
        yield
    finally:
        if os.name == "nt":
            import msvcrt
            handle.seek(0)
            msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
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
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        if _symlink_component(path) is not None:
            raise AgentDocumentError("Refusing to replace a symlink path")
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


_atomic_write_bytes = _atomic_replace


def _atomic_write_text(path: Path, text: str) -> None:
    _atomic_replace(path, text.encode())


def _create_once(path: Path, data: bytes) -> None:
    handle, temporary = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".agent-new", dir=path.parent)
    try:
        with os.fdopen(handle, "wb") as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        if _symlink_component(path) is not None:
            raise AgentDocumentError("Refusing to create through a symlink path")
        os.link(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def _asset_mime_for_name(name_or_path: str | Path) -> str | None:
    return documents.MIMES.get(Path(name_or_path).suffix.lower().lstrip("."))


def _validate_asset_name(name: str | None, asset_path: Path, mime: str, asset_sha: str, *, ext: str) -> str:
    filename = name or asset_path.name
    if name is None and not documents.is_valid_asset_filename(filename):
        stem = re.sub(r"[^A-Za-z0-9._-]+", "-", Path(filename).stem).strip(".-_") or "asset"
        filename = f"{stem[:120]}-{asset_sha[:8]}{Path(filename).suffix}"
    if not documents.is_valid_asset_filename(filename):
        raise AgentDocumentError("Asset name must be a simple filename (letters, digits, dot, underscore, hyphen)")
    named_ext = Path(filename).suffix.lower().lstrip(".")
    if not named_ext:
        filename += "." + ext
        if not documents.is_valid_asset_filename(filename):
            raise AgentDocumentError("Asset name must be a simple filename (letters, digits, dot, underscore, hyphen)")
    elif documents.MIMES.get(named_ext) != mime:
        raise AgentDocumentError("Asset name extension must match the image type")
    return "assets/" + filename


def _asset_record(name: str, mime: str | None = None, size: int | None = None,
                  sha256: str | None = None, *, invalid: bool = False) -> dict:
    record: dict[str, object] = {"id": hashlib.sha256(name.encode()).hexdigest(), "name": name,
                                 "mime": mime, "bytes": size, "sha256": sha256}
    if invalid:
        record["invalid"] = True
    return record


def _resolve_asset_id(assets: dict[str, str], asset_id: str) -> str:
    if asset_id in assets:
        return asset_id
    matches = [name for name in assets if hashlib.sha256(name.encode()).hexdigest() == asset_id]
    if len(matches) != 1:
        raise AgentDocumentError("Asset ID is not present in the current document")
    return matches[0]


_PEER_MODULE = (
    "agent.fs_ops"
    if __name__ == "desktop.agent.fs_ops"
    else ("desktop.agent.fs_ops" if __name__ == "agent.fs_ops" else None)
)
if _PEER_MODULE and _PEER_MODULE in sys.modules:
    sys.modules[__name__] = sys.modules[_PEER_MODULE]
