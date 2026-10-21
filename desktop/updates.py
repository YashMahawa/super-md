"""Bounded, opt-in downloads from published Super MD GitHub releases only.

Never execute a network response or replace a running installation. The user
opens the verified platform installer; the previous install remains recoverable.
"""
import hashlib
import json
import platform
import re
import sys
import os
import socket
import shutil
import ssl
import subprocess
import tempfile
import urllib.parse
import urllib.request
from pathlib import Path
from documents import atomic_json
from network_tls import client_context

REPO = "https://github.com/YashMahawa/super-md"
API = "https://api.github.com/repos/YashMahawa/super-md/releases/latest"

def version(value):
    match = re.fullmatch(r"v?(\d+)\.(\d+)\.(\d+)", value)
    if not match: raise ValueError("Invalid stable release version")
    return tuple(map(int, match.groups()))

def asset_url(value):
    url = urllib.parse.urlsplit(value)
    if url.scheme != "https" or url.netloc != "github.com" or not url.path.startswith("/YashMahawa/super-md/releases/download/") or url.query or url.fragment:
        raise ValueError("Update asset is not from the official repository")
    return value

class SafeRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, message, headers, newurl):
        url = urllib.parse.urlsplit(newurl)
        if url.scheme != "https" or url.hostname not in ("github.com", "release-assets.githubusercontent.com", "objects.githubusercontent.com"):
            raise ValueError("Untrusted update redirect")
        return super().redirect_request(request, fp, code, message, headers, newurl)

def response(url):
    return urllib.request.build_opener(
        SafeRedirect(), urllib.request.HTTPSHandler(context=client_context())
    ).open(urllib.request.Request(url, headers={"User-Agent": "Super-MD-updater", "Accept": "application/vnd.github+json"}), timeout=30)

def check_failure(error):
    """Return a short actionable update-check error without exposing internals."""
    reason = getattr(error, "reason", error)
    if isinstance(reason, ssl.SSLCertVerificationError):
        return "Could not verify the update server certificate. Check your system date, time, and network trust settings; no update was downloaded."
    status = getattr(error, "code", None)
    if status == 403:
        return "The update service denied the request. Check GitHub availability and try again."
    if status == 429:
        return "The update service is rate-limiting requests. Wait briefly, then try again."
    if isinstance(reason, (TimeoutError, socket.timeout)):
        return "The update check timed out. Check your connection and try again."
    return "Could not check for updates. Check your internet connection and try again. Your notes still work offline."

def bounded_json(url, limit=1_000_000):
    with response(url) as stream: data=stream.read(limit+1)
    if len(data)>limit: raise ValueError("Update response is too large")
    return json.loads(data)

def linux_install_kind(executable=None, environ=None, frozen=None, home=None):
    """Return the current Linux package channel without changing the system."""
    environ = os.environ if environ is None else environ
    if environ.get("APPIMAGE"):
        return "appimage"
    executable = Path(executable or sys.executable).resolve()
    home = Path(home or Path.home()).resolve()
    if frozen is None:
        frozen = bool(getattr(sys, "frozen", False))
    if frozen and executable.parent.parent == (home / ".local/opt").resolve() and executable.parent.name.startswith("super-md-qt-"):
        return "appimage"
    if frozen:
        # Query ownership of this exact executable, not whether a package
        # manager happens to be installed on the host.
        if shutil.which("dpkg-query"):
            try:
                result = subprocess.run(["dpkg-query", "-S", str(executable)], capture_output=True, text=True, timeout=3, check=False)
                owners = [entry.split(": ", 1)[0].split(":", 1)[0] for entry in result.stdout.splitlines() if ": " in entry]
                if result.returncode == 0 and "super-md" in owners:
                    return "deb"
            except (OSError, subprocess.TimeoutExpired):
                pass
        if shutil.which("rpm"):
            try:
                result = subprocess.run(["rpm", "-qf", "--qf", "%{NAME}", str(executable)], capture_output=True, text=True, timeout=3, check=False)
                if result.returncode == 0 and result.stdout.strip() == "super-md":
                    return "rpm"
            except (OSError, subprocess.TimeoutExpired):
                pass
    # Unknown/source installations retain the existing portable Linux update
    # path; the install action still refuses to replace an unmanaged system app.
    return "appimage"

def release_info(data, current, system=None, machine=None, linux_kind="appimage"):
    tag=data.get("tag_name", "")
    if data.get("draft") or data.get("prerelease") or version(tag)<=version(current): return None
    system=system or sys.platform;machine=machine or platform.machine()
    if system.startswith("linux") and linux_kind not in ("appimage", "deb", "rpm"):
        raise ValueError("Unsupported Linux update channel")
    if system == "win32":
        suffix = "_x64-setup.exe"
    elif system == "darwin":
        suffix = "_aarch64.dmg" if machine in ("arm64", "aarch64") else "_x64.dmg"
    else:
        suffix = {"appimage": "_amd64.AppImage", "deb": "_amd64.deb", "rpm": "-1.x86_64.rpm"}.get(linux_kind)
        if suffix is None:
            raise ValueError("Unsupported Linux update channel")
    release_version = tag.lstrip("v")
    # The RPM packaging job follows the native RPM package naming convention;
    # unlike the other generated installers its published name uses hyphens.
    name = f"Super-MD-{release_version}-1.x86_64.rpm" if linux_kind == "rpm" and system.startswith("linux") else f"Super-MD_{release_version}{suffix}"
    assets={asset["name"]:asset for asset in data.get("assets", [])}
    if name not in assets or "SHA256SUMS" not in assets: raise ValueError("The published update is incomplete for this platform")
    if not 0<assets[name].get("size",0)<=1_500_000_000: raise ValueError("Invalid update size")
    return {"version":tag.lstrip('v'),"name":name,"size":assets[name]["size"],"url":asset_url(assets[name]["browser_download_url"]),"checksums":asset_url(assets["SHA256SUMS"]["browser_download_url"])}

def checksum(text, name):
    for line in text.splitlines():
        match=re.fullmatch(r"([a-fA-F0-9]{64})\s+\*?(.+)", line)
        if match and match[2]==name:return match[1].lower()
    raise ValueError("Update checksum is missing")

def validate_info(info):
    version(info['version'])
    if not re.fullmatch(r'(?:Super-MD_'+re.escape(info['version'])+r'_(?:amd64\.(?:AppImage|deb)|x64-setup\.exe|(?:x64|aarch64)\.dmg)|Super-MD-'+re.escape(info['version'])+r'-1\.x86_64\.rpm)',info['name']):
        raise ValueError('Invalid installer name')
    for key in ('url','checksums'):asset_url(info[key])
    if info['url']!=f"{REPO}/releases/download/v{info['version']}/{info['name']}" or info['checksums']!=f"{REPO}/releases/download/v{info['version']}/SHA256SUMS":raise ValueError('Mismatched release assets')
    if type(info['size']) is not int or not 0<info['size']<=1_500_000_000:raise ValueError('Invalid installer size')

def installer_kind(info):
    validate_info(info)
    name = info["name"]
    if name.endswith(".AppImage"): return "appimage"
    if name.endswith(".deb"): return "deb"
    if name.endswith(".rpm"): return "rpm"
    if name.endswith(".exe"): return "windows"
    if name.endswith(".dmg"): return "macos"
    raise ValueError("Unsupported installer type")

def verify_file(path, info, expected):
    validate_info(info)
    path=Path(path)
    if path.is_symlink() or not path.is_file() or path.stat().st_size!=info['size'] or not re.fullmatch('[a-f0-9]{64}',expected):raise ValueError('Downloaded installer is missing or changed')
    digest=hashlib.sha256()
    with path.open('rb') as stream:
        while chunk:=stream.read(256*1024):digest.update(chunk)
    if digest.hexdigest()!=expected:raise ValueError('Downloaded installer checksum mismatch')
    return str(path)

def load_ready(state_dir, current):
    """Restore without networking. Never delete a user's downloaded installer."""
    record=Path(state_dir)/'ready.json'
    if not record.is_file():return None
    try:
        if record.stat().st_size>8192:raise ValueError('Invalid update record')
        saved=json.loads(record.read_text(encoding='utf-8'));info=saved['release'];validate_info(info)
        if version(info['version'])<=version(current):
            record.unlink(missing_ok=True);return None
        verify_file(saved['path'],info,saved['sha256'])
        return saved
    except (OSError,ValueError,KeyError,TypeError):return None

def download(info, directory, state_dir=None):
    validate_info(info)
    with response(asset_url(info["checksums"])) as stream: sums=stream.read(65_537)
    if len(sums)>65_536: raise ValueError("Checksum manifest is too large")
    expected=checksum(sums.decode("utf-8"),info["name"])
    directory=Path(directory);directory.mkdir(parents=True,exist_ok=True)
    target=directory/info["name"]
    def remember(path):
        canonical=str(path.resolve())
        if state_dir is not None:
            Path(state_dir).mkdir(parents=True,exist_ok=True)
            atomic_json(Path(state_dir)/'ready.json',{'release':info,'path':canonical,'sha256':expected})
        return canonical
    if target.exists() and not target.is_symlink():
        try:verify_file(target,info,expected);return remember(target)
        except ValueError:pass
    # Preserve a conflicting download instead of overwriting it. A unique staging
    # name also keeps two windows from corrupting one another's partial download.
    fd,name=tempfile.mkstemp(prefix='.'+info['name']+'-',suffix='.part',dir=directory);os.close(fd)
    temporary=Path(name)
    digest=hashlib.sha256();count=0
    try:
        with response(asset_url(info["url"])) as stream, temporary.open("wb") as output:
            while chunk:=stream.read(256*1024):
                count+=len(chunk)
                if count>info["size"]:raise ValueError("Update exceeds its declared size")
                digest.update(chunk);output.write(chunk)
        if count!=info["size"] or digest.hexdigest()!=expected:raise ValueError("Update checksum or size mismatch")
        if target.exists() or target.is_symlink():target=directory/(info['name']+".verified-"+temporary.stem[-8:]+Path(info['name']).suffix)
        temporary.replace(target)
        if target.suffix==".AppImage":target.chmod(0o700)
        return remember(target)
    finally:
        temporary.unlink(missing_ok=True)
