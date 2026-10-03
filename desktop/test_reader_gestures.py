import json
import os
import unittest
os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
from PySide6.QtCore import QPointF, Qt
from PySide6.QtGui import QGuiApplication, QNativeGestureEvent, QPointingDevice
from PySide6.QtQuick import QQuickWindow, QQuickItem
from reader_gestures import ReaderGestures

class ReaderGesturesTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls): cls.app=QGuiApplication.instance() or QGuiApplication(["Native pinch tests"])
    def test_pinch_routes_local_document_coordinates_before_browser_zoom(self):
        window=QQuickWindow();window.resize(900,600)
        reader=QQuickItem(window.contentItem());reader.setPosition(QPointF(260,130));reader.setSize(window.size());reader.setWidth(640);reader.setHeight(470)
        scripts=[];router=ReaderGestures(window,reader,scripts.append)
        def event(point,kind=Qt.NativeGestureType.ZoomNativeGesture):
            return QNativeGestureEvent(kind,QPointingDevice.primaryPointingDevice(),2,point,point,point,.1,QPointF())
        try:
            pinch=event(QPointF(460,330));self.assertTrue(router.eventFilter(window,pinch));self.assertTrue(pinch.isAccepted())
            self.assertIn('"x": 200.0, "y": 200.0',scripts[-1]);self.assertIn(',true)',scripts[-1])
            self.assertFalse(router.eventFilter(window,event(QPointF(20,20))))
            self.assertFalse(router.eventFilter(window,event(QPointF(460,330),Qt.NativeGestureType.RotateNativeGesture)))
            self.assertEqual(len(scripts),1)
        finally:
            window.removeEventFilter(router);window.close()
