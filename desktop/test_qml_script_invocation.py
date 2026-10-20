"""Exercise the production QML script wrapper through its Qt metaobject."""
import os
import unittest
from pathlib import Path

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

from PySide6.QtCore import Q_ARG, QMetaObject, QUrl
from PySide6.QtGui import QGuiApplication
from PySide6.QtQml import QQmlComponent, QQmlEngine


MAIN_QML = Path(__file__).parent / "qml" / "Main.qml"


class QmlScriptInvocationTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.app = QGuiApplication.instance() or QGuiApplication(["QML script invocation tests"])

    def test_one_argument_invokable_runs_javascript_on_reader(self):
        production = MAIN_QML.read_text(encoding="utf-8")
        start = production.index("    function runDocumentScript(script)")
        end = production.index("    function focusReader()", start)
        wrappers = production[start:end]
        self.assertIn("function runDocumentScriptWithCallback(script, callback)", wrappers)
        self.assertIn("window.runDocumentScriptWithCallback(", production)

        engine = QQmlEngine()
        component = QQmlComponent(engine)
        qml = f'''import QtQuick
Item {{
    id: window
    property string executedScript: web.lastScript
    property var reader: web
    QtObject {{
        id: web
        property string lastScript: ""
        function runJavaScript(script, callback) {{ lastScript = script }}
    }}
{wrappers}
}}
'''
        component.setData(qml.encode("utf-8"), QUrl.fromLocalFile(str(MAIN_QML)))
        instance = component.create()
        self.assertIsNotNone(instance, "\n".join(error.toString() for error in component.errors()))
        try:
            self.assertTrue(QMetaObject.invokeMethod(instance, "runDocumentScript", Q_ARG("QVariant", "window.supermdLoad?.(true)")))
            self.assertEqual(instance.property("executedScript"), "window.supermdLoad?.(true)")
        finally:
            instance.deleteLater()
            engine.deleteLater()
            self.app.processEvents()


if __name__ == "__main__":
    unittest.main()
