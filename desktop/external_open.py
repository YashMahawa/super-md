"""Desktop external file-open routing across Qt FileOpen events and single-instance IPC."""
from __future__ import annotations

from PySide6.QtCore import QEvent, QObject
from PySide6.QtGui import QGuiApplication, QWindow

try:
    from .studio import local_path
except ImportError:
    from studio import local_path


class _WindowActivationTracker(QObject):
    """Per-window activation listener (never installed globally on QApplication)."""

    def __init__(self, router: ExternalOpenRouter, studio, window: QObject):
        super().__init__(window)
        self._router = router
        self._studio = studio
        self.window = window
        window.installEventFilter(self)
        if hasattr(window, "activeChanged"):
            window.activeChanged.connect(self._on_active_changed)
        if hasattr(window, "visibleChanged"):
            window.visibleChanged.connect(self._on_visible_changed)

    def _on_active_changed(self, *_) -> None:
        if getattr(self._studio, "retired", False):
            return
        is_active = self.window.isActive() if hasattr(self.window, "isActive") else False
        if is_active:
            self._router.mark_active(self._studio)

    def _on_visible_changed(self, *_) -> None:
        if getattr(self._studio, "retired", False):
            return
        is_visible = self.window.isVisible() if hasattr(self.window, "isVisible") else False
        if is_visible:
            self._router.mark_active(self._studio)

    def eventFilter(self, watched: QObject, event: QEvent) -> bool:
        if watched is self.window and not getattr(self._studio, "retired", False):
            if event.type() in (QEvent.Type.WindowActivate, QEvent.Type.FocusIn):
                self._router.mark_active(self._studio)
        return False


class ExternalOpenRouter:
    """Routes external file/folder open requests to an existing tab or last active eligible window."""

    def __init__(self, studios: list, create_window, *, app: QGuiApplication | None = None):
        self._studios = studios
        self._create_window = create_window
        self._app = app
        self._seq = 0
        self._active_order: dict[str, int] = {}
        self._trackers: dict[str, _WindowActivationTracker] = {}
        if app is not None and hasattr(app, "focusWindowChanged"):
            app.focusWindowChanged.connect(self._on_focus_window_changed)

    def _on_focus_window_changed(self, focus_window) -> None:
        if focus_window is None:
            return
        for studio in list(self._studios):
            if not getattr(studio, "retired", False) and getattr(studio, "host_window", None) is focus_window:
                self.mark_active(studio)
                break

    def register_window(self, studio, *, activated: bool | None = None) -> None:
        if studio is None or getattr(studio, "retired", False):
            return
        window_id = studio.window_id
        window = getattr(studio, "host_window", None)
        existing = self._trackers.get(window_id)
        if window is not None and (existing is None or existing.window is not window):
            if existing is not None:
                try:
                    existing.window.removeEventFilter(existing)
                except RuntimeError:
                    pass
            self._trackers[window_id] = _WindowActivationTracker(self, studio, window)
        if activated is None:
            activated = self._is_window_visible(studio)
        if activated:
            self.mark_active(studio)
        else:
            self._active_order.setdefault(window_id, 0)

    def mark_active(self, studio) -> None:
        if studio is None or getattr(studio, "retired", False):
            return
        self._seq += 1
        self._active_order[studio.window_id] = self._seq

    def _current_focus_window(self):
        app = self._app or QGuiApplication.instance()
        if app is not None and hasattr(app, "focusWindow"):
            return app.focusWindow()
        return None

    @staticmethod
    def _is_window_visible(studio) -> bool:
        window = getattr(studio, "host_window", None)
        if window is None:
            return True
        if hasattr(window, "isVisible"):
            return bool(window.isVisible())
        return True

    @staticmethod
    def _is_window_closing(studio) -> bool:
        if studio is None or getattr(studio, "retired", False):
            return True
        if getattr(studio, "dropBlocked", False):
            return True
        window = getattr(studio, "host_window", None)
        if window is not None and hasattr(window, "property"):
            if bool(window.property("closingAllowed")) or bool(window.property("intentionalShutdown")):
                return True
        return False

    @classmethod
    def _is_window_eligible(cls, studio) -> bool:
        if cls._is_window_closing(studio):
            return False
        if getattr(studio, "pending_save_as", "") or getattr(studio, "pending_export", ""):
            return False
        if getattr(studio, "_folder_search_open", False):
            return False
        window = getattr(studio, "host_window", None)
        if window is not None and hasattr(window, "property"):
            modal_count = window.property("modalDialogCount")
            if isinstance(modal_count, int) and modal_count > 0:
                return False
        return True

    def _ordered_live_studios(self) -> list:
        live = []
        live_ids = set()
        for index, studio in enumerate(self._studios):
            if studio is None or getattr(studio, "retired", False):
                continue
            live_ids.add(studio.window_id)
            live.append((index, studio))
        for stale_id in list(self._active_order):
            if stale_id not in live_ids:
                self._active_order.pop(stale_id, None)
        for stale_id in list(self._trackers):
            if stale_id not in live_ids:
                tracker = self._trackers.pop(stale_id, None)
                if tracker is not None:
                    try:
                        tracker.window.removeEventFilter(tracker)
                    except RuntimeError:
                        pass
        focus_window = self._current_focus_window()
        live.sort(
            key=lambda item: (
                self._active_order.get(item[1].window_id, 0),
                1 if (focus_window is not None and getattr(item[1], "host_window", None) is focus_window) else 0,
                item[0],
            ),
            reverse=True,
        )
        return [studio for _, studio in live]

    def _present_window(self, studio) -> None:
        window = getattr(studio, "host_window", None)
        if window is not None:
            visibility = window.visibility() if hasattr(window, "visibility") else None
            is_visible = window.isVisible() if hasattr(window, "isVisible") else True
            if not is_visible:
                ensure_profile = getattr(studio, "ensureReaderProfile", None)
                if callable(ensure_profile):
                    ensure_profile()
                else:
                    if getattr(studio, "_defer_reader_activation", False):
                        studio._defer_reader_activation = False
                    session_ensure = getattr(getattr(studio, "session", None), "ensure_reader_profile", None)
                    if callable(session_ensure):
                        session_ensure()
            session = getattr(studio, "session", None)
            settings = getattr(session, "settings", None)
            remembered = settings.get("window") if isinstance(settings, dict) else None
            wants_maximized = isinstance(remembered, dict) and bool(remembered.get("maximized"))
            if visibility == QWindow.Visibility.Minimized:
                if wants_maximized and hasattr(window, "showMaximized"):
                    window.showMaximized()
                elif hasattr(window, "showNormal"):
                    window.showNormal()
            elif not is_visible:
                if wants_maximized and hasattr(window, "showMaximized"):
                    window.showMaximized()
                elif hasattr(window, "show"):
                    window.show()
            if hasattr(window, "raise_"):
                window.raise_()
            if hasattr(window, "requestActivate"):
                window.requestActivate()
        self.mark_active(studio)

    def open_requested(self, note: str | None = None):
        raw = note if isinstance(note, str) else (str(note) if note is not None else "")
        ordered = self._ordered_live_studios()
        if not raw:
            hidden = next(
                (
                    studio
                    for studio in ordered
                    if getattr(studio, "host_window", None) is not None
                    and not self._is_window_visible(studio)
                    and not self._is_window_closing(studio)
                ),
                None,
            )
            if hidden is not None:
                self._present_window(hidden)
                return hidden
            return self._create_window(None)

        target_path = local_path(raw)
        if not target_path.is_dir():
            existing = next(
                (
                    studio
                    for studio in ordered
                    if self._is_window_eligible(studio) and studio.has_open_tab_for_path(target_path)
                ),
                None,
            )
            if existing is None:
                existing = next(
                    (
                        studio
                        for studio in ordered
                        if not self._is_window_closing(studio) and studio.has_open_tab_for_path(target_path)
                    ),
                    None,
                )
            if existing is not None:
                self._present_window(existing)
                existing.openPath(raw)
                return existing

        eligible = next(
            (studio for studio in ordered if self._is_window_eligible(studio) and self._is_window_visible(studio)),
            None,
        )
        if eligible is None:
            eligible = next((studio for studio in ordered if self._is_window_eligible(studio)), None)
        if eligible is not None:
            self._present_window(eligible)
            eligible.openPath(raw)
            return eligible

        return self._create_window(raw)
