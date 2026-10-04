"""One-directory distribution: no self-extraction on every application launch."""
import json
import sys
from importlib.metadata import distribution
from pathlib import Path
from PyInstaller.utils.hooks import collect_data_files

root = Path(SPECPATH).parent
engine = root / "smd-core" / "target" / "release" / ("smd-engine.exe" if sys.platform == "win32" else "smd-engine")
if not engine.is_file():
    raise SystemExit("Build the optimized smd-engine first")
version = json.loads((root / "package.json").read_text())["version"]
data = [(str(root / "dist"), "resources/dist"),
        (str(root / "desktop/qml"), "resources/desktop/qml"),
        (str(root / "desktop/icons"), "resources/desktop/icons"),
        (str(root / "public/brand-mark-fixed.svg"), "resources/public"),
        (str(root / "public/brand-mark.svg"), "resources/public"),
        (str(root / "public/third-party-ui-licenses.txt"), "resources/licenses"),
        (str(root / "smd-core/fonts"), "resources/smd-core/fonts"),
        (str(root / "docs/AUTHORING.md"), "resources/docs"),
        (str(root / "desktop/NOTICE.md"), "resources/licenses")]
data.append((str(root / "desktop/licenses"), "resources/licenses/qt"))
data.append((str(root / "desktop/build-info.json"), "resources/desktop"))
for package in ("PySide6", "PySide6_Essentials", "PySide6_Addons", "shiboken6", "numpy", "material-color-utilities"):
    dist = distribution(package)
    for file in dist.files or []:
        if "/licenses/" in str(file) or str(file).endswith(("LICENSE", "LICENSE.txt", "COPYING")):
            data.append((str(dist.locate_file(file)), "resources/licenses/" + package))
if (root / "LICENSE").exists():
    data.append((str(root / "LICENSE"), "resources/licenses"))
data += collect_data_files("PySide6", includes=["**/LICENSE*", "**/COPYING*", "**/licenses/**"])
hidden = ["PySide6.QtWebEngineCore", "PySide6.QtWebChannel", "PySide6.QtNetwork"]
if sys.platform in ("win32", "darwin"):
    # Built-in Python for cells: most people on Windows and macOS have no Python.
    # Ship numpy + matplotlib and the standard library cells commonly import.
    skip = {"tkinter", "turtle", "turtledemo", "idlelib", "test", "lib2to3", "ensurepip", "venv", "pydoc_data",
            "distutils", "msilib", "unittest", "this", "antigravity", "__phello__", "_tkinter", "curses", "_curses"}
    hidden += [name for name in sorted(sys.stdlib_module_names) if name not in skip and not name.startswith("_")]
    hidden += ["numpy", "matplotlib", "matplotlib.pyplot", "matplotlib.backends.backend_agg",
               "matplotlib.backends.backend_svg", "mpl_toolkits.mplot3d"]
    for package in ("matplotlib", "pillow", "contourpy", "cycler", "fonttools", "kiwisolver", "pyparsing", "python-dateutil", "packaging"):
        try:
            dist = distribution(package)
        except Exception:
            continue
        for file in dist.files or []:
            if "/licenses/" in str(file) or str(file).endswith(("LICENSE", "LICENSE.txt", "COPYING")):
                data.append((str(dist.locate_file(file)), "resources/licenses/" + package))
analysis = Analysis([str(root / "desktop/main.py")], pathex=[str(root / "desktop")],
    binaries=[(str(engine), "resources/desktop")], datas=data,
    hiddenimports=hidden,
    excludes=["tkinter", "pytest", "unittest", "PyQt6", "PyQt5"], noarchive=False)
pyz = PYZ(analysis.pure)
exe = EXE(pyz, analysis.scripts, [], exclude_binaries=True, name="super-md",
          debug=False, strip=False, upx=False, console=sys.platform.startswith("linux"),
          icon=str(root / "src-tauri/icons/icon.ico") if sys.platform == "win32" else None)
collection = COLLECT(exe, analysis.binaries, analysis.datas, strip=False, upx=False, name="super-md")
if sys.platform == "darwin":
    app = BUNDLE(collection, name="Super MD.app", icon=str(root / "src-tauri/icons/icon.icns"),
        bundle_identifier="dev.supermd.studio", info_plist={
            "CFBundleShortVersionString": version, "CFBundleVersion": version,
            "NSHumanReadableCopyright": "Copyright © 2026 Yash Mahawar and Super MD contributors. MIT License.",
            "NSHighResolutionCapable": True,
            "CFBundleDocumentTypes": [{"CFBundleTypeName": "Super MD note", "CFBundleTypeRole": "Editor",
                                      "CFBundleTypeExtensions": ["md", "markdown", "smd", "fmd", "txt"], "LSHandlerRank": "Alternate"},
                                     {"CFBundleTypeName": "Folder", "CFBundleTypeRole": "Viewer", "LSItemContentTypes": ["public.folder"]}]})
