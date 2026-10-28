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


def native_build_inputs():
    """Return verified external native inputs required for this platform's wheels."""
    if sys.platform != "darwin" or platform.machine().lower() not in ("x86_64", "amd64"):
        return {}

    openssl_dir = os.environ.get("OPENSSL_DIR", "").strip()
    if not openssl_dir:
        brew = shutil.which("brew")
        if brew:
            try:
                result = subprocess.run([brew, "--prefix", "openssl@3"], capture_output=True,
                                        text=True, timeout=10, check=False)
                if result.returncode == 0:
                    openssl_dir = result.stdout.strip()
            except (OSError, subprocess.SubprocessError):
                pass
    if not openssl_dir:
        raise RuntimeError(
            "Building the macOS Intel cryptography wheel requires Homebrew OpenSSL 3; "
            "install openssl@3 or set OPENSSL_DIR to its prefix."
        )

    prefix = Path(openssl_dir).expanduser()
    required_files = (prefix / "include/openssl/ssl.h", prefix / "lib/libssl.a", prefix / "lib/libcrypto.a")
    missing = [str(path) for path in required_files if not path.is_file()]
    if missing:
        raise RuntimeError(
            "Static cryptography build needs OpenSSL headers and archives under OPENSSL_DIR; "
            f"missing: {', '.join(missing)}. Install/reinstall Homebrew openssl@3."
        )

    openssl = prefix / "bin/openssl"
    try:
        result = subprocess.run([str(openssl), "version"], capture_output=True, text=True,
                                timeout=5, check=False)
        version = (result.stdout or result.stderr).strip() if result.returncode == 0 else ""
    except (OSError, subprocess.SubprocessError):
        version = ""
    if not version:
        raise RuntimeError(f"Could not read the OpenSSL version from {openssl}")
    return {
        "environment": {"OPENSSL_DIR": str(prefix), "OPENSSL_STATIC": "1"},
        "opensslDir": str(prefix),
        "opensslVersion": version,
    }


def wheel_build_environment(inputs=None):
    environment = os.environ.copy()
    environment.update((inputs if inputs is not None else native_build_inputs()).get("environment", {}))
    return environment


def verify_static_cryptography_openssl(build_inputs=None):
    """Fail early if the installed Intel macOS wheel still imports OpenSSL dylibs."""
    inputs = build_inputs if build_inputs is not None else native_build_inputs()
    if not inputs:
        return

    otool = shutil.which("otool")
    if not otool:
        raise RuntimeError("Cannot verify the static cryptography wheel: macOS otool is unavailable")
    locate_extension = (
        "from importlib.metadata import distribution; "
        "d=distribution('cryptography'); "
        "print(next(d.locate_file(f) for f in d.files or [] "
        "if str(f).startswith('cryptography/hazmat/bindings/_rust.') and str(f).endswith('.so')))"
    )
    try:
        located = subprocess.run([sys.executable, "-c", locate_extension], capture_output=True,
                                 text=True, timeout=10, check=False)
        if located.returncode != 0 or not located.stdout.strip():
            raise RuntimeError((located.stderr or located.stdout).strip() or "cryptography Rust extension was not found")
        extension = Path(located.stdout.strip())
        if not extension.is_file():
            raise RuntimeError(f"cryptography Rust extension was not found at {extension}")
        linked = subprocess.run([otool, "-L", str(extension)], capture_output=True,
                                text=True, timeout=10, check=False)
    except (OSError, subprocess.SubprocessError) as error:
        raise RuntimeError(f"Cannot verify static cryptography linkage: {error}") from error
    if linked.returncode != 0:
        raise RuntimeError(f"otool could not inspect {extension}: {(linked.stderr or linked.stdout).strip()}")
    dynamic_openssl = []
    for line in linked.stdout.splitlines()[1:]:
        library = line.strip().split(" (", 1)[0]
        name = Path(library).name.lower()
        if name.startswith(("libssl", "libcrypto")) and name.endswith(".dylib"):
            dynamic_openssl.append(name)
    if dynamic_openssl:
        names = ", ".join(sorted(set(dynamic_openssl)))
        raise RuntimeError(
            "The macOS Intel cryptography wheel is dynamically linked to " + names + ". "
            "A static OpenSSL build is required; confirm OPENSSL_STATIC=1 and rebuild the wheelhouse."
        )


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

    identity = {
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
    native_inputs = native_build_inputs()
    if native_inputs:
        identity["nativeBuildInputs"] = native_inputs
    return identity


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
    build_inputs = native_build_inputs()
    cryptography_wheels = sorted(Path(wheelhouse).glob("cryptography-*.whl")) if build_inputs else []
    if build_inputs and len(cryptography_wheels) != 1:
        raise RuntimeError(
            "An Intel macOS static build requires exactly one cryptography-*.whl "
            f"in the validated wheelhouse; found {len(cryptography_wheels)}."
        )
    installed = subprocess.run([
        sys.executable, "-m", "pip", "install", "--no-index",
        "--find-links", str(wheelhouse), "-r", str(requirements_file),
    ]).returncode == 0
    if not installed:
        return False
    if build_inputs:
        # Pip can leave an already-installed same-version build untouched.
        # Replace only cryptography with the validated static wheel, without
        # re-resolving or reinstalling PySide/scientific dependencies.
        return subprocess.run([
            sys.executable, "-m", "pip", "install", "--no-index", "--no-deps",
            "--force-reinstall", str(cryptography_wheels[0]),
        ]).returncode == 0
    return True


def prepare(wheelhouse, requirements_file, identity_files):
    wheelhouse = Path(wheelhouse).resolve()
    requirements_file = Path(requirements_file).resolve()
    wheelhouse.parent.mkdir(parents=True, exist_ok=True)
    if manifest_is_complete(wheelhouse, identity_files):
        print("Wheelhouse manifest and wheel hashes match; trying offline install.", flush=True)
        if install_offline(wheelhouse, requirements_file):
            verify_static_cryptography_openssl()
            return "cache-validated"
        print("Cached wheelhouse failed offline resolution; rebuilding wheels.", flush=True)
    else:
        print("Wheelhouse is absent, incomplete, corrupt, or has a different requirements identity; rebuilding wheels.", flush=True)
    # pip wheel may trust an existing file with the requested wheel filename.
    # Never rebuild into an invalid cache: use a fresh sibling directory so a
    # partial/corrupt cached wheel cannot be silently reused.
    staging = Path(tempfile.mkdtemp(prefix=wheelhouse.name + ".staging-", dir=wheelhouse.parent))
    try:
        build_inputs = native_build_inputs()
        command = [sys.executable, "-m", "pip", "wheel"]
        if build_inputs:
            # pip's local wheel cache does not key Rust/OpenSSL builds on
            # OPENSSL_STATIC. Do not let it reuse the earlier dylib-linked
            # cryptography wheel after switching this build to static OpenSSL.
            command.append("--no-cache-dir")
        command.extend(("--wheel-dir", str(staging), "-r", str(requirements_file)))
        subprocess.run(command, check=True, env=wheel_build_environment(build_inputs))
        if not install_offline(staging, requirements_file):
            raise RuntimeError("Offline install failed after rebuilding the wheelhouse")
        verify_static_cryptography_openssl(build_inputs)
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
