"""760px Desktop conflict banner, background tab indicator, active-tab reveal, and reload recovery."""
import json
import os
import shutil
import tempfile
import textwrap
import time
import unittest
from pathlib import Path

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
from PySide6.QtCore import QEvent, QObject, QPointF, Qt, QUrl
from PySide6.QtGui import QGuiApplication
from PySide6.QtQml import QQmlComponent, QQmlEngine
from PySide6.QtQuick import QQuickItem
from PySide6.QtQuickControls2 import QQuickStyle
from PySide6.QtTest import QTest

from documents import open_note, write_portable
from studio import Session
from test_studio import QuietStudio


class ConflictPresentationDesktopTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if QGuiApplication.instance() is None:
            QQuickStyle.setStyle("Material")
        cls.app = QGuiApplication.instance() or QGuiApplication(["Conflict presentation 760px tests"])

    def setUp(self):
        self.temp_dir = Path(tempfile.mkdtemp(prefix="supermd-conflict-ui-760-"))
        self.session = Session(True)
        self.session.settings.update(theme="dark", accent="sky", motion=False, welcomed=True)
        self.studio = QuietStudio(True, self.session)
        self.engine = QQmlEngine()
        self.engine.rootContext().setContextProperty("studio", self.studio)
        self.window = self._create_760_window()

    def tearDown(self):
        if self.window is not None:
            self.window.close()
            self.window.deleteLater()
            self.app.sendPostedEvents(None, QEvent.Type.DeferredDelete)
        if getattr(self, "component", None) is not None:
            self.component.deleteLater()
            self.app.sendPostedEvents(None, QEvent.Type.DeferredDelete)
        self.engine.deleteLater()
        self.app.sendPostedEvents(None, QEvent.Type.DeferredDelete)
        self.studio.stop()
        self.studio.pool.shutdown(wait=True)
        self.studio._search_pool.shutdown(wait=True, cancel_futures=True)
        self.session.writes.shutdown(wait=True)
        shutil.rmtree(self.temp_dir, ignore_errors=True)

    def _create_760_window(self):
        qml_path = Path(__file__).parent / "qml/Main.qml"
        qml = qml_path.read_text(encoding="utf-8")
        banner_start = qml.index("                Pane {\n                    id: conflictBanner")
        banner_end = qml.index("                Loader {\n                    id: readerLoader", banner_start)
        banner_code = textwrap.dedent(qml[banner_start:banner_end]).rstrip()

        dialog_start = qml.index("    AppDialog {\n        id: saveConflictDialog")
        dialog_end = qml.index("    AppDialog {\n        id: flushDialog", dialog_start)
        dialog_code = textwrap.dedent(qml[dialog_start:dialog_end]).rstrip()

        harness = ("""
import QtQuick
import QtQuick.Controls
import QtQuick.Controls.Material
import QtQuick.Layouts

ApplicationWindow {
    id: window
    width: 760
    height: 560
    minimumWidth: 760
    minimumHeight: 520
    visible: true
    color: viewState.colors.surface
    property var viewState: JSON.parse(studio.snapshot)
    property var sidebarState: JSON.parse(studio.sidebarSnapshot)
    property var shortcutLabels: ({})
    property bool sidebar: true
    property string sidebarSection: "folder"
    property int contextMenuCount: 0
    property int modalDialogCount: 0
    QtObject { id: studyToolbar; property bool visible: false; property bool shown: false; property real height: 56 }
    Material.theme: viewState.dark ? Material.Dark : Material.Light
    Material.primary: viewState.colors.primary
    Material.accent: viewState.colors.primary
    Material.background: viewState.colors.surface
    Material.foreground: viewState.colors.text

    Connections {
        target: studio
        function onChanged() { window.viewState = JSON.parse(studio.snapshot) }
        function onSidebarChanged() { window.sidebarState = JSON.parse(studio.sidebarSnapshot) }
        function onSaveConflictRequested(noteName) {
            saveConflictDialog.title = (noteName || viewState.name) + " changed on disk"
            saveConflictDialog.open()
        }
    }

    function modeChoices(wide) {
        return wide
            ? [{key:"wysiwyg",label:"Live"},{key:"source",label:"Source"},{key:"reader",label:"Read"},{key:"split",label:"Split"}]
            : [{key:"wysiwyg",label:"Live"},{key:"source",label:"Source"},{key:"reader",label:"Read"}]
    }

    header: Column {
        visible: !viewState.fullscreen
        width: parent.width
        ToolBar {
            width: parent.width
            height: 52
            leftPadding: 12
            rightPadding: 12
            background: Rectangle {
                color: viewState.colors["surface-low"]
                Rectangle { anchors.bottom: parent.bottom; width: parent.width; height: 1; color: viewState.colors.outline; opacity: .55 }
            }
            RowLayout {
                anchors.fill: parent
                spacing: 6
                ActionButton { glyph: "SidebarSimple"; compact: true; tonal: window.sidebar; ToolTip.text: "Toggle sidebar"; onClicked: window.sidebar = !window.sidebar }
                ActionButton { glyph: "FolderOpen"; compact: true; text: "Open"; onClicked: {} }
                ActionButton { glyph: "FloppyDisk"; compact: true; ToolTip.text: "Save"; onClicked: studio.save() }
                Item { Layout.fillWidth: true }
                Label { text: viewState.name; color: viewState.colors.muted; font.pixelSize: 13; elide: Text.ElideRight; Layout.maximumWidth: 240 }
                ActionButton { glyph: "MagnifyingGlass"; compact: true; ToolTip.text: "Find"; onClicked: {} }
                ActionButton { glyph: "Export"; compact: true; prominent: true; ToolTip.text: "Export"; onClicked: {} }
                ActionButton { glyph: "GearSix"; compact: true; ToolTip.text: "Settings"; onClicked: {} }
            }
        }
        TabStrip {
            width: parent.width
            viewState: window.viewState
            shortcutLabels: window.shortcutLabels
        }
        Rectangle { width: parent.width; height: 1; color: viewState.colors.outline; opacity: .55 }
    }

    SplitView {
        anchors.fill: parent
        orientation: Qt.Horizontal
        handle: Rectangle {
            implicitWidth: 6
            color: window.viewState.colors["surface-low"]
            Rectangle { anchors.horizontalCenter: parent.horizontalCenter; width: 1; height: parent.height; color: window.viewState.colors.outline }
        }
        Pane {
            objectName: "sidebarPane"
            visible: window.sidebar && !viewState.fullscreen
            SplitView.preferredWidth: 260
            SplitView.minimumWidth: 200
            SplitView.maximumWidth: 500
            padding: 16
            background: Rectangle { color: viewState.colors["surface-low"] }
            ColumnLayout {
                anchors.fill: parent
                spacing: 12
                Label { text: "Your files"; font.pixelSize: 20; font.weight: Font.DemiBold; color: viewState.colors.text }
                ModeGroup { Layout.fillWidth: true; choices: [{key:"folder",label:"Folder"},{key:"contents",label:"Contents"}]; selected: window.sidebarSection; onChosen: key => window.sidebarSection = key }
                Label { text: "LectureNotes"; font.pixelSize: 13; font.weight: Font.Medium; color: viewState.colors.muted }
                Repeater {
                    model: ["01_Eigenvalues.md", "02_SVD_Notes.md", "03_Spectral_Theorem.md", "04_Cholesky.smd"]
                    delegate: Label {
                        required property string modelData
                        text: modelData
                        font.pixelSize: 13
                        color: modelData === viewState.name ? viewState.colors.primary : viewState.colors.text
                        elide: Text.ElideRight
                        Layout.fillWidth: true
                    }
                }
                Item { Layout.fillHeight: true }
            }
        }
        Item {
            SplitView.fillWidth: true
            ColumnLayout {
                anchors.fill: parent
                spacing: 0
                Pane {
                    objectName: "modeToolbarPane"
                    Layout.fillWidth: true
                    padding: 10
                    background: Rectangle {
                        color: viewState.colors.surface
                        Rectangle { anchors.bottom: parent.bottom; width: parent.width; height: 1; color: viewState.colors.outline; opacity: .4 }
                    }
                    RowLayout {
                        anchors.fill: parent
                        ModeGroup { choices: window.modeChoices(window.width >= 1000); selected: viewState.mode; onChosen: key => studio.setMode(key) }
                        Item { Layout.fillWidth: true }
                        Rectangle {
                            Layout.preferredWidth: 68
                            Layout.preferredHeight: 34
                            radius: 12
                            color: viewState.colors["surface-high"]
                            Label { anchors.centerIn: parent; text: Math.round(viewState.zoom) + "%%"; font.pixelSize: 13; color: viewState.colors.text }
                        }
                        ActionButton { glyph: "Fullscreen"; compact: true; tonal: true; onClicked: {} }
                        ActionButton { glyph: "Lock"; compact: true; tonal: true; onClicked: {} }
                    }
                }
%s
                Rectangle {
                    objectName: "documentViewport"
                    Layout.fillWidth: true
                    Layout.fillHeight: true
                    color: viewState.colors.surface
                    clip: true
                    Column {
                        anchors.fill: parent
                        anchors.margins: 24
                        spacing: 12
                        Label { text: "Spectral Theorem"; font.pixelSize: 24; font.weight: Font.Bold; color: viewState.colors.text }
                        Label { text: "Every real symmetric matrix is orthogonally diagonalizable."; width: parent.width; wrapMode: Text.WordWrap; font.pixelSize: 14; color: viewState.colors.text }
                        Label { text: "Local draft: eigenvectors from distinct eigenspaces remain orthogonal."; width: parent.width; wrapMode: Text.WordWrap; font.pixelSize: 14; color: viewState.colors.muted }
                    }
                }
            }
        }
    }
%s
}
""" % (textwrap.indent(banner_code, "                "), textwrap.indent(dialog_code, "    "))).encode("utf-8")

        self.component = QQmlComponent(self.engine)
        self.component.setData(harness, QUrl.fromLocalFile(str(Path(__file__).parent / "qml/conflict-760-test.qml")))
        self.assertFalse(self.component.isError(), str(self.component.errors()))
        win = self.component.create()
        self.assertIsNotNone(win, str(self.component.errors()))
        QTest.qWait(60)
        return win

    def _wait_until(self, predicate, timeout=5.0):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            self.app.processEvents()
            if predicate():
                return
            QTest.qWait(15)
        self.assertTrue(predicate())

    def _walk_items(self, root=None, seen=None):
        if seen is None:
            seen = set()
        if root is None:
            for top in (self.window.property("header"), self.window.contentItem()):
                if isinstance(top, QQuickItem):
                    yield from self._walk_items(top, seen)
            return
        if root in seen:
            return
        seen.add(root)
        yield root
        for child in root.childItems():
            yield from self._walk_items(child, seen)

    def _named(self, name):
        found = self.window.findChild(QObject, name)
        if found is not None:
            return found
        for item in self._walk_items():
            if item.objectName() == name:
                return item
            nested = item.findChild(QObject, name)
            if nested is not None:
                return nested
        return None

    def _scene_rect(self, item):
        top_left = item.mapToScene(QPointF(0, 0))
        return (
            float(top_left.x()),
            float(top_left.y()),
            float(top_left.x() + item.width()),
            float(top_left.y() + item.height()),
        )

    def _assert_banner_and_three_actions_unclipped(self, context_label):
        banner = self._named("conflictBanner")
        label = self._named("conflictBannerLabel")
        save_as = self._named("conflictSaveAsButton")
        reload_btn = self._named("conflictReloadButton")
        overwrite = self._named("conflictOverwriteButton")
        doc_view = self._named("documentViewport")

        for item_name, item in (
            ("conflictBanner", banner),
            ("conflictBannerLabel", label),
            ("conflictSaveAsButton", save_as),
            ("conflictReloadButton", reload_btn),
            ("conflictOverwriteButton", overwrite),
        ):
            self.assertIsNotNone(item, f"{item_name} missing ({context_label})")
            self.assertTrue(bool(item.property("visible")), f"{item_name} not visible ({context_label})")

        self.assertGreaterEqual(label.width(), 320.0, f"Warning label collapsed or cramped ({context_label}): w={label.width()}")
        self.assertGreaterEqual(label.height(), 16.0, f"Warning label height invalid ({context_label}): h={label.height()}")

        bx1, by1, bx2, by2 = self._scene_rect(banner)
        self.assertGreaterEqual(bx1, 0.0)
        self.assertLessEqual(bx2, self.window.width() + 0.5)

        lx1, ly1, lx2, ly2 = self._scene_rect(label)
        self.assertGreaterEqual(lx1, bx1 - 0.5)
        self.assertLessEqual(lx2, bx2 + 0.5)
        self.assertGreaterEqual(ly1, by1 - 0.5)
        self.assertLessEqual(ly2, by2 + 0.5)

        buttons = [("Save as", save_as), ("Reload from disk", reload_btn), ("Overwrite", overwrite)]
        rects = []
        for expected_text, btn in buttons:
            self.assertEqual(btn.property("text"), expected_text)
            self.assertTrue(bool(btn.property("enabled")))
            self.assertGreaterEqual(btn.width(), 64.0)
            self.assertGreaterEqual(btn.height(), 36.0)
            rx1, ry1, rx2, ry2 = self._scene_rect(btn)
            self.assertGreaterEqual(rx1, bx1 - 0.5, f"{expected_text} clipped left ({context_label})")
            self.assertLessEqual(rx2, bx2 + 0.5, f"{expected_text} clipped right ({context_label}): {rx2} > {bx2}")
            self.assertGreaterEqual(ry1, by1 - 0.5, f"{expected_text} clipped top ({context_label})")
            self.assertLessEqual(ry2, by2 + 0.5, f"{expected_text} clipped bottom ({context_label}): {ry2} > {by2}")
            # Warning text must not overlap action buttons
            overlaps_label = not (rx2 <= lx1 + 0.5 or rx1 >= lx2 - 0.5 or ry2 <= ly1 + 0.5 or ry1 >= ly2 - 0.5)
            self.assertFalse(overlaps_label, f"{expected_text} overlaps warning label ({context_label})")
            rects.append((expected_text, rx1, ry1, rx2, ry2))

        for i in range(len(rects)):
            for j in range(i + 1, len(rects)):
                n1, ax1, ay1, ax2, ay2 = rects[i]
                n2, cx1, cy1, cx2, cy2 = rects[j]
                overlaps = not (ax2 <= cx1 + 0.5 or ax1 >= cx2 - 0.5 or ay2 <= cy1 + 0.5 or ay1 >= cy2 - 0.5)
                self.assertFalse(overlaps, f"Buttons {n1} and {n2} overlap ({context_label})")

        _, dy1, _, dy2 = self._scene_rect(doc_view)
        self.assertLessEqual(by2, dy1 + 1.0)
        self.assertGreaterEqual(dy2 - dy1, 200.0, f"Document viewport squeezed ({context_label}): h={dy2 - dy1}")

    def test_760px_desktop_conflict_banner_actions_and_reload_recovery(self):
        md_one = self.temp_dir / "01_Eigenvalues.md"
        md_two = self.temp_dir / "03_Spectral_Theorem.md"
        smd_bg = self.temp_dir / "04_Cholesky.smd"
        svg_disk = "data:image/svg+xml;base64,PHN2ZyBpZD0iZGlzayIvPg=="
        svg_draft = "data:image/svg+xml;base64,PHN2ZyBpZD0iZHJhZnQiLz4="

        md_one.write_text("# Eigenvalues\n", encoding="utf-8")
        md_two.write_text("# Spectral Theorem\n\nDisk base.\n", encoding="utf-8")
        write_portable(smd_bg, "# Cholesky\n\nBase portable.\n", {"assets/diagram.svg": svg_disk})

        # Set up three realistic tabs: clean first tab, dirty conflicted active tab, dirty conflicted background .smd tab.
        t0 = self.studio.tabs[0]
        t0.update(name=md_one.name, path=str(md_one), content="# Eigenvalues\n", saved="# Eigenvalues\n", conflict=False)

        self.studio.newNote()
        t_active = self.studio._current()
        t_active.update(
            name=md_two.name,
            path=str(md_two),
            content="# Spectral Theorem\n\nUnsaved local proof draft.\n",
            saved="# Spectral Theorem\n\nDisk base.\n",
            conflict=True,
        )

        self.studio.newNote()
        t_bg = self.studio._current()
        t_bg.update(
            name=smd_bg.name,
            path=str(smd_bg),
            content="# Cholesky\n\nUnsaved portable draft.\n",
            saved="# Cholesky\n\nBase portable.\n",
            assets={"assets/diagram.svg": svg_draft},
            saved_assets={"assets/diagram.svg": svg_disk},
            portable=True,
            conflict=True,
        )
        # Keep 03_Spectral_Theorem.md active while 04_Cholesky.smd is a conflicted background tab.
        self.studio.selectTab(t_active["id"])
        QTest.qWait(80)
        img_760 = self.window.grabWindow()
        self.assertFalse(img_760.isNull())

        screenshot_out = os.environ.get("SUPERMD_CONFLICT_DESKTOP_SCREENSHOT")
        if screenshot_out:
            Path(screenshot_out).parent.mkdir(parents=True, exist_ok=True)
            self.assertTrue(img_760.save(screenshot_out))

        # 1. Verify 760px with sidebar open (494px right pane).
        self.assertEqual(self.window.width(), 760)
        label = self._named("conflictBannerLabel")
        self.assertIn("Reload from disk", str(label.property("text")))
        self.assertIn("closed tabs", str(label.property("text")))
        self._assert_banner_and_three_actions_unclipped("760px sidebar open")

        # 2. Verify background conflicted tab indicator is visible while clean tab indicator is hidden.
        note_tabs = [item for item in self._walk_items() if item.objectName() == "noteTab"]
        self.assertEqual(len(note_tabs), 3)
        by_id = {item.property("modelData")["id"]: item for item in note_tabs}
        for tid, expected_conflict in ((t0["id"], False), (t_active["id"], True), (t_bg["id"], True)):
            indicator = by_id[tid].findChild(QObject, "tabConflictIndicator")
            self.assertIsNotNone(indicator)
            self.assertEqual(bool(indicator.property("visible")), expected_conflict)

        # 3. Verify 760px with sidebar hidden (760px full-width pane) and wide 1120px single-row layout.
        self.window.setProperty("sidebar", False)
        QTest.qWait(60)
        self.window.grabWindow()
        self._assert_banner_and_three_actions_unclipped("760px sidebar closed")

        self.window.setProperty("sidebar", True)
        self.window.resize(1120, 640)
        QTest.qWait(60)
        self.window.grabWindow()
        self._assert_banner_and_three_actions_unclipped("1120px wide single-row")

        self.window.resize(760, 560)
        QTest.qWait(60)
        self.window.grabWindow()
        self._assert_banner_and_three_actions_unclipped("760px restored")

        # 4. Verify all three conflict actions are interactively clickable at 760px:
        # Action A: Save as triggers save_as resolution (saveAsSafely).
        save_as_calls = []
        orig_save_as = self.studio.saveAsSafely
        self.studio.saveAsSafely = lambda: save_as_calls.append("save_as")
        try:
            save_as_btn = self._named("conflictSaveAsButton")
            pt = save_as_btn.mapToScene(QPointF(save_as_btn.width() / 2, save_as_btn.height() / 2)).toPoint()
            QTest.mouseClick(self.window, Qt.MouseButton.LeftButton, Qt.KeyboardModifier.NoModifier, pt)
            QTest.qWait(40)
            self.assertEqual(save_as_calls, ["save_as"])
        finally:
            self.studio.saveAsSafely = orig_save_as

        # Action B: Overwrite writes local draft to disk and clears conflict on active tab only.
        md_two.write_text("# Spectral Theorem\n\nExternal disk edit.\n", encoding="utf-8")
        overwrite_btn = self._named("conflictOverwriteButton")
        pt = overwrite_btn.mapToScene(QPointF(overwrite_btn.width() / 2, overwrite_btn.height() / 2)).toPoint()
        QTest.mouseClick(self.window, Qt.MouseButton.LeftButton, Qt.KeyboardModifier.NoModifier, pt)
        self._wait_until(lambda: not t_active.get("conflict") and not self.studio.saving)
        self.assertEqual(md_two.read_text(encoding="utf-8"), "# Spectral Theorem\n\nUnsaved local proof draft.\n")
        self.assertFalse(bool(self._named("conflictBanner").property("visible")))
        # Background tab 04_Cholesky.smd is still conflicted!
        self.assertTrue(bool(t_bg.get("conflict")))

        # Click the background tab's conflict indicator to reveal and activate 04_Cholesky.smd, then test Reload from disk + #122 recovery!
        note_tabs = [item for item in self._walk_items() if item.objectName() == "noteTab"]
        bg_tab_item = next(item for item in note_tabs if item.property("modelData")["id"] == t_bg["id"])
        bg_indicator = bg_tab_item.findChild(QQuickItem, "tabConflictIndicator")
        self.assertTrue(bg_indicator.isVisible())
        ind_pt = bg_indicator.mapToScene(QPointF(bg_indicator.width() / 2, bg_indicator.height() / 2)).toPoint()
        QTest.mouseClick(self.window, Qt.MouseButton.LeftButton, Qt.KeyboardModifier.NoModifier, ind_pt)
        self._wait_until(lambda: self.studio.active == t_bg["id"] and bool(self._named("conflictBanner").property("visible")))

        # Action C: Reload from disk on dirty portable .smd archives draft + assets to closed tabs (#122) and loads disk version.
        svg_external = "data:image/svg+xml;base64,PHN2ZyBpZD0iZXh0ZXJuYWwiLz4="
        write_portable(smd_bg, "# Cholesky\n\nExternal portable v2.\n", {"assets/diagram.svg": svg_external})
        reload_btn = self._named("conflictReloadButton")
        pt = reload_btn.mapToScene(QPointF(reload_btn.width() / 2, reload_btn.height() / 2)).toPoint()
        QTest.mouseClick(self.window, Qt.MouseButton.LeftButton, Qt.KeyboardModifier.NoModifier, pt)
        self._wait_until(lambda: not t_bg.get("conflict") and self.studio.busy == 0)
        self.assertEqual(t_bg["content"], "# Cholesky\n\nExternal portable v2.\n")
        self.assertEqual(t_bg["assets"], {"assets/diagram.svg": svg_external})
        self.assertFalse(bool(self._named("conflictBanner").property("visible")))

        # Reopening closed tab restores the archived dirty draft and its portable SVG asset!
        self.studio.reopenTab()
        QTest.qWait(50)
        reopened = self.studio._current()
        self.assertEqual(reopened["content"], "# Cholesky\n\nUnsaved portable draft.\n")
        self.assertEqual(reopened["assets"], {"assets/diagram.svg": svg_draft})
        self.assertEqual(open_note(smd_bg)[:2], ("# Cholesky\n\nExternal portable v2.\n", {"assets/diagram.svg": svg_external}))

    def test_overflowing_760px_tab_strip_reveals_active_tab_when_background_tabs_gain_conflict(self):
        # Create overflowing tabs across the 760px strip.
        for idx in range(6):
            if idx > 0:
                self.studio.newNote()
            tab = self.studio._current()
            tab.update(
                name=f"0{idx + 1}_Numerical_Linear_Algebra_Part_{idx + 1}.md",
                path=str(self.temp_dir / f"part_{idx + 1}.md"),
                content=f"# Part {idx + 1}",
                saved=f"# Part {idx + 1}",
                conflict=False,
            )
        self.studio._emit(False)
        QTest.qWait(60)

        def assert_active_revealed(context):
            strip = self._named("tabStrip")
            flickable = strip.property("contentItem")
            content_x = float(flickable.property("contentX"))
            viewport_w = float(strip.property("availableWidth") or strip.width())
            active_item = next(
                item for item in self._walk_items()
                if item.objectName() == "noteTab" and bool(item.property("isActive"))
            )
            self.assertGreaterEqual(
                active_item.x() + 0.5,
                content_x,
                f"Active tab clipped left ({context}): x={active_item.x()}, contentX={content_x}",
            )
            self.assertLessEqual(
                active_item.x() + active_item.width() - 0.5,
                content_x + viewport_w,
                f"Active tab clipped right ({context}): right={active_item.x() + active_item.width()}, viewRight={content_x + viewport_w}",
            )

        # Select tab 1 (leftmost), then select tab 3 (near right edge of initial viewport).
        self.studio.selectTab(self.studio.tabs[0]["id"])
        QTest.qWait(60)
        assert_active_revealed("after selecting tab 1")

        self.studio.selectTab(self.studio.tabs[2]["id"])
        QTest.qWait(60)
        assert_active_revealed("after selecting tab 3 near right edge")

        # Mark tabs 0, 1, and 2 as conflicted so each widens by +24px; active tab 3 must remain completely revealed.
        for idx in (0, 1, 2):
            self.studio.tabs[idx]["conflict"] = True
        self.studio._emit(False)
        QTest.qWait(80)
        assert_active_revealed("after preceding and active tabs widen with conflict indicator")

        # Selecting the rightmost conflicted tab also reveals its full pill and indicator.
        self.studio.tabs[-1]["conflict"] = True
        self.studio.selectTab(self.studio.tabs[-1]["id"])
        QTest.qWait(80)
        assert_active_revealed("after selecting rightmost conflicted tab")


if __name__ == "__main__":
    unittest.main()
