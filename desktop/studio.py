"""Native Qt state/file management. Expensive work runs outside the UI thread."""
from __future__ import annotations
import base64
import concurrent.futures
import copy
import http.client
import json
import ipaddress
import math
import mimetypes
import os
import shutil
import socket
import ssl
import subprocess
import sys
import tempfile
import threading
import time
import urllib.parse
import urllib.request
import uuid
from pathlib import Path
from PySide6.QtCore import QObject, Property, Signal, Slot, QStandardPaths, QTimer, QUrl, QFileSystemWatcher, QProcess, Qt, QPointF, QMetaObject
from PySide6.QtGui import QDesktopServices, QFontDatabase, QGuiApplication, QCursor
from documents import atomic_write, atomic_json, bundle, image_data, materialize_assets, open_note, MIMES, MAX_IMAGE
from theme import detect_system_dark, read_system_palette, system_palette_paths, tokens
from fonts import FontStore
from python_outputs import PythonOutputs
from reader_edits import ReaderEdits
from closed_notes import ClosedNoteStore
from reader_assets import ReaderAssetStore, note_file_path, resolve_source
from storage_inspector import inspect_storage
from latest_writes import LatestWriteExecutor
import updates
import app_integration
import python_runtime
import pending_python
from export_jobs import ExportJobRegistry
import file_events
import custom_theme

ROOT = Path(sys._MEIPASS)/"resources" if getattr(sys,"frozen",False) else Path(__file__).resolve().parent.parent
DEFAULT_PDF = {"pageSize": "a4", "margin": 18, "fontSize": 10, "lineHeight": 1.45, "paragraphSpacing": 1.2, "fontFamily": "Manrope", "pageNumbers": True, "themed": False}
DEFAULTS = {"theme": "system", "fullTheme": "black", "motion": True, "font": "Manrope", "size": 18, "width": 0, "widthPercent":90, "lineHeight":1.65, "autosave":True, "normalZoom": 100, "fullZoom": 100, "python": "", "pdf": DEFAULT_PDF, "welcomed": False}
DEFAULTS.update(widthMigrated=True, window={"width":1320,"height":880,"maximized":False}, spellCheck=False, grammarCheck=False, readingMode="live", newNoteLocation="", accent="system", checkUpdates=True, autoUpdate=False)
DEFAULTS.update(restorePosition=True, centerLock=True, startup="restore", imageAppearance="original", svgAppearance="original", imageContrast=1.25, fullDocumentAccessibility=False)
DEFAULTS.update(patternKind="",patternOpacity=-1,patternSize=0,patternSpacing=0)
DEFAULTS.update(desktopIntegration=False)
SAMPLE = """# A place to think\n\nWrite in Markdown. Read without distractions.\n\n> [!tip] Start with your notes\n> Open any note or folder. No vault, no import process.\n\n## Learn by exploring\n\n$$E = mc^2$$\n\n> [!answer]- Why does this matter?\n> Tap the heading to reveal an answer, then hide it to test yourself.\n\n```smd-chart\n{\"title\":\"A changing wave\",\"series\":[{\"name\":\"Sine\",\"expression\":\"sin(a*x)\",\"color\":\"#386a57\"},{\"name\":\"Cosine\",\"expression\":\"cos(a*x)\",\"color\":\"#bc6750\"}],\"sliders\":[{\"name\":\"a\",\"min\":0.2,\"max\":3,\"value\":1}]}\n```\n\n## Matplotlib in three dimensions\n\nRun a Python cell to generate a 3D figure, then save it in your note or PDF.\n\n```python\nimport numpy as np\nimport matplotlib.pyplot as plt\nx, y = np.meshgrid(np.linspace(-2, 2, 32), np.linspace(-2, 2, 32))\nfig = plt.figure()\nax = fig.add_subplot(111, projection=\"3d\")\nax.plot_surface(x, y, x*x + y*y, cmap=\"viridis\")\n```\n\n[Back to exploring](#learn-by-exploring)\n"""

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
        return self.do_open(lambda host, **kwargs: _PinnedHTTPSConnection(host, pinned=pinned, **kwargs), request, context=ssl.create_default_context())

def local_path(value: str) -> Path:
    url = QUrl(value)
    return Path(url.toLocalFile() if url.isLocalFile() else value).expanduser().resolve()

def export_destination(value: str, format: str) -> Path:
    suffixes = {"pdf": ".pdf", "smd": ".smd", "md": ".md"}
    # These are known payload extensions, not merely dotted stem names.  In
    # particular, .fmd is an older portable format and must not be silently
    # rewritten as .fmd.pdf/.fmd.smd.
    payload_formats = {
        ".pdf": "pdf",
        ".smd": "smd",
        ".md": "md",
        ".markdown": "md",
        ".txt": "md",
    }
    if format not in suffixes:
        raise ValueError("Unsupported export format")
    destination = local_path(value)
    if not destination.name or destination.is_dir():
        raise ValueError("Choose a file destination for the export")
    expected = suffixes[format]
    existing_suffix = destination.suffix.casefold()
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

def _same_closed_revision(current: dict, captured: dict) -> bool:
    """Compare content-bearing fields after a background close snapshot."""
    return current == captured

def _asset_identity(value):
    return id(value)

class Session(QObject):
    """One ordered persistence stream for every native window in the application."""
    changed = Signal()
    locationChanged = Signal(str,str)
    def __init__(self,isolated=False):
        super().__init__()
        self.data = Path(tempfile.mkdtemp(prefix="supermd-test-")) if isolated else Path(QStandardPaths.writableLocation(QStandardPaths.AppDataLocation))/"qt-studio"
        self.data=self.data.resolve()
        self.data.mkdir(parents=True,exist_ok=True)
        self.font_store = FontStore(self.data)
        self.python_outputs = PythonOutputs(self.data/"derived-python")
        self.reader_assets = ReaderAssetStore(self.reader_asset_is_current, self.reader_asset_payload)
        self.closed_note_store = ClosedNoteStore(self.data/"closed-notes")
        try:self.closed_tabs = self.closed_note_store.load_index_strict();self.closed_note_error=""
        except (OSError,ValueError,TypeError) as error:self.closed_tabs=[];self.closed_note_error=str(error)
        self.writes = LatestWriteExecutor(max_workers=1,thread_name_prefix="supermd-save")
        self.settings = copy.deepcopy(DEFAULTS)
        self.recent = []
        self.pinned = []
        self.workspace = {}
        self.startup_paths = []
        self.startup_active = ""
        self.startup_entries = []
        self.startup_active_id = ""
        self.quitting = False
        self.locations = {}
        self.drafts = {}
        self.windows = {}
        self.custom_theme = None
        self.theme_epoch = 0
        self.theme_revision = 0
        self.theme_source = ""
        try:self.theme_source=json.loads((self.data/"theme-source.json").read_text(encoding="utf-8")).get("path","")
        except (OSError,ValueError,AttributeError):pass
        self.initial_recovery = []
        try:
            stored = json.loads((self.data/"settings.json").read_text(encoding="utf-8"))
            self.settings.update({k:v for k,v in stored["settings"].items() if k in DEFAULTS})
            if not stored["settings"].get("widthMigrated") and stored["settings"].get("widthPercent") == 80:
                self.settings["widthPercent"] = 90  # 80% was the old default, not a choice.
            self.settings["pdf"] = {**DEFAULT_PDF, **self.settings.get("pdf", {})}
            self.pinned = list(dict.fromkeys(p for p in stored.get("pinned",[]) if isinstance(p,str)))[:10]
            self.recent = list(dict.fromkeys(self.pinned + [p for p in stored.get("recent",[]) if isinstance(p,str)]))[:10]
        except (OSError,ValueError,KeyError,TypeError,AttributeError): pass
        try:
            workspace=json.loads((self.data/"startup.json").read_text(encoding="utf-8"))
            self.startup_paths=list(dict.fromkeys(p for p in workspace.get("paths",[]) if isinstance(p,str)))[:100]
            self.startup_active=workspace.get("active","")
            self.startup_entries=[entry for entry in workspace.get("tabs",[]) if isinstance(entry,dict) and isinstance(entry.get("id"),str) and isinstance(entry.get("path"),str)][:100]
            self.startup_active_id=workspace.get("activeId","")
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
        active_ids.update(tab.get("id") for tab in self.initial_recovery)
        kept=[ref for ref in self.closed_tabs if ref.get("id") not in active_ids]
        if kept != self.closed_tabs:
            self.closed_tabs=kept
            try:self.closed_note_store.save_index(kept)
            except OSError:pass

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
    readerLoad = Signal(str)
    readerCall = Signal(str)
    chromeRequested = Signal(str)
    replied = Signal(str, str, str)
    completed = Signal(object)
    saveRequested = Signal(str)
    closeRequested = Signal(str)
    allowClose = Signal()
    newWindowRequested = Signal()
    detachedWindowRequested = Signal(str, str)
    exportRequested = Signal(str)
    folderPickerRequested = Signal()
    fontPickerRequested = Signal()
    themePickerRequested = Signal()
    themeExportRequested = Signal()
    noteLocationPickerRequested = Signal()
    flushFailed = Signal(bool)
    pythonProgress = Signal(str)

    def __init__(self, isolated: bool = False, session: Session | None = None):
        super().__init__()
        self.setObjectName("studio")
        self._brand_svg = (ROOT/"public/brand-mark-fixed.svg").read_text(encoding="utf-8")
        self.pool = concurrent.futures.ThreadPoolExecutor(max_workers=3, thread_name_prefix="supermd")
        self.session = session or Session(isolated)
        self.session.changed.connect(lambda:self._emit())
        self.session.locationChanged.connect(self._location_changed)
        self.writes = self.session.writes
        self.window_id = uuid.uuid4().hex
        self.session.windows[self.window_id] = self
        self.host_window = None
        self._retired = False
        self.completed.connect(self._complete)
        self.data = self.session.data
        self.settings = self.session.settings
        self.update_status=""
        self.update_info=None
        self.update_path=""
        self.update_running=False
        self._storage_report = json.dumps({"status":"idle","cancelled":False,"truncated":False,"scannedEntries":0,"categories":[]})
        self.storage_busy = False
        self._storage_cancel_event = None
        self.python_status=""
        self.python_choices=[]
        self.python_busy=False
        self.pythonProgress.connect(self._python_progress)
        if not self.settings.get("python"): QTimer.singleShot(0,self._choose_default_python)
        if not isolated and len(self.session.windows)==1:QTimer.singleShot(0,self._restore_update)
        self.tabs: list[dict] = []
        self.closed_tabs = self.session.closed_tabs
        self._closing_tabs: set[str] = set()
        self.note_watcher = QFileSystemWatcher(self)
        self.note_watcher.fileChanged.connect(self._external_note_changed)
        self.note_watcher.directoryChanged.connect(self._external_note_changed)
        self.external_paths = set()
        self.note_watch_paths = None
        self.note_file_stamps = {}
        self.note_identities = {}
        self.external_timer = QTimer(self)
        self.external_timer.setSingleShot(True)
        self.external_timer.timeout.connect(self._refresh_external_notes)
        self.active = ""
        self.folder = ""
        self.files: list[dict] = []
        self.expanded: set[str] = set()
        self.mode = self.settings.get("readingMode", "live")
        self.fullscreen = False
        self.reader_overlay = False
        self.image_overlay = False
        self.busy = 0
        self.message = ("Closed-note recovery index could not be read; historical snapshots were left untouched. "+self.session.closed_note_error) if self.session.closed_note_error else ""
        self.ready = False
        self._last_reader_text = None
        self._export_jobs = ExportJobRegistry()
        self.reader_edits = ReaderEdits()
        self.system_dark = None
        self.system_mode, self.system_colors = read_system_palette()
        self._theme_result = None
        self._theme_running = False
        self._theme_pending = False
        self.theme_debounce = QTimer(self)
        self.theme_debounce.setSingleShot(True)
        self.theme_debounce.timeout.connect(self._refresh_theme)
        QGuiApplication.styleHints().colorSchemeChanged.connect(self._schedule_theme)
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
        QTimer.singleShot(0,self.reloadCustomTheme)
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
        self.flush_operation = None
        self.flush_timer = QTimer(self)
        self.flush_timer.setSingleShot(True)
        self.flush_timer.timeout.connect(lambda:self.flushFailed.emit(bool(self.flush_operation and self.flush_operation["action"] == "close_window")))
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
        self.tabs = [{**tab,"id":tab.get("id") or uuid.uuid4().hex} for tab in self.session.initial_recovery]
        self.session.initial_recovery = []
        self.session.drafts[self.window_id] = [dict(t) for t in self.tabs]
        if not self.tabs:
            self.tabs.append(self._note("Untitled.md") if self.settings["welcomed"] else self._note("Welcome.md", SAMPLE, saved=SAMPLE))
        elif self.settings["startup"]=="new":
            self.tabs.insert(0,self._note("Untitled.md"))
        self.active = self.tabs[0]["id"]
        if self.settings["startup"]=="restore" and any(t["id"]==self.session.startup_active_id for t in self.tabs):self.active=self.session.startup_active_id
        self._activation_generation = 0
        self._startup_placeholder_ids = {
            tab["id"] for tab in self.tabs
            if tab["name"] == "Untitled.md" and not tab["path"] and not tab["content"] and not tab["saved"] and not tab["assets"]
        }
        self._restoring_paths=set()
        self._startup_order=[]
        self._startup_entries=self.session.startup_entries
        self.session.startup_entries=[]
        if self.settings["startup"]=="restore" and self.session.startup_paths:
            self._startup_order,self.session.startup_paths=self.session.startup_paths,[]
            self._restoring_paths=set(self._startup_order)
            restore_generation = self._activation_generation
            QTimer.singleShot(0,lambda:[self._open_note(path, explicit=False, activation_generation=restore_generation) for path in self._startup_order])
        self._refresh_theme()

    @property
    def recent(self): return self.session.recent

    @recent.setter
    def recent(self,value): self.session.recent = list(dict.fromkeys(self.session.pinned + value))[:10]

    @Slot(str)
    def pinRecent(self,path):
        if path not in self.recent:return
        if path in self.session.pinned:self.session.pinned.remove(path)
        else:self.session.pinned.append(path)
        self.recent=self.recent
        self._preferences()

    def _note(self, name: str, content: str = "", path: str = "", saved: str = "", assets: dict | None = None, portable: bool = False):
        return {"id": uuid.uuid4().hex, "name": name, "content": content, "path": path, "saved": saved, "assets": assets or {}, "portable": portable}

    @Property("QStringList",notify=changed)
    def pinnedRecent(self):return self.session.pinned

    def _current(self):
        return next(t for t in self.tabs if t["id"] == self.active)

    def _emit(self, load=True):
        if self.retired: return
        self._watch_notes()
        self.changed.emit()
        if load and self.ready:
            tab = self._current()
            colors = self._colors()
            reading_settings={key:self.settings[key] for key in ("restorePosition","centerLock","imageAppearance","svgAppearance","imageContrast","fullDocumentAccessibility")}
            reading_settings["customStyle"]=custom_theme.reader(self.session.custom_theme,self.settings["fullTheme" if self.fullscreen else "theme"],self._dark(),self.settings)
            payload={**reading_settings,"readingLocation":self.session.locations.get(tab["path"]),"id": tab["id"], "path": tab["path"] or tab["id"], "mode": self.mode, "dark": self._dark(), "fullscreen": self.fullscreen, "font": self.settings["font"], "size": self.settings["size"], "widthPercent": self.settings["widthPercent"], "lineHeight":self.settings["lineHeight"], "spellCheck":self.settings["spellCheck"], "grammarCheck":self.settings["grammarCheck"], "zoom": self.settings["fullZoom" if self.fullscreen else "normalZoom"], "motion": self.settings["motion"], "python": self.settings["python"], "colors": colors, "viewState": tab.pop("viewState", None)}
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

    @Property("QVariantMap",notify=changed)
    def themeArtwork(self):
        selected=custom_theme.variant(self.session.custom_theme,self.settings["fullTheme" if self.fullscreen else "theme"],self._dark())
        return custom_theme.artwork(self.session.custom_theme,selected)

    @Property("QVariantMap",notify=changed)
    def themeBackground(self):
        style=custom_theme.reader(self.session.custom_theme,self.settings["theme"],self._dark(),self.settings)
        return {"pattern":"none","size":24,"spacing":24,**(style["background"] or {}),"opacity":style["artwork"].get("reader",{}).get("opacity",(style["background"] or {}).get("opacity",.06))}

    @Slot()
    def resetThemeBackground(self):
        self.settings.update(patternKind="",patternOpacity=-1,patternSize=0,patternSpacing=0)
        self._preferences();self._emit()

    @Property(bool, notify=changed)
    def motionEnabled(self): return bool(self.settings["motion"])

    def _watch_notes(self,force=False):
        paths=tuple(sorted({tab["path"] for tab in self.tabs if tab["path"]}|set(self.recent)))
        signature=(paths,self.folder,tuple(sorted(self.expanded)))
        if not force and signature==self.note_watch_paths:return
        self.note_watch_paths=signature
        self.note_file_stamps={path:stamp for path,stamp in self.note_file_stamps.items() if path in paths}
        self.note_identities={path:file_events.identity(path) or self.note_identities.get(path) for path in paths}
        targets={str(target) for path in paths for target in (Path(path),Path(path).parent) if target.exists()}
        targets.update(path for path in ({self.folder}|set(self.expanded)) if path and Path(path).is_dir())
        watched=set(self.note_watcher.files()+self.note_watcher.directories())
        if watched-targets:self.note_watcher.removePaths(list(watched-targets))
        if targets-watched:self.note_watcher.addPaths(list(targets-watched))

    def _external_note_changed(self,path):
        if self.retired:return
        self.external_paths.add(str(local_path(path)))
        self.external_timer.start(250)

    def _refresh_external_notes(self):
        if self.retired:return
        changed,self.external_paths=self.external_paths,set()
        known=dict(self.note_identities)
        def reconciled(result,error):
            if self.retired or error:return
            for old,new in result.items():self.session.locationChanged.emit(old,new or "")
            self._reload_changed_content(changed)
            if self.folder and (self.folder in changed or set(self.expanded)&changed):self._load_tree()
        self._submit(lambda:file_events.reconcile(known,changed),reconciled,False)

    def _location_changed(self,old,new):
        if self.retired:return
        if Path(old).exists() and not (new and old!=new and old.casefold()==new.casefold()):return  # A temporary atomic-replace gap has healed.
        if new and not Path(new).is_file():return
        if new:
            location=self.session.locations.pop(old,None)
            if location:self.session.locations[new]=location
            for tab in self.tabs:
                if tab["path"]==old:tab.update(path=new,name=Path(new).name)
            self.session.pinned=[new if path==old else path for path in self.session.pinned]
            self.recent=[new if path==old else path for path in self.recent]
            for paths in self.session.workspace.values():
                for entry in paths:
                    if entry["path"]==old:entry["path"]=new
            self.message="Renamed note: "+Path(new).name
        else:
            self.session.locations.pop(old,None)
            self.session.pinned=[path for path in self.session.pinned if path!=old]
            self.recent=[path for path in self.recent if path!=old]
            for tab in list(self.tabs):
                if tab["path"]!=old:continue
                if tab["content"]!=tab["saved"]:
                    draft={**tab,"path":"","name":"Recovered "+tab["name"],"saved":""}
                    self.session.drafts.setdefault("deleted-notes",[]).append(draft)
                    tab.update(path="",name=draft["name"])
                self._remove_tab(tab["id"])
            self.message="File deleted: "+Path(old).name+". Its tab was closed; unsaved changes remain recoverable."
        self._preferences();self._recover();self._emit()

    def _reload_changed_content(self,changed):
        self._watch_notes(force=True)
        for tab in self.tabs:
            path=tab["path"]
            if not path or not ({path,str(Path(path).parent)} & changed) or tab["id"] in self.saving:continue
            if tab["content"]!=tab["saved"]:continue  # Never clobber a local draft.
            try:
                stat=Path(path).stat();stamp=(stat.st_mtime_ns,stat.st_size)
            except OSError:continue
            if self.note_file_stamps.get(path)==stamp:continue
            id,expected=tab["id"],tab["saved"]
            def finished(result,error,id=id,expected=expected,path=path,stamp=stamp):
                current=next((note for note in self.tabs if note["id"]==id),None)
                if error or not current or current["content"]!=expected:return
                self.note_file_stamps[path]=stamp
                content,assets,portable=result
                if content==expected and assets==current["assets"]:return
                current.update(content=content,saved=content,assets=assets,portable=portable)
                self.message="Reloaded externally updated note"
                self._emit(load=id==self.active)
            self._submit(lambda path=path:open_note(Path(path)),finished,False)

    def _schedule_theme(self,*_):
        self.theme_debounce.start(150)

    def _watch_palette(self):
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
        self._export_jobs.cancel_all()
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
        self._recover()
        self.session.reader_assets.revoke_owner(self.window_id)
        self._retired = True
        self.session.windows.pop(self.window_id, None)
        if not self.session.quitting and self.session.windows:
            self.session.workspace.pop(self.window_id,None)
            next(iter(self.session.windows.values()))._recover()
        if self.system_preferences.state() != QProcess.NotRunning:
            self.system_preferences.terminate()
            self.system_preferences.waitForFinished(300)

    @Property(str, notify=changed)
    def snapshot(self):
        tab = self._current()
        return json.dumps({"tabs": [{"id": t["id"], "name": t["name"], "path": t["path"], "dirty": t["content"] != t["saved"]} for t in self.tabs], "active": self.active, "name": tab["name"], "outline": tab.get("outline", []), "portable": tab["portable"], "folder": self.folder, "files": self.files, "recent": self.recent, "settings": self.settings, "mode": self.mode, "fullscreen": self.fullscreen, "readerOverlay": self.reader_overlay, "imageOverlay": self.image_overlay, "readerReady": self.ready, "dark": self._dark(), "zoom": self.settings["fullZoom" if self.fullscreen else "normalZoom"], "busy": self.busy > 0, "message": self.message, "colors": self._colors()})

    @Property(bool,notify=changed)
    def readerFullscreen(self):return self.fullscreen

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
        downloads=Path(QStandardPaths.writableLocation(QStandardPaths.DownloadLocation) or str(Path.home()/'Downloads'))/'Super MD Updates'
        self._submit(lambda:updates.download(info,downloads,self.data/'updates'),done,False)

    @Slot()
    @Slot(bool)
    def checkUpdates(self,automatic=False):
        if self.update_running:return
        self.update_running=True;self.update_status="Checking published releases…";self._emit(False)
        def done(info,error):
            self.update_running=False
            if error:
                self.update_status="Couldn't check updates. Your notes still work offline."
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
            try:return updates.release_info(updates.bounded_json(updates.API),self.appVersion),None
            except Exception as failure:return None,str(failure)
        self._submit(check,lambda result,error:done(*(result or (None,error))),False)

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

    def _choose_default_python(self):
        if self.retired:return
        managed = self.data/"python-env"
        def done(path,error):
            if path and not self.settings.get("python"):
                self.settings["python"] = path
                self._preferences()
            self._emit(False)
        self._submit(lambda: python_runtime.preferred(managed), done, False)

    @Slot(str)
    def _python_progress(self, text):
        self.python_status = text
        self._emit(False)

    @Slot()
    def refreshPython(self):
        if self.python_busy: return
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
        self._submit(lambda: python_runtime.discover(self.data/"python-env", self._python_folders()), done, False)

    @Slot(str)
    def installPythonPackages(self, path):
        if self.python_busy: return
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
        if self.python_busy: return
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
        self._submit(lambda: python_runtime.setup_environment(self.data/"python-env", self.pythonProgress.emit), done, False)

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
        if self.update_path.endswith('.AppImage') and not self.desktopIntegrationAvailable:
            self.update_status='This installation is package-managed. Install the DEB/RPM from the release page using your package manager.'
            QDesktopServices.openUrl(QUrl(updates.REPO+'/releases/latest'));self._emit(False);return
        self.update_running=True;self.update_status='Verifying and preparing installation…';self._emit(False)
        def prepare():
            saved=updates.load_ready(self.data/'updates',self.appVersion)
            if not saved or saved['path']!=self.update_path:raise ValueError('Installer changed or is missing. Download the update again.')
            if self.update_path.endswith('.AppImage'):
                return app_integration.install_appimage(self.update_path,saved['release']['version'],self.settings.get('desktopIntegration',False))
            return self.update_path
        def done(path,error):
            self.update_running=False
            if error:self.update_status='Update installation failed: '+error;return
            if self.update_path.endswith('.AppImage'):
                self.update_status='Update installed. Close and reopen Super MD to use it. Your previous version and downloaded installer have been kept.'
            else:
                opened=QProcess.startDetached(path,[]) if sys.platform=='win32' else QDesktopServices.openUrl(QUrl.fromLocalFile(path))
                if isinstance(opened,tuple):opened=opened[0]
                self.update_status='Installer opened. Follow its instructions; the download is kept in Downloads.' if opened else 'Could not open installer. Open the verified file in Downloads.'
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
        self.session.drafts[self.window_id] = [copy.deepcopy({key: value for key, value in t.items() if key != "viewState"}) for t in self.tabs if t["content"] != t["saved"] and (t["path"] or t["content"].strip())]
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
    def captionlessDesktop(self):
        desktop = os.environ.get("XDG_CURRENT_DESKTOP", "").lower()
        return sys.platform.startswith("linux") and any(name in desktop for name in ("hyprland", "sway", "river", "niri"))

    @Slot()
    def chooseFont(self): self.fontPickerRequested.emit()

    @Slot()
    def chooseCustomTheme(self):self.themePickerRequested.emit()

    @Slot()
    def chooseThemeExport(self):self.themeExportRequested.emit()

    @Slot()
    def openThemeGuide(self):QDesktopServices.openUrl(QUrl("https://github.com/YashMahawa/super-md/blob/main/docs/THEMING.md"))

    def _watch_custom_theme(self):
        watcher=self.custom_theme_watcher
        paths=watcher.files()+watcher.directories()
        if paths:watcher.removePaths(paths)
        source=Path(self.session.theme_source) if self.session.theme_source else None
        self.custom_theme_stamp=custom_theme.stamp(source) if source else None
        if source:
            watcher.addPaths([str(path) for path in (source,source.parent) if path.exists()])

    def _custom_theme_event(self):
        if self.retired or not self.session.theme_source:return
        value=custom_theme.stamp(Path(self.session.theme_source))
        if value==self.custom_theme_stamp:return
        self.custom_theme_stamp=value
        self.reloadCustomTheme()

    @Slot(str)
    def importCustomTheme(self,value):self._load_custom_theme(local_path(value))

    @Slot()
    def reloadCustomTheme(self):
        if self.retired:return
        source=Path(self.session.theme_source) if self.session.theme_source else self.data/"theme.json"
        if not source.is_file():source=self.data/"theme.json"
        self._watch_custom_theme()
        cached=self.data/"theme.json"
        if self.session.custom_theme is None and cached.is_file() and cached!=source:self._load_custom_theme(cached,False,source)
        elif source.is_file():self._load_custom_theme(source,False)

    def _load_custom_theme(self,path,importing=True,follow_source=None):
        self.session.theme_epoch+=1
        epoch=self.session.theme_epoch
        try:engine=self._engine()
        except ValueError as error:self.message=str(error);self._emit(False);return
        def finished(value,error):
            if epoch!=self.session.theme_epoch:return
            if error:
                self.message="Theme not applied: "+str(error);self._emit(False)
                if follow_source:self._load_custom_theme(follow_source,False)
                return
            try:
                if importing:
                    self.session.theme_source=str(path)
                    atomic_json(self.data/"theme-source.json",{"path":str(path)})
                changed=value!=self.session.custom_theme
                if changed:atomic_json(self.data/"theme.json",value)
                self.session.custom_theme=value
                if changed:self.session.theme_revision+=1
                for window in self.session.windows.values():window._watch_custom_theme()
                if changed or importing:
                    self.message="Applied "+value["name"]
                    self.session.changed.emit()
            except OSError as failure:self.message="Could not save theme: "+str(failure);self._emit(False)
            if follow_source:self._load_custom_theme(follow_source,False)
        def read():
            try:return custom_theme.read(engine,path),None
            except Exception as failure:return None,str(failure)
        self._submit(read,lambda result,error:finished(*(result or (None,error))),False)

    @Slot()
    def resetCustomTheme(self):
        self.session.theme_epoch+=1
        self.session.custom_theme=None;self.session.theme_source=""
        self.session.theme_revision+=1
        for filename in ("theme.json","theme-source.json"):(self.data/filename).unlink(missing_ok=True)
        for window in self.session.windows.values():window._watch_custom_theme()
        self.session.changed.emit()

    @Slot()
    def editCustomTheme(self):
        source=Path(self.session.theme_source) if self.session.theme_source else self.data/"theme.json"
        if source.is_file():QDesktopServices.openUrl(QUrl.fromLocalFile(str(source)))

    @Slot(str)
    def exportCustomTheme(self,value):
        try:
            atomic_json(local_path(value),custom_theme.for_sharing(self.session.custom_theme,self.settings))
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
            if self.retired:return
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

    def _preferences(self,notify=True):
        if self.retired or getattr(self.writes, "_shutdown", False): return
        data = json.dumps({"settings": self.settings, "recent": self.recent, "pinned":self.session.pinned}).encode()
        self._submit(lambda: atomic_write(self.data / "settings.json", data), lambda *_: None, False,self.writes)
        if notify:self.session.changed.emit()

    def _save_positions(self):
        data=json.dumps(self.session.locations).encode()
        self._submit(lambda:atomic_write(self.data/"reading-positions.json",data),lambda *_:None,False,self.writes)

    def _recover(self):
        # Clean tabs need only paths, never another copy of their image bytes.
        self.session.workspace[self.window_id]=[{"path":t["path"],"id":t["id"]} for t in self.tabs if t["path"] or t["content"]!=t["saved"]]
        entries=[entry for tabs in self.session.workspace.values() for entry in tabs]
        workspace={"paths":list(dict.fromkeys(t["path"] for t in entries if t["path"])),"tabs":entries,"active":self._current()["path"],"activeId":self.active}
        self.session.writes.submit_latest("startup",lambda:atomic_json(self.data/"startup.json",workspace),lambda error:self._notify_recovery_write("startup",error))
        # Snapshot only unsaved tabs. Asset bytes stay in recovery, never in displayed source.
        self.session.drafts[self.window_id] = [copy.deepcopy({key: value for key, value in t.items() if key != "viewState"}) for t in self.tabs if t["content"] != t["saved"] and (t["path"] or t["content"].strip() or t["assets"])]
        drafts = [tab for tabs in self.session.drafts.values() for tab in tabs]
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

    def _open_note(self, value, *, explicit, activation_generation=None):
        if self.retired:return
        path = local_path(value)
        if path.is_dir():
            self.openFolder(str(path))
            return
        if explicit:
            self._activation_generation += 1
            activation_generation = self._activation_generation
        elif activation_generation is None:
            activation_generation = self._activation_generation
        restoring = not explicit and str(path) in self._restoring_paths
        found = next((t for t in self.tabs if t["path"] == str(path)), None)
        if found:
            self._restoring_paths.discard(str(path))
            if restoring and activation_generation == self._activation_generation and str(path) == self.session.startup_active:
                self._select_tab_from_open(found["id"], activation_generation)
            if explicit and activation_generation == self._activation_generation:
                self._select_tab_from_open(found["id"], activation_generation)
                self._focus_open_target(activation_generation)
            return
        def finished(result, error):
            self._restoring_paths.discard(str(path))
            if error:
                return
            content, assets, portable = result
            # A startup read and an explicit open may race for the same path.
            # Keep one tab and let only an explicit, still-current request focus it.
            existing = next((tab for tab in self.tabs if tab["path"] == str(path)), None)
            if existing:
                if explicit and activation_generation == self._activation_generation:
                    self._select_tab_from_open(existing["id"], activation_generation)
                    self._focus_open_target(activation_generation)
                return
            note = self._note(path.name, content, str(path), content, assets, portable)
            if restoring:
                if activation_generation == self._activation_generation:
                    self.tabs=[t for t in self.tabs if t["id"] not in self._startup_placeholder_ids]
                    self._startup_placeholder_ids.clear()
            self.tabs.append(note)
            if restoring:
                keys=[entry["path"] or entry["id"] for entry in self._startup_entries] or self._startup_order
                self.tabs.sort(key=lambda t:keys.index(t["path"] or t["id"]) if (t["path"] or t["id"]) in keys else -1)
            should_activate = (explicit and activation_generation == self._activation_generation)
            if restoring and activation_generation == self._activation_generation:
                should_activate = str(path) == self.session.startup_active or not any(t["id"] == self.active for t in self.tabs)
            if should_activate:
                self.active = note["id"]
            self.settings["welcomed"] = True
            self.recent = [str(path)] + [p for p in self.recent if p != str(path)][:29]
            self._preferences()
            self.recovery_timer.start(800)
            self._emit()
            if explicit and should_activate:
                self._focus_open_target(activation_generation)
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
        index=next((i for i,t in enumerate(self.tabs) if t["id"]==self.active),0)
        self.selectTab(self.tabs[(index+direction)%len(self.tabs)]["id"])

    @Slot(int)
    def tabNumber(self, number):
        index=len(self.tabs)-1 if number==9 else number-1
        if 0<=index<len(self.tabs):self.selectTab(self.tabs[index]["id"])

    @Slot()
    def reopenTab(self):
        if not self.closed_tabs:return
        self._activation_generation += 1
        activation_generation=self._activation_generation
        reference=self.closed_tabs[-1]
        def finished(note,error):
            if error:
                self.message="Could not reopen the closed note: "+error
                self._emit(False);return
            if reference not in self.closed_tabs:return
            existing=next((t for t in self.tabs if note.get("path") and t["path"]==note["path"]),None)
            if existing:
                if activation_generation==self._activation_generation:self.active=existing["id"]
            else:
                self.tabs.append(note)
                if activation_generation==self._activation_generation:self.active=note["id"]
            self.closed_tabs.remove(reference)
            self._recover();self._emit()
        def read_note():
            if reference.get("_closedSnapshot"):
                return self.session.closed_note_store.load(reference)
            return copy.deepcopy(reference)  # compatibility with old in-memory entries
        self._submit(read_note,finished,False,self.writes)

    @Slot(str)
    def openFolder(self, value):
        path = local_path(value)
        if not path.is_dir():
            self.message = "Choose an existing local folder."
            self._emit(False)
            return
        self.folder = str(path)
        self.settings["welcomed"] = True
        self.expanded = {self.folder}
        self._preferences()
        self._emit(False)
        self._load_tree()

    def _load_tree(self):
        folder, expanded = self.folder, set(self.expanded)
        def scan():
            entries = []
            def visit(path, depth):
                try:
                    children = sorted(Path(path).iterdir(), key=lambda p: (not p.is_dir(), p.name.lower()))
                except OSError:
                    return
                for child in children:
                    if len(entries) >= 3000:
                        return
                    if child.name.startswith(".") or child.is_symlink():
                        continue
                    directory = child.is_dir()
                    if directory or child.suffix.lower() in (".md", ".smd", ".fmd", ".markdown", ".txt"):
                        entries.append({"name": child.name, "path": str(child), "directory": directory, "depth": depth, "expanded": str(child) in expanded})
                        if directory and str(child) in expanded:
                            visit(child, depth + 1)
            visit(folder, 0)
            return entries
        def finished(result, error):
            if not error and folder == self.folder:
                self.files = result
        self._submit(scan, finished, False)

    @Slot(str)
    def toggleDirectory(self, path):
        self.expanded.symmetric_difference_update({path})
        self._load_tree()

    @Slot()
    def closeFolder(self):
        self.folder = ""
        self.files = []
        self.expanded.clear()
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
        if key=="patternKind" and value not in ("","none","paws","dots","grid","diagonal","gradient"):return
        if key in ("patternOpacity","patternSize","patternSpacing"):
            if not isinstance(value,(int,float)) or isinstance(value,bool) or not math.isfinite(value):return
            default,low,high={"patternOpacity":(-1,0,.25),"patternSize":(0,8,64),"patternSpacing":(0,12,192)}[key]
            if value!=default and not low<=value<=high:return
        if key in ("imageAppearance","svgAppearance") and value not in ("original","invert-dark","auto","monochrome","contrast"):return
        if key in ("restorePosition","centerLock") and not isinstance(value,bool):return
        if key=="imageContrast" and (not isinstance(value,(int,float)) or isinstance(value,bool) or not math.isfinite(value) or not 1<=value<=2):return
        if key in ("motion","welcomed","autosave","checkUpdates","autoUpdate","spellCheck","grammarCheck","desktopIntegration","fullDocumentAccessibility") and not isinstance(value,bool): return
        if key in ("font","python") and (not isinstance(value,str) or not value.strip() or len(value)>2048): return
        if key == "python":
            try: value = python_runtime.validate(value.strip())
            except ValueError as error:
                self.python_status = str(error); self._emit(False); return
            self.python_status = ""
        if key in ("size","width","widthPercent","lineHeight","normalZoom","fullZoom") and (not isinstance(value,(int,float)) or isinstance(value,bool) or not math.isfinite(value)): return
        if key == "pdf" and (not isinstance(value,dict) or set(value) != set(DEFAULT_PDF)): return
        if key in ("window","widthMigrated"): return  # Internal state, not user settings.
        if key == "size": value = max(6, min(32, float(value)))
        if key == "width": value = max(0, min(5000, int(value)))
        if key == "widthPercent": value = max(50,min(150,float(value)))
        if key == "lineHeight": value = max(1.15,min(2.2,float(value)))
        self.settings[key] = value
        self._preferences()
        self._emit()

    @Slot()
    def save(self):
        tab = self._current()
        if not tab["path"]:
            self.saveRequested.emit(tab["name"])
        elif tab["portable"]:
            self.readerCall.emit("window.supermdPortable?.(true)")
        else:
            self._save_text(tab, Path(tab["path"]))

    def _after_flush(self,operation):
        if operation["action"] == "save": self.save()
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

    def _flush(self,action,target=""):
        if self.retired or action=="close_window" and self.pending_close:return
        operation = {"action":action,"target":target,"token":uuid.uuid4().hex}
        if not self.ready:
            self._after_flush(operation)
            return
        if self.flush_operation: return
        self.flush_operation = operation
        self.flush_timer.start(5000)
        self.readerCall.emit(f"window.supermdFlush?.({json.dumps(operation)})")

    @Slot()
    def saveSafely(self): self._flush("save")

    @Slot(str)
    def closeTabSafely(self,id): self._flush("close_tab",id)

    @Slot()
    def closeWindowSafely(self): self._flush("close_window")

    @Slot(str)
    def resolveFlush(self,choice):
        operation,self.flush_operation = self.flush_operation,None
        self.flush_timer.stop()
        if not operation: return
        if choice == "retry": self._flush(operation["action"],operation["target"])
        elif choice == "recover_close" and operation["action"] == "close_window":
            # Explicit emergency action: preserve the latest received drafts, not
            # a silent discard or a claim we can recover an unresponsive renderer.
            self._recover()
            self.allowClose.emit()

    @Slot(str)
    def saveAs(self, value):
        path = local_path(value)
        if path.suffix.lower() == ".smd":
            self.pending_export = str(path)
            self.pending_save_as = str(path)
            self.readerCall.emit("window.supermdPortable?.(false)")
        else:
            self._save_text(self._current(), path)

    def _save_text(self, tab, path, automatic=False):
        id, content, assets = tab["id"], tab["content"], dict(tab["assets"])
        expected, original_path = tab["saved"], tab["path"]
        portable = tab["portable"] and str(path) == original_path
        if id in self.saving: return
        self.saving.add(id)
        def finished(_, error):
            self.saving.discard(id)
            if error: return
            target = next((t for t in self.tabs if t["id"] == id), None)
            if target:
                target.update(path=str(path), name=path.name, saved=content, portable=portable)
                if automatic and target["content"] != content: self.autosave_timer.start(900)
            self.message = "Autosaved" if automatic else "Saved"
            self._recover()
            self._emit()
            if self.pending_close:
                self._finish_close()
        def write():
            if automatic and (not path.exists() or open_note(path)[0] != expected):
                raise ValueError("Autosave paused: this file changed outside Super MD. Your edits remain in draft recovery; use Save as to keep both versions.")
            if portable: atomic_write(path,json.dumps(bundle(content,assets),ensure_ascii=False).encode())
            else:
                materialize_assets(path.parent,assets)
                atomic_write(path,content.encode())
        self._submit(write, finished,busy=not automatic,executor=self.writes)

    def _autosave(self):
        if not self.settings["autosave"]: return
        for tab in self.tabs:
            if tab["path"] and tab["content"] != tab["saved"] and tab["id"] not in self.saving:
                self._save_text(tab,Path(tab["path"]),automatic=True)

    @Slot(str, str)
    def renameNote(self, id, name):
        tab = next((t for t in self.tabs if t["id"] == id),None)
        if not tab or id in self.saving: return
        name = name.strip()
        if not name or name in (".","..") or any(c in name for c in '/\\\x00'):
            self.message = "Choose a filename without path separators."; self._emit(False); return
        suffix = Path(tab["name"]).suffix or ".md"
        if not Path(name).suffix: name += suffix
        if Path(name).suffix.lower() != suffix.lower():
            self.message = "Rename keeps the note format. Use Export to change formats."; self._emit(False); return
        if not tab["path"]: tab["name"] = name; self._recover(); self._emit(False); return
        before = Path(tab["path"]); after = before.with_name(name)
        if before == after: return
        def work():
            if after.exists(): raise ValueError("A file with that name already exists.")
            before.rename(after)
        def finished(_,error):
            if error: return
            tab.update(path=str(after),name=name)
            self.recent = [str(after) if p == str(before) else p for p in self.recent]
            self._preferences(); self._recover(); self._emit(); self._load_tree()
        self._submit(work,finished,executor=self.writes)

    @Slot(str,result=QUrl)
    def defaultSaveLocation(self,name):
        directory = self.settings.get("newNoteLocation") or QStandardPaths.writableLocation(QStandardPaths.DownloadLocation) or str(Path.home())
        return QUrl.fromLocalFile(str(Path(directory)/Path(name).name))

    @Slot(str, result=QUrl)
    def defaultExportLocation(self, format):
        return self.defaultSaveLocation(Path(self._current()["name"]).stem + "." + format)

    @Slot(str)
    def closeTab(self, id):
        tab = next((t for t in self.tabs if t["id"] == id), None)
        if not tab:
            return
        self._activation_generation += 1
        if tab["content"] != tab["saved"] and (tab["path"] or tab["content"].strip() or tab["assets"]):
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
            # Strings and encoded assets are immutable; deepcopy shares their
            # bytes while snapshotting small mutable metadata/asset mappings.
            captured=copy.deepcopy(removed)
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
        dirty = next((t for t in self.tabs if t["content"] != t["saved"] and (t["path"] or t["content"].strip() or t["assets"])), None)
        if dirty:
            self.pending_close = "window"
            self.selectTab(dirty["id"])
            self.closeRequested.emit(dirty["name"])
            return False
        return True

    @Slot(str)
    def resolveClose(self, choice):
        if choice == "cancel": self.pending_close = ""; return
        if choice == "save": self.save(); return
        if choice == "discard":
            # For a single-tab close, "discard" confirms closing the dirty
            # buffer; the closed snapshot must retain its original saved text.
            if self.pending_close != "window":
                action=self.pending_close
                self.pending_close=""
                if action:self._remove_tab(action)
                return
            self._current()["saved"] = self._current()["content"]
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
        if self.pending_export:
            self.message = "An export is already in progress; finish or cancel it before choosing another destination"
            self._emit(False)
            return
        self.pending_save_as = ""
        self.pending_export = ""
        try:
            self.pending_export = str(export_destination(value, format))
        except ValueError as error:
            self.message = str(error)
            self._emit(False)
            return
        if format == "md": self.readerCall.emit("window.supermdExportMarkdown?.()")
        elif format == "smd": self.readerCall.emit("window.supermdPortable?.(false)")
        else: self.readerCall.emit(f"window.supermdExport?.({json.dumps(self.settings['pdf'])})")

    @Slot(str)
    def command(self, action):
        calls = {"find": "window.supermdFind?.()", "insert": "window.supermdMedia?.()", "repair": "window.supermdRepairMath?.()", "undo":"window.supermdHistory?.('undo')", "redo":"window.supermdHistory?.('redo')"}
        if action in calls: self.readerCall.emit(calls[action])
        elif action == "window": self.newWindowRequested.emit()

    @Slot(str, str, str)
    def post(self, id, command, raw):
        if self.retired:return
        try:
            args = json.loads(raw)
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
                if target:
                    target["outline"] = headings
                    if not target["path"] and target["name"].startswith("Untitled") and headings:
                        title = str(headings[0].get("title", "")).strip()
                        title = "".join(c for c in title if c not in '/\\:*?"<>|' and ord(c) >= 32).strip(". ")[:120]
                        if title: target["name"] = title + (".smd" if target["portable"] else ".md")
                if changed:self._emit(False)
                self.replied.emit(id,"true",""); return
            if command == "document_flushed":
                operation = args.get("operation")
                if operation != self.flush_operation or operation is None:
                    self.replied.emit(id,"true",""); return
                target = next((t for t in self.tabs if t["id"] == args["id"]),None)
                if target: target["content"] = args["content"]
                if operation["action"] in ("move_tab", "detach_tab"):
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
                tab = next((item for item in self.tabs if document in (item["id"], item["path"])), None)
                if tab is None:
                    raise ValueError("The note for this image is no longer open")
                captured = dict(tab)
                captured["assets"] = dict(tab["assets"])
                owner_id, tab_id = self.window_id, tab["id"]
                def work():
                    return resolve_source(captured, source)
                def finished(resolved, error):
                    current = next((item for item in self.tabs if item["id"] == tab_id), None)
                    if error:
                        self.replied.emit(id, "null", error)
                    elif current is None or not self.session.reader_asset_source_is_current(
                            owner_id, tab_id, source, _asset_identity(resolved.get("embedded_data")) if resolved.get("embedded_data") else 0,
                            resolved.get("path", "")):
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
            if command == "export_failed": self.pending_export = self.pending_save_as = ""; self.message = args["error"]; self._emit(False); self.replied.emit(id,"true",""); return
            if command == "request_fmd_export": self.exportRequested.emit("smd"); self.replied.emit(id,"true",""); return
            context=args.get("context")
            if context is not None:
                if not isinstance(context,dict) or set(context)!={"document","cell","interpreter"}:raise ValueError("Invalid Python output context")
                if context["interpreter"] != (self.settings["python"] or "embedded"):raise ValueError("Python runtime changed; retry this operation")
            reference = args.get("id") or args.get("documentPath") or (context.get("document") if context else None)
            if reference:
                tab = next((t for t in self.tabs if reference in (t["id"],t["path"])),None)
                if tab is None: raise ValueError("The note for this operation is no longer open")
            if context and context["document"] not in (tab["id"],tab["path"]):raise ValueError("Python output belongs to another note")
            captured = dict(tab)
            captured["assets"] = dict(tab["assets"])
            output = self.pending_export
            save_as = self.pending_save_as
            # Preparation is asynchronous. Recheck the actual writer, not just
            # the dialog choice, so a stale/cross-format callback cannot put
            # PDF bytes in an SMD file (or overwrite a portable note with text).
            expected_suffixes = {
                "export_pdf_native": (".pdf",),
                "export_markdown_native": (".md", ".markdown", ".txt"),
                "export_fmd_native": (".smd",),
            }
            if command in expected_suffixes and not (command == "export_fmd_native" and args.get("save")):
                if not output or Path(output).suffix.casefold() not in expected_suffixes[command]:
                    raise ValueError("The export destination does not match the requested file format; choose the destination again")
            python = self.settings["python"]
            export_job = None
            if command == "export_pdf_native":
                if not output: raise ValueError("Choose a PDF destination before exporting")
                job_id = args.get("jobId")
                if job_id is None: job_id = uuid.uuid4().hex
                export_job = self._export_jobs.register(job_id)
            def work():
                if command == "load_asset": return self._asset(captured,args["source"])
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
                    result=self._python(python,args["code"],str(Path(captured["path"]).parent) if captured.get("path") else None)
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
                    if not output or not isinstance(args["content"], str) or len(args["content"].encode()) > 20_000_000: raise ValueError("Choose a Markdown destination for a note under 20 MB")
                    atomic_write(Path(output), args["content"].encode())
                    return {"path": output}
                if command == "export_fmd_native":
                    target = Path(captured["path"]) if args.get("save") else Path(output)
                    atomic_write(target,json.dumps(bundle(args["content"],args["assets"]),ensure_ascii=False).encode())
                    return {"path":str(target)}
                if command == "export_pdf_native":
                    job = export_job
                    assert job is not None
                    destination = Path(output)
                    stage = destination.with_name(f".{destination.name}.{uuid.uuid4().hex}.stage.pdf")
                    process = None
                    rust_temp = None
                    try:
                        job.check()
                        if not destination.parent.is_dir(): raise ValueError("The PDF destination folder is unavailable")
                        engine = self._engine()
                        args["assets"].update(self.session.font_store.pdf_assets(args["options"]["fontFamily"]))
                        job.check()
                        with tempfile.TemporaryFile() as request_file, tempfile.TemporaryFile() as stdout_file, tempfile.TemporaryFile() as stderr_file:
                            request_size = 0
                            for chunk in json.JSONEncoder(ensure_ascii=False).iterencode(args):
                                encoded = chunk.encode("utf-8")
                                request_size += len(encoded)
                                request_file.write(encoded)
                            request_file.flush()
                            request_file.seek(0)
                            job.check()
                            process = subprocess.Popen(
                                [str(engine), "export-json", str(stage)],
                                stdin=request_file, stdout=stdout_file, stderr=stderr_file,
                            )
                            rust_temp = stage.with_name(f".{stage.name}.{process.pid}.tmp")
                            job.attach_process(process)
                            deadline=time.monotonic()+120
                            while True:
                                try:
                                    process.wait(timeout=.1)
                                    break
                                except subprocess.TimeoutExpired:
                                    if not job.cancelled.is_set() and time.monotonic()<deadline:continue
                                    job.stop_process()
                                    try: process.wait(timeout=2)
                                    except subprocess.TimeoutExpired:
                                        try: process.kill()
                                        except OSError: pass
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
                            if generated.read(5) != b"%PDF-": raise ValueError("PDF export produced an invalid file")
                        job.promote(stage, destination,lambda:self.readerCall.emit("window.supermdExportPhase?.("+json.dumps(job.job_id)+",'publishing')"))
                        return {"path":output}
                    finally:
                        for owned in (stage, rust_temp):
                            if owned is not None:
                                try: owned.unlink(missing_ok=True)
                                except OSError: pass
                        self._export_jobs.discard(job.job_id, job)
                raise ValueError(f"Unsupported command: {command}")
            def finished(result,error):
                if command.startswith("export_") and self.pending_export == output: self.pending_export = ""
                if error and self.pending_save_as == save_as: self.pending_save_as = ""
                if error: self.replied.emit(id,"null",error); return
                target = next((t for t in self.tabs if t["id"] == captured["id"]),None)
                if command == "import_images" and target: target["assets"].update(captured["assets"])
                if command == "export_fmd_native" and args.get("save") and target:
                    target.update(saved=args["originalContent"], assets=args["assets"])
                    if target["content"] == args["originalContent"]: target["content"] = target["saved"] = args["content"]
                    self._recover()
                    if self.pending_close: self._finish_close()
                elif command == "export_fmd_native" and save_as and target:
                    if target["content"] == args["originalContent"]:
                        target.update(path=save_as,name=Path(save_as).name,content=args["content"],saved=args["content"],assets=args["assets"],portable=True)
                        self._recover()
                        self._emit()
                        if self.pending_close: self._finish_close()
                    self.pending_save_as = ""
                if command.startswith("export_"): self.message = f"Exported {Path(result['path']).name}"
                self.replied.emit(id,json.dumps(result),"")
            self._submit(work,finished,command in ("run_python","export_fmd_native","export_pdf_native","export_markdown_native"),self.writes if command in ("export_fmd_native", "export_markdown_native") else None)
        except Exception as error:
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

    def _python(self, executable, code, folder=None):
        # Explicit Run only. Python is trusted local code, not a sandbox.
        return python_runtime.run(executable or self.settings["python"], code, cwd=folder)
