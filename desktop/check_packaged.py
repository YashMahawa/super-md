"""Exercise the packaged executable, not the developer's Python environment.

Checks private user-data roots, CLI/math/portable export, presented WebEngine
pixels, and automatic graphics recovery. Never loads or writes a user's notes.
"""
import argparse
import base64
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
        # CI Python's compiled OpenSSL paths may not exist on the destination
        # machine. Exercise the frozen interpreter with those paths unavailable,
        # not the developer's Python or a runner's conveniently installed roots.
        tls_output = root / "tls-result.json"
        saved_env = env.copy()
        try:
            env["SSL_CERT_FILE"] = str(root / "absent-host-ca.pem")
            env["SSL_CERT_DIR"] = str(root / "absent-host-ca-directory")
            run("--tls-probe", tls_output, timeout=30)
        finally:
            env.clear()
            env.update(saved_env)
        tls_evidence = json.loads(tls_output.read_text(encoding="utf-8"))
        if not tls_evidence.get("checkHostname") or not tls_evidence.get("verifyRequired") or tls_evidence.get("x509_ca",0) <= 20:
            raise RuntimeError(f"Packaged verified TLS trust store failed: {tls_evidence}")
        run("doctor")
        note = root / "Fresh machine.md"
        (root / "figure.svg").write_text('<svg xmlns="http://www.w3.org/2000/svg" width="80" height="40" viewBox="0 0 80 40"><rect width="80" height="40" fill="#3476ad"/></svg>',encoding='utf-8')
        note.write_text("# Fresh machine\n\nMath: $E=mc^2$.\n\n"
                        "Native symbols: $x\\circledast_N h$, $\\oplus\\otimes\\partial\\hbar$; "
                        "literal $\\text{ast.circle}$.\n\n"
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
        theme=root/"Smoke theme.json"
        theme.write_text(json.dumps({"format":"supermd-theme","version":1,"name":"Packaged theme check","accent":"violet","variants":{"light":{"colors":{},"background":{"pattern":"dots","color":"#7255a5","opacity":.05,"spacing":24}}},"metrics":{"headingWeight":800,"controlRadius":16}}),encoding="utf-8")
        theme_data=json.loads(theme.read_text(encoding="utf-8"))
        art='<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 300"><circle cx="280" cy="90" r="65" fill="#665599"/><path d="M0 250L250 0" stroke="#aa6677" stroke-width="4"/></svg>'
        theme_data["variants"]["light"]["artwork"]={"reader":{"image":"data:image/svg+xml;base64,"+base64.b64encode(art.encode()).decode(),"opacity":.08,"fit":"cover"}}
        theme.write_text(json.dumps(theme_data),encoding="utf-8")
        args = ["--test-state", "--smoke", "--smoke-theme",str(theme),"--smoke-report", str(report), "--quit-after", "40000"]
        if graphics == "software":
            args.append("--safe-graphics")
        result = run(*args, timeout=60)
        if not report.exists():
            raise RuntimeError(f"No presented-pixel evidence from packaged app\n{result.stdout}\n{result.stderr}")
        evidence = json.loads(report.read_text(encoding="utf-8"))
        if not evidence.get("ok") or evidence.get("readerColors",0) <= 20:
            raise RuntimeError(f"Document did not paint: {evidence}")
        if evidence.get("theme")!="Packaged theme check":raise RuntimeError("Packaged custom-theme validator or native/reader bridge failed")
        if '"themeArt":true' not in evidence.get("content",""):raise RuntimeError("Packaged embedded theme artwork did not reach the reader")
        if graphics != "auto" and evidence.get("software") is not True:
            raise RuntimeError("Required graphics fallback was not selected")
        print(json.dumps({"executable":str(executable),"version":version,"graphics":graphics,
                          "software":evidence.get("software"),
                          "readerColors":evidence['readerColors'],"pdfBytes":pdf.stat().st_size,
                          "trustedCAsWithoutHostPaths":tls_evidence['x509_ca']}))


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("executable",type=Path)
    parser.add_argument("version")
    parser.add_argument("--graphics",choices=("auto","software","missing-wayland-egl"),default="software")
    args = parser.parse_args()
    check(args.executable,args.version,args.graphics)
