"""Vault-free workspace note link resolution with bounded, cached in-memory scanning."""
from __future__ import annotations

import os
import re
import sys
import threading
import time
import urllib.parse
from collections.abc import Iterable
from dataclasses import dataclass
from pathlib import Path, PurePosixPath

try:
    import fcntl as _fcntl
except ImportError:  # pragma: no cover - Windows
    _fcntl = None  # type: ignore[assignment]

NOTE_EXTENSIONS = (".md", ".smd", ".fmd", ".markdown", ".txt")
_EXTENSION_PRIORITY = {ext: idx for idx, ext in enumerate(NOTE_EXTENSIONS)}
_ENCODED_SEP = re.compile(r"%2f|%5c", re.IGNORECASE)
_ENCODED_NUL = re.compile(r"%00", re.IGNORECASE)
_MACOS_F_GETPATH = 50
_MACOS_MAXPATHLEN = 1024

MAX_SCAN_FILES = 8_000
MAX_SCAN_DIRS = 2_500
MAX_SCAN_DEPTH = 16
CACHE_TTL_SECONDS = 5.0


class WorkspaceLinkError(ValueError):
    """User-facing non-destructive link resolution error."""


def _stat_identity(st: os.stat_result) -> tuple[int, int] | None:
    if st.st_ino and st.st_dev:
        return (st.st_dev, st.st_ino)
    return None


def _path_identity(path: Path, *, follow_symlinks: bool = False) -> tuple[int, int] | None:
    try:
        return _stat_identity(path.stat(follow_symlinks=follow_symlinks))
    except OSError:
        return None


def _same_disk_object(first: Path, second: Path) -> bool:
    if first == second:
        return True
    try:
        return os.path.samefile(first, second)
    except OSError:
        return False


def _canonicalize_existing_path(path: Path) -> Path:
    resolved = path.resolve(strict=True)
    if sys.platform == "darwin" and _fcntl is not None:
        fd = -1
        try:
            open_flags = os.O_RDONLY | getattr(os, "O_CLOEXEC", 0)
            fd = os.open(os.fspath(resolved), open_flags)
            raw = _fcntl.fcntl(fd, _MACOS_F_GETPATH, b"\x00" * _MACOS_MAXPATHLEN)
            nul = raw.find(b"\x00")
            trimmed = raw[:nul] if nul >= 0 else raw
            if trimmed:
                return Path(os.fsdecode(trimmed))
        except (OSError, ValueError):
            pass
        finally:
            if fd >= 0:
                try:
                    os.close(fd)
                except OSError:
                    pass
    return resolved


def _fold_cache_path(raw: str | os.PathLike[str]) -> str:
    expanded = os.path.abspath(os.fspath(Path(raw).expanduser()))
    normalized = os.path.normcase(os.path.normpath(expanded)).replace("\\", "/").rstrip("/")
    return normalized.casefold() or "/"


def _overlaps_folded_path(first_fold: str, second_fold: str) -> bool:
    if first_fold == second_fold:
        return True
    if first_fold == "/" or second_fold == "/":
        return True
    return first_fold.startswith(f"{second_fold}/") or second_fold.startswith(f"{first_fold}/")


def _is_within_or_equal(candidate: Path, boundary: Path) -> bool:
    return candidate == boundary or boundary in candidate.parents


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
        if hasattr(os.path, "isjunction") and os.path.isjunction(path):
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


def _match_child_entry(
    parent_dir: Path,
    segment: str,
    *,
    exact_case: bool,
) -> os.DirEntry[str] | None:
    """Match a single child segment against real directory entries in `parent_dir`.

    Unlike `Path.resolve()`, `os.scandir()` exposes the true on-disk filename casing on
    case-insensitive filesystems such as macOS APFS and Windows NTFS.
    """
    direct = parent_dir / segment
    if _is_link_or_junction(direct):
        raise WorkspaceLinkError("Linked note symlink paths are not allowed.")
    try:
        probed_stat = direct.stat(follow_symlinks=False)
    except OSError:
        return None

    seg_fold = segment.casefold()
    folded_match: os.DirEntry[str] | None = None
    try:
        with os.scandir(parent_dir) as iterator:
            for entry in iterator:
                name = entry.name
                if name == segment:
                    if _is_entry_link_or_junction(entry):
                        raise WorkspaceLinkError("Linked note symlink paths are not allowed.")
                    return entry
                if name.casefold() != seg_fold:
                    continue
                if _is_entry_link_or_junction(entry):
                    raise WorkspaceLinkError("Linked note symlink paths are not allowed.")
                if not exact_case and folded_match is None:
                    try:
                        # Query Path.stat rather than DirEntry.stat: on Windows, nt.DirEntry.stat()
                        # populates WIN32_FIND_DATAW with st_ino=0/st_dev=0 whereas Path.stat()
                        # queries GetFileInformationByHandle with real volume/file-index identity.
                        entry_stat = Path(entry.path).stat(follow_symlinks=False)
                    except OSError:
                        continue
                    if os.path.samestat(entry_stat, probed_stat) or _stat_identity(probed_stat) is None:
                        folded_match = entry
    except WorkspaceLinkError:
        raise
    except OSError:
        return None

    return None if exact_case else folded_match


def _verify_exact_on_disk_path(boundary: Path, candidate: Path) -> bool:
    try:
        parts = candidate.relative_to(boundary).parts
    except ValueError:
        return False
    current = boundary
    for part in parts:
        try:
            entry = _match_child_entry(current, part, exact_case=True)
        except WorkspaceLinkError:
            return False
        if entry is None:
            return False
        current = current / entry.name
    return current.is_file()


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


_SUBSECOND_RACY_WINDOW_NS = 100_000_000
_COARSE_RACY_WINDOW_NS = 2_000_000_000


def _racy_window_ns(mtime_ns: int, ctime_ns: int) -> int:
    if mtime_ns % 1_000_000_000 == 0 and ctime_ns % 1_000_000_000 == 0:
        return _COARSE_RACY_WINDOW_NS
    return _SUBSECOND_RACY_WINDOW_NS


def _snapshot_racy_entries(entries: Iterable[os.DirEntry[str]]) -> frozenset[tuple[str, bool, bool, bool]]:
    snapshot: set[tuple[str, bool, bool, bool]] = set()
    for entry in entries:
        name = entry.name
        if not name or name.startswith("."):
            continue
        try:
            is_sym = entry.is_symlink()
            is_dir = not is_sym and entry.is_dir(follow_symlinks=False)
            is_file = not is_sym and not is_dir and entry.is_file(follow_symlinks=False)
        except OSError:
            is_sym = True
            is_dir = False
            is_file = False
        snapshot.add((name, is_sym, is_dir, is_file))
    return frozenset(snapshot)


@dataclass(frozen=True)
class _DirStamp:
    path: Path
    mtime_ns: int
    ctime_ns: int
    size: int
    nlink: int
    file_id: tuple[int, int] | None
    racy_entries: frozenset[tuple[str, bool, bool, bool]] | None = None


@dataclass
class _CachedScan:
    root: Path
    root_fold: str
    root_id: tuple[int, int] | None
    dir_stamps: tuple[_DirStamp, ...]
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

    def _is_fresh(self, cached: _CachedScan, now: float) -> bool:
        elapsed_seconds = now - cached.scanned_at
        if elapsed_seconds > self.ttl_seconds:
            return False
        elapsed_since_scan_ns = elapsed_seconds * 1_000_000_000
        check_wall_ns: int | None = None
        cleaned_stamps: list[_DirStamp] | None = None
        for idx, stamp in enumerate(cached.dir_stamps):
            try:
                st = stamp.path.stat(follow_symlinks=False)
            except OSError:
                return False
            if (
                st.st_mtime_ns != stamp.mtime_ns
                or st.st_ctime_ns != stamp.ctime_ns
                or st.st_size != stamp.size
                or st.st_nlink != stamp.nlink
            ):
                return False
            if stamp.file_id is not None and _stat_identity(st) != stamp.file_id:
                return False
            if stamp.racy_entries is not None:
                if check_wall_ns is None:
                    check_wall_ns = time.time_ns()
                try:
                    with os.scandir(stamp.path) as iterator:
                        live_entries = _snapshot_racy_entries(iterator)
                except OSError:
                    return False
                if live_entries != stamp.racy_entries:
                    return False
                window_ns = _racy_window_ns(stamp.mtime_ns, stamp.ctime_ns)
                if (
                    elapsed_since_scan_ns > window_ns
                    and check_wall_ns - stamp.mtime_ns > window_ns
                    and check_wall_ns - stamp.ctime_ns > window_ns
                ):
                    if cleaned_stamps is None:
                        cleaned_stamps = list(cached.dir_stamps)
                    cleaned_stamps[idx] = _DirStamp(
                        path=stamp.path,
                        mtime_ns=stamp.mtime_ns,
                        ctime_ns=stamp.ctime_ns,
                        size=stamp.size,
                        nlink=stamp.nlink,
                        file_id=stamp.file_id,
                        racy_entries=None,
                    )
        if cleaned_stamps is not None:
            cached.dir_stamps = tuple(cleaned_stamps)
        return True

    def invalidate(self, folder: str | os.PathLike[str] | None = None) -> None:
        if folder is None or not str(folder):
            with self._lock:
                self._entries.clear()
            return

        supplied_fold = _fold_cache_path(folder)
        resolved_fold: str | None = None
        target_id: tuple[int, int] | None = None
        try:
            canonical = _canonicalize_existing_path(Path(os.path.abspath(Path(folder).expanduser())))
            resolved_fold = _fold_cache_path(canonical)
            target_id = _path_identity(canonical, follow_symlinks=False)
        except (OSError, ValueError):
            target_id = _path_identity(Path(os.path.abspath(Path(folder).expanduser())), follow_symlinks=True)

        with self._lock:
            stale_keys = [
                key
                for key, snap in self._entries.items()
                if key == supplied_fold
                or (resolved_fold is not None and key == resolved_fold)
                or _overlaps_folded_path(snap.root_fold, supplied_fold)
                or (resolved_fold is not None and _overlaps_folded_path(snap.root_fold, resolved_fold))
                or (
                    target_id is not None
                    and (
                        snap.root_id == target_id
                        or any(stamp.file_id == target_id for stamp in snap.dir_stamps)
                    )
                )
            ]
            for key in stale_keys:
                self._entries.pop(key, None)

    def scan(self, boundary: Path | str | os.PathLike[str]) -> tuple[IndexedNote, ...]:
        boundary_path = _resolve_clean_directory(boundary, "workspace folder")
        root_fold = _fold_cache_path(boundary_path)
        now = time.monotonic()
        try:
            root_stat = boundary_path.stat(follow_symlinks=False)
        except OSError as exc:
            raise WorkspaceLinkError("Workspace folder is unavailable.") from exc
        root_id = _stat_identity(root_stat)

        with self._lock:
            cached = self._entries.get(root_fold)
            if cached is None and root_id is not None:
                cached = next((item for item in self._entries.values() if item.root_id == root_id), None)
            if (
                cached is not None
                and os.fspath(cached.root) == os.fspath(boundary_path)
                and self._is_fresh(cached, now)
            ):
                return cached.entries

        collected: list[IndexedNote] = []
        dir_stamps: list[_DirStamp] = []
        visited_dirs = 0
        truncated = False
        scan_started_wall_ns = time.time_ns()
        stack: list[tuple[Path, str, int]] = [(boundary_path, "", 0)]

        while stack:
            current_dir, rel_prefix, depth = stack.pop()
            visited_dirs += 1
            if visited_dirs > self.max_dirs:
                truncated = True
                break
            try:
                dir_stat = current_dir.stat(follow_symlinks=False)
                with os.scandir(current_dir) as iterator:
                    dir_entries = sorted(iterator, key=lambda e: (e.name.casefold(), e.name))
            except OSError:
                continue
            dir_wall_ns = time.time_ns()
            window_ns = _racy_window_ns(dir_stat.st_mtime_ns, dir_stat.st_ctime_ns)
            is_racy = (
                abs(dir_wall_ns - dir_stat.st_mtime_ns) <= window_ns
                or abs(dir_wall_ns - dir_stat.st_ctime_ns) <= window_ns
                or abs(scan_started_wall_ns - dir_stat.st_mtime_ns) <= window_ns
                or abs(scan_started_wall_ns - dir_stat.st_ctime_ns) <= window_ns
            )
            dir_stamps.append(_DirStamp(
                path=current_dir,
                mtime_ns=dir_stat.st_mtime_ns,
                ctime_ns=dir_stat.st_ctime_ns,
                size=dir_stat.st_size,
                nlink=dir_stat.st_nlink,
                file_id=_stat_identity(dir_stat),
                racy_entries=_snapshot_racy_entries(dir_entries) if is_racy else None,
            ))

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

                child_path = current_dir / name
                rel_posix = f"{rel_prefix}/{name}" if rel_prefix else name
                if is_dir:
                    if depth + 1 <= self.max_depth:
                        subdirs.append((child_path, rel_posix, depth + 1))
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
                        path=child_path,
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
            root=boundary_path,
            root_fold=root_fold,
            root_id=root_id,
            dir_stamps=tuple(dir_stamps),
            scanned_at=time.monotonic(),
            entries=tuple(collected),
            truncated=truncated,
        )
        with self._lock:
            if root_id is not None:
                duplicate_keys = [
                    existing_key
                    for existing_key, existing in self._entries.items()
                    if existing_key != root_fold and existing.root_id == root_id
                ]
                for existing_key in duplicate_keys:
                    self._entries.pop(existing_key, None)
            while len(self._entries) >= 16 and root_fold not in self._entries:
                self._entries.pop(next(iter(self._entries)))
            self._entries[root_fold] = snapshot
        return snapshot.entries


def _has_supported_note_extension(name: str) -> bool:
    return Path(name).suffix.lower() in NOTE_EXTENSIONS


def _validate_target_syntax(raw_target: str) -> str:
    if not isinstance(raw_target, str) or len(raw_target) > 4096:
        raise WorkspaceLinkError("Invalid note link target.")
    stripped_fragment = raw_target.split("#", 1)[0].split("?", 1)[0].strip()
    if not stripped_fragment or "\x00" in stripped_fragment or _ENCODED_NUL.search(stripped_fragment):
        raise WorkspaceLinkError("Invalid note link target.")
    if _ENCODED_SEP.search(stripped_fragment):
        raise WorkspaceLinkError("Encoded path separators are not allowed in note links.")
    cleaned = urllib.parse.unquote(stripped_fragment).strip()
    if not cleaned or "\x00" in cleaned:
        raise WorkspaceLinkError("Invalid note link target.")
    if cleaned.startswith(("/", "\\")) or "\\" in cleaned:
        raise WorkspaceLinkError("Note links must be relative to the workspace folder.")
    if re.match(r"^[A-Za-z]:", cleaned) or re.match(r"^[A-Za-z][A-Za-z0-9+.-]*:", cleaned):
        raise WorkspaceLinkError("Unsupported note link scheme.")
    return cleaned


def _resolve_clean_directory(raw_dir: str | os.PathLike[str], label: str) -> Path:
    supplied = Path(os.path.abspath(Path(raw_dir).expanduser()))
    if _is_link_or_junction(supplied):
        raise WorkspaceLinkError(f"Linked note symlink paths are not allowed for {label}.")
    try:
        resolved = _canonicalize_existing_path(supplied)
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
        raise WorkspaceLinkError("Linked note symlink paths are not allowed.")
    parent_supplied = note_supplied.parent
    if _is_link_or_junction(parent_supplied):
        raise WorkspaceLinkError("Linked note symlink paths are not allowed.")
    try:
        note_dir = _canonicalize_existing_path(parent_supplied)
    except OSError as exc:
        raise WorkspaceLinkError("Note folder is unavailable.") from exc
    if not note_dir.is_dir():
        raise WorkspaceLinkError("Note folder is not a folder.")

    if ws_boundary is None:
        return note_dir

    # Walk upward from `parent_supplied` to detect symlinks/junctions and also match
    # `ws_boundary` by inode identity when `note_raw` and `ws_boundary` differ in casing.
    cur = parent_supplied
    segments_from_ws: list[str] = []
    reached_ws = False
    while True:
        if _is_link_or_junction(cur):
            raise WorkspaceLinkError("Linked note symlink paths are not allowed.")
        try:
            cur_resolved = _canonicalize_existing_path(cur)
        except OSError as exc:
            raise WorkspaceLinkError("Note folder is unavailable.") from exc
        if cur_resolved == ws_boundary or _same_disk_object(cur_resolved, ws_boundary):
            reached_ws = True
            break
        if cur.parent == cur:
            break
        segments_from_ws.append(cur.name)
        cur = cur.parent

    if not reached_ws:
        if _is_within_or_equal(note_dir, ws_boundary):
            raise WorkspaceLinkError("Linked note symlink paths are not allowed.")
        return note_dir

    rebased = ws_boundary
    for seg in reversed(segments_from_ws):
        entry = _match_child_entry(rebased, seg, exact_case=False)
        if entry is None:
            return note_dir
        rebased = rebased / entry.name
    return rebased


def _walk_and_match_within_boundary(
    base_dir: Path,
    rel_path: str,
    boundary: Path,
    *,
    exact_case: bool,
) -> Path | None:
    current = base_dir
    for part in PurePosixPath(rel_path).parts:
        if part in ("", "."):
            continue
        if part == "..":
            if current == boundary:
                raise WorkspaceLinkError("Linked note is outside the authorized folder.")
            parent = current.parent
            if not _is_within_or_equal(parent, boundary):
                raise WorkspaceLinkError("Linked note is outside the authorized folder.")
            current = parent
        else:
            entry = _match_child_entry(current, part, exact_case=exact_case)
            if entry is None:
                return None
            current = current / entry.name
    if not _is_within_or_equal(current, boundary):
        raise WorkspaceLinkError("Linked note is outside the authorized folder.")
    return current


def _probe_candidate(base_dir: Path, rel_path: str, boundary: Path, *, exact_case: bool = False) -> Path | None:
    candidates = [rel_path] if _has_supported_note_extension(rel_path) else [
        *(f"{rel_path}{ext}" for ext in NOTE_EXTENSIONS),
    ]
    for candidate_rel in candidates:
        walked = _walk_and_match_within_boundary(base_dir, candidate_rel, boundary, exact_case=exact_case)
        if walked is None:
            continue
        try:
            if walked.is_file() and walked.suffix.lower() in NOTE_EXTENSIONS:
                resolved = _canonicalize_existing_path(walked)
                if not _is_within_or_equal(resolved, boundary) or not _is_within_or_equal(walked, boundary):
                    raise WorkspaceLinkError("Linked note is outside the authorized folder.")
                return resolved
        except WorkspaceLinkError:
            raise
        except OSError:
            continue
    return None


_DEFAULT_CACHE = WorkspaceLinkCache()


def _rank_and_select_indexed_match(
    entries: tuple[IndexedNote, ...],
    cleaned: str,
    note_dir: Path | None,
    boundary: Path,
) -> tuple[Path | None, bool]:
    """Return `(resolved_winner, saw_stale_entry)` across ranked `IndexedNote` candidates."""
    has_ext = _has_supported_note_extension(cleaned)
    cleaned_fold = cleaned.casefold()
    note_rel_dir_fold: str | None = None
    if note_dir is not None and _is_within_or_equal(note_dir, boundary):
        note_rel_dir_fold = "" if note_dir == boundary else note_dir.relative_to(boundary).as_posix().casefold()

    matches: list[tuple[tuple[int, int, int, int, str, str], IndexedNote]] = []
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
        if not _verify_exact_on_disk_path(boundary, entry.path):
            return None, True
        entry_dir_fold = entry.rel_posix.rsplit("/", 1)[0].casefold() if "/" in entry.rel_posix else ""
        same_dir_rank = 0 if (note_rel_dir_fold is not None and entry_dir_fold == note_rel_dir_fold) else 1
        case_rank = 0 if exact else 1
        rank = (case_rank, same_dir_rank, entry.depth, entry.ext_rank, entry.rel_posix.casefold(), entry.rel_posix)
        matches.append((rank, entry))

    matches.sort(key=lambda item: item[0])
    saw_stale = False
    for _rank, winner in matches:
        candidate = winner.path
        try:
            resolved = _canonicalize_existing_path(candidate)
        except OSError:
            saw_stale = True
            continue
        if not _is_within_or_equal(resolved, boundary) or not _is_within_or_equal(candidate, boundary):
            continue
        if candidate.is_file():
            return resolved, saw_stale

    return None, saw_stale


def resolve_workspace_link(
    target: str,
    *,
    wikilink: bool = False,
    note_path: str | os.PathLike[str] | None,
    workspace_folder: str | os.PathLike[str] | None = None,
    cache: WorkspaceLinkCache | None = None,
) -> Path:
    """Resolve a relative Markdown link or [[wikilink]] safely within the authorized boundary."""
    cleaned = _validate_target_syntax(target)
    is_explicit_relative = not wikilink or cleaned.startswith(("./", "../"))
    has_note_path = bool(note_path and str(note_path))
    has_workspace_folder = bool(workspace_folder and str(workspace_folder))

    if not has_note_path and (is_explicit_relative or not has_workspace_folder):
        raise WorkspaceLinkError("Save this note before opening linked notes.")

    suffix = Path(cleaned).suffix.lower()
    if not wikilink and suffix and suffix not in NOTE_EXTENSIONS:
        raise WorkspaceLinkError("Only Markdown and Super MD notes can be opened from relative links.")

    ws_boundary: Path | None = None
    if has_workspace_folder:
        assert workspace_folder is not None
        ws_boundary = _resolve_clean_directory(workspace_folder, "workspace folder")

    note_dir: Path | None = None
    if has_note_path:
        assert note_path is not None
        note_dir = _resolve_note_directory(note_path, ws_boundary)

    if ws_boundary is not None:
        if note_dir is not None and not _is_within_or_equal(note_dir, ws_boundary):
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
        if (not cleaned.startswith(("./", "../"))
                and ".." not in PurePosixPath(cleaned).parts
                and note_dir != boundary):
            from_root = _probe_candidate(boundary, cleaned, boundary)
            if from_root is not None:
                return from_root
        raise WorkspaceLinkError(f"Linked note not found: {cleaned}")

    # Wikilink resolution:
    # 1. Exact-case match relative to current note folder (if saved) and workspace root.
    if note_dir is not None:
        direct = _probe_candidate(note_dir, cleaned, boundary, exact_case=True)
        if direct is not None:
            return direct
    if note_dir != boundary:
        from_root = _probe_candidate(boundary, cleaned, boundary, exact_case=True)
        if from_root is not None:
            return from_root

    # 2. Bounded, cached scan across the workspace folder.
    active_cache = cache if cache is not None else _DEFAULT_CACHE
    entries = active_cache.scan(boundary)
    winner, saw_stale = _rank_and_select_indexed_match(entries, cleaned, note_dir, boundary)
    if saw_stale:
        active_cache.invalidate(boundary)
        entries = active_cache.scan(boundary)
        winner, _ = _rank_and_select_indexed_match(entries, cleaned, note_dir, boundary)
    if winner is not None:
        return winner

    raise WorkspaceLinkError(f"Linked note not found: {cleaned}")
