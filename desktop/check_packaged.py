"""Exercise the packaged executable, not the developer's Python environment.

Checks private user-data roots, CLI/math/portable export, presented WebEngine
pixels, and automatic graphics recovery. Never loads or writes a user's notes.
"""
import argparse
import json
import os
from pathlib import Path
import subprocess
import tempfile


def check(executable: Path, version: str, graphics: str) -> None:
    executable = executable.resolve()
    with tempfile.TemporaryDirectory(prefix="supermd-packaged-check-") as folder:
        root = Path(folder)
        env = dict(os.environ, XDG_CONFIG_HOME=str(root / "config"),
                   XDG_DATA_HOME=str(root / "data"), XDG_CACHE_HOME=str(root / "cache"),
                   APPIMAGE_EXTRACT_AND_RUN="1")
        env.pop("PYTHONPATH", None)
        env.pop("PYTHONHOME", None)
        for name in ("QT_QUICK_BACKEND", "QSG_RHI_BACKEND", "QTWEBENGINE_CHROMIUM_FLAGS"):
            env.pop(name, None)
        if graphics == "missing-wayland-egl":
            env["QT_QPA_PLATFORM"] = "wayland"
            env["QT_WAYLAND_CLIENT_BUFFER_INTEGRATION"] = "missing-supermd-egl"

        def run(*args, timeout=180):
            result = subprocess.run([str(executable), *map(str,args)], env=env,
                                    capture_output=True, text=True, timeout=timeout)
            if result.returncode:
                raise RuntimeError(f"Packaged command failed ({result.returncode}): {args}\n{result.stdout}\n{result.stderr}")
            return result

        identity = run("--version")
        # Windowed Windows builds may have no stdout. GUI/report and CLI outputs
        # below remain mandatory; they cannot succeed by merely exiting early.
        if identity.stdout.strip() and f"Super MD {version}" not in identity.stdout:
            raise RuntimeError(f"Unexpected packaged version: {identity.stdout}")
        run("doctor")
        note = root / "Fresh machine.md"
        (root / "figure.svg").write_text('<svg xmlns="http://www.w3.org/2000/svg" width="80" height="40" viewBox="0 0 80 40"><rect width="80" height="40" fill="#3476ad"/></svg>',encoding='utf-8')
        note.write_text("# Fresh machine\n\nMath: $E=mc^2$.\n\n"
                        "> [!tip] Portable\n> A local check.\n\n"
                        "| Name | Value |\n|---|---|\n| x | $x^2$ |\n\n![Embedded figure](figure.svg)\n", encoding="utf-8")
        portable, pdf = root / "Fresh machine.smd", root / "Fresh machine.pdf"
        run("pack", note, portable)
        packed = json.loads(portable.read_text(encoding="utf-8"))
        if packed["format"] != "supermd-smd" or len(packed["assets"]) != 1:
            raise RuntimeError("Portable CLI did not produce a valid note")
        run("export", portable, pdf)
        if not pdf.read_bytes().startswith(b"%PDF-") or pdf.stat().st_size < 10000:
            raise RuntimeError("Packaged native math/PDF engine failed")
        report = root / "presented.json"
        args = ["--test-state", "--smoke", "--smoke-report", str(report), "--quit-after", "40000"]
        if graphics == "software":
            args.append("--safe-graphics")
        result = run(*args, timeout=60)
        if not report.exists():
            raise RuntimeError(f"No presented-pixel evidence from packaged app\n{result.stdout}\n{result.stderr}")
        evidence = json.loads(report.read_text(encoding="utf-8"))
        if not evidence.get("ok") or evidence.get("readerColors",0) <= 20:
            raise RuntimeError(f"Document did not paint: {evidence}")
        if graphics != "auto" and evidence.get("software") is not True:
            raise RuntimeError("Required graphics fallback was not selected")
        print(json.dumps({"executable":str(executable),"version":version,"graphics":graphics,
                          "readerColors":evidence['readerColors'],"pdfBytes":pdf.stat().st_size}))


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("executable",type=Path)
    parser.add_argument("version")
    parser.add_argument("--graphics",choices=("auto","software","missing-wayland-egl"),default="software")
    args = parser.parse_args()
    check(args.executable,args.version,args.graphics)
