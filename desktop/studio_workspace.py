"""Workspace full-text search, folder restoration, subfolder filtering, and directory tree helpers."""
from __future__ import annotations

import json, os, sys, threading
from pathlib import Path


def _studio_module():
    mod = sys.modules.get("studio") or sys.modules.get("desktop.studio")
    if mod is not None:
        return mod
    if __package__:
        from . import studio as mod
    else:
        import studio as mod
    return mod


def _call_optional(obj, attr: str, *args):
    fn = getattr(obj, attr, None)
    return fn(*args) if callable(fn) else None


def _call_method(studio_obj, attr: str, fallback, *args):
    fn = getattr(studio_obj, attr, None)
    return fn(*args) if callable(fn) else fallback(studio_obj, *args)


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
    if not folder_path:
        return
    links = getattr(getattr(studio_obj, "session", None), "workspace_links", None)
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
    raw_entries: list[tuple[bool, str, str]] = []
    try:
        with os.scandir(dir_path) as it:
            for entry in it:
                if cancel_event is not None and cancel_event.is_set():
                    return None
                if scan_budget is not None:
                    scan_budget[0] -= 1
                    if scan_budget[0] < 0:
                        break
                name = entry.name
                if name.startswith("."):
                    continue
                try:
                    if entry.is_symlink() or fops._is_link_or_junction(Path(entry.path)):
                        continue
                    is_dir = entry.is_dir(follow_symlinks=False)
                    is_file = False if is_dir else entry.is_file(follow_symlinks=False)
                except OSError:
                    continue
                if is_dir or (is_file and is_searchable(name)):
                    raw_entries.append((is_dir, name, fops.canonical_path_str(entry.path)))
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
    sync_pending = bool(
        studio_obj._folder_search_open and studio_obj._folder_search_query.strip()
        and flush_op and flush_op.get("action") == "sync_for_search"
    )
    return {
        "open": studio_obj._folder_search_open, "query": studio_obj._folder_search_query,
        "caseSensitive": studio_obj._folder_search_case_sensitive,
        "includeDiagrams": studio_obj._folder_search_include_diagrams,
        "matches": studio_obj._folder_search_matches,
        "scanning": studio_obj._folder_search_scanning or sync_pending,
        "scannedFiles": studio_obj._folder_search_scanned_files,
        "truncated": studio_obj._folder_search_truncated,
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
    pinned = getattr(getattr(studio_obj, "session", None), "pinned", ()) or ()
    pinned_keys = {canon_key(p) for p in pinned if p}
    recent_snap = [
        {"path": p, "name": Path(p).name, "pinned": canon_key(p) in pinned_keys}
        for p in getattr(studio_obj, "recent", ()) if p
    ]
    folder_path = Path(studio_obj.folder) if getattr(studio_obj, "folder", "") else None
    return tabs_snap, recent_snap, folder_path, getattr(studio_obj, "active", "")


def cancel_folder_search(studio_obj, close: bool = False) -> None:
    _reset_cancel_state(studio_obj, "_folder_search_cancel", generation_attr="_folder_search_generation")
    studio_obj._folder_search_scanning = False
    if close:
        studio_obj._folder_search_open = False
        studio_obj._folder_search_matches = []
        studio_obj._folder_search_scanned_files = 0
        studio_obj._folder_search_truncated = False
        studio_obj._folder_search_tabs_sig = None
        flush_op = getattr(studio_obj, "flush_operation", None)
        if flush_op and flush_op.get("action") == "sync_for_search":
            studio_obj.flush_operation = None
            flush_timer = getattr(studio_obj, "flush_timer", None)
            if flush_timer is not None:
                flush_timer.stop()


def open_folder_search(studio_obj) -> None:
    if getattr(studio_obj, "retired", False):
        return
    studio_obj._folder_search_open = True
    studio_obj._folder_search_tabs_sig = None
    if getattr(studio_obj, "ready", False) and studio_obj.tabs and not getattr(studio_obj, "flush_operation", None):
        studio_obj._flush("sync_for_search")
        studio_obj.workspaceSearchChanged.emit()
    else:
        studio_obj.workspaceSearchChanged.emit()
        if studio_obj._folder_search_query.strip():
            _call_method(studio_obj, "_start_folder_search", start_folder_search)


def update_folder_search(studio_obj, query: str, case_sensitive: bool = False, include_diagrams: bool = False) -> None:
    if getattr(studio_obj, "retired", False):
        return
    studio_obj._folder_search_query = query if isinstance(query, str) else ""
    studio_obj._folder_search_case_sensitive = bool(case_sensitive)
    studio_obj._folder_search_include_diagrams = bool(include_diagrams)
    if not studio_obj._folder_search_open:
        studio_obj._folder_search_open = True
    _call_method(studio_obj, "_start_folder_search", start_folder_search)


def start_folder_search(studio_obj) -> None:
    st = _studio_module()
    generation, _ = _reset_cancel_state(studio_obj, "_folder_search_cancel", generation_attr="_folder_search_generation")
    studio_obj._folder_search_matches = []
    studio_obj._folder_search_scanned_files = 0
    studio_obj._folder_search_truncated = False
    query = studio_obj._folder_search_query
    if not query or not query.strip():
        studio_obj._folder_search_scanning = False
        studio_obj._folder_search_tabs_sig = None
        studio_obj.workspaceSearchChanged.emit()
        return
    cancel_event = threading.Event()
    studio_obj._folder_search_cancel = cancel_event
    studio_obj._folder_search_scanning = True
    is_dirty = getattr(studio_obj, "_is_dirty", None)
    studio_obj._folder_search_tabs_sig = [
        (t["id"], t["content"], is_dirty(t) if callable(is_dirty) else bool(t.get("dirty")))
        for t in studio_obj.tabs
    ]
    studio_obj.workspaceSearchChanged.emit()
    tabs_snap, recent_snap, folder_path, active_id = _call_method(studio_obj, "_search_snapshots", search_snapshots)
    case_sensitive = studio_obj._folder_search_case_sensitive
    exclude_diagrams = not studio_obj._folder_search_include_diagrams

    def emit_batch(batch: list[dict], scanned: int, truncated: bool, done: bool) -> None:
        if not getattr(studio_obj, "retired", False) and not cancel_event.is_set():
            studio_obj.workspaceSearchBatch.emit(generation, batch, scanned, truncated, done)

    def worker() -> None:
        st.stream_text_search(
            query, tabs_snap, recent_snap, folder_path,
            active_id=active_id, case_sensitive=case_sensitive, exclude_diagrams=exclude_diagrams,
            cancel_event=cancel_event, on_batch=emit_batch,
        )

    search_pool = getattr(studio_obj, "_search_pool", None)
    if search_pool is None:
        worker()
        return
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
    if not studio_obj._folder_search_open and not studio_obj._folder_search_scanning:
        return
    _call_method(studio_obj, "_cancel_folder_search", cancel_folder_search, True)
    studio_obj.workspaceSearchChanged.emit()


def cancel_workspace_search(studio_obj) -> None:
    changed = studio_obj._folder_search_open or studio_obj._folder_search_scanning
    _call_method(studio_obj, "_cancel_folder_search", cancel_folder_search, True)
    if changed:
        studio_obj.workspaceSearchChanged.emit()


def open_folder_search_match(studio_obj, tab_id: str, path: str, query: str, case_sensitive: bool = False) -> None:
    if getattr(studio_obj, "retired", False):
        return
    _call_method(studio_obj, "_cancel_folder_search", cancel_folder_search, True)
    studio_obj.workspaceSearchChanged.emit()
    payload = {"tabId": tab_id or "", "path": path or "", "query": query or "", "caseSensitive": bool(case_sensitive)}
    studio_obj._flush("open_search_match", json.dumps(payload))


def restore_workspace_folder(studio_obj, folder_path: str, expanded_paths: list[str] | None = None) -> None:
    fops = _studio_module().folder_ops
    root = _resolve_non_link_dir(folder_path, fops)
    if root is None:
        return
    root_str = fops.canonical_path_str(root)
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
            "folder": studio_obj.folder,
            "expanded": sorted(studio_obj.expanded),
            "active": current_fn()["path"] if callable(current_fn) else "",
            "activeId": getattr(studio_obj, "active", ""),
        }
    _call_optional(studio_obj, "_watch_notes")
    _call_method(studio_obj, "_load_tree", load_tree)


def cancel_subfolder_search(studio_obj) -> None:
    filter_timer = getattr(studio_obj, "filter_timer", None)
    if filter_timer is not None:
        filter_timer.stop()
    _reset_cancel_state(studio_obj, "_search_cancel", generation_attr="_search_generation")
    studio_obj._folder_searching = False


def clear_folder_filter(studio_obj) -> None:
    _call_method(studio_obj, "_cancel_subfolder_search", cancel_subfolder_search)
    studio_obj.folder_filter = ""


def set_folder_filter(studio_obj, query) -> None:
    if getattr(studio_obj, "retired", False):
        return
    raw = str(query or "")
    trimmed = raw.strip()
    filter_timer = getattr(studio_obj, "filter_timer", None)
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
    if filter_timer is not None:
        filter_timer.start(150)
    else:
        _call_method(studio_obj, "_start_subfolder_search", start_subfolder_search)


def start_subfolder_search(studio_obj) -> None:
    if getattr(studio_obj, "retired", False):
        return
    st = _studio_module()
    filter_timer = getattr(studio_obj, "filter_timer", None)
    if filter_timer is not None:
        filter_timer.stop()
    _reset_cancel_state(studio_obj, "_search_cancel")
    folder = studio_obj.folder
    needle = studio_obj.folder_filter.strip().casefold()
    if not folder or not needle:
        studio_obj._folder_searching = False
        if folder:
            _call_method(studio_obj, "_load_tree", load_tree)
        else:
            studio_obj.files = []
        _call_optional(studio_obj, "_emit", False)
        return
    generation, cancel = _reset_cancel_state(
        studio_obj, "_search_cancel", generation_attr="_search_generation", create_event=True
    )
    assert cancel is not None
    studio_obj._folder_searching = True
    max_scanned, max_matched, max_depth = 25000, 3000, st.MAX_FOLDER_DEPTH

    def search():
        scan_budget = [max_scanned]
        matched_total = 0

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
                        remaining = max_matched - matched_total
                        if remaining > 0:
                            kept_sub = sub_matches[:remaining]
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
    settings = getattr(studio_obj, "settings", None)
    if isinstance(settings, dict):
        settings["welcomed"] = True
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
    st = _studio_module()
    session = getattr(studio_obj, "session", None)
    windows = tuple(session.windows.values()) if session is not None and hasattr(session, "windows") else (studio_obj,)
    for window in windows:
        if getattr(window, "retired", False) or not hasattr(window, "_load_tree"):
            continue
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
    folder = studio_obj.folder
    expanded = set(getattr(studio_obj, "expanded", ()))
    expanded_keys = {st.folder_ops.normalize_path_key(item) for item in expanded if item}

    def scan():
        entries: list[dict[str, object]] = []

        def visit(path, depth):
            children = _list_visible_dir_entries(path, fops=st.folder_ops, is_searchable=st.is_searchable_note_name)
            for directory, name, child_str in children or ():
                if len(entries) >= 3000:
                    return
                is_expanded = st.folder_ops.normalize_path_key(child_str) in expanded_keys
                entries.append(_entry_dict(name, child_str, directory=directory, depth=depth, expanded=is_expanded))
                if directory and is_expanded:
                    visit(child_str, depth + 1)

        visit(folder, 0)
        return entries

    def finished(result, error):
        if (not error and generation == getattr(studio_obj, "_tree_generation", 0)
                and st.folder_ops.same_path(folder, studio_obj.folder)
                and not getattr(studio_obj, "folder_filter", "").strip()):
            studio_obj.files = result

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
    else:
        studio_obj.expanded.add(canon)
    _call_optional(studio_obj, "_recover")
    _call_optional(studio_obj, "_emit", False)
    _call_method(studio_obj, "_load_tree", load_tree)


def close_folder(studio_obj) -> None:
    studio_obj._tree_generation = getattr(studio_obj, "_tree_generation", 0) + 1
    _call_method(studio_obj, "_clear_folder_filter", clear_folder_filter)
    if getattr(studio_obj, "folder", ""):
        _invalidate_workspace_links(studio_obj, studio_obj.folder)
    studio_obj.folder = ""
    studio_obj.files = []
    if hasattr(studio_obj, "expanded"):
        studio_obj.expanded.clear()
    _call_optional(studio_obj, "_recover")
    _call_optional(studio_obj, "_emit", False)
