import unittest
from unittest.mock import patch
from PySide6.QtCore import QObject,Signal
from background_service import BackgroundService
class App(QObject):
    def __init__(self):super().__init__();self.ended=False
    def setQuitOnLastWindowClosed(self,value):self.keep=not value
    def quit(self):self.ended=True
class Owner(QObject):
    allowClose=Signal()
    def __init__(self,key):super().__init__();self.window_id=key;self.retired=False;self.requested=False
    def closeWindowSafely(self):self.requested=True
class BackgroundTests(unittest.TestCase):
    def test_background_quit_waits_for_every_note_flush(self):
        from types import SimpleNamespace
        app=App();a,b=Owner('a'),Owner('b');session=SimpleNamespace(windows={'a':a,'b':b},recent=[])
        with patch('background_service.QSystemTrayIcon.isSystemTrayAvailable',return_value=False):service=BackgroundService(app,session,__import__('pathlib').Path('.'),lambda _:None,force=True)
        self.assertTrue(service.enabled);self.assertTrue(app.keep)
        service.quit();self.assertTrue(a.requested and b.requested);self.assertEqual(service.waiting,{'a','b'})
        a.allowClose.emit();self.assertEqual(service.waiting,{'b'});self.assertFalse(app.ended)
        b.allowClose.emit();self.assertFalse(service.waiting)
