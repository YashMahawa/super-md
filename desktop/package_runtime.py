"""Keep the Linux driver ABI owned by the destination distribution."""
from pathlib import PurePosixPath

# PyInstaller intentionally omits many /usr/lib libraries. XCB's helper
# libraries are not installed on every desktop (including AppImageHub's Xvfb
# runner), unlike the driver-owned GL/EGL/C++ ABI which must stay on the host.
X11_SUPPORT = ("libxcb-icccm.so.4", "libxcb-keysyms.so.1", "libxcb-image.so.0",
               "libxcb-render-util.so.0", "libxcb-cursor.so.0",
               "libxkbcommon-x11.so.0", "libX11-xcb.so.1",
               "libxcb-randr.so.0", "libxcb-shape.so.0", "libxcb-sync.so.1",
               "libxcb-xfixes.so.0", "libxcb-xkb.so.1", "libxcb-util.so.1",
               "libwayland-client.so.0", "libwayland-cursor.so.0", "libwayland-server.so.0")


def linux_support_binaries(resolve, platform):
    if not platform.startswith("linux"):
        return []
    entries = []
    for name in X11_SUPPORT:
        path = resolve(name)
        if not path:
            raise RuntimeError(f"Missing Linux build dependency: {name}")
        entries.append((path, "."))
    return entries


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
