"""Keep the Linux driver ABI owned by the destination distribution."""
from pathlib import PurePosixPath


def wayland_dependencies(package_format):
    """Qt links all three Wayland libraries, even when launched through X11."""
    names = ("client", "cursor", "server")
    if package_format == "deb":
        return [f"libwayland-{name}0" for name in names]
    if package_format == "rpm":
        return [f"libwayland-{name}.so.0()(64bit)" for name in names]
    raise ValueError(f"Unknown Linux package format: {package_format}")


def portable_binaries(entries, platform):
    """Do not shadow the host C++/unwind ABI used by newer Mesa/LLVM drivers.

    Qt/Python/application libraries remain bundled. Windows and macOS retain
    their existing runtime packaging. Linux packages declare these host libs.
    https://pyinstaller.org/en/stable/usage.html#making-gnu-linux-apps-forward-compatible
    """
    if not platform.startswith("linux"):
        return list(entries)
    return [entry for entry in entries
            if not PurePosixPath(entry[0]).name.startswith(("libstdc++.so", "libgcc_s.so"))]
