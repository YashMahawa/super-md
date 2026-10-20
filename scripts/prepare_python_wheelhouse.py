#!/usr/bin/env python3
"""Validate a cached wheelhouse, fall back to rebuilding it, then install offline."""
import argparse
import hashlib
import json
import os
import platform
import re
import shlex
import shutil
import subprocess
import sys
import sysconfig
import tempfile
from pathlib import Path

MANIFEST = "wheelhouse-manifest.json"


def requirements_identity(paths):
    digest = hashlib.sha256()
    for path in paths:
        file = Path(path)
        digest.update(file.name.encode("utf-8"))
        digest.update(b"\0")
        digest.update(file.read_bytes())
        digest.update(b"\0")
    return digest.hexdigest()


def runtime_identity():
    def compiler(command):
        command = command or ""
        try:
            parts = shlex.split(command, posix=os.name != "nt")
        except ValueError:
            parts = [command] if command else []
        version = ""
        if parts:
            executable = shutil.which(parts[0])
            if executable:
                flag = "/Bv" if Path(executable).name.lower() in ("cl", "cl.exe") else "--version"
                try:
                    result = subprocess.run([executable, *parts[1:], flag], capture_output=True,
                                            text=True, timeout=5, check=False)
                    output = (result.stdout or result.stderr).strip()
                    version = re.sub(r"\b\d{8}\b", "", output.splitlines()[0]).strip() if output else ""
                except (OSError, subprocess.SubprocessError):
                    pass
        return {"command": command, "version": version}

    def config_or_env(env_name, config_name):
        return os.environ.get(env_name, sysconfig.get_config_var(config_name) or "")

    return {
        "implementation": sys.implementation.name,
        "pythonTag": sys.implementation.cache_tag,
        "pythonVersion": f"{sys.version_info.major}.{sys.version_info.minor}",
        "soabi": sysconfig.get_config_var("SOABI") or "",
        "abiFlags": sysconfig.get_config_var("ABIFLAGS") or "",
        "sysPlatform": sys.platform,
        "machine": platform.machine(),
        "wheelPlatform": sysconfig.get_platform(),
        "multiarch": sysconfig.get_config_var("MULTIARCH") or "",
        "libc": dict(zip(("name", "version"), platform.libc_ver())),
        "pythonCompiler": re.sub(r"\b\d{8}\b", "", platform.python_compiler()).strip(),
        "cCompiler": compiler(config_or_env("CC", "CC")),
        "cxxCompiler": compiler(config_or_env("CXX", "CXX")),
        "buildFlags": {
            key: config_or_env(key, key)
            for key in ("CFLAGS", "CXXFLAGS", "CPPFLAGS", "LDFLAGS")
        },
        "deploymentTarget": os.environ.get("MACOSX_DEPLOYMENT_TARGET") or sysconfig.get_config_var("MACOSX_DEPLOYMENT_TARGET") or "",
        "sdkRoot": os.environ.get("SDKROOT", ""),
        "windowsToolchain": {
            key: os.environ.get(key, "")
            for key in ("VCToolsVersion", "VisualStudioVersion")
        },
    }


def wheel_files(wheelhouse):
    wheels = {}
    for path in sorted(Path(wheelhouse).glob("*.whl")):
        digest = hashlib.sha256()
        with path.open("rb") as stream:
            for chunk in iter(lambda: stream.read(1024 * 1024), b""):
                digest.update(chunk)
        wheels[path.name] = digest.hexdigest()
    return wheels


def manifest_data(wheelhouse, requirement_paths):
    return {
        "requirementsSha256": requirements_identity(requirement_paths),
        "runtime": runtime_identity(),
        "wheels": wheel_files(wheelhouse),
    }


def cache_identity(requirement_paths):
    """Stable key material shared by GitHub Actions and the cache manifest."""
    identity = {
        "requirementsSha256": requirements_identity(requirement_paths),
        "runtime": runtime_identity(),
    }
    encoded = json.dumps(identity, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def write_manifest(wheelhouse, requirement_paths):
    wheelhouse = Path(wheelhouse)
    data = manifest_data(wheelhouse, requirement_paths)
    manifest_path = wheelhouse / MANIFEST
    temporary = manifest_path.with_suffix(".tmp")
    temporary.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")
    temporary.replace(manifest_path)
    return data


def manifest_is_complete(wheelhouse, requirement_paths):
    try:
        saved = json.loads((Path(wheelhouse) / MANIFEST).read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return False
    current = manifest_data(wheelhouse, requirement_paths)
    return bool(current["wheels"]) and saved == current


def install_offline(wheelhouse, requirements_file):
    return subprocess.run([
        sys.executable, "-m", "pip", "install", "--no-index",
        "--find-links", str(wheelhouse), "-r", str(requirements_file),
    ]).returncode == 0


def prepare(wheelhouse, requirements_file, identity_files):
    wheelhouse = Path(wheelhouse).resolve()
    requirements_file = Path(requirements_file).resolve()
    wheelhouse.parent.mkdir(parents=True, exist_ok=True)
    if manifest_is_complete(wheelhouse, identity_files):
        print("Wheelhouse manifest and wheel hashes match; trying offline install.", flush=True)
        if install_offline(wheelhouse, requirements_file):
            return "cache-validated"
        print("Cached wheelhouse failed offline resolution; rebuilding wheels.", flush=True)
    else:
        print("Wheelhouse is absent, incomplete, corrupt, or has a different requirements identity; rebuilding wheels.", flush=True)
    # pip wheel may trust an existing file with the requested wheel filename.
    # Never rebuild into an invalid cache: use a fresh sibling directory so a
    # partial/corrupt cached wheel cannot be silently reused.
    staging = Path(tempfile.mkdtemp(prefix=wheelhouse.name + ".staging-", dir=wheelhouse.parent))
    try:
        subprocess.run([
            sys.executable, "-m", "pip", "wheel", "--wheel-dir", str(staging),
            "-r", str(requirements_file),
        ], check=True)
        if not install_offline(staging, requirements_file):
            raise RuntimeError("Offline install failed after rebuilding the wheelhouse")
        write_manifest(staging, identity_files)
        if not manifest_is_complete(staging, identity_files):
            raise RuntimeError("Rebuilt wheelhouse failed manifest validation")

        quarantine = wheelhouse.with_name(wheelhouse.name + ".quarantine")
        if wheelhouse.exists():
            # Preserve the old cache byte-for-byte. A fixed sibling quarantine
            # bounds retained categories; never overwrite an earlier quarantine.
            if quarantine.exists():
                print("A prior wheelhouse quarantine exists; using the validated staged wheels without replacing either cache.", flush=True)
                return "rebuilt-uncached"
            wheelhouse.rename(quarantine)
            try:
                staging.rename(wheelhouse)
            except OSError:
                # Roll back only our own rename, and only when the destination
                # is still vacant. The quarantined data is never deleted.
                if not wheelhouse.exists() and quarantine.exists():
                    quarantine.rename(wheelhouse)
                raise
        else:
            staging.rename(wheelhouse)
        return "rebuilt"
    finally:
        # The temporary staging directory is ours; after promotion the path no
        # longer exists. This does not remove or rewrite any pre-existing cache.
        if staging.exists():
            shutil.rmtree(staging)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("wheelhouse", type=Path)
    parser.add_argument("requirements", type=Path)
    parser.add_argument("identity_requirements", nargs="+", type=Path)
    args = parser.parse_args()
    outcome = prepare(args.wheelhouse, args.requirements, args.identity_requirements)
    print(f"wheelhouse_outcome={outcome} wheel_count={len(wheel_files(args.wheelhouse))}")


if __name__ == "__main__":
    main()
