"""WebChannel reader IPC command router and worker dispatch helpers for Studio."""
from __future__ import annotations

import base64, json, math, urllib.parse, uuid
from pathlib import Path
from typing import Any

_EXPECTED_EXPORT_SUFFIXES = {"export_pdf_native": (".pdf",), "export_markdown_native": (".md", ".markdown", ".txt", ".zip"), "export_fmd_native": (".smd",)}

def _studio_module():
    if __package__: from . import studio as mod
    else: import studio as mod
    return mod

def _set_agent_banner_unreviewed(studio_obj: Any, request_id: str, tab_id: Any, unreviewed: bool) -> None:
    target = next((t for t in studio_obj.tabs if t["id"] == tab_id), None)
    if target and bool(target.get("agent_unreviewed")) != unreviewed:
        target["agent_unreviewed"] = unreviewed
        studio_obj.recovery_timer.start(800)
        studio_obj._emit(False)
    studio_obj.replied.emit(request_id, "true", "")

def _handle_immediate_command(studio_obj: Any, request_id: str, command: str, args: dict) -> bool:
    st = _studio_module()
    if command == "agent_result":
        if (bridge := getattr(studio_obj.session, "agent_bridge", None)) is not None:
            error = args.get("error", "")
            if error and not isinstance(error, str): error = "Live tab operation failed"
            bridge.complete(request_id, args.get("result"), error or "", window_id=studio_obj.window_id)
    elif command == "agent_render_bounds":
        bridge = getattr(studio_obj.session, "agent_bridge", None)
        if bridge is not None and bridge.has_pending(request_id, studio_obj.window_id, "render_tab", args.get("tabId", "")):
            if args.get("error"):
                bridge.complete(request_id, None, str(args["error"])[:1000], window_id=studio_obj.window_id)
            else:
                try: studio_obj._begin_agent_viewport_capture(request_id, args)
                except Exception as error: bridge.complete(request_id, None, str(error)[:1000], window_id=studio_obj.window_id)
    elif command == "agent_export_native":
        studio_obj._agent_export_native(request_id, args)
    elif command == "cancel_export":
        job_id = args.get("jobId")
        if not isinstance(job_id, str) or not job_id or len(job_id) > 128: raise ValueError("Invalid PDF export job id")
        studio_obj.replied.emit(request_id, json.dumps({"cancelled": studio_obj._export_jobs.cancel(job_id)}), "")
    elif command == "reader_ready":
        studio_obj.ready, studio_obj._last_reader_text = True, None
        studio_obj._last_reader_agent_seq.clear()
        studio_obj._emit()
        studio_obj.replied.emit(request_id, "true", "")
    elif command in ("agent_banner_shown", "agent_banner_dismissed"):
        _set_agent_banner_unreviewed(studio_obj, request_id, args.get("id"), command == "agent_banner_shown")
    elif command == "reader_chrome":
        action = args.get("action")
        if action not in ("show", "hide", "toggle"): raise ValueError("Invalid reading chrome action")
        if studio_obj.fullscreen: studio_obj.chromeRequested.emit(action)
        studio_obj.replied.emit(request_id, "true", "")
    elif command == "reader_overlay_changed":
        studio_obj.reader_overlay, studio_obj.image_overlay = bool(args.get("open")), bool(args.get("image"))
        studio_obj._emit(False)
        studio_obj.replied.emit(request_id, "true", "")
    elif command == "editor_focus_changed":
        studio_obj.replied.emit(request_id, "true", "")
    elif command == "typewriter_scroll":
        enabled = args.get("enabled")
        if not isinstance(enabled, bool): raise ValueError("Invalid typewriter scroll value")
        if studio_obj.settings["typewriterScroll"] != enabled:
            studio_obj.settings["typewriterScroll"] = enabled
            studio_obj._preferences()
            studio_obj._emit()
        studio_obj.replied.emit(request_id, "true", "")
    elif command == "copy_image_native":
        body = args.get("body")
        if args.get("mimeType") != "image/png" or not isinstance(body, str) or len(body) > 34_000_000:
            raise ValueError("Clipboard image must be a PNG under 25 MB")
        try: data = base64.b64decode(body, validate=True)
        except (ValueError, base64.binascii.Error): raise ValueError("Clipboard image is not valid base64") from None
        if not data.startswith(b"\x89PNG\r\n\x1a\n") or len(data) < 24 or len(data) > 25_000_000:
            raise ValueError("Clipboard image is not a valid PNG")
        width, height = int.from_bytes(data[16:20], "big"), int.from_bytes(data[20:24], "big")
        if not 0 < width <= 4096 or not 0 < height <= 4096 or width * height > 16_000_000:
            raise ValueError("Clipboard image dimensions exceed the limit")
        image = st.QImage.fromData(data, "PNG")
        if image.isNull(): raise ValueError("Clipboard PNG could not be decoded")
        st.QGuiApplication.clipboard().setImage(image)
        studio_obj.replied.emit(request_id, "true", "")
    elif command == "copy_text":
        text = args.get("text")
        if not isinstance(text, str) or len(text) > 2_000_000: raise ValueError("Clipboard text is too large or invalid")
        st.QGuiApplication.clipboard().setText(text)
        studio_obj.replied.emit(request_id, "true", "")
    elif command == "apply_bundled_theme":
        preset_id = args.get("id")
        if not isinstance(preset_id, str) or not preset_id: raise ValueError("Invalid bundled theme id")
        studio_obj._apply_bundled_theme(preset_id, lambda res, err: studio_obj.replied.emit(request_id, json.dumps(res) if not err else "null", err or ""))
    elif command == "reading_position":
        target, location = next((t for t in studio_obj.tabs if t["id"] == args.get("id")), None), args.get("location")
        if target and target["path"] and studio_obj.settings["restorePosition"] and isinstance(location, dict):
            if any(isinstance(location.get(k), bool) or not isinstance(location.get(k), (int, float))
                   or not math.isfinite(location[k]) or location[k] < 0 for k in ("top", "offset", "zoom")):
                raise ValueError("Invalid reading position")
            if location.get("mode") not in ("reader", "live", "editor", "split"): raise ValueError("Invalid reading mode")
            studio_obj.session.locations.pop(target["path"], None)
            studio_obj.session.locations[target["path"]] = {k: location[k] for k in ("top", "offset", "zoom", "mode")}
            while len(studio_obj.session.locations) > 200: studio_obj.session.locations.pop(next(iter(studio_obj.session.locations)))
            studio_obj.position_timer.start(500)
        studio_obj.replied.emit(request_id, "true", "")
    elif command == "document_outline":
        target, headings = next((t for t in studio_obj.tabs if t["id"] == args.get("id")), None), args.get("headings", [])
        if not isinstance(headings, list) or len(headings) > 2000: raise ValueError("Invalid outline")
        changed, name_changed = bool(target and target.get("outline", []) != headings), False
        if target:
            if changed:
                target["outline"] = headings
                studio_obj._outline_revision = getattr(studio_obj, "_outline_revision", 0) + 1
            if not target["path"] and target["name"].startswith("Untitled") and headings:
                title = "".join(c for c in str(headings[0].get("title", "")).strip() if c not in '/\\:*?"<>|' and ord(c) >= 32).strip(". ")[:120]
                if title:
                    new_name = title + (".smd" if target["portable"] else ".md")
                    name_changed, target["name"] = new_name != target["name"], new_name
        if changed or name_changed: studio_obj._emit(False)
        studio_obj.replied.emit(request_id, "true", "")
    elif command == "document_flushed":
        operation = args.get("operation")
        if operation == studio_obj.flush_operation and operation is not None:
            if target := next((t for t in studio_obj.tabs if t["id"] == args["id"]), None): target["content"] = args["content"]
            if operation["action"] in ("move_tab", "detach_tab", "reload_reader"):
                view_tab, view = next((t for t in studio_obj.tabs if t["id"] == args.get("viewId")), None), args.get("viewState")
                if view_tab and isinstance(view, dict) and len(json.dumps(view)) <= 12_000_000: view_tab["viewState"] = view
            studio_obj.flush_timer.stop()
            studio_obj.flush_operation = None
            studio_obj._recover()
            studio_obj._after_flush(operation)
        studio_obj.replied.emit(request_id, "true", "")
    elif command in ("document_sync", "document_patch", "document_resync"):
        target = next((t for t in studio_obj.tabs if t["id"] == args.get("id")), None)
        def commit_edit(content):
            was_dirty = target["content"] != target["saved"]
            target["content"] = content
            if target["id"] == studio_obj.active: studio_obj._last_reader_text = (target["id"], content)
            studio_obj.recovery_timer.start(800)
            studio_obj.autosave_timer.start(900)
            if was_dirty != (content != target["saved"]): studio_obj._emit(False)
        result = studio_obj.reader_edits.apply(command, args, target["content"] if target else None, commit_edit)
        if command == "document_resync" and not result["accepted"] and isinstance(args.get("content"), str):
            destination = studio_obj.data / "reader-conflicts" / (uuid.uuid4().hex + ".json")
            payload = {"id": args.get("id"), "content": args["content"], "reason": "Native and renderer revisions diverged"}
            def preserve_done(_value, error):
                studio_obj.message = ("Conflicting editor draft preserved for recovery." if not error
                                      else "Could not preserve the conflicting draft; keep the editor open. " + str(error))
                studio_obj._emit(False)
                studio_obj.replied.emit(request_id, json.dumps({**result, "draftSaved": not bool(error)}), "")
            def preserve_work():
                destination.parent.mkdir(parents=True, exist_ok=True)
                return _studio_module().atomic_json(destination, payload)
            studio_obj._submit(preserve_work, preserve_done, False)
        else:
            studio_obj.replied.emit(request_id, json.dumps(result), "")
    elif command == "document_changed":
        target = next((t for t in studio_obj.tabs if t["id"] == args["id"]), None)
        studio_obj.reader_edits.clear(args["id"])
        if target:
            target["content"] = args["content"]
            if target["id"] == studio_obj.active: studio_obj._last_reader_text = (target["id"], target["content"])
        studio_obj.recovery_timer.start(800)
        studio_obj.autosave_timer.start(900)
        studio_obj._emit(False)
        studio_obj.replied.emit(request_id, "true", "")
    elif command == "resolve_reader_asset":
        document, source = args.get("documentPath"), args.get("source")
        if not isinstance(document, str) or not isinstance(source, str): raise ValueError("Invalid reader asset request")
        if (tab := studio_obj._find_open_tab(document)) is None: raise ValueError("The note for this image is no longer open")
        captured = {**tab, "assets": dict(tab["assets"])}
        owner_id, tab_id, embedded = studio_obj.window_id, tab["id"], captured["assets"].get(source)
        cached = studio_obj.session.reader_assets.resolve_cached(owner_id, tab_id, source, embedded) if embedded is not None else None
        def asset_done(resolved, error):
            mod, current = _studio_module(), next((item for item in studio_obj.tabs if item["id"] == tab_id), None)
            if error:
                studio_obj.replied.emit(request_id, "null", error)
            elif current is None or not studio_obj.session.reader_asset_source_is_current(
                owner_id, tab_id, source, mod._asset_identity(resolved.get("embedded_data")) if resolved.get("embedded_data") else 0, resolved.get("path", "")
            ):
                studio_obj.session.reader_assets.evict_source(owner_id, tab_id, source)
                studio_obj.replied.emit(request_id, "null", "The note or image changed while it was being resolved")
            else:
                try:
                    url = studio_obj.session.reader_assets.register(owner_id, tab_id, source, resolved)
                    studio_obj.replied.emit(request_id, json.dumps({"url": url, "mime": resolved["mime"]}), "")
                except Exception as failure:
                    studio_obj.replied.emit(request_id, "null", str(failure))
        studio_obj._submit(lambda: cached if cached is not None else _studio_module().resolve_source(captured, source), asset_done, False)
    elif command == "zoom_changed":
        studio_obj.settings["fullZoom" if args.get("fullscreen", studio_obj.fullscreen) else "normalZoom"] = max(40, min(300, args["zoom"]))
        studio_obj.preference_timer.start(500)
        studio_obj._emit(False)
        studio_obj.replied.emit(request_id, "true", "")
    elif command == "open_external_url":
        url = args.get("url")
        if not isinstance(url, str) or len(url) > 4096: raise ValueError("Invalid external URL")
        if urllib.parse.urlparse(url).scheme.lower() not in ("http", "https", "mailto"): raise ValueError("Unsupported external URL scheme")
        st.QDesktopServices.openUrl(st.QUrl(url))
        studio_obj.replied.emit(request_id, "true", "")
    elif command in ("open_workspace_link", "open_relative_note"):
        raw_target, raw_fragment = args.get("target"), args.get("fragment")
        if not raw_fragment: raw_fragment = args.get("heading", "")
        if raw_fragment is None: raw_fragment = ""
        wikilink = bool(args.get("wikilink", False)) if command == "open_workspace_link" else False
        doc_ref = args.get("documentPath", "")
        if not isinstance(raw_target, str) or len(raw_target) > 4096 or not isinstance(raw_fragment, str) or len(raw_fragment) > 1024:
            raise ValueError("Invalid workspace link")
        source_tab = studio_obj._find_open_tab(doc_ref, canonicalize_local=True) if doc_ref else studio_obj._current()
        if source_tab is None: raise ValueError("The note for this link is no longer open.")
        note_path, folder = source_tab["path"], studio_obj.folder
        if studio_obj.recovery_timer.isActive(): studio_obj.recovery_timer.stop()
        studio_obj._recover()
        if studio_obj.autosave_timer.isActive() or (studio_obj.settings.get("autosave") and note_path and studio_obj._is_dirty(source_tab)):
            studio_obj.autosave_timer.stop()
            studio_obj._autosave()
        studio_obj._activation_generation += 1
        link_generation = studio_obj._activation_generation
        def resolve_done(resolved_path, error):
            if studio_obj.retired:
                studio_obj.replied.emit(request_id, json.dumps({"opened": False}), "")
                return
            if error:
                studio_obj.message = str(error)
                studio_obj._emit(False)
                studio_obj.replied.emit(request_id, json.dumps({"opened": False, "message": str(error)}), "")
                return
            fragment = raw_fragment.strip()
            heading_payload = {"heading": fragment, "token": uuid.uuid4().hex} if fragment else None
            def opened(opened_tab, open_error):
                if open_error or opened_tab is None:
                    if open_error:
                        studio_obj.message = str(open_error)
                        studio_obj._emit(False)
                    studio_obj.replied.emit(request_id, json.dumps({"opened": False, "message": str(open_error or "Could not open note")}), "")
                else:
                    studio_obj.replied.emit(request_id, json.dumps({"opened": True, "id": opened_tab["id"], "path": opened_tab["path"]}), "")
            studio_obj._open_note(str(resolved_path), explicit=True, activation_generation=link_generation, completion_callback=opened, pending_heading=heading_payload)
        studio_obj._submit(lambda: _studio_module().resolve_workspace_link(
            raw_target, wikilink=wikilink, note_path=note_path, workspace_folder=folder, cache=studio_obj.session.workspace_links
        ), resolve_done, False)
    elif command == "export_failed":
        studio_obj.pending_export = studio_obj.pending_save_as = studio_obj.pending_save_as_tab = ""
        studio_obj.message = args["error"]
        studio_obj._emit(False)
        studio_obj.replied.emit(request_id, "true", "")
    elif command == "request_fmd_export":
        studio_obj.exportRequested.emit("smd")
        studio_obj.replied.emit(request_id, "true", "")
    else:
        return False
    return True

def _run_worker_command(
    studio_obj: Any, command: str, args: dict, captured: dict, *, context: dict | None, output: str,
    save_as: str, force_portable_overwrite: bool, python: str, python_job: Any, export_job: Any, export_result: Any,
) -> Any:
    st = _studio_module()
    if command == "load_asset": return studio_obj._asset(captured, args["source"])
    if command == "load_text_asset": return {"text": studio_obj._text_asset(captured, args["source"])}
    if command == "load_font": return studio_obj.session.font_store.reader(args["family"])
    if command == "cache_python_output":
        if context and args["result"].get("provenance", {}).get("verified") is False:
            raise ValueError("Legacy output cannot be promoted to verified output")
        if context and not st.pending_python.matches(args["source"], args["result"], context):
            raise ValueError("Only an unsaved native execution can be retried")
        studio_obj.session.python_outputs.store(args["source"], args["result"], context)
        if context: st.pending_python.forget(args["source"], context)
        return True
    if command == "load_python_output":
        value = studio_obj.session.python_outputs.load(args["source"], context)
        return {**value["result"], "provenance": value["provenance"]} if context and value else value
    if command == "fetch_resource": return studio_obj._fetch(args)
    if command == "import_images":
        results = []
        for image in args["images"]:
            mime, _ = st.image_data(image["data"])
            extension = next(k for k, v in st.MIMES.items() if v == mime)
            name = f"assets/import-{uuid.uuid4().hex}.{extension}"
            captured["assets"][name] = image["data"]
            results.append({"source": name, "alt": Path(image["name"]).stem})
        return results
    if command == "run_python":
        assert python_job is not None
        try:
            cwd = str(Path(captured["path"]).parent) if captured.get("path") else None
            result = studio_obj._python(python, args["code"], cwd, job=python_job)
        except st.python_runtime.PythonCellCancelled:
            return {"_cancelled": True}
        finally:
            studio_obj._python_jobs.discard(python_job)
        if python_job.cancelled.is_set(): return {"_cancelled": True}
        if context:
            try:
                studio_obj.session.python_outputs.store(args["code"], result, context)
                st.pending_python.forget(args["code"], context)
                saved = studio_obj.session.python_outputs.load(args["code"], context)
                return {**result, "provenance": saved["provenance"]}
            except (OSError, ValueError) as error:
                st.pending_python.remember(args["code"], result, context)
                return {**result, "provenance": {"verified": False, "unsaved": True, "reason": f"Could not save execution output: {error}"}}
        return result
    if command == "export_markdown_native":
        return st.studio_exports.execute_export_markdown_native(output, args, captured, export_result)
    if command == "export_fmd_native" and not args.get("save") and not save_as:
        return st.studio_exports.execute_export_smd_native(output, args, export_result)
    if command == "export_fmd_native":
        return st.studio_saves.execute_portable_tab_save(output, args, captured, force_portable_overwrite=force_portable_overwrite, export_result=export_result)
    if command == "export_pdf_native":
        return st.studio_exports.execute_export_pdf_native(studio_obj, output, args, export_job, export_result)
    raise ValueError(f"Unsupported command: {command}")

def _finish_worker_command(
    studio_obj: Any, request_id: str, command: str, args: dict, captured: dict, result: Any, error: Any,
    *, output: str, save_as: str, save_as_tab: str, is_portable_tab_save: bool, saving_tab_id: str, agent_export_info: dict | None,
) -> None:
    st = _studio_module()
    if is_portable_tab_save: studio_obj.saving.discard(saving_tab_id)
    if command.startswith("export_") and studio_obj.pending_export == output: studio_obj.pending_export = ""
    if error and studio_obj.pending_save_as == save_as: studio_obj.pending_save_as = studio_obj.pending_save_as_tab = ""
    if error:
        if agent_export_info: st.studio_exports.fail_agent_export(studio_obj, request_id, agent_export_info, error)
        else: studio_obj.replied.emit(request_id, "null", error)
        return
    if command == "run_python" and isinstance(result, dict) and result.get("_cancelled"):
        studio_obj.replied.emit(request_id, "null", "Python cell cancelled")
        return
    if command == "export_fmd_native" and isinstance(result, dict) and result.get("_conflict"):
        st.studio_saves.handle_portable_save_conflict(studio_obj, request_id, captured)
        return
    stamp = result.pop("_stamp", None) if isinstance(result, dict) else None
    if stamp and isinstance(result, dict) and result.get("path"):
        studio_obj.note_file_stamps[str(result["path"])] = stamp
    target = next((t for t in studio_obj.tabs if t["id"] == captured["id"]), None)
    if command == "import_images" and target:
        target["assets"].update(captured["assets"])
        target["assets_dirty"] = True
        studio_obj.recovery_timer.start(800)
        studio_obj.autosave_timer.start(900)
        studio_obj._emit(False)
    if command == "export_fmd_native" and ((args.get("save") and target) or save_as):
        st.studio_saves.finalize_portable_tab_save(studio_obj, args, captured, target, save_as=save_as, save_as_tab=save_as_tab)
    elif command.startswith("export_"):
        st.studio_exports.finalize_standalone_export(studio_obj, result["path"])
    if agent_export_info:
        st.studio_exports.complete_agent_export(studio_obj, request_id, agent_export_info, result)
    if not agent_export_info:
        studio_obj.replied.emit(request_id, json.dumps(result), "")

def post_message(studio_obj: Any, id: str, command: str, raw: str) -> None:
    if studio_obj.retired: return
    python_job = None
    try:
        if command == "save_media_native":
            if not isinstance(raw, str) or len(raw) > 36_100_000: raise ValueError("Media data is invalid or exceeds 25 MB")
            directory = studio_obj._media_download_directory()
            def media_work():
                st = _studio_module()
                parsed, source_str, body_start, body_end = st.Studio._parse_media_envelope(raw)
                return st.Studio._validate_and_write_media(parsed, directory, source_str=source_str, body_start=body_start, body_end=body_end)
            studio_obj._submit_write(media_work, lambda res, err: studio_obj.replied.emit(id, "null" if err else json.dumps(res), err or ""))
            return
        args = json.loads(raw)
        if _handle_immediate_command(studio_obj, id, command, args): return
        exports = getattr(studio_obj, "_agent_exports", None)
        agent_export_info = exports.get(id) if exports is not None else None
        context = args.get("context")
        if context is not None:
            if not isinstance(context, dict) or set(context) != {"document", "cell", "interpreter"}: raise ValueError("Invalid Python output context")
            if context["interpreter"] != (studio_obj.settings["python"] or "embedded"): raise ValueError("Python runtime changed; retry this operation")
        reference = args.get("id") or args.get("documentPath") or (context.get("document") if context else None)
        tab = studio_obj._find_open_tab(reference) if reference else studio_obj._current()
        if reference and tab is None: raise ValueError("The note for this operation is no longer open")
        if context and context["document"] not in (tab["id"], tab["path"]): raise ValueError("Python output belongs to another note")
        captured = {**tab, "assets": dict(tab["assets"]), "saved_assets": dict(tab.get("saved_assets", {}))}
        output, save_as, save_as_tab = studio_obj.pending_export, studio_obj.pending_save_as, studio_obj.pending_save_as_tab
        force_ids = getattr(studio_obj, "_force_overwrite_ids", ())
        force_portable_overwrite = bool(command == "export_fmd_native" and args.get("save") and captured["id"] in force_ids)
        if command == "export_fmd_native" and args.get("save") and hasattr(force_ids, "discard"): force_ids.discard(captured["id"])
        if command in _EXPECTED_EXPORT_SUFFIXES and not (command == "export_fmd_native" and args.get("save")):
            if not output or Path(output).suffix.casefold() not in _EXPECTED_EXPORT_SUFFIXES[command]:
                raise ValueError("The export destination does not match the requested file format; choose the destination again")
        saving_tab_id = (save_as_tab or captured["id"]) if (command == "export_fmd_native" and save_as) else captured["id"]
        is_portable_tab_save = command == "export_fmd_native" and not agent_export_info and bool(args.get("save") or save_as)
        if is_portable_tab_save:
            if saving_tab_id in studio_obj.saving or saving_tab_id in getattr(studio_obj, "_staging_tabs", ()):
                raise ValueError("A save is already in progress for this tab; retry after it finishes")
            studio_obj.saving.add(saving_tab_id)
        python, export_job = studio_obj.settings["python"], None
        if command == "export_pdf_native":
            if not output: raise ValueError("Choose a PDF destination before exporting")
            export_job = studio_obj._export_jobs.register(args.get("jobId") or uuid.uuid4().hex)
        elif command == "run_python":
            if studio_obj.retired or captured["id"] in getattr(studio_obj, "_closing_tabs", ()):
                raise ValueError("The note for this operation is no longer open")
            python_job = studio_obj._python_jobs.register(captured["id"])
        export_result = lambda path: studio_obj._agent_export_metadata(Path(path), agent_export_info["format"]) if agent_export_info else {"path": str(path)}
        work = lambda: _run_worker_command(
            studio_obj, command, args, captured, context=context, output=output, save_as=save_as,
            force_portable_overwrite=force_portable_overwrite, python=python, python_job=python_job, export_job=export_job, export_result=export_result,
        )
        finished = lambda result, error: _finish_worker_command(
            studio_obj, id, command, args, captured, result, error, output=output, save_as=save_as,
            save_as_tab=save_as_tab, is_portable_tab_save=is_portable_tab_save, saving_tab_id=saving_tab_id, agent_export_info=agent_export_info,
        )
        if is_portable_tab_save and (studio_obj.retired or getattr(studio_obj.writes, "_shutdown", False)):
            studio_obj.saving.discard(saving_tab_id)
            return
        if python_job is not None and (studio_obj.retired or getattr(studio_obj.pool, "_shutdown", False)):
            studio_obj._python_jobs.discard(python_job)
            return
        studio_obj._submit(work, finished, command in ("run_python", "export_fmd_native", "export_pdf_native", "export_markdown_native"),
                           studio_obj.writes if command in ("export_fmd_native", "export_markdown_native") else None)
    except Exception as error:
        if python_job is not None: studio_obj._python_jobs.discard(python_job)
        if hasattr(studio_obj, "_agent_exports"):
            _studio_module().studio_exports.cleanup_failed_post_agent_export(studio_obj, id)
        studio_obj.replied.emit(id, "null", str(error))
