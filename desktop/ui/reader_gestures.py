"""Route native pinch before Chromium can briefly zoom the browser surface."""
import json
import math
from PySide6.QtCore import QObject, QEvent, Qt

class ReaderGestures(QObject):
    def __init__(self, window, reader, send):
        super().__init__(window)
        self.reader, self.send = reader, send
        window.installEventFilter(self)

    def eventFilter(self, watched, event):
        if event.type() != QEvent.Type.NativeGesture or event.gestureType() != Qt.NativeGestureType.ZoomNativeGesture:
            return False
        point = self.reader.mapFromScene(event.position())
        if not (0 <= point.x() <= self.reader.width() and 0 <= point.y() <= self.reader.height()):
            return False
        factor = 1 + event.value()
        if not math.isfinite(factor) or factor <= 0:
            return False
        # Use the same independently hit-tested plot/image/document path as
        # Ctrl+wheel. The local point excludes the caption and toolbar offsets.
        focus = json.dumps({"x":point.x(), "y":point.y()})
        self.send(f"window.supermdNativeWheel?.(0,{-math.log(factor)/.002},{focus},true)")
        event.accept()
        return True
