"""Actual QML geometry: contents on the left, exit on the right, idle hiding."""
import json
import os
import unittest
import xml.etree.ElementTree as ET
from pathlib import Path
os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
from PySide6.QtCore import QObject, Property, QUrl, QEvent, QPointF, QPoint, Qt, QMetaObject
from PySide6.QtGui import QGuiApplication
from PySide6.QtQml import QQmlEngine, QQmlComponent
from PySide6.QtTest import QTest
from PySide6.QtQuick import QQuickItem

class Palette(QObject):
    @Property(str, constant=True)
    def snapshot(self):
        return json.dumps({"settings":{"motion":False},"colors":{"text":"#201a17","muted":"#69564c","primary":"#8c4b2b","on-primary":"#ffffff","surface-low":"#f8d7c5","surface-high":"#eac1ac","outline":"#88756b"}})
    @Property("QVariantMap", constant=True)
    def palette(self): return {**json.loads(self.snapshot)["colors"],"primary-container":"#e9cab8"}
    @Property(bool, constant=True)
    def motionEnabled(self): return json.loads(self.snapshot)["settings"]["motion"]

class StudyControlsTest(unittest.TestCase):
    def test_reparented_font_search_closes_when_its_owner_dialog_closes(self):
        app=QGuiApplication.instance() or QGuiApplication(["Font popup lifecycle"])
        engine=QQmlEngine();palette=Palette();engine.rootContext().setContextProperty("studio",palette)
        component=QQmlComponent(engine)
        component.setData(b'''import QtQuick
import QtQuick.Controls
ApplicationWindow {width:600;height:500;visible:true
Dialog {id:owner;objectName:"owner";width:400;height:400}
FontField {objectName:"font";ownerPopup:owner;width:280;families:["Manrope","Noto Serif"]}}
''',QUrl.fromLocalFile(str(Path(__file__).parent/'qml/font-owner-test.qml')))
        self.assertFalse(component.isError(),str(component.errors()));window=component.create()
        try:
            owner=window.findChild(QObject,"owner");field=window.findChild(QObject,"font");picker=window.findChild(QObject,"fontPopup")
            QMetaObject.invokeMethod(owner,"open");QTest.qWait(30);QMetaObject.invokeMethod(field,"revealChoices");QTest.qWait(30)
            self.assertTrue(picker.property("visible"))
            QMetaObject.invokeMethod(owner,"close");QTest.qWait(150)
            self.assertFalse(picker.property("visible"));self.assertTrue(field.property("visible"),"Owner lifecycle must work even with an independently visible anchor")
        finally:
            window.close();window.deleteLater();app.sendPostedEvents(None,QEvent.Type.DeferredDelete);engine.deleteLater();app.sendPostedEvents(None,QEvent.Type.DeferredDelete)

    def test_recent_pin_is_small_and_only_shown_after_context_action(self):
        app=QGuiApplication.instance() or QGuiApplication(["Recent controls"])
        engine=QQmlEngine();palette=Palette();engine.rootContext().setContextProperty("studio",palette)
        component=QQmlComponent(engine)
        component.setData(b'''import QtQuick
import QtQuick.Controls
ApplicationWindow {width:320;height:220;visible:true
RecentNotes {objectName:"recent";anchors.fill:parent;model:["/notes/Study.md"];onPinRequested:path=>pinned=pinned.length?[]:[path]}}
''',QUrl.fromLocalFile(str(Path(__file__).parent/'qml/recent-test.qml')))
        self.assertFalse(component.isError(),str(component.errors()));window=component.create()
        try:
            def visual_items(item):
                yield item
                for child in item.childItems():yield from visual_items(child)
            QTest.qWait(30);items=list(visual_items(window.contentItem()))
            entry=next(item for item in items if item.objectName()=="recentNoteEntry");pin=next(item for item in items if item.objectName()=="recentPinnedIndicator")
            self.assertIsNotNone(entry);self.assertFalse(pin.property("visible"));self.assertEqual(pin.property("width"),18)
            self.assertGreaterEqual(pin.property("availableHeight"),16,"Decorative pin must not shrink into button padding")
            QTest.mouseClick(window,Qt.RightButton,Qt.NoModifier,QPoint(100,20));QTest.qWait(30)
            menu=next(x for x in visual_items(window.contentItem()) if x.property("text")=="Pin note")
            position=menu.mapToScene(QPointF(menu.property("width")/2,menu.property("height")/2))
            QTest.mouseClick(window,Qt.LeftButton,Qt.NoModifier,position.toPoint());QTest.qWait(20)
            self.assertTrue(pin.property("visible"));self.assertEqual(entry.property("text"),"Study.md")
        finally:
            window.close();window.deleteLater();app.sendPostedEvents(None,QEvent.Type.DeferredDelete);engine.deleteLater();app.sendPostedEvents(None,QEvent.Type.DeferredDelete)

    def test_brand_variants_share_the_mark_geometry(self):
        root=Path(__file__).resolve().parent.parent/'public'
        geometries=[]
        for name in ('brand-mark.svg','brand-mark-fixed.svg','brand-mark-themed.svg'):
            svg=ET.parse(root/name).getroot()
            geometries.append([path.attrib['d'] for path in svg.findall('{http://www.w3.org/2000/svg}path')])
        self.assertEqual(len(geometries[0]),2)  # the S and the Markdown arrow
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
            left=window.findChild(QQuickItem,"studyContentsButton");right=window.findChild(QQuickItem,"studyExitButton");lock=window.findChild(QQuickItem,"studyCenterLockButton");controls=window.findChild(QQuickItem,"controls")
            self.assertEqual(controls.property("height"),56)
            left_x=left.mapToScene(QPointF()).x();right_x=right.mapToScene(QPointF()).x()
            self.assertEqual(left_x,12);self.assertEqual(lock.mapToScene(QPointF()).x()+lock.property("width"),888)
            self.assertEqual(right_x+right.property("width")+8,lock.mapToScene(QPointF()).x())
            self.assertEqual(lock.property("glyph"),"Lock")
            controls.setProperty("centerLocked",False);self.assertEqual(lock.property("glyph"),"LockOpen")
            self.assertLess(left_x+left.property("width"),right_x)
            QTest.mouseMove(window,QPoint(450,300));QTest.qWait(20)
            self.assertFalse(controls.property("hovered"))
            controls.setProperty("awake",False);QTest.qWait(10)
            self.assertFalse(left.property("visible"));self.assertFalse(right.property("visible"));self.assertFalse(lock.property("visible"))
            self.assertEqual(controls.property("height"),56,"Hiding the overlay must not change its geometry")
            QTest.mouseMove(window,QPoint(450,20));QTest.qWait(20)
            self.assertTrue(left.property("visible"),"Hovering the toolbar must reveal its controls")
        finally:
            window.close();window.deleteLater();app.sendPostedEvents(None,QEvent.Type.DeferredDelete);engine.deleteLater();app.sendPostedEvents(None,QEvent.Type.DeferredDelete)
