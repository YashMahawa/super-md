"""Rasterize the vector master, then let Tauri produce OS icon containers.

The shipped Qt and Android apps use the same brush-S geometry. No font or
network request is needed to display this mark.
"""
import os
from pathlib import Path
import subprocess
os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
from PySide6.QtGui import QGuiApplication, QImage, QPainter
from PySide6.QtSvg import QSvgRenderer

root = Path(__file__).resolve().parent.parent
app = QGuiApplication([])
renderer = QSvgRenderer(str(root / "public/brand-mark-fixed.svg"))
if not renderer.isValid():
    raise SystemExit("Invalid brand vector")
image = QImage(1024, 1024, QImage.Format.Format_ARGB32)
image.fill(0)
painter = QPainter(image)
painter.setRenderHint(QPainter.RenderHint.Antialiasing)
renderer.render(painter)
painter.end()
source = root / "src-tauri/icons/icon-source.png"
if not image.save(str(source)):
    raise SystemExit("Could not rasterize brand mark")
subprocess.run(["/usr/bin/npx", "tauri", "icon", str(source)], cwd=root, check=True)
