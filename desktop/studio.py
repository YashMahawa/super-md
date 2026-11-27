"""Native Qt state/file management. Expensive work runs outside the UI thread."""
from __future__ import annotations
import base64
import concurrent.futures
import copy
import hashlib
import http.client
import io
import json
import ipaddress
import math
import mimetypes
import os
import platform
import shutil
import re
import secrets
import socket
import stat
import subprocess
import sys
import tempfile
import threading
import time
import urllib.parse
import urllib.request
import uuid
import weakref
import zipfile
from pathlib import Path
try:
    import shiboken6
except ImportError:  # pragma: no cover
    shiboken6 = None
from network_tls import client_context
from PySide6.QtCore import QEvent, QObject, Property, Signal, Slot, QStandardPaths, QTimer, QUrl, QFileSystemWatcher, QProcess, Qt, QPointF, QRect, QMetaObject, QBuffer, QByteArray, QIODevice
from PySide6.QtGui import QDesktopServices, QFontDatabase, QGuiApplication, QCursor, QImage, QDragEnterEvent, QDragLeaveEvent
from documents import (
    atomic_write, atomic_json, bundle, decode_base64_chunked,
    encode_base64_chunked, image_data, is_valid_asset_filename,
    materialize_assets, open_note, write_portable, MIMES, MAX_IMAGE,
)
import folder_ops
from markdown_export import write_markdown_export, write_markdown_zip
from theme import detect_system_dark, read_system_palette, system_palette_paths, tokens
from fonts import FontStore
from python_outputs import PythonOutputs
try:
    from . import studio_exports
except ImportError:
    import studio_exports
from reader_edits import ReaderEdits
from closed_notes import ClosedNoteStore
from reader_assets import ReaderAssetStore, note_file_path, resolve_source
from storage_inspector import inspect_storage, clear_storage_category
from latest_writes import LatestWriteExecutor
import updates
import app_integration
import python_runtime
import pending_python
from export_jobs import ExportJobRegistry
import file_events
import custom_theme
from selection_actions import ASSISTANTS, selection_target
from shortcuts import DEFINITIONS as SHORTCUT_DEFINITIONS, capture_sequence, default_shortcuts, native_label, normalize_shortcuts, parse_sequence
from workspace_links import WorkspaceLinkCache, WorkspaceLinkError, resolve_workspace_link
from workspace_search import KNOWN_NOTE_SUFFIXES, MAX_FOLDER_DEPTH, canonical_note_key, is_searchable_note_name, stream_text_search
from core.paths import DESKTOP_DIR, resource_root

FOLDER_TREE_NOTE_SUFFIXES = frozenset({".md", ".smd", ".txt"})
FOLDER_TREE_SCAN_BUDGET = 25000


def _is_folder_tree_note_name(filename: str) -> bool:
    return bool(filename) and not filename.startswith(".") and Path(filename).suffix.lower() in FOLDER_TREE_NOTE_SUFFIXES


def _probe_directory_visible_note(
    dir_path: Path,
    *,
    depth: int,
    max_depth: int = MAX_FOLDER_DEPTH,
    budget: list[int] | None = None,
    memo: dict[str, bool] | None = None,
) -> bool | None:
    """Return True if a visible note exists, False if confirmed absent, or None if scan bounds stopped early."""
    key = folder_ops.normalize_path_key(dir_path)
    if memo is not None and key in memo:
        return memo[key]
    if depth > max_depth:
        return None
    if budget is not None and budget[0] <= 0:
        return None
    subdirs: list[Path] = []
    found = False
    unresolved = False
    saw_entry = False
    try:
        with os.scandir(dir_path) as it:
            for entry in it:
                saw_entry = True
                if budget is not None:
                    if budget[0] <= 0:
                        unresolved = True
                        break
                    budget[0] -= 1
                name = entry.name
                if name.startswith("."):
                    continue
                try:
                    entry_path = Path(entry.path)
                    if entry.is_symlink() or folder_ops._is_link_or_junction(entry_path):
                        continue
                    if entry.is_dir(follow_symlinks=False):
                        subdirs.append(entry_path)
                    elif entry.is_file(follow_symlinks=False) and _is_folder_tree_note_name(name):
                        found = True
                        break
                except OSError:
                    continue
        if not saw_entry and budget is not None:
            budget[0] -= 1
    except OSError:
        if memo is not None:
            memo[key] = False
        return False
    if found:
        if memo is not None:
            memo[key] = True
        return True
    if unresolved:
        return None
    for subdir in subdirs:
        sub_result = _probe_directory_visible_note(
            subdir,
            depth=depth + 1,
            max_depth=max_depth,
            budget=budget,
            memo=memo,
        )
        if sub_result is True:
            if memo is not None:
                memo[key] = True
            return True
        if sub_result is None:
            unresolved = True
            if budget is not None and budget[0] <= 0:
                break
    if unresolved:
        return None
    if memo is not None:
        memo[key] = False
    return False


def _directory_has_visible_note(
    dir_path: Path,
    *,
    depth: int,
    max_depth: int = MAX_FOLDER_DEPTH,
    budget: list[int] | None = None,
    memo: dict[str, bool] | None = None,
) -> bool:
    return (
        _probe_directory_visible_note(
            dir_path,
            depth=depth,
            max_depth=max_depth,
            budget=budget,
            memo=memo,
        )
        is not False
    )


ROOT = resource_root()
DEFAULT_PDF = {"pageSize": "a4", "margin": 14, "fontSize": 10.5, "lineHeight": 1.4, "paragraphSpacing": 0.65, "fontFamily": "Manrope", "pageNumbers": True, "themed": False}
DEFAULTS = {"theme": "system", "fullTheme": "black", "motion": True, "font": "Manrope", "size": 18, "width": 0, "widthPercent":90, "lineHeight":1.65, "autosave":True, "normalZoom": 100, "fullZoom": 100, "python": "", "pdf": DEFAULT_PDF, "welcomed": False}
DEFAULTS.update(widthMigrated=True, window={"width":1320,"height":880,"maximized":False}, spellCheck=False, grammarCheck=False, readingMode="live", newNoteLocation="", accent="system", checkUpdates=True, autoUpdate=False)
DEFAULTS.update(restorePosition=True, centerLock=True, startup="restore", imageAppearance="original", svgAppearance="original", imageContrast=1.25, fullDocumentAccessibility=False)
DEFAULTS.update(patternKind="",patternOpacity=-1,patternSize=0,patternSpacing=0)
DEFAULTS.update(desktopIntegration=False)
DEFAULTS.update(selectionAssistant="chatgpt")
DEFAULTS.update(latexAutofix=False, typewriterScroll=False)
DEFAULTS.update(shortcuts=default_shortcuts())
DEFAULTS.update(agentAccessEnabled=False, cloudAgentEnabled=False, keepInBackground=False)
DEFAULTS.update(hideNonNoteFolders=True)

def _preserve_unchanged_assets(old_assets: dict[str, str], new_assets: dict[str, str]) -> dict[str, str]:
    """Keep existing Python string identities for unchanged data URLs so ReaderAssetStore grants stay valid."""
    return {k: old_assets[k] if old_assets.get(k) == v else v for k, v in new_assets.items()}


def _is_windows() -> bool:
    return os.name == "nt"


def _rename_path_with_windows_retry(before: Path, after: Path) -> None:
    """Retry brief Windows sharing/access-denied locks (e.g. watcher teardown or indexer)."""
    if not _is_windows():
        before.rename(after)
        return
    delay = 0.005
    deadline = time.monotonic() + 1.5
    while True:
        try:
            before.rename(after)
            return
        except PermissionError as error:
            if getattr(error, "winerror", None) not in (5, 32) or time.monotonic() >= deadline:
                raise
            time.sleep(delay)
            delay = min(0.05, delay * 2.0)

def _normalize_mcp_roots(roots) -> list[str]:
    if not roots:
        return []
    normalized: list[str] = []
    seen: set[str] = set()
    for candidate in roots:
        if candidate is None:
            continue
        raw = str(candidate).strip()
        if not raw or "\0" in raw:
            continue
        try:
            resolved = Path(raw).expanduser().resolve(strict=True)
        except (OSError, RuntimeError, ValueError):
            continue
        if not resolved.is_dir():
            continue
        key = str(resolved)
        if key not in seen:
            seen.add(key)
            normalized.append(key)
    return normalized


def agent_mcp_setup_config(discovery_dir, *, roots=None, executable=None, frozen=None, platform=None, cli_script=None):
    """Return a directly executable, absolute MCP stdio command for this install."""
    frozen = getattr(sys, "frozen", False) if frozen is None else bool(frozen)
    # Resolving a source venv's Python symlink would bypass that environment
    # and lose its MCP dependencies. Frozen launchers can use canonical paths.
    executable_path = Path(os.path.abspath(Path(executable or sys.executable).expanduser()))
    if frozen:
        executable_path = executable_path.resolve()
    platform = sys.platform if platform is None else platform
    if frozen:
        if platform.startswith("win"):
            command = str(executable_path.with_name("super-md-cli.exe").resolve())
        elif platform.startswith("linux"):
            appimage = os.environ.get("APPIMAGE", "")
            appimage_path = Path(appimage).expanduser() if appimage else None
            appdir = os.environ.get("APPDIR", "")
            from_image = bool(appdir and executable_path.is_relative_to(Path(appdir).resolve()))
            command = str(appimage_path.resolve()) if from_image and appimage_path and appimage_path.is_file() else str(executable_path)
        else:
            command = str(executable_path)
        args = ["agent", "mcp"]
    else:
        if platform.startswith("win") and executable_path.name.casefold() == "pythonw.exe":
            console_python = executable_path.with_name("python.exe")
            if console_python.is_file():
                executable_path = console_python
        script = Path(cli_script or DESKTOP_DIR / "agent_cli.py").expanduser().resolve()
        command = str(executable_path)
        args = [str(script), "mcp"]
    for root_path in _normalize_mcp_roots(roots):
        args.extend(["--root", root_path])
    args.extend(["--live-sessions-dir", str(Path(discovery_dir).expanduser().resolve()), "--transport", "stdio"])
    return {"command": command, "args": args}


_REQUIRED_SKILL_PACKAGE_FILES = (
    "SKILL.md",
    "references/study-notes.md",
    "references/visual-authoring.md",
    "references/agent-connection.md",
    "assets/study-visual-example.svg",
)


def _bundle_agent_skill_markdown(skill_dir: Path) -> str:
    router = (skill_dir / "SKILL.md").read_text(encoding="utf-8").rstrip()
    router = (router
              .replace("(references/study-notes.md)", "(#exam-ready-study-notes)")
              .replace("(references/visual-authoring.md)", "(#diagram-and-interaction-guide)")
              .replace("(references/agent-connection.md)", "(#agent-connection)"))
    study_notes = (skill_dir / "references" / "study-notes.md").read_text(encoding="utf-8").strip()
    visual_authoring = (skill_dir / "references" / "visual-authoring.md").read_text(encoding="utf-8").strip()
    connection = (skill_dir / "references" / "agent-connection.md").read_text(encoding="utf-8").strip()
    return (f"{router}\n\n{study_notes}\n\n{visual_authoring}\n\n"
            f"# Agent connection\n\n{connection}\n")


def _build_agent_skill_zip_bytes(root_dir: Path) -> bytes:
    dist_zip = root_dir / "dist" / "super-md-skill.zip"
    if dist_zip.is_file():
        raw = dist_zip.read_bytes()
        with zipfile.ZipFile(io.BytesIO(raw), "r") as archive:
            names = set(archive.namelist())
            if any(name.endswith("/local-preferences.md") or name == "local-preferences.md" for name in names):
                raise ValueError("Skill archive must not contain local-preferences.md")
            if all(f"super-md/{rel}" in names for rel in _REQUIRED_SKILL_PACKAGE_FILES):
                return raw
    if getattr(sys, "frozen", False):
        raise FileNotFoundError("Bundled super-md-skill.zip is missing from this installation")
    source_dir = root_dir / "dist" / "super-md-skill"
    if not source_dir.is_dir():
        source_dir = root_dir / "docs" / "skills" / "super-md"
    for rel in _REQUIRED_SKILL_PACKAGE_FILES:
        if not (source_dir / rel).is_file():
            raise FileNotFoundError(f"Missing required skill file: {rel}")
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", compression=zipfile.ZIP_STORED) as archive:
        for file_path in sorted(source_dir.rglob("*")):
            rel_parts = file_path.relative_to(source_dir).parts
            if any(part.startswith(".") or part == "local-preferences.md" for part in rel_parts):
                continue
            if file_path.is_file() and not file_path.is_symlink():
                info = zipfile.ZipInfo("super-md/" + "/".join(rel_parts))
                info.date_time = (1980, 1, 1, 0, 0, 0)
                info.compress_type = zipfile.ZIP_STORED
                archive.writestr(info, file_path.read_bytes())
    return buffer.getvalue()


_SYSTEM_PATH_ALIASES: tuple[tuple[str, str], ...] = (
    (("/var", "/private/var"), ("/tmp", "/private/tmp"), ("/etc", "/private/etc"))
    if sys.platform == "darwin"
    else ()
)


def _validate_local_tab_asset_path(raw_path, note_path: Path, extra_roots: list[Path], *,
                                   unavailable_message: str, outside_message: str,
                                   _system_aliases: tuple[tuple[str, str], ...] | None = None) -> Path:
    if not isinstance(raw_path, str) or not 1 <= len(raw_path.strip()) <= 4096 or "\0" in raw_path:
        raise ValueError(unavailable_message)
    candidate = Path(raw_path).expanduser()
    if not candidate.is_absolute():
        candidate = note_path.parent / candidate
    absolute = Path(os.path.abspath(candidate))

    # On macOS /var and /tmp are system-provided symlinks into /private. Rewrite
    # those known aliases before walking path components so temp-folder paths
    # work when tab["path"] was resolved, while still rejecting symlinks inside
    # user folders.
    system_aliases = _SYSTEM_PATH_ALIASES if _system_aliases is None else _system_aliases
    for raw_alias, raw_canonical in system_aliases:
        alias = Path(raw_alias)
        canonical = Path(raw_canonical)
        try:
            if (alias.is_symlink() and alias.resolve(strict=True) == canonical.resolve(strict=True)
                    and (absolute == alias or alias in absolute.parents)):
                absolute = canonical / absolute.relative_to(alias)
                break
        except (OSError, RuntimeError):
            continue

    canonical_roots: list[Path] = []
    root_aliases: list[tuple[Path, Path]] = []
    for root in (note_path.parent, *extra_roots):
        if not root:
            continue
        try:
            supplied_root = Path(os.path.abspath(Path(root).expanduser()))
            canonical_root = supplied_root.resolve(strict=True)
        except (OSError, RuntimeError):
            continue
        if not canonical_root.is_dir():
            continue
        if canonical_root not in canonical_roots:
            canonical_roots.append(canonical_root)
        if supplied_root != canonical_root:
            pair = (supplied_root, canonical_root)
            if pair not in root_aliases:
                root_aliases.append(pair)
    root_aliases.sort(key=lambda item: len(item[0].parts), reverse=True)

    for supplied_root, canonical_root in root_aliases:
        if absolute == supplied_root or supplied_root in absolute.parents:
            absolute = canonical_root / absolute.relative_to(supplied_root)
            break

    current = Path(absolute.anchor)
    for part in absolute.parts[1:]:
        current = current / part
        try:
            if current.is_symlink() or (hasattr(os.path, "isjunction") and os.path.isjunction(current)):
                raise ValueError(outside_message)
        except OSError as error:
            raise ValueError(unavailable_message) from error

    try:
        resolved = absolute.resolve(strict=True)
    except (OSError, RuntimeError) as error:
        raise ValueError(unavailable_message) from error
    if not resolved.is_file():
        raise ValueError(outside_message)
    if any(resolved == canonical_root or canonical_root in resolved.parents for canonical_root in canonical_roots):
        return resolved
    raise ValueError(outside_message)

SAMPLE = """# A place to think\n\nWrite in Markdown. Read without distractions.\n\n> [!tip] Start with your notes\n> Open any note or folder. No vault, no import process.\n\n## Learn by exploring\n\n$$E = mc^2$$\n\n> [!answer]- Why does this matter?\n> Tap the heading to reveal an answer, then hide it to test yourself.\n\n```smd-chart\n{\"title\":\"A changing wave\",\"series\":[{\"name\":\"Sine\",\"expression\":\"sin(a*x)\",\"color\":\"#386a57\"},{\"name\":\"Cosine\",\"expression\":\"cos(a*x)\",\"color\":\"#bc6750\"}],\"sliders\":[{\"name\":\"a\",\"min\":0.1,\"max\":3,\"step\":0.05,\"value\":1}]}\n```\n\n## Matplotlib in three dimensions\n\nRun a Python cell to generate a 3D figure, then save it in your note or PDF.\n\n```python\nimport numpy as np\nimport matplotlib.pyplot as plt\nx, y = np.meshgrid(np.linspace(-2, 2, 32), np.linspace(-2, 2, 32))\nfig = plt.figure()\nax = fig.add_subplot(111, projection=\"3d\")\nax.plot_surface(x, y, x*x + y*y, cmap=\"viridis\")\n```\n\n[Back to exploring](#learn-by-exploring)\n"""

def public_address(url: str) -> str:
    """Resolve once and return a global IP for the URL's host, or refuse."""
    parsed = urllib.parse.urlparse(url)
    if parsed.scheme not in ("http","https") or not parsed.hostname or parsed.username or parsed.password:
        raise ValueError("Use a public web URL")
    addresses = socket.getaddrinfo(parsed.hostname,parsed.port or (443 if parsed.scheme=="https" else 80),type=socket.SOCK_STREAM)
    if not addresses or any(not ipaddress.ip_address(address[4][0]).is_global for address in addresses):
        raise ValueError("Private, local and reserved network addresses are not allowed")
    return addresses[0][4][0]

class _PinnedHTTPConnection(http.client.HTTPConnection):
    def __init__(self, host, *args, pinned="", **kwargs):
        super().__init__(host, *args, **kwargs); self.pinned = pinned
    def connect(self):
        self.sock = socket.create_connection((self.pinned, self.port), self.timeout)

class _PinnedHTTPSConnection(http.client.HTTPSConnection):
    def __init__(self, host, *args, pinned="", **kwargs):
        super().__init__(host, *args, **kwargs); self.pinned = pinned
    def connect(self):
        # TLS still verifies the certificate against the requested hostname.
        self.sock = self._context.wrap_socket(socket.create_connection((self.pinned, self.port), self.timeout), server_hostname=self.host)

class PinnedHTTPHandler(urllib.request.HTTPHandler):
    def http_open(self, request):
        pinned = public_address(request.full_url)
        return self.do_open(lambda host, **kwargs: _PinnedHTTPConnection(host, pinned=pinned, **kwargs), request)

class PinnedHTTPSHandler(urllib.request.HTTPSHandler):
    def https_open(self, request):
        pinned = public_address(request.full_url)
        return self.do_open(lambda host, **kwargs: _PinnedHTTPSConnection(host, pinned=pinned, **kwargs), request, context=client_context())

def local_path(value: str) -> Path:
    url = QUrl(value)
    resolved = Path(url.toLocalFile() if url.isLocalFile() else value).expanduser().resolve()
    return Path(folder_ops.strip_extended_length_prefix(str(resolved)))


def _extract_local_drop_paths(values) -> list[Path]:
    paths: list[Path] = []
    seen: set[str] = set()
    for raw in values or ():
        if raw is None:
            continue
        if isinstance(raw, QUrl):
            if not raw.isLocalFile():
                continue
            local_str = raw.toLocalFile()
        elif isinstance(raw, Path):
            local_str = str(raw)
        else:
            text = str(raw).strip()
            if not text:
                continue
            url = QUrl(text)
            if url.isLocalFile():
                local_str = url.toLocalFile()
            elif not url.scheme() or (len(url.scheme()) == 1 and sys.platform == "win32"):
                local_str = text
            else:
                continue
        if not local_str:
            continue
        try:
            resolved = Path(local_str).expanduser().resolve()
            resolved = Path(folder_ops.strip_extended_length_prefix(str(resolved)))
        except (OSError, RuntimeError):
            continue
        key = canonical_note_key(resolved)
        if key in seen:
            continue
        seen.add(key)
        paths.append(resolved)
    return paths


def _classify_drop_paths(paths: list[Path]) -> tuple[list[Path], list[Path], list[Path], list[Path]]:
    folders: list[Path] = []
    notes: list[Path] = []
    images: list[Path] = []
    unsupported: list[Path] = []
    for path in paths:
        try:
            is_dir = path.is_dir()
            is_file = False if is_dir else path.is_file()
        except OSError:
            unsupported.append(path)
            continue
        if is_dir:
            folders.append(path)
        elif is_file:
            suffix = path.suffix.lower()
            if suffix in KNOWN_NOTE_SUFFIXES:
                notes.append(path)
            elif suffix.lstrip(".") in MIMES:
                images.append(path)
            else:
                unsupported.append(path)
        else:
            unsupported.append(path)
    return folders, notes, images, unsupported


class WorkspaceDropFilter(QObject):
    """Window-level drag/drop router preserving TabStrip drags and WebEngine image drops."""

    def __init__(self, studio: Studio, window: QObject, reader: QObject | None = None):
        super().__init__(window)
        self.studio = studio
        self.window = window
        self.reader = reader
        self._intercepting_drag = False
        self._forwarding = False
        window.installEventFilter(self)

    def set_reader(self, reader: QObject | None) -> None:
        self.reader = reader

    def _over_active_reader(self, scene_pos: QPointF) -> bool:
        reader = self.reader
        if (
            reader is None
            or not self.studio.settings.get("welcomed")
            or not self.studio.ready
            or self.studio.reader_overlay
            or self.studio.image_overlay
        ):
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

    def _forward_enter_to_scene(self, event) -> None:
        app = QGuiApplication.instance()
        if app is None:
            return
        enter = QDragEnterEvent(
            event.position().toPoint(),
            event.possibleActions(),
            event.mimeData(),
            event.buttons(),
            event.modifiers(),
        )
        self._forwarding = True
        try:
            app.sendEvent(self.window, enter)
        finally:
            self._forwarding = False

    def _send_leave_to_scene(self) -> None:
        app = QGuiApplication.instance()
        if app is None:
            return
        leave = QDragLeaveEvent()
        self._forwarding = True
        try:
            app.sendEvent(self.window, leave)
        finally:
            self._forwarding = False

    def eventFilter(self, watched: QObject, event: QEvent) -> bool:
        if watched is not self.window or self._forwarding:
            return False
        etype = event.type()
        if etype not in (
            QEvent.Type.DragEnter,
            QEvent.Type.DragMove,
            QEvent.Type.DragLeave,
            QEvent.Type.Drop,
        ):
            return False

        if etype == QEvent.Type.DragLeave:
            if self._intercepting_drag:
                self._intercepting_drag = False
                event.accept()
                return True
            return False

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

        scene_pos = event.position()
        over_reader = self._over_active_reader(scene_pos)
        urls = mime.urls()
        intercept = self.studio.shouldInterceptExternalDrop(urls, over_reader)

        if not intercept:
            if self._intercepting_drag:
                self._intercepting_drag = False
                if etype in (QEvent.Type.DragMove, QEvent.Type.Drop):
                    self._forward_enter_to_scene(event)
            return False

        if not self._intercepting_drag and etype == QEvent.Type.DragMove:
            self._send_leave_to_scene()

        if etype in (QEvent.Type.DragEnter, QEvent.Type.DragMove):
            self._intercepting_drag = True
            event.setDropAction(Qt.DropAction.CopyAction)
            event.accept()
            return True

        self._intercepting_drag = False
        event.setDropAction(Qt.DropAction.CopyAction)
        event.accept()
        self.studio.handleExternalDrop(urls, over_reader)
        return True

def export_destination(value: str, format: str) -> Path:
    return studio_exports.export_destination(value, format)

def _same_closed_revision(current: dict, captured: dict) -> bool:
    """Compare content-bearing fields after a background close snapshot."""
    return current == captured


def _snapshot_tab_state(tab: dict, *, include_view_state: bool = True) -> dict:
    """Snapshot tab metadata and asset dicts without walking immutable image strings."""
    snapshot = {}
    for key, value in tab.items():
        if not include_view_state and key == "viewState":
            continue
        if key in ("assets", "saved_assets") and isinstance(value, dict):
            snapshot[key] = dict(value)
        elif key == "outline" and isinstance(value, list):
            snapshot[key] = copy.deepcopy(value)
        elif key == "viewState" and value is not None:
            snapshot[key] = copy.deepcopy(value)
        elif isinstance(value, (str, int, float, bool)) or value is None:
            snapshot[key] = value
        else:
            snapshot[key] = copy.deepcopy(value)
    return snapshot


def _asset_identity(value):
    return id(value)


def _noop_done(*_):
    pass


class _StoppedFileWatcher:
    def files(self) -> list[str]:
        return []

    def directories(self) -> list[str]:
        return []

    def addPath(self, _path: str) -> bool:
        return False

    def addPaths(self, paths) -> list[str]:
        return list(paths)

    def removePath(self, _path: str) -> bool:
        return False

    def removePaths(self, paths) -> list[str]:
        return list(paths)


_STOPPED_WATCHER = _StoppedFileWatcher()


def _matches_media_signature(mime: str, data: bytes) -> bool:
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

class Session(QObject):
    """One ordered persistence stream for every native window in the application."""
    changed = Signal()
    locationChanged = Signal(str,str)
    renameCompleted = Signal(object)
    def __init__(self,isolated=False,data=None):
        super().__init__()
        self.renameCompleted.connect(self._on_rename_completed)
        self._watch_suspension_lock = threading.Lock()
        self._watch_suspensions: list[tuple[str, str, bool, threading.Event, str]] = []
        self._pending_rename_cleanups: dict[str, Any] = {}
        self._rename_state_lock = threading.RLock()
        self._retired_persist_needed = False
        self._last_recovered_window_id = ""
        self.data = Path(data) if data is not None else (Path(tempfile.mkdtemp(prefix="supermd-test-")) if isolated else Path(QStandardPaths.writableLocation(QStandardPaths.StandardLocation.AppDataLocation))/"qt-studio")
        self.data=self.data.resolve()
        self.data.mkdir(parents=True,exist_ok=True)
        self.font_store = FontStore(self.data)
        self.python_outputs = PythonOutputs(self.data/"derived-python")
        self.reader_assets = ReaderAssetStore(self.reader_asset_is_current, self.reader_asset_payload)
        self.closed_note_store = ClosedNoteStore(self.data/"closed-notes")
        try:self.closed_tabs = self.closed_note_store.load_index_strict();self.closed_note_error=""
        except (OSError,ValueError,TypeError) as error:self.closed_tabs=[];self.closed_note_error=str(error)
        self.writes = LatestWriteExecutor(max_workers=1,thread_name_prefix="supermd-save")
        self.writes.add_drain_finalizer(self._flush_retired_persistence_sync)
        self.settings = copy.deepcopy(DEFAULTS)
        self.recent = []
        self.pinned = []
        self.workspace = {}
        self.window_workspaces = {}
        self.startup_paths = []
        self.startup_active = ""
        self.startup_entries = []
        self.startup_active_id = ""
        self.startup_folder = ""
        self.startup_expanded = []
        self.startup_windows = []
        self._pending_startup_windows = []
        self.quitting = False
        self.update_installed = False
        self.locations = {}
        self.drafts = {}
        self.windows = {}
        self.custom_theme = None
        self.theme_epoch = 0
        self.theme_revision = 0
        self.theme_source = ""
        self.active_theme_kind = "builtin"
        self.active_theme_id = ""
        self.saved_themes = []
        self.theme_restored = False
        self._load_theme_library()
        self.initial_recovery = []
        settings_path = self.data / "settings.json"
        stored_settings = None
        can_persist_migration = not settings_path.exists()
        try:
            stored = json.loads(settings_path.read_text(encoding="utf-8"))
            if isinstance(stored, dict) and isinstance(stored.get("settings"), dict):
                stored_settings = stored["settings"]
                can_persist_migration = True
            self.settings.update({k:v for k,v in stored["settings"].items() if k in DEFAULTS})
            if not stored["settings"].get("widthMigrated") and stored["settings"].get("widthPercent") == 80:
                self.settings["widthPercent"] = 90  # 80% was the old default, not a choice.
            self.settings["pdf"] = {**DEFAULT_PDF, **self.settings.get("pdf", {})}
            self.pinned = list(dict.fromkeys(p for p in stored.get("pinned",[]) if isinstance(p,str)))[:10]
            self.recent = list(dict.fromkeys(self.pinned + [p for p in stored.get("recent",[]) if isinstance(p,str)]))[:10]
        except (OSError,ValueError,KeyError,TypeError,AttributeError): pass
        had_explicit_keep_in_background = isinstance(stored_settings, dict) and "keepInBackground" in stored_settings
        fresh_service_log = os.environ.get("SUPERMD_FRESH_SERVICE_LOG") == "1"
        migrated_keep_in_background = not had_explicit_keep_in_background and (
            (isinstance(stored_settings, dict) and any(
                stored_settings.get(key) is True
                for key in ("agentAccessEnabled", "cloudAgentEnabled", "background", "backgroundEnabled")
            ))
            or (self.data / "agent-sessions").is_dir()
            or (self.data / "agent-cloud.json").is_file()
            or (
                not fresh_service_log
                and (
                    (self.data / "background-service.log").is_file()
                    or (self.data.name == "qt-studio" and (self.data.parent / "background-service.log").is_file())
                )
            )
        )
        # Local MCP access and cloud relay reconnection are explicit, persisted
        # opt-ins; each desktop launch mints a fresh temporary loopback token.
        self.settings["agentAccessEnabled"] = self.settings.get("agentAccessEnabled") is True
        self.settings["cloudAgentEnabled"] = self.settings.get("cloudAgentEnabled") is True
        self.settings["keepInBackground"] = (
            stored_settings.get("keepInBackground") is True
            if had_explicit_keep_in_background
            else bool(migrated_keep_in_background)
        )
        shortcuts, _ = normalize_shortcuts(self.settings.get("shortcuts"))
        self.settings["shortcuts"] = shortcuts or default_shortcuts()
        if (migrated_keep_in_background or (fresh_service_log and not had_explicit_keep_in_background)) and can_persist_migration:
            try:
                atomic_write(
                    settings_path,
                    json.dumps({"settings": self.settings, "recent": self.recent, "pinned": self.pinned}, ensure_ascii=False).encode("utf-8"),
                )
            except OSError:
                pass
        try:
            workspace=json.loads((self.data/"startup.json").read_text(encoding="utf-8"))
            self.startup_paths=list(dict.fromkeys(p for p in workspace.get("paths",[]) if isinstance(p,str)))[:100]
            self.startup_active=workspace.get("active","") if isinstance(workspace.get("active"),str) else ""
            self.startup_entries=[entry for entry in workspace.get("tabs",[]) if isinstance(entry,dict) and isinstance(entry.get("id"),str) and isinstance(entry.get("path"),str)][:100]
            self.startup_active_id=workspace.get("activeId","") if isinstance(workspace.get("activeId"),str) else ""
            self.startup_folder=workspace.get("folder","") if isinstance(workspace.get("folder"),str) else ""
            self.startup_expanded=[p for p in workspace.get("expanded",[]) if isinstance(p,str)][:500] if isinstance(workspace.get("expanded"),list) else []
            raw_windows=workspace.get("windows",[])
            if isinstance(raw_windows,list):
                for item in raw_windows[:20]:
                    if not isinstance(item,dict):
                        continue
                    w_tabs=[entry for entry in item.get("tabs",[]) if isinstance(entry,dict) and isinstance(entry.get("id"),str) and isinstance(entry.get("path"),str)][:100]
                    w_paths=list(dict.fromkeys(entry["path"] for entry in w_tabs if entry["path"]))[:100]
                    w_folder=item.get("folder","") if isinstance(item.get("folder"),str) else ""
                    w_expanded=[p for p in item.get("expanded",[]) if isinstance(p,str)][:500] if isinstance(item.get("expanded"),list) else []
                    self.startup_windows.append({
                        "tabs": w_tabs,
                        "paths": w_paths,
                        "active": item.get("active","") if isinstance(item.get("active"),str) else "",
                        "activeId": item.get("activeId","") if isinstance(item.get("activeId"),str) else "",
                        "folder": w_folder,
                        "expanded": w_expanded,
                    })
            self._pending_startup_windows=list(self.startup_windows)
        except (OSError,ValueError,TypeError,AttributeError): pass
        try:
            locations=json.loads((self.data/"reading-positions.json").read_text(encoding="utf-8"))
            if isinstance(locations,dict):self.locations=dict(list(locations.items())[-200:])
        except (OSError,ValueError,TypeError):pass
        try:
            recovered = json.loads((self.data/"recovery.json").read_text(encoding="utf-8"))
            for tab in recovered:
                if not isinstance(tab,dict) or any(not isinstance(tab.get(key),str) for key in ("name","content","path","saved")):
                    raise ValueError("Invalid draft recovery")
                bundle(tab["content"],tab.get("assets",{}))
                self.initial_recovery.append(tab)
        except (OSError,ValueError,TypeError): pass
        # A crash can land after an active-tab recovery write but before the
        # small closed-tab index is refreshed. Prefer the active recovery entry.
        active_ids={entry.get("id") for entry in self.startup_entries if isinstance(entry,dict)}
        for win_spec in self.startup_windows:
            active_ids.update(entry.get("id") for entry in win_spec.get("tabs",[]) if isinstance(entry,dict))
        active_ids.update(tab.get("id") for tab in self.initial_recovery)
        kept=[ref for ref in self.closed_tabs if ref.get("id") not in active_ids]
        if kept != self.closed_tabs:
            self.closed_tabs=kept
            try:self.closed_note_store.save_index(kept)
            except OSError:pass
        self.workspace_links = WorkspaceLinkCache()

    @Slot(object)
    def _on_rename_completed(self, payload):
        callback, value, error = payload
        callback(value, error)

    def _remap_session_paths(self, old_path: str, new_path: str, *, is_dir: bool):
        with self._rename_state_lock:
            for loc_key in list(self.locations.keys()):
                if folder_ops.matches_path_prefix(loc_key, old_path, is_directory=is_dir):
                    value = self.locations.pop(loc_key)
                    self.locations[folder_ops.remap_path_prefix(loc_key, old_path, new_path, is_directory=is_dir)] = value
            self.pinned = list(dict.fromkeys(
                folder_ops.remap_path_prefix(p, old_path, new_path, is_directory=is_dir)
                for p in self.pinned
            ))[:10]
            remapped_recent = [folder_ops.remap_path_prefix(p, old_path, new_path, is_directory=is_dir) for p in self.recent]
            self.recent = list(dict.fromkeys(self.pinned + remapped_recent))[:10]
            for entries in self.workspace.values():
                for entry in entries:
                    if entry.get("path") and folder_ops.matches_path_prefix(entry["path"], old_path, is_directory=is_dir):
                        entry["path"] = folder_ops.remap_path_prefix(entry["path"], old_path, new_path, is_directory=is_dir)
            for ws in getattr(self, "window_workspaces", {}).values():
                if isinstance(ws, dict):
                    if ws.get("folder") and folder_ops.matches_path_prefix(ws["folder"], old_path, is_directory=is_dir):
                        ws["folder"] = folder_ops.remap_path_prefix(ws["folder"], old_path, new_path, is_directory=is_dir)
                    if isinstance(ws.get("expanded"), list):
                        ws["expanded"] = [folder_ops.remap_path_prefix(p, old_path, new_path, is_directory=is_dir) for p in ws["expanded"]]
                    if ws.get("active") and folder_ops.matches_path_prefix(ws["active"], old_path, is_directory=is_dir):
                        ws["active"] = folder_ops.remap_path_prefix(ws["active"], old_path, new_path, is_directory=is_dir)
            for draft_key, draft_list in self.drafts.items():
                if draft_key == "deleted-notes" or not isinstance(draft_list, list):
                    continue
                for draft in draft_list:
                    if isinstance(draft, dict) and draft.get("path") and folder_ops.matches_path_prefix(draft["path"], old_path, is_directory=is_dir):
                        updated_path = folder_ops.remap_path_prefix(draft["path"], old_path, new_path, is_directory=is_dir)
                        draft.update(path=updated_path, name=Path(updated_path).name)
            if getattr(self, "startup_folder", ""):
                self.startup_folder = folder_ops.remap_path_prefix(
                    self.startup_folder, old_path, new_path, is_directory=is_dir
                )
            if getattr(self, "startup_expanded", None):
                self.startup_expanded = [
                    folder_ops.remap_path_prefix(p, old_path, new_path, is_directory=is_dir)
                    for p in self.startup_expanded
                ]
            for spec_list_attr in ("startup_windows", "_pending_startup_windows"):
                for spec in getattr(self, spec_list_attr, ()):
                    if not isinstance(spec, dict):
                        continue
                    if spec.get("folder") and folder_ops.matches_path_prefix(spec["folder"], old_path, is_directory=is_dir):
                        spec["folder"] = folder_ops.remap_path_prefix(spec["folder"], old_path, new_path, is_directory=is_dir)
                    if isinstance(spec.get("expanded"), list):
                        spec["expanded"] = [folder_ops.remap_path_prefix(p, old_path, new_path, is_directory=is_dir) for p in spec["expanded"]]
                    if isinstance(spec.get("paths"), list):
                        spec["paths"] = [folder_ops.remap_path_prefix(p, old_path, new_path, is_directory=is_dir) for p in spec["paths"]]
                    if spec.get("active"):
                        spec["active"] = folder_ops.remap_path_prefix(spec["active"], old_path, new_path, is_directory=is_dir)
                    for entry in spec.get("tabs", ()):
                        if isinstance(entry, dict) and entry.get("path") and folder_ops.matches_path_prefix(entry["path"], old_path, is_directory=is_dir):
                            entry["path"] = folder_ops.remap_path_prefix(entry["path"], old_path, new_path, is_directory=is_dir)
            self.startup_paths = [
                folder_ops.remap_path_prefix(p, old_path, new_path, is_directory=is_dir)
                for p in self.startup_paths
            ]
            if self.startup_active:
                self.startup_active = folder_ops.remap_path_prefix(
                    self.startup_active, old_path, new_path, is_directory=is_dir
                )
            for entry in self.startup_entries:
                if entry.get("path") and folder_ops.matches_path_prefix(entry["path"], old_path, is_directory=is_dir):
                    entry["path"] = folder_ops.remap_path_prefix(entry["path"], old_path, new_path, is_directory=is_dir)
            self.workspace_links.invalidate()

    def _build_retired_persistence_payloads(self):
        with self._rename_state_lock:
            settings_bytes = json.dumps({
                "settings": copy.deepcopy(self.settings),
                "recent": list(self.recent),
                "pinned": list(self.pinned),
            }).encode()
            positions_bytes = json.dumps(dict(self.locations)).encode()
            entries = [dict(entry) for tabs in self.workspace.values() for entry in tabs]
            windows_payload = []
            for wid, w_tabs in self.workspace.items():
                meta = self.window_workspaces.get(wid, {})
                w_folder = meta.get("folder", "")
                windows_payload.append({
                    "windowId": wid,
                    "tabs": [dict(t) for t in w_tabs],
                    "active": meta.get("active", ""),
                    "activeId": meta.get("activeId", ""),
                    "folder": w_folder,
                    "expanded": list(meta.get("expanded", [])) if w_folder else [],
                })
            workspace_payload = None
            if windows_payload or entries:
                primary_folder = windows_payload[0]["folder"] if windows_payload else ""
                primary_expanded = windows_payload[0]["expanded"] if windows_payload else []
                last_meta = (
                    self.window_workspaces.get(self._last_recovered_window_id, {})
                    if self._last_recovered_window_id and self._last_recovered_window_id in self.window_workspaces
                    else (windows_payload[-1] if windows_payload else {})
                )
                workspace_payload = {
                    "paths": list(dict.fromkeys(t["path"] for t in entries if t["path"])),
                    "tabs": entries,
                    "active": last_meta.get("active", ""),
                    "activeId": last_meta.get("activeId", ""),
                    "folder": primary_folder,
                    "expanded": primary_expanded,
                    "windows": windows_payload,
                }
            drafts_payload = [_snapshot_tab_state(tab, include_view_state=False) for tabs in self.drafts.values() for tab in tabs]
            return settings_bytes, positions_bytes, workspace_payload, drafts_payload

    def _enqueue_retired_persistence(self):
        if getattr(self.writes, "_shutdown", False):
            return
        settings_bytes, positions_bytes, workspace_payload, drafts_payload = self._build_retired_persistence_payloads()
        try:
            self.writes.submit(lambda: atomic_write(self.data / "settings.json", settings_bytes))
            self.writes.submit(lambda: atomic_write(self.data / "reading-positions.json", positions_bytes))
            if workspace_payload is not None:
                self.writes.submit_latest("startup", lambda: atomic_json(self.data / "startup.json", workspace_payload))
            self.writes.submit_latest("recovery", lambda: atomic_json(self.data / "recovery.json", drafts_payload))
        except RuntimeError:
            pass

    def _flush_retired_persistence_sync(self):
        with self._rename_state_lock:
            if not self._retired_persist_needed:
                return
            self._retired_persist_needed = False
            settings_bytes, positions_bytes, workspace_payload, drafts_payload = self._build_retired_persistence_payloads()
        atomic_write(self.data / "settings.json", settings_bytes)
        atomic_write(self.data / "reading-positions.json", positions_bytes)
        if workspace_payload is not None:
            atomic_json(self.data / "startup.json", workspace_payload)
        atomic_json(self.data / "recovery.json", drafts_payload)

    def is_quitting(self) -> bool:
        background = getattr(self, "background", None)
        return bool(self.quitting or (background is not None and getattr(background, "quitting", False)))

    def has_pending_startup_windows(self) -> bool:
        return bool(self.settings.get("startup", "restore") == "restore" and self._pending_startup_windows)

    def _load_theme_library(self):
        library_path = self.data / "theme-library.json"
        themes_dir = self.data / "themes"
        if library_path.is_file():
            try:
                raw = json.loads(library_path.read_text(encoding="utf-8"))
                saved = []
                for item in raw.get("saved", []):
                    if not isinstance(item, dict):
                        continue
                    entry_id = item.get("id", "")
                    name = item.get("name", "")
                    source = item.get("source", "")
                    if (
                        isinstance(entry_id, str)
                        and re.fullmatch(r"[0-9a-f]{8,64}", entry_id)
                        and isinstance(name, str)
                        and name.strip()
                        and isinstance(source, str)
                        and (themes_dir / f"{entry_id}.json").is_file()
                    ):
                        saved.append({"id": entry_id, "name": name, "source": source})
                self.saved_themes = saved
                active = raw.get("active", {}) if isinstance(raw.get("active"), dict) else {}
                kind = active.get("kind", "builtin")
                active_id = active.get("id", "") if isinstance(active.get("id"), str) else ""
                if kind == "saved":
                    matched = next((item for item in saved if item["id"] == active_id), None)
                    if matched is not None:
                        self.active_theme_kind = "saved"
                        self.active_theme_id = matched["id"]
                        self.theme_source = matched["source"]
                elif kind == "preset" and active_id:
                    self.active_theme_kind = "preset"
                    self.active_theme_id = active_id
                    self.theme_source = ""
            except (OSError, ValueError, TypeError, AttributeError):
                pass
            return
        legacy_source = ""
        try:
            legacy_source = json.loads((self.data / "theme-source.json").read_text(encoding="utf-8")).get("path", "")
            if not isinstance(legacy_source, str):
                legacy_source = ""
        except (OSError, ValueError, AttributeError):
            legacy_source = ""
        legacy_theme = self.data / "theme.json"
        if legacy_theme.is_file():
            try:
                parsed = json.loads(legacy_theme.read_text(encoding="utf-8"))
                name = parsed.get("name") if isinstance(parsed, dict) and isinstance(parsed.get("name"), str) and parsed.get("name").strip() else "Imported theme"
                entry_id = uuid.uuid4().hex
                themes_dir.mkdir(parents=True, exist_ok=True)
                atomic_json(themes_dir / f"{entry_id}.json", parsed)
                self.saved_themes = [{"id": entry_id, "name": name, "source": legacy_source}]
                self.active_theme_kind = "saved"
                self.active_theme_id = entry_id
                self.theme_source = legacy_source
                atomic_json(library_path, {"active": {"kind": "saved", "id": entry_id}, "saved": self.saved_themes})
            except (OSError, ValueError, TypeError):
                self.theme_source = legacy_source
        else:
            self.theme_source = legacy_source

    def reader_asset_is_current(self, grant):
        return self.reader_asset_source_is_current(grant.owner_id, grant.tab_id, grant.source,
                                                   grant.embedded_identity, grant.path)

    def reader_asset_source_is_current(self, owner_id, tab_id, source, embedded_identity, path):
        studio = self.windows.get(owner_id)
        if not studio or studio.retired:
            return False
        tab = next((item for item in studio.tabs if item["id"] == tab_id), None)
        if tab is None:
            return False
        if source in tab.get("assets", {}):
            # Asset strings are immutable; identity keeps request validation
            # cheap for large embedded images and replacement revokes access.
            return id(tab["assets"][source]) == embedded_identity
        try:
            return str(note_file_path(tab, source)) == path
        except (OSError, ValueError):
            return False

    def reader_asset_payload(self, grant):
        studio = self.windows.get(grant.owner_id)
        if not studio or studio.retired:
            return None
        tab = next((item for item in studio.tabs if item["id"] == grant.tab_id), None)
        if tab is None:
            return None
        payload = tab.get("assets", {}).get(grant.source)
        return payload if isinstance(payload, str) and id(payload) == grant.embedded_identity else None

class Studio(QObject):
    changed = Signal()
    sidebarChanged = Signal()
    shortcutsChanged = Signal()
    workspaceSearchChanged = Signal()
    workspaceSearchBatch = Signal(int, object, int, bool, bool)
    readerLoad = Signal(str)
    readerCall = Signal(str)
    readerReloadRequested = Signal()
    chromeRequested = Signal(str)
    replied = Signal(str, str, str)
    completed = Signal(object)
    backgroundWriteCompleted = Signal(object)
    saveRequested = Signal(str)
    saveAsRequested = Signal(str)
    saveConflictRequested = Signal(str)
    closeRequested = Signal(str)
    allowClose = Signal()
    newWindowRequested = Signal()
    detachedWindowRequested = Signal(str, str)
    exportRequested = Signal(str)
    folderPickerRequested = Signal()
    workspaceFolderDropped = Signal()
    fontPickerRequested = Signal()
    themePickerRequested = Signal()
    themeExportRequested = Signal()
    noteLocationPickerRequested = Signal()
    flushFailed = Signal(bool)
    pythonProgress = Signal(str)
    agentRequest = Signal(str)
    cloudRevocationFinished = Signal(bool, str)

    def __init__(self, isolated: bool = False, session: Session | None = None):
        super().__init__()
        self.setObjectName("studio")
        self._brand_svg = (ROOT/"public/brand-mark-fixed.svg").read_text(encoding="utf-8")
        self.pool = concurrent.futures.ThreadPoolExecutor(max_workers=3, thread_name_prefix="supermd")
        self._search_pool = concurrent.futures.ThreadPoolExecutor(max_workers=2, thread_name_prefix="supermd-search")
        self.workspaceSearchBatch.connect(self._on_workspace_search_batch)
        self.session = session or Session(isolated)
        weak_self = weakref.ref(self)
        def _on_session_changed():
            inst = weak_self()
            if inst is not None and not inst.retired:
                inst._emit()
        def _on_location_changed(old, new):
            inst = weak_self()
            if inst is not None and not inst.retired:
                inst._location_changed(old, new)
        self._session_changed_slot = _on_session_changed
        self._location_changed_slot = _on_location_changed
        self.session.changed.connect(self._session_changed_slot)
        self.session.locationChanged.connect(self._location_changed_slot)
        self.writes = self.session.writes
        self.window_id = uuid.uuid4().hex
        self.session.windows[self.window_id] = self
        self.host_window = None
        self._retired = False
        self._write_callback_lock = threading.Lock()
        self._pending_write_retirements: dict[str, Any] = {}
        self.completed.connect(self._complete)
        self.backgroundWriteCompleted.connect(self._complete_background_write)
        self.data = self.session.data
        self.settings = self.session.settings
        self._defer_reader_activation = False
        self._agent_error = ""
        self._agent_cloud_error = ""
        self._agent_cloud_config_path = self.data / "agent-cloud.json"
        self._cloud_started_local_bridge = False
        self._cloud_revocation_pending = False
        self.cloudRevocationFinished.connect(self._finish_cloud_revocation)
        self._agent_viewport_capture = None
        agent_bridge = getattr(self.session, "agent_bridge", None)
        if agent_bridge is not None:
            agent_bridge.enabledChanged.connect(lambda: self._emit(False))
            agent_bridge.cloudStatusChanged.connect(self._cloud_status_changed)
        self.update_status=""
        self.update_info=None
        self.update_path=""
        self.update_running=False
        self._storage_report = json.dumps({"status":"idle","cancelled":False,"truncated":False,"scannedEntries":0,"categories":[]})
        self.storage_busy = False
        self.storage_cleanup_busy = False
        self.storage_cleanup_status = ""
        self._storage_cancel_event = None
        self.python_status=""
        self.python_choices=[]
        self.python_busy=False
        self.pythonProgress.connect(self._python_progress)
        if not self.settings.get("python"):
            self._choose_default_python(emit=False)
        if not isolated and len(self.session.windows)==1:QTimer.singleShot(0,self._restore_update)
        self.tabs: list[dict] = []
        self.closed_tabs = self.session.closed_tabs
        self._closing_tabs: set[str] = set()
        self.note_watcher = QFileSystemWatcher(self)
        self.note_watcher.fileChanged.connect(self._external_note_changed)
        self.note_watcher.directoryChanged.connect(self._external_note_changed)
        self.external_paths = set()
        self.note_watch_paths = None
        self._watch_suspensions = self.session._watch_suspensions
        with self.session._rename_state_lock:
            self.session._retired_persist_needed = False
        self.note_file_stamps = {}
        self.note_identities = {}
        self.external_timer = QTimer(self)
        self.external_timer.setSingleShot(True)
        self.external_timer.timeout.connect(self._refresh_external_notes)
        self.active = ""
        self.folder = ""
        self._files: list[dict] = []
        self._files_revision = 0
        self._outline_revision = 0
        self.expanded: set[str] = set()
        self._pinned_visible_dirs: set[str] = set()
        self.folder_filter = ""
        self._folder_searching = False
        self._search_generation = 0
        self._search_cancel: threading.Event | None = None
        self.filter_timer = QTimer(self)
        self.filter_timer.setSingleShot(True)
        self.filter_timer.timeout.connect(self._start_subfolder_search)
        self._folder_search_open = False
        self._folder_search_query = ""
        self._folder_search_case_sensitive = False
        self._folder_search_include_diagrams = False
        self._folder_search_matches: list[dict] = []
        self._folder_search_scanning = False
        self._folder_search_scanned_files = 0
        self._folder_search_truncated = False
        self._folder_search_generation = 0
        self._folder_search_cancel: threading.Event | None = None
        self._folder_search_tabs_sig: list[tuple[str, str, bool]] | None = None
        self._pending_seeded_find: dict | None = None
        self.mode = self.settings.get("readingMode", "live")
        self.fullscreen = False
        self.reader_overlay = False
        self.image_overlay = False
        self.busy = 0
        self._message = ""
        self._message_revision = 0
        self.message = ("Closed-note recovery index could not be read; historical snapshots were left untouched. "+self.session.closed_note_error) if self.session.closed_note_error else ""
        self.ready = False
        self._last_reader_text = None
        self._export_jobs = ExportJobRegistry()
        self._python_jobs = python_runtime.PythonJobRegistry()
        self._agent_exports: dict[str, dict] = {}
        self._agent_owned_files: set[str] = getattr(self.session, "agent_owned_files", None) or set()
        self.session.agent_owned_files = self._agent_owned_files
        self._agent_open_paths: set[str] = getattr(self.session, "agent_open_paths", None) or set()
        self.session.agent_open_paths = self._agent_open_paths
        self._agent_job_records = {}
        self.reader_edits = ReaderEdits()
        self.system_dark = None
        self.system_mode, self.system_colors = read_system_palette()
        self._theme_result = None
        self._theme_running = False
        self._theme_pending = False
        self.theme_debounce = QTimer(self)
        self.theme_debounce.setSingleShot(True)
        self.theme_debounce.timeout.connect(self._refresh_theme)
        def _on_color_scheme_changed(*args):
            inst = weak_self()
            if inst is not None and not inst.retired:
                inst._schedule_theme(*args)
        self._color_scheme_slot = _on_color_scheme_changed
        QGuiApplication.styleHints().colorSchemeChanged.connect(self._color_scheme_slot)
        self.palette_watcher = QFileSystemWatcher(self)
        self.palette_watcher.fileChanged.connect(self._palette_changed)
        self.palette_watcher.directoryChanged.connect(self._palette_changed)
        self._watch_palette()
        self.custom_theme_watcher=QFileSystemWatcher(self)
        self.custom_theme_timer=QTimer(self)
        self.custom_theme_timer.setSingleShot(True)
        self.custom_theme_timer.setInterval(250)
        self.custom_theme_timer.timeout.connect(self._custom_theme_event)
        self.custom_theme_stamp=None
        self.custom_theme_watcher.fileChanged.connect(lambda *_:self.custom_theme_timer.start())
        self.custom_theme_watcher.directoryChanged.connect(lambda *_:self.custom_theme_timer.start())
        QTimer.singleShot(0,self._restore_custom_theme)
        self.system_preferences = QProcess(self)
        if sys.platform.startswith("linux") and shutil.which("gsettings"):
            self.system_preferences.readyReadStandardOutput.connect(self._system_setting_changed)
            self.system_preferences.start("gsettings",["monitor","org.gnome.desktop.interface"])
        self.theme_timer = QTimer(self)
        # Live notifications handle ordinary changes; this is only a fallback for
        # environments without portal/Qt preference events. No four-second spawning.
        self.theme_timer.setInterval(60000)
        self.theme_timer.timeout.connect(self._refresh_theme)
        self.theme_timer.start()
        self.pending_close = ""
        self.pending_export = ""
        self.pending_save_as = ""
        self.pending_save_as_tab = ""
        self._force_overwrite_ids: set[str] = set()
        self.flush_operation = None
        self.flush_timer = QTimer(self)
        self.flush_timer.setSingleShot(True)
        self.flush_timer.timeout.connect(self._on_flush_timeout)
        self.recovery_timer = QTimer(self)
        self.recovery_timer.setSingleShot(True)
        self.recovery_timer.timeout.connect(self._recover)
        self.autosave_timer = QTimer(self)
        self.autosave_timer.setSingleShot(True)
        self.autosave_timer.timeout.connect(self._autosave)
        self.preference_timer = QTimer(self)
        self.preference_timer.setSingleShot(True)
        self.preference_timer.timeout.connect(self._preferences)
        self.position_timer=QTimer(self);self.position_timer.setSingleShot(True);self.position_timer.timeout.connect(self._save_positions)
        self.saving = set()
        restore_enabled = self.settings.get("startup", "restore") == "restore"
        if not restore_enabled:
            self.session._pending_startup_windows.clear()
            self.session.startup_folder = ""
            self.session.startup_expanded = []
            self.session.startup_paths = []
            self.session.startup_entries = []
        win_spec = self.session._pending_startup_windows.pop(0) if restore_enabled and self.session._pending_startup_windows else None
        if win_spec is not None and self.session._pending_startup_windows:
            spec_ids = {entry["id"] for entry in win_spec["tabs"]}
            claimed = [tab for tab in self.session.initial_recovery if tab.get("id") in spec_ids]
            self.session.initial_recovery = [tab for tab in self.session.initial_recovery if tab.get("id") not in spec_ids]
        else:
            claimed = list(self.session.initial_recovery)
            self.session.initial_recovery = []
        self.tabs = [{**tab,"id":tab.get("id") or uuid.uuid4().hex} for tab in claimed]
        for tab in self.tabs:
            tab.setdefault("saved_assets", dict(tab.get("assets", {})))
            tab.setdefault("assets_dirty", False)
            tab.setdefault("conflict", False)
        self._agent_open_paths.update(str(Path(tab["path"]).resolve()) for tab in self.tabs if tab.get("path"))
        self.session.drafts[self.window_id] = [dict(t) for t in self.tabs]
        if not self.tabs:
            self.tabs.append(self._note("Untitled.md") if self.settings["welcomed"] else self._note("Welcome.md", SAMPLE, saved=SAMPLE))
        elif self.settings["startup"]=="new":
            self.tabs.insert(0,self._note("Untitled.md"))
        self.active = self.tabs[0]["id"]
        target_active_id = win_spec["activeId"] if win_spec is not None else self.session.startup_active_id
        if restore_enabled and any(t["id"]==target_active_id for t in self.tabs):self.active=target_active_id
        self._activation_generation = 0
        self._startup_placeholder_ids = {
            tab["id"] for tab in self.tabs
            if tab["name"] == "Untitled.md" and not tab["path"] and not tab["content"] and not tab["saved"] and not tab["assets"]
        }
        self._restoring_paths=set()
        self._startup_order=[]
        if win_spec is not None:
            self._startup_entries = list(win_spec["tabs"])
            self._startup_active = win_spec["active"]
            restore_paths = list(win_spec["paths"])
            restore_folder = win_spec["folder"]
            restore_expanded = list(win_spec["expanded"])
            if not self.session._pending_startup_windows:
                self.session.startup_paths = []
                self.session.startup_entries = []
                self.session.startup_folder = ""
                self.session.startup_expanded = []
        else:
            self._startup_entries = self.session.startup_entries
            self.session.startup_entries = []
            self._startup_active = self.session.startup_active
            restore_paths = list(self.session.startup_paths)
            self.session.startup_paths = []
            restore_folder = self.session.startup_folder
            restore_expanded = list(self.session.startup_expanded)
            self.session.startup_folder = ""
            self.session.startup_expanded = []
        if restore_enabled and restore_paths:
            self._startup_order = restore_paths
            self._restoring_paths = set(self._startup_order)
            restore_generation = self._activation_generation
            QTimer.singleShot(0,lambda:[self._open_note(path, explicit=False, activation_generation=restore_generation) for path in self._startup_order])
        if restore_enabled and restore_folder:
            self._restore_workspace_folder(restore_folder, restore_expanded)
        self._emitted_sidebar_key = self._sidebar_slice_key()
        self._refresh_theme()
        # Only the first real desktop window may restore the user's opted-in
        # cloud connection. The cloud client handles network retry/backoff.
        if not isolated and len(self.session.windows) == 1 and self.settings.get("cloudAgentEnabled"):
            QTimer.singleShot(0, self._restore_cloud_connection)

    def _restore_cloud_connection(self):
        if self.retired or not self.settings.get("cloudAgentEnabled") or self._cloud_revocation_pending:
            return
        bridge = getattr(self.session, "agent_bridge", None)
        if bridge is None or bridge.cloudClient.enabled:
            return
        try:
            try:
                from .agent_cloud import read_cloud_config
            except ImportError:
                from agent_cloud import read_cloud_config
            config = read_cloud_config(self._agent_cloud_config_path)
            was_enabled = bridge.enabled
            bridge.start_cloud(config)
            self._cloud_started_local_bridge = not was_enabled
            self._agent_cloud_error = ""
        except Exception as error:
            # Keep the opt-in on transient errors so the user can retry without
            # re-pairing. Invalid pairing is surfaced, never silently replaced.
            self._agent_cloud_error = f"Cloud auto-connect failed: {str(error)[:140]}"
        self._emit(False)

    @property
    def files(self): return getattr(self, "_files", [])

    @files.setter
    def files(self, value):
        current = getattr(self, "_files", None)
        if current is not None and value == current:
            return
        self._files = value
        self._files_revision = getattr(self, "_files_revision", 0) + 1

    @property
    def recent(self): return self.session.recent

    @recent.setter
    def recent(self,value): self.session.recent = list(dict.fromkeys(self.session.pinned + value))[:10]

    @property
    def message(self): return getattr(self, "_message", "")

    @message.setter
    def message(self, value):
        self._message = value
        if value: self._message_revision = getattr(self, "_message_revision", 0) + 1

    @Slot(str)
    def pinRecent(self,path):
        matched_recent = next((item for item in self.recent if folder_ops.same_path(item, path)), None)
        if matched_recent is None:
            return
        matched_pinned = next((item for item in self.session.pinned if folder_ops.same_path(item, matched_recent)), None)
        if matched_pinned is not None:
            self.session.pinned = [item for item in self.session.pinned if not folder_ops.same_path(item, matched_recent)]
        else:
            self.session.pinned.append(matched_recent)
        self.recent=self.recent
        self._preferences()
        for window in tuple(self.session.windows.values()):
            window._notify_sidebar()

    def _note(self, name: str, content: str = "", path: str = "", saved: str = "", assets: dict | None = None, portable: bool = False):
        assets = dict(assets) if assets else {}
        return {"id": uuid.uuid4().hex, "name": name, "content": content, "path": path, "saved": saved,
                "assets": assets, "saved_assets": dict(assets), "assets_dirty": False,
                "portable": portable, "conflict": False}

    def _is_dirty(self, tab: dict) -> bool:
        if tab.get("content") != tab.get("saved"):
            return True
        if tab.get("assets_dirty"):
            return True
        if tab.get("path") and "saved_assets" in tab and tab.get("assets", {}) != tab.get("saved_assets", {}):
            return True
        return False

    @Property("QStringList",notify=sidebarChanged)
    def pinnedRecent(self):return list(self.session.pinned)

    def _current(self):
        if not self.tabs:
            return {"id": "", "name": "Super MD", "content": "", "path": "", "saved": "", "assets": {}, "saved_assets": {}, "assets_dirty": False, "portable": False, "conflict": False, "outline": []}
        return next((t for t in self.tabs if t["id"] == self.active), self.tabs[0])

    @staticmethod
    def _seeded_find_bounds(data: dict) -> dict:
        start = data.get("sourceStart")
        end = data.get("sourceEnd")
        if (
            isinstance(start, int) and not isinstance(start, bool)
            and isinstance(end, int) and not isinstance(end, bool)
            and start >= 0 and end >= start
        ):
            bounds: dict[str, object] = {"sourceStart": start, "sourceEnd": end}
            match_text = data.get("matchText")
            if isinstance(match_text, str) and match_text:
                bounds["matchText"] = match_text
            return bounds
        return {}

    def _consume_seeded_find(self, tab: dict) -> dict | None:
        pending = self._pending_seeded_find
        if not pending or not tab.get("id"):
            return None
        target_id = pending.get("tabId") or ""
        target_path = pending.get("path") or ""
        matches_id = bool(target_id and tab["id"] == target_id)
        matches_path = bool(target_path and tab.get("path") and os.path.normcase(str(Path(tab["path"]).resolve(strict=False))) == os.path.normcase(str(Path(target_path).resolve(strict=False))))
        if not matches_id and not matches_path:
            return None
        self._pending_seeded_find = None
        seeded = {"query": pending["query"], "caseSensitive": bool(pending.get("caseSensitive", False))}
        seeded.update(self._seeded_find_bounds(pending))
        return seeded

    def _notify_sidebar(self):
        if self.retired:
            return
        key = self._sidebar_slice_key()
        if key != getattr(self, "_emitted_sidebar_key", None):
            self._emitted_sidebar_key = key
            self.sidebarChanged.emit()

    def _emit(self, load=True):
        if self.retired: return
        self._watch_notes()
        self._notify_sidebar()
        self.changed.emit()
        if load and self.ready and self.tabs:
            tab = self._current()
            colors = self._colors()
            reading_settings={key:self.settings[key] for key in ("restorePosition","centerLock","imageAppearance","svgAppearance","imageContrast","fullDocumentAccessibility","latexAutofix","typewriterScroll")}
            reading_settings["customStyle"]=custom_theme.reader(self.session.custom_theme,self.settings["fullTheme" if self.fullscreen else "theme"],self._dark(),self.settings)
            payload={**reading_settings,"readingLocation":self.session.locations.get(tab["path"]),"id": tab["id"], "path": tab["path"] or tab["id"], "portable": bool(tab.get("portable", False)), "mode": self.mode, "dark": self._dark(), "fullscreen": self.fullscreen, "font": self.settings["font"], "size": self.settings["size"], "widthPercent": self.settings["widthPercent"], "lineHeight":self.settings["lineHeight"], "spellCheck":self.settings["spellCheck"], "grammarCheck":self.settings["grammarCheck"], "zoom": self.settings["fullZoom" if self.fullscreen else "normalZoom"], "motion": self.settings["motion"], "python": self.settings["python"], "colors": colors, "viewState": tab.pop("viewState", None)}
            pending_heading = tab.pop("pendingHeading", None)
            if pending_heading:
                payload["pendingHeading"] = pending_heading
            seeded_find = self._consume_seeded_find(tab)
            if seeded_find is not None:
                payload["seededFind"] = seeded_find
            payload["editProtocol"]=1
            previous=self._last_reader_text
            if previous and previous[0]==tab["id"] and previous[1] is tab["content"]:payload["contentUnchanged"]=True
            else:payload["content"]=tab["content"]
            self._last_reader_text=(tab["id"],tab["content"])
            self.readerLoad.emit(json.dumps(payload))

    def _tokens(self):
        # Scheme generation is costly and QML reads colors from many bindings.
        theme = self.settings["fullTheme" if self.fullscreen else "theme"]
        selected=self.session.custom_theme
        key = (theme,self.system_dark,json.dumps(self.system_colors,sort_keys=True),self.system_mode,self.settings["accent"],self.session.theme_revision)
        if getattr(self,"_token_key",None) != key:
            self._token_key = key
            dark,colors=tokens(theme,self.system_dark,self.system_colors,self.system_mode,selected["accent"] if selected else self.settings["accent"])
            self._token_value = (dark,custom_theme.palette(colors,custom_theme.variant(selected,theme,dark).get("colors",{}))) if selected else (dark,colors)
        return self._token_value

    def _dark(self):
        return self._tokens()[0]

    def _colors(self):
        return dict(self._tokens()[1])

    @Property("QVariantMap", notify=changed)
    def palette(self): return self._colors()

    @Property("QVariantMap",notify=changed)
    def themeMetrics(self):return {"controlRadius":22,"contentRadius":16,**(self.session.custom_theme or {}).get("metrics",{})}

    @Property(str,notify=changed)
    def customThemeName(self):return (self.session.custom_theme or {}).get("name","Built-in appearance")

    @Property(bool,notify=changed)
    def customThemeActive(self):return self.session.custom_theme is not None

    @Property("QVariantList",constant=True)
    def bundledThemes(self):return custom_theme.bundled_themes(ROOT)

    @Property("QVariantList",notify=changed)
    def savedThemes(self):return copy.deepcopy(self.session.saved_themes)

    @Property(str,notify=changed)
    def activeThemeKind(self):return self.session.active_theme_kind

    @Property(str,notify=changed)
    def activeThemeId(self):return self.session.active_theme_id

    @Property(bool,notify=changed)
    def customThemeHasSource(self):
        return self.session.custom_theme is not None and self.session.active_theme_kind != "preset" and bool(self.session.theme_source)

    @Property("QVariantMap",notify=changed)
    def themeArtwork(self):
        selected=custom_theme.variant(self.session.custom_theme,self.settings["fullTheme" if self.fullscreen else "theme"],self._dark())
        return custom_theme.artwork(self.session.custom_theme,selected)

    @Property("QVariantMap",notify=changed)
    def themeBackground(self):
        style=custom_theme.reader(self.session.custom_theme,self.settings["theme"],self._dark(),self.settings)
        return {"pattern":"none","opacity":.06,"size":24,"spacing":24,**(style["background"] or {})}

    @Slot()
    def resetThemeBackground(self):
        self.settings.update(patternKind="",patternOpacity=-1,patternSize=0,patternSpacing=0)
        self._preferences();self._emit()

    @Property(bool, notify=changed)
    def motionEnabled(self): return bool(self.settings["motion"])

    @Property(str, constant=True)
    def shortcutActions(self): return json.dumps(SHORTCUT_DEFINITIONS)

    @Property(str, notify=shortcutsChanged)
    def shortcutBindings(self): return json.dumps(self.settings.get("shortcuts", {}))

    @Property(str, notify=shortcutsChanged)
    def shortcutLabels(self):
        return json.dumps({action: self.shortcutLabel(action) for action in self.settings.get("shortcuts", {})})

    @Slot(str, result="QVariantList")
    def shortcutSequences(self, action):
        return list(self.settings.get("shortcuts", {}).get(action, []))

    @Slot(str, result=str)
    def shortcutLabel(self, action):
        values = self.shortcutSequences(action)
        return "  /  ".join(native_label(value) for value in values) if values else "Disabled"

    @Slot(int, int, result=str)
    def captureShortcut(self, key, modifiers):
        sequence, error = capture_sequence(key, modifiers)
        return json.dumps({"sequence": sequence, "error": error})

    @Slot(str, str, result=str)
    def setShortcut(self, action, value):
        if action not in self.settings.get("shortcuts", {}):
            return "Unknown shortcut action."
        sequence = parse_sequence(value) if value else None
        if value and sequence is None:
            return "Invalid key combination."
        candidate = copy.deepcopy(self.settings["shortcuts"])
        candidate[action] = [sequence] if sequence else []
        validated, error = normalize_shortcuts(candidate, edited_action=action)
        if error: return error
        if validated == self.settings["shortcuts"]: return ""
        self.settings["shortcuts"] = validated
        self._notify_shortcuts()
        self._preferences()
        self._emit(False)
        return ""

    @Slot(result=str)
    def resetShortcuts(self):
        defaults = default_shortcuts()
        if defaults == self.settings["shortcuts"]: return ""
        self.settings["shortcuts"] = defaults
        self._notify_shortcuts()
        self._preferences()
        self._emit(False)
        return ""

    def _notify_shortcuts(self):
        # Do not rebuild every QML Shortcut/recorder on each note edit, zoom or
        # scroll update. Only an actual binding change invalidates these maps.
        for window in tuple(self.session.windows.values()):
            if not window.retired: window.shortcutsChanged.emit()

    def _active_watch_suspensions(self):
        with self.session._watch_suspension_lock:
            active = [item for item in self.session._watch_suspensions if not item[3].is_set()]
            if len(active) != len(self.session._watch_suspensions):
                self.session._watch_suspensions[:] = active
            return list(active)

    def _is_path_suspended(self, candidate: str, suspensions=None) -> bool:
        if not candidate:
            return False
        items = self._active_watch_suspensions() if suspensions is None else suspensions
        for item in items:
            susp_target, _susp_parent, susp_is_dir = item[0], item[1], item[2]
            susp_new = item[4] if len(item) > 4 else ""
            if folder_ops.matches_path_prefix(candidate, susp_target, is_directory=susp_is_dir):
                return True
            if susp_new and folder_ops.matches_path_prefix(candidate, susp_new, is_directory=susp_is_dir):
                return True
        return False

    def _is_watch_target_suspended(self, candidate: str, suspensions=None) -> bool:
        if not candidate:
            return False
        items = self._active_watch_suspensions() if suspensions is None else suspensions
        for item in items:
            susp_target, susp_parent, susp_is_dir = item[0], item[1], item[2]
            susp_new = item[4] if len(item) > 4 else ""
            if folder_ops.matches_path_prefix(candidate, susp_target, is_directory=susp_is_dir):
                return True
            if susp_new and folder_ops.matches_path_prefix(candidate, susp_new, is_directory=susp_is_dir):
                return True
            if susp_parent and folder_ops.same_path(candidate, susp_parent):
                return True
        return False

    def _has_session_path_reference(self, candidate: str) -> bool:
        if not candidate:
            return False
        if any(folder_ops.same_path(p, candidate) for p in self.note_identities):
            return True
        if any(folder_ops.same_path(p, candidate) for p in self.session.pinned):
            return True
        if any(folder_ops.same_path(p, candidate) for p in self.recent):
            return True
        if any(folder_ops.same_path(k, candidate) for k in self.session.locations):
            return True
        for win in list(self.session.windows.values()):
            if win.retired:
                continue
            if any(t["path"] and folder_ops.same_path(t["path"], candidate) for t in win.tabs):
                return True
        for entries in self.session.workspace.values():
            if any(entry.get("path") and folder_ops.same_path(entry["path"], candidate) for entry in entries):
                return True
        return False

    def _watch_notes(self,force=False):
        if self.retired:return
        active_suspensions = self._active_watch_suspensions()
        paths=tuple(sorted({tab["path"] for tab in self.tabs if tab["path"]}|set(self.recent)))
        signature=(paths,self.folder,tuple(sorted(self.expanded)))
        if not force and not active_suspensions and signature==self.note_watch_paths:return
        self.note_watch_paths = None if active_suspensions else signature
        self.note_file_stamps={path:stamp for path,stamp in self.note_file_stamps.items() if path in paths}
        self.note_identities={
            path: (
                self.note_identities.get(path)
                if self._is_path_suspended(path, active_suspensions)
                else (file_events.identity(path) or self.note_identities.get(path))
            )
            for path in paths
        }
        targets={
            str(target)
            for path in paths
            if not self._is_path_suspended(path, active_suspensions)
            for target in (Path(path),Path(path).parent)
            if target.exists()
        }
        targets.update(
            path
            for path in ({self.folder}|set(self.expanded))
            if path and not self._is_watch_target_suspended(path, active_suspensions) and Path(path).is_dir()
        )
        if active_suspensions:
            targets = {
                candidate
                for candidate in targets
                if not self._is_watch_target_suspended(candidate, active_suspensions)
            }
        watched=set(self.note_watcher.files()+self.note_watcher.directories())
        if watched-targets:self.note_watcher.removePaths(list(watched-targets))
        if targets-watched:self.note_watcher.addPaths(list(targets-watched))

    def _suspend_watches_for_prefix(self, target_path: str, *, is_dir: bool, new_path: str = ""):
        parent_str = folder_ops.canonical_path_str(Path(target_path).parent)
        entry_list = [(target_path, parent_str, is_dir, threading.Event(), new_path)]
        for win in list(self.session.windows.values()):
            if win.retired:
                continue
            win.note_watch_paths = None
            watched = list(win.note_watcher.files() + win.note_watcher.directories())
            to_remove = [
                watched_path
                for watched_path in watched
                if win._is_watch_target_suspended(watched_path, entry_list)
            ]
            if to_remove:
                win.note_watcher.removePaths(to_remove)
            if win.external_paths:
                win.external_paths = {
                    ext_path
                    for ext_path in win.external_paths
                    if not win._is_watch_target_suspended(ext_path, entry_list)
                }
                if not win.external_paths:
                    win.external_timer.stop()

    def _hold_watches_for_rename(self, target_path: str, *, is_dir: bool, new_path: str = "") -> threading.Event:
        resume_event = threading.Event()
        parent_str = folder_ops.canonical_path_str(Path(target_path).parent)
        entry = (target_path, parent_str, is_dir, resume_event, new_path)
        with self.session._watch_suspension_lock:
            self.session._watch_suspensions[:] = [
                item for item in self.session._watch_suspensions if not item[3].is_set()
            ]
            self.session._watch_suspensions.append(entry)
        self._suspend_watches_for_prefix(target_path, is_dir=is_dir, new_path=new_path)
        return resume_event

    def _external_note_changed(self,path):
        if self.retired:return
        local_str = str(local_path(path))
        if self._is_watch_target_suspended(local_str):
            return
        self.external_paths.add(local_str)
        self.external_timer.start(250)

    def _refresh_external_notes(self):
        if self.retired:return
        changed,self.external_paths=self.external_paths,set()
        active_suspensions = self._active_watch_suspensions()
        known = {
            path: ident
            for path, ident in self.note_identities.items()
            if not self._is_path_suspended(path, active_suspensions)
        }
        unsuspended_changed = {
            path for path in changed if not self._is_watch_target_suspended(path, active_suspensions)
        }
        if not known and not unsuspended_changed:
            return
        def reconciled(result,error):
            if self.retired or error:return
            current_suspensions = self._active_watch_suspensions()
            emitted_location_change = False
            for old,new in result.items():
                if self._is_path_suspended(old, current_suspensions) or (
                    new and self._is_path_suspended(new, current_suspensions)
                ):
                    continue
                if not self._has_session_path_reference(old):
                    continue
                emitted_location_change = True
                self.session.locationChanged.emit(old,new or "")
            effective_changed = {
                path for path in changed if not self._is_watch_target_suspended(path, current_suspensions)
            }
            self._reload_changed_content(effective_changed)
            if self.folder and (effective_changed or emitted_location_change):
                self.session.workspace_links.invalidate(self.folder)
            if self.folder and (
                any(
                    folder_ops.same_path(ch, self.folder)
                    or folder_ops.matches_path_prefix(ch, self.folder, is_directory=True)
                    for ch in effective_changed
                )
                or (
                    emitted_location_change
                    and any(
                        folder_ops.matches_path_prefix(p, self.folder, is_directory=True)
                        for old, new in result.items()
                        for p in (old, new)
                        if p
                        and not self._is_path_suspended(old, current_suspensions)
                        and not (new and self._is_path_suspended(new, current_suspensions))
                    )
                )
            ):
                self._load_tree()
        self._submit(lambda:file_events.reconcile(known,changed),reconciled,False)

    def _location_changed(self,old,new):
        if self.retired:return
        active_suspensions = self._active_watch_suspensions()
        if self._is_path_suspended(old, active_suspensions) or (
            new and self._is_path_suspended(new, active_suspensions)
        ):
            return
        if Path(old).exists() and not (new and old!=new and old.casefold()==new.casefold()):return  # A temporary atomic-replace gap has healed.
        if new and not Path(new).is_file():return
        for stamp_key in [k for k in list(self.note_file_stamps) if folder_ops.same_path(k, old)]:
            self.note_file_stamps.pop(stamp_key, None)
        if new:
            location = None
            for loc_key in [k for k in list(self.session.locations) if folder_ops.same_path(k, old)]:
                popped = self.session.locations.pop(loc_key, None)
                if location is None and popped is not None:
                    location = popped
            if location:self.session.locations[new]=location
            for tab in self.tabs:
                if tab["path"] and folder_ops.same_path(tab["path"], old):
                    tab.update(path=new,name=Path(new).name)
                    try:
                        st = Path(new).stat()
                        self.note_file_stamps[new] = (st.st_mtime_ns, st.st_size)
                    except OSError:
                        pass
            self.session.pinned=[new if folder_ops.same_path(path, old) else path for path in self.session.pinned]
            self.recent=[new if folder_ops.same_path(path, old) else path for path in self.recent]
            for paths in self.session.workspace.values():
                for entry in paths:
                    if entry["path"] and folder_ops.same_path(entry["path"], old):entry["path"]=new
            self.message="Renamed note: "+Path(new).name
        else:
            for loc_key in [k for k in list(self.session.locations) if folder_ops.same_path(k, old)]:
                self.session.locations.pop(loc_key, None)
            self.session.pinned=[path for path in self.session.pinned if not folder_ops.same_path(path, old)]
            self.recent=[path for path in self.recent if not folder_ops.same_path(path, old)]
            for tab in list(self.tabs):
                if not tab["path"] or not folder_ops.same_path(tab["path"], old):continue
                if self._is_dirty(tab):
                    draft={**tab,"path":"","name":"Recovered "+tab["name"],"saved":"","conflict":False}
                    self.session.drafts.setdefault("deleted-notes",[]).append(draft)
                    tab.update(path="",name=draft["name"],conflict=False)
                self._remove_tab(tab["id"])
            self.message="File deleted: "+Path(old).name+". Its tab was closed; unsaved changes remain recoverable."
        self.session.workspace_links.invalidate()
        self._preferences();self._recover();self._emit()

    def _reload_changed_content(self,changed):
        self._watch_notes(force=True)
        active_suspensions = self._active_watch_suspensions()
        for tab in self.tabs:
            path=tab["path"]
            if (
                not path
                or self._is_path_suspended(path, active_suspensions)
                or not ({path,str(Path(path).parent)} & changed)
                or tab["id"] in self.saving
            ):
                continue
            was_dirty=self._is_dirty(tab)
            try:
                stat_result=Path(path).stat();stamp=(stat_result.st_mtime_ns,stat_result.st_size)
            except OSError:continue
            if not was_dirty and self.note_file_stamps.get(path)==stamp:continue
            id,expected=tab["id"],tab["saved"]
            def finished(result,error,id=id,expected=expected,path=path,stamp=stamp,was_dirty=was_dirty):
                current=next((note for note in self.tabs if note["id"]==id),None)
                if error or not current:return
                self.note_file_stamps[path]=stamp
                content,assets,portable=result
                if was_dirty or self._is_dirty(current) or current.get("conflict"):
                    if content!=current["saved"] or assets!=current.get("saved_assets",{}):
                        current["conflict"]=True
                        self.message="This file changed outside Super MD. Autosave is paused for this tab."
                        self._emit(False)
                    return
                if current["content"]!=expected:return
                if content==expected and assets==current["assets"]:return
                old_assets=current["assets"]
                assets_changed=assets!=old_assets
                merged_assets=_preserve_unchanged_assets(old_assets,assets)
                current.update(content=content,saved=content,assets=merged_assets,saved_assets=dict(merged_assets),assets_dirty=False,portable=portable,conflict=False)
                if assets_changed:self.session.reader_assets.revoke_tab(self.window_id, id)
                self.message="Reloaded externally updated note"
                self._emit(load=id==self.active)
            self._submit(lambda path=path:open_note(Path(path)),finished,False)

    def _schedule_theme(self,*_):
        self.theme_debounce.start(150)

    def _watch_palette(self):
        if self.retired:return
        watched = set(self.palette_watcher.files()+self.palette_watcher.directories())
        for path in system_palette_paths():
            for target in (path,path.parent):
                if target.exists() and str(target) not in watched:
                    self.palette_watcher.addPath(str(target))

    def _palette_changed(self,*_):
        self._watch_palette()  # Atomic file replacement invalidates the old watch.
        self._schedule_theme()

    def _system_setting_changed(self):
        self.system_preferences.readAllStandardOutput()
        self._schedule_theme()

    def _refresh_theme(self):
        if self._theme_running:
            self._theme_pending = True
            return
        self._theme_running = True
        scheme = QGuiApplication.styleHints().colorScheme().name
        def finished(result,error):
            self._theme_running = False
            if not error and result != self._theme_result:
                self._theme_result = result
                self.system_dark,(self.system_mode,self.system_colors) = result
                self._emit()
            if self._theme_pending:
                self._theme_pending = False
                self._schedule_theme()
        self._submit(lambda:(detect_system_dark(scheme),read_system_palette()),finished,False)

    def stop(self):
        if self.retired: return
        if self._storage_cancel_event is not None:self._storage_cancel_event.set()
        self._cancel_subfolder_search()
        if self._folder_search_cancel is not None:self._folder_search_cancel.set()
        self._search_pool.shutdown(wait=False, cancel_futures=True)
        self._export_jobs.cancel_all()
        self._python_jobs.cancel_all(retire=True)
        for agent_export in tuple(self._agent_exports.values()):
            try:
                reserved = Path(agent_export["path"])
                if reserved.exists() and reserved.stat().st_size == 0:
                    reserved.unlink()
            except (OSError, TypeError, KeyError):
                pass
        self._agent_exports.clear()
        if self.position_timer.isActive():self._save_positions()
        self.position_timer.stop()
        if self.preference_timer.isActive():self._preferences(False)
        self.preference_timer.stop()
        self.theme_timer.stop()
        self.theme_debounce.stop()
        self.custom_theme_timer.stop()
        self.recovery_timer.stop()
        self.autosave_timer.stop()
        self.flush_timer.stop()
        self.external_timer.stop()
        self.filter_timer.stop()
        for attr in ("note_watcher", "palette_watcher", "custom_theme_watcher"):
            watcher = getattr(self, attr, None)
            if watcher is None or watcher is _STOPPED_WATCHER:
                continue
            watched = watcher.files() + watcher.directories()
            if watched:
                watcher.removePaths(watched)
            setattr(self, attr, _STOPPED_WATCHER)
            if shiboken6 is not None and shiboken6.isValid(watcher):
                watcher.setParent(None)
                shiboken6.delete(watcher)
            else:
                watcher.deleteLater()
        for signal, slot in (
            (QGuiApplication.styleHints().colorSchemeChanged, getattr(self, "_color_scheme_slot", None)),
            (self.session.changed, getattr(self, "_session_changed_slot", None)),
            (self.session.locationChanged, getattr(self, "_location_changed_slot", None)),
        ):
            if slot is not None:
                try:
                    signal.disconnect(slot)
                except (RuntimeError, TypeError):
                    pass
        self._recover()
        self.session.reader_assets.revoke_owner(self.window_id)
        self._retired = True
        self.session.windows.pop(self.window_id, None)
        with self._write_callback_lock:
            retired_callbacks = list(self._pending_write_retirements.values())
            self._pending_write_retirements.clear()
        for callback in retired_callbacks:
            try:
                callback()
            except Exception:
                pass
        if not any(not w.retired for w in self.session.windows.values()):
            for cleanup in list(self.session._pending_rename_cleanups.values()):
                try:
                    cleanup()
                except Exception:
                    pass
        if not self.session.is_quitting() and self.session.windows:
            self.session.workspace.pop(self.window_id,None)
            self.session.window_workspaces.pop(self.window_id,None)
            next(iter(self.session.windows.values()))._recover()
        if self.system_preferences.state() != QProcess.ProcessState.NotRunning:
            self.system_preferences.terminate()
            self.system_preferences.waitForFinished(300)

    def _folder_slice_key(self, files):
        return (
            self.folder,
            self.folder_filter,
            bool(self._folder_searching),
            getattr(self, "_files_revision", 0),
            id(files),
            len(files),
        )

    _EMPTY_OUTLINE = ()

    def _tab_outline(self, tab):
        outline = tab.get("outline")
        return outline if isinstance(outline, list) and outline else self._EMPTY_OUTLINE

    def _outline_slice_key(self, active_id, outline):
        return (
            active_id,
            getattr(self, "_outline_revision", 0),
            id(outline),
            len(outline),
        )

    def _sidebar_slice_key(self):
        tab = self._current()
        active_id = self.active if self.tabs else ""
        outline = self._tab_outline(tab)
        files = self.files
        return (
            self._folder_slice_key(files),
            self._outline_slice_key(active_id, outline),
            (tuple(self.recent), tuple(self.session.pinned)),
        )

    def _cached_folder_slice_json(self, folder_key, files):
        cached = getattr(self, "_folder_slice_cache", None)
        if cached is not None and cached[0] == folder_key:
            return cached[1]
        encoded = json.dumps({
            "folder": self.folder,
            "folderFilter": self.folder_filter,
            "folderSearching": bool(self._folder_searching),
            "files": files,
        })[1:-1]
        self._folder_slice_cache = (folder_key, encoded)
        return encoded

    def _cached_outline_slice_json(self, outline_key, outline):
        cached = getattr(self, "_outline_slice_cache", None)
        if cached is not None and cached[0] == outline_key:
            return cached[1]
        encoded = json.dumps(outline)
        self._outline_slice_cache = (outline_key, encoded)
        return encoded

    def _cached_recent_slice_json(self, recent_tuple):
        cached = getattr(self, "_recent_slice_cache", None)
        if cached is not None and cached[0] == recent_tuple:
            return cached[1]
        encoded = json.dumps(list(recent_tuple))
        self._recent_slice_cache = (recent_tuple, encoded)
        return encoded

    def _cached_pinned_slice_json(self, pinned_tuple):
        cached = getattr(self, "_pinned_slice_cache", None)
        if cached is not None and cached[0] == pinned_tuple:
            return cached[1]
        encoded = json.dumps(list(pinned_tuple))
        self._pinned_slice_cache = (pinned_tuple, encoded)
        return encoded

    def _cached_tabs_slice_json(self):
        tabs_key = tuple(
            (t["id"], t["name"], t["path"], self._is_dirty(t), bool(t.get("conflict")))
            for t in self.tabs
        )
        cached = getattr(self, "_tabs_slice_cache", None)
        if cached is not None and cached[0] == tabs_key:
            return cached[1]
        encoded = json.dumps([
            {"id": tid, "name": name, "path": path, "dirty": dirty, "conflict": conflict}
            for tid, name, path, dirty, conflict in tabs_key
        ])
        self._tabs_slice_cache = (tabs_key, encoded)
        return encoded

    def _cached_colors_slice_json(self):
        dark, palette = self._tokens()
        token_key = getattr(self, "_token_key", None)
        cached = getattr(self, "_colors_slice_cache", None)
        if token_key is not None and cached is not None and cached[0] == token_key:
            return dark, cached[1]
        encoded = json.dumps(dict(palette))
        self._colors_slice_cache = (token_key, encoded)
        return dark, encoded

    @Property(str, notify=sidebarChanged)
    def sidebarSnapshot(self):
        tab = self._current()
        active_id = self.active if self.tabs else ""
        outline = self._tab_outline(tab)
        files = self.files
        folder_key = self._folder_slice_key(files)
        outline_key = self._outline_slice_key(active_id, outline)
        recent_tuple = tuple(self.recent)
        pinned_tuple = tuple(self.session.pinned)
        sidebar_key = (folder_key, outline_key, (recent_tuple, pinned_tuple))
        cached = getattr(self, "_sidebar_snapshot_cache", None)
        if cached is not None and cached[0] == sidebar_key:
            return cached[1]
        folder_fragment = self._cached_folder_slice_json(folder_key, files)
        outline_json = self._cached_outline_slice_json(outline_key, outline)
        recent_json = self._cached_recent_slice_json(recent_tuple)
        pinned_json = self._cached_pinned_slice_json(pinned_tuple)
        encoded = (
            '{"active": ' + json.dumps(active_id)
            + ", " + folder_fragment
            + ', "outline": ' + outline_json
            + ', "recent": ' + recent_json
            + ', "pinned": ' + pinned_json
            + "}"
        )
        self._sidebar_snapshot_cache = (sidebar_key, encoded)
        return encoded

    @Property(str, notify=changed)
    def snapshot(self):
        tab = self._current()
        active_id = self.active if self.tabs else ""
        outline = self._tab_outline(tab)
        files = self.files
        tabs_json = self._cached_tabs_slice_json()
        folder_fragment = self._cached_folder_slice_json(self._folder_slice_key(files), files)
        outline_json = self._cached_outline_slice_json(self._outline_slice_key(active_id, outline), outline)
        recent_json = self._cached_recent_slice_json(tuple(self.recent))
        dark, colors_json = self._cached_colors_slice_json()
        head_fragment = json.dumps({
            "active": active_id,
            "name": tab["name"],
            "portable": tab["portable"],
            "conflict": bool(tab.get("conflict")),
            "closedCount": len(self.closed_tabs),
            "settings": self.settings,
            "mode": self.mode,
            "fullscreen": self.fullscreen,
            "readerOverlay": self.reader_overlay,
            "imageOverlay": self.image_overlay,
            "readerReady": self.ready,
            "dark": dark,
            "zoom": self.settings["fullZoom" if self.fullscreen else "normalZoom"],
            "busy": self.busy > 0,
            "message": self.message,
            "messageRevision": getattr(self, "_message_revision", 0),
        })[1:-1]
        return (
            '{"tabs": ' + tabs_json
            + ", " + head_fragment
            + ', "outline": ' + outline_json
            + ", " + folder_fragment
            + ', "recent": ' + recent_json
            + ', "colors": ' + colors_json
            + "}"
        )

    @Property("QVariantMap", notify=workspaceSearchChanged)
    def folderSearchState(self):
        sync_pending = bool(
            self._folder_search_open
            and self._folder_search_query.strip()
            and self.flush_operation
            and self.flush_operation.get("action") == "sync_for_search"
        )
        return {
            "open": self._folder_search_open,
            "query": self._folder_search_query,
            "caseSensitive": self._folder_search_case_sensitive,
            "includeDiagrams": self._folder_search_include_diagrams,
            "matches": self._folder_search_matches,
            "scanning": self._folder_search_scanning or sync_pending,
            "scannedFiles": self._folder_search_scanned_files,
            "truncated": self._folder_search_truncated,
            "hasFolder": bool(self.folder),
        }

    def _search_snapshots(self):
        tabs_snap = [
            {
                "id": t["id"],
                "name": t["name"],
                "path": t["path"],
                "content": t["content"],
                "dirty": self._is_dirty(t),
            }
            for t in self.tabs
        ]
        pinned_keys = {canonical_note_key(p) for p in self.session.pinned if p}
        recent_snap = [
            {
                "path": p,
                "name": Path(p).name,
                "pinned": canonical_note_key(p) in pinned_keys,
            }
            for p in self.recent
            if p
        ]
        folder_path = Path(self.folder) if self.folder else None
        return tabs_snap, recent_snap, folder_path, self.active

    def _cancel_folder_search(self, close: bool = False):
        if self._folder_search_cancel is not None:
            self._folder_search_cancel.set()
            self._folder_search_cancel = None
        self._folder_search_generation += 1
        self._folder_search_scanning = False
        if close:
            self._folder_search_open = False
            self._folder_search_matches = []
            self._folder_search_scanned_files = 0
            self._folder_search_truncated = False
            self._folder_search_tabs_sig = None
            if self.flush_operation and self.flush_operation.get("action") == "sync_for_search":
                self.flush_operation = None
                self.flush_timer.stop()

    @Slot()
    def openFolderSearch(self):
        if self.retired:
            return
        self._folder_search_open = True
        self._folder_search_tabs_sig = None
        if self.ready and self.tabs and not self.flush_operation:
            self._flush("sync_for_search")
            self.workspaceSearchChanged.emit()
        else:
            self.workspaceSearchChanged.emit()
            if self._folder_search_query.strip():
                self._start_folder_search()

    @Slot(str, bool, bool)
    def updateFolderSearch(self, query: str, case_sensitive: bool = False, include_diagrams: bool = False):
        if self.retired:
            return
        self._folder_search_query = query if isinstance(query, str) else ""
        self._folder_search_case_sensitive = bool(case_sensitive)
        self._folder_search_include_diagrams = bool(include_diagrams)
        if not self._folder_search_open:
            self._folder_search_open = True
        self._start_folder_search()

    def _start_folder_search(self):
        if self._folder_search_cancel is not None:
            self._folder_search_cancel.set()
            self._folder_search_cancel = None
        self._folder_search_generation += 1
        generation = self._folder_search_generation
        self._folder_search_matches = []
        self._folder_search_scanned_files = 0
        self._folder_search_truncated = False
        query = self._folder_search_query
        if not query or not query.strip():
            self._folder_search_scanning = False
            self._folder_search_tabs_sig = None
            self.workspaceSearchChanged.emit()
            return
        cancel_event = threading.Event()
        self._folder_search_cancel = cancel_event
        self._folder_search_scanning = True
        self._folder_search_tabs_sig = [(t["id"], t["content"], self._is_dirty(t)) for t in self.tabs]
        self.workspaceSearchChanged.emit()

        tabs_snap, recent_snap, folder_path, active_id = self._search_snapshots()
        case_sensitive = self._folder_search_case_sensitive
        exclude_diagrams = not self._folder_search_include_diagrams

        def emit_batch(batch: list[dict], scanned: int, truncated: bool, done: bool):
            if self.retired or cancel_event.is_set():
                return
            self.workspaceSearchBatch.emit(generation, batch, scanned, truncated, done)

        def worker():
            stream_text_search(
                query,
                tabs_snap,
                recent_snap,
                folder_path,
                active_id=active_id,
                case_sensitive=case_sensitive,
                exclude_diagrams=exclude_diagrams,
                cancel_event=cancel_event,
                on_batch=emit_batch,
            )

        try:
            self._search_pool.submit(worker)
        except RuntimeError:
            self._folder_search_scanning = False
            self.workspaceSearchChanged.emit()

    def _on_workspace_search_batch(self, generation: int, batch, scanned: int, truncated: bool, done: bool):
        if self.retired or not self._folder_search_open or generation != self._folder_search_generation:
            return
        if batch:
            self._folder_search_matches = self._folder_search_matches + list(batch)
        self._folder_search_scanned_files = scanned
        self._folder_search_truncated = bool(truncated)
        if done:
            self._folder_search_scanning = False
        self.workspaceSearchChanged.emit()

    @Slot()
    def closeFolderSearch(self):
        if not self._folder_search_open and not self._folder_search_scanning:
            return
        self._cancel_folder_search(close=True)
        self.workspaceSearchChanged.emit()

    @Slot()
    def cancelWorkspaceSearch(self):
        changed = self._folder_search_open or self._folder_search_scanning
        self._cancel_folder_search(close=True)
        if changed:
            self.workspaceSearchChanged.emit()

    @Slot(str, str, str, bool)
    @Slot(str, str, str, bool, int, int)
    @Slot(str, str, str, bool, int, int, str)
    def openFolderSearchMatch(
        self,
        tab_id: str,
        path: str,
        query: str,
        case_sensitive: bool = False,
        source_start: int = -1,
        source_end: int = -1,
        match_text: str = "",
    ):
        if self.retired:
            return
        self._cancel_folder_search(close=True)
        self.workspaceSearchChanged.emit()
        payload: dict[str, object] = {
            "tabId": tab_id or "",
            "path": path or "",
            "query": query or "",
            "caseSensitive": bool(case_sensitive),
        }
        payload.update(self._seeded_find_bounds({
            "sourceStart": source_start,
            "sourceEnd": source_end,
            "matchText": match_text,
        }))
        self._flush("open_search_match", json.dumps(payload))

    @Property(bool, notify=changed)
    def agentAccessEnabled(self):
        bridge = getattr(self.session, "agent_bridge", None)
        return bool(bridge and bridge.enabled)

    @Property(str, notify=changed)
    def agentAccessStatus(self):
        bridge = getattr(self.session, "agent_bridge", None)
        if self._agent_error:
            return self._agent_error
        if not bridge or not bridge.enabled:
            return "Off · no live tabs are exposed"
        return "On · loopback only (fresh token each launch)"

    def _agent_mcp_roots(self) -> list[str]:
        windows = [self]
        if hasattr(self, "session") and hasattr(self.session, "windows"):
            windows.extend(window for window in self.session.windows.values()
                           if window is not self and not getattr(window, "retired", False))
        candidates: list[str | Path] = []
        for window in windows:
            folder = getattr(window, "folder", "")
            if folder:
                candidates.append(folder)
        location = self.settings.get("newNoteLocation") if isinstance(getattr(self, "settings", None), dict) else None
        if location:
            candidates.append(location)
        for window in windows:
            for tab in getattr(window, "tabs", ()):
                tab_path = tab.get("path") if isinstance(tab, dict) else None
                if isinstance(tab_path, str) and tab_path:
                    candidates.append(Path(tab_path).parent)
        return _normalize_mcp_roots(candidates)

    @Property(str, notify=changed)
    def agentSetupInstructions(self):
        bridge = getattr(self.session, "agent_bridge", None)
        if not bridge or not bridge.enabled:
            return "Enable live agent access to prepare the local MCP server configuration."
        return json.dumps(
            agent_mcp_setup_config(bridge.discovery_dir, roots=self._agent_mcp_roots()),
            ensure_ascii=False,
            indent=2,
        )

    @Property(str, notify=changed)
    def agentAccessTabsSummary(self):
        bridge = getattr(self.session, "agent_bridge", None)
        if not bridge or not bridge.enabled:
            return "No tabs are exposed."
        studios = [window for window in self.session.windows.values() if not window.retired]
        tabs = sum(len(window.tabs) for window in studios)
        return f"{tabs} open tabs across {len(studios)} windows are available to the local MCP server."

    @Property(bool, notify=changed)
    def cloudAgentConfigured(self):
        return self._agent_cloud_config_path.is_file()

    @Property(bool, notify=changed)
    def cloudAgentRevocationPending(self):
        return self._cloud_revocation_pending

    @Property(bool, notify=changed)
    def cloudAgentEnabled(self):
        bridge = getattr(self.session, "agent_bridge", None)
        return bool(bridge and bridge.cloudClient.enabled)

    @Property(str, notify=changed)
    def cloudAgentStatus(self):
        if self._agent_cloud_error:
            return self._agent_cloud_error
        if self._cloud_revocation_pending:
            return "Disconnecting and revoking this desktop pairing…"
        bridge = getattr(self.session, "agent_bridge", None)
        return bridge.cloudClient.status if bridge else "Cloud relay is unavailable."

    @Property(str, notify=changed)
    def cloudRelayOrigin(self):
        if not self.cloudAgentConfigured:
            return ""
        try:
            try:
                from .agent_cloud import read_cloud_config
            except ImportError:
                from agent_cloud import read_cloud_config
            return read_cloud_config(self._agent_cloud_config_path)["serverOrigin"]
        except Exception:
            return ""

    @Property(str, notify=changed)
    def cloudConnectorUrl(self):
        if not self.cloudAgentConfigured:
            return ""
        try:
            try:
                from .agent_cloud import connector_url, read_cloud_config
            except ImportError:
                from agent_cloud import connector_url, read_cloud_config
            return connector_url(read_cloud_config(self._agent_cloud_config_path))
        except Exception:
            return ""

    def _best_effort_revoke_cloud_config(self, config):
        if not config:
            return
        def run():
            try:
                try:
                    from .agent_cloud import revoke
                except ImportError:
                    from agent_cloud import revoke
                revoke(config, timeout=8)
            except Exception:
                pass
        threading.Thread(target=run, name="supermd-agent-cloud-revoke-old", daemon=True).start()

    @Slot(bool, str)
    def _finish_cloud_revocation(self, confirmed, device_id):
        erased = False
        try:
            try:
                from .agent_cloud import read_cloud_config
            except ImportError:
                from agent_cloud import read_cloud_config
            current = read_cloud_config(self._agent_cloud_config_path)
            if current.get("deviceId") == device_id:
                self._agent_cloud_config_path.unlink(missing_ok=True)
                erased = not self._agent_cloud_config_path.exists()
        except FileNotFoundError:
            erased = True
        except Exception:
            confirmed = False
        self._cloud_revocation_pending = False
        self.settings["cloudAgentEnabled"] = False
        self._preferences()
        if not erased:
            self._agent_cloud_error = "Relay revoke finished, but the local pairing file could not be erased. Remove it from app data before reconnecting."
        elif confirmed:
            self._agent_cloud_error = "Relay revocation confirmed; local pairing credentials were erased."
        else:
            self._agent_cloud_error = "Local pairing credentials were erased, but relay revocation could not be confirmed."
        self._emit(False)

    @Slot()
    def revokeCloudAgent(self):
        if self._cloud_revocation_pending:
            return
        try:
            try:
                from .agent_cloud import read_cloud_config, revoke
            except ImportError:
                from agent_cloud import read_cloud_config, revoke
            config = read_cloud_config(self._agent_cloud_config_path)
            bridge = getattr(self.session, "agent_bridge", None)
            self.settings["cloudAgentEnabled"] = False
            self._preferences()
            self._cloud_revocation_pending = True
            self._agent_cloud_error = ""
            device_id = config["deviceId"]
            def run():
                confirmed = False
                try:
                    if bridge:
                        bridge.stop_cloud()
                    revoke(config, timeout=8)
                    confirmed = True
                except Exception:
                    pass
                self.cloudRevocationFinished.emit(confirmed, device_id)
            threading.Thread(target=run, name="supermd-agent-cloud-revoke", daemon=True).start()
        except Exception as error:
            self._agent_cloud_error = str(error)[:180]
        self._emit(False)

    @Slot(str)
    def _cloud_status_changed(self, _status):
        self._emit(False)

    @Slot(str, result=bool)
    def createAgentPairing(self, server_origin):
        try:
            if self._cloud_revocation_pending:
                raise ValueError("Wait for desktop pairing revocation to finish")
            old_config = None
            try:
                try:
                    from .agent_cloud import read_cloud_config
                except ImportError:
                    from agent_cloud import read_cloud_config
                old_config = read_cloud_config(self._agent_cloud_config_path)
            except Exception:
                pass
            bridge = getattr(self.session, "agent_bridge", None)
            if bridge and bridge.cloudClient.enabled:
                bridge.stop_cloud()
                self.settings["cloudAgentEnabled"] = False
                if self._cloud_started_local_bridge and not self.settings.get("agentAccessEnabled", False):
                    bridge.stop()
                self._cloud_started_local_bridge = False
            try:
                from .agent_cloud import device_config, new_pairing, write_cloud_config
            except ImportError:
                from agent_cloud import device_config, new_pairing, write_cloud_config
            write_cloud_config(self._agent_cloud_config_path, device_config(new_pairing(server_origin)))
            self._best_effort_revoke_cloud_config(old_config)
            self._agent_cloud_error = ""
            self._emit(False)
            return True
        except Exception as error:
            self._agent_cloud_error = str(error)[:180]
            self._emit(False)
            return False

    @Slot(str, result=bool)
    def importAgentPairing(self, source):
        try:
            if self._cloud_revocation_pending:
                raise ValueError("Wait for desktop pairing revocation to finish")
            old_config = None
            try:
                try:
                    from .agent_cloud import read_cloud_config
                except ImportError:
                    from agent_cloud import read_cloud_config
                old_config = read_cloud_config(self._agent_cloud_config_path)
            except Exception:
                pass
            bridge = getattr(self.session, "agent_bridge", None)
            if bridge and bridge.cloudClient.enabled:
                bridge.stop_cloud()
                self.settings["cloudAgentEnabled"] = False
                if self._cloud_started_local_bridge and not self.settings.get("agentAccessEnabled", False):
                    bridge.stop()
                self._cloud_started_local_bridge = False
            try:
                from .agent_cloud import device_config, validate_pairing, write_cloud_config
            except ImportError:
                from agent_cloud import device_config, validate_pairing, write_cloud_config
            path = local_path(source)
            if path.stat().st_size > 16_000:
                raise ValueError("Pairing file is too large")
            pairing = validate_pairing(json.loads(path.read_text(encoding="utf-8")))
            write_cloud_config(self._agent_cloud_config_path, device_config(pairing))
            self._best_effort_revoke_cloud_config(old_config)
            self._agent_cloud_error = ""
            self._emit(False)
            return True
        except Exception as error:
            self._agent_cloud_error = str(error)[:180]
            self._emit(False)
            return False

    @Slot(str, result=bool)
    def exportAgentPairing(self, destination):
        try:
            try:
                from .agent_cloud import export_pairing, read_cloud_config
            except ImportError:
                from agent_cloud import export_pairing, read_cloud_config
            path = local_path(destination)
            export_pairing(path, read_cloud_config(self._agent_cloud_config_path))
            self.message = f"Pairing file saved to {path}"
            self._agent_cloud_error = ""
            self._emit(False)
            return True
        except Exception as error:
            self._agent_cloud_error = str(error)[:180]
            self._emit(False)
            return False

    @Slot(bool)
    def setCloudAgentEnabled(self, enabled):
        bridge = getattr(self.session, "agent_bridge", None)
        try:
            if bridge is None:
                raise ValueError("Cloud agent access is unavailable in this app session")
            if enabled:
                try:
                    from .agent_cloud import read_cloud_config
                except ImportError:
                    from agent_cloud import read_cloud_config
                config = read_cloud_config(self._agent_cloud_config_path)
                was_enabled = bridge.enabled
                bridge.start_cloud(config)
                self._cloud_started_local_bridge = not was_enabled
            else:
                bridge.stop_cloud()
                if self._cloud_started_local_bridge and not self.settings.get("agentAccessEnabled", False):
                    bridge.stop()
                self._cloud_started_local_bridge = False
            self.settings["cloudAgentEnabled"] = bool(enabled)
            self._preferences()
            self._agent_cloud_error = ""
        except Exception as error:
            self.settings["cloudAgentEnabled"] = False
            self._agent_cloud_error = str(error)[:180]
        self._emit(False)

    @Slot()
    def copyCloudConnectorUrl(self):
        url = self.cloudConnectorUrl
        if not url:
            self._agent_cloud_error = "Create or import a pairing before copying the connector URL."
        else:
            QGuiApplication.clipboard().setText(url)
            self._agent_cloud_error = "Connector URL copied. Treat it as a secret."
        self._emit(False)

    @Slot(bool)
    def setAgentAccessEnabled(self, enabled):
        bridge = getattr(self.session, "agent_bridge", None)
        if bridge is None:
            self._agent_error = "Live agent access is unavailable in this app session."
            self._emit(False)
            return
        try:
            if enabled:
                bridge.start()
                self._agent_error = ""
            else:
                bridge.stop()
                self.settings["cloudAgentEnabled"] = False
                self._agent_error = ""
            background = getattr(self.session, "background", None)
            if background is not None:
                background._cli_started_agent_access = False
            self.settings["agentAccessEnabled"] = bool(enabled)
            self._preferences()
            self._emit(False)
        except Exception as error:
            self._agent_error = f"Could not enable live agent access ({type(error).__name__})."
            self.settings["agentAccessEnabled"] = False
            self._emit(False)

    @Slot()
    def copyAgentSetupInstructions(self):
        if not self.agentAccessEnabled:
            self._agent_error = "Enable live agent access before copying its MCP configuration."
            self._emit(False)
            return
        QGuiApplication.clipboard().setText(self.agentSetupInstructions)
        self._agent_error = ""
        self.message = "MCP server configuration copied to clipboard"
        self._emit(False)

    @Slot(str)
    def saveAgentSetupInstructions(self, destination):
        if not self.agentAccessEnabled:
            self._agent_error = "Enable live agent access before saving its setup guide."
            self._emit(False)
            return
        try:
            path = local_path(destination)
            if path.suffix.casefold() != ".md":
                path = path.with_suffix(".md")
            skill_path = ROOT / "dist" / "super-md-agent-SKILL.md"
            if skill_path.is_file():
                skill = skill_path.read_text(encoding="utf-8").rstrip()
            elif not getattr(sys, "frozen", False):
                skill = _bundle_agent_skill_markdown(ROOT / "docs" / "skills" / "super-md").rstrip()
            else:
                raise FileNotFoundError("Bundled super-md-agent-SKILL.md is missing")
            guide = (skill + "\n\n# Connection for this installation\n\n"
                     "This local MCP server can inspect and revise tabs that are open in this Super MD app session. "
                     "It runs over stdio and reads the private, temporary discovery directory shown below.\n\n"
                     "## MCP client configuration\n\n```json\n" + self.agentSetupInstructions + "\n```\n\n"
                     "Live access is off by default. Enable it in Super MD Settings → AI agents before starting the MCP server. "
                     "Disabling access or closing Super MD revokes the temporary session token. The token is not included in this file.\n\n"
                     "## Cloud relay connector\n\n"
                     "Cloud relay connector URLs are secret bearer credentials and are not included in saved setup guides. "
                     "To connect a cloud MCP client, open Super MD Settings → AI agents and use Copy MCP connector URL to get your own connector.\n")
            atomic_write(path, guide.encode("utf-8"))
            self._agent_error = ""
            self.message = f"Setup guide saved to {path}"
            self._emit(False)
        except (OSError, ValueError, TypeError) as error:
            self._agent_error = f"Could not save setup guide ({type(error).__name__})."
            self._emit(False)

    @Slot(str, result=bool)
    def exportAgentSkill(self, destination):
        try:
            path = local_path(destination)
            if path.suffix.casefold() != ".zip":
                path = path.with_suffix(".zip")
            raw = _build_agent_skill_zip_bytes(ROOT)
            atomic_write(path, raw)
            self._agent_error = ""
            self.message = f"Skill package saved to {path}"
            self._emit(False)
            return True
        except (OSError, ValueError, TypeError, zipfile.BadZipFile) as error:
            self._agent_error = f"Could not save skill package ({type(error).__name__})."
            self._emit(False)
            return False

    @Property(bool,notify=changed)
    def readerFullscreen(self):return self.fullscreen

    @Property(str,notify=changed)
    def selectionAssistantLabel(self):
        provider=self.settings.get("selectionAssistant")
        return ASSISTANTS.get(provider,"ChatGPT") if isinstance(provider,str) else "ChatGPT"

    @Slot(str,str)
    def selectionAction(self, action, text):
        try:
            url, copy_text, message=selection_target(action,text,self.settings.get("selectionAssistant","chatgpt"))
            if copy_text:QGuiApplication.clipboard().setText(text.replace("\u2029","\n"))
            opened=QDesktopServices.openUrl(QUrl(url))
            self.message=message if opened else "Could not open your browser." + (" The selected text is copied." if copy_text else "")
        except (ValueError,UnicodeError) as error:
            self.message=str(error)
        self._emit(False)

    @Property(bool,notify=changed)
    def retired(self):return self._retired

    @Property(str, constant=True)
    def windowId(self): return self.window_id

    @Property(str,constant=True)
    def appVersion(self):
        metadata=ROOT/"desktop/build-info.json" if getattr(sys,"frozen",False) else ROOT/"package.json"
        return json.loads(metadata.read_text(encoding="utf-8"))["version"]

    @Property(str,notify=changed)
    def updateStatus(self):return self.update_status

    @Property(bool,notify=changed)
    def updateAvailable(self):return self.update_info is not None

    @Property(bool,notify=changed)
    def updateReady(self):return bool(self.update_path)

    @Property(bool,notify=changed)
    def updateBusy(self):return self.update_running

    @Property(str,notify=changed)
    def storageReport(self):return self._storage_report

    @Property(bool,notify=changed)
    def storageBusy(self):return self.storage_busy

    @Property(bool,notify=changed)
    def storageCleanupBusy(self):return self.storage_cleanup_busy

    @Property(str,notify=changed)
    def storageCleanupStatus(self):return self.storage_cleanup_status

    @Slot(str)
    def clearStorageCategory(self, category):
        if category not in ("execution-results", "update-state"):
            self.storage_cleanup_status = "This storage category is protected."
            self._emit(False)
            return
        if self.retired or self.storage_busy or self.storage_cleanup_busy or (category == "update-state" and (self.update_running or self.update_path)):
            self.storage_cleanup_status = "Cleanup is unavailable while storage or updates are in use."
            self._emit(False)
            return
        self.storage_cleanup_busy = True
        self.storage_cleanup_status = ""
        self._emit(False)
        def done(result,error):
            self.storage_cleanup_busy = False
            self.storage_cleanup_status = ("Cleanup failed; app files were not intentionally changed." if error or not result else "Temporary app data cleared. Notes and recovery preserved.")
            self._emit(False)
            self.inspectStorage()
        self._submit(lambda:clear_storage_category(self.data,category),done,False)

    @Slot()
    def openLatestGitHubRelease(self):
        if not QDesktopServices.openUrl(QUrl(updates.REPO + "/releases/latest")):
            self.message = "Could not open the latest GitHub release in your browser."
        self._emit(False)

    @Slot()
    def inspectStorage(self):
        if self.retired or self.storage_busy:return
        cancel_event=threading.Event()
        self._storage_cancel_event=cancel_event
        self.storage_busy=True
        self._storage_report=json.dumps({"status":"scanning","cancelled":False,"truncated":False,"scannedEntries":0,"categories":[]})
        self._emit(False)
        def done(report,error):
            if self._storage_cancel_event is not cancel_event:return
            self._storage_cancel_event=None
            self.storage_busy=False
            if error or not isinstance(report,dict):
                # Keep exception text out of UI/report: filesystem errors may
                # contain private local paths.
                report={"status":"partial","cancelled":cancel_event.is_set(),"truncated":False,"scannedEntries":0,"categories":[],"message":"Some app data could not be inspected."}
            self._storage_report=json.dumps(report,separators=(",",":"))
            self._emit(False)
        self._submit(lambda:inspect_storage(self.data,cancel_event),done,False)

    @Slot()
    def cancelStorageInspection(self):
        if self._storage_cancel_event is not None:self._storage_cancel_event.set()

    @Property(bool,constant=True)
    def desktopIntegrationAvailable(self):return app_integration.available()

    def _restore_update(self):
        self.update_running=True
        def done(saved,error):
            self.update_running=False
            if saved:
                self.update_info=saved['release'];self.update_path=saved['path'];self.update_status='Verified update ready in Downloads.'
            if self.settings.get('checkUpdates'):QTimer.singleShot(6000,lambda:self.checkUpdates(True) if not self.retired else None)
        self._submit(lambda:updates.load_ready(self.data/'updates',self.appVersion),done,False)

    @Slot(bool)
    def setDesktopIntegration(self,enabled):
        if not self.desktopIntegrationAvailable or self.update_running:return
        if not enabled:
            self.setting('desktopIntegration','false');return
        self.update_running=True;self.update_status='Adding Super MD to your applications…';self._emit(False)
        def done(path,error):
            self.update_running=False
            if error:self.update_status='Desktop integration failed: '+error;return
            self.setting('desktopIntegration','true');self.update_status='Added to Applications and Open With. Your file defaults are unchanged.'
        self._submit(lambda:app_integration.integrate_current(self.appVersion),done,False)

    @Slot()
    def downloadUpdate(self):
        if self.update_running or not self.update_info or self.update_path:return
        self.update_running=True;self.update_status="Downloading and verifying update…";self._emit(False)
        info=dict(self.update_info)
        def done(path,error):
            self.update_running=False
            if error:self.update_status="Update download failed: "+error;return
            self.update_path=path;self.update_status="Verified update ready. Save your work, then open the installer."
        downloads=Path(QStandardPaths.writableLocation(QStandardPaths.StandardLocation.DownloadLocation) or str(Path.home()/'Downloads'))/'Super MD Updates'
        self._submit(lambda:updates.download(info,downloads,self.data/'updates'),done,False)

    @Slot()
    @Slot(bool)
    def checkUpdates(self,automatic=False):
        if self.update_running:return
        self.update_running=True;self.update_status="Checking published releases…";self._emit(False)
        def done(info,error):
            self.update_running=False
            if error:
                self.update_status=updates.check_failure(error)
                if not automatic:self.message=self.update_status
                return
            # Offline/repeated checks must not forget a verified ready installer.
            if info and self.update_info and info['version']==self.update_info['version'] and self.update_path:
                self.update_status='Verified Super MD '+info['version']+' is already downloaded.';return
            if not info and self.update_path:return
            self.update_path=""
            self.update_info=info
            if not info:self.update_status="You're on the latest published version.";return
            self.update_status="Super MD "+info["version"]+" is available."
            self.message=self.update_status
            if automatic:
                try:
                    from PySide6.QtWidgets import QApplication, QSystemTrayIcon
                    from PySide6.QtGui import QIcon
                    if isinstance(QGuiApplication.instance(),QApplication) and QSystemTrayIcon.isSystemTrayAvailable():
                        self.update_tray=QSystemTrayIcon(QIcon(str(ROOT/"public/brand-mark-fixed.svg")),self)
                        self.update_tray.setToolTip("Super MD updates");self.update_tray.show();self.update_tray.showMessage("Super MD update",self.update_status)
                except RuntimeError:pass
            if self.settings.get("autoUpdate"):self.downloadUpdate()
        def check():
            try:
                linux_kind=updates.linux_install_kind() if sys.platform.startswith("linux") else "appimage"
                return updates.release_info(updates.bounded_json(updates.API),self.appVersion,linux_kind=linux_kind),None
            except Exception as failure:return None,failure
        self._submit(check,lambda result,error:done(*(result or (None,error))),False)

    @Property(bool,notify=changed)
    def backgroundEnabled(self):
        if getattr(self.session, "update_installed", False):
            return False
        service=getattr(self.session,"background",None)
        return bool(service and service.enabled and not service.quitting)

    @Slot(result=bool)
    def hasOtherOpenWindows(self):
        return any(
            other is not self
            and not other.retired
            and (getattr(other, "host_window", None) is None or other.host_window.isVisible())
            for other in self.session.windows.values()
        )

    @Property(bool,notify=changed)
    def deferReaderActivation(self):
        return bool(getattr(self, "_defer_reader_activation", False))

    @Property(str,notify=changed)
    def pythonStatus(self): return self.python_status

    @Property(str,notify=changed)
    def pythonChoices(self): return json.dumps(self.python_choices)

    @Property(bool,notify=changed)
    def pythonBusy(self): return self.python_busy

    @Property(bool,constant=True)
    def pythonBundled(self): return python_runtime.bundled_available()

    def _python_folders(self):
        return [p for p in [self.folder, *(str(Path(t["path"]).parent) for t in self.tabs if t.get("path"))] if p]

    def _choose_default_python(self, emit: bool = True):
        if self.retired or self.settings.get("python"):
            return
        path = python_runtime.default_python(self.data / "python-env")
        if path:
            self.settings["python"] = path
            self._preferences(notify=emit)
        if emit:
            self._emit(False)

    @Slot(str)
    def _python_progress(self, text):
        self.python_status = text
        self._emit(False)

    @Slot()
    def refreshPython(self):
        if self.retired or self.python_busy or getattr(self.pool, "_shutdown", False): return
        managed = self.data / "python-env"
        folders = tuple(self._python_folders())
        self.python_busy = True
        self.python_status = "Looking for Python installations"
        self._emit(False)
        def done(choices,error):
            self.python_busy = False
            self.python_choices = choices or []
            if error: self.python_status = error
            elif not self.python_choices: self.python_status = "No Python found. Use Set up Python to create one, or install Python 3."
            elif not any(c["matplotlib"] for c in self.python_choices): self.python_status = "Python found, but numpy and matplotlib are missing. Set up Python installs both in a private environment."
            else: self.python_status = ""
            self._emit(False)
        self._submit(lambda: python_runtime.discover(managed, folders), done, False)

    @Slot(str)
    def installPythonPackages(self, path):
        if self.retired or self.python_busy or getattr(self.pool, "_shutdown", False): return
        self.python_busy = True
        self.python_status = "Preparing to install numpy and matplotlib"
        self._emit(False)
        def done(result,error):
            self.python_busy = False
            if error:
                self.python_status = error
                self._emit(False)
                return
            self.settings["python"] = result
            self._preferences()
            self.refreshPython()
        self._submit(lambda: python_runtime.install_packages(path, self.pythonProgress.emit), done, False)

    @Slot()
    def setupPython(self):
        if self.retired or self.python_busy or getattr(self.pool, "_shutdown", False): return
        managed = self.data / "python-env"
        self.python_busy = True
        self.python_status = "Preparing Python setup"
        self._emit(False)
        def done(path,error):
            self.python_busy = False
            if error:
                self.python_status = error
                self._emit(False)
                return
            self.settings["python"] = path
            self._preferences()
            self.python_status = "Python with numpy and matplotlib is ready"
            self._emit()
            self.python_busy = False
            self.refreshPython()
            self.python_status = "Python with numpy and matplotlib is ready"
        self._submit(lambda: python_runtime.setup_environment(managed, self.pythonProgress.emit), done, False)

    @Slot(int, int, bool)
    def rememberWindow(self, width, height, maximized):
        # Reopen at the size people left, not a fixed default every launch.
        value = {"width": max(760, min(10000, int(width))), "height": max(520, min(10000, int(height))), "maximized": bool(maximized)}
        if self.settings.get("window") != value:
            self.settings["window"] = value
            self._preferences()

    @Slot()
    def installUpdate(self):
        if not self.update_path or self.update_running:return
        try:
            kind=updates.installer_kind(self.update_info)
        except (TypeError,ValueError,KeyError):
            self.update_status='Update information is invalid. Check for updates again.'
            self._emit(False);return
        if kind=='appimage' and not self.desktopIntegrationAvailable:
            self.update_status='This installation is package-managed. Install the DEB/RPM from the release page using your package manager.'
            QDesktopServices.openUrl(QUrl(updates.REPO+'/releases/latest'));self._emit(False);return
        self.update_running=True;self.update_status='Verifying and preparing installation…';self._emit(False)
        def prepare():
            saved=updates.load_ready(self.data/'updates',self.appVersion)
            if not saved or saved['path']!=self.update_path:raise ValueError('Installer changed or is missing. Download the update again.')
            prepared_kind=updates.installer_kind(saved['release'])
            if not self.update_info or saved['release']['version']!=self.update_info.get('version'):
                raise ValueError('The verified installer no longer matches the selected update. Check for updates again.')
            if prepared_kind=='appimage':
                installed=app_integration.install_appimage(self.update_path,saved['release']['version'],self.settings.get('desktopIntegration',False))
                return installed,prepared_kind
            return self.update_path,prepared_kind
        def done(prepared,error):
            self.update_running=False
            if error:self.update_status='Update installation failed: '+error;return
            path,prepared_kind=prepared
            if prepared_kind=='appimage':
                self.session.update_installed=True;self.session.changed.emit()
                self.update_status='Update installed. Close and reopen Super MD to use it. Your previous version and downloaded installer have been kept.'
            else:
                opened=QProcess.startDetached(path,[]) if prepared_kind=='windows' else QDesktopServices.openUrl(QUrl.fromLocalFile(path))
                if isinstance(opened,tuple):opened=opened[0]
                if not opened:
                    self.update_status='Could not open the verified installer. It is still available in Downloads.'
                else:
                    self.session.update_installed=True;self.session.changed.emit()
                    if prepared_kind in ('deb','rpm'):
                        self.update_status='Package installer opened. Confirm the update there; Super MD will not request elevated permissions automatically.'
                    elif prepared_kind=='macos':
                        self.update_status='Disk image opened. Drag Super MD into Applications and confirm replacement to update.'
                    else:
                        self.update_status='Installer opened. Follow its instructions; the download is kept in Downloads.'
            self._emit(False)
        self._submit(prepare,done,False)

    def _can_move(self):
        return not (self.retired or self.busy or self.saving or self.pending_close or self.pending_save_as or self.pending_export or self.flush_operation)

    @Slot(str, str, result=bool)
    def canReceiveTab(self, source_id, tab_id):
        source = self.session.windows.get(source_id)
        return bool(source and source._can_move() and self._can_move() and any(t["id"] == tab_id for t in source.tabs))

    @Slot(str, str, int)
    def receiveTab(self, source_id, tab_id, index):
        if not self.canReceiveTab(source_id, tab_id): return
        source = self.session.windows[source_id]
        if source is self:
            old = next(i for i, t in enumerate(self.tabs) if t["id"] == tab_id)
            note = self.tabs.pop(old)
            self.tabs.insert(max(0, min(len(self.tabs), index - (1 if old < index else 0))), note)
            self._recover(); self._emit(False)
        else:
            source._flush("move_tab", json.dumps({"window": self.window_id, "tab": tab_id, "index": index}))

    def _move_tab(self, target, tab_id, index):
        # Keep the exact note object, including unsaved content and portable assets.
        # Only remove it after the destination is alive and can accept ownership.
        if target is self or not self._can_move() or not target._can_move(): return False
        note = next((t for t in self.tabs if t["id"] == tab_id), None)
        if not note: return False
        old = self.tabs.index(note)
        self.tabs.remove(note)
        self.session.reader_assets.revoke_tab(self.window_id, tab_id)
        target.tabs.insert(max(0, min(len(target.tabs), index)), note)
        target.active = tab_id
        emptied = not self.tabs
        if emptied: self.tabs.append(self._note("Untitled.md"))
        if self.active == tab_id: self.active = self.tabs[min(old, len(self.tabs)-1)]["id"]
        # Update both owners before writing one recovery snapshot: never duplicate
        # or temporarily lose a dirty note in the durable recovery stream.
        self.session.drafts[self.window_id] = [_snapshot_tab_state(t, include_view_state=False) for t in self.tabs if self._is_dirty(t) and (t["path"] or t["content"].strip() or t["assets"])]
        target._recover()
        self._emit(); target._emit()
        if emptied: QTimer.singleShot(0, self.allowClose.emit)
        return True

    @Slot(str)
    def detachTab(self, tab_id):
        if self._can_move() and any(t["id"] == tab_id for t in self.tabs): self._flush("detach_tab", tab_id)

    @Slot(str,result=str)
    def tabPreview(self,id):
        note=next((t for t in self.tabs if t["id"]==id),None)
        return note["content"][:900] if note else ""

    @Slot(str, int)
    def finishTabDrag(self, tab_id, action):
        if action != int(Qt.DropAction.IgnoreAction.value): return
        # QDrag's nested event loop can finish before Wayland delivers the
        # release to Qt's button-state cache. Wait for that delivery before
        # distinguishing an outside drop from Escape while still held.
        QTimer.singleShot(150, lambda:self._finish_tab_drag(tab_id))

    def _finish_tab_drag(self, tab_id):
        # Escape cancels QDrag while the button is still held; never detach then.
        if QGuiApplication.mouseButtons() & Qt.MouseButton.LeftButton: return
        cursor = QCursor.pos()
        for backend in self.session.windows.values():
            host = backend.host_window
            if not host or not host.isVisible(): continue
            strip = host.findChild(QObject, "tabStrip")
            if strip:
                point = strip.mapFromGlobal(QPointF(cursor))
                if 0 <= point.x() <= strip.width() and 0 <= point.y() <= strip.height(): return
        self.detachTab(tab_id)

    @Property("QStringList", notify=changed)
    def fonts(self):
        preferred = ["Manrope", "Roboto", "Noto Sans", "Noto Serif", "JetBrains Mono", "Libertinus Serif", "New Computer Modern", "DejaVu Sans Mono"]
        return preferred + sorted(set(QFontDatabase.families()) - set(preferred))

    @Property(bool, constant=True)
    def fedoraWindowFrame(self):
        if not sys.platform.startswith("linux"):
            return False
        try:
            return platform.freedesktop_os_release().get("ID") == "fedora"
        except OSError:
            return False

    @Property(bool, constant=True)
    def showToolbarWindowControls(self):
        desktop = os.environ.get("XDG_CURRENT_DESKTOP", "").lower()
        return self.fedoraWindowFrame or (sys.platform.startswith("linux") and
            any(name in desktop for name in ("hyprland", "sway", "river", "niri")))

    @Slot()
    def chooseFont(self): self.fontPickerRequested.emit()

    @Slot()
    def chooseCustomTheme(self):self.themePickerRequested.emit()

    @Slot()
    def chooseThemeExport(self):self.themeExportRequested.emit()

    @Slot()
    def openThemeGuide(self):self.readerCall.emit("window.supermdThemeGuide?.()")

    def _save_theme_library(self):
        atomic_json(
            self.data / "theme-library.json",
            {
                "active": {"kind": self.session.active_theme_kind, "id": self.session.active_theme_id},
                "saved": self.session.saved_themes,
            },
        )

    def _clear_theme_background_overrides(self):
        changed = any(
            self.settings.get(key) != default
            for key, default in (("patternKind", ""), ("patternOpacity", -1), ("patternSize", 0), ("patternSpacing", 0))
        )
        self.settings.update(patternKind="", patternOpacity=-1, patternSize=0, patternSpacing=0)
        if changed:
            self._preferences(False)

    def _watch_custom_theme(self):
        if self.retired:return
        watcher=self.custom_theme_watcher
        paths=watcher.files()+watcher.directories()
        if paths:watcher.removePaths(paths)
        source=Path(self.session.theme_source) if self.session.active_theme_kind!="preset" and self.session.theme_source else None
        self.custom_theme_stamp=custom_theme.stamp(source) if source else None
        if source:
            watcher.addPaths([str(path) for path in (source,source.parent) if path.exists()])

    def _custom_theme_event(self):
        if self.retired or self.session.active_theme_kind=="preset" or not self.session.theme_source:return
        value=custom_theme.stamp(Path(self.session.theme_source))
        if value==self.custom_theme_stamp:return
        self.custom_theme_stamp=value
        self.reloadCustomTheme()

    def _restore_custom_theme(self):
        if self.retired:
            return
        self._watch_custom_theme()
        if self.session.theme_restored:
            return
        self.session.theme_restored = True
        kind = self.session.active_theme_kind
        cached = self.data / "theme.json"
        if kind == "preset":
            try:
                target = cached if cached.is_file() else custom_theme.bundled_theme_path(self.session.active_theme_id, ROOT)
            except ValueError:
                return
            self._load_custom_theme(target, mode="restore")
            return
        if kind == "saved":
            saved_file = self.data / "themes" / f"{self.session.active_theme_id}.json"
            primary = saved_file if saved_file.is_file() else cached
            source = Path(self.session.theme_source) if self.session.theme_source else None
            follow = source if source and source.is_file() and source != primary else None
            if primary.is_file():
                self._load_custom_theme(primary, mode="restore", follow_source=follow)
            elif follow:
                self._load_custom_theme(follow, mode="restore")
            return
        source = Path(self.session.theme_source) if self.session.theme_source else cached
        if not source.is_file():
            source = cached
        if self.session.custom_theme is None and cached.is_file() and cached != source:
            self._load_custom_theme(cached, mode="restore", follow_source=source)
        elif source.is_file():
            self._load_custom_theme(source, mode="restore")

    @Slot(str)
    def importCustomTheme(self,value):self._load_custom_theme(local_path(value),mode="import")

    @Slot(str)
    def selectBundledTheme(self,preset_id):self._apply_bundled_theme(preset_id)

    def _apply_bundled_theme(self,preset_id,callback=None):
        if not isinstance(preset_id,str) or not preset_id:
            if callback:callback(None,"Unknown bundled theme")
            return
        if preset_id=="builtin":
            self.resetCustomTheme()
            if callback:callback({"id":"builtin","name":"Built-in appearance"},"")
            return
        try:
            path=custom_theme.bundled_theme_path(preset_id,ROOT)
        except ValueError as error:
            self.message="Theme not applied: "+str(error);self._emit(False)
            if callback:callback(None,str(error))
            return
        self._load_custom_theme(path,mode="preset",preset_id=preset_id,callback=callback)

    @Slot(str)
    def selectSavedTheme(self,entry_id):
        entry=next((item for item in self.session.saved_themes if item["id"]==entry_id),None)
        if entry is None:return
        path=self.data/"themes"/f"{entry_id}.json"
        if not path.is_file():
            self.message="Saved theme is unavailable.";self._emit(False);return
        self._load_custom_theme(path,mode="saved",entry_id=entry_id)

    @Slot(str)
    def deleteSavedTheme(self,entry_id):
        entry=next((item for item in self.session.saved_themes if item["id"]==entry_id),None)
        if entry is None:return
        self.session.saved_themes=[item for item in self.session.saved_themes if item["id"]!=entry_id]
        (self.data/"themes"/f"{entry_id}.json").unlink(missing_ok=True)
        was_active=self.session.active_theme_kind=="saved" and self.session.active_theme_id==entry_id
        if was_active:
            self.session.theme_epoch+=1
            self.session.custom_theme=None
            self.session.theme_source=""
            self.session.active_theme_kind="builtin"
            self.session.active_theme_id=""
            self.session.theme_revision+=1
            for filename in ("theme.json","theme-source.json"):(self.data/filename).unlink(missing_ok=True)
            self._clear_theme_background_overrides()
            for window in self.session.windows.values():window._watch_custom_theme()
        try:self._save_theme_library()
        except OSError:pass
        self.message="Removed "+entry["name"]
        self.session.changed.emit()

    @Slot()
    def reloadCustomTheme(self):
        if self.retired or self.session.active_theme_kind=="preset":return
        if self.session.active_theme_kind=="saved" and not self.session.theme_source:return
        source=Path(self.session.theme_source) if self.session.theme_source else self.data/"theme.json"
        if not source.is_file():source=self.data/"theme.json"
        self._watch_custom_theme()
        cached=self.data/"theme.json"
        if self.session.custom_theme is None and cached.is_file() and cached!=source:self._load_custom_theme(cached,mode="restore",follow_source=source,clear_overrides_on_follow=True)
        elif source.is_file():self._load_custom_theme(source,mode="reload")

    def _load_custom_theme(self,path,mode="import",follow_source=None,preset_id="",entry_id="",callback=None,clear_overrides_on_follow=False):
        self.session.theme_epoch+=1
        epoch=self.session.theme_epoch
        try:engine=self._engine()
        except ValueError as error:
            self.message=str(error);self._emit(False)
            if callback:callback(None,str(error))
            return
        def finished(value,error):
            if epoch!=self.session.theme_epoch:
                if callback:callback(None,"Superseded by newer theme selection")
                return
            if error:
                self.message="Theme not applied: "+str(error);self._emit(False)
                if callback:callback(None,str(error))
                if follow_source:self._load_custom_theme(follow_source,mode="reload" if clear_overrides_on_follow else "restore")
                return
            try:
                changed=value!=self.session.custom_theme
                if mode=="import":
                    source_str=str(path)
                    existing=next((item for item in self.session.saved_themes if item.get("source")==source_str),None)
                    if existing is not None:
                        target_id=existing["id"]
                        existing["name"]=value["name"]
                    else:
                        target_id=uuid.uuid4().hex
                        self.session.saved_themes.append({"id":target_id,"name":value["name"],"source":source_str})
                    (self.data/"themes").mkdir(parents=True,exist_ok=True)
                    atomic_json(self.data/"themes"/f"{target_id}.json",value)
                    self.session.active_theme_kind="saved"
                    self.session.active_theme_id=target_id
                    self.session.theme_source=source_str
                    atomic_json(self.data/"theme-source.json",{"path":source_str})
                    atomic_json(self.data/"theme.json",value)
                    self._save_theme_library()
                    self._clear_theme_background_overrides()
                elif mode=="preset":
                    self.session.active_theme_kind="preset"
                    self.session.active_theme_id=preset_id
                    self.session.theme_source=""
                    (self.data/"theme-source.json").unlink(missing_ok=True)
                    atomic_json(self.data/"theme.json",value)
                    self._save_theme_library()
                    self._clear_theme_background_overrides()
                elif mode=="saved":
                    entry=next((item for item in self.session.saved_themes if item["id"]==entry_id),None)
                    source_str=entry.get("source","") if entry else ""
                    if entry is not None:entry["name"]=value["name"]
                    self.session.active_theme_kind="saved"
                    self.session.active_theme_id=entry_id
                    self.session.theme_source=source_str
                    if source_str:atomic_json(self.data/"theme-source.json",{"path":source_str})
                    else:(self.data/"theme-source.json").unlink(missing_ok=True)
                    atomic_json(self.data/"theme.json",value)
                    self._save_theme_library()
                    self._clear_theme_background_overrides()
                elif mode=="reload":
                    if self.session.active_theme_kind=="saved" and self.session.active_theme_id:
                        (self.data/"themes").mkdir(parents=True,exist_ok=True)
                        atomic_json(self.data/"themes"/f"{self.session.active_theme_id}.json",value)
                        entry=next((item for item in self.session.saved_themes if item["id"]==self.session.active_theme_id),None)
                        if entry is not None:entry["name"]=value["name"]
                        self._save_theme_library()
                    if changed:atomic_json(self.data/"theme.json",value)
                    self._clear_theme_background_overrides()
                else:
                    if changed:atomic_json(self.data/"theme.json",value)
                self.session.custom_theme=value
                if changed:self.session.theme_revision+=1
                for window in self.session.windows.values():window._watch_custom_theme()
                if mode in ("import","preset","saved","reload") or (mode!="restore" and changed):
                    self.message="Applied "+value["name"]
                self.session.changed.emit()
                if callback:callback({"id":preset_id or entry_id or self.session.active_theme_id,"name":value["name"]},"")
            except OSError as failure:
                self.message="Could not save theme: "+str(failure);self._emit(False)
                if callback:callback(None,str(failure))
            if follow_source:self._load_custom_theme(follow_source,mode="reload" if clear_overrides_on_follow else "restore")
        def read():
            try:return custom_theme.read(engine,path),None
            except Exception as failure:return None,str(failure)
        self._submit(read,lambda result,error:finished(*(result or (None,error))),False)

    @Slot()
    def resetCustomTheme(self):
        self.session.theme_epoch+=1
        self.session.custom_theme=None;self.session.theme_source=""
        self.session.active_theme_kind="builtin";self.session.active_theme_id=""
        self.session.theme_revision+=1
        for filename in ("theme.json","theme-source.json"):(self.data/filename).unlink(missing_ok=True)
        try:self._save_theme_library()
        except OSError:pass
        self._clear_theme_background_overrides()
        for window in self.session.windows.values():window._watch_custom_theme()
        self.session.changed.emit()

    @Slot()
    def editCustomTheme(self):
        if self.session.active_theme_kind=="preset" or not self.session.theme_source:return
        source=Path(self.session.theme_source)
        if source.is_file():QDesktopServices.openUrl(QUrl.fromLocalFile(str(source)))

    @Slot(str)
    def exportCustomTheme(self,value):
        try:
            atomic_json(local_path(value),custom_theme.for_sharing(self.session.custom_theme))
            self.message="Theme exported. Edit the JSON and import it to apply."
        except OSError as error:self.message=str(error)
        self._emit(False)

    @Slot()
    def chooseNoteLocation(self): self.noteLocationPickerRequested.emit()

    @Slot(str)
    def setNoteLocation(self, value):
        directory = local_path(value)
        if directory.is_dir():
            self.settings["newNoteLocation"] = str(directory)
            self._preferences(); self._emit(False)

    @Slot(str)
    def importFont(self,value):
        try:
            family=self.session.font_store.import_file(local_path(value))
            self.settings["font"] = family
            self.message = "Imported " + family + " for reading and PDF export"
            self._preferences(); self._emit()
        except (OSError,ValueError) as error:
            self.message = str(error); self._emit(False)

    @Property(str,notify=changed)
    def brand(self):
        svg = self._brand_svg
        colors = self._colors()
        svg = svg.replace("#16181d",colors["text"]).replace("#f4f4f1",colors["surface"])
        return "data:image/svg+xml;base64,"+base64.b64encode(svg.encode()).decode()

    def _submit(self, action, done, busy=True, executor=None):
        if self.retired:return
        target=executor or self.pool
        if getattr(target,"_shutdown",False):return
        if busy:
            self.busy += 1
            self._emit(False)
        future = target.submit(action)
        def completed(f):
            if self.retired or f.cancelled():return
            try:
                value,error=f.result(),None
            except Exception as reason:
                value,error=None,str(reason)
            if self.retired or (done is _noop_done and not busy and error is None):return
            try:self.completed.emit((done,value,error,busy))
            except RuntimeError:pass  # The QObject may have been retired meanwhile.
        future.add_done_callback(completed)

    @Slot(object)
    def _complete(self, result):
        if self.retired:return
        done, value, error, busy = result
        if busy:
            self.busy -= 1
        if error:
            self.message = error
            self.pending_close = ""
        done(value, error)
        self._emit(False)

    def _submit_write(self, action, done, *, on_retired=None):
        token = uuid.uuid4().hex
        invoked = False

        def notify_retired():
            nonlocal invoked
            with self._write_callback_lock:
                if invoked:
                    return
                invoked = True
                self._pending_write_retirements.pop(token, None)
            if on_retired is not None:
                on_retired()

        if self.retired or getattr(self.writes, "_shutdown", False):
            notify_retired()
            return False

        if on_retired is not None:
            with self._write_callback_lock:
                self._pending_write_retirements[token] = notify_retired

        try:
            future = self.writes.submit(action)
        except RuntimeError:
            notify_retired()
            return False

        def completed(f):
            if f.cancelled():
                notify_retired()
                return
            try:
                value, error = f.result(), None
            except Exception as reason:
                value, error = None, str(reason)
            if self.retired:
                notify_retired()
                return
            try:
                self.backgroundWriteCompleted.emit((token, done, notify_retired, value, error))
            except RuntimeError:
                notify_retired()

        future.add_done_callback(completed)
        return True

    @Slot(object)
    def _complete_background_write(self, payload):
        token, done, notify_retired, value, error = payload
        if self.retired:
            notify_retired()
            return
        with self._write_callback_lock:
            self._pending_write_retirements.pop(token, None)
        done(value, error)

    def _preferences(self,notify=True):
        if self.retired or getattr(self.writes, "_shutdown", False): return
        persisted_settings = dict(self.settings)
        if getattr(getattr(self.session, "background", None), "_cli_started_agent_access", False):
            persisted_settings["agentAccessEnabled"] = False
        data = json.dumps({"settings": persisted_settings, "recent": self.recent, "pinned":self.session.pinned}).encode()
        self._submit(lambda: atomic_write(self.data / "settings.json", data), _noop_done, False, self.writes)
        if notify:self.session.changed.emit()

    def _save_positions(self):
        data=json.dumps(self.session.locations).encode()
        self._submit(lambda:atomic_write(self.data/"reading-positions.json",data),_noop_done,False,self.writes)

    def _recover(self):
        # Clean tabs need only paths, never another copy of their image bytes.
        with self.session._rename_state_lock:
            window_tabs = [{"path":t["path"],"id":t["id"]} for t in self.tabs if t["path"] or self._is_dirty(t)]
            self.session.workspace[self.window_id] = window_tabs
            self.session.window_workspaces[self.window_id] = {
                "folder": self.folder,
                "expanded": sorted(self.expanded) if self.folder else [],
                "active": self._current()["path"],
                "activeId": self.active,
            }
            self.session._last_recovered_window_id = self.window_id
            entries = [dict(entry) for tabs in self.session.workspace.values() for entry in tabs]
            windows_payload = []
            for wid, w_tabs in self.session.workspace.items():
                meta = self.session.window_workspaces.get(wid, {})
                w_folder = meta.get("folder", "")
                windows_payload.append({
                    "windowId": wid,
                    "tabs": [dict(t) for t in w_tabs],
                    "active": meta.get("active", ""),
                    "activeId": meta.get("activeId", ""),
                    "folder": w_folder,
                    "expanded": list(meta.get("expanded", [])) if w_folder else [],
                })
            primary_folder = windows_payload[0]["folder"] if windows_payload else self.folder
            primary_expanded = windows_payload[0]["expanded"] if windows_payload else (sorted(self.expanded) if self.folder else [])
            workspace = {
                "paths": list(dict.fromkeys(t["path"] for t in entries if t["path"])),
                "tabs": entries,
                "active": self._current()["path"],
                "activeId": self.active,
                "folder": primary_folder,
                "expanded": primary_expanded,
                "windows": windows_payload,
            }
            # Snapshot only unsaved tabs. Asset bytes stay in recovery, never in displayed source.
            self.session.drafts[self.window_id] = [_snapshot_tab_state(t, include_view_state=False) for t in self.tabs if self._is_dirty(t) and (t["path"] or t["content"].strip() or t["assets"])]
            drafts = [_snapshot_tab_state(tab, include_view_state=False) for tabs in self.session.drafts.values() for tab in tabs]
        self.session.writes.submit_latest("startup",lambda:atomic_json(self.data/"startup.json",workspace),lambda error:self._notify_recovery_write("startup",error))
        self.session.writes.submit_latest("recovery",lambda:atomic_json(self.data/"recovery.json",drafts),lambda error:self._notify_recovery_write("recovery",error))

    def _notify_recovery_write(self,category,error):
        try:self.completed.emit((self._recovery_write_completed,(category,error),None,False))
        except RuntimeError:pass

    def _recovery_write_completed(self,result,_error):
        category,error=result
        notice={
            "startup":"Couldn't save the current workspace state. Keep Super MD open and retry.",
            "recovery":"Couldn't save draft recovery data. Keep Super MD open and retry.",
        }[category]
        if error:self.message=notice
        elif self.message==notice:self.message=""
        self._emit(False)

    @Property(bool, notify=changed)
    def dropBlocked(self):
        return bool(self.retired or self.pending_close or self.flush_operation)

    @Slot(QObject)
    @Slot(QObject, QObject)
    def attachWindowDropFilter(self, window: QObject | None, reader: QObject | None = None):
        if window is None or self.retired:
            return
        existing = getattr(self, "_workspace_drop_filter", None)
        if existing is not None and existing.window is window:
            existing.set_reader(reader)
            return
        if existing is not None:
            try:
                existing.window.removeEventFilter(existing)
            except RuntimeError:
                pass
        self._workspace_drop_filter = WorkspaceDropFilter(self, window, reader)

    @Slot("QVariantList", bool, result=bool)
    def shouldInterceptExternalDrop(self, urls, over_reader: bool = False) -> bool:
        paths = _extract_local_drop_paths(urls)
        if not paths:
            return False
        if self.dropBlocked:
            return True
        folders, notes, images, unsupported = _classify_drop_paths(paths)
        if (
            over_reader
            and self.settings.get("welcomed")
            and self.ready
            and not self.reader_overlay
            and not self.image_overlay
            and images
            and not folders
            and not notes
            and not unsupported
        ):
            return False
        return True

    @Slot("QVariantList")
    def openDroppedUrls(self, urls):
        self.handleExternalDrop(urls, False)

    @Slot("QVariantList", bool)
    def handleExternalDrop(self, urls, over_reader: bool = False):
        del over_reader
        if self.dropBlocked:
            return
        paths = _extract_local_drop_paths(urls)
        if not paths:
            return
        folders, notes, images, unsupported = _classify_drop_paths(paths)
        if not folders and not notes:
            if images:
                self.message = "Drop images inside an open note to insert them."
            else:
                self.message = "Only Markdown notes (.md, .smd, .fmd, .markdown, .txt) and folders can be opened by dropping."
            self._emit(False)
            return

        notices: list[str] = []
        if len(folders) > 1:
            skipped_folders = len(folders) - 1
            notices.append(f"opened folder {folders[-1].name} ({skipped_folders} other folder{'s' if skipped_folders != 1 else ''} skipped)")
        skipped_files = len(images) + len(unsupported)
        if skipped_files:
            if images and not unsupported:
                notices.append("drop images inside an open note separately to insert them")
            else:
                notices.append(f"skipped {skipped_files} unsupported item{'s' if skipped_files != 1 else ''}")

        formatted_notice = ""
        if notices:
            joined = "; ".join(notices)
            formatted_notice = joined[0].upper() + joined[1:] + "."

        if folders:
            self.openFolder(str(folders[-1]))
            self.workspaceFolderDropped.emit()
            if not notes and self.host_window is not None:
                self.host_window.raise_()
                self.host_window.requestActivate()

        if notes:
            self._open_dropped_notes(notes, notice=formatted_notice)
        elif formatted_notice:
            self.message = formatted_notice
            self._emit(False)

    def _open_dropped_notes(self, note_paths: list[Path], *, notice: str = ""):
        if not note_paths or self.retired:
            return
        self._activation_generation += 1
        batch_generation = self._activation_generation
        highest_activated_index = -1
        batch_new_tab_indices: dict[str, int] = {}
        opened_paths_by_index: dict[int, str] = {}
        errors: list[str] = []
        remaining = len(note_paths)

        def make_batch_insert(index: int):
            def insert_note(note: dict):
                batch_new_tab_indices[note["id"]] = index
                insert_at = next(
                    (
                        pos
                        for pos, existing in enumerate(self.tabs)
                        if existing["id"] in batch_new_tab_indices and batch_new_tab_indices[existing["id"]] > index
                    ),
                    None,
                )
                if insert_at is None:
                    self.tabs.append(note)
                else:
                    self.tabs.insert(insert_at, note)
            return insert_note

        def make_should_activate(index: int):
            def check(_tab: dict) -> bool:
                nonlocal highest_activated_index
                if index >= highest_activated_index:
                    highest_activated_index = index
                    return True
                return False
            return check

        def make_done(index: int, path: Path):
            def done(tab: dict | None, error: str | None):
                nonlocal remaining
                if error:
                    errors.append(f"{path.name}: {error}")
                elif tab is not None:
                    opened_paths_by_index[index] = folder_ops.canonical_path_str(path)
                remaining -= 1
                if remaining == 0 and not self.retired:
                    if len(opened_paths_by_index) > 1:
                        ordered = [opened_paths_by_index[i] for i in sorted(opened_paths_by_index, reverse=True)]
                        self.recent = (
                            ordered
                            + [p for p in self.recent if not any(folder_ops.same_path(p, o) for o in ordered)]
                        )[:30]
                        self._preferences()
                    parts: list[str] = []
                    if errors:
                        parts.append("Could not open " + "; ".join(errors))
                    if notice:
                        parts.append(notice)
                    if parts:
                        self.message = " ".join(parts)
                    self._emit(False)
            return done

        for idx, note_path in enumerate(note_paths):
            self._open_note(
                str(note_path),
                explicit=True,
                activation_generation=batch_generation,
                completion_callback=make_done(idx, note_path),
                batch_insert=make_batch_insert(idx),
                should_activate_fn=make_should_activate(idx),
            )

    @Slot(str)
    def openPath(self, value):
        path = local_path(value)
        if path.is_dir():
            self.openFolder(str(path))
        else:
            self.openNote(str(path))

    @Slot()
    def chooseFolder(self):
        if not sys.platform.startswith("linux"):
            self.folderPickerRequested.emit()
            return
        if getattr(self, "_folder_check", None) is not None:
            return
        from PySide6.QtDBus import QDBusConnection, QDBusMessage, QDBusPendingCallWatcher, QDBusVariant
        message = QDBusMessage.createMethodCall("org.freedesktop.portal.Desktop", "/org/freedesktop/portal/desktop", "org.freedesktop.DBus.Properties", "Get")
        message.setArguments(["org.freedesktop.portal.FileChooser", "version"])
        self._folder_check = watcher = QDBusPendingCallWatcher(QDBusConnection.sessionBus().asyncCall(message, 3000), self)
        def finished(call):
            reply = call.reply()
            values = reply.arguments()
            version = values[0].variant() if values and isinstance(values[0], QDBusVariant) else (values[0] if values else 0)
            self._folder_check = None
            call.deleteLater()
            if reply.type() == QDBusMessage.MessageType.ReplyMessage and isinstance(version, int) and version >= 3:
                self.folderPickerRequested.emit()
            else:
                self.message = "The system folder picker is unavailable. Enable an XDG desktop portal file chooser, or open a folder with Super MD from your file manager."
                self._emit(False)
        watcher.finished.connect(finished)

    @Slot(str)
    def openNote(self, value):
        self._open_note(value, explicit=True)

    def _focus_open_target(self, generation):
        if generation != self._activation_generation or self.retired:
            return
        window = self.host_window
        if window is None:
            return
        window.raise_()
        window.requestActivate()
        QTimer.singleShot(0, lambda: QMetaObject.invokeMethod(window, "focusReader", Qt.ConnectionType.QueuedConnection)
                          if generation == self._activation_generation and not self.retired else None)

    def _open_note(
        self,
        value,
        *,
        explicit,
        background=False,
        activation_generation=None,
        completion_callback=None,
        batch_insert=None,
        should_activate_fn=None,
        pending_heading=None,
    ):
        if self.retired:
            if completion_callback: completion_callback(None, "The document window is no longer available")
            return
        path = local_path(value)
        if path.is_dir():
            self.openFolder(str(path))
            if completion_callback: completion_callback(None, "A folder cannot be opened as a document")
            return
        if explicit and not background and activation_generation is None:
            self._activation_generation += 1
            activation_generation = self._activation_generation
        elif activation_generation is None:
            activation_generation = self._activation_generation
        restoring = not explicit and not background and str(path) in self._restoring_paths
        def activate_existing(target_tab):
            if explicit and not background and activation_generation == self._activation_generation:
                if should_activate_fn is None or should_activate_fn(target_tab):
                    if pending_heading:
                        target_tab["pendingHeading"] = pending_heading
                    else:
                        target_tab.pop("pendingHeading", None)
                    if batch_insert is None:
                        canon_existing_path = folder_ops.canonical_path_str(path)
                        self.recent = [canon_existing_path] + [p for p in self.recent if not folder_ops.same_path(p, canon_existing_path)][:29]
                        self._preferences(notify=False)
                    was_active = self.active == target_tab["id"]
                    self._select_tab_from_open(target_tab["id"], activation_generation)
                    if was_active:
                        self._emit(bool(pending_heading))
                    for window in list(self.session.windows.values()):
                        if window is not self and not window.retired:
                            window._emit(False)
                    self._focus_open_target(activation_generation)
        def same_open_tab_path(tab_path: str) -> bool:
            if not tab_path:
                return False
            if tab_path == str(path) or folder_ops.same_path(tab_path, path):
                return True
            try:
                return not Path(tab_path).is_symlink() and os.path.samefile(tab_path, path)
            except OSError:
                return False
        found = next((t for t in self.tabs if same_open_tab_path(t["path"])), None)
        if found:
            self._agent_open_paths.add(folder_ops.canonical_path_str(path))
            self._restoring_paths.discard(str(path))
            if restoring and activation_generation == self._activation_generation and str(path) == (self._startup_active or self.session.startup_active):
                self._select_tab_from_open(found["id"], activation_generation)
            activate_existing(found)
            if completion_callback: completion_callback(found, None)
            return
        def finished(result, error):
            self._restoring_paths.discard(str(path))
            if error:
                if completion_callback: completion_callback(None, error)
                return
            content, assets, portable = result
            # A startup read and an explicit open may race for the same path.
            # Keep one tab and let only an explicit, still-current request focus it.
            existing = next((tab for tab in self.tabs if same_open_tab_path(tab["path"])), None)
            if existing:
                activate_existing(existing)
                if completion_callback: completion_callback(existing, None)
                return
            note = self._note(path.name, content, str(path), content, assets, portable)
            self._agent_open_paths.add(folder_ops.canonical_path_str(path))
            if restoring:
                if activation_generation == self._activation_generation:
                    self.tabs=[t for t in self.tabs if t["id"] not in self._startup_placeholder_ids]
                    self._startup_placeholder_ids.clear()
            if batch_insert is not None:
                batch_insert(note)
            else:
                self.tabs.append(note)
            if restoring:
                keys=[entry["path"] or entry["id"] for entry in self._startup_entries] or self._startup_order
                self.tabs.sort(key=lambda t:keys.index(t["path"] or t["id"]) if (t["path"] or t["id"]) in keys else -1)
            if should_activate_fn is not None:
                should_activate = bool(
                    not background
                    and explicit
                    and activation_generation == self._activation_generation
                    and should_activate_fn(note)
                )
            else:
                should_activate = (not background and explicit and activation_generation == self._activation_generation)
            if restoring and not background and activation_generation == self._activation_generation:
                target_active = self._startup_active or self.session.startup_active
                should_activate = str(path) == target_active or not any(t["id"] == self.active for t in self.tabs)
            if should_activate:
                self.active = note["id"]
                if pending_heading:
                    note["pendingHeading"] = pending_heading
            self.settings["welcomed"] = True
            canon_note_path = folder_ops.canonical_path_str(path)
            self.recent = [canon_note_path] + [p for p in self.recent if not folder_ops.same_path(p, canon_note_path)][:29]
            self._preferences(notify=False)
            self.recovery_timer.start(800)
            emit_load = False if background else (should_activate if (should_activate_fn is not None or explicit) else True)
            for window in list(self.session.windows.values()):
                if window is self:
                    window._emit(emit_load)
                else:
                    window._emit(False if background else True)
            if explicit and should_activate:
                self._focus_open_target(activation_generation)
            if completion_callback: completion_callback(note, None)
        self._submit(lambda: open_note(path), finished)

    @Slot()
    def newNote(self):
        self._activation_generation += 1
        note = self._note("Untitled.md")
        self.tabs.append(note)
        self.active = note["id"]
        self.recovery_timer.start(800)
        self._emit()

    @Slot(str)
    def selectTab(self, id):
        if any(t["id"] == id for t in self.tabs):
            self._activation_generation += 1
            for tab in self.tabs:
                tab.pop("pendingHeading", None)
        self._select_tab_from_open(id, self._activation_generation)

    def _select_tab_from_open(self, id, generation):
        if generation != self._activation_generation:
            return
        if id!=self.active and any(t["id"] == id for t in self.tabs):
            self.active = id
            self.recovery_timer.start(800)
            self._emit()

    @Slot(int)
    def cycleTab(self, direction):
        if not self.tabs: return
        index=next((i for i,t in enumerate(self.tabs) if t["id"]==self.active),0)
        self.selectTab(self.tabs[(index+direction)%len(self.tabs)]["id"])

    @Slot(int)
    def moveActiveTab(self, direction):
        if direction not in (-1, 1) or len(self.tabs) < 2: return
        index=next((i for i,t in enumerate(self.tabs) if t["id"]==self.active),-1)
        target=max(0,min(len(self.tabs)-1,index+direction))
        if index < 0 or target == index: return
        self.tabs.insert(target,self.tabs.pop(index))
        self._recover()
        self._emit(False)

    @Slot(int)
    def tabNumber(self, number):
        index=len(self.tabs)-1 if number==9 else number-1
        if 0<=index<len(self.tabs):self.selectTab(self.tabs[index]["id"])

    @Slot()
    def reopenTab(self):
        if not self.closed_tabs:return
        self._activation_generation += 1
        activation_generation=self._activation_generation
        reference=self.closed_tabs[0]
        def finished(note,error):
            if error:
                self.message="Could not reopen the closed note: "+error
                self._emit(False);return
            if reference not in self.closed_tabs:return
            note.setdefault("saved_assets", dict(note.get("assets", {})))
            note.setdefault("assets_dirty", False)
            note.setdefault("conflict", False)
            next_refs=[item for item in self.closed_tabs if item is not reference]
            try:self.session.closed_note_store.save_index(next_refs)
            except Exception as failure:
                self.message="Could not update closed-note recovery: "+str(failure)
                self._emit(False);return
            existing=next((t for t in self.tabs if note.get("path") and t["path"]==note["path"]),None)
            if existing:
                if activation_generation==self._activation_generation:self.active=existing["id"]
            else:
                self.tabs.append(note)
                if note.get("path"):
                    try:self._agent_open_paths.add(str(Path(note["path"]).resolve()))
                    except OSError:pass
                if activation_generation==self._activation_generation:self.active=note["id"]
            self.closed_tabs[:]=next_refs
            self._recover();self._emit()
        def read_note():
            if reference.get("_closedSnapshot"):
                return self.session.closed_note_store.load(reference)
            return _snapshot_tab_state(reference)  # compatibility with old in-memory entries
        self._submit(read_note,finished,False,self.writes)

    def _restore_workspace_folder(self, folder_path: str, expanded_paths: list[str] | None = None):
        if not folder_path:
            return
        try:
            candidate_root = Path(folder_ops.strip_extended_length_prefix(str(folder_path))).expanduser()
            if folder_ops._is_link_or_junction(candidate_root):
                return
            root = Path(folder_ops.strip_extended_length_prefix(str(candidate_root.resolve(strict=True))))
        except OSError:
            return
        if not root.is_dir():
            return
        root_str = folder_ops.canonical_path_str(root)
        self._pinned_visible_dirs.clear()
        valid_expanded = {root_str}
        for raw in expanded_paths or []:
            if not raw:
                continue
            try:
                candidate = Path(folder_ops.strip_extended_length_prefix(str(raw))).expanduser()
                if folder_ops._is_link_or_junction(candidate):
                    continue
                resolved = Path(folder_ops.strip_extended_length_prefix(str(candidate.resolve(strict=True))))
                if folder_ops.matches_path_prefix(str(resolved), root_str, is_directory=True) and resolved.is_dir():
                    valid_expanded.add(folder_ops.canonical_path_str(resolved))
            except OSError:
                continue
        self.folder = root_str
        self.session.workspace_links.invalidate(self.folder)
        self.expanded = valid_expanded
        self.session.window_workspaces[self.window_id] = {
            "folder": self.folder,
            "expanded": sorted(self.expanded),
            "active": self._current()["path"],
            "activeId": self.active,
        }
        self._watch_notes()
        self._load_tree()

    def _cancel_subfolder_search(self):
        self.filter_timer.stop()
        self._search_generation += 1
        if self._search_cancel is not None:
            self._search_cancel.set()
            self._search_cancel = None
        self._folder_searching = False

    def _clear_folder_filter(self):
        self._cancel_subfolder_search()
        self.folder_filter = ""

    @Slot(str)
    def setFolderFilter(self, query):
        if self.retired:
            return
        raw = str(query or "")
        trimmed = raw.strip()
        if raw == self.folder_filter and (not trimmed or self._folder_searching or self.filter_timer.isActive()):
            return
        self._cancel_subfolder_search()
        self.folder_filter = raw
        if not self.folder:
            self.files = []
            self._emit(False)
            return
        if not trimmed:
            self._load_tree()
            self._emit(False)
            return
        self._folder_searching = True
        self._emit(False)
        self.filter_timer.start(150)

    def _start_subfolder_search(self):
        if self.retired:
            return
        self.filter_timer.stop()
        if self._search_cancel is not None:
            self._search_cancel.set()
            self._search_cancel = None
        folder = self.folder
        needle = self.folder_filter.strip().casefold()
        if not folder or not needle:
            self._folder_searching = False
            if folder:
                self._load_tree()
            else:
                self.files = []
            self._emit(False)
            return
        self._search_generation += 1
        generation = self._search_generation
        cancel = threading.Event()
        self._search_cancel = cancel
        self._folder_searching = True

        max_scanned = 25000
        max_matched = 3000
        max_depth = MAX_FOLDER_DEPTH

        def search():
            scanned = 0
            matched_total = 0

            def walk_dir(dir_path: str, depth: int) -> list[dict] | None:
                nonlocal scanned, matched_total
                if cancel.is_set():
                    return None
                if depth > max_depth or scanned >= max_scanned or matched_total >= max_matched:
                    return []
                raw_entries = []
                try:
                    with os.scandir(dir_path) as it:
                        for entry in it:
                            if cancel.is_set():
                                return None
                            scanned += 1
                            if scanned > max_scanned:
                                break
                            name = entry.name
                            if name.startswith("."):
                                continue
                            try:
                                if entry.is_symlink() or folder_ops._is_link_or_junction(Path(entry.path)):
                                    continue
                                is_dir = entry.is_dir(follow_symlinks=False)
                                is_file = False if is_dir else entry.is_file(follow_symlinks=False)
                            except OSError:
                                continue
                            if is_dir or (is_file and is_searchable_note_name(name)):
                                raw_entries.append((is_dir, name, folder_ops.canonical_path_str(entry.path)))
                except OSError:
                    return []
                if cancel.is_set():
                    return None
                raw_entries.sort(key=lambda item: (not item[0], item[1].lower()))
                collected: list[dict] = []
                for is_dir, name, full_path in raw_entries:
                    if cancel.is_set():
                        return None
                    if matched_total >= max_matched:
                        break
                    if is_dir:
                        sub_matches = walk_dir(full_path, depth + 1)
                        if sub_matches is None:
                            return None
                        if sub_matches:
                            collected.append({
                                "name": name,
                                "path": full_path,
                                "directory": True,
                                "depth": depth,
                                "expanded": True,
                            })
                            matched_total += 1
                            remaining = max_matched - matched_total
                            if remaining > 0:
                                kept_sub = sub_matches[:remaining]
                                collected.extend(kept_sub)
                                matched_total += len(kept_sub)
                    else:
                        if needle in name.casefold():
                            collected.append({
                                "name": name,
                                "path": full_path,
                                "directory": False,
                                "depth": depth,
                                "expanded": False,
                            })
                            matched_total += 1
                return collected

            return walk_dir(folder, 0)

        def finished(result, error):
            if self.retired or cancel.is_set() or generation != self._search_generation or not folder_ops.same_path(folder, self.folder):
                return
            self._folder_searching = False
            if not error and result is not None:
                self.files = result

        self._submit(search, finished, False, executor=self._search_pool)

    @Slot(str)
    def openFolder(self, value):
        path = local_path(value)
        if not path.is_dir():
            self.message = "Choose an existing local folder."
            self._emit(False)
            return
        self._clear_folder_filter()
        self.folder = folder_ops.canonical_path_str(path)
        self.session.workspace_links.invalidate(self.folder)
        self.settings["welcomed"] = True
        self._pinned_visible_dirs.clear()
        self.expanded = {self.folder}
        self._preferences()
        self._recover()
        self._emit(False)
        self._load_tree()

    def _is_within_open_folder(self, candidate) -> bool:
        folder = getattr(self, "folder", "")
        if not folder or not candidate:
            return False
        try:
            return folder_ops.matches_path_prefix(str(candidate), folder, is_directory=True)
        except (OSError, ValueError):
            return False

    def _refresh_open_folder_trees(self, *candidates) -> None:
        if not candidates:
            return
        session = getattr(self, "session", None)
        windows = tuple(session.windows.values()) if session is not None and hasattr(session, "windows") else (self,)
        for window in windows:
            if getattr(window, "retired", False) or not hasattr(window, "_load_tree"):
                continue
            if any(Studio._is_within_open_folder(window, candidate) for candidate in candidates if candidate):
                window._load_tree()

    def _load_tree(self):
        self._tree_generation = getattr(self, "_tree_generation", 0) + 1
        generation = self._tree_generation
        if not self.folder:
            self.files = []
            return
        if self.folder_filter.strip():
            self._start_subfolder_search()
            return
        folder, expanded = self.folder, set(self.expanded)
        hide_non_note = bool(self.settings.get("hideNonNoteFolders", True))
        expanded_keys = {folder_ops.normalize_path_key(item) for item in expanded if item}
        pinned_visible_keys = {folder_ops.normalize_path_key(item) for item in getattr(self, "_pinned_visible_dirs", ()) if item}
        custom_budget = getattr(self, "_folder_tree_scan_budget", None)
        initial_budget = FOLDER_TREE_SCAN_BUDGET if custom_budget is None else max(0, int(custom_budget))
        def scan():
            entries: list[dict[str, object]] = []
            note_memo: dict[str, bool] = {}
            scan_budget = [initial_budget]
            def visit(path, depth):
                if depth > 256:
                    return
                try:
                    children = sorted(Path(path).iterdir(), key=lambda p: (not p.is_dir(), p.name.lower()))
                except OSError:
                    return
                for child in children:
                    if len(entries) >= 3000:
                        return
                    if child.name.startswith(".") or folder_ops._is_link_or_junction(child):
                        continue
                    directory = child.is_dir()
                    if directory:
                        child_str = folder_ops.canonical_path_str(child)
                        child_key = folder_ops.normalize_path_key(child_str)
                        if (
                            hide_non_note
                            and child_key not in pinned_visible_keys
                            and not _directory_has_visible_note(
                                child,
                                depth=depth + 1,
                                max_depth=MAX_FOLDER_DEPTH,
                                budget=scan_budget,
                                memo=note_memo,
                            )
                        ):
                            continue
                        is_expanded = child_key in expanded_keys
                        entries.append({"name": child.name, "path": child_str, "directory": True, "depth": depth, "expanded": is_expanded})
                        if is_expanded:
                            visit(child, depth + 1)
                    elif is_searchable_note_name(child.name):
                        child_str = folder_ops.canonical_path_str(child)
                        entries.append({"name": child.name, "path": child_str, "directory": False, "depth": depth, "expanded": False})
            visit(folder, 0)
            return entries
        def finished(result, error):
            if not error and result is not None and generation == getattr(self, "_tree_generation", 0) and folder_ops.same_path(folder, self.folder) and not self.folder_filter.strip():
                self.files = result
                self._watch_notes()
        self._submit(scan, finished, False)

    @Slot(str)
    def toggleDirectory(self, path):
        if not self.folder:
            return
        canon = folder_ops.canonical_path_str(local_path(path))
        if not canon:
            return
        existing = [item for item in self.expanded if folder_ops.same_path(item, canon)]
        if existing:
            for item in existing:
                self.expanded.discard(item)
            for item in [p for p in self._pinned_visible_dirs if folder_ops.same_path(p, canon)]:
                self._pinned_visible_dirs.discard(item)
        else:
            self.expanded.add(canon)
        self._recover()
        self._emit(False)
        self._load_tree()

    @Slot()
    def closeFolder(self):
        self._tree_generation = getattr(self, "_tree_generation", 0) + 1
        self._clear_folder_filter()
        if self.folder:
            self.session.workspace_links.invalidate(self.folder)
        self.folder = ""
        self.files = []
        self._pinned_visible_dirs.clear()
        self.expanded.clear()
        self._watch_notes()
        self._recover()
        self._emit(False)

    @Slot(str)
    def setMode(self, mode):
        if mode in ("live", "reader", "editor", "split"):
            if mode!=self.mode:self._flush("mode",mode)

    def _apply_mode(self,mode):
        self.mode=mode
        self.settings["readingMode"]=mode
        self.preference_timer.start(500)
        self._emit()

    @Slot(bool)
    def setFullscreen(self, value):
        if value == self.fullscreen:
            return
        if value:
            self.settings["fullZoom"] = self.settings["normalZoom"]
        self.fullscreen = value
        self._emit()

    @Slot(float)
    def setZoom(self, value):
        zoom = max(40, min(300, round(value)))
        self.settings["fullZoom" if self.fullscreen else "normalZoom"] = zoom
        self.readerCall.emit(f"window.supermdSetZoom?.({zoom},{int(time.time()*1000)})")
        self.preference_timer.start(500)
        self._emit(False)

    @Slot(str, int)
    def navigateHeading(self, heading, offset):
        self.readerCall.emit(f"window.supermdHeading?.({json.dumps(heading)}, {offset})")

    @Slot(str, str)
    def setting(self, key, encoded):
        if key not in DEFAULTS:
            return
        try:
            value = json.loads(encoded)
        except ValueError:
            return
        if key in ("theme","fullTheme") and value not in ("system","light","dark","black"): return
        if key=="accent" and value not in ("system","blue","green","violet","rose","amber"):return
        if key=="startup" and value not in ("restore","new"):return
        if key=="selectionAssistant" and (not isinstance(value,str) or value not in ASSISTANTS):return
        if key=="patternKind" and value not in ("","none","paws","dots","grid","diagonal","gradient"):return
        if key in ("patternOpacity","patternSize","patternSpacing"):
            if not isinstance(value,(int,float)) or isinstance(value,bool) or not math.isfinite(value):return
            default,low,high={"patternOpacity":(-1,0,.25),"patternSize":(0,8,64),"patternSpacing":(0,12,192)}[key]
            if value!=default and not low<=value<=high:return
        if key in ("imageAppearance","svgAppearance") and value not in ("original","invert-dark","auto","monochrome","contrast"):return
        if key in ("restorePosition","centerLock") and not isinstance(value,bool):return
        if key=="imageContrast" and (not isinstance(value,(int,float)) or isinstance(value,bool) or not math.isfinite(value) or not 1<=value<=2):return
        if key in ("motion","welcomed","autosave","checkUpdates","autoUpdate","spellCheck","grammarCheck","latexAutofix","typewriterScroll","desktopIntegration","fullDocumentAccessibility","keepInBackground","hideNonNoteFolders") and not isinstance(value,bool): return
        if key in ("font","python") and (not isinstance(value,str) or not value.strip() or len(value)>2048): return
        if key == "python":
            try: value = python_runtime.validate(value.strip())
            except ValueError as error:
                self.python_status = str(error); self._emit(False); return
            self.python_status = ""
        if key in ("size","width","widthPercent","lineHeight","normalZoom","fullZoom") and (not isinstance(value,(int,float)) or isinstance(value,bool) or not math.isfinite(value)): return
        if key == "pdf" and (not isinstance(value,dict) or set(value) != set(DEFAULT_PDF)): return
        if key == "shortcuts":
            value, error = normalize_shortcuts(value)
            if error: return
        if key in ("window","widthMigrated"): return  # Internal state, not user settings.
        if key == "size": value = max(6, min(32, float(value)))
        if key == "width": value = max(0, min(5000, int(value)))
        if key == "widthPercent": value = max(50,min(150,float(value)))
        if key == "lineHeight": value = max(1.15,min(2.2,float(value)))
        self.settings[key] = value
        if key == "shortcuts": self._notify_shortcuts()
        if key == "hideNonNoteFolders":
            for win in list(self.session.windows.values()):
                if not win.retired and win.folder:
                    if value:
                        win._pinned_visible_dirs.clear()
                    win._load_tree()
        self._preferences()
        self._emit()

    @Slot()
    def save(self):
        if not self.tabs:
            return
        self._save_current(False)

    def _save_current(self, force_overwrite: bool = False):
        if not self.tabs:
            return
        tab = self._current()
        if not tab["path"]:
            self.saveRequested.emit(tab["name"])
        elif not force_overwrite and tab.get("conflict"):
            self.saveConflictRequested.emit(tab["name"])
        elif tab["portable"] and self.ready:
            if force_overwrite:
                self._force_overwrite_ids.add(tab["id"])
            else:
                self._force_overwrite_ids.discard(tab["id"])
            self.readerCall.emit("window.supermdPortable?.(true)")
        else:
            self._save_text(tab, Path(tab["path"]), automatic=False, force_overwrite=force_overwrite, force_portable=bool(tab["portable"]))

    def _after_flush(self,operation):
        if operation["action"] == "save": self.save()
        elif operation["action"] == "save_as":
            if self.tabs:
                self.saveAsRequested.emit(self._current()["name"])
        elif operation["action"] == "overwrite_conflict": self._save_current(True)
        elif operation["action"] == "reload_conflict": self._reload_current_from_disk()
        elif operation["action"] == "sync_for_search":
            if self._folder_search_open and self._folder_search_query.strip():
                current_sig = [(t["id"], t["content"], self._is_dirty(t)) for t in self.tabs]
                if current_sig != self._folder_search_tabs_sig:
                    self._start_folder_search()
                else:
                    self.workspaceSearchChanged.emit()
        elif operation["action"] == "open_search_match":
            request = json.loads(operation["target"])
            tab_id = request.get("tabId") or ""
            path = request.get("path") or ""
            query = request.get("query") or ""
            case_sensitive = bool(request.get("caseSensitive", False))
            bounds = self._seeded_find_bounds(request)
            existing = next((t for t in self.tabs if tab_id and t["id"] == tab_id), None)
            if existing is None and path:
                resolved = os.path.normcase(str(Path(path).resolve(strict=False)))
                existing = next((t for t in self.tabs if t.get("path") and os.path.normcase(str(Path(t["path"]).resolve(strict=False))) == resolved), None)
            if existing is not None:
                if existing["id"] == self.active and self.ready:
                    self._pending_seeded_find = None
                    if query:
                        find_opts = {"caseSensitive": case_sensitive, **bounds}
                        self.readerCall.emit(f"window.supermdFind?.({json.dumps(query)}, {json.dumps(find_opts)})")
                    self._focus_open_target(self._activation_generation)
                else:
                    self._pending_seeded_find = {"tabId": existing["id"], "path": existing.get("path") or "", "query": query, "caseSensitive": case_sensitive, **bounds} if query else None
                    self.selectTab(existing["id"])
                    if existing["id"] == self.active and not self.ready:
                        pass
                    self._focus_open_target(self._activation_generation)
            elif path:
                local = str(local_path(path))
                self._pending_seeded_find = {"tabId": "", "path": local, "query": query, "caseSensitive": case_sensitive, **bounds} if query else None
                def opened(_note, error):
                    if error and self._pending_seeded_find and self._pending_seeded_find.get("path") == local:
                        self._pending_seeded_find = None
                self._open_note(local, explicit=True, completion_callback=opened)
        elif operation["action"] == "reload_reader":
            # The renderer has acknowledged all edits. Reopen it from native
            # state and the just-captured view snapshot in document_flushed.
            self.ready=False
            self._last_reader_text=None
            self.reader_overlay=False
            self.image_overlay=False
            self._emit(False)
            self.readerReloadRequested.emit()
        elif operation["action"] == "mode": self._apply_mode(operation["target"])
        elif operation["action"] == "move_tab":
            request = json.loads(operation["target"])
            target = self.session.windows.get(request["window"])
            if target: self._move_tab(target, request["tab"], request["index"])
        elif operation["action"] == "detach_tab":
            if self._can_move(): self.detachedWindowRequested.emit(self.window_id, operation["target"])
        elif operation["action"] == "close_tab": self.closeTab(operation["target"])
        elif operation["action"] == "close_window" and self.requestWindowClose():
            self._recover()
            QTimer.singleShot(0,self.allowClose.emit)

    def _on_flush_timeout(self):
        if self.flush_operation and self.flush_operation.get("action") == "sync_for_search":
            self.flush_operation = None
            self.workspaceSearchChanged.emit()
            return
        bg = getattr(self.session, "background", None)
        if (
            self.flush_operation
            and self.flush_operation["action"] == "close_window"
            and bg is not None
            and getattr(bg, "_stopping_from_cli", False)
            and getattr(self, "host_window", None) is not None
            and not self.host_window.isVisible()
        ):
            self.resolveFlush("recover_close")
            return
        self.flushFailed.emit(bool(self.flush_operation and self.flush_operation["action"] == "close_window"))

    def _flush(self,action,target=""):
        if self.retired or action=="close_window" and self.pending_close:return
        operation = {"action":action,"target":target,"token":uuid.uuid4().hex}
        if not self.ready or not self.tabs:
            self._after_flush(operation)
            return
        bg = getattr(self.session, "background", None)
        hidden_cli_close = (
            action == "close_window"
            and bg is not None
            and getattr(bg, "_stopping_from_cli", False)
            and getattr(self, "host_window", None) is not None
            and not self.host_window.isVisible()
        )
        if self.flush_operation and not hidden_cli_close and (self.flush_operation.get("action") != "sync_for_search" or action == "sync_for_search"): return
        self.flush_operation = operation
        self.flush_timer.start(250 if hidden_cli_close else 5000)
        self.readerCall.emit(f"window.supermdFlush?.({json.dumps(operation)})")

    @Slot()
    def saveSafely(self): self._flush("save")

    @Slot()
    def ensureReaderProfile(self):
        if getattr(self, "_defer_reader_activation", False):
            self._defer_reader_activation = False
        callback = getattr(self.session, "ensure_reader_profile", None)
        if callable(callback):
            callback()

    @Slot()
    def saveAsSafely(self): self._flush("save_as")

    @Slot()
    def reloadReaderSafely(self):
        if not self.ready or self.retired or self.busy or self.flush_operation: return
        self._flush("reload_reader")

    @Slot(str)
    def closeTabSafely(self,id): self._flush("close_tab",id)

    @Slot()
    def closeWindowSafely(self): self._flush("close_window")

    @Slot(str)
    def resolveFlush(self,choice):
        operation,self.flush_operation = self.flush_operation,None
        self.flush_timer.stop()
        if not operation: return
        if choice == "cancel" and operation["action"] == "close_window":
            service = getattr(self.session, "background", None)
            if service is not None: service.cancel_quit()
        elif choice == "retry": self._flush(operation["action"],operation["target"])
        elif choice == "recover_close" and operation["action"] == "close_window":
            # Explicit emergency action: preserve the latest received drafts, not
            # a silent discard or a claim we can recover an unresponsive renderer.
            self._recover()
            self.allowClose.emit()

    @Slot(str)
    def saveAs(self, value):
        path = local_path(value)
        tab = self._current()
        if path.suffix.lower() == ".smd" and self.ready:
            self.pending_export = str(path)
            self.pending_save_as = str(path)
            self.pending_save_as_tab = tab["id"]
            self.readerCall.emit("window.supermdPortable?.(false)")
        else:
            self._save_text(tab, path, automatic=False, force_overwrite=True, force_portable=path.suffix.lower() == ".smd")

    @Slot(str)
    def resolveConflict(self, choice):
        if choice == "cancel":
            was_window = self.pending_close == "window"
            self.pending_close = ""
            if was_window:
                service = getattr(self.session, "background", None)
                if service is not None: service.cancel_quit()
            return
        if choice == "save_as":
            self.saveAsSafely()
            return
        if choice == "overwrite":
            self._flush("overwrite_conflict")
            return
        if choice == "reload":
            self._flush("reload_conflict")
            return

    def _reload_current_from_disk(self):
        tab = self._current()
        if not tab.get("path"):
            return
        tab_id = tab["id"]
        path = Path(tab["path"])
        was_dirty = self._is_dirty(tab)
        captured = _snapshot_tab_state(tab)
        archived_draft = None
        if was_dirty:
            archived_assets = dict(captured.get("assets", {}))
            raw_name = str(captured.get("name") or "Untitled.md")
            archived_draft = dict(captured)
            archived_draft.update(
                id=uuid.uuid4().hex,
                name=raw_name if raw_name.startswith("Recovered ") else f"Recovered {raw_name}",
                path="",
                saved="",
                assets=archived_assets,
                saved_assets={},
                assets_dirty=bool(archived_assets),
                portable=bool(captured.get("portable")),
                conflict=False,
            )

        def work():
            loaded = open_note(path)
            reference = None
            if archived_draft is not None:
                try:
                    reference = self.session.closed_note_store.save(archived_draft)
                except Exception as failure:
                    raise RuntimeError(f"ARCHIVE_FAILED:{failure}") from failure
            return loaded, reference

        def done(outcome, error):
            if error:
                if str(error).startswith("ARCHIVE_FAILED:"):
                    detail = str(error)[len("ARCHIVE_FAILED:"):]
                    self.message = f"Could not archive draft before reloading: {detail}"
                else:
                    self.message = f"Could not reload note from disk: {error}"
                self._recover()
                self._emit(False)
                return
            target = next((t for t in self.tabs if t["id"] == tab_id), None)
            if not target:
                return
            if (
                target.get("content") != captured.get("content")
                or target.get("saved") != captured.get("saved")
                or target.get("assets") != captured.get("assets")
                or target.get("assets_dirty") != captured.get("assets_dirty")
                or target.get("path") != captured.get("path")
            ):
                self.message = "The note changed while reloading from disk. It remains open with the latest draft."
                self._recover()
                self._emit(False)
                return
            loaded, reference = outcome
            if reference is not None:
                next_refs = ([reference] + self.closed_tabs)[:ClosedNoteStore.LIMIT]
                try:
                    self.session.closed_note_store.save_index(next_refs)
                except Exception as failure:
                    self.message = f"Could not update closed-note recovery before reloading: {failure}"
                    self._recover()
                    self._emit(False)
                    return
                self.closed_tabs[:] = next_refs
            content, assets, portable = loaded
            try:
                st = path.stat()
                self.note_file_stamps[str(path)] = (st.st_mtime_ns, st.st_size)
            except OSError:
                pass
            self.reader_edits.clear(tab_id)
            self.session.reader_assets.revoke_tab(self.window_id, tab_id)
            if tab_id == self.active:
                self._last_reader_text = None
            target.update(
                content=content,
                saved=content,
                assets=assets,
                saved_assets=dict(assets),
                assets_dirty=False,
                portable=portable,
                conflict=False,
            )
            self.message = "Reloaded note from disk"
            self._recover()
            self._emit(load=tab_id == self.active)

        self._submit(work, done, True, self.writes)

    def _save_text(self, tab, path, automatic=False, force_overwrite=False, force_portable=False):
        id, content, assets = tab["id"], tab["content"], dict(tab["assets"])
        expected, original_path = tab["saved"], tab["path"]
        expected_assets = dict(tab.get("saved_assets", {}))
        try:
            same_path = bool(original_path) and Path(path).resolve() == Path(original_path).resolve()
        except OSError:
            same_path = str(path) == original_path
        portable = bool(force_portable or path.suffix.lower() == ".smd" or (tab["portable"] and same_path))
        if id in self.saving: return
        self.saving.add(id)
        def finished(outcome, error):
            self.saving.discard(id)
            if error: return
            target = next((t for t in self.tabs if t["id"] == id), None)
            if isinstance(outcome, dict) and outcome.get("_conflict"):
                if target:
                    target["conflict"] = True
                if automatic:
                    self.message = outcome["message"]
                    self._emit(False)
                else:
                    self.message = "This file changed on disk since you opened or last saved it."
                    self._emit(False)
                    if target:
                        self.saveConflictRequested.emit(target["name"])
                return
            if isinstance(outcome, dict) and outcome.get("stamp"):
                self.note_file_stamps[str(path)] = outcome["stamp"]
            if target:
                target.update(
                    path=str(path),
                    name=path.name,
                    saved=content,
                    saved_assets=dict(assets),
                    assets_dirty=False,
                    portable=portable,
                    conflict=False,
                )
                try:
                    self._agent_open_paths.add(str(Path(path).resolve()))
                except OSError:
                    pass
                if str(path) != original_path:
                    self.session.workspace_links.invalidate(path.parent)
                    self.recent = [str(path)] + [p for p in self.recent if p != str(path)][:29]
                    self._preferences()
                if automatic and self._is_dirty(target): self.autosave_timer.start(900)
            self.message = "Autosaved" if automatic else "Saved"
            self._recover()
            self._emit()
            if str(path) != original_path:
                self._refresh_open_folder_trees(path, original_path)
            if self.pending_close:
                self._finish_close()
        def write():
            if automatic or (not force_overwrite and same_path):
                changed_on_disk = False
                if not path.exists():
                    changed_on_disk = bool(automatic)
                else:
                    try:
                        disk_content, disk_assets, _ = open_note(path, decode_assets=False)
                        changed_on_disk = disk_content != expected or (portable and disk_assets != expected_assets)
                    except Exception:
                        changed_on_disk = True
                if changed_on_disk:
                    return {
                        "_conflict": True,
                        "message": "Autosave paused: this file changed outside Super MD. Your edits remain in draft recovery; use Save as to keep both versions.",
                    }
            if portable: write_portable(path,content,assets,validated_assets=expected_assets)
            else:
                materialize_assets(path.parent,assets)
                atomic_write(path,content.encode())
            try:
                st = path.stat()
                return {"stamp": (st.st_mtime_ns, st.st_size)}
            except OSError:
                return {}
        self._submit(write, finished,busy=not automatic,executor=self.writes)

    def _autosave(self):
        if not self.settings["autosave"]: return
        for tab in self.tabs:
            if tab["path"] and self._is_dirty(tab) and not tab.get("conflict") and tab["id"] not in self.saving:
                self._save_text(tab,Path(tab["path"]),automatic=True)

    def _sync_path_change(self, old_path: str, new_path: str, *, is_dir: bool, message: str = "", on_rebound=None):
        parent_str = folder_ops.canonical_path_str(Path(old_path).parent)
        target_windows = [win for win in list(self.session.windows.values()) if not win.retired]
        for win in target_windows:
            for stamp_key in list(win.note_file_stamps.keys()):
                if folder_ops.matches_path_prefix(stamp_key, old_path, is_directory=is_dir):
                    win.note_file_stamps.pop(stamp_key, None)
            for tab in win.tabs:
                if tab["path"] and folder_ops.matches_path_prefix(tab["path"], old_path, is_directory=is_dir):
                    updated = folder_ops.remap_path_prefix(tab["path"], old_path, new_path, is_directory=is_dir)
                    tab.update(path=updated, name=Path(updated).name)
                    try:
                        st = Path(updated).stat()
                        win.note_file_stamps[updated] = (st.st_mtime_ns, st.st_size)
                    except OSError:
                        pass
            for path_set in (win._agent_open_paths, win._agent_owned_files):
                remapped = {folder_ops.remap_path_prefix(p, old_path, new_path, is_directory=is_dir) for p in path_set}
                path_set.clear()
                path_set.update(remapped)
            if win.external_paths:
                win.external_paths = {
                    ext_path
                    for ext_path in win.external_paths
                    if not folder_ops.matches_path_prefix(ext_path, old_path, is_directory=is_dir)
                    and not folder_ops.matches_path_prefix(ext_path, new_path, is_directory=is_dir)
                    and not (parent_str and folder_ops.same_path(ext_path, parent_str))
                }
                if not win.external_paths:
                    win.external_timer.stop()
        if self not in target_windows:
            for path_set in (self._agent_open_paths, self._agent_owned_files):
                remapped = {folder_ops.remap_path_prefix(p, old_path, new_path, is_directory=is_dir) for p in path_set}
                path_set.clear()
                path_set.update(remapped)
        with self.session._rename_state_lock:
            self.session._remap_session_paths(old_path, new_path, is_dir=is_dir)
            self.session._retired_persist_needed = False
        if message and not self.retired:
            self.message = message
        self.session.workspace_links.invalidate()
        self._save_positions()
        self._preferences(notify=False)
        for win in target_windows:
            if win.folder and folder_ops.matches_path_prefix(win.folder, old_path, is_directory=is_dir):
                win.folder = folder_ops.remap_path_prefix(win.folder, old_path, new_path, is_directory=is_dir)
            win.expanded = {
                folder_ops.remap_path_prefix(p, old_path, new_path, is_directory=is_dir)
                for p in win.expanded
            }
            win._pinned_visible_dirs = {
                folder_ops.remap_path_prefix(p, old_path, new_path, is_directory=is_dir)
                for p in getattr(win, "_pinned_visible_dirs", ())
            }
            if win._pending_seeded_find and win._pending_seeded_find.get("path"):
                seeded_path = win._pending_seeded_find["path"]
                if folder_ops.matches_path_prefix(seeded_path, old_path, is_directory=is_dir):
                    win._pending_seeded_find["path"] = folder_ops.remap_path_prefix(
                        seeded_path, old_path, new_path, is_directory=is_dir
                    )
        if on_rebound is not None:
            on_rebound()
        for win in target_windows:
            if win.retired:
                continue
            win._watch_notes(force=True)
            win._recover()
            if win.folder:
                win._load_tree()
            if win._folder_search_open and win._folder_search_query.strip():
                win._start_folder_search()
            win._emit()

    @Slot(str)
    def notifyMessage(self, text):
        self.message = str(text or "")
        self._emit(False)

    @Slot(str, str, str)
    def createFolderNote(self, parent_path, name, fmt="md"):
        if not self.folder:
            self.message = "Open a folder first."
            self._emit(False)
            return
        kind = (fmt or "md").strip().lower().lstrip(".")
        if kind not in ("md", "smd"):
            self.message = "Choose Markdown (.md) or portable Super MD (.smd)."
            self._emit(False)
            return
        try:
            target_dir = folder_ops.resolve_within_open_folder(self.folder, parent_path or self.folder, allow_root=True, must_exist=True)
            if not target_dir.is_dir():
                raise ValueError("Choose an existing target folder.")
            filename = folder_ops.validate_entry_name(name, is_directory=False, current_ext="." + kind)
            target = target_dir / filename
            folder_ops.resolve_within_open_folder(self.folder, target, allow_root=False, must_exist=False)
        except ValueError as error:
            self.message = str(error)
            self._emit(False)
            return
        self._activation_generation += 1
        generation = self._activation_generation

        def work():
            if target.exists() or folder_ops._is_link_or_junction(target):
                raise ValueError("An item with that name already exists.")
            if kind == "smd":
                write_portable(target, "", {})
            else:
                atomic_write(target, b"")
            return folder_ops.canonical_path_str(target.resolve(strict=True))

        def finished(created_path, error):
            if error or not created_path:
                return
            self.session.workspace_links.invalidate(self.folder)
            created = Path(created_path)
            for win in list(self.session.windows.values()):
                if not win.retired and win.folder:
                    try:
                        win_root = Path(folder_ops.canonical_path_str(win.folder))
                        if folder_ops.matches_path_prefix(created_path, str(win_root), is_directory=True):
                            win.expanded.update(folder_ops.ancestor_directories_in_folder(win_root, created.parent))
                            win._load_tree()
                    except OSError:
                        pass
            existing = next((t for t in self.tabs if folder_ops.same_path(t["path"], created_path)), None)
            if existing is None:
                note = self._note(created.name, "", created_path, "", {}, kind == "smd")
                self._agent_open_paths.add(created_path)
                self.tabs.append(note)
            else:
                note = existing
            if generation == self._activation_generation:
                self.active = note["id"]
            self.settings["welcomed"] = True
            self.recent = [created_path] + [p for p in self.recent if not folder_ops.same_path(p, created_path)][:29]
            self.message = f"Created {created.name}"
            self._watch_notes(force=True)
            self._preferences()
            self.recovery_timer.start(800)
            self._emit()
            if generation == self._activation_generation:
                self._focus_open_target(generation)

        self._submit(work, finished, executor=self.writes)

    @Slot(str, str)
    def createSubfolder(self, parent_path, name):
        if not self.folder:
            self.message = "Open a folder first."
            self._emit(False)
            return
        try:
            target_dir = folder_ops.resolve_within_open_folder(self.folder, parent_path or self.folder, allow_root=True, must_exist=True)
            if not target_dir.is_dir():
                raise ValueError("Choose an existing target folder.")
            dirname = folder_ops.validate_entry_name(name, is_directory=True)
            target = target_dir / dirname
            folder_ops.resolve_within_open_folder(self.folder, target, allow_root=False, must_exist=False)
        except ValueError as error:
            self.message = str(error)
            self._emit(False)
            return

        def work():
            if target.exists() or folder_ops._is_link_or_junction(target):
                raise ValueError("An item with that name already exists.")
            target.mkdir(parents=False, exist_ok=False)
            return folder_ops.canonical_path_str(target.resolve(strict=True))

        def finished(created_dir, error):
            if error or not created_dir:
                return
            self.session.workspace_links.invalidate(self.folder)
            created = Path(created_dir)
            for win in list(self.session.windows.values()):
                if not win.retired and win.folder:
                    try:
                        win_root = Path(folder_ops.canonical_path_str(win.folder))
                        if folder_ops.matches_path_prefix(created_dir, str(win_root), is_directory=True):
                            ancestors = folder_ops.ancestor_directories_in_folder(win_root, created)
                            win.expanded.update(ancestors)
                            win._pinned_visible_dirs.update(ancestors)
                            win._recover()
                            win._load_tree()
                    except OSError:
                        pass
            self.message = f"Created folder {created.name}"
            self._emit(False)

        self._submit(work, finished, executor=self.writes)

    def _submit_rename(
        self,
        before: Path,
        after: Path,
        final_name: str,
        *,
        is_dir: bool,
        message_builder,
        symlink_error: str,
        exists_error: str,
    ):
        if self.retired or getattr(self.writes, "_shutdown", False):
            return
        before_canon = folder_ops.canonical_path_str(before)
        after_canon = folder_ops.canonical_path_str(after)
        resume_event = self._hold_watches_for_rename(before_canon, is_dir=is_dir, new_path=after_canon)
        session = self.session
        token = uuid.uuid4().hex
        state_lock = threading.Lock()
        finalize_lock = threading.Lock()
        suspension_released = False
        finalized = False
        busy_active = True
        future_holder: list[Any] = []

        def release_suspension():
            nonlocal suspension_released
            with state_lock:
                if suspension_released:
                    return False
                suspension_released = True
            resume_event.set()
            with session._watch_suspension_lock:
                session._watch_suspensions[:] = [
                    item for item in session._watch_suspensions if not item[3].is_set()
                ]
            session._pending_rename_cleanups.pop(token, None)
            with self._write_callback_lock:
                self._pending_write_retirements.pop(token, None)
            return True

        def release_busy():
            nonlocal busy_active
            with state_lock:
                if not busy_active:
                    return
                busy_active = False
            if self.busy > 0:
                self.busy -= 1

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
            _rename_path_with_windows_retry(before, after)
            return before_canon, folder_ops.canonical_path_str(after.resolve(strict=True)), is_dir

        def apply_without_live_windows(value, error):
            nonlocal finalized
            with finalize_lock:
                if finalized:
                    should_apply = False
                else:
                    finalized = True
                    should_apply = True
            release_busy()
            if should_apply and value is not None and not error:
                old_str, new_str, was_dir = value
                with session._rename_state_lock:
                    session._remap_session_paths(old_str, new_str, is_dir=was_dir)
                    session._retired_persist_needed = True
                session._enqueue_retired_persistence()
            release_suspension()

        def finalize_without_live_windows(done_future):
            if done_future.cancelled():
                value, error = None, "cancelled"
            else:
                try:
                    value, error = done_future.result(), None
                except Exception as reason:
                    value, error = None, str(reason)
            apply_without_live_windows(value, error)

        def finish_on_ui(value, error):
            nonlocal finalized
            live_windows = [w for w in list(session.windows.values()) if not w.retired]
            if not live_windows:
                apply_without_live_windows(value, error)
                return
            with finalize_lock:
                if finalized:
                    release_suspension()
                    return
                finalized = True
            release_busy()
            if error or not value:
                release_suspension()
                for win in live_windows:
                    win._watch_notes(force=True)
                if not self.retired:
                    if error:
                        self.message = error
                        self.pending_close = ""
                    self._emit(False)
                return
            old_str, new_str, was_dir = value
            target_win = self if not self.retired else live_windows[0]
            target_win._sync_path_change(
                old_str,
                new_str,
                is_dir=was_dir,
                message=message_builder(new_str) if target_win is self else "",
                on_rebound=release_suspension,
            )

        def cleanup_when_no_live_windows():
            nonlocal finalized
            release_busy()
            if any(not w.retired for w in list(session.windows.values())):
                # Keep suspension active until the worker finishes and Session
                # rebinds paths and identities on the surviving window(s).
                return
            fut = future_holder[0] if future_holder else None
            if fut is None:
                with finalize_lock:
                    finalized = True
                release_suspension()
                return
            if fut.done():
                finalize_without_live_windows(fut)

        session._pending_rename_cleanups[token] = cleanup_when_no_live_windows
        with self._write_callback_lock:
            self._pending_write_retirements[token] = cleanup_when_no_live_windows

        self.busy += 1
        self._emit(False)
        try:
            future = self.writes.submit(work)
        except RuntimeError:
            with finalize_lock:
                finalized = True
            release_busy()
            release_suspension()
            for win in list(session.windows.values()):
                if not win.retired:
                    win._watch_notes(force=True)
            self._emit(False)
            return
        future_holder.append(future)

        def completed(f):
            if not any(not w.retired for w in list(session.windows.values())):
                finalize_without_live_windows(f)
                return
            if f.cancelled():
                value, error = None, ""
            else:
                try:
                    value, error = f.result(), None
                except Exception as reason:
                    value, error = None, str(reason)
            if not any(not w.retired for w in list(session.windows.values())):
                apply_without_live_windows(value, error)
                return
            try:
                session.renameCompleted.emit((finish_on_ui, value, error))
            except RuntimeError:
                apply_without_live_windows(value, error)

        future.add_done_callback(completed)

    @Slot(str, str)
    def renameEntry(self, entry_path, name):
        if not self.folder:
            self.message = "Open a folder first."
            self._emit(False)
            return
        try:
            before = folder_ops.resolve_within_open_folder(self.folder, entry_path, allow_root=False, must_exist=True)
            is_dir = before.is_dir()
            final_name = folder_ops.validate_entry_name(
                name,
                is_directory=is_dir,
                current_ext="" if is_dir else folder_ops.note_extension(before.name),
                has_saved_target=True,
            )
            after = before.with_name(final_name)
            if not folder_ops.same_path(after, before):
                folder_ops.resolve_within_open_folder(self.folder, after, allow_root=False, must_exist=False)
        except ValueError as error:
            self.message = str(error)
            self._emit(False)
            return
        if before.name == final_name:
            return
        for win in list(self.session.windows.values()):
            for tab in win.tabs:
                if tab["id"] in win.saving and folder_ops.matches_path_prefix(tab["path"], str(before), is_directory=is_dir):
                    self.message = "Wait for the current save to finish."
                    self._emit(False)
                    return
        self._submit_rename(
            before,
            after,
            final_name,
            is_dir=is_dir,
            message_builder=lambda new_str: f"Renamed to {Path(new_str).name}",
            symlink_error="Symlinks are not allowed inside the open folder.",
            exists_error="An item with that name already exists.",
        )

    @Slot(str, str)
    def renameNote(self, id, name):
        tab = next((t for t in self.tabs if t["id"] == id), None)
        if not tab or id in self.saving: return
        try:
            has_saved = bool(tab.get("path"))
            existing_ext = folder_ops.note_extension(tab["name"])
            current_ext = existing_ext if has_saved else (existing_ext or (".smd" if tab.get("portable") else ".md"))
            final_name = folder_ops.validate_entry_name(
                name,
                is_directory=False,
                current_ext=current_ext,
                has_saved_target=has_saved,
            )
        except ValueError as error:
            self.message = str(error); self._emit(False); return
        if not tab["path"]: tab["name"] = final_name; self._recover(); self._emit(False); return
        before = Path(tab["path"]); after = before.with_name(final_name)
        if before.name == final_name: return
        if self.folder and folder_ops.matches_path_prefix(str(before), self.folder, is_directory=True):
            self.renameEntry(str(before), final_name)
            return
        self._submit_rename(
            before,
            after,
            final_name,
            is_dir=False,
            message_builder=lambda _new_str: f"Renamed to {final_name}",
            symlink_error="Symlinks are not allowed.",
            exists_error="A file with that name already exists.",
        )

    @staticmethod
    def _existing_save_directory(raw_path, *, reject_links: bool = False) -> Path | None:
        cleaned = folder_ops.strip_extended_length_prefix(str(raw_path or "").strip())
        if not cleaned:
            return None
        try:
            candidate = Path(cleaned).expanduser()
            if reject_links and folder_ops._is_link_or_junction(candidate):
                return None
            if reject_links:
                resolved = Path(folder_ops.strip_extended_length_prefix(str(candidate.resolve(strict=True))))
                return Path(folder_ops.canonical_path_str(resolved)) if resolved.is_dir() else None
            return candidate if candidate.is_dir() else None
        except OSError:
            return None

    @classmethod
    def _downloads_fallback_directory(cls) -> Path:
        raw_downloads = QStandardPaths.writableLocation(QStandardPaths.StandardLocation.DownloadLocation)
        downloads = cls._existing_save_directory(raw_downloads)
        if downloads is not None:
            return downloads
        home = cls._existing_save_directory(Path.home())
        if home is not None:
            return home
        cleaned = folder_ops.strip_extended_length_prefix(str(raw_downloads or "").strip()) or str(Path.home())
        return Path(cleaned).expanduser()

    def _default_output_directory(self) -> Path:
        raw = (
            self.settings.get("newNoteLocation")
            or QStandardPaths.writableLocation(QStandardPaths.StandardLocation.DownloadLocation)
            or str(Path.home())
        )
        cleaned = folder_ops.strip_extended_length_prefix(str(raw or "").strip()) or str(Path.home())
        return Path(cleaned).expanduser()

    def _note_save_directory(self) -> Path:
        configured = self._existing_save_directory(self.settings.get("newNoteLocation"))
        if configured is not None:
            return configured
        open_folder = self._existing_save_directory(self.folder, reject_links=True)
        if open_folder is not None:
            return open_folder
        return self._downloads_fallback_directory()

    def _save_as_directory(self) -> Path:
        current_path = self._current().get("path") if self.tabs else ""
        if current_path:
            cleaned_current = folder_ops.strip_extended_length_prefix(str(current_path).strip())
            if cleaned_current:
                parent = self._existing_save_directory(Path(cleaned_current).expanduser().parent)
                if parent is not None:
                    return parent
        return self._note_save_directory()

    @Slot(result=QUrl)
    def defaultSaveFolder(self):
        return QUrl.fromLocalFile(str(self._note_save_directory()))

    @Slot(str, result=QUrl)
    def defaultSaveLocation(self, name):
        leaf = folder_ops._pure_path(str(name or "")).name or "Untitled.md"
        return QUrl.fromLocalFile(str(self._note_save_directory() / leaf))

    @Slot(result=QUrl)
    def defaultSaveAsFolder(self):
        return QUrl.fromLocalFile(str(self._save_as_directory()))

    @Slot(str, result=QUrl)
    def defaultSaveAsLocation(self, name):
        leaf = folder_ops._pure_path(str(name or "")).name or "Untitled.md"
        return QUrl.fromLocalFile(str(self._save_as_directory() / leaf))

    @Slot(str, result=QUrl)
    def defaultExportLocation(self, format):
        return studio_exports.default_export_location(self, format)

    @Slot(str, result=QUrl)
    def defaultThemeExportLocation(self, name):
        leaf = folder_ops._pure_path(str(name or "")).name or "My theme.supermd-theme.json"
        return QUrl.fromLocalFile(str(self._default_output_directory() / leaf))

    @Slot(str)
    def closeTab(self, id):
        tab = next((t for t in self.tabs if t["id"] == id), None)
        if not tab:
            return
        self._activation_generation += 1
        if self._is_dirty(tab) and (tab["path"] or tab["content"].strip() or tab["assets"]):
            self.pending_close = id
            self.selectTab(id)
            self.closeRequested.emit(tab["name"])
        else:
            self._remove_tab(id)

    def _remove_tab(self, id):
        removed=next((tab for tab in self.tabs if tab["id"]==id),None)
        if removed is None:return
        if removed["content"].strip() or removed["path"] or removed.get("assets"):
            if id in self._closing_tabs:return
            self._closing_tabs.add(id)
            self._python_jobs.cancel_tab(id)
            # Strings and encoded assets are immutable; snapshot small mutable
            # metadata/asset mappings without walking large base64 strings.
            captured=_snapshot_tab_state(removed)
            def saved(reference,error):
                self._closing_tabs.discard(id)
                if error:
                    self.message="Could not preserve the closed note: "+error
                    return
                current=next((tab for tab in self.tabs if tab["id"]==id),None)
                if current is None:return
                if not _same_closed_revision(current,captured):
                    self.message="The note changed while it was closing. It remains open with the latest text."
                    return
                next_refs=[reference]+self.closed_tabs
                next_refs=next_refs[:ClosedNoteStore.LIMIT]
                try:self.session.closed_note_store.save_index(next_refs)
                except Exception as failure:
                    self.message="Could not update closed-note recovery: "+str(failure)
                    return
                self.closed_tabs[:]=next_refs
                self._finish_remove_tab(id)
            self._submit(lambda:self.session.closed_note_store.save(captured),saved,False,self.writes)
            return
        self._finish_remove_tab(id)

    def _finish_remove_tab(self,id):
        self._python_jobs.cancel_tab(id)
        self.reader_edits.clear(id)
        current_index=next((i for i,tab in enumerate(self.tabs) if tab["id"]==id),None)
        if current_index is None:return
        self.session.reader_assets.revoke_tab(self.window_id, id)
        self.tabs.pop(current_index)
        if not self.tabs:
            self.tabs.append(self._note("Untitled.md"))
        if self.active == id:
            self._activation_generation += 1
            self.active = self.tabs[min(current_index, len(self.tabs)-1)]["id"]
        self._recover()
        self._emit()

    @Slot(result=bool)
    def requestWindowClose(self):
        bg = getattr(self.session, "background", None)
        if (
            bg is not None
            and getattr(bg, "_stopping_from_cli", False)
            and getattr(self, "host_window", None) is not None
            and not self.host_window.isVisible()
        ):
            return True
        dirty = next((t for t in self.tabs if self._is_dirty(t) and (t["path"] or t["content"].strip() or t["assets"])), None)
        if dirty:
            self.pending_close = "window"
            self.selectTab(dirty["id"])
            self.closeRequested.emit(dirty["name"])
            return False
        return True

    @Slot(str)
    def resolveClose(self, choice):
        if choice == "cancel":
            was_window = self.pending_close == "window"
            self.pending_close = ""
            if was_window:
                service = getattr(self.session, "background", None)
                if service is not None: service.cancel_quit()
            return
        if choice == "save": self.save(); return
        if choice == "discard":
            # For a single-tab close, "discard" confirms closing the dirty
            # buffer; the closed snapshot must retain its original saved text.
            if self.pending_close != "window":
                action=self.pending_close
                self.pending_close=""
                if action:self._remove_tab(action)
                return
            current = self._current()
            if current["content"].strip() or current["path"] or current.get("assets"):
                captured = _snapshot_tab_state(current)
                try:
                    reference = self.session.closed_note_store.save(captured)
                    next_refs = ([reference] + self.closed_tabs)[:ClosedNoteStore.LIMIT]
                    self.session.closed_note_store.save_index(next_refs)
                    self.closed_tabs[:] = next_refs
                except Exception as failure:
                    self.message = "Could not preserve the closed note: " + str(failure)
            current["saved"] = current["content"]
            current["saved_assets"] = dict(current.get("assets", {}))
            current["assets_dirty"] = False
            self._finish_close()

    def _finish_close(self):
        action = self.pending_close
        self.pending_close = ""
        if action == "window":
            if self.requestWindowClose():
                self._recover()
                self.allowClose.emit()
        elif action:
            self.closeTab(action)

    @Slot(str, str)
    def exportTo(self, value, format):
        studio_exports.export_to(self, value, format)

    @Slot(str)
    def command(self, action):
        calls = {
            "find": "window.supermdFind?.()",
            "replace": "window.supermdFind?.(true)",
            "find_next": "window.supermdFindStep?.(1)",
            "find_previous": "window.supermdFindStep?.(-1)",
            "insert": "window.supermdMedia?.()",
            "repair": "window.supermdRepairMath?.()",
            "undo": "window.supermdHistory?.('undo')",
            "redo": "window.supermdHistory?.('redo')",
            "format_bold": "window.supermdFormat?.('bold')",
            "format_italic": "window.supermdFormat?.('italic')",
            "format_inline_code": "window.supermdFormat?.('inline_code')",
            "format_link": "window.supermdFormat?.('link')",
            "format_heading": "window.supermdFormat?.('heading')",
            "format_list": "window.supermdFormat?.('list')",
            "format_quote": "window.supermdFormat?.('quote')",
            "format_inline_math": "window.supermdFormat?.('inline_math')",
        }
        if action in calls: self.readerCall.emit(calls[action])
        elif action == "window": self.newWindowRequested.emit()

    def _agent_export_path(self, filename: str, format: str, tab: dict) -> Path:
        extension = {"pdf": ".pdf", "smd": ".smd", "md": ".md"}[format]
        selected = filename or Path(tab["name"]).stem or "Super MD export"
        if Path(selected).name != selected or any(char in selected for char in ("/", "\\", "\0")):
            raise ValueError("Export filename must be a basename")
        stem = Path(selected).stem if Path(selected).suffix else selected
        stem = "".join(char for char in stem if char.isalnum() or char in " ._()-").strip(" .")[:100]
        if not stem or stem in (".", ".."):
            stem = "Super MD export"
        directory = Path(self.settings.get("newNoteLocation") or QStandardPaths.writableLocation(QStandardPaths.StandardLocation.DownloadLocation) or str(Path.home())).expanduser()
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

    @staticmethod
    def _agent_export_metadata(path: Path, format: str) -> dict:
        return studio_exports.agent_export_metadata(path, format)

    def _agent_export_native(self, request_id: str, args: dict):
        studio_exports.agent_export_native(self, request_id, args)

    def _agent_job_status(self, job_id):
        return studio_exports.agent_job_status(self, job_id)

    def _agent_export_chunk(self, job_id, offset=0, limit=262_144):
        return studio_exports.agent_export_chunk(self, job_id, offset, limit)

    def _agent_document_action(self, args):
        action = args.get("action")
        if action == "patch_tab":
            tab_id = args.get("tabId")
            tab = next((item for item in self.tabs if item["id"] == tab_id), None)
            if tab is None:
                raise ValueError("The requested live tab is no longer open")
            expected = args.get("expectedRevision")
            revision = hashlib.sha256(tab["content"].encode("utf-8")).hexdigest()
            if not isinstance(expected, str) or expected != revision:
                raise ValueError("Live tab revision changed; inspect it again before editing")
            operations = args.get("operations")
            if not isinstance(operations, list) or len(operations) > 100:
                raise ValueError("operations must contain at most 100 edits")
            if len(json.dumps(operations, ensure_ascii=False).encode("utf-8")) > 64_000:
                raise ValueError("Patch operations exceed the 64 KB limit")
            from agent_documents import apply_patch_operations_detailed
            edited, operation_results = apply_patch_operations_detailed(tab["content"], operations)
            changed = edited != tab["content"]
            if changed:
                tab["content"] = edited
                self.recovery_timer.start(800)
                self.autosave_timer.start(900)
                self._emit(load=tab_id == self.active)
            return {"tabId": tab_id, "windowId": self.window_id,
                    "revision": hashlib.sha256(edited.encode("utf-8")).hexdigest(),
                    "sourceLength": len(edited), "changed": changed,
                    "applied": len(operation_results), "operation_results": operation_results,
                    "isDirty": edited != tab["saved"]}
        if action == "replace_tab_asset":
            return self._replace_tab_asset_native(args)
        if action == "asset_action" and args.get("assetAction") == "attach":
            return self._attach_tab_asset_native(args)
        if action == "create_document":
            fmt = args.get("format")
            content = args.get("content", "")
            title = args.get("title") or args.get("filename", "")
            background = args.get("background", False)
            if not isinstance(background, bool):
                raise ValueError("background must be a boolean")
            if fmt is None:
                fmt = "smd" if isinstance(title, str) and Path(title).suffix.lower() == ".smd" else "md"
            if (fmt not in ("md", "smd") or not isinstance(content, str) or
                    len(content.encode("utf-8")) > 20_000_000 or not isinstance(title, str)):
                raise ValueError("New document content or format is invalid")
            title = title.strip() or ("Untitled.smd" if fmt == "smd" else "Untitled.md")
            suffix = Path(title).suffix.lower()
            if suffix in (".md", ".smd") and suffix != "." + fmt:
                title = str(Path(title).with_suffix("." + fmt))
            elif not title.lower().endswith("." + fmt):
                title += "." + fmt
            note = self._note(title, content, "", "", {}, fmt == "smd")
            self.tabs.append(note)
            if not background:
                self.active = note["id"]
            self.recovery_timer.start(800)
            self._emit(load=not background)
            revision = hashlib.sha256(content.encode("utf-8")).hexdigest()
            return self._agent_tab_result(note, active=not background, title=title)
        if action == "save_document":
            return Studio._run_prepared_write_sync(self, Studio._prepare_save_document(self, args))
        if action == "activate_document":
            tab_id = args.get("tabId")
            tab = next((item for item in self.tabs if item["id"] == tab_id), None)
            if tab is None:
                raise ValueError("The requested live tab is no longer open")
            self.selectTab(tab_id)
            return self._agent_tab_result(tab, active=True)
        if action == "close_document":
            tab_id = args.get("tabId")
            tab = next((item for item in self.tabs if item["id"] == tab_id), None)
            if tab is None:
                raise ValueError("The requested live tab is no longer open")
            expected = args.get("expectedRevision")
            revision = hashlib.sha256(tab["content"].encode("utf-8")).hexdigest()
            if not isinstance(expected, str) or expected != revision:
                raise ValueError("Live tab revision changed; inspect it again before closing")
            discard = args.get("discardChanges", False)
            if not isinstance(discard, bool):
                raise ValueError("discardChanges must be a boolean")
            if Studio._is_dirty(self, tab) and not discard:
                raise ValueError("The document has unsaved changes; pass discardChanges:true to close and preserve it in closed-note recovery")
            self._remove_tab(tab_id)
            if any(item["id"] == tab_id for item in self.tabs):
                return {"status": "closing", "tabId": tab_id, "windowId": self.window_id,
                        "path": tab["path"], "revision": revision, "active": self.active == tab_id}
            return {"status": "closed", "tabId": tab_id, "windowId": self.window_id,
                    "path": tab["path"], "revision": revision, "active": self.active == tab_id}
        if action == "open_document":
            background = args.get("background", False)
            if not isinstance(background, bool):
                raise ValueError("background must be a boolean")
            filename = args.get("filename", "")
            if filename == "":
                tab_id = args.get("tabId")
                existing = next((item for item in self.tabs if item["id"] == tab_id), None)
                if existing is None:
                    raise ValueError("The requested live tab is no longer open")
                if not background: self.selectTab(existing["id"])
                return self._agent_tab_result(existing, active=not background)
            candidate = Path(filename).expanduser()
            if not candidate.is_absolute():
                directory = Path(self.settings.get("newNoteLocation") or QStandardPaths.writableLocation(QStandardPaths.StandardLocation.DownloadLocation) or str(Path.home())).expanduser()
                candidate = directory / candidate.name
            if not self._agent_path_allowed(candidate):
                raise ValueError("The file is outside the approved agent note roots")
            resolved = str(candidate.resolve())
            existing = next((item for item in self.tabs if item["path"] and str(Path(item["path"]).resolve()) == resolved), None)
            if existing:
                if not background: self.selectTab(existing["id"])
                return self._agent_tab_result(existing, active=not background)
            while len(self._agent_job_records) >= 20:
                removable = next((key for key, value in self._agent_job_records.items()
                                  if value.get("status") in ("completed", "failed", "cancelled")), None)
                if removable is None:
                    raise ValueError("The desktop already has 20 active agent jobs")
                self._agent_job_records.pop(removable, None)
            job_id = uuid.uuid4().hex
            fmt = "smd" if Path(resolved).suffix.lower() == ".smd" else "md"
            self._agent_job_records[job_id] = {"jobId": job_id, "status": "running", "action": "open_document",
                                               "path": resolved, "windowId": self.window_id,
                                               "active": not background, "format": fmt}
            self._agent_open_paths.add(resolved)
            def opened(result, error):
                record = self._agent_job_records.get(job_id)
                if record is None: return
                if error:
                    record.update(status="failed", error=str(error)[:1000])
                else:
                    metadata = self._agent_tab_result(result)
                    record.update(status="completed", **metadata)
            self._open_note(resolved, explicit=not background, background=background, completion_callback=opened)
            return {"status": "opening", "jobId": job_id, "path": resolved, "windowId": self.window_id,
                    "active": not background, "format": fmt}
        raise ValueError("Unsupported native document action")

    def _agent_tab_result(self, tab, *, active=None, title=None):
        content = tab["content"]
        path = tab["path"]
        fmt = "smd" if tab.get("portable") or Path(path or tab["name"]).suffix.lower() == ".smd" else "md"
        return {"tabId": tab["id"], "windowId": self.window_id, "revision": hashlib.sha256(content.encode("utf-8")).hexdigest(),
                "path": path, "title": title or tab["name"], "active": self.active == tab["id"] if active is None else active,
                "sourceLength": len(content), "format": fmt, "isDirty": Studio._is_dirty(self, tab)}

    def _agent_path_allowed(self, path: Path) -> bool:
        """Check open targets against user-selected note roots and session paths."""
        absolute = Path(os.path.abspath(path))
        # On macOS /var is the system-provided alias for /private/var. Resolve
        # this one known alias before checking path components so a temporary
        # folder selected through /var remains usable, while symlinks inside
        # the selected note root are still rejected below.
        if sys.platform == "darwin":
            alias = Path("/var")
            canonical = Path("/private/var")
            try:
                if (alias.is_symlink() and alias.resolve(strict=True) == canonical.resolve(strict=True)
                        and (absolute == alias or alias in absolute.parents)):
                    absolute = canonical / absolute.relative_to(alias)
            except (OSError, RuntimeError):
                pass
        try:
            if not absolute.is_file(): return False
            # Refuse symlinks in every component, including the selected file.
            current = Path(absolute.anchor)
            for component in absolute.parts[1:]:
                current /= component
                if current.is_symlink(): return False
            resolved = absolute.resolve(strict=True)
        except (OSError, RuntimeError):
            return False
        if str(resolved) in self._agent_owned_files or str(resolved) in self._agent_open_paths:
            return True
        roots = []
        location = self.settings.get("newNoteLocation")
        if location: roots.append(Path(location).expanduser())
        if self.folder: roots.append(Path(self.folder))
        roots.extend(Path(tab["path"]).parent for tab in self.tabs if tab.get("path"))
        for root in roots:
            try:
                root = root.resolve(strict=True)
                if root.is_dir() and (resolved == root or root in resolved.parents): return True
            except (OSError, RuntimeError):
                continue
        return False

    @staticmethod
    def _run_prepared_write_sync(studio, prepared):
        tab_id, work, finalize, _abort = prepared
        saving = getattr(studio, "saving", None)
        if saving is not None:
            saving.add(tab_id)
        try:
            value = work()
        except Exception as error:
            if saving is not None:
                saving.discard(tab_id)
            finalize(None, str(error))
            raise
        if saving is not None:
            saving.discard(tab_id)
        return finalize(value, None)

    def _agent_document_action_async(self, args, on_complete):
        action = args.get("action")
        if action == "save_document":
            prepared = Studio._prepare_save_document(self, args)
        elif action == "replace_tab_asset":
            prepared = Studio._prepare_replace_tab_asset(self, args)
        elif action == "asset_action" and args.get("assetAction") == "attach":
            prepared = Studio._prepare_attach_tab_asset(self, args)
        else:
            result = self._agent_document_action(args)
            on_complete(result, None)
            return

        tab_id, work, finalize, abort = prepared
        if self.retired or getattr(self.writes, "_shutdown", False):
            abort()
            raise ValueError("The target desktop window was closed")

        self.saving.add(tab_id)

        def handle_done(value, error):
            self.saving.discard(tab_id)
            if error is not None:
                finalize(None, error)
                on_complete(None, error)
                return
            try:
                result = finalize(value, None)
            except Exception as failure:
                on_complete(None, str(failure))
                return
            on_complete(result, None)

        def handle_retired():
            self.saving.discard(tab_id)
            finalize(None, "The target desktop window was closed")
            on_complete(None, "The target desktop window was closed")

        if not self._submit_write(work, handle_done, on_retired=handle_retired):
            abort()

    def _prepare_save_document(self, args):
        tab_id = args.get("tabId")
        tab = next((item for item in self.tabs if item["id"] == tab_id), None)
        if not tab:
            raise ValueError("Save requires a target tab that is still open")
        saving = getattr(self, "saving", None)
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
        if fmt not in ("md", "smd"):
            raise ValueError("Save format must be md or smd")
        old_path = tab["path"]
        try:
            old_canonical_path = str(Path(old_path).resolve(strict=True)) if old_path else ""
        except (OSError, RuntimeError):
            old_canonical_path = ""
        save_as = bool(args.get("saveAs", False)) or bool(args.get("filename"))
        if not isinstance(args.get("saveAs", False), bool):
            raise ValueError("saveAs must be a boolean")
        same_format = tab.get("path") and current_format == fmt
        saved_snapshot = tab["saved"]
        assets_snapshot = dict(tab.get("assets", {}))
        saved_assets_snapshot = dict(tab.get("saved_assets", assets_snapshot))
        portable_snapshot = bool(tab.get("portable"))
        created_new_path = False
        reservation_identity = None
        if old_path and not save_as and same_format and fmt == current_format:
            path = Path(old_path)
            if not path.is_file():
                raise ValueError("The saved file is no longer available; use save-as to create a new copy")
        else:
            if old_path and not save_as:
                raise ValueError("Saving in another format requires saveAs:true and a new filename")
            path = self._agent_export_path(args.get("filename", ""), fmt, tab)
            self._agent_owned_files.add(str(path.resolve()))
            created_new_path = True
            reservation_stat = path.stat(follow_symlinks=False)
            reservation_identity = (reservation_stat.st_dev, reservation_stat.st_ino)
        resolved_path = path.resolve()

        def unlink_reserved():
            if not created_new_path:
                return
            try:
                current_stat = resolved_path.stat(follow_symlinks=False)
                if (reservation_identity == (current_stat.st_dev, current_stat.st_ino)
                        and current_stat.st_size == 0 and not resolved_path.is_symlink()):
                    resolved_path.unlink()
            except OSError:
                pass

        def abort():
            unlink_reserved()
            if created_new_path:
                self._agent_owned_files.discard(str(resolved_path))

        def work():
            try:
                if not created_new_path:
                    # Compare the full decoded note, including portable assets, with
                    # the tab's saved snapshot before replacing the existing file.
                    if not path.is_file():
                        raise ValueError("The saved file is no longer available; use save-as to create a new copy")
                    disk_content, disk_assets, disk_portable = open_note(path)
                    if (disk_content != saved_snapshot or disk_assets != saved_assets_snapshot or
                            disk_portable != portable_snapshot):
                        raise ValueError("This file changed outside Super MD. Your edits remain in draft recovery; use save-as to keep both versions.")
                if fmt == "smd":
                    write_portable(resolved_path, content_snapshot, assets_snapshot)
                else:
                    # Converting a portable note to Markdown must keep its
                    # relative image references valid on disk. The helper
                    # refuses to replace an unrelated image at that path.
                    materialize_assets(resolved_path.parent, assets_snapshot)
                    atomic_write(resolved_path, content_snapshot.encode("utf-8"))
                try:
                    st = resolved_path.stat()
                    return (st.st_mtime_ns, st.st_size)
                except OSError:
                    return None
            except Exception:
                unlink_reserved()
                raise

        def finalize(stamp, error):
            if error is not None:
                unlink_reserved()
                if created_new_path:
                    self._agent_owned_files.discard(str(resolved_path))
                return None
            if stamp and hasattr(self, "note_file_stamps"):
                self.note_file_stamps[str(resolved_path)] = stamp
            path_changed = not old_canonical_path or str(resolved_path) != old_canonical_path
            target = next((item for item in self.tabs if item["id"] == tab_id), None)
            is_dirty = False
            if target is not None:
                target.update(
                    path=str(resolved_path),
                    name=resolved_path.name,
                    saved=content_snapshot,
                    saved_assets=dict(assets_snapshot),
                    assets_dirty=False,
                    portable=fmt == "smd",
                    conflict=False,
                )
                is_dirty = Studio._is_dirty(self, target)
                if is_dirty and getattr(self, "settings", {}).get("autosave") and hasattr(self, "autosave_timer"):
                    self.autosave_timer.start(900)
            self._agent_open_paths.add(str(resolved_path))
            self._recover()
            self._emit()
            if path_changed:
                Studio._refresh_open_folder_trees(self, resolved_path, old_canonical_path or old_path)
            return {"tabId": tab_id, "windowId": self.window_id, "path": str(resolved_path),
                    "filename": resolved_path.name, "revision": revision, "format": fmt, "isDirty": is_dirty,
                    "pathChanged": path_changed, "oldPath": old_canonical_path or old_path,
                    "newPath": str(resolved_path)}

        return tab_id, work, finalize, abort

    def _extra_asset_roots(self) -> list[Path]:
        roots: list[Path] = []
        if getattr(self, "folder", ""):
            roots.append(Path(self.folder))
        location = self.settings.get("newNoteLocation") if isinstance(getattr(self, "settings", None), dict) else None
        if location:
            roots.append(Path(location))
        return roots

    def _apply_saved_tab_assets(self, tab_id: str, path: Path, content_snapshot: str,
                                assets_snapshot: dict, updated: dict, stamp=None) -> None:
        if stamp and hasattr(self, "note_file_stamps"):
            self.note_file_stamps[str(path)] = stamp
        target = next((item for item in self.tabs if item["id"] == tab_id), None)
        if target is not None:
            extra = {k: v for k, v in target.get("assets", {}).items() if k not in assets_snapshot}
            target["assets"] = {**updated, **extra} if extra else updated
            target["saved"] = content_snapshot
            target["saved_assets"] = dict(updated)
            target["assets_dirty"] = bool(extra)
            target["conflict"] = False
            if Studio._is_dirty(self, target) and getattr(self, "settings", {}).get("autosave") and hasattr(self, "autosave_timer"):
                self.autosave_timer.start(900)
        session = getattr(self, "session", None)
        reader_assets = getattr(session, "reader_assets", None)
        if reader_assets is not None:
            reader_assets.revoke_tab(self.window_id, tab_id)
        if hasattr(self, "readerCall"):
            self.readerCall.emit("window.dispatchEvent(new Event('supermd-assets-changed'))")
        if hasattr(self, "_recover"):
            self._recover()
        if hasattr(self, "_emit"):
            self._emit()

    def _prepare_attach_tab_asset(self, args):
        """Prepare attaching a bounded local or relay-supplied image to a saved portable note."""
        tab_id = args.get("tabId")
        tab = next((item for item in self.tabs if item["id"] == tab_id), None)
        if not tab or tab_id != self.active:
            raise ValueError("Attaching an asset requires the target tab to be active")
        saving = getattr(self, "saving", None)
        if saving is not None and tab_id in saving:
            raise ValueError("A save is already in progress for this tab; retry after it finishes")
        content_snapshot = tab["content"]
        revision = hashlib.sha256(content_snapshot.encode("utf-8")).hexdigest()
        if args.get("expectedRevision") != revision:
            raise ValueError("Live tab revision changed; inspect it again before attaching an asset")
        path = Path(tab.get("path") or "")
        if not tab.get("portable") or path.suffix.lower() != ".smd" or not path.is_file():
            raise ValueError("Attaching an asset requires a saved portable .smd note")
        saved_snapshot = tab["saved"]
        if Studio._is_dirty(self, tab):
            raise ValueError("Save the note before attaching a portable asset")

        mime = args.get("mimeType")
        body = args.get("body")
        asset_path = args.get("assetPath")
        if (isinstance(body, str)) == (isinstance(asset_path, str) and bool(asset_path)):
            raise ValueError("Provide exactly one of base64 body or local assetPath")
        inline_mode = isinstance(body, str)
        candidate = None
        if inline_mode:
            if mime not in MIMES.values() or len(body) > (MAX_IMAGE * 4 // 3 + 8):
                raise ValueError("Inline asset type or size is invalid")
            requested_name = args.get("assetName")
        else:
            candidate = _validate_local_tab_asset_path(
                asset_path,
                path,
                Studio._extra_asset_roots(self),
                unavailable_message="Asset file is unavailable",
                outside_message="Asset must be inside the current note folder or a configured folder",
            )
            if candidate.stat().st_size > MAX_IMAGE:
                raise ValueError("Asset exceeds 25 MB")
            extension = candidate.suffix.lower().lstrip(".")
            mime = MIMES.get(extension)
            if mime is None:
                raise ValueError("Asset type must be PNG, JPEG, SVG, GIF, WebP or AVIF")
            requested_name = args.get("assetName") or candidate.name

        assets_snapshot = dict(tab.get("assets", {}))
        saved_assets_snapshot = dict(tab.get("saved_assets", assets_snapshot))

        def work():
            if inline_mode:
                try:
                    raw = decode_base64_chunked(body)
                except (ValueError, TypeError, base64.binascii.Error) as error:
                    raise ValueError("Asset body must be valid base64") from error
                if not 1 <= len(raw) <= 1024 * 1024:
                    raise ValueError("Relay supplied assets are limited to 1 MiB")
            else:
                assert candidate is not None
                raw = candidate.read_bytes()
                if len(raw) > MAX_IMAGE:
                    raise ValueError("Asset exceeds 25 MB")

            filename = requested_name.removeprefix("assets/") if isinstance(requested_name, str) else ""
            if not is_valid_asset_filename(filename):
                raise ValueError("Asset name must be a simple filename")
            ext = Path(filename).suffix.lower().lstrip(".")
            if not ext:
                ext = next((item for item, kind in MIMES.items() if kind == mime), "")
                filename += "." + ext
                if not is_valid_asset_filename(filename):
                    raise ValueError("Asset name must be a simple filename")
            if MIMES.get(ext) != mime:
                raise ValueError("Asset name extension must match the image type")
            if not _matches_media_signature(mime, raw):
                raise ValueError("Asset bytes do not match the declared image type")
            asset_key = "assets/" + filename
            if asset_key in assets_snapshot:
                raise ValueError("An asset with that name already exists")
            disk_content, disk_assets, portable = open_note(path)
            if not portable or disk_content != saved_snapshot or disk_assets != saved_assets_snapshot:
                raise ValueError("The portable note changed on disk; reopen it before attaching an asset")
            updated = dict(assets_snapshot)
            updated[asset_key] = f"data:{mime};base64," + encode_base64_chunked(raw)
            write_portable(path, content_snapshot, updated)
            try:
                st = path.stat()
                stamp = (st.st_mtime_ns, st.st_size)
            except OSError:
                stamp = None
            sha = hashlib.sha256(raw).hexdigest()
            record = {"name": asset_key, "mime": mime, "bytes": len(raw), "sha256": sha}
            return {"updated": updated, "stamp": stamp,
                    "result": {"tabId": tab_id, "assetName": asset_key, "asset": record,
                               "mimeType": mime, "bytes": len(raw), "sha256": sha,
                               "revision": revision, "saved": True}}

        def finalize(value, error):
            if error is not None:
                return None
            Studio._apply_saved_tab_assets(
                self, tab_id, path, content_snapshot, assets_snapshot, value["updated"], value.get("stamp")
            )
            return value["result"]

        return tab_id, work, finalize, lambda: None

    def _attach_tab_asset_native(self, args):
        """Attach a bounded local or relay-supplied image to a saved portable note."""
        return Studio._run_prepared_write_sync(self, Studio._prepare_attach_tab_asset(self, args))

    @staticmethod
    def _parse_media_envelope(raw: str):
        if len(raw) > 524_288:
            key_pos = raw.find('"body"')
            if key_pos >= 0:
                colon_pos = raw.find(":", key_pos + 6)
                if colon_pos >= 0:
                    q_open = raw.find('"', colon_pos + 1)
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

    @staticmethod
    def _validate_and_write_media(args: dict, directory: Path, *, source_str: str | None = None,
                                  body_start: int = 0, body_end: int | None = None) -> dict:
        if not isinstance(args, dict):
            raise ValueError("Invalid media payload")
        mime_type, filename = args.get("mimeType"), args.get("filename", "")
        if source_str is None:
            body = args.get("body")
            if not isinstance(body, str):
                raise ValueError("Media data is invalid or exceeds 25 MB")
            source_str = body
            body_start = 0
            body_end = len(body)
        else:
            assert body_end is not None
        body_len = body_end - body_start
        extensions = {"image/png": ".png", "image/svg+xml": ".svg", "image/jpeg": ".jpg",
                      "image/webp": ".webp", "image/gif": ".gif", "image/avif": ".avif",
                      "text/plain": ".mmd"}
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
        first_slice = source_str[body_start:first_end]
        try:
            if first_end < body_end and "=" in first_slice:
                raise base64.binascii.Error("Excess data after padding")
            first_chunk = base64.b64decode(first_slice, validate=True)
        except (ValueError, base64.binascii.Error):
            raise ValueError("Media data is not valid base64") from None
        if not first_chunk or len(first_chunk) > 25_000_000:
            raise ValueError("Media data is empty or exceeds 25 MB")
        if not _matches_media_signature(mime_type, first_chunk):
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
                        chunk = source_str[offset:end]
                        try:
                            if end < body_end and "=" in chunk:
                                raise base64.binascii.Error("Excess data after padding")
                            piece = base64.b64decode(chunk, validate=True)
                        except (ValueError, base64.binascii.Error):
                            raise ValueError("Media data is not valid base64") from None
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

    def _media_download_directory(self) -> Path:
        directory = Path(self.settings.get("newNoteLocation") or QStandardPaths.writableLocation(QStandardPaths.StandardLocation.DownloadLocation) or str(Path.home())).expanduser()
        if not directory.is_dir():
            raise ValueError("The media download folder is unavailable")
        return directory

    def _save_media_native(self, args):
        return Studio._validate_and_write_media(args, self._media_download_directory())

    def _prepare_replace_tab_asset(self, args):
        tab_id = args.get("tabId")
        tab = next((item for item in self.tabs if item["id"] == tab_id), None)
        if not tab or tab_id != self.active:
            raise ValueError("Asset replacement requires the target tab to be active")
        saving = getattr(self, "saving", None)
        if saving is not None and tab_id in saving:
            raise ValueError("A save is already in progress for this tab; retry after it finishes")
        content_snapshot = tab["content"]
        current = hashlib.sha256(content_snapshot.encode("utf-8")).hexdigest()
        if args.get("expectedRevision") != current:
            raise ValueError("Live tab revision changed; inspect it again before replacing an asset")
        path = Path(tab.get("path") or "")
        if not tab.get("portable") or path.suffix.lower() != ".smd" or not path.is_file():
            raise ValueError("Asset replacement requires a saved portable .smd note")
        saved_snapshot = tab["saved"]
        if Studio._is_dirty(self, tab):
            raise ValueError("Save the note before replacing a portable asset")
        asset_id, asset_path_value = args.get("assetName"), args.get("assetPath")
        assets_snapshot = dict(tab.get("assets", {}))
        saved_assets_snapshot = dict(tab.get("saved_assets", assets_snapshot))
        asset_name = asset_id if asset_id in assets_snapshot else next((name for name in assets_snapshot
            if hashlib.sha256(name.encode("utf-8")).hexdigest() == asset_id), None)
        if not asset_name:
            raise ValueError("Asset ID is not present in the current note")
        candidate = _validate_local_tab_asset_path(
            asset_path_value,
            path,
            Studio._extra_asset_roots(self),
            unavailable_message="Replacement asset file is unavailable",
            outside_message="Replacement asset must be inside the current note folder or a configured folder",
        )
        if candidate.stat().st_size > MAX_IMAGE:
            raise ValueError("Replacement asset exceeds 25 MB")
        extension = candidate.suffix.lower().lstrip(".")
        mime = MIMES.get(extension)
        expected_mime = MIMES.get(asset_name.rsplit(".", 1)[-1].lower())
        if not mime or mime != expected_mime:
            raise ValueError("Replacement asset must keep the existing MIME type and extension")

        def work():
            raw = candidate.read_bytes()
            if len(raw) > MAX_IMAGE:
                raise ValueError("Replacement asset exceeds 25 MB")
            if not _matches_media_signature(mime, raw):
                raise ValueError("Replacement asset bytes do not match the current MIME type")
            old_mime, old_data = image_data(assets_snapshot[asset_name])
            if old_mime != mime:
                raise ValueError("Stored asset MIME type does not match its extension")
            if old_data == raw:
                return {"changed": False, "result": {"tabId": tab_id, "assetName": asset_name, "asset": asset_name,
                                                     "assetId": asset_name, "revision": current, "changed": False,
                                                     "saved": False}}
            updated = dict(assets_snapshot)
            updated[asset_name] = f"data:{mime};base64," + encode_base64_chunked(raw)
            disk_content, disk_assets, disk_portable = open_note(path)
            if not disk_portable or disk_content != saved_snapshot or disk_assets != saved_assets_snapshot:
                raise ValueError("The portable note changed on disk; reopen it before replacing an asset")
            # The text revision is checked above; writing the existing open SMD is
            # atomic and preserves every other asset and the exact Markdown string.
            write_portable(path, content_snapshot, updated)
            try:
                st = path.stat()
                stamp = (st.st_mtime_ns, st.st_size)
            except OSError:
                stamp = None
            return {"changed": True, "updated": updated, "stamp": stamp,
                    "result": {"tabId": tab_id, "assetName": asset_name, "asset": asset_name, "assetId": asset_name,
                               "revision": current, "changed": True, "saved": True, "bytes": len(raw),
                               "mimeType": mime}}

        def finalize(value, error):
            if error is not None:
                return None
            if value["changed"]:
                Studio._apply_saved_tab_assets(
                    self, tab_id, path, content_snapshot, assets_snapshot, value["updated"], value.get("stamp")
                )
            return value["result"]

        return tab_id, work, finalize, lambda: None

    def _replace_tab_asset_native(self, args):
        return Studio._run_prepared_write_sync(self, Studio._prepare_replace_tab_asset(self, args))

    def _agent_viewport_pending(self, request_id, tab_id):
        bridge = getattr(self.session, "agent_bridge", None)
        return bool(bridge and bridge.has_pending(request_id, self.window_id, "render_tab", tab_id))

    def _agent_viewport_revision(self, tab_id):
        if self.retired or self.active != tab_id:
            raise ValueError("The target tab is no longer active; refresh the live tab list")
        tab = next((item for item in self.tabs if item["id"] == tab_id), None)
        if tab is None:
            raise ValueError("The requested live tab is no longer open")
        return hashlib.sha256(tab["content"].encode("utf-8")).hexdigest()

    def _begin_agent_viewport_capture(self, request_id, args):
        if not isinstance(args, dict) or args.get("requestId") != request_id:
            raise ValueError("Viewport capture request is invalid")
        tab_id, revision, context = args.get("tabId"), args.get("revision"), args.get("context")
        if not isinstance(tab_id, str) or not isinstance(revision, str) or len(revision) != 64:
            raise ValueError("Viewport capture is missing its live tab revision")
        if not isinstance(context, dict) or context.get("revision") != revision:
            raise ValueError("Viewport context revision does not match the request")
        if not self._agent_viewport_pending(request_id, tab_id):
            return
        if self._agent_viewport_revision(tab_id) != revision:
            raise ValueError("The live tab changed before its viewport was captured")
        if self.host_window is not None and not self.host_window.isVisible():
            self._capture_background_preview(request_id,tab_id,revision,context,args)
            return
        bounds = context.get("viewport")
        if not isinstance(bounds, dict):
            raise ValueError("Reader viewport bounds are unavailable")
        try:
            rect = {key: float(bounds[key]) for key in ("x", "y", "width", "height", "viewportWidth", "viewportHeight")}
        except (KeyError, TypeError, ValueError) as error:
            raise ValueError("Reader viewport bounds are invalid") from error
        if any(not math.isfinite(value) for value in rect.values()) or rect["width"] <= 0 or rect["height"] <= 0 or rect["viewportWidth"] <= 0 or rect["viewportHeight"] <= 0:
            raise ValueError("Reader viewport bounds are invalid")
        if rect["x"] < 0 or rect["y"] < 0 or rect["x"] + rect["width"] > rect["viewportWidth"] + 1 or rect["y"] + rect["height"] > rect["viewportHeight"] + 1:
            raise ValueError("Reader viewport bounds are outside the visible page")
        width = args.get("width", 1600)
        if not isinstance(width, int) or isinstance(width, bool) or not 64 <= width <= 1600:
            raise ValueError("Viewport width must be between 64 and 1,600 pixels")
        image_format = args.get("imageFormat", "png")
        if image_format not in ("png", "jpeg"):
            raise ValueError("Viewport imageFormat must be png or jpeg")
        if self._agent_viewport_capture is not None:
            raise ValueError("Another viewport capture is already in progress")
        window = self.host_window
        if window is None:
            raise ValueError("The desktop reader window is unavailable")
        pending = {"requestId": request_id, "tabId": tab_id, "revision": revision,
                   "context": context, "bounds": rect, "width": width,
                   "imageFormat": image_format, "window": window}
        self._agent_viewport_capture = pending
        try:
            window.frameSwapped.connect(self._agent_viewport_frame_swapped, Qt.ConnectionType.QueuedConnection)
        except (AttributeError, RuntimeError, TypeError):
            pass
        window.update()
        # Some software Qt backends do not emit frameSwapped for an unchanged
        # exposed window. Try a bounded capture after 200 ms in that case.
        QTimer.singleShot(200, lambda rid=request_id: self._agent_viewport_fallback(rid))

    def _capture_background_preview(self, request_id, tab_id, revision, context, args):
        from offline_view import render_live_snapshot
        tab=next(t for t in self.tabs if t["id"]==tab_id)
        content,assets,path=tab["content"],dict(tab.get("assets",{})),tab.get("path","")
        width=max(320,min(1600,int(args.get("width",1200))))
        heading=context.get("reading",{}).get("heading") or None
        view={"dark":self._dark(),"colors":self._colors(),"font":self.settings["font"],"size":self.settings["size"],"svgAppearance":self.settings["svgAppearance"],"lineHeight":self.settings["lineHeight"]}
        def done(body,error):
            bridge=getattr(self.session,"agent_bridge",None)
            if bridge is None:return
            if error:bridge.complete(request_id,None,str(error),window_id=self.window_id);return
            if self._agent_viewport_revision(tab_id)!=revision:
                bridge.complete(request_id,None,"The note changed during background preview; retry",window_id=self.window_id);return
            image=QImage.fromData(body,"PNG")
            mime="image/jpeg" if args.get("imageFormat")=="jpeg" else "image/png"
            encoded=QByteArray();buffer=QBuffer(encoded);buffer.open(QIODevice.OpenModeFlag.WriteOnly);image.save(buffer,"JPEG" if mime=="image/jpeg" else "PNG")
            bridge.complete(request_id,{"tabId":tab_id,"revision":revision,"mime_type":mime,"data":base64.b64encode(bytes(encoded)).decode(),"width":image.width(),"height":image.height(),"context":context,"renderedFrom":"background-preview"},window_id=self.window_id)
        self._submit(lambda:render_live_snapshot(content,assets,path,width=width,heading=heading,view=view),done,False)

    def _clear_agent_viewport_capture(self, pending):
        if self._agent_viewport_capture is not pending:
            return
        self._agent_viewport_capture = None
        try:
            pending["window"].frameSwapped.disconnect(self._agent_viewport_frame_swapped)
        except (AttributeError, RuntimeError, TypeError):
            pass

    def _agent_viewport_fallback(self, request_id):
        pending = self._agent_viewport_capture
        if pending is not None and pending["requestId"] == request_id:
            self._capture_agent_viewport(pending)

    @Slot()
    def _agent_viewport_frame_swapped(self):
        pending = self._agent_viewport_capture
        if pending is not None:
            self._capture_agent_viewport(pending)

    def _capture_agent_viewport(self, pending):
        if self._agent_viewport_capture is not pending:
            return
        bridge = getattr(self.session, "agent_bridge", None)
        request_id, tab_id, revision = pending["requestId"], pending["tabId"], pending["revision"]
        if bridge is None or not self._agent_viewport_pending(request_id, tab_id):
            self._clear_agent_viewport_capture(pending)
            return
        try:
            if self._agent_viewport_revision(tab_id) != revision:
                raise ValueError("The live tab changed before its viewport was captured")
            window = pending["window"]
            reader = window.property("reader")
            if reader is None:
                reader = window.findChild(QObject, "documentReader")
            if reader is None or not callable(getattr(reader, "mapToScene", None)):
                raise ValueError("The desktop WebEngine view is unavailable")
            bounds = pending["bounds"]
            view_width, view_height = float(reader.width()), float(reader.height())
            if view_width <= 0 or view_height <= 0:
                raise ValueError("The desktop WebEngine view has no visible area")
            scale_x, scale_y = view_width / bounds["viewportWidth"], view_height / bounds["viewportHeight"]
            top_left = reader.mapToScene(QPointF(bounds["x"] * scale_x, bounds["y"] * scale_y))
            bottom_right = reader.mapToScene(QPointF((bounds["x"] + bounds["width"]) * scale_x,
                                                      (bounds["y"] + bounds["height"]) * scale_y))
            image = window.grabWindow()
            if image is None or image.isNull():
                raise ValueError("The desktop reader frame could not be captured")
            pixel_scale_x = image.width() / max(1.0, float(window.width()))
            pixel_scale_y = image.height() / max(1.0, float(window.height()))
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
            if self._agent_viewport_revision(tab_id) != revision:
                raise ValueError("The live tab changed while its viewport was being captured")
            if not bridge.has_pending(request_id, self.window_id, "render_tab", tab_id):
                self._clear_agent_viewport_capture(pending)
                return
            array = QByteArray()
            buffer = QBuffer(array)
            image_format = pending.get("imageFormat", "png")
            image_encoder = "JPEG" if image_format == "jpeg" else "PNG"
            saved = (crop.save(buffer, image_encoder, 90) if image_format == "jpeg"
                     else crop.save(buffer, image_encoder)) if buffer.open(QIODevice.OpenModeFlag.WriteOnly) else False
            if not saved:
                raise ValueError(f"Could not encode the live viewport as {image_encoder}")
            result = dict(pending["context"])
            mime_type = "image/jpeg" if image_format == "jpeg" else "image/png"
            result.update({"mime_type": mime_type, "data": base64.b64encode(bytes(array)).decode("ascii"),
                           "width": crop.width(), "height": crop.height(), "revision": revision,
                           "tabId": tab_id, "windowId": self.window_id})
            self._clear_agent_viewport_capture(pending)
            bridge.complete(request_id, result, window_id=self.window_id)
        except Exception as error:
            self._clear_agent_viewport_capture(pending)
            bridge.complete(request_id, None, str(error)[:1000], window_id=self.window_id)

    @Slot(str, str, str)
    def post(self, id, command, raw):
        self._post(id, command, raw)

    def _post(self, id, command, raw):
        if self.retired:return
        python_job = None
        try:
            if command == "save_media_native":
                if not isinstance(raw, str) or len(raw) > 36_100_000:
                    raise ValueError("Media data is invalid or exceeds 25 MB")
                directory = self._media_download_directory()
                def media_work():
                    parsed, source_str, body_start, body_end = Studio._parse_media_envelope(raw)
                    return Studio._validate_and_write_media(
                        parsed, directory, source_str=source_str, body_start=body_start, body_end=body_end
                    )
                def media_done(result, error):
                    if error:
                        self.replied.emit(id, "null", error)
                    else:
                        self.replied.emit(id, json.dumps(result), "")
                self._submit_write(media_work, media_done)
                return
            args = json.loads(raw)
            if command == "agent_result":
                bridge = getattr(self.session, "agent_bridge", None)
                if bridge is not None:
                    result = args.get("result")
                    error = args.get("error", "")
                    if error and not isinstance(error, str):
                        error = "Live tab operation failed"
                    bridge.complete(id, result, error or "", window_id=self.window_id)
                return
            if command == "agent_render_bounds":
                bridge = getattr(self.session, "agent_bridge", None)
                tab_id = args.get("tabId", "")
                if bridge is None or not bridge.has_pending(id, self.window_id, "render_tab", tab_id):
                    return
                if args.get("error"):
                    bridge.complete(id, None, str(args["error"])[:1000], window_id=self.window_id)
                    return
                try:
                    self._begin_agent_viewport_capture(id, args)
                except Exception as error:
                    bridge.complete(id, None, str(error)[:1000], window_id=self.window_id)
                return
            if command == "agent_export_native":
                self._agent_export_native(id, args)
                return
            agent_export_info = self._agent_exports.get(id)
            if command == "cancel_export":
                job_id = args.get("jobId")
                if not isinstance(job_id, str) or not job_id or len(job_id) > 128:
                    raise ValueError("Invalid PDF export job id")
                self.replied.emit(id, json.dumps({"cancelled": self._export_jobs.cancel(job_id)}), "")
                return
            tab = self._current()
            if command == "reader_ready": self.ready = True; self._last_reader_text=None; self._emit(); self.replied.emit(id,"true",""); return
            if command == "reader_chrome":
                action = args.get("action")
                if action not in ("show", "hide", "toggle"): raise ValueError("Invalid reading chrome action")
                if self.fullscreen: self.chromeRequested.emit(action)
                self.replied.emit(id,"true",""); return
            if command == "reader_overlay_changed": self.reader_overlay = bool(args.get("open")); self.image_overlay = bool(args.get("image")); self._emit(False); self.replied.emit(id,"true",""); return
            if command == "editor_focus_changed": self.replied.emit(id,"true",""); return
            if command == "typewriter_scroll":
                enabled = args.get("enabled")
                if not isinstance(enabled, bool): raise ValueError("Invalid typewriter scroll value")
                if self.settings["typewriterScroll"] != enabled:
                    self.settings["typewriterScroll"] = enabled
                    self._preferences()
                    self._emit()
                self.replied.emit(id, "true", ""); return
            if command == "copy_image_native":
                body = args.get("body")
                if args.get("mimeType") != "image/png" or not isinstance(body, str) or len(body) > 34_000_000:
                    raise ValueError("Clipboard image must be a PNG under 25 MB")
                try:
                    data = base64.b64decode(body, validate=True)
                except (ValueError, base64.binascii.Error):
                    raise ValueError("Clipboard image is not valid base64") from None
                if not data.startswith(b"\x89PNG\r\n\x1a\n") or len(data) < 24 or len(data) > 25_000_000:
                    raise ValueError("Clipboard image is not a valid PNG")
                width, height = int.from_bytes(data[16:20], "big"), int.from_bytes(data[20:24], "big")
                if not 0 < width <= 4096 or not 0 < height <= 4096 or width * height > 16_000_000:
                    raise ValueError("Clipboard image dimensions exceed the limit")
                image = QImage.fromData(data, "PNG")
                if image.isNull(): raise ValueError("Clipboard PNG could not be decoded")
                QGuiApplication.clipboard().setImage(image)
                self.replied.emit(id, "true", ""); return
            if command == "copy_text":
                text=args.get("text")
                if not isinstance(text,str) or len(text)>2_000_000:raise ValueError("Clipboard text is too large or invalid")
                QGuiApplication.clipboard().setText(text);self.replied.emit(id,"true","");return
            if command == "apply_bundled_theme":
                preset_id=args.get("id")
                if not isinstance(preset_id,str) or not preset_id:
                    raise ValueError("Invalid bundled theme id")
                self._apply_bundled_theme(preset_id,lambda result,error:self.replied.emit(id,json.dumps(result) if not error else "null",error or ""))
                return
            if command == "reading_position":
                target=next((t for t in self.tabs if t["id"]==args.get("id")),None);location=args.get("location")
                if target and target["path"] and self.settings["restorePosition"] and isinstance(location,dict):
                    if any(isinstance(location.get(key),bool) or not isinstance(location.get(key),(int,float)) or not math.isfinite(location[key]) or location[key]<0 for key in ("top","offset","zoom")):raise ValueError("Invalid reading position")
                    if location.get("mode") not in ("reader","live","editor","split"):raise ValueError("Invalid reading mode")
                    self.session.locations.pop(target["path"],None);self.session.locations[target["path"]]={key:location[key] for key in ("top","offset","zoom","mode")}
                    while len(self.session.locations)>200:self.session.locations.pop(next(iter(self.session.locations)))
                    self.position_timer.start(500)
                self.replied.emit(id,"true","");return
            if command == "document_outline":
                target = next((t for t in self.tabs if t["id"] == args.get("id")), None)
                headings = args.get("headings", [])
                if not isinstance(headings, list) or len(headings) > 2000: raise ValueError("Invalid outline")
                changed=bool(target and target.get("outline",[])!=headings)
                name_changed=False
                if target:
                    if changed:
                        target["outline"] = headings
                        self._outline_revision = getattr(self, "_outline_revision", 0) + 1
                    if not target["path"] and target["name"].startswith("Untitled") and headings:
                        title = str(headings[0].get("title", "")).strip()
                        title = "".join(c for c in title if c not in '/\\:*?"<>|' and ord(c) >= 32).strip(". ")[:120]
                        if title:
                            new_name = title + (".smd" if target["portable"] else ".md")
                            name_changed = new_name != target["name"]
                            target["name"] = new_name
                if changed or name_changed:self._emit(False)
                self.replied.emit(id,"true",""); return
            if command == "document_flushed":
                operation = args.get("operation")
                if operation != self.flush_operation or operation is None:
                    self.replied.emit(id,"true",""); return
                target = next((t for t in self.tabs if t["id"] == args["id"]),None)
                if target: target["content"] = args["content"]
                if operation["action"] in ("move_tab", "detach_tab", "reload_reader"):
                    view_tab = next((t for t in self.tabs if t["id"] == args.get("viewId")), None)
                    view = args.get("viewState")
                    if view_tab and isinstance(view, dict) and len(json.dumps(view)) <= 12_000_000: view_tab["viewState"] = view
                self.flush_timer.stop()
                self.flush_operation = None
                self._recover()
                self._after_flush(operation)
                self.replied.emit(id,"true",""); return
            if command in ("document_sync", "document_patch", "document_resync"):
                target = next((t for t in self.tabs if t["id"] == args.get("id")), None)
                def commit_edit(content):
                    was_dirty=target["content"]!=target["saved"]
                    target["content"] = content
                    if target["id"] == self.active:self._last_reader_text=(target["id"],content)
                    self.recovery_timer.start(800)
                    self.autosave_timer.start(900)
                    if was_dirty != (content!=target["saved"]):self._emit(False)
                result=self.reader_edits.apply(command,args,target["content"] if target else None,commit_edit)
                if command == "document_resync" and not result["accepted"] and isinstance(args.get("content"),str):
                    draft=args["content"]
                    destination=self.data/"reader-conflicts"/(uuid.uuid4().hex+".json")
                    payload={"id":args.get("id"),"content":draft,"reason":"Native and renderer revisions diverged"}
                    def preserve_done(_value,error):
                        self.message="Conflicting editor draft preserved for recovery." if not error else "Could not preserve the conflicting draft; keep the editor open. "+str(error)
                        self._emit(False)
                        self.replied.emit(id,json.dumps({**result,"draftSaved":not bool(error)}),"")
                    self._submit(lambda:atomic_json(destination,payload),preserve_done,False)
                    return
                self.replied.emit(id,json.dumps(result),"");return
            if command == "document_changed":
                target = next((t for t in self.tabs if t["id"] == args["id"]), None)
                self.reader_edits.clear(args["id"])
                if target: target["content"] = args["content"]
                if target and target["id"]==self.active:self._last_reader_text=(target["id"],target["content"])
                self.recovery_timer.start(800)
                self.autosave_timer.start(900)
                self._emit(False)
                self.replied.emit(id,"true",""); return
            if command == "resolve_reader_asset":
                document = args.get("documentPath")
                source = args.get("source")
                if not isinstance(document, str) or not isinstance(source, str):
                    raise ValueError("Invalid reader asset request")
                tab = self._find_open_tab(document)
                if tab is None:
                    raise ValueError("The note for this image is no longer open")
                captured = dict(tab)
                captured["assets"] = dict(tab["assets"])
                owner_id, tab_id = self.window_id, tab["id"]
                embedded = captured["assets"].get(source)
                cached = self.session.reader_assets.resolve_cached(owner_id, tab_id, source, embedded) if embedded is not None else None
                def work():
                    return cached if cached is not None else resolve_source(captured, source)
                def finished(resolved, error):
                    current = next((item for item in self.tabs if item["id"] == tab_id), None)
                    if error:
                        self.replied.emit(id, "null", error)
                    elif current is None or not self.session.reader_asset_source_is_current(
                            owner_id, tab_id, source, _asset_identity(resolved.get("embedded_data")) if resolved.get("embedded_data") else 0,
                            resolved.get("path", "")):
                        self.session.reader_assets.evict_source(owner_id, tab_id, source)
                        self.replied.emit(id, "null", "The note or image changed while it was being resolved")
                    else:
                        try:
                            url = self.session.reader_assets.register(owner_id, tab_id, source, resolved)
                            self.replied.emit(id, json.dumps({"url": url, "mime": resolved["mime"]}), "")
                        except Exception as failure:
                            self.replied.emit(id, "null", str(failure))
                self._submit(work, finished, False)
                return
            if command == "zoom_changed":
                self.settings["fullZoom" if args.get("fullscreen", self.fullscreen) else "normalZoom"] = max(40,min(300,args["zoom"]))
                self.preference_timer.start(500)
                self._emit(False); self.replied.emit(id,"true",""); return
            if command == "open_external_url":
                url = args.get("url")
                if not isinstance(url, str) or len(url) > 4096:
                    raise ValueError("Invalid external URL")
                parsed = urllib.parse.urlparse(url)
                if parsed.scheme.lower() not in ("http", "https", "mailto"):
                    raise ValueError("Unsupported external URL scheme")
                QDesktopServices.openUrl(QUrl(url))
                self.replied.emit(id, "true", "")
                return
            if command in ("open_workspace_link", "open_relative_note"):
                raw_target = args.get("target")
                raw_fragment = args.get("fragment")
                if not raw_fragment:
                    raw_fragment = args.get("heading", "")
                if raw_fragment is None:
                    raw_fragment = ""
                wikilink = bool(args.get("wikilink", False)) if command == "open_workspace_link" else False
                doc_ref = args.get("documentPath", "")
                if (not isinstance(raw_target, str) or len(raw_target) > 4096
                        or not isinstance(raw_fragment, str) or len(raw_fragment) > 1024):
                    raise ValueError("Invalid workspace link")
                source_tab = self._find_open_tab(doc_ref, canonicalize_local=True) if doc_ref else self._current()
                if source_tab is None:
                    raise ValueError("The note for this link is no longer open.")
                note_path = source_tab["path"]
                folder = self.folder
                if self.recovery_timer.isActive():
                    self.recovery_timer.stop()
                self._recover()
                if self.autosave_timer.isActive() or (
                    self.settings.get("autosave") and note_path and self._is_dirty(source_tab)
                ):
                    self.autosave_timer.stop()
                    self._autosave()
                self._activation_generation += 1
                link_generation = self._activation_generation
                def resolve_work():
                    return resolve_workspace_link(
                        raw_target,
                        wikilink=wikilink,
                        note_path=note_path,
                        workspace_folder=folder,
                        cache=self.session.workspace_links,
                    )
                def resolve_done(resolved_path, error):
                    if self.retired:
                        self.replied.emit(id, json.dumps({"opened": False}), "")
                        return
                    if error:
                        self.message = str(error)
                        self._emit(False)
                        self.replied.emit(id, json.dumps({"opened": False, "message": str(error)}), "")
                        return
                    fragment = raw_fragment.strip()
                    heading_payload = {"heading": fragment, "token": uuid.uuid4().hex} if fragment else None
                    def opened(opened_tab, open_error):
                        if open_error or opened_tab is None:
                            if open_error:
                                self.message = str(open_error)
                                self._emit(False)
                            self.replied.emit(
                                id,
                                json.dumps({"opened": False, "message": str(open_error or "Could not open note")}),
                                "",
                            )
                            return
                        self.replied.emit(
                            id,
                            json.dumps({"opened": True, "id": opened_tab["id"], "path": opened_tab["path"]}),
                            "",
                        )
                    self._open_note(
                        str(resolved_path),
                        explicit=True,
                        activation_generation=link_generation,
                        completion_callback=opened,
                        pending_heading=heading_payload,
                    )
                self._submit(resolve_work, resolve_done, False)
                return
            if command == "export_failed": self.pending_export = self.pending_save_as = self.pending_save_as_tab = ""; self.message = args["error"]; self._emit(False); self.replied.emit(id,"true",""); return
            if command == "request_fmd_export": self.exportRequested.emit("smd"); self.replied.emit(id,"true",""); return
            context=args.get("context")
            if context is not None:
                if not isinstance(context,dict) or set(context)!={"document","cell","interpreter"}:raise ValueError("Invalid Python output context")
                if context["interpreter"] != (self.settings["python"] or "embedded"):raise ValueError("Python runtime changed; retry this operation")
            reference = args.get("id") or args.get("documentPath") or (context.get("document") if context else None)
            if reference:
                tab = self._find_open_tab(reference)
                if tab is None: raise ValueError("The note for this operation is no longer open")
            if context and context["document"] not in (tab["id"],tab["path"]):raise ValueError("Python output belongs to another note")
            captured = dict(tab)
            captured["assets"] = dict(tab["assets"])
            captured["saved_assets"] = dict(tab.get("saved_assets", {}))
            output = self.pending_export
            save_as = self.pending_save_as
            save_as_tab = self.pending_save_as_tab
            force_portable_overwrite = bool(command == "export_fmd_native" and args.get("save") and captured["id"] in self._force_overwrite_ids)
            if command == "export_fmd_native" and args.get("save"):
                self._force_overwrite_ids.discard(captured["id"])
            # Preparation is asynchronous. Recheck the actual writer, not just
            # the dialog choice, so a stale/cross-format callback cannot put
            # PDF bytes in an SMD file (or overwrite a portable note with text).
            expected_suffixes = {
                "export_pdf_native": (".pdf",),
                "export_markdown_native": (".md", ".markdown", ".txt", ".zip"),
                "export_fmd_native": (".smd",),
            }
            if command in expected_suffixes and not (command == "export_fmd_native" and args.get("save")):
                if not output or Path(output).suffix.casefold() not in expected_suffixes[command]:
                    raise ValueError("The export destination does not match the requested file format; choose the destination again")
            saving_tab_id = (save_as_tab or captured["id"]) if (command == "export_fmd_native" and save_as) else captured["id"]
            is_portable_tab_save = command == "export_fmd_native" and not agent_export_info and bool(args.get("save") or save_as)
            if is_portable_tab_save:
                if saving_tab_id in self.saving:
                    raise ValueError("A save is already in progress for this tab; retry after it finishes")
                self.saving.add(saving_tab_id)
            python = self.settings["python"]
            export_job = None
            python_job = None
            if command == "export_pdf_native":
                if not output: raise ValueError("Choose a PDF destination before exporting")
                job_id = args.get("jobId")
                if job_id is None: job_id = uuid.uuid4().hex
                export_job = self._export_jobs.register(job_id)
            elif command == "run_python":
                if self.retired or captured["id"] in self._closing_tabs:
                    raise ValueError("The note for this operation is no longer open")
                python_job = self._python_jobs.register(captured["id"])
            def export_result(path):
                if agent_export_info:
                    return self._agent_export_metadata(Path(path), agent_export_info["format"])
                return {"path": str(path)}
            def work():
                if command == "load_asset": return self._asset(captured,args["source"])
                if command == "load_text_asset": return {"text": self._text_asset(captured,args["source"])}
                if command == "load_font": return self.session.font_store.reader(args["family"])
                if command == "cache_python_output":
                    if context and args["result"].get("provenance",{}).get("verified") is False:raise ValueError("Legacy output cannot be promoted to verified output")
                    if context and not pending_python.matches(args["source"],args["result"],context):raise ValueError("Only an unsaved native execution can be retried")
                    self.session.python_outputs.store(args["source"],args["result"],context)
                    if context:pending_python.forget(args["source"],context)
                    return True
                if command == "load_python_output":
                    value=self.session.python_outputs.load(args["source"],context)
                    return {**value["result"],"provenance":value["provenance"]} if context and value else value
                if command == "fetch_resource": return self._fetch(args)
                if command == "import_images":
                    results = []
                    for image in args["images"]:
                        mime, _ = image_data(image["data"])
                        extension = next(k for k,v in MIMES.items() if v == mime)
                        name = f"assets/import-{uuid.uuid4().hex}.{extension}"
                        captured["assets"][name] = image["data"]
                        results.append({"source":name,"alt":Path(image["name"]).stem})
                    return results
                if command == "run_python":
                    assert python_job is not None
                    try:
                        result=self._python(python,args["code"],str(Path(captured["path"]).parent) if captured.get("path") else None,job=python_job)
                    except python_runtime.PythonCellCancelled:
                        return {"_cancelled": True}
                    finally:
                        self._python_jobs.discard(python_job)
                    if python_job.cancelled.is_set():
                        return {"_cancelled": True}
                    if context:
                        try:
                            self.session.python_outputs.store(args["code"],result,context)
                            pending_python.forget(args["code"],context)
                            saved=self.session.python_outputs.load(args["code"],context)
                            return {**result,"provenance":saved["provenance"]}
                        except (OSError,ValueError) as error:
                            # Successful execution is still useful if derived-cache I/O fails.
                            pending_python.remember(args["code"],result,context)
                            return {**result,"provenance":{"verified":False,"unsaved":True,"reason":f"Could not save execution output: {error}"}}
                    return result
                if command == "export_markdown_native":
                    return studio_exports.execute_export_markdown_native(output, args, captured, export_result)
                if command == "export_fmd_native" and not args.get("save") and not save_as:
                    return studio_exports.execute_export_smd_native(output, args, export_result)
                if command == "export_fmd_native":
                    target_path = Path(captured["path"]) if args.get("save") else Path(output)
                    if args.get("save") and not force_portable_overwrite and target_path.exists():
                        try:
                            disk_content, disk_assets, _ = open_note(target_path, decode_assets=False)
                            if disk_content != captured["saved"] or disk_assets != captured.get("saved_assets", {}):
                                return {"_conflict": True}
                        except Exception:
                            return {"_conflict": True}
                    write_portable(target_path,args["content"],args["assets"],validated_assets=captured.get("saved_assets") if args.get("save") else None)
                    result_data = export_result(target_path)
                    try:
                        st = target_path.stat()
                        result_data["_stamp"] = (st.st_mtime_ns, st.st_size)
                    except OSError:
                        pass
                    return result_data
                if command == "export_pdf_native":
                    return studio_exports.execute_export_pdf_native(self, output, args, export_job, export_result)
                raise ValueError(f"Unsupported command: {command}")
            def finished(result,error):
                if is_portable_tab_save:
                    self.saving.discard(saving_tab_id)
                if command.startswith("export_") and self.pending_export == output: self.pending_export = ""
                if error and self.pending_save_as == save_as:
                    self.pending_save_as = ""
                    self.pending_save_as_tab = ""
                if error:
                    if agent_export_info:
                        studio_exports.fail_agent_export(self, id, agent_export_info, error)
                    if not agent_export_info:
                        self.replied.emit(id,"null",error)
                    return
                if command == "run_python" and isinstance(result, dict) and result.get("_cancelled"):
                    self.replied.emit(id, "null", "Python cell cancelled")
                    return
                if command == "export_fmd_native" and isinstance(result, dict) and result.get("_conflict"):
                    target_tab = next((t for t in self.tabs if t["id"] == captured["id"]), None)
                    if target_tab:
                        target_tab["conflict"] = True
                        self.message = "This file changed on disk since you opened or last saved it."
                        self._emit(False)
                        self.saveConflictRequested.emit(target_tab["name"])
                    self.replied.emit(id, json.dumps({"saved": False, "conflict": True}), "")
                    return
                stamp = result.pop("_stamp", None) if isinstance(result, dict) else None
                if stamp and isinstance(result, dict) and result.get("path"):
                    self.note_file_stamps[str(result["path"])] = stamp
                target = next((t for t in self.tabs if t["id"] == captured["id"]),None)
                if command == "import_images" and target:
                    target["assets"].update(captured["assets"])
                    target["assets_dirty"] = True
                    self.recovery_timer.start(800)
                    self.autosave_timer.start(900)
                    self._emit(False)
                if command == "export_fmd_native" and args.get("save") and target:
                    old_assets = target.get("assets", {})
                    if old_assets != args["assets"]:
                        self.session.reader_assets.revoke_tab(self.window_id, target["id"])
                    merged_assets = _preserve_unchanged_assets(old_assets, args["assets"])
                    target.update(
                        saved=args["originalContent"],
                        assets=merged_assets,
                        saved_assets=dict(merged_assets),
                        assets_dirty=False,
                        conflict=False,
                    )
                    if target["content"] == args["originalContent"]: target["content"] = target["saved"] = args["content"]
                    self.message = "Saved"
                    self._recover()
                    self._emit()
                    if self.pending_close: self._finish_close()
                elif command == "export_fmd_native" and save_as:
                    save_target = next((t for t in self.tabs if t["id"] == (save_as_tab or captured["id"])), target)
                    if save_target:
                        old_assets = save_target.get("assets", {})
                        path_changed = save_target.get("path") != save_as
                        if old_assets != args["assets"] or path_changed:
                            self.session.reader_assets.revoke_tab(self.window_id, save_target["id"])
                        merged_assets = args["assets"] if path_changed else _preserve_unchanged_assets(old_assets, args["assets"])
                        new_content = args["content"] if save_target["content"] == args.get("originalContent", save_target["content"]) else save_target["content"]
                        save_target.update(
                            path=save_as,
                            name=Path(save_as).name,
                            content=new_content,
                            saved=args["content"],
                            assets=merged_assets,
                            saved_assets=dict(merged_assets),
                            assets_dirty=False,
                            portable=True,
                            conflict=False,
                        )
                        try:
                            self._agent_open_paths.add(str(Path(save_as).resolve()))
                        except OSError:
                            pass
                        if path_changed:
                            self.session.workspace_links.invalidate(Path(save_as).parent)
                        self.recent = [save_as] + [p for p in self.recent if p != save_as][:29]
                        self._preferences()
                        self.message = "Saved"
                        self._recover()
                        self._emit()
                        if path_changed:
                            self._refresh_open_folder_trees(save_as)
                        if self.pending_close: self._finish_close()
                    self.pending_save_as = ""
                    self.pending_save_as_tab = ""
                elif command.startswith("export_"):
                    studio_exports.finalize_standalone_export(self, result["path"])
                if agent_export_info:
                    studio_exports.complete_agent_export(self, id, agent_export_info, result)
                if not agent_export_info:
                    self.replied.emit(id,json.dumps(result),"")
            if is_portable_tab_save and (self.retired or getattr(self.writes, "_shutdown", False)):
                self.saving.discard(saving_tab_id)
                return
            if python_job is not None and (self.retired or getattr(self.pool, "_shutdown", False)):
                self._python_jobs.discard(python_job)
                return
            self._submit(work,finished,command in ("run_python","export_fmd_native","export_pdf_native","export_markdown_native"),self.writes if command in ("export_fmd_native", "export_markdown_native") else None)
        except Exception as error:
            if python_job is not None:
                self._python_jobs.discard(python_job)
            studio_exports.cleanup_failed_post_agent_export(self, id)
            self.replied.emit(id,"null",str(error))

    @Slot()
    def readerCrashed(self):
        if self.retired:return
        # Native tab text and persisted positions are authoritative. Reloading
        # a renderer must not restore an older recovery snapshot or run cells.
        self.ready=False
        self._last_reader_text=None
        self.reader_overlay=False
        self.image_overlay=False
        self._emit(False)

    def _asset(self, tab, source):
        if source in tab["assets"]: return tab["assets"][source]
        if not tab["path"]: raise ValueError("Save this note to resolve relative images")
        root = Path(tab["path"]).parent.resolve()
        path = (root / urllib.parse.unquote(source)).resolve()
        if not path.is_relative_to(root): raise ValueError("Image is outside the note folder")
        if path.stat().st_size > MAX_IMAGE: raise ValueError("Image exceeds 25 MB")
        mime = MIMES.get(path.suffix[1:].lower())
        if not mime: raise ValueError("Unsupported image type")
        return f"data:{mime};base64,{base64.b64encode(path.read_bytes()).decode()}"

    def _text_asset(self, tab, source):
        if not isinstance(source, str) or len(source) > 4096 or Path(source).suffix.lower() not in (".mmd", ".mermaid"):
            raise ValueError("Only local .mmd or .mermaid source files can be inlined")
        if not tab.get("path"): raise ValueError("Save this note to resolve relative diagram source files")
        root = Path(tab["path"]).parent.resolve()
        relative = urllib.parse.unquote(source.split("#", 1)[0].split("?", 1)[0])
        requested = root / relative
        current = root
        for part in Path(relative).parts:
            current = current / part
            if current.is_symlink(): raise ValueError("Diagram source symlink paths are not allowed")
        path = requested.resolve(strict=True)
        if not path.is_relative_to(root) or not path.is_file(): raise ValueError("Diagram source is outside the note folder")
        if path.stat().st_size > 2_000_000: raise ValueError("Diagram source exceeds 2 MB")
        return path.read_text(encoding="utf-8")

    def _find_open_tab(self, reference, *, canonicalize_local: bool = False):
        if not isinstance(reference, str) or not reference:
            return None
        match = next((item for item in self.tabs if reference in (item["id"], item["path"])), None)
        if match is not None or not canonicalize_local or "\x00" in reference:
            return match
        try:
            if QUrl(reference).isLocalFile() or Path(reference).is_absolute():
                canonical = str(local_path(reference))
                exact = next((item for item in self.tabs if item["path"] == canonical or (item["path"] and folder_ops.same_path(item["path"], canonical))), None)
                if exact is not None:
                    return exact
                return next(
                    (
                        item for item in self.tabs
                        if item["path"] and not Path(item["path"]).is_symlink() and os.path.samefile(item["path"], canonical)
                    ),
                    None,
                )
        except OSError:
            pass
        return None

    def _fetch(self, args):
        url = args["url"]
        self._public_url(url)
        owner = self
        class PublicRedirect(urllib.request.HTTPRedirectHandler):
            def redirect_request(self,request,fp,code,msg,headers,newurl):
                owner._public_url(newurl)
                return super().redirect_request(request,fp,code,msg,headers,newurl)
        # Connect to the exact address that was validated. Resolving again in
        # the socket layer would allow DNS rebinding onto a private network.
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), PinnedHTTPHandler(), PinnedHTTPSHandler(), PublicRedirect())
        request = urllib.request.Request(url,headers={"User-Agent":"SuperMD/Qt"})
        with opener.open(request,timeout=20) as response:
            data = response.read((MAX_IMAGE if args.get("image") else 2_000_000)+1)
            if len(data) > (MAX_IMAGE if args.get("image") else 2_000_000): raise ValueError("Resource is too large")
            if args.get("image"):
                mime = response.headers.get_content_type()
                if mime not in MIMES.values(): raise ValueError("URL did not return a supported image")
                return {"body":f"data:{mime};base64,{base64.b64encode(data).decode()}"}
            return {"body":data.decode("utf-8",errors="replace")}

    @staticmethod
    def _public_url(url):
        return public_address(url)

    def _engine(self):
        executable = "smd-engine.exe" if sys.platform == "win32" else "smd-engine"
        candidates = [ROOT / "desktop" / executable, ROOT / "smd-core" / "target" / "release" / executable, ROOT / "smd-core" / "target" / "debug" / executable]
        for path in candidates:
            if path.is_file(): return path
        raise ValueError("Native PDF engine is not installed. Build smd-core's smd-engine binary.")

    def _python(self, executable, code, folder=None, job=None):
        # Explicit Run only. Python is trusted local code, not a sandbox.
        owned_job = None
        if job is None and hasattr(self, "_python_jobs"):
            owned_job = self._python_jobs.register("")
            job = owned_job
        try:
            return python_runtime.run(executable or self.settings["python"], code, cwd=folder, job=job)
        finally:
            if owned_job is not None:
                self._python_jobs.discard(owned_job)
