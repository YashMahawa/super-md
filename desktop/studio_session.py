"""Session state/persistence and Studio background executor, startup snapshot, and recovery helpers."""
from __future__ import annotations

import copy, json, re, sys, uuid
from collections import deque
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

def asset_identity(value):
    return id(value)

def noop_done(*_):
    pass

def init_session(session, isolated=False, data=None) -> None:
    mod = _studio_module()
    if data is not None:
        raw_data = Path(data)
    elif isolated:
        raw_data = Path(mod.tempfile.mkdtemp(prefix="supermd-test-"))
    else:
        raw_data = Path(mod.QStandardPaths.writableLocation(mod.QStandardPaths.StandardLocation.AppDataLocation)) / "qt-studio"
    session.data = raw_data.resolve()
    session.data.mkdir(parents=True, exist_ok=True)
    session.font_store = mod.FontStore(session.data)
    session.python_outputs = mod.PythonOutputs(session.data / "derived-python")
    session.reader_assets = mod.ReaderAssetStore(session.reader_asset_is_current, session.reader_asset_payload)
    session.closed_note_store = mod.ClosedNoteStore(session.data / "closed-notes")
    try:
        session.closed_tabs = session.closed_note_store.load_index_strict()
        session.closed_note_error = ""
    except (OSError, ValueError, TypeError) as error:
        session.closed_tabs, session.closed_note_error = [], str(error)
    session.writes = mod.LatestWriteExecutor(max_workers=1, thread_name_prefix="supermd-save")
    session.settings = copy.deepcopy(mod.DEFAULTS)
    session.recent, session.pinned = [], []
    session.workspace, session.window_workspaces = {}, {}
    session.startup_paths, session.startup_entries = [], []
    session.startup_expanded, session.startup_windows, session._pending_startup_windows = [], [], []
    session.startup_active = session.startup_active_id = session.startup_folder = ""
    session.quitting = session.update_installed = False
    session.locations, session.drafts, session.windows = {}, {}, {}
    session._agent_stage_queue = deque()
    session._agent_staging_active = False
    session.custom_theme = None
    session.theme_epoch = session.theme_revision = 0
    session.theme_source = session.active_theme_id = ""
    session.active_theme_kind = "builtin"
    session.saved_themes = []
    session.theme_restored = False
    session._load_theme_library()
    session.initial_recovery = []
    settings_path = session.data / "settings.json"
    stored_settings = None
    can_persist_migration = not settings_path.exists()
    try:
        stored = json.loads(settings_path.read_text(encoding="utf-8"))
        if isinstance(stored, dict) and isinstance(stored.get("settings"), dict):
            stored_settings = stored["settings"]
            can_persist_migration = True
        session.settings.update({k: v for k, v in stored["settings"].items() if k in mod.DEFAULTS})
        if not stored["settings"].get("widthMigrated") and stored["settings"].get("widthPercent") == 80:
            session.settings["widthPercent"] = 90  # 80% was the old default, not a choice.
        session.settings["pdf"] = {**mod.DEFAULT_PDF, **session.settings.get("pdf", {})}
        session.pinned = list(dict.fromkeys(p for p in stored.get("pinned", []) if isinstance(p, str)))[:10]
        session.recent = list(dict.fromkeys(session.pinned + [p for p in stored.get("recent", []) if isinstance(p, str)]))[:10]
    except (OSError, ValueError, KeyError, TypeError, AttributeError):
        pass
    had_explicit_keep_in_background = isinstance(stored_settings, dict) and "keepInBackground" in stored_settings
    fresh_service_log = mod.os.environ.get("SUPERMD_FRESH_SERVICE_LOG") == "1"
    migrated_keep_in_background = not had_explicit_keep_in_background and (
        (isinstance(stored_settings, dict) and any(
            stored_settings.get(key) is True
            for key in ("agentAccessEnabled", "cloudAgentEnabled", "background", "backgroundEnabled")
        ))
        or (session.data / "agent-sessions").is_dir()
        or (session.data / "agent-cloud.json").is_file()
        or (not fresh_service_log and (
            (session.data / "background-service.log").is_file()
            or (session.data.name == "qt-studio" and (session.data.parent / "background-service.log").is_file())
        ))
    )
    # Local MCP access and cloud relay reconnection are explicit, persisted
    # opt-ins; each desktop launch mints a fresh temporary loopback token.
    session.settings["agentAccessEnabled"] = session.settings.get("agentAccessEnabled") is True
    session.settings["cloudAgentEnabled"] = session.settings.get("cloudAgentEnabled") is True
    session.settings["keepInBackground"] = (
        stored_settings.get("keepInBackground") is True if had_explicit_keep_in_background else bool(migrated_keep_in_background)
    )
    shortcuts, _ = mod.normalize_shortcuts(session.settings.get("shortcuts"))
    session.settings["shortcuts"] = shortcuts or mod.default_shortcuts()
    if (migrated_keep_in_background or (fresh_service_log and not had_explicit_keep_in_background)) and can_persist_migration:
        try:
            mod.atomic_write(
                settings_path,
                json.dumps({"settings": session.settings, "recent": session.recent, "pinned": session.pinned}, ensure_ascii=False).encode("utf-8"),
            )
        except OSError:
            pass
    try:
        workspace = json.loads((session.data / "startup.json").read_text(encoding="utf-8"))
        session.startup_paths = list(dict.fromkeys(p for p in workspace.get("paths", []) if isinstance(p, str)))[:100]
        session.startup_active = workspace.get("active", "") if isinstance(workspace.get("active"), str) else ""
        session.startup_entries = [entry for entry in workspace.get("tabs", []) if isinstance(entry, dict) and isinstance(entry.get("id"), str) and isinstance(entry.get("path"), str)][:100]
        session.startup_active_id = workspace.get("activeId", "") if isinstance(workspace.get("activeId"), str) else ""
        session.startup_folder = workspace.get("folder", "") if isinstance(workspace.get("folder"), str) else ""
        session.startup_expanded = [p for p in workspace.get("expanded", []) if isinstance(p, str)][:500] if isinstance(workspace.get("expanded"), list) else []
        raw_windows = workspace.get("windows", [])
        if isinstance(raw_windows, list):
            for item in raw_windows[:20]:
                if not isinstance(item, dict):
                    continue
                w_tabs = [entry for entry in item.get("tabs", []) if isinstance(entry, dict) and isinstance(entry.get("id"), str) and isinstance(entry.get("path"), str)][:100]
                w_paths = list(dict.fromkeys(entry["path"] for entry in w_tabs if entry["path"]))[:100]
                w_folder = item.get("folder", "") if isinstance(item.get("folder"), str) else ""
                w_expanded = [p for p in item.get("expanded", []) if isinstance(p, str)][:500] if isinstance(item.get("expanded"), list) else []
                session.startup_windows.append({
                    "tabs": w_tabs, "paths": w_paths,
                    "active": item.get("active", "") if isinstance(item.get("active"), str) else "",
                    "activeId": item.get("activeId", "") if isinstance(item.get("activeId"), str) else "",
                    "folder": w_folder, "expanded": w_expanded,
                })
        session._pending_startup_windows = list(session.startup_windows)
    except (OSError, ValueError, TypeError, AttributeError):
        pass
    try:
        locations = json.loads((session.data / "reading-positions.json").read_text(encoding="utf-8"))
        if isinstance(locations, dict):
            session.locations = dict(list(locations.items())[-200:])
    except (OSError, ValueError, TypeError):
        pass
    try:
        recovered = json.loads((session.data / "recovery.json").read_text(encoding="utf-8"))
        for tab in recovered:
            if not isinstance(tab, dict) or any(not isinstance(tab.get(key), str) for key in ("name", "content", "path", "saved")):
                raise ValueError("Invalid draft recovery")
            mod.bundle(tab["content"], tab.get("assets", {}))
            session.initial_recovery.append(tab)
    except (OSError, ValueError, TypeError):
        pass
    # A crash can land after an active-tab recovery write but before the
    # small closed-tab index is refreshed. Prefer the active recovery entry.
    active_ids = {entry.get("id") for entry in session.startup_entries if isinstance(entry, dict)}
    for win_spec in session.startup_windows:
        active_ids.update(entry.get("id") for entry in win_spec.get("tabs", []) if isinstance(entry, dict))
    active_ids.update(tab.get("id") for tab in session.initial_recovery)
    kept = [ref for ref in session.closed_tabs if ref.get("id") not in active_ids]
    if kept != session.closed_tabs:
        session.closed_tabs = kept
        try:
            session.closed_note_store.save_index(kept)
        except OSError:
            pass
    session.workspace_links = mod.WorkspaceLinkCache()

def session_is_quitting(session) -> bool:
    background = getattr(session, "background", None)
    return bool(session.quitting or (background is not None and getattr(background, "quitting", False)))

def has_pending_startup_windows(session) -> bool:
    return bool(session.settings.get("startup", "restore") == "restore" and session._pending_startup_windows)

def load_theme_library(session) -> None:
    mod = _studio_module()
    library_path = session.data / "theme-library.json"
    themes_dir = session.data / "themes"
    if library_path.is_file():
        try:
            raw = json.loads(library_path.read_text(encoding="utf-8"))
            saved = []
            for item in raw.get("saved", []):
                if not isinstance(item, dict):
                    continue
                entry_id, name, source = item.get("id", ""), item.get("name", ""), item.get("source", "")
                if (
                    isinstance(entry_id, str) and re.fullmatch(r"[0-9a-f]{8,64}", entry_id)
                    and isinstance(name, str) and name.strip()
                    and isinstance(source, str) and (themes_dir / f"{entry_id}.json").is_file()
                ):
                    saved.append({"id": entry_id, "name": name, "source": source})
            session.saved_themes = saved
            active = raw.get("active", {}) if isinstance(raw.get("active"), dict) else {}
            kind = active.get("kind", "builtin")
            active_id = active.get("id", "") if isinstance(active.get("id"), str) else ""
            if kind == "saved":
                matched = next((item for item in saved if item["id"] == active_id), None)
                if matched is not None:
                    session.active_theme_kind, session.active_theme_id, session.theme_source = "saved", matched["id"], matched["source"]
            elif kind == "preset" and active_id:
                session.active_theme_kind, session.active_theme_id, session.theme_source = "preset", active_id, ""
        except (OSError, ValueError, TypeError, AttributeError):
            pass
        return
    legacy_source = ""
    try:
        legacy_source = json.loads((session.data / "theme-source.json").read_text(encoding="utf-8")).get("path", "")
        if not isinstance(legacy_source, str):
            legacy_source = ""
    except (OSError, ValueError, AttributeError):
        legacy_source = ""
    legacy_theme = session.data / "theme.json"
    if legacy_theme.is_file():
        try:
            parsed = json.loads(legacy_theme.read_text(encoding="utf-8"))
            name = parsed.get("name") if isinstance(parsed, dict) and isinstance(parsed.get("name"), str) and parsed.get("name").strip() else "Imported theme"
            entry_id = uuid.uuid4().hex
            themes_dir.mkdir(parents=True, exist_ok=True)
            mod.atomic_json(themes_dir / f"{entry_id}.json", parsed)
            session.saved_themes = [{"id": entry_id, "name": name, "source": legacy_source}]
            session.active_theme_kind, session.active_theme_id, session.theme_source = "saved", entry_id, legacy_source
            mod.atomic_json(library_path, {"active": {"kind": "saved", "id": entry_id}, "saved": session.saved_themes})
        except (OSError, ValueError, TypeError):
            session.theme_source = legacy_source
    else:
        session.theme_source = legacy_source

def reader_asset_is_current(session, grant):
    return session.reader_asset_source_is_current(grant.owner_id, grant.tab_id, grant.source, grant.embedded_identity, grant.path)

def reader_asset_source_is_current(session, owner_id, tab_id, source, embedded_identity, path):
    studio = session.windows.get(owner_id)
    if not studio or studio.retired:
        return False
    tab = next((item for item in studio.tabs if item["id"] == tab_id), None)
    if tab is None:
        return False
    if source in tab.get("assets", {}):
        # Asset strings are immutable; identity keeps request validation
        # cheap for large embedded images and replacement revokes access.
        return id(tab["assets"][source]) == embedded_identity
    try:
        return str(_studio_module().note_file_path(tab, source)) == path
    except (OSError, ValueError):
        return False

def reader_asset_payload(session, grant):
    studio = session.windows.get(grant.owner_id)
    if not studio or studio.retired:
        return None
    tab = next((item for item in studio.tabs if item["id"] == grant.tab_id), None)
    if tab is None:
        return None
    payload = tab.get("assets", {}).get(grant.source)
    return payload if isinstance(payload, str) and id(payload) == grant.embedded_identity else None

def enqueue_agent_stage(session, runner) -> None:
    session._agent_stage_queue.append(runner)
    if not session._agent_staging_active:
        session._advance_agent_stage_queue()

def advance_agent_stage_queue(session) -> None:
    while session._agent_stage_queue:
        runner = session._agent_stage_queue.popleft()
        session._agent_staging_active = True
        if runner():
            return
    session._agent_staging_active = False

def submit(studio_obj, action, done, busy=True, executor=None) -> None:
    if studio_obj.retired:
        return
    target = executor or studio_obj.pool
    if getattr(target, "_shutdown", False):
        return
    if busy:
        studio_obj.busy += 1
        studio_obj._emit(False)
    future = target.submit(action)
    def completed(f):
        if studio_obj.retired or f.cancelled():
            return
        try:
            value, error = f.result(), None
        except Exception as reason:
            value, error = None, str(reason)
        is_noop = done is noop_done or done is getattr(_studio_module(), "_noop_done", None)
        if studio_obj.retired or (is_noop and not busy and error is None):
            return
        try:
            studio_obj.completed.emit((done, value, error, busy))
        except RuntimeError:
            pass  # The QObject may have been retired meanwhile.
    future.add_done_callback(completed)

def complete(studio_obj, result) -> None:
    if studio_obj.retired:
        return
    done, value, error, busy = result
    if busy:
        studio_obj.busy -= 1
    if error:
        studio_obj.message = error
        studio_obj.pending_close = ""
    done(value, error)
    studio_obj._emit(False)

def _prepare_write_retirement_guard(studio_obj, on_retired):
    token = uuid.uuid4().hex
    invoked = False
    def notify_retired():
        nonlocal invoked
        with studio_obj._write_callback_lock:
            if invoked:
                return
            invoked = True
            studio_obj._pending_write_retirements.pop(token, None)
        if on_retired is not None:
            on_retired()
    if studio_obj.retired or getattr(studio_obj.writes, "_shutdown", False):
        notify_retired()
        return None
    if on_retired is not None:
        with studio_obj._write_callback_lock:
            studio_obj._pending_write_retirements[token] = notify_retired
    return token, notify_retired

def _emit_background_write(studio_obj, token: str, done, notify_retired, value, error) -> None:
    if studio_obj.retired:
        notify_retired()
        return
    try:
        studio_obj.backgroundWriteCompleted.emit((token, done, notify_retired, value, error))
    except RuntimeError:
        notify_retired()

def submit_write(studio_obj, action, done, *, on_retired=None) -> bool:
    guard = _prepare_write_retirement_guard(studio_obj, on_retired)
    if guard is None:
        return False
    token, notify_retired = guard
    try:
        future = studio_obj.writes.submit(action)
    except RuntimeError:
        notify_retired()
        return False
    def completed(f):
        if f.cancelled():
            notify_retired()
            return
        try:
            value, error = f.result(), None
        except Exception as reason:
            value, error = None, str(reason)
        _emit_background_write(studio_obj, token, done, notify_retired, value, error)
    future.add_done_callback(completed)
    return True

def complete_background_write(studio_obj, payload) -> None:
    token, done, notify_retired, value, error = payload
    if studio_obj.retired:
        notify_retired()
        return
    with studio_obj._write_callback_lock:
        studio_obj._pending_write_retirements.pop(token, None)
    done(value, error)

def submit_exact_recovery_write(studio_obj, action, done, *, on_retired=None, on_enqueued=None) -> bool:
    guard = _prepare_write_retirement_guard(studio_obj, on_retired)
    if guard is None:
        return False
    token, notify_retired = guard
    def exact_completed(status, rev, error):
        _emit_background_write(studio_obj, token, done, notify_retired, (status, rev, error), None)
    try:
        studio_obj.writes.submit_latest_exact("recovery", action, None, exact_completed, on_enqueued=on_enqueued)
    except RuntimeError:
        notify_retired()
        return False
    return True

def preferences(studio_obj, notify=True) -> None:
    if studio_obj.retired or getattr(studio_obj.writes, "_shutdown", False):
        return
    mod = _studio_module()
    persisted_settings = dict(studio_obj.settings)
    if getattr(getattr(studio_obj.session, "background", None), "_cli_started_agent_access", False):
        persisted_settings["agentAccessEnabled"] = False
    data = json.dumps({"settings": persisted_settings, "recent": studio_obj.recent, "pinned": studio_obj.session.pinned}).encode()
    studio_obj._submit(lambda: _studio_module().atomic_write(studio_obj.data / "settings.json", data), mod._noop_done, False, studio_obj.writes)
    if notify:
        studio_obj.session.changed.emit()

def save_positions(studio_obj) -> None:
    mod = _studio_module()
    data = json.dumps(studio_obj.session.locations).encode()
    studio_obj._submit(lambda: _studio_module().atomic_write(studio_obj.data / "reading-positions.json", data), mod._noop_done, False, studio_obj.writes)

def submit_startup_snapshot(studio_obj) -> None:
    # Clean tabs need only paths, never another copy of their image bytes.
    window_tabs = [{"path": t["path"], "id": t["id"]} for t in studio_obj.tabs if t["path"] or studio_obj._is_dirty(t) or t.get("agent_staged") or t.get("agent_unreviewed")]
    studio_obj.session.workspace[studio_obj.window_id] = window_tabs
    studio_obj.session.window_workspaces[studio_obj.window_id] = {
        "folder": studio_obj.folder, "expanded": sorted(studio_obj.expanded) if studio_obj.folder else [],
        "active": studio_obj._current()["path"], "activeId": studio_obj.active,
    }
    entries = [entry for tabs in studio_obj.session.workspace.values() for entry in tabs]
    windows_payload = []
    for wid, w_tabs in studio_obj.session.workspace.items():
        meta = studio_obj.session.window_workspaces.get(wid, {})
        w_folder = meta.get("folder", "")
        windows_payload.append({
            "windowId": wid, "tabs": w_tabs,
            "active": meta.get("active", ""), "activeId": meta.get("activeId", ""),
            "folder": w_folder, "expanded": meta.get("expanded", []) if w_folder else [],
        })
    primary_folder = windows_payload[0]["folder"] if windows_payload else studio_obj.folder
    primary_expanded = windows_payload[0]["expanded"] if windows_payload else (sorted(studio_obj.expanded) if studio_obj.folder else [])
    workspace = {
        "paths": list(dict.fromkeys(t["path"] for t in entries if t["path"])),
        "tabs": entries, "active": studio_obj._current()["path"], "activeId": studio_obj.active,
        "folder": primary_folder, "expanded": primary_expanded, "windows": windows_payload,
    }
    studio_obj.session.writes.submit_latest(
        "startup",
        lambda: _studio_module().atomic_json(studio_obj.data / "startup.json", workspace),
        lambda error: studio_obj._notify_recovery_write("startup", error),
    )

def window_recovery_drafts(studio_obj, tabs=None):
    mod = _studio_module()
    source_tabs = studio_obj.tabs if tabs is None else tabs
    return [
        mod._snapshot_tab_state(t, include_view_state=False)
        for t in source_tabs
        if (studio_obj._is_dirty(t) or t.get("agent_staged") or t.get("agent_unreviewed"))
        and (t["path"] or t["content"].strip() or t["assets"] or t.get("agent_staged") or t.get("agent_unreviewed"))
    ]

def combined_recovery_drafts(studio_obj, window_drafts):
    combined, replaced = [], False
    for wid, tabs in studio_obj.session.drafts.items():
        if wid == studio_obj.window_id:
            combined.extend(window_drafts)
            replaced = True
        else:
            combined.extend(tabs)
    if not replaced:
        combined.extend(window_drafts)
    return combined

def recover(studio_obj) -> None:
    studio_obj._submit_startup_snapshot()
    # Snapshot only unsaved or agent-staged tabs. Asset bytes stay in recovery, never in displayed source.
    window_drafts = studio_obj._window_recovery_drafts()
    studio_obj.session.drafts[studio_obj.window_id] = window_drafts
    drafts = studio_obj._combined_recovery_drafts(window_drafts)
    studio_obj.session.writes.submit_latest(
        "recovery",
        lambda: _studio_module().atomic_json(studio_obj.data / "recovery.json", drafts),
        lambda error: studio_obj._notify_recovery_write("recovery", error),
    )

def notify_recovery_write(studio_obj, category, error) -> None:
    try:
        studio_obj.completed.emit((studio_obj._recovery_write_completed, (category, error), None, False))
    except RuntimeError:
        pass

def recovery_write_completed(studio_obj, result, _error) -> None:
    category, error = result
    notice = {
        "startup": "Couldn't save the current workspace state. Keep Super MD open and retry.",
        "recovery": "Couldn't save draft recovery data. Keep Super MD open and retry.",
    }[category]
    if error:
        studio_obj.message = notice
    elif studio_obj.message == notice:
        studio_obj.message = ""
    studio_obj._emit(False)
