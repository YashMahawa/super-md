import hashlib
import io
import ssl
import socket
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock, patch
import updates

class UpdateTest(unittest.TestCase):
    def fixture(self):
        names=('Super-MD_1.2.3_amd64.AppImage','Super-MD_1.2.3_amd64.deb','Super-MD-1.2.3-1.x86_64.rpm','Super-MD_1.2.3_x64-setup.exe','Super-MD_1.2.3_x64.dmg','Super-MD_1.2.3_aarch64.dmg')
        return {'tag_name':'v1.2.3','draft':False,'prerelease':False,'assets':[
            *[{'name':name,'size':4,'browser_download_url':updates.REPO+'/releases/download/v1.2.3/'+name} for name in names],
            {'name':'SHA256SUMS','size':100,'browser_download_url':updates.REPO+'/releases/download/v1.2.3/SHA256SUMS'}]}
    def test_stable_versions_and_platform_asset(self):
        self.assertGreater(updates.version('0.10.0'),updates.version('0.9.99'))
        self.assertIsNone(updates.release_info(self.fixture(),'1.2.3','linux','x86_64'))
        info=updates.release_info(self.fixture(),'1.2.2','linux','x86_64')
        self.assertEqual(info['name'],'Super-MD_1.2.3_amd64.AppImage')
        for kind,name in (("deb","Super-MD_1.2.3_amd64.deb"),("rpm","Super-MD-1.2.3-1.x86_64.rpm")):
            package=updates.release_info(self.fixture(),'1.2.2','linux','x86_64',linux_kind=kind)
            self.assertEqual(package['name'],name)
            self.assertEqual(updates.installer_kind(package),kind)
        self.assertEqual(updates.installer_kind(updates.release_info(self.fixture(),'1.2.2','win32','AMD64')),'windows')
        self.assertEqual(updates.installer_kind(updates.release_info(self.fixture(),'1.2.2','darwin','x86_64')),'macos')
        self.assertEqual(updates.installer_kind(updates.release_info(self.fixture(),'1.2.2','darwin','arm64')),'macos')
        for value in ('v1.2','1.2.3-beta','https://example.org'):
            with self.assertRaises(ValueError):updates.version(value)
    def test_drafts_prereleases_and_untrusted_urls_never_download(self):
        for flag in ('draft','prerelease'):
            fixture=self.fixture();fixture[flag]=True
            self.assertIsNone(updates.release_info(fixture,'1.0.0','linux','x86_64'))
        for url in ('http://github.com/YashMahawa/super-md/releases/download/v1/x',updates.REPO+'.evil/releases/download/v1/x','https://github.com/attacker/super-md/releases/download/v1/x','https://github.com@evil.test/YashMahawa/super-md/releases/download/v1/x'):
            with self.assertRaises(ValueError):updates.asset_url(url)
    def test_update_failures_are_classified_without_internal_details(self):
        self.assertIn('certificate',updates.check_failure(ssl.SSLCertVerificationError('bad cert')).lower())
        self.assertIn('timed out',updates.check_failure(socket.timeout()).lower())
        self.assertIn('rate-limiting',updates.check_failure(type('HttpFailure',(Exception,),{'code':429})()).lower())
        self.assertIn('could not check',updates.check_failure(OSError('private path /secret')).lower())
    def test_release_requests_use_verified_context_on_the_same_proxy_aware_opener(self):
        opener=Mock();opener.open.return_value='response'
        with patch('updates.urllib.request.build_opener',return_value=opener) as build:
            self.assertEqual(updates.response('https://api.github.com/repos/YashMahawa/super-md/releases/latest'),'response')
        handlers=build.call_args.args
        self.assertTrue(any(isinstance(handler,updates.SafeRedirect) for handler in handlers))
        https=next(handler for handler in handlers if isinstance(handler,updates.urllib.request.HTTPSHandler))
        self.assertTrue(https._context.check_hostname)
        self.assertEqual(https._context.verify_mode,ssl.CERT_REQUIRED)
        opener.open.assert_called_once()
    def test_streamed_download_requires_exact_size_and_hash(self):
        info=updates.release_info(self.fixture(),'1.0.0','linux','x86_64')
        for payload,valid in ((b'good',True),(b'evil',False),(b'too big',False)):
            digest=hashlib.sha256(b'good').hexdigest()
            def stream(url):return io.BytesIO((digest+'  '+info['name']+'\n').encode() if url.endswith('SHA256SUMS') else payload)
            with tempfile.TemporaryDirectory() as directory,patch('updates.response',side_effect=stream):
                if valid:
                    file=Path(updates.download(info,directory));self.assertEqual(file.read_bytes(),b'good')
                else:
                    with self.assertRaises(ValueError):updates.download(info,directory)
                    self.assertEqual(list(Path(directory).iterdir()),[])
    def test_incomplete_release_and_missing_checksum_rejected(self):
        fixture=self.fixture();fixture['assets'].pop()
        with self.assertRaises(ValueError):updates.release_info(fixture,'1.0.0','linux','x86_64')
        with self.assertRaises(ValueError):updates.checksum('0'*64+'  wrong.apk','right.apk')

    def test_downloads_restore_offline_reuse_and_survive_installed_version(self):
        info=updates.release_info(self.fixture(),'1.0.0','linux','x86_64');digest=hashlib.sha256(b'good').hexdigest()
        def stream(url):return io.BytesIO((digest+'  '+info['name']).encode() if url.endswith('SHA256SUMS') else b'good')
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder);downloads=root/'Downloads';state=root/'state'
            with patch('updates.response',side_effect=stream) as network:
                path=Path(updates.download(info,downloads,state));self.assertEqual(network.call_count,2)
            with patch('updates.response',side_effect=AssertionError('No network')):
                self.assertEqual(updates.load_ready(state,'1.0.0')['path'],str(path))
            with patch('updates.response',side_effect=stream) as network:
                self.assertEqual(updates.download(info,downloads,state),str(path));self.assertEqual(network.call_count,1)
            self.assertIsNone(updates.load_ready(state,'1.2.3'));self.assertTrue(path.is_file())
            self.assertFalse((state/'ready.json').exists())

    def test_tamper_and_symlinks_refused_conflicting_files_preserved(self):
        info=updates.release_info(self.fixture(),'1.0.0','linux','x86_64');digest=hashlib.sha256(b'good').hexdigest()
        def stream(url):return io.BytesIO((digest+'  '+info['name']).encode() if url.endswith('SHA256SUMS') else b'good')
        with tempfile.TemporaryDirectory() as folder,patch('updates.response',side_effect=stream):
            root=Path(folder);downloads=root/'Downloads';downloads.mkdir();existing=downloads/info['name'];existing.write_bytes(b'keep')
            path=Path(updates.download(info,downloads,root/'state'));self.assertNotEqual(path,existing);self.assertEqual(existing.read_bytes(),b'keep')
            path.write_bytes(b'evil');self.assertIsNone(updates.load_ready(root/'state','1.0.0'))
            link=root/'linked';link.symlink_to(existing)
            with self.assertRaises(ValueError):updates.verify_file(link,info,digest)

    def test_linux_install_channel_uses_current_image_or_exact_package_owner(self):
        self.assertEqual(updates.linux_install_kind('/usr/bin/super-md',{'APPIMAGE':'/tmp/app.AppImage'},True,'/home/test'),'appimage')
        with tempfile.TemporaryDirectory() as folder:
            executable=Path(folder)/'.local/opt/super-md-qt-1.2.3/super-md'
            self.assertEqual(updates.linux_install_kind(executable,{},True,folder),'appimage')
        with patch('updates.shutil.which',side_effect=lambda name:'/usr/bin/dpkg-query' if name=='dpkg-query' else None),patch('updates.subprocess.run',return_value=subprocess.CompletedProcess([],0,'super-md: /opt/super-md/super-md\n','')) as query:
            self.assertEqual(updates.linux_install_kind('/opt/super-md/super-md',{},True,'/home/test'),'deb')
            self.assertEqual(query.call_args.args[0][:3],['dpkg-query','-S',str(Path('/opt/super-md/super-md').resolve())])
        with patch('updates.shutil.which',side_effect=lambda name:'/usr/bin/rpm' if name=='rpm' else None),patch('updates.subprocess.run',return_value=subprocess.CompletedProcess([],0,'super-md','')):
            self.assertEqual(updates.linux_install_kind('/opt/super-md/super-md',{},True,'/home/test'),'rpm')
        self.assertEqual(updates.linux_install_kind('/source/desktop/.venv/bin/python',{},False,'/home/test'),'appimage')
