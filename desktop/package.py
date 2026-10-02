"""Build a self-contained Qt distribution and native installers on the host OS."""
import argparse
import hashlib
import json
import os
import platform
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUTPUT = ROOT / "desktop/dist"

def run(*args, **kwargs):
    subprocess.run([str(arg) for arg in args], check=True, **kwargs)

def build():
    version = json.loads((ROOT / "package.json").read_text())["version"]
    identity = {"version": version,
                "commit": subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip(),
                "dirty": bool(subprocess.check_output(["git", "status", "--porcelain"], cwd=ROOT, text=True).strip())}
    (ROOT / "desktop/build-info.json").write_text(json.dumps(identity))
    run(sys.executable, "-m", "PyInstaller", "--noconfirm", "--distpath", OUTPUT,
        "--workpath", ROOT / "desktop/build", ROOT / "desktop/super-md.spec", cwd=ROOT)
    return version

def installers(version):
    packages = OUTPUT / "packages"
    packages.mkdir(exist_ok=True)
    if sys.platform == "win32":
        run("makensis", f"/DVERSION={version}", ROOT / "desktop/windows/installer.nsi", cwd=ROOT)
    elif sys.platform == "darwin":
        architecture = "aarch64" if platform.machine() == "arm64" else "x64"
        with tempfile.TemporaryDirectory(prefix="supermd-dmg-") as temporary:
            folder = Path(temporary)
            shutil.copytree(OUTPUT / "Super MD.app", folder / "Super MD.app", symlinks=True)
            (folder / "Applications").symlink_to("/Applications")
            run("hdiutil", "create", "-volname", "Super MD", "-srcfolder", folder,
                "-ov", "-format", "UDZO", packages / f"Super-MD_{version}_{architecture}.dmg")
    else:
        with tempfile.TemporaryDirectory(prefix="supermd-installer-") as temporary:
            stage = Path(temporary)
            appdir = stage / "SuperMD.AppDir"
            shutil.copytree(OUTPUT / "super-md", appdir / "usr/lib/super-md", symlinks=True)
            (appdir / "usr/bin").mkdir(parents=True)
            (appdir / "usr/bin/super-md").symlink_to("../lib/super-md/super-md")
            for source, target in [("desktop/linux/dev.supermd.studio.desktop", "dev.supermd.studio.desktop"),
                                   ("desktop/linux/AppRun", "AppRun"),
                                   ("public/brand-mark-fixed.svg", "super-md.svg")]:
                shutil.copy2(ROOT / source, appdir / target)
            (appdir / "AppRun").chmod(0o755)
            appimage = os.environ.get("APPIMAGETOOL")
            if not appimage:
                raise RuntimeError("Set APPIMAGETOOL to the official appimagetool executable")
            run(appimage, "--no-appstream", appdir, packages / f"Super-MD_{version}_amd64.AppImage",
                env={**os.environ, "ARCH": "x86_64", "APPIMAGE_EXTRACT_AND_RUN": "1"})
            # Debian package installs only program files; user data lives separately.
            deb = stage / "deb"
            shutil.copytree(OUTPUT / "super-md", deb / "opt/super-md", symlinks=True)
            for source, destination in [("desktop/linux/dev.supermd.studio.desktop", "usr/share/applications/dev.supermd.studio.desktop"),
                                        ("desktop/linux/supermd.xml", "usr/share/mime/packages/supermd.xml"),
                                        ("public/brand-mark-fixed.svg", "usr/share/icons/hicolor/scalable/apps/super-md.svg")]:
                target = deb / destination
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(ROOT / source, target)
            (deb / "usr/bin").mkdir(parents=True, exist_ok=True)
            (deb / "usr/bin/super-md").symlink_to("/opt/super-md/super-md")
            (deb / "DEBIAN").mkdir()
            (deb / "DEBIAN/control").write_text(f"Package: super-md\nVersion: {version}\nArchitecture: amd64\nMaintainer: Super MD <YashMahawa@users.noreply.github.com>\nDepends: libc6 (>= 2.35), libnss3, libasound2, libxcb1, libxkbcommon0, libegl1, libgl1, libdbus-1-3\nSection: editors\nPriority: optional\nDescription: Native Qt Markdown studio with typeset PDF export\n")
            for hook in ("postinst", "postrm"):
                shutil.copy2(ROOT / "desktop/linux/mime-refresh.sh", deb / "DEBIAN" / hook)
                (deb / "DEBIAN" / hook).chmod(0o755)
            debfile = packages / f"Super-MD_{version}_amd64.deb"
            run("dpkg-deb", "--build", "--root-owner-group", deb, debfile)
            run("fpm", "-s", "deb", "-t", "rpm", "--rpm-rpmbuild-define", "_build_id_links none",
                "-p", packages / f"Super-MD-{version}-1.x86_64.rpm", debfile)
    for file in packages.iterdir():
        if file.is_file() and file.name != "SHA256SUMS":
            print(f"{hashlib.sha256(file.read_bytes()).hexdigest()}  {file.name}")

if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--bundle-only", action="store_true")
    parser.add_argument("--installers-only", action="store_true")
    args = parser.parse_args()
    version = json.loads((ROOT / "package.json").read_text())["version"] if args.installers_only else build()
    if not args.bundle_only:
        installers(version)
