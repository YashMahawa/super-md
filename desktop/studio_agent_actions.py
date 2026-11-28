"""Reader command routing, agent document actions, export path reservation, and viewport capture for Studio."""
from __future__ import annotations
import base64, hashlib, math, os, uuid
from collections.abc import Callable
from pathlib import Path
from typing import Any
from PySide6.QtCore import QBuffer, QByteArray, QIODevice, QObject, QPointF, QRect, QStandardPaths, QTimer, Qt
from PySide6.QtGui import QImage

_READER_COMMAND_CALLS = {
    "find": "window.supermdFind?.()", "replace": "window.supermdFind?.(true)",
    "find_next": "window.supermdFindStep?.(1)", "find_previous": "window.supermdFindStep?.(-1)",
    "insert": "window.supermdMedia?.()", "repair": "window.supermdRepairMath?.()",
    "undo": "window.supermdHistory?.('undo')", "redo": "window.supermdHistory?.('redo')",
    "format_bold": "window.supermdFormat?.('bold')", "format_italic": "window.supermdFormat?.('italic')",
    "format_inline_code": "window.supermdFormat?.('inline_code')", "format_link": "window.supermdFormat?.('link')",
    "format_heading": "window.supermdFormat?.('heading')", "format_list": "window.supermdFormat?.('list')",
    "format_quote": "window.supermdFormat?.('quote')", "format_inline_math": "window.supermdFormat?.('inline_math')",
}


def _default_is_dirty(_studio_obj: Any, tab: dict) -> bool:
    return bool(tab.get("content") != tab.get("saved") or tab.get("assets_dirty")
                or (tab.get("path") and "saved_assets" in tab and tab.get("assets", {}) != tab.get("saved_assets", {})))

def _default_prepare_save_document(studio_obj: Any, args: dict):
    return studio_obj._prepare_save_document(args)

def _default_run_prepared_write_sync(studio_obj: Any, prepared: Any):
    tab_id, work, finalize, _abort = prepared
    saving = getattr(studio_obj, "saving", None)
    if saving is not None: saving.add(tab_id)
    try:
        value = work()
    except Exception as error:
        if saving is not None: saving.discard(tab_id)
        finalize(None, str(error))
        raise
    if saving is not None: saving.discard(tab_id)
    return finalize(value, None)

def _default_agent_directory(studio_obj: Any, *, writable_location_fn: Callable = QStandardPaths.writableLocation) -> Path:
    return Path(studio_obj.settings.get("newNoteLocation")
                or writable_location_fn(QStandardPaths.StandardLocation.DownloadLocation) or str(Path.home())).expanduser()

def _tab_result(studio_obj: Any, tab: dict, *, is_dirty_fn: Callable = _default_is_dirty, **kwargs) -> dict:
    fn = getattr(studio_obj, "_agent_tab_result", None)
    return fn(tab, **kwargs) if callable(fn) else agent_tab_result(studio_obj, tab, is_dirty_fn=is_dirty_fn, **kwargs)

def _encode_viewport_image(image: QImage, image_format: str, *, jpeg_quality: int | None = None, require_saved: bool = False) -> tuple[str, str]:
    is_jpeg = image_format == "jpeg"
    mime_type, encoder = ("image/jpeg", "JPEG") if is_jpeg else ("image/png", "PNG")
    encoded = QByteArray()
    buffer = QBuffer(encoded)
    saved = ((image.save(buffer, encoder, jpeg_quality) if is_jpeg and jpeg_quality is not None else image.save(buffer, encoder))
             if buffer.open(QIODevice.OpenModeFlag.WriteOnly) else False)
    if require_saved and not saved:
        raise ValueError(f"Could not encode the live viewport as {encoder}")
    return mime_type, base64.b64encode(bytes(encoded)).decode("ascii")

def command(studio_obj: Any, action: str) -> None:
    if action in _READER_COMMAND_CALLS:
        studio_obj.readerCall.emit(_READER_COMMAND_CALLS[action])
    elif action == "window":
        studio_obj.newWindowRequested.emit()

def agent_export_path(studio_obj: Any, filename: str, format: str, tab: dict, *, writable_location_fn: Callable = QStandardPaths.writableLocation) -> Path:
    extension = {"pdf": ".pdf", "smd": ".smd", "md": ".md", "mdzip": ".zip"}[format]
    selected = filename or Path(tab["name"]).stem or "Super MD export"
    if Path(selected).name != selected or any(char in selected for char in ("/", "\\", "\0")):
        raise ValueError("Export filename must be a basename")
    stem = Path(selected).stem if Path(selected).suffix else selected
    stem = "".join(char for char in stem if char.isalnum() or char in " ._()-").strip(" .")[:100]
    if not stem or stem in (".", ".."):
        stem = "Super MD export"
    directory = _default_agent_directory(studio_obj, writable_location_fn=writable_location_fn)
    if not directory.is_dir():
        raise ValueError("The configured export folder is unavailable")
    for index in range(1, 10_001):
        suffix = "" if index == 1 else f" ({index})"
        candidate = directory / f"{stem}{suffix}{extension}"
        try:
            descriptor = os.open(candidate, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        except FileExistsError:
            continue
        os.close(descriptor)
        return candidate
    raise ValueError("Could not choose a unique export filename")

def agent_document_action(
    studio_obj: Any, args: dict, *, writable_location_fn: Callable = QStandardPaths.writableLocation,
    is_dirty_fn: Callable = _default_is_dirty, run_prepared_write_sync_fn: Callable = _default_run_prepared_write_sync,
    prepare_save_document_fn: Callable = _default_prepare_save_document,
) -> dict:
    action = args.get("action")
    if action == "patch_tab":
        tab, tab_id, previous, revision, edited, operation_results, changed = studio_obj._validate_and_compute_patch_tab(args)
        if tab_id == studio_obj.active:
            if changed:
                tab["content"] = edited
                studio_obj._append_agent_edit(tab, previous, edited)
                tab["agent_unreviewed"] = True
                studio_obj.recovery_timer.start(800)
                studio_obj.autosave_timer.start(900)
                studio_obj._emit(load=True)
            return {"tabId": tab_id, "windowId": studio_obj.window_id,
                    "revision": hashlib.sha256(edited.encode("utf-8")).hexdigest(),
                    "sourceLength": len(edited), "changed": changed,
                    "applied": len(operation_results), "operation_results": operation_results,
                    "isDirty": edited != tab["saved"]}
        if not changed and not (is_dirty_fn(studio_obj, tab) or tab.get("agent_staged") or tab.get("agent_unreviewed")):
            return {"tabId": tab_id, "windowId": studio_obj.window_id, "revision": revision,
                    "sourceLength": len(edited), "changed": False,
                    "applied": len(operation_results), "operation_results": operation_results, "isDirty": False}
        return studio_obj._stage_inactive_patch_tab_sync(tab_id, previous, edited, operation_results, changed)
    if action == "replace_tab_asset":
        return studio_obj._replace_tab_asset_native(args)
    if action == "asset_action" and args.get("assetAction") == "attach":
        return studio_obj._attach_tab_asset_native(args)
    if action == "create_document":
        fmt, content = args.get("format"), args.get("content", "")
        title = args.get("title") or args.get("filename", "")
        background = args.get("background", False)
        if not isinstance(background, bool):
            raise ValueError("background must be a boolean")
        if fmt is None:
            fmt = "smd" if isinstance(title, str) and Path(title).suffix.lower() == ".smd" else "md"
        if fmt not in ("md", "smd") or not isinstance(content, str) or len(content.encode("utf-8")) > 20_000_000 or not isinstance(title, str):
            raise ValueError("New document content or format is invalid")
        title = title.strip() or ("Untitled.smd" if fmt == "smd" else "Untitled.md")
        suffix = Path(title).suffix.lower()
        if suffix in (".md", ".smd") and suffix != "." + fmt:
            title = str(Path(title).with_suffix("." + fmt))
        elif not title.lower().endswith("." + fmt):
            title += "." + fmt
        note = studio_obj._note(title, content, "", "", {}, fmt == "smd")
        studio_obj.tabs.append(note)
        if not background:
            studio_obj.active = note["id"]
        studio_obj.recovery_timer.start(800)
        studio_obj._emit(load=not background)
        return _tab_result(studio_obj, note, is_dirty_fn=is_dirty_fn, active=not background, title=title)
    if action == "save_document":
        return run_prepared_write_sync_fn(studio_obj, prepare_save_document_fn(studio_obj, args))
    if action == "activate_document":
        tab_id = args.get("tabId")
        tab = next((item for item in studio_obj.tabs if item["id"] == tab_id), None)
        if tab is None:
            raise ValueError("The requested live tab is no longer open")
        studio_obj.selectTab(tab_id)
        return _tab_result(studio_obj, tab, is_dirty_fn=is_dirty_fn, active=True)
    if action == "close_document":
        tab_id = args.get("tabId")
        tab = next((item for item in studio_obj.tabs if item["id"] == tab_id), None)
        if tab is None:
            raise ValueError("The requested live tab is no longer open")
        staging = getattr(studio_obj, "_staging_tabs", None)
        if staging is not None and tab_id in staging:
            raise ValueError("An agent patch is already staging for this tab; retry after it finishes")
        expected = args.get("expectedRevision")
        revision = hashlib.sha256(tab["content"].encode("utf-8")).hexdigest()
        if not isinstance(expected, str) or expected != revision:
            raise ValueError("Live tab revision changed; inspect it again before closing")
        discard = args.get("discardChanges", False)
        if not isinstance(discard, bool):
            raise ValueError("discardChanges must be a boolean")
        if is_dirty_fn(studio_obj, tab) and not discard:
            raise ValueError("The document has unsaved changes; pass discardChanges:true to close and preserve it in closed-note recovery")
        studio_obj._remove_tab(tab_id)
        status = "closing" if any(item["id"] == tab_id for item in studio_obj.tabs) else "closed"
        return {"status": status, "tabId": tab_id, "windowId": studio_obj.window_id,
                "path": tab["path"], "revision": revision, "active": studio_obj.active == tab_id}
    if action == "open_document":
        background = args.get("background", False)
        if not isinstance(background, bool):
            raise ValueError("background must be a boolean")
        filename = args.get("filename", "")
        if filename == "":
            tab_id = args.get("tabId")
            existing = next((item for item in studio_obj.tabs if item["id"] == tab_id), None)
            if existing is None:
                raise ValueError("The requested live tab is no longer open")
            if not background:
                studio_obj.selectTab(existing["id"])
            return _tab_result(studio_obj, existing, is_dirty_fn=is_dirty_fn, active=not background)
        candidate = Path(filename).expanduser()
        if not candidate.is_absolute():
            candidate = _default_agent_directory(studio_obj, writable_location_fn=writable_location_fn) / candidate.name
        if not studio_obj._agent_path_allowed(candidate):
            raise ValueError("The file is outside the approved agent note roots")
        resolved = str(candidate.resolve())
        existing = next((item for item in studio_obj.tabs if item["path"] and str(Path(item["path"]).resolve()) == resolved), None)
        if existing:
            if not background:
                studio_obj.selectTab(existing["id"])
            return _tab_result(studio_obj, existing, is_dirty_fn=is_dirty_fn, active=not background)
        while len(studio_obj._agent_job_records) >= 20:
            removable = next((key for key, value in studio_obj._agent_job_records.items()
                              if value.get("status") in ("completed", "failed", "cancelled")), None)
            if removable is None:
                raise ValueError("The desktop already has 20 active agent jobs")
            studio_obj._agent_job_records.pop(removable, None)
        job_id = uuid.uuid4().hex
        fmt = "smd" if Path(resolved).suffix.lower() == ".smd" else "md"
        studio_obj._agent_job_records[job_id] = {"jobId": job_id, "status": "running", "action": "open_document",
                                                 "path": resolved, "windowId": studio_obj.window_id,
                                                 "active": not background, "format": fmt}
        studio_obj._agent_open_paths.add(resolved)

        def opened(result, error):
            record = studio_obj._agent_job_records.get(job_id)
            if record is None:
                return
            if error:
                record.update(status="failed", error=str(error)[:1000])
            else:
                record.update(status="completed", **_tab_result(studio_obj, result, is_dirty_fn=is_dirty_fn))

        studio_obj._open_note(resolved, explicit=not background, background=background, completion_callback=opened)
        return {"status": "opening", "jobId": job_id, "path": resolved, "windowId": studio_obj.window_id,
                "active": not background, "format": fmt}
    raise ValueError("Unsupported native document action")

def agent_tab_result(studio_obj: Any, tab: dict, *, active: bool | None = None, title: str | None = None, is_dirty_fn: Callable = _default_is_dirty) -> dict:
    content, path = tab["content"], tab["path"]
    fmt = "smd" if tab.get("portable") or Path(path or tab["name"]).suffix.lower() == ".smd" else "md"
    return {"tabId": tab["id"], "windowId": studio_obj.window_id,
            "revision": hashlib.sha256(content.encode("utf-8")).hexdigest(),
            "path": path, "title": title or tab["name"],
            "active": studio_obj.active == tab["id"] if active is None else active,
            "sourceLength": len(content), "format": fmt, "isDirty": is_dirty_fn(studio_obj, tab)}

def agent_viewport_pending(studio_obj: Any, request_id: str, tab_id: str) -> bool:
    bridge = getattr(studio_obj.session, "agent_bridge", None)
    return bool(bridge and bridge.has_pending(request_id, studio_obj.window_id, "render_tab", tab_id))

def agent_viewport_revision(studio_obj: Any, tab_id: str) -> str:
    if studio_obj.retired or studio_obj.active != tab_id:
        raise ValueError("The target tab is no longer active; refresh the live tab list")
    tab = next((item for item in studio_obj.tabs if item["id"] == tab_id), None)
    if tab is None:
        raise ValueError("The requested live tab is no longer open")
    return hashlib.sha256(tab["content"].encode("utf-8")).hexdigest()

def begin_agent_viewport_capture(studio_obj: Any, request_id: str, args: dict, *, single_shot_fn: Callable = QTimer.singleShot) -> None:
    if not isinstance(args, dict) or args.get("requestId") != request_id:
        raise ValueError("Viewport capture request is invalid")
    tab_id, revision, context = args.get("tabId"), args.get("revision"), args.get("context")
    if not isinstance(tab_id, str) or not isinstance(revision, str) or len(revision) != 64:
        raise ValueError("Viewport capture is missing its live tab revision")
    if not isinstance(context, dict) or context.get("revision") != revision:
        raise ValueError("Viewport context revision does not match the request")
    if not studio_obj._agent_viewport_pending(request_id, tab_id):
        return
    if studio_obj._agent_viewport_revision(tab_id) != revision:
        raise ValueError("The live tab changed before its viewport was captured")
    if studio_obj.host_window is not None and not studio_obj.host_window.isVisible():
        studio_obj._capture_background_preview(request_id, tab_id, revision, context, args)
        return
    bounds = context.get("viewport")
    if not isinstance(bounds, dict):
        raise ValueError("Reader viewport bounds are unavailable")
    try:
        rect = {key: float(bounds[key]) for key in ("x", "y", "width", "height", "viewportWidth", "viewportHeight")}
    except (KeyError, TypeError, ValueError) as error:
        raise ValueError("Reader viewport bounds are invalid") from error
    if any(not math.isfinite(v) for v in rect.values()) or rect["width"] <= 0 or rect["height"] <= 0 or rect["viewportWidth"] <= 0 or rect["viewportHeight"] <= 0:
        raise ValueError("Reader viewport bounds are invalid")
    if rect["x"] < 0 or rect["y"] < 0 or rect["x"] + rect["width"] > rect["viewportWidth"] + 1 or rect["y"] + rect["height"] > rect["viewportHeight"] + 1:
        raise ValueError("Reader viewport bounds are outside the visible page")
    width = args.get("width", 1600)
    if not isinstance(width, int) or isinstance(width, bool) or not 64 <= width <= 1600:
        raise ValueError("Viewport width must be between 64 and 1,600 pixels")
    image_format = args.get("imageFormat", "png")
    if image_format not in ("png", "jpeg"):
        raise ValueError("Viewport imageFormat must be png or jpeg")
    if studio_obj._agent_viewport_capture is not None:
        raise ValueError("Another viewport capture is already in progress")
    window = studio_obj.host_window
    if window is None:
        raise ValueError("The desktop reader window is unavailable")
    pending = {"requestId": request_id, "tabId": tab_id, "revision": revision, "context": context,
               "bounds": rect, "width": width, "imageFormat": image_format, "window": window}
    studio_obj._agent_viewport_capture = pending
    try:
        window.frameSwapped.connect(studio_obj._agent_viewport_frame_swapped, Qt.ConnectionType.QueuedConnection)
    except (AttributeError, RuntimeError, TypeError):
        pass
    window.update()
    single_shot_fn(200, lambda rid=request_id: studio_obj._agent_viewport_fallback(rid))

def capture_background_preview(studio_obj: Any, request_id: str, tab_id: str, revision: str, context: dict, args: dict, *, offline_view_mod: Any = None) -> None:
    if offline_view_mod is None:
        if __package__: from . import offline_view as offline_view_mod
        else: import offline_view as offline_view_mod
    bridge = getattr(studio_obj.session, "agent_bridge", None)
    tab = next((t for t in studio_obj.tabs if t["id"] == tab_id), None)
    if studio_obj.retired or tab is None or tab_id in getattr(studio_obj, "_closing_tabs", ()):
        if bridge is not None: bridge.complete(request_id, None, "The note for this preview is no longer open", window_id=studio_obj.window_id)
        return
    content, assets, path = tab["content"], dict(tab.get("assets", {})), tab.get("path", "")
    width = max(320, min(1600, int(args.get("width", 1200))))
    heading = context.get("reading", {}).get("heading") or None
    view = {"dark": studio_obj._dark(), "colors": studio_obj._colors(), "font": studio_obj.settings["font"],
            "size": studio_obj.settings["size"], "svgAppearance": studio_obj.settings["svgAppearance"], "lineHeight": studio_obj.settings["lineHeight"]}
    preview_jobs = getattr(studio_obj, "_preview_jobs", None)
    preview_job = preview_jobs.register(tab_id) if preview_jobs is not None else None

    def work():
        try: return offline_view_mod.render_live_snapshot(content, assets, path, width=width, heading=heading, view=view, job=preview_job)
        except offline_view_mod.PreviewCancelled: return None
        finally:
            if preview_jobs is not None: preview_jobs.discard(preview_job)

    def done(body, error):
        bridge = getattr(studio_obj.session, "agent_bridge", None)
        if bridge is None: return
        if body is None and not error:
            bridge.complete(request_id, None, "Background preview cancelled", window_id=studio_obj.window_id); return
        if error:
            bridge.complete(request_id, None, str(error), window_id=studio_obj.window_id); return
        try: current_revision = studio_obj._agent_viewport_revision(tab_id)
        except ValueError as rev_error:
            bridge.complete(request_id, None, str(rev_error), window_id=studio_obj.window_id); return
        if current_revision != revision:
            bridge.complete(request_id, None, "The note changed during background preview; retry", window_id=studio_obj.window_id); return
        image = QImage.fromData(body, "PNG")
        mime, data = _encode_viewport_image(image, args.get("imageFormat", "png"))
        bridge.complete(request_id, {"tabId": tab_id, "revision": revision, "mime_type": mime, "data": data,
                                     "width": image.width(), "height": image.height(), "context": context, "renderedFrom": "background-preview"}, window_id=studio_obj.window_id)

    if studio_obj.retired or getattr(studio_obj.pool, "_shutdown", False):
        if preview_jobs is not None: preview_jobs.discard(preview_job)
        if bridge is not None: bridge.complete(request_id, None, "Background preview cancelled", window_id=studio_obj.window_id)
        return
    studio_obj._submit(work, done, False)

def clear_agent_viewport_capture(studio_obj: Any, pending: dict) -> None:
    if studio_obj._agent_viewport_capture is not pending:
        return
    studio_obj._agent_viewport_capture = None
    try:
        pending["window"].frameSwapped.disconnect(studio_obj._agent_viewport_frame_swapped)
    except (AttributeError, RuntimeError, TypeError):
        pass

def agent_viewport_fallback(studio_obj: Any, request_id: str) -> None:
    pending = studio_obj._agent_viewport_capture
    if pending is not None and pending["requestId"] == request_id:
        studio_obj._capture_agent_viewport(pending)

def agent_viewport_frame_swapped(studio_obj: Any) -> None:
    pending = studio_obj._agent_viewport_capture
    if pending is not None:
        studio_obj._capture_agent_viewport(pending)

def capture_agent_viewport(studio_obj: Any, pending: dict) -> None:
    if studio_obj._agent_viewport_capture is not pending:
        return
    bridge = getattr(studio_obj.session, "agent_bridge", None)
    request_id, tab_id, revision = pending["requestId"], pending["tabId"], pending["revision"]
    if bridge is None or not studio_obj._agent_viewport_pending(request_id, tab_id):
        studio_obj._clear_agent_viewport_capture(pending)
        return
    try:
        if studio_obj._agent_viewport_revision(tab_id) != revision:
            raise ValueError("The live tab changed before its viewport was captured")
        window = pending["window"]
        reader = window.property("reader") or window.findChild(QObject, "documentReader")
        if reader is None or not callable(getattr(reader, "mapToScene", None)):
            raise ValueError("The desktop WebEngine view is unavailable")
        bounds = pending["bounds"]
        view_width, view_height = float(reader.width()), float(reader.height())
        if view_width <= 0 or view_height <= 0:
            raise ValueError("The desktop WebEngine view has no visible area")
        scale_x, scale_y = view_width / bounds["viewportWidth"], view_height / bounds["viewportHeight"]
        top_left = reader.mapToScene(QPointF(bounds["x"] * scale_x, bounds["y"] * scale_y))
        bottom_right = reader.mapToScene(QPointF((bounds["x"] + bounds["width"]) * scale_x, (bounds["y"] + bounds["height"]) * scale_y))
        image = window.grabWindow()
        if image is None or image.isNull():
            raise ValueError("The desktop reader frame could not be captured")
        pixel_scale_x, pixel_scale_y = image.width() / max(1.0, float(window.width())), image.height() / max(1.0, float(window.height()))
        left = max(0, math.floor(min(top_left.x(), bottom_right.x()) * pixel_scale_x))
        top = max(0, math.floor(min(top_left.y(), bottom_right.y()) * pixel_scale_y))
        right = min(image.width(), math.ceil(max(top_left.x(), bottom_right.x()) * pixel_scale_x))
        bottom = min(image.height(), math.ceil(max(top_left.y(), bottom_right.y()) * pixel_scale_y))
        if right <= left or bottom <= top:
            raise ValueError("The reader viewport is outside the captured window")
        crop = image.copy(QRect(left, top, right - left, bottom - top))
        longest = max(crop.width(), crop.height())
        if longest > pending["width"]:
            ratio = pending["width"] / longest
            crop = crop.scaled(max(1, round(crop.width() * ratio)), max(1, round(crop.height() * ratio)),
                               Qt.AspectRatioMode.KeepAspectRatio, Qt.TransformationMode.SmoothTransformation)
        if studio_obj._agent_viewport_revision(tab_id) != revision:
            raise ValueError("The live tab changed while its viewport was being captured")
        if not bridge.has_pending(request_id, studio_obj.window_id, "render_tab", tab_id):
            studio_obj._clear_agent_viewport_capture(pending)
            return
        mime_type, data = _encode_viewport_image(crop, pending.get("imageFormat", "png"), jpeg_quality=90, require_saved=True)
        result = dict(pending["context"])
        result.update({"mime_type": mime_type, "data": data, "width": crop.width(), "height": crop.height(),
                       "revision": revision, "tabId": tab_id, "windowId": studio_obj.window_id})
        studio_obj._clear_agent_viewport_capture(pending)
        bridge.complete(request_id, result, window_id=studio_obj.window_id)
    except Exception as error:
        studio_obj._clear_agent_viewport_capture(pending)
        bridge.complete(request_id, None, str(error)[:1000], window_id=studio_obj.window_id)
