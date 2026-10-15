import json
import tempfile
import unittest
import sys
from pathlib import Path
from unittest.mock import patch
import app_integration as integration

@unittest.skipUnless(sys.platform.startswith('linux'),'Portable integration is Linux-specific')
class IntegrationTest(unittest.TestCase):
    def package(self,root,version='1.2.3'):
        package=root/'squashfs-root/usr/lib/super-md'
        resources=package/'_internal/resources';(resources/'desktop').mkdir(parents=True);(resources/'public').mkdir()
        (resources/'desktop/build-info.json').write_text(json.dumps({'version':version}))
        (resources/'public/brand-mark-fixed.svg').write_text('<svg/>');(package/'super-md').write_text('binary')
        return package

    def test_install_switches_launcher_keeps_previous_and_download_without_defaults(self):
        with tempfile.TemporaryDirectory() as folder:
            home=Path(folder);old=home/'.local/opt/super-md-qt-1.2.2';old.mkdir(parents=True);(old/'super-md').write_text('old')
            launcher=home/'.local/bin/super-md';launcher.parent.mkdir();launcher.symlink_to(old/'super-md')
            image=home/'update.AppImage';image.write_text('verified')
            def extract(args,**kwargs):
                if args[1]=='--appimage-extract':self.package(Path(kwargs['cwd']))
            with patch('app_integration.subprocess.run',side_effect=extract),patch('app_integration.shutil.which',return_value=None):
                destination=Path(integration.install_appimage(image,'1.2.3',True,home))
            self.assertEqual(launcher.resolve(),destination/'super-md');self.assertEqual((old/'super-md').read_text(),'old');self.assertTrue(image.exists())
            entry=(home/'.local/share/applications/dev.supermd.studio.desktop').read_text()
            self.assertIn(integration.OWNER,entry);self.assertIn('text/markdown',entry);self.assertFalse((home/'.config/mimeapps.list').exists())

    def test_wrong_package_does_not_change_launcher_and_unrelated_launcher_is_refused(self):
        with tempfile.TemporaryDirectory() as folder:
            home=Path(folder);launcher=home/'.local/bin/super-md';launcher.parent.mkdir(parents=True);launcher.write_text('unrelated')
            def extract(args,**kwargs):self.package(Path(kwargs['cwd']),'9.9.9')
            with patch('app_integration.subprocess.run',side_effect=extract):
                with self.assertRaises(ValueError):integration.install_appimage(home/'update','1.2.3',False,home)
            self.assertEqual(launcher.read_text(),'unrelated')
            with self.assertRaises(ValueError):integration._link(home/'new',launcher)
            self.assertEqual(launcher.read_text(),'unrelated')

    def test_existing_version_not_overwritten_and_registration_off_creates_no_entry(self):
        with tempfile.TemporaryDirectory() as folder:
            home=Path(folder);old=home/'.local/opt/super-md-qt-1.2.3';old.mkdir(parents=True);(old/'super-md').write_text('previous')
            with patch('app_integration.subprocess.run',side_effect=lambda args,**kw:self.package(Path(kw['cwd']))):
                destination=Path(integration.install_appimage(home/'image','1.2.3',False,home))
            self.assertNotEqual(destination,old);self.assertEqual((old/'super-md').read_text(),'previous')
            self.assertFalse((home/'.local/share/applications').exists())

    def test_desktop_exec_escapes_spaces_and_field_codes(self):
        self.assertEqual(integration._exec_path(Path('/home/a b%/app')), '"/home/a b%%/app"')
