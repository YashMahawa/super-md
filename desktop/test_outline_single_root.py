"""Exercise the production contents outline's single-root default expansion."""
import os
import unittest
from pathlib import Path

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
from PySide6.QtCore import Q_ARG, QEvent, QMetaObject, Q_RETURN_ARG, Qt, QUrl
from PySide6.QtGui import QGuiApplication
from PySide6.QtQml import QQmlComponent, QQmlEngine

from test_choice_field import Palette


class OutlineSingleRootTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.app = QGuiApplication.instance() or QGuiApplication(["Outline single-root tests"])

    def setUp(self):
        self.engine = QQmlEngine()
        self.palette = Palette()
        self.engine.rootContext().setContextProperty("studio", self.palette)
        self.component = QQmlComponent(self.engine)
        self.component.setData(b'''import QtQuick
Item {
    id: host
    width: 320; height: 480
    property var headings: []
    property string currentNote: "one"
    property alias expanded: outline.expanded
    property alias scrollPosition: outline.contentY
    function toggleHeading(id) { outline.toggleExpanded(id) }
    function readRows() { return outline.visibleEntries() }
    OutlineList {
        id: outline
        anchors.fill: parent
        entries: host.headings
        noteId: host.currentNote
    }
}
''', QUrl.fromLocalFile(str(Path(__file__).parent / "qml" / "outline-test.qml")))
        self.assertFalse(self.component.isError(), str(self.component.errors()))
        self.window = self.component.create()
        self.assertIsNotNone(self.window, str(self.component.errors()))

    def tearDown(self):
        self.window.deleteLater()
        self.app.sendPostedEvents(None, QEvent.Type.DeferredDelete)
        self.engine.deleteLater()
        self.app.sendPostedEvents(None, QEvent.Type.DeferredDelete)

    def rows(self):
        self.app.processEvents()
        return QMetaObject.invokeMethod(self.window, "readRows", Qt.DirectConnection, Q_RETURN_ARG("QVariant")).toVariant()

    def test_single_root_at_non_one_level_exposes_children_without_expanding_nested_sections(self):
        self.window.setProperty("headings", [
            {"id": "root", "title": "Root", "level": 3, "offset": 0},
            {"id": "section", "title": "Section", "level": 4, "offset": 10},
            {"id": "nested", "title": "Nested", "level": 5, "offset": 20},
            {"id": "another", "title": "Another section", "level": 4, "offset": 30},
        ])
        initial = self.rows()
        self.assertEqual([row["id"] for row in initial], ["root", "section", "another"])
        self.assertEqual([row["depth"] for row in initial], [0, 1, 1])
        self.assertFalse(initial[0]["collapsible"])
        self.assertTrue(initial[1]["collapsible"])
        self.assertFalse(initial[2]["collapsible"])

        self.window.setProperty("expanded", {"section": True})
        self.assertEqual([row["id"] for row in self.rows()], ["root", "section", "nested", "another"])

    def test_one_heading_has_no_empty_disclosure_and_multiple_roots_stay_collapsed(self):
        self.window.setProperty("headings", [{"id": "only", "title": "Only", "level": 4, "offset": 0}])
        only = self.rows()
        self.assertEqual(len(only), 1)
        self.assertFalse(only[0]["children"])
        self.assertFalse(only[0]["collapsible"])

        self.window.setProperty("headings", [
            {"id": "first", "title": "First", "level": 2, "offset": 0},
            {"id": "child", "title": "Child", "level": 3, "offset": 10},
            {"id": "second", "title": "Second", "level": 2, "offset": 20},
        ])
        roots = self.rows()
        self.assertEqual([row["id"] for row in roots], ["first", "second"])
        self.assertEqual([row["collapsible"] for row in roots], [True, False])

    def test_switching_notes_clears_manual_expansion(self):
        self.window.setProperty("headings", [
            {"id": "root", "title": "Root", "level": 2, "offset": 0},
            {"id": "child", "title": "Child", "level": 3, "offset": 10},
            {"id": "nested", "title": "Nested", "level": 4, "offset": 20},
        ])
        self.window.setProperty("expanded", {"child": True})
        self.assertEqual([row["id"] for row in self.rows()], ["root", "child", "nested"])
        self.window.setProperty("currentNote", "two")
        self.assertEqual([row["id"] for row in self.rows()], ["root", "child"])

    def test_expanding_at_a_scrolled_position_does_not_reset_the_outline(self):
        self.window.setProperty("headings", [entry for i in range(80) for entry in (
            {"id": f"section-{i}", "title": f"Section {i}", "level": 1, "offset": i*20},
            {"id": f"child-{i}", "title": "Child", "level": 2, "offset": i*20+10})])
        self.rows()
        self.window.setProperty("scrollPosition", 700.0)
        QMetaObject.invokeMethod(self.window, "toggleHeading", Qt.DirectConnection, Q_ARG("QVariant", "section-16"))
        self.app.processEvents()
        self.assertAlmostEqual(self.window.property("scrollPosition"), 700.0)
        self.window.setProperty("currentNote", "another")
        self.app.processEvents()
        self.assertAlmostEqual(self.window.property("scrollPosition"), 0.0)


if __name__ == "__main__":
    unittest.main()
