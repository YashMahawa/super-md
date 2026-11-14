#!/usr/bin/env python3
"""Install the verified Linux CLI/AppImage from the current public release."""
import argparse,hashlib,json,os,platform,shutil,tempfile,time,urllib.request
from pathlib import Path
p=argparse.ArgumentParser(description=__doc__);p.add_argument('--prefix',type=Path,default=Path.home()/'.local');p.add_argument('--dry-run',action='store_true');a=p.parse_args()
if platform.system()!='Linux' or platform.machine() not in ('x86_64','amd64'):
    raise SystemExit('Use the Windows or macOS desktop installer; their CLI and MCP server are included. See README.md.')
def fetch(url):
    return urllib.request.urlopen(urllib.request.Request(url,headers={'User-Agent':'Super-MD-CLI-installer'}),timeout=60)
with fetch('https://api.github.com/repos/YashMahawa/super-md/releases/latest') as response:release=json.load(response)
asset=next(x for x in release['assets'] if x['name'].endswith('_amd64.AppImage'))
checksums=next(x for x in release['assets'] if x['name']=='SHA256SUMS')
with fetch(checksums['browser_download_url']) as response:
    sums={line.split(None,1)[1].strip().lstrip('*'):line.split(None,1)[0] for line in response.read(65536).decode().splitlines()}
expected=sums[asset['name']]
if asset.get('digest') and asset['digest']!='sha256:'+expected:raise SystemExit('Release checksum metadata does not agree')
target=a.prefix.expanduser()/'bin'/'super-md'
if a.dry_run:print(json.dumps({'release':release['tag_name'],'asset':asset['name'],'sha256':expected,'destination':str(target)}));raise SystemExit(0)
target.parent.mkdir(parents=True,exist_ok=True)
with tempfile.TemporaryDirectory(prefix='.super-md-install-',dir=target.parent) as directory:
    staged=Path(directory)/'super-md';digest=hashlib.sha256();count=0
    with fetch(asset['browser_download_url']) as response,staged.open('wb') as output:
        while block:=response.read(1024*1024):
            count+=len(block)
            if count>asset['size'] or count>700_000_000:raise SystemExit('Installer download exceeds its declared size')
            digest.update(block);output.write(block)
    if count!=asset['size'] or digest.hexdigest()!=expected:raise SystemExit('Installer checksum verification failed')
    staged.chmod(0o755)
    backup=None
    if target.exists() or target.is_symlink():
        backup=target.with_name('super-md.previous-'+str(time.time_ns()));target.rename(backup)
    try:os.replace(staged,target)
    except Exception:
        if backup:backup.rename(target)
        raise
print(json.dumps({'installed':str(target),'version':release['tag_name'],'backup':str(backup) if backup else None}))
