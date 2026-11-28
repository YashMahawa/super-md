"""Filesystem note watching, watch-suspension guards, and external note reconciliation for Studio."""
from __future__ import annotations
import contextlib
from collections.abc import Callable
from pathlib import Path
from typing import Any
from PySide6.QtCore import QUrl

if __package__:
    from . import file_events, folder_ops, studio_assets_rename
    from .documents import open_note
else:
    import file_events
    import folder_ops
    import studio_assets_rename
    from documents import open_note

class _StoppedFileWatcher:
    def files(self) -> list[str]: return []
    def directories(self) -> list[str]: return []
    def addPath(self, _path: str) -> bool: return False
    def addPaths(self, paths) -> list[str]: return list(paths)
    def removePath(self, _path: str) -> bool: return False
    def removePaths(self, paths) -> list[str]: return list(paths)

_STOPPED_WATCHER = _StoppedFileWatcher()

def _default_local_path(value: str) -> Path:
    url = QUrl(value)
    resolved = Path(url.toLocalFile() if url.isLocalFile() else value).expanduser().resolve()
    return Path(folder_ops.strip_extended_length_prefix(str(resolved)))

def _default_preserve_unchanged_assets(old_assets: dict[str, str], new_assets: dict[str, str]) -> dict[str, str]:
    return {k: old_assets[k] if old_assets.get(k) == v else v for k, v in new_assets.items()}

def _call_method(studio_obj: Any, name: str, fallback_fn, *args, **kwargs):
    method = getattr(studio_obj, name, None)
    return method(*args, **kwargs) if callable(method) else (fallback_fn(studio_obj, *args, **kwargs) if fallback_fn is not None else None)

def _active_suspensions(studio_obj: Any) -> list:
    session = getattr(studio_obj, "session", None)
    if session is not None and hasattr(session, "_watch_suspension_lock"):
        return studio_assets_rename.active_watch_suspensions(session)
    return [
        (item[0], item[1], item[2], ev, item[4] if len(item) > 4 else "")
        for item in (getattr(session, "_watch_suspensions", None) or ())
        if (ev := (item[3]() if callable(item[3]) else item[3])) is not None and not (hasattr(ev, "is_set") and ev.is_set())
    ]

def _fallback_is_dirty(_studio_obj: Any, tab: dict) -> bool:
    if tab.get("content") != tab.get("saved") or tab.get("assets_dirty"):
        return True
    return bool(tab.get("path") and "saved_assets" in tab and tab.get("assets", {}) != tab.get("saved_assets", {}))

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

def _invalidate_index(studio_obj: Any, target_path: str) -> None:
    if callable(fn := getattr(studio_obj, "_invalidate_folder_index", None)): return fn(target_path)
    session = getattr(studio_obj, "session", None)
    if callable(inv := getattr(session, "invalidate_workspace_caches", None)): inv(target_path)
    elif (idx := getattr(session, "folder_note_index", None)) is not None: idx.invalidate(target_path)

def _matches_watch_suspension(candidate: str, items, *, include_parent: bool = False, folder_ops_mod: Any = folder_ops) -> bool:
    if not candidate or not items: return False
    for item in items:
        susp_target, susp_parent, susp_is_dir, susp_new = item[0], item[1], item[2], item[4] if len(item) > 4 else ""
        if folder_ops_mod.matches_path_prefix(candidate, susp_target, is_directory=susp_is_dir) or (susp_new and folder_ops_mod.matches_path_prefix(candidate, susp_new, is_directory=susp_is_dir)):
            return True
        if include_parent and susp_parent and folder_ops_mod.same_path(candidate, susp_parent):
            return True
    return False

def _check_suspended(studio_obj: Any, candidate: str, suspensions, *, include_parent: bool, folder_ops_mod: Any = folder_ops) -> bool:
    if not candidate:
        return False
    items = _call_method(studio_obj, "_active_watch_suspensions", _active_suspensions) if suspensions is None else suspensions
    return _matches_watch_suspension(candidate, items, include_parent=include_parent, folder_ops_mod=folder_ops_mod)

def _path_suspended(studio_obj: Any, candidate: str, suspensions=None, *, folder_ops_mod: Any = folder_ops) -> bool:
    fn = getattr(studio_obj, "_is_path_suspended", None)
    return fn(candidate, suspensions) if callable(fn) else _check_suspended(studio_obj, candidate, suspensions, include_parent=False, folder_ops_mod=folder_ops_mod)

def _target_suspended(studio_obj: Any, candidate: str, suspensions=None, *, folder_ops_mod: Any = folder_ops) -> bool:
    fn = getattr(studio_obj, "_is_watch_target_suspended", None)
    return (fn(candidate) if suspensions is None else fn(candidate, suspensions)) if callable(fn) else _check_suspended(studio_obj, candidate, suspensions, include_parent=True, folder_ops_mod=folder_ops_mod)

def _any_path_suspended(studio_obj: Any, old: str, new: str, suspensions, *, folder_ops_mod: Any = folder_ops) -> bool:
    return bool(_path_suspended(studio_obj, old, suspensions, folder_ops_mod=folder_ops_mod) or (new and _path_suspended(studio_obj, new, suspensions, folder_ops_mod=folder_ops_mod)))

def _pop_matching_locations(locations: dict, old: str, *, folder_ops_mod: Any = folder_ops):
    first = None
    for loc_key in [k for k in list(locations) if folder_ops_mod.same_path(k, old)]:
        popped = locations.pop(loc_key, None)
        if first is None and popped is not None:
            first = popped
    return first

def is_path_suspended(studio_obj: Any, candidate: str, suspensions=None, *, folder_ops_mod: Any = folder_ops) -> bool:
    return _check_suspended(studio_obj, candidate, suspensions, include_parent=False, folder_ops_mod=folder_ops_mod)

def is_watch_target_suspended(studio_obj: Any, candidate: str, suspensions=None, *, folder_ops_mod: Any = folder_ops) -> bool:
    return _check_suspended(studio_obj, candidate, suspensions, include_parent=True, folder_ops_mod=folder_ops_mod)

def has_session_path_reference(studio_obj: Any, candidate: str, *, folder_ops_mod: Any = folder_ops) -> bool:
    if not candidate:
        return False
    session = getattr(studio_obj, "session", None)
    pools = (getattr(studio_obj, "note_identities", ()), getattr(session, "pinned", ()), getattr(studio_obj, "recent", ()), getattr(session, "locations", ()))
    if any(folder_ops_mod.same_path(p, candidate) for pool in pools for p in pool):
        return True
    windows = getattr(session, "windows", None)
    for win in (list(windows.values()) if isinstance(windows, dict) else [studio_obj]):
        if not getattr(win, "retired", False) and any(t.get("path") and folder_ops_mod.same_path(t["path"], candidate) for t in getattr(win, "tabs", ())):
            return True
    workspace = getattr(session, "workspace", None)
    return any(entry.get("path") and folder_ops_mod.same_path(entry["path"], candidate) for entries in (workspace.values() if isinstance(workspace, dict) else ()) for entry in entries)

def watch_notes(studio_obj: Any, force: bool = False, *, local_path_fn: Callable[[str], Path] = _default_local_path, file_events_mod: Any = file_events, folder_ops_mod: Any = folder_ops, watcher_alive_fn: Callable[[Any], bool] | None = None) -> None:
    watcher = getattr(studio_obj, "note_watcher", _STOPPED_WATCHER)
    if getattr(studio_obj, "retired", False) or (watcher_alive_fn is not None and not watcher_alive_fn(watcher)): return
    active_suspensions = _call_method(studio_obj, "_active_watch_suspensions", _active_suspensions)
    tabs, recent = getattr(studio_obj, "tabs", ()), getattr(studio_obj, "recent", ())
    folder, expanded = getattr(studio_obj, "folder", ""), getattr(studio_obj, "expanded", ())
    paths = tuple(sorted({tab["path"] for tab in tabs if tab.get("path")} | set(recent)))
    signature = (paths, folder, tuple(sorted(expanded)))
    if not force and not active_suspensions and signature == getattr(studio_obj, "note_watch_paths", None): return
    studio_obj.note_watch_paths = None if active_suspensions else signature
    prev_stamps, prev_identities = getattr(studio_obj, "note_file_stamps", {}), getattr(studio_obj, "note_identities", {})
    studio_obj.note_file_stamps = {path: stamp for path, stamp in prev_stamps.items() if path in paths}
    to_path = lambda p: local_path_fn(p) if "://" in p else Path(p)
    unsuspended = {path: to_path(path) for path in paths if not _path_suspended(studio_obj, path, active_suspensions, folder_ops_mod=folder_ops_mod)}
    studio_obj.note_identities = {path: prev_identities.get(path) if path not in unsuspended else (file_events_mod.identity(str(unsuspended[path])) or prev_identities.get(path)) for path in paths}
    targets = {str(target) for resolved in unsuspended.values() for target in (resolved, resolved.parent) if target.exists()}
    targets.update(str(resolved) for raw in ({folder} | set(expanded)) if raw and not _target_suspended(studio_obj, raw, active_suspensions, folder_ops_mod=folder_ops_mod) and (resolved := to_path(raw)).is_dir())
    if active_suspensions:
        targets = {c for c in targets if not _target_suspended(studio_obj, c, active_suspensions, folder_ops_mod=folder_ops_mod)}
    watched = set(watcher.files() + watcher.directories())
    if watched - targets: watcher.removePaths(list(watched - targets))
    if targets - watched: watcher.addPaths(list(targets - watched))

def external_note_changed(studio_obj: Any, path: str, *, local_path_fn: Callable[[str], Path] = _default_local_path, folder_ops_mod: Any = folder_ops) -> None:
    if getattr(studio_obj, "retired", False): return
    local_str = str(local_path_fn(path))
    if _target_suspended(studio_obj, local_str, folder_ops_mod=folder_ops_mod): return
    if getattr(studio_obj, "external_paths", None) is None:
        studio_obj.external_paths = set()
    studio_obj.external_paths.add(local_str)
    if (timer := getattr(studio_obj, "external_timer", None)) is not None:
        timer.start(250)

def refresh_external_notes(studio_obj: Any, *, file_events_mod: Any = file_events, folder_ops_mod: Any = folder_ops) -> None:
    if getattr(studio_obj, "retired", False): return
    changed, studio_obj.external_paths = set(getattr(studio_obj, "external_paths", ())), set()
    active_suspensions = _call_method(studio_obj, "_active_watch_suspensions", _active_suspensions)
    known = {path: ident for path, ident in getattr(studio_obj, "note_identities", {}).items() if not _path_suspended(studio_obj, path, active_suspensions, folder_ops_mod=folder_ops_mod)}
    unsuspended = {p for p in changed if not _target_suspended(studio_obj, p, active_suspensions, folder_ops_mod=folder_ops_mod)}
    if not known and not unsuspended: return

    def reconciled(result, error):
        if getattr(studio_obj, "retired", False) or error: return
        session = getattr(studio_obj, "session", None)
        current_suspensions = _call_method(studio_obj, "_active_watch_suspensions", _active_suspensions)
        emitted_location_change = False
        has_ref = lambda p: fn(p) if callable(fn := getattr(studio_obj, "_has_session_path_reference", None)) else has_session_path_reference(studio_obj, p, folder_ops_mod=folder_ops_mod)
        for old, new in result.items():
            if _any_path_suspended(studio_obj, old, new, current_suspensions, folder_ops_mod=folder_ops_mod) or not has_ref(old):
                continue
            emitted_location_change = True
            if (loc_sig := getattr(session, "locationChanged", None)) is not None:
                loc_sig.emit(old, new or "")
        effective = {p for p in changed if not _target_suspended(studio_obj, p, current_suspensions, folder_ops_mod=folder_ops_mod)}
        reload_fn = getattr(studio_obj, "_reload_changed_content", None)
        reload_fn(effective) if callable(reload_fn) else reload_changed_content(studio_obj, effective, folder_ops_mod=folder_ops_mod)
        for changed_path in effective:
            _invalidate_index(studio_obj, changed_path)
        folder = getattr(studio_obj, "folder", "")
        if folder and (effective or emitted_location_change) and (wl := getattr(session, "workspace_links", None)) is not None:
            wl.invalidate(folder)
        if folder and (
            any(folder_ops_mod.same_path(ch, folder) or folder_ops_mod.matches_path_prefix(ch, folder, is_directory=True) for ch in effective)
            or (emitted_location_change and any(
                folder_ops_mod.matches_path_prefix(p, folder, is_directory=True)
                for old, new in result.items() if (old or new) and not _any_path_suspended(studio_obj, old, new, current_suspensions, folder_ops_mod=folder_ops_mod) for p in (old, new) if p
            ))
        ):
            _call_method(studio_obj, "_load_tree", None)

    _call_method(studio_obj, "_submit", _fallback_submit, lambda: file_events_mod.reconcile(known, changed), reconciled, False)

def location_changed(studio_obj: Any, old: str, new: str, *, folder_ops_mod: Any = folder_ops) -> None:
    if getattr(studio_obj, "retired", False): return
    active_suspensions = _call_method(studio_obj, "_active_watch_suspensions", _active_suspensions)
    if _any_path_suspended(studio_obj, old, new, active_suspensions, folder_ops_mod=folder_ops_mod): return
    if Path(old).exists() and not (new and old != new and old.casefold() == new.casefold()): return  # A temporary atomic-replace gap has healed.
    if new and not Path(new).is_file(): return
    session = getattr(studio_obj, "session", None)
    stamps, locations = getattr(studio_obj, "note_file_stamps", None), getattr(session, "locations", None)
    if isinstance(stamps, dict):
        _pop_matching_locations(stamps, old, folder_ops_mod=folder_ops_mod)
    if new:
        if isinstance(locations, dict) and (loc := _pop_matching_locations(locations, old, folder_ops_mod=folder_ops_mod)):
            locations[new] = loc
        for tab in getattr(studio_obj, "tabs", ()):
            if tab.get("path") and folder_ops_mod.same_path(tab["path"], old):
                tab.update(path=new, name=Path(new).name)
                if isinstance(stamps, dict):
                    with contextlib.suppress(OSError):
                        st = Path(new).stat()
                        stamps[new] = (st.st_mtime_ns, st.st_size)
        if session is not None and hasattr(session, "pinned"):
            session.pinned = [new if folder_ops_mod.same_path(path, old) else path for path in session.pinned]
        if hasattr(studio_obj, "recent"):
            studio_obj.recent = [new if folder_ops_mod.same_path(path, old) else path for path in studio_obj.recent]
        workspace = getattr(session, "workspace", None)
        for paths in (workspace.values() if isinstance(workspace, dict) else ()):
            for entry in paths:
                if entry.get("path") and folder_ops_mod.same_path(entry["path"], old):
                    entry["path"] = new
        studio_obj.message = "Renamed note: " + Path(new).name
    else:
        if isinstance(locations, dict):
            _pop_matching_locations(locations, old, folder_ops_mod=folder_ops_mod)
        if session is not None and hasattr(session, "pinned"):
            session.pinned = [path for path in session.pinned if not folder_ops_mod.same_path(path, old)]
        if hasattr(studio_obj, "recent"):
            studio_obj.recent = [path for path in studio_obj.recent if not folder_ops_mod.same_path(path, old)]
        drafts = getattr(session, "drafts", None)
        for tab in list(getattr(studio_obj, "tabs", ())):
            if not tab.get("path") or not folder_ops_mod.same_path(tab["path"], old):
                continue
            if _call_method(studio_obj, "_is_dirty", _fallback_is_dirty, tab):
                draft = {**tab, "path": "", "name": "Recovered " + tab["name"], "saved": "", "conflict": False}
                if isinstance(drafts, dict):
                    drafts.setdefault("deleted-notes", []).append(draft)
                tab.update(path="", name=draft["name"], conflict=False)
            _call_method(studio_obj, "_remove_tab", _fallback_remove_tab, tab["id"])
        studio_obj.message = "File deleted: " + Path(old).name + ". Its tab was closed; unsaved changes remain recoverable."
    _invalidate_index(studio_obj, old)
    if new: _invalidate_index(studio_obj, new)
    if (wl := getattr(session, "workspace_links", None)) is not None: wl.invalidate()
    _call_method(studio_obj, "_preferences", None)
    _call_method(studio_obj, "_recover", None)
    _call_method(studio_obj, "_emit", None)

def reload_changed_content(studio_obj: Any, changed, *, open_note_fn: Callable[[Path], Any] = open_note, folder_ops_mod: Any = folder_ops, preserve_assets_fn: Callable[[dict[str, str], dict[str, str]], dict[str, str]] = _default_preserve_unchanged_assets) -> None:
    watch_fn = getattr(studio_obj, "_watch_notes", None)
    watch_fn(force=True) if callable(watch_fn) else watch_notes(studio_obj, force=True, folder_ops_mod=folder_ops_mod)
    active_suspensions = _call_method(studio_obj, "_active_watch_suspensions", _active_suspensions)
    changed_set = changed if isinstance(changed, (set, frozenset)) else set(changed)
    saving, staging = getattr(studio_obj, "saving", None) or (), getattr(studio_obj, "_staging_tabs", None) or ()
    if getattr(studio_obj, "note_file_stamps", None) is None: studio_obj.note_file_stamps = {}
    for tab in getattr(studio_obj, "tabs", ()):
        path = tab.get("path", "")
        if not path or _path_suspended(studio_obj, path, active_suspensions, folder_ops_mod=folder_ops_mod) or not ({path, str(Path(path).parent)} & changed_set) or tab["id"] in saving or tab["id"] in staging:
            continue
        was_dirty = bool(_call_method(studio_obj, "_is_dirty", _fallback_is_dirty, tab) or tab.get("agent_staged"))
        try:
            st = Path(path).stat()
            stamp = (st.st_mtime_ns, st.st_size)
        except OSError: continue
        if not was_dirty and studio_obj.note_file_stamps.get(path) == stamp: continue
        tab_id, expected = tab["id"], tab["saved"]

        def finished(result, error, id=tab_id, expected=expected, path=path, stamp=stamp, was_dirty=was_dirty):
            current = next((note for note in getattr(studio_obj, "tabs", ()) if note["id"] == id), None)
            if error or not current: return
            if isinstance(getattr(studio_obj, "note_file_stamps", None), dict):
                studio_obj.note_file_stamps[path] = stamp
            content, assets, portable = result
            if was_dirty or _call_method(studio_obj, "_is_dirty", _fallback_is_dirty, current) or current.get("agent_staged") or current.get("conflict"):
                if content != current["saved"] or assets != current.get("saved_assets", {}):
                    current["conflict"] = True
                    studio_obj.message = "This file changed outside Super MD. Autosave is paused for this tab."
                    _call_method(studio_obj, "_emit", None, False)
                return
            old_assets = current.get("assets", {})
            if current["content"] != expected or (content == expected and assets == old_assets): return
            assets_changed = assets != old_assets
            merged = preserve_assets_fn(old_assets, assets)
            current.update(content=content, saved=content, assets=merged, saved_assets=dict(merged), assets_dirty=False, portable=portable, conflict=False)
            if assets_changed and (ra := getattr(getattr(studio_obj, "session", None), "reader_assets", None)) is not None:
                ra.revoke_tab(getattr(studio_obj, "window_id", ""), id)
            studio_obj.message = "Reloaded externally updated note"
            _call_method(studio_obj, "_emit", None, load=id == getattr(studio_obj, "active", ""))

        _call_method(studio_obj, "_submit", _fallback_submit, lambda path=path: open_note_fn(Path(path)), finished, False)
