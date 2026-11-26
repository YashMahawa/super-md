"""Tray-owned application lifetime; closing a window preserves its live note session when opted in."""
from pathlib import Path
from PySide6.QtCore import QObject, QTimer
from PySide6.QtGui import QIcon
from PySide6.QtWidgets import QSystemTrayIcon, QMenu

class BackgroundService(QObject):
    def __init__(self,app,session,root,open_window,*,force=False):
        super().__init__(app);self.app=app;self.session=session;self.root=Path(root);self.open_window=open_window
        self.forced=bool(force);self.quitting=False;self.waiting=set();self._quit_handlers=[];self.enabled=False
        self._cli_started_agent_access=False;self._stopping_from_cli=False;self.tray=None;self.menu=None;self.recents=None
        changed=getattr(self.session,'changed',None)
        if changed is not None and hasattr(changed,'connect'):changed.connect(self.sync)
        self.sync()
    def _ensure_tray(self):
        if self.tray is not None or not QSystemTrayIcon.isSystemTrayAvailable():return
        self.tray=QSystemTrayIcon(QIcon(str(self.root/'public/brand-mark-fixed.svg')),self)
        self.tray.setToolTip('Super MD — background service')
        menu=QMenu();self.menu=menu
        menu.addAction('Open Super MD',lambda:self.open_window(None))
        self.recents=menu.addMenu('Recent notes');self.recents.aboutToShow.connect(self.rebuild_recent)
        menu.addSeparator();menu.addAction('Quit Super MD',self.quit)
        self.tray.setContextMenu(menu)
        self.tray.activated.connect(lambda reason:self.open_window(None) if reason in (QSystemTrayIcon.ActivationReason.Trigger,QSystemTrayIcon.ActivationReason.DoubleClick) else None)
    def _notify_windows(self):
        for studio in list(getattr(self.session,'windows',{}).values()):
            if not getattr(studio,'retired',False) and hasattr(studio,'_emit'):studio._emit(False)
    def sync(self):
        settings=getattr(self.session,'settings',None)
        keep=isinstance(settings,dict) and settings.get('keepInBackground') is True
        should_enable=(self.forced or keep) and getattr(self.session,'update_installed',False) is not True
        previous=self.enabled;self.enabled=should_enable
        self.app.setQuitOnLastWindowClosed(not should_enable)
        if should_enable:
            self._ensure_tray()
            if self.tray is not None and not self.tray.isVisible():self.tray.show()
        elif self.tray is not None:self.tray.hide()
        if previous!=self.enabled:self._notify_windows()
    def set_forced(self,forced:bool):
        self.forced=bool(forced);self.sync()
    def disable(self):
        self.forced=False;self.sync()
    def visible_windows(self):
        return [s for s in getattr(self.session,'windows',{}).values() if not getattr(s,'retired',False) and getattr(s,'host_window',None) is not None and s.host_window.isVisible()]
    def restore_agent_access(self,studio=None):
        if self.quitting or getattr(self.session,'quitting',False):return
        settings,bridge=getattr(self.session,'settings',None),getattr(self.session,'agent_bridge',None)
        if not isinstance(settings,dict) or bridge is None:return
        if settings.get('agentAccessEnabled') is True and not bridge.enabled:bridge.start()
        if settings.get('cloudAgentEnabled') is True and not bridge.cloudClient.enabled:
            target=studio or next((s for s in getattr(self.session,'windows',{}).values() if not getattr(s,'retired',False)),None)
            if target is not None and hasattr(target,'_restore_cloud_connection'):target._restore_cloud_connection()
    def handle_window_visibility(self,studio,*,engines=None,studios=None,engine=None):
        window=getattr(studio,'host_window',None)
        if window is None or getattr(studio,'retired',False):return
        if window.isVisible():
            if getattr(studio,'ready',False):
                studio._last_reader_text=None;studio._emit(load=True)
            self.restore_agent_access(studio);return
        has_other=any(other is not studio and not getattr(other,'retired',False) for other in getattr(self.session,'windows',{}).values())
        if not studio.backgroundEnabled or has_other:
            studio.stop()
            if hasattr(studio,'pool'):studio.pool.shutdown(wait=False,cancel_futures=True)
            if hasattr(studio,'_search_pool'):studio._search_pool.shutdown(wait=False,cancel_futures=True)
            if studios is not None and studio in studios:studios.remove(studio)
            if engines is not None and engine is not None and engine in engines:engines.remove(engine)
            if engine is not None and hasattr(engine,'deleteLater'):engine.deleteLater()
            return
        if not self.visible_windows() and not self.forced:
            bridge=getattr(self.session,'agent_bridge',None)
            if bridge is not None:bridge.stop()
    def handle_service_request(self,action:str)->dict:
        bridge,settings=getattr(self.session,'agent_bridge',None),getattr(self.session,'settings',None)
        quitting=bool(self.quitting or getattr(self.session,'quitting',False))
        running=bool(self.enabled and not quitting)
        agent_enabled=bool(bridge and bridge.enabled and not quitting)
        if action=='status':
            reply={'ok':True,'running':running,'agentAccess':agent_enabled}
            if quitting:reply['stopping']=True
            return reply
        if action=='start':
            if quitting:
                return {'ok':False,'stopping':True,'running':False,'agentAccess':False,'error':'Background service is stopping'}
            if getattr(self.session,'update_installed',False) is True:
                return {'ok':False,'running':False,'agentAccess':agent_enabled,'error':'Super MD installed an update and must restart before starting the background service.'}
            keep=isinstance(settings,dict) and settings.get('keepInBackground') is True
            agent_consented=isinstance(settings,dict) and settings.get('agentAccessEnabled') is True
            if not (self.enabled or keep or agent_consented):
                return {'ok':False,'running':running,'agentAccess':False,'error':'Super MD is already open without tray residency or live agent access. Enable Keep running in the system tray or Live agent access in Settings first.'}
            if not agent_enabled and not agent_consented:self._cli_started_agent_access=True
            if isinstance(settings,dict):settings['agentAccessEnabled']=True
            self.set_forced(True)
            if bridge is not None and not bridge.enabled:bridge.start()
            return {'ok':True,'running':bool(self.enabled and not self.quitting),'agentAccess':bool(bridge and bridge.enabled),'sessionsDirectory':str(bridge.discovery_dir) if bridge is not None else ''}
        if action in ('stop','quit'):
            if quitting:
                return {'ok':True,'running':False,'stopped':False,'quitRequested':True}
            open_windows=self.visible_windows()
            if open_windows:
                prefs_changed=False
                if isinstance(settings,dict) and settings.get('keepInBackground') is True:
                    settings['keepInBackground']=False;prefs_changed=True
                if self._cli_started_agent_access:
                    self._cli_started_agent_access=False
                    if isinstance(settings,dict):settings['agentAccessEnabled']=False
                    if bridge is not None and bridge.enabled and not bridge.cloudClient.enabled:bridge.stop()
                if prefs_changed and hasattr(open_windows[0],'_preferences'):open_windows[0]._preferences()
                self.disable()
                return {'ok':True,'running':False,'stopped':running,'quitRequested':False}
            if self._cli_started_agent_access:
                self._cli_started_agent_access=False
                if isinstance(settings,dict):settings['agentAccessEnabled']=False
            self._stopping_from_cli=True;self.quitting=True
            if bridge is not None:bridge.stop()
            self.disable();self._notify_windows();self.quit()
            return {'ok':True,'running':False,'stopped':True,'quitRequested':True}
        return {'ok':False,'running':running,'error':f'Unsupported service action: {action}'}
    def rebuild_recent(self):
        self.recents.clear()
        for path in self.session.recent[:10]:
            action=self.recents.addAction(Path(path).name,lambda checked=False,path=path:self.open_window(path));action.setToolTip(path)
        if not self.session.recent:self.recents.addAction('No recent notes').setEnabled(False)
    def _clear_quit_handlers(self):
        for studio,handler in self._quit_handlers:
            try:studio.allowClose.disconnect(handler)
            except (RuntimeError,TypeError):pass
        self._quit_handlers.clear();self.waiting.clear()
    def cancel_quit(self):
        if not self.quitting:return
        self._clear_quit_handlers();self.quitting=False;self._stopping_from_cli=False;self.sync()
        if self.visible_windows():self.restore_agent_access()
        self._notify_windows()
    def _finalize_quit(self):
        if not self.quitting:return
        if self.tray is not None:self.tray.hide()
        self.app.setQuitOnLastWindowClosed(True)
        self.app.quit()
    def quit(self):
        self._clear_quit_handlers();self.quitting=True;self._notify_windows()
        owners=[s for s in self.session.windows.values() if not s.retired]
        self.waiting={s.window_id for s in owners}
        if not owners:QTimer.singleShot(0,self._finalize_quit);return
        for studio in owners:
            key=studio.window_id
            def ready(key=key):
                self.waiting.discard(key)
                if not self.waiting:self._clear_quit_handlers();QTimer.singleShot(0,self._finalize_quit)
            studio.allowClose.connect(ready);self._quit_handlers.append((studio,ready))
            studio.closeWindowSafely()
