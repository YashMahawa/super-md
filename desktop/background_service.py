"""Tray-owned application lifetime; closing a window preserves its live note session."""
from pathlib import Path
from PySide6.QtCore import QObject, QTimer
from PySide6.QtGui import QIcon
from PySide6.QtWidgets import QSystemTrayIcon, QMenu

class BackgroundService(QObject):
    def __init__(self,app,session,root,open_window,*,force=False):
        super().__init__(app);self.app=app;self.session=session;self.open_window=open_window
        self.quitting=False;self.waiting=set();self.enabled=force or QSystemTrayIcon.isSystemTrayAvailable()
        self.tray=None
        if not self.enabled:return
        app.setQuitOnLastWindowClosed(False)
        if QSystemTrayIcon.isSystemTrayAvailable():
            self.tray=QSystemTrayIcon(QIcon(str(root/'public/brand-mark-fixed.svg')),self)
            self.tray.setToolTip('Super MD — background service')
            menu=QMenu();self.menu=menu
            menu.addAction('Open Super MD',lambda:open_window(None))
            self.recents=menu.addMenu('Recent notes');self.recents.aboutToShow.connect(self.rebuild_recent)
            menu.addSeparator();menu.addAction('Quit Super MD',self.quit)
            self.tray.setContextMenu(menu)
            self.tray.activated.connect(lambda reason:open_window(None) if reason in (QSystemTrayIcon.Trigger,QSystemTrayIcon.DoubleClick) else None)
            self.tray.show()
    def rebuild_recent(self):
        self.recents.clear()
        for path in self.session.recent[:10]:
            action=self.recents.addAction(Path(path).name,lambda checked=False,path=path:self.open_window(path));action.setToolTip(path)
        if not self.session.recent:self.recents.addAction('No recent notes').setEnabled(False)
    def quit(self):
        self.quitting=True
        owners=[s for s in self.session.windows.values() if not s.retired]
        self.waiting={s.window_id for s in owners}
        if not owners:self.app.quit();return
        for studio in owners:
            key=studio.window_id
            def ready(key=key):
                self.waiting.discard(key)
                if not self.waiting:QTimer.singleShot(0,self.app.quit)
            studio.allowClose.connect(ready)
            window=getattr(studio,'host_window',None)
            if window is not None and not window.isVisible():window.show()
            studio.closeWindowSafely()
