"""Native Qt state/file management. Expensive work runs outside the UI thread."""
from __future__ import annotations
import base64
import concurrent.futures
import copy
import json
import ipaddress
import math
import mimetypes
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import urllib.parse
import urllib.request
import uuid
from pathlib import Path
from PySide6.QtCore import QObject, Property, Signal, Slot, QStandardPaths, QTimer, QUrl, QFileSystemWatcher, QProcess, Qt, QPointF
from PySide6.QtGui import QDesktopServices, QFontDatabase, QGuiApplication, QCursor
from documents import atomic_write, atomic_json, bundle, image_data, materialize_assets, open_note, MIMES, MAX_IMAGE
from theme import detect_system_dark, read_system_palette, system_palette_paths, tokens
from fonts import FontStore
from python_outputs import PythonOutputs
import updates

ROOT = Path(sys._MEIPASS)/"resources" if getattr(sys,"frozen",False) else Path(__file__).resolve().parent.parent
DEFAULT_PDF = {"pageSize": "a4", "margin": 18, "fontSize": 10, "lineHeight": 1.45, "paragraphSpacing": 1.2, "fontFamily": "Manrope", "pageNumbers": True, "themed": False}
DEFAULTS = {"theme": "system", "fullTheme": "black", "motion": True, "font": "Manrope", "size": 18, "width": 0, "widthPercent":80, "lineHeight":1.65, "autosave":True, "normalZoom": 100, "fullZoom": 100, "python": (shutil.which("python3") or shutil.which("python") or "") if getattr(sys,"frozen",False) else sys.executable, "pdf": DEFAULT_PDF, "welcomed": False}
DEFAULTS.update(readingMode="live", newNoteLocation="", accent="system", checkUpdates=True, autoUpdate=False)
SAMPLE = """# A place to think\n\nWrite in Markdown. Read without distractions.\n\n> [!tip] Start with your notes\n> Open any note or folder. No vault, no import process.\n\n## Learn by exploring\n\n$$E = mc^2$$\n\n> [!answer]- Why does this matter?\n> Tap the heading to reveal an answer, then hide it to test yourself.\n\n```smd-chart\n{\"title\":\"A changing wave\",\"series\":[{\"name\":\"Sine\",\"expression\":\"sin(a*x)\",\"color\":\"#386a57\"},{\"name\":\"Cosine\",\"expression\":\"cos(a*x)\",\"color\":\"#bc6750\"}],\"sliders\":[{\"name\":\"a\",\"min\":0.2,\"max\":3,\"value\":1}]}\n```\n\n## Explore in three dimensions\n\n```smd-chart\n{\"mode\":\"surface3d\",\"title\":\"Bowl and saddle\",\"x\":{\"min\":-2,\"max\":2,\"steps\":20},\"y\":{\"min\":-2,\"max\":2},\"series\":[{\"name\":\"Bowl\",\"expression\":\"a*(x^2+y^2)\",\"color\":\"#39aa7a\"},{\"name\":\"Saddle\",\"expression\":\"x^2-y^2\",\"color\":\"#ad8be3\"}],\"sliders\":[{\"name\":\"a\",\"min\":0.1,\"max\":2,\"value\":1}]}\n```\n\n[Back to exploring](#learn-by-exploring)\n"""

def local_path(value: str) -> Path:
    url = QUrl(value)
    return Path(url.toLocalFile() if url.isLocalFile() else value).expanduser().resolve()

class Session(QObject):
    """One ordered persistence stream for every native window in the application."""
    changed = Signal()
    def __init__(self,isolated=False):
        super().__init__()
        self.data = Path(tempfile.mkdtemp(prefix="supermd-test-")) if isolated else Path(QStandardPaths.writableLocation(QStandardPaths.AppDataLocation))/"qt-studio"
        self.data.mkdir(parents=True,exist_ok=True)
        self.font_store = FontStore(self.data)
        self.python_outputs = PythonOutputs(self.data/"derived-python")
        self.writes = concurrent.futures.ThreadPoolExecutor(max_workers=1,thread_name_prefix="supermd-save")
        self.settings = copy.deepcopy(DEFAULTS)
        self.recent = []
        self.drafts = {}
        self.windows = {}
        self.initial_recovery = []
        try:
            stored = json.loads((self.data/"settings.json").read_text(encoding="utf-8"))
            self.settings.update({k:v for k,v in stored["settings"].items() if k in DEFAULTS})
            self.settings["pdf"] = {**DEFAULT_PDF, **self.settings.get("pdf", {})}
            self.recent = [p for p in stored.get("recent",[]) if isinstance(p,str)][:30]
        except (OSError,ValueError,KeyError,TypeError,AttributeError): pass
        try:
            recovered = json.loads((self.data/"recovery.json").read_text(encoding="utf-8"))
            for tab in recovered:
                if not isinstance(tab,dict) or any(not isinstance(tab.get(key),str) for key in ("name","content","path","saved")):
                    raise ValueError("Invalid draft recovery")
                bundle(tab["content"],tab.get("assets",{}))
                self.initial_recovery.append(tab)
        except (OSError,ValueError,TypeError): pass

class Studio(QObject):
    changed = Signal()
    readerLoad = Signal(str)
    readerCall = Signal(str)
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
    noteLocationPickerRequested = Signal()
    flushFailed = Signal(bool)

    def __init__(self, isolated: bool = False, session: Session | None = None):
        super().__init__()
        self.setObjectName("studio")
        self._brand_svg = (ROOT/"public/brand-mark-fixed.svg").read_text(encoding="utf-8")
        self.pool = concurrent.futures.ThreadPoolExecutor(max_workers=3, thread_name_prefix="supermd")
        self.session = session or Session(isolated)
        self.session.changed.connect(lambda:self._emit())
        self.writes = self.session.writes
        self.window_id = uuid.uuid4().hex
        self.session.windows[self.window_id] = self
        self.host_window = None
        self.retired = False
        self.completed.connect(self._complete)
        self.data = self.session.data
        self.settings = self.session.settings
        self.update_status=""
        self.update_info=None
        self.update_path=""
        self.update_running=False
        if not isolated and len(self.session.windows)==1:QTimer.singleShot(6000,lambda:self.checkUpdates(True) if self.settings.get("checkUpdates") and not self.retired else None)
        self.tabs: list[dict] = []
        self.closed_tabs: list[dict] = []
        self.note_watcher = QFileSystemWatcher(self)
        self.note_watcher.fileChanged.connect(self._external_note_changed)
        self.note_watcher.directoryChanged.connect(self._external_note_changed)
        self.external_paths = set()
        self.note_watch_paths = None
        self.note_file_stamps = {}
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
        self.message = ""
        self.ready = False
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
        self.saving = set()
        self.tabs = [{**tab,"id":uuid.uuid4().hex} for tab in self.session.initial_recovery]
        self.session.initial_recovery = []
        self.session.drafts[self.window_id] = [dict(t) for t in self.tabs]
        if not self.tabs:
            self.tabs.append(self._note("Welcome.md", SAMPLE, saved=SAMPLE))
        self.active = self.tabs[0]["id"]
        self._refresh_theme()

    @property
    def recent(self): return self.session.recent

    @recent.setter
    def recent(self,value): self.session.recent = value

    def _note(self, name: str, content: str = "", path: str = "", saved: str = "", assets: dict | None = None, portable: bool = False):
        return {"id": uuid.uuid4().hex, "name": name, "content": content, "path": path, "saved": saved, "assets": assets or {}, "portable": portable}

    def _current(self):
        return next(t for t in self.tabs if t["id"] == self.active)

    def _emit(self, load=True):
        if self.retired: return
        self._watch_notes()
        self.changed.emit()
        if load and self.ready:
            tab = self._current()
            colors = self._colors()
            self.readerLoad.emit(json.dumps({"id": tab["id"], "content": tab["content"], "path": tab["path"] or tab["id"], "mode": self.mode, "dark": self._dark(), "fullscreen": self.fullscreen, "font": self.settings["font"], "size": self.settings["size"], "widthPercent": self.settings["widthPercent"], "lineHeight":self.settings["lineHeight"], "zoom": self.settings["fullZoom" if self.fullscreen else "normalZoom"], "motion": self.settings["motion"], "python": self.settings["python"], "colors": colors, "viewState": tab.pop("viewState", None)}))

    def _dark(self):
        theme = self.settings["fullTheme" if self.fullscreen else "theme"]
        return tokens(theme,self.system_dark,self.system_colors,self.system_mode,self.settings["accent"])[0]

    def _colors(self):
        return tokens(self.settings["fullTheme" if self.fullscreen else "theme"],self.system_dark,self.system_colors,self.system_mode,self.settings["accent"])[1]

    def _watch_notes(self,force=False):
        paths=tuple(sorted({tab["path"] for tab in self.tabs if tab["path"]}))
        if not force and paths==self.note_watch_paths:return
        self.note_watch_paths=paths
        self.note_file_stamps={path:stamp for path,stamp in self.note_file_stamps.items() if path in paths}
        targets={str(path) for tab in self.tabs if tab["path"] for path in (Path(tab["path"]),Path(tab["path"]).parent) if path.exists()}
        watched=set(self.note_watcher.files()+self.note_watcher.directories())
        if watched-targets:self.note_watcher.removePaths(list(watched-targets))
        if targets-watched:self.note_watcher.addPaths(list(targets-watched))

    def _external_note_changed(self,path):
        if self.retired:return
        self.external_paths.add(path)
        self.external_timer.start(250)

    def _refresh_external_notes(self):
        if self.retired:return
        changed,self.external_paths=self.external_paths,set()
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
        self.preference_timer.stop()
        self.theme_timer.stop()
        self.theme_debounce.stop()
        self.recovery_timer.stop()
        self.autosave_timer.stop()
        self.flush_timer.stop()
        self.external_timer.stop()
        self._recover()
        self.retired = True
        self.session.windows.pop(self.window_id, None)
        if self.system_preferences.state() != QProcess.NotRunning:
            self.system_preferences.terminate()
            self.system_preferences.waitForFinished(300)

    @Property(str, notify=changed)
    def snapshot(self):
        tab = self._current()
        return json.dumps({"tabs": [{"id": t["id"], "name": t["name"], "path": t["path"], "dirty": t["content"] != t["saved"]} for t in self.tabs], "active": self.active, "name": tab["name"], "outline": tab.get("outline", []), "portable": tab["portable"], "folder": self.folder, "files": self.files, "recent": self.recent, "settings": self.settings, "mode": self.mode, "fullscreen": self.fullscreen, "readerOverlay": self.reader_overlay, "imageOverlay": self.image_overlay, "dark": self._dark(), "zoom": self.settings["fullZoom" if self.fullscreen else "normalZoom"], "busy": self.busy > 0, "message": self.message, "colors": self._colors()})

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

    @Slot()
    def downloadUpdate(self):
        if self.update_running or not self.update_info:return
        self.update_running=True;self.update_status="Downloading and verifying update…";self._emit(False)
        info=dict(self.update_info)
        def done(path,error):
            self.update_running=False
            if error:self.update_status="Update download failed: "+error;return
            self.update_path=path;self.update_status="Verified update ready. Save your work, then open the installer."
        self._submit(lambda:updates.download(info,self.data/"updates"),done,False)

    @Slot()
    @Slot(bool)
    def checkUpdates(self,automatic=False):
        if self.update_running:return
        self.update_running=True;self.update_status="Checking published releases…";self._emit(False)
        def done(info,error):
            self.update_running=False
            if error:self.update_status="Couldn't check updates. Your notes still work offline.";return
            if not info or not self.update_info or info["version"]!=self.update_info["version"]:self.update_path=""
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
        self._submit(lambda:updates.release_info(updates.bounded_json(updates.API),self.appVersion),done,False)

    @Slot()
    def installUpdate(self):
        if not self.update_path:return
        # Never terminate windows, discard recovery, or overwrite package-managed
        # installations. The OS installer (or parallel AppImage) owns activation.
        if self.update_path.endswith('.AppImage'):
            QProcess.startDetached(self.update_path,[])
        else:QDesktopServices.openUrl(QUrl.fromLocalFile(self.update_path))

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
        svg = svg.replace("#d8e3ff",colors["primary-container"]).replace("#244779",colors["on-primary-container"])
        return "data:image/svg+xml;base64,"+base64.b64encode(svg.encode()).decode()

    def _submit(self, action, done, busy=True, executor=None):
        if busy:
            self.busy += 1
            self._emit(False)
        future = (executor or self.pool).submit(action)
        def completed(f):
            try:
                self.completed.emit((done, f.result(), None, busy))
            except Exception as error:
                self.completed.emit((done, None, str(error), busy))
        future.add_done_callback(completed)

    @Slot(object)
    def _complete(self, result):
        done, value, error, busy = result
        if busy:
            self.busy -= 1
        if error:
            self.message = error
            self.pending_close = ""
        done(value, error)
        self._emit(False)

    def _preferences(self):
        if self.retired or getattr(self.writes, "_shutdown", False): return
        data = json.dumps({"settings": self.settings, "recent": self.recent}).encode()
        self._submit(lambda: atomic_write(self.data / "settings.json", data), lambda *_: None, False,self.writes)
        self.session.changed.emit()

    def _recover(self):
        # Snapshot only unsaved tabs. Asset bytes stay in recovery, never in displayed source.
        self.session.drafts[self.window_id] = [copy.deepcopy({key: value for key, value in t.items() if key != "viewState"}) for t in self.tabs if t["content"] != t["saved"] and (t["path"] or t["content"].strip() or t["assets"])]
        drafts = [tab for tabs in self.session.drafts.values() for tab in tabs]
        self._submit(lambda: atomic_json(self.data / "recovery.json", drafts), lambda *_: None, False,self.writes)

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
        path = local_path(value)
        if path.is_dir():
            self.openFolder(str(path))
            return
        found = next((t for t in self.tabs if t["path"] == str(path)), None)
        if found:
            self.selectTab(found["id"])
            return
        def finished(result, error):
            if error:
                return
            content, assets, portable = result
            note = self._note(path.name, content, str(path), content, assets, portable)
            self.tabs.append(note)
            self.active = note["id"]
            self.settings["welcomed"] = True
            self.recent = [str(path)] + [p for p in self.recent if p != str(path)][:29]
            self._preferences()
            self._emit()
        self._submit(lambda: open_note(path), finished)

    @Slot()
    def newNote(self):
        note = self._note("Untitled.md")
        self.tabs.append(note)
        self.active = note["id"]
        self._emit()

    @Slot(str)
    def selectTab(self, id):
        if id!=self.active and any(t["id"] == id for t in self.tabs):
            self.active = id
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
        note=self.closed_tabs.pop()
        existing=next((t for t in self.tabs if note["path"] and t["path"]==note["path"]),None)
        if existing:self.selectTab(existing["id"]);return
        self.tabs.append(note);self.active=note["id"];self._emit()

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
                    if directory or child.suffix.lower() in (".md", ".smd", ".fmd", ".markdown"):
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
        self.fullscreen = value
        self._emit()

    @Slot(float)
    def setZoom(self, value):
        zoom = max(40, min(300, round(value)))
        self.settings["fullZoom" if self.fullscreen else "normalZoom"] = zoom
        self.readerCall.emit(f"window.supermdSetZoom?.({zoom})")
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
        if key in ("motion","welcomed","autosave","checkUpdates","autoUpdate") and not isinstance(value,bool): return
        if key in ("font","python") and (not isinstance(value,str) or not value.strip() or len(value)>2048): return
        if key in ("size","width","widthPercent","lineHeight","normalZoom","fullZoom") and (not isinstance(value,(int,float)) or isinstance(value,bool) or not math.isfinite(value)): return
        if key == "pdf" and (not isinstance(value,dict) or set(value) != set(DEFAULT_PDF)): return
        if key == "size": value = max(6, min(32, float(value)))
        if key == "width": value = max(0, min(5000, int(value)))
        if key == "widthPercent": value = max(50,min(100,float(value)))
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
        if tab["content"] != tab["saved"] and (tab["path"] or tab["content"].strip() or tab["assets"]):
            self.pending_close = id
            self.selectTab(id)
            self.closeRequested.emit(tab["name"])
        else:
            self._remove_tab(id)

    def _remove_tab(self, id):
        index = next(i for i,t in enumerate(self.tabs) if t["id"] == id)
        removed=self.tabs.pop(index)
        if removed["content"].strip() or removed["path"]:
            self.closed_tabs.append(removed)
            while len(self.closed_tabs)>12 or sum(len(t["content"])+len(t["saved"])+sum(len(v) for v in t["assets"].values()) for t in self.closed_tabs)>4_000_000:self.closed_tabs.pop(0)
        if not self.tabs:
            self.tabs.append(self._note("Untitled.md"))
        if self.active == id:
            self.active = self.tabs[min(index, len(self.tabs)-1)]["id"]
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
        self.pending_save_as = ""
        self.pending_export = str(local_path(value))
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
        try:
            args = json.loads(raw)
            tab = self._current()
            if command == "reader_ready": self.ready = True; self._emit(); self.replied.emit(id,"true",""); return
            if command == "reader_overlay_changed": self.reader_overlay = bool(args.get("open")); self.image_overlay = bool(args.get("image")); self._emit(False); self.replied.emit(id,"true",""); return
            if command == "document_outline":
                target = next((t for t in self.tabs if t["id"] == args.get("id")), None)
                headings = args.get("headings", [])
                if not isinstance(headings, list) or len(headings) > 2000: raise ValueError("Invalid outline")
                if target:
                    target["outline"] = headings
                    if not target["path"] and target["name"].startswith("Untitled") and headings:
                        title = str(headings[0].get("title", "")).strip()
                        title = "".join(c for c in title if c not in '/\\:*?"<>|' and ord(c) >= 32).strip(". ")[:120]
                        if title: target["name"] = title + (".smd" if target["portable"] else ".md")
                self._emit(False); self.replied.emit(id,"true",""); return
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
            if command == "document_changed":
                target = next((t for t in self.tabs if t["id"] == args["id"]), None)
                if target: target["content"] = args["content"]
                self.recovery_timer.start(800)
                self.autosave_timer.start(900)
                self._emit(False)
                self.replied.emit(id,"true",""); return
            if command == "zoom_changed":
                self.settings["fullZoom" if args.get("fullscreen", self.fullscreen) else "normalZoom"] = max(40,min(300,args["zoom"]))
                self.preference_timer.start(500)
                self._emit(False); self.replied.emit(id,"true",""); return
            if command == "export_failed": self.pending_export = self.pending_save_as = ""; self.message = args["error"]; self._emit(False); self.replied.emit(id,"true",""); return
            if command == "request_fmd_export": self.exportRequested.emit("smd"); self.replied.emit(id,"true",""); return
            reference = args.get("id") or args.get("documentPath")
            if reference:
                tab = next((t for t in self.tabs if reference in (t["id"],t["path"])),None)
                if tab is None: raise ValueError("The note for this operation is no longer open")
            captured = dict(tab)
            captured["assets"] = dict(tab["assets"])
            output = self.pending_export
            save_as = self.pending_save_as
            python = self.settings["python"]
            def work():
                if command == "load_asset": return self._asset(captured,args["source"])
                if command == "load_font": return self.session.font_store.reader(args["family"])
                if command == "cache_python_output": self.session.python_outputs.store(args["source"],args["result"]); return True
                if command == "load_python_output": return self.session.python_outputs.load(args["source"])
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
                if command == "run_python": return self._python(python, args["code"])
                if command == "export_markdown_native":
                    if not output or not isinstance(args["content"], str) or len(args["content"].encode()) > 20_000_000: raise ValueError("Choose a Markdown destination for a note under 20 MB")
                    atomic_write(Path(output), args["content"].encode())
                    return {"path": output}
                if command == "export_fmd_native":
                    target = Path(captured["path"]) if args.get("save") else Path(output)
                    atomic_write(target,json.dumps(bundle(args["content"],args["assets"]),ensure_ascii=False).encode())
                    return {"path":str(target)}
                if command == "export_pdf_native":
                    engine = self._engine()
                    args["assets"].update(self.session.font_store.pdf_assets(args["options"]["fontFamily"]))
                    result = subprocess.run([str(engine),"export-json",output], input=json.dumps(args), text=True, capture_output=True, timeout=120)
                    if result.returncode: raise ValueError(result.stderr.strip() or "PDF export failed")
                    return {"path":output}
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
        opener = urllib.request.build_opener(PublicRedirect())
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
        parsed = urllib.parse.urlparse(url)
        if parsed.scheme not in ("http","https") or not parsed.hostname or parsed.username or parsed.password:
            raise ValueError("Use a public web URL")
        addresses = socket.getaddrinfo(parsed.hostname,parsed.port or (443 if parsed.scheme=="https" else 80),type=socket.SOCK_STREAM)
        if not addresses or any(not ipaddress.ip_address(address[4][0]).is_global for address in addresses):
            raise ValueError("Private, local and reserved network addresses are not allowed")

    def _engine(self):
        executable = "smd-engine.exe" if sys.platform == "win32" else "smd-engine"
        candidates = [ROOT / "desktop" / executable, ROOT / "smd-core" / "target" / "release" / executable, ROOT / "smd-core" / "target" / "debug" / executable]
        for path in candidates:
            if path.is_file(): return path
        raise ValueError("Native PDF engine is not installed. Build smd-core's smd-engine binary.")

    def _python(self, executable, code):
        if len(code) > 200_000: raise ValueError("Python cell exceeds 200 KB")
        # Explicit Run only. Python is trusted local code, not a sandbox.
        wrapper = """import sys,json,io,base64,contextlib,traceback
payload=json.load(sys.stdin)
out=io.StringIO(); err=io.StringIO(); images=[]; ok=True
try:
 import matplotlib
 matplotlib.use('Agg')
 import matplotlib.pyplot as plt
 with contextlib.redirect_stdout(out),contextlib.redirect_stderr(err):
  exec(compile(payload['code'],'<Super MD cell>','exec'),{'__name__':'__main__'})
 for number in plt.get_fignums()[:16]:
  data=io.BytesIO(); plt.figure(number).savefig(data,format='svg',bbox_inches='tight')
  images.append('data:image/svg+xml;base64,'+base64.b64encode(data.getvalue()).decode())
 plt.close('all')
except BaseException:
 ok=False; traceback.print_exc(file=err)
print(json.dumps({'stdout':out.getvalue()[:200000],'stderr':err.getvalue()[:200000],'images':images,'ok':ok}))
"""
        if not executable:
            raise ValueError("Choose a system Python or virtual environment in Settings first.")
        environment = os.environ.copy()
        if getattr(sys,"frozen",False) and sys.platform.startswith("linux"):
            # An external interpreter must not load our embedded Python/Qt libraries.
            if "LD_LIBRARY_PATH_ORIG" in environment:
                environment["LD_LIBRARY_PATH"] = environment["LD_LIBRARY_PATH_ORIG"]
            else:
                environment.pop("LD_LIBRARY_PATH",None)
        process = subprocess.run([executable,"-c",wrapper],input=json.dumps({"code":code}),text=True,capture_output=True,timeout=90,env=environment)
        if process.returncode: raise ValueError(process.stderr[:2000])
        return json.loads(process.stdout)
