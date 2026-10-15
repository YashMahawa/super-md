"""Exercise a real AppImage update in an isolated home before publication."""
import hashlib
import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path
import app_integration
import updates

def check(image, version):
    image=Path(image).resolve()
    digest=hashlib.sha256()
    with image.open('rb') as stream:
        while chunk:=stream.read(256*1024):digest.update(chunk)
    info={'version':version,'name':f'Super-MD_{version}_amd64.AppImage','size':image.stat().st_size,'url':f'{updates.REPO}/releases/download/v{version}/Super-MD_{version}_amd64.AppImage','checksums':f'{updates.REPO}/releases/download/v{version}/SHA256SUMS'}
    updates.verify_file(image,info,digest.hexdigest())
    with tempfile.TemporaryDirectory(prefix='supermd-update-check-') as directory:
        home=Path(directory)
        previous=home/'.local/opt/super-md-qt-previous';previous.mkdir(parents=True)
        (previous/'super-md').write_text('previous installation retained')
        launcher=home/'.local/bin/super-md';launcher.parent.mkdir();launcher.symlink_to(previous/'super-md')
        package=Path(app_integration.install_appimage(image,version,True,home))
        assert launcher.resolve()==package/'super-md'
        assert (previous/'super-md').read_text()=='previous installation retained'
        assert image.is_file()
        assert app_integration.OWNER in (home/'.local/share/applications/dev.supermd.studio.desktop').read_text()
        environment={**os.environ,'HOME':str(home),'XDG_CONFIG_HOME':str(home/'.config'),'XDG_DATA_HOME':str(home/'.local/share'),'QT_QPA_PLATFORM':'offscreen'}
        result=subprocess.run([str(launcher),'--version'],text=True,capture_output=True,check=True,timeout=30,env=environment)
        assert result.stdout.strip()=='Super MD '+version,result.stdout
        print(json.dumps({'version':version,'verified':'real AppImage extraction, launcher activation, previous-install preservation and installed binary startup'}))

if __name__=='__main__':check(sys.argv[1],sys.argv[2])
