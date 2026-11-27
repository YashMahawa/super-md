"""Note save, flush, conflict resolution, Save As location, and agent save helpers for Studio."""
from __future__ import annotations

import hashlib, json, os, sys, uuid
from pathlib import Path

def _studio_module():
    if mod := (sys.modules.get("studio") or sys.modules.get("desktop.studio")):
        return mod
    if __package__: from . import studio as mod  # type: ignore[no-redef]
    else: import studio as mod  # type: ignore[no-redef]
    return mod

def preserve_unchanged_assets(old_assets: dict[str, str], new_assets: dict[str, str]) -> dict[str, str]:
    """Keep existing Python string identities for unchanged data URLs so ReaderAssetStore grants stay valid."""
    return {k: old_assets[k] if old_assets.get(k) == v else v for k, v in new_assets.items()}

def _has_disk_conflict(path: Path, expected_content: str, expected_assets: dict[str, str], *,
                       check_assets: bool, expected_portable: bool | None = None, missing_is_conflict: bool = False) -> bool:
    if not path.exists():
        return bool(missing_is_conflict)
    try:
        disk_content, disk_assets, disk_portable = _studio_module().open_note(path, decode_assets=expected_portable is not None)
    except Exception:
        if expected_portable is not None: raise
        return True
    return (disk_content != expected_content or (check_assets and disk_assets != expected_assets)
            or (expected_portable is not None and disk_portable != expected_portable))

def _write_note_and_stat(path: Path, content: str, assets: dict[str, str], *,
                         portable: bool, validated_assets: dict[str, str] | None = None) -> tuple[int, int] | None:
    mod = _studio_module()
    if portable:
        if validated_assets is not None: mod.write_portable(path, content, assets, validated_assets=validated_assets)
        else: mod.write_portable(path, content, assets)
    else:
        mod.materialize_assets(path.parent, assets)
        mod.atomic_write(path, content.encode("utf-8"))
    try:
        st = path.stat()
        return (st.st_mtime_ns, st.st_size)
    except OSError:
        return None

def _commit_saved_tab_state(
    studio_obj, target: dict | None, *, path: Path | None, saved_content: str, saved_assets: dict[str, str],
    portable: bool, stamp: tuple[int, int] | None = None, raw_path_str: str = "",
    updated_content: str | None = None, updated_assets: dict[str, str] | None = None,
    clear_staging: bool = True, add_open_path_when_missing_tab: bool = False,
    path_changed: bool = False, old_path: str = "", update_recent: bool = False,
    rearm_autosave: bool = False, message: str | None = None, finish_pending_close: bool = False,
) -> bool:
    studio_cls, path_str = _studio_module().Studio, raw_path_str or (str(path) if path is not None else "")
    if stamp and path_str and (stamps := getattr(studio_obj, "note_file_stamps", None)) is not None:
        stamps[path_str] = stamp
    is_dirty = False
    if target is not None:
        updates: dict[str, object] = {"saved": saved_content, "saved_assets": dict(saved_assets), "assets_dirty": False, "conflict": False}
        if path is not None: updates.update(path=path_str, name=path.name, portable=portable)
        if updated_content is not None: updates["content"] = updated_content
        if updated_assets is not None: updates["assets"] = updated_assets
        target.update(updates)
        if clear_staging:
            studio_cls._clear_agent_staging(studio_obj, target)
        session = getattr(studio_obj, "session", None)
        if path_changed and path is not None and session is not None and hasattr(session, "workspace_links"):
            session.workspace_links.invalidate(path.parent)
        if update_recent and path_str:
            studio_obj.recent = [path_str] + [p for p in studio_obj.recent if p != path_str][:29]
            studio_obj._preferences()
        dirty_fn = getattr(studio_obj, "_is_dirty", None)
        is_dirty = dirty_fn(target) if callable(dirty_fn) else studio_cls._is_dirty(studio_obj, target)
        if (rearm_autosave and is_dirty and not target.get("agent_staged")
                and target["id"] not in getattr(studio_obj, "_staging_tabs", ()) and hasattr(studio_obj, "autosave_timer")):
            studio_obj.autosave_timer.start(900)
    if (open_paths := getattr(studio_obj, "_agent_open_paths", None)) is not None and path is not None and (target is not None or add_open_path_when_missing_tab):
        try:
            open_paths.add(str(path.resolve()))
        except OSError:
            pass
    if message is not None:
        studio_obj.message = message
    studio_obj._recover()
    studio_obj._emit()
    if path_changed and path_str:
        candidates = (path if not raw_path_str and path is not None else path_str, old_path) if old_path else (path_str,)
        refresh_fn = getattr(studio_obj, "_refresh_open_folder_trees", None)
        refresh_fn(*candidates) if callable(refresh_fn) else studio_cls._refresh_open_folder_trees(studio_obj, *candidates)
    if finish_pending_close and getattr(studio_obj, "pending_close", ""):
        studio_obj._finish_close()
    return is_dirty

def save(studio_obj) -> None:
    if studio_obj.tabs:
        studio_obj._save_current(False)

def save_current(studio_obj, force_overwrite: bool = False) -> None:
    if not studio_obj.tabs:
        return
    tab = studio_obj._current()
    if not tab["path"]:
        studio_obj.saveRequested.emit(tab["name"])
    elif not force_overwrite and tab.get("conflict"):
        studio_obj.saveConflictRequested.emit(tab["name"])
    elif tab["portable"] and studio_obj.ready:
        (studio_obj._force_overwrite_ids.add if force_overwrite else studio_obj._force_overwrite_ids.discard)(tab["id"])
        studio_obj.readerCall.emit("window.supermdPortable?.(true)")
    else:
        studio_obj._save_text(tab, Path(tab["path"]), automatic=False, force_overwrite=force_overwrite, force_portable=bool(tab["portable"]))

def after_flush(studio_obj, operation: dict) -> None:
    mod, action = _studio_module(), operation["action"]
    if action == "save":
        studio_obj.save()
    elif action == "save_as":
        if studio_obj.tabs:
            studio_obj.saveAsRequested.emit(studio_obj._current()["name"])
    elif action == "overwrite_conflict":
        studio_obj._save_current(True)
    elif action == "reload_conflict":
        studio_obj._reload_current_from_disk()
    elif action == "sync_for_search":
        if studio_obj._folder_search_open and studio_obj._folder_search_query.strip():
            current_sig = [(t["id"], t["content"], studio_obj._is_dirty(t)) for t in studio_obj.tabs]
            (studio_obj._start_folder_search if current_sig != studio_obj._folder_search_tabs_sig else studio_obj.workspaceSearchChanged.emit)()
    elif action == "open_search_match":
        request = json.loads(operation["target"])
        tab_id, path, query = request.get("tabId") or "", request.get("path") or "", request.get("query") or ""
        find_opts = {"caseSensitive": bool(request.get("caseSensitive", False)), **getattr(studio_obj, "_seeded_find_bounds", mod.Studio._seeded_find_bounds)(request)}
        existing = next((t for t in studio_obj.tabs if tab_id and t["id"] == tab_id), None)
        if existing is None and path:
            resolved = os.path.normcase(str(Path(path).resolve(strict=False)))
            existing = next((t for t in studio_obj.tabs if t.get("path")
                             and os.path.normcase(str(Path(t["path"]).resolve(strict=False))) == resolved), None)
        if existing is not None:
            if existing["id"] == studio_obj.active and studio_obj.ready:
                studio_obj._pending_seeded_find = None
                if query:
                    studio_obj.readerCall.emit(f"window.supermdFind?.({json.dumps(query)}, {json.dumps(find_opts)})")
            else:
                studio_obj._pending_seeded_find = {"tabId": existing["id"], "path": existing.get("path") or "", "query": query, **find_opts} if query else None
                studio_obj.selectTab(existing["id"])
            studio_obj._focus_open_target(studio_obj._activation_generation)
        elif path:
            local = str(mod.local_path(path))
            studio_obj._pending_seeded_find = {"tabId": "", "path": local, "query": query, **find_opts} if query else None
            def opened(_note, error):
                if error and studio_obj._pending_seeded_find and studio_obj._pending_seeded_find.get("path") == local:
                    studio_obj._pending_seeded_find = None
            studio_obj._open_note(local, explicit=True, completion_callback=opened)
    elif action == "reload_reader":
        studio_obj.ready = studio_obj.reader_overlay = studio_obj.image_overlay = False
        studio_obj._last_reader_text = None
        studio_obj._last_reader_agent_seq.clear()
        studio_obj._emit(False)
        studio_obj.readerReloadRequested.emit()
    elif action == "mode":
        studio_obj._apply_mode(operation["target"])
    elif action == "move_tab":
        request = json.loads(operation["target"])
        if target := studio_obj.session.windows.get(request["window"]):
            studio_obj._move_tab(target, request["tab"], request["index"])
    elif action == "detach_tab":
        if studio_obj._can_move():
            studio_obj.detachedWindowRequested.emit(studio_obj.window_id, operation["target"])
    elif action == "close_tab":
        studio_obj.closeTab(operation["target"])
    elif action == "close_window" and studio_obj.requestWindowClose():
        studio_obj._recover()
        mod.QTimer.singleShot(0, studio_obj.allowClose.emit)

def _is_hidden_cli_close(studio_obj, action: str | None) -> bool:
    bg, host = getattr(studio_obj.session, "background", None), getattr(studio_obj, "host_window", None)
    return bool(action == "close_window" and bg is not None and getattr(bg, "_stopping_from_cli", False)
                and host is not None and not host.isVisible())

def on_flush_timeout(studio_obj) -> None:
    if studio_obj.flush_operation and studio_obj.flush_operation.get("action") == "sync_for_search":
        studio_obj.flush_operation = None
        studio_obj.workspaceSearchChanged.emit()
        return
    if studio_obj.flush_operation and _is_hidden_cli_close(studio_obj, studio_obj.flush_operation.get("action")):
        studio_obj.resolveFlush("recover_close")
        return
    studio_obj.flushFailed.emit(bool(studio_obj.flush_operation and studio_obj.flush_operation["action"] == "close_window"))

def flush(studio_obj, action: str, target: str = "") -> None:
    if studio_obj.retired or (action == "close_window" and studio_obj.pending_close):
        return
    operation = {"action": action, "target": target, "token": uuid.uuid4().hex}
    if not studio_obj.ready or not studio_obj.tabs:
        studio_obj._after_flush(operation)
        return
    hidden_cli_close = _is_hidden_cli_close(studio_obj, action)
    if studio_obj.flush_operation and not hidden_cli_close and (studio_obj.flush_operation.get("action") != "sync_for_search" or action == "sync_for_search"):
        return
    studio_obj.flush_operation = operation
    studio_obj.flush_timer.start(250 if hidden_cli_close else 5000)
    studio_obj.readerCall.emit(f"window.supermdFlush?.({json.dumps(operation)})")

def save_safely(studio_obj) -> None: studio_obj._flush("save")
def save_as_safely(studio_obj) -> None: studio_obj._flush("save_as")
def close_tab_safely(studio_obj, tab_id: str) -> None: studio_obj._flush("close_tab", tab_id)
def close_window_safely(studio_obj) -> None: studio_obj._flush("close_window")

def reload_reader_safely(studio_obj) -> None:
    if studio_obj.ready and not (studio_obj.retired or studio_obj.busy or studio_obj.flush_operation):
        studio_obj._flush("reload_reader")

def resolve_flush(studio_obj, choice: str) -> None:
    operation, studio_obj.flush_operation = studio_obj.flush_operation, None
    studio_obj.flush_timer.stop()
    if not operation:
        return
    if choice == "cancel" and operation["action"] == "close_window":
        if (service := getattr(studio_obj.session, "background", None)) is not None:
            service.cancel_quit()
    elif choice == "retry":
        studio_obj._flush(operation["action"], operation["target"])
    elif choice == "recover_close" and operation["action"] == "close_window":
        studio_obj._recover()
        studio_obj.allowClose.emit()

def save_as(studio_obj, value: str) -> None:
    path, tab = _studio_module().local_path(value), studio_obj._current()
    if path.suffix.lower() == ".smd" and studio_obj.ready:
        studio_obj.pending_export = studio_obj.pending_save_as = str(path)
        studio_obj.pending_save_as_tab = tab["id"]
        studio_obj.readerCall.emit("window.supermdPortable?.(false)")
    else:
        studio_obj._save_text(tab, path, automatic=False, force_overwrite=True, force_portable=path.suffix.lower() == ".smd")

def resolve_conflict(studio_obj, choice: str) -> None:
    if choice == "cancel":
        was_window, studio_obj.pending_close = studio_obj.pending_close == "window", ""
        if was_window and (service := getattr(studio_obj.session, "background", None)) is not None:
            service.cancel_quit()
    elif choice == "save_as":
        studio_obj.saveAsSafely()
    elif choice == "overwrite":
        studio_obj._flush("overwrite_conflict")
    elif choice == "reload":
        studio_obj._flush("reload_conflict")

def reload_current_from_disk(studio_obj) -> None:
    if not (tab := studio_obj._current()).get("path"):
        return
    tab_id, path, mod = tab["id"], Path(tab["path"]), _studio_module()
    captured = mod._snapshot_tab_state(tab)
    archived_draft = None
    if studio_obj._is_dirty(tab):
        archived_assets, raw_name = dict(captured.get("assets", {})), str(captured.get("name") or "Untitled.md")
        archived_draft = {
            **captured, "id": uuid.uuid4().hex,
            "name": raw_name if raw_name.startswith("Recovered ") else f"Recovered {raw_name}",
            "path": "", "saved": "", "assets": archived_assets, "saved_assets": {},
            "assets_dirty": bool(archived_assets), "portable": bool(captured.get("portable")),
            "conflict": False, "agent_staged": False, "agent_unreviewed": False, "agent_edits": [],
        }
    def work():
        loaded = mod.open_note(path)
        if archived_draft is None:
            return loaded, None
        try:
            return loaded, studio_obj.session.closed_note_store.save(archived_draft)
        except Exception as failure:
            raise RuntimeError(f"ARCHIVE_FAILED:{failure}") from failure
    def done(outcome, error):
        if error:
            err_text = str(error)
            studio_obj.message = (f"Could not archive draft before reloading: {err_text[len('ARCHIVE_FAILED:'):]}"
                                  if err_text.startswith("ARCHIVE_FAILED:") else f"Could not reload note from disk: {error}")
            studio_obj._recover()
            studio_obj._emit(False)
            return
        if not (target := next((t for t in studio_obj.tabs if t["id"] == tab_id), None)):
            return
        if any(target.get(k) != captured.get(k) for k in ("content", "saved", "assets", "assets_dirty", "path")):
            studio_obj.message = "The note changed while reloading from disk. It remains open with the latest draft."
            studio_obj._recover()
            studio_obj._emit(False)
            return
        (content, assets, portable), reference = outcome
        if reference is not None:
            next_refs = ([reference] + studio_obj.closed_tabs)[:mod.ClosedNoteStore.LIMIT]
            try:
                studio_obj.session.closed_note_store.save_index(next_refs)
            except Exception as failure:
                studio_obj.message = f"Could not update closed-note recovery before reloading: {failure}"
                studio_obj._recover()
                studio_obj._emit(False)
                return
            studio_obj.closed_tabs[:] = next_refs
        try:
            st = path.stat()
            studio_obj.note_file_stamps[str(path)] = (st.st_mtime_ns, st.st_size)
        except OSError:
            pass
        studio_obj.reader_edits.clear(tab_id)
        studio_obj.session.reader_assets.revoke_tab(studio_obj.window_id, tab_id)
        if tab_id == studio_obj.active:
            studio_obj._last_reader_text = None
        target.update(content=content, saved=content, assets=assets, saved_assets=dict(assets),
                      assets_dirty=False, portable=portable, conflict=False)
        mod.Studio._clear_agent_staging(studio_obj, target)
        studio_obj.message = "Reloaded note from disk"
        studio_obj._recover()
        studio_obj._emit(load=tab_id == studio_obj.active)
    studio_obj._submit(work, done, True, studio_obj.writes)

def save_text(studio_obj, tab: dict, path: Path, automatic: bool = False, force_overwrite: bool = False, force_portable: bool = False) -> None:
    tab_id, content, assets = tab["id"], tab["content"], dict(tab["assets"])
    expected, original_path, expected_assets = tab["saved"], tab["path"], dict(tab.get("saved_assets", {}))
    try:
        same_path = bool(original_path) and Path(path).resolve() == Path(original_path).resolve()
    except OSError:
        same_path = str(path) == original_path
    portable = bool(force_portable or path.suffix.lower() == ".smd" or (tab["portable"] and same_path))
    if tab_id in studio_obj.saving or tab_id in getattr(studio_obj, "_staging_tabs", ()):
        return
    studio_obj.saving.add(tab_id)
    def finished(outcome, error):
        studio_obj.saving.discard(tab_id)
        if error:
            return
        target = next((t for t in studio_obj.tabs if t["id"] == tab_id), None)
        if isinstance(outcome, dict) and outcome.get("_conflict"):
            if target:
                target["conflict"] = True
            studio_obj.message = outcome["message"] if automatic else "This file changed on disk since you opened or last saved it."
            studio_obj._emit(False)
            if not automatic and target:
                studio_obj.saveConflictRequested.emit(target["name"])
            return
        path_changed = str(path) != original_path
        _commit_saved_tab_state(
            studio_obj, target, path=path, saved_content=content, saved_assets=assets, portable=portable,
            stamp=outcome.get("stamp") if isinstance(outcome, dict) else None, clear_staging=not automatic,
            path_changed=path_changed, old_path=original_path, update_recent=path_changed and target is not None,
            rearm_autosave=automatic, message="Autosaved" if automatic else "Saved", finish_pending_close=True,
        )
    def write():
        if (automatic or (not force_overwrite and same_path)) and _has_disk_conflict(
            path, expected, expected_assets, check_assets=portable, missing_is_conflict=bool(automatic)
        ):
            return {"_conflict": True, "message": "Autosave paused: this file changed outside Super MD. Your edits remain in draft recovery; use Save as to keep both versions."}
        stamp = _write_note_and_stat(path, content, assets, portable=portable, validated_assets=expected_assets)
        return {"stamp": stamp} if stamp else {}
    studio_obj._submit(write, finished, busy=not automatic, executor=studio_obj.writes)

def autosave(studio_obj) -> None:
    if not studio_obj.settings["autosave"]:
        return
    staging = getattr(studio_obj, "_staging_tabs", ())
    for tab in studio_obj.tabs:
        if (tab["path"] and studio_obj._is_dirty(tab) and not tab.get("conflict") and not tab.get("agent_staged")
                and tab["id"] not in studio_obj.saving and tab["id"] not in staging):
            studio_obj._save_text(tab, Path(tab["path"]), automatic=True)

def existing_save_directory(raw_path, *, reject_links: bool = False) -> Path | None:
    folder_ops = _studio_module().folder_ops
    if not (cleaned := folder_ops.strip_extended_length_prefix(str(raw_path or "").strip())):
        return None
    try:
        candidate = Path(cleaned).expanduser()
        if reject_links:
            if folder_ops._is_link_or_junction(candidate):
                return None
            resolved = Path(folder_ops.strip_extended_length_prefix(str(candidate.resolve(strict=True))))
            return Path(folder_ops.canonical_path_str(resolved)) if resolved.is_dir() else None
        return candidate if candidate.is_dir() else None
    except OSError:
        return None

def downloads_fallback_directory(cls=None) -> Path:
    mod = _studio_module()
    existing_fn = getattr(cls, "_existing_save_directory", existing_save_directory) if cls is not None else existing_save_directory
    raw_downloads = mod.QStandardPaths.writableLocation(mod.QStandardPaths.StandardLocation.DownloadLocation)
    for candidate in (raw_downloads, Path.home()):
        if (existing := existing_fn(candidate)) is not None:
            return existing
    return Path(mod.folder_ops.strip_extended_length_prefix(str(raw_downloads or "").strip()) or str(Path.home())).expanduser()

def default_output_directory(studio_obj) -> Path:
    mod = _studio_module()
    raw = studio_obj.settings.get("newNoteLocation") or mod.QStandardPaths.writableLocation(mod.QStandardPaths.StandardLocation.DownloadLocation) or str(Path.home())
    return Path(mod.folder_ops.strip_extended_length_prefix(str(raw or "").strip()) or str(Path.home())).expanduser()

def note_save_directory(studio_obj) -> Path:
    existing_fn = getattr(studio_obj, "_existing_save_directory", existing_save_directory)
    if (configured := existing_fn(studio_obj.settings.get("newNoteLocation"))) is not None:
        return configured
    if (open_folder := existing_fn(getattr(studio_obj, "folder", ""), reject_links=True)) is not None:
        return open_folder
    fallback_fn = getattr(studio_obj, "_downloads_fallback_directory", None)
    return fallback_fn() if callable(fallback_fn) else downloads_fallback_directory(_studio_module().Studio)

def save_as_directory(studio_obj) -> Path:
    existing_fn = getattr(studio_obj, "_existing_save_directory", existing_save_directory)
    current_fn = getattr(studio_obj, "_current", None)
    current_tab = current_fn() if callable(current_fn) and studio_obj.tabs else (studio_obj.tabs[0] if getattr(studio_obj, "tabs", None) else {})
    if studio_obj.tabs and (current_path := current_tab.get("path")):
        if cleaned := _studio_module().folder_ops.strip_extended_length_prefix(str(current_path).strip()):
            if (parent := existing_fn(Path(cleaned).expanduser().parent)) is not None:
                return parent
    note_dir_fn = getattr(studio_obj, "_note_save_directory", None)
    return note_dir_fn() if callable(note_dir_fn) else note_save_directory(studio_obj)

def _directory_qurl(studio_obj, attr: str, fallback, name: str | None = None):
    mod, fn = _studio_module(), getattr(studio_obj, attr, None)
    base = fn() if callable(fn) else fallback(studio_obj)
    target = base if name is None else base / (mod.folder_ops._pure_path(str(name or "")).name or "Untitled.md")
    return mod.QUrl.fromLocalFile(str(target))

def default_save_folder(studio_obj): return _directory_qurl(studio_obj, "_note_save_directory", note_save_directory)
def default_save_location(studio_obj, name: str): return _directory_qurl(studio_obj, "_note_save_directory", note_save_directory, name)
def default_save_as_folder(studio_obj): return _directory_qurl(studio_obj, "_save_as_directory", save_as_directory)
def default_save_as_location(studio_obj, name: str): return _directory_qurl(studio_obj, "_save_as_directory", save_as_directory, name)

def run_prepared_write_sync(studio_obj, prepared):
    tab_id, work, finalize, _abort = prepared
    if (saving := getattr(studio_obj, "saving", None)) is not None: saving.add(tab_id)
    try:
        value = work()
    except Exception as error:
        if saving is not None: saving.discard(tab_id)
        finalize(None, str(error))
        raise
    if saving is not None: saving.discard(tab_id)
    return finalize(value, None)

def agent_document_action_async(studio_obj, args: dict, on_complete, *, register_cancel=None, is_cancelled=None) -> None:
    studio_cls, action = _studio_module().Studio, args.get("action")
    if action == "patch_tab":
        studio_obj._stage_inactive_patch_tab_async(args, on_complete, register_cancel=register_cancel, is_cancelled=is_cancelled)
        return
    if action == "save_document":
        prepared = studio_cls._prepare_save_document(studio_obj, args)
    elif action == "replace_tab_asset":
        prepared = studio_cls._prepare_replace_tab_asset(studio_obj, args)
    elif action == "asset_action" and args.get("assetAction") == "attach":
        prepared = studio_cls._prepare_attach_tab_asset(studio_obj, args)
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
        try:
            on_complete(finalize(value, None), None)
        except Exception as failure:
            on_complete(None, str(failure))
    def handle_retired():
        studio_obj.saving.discard(tab_id)
        finalize(None, "The target desktop window was closed")
        on_complete(None, "The target desktop window was closed")
    if not studio_obj._submit_write(work, handle_done, on_retired=handle_retired):
        abort()

def prepare_save_document(studio_obj, args: dict):
    tab_id = args.get("tabId")
    if not (tab := next((item for item in studio_obj.tabs if item["id"] == tab_id), None)):
        raise ValueError("Save requires a target tab that is still open")
    if tab_id in (getattr(studio_obj, "saving", None) or ()):
        raise ValueError("A save is already in progress for this tab; retry after it finishes")
    if tab_id in (getattr(studio_obj, "_staging_tabs", None) or ()):
        raise ValueError("An agent patch is already staging for this tab; retry after it finishes")
    content_snapshot = tab["content"]
    revision = hashlib.sha256(content_snapshot.encode("utf-8")).hexdigest()
    if args.get("expectedRevision") != revision:
        raise ValueError("Live tab revision changed; inspect it again before saving")
    current_format = "smd" if tab.get("portable") or Path(tab.get("path") or tab["name"]).suffix.lower() == ".smd" else "md"
    filename_suffix = Path(args.get("filename", "")).suffix.lower() if isinstance(args.get("filename", ""), str) else ""
    filename_format = "smd" if filename_suffix == ".smd" else "md" if filename_suffix in (".md", ".markdown") else None
    fmt = args.get("format") or (filename_format if args.get("saveAs") or args.get("filename") else None) or current_format
    if fmt not in ("md", "smd"):
        raise ValueError("Save format must be md or smd")
    old_path = tab["path"]
    try:
        old_canonical_path = str(Path(old_path).resolve(strict=True)) if old_path else ""
    except (OSError, RuntimeError):
        old_canonical_path = ""
    if not isinstance(args.get("saveAs", False), bool):
        raise ValueError("saveAs must be a boolean")
    save_as_flag = bool(args.get("saveAs", False)) or bool(args.get("filename"))
    saved_snapshot, assets_snapshot = tab["saved"], dict(tab.get("assets", {}))
    saved_assets_snapshot, portable_snapshot = dict(tab.get("saved_assets", assets_snapshot)), bool(tab.get("portable"))
    created_new_path, reservation_identity = False, None
    if old_path and not save_as_flag and current_format == fmt:
        path = Path(old_path)
        if not path.is_file():
            raise ValueError("The saved file is no longer available; use save-as to create a new copy")
    else:
        if old_path and not save_as_flag:
            raise ValueError("Saving in another format requires saveAs:true and a new filename")
        path = studio_obj._agent_export_path(args.get("filename", ""), fmt, tab)
        studio_obj._agent_owned_files.add(str(path.resolve()))
        created_new_path, st = True, path.stat(follow_symlinks=False)
        reservation_identity = (st.st_dev, st.st_ino)
    resolved_path = path.resolve()
    def unlink_reserved():
        if created_new_path:
            try:
                cur = resolved_path.stat(follow_symlinks=False)
                if reservation_identity == (cur.st_dev, cur.st_ino) and cur.st_size == 0 and not resolved_path.is_symlink():
                    resolved_path.unlink()
            except OSError:
                pass
    def abort():
        unlink_reserved()
        if created_new_path:
            studio_obj._agent_owned_files.discard(str(resolved_path))
    def work():
        try:
            if not created_new_path:
                if not path.is_file():
                    raise ValueError("The saved file is no longer available; use save-as to create a new copy")
                if _has_disk_conflict(path, saved_snapshot, saved_assets_snapshot, check_assets=True, expected_portable=portable_snapshot):
                    raise ValueError("This file changed outside Super MD. Your edits remain in draft recovery; use save-as to keep both versions.")
            return _write_note_and_stat(resolved_path, content_snapshot, assets_snapshot, portable=fmt == "smd")
        except Exception:
            unlink_reserved()
            raise
    def finalize(stamp, error):
        if error is not None:
            abort()
            return None
        path_changed = not old_canonical_path or str(resolved_path) != old_canonical_path
        target = next((item for item in studio_obj.tabs if item["id"] == tab_id), None)
        is_dirty = _commit_saved_tab_state(
            studio_obj, target, path=resolved_path, saved_content=content_snapshot, saved_assets=assets_snapshot,
            portable=fmt == "smd", stamp=stamp, clear_staging=True, add_open_path_when_missing_tab=True,
            path_changed=path_changed, old_path=old_canonical_path or old_path,
            rearm_autosave=bool(getattr(studio_obj, "settings", {}).get("autosave")),
        )
        return {"tabId": tab_id, "windowId": studio_obj.window_id, "path": str(resolved_path), "filename": resolved_path.name,
                "revision": revision, "format": fmt, "isDirty": is_dirty, "pathChanged": path_changed,
                "oldPath": old_canonical_path or old_path, "newPath": str(resolved_path)}
    return tab_id, work, finalize, abort

def execute_portable_tab_save(output: str, args: dict, captured: dict, *, force_portable_overwrite: bool, export_result) -> dict:
    target_path = Path(captured["path"]) if args.get("save") else Path(output)
    if args.get("save") and not force_portable_overwrite and _has_disk_conflict(
        target_path, captured["saved"], captured.get("saved_assets", {}), check_assets=True
    ):
        return {"_conflict": True}
    stamp = _write_note_and_stat(target_path, args["content"], args["assets"], portable=True,
                                 validated_assets=captured.get("saved_assets") if args.get("save") else None)
    result_data = export_result(target_path)
    if stamp is not None:
        result_data["_stamp"] = stamp
    return result_data

def handle_portable_save_conflict(studio_obj, request_id: str, captured: dict) -> None:
    if target_tab := next((t for t in studio_obj.tabs if t["id"] == captured["id"]), None):
        target_tab["conflict"] = True
        studio_obj.message = "This file changed on disk since you opened or last saved it."
        studio_obj._emit(False)
        studio_obj.saveConflictRequested.emit(target_tab["name"])
    studio_obj.replied.emit(request_id, json.dumps({"saved": False, "conflict": True}), "")

def finalize_portable_tab_save(studio_obj, args: dict, captured: dict, target: dict | None, *, save_as: str, save_as_tab: str) -> None:
    if args.get("save") and target:
        old_assets = target.get("assets", {})
        if old_assets != args["assets"]:
            studio_obj.session.reader_assets.revoke_tab(studio_obj.window_id, target["id"])
        merged_assets, matched = preserve_unchanged_assets(old_assets, args["assets"]), target["content"] == args["originalContent"]
        _commit_saved_tab_state(
            studio_obj, target, path=None, saved_content=args["content"] if matched else args["originalContent"],
            saved_assets=merged_assets, portable=bool(target.get("portable", True)),
            updated_content=args["content"] if matched else None, updated_assets=merged_assets,
            clear_staging=True, message="Saved", finish_pending_close=True,
        )
    elif save_as:
        if save_target := next((t for t in studio_obj.tabs if t["id"] == (save_as_tab or captured["id"])), target):
            old_assets, old_path = save_target.get("assets", {}), save_target.get("path", "")
            path_changed = old_path != save_as
            if old_assets != args["assets"] or path_changed:
                studio_obj.session.reader_assets.revoke_tab(studio_obj.window_id, save_target["id"])
            merged_assets = args["assets"] if path_changed else preserve_unchanged_assets(old_assets, args["assets"])
            new_content = args["content"] if save_target["content"] == args.get("originalContent", save_target["content"]) else save_target["content"]
            _commit_saved_tab_state(
                studio_obj, save_target, path=Path(save_as), raw_path_str=save_as, saved_content=args["content"],
                saved_assets=merged_assets, portable=True, updated_content=new_content, updated_assets=merged_assets,
                clear_staging=True, path_changed=path_changed, old_path=old_path, update_recent=True,
                message="Saved", finish_pending_close=True,
            )
        studio_obj.pending_save_as = studio_obj.pending_save_as_tab = ""
