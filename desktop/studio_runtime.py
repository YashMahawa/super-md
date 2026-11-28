"""Runtime domain helpers for Studio: app updates, desktop integration, storage, and Python setup."""
from __future__ import annotations
import json, sys, threading
from pathlib import Path
from PySide6.QtCore import QObject, QProcess, QStandardPaths, QTimer, QUrl
from PySide6.QtGui import QDesktopServices, QGuiApplication

if __package__:
    from . import app_integration, python_runtime, updates
    from .core.paths import resource_root
    from .storage_inspector import clear_storage_category, inspect_storage
else:
    import app_integration, python_runtime, updates
    from core.paths import resource_root
    from storage_inspector import clear_storage_category, inspect_storage

def _app_version(studio_obj) -> str:
    return studio_obj.appVersion if hasattr(studio_obj, "appVersion") else app_version(studio_obj)

def _desktop_integration_available(studio_obj, app_integration_mod=app_integration) -> bool:
    return bool(studio_obj.desktopIntegrationAvailable) if hasattr(studio_obj, "desktopIntegrationAvailable") else app_integration_mod.available()

def _begin_update_task(studio_obj, status_text: str) -> bool:
    if studio_obj.update_running:
        return False
    studio_obj.update_running, studio_obj.update_status = True, status_text
    studio_obj._emit(False)
    return True

def _submit_update_task(studio_obj, status_text: str, action, on_success, error_prefix: str) -> bool:
    if not _begin_update_task(studio_obj, status_text):
        return False
    def done(value, error):
        studio_obj.update_running = False
        if error:
            studio_obj.update_status = error_prefix + str(error)
            return
        on_success(value)
    studio_obj._submit(action, done, False)
    return True

def _start_python_task(studio_obj, status_text: str) -> bool:
    if studio_obj.retired or studio_obj.python_busy or getattr(studio_obj.pool, "_shutdown", False):
        return False
    studio_obj.python_busy, studio_obj.python_status = True, status_text
    studio_obj._emit(False)
    return True

def _submit_python_install(studio_obj, status_text: str, run_fn, ready_status: str = "", python_runtime_mod=python_runtime) -> None:
    if not _start_python_task(studio_obj, status_text):
        return
    progress = studio_obj.pythonProgress.emit if hasattr(studio_obj, "pythonProgress") else (lambda _text: None)
    def done(result, error):
        studio_obj.python_busy = False
        if error:
            studio_obj.python_status = error
            studio_obj._emit(False)
            return
        studio_obj.settings["python"] = result
        studio_obj._preferences()
        if ready_status:
            studio_obj.python_status = ready_status
            studio_obj._emit()
            studio_obj.python_busy = False
        studio_obj.refreshPython()
        if ready_status:
            studio_obj.python_status = ready_status
    studio_obj._submit(lambda: run_fn(python_runtime_mod, progress), done, False)

def app_version(studio_obj=None, *, root: Path | None = None, frozen: bool | None = None) -> str:
    base = getattr(studio_obj, "ROOT", None) or root or resource_root()
    is_frozen = getattr(sys, "frozen", False) if frozen is None else frozen
    return json.loads((base / ("desktop/build-info.json" if is_frozen else "package.json")).read_text(encoding="utf-8"))["version"]

def clear_storage_category_action(studio_obj, category: str, *, clear_storage_fn=clear_storage_category) -> None:
    if category not in ("execution-results", "update-state"):
        studio_obj.storage_cleanup_status = "This storage category is protected."
        studio_obj._emit(False)
        return
    in_use = category == "update-state" and (studio_obj.update_running or studio_obj.update_path)
    if studio_obj.retired or studio_obj.storage_busy or studio_obj.storage_cleanup_busy or in_use:
        studio_obj.storage_cleanup_status = "Cleanup is unavailable while storage or updates are in use."
        studio_obj._emit(False)
        return
    studio_obj.storage_cleanup_busy, studio_obj.storage_cleanup_status = True, ""
    studio_obj._emit(False)
    def done(result, error):
        studio_obj.storage_cleanup_busy = False
        studio_obj.storage_cleanup_status = "Cleanup failed; app files were not intentionally changed." if error or not result else "Temporary app data cleared. Notes and recovery preserved."
        studio_obj._emit(False)
        studio_obj.inspectStorage()
    studio_obj._submit(lambda: clear_storage_fn(studio_obj.data, category), done, False)

def open_latest_github_release(studio_obj, *, updates_mod=updates, open_url_fn=QDesktopServices.openUrl) -> None:
    if not open_url_fn(QUrl(updates_mod.REPO + "/releases/latest")):
        studio_obj.message = "Could not open the latest GitHub release in your browser."
    studio_obj._emit(False)

def inspect_storage_action(studio_obj, *, inspect_storage_fn=inspect_storage) -> None:
    if studio_obj.retired or studio_obj.storage_busy:
        return
    cancel_event = threading.Event()
    studio_obj._storage_cancel_event, studio_obj.storage_busy = cancel_event, True
    studio_obj._storage_report = json.dumps({"status": "scanning", "cancelled": False, "truncated": False, "scannedEntries": 0, "categories": []})
    studio_obj._emit(False)
    def done(report, error):
        if studio_obj._storage_cancel_event is not cancel_event:
            return
        studio_obj._storage_cancel_event, studio_obj.storage_busy = None, False
        if error or not isinstance(report, dict):
            # Keep exception text out of UI/report: filesystem errors may contain private local paths.
            report = {"status": "partial", "cancelled": cancel_event.is_set(), "truncated": False,
                      "scannedEntries": 0, "categories": [], "message": "Some app data could not be inspected."}
        studio_obj._storage_report = json.dumps(report, separators=(",", ":"))
        studio_obj._emit(False)
    studio_obj._submit(lambda: inspect_storage_fn(studio_obj.data, cancel_event), done, False)

def cancel_storage_inspection(studio_obj) -> None:
    if studio_obj._storage_cancel_event is not None:
        studio_obj._storage_cancel_event.set()

def desktop_integration_available(_studio_obj=None, *, app_integration_mod=app_integration) -> bool:
    return app_integration_mod.available()

def restore_update(studio_obj, *, updates_mod=updates, single_shot_fn=QTimer.singleShot) -> None:
    studio_obj.update_running = True
    def done(saved, _error):
        studio_obj.update_running = False
        if saved:
            studio_obj.update_info, studio_obj.update_path = saved["release"], saved["path"]
            studio_obj.update_status = "Verified update ready in Downloads."
        if studio_obj.settings.get("checkUpdates"):
            single_shot_fn(6000, lambda: studio_obj.checkUpdates(True) if not studio_obj.retired else None)
    studio_obj._submit(lambda: updates_mod.load_ready(studio_obj.data / "updates", _app_version(studio_obj)), done, False)

def set_desktop_integration(studio_obj, enabled: bool, *, app_integration_mod=app_integration) -> None:
    if not _desktop_integration_available(studio_obj, app_integration_mod) or studio_obj.update_running:
        return
    if not enabled:
        studio_obj.setting("desktopIntegration", "false")
        return
    def on_success(_path):
        studio_obj.setting("desktopIntegration", "true")
        studio_obj.update_status = "Added to Applications and Open With. Your file defaults are unchanged."
    _submit_update_task(studio_obj, "Adding Super MD to your applications…", lambda: app_integration_mod.integrate_current(_app_version(studio_obj)), on_success, "Desktop integration failed: ")

def download_update(studio_obj, *, updates_mod=updates, writable_location_fn=QStandardPaths.writableLocation) -> None:
    if studio_obj.update_running or not studio_obj.update_info or studio_obj.update_path:
        return
    info = dict(studio_obj.update_info)
    loc = writable_location_fn(QStandardPaths.StandardLocation.DownloadLocation)
    downloads = Path(loc or str(Path.home() / "Downloads")) / "Super MD Updates"
    def on_success(path):
        studio_obj.update_path = path
        studio_obj.update_status = "Verified update ready. Save your work, then open the installer."
    _submit_update_task(studio_obj, "Downloading and verifying update…", lambda: updates_mod.download(info, downloads, studio_obj.data / "updates"), on_success, "Update download failed: ")

def check_updates(studio_obj, automatic: bool = False, *, updates_mod=updates, root: Path | None = None,
                  sys_platform: str | None = None, gui_app_cls=QGuiApplication) -> None:
    if not _begin_update_task(studio_obj, "Checking published releases…"):
        return
    platform_name = sys.platform if sys_platform is None else sys_platform
    def done(info, error):
        studio_obj.update_running = False
        if error:
            studio_obj.update_status = updates_mod.check_failure(error)
            if not automatic:
                studio_obj.message = studio_obj.update_status
            return
        # Offline/repeated checks must not forget a verified ready installer.
        if info and studio_obj.update_info and info["version"] == studio_obj.update_info["version"] and studio_obj.update_path:
            studio_obj.update_status = "Verified Super MD " + info["version"] + " is already downloaded."
            return
        if not info and studio_obj.update_path:
            return
        studio_obj.update_path, studio_obj.update_info = "", info
        if not info:
            studio_obj.update_status = "You're on the latest published version."
            return
        studio_obj.update_status = studio_obj.message = "Super MD " + info["version"] + " is available."
        if automatic:
            try:
                from PySide6.QtGui import QIcon
                from PySide6.QtWidgets import QApplication, QSystemTrayIcon
                if isinstance(gui_app_cls.instance(), QApplication) and QSystemTrayIcon.isSystemTrayAvailable():
                    base = getattr(studio_obj, "ROOT", None) or root or resource_root()
                    parent = studio_obj if isinstance(studio_obj, QObject) else None
                    studio_obj.update_tray = QSystemTrayIcon(QIcon(str(base / "public/brand-mark-fixed.svg")), parent)
                    studio_obj.update_tray.setToolTip("Super MD updates")
                    studio_obj.update_tray.show()
                    studio_obj.update_tray.showMessage("Super MD update", studio_obj.update_status)
            except RuntimeError:
                pass
        if studio_obj.settings.get("autoUpdate"):
            studio_obj.downloadUpdate()
    def check():
        try:
            linux_kind = updates_mod.linux_install_kind() if platform_name.startswith("linux") else "appimage"
            return updates_mod.release_info(updates_mod.bounded_json(updates_mod.API), _app_version(studio_obj), linux_kind=linux_kind), None
        except Exception as failure:
            return None, failure
    studio_obj._submit(check, lambda result, error: done(*(result or (None, error))), False)

def background_enabled(studio_obj) -> bool:
    if getattr(studio_obj.session, "update_installed", False):
        return False
    service = getattr(studio_obj.session, "background", None)
    return bool(service and service.enabled and not service.quitting)

def python_bundled(_studio_obj=None, *, python_runtime_mod=python_runtime) -> bool:
    return python_runtime_mod.bundled_available()

def python_folders(studio_obj) -> list[str]:
    return [p for p in [studio_obj.folder, *(str(Path(t["path"]).parent) for t in studio_obj.tabs if t.get("path"))] if p]

def choose_default_python(studio_obj, emit: bool = True, *, python_runtime_mod=python_runtime) -> None:
    if studio_obj.retired or studio_obj.settings.get("python"):
        return
    path = python_runtime_mod.default_python(studio_obj.data / "python-env")
    if path:
        studio_obj.settings["python"] = path
        studio_obj._preferences(notify=emit)
    if emit:
        studio_obj._emit(False)

def python_progress(studio_obj, text: str) -> None:
    studio_obj.python_status = text
    studio_obj._emit(False)

def refresh_python(studio_obj, *, python_runtime_mod=python_runtime) -> None:
    if not _start_python_task(studio_obj, "Looking for Python installations"):
        return
    managed = studio_obj.data / "python-env"
    folders = tuple(studio_obj._python_folders() if hasattr(studio_obj, "_python_folders") else python_folders(studio_obj))
    def done(choices, error):
        studio_obj.python_busy, studio_obj.python_choices = False, choices or []
        if error:
            studio_obj.python_status = error
        elif not studio_obj.python_choices:
            studio_obj.python_status = "No Python found. Use Set up Python to create one, or install Python 3."
        elif not any(c["matplotlib"] for c in studio_obj.python_choices):
            studio_obj.python_status = "Python found, but numpy and matplotlib are missing. Set up Python installs both in a private environment."
        else:
            studio_obj.python_status = ""
        studio_obj._emit(False)
    studio_obj._submit(lambda: python_runtime_mod.discover(managed, folders), done, False)

def install_python_packages(studio_obj, path: str, *, python_runtime_mod=python_runtime) -> None:
    _submit_python_install(studio_obj, "Preparing to install numpy and matplotlib", lambda rt, progress: rt.install_packages(path, progress), python_runtime_mod=python_runtime_mod)

def setup_python(studio_obj, *, python_runtime_mod=python_runtime) -> None:
    managed = studio_obj.data / "python-env"
    _submit_python_install(studio_obj, "Preparing Python setup", lambda rt, progress: rt.setup_environment(managed, progress),
                           ready_status="Python with numpy and matplotlib is ready", python_runtime_mod=python_runtime_mod)

def install_update(studio_obj, *, updates_mod=updates, app_integration_mod=app_integration,
                   open_url_fn=QDesktopServices.openUrl, start_detached_fn=QProcess.startDetached) -> None:
    if not studio_obj.update_path or studio_obj.update_running:
        return
    try:
        kind = updates_mod.installer_kind(studio_obj.update_info)
    except (TypeError, ValueError, KeyError):
        studio_obj.update_status = "Update information is invalid. Check for updates again."
        studio_obj._emit(False)
        return
    if kind == "appimage" and not _desktop_integration_available(studio_obj, app_integration_mod):
        studio_obj.update_status = "This installation is package-managed. Install the DEB/RPM from the release page using your package manager."
        open_url_fn(QUrl(updates_mod.REPO + "/releases/latest"))
        studio_obj._emit(False)
        return
    def prepare():
        saved = updates_mod.load_ready(studio_obj.data / "updates", _app_version(studio_obj))
        if not saved or saved["path"] != studio_obj.update_path:
            raise ValueError("Installer changed or is missing. Download the update again.")
        prepared_kind = updates_mod.installer_kind(saved["release"])
        if not studio_obj.update_info or saved["release"]["version"] != studio_obj.update_info.get("version"):
            raise ValueError("The verified installer no longer matches the selected update. Check for updates again.")
        if prepared_kind == "appimage":
            return app_integration_mod.install_appimage(studio_obj.update_path, saved["release"]["version"], studio_obj.settings.get("desktopIntegration", False)), prepared_kind
        return studio_obj.update_path, prepared_kind
    def on_success(prepared):
        path, prepared_kind = prepared
        if prepared_kind == "appimage":
            studio_obj.session.update_installed = True
            studio_obj.session.changed.emit()
            studio_obj.update_status = "Update installed. Close and reopen Super MD to use it. Your previous version and downloaded installer have been kept."
        else:
            opened = start_detached_fn(path, []) if prepared_kind == "windows" else open_url_fn(QUrl.fromLocalFile(path))
            opened = opened[0] if isinstance(opened, tuple) else opened
            if not opened:
                studio_obj.update_status = "Could not open the verified installer. It is still available in Downloads."
            else:
                studio_obj.session.update_installed = True
                studio_obj.session.changed.emit()
                if prepared_kind in ("deb", "rpm"):
                    studio_obj.update_status = "Package installer opened. Confirm the update there; Super MD will not request elevated permissions automatically."
                elif prepared_kind == "macos":
                    studio_obj.update_status = "Disk image opened. Drag Super MD into Applications and confirm replacement to update."
                else:
                    studio_obj.update_status = "Installer opened. Follow its instructions; the download is kept in Downloads."
        studio_obj._emit(False)
    _submit_update_task(studio_obj, "Verifying and preparing installation…", prepare, on_success, "Update installation failed: ")
