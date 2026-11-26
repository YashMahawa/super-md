"""Portable .smd asset-staging, attachment, and replacement helpers for Studio."""
from __future__ import annotations
import base64, hashlib, re, sys
from pathlib import Path
from typing import Any, Callable

if __package__:
    from . import documents
    from .documents import MAX_IMAGE, MIMES, decode_base64_chunked, encode_base64_chunked, image_data
else:
    import documents
    from documents import MAX_IMAGE, MIMES, decode_base64_chunked, encode_base64_chunked, image_data


def _studio_module():
    module = sys.modules.get("studio") or sys.modules.get("desktop.studio")
    if module is not None:
        return module
    if __package__:
        from . import studio as module
    else:
        import studio as module
    return module


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
