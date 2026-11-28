"""Shared atomic file replacement and streamed JSON output without Qt dependencies."""
from collections.abc import Callable, Iterator
import contextlib
import json
import os
from pathlib import Path
import stat
import tempfile
import threading
import time
from typing import BinaryIO

JSON_WRITE_CHUNK = 262_144  # 256 KiB

_is_trusted_ascii: Callable[[str], bool] = lambda _text: False
_ATOMIC_JSON_STAGE_TLS = threading.local()


def set_trusted_ascii_predicate(predicate: Callable[[str], bool] | None) -> None:
    """Register an optional fast-path predicate for validated ASCII strings."""
    global _is_trusted_ascii
    _is_trusted_ascii = (lambda _text: False) if predicate is None else predicate


def _replace_with_windows_sharing_retry(source: str, target: Path) -> None:
    """Preserve atomic replacement despite brief Windows AV/indexer file locks.

    Only transient sharing/access-denied errors are retried, for at most one
    second. Other errors fail immediately and the caller cleans up its temp.
    """
    if os.name != "nt":
        os.replace(source, target)
        return
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


def _stage_target_key(path: Path | str) -> str:
    try:
        resolved = os.path.realpath(os.path.abspath(os.fspath(path)))
    except OSError:
        resolved = os.path.abspath(os.fspath(path))
    if os.name == "nt":
        if resolved.startswith("\\\\?\\UNC\\"):
            resolved = "\\\\" + resolved[8:]
        elif resolved.startswith("\\\\?\\"):
            resolved = resolved[4:]
    return os.path.normcase(os.path.normpath(resolved))


class _StagedAtomicJsonScope:
    """Defer the final atomic rename of ``target_path`` until the caller commits."""

    def __init__(self, target_path: Path, abort_check=None, *, replace_fn=_replace_with_windows_sharing_retry):
        self.target = Path(os.path.abspath(os.fspath(target_path)))
        self.target_key = _stage_target_key(target_path)
        self.abort_check = abort_check
        self.intercepted = False
        self.temporary: str | None = None
        self._previous = None
        self._replace_fn = replace_fn

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
            self._replace_fn(temp, destination or self.target)
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


def stage_atomic_json(
    target_path: Path,
    *,
    abort_check=None,
    replace_fn=_replace_with_windows_sharing_retry,
) -> _StagedAtomicJsonScope:
    return _StagedAtomicJsonScope(target_path, abort_check=abort_check, replace_fn=replace_fn)


@contextlib.contextmanager
def atomic_output_file(
    path: Path,
    *,
    buffering: int = -1,
    _staged_scope: _StagedAtomicJsonScope | None = None,
    replace_fn=_replace_with_windows_sharing_retry,
) -> Iterator[BinaryIO]:
    """Yield a sibling temp binary stream and atomically replace `path` on clean exit."""
    target = path if isinstance(path, Path) else Path(path)
    handle, temporary = tempfile.mkstemp(prefix=f".{target.name}.", suffix=".tmp", dir=target.parent)
    handed_off = False
    try:
        try:
            raw = os.fdopen(handle, "wb", buffering=buffering)
        except BaseException:
            os.close(handle)
            raise
        with raw:
            if os.name != "nt" and hasattr(os, "fchmod"):
                try:
                    st_mode = target.stat().st_mode
                except FileNotFoundError:
                    pass
                else:
                    os.fchmod(raw.fileno(), stat.S_IMODE(st_mode))
            yield raw
            raw.flush()
            os.fsync(raw.fileno())
        if _staged_scope is not None:
            _staged_scope.temporary = temporary
            handed_off = True
            return
        replace_fn(temporary, target)
    finally:
        if not handed_off and os.path.exists(temporary):
            os.unlink(temporary)


def atomic_write(path: Path, data: bytes, *, replace_fn=_replace_with_windows_sharing_retry) -> None:
    # Same-filesystem replace is atomic; a cancelled/failed write leaves the old note intact.
    with atomic_output_file(path, replace_fn=replace_fn) as file:
        file.write(data)


def _write_json_str(raw, text: str) -> None:
    if type(text) is str and _is_trusted_ascii(text):
        raw.write(b'"')
        for offset in range(0, len(text), JSON_WRITE_CHUNK):
            raw.write(text[offset:offset + JSON_WRITE_CHUNK].encode("ascii"))
        raw.write(b'"')
        return
    if len(text) <= JSON_WRITE_CHUNK:
        raw.write(json.dumps(text, ensure_ascii=False).encode("utf-8", errors="backslashreplace"))
        return
    plain = text if type(text) is str else str(text)
    raw.write(b'"')
    for offset in range(0, len(plain), JSON_WRITE_CHUNK):
        chunk = json.dumps(plain[offset:offset + JSON_WRITE_CHUNK], ensure_ascii=False)[1:-1]
        raw.write(chunk.encode("utf-8", errors="backslashreplace"))
    raw.write(b'"')


def _write_json_value(raw, value, seen: set[int], *, write_str=_write_json_str, write_value=None) -> None:
    if isinstance(value, str):
        write_str(raw, value)
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
        write_val = _write_json_value if write_value is None else write_value
        try:
            raw.write(b"[")
            for idx, item in enumerate(value):
                if idx:
                    raw.write(b", ")
                write_val(raw, item, seen)
            raw.write(b"]")
        finally:
            seen.remove(marker)
    elif isinstance(value, dict):
        marker = id(value)
        if marker in seen:
            raise ValueError("Circular reference detected")
        seen.add(marker)
        write_val = _write_json_value if write_value is None else write_value
        try:
            raw.write(b"{")
            first = True
            for key, item in value.items():
                if not first:
                    raw.write(b", ")
                first = False
                if isinstance(key, str):
                    write_str(raw, key)
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
                write_val(raw, item, seen)
            raw.write(b"}")
        finally:
            seen.remove(marker)
    else:
        raise TypeError(f"Object of type {type(value).__name__} is not JSON serializable")


def atomic_json(
    path: Path,
    value,
    *,
    write_value=_write_json_value,
    replace_fn=_replace_with_windows_sharing_retry,
) -> None:
    """Write ordered recovery without full-workspace JSON + UTF-8 copies or long GIL holds."""
    path_obj = path if isinstance(path, Path) else Path(path)
    stage_scope = getattr(_ATOMIC_JSON_STAGE_TLS, "active", None)
    capture_stage = (
        stage_scope is not None
        and not stage_scope.intercepted
        and _stage_target_key(path_obj) == stage_scope.target_key
    )
    if capture_stage:
        stage_scope.intercepted = True
        if callable(stage_scope.abort_check) and stage_scope.abort_check():
            return
    with atomic_output_file(
        path_obj,
        buffering=JSON_WRITE_CHUNK,
        _staged_scope=stage_scope if capture_stage else None,
        replace_fn=replace_fn,
    ) as file:
        write_value(file, value, set())
