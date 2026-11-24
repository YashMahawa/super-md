"""Python cell runtimes: the bundled interpreter, detected environments and app-managed setup.

Nothing here runs on open or export. Cells run only after an explicit Run, and
local Python is trusted user code, not a sandbox.
"""
from __future__ import annotations
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

BUNDLED = "bundled"
CELL_FLAG = "--python-cell"
MAX_CODE = 200_000
MAX_FIGURES = 16
MAX_FIGURE_BYTES = 8_000_000
NAME = re.compile(r"^python(\d+(\.\d+)?)?w?(\.exe)?$", re.IGNORECASE)
CELL_FILENAME = "<Super MD cell>"

# Runs inside the chosen interpreter. Communicates through files, not stdio,
# because windowed (no console) builds have no usable standard streams.
RUNNER = r'''
import sys, json, io, base64, contextlib, traceback
source_path, result_path = sys.argv[-2], sys.argv[-1]
with open(source_path, encoding="utf-8") as handle:
    payload = json.load(handle)
out = io.StringIO(); err = io.StringIO(); images = []; ok = True; plt = None
try:
    try:
        import matplotlib
        matplotlib.use("Agg")
        import matplotlib.pyplot as plt
    except ImportError:
        plt = None
    with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
        exec(compile(payload["code"], "<Super MD cell>", "exec"), {"__name__": "__main__"})
    if plt is not None:
        for number in plt.get_fignums()[:16]:
            data = io.BytesIO()
            plt.figure(number).savefig(data, format="svg", bbox_inches="tight")
            if data.tell() <= 8000000:
                images.append("data:image/svg+xml;base64," + base64.b64encode(data.getvalue()).decode())
except BaseException as error:
    ok = False
    frames = [frame for frame in traceback.extract_tb(error.__traceback__) if frame.filename == "<Super MD cell>"]
    lines = payload["code"].splitlines()
    for frame in frames:
        text = lines[frame.lineno - 1].strip() if frame.lineno and frame.lineno <= len(lines) else ""
        err.write(f"Line {frame.lineno}" + (f": {text}" if text else "") + "\n")
    if isinstance(error, ModuleNotFoundError) and error.name in ("matplotlib", "numpy"):
        err.write(f"{error.name} is not installed for this Python. Choose another interpreter or set one up in Settings > Python.\n")
    else:
        err.write("".join(traceback.format_exception_only(type(error), error)))
finally:
    if plt is not None:
        try: plt.close("all")
        except Exception: pass
with open(result_path, "w", encoding="utf-8") as handle:
    json.dump({"stdout": out.getvalue()[:200000], "stderr": err.getvalue()[:200000], "images": images, "ok": ok}, handle)
'''

PROBE = ("import sys,json,importlib.util as u;print(json.dumps({'version':'%d.%d.%d'%sys.version_info[:3],"
         "'prefix':sys.prefix,'venv':sys.prefix!=getattr(sys,'base_prefix',sys.prefix),"
         "'matplotlib':u.find_spec('matplotlib') is not None,'numpy':u.find_spec('numpy') is not None,"
         "'venvModule':u.find_spec('venv') is not None and u.find_spec('ensurepip') is not None}))")

def frozen() -> bool:
    return bool(getattr(sys, "frozen", False))

def bundled_available() -> bool:
    """Windows and macOS installers ship numpy and matplotlib inside the app."""
    if not frozen():
        return False
    import importlib.util
    return importlib.util.find_spec("matplotlib") is not None

def _no_window() -> dict:
    return {"creationflags": subprocess.CREATE_NO_WINDOW} if sys.platform == "win32" else {}

def clean_environment() -> dict:
    environment = os.environ.copy()
    for key in ("PYTHONHOME", "PYTHONPATH", "PYTHONSTARTUP", "PYTHONINSPECT"):
        environment.pop(key, None)
    if frozen() and sys.platform.startswith("linux"):
        # An external interpreter must not load our embedded Python/Qt libraries.
        if "LD_LIBRARY_PATH_ORIG" in environment:
            environment["LD_LIBRARY_PATH"] = environment["LD_LIBRARY_PATH_ORIG"]
        else:
            environment.pop("LD_LIBRARY_PATH", None)
    environment["PYTHONIOENCODING"] = "utf-8"
    environment["MPLBACKEND"] = "Agg"
    return environment

def validate(executable: str) -> str:
    """Accept only the bundled runtime or an existing executable named like Python."""
    if executable == BUNDLED:
        if not bundled_available():
            raise ValueError("This build has no bundled Python. Choose an interpreter in Settings > Python.")
        return executable
    if not executable:
        raise ValueError("Choose a Python interpreter in Settings > Python first.")
    path = Path(executable).expanduser()
    if not path.is_absolute():
        found = shutil.which(executable)
        if not found:
            raise ValueError(f"Python interpreter not found: {executable}")
        path = Path(found)
    if not NAME.match(path.name):
        raise ValueError("The interpreter must be a Python executable (python, python3 or python.exe)")
    if not path.is_file() or not os.access(path, os.X_OK):
        raise ValueError(f"Python interpreter not found: {path}")
    return str(path)

def _command(executable: str) -> list[str]:
    if executable == BUNDLED:
        return [sys.executable, CELL_FLAG]
    return [executable, "-c", RUNNER]

def run(executable: str, code: str, timeout: int = 90, cwd: str | None = None) -> dict:
    if not isinstance(code, str) or len(code) > MAX_CODE:
        raise ValueError("Python cell exceeds 200 KB")
    executable = validate(executable)
    with tempfile.TemporaryDirectory(prefix="supermd-cell-") as folder:
        source, result = Path(folder) / "cell.json", Path(folder) / "result.json"
        source.write_text(json.dumps({"code": code}), encoding="utf-8")
        try:
            process = subprocess.run([*_command(executable), str(source), str(result)], capture_output=True, text=True,
                                     encoding="utf-8", errors="replace", timeout=timeout, env=clean_environment(),
                                     cwd=cwd if cwd and Path(cwd).is_dir() else folder, stdin=subprocess.DEVNULL, **_no_window())
        except subprocess.TimeoutExpired:
            raise ValueError(f"Python cell stopped after {timeout} seconds") from None
        if not result.is_file():
            raise ValueError((process.stderr or "Python exited without a result").strip()[-2000:])
        output = json.loads(result.read_text(encoding="utf-8"))
    output["images"] = [image for image in output.get("images", [])[:MAX_FIGURES]
                        if isinstance(image, str) and image.startswith("data:image/svg+xml;base64,") and len(image) <= MAX_FIGURE_BYTES * 4 // 3 + 64]
    return output

def run_bundled_cell(argv: list[str]) -> int:
    """Entry point for `super-md --python-cell source result` inside the frozen app."""
    if len(argv) < 2:
        return 2
    sys.argv = [sys.argv[0], argv[-2], argv[-1]]
    exec(compile(RUNNER, "<Super MD runner>", "exec"), {"__name__": "__supermd_runner__"})
    return 0

def probe(executable: str, timeout: float = 6) -> dict | None:
    try:
        process = subprocess.run([executable, "-c", PROBE], capture_output=True, text=True, timeout=timeout,
                                 env=clean_environment(), stdin=subprocess.DEVNULL, **_no_window())
        if process.returncode:
            return None
        return json.loads(process.stdout.strip().splitlines()[-1])
    except (OSError, ValueError, IndexError, subprocess.SubprocessError):
        return None

def _bin(prefix: Path) -> list[Path]:
    return [prefix / "Scripts" / "python.exe", prefix / "python.exe"] if sys.platform == "win32" else [prefix / "bin" / "python3", prefix / "bin" / "python"]

def candidates(managed: Path, folders: list[str] = ()) -> list[Path]:
    home = Path.home()
    found: list[Path] = []
    def add_prefix(prefix: Path):
        for path in _bin(prefix):
            found.append(path)
    add_prefix(managed)
    for variable in ("VIRTUAL_ENV", "CONDA_PREFIX"):
        if os.environ.get(variable):
            add_prefix(Path(os.environ[variable]))
    for folder in folders:
        current = Path(folder)
        for _ in range(4):
            for name in (".venv", "venv", "env", ".env"):
                add_prefix(current / name)
            if current.parent == current:
                break
            current = current.parent
    for name in (".venv", "venv", ".virtualenvs", ".local/share/virtualenvs", "envs", ".pyenv/versions"):
        base = home / name
        add_prefix(base)
        if base.is_dir() and name not in (".venv", "venv"):
            try:
                for child in sorted(base.iterdir())[:40]:
                    add_prefix(child)
            except OSError:
                pass
    for name in ("miniconda3", "anaconda3", "miniforge3", "mambaforge", "micromamba", ".conda"):
        base = home / name
        add_prefix(base)
        try:
            for child in sorted((base / "envs").iterdir())[:40]:
                add_prefix(child)
        except OSError:
            pass
    if sys.platform == "win32":
        local = Path(os.environ.get("LOCALAPPDATA", home / "AppData/Local")) / "Programs/Python"
        try:
            found += [child / "python.exe" for child in sorted(local.iterdir(), reverse=True)]
        except OSError:
            pass
    else:
        found += [Path("/opt/homebrew/bin/python3"), Path("/usr/local/bin/python3")]
    for name in ("python3", "python", *(f"python3.{minor}" for minor in range(16, 8, -1))):
        located = shutil.which(name)
        if located:
            found.append(Path(located))
    if not frozen():
        found.append(Path(sys.executable))
    unique, seen = [], set()
    for path in found:
        sibling = Path(str(path).replace("/sbin/", "/bin/"))
        if sibling != path and sibling.is_file():
            path = sibling  # Merged-/usr systems list python under sbin first on PATH.
        key = os.path.normcase(os.path.abspath(path))
        if key not in seen and path.is_file() and NAME.match(path.name):
            seen.add(key)
            unique.append(path)
    return unique

def discover(managed: Path, folders: list[str] = ()) -> list[dict]:
    """Detected interpreters, best first: managed env, environments with matplotlib, then the rest."""
    results, prefixes = [], set()
    if bundled_available():
        results.append({"path": BUNDLED, "label": "Built-in Python", "detail": "Included with Super MD: numpy and matplotlib", "matplotlib": True, "managed": False, "venv": False})
    import concurrent.futures
    paths = candidates(managed, folders)
    with concurrent.futures.ThreadPoolExecutor(max_workers=6) as pool:
        infos = list(pool.map(probe, map(str, paths)))
    for path, info in zip(paths, infos):
        if not info:
            continue
        key = (os.path.normcase(info["prefix"]), os.path.normcase(os.path.realpath(path)))
        if key in prefixes:
            continue
        prefixes.add(key)
        is_managed = Path(info["prefix"]).resolve() == managed.resolve() if managed.exists() else False
        kind = "Super MD environment" if is_managed else ("Virtual environment" if info["venv"] else "System Python")
        ready = info["matplotlib"] and info["numpy"]
        missing = [name for name in ("numpy", "matplotlib") if not info[name]]
        packages = "numpy + matplotlib ready" if ready else "needs " + " + ".join(missing)
        location = str(Path(info["prefix"]).name if info["venv"] or is_managed else path)
        results.append({"path": str(path), "label": f"{kind} {info['version']}", "detail": f"{location} · {packages}",
                        "matplotlib": ready, "managed": is_managed, "venv": bool(info["venv"]) or is_managed, "venvModule": info.get("venvModule", False)})
    results.sort(key=lambda item: (item["path"] != BUNDLED, not item["managed"], not item["matplotlib"]))
    return results

def preferred(managed: Path) -> str:
    if bundled_available():
        return BUNDLED
    for item in discover(managed):
        if item["matplotlib"]:
            return item["path"]
    if not frozen():
        return sys.executable
    return shutil.which("python3") or shutil.which("python") or ""

def setup_environment(managed: Path, report=lambda text: None) -> str:
    """Create an app-owned virtual environment and install numpy + matplotlib into it."""
    bases = [item for item in discover(managed) if item["path"] != BUNDLED and not item["managed"] and item.get("venvModule")]
    if not bases:
        if sys.platform.startswith("linux"):
            raise ValueError("No Python with venv support was found. Install python3 and python3-venv (Debian/Ubuntu) or python (Arch/Fedora), then try again.")
        raise ValueError("No Python 3 installation was found. Install Python from python.org, then try again.")
    base = bases[0]["path"]
    report("Creating a private Python environment")
    if managed.exists():
        shutil.rmtree(managed, ignore_errors=True)
    managed.parent.mkdir(parents=True, exist_ok=True)
    created = subprocess.run([base, "-m", "venv", str(managed)], capture_output=True, text=True, timeout=180,
                             env=clean_environment(), stdin=subprocess.DEVNULL, **_no_window())
    if created.returncode:
        hint = " Install your distribution's python3-venv package and try again." if "ensurepip" in created.stderr else ""
        raise ValueError((created.stderr.strip().splitlines() or ["Could not create the environment"])[-1] + hint)
    python = next((path for path in _bin(managed) if path.is_file()), None)
    if python is None:
        raise ValueError("The new environment has no Python executable")
    report("Installing numpy and matplotlib (needs internet)")
    installed = subprocess.run([str(python), "-m", "pip", "install", "--disable-pip-version-check", "--no-input", "numpy", "matplotlib"],
                               capture_output=True, text=True, timeout=900, env=clean_environment(), stdin=subprocess.DEVNULL, **_no_window())
    if installed.returncode:
        raise ValueError("pip could not install matplotlib: " + ((installed.stderr.strip().splitlines() or ["check your internet connection"])[-1]))
    return str(python)

def install_packages(executable: str, report=lambda text: None) -> str:
    """Install numpy + matplotlib into an existing virtual environment."""
    executable = validate(executable)
    if executable == BUNDLED:
        return executable
    info = probe(executable)
    if not info:
        raise ValueError("This Python could not be started")
    if not info["venv"]:
        raise ValueError("System Python is managed by your OS. Use Set up Python for a private environment, or install python-numpy and python-matplotlib with your package manager.")
    report("Installing numpy and matplotlib (needs internet)")
    installed = subprocess.run([executable, "-m", "pip", "install", "--disable-pip-version-check", "--no-input", "numpy", "matplotlib"],
                               capture_output=True, text=True, timeout=900, env=clean_environment(), stdin=subprocess.DEVNULL, **_no_window())
    if installed.returncode:
        raise ValueError("pip could not install numpy and matplotlib: " + ((installed.stderr.strip().splitlines() or ["check your internet connection"])[-1]))
    return executable
