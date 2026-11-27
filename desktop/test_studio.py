import json
import os
import sys
import time
import unittest
from pathlib import Path
from unittest.mock import patch
os.environ.setdefault("QT_QPA_PLATFORM","offscreen")
from PySide6.QtGui import QGuiApplication
from PySide6.QtCore import QUrl, QObject, Slot
from studio import Session, Studio
from documents import atomic_json
import updates

class QuietStudio(Studio):
    def _refresh_theme(self):
        self.system_dark = True

class StudioTest(unittest.TestCase):
    def test_fedora_uses_toolbar_frame_across_desktops(self):
        for distro, desktop, frame, controls in (
            ("fedora", "niri", True, True),
            ("fedora", "GNOME", True, True),
            ("debian", "niri", False, True),
            ("debian", "GNOME", False, False),
        ):
            with self.subTest(distro=distro, desktop=desktop), patch("studio.sys.platform", "linux"), patch(
                "studio.platform.freedesktop_os_release", return_value={"ID": distro}
            ), patch.dict(os.environ, {"XDG_CURRENT_DESKTOP": desktop}):
                self.assertEqual(self.studio.fedoraWindowFrame, frame)
                self.assertEqual(self.studio.showToolbarWindowControls, controls)

    def test_agent_pdf_options_match_gui_limits_and_remembered_preferences(self):
        import hashlib
        studio = self.studio
        studio.settings["newNoteLocation"] = str(studio.data)
        studio.settings["pdf"] = {**studio.settings["pdf"], "fontFamily": "Noto Serif", "fontSize": 13}
        tab = studio._current()
        request = {"id": tab["id"], "expectedRevision": hashlib.sha256(tab["content"].encode()).hexdigest(),
                   "format": "pdf", "content": tab["content"], "assets": {}, "filename": "Agent options.pdf",
                   "options": {"fontSize": 5, "margin": 60, "lineHeight": .9, "paragraphSpacing": 3}}
        with patch.object(studio, "post") as post:
            studio._agent_export_native("native-options", request)
        forwarded = json.loads(post.call_args.args[2])
        self.assertEqual(forwarded["options"]["fontFamily"], "Noto Serif")
        self.assertEqual(forwarded["options"]["fontSize"], 5)
        self.assertEqual(forwarded["options"]["lineHeight"], .9)
        self.assertEqual(studio.settings["pdf"]["fontSize"], 13, "An agent export must not change GUI preferences")

    def test_shortcut_maps_only_notify_when_bindings_change_across_windows(self):
        other=self.window();first=[];second=[]
        self.studio.shortcutsChanged.connect(lambda:first.append(True));other.shortcutsChanged.connect(lambda:second.append(True))
        self.studio._emit();self.studio.setZoom(125)
        self.assertEqual((first,second),([],[]))
        self.assertEqual(self.studio.setShortcut('find','Ctrl+Alt+F'),'')
        self.assertEqual((len(first),len(second)),(1,1));self.assertEqual(other.shortcutSequences('find'),['Ctrl+Alt+F'])
        self.studio._emit();self.studio.setShortcut('find','Ctrl+Alt+F')
        self.assertEqual((len(first),len(second)),(1,1))

    def test_paste_autofix_is_opt_in_validated_and_sent_to_reader(self):
        studio=self.studio;loads=[];studio.readerLoad.connect(loads.append);studio.ready=True
        self.assertFalse(studio.settings['latexAutofix'])
        for invalid in ('true',1,None):
            studio.setting('latexAutofix',json.dumps(invalid))
            self.assertFalse(studio.settings['latexAutofix'])
        studio.setting('latexAutofix','true')
        self.assertTrue(json.loads(loads[-1])['latexAutofix'])
        self.assertTrue(self.session.settings['latexAutofix'])
        studio.setting('latexAutofix','false')
        self.assertFalse(json.loads(loads[-1])['latexAutofix'])

    def test_typewriter_scroll_is_opt_in_validated_and_synced_with_reader(self):
        studio=self.studio;loads=[];replies=[];studio.readerLoad.connect(loads.append);studio.ready=True
        studio.replied.connect(lambda identifier,value,error:replies.append((identifier,value,error)))
        self.assertFalse(studio.settings['typewriterScroll'])
        for invalid in ('true',1,None):
            studio.setting('typewriterScroll',json.dumps(invalid))
            self.assertFalse(studio.settings['typewriterScroll'])
        studio.setting('typewriterScroll','true')
        self.assertTrue(json.loads(loads[-1])['typewriterScroll'])
        self.assertTrue(self.session.settings['typewriterScroll'])
        studio.post('tw1','typewriter_scroll',json.dumps({'enabled':False}))
        self.assertEqual(replies[-1],('tw1','true',''))
        self.assertFalse(studio.settings['typewriterScroll'])
        self.assertFalse(json.loads(loads[-1])['typewriterScroll'])
        studio.post('tw2','typewriter_scroll',json.dumps({'enabled':'yes'}))
        self.assertTrue(replies[-1][2])

    def test_theme_guide_opens_in_reader_and_copies_without_editing_note(self):
        studio=self.studio;calls=[];replies=[];studio.readerCall.connect(calls.append)
        studio.replied.connect(lambda identifier,value,error:replies.append((identifier,value,error)))
        original=studio._current()['content']
        with patch('studio.QDesktopServices.openUrl') as external:
            studio.openThemeGuide();external.assert_not_called()
        self.assertEqual(calls,['window.supermdThemeGuide?.()'])
        guide='# Theme guide\n\n```json\n{}\n```\n'
        studio.post('copy','copy_text',json.dumps({'text':guide}))
        self.assertEqual(QGuiApplication.clipboard().text(),guide)
        self.assertEqual(replies[-1],('copy','true',''))
        for invalid in (42,None,'x'*2_000_001):
            studio.post('invalid','copy_text',json.dumps({'text':invalid}))
            self.assertTrue(replies[-1][2]);self.assertEqual(QGuiApplication.clipboard().text(),guide)
        self.assertEqual(studio._current()['content'],original)

    def test_copy_image_writes_real_pixels_and_rejects_invalid_data_without_changing_note(self):
        import base64
        from PySide6.QtCore import QBuffer, QByteArray, QIODevice
        from PySide6.QtGui import QImage, QColor
        image=QImage(8,6,QImage.Format.Format_ARGB32);image.fill(QColor("#1688dd"))
        raw=QByteArray();buffer=QBuffer(raw);buffer.open(QIODevice.OpenModeFlag.WriteOnly);image.save(buffer,"PNG")
        studio=self.studio;original=studio._current()['content'];replies=[]
        studio.replied.connect(lambda identifier,value,error:replies.append((identifier,value,error)))
        body=base64.b64encode(bytes(raw)).decode()
        studio.post('copy-image','copy_image_native',json.dumps({'body':body,'mimeType':'image/png'}))
        copied=QGuiApplication.clipboard().image()
        self.assertEqual((copied.width(),copied.height()),(8,6))
        self.assertEqual(copied.pixelColor(2,2).name(),'#1688dd')
        self.assertEqual(replies[-1],('copy-image','true',''))
        studio.post('bad-image','copy_image_native',json.dumps({'body':'aGVsbG8=','mimeType':'image/png'}))
        self.assertTrue(replies[-1][2]);self.assertEqual(QGuiApplication.clipboard().image().pixelColor(2,2).name(),'#1688dd')
        self.assertEqual(studio._current()['content'],original)

    def test_reader_patches_commit_in_order_and_reject_external_changes(self):
        studio=self.studio;note=studio._current();note['content']='a😀z'
        replies=[]
        studio.replied.connect(lambda identifier,value,error:replies.append((identifier,json.loads(value),error)))
        base={'id':note['id'],'epoch':'new-renderer'}
        studio.post('sync','document_sync',json.dumps({**base,'revision':0,'content':note['content']}))
        patch={**base,'baseRevision':0,'revision':1,'changes':[{'from':1,'to':3,'insert':'!'}]}
        studio.post('edit','document_patch',json.dumps(patch))
        self.assertEqual(note['content'],'a!z')
        self.assertTrue(replies[-1][1]['accepted'])
        studio.post('duplicate','document_patch',json.dumps(patch))
        self.assertTrue(replies[-1][1]['accepted'])
        note['content']='external'
        studio.post('stale','document_patch',json.dumps({**patch,'baseRevision':1,'revision':2}))
        self.assertFalse(replies[-1][1]['accepted'])
        self.assertEqual(note['content'],'external')

    def test_repeated_update_checks_keep_verified_installer_and_skip_redownload(self):
        studio=self.studio;info={'version':'9.9.9'};studio.update_info=info;studio.update_path='/verified/installer'
        calls=[]
        with patch.object(studio,'_submit',side_effect=lambda action,done,*_:calls.append((action,done))):
            studio.checkUpdates();_,done=calls.pop();done((info,None),None)
            self.assertEqual(studio.update_path,'/verified/installer');self.assertIn('already downloaded',studio.update_status)
            studio.downloadUpdate();self.assertEqual(calls,[])
            studio.checkUpdates();_,done=calls.pop();done((None,'offline'),None)
            self.assertEqual(studio.update_path,'/verified/installer')

    def test_portable_update_installs_without_starting_competing_instance(self):
        studio=self.studio;name='Super-MD_9.9.9_amd64.AppImage';studio.update_path='/verified/update.AppImage';studio.update_info={'version':'9.9.9','name':name,'size':4,'url':updates.REPO+'/releases/download/v9.9.9/'+name,'checksums':updates.REPO+'/releases/download/v9.9.9/SHA256SUMS'};calls=[]
        saved={'path':studio.update_path,'release':studio.update_info}
        with patch('app_integration.available',return_value=True),patch.object(studio,'_submit',side_effect=lambda action,done,*_:calls.append((action,done))),patch('updates.load_ready',return_value=saved),patch('app_integration.install_appimage',return_value='/managed/new') as install,patch('studio.QProcess.startDetached') as spawn:
            studio.installUpdate();action,done=calls.pop();done(action(),None)
            install.assert_called_once_with(studio.update_path,'9.9.9',False);spawn.assert_not_called()
        self.assertIn('Close and reopen',studio.update_status);self.assertFalse(studio.update_running)

    def test_package_update_handoff_opens_matching_verified_installer(self):
        studio=self.studio;name='Super-MD_9.9.9_amd64.deb';studio.update_path='/verified/update.deb';studio.update_info={'version':'9.9.9','name':name,'size':4,'url':updates.REPO+'/releases/download/v9.9.9/'+name,'checksums':updates.REPO+'/releases/download/v9.9.9/SHA256SUMS'};calls=[]
        saved={'path':studio.update_path,'release':studio.update_info}
        with patch.object(studio,'_submit',side_effect=lambda action,done,*_:calls.append((action,done))),patch('updates.load_ready',return_value=saved),patch('studio.QDesktopServices.openUrl',return_value=True) as open_url,patch('app_integration.install_appimage') as appimage:
            studio.installUpdate();action,done=calls.pop();done(action(),None)
        open_url.assert_called_once_with(QUrl.fromLocalFile(studio.update_path))
        appimage.assert_not_called()
        self.assertIn('Package installer opened',studio.update_status)

    def test_update_check_selects_detected_linux_install_channel(self):
        studio=self.studio;calls=[]
        release={'tag_name':'v9.9.9','draft':False,'prerelease':False,'assets':[
            {'name':'Super-MD_9.9.9_amd64.AppImage','size':4,'browser_download_url':updates.REPO+'/releases/download/v9.9.9/Super-MD_9.9.9_amd64.AppImage'},
            {'name':'Super-MD_9.9.9_amd64.deb','size':4,'browser_download_url':updates.REPO+'/releases/download/v9.9.9/Super-MD_9.9.9_amd64.deb'},
            {'name':'SHA256SUMS','size':100,'browser_download_url':updates.REPO+'/releases/download/v9.9.9/SHA256SUMS'}]}
        with patch('studio.sys.platform','linux'),patch.object(studio,'_submit',side_effect=lambda action,done,*_:calls.append((action,done))),patch('updates.linux_install_kind',return_value='deb') as channel,patch('updates.bounded_json',return_value=release):
            studio.checkUpdates();action,done=calls.pop();done(action(),None)
        channel.assert_called_once_with()
        self.assertEqual(studio.update_info['name'],'Super-MD_9.9.9_amd64.deb')

    def test_update_check_preserves_tls_error_type_for_actionable_message(self):
        import ssl
        from urllib.error import URLError
        studio=self.studio
        jobs=[]
        failure=URLError(ssl.SSLCertVerificationError("certificate verify failed"))
        with patch.object(studio,'_submit',side_effect=lambda action,done,*_:jobs.append((action,done))),patch('updates.bounded_json',side_effect=failure):
            studio.checkUpdates()
            action,done=jobs.pop()
            done(action(),None)
        self.assertFalse(studio.update_running)
        self.assertIn('certificate',studio.update_status)
        self.assertIn('system date',studio.update_status)

    def test_macos_and_windows_updates_handoff_to_their_native_installers(self):
        for name,kind in (("Super-MD_9.9.9_aarch64.dmg","macos"),("Super-MD_9.9.9_x64-setup.exe","windows")):
            with self.subTest(kind=kind):
                studio=self.studio;studio.update_path="/verified/"+name
                studio.update_info={'version':'9.9.9','name':name,'size':4,'url':updates.REPO+'/releases/download/v9.9.9/'+name,'checksums':updates.REPO+'/releases/download/v9.9.9/SHA256SUMS'}
                saved={'path':studio.update_path,'release':studio.update_info};calls=[]
                with patch.object(studio,'_submit',side_effect=lambda action,done,*_:calls.append((action,done))),patch('updates.load_ready',return_value=saved),patch('studio.QDesktopServices.openUrl',return_value=True) as open_url,patch('studio.QProcess.startDetached',return_value=(True,123)) as start:
                    studio.installUpdate();action,done=calls.pop();done(action(),None)
                if kind=='macos':
                    open_url.assert_called_once_with(QUrl.fromLocalFile(studio.update_path));start.assert_not_called()
                    self.assertIn('Disk image opened',studio.update_status)
                else:
                    start.assert_called_once_with(studio.update_path,[]);open_url.assert_not_called()
                    self.assertIn('Installer opened',studio.update_status)
    @classmethod
    def setUpClass(cls):
        cls.app = QGuiApplication.instance() or QGuiApplication(["Super MD tests"])

    def setUp(self):
        self.session = Session(True)
        self.windows = []
        self.studio = self.window()
        self.session.writes.flush(timeout=3)

    def window(self):
        window = QuietStudio(True,self.session)
        self.windows.append(window)
        return window

    def flush(self):
        self.session.writes.flush(timeout=3)
        self.app.processEvents()

    def await_idle(self):
        deadline = time.monotonic()+3
        while self.studio.busy and time.monotonic()<deadline:
            self.app.processEvents()
            time.sleep(.005)
        self.assertEqual(self.studio.busy,0)
        self.flush()

    def tearDown(self):
        for window in self.windows:
            window.stop()
            window.pool.shutdown(wait=True,cancel_futures=True)
            window._search_pool.shutdown(wait=True,cancel_futures=True)
        self.session.writes.shutdown(wait=True)
        self.app.processEvents()

    def test_reading_chrome_actions_are_validated_and_only_reach_fullscreen(self):
        received=[]
        self.studio.chromeRequested.connect(received.append)
        self.studio.post("normal","reader_chrome",'{"action":"show"}')
        self.assertEqual(received,[])
        self.studio.setFullscreen(True)
        for action in ("show","hide","toggle"):
            self.studio.post(action,"reader_chrome",json.dumps({"action":action}))
        self.studio.post("invalid","reader_chrome",'{"action":"anything"}')
        self.assertEqual(received,["show","hide","toggle"])

    def test_custom_theme_import_updates_all_windows_and_reset_never_deletes_source(self):
        import custom_theme
        studio=self.studio;second=self.window();source=studio.data/"authored-theme.json";source.write_text("{}")
        pending=[]
        # These are persistence/state unit tests. The real shared engine is
        # exercised by CLI tests and the mandatory packaged rendering checks.
        with patch.object(studio,"_engine",return_value=Path("unused-theme-engine")),patch.object(studio,"_submit",side_effect=lambda action,done,*_:pending.append((action,done))),patch("custom_theme.read",return_value=custom_theme.TEMPLATE):
            studio.importCustomTheme(str(source));action,done=pending.pop();done(action(),None)
        self.assertEqual(studio.customThemeName,"My theme");self.assertEqual(second.customThemeName,"My theme")
        self.assertTrue((studio.data/"theme.json").is_file());self.assertIn(str(source),studio.custom_theme_watcher.files())
        original=studio._colors()
        pending=[]
        with patch.object(studio,"_engine",return_value=Path("unused-theme-engine")),patch.object(studio,"_submit",side_effect=lambda action,done,*_:pending.append((action,done))),patch("custom_theme.read",side_effect=ValueError("Invalid edit")):
            studio.reloadCustomTheme();action,done=pending.pop();value=action();studio.pending_close="keep";done(value,None)
        self.assertEqual(studio._colors(),original);self.assertIn("Invalid edit",studio.message);self.assertEqual(studio.pending_close,"keep")
        studio.resetCustomTheme();self.assertTrue(source.is_file());self.assertFalse((studio.data/"theme.json").exists());self.assertEqual(second.customThemeName,"Built-in appearance")

    def test_background_controls_validate_persist_and_restore_theme_defaults(self):
        import custom_theme
        self.session.custom_theme=custom_theme.TEMPLATE
        for key,value in (("patternKind","paws"),("patternOpacity",.1),("patternSize",30),("patternSpacing",96)):
            self.studio.setting(key,json.dumps(value))
        self.assertEqual(self.studio.themeBackground["pattern"],"paws")
        self.assertEqual(self.studio.themeBackground["spacing"],96)
        for key,value in (("patternKind","url(evil)"),("patternOpacity",1),("patternSize",999),("patternSpacing",False)):
            before=self.studio.themeBackground.copy();self.studio.setting(key,json.dumps(value));self.assertEqual(self.studio.themeBackground,before)
        self.flush()
        stored=json.loads((self.studio.data/"settings.json").read_text())
        self.assertEqual(stored["settings"]["patternKind"],"paws")
        self.studio.resetThemeBackground()
        self.assertEqual(self.studio.themeBackground["pattern"],"dots")

    def test_automatic_update_network_errors_do_not_replace_messages_or_close_intent(self):
        studio=self.studio;pending=[];studio.message="A local note is ready";studio.pending_close="keep"
        with patch.object(studio,"_submit",side_effect=lambda action,done,*_:pending.append((action,done))),patch("studio.updates.bounded_json",side_effect=OSError("Temporary failure in name resolution")):
            studio.checkUpdates(True);action,done=pending.pop();studio._complete((done,action(),None,False))
        self.assertEqual(studio.message,"A local note is ready");self.assertEqual(studio.pending_close,"keep");self.assertIn("offline",studio.updateStatus)

    def test_last_good_theme_is_restored_before_retrying_an_invalid_source(self):
        import custom_theme
        studio=self.studio;source=studio.data/"edited-theme.json";source.write_text("broken JSON")
        atomic_json(studio.data/"theme.json",custom_theme.TEMPLATE);studio.session.theme_source=str(source)
        pending=[]
        def read(_,path):
            if path==source:raise ValueError("Incomplete edit")
            return custom_theme.TEMPLATE
        with patch.object(studio,"_engine",return_value=Path("unused-theme-engine")),patch.object(studio,"_submit",side_effect=lambda action,done,*_:pending.append((action,done))),patch("custom_theme.read",side_effect=read):
            studio.reloadCustomTheme()
            while pending:
                action,done=pending.pop(0);done(action(),None)
        self.assertEqual(studio.customThemeName,"My theme");self.assertIn("Incomplete edit",studio.message)

    def test_unrelated_parent_notifications_do_not_reparse_a_theme(self):
        studio=self.studio;source=studio.data/"observed-theme.json";source.write_text("{}")
        studio.session.theme_source=str(source);studio._watch_custom_theme()
        with patch.object(studio,"reloadCustomTheme") as reload:
            studio._custom_theme_event();reload.assert_not_called()
            source.write_text("{ } ")
            studio._custom_theme_event();reload.assert_called_once()

    def test_retired_windows_ignore_queued_jobs_and_late_callbacks(self):
        studio=self.studio
        studio.stop();studio.pool.shutdown(wait=True,cancel_futures=True)
        studio._choose_default_python()
        studio._submit(lambda:1,lambda *_:self.fail("Retired callback ran"))
        studio._complete((lambda *_:self.fail("Retired callback ran"),None,None,False))

    def test_startup_populates_default_python_before_reader_load_without_probing(self):
        with (
            patch("python_runtime.probe", side_effect=AssertionError("startup must not probe Python")),
            patch("python_runtime.discover", side_effect=AssertionError("startup must not discover Python")),
        ):
            fresh_session = Session(True)
            self.addCleanup(lambda: fresh_session.writes.shutdown(wait=True))
            self.assertEqual(fresh_session.settings["python"], "")
            fresh_studio = QuietStudio(True, fresh_session)
            self.windows.append(fresh_studio)
            self.assertFalse(fresh_studio.pythonBusy)
            self.assertTrue(fresh_studio.settings["python"])
            loads = []
            fresh_studio.readerLoad.connect(loads.append)
            fresh_studio.post("ready", "reader_ready", "{}")
            self.assertEqual(json.loads(loads[-1])["python"], fresh_studio.settings["python"])
            self.app.processEvents()
            fresh_session.writes.flush(timeout=3)
            stored = json.loads((fresh_session.data / "settings.json").read_text(encoding="utf-8"))
            self.assertEqual(stored["settings"]["python"], fresh_studio.settings["python"])

            saved_session = Session(True)
            self.addCleanup(lambda: saved_session.writes.shutdown(wait=True))
            saved_session.settings["python"] = sys.executable
            saved_studio = QuietStudio(True, saved_session)
            self.windows.append(saved_studio)
            self.assertFalse(saved_studio.pythonBusy)
            self.assertEqual(saved_studio.settings["python"], sys.executable)
            self.app.processEvents()

    def test_startup_default_python_persists_during_init_without_reader_ready_or_ui_completion(self):
        fresh_session = Session(True)
        self.addCleanup(lambda: fresh_session.writes.shutdown(wait=True))
        submitted_writes = []
        original_submit = fresh_session.writes.submit

        def record_submit(fn, *args, **kwargs):
            submitted_writes.append(fn)
            return original_submit(fn, *args, **kwargs)

        with patch.object(fresh_session.writes, "submit", side_effect=record_submit):
            fresh_studio = QuietStudio(True, fresh_session)
            self.windows.append(fresh_studio)
            # Queued directly during __init__ before any QTimer.singleShot(0) or reader_ready runs.
            self.assertEqual(len(submitted_writes), 1)
            fresh_session.writes.flush(timeout=3)
            stored = json.loads((fresh_session.data / "settings.json").read_text(encoding="utf-8"))
            self.assertEqual(stored["settings"]["python"], fresh_studio.settings["python"])

            completed_events = []
            fresh_studio.completed.connect(completed_events.append)
            fresh_studio._preferences(False)
            fresh_session.writes.flush(timeout=3)
            self.app.processEvents()
            self.assertEqual(completed_events, [])

            writes_before_ready = len(submitted_writes)
            fresh_studio.post("ready", "reader_ready", "{}")
            self.app.processEvents()
            self.assertEqual(len(submitted_writes), writes_before_ready)

        with patch("studio.atomic_write", side_effect=OSError("disk full")):
            fresh_studio._preferences(False)
            fresh_session.writes.flush(timeout=3)
            self.app.processEvents()
            self.assertIn("disk full", fresh_studio.message)

    def test_concurrent_refresh_python_and_preferred_share_single_discover_run(self):
        import concurrent.futures
        import threading
        import python_runtime

        studio = self.studio
        started = threading.Event()
        release = threading.Event()
        probe_calls = 0
        lock = threading.Lock()

        def controlled_probe(executable, timeout=6):
            nonlocal probe_calls
            with lock:
                probe_calls += 1
            started.set()
            release.wait(5)
            return {
                "version": "3.12.0",
                "prefix": sys.prefix,
                "venv": True,
                "matplotlib": True,
                "numpy": True,
                "venvModule": True,
            }

        with (
            patch("python_runtime.bundled_available", return_value=False),
            patch("python_runtime.candidates", return_value=[Path(sys.executable)]),
            patch("python_runtime.probe", side_effect=controlled_probe),
        ):
            studio.refreshPython()
            self.assertTrue(studio.pythonBusy)
            self.assertTrue(started.wait(2))
            with concurrent.futures.ThreadPoolExecutor(max_workers=1) as caller:
                preferred_future = caller.submit(python_runtime.preferred, studio.data / "python-env")
                time.sleep(0.05)
                release.set()
                chosen = preferred_future.result(timeout=5)
            self._wait_for(lambda: not studio.pythonBusy)

        self.assertEqual(probe_calls, 1)
        self.assertEqual(chosen, sys.executable)
        self.assertEqual([item["path"] for item in studio.python_choices], [sys.executable])

    def test_default_python_selection_and_refresh_publish_discovered_choices(self):
        studio = self.studio
        studio.settings["python"] = ""
        choices = [{"path": sys.executable, "label": "Virtual environment 3.13.0", "detail": ".venv · numpy + matplotlib ready",
                    "matplotlib": True, "managed": False, "venv": True, "venvModule": True}]
        pending = []
        with patch.object(studio, "_submit", side_effect=lambda action, done, *_: pending.append((action, done))), \
             patch("python_runtime.default_python", return_value=sys.executable) as default_python, \
             patch("python_runtime.discover", return_value=choices) as discover:
            studio._choose_default_python()
            action, done = pending.pop()
            done(action(), None)
            default_python.assert_called_once_with(studio.data / "python-env")
            self.assertEqual(studio.settings["python"], sys.executable)

            studio.refreshPython()
            self.assertTrue(studio.pythonBusy)
            action, done = pending.pop()
            done(action(), None)
            discover.assert_called_once()
            self.assertFalse(studio.pythonBusy)
            self.assertEqual(json.loads(studio.pythonChoices), choices)
            self.assertEqual(studio.pythonStatus, "")

    def test_pinned_recents_are_first_and_never_evicted_by_recent_opens(self):
        studio=self.studio;studio.recent=["/notes/pinned.md"]
        studio.pinRecent("/notes/pinned.md")
        for i in range(25):studio.recent=[f"/notes/{i}.md"]+studio.recent
        self.assertEqual(len(studio.recent),10)
        self.assertEqual(studio.recent[0],"/notes/pinned.md")
        studio.pinRecent("/notes/pinned.md");self.assertNotIn("/notes/pinned.md",studio.pinnedRecent)

    def test_center_lock_defaults_on_and_updates_reader_without_reloading_content(self):
        studio=self.studio;messages=[];studio.readerLoad.connect(messages.append)
        studio.post("ready","reader_ready","{}")
        self.assertTrue(json.loads(messages[-1])["centerLock"])
        studio.setting("centerLock","false");payload=json.loads(messages[-1])
        self.assertFalse(payload["centerLock"]);self.assertTrue(payload["contentUnchanged"])
        studio.setting("centerLock",'"invalid"');self.assertFalse(studio.settings["centerLock"])

    def test_full_document_accessibility_is_opt_in_persisted_and_sent_to_reader(self):
        studio=self.studio;messages=[];studio.readerLoad.connect(messages.append)
        studio.post("ready","reader_ready","{}")
        self.assertFalse(json.loads(messages[-1])["fullDocumentAccessibility"])
        studio.setting("fullDocumentAccessibility","true")
        payload=json.loads(messages[-1])
        self.assertTrue(payload["fullDocumentAccessibility"])
        self.assertTrue(payload["contentUnchanged"])
        self.assertTrue(studio.settings["fullDocumentAccessibility"])
        self.flush()
        stored=json.loads((studio.data/"settings.json").read_text())
        self.assertTrue(stored["settings"]["fullDocumentAccessibility"])
        studio.setting("fullDocumentAccessibility",'"true"')
        self.assertTrue(studio.settings["fullDocumentAccessibility"])

    def test_palette_loads_do_not_reserialize_the_note_and_ready_resets_the_cache(self):
        studio=self.studio;messages=[];studio.readerLoad.connect(messages.append)
        studio._current()["content"]="A big note. "*20000
        studio.post("ready","reader_ready","{}")
        self.assertIn("content",json.loads(messages[-1]))
        studio.setting("theme",'"dark"')
        value=json.loads(messages[-1]);self.assertTrue(value["contentUnchanged"]);self.assertNotIn("content",value)
        self.assertLess(len(messages[-1]),5000)
        studio.post("ready-again","reader_ready","{}")
        self.assertIn("content",json.loads(messages[-1]))

    def test_first_run_sample_does_not_return_for_existing_users(self):
        self.session.settings["welcomed"]=True
        window=self.window();self.assertEqual(window._current()["name"],"Untitled.md")
        self.assertEqual(window._current()["content"],"")

    def test_clean_tabs_are_recorded_for_restart_and_reopened_in_order(self):
        studio=self.studio;self.session.settings["welcomed"]=True
        paths=[]
        for i in range(3):
            path=studio.data/f"restart-{i}.md";path.write_text(f"# Note {i}");paths.append(str(path));studio.openNote(str(path));self.await_idle()
        studio._recover();self.flush()
        value=json.loads((studio.data/"startup.json").read_text());self.assertEqual(value["paths"],paths)
        self.session.startup_paths=paths;self.session.startup_active=paths[1]
        restored=self.window()
        deadline=time.monotonic()+3
        while restored._restoring_paths and time.monotonic()<deadline:self.app.processEvents();time.sleep(.005)
        self.assertEqual([tab["path"] for tab in restored.tabs],paths)
        self.assertEqual(restored._current()["path"],paths[1])

    def test_reading_locations_are_durable_without_a_persistent_web_profile(self):
        studio=self.studio;path=studio.data/"position.md";path.write_text("# Reading")
        studio.openNote(str(path));self.await_idle()
        point={"top":1200,"offset":12,"zoom":150,"mode":"reader"}
        studio.post("position","reading_position",json.dumps({"id":studio.active,"location":point}))
        studio._save_positions();self.flush()
        self.assertEqual(json.loads((studio.data/"reading-positions.json").read_text())[str(path)],point)
        messages=[];studio.readerLoad.connect(messages.append);studio.ready=True;studio._emit()
        self.assertEqual(json.loads(messages[-1])["readingLocation"],point)

    def test_blank_startup_keeps_recovered_drafts_but_opens_a_new_active_note(self):
        self.session.settings.update(welcomed=True,startup="new")
        self.session.initial_recovery=[self.studio._note("Draft.md","Do not lose this")]
        window=self.window()
        self.assertEqual(window._current()["content"],"")
        self.assertEqual(window.tabs[1]["content"],"Do not lose this")

    def test_closing_one_of_multiple_windows_does_not_restore_its_clean_tabs(self):
        second=self.window()
        first_path=self.studio.data/"closed.md";first_path.write_text("# Closed")
        self.studio.openNote(str(first_path));self.await_idle()
        self.studio._recover();second._recover();self.flush()
        self.studio.stop();self.flush()
        self.assertNotIn(str(first_path),json.loads((self.studio.data/"startup.json").read_text())["paths"])

    def test_mixed_clean_and_draft_startup_keeps_order_and_active_draft(self):
        studio=self.studio;self.session.settings["welcomed"]=True
        path=studio.data/"clean.md";path.write_text("# Clean")
        studio.openNote(str(path));self.await_idle()
        studio.newNote();draft=studio._current();draft["content"]="Unfinished work"
        studio._recover();self.flush()
        value=json.loads((studio.data/"startup.json").read_text())
        self.session.startup_paths=value["paths"];self.session.startup_entries=value["tabs"]
        self.session.startup_active=value["active"];self.session.startup_active_id=value["activeId"]
        self.session.initial_recovery=[dict(draft)]
        restored=self.window();deadline=time.monotonic()+3
        while restored._restoring_paths and time.monotonic()<deadline:self.app.processEvents();time.sleep(.005)
        self.assertEqual([t["path"] for t in restored.tabs],[str(path),""])
        self.assertEqual(restored._current()["content"],"Unfinished work")

    def test_native_folder_notifications_refresh_additions_and_removals(self):
        studio=self.studio;folder=studio.data/"watched";folder.mkdir();studio.openFolder(str(folder));self.await_idle()
        path=folder/"added.md";path.write_text("# Added")
        deadline=time.monotonic()+3
        while not any(entry["path"]==str(path) for entry in studio.files) and time.monotonic()<deadline:self.app.processEvents();time.sleep(.01)
        self.assertIn(str(path),[entry["path"] for entry in studio.files])
        path.unlink();deadline=time.monotonic()+3
        while studio.files and time.monotonic()<deadline:self.app.processEvents();time.sleep(.01)
        self.assertEqual(studio.files,[])

    def test_external_rename_and_delete_update_tabs_and_pins_without_losing_drafts(self):
        studio=self.studio;old=studio.data/"before.md";old.write_text("# Saved")
        studio.openNote(str(old));self.await_idle();tab=studio._current();studio.pinRecent(str(old))
        new=old.with_name("after.md");old.rename(new)
        studio._location_changed(str(old),str(new))
        self.assertEqual(tab["name"],"after.md");self.assertEqual(studio.recent[0],str(new));self.assertIn(str(new),studio.pinnedRecent)
        studio.tabs=[tab];tab["content"]="# Unsaved edit";new.unlink()
        studio._location_changed(str(new),"")
        self._wait_for(lambda:studio._current()["name"]=="Untitled.md")
        self.assertEqual(studio._current()["name"],"Untitled.md")
        self.assertNotIn(str(new),studio.recent);self.assertNotIn(str(new),studio.pinnedRecent)
        self.flush()
        drafts=json.loads((studio.data/"recovery.json").read_text())
        self.assertIn("# Unsaved edit",[draft["content"] for draft in drafts])
        self.assertEqual(drafts[0]["path"],"")

    def test_writing_preferences_are_boolean_persistent_and_forwarded_to_reader(self):
        self.studio.setting("spellCheck","true")
        self.studio.setting("grammarCheck","true")
        self.studio.setting("spellCheck",'"not a boolean"')
        self.assertTrue(self.studio.settings["spellCheck"])
        self.assertTrue(self.studio.settings["grammarCheck"])
        restored=self.window()
        self.assertTrue(restored.settings["spellCheck"])
        self.assertTrue(restored.settings["grammarCheck"])
        messages=[];restored.readerLoad.connect(messages.append);restored.ready=True;restored._emit()
        payload=json.loads(messages[-1])
        self.assertTrue(payload["spellCheck"]);self.assertTrue(payload["grammarCheck"])

    def test_cancel_then_discard_closes_once_without_prompt_loop(self):
        studio = self.studio
        studio.newNote()
        studio._current()["content"] = "Unsaved work"
        closed = []
        studio.allowClose.connect(lambda:closed.append(True))
        self.assertFalse(studio.requestWindowClose())
        studio.resolveClose("cancel")
        self.assertEqual(studio._current()["content"],"Unsaved work")
        self.assertEqual(closed,[])
        self.assertFalse(studio.requestWindowClose())
        studio.resolveClose("discard")
        self.assertEqual(closed,[True])
        self.assertTrue(studio.requestWindowClose())

    def test_open_with_folder_routes_to_sidebar_without_discarding_notes(self):
        studio = self.studio
        folder = studio.data / "Notes with spaces Ω"
        folder.mkdir()
        (folder / "Algebra.md").write_text("# Algebra")
        ids = [t["id"] for t in studio.tabs]
        studio._current()["content"] = "Unsaved draft"
        studio.openPath(QUrl.fromLocalFile(str(folder)).toString())
        deadline = time.monotonic() + 3
        while not studio.files and time.monotonic() < deadline:
            self.app.processEvents(); time.sleep(.005)
        self.assertEqual(studio.folder, str(folder.resolve()))
        self.assertEqual([entry["name"] for entry in studio.files], ["Algebra.md"])
        self.assertEqual([t["id"] for t in studio.tabs], ids)
        self.assertEqual(studio._current()["content"], "Unsaved draft")
        self.assertTrue(studio.settings["welcomed"])

    def test_invalid_folder_does_not_clear_the_existing_folder(self):
        studio = self.studio
        studio.folder = str(studio.data)
        studio.openFolder(str(studio.data / "missing"))
        self.assertEqual(studio.folder, str(studio.data))
        self.assertIn("existing local folder", studio.message)

    def test_open_with_note_still_opens_markdown(self):
        path = self.studio.data / "A note.md"
        path.write_text("# Open me", encoding="utf-8")
        self.studio.openPath(str(path))
        self.await_idle()
        self.assertEqual(self.studio._current()["path"], str(path.resolve()))
        self.assertEqual(self.studio._current()["content"], "# Open me")

    def test_opening_already_open_note_selects_tab_and_focuses_reader(self):
        path=self.studio.data/"already-open.md"
        path.write_text("# Existing",encoding="utf-8")
        self.studio.openNote(str(path));self.await_idle()
        opened_id=self.studio.active
        self.studio.newNote()

        class Host(QObject):
            def __init__(self):
                super().__init__();self.raised=0;self.activated=0;self.focused=0
            def raise_(self):self.raised+=1
            def requestActivate(self):self.activated+=1
            @Slot()
            def focusReader(self):self.focused+=1

        host=Host();self.studio.host_window=host
        self.studio.openNote(str(path))
        deadline=time.monotonic()+1
        while not host.focused and time.monotonic()<deadline:
            self.app.processEvents();time.sleep(.005)
        self.assertEqual(self.studio.active,opened_id)
        self.assertEqual((host.raised,host.activated,host.focused),(1,1,1))

    def test_latest_explicit_open_wins_when_reads_finish_out_of_order(self):
        paths=[]
        for name in ("first-request.md","latest-request.md"):
            path=self.studio.data/name;path.write_text(f"# {name}",encoding="utf-8");paths.append(path)
        pending=[]
        with patch.object(self.studio,"_submit",side_effect=lambda action,done,*args,**kwargs:pending.append((action,done))):
            self.studio.openNote(str(paths[0]))
            self.studio.openNote(str(paths[1]))
            self.assertEqual(len(pending),2)
            action,done=pending[1];done(action(),None)
            latest_id=self.studio.active
            action,done=pending[0];done(action(),None)
        self.assertEqual(self.studio._current()["path"],str(paths[1].resolve()))
        self.assertEqual(self.studio.active,latest_id)
        self.assertEqual({tab["path"] for tab in self.studio.tabs if tab["path"]},{str(path.resolve()) for path in paths})

    def test_manual_tab_selection_wins_over_a_pending_open_completion(self):
        existing=self.studio.data/"selected-before-open.md";existing.write_text("# Selected",encoding="utf-8")
        self.studio.openNote(str(existing));self.await_idle();selected_id=self.studio.active
        self.studio.newNote()
        requested=self.studio.data/"slow-open.md";requested.write_text("# Slow",encoding="utf-8")
        pending=[]
        with patch.object(self.studio,"_submit",side_effect=lambda action,done,*args,**kwargs:pending.append((action,done))):
            self.studio.openNote(str(requested))
            self.studio.selectTab(selected_id)
            action,done=pending[0];done(action(),None)
        self.assertEqual(self.studio.active,selected_id)
        self.assertEqual(self.studio._current()["path"],str(existing.resolve()))

    def test_new_blank_note_wins_over_a_pending_open_completion(self):
        requested=self.studio.data/"slow-open-new-tab.md";requested.write_text("# Slow",encoding="utf-8")
        pending=[]
        with patch.object(self.studio,"_submit",side_effect=lambda action,done,*args,**kwargs:pending.append((action,done))):
            self.studio.openNote(str(requested))
            self.studio.newNote()
            new_id=self.studio.active
            action,done=pending[0];done(action(),None)
        self.assertEqual(self.studio.active,new_id)
        self.assertEqual(self.studio._current()["name"],"Untitled.md")

    def test_startup_restore_keeps_new_blank_tab_created_before_queued_restore(self):
        startup=self.session.data/"queued-startup.md";startup.write_text("# Startup",encoding="utf-8")
        self.session.settings.update(welcomed=True,startup="restore")
        restored=self.window()
        placeholder_id=restored.active
        restored._restoring_paths={str(startup.resolve())}
        restored._startup_order=[str(startup.resolve())]
        self.session.startup_active=str(startup.resolve())
        pending=[]
        with patch.object(restored,"_submit",side_effect=lambda action,done,*args,**kwargs:pending.append((action,done))):
            restored.newNote()
            new_id=restored.active
            # Simulate the queued startup callback, which captured generation 0
            # before the user created a new blank tab.
            restored._open_note(str(startup),explicit=False,activation_generation=0)
            self.assertEqual(len(pending),1)
            action,done=pending[0];done(action(),None)
        self.assertEqual(restored.active,new_id)
        self.assertIn(placeholder_id,[tab["id"] for tab in restored.tabs])
        self.assertIn(new_id,[tab["id"] for tab in restored.tabs])
        self.assertIn(str(startup.resolve()),[tab["path"] for tab in restored.tabs])

    def test_delayed_startup_restore_does_not_steal_explicit_open_focus(self):
        startup=self.studio.data/"startup-restore.md";startup.write_text("# Startup",encoding="utf-8")
        requested=self.studio.data/"requested.md";requested.write_text("# Requested",encoding="utf-8")
        self.session.startup_active=str(startup.resolve())
        self.studio._restoring_paths={str(startup.resolve())}
        pending=[]
        with patch.object(self.studio,"_submit",side_effect=lambda action,done,*args,**kwargs:pending.append((action,done))):
            self.studio.openNote(str(requested))
            # The queued startup callback must retain the generation from when
            # startup began, not inherit an explicit request made just before it runs.
            self.studio._open_note(str(startup),explicit=False,activation_generation=0)
            self.assertEqual(len(pending),2)
            action,done=pending[0];done(action(),None)
            requested_id=self.studio.active
            action,done=pending[1];done(action(),None)
        self.assertEqual(self.studio._current()["path"],str(requested.resolve()))
        self.assertEqual(self.studio.active,requested_id)
        self.assertEqual({tab["path"] for tab in self.studio.tabs if tab["path"]},{str(startup.resolve()),str(requested.resolve())})

    def test_background_external_refresh_updates_other_tab_without_changing_focus(self):
        first=self.studio.data/"background-refresh.md";first.write_text("# Original",encoding="utf-8")
        self.studio.openNote(str(first));self.await_idle();first_id=self.studio.active
        second=self.studio.data/"focused-note.md";second.write_text("# Focused",encoding="utf-8")
        self.studio.openNote(str(second));self.await_idle();focused_id=self.studio.active
        first.write_text("# External update",encoding="utf-8")
        self.studio._reload_changed_content({str(first.resolve())})
        self._wait_for(lambda:next(tab for tab in self.studio.tabs if tab["id"]==first_id)["content"]=="# External update")
        self.assertEqual(self.studio.active,focused_id)
        self.assertEqual(self.studio._current()["path"],str(second.resolve()))
        self.assertEqual(next(tab for tab in self.studio.tabs if tab["id"]==first_id)["content"],"# External update")

    def test_save_then_close_commits_the_file_before_closing(self):
        studio = self.studio
        path = studio.data/"saved.md"
        studio.newNote()
        studio._current().update(content="# Keep this",path=str(path))
        closed = []
        studio.allowClose.connect(lambda:closed.append(path.read_text()))
        self.assertFalse(studio.requestWindowClose())
        studio.resolveClose("save")
        self.await_idle()
        self.assertEqual(closed,["# Keep this"])

    def test_window_recovery_does_not_clobber_other_window(self):
        first,second = self.studio,self.window()
        first._current()["content"] = "First draft"
        second._current()["content"] = "Second draft"
        first._recover(); second._recover(); self.flush()
        recovered = json.loads((first.data/"recovery.json").read_text())
        self.assertEqual({t["content"] for t in recovered},{"First draft","Second draft"})
        second._current()["saved"] = second._current()["content"]
        second._recover(); self.flush()
        recovered = json.loads((first.data/"recovery.json").read_text())
        self.assertEqual([t["content"] for t in recovered],["First draft"])

    def test_unicode_settings_and_drafts_survive_non_utf8_system_locale(self):
        draft={"name":"Notes λ.md","content":"# λ 📖\n\\alpha + β","path":"","saved":"","assets":{}}
        atomic_json(self.session.data/"settings.json",{"settings":{"font":"字体 λ"},"recent":["Notes λ.md"]})
        atomic_json(self.session.data/"recovery.json",[draft])
        original_read=Path.read_text
        def locale_read(path,*args,**kwargs):
            # Match Windows machines whose implicit text codec is not UTF-8.
            if not args and "encoding" not in kwargs:kwargs["encoding"]="cp1252"
            return original_read(path,*args,**kwargs)
        with patch("studio.tempfile.mkdtemp",return_value=str(self.session.data)),patch.object(Path,"read_text",locale_read):
            restored=Session(True)
        try:
            self.assertEqual(restored.settings["font"],"字体 λ")
            self.assertEqual(restored.recent,["Notes λ.md"])
            self.assertEqual(restored.initial_recovery,[draft])
        finally:restored.writes.shutdown(wait=True)

    def test_close_folder_keeps_tabs_and_fullscreen_zoom_is_independent(self):
        studio = self.studio
        ids = [t["id"] for t in studio.tabs]
        studio.folder = str(studio.data)
        studio.closeFolder()
        self.assertEqual([t["id"] for t in studio.tabs],ids)
        self.assertEqual(studio.folder,"")
        studio.setZoom(130)
        studio.settings["fullZoom"]=70
        studio.setFullscreen(True)
        self.assertEqual(json.loads(studio.snapshot)["zoom"],130)
        studio.setZoom(210)
        studio.setFullscreen(False)
        self.assertEqual(json.loads(studio.snapshot)["zoom"],130)

    def test_empty_untitled_is_not_recovered_or_prompted(self):
        self.studio.newNote()
        self.studio._current()["content"] = " \n\t"
        self.studio._recover(); self.flush()
        self.assertEqual(json.loads((self.studio.data / "recovery.json").read_text()), [])
        self.assertTrue(self.studio.requestWindowClose())

    def test_autosave_commits_existing_note_and_pauses_for_external_edits(self):
        studio=self.studio
        path=studio.data / "autosave.md"
        path.write_text("original",encoding="utf-8")
        studio._current().update(path=str(path),content="first edit",saved="original")
        studio._autosave()
        deadline=time.monotonic()+3
        while studio.saving and time.monotonic()<deadline:
            self.app.processEvents();time.sleep(.005)
        self.assertEqual(path.read_text(),"first edit")
        self.assertEqual(studio._current()["saved"],"first edit")
        path.write_text("external edit",encoding="utf-8")
        studio._current()["content"]="second edit"
        studio._autosave()
        deadline=time.monotonic()+3
        while studio.saving and time.monotonic()<deadline:
            self.app.processEvents();time.sleep(.005)
        self.assertEqual(path.read_text(),"external edit")
        self.assertEqual(studio._current()["content"],"second edit")
        self.assertIn("changed",studio.message)

    def test_reorder_keeps_active_note_and_portable_assets(self):
        studio = self.studio
        studio.newNote(); studio.newNote()
        note = studio._current()
        note.update(content="![image](smd-asset:x)", assets={"x": "image bytes"}, portable=True)
        studio.receiveTab(studio.window_id, note["id"], 0)
        self.assertIs(studio.tabs[0], note)
        self.assertEqual(studio.active, note["id"])
        self.assertEqual(note["assets"], {"x": "image bytes"})

    def test_keyboard_move_reorders_only_the_active_tab_and_keeps_its_content(self):
        studio=self.studio
        first=studio._current()
        first.update(content="draft A",saved="",assets={"asset":"bytes"},portable=True)
        studio.newNote()
        second=studio._current();second["content"]="draft B"
        studio.moveActiveTab(-1)
        self.assertEqual([tab["id"] for tab in studio.tabs],[second["id"],first["id"]])
        self.assertEqual(studio.active,second["id"])
        self.assertEqual(second["content"],"draft B")
        self.assertEqual(first["assets"],{"asset":"bytes"})
        studio.moveActiveTab(1)
        self.assertEqual([tab["id"] for tab in studio.tabs],[first["id"],second["id"]])

    def test_window_transfer_flushes_latest_text_and_recovers_exactly_once(self):
        source, target = self.studio, self.window()
        note = source._current()
        note.update(assets={"image": "bytes"}, portable=True)
        source.ready = True
        target.receiveTab(source.window_id, note["id"], 0)
        self.assertIn(note, source.tabs)
        operation = dict(source.flush_operation)
        source.post("flush", "document_flushed", json.dumps({"id": note["id"], "content": "last keystroke", "operation": operation}))
        self.assertNotIn(note, source.tabs)
        self.assertIs(target.tabs[0], note)
        self.assertEqual(target.active, note["id"])
        self.assertEqual(note["content"], "last keystroke")
        self.assertEqual(note["assets"], {"image": "bytes"})
        self.flush()
        recovered = json.loads((source.data / "recovery.json").read_text())
        self.assertEqual([t["content"] for t in recovered], ["last keystroke"])

    def test_closed_or_busy_destination_cannot_lose_the_source_tab(self):
        source, target = self.studio, self.window()
        source.ready = True
        note = source._current()
        target.receiveTab(source.window_id, note["id"], 0)
        operation = dict(source.flush_operation)
        target.stop()
        source.post("flush", "document_flushed", json.dumps({"id": note["id"], "content": "keep me", "operation": operation}))
        self.assertIn(note, source.tabs)
        third = self.window(); third.busy = 1
        third.receiveTab(source.window_id, note["id"], 0)
        self.assertIn(note, source.tabs)
        self.assertIsNone(source.flush_operation)

    def test_detach_is_a_flush_then_request_not_a_destructive_close(self):
        studio = self.studio
        studio.ready = True
        requests = []
        studio.detachedWindowRequested.connect(lambda window, tab: requests.append((window, tab)))
        studio.detachTab(studio.active)
        operation = dict(studio.flush_operation)
        studio.post("flush", "document_flushed", json.dumps({"id": studio.active, "content": "unsaved", "operation": operation}))
        self.assertEqual(requests, [(studio.window_id, studio.active)])
        self.assertEqual(studio._current()["content"], "unsaved")

    def test_reader_reload_waits_for_latest_draft_and_view_snapshot_acknowledgement(self):
        studio=self.studio;studio.ready=True
        calls=[];reloads=[]
        studio.readerCall.connect(calls.append)
        studio.readerReloadRequested.connect(lambda:reloads.append(True))
        studio.reloadReaderSafely()
        operation=dict(studio.flush_operation)
        self.assertEqual(operation["action"],"reload_reader")
        self.assertEqual(calls,[f"window.supermdFlush?.({json.dumps(operation)})"])
        self.assertEqual(reloads,[])
        state={"top":842,"rendered":{"openDetails":["proof"]}}
        studio.post("reload","document_flushed",json.dumps({"id":studio.active,"content":"last keystroke","operation":operation,"viewId":studio.active,"viewState":state}))
        self.assertEqual(studio._current()["content"],"last keystroke")
        self.assertEqual(studio._current()["viewState"],state)
        self.assertEqual(reloads,[True])
        self.assertFalse(studio.ready)

    def test_share_markdown_uses_the_final_reader_snapshot_and_releases_tab_moves(self):
        path = self.studio.data / "shared.md"
        self.studio.exportTo(str(path), "md")
        self.assertFalse(self.studio._can_move())
        self.studio.post("export", "export_markdown_native", json.dumps({"id": self.studio.active, "content": "the final edit"}))
        self.await_idle()
        self.assertEqual(path.read_text(), "the final edit")
        self.assertTrue(self.studio._can_move())

    def test_settings_sync_and_invalid_themes_cannot_corrupt_the_ui(self):
        second = self.window()
        self.studio.setting("theme",'"light"')
        self.assertEqual(second.settings["theme"],"light")
        self.studio.setting("theme",'"not-a-theme"')
        self.studio.setting("size",'NaN')
        self.assertEqual(second.settings["theme"],"light")
        self.assertEqual(second.settings["size"],18)

    def test_shortcut_remaps_are_persisted_conflict_checked_and_resettable(self):
        studio=self.studio
        original=studio.shortcutSequences("find")
        self.assertTrue(original)
        conflict=studio.setShortcut("find",studio.shortcutSequences("open")[0])
        self.assertIn("Open note",conflict)
        self.assertEqual(studio.shortcutSequences("find"),original)
        self.assertEqual(studio.setShortcut("find","Ctrl+Alt+F"),"")
        self.assertEqual(studio.shortcutLabel("find"),"⌥⌘F" if sys.platform == "darwin" else "Ctrl+Alt+F")
        self.flush()
        stored=json.loads((studio.data/"settings.json").read_text())
        self.assertEqual(stored["settings"]["shortcuts"]["find"],["Ctrl+Alt+F"])
        self.assertEqual(studio.setShortcut("find",""),"")
        self.assertEqual(studio.shortcutLabel("find"),"Disabled")
        self.assertEqual(studio.resetShortcuts(),"")
        self.assertEqual(studio.shortcutSequences("find"),original)
        self.flush()
        restored=json.loads((studio.data/"settings.json").read_text())
        self.assertEqual(restored["settings"]["shortcuts"]["find"],original)

    def test_zoom_sends_a_delta_not_the_document_and_remembers_mode(self):
        self.studio.ready = True
        loads, calls = [], []
        self.studio.readerLoad.connect(loads.append)
        self.studio.readerCall.connect(calls.append)
        with patch('studio.time.time',return_value=1700000000.123):self.studio.setZoom(175)
        self.assertEqual(loads, [])
        self.assertEqual(calls, ["window.supermdSetZoom?.(175,1700000000123)"])
        self.studio.setMode("reader")
        operation=self.studio.flush_operation
        self.assertEqual(operation["action"],"mode")
        self.studio.post("flush-mode","document_flushed",json.dumps({"id":self.studio.active,"content":self.studio._current()["content"],"operation":operation}))
        self.assertEqual(self.window().mode, "reader")

    def test_export_names_are_typed_urls_and_never_double_encode_spaces(self):
        meta=self.studio.metaObject()
        for signature in ("defaultSaveLocation(QString)","defaultExportLocation(QString)"):
            self.assertEqual(meta.method(meta.indexOfMethod(signature)).typeName(),"QUrl")
        self.studio._current()["name"]="Quiz 2 Ω literal%20.md"
        for extension in ("pdf","smd"):
            target=self.studio.defaultExportLocation(extension)
            self.assertIsInstance(target,QUrl)
            self.assertEqual(Path(target.toLocalFile()).name,"Quiz 2 Ω literal%20."+extension)

    def test_export_format_writes_to_matching_suffix_and_preserves_url_filename(self):
        base=self.studio.data/"Quarterly Notes Ω literal%20.rev 2"
        selected=QUrl.fromLocalFile(str(base)).toString()
        markdown=Path(str(base)+".md")
        portable=Path(str(base)+".smd")

        self.studio.exportTo(selected,"md")
        self.assertEqual(self.studio.pending_export,str(markdown))
        gif="R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7"
        markdown_content="![Loop](images/loop.gif)"
        self.studio.post("markdown-export","export_markdown_native",json.dumps({"id":self.studio.active,"content":markdown_content,"assets":{"images/loop.gif":"data:image/gif;base64,"+gif}}))
        self.await_idle()
        self.assertEqual(markdown.read_text(encoding="utf-8"),markdown_content)
        self.assertEqual((markdown.parent/"images"/"loop.gif").read_bytes(),__import__("base64").b64decode(gif))

        self.studio.exportTo(selected,"smd")
        self.assertEqual(self.studio.pending_export,str(portable))
        self.studio.post("portable-export","export_fmd_native",json.dumps({"id":self.studio.active,"content":"Portable Markdown","assets":{},"save":False}))
        self.await_idle()
        from documents import open_note
        content, assets, is_portable = open_note(portable)
        self.assertTrue(is_portable)
        self.assertEqual(content,"Portable Markdown")
        self.assertEqual(assets,{})
        self.assertEqual(markdown.read_text(encoding="utf-8"),markdown_content)
        self.assertFalse(Path(str(base)+".smd.md").exists())

    def test_markdown_zip_export_preserves_raster_paths(self):
        import base64, zipfile
        base=self.studio.data/"Markdown bundle"
        selected=QUrl.fromLocalFile(str(base)).toString()
        target=Path(str(base)+".zip")
        gif="R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7"
        self.studio.exportTo(selected,"mdzip")
        self.assertEqual(self.studio.pending_export,str(target))
        self.studio.post("markdown-zip","export_markdown_native",json.dumps({"id":self.studio.active,"content":"![Loop](media/loop.gif)","assets":{"media/loop.gif":"data:image/gif;base64,"+gif},"archive":True}))
        self.await_idle()
        with zipfile.ZipFile(target) as archive:
            self.assertEqual(archive.namelist(),["Markdown bundle.md","media/loop.gif"])
            self.assertEqual(archive.read("media/loop.gif"),base64.b64decode(gif))

    def test_markdown_export_never_overwrites_the_original_note(self):
        source=self.studio.data/"original.md"
        original=b"# Original note\n![Photo](images/photo.gif)\n"
        source.write_bytes(original)
        self.studio._current()["path"]=str(source)
        self.studio.exportTo(QUrl.fromLocalFile(str(source)).toString(),"md")
        self.studio.post("same-path","export_markdown_native",json.dumps({"id":self.studio.active,"content":"replacement","assets":{"images/photo.gif":"data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7"}}))
        self.await_idle()
        self.assertEqual(source.read_bytes(),original)
        self.assertFalse((self.studio.data/"images"/"photo.gif").exists())

    def test_export_rejects_mismatched_suffixes_and_unconfirmed_appended_overwrite(self):
        calls=[]
        self.studio.readerCall.connect(calls.append)
        for name,format in (("wrong.smd","pdf"),("wrong.pdf","smd"),("wrong.md","pdf"),("wrong.pdf","md")):
            path=self.studio.data/name
            self.studio.exportTo(QUrl.fromLocalFile(str(path)).toString(),format)
            self.assertEqual(self.studio.pending_export,"")
            self.assertIn("ending in",self.studio.message)
            self.assertFalse(path.exists())
        self.assertEqual(calls,[])

        extensionless=self.studio.data/"report"
        actual_target=Path(str(extensionless)+".pdf")
        actual_target.write_bytes(b"keep existing bytes")
        self.studio.exportTo(QUrl.fromLocalFile(str(extensionless)).toString(),"pdf")
        self.assertEqual(self.studio.pending_export,"")
        self.assertIn("choose its full filename",self.studio.message)
        self.assertEqual(actual_target.read_bytes(),b"keep existing bytes")

    def test_export_legacy_and_markdown_alias_suffix_policy(self):
        for format in ("pdf", "smd", "md"):
            legacy=self.studio.data/f"old-{format}.fmd"
            self.studio.exportTo(QUrl.fromLocalFile(str(legacy)).toString(),format)
            self.assertEqual(self.studio.pending_export,"")
            self.assertIn("Legacy .fmd",self.studio.message)
            self.assertFalse(legacy.exists())

        for suffix in (".markdown", ".txt"):
            destination=self.studio.data/f"notes{suffix}"
            self.studio.exportTo(QUrl.fromLocalFile(str(destination)).toString(),"md")
            self.assertEqual(self.studio.pending_export,str(destination))
            self.studio.pending_export=""
            for format in ("pdf", "smd"):
                self.studio.exportTo(QUrl.fromLocalFile(str(destination)).toString(),format)
                self.assertEqual(self.studio.pending_export,"")
                self.assertIn("ending in",self.studio.message)
                self.assertFalse(Path(str(destination)+({"pdf":".pdf","smd":".smd"}[format])).exists())

    def test_export_preserves_matching_case_insensitive_multi_dot_extension(self):
        selected_path=self.studio.data/"Quarterly.notes Ω literal%20.v2.PDF"
        self.studio.exportTo(QUrl.fromLocalFile(str(selected_path)).toString(),"pdf")
        self.assertEqual(self.studio.pending_export,str(selected_path))
        self.assertFalse(Path(str(selected_path)+".pdf").exists())

    def test_export_dialog_tracks_selected_format_suffix_and_filters(self):
        qml=(Path(__file__).parent/"qml"/"Main.qml").read_text(encoding="utf-8")
        self.assertIn('defaultSuffix: exportFormat === "mdzip" ? "zip" : exportFormat',qml)
        for expected in ('PDF (*.pdf)', 'Markdown (*.md)', 'Markdown bundle (*.zip)', 'Portable Super MD (*.smd)'):
            self.assertIn(expected,qml)
        self.assertIn('property var availableFormats: ["pdf", "smd", "md", "mdzip"]',qml)
        self.assertIn('availableFormats.indexOf(outputFormat)',qml)
        self.assertIn('onActivated: outputFormat = exportDialog.availableFormats[currentIndex]',qml)

    def test_external_refresh_does_not_overwrite_a_draft(self):
        studio=self.studio;path=studio.data / "external.md"
        path.write_text("Original",encoding="utf-8")
        studio._current().update(path=str(path),content="Original",saved="Original")
        studio._emit();path.write_text("External update",encoding="utf-8")
        studio._external_note_changed(str(path));studio.external_timer.stop();studio._refresh_external_notes()
        deadline=time.monotonic()+3
        while studio._current()["content"]!="External update" and time.monotonic()<deadline:
            self.app.processEvents();time.sleep(.005)
        self.assertEqual(studio._current()["content"],"External update")
        studio._current()["content"]="Unsaved local draft"
        path.write_text("Second external version",encoding="utf-8")
        studio._external_note_changed(str(path));studio.external_timer.stop();studio._refresh_external_notes()
        self.app.processEvents()
        self.assertEqual(studio._current()["content"],"Unsaved local draft")

    def test_chrome_tab_navigation_reopen_and_last_tab_shortcut(self):
        first=self.studio.active
        self.studio.newNote();second=self.studio.active
        self.studio.newNote();third=self.studio.active
        self.studio._current().update(content="Keep this",saved="Keep this")
        self.studio.cycleTab(1);self.assertEqual(self.studio.active,first)
        self.studio.cycleTab(-1);self.assertEqual(self.studio.active,third)
        self.studio.tabNumber(2);self.assertEqual(self.studio.active,second)
        self.studio.tabNumber(9);self.assertEqual(self.studio.active,third)
        self.studio.closeTab(third)
        self._wait_for(lambda: all(tab["id"]!=third for tab in self.studio.tabs))
        self.studio.reopenTab()
        self._wait_for(lambda: self.studio.active==third)
        self.assertEqual(self.studio.active,third)
        self.assertEqual(self.studio._current()["content"],"Keep this")

    def _wait_for(self,predicate,timeout=5):
        deadline=time.monotonic()+timeout
        while not predicate() and time.monotonic()<deadline:
            self.app.processEvents();time.sleep(.005)
        self.assertTrue(predicate(),"condition did not complete")

    def test_close_persists_dirty_baseline_assets_and_reopen_restores_full_note(self):
        note=self.studio._current()
        note.update(name="Portable.smd",content="new draft",saved="old saved text",
                    assets={"assets/a.svg":"data:image/svg+xml;base64,PHN2Zy8+"},portable=True)
        note_id=note["id"]
        self.studio.closeTab(note_id)
        self.studio.resolveClose("discard")
        self.assertEqual(note["saved"],"old saved text")
        self._wait_for(lambda: all(tab["id"]!=note_id for tab in self.studio.tabs))
        reference=self.studio.closed_tabs[-1]
        self.assertEqual(reference["content"],"")
        self.studio.reopenTab()
        self._wait_for(lambda: self.studio.active==note_id)
        restored=self.studio._current()
        self.assertEqual(restored["content"],"new draft")
        self.assertEqual(restored["saved"],"old saved text")
        self.assertEqual(restored["assets"],note["assets"])
        self.assertTrue(restored["portable"])

    def test_close_aborts_when_note_changes_during_background_snapshot(self):
        import threading
        note=self.studio._current();note.update(content="captured",saved="captured")
        note_id=note["id"];started=threading.Event();release=threading.Event()
        store=self.session.closed_note_store;real_save=store.save
        def blocked(value):
            started.set();release.wait(3);return real_save(value)
        with patch.object(store,"save",side_effect=blocked):
            self.studio.closeTab(note_id)
            self.assertTrue(started.wait(2))
            note["content"]="latest reader text"
            release.set()
            self._wait_for(lambda: note_id not in self.studio._closing_tabs)
        self.assertIn(note,self.studio.tabs)
        self.assertEqual(note["content"],"latest reader text")
        self.assertEqual(self.studio.closed_tabs,[])

    def test_outline_names_untitled_notes_and_sets_export_filename(self):
        self.studio.newNote()
        self.studio.post("outline", "document_outline", json.dumps({"id": self.studio.active, "headings": [{"id":"energy", "title":"Energy / work", "level":1,"offset":0}]}))
        self.assertEqual(self.studio._current()["name"], "Energy  work.md")
        self.assertTrue(QUrl(self.studio.defaultExportLocation("pdf")).toLocalFile().endswith("Energy  work.pdf"))
        self.assertEqual(json.loads(self.studio.snapshot)["outline"][0]["id"], "energy")

    def test_close_waits_for_final_editor_snapshot(self):
        studio = self.studio
        studio.ready = True
        prompts,closed = [],[]
        studio.closeRequested.connect(prompts.append)
        studio.allowClose.connect(lambda:closed.append(True))
        studio.closeWindowSafely()
        self.assertEqual(prompts,[])
        operation = dict(studio.flush_operation)
        studio.post("flush","document_flushed",json.dumps({"id":studio.active,"content":"The last keystroke","operation":operation}))
        self.assertEqual(prompts,["Welcome.md"])
        self.assertEqual(closed,[])
        studio.resolveClose("discard")
        self.assertEqual(closed,[True])

    def test_stale_flush_cannot_close_a_later_operation(self):
        studio = self.studio
        studio.ready = True
        studio.closeWindowSafely()
        previous = dict(studio.flush_operation)
        studio.resolveFlush("cancel")
        studio.saveSafely()
        studio.post("flush","document_flushed",json.dumps({"id":studio.active,"content":"Stale draft","operation":previous}))
        self.assertNotEqual(studio._current()["content"],"Stale draft")
        self.assertEqual(studio.flush_operation["action"],"save")

    def test_open_relative_note_opens_contained_targets_and_emits_one_shot_pending_heading(self):
        studio = self.studio
        studio.ready = True
        loads = []
        replies = []
        studio.readerLoad.connect(lambda raw: loads.append(json.loads(raw)))
        studio.replied.connect(lambda req_id, value, err: replies.append((req_id, value, err)))

        folder = studio.data / "workspace"
        sub = folder / "sub"
        sub.mkdir(parents=True)
        index_note = folder / "Index.md"
        task_note = folder / "Task Note.md"
        lecture_note = folder / "Lecture 2.md"
        deck_note = sub / "study.smd"
        index_note.write_text("# Index\n\n[[Task Note]]\n", encoding="utf-8")
        task_note.write_text("# Task Note\n\nBody\n", encoding="utf-8")
        lecture_note.write_text("# Lecture 2\n\n## Bayes\n\nPosterior\n", encoding="utf-8")
        deck_note.write_text("# Portable text deck\n", encoding="utf-8")

        studio.openFolder(str(folder))
        studio.openNote(str(index_note))
        self._wait_for(lambda: studio._current()["path"] == str(index_note.resolve()))
        loads.clear()
        replies.clear()

        studio.post("rel-1", "open_workspace_link", json.dumps({
            "documentPath": str(index_note.resolve()),
            "target": "Task Note",
            "wikilink": True,
        }))
        self._wait_for(lambda: any(r[0] == "rel-1" for r in replies))
        self.assertEqual(replies[-1][2], "")
        self.assertTrue(json.loads(replies[-1][1])["opened"])
        self.assertEqual(studio._current()["path"], str(task_note.resolve()))
        self.assertNotIn("pendingHeading", loads[-1])

        loads.clear()
        replies.clear()
        noncanonical_task_ref = str(task_note.parent) + os.sep + "." + os.sep + task_note.name
        alias_root = studio.data / "workspace-alias"
        try:
            alias_root.symlink_to(folder, target_is_directory=True)
            noncanonical_task_ref = str(alias_root / task_note.name)
        except OSError as error:
            if getattr(error, "winerror", None) != 1314:
                raise
        studio.post("rel-2", "open_workspace_link", json.dumps({
            "documentPath": noncanonical_task_ref,
            "target": "Lecture%202.md",
            "fragment": "bayes",
            "wikilink": False,
        }))
        self._wait_for(lambda: any(r[0] == "rel-2" for r in replies))
        self.assertEqual(replies[-1][2], "")
        self.assertTrue(json.loads(replies[-1][1])["opened"])
        self.assertEqual(studio._current()["path"], str(lecture_note.resolve()))
        self.assertEqual(len(loads), 1)
        self.assertIn("content", loads[0])
        pending = loads[0].get("pendingHeading")
        self.assertIsInstance(pending, dict)
        self.assertEqual(pending["heading"], "bayes")
        self.assertTrue(bool(pending.get("token")))

        # Subsequent emits must not re-send the one-shot pendingHeading.
        loads.clear()
        studio._emit()
        self.assertNotIn("pendingHeading", loads[-1])

        # Opening a subfolder .smd note and navigating back up within the authorized workspace folder succeeds.
        replies.clear()
        studio.post("rel-3", "open_relative_note", json.dumps({
            "documentPath": str(lecture_note.resolve()),
            "target": "sub/study.smd",
        }))
        self._wait_for(lambda: any(r[0] == "rel-3" for r in replies))
        self.assertTrue(json.loads(replies[-1][1])["opened"])
        self.assertEqual(studio._current()["path"], str(deck_note.resolve()))

        loads.clear()
        replies.clear()
        studio.post("rel-4", "open_workspace_link", json.dumps({
            "documentPath": str(deck_note.resolve()),
            "target": "../Lecture%202.md",
            "fragment": "bayes",
            "wikilink": False,
        }))
        self._wait_for(lambda: any(r[0] == "rel-4" for r in replies))
        self.assertTrue(json.loads(replies[-1][1])["opened"])
        self.assertEqual(studio._current()["path"], str(lecture_note.resolve()))
        self.assertEqual(loads[-1].get("pendingHeading", {}).get("heading"), "bayes")

    def test_open_relative_note_rejects_unsaved_notes_traversal_encoded_separators_null_bytes_and_symlinks(self):
        studio = self.studio
        studio.ready = True
        replies = []
        studio.replied.connect(lambda req_id, value, err: replies.append((req_id, value, err)))

        # Unsaved note surfaces a status notice.
        studio.newNote()
        unsaved_id = studio.active
        studio.post("unsaved", "open_workspace_link", json.dumps({
            "documentPath": unsaved_id,
            "target": "Task%20Note.md",
            "wikilink": False,
        }))
        self._wait_for(lambda: any(r[0] == "unsaved" for r in replies))
        payload = json.loads(replies[-1][1])
        self.assertFalse(payload["opened"])
        self.assertIn("Save this note", payload["message"])
        self.assertEqual(studio.message, "Save this note before opening linked notes.")

        sandbox = studio.data / "containment"
        folder = sandbox / "guarded"
        folder.mkdir(parents=True)
        outside = sandbox / "outside.md"
        outside.write_text("# Secret\n", encoding="utf-8")
        inside = folder / "Inside.md"
        inside.write_text("# Inside\n", encoding="utf-8")
        symlink_note = folder / "Symlink.md"
        has_symlink = False
        try:
            symlink_note.symlink_to(outside)
            has_symlink = True
        except OSError as error:
            if getattr(error, "winerror", None) != 1314:
                raise

        studio.openNote(str(inside))
        self._wait_for(lambda: studio._current()["path"] == str(inside.resolve()))

        bad_targets = [
            "../outside.md",
            "../missing-outside.md",
            "sub%2f..%2f..%2foutside.md",
            "sub%5cnote.md",
            "bad%00.md",
            "bad\x00.md",
            "/etc/passwd.md",
        ]
        if has_symlink:
            bad_targets.append("Symlink.md")

        for index, bad_target in enumerate(bad_targets):
            replies.clear()
            studio.message = ""
            req = f"bad-{index}"
            studio.post(req, "open_workspace_link", json.dumps({
                "documentPath": str(inside.resolve()),
                "target": bad_target,
                "wikilink": False,
            }))
            self._wait_for(lambda: any(r[0] == req for r in replies))
            self.assertEqual(replies[-1][2], "")
            rejected = json.loads(replies[-1][1])
            self.assertFalse(rejected["opened"], f"Expected rejection for {bad_target}")
            self.assertTrue(bool(rejected.get("message")), f"Expected message for {bad_target}")
            if bad_target.startswith("../"):
                self.assertIn("outside the authorized folder", rejected["message"])
            self.assertEqual(studio.message, rejected["message"])
            self.assertEqual(studio._current()["path"], str(inside.resolve()))

        if not has_symlink:
            replies.clear()
            studio.message = ""
            with patch.object(Path, "is_symlink", autospec=True, side_effect=lambda p: p.name == "MockLink.md"):
                studio.post("bad-mock-link", "open_workspace_link", json.dumps({
                    "documentPath": str(inside.resolve()),
                    "target": "MockLink.md",
                    "wikilink": False,
                }))
                self._wait_for(lambda: any(r[0] == "bad-mock-link" for r in replies))
            rejected = json.loads(replies[-1][1])
            self.assertFalse(rejected["opened"])
            self.assertIn("symlink", rejected["message"])

        def _linux_inotify_fds() -> int | None:
            fd_dir = Path("/proc/self/fd")
            if not fd_dir.is_dir():
                return None
            total = 0
            for entry in os.listdir(fd_dir):
                try:
                    if "inotify" in os.readlink(fd_dir / entry):
                        total += 1
                except OSError:
                    pass
            return total

        inotify_before = _linux_inotify_fds()
        self.assertTrue(studio.note_watcher.files() or studio.note_watcher.directories())
        studio.stop()
        self.assertEqual(studio.note_watcher.files(), [])
        self.assertEqual(studio.note_watcher.directories(), [])
        inotify_after = _linux_inotify_fds()
        if inotify_before is not None and inotify_after is not None:
            self.assertLessEqual(inotify_after, inotify_before - 3)

    def test_open_relative_note_pending_heading_preserves_manual_tab_switch_and_batch_drop(self):
        from unittest.mock import patch

        studio = self.studio
        studio.ready = True
        loads = []
        studio.readerLoad.connect(lambda payload: loads.append(json.loads(payload)))

        folder = studio.data / "heading-drop-coexist"
        folder.mkdir(parents=True, exist_ok=True)
        index_note = folder / "index.md"
        keep_note = folder / "keep.md"
        linked_note = folder / "linked.md"
        drop_a = folder / "drop-a.md"
        drop_b = folder / "drop-b.md"
        index_note.write_text("# Index\n\n[[linked#Target]]\n", encoding="utf-8")
        keep_note.write_text("# Keep\n", encoding="utf-8")
        linked_note.write_text("# Linked\n\n## Target\n", encoding="utf-8")
        drop_a.write_text("# Drop A\n", encoding="utf-8")
        drop_b.write_text("# Drop B\n", encoding="utf-8")

        studio.openFolder(str(folder))
        studio.openNote(str(index_note))
        self._wait_for(lambda: studio._current()["path"] == str(index_note.resolve()))
        studio.openNote(str(keep_note))
        self._wait_for(lambda: studio._current()["path"] == str(keep_note.resolve()))
        keep_id = studio.active
        index_id = next(t["id"] for t in studio.tabs if t["path"] == str(index_note.resolve()))
        studio.selectTab(index_id)

        replies = []
        studio.replied.connect(lambda req_id, value, err: replies.append((req_id, value, err)))
        pending_reads: list[tuple[object, object]] = []

        def intercept_submit(action, done, *args, **kwargs):
            # Let background settings writes discard cleanly; capture worker tasks.
            if done.__name__ == "_noop_done":
                return
            pending_reads.append((action, done))

        with patch.object(studio, "_submit", side_effect=intercept_submit):
            studio.post("rel-coexist", "open_workspace_link", json.dumps({
                "documentPath": str(index_note.resolve()),
                "target": "linked.md",
                "fragment": "target",
                "wikilink": False,
            }))
            self.assertEqual(len(pending_reads), 1)
            resolve_action, resolve_done = pending_reads.pop()
            resolve_done(resolve_action(), None)
            self.assertEqual(len(pending_reads), 1)

            # User manually selects keep_id before the linked note finishes loading.
            studio.selectTab(keep_id)
            loads.clear()
            action, done = pending_reads.pop()
            done(action(), None)

        self.assertEqual(replies[-1][0], "rel-coexist")
        self.assertTrue(json.loads(replies[-1][1])["opened"])
        self.assertEqual(studio.active, keep_id)
        self.assertEqual(loads, [])
        linked_tab = next(t for t in studio.tabs if t["path"] == str(linked_note.resolve()))
        self.assertNotIn("pendingHeading", linked_tab)

        # Selecting linked_tab manually later must restore ordinarily without pendingHeading.
        studio.selectTab(linked_tab["id"])
        self.assertEqual(studio.active, linked_tab["id"])
        self.assertNotIn("pendingHeading", loads[-1])

        # Batch drop still preserves drop order and activates the last dropped note.
        pending_reads.clear()
        with patch.object(studio, "_submit", side_effect=intercept_submit):
            studio.handleExternalDrop(
                [QUrl.fromLocalFile(str(drop_a)), QUrl.fromLocalFile(str(drop_b))],
                True,
            )
            self.assertEqual(len(pending_reads), 2)
            # Complete out of order: drop_b (1) then drop_a (0).
            for idx in (1, 0):
                action, done = pending_reads[idx]
                done(action(), None)

        self.assertEqual(studio._current()["path"], str(drop_b.resolve()))
        tail_paths = [t["path"] for t in studio.tabs[-2:]]
        self.assertEqual(tail_paths, [str(drop_a.resolve()), str(drop_b.resolve())])

    def test_workspace_folder_and_expanded_subfolders_persist_across_restarts_tray_hides_and_multiwindow_shutdown(self):
        import tempfile
        with tempfile.TemporaryDirectory() as tmp:
            root_a = Path(tmp) / "workspace-a"
            sub_a = root_a / "math" / "algebra"
            sub_a.mkdir(parents=True)
            (root_a / "index.md").write_text("# Index\n")
            (sub_a / "basis.md").write_text("# Basis\n")

            root_b = Path(tmp) / "workspace-b"
            sub_b = root_b / "physics"
            sub_b.mkdir(parents=True)
            (sub_b / "waves.md").write_text("# Waves\n")

            # Open workspace A and expand nested subfolders in window 1.
            self.studio.openFolder(str(root_a))
            self.await_idle()
            self.studio.toggleDirectory(str(root_a / "math"))
            self.await_idle()
            self.studio.toggleDirectory(str(sub_a))
            self.await_idle()

            # Tray hide preserves in-memory and persisted state (stop isn't called on hide,
            # and persisted startup.json keeps folder + expanded).
            self.flush()
            persisted = json.loads((self.studio.data / "startup.json").read_text())
            expected_expanded_a = {
                str(root_a.resolve()),
                str((root_a / "math").resolve()),
                str(sub_a.resolve()),
            }
            win_entry = next(w for w in persisted["windows"] if w["windowId"] == self.studio.window_id)
            self.assertEqual(win_entry["folder"], str(root_a.resolve()))
            self.assertEqual(
                set(win_entry["expanded"]),
                expected_expanded_a,
            )

            # Open window 2 with workspace B and simulate multi-window tray quit
            # (service.quitting=True before app.aboutToQuit sets session.quitting=True).
            second = self.window()
            second.openFolder(str(root_b))
            self._wait_for(lambda: second.busy == 0)
            second.toggleDirectory(str(sub_b))
            self._wait_for(lambda: second.busy == 0)
            self.flush()
            expected_expanded_b = {str(root_b.resolve()), str(sub_b.resolve())}

            class FakeService:
                quitting = True

            self.session.background = FakeService()
            self.studio.stop()
            second.stop()
            self.flush()

            # Restart with startup == "restore": both windows restore their workspace folders & expanded paths.
            restored_session = Session(True, data=self.studio.data)
            w1 = w2 = None
            try:
                w1 = QuietStudio(True, restored_session)
                self.assertTrue(restored_session.has_pending_startup_windows())
                w2 = QuietStudio(True, restored_session)
                self.assertFalse(restored_session.has_pending_startup_windows())
                self._wait_for(
                    lambda: len(json.loads(w1.snapshot)["files"]) > 0
                    and len(json.loads(w2.snapshot)["files"]) > 0
                )

                self.assertEqual(w1.folder, str(root_a.resolve()))
                self.assertEqual(w1.expanded, expected_expanded_a)
                w1_paths = {entry["path"] for entry in json.loads(w1.snapshot)["files"]}
                self.assertIn(str((sub_a / "basis.md").resolve()), w1_paths)

                self.assertEqual(w2.folder, str(root_b.resolve()))
                self.assertEqual(w2.expanded, expected_expanded_b)
                w2_paths = {entry["path"] for entry in json.loads(w2.snapshot)["files"]}
                self.assertIn(str((sub_b / "waves.md").resolve()), w2_paths)
            finally:
                for w in (w1, w2):
                    if w is not None:
                        w.stop()
                        w.pool.shutdown(wait=True, cancel_futures=True)
                        w._search_pool.shutdown(wait=True, cancel_futures=True)
                restored_session.writes.shutdown(wait=True)

            # When startup != "restore", workspace folders are NOT restored on launch.
            self.session.settings["startup"] = "new"
            atomic_json(self.studio.data / "settings.json", {"settings": self.session.settings})
            fresh_session = Session(True, data=self.studio.data)
            fresh_win = None
            try:
                fresh_win = QuietStudio(True, fresh_session)
                self.assertEqual(fresh_win.folder, "")
                self.assertEqual(fresh_win.expanded, set())
                self.assertFalse(fresh_session.has_pending_startup_windows())
            finally:
                if fresh_win is not None:
                    fresh_win.stop()
                    fresh_win.pool.shutdown(wait=True, cancel_futures=True)
                    fresh_win._search_pool.shutdown(wait=True, cancel_futures=True)
                fresh_session.writes.shutdown(wait=True)

    def test_subfolder_search_scans_collapsed_subfolders_skips_hidden_and_symlinks_and_preserves_watchers(self):
        import tempfile
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "vault"
            (root / "courses" / "algebra").mkdir(parents=True)
            (root / "empty-branch" / "sub").mkdir(parents=True)
            (root / ".obsidian").mkdir(parents=True)
            outside = Path(tmp) / "outside"
            outside.mkdir()

            (root / "readme.md").write_text("# Root\n")
            (root / "courses" / "algebra" / "1.2 Linear Algebra.md").write_text("# LA\n")
            (root / "courses" / "algebra" / "scratch.txt").write_text("plain text note\n")
            (root / "empty-branch" / "other.md").write_text("# Unrelated\n")
            (root / ".obsidian" / "linear-secret.md").write_text("hidden dir\n")
            (root / ".linear-hidden.md").write_text("hidden file\n")
            (outside / "linear-external.md").write_text("outside\n")
            try:
                (root / "linked-outside").symlink_to(outside, target_is_directory=True)
                (root / "courses" / "linear-link.md").symlink_to(outside / "linear-external.md")
            except OSError:
                pass

            studio = self.studio
            studio.openFolder(str(root))
            self.await_idle()

            # Collapsed subfolders are NOT watched at rest.
            watched_dirs_before = set(studio.note_watcher.directories())
            expected_root_only = {str(root.resolve())}
            self.assertIn(str(root.resolve()), watched_dirs_before)
            self.assertNotIn(str((root / "courses").resolve()), watched_dirs_before)
            self.assertEqual(studio.expanded, expected_root_only)

            # Search across collapsed subfolders finds matching note & ancestor dirs only.
            studio.setFolderFilter("linear")
            self._wait_for(lambda: not studio.filter_timer.isActive() and not studio._folder_searching)
            snap = json.loads(studio.snapshot)
            names = [item["name"] for item in snap["files"]]
            self.assertEqual(names, ["courses", "algebra", "1.2 Linear Algebra.md"])
            self.assertEqual(studio.expanded, expected_root_only, "Search must not mutate expanded folder state")
            self.assertEqual(
                set(studio.note_watcher.directories()),
                watched_dirs_before,
                "Search must not add collapsed subdirectories to QFileSystemWatcher",
            )

            # Rapid queries cancel stale searches cleanly and converge on the latest filter.
            studio.setFolderFilter("readme")
            studio.setFolderFilter("scratch")
            self._wait_for(lambda: not studio.filter_timer.isActive() and not studio._folder_searching)
            snap = json.loads(studio.snapshot)
            self.assertEqual([item["name"] for item in snap["files"]], ["courses", "algebra", "scratch.txt"])

            # Zero matches produces an empty list while preserving folderFilter in snapshot.
            studio.setFolderFilter("nonexistent-xyz")
            self._wait_for(lambda: not studio.filter_timer.isActive() and not studio._folder_searching)
            snap = json.loads(studio.snapshot)
            self.assertEqual(snap["folderFilter"], "nonexistent-xyz")
            self.assertEqual(snap["files"], [])

            # Closing (or reopening) folder clears the active filter automatically.
            studio.closeFolder()
            self.assertEqual(studio.folder_filter, "")
            self.assertEqual(json.loads(studio.snapshot)["folderFilter"], "")

    def test_bundled_presets_saved_themes_override_resets_and_clean_exports(self):
        import custom_theme
        studio=self.studio;second=self.window()
        self.assertEqual(len(studio.bundledThemes),16)
        alpha={**custom_theme.TEMPLATE,"name":"Theme Alpha","variants":{"dark":{"colors":{"surface":"#191524"},"artwork":{"reader":{"image":"data:image/svg+xml;base64,PHN2Zy8+","opacity":.14,"fit":"cover"}}}}}
        beta={**custom_theme.TEMPLATE,"name":"Theme Beta","variants":{"dark":{"colors":{"surface":"#14211d"},"background":{"pattern":"grid","color":"#78b09c","opacity":.07,"size":24,"spacing":32}}}}
        source_a=studio.data/"alpha.supermd-theme.json";source_a.write_text(json.dumps(alpha))
        source_b=studio.data/"beta.supermd-theme.json";source_b.write_text(json.dumps(beta))

        def run_sync(call):
            pending=[]
            with patch.object(studio,"_engine",return_value=Path("unused-theme-engine")),patch.object(studio,"_submit",side_effect=lambda action,done,*_:pending.append((action,done))),patch("custom_theme.read",side_effect=lambda _,p:json.loads(Path(p).read_text())):
                call()
                while pending:
                    action,done=pending.pop(0);done(action(),None)

        studio.setting("patternKind",'"paws"');studio.setting("patternOpacity","0.12")
        run_sync(lambda:studio.importCustomTheme(str(source_a)))
        self.assertEqual(studio.customThemeName,"Theme Alpha");self.assertEqual(second.customThemeName,"Theme Alpha")
        self.assertEqual(studio.activeThemeKind,"saved");self.assertTrue(studio.customThemeHasSource)
        self.assertIn(str(source_a),studio.custom_theme_watcher.files())
        self.assertEqual(studio.settings["patternKind"],"");self.assertEqual(studio.settings["patternOpacity"],-1)
        # Omitted background stays None in reader style when no override is set; reader artwork opacity is never exposed as pattern opacity
        self.assertIsNone(custom_theme.reader(studio.session.custom_theme,"dark",True,studio.settings)["background"])
        self.assertEqual(studio.themeBackground,{"pattern":"none","opacity":.06,"size":24,"spacing":24})
        studio.setting("patternOpacity","0.02")
        self.assertEqual(custom_theme.reader(studio.session.custom_theme,"dark",True,studio.settings)["artwork"]["reader"]["opacity"],.14)

        # Importing a second theme retains the first across restarts and clears overrides
        run_sync(lambda:studio.importCustomTheme(str(source_b)))
        self.assertEqual(studio.customThemeName,"Theme Beta")
        self.assertEqual([item["name"] for item in studio.savedThemes],["Theme Alpha","Theme Beta"])
        self.assertEqual(studio.settings["patternOpacity"],-1)
        self.assertIn(str(source_b),studio.custom_theme_watcher.files())
        self.assertNotIn(str(source_a),studio.custom_theme_watcher.files())

        # Selecting a bundled preset or applying via reader guide clears overrides and pauses external file watching
        studio.setting("patternKind",'"dots"');studio.setting("patternSize","36")
        replies=[];studio.replied.connect(lambda identifier,value,error:replies.append((identifier,value,error)))
        run_sync(lambda:studio.post("guide-preset","apply_bundled_theme",json.dumps({"id":"study-desk"})))
        self.assertEqual((replies[-1][0],json.loads(replies[-1][1]),replies[-1][2]),("guide-preset",{"id":"study-desk","name":"Study desk"},""))
        self.assertEqual(studio.activeThemeKind,"preset");self.assertEqual(studio.activeThemeId,"study-desk")
        self.assertEqual(studio.customThemeName,"Study desk");self.assertEqual(second.customThemeName,"Study desk")
        self.assertFalse(studio.customThemeHasSource);self.assertEqual(studio.custom_theme_watcher.files(),[])
        self.assertEqual((studio.settings["patternKind"],studio.settings["patternSize"]),("",0))

        # Clean export never bakes viewing-only overrides into active themes or starter templates
        studio.setting("patternKind",'"paws"');studio.setting("patternOpacity","0.15")
        exported_preset=studio.data/"exported-preset.json"
        studio.exportCustomTheme(str(exported_preset))
        self.assertNotEqual(json.loads(exported_preset.read_text())["variants"]["dark"].get("background",{}).get("pattern"),"paws")

        # Switching back to Theme Alpha across a restarted Session restores saved library & persisted overrides on startup
        self.flush()
        alpha_id=next(item["id"] for item in studio.savedThemes if item["name"]=="Theme Alpha")
        run_sync(lambda:studio.selectSavedTheme(alpha_id))
        self.assertEqual(studio.customThemeName,"Theme Alpha")
        self.assertTrue(studio.customThemeHasSource);self.assertIn(str(source_a),studio.custom_theme_watcher.files())
        self.assertEqual(studio.settings["patternKind"],"")
        studio.setting("patternKind",'"grid"')
        self.flush()

        restarted_session=Session(True,data=studio.data)
        self.assertEqual([item["name"] for item in restarted_session.saved_themes],["Theme Alpha","Theme Beta"])
        self.assertEqual(restarted_session.active_theme_kind,"saved")
        self.assertEqual(restarted_session.settings["patternKind"],"grid")
        restarted_session.writes.shutdown(wait=True)

        # Deleting active saved theme keeps user's source file on disk and resets to Built-in while retaining Theme Beta
        studio.deleteSavedTheme(alpha_id)
        self.assertTrue(source_a.is_file())
        self.assertEqual(studio.activeThemeKind,"builtin");self.assertEqual(studio.customThemeName,"Built-in appearance")
        self.assertEqual([item["name"] for item in studio.savedThemes],["Theme Beta"])
        self.assertEqual(studio.settings["patternKind"],"")
        exported_template=studio.data/"starter-template.json"
        studio.setting("patternKind",'"paws"')
        studio.exportCustomTheme(str(exported_template))
        self.assertEqual(json.loads(exported_template.read_text()),custom_theme.TEMPLATE)

    def test_legacy_single_theme_migrates_into_saved_theme_library(self):
        import custom_theme
        legacy_dir=self.studio.data/"legacy-workspace";legacy_dir.mkdir(parents=True)
        source=legacy_dir/"external.supermd-theme.json";source.write_text("{}")
        atomic_json(legacy_dir/"theme.json",{**custom_theme.TEMPLATE,"name":"Legacy Imported"})
        atomic_json(legacy_dir/"theme-source.json",{"path":str(source)})
        migrated=Session(True,data=legacy_dir)
        try:
            self.assertEqual(migrated.active_theme_kind,"saved")
            self.assertEqual(len(migrated.saved_themes),1)
            self.assertEqual(migrated.saved_themes[0]["name"],"Legacy Imported")
            self.assertEqual(migrated.saved_themes[0]["source"],str(source))
        finally:
            migrated.writes.shutdown(wait=True)

    def test_reopen_closed_tab_restores_most_recent_first_and_persists_across_restart(self):
        studio = self.studio
        first = studio._current()
        first.update(name="First.md", content="First note", saved="First note")
        first_id = first["id"]
        studio.newNote()
        second = studio._current()
        second.update(name="Second.md", content="Second note", saved="Second note")
        second_id = second["id"]
        studio.newNote()
        studio._current().update(name="Stay.md", content="Stay open", saved="Stay open")

        studio.closeTab(first_id)
        self._wait_for(lambda: all(t["id"] != first_id for t in studio.tabs))
        studio.closeTab(second_id)
        self._wait_for(lambda: all(t["id"] != second_id for t in studio.tabs))
        self.assertEqual(json.loads(studio.snapshot)["closedCount"], 2)

        studio.reopenTab()
        self._wait_for(lambda: studio.active == second_id)
        self.assertEqual(studio._current()["content"], "Second note")
        self.assertEqual(json.loads(studio.snapshot)["closedCount"], 1)

        # Simulate an app restart reading closed-notes/index.json from the same data dir.
        restarted_store = studio.session.closed_note_store.__class__(studio.session.closed_note_store.root)
        persisted_refs = restarted_store.load_index_strict()
        self.assertEqual(len(persisted_refs), 1)
        self.assertEqual(persisted_refs[0]["id"], first_id)

        studio.reopenTab()
        self._wait_for(lambda: studio.active == first_id)
        self.assertEqual(studio._current()["content"], "First note")
        persisted_after = restarted_store.load_index_strict()
        self.assertEqual(persisted_after, [])

    def test_window_close_discard_preserves_closed_tab_snapshot(self):
        studio = self.studio
        note = studio._current()
        note.update(name="WindowDraft.md", content="Unsaved window draft", saved="")
        note_id = note["id"]
        self.assertFalse(studio.requestWindowClose())
        studio.resolveClose("discard")
        self.assertEqual(len(studio.closed_tabs), 1)
        restored = studio.session.closed_note_store.load(studio.closed_tabs[0])
        self.assertEqual(restored["id"], note_id)
        self.assertEqual(restored["content"], "Unsaved window draft")

    def test_proactive_conflict_detection_pauses_autosave_for_md_and_smd(self):
        from documents import write_portable
        studio = self.studio
        md_path = studio.data / "conflict.md"
        md_path.write_text("base md", encoding="utf-8")
        md_tab = studio._current()
        md_tab.update(name="conflict.md", path=str(md_path), content="local md draft", saved="base md")
        studio._emit(False)

        md_path.write_text("external md change", encoding="utf-8")
        studio._external_note_changed(str(md_path))
        studio.external_timer.stop()
        studio._refresh_external_notes()
        self._wait_for(lambda: bool(md_tab.get("conflict")))
        self.assertTrue(json.loads(studio.snapshot)["conflict"])
        self.assertEqual(md_tab["content"], "local md draft")

        # Autosave must stay paused for the conflicted tab while non-conflicted tabs still autosave.
        clean_other_path = studio.data / "other.md"
        clean_other_path.write_text("other base", encoding="utf-8")
        studio.newNote()
        other_tab = studio._current()
        other_tab.update(name="other.md", path=str(clean_other_path), content="other draft", saved="other base")
        studio._autosave()
        self._wait_for(lambda: not studio.saving)
        self.assertEqual(md_path.read_text(encoding="utf-8"), "external md change")
        self.assertEqual(clean_other_path.read_text(encoding="utf-8"), "other draft")

        # Portable .smd external asset-only change on a dirty tab must also flag conflict and pause autosave.
        svg_a = "data:image/svg+xml;base64,PHN2Zy8+"
        svg_b = "data:image/svg+xml;base64,PHN2ZyBpZD0iYiIvPg=="
        smd_path = studio.data / "portable.smd"
        write_portable(smd_path, "base smd", {"assets/a.svg": svg_a})
        studio.newNote()
        smd_tab = studio._current()
        smd_tab.update(
            name="portable.smd",
            path=str(smd_path),
            content="local smd draft",
            saved="base smd",
            assets={"assets/a.svg": svg_a},
            saved_assets={"assets/a.svg": svg_a},
            portable=True,
        )
        studio._emit(False)
        write_portable(smd_path, "base smd", {"assets/a.svg": svg_b})
        studio._external_note_changed(str(smd_path))
        studio.external_timer.stop()
        studio._refresh_external_notes()
        self._wait_for(lambda: bool(smd_tab.get("conflict")))
        self.assertTrue(json.loads(studio.snapshot)["conflict"])

    def test_guarded_manual_save_and_conflict_resolution_for_md_and_smd(self):
        from documents import open_note, write_portable
        studio = self.studio
        conflicts = []
        studio.saveConflictRequested.connect(conflicts.append)

        md_path = studio.data / "guarded.md"
        md_path.write_text("v1", encoding="utf-8")
        tab = studio._current()
        tab.update(name="guarded.md", path=str(md_path), content="my local draft", saved="v1")

        # External modification before watcher even runs: manual Save must detect and block overwrite!
        md_path.write_text("external v2", encoding="utf-8")
        studio.save()
        self._wait_for(lambda: len(conflicts) == 1)
        self.assertEqual(conflicts, ["guarded.md"])
        self.assertTrue(tab["conflict"])
        self.assertEqual(md_path.read_text(encoding="utf-8"), "external v2")

        # Repeating Save while already flagged immediately re-requests conflict resolution without writing.
        studio.save()
        self.assertEqual(conflicts, ["guarded.md", "guarded.md"])
        self.assertEqual(md_path.read_text(encoding="utf-8"), "external v2")

        # Choosing Overwrite writes the draft and clears conflict.
        studio.resolveConflict("overwrite")
        self._wait_for(lambda: not tab["conflict"] and not studio.saving)
        self.assertEqual(md_path.read_text(encoding="utf-8"), "my local draft")
        self.assertEqual(tab["saved"], "my local draft")

        # Modify externally again, edit locally, then choose Reload from disk.
        md_path.write_text("disk v3", encoding="utf-8")
        tab["content"] = "discardable draft"
        studio.save()
        self._wait_for(lambda: tab["conflict"])
        studio.resolveConflict("reload")
        self._wait_for(lambda: not tab["conflict"] and studio.busy == 0)
        self.assertEqual(tab["content"], "disk v3")
        self.assertEqual(tab["saved"], "disk v3")

        # Guarded manual Save on live portable .smd (ready=True) also blocks external changes.
        svg_a = "data:image/svg+xml;base64,PHN2Zy8+"
        svg_b = "data:image/svg+xml;base64,PHN2ZyBpZD0iYiIvPg=="
        smd_path = studio.data / "guarded.smd"
        write_portable(smd_path, "smd v1", {"assets/a.svg": svg_a})
        studio.newNote()
        smd_tab = studio._current()
        smd_tab.update(
            name="guarded.smd",
            path=str(smd_path),
            content="smd local",
            saved="smd v1",
            assets={"assets/a.svg": svg_a},
            saved_assets={"assets/a.svg": svg_a},
            portable=True,
        )
        studio.ready = True
        write_portable(smd_path, "smd external", {"assets/a.svg": svg_b})
        conflicts.clear()
        studio.post(
            "portable-save",
            "export_fmd_native",
            json.dumps({
                "id": smd_tab["id"],
                "save": True,
                "content": "smd local",
                "originalContent": "smd local",
                "assets": {"assets/a.svg": svg_a},
            }),
        )
        self._wait_for(lambda: len(conflicts) == 1)
        self.assertEqual(conflicts, ["guarded.smd"])
        self.assertTrue(smd_tab["conflict"])
        self.assertEqual(open_note(smd_path)[:2], ("smd external", {"assets/a.svg": svg_b}))

    def test_save_as_rebinds_tab_saves_assets_and_clears_conflict(self):
        from documents import open_note, write_portable
        studio = self.studio
        svg_a = "data:image/svg+xml;base64,PHN2Zy8+"
        orig_md = studio.data / "orig.md"
        orig_md.write_text("disk md", encoding="utf-8")
        tab = studio._current()
        tab.update(
            name="orig.md",
            path=str(orig_md),
            content="draft with ![pic](assets/a.svg)",
            saved="old md",
            assets={"assets/a.svg": svg_a},
            conflict=True,
        )
        copy_md = studio.data / "saved-copy.md"
        studio.saveAs(str(copy_md))
        self._wait_for(lambda: not studio.saving and tab["path"] == str(copy_md))
        self.assertEqual(tab["name"], "saved-copy.md")
        self.assertFalse(tab["conflict"])
        self.assertFalse(json.loads(studio.snapshot)["conflict"])
        self.assertFalse(studio._is_dirty(tab))
        self.assertEqual(copy_md.read_text(encoding="utf-8"), "draft with ![pic](assets/a.svg)")
        self.assertTrue((studio.data / "assets" / "a.svg").is_file())
        self.assertEqual(orig_md.read_text(encoding="utf-8"), "disk md")

        # Now test Save As on an already-saved conflicted .smd via live reader bridge.
        orig_smd = studio.data / "orig.smd"
        write_portable(orig_smd, "external smd", {})
        studio.newNote()
        smd_tab = studio._current()
        smd_tab.update(
            name="orig.smd",
            path=str(orig_smd),
            content="portable draft ![pic](assets/a.svg)",
            saved="base smd",
            assets={"assets/a.svg": svg_a},
            saved_assets={"assets/a.svg": svg_a},
            portable=True,
            conflict=True,
        )
        studio.ready = True
        copy_smd = studio.data / "rebound.smd"
        studio.saveAs(str(copy_smd))
        studio.post(
            "portable-save-as",
            "export_fmd_native",
            json.dumps({
                "id": smd_tab["id"],
                "save": False,
                "content": smd_tab["content"],
                "originalContent": smd_tab["content"],
                "assets": {"assets/a.svg": svg_a},
            }),
        )
        self._wait_for(lambda: smd_tab["path"] == str(copy_smd) and studio.busy == 0)
        self.assertEqual(smd_tab["name"], "rebound.smd")
        self.assertFalse(smd_tab["conflict"])
        self.assertFalse(studio._is_dirty(smd_tab))
        self.assertEqual(open_note(copy_smd), ("portable draft ![pic](assets/a.svg)", {"assets/a.svg": svg_a}, True))
        self.assertEqual(open_note(orig_smd), ("external smd", {}, True))

    def test_qmd_and_rmd_open_dialog_folder_list_filename_search_and_ordinary_save(self):
        import fnmatch
        import re
        from PySide6.QtCore import QRegularExpression, Qt
        from folder_ops import note_extension, note_stem, validate_entry_name
        from studio import export_destination

        repo_root = Path(__file__).resolve().parent.parent
        main_qml = (repo_root / "desktop" / "qml" / "Main.qml").read_text(encoding="utf-8")
        filter_match = re.search(r'id:\s*openDialog.*?nameFilters:\s*\["Notes \(([^)]+)\)"', main_qml, re.DOTALL)
        self.assertIsNotNone(filter_match)
        globs = filter_match.group(1).split()

        for sample in (
            "report.qmd",
            "REPORT.QMD",
            "Mixed.qMd",
            "analysis.Rmd",
            "analysis.rmd",
            "ANALYSIS.RMD",
            "Mixed.rMd",
        ):
            self.assertTrue(
                any(
                    QRegularExpression.fromWildcard(
                        pattern, Qt.CaseSensitivity.CaseInsensitive
                    ).match(sample).hasMatch()
                    for pattern in globs
                ),
                f"Expected Qt wildcard filter to match {sample}",
            )

        for portal_sample in ("report.qmd", "REPORT.QMD", "analysis.Rmd", "analysis.rmd", "ANALYSIS.RMD"):
            self.assertTrue(
                any(fnmatch.fnmatchcase(portal_sample, pattern) for pattern in globs),
                f"Expected case-sensitive desktop portal glob to match {portal_sample}",
            )

        # OS file associations must remain untouched in this slice.
        for assoc_rel in (
            "desktop/windows/installer.nsi",
            "desktop/linux/dev.supermd.studio.desktop",
            "desktop/linux/supermd.xml",
            "desktop/core/app_integration.py",
            "desktop/install_linux.py",
            "android/app/src/main/AndroidManifest.xml",
        ):
            assoc_text = (repo_root / assoc_rel).read_text(encoding="utf-8")
            self.assertNotRegex(assoc_text, r"(?i)\.(qmd|rmd)\b", f"Unexpected OS association in {assoc_rel}")

        import studio as studio_mod
        if hasattr(studio_mod, "FOLDER_TREE_NOTE_SUFFIXES"):
            self.assertEqual(studio_mod.FOLDER_TREE_NOTE_SUFFIXES, frozenset({".md", ".smd", ".txt"}))

        folder = self.studio.data / "quarto-rmd-workspace"
        sub = folder / "biostats"
        sub.mkdir(parents=True)
        qmd_only_sub = folder / "quarto-archive"
        qmd_only_sub.mkdir(parents=True)

        qmd_initial = (
            "---\n"
            "title: \"Quarto Longitudinal Study\"\n"
            "format: html\n"
            "---\n\n"
            "# Quarto Study\n\n"
            "```{python}\n"
            "#| label: fig-curve\n"
            "#| echo: false\n"
            "x = [1, 2, 3]\n"
            "```\n\n"
            "```{mermaid}\n"
            "graph LR\n"
            "  Raw --> Clean\n"
            "```\n"
        )
        rmd_initial = (
            "---\n"
            "title: \"Clinical Trial Summary\"\n"
            "output: html_document\n"
            "---\n\n"
            "```{r setup, include=FALSE}\n"
            "knitr::opts_chunk$set(echo = TRUE)\n"
            "```\n\n"
            "Baseline prose with inline math $\\alpha = 0.05$.\n"
        )

        qmd_path = folder / "quarto-guide.qmd"
        rmd_path = folder / "ClinicalTrial.Rmd"
        upper_qmd = folder / "UPPER_REPORT.QMD"
        mixed_qmd = folder / "MixedCase.qMd"
        sub_overview_md = sub / "Overview.md"
        sub_upper_rmd = sub / "SurvivalModel.RMD"
        sub_lower_rmd = sub / "lowercase.rmd"
        sub_mixed_rmd = sub / "weird.rMd"
        archive_qmd = qmd_only_sub / "appendix.qmd"

        qmd_path.write_text(qmd_initial, encoding="utf-8")
        rmd_path.write_text(rmd_initial, encoding="utf-8")
        upper_qmd.write_text("# Upper QMD\n", encoding="utf-8")
        mixed_qmd.write_text("# Mixed qMd\n", encoding="utf-8")
        sub_overview_md.write_text("# Biostats Overview\n", encoding="utf-8")
        sub_upper_rmd.write_text("# Survival RMD\n", encoding="utf-8")
        sub_lower_rmd.write_text("# Lower rmd\n", encoding="utf-8")
        sub_mixed_rmd.write_text("# Mixed rMd\n", encoding="utf-8")
        archive_qmd.write_text("# Appendix QMD\n", encoding="utf-8")
        (folder / ".hidden.qmd").write_text("hidden", encoding="utf-8")
        (folder / ".hidden.Rmd").write_text("hidden", encoding="utf-8")
        (folder / "qmd").write_text("dotless qmd", encoding="utf-8")
        (folder / "rmd").write_text("dotless rmd", encoding="utf-8")
        (folder / "dataset.csv").write_text("a,b\n1,2\n", encoding="utf-8")

        studio = self.studio
        hides_qmd_only_subfolder = hasattr(studio_mod, "_directory_has_visible_note") and bool(
            studio.settings.get("hideNonNoteFolders", True)
        )
        expected_root_entries = [
            ("biostats", True),
            *(() if hides_qmd_only_subfolder else (("quarto-archive", True),)),
            ("ClinicalTrial.Rmd", False),
            ("MixedCase.qMd", False),
            ("quarto-guide.qmd", False),
            ("UPPER_REPORT.QMD", False),
        ]

        studio.openFolder(str(folder))
        self._wait_for(lambda: [(e["name"], e["directory"]) for e in studio.files] == expected_root_entries)

        # Expanding an already-visible folder lists .Rmd/.rmd/.rMd alongside .md notes.
        studio.toggleDirectory(str(sub))
        expected_expanded_entries = [
            ("biostats", True),
            ("lowercase.rmd", False),
            ("Overview.md", False),
            ("SurvivalModel.RMD", False),
            ("weird.rMd", False),
            *(() if hides_qmd_only_subfolder else (("quarto-archive", True),)),
            ("ClinicalTrial.Rmd", False),
            ("MixedCase.qMd", False),
            ("quarto-guide.qmd", False),
            ("UPPER_REPORT.QMD", False),
        ]
        self._wait_for(lambda: [(e["name"], e["directory"]) for e in studio.files] == expected_expanded_entries)
        studio.toggleDirectory(str(sub))
        self._wait_for(lambda: [(e["name"], e["directory"]) for e in studio.files] == expected_root_entries)

        # Filename search at root + collapsed subfolders across case variants (including quarto-archive).
        studio.setFolderFilter(".rmd")
        self._wait_for(
            lambda: not studio.filter_timer.isActive()
            and not studio._folder_searching
            and [entry["name"] for entry in studio.files if not entry["directory"]]
            == ["lowercase.rmd", "SurvivalModel.RMD", "weird.rMd", "ClinicalTrial.Rmd"]
        )

        studio.setFolderFilter(".QMD")
        self._wait_for(
            lambda: not studio.filter_timer.isActive()
            and not studio._folder_searching
            and [entry["name"] for entry in studio.files if not entry["directory"]]
            == ["appendix.qmd", "MixedCase.qMd", "quarto-guide.qmd", "UPPER_REPORT.QMD"]
        )

        studio.setFolderFilter("survival")
        self._wait_for(
            lambda: not studio.filter_timer.isActive()
            and not studio._folder_searching
            and [entry["name"] for entry in studio.files if not entry["directory"]] == ["SurvivalModel.RMD"]
        )
        studio.setFolderFilter("")
        self._wait_for(lambda: [(e["name"], e["directory"]) for e in studio.files] == expected_root_entries)

        # Helper stem/extension preservation checks.
        self.assertEqual(note_extension("ClinicalTrial.Rmd"), ".Rmd")
        self.assertEqual(note_stem("ClinicalTrial.Rmd"), "ClinicalTrial")
        self.assertEqual(note_extension("UPPER_REPORT.QMD"), ".QMD")
        self.assertEqual(validate_entry_name("Experiment", is_directory=False, current_ext=".Rmd"), "Experiment.Rmd")
        self.assertEqual(validate_entry_name("Experiment.Rmd", is_directory=False, current_ext=".Rmd"), "Experiment.Rmd")
        self.assertEqual(validate_entry_name("Experiment", is_directory=False, current_ext=".qmd"), "Experiment.qmd")
        self.assertEqual(export_destination(str(rmd_path), "md"), rmd_path)
        self.assertEqual(export_destination(str(qmd_path), "md"), qmd_path)

        # Open, ordinary edit, and save for .qmd preserves exact filename and raw source.
        studio.openNote(str(qmd_path))
        self._wait_for(lambda: studio._current()["name"] == "quarto-guide.qmd" and studio.busy == 0)
        qmd_tab = studio._current()
        self.assertEqual(qmd_tab["name"], "quarto-guide.qmd")
        self.assertEqual(qmd_tab["path"], str(qmd_path))
        self.assertFalse(qmd_tab["portable"])
        self.assertEqual(qmd_tab["content"], qmd_initial)

        qmd_edited = qmd_initial + "\nUpdated longitudinal interpretation.\n"
        qmd_tab["content"] = qmd_edited
        studio.save()
        self._wait_for(lambda: not studio.saving and not studio._is_dirty(qmd_tab))
        self.assertEqual(qmd_tab["name"], "quarto-guide.qmd")
        self.assertEqual(qmd_tab["path"], str(qmd_path))
        self.assertEqual(qmd_path.read_text(encoding="utf-8"), qmd_edited)
        self.assertFalse((folder / "quarto-guide.md").exists())
        self.assertFalse((folder / "quarto-guide.smd").exists())

        # Open, ordinary edit, save, and autosave for .Rmd preserves capital-R .Rmd and R chunks verbatim.
        studio.openNote(str(rmd_path))
        self._wait_for(lambda: studio._current()["name"] == "ClinicalTrial.Rmd" and studio.busy == 0)
        rmd_tab = studio._current()
        self.assertEqual(rmd_tab["name"], "ClinicalTrial.Rmd")
        self.assertEqual(rmd_tab["path"], str(rmd_path))
        self.assertFalse(rmd_tab["portable"])
        self.assertEqual(rmd_tab["content"], rmd_initial)
        self.assertTrue(studio.defaultExportLocation("pdf").toLocalFile().endswith("ClinicalTrial.pdf"))

        rmd_edited = rmd_initial + "\nPrimary endpoint remained unchanged.\n"
        rmd_tab["content"] = rmd_edited
        studio.save()
        self._wait_for(lambda: not studio.saving and not studio._is_dirty(rmd_tab))
        self.assertEqual(rmd_tab["name"], "ClinicalTrial.Rmd")
        self.assertEqual(rmd_tab["path"], str(rmd_path))
        self.assertEqual(rmd_path.read_text(encoding="utf-8"), rmd_edited)
        self.assertFalse((folder / "ClinicalTrial.md").exists())

        rmd_autosaved = rmd_edited + "Autosaved follow-up paragraph.\n"
        rmd_tab["content"] = rmd_autosaved
        studio._autosave()
        self._wait_for(lambda: not studio.saving and rmd_path.read_text(encoding="utf-8") == rmd_autosaved)
        self.assertEqual(rmd_tab["name"], "ClinicalTrial.Rmd")
        self.assertEqual(rmd_tab["path"], str(rmd_path))
        self.assertFalse((folder / "ClinicalTrial.md").exists())
