"""Filesystem note watching, watch-suspension guards, and external note reconciliation for Studio."""
from __future__ import annotations
import contextlib
from pathlib import Path
from typing import Any


class _StoppedFileWatcher:
    def files(self) -> list[str]: return []
    def directories(self) -> list[str]: return []
    def addPath(self, _path: str) -> bool: return False
    def addPaths(self, paths) -> list[str]: return list(paths)
    def removePath(self, _path: str) -> bool: return False
    def removePaths(self, paths) -> list[str]: return list(paths)


_STOPPED_WATCHER = _StoppedFileWatcher()

def _studio_module():
    if __package__:
        from . import studio as module
    else:
        import studio as module
    return module

def _call_method(studio_obj: Any, name: str, fallback_fn, *args, **kwargs):
    method = getattr(studio_obj, name, None)
    if callable(method):
        return method(*args, **kwargs)
    return fallback_fn(studio_obj, *args, **kwargs) if fallback_fn is not None else None

def _active_suspensions(studio_obj: Any) -> list:
    session = getattr(studio_obj, "session", None)
    if session is not None and hasattr(session, "_watch_suspension_lock"):
        return _studio_module().studio_assets_rename.active_watch_suspensions(session)
    return [
        (item[0], item[1], item[2], ev, item[4] if len(item) > 4 else "")
        for item in (getattr(session, "_watch_suspensions", None) or ())
        if (ev := (item[3]() if callable(item[3]) else item[3])) is not None and not (hasattr(ev, "is_set") and ev.is_set())
    ]

def _fallback_is_dirty(studio_obj: Any, tab: dict) -> bool:
    return _studio_module().Studio._is_dirty(studio_obj, tab)

def _fallback_remove_tab(studio_obj: Any, tab_id: str) -> None:
    if isinstance(tabs := getattr(studio_obj, "tabs", None), list):
        studio_obj.tabs = [tab for tab in tabs if tab.get("id") != tab_id]
        if getattr(studio_obj, "active", "") == tab_id:
            studio_obj.active = studio_obj.tabs[0]["id"] if studio_obj.tabs else ""

def _fallback_submit(_studio_obj: Any, action, done, _busy: bool = True) -> None:
    try:
        value, error = action(), None
    except Exception as reason:
        value, error = None, str(reason)
    done(value, error)

def _matches_watch_suspension(candidate: str, items, *, include_parent: bool = False) -> bool:
    if not candidate:
        return False
    ops = _studio_module().folder_ops
    for item in items:
        susp_target, susp_parent, susp_is_dir = item[0], item[1], item[2]
        susp_new = item[4] if len(item) > 4 else ""
        if ops.matches_path_prefix(candidate, susp_target, is_directory=susp_is_dir):
            return True
        if susp_new and ops.matches_path_prefix(candidate, susp_new, is_directory=susp_is_dir):
            return True
        if include_parent and susp_parent and ops.same_path(candidate, susp_parent):
            return True
    return False

def _check_suspended(studio_obj: Any, candidate: str, suspensions, *, include_parent: bool) -> bool:
    if not candidate:
        return False
    items = _call_method(studio_obj, "_active_watch_suspensions", _active_suspensions) if suspensions is None else suspensions
    return _matches_watch_suspension(candidate, items, include_parent=include_parent)

def _any_path_suspended(studio_obj: Any, old: str, new: str, suspensions) -> bool:
    check = lambda p: _call_method(studio_obj, "_is_path_suspended", is_path_suspended, p, suspensions)
    return bool(check(old) or (new and check(new)))

def _pop_matching_locations(locations: dict, old: str):
    ops, first = _studio_module().folder_ops, None
    for loc_key in [k for k in list(locations) if ops.same_path(k, old)]:
        popped = locations.pop(loc_key, None)
        if first is None and popped is not None:
            first = popped
    return first

def is_path_suspended(studio_obj: Any, candidate: str, suspensions=None) -> bool:
    return _check_suspended(studio_obj, candidate, suspensions, include_parent=False)

def is_watch_target_suspended(studio_obj: Any, candidate: str, suspensions=None) -> bool:
    return _check_suspended(studio_obj, candidate, suspensions, include_parent=True)

def has_session_path_reference(studio_obj: Any, candidate: str) -> bool:
    if not candidate:
        return False
    ops, session = _studio_module().folder_ops, getattr(studio_obj, "session", None)
    pools = (getattr(studio_obj, "note_identities", ()), getattr(session, "pinned", ()), getattr(studio_obj, "recent", ()), getattr(session, "locations", ()))
    if any(ops.same_path(p, candidate) for pool in pools for p in pool):
        return True
    windows = getattr(session, "windows", None)
    for win in (list(windows.values()) if isinstance(windows, dict) else [studio_obj]):
        if not getattr(win, "retired", False) and any(t.get("path") and ops.same_path(t["path"], candidate) for t in getattr(win, "tabs", ())):
            return True
    workspace = getattr(session, "workspace", None)
    return any(entry.get("path") and ops.same_path(entry["path"], candidate) for entries in (workspace.values() if isinstance(workspace, dict) else ()) for entry in entries)

def watch_notes(studio_obj: Any, force: bool = False) -> None:
    if getattr(studio_obj, "retired", False): return
    studio_mod = _studio_module()
    active_suspensions = _call_method(studio_obj, "_active_watch_suspensions", _active_suspensions)
    tabs, recent = getattr(studio_obj, "tabs", ()), getattr(studio_obj, "recent", ())
    folder, expanded = getattr(studio_obj, "folder", ""), getattr(studio_obj, "expanded", ())
    paths = tuple(sorted({tab["path"] for tab in tabs if tab.get("path")} | set(recent)))
    signature = (paths, folder, tuple(sorted(expanded)))
    if not force and not active_suspensions and signature == getattr(studio_obj, "note_watch_paths", None): return
    studio_obj.note_watch_paths = None if active_suspensions else signature
    prev_stamps, prev_identities = getattr(studio_obj, "note_file_stamps", {}), getattr(studio_obj, "note_identities", {})
    studio_obj.note_file_stamps = {path: stamp for path, stamp in prev_stamps.items() if path in paths}
    path_susp = lambda p: _call_method(studio_obj, "_is_path_suspended", is_path_suspended, p, active_suspensions)
    target_susp = lambda p: _call_method(studio_obj, "_is_watch_target_suspended", is_watch_target_suspended, p, active_suspensions)
    studio_obj.note_identities = {path: prev_identities.get(path) if path_susp(path) else (studio_mod.file_events.identity(path) or prev_identities.get(path)) for path in paths}
    targets = {str(target) for path in paths if not path_susp(path) for target in (Path(path), Path(path).parent) if target.exists()}
    targets.update(path for path in ({folder} | set(expanded)) if path and not target_susp(path) and Path(path).is_dir())
    if active_suspensions:
        targets = {candidate for candidate in targets if not target_susp(candidate)}
    watcher = getattr(studio_obj, "note_watcher", _STOPPED_WATCHER)
    watched = set(watcher.files() + watcher.directories())
    if watched - targets: watcher.removePaths(list(watched - targets))
    if targets - watched: watcher.addPaths(list(targets - watched))

def external_note_changed(studio_obj: Any, path: str) -> None:
    if getattr(studio_obj, "retired", False): return
    local_str = str(_studio_module().local_path(path))
    if _call_method(studio_obj, "_is_watch_target_suspended", is_watch_target_suspended, local_str): return
    if getattr(studio_obj, "external_paths", None) is None:
        studio_obj.external_paths = set()
    studio_obj.external_paths.add(local_str)
    if (timer := getattr(studio_obj, "external_timer", None)) is not None:
        timer.start(250)

def refresh_external_notes(studio_obj: Any) -> None:
    if getattr(studio_obj, "retired", False): return
    changed, studio_obj.external_paths = set(getattr(studio_obj, "external_paths", ())), set()
    active_suspensions = _call_method(studio_obj, "_active_watch_suspensions", _active_suspensions)
    known = {path: ident for path, ident in getattr(studio_obj, "note_identities", {}).items() if not _call_method(studio_obj, "_is_path_suspended", is_path_suspended, path, active_suspensions)}
    unsuspended = {p for p in changed if not _call_method(studio_obj, "_is_watch_target_suspended", is_watch_target_suspended, p, active_suspensions)}
    if not known and not unsuspended: return

    def reconciled(result, error):
        if getattr(studio_obj, "retired", False) or error: return
        ops, session = _studio_module().folder_ops, getattr(studio_obj, "session", None)
        current_suspensions = _call_method(studio_obj, "_active_watch_suspensions", _active_suspensions)
        emitted_location_change = False
        for old, new in result.items():
            if _any_path_suspended(studio_obj, old, new, current_suspensions) or not _call_method(studio_obj, "_has_session_path_reference", has_session_path_reference, old):
                continue
            emitted_location_change = True
            if (loc_sig := getattr(session, "locationChanged", None)) is not None:
                loc_sig.emit(old, new or "")
        effective = {p for p in changed if not _call_method(studio_obj, "_is_watch_target_suspended", is_watch_target_suspended, p, current_suspensions)}
        _call_method(studio_obj, "_reload_changed_content", reload_changed_content, effective)
        folder = getattr(studio_obj, "folder", "")
        if folder and (effective or emitted_location_change) and (wl := getattr(session, "workspace_links", None)) is not None:
            wl.invalidate(folder)
        if folder and effective and any(ops.same_path(d, p) for d in (folder, *getattr(studio_obj, "expanded", ())) for p in effective):
            _call_method(studio_obj, "_load_tree", None)

    _call_method(studio_obj, "_submit", _fallback_submit, lambda: _studio_module().file_events.reconcile(known, changed), reconciled, False)

def location_changed(studio_obj: Any, old: str, new: str) -> None:
    if getattr(studio_obj, "retired", False): return
    active_suspensions = _call_method(studio_obj, "_active_watch_suspensions", _active_suspensions)
    if _any_path_suspended(studio_obj, old, new, active_suspensions): return
    if Path(old).exists() and not (new and old != new and old.casefold() == new.casefold()): return  # A temporary atomic-replace gap has healed.
    if new and not Path(new).is_file(): return
    ops, session = _studio_module().folder_ops, getattr(studio_obj, "session", None)
    stamps, locations = getattr(studio_obj, "note_file_stamps", None), getattr(session, "locations", None)
    if isinstance(stamps, dict):
        _pop_matching_locations(stamps, old)
    if new:
        if isinstance(locations, dict) and (loc := _pop_matching_locations(locations, old)):
            locations[new] = loc
        for tab in getattr(studio_obj, "tabs", ()):
            if tab.get("path") and ops.same_path(tab["path"], old):
                tab.update(path=new, name=Path(new).name)
                if isinstance(stamps, dict):
                    with contextlib.suppress(OSError):
                        st = Path(new).stat()
                        stamps[new] = (st.st_mtime_ns, st.st_size)
        if session is not None and hasattr(session, "pinned"):
            session.pinned = [new if ops.same_path(path, old) else path for path in session.pinned]
        if hasattr(studio_obj, "recent"):
            studio_obj.recent = [new if ops.same_path(path, old) else path for path in studio_obj.recent]
        workspace = getattr(session, "workspace", None)
        for paths in (workspace.values() if isinstance(workspace, dict) else ()):
            for entry in paths:
                if entry.get("path") and ops.same_path(entry["path"], old):
                    entry["path"] = new
        studio_obj.message = "Renamed note: " + Path(new).name
    else:
        if isinstance(locations, dict):
            _pop_matching_locations(locations, old)
        if session is not None and hasattr(session, "pinned"):
            session.pinned = [path for path in session.pinned if not ops.same_path(path, old)]
        if hasattr(studio_obj, "recent"):
            studio_obj.recent = [path for path in studio_obj.recent if not ops.same_path(path, old)]
        drafts = getattr(session, "drafts", None)
        for tab in list(getattr(studio_obj, "tabs", ())):
            if not tab.get("path") or not ops.same_path(tab["path"], old):
                continue
            if _call_method(studio_obj, "_is_dirty", _fallback_is_dirty, tab):
                draft = {**tab, "path": "", "name": "Recovered " + tab["name"], "saved": "", "conflict": False}
                if isinstance(drafts, dict):
                    drafts.setdefault("deleted-notes", []).append(draft)
                tab.update(path="", name=draft["name"], conflict=False)
            _call_method(studio_obj, "_remove_tab", _fallback_remove_tab, tab["id"])
        studio_obj.message = "File deleted: " + Path(old).name + ". Its tab was closed; unsaved changes remain recoverable."
    if (wl := getattr(session, "workspace_links", None)) is not None:
        wl.invalidate()
    _call_method(studio_obj, "_preferences", None)
    _call_method(studio_obj, "_recover", None)
    _call_method(studio_obj, "_emit", None)

def reload_changed_content(studio_obj: Any, changed) -> None:
    _call_method(studio_obj, "_watch_notes", watch_notes, force=True)
    active_suspensions = _call_method(studio_obj, "_active_watch_suspensions", _active_suspensions)
    changed_set = changed if isinstance(changed, (set, frozenset)) else set(changed)
    saving = getattr(studio_obj, "saving", ())
    if getattr(studio_obj, "note_file_stamps", None) is None:
        studio_obj.note_file_stamps = {}
    for tab in getattr(studio_obj, "tabs", ()):
        path = tab.get("path", "")
        if not path or _call_method(studio_obj, "_is_path_suspended", is_path_suspended, path, active_suspensions) or not ({path, str(Path(path).parent)} & changed_set) or tab["id"] in saving:
            continue
        was_dirty = _call_method(studio_obj, "_is_dirty", _fallback_is_dirty, tab)
        try:
            st = Path(path).stat()
            stamp = (st.st_mtime_ns, st.st_size)
        except OSError:
            continue
        if not was_dirty and studio_obj.note_file_stamps.get(path) == stamp:
            continue
        tab_id, expected = tab["id"], tab["saved"]

        def finished(result, error, id=tab_id, expected=expected, path=path, stamp=stamp, was_dirty=was_dirty):
            current = next((note for note in getattr(studio_obj, "tabs", ()) if note["id"] == id), None)
            if error or not current: return
            if isinstance(getattr(studio_obj, "note_file_stamps", None), dict):
                studio_obj.note_file_stamps[path] = stamp
            content, assets, portable = result
            if was_dirty or _call_method(studio_obj, "_is_dirty", _fallback_is_dirty, current) or current.get("conflict"):
                if content != current["saved"] or assets != current.get("saved_assets", {}):
                    current["conflict"] = True
                    studio_obj.message = "This file changed outside Super MD. Autosave is paused for this tab."
                    _call_method(studio_obj, "_emit", None, False)
                return
            old_assets = current.get("assets", {})
            if current["content"] != expected or (content == expected and assets == old_assets): return
            assets_changed = assets != old_assets
            merged = _studio_module()._preserve_unchanged_assets(old_assets, assets)
            current.update(content=content, saved=content, assets=merged, saved_assets=dict(merged), assets_dirty=False, portable=portable, conflict=False)
            if assets_changed and (ra := getattr(getattr(studio_obj, "session", None), "reader_assets", None)) is not None:
                ra.revoke_tab(getattr(studio_obj, "window_id", ""), id)
            studio_obj.message = "Reloaded externally updated note"
            _call_method(studio_obj, "_emit", None, load=id == getattr(studio_obj, "active", ""))

        _call_method(studio_obj, "_submit", _fallback_submit, lambda path=path: _studio_module().open_note(Path(path)), finished, False)
