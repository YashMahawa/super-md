"""Native toolbar/sidebar SVG art paints without an extra web renderer."""
import base64
import os
import time
import unittest
from pathlib import Path
os.environ.setdefault("QT_QPA_PLATFORM","offscreen")
from PySide6.QtCore import Property,QUrl,QEvent
from PySide6.QtGui import QGuiApplication
from PySide6.QtQml import QQmlEngine,QQmlComponent
from PySide6.QtTest import QTest
from test_choice_field import Palette

class ArtPalette(Palette):
    def __init__(self,uri=None):super().__init__();self.uri=uri
    @Property("QVariantMap",constant=True)
    def palette(self):return {"surface-low":"#000000"}
    @Property("QVariantMap",constant=True)
    def themeArtwork(self):
        svg='<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="100" height="100" fill="#ff0000"/></svg>'
        return {"sidebar":{"image":self.uri or "data:image/svg+xml;base64,"+base64.b64encode(svg.encode()).decode(),"opacity":.1,"fit":"cover"}}

class ThemeSurfaceTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):cls.app=QGuiApplication.instance() or QGuiApplication(["Native artwork test"])
    def test_native_static_svg_is_painted_at_the_requested_opacity(self):
        self.assert_painted()
    def test_native_jpeg_and_webp_pixels_are_not_just_accepted_but_painted(self):
        import json
        fixtures=json.loads((Path(__file__).parent.parent/"test-fixtures/theme-artwork.json").read_text())
        for kind in ("jpeg","webp"):self.assert_painted(fixtures[kind])
    def assert_painted(self,uri=None):
        engine=QQmlEngine();palette=ArtPalette(uri);engine.rootContext().setContextProperty("studio",palette)
        component=QQmlComponent(engine)
        component.setData(b'import QtQuick\nimport QtQuick.Controls\nApplicationWindow {width:300;height:200;visible:true;ThemeSurface {anchors.fill:parent;area:"sidebar"}}',QUrl.fromLocalFile(str(Path(__file__).parent/"qml/theme-art-test.qml")))
        self.assertFalse(component.isError(),str(component.errors()))
        window=component.create();self.assertIsNotNone(window,str(component.errors()))
        try:
            end=time.monotonic()+3;seen=None
            while time.monotonic()<end:
                QTest.qWait(25);image=window.grabWindow()
                if not image.isNull():
                    seen=image.pixelColor(150,100)
                    if 23<=seen.red()<=27 and seen.green()==0 and seen.blue()==0:break
            self.assertIsNotNone(seen)
            self.assertTrue(23<=seen.red()<=27 and seen.green()==0 and seen.blue()==0,f"Native theme art did not paint: {seen.name()}")
        finally:
            window.close();window.deleteLater();self.app.sendPostedEvents(None,QEvent.Type.DeferredDelete)
            engine.deleteLater();self.app.sendPostedEvents(None,QEvent.Type.DeferredDelete)
