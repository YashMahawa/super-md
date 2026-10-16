"""Opt-in, per-user portable installation; never overwrite system packages.

The old installation and running process remain intact. Activation is an atomic
launcher change, not a second app competing with the current instance broker.
"""
import json
import os
import shutil
import subprocess
import sys
import tempfile
import uuid
from pathlib import Path
from documents import atomic_write
from updates import version

OWNER='X-SuperMD-Managed=true'

def available():
    if not sys.platform.startswith('linux') or not getattr(sys,'frozen',False):return False
    return bool(os.environ.get('APPIMAGE')) or Path(sys.executable).resolve().parent.parent==(Path.home()/'.local/opt').resolve() and Path(sys.executable).resolve().parent.name.startswith('super-md-qt-')

def _check_launcher(launcher):
    if launcher.is_symlink():
        previous=launcher.resolve()
        if previous.parent.parent!=(launcher.parent.parent/'opt').resolve() or not previous.parent.name.startswith('super-md-qt-'):raise ValueError('Existing launcher belongs to another installation')
    elif launcher.exists():raise ValueError('Existing launcher is not managed by Super MD')

def _link(target, launcher):
    launcher.parent.mkdir(parents=True,exist_ok=True)
    _check_launcher(launcher)
    stage=launcher.with_name('.super-md-link-'+uuid.uuid4().hex)
    try:stage.symlink_to(target);os.replace(stage,launcher)
    finally:stage.unlink(missing_ok=True)

def _exec_path(path):
    # Desktop Entry Exec quoting, including percent field-code escaping. The
    # specification does not run this through a shell.
    return '"'+str(path).replace('\\','\\\\').replace('"','\\"').replace('`','\\`').replace('$','\\$').replace('%','%%')+'"'

def register(package, home=None):
    home=Path(home) if home is not None else Path.home()
    local=home/'.local';binary=local/'bin/super-md'
    _check_launcher(binary)
    desktop=local/'share/applications/dev.supermd.studio.desktop'
    if desktop.exists():
        prior=desktop.read_text(encoding='utf-8')
        # Accept the previous official installer template, not unrelated entries.
        if OWNER not in prior and not ('Name=Super MD\n' in prior and ('Exec='+_exec_path(binary)+' %f') in prior):raise ValueError('Existing desktop entry is not managed by Super MD')
    icon=package/'_internal/resources/public/brand-mark-fixed.svg'
    if not icon.is_file():raise ValueError('Application icon is missing')
    text='\n'.join(['[Desktop Entry]','Type=Application','Name=Super MD','Comment=Markdown notes, portable documents and typeset PDFs','Exec='+_exec_path(binary)+' %f','Icon=super-md','Terminal=false','Categories=Utility;TextEditor;','MimeType=text/markdown;text/x-markdown;text/plain;application/vnd.supermd.smd;application/vnd.supermd.fmd;','StartupNotify=true','StartupWMClass=dev.supermd.studio',OWNER,''])
    target=local/'share/icons/hicolor/scalable/apps/super-md.svg'
    target.parent.mkdir(parents=True,exist_ok=True);atomic_write(target,icon.read_bytes())
    mime=local/'share/mime/packages/supermd.xml';mime.parent.mkdir(parents=True,exist_ok=True)
    atomic_write(mime,b'<?xml version="1.0"?><mime-info xmlns="http://www.freedesktop.org/standards/shared-mime-info"><mime-type type="application/vnd.supermd.smd"><comment>Portable Super MD note</comment><glob pattern="*.smd" weight="80"/><icon name="super-md"/></mime-type><mime-type type="application/vnd.supermd.fmd"><comment>Legacy Super MD note</comment><glob pattern="*.fmd" weight="80"/><icon name="super-md"/></mime-type></mime-info>')
    desktop.parent.mkdir(parents=True,exist_ok=True);atomic_write(desktop,text.encode())
    _link(package/'super-md',binary)
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

def integrate_current(current_version):
    if not available():raise ValueError('Desktop integration is available for portable Linux builds only')
    image=os.environ.get('APPIMAGE')
    if image:return install_appimage(image,current_version,True)
    package=Path(sys.executable).resolve().parent
    register(package)
    return str(package)
