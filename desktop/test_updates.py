import hashlib
import io
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
import updates

class UpdateTest(unittest.TestCase):
    def fixture(self):
        name='Super-MD_1.2.3_amd64.AppImage'
        return {'tag_name':'v1.2.3','draft':False,'prerelease':False,'assets':[
            {'name':name,'size':4,'browser_download_url':updates.REPO+'/releases/download/v1.2.3/'+name},
            {'name':'SHA256SUMS','size':100,'browser_download_url':updates.REPO+'/releases/download/v1.2.3/SHA256SUMS'}]}
    def test_stable_versions_and_platform_asset(self):
        self.assertGreater(updates.version('0.10.0'),updates.version('0.9.99'))
        self.assertIsNone(updates.release_info(self.fixture(),'1.2.3','linux','x86_64'))
        info=updates.release_info(self.fixture(),'1.2.2','linux','x86_64')
        self.assertEqual(info['name'],'Super-MD_1.2.3_amd64.AppImage')
        for value in ('v1.2','1.2.3-beta','https://example.org'):
            with self.assertRaises(ValueError):updates.version(value)
    def test_drafts_prereleases_and_untrusted_urls_never_download(self):
        for flag in ('draft','prerelease'):
            fixture=self.fixture();fixture[flag]=True
            self.assertIsNone(updates.release_info(fixture,'1.0.0','linux','x86_64'))
        for url in ('http://github.com/YashMahawa/super-md/releases/download/v1/x',updates.REPO+'.evil/releases/download/v1/x','https://github.com/attacker/super-md/releases/download/v1/x','https://github.com@evil.test/YashMahawa/super-md/releases/download/v1/x'):
            with self.assertRaises(ValueError):updates.asset_url(url)
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
