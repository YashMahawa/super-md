"""Bounded, opt-in downloads from published Super MD GitHub releases only.

Never execute a network response or replace a running installation. The user
opens the verified platform installer; the previous install remains recoverable.
"""
import hashlib
import json
import platform
import re
import sys
import urllib.parse
import urllib.request
from pathlib import Path

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
    return urllib.request.build_opener(SafeRedirect()).open(urllib.request.Request(url, headers={"User-Agent": "Super-MD-updater", "Accept": "application/vnd.github+json"}), timeout=30)

def bounded_json(url, limit=1_000_000):
    with response(url) as stream: data=stream.read(limit+1)
    if len(data)>limit: raise ValueError("Update response is too large")
    return json.loads(data)

def release_info(data, current, system=None, machine=None):
    tag=data.get("tag_name", "")
    if data.get("draft") or data.get("prerelease") or version(tag)<=version(current): return None
    system=system or sys.platform;machine=machine or platform.machine()
    suffix="_x64-setup.exe" if system=="win32" else ("_aarch64.dmg" if machine in ("arm64","aarch64") else "_x64.dmg") if system=="darwin" else "_amd64.AppImage"
    name=f"Super-MD_{tag.lstrip('v')}{suffix}"
    assets={asset["name"]:asset for asset in data.get("assets", [])}
    if name not in assets or "SHA256SUMS" not in assets: raise ValueError("The published update is incomplete for this platform")
    if not 0<assets[name].get("size",0)<=1_500_000_000: raise ValueError("Invalid update size")
    return {"version":tag.lstrip('v'),"name":name,"size":assets[name]["size"],"url":asset_url(assets[name]["browser_download_url"]),"checksums":asset_url(assets["SHA256SUMS"]["browser_download_url"])}

def checksum(text, name):
    for line in text.splitlines():
        match=re.fullmatch(r"([a-fA-F0-9]{64})\s+\*?(.+)", line)
        if match and match[2]==name:return match[1].lower()
    raise ValueError("Update checksum is missing")

def download(info, directory):
    with response(asset_url(info["checksums"])) as stream: sums=stream.read(65_537)
    if len(sums)>65_536: raise ValueError("Checksum manifest is too large")
    expected=checksum(sums.decode("utf-8"),info["name"])
    directory=Path(directory);directory.mkdir(parents=True,exist_ok=True)
    target=directory/info["name"];temporary=target.with_suffix(target.suffix+".part")
    digest=hashlib.sha256();count=0
    try:
        with response(asset_url(info["url"])) as stream, temporary.open("wb") as output:
            while chunk:=stream.read(256*1024):
                count+=len(chunk)
                if count>info["size"]:raise ValueError("Update exceeds its declared size")
                digest.update(chunk);output.write(chunk)
        if count!=info["size"] or digest.hexdigest()!=expected:raise ValueError("Update checksum or size mismatch")
        temporary.replace(target)
        if target.suffix==".AppImage":target.chmod(0o700)
        return str(target)
    finally:
        temporary.unlink(missing_ok=True)
