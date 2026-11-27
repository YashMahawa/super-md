"""Workspace full-text search, folder visibility probing, subfolder filtering, and directory tree helpers."""
from __future__ import annotations

import importlib, json, os, sys, threading
from pathlib import Path

if __package__:
    from .workspace_search import MAX_FOLDER_DEPTH
else:
    from workspace_search import MAX_FOLDER_DEPTH

FOLDER_TREE_NOTE_SUFFIXES = frozenset({".md", ".smd", ".txt"})
FOLDER_TREE_SCAN_BUDGET = 25000

def _studio_module():
    mod = sys.modules.get("studio") or sys.modules.get("desktop.studio")
    return mod if mod is not None else importlib.import_module(".studio" if __package__ else "studio", __package__ or None)

def _call_optional(obj, attr: str, *args):
    fn = getattr(obj, attr, None)
    return fn(*args) if callable(fn) else None

def _call_method(studio_obj, attr: str, fallback, *args):
    fn = getattr(studio_obj, attr, None)
    return fn(*args) if callable(fn) else fallback(studio_obj, *args)

def _clear_pinned_visible_dirs(studio_obj) -> None:
    _call_optional(getattr(studio_obj, "_pinned_visible_dirs", None), "clear")

def _classify_scandir_entry(entry, fops) -> tuple[bool, bool, Path] | None:
    if entry.name.startswith("."):
        return None
    try:
        entry_path = Path(entry.path)
        if entry.is_symlink() or fops._is_link_or_junction(entry_path):
            return None
        is_dir = entry.is_dir(follow_symlinks=False)
        return is_dir, (False if is_dir else entry.is_file(follow_symlinks=False)), entry_path
    except OSError:
        return None

def is_folder_tree_note_name(filename: str) -> bool:
    suffixes = getattr(_studio_module(), "FOLDER_TREE_NOTE_SUFFIXES", FOLDER_TREE_NOTE_SUFFIXES)
    return bool(filename) and not filename.startswith(".") and Path(filename).suffix.lower() in suffixes

def probe_directory_visible_note(
    dir_path: Path, *, depth: int, max_depth: int = MAX_FOLDER_DEPTH,
    budget: list[int] | None = None, memo: dict[str, bool] | None = None,
) -> bool | None:
    """Return True if a visible note exists, False if confirmed absent, or None if scan bounds stopped early."""
    st = _studio_module()
    fops, scandir = st.folder_ops, getattr(st, "os", os).scandir
    key = fops.normalize_path_key(dir_path)
    if memo is not None and key in memo:
        return memo[key]
    if depth > max_depth or (budget is not None and budget[0] <= 0):
        return None
    def remember(val: bool) -> bool:
        if memo is not None:
            memo[key] = val
        return val
    is_note = getattr(st, "_is_folder_tree_note_name", is_folder_tree_note_name)
    probe_fn = getattr(st, "_probe_directory_visible_note", probe_directory_visible_note)
    subdirs: list[Path] = []
    found = unresolved = saw_entry = False
    try:
        with scandir(dir_path) as it:
            for entry in it:
                saw_entry = True
                if budget is not None and budget[0] <= 0:
                    unresolved = True
                    break
                if budget is not None:
                    budget[0] -= 1
                kind = _classify_scandir_entry(entry, fops)
                if kind is None:
                    continue
                is_dir, is_file, entry_path = kind
                if is_dir:
                    subdirs.append(entry_path)
                elif is_file and is_note(entry.name):
                    found = True
                    break
        if not saw_entry and budget is not None:
            budget[0] -= 1
    except OSError:
        return remember(False)
    if found:
        return remember(True)
    if unresolved:
        return None
    for subdir in subdirs:
        sub_result = probe_fn(subdir, depth=depth + 1, max_depth=max_depth, budget=budget, memo=memo)
        if sub_result is True:
            return remember(True)
        if sub_result is None:
            unresolved = True
            if budget is not None and budget[0] <= 0:
                break
    return None if unresolved else remember(False)

def directory_has_visible_note(
    dir_path: Path, *, depth: int, max_depth: int = MAX_FOLDER_DEPTH,
    budget: list[int] | None = None, memo: dict[str, bool] | None = None,
) -> bool:
    probe_fn = getattr(_studio_module(), "_probe_directory_visible_note", probe_directory_visible_note)
    return probe_fn(dir_path, depth=depth, max_depth=max_depth, budget=budget, memo=memo) is not False

def _reset_cancel_state(studio_obj, cancel_attr: str, *, generation_attr: str | None = None, create_event: bool = False):
    current = getattr(studio_obj, cancel_attr, None)
    if current is not None:
        current.set()
        setattr(studio_obj, cancel_attr, None)
    generation = getattr(studio_obj, generation_attr, 0) if generation_attr else 0
    if generation_attr is not None:
        generation += 1
        setattr(studio_obj, generation_attr, generation)
    event = threading.Event() if create_event else None
    if event is not None:
        setattr(studio_obj, cancel_attr, event)
    return generation, event

def _invalidate_workspace_links(studio_obj, folder_path: str) -> None:
    links = getattr(getattr(studio_obj, "session", None), "workspace_links", None) if folder_path else None
    if links is not None:
        links.invalidate(folder_path)

def _resolve_non_link_dir(raw_path, fops) -> Path | None:
    if not raw_path:
        return None
    try:
        candidate = Path(fops.strip_extended_length_prefix(str(raw_path))).expanduser()
        if fops._is_link_or_junction(candidate):
            return None
        resolved = Path(fops.strip_extended_length_prefix(str(candidate.resolve(strict=True))))
        return resolved if resolved.is_dir() else None
    except OSError:
        return None

def _list_visible_dir_entries(
    dir_path: str | os.PathLike[str], *, fops, is_searchable,
    cancel_event: threading.Event | None = None, scan_budget: list[int] | None = None,
) -> list[tuple[bool, str, str]] | None:
    scandir = getattr(_studio_module(), "os", os).scandir
    raw_entries: list[tuple[bool, str, str]] = []
    try:
        with scandir(dir_path) as it:
            for entry in it:
                if cancel_event is not None and cancel_event.is_set():
                    return None
                if scan_budget is not None:
                    scan_budget[0] -= 1
                    if scan_budget[0] < 0:
                        break
                kind = _classify_scandir_entry(entry, fops)
                if kind is None:
                    continue
                is_dir, is_file, entry_path = kind
                if is_dir or (is_file and is_searchable(entry.name)):
                    raw_entries.append((is_dir, entry.name, fops.canonical_path_str(entry_path)))
    except OSError:
        return []
    if cancel_event is not None and cancel_event.is_set():
        return None
    raw_entries.sort(key=lambda item: (not item[0], item[1].lower()))
    return raw_entries

def _submit_task(studio_obj, action, done, *, executor=None) -> None:
    submit = getattr(studio_obj, "_submit", None)
    if callable(submit):
        submit(action, done, False, executor) if executor is not None else submit(action, done, False)
        return
    try:
        value, error = action(), None
    except Exception as exc:
        value, error = None, str(exc)
    done(value, error)
    _call_optional(studio_obj, "_emit", False)

def _entry_dict(name: str, path: str, *, directory: bool, depth: int, expanded: bool) -> dict[str, object]:
    return {"name": name, "path": path, "directory": directory, "depth": depth, "expanded": expanded}

def folder_search_state(studio_obj) -> dict:
    flush_op = getattr(studio_obj, "flush_operation", None)
    sync_pending = bool(studio_obj._folder_search_open and studio_obj._folder_search_query.strip()
                        and flush_op and flush_op.get("action") == "sync_for_search")
    return {
        "open": studio_obj._folder_search_open, "query": studio_obj._folder_search_query,
        "caseSensitive": studio_obj._folder_search_case_sensitive, "includeDiagrams": studio_obj._folder_search_include_diagrams,
        "matches": studio_obj._folder_search_matches, "scanning": studio_obj._folder_search_scanning or sync_pending,
        "scannedFiles": studio_obj._folder_search_scanned_files, "truncated": studio_obj._folder_search_truncated,
        "hasFolder": bool(getattr(studio_obj, "folder", "")),
    }

def search_snapshots(studio_obj):
    canon_key = _studio_module().canonical_note_key
    is_dirty = getattr(studio_obj, "_is_dirty", None)
    tabs_snap = [
        {"id": t["id"], "name": t["name"], "path": t["path"], "content": t["content"],
         "dirty": is_dirty(t) if callable(is_dirty) else bool(t.get("dirty"))}
        for t in studio_obj.tabs
    ]
    pinned_keys = {canon_key(p) for p in (getattr(getattr(studio_obj, "session", None), "pinned", ()) or ()) if p}
    recent_snap = [{"path": p, "name": Path(p).name, "pinned": canon_key(p) in pinned_keys} for p in getattr(studio_obj, "recent", ()) if p]
    folder_path = Path(studio_obj.folder) if getattr(studio_obj, "folder", "") else None
    return tabs_snap, recent_snap, folder_path, getattr(studio_obj, "active", "")

def cancel_folder_search(studio_obj, close: bool = False) -> None:
    _reset_cancel_state(studio_obj, "_folder_search_cancel", generation_attr="_folder_search_generation")
    studio_obj._folder_search_scanning = False
    if not close:
        return
    studio_obj._folder_search_open = studio_obj._folder_search_truncated = False
    studio_obj._folder_search_matches, studio_obj._folder_search_scanned_files = [], 0
    studio_obj._folder_search_tabs_sig = None
    flush_op = getattr(studio_obj, "flush_operation", None)
    if flush_op and flush_op.get("action") == "sync_for_search":
        studio_obj.flush_operation = None
        _call_optional(getattr(studio_obj, "flush_timer", None), "stop")

def open_folder_search(studio_obj) -> None:
    if getattr(studio_obj, "retired", False):
        return
    studio_obj._folder_search_open, studio_obj._folder_search_tabs_sig = True, None
    if getattr(studio_obj, "ready", False) and studio_obj.tabs and not getattr(studio_obj, "flush_operation", None):
        studio_obj._flush("sync_for_search")
        studio_obj.workspaceSearchChanged.emit()
        return
    studio_obj.workspaceSearchChanged.emit()
    if studio_obj._folder_search_query.strip():
        _call_method(studio_obj, "_start_folder_search", start_folder_search)

def update_folder_search(studio_obj, query: str, case_sensitive: bool = False, include_diagrams: bool = False) -> None:
    if getattr(studio_obj, "retired", False):
        return
    studio_obj._folder_search_query = query if isinstance(query, str) else ""
    studio_obj._folder_search_case_sensitive = bool(case_sensitive)
    studio_obj._folder_search_include_diagrams = bool(include_diagrams)
    studio_obj._folder_search_open = True
    _call_method(studio_obj, "_start_folder_search", start_folder_search)

def start_folder_search(studio_obj) -> None:
    st = _studio_module()
    generation, _ = _reset_cancel_state(studio_obj, "_folder_search_cancel", generation_attr="_folder_search_generation")
    studio_obj._folder_search_matches, studio_obj._folder_search_scanned_files = [], 0
    studio_obj._folder_search_truncated = False
    query = studio_obj._folder_search_query
    if not query or not query.strip():
        studio_obj._folder_search_scanning, studio_obj._folder_search_tabs_sig = False, None
        studio_obj.workspaceSearchChanged.emit()
        return
    cancel_event = threading.Event()
    studio_obj._folder_search_cancel, studio_obj._folder_search_scanning = cancel_event, True
    is_dirty = getattr(studio_obj, "_is_dirty", None)
    studio_obj._folder_search_tabs_sig = [
        (t["id"], t["content"], is_dirty(t) if callable(is_dirty) else bool(t.get("dirty"))) for t in studio_obj.tabs
    ]
    studio_obj.workspaceSearchChanged.emit()
    tabs_snap, recent_snap, folder_path, active_id = _call_method(studio_obj, "_search_snapshots", search_snapshots)
    case_sensitive, exclude_diagrams = studio_obj._folder_search_case_sensitive, not studio_obj._folder_search_include_diagrams

    def emit_batch(batch: list[dict], scanned: int, truncated: bool, done: bool) -> None:
        if not getattr(studio_obj, "retired", False) and not cancel_event.is_set():
            studio_obj.workspaceSearchBatch.emit(generation, batch, scanned, truncated, done)

    def worker() -> None:
        st.stream_text_search(query, tabs_snap, recent_snap, folder_path, active_id=active_id,
                              case_sensitive=case_sensitive, exclude_diagrams=exclude_diagrams,
                              cancel_event=cancel_event, on_batch=emit_batch)

    search_pool = getattr(studio_obj, "_search_pool", None)
    if search_pool is None:
        return worker()
    try:
        search_pool.submit(worker)
    except RuntimeError:
        studio_obj._folder_search_scanning = False
        studio_obj.workspaceSearchChanged.emit()

def on_workspace_search_batch(studio_obj, generation: int, batch, scanned: int, truncated: bool, done: bool) -> None:
    if getattr(studio_obj, "retired", False) or not studio_obj._folder_search_open or generation != studio_obj._folder_search_generation:
        return
    if batch:
        studio_obj._folder_search_matches = studio_obj._folder_search_matches + list(batch)
    studio_obj._folder_search_scanned_files = scanned
    studio_obj._folder_search_truncated = bool(truncated)
    if done:
        studio_obj._folder_search_scanning = False
    studio_obj.workspaceSearchChanged.emit()

def close_folder_search(studio_obj) -> None:
    if studio_obj._folder_search_open or studio_obj._folder_search_scanning:
        _call_method(studio_obj, "_cancel_folder_search", cancel_folder_search, True)
        studio_obj.workspaceSearchChanged.emit()

def cancel_workspace_search(studio_obj) -> None:
    changed = studio_obj._folder_search_open or studio_obj._folder_search_scanning
    _call_method(studio_obj, "_cancel_folder_search", cancel_folder_search, True)
    if changed:
        studio_obj.workspaceSearchChanged.emit()

def open_folder_search_match(
    studio_obj, tab_id: str, path: str, query: str, case_sensitive: bool = False,
    source_start: int = -1, source_end: int = -1, match_text: str = "",
) -> None:
    if getattr(studio_obj, "retired", False):
        return
    _call_method(studio_obj, "_cancel_folder_search", cancel_folder_search, True)
    studio_obj.workspaceSearchChanged.emit()
    bounds_fn = getattr(studio_obj, "_seeded_find_bounds", _studio_module().Studio._seeded_find_bounds)
    bounds = bounds_fn({"sourceStart": source_start, "sourceEnd": source_end, "matchText": match_text})
    payload = {"tabId": tab_id or "", "path": path or "", "query": query or "", "caseSensitive": bool(case_sensitive), **bounds}
    studio_obj._flush("open_search_match", json.dumps(payload))

def restore_workspace_folder(studio_obj, folder_path: str, expanded_paths: list[str] | None = None) -> None:
    fops = _studio_module().folder_ops
    root = _resolve_non_link_dir(folder_path, fops)
    if root is None:
        return
    root_str = fops.canonical_path_str(root)
    _clear_pinned_visible_dirs(studio_obj)
    valid_expanded = {root_str}
    for raw in expanded_paths or []:
        resolved = _resolve_non_link_dir(raw, fops)
        if resolved is not None and fops.matches_path_prefix(str(resolved), root_str, is_directory=True):
            valid_expanded.add(fops.canonical_path_str(resolved))
    studio_obj.folder = root_str
    _invalidate_workspace_links(studio_obj, studio_obj.folder)
    studio_obj.expanded = valid_expanded
    window_workspaces = getattr(getattr(studio_obj, "session", None), "window_workspaces", None)
    if isinstance(window_workspaces, dict) and hasattr(studio_obj, "window_id"):
        current_fn = getattr(studio_obj, "_current", None)
        window_workspaces[studio_obj.window_id] = {
            "folder": studio_obj.folder, "expanded": sorted(studio_obj.expanded),
            "active": current_fn()["path"] if callable(current_fn) else "",
            "activeId": getattr(studio_obj, "active", ""),
        }
    _call_optional(studio_obj, "_watch_notes")
    _call_method(studio_obj, "_load_tree", load_tree)

def cancel_subfolder_search(studio_obj) -> None:
    _call_optional(getattr(studio_obj, "filter_timer", None), "stop")
    _reset_cancel_state(studio_obj, "_search_cancel", generation_attr="_search_generation")
    studio_obj._folder_searching = False

def clear_folder_filter(studio_obj) -> None:
    _call_method(studio_obj, "_cancel_subfolder_search", cancel_subfolder_search)
    studio_obj.folder_filter = ""

def set_folder_filter(studio_obj, query) -> None:
    if getattr(studio_obj, "retired", False):
        return
    raw = str(query or "")
    trimmed, filter_timer = raw.strip(), getattr(studio_obj, "filter_timer", None)
    timer_active = bool(filter_timer is not None and filter_timer.isActive())
    if raw == studio_obj.folder_filter and (not trimmed or studio_obj._folder_searching or timer_active):
        return
    _call_method(studio_obj, "_cancel_subfolder_search", cancel_subfolder_search)
    studio_obj.folder_filter = raw
    if not studio_obj.folder:
        studio_obj.files = []
        _call_optional(studio_obj, "_emit", False)
        return
    if not trimmed:
        _call_method(studio_obj, "_load_tree", load_tree)
        _call_optional(studio_obj, "_emit", False)
        return
    studio_obj._folder_searching = True
    _call_optional(studio_obj, "_emit", False)
    filter_timer.start(150) if filter_timer is not None else _call_method(studio_obj, "_start_subfolder_search", start_subfolder_search)

def start_subfolder_search(studio_obj) -> None:
    if getattr(studio_obj, "retired", False):
        return
    st = _studio_module()
    _call_optional(getattr(studio_obj, "filter_timer", None), "stop")
    _reset_cancel_state(studio_obj, "_search_cancel")
    folder, needle = studio_obj.folder, studio_obj.folder_filter.strip().casefold()
    if not folder or not needle:
        studio_obj._folder_searching = False
        _call_method(studio_obj, "_load_tree", load_tree) if folder else setattr(studio_obj, "files", [])
        _call_optional(studio_obj, "_emit", False)
        return
    generation, cancel = _reset_cancel_state(studio_obj, "_search_cancel", generation_attr="_search_generation", create_event=True)
    assert cancel is not None
    studio_obj._folder_searching = True
    max_scanned, max_matched, max_depth = 25000, 3000, st.MAX_FOLDER_DEPTH

    def search():
        scan_budget, matched_total = [max_scanned], 0

        def walk_dir(dir_path: str, depth: int) -> list[dict] | None:
            nonlocal matched_total
            if cancel.is_set():
                return None
            if depth > max_depth or scan_budget[0] <= 0 or matched_total >= max_matched:
                return []
            raw_entries = _list_visible_dir_entries(
                dir_path, fops=st.folder_ops, is_searchable=st.is_searchable_note_name,
                cancel_event=cancel, scan_budget=scan_budget,
            )
            if raw_entries is None:
                return None
            collected: list[dict] = []
            for is_dir, name, full_path in raw_entries:
                if cancel.is_set():
                    return None
                if matched_total >= max_matched:
                    break
                if is_dir:
                    sub_matches = walk_dir(full_path, depth + 1)
                    if sub_matches is None:
                        return None
                    if sub_matches:
                        collected.append(_entry_dict(name, full_path, directory=True, depth=depth, expanded=True))
                        matched_total += 1
                        kept_sub = sub_matches[:max(0, max_matched - matched_total)]
                        collected.extend(kept_sub)
                        matched_total += len(kept_sub)
                elif needle in name.casefold():
                    collected.append(_entry_dict(name, full_path, directory=False, depth=depth, expanded=False))
                    matched_total += 1
            return collected

        return walk_dir(folder, 0)

    def finished(result, error):
        if (getattr(studio_obj, "retired", False) or cancel.is_set()
                or generation != studio_obj._search_generation
                or not st.folder_ops.same_path(folder, studio_obj.folder)):
            return
        studio_obj._folder_searching = False
        if not error and result is not None:
            studio_obj.files = result

    _submit_task(studio_obj, search, finished, executor=getattr(studio_obj, "_search_pool", None))

def open_folder(studio_obj, value) -> None:
    st = _studio_module()
    path = st.local_path(value)
    if not path.is_dir():
        studio_obj.message = "Choose an existing local folder."
        _call_optional(studio_obj, "_emit", False)
        return
    _call_method(studio_obj, "_clear_folder_filter", clear_folder_filter)
    studio_obj.folder = st.folder_ops.canonical_path_str(path)
    _invalidate_workspace_links(studio_obj, studio_obj.folder)
    if isinstance(getattr(studio_obj, "settings", None), dict):
        studio_obj.settings["welcomed"] = True
    _clear_pinned_visible_dirs(studio_obj)
    studio_obj.expanded = {studio_obj.folder}
    _call_optional(studio_obj, "_preferences")
    _call_optional(studio_obj, "_recover")
    _call_optional(studio_obj, "_emit", False)
    _call_method(studio_obj, "_load_tree", load_tree)

def is_within_open_folder(studio_obj, candidate) -> bool:
    folder = getattr(studio_obj, "folder", "")
    if not folder or not candidate:
        return False
    try:
        return _studio_module().folder_ops.matches_path_prefix(str(candidate), folder, is_directory=True)
    except (OSError, ValueError):
        return False

def refresh_open_folder_trees(studio_obj, *candidates) -> None:
    if not candidates:
        return
    st, session = _studio_module(), getattr(studio_obj, "session", None)
    windows = tuple(session.windows.values()) if session is not None and hasattr(session, "windows") else (studio_obj,)
    for window in windows:
        if not getattr(window, "retired", False) and hasattr(window, "_load_tree"):
            if any(st.Studio._is_within_open_folder(window, candidate) for candidate in candidates if candidate):
                window._load_tree()

def load_tree(studio_obj) -> None:
    st = _studio_module()
    studio_obj._tree_generation = getattr(studio_obj, "_tree_generation", 0) + 1
    generation = studio_obj._tree_generation
    if not getattr(studio_obj, "folder", ""):
        studio_obj.files = []
        return
    if getattr(studio_obj, "folder_filter", "").strip():
        _call_method(studio_obj, "_start_subfolder_search", start_subfolder_search)
        return
    folder, expanded = studio_obj.folder, set(getattr(studio_obj, "expanded", ()))
    settings = getattr(studio_obj, "settings", None)
    hide_non_note = bool(settings.get("hideNonNoteFolders", True)) if isinstance(settings, dict) else True
    expanded_keys = {st.folder_ops.normalize_path_key(item) for item in expanded if item}
    pinned_keys = {st.folder_ops.normalize_path_key(item) for item in getattr(studio_obj, "_pinned_visible_dirs", ()) if item}
    custom_budget = getattr(studio_obj, "_folder_tree_scan_budget", None)
    default_budget = getattr(st, "FOLDER_TREE_SCAN_BUDGET", FOLDER_TREE_SCAN_BUDGET)
    initial_budget = default_budget if custom_budget is None else max(0, int(custom_budget))
    has_visible_note = getattr(st, "_directory_has_visible_note", directory_has_visible_note)

    def scan():
        entries, note_memo, scan_budget = [], {}, [initial_budget]
        def visit(path, depth):
            if depth > 256:
                return
            for directory, name, child_str in _list_visible_dir_entries(path, fops=st.folder_ops, is_searchable=st.is_searchable_note_name) or ():
                if len(entries) >= 3000:
                    return
                if not directory:
                    entries.append(_entry_dict(name, child_str, directory=False, depth=depth, expanded=False))
                    continue
                child_key = st.folder_ops.normalize_path_key(child_str)
                if hide_non_note and child_key not in pinned_keys and not has_visible_note(
                    Path(child_str), depth=depth + 1, max_depth=st.MAX_FOLDER_DEPTH, budget=scan_budget, memo=note_memo
                ):
                    continue
                is_expanded = child_key in expanded_keys
                entries.append(_entry_dict(name, child_str, directory=True, depth=depth, expanded=is_expanded))
                if is_expanded:
                    visit(child_str, depth + 1)
        visit(folder, 0)
        return entries

    def finished(result, error):
        if (not error and result is not None and generation == getattr(studio_obj, "_tree_generation", 0)
                and st.folder_ops.same_path(folder, studio_obj.folder) and not getattr(studio_obj, "folder_filter", "").strip()):
            studio_obj.files = result
            _call_optional(studio_obj, "_watch_notes")
    _submit_task(studio_obj, scan, finished)

def toggle_directory(studio_obj, path) -> None:
    if not getattr(studio_obj, "folder", ""):
        return
    st = _studio_module()
    canon = st.folder_ops.canonical_path_str(st.local_path(path))
    if not canon:
        return
    existing = [item for item in studio_obj.expanded if st.folder_ops.same_path(item, canon)]
    if existing:
        for item in existing:
            studio_obj.expanded.discard(item)
        pinned = getattr(studio_obj, "_pinned_visible_dirs", None)
        for item in ([p for p in pinned if st.folder_ops.same_path(p, canon)] if pinned is not None else ()):
            pinned.discard(item)
    else:
        studio_obj.expanded.add(canon)
    _call_optional(studio_obj, "_recover")
    _call_optional(studio_obj, "_emit", False)
    _call_method(studio_obj, "_load_tree", load_tree)

def close_folder(studio_obj) -> None:
    studio_obj._tree_generation = getattr(studio_obj, "_tree_generation", 0) + 1
    _call_method(studio_obj, "_clear_folder_filter", clear_folder_filter)
    _invalidate_workspace_links(studio_obj, getattr(studio_obj, "folder", ""))
    studio_obj.folder, studio_obj.files = "", []
    _clear_pinned_visible_dirs(studio_obj)
    _call_optional(getattr(studio_obj, "expanded", None), "clear")
    _call_optional(studio_obj, "_watch_notes")
    _call_optional(studio_obj, "_recover")
    _call_optional(studio_obj, "_emit", False)
