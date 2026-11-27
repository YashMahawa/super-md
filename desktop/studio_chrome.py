"""Focused theme, system palette, custom theme library, and shortcut helpers for Studio."""
from __future__ import annotations

from collections.abc import Callable
import copy
import json
from pathlib import Path
import uuid

from PySide6.QtCore import QUrl
from PySide6.QtGui import QDesktopServices, QGuiApplication

try:
    from . import custom_theme
    from .core.paths import resource_root
    from .documents import atomic_json
    from .shortcuts import DEFINITIONS as SHORTCUT_DEFINITIONS, capture_sequence, default_shortcuts, native_label, normalize_shortcuts, parse_sequence
    from .theme import detect_system_dark, read_system_palette, system_palette_paths, tokens
except ImportError:
    import custom_theme
    from core.paths import resource_root
    from documents import atomic_json
    from shortcuts import DEFINITIONS as SHORTCUT_DEFINITIONS, capture_sequence, default_shortcuts, native_label, normalize_shortcuts, parse_sequence
    from theme import detect_system_dark, read_system_palette, system_palette_paths, tokens

_PATTERN_DEFAULTS = (("patternKind", ""), ("patternOpacity", -1), ("patternSize", 0), ("patternSpacing", 0))


def _call(studio_obj, name: str, fallback: Callable, *args, **kwargs):
    fn = getattr(studio_obj, name, None)
    return fn(*args, **kwargs) if callable(fn) else fallback(studio_obj, *args, **kwargs)


def _emit(studio_obj, load: bool = True) -> None:
    if callable(fn := getattr(studio_obj, "_emit", None)): fn(load)


def _preferences(studio_obj, *args) -> None:
    if callable(fn := getattr(studio_obj, "_preferences", None)): fn(*args)


def _submit(studio_obj, action: Callable, done: Callable, busy: bool = False) -> None:
    if callable(fn := getattr(studio_obj, "_submit", None)):
        fn(action, done, busy)
        return
    try: value, error = action(), None
    except Exception as reason: value, error = None, str(reason)  # pragma: no cover
    done(value, error)


def tokens_for(studio_obj, *, tokens_fn: Callable | None = None):
    # Scheme generation is costly and QML reads colors from many bindings.
    compute_tokens = tokens_fn or tokens
    settings = studio_obj.settings
    theme = settings["fullTheme" if getattr(studio_obj, "fullscreen", False) else "theme"]
    selected = studio_obj.session.custom_theme
    system_dark = getattr(studio_obj, "system_dark", None)
    system_colors = getattr(studio_obj, "system_colors", {})
    system_mode = getattr(studio_obj, "system_mode", None)
    key = (theme, system_dark, json.dumps(system_colors, sort_keys=True), system_mode, settings["accent"], studio_obj.session.theme_revision)
    if getattr(studio_obj, "_token_key", None) != key:
        studio_obj._token_key = key
        dark, colors = compute_tokens(theme, system_dark, system_colors, system_mode, selected["accent"] if selected else settings["accent"])
        studio_obj._token_value = (dark, custom_theme.palette(colors, custom_theme.variant(selected, theme, dark).get("colors", {}))) if selected else (dark, colors)
    return studio_obj._token_value


def dark_for(studio_obj) -> bool: return _call(studio_obj, "_tokens", tokens_for)[0]
def colors_for(studio_obj) -> dict: return dict(_call(studio_obj, "_tokens", tokens_for)[1])
def palette(studio_obj) -> dict: return _call(studio_obj, "_colors", colors_for)
def theme_metrics(selected_theme: dict | None) -> dict: return {"controlRadius": 22, "contentRadius": 16, **(selected_theme or {}).get("metrics", {})}
def custom_theme_name(selected_theme: dict | None) -> str: return (selected_theme or {}).get("name", "Built-in appearance")
def custom_theme_active(selected_theme: dict | None) -> bool: return selected_theme is not None
def bundled_themes(root: Path | None = None) -> list: return custom_theme.bundled_themes(root or resource_root())
def saved_themes(session) -> list: return copy.deepcopy(session.saved_themes)
def active_theme_kind(session) -> str: return session.active_theme_kind
def active_theme_id(session) -> str: return session.active_theme_id
def motion_enabled(settings: dict) -> bool: return bool(settings["motion"])
def shortcut_actions() -> str: return json.dumps(SHORTCUT_DEFINITIONS)
def shortcut_bindings(settings: dict) -> str: return json.dumps(settings.get("shortcuts", {}))
def shortcut_sequences(settings: dict, action: str) -> list: return list(settings.get("shortcuts", {}).get(action, []))
def choose_custom_theme(studio_obj) -> None: studio_obj.themePickerRequested.emit()
def choose_theme_export(studio_obj) -> None: studio_obj.themeExportRequested.emit()
def open_theme_guide(studio_obj) -> None: studio_obj.readerCall.emit("window.supermdThemeGuide?.()")


def custom_theme_has_source(session) -> bool:
    return session.custom_theme is not None and session.active_theme_kind != "preset" and bool(session.theme_source)


def theme_artwork(selected_theme: dict | None, settings: dict, *, fullscreen: bool = False, dark: bool = False) -> dict:
    variant = custom_theme.variant(selected_theme, settings["fullTheme" if fullscreen else "theme"], dark)
    return custom_theme.artwork(selected_theme, variant)


def theme_background(selected_theme: dict | None, settings: dict, *, dark: bool = False) -> dict:
    style = custom_theme.reader(selected_theme, settings["theme"], dark, settings)
    return {"pattern": "none", "opacity": 0.06, "size": 24, "spacing": 24, **(style["background"] or {})}


def reset_theme_background(studio_obj) -> None:
    studio_obj.settings.update(patternKind="", patternOpacity=-1, patternSize=0, patternSpacing=0)
    _preferences(studio_obj)
    _emit(studio_obj)


def shortcut_label(settings: dict, action: str, *, sequences_fn: Callable[[str], list] | None = None) -> str:
    values = sequences_fn(action) if callable(sequences_fn) else shortcut_sequences(settings, action)
    return "  /  ".join(native_label(value) for value in values) if values else "Disabled"


def shortcut_labels(settings: dict, *, label_fn: Callable[[str], str] | None = None) -> str:
    resolve = label_fn if callable(label_fn) else (lambda action: shortcut_label(settings, action))
    return json.dumps({action: resolve(action) for action in settings.get("shortcuts", {})})


def capture_shortcut(key: int, modifiers: int) -> str:
    sequence, error = capture_sequence(key, modifiers)
    return json.dumps({"sequence": sequence, "error": error})


def set_shortcut(studio_obj, action: str, value: str) -> str:
    if action not in studio_obj.settings.get("shortcuts", {}): return "Unknown shortcut action."
    sequence = parse_sequence(value) if value else None
    if value and sequence is None: return "Invalid key combination."
    candidate = copy.deepcopy(studio_obj.settings["shortcuts"])
    candidate[action] = [sequence] if sequence else []
    validated, error = normalize_shortcuts(candidate, edited_action=action)
    if error: return error
    if validated == studio_obj.settings["shortcuts"]: return ""
    studio_obj.settings["shortcuts"] = validated
    _call(studio_obj, "_notify_shortcuts", notify_shortcuts)
    _preferences(studio_obj)
    _emit(studio_obj, False)
    return ""


def reset_shortcuts(studio_obj) -> str:
    defaults = default_shortcuts()
    if defaults == studio_obj.settings["shortcuts"]: return ""
    studio_obj.settings["shortcuts"] = defaults
    _call(studio_obj, "_notify_shortcuts", notify_shortcuts)
    _preferences(studio_obj)
    _emit(studio_obj, False)
    return ""


def notify_shortcuts(studio_obj) -> None:
    # Do not rebuild every QML Shortcut/recorder on each note edit, zoom or
    # scroll update. Only an actual binding change invalidates these maps.
    for window in tuple(studio_obj.session.windows.values()):
        if not getattr(window, "retired", False): window.shortcutsChanged.emit()


def schedule_theme(studio_obj, *_) -> None:
    if (timer := getattr(studio_obj, "theme_debounce", None)) is not None: timer.start(150)


def watch_palette(studio_obj, *, palette_paths_fn: Callable | None = None) -> None:
    if getattr(studio_obj, "retired", False): return
    watched = set(studio_obj.palette_watcher.files() + studio_obj.palette_watcher.directories())
    for path in (palette_paths_fn or system_palette_paths)():
        for target in (path, path.parent):
            if target.exists() and str(target) not in watched:
                studio_obj.palette_watcher.addPath(str(target))


def palette_changed(studio_obj, *_) -> None:
    _call(studio_obj, "_watch_palette", watch_palette)  # Atomic file replacement invalidates the old watch.
    _call(studio_obj, "_schedule_theme", schedule_theme)


def system_setting_changed(studio_obj) -> None:
    studio_obj.system_preferences.readAllStandardOutput()
    _call(studio_obj, "_schedule_theme", schedule_theme)


def refresh_theme(studio_obj, *, detect_dark_fn: Callable | None = None, read_palette_fn: Callable | None = None) -> None:
    if getattr(studio_obj, "_theme_running", False):
        studio_obj._theme_pending = True
        return
    detect_dark, read_palette = detect_dark_fn or detect_system_dark, read_palette_fn or read_system_palette
    studio_obj._theme_running = True
    scheme = QGuiApplication.styleHints().colorScheme().name

    def finished(result, error):
        studio_obj._theme_running = False
        if not error and result != getattr(studio_obj, "_theme_result", None):
            studio_obj._theme_result = result
            studio_obj.system_dark, (studio_obj.system_mode, studio_obj.system_colors) = result
            _emit(studio_obj)
        if getattr(studio_obj, "_theme_pending", False):
            studio_obj._theme_pending = False
            _call(studio_obj, "_schedule_theme", schedule_theme)

    _submit(studio_obj, lambda: (detect_dark(scheme), read_palette()), finished, False)


def save_theme_library(studio_obj, *, write_json: Callable | None = None) -> None:
    s = studio_obj.session
    (write_json or atomic_json)(studio_obj.data / "theme-library.json", {"active": {"kind": s.active_theme_kind, "id": s.active_theme_id}, "saved": s.saved_themes})


def _persist_theme_library(studio_obj, write_json: Callable | None = None) -> None:
    if callable(fn := getattr(studio_obj, "_save_theme_library", None)): fn()
    else: save_theme_library(studio_obj, write_json=write_json)


def _load_theme(studio_obj, path, *, write_json: Callable | None = None, read_theme: Callable | None = None, **kwargs) -> None:
    if callable(fn := getattr(studio_obj, "_load_custom_theme", None)): fn(path, **kwargs)
    else: load_custom_theme(studio_obj, path, write_json=write_json, read_theme=read_theme, **kwargs)


def clear_theme_background_overrides(studio_obj) -> None:
    changed = any(studio_obj.settings.get(key) != default for key, default in _PATTERN_DEFAULTS)
    studio_obj.settings.update(patternKind="", patternOpacity=-1, patternSize=0, patternSpacing=0)
    if changed: _preferences(studio_obj, False)


def _reset_builtin_theme_state(studio_obj) -> None:
    session = studio_obj.session
    session.custom_theme, session.theme_source, session.active_theme_kind, session.active_theme_id = None, "", "builtin", ""
    session.theme_epoch += 1
    session.theme_revision += 1
    for filename in ("theme.json", "theme-source.json"): (studio_obj.data / filename).unlink(missing_ok=True)
    _call(studio_obj, "_clear_theme_background_overrides", clear_theme_background_overrides)
    for window in session.windows.values(): _call(window, "_watch_custom_theme", watch_custom_theme)


def _write_saved_theme_file(data_dir: Path, writer: Callable, entry_id: str, value: dict) -> None:
    (data_dir / "themes").mkdir(parents=True, exist_ok=True)
    writer(data_dir / "themes" / f"{entry_id}.json", value)


def _activate_theme_selection(studio_obj, writer: Callable, kind: str, theme_id: str, source_str: str) -> None:
    studio_obj.session.active_theme_kind, studio_obj.session.active_theme_id, studio_obj.session.theme_source = kind, theme_id, source_str
    if source_str: writer(studio_obj.data / "theme-source.json", {"path": source_str})
    else: (studio_obj.data / "theme-source.json").unlink(missing_ok=True)


def watch_custom_theme(studio_obj) -> None:
    if getattr(studio_obj, "retired", False): return
    watcher = studio_obj.custom_theme_watcher
    if paths := watcher.files() + watcher.directories(): watcher.removePaths(paths)
    session = studio_obj.session
    source = Path(session.theme_source) if session.active_theme_kind != "preset" and session.theme_source else None
    studio_obj.custom_theme_stamp = custom_theme.stamp(source) if source else None
    if source: watcher.addPaths([str(path) for path in (source, source.parent) if path.exists()])


def custom_theme_event(studio_obj) -> None:
    session = studio_obj.session
    if getattr(studio_obj, "retired", False) or session.active_theme_kind == "preset" or not session.theme_source: return
    value = custom_theme.stamp(Path(session.theme_source))
    if value != getattr(studio_obj, "custom_theme_stamp", None):
        studio_obj.custom_theme_stamp = value
        _call(studio_obj, "reloadCustomTheme", reload_custom_theme)


def restore_custom_theme(studio_obj, *, root: Path | None = None) -> None:
    if getattr(studio_obj, "retired", False): return
    _call(studio_obj, "_watch_custom_theme", watch_custom_theme)
    session = studio_obj.session
    if session.theme_restored: return
    session.theme_restored = True
    cached = studio_obj.data / "theme.json"
    if session.active_theme_kind == "preset":
        try: target = cached if cached.is_file() else custom_theme.bundled_theme_path(session.active_theme_id, root or resource_root())
        except ValueError: return
        _load_theme(studio_obj, target, mode="restore")
        return
    if session.active_theme_kind == "saved":
        saved_file = studio_obj.data / "themes" / f"{session.active_theme_id}.json"
        primary = saved_file if saved_file.is_file() else cached
        source = Path(session.theme_source) if session.theme_source else None
        follow = source if source and source.is_file() and source != primary else None
        if primary.is_file(): _load_theme(studio_obj, primary, mode="restore", follow_source=follow)
        elif follow: _load_theme(studio_obj, follow, mode="restore")
        return
    source = Path(session.theme_source) if session.theme_source else cached
    if not source.is_file(): source = cached
    if session.custom_theme is None and cached.is_file() and cached != source:
        _load_theme(studio_obj, cached, mode="restore", follow_source=source)
    elif source.is_file():
        _load_theme(studio_obj, source, mode="restore")


def import_custom_theme(studio_obj, path: Path | str) -> None:
    _load_theme(studio_obj, Path(path), mode="import")


def select_bundled_theme(studio_obj, preset_id: str, *, root: Path | None = None) -> None:
    if callable(fn := getattr(studio_obj, "_apply_bundled_theme", None)): fn(preset_id)
    else: apply_bundled_theme(studio_obj, preset_id, root=root)


def apply_bundled_theme(studio_obj, preset_id: str, callback=None, *, root: Path | None = None) -> None:
    if not isinstance(preset_id, str) or not preset_id:
        if callback: callback(None, "Unknown bundled theme")
        return
    if preset_id == "builtin":
        _call(studio_obj, "resetCustomTheme", reset_custom_theme)
        if callback: callback({"id": "builtin", "name": "Built-in appearance"}, "")
        return
    try: path = custom_theme.bundled_theme_path(preset_id, root or resource_root())
    except ValueError as error:
        studio_obj.message = "Theme not applied: " + str(error)
        _emit(studio_obj, False)
        if callback: callback(None, str(error))
        return
    _load_theme(studio_obj, path, mode="preset", preset_id=preset_id, callback=callback)


def select_saved_theme(studio_obj, entry_id: str) -> None:
    if not any(item["id"] == entry_id for item in studio_obj.session.saved_themes): return
    path = studio_obj.data / "themes" / f"{entry_id}.json"
    if not path.is_file():
        studio_obj.message = "Saved theme is unavailable."
        _emit(studio_obj, False)
        return
    _load_theme(studio_obj, path, mode="saved", entry_id=entry_id)


def delete_saved_theme(studio_obj, entry_id: str, *, write_json: Callable | None = None) -> None:
    session = studio_obj.session
    entry = next((item for item in session.saved_themes if item["id"] == entry_id), None)
    if entry is None: return
    session.saved_themes = [item for item in session.saved_themes if item["id"] != entry_id]
    (studio_obj.data / "themes" / f"{entry_id}.json").unlink(missing_ok=True)
    if session.active_theme_kind == "saved" and session.active_theme_id == entry_id:
        _reset_builtin_theme_state(studio_obj)
    try: _persist_theme_library(studio_obj, write_json)
    except OSError: pass
    studio_obj.message = "Removed " + entry["name"]
    if hasattr(session, "changed"): session.changed.emit()


def reload_custom_theme(studio_obj) -> None:
    session = studio_obj.session
    if getattr(studio_obj, "retired", False) or session.active_theme_kind == "preset": return
    if session.active_theme_kind == "saved" and not session.theme_source: return
    cached = studio_obj.data / "theme.json"
    source = Path(session.theme_source) if session.theme_source else cached
    if not source.is_file(): source = cached
    _call(studio_obj, "_watch_custom_theme", watch_custom_theme)
    if session.custom_theme is None and cached.is_file() and cached != source:
        _load_theme(studio_obj, cached, mode="restore", follow_source=source, clear_overrides_on_follow=True)
    elif source.is_file():
        _load_theme(studio_obj, source, mode="reload")


def load_custom_theme(
    studio_obj, path, mode: str = "import", follow_source=None, preset_id: str = "", entry_id: str = "",
    callback=None, clear_overrides_on_follow: bool = False, *, write_json: Callable | None = None, read_theme: Callable | None = None,
) -> None:
    writer, session = write_json or atomic_json, studio_obj.session
    session.theme_epoch += 1
    epoch = session.theme_epoch
    engine_fn = getattr(studio_obj, "_engine", None)
    try: engine = engine_fn() if callable(engine_fn) else getattr(studio_obj, "engine", Path("unused-theme-engine"))
    except ValueError as error:
        studio_obj.message = str(error)
        _emit(studio_obj, False)
        if callback: callback(None, str(error))
        return

    next_follow_mode = "reload" if clear_overrides_on_follow else "restore"

    def finished(value, error):
        if epoch != session.theme_epoch:
            if callback: callback(None, "Superseded by newer theme selection")
            return
        if error:
            studio_obj.message = "Theme not applied: " + str(error)
            _emit(studio_obj, False)
            if callback: callback(None, str(error))
            if follow_source: _load_theme(studio_obj, follow_source, write_json=write_json, read_theme=read_theme, mode=next_follow_mode)
            return
        try:
            changed = value != session.custom_theme
            save_library = mode in ("import", "preset", "saved")
            if mode == "import":
                source_str = str(path)
                existing = next((item for item in session.saved_themes if item.get("source") == source_str), None)
                if existing is None:
                    existing = {"id": uuid.uuid4().hex, "name": value["name"], "source": source_str}
                    session.saved_themes.append(existing)
                existing["name"] = value["name"]
                _write_saved_theme_file(studio_obj.data, writer, existing["id"], value)
                _activate_theme_selection(studio_obj, writer, "saved", existing["id"], source_str)
            elif mode == "preset":
                _activate_theme_selection(studio_obj, writer, "preset", preset_id, "")
            elif mode == "saved":
                entry = next((item for item in session.saved_themes if item["id"] == entry_id), None)
                source_str = entry.get("source", "") if entry else ""
                if entry is not None: entry["name"] = value["name"]
                _activate_theme_selection(studio_obj, writer, "saved", entry_id, source_str)
            elif mode == "reload" and session.active_theme_kind == "saved" and session.active_theme_id:
                _write_saved_theme_file(studio_obj.data, writer, session.active_theme_id, value)
                entry = next((item for item in session.saved_themes if item["id"] == session.active_theme_id), None)
                if entry is not None: entry["name"] = value["name"]
                save_library = True
            if mode in ("import", "preset", "saved") or changed: writer(studio_obj.data / "theme.json", value)
            if save_library: _persist_theme_library(studio_obj, writer)
            if mode in ("import", "preset", "saved", "reload"): _call(studio_obj, "_clear_theme_background_overrides", clear_theme_background_overrides)
            session.custom_theme = value
            if changed: session.theme_revision += 1
            for window in session.windows.values(): _call(window, "_watch_custom_theme", watch_custom_theme)
            if mode in ("import", "preset", "saved", "reload") or (mode != "restore" and changed): studio_obj.message = "Applied " + value["name"]
            if hasattr(session, "changed"): session.changed.emit()
            if callback: callback({"id": preset_id or entry_id or session.active_theme_id, "name": value["name"]}, "")
        except OSError as failure:
            studio_obj.message = "Could not save theme: " + str(failure)
            _emit(studio_obj, False)
            if callback: callback(None, str(failure))
        if follow_source: _load_theme(studio_obj, follow_source, write_json=write_json, read_theme=read_theme, mode=next_follow_mode)

    def read():
        try: return (read_theme or custom_theme.read)(engine, path), None
        except Exception as failure: return None, str(failure)

    _submit(studio_obj, read, lambda result, error: finished(*(result or (None, error))), False)


def reset_custom_theme(studio_obj, *, write_json: Callable | None = None) -> None:
    _reset_builtin_theme_state(studio_obj)
    try: _persist_theme_library(studio_obj, write_json)
    except OSError: pass
    if hasattr(studio_obj.session, "changed"): studio_obj.session.changed.emit()


def edit_custom_theme(studio_obj, *, open_url: Callable | None = None) -> None:
    session = studio_obj.session
    if session.active_theme_kind == "preset" or not session.theme_source: return
    source = Path(session.theme_source)
    if source.is_file(): (open_url or QDesktopServices.openUrl)(QUrl.fromLocalFile(str(source)))
