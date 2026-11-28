"""Standalone export destination, native export execution, and agent export job helpers for Studio."""
from __future__ import annotations

import base64, hashlib, json, os, re, stat, subprocess, sys, tempfile, time, uuid
from pathlib import Path

try:
    from . import folder_ops
    from .agent_exports import validate_pdf_options
except ImportError:
    import folder_ops
    from agent_exports import validate_pdf_options

EXPORT_SUFFIXES = {"pdf": ".pdf", "smd": ".smd", "md": ".md", "mdzip": ".zip"}
PAYLOAD_FORMATS = {".pdf": "pdf", ".smd": "smd", ".md": "md", ".markdown": "md", ".txt": "md", ".zip": "mdzip"}
AGENT_EXPORT_EXTENSIONS = {"pdf": ".pdf", "smd": ".smd", "md": ".md", "mdzip": ".zip"}
AGENT_EXPORT_COMMANDS = {"pdf": "export_pdf_native", "smd": "export_fmd_native", "md": "export_markdown_native", "mdzip": "export_markdown_native"}
AGENT_EXPORT_MIMES = {"pdf": "application/pdf", "smd": "application/x-supermd", "md": "text/markdown", "mdzip": "application/zip"}


def _studio_module():
    mod = sys.modules.get("studio") or sys.modules.get("desktop.studio")
    if mod is not None:
        return mod
    try:
        from . import studio as mod  # type: ignore[no-redef]
    except ImportError:
        import studio as mod  # type: ignore[no-redef]
    return mod


def export_destination(value: str, format: str) -> Path:
    # Known payload extensions are not merely dotted stem names. In particular,
    # .fmd is an older portable format and must not be silently rewritten as
    # .fmd.pdf/.fmd.smd.
    if format not in EXPORT_SUFFIXES:
        raise ValueError("Unsupported export format")
    destination = _studio_module().local_path(value)
    if not destination.name or destination.is_dir():
        raise ValueError("Choose a file destination for the export")
    expected = EXPORT_SUFFIXES[format]
    existing_suffix = destination.suffix.casefold()
    if existing_suffix == ".fmd":
        raise ValueError("Legacy .fmd files are not a supported export destination; choose .smd or a new filename")
    if existing_suffix in PAYLOAD_FORMATS:
        if PAYLOAD_FORMATS[existing_suffix] != format:
            raise ValueError(f"Choose a filename ending in {expected} for this export")
        return destination
    target = destination.with_name(destination.name + expected)
    if target.exists():
        raise ValueError(f"The {expected} destination already exists; choose its full filename to confirm replacement")
    return target


def default_export_location(studio_obj, format: str):
    suffix = "zip" if format == "mdzip" else format
    filename = (folder_ops.note_stem(studio_obj._current()["name"]) or "Untitled") + "." + suffix
    return _studio_module().QUrl.fromLocalFile(
        str(studio_obj._default_output_directory() / folder_ops._pure_path(filename).name)
    )


def export_to(studio_obj, value: str, format: str) -> None:
    if studio_obj.pending_export:
        studio_obj.message = "An export is already in progress; finish or cancel it before choosing another destination"
        studio_obj._emit(False)
        return
    studio_obj.pending_save_as = ""
    studio_obj.pending_export = ""
    try:
        studio_obj.pending_export = str(_studio_module().export_destination(value, format))
    except ValueError as error:
        studio_obj.message = str(error)
        studio_obj._emit(False)
        return
    if format in ("md", "mdzip"):
        studio_obj.readerCall.emit(f"window.supermdExportMarkdown?.({str(format == 'mdzip').lower()})")
    elif format == "smd":
        studio_obj.readerCall.emit("window.supermdPortable?.(false)")
    else:
        studio_obj.readerCall.emit(f"window.supermdExport?.({json.dumps(studio_obj.settings['pdf'])})")


def agent_export_metadata(path: Path, format: str) -> dict:
    digest = hashlib.sha256()
    size = 0
    with path.open("rb") as source:
        while True:
            chunk = source.read(1024 * 1024)
            if not chunk:
                break
            size += len(chunk)
            digest.update(chunk)
    return {"path": str(path), "filename": path.name, "format": format, "bytes": size, "sha256": digest.hexdigest()}


def agent_export_native(studio_obj, request_id: str, args: dict) -> None:
    tab_id = args.get("id")
    target = next((tab for tab in studio_obj.tabs if tab["id"] == tab_id), None)
    if target is None or target["id"] != studio_obj.active:
        raise ValueError("Export the currently active live tab")
    fmt = args.get("format")
    if fmt not in AGENT_EXPORT_EXTENSIONS:
        raise ValueError("export format must be pdf, smd, md, or mdzip")
    expected = args.get("expectedRevision")
    current = hashlib.sha256(target["content"].encode("utf-8")).hexdigest()
    if not isinstance(expected, str) or expected != current:
        raise ValueError("Live tab revision changed; inspect it again before exporting")
    if studio_obj.pending_export or studio_obj.pending_save_as:
        raise ValueError("Finish the current save or export before starting another one")
    content, assets = args.get("content"), args.get("assets", {})
    if not isinstance(content, str) or len(content.encode("utf-8")) > 20_000_000:
        raise ValueError("Prepared export content must be a string under 20 MB")
    if not isinstance(assets, dict) or len(assets) > 512 or any(
        not isinstance(k, str) or not isinstance(v, str) for k, v in assets.items()
    ):
        raise ValueError("Prepared export assets are invalid")
    if sum(len(value) for value in assets.values()) > 110_000_000:
        raise ValueError("Prepared export assets exceed the bounded total size")
    options = args.get("options", {})
    if fmt == "pdf":
        if not isinstance(options, dict):
            raise ValueError("PDF options must be an object")
        supplied = dict(options)
        options = {**_studio_module().DEFAULT_PDF, **studio_obj.settings.get("pdf", {}), **supplied}
        options["themeAccent"] = supplied.get("themeAccent") or studio_obj._colors().get("primary", "#386a57")
        options = validate_pdf_options(options)
    elif not isinstance(options, dict):
        raise ValueError("Export options must be an object")
    archive = bool(args.get("archive")) or bool(options.get("archive")) or fmt == "mdzip"
    if archive and fmt == "md":
        fmt = "mdzip"
    output = studio_obj._agent_export_path(args.get("filename", ""), fmt, target)
    studio_obj.pending_export = str(output)
    job_id = uuid.uuid4().hex
    while len(studio_obj._agent_job_records) >= 20:
        removable = next(
            (key for key, value in studio_obj._agent_job_records.items()
             if value.get("status") in ("completed", "failed", "cancelled")),
            None,
        )
        if removable is None:
            studio_obj.pending_export = ""
            output.unlink(missing_ok=True)
            raise ValueError("The desktop already has 20 active agent export jobs")
        studio_obj._agent_job_records.pop(removable, None)
    studio_obj._agent_exports[request_id] = {"path": str(output), "format": fmt, "jobId": job_id}
    studio_obj._agent_job_records[job_id] = {
        "jobId": job_id, "action": "export_document", "status": "running",
        "filename": output.name, "format": fmt, "path": str(output), "bytes": 0,
    }
    command = AGENT_EXPORT_COMMANDS[fmt]
    forwarded = {
        "id": tab_id, "content": content, "assets": assets, "options": options,
        "expectedRevision": expected, "save": False, "jobId": job_id, "archive": archive,
    }
    try:
        studio_obj.post(request_id, command, json.dumps(forwarded, ensure_ascii=False, separators=(",", ":")))
        studio_obj.replied.emit(
            request_id,
            json.dumps({"jobId": job_id, "status": "running", "filename": output.name, "format": fmt}),
            "",
        )
    except Exception:
        studio_obj._agent_exports.pop(request_id, None)
        studio_obj.pending_export = ""
        try:
            output.unlink(missing_ok=True)
        except OSError:
            pass
        raise


def agent_job_status(studio_obj, job_id) -> dict:
    if not isinstance(job_id, str) or not job_id:
        raise ValueError("jobId is required")
    record = studio_obj._agent_job_records.get(job_id)
    if not record:
        raise ValueError("Export job is unavailable or expired")
    result = {key: value for key, value in record.items() if key != "path" and not key.startswith("_")}
    if record.get("status") == "completed":
        if record.get("path"):
            result["path"] = record["path"]
        if record.get("action") == "export_document" and isinstance(record.get("_fingerprint"), dict):
            result["downloadable"] = True
    return result


def agent_export_chunk(studio_obj, job_id, offset: int = 0, limit: int = 262_144) -> dict:
    """Read one bounded segment from a completed, registered export artifact."""
    if not isinstance(job_id, str) or not job_id or len(job_id) > 128:
        raise ValueError("jobId is required")
    record = studio_obj._agent_job_records.get(job_id)
    if not isinstance(record, dict) or record.get("action") != "export_document":
        raise ValueError("Export artifact job is unavailable or is not an export")
    if record.get("status") != "completed":
        raise ValueError("Export artifact is not completed")
    if not isinstance(offset, int) or isinstance(offset, bool) or offset < 0:
        raise ValueError("offset must be a nonnegative byte offset")
    if not isinstance(limit, int) or isinstance(limit, bool) or not 1 <= limit <= 524_288:
        raise ValueError("limit must be between 1 and 524,288 bytes")
    total = record.get("bytes")
    fingerprint = record.get("_fingerprint")
    expected_hash = record.get("sha256")
    file_path = record.get("path")
    fmt = record.get("format")
    filename = record.get("filename")
    if not isinstance(total, int) or isinstance(total, bool) or total < 0:
        raise ValueError("Export artifact metadata is invalid or incomplete")
    if offset > total:
        raise ValueError("offset must be between 0 and the artifact byte count")
    if (not isinstance(fingerprint, dict) or fmt not in AGENT_EXPORT_MIMES
            or not isinstance(filename, str) or not filename
            or not isinstance(file_path, str) or not isinstance(expected_hash, str)
            or not re.fullmatch(r"[0-9a-f]{64}", expected_hash)):
        raise ValueError("Export artifact metadata is invalid or incomplete")
    path = Path(file_path)
    flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0)
    registered_identity = (
        fingerprint.get("device"), fingerprint.get("inode"),
        fingerprint.get("size"), fingerprint.get("mtimeNs"),
    )
    try:
        path_stat = path.stat(follow_symlinks=False)
        if (path.is_symlink() or not stat.S_ISREG(path_stat.st_mode)
                or (path_stat.st_dev, path_stat.st_ino, path_stat.st_size, path_stat.st_mtime_ns) != registered_identity):
            raise ValueError("Export artifact changed after completion")
        fd = os.open(path, flags)
    except (OSError, ValueError) as error:
        raise ValueError("Export artifact changed after completion") from error
    try:
        before = os.fstat(fd)
        actual_identity = (before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns)
        if not stat.S_ISREG(before.st_mode) or actual_identity != registered_identity:
            raise ValueError("Export artifact changed after completion")
        with os.fdopen(fd, "rb") as stream:
            fd = -1
            stream.seek(offset)
            body = stream.read(min(limit, total - offset))
            after = os.fstat(stream.fileno())
            if ((after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns) != actual_identity
                    or len(body) != min(limit, total - offset)):
                raise ValueError("Export artifact changed during retrieval")
    except OSError as error:
        raise ValueError("Export artifact could not be read") from error
    finally:
        if fd >= 0:
            os.close(fd)
    next_offset = offset + len(body)
    return {
        "jobId": job_id, "filename": filename, "format": fmt,
        "mimeType": AGENT_EXPORT_MIMES[fmt], "bytes": total, "sha256": expected_hash,
        "offset": offset, "nextOffset": next_offset if next_offset < total else None,
        "body": base64.b64encode(body).decode("ascii"),
    }


def execute_export_markdown_native(output: str, args: dict, captured: dict, export_result) -> dict:
    if not output:
        raise ValueError("Choose a Markdown destination")
    if not isinstance(args.get("archive", False), bool):
        raise ValueError("archive must be a boolean")
    if captured.get("path") and Path(output).resolve() == Path(captured["path"]).resolve():
        raise ValueError("Markdown export must not overwrite the original note")
    studio_mod = _studio_module()
    if args.get("archive", False):
        studio_mod.write_markdown_zip(Path(output), args.get("content"), args.get("assets", {}))
    else:
        studio_mod.write_markdown_export(Path(output), args.get("content"), args.get("assets", {}))
    return export_result(output)


def execute_export_smd_native(output: str, args: dict, export_result) -> dict:
    target_path = Path(output)
    _studio_module().write_portable(target_path, args["content"], args["assets"])
    result_data = export_result(target_path)
    try:
        st = target_path.stat()
        result_data["_stamp"] = (st.st_mtime_ns, st.st_size)
    except OSError:
        pass
    return result_data


def execute_export_pdf_native(studio_obj, output: str, args: dict, export_job, export_result) -> dict:
    job = export_job
    assert job is not None
    destination = Path(output)
    stage = destination.with_name(f".{destination.name}.{uuid.uuid4().hex}.stage.pdf")
    process = None
    rust_temp = None
    try:
        job.check()
        if not destination.parent.is_dir():
            raise ValueError("The PDF destination folder is unavailable")
        engine = studio_obj._engine()
        args["assets"].update(studio_obj.session.font_store.pdf_assets(args["options"]["fontFamily"]))
        job.check()
        with tempfile.TemporaryFile() as request_file, tempfile.TemporaryFile() as stdout_file, tempfile.TemporaryFile() as stderr_file:
            for chunk in json.JSONEncoder(ensure_ascii=False).iterencode(args):
                request_file.write(chunk.encode("utf-8"))
            request_file.flush()
            request_file.seek(0)
            job.check()
            process = subprocess.Popen(
                [str(engine), "export-json", str(stage)],
                stdin=request_file, stdout=stdout_file, stderr=stderr_file,
            )
            rust_temp = stage.with_name(f".{stage.name}.{process.pid}.tmp")
            job.attach_process(process)
            deadline = time.monotonic() + 120
            while True:
                try:
                    process.wait(timeout=0.1)
                    break
                except subprocess.TimeoutExpired:
                    if not job.cancelled.is_set() and time.monotonic() < deadline:
                        continue
                    job.stop_process()
                    try:
                        process.wait(timeout=2)
                    except subprocess.TimeoutExpired:
                        try:
                            process.kill()
                        except OSError:
                            pass
                        process.wait()
                    job.check()
                    raise ValueError("PDF export timed out")
            job.check()
            stderr_file.seek(0)
            error_text = stderr_file.read(64 * 1024).decode("utf-8", errors="replace").strip()
        if process.returncode:
            raise ValueError(error_text or "PDF export failed")
        if not stage.is_file() or stage.stat().st_size < 5:
            raise ValueError("PDF export produced an incomplete file")
        with stage.open("rb") as generated:
            if generated.read(5) != b"%PDF-":
                raise ValueError("PDF export produced an invalid file")
        job.promote(
            stage,
            destination,
            lambda: studio_obj.readerCall.emit("window.supermdExportPhase?.(" + json.dumps(job.job_id) + ",'publishing')"),
        )
        return export_result(output)
    finally:
        for owned in (stage, rust_temp):
            if owned is not None:
                try:
                    owned.unlink(missing_ok=True)
                except OSError:
                    pass
        studio_obj._export_jobs.discard(job.job_id, job)


def fail_agent_export(studio_obj, request_id: str, agent_export_info: dict, error) -> None:
    record = studio_obj._agent_job_records.get(agent_export_info.get("jobId"))
    if record:
        record.update(status="failed", error=str(error)[:1000])
    try:
        reserved = Path(agent_export_info["path"])
        if reserved.exists() and reserved.stat().st_size == 0:
            reserved.unlink()
    except OSError:
        pass
    studio_obj._agent_exports.pop(request_id, None)


def finalize_standalone_export(studio_obj, exported_path: str) -> None:
    studio_obj.message = f"Exported {Path(exported_path).name}"
    if _studio_module().is_searchable_note_name(Path(exported_path).name):
        studio_obj._refresh_open_folder_trees(exported_path)


def complete_agent_export(studio_obj, request_id: str, agent_export_info: dict, result: dict) -> None:
    record = studio_obj._agent_job_records.get(agent_export_info.get("jobId"))
    if record:
        artifact_path = Path(result.get("path", ""))
        try:
            artifact_stat = artifact_path.stat(follow_symlinks=False)
            artifact_bytes = result.get("bytes")
            artifact_hash = result.get("sha256")
            if (artifact_path.is_symlink() or not stat.S_ISREG(artifact_stat.st_mode)
                    or not isinstance(artifact_bytes, int) or isinstance(artifact_bytes, bool)
                    or artifact_bytes != artifact_stat.st_size
                    or not isinstance(artifact_hash, str)
                    or not re.fullmatch(r"[0-9a-f]{64}", artifact_hash)):
                raise ValueError("Export artifact metadata does not match the completed file")
            record.update(
                status="completed", bytes=artifact_bytes, sha256=artifact_hash,
                path=str(artifact_path), filename=artifact_path.name,
                _fingerprint={"device": artifact_stat.st_dev, "inode": artifact_stat.st_ino,
                              "size": artifact_stat.st_size, "mtimeNs": artifact_stat.st_mtime_ns},
            )
        except (OSError, ValueError) as failure:
            record.update(status="failed", error=str(failure)[:500])
    if result.get("path"):
        studio_obj._agent_owned_files.add(str(Path(result["path"]).resolve()))
    studio_obj._agent_exports.pop(request_id, None)


def cleanup_failed_post_agent_export(studio_obj, request_id: str) -> None:
    agent_export = studio_obj._agent_exports.pop(request_id, None)
    if agent_export:
        if studio_obj.pending_export == agent_export.get("path"):
            studio_obj.pending_export = ""
        try:
            reserved = Path(agent_export["path"])
            if reserved.exists() and reserved.stat().st_size == 0:
                reserved.unlink()
        except (OSError, TypeError, KeyError):
            pass
