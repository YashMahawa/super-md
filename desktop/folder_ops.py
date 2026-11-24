"""Validation, boundary checks, lazy subfolder listing, and linked-asset helpers for open folders."""
from __future__ import annotations

import os
import re
import urllib.parse
from pathlib import Path, PurePath, PurePosixPath, PureWindowsPath

try:
    from . import documents, markdown_prepare
except ImportError:
    import documents
    import markdown_prepare

NOTE_SUFFIXES = (".md", ".smd", ".fmd", ".markdown", ".txt")
PLAIN_MARKDOWN_SUFFIXES = (".md", ".markdown", ".txt")
KNOWN_FORMAT_SUFFIXES = frozenset({".md", ".markdown", ".txt", ".smd", ".fmd", ".pdf", ".zip", ".html", ".docx"})


def validate_entry_name(raw_name: str, *, is_directory: bool, current_ext: str = "") -> str:
    """Validate a note or folder name, preserving note extensions unless a matching one is supplied."""
    if not isinstance(raw_name, str):
        raise ValueError("Choose a valid name.")
    name = raw_name.strip()
    if (
        not name
        or name in (".", "..")
        or name.startswith(".")
        or any(ch in name for ch in "/\\\x00")
        or any(ord(ch) < 32 for ch in name)
    ):
        raise ValueError("Choose a visible name without path separators.")
    if len(name) > 240:
        raise ValueError("Choose a shorter name.")
    if is_directory:
        return name

    ext = current_ext or ".md"
    if not ext.startswith("."):
        ext = "." + ext
    if len(name) > len(ext) and name.lower().endswith(ext.lower()):
        stem = name[: -len(ext)].strip()
        if not stem or stem in (".", ".."):
            raise ValueError("Choose a valid note name.")
        return name

    supplied_suffix = Path(name).suffix.lower()
    if supplied_suffix and supplied_suffix in (KNOWN_FORMAT_SUFFIXES - {ext.lower()}):
        raise ValueError("Rename keeps the note format. Use Export to change formats.")
    return name + ext


def _is_link_or_junction(path: Path) -> bool:
    if path.is_symlink():
        return True
    is_junction = getattr(path, "is_junction", None)
    return bool(callable(is_junction) and is_junction())


def strip_extended_length_prefix(raw: str) -> str:
    """Strip Win32 extended-length path prefixes (\\\\?\\) while preserving standard paths."""
    if os.name == "nt":
        if raw.startswith("\\\\?\\UNC\\"):
            return "\\\\" + raw[8:]
        if raw.startswith("\\\\?\\"):
            return raw[4:]
    return raw


def _pure_path(raw: str) -> PurePath:
    return PureWindowsPath(raw) if os.name == "nt" else PurePosixPath(raw)


def canonical_path_str(path: str | os.PathLike[str]) -> str:
    """Return a resolved, normalized path string without Win32 \\\\?\\ prefixes."""
    raw = strip_extended_length_prefix(str(path or "").strip())
    if not raw:
        return ""
    try:
        resolved = os.path.realpath(raw)
        return os.path.normpath(strip_extended_length_prefix(str(resolved)))
    except OSError:
        return os.path.normpath(raw)


def normalize_path_key(path: str | os.PathLike[str]) -> str:
    """Return an OS-normalized comparison key using forward slashes and platform case rules."""
    canon = canonical_path_str(path)
    if not canon:
        return ""
    key = os.path.normcase(canon)
    if os.name == "nt":
        key = key.replace("\\", "/")
    while len(key) > 1 and key.endswith("/") and not (os.name == "nt" and len(key) == 3 and key[1] == ":"):
        key = key[:-1]
    return key


def same_path(left: str | os.PathLike[str], right: str | os.PathLike[str]) -> bool:
    """Return True when two paths refer to the same normalized location."""
    left_key = normalize_path_key(left)
    right_key = normalize_path_key(right)
    return bool(left_key and right_key and left_key == right_key)


def normalized_relpath(path: str | os.PathLike[str], root: str | os.PathLike[str]) -> str:
    """Return a POSIX-separated relative path from *root* to *path* across all platforms."""
    canon_path = _pure_path(canonical_path_str(path))
    canon_root = _pure_path(canonical_path_str(root))
    try:
        return canon_path.relative_to(canon_root).as_posix()
    except ValueError:
        path_key = normalize_path_key(str(canon_path))
        root_key = normalize_path_key(str(canon_root))
        if path_key == root_key:
            return "."
        prefix = root_key if root_key.endswith("/") else root_key + "/"
        if path_key.startswith(prefix) and len(canon_path.parts) > len(canon_root.parts):
            return PurePosixPath(*canon_path.parts[len(canon_root.parts):]).as_posix()
        raise


def _check_no_symlinks_under(base: Path, target: Path) -> None:
    try:
        rel_parts = target.relative_to(base).parts
    except ValueError:
        return
    current = base
    for part in rel_parts:
        current = current / part
        if _is_link_or_junction(current):
            raise ValueError("Symlinks are not allowed inside the open folder.")


def resolve_within_open_folder(
    open_root: str | os.PathLike[str],
    target: str | os.PathLike[str],
    *,
    allow_root: bool = False,
    must_exist: bool = True,
) -> Path:
    """Resolve *target* inside *open_root*, rejecting symlinks and paths outside the open folder."""
    root_str = strip_extended_length_prefix(str(open_root or "").strip())
    target_str = strip_extended_length_prefix(str(target or "").strip())
    if not root_str or not target_str:
        raise ValueError("Open a folder first.")
    raw_root = Path(root_str)
    if _is_link_or_junction(raw_root):
        raise ValueError("Symlinks are not allowed inside the open folder.")
    try:
        root = Path(strip_extended_length_prefix(str(raw_root.resolve(strict=True))))
    except OSError as error:
        raise ValueError("The open folder is no longer available.") from error
    if not root.is_dir():
        raise ValueError("The open folder is no longer available.")

    raw_target = Path(target_str)
    if not raw_target.is_absolute():
        raise ValueError("Folder entry path must be an absolute path inside the open folder.")
    if _is_link_or_junction(raw_target):
        raise ValueError("Symlinks are not allowed inside the open folder.")

    _check_no_symlinks_under(raw_root, raw_target)
    _check_no_symlinks_under(root, raw_target)

    try:
        resolved = Path(strip_extended_length_prefix(str(raw_target.resolve(strict=must_exist))))
    except OSError as error:
        raise ValueError("The selected item is no longer available.") from error

    if same_path(resolved, root):
        if not allow_root:
            raise ValueError("Cannot modify the open folder itself.")
        return resolved
    if not matches_path_prefix(str(resolved), str(root), is_directory=True):
        raise ValueError("Paths outside the open folder are not allowed.")

    _check_no_symlinks_under(root, resolved)
    return resolved


def ancestor_directories_in_folder(open_root: Path, target_dir: Path) -> set[str]:
    """Return *open_root* and every ancestor directory down to *target_dir* for tree expansion."""
    root = Path(canonical_path_str(open_root))
    current = Path(canonical_path_str(target_dir))
    expanded = {str(root)}
    if same_path(current, root) or matches_path_prefix(str(current), str(root), is_directory=True):
        while not same_path(current, root) and matches_path_prefix(str(current), str(root), is_directory=True):
            expanded.add(str(current))
            if current.parent == current:
                break
            current = current.parent
    return expanded


def matches_path_prefix(candidate: str, target: str, *, is_directory: bool) -> bool:
    """Return True when *candidate* is *target* or (for directories) a descendant of *target*."""
    cand_key = normalize_path_key(candidate)
    targ_key = normalize_path_key(target)
    if not cand_key or not targ_key:
        return False
    if cand_key == targ_key:
        return True
    if not is_directory:
        return False
    prefix = targ_key if targ_key.endswith("/") else targ_key + "/"
    return cand_key.startswith(prefix)


def remap_path_prefix(candidate: str, old_path: str, new_path: str, *, is_directory: bool) -> str:
    """Rewrite *candidate* when *old_path* (file or folder) moves/renames to *new_path*."""
    if not candidate:
        return candidate
    cand_key = normalize_path_key(candidate)
    old_key = normalize_path_key(old_path)
    new_canon = canonical_path_str(new_path)
    if not cand_key or not old_key or not new_canon:
        return candidate
    if cand_key == old_key:
        return new_canon
    if is_directory:
        prefix = old_key if old_key.endswith("/") else old_key + "/"
        if cand_key.startswith(prefix):
            cand_parts = _pure_path(canonical_path_str(candidate)).parts
            old_parts = _pure_path(canonical_path_str(old_path)).parts
            if len(cand_parts) > len(old_parts):
                return str(_pure_path(new_canon).joinpath(*cand_parts[len(old_parts):]))
    return candidate


def _decode_relative_asset_ref(raw_source: str) -> str | None:
    if not raw_source:
        return None
    trimmed = raw_source.strip()
    if not trimmed or trimmed.startswith(("/", "\\")) or re.match(r"^[a-z][a-z\d+.-]*:", trimmed, re.I):
        return None
    decoded = urllib.parse.unquote(trimmed.split("#", 1)[0].split("?", 1)[0]).strip()
    if not decoded or "\\" in decoded or "\0" in decoded or decoded.startswith("/"):
        return None
    parts = [part for part in decoded.split("/") if part and part != "."]
    if not parts or any(any(ord(ch) < 32 for ch in part) for part in parts):
        return None
    return "/".join(parts)


def linked_local_images(
    note_path: Path,
    markdown: str,
    open_root: Path,
    target_dir: Path,
) -> list[tuple[str, Path, Path]]:
    """Find relative local images/diagrams in a plain Markdown note that would break on move."""
    if note_path.suffix.lower() not in PLAIN_MARKDOWN_SUFFIXES:
        return []
    root = Path(strip_extended_length_prefix(str(open_root.resolve(strict=True))))
    source_dir = Path(strip_extended_length_prefix(str(note_path.parent.resolve(strict=True))))
    dest_dir = Path(strip_extended_length_prefix(str(target_dir.resolve(strict=True))))
    if same_path(source_dir, dest_dir):
        return []

    found: list[tuple[str, Path, Path]] = []
    seen: set[str] = set()
    for ref in markdown_prepare._references(markdown or ""):
        rel = _decode_relative_asset_ref(ref.source)
        if not rel or rel in seen:
            continue
        src_candidate = source_dir / rel
        try:
            src_file = resolve_within_open_folder(root, src_candidate, allow_root=False, must_exist=True)
        except ValueError:
            continue
        if not src_file.is_file():
            continue
        dst_candidate = dest_dir / rel
        try:
            dst_file = resolve_within_open_folder(root, dst_candidate, allow_root=False, must_exist=False)
        except ValueError:
            # Relative path (such as ../image.png) would escape the open root at destination: warn user.
            seen.add(rel)
            found.append((rel, src_file, dst_candidate))
            continue
        if same_path(dst_file, src_file):
            continue
        if dst_file.exists() and dst_file.is_file():
            try:
                if dst_file.stat().st_size == src_file.stat().st_size and dst_file.read_bytes() == src_file.read_bytes():
                    continue
            except OSError:
                pass
        seen.add(rel)
        found.append((rel, src_file, dst_file))
    return found


def copy_linked_local_images(items: list[tuple[str, Path, Path]], open_root: Path) -> None:
    """Safely copy relative local images/diagrams to their relative destinations inside *open_root*."""
    if not items:
        return
    root = Path(strip_extended_length_prefix(str(open_root.resolve(strict=True))))
    staged: list[tuple[Path, bytes]] = []
    total_bytes = 0
    for rel, src_file, dst_candidate in items:
        dst_file = resolve_within_open_folder(root, dst_candidate, allow_root=False, must_exist=False)
        size = src_file.stat().st_size
        if size > documents.MAX_IMAGE:
            raise ValueError(f"Linked asset exceeds 25 MB: {src_file.name}")
        total_bytes += size
        if total_bytes > 110_000_000:
            raise ValueError("Linked assets exceed the total copy size limit.")
        payload = src_file.read_bytes()
        if dst_file.exists():
            if not dst_file.is_file() or dst_file.read_bytes() != payload:
                raise FileExistsError(f"A different file already exists at {rel}.")
            continue
        staged.append((dst_file, payload))

    created: list[Path] = []
    try:
        for dst_file, payload in staged:
            parent = dst_file.parent
            parent.mkdir(parents=True, exist_ok=True)
            resolve_within_open_folder(root, parent, allow_root=True, must_exist=True)
            documents.atomic_write(dst_file, payload)
            created.append(dst_file)
    except Exception:
        for path in created:
            try:
                path.unlink(missing_ok=True)
            except OSError:
                pass
        raise


def list_subfolders_lazy(
    open_root: Path,
    expanded_dirs: set[str],
    exclude_subtree: Path | None = None,
) -> list[dict]:
    """List the open root and lazily expanded subdirectories for the Move-to-folder picker."""
    root = Path(strip_extended_length_prefix(str(open_root.resolve(strict=True))))
    excluded = Path(canonical_path_str(exclude_subtree)) if exclude_subtree is not None else None
    expanded_keys = {normalize_path_key(item) for item in expanded_dirs if item}

    def is_excluded(candidate: Path) -> bool:
        return excluded is not None and (
            same_path(candidate, excluded)
            or matches_path_prefix(str(candidate), str(excluded), is_directory=True)
        )

    def has_visible_subdirs(directory: Path) -> bool:
        try:
            for child in directory.iterdir():
                if child.name.startswith(".") or _is_link_or_junction(child):
                    continue
                if child.is_dir():
                    resolved_child = Path(canonical_path_str(child))
                    if is_excluded(resolved_child):
                        continue
                    return True
        except OSError:
            return False
        return False

    rows: list[dict] = [
        {
            "name": root.name or str(root),
            "path": str(root),
            "depth": 0,
            "expanded": True,
            "hasChildren": has_visible_subdirs(root),
            "isRoot": True,
        }
    ]

    def visit(directory: Path, depth: int) -> None:
        try:
            children = sorted(directory.iterdir(), key=lambda p: p.name.lower())
        except OSError:
            return
        for child in children:
            if len(rows) >= 1500:
                return
            if child.name.startswith(".") or _is_link_or_junction(child) or not child.is_dir():
                continue
            resolved_child = Path(canonical_path_str(child))
            if is_excluded(resolved_child):
                continue
            is_expanded = normalize_path_key(resolved_child) in expanded_keys
            rows.append(
                {
                    "name": child.name,
                    "path": str(resolved_child),
                    "depth": depth,
                    "expanded": is_expanded,
                    "hasChildren": has_visible_subdirs(resolved_child),
                    "isRoot": False,
                }
            )
            if is_expanded:
                visit(resolved_child, depth + 1)

    visit(root, 1)
    return rows
