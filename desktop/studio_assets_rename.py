"""Unified folder creation, watched file/folder renames, and session path remapping for Studio."""
from __future__ import annotations
import contextlib, os, threading, time, uuid
from pathlib import Path
from typing import Any, Callable

if __package__:
    from . import folder_ops
    from .documents import atomic_write, write_portable
else:
    import folder_ops
    from documents import atomic_write, write_portable


def _default_is_windows() -> bool:
    return os.name == "nt"


def _session_windows(studio_obj: Any) -> list[Any]:
    windows = getattr(getattr(studio_obj, "session", None), "windows", None)
    return list(windows.values()) if isinstance(windows, dict) else []


def _fail_message(studio_obj: Any, text: str) -> None:
    studio_obj.message = str(text)
    studio_obj._emit(False)


def _future_outcome(done_future: Any, cancel_err: str = "") -> tuple[Any, str | None]:
    if done_future.cancelled():
        return None, cancel_err
    try:
        return done_future.result(), None
    except Exception as reason:
        return None, str(reason)


def rename_path_with_windows_retry(before: Path, after: Path, *, is_windows_fn: Callable[[], bool] = _default_is_windows) -> None:
    """Retry brief Windows sharing/access-denied locks (e.g. watcher teardown or indexer)."""
    if not is_windows_fn():
        before.rename(after)
        return
    delay, deadline = 0.005, time.monotonic() + 1.5
    while True:
        try:
            before.rename(after)
            return
        except PermissionError as error:
            if getattr(error, "winerror", None) not in (5, 32) or time.monotonic() >= deadline:
                raise
            time.sleep(delay)
            delay = min(0.05, delay * 2.0)


def active_watch_suspensions(session: Any) -> list[tuple[str, str, bool, threading.Event, str]]:
    with session._watch_suspension_lock:
        active = [item for item in session._watch_suspensions if not item[3].is_set()]
        if len(active) != len(session._watch_suspensions):
            session._watch_suspensions[:] = active
        return list(active)


def suspend_watches_for_prefix(studio_obj: Any, target_path: str, *, is_dir: bool, new_path: str = "") -> None:
    parent_str = folder_ops.canonical_path_str(Path(target_path).parent)
    entry_list = [(target_path, parent_str, is_dir, threading.Event(), new_path)]
    fallback_hit = lambda p: (
        folder_ops.matches_path_prefix(p, target_path, is_directory=is_dir)
        or bool(new_path and folder_ops.matches_path_prefix(p, new_path, is_directory=is_dir))
        or bool(parent_str and folder_ops.same_path(p, parent_str))
    )
    for win in _session_windows(studio_obj):
        if getattr(win, "retired", False):
            continue
        win.note_watch_paths = None
        check = getattr(win, "_is_watch_target_suspended", None)
        hit = (lambda p, fn=check: fn(p, entry_list)) if callable(check) else fallback_hit
        to_remove = [p for p in (win.note_watcher.files() + win.note_watcher.directories()) if hit(p)]
        if to_remove:
            win.note_watcher.removePaths(to_remove)
        if win.external_paths:
            win.external_paths = {p for p in win.external_paths if not hit(p)}
            if not win.external_paths and hasattr(win, "external_timer"):
                win.external_timer.stop()


def hold_watches_for_rename(studio_obj: Any, target_path: str, *, is_dir: bool, new_path: str = "") -> threading.Event:
    resume_event = threading.Event()
    parent_str = folder_ops.canonical_path_str(Path(target_path).parent)
    entry = (target_path, parent_str, is_dir, resume_event, new_path)
    session = getattr(studio_obj, "session", None)
    susp_lock = getattr(session, "_watch_suspension_lock", None)
    if susp_lock is not None:
        with susp_lock:
            session._watch_suspensions[:] = [item for item in session._watch_suspensions if not item[3].is_set()]
            session._watch_suspensions.append(entry)
    suspend_fn = getattr(studio_obj, "_suspend_watches_for_prefix", None)
    if callable(suspend_fn):
        suspend_fn(target_path, is_dir=is_dir, new_path=new_path)
    else:
        suspend_watches_for_prefix(studio_obj, target_path, is_dir=is_dir, new_path=new_path)
    return resume_event


def _restore_watched_notes(studio_obj: Any) -> None:
    for win in _session_windows(studio_obj):
        if not getattr(win, "retired", False):
            win._watch_notes(force=True)


def _remap_workspace_spec(spec: dict, matches: Callable[[Any], bool], remap: Callable[[str], str], *, full: bool) -> None:
    if matches(spec.get("folder")):
        spec["folder"] = remap(spec["folder"])
    if isinstance(spec.get("expanded"), list):
        spec["expanded"] = [remap(p) for p in spec["expanded"]]
    if spec.get("active") and (full or matches(spec.get("active"))):
        spec["active"] = remap(spec["active"])
    if not full:
        return
    if isinstance(spec.get("paths"), list):
        spec["paths"] = [remap(p) for p in spec["paths"]]
    for entry in spec.get("tabs", ()):
        if isinstance(entry, dict) and matches(entry.get("path")):
            entry["path"] = remap(entry["path"])


def remap_session_paths(session: Any, old_path: str, new_path: str, *, is_dir: bool) -> None:
    remap = lambda candidate: folder_ops.remap_path_prefix(candidate, old_path, new_path, is_directory=is_dir)
    matches = lambda candidate: bool(candidate and folder_ops.matches_path_prefix(candidate, old_path, is_directory=is_dir))
    lock = getattr(session, "_rename_state_lock", None)
    with (lock if lock is not None else contextlib.nullcontext()):
        for loc_key in list(session.locations.keys()):
            if matches(loc_key):
                session.locations[remap(loc_key)] = session.locations.pop(loc_key)
        session.pinned = list(dict.fromkeys(remap(p) for p in session.pinned))[:10]
        if hasattr(session, "recent"):
            session.recent = list(dict.fromkeys(session.pinned + [remap(p) for p in session.recent]))[:10]
        for entries in session.workspace.values():
            for entry in entries:
                if matches(entry.get("path")):
                    entry["path"] = remap(entry["path"])
        for ws in getattr(session, "window_workspaces", {}).values():
            if isinstance(ws, dict):
                _remap_workspace_spec(ws, matches, remap, full=False)
        for draft_key, draft_list in getattr(session, "drafts", {}).items():
            if draft_key != "deleted-notes" and isinstance(draft_list, list):
                for draft in draft_list:
                    if isinstance(draft, dict) and matches(draft.get("path")):
                        updated_path = remap(draft["path"])
                        draft.update(path=updated_path, name=Path(updated_path).name)
        if getattr(session, "startup_folder", ""):
            session.startup_folder = remap(session.startup_folder)
        if getattr(session, "startup_expanded", None):
            session.startup_expanded = [remap(p) for p in session.startup_expanded]
        for spec_list_attr in ("startup_windows", "_pending_startup_windows"):
            for spec in getattr(session, spec_list_attr, ()):
                if isinstance(spec, dict):
                    _remap_workspace_spec(spec, matches, remap, full=True)
        session.startup_paths = [remap(p) for p in session.startup_paths]
        if session.startup_active:
            session.startup_active = remap(session.startup_active)
        for entry in session.startup_entries:
            if matches(entry.get("path")):
                entry["path"] = remap(entry["path"])
        workspace_links = getattr(session, "workspace_links", None)
        if workspace_links is not None:
            workspace_links.invalidate()


def sync_path_change(studio_obj: Any, old_path: str, new_path: str, *, is_dir: bool, message: str = "", on_rebound: Callable[[], Any] | None = None) -> None:
    remap = lambda candidate: folder_ops.remap_path_prefix(candidate, old_path, new_path, is_directory=is_dir)
    matches = lambda candidate: bool(candidate and folder_ops.matches_path_prefix(candidate, old_path, is_directory=is_dir))
    parent_str = folder_ops.canonical_path_str(Path(old_path).parent)
    target_windows = [win for win in _session_windows(studio_obj) if not getattr(win, "retired", False)]
    for win in target_windows:
        stamps = getattr(win, "note_file_stamps", None)
        if isinstance(stamps, dict):
            for stamp_key in [k for k in list(stamps) if matches(k)]:
                stamps.pop(stamp_key, None)
        for tab in win.tabs:
            if matches(tab["path"]):
                updated = remap(tab["path"])
                tab.update(path=updated, name=Path(updated).name)
                if isinstance(stamps, dict):
                    with contextlib.suppress(OSError):
                        st = Path(updated).stat()
                        stamps[updated] = (st.st_mtime_ns, st.st_size)
        for path_set in (win._agent_open_paths, win._agent_owned_files):
            remapped = {remap(p) for p in path_set}
            path_set.clear()
            path_set.update(remapped)
        if getattr(win, "external_paths", None):
            win.external_paths = {
                ext_path for ext_path in win.external_paths
                if not matches(ext_path)
                and not folder_ops.matches_path_prefix(ext_path, new_path, is_directory=is_dir)
                and not (parent_str and folder_ops.same_path(ext_path, parent_str))
            }
            if not win.external_paths and hasattr(win, "external_timer"):
                win.external_timer.stop()
    if studio_obj not in target_windows:
        for path_set in (studio_obj._agent_open_paths, studio_obj._agent_owned_files):
            remapped = {remap(p) for p in path_set}
            path_set.clear()
            path_set.update(remapped)
    session = studio_obj.session
    lock = getattr(session, "_rename_state_lock", None)
    with (lock if lock is not None else contextlib.nullcontext()):
        remap_fn = getattr(session, "_remap_session_paths", None)
        if callable(remap_fn):
            remap_fn(old_path, new_path, is_dir=is_dir)
        else:
            remap_session_paths(session, old_path, new_path, is_dir=is_dir)
        if hasattr(session, "_retired_persist_needed"):
            session._retired_persist_needed = False
    if "recent" in getattr(studio_obj, "__dict__", {}):
        studio_obj.recent = [remap(p) for p in studio_obj.recent]
    if message and not getattr(studio_obj, "retired", False):
        studio_obj.message = message
    studio_obj._save_positions()
    studio_obj._preferences(notify=False)
    for win in target_windows:
        if matches(win.folder):
            win.folder = remap(win.folder)
        win.expanded = {remap(p) for p in win.expanded}
        win._pinned_visible_dirs = {remap(p) for p in getattr(win, "_pinned_visible_dirs", ())}
        if win._pending_seeded_find and matches(win._pending_seeded_find.get("path")):
            win._pending_seeded_find["path"] = remap(win._pending_seeded_find["path"])
    if on_rebound is not None:
        on_rebound()
    for win in target_windows:
        if getattr(win, "retired", False):
            continue
        win._watch_notes(force=True)
        win._recover()
        if win.folder:
            win._load_tree()
        if win._folder_search_open and win._folder_search_query.strip():
            win._start_folder_search()
        win._emit()


def _resolve_new_folder_child(open_folder: str, parent_path: str, raw_name: str, *, is_directory: bool, current_ext: str = "") -> Path:
    target_dir = folder_ops.resolve_within_open_folder(open_folder, parent_path or open_folder, allow_root=True, must_exist=True)
    if not target_dir.is_dir():
        raise ValueError("Choose an existing target folder.")
    target = target_dir / folder_ops.validate_entry_name(raw_name, is_directory=is_directory, current_ext=current_ext)
    folder_ops.resolve_within_open_folder(open_folder, target, allow_root=False, must_exist=False)
    return target


def _ensure_new_target_free(target: Path) -> None:
    if target.exists() or folder_ops._is_link_or_junction(target):
        raise ValueError("An item with that name already exists.")


def _expand_created_in_windows(studio_obj: Any, created_path: str, expand_target: Path, *, recover: bool = False) -> None:
    for win in _session_windows(studio_obj):
        if not getattr(win, "retired", False) and win.folder:
            with contextlib.suppress(OSError):
                win_root = Path(folder_ops.canonical_path_str(win.folder))
                if folder_ops.matches_path_prefix(created_path, str(win_root), is_directory=True):
                    ancestors = folder_ops.ancestor_directories_in_folder(win_root, expand_target)
                    win.expanded.update(ancestors)
                    if recover:
                        if hasattr(win, "_pinned_visible_dirs"):
                            win._pinned_visible_dirs.update(ancestors)
                        win._recover()
                    win._load_tree()


def create_folder_note(studio_obj: Any, parent_path: str, name: str, fmt: str = "md", *, write_portable_fn: Callable = write_portable, atomic_write_fn: Callable = atomic_write) -> None:
    if not studio_obj.folder:
        return _fail_message(studio_obj, "Open a folder first.")
    kind = (fmt or "md").strip().lower().lstrip(".")
    if kind not in ("md", "smd"):
        return _fail_message(studio_obj, "Choose Markdown (.md) or portable Super MD (.smd).")
    try:
        target = _resolve_new_folder_child(studio_obj.folder, parent_path, name, is_directory=False, current_ext="." + kind)
    except ValueError as error:
        return _fail_message(studio_obj, str(error))
    studio_obj._activation_generation += 1
    generation = studio_obj._activation_generation

    def work():
        _ensure_new_target_free(target)
        if kind == "smd":
            write_portable_fn(target, "", {})
        else:
            atomic_write_fn(target, b"")
        return folder_ops.canonical_path_str(target.resolve(strict=True))

    def finished(created_path, error):
        if error or not created_path:
            return
        workspace_links = getattr(getattr(studio_obj, "session", None), "workspace_links", None)
        if workspace_links is not None:
            workspace_links.invalidate(studio_obj.folder)
        created = Path(created_path)
        _expand_created_in_windows(studio_obj, created_path, created.parent, recover=False)
        existing = next((t for t in studio_obj.tabs if folder_ops.same_path(t["path"], created_path)), None)
        if existing is None:
            note = studio_obj._note(created.name, "", created_path, "", {}, kind == "smd")
            studio_obj._agent_open_paths.add(created_path)
            studio_obj.tabs.append(note)
        else:
            note = existing
        if generation == studio_obj._activation_generation:
            studio_obj.active = note["id"]
        studio_obj.settings["welcomed"] = True
        studio_obj.recent = [created_path] + [p for p in studio_obj.recent if not folder_ops.same_path(p, created_path)][:29]
        studio_obj.message = f"Created {created.name}"
        studio_obj._watch_notes(force=True)
        studio_obj._preferences()
        studio_obj.recovery_timer.start(800)
        studio_obj._emit()
        if generation == studio_obj._activation_generation:
            studio_obj._focus_open_target(generation)

    studio_obj._submit(work, finished, executor=studio_obj.writes)


def create_subfolder(studio_obj: Any, parent_path: str, name: str) -> None:
    if not studio_obj.folder:
        return _fail_message(studio_obj, "Open a folder first.")
    try:
        target = _resolve_new_folder_child(studio_obj.folder, parent_path, name, is_directory=True)
    except ValueError as error:
        return _fail_message(studio_obj, str(error))

    def work():
        _ensure_new_target_free(target)
        target.mkdir(parents=False, exist_ok=False)
        return folder_ops.canonical_path_str(target.resolve(strict=True))

    def finished(created_dir, error):
        if error or not created_dir:
            return
        workspace_links = getattr(getattr(studio_obj, "session", None), "workspace_links", None)
        if workspace_links is not None:
            workspace_links.invalidate(studio_obj.folder)
        created = Path(created_dir)
        _expand_created_in_windows(studio_obj, created_dir, created, recover=True)
        _fail_message(studio_obj, f"Created folder {created.name}")

    studio_obj._submit(work, finished, executor=studio_obj.writes)


def submit_rename(
    studio_obj: Any, before: Path, after: Path, final_name: str, *,
    is_dir: bool, message_builder: Callable[[str], str], symlink_error: str, exists_error: str,
    rename_fn: Callable[[Path, Path], None] = rename_path_with_windows_retry,
) -> None:
    if getattr(studio_obj, "retired", False) or getattr(getattr(studio_obj, "writes", None), "_shutdown", False):
        return
    before_canon, after_canon = folder_ops.canonical_path_str(before), folder_ops.canonical_path_str(after)
    hold_fn = getattr(studio_obj, "_hold_watches_for_rename", None)
    resume_event = hold_fn(before_canon, is_dir=is_dir, new_path=after_canon) if callable(hold_fn) else hold_watches_for_rename(studio_obj, before_canon, is_dir=is_dir, new_path=after_canon)

    def work():
        if folder_ops._is_link_or_junction(after):
            raise ValueError(symlink_error)
        if after.exists():
            same_inode = False
            if before.name.casefold() == final_name.casefold():
                with contextlib.suppress(OSError):
                    same_inode = os.path.samestat(before.stat(), after.stat())
            if not same_inode:
                raise ValueError(exists_error)
        rename_fn(before, after)
        return before_canon, folder_ops.canonical_path_str(after.resolve(strict=True)), is_dir

    if getattr(studio_obj, "writes", None) is None:
        def done_sync(result, error):
            resume_event.set()
            if error or not result:
                return _restore_watched_notes(studio_obj)
            old_str, new_str, was_dir = result
            sync_fn = getattr(studio_obj, "_sync_path_change", None)
            msg = message_builder(new_str)
            return sync_fn(old_str, new_str, is_dir=was_dir, message=msg) if callable(sync_fn) else sync_path_change(studio_obj, old_str, new_str, is_dir=was_dir, message=msg)
        studio_obj._submit(work, done_sync, executor=None)
        return

    session = studio_obj.session
    token = uuid.uuid4().hex
    state_lock, finalize_lock = threading.Lock(), threading.Lock()
    suspension_released, finalized, busy_active = False, False, True
    future_holder: list[Any] = []

    def release_suspension() -> bool:
        nonlocal suspension_released
        with state_lock:
            if suspension_released:
                return False
            suspension_released = True
        resume_event.set()
        with session._watch_suspension_lock:
            session._watch_suspensions[:] = [item for item in session._watch_suspensions if not item[3].is_set()]
        session._pending_rename_cleanups.pop(token, None)
        with studio_obj._write_callback_lock:
            studio_obj._pending_write_retirements.pop(token, None)
        return True

    def release_busy() -> None:
        nonlocal busy_active
        with state_lock:
            if not busy_active:
                return
            busy_active = False
        if studio_obj.busy > 0:
            studio_obj.busy -= 1

    def apply_without_live_windows(value, error) -> None:
        nonlocal finalized
        with finalize_lock:
            should_apply = not finalized
            finalized = True
        release_busy()
        if should_apply and value is not None and not error:
            old_str, new_str, was_dir = value
            with session._rename_state_lock:
                session._remap_session_paths(old_str, new_str, is_dir=was_dir)
                session._retired_persist_needed = True
            session._enqueue_retired_persistence()
        release_suspension()

    def finalize_without_live_windows(done_future) -> None:
        value, error = _future_outcome(done_future, cancel_err="cancelled")
        apply_without_live_windows(value, error)

    def finish_on_ui(value, error) -> None:
        nonlocal finalized
        live_windows = [w for w in list(session.windows.values()) if not w.retired]
        if not live_windows:
            return apply_without_live_windows(value, error)
        with finalize_lock:
            if finalized:
                release_suspension()
                return
            finalized = True
        release_busy()
        if error or not value:
            release_suspension()
            for win in live_windows:
                win._watch_notes(force=True)
            if not studio_obj.retired:
                if error:
                    studio_obj.message, studio_obj.pending_close = error, ""
                studio_obj._emit(False)
            return
        old_str, new_str, was_dir = value
        target_win = studio_obj if not studio_obj.retired else live_windows[0]
        target_win._sync_path_change(
            old_str, new_str, is_dir=was_dir,
            message=message_builder(new_str) if target_win is studio_obj else "",
            on_rebound=release_suspension,
        )

    def cleanup_when_no_live_windows() -> None:
        nonlocal finalized
        release_busy()
        if any(not w.retired for w in list(session.windows.values())):
            return
        fut = future_holder[0] if future_holder else None
        if fut is None:
            with finalize_lock:
                finalized = True
            release_suspension()
        elif fut.done():
            finalize_without_live_windows(fut)

    session._pending_rename_cleanups[token] = cleanup_when_no_live_windows
    with studio_obj._write_callback_lock:
        studio_obj._pending_write_retirements[token] = cleanup_when_no_live_windows
    studio_obj.busy += 1
    studio_obj._emit(False)
    try:
        future = studio_obj.writes.submit(work)
    except RuntimeError:
        with finalize_lock:
            finalized = True
        release_busy()
        release_suspension()
        _restore_watched_notes(studio_obj)
        studio_obj._emit(False)
        return
    future_holder.append(future)

    def completed(f) -> None:
        if not any(not w.retired for w in list(session.windows.values())):
            return finalize_without_live_windows(f)
        value, error = _future_outcome(f, cancel_err="")
        if not any(not w.retired for w in list(session.windows.values())):
            return apply_without_live_windows(value, error)
        try:
            session.renameCompleted.emit((finish_on_ui, value, error))
        except RuntimeError:
            apply_without_live_windows(value, error)

    future.add_done_callback(completed)


def _dispatch_rename(
    studio_obj: Any, before: Path, after: Path, final_name: str, *,
    rename_fn: Callable[[Path, Path], None] | None = None,
    **kwargs: Any,
) -> None:
    if rename_fn is None and callable(fn := getattr(studio_obj, "_submit_rename", None)):
        return fn(before, after, final_name, **kwargs)
    return submit_rename(
        studio_obj, before, after, final_name,
        rename_fn=rename_path_with_windows_retry if rename_fn is None else rename_fn,
        **kwargs,
    )


def rename_entry(
    studio_obj: Any, entry_path: str, name: str, *,
    rename_fn: Callable[[Path, Path], None] | None = None,
) -> None:
    if not studio_obj.folder:
        return _fail_message(studio_obj, "Open a folder first.")
    try:
        before = folder_ops.resolve_within_open_folder(studio_obj.folder, entry_path, allow_root=False, must_exist=True)
        is_dir = before.is_dir()
        final_name = folder_ops.validate_entry_name(name, is_directory=is_dir, current_ext="" if is_dir else folder_ops.note_extension(before.name), has_saved_target=True)
        after = before.with_name(final_name)
        if not folder_ops.same_path(after, before):
            folder_ops.resolve_within_open_folder(studio_obj.folder, after, allow_root=False, must_exist=False)
    except ValueError as error:
        return _fail_message(studio_obj, str(error))
    if before.name == final_name:
        return
    for win in _session_windows(studio_obj):
        for tab in win.tabs:
            if tab["id"] in win.saving and folder_ops.matches_path_prefix(tab["path"], str(before), is_directory=is_dir):
                return _fail_message(studio_obj, "Wait for the current save to finish.")
    _dispatch_rename(
        studio_obj, before, after, final_name, is_dir=is_dir,
        message_builder=lambda new_str: f"Renamed to {Path(new_str).name}",
        symlink_error="Symlinks are not allowed inside the open folder.",
        exists_error="An item with that name already exists.",
        rename_fn=rename_fn,
    )


def rename_note(
    studio_obj: Any, note_id: str, name: str, *,
    rename_fn: Callable[[Path, Path], None] | None = None,
) -> None:
    tab = next((t for t in studio_obj.tabs if t["id"] == note_id), None)
    if not tab or note_id in getattr(studio_obj, "saving", ()):
        return
    try:
        has_saved = bool(tab.get("path"))
        existing_ext = folder_ops.note_extension(tab["name"])
        current_ext = existing_ext if has_saved else (existing_ext or (".smd" if tab.get("portable") else ".md"))
        final_name = folder_ops.validate_entry_name(name, is_directory=False, current_ext=current_ext, has_saved_target=has_saved)
    except ValueError as error:
        return _fail_message(studio_obj, str(error))
    if not tab["path"]:
        tab["name"] = final_name
        studio_obj._recover()
        studio_obj._emit(False)
        return
    before = Path(tab["path"])
    after = before.with_name(final_name)
    if before.name == final_name:
        return
    if getattr(studio_obj, "folder", "") and folder_ops.matches_path_prefix(str(before), studio_obj.folder, is_directory=True):
        if rename_fn is None and callable(rename_entry_fn := getattr(studio_obj, "renameEntry", None)):
            return rename_entry_fn(str(before), final_name)
        return rename_entry(studio_obj, str(before), final_name, rename_fn=rename_fn)
    _dispatch_rename(
        studio_obj, before, after, final_name, is_dir=False,
        message_builder=lambda _new_str: f"Renamed to {final_name}",
        symlink_error="Symlinks are not allowed.",
        exists_error="A file with that name already exists.",
        rename_fn=rename_fn,
    )
