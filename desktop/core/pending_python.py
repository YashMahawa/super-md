"""Short-lived proofs for retrying failed contextual Python-output writes.

Only digests are retained here. This deliberately does not persist output or
decide whether a result should be executed; the caller records a proof only
after a native contextual run fails to save its result.
"""
from collections import OrderedDict
from hashlib import sha256
from threading import RLock
import time


_CONTEXT_FIELDS = ("document", "cell", "interpreter")
_RESULT_FIELDS = ("stdout", "stderr", "images", "ok")
_TEXT_CHUNK_CHARS = 4096


def _update_text(digest, label: str, value: str) -> None:
    """Hash a framed string without creating a second full-size UTF-8 copy."""
    digest.update(label.encode("ascii"))
    byte_length = 0
    for start in range(0, len(value), _TEXT_CHUNK_CHARS):
        byte_length += len(value[start:start + _TEXT_CHUNK_CHARS].encode("utf-8"))
    digest.update(str(byte_length).encode("ascii"))
    digest.update(b":")
    for start in range(0, len(value), _TEXT_CHUNK_CHARS):
        digest.update(value[start:start + _TEXT_CHUNK_CHARS].encode("utf-8"))


def _source_digest(source) -> str:
    if not isinstance(source, str):
        raise ValueError("Python source must be text")
    digest = sha256()
    _update_text(digest, "source:", source)
    return digest.hexdigest()


def _context_digest(context) -> str:
    if not isinstance(context, dict) or set(context) != set(_CONTEXT_FIELDS):
        raise ValueError("Python output context must contain document, cell, and interpreter")
    digest = sha256()
    for field in _CONTEXT_FIELDS:
        value = context[field]
        if not isinstance(value, str) or not value:
            raise ValueError("Python output context values must be non-empty text")
        _update_text(digest, field + ":", value)
    return digest.hexdigest()


def _result_digest(result) -> str:
    if not isinstance(result, dict):
        raise ValueError("Python output must be an object")
    if set(result) not in (set(_RESULT_FIELDS), set(_RESULT_FIELDS) | {"provenance"}):
        raise ValueError("Python output has unexpected fields")
    digest = sha256()
    for field in ("stdout", "stderr"):
        value = result[field]
        if not isinstance(value, str):
            raise ValueError("Python output text fields must be strings")
        _update_text(digest, field + ":", value)
    images = result["images"]
    if not isinstance(images, list) or any(not isinstance(image, str) for image in images):
        raise ValueError("Python output images must be a list of strings")
    digest.update(b"images:")
    digest.update(str(len(images)).encode("ascii"))
    digest.update(b":")
    for image in images:
        _update_text(digest, "image:", image)
    if not isinstance(result["ok"], bool):
        raise ValueError("Python output status must be boolean")
    digest.update(b"ok:1" if result["ok"] else b"ok:0")
    return digest.hexdigest()


class PendingPythonProofs:
    """Thread-safe bounded store of exact source/context/result digest proofs."""

    def __init__(self, clock=time.monotonic, max_entries=64, ttl_seconds=600):
        if not isinstance(max_entries, int) or max_entries < 1:
            raise ValueError("max_entries must be a positive integer")
        if not isinstance(ttl_seconds, (int, float)) or ttl_seconds <= 0:
            raise ValueError("ttl_seconds must be positive")
        self._clock = clock
        self._max_entries = max_entries
        self._ttl_seconds = float(ttl_seconds)
        self._entries = OrderedDict()
        self._lock = RLock()

    def _expire(self, now):
        expired = [key for key, entry in self._entries.items() if now - entry[0] >= self._ttl_seconds]
        for key in expired:
            self._entries.pop(key, None)

    @staticmethod
    def _key(source, context):
        return _source_digest(source), _context_digest(context)

    def remember(self, source, result, context):
        key = self._key(source, context)
        result_digest = _result_digest(result)
        now = self._clock()
        with self._lock:
            self._expire(now)
            self._entries.pop(key, None)
            self._entries[key] = (now, result_digest)
            while len(self._entries) > self._max_entries:
                self._entries.popitem(last=False)

    def matches(self, source, result, context):
        key = self._key(source, context)
        result_digest = _result_digest(result)
        now = self._clock()
        with self._lock:
            self._expire(now)
            entry = self._entries.get(key)
            if entry is None:
                return False
            self._entries.move_to_end(key)
            return entry[1] == result_digest

    def forget(self, source, context):
        key = self._key(source, context)
        with self._lock:
            self._expire(self._clock())
            self._entries.pop(key, None)

    def clear(self):
        with self._lock:
            self._entries.clear()


_default_proofs = PendingPythonProofs()


def remember(source, result, context):
    """Record a proof after a contextual output write fails."""
    _default_proofs.remember(source, result, context)


def matches(source, result, context):
    """Return whether a retry exactly matches a recorded native result."""
    return _default_proofs.matches(source, result, context)


def forget(source, context):
    _default_proofs.forget(source, context)


def clear():
    _default_proofs.clear()
