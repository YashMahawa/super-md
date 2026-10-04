"""Actual QML geometry: contents on the left, exit on the right, idle hiding."""
import json
import os
import unittest
import xml.etree.ElementTree as ET
from pathlib import Path
os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
from PySide6.QtCore import QObject, Property, QUrl, QEvent, QPointF, QPoint
from PySide6.QtGui import QGuiApplication
from PySide6.QtQml import QQmlEngine, QQmlComponent
from PySide6.QtTest import QTest
from PySide6.QtQuick import QQuickItem

class Palette(QObject):
    @Property(str, constant=True)
    def snapshot(self):
        return json.dumps({"settings":{"motion":False},"colors":{"text":"#201a17","primary":"#8c4b2b","on-primary":"#ffffff","surface-low":"#f8d7c5","surface-high":"#eac1ac","outline":"#88756b"}})
    @Property("QVariantMap", constant=True)
    def palette(self): return json.loads(self.snapshot)["colors"]
    @Property(bool, constant=True)
    def motionEnabled(self): return json.loads(self.snapshot)["settings"]["motion"]

class StudyControlsTest(unittest.TestCase):
    def test_brand_variants_share_the_brush_s_geometry(self):
        root=Path(__file__).resolve().parent.parent/'public'
        geometries=[]
        for name in ('brand-mark.svg','brand-mark-fixed.svg','brand-mark-themed.svg'):
            svg=ET.parse(root/name).getroot()
            geometries.append([path.attrib['d'] for path in svg.findall('{http://www.w3.org/2000/svg}path')])
        self.assertEqual(len(geometries[0]),1)
        self.assertEqual(geometries[0],geometries[1])
        self.assertEqual(geometries[1],geometries[2])

    def test_controls_are_opposite_and_hide_without_movement(self):
        app=QGuiApplication.instance() or QGuiApplication(["Study controls"])
        engine=QQmlEngine();palette=Palette();engine.rootContext().setContextProperty("studio",palette)
        component=QQmlComponent(engine)
        component.setData(b' import QtQuick\nimport QtQuick.Controls\nApplicationWindow {width:900;height:600;visible:true;StudyControls {objectName:"controls";anchors.left:parent.left;anchors.right:parent.right;anchors.top:parent.top}}',QUrl.fromLocalFile(str(Path(__file__).parent/'qml/study-test.qml')))
        self.assertFalse(component.isError(),str(component.errors()));window=component.create()
        try:
            QTest.qWait(20)
            left=window.findChild(QQuickItem,"studyContentsButton");right=window.findChild(QQuickItem,"studyExitButton");controls=window.findChild(QQuickItem,"controls")
            self.assertEqual(controls.property("height"),56)
            left_x=left.mapToScene(QPointF()).x();right_x=right.mapToScene(QPointF()).x()
            self.assertEqual(left_x,12);self.assertEqual(right_x+right.property("width"),888)
            self.assertLess(left_x+left.property("width"),right_x)
            QTest.mouseMove(window,QPoint(450,300));QTest.qWait(20)
            self.assertFalse(controls.property("hovered"))
            controls.setProperty("awake",False);QTest.qWait(10)
            self.assertFalse(left.property("visible"));self.assertFalse(right.property("visible"))
            self.assertEqual(controls.property("height"),56,"Hiding the overlay must not change its geometry")
            QTest.mouseMove(window,QPoint(450,20));QTest.qWait(20)
            self.assertTrue(left.property("visible"),"Hovering the toolbar must reveal its controls")
        finally:
            window.close();window.deleteLater();app.sendPostedEvents(None,QEvent.Type.DeferredDelete);engine.deleteLater();app.sendPostedEvents(None,QEvent.Type.DeferredDelete)
