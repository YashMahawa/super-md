"""Shared stdlib-only parameter, revision, directory-grant, and native-path validators."""
from __future__ import annotations

import json
import os
import re
import sys
from collections.abc import Iterable, Mapping
from pathlib import Path, PurePath, PurePosixPath, PureWindowsPath
from typing import Any

_HEX_CHARS = frozenset("0123456789abcdef")
_WINDOWS_PATH_RE = re.compile(r"^(?:[A-Za-z]:[\\/]|\\\\)")
SYSTEM_PATH_ALIASES: tuple[tuple[str, str], ...] = (
    (("/var", "/private/var"), ("/tmp", "/private/tmp"), ("/etc", "/private/etc")) if sys.platform == "darwin" else ()
)


def require_sha256_revision(value: Any, *, field: str = "expected_revision", error_cls: type[Exception] = ValueError, hex_only: bool = True, message: str | None = None) -> str:
    """Require a 64-character SHA-256 revision string (lowercase hex by default)."""
    if not isinstance(value, str) or len(value) != 64 or (hex_only and any(ch not in _HEX_CHARS for ch in value)):
        raise error_cls(message or f"{field} must be the current SHA-256 revision")
    return value


def require_optional_sha256_revision(value: Any, *, field: str = "expected_revision", error_cls: type[Exception] = ValueError, hex_only: bool = True, message: str | None = None) -> str | None:
    """Validate an optional SHA-256 revision when supplied."""
    return None if value is None else require_sha256_revision(value, field=field, error_cls=error_cls, hex_only=hex_only, message=message)


def require_nonneg_int(value: Any, *, field: str = "offset", max_value: int | None = None, error_cls: type[Exception] = ValueError, message: str | None = None) -> int:
    """Require a nonnegative integer (rejecting booleans) with an optional upper bound."""
    if isinstance(value, bool) or not isinstance(value, int) or value < 0 or (max_value is not None and value > max_value):
        if message is not None:
            raise error_cls(message)
        raise error_cls(f"{field} must be between 0 and {max_value:,}" if max_value is not None else f"{field} must be a nonnegative integer")
    return value


def require_int_range(value: Any, min_value: int, max_value: int, *, field: str = "limit", error_cls: type[Exception] = ValueError, message: str | None = None) -> int:
    """Require an integer within ``[min_value, max_value]`` (rejecting booleans)."""
    if isinstance(value, bool) or not isinstance(value, int) or not min_value <= value <= max_value:
        raise error_cls(message or f"{field} must be between {min_value:,} and {max_value:,}")
    return value


def require_bool_flags(mapping: Mapping[str, Any], keys: Iterable[str], *, error_cls: type[Exception] = ValueError, message: str | None = None) -> None:
    """Ensure every present flag key in ``mapping`` is a strict boolean."""
    for key in keys:
        if key in mapping and not isinstance(mapping[key], bool):
            raise error_cls(message or f"{key} must be a boolean")


def require_identifier(value: Any, *, field: str, max_len: int = 128, error_cls: type[Exception] = ValueError, message: str | None = None) -> str:
    """Require a bounded non-empty string identifier."""
    if not isinstance(value, str) or not value or len(value) > max_len:
        raise error_cls(message or f"{field} is required")
    return value


def require_diagram_id(value: Any, *, max_len: int = 100, require_prefix: bool = True, error_cls: type[Exception] = ValueError, message: str | None = None) -> str:
    """Require a bounded diagram source reference."""
    if not isinstance(value, str) or not value or len(value) > max_len or (require_prefix and not value.startswith("diagram:")):
        raise error_cls(message or "diagramId is invalid")
    return value


def require_heading_selector(heading: Any, *, error_cls: type[Exception] = ValueError) -> int | str | None:
    """Validate an optional nonnegative outline index or non-empty heading title/slug."""
    if heading is None or (isinstance(heading, int) and not isinstance(heading, bool) and heading >= 0):
        return heading
    if isinstance(heading, str) and bool(heading.strip()) and len(heading) <= 300:
        return heading
    raise error_cls("heading must be an outline index, exact title, slug, or numbered heading prefix")


def require_search_params(query: Any, limit: Any = 10, context: Any = 100, offset: Any = 0, *, max_offset: int | None = None, flags: Mapping[str, Any] | Iterable[Any] = (), error_cls: type[Exception] = ValueError) -> tuple[str, int, int, int]:
    """Validate search query, limit, context, offset, and optional boolean filter flags."""
    if not isinstance(query, str) or not query or len(query) > 500:
        raise error_cls("query must contain between 1 and 500 characters")
    checked = (query, require_int_range(limit, 1, 25, field="limit", error_cls=error_cls),
               require_int_range(context, 0, 500, field="context", error_cls=error_cls),
               require_nonneg_int(offset, field="offset", max_value=max_offset, error_cls=error_cls))
    if isinstance(flags, Mapping):
        require_bool_flags(flags, flags.keys(), error_cls=error_cls)
    else:
        for item in flags:
            if isinstance(item, tuple) and len(item) == 2:
                if not isinstance(item[1], bool):
                    raise error_cls(f"{item[0]} must be a boolean")
            elif not isinstance(item, bool):
                raise error_cls("search flags must be booleans")
    return checked


def require_viewport_width(width: Any, *, min_width: int = 64, max_width: int = 1600, error_cls: type[Exception] = ValueError, message: str | None = None) -> int:
    """Require an integer viewport render width in pixels."""
    if isinstance(width, bool) or not isinstance(width, int) or not min_width <= width <= max_width:
        raise error_cls(message or f"width must be between {min_width:,} and {max_width:,} pixels")
    return width


def require_image_format(image_format: Any, *, field: str = "image_format", error_cls: type[Exception] = ValueError) -> str:
    """Require a supported live raster snapshot format (``png`` or ``jpeg``)."""
    if image_format not in ("png", "jpeg"):
        raise error_cls(f"{field} must be png or jpeg")
    return image_format


def require_repair_indices(indices: Any, *, allow_empty: bool = True, max_items: int = 40, field: str = "repair_indices", error_cls: type[Exception] = ValueError, message: str | None = None) -> list[int]:
    """Require up to ``max_items`` unique nonnegative LaTeX repair indices."""
    if (not isinstance(indices, list) or len(indices) > max_items or (not allow_empty and not indices)
            or any(not isinstance(v, int) or isinstance(v, bool) or v < 0 for v in indices) or len(set(indices)) != len(indices)):
        if message is not None:
            raise error_cls(message)
        if not allow_empty and isinstance(indices, list) and not indices:
            raise error_cls(f"{field} requires 1–{max_items} unique nonnegative repair indexes")
        raise error_cls(f"{field} must be up to {max_items} unique nonnegative repair indexes")
    return indices


def require_export_params(format_value: Any, *, options: Any = None, filename: Any = None, allowed_formats: tuple[str, ...] = ("pdf", "smd", "md"), require_safe_basename: bool = False, error_cls: type[Exception] = ValueError) -> tuple[str, dict[str, Any] | None, str | None]:
    """Validate export format, bounded JSON options dict, and optional basename."""
    if format_value not in allowed_formats:
        choices = ", ".join(allowed_formats[:-1]) + f", or {allowed_formats[-1]}" if len(allowed_formats) > 2 else " or ".join(allowed_formats)
        raise error_cls(f"format must be {choices}")
    if options is not None:
        if not isinstance(options, dict):
            raise error_cls("Export options must be an object smaller than 8 KB")
        try:
            encoded = json.dumps(options, ensure_ascii=False).encode("utf-8")
        except (TypeError, ValueError, UnicodeError) as exc:
            raise error_cls("Export options must be an object smaller than 8 KB") from exc
        if len(encoded) > 8_000:
            raise error_cls("Export options must be an object smaller than 8 KB")
    if filename is not None and (not isinstance(filename, str) or len(filename) > 160 or (require_safe_basename and any(ch in filename for ch in ("/", "\\", "\0")))):
        raise error_cls("filename must be a short basename")
    return format_value, options, filename


def strip_extended_length_prefix(raw: str) -> str:
    """Strip Win32 extended-length path prefixes (\\\\?\\) without trimming outer whitespace."""
    return ("\\\\" + raw.removeprefix("\\\\?\\UNC\\")) if raw.startswith("\\\\?\\UNC\\") else raw.removeprefix("\\\\?\\")


def _pure_native_path(raw: str) -> PurePath:
    return PureWindowsPath(raw) if (os.name == "nt" or _WINDOWS_PATH_RE.match(raw)) else PurePosixPath(raw)


def is_link_or_junction(path: Path) -> bool:
    """Return True when *path* itself is a symbolic link or NTFS junction."""
    is_junction = getattr(path, "is_junction", None)
    return path.is_symlink() or bool(callable(is_junction) and is_junction())


def has_link_or_junction_component(path: Path) -> bool:
    """Return True when any path component under *path.anchor* is a symlink or junction."""
    current = Path(path.anchor)
    for part in path.parts[1:]:
        current = current / part
        try:
            if is_link_or_junction(current):
                return True
        except OSError:
            return True
    return False


def is_hidden_name(name: str) -> bool:
    """Return True when a filesystem entry basename is hidden (dot-prefixed)."""
    return bool(name and name not in (".", "..") and name.startswith("."))


def canonical_native_path_str(path: str | os.PathLike[str] | None) -> str:
    """Resolve and normalize *path* while preserving significant outer filesystem whitespace."""
    if path is None:
        return ""
    raw = strip_extended_length_prefix(os.fspath(path) if isinstance(path, os.PathLike) else str(path))
    if not raw or not raw.strip():
        return ""
    try:
        return os.path.normpath(strip_extended_length_prefix(str(os.path.realpath(raw))))
    except OSError:
        return os.path.normpath(raw)


def normalize_native_path_key(path: str | os.PathLike[str] | None) -> str:
    """Return an OS-normalized path comparison key preserving significant outer whitespace."""
    canon = canonical_native_path_str(path)
    if not canon:
        return ""
    key = os.path.normcase(canon).replace("\\", "/") if os.name == "nt" else os.path.normcase(canon)
    while len(key) > 1 and key.endswith("/") and not (os.name == "nt" and len(key) == 3 and key[1] == ":"):
        key = key[:-1]
    return key


def same_native_path(left: str | os.PathLike[str] | None, right: str | os.PathLike[str] | None) -> bool:
    """Return True when *left* and *right* refer to the same canonical native path."""
    left_key, right_key = normalize_native_path_key(left), normalize_native_path_key(right)
    return bool(left_key and right_key and left_key == right_key)


def has_hidden_relative_segment(path: Path, root: Path) -> bool:
    """Return True if any path segment of *path* relative to *root* is dot-prefixed."""
    try:
        rel_parts = path.relative_to(root).parts
    except ValueError:
        path_key, root_key = normalize_native_path_key(path), normalize_native_path_key(root)
        if not path_key or not root_key or path_key == root_key or not path_key.startswith(root_key if root_key.endswith("/") else root_key + "/"):
            return False
        canon_path, canon_root = _pure_native_path(canonical_native_path_str(path)), _pure_native_path(canonical_native_path_str(root))
        rel_parts = canon_path.parts[len(canon_root.parts):] if len(canon_path.parts) > len(canon_root.parts) else ()
    return any(is_hidden_name(part) for part in rel_parts)


def rewrite_system_path_alias(path: Path, system_aliases: tuple[tuple[str, str], ...] | None = None) -> Path:
    """Rewrite macOS system symlink roots (/var, /tmp, /etc) to canonical /private paths."""
    for raw_alias, raw_canonical in (SYSTEM_PATH_ALIASES if system_aliases is None else system_aliases):
        alias, canonical = Path(raw_alias), Path(raw_canonical)
        try:
            if alias.is_symlink() and alias.resolve(strict=True) == canonical.resolve(strict=True) and (path == alias or alias in path.parents):
                return canonical / path.relative_to(alias)
        except (OSError, RuntimeError):
            continue
    return path


def canonical_approved_directory(raw_value: Any, *, system_aliases: tuple[tuple[str, str], ...] | None = None) -> Path | None:
    """Validate an existing approved directory while preserving exact native path identity."""
    if raw_value is None or not isinstance(raw_value, (str, os.PathLike)):
        return None
    raw = strip_extended_length_prefix(os.fspath(raw_value) if isinstance(raw_value, os.PathLike) else raw_value)
    if not raw or not raw.strip() or "\0" in raw or len(raw) > 4096:
        return None
    try:
        expanded = Path(os.path.expanduser(raw))
        if is_link_or_junction(expanded):
            return None
        aliased = rewrite_system_path_alias(Path(os.path.abspath(expanded)), system_aliases)
        if has_link_or_junction_component(aliased):
            return None
        resolved = Path(strip_extended_length_prefix(str(aliased.resolve(strict=True))))
    except (OSError, RuntimeError, ValueError):
        return None
    return resolved if resolved.is_dir() else None


def is_disallowed_root_setting(raw_value: str, *, system_aliases: tuple[tuple[str, str], ...] | None = None) -> bool:
    """Return True if a persisted root setting is malformed, a symlink/junction, or a non-directory."""
    cleaned = strip_extended_length_prefix(raw_value)
    if not cleaned or not cleaned.strip():
        return False
    try:
        expanded = Path(os.path.expanduser(cleaned))
        if is_link_or_junction(expanded):
            return True
        aliased = rewrite_system_path_alias(Path(os.path.abspath(expanded)), system_aliases)
        return has_link_or_junction_component(aliased) or (aliased.exists() and not aliased.is_dir())
    except (OSError, RuntimeError, ValueError):
        return True


def normalize_approved_roots(roots: Any, *, system_aliases: tuple[tuple[str, str], ...] | None = None) -> list[str]:
    """Normalize explicit directory roots without trimming significant outer whitespace."""
    normalized, seen = [], set()
    for candidate in roots or ():
        resolved = canonical_approved_directory(candidate, system_aliases=system_aliases)
        if resolved is not None and (key := normalize_native_path_key(resolved)) and key not in seen:
            seen.add(key)
            normalized.append(str(resolved))
    return normalized


def _ensure_no_link_components(path_obj: Path, *, skip_dots: bool, outside_msg: str, unavail_msg: str, error_cls: type[Exception]) -> None:
    current = Path(path_obj.anchor)
    for part in path_obj.parts[1:]:
        current = current / part
        if skip_dots and part in (".", ".."):
            continue
        try:
            if is_link_or_junction(current):
                raise error_cls(outside_msg)
        except OSError as error:
            raise error_cls(unavail_msg) from error


def _collect_approved_entries(items: Iterable[Any], *, want_dir: bool, system_aliases: tuple[tuple[str, str], ...] | None) -> tuple[list[Path], list[tuple[Path, Path]]]:
    canonicals: list[Path] = []
    aliases: list[tuple[Path, Path]] = []
    for item in items:
        raw = strip_extended_length_prefix(os.fspath(item) if isinstance(item, os.PathLike) else str(item or ""))
        if not raw or not raw.strip() or "\0" in raw:
            continue
        try:
            supplied = Path(os.path.abspath(os.path.expanduser(raw)))
            aliased = rewrite_system_path_alias(supplied, system_aliases)
            if (not want_dir and is_hidden_name(aliased.name)) or has_link_or_junction_component(aliased):
                continue
            canon = Path(strip_extended_length_prefix(str(aliased.resolve(strict=True))))
        except (OSError, RuntimeError, ValueError):
            continue
        if canon.is_dir() if want_dir else (canon.is_file() and not is_hidden_name(canon.name)):
            if canon not in canonicals:
                canonicals.append(canon)
            for alias_cand in (supplied, aliased):
                if alias_cand != canon and (alias_cand, canon) not in aliases:
                    aliases.append((alias_cand, canon))
    aliases.sort(key=lambda pair: len(pair[0].parts), reverse=True)
    return canonicals, aliases


def _rewrite_supplied_prefix(path_obj: Path, root_aliases: list[tuple[Path, Path]], file_aliases: list[tuple[Path, Path]] = ()) -> Path:
    for sup_root, can_root in root_aliases:
        if path_obj == sup_root or sup_root in path_obj.parents:
            return can_root / path_obj.relative_to(sup_root)
    for sup_file, can_file in file_aliases:
        if path_obj == sup_file:
            return can_file
    return path_obj


def validate_approved_local_file_path(
    raw_path: Any, *, note_path: Path | None = None, extra_roots: Iterable[Path] = (),
    approved_files: Iterable[str | Path] = (), allow_note_parent: bool = False,
    unavailable_message: str, outside_message: str, error_cls: type[Exception] = ValueError,
    system_aliases: tuple[tuple[str, str], ...] | None = None,
) -> Path:
    """Validate local file paths against explicit directory grants and individual approved notes."""
    if not isinstance(raw_path, str) or not raw_path.strip() or len(raw_path) > 4096 or "\0" in raw_path:
        raise error_cls(unavailable_message)
    cleaned_raw = strip_extended_length_prefix(raw_path)
    if not cleaned_raw or not cleaned_raw.strip():
        raise error_cls(unavailable_message)
    candidate = Path(os.path.expanduser(cleaned_raw))
    if not candidate.is_absolute() and any(is_hidden_name(part) for part in candidate.parts):
        raise error_cls(outside_message)

    root_inputs = ([note_path.parent] if note_path is not None and allow_note_parent else []) + [Path(r) for r in extra_roots if r]
    canonical_roots, root_aliases = _collect_approved_entries(root_inputs, want_dir=True, system_aliases=system_aliases)
    canonical_file_list, file_aliases = _collect_approved_entries(approved_files, want_dir=False, system_aliases=system_aliases)
    canonical_files = set(canonical_file_list)

    candidate_paths: list[Path] = [candidate] if candidate.is_absolute() else [r / candidate for r in canonical_roots]
    if not candidate.is_absolute():
        if len(candidate.parts) == 1 and len(matched := [f for f in canonical_file_list if f.name == candidate.name]) == 1:
            candidate_paths.append(matched[0])
        if not candidate_paths:
            raise error_cls(outside_message)

    def _rewrite_raw(path_obj: Path) -> Path:
        rewritten = rewrite_system_path_alias(path_obj, system_aliases)
        for sup_root, can_root in root_aliases:
            if len(rewritten.parts) >= len(sup_root.parts) and rewritten.parts[:len(sup_root.parts)] == sup_root.parts:
                tail = rewritten.parts[len(sup_root.parts):]
                return can_root.joinpath(*tail) if tail else can_root
        for sup_file, can_file in file_aliases:
            if rewritten.parts == sup_file.parts:
                return can_file
        return rewritten

    def _traversed_hidden(raw_obj: Path, base_obj: Path) -> bool:
        common = 0
        for left, right in zip(raw_obj.parts, base_obj.parts):
            if normalize_native_path_key(left) != normalize_native_path_key(right):
                break
            common += 1
        return any(is_hidden_name(part) for part in raw_obj.parts[common:])

    saw_missing = False
    for attempt in candidate_paths:
        raw_attempt = _rewrite_raw(attempt if attempt.is_absolute() else Path(os.getcwd()) / attempt)
        _ensure_no_link_components(raw_attempt, skip_dots=True, outside_msg=outside_message, unavail_msg=unavailable_message, error_cls=error_cls)
        absolute = _rewrite_supplied_prefix(rewrite_system_path_alias(Path(os.path.abspath(attempt)), system_aliases), root_aliases, file_aliases)
        _ensure_no_link_components(absolute, skip_dots=False, outside_msg=outside_message, unavail_msg=unavailable_message, error_cls=error_cls)
        try:
            resolved = Path(strip_extended_length_prefix(str(raw_attempt.resolve(strict=True))))
        except (OSError, RuntimeError):
            saw_missing = True
            continue
        if not resolved.is_file() or is_hidden_name(resolved.name):
            raise error_cls(outside_message)
        if resolved in canonical_files:
            if _traversed_hidden(raw_attempt, resolved):
                raise error_cls(outside_message)
            return resolved
        for can_root in canonical_roots:
            if can_root in resolved.parents:
                if has_hidden_relative_segment(resolved, can_root) or has_hidden_relative_segment(absolute, can_root) or _traversed_hidden(raw_attempt, can_root):
                    raise error_cls(outside_message)
                return resolved
    if saw_missing and (candidate.is_absolute() or len(candidate_paths) == 1):
        probe = _rewrite_supplied_prefix(rewrite_system_path_alias(Path(os.path.abspath(candidate_paths[0])), system_aliases), root_aliases)
        if any(can_root in probe.parents and not has_hidden_relative_segment(probe, can_root) for can_root in canonical_roots):
            raise error_cls(unavailable_message)
    raise error_cls(outside_message)


def _active_windows(studio: Any) -> list[Any]:
    windows = [studio]
    session = getattr(studio, "session", None)
    if session is not None and isinstance(getattr(session, "windows", None), dict):
        windows.extend(w for w in session.windows.values() if w is not studio and not getattr(w, "retired", False))
    return windows


def approved_agent_roots(studio: Any, *, system_aliases: tuple[tuple[str, str], ...] | None = None) -> list[Path]:
    """Collect explicit workspace roots across non-retired windows plus configured newNoteLocation."""
    candidates = [getattr(w, "folder", "") for w in _active_windows(studio)]
    settings = getattr(studio, "settings", None)
    if isinstance(settings, dict):
        candidates.append(settings.get("newNoteLocation"))
    roots, seen = [], set()
    for item in candidates:
        if (
            item
            and (resolved := canonical_approved_directory(item, system_aliases=system_aliases)) is not None
            and (key := normalize_native_path_key(resolved))
            and key not in seen
        ):
            seen.add(key)
            roots.append(resolved)
    return roots


def is_agent_created_tab(studio: Any, tab: dict[str, Any]) -> bool:
    """Return True when *tab* was created or saved-as by agent automation without user note grant."""
    if not isinstance(tab, dict):
        return False
    if tab.get("agentCreated"):
        return True
    tab_path = tab.get("path")
    if not isinstance(tab_path, str) or not tab_path:
        return False
    owned = getattr(studio, "_agent_owned_files", None) or getattr(getattr(studio, "session", None), "agent_owned_files", None)
    canon = canonical_native_path_str(tab_path) if owned else ""
    return bool(canon and any(same_native_path(item, canon) for item in owned))


def is_automation_opened_tab(studio: Any, tab: dict[str, Any]) -> bool:
    """Return True when *tab* was opened solely via automation rather than an explicit user grant."""
    if not isinstance(tab, dict) or not tab.get("agentOpened") or is_agent_created_tab(studio, tab):
        return False
    tab_path = tab.get("path")
    if isinstance(tab_path, str) and tab_path:
        return not any(same_native_path(item, tab_path) for item in (getattr(studio, "_agent_open_paths", None) or ()))
    return True


def approved_individual_agent_files(studio: Any) -> list[str]:
    """Collect explicitly user-authorized and agent-owned individual note file paths."""
    approved, seen = [], set()

    def _add(entry: Any) -> None:
        if isinstance(entry, str) and entry and (key := normalize_native_path_key(entry)) and key not in seen:
            seen.add(key)
            approved.append(entry)

    for collection in (getattr(studio, "_agent_open_paths", ()), getattr(studio, "_agent_owned_files", ())):
        for entry in collection or ():
            _add(entry)
    for window in _active_windows(studio):
        for tab in getattr(window, "tabs", ()) or ():
            if isinstance(tab, dict) and not is_agent_created_tab(window, tab) and not is_automation_opened_tab(window, tab):
                _add(tab.get("path"))
    return approved


def resolve_agent_open_path(studio: Any, raw_path: Any, *, error_cls: type[Exception] = ValueError, system_aliases: tuple[tuple[str, str], ...] | None = None) -> Path:
    """Resolve a live open_document target against explicit directory roots and individual note grants."""
    msg = "The file is outside the approved agent note roots"
    return validate_approved_local_file_path(
        raw_path if isinstance(raw_path, str) else str(raw_path),
        extra_roots=approved_agent_roots(studio, system_aliases=system_aliases),
        approved_files=approved_individual_agent_files(studio),
        allow_note_parent=False, unavailable_message=msg, outside_message=msg, error_cls=error_cls, system_aliases=system_aliases,
    )


def agent_path_allowed(studio: Any, path: Path | str, *, system_aliases: tuple[tuple[str, str], ...] | None = None) -> bool:
    """Return True if *path* is covered by an active directory grant or individual note grant."""
    try:
        resolve_agent_open_path(studio, str(path), system_aliases=system_aliases)
    except ValueError:
        return False
    return True


def _is_delegating_studio_method(fn: Any) -> bool:
    return getattr(getattr(fn, "__func__", fn), "__dict__", {}).get("_delegates_to_shared_validator") is True


def is_tab_live_authorized(studio: Any, tab: dict[str, Any] | None) -> bool:
    """Return False when an automation-opened tab's directory grant has been revoked."""
    if not isinstance(tab, dict):
        return True
    checker = getattr(studio, "_is_tab_live_authorized", None)
    if callable(checker) and not _is_delegating_studio_method(checker):
        return bool(checker(tab))
    if is_automation_opened_tab(studio, tab):
        tab_path = tab.get("path")
        if isinstance(tab_path, str) and tab_path:
            path_checker = getattr(studio, "_agent_path_allowed", None)
            return bool(path_checker(tab_path)) if callable(path_checker) and not _is_delegating_studio_method(path_checker) else agent_path_allowed(studio, tab_path)
    return True


def require_tab_live_authorized(studio: Any, tab: dict[str, Any] | None, *, action: str = "", error_cls: type[Exception] = ValueError, message: str = "The file is outside the approved agent note roots") -> None:
    """Raise *error_cls* when *tab* is no longer authorized for live agent access."""
    if action != "close_document" and not is_tab_live_authorized(studio, tab):
        raise error_cls(message)


_PEER_MODULE = "agent.validators" if __name__ == "desktop.agent.validators" else ("desktop.agent.validators" if __name__ == "agent.validators" else None)
if _PEER_MODULE and _PEER_MODULE in sys.modules:
    sys.modules[__name__] = sys.modules[_PEER_MODULE]
