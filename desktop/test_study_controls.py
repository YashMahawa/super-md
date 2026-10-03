"""Actual QML geometry: contents on the left, exit on the right, idle hiding."""
import json
import os
import unittest
from pathlib import Path
os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
from PySide6.QtCore import QObject, Property, QUrl, QEvent
from PySide6.QtGui import QGuiApplication
from PySide6.QtQml import QQmlEngine, QQmlComponent
from PySide6.QtTest import QTest

class Palette(QObject):
    @Property(str, constant=True)
    def snapshot(self):
        return json.dumps({"settings":{"motion":False},"colors":{"text":"#201a17","primary":"#8c4b2b","on-primary":"#ffffff","surface-low":"#f8d7c5","surface-high":"#eac1ac","outline":"#88756b"}})

class StudyControlsTest(unittest.TestCase):
    def test_controls_are_opposite_and_hide_without_movement(self):
        app=QGuiApplication.instance() or QGuiApplication(["Study controls"])
        engine=QQmlEngine();palette=Palette();engine.rootContext().setContextProperty("studio",palette)
        component=QQmlComponent(engine)
        component.setData(b' import QtQuick\nimport QtQuick.Controls\nApplicationWindow {width:900;height:600;visible:true;StudyControls {objectName:"controls";anchors.fill:parent}}',QUrl.fromLocalFile(str(Path(__file__).parent/'qml/study-test.qml')))
        self.assertFalse(component.isError(),str(component.errors()));window=component.create()
        try:
            QTest.qWait(20)
            left=window.findChild(QObject,"studyContentsButton");right=window.findChild(QObject,"studyExitButton");controls=window.findChild(QObject,"controls")
            self.assertEqual(left.property("x"),12);self.assertEqual(right.property("x")+right.property("width"),888)
            self.assertLess(left.property("x")+left.property("width"),right.property("x"))
            controls.setProperty("awake",False);QTest.qWait(10)
            self.assertFalse(left.property("visible"));self.assertFalse(right.property("visible"))
        finally:
            window.close();window.deleteLater();app.sendPostedEvents(None,QEvent.Type.DeferredDelete);engine.deleteLater();app.sendPostedEvents(None,QEvent.Type.DeferredDelete)
