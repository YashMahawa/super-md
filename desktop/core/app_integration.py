"""Opt-in, per-user portable installation; never overwrite system packages.

The old installation and running process remain intact. Activation is an atomic
launcher change, not a second app competing with the current instance broker.
"""
import json
import os
import re
import shutil
import stat
import subprocess
import sys
import tempfile
import uuid
from pathlib import Path
from .updates import version

if __package__ and "." in __package__:
    from ..documents import atomic_write
else:
    from documents import atomic_write

OWNER='X-SuperMD-Managed=true'
_MIME_XML=(
    b'<?xml version="1.0"?>'
    b'<mime-info xmlns="http://www.freedesktop.org/standards/shared-mime-info">'
    b'<mime-type type="application/vnd.supermd.smd"><comment>Portable Super MD note</comment><glob pattern="*.smd" weight="80"/><icon name="super-md"/></mime-type>'
    b'<mime-type type="application/vnd.supermd.fmd"><comment>Legacy Super MD note</comment><glob pattern="*.fmd" weight="80"/><icon name="super-md"/></mime-type>'
    b'</mime-info>'
)
_SYSTEM_PREFIXES=(
    Path('/opt'),
    Path('/usr'),
    Path('/bin'),
    Path('/sbin'),
    Path('/lib'),
    Path('/lib64'),
    Path('/snap'),
    Path('/etc'),
    Path('/var/lib'),
    Path('/var/opt'),
)

def _current_uid():
    return os.geteuid() if hasattr(os,'geteuid') else None

def _require_user_owned(path, message):
    uid=_current_uid()
    if uid is not None and path.lstat().st_uid!=uid:
        raise ValueError(message)

def _is_user_local_package(package, opt):
    return package.parent==opt and package.name.startswith('super-md-qt-')

def _is_system_package(package):
    for prefix in _SYSTEM_PREFIXES:
        if package.is_relative_to(prefix):
            return True
        try:
            resolved=prefix.resolve()
        except OSError:
            continue
        if package.is_relative_to(resolved):
            return True
    return False

def _validate_package(package, expected_version=None, *, require_user_owner=False):
    if expected_version is not None:
        version(expected_version)
    if package.is_symlink() or not package.is_dir():
        raise ValueError('Running package identity mismatch')
    resolved=package.resolve()
    if require_user_owner:
        _require_user_owned(resolved,'Existing installation is not owned by the current user')
    binary=resolved/'super-md'
    if binary.is_symlink() or not binary.is_file() or binary.resolve().parent!=resolved:
        raise ValueError('Extracted package identity mismatch')
    metadata_file=resolved/'_internal/resources/desktop/build-info.json'
    if metadata_file.is_symlink() or not metadata_file.is_file() or not metadata_file.resolve().is_relative_to(resolved):
        raise ValueError('Extracted package identity mismatch')
    try:
        metadata=json.loads(metadata_file.read_text(encoding='utf-8'))
    except (OSError,UnicodeDecodeError,json.JSONDecodeError) as exc:
        raise ValueError('Extracted package identity mismatch') from exc
    pkg_version=metadata.get('version') if isinstance(metadata,dict) else None
    if not isinstance(pkg_version,str) or not re.fullmatch(r'\d+\.\d+\.\d+',pkg_version):
        raise ValueError('Extracted package identity mismatch')
    version(pkg_version)
    if expected_version is not None and pkg_version!=expected_version:
        raise ValueError('Extracted package identity mismatch')
    icon=resolved/'_internal/resources/public/brand-mark-fixed.svg'
    if icon.is_symlink() or not icon.is_file() or not icon.resolve().is_relative_to(resolved):
        raise ValueError('Application icon is missing')
    uid=_current_uid() if require_user_owner else None
    for root,dirnames,filenames in os.walk(resolved,followlinks=False):
        root_path=Path(root)
        if uid is not None and root_path.lstat().st_uid!=uid:
            raise ValueError('Existing installation is not owned by the current user')
        for name in (*dirnames,*filenames):
            entry=root_path/name
            st=entry.lstat()
            if uid is not None and st.st_uid!=uid:
                raise ValueError('Existing installation is not owned by the current user')
            if stat.S_ISLNK(st.st_mode):
                raw_target=os.readlink(entry)
                if Path(raw_target).is_absolute() or not (entry.parent/raw_target).resolve(strict=False).is_relative_to(resolved):
                    raise ValueError('Package contains an external symlink')
            elif not (stat.S_ISREG(st.st_mode) or stat.S_ISDIR(st.st_mode)):
                raise ValueError('Package contains unsupported special files')
    return pkg_version

def _normalize_file_mode(path, *, executable=False):
    mode=stat.S_IMODE(path.lstat().st_mode)
    target_mode=((mode & 0o755) | 0o700) if executable else ((mode & 0o644) | 0o600)
    os.chmod(path,target_mode)

def _normalize_permissions(package):
    resolved=package.resolve()
    main_binary=resolved/'super-md'
    os.chmod(resolved,(stat.S_IMODE(resolved.lstat().st_mode) & 0o755) | 0o700)
    for root,dirnames,filenames in os.walk(resolved,topdown=True,followlinks=False):
        root_path=Path(root)
        os.chmod(root_path,(stat.S_IMODE(root_path.lstat().st_mode) & 0o755) | 0o700)
        for dirname in dirnames:
            subdir=root_path/dirname
            if not subdir.is_symlink():
                os.chmod(subdir,(stat.S_IMODE(subdir.lstat().st_mode) & 0o755) | 0o700)
        for filename in filenames:
            entry=root_path/filename
            if entry.is_symlink():
                continue
            mode=stat.S_IMODE(entry.lstat().st_mode)
            _normalize_file_mode(entry,executable=(entry==main_binary or bool(mode & 0o111)))

def _ensure_tree_user_writable(root):
    if not root.exists() and not root.is_symlink():
        return
    if root.is_symlink():
        return
    try:
        os.chmod(root,stat.S_IMODE(root.lstat().st_mode) | 0o700)
    except OSError:
        return
    for current,dirnames,filenames in os.walk(root,topdown=True,followlinks=False):
        current_path=Path(current)
        for dirname in dirnames:
            subdir=current_path/dirname
            if not subdir.is_symlink():
                try:os.chmod(subdir,stat.S_IMODE(subdir.lstat().st_mode) | 0o700)
                except OSError:pass
        for filename in filenames:
            entry=current_path/filename
            if not entry.is_symlink():
                try:os.chmod(entry,stat.S_IMODE(entry.lstat().st_mode) | 0o600)
                except OSError:pass

def available(executable=None, home=None, *, frozen=None, platform=None):
    platform=sys.platform if platform is None else platform
    frozen=bool(getattr(sys,'frozen',False)) if frozen is None else bool(frozen)
    if not platform.startswith('linux') or not frozen:
        return False
    try:
        exe=Path(executable or sys.executable).resolve()
        if exe.name!='super-md' or not exe.is_file():
            return False
        package=exe.parent
        home_path=Path(home) if home is not None else Path.home()
        resolved_home=home_path.resolve()
        opt=(home_path/'.local/opt').resolve()
        user_local=_is_user_local_package(package,opt)
        if not user_local and not package.is_relative_to(resolved_home) and _is_system_package(package):
            return False
        _validate_package(package,require_user_owner=user_local)
        return True
    except (OSError,RuntimeError,ValueError):
        return False

def _check_launcher(launcher):
    if launcher.is_symlink():
        _require_user_owned(launcher,'Existing launcher is not owned by the current user')
        previous=launcher.resolve()
        if previous.parent.parent!=(launcher.parent.parent/'opt').resolve() or not previous.parent.name.startswith('super-md-qt-'):raise ValueError('Existing launcher belongs to another installation')
    elif launcher.exists():raise ValueError('Existing launcher is not managed by Super MD')

def _link(target, launcher):
    launcher.parent.mkdir(parents=True,exist_ok=True)
    _check_launcher(launcher)
    stage=launcher.with_name('.super-md-link-'+uuid.uuid4().hex)
    try:stage.symlink_to(target);os.replace(stage,launcher)
    finally:stage.unlink(missing_ok=True)

def _restore_launcher(launcher, prior_target):
    stage=launcher.with_name('.super-md-link-'+uuid.uuid4().hex)
    try:
        if prior_target is None:
            launcher.unlink(missing_ok=True)
        else:
            stage.symlink_to(prior_target)
            os.replace(stage,launcher)
    except OSError:
        pass
    finally:
        stage.unlink(missing_ok=True)

def _exec_path(path):
    # Desktop Entry Exec quoting, including percent field-code escaping. The
    # specification does not run this through a shell.
    return '"'+str(path).replace('\\','\\\\').replace('"','\\"').replace('`','\\`').replace('$','\\$').replace('%','%%')+'"'

def _preflight_registration(home):
    local=home/'.local'
    binary=local/'bin/super-md'
    _check_launcher(binary)
    desktop=local/'share/applications/dev.supermd.studio.desktop'
    if desktop.is_symlink():
        raise ValueError('Existing desktop entry is not managed by Super MD')
    if desktop.exists():
        _require_user_owned(desktop,'Existing desktop entry is not owned by the current user')
        prior=desktop.read_text(encoding='utf-8')
        # Accept the previous official installer template, not unrelated entries.
        if OWNER not in prior and not ('Name=Super MD\n' in prior and ('Exec='+_exec_path(binary)+' %f') in prior):
            raise ValueError('Existing desktop entry is not managed by Super MD')
    icon_target=local/'share/icons/hicolor/scalable/apps/super-md.svg'
    mime_target=local/'share/mime/packages/supermd.xml'
    for target,label in ((icon_target,'Existing application icon'),(mime_target,'Existing MIME definition')):
        if target.is_symlink():
            raise ValueError(label+' is not managed by Super MD')
        if target.exists():
            _require_user_owned(target,label+' is not owned by the current user')
    return local,binary,desktop,icon_target,mime_target

def register(package, home=None):
    home=Path(home) if home is not None else Path.home()
    package=Path(package).resolve()
    local,binary,desktop,target,mime=_preflight_registration(home)
    icon=package/'_internal/resources/public/brand-mark-fixed.svg'
    if icon.is_symlink() or not icon.is_file() or not icon.resolve().is_relative_to(package):
        raise ValueError('Application icon is missing')
    app_binary=package/'super-md'
    if app_binary.is_symlink() or not app_binary.is_file() or app_binary.resolve().parent!=package:
        raise ValueError('Extracted package identity mismatch')
    icon_bytes=icon.read_bytes()
    text='\n'.join(['[Desktop Entry]','Type=Application','Name=Super MD','Comment=Markdown notes, portable documents and typeset PDFs','Exec='+_exec_path(binary)+' %f','Icon=super-md','Terminal=false','Categories=Utility;TextEditor;','MimeType=text/markdown;text/x-markdown;text/plain;application/vnd.supermd.smd;application/vnd.supermd.fmd;','StartupNotify=true','StartupWMClass=dev.supermd.studio',OWNER,''])
    prior_files={
        path:(path.read_bytes(),stat.S_IMODE(path.stat().st_mode)) if path.exists() else None
        for path in (target,mime,desktop)
    }
    prior_launcher=os.readlink(binary) if binary.is_symlink() else None
    try:
        target.parent.mkdir(parents=True,exist_ok=True);atomic_write(target,icon_bytes);_normalize_file_mode(target,executable=False)
        mime.parent.mkdir(parents=True,exist_ok=True);atomic_write(mime,_MIME_XML);_normalize_file_mode(mime,executable=False)
        desktop.parent.mkdir(parents=True,exist_ok=True);atomic_write(desktop,text.encode('utf-8'));_normalize_file_mode(desktop,executable=False)
        _link(app_binary,binary)
    except Exception:
        _restore_launcher(binary,prior_launcher)
        for path,saved in prior_files.items():
            try:
                if saved is None:
                    path.unlink(missing_ok=True)
                else:
                    data,mode=saved
                    atomic_write(path,data)
                    os.chmod(path,(mode & 0o644) | 0o600)
            except OSError:
                pass
        raise
    for command in [('update-mime-database',str(local/'share/mime')),('update-desktop-database',str(desktop.parent)),('gtk-update-icon-cache','-f','-t',str(local/'share/icons/hicolor'))]:
        if shutil.which(command[0]):
            try:subprocess.run(command,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,timeout=15,check=False)
            except (OSError,subprocess.TimeoutExpired):pass
    # Registration offers Open With; it deliberately does not change defaults.
    return str(binary)

def install_appimage(image, expected_version, integrate=True, home=None):
    version(expected_version)
    home=Path(home) if home is not None else Path.home();opt=(home/'.local/opt').resolve()
    _check_launcher(home/'.local/bin/super-md')
    opt.mkdir(parents=True,exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='.super-md-stage-',dir=opt) as staging:
        stage=Path(staging)
        subprocess.run([str(Path(image).resolve()),'--appimage-extract'],cwd=stage,stdout=subprocess.DEVNULL,stderr=subprocess.PIPE,timeout=180,check=True)
        package=stage/'squashfs-root/usr/lib/super-md'
        metadata=json.loads((package/'_internal/resources/desktop/build-info.json').read_text(encoding='utf-8'))
        if metadata.get('version')!=expected_version or not (package/'super-md').is_file() or (package/'super-md').resolve().parent!=package:raise ValueError('Extracted package identity mismatch')
        destination=opt/('super-md-qt-'+expected_version)
        # Keep any previous installation of this version recoverable, too.
        if destination.exists():destination=opt/('super-md-qt-'+expected_version+'-'+uuid.uuid4().hex[:8])
        package.rename(destination)
    launcher=home/'.local/bin/super-md'
    # Register before activating the launcher. Failed registration never changes
    # which binary launches, and leaves the old installation available.
    if integrate:register(destination,home)
    else:_link(destination/'super-md',launcher)
    return str(destination)

def integrate_current(current_version, *, executable=None, home=None, frozen=None, platform=None):
    version(current_version)
    platform=sys.platform if platform is None else platform
    frozen=bool(getattr(sys,'frozen',False)) if frozen is None else bool(frozen)
    if not platform.startswith('linux') or not frozen:
        raise ValueError('Desktop integration is available for portable Linux builds only')
    exe=Path(executable or sys.executable).resolve()
    package=exe.parent
    home_path=Path(home) if home is not None else Path.home()
    resolved_home=home_path.resolve()
    opt=(home_path/'.local/opt').resolve()
    user_local=_is_user_local_package(package,opt)
    if not user_local and not package.is_relative_to(resolved_home) and _is_system_package(package):
        raise ValueError('Desktop integration is available for portable Linux builds only')
    if exe.name!='super-md' or not exe.is_file():
        raise ValueError('Extracted package identity mismatch')
    _validate_package(package,expected_version=current_version,require_user_owner=user_local)
    _preflight_registration(home_path)
    if user_local:
        _normalize_permissions(package)
        register(package,home_path)
        return str(package)
    opt.mkdir(parents=True,exist_ok=True)
    _require_user_owned(opt,'Installation directory is not owned by the current user')
    destination=None
    stage_dir=Path(tempfile.mkdtemp(prefix='.super-md-stage-',dir=opt))
    try:
        staged=stage_dir/'package'
        shutil.copytree(package,staged,symlinks=True)
        _normalize_permissions(staged)
        _validate_package(staged,expected_version=current_version,require_user_owner=True)
        destination=opt/('super-md-qt-'+current_version)
        # Keep any previous installation of this version recoverable, too.
        if destination.exists() or destination.is_symlink():
            destination=opt/('super-md-qt-'+current_version+'-'+uuid.uuid4().hex[:8])
        staged.rename(destination)
    finally:
        _ensure_tree_user_writable(stage_dir)
        shutil.rmtree(stage_dir,ignore_errors=True)
    try:
        register(destination,home_path)
    except Exception:
        if destination is not None:
            _ensure_tree_user_writable(destination)
            shutil.rmtree(destination,ignore_errors=True)
        raise
    return str(destination)
