"""Install a verified onedir build per-user, retaining the previous launcher."""
import argparse
import datetime
import json
import os
import re
import shutil
import subprocess
import tempfile
import uuid
from pathlib import Path

def install(package):
    package = package.resolve()
    resources = package / "_internal/resources"
    metadata = json.loads((resources / "desktop/build-info.json").read_text())
    version = metadata["version"]
    if not re.fullmatch(r"\d+\.\d+\.\d+", version) or not (package / "super-md").is_file():
        raise ValueError("Not a valid Super MD package")
    local = Path.home() / ".local"
    opt = local / "opt"
    opt.mkdir(parents=True, exist_ok=True)
    destination = opt / f"super-md-qt-{version}"
    stamp = datetime.datetime.now().strftime("%Y%m%d-%H%M%S")
    stage = Path(tempfile.mkdtemp(prefix=f"super-md-qt-{version}-install-", dir=opt))
    shutil.copytree(package, stage, dirs_exist_ok=True, symlinks=True)
    if destination.exists():
        destination.rename(opt / f"super-md-qt-{version}.before-{stamp}")
    stage.rename(destination)

    def backup(path):
        if path.exists() or path.is_symlink():
            saved = path.with_name(path.name + f".before-qt-{version}-{stamp}")
            shutil.copy2(path, saved, follow_symlinks=False)
            return saved
        return None

    binary = local / "bin/super-md"
    binary.parent.mkdir(parents=True, exist_ok=True)
    old_launcher = backup(binary)
    link = binary.with_name(".super-md-install-" + uuid.uuid4().hex)
    link.symlink_to(destination / "super-md")
    os.replace(link, binary)
    cli = local / "bin/smd-engine"
    backup(cli)
    link = cli.with_name(".smd-engine-install-" + uuid.uuid4().hex)
    link.symlink_to(destination / "_internal/resources/desktop/smd-engine")
    os.replace(link, cli)
    templates = Path(__file__).parent / "linux"
    desktop = local / "share/applications/dev.supermd.studio.desktop"
    desktop.parent.mkdir(parents=True, exist_ok=True)
    backup(desktop)
    text = (templates / "dev.supermd.studio.desktop").read_text()
    text = text.replace("Exec=super-md %f", f'Exec="{binary}" %f').replace("TryExec=super-md", f"TryExec={binary}")
    desktop.write_text(text)
    for source, target in [(templates / "supermd.xml", local / "share/mime/packages/supermd.xml"),
                           (resources / "public/brand-mark-fixed.svg", local / "share/icons/hicolor/scalable/apps/super-md.svg")]:
        target.parent.mkdir(parents=True, exist_ok=True)
        backup(target)
        shutil.copy2(source, target)
    for command in [("update-mime-database", str(local / "share/mime")),
                    ("update-desktop-database", str(local / "share/applications")),
                    ("gtk-update-icon-cache", "-f", "-t", str(local / "share/icons/hicolor")),
                    ("xdg-mime", "default", "dev.supermd.studio.desktop", "application/vnd.supermd.smd"),
                    ("xdg-mime", "default", "dev.supermd.studio.desktop", "application/vnd.supermd.fmd")]:
        if shutil.which(command[0]):
            subprocess.run(command, check=False, stdout=subprocess.DEVNULL)
    print(json.dumps({"installed": str(destination), "version": version,
                      "launcher": str(binary), "rollbackLauncher": str(old_launcher)}, indent=2))

if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--package", type=Path, required=True)
    install(parser.parse_args().package)
