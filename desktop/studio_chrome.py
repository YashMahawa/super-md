"""Theme, shortcut, window chrome, selection assistant, mode/zoom, and settings helpers for Studio."""
from __future__ import annotations

import base64
import copy
import json
import math
import sys
import uuid
from pathlib import Path
from PySide6.QtCore import QStandardPaths

_PREFERRED_FONTS = ["Manrope", "Roboto", "Noto Sans", "Noto Serif", "JetBrains Mono", "Libertinus Serif", "New Computer Modern", "DejaVu Sans Mono"]
_BOOL_SETTINGS = frozenset({"restorePosition", "centerLock", "motion", "welcomed", "autosave", "checkUpdates", "autoUpdate", "spellCheck", "grammarCheck", "latexAutofix", "typewriterScroll", "desktopIntegration", "fullDocumentAccessibility", "keepInBackground"})
_FINITE_SETTINGS = frozenset({"size", "width", "widthPercent", "lineHeight", "normalZoom", "fullZoom"})
_PATTERN_DEFAULTS = (("patternKind", ""), ("patternOpacity", -1), ("patternSize", 0), ("patternSpacing", 0))

def _studio_module():
    mod = sys.modules.get("studio") or sys.modules.get("desktop.studio")
    if mod is not None:
        return mod
    try:
        from . import studio as mod  # type: ignore[no-redef]
    except ImportError:  # pragma: no cover
        import studio as mod  # type: ignore[no-redef]
    return mod

def _call(studio_obj, name: str, fallback, *args, **kwargs):
    fn = getattr(studio_obj, name, None)
    return fn(*args, **kwargs) if callable(fn) else fallback(studio_obj, *args, **kwargs)

def _emit(studio_obj, load: bool = True) -> None:
    if callable(fn := getattr(studio_obj, "_emit", None)): fn(load)
def _preferences(studio_obj, *args) -> None:
    if callable(fn := getattr(studio_obj, "_preferences", None)): fn(*args)

def _submit(studio_obj, action, done, busy: bool = False) -> None:
    if callable(fn := getattr(studio_obj, "_submit", None)):
        fn(action, done, busy)
        return
    try: value, error = action(), None
    except Exception as reason: value, error = None, str(reason)  # pragma: no cover
    done(value, error)

def tokens_for(studio_obj):
    # Scheme generation is costly and QML reads colors from many bindings.
    mod = _studio_module()
    theme = studio_obj.settings["fullTheme" if getattr(studio_obj, "fullscreen", False) else "theme"]
    selected = studio_obj.session.custom_theme
    system_dark = getattr(studio_obj, "system_dark", None)
    system_colors = getattr(studio_obj, "system_colors", {})
    system_mode = getattr(studio_obj, "system_mode", None)
    key = (theme, system_dark, json.dumps(system_colors, sort_keys=True), system_mode, studio_obj.settings["accent"], studio_obj.session.theme_revision)
    if getattr(studio_obj, "_token_key", None) != key:
        studio_obj._token_key = key
        dark, colors = mod.tokens(theme, system_dark, system_colors, system_mode, selected["accent"] if selected else studio_obj.settings["accent"])
        studio_obj._token_value = (dark, mod.custom_theme.palette(colors, mod.custom_theme.variant(selected, theme, dark).get("colors", {}))) if selected else (dark, colors)
    return studio_obj._token_value

def dark_for(studio_obj) -> bool: return _call(studio_obj, "_tokens", tokens_for)[0]
def colors_for(studio_obj) -> dict: return dict(_call(studio_obj, "_tokens", tokens_for)[1])
def palette(studio_obj) -> dict: return _call(studio_obj, "_colors", colors_for)
def theme_metrics(studio_obj) -> dict: return {"controlRadius": 22, "contentRadius": 16, **(studio_obj.session.custom_theme or {}).get("metrics", {})}
def custom_theme_name(studio_obj) -> str: return (studio_obj.session.custom_theme or {}).get("name", "Built-in appearance")
def custom_theme_active(studio_obj) -> bool: return studio_obj.session.custom_theme is not None
def bundled_themes(_studio_obj=None) -> list: return (mod := _studio_module()).custom_theme.bundled_themes(mod.ROOT)
def saved_themes(studio_obj) -> list: return copy.deepcopy(studio_obj.session.saved_themes)
def active_theme_kind(studio_obj) -> str: return studio_obj.session.active_theme_kind
def active_theme_id(studio_obj) -> str: return studio_obj.session.active_theme_id
def motion_enabled(studio_obj) -> bool: return bool(studio_obj.settings["motion"])
def shortcut_actions(_studio_obj=None) -> str: return json.dumps(_studio_module().SHORTCUT_DEFINITIONS)
def shortcut_bindings(studio_obj) -> str: return json.dumps(studio_obj.settings.get("shortcuts", {}))
def shortcut_sequences(studio_obj, action: str) -> list: return list(studio_obj.settings.get("shortcuts", {}).get(action, []))
def reader_fullscreen(studio_obj) -> bool: return bool(studio_obj.fullscreen)
def choose_font(studio_obj) -> None: studio_obj.fontPickerRequested.emit()
def choose_custom_theme(studio_obj) -> None: studio_obj.themePickerRequested.emit()
def choose_theme_export(studio_obj) -> None: studio_obj.themeExportRequested.emit()
def open_theme_guide(studio_obj) -> None: studio_obj.readerCall.emit("window.supermdThemeGuide?.()")
def choose_note_location(studio_obj) -> None: studio_obj.noteLocationPickerRequested.emit()
def navigate_heading(studio_obj, heading: str, offset: int) -> None: studio_obj.readerCall.emit(f"window.supermdHeading?.({json.dumps(heading)}, {offset})")
def import_custom_theme(studio_obj, value: str) -> None: _call(studio_obj, "_load_custom_theme", load_custom_theme, _studio_module().local_path(value), mode="import")
def select_bundled_theme(studio_obj, preset_id: str) -> None: _call(studio_obj, "_apply_bundled_theme", apply_bundled_theme, preset_id)
def fonts(_studio_obj=None) -> list[str]: return _PREFERRED_FONTS + sorted(set(_studio_module().QFontDatabase.families()) - set(_PREFERRED_FONTS))
def shortcut_labels(studio_obj) -> str: return json.dumps({action: _call(studio_obj, "shortcutLabel", shortcut_label, action) for action in studio_obj.settings.get("shortcuts", {})})
def capture_shortcut(_studio_obj, key: int, modifiers: int) -> str:
    sequence, error = _studio_module().capture_sequence(key, modifiers)
    return json.dumps({"sequence": sequence, "error": error})

def custom_theme_has_source(studio_obj) -> bool:
    return (s := studio_obj.session).custom_theme is not None and s.active_theme_kind != "preset" and bool(s.theme_source)

def theme_artwork(studio_obj) -> dict:
    mod = _studio_module()
    theme = studio_obj.settings["fullTheme" if getattr(studio_obj, "fullscreen", False) else "theme"]
    selected = mod.custom_theme.variant(studio_obj.session.custom_theme, theme, _call(studio_obj, "_dark", dark_for))
    return mod.custom_theme.artwork(studio_obj.session.custom_theme, selected)

def theme_background(studio_obj) -> dict:
    mod = _studio_module()
    style = mod.custom_theme.reader(studio_obj.session.custom_theme, studio_obj.settings["theme"], _call(studio_obj, "_dark", dark_for), studio_obj.settings)
    return {"pattern": "none", "opacity": 0.06, "size": 24, "spacing": 24, **(style["background"] or {})}

def reset_theme_background(studio_obj) -> None:
    studio_obj.settings.update(patternKind="", patternOpacity=-1, patternSize=0, patternSpacing=0)
    _preferences(studio_obj)
    _emit(studio_obj)

def shortcut_label(studio_obj, action: str) -> str:
    mod = _studio_module()
    values = _call(studio_obj, "shortcutSequences", shortcut_sequences, action)
    return "  /  ".join(mod.native_label(value) for value in values) if values else "Disabled"

def set_shortcut(studio_obj, action: str, value: str) -> str:
    mod = _studio_module()
    if action not in studio_obj.settings.get("shortcuts", {}): return "Unknown shortcut action."
    sequence = mod.parse_sequence(value) if value else None
    if value and sequence is None: return "Invalid key combination."
    candidate = copy.deepcopy(studio_obj.settings["shortcuts"])
    candidate[action] = [sequence] if sequence else []
    validated, error = mod.normalize_shortcuts(candidate, edited_action=action)
    if error: return error
    if validated == studio_obj.settings["shortcuts"]: return ""
    studio_obj.settings["shortcuts"] = validated
    _call(studio_obj, "_notify_shortcuts", notify_shortcuts)
    _preferences(studio_obj)
    _emit(studio_obj, False)
    return ""

def reset_shortcuts(studio_obj) -> str:
    defaults = _studio_module().default_shortcuts()
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

def watch_palette(studio_obj) -> None:
    if getattr(studio_obj, "retired", False): return
    watched = set(studio_obj.palette_watcher.files() + studio_obj.palette_watcher.directories())
    for path in _studio_module().system_palette_paths():
        for target in (path, path.parent):
            if target.exists() and str(target) not in watched:
                studio_obj.palette_watcher.addPath(str(target))

def palette_changed(studio_obj, *_) -> None:
    _call(studio_obj, "_watch_palette", watch_palette)  # Atomic file replacement invalidates the old watch.
    _call(studio_obj, "_schedule_theme", schedule_theme)

def system_setting_changed(studio_obj) -> None:
    studio_obj.system_preferences.readAllStandardOutput()
    _call(studio_obj, "_schedule_theme", schedule_theme)

def refresh_theme(studio_obj) -> None:
    if getattr(studio_obj, "_theme_running", False):
        studio_obj._theme_pending = True
        return
    mod = _studio_module()
    studio_obj._theme_running = True
    scheme = mod.QGuiApplication.styleHints().colorScheme().name
    def finished(result, error):
        studio_obj._theme_running = False
        if not error and result != getattr(studio_obj, "_theme_result", None):
            studio_obj._theme_result = result
            studio_obj.system_dark, (studio_obj.system_mode, studio_obj.system_colors) = result
            _emit(studio_obj)
        if getattr(studio_obj, "_theme_pending", False):
            studio_obj._theme_pending = False
            _call(studio_obj, "_schedule_theme", schedule_theme)
    _submit(studio_obj, lambda: (mod.detect_system_dark(scheme), mod.read_system_palette()), finished, False)

def selection_assistant_label(studio_obj) -> str:
    provider = studio_obj.settings.get("selectionAssistant")
    return _studio_module().ASSISTANTS.get(provider, "ChatGPT") if isinstance(provider, str) else "ChatGPT"

def selection_action(studio_obj, action: str, text: str) -> None:
    mod = _studio_module()
    try:
        url, copy_text, message = mod.selection_target(action, text, studio_obj.settings.get("selectionAssistant", "chatgpt"))
        if copy_text: mod.QGuiApplication.clipboard().setText(text.replace("\u2029", "\n"))
        opened = mod.QDesktopServices.openUrl(mod.QUrl(url))
        studio_obj.message = message if opened else "Could not open your browser." + (" The selected text is copied." if copy_text else "")
    except (ValueError, UnicodeError) as error:
        studio_obj.message = str(error)
    _emit(studio_obj, False)

def remember_window(studio_obj, width: int, height: int, maximized: bool) -> None:
    # Reopen at the size people left, not a fixed default every launch.
    value = {"width": max(760, min(10000, int(width))), "height": max(520, min(10000, int(height))), "maximized": bool(maximized)}
    if studio_obj.settings.get("window") != value:
        studio_obj.settings["window"] = value
        _preferences(studio_obj)

def fedora_window_frame(_studio_obj=None) -> bool:
    mod = _studio_module()
    if not mod.sys.platform.startswith("linux"): return False
    try: return mod.platform.freedesktop_os_release().get("ID") == "fedora"
    except OSError: return False

def show_toolbar_window_controls(studio_obj) -> bool:
    mod = _studio_module()
    desktop = mod.os.environ.get("XDG_CURRENT_DESKTOP", "").lower()
    attr = getattr(studio_obj, "fedoraWindowFrame", None)
    fedora = bool(attr() if callable(attr) else attr) if attr is not None else fedora_window_frame(studio_obj)
    return fedora or (mod.sys.platform.startswith("linux") and any(name in desktop for name in ("hyprland", "sway", "river", "niri")))

def save_theme_library(studio_obj) -> None:
    s = studio_obj.session
    _studio_module().atomic_json(studio_obj.data / "theme-library.json", {"active": {"kind": s.active_theme_kind, "id": s.active_theme_id}, "saved": s.saved_themes})

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

def _write_saved_theme_file(studio_obj, mod, entry_id: str, value: dict) -> None:
    (studio_obj.data / "themes").mkdir(parents=True, exist_ok=True)
    mod.atomic_json(studio_obj.data / "themes" / f"{entry_id}.json", value)

def _activate_theme_selection(studio_obj, mod, kind: str, theme_id: str, source_str: str) -> None:
    studio_obj.session.active_theme_kind, studio_obj.session.active_theme_id, studio_obj.session.theme_source = kind, theme_id, source_str
    if source_str: mod.atomic_json(studio_obj.data / "theme-source.json", {"path": source_str})
    else: (studio_obj.data / "theme-source.json").unlink(missing_ok=True)

def watch_custom_theme(studio_obj) -> None:
    if getattr(studio_obj, "retired", False): return
    watcher = studio_obj.custom_theme_watcher
    if paths := watcher.files() + watcher.directories(): watcher.removePaths(paths)
    session = studio_obj.session
    source = Path(session.theme_source) if session.active_theme_kind != "preset" and session.theme_source else None
    studio_obj.custom_theme_stamp = _studio_module().custom_theme.stamp(source) if source else None
    if source: watcher.addPaths([str(path) for path in (source, source.parent) if path.exists()])

def custom_theme_event(studio_obj) -> None:
    session = studio_obj.session
    if getattr(studio_obj, "retired", False) or session.active_theme_kind == "preset" or not session.theme_source: return
    value = _studio_module().custom_theme.stamp(Path(session.theme_source))
    if value != getattr(studio_obj, "custom_theme_stamp", None):
        studio_obj.custom_theme_stamp = value
        _call(studio_obj, "reloadCustomTheme", reload_custom_theme)

def restore_custom_theme(studio_obj) -> None:
    if getattr(studio_obj, "retired", False): return
    mod = _studio_module()
    _call(studio_obj, "_watch_custom_theme", watch_custom_theme)
    session = studio_obj.session
    if session.theme_restored: return
    session.theme_restored = True
    cached = studio_obj.data / "theme.json"
    if session.active_theme_kind == "preset":
        try: target = cached if cached.is_file() else mod.custom_theme.bundled_theme_path(session.active_theme_id, mod.ROOT)
        except ValueError: return
        _call(studio_obj, "_load_custom_theme", load_custom_theme, target, mode="restore")
        return
    if session.active_theme_kind == "saved":
        saved_file = studio_obj.data / "themes" / f"{session.active_theme_id}.json"
        primary = saved_file if saved_file.is_file() else cached
        source = Path(session.theme_source) if session.theme_source else None
        follow = source if source and source.is_file() and source != primary else None
        if primary.is_file(): _call(studio_obj, "_load_custom_theme", load_custom_theme, primary, mode="restore", follow_source=follow)
        elif follow: _call(studio_obj, "_load_custom_theme", load_custom_theme, follow, mode="restore")
        return
    source = Path(session.theme_source) if session.theme_source else cached
    if not source.is_file(): source = cached
    if session.custom_theme is None and cached.is_file() and cached != source:
        _call(studio_obj, "_load_custom_theme", load_custom_theme, cached, mode="restore", follow_source=source)
    elif source.is_file():
        _call(studio_obj, "_load_custom_theme", load_custom_theme, source, mode="restore")

def apply_bundled_theme(studio_obj, preset_id: str, callback=None) -> None:
    if not isinstance(preset_id, str) or not preset_id:
        if callback: callback(None, "Unknown bundled theme")
        return
    if preset_id == "builtin":
        _call(studio_obj, "resetCustomTheme", reset_custom_theme)
        if callback: callback({"id": "builtin", "name": "Built-in appearance"}, "")
        return
    mod = _studio_module()
    try: path = mod.custom_theme.bundled_theme_path(preset_id, mod.ROOT)
    except ValueError as error:
        studio_obj.message = "Theme not applied: " + str(error)
        _emit(studio_obj, False)
        if callback: callback(None, str(error))
        return
    _call(studio_obj, "_load_custom_theme", load_custom_theme, path, mode="preset", preset_id=preset_id, callback=callback)

def select_saved_theme(studio_obj, entry_id: str) -> None:
    if not any(item["id"] == entry_id for item in studio_obj.session.saved_themes): return
    path = studio_obj.data / "themes" / f"{entry_id}.json"
    if not path.is_file():
        studio_obj.message = "Saved theme is unavailable."
        _emit(studio_obj, False)
        return
    _call(studio_obj, "_load_custom_theme", load_custom_theme, path, mode="saved", entry_id=entry_id)

def delete_saved_theme(studio_obj, entry_id: str) -> None:
    session = studio_obj.session
    entry = next((item for item in session.saved_themes if item["id"] == entry_id), None)
    if entry is None: return
    session.saved_themes = [item for item in session.saved_themes if item["id"] != entry_id]
    (studio_obj.data / "themes" / f"{entry_id}.json").unlink(missing_ok=True)
    if session.active_theme_kind == "saved" and session.active_theme_id == entry_id:
        _reset_builtin_theme_state(studio_obj)
    try: _call(studio_obj, "_save_theme_library", save_theme_library)
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
        _call(studio_obj, "_load_custom_theme", load_custom_theme, cached, mode="restore", follow_source=source, clear_overrides_on_follow=True)
    elif source.is_file():
        _call(studio_obj, "_load_custom_theme", load_custom_theme, source, mode="reload")

def load_custom_theme(studio_obj, path, mode: str = "import", follow_source=None, preset_id: str = "", entry_id: str = "", callback=None, clear_overrides_on_follow: bool = False) -> None:
    mod = _studio_module()
    session = studio_obj.session
    session.theme_epoch += 1
    epoch = session.theme_epoch
    engine_fn = getattr(studio_obj, "_engine", None)
    try: engine = engine_fn() if callable(engine_fn) else getattr(studio_obj, "engine", Path("unused-theme-engine"))
    except ValueError as error:
        studio_obj.message = str(error)
        _emit(studio_obj, False)
        if callback: callback(None, str(error))
        return

    def finished(value, error):
        if epoch != session.theme_epoch:
            if callback: callback(None, "Superseded by newer theme selection")
            return
        if error:
            studio_obj.message = "Theme not applied: " + str(error)
            _emit(studio_obj, False)
            if callback: callback(None, str(error))
            if follow_source: _call(studio_obj, "_load_custom_theme", load_custom_theme, follow_source, mode="reload" if clear_overrides_on_follow else "restore")
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
                _write_saved_theme_file(studio_obj, mod, existing["id"], value)
                _activate_theme_selection(studio_obj, mod, "saved", existing["id"], source_str)
            elif mode == "preset":
                _activate_theme_selection(studio_obj, mod, "preset", preset_id, "")
            elif mode == "saved":
                entry = next((item for item in session.saved_themes if item["id"] == entry_id), None)
                source_str = entry.get("source", "") if entry else ""
                if entry is not None: entry["name"] = value["name"]
                _activate_theme_selection(studio_obj, mod, "saved", entry_id, source_str)
            elif mode == "reload" and session.active_theme_kind == "saved" and session.active_theme_id:
                _write_saved_theme_file(studio_obj, mod, session.active_theme_id, value)
                entry = next((item for item in session.saved_themes if item["id"] == session.active_theme_id), None)
                if entry is not None: entry["name"] = value["name"]
                save_library = True
            if mode in ("import", "preset", "saved") or changed:
                mod.atomic_json(studio_obj.data / "theme.json", value)
            if save_library: _call(studio_obj, "_save_theme_library", save_theme_library)
            if mode in ("import", "preset", "saved", "reload"):
                _call(studio_obj, "_clear_theme_background_overrides", clear_theme_background_overrides)
            session.custom_theme = value
            if changed: session.theme_revision += 1
            for window in session.windows.values(): _call(window, "_watch_custom_theme", watch_custom_theme)
            if mode in ("import", "preset", "saved", "reload") or (mode != "restore" and changed):
                studio_obj.message = "Applied " + value["name"]
            if hasattr(session, "changed"): session.changed.emit()
            if callback: callback({"id": preset_id or entry_id or session.active_theme_id, "name": value["name"]}, "")
        except OSError as failure:
            studio_obj.message = "Could not save theme: " + str(failure)
            _emit(studio_obj, False)
            if callback: callback(None, str(failure))
        if follow_source: _call(studio_obj, "_load_custom_theme", load_custom_theme, follow_source, mode="reload" if clear_overrides_on_follow else "restore")

    def read():
        try: return mod.custom_theme.read(engine, path), None
        except Exception as failure: return None, str(failure)

    _submit(studio_obj, read, lambda result, error: finished(*(result or (None, error))), False)

def reset_custom_theme(studio_obj) -> None:
    _reset_builtin_theme_state(studio_obj)
    try: _call(studio_obj, "_save_theme_library", save_theme_library)
    except OSError: pass
    if hasattr(studio_obj.session, "changed"): studio_obj.session.changed.emit()

def edit_custom_theme(studio_obj) -> None:
    session = studio_obj.session
    if session.active_theme_kind == "preset" or not session.theme_source: return
    mod = _studio_module()
    source = Path(session.theme_source)
    if source.is_file(): mod.QDesktopServices.openUrl(mod.QUrl.fromLocalFile(str(source)))

def export_custom_theme(studio_obj, value: str) -> None:
    mod = _studio_module()
    try:
        mod.atomic_json(mod.local_path(value), mod.custom_theme.for_sharing(studio_obj.session.custom_theme))
        studio_obj.message = "Theme exported. Edit the JSON and import it to apply."
    except OSError as error:
        studio_obj.message = str(error)
    _emit(studio_obj, False)

def set_note_location(studio_obj, value: str) -> None:
    directory = _studio_module().local_path(value)
    if directory.is_dir():
        studio_obj.settings["newNoteLocation"] = str(directory)
        _preferences(studio_obj)
        _emit(studio_obj, False)

def import_font(studio_obj, value: str) -> None:
    mod = _studio_module()
    try:
        family = studio_obj.session.font_store.import_file(mod.local_path(value))
        studio_obj.settings["font"] = family
        studio_obj.message = "Imported " + family + " for reading and PDF export"
        _preferences(studio_obj)
        _emit(studio_obj)
    except (OSError, ValueError) as error:
        studio_obj.message = str(error)
        _emit(studio_obj, False)

def brand(studio_obj) -> str:
    colors = _call(studio_obj, "_colors", colors_for)
    svg = studio_obj._brand_svg.replace("#16181d", colors["text"]).replace("#f4f4f1", colors["surface"])
    return "data:image/svg+xml;base64," + base64.b64encode(svg.encode()).decode()

def set_mode(studio_obj, mode: str) -> None:
    if mode in ("live", "reader", "editor", "split") and mode != getattr(studio_obj, "mode", None):
        if callable(flush := getattr(studio_obj, "_flush", None)): flush("mode", mode)
        else: apply_mode(studio_obj, mode)

def apply_mode(studio_obj, mode: str) -> None:
    studio_obj.mode = mode
    studio_obj.settings["readingMode"] = mode
    if (timer := getattr(studio_obj, "preference_timer", None)) is not None: timer.start(500)
    _emit(studio_obj)

def set_fullscreen(studio_obj, value: bool) -> None:
    if value == studio_obj.fullscreen: return
    if value: studio_obj.settings["fullZoom"] = studio_obj.settings["normalZoom"]
    studio_obj.fullscreen = value
    _emit(studio_obj)

def set_zoom(studio_obj, value: float) -> None:
    mod = _studio_module()
    zoom = max(40, min(300, round(value)))
    studio_obj.settings["fullZoom" if getattr(studio_obj, "fullscreen", False) else "normalZoom"] = zoom
    studio_obj.readerCall.emit(f"window.supermdSetZoom?.({zoom},{int(mod.time.time() * 1000)})")
    if (timer := getattr(studio_obj, "preference_timer", None)) is not None: timer.start(500)
    _emit(studio_obj, False)

def _is_finite_number(value) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)

def setting(studio_obj, key: str, encoded: str) -> None:
    mod = _studio_module()
    if key not in mod.DEFAULTS or key in ("window", "widthMigrated"): return
    try: value = json.loads(encoded)
    except ValueError: return
    if key in ("theme", "fullTheme") and value not in ("system", "light", "dark", "black"): return
    if key == "accent" and value not in ("system", "blue", "green", "violet", "rose", "amber"): return
    if key == "startup" and value not in ("restore", "new"): return
    if key == "selectionAssistant" and (not isinstance(value, str) or value not in mod.ASSISTANTS): return
    if key == "patternKind" and value not in ("", "none", "paws", "dots", "grid", "diagonal", "gradient"): return
    if key in ("patternOpacity", "patternSize", "patternSpacing"):
        if not _is_finite_number(value): return
        default, low, high = {"patternOpacity": (-1, 0, 0.25), "patternSize": (0, 8, 64), "patternSpacing": (0, 12, 192)}[key]
        if value != default and not low <= value <= high: return
    if key in ("imageAppearance", "svgAppearance") and value not in ("original", "invert-dark", "auto", "monochrome", "contrast"): return
    if key in _BOOL_SETTINGS and not isinstance(value, bool): return
    if key == "imageContrast" and (not _is_finite_number(value) or not 1 <= value <= 2): return
    if key in ("font", "python") and (not isinstance(value, str) or not value.strip() or len(value) > 2048): return
    if key == "python":
        try: value = mod.python_runtime.validate(value.strip())
        except ValueError as error:
            studio_obj.python_status = str(error)
            _emit(studio_obj, False)
            return
        studio_obj.python_status = ""
    if key in _FINITE_SETTINGS and not _is_finite_number(value): return
    if key == "pdf" and (not isinstance(value, dict) or set(value) != set(mod.DEFAULT_PDF)): return
    if key == "shortcuts":
        value, error = mod.normalize_shortcuts(value)
        if error: return
    if key == "size": value = max(6, min(32, float(value)))
    elif key == "width": value = max(0, min(5000, int(value)))
    elif key == "widthPercent": value = max(50, min(150, float(value)))
    elif key == "lineHeight": value = max(1.15, min(2.2, float(value)))
    studio_obj.settings[key] = value
    if key == "shortcuts": _call(studio_obj, "_notify_shortcuts", notify_shortcuts)
    _preferences(studio_obj)
    _emit(studio_obj)

def notify_message(studio_obj, text: str) -> None:
    studio_obj.message = str(text or "")
    _emit(studio_obj, False)

def default_theme_export_location(studio_obj, name: str):
    mod = _studio_module()
    leaf = mod.folder_ops._pure_path(str(name or "")).name or "My theme.supermd-theme.json"
    if callable(out_dir_fn := getattr(studio_obj, "_default_output_directory", None)):
        base_dir = out_dir_fn()
    else:
        raw = studio_obj.settings.get("newNoteLocation") or QStandardPaths.writableLocation(QStandardPaths.StandardLocation.DownloadLocation) or str(Path.home())
        base_dir = Path(mod.folder_ops.strip_extended_length_prefix(str(raw or "").strip()) or str(Path.home())).expanduser()
    return mod.QUrl.fromLocalFile(str(base_dir / leaf))
