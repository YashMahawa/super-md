"""Unified folder creation, watched file/folder renames, and portable .smd asset staging for Studio."""
from __future__ import annotations
import base64, hashlib, os, re, sys
from pathlib import Path
from typing import Any, Callable

try:
    from . import documents, folder_ops
    from .documents import MAX_IMAGE, MIMES, decode_base64_chunked, encode_base64_chunked, image_data
except ImportError:
    import documents, folder_ops
    from documents import MAX_IMAGE, MIMES, decode_base64_chunked, encode_base64_chunked, image_data

def _studio_module():
    module = sys.modules.get("studio") or sys.modules.get("desktop.studio")
    if module is not None:
        return module
    try:
        from . import studio as module
    except ImportError:
        import studio as module
    return module

def _session_windows(studio_obj: Any) -> list[Any]:
    windows = getattr(getattr(studio_obj, "session", None), "windows", None)
    return list(windows.values()) if isinstance(windows, dict) else []

def _fail_message(studio_obj: Any, text: str) -> None:
    studio_obj.message = str(text)
    studio_obj._emit(False)

def suspend_watches_for_prefix(studio_obj: Any, target_path: str, *, is_dir: bool) -> None:
    parent_str = folder_ops.canonical_path_str(Path(target_path).parent)
    def hit(candidate: str) -> bool:
        return folder_ops.matches_path_prefix(candidate, target_path, is_directory=is_dir) or bool(
            parent_str and folder_ops.same_path(candidate, parent_str)
        )
    for win in _session_windows(studio_obj):
        if getattr(win, "retired", False):
            continue
        to_remove = [p for p in (win.note_watcher.files() + win.note_watcher.directories()) if hit(p)]
        if to_remove:
            win.note_watcher.removePaths(to_remove)
            win.note_watch_paths = None
        if win.external_paths:
            win.external_paths = {p for p in win.external_paths if not hit(p)}

def _restore_watched_notes(studio_obj: Any) -> None:
    for win in _session_windows(studio_obj):
        if not getattr(win, "retired", False):
            win._watch_notes(force=True)

def _remap_workspace_spec(spec: dict, matches: Callable[[Any], bool], remap: Callable[[str], str], *, full: bool) -> None:
    if matches(spec.get("folder")):
        spec["folder"] = remap(spec["folder"])
    if isinstance(spec.get("expanded"), list):
        spec["expanded"] = [remap(p) for p in spec["expanded"]]
    if not full:
        return
    if isinstance(spec.get("paths"), list):
        spec["paths"] = [remap(p) for p in spec["paths"]]
    if spec.get("active"):
        spec["active"] = remap(spec["active"])
    for entry in spec.get("tabs", ()):
        if isinstance(entry, dict) and matches(entry.get("path")):
            entry["path"] = remap(entry["path"])

def sync_path_change(studio_obj: Any, old_path: str, new_path: str, *, is_dir: bool, message: str = "") -> None:
    remap = lambda candidate: folder_ops.remap_path_prefix(candidate, old_path, new_path, is_directory=is_dir)
    matches = lambda candidate: bool(candidate and folder_ops.matches_path_prefix(candidate, old_path, is_directory=is_dir))
    for win in _session_windows(studio_obj):
        if not getattr(win, "retired", False):
            for tab in win.tabs:
                if matches(tab["path"]):
                    updated = remap(tab["path"])
                    tab.update(path=updated, name=Path(updated).name)
    for path_set in (studio_obj._agent_open_paths, studio_obj._agent_owned_files):
        remapped = {remap(p) for p in path_set}
        path_set.clear()
        path_set.update(remapped)
    session = studio_obj.session
    for loc_key in list(session.locations.keys()):
        if matches(loc_key):
            session.locations[remap(loc_key)] = session.locations.pop(loc_key)
    session.pinned = list(dict.fromkeys(remap(p) for p in session.pinned))
    studio_obj.recent = [remap(p) for p in studio_obj.recent]
    for entries in session.workspace.values():
        for entry in entries:
            if matches(entry.get("path")):
                entry["path"] = remap(entry["path"])
    for ws in getattr(session, "window_workspaces", {}).values():
        if isinstance(ws, dict):
            _remap_workspace_spec(ws, matches, remap, full=False)
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
    if message:
        studio_obj.message = message
    studio_obj._save_positions()
    studio_obj._preferences(notify=False)
    for win in _session_windows(studio_obj):
        if getattr(win, "retired", False):
            continue
        if matches(win.folder):
            win.folder = remap(win.folder)
        win.expanded = {remap(p) for p in win.expanded}
        if win._pending_seeded_find and matches(win._pending_seeded_find.get("path")):
            win._pending_seeded_find["path"] = remap(win._pending_seeded_find["path"])
        win._watch_notes(force=True)
        win._recover()
        if win.folder:
            win._load_tree()
        if win._folder_search_open and win._folder_search_query.strip():
            win._start_folder_search()
        win._emit()

def _resolve_new_folder_child(
    open_folder: str, parent_path: str, raw_name: str, *, is_directory: bool, current_ext: str = "",
) -> Path:
    target_dir = folder_ops.resolve_within_open_folder(
        open_folder, parent_path or open_folder, allow_root=True, must_exist=True
    )
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
            try:
                win_root = Path(folder_ops.canonical_path_str(win.folder))
                if folder_ops.matches_path_prefix(created_path, str(win_root), is_directory=True):
                    win.expanded.update(folder_ops.ancestor_directories_in_folder(win_root, expand_target))
                    if recover:
                        win._recover()
                    win._load_tree()
            except OSError:
                pass

def create_folder_note(studio_obj: Any, parent_path: str, name: str, fmt: str = "md") -> None:
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
        studio_mod = _studio_module()
        if kind == "smd":
            studio_mod.write_portable(target, "", {})
        else:
            studio_mod.atomic_write(target, b"")
        return folder_ops.canonical_path_str(target.resolve(strict=True))

    def finished(created_path, error):
        if error or not created_path:
            return
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
        created = Path(created_dir)
        _expand_created_in_windows(studio_obj, created_dir, created, recover=True)
        _fail_message(studio_obj, f"Created folder {created.name}")

    studio_obj._submit(work, finished, executor=studio_obj.writes)

def _execute_watched_rename(
    studio_obj: Any, before: Path, after: Path, final_name: str, *,
    is_dir: bool, symlink_error: str, exists_error: str,
) -> None:
    suspend_fn = getattr(studio_obj, "_suspend_watches_for_prefix", None)
    if callable(suspend_fn):
        suspend_fn(str(before), is_dir=is_dir)
    else:
        suspend_watches_for_prefix(studio_obj, str(before), is_dir=is_dir)

    def work():
        if folder_ops._is_link_or_junction(after):
            raise ValueError(symlink_error)
        if after.exists():
            same_inode = False
            if before.name.casefold() == final_name.casefold():
                try:
                    same_inode = os.path.samestat(before.stat(), after.stat())
                except OSError:
                    same_inode = False
            if not same_inode:
                raise ValueError(exists_error)
        old_str = folder_ops.canonical_path_str(before)
        before.rename(after)
        return old_str, folder_ops.canonical_path_str(after.resolve(strict=True)), is_dir

    def finished(result, error):
        if error or not result:
            return _restore_watched_notes(studio_obj)
        old_str, new_str, was_dir = result
        message = f"Renamed to {Path(new_str).name}"
        sync_fn = getattr(studio_obj, "_sync_path_change", None)
        if callable(sync_fn):
            sync_fn(old_str, new_str, is_dir=was_dir, message=message)
        else:
            sync_path_change(studio_obj, old_str, new_str, is_dir=was_dir, message=message)

    studio_obj._submit(work, finished, executor=studio_obj.writes)

def rename_entry(studio_obj: Any, entry_path: str, name: str) -> None:
    if not studio_obj.folder:
        return _fail_message(studio_obj, "Open a folder first.")
    try:
        before = folder_ops.resolve_within_open_folder(studio_obj.folder, entry_path, allow_root=False, must_exist=True)
        is_dir = before.is_dir()
        final_name = folder_ops.validate_entry_name(
            name, is_directory=is_dir, current_ext="" if is_dir else folder_ops.note_extension(before.name), has_saved_target=True
        )
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
    _execute_watched_rename(
        studio_obj, before, after, final_name, is_dir=is_dir,
        symlink_error="Symlinks are not allowed inside the open folder.",
        exists_error="An item with that name already exists.",
    )

def rename_note(studio_obj: Any, note_id: str, name: str) -> None:
    tab = next((t for t in studio_obj.tabs if t["id"] == note_id), None)
    if not tab or note_id in getattr(studio_obj, "saving", ()):
        return
    try:
        has_saved = bool(tab.get("path"))
        existing_ext = folder_ops.note_extension(tab["name"])
        current_ext = existing_ext if has_saved else (existing_ext or (".smd" if tab.get("portable") else ".md"))
        final_name = folder_ops.validate_entry_name(
            name, is_directory=False, current_ext=current_ext, has_saved_target=has_saved
        )
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
        rename_entry_fn = getattr(studio_obj, "renameEntry", None)
        return rename_entry_fn(str(before), final_name) if callable(rename_entry_fn) else rename_entry(studio_obj, str(before), final_name)
    _execute_watched_rename(
        studio_obj, before, after, final_name, is_dir=False,
        symlink_error="Symlinks are not allowed.",
        exists_error="A file with that name already exists.",
    )

def extra_asset_roots(studio_obj: Any) -> list[Path]:
    roots: list[Path] = []
    if getattr(studio_obj, "folder", ""):
        roots.append(Path(studio_obj.folder))
    settings = getattr(studio_obj, "settings", None)
    location = settings.get("newNoteLocation") if isinstance(settings, dict) else None
    if location:
        roots.append(Path(location))
    return roots

def apply_saved_tab_assets(
    studio_obj: Any, tab_id: str, path: Path, content_snapshot: str,
    assets_snapshot: dict, updated: dict, stamp=None,
) -> None:
    note_file_stamps = getattr(studio_obj, "note_file_stamps", None)
    if stamp and isinstance(note_file_stamps, dict):
        note_file_stamps[str(path)] = stamp
    target = next((item for item in getattr(studio_obj, "tabs", ()) if item["id"] == tab_id), None)
    if target is not None:
        extra = {k: v for k, v in target.get("assets", {}).items() if k not in assets_snapshot}
        target["assets"] = {**updated, **extra} if extra else updated
        target["saved"] = content_snapshot
        target["saved_assets"] = dict(updated)
        target["assets_dirty"] = bool(extra)
        target["conflict"] = False
        settings = getattr(studio_obj, "settings", None)
        autosave = settings.get("autosave") if isinstance(settings, dict) else False
        if _studio_module().Studio._is_dirty(studio_obj, target) and autosave and hasattr(studio_obj, "autosave_timer"):
            studio_obj.autosave_timer.start(900)
    reader_assets = getattr(getattr(studio_obj, "session", None), "reader_assets", None)
    if reader_assets is not None:
        reader_assets.revoke_tab(getattr(studio_obj, "window_id", ""), tab_id)
    if hasattr(studio_obj, "readerCall"):
        studio_obj.readerCall.emit("window.dispatchEvent(new Event('supermd-assets-changed'))")
    if hasattr(studio_obj, "_recover"):
        studio_obj._recover()
    if hasattr(studio_obj, "_emit"):
        studio_obj._emit()

def _is_valid_asset_filename(filename: str) -> bool:
    validator = getattr(documents, "is_valid_asset_filename", None)
    if callable(validator):
        return bool(validator(filename))
    return bool(re.fullmatch(r"[A-Za-z0-9._-]{1,150}", filename)) and filename not in (".", "..")

def _resolve_local_asset_candidate(
    studio_obj: Any, raw_path: Any, note_path: Path, *,
    unavailable_message: str, outside_message: str, size_error: str,
) -> tuple[Path, str | None]:
    studio_mod = _studio_module()
    candidate = studio_mod._validate_local_tab_asset_path(
        raw_path, note_path, studio_mod.Studio._extra_asset_roots(studio_obj),
        unavailable_message=unavailable_message, outside_message=outside_message,
    )
    if candidate.stat().st_size > MAX_IMAGE:
        raise ValueError(size_error)
    return candidate, MIMES.get(candidate.suffix.lower().lstrip("."))

def _read_bounded_candidate(candidate: Path, size_error: str) -> bytes:
    raw = candidate.read_bytes()
    if len(raw) > MAX_IMAGE:
        raise ValueError(size_error)
    return raw

def _prepare_portable_asset_mutation(
    studio_obj: Any, args: dict, *, subject: str, gerund: str, prepare_source: Callable,
):
    studio_cls = _studio_module().Studio
    tab_id = args.get("tabId")
    tab = next((item for item in studio_obj.tabs if item["id"] == tab_id), None)
    if not tab or tab_id != studio_obj.active:
        raise ValueError(f"{subject} requires the target tab to be active")
    saving = getattr(studio_obj, "saving", None)
    if saving is not None and tab_id in saving:
        raise ValueError("A save is already in progress for this tab; retry after it finishes")
    content_snapshot = tab["content"]
    revision = hashlib.sha256(content_snapshot.encode("utf-8")).hexdigest()
    if args.get("expectedRevision") != revision:
        raise ValueError(f"Live tab revision changed; inspect it again before {gerund} an asset")
    path = Path(tab.get("path") or "")
    if not tab.get("portable") or path.suffix.lower() != ".smd" or not path.is_file():
        raise ValueError(f"{subject} requires a saved portable .smd note")
    saved_snapshot = tab["saved"]
    if studio_cls._is_dirty(studio_obj, tab):
        raise ValueError(f"Save the note before {gerund} a portable asset")
    assets_snapshot = dict(tab.get("assets", {}))
    saved_assets_snapshot = dict(tab.get("saved_assets", assets_snapshot))
    load_stage = prepare_source(tab_id, path, assets_snapshot, revision)

    def work():
        asset_key, mime, raw, signature_error, post_signature_check, build_result = load_stage()
        studio_mod = _studio_module()
        if not studio_mod._matches_media_signature(mime, raw):
            raise ValueError(signature_error)
        noop_result = post_signature_check(raw)
        if noop_result is not None:
            return {"changed": False, "result": noop_result}
        disk_content, disk_assets, disk_portable = studio_mod.open_note(path)
        if not disk_portable or disk_content != saved_snapshot or disk_assets != saved_assets_snapshot:
            raise ValueError(f"The portable note changed on disk; reopen it before {gerund} an asset")
        updated = dict(assets_snapshot)
        updated[asset_key] = f"data:{mime};base64," + encode_base64_chunked(raw)
        studio_mod.write_portable(path, content_snapshot, updated)
        try:
            st = path.stat()
            stamp = (st.st_mtime_ns, st.st_size)
        except OSError:
            stamp = None
        return {"changed": True, "updated": updated, "stamp": stamp, "result": build_result(asset_key, mime, raw)}

    def finalize(value, error):
        if error is not None:
            return None
        if value.get("changed", True):
            _studio_module().Studio._apply_saved_tab_assets(
                studio_obj, tab_id, path, content_snapshot, assets_snapshot, value["updated"], value.get("stamp")
            )
        return value["result"]

    return tab_id, work, finalize, lambda: None

def prepare_attach_tab_asset(studio_obj: Any, args: dict):
    """Prepare attaching a bounded local or relay-supplied image to a saved portable note."""
    def prepare_source(tab_id: str, path: Path, assets_snapshot: dict[str, str], revision: str):
        mime, body, asset_path = args.get("mimeType"), args.get("body"), args.get("assetPath")
        if isinstance(body, str) == (isinstance(asset_path, str) and bool(asset_path)):
            raise ValueError("Provide exactly one of base64 body or local assetPath")
        inline_mode = isinstance(body, str)
        candidate = None
        if inline_mode:
            if mime not in MIMES.values() or len(body) > (MAX_IMAGE * 4 // 3 + 8):
                raise ValueError("Inline asset type or size is invalid")
            requested_name = args.get("assetName")
        else:
            candidate, mime = _resolve_local_asset_candidate(
                studio_obj, asset_path, path, unavailable_message="Asset file is unavailable",
                outside_message="Asset must be inside the current note folder or a configured folder",
                size_error="Asset exceeds 25 MB",
            )
            if mime is None:
                raise ValueError("Asset type must be PNG, JPEG, SVG, GIF, WebP or AVIF")
            requested_name = args.get("assetName") or candidate.name

        def load_stage():
            if inline_mode:
                try:
                    raw = decode_base64_chunked(body)
                except (ValueError, TypeError, base64.binascii.Error) as error:
                    raise ValueError("Asset body must be valid base64") from error
                if not 1 <= len(raw) <= 1024 * 1024:
                    raise ValueError("Relay supplied assets are limited to 1 MiB")
            else:
                assert candidate is not None
                raw = _read_bounded_candidate(candidate, "Asset exceeds 25 MB")
            filename = requested_name.removeprefix("assets/") if isinstance(requested_name, str) else ""
            if not _is_valid_asset_filename(filename):
                raise ValueError("Asset name must be a simple filename")
            ext = Path(filename).suffix.lower().lstrip(".")
            if not ext:
                ext = next((item for item, kind in MIMES.items() if kind == mime), "")
                filename += "." + ext
            if MIMES.get(ext) != mime:
                raise ValueError("Asset name extension must match the image type")
            asset_key = "assets/" + filename

            def check_collision(_raw: bytes):
                if asset_key in assets_snapshot:
                    raise ValueError("An asset with that name already exists")
                return None

            def build_result(key: str, resolved_mime: str, payload: bytes) -> dict:
                sha = hashlib.sha256(payload).hexdigest()
                record = {"name": key, "mime": resolved_mime, "bytes": len(payload), "sha256": sha}
                return {"tabId": tab_id, "assetName": key, "asset": record, "mimeType": resolved_mime,
                        "bytes": len(payload), "sha256": sha, "revision": revision, "saved": True}

            return asset_key, mime, raw, "Asset bytes do not match the declared image type", check_collision, build_result

        return load_stage

    return _prepare_portable_asset_mutation(
        studio_obj, args, subject="Attaching an asset", gerund="attaching", prepare_source=prepare_source
    )

def attach_tab_asset_native(studio_obj: Any, args: dict):
    """Attach a bounded local or relay-supplied image to a saved portable note."""
    studio_cls = _studio_module().Studio
    return studio_cls._run_prepared_write_sync(studio_obj, studio_cls._prepare_attach_tab_asset(studio_obj, args))

def prepare_replace_tab_asset(studio_obj: Any, args: dict):
    def prepare_source(tab_id: str, path: Path, assets_snapshot: dict[str, str], revision: str):
        asset_id, asset_path_value = args.get("assetName"), args.get("assetPath")
        asset_name = asset_id if asset_id in assets_snapshot else next(
            (name for name in assets_snapshot if hashlib.sha256(name.encode("utf-8")).hexdigest() == asset_id), None
        )
        if not asset_name:
            raise ValueError("Asset ID is not present in the current note")
        candidate, mime = _resolve_local_asset_candidate(
            studio_obj, asset_path_value, path, unavailable_message="Replacement asset file is unavailable",
            outside_message="Replacement asset must be inside the current note folder or a configured folder",
            size_error="Replacement asset exceeds 25 MB",
        )
        expected_mime = MIMES.get(asset_name.rsplit(".", 1)[-1].lower())
        if not mime or mime != expected_mime:
            raise ValueError("Replacement asset must keep the existing MIME type and extension")

        def load_stage():
            raw = _read_bounded_candidate(candidate, "Replacement asset exceeds 25 MB")

            def check_existing_and_noop(payload: bytes):
                old_mime, old_data = image_data(assets_snapshot[asset_name])
                if old_mime != mime:
                    raise ValueError("Stored asset MIME type does not match its extension")
                if old_data == payload:
                    return {"tabId": tab_id, "assetName": asset_name, "asset": asset_name, "assetId": asset_name,
                            "revision": revision, "changed": False, "saved": False}
                return None

            def build_result(key: str, resolved_mime: str, payload: bytes) -> dict:
                return {"tabId": tab_id, "assetName": key, "asset": key, "assetId": key, "revision": revision,
                        "changed": True, "saved": True, "bytes": len(payload), "mimeType": resolved_mime}

            return (asset_name, mime, raw, "Replacement asset bytes do not match the current MIME type",
                    check_existing_and_noop, build_result)

        return load_stage

    return _prepare_portable_asset_mutation(
        studio_obj, args, subject="Asset replacement", gerund="replacing", prepare_source=prepare_source
    )

def replace_tab_asset_native(studio_obj: Any, args: dict):
    studio_cls = _studio_module().Studio
    return studio_cls._run_prepared_write_sync(studio_obj, studio_cls._prepare_replace_tab_asset(studio_obj, args))
