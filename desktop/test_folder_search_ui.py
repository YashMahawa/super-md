"""Software-rendered QML tests for workspace subfolder filtering and empty states."""
import os
import time
import unittest
from pathlib import Path

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
os.environ.setdefault("QT_QUICK_BACKEND", "software")
from PySide6.QtCore import QEvent, QObject, QUrl
from PySide6.QtGui import QGuiApplication
from PySide6.QtQml import QQmlComponent, QQmlEngine
from PySide6.QtQuickControls2 import QQuickStyle
from PySide6.QtTest import QTest
from studio import Session
from test_studio import QuietStudio


SIDEBAR_HOST_QML = b"""
import QtQuick
import QtQuick.Controls
import QtQuick.Controls.Material
import QtQuick.Layouts

ApplicationWindow {
    id: host
    width: 960
    height: 640
    visible: true
    color: viewState.colors.surface
    property var viewState: JSON.parse(studio.snapshot)
    property string sidebarSection: "folder"
    Material.theme: viewState.dark ? Material.Dark : Material.Light
    Material.primary: viewState.colors.primary
    Material.accent: viewState.colors.primary
    Material.background: viewState.colors.surface
    Material.foreground: viewState.colors.text

    RowLayout {
        anchors.fill: parent
        spacing: 0
        Pane {
            Layout.preferredWidth: 300
            Layout.fillHeight: true
            padding: 16
            background: ThemeSurface { area: "sidebar" }
            ColumnLayout {
                anchors.fill: parent
                spacing: 12
                Label { text: "Your files"; font.pixelSize: 22; font.weight: Font.DemiBold }
                RowLayout {
                    visible: !!viewState.folder
                    Layout.fillWidth: true
                    Label { objectName: "folderHeaderLabel"; text: viewState.folder.split("/").pop(); Layout.fillWidth: true; elide: Text.ElideMiddle }
                    ActionButton { objectName: "closeFolderBtn"; glyph: "X"; compact: true; Accessible.name: "Close folder"; onClicked: studio.closeFolder() }
                }
                TextField {
                    id: filter
                    objectName: "folderFilterField"
                    property string backendFilter: viewState.folderFilter || ""
                    visible: !!viewState.folder
                    Layout.fillWidth: true
                    placeholderText: "Filter files"
                    selectByMouse: true
                    onTextChanged: {
                        if (text !== backendFilter)
                            studio.setFolderFilter(text)
                    }
                    onBackendFilterChanged: {
                        if (backendFilter === "" && text !== "")
                            text = ""
                        else if (!activeFocus && text !== backendFilter)
                            text = backendFilter
                    }
                }
                Item {
                    Layout.fillWidth: true
                    Layout.fillHeight: true
                    ListView {
                        id: folderFilesView
                        objectName: "folderFilesView"
                        anchors.fill: parent
                        visible: viewState.files.length > 0
                        clip: true
                        model: viewState.files
                        delegate: ItemDelegate {
                            required property var modelData
                            objectName: "folderFileDelegate"
                            width: ListView.view.width - 20
                            height: 42
                            leftPadding: 8 + modelData.depth * 16
                            text: (modelData.directory ? (modelData.expanded ? "\\u25be " : "\\u25b8 ") : "") + modelData.name
                            onClicked: modelData.directory ? (!((viewState.folderFilter || "").trim()) && studio.toggleDirectory(modelData.path)) : studio.openNote(modelData.path)
                        }
                        ScrollBar.vertical: ExpressiveScrollBar { }
                    }
                    ColumnLayout {
                        objectName: "folderEmptyState"
                        anchors.centerIn: parent
                        width: parent.width - 16
                        spacing: 4
                        visible: !!viewState.folder && viewState.files.length === 0 && !viewState.folderSearching
                        Label {
                            objectName: "folderEmptyLabel"
                            Layout.fillWidth: true
                            horizontalAlignment: Text.AlignHCenter
                            wrapMode: Text.WordWrap
                            font.weight: Font.Medium
                            color: viewState.colors.text
                            text: (viewState.folderFilter || "").trim().length > 0 ? "No matching notes found" : "No notes in this folder"
                        }
                        Label {
                            visible: (viewState.folderFilter || "").trim().length > 0
                            Layout.fillWidth: true
                            horizontalAlignment: Text.AlignHCenter
                            wrapMode: Text.WordWrap
                            font.pixelSize: 12
                            color: viewState.colors.muted
                            text: "Try another filename or clear the filter."
                        }
                    }
                }
            }
        }
        Rectangle {
            Layout.fillWidth: true
            Layout.fillHeight: true
            color: viewState.colors["surface-low"]
            ColumnLayout {
                anchors.fill: parent
                anchors.margins: 32
                spacing: 12
                Label {
                    text: viewState.name
                    font.pixelSize: 26
                    font.weight: Font.DemiBold
                    color: viewState.colors.text
                }
                Label {
                    text: "Workspace folder: " + (viewState.folder || "None")
                    font.pixelSize: 14
                    color: viewState.colors.muted
                }
                Item { Layout.fillHeight: true }
            }
        }
    }
}
"""


class FolderSearchUiTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if QGuiApplication.instance() is None:
            QQuickStyle.setStyle("Material")
        cls.app = QGuiApplication.instance() or QGuiApplication(["Folder search UI tests"])

    def setUp(self):
        self.session = Session(True)
        self.session.settings.update(theme="dark", accent="blue", motion=False, welcomed=True)
        self.studio = QuietStudio(True, self.session)
        self.workspace = self.studio.data / "StudyVault"
        (self.workspace / "Courses" / "Linear Algebra").mkdir(parents=True)
        (self.workspace / "Courses" / "Linear Algebra" / "1.2 Eigenvalues.md").write_text("# Eigenvalues")
        (self.workspace / "Courses" / "Calculus").mkdir(parents=True)
        (self.workspace / "Courses" / "Calculus" / "Limits.txt").write_text("Limits")
        (self.workspace / "Archive").mkdir(parents=True)
        (self.workspace / "Overview.md").write_text("# Overview")

        self.engine = QQmlEngine()
        self.engine.rootContext().setContextProperty("studio", self.studio)
        self.component = QQmlComponent(self.engine)
        self.component.setData(SIDEBAR_HOST_QML, QUrl.fromLocalFile(str(Path(__file__).parent / "qml/folder-search-test.qml")))
        self.assertFalse(self.component.isError(), str(self.component.errors()))
        self.window = self.component.create()
        self.assertIsNotNone(self.window, str(self.component.errors()))
        QTest.qWait(50)

    def tearDown(self):
        self.window.close()
        self.window.deleteLater()
        self.app.sendPostedEvents(None, QEvent.Type.DeferredDelete)
        self.engine.deleteLater()
        self.app.sendPostedEvents(None, QEvent.Type.DeferredDelete)
        self.studio.stop()
        self.studio.pool.shutdown(wait=True)
        self.studio._search_pool.shutdown(wait=True, cancel_futures=True)
        self.session.writes.shutdown(wait=True)

    def items(self, item=None):
        item = item or self.window.contentItem()
        yield item
        for child in item.childItems():
            yield from self.items(child)

    def named(self, name):
        found = self.window.findChild(QObject, name)
        if found is not None:
            return found
        for item in self.items():
            if item.objectName() == name:
                return item
            found = item.findChild(QObject, name)
            if found is not None:
                return found
        return None

    def wait_until(self, predicate, timeout=3.0):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            self.app.processEvents()
            if predicate():
                return
            QTest.qWait(15)
        self.app.processEvents()
        self.assertTrue(predicate())

    def test_qml_filter_searches_collapsed_subfolders_renders_empty_state_and_clears_on_folder_switch(self):
        self.studio.openFolder(str(self.workspace))
        self.wait_until(lambda: len(self.studio.files) == 2)
        # Empty Archive is hidden by default when hideNonNoteFolders is enabled.
        self.assertEqual([f["name"] for f in self.studio.files], ["Courses", "Overview.md"])

        # Toggling hideNonNoteFolders off shows Archive; toggling back on hides it again.
        self.studio.setting("hideNonNoteFolders", "false")
        self.wait_until(lambda: [f["name"] for f in self.studio.files] == ["Archive", "Courses", "Overview.md"])
        self.studio.setting("hideNonNoteFolders", "true")
        self.wait_until(lambda: [f["name"] for f in self.studio.files] == ["Courses", "Overview.md"])

        filter_field = self.named("folderFilterField")
        empty_state = self.named("folderEmptyState")
        empty_label = self.named("folderEmptyLabel")
        self.assertIsNotNone(filter_field)
        self.assertFalse(empty_state.property("visible"))

        filter_field.setProperty("text", "eigen")
        self.wait_until(
            lambda: not self.studio._folder_searching
            and not self.studio.filter_timer.isActive()
            and any(f["name"] == "1.2 Eigenvalues.md" for f in self.studio.files)
        )
        QTest.qWait(40)
        # Only ancestor folders and the matching file appear; Archive and Calculus are hidden!
        self.assertEqual(
            [(f["name"], f["directory"], f["depth"]) for f in self.studio.files],
            [("Courses", True, 0), ("Linear Algebra", True, 1), ("1.2 Eigenvalues.md", False, 2)],
        )
        self.assertFalse(empty_state.property("visible"))

        screenshot_dir = os.environ.get("SUPERMD_SCREENSHOT_DIR")
        if screenshot_dir:
            Path(screenshot_dir).mkdir(parents=True, exist_ok=True)
            self.window.grabWindow().save(str(Path(screenshot_dir) / "desktop-subfolder-search-match.png"))

        # Zero-match query renders empty state.
        filter_field.setProperty("text", "quantum-nonexistent")
        self.wait_until(
            lambda: not self.studio._folder_searching
            and not self.studio.filter_timer.isActive()
            and self.studio.files == []
        )
        QTest.qWait(40)
        self.assertTrue(empty_state.property("visible"))
        self.assertEqual(empty_label.property("text"), "No matching notes found")

        if screenshot_dir:
            self.window.grabWindow().save(str(Path(screenshot_dir) / "desktop-subfolder-search-empty.png"))

        # Switching to another folder clears the filter field automatically.
        other = self.studio.data / "SecondVault"
        other.mkdir()
        (other / "Fresh.md").write_text("# Fresh")
        self.studio.openFolder(str(other))
        self.wait_until(lambda: [f["name"] for f in self.studio.files] == ["Fresh.md"])
        QTest.qWait(30)
        self.assertEqual(filter_field.property("text"), "")
        self.assertFalse(empty_state.property("visible"))

        # Closing folder also clears an active filter.
        filter_field.setProperty("text", "fresh")
        QTest.qWait(30)
        self.studio.closeFolder()
        QTest.qWait(30)
        self.assertEqual(filter_field.property("text"), "")


if __name__ == "__main__":
    unittest.main()
