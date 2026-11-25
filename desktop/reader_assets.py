"""Scoped Qt WebEngine raster capabilities for native reader images."""
from __future__ import annotations

import hashlib
import os
import re
import secrets
import threading
import urllib.parse
from collections import OrderedDict
from dataclasses import dataclass
from pathlib import Path
from typing import Callable

from PySide6.QtCore import QByteArray, QBuffer, QFile, QIODevice, QUrlQuery
from PySide6.QtWebEngineCore import QWebEngineUrlRequestJob, QWebEngineUrlSchemeHandler

from documents import MAX_IMAGE, MIMES, image_data

SCHEME = "supermdasset"
TOKEN = re.compile(r"^[a-f0-9]{32}$")
FINGERPRINT = re.compile(r"^[a-f0-9]{64}$")
RASTER_MIMES = frozenset(("image/png", "image/jpeg", "image/gif", "image/webp", "image/avif"))


@dataclass(frozen=True)
class AssetGrant:
    owner_id: str
    tab_id: str
    source: str
    fingerprint: str
    mime: str
    path: str = ""
    embedded_identity: int = 0
    size: int = 0
    mtime_ns: int = 0
    inode: int = 0


def _file_identity(path: Path) -> tuple[int, int, int]:
    info = path.stat()
    if not path.is_file() or info.st_size > MAX_IMAGE:
        raise ValueError("Image is missing or exceeds 25 MB")
    return info.st_size, info.st_mtime_ns, getattr(info, "st_ino", 0)


def note_file_path(tab: dict, source: str) -> Path:
    note_path = tab.get("path")
    if not note_path:
        raise ValueError("Save this note to resolve relative images")
    root = Path(note_path).parent.resolve()
    candidate = (root / urllib.parse.unquote(source)).resolve()
    if not candidate.is_relative_to(root):
        raise ValueError("Image is outside the note folder")
    return candidate


def resolve_source(tab: dict, source: str) -> dict:
    """Resolve and hash a note-owned raster on a worker thread."""
    if not isinstance(source, str) or not source or len(source) > 4096:
        raise ValueError("Invalid image source")
    embedded = tab.get("assets", {}).get(source)
    if embedded is not None:
        mime, payload = image_data(embedded)
        if mime not in RASTER_MIMES:
            raise ValueError("Only raster images can use the streamed reader transport")
        return {"mime": mime, "fingerprint": hashlib.sha256(payload).hexdigest(), "embedded_data": embedded,
                "payload": payload, "size": len(payload)}
    candidate = note_file_path(tab, source)
    mime = MIMES.get(candidate.suffix[1:].lower())
    if mime not in RASTER_MIMES:
        raise ValueError("Only raster images can use the streamed reader transport")
    before = _file_identity(candidate)
    digest = hashlib.sha256()
    count = 0
    with candidate.open("rb") as stream:
        while True:
            chunk = stream.read(1024 * 1024)
            if not chunk:
                break
            count += len(chunk)
            if count > MAX_IMAGE:
                raise ValueError("Image exceeds 25 MB")
            digest.update(chunk)
    after = _file_identity(candidate)
    if before != after or count != before[0]:
        raise ValueError("Image changed while it was being resolved")
    return {"mime": mime, "fingerprint": digest.hexdigest(), "path": str(candidate),
            "size": before[0], "mtime_ns": before[1], "inode": before[2]}


class ReaderAssetStore:
    """Opaque per-note capabilities; validation callback checks live ownership."""

    MAX_CAPABILITIES = 1024
    MAX_PAYLOAD_BYTES = 80 * 1024 * 1024

    def __init__(self, is_current: Callable[[AssetGrant], bool], embedded_payload: Callable[[AssetGrant], str | None]):
        self._is_current = is_current
        self._embedded_payload = embedded_payload
        self._lock = threading.RLock()
        self._grants: OrderedDict[str, AssetGrant] = OrderedDict()
        self._by_asset: dict[tuple[str, str, str, str], str] = {}
        self._by_source: dict[tuple[str, str, str], str] = {}
        self._payloads: OrderedDict[str, bytes] = OrderedDict()
        self._payload_bytes = 0

    def __len__(self):
        with self._lock:
            return len(self._grants)

    @property
    def cached_bytes(self) -> int:
        with self._lock:
            for stale_token, stale_grant in list(self._grants.items()):
                if not self._is_current(stale_grant):
                    self._drop(stale_token)
            return self._payload_bytes

    def _drop(self, token: str) -> None:
        payload = self._payloads.pop(token, None)
        if payload is not None:
            self._payload_bytes -= len(payload)
        grant = self._grants.pop(token, None)
        if grant:
            key = (grant.owner_id, grant.tab_id, grant.source, grant.fingerprint)
            if self._by_asset.get(key) == token:
                self._by_asset.pop(key, None)
            source_key = (grant.owner_id, grant.tab_id, grant.source)
            if self._by_source.get(source_key) == token:
                self._by_source.pop(source_key, None)

    def _evict_grant(self, grant: AssetGrant) -> None:
        key = (grant.owner_id, grant.tab_id, grant.source, grant.fingerprint)
        token = self._by_asset.get(key)
        if token is not None:
            self._drop(token)
            return
        for candidate_token, candidate_grant in list(self._grants.items()):
            if candidate_grant == grant:
                self._drop(candidate_token)

    def _store_payload(self, token: str, payload: bytes) -> None:
        old = self._payloads.pop(token, None)
        if old is not None:
            self._payload_bytes -= len(old)
        max_bytes = max(0, self.MAX_PAYLOAD_BYTES)
        if len(payload) > max_bytes:
            return
        if self._payload_bytes + len(payload) > max_bytes:
            for stale_token, stale_grant in list(self._grants.items()):
                if stale_token != token and not self._is_current(stale_grant):
                    self._drop(stale_token)
        while self._payloads and self._payload_bytes + len(payload) > max_bytes:
            _, evicted = self._payloads.popitem(last=False)
            self._payload_bytes -= len(evicted)
        self._payloads[token] = payload
        self._payload_bytes += len(payload)

    def evict_source(self, owner_id: str, tab_id: str, source: str) -> None:
        with self._lock:
            token = self._by_source.get((owner_id, tab_id, source))
            if token is not None:
                self._drop(token)
            for candidate_token, grant in list(self._grants.items()):
                if (grant.owner_id, grant.tab_id, grant.source) == (owner_id, tab_id, source):
                    self._drop(candidate_token)

    def resolve_cached(self, owner_id: str, tab_id: str, source: str, embedded_data: str | None) -> dict | None:
        if not isinstance(embedded_data, str):
            return None
        with self._lock:
            token = self._by_source.get((owner_id, tab_id, source))
            if token is None:
                return None
            grant = self._grants.get(token)
            if grant is None or grant.path or grant.embedded_identity != id(embedded_data) or not self._is_current(grant):
                self._drop(token)
                return None
            self._grants.move_to_end(token)
            if token in self._payloads:
                self._payloads.move_to_end(token)
            return {"mime": grant.mime, "fingerprint": grant.fingerprint,
                    "embedded_data": embedded_data, "size": grant.size}

    def register(self, owner_id: str, tab_id: str, source: str, resolved: dict) -> str | None:
        if not isinstance(source, str) or not source or len(source) > 4096:
            raise ValueError("Invalid reader asset source")
        mime = resolved.get("mime")
        fingerprint = resolved.get("fingerprint")
        if mime not in RASTER_MIMES or not isinstance(fingerprint, str) or not FINGERPRINT.fullmatch(fingerprint):
            raise ValueError("Invalid raster asset metadata")
        payload = resolved.get("payload")
        with self._lock:
            source_key = (owner_id, tab_id, source)
            previous_for_source = self._by_source.get(source_key)
            if previous_for_source is not None:
                previous_grant = self._grants.get(previous_for_source)
                if previous_grant is None or previous_grant.fingerprint != fingerprint or not self._is_current(previous_grant):
                    self._drop(previous_for_source)
            key = (owner_id, tab_id, source, fingerprint)
            existing = self._by_asset.get(key)
            if existing and self.lookup(existing, fingerprint):
                if isinstance(payload, bytes) and existing not in self._payloads and len(payload) == resolved["size"]:
                    self._store_payload(existing, payload)
                return f"{SCHEME}://{existing}?v={fingerprint}"
            if existing:
                self._drop(existing)
            if len(self._grants) >= self.MAX_CAPABILITIES:
                for stale_token, stale_grant in list(self._grants.items()):
                    if not self._is_current(stale_grant):
                        self._drop(stale_token)
            if len(self._grants) >= self.MAX_CAPABILITIES:
                # Keep already-rendered URLs live. Caller gets null and uses the
                # legacy bounded data-URL loader for this newly requested image.
                return None
            grant = AssetGrant(owner_id=owner_id, tab_id=tab_id, source=source,
                               fingerprint=fingerprint, mime=mime, path=resolved.get("path", ""),
                               embedded_identity=id(resolved["embedded_data"]) if resolved.get("embedded_data") else 0,
                               size=resolved["size"],
                               mtime_ns=resolved.get("mtime_ns", 0), inode=resolved.get("inode", 0))
            token = secrets.token_hex(16)
            self._grants[token] = grant
            self._by_asset[key] = token
            self._by_source[source_key] = token
            if isinstance(payload, bytes) and not grant.path and len(payload) == grant.size:
                self._store_payload(token, payload)
            return f"{SCHEME}://{token}?v={fingerprint}"

    def lookup(self, token: str, fingerprint: str) -> AssetGrant | None:
        if not TOKEN.fullmatch(token) or not FINGERPRINT.fullmatch(fingerprint):
            return None
        with self._lock:
            grant = self._grants.get(token)
            if grant is None or grant.fingerprint != fingerprint:
                return None
            if not self._is_current(grant):
                self._drop(token)
                return None
            if grant.path:
                try:
                    if _file_identity(Path(grant.path)) != (grant.size, grant.mtime_ns, grant.inode):
                        self._drop(token)
                        return None
                except (OSError, ValueError):
                    self._drop(token)
                    return None
            self._grants.move_to_end(token)
            if token in self._payloads:
                self._payloads.move_to_end(token)
            return grant

    def revoke_tab(self, owner_id: str, tab_id: str) -> None:
        with self._lock:
            for token, grant in list(self._grants.items()):
                if (grant.owner_id, grant.tab_id) == (owner_id, tab_id):
                    self._drop(token)

    def revoke_owner(self, owner_id: str) -> None:
        with self._lock:
            for token, grant in list(self._grants.items()):
                if grant.owner_id == owner_id:
                    self._drop(token)

    def open_payload(self, grant: AssetGrant) -> QIODevice:
        if grant.path:
            flags = os.O_RDONLY | getattr(os, "O_BINARY", 0) | getattr(os, "O_NOFOLLOW", 0)
            descriptor = os.open(grant.path, flags)
            try:
                info = os.fstat(descriptor)
                identity = (info.st_size, info.st_mtime_ns, getattr(info, "st_ino", 0))
                if identity != (grant.size, grant.mtime_ns, grant.inode):
                    raise ValueError("Image changed before it could be opened")
                device = QFile()
                if not device.open(descriptor, QIODevice.OpenModeFlag.ReadOnly, QFile.FileHandleFlag.AutoCloseHandle):
                    raise ValueError("Image is no longer available")
                descriptor = -1  # QFile now owns the descriptor through the request job.
            finally:
                if descriptor >= 0:
                    os.close(descriptor)
            return device
        payload: bytes | None = None
        with self._lock:
            if not self._is_current(grant):
                self._evict_grant(grant)
                raise ValueError("Embedded image changed")
            embedded_data = self._embedded_payload(grant)
            if embedded_data is None:
                self._evict_grant(grant)
                raise ValueError("Embedded image changed")
            key = (grant.owner_id, grant.tab_id, grant.source, grant.fingerprint)
            token = self._by_asset.get(key)
            if token is not None and self._grants.get(token) == grant:
                cached = self._payloads.get(token)
                if cached is not None:
                    if len(cached) != grant.size:
                        self._drop(token)
                        raise ValueError("Embedded image changed")
                    self._payloads.move_to_end(token)
                    payload = cached
        if payload is None:
            mime, decoded = image_data(embedded_data)
            if mime != grant.mime or len(decoded) != grant.size:
                with self._lock:
                    self._evict_grant(grant)
                raise ValueError("Embedded image changed")
            payload = decoded
            with self._lock:
                if self._is_current(grant) and self._embedded_payload(grant) is not None:
                    key = (grant.owner_id, grant.tab_id, grant.source, grant.fingerprint)
                    token = self._by_asset.get(key)
                    if token is not None and self._grants.get(token) == grant:
                        self._store_payload(token, payload)
        device = QBuffer()
        device.setData(QByteArray(payload))
        if not device.open(QIODevice.OpenModeFlag.ReadOnly):
            raise ValueError("Could not open image stream")
        return device


class ReaderAssetSchemeHandler(QWebEngineUrlSchemeHandler):
    """Streams only a registered token's raster bytes to WebEngine."""

    def __init__(self, store: ReaderAssetStore, parent=None):
        super().__init__(parent)
        self._store = store

    def requestStarted(self, job):  # noqa: N802 - Qt virtual method
        url = job.requestUrl()
        query = QUrlQuery(url)
        values = query.allQueryItemValues("v")
        valid = (url.scheme() == SCHEME and not url.userInfo() and url.port() == -1 and
                 url.path() in ("", "/") and not url.fragment() and
                 query.queryItems() and len(query.queryItems()) == 1 and len(values) == 1 and
                 bytes(job.requestMethod()).upper() == b"GET")
        grant = self._store.lookup(url.host(), values[0] if valid else "") if valid else None
        if grant is None:
            job.fail(QWebEngineUrlRequestJob.Error.RequestDenied)
            return
        try:
            device = self._store.open_payload(grant)
            device.setParent(job)
            job.reply(grant.mime.encode("ascii"), device)
        except (OSError, ValueError):
            job.fail(QWebEngineUrlRequestJob.Error.RequestFailed)
