"""Desktop filename quick switcher backed by workspace roots and the shared folder note index."""
from __future__ import annotations

import os
import stat
import threading
from pathlib import Path
from typing import Callable, Iterable

import folder_ops
from workspace_search import MAX_FOLDER_DEPTH, MAX_WALK_ENTRIES, canonical_note_key, walk_folder_notes

QUICK_SWITCHER_SUFFIXES = (".md", ".smd")
MAX_QUICK_SWITCHER_RESULTS = 100
DirStamp = tuple[int, int, int, int]


def is_quick_switcher_note_name(name: str) -> bool:
    """Return True when *name* is a visible `.md` or `.smd` note filename."""
    if not name or name.startswith("."):
        return False
    return folder_ops.note_extension(name).lower() in QUICK_SWITCHER_SUFFIXES


def _clean_native_path_str(value: str | os.PathLike[str] | None) -> str:
    """Strip Win32 extended-length prefixes while preserving significant outer whitespace."""
    if value is None or not isinstance(value, (str, os.PathLike)):
        return ""
    raw = folder_ops.strip_extended_length_prefix(
        os.fspath(value) if isinstance(value, os.PathLike) else value
    )
    if not raw or not raw.strip() or "\x00" in raw:
        return ""
    return raw


def _note_cache_key(path: str | os.PathLike[str] | None) -> str:
    cleaned = _clean_native_path_str(path)
    if not cleaned:
        return ""
    expanded = os.path.expanduser(cleaned)
    return folder_ops.normalize_path_key(expanded) or canonical_note_key(expanded)


def _resolve_index_root(folder_root: str | os.PathLike[str] | None) -> tuple[Path, str] | None:
    raw = _clean_native_path_str(folder_root)
    if not raw:
        return None
    try:
        candidate = Path(os.path.expanduser(raw))
        if folder_ops._is_link_or_junction(candidate) or not candidate.is_dir():
            return None
        resolved = Path(folder_ops.canonical_path_str(candidate.resolve(strict=True)))
        if not resolved.is_dir():
            return None
    except OSError:
        return None
    key = folder_ops.normalize_path_key(resolved)
    return (resolved, key) if key else None


def _dir_stamp(path: Path) -> DirStamp | None:
    try:
        st = path.stat(follow_symlinks=False)
    except OSError:
        return None
    if stat.S_ISLNK(st.st_mode) or not stat.S_ISDIR(st.st_mode):
        return None
    if folder_ops._is_link_or_junction(path):
        return None
    return (
        st.st_mtime_ns,
        getattr(st, "st_ctime_ns", 0),
        getattr(st, "st_ino", 0),
        getattr(st, "st_dev", 0),
    )


def _collect_dir_snapshot(
    root: Path,
    *,
    cancel_event: threading.Event | None = None,
) -> tuple[tuple[tuple[str, DirStamp], ...], frozenset[str]] | None:
    stamps: list[tuple[str, DirStamp]] = []
    note_paths: set[str] = set()
    stack: list[tuple[Path, int]] = [(root, 0)]
    visited = 0
    while stack and visited < MAX_WALK_ENTRIES:
        if cancel_event is not None and cancel_event.is_set():
            return None
        current, depth = stack.pop()
        if depth > MAX_FOLDER_DEPTH:
            continue
        stamp = _dir_stamp(current)
        if stamp is None:
            return None
        stamps.append((folder_ops.canonical_path_str(current), stamp))
        visited += 1
        try:
            with os.scandir(current) as entries:
                for entry in entries:
                    if cancel_event is not None and cancel_event.is_set():
                        return None
                    if entry.name.startswith("."):
                        continue
                    try:
                        entry_path = Path(entry.path)
                        if entry.is_symlink() or folder_ops._is_link_or_junction(entry_path):
                            continue
                        if entry.is_dir(follow_symlinks=False):
                            if depth < MAX_FOLDER_DEPTH:
                                stack.append((entry_path, depth + 1))
                        elif entry.is_file(follow_symlinks=False) and is_quick_switcher_note_name(entry.name):
                            canon = folder_ops.canonical_path_str(entry.path)
                            if canon:
                                note_paths.add(canon)
                    except OSError:
                        return None
        except OSError:
            return None
    if stack:
        return None
    stamps.sort(key=lambda item: item[0])
    return tuple(stamps), frozenset(note_paths)


def _collect_dir_stamps(root: Path) -> tuple[tuple[str, DirStamp], ...]:
    snapshot = _collect_dir_snapshot(root)
    return snapshot[0] if snapshot is not None else ()


class FolderNoteIndex:
    """Thread-safe in-memory folder index reusing `walk_folder_notes` across quick-switcher queries."""

    def __init__(
        self,
        *,
        on_invalidate: Callable[[str | os.PathLike[str] | None], None] | None = None,
    ) -> None:
        self._lock = threading.Lock()
        self._entries: dict[str, tuple[list[dict], tuple[tuple[str, DirStamp], ...]]] = {}
        self._generation = 0
        self._on_invalidate = on_invalidate

    def _evict_matching(self, target_path: str | os.PathLike[str] | None) -> bool:
        with self._lock:
            self._generation += 1
            raw = _clean_native_path_str(target_path)
            if not raw:
                had_entries = bool(self._entries)
                self._entries.clear()
                return had_entries
            expanded = os.path.expanduser(raw)
            to_drop = [
                root_key
                for root_key in self._entries
                if folder_ops.matches_path_prefix(expanded, root_key, is_directory=True)
                or folder_ops.matches_path_prefix(root_key, expanded, is_directory=True)
                or (
                    raw != expanded
                    and (
                        folder_ops.matches_path_prefix(raw, root_key, is_directory=True)
                        or folder_ops.matches_path_prefix(root_key, raw, is_directory=True)
                    )
                )
            ]
            for root_key in to_drop:
                self._entries.pop(root_key, None)
            return bool(to_drop)

    def peek_entries(self, folder_root: str | os.PathLike[str]) -> list[dict] | None:
        raw = _clean_native_path_str(folder_root)
        if not raw:
            return []
        resolved_pair = _resolve_index_root(raw)
        key = resolved_pair[1] if resolved_pair is not None else folder_ops.normalize_path_key(os.path.expanduser(raw))
        if not key:
            return []
        with self._lock:
            cached = self._entries.get(key)
            return list(cached[0]) if cached is not None else None

    def get_entries(
        self,
        folder_root: str | os.PathLike[str],
        *,
        cancel_event: threading.Event | None = None,
        revalidate: bool = True,
    ) -> list[dict]:
        raw = _clean_native_path_str(folder_root)
        if not raw:
            return []
        resolved_pair = _resolve_index_root(raw)
        if resolved_pair is None:
            if self._evict_matching(raw) and self._on_invalidate is not None:
                self._on_invalidate(raw)
            return []
        resolved, key = resolved_pair

        with self._lock:
            scan_gen = self._generation
            cached = self._entries.get(key)

        if cached is not None:
            entries, stamps = cached
            if not revalidate:
                return list(entries)
            if stamps and all(_dir_stamp(Path(dpath)) == expected for dpath, expected in stamps):
                return list(entries)

        pre_snapshot = _collect_dir_snapshot(resolved, cancel_event=cancel_event)
        if cancel_event is not None and cancel_event.is_set():
            return []

        walked = walk_folder_notes(resolved, cancel_event=cancel_event)
        if cancel_event is not None and cancel_event.is_set():
            return []

        filtered: list[dict] = []
        walked_paths: set[str] = set()
        for entry in walked:
            name = entry.get("name") or ""
            epath = entry.get("path") or ""
            if not epath or not is_quick_switcher_note_name(name):
                continue
            try:
                if folder_ops._is_link_or_junction(Path(epath)):
                    continue
            except OSError:
                continue
            canon_path = folder_ops.canonical_path_str(epath)
            if not canon_path:
                continue
            walked_paths.add(canon_path)
            filtered.append({
                "name": name,
                "path": canon_path,
                "relative": entry.get("relative") or name,
            })

        post_snapshot = _collect_dir_snapshot(resolved, cancel_event=cancel_event)
        if cancel_event is not None and cancel_event.is_set():
            return []

        coherent = False
        post_stamps: tuple[tuple[str, DirStamp], ...] = ()
        if pre_snapshot is not None and post_snapshot is not None:
            pre_stamps, pre_notes = pre_snapshot
            post_stamps, post_notes = post_snapshot
            notes_match = (
                walked_paths == post_notes
                if len(walked) < MAX_WALK_ENTRIES
                else (bool(walked_paths) and walked_paths.issubset(post_notes))
            )
            coherent = bool(
                post_stamps
                and pre_stamps == post_stamps
                and pre_notes == post_notes
                and notes_match
            )

        with self._lock:
            if coherent and self._generation == scan_gen:
                self._entries[key] = (filtered, post_stamps)
            elif cached is not None and self._entries.get(key) is cached:
                self._entries.pop(key, None)
        return list(filtered)

    def invalidate(self, target_path: str | os.PathLike[str] | None = None) -> None:
        self._evict_matching(target_path)
        if self._on_invalidate is not None:
            self._on_invalidate(target_path)


def normalize_workspace_roots(raw_roots: Iterable[str | os.PathLike[str] | None]) -> list[Path]:
    """Return deduplicated, non-symlink canonical directory roots preserving significant whitespace."""
    roots: list[Path] = []
    seen: set[str] = set()
    for raw in raw_roots:
        resolved_pair = _resolve_index_root(raw)
        if resolved_pair is None:
            continue
        resolved, key = resolved_pair
        if key not in seen:
            seen.add(key)
            roots.append(resolved)
    return roots


def coalesce_walk_roots(roots: list[Path]) -> list[Path]:
    """Keep top-level roots so nested workspace roots are not walked twice."""
    top_roots: list[Path] = []
    for root in sorted(roots, key=lambda p: len(p.parts)):
        if any(folder_ops.matches_path_prefix(str(root), str(parent), is_directory=True) for parent in top_roots):
            continue
        top_roots.append(root)
    return top_roots


def format_external_parent(parent: Path) -> str:
    """Format an external parent directory using `~` when inside the user's home directory."""
    canon = Path(folder_ops.canonical_path_str(parent))
    try:
        home = Path(folder_ops.canonical_path_str(Path.home()))
        if folder_ops.same_path(canon, home):
            return "~"
        if folder_ops.matches_path_prefix(str(canon), str(home), is_directory=True):
            rel = folder_ops.normalized_relpath(canon, home)
            return f"~/{rel}" if rel and rel != "." else "~"
    except (OSError, ValueError):
        pass
    return canon.as_posix() if os.name != "nt" else str(canon).replace("\\", "/")


def _matching_root(path_str: str, roots: list[Path]) -> Path | None:
    matches = [r for r in roots if folder_ops.matches_path_prefix(path_str, str(r), is_directory=True)]
    if not matches:
        return None
    return max(matches, key=lambda r: len(r.parts))


def _trailing_parent_segments(path_str: str, count: int) -> str:
    parent = Path(folder_ops.canonical_path_str(path_str)).parent
    parts = [p for p in parent.parts if p not in ("/", "\\")]
    if os.name == "nt" and parts and parts[0].endswith(":\\"):
        parts[0] = parts[0].rstrip("\\")
    if not parts:
        return format_external_parent(parent)
    if count >= len(parts):
        return format_external_parent(parent)
    return "/".join(parts[-count:])


def _assign_parent_paths(candidates: list[dict], display_roots: list[Path]) -> None:
    multi_root = len(display_roots) > 1
    for item in candidates:
        path_str = item.get("path") or ""
        if not path_str:
            item["parentPath"] = ""
            item["_relParent"] = ""
            item["_rootName"] = ""
            item["_depth"] = 0
            continue
        root = _matching_root(path_str, display_roots)
        if root is not None:
            try:
                rel_file = folder_ops.normalized_relpath(path_str, root)
            except ValueError:
                rel_file = item["name"]
            rel_parent = "" if "/" not in rel_file else rel_file.rsplit("/", 1)[0]
            root_name = root.name or format_external_parent(root)
            item["_relParent"] = rel_parent
            item["_rootName"] = root_name
            item["_depth"] = 0 if not rel_parent else rel_parent.count("/") + 1
            if multi_root:
                item["parentPath"] = f"{root_name}/{rel_parent}" if rel_parent else root_name
            else:
                item["parentPath"] = rel_parent if rel_parent else root_name
        else:
            parent_dir = Path(path_str).parent
            item["_relParent"] = ""
            item["_rootName"] = ""
            item["_depth"] = 99
            item["parentPath"] = format_external_parent(parent_dir)

    by_name: dict[str, list[dict]] = {}
    for item in candidates:
        by_name.setdefault(item["name"].casefold(), []).append(item)

    for group in by_name.values():
        if len(group) < 2:
            for item in group:
                item["duplicate"] = False
            continue
        unsaved_in_group = [it for it in group if not it.get("path")]
        for idx, it in enumerate(unsaved_in_group, start=1):
            it["duplicate"] = True
            it["parentPath"] = f"Unsaved tab {idx}" if len(unsaved_in_group) > 1 else "Unsaved tab"

        path_items = [it for it in group if it.get("path")]
        for it in path_items:
            it["duplicate"] = True

        # First disambiguate root-level vs same-named subfolder inside a single root (e.g. ws/a.md vs ws/ws/a.md).
        by_parent: dict[str, list[dict]] = {}
        for it in path_items:
            by_parent.setdefault(it["parentPath"].casefold(), []).append(it)
        for colliding in by_parent.values():
            if len(colliding) < 2:
                continue
            if any(not it["_relParent"] and it["_rootName"] for it in colliding):
                for it in colliding:
                    if it["_relParent"] and it["_rootName"]:
                        it["parentPath"] = f"{it['_rootName']}/{it['_relParent']}"

        # Expand ancestor directory segments until all distinct paths have distinct parentPath labels.
        depth_segments = 2
        while depth_segments <= 32:
            by_parent = {}
            for it in path_items:
                by_parent.setdefault(it["parentPath"].casefold(), []).append(it)
            unresolved = [
                colliding
                for colliding in by_parent.values()
                if len({it["key"] for it in colliding}) > 1
            ]
            if not unresolved:
                break
            progressed = False
            for colliding in unresolved:
                for it in colliding:
                    updated = _trailing_parent_segments(it["path"], depth_segments)
                    if updated != it["parentPath"]:
                        it["parentPath"] = updated
                        progressed = True
            depth_segments += 1
            if not progressed:
                for colliding in unresolved:
                    for it in colliding:
                        it["parentPath"] = format_external_parent(Path(it["path"]).parent)
                break


def build_quick_switcher_candidates(
    tabs_snapshot: list[dict],
    recent_paths: list[str],
    pinned_paths: list[str],
    workspace_roots: list[Path],
    root_entries: dict[str, list[dict]],
    *,
    active_id: str = "",
) -> list[dict]:
    """Build deduplicated `.md` and `.smd` quick-switcher candidates with disambiguating parent paths."""
    display_roots = coalesce_walk_roots(workspace_roots)
    pinned_keys = {k for p in pinned_paths if (k := _note_cache_key(p))}
    recent_rank_by_key: dict[str, int] = {}
    for idx, rpath in enumerate(recent_paths):
        rkey = _note_cache_key(rpath)
        if rkey and rkey not in recent_rank_by_key:
            recent_rank_by_key[rkey] = idx

    candidates: list[dict] = []
    by_key: dict[str, dict] = {}
    open_tab_paths: list[tuple[str, str, dict]] = []

    def _match_open_tab_samefile(candidate_path: str) -> dict | None:
        if not open_tab_paths or not candidate_path:
            return None
        cand_name_cf = Path(candidate_path).name.casefold()
        for raw_tab_path, tab_name_cf, tab_entry in open_tab_paths:
            if tab_name_cf != cand_name_cf:
                continue
            try:
                if not Path(candidate_path).is_symlink() and os.path.samefile(raw_tab_path, candidate_path):
                    return tab_entry
            except OSError:
                continue
        return None

    def _merge_open_tab_disk_path(tab_entry: dict, disk_path: str, disk_key: str) -> None:
        disk_name = Path(disk_path).name
        tab_entry["path"] = disk_path
        if tab_entry["name"].casefold() == disk_name.casefold():
            tab_entry["name"] = disk_name
            tab_entry["stem"] = folder_ops.note_stem(disk_name)
            tab_entry["ext"] = folder_ops.note_extension(disk_name).lower()
        if disk_key in pinned_keys:
            tab_entry["pinned"] = True
        if disk_key in recent_rank_by_key:
            tab_entry["recent"] = True
            tab_entry["_recentRank"] = min(tab_entry["_recentRank"], recent_rank_by_key[disk_key])
        by_key[disk_key] = tab_entry

    ordered_tabs = sorted(
        enumerate(tabs_snapshot),
        key=lambda pair: (0 if pair[1].get("id") == active_id else 1, pair[0]),
    )
    for tab_order, (_, tab) in enumerate(ordered_tabs):
        tab_id = tab.get("id") or ""
        raw_path = tab.get("path") or ""
        cleaned_tab_path = _clean_native_path_str(raw_path)
        canon_path = folder_ops.canonical_path_str(os.path.expanduser(cleaned_tab_path)) if cleaned_tab_path else ""
        name = tab.get("name") or (Path(canon_path).name if canon_path else "Untitled.md")
        if not is_quick_switcher_note_name(name):
            continue
        key = _note_cache_key(canon_path) if canon_path else f"tab:{tab_id}"
        if key in by_key:
            continue
        if raw_path and _match_open_tab_samefile(raw_path) is not None:
            continue
        entry = {
            "key": key,
            "tabId": tab_id,
            "path": canon_path,
            "name": name,
            "stem": folder_ops.note_stem(name),
            "ext": folder_ops.note_extension(name).lower(),
            "open": True,
            "active": tab_id == active_id,
            "dirty": bool(tab.get("dirty")),
            "pinned": bool(canon_path and key in pinned_keys),
            "recent": bool(canon_path and key in recent_rank_by_key),
            "_tabOrder": tab_order,
            "_recentRank": recent_rank_by_key.get(key, 10_000),
        }
        by_key[key] = entry
        candidates.append(entry)
        if raw_path:
            try:
                if not Path(raw_path).is_symlink():
                    open_tab_paths.append((raw_path, Path(canon_path).name.casefold(), entry))
            except OSError:
                pass

    # Include pinned and recent `.md` / `.smd` files on disk.
    combined_recent = list(dict.fromkeys([*pinned_paths, *recent_paths]))
    for rpath in combined_recent:
        cleaned_rpath = _clean_native_path_str(rpath)
        if not cleaned_rpath:
            continue
        key = _note_cache_key(cleaned_rpath)
        if not key or key in by_key:
            continue
        try:
            candidate = Path(os.path.expanduser(cleaned_rpath))
            if folder_ops._is_link_or_junction(candidate) or not candidate.is_file():
                continue
            canon_path = folder_ops.canonical_path_str(candidate.resolve(strict=True))
        except OSError:
            continue
        name = Path(canon_path).name
        if not is_quick_switcher_note_name(name):
            continue
        key = _note_cache_key(canon_path)
        if not key or key in by_key:
            continue
        samefile_tab = _match_open_tab_samefile(canon_path)
        if samefile_tab is not None:
            _merge_open_tab_disk_path(samefile_tab, canon_path, key)
            continue
        entry = {
            "key": key,
            "tabId": "",
            "path": canon_path,
            "name": name,
            "stem": folder_ops.note_stem(name),
            "ext": folder_ops.note_extension(name).lower(),
            "open": False,
            "active": False,
            "dirty": False,
            "pinned": key in pinned_keys,
            "recent": True,
            "_tabOrder": 10_000,
            "_recentRank": recent_rank_by_key.get(key, len(recent_rank_by_key)),
        }
        by_key[key] = entry
        candidates.append(entry)

    # Include `.md` and `.smd` notes from the workspace folder index.
    for root in display_roots:
        root_key = folder_ops.normalize_path_key(root)
        for fentry in root_entries.get(root_key, ()):
            fpath = fentry.get("path") or ""
            fname = fentry.get("name") or ""
            if not fpath or not is_quick_switcher_note_name(fname):
                continue
            key = _note_cache_key(fpath)
            if not key or key in by_key:
                continue
            samefile_tab = _match_open_tab_samefile(fpath)
            if samefile_tab is not None:
                _merge_open_tab_disk_path(samefile_tab, fpath, key)
                continue
            entry = {
                "key": key,
                "tabId": "",
                "path": fpath,
                "name": fname,
                "stem": folder_ops.note_stem(fname),
                "ext": folder_ops.note_extension(fname).lower(),
                "open": False,
                "active": False,
                "dirty": False,
                "pinned": key in pinned_keys,
                "recent": key in recent_rank_by_key,
                "_tabOrder": 10_000,
                "_recentRank": recent_rank_by_key.get(key, 10_000),
            }
            by_key[key] = entry
            candidates.append(entry)

    _assign_parent_paths(candidates, display_roots)
    return candidates


def _is_boundary(text: str, index: int) -> bool:
    if index <= 0:
        return True
    prev = text[index - 1]
    curr = text[index]
    if prev in " /\\-_." or not prev.isalnum():
        return True
    return prev.islower() and curr.isupper()


def _subsequence_score(needle: str, target_raw: str, target_cf: str) -> int | None:
    """Return fuzzy subsequence score on `target_cf`, or None if `needle` is not a subsequence."""
    if not needle:
        return 0
    nlen = len(needle)
    tlen = len(target_cf)
    if nlen > tlen:
        return None
    positions: list[int] = []
    cursor = 0
    for ch in needle:
        pos = target_cf.find(ch, cursor)
        if pos < 0:
            return None
        positions.append(pos)
        cursor = pos + 1

    # Prefer tighter rightmost-start matches when possible by scanning forward from a boundary if available.
    score = 120
    for idx, pos in enumerate(positions):
        if idx > 0 and pos == positions[idx - 1] + 1:
            score += 24
        if pos < len(target_raw) and _is_boundary(target_raw, pos):
            score += 18
    span = positions[-1] - positions[0] + 1
    score -= max(0, span - nlen) * 3
    score -= positions[0] * 2
    return score


def _score_token(token: str, item: dict) -> int | None:
    name_raw = item["name"]
    name_cf = name_raw.casefold()
    stem_cf = item["stem"].casefold()
    parent_raw = item["parentPath"]
    parent_cf = parent_raw.casefold()
    combined_raw = f"{parent_raw}/{name_raw}" if parent_raw else name_raw
    combined_cf = combined_raw.casefold()

    if "/" in token:
        if combined_cf == token or combined_cf.endswith("/" + token):
            return 950
        pos = combined_cf.find(token)
        if pos >= 0:
            bonus = 80 if pos == 0 or combined_cf[pos - 1] == "/" else 0
            return 760 + bonus - min(pos, 60)
        sub = _subsequence_score(token, combined_raw, combined_cf)
        return (320 + sub) if sub is not None else None

    if name_cf == token:
        return 1050
    if stem_cf == token:
        return 1020
    if name_cf.startswith(token):
        return 900 - min(len(name_cf) - len(token), 40)

    pos = name_cf.find(token)
    if pos >= 0:
        if pos < len(name_raw) and _is_boundary(name_raw, pos):
            return 830 - min(pos, 40)
        return 740 - min(pos, 50)

    if parent_cf:
        if parent_cf == token or parent_cf.endswith("/" + token):
            return 660
        ppos = parent_cf.find(token)
        if ppos >= 0:
            boundary = ppos == 0 or parent_cf[ppos - 1] in " /_-."
            return (620 if boundary else 560) - min(ppos, 40)

    name_sub = _subsequence_score(token, name_raw, name_cf)
    if name_sub is not None:
        return 400 + name_sub

    comb_sub = _subsequence_score(token, combined_raw, combined_cf)
    if comb_sub is not None:
        return 240 + comb_sub

    return None


def _public_item(item: dict) -> dict:
    return {
        "key": item["key"],
        "tabId": item["tabId"],
        "path": item["path"],
        "name": item["name"],
        "parentPath": item["parentPath"],
        "ext": item["ext"],
        "open": item["open"],
        "active": item["active"],
        "dirty": item["dirty"],
        "pinned": item["pinned"],
        "recent": item["recent"],
        "duplicate": bool(item.get("duplicate")),
    }


def rank_quick_switcher_items(
    candidates: list[dict],
    query: str,
    *,
    max_results: int = MAX_QUICK_SWITCHER_RESULTS,
) -> list[dict]:
    """Filter and rank quick-switcher candidates by filename and disambiguating parent path."""
    raw_query = (query or "").replace("\\", "/")
    cleaned = raw_query.strip()
    if not cleaned:
        ordered = sorted(
            candidates,
            key=lambda it: (
                0 if it["pinned"] else (1 if it["open"] else (2 if it["recent"] else 3)),
                it["_tabOrder"] if it["open"] else it["_recentRank"],
                it["_depth"],
                it["name"].casefold(),
                it["parentPath"].casefold(),
            ),
        )
        return [_public_item(it) for it in ordered[:max_results]]

    tokens = [tok.casefold() for tok in cleaned.split() if tok]
    scored: list[tuple[tuple, dict]] = []
    full_cf = cleaned.casefold()
    raw_cf = raw_query.casefold()
    for item in candidates:
        total = 0
        matched = True
        for tok in tokens:
            tok_score = _score_token(tok, item)
            if tok_score is None:
                matched = False
                break
            total += tok_score
        if not matched:
            continue
        # Bonus when the entire multi-word query matches filename or stem directly.
        if len(tokens) > 1:
            name_cf = item["name"].casefold()
            stem_cf = item["stem"].casefold()
            if name_cf == full_cf or stem_cf == full_cf:
                total += 400
            elif name_cf.startswith(full_cf):
                total += 250
            elif full_cf in name_cf:
                total += 160
        if raw_cf != full_cf:
            parent_cf = item["parentPath"].casefold()
            name_cf = item["name"].casefold()
            if parent_cf == raw_cf or parent_cf.endswith("/" + raw_cf) or name_cf == raw_cf:
                total += 80
        if item["pinned"]:
            total += 28
        if item["open"]:
            total += 20
        elif item["recent"]:
            total += 12
        sort_key = (
            -total,
            len(item["name"]),
            item["_depth"],
            item["name"].casefold(),
            item["parentPath"].casefold(),
        )
        scored.append((sort_key, item))

    scored.sort(key=lambda pair: pair[0])
    return [_public_item(item) for _, item in scored[:max_results]]
