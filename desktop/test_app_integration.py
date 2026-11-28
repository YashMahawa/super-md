import json
import os
import stat
import subprocess
import sys
import tempfile
import unittest
from contextlib import ExitStack
from pathlib import Path
from unittest.mock import patch

if __package__:
    from .core import app_integration as integration
else:
    from core import app_integration as integration


class _SubprocessSpy:
    def __init__(self, *, forbidden_executables=()):
        self.calls = []
        self.popen_calls = []
        self._forbidden = {str(Path(p)) for p in forbidden_executables} | {
            str(Path(p).resolve()) for p in forbidden_executables
        }

    def run(self, args, **kwargs):
        argv = tuple(str(part) for part in args)
        self.calls.append((argv, dict(kwargs)))
        if argv and (argv[0] in self._forbidden or '--appimage-extract' in argv):
            raise AssertionError(f'Unexpected installer subprocess execution: {argv!r}')
        return subprocess.CompletedProcess(args, 0, '', '')

    def popen(self, args, **kwargs):
        argv = tuple(str(part) for part in args) if isinstance(args, (list, tuple)) else (str(args),)
        self.popen_calls.append((argv, dict(kwargs)))
        raise AssertionError(f'Unexpected Popen invocation during desktop integration: {argv!r}')


def _make_tree_writable(root: Path) -> None:
    if not root.exists() and not root.is_symlink():
        return
    if not root.is_symlink():
        os.chmod(root, stat.S_IMODE(root.lstat().st_mode) | 0o700)
    for current, dirnames, filenames in os.walk(root, topdown=True, followlinks=False):
        current_path = Path(current)
        for name in dirnames:
            subdir = current_path / name
            if not subdir.is_symlink():
                os.chmod(subdir, stat.S_IMODE(subdir.lstat().st_mode) | 0o700)
        for name in filenames:
            entry = current_path / name
            if not entry.is_symlink():
                os.chmod(entry, stat.S_IMODE(entry.lstat().st_mode) | 0o600)


@unittest.skipUnless(sys.platform.startswith('linux'),'Portable integration is Linux-specific')
class IntegrationTest(unittest.TestCase):
    def package(self,root,version='1.2.3',*,binary_text='binary',relative_dir='squashfs-root/usr/lib/super-md'):
        package=root/relative_dir if relative_dir else root
        resources=package/'_internal/resources';(resources/'desktop').mkdir(parents=True,exist_ok=True);(resources/'public').mkdir(exist_ok=True)
        (resources/'desktop/build-info.json').write_text(json.dumps({'version':version}),encoding='utf-8')
        (resources/'public/brand-mark-fixed.svg').write_text('<svg/>',encoding='utf-8')
        (package/'super-md').write_text(binary_text,encoding='utf-8')
        return package

    def spy_subprocesses(self, *, which_map=None, forbidden_executables=()):
        spy = _SubprocessSpy(forbidden_executables=forbidden_executables)
        lookup = dict(which_map or {})
        stack = ExitStack()
        stack.enter_context(patch.object(integration.subprocess, 'run', side_effect=spy.run))
        stack.enter_context(patch.object(integration.subprocess, 'Popen', side_effect=spy.popen))
        stack.enter_context(patch.object(integration.shutil, 'which', side_effect=lambda cmd: lookup.get(cmd)))
        return stack, spy

    def test_install_switches_launcher_keeps_previous_and_download_without_defaults(self):
        with tempfile.TemporaryDirectory() as folder:
            home=Path(folder);old=home/'.local/opt/super-md-qt-1.2.2';old.mkdir(parents=True);(old/'super-md').write_text('old')
            launcher=home/'.local/bin/super-md';launcher.parent.mkdir();launcher.symlink_to(old/'super-md')
            image=home/'update.AppImage';image.write_text('verified')
            def extract(args,**kwargs):
                if args[1]=='--appimage-extract':self.package(Path(kwargs['cwd']))
            with patch.object(integration.subprocess,'run',side_effect=extract),patch.object(integration.shutil,'which',return_value=None):
                destination=Path(integration.install_appimage(image,'1.2.3',True,home))
            self.assertEqual(launcher.resolve(),destination/'super-md');self.assertEqual((old/'super-md').read_text(),'old');self.assertTrue(image.exists())
            entry=(home/'.local/share/applications/dev.supermd.studio.desktop').read_text()
            self.assertIn(integration.OWNER,entry);self.assertIn('text/markdown',entry);self.assertFalse((home/'.config/mimeapps.list').exists())

    def test_wrong_package_does_not_change_launcher_and_unrelated_launcher_is_refused(self):
        with tempfile.TemporaryDirectory() as folder:
            home=Path(folder);launcher=home/'.local/bin/super-md';launcher.parent.mkdir(parents=True);launcher.write_text('unrelated')
            def extract(args,**kwargs):self.package(Path(kwargs['cwd']),'9.9.9')
            with patch.object(integration.subprocess,'run',side_effect=extract),self.assertRaises(ValueError):
                integration.install_appimage(home/'update','1.2.3',False,home)
            self.assertEqual(launcher.read_text(),'unrelated')
            with self.assertRaises(ValueError):integration._link(home/'new',launcher)
            self.assertEqual(launcher.read_text(),'unrelated')

    def test_existing_version_not_overwritten_and_registration_off_creates_no_entry(self):
        with tempfile.TemporaryDirectory() as folder:
            home=Path(folder);old=home/'.local/opt/super-md-qt-1.2.3';old.mkdir(parents=True);(old/'super-md').write_text('previous')
            with patch.object(integration.subprocess,'run',side_effect=lambda args,**kw:self.package(Path(kw['cwd']))):
                destination=Path(integration.install_appimage(home/'image','1.2.3',False,home))
            self.assertNotEqual(destination,old);self.assertEqual((old/'super-md').read_text(),'previous')
            self.assertFalse((home/'.local/share/applications').exists())

    def test_desktop_exec_escapes_spaces_and_field_codes(self):
        self.assertEqual(integration._exec_path(Path('/home/a b%/app')), '"/home/a b%%/app"')

    def test_symlinked_home_keeps_owned_launcher_recognizable(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);real=root/'storage';real.mkdir();home=root/'home';home.symlink_to(real,target_is_directory=True)
            previous=real/'.local/opt/super-md-qt-1.2.2';previous.mkdir(parents=True);(previous/'super-md').write_text('old')
            launcher=home/'.local/bin/super-md';launcher.parent.mkdir();launcher.symlink_to(previous/'super-md')
            with patch.object(integration.subprocess,'run',side_effect=lambda args,**kw:self.package(Path(kw['cwd']))):
                destination=Path(integration.install_appimage(home/'image','1.2.3',False,home))
            self.assertEqual(launcher.resolve(),destination/'super-md');self.assertEqual((previous/'super-md').read_text(),'old')

    def test_integrate_current_copies_validated_readonly_running_bundle_without_executing_env_installer(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            home = root / 'home'
            home.mkdir()
            mount = root / 'mounted-appdir'
            self.addCleanup(_make_tree_writable, mount)
            running_pkg = self.package(mount, '1.2.3', binary_text='mounted-1.2.3', relative_dir='usr/lib/super-md')
            helper = running_pkg / '_internal/resources/desktop/smd-engine'
            helper.write_text('engine-binary', encoding='utf-8')
            helper.chmod(0o555)
            lib_real = running_pkg / '_internal/libQt6Core.so.6.8.0'
            lib_real.write_text('shared-lib', encoding='utf-8')
            lib_link = running_pkg / '_internal/libQt6Core.so.6'
            lib_link.symlink_to('libQt6Core.so.6.8.0')
            (running_pkg / 'super-md').chmod(0o555)
            (running_pkg / '_internal/resources/desktop/build-info.json').chmod(0o444)
            (running_pkg / '_internal/resources/public/brand-mark-fixed.svg').chmod(0o666)
            for path in sorted(running_pkg.rglob('*'), key=lambda p: len(p.parts), reverse=True):
                if path.is_dir() and not path.is_symlink():
                    path.chmod(0o555)
            running_pkg.chmod(0o555)

            decoy_installer = root / 'env-injected-installer.AppImage'
            decoy_installer.write_text('#!/bin/sh\nexit 99\n', encoding='utf-8')
            decoy_installer.chmod(0o755)

            which_tools = {
                'update-mime-database': '/usr/bin/update-mime-database',
                'update-desktop-database': '/usr/bin/update-desktop-database',
            }
            stack, spy = self.spy_subprocesses(which_map=which_tools, forbidden_executables=[decoy_installer])
            with (
                stack,
                patch.dict(os.environ, {'APPIMAGE': str(decoy_installer), 'APPDIR': str(root / 'unrelated-mount')}, clear=False),
            ):
                self.assertTrue(integration.available(running_pkg / 'super-md', home, frozen=True, platform='linux'))
                installed = Path(
                    integration.integrate_current(
                        '1.2.3',
                        executable=running_pkg / 'super-md',
                        home=home,
                        frozen=True,
                        platform='linux',
                    )
                )

            self.assertEqual(installed, (home / '.local/opt/super-md-qt-1.2.3').resolve())
            self.assertEqual((installed / 'super-md').read_text(encoding='utf-8'), 'mounted-1.2.3')
            self.assertTrue((installed / '_internal/libQt6Core.so.6').is_symlink())
            self.assertEqual(os.readlink(installed / '_internal/libQt6Core.so.6'), 'libQt6Core.so.6.8.0')
            self.assertEqual((home / '.local/bin/super-md').resolve(), installed / 'super-md')
            self.assertEqual(spy.popen_calls, [])
            self.assertEqual(
                [argv for argv, _ in spy.calls],
                [
                    ('update-mime-database', str(home / '.local/share/mime')),
                    ('update-desktop-database', str(home / '.local/share/applications')),
                ],
            )

            uid = os.geteuid()
            for current, dirnames, filenames in os.walk(installed, followlinks=False):
                current_path = Path(current)
                dir_stat = current_path.lstat()
                self.assertEqual(dir_stat.st_uid, uid)
                dir_mode = stat.S_IMODE(dir_stat.st_mode)
                self.assertEqual(dir_mode & 0o700, 0o700)
                self.assertEqual(dir_mode & 0o7022, 0)
                for filename in filenames:
                    entry = current_path / filename
                    entry_stat = entry.lstat()
                    self.assertEqual(entry_stat.st_uid, uid)
                    if entry.is_symlink():
                        continue
                    mode = stat.S_IMODE(entry_stat.st_mode)
                    self.assertEqual(mode & 0o7022, 0)
                    if entry.name in ('super-md', 'smd-engine'):
                        self.assertEqual(mode & 0o700, 0o700)
                    else:
                        self.assertEqual(mode & 0o600, 0o600)
                        self.assertEqual(mode & 0o111, 0)

            for xdg_file in (
                home / '.local/share/applications/dev.supermd.studio.desktop',
                home / '.local/share/icons/hicolor/scalable/apps/super-md.svg',
                home / '.local/share/mime/packages/supermd.xml',
            ):
                xdg_mode = stat.S_IMODE(xdg_file.lstat().st_mode)
                self.assertEqual(xdg_mode & 0o600, 0o600)
                self.assertEqual(xdg_mode & 0o7133, 0)

    def test_integrate_current_registers_existing_user_local_installation_in_place_ignoring_env_appimage(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            home = root / 'home'
            older = self.package(home / '.local/opt/super-md-qt-1.2.2', '1.2.2', binary_text='keep-1.2.2', relative_dir='')
            current = self.package(home / '.local/opt/super-md-qt-1.2.3', '1.2.3', binary_text='local-1.2.3', relative_dir='')
            helper = current / '_internal/resources/desktop/smd-engine'
            helper.write_text('engine-1.2.3', encoding='utf-8')
            (current / 'super-md').chmod(0o755)
            helper.chmod(0o750)
            launcher = home / '.local/bin/super-md'
            launcher.parent.mkdir(parents=True)
            launcher.symlink_to(older / 'super-md')
            decoy = root / 'poisoned.AppImage'
            decoy.write_text('never-run', encoding='utf-8')

            stack, spy = self.spy_subprocesses(forbidden_executables=[decoy])
            with stack, patch.dict(os.environ, {'APPIMAGE': str(decoy)}, clear=False):
                self.assertTrue(integration.available(launcher, home, frozen=True, platform='linux'))
                with self.assertRaises(ValueError):
                    integration.integrate_current('1.2.3', executable=launcher, home=home, frozen=True, platform='linux')
                self.assertEqual(launcher.resolve(), (older / 'super-md').resolve())

                result = Path(
                    integration.integrate_current(
                        '1.2.3',
                        executable=current / 'super-md',
                        home=home,
                        frozen=True,
                        platform='linux',
                    )
                )

            self.assertEqual(result, current.resolve())
            self.assertEqual(sorted(p.name for p in (home / '.local/opt').iterdir()), ['super-md-qt-1.2.2', 'super-md-qt-1.2.3'])
            self.assertEqual(launcher.resolve(), (current / 'super-md').resolve())
            self.assertEqual((older / 'super-md').read_text(encoding='utf-8'), 'keep-1.2.2')
            self.assertEqual(stat.S_IMODE((current / 'super-md').stat().st_mode), 0o755)
            self.assertEqual(stat.S_IMODE(helper.stat().st_mode), 0o750)
            self.assertEqual(spy.calls, [])
            self.assertEqual(spy.popen_calls, [])

    def test_integrate_current_preserves_side_by_side_versions_and_launcher_rollback_target(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            home = root / 'home'
            v122 = self.package(home / '.local/opt/super-md-qt-1.2.2', '1.2.2', binary_text='v1.2.2', relative_dir='')
            v123_existing = self.package(home / '.local/opt/super-md-qt-1.2.3', '1.2.3', binary_text='existing-v1.2.3', relative_dir='')
            launcher = home / '.local/bin/super-md'
            launcher.parent.mkdir(parents=True)
            launcher.symlink_to(v122 / 'super-md')

            running = self.package(root / 'bundle', '1.2.3', binary_text='running-v1.2.3', relative_dir='usr/lib/super-md')
            stack, spy = self.spy_subprocesses()
            with stack:
                installed = Path(
                    integration.integrate_current(
                        '1.2.3',
                        executable=running / 'super-md',
                        home=home,
                        frozen=True,
                        platform='linux',
                    )
                )

            self.assertNotEqual(installed, v123_existing.resolve())
            self.assertTrue(installed.name.startswith('super-md-qt-1.2.3-'))
            self.assertEqual((installed / 'super-md').read_text(encoding='utf-8'), 'running-v1.2.3')
            self.assertEqual((v123_existing / 'super-md').read_text(encoding='utf-8'), 'existing-v1.2.3')
            self.assertEqual((v122 / 'super-md').read_text(encoding='utf-8'), 'v1.2.2')
            self.assertEqual(launcher.resolve(), installed / 'super-md')
            self.assertEqual(spy.calls, [])

    def test_integrate_current_rolls_back_on_copy_or_registration_failure_preserving_previous_launcher(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            home = root / 'home'
            previous = self.package(home / '.local/opt/super-md-qt-1.2.2', '1.2.2', binary_text='stable-1.2.2', relative_dir='')
            integration.register(previous, home)
            launcher = home / '.local/bin/super-md'
            desktop = home / '.local/share/applications/dev.supermd.studio.desktop'
            prior_desktop_bytes = desktop.read_bytes()

            mount = root / 'readonly-mount'
            self.addCleanup(_make_tree_writable, mount)
            running = self.package(mount, '1.2.3', binary_text='candidate-1.2.3', relative_dir='usr/lib/super-md')
            for sub in sorted(running.rglob('*'), key=lambda p: len(p.parts), reverse=True):
                if sub.is_dir():
                    sub.chmod(0o555)
            running.chmod(0o555)

            real_copytree = integration.shutil.copytree

            def failing_mid_copy(src, dst, **kwargs):
                dst_path = Path(dst)
                (dst_path / '_internal').mkdir(parents=True)
                (dst_path / '_internal/partial').write_text('partial', encoding='utf-8')
                (dst_path / '_internal').chmod(0o555)
                dst_path.chmod(0o555)
                raise OSError('simulated copytree failure')

            stack, spy = self.spy_subprocesses()
            with stack, patch.object(integration.shutil, 'copytree', side_effect=failing_mid_copy):
                with self.assertRaisesRegex(OSError, 'simulated copytree failure'):
                    integration.integrate_current('1.2.3', executable=running / 'super-md', home=home, frozen=True, platform='linux')

            self.assertEqual([p.name for p in (home / '.local/opt').iterdir()], ['super-md-qt-1.2.2'])
            self.assertEqual(launcher.resolve(), (previous / 'super-md').resolve())
            self.assertEqual(desktop.read_bytes(), prior_desktop_bytes)
            self.assertEqual(spy.calls, [])

            stack2, spy2 = self.spy_subprocesses()
            with (
                stack2,
                patch.object(integration.shutil, 'copytree', wraps=real_copytree),
                patch.object(integration, '_link', side_effect=OSError('simulated launcher replace failure')),
            ):
                with self.assertRaisesRegex(OSError, 'simulated launcher replace failure'):
                    integration.integrate_current('1.2.3', executable=running / 'super-md', home=home, frozen=True, platform='linux')

            self.assertEqual([p.name for p in (home / '.local/opt').iterdir()], ['super-md-qt-1.2.2'])
            self.assertEqual(launcher.resolve(), (previous / 'super-md').resolve())
            self.assertEqual(desktop.read_bytes(), prior_desktop_bytes)
            self.assertEqual(spy2.calls, [])

    def test_environment_metadata_cannot_enable_system_source_nonlinux_or_invalid_bundles(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            home = root / 'home'
            home.mkdir()
            decoy = root / 'evil.AppImage'
            decoy.write_text('#!/bin/sh\nexit 1\n', encoding='utf-8')
            valid_bundle = self.package(root / 'valid', '1.2.3', relative_dir='usr/lib/super-md')

            stack, spy = self.spy_subprocesses(forbidden_executables=[decoy])
            with stack, patch.dict(os.environ, {'APPIMAGE': str(decoy), 'APPDIR': '/opt'}, clear=False):
                self.assertFalse(integration.available('/opt/super-md/super-md', home, frozen=True, platform='linux'))
                self.assertFalse(integration.available(valid_bundle / 'super-md', home, frozen=False, platform='linux'))
                self.assertFalse(integration.available(valid_bundle / 'super-md', home, frozen=True, platform='darwin'))
                for kwargs in (
                    {'executable': '/opt/super-md/super-md', 'frozen': True, 'platform': 'linux'},
                    {'executable': valid_bundle / 'super-md', 'frozen': False, 'platform': 'linux'},
                    {'executable': valid_bundle / 'super-md', 'frozen': True, 'platform': 'darwin'},
                ):
                    with self.assertRaises(ValueError):
                        integration.integrate_current('1.2.3', home=home, **kwargs)

                missing_icon_bundle = self.package(root / 'missing-icon', '1.2.3', relative_dir='usr/lib/super-md')
                (missing_icon_bundle / '_internal/resources/public/brand-mark-fixed.svg').unlink()
                self.assertFalse(integration.available(missing_icon_bundle / 'super-md', home, frozen=True, platform='linux'))

                bad_symlink_bundle = self.package(root / 'bad-link', '1.2.3', relative_dir='usr/lib/super-md')
                (bad_symlink_bundle / '_internal/escape').symlink_to(root / 'outside-secret')
                with patch.object(integration.os, 'walk', side_effect=AssertionError('available() must not call os.walk')):
                    self.assertTrue(integration.available(bad_symlink_bundle / 'super-md', home, frozen=True, platform='linux'))
                with self.assertRaisesRegex(ValueError, 'external symlink'):
                    integration.integrate_current('1.2.3', executable=bad_symlink_bundle / 'super-md', home=home, frozen=True, platform='linux')

                unmanaged_desktop = home / '.local/share/applications/dev.supermd.studio.desktop'
                unmanaged_desktop.parent.mkdir(parents=True)
                unmanaged_desktop.write_text('[Desktop Entry]\nName=Other App\nExec=/usr/bin/other\n', encoding='utf-8')
                with self.assertRaises(ValueError):
                    integration.integrate_current('1.2.3', executable=valid_bundle / 'super-md', home=home, frozen=True, platform='linux')
                self.assertFalse((home / '.local/opt').exists())
                self.assertEqual(spy.calls, [])
                self.assertEqual(spy.popen_calls, [])

    def test_default_runtime_resolution_and_non_owner_installation_refusal(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            home = root / 'home'
            home.mkdir()
            running = self.package(root / 'appdir', '1.2.3', binary_text='runtime-default', relative_dir='usr/lib/super-md')
            decoy = root / 'env.AppImage'
            decoy.write_text('unused', encoding='utf-8')

            stack, spy = self.spy_subprocesses(forbidden_executables=[decoy])
            with (
                stack,
                patch.dict(os.environ, {'APPIMAGE': str(decoy)}, clear=False),
                patch.object(integration.sys, 'executable', str(running / 'super-md')),
                patch.object(integration.sys, 'frozen', True, create=True),
                patch.object(integration.sys, 'platform', 'linux'),
                patch.object(integration.Path, 'home', return_value=home),
            ):
                self.assertTrue(integration.available())
                installed = Path(integration.integrate_current('1.2.3'))
                self.assertEqual(installed, (home / '.local/opt/super-md-qt-1.2.3').resolve())
                self.assertEqual((home / '.local/bin/super-md').resolve(), installed / 'super-md')

                with patch.object(integration.sys, 'executable', str(installed / 'super-md')), patch.object(
                    integration, '_current_uid', return_value=os.geteuid() + 1
                ):
                    self.assertFalse(integration.available())
                    with self.assertRaisesRegex(ValueError, 'not owned by the current user'):
                        integration.integrate_current('1.2.3')
            self.assertEqual(spy.calls, [])
            self.assertEqual(spy.popen_calls, [])

    def test_user_local_registration_failure_preserves_prior_launcher_registration_and_file_modes(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            home = root / 'home'
            older = self.package(home / '.local/opt/super-md-qt-1.2.2', '1.2.2', binary_text='#!/bin/sh\necho 1.2.2\n', relative_dir='')
            (older / 'super-md').chmod(0o755)
            (older / '_internal/resources/public/brand-mark-fixed.svg').write_text('<svg id="v1.2.2"/>', encoding='utf-8')
            with patch.object(integration.shutil, 'which', return_value=None):
                integration.register(older, home)

            launcher = home / '.local/bin/super-md'
            xdg_paths = (
                home / '.local/share/applications/dev.supermd.studio.desktop',
                home / '.local/share/icons/hicolor/scalable/apps/super-md.svg',
                home / '.local/share/mime/packages/supermd.xml',
            )
            xdg_paths[0].chmod(0o640)
            xdg_paths[1].chmod(0o644)
            xdg_paths[2].chmod(0o600)
            prior_xdg = {p: (p.read_bytes(), stat.S_IMODE(p.lstat().st_mode)) for p in xdg_paths}

            current = self.package(home / '.local/opt/super-md-qt-1.2.3', '1.2.3', binary_text='#!/bin/sh\necho ok-1.2.3\n', relative_dir='')
            (current / '_internal/resources/public/brand-mark-fixed.svg').write_text('<svg id="v1.2.3"/>', encoding='utf-8')
            helper = current / '_internal/resources/desktop/smd-engine'
            helper.write_text('#!/bin/sh\necho engine\n', encoding='utf-8')
            lib_real = current / '_internal/libQt6Core.so.6.8.0'
            lib_real.write_text('elf-shared-lib', encoding='utf-8')
            lib_link = current / '_internal/libQt6Core.so.6'
            lib_link.symlink_to('libQt6Core.so.6.8.0')
            current.chmod(0o755)
            (current / '_internal').chmod(0o755)
            (current / '_internal/resources').chmod(0o750)
            (current / 'super-md').chmod(0o755)
            helper.chmod(0o750)
            lib_real.chmod(0o755)
            (current / '_internal/resources/desktop/build-info.json').chmod(0o644)
            (current / '_internal/resources/public/brand-mark-fixed.svg').chmod(0o640)

            def snapshot_modes(pkg: Path) -> dict[Path, int]:
                modes = {pkg: stat.S_IMODE(pkg.lstat().st_mode)}
                for cur, dirs, files in os.walk(pkg, followlinks=False):
                    cur_path = Path(cur)
                    modes[cur_path] = stat.S_IMODE(cur_path.lstat().st_mode)
                    for name in (*dirs, *files):
                        entry = cur_path / name
                        if not entry.is_symlink():
                            modes[entry] = stat.S_IMODE(entry.lstat().st_mode)
                return modes

            expected_modes = snapshot_modes(current)
            stack, spy = self.spy_subprocesses(which_map={'update-desktop-database': '/usr/bin/update-desktop-database'})
            with stack, patch.object(integration, '_link', side_effect=OSError('simulated launcher replace failure')):
                with self.assertRaisesRegex(OSError, 'simulated launcher replace failure'):
                    integration.integrate_current('1.2.3', executable=current / 'super-md', home=home, frozen=True, platform='linux')

            self.assertEqual(launcher.resolve(), (older / 'super-md').resolve())
            self.assertEqual({p: (p.read_bytes(), stat.S_IMODE(p.lstat().st_mode)) for p in xdg_paths}, prior_xdg)
            self.assertEqual(snapshot_modes(current), expected_modes)
            self.assertEqual(os.readlink(lib_link), 'libQt6Core.so.6.8.0')
            self.assertEqual(subprocess.check_output([str(current / 'super-md')], text=True).strip(), 'ok-1.2.3')
            self.assertEqual(spy.calls, [])

            xdg_paths[0].write_text('[Desktop Entry]\nName=Custom Unmanaged\nExec=/usr/bin/other\n', encoding='utf-8')
            unmanaged_bytes = xdg_paths[0].read_bytes()
            stack2, spy2 = self.spy_subprocesses()
            with stack2:
                with self.assertRaisesRegex(ValueError, 'not managed by Super MD'):
                    integration.integrate_current('1.2.3', executable=current / 'super-md', home=home, frozen=True, platform='linux')
            self.assertEqual(launcher.resolve(), (older / 'super-md').resolve())
            self.assertEqual(xdg_paths[0].read_bytes(), unmanaged_bytes)
            self.assertEqual(snapshot_modes(current), expected_modes)
            self.assertEqual(spy2.calls, [])

    def test_available_skips_package_walk_while_integration_rejects_bad_symlinks_and_preserves_rollback(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            home = root / 'home'
            previous = self.package(home / '.local/opt/super-md-qt-1.2.2', '1.2.2', binary_text='stable-1.2.2', relative_dir='')
            (previous / '_internal/resources/public/brand-mark-fixed.svg').write_text('<svg id="stable"/>', encoding='utf-8')
            with patch.object(integration.shutil, 'which', return_value=None):
                integration.register(previous, home)

            launcher = home / '.local/bin/super-md'
            xdg_paths = (
                home / '.local/share/applications/dev.supermd.studio.desktop',
                home / '.local/share/icons/hicolor/scalable/apps/super-md.svg',
                home / '.local/share/mime/packages/supermd.xml',
            )
            xdg_paths[0].chmod(0o640)
            prior_xdg = {p: (p.read_bytes(), stat.S_IMODE(p.lstat().st_mode)) for p in xdg_paths}

            portable_bad_abs = self.package(root / 'portable-abs', '1.2.3', binary_text='abs-link', relative_dir='usr/lib/super-md')
            (portable_bad_abs / '_internal/abs-escape').symlink_to(root / 'outside-secret')

            portable_bad_rel = self.package(root / 'portable-rel', '1.2.3', binary_text='rel-link', relative_dir='usr/lib/super-md')
            (portable_bad_rel / '_internal/rel-escape').symlink_to('../../../../outside-secret')

            local_bad = self.package(home / '.local/opt/super-md-qt-1.2.3', '1.2.3', binary_text='local-bad', relative_dir='')
            (local_bad / '_internal/local-escape').symlink_to('../../outside-secret')

            broken_meta = self.package(root / 'broken-meta', '1.2.3', relative_dir='usr/lib/super-md')
            (broken_meta / '_internal/resources/desktop/build-info.json').write_text('{invalid', encoding='utf-8')

            with patch.object(integration.os, 'walk', side_effect=AssertionError('availability probe must not call os.walk')):
                self.assertTrue(integration.available(previous / 'super-md', home, frozen=True, platform='linux'))
                self.assertTrue(integration.available(portable_bad_abs / 'super-md', home, frozen=True, platform='linux'))
                self.assertTrue(integration.available(local_bad / 'super-md', home, frozen=True, platform='linux'))
                self.assertFalse(integration.available(broken_meta / 'super-md', home, frozen=True, platform='linux'))
                with patch.object(integration, '_current_uid', return_value=os.geteuid() + 1):
                    self.assertFalse(integration.available(previous / 'super-md', home, frozen=True, platform='linux'))

            stack, spy = self.spy_subprocesses(which_map={'update-desktop-database': '/usr/bin/update-desktop-database'})
            with stack:
                for candidate in (portable_bad_abs, portable_bad_rel, local_bad):
                    with self.assertRaisesRegex(ValueError, 'external symlink'):
                        integration.integrate_current('1.2.3', executable=candidate / 'super-md', home=home, frozen=True, platform='linux')
                    self.assertEqual(launcher.resolve(), (previous / 'super-md').resolve())
                    self.assertEqual({p: (p.read_bytes(), stat.S_IMODE(p.lstat().st_mode)) for p in xdg_paths}, prior_xdg)
                    self.assertEqual(
                        sorted(p.name for p in (home / '.local/opt').iterdir()),
                        ['super-md-qt-1.2.2', 'super-md-qt-1.2.3'],
                    )
                with self.assertRaisesRegex(ValueError, 'external symlink'):
                    integration.register(local_bad, home)
                self.assertEqual(launcher.resolve(), (previous / 'super-md').resolve())
                self.assertEqual({p: (p.read_bytes(), stat.S_IMODE(p.lstat().st_mode)) for p in xdg_paths}, prior_xdg)

                local_foreign = self.package(home / '.local/opt/super-md-qt-1.2.4', '1.2.4', binary_text='local-foreign', relative_dir='')
                nested_foreign = (local_foreign / '_internal/libForeign.so').resolve()
                nested_foreign.write_text('foreign-lib', encoding='utf-8')
                real_lstat = Path.lstat

                def fake_lstat(path_obj, *args, **kwargs):
                    st = real_lstat(path_obj, *args, **kwargs)
                    if path_obj == nested_foreign:
                        return os.stat_result((
                            st.st_mode, st.st_ino, st.st_dev, st.st_nlink,
                            st.st_uid + 1, st.st_gid, st.st_size,
                            st.st_atime, st.st_mtime, st.st_ctime,
                        ))
                    return st

                with patch.object(Path, 'lstat', fake_lstat):
                    with patch.object(integration.os, 'walk', side_effect=AssertionError('availability probe must not call os.walk')):
                        self.assertTrue(integration.available(local_foreign / 'super-md', home, frozen=True, platform='linux'))
                    with self.assertRaisesRegex(ValueError, 'not owned by the current user'):
                        integration.integrate_current('1.2.4', executable=local_foreign / 'super-md', home=home, frozen=True, platform='linux')
                    with self.assertRaisesRegex(ValueError, 'not owned by the current user'):
                        integration.register(local_foreign, home)
                shutil_rmtree = integration.shutil.rmtree
                shutil_rmtree(local_foreign)
                self.assertEqual(launcher.resolve(), (previous / 'super-md').resolve())
                self.assertEqual({p: (p.read_bytes(), stat.S_IMODE(p.lstat().st_mode)) for p in xdg_paths}, prior_xdg)

                clean_portable = self.package(root / 'clean-portable', '1.2.4', binary_text='clean-1.2.4', relative_dir='usr/lib/super-md')
                real_copytree = integration.shutil.copytree

                def inject_staged_bad_symlink(src, dst, *args, **kwargs):
                    result = real_copytree(src, dst, *args, **kwargs)
                    if Path(src) == clean_portable:
                        (Path(dst) / '_internal/staged-escape').symlink_to(root / 'outside-secret')
                    return result

                with patch.object(integration.shutil, 'copytree', side_effect=inject_staged_bad_symlink):
                    with self.assertRaisesRegex(ValueError, 'external symlink'):
                        integration.integrate_current('1.2.4', executable=clean_portable / 'super-md', home=home, frozen=True, platform='linux')
                self.assertEqual(launcher.resolve(), (previous / 'super-md').resolve())
                self.assertEqual({p: (p.read_bytes(), stat.S_IMODE(p.lstat().st_mode)) for p in xdg_paths}, prior_xdg)
                self.assertEqual(
                    sorted(p.name for p in (home / '.local/opt').iterdir()),
                    ['super-md-qt-1.2.2', 'super-md-qt-1.2.3'],
                )
                self.assertEqual(spy.calls, [])
                self.assertEqual(spy.popen_calls, [])
