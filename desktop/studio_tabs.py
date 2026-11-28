"""Note tab model, cross-window tab drag/detach, note open/navigation, and close/recovery helpers."""
from __future__ import annotations

import contextlib, copy, json, os, sys, uuid
from pathlib import Path
from PySide6.QtCore import QMetaObject, QObject, QPointF, QTimer, QUrl, Qt
from PySide6.QtGui import QCursor, QGuiApplication
if __package__:
    from . import folder_ops
    from .closed_notes import ClosedNoteStore
    from .documents import open_note
else:
    import folder_ops
    from closed_notes import ClosedNoteStore
    from documents import open_note

def _call_optional(obj, attr: str, *args, **kwargs):
    fn = getattr(obj, attr, None)
    return fn(*args, **kwargs) if callable(fn) else None

def _call_method(studio_obj, attr: str, fallback, *args, **kwargs):
    fn = getattr(studio_obj, attr, None)
    return fn(*args, **kwargs) if callable(fn) else fallback(studio_obj, *args, **kwargs)

def local_path(value: str) -> Path:
    url = QUrl(value)
    return Path(folder_ops.strip_extended_length_prefix(str(Path(url.toLocalFile() if url.isLocalFile() else value).expanduser().resolve())))

def _seeded_find_bounds(data: dict) -> dict:
    start, end, match_text = data.get("sourceStart"), data.get("sourceEnd"), data.get("matchText")
    if isinstance(start, int) and not isinstance(start, bool) and isinstance(end, int) and not isinstance(end, bool) and 0 <= start <= end:
        return {"sourceStart": start, "sourceEnd": end, **({"matchText": match_text} if isinstance(match_text, str) and match_text else {})}
    return {}

def same_closed_revision(current: dict, captured: dict) -> bool:
    """Compare content-bearing fields after a background close snapshot."""
    return current == captured

def snapshot_tab_state(tab: dict, *, include_view_state: bool = True) -> dict:
    """Snapshot tab metadata and asset dicts without walking immutable image strings."""
    snapshot = {}
    for key, value in tab.items():
        if not include_view_state and key == "viewState":
            continue
        if key in ("assets", "saved_assets") and isinstance(value, dict):
            snapshot[key] = dict(value)
        elif (key == "outline" and isinstance(value, list)) or (key == "viewState" and value is not None):
            snapshot[key] = copy.deepcopy(value)
        elif isinstance(value, (str, int, float, bool)) or value is None:
            snapshot[key] = value
        else:
            snapshot[key] = copy.deepcopy(value)
    return snapshot

_same_closed_revision = same_closed_revision
_snapshot_tab_state = snapshot_tab_state

def _has_note_substance(tab: dict) -> bool:
    return bool(tab.get("path") or tab.get("content", "").strip() or tab.get("assets"))

def _prepend_recent(studio_obj, path: Path, fops) -> str:
    canon = fops.canonical_path_str(path)
    studio_obj.recent = [canon] + [p for p in studio_obj.recent if not fops.same_path(p, canon)][:29]
    _call_optional(studio_obj, "_preferences", notify=False)
    return canon

def _record_closed_reference(studio_obj, reference: dict) -> None:
    next_refs = ([reference] + studio_obj.closed_tabs)[:ClosedNoteStore.LIMIT]
    studio_obj.session.closed_note_store.save_index(next_refs)
    studio_obj.closed_tabs[:] = next_refs

def pin_recent(studio_obj, path: str, *, folder_ops_mod=folder_ops) -> None:
    matched_recent = next((item for item in studio_obj.recent if folder_ops_mod.same_path(item, path)), None)
    if matched_recent is None:
        return
    session = studio_obj.session
    if any(folder_ops_mod.same_path(item, matched_recent) for item in session.pinned):
        session.pinned = [item for item in session.pinned if not folder_ops_mod.same_path(item, matched_recent)]
    else:
        session.pinned.append(matched_recent)
    studio_obj.recent = studio_obj.recent
    _call_optional(studio_obj, "_preferences")
    for window in tuple(getattr(session, "windows", {}).values()):
        _call_optional(window, "_notify_sidebar")

def make_note(studio_obj, name: str, content: str = "", path: str = "", saved: str = "", assets: dict | None = None, portable: bool = False, *, uuid_fn=uuid.uuid4) -> dict:
    asset_map = dict(assets) if assets else {}
    return {"id": uuid_fn().hex, "name": name, "content": content, "path": path, "saved": saved, "assets": asset_map, "saved_assets": dict(asset_map),
            "assets_dirty": False, "portable": portable, "conflict": False, "agent_staged": False, "agent_unreviewed": False, "agent_edits": []}

def is_dirty(studio_obj, tab: dict) -> bool:
    if tab.get("content") != tab.get("saved") or tab.get("assets_dirty"):
        return True
    return bool(tab.get("path") and "saved_assets" in tab and tab.get("assets", {}) != tab.get("saved_assets", {}))

def current_tab(studio_obj) -> dict:
    tabs = getattr(studio_obj, "tabs", ())
    if not tabs:
        return {"id": "", "name": "Super MD", "content": "", "path": "", "saved": "", "assets": {}, "saved_assets": {}, "assets_dirty": False, "portable": False, "conflict": False, "outline": []}
    return next((t for t in tabs if t["id"] == getattr(studio_obj, "active", "")), tabs[0])

def consume_seeded_find(studio_obj, tab: dict, *, seeded_find_bounds_fn=None) -> dict | None:
    pending = getattr(studio_obj, "_pending_seeded_find", None)
    if not pending or not tab.get("id"):
        return None
    target_id, target_path = pending.get("tabId") or "", pending.get("path") or ""
    matches_id = bool(target_id and tab["id"] == target_id)
    matches_path = bool(target_path and tab.get("path") and os.path.normcase(str(Path(tab["path"]).resolve(strict=False))) == os.path.normcase(str(Path(target_path).resolve(strict=False))))
    if not (matches_id or matches_path):
        return None
    studio_obj._pending_seeded_find = None
    bounds_fn = seeded_find_bounds_fn or getattr(studio_obj, "_seeded_find_bounds", _seeded_find_bounds)
    return {"query": pending["query"], "caseSensitive": bool(pending.get("caseSensitive", False)), **bounds_fn(pending)}

def can_move(studio_obj) -> bool:
    return not any(getattr(studio_obj, attr, False) for attr in ("retired", "busy", "saving", "_staging_tabs", "pending_close", "pending_save_as", "pending_export", "flush_operation"))

def can_receive_tab(studio_obj, source_id: str, tab_id: str) -> bool:
    source = studio_obj.session.windows.get(source_id)
    return bool(source and _call_method(source, "_can_move", can_move) and _call_method(studio_obj, "_can_move", can_move) and any(t["id"] == tab_id for t in source.tabs))

def receive_tab(studio_obj, source_id: str, tab_id: str, index: int) -> None:
    if not _call_method(studio_obj, "canReceiveTab", can_receive_tab, source_id, tab_id):
        return
    source = studio_obj.session.windows[source_id]
    if source is studio_obj:
        old = next(i for i, t in enumerate(studio_obj.tabs) if t["id"] == tab_id)
        note = studio_obj.tabs.pop(old)
        studio_obj.tabs.insert(max(0, min(len(studio_obj.tabs), index - (1 if old < index else 0))), note)
        _call_optional(studio_obj, "_recover")
        _call_optional(studio_obj, "_emit", False)
    else:
        source._flush("move_tab", json.dumps({"window": studio_obj.window_id, "tab": tab_id, "index": index}))

def move_tab(studio_obj, target, tab_id: str, index: int, *, single_shot_fn=QTimer.singleShot) -> bool:
    if target is studio_obj or not _call_method(studio_obj, "_can_move", can_move) or not _call_method(target, "_can_move", can_move):
        return False
    note = next((t for t in studio_obj.tabs if t["id"] == tab_id), None)
    if not note:
        return False
    _call_optional(getattr(studio_obj, "_python_jobs", None), "cancel_tab", tab_id)
    old = studio_obj.tabs.index(note)
    studio_obj.tabs.remove(note)
    _call_optional(getattr(studio_obj, "_preview_jobs", None), "cancel_tab", tab_id)
    studio_obj.session.reader_assets.revoke_tab(studio_obj.window_id, tab_id)
    target.tabs.insert(max(0, min(len(target.tabs), index)), note)
    target.active = tab_id
    _call_optional(target, "_activate_tab_state", note)
    emptied = not studio_obj.tabs
    if emptied:
        studio_obj.tabs.append(_call_method(studio_obj, "_note", make_note, "Untitled.md"))
    if studio_obj.active == tab_id:
        studio_obj.active = studio_obj.tabs[min(old, len(studio_obj.tabs) - 1)]["id"]
        _call_optional(studio_obj, "_activate_tab_state", _call_method(studio_obj, "_current", current_tab))
    with getattr(studio_obj.session, "_rename_state_lock", None) or contextlib.nullcontext():
        studio_obj.session.drafts[studio_obj.window_id] = studio_obj._window_recovery_drafts()
    _call_optional(target, "_recover")
    _call_optional(studio_obj, "_emit")
    _call_optional(target, "_emit")
    if emptied:
        single_shot_fn(0, studio_obj.allowClose.emit)
    return True

def detach_tab(studio_obj, tab_id: str) -> None:
    if _call_method(studio_obj, "_can_move", can_move) and any(t["id"] == tab_id for t in studio_obj.tabs):
        studio_obj._flush("detach_tab", tab_id)

def tab_preview(studio_obj, tab_id: str) -> str:
    note = next((t for t in studio_obj.tabs if t["id"] == tab_id), None)
    return note["content"][:900] if note else ""

def finish_tab_drag(studio_obj, tab_id: str, action: int, *, single_shot_fn=QTimer.singleShot) -> None:
    if action == int(Qt.DropAction.IgnoreAction.value):
        single_shot_fn(150, lambda: _call_method(studio_obj, "_finish_tab_drag", complete_tab_drag, tab_id))

def complete_tab_drag(studio_obj, tab_id: str, *, mouse_buttons_fn=QGuiApplication.mouseButtons, cursor_pos_fn=QCursor.pos) -> None:
    if mouse_buttons_fn() & Qt.MouseButton.LeftButton:
        return
    cursor = cursor_pos_fn()
    for backend in studio_obj.session.windows.values():
        host = backend.host_window
        if host and host.isVisible():
            strip = host.findChild(QObject, "tabStrip")
            if strip:
                point = strip.mapFromGlobal(QPointF(cursor))
                if 0 <= point.x() <= strip.width() and 0 <= point.y() <= strip.height():
                    return
    _call_method(studio_obj, "detachTab", detach_tab, tab_id)

def same_open_tab_path(tab_path: str, path: Path, *, folder_ops_mod=folder_ops) -> bool:
    if not tab_path:
        return False
    if tab_path == str(path) or folder_ops_mod.same_path(tab_path, path):
        return True
    try:
        return not Path(tab_path).is_symlink() and os.path.samefile(tab_path, path)
    except OSError:
        return False

def has_open_tab_for_path(studio_obj, value, *, local_path_fn=local_path, folder_ops_mod=folder_ops) -> bool:
    if getattr(studio_obj, "retired", False):
        return False
    path = value if isinstance(value, Path) else local_path_fn(str(value))
    if path.is_dir():
        return False
    same_fn = getattr(studio_obj, "_same_open_tab_path", None)
    check_tab = same_fn if callable(same_fn) else (lambda tp, p: same_open_tab_path(tp, p, folder_ops_mod=folder_ops_mod))
    if any(check_tab(tab.get("path", ""), path) for tab in getattr(studio_obj, "tabs", ())):
        return True
    if any(folder_ops_mod.same_path(restoring, path) for restoring in getattr(studio_obj, "_restoring_paths", ())):
        return True
    return any(count > 0 and folder_ops_mod.same_path(opening, path) for opening, count in getattr(studio_obj, "_opening_paths", {}).items())

def open_path(studio_obj, value: str, *, local_path_fn=local_path, folder_ops_mod=folder_ops) -> None:
    if getattr(studio_obj, "retired", False):
        return
    path = local_path_fn(value)
    if path.is_dir():
        studio_obj.openFolder(str(path))
        if getattr(studio_obj, "folder", "") and folder_ops_mod.same_path(studio_obj.folder, path):
            _call_optional(getattr(studio_obj, "workspaceFolderDropped", None), "emit")
            host = getattr(studio_obj, "host_window", None)
            if host is not None:
                host.raise_()
                host.requestActivate()
        return
    had_unwelcomed_placeholder = not bool(getattr(studio_obj, "settings", {}).get("welcomed"))
    opening_paths = getattr(studio_obj, "_opening_paths", None)
    canon_opening = folder_ops_mod.canonical_path_str(path)
    if canon_opening and opening_paths is not None:
        opening_paths[canon_opening] = opening_paths.get(canon_opening, 0) + 1
    open_generation = getattr(studio_obj, "_activation_generation", 0) + 1

    def finish_open_path(opened_tab, error):
        if canon_opening and opening_paths is not None and canon_opening in opening_paths:
            remaining_opens = opening_paths[canon_opening] - 1
            if remaining_opens > 0:
                opening_paths[canon_opening] = remaining_opens
            else:
                opening_paths.pop(canon_opening, None)
        if error or opened_tab is None or getattr(studio_obj, "retired", False):
            return
        previous_active = studio_obj.active
        placeholder_removed = bool(_call_optional(
            studio_obj, "_remove_untouched_startup_placeholders", keep_tab_id=opened_tab["id"], allow_welcome_sample=had_unwelcomed_placeholder,
        ))
        active_changed = studio_obj.active != previous_active
        was_unwelcomed = not bool(studio_obj.settings.get("welcomed"))
        if was_unwelcomed:
            studio_obj.settings["welcomed"] = True
            _call_optional(studio_obj, "_preferences", notify=False)
        if placeholder_removed:
            studio_obj.recovery_timer.start(800)
        if placeholder_removed or was_unwelcomed:
            emit_load = active_changed or (was_unwelcomed and studio_obj.active == opened_tab["id"] and open_generation == studio_obj._activation_generation)
            _call_optional(studio_obj, "_emit", emit_load)

    _call_method(
        studio_obj, "_open_note",
        lambda s, v, **kw: open_note_workflow(s, v, local_path_fn=local_path_fn, folder_ops_mod=folder_ops_mod, **kw),
        str(path), explicit=True, completion_callback=finish_open_path,
    )

def choose_folder(studio_obj, *, sys_platform: str = sys.platform) -> None:
    if not sys_platform.startswith("linux"):
        studio_obj.folderPickerRequested.emit()
        return
    if getattr(studio_obj, "_folder_check", None) is not None:
        return
    from PySide6.QtDBus import QDBusConnection, QDBusMessage, QDBusPendingCallWatcher, QDBusVariant
    message = QDBusMessage.createMethodCall("org.freedesktop.portal.Desktop", "/org/freedesktop/portal/desktop", "org.freedesktop.DBus.Properties", "Get")
    message.setArguments(["org.freedesktop.portal.FileChooser", "version"])
    parent = studio_obj if isinstance(studio_obj, QObject) else None
    studio_obj._folder_check = watcher = QDBusPendingCallWatcher(QDBusConnection.sessionBus().asyncCall(message, 3000), parent)

    def finished(call):
        reply = call.reply()
        values = reply.arguments()
        version = values[0].variant() if values and isinstance(values[0], QDBusVariant) else (values[0] if values else 0)
        studio_obj._folder_check = None
        call.deleteLater()
        if reply.type() == QDBusMessage.MessageType.ReplyMessage and isinstance(version, int) and version >= 3:
            studio_obj.folderPickerRequested.emit()
        else:
            studio_obj.message = "The system folder picker is unavailable. Enable an XDG desktop portal file chooser, or open a folder with Super MD from your file manager."
            _call_optional(studio_obj, "_emit", False)

    watcher.finished.connect(finished)

def open_note_slot(studio_obj, value: str) -> None:
    _call_method(studio_obj, "_open_note", open_note_workflow, value, explicit=True)

def focus_open_target(studio_obj, generation: int, *, single_shot_fn=QTimer.singleShot) -> None:
    window = None if generation != studio_obj._activation_generation or getattr(studio_obj, "retired", False) else studio_obj.host_window
    if window is not None:
        window.raise_()
        window.requestActivate()
        single_shot_fn(
            0,
            lambda: QMetaObject.invokeMethod(window, "focusReader", Qt.ConnectionType.QueuedConnection)
            if generation == studio_obj._activation_generation and not getattr(studio_obj, "retired", False) else None,
        )

def open_note_workflow(
    studio_obj, value, *, explicit: bool, background: bool = False, activation_generation=None,
    completion_callback=None, batch_insert=None, should_activate_fn=None, pending_heading=None,
    local_path_fn=local_path, open_note_fn=open_note, folder_ops_mod=folder_ops,
) -> None:
    done = completion_callback or (lambda *_: None)
    if getattr(studio_obj, "retired", False):
        done(None, "The document window is no longer available")
        return
    fops = folder_ops_mod
    path = local_path_fn(value)
    if path.is_dir():
        studio_obj.openFolder(str(path))
        done(None, "A folder cannot be opened as a document")
        return
    if activation_generation is None:
        if explicit and not background:
            studio_obj._activation_generation += 1
        activation_generation = studio_obj._activation_generation
    restoring = not explicit and not background and str(path) in studio_obj._restoring_paths

    def activate_existing(target_tab):
        if not (explicit and not background and activation_generation == studio_obj._activation_generation) or (should_activate_fn is not None and not should_activate_fn(target_tab)):
            return
        if pending_heading:
            target_tab["pendingHeading"] = pending_heading
        else:
            target_tab.pop("pendingHeading", None)
        if batch_insert is None:
            _prepend_recent(studio_obj, path, fops)
        was_active = studio_obj.active == target_tab["id"]
        _call_method(studio_obj, "_select_tab_from_open", select_tab_from_open, target_tab["id"], activation_generation)
        if was_active:
            _call_optional(studio_obj, "_emit", bool(pending_heading))
        for window in list(studio_obj.session.windows.values()):
            if window is not studio_obj and not getattr(window, "retired", False):
                _call_optional(window, "_emit", False)
        _call_method(studio_obj, "_focus_open_target", focus_open_target, activation_generation)

    same_fn = getattr(studio_obj, "_same_open_tab_path", None)
    check_open_path = (lambda tp: same_fn(tp, path)) if callable(same_fn) else (lambda tp: same_open_tab_path(tp, path, folder_ops_mod=fops))
    found = next((t for t in studio_obj.tabs if check_open_path(t["path"])), None)
    if found:
        studio_obj._agent_open_paths.add(fops.canonical_path_str(path))
        studio_obj._restoring_paths.discard(str(path))
        if restoring and activation_generation == studio_obj._activation_generation and str(path) == (studio_obj._startup_active or studio_obj.session.startup_active):
            _call_method(studio_obj, "_select_tab_from_open", select_tab_from_open, found["id"], activation_generation)
        activate_existing(found)
        done(found, None)
        return

    def finished(result, error):
        studio_obj._restoring_paths.discard(str(path))
        if error:
            if restoring and not studio_obj._restoring_paths and activation_generation == studio_obj._activation_generation:
                _call_optional(studio_obj, "_activate_tab_state", _call_method(studio_obj, "_current", current_tab))
            done(None, error)
            return
        content, assets, portable = result
        existing = next((tab for tab in studio_obj.tabs if check_open_path(tab["path"])), None)
        if existing:
            activate_existing(existing)
            done(existing, None)
            return
        note = _call_method(studio_obj, "_note", make_note, path.name, content, str(path), content, assets, portable)
        studio_obj._agent_open_paths.add(fops.canonical_path_str(path))
        if restoring and activation_generation == studio_obj._activation_generation:
            studio_obj.tabs = [t for t in studio_obj.tabs if t["id"] not in studio_obj._startup_placeholder_ids]
            studio_obj._startup_placeholder_ids.clear()
        batch_insert(note) if batch_insert is not None else studio_obj.tabs.append(note)
        if restoring:
            keys = [entry["path"] or entry["id"] for entry in studio_obj._startup_entries] or studio_obj._startup_order
            studio_obj.tabs.sort(key=lambda t: keys.index(t["path"] or t["id"]) if (t["path"] or t["id"]) in keys else -1)
        should_activate = bool(not background and explicit and activation_generation == studio_obj._activation_generation and (should_activate_fn is None or should_activate_fn(note)))
        if restoring and not background and activation_generation == studio_obj._activation_generation:
            target_active = studio_obj._startup_active or studio_obj.session.startup_active
            should_activate = str(path) == target_active or not any(t["id"] == studio_obj.active for t in studio_obj.tabs)
        if should_activate:
            studio_obj.active = note["id"]
            _call_optional(studio_obj, "_activate_tab_state", note)
            if pending_heading:
                note["pendingHeading"] = pending_heading
        elif restoring and not studio_obj._restoring_paths and activation_generation == studio_obj._activation_generation:
            _call_optional(studio_obj, "_activate_tab_state", _call_method(studio_obj, "_current", current_tab))
        studio_obj.settings["welcomed"] = True
        _prepend_recent(studio_obj, path, fops)
        studio_obj.recovery_timer.start(800)
        emit_load = False if background else (should_activate if (should_activate_fn is not None or explicit) else True)
        for window in list(studio_obj.session.windows.values()):
            _call_optional(window, "_emit", emit_load if window is studio_obj else not background)
        if explicit and should_activate:
            _call_method(studio_obj, "_focus_open_target", focus_open_target, activation_generation)
        done(note, None)

    studio_obj._submit(lambda: open_note_fn(path), finished)

def new_note(studio_obj, *, uuid_fn=uuid.uuid4) -> None:
    studio_obj._activation_generation += 1
    note = _call_method(studio_obj, "_note", lambda s, n: make_note(s, n, uuid_fn=uuid_fn), "Untitled.md")
    studio_obj.tabs.append(note)
    studio_obj.active = note["id"]
    studio_obj.recovery_timer.start(800)
    _call_optional(studio_obj, "_emit")

def select_tab(studio_obj, tab_id: str) -> None:
    if any(t["id"] == tab_id for t in studio_obj.tabs):
        studio_obj._activation_generation += 1
        for tab in studio_obj.tabs:
            tab.pop("pendingHeading", None)
    _call_method(studio_obj, "_select_tab_from_open", select_tab_from_open, tab_id, studio_obj._activation_generation)

def select_tab_from_open(studio_obj, tab_id: str, generation: int) -> None:
    if generation == studio_obj._activation_generation and tab_id != studio_obj.active and any(t["id"] == tab_id for t in studio_obj.tabs):
        studio_obj.active = tab_id
        _call_optional(studio_obj, "_activate_tab_state", _call_method(studio_obj, "_current", current_tab))
        studio_obj.recovery_timer.start(800)
        _call_optional(studio_obj, "_emit")

def cycle_tab(studio_obj, direction: int) -> None:
    if studio_obj.tabs:
        index = next((i for i, t in enumerate(studio_obj.tabs) if t["id"] == studio_obj.active), 0)
        _call_method(studio_obj, "selectTab", select_tab, studio_obj.tabs[(index + direction) % len(studio_obj.tabs)]["id"])

def move_active_tab(studio_obj, direction: int) -> None:
    if direction in (-1, 1) and len(studio_obj.tabs) >= 2:
        index = next((i for i, t in enumerate(studio_obj.tabs) if t["id"] == studio_obj.active), -1)
        target = max(0, min(len(studio_obj.tabs) - 1, index + direction))
        if index >= 0 and target != index:
            studio_obj.tabs.insert(target, studio_obj.tabs.pop(index))
            _call_optional(studio_obj, "_recover")
            _call_optional(studio_obj, "_emit", False)

def tab_number(studio_obj, number: int) -> None:
    index = len(studio_obj.tabs) - 1 if number == 9 else number - 1
    if 0 <= index < len(studio_obj.tabs):
        _call_method(studio_obj, "selectTab", select_tab, studio_obj.tabs[index]["id"])

def reopen_tab(studio_obj, *, snapshot_tab_fn=snapshot_tab_state, same_closed_revision_fn=same_closed_revision) -> None:
    if not studio_obj.closed_tabs:
        return
    studio_obj._activation_generation += 1
    activation_generation, reference = studio_obj._activation_generation, studio_obj.closed_tabs[0]

    def finished(note, error):
        if error:
            studio_obj.message = "Could not reopen the closed note: " + error
            _call_optional(studio_obj, "_emit", False)
            return
        if reference not in studio_obj.closed_tabs:
            return
        for key, default in (("saved_assets", dict(note.get("assets", {}))), ("assets_dirty", False), ("conflict", False), ("agent_staged", False), ("agent_unreviewed", False), ("agent_edits", [])):
            note.setdefault(key, default)
        next_refs = [item for item in studio_obj.closed_tabs if item is not reference]
        try:
            studio_obj.session.closed_note_store.save_index(next_refs)
        except Exception as failure:
            studio_obj.message = "Could not update closed-note recovery: " + str(failure)
            _call_optional(studio_obj, "_emit", False)
            return
        existing = next((t for t in studio_obj.tabs if note.get("path") and t["path"] == note["path"]), None)
        target_note = existing or note
        if not existing:
            note["agent_staged"] = bool(note.get("agent_staged", False))
            studio_obj.tabs.append(note)
            if note.get("path"):
                try:
                    studio_obj._agent_open_paths.add(str(Path(note["path"]).resolve()))
                except OSError:
                    pass
        if activation_generation == studio_obj._activation_generation:
            studio_obj.active = target_note["id"]
            _call_optional(studio_obj, "_activate_tab_state", target_note)
        studio_obj.closed_tabs[:] = next_refs
        _call_optional(studio_obj, "_recover")
        _call_optional(studio_obj, "_emit")

    read_note = lambda: studio_obj.session.closed_note_store.load(reference) if reference.get("_closedSnapshot") else snapshot_tab_fn(reference)
    studio_obj._submit(read_note, finished, False, studio_obj.writes)

def close_tab(studio_obj, tab_id: str) -> None:
    tab = next((t for t in studio_obj.tabs if t["id"] == tab_id), None)
    if not tab:
        return
    studio_obj._activation_generation += 1
    if _call_method(studio_obj, "_is_dirty", is_dirty, tab) and _has_note_substance(tab):
        studio_obj.pending_close = tab_id
        _call_method(studio_obj, "selectTab", select_tab, tab_id)
        studio_obj.closeRequested.emit(tab["name"])
    else:
        _call_method(studio_obj, "_remove_tab", remove_tab, tab_id)

def remove_tab(studio_obj, tab_id: str, *, snapshot_tab_fn=snapshot_tab_state, same_closed_revision_fn=same_closed_revision) -> None:
    removed = next((tab for tab in studio_obj.tabs if tab["id"] == tab_id), None)
    if removed is None:
        return
    if not _has_note_substance(removed):
        _call_method(studio_obj, "_finish_remove_tab", finish_remove_tab, tab_id)
        return
    if tab_id in studio_obj._closing_tabs:
        return
    studio_obj._closing_tabs.add(tab_id)
    _call_optional(getattr(studio_obj, "_preview_jobs", None), "cancel_tab", tab_id)
    studio_obj._python_jobs.cancel_tab(tab_id)
    captured = snapshot_tab_fn(removed)

    def saved(reference, error):
        studio_obj._closing_tabs.discard(tab_id)
        if error:
            studio_obj.message = "Could not preserve the closed note: " + error
            return
        current = next((tab for tab in studio_obj.tabs if tab["id"] == tab_id), None)
        if current is None:
            return
        if not same_closed_revision_fn(current, captured):
            studio_obj.message = "The note changed while it was closing. It remains open with the latest text."
            return
        try:
            _record_closed_reference(studio_obj, reference)
        except Exception as failure:
            studio_obj.message = "Could not update closed-note recovery: " + str(failure)
            return
        _call_method(studio_obj, "_finish_remove_tab", finish_remove_tab, tab_id)

    studio_obj._submit(lambda: studio_obj.session.closed_note_store.save(captured), saved, False, studio_obj.writes)

def finish_remove_tab(studio_obj, tab_id: str) -> None:
    _call_optional(getattr(studio_obj, "_preview_jobs", None), "cancel_tab", tab_id)
    studio_obj._python_jobs.cancel_tab(tab_id)
    studio_obj.reader_edits.clear(tab_id)
    current_index = next((i for i, tab in enumerate(studio_obj.tabs) if tab["id"] == tab_id), None)
    if current_index is None:
        return
    studio_obj.session.reader_assets.revoke_tab(studio_obj.window_id, tab_id)
    studio_obj.tabs.pop(current_index)
    if not studio_obj.tabs:
        studio_obj.tabs.append(_call_method(studio_obj, "_note", make_note, "Untitled.md"))
    if studio_obj._agent_jump_tab_id == tab_id:
        studio_obj._agent_jump_tab_id = ""
    studio_obj._last_reader_agent_seq.pop(tab_id, None)
    if studio_obj.active == tab_id:
        studio_obj._activation_generation += 1
        studio_obj.active = studio_obj.tabs[min(current_index, len(studio_obj.tabs) - 1)]["id"]
        _call_optional(studio_obj, "_activate_tab_state", _call_method(studio_obj, "_current", current_tab))
    _call_optional(studio_obj, "_recover")
    _call_optional(studio_obj, "_emit")

def request_window_close(studio_obj) -> bool:
    bg, host = getattr(studio_obj.session, "background", None), getattr(studio_obj, "host_window", None)
    if bg is not None and getattr(bg, "_stopping_from_cli", False) and host is not None and not host.isVisible():
        return True
    dirty = next((t for t in studio_obj.tabs if _call_method(studio_obj, "_is_dirty", is_dirty, t) and _has_note_substance(t)), None)
    if not dirty:
        return True
    studio_obj.pending_close = "window"
    _call_method(studio_obj, "selectTab", select_tab, dirty["id"])
    studio_obj.closeRequested.emit(dirty["name"])
    return False

def resolve_close(studio_obj, choice: str, *, snapshot_tab_fn=snapshot_tab_state, same_closed_revision_fn=same_closed_revision) -> None:
    if choice == "cancel":
        was_window, studio_obj.pending_close = studio_obj.pending_close == "window", ""
        if was_window:
            _call_optional(getattr(studio_obj.session, "background", None), "cancel_quit")
    elif choice == "save":
        studio_obj.save()
    elif choice == "discard":
        if studio_obj.pending_close != "window":
            action, studio_obj.pending_close = studio_obj.pending_close, ""
            if action:
                _call_method(studio_obj, "_remove_tab", lambda s, tid: remove_tab(s, tid, snapshot_tab_fn=snapshot_tab_fn, same_closed_revision_fn=same_closed_revision_fn), action)
            return
        current = _call_method(studio_obj, "_current", current_tab)
        if _has_note_substance(current):
            try:
                _record_closed_reference(studio_obj, studio_obj.session.closed_note_store.save(snapshot_tab_fn(current)))
            except Exception as failure:
                studio_obj.message = "Could not preserve the closed note: " + str(failure)
        current["saved"] = current["content"]
        current["saved_assets"] = dict(current.get("assets", {}))
        current["assets_dirty"] = False
        _call_method(studio_obj, "_finish_close", finish_close)

def finish_close(studio_obj) -> None:
    action, studio_obj.pending_close = studio_obj.pending_close, ""
    if action == "window":
        if _call_method(studio_obj, "requestWindowClose", request_window_close):
            _call_optional(studio_obj, "_recover")
            studio_obj.allowClose.emit()
    elif action:
        _call_method(studio_obj, "closeTab", close_tab, action)
