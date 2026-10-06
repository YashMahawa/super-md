"""Keep the Linux driver ABI owned by the destination distribution."""
from pathlib import PurePosixPath


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
