"""Naming validation, open-folder boundary checks, and cross-platform path remapping."""
from __future__ import annotations

import os
import re
from collections.abc import Sequence
from pathlib import Path, PurePath, PurePosixPath, PureWindowsPath

NOTE_SUFFIXES = (".markdown", ".smd", ".fmd", ".md", ".txt")
KNOWN_FORMAT_SUFFIXES = frozenset({".md", ".markdown", ".txt", ".smd", ".fmd", ".pdf", ".zip", ".html", ".docx"})
_WINDOWS_PATH_RE = re.compile(r"^([a-zA-Z]:[\\/]|\\\\)")


def note_extension(name: str) -> str:
    """Return a note's extension (with leading dot), ignoring dotted titles such as 'Section 1.2'."""
    leaf = _pure_path(str(name or "")).name
    lower = leaf.lower()
    for suffix in NOTE_SUFFIXES:
        if len(leaf) > len(suffix) and lower.endswith(suffix):
            return leaf[-len(suffix):]
    dot = leaf.rfind(".")
    if dot > 0:
        raw_ext = leaf[dot + 1:]
        if 1 <= len(raw_ext) <= 16 and raw_ext[0].isascii() and raw_ext[0].isalpha() and raw_ext.isascii() and raw_ext.isalnum():
            return "." + raw_ext
    return ""


def note_stem(name: str) -> str:
    """Strip a known note suffix without truncating dotted stems such as '1.2 Linear Algebra.md'."""
    leaf = _pure_path(str(name or "")).name
    ext = note_extension(leaf)
    return leaf[: -len(ext)] if ext and len(leaf) > len(ext) else leaf


def validate_entry_name(
    raw_name: str,
    *,
    is_directory: bool,
    current_ext: str = "",
    has_saved_target: bool = False,
) -> str:
    """Validate a note or folder name, preserving note extensions unless a matching one is supplied."""
    if not isinstance(raw_name, str):
        raise ValueError("Choose a valid name.")
    name = raw_name.strip()
    if (
        not name
        or name in (".", "..")
        or name.startswith(".")
        or name.endswith(".")
        or any(ch in name for ch in '/\\:*?"<>|\x00')
        or any(ord(ch) < 32 for ch in name)
    ):
        raise ValueError("Choose a visible name without path separators or reserved characters.")
    if len(name) > 240:
        raise ValueError("Choose a shorter name.")
    if is_directory:
        return name

    if has_saved_target and not current_ext:
        supplied_suffix = Path(name).suffix.lower()
        if supplied_suffix and supplied_suffix in KNOWN_FORMAT_SUFFIXES:
            raise ValueError("Rename keeps the note format. Use Export to change formats.")
        return name

    ext = current_ext or ".md"
    if not ext.startswith("."):
        ext = "." + ext
    if len(name) > len(ext) and name.lower().endswith(ext.lower()):
        stem = name[: -len(ext)].strip()
        if not stem or stem in (".", "..") or stem.endswith("."):
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
    if raw.startswith("\\\\?\\UNC\\"):
        return "\\\\" + raw[8:]
    if raw.startswith("\\\\?\\"):
        return raw[4:]
    return raw


def _pure_path(raw: str) -> PurePath:
    return PureWindowsPath(raw) if (os.name == "nt" or _WINDOWS_PATH_RE.match(raw)) else PurePosixPath(raw)


def canonical_path_str(path: str | os.PathLike[str]) -> str:
    """Return a resolved, normalized path string without Win32 \\\\?\\ prefixes."""
    if path is None:
        return ""
    raw = strip_extended_length_prefix(os.fspath(path) if isinstance(path, os.PathLike) else str(path))
    if not raw or not raw.strip():
        return ""
    try:
        return os.path.normpath(strip_extended_length_prefix(str(os.path.realpath(raw))))
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
    left_key, right_key = normalize_path_key(left), normalize_path_key(right)
    return bool(left_key and right_key and left_key == right_key)


def normalized_relpath(path: str | os.PathLike[str], root: str | os.PathLike[str]) -> str:
    """Return a POSIX-separated relative path from *root* to *path* across all platforms."""
    canon_path = _pure_path(canonical_path_str(path))
    canon_root = _pure_path(canonical_path_str(root))
    try:
        return canon_path.relative_to(canon_root).as_posix()
    except ValueError:
        path_key, root_key = normalize_path_key(str(canon_path)), normalize_path_key(str(canon_root))
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
    root_str = strip_extended_length_prefix(os.fspath(open_root) if isinstance(open_root, os.PathLike) else str(open_root or ""))
    target_str = strip_extended_length_prefix(os.fspath(target) if isinstance(target, os.PathLike) else str(target or ""))
    if not root_str.strip() or not target_str.strip():
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
    root = Path(canonical_path_str(open_root))
    current = Path(canonical_path_str(target_dir))
    expanded = {str(root)}
    while not same_path(current, root) and matches_path_prefix(str(current), str(root), is_directory=True):
        expanded.add(str(current))
        if current.parent == current:
            break
        current = current.parent
    return expanded


def matches_path_prefix(candidate: str, target: str, *, is_directory: bool) -> bool:
    cand_key, targ_key = normalize_path_key(candidate), normalize_path_key(target)
    if not cand_key or not targ_key:
        return False
    if cand_key == targ_key:
        return True
    return is_directory and cand_key.startswith(targ_key if targ_key.endswith("/") else targ_key + "/")


def remap_path_prefix(candidate: str, old_path: str, new_path: str, *, is_directory: bool) -> str:
    if not candidate:
        return candidate
    cand_key, old_key, new_canon = normalize_path_key(candidate), normalize_path_key(old_path), canonical_path_str(new_path)
    if not cand_key or not old_key or not new_canon:
        return candidate
    if cand_key == old_key:
        return new_canon
    if is_directory and cand_key.startswith(old_key if old_key.endswith("/") else old_key + "/"):
        cand_parts = _pure_path(canonical_path_str(candidate)).parts
        old_parts = _pure_path(canonical_path_str(old_path)).parts
        if len(cand_parts) > len(old_parts):
            return str(_pure_path(new_canon).joinpath(*cand_parts[len(old_parts):]))
    return candidate


def _split_parent_segments(raw_path: str) -> tuple[str, tuple[str, ...], str]:
    cleaned = strip_extended_length_prefix(str(raw_path or "").strip())
    if not cleaned:
        return "", (), ""
    pure = _pure_path(cleaned)
    parent = pure.parent
    raw_parts = parent.parts
    if isinstance(pure, PureWindowsPath):
        anchor = pure.anchor.replace("\\", "/").rstrip("/")
        named = tuple(part for part in raw_parts[1 if pure.anchor else 0:] if part and part != ".")
        parent_key = f"{anchor}/{'/'.join(named)}".casefold() if anchor else "/".join(named).casefold()
        return anchor, named, parent_key
    anchor = "/" if pure.anchor else ""
    named = tuple(part for part in raw_parts[1 if pure.anchor else 0:] if part and part != ".")
    parent_key = f"/{'/'.join(named)}" if anchor else "/".join(named)
    return anchor, named, parent_key


def _parent_segments_at_depth(anchor: str, named: tuple[str, ...], depth: int) -> tuple[str, ...]:
    if not named:
        return (anchor,) if anchor else ()
    if depth <= len(named):
        return named[-depth:]
    if anchor == "/":
        return ("/" + named[0], *named[1:])
    if anchor:
        return (anchor, *named)
    return named


def disambiguate_tab_parents(tabs: Sequence[tuple[str, str]]) -> list[str]:
    """Return the shortest useful parent context for open tabs that share a filename."""
    contexts = [""] * len(tabs)
    groups: dict[str, list[int]] = {}
    for index, (raw_name, _raw_path) in enumerate(tabs):
        key = str(raw_name or "").strip().casefold()
        if key:
            groups.setdefault(key, []).append(index)

    for indices in groups.values():
        if len(indices) < 2:
            continue
        path_items: list[dict] = []
        unsaved_count = 0
        for index in indices:
            raw_name, raw_path = tabs[index]
            anchor, named, parent_key = _split_parent_segments(raw_path)
            if not parent_key and not anchor and not named:
                unsaved_count += 1
                continue
            max_depth = max(1, len(named) + (1 if anchor else 0))
            path_items.append({
                "index": index,
                "name": str(raw_name or "").strip(),
                "anchor": anchor,
                "named": named,
                "parent_key": parent_key or anchor,
                "depth": 1,
                "max_depth": max_depth,
                "segs": (),
                "label": "",
            })

        if not path_items:
            continue

        distinct_parents = {it["parent_key"] for it in path_items}
        if unsaved_count == 0 and len(distinct_parents) <= 1 and len({it["name"] for it in path_items}) > 1:
            continue

        while True:
            by_label: dict[str, list[dict]] = {}
            for it in path_items:
                segs = _parent_segments_at_depth(it["anchor"], it["named"], it["depth"])
                label = "/".join(segs)
                it["segs"] = segs
                it["label"] = label
                by_label.setdefault(label.casefold(), []).append(it)

            progressed = False
            for colliding in by_label.values():
                if len(colliding) < 2:
                    continue
                if len({it["parent_key"] for it in colliding}) <= 1:
                    continue
                for it in colliding:
                    if it["depth"] < it["max_depth"]:
                        it["depth"] += 1
                        progressed = True
            if not progressed:
                break

        uncompacted_by_parent = {it["parent_key"]: it["label"].casefold() for it in path_items}
        for it in path_items:
            segs = it["segs"]
            chosen = it["label"]
            if len(segs) >= 4:
                for keep in range(1, len(segs) - 2):
                    candidate = f"{'/'.join(segs[:keep])}/…/{segs[-1]}"
                    cand_cf = candidate.casefold()
                    collision = False
                    for other in path_items:
                        if other["parent_key"] == it["parent_key"]:
                            continue
                        if uncompacted_by_parent[other["parent_key"]] == cand_cf:
                            collision = True
                            break
                        other_segs = other["segs"]
                        if len(other_segs) >= keep + 3:
                            other_cand = f"{'/'.join(other_segs[:keep])}/…/{other_segs[-1]}"
                            if other_cand.casefold() == cand_cf:
                                collision = True
                                break
                    if not collision:
                        chosen = candidate
                        break
            contexts[it["index"]] = chosen

    return contexts
