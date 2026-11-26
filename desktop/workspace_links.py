"""Shared vault-free workspace note link resolution and containment helpers."""
from __future__ import annotations

import os
import re
import urllib.parse
from pathlib import Path, PurePosixPath

NOTE_EXTENSIONS = (".md", ".smd", ".fmd", ".markdown", ".txt")
_ENCODED_SEP = re.compile(r"%2f|%5c", re.IGNORECASE)
_ENCODED_NUL = re.compile(r"%00", re.IGNORECASE)


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
        if hasattr(os.path, "isjunction") and os.path.isjunction(path):
            return True
    except OSError:
        return False
    return _is_macos_alias_file(path)


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
        raise WorkspaceLinkError("Linked note symlink paths are not allowed.")
    parent_supplied = note_supplied.parent
    if _is_link_or_junction(parent_supplied):
        raise WorkspaceLinkError("Linked note symlink paths are not allowed.")
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
                raise WorkspaceLinkError("Linked note symlink paths are not allowed.")
            try:
                cur_resolved = cur.resolve(strict=True)
            except OSError as exc:
                raise WorkspaceLinkError("Note folder is unavailable.") from exc
            if cur_resolved == ws_boundary:
                break
            if cur.parent == cur:
                raise WorkspaceLinkError("Linked note symlink paths are not allowed.")
            cur = cur.parent
    return note_dir


def _walk_within_boundary(base_dir: Path, rel_path: str, boundary: Path) -> Path:
    current = base_dir
    for part in PurePosixPath(rel_path).parts:
        if part in ("", "."):
            continue
        if part == "..":
            if current == boundary:
                raise WorkspaceLinkError("Linked note is outside the authorized folder.")
            parent = current.parent
            if parent != boundary and boundary not in parent.parents:
                raise WorkspaceLinkError("Linked note is outside the authorized folder.")
            current = parent
        else:
            nxt = current / part
            if _is_link_or_junction(nxt):
                raise WorkspaceLinkError("Linked note symlink paths are not allowed.")
            current = nxt
    if current != boundary and boundary not in current.parents:
        raise WorkspaceLinkError("Linked note is outside the authorized folder.")
    return current


def _probe_candidate(base_dir: Path, rel_path: str, boundary: Path) -> Path | None:
    candidates = [rel_path] if _has_supported_note_extension(rel_path) else [
        *(f"{rel_path}{ext}" for ext in NOTE_EXTENSIONS),
    ]
    for candidate_rel in candidates:
        walked = _walk_within_boundary(base_dir, candidate_rel, boundary)
        try:
            if walked.is_file() and walked.suffix.lower() in NOTE_EXTENSIONS:
                resolved = walked.resolve(strict=True)
                if resolved != boundary and boundary not in resolved.parents:
                    raise WorkspaceLinkError("Linked note is outside the authorized folder.")
                return resolved
        except WorkspaceLinkError:
            raise
        except OSError:
            continue
    return None


def resolve_workspace_link(
    target: str,
    *,
    wikilink: bool = False,
    note_path: str | os.PathLike[str] | None,
    workspace_folder: str | os.PathLike[str] | None = None,
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
        if (not cleaned.startswith(("./", "../"))
                and ".." not in PurePosixPath(cleaned).parts
                and note_dir != boundary):
            from_root = _probe_candidate(boundary, cleaned, boundary)
            if from_root is not None:
                return from_root
        raise WorkspaceLinkError(f"Linked note not found: {cleaned}")

    if note_dir is not None:
        direct = _probe_candidate(note_dir, cleaned, boundary)
        if direct is not None:
            return direct
    if note_dir != boundary:
        from_root = _probe_candidate(boundary, cleaned, boundary)
        if from_root is not None:
            return from_root

    raise WorkspaceLinkError(f"Linked note not found: {cleaned}")
