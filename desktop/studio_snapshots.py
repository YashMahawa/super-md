"""Window initialization/teardown, state emission, and memoized snapshot slice helpers for Studio."""
from __future__ import annotations
import concurrent.futures, contextlib, json, shutil, sys, threading, uuid, weakref
from pathlib import Path
from typing import Any
from PySide6.QtCore import QFileSystemWatcher, QProcess, QTimer
from PySide6.QtGui import QGuiApplication

if __package__:
    from . import custom_theme, folder_ops, offline_view, python_runtime
    from .core.paths import DESKTOP_DIR
    from .export_jobs import ExportJobRegistry
    from .reader_edits import ReaderEdits
    from .theme import read_system_palette
else:
    import custom_theme, folder_ops, offline_view, python_runtime
    from core.paths import DESKTOP_DIR
    from export_jobs import ExportJobRegistry
    from reader_edits import ReaderEdits
    from theme import read_system_palette

EMPTY_OUTLINE = ()
_DEFAULT_STOPPED_WATCHER = object()
_READING_SETTING_KEYS = (
    "restorePosition", "centerLock", "imageAppearance", "svgAppearance",
    "imageContrast", "fullDocumentAccessibility", "latexAutofix", "typewriterScroll",
)
_STOP_TIMERS = (
    "theme_timer", "theme_debounce", "custom_theme_timer", "recovery_timer",
    "autosave_timer", "flush_timer", "external_timer", "filter_timer",
)
_WATCHER_ATTRS = ("note_watcher", "palette_watcher", "custom_theme_watcher")

def _call_optional(obj, attr: str, *args):
    fn = getattr(obj, attr, None)
    return fn(*args) if callable(fn) else None

def _call_method(studio_obj, attr: str, fallback_fn, *args):
    fn = getattr(studio_obj, attr, None)
    return fn(*args) if callable(fn) else fallback_fn(studio_obj, *args)

def _single_shot_timer(timer_cls, studio_obj, slot, interval: int | None = None):
    timer = timer_cls(studio_obj)
    timer.setSingleShot(True)
    if interval is not None:
        timer.setInterval(interval)
    timer.timeout.connect(slot)
    return timer

def _current_tab(studio_obj) -> dict:
    tabs = getattr(studio_obj, "tabs", None) or []
    if not tabs:
        return {"id": "", "name": "Super MD", "content": "", "path": "", "saved": "", "assets": {}, "saved_assets": {}, "assets_dirty": False, "portable": False, "conflict": False, "outline": []}
    active = getattr(studio_obj, "active", "")
    return next((t for t in tabs if t["id"] == active), tabs[0])

def _tab_is_dirty(_studio_obj, tab: dict) -> bool:
    if tab.get("content") != tab.get("saved") or tab.get("assets_dirty"):
        return True
    return bool(tab.get("path") and "saved_assets" in tab and tab.get("assets", {}) != tab.get("saved_assets", {}))

def _cached_slice(studio_obj, cache_attr: str, key: Any, encode) -> str:
    cached = getattr(studio_obj, cache_attr, None)
    if key is not None and cached is not None and cached[0] == key:
        return cached[1]
    encoded = encode()
    setattr(studio_obj, cache_attr, (key, encoded))
    return encoded

def init_studio_window(
    studio_obj, isolated: bool = False, session=None, *, root: Path = DESKTOP_DIR.parent,
    session_cls=None, sample: str = "", timer_cls=QTimer, watcher_cls=QFileSystemWatcher,
    export_jobs_cls=ExportJobRegistry, reader_edits_cls=ReaderEdits, python_runtime_mod=python_runtime,
    offline_view_mod=offline_view, folder_ops_mod=folder_ops,
    read_system_palette_fn=read_system_palette, gui_app_cls=QGuiApplication, process_cls=QProcess,
    sys_platform: str | None = None, which_fn=shutil.which,
) -> None:
    studio_obj.setObjectName("studio")
    studio_obj._brand_svg = (Path(root) / "public/brand-mark-fixed.svg").read_text(encoding="utf-8")
    studio_obj.pool = concurrent.futures.ThreadPoolExecutor(max_workers=3, thread_name_prefix="supermd")
    studio_obj._search_pool = concurrent.futures.ThreadPoolExecutor(max_workers=2, thread_name_prefix="supermd-search")
    studio_obj._python_pool: concurrent.futures.ThreadPoolExecutor | None = None
    studio_obj.workspaceSearchBatch.connect(studio_obj._on_workspace_search_batch)
    if session is None:
        if session_cls is None:
            raise TypeError("init_studio_window requires session or session_cls")
        session = session_cls(isolated)
    studio_obj.session = session
    weak_self = weakref.ref(studio_obj)

    def _on_session_changed():
        inst = weak_self()
        if inst is not None and not inst.retired:
            inst._emit()

    def _on_location_changed(old, new):
        inst = weak_self()
        if inst is not None and not inst.retired:
            inst._location_changed(old, new)

    studio_obj._session_changed_slot = _on_session_changed
    studio_obj._location_changed_slot = _on_location_changed
    studio_obj.session.changed.connect(studio_obj._session_changed_slot)
    studio_obj.session.locationChanged.connect(studio_obj._location_changed_slot)
    studio_obj.writes = studio_obj.session.writes
    studio_obj.window_id = uuid.uuid4().hex
    studio_obj.session.windows[studio_obj.window_id] = studio_obj
    studio_obj.host_window = None
    studio_obj._retired = False
    studio_obj._write_callback_lock = threading.Lock()
    studio_obj._pending_write_retirements: dict[str, Any] = {}
    studio_obj.completed.connect(studio_obj._complete)
    studio_obj.backgroundWriteCompleted.connect(studio_obj._complete_background_write)
    studio_obj.data = studio_obj.session.data
    studio_obj.settings = studio_obj.session.settings
    studio_obj._defer_reader_activation = False
    studio_obj._agent_error = ""
    studio_obj._agent_cloud_error = ""
    studio_obj._agent_cloud_config_path = studio_obj.data / "agent-cloud.json"
    studio_obj._cloud_started_local_bridge = False
    studio_obj._cloud_revocation_pending = False
    studio_obj.cloudRevocationFinished.connect(studio_obj._finish_cloud_revocation)
    studio_obj._agent_viewport_capture = None
    studio_obj._preview_jobs = offline_view_mod.PreviewJobRegistry()
    agent_bridge = getattr(studio_obj.session, "agent_bridge", None)
    if agent_bridge is not None:
        agent_bridge.enabledChanged.connect(lambda: studio_obj._emit(False))
        agent_bridge.cloudStatusChanged.connect(studio_obj._cloud_status_changed)
    studio_obj.update_status, studio_obj.update_info, studio_obj.update_path, studio_obj.update_running = "", None, "", False
    studio_obj._storage_report = json.dumps({"status": "idle", "cancelled": False, "truncated": False, "scannedEntries": 0, "categories": []})
    studio_obj.storage_busy, studio_obj.storage_cleanup_busy, studio_obj.storage_cleanup_status, studio_obj._storage_cancel_event = False, False, "", None
    studio_obj.python_status, studio_obj.python_choices, studio_obj.python_busy = "", [], False
    studio_obj.pythonProgress.connect(studio_obj._python_progress)
    if not studio_obj.settings.get("python"):
        studio_obj._choose_default_python(emit=False)
    if not isolated and len(studio_obj.session.windows) == 1:
        timer_cls.singleShot(0, studio_obj._restore_update)
    studio_obj.tabs: list[dict] = []
    studio_obj.closed_tabs = studio_obj.session.closed_tabs
    studio_obj._closing_tabs, studio_obj._staging_tabs = set(), set()
    studio_obj._max_agent_stage_attempts = 3
    studio_obj.note_watcher = watcher_cls(studio_obj)
    studio_obj.note_watcher.fileChanged.connect(studio_obj._external_note_changed)
    studio_obj.note_watcher.directoryChanged.connect(studio_obj._external_note_changed)
    studio_obj.external_paths, studio_obj.note_watch_paths, studio_obj.note_file_stamps, studio_obj.note_identities = set(), None, {}, {}
    studio_obj._watch_suspensions = studio_obj.session._watch_suspensions
    with studio_obj.session._rename_state_lock:
        studio_obj.session._retired_persist_needed = False
    studio_obj.external_timer = _single_shot_timer(timer_cls, studio_obj, studio_obj._refresh_external_notes)
    studio_obj.active, studio_obj.folder = "", ""
    studio_obj._files: list[dict] = []
    studio_obj._files_revision, studio_obj._outline_revision = 0, 0
    studio_obj.expanded: set[str] = set()
    studio_obj._pinned_visible_dirs: set[str] = set()
    studio_obj.folder_filter, studio_obj._folder_searching = "", False
    studio_obj._search_generation, studio_obj._search_cancel = 0, None
    studio_obj.filter_timer = _single_shot_timer(timer_cls, studio_obj, studio_obj._start_subfolder_search)
    studio_obj._folder_search_open, studio_obj._folder_search_query = False, ""
    studio_obj._folder_search_case_sensitive, studio_obj._folder_search_include_diagrams = False, False
    studio_obj._folder_search_matches: list[dict] = []
    studio_obj._folder_search_scanning, studio_obj._folder_search_scanned_files, studio_obj._folder_search_truncated = False, 0, False
    studio_obj._folder_search_generation, studio_obj._folder_search_cancel, studio_obj._folder_search_tabs_sig = 0, None, None
    studio_obj._pending_seeded_find: dict | None = None
    studio_obj.mode = studio_obj.settings.get("readingMode", "live")
    studio_obj.fullscreen, studio_obj.reader_overlay, studio_obj.image_overlay, studio_obj.busy = False, False, False, 0
    studio_obj._message, studio_obj._message_revision = "", 0
    closed_err = studio_obj.session.closed_note_error
    studio_obj.message = f"Closed-note recovery index could not be read; historical snapshots were left untouched. {closed_err}" if closed_err else ""
    studio_obj.ready, studio_obj._last_reader_text = False, None
    studio_obj._last_reader_agent_seq: dict[str, int] = {}
    studio_obj._agent_edit_seq, studio_obj._agent_jump_tab_id = 0, ""
    studio_obj._export_jobs = export_jobs_cls()
    studio_obj._python_jobs = python_runtime_mod.PythonJobRegistry()
    studio_obj._agent_exports: dict[str, dict] = {}
    studio_obj._agent_owned_files: set[str] = getattr(studio_obj.session, "agent_owned_files", None) or set()
    studio_obj.session.agent_owned_files = studio_obj._agent_owned_files
    studio_obj._agent_open_paths: set[str] = getattr(studio_obj.session, "agent_open_paths", None) or set()
    studio_obj.session.agent_open_paths = studio_obj._agent_open_paths
    studio_obj._agent_job_records = {}
    studio_obj.reader_edits = reader_edits_cls()
    studio_obj.system_dark = None
    studio_obj.system_mode, studio_obj.system_colors = read_system_palette_fn()
    studio_obj._theme_result, studio_obj._theme_running, studio_obj._theme_pending = None, False, False
    studio_obj.theme_debounce = _single_shot_timer(timer_cls, studio_obj, studio_obj._refresh_theme)

    def _on_color_scheme_changed(*args):
        inst = weak_self()
        if inst is not None and not inst.retired:
            inst._schedule_theme(*args)

    studio_obj._color_scheme_slot = _on_color_scheme_changed
    gui_app_cls.styleHints().colorSchemeChanged.connect(studio_obj._color_scheme_slot)
    studio_obj.palette_watcher = watcher_cls(studio_obj)
    studio_obj.palette_watcher.fileChanged.connect(studio_obj._palette_changed)
    studio_obj.palette_watcher.directoryChanged.connect(studio_obj._palette_changed)
    studio_obj._watch_palette()
    studio_obj.custom_theme_watcher = watcher_cls(studio_obj)
    studio_obj.custom_theme_timer = _single_shot_timer(timer_cls, studio_obj, studio_obj._custom_theme_event, 250)
    studio_obj.custom_theme_stamp = None
    studio_obj.custom_theme_watcher.fileChanged.connect(lambda *_: studio_obj.custom_theme_timer.start())
    studio_obj.custom_theme_watcher.directoryChanged.connect(lambda *_: studio_obj.custom_theme_timer.start())
    timer_cls.singleShot(0, studio_obj._restore_custom_theme)
    studio_obj.system_preferences = process_cls(studio_obj)
    platform_name = sys.platform if sys_platform is None else sys_platform
    if platform_name.startswith("linux") and which_fn("gsettings"):
        studio_obj.system_preferences.readyReadStandardOutput.connect(studio_obj._system_setting_changed)
        studio_obj.system_preferences.start("gsettings", ["monitor", "org.gnome.desktop.interface"])
    studio_obj.theme_timer = timer_cls(studio_obj)
    studio_obj.theme_timer.setInterval(60000)
    studio_obj.theme_timer.timeout.connect(studio_obj._refresh_theme)
    studio_obj.theme_timer.start()
    studio_obj.pending_close, studio_obj.pending_export, studio_obj.pending_save_as, studio_obj.pending_save_as_tab = "", "", "", ""
    studio_obj._force_overwrite_ids: set[str] = set()
    studio_obj.flush_operation = None
    studio_obj.flush_timer = _single_shot_timer(timer_cls, studio_obj, studio_obj._on_flush_timeout)
    studio_obj.recovery_timer = _single_shot_timer(timer_cls, studio_obj, studio_obj._recover)
    studio_obj.autosave_timer = _single_shot_timer(timer_cls, studio_obj, studio_obj._autosave)
    studio_obj.preference_timer = _single_shot_timer(timer_cls, studio_obj, studio_obj._preferences)
    studio_obj.position_timer = _single_shot_timer(timer_cls, studio_obj, studio_obj._save_positions)
    studio_obj.saving = set()
    restore_enabled = studio_obj.settings.get("startup", "restore") == "restore"
    if not restore_enabled:
        studio_obj.session._pending_startup_windows.clear()
        studio_obj.session.startup_folder = ""
        studio_obj.session.startup_expanded, studio_obj.session.startup_paths, studio_obj.session.startup_entries = [], [], []
    win_spec = studio_obj.session._pending_startup_windows.pop(0) if restore_enabled and studio_obj.session._pending_startup_windows else None
    if win_spec is not None and studio_obj.session._pending_startup_windows:
        spec_ids = {entry["id"] for entry in win_spec["tabs"]}
        claimed = [tab for tab in studio_obj.session.initial_recovery if tab.get("id") in spec_ids]
        studio_obj.session.initial_recovery = [tab for tab in studio_obj.session.initial_recovery if tab.get("id") not in spec_ids]
    else:
        claimed = list(studio_obj.session.initial_recovery)
        studio_obj.session.initial_recovery = []
    studio_obj.tabs = [{**tab, "id": tab.get("id") or uuid.uuid4().hex} for tab in claimed]
    for tab in studio_obj.tabs:
        tab.setdefault("saved_assets", dict(tab.get("assets", {})))
        tab.setdefault("assets_dirty", False)
        tab.setdefault("conflict", False)
        tab["agent_staged"] = bool(tab.get("agent_staged", False))
        tab["agent_unreviewed"] = bool(tab.get("agent_unreviewed", False))
        raw_edits = tab.get("agent_edits")
        valid_edits = []
        if isinstance(raw_edits, list):
            for entry in raw_edits[-60:]:
                if isinstance(entry, dict) and isinstance(entry.get("seq"), int) and isinstance(entry.get("before"), str) and isinstance(entry.get("after"), str):
                    valid_edits.append({"seq": entry["seq"], "before": entry["before"], "after": entry["after"]})
                    if entry["seq"] > studio_obj._agent_edit_seq:
                        studio_obj._agent_edit_seq = entry["seq"]
        tab["agent_edits"] = studio_obj._bound_agent_edits(valid_edits)
    studio_obj._agent_open_paths.update(str(Path(tab["path"]).resolve()) for tab in studio_obj.tabs if tab.get("path"))
    with studio_obj.session._rename_state_lock:
        studio_obj.session.drafts[studio_obj.window_id] = [dict(t) for t in studio_obj.tabs]
    studio_obj._startup_placeholder_ids, studio_obj._touched_tab_ids = set(), set()
    studio_obj._welcome_placeholder_id = None
    studio_obj._opening_paths: dict[str, int] = {}
    if not studio_obj.tabs:
        if studio_obj.settings["welcomed"]:
            placeholder = studio_obj._note("Untitled.md")
            studio_obj.tabs.append(placeholder)
            studio_obj._startup_placeholder_ids.add(placeholder["id"])
        else:
            placeholder = studio_obj._note("Welcome.md", sample, saved=sample)
            studio_obj.tabs.append(placeholder)
            studio_obj._welcome_placeholder_id = placeholder["id"]
    elif studio_obj.settings["startup"] == "new":
        placeholder = studio_obj._note("Untitled.md")
        studio_obj.tabs.insert(0, placeholder)
        studio_obj._startup_placeholder_ids.add(placeholder["id"])
    studio_obj.active = studio_obj.tabs[0]["id"]
    target_active_id = win_spec["activeId"] if win_spec is not None else studio_obj.session.startup_active_id
    if restore_enabled and any(t["id"] == target_active_id for t in studio_obj.tabs):
        studio_obj.active = target_active_id
    studio_obj._activation_generation = 0
    studio_obj._restoring_paths, studio_obj._startup_order = set(), []
    if win_spec is not None:
        studio_obj._startup_entries, studio_obj._startup_active = list(win_spec["tabs"]), win_spec["active"]
        restore_paths, restore_folder, restore_expanded = list(win_spec["paths"]), win_spec["folder"], list(win_spec["expanded"])
        if not studio_obj.session._pending_startup_windows:
            studio_obj.session.startup_paths, studio_obj.session.startup_entries = [], []
            studio_obj.session.startup_folder, studio_obj.session.startup_expanded = "", []
    else:
        studio_obj._startup_entries, studio_obj._startup_active = studio_obj.session.startup_entries, studio_obj.session.startup_active
        restore_paths = list(studio_obj.session.startup_paths)
        restore_folder, restore_expanded = studio_obj.session.startup_folder, list(studio_obj.session.startup_expanded)
        studio_obj.session.startup_entries, studio_obj.session.startup_paths = [], []
        studio_obj.session.startup_folder, studio_obj.session.startup_expanded = "", []
    pending_active_restore = bool(
        restore_enabled and studio_obj._startup_active
        and not any(t["id"] == target_active_id for t in studio_obj.tabs)
        and any(folder_ops_mod.same_path(p, studio_obj._startup_active) for p in restore_paths)
    )
    if not pending_active_restore:
        studio_obj._activate_tab_state(studio_obj._current())
    if restore_enabled and restore_paths:
        studio_obj._startup_order = restore_paths
        studio_obj._restoring_paths = set(studio_obj._startup_order)
        restore_generation = studio_obj._activation_generation
        timer_cls.singleShot(0, lambda: [studio_obj._open_note(p, explicit=False, activation_generation=restore_generation) for p in studio_obj._startup_order])
    if restore_enabled and restore_folder:
        studio_obj._restore_workspace_folder(restore_folder, restore_expanded)
    studio_obj._emitted_sidebar_key = studio_obj._sidebar_slice_key()
    studio_obj._emitted_tabs_key = studio_obj._tabs_slice_key()
    studio_obj._emitted_active_tab_id = studio_obj.active if studio_obj.tabs else ""
    studio_obj._refresh_theme()
    if not isolated and len(studio_obj.session.windows) == 1 and studio_obj.settings.get("cloudAgentEnabled"):
        timer_cls.singleShot(0, studio_obj._restore_cloud_connection)

def notify_sidebar(studio_obj) -> None:
    if getattr(studio_obj, "retired", False):
        return
    key = _call_method(studio_obj, "_sidebar_slice_key", sidebar_slice_key)
    if key != getattr(studio_obj, "_emitted_sidebar_key", None):
        studio_obj._emitted_sidebar_key = key
        studio_obj.sidebarChanged.emit()

def notify_tabs(studio_obj) -> None:
    if getattr(studio_obj, "retired", False):
        return
    tabs_key = _call_method(studio_obj, "_tabs_slice_key", tabs_slice_key)
    if tabs_key != getattr(studio_obj, "_emitted_tabs_key", None):
        studio_obj._emitted_tabs_key = tabs_key
        if (tabs_sig := getattr(studio_obj, "tabsChanged", None)) is not None:
            tabs_sig.emit()
    active_id = studio_obj.active if studio_obj.tabs else ""
    if active_id != getattr(studio_obj, "_emitted_active_tab_id", None):
        studio_obj._emitted_active_tab_id = active_id
        if (active_sig := getattr(studio_obj, "activeTabChanged", None)) is not None:
            active_sig.emit()

def emit_state(studio_obj, load: bool = True, *, custom_theme_mod=custom_theme) -> None:
    if getattr(studio_obj, "retired", False):
        return
    if (preview_jobs := getattr(studio_obj, "_preview_jobs", None)) is not None:
        preview_jobs.retain_tabs(tab["id"] for tab in studio_obj.tabs)
    _call_optional(studio_obj, "_watch_notes")
    _call_method(studio_obj, "_notify_sidebar", notify_sidebar)
    _call_method(studio_obj, "_notify_tabs", notify_tabs)
    studio_obj.changed.emit()
    if load and studio_obj.ready and studio_obj.tabs:
        tab = _call_method(studio_obj, "_current", _current_tab)
        dark = _call_method(studio_obj, "_dark", lambda s: s._tokens()[0])
        colors = _call_method(studio_obj, "_colors", lambda s: dict(s._tokens()[1]))
        s = studio_obj.settings
        reading_settings = {key: s[key] for key in _READING_SETTING_KEYS}
        reading_settings["customStyle"] = custom_theme_mod.reader(
            studio_obj.session.custom_theme, s["fullTheme" if studio_obj.fullscreen else "theme"], dark, s,
        )
        payload = {
            **reading_settings, "readingLocation": studio_obj.session.locations.get(tab["path"]),
            "id": tab["id"], "path": tab["path"] or tab["id"], "portable": bool(tab.get("portable", False)),
            "mode": studio_obj.mode, "dark": dark, "fullscreen": studio_obj.fullscreen, "font": s["font"], "size": s["size"],
            "widthPercent": s["widthPercent"], "lineHeight": s["lineHeight"],
            "spellCheck": s["spellCheck"], "grammarCheck": s["grammarCheck"],
            "zoom": s["fullZoom" if studio_obj.fullscreen else "normalZoom"],
            "motion": s["motion"], "python": s["python"], "colors": colors,
            "viewState": tab.pop("viewState", None),
        }
        pending_heading = tab.pop("pendingHeading", None)
        if pending_heading:
            payload["pendingHeading"] = pending_heading
        seeded_find = _call_optional(studio_obj, "_consume_seeded_find", tab)
        if seeded_find is not None:
            payload["seededFind"] = seeded_find
        payload["editProtocol"] = 1
        if tab.get("agent_unreviewed"):
            payload["agentUnreviewed"] = True
        edits = tab.get("agent_edits") or []
        last_sent = studio_obj._last_reader_agent_seq.get(tab["id"], 0)
        unseen_edits = [item for item in edits if isinstance(item, dict) and item.get("seq", 0) > last_sent]
        if unseen_edits:
            payload["pendingAgentEdits"] = unseen_edits
            studio_obj._last_reader_agent_seq[tab["id"]] = unseen_edits[-1]["seq"]
        previous = studio_obj._last_reader_text
        if previous and previous[0] == tab["id"] and previous[1] is tab["content"]:
            payload["contentUnchanged"] = True
        else:
            payload["content"] = tab["content"]
        studio_obj._last_reader_text = (tab["id"], tab["content"])
        studio_obj.readerLoad.emit(json.dumps(payload))

def stop_window(
    studio_obj, *, stopped_watcher=None, shiboken_mod=None,
    gui_app_cls=QGuiApplication, process_cls=QProcess,
) -> None:
    if getattr(studio_obj, "retired", False):
        return
    if getattr(studio_obj, "_storage_cancel_event", None) is not None:
        studio_obj._storage_cancel_event.set()
    _call_optional(studio_obj, "_cancel_subfolder_search")
    if getattr(studio_obj, "_folder_search_cancel", None) is not None:
        studio_obj._folder_search_cancel.set()
    if (search_pool := getattr(studio_obj, "_search_pool", None)) is not None:
        search_pool.shutdown(wait=False, cancel_futures=True)
    if (python_pool := getattr(studio_obj, "_python_pool", None)) is not None:
        python_pool.shutdown(wait=False, cancel_futures=True)
    if (export_jobs := getattr(studio_obj, "_export_jobs", None)) is not None:
        export_jobs.cancel_all()
    if (python_jobs := getattr(studio_obj, "_python_jobs", None)) is not None:
        python_jobs.cancel_all(retire=True)
    if (preview_jobs := getattr(studio_obj, "_preview_jobs", None)) is not None:
        preview_jobs.cancel_all(retire=True)
    agent_exports = getattr(studio_obj, "_agent_exports", None)
    if agent_exports:
        for agent_export in tuple(agent_exports.values()):
            try:
                reserved = Path(agent_export["path"])
                if reserved.exists() and reserved.stat().st_size == 0:
                    reserved.unlink()
            except (OSError, TypeError, KeyError):
                pass
        agent_exports.clear()
    if (opening_paths := getattr(studio_obj, "_opening_paths", None)) is not None:
        opening_paths.clear()
    pos_timer = getattr(studio_obj, "position_timer", None)
    if pos_timer is not None:
        if pos_timer.isActive():
            _call_optional(studio_obj, "_save_positions")
        pos_timer.stop()
    pref_timer = getattr(studio_obj, "preference_timer", None)
    if pref_timer is not None:
        if pref_timer.isActive():
            _call_optional(studio_obj, "_preferences", False)
        pref_timer.stop()
    for timer_attr in _STOP_TIMERS:
        timer = getattr(studio_obj, timer_attr, None)
        if timer is not None:
            timer.stop()
    if stopped_watcher is None:
        stopped_watcher = _DEFAULT_STOPPED_WATCHER
    for attr in _WATCHER_ATTRS:
        watcher = getattr(studio_obj, attr, None)
        if watcher is None or watcher is stopped_watcher:
            continue
        watched = watcher.files() + watcher.directories()
        if watched:
            watcher.removePaths(watched)
        setattr(studio_obj, attr, stopped_watcher)
        if shiboken_mod is not None and shiboken_mod.isValid(watcher):
            watcher.setParent(None)
            shiboken_mod.delete(watcher)
        else:
            watcher.deleteLater()
    session = getattr(studio_obj, "session", None)
    color_slot = getattr(studio_obj, "_color_scheme_slot", None)
    signal_pairs = [
        (getattr(session, "changed", None), getattr(studio_obj, "_session_changed_slot", None)),
        (getattr(session, "locationChanged", None), getattr(studio_obj, "_location_changed_slot", None)),
    ]
    if color_slot is not None:
        signal_pairs.insert(0, (gui_app_cls.styleHints().colorSchemeChanged, color_slot))
    for signal, slot in signal_pairs:
        if signal is not None and slot is not None:
            try:
                signal.disconnect(slot)
            except (RuntimeError, TypeError):
                pass
    _call_optional(studio_obj, "_recover")
    if session is not None and getattr(session, "reader_assets", None) is not None:
        session.reader_assets.revoke_owner(studio_obj.window_id)
    studio_obj._retired = True
    windows = getattr(session, "windows", None) if session is not None else None
    if windows is not None:
        windows.pop(getattr(studio_obj, "window_id", None), None)
    pending_retirements = getattr(studio_obj, "_pending_write_retirements", None)
    if pending_retirements is not None:
        with getattr(studio_obj, "_write_callback_lock", None) or contextlib.nullcontext():
            retired_callbacks = list(pending_retirements.values())
            pending_retirements.clear()
        for callback in retired_callbacks:
            try:
                callback()
            except Exception:
                pass
    if windows is not None and not any(not getattr(w, "retired", False) for w in windows.values()):
        for cleanup in list((getattr(session, "_pending_rename_cleanups", None) or {}).values()):
            try:
                cleanup()
            except Exception:
                pass
    if session is not None and windows and not _call_optional(session, "is_quitting"):
        with getattr(session, "_rename_state_lock", None) or contextlib.nullcontext():
            if getattr(session, "workspace", None) is not None:
                session.workspace.pop(studio_obj.window_id, None)
            if getattr(session, "window_workspaces", None) is not None:
                session.window_workspaces.pop(studio_obj.window_id, None)
        _call_optional(next(iter(windows.values())), "_recover")
    sys_prefs = getattr(studio_obj, "system_preferences", None)
    if sys_prefs is not None and sys_prefs.state() != process_cls.ProcessState.NotRunning:
        sys_prefs.terminate()
        sys_prefs.waitForFinished(300)

def folder_slice_key(studio_obj, files):
    return (studio_obj.folder, studio_obj.folder_filter, bool(studio_obj._folder_searching), getattr(studio_obj, "_files_revision", 0), id(files), len(files))

def tab_outline(studio_obj, tab):
    outline = tab.get("outline")
    empty = getattr(studio_obj, "_EMPTY_OUTLINE", EMPTY_OUTLINE)
    return outline if isinstance(outline, list) and outline else empty

def outline_slice_key(studio_obj, active_id, outline):
    return (active_id, getattr(studio_obj, "_outline_revision", 0), id(outline), len(outline))

def _sidebar_inputs(studio_obj):
    tab = _call_method(studio_obj, "_current", _current_tab)
    active_id = studio_obj.active if studio_obj.tabs else ""
    outline = _call_method(studio_obj, "_tab_outline", tab_outline, tab)
    files = getattr(studio_obj, "files", [])
    folder_key = _call_method(studio_obj, "_folder_slice_key", folder_slice_key, files)
    outline_key = _call_method(studio_obj, "_outline_slice_key", outline_slice_key, active_id, outline)
    return tab, active_id, outline, files, folder_key, outline_key, tuple(studio_obj.recent)

def sidebar_slice_key(studio_obj):
    _, _, _, _, folder_key, outline_key, recent_tuple = _sidebar_inputs(studio_obj)
    return (folder_key, outline_key, (recent_tuple, tuple(studio_obj.session.pinned)))

def cached_folder_slice_json(studio_obj, folder_key, files) -> str:
    return _cached_slice(
        studio_obj, "_folder_slice_cache", folder_key,
        lambda: json.dumps({"folder": studio_obj.folder, "folderFilter": studio_obj.folder_filter, "folderSearching": bool(studio_obj._folder_searching), "files": files})[1:-1],
    )

def cached_outline_slice_json(studio_obj, outline_key, outline) -> str:
    return _cached_slice(studio_obj, "_outline_slice_cache", outline_key, lambda: json.dumps(outline))

def cached_recent_slice_json(studio_obj, recent_tuple) -> str:
    return _cached_slice(studio_obj, "_recent_slice_cache", recent_tuple, lambda: json.dumps(list(recent_tuple)))

def cached_pinned_slice_json(studio_obj, pinned_tuple) -> str:
    return _cached_slice(studio_obj, "_pinned_slice_cache", pinned_tuple, lambda: json.dumps(list(pinned_tuple)))

def tabs_slice_key(studio_obj):
    active_id = studio_obj.active if studio_obj.tabs else ""
    return tuple(
        (t["id"], t["name"], t["path"], _call_method(studio_obj, "_is_dirty", _tab_is_dirty, t), bool(t.get("conflict")), bool(t["id"] != active_id and (t.get("agent_staged") or t.get("agent_unreviewed"))))
        for t in studio_obj.tabs
    )

def cached_tabs_slice_json(studio_obj, tabs_key=None) -> str:
    if tabs_key is None:
        tabs_key = _call_method(studio_obj, "_tabs_slice_key", tabs_slice_key)
    return _cached_slice(
        studio_obj, "_tabs_slice_cache", tabs_key,
        lambda: json.dumps([{"id": tid, "name": name, "path": path, "dirty": dirty, "conflict": conflict, "agentEdited": agent_edited} for tid, name, path, dirty, conflict, agent_edited in tabs_key]),
    )

def tabs_snapshot(studio_obj) -> str:
    return _call_method(studio_obj, "_cached_tabs_slice_json", cached_tabs_slice_json)

def active_tab_id(studio_obj) -> str:
    return studio_obj.active if studio_obj.tabs else ""

def cached_colors_slice_json(studio_obj) -> tuple[bool, str]:
    dark, palette = studio_obj._tokens()
    return dark, _cached_slice(studio_obj, "_colors_slice_cache", getattr(studio_obj, "_token_key", None), lambda: json.dumps(dict(palette)))

def sidebar_snapshot(studio_obj) -> str:
    _, active_id, outline, files, folder_key, outline_key, recent_tuple = _sidebar_inputs(studio_obj)
    pinned_tuple = tuple(studio_obj.session.pinned)
    sidebar_key = (folder_key, outline_key, (recent_tuple, pinned_tuple))

    def encode() -> str:
        folder_fragment = _call_method(studio_obj, "_cached_folder_slice_json", cached_folder_slice_json, folder_key, files)
        outline_json = _call_method(studio_obj, "_cached_outline_slice_json", cached_outline_slice_json, outline_key, outline)
        recent_json = _call_method(studio_obj, "_cached_recent_slice_json", cached_recent_slice_json, recent_tuple)
        pinned_json = _call_method(studio_obj, "_cached_pinned_slice_json", cached_pinned_slice_json, pinned_tuple)
        return '{"active": ' + json.dumps(active_id) + ", " + folder_fragment + ', "outline": ' + outline_json + ', "recent": ' + recent_json + ', "pinned": ' + pinned_json + "}"

    return _cached_slice(studio_obj, "_sidebar_snapshot_cache", sidebar_key, encode)

def window_snapshot(studio_obj) -> str:
    tab, active_id, outline, files, folder_key, outline_key, recent_tuple = _sidebar_inputs(studio_obj)
    tabs_json = _call_method(studio_obj, "_cached_tabs_slice_json", cached_tabs_slice_json)
    folder_fragment = _call_method(studio_obj, "_cached_folder_slice_json", cached_folder_slice_json, folder_key, files)
    outline_json = _call_method(studio_obj, "_cached_outline_slice_json", cached_outline_slice_json, outline_key, outline)
    recent_json = _call_method(studio_obj, "_cached_recent_slice_json", cached_recent_slice_json, recent_tuple)
    dark, colors_json = _call_method(studio_obj, "_cached_colors_slice_json", cached_colors_slice_json)
    agent_connection = _call_method(studio_obj, "_agent_connection_snapshot", lambda _s: {"visible": False, "state": "off", "label": "", "detail": ""})
    agent_jump = _call_method(studio_obj, "_agent_jump_snapshot", lambda _s: None)
    head_fragment = json.dumps({
        "active": active_id, "name": tab["name"], "portable": tab["portable"], "conflict": bool(tab.get("conflict")),
        "closedCount": len(studio_obj.closed_tabs), "settings": studio_obj.settings, "mode": studio_obj.mode,
        "fullscreen": studio_obj.fullscreen, "readerOverlay": studio_obj.reader_overlay, "imageOverlay": studio_obj.image_overlay,
        "readerReady": studio_obj.ready, "dark": dark, "zoom": studio_obj.settings["fullZoom" if studio_obj.fullscreen else "normalZoom"],
        "busy": studio_obj.busy > 0, "message": studio_obj.message, "messageRevision": getattr(studio_obj, "_message_revision", 0),
        "agentConnection": agent_connection, "agentJumpTab": agent_jump, "activeAgentUnreviewed": bool(tab.get("agent_unreviewed")),
    })[1:-1]
    return '{"tabs": ' + tabs_json + ", " + head_fragment + ', "outline": ' + outline_json + ", " + folder_fragment + ', "recent": ' + recent_json + ', "colors": ' + colors_json + "}"
