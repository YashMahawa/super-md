"""Vault-free workspace note link resolution with bounded, cached in-memory scanning."""
from __future__ import annotations

import os
import re
import threading
import time
import urllib.parse
from dataclasses import dataclass
from pathlib import Path, PurePosixPath

NOTE_EXTENSIONS = (".md", ".smd", ".fmd", ".markdown", ".txt")
_EXTENSION_PRIORITY = {ext: idx for idx, ext in enumerate(NOTE_EXTENSIONS)}
_ENCODED_SEP = re.compile(r"%2f|%5c", re.IGNORECASE)

MAX_SCAN_FILES = 8_000
MAX_SCAN_DIRS = 2_500
MAX_SCAN_DEPTH = 16
CACHE_TTL_SECONDS = 5.0


class WorkspaceLinkError(ValueError):
    """User-facing non-destructive link resolution error."""


def _is_macos_alias_file(path: Path) -> bool:
    if os.name != "posix" or not hasattr(os, "getxattr"):
        return False
    try:
        finder_info = os.getxattr(path, "com.apple.FinderInfo", follow_symlinks=False)
        if len(finder_info) >= 10 and (finder_info[8] & 0x80):
            return True
    except OSError:
        pass
    try:
        if path.is_file():
            with path.open("rb") as handle:
                if handle.read(16) == b"book\x00\x00\x00\x00mark\x00\x00\x00\x00":
                    return True
    except OSError:
        pass
    return False


def _is_link_or_junction(path: Path) -> bool:
    try:
        if path.is_symlink():
            return True
        is_junction = getattr(path, "is_junction", None)
        if callable(is_junction) and is_junction():
            return True
    except OSError:
        return False
    return _is_macos_alias_file(path)


def _is_entry_link_or_junction(entry: os.DirEntry[str]) -> bool:
    try:
        if entry.is_symlink():
            return True
    except OSError:
        return True
    return _is_link_or_junction(Path(entry.path))


def _has_symlink_within(boundary: Path, candidate: Path) -> bool:
    try:
        parts = candidate.relative_to(boundary).parts
    except ValueError:
        return True
    current = boundary
    for part in parts:
        current = current / part
        if _is_link_or_junction(current):
            return True
    return False


@dataclass(frozen=True)
class IndexedNote:
    path: Path
    rel_posix: str
    name: str
    name_fold: str
    stem: str
    stem_fold: str
    no_ext_posix: str
    no_ext_fold: str
    depth: int
    ext_rank: int


@dataclass
class _CachedScan:
    root: Path
    root_mtime_ns: int
    scanned_at: float
    entries: tuple[IndexedNote, ...]
    truncated: bool


class WorkspaceLinkCache:
    """Thread-safe bounded in-memory note index. Writes zero files to disk."""

    def __init__(self, *, max_files: int = MAX_SCAN_FILES, max_dirs: int = MAX_SCAN_DIRS,
                 max_depth: int = MAX_SCAN_DEPTH, ttl_seconds: float = CACHE_TTL_SECONDS):
        self.max_files = max_files
        self.max_dirs = max_dirs
        self.max_depth = max_depth
        self.ttl_seconds = ttl_seconds
        self._lock = threading.Lock()
        self._entries: dict[str, _CachedScan] = {}

    def invalidate(self, folder: str | os.PathLike[str] | None = None) -> None:
        with self._lock:
            if folder is None or not str(folder):
                self._entries.clear()
                return
            try:
                key = str(Path(os.path.abspath(Path(folder).expanduser())).resolve())
            except OSError:
                key = str(folder)
            self._entries.pop(key, None)

    def scan(self, boundary: Path | str | os.PathLike[str]) -> tuple[IndexedNote, ...]:
        boundary = _resolve_clean_directory(boundary, "workspace folder")
        key = str(boundary)
        now = time.monotonic()
        try:
            root_mtime_ns = boundary.stat(follow_symlinks=False).st_mtime_ns
        except OSError as exc:
            raise WorkspaceLinkError("Workspace folder is unavailable.") from exc

        with self._lock:
            cached = self._entries.get(key)
            if (cached is not None
                    and cached.root_mtime_ns == root_mtime_ns
                    and (now - cached.scanned_at) <= self.ttl_seconds):
                return cached.entries

        collected: list[IndexedNote] = []
        visited_dirs = 0
        truncated = False
        stack: list[tuple[Path, str, int]] = [(boundary, "", 0)]

        while stack:
            current_dir, rel_prefix, depth = stack.pop()
            visited_dirs += 1
            if visited_dirs > self.max_dirs:
                truncated = True
                break
            try:
                with os.scandir(current_dir) as iterator:
                    dir_entries = sorted(iterator, key=lambda e: e.name.casefold())
            except OSError:
                continue

            subdirs: list[tuple[Path, str, int]] = []
            for entry in dir_entries:
                name = entry.name
                if not name or name.startswith("."):
                    continue
                try:
                    if _is_entry_link_or_junction(entry):
                        continue
                    is_dir = entry.is_dir(follow_symlinks=False)
                    is_file = not is_dir and entry.is_file(follow_symlinks=False)
                except OSError:
                    continue

                rel_posix = f"{rel_prefix}/{name}" if rel_prefix else name
                if is_dir:
                    if depth + 1 <= self.max_depth:
                        subdirs.append((Path(entry.path), rel_posix, depth + 1))
                elif is_file:
                    suffix = Path(name).suffix.lower()
                    ext_rank = _EXTENSION_PRIORITY.get(suffix)
                    if ext_rank is None:
                        continue
                    if len(collected) >= self.max_files:
                        truncated = True
                        break
                    stem = name[:-len(suffix)] if suffix else name
                    no_ext_posix = rel_posix[:-len(suffix)] if suffix else rel_posix
                    collected.append(IndexedNote(
                        path=Path(entry.path),
                        rel_posix=rel_posix,
                        name=name,
                        name_fold=name.casefold(),
                        stem=stem,
                        stem_fold=stem.casefold(),
                        no_ext_posix=no_ext_posix,
                        no_ext_fold=no_ext_posix.casefold(),
                        depth=depth,
                        ext_rank=ext_rank,
                    ))
            if truncated:
                break
            for item in reversed(subdirs):
                stack.append(item)

        snapshot = _CachedScan(
            root=boundary,
            root_mtime_ns=root_mtime_ns,
            scanned_at=time.monotonic(),
            entries=tuple(collected),
            truncated=truncated,
        )
        with self._lock:
            while len(self._entries) >= 16 and key not in self._entries:
                self._entries.pop(next(iter(self._entries)))
            self._entries[key] = snapshot
        return snapshot.entries


def _has_supported_note_extension(name: str) -> bool:
    return Path(name).suffix.lower() in NOTE_EXTENSIONS


def _validate_target_syntax(raw_target: str) -> str:
    if not isinstance(raw_target, str):
        raise WorkspaceLinkError("Invalid note link target.")
    if _ENCODED_SEP.search(raw_target):
        raise WorkspaceLinkError("Encoded path separators are not allowed in note links.")
    cleaned = urllib.parse.unquote(raw_target).strip()
    if not cleaned or "\x00" in cleaned:
        raise WorkspaceLinkError("Invalid note link target.")
    if cleaned.startswith(("/", "\\")) or "\\" in cleaned:
        raise WorkspaceLinkError("Note links must be relative to the workspace folder.")
    if re.match(r"^[A-Za-z][A-Za-z0-9+.-]*:", cleaned):
        raise WorkspaceLinkError("Unsupported note link scheme.")
    return cleaned


def _resolve_clean_directory(raw_dir: str | os.PathLike[str], label: str) -> Path:
    supplied = Path(os.path.abspath(Path(raw_dir).expanduser()))
    if _is_link_or_junction(supplied):
        raise WorkspaceLinkError(f"Symlink paths are not allowed for {label}.")
    try:
        resolved = supplied.resolve(strict=True)
    except OSError as exc:
        raise WorkspaceLinkError(f"{label.capitalize()} is unavailable.") from exc
    if not resolved.is_dir():
        raise WorkspaceLinkError(f"{label.capitalize()} is not a folder.")
    return resolved


def _resolve_note_directory(
    note_raw: str | os.PathLike[str],
    ws_boundary: Path | None,
) -> Path:
    note_supplied = Path(os.path.abspath(Path(note_raw).expanduser()))
    if _is_link_or_junction(note_supplied):
        raise WorkspaceLinkError("Symlink note paths are not allowed.")
    parent_supplied = note_supplied.parent
    if _is_link_or_junction(parent_supplied):
        raise WorkspaceLinkError("Symlink note paths are not allowed.")
    try:
        note_dir = parent_supplied.resolve(strict=True)
    except OSError as exc:
        raise WorkspaceLinkError("Note folder is unavailable.") from exc
    if not note_dir.is_dir():
        raise WorkspaceLinkError("Note folder is not a folder.")

    if ws_boundary is not None and (note_dir == ws_boundary or ws_boundary in note_dir.parents):
        cur = parent_supplied
        while True:
            if _is_link_or_junction(cur):
                raise WorkspaceLinkError("Symlink note paths are not allowed.")
            try:
                cur_resolved = cur.resolve(strict=True)
            except OSError as exc:
                raise WorkspaceLinkError("Note folder is unavailable.") from exc
            if cur_resolved == ws_boundary:
                break
            if cur.parent == cur:
                raise WorkspaceLinkError("Symlink note paths are not allowed.")
            cur = cur.parent
    return note_dir


def _walk_within_boundary(base_dir: Path, rel_path: str, boundary: Path) -> Path:
    current = base_dir
    for part in PurePosixPath(rel_path).parts:
        if part in ("", "."):
            continue
        if part == "..":
            if current == boundary:
                raise WorkspaceLinkError("Link points outside the allowed folder.")
            parent = current.parent
            if parent != boundary and boundary not in parent.parents:
                raise WorkspaceLinkError("Link points outside the allowed folder.")
            current = parent
        else:
            nxt = current / part
            if _is_link_or_junction(nxt):
                raise WorkspaceLinkError("Symlink note links are not allowed.")
            current = nxt
    if current != boundary and boundary not in current.parents:
        raise WorkspaceLinkError("Link points outside the allowed folder.")
    return current


def _probe_candidate(base_dir: Path, rel_path: str, boundary: Path, *, exact_case: bool = False) -> Path | None:
    candidates = [rel_path] if _has_supported_note_extension(rel_path) else [
        *(f"{rel_path}{ext}" for ext in NOTE_EXTENSIONS),
    ]
    for candidate_rel in candidates:
        walked = _walk_within_boundary(base_dir, candidate_rel, boundary)
        try:
            if walked.is_file() and walked.suffix.lower() in NOTE_EXTENSIONS:
                resolved = walked.resolve(strict=True)
                if exact_case and resolved.name != walked.name:
                    continue
                if resolved != boundary and boundary not in resolved.parents:
                    raise WorkspaceLinkError("Link points outside the allowed folder.")
                return resolved
        except WorkspaceLinkError:
            raise
        except OSError:
            continue
    return None


def resolve_workspace_link(
    target: str,
    *,
    wikilink: bool,
    note_path: str | os.PathLike[str] | None,
    workspace_folder: str | os.PathLike[str] | None,
    cache: WorkspaceLinkCache,
) -> Path:
    """Resolve a relative Markdown link or [[wikilink]] safely within the workspace."""
    cleaned = _validate_target_syntax(target)
    is_explicit_relative = not wikilink or cleaned.startswith(("./", "../"))
    has_note_path = bool(note_path and str(note_path))
    has_workspace_folder = bool(workspace_folder and str(workspace_folder))

    if not has_note_path and is_explicit_relative:
        raise WorkspaceLinkError("Save this draft before following relative note links.")
    if not has_note_path and not has_workspace_folder:
        raise WorkspaceLinkError("Save this draft or open a folder before following note links.")

    ws_boundary: Path | None = None
    if has_workspace_folder:
        assert workspace_folder is not None
        ws_boundary = _resolve_clean_directory(workspace_folder, "workspace folder")

    note_dir: Path | None = None
    if has_note_path:
        assert note_path is not None
        note_dir = _resolve_note_directory(note_path, ws_boundary)

    if ws_boundary is not None:
        if note_dir is not None and note_dir != ws_boundary and ws_boundary not in note_dir.parents:
            boundary = note_dir
        else:
            boundary = ws_boundary
    else:
        assert note_dir is not None
        boundary = note_dir

    if is_explicit_relative:
        assert note_dir is not None
        found = _probe_candidate(note_dir, cleaned, boundary)
        if found is not None:
            return found
        raise WorkspaceLinkError(f"Linked note not found: {cleaned}")

    # Wikilink resolution:
    # 1. Relative to current note folder (if saved) and workspace root.
    if note_dir is not None:
        direct = _probe_candidate(note_dir, cleaned, boundary, exact_case=True)
        if direct is not None:
            return direct
    if note_dir != boundary:
        from_root = _probe_candidate(boundary, cleaned, boundary, exact_case=True)
        if from_root is not None:
            return from_root

    # 2. Bounded, cached background scan across the workspace folder.
    entries = cache.scan(boundary)
    has_ext = _has_supported_note_extension(cleaned)
    cleaned_fold = cleaned.casefold()
    note_rel_dir = ""
    if note_dir is not None and (note_dir == boundary or boundary in note_dir.parents):
        note_rel_dir = "" if note_dir == boundary else note_dir.relative_to(boundary).as_posix()

    matches: list[tuple[tuple[int, int, int, int, str], IndexedNote]] = []
    for entry in entries:
        if "/" in cleaned:
            if has_ext:
                exact = entry.rel_posix == cleaned or entry.rel_posix.endswith(f"/{cleaned}")
                folded = entry.rel_posix.casefold() == cleaned_fold or entry.rel_posix.casefold().endswith(f"/{cleaned_fold}")
            else:
                exact = entry.no_ext_posix == cleaned or entry.no_ext_posix.endswith(f"/{cleaned}")
                folded = entry.no_ext_fold == cleaned_fold or entry.no_ext_fold.endswith(f"/{cleaned_fold}")
        else:
            if has_ext:
                exact = entry.name == cleaned
                folded = entry.name_fold == cleaned_fold
            else:
                exact = entry.stem == cleaned
                folded = entry.stem_fold == cleaned_fold
        if not exact and not folded:
            continue
        entry_dir = entry.rel_posix.rsplit("/", 1)[0] if "/" in entry.rel_posix else ""
        same_dir_rank = 0 if (note_dir is not None and entry_dir == note_rel_dir) else 1
        case_rank = 0 if exact else 1
        rank = (case_rank, same_dir_rank, entry.depth, entry.ext_rank, entry.rel_posix.casefold())
        matches.append((rank, entry))

    matches.sort(key=lambda item: item[0])
    for _rank, winner in matches:
        candidate = winner.path
        if _has_symlink_within(boundary, candidate):
            continue
        try:
            resolved = candidate.resolve(strict=True)
        except OSError:
            continue
        if (resolved == boundary or boundary in resolved.parents) and resolved.is_file():
            return resolved

    raise WorkspaceLinkError(f"Linked note not found: {cleaned}")
