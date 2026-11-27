"""Rasterize the vector master and generate OS icon containers via Pillow.

The shipped Qt and Android apps use the same brush-S geometry. No font or
network request is needed to display this mark.
"""
import os
from pathlib import Path

from PIL import Image

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
from PySide6.QtGui import QGuiApplication, QImage, QPainter
from PySide6.QtSvg import QSvgRenderer

ICO_SIZES = [(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)]

root = Path(__file__).resolve().parent.parent
app = QGuiApplication.instance() or QGuiApplication([])
renderer = QSvgRenderer(str(root / "public/brand-mark-fixed.svg"))
if not renderer.isValid():
    raise SystemExit("Invalid brand vector")
image = QImage(1024, 1024, QImage.Format.Format_ARGB32)
image.fill(0)
painter = QPainter(image)
painter.setRenderHint(QPainter.RenderHint.Antialiasing)
renderer.render(painter)
painter.end()
brand_dir = root / "desktop/brand"
brand_dir.mkdir(parents=True, exist_ok=True)
source = brand_dir / "icon-source.png"
if not image.save(str(source)):
    raise SystemExit("Could not rasterize brand mark")
with Image.open(source) as master:
    master.save(brand_dir / "icon.ico", format="ICO", sizes=ICO_SIZES)
    master.save(brand_dir / "icon.icns", format="ICNS")
