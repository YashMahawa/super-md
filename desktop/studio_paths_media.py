"""Workspace drag-and-drop routing and streaming media writers for Studio."""
from __future__ import annotations

import base64, json, os, re
from collections.abc import Callable
from pathlib import Path
from typing import Any

from PySide6.QtCore import QEvent, QObject, QPointF, Qt
from PySide6.QtGui import QDragEnterEvent, QDragLeaveEvent, QGuiApplication

if __package__:
    from . import folder_ops
else:
    import folder_ops

ClassifyResult = tuple[list[Path], list[Path], list[Path], list[Path]]
ExtractPathsFn = Callable[[Any], list[Path]]
ClassifyPathsFn = Callable[[list[Path]], ClassifyResult]


class WorkspaceDropFilter(QObject):
    """Window-level drag/drop router preserving TabStrip drags and WebEngine image drops."""

    def __init__(
        self, studio: Any, window: QObject, reader: QObject | None = None, *,
        app_instance_fn: Callable[[], Any] = QGuiApplication.instance,
    ):
        super().__init__(window)
        self.studio, self.window, self.reader = studio, window, reader
        self._app_instance_fn = app_instance_fn
        self._intercepting_drag = self._forwarding = False
        window.installEventFilter(self)

    def set_reader(self, reader: QObject | None) -> None:
        self.reader = reader

    def _over_active_reader(self, scene_pos: QPointF) -> bool:
        reader = self.reader
        if (reader is None or not self.studio.settings.get("welcomed") or not self.studio.ready
                or self.studio.reader_overlay or self.studio.image_overlay):
            return False
        try:
            if not reader.isVisible() or reader.width() <= 0 or reader.height() <= 0:
                return False
            local = reader.mapFromScene(scene_pos)
            return 0 <= local.x() <= reader.width() and 0 <= local.y() <= reader.height()
        except RuntimeError:
            return False

    def _modal_blocked(self) -> bool:
        if self.studio.dropBlocked:
            return True
        try:
            count = self.window.property("modalDialogCount")
            return bool(count and int(count) > 0)
        except (RuntimeError, TypeError, ValueError):
            return False

    def _send_scene_event(self, factory: Callable[[], QEvent]) -> None:
        app = self._app_instance_fn()
        if app is None:
            return
        self._forwarding = True
        try:
            app.sendEvent(self.window, factory())
        finally:
            self._forwarding = False

    def _forward_enter_to_scene(self, event) -> None:
        self._send_scene_event(lambda: QDragEnterEvent(
            event.position().toPoint(), event.possibleActions(), event.mimeData(), event.buttons(), event.modifiers()
        ))

    def _send_leave_to_scene(self) -> None:
        self._send_scene_event(QDragLeaveEvent)

    def eventFilter(self, watched: QObject, event: QEvent) -> bool:
        if watched is not self.window or self._forwarding:
            return False
        etype = event.type()
        if etype not in (QEvent.Type.DragEnter, QEvent.Type.DragMove, QEvent.Type.DragLeave, QEvent.Type.Drop):
            return False
        if etype == QEvent.Type.DragLeave:
            if not self._intercepting_drag:
                return False
            self._intercepting_drag = False
            event.accept()
            return True
        mime = event.mimeData()
        if mime is None or not mime.hasUrls() or mime.hasFormat("application/x-supermd-tab"):
            return False
        if self._modal_blocked():
            if not self._intercepting_drag and etype == QEvent.Type.DragMove:
                self._send_leave_to_scene()
            self._intercepting_drag = etype != QEvent.Type.Drop
            event.setDropAction(Qt.DropAction.IgnoreAction)
            event.ignore()
            return True
        over_reader = self._over_active_reader(event.position())
        urls = mime.urls()
        if not self.studio.shouldInterceptExternalDrop(urls, over_reader):
            if self._intercepting_drag:
                self._intercepting_drag = False
                if etype in (QEvent.Type.DragMove, QEvent.Type.Drop):
                    self._forward_enter_to_scene(event)
            return False
        if not self._intercepting_drag and etype == QEvent.Type.DragMove:
            self._send_leave_to_scene()
        self._intercepting_drag = etype in (QEvent.Type.DragEnter, QEvent.Type.DragMove)
        event.setDropAction(Qt.DropAction.CopyAction)
        event.accept()
        if etype == QEvent.Type.Drop:
            self.studio.handleExternalDrop(urls, over_reader)
        return True


def drop_blocked(studio_obj: Any) -> bool:
    return bool(
        getattr(studio_obj, "retired", False)
        or getattr(studio_obj, "pending_close", "")
        or getattr(studio_obj, "flush_operation", "")
    )


def _is_drop_blocked(studio_obj: Any) -> bool:
    return bool(studio_obj.dropBlocked) if hasattr(studio_obj, "dropBlocked") else drop_blocked(studio_obj)


def attach_window_drop_filter(
    studio_obj: Any, window: QObject | None, reader: QObject | None = None, *,
    filter_cls: Callable[..., Any] = WorkspaceDropFilter,
) -> None:
    if window is None or getattr(studio_obj, "retired", False):
        return
    existing = getattr(studio_obj, "_workspace_drop_filter", None)
    if existing is not None and existing.window is window:
        existing.set_reader(reader)
        return
    if existing is not None:
        try:
            existing.window.removeEventFilter(existing)
        except RuntimeError:
            pass
    studio_obj._workspace_drop_filter = filter_cls(studio_obj, window, reader)


def should_intercept_external_drop(
    studio_obj: Any, urls, over_reader: bool = False, *,
    extract_paths_fn: ExtractPathsFn, classify_paths_fn: ClassifyPathsFn,
) -> bool:
    paths = extract_paths_fn(urls)
    if not paths:
        return False
    if _is_drop_blocked(studio_obj):
        return True
    folders, notes, images, unsupported = classify_paths_fn(paths)
    return not (
        over_reader and studio_obj.settings.get("welcomed") and studio_obj.ready
        and not getattr(studio_obj, "reader_overlay", False)
        and not getattr(studio_obj, "image_overlay", False)
        and images and not folders and not notes and not unsupported
    )


def open_dropped_urls(
    studio_obj: Any, urls, *,
    extract_paths_fn: ExtractPathsFn | None = None, classify_paths_fn: ClassifyPathsFn | None = None,
) -> None:
    handler = getattr(studio_obj, "handleExternalDrop", None)
    if callable(handler):
        handler(urls, False)
        return
    if extract_paths_fn is None or classify_paths_fn is None:
        raise TypeError("open_dropped_urls requires handleExternalDrop or explicit path collaborators")
    handle_external_drop(
        studio_obj, urls, False, extract_paths_fn=extract_paths_fn, classify_paths_fn=classify_paths_fn
    )


def handle_external_drop(
    studio_obj: Any, urls, over_reader: bool = False, *,
    extract_paths_fn: ExtractPathsFn, classify_paths_fn: ClassifyPathsFn,
) -> None:
    del over_reader
    if _is_drop_blocked(studio_obj):
        return
    paths = extract_paths_fn(urls)
    if not paths:
        return
    folders, notes, images, unsupported = classify_paths_fn(paths)
    if not folders and not notes:
        studio_obj.message = (
            "Drop images inside an open note to insert them." if images
            else "Only Markdown notes (.md, .smd, .fmd, .markdown, .txt) and folders can be opened by dropping."
        )
        studio_obj._emit(False)
        return

    notices: list[str] = []
    if len(folders) > 1:
        skipped = len(folders) - 1
        notices.append(f"opened folder {folders[-1].name} ({skipped} other folder{'s' if skipped != 1 else ''} skipped)")
    skipped_files = len(images) + len(unsupported)
    if skipped_files:
        notices.append(
            "drop images inside an open note separately to insert them" if images and not unsupported
            else f"skipped {skipped_files} unsupported item{'s' if skipped_files != 1 else ''}"
        )
    joined = "; ".join(notices)
    formatted_notice = (joined[0].upper() + joined[1:] + ".") if joined else ""

    if folders:
        studio_obj.openFolder(str(folders[-1]))
        studio_obj.workspaceFolderDropped.emit()
        host_window = getattr(studio_obj, "host_window", None)
        if not notes and host_window is not None:
            host_window.raise_()
            host_window.requestActivate()

    if notes:
        open_notes_fn = getattr(studio_obj, "_open_dropped_notes", None)
        if callable(open_notes_fn):
            open_notes_fn(notes, notice=formatted_notice)
        else:
            open_dropped_notes(studio_obj, notes, notice=formatted_notice)
    elif formatted_notice:
        studio_obj.message = formatted_notice
        studio_obj._emit(False)


def open_dropped_notes(studio_obj: Any, note_paths: list[Path], *, notice: str = "") -> None:
    if not note_paths or getattr(studio_obj, "retired", False):
        return
    studio_obj._activation_generation += 1
    batch_generation = studio_obj._activation_generation
    highest_activated_index = -1
    batch_new_tab_indices: dict[str, int] = {}
    opened_paths_by_index: dict[int, str] = {}
    errors: list[str] = []
    remaining = len(note_paths)

    def make_batch_insert(index: int):
        def insert_note(note: dict):
            batch_new_tab_indices[note["id"]] = index
            insert_at = next(
                (pos for pos, existing in enumerate(studio_obj.tabs)
                 if existing["id"] in batch_new_tab_indices and batch_new_tab_indices[existing["id"]] > index),
                None,
            )
            if insert_at is None:
                studio_obj.tabs.append(note)
            else:
                studio_obj.tabs.insert(insert_at, note)
        return insert_note

    def make_should_activate(index: int):
        def check(_tab: dict) -> bool:
            nonlocal highest_activated_index
            if index < highest_activated_index:
                return False
            highest_activated_index = index
            return True
        return check

    def make_done(index: int, path: Path):
        def done(tab: dict | None, error: str | None):
            nonlocal remaining
            if error:
                errors.append(f"{path.name}: {error}")
            elif tab is not None:
                opened_paths_by_index[index] = folder_ops.canonical_path_str(path)
            remaining -= 1
            if remaining == 0 and not getattr(studio_obj, "retired", False):
                if len(opened_paths_by_index) > 1:
                    ordered = [opened_paths_by_index[i] for i in sorted(opened_paths_by_index, reverse=True)]
                    studio_obj.recent = (
                        ordered + [p for p in studio_obj.recent if not any(folder_ops.same_path(p, o) for o in ordered)]
                    )[:30]
                    studio_obj._preferences()
                parts = ([f"Could not open {'; '.join(errors)}"] if errors else []) + ([notice] if notice else [])
                if parts:
                    studio_obj.message = " ".join(parts)
                studio_obj._emit(False)
        return done

    for idx, note_path in enumerate(note_paths):
        studio_obj._open_note(
            str(note_path), explicit=True, activation_generation=batch_generation,
            completion_callback=make_done(idx, note_path),
            batch_insert=make_batch_insert(idx), should_activate_fn=make_should_activate(idx),
        )


def matches_media_signature(mime: str, data: bytes) -> bool:
    head = data[:4096]
    if mime == "image/png":
        return head.startswith(b"\x89PNG\r\n\x1a\n")
    if mime == "image/jpeg":
        return head.startswith(b"\xff\xd8\xff")
    if mime == "image/webp":
        return len(head) >= 12 and head[:4] == b"RIFF" and head[8:12] == b"WEBP"
    if mime == "image/gif":
        return head.startswith((b"GIF87a", b"GIF89a"))
    if mime == "image/avif":
        return len(head) >= 12 and head[4:8] == b"ftyp" and b"avif" in head[8:16]
    if mime == "image/svg+xml":
        return b"<svg" in head.lower()
    return mime == "text/plain"


def parse_media_envelope(raw: str):
    if len(raw) > 524_288:
        key_pos = raw.find('"body"')
        colon_pos = raw.find(":", key_pos + 6) if key_pos >= 0 else -1
        q_open = raw.find('"', colon_pos + 1) if colon_pos >= 0 else -1
        if q_open >= 0 and raw[colon_pos + 1:q_open].strip() == "":
            q_close = raw.find('"', q_open + 1)
            if q_close > q_open + 262_144:
                try:
                    parsed = json.loads(raw[:q_open + 1] + raw[q_close:])
                    if isinstance(parsed, dict) and parsed.get("body") == "":
                        return parsed, raw, q_open + 1, q_close
                except ValueError:
                    pass
    parsed = json.loads(raw)
    if not isinstance(parsed, dict):
        raise ValueError("Invalid media payload")
    body = parsed.get("body")
    if not isinstance(body, str):
        raise ValueError("Media data is invalid or exceeds 25 MB")
    return parsed, body, 0, len(body)


def _decode_media_slice(chunk: str, *, allow_padding: bool) -> bytes:
    try:
        if not allow_padding and "=" in chunk:
            raise base64.binascii.Error("Excess data after padding")
        return base64.b64decode(chunk, validate=True)
    except (ValueError, base64.binascii.Error):
        raise ValueError("Media data is not valid base64") from None


def validate_and_write_media(
    args: dict, directory: Path, *, source_str: str | None = None, body_start: int = 0,
    body_end: int | None = None, matches_signature_fn: Callable[[str, bytes], bool] = matches_media_signature,
) -> dict:
    if not isinstance(args, dict):
        raise ValueError("Invalid media payload")
    mime_type, filename = args.get("mimeType"), args.get("filename", "")
    if source_str is None:
        body = args.get("body")
        if not isinstance(body, str):
            raise ValueError("Media data is invalid or exceeds 25 MB")
        source_str, body_start, body_end = body, 0, len(body)
    else:
        assert body_end is not None
    body_len = body_end - body_start
    extensions = {"image/png": ".png", "image/svg+xml": ".svg", "image/jpeg": ".jpg",
                  "image/webp": ".webp", "image/gif": ".gif", "image/avif": ".avif", "text/plain": ".mmd"}
    if mime_type not in extensions:
        raise ValueError("Unsupported media type")
    if not isinstance(filename, str) or len(filename) > 160 or any(char in filename for char in ("/", "\\", "\0")):
        raise ValueError("Media filename must be a short basename")
    if body_len <= 0 or body_len > 36_000_000:
        raise ValueError("Media data is invalid or exceeds 25 MB")
    safe = re.sub(r"[^A-Za-z0-9._ -]", "", Path(str(filename)).stem).strip(" .")[:100] or "Super-MD-media"
    extension = extensions[mime_type]
    if not directory.is_dir():
        raise ValueError("The media download folder is unavailable")

    step = 262_144  # 256 KiB chars (multiple of 4)
    first_end = min(body_start + step, body_end)
    first_chunk = _decode_media_slice(source_str[body_start:first_end], allow_padding=first_end >= body_end)
    if not first_chunk or len(first_chunk) > 25_000_000:
        raise ValueError("Media data is empty or exceeds 25 MB")
    if not matches_signature_fn(mime_type, first_chunk):
        raise ValueError("Media bytes do not match the declared type")

    for suffix in range(1, 10000):
        name = f"{safe}{'' if suffix == 1 else f' ({suffix})'}{extension}"
        path = directory / name
        try:
            fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        except FileExistsError:
            continue
        try:
            total_bytes = len(first_chunk)
            with os.fdopen(fd, "wb") as stream:
                stream.write(first_chunk)
                for offset in range(first_end, body_end, step):
                    end = min(offset + step, body_end)
                    piece = _decode_media_slice(source_str[offset:end], allow_padding=end >= body_end)
                    total_bytes += len(piece)
                    if total_bytes > 25_000_000:
                        raise ValueError("Media data is empty or exceeds 25 MB")
                    if piece:
                        stream.write(piece)
                stream.flush()
                os.fsync(stream.fileno())
            return {"filename": name, "path": str(path), "bytes": total_bytes, "mimeType": mime_type}
        except Exception:
            try:
                path.unlink(missing_ok=True)
            except OSError:
                pass
            raise
    raise ValueError("Could not find an unused media filename")
