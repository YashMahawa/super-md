"""Unified note save, conflict detection, renderer flush, and native .smd save/export helpers for Studio."""
from __future__ import annotations

import hashlib, json, os, sys, uuid
from contextlib import suppress
from pathlib import Path
from typing import Any, Callable
from PySide6.QtCore import QStandardPaths, QUrl

try:
    from . import folder_ops
except ImportError:
    import folder_ops

AUTOSAVE_CONFLICT_MESSAGE = (
    "Autosave paused: this file changed outside Super MD. "
    "Your edits remain in draft recovery; use Save as to keep both versions."
)
MANUAL_CONFLICT_MESSAGE = "This file changed on disk since you opened or last saved it."
AGENT_CONFLICT_MESSAGE = (
    "This file changed outside Super MD. Your edits remain in draft recovery; use save-as to keep both versions."
)

def _studio_module():
    module = sys.modules.get("studio") or sys.modules.get("desktop.studio")
    if module is not None: return module
    try:
        from . import studio as module
    except ImportError:
        import studio as module
    return module

def _call_method(studio_obj: Any, name: str, fallback: Callable[..., Any], *args: Any, **kwargs: Any) -> Any:
    fn = getattr(studio_obj, name, None)
    return fn(*args, **kwargs) if callable(fn) else fallback(studio_obj, *args, **kwargs)

def _current_tab(studio_obj: Any) -> dict:
    fn = getattr(studio_obj, "_current", None)
    return fn() if callable(fn) else next((t for t in studio_obj.tabs if t["id"] == studio_obj.active), studio_obj.tabs[0])

def _is_tab_dirty(studio_obj: Any, tab: dict) -> bool:
    fn = getattr(studio_obj, "_is_dirty", None)
    return bool(fn(tab)) if callable(fn) else bool(_studio_module().Studio._is_dirty(studio_obj, tab))

def _preserve_unchanged_assets(old_assets: dict[str, str], new_assets: dict[str, str]) -> dict[str, str]:
    """Keep existing Python string identities for unchanged data URLs so ReaderAssetStore grants stay valid."""
    return {k: old_assets[k] if old_assets.get(k) == v else v for k, v in new_assets.items()}

def export_destination(value: str, format: str) -> Path:
    suffixes = {"pdf": ".pdf", "smd": ".smd", "md": ".md", "mdzip": ".zip"}
    # Known payload extensions; legacy .fmd must not be silently rewritten as .fmd.pdf/.fmd.smd.
    payload_formats = {".pdf": "pdf", ".smd": "smd", ".md": "md", ".markdown": "md", ".txt": "md", ".zip": "mdzip"}
    if format not in suffixes: raise ValueError("Unsupported export format")
    destination = _studio_module().local_path(value)
    if not destination.name or destination.is_dir(): raise ValueError("Choose a file destination for the export")
    expected, existing_suffix = suffixes[format], destination.suffix.casefold()
    if existing_suffix == ".fmd":
        raise ValueError("Legacy .fmd files are not a supported export destination; choose .smd or a new filename")
    if existing_suffix in payload_formats:
        if payload_formats[existing_suffix] != format:
            raise ValueError(f"Choose a filename ending in {expected} for this export")
        return destination
    target = destination.with_name(destination.name + expected)
    if target.exists():
        raise ValueError(f"The {expected} destination already exists; choose its full filename to confirm replacement")
    return target

def _has_disk_conflict(path: Path, expected_content: str, expected_assets: dict[str, str], *,
                       check_assets: bool = True, decode_assets: bool = False,
                       expected_portable: bool | None = None, missing_is_conflict: bool = False,
                       catch_errors: bool = True) -> bool:
    if not path.exists(): return missing_is_conflict
    studio_mod = _studio_module()
    try:
        disk_content, disk_assets, disk_portable = (
            studio_mod.open_note(path) if decode_assets else studio_mod.open_note(path, decode_assets=False)
        )
    except Exception:
        if catch_errors: return True
        raise
    return (disk_content != expected_content or (check_assets and disk_assets != expected_assets)
            or (expected_portable is not None and disk_portable != expected_portable))

def _write_note_and_stat(path: Path, content: str, assets: dict[str, str], *, portable: bool,
                         validated_assets: dict[str, str] | None = None) -> tuple[int, int] | None:
    studio_mod = _studio_module()
    if portable:
        if validated_assets is not None:
            studio_mod.write_portable(path, content, assets, validated_assets=validated_assets)
        else:
            studio_mod.write_portable(path, content, assets)
    else:
        studio_mod.materialize_assets(path.parent, assets)
        studio_mod.atomic_write(path, content.encode("utf-8"))
    with suppress(OSError):
        st = path.stat()
        return (st.st_mtime_ns, st.st_size)
    return None

def _record_file_stamp(studio_obj: Any, path: Path | str | None, stamp: tuple[int, int] | None) -> None:
    stamps = getattr(studio_obj, "note_file_stamps", None)
    if stamp and path and isinstance(stamps, dict): stamps[str(path)] = stamp

def _report_ui_save_conflict(studio_obj: Any, target: dict | None, *, automatic: bool = False,
                             message: str | None = None, emit_when_missing: bool = False) -> None:
    if target is not None: target["conflict"] = True
    if target is not None or emit_when_missing:
        studio_obj.message = message or (AUTOSAVE_CONFLICT_MESSAGE if automatic else MANUAL_CONFLICT_MESSAGE)
        studio_obj._emit(False)
    if not automatic and target is not None: studio_obj.saveConflictRequested.emit(target["name"])

def _refresh_open_folder_trees(studio_obj: Any, *candidates: Any) -> None:
    _call_method(studio_obj, "_refresh_open_folder_trees", _studio_module().Studio._refresh_open_folder_trees, *candidates)

def _commit_saved_tab_state(studio_obj: Any, target: dict | None, *, new_path: str | None = None,
                            saved_content: str, saved_assets: dict[str, str], portable: bool | None = None,
                            new_content: str | None = None, new_assets: dict[str, str] | None = None,
                            path_changed: bool = False, update_recent: bool = False,
                            restart_autosave: bool = False, ui_message: str | None = None,
                            refresh_trees: tuple[Any, ...] = (), finish_pending_close: bool = False) -> bool:
    is_dirty = False
    if target is not None:
        target.update({
            "saved": saved_content, "saved_assets": dict(saved_assets), "assets_dirty": False, "conflict": False,
            **({"path": new_path, "name": Path(new_path).name} if new_path is not None else {}),
            **({"content": new_content} if new_content is not None else {}),
            **({"assets": new_assets} if new_assets is not None else {}),
            **({"portable": portable} if portable is not None else {}),
        })
        if update_recent and new_path:
            studio_obj.recent = [new_path] + [p for p in studio_obj.recent if p != new_path][:29]
            studio_obj._preferences()
        is_dirty = _is_tab_dirty(studio_obj, target)
        if restart_autosave and is_dirty and hasattr(studio_obj, "autosave_timer"):
            studio_obj.autosave_timer.start(900)
    effective_path = new_path or (target.get("path") if target is not None else None)
    open_paths = getattr(studio_obj, "_agent_open_paths", None)
    if effective_path and isinstance(open_paths, set) and (target is not None or ui_message is None):
        with suppress(OSError): open_paths.add(str(Path(effective_path).resolve()))
    workspace_links = getattr(getattr(studio_obj, "session", None), "workspace_links", None)
    if path_changed and new_path and workspace_links is not None and (target is not None or ui_message is None):
        workspace_links.invalidate(Path(new_path).parent)
    if ui_message is not None: studio_obj.message = ui_message
    if hasattr(studio_obj, "_recover"): studio_obj._recover()
    if hasattr(studio_obj, "_emit"): studio_obj._emit()
    if refresh_trees: _refresh_open_folder_trees(studio_obj, *refresh_trees)
    if finish_pending_close and getattr(studio_obj, "pending_close", ""): studio_obj._finish_close()
    return is_dirty

def save(studio_obj: Any) -> None:
    if studio_obj.tabs: _call_method(studio_obj, "_save_current", save_current, False)

def save_current(studio_obj: Any, force_overwrite: bool = False) -> None:
    if not studio_obj.tabs: return
    tab = _current_tab(studio_obj)
    if not tab["path"]:
        studio_obj.saveRequested.emit(tab["name"])
    elif not force_overwrite and tab.get("conflict"):
        studio_obj.saveConflictRequested.emit(tab["name"])
    elif tab["portable"] and studio_obj.ready:
        (studio_obj._force_overwrite_ids.add if force_overwrite else studio_obj._force_overwrite_ids.discard)(tab["id"])
        studio_obj.readerCall.emit("window.supermdPortable?.(true)")
    else:
        _call_method(studio_obj, "_save_text", save_text, tab, Path(tab["path"]),
                     automatic=False, force_overwrite=force_overwrite, force_portable=bool(tab["portable"]))

def after_flush(studio_obj: Any, operation: dict) -> None:
    action = operation["action"]
    if action == "save": _call_method(studio_obj, "save", save)
    elif action == "save_as":
        if studio_obj.tabs: studio_obj.saveAsRequested.emit(_current_tab(studio_obj)["name"])
    elif action == "overwrite_conflict": _call_method(studio_obj, "_save_current", save_current, True)
    elif action == "sync_for_search":
        if studio_obj._folder_search_open and studio_obj._folder_search_query.strip():
            current_sig = [(t["id"], t["content"], _is_tab_dirty(studio_obj, t)) for t in studio_obj.tabs]
            if current_sig != studio_obj._folder_search_tabs_sig: studio_obj._start_folder_search()
            else: studio_obj.workspaceSearchChanged.emit()
    elif action == "open_search_match":
        request = json.loads(operation["target"])
        tab_id, path, query = request.get("tabId") or "", request.get("path") or "", request.get("query") or ""
        case_sensitive = bool(request.get("caseSensitive", False))
        existing = next((t for t in studio_obj.tabs if tab_id and t["id"] == tab_id), None)
        if existing is None and path:
            resolved = os.path.normcase(str(Path(path).resolve(strict=False)))
            existing = next((t for t in studio_obj.tabs if t.get("path") and os.path.normcase(str(Path(t["path"]).resolve(strict=False))) == resolved), None)
        if existing is not None:
            if existing["id"] == studio_obj.active and studio_obj.ready:
                studio_obj._pending_seeded_find = None
                if query: studio_obj.readerCall.emit(f"window.supermdFind?.({json.dumps(query)}, {json.dumps({'caseSensitive': case_sensitive})})")
                studio_obj._focus_open_target(studio_obj._activation_generation)
            else:
                studio_obj._pending_seeded_find = {"tabId": existing["id"], "path": existing.get("path") or "", "query": query, "caseSensitive": case_sensitive} if query else None
                studio_obj.selectTab(existing["id"])
                studio_obj._focus_open_target(studio_obj._activation_generation)
        elif path:
            local = str(_studio_module().local_path(path))
            studio_obj._pending_seeded_find = {"tabId": "", "path": local, "query": query, "caseSensitive": case_sensitive} if query else None
            def opened(_note, error):
                if error and studio_obj._pending_seeded_find and studio_obj._pending_seeded_find.get("path") == local:
                    studio_obj._pending_seeded_find = None
            studio_obj._open_note(local, explicit=True, completion_callback=opened)
    elif action == "reload_reader":
        studio_obj.ready = False
        studio_obj._last_reader_text = None
        studio_obj.reader_overlay = studio_obj.image_overlay = False
        studio_obj._emit(False)
        studio_obj.readerReloadRequested.emit()
    elif action == "mode": studio_obj._apply_mode(operation["target"])
    elif action == "move_tab":
        request = json.loads(operation["target"])
        target = studio_obj.session.windows.get(request["window"])
        if target: studio_obj._move_tab(target, request["tab"], request["index"])
    elif action == "detach_tab":
        if studio_obj._can_move(): studio_obj.detachedWindowRequested.emit(studio_obj.window_id, operation["target"])
    elif action == "close_tab": studio_obj.closeTab(operation["target"])
    elif action == "close_window" and studio_obj.requestWindowClose():
        studio_obj._recover()
        _studio_module().QTimer.singleShot(0, studio_obj.allowClose.emit)

def on_flush_timeout(studio_obj: Any) -> None:
    if studio_obj.flush_operation and studio_obj.flush_operation.get("action") == "sync_for_search":
        studio_obj.flush_operation = None
        studio_obj.workspaceSearchChanged.emit()
        return
    studio_obj.flushFailed.emit(bool(studio_obj.flush_operation and studio_obj.flush_operation["action"] == "close_window"))

def flush(studio_obj: Any, action: str, target: str = "") -> None:
    if studio_obj.retired or (action == "close_window" and studio_obj.pending_close): return
    operation = {"action": action, "target": target, "token": uuid.uuid4().hex}
    if not studio_obj.ready or not studio_obj.tabs:
        _call_method(studio_obj, "_after_flush", after_flush, operation)
        return
    if studio_obj.flush_operation and (studio_obj.flush_operation.get("action") != "sync_for_search" or action == "sync_for_search"):
        return
    studio_obj.flush_operation = operation
    studio_obj.flush_timer.start(5000)
    studio_obj.readerCall.emit(f"window.supermdFlush?.({json.dumps(operation)})")

def save_safely(studio_obj: Any) -> None: _call_method(studio_obj, "_flush", flush, "save")
def save_as_safely(studio_obj: Any) -> None: _call_method(studio_obj, "_flush", flush, "save_as")

def reload_reader_safely(studio_obj: Any) -> None:
    if studio_obj.ready and not studio_obj.retired and not studio_obj.busy and not studio_obj.flush_operation:
        _call_method(studio_obj, "_flush", flush, "reload_reader")

def close_tab_safely(studio_obj: Any, tab_id: str) -> None: _call_method(studio_obj, "_flush", flush, "close_tab", tab_id)
def close_window_safely(studio_obj: Any) -> None: _call_method(studio_obj, "_flush", flush, "close_window")

def resolve_flush(studio_obj: Any, choice: str) -> None:
    operation, studio_obj.flush_operation = studio_obj.flush_operation, None
    studio_obj.flush_timer.stop()
    if not operation: return
    if choice == "retry": _call_method(studio_obj, "_flush", flush, operation["action"], operation["target"])
    elif choice == "recover_close" and operation["action"] == "close_window":
        studio_obj._recover()
        studio_obj.allowClose.emit()

def save_as(studio_obj: Any, value: str) -> None:
    path, tab = _studio_module().local_path(value), _current_tab(studio_obj)
    if path.suffix.lower() == ".smd" and studio_obj.ready:
        studio_obj.pending_export = studio_obj.pending_save_as = str(path)
        studio_obj.pending_save_as_tab = tab["id"]
        studio_obj.readerCall.emit("window.supermdPortable?.(false)")
    else:
        _call_method(studio_obj, "_save_text", save_text, tab, path,
                     automatic=False, force_overwrite=True, force_portable=path.suffix.lower() == ".smd")

def resolve_conflict(studio_obj: Any, choice: str) -> None:
    if choice == "cancel": studio_obj.pending_close = ""
    elif choice == "save_as": _call_method(studio_obj, "saveAsSafely", save_as_safely)
    elif choice == "overwrite": _call_method(studio_obj, "_flush", flush, "overwrite_conflict")
    elif choice == "reload":
        tab = _current_tab(studio_obj)
        if not tab.get("path"): return
        tab_id, path = tab["id"], Path(tab["path"])
        def done(result, error):
            if error: return
            target = next((t for t in studio_obj.tabs if t["id"] == tab_id), None)
            if not target: return
            content, assets, portable = result
            with suppress(OSError):
                st = path.stat()
                _record_file_stamp(studio_obj, path, (st.st_mtime_ns, st.st_size))
            studio_obj.reader_edits.clear(tab_id)
            studio_obj.session.reader_assets.revoke_tab(studio_obj.window_id, tab_id)
            if tab_id == studio_obj.active: studio_obj._last_reader_text = None
            target.update(content=content, saved=content, assets=assets, saved_assets=dict(assets),
                          assets_dirty=False, portable=portable, conflict=False)
            studio_obj.message = "Reloaded note from disk"
            studio_obj._recover()
            studio_obj._emit(load=tab_id == studio_obj.active)
        studio_obj._submit(lambda: _studio_module().open_note(path), done, True)

def save_text(studio_obj: Any, tab: dict, path: Path, automatic: bool = False,
              force_overwrite: bool = False, force_portable: bool = False) -> None:
    tab_id, content, assets = tab["id"], tab["content"], dict(tab["assets"])
    expected, original_path = tab["saved"], tab["path"]
    expected_assets = dict(tab.get("saved_assets", {}))
    try: same_path = bool(original_path) and Path(path).resolve() == Path(original_path).resolve()
    except OSError: same_path = str(path) == original_path
    portable = bool(force_portable or path.suffix.lower() == ".smd" or (tab["portable"] and same_path))
    if tab_id in studio_obj.saving: return
    studio_obj.saving.add(tab_id)
    def finished(outcome, error):
        studio_obj.saving.discard(tab_id)
        if error: return
        target = next((t for t in studio_obj.tabs if t["id"] == tab_id), None)
        if isinstance(outcome, dict) and outcome.get("_conflict"):
            _report_ui_save_conflict(studio_obj, target, automatic=automatic,
                                     message=outcome["message"] if automatic else MANUAL_CONFLICT_MESSAGE,
                                     emit_when_missing=True)
            return
        _record_file_stamp(studio_obj, path, outcome.get("stamp") if isinstance(outcome, dict) else None)
        path_changed = bool(target is not None and str(path) != original_path)
        _commit_saved_tab_state(
            studio_obj, target, new_path=str(path), saved_content=content, saved_assets=assets, portable=portable,
            path_changed=path_changed, update_recent=path_changed, restart_autosave=bool(automatic),
            ui_message="Autosaved" if automatic else "Saved",
            refresh_trees=(path, original_path) if str(path) != original_path else (), finish_pending_close=True,
        )
    def write():
        if (automatic or (not force_overwrite and same_path)) and _has_disk_conflict(
            path, expected, expected_assets, check_assets=portable, decode_assets=False,
            missing_is_conflict=bool(automatic),
        ):
            return {"_conflict": True, "message": AUTOSAVE_CONFLICT_MESSAGE}
        stamp = _write_note_and_stat(path, content, assets, portable=portable,
                                     validated_assets=expected_assets if portable else None)
        return {"stamp": stamp} if stamp is not None else {}
    studio_obj._submit(write, finished, busy=not automatic, executor=studio_obj.writes)

def autosave(studio_obj: Any) -> None:
    if not studio_obj.settings["autosave"]: return
    for tab in studio_obj.tabs:
        if tab["path"] and _is_tab_dirty(studio_obj, tab) and not tab.get("conflict") and tab["id"] not in studio_obj.saving:
            _call_method(studio_obj, "_save_text", save_text, tab, Path(tab["path"]), automatic=True)

def _output_dir(studio_obj: Any, method_name: str) -> Path:
    fn = getattr(studio_obj, method_name, None)
    if callable(fn): return Path(fn())
    settings = getattr(studio_obj, "settings", None)
    configured = settings.get("newNoteLocation") if isinstance(settings, dict) else ""
    raw = configured or QStandardPaths.writableLocation(QStandardPaths.StandardLocation.DownloadLocation) or str(Path.home())
    return Path(folder_ops.strip_extended_length_prefix(str(raw or "").strip()) or str(Path.home())).expanduser()

def default_save_location(studio_obj: Any, name: str) -> QUrl:
    leaf = folder_ops._pure_path(str(name or "")).name or "Untitled.md"
    return QUrl.fromLocalFile(str(_output_dir(studio_obj, "_note_save_directory") / leaf))

def default_save_as_location(studio_obj: Any, name: str) -> QUrl:
    leaf = folder_ops._pure_path(str(name or "")).name or "Untitled.md"
    fn = getattr(studio_obj, "_save_as_directory", None)
    if callable(fn): directory = Path(fn())
    else:
        cur_path = _current_tab(studio_obj).get("path") if getattr(studio_obj, "tabs", None) else ""
        parent = Path(cur_path).parent if cur_path else None
        directory = parent if parent is not None and parent.is_dir() else _output_dir(studio_obj, "_default_output_directory")
    return QUrl.fromLocalFile(str(directory / leaf))

def default_export_location(studio_obj: Any, format: str) -> QUrl:
    suffix = "zip" if format == "mdzip" else format
    filename = (folder_ops.note_stem(_current_tab(studio_obj)["name"]) or "Untitled") + "." + suffix
    return QUrl.fromLocalFile(str(_output_dir(studio_obj, "_default_output_directory") / folder_ops._pure_path(filename).name))

def export_to(studio_obj: Any, value: str, format: str) -> None:
    if studio_obj.pending_export:
        studio_obj.message = "An export is already in progress; finish or cancel it before choosing another destination"
        studio_obj._emit(False)
        return
    studio_obj.pending_save_as = studio_obj.pending_export = ""
    try: studio_obj.pending_export = str(_studio_module().export_destination(value, format))
    except ValueError as error:
        studio_obj.message = str(error)
        studio_obj._emit(False)
        return
    if format in ("md", "mdzip"): studio_obj.readerCall.emit(f"window.supermdExportMarkdown?.({str(format == 'mdzip').lower()})")
    elif format == "smd": studio_obj.readerCall.emit("window.supermdPortable?.(false)")
    else: studio_obj.readerCall.emit(f"window.supermdExport?.({json.dumps(studio_obj.settings['pdf'])})")

def run_prepared_write_sync(studio: Any, prepared: tuple) -> Any:
    tab_id, work, finalize, _abort = prepared
    saving = getattr(studio, "saving", None)
    if saving is not None: saving.add(tab_id)
    try: value = work()
    except Exception as error:
        if saving is not None: saving.discard(tab_id)
        finalize(None, str(error))
        raise
    if saving is not None: saving.discard(tab_id)
    return finalize(value, None)

def agent_document_action_async(studio_obj: Any, args: dict, on_complete: Callable[[Any, str | None], None]) -> None:
    action, studio_cls = args.get("action"), _studio_module().Studio
    if action == "save_document": prepared = studio_cls._prepare_save_document(studio_obj, args)
    elif action == "replace_tab_asset": prepared = studio_cls._prepare_replace_tab_asset(studio_obj, args)
    elif action == "asset_action" and args.get("assetAction") == "attach": prepared = studio_cls._prepare_attach_tab_asset(studio_obj, args)
    else:
        on_complete(studio_obj._agent_document_action(args), None)
        return
    tab_id, work, finalize, abort = prepared
    if studio_obj.retired or getattr(studio_obj.writes, "_shutdown", False):
        abort()
        raise ValueError("The target desktop window was closed")
    studio_obj.saving.add(tab_id)
    def handle_done(value, error):
        studio_obj.saving.discard(tab_id)
        if error is not None:
            finalize(None, error)
            on_complete(None, error)
            return
        try: result = finalize(value, None)
        except Exception as failure:
            on_complete(None, str(failure))
            return
        on_complete(result, None)
    def handle_retired():
        studio_obj.saving.discard(tab_id)
        finalize(None, "The target desktop window was closed")
        on_complete(None, "The target desktop window was closed")
    if not studio_obj._submit_write(work, handle_done, on_retired=handle_retired): abort()

def prepare_save_document(studio_obj: Any, args: dict) -> tuple:
    tab_id = args.get("tabId")
    tab = next((item for item in studio_obj.tabs if item["id"] == tab_id), None)
    if not tab: raise ValueError("Save requires a target tab that is still open")
    saving = getattr(studio_obj, "saving", None)
    if saving is not None and tab_id in saving:
        raise ValueError("A save is already in progress for this tab; retry after it finishes")
    content_snapshot = tab["content"]
    revision = hashlib.sha256(content_snapshot.encode("utf-8")).hexdigest()
    if args.get("expectedRevision") != revision:
        raise ValueError("Live tab revision changed; inspect it again before saving")
    requested_format = args.get("format")
    current_format = "smd" if tab.get("portable") or Path(tab.get("path") or tab["name"]).suffix.lower() == ".smd" else "md"
    filename_suffix = Path(args.get("filename", "")).suffix.lower() if isinstance(args.get("filename", ""), str) else ""
    filename_format = "smd" if filename_suffix == ".smd" else "md" if filename_suffix in (".md", ".markdown") else None
    fmt = requested_format or (filename_format if args.get("saveAs") or args.get("filename") else None) or current_format
    if fmt not in ("md", "smd"): raise ValueError("Save format must be md or smd")
    old_path = tab["path"]
    try: old_canonical_path = str(Path(old_path).resolve(strict=True)) if old_path else ""
    except (OSError, RuntimeError): old_canonical_path = ""
    save_as_flag = bool(args.get("saveAs", False)) or bool(args.get("filename"))
    if not isinstance(args.get("saveAs", False), bool): raise ValueError("saveAs must be a boolean")
    same_format = tab.get("path") and current_format == fmt
    saved_snapshot, assets_snapshot = tab["saved"], dict(tab.get("assets", {}))
    saved_assets_snapshot, portable_snapshot = dict(tab.get("saved_assets", assets_snapshot)), bool(tab.get("portable"))
    created_new_path, reservation_identity = False, None
    if old_path and not save_as_flag and same_format and fmt == current_format:
        path = Path(old_path)
        if not path.is_file(): raise ValueError("The saved file is no longer available; use save-as to create a new copy")
    else:
        if old_path and not save_as_flag:
            raise ValueError("Saving in another format requires saveAs:true and a new filename")
        path = studio_obj._agent_export_path(args.get("filename", ""), fmt, tab)
        studio_obj._agent_owned_files.add(str(path.resolve()))
        created_new_path = True
        reservation_stat = path.stat(follow_symlinks=False)
        reservation_identity = (reservation_stat.st_dev, reservation_stat.st_ino)
    resolved_path = path.resolve()
    def unlink_reserved():
        if not created_new_path: return
        with suppress(OSError):
            current_stat = resolved_path.stat(follow_symlinks=False)
            if (reservation_identity == (current_stat.st_dev, current_stat.st_ino)
                    and current_stat.st_size == 0 and not resolved_path.is_symlink()):
                resolved_path.unlink()
    def abort():
        unlink_reserved()
        if created_new_path: studio_obj._agent_owned_files.discard(str(resolved_path))
    def work():
        try:
            if not created_new_path:
                if not path.is_file():
                    raise ValueError("The saved file is no longer available; use save-as to create a new copy")
                if _has_disk_conflict(path, saved_snapshot, saved_assets_snapshot, check_assets=True,
                                      decode_assets=True, expected_portable=portable_snapshot, catch_errors=False):
                    raise ValueError(AGENT_CONFLICT_MESSAGE)
            return _write_note_and_stat(resolved_path, content_snapshot, assets_snapshot, portable=fmt == "smd")
        except Exception:
            unlink_reserved()
            raise
    def finalize(stamp, error):
        if error is not None:
            abort()
            return None
        _record_file_stamp(studio_obj, resolved_path, stamp)
        path_changed = not old_canonical_path or str(resolved_path) != old_canonical_path
        target = next((item for item in studio_obj.tabs if item["id"] == tab_id), None)
        is_dirty = _commit_saved_tab_state(
            studio_obj, target, new_path=str(resolved_path), saved_content=content_snapshot,
            saved_assets=assets_snapshot, portable=fmt == "smd", path_changed=path_changed,
            restart_autosave=bool(getattr(studio_obj, "settings", {}).get("autosave")),
            refresh_trees=(resolved_path, old_canonical_path or old_path) if path_changed else (),
        )
        return {"tabId": tab_id, "windowId": studio_obj.window_id, "path": str(resolved_path),
                "filename": resolved_path.name, "revision": revision, "format": fmt, "isDirty": is_dirty,
                "pathChanged": path_changed, "oldPath": old_canonical_path or old_path,
                "newPath": str(resolved_path)}
    return tab_id, work, finalize, abort

def execute_export_fmd_write(captured: dict, args: dict, output: str, *, force_overwrite: bool,
                             export_result: Callable[[Path], dict]) -> dict:
    is_save = bool(args.get("save"))
    target_path = Path(captured["path"]) if is_save else Path(output)
    if is_save and not force_overwrite and _has_disk_conflict(
        target_path, captured["saved"], captured.get("saved_assets", {}), check_assets=True, decode_assets=False
    ):
        return {"_conflict": True}
    stamp = _write_note_and_stat(target_path, args["content"], args["assets"], portable=True,
                                 validated_assets=captured.get("saved_assets") if is_save else None)
    result_data = export_result(target_path)
    if stamp is not None: result_data["_stamp"] = stamp
    return result_data

def finalize_export_fmd_result(studio_obj: Any, request_id: str, captured_id: str, args: dict, result: Any, *,
                               target: dict | None, save_as: str, save_as_tab: str) -> bool:
    if isinstance(result, dict) and result.get("_conflict"):
        _report_ui_save_conflict(studio_obj, target, automatic=False)
        studio_obj.replied.emit(request_id, json.dumps({"saved": False, "conflict": True}), "")
        return False
    stamp = result.pop("_stamp", None) if isinstance(result, dict) else None
    _record_file_stamp(studio_obj, result.get("path") if isinstance(result, dict) else None, stamp)
    reader_assets = getattr(getattr(studio_obj, "session", None), "reader_assets", None)
    if args.get("save") and target is not None:
        old_assets = target.get("assets", {})
        if old_assets != args["assets"] and reader_assets is not None:
            reader_assets.revoke_tab(studio_obj.window_id, target["id"])
        merged = _preserve_unchanged_assets(old_assets, args["assets"])
        unchanged = target["content"] == args["originalContent"]
        _commit_saved_tab_state(
            studio_obj, target, saved_content=args["content"] if unchanged else args["originalContent"],
            saved_assets=merged, new_content=args["content"] if unchanged else None, new_assets=merged,
            ui_message="Saved", finish_pending_close=True,
        )
    elif save_as:
        save_target = next((t for t in studio_obj.tabs if t["id"] == (save_as_tab or captured_id)), target)
        if save_target is not None:
            old_assets, path_changed = save_target.get("assets", {}), save_target.get("path") != save_as
            if (old_assets != args["assets"] or path_changed) and reader_assets is not None:
                reader_assets.revoke_tab(studio_obj.window_id, save_target["id"])
            merged = args["assets"] if path_changed else _preserve_unchanged_assets(old_assets, args["assets"])
            new_content = args["content"] if save_target["content"] == args.get("originalContent", save_target["content"]) else save_target["content"]
            _commit_saved_tab_state(
                studio_obj, save_target, new_path=save_as, saved_content=args["content"], saved_assets=merged,
                portable=True, new_content=new_content, new_assets=merged, path_changed=path_changed,
                update_recent=True, ui_message="Saved", refresh_trees=(save_as,) if path_changed else (), finish_pending_close=True,
            )
        studio_obj.pending_save_as = studio_obj.pending_save_as_tab = ""
    else: finalize_export_file(studio_obj, result["path"])
    return True

def finalize_export_file(studio_obj: Any, exported_path: str) -> None:
    name = Path(exported_path).name
    studio_obj.message = f"Exported {name}"
    if _studio_module().is_searchable_note_name(name): _refresh_open_folder_trees(studio_obj, exported_path)
