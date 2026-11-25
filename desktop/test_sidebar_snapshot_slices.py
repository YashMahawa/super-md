"""Regression tests for cached folder/sidebar snapshot slices and sidebarChanged domain signal."""
import copy
import json
import os
import textwrap
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


MAIN_QML = Path(__file__).parent / "qml" / "Main.qml"


def _production_sidebar_harness_qml() -> bytes:
    qml = MAIN_QML.read_text(encoding="utf-8")
    sidebar_start = qml.index("        Pane {\n            visible: sidebar && !viewState.fullscreen && !viewState.imageOverlay")
    sidebar_end = qml.index("        Item {\n            SplitView.fillWidth: true", sidebar_start)
    sidebar_pane = textwrap.dedent(qml[sidebar_start:sidebar_end]).rstrip()
    sidebar_pane = sidebar_pane.replace(
        "SplitView.preferredWidth: 260\n    SplitView.minimumWidth: 200\n    SplitView.maximumWidth: 500",
        "Layout.preferredWidth: 300\n    Layout.fillHeight: true",
        1,
    )

    popup_start = qml.index("    Popup {\n        id: contentsPopup")
    popup_end = qml.index("    AppDialog {\n        id: settingsDialog", popup_start)
    popup_block = textwrap.dedent(qml[popup_start:popup_end]).rstrip()

    harness = f"""import QtQuick
import QtQuick.Controls
import QtQuick.Controls.Material
import QtQuick.Layouts

ApplicationWindow {{
    id: window
    width: 980
    height: 680
    visible: true
    color: viewState.colors.surface
    property var viewState: JSON.parse(studio.snapshot)
    property var sidebarState: JSON.parse(studio.sidebarSnapshot)
    property var shortcutLabels: JSON.parse(studio.shortcutLabels)
    property bool sidebar: true
    property string sidebarSection: "folder"
    property bool chromeAwake: true
    property int viewStateEvaluations: 0
    property int sidebarStateEvaluations: 0
    onViewStateChanged: viewStateEvaluations += 1
    onSidebarStateChanged: sidebarStateEvaluations += 1
    function focusReader() {{}}
    Material.theme: viewState.dark ? Material.Dark : Material.Light
    Material.primary: viewState.colors.primary
    Material.accent: viewState.colors.primary
    Material.background: viewState.colors.surface
    Material.foreground: viewState.colors["on-surface"]

    RowLayout {{
        anchors.fill: parent
        spacing: 0
{textwrap.indent(sidebar_pane, "        ")}
        Item {{ Layout.fillWidth: true; Layout.fillHeight: true }}
    }}
{textwrap.indent(popup_block, "    ")}
}}
"""
    return harness.encode("utf-8")


class SidebarSnapshotSlicesTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if QGuiApplication.instance() is None:
            QQuickStyle.setStyle("Material")
        cls.app = QGuiApplication.instance() or QGuiApplication(["Sidebar snapshot slices tests"])

    def setUp(self):
        self.session = Session(True)
        self.session.settings.update(theme="dark", accent="blue", motion=False, welcomed=True, autosave=False)
        self.studio = QuietStudio(True, self.session)
        self.workspace = self.studio.data / "NotesWorkspace"
        (self.workspace / "Coursework").mkdir(parents=True)
        (self.workspace / "Coursework" / "Week 1.md").write_text("# Week 1\n\nLinear systems", encoding="utf-8")
        (self.workspace / "Overview.md").write_text("# Overview\n\nSummary", encoding="utf-8")
        (self.workspace / "Reading.md").write_text("# Reading\n\nChapter 2", encoding="utf-8")

        self.engine = QQmlEngine()
        self.engine.rootContext().setContextProperty("studio", self.studio)
        self.component = QQmlComponent(self.engine)
        self.component.setData(
            _production_sidebar_harness_qml(),
            QUrl.fromLocalFile(str(Path(__file__).parent / "qml" / "sidebar-slices-harness.qml")),
        )
        self.assertFalse(self.component.isError(), str(self.component.errors()))
        self.window = self.component.create()
        self.assertIsNotNone(self.window, str(self.component.errors()))
        QTest.qWait(40)

    def tearDown(self):
        self.window.close()
        self.window.deleteLater()
        self.app.sendPostedEvents(None, QEvent.Type.DeferredDelete)
        self.engine.deleteLater()
        self.app.sendPostedEvents(None, QEvent.Type.DeferredDelete)
        for window in list(self.session.windows.values()):
            window.stop()
            window.pool.shutdown(wait=True)
            window._search_pool.shutdown(wait=True, cancel_futures=True)
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

    def _qml_dict(self, prop_name: str) -> dict:
        value = self.window.property(prop_name)
        return value.toVariant() if hasattr(value, "toVariant") else value

    @staticmethod
    def _list_delegates(list_view):
        content = list_view.property("contentItem")
        return [
            child
            for child in content.childItems()
            if child.metaObject().className() != "QQuickItem"
            and child.property("width") > 0
            and child.property("height") > 0
        ]

    def test_unrelated_studio_changes_reuse_cached_slices_and_keep_sidebar_delegates_alive(self):
        overview = self.workspace / "Overview.md"
        self.studio.openFolder(str(self.workspace))
        self.wait_until(lambda: len(self.studio.files) == 3)
        self.studio.openNote(str(overview))
        self.wait_until(lambda: self.studio._current()["path"] == str(overview))
        self.studio.pinRecent(str(overview))
        active_id = self.studio.active
        self.studio.post(
            "req-outline-1",
            "document_outline",
            json.dumps({
                "id": active_id,
                "headings": [
                    {"title": "Overview", "level": 1, "offset": 0},
                    {"title": "Summary", "level": 2, "offset": 12},
                ],
            }),
        )
        QTest.qWait(40)

        files_view = self.named("folderFilesView")
        outline_list = self.named("sidebarOutlineList")
        recent_notes = self.named("sidebarRecentNotes")
        self.assertIsNotNone(files_view)
        self.assertIsNotNone(outline_list)
        self.assertIsNotNone(recent_notes)

        initial_file_delegates = self._list_delegates(files_view)
        initial_recent_delegates = self._list_delegates(recent_notes)
        self.assertEqual(len(initial_file_delegates), 3)
        self.assertEqual(len(initial_recent_delegates), 1)

        self.window.setProperty("sidebarSection", "contents")
        QTest.qWait(30)
        initial_outline_delegates = self._list_delegates(outline_list)
        self.assertEqual(len(initial_outline_delegates), 2)
        self.window.setProperty("sidebarSection", "folder")
        QTest.qWait(30)

        # Prime caches and record exact cached string references.
        baseline_sidebar_json = self.studio.sidebarSnapshot
        _ = self.studio.snapshot
        folder_cache_before = self.studio._folder_slice_cache
        outline_cache_before = self.studio._outline_slice_cache
        recent_cache_before = self.studio._recent_slice_cache
        pinned_cache_before = self.studio._pinned_slice_cache

        changed_emissions = []
        sidebar_emissions = []
        self.studio.changed.connect(lambda: changed_emissions.append(1))
        self.studio.sidebarChanged.connect(lambda: sidebar_emissions.append(1))
        sidebar_evals_before = self.window.property("sidebarStateEvaluations")
        view_evals_before = self.window.property("viewStateEvaluations")

        # Trigger unrelated global studio.changed events: zoom, status message, busy, overlay, settings, body edit.
        self.studio.setZoom(135)
        self.studio.message = "Exported preview"
        self.studio._emit(False)
        self.studio.busy = 1
        self.studio._emit(False)
        self.studio.busy = 0
        self.studio._emit(False)
        self.studio.post("req-overlay", "reader_overlay_changed", json.dumps({"open": True, "image": False}))
        self.studio.post("req-overlay-close", "reader_overlay_changed", json.dumps({"open": False, "image": False}))
        self.studio.setting("centerLock", "false")
        self.studio.post(
            "req-body-edit",
            "document_changed",
            json.dumps({"id": active_id, "content": "# Overview\n\nSummary with extra body paragraph."}),
        )
        # No-op folder rescan with identical entries (e.g. directoryChanged after atomic save) must not churn files.
        self.studio.files = copy.deepcopy(self.studio.files)
        self.studio._emit(False)
        QTest.qWait(40)

        self.assertGreaterEqual(len(changed_emissions), 8)
        self.assertEqual(len(sidebar_emissions), 0)
        self.assertEqual(self.window.property("sidebarStateEvaluations"), sidebar_evals_before)
        self.assertGreater(self.window.property("viewStateEvaluations"), view_evals_before)

        # Exact cached JSON fragments and sidebarSnapshot string were reused without re-encoding.
        self.assertIs(self.studio.sidebarSnapshot, baseline_sidebar_json)
        self.assertIs(self.studio._folder_slice_cache, folder_cache_before)
        self.assertIs(self.studio._outline_slice_cache, outline_cache_before)
        self.assertIs(self.studio._recent_slice_cache, recent_cache_before)
        self.assertIs(self.studio._pinned_slice_cache, pinned_cache_before)

        # Delegate instances in folderFilesView and RecentNotes were never destroyed/recreated.
        self.assertEqual(self._list_delegates(files_view), initial_file_delegates)
        self.assertEqual(self._list_delegates(recent_notes), initial_recent_delegates)

        snap = json.loads(self.studio.snapshot)
        self.assertEqual(snap["zoom"], 135)
        self.assertTrue(any(t["id"] == active_id and t["dirty"] for t in snap["tabs"]))

    def test_preserves_updates_after_tab_changes_and_edits(self):
        overview = self.workspace / "Overview.md"
        reading = self.workspace / "Reading.md"
        self.studio.openFolder(str(self.workspace))
        self.wait_until(lambda: len(self.studio.files) == 3)

        self.studio.openNote(str(overview))
        self.wait_until(lambda: self.studio._current()["path"] == str(overview))
        overview_id = self.studio.active
        self.studio.post(
            "out-overview",
            "document_outline",
            json.dumps({"id": overview_id, "headings": [{"title": "Overview", "level": 1, "offset": 0}]}),
        )

        self.studio.openNote(str(reading))
        self.wait_until(lambda: self.studio._current()["path"] == str(reading))
        reading_id = self.studio.active
        folder_cache_before_outline = self.studio._folder_slice_cache
        self.studio.post(
            "out-reading",
            "document_outline",
            json.dumps({
                "id": reading_id,
                "headings": [
                    {"title": "Reading", "level": 1, "offset": 0},
                    {"title": "Exercises", "level": 2, "offset": 24},
                ],
            }),
        )
        QTest.qWait(30)
        # Updating outline reuses the cached folder slice without re-serializing files.
        self.assertIs(self.studio._folder_slice_cache, folder_cache_before_outline)

        outline_list = self.named("sidebarOutlineList")
        popup_outline = self.named("popupOutlineList")
        self.assertEqual([e["title"] for e in self._qml_dict("sidebarState")["outline"]], ["Reading", "Exercises"])
        self.assertEqual(outline_list.property("noteId"), reading_id)
        self.assertEqual(popup_outline.property("noteId"), reading_id)

        # Switching tabs updates active & outline in both sidebar and contents popup.
        self.studio.selectTab(overview_id)
        QTest.qWait(30)
        self.assertEqual(self._qml_dict("sidebarState")["active"], overview_id)
        self.assertEqual([e["title"] for e in self._qml_dict("sidebarState")["outline"]], ["Overview"])
        self.assertEqual(outline_list.property("noteId"), overview_id)
        self.assertEqual(popup_outline.property("noteId"), overview_id)

        # Creating an untitled note and adding a heading updates outline and auto-titles the tab.
        self.studio.newNote()
        untitled_id = self.studio.active
        QTest.qWait(30)
        self.assertEqual(self._qml_dict("sidebarState")["active"], untitled_id)
        self.assertEqual(self._qml_dict("sidebarState")["outline"], [])
        self.studio.post(
            "out-untitled",
            "document_outline",
            json.dumps({"id": untitled_id, "headings": [{"title": "Draft Plan", "level": 1, "offset": 0}]}),
        )
        QTest.qWait(30)
        self.assertEqual([e["title"] for e in self._qml_dict("sidebarState")["outline"]], ["Draft Plan"])
        self.assertEqual(self._qml_dict("viewState")["name"], "Draft Plan.md")

        # Save-as updates recent notes and clears dirty state.
        saved_draft = self.workspace / "Draft Plan.md"
        self.studio.post(
            "edit-untitled",
            "document_changed",
            json.dumps({"id": untitled_id, "content": "# Draft Plan\n\nSaved content"}),
        )
        self.studio.saveAs(str(saved_draft))
        self.wait_until(lambda: str(saved_draft) in self.studio.recent and saved_draft.is_file())
        QTest.qWait(30)
        self.assertEqual(self._qml_dict("sidebarState")["recent"][0], str(saved_draft))
        self.assertFalse(any(t["id"] == untitled_id and t["dirty"] for t in self._qml_dict("viewState")["tabs"]))

        # Renaming a saved note updates tabs, recent notes, and folder file listing.
        renamed_draft = self.workspace / "Final Plan.md"
        self.studio.renameNote(untitled_id, "Final Plan.md")
        self.wait_until(
            lambda: renamed_draft.is_file()
            and any(f["name"] == "Final Plan.md" for f in self.studio.files)
        )
        QTest.qWait(30)
        self.assertEqual(self._qml_dict("sidebarState")["recent"][0], str(renamed_draft))
        self.assertIn("Final Plan.md", [f["name"] for f in self._qml_dict("sidebarState")["files"]])

        # Closing and reopening the active tab preserves sidebar outline/active sync.
        self.studio.closeTab(untitled_id)
        self.wait_until(lambda: all(t["id"] != untitled_id for t in self.studio.tabs))
        QTest.qWait(30)
        self.assertNotEqual(self._qml_dict("sidebarState")["active"], untitled_id)
        self.studio.reopenTab()
        self.wait_until(lambda: any(t["path"] == str(renamed_draft) for t in self.studio.tabs))
        QTest.qWait(30)
        self.assertEqual(self.studio._current()["path"], str(renamed_draft))
        self.assertEqual(self._qml_dict("sidebarState")["active"], self.studio.active)

        # Cross-window tab move updates both source and destination sidebar states.
        second_studio = QuietStudio(True, self.session)
        moved_id = self.studio.active
        self.assertTrue(self.studio._move_tab(second_studio, moved_id, 0))
        self.assertEqual(json.loads(second_studio.sidebarSnapshot)["active"], moved_id)
        self.assertNotEqual(json.loads(self.studio.sidebarSnapshot)["active"], moved_id)

        # Incremental document_patch clean -> dirty -> clean flips tab dirty state without emitting sidebarChanged.
        self.studio.selectTab(overview_id)
        QTest.qWait(20)
        sync_sidebar_signals = []
        self.studio.sidebarChanged.connect(lambda: sync_sidebar_signals.append(1))
        original_text = self.studio._current()["saved"]
        self.studio.post(
            "sync-seed",
            "document_sync",
            json.dumps({"id": overview_id, "epoch": "e1", "revision": 0, "content": original_text}),
        )
        utf16_len = len(original_text.encode("utf-16-le")) // 2
        added_suffix = "\nEdited line"
        self.studio.post(
            "patch-dirty",
            "document_patch",
            json.dumps({
                "id": overview_id,
                "epoch": "e1",
                "baseRevision": 0,
                "revision": 1,
                "changes": [{"from": utf16_len, "to": utf16_len, "insert": added_suffix}],
            }),
        )
        QTest.qWait(20)
        self.assertTrue(any(t["id"] == overview_id and t["dirty"] for t in self._qml_dict("viewState")["tabs"]))
        self.assertEqual(len(sync_sidebar_signals), 0)
        self.studio.post(
            "patch-clean",
            "document_patch",
            json.dumps({
                "id": overview_id,
                "epoch": "e1",
                "baseRevision": 1,
                "revision": 2,
                "changes": [{"from": utf16_len, "to": utf16_len + len(added_suffix), "insert": ""}],
            }),
        )
        QTest.qWait(20)
        self.assertFalse(any(t["id"] == overview_id and t["dirty"] for t in self._qml_dict("viewState")["tabs"]))
        self.assertEqual(len(sync_sidebar_signals), 0)

        # External rename and delete propagate to pinned & recent slices.
        self.studio.pinRecent(str(overview))
        ext_renamed = self.workspace / "Overview Renamed.md"
        overview.rename(ext_renamed)
        self.studio._location_changed(str(overview), str(ext_renamed))
        QTest.qWait(20)
        self.assertIn(str(ext_renamed), self._qml_dict("sidebarState")["recent"])
        self.assertEqual(self._qml_dict("sidebarState")["pinned"], [str(ext_renamed)])
        ext_renamed.unlink()
        self.studio._location_changed(str(ext_renamed), "")
        self.wait_until(lambda: all(t["path"] != str(ext_renamed) for t in self.studio.tabs))
        QTest.qWait(20)
        self.assertNotIn(str(ext_renamed), self._qml_dict("sidebarState")["recent"])
        self.assertEqual(self._qml_dict("sidebarState")["pinned"], [])

    def test_preserves_updates_after_folder_operations_pins_and_startup_restore(self):
        # Open folder and expand nested directory.
        self.studio.openFolder(str(self.workspace))
        self.wait_until(lambda: len(self.studio.files) == 3)
        QTest.qWait(30)
        self.assertEqual(
            [f["name"] for f in self._qml_dict("sidebarState")["files"]],
            ["Coursework", "Overview.md", "Reading.md"],
        )

        coursework = self.workspace / "Coursework"
        self.studio.toggleDirectory(str(coursework))
        self.wait_until(lambda: any(f["name"] == "Week 1.md" for f in self.studio.files))
        QTest.qWait(30)
        self.assertEqual(
            [(f["name"], f["expanded"]) for f in self._qml_dict("sidebarState")["files"]],
            [("Coursework", True), ("Week 1.md", False), ("Overview.md", False), ("Reading.md", False)],
        )

        # Subfolder filter search and empty state.
        filter_field = self.named("folderFilterField")
        empty_state = self.named("folderEmptyState")
        filter_field.setProperty("text", "week")
        self.wait_until(
            lambda: not self.studio._folder_searching
            and not self.studio.filter_timer.isActive()
            and [f["name"] for f in self.studio.files] == ["Coursework", "Week 1.md"]
        )
        QTest.qWait(30)
        self.assertEqual(
            [f["name"] for f in self._qml_dict("sidebarState")["files"]],
            ["Coursework", "Week 1.md"],
        )
        self.assertFalse(empty_state.property("visible"))

        filter_field.setProperty("text", "nonexistent-note-xyz")
        self.wait_until(
            lambda: not self.studio._folder_searching
            and not self.studio.filter_timer.isActive()
            and len(self.studio.files) == 0
        )
        QTest.qWait(30)
        self.assertTrue(empty_state.property("visible"))

        # Clearing filter restores expanded tree.
        filter_field.setProperty("text", "")
        self.wait_until(lambda: len(self.studio.files) == 4)
        QTest.qWait(30)
        self.assertFalse(empty_state.property("visible"))

        # External file creation in watched folder refreshes sidebar files.
        added = coursework / "Week 2.md"
        added.write_text("# Week 2", encoding="utf-8")
        self.studio._external_note_changed(str(coursework))
        self.studio.external_timer.stop()
        self.studio._refresh_external_notes()
        self.wait_until(lambda: any(f["name"] == "Week 2.md" for f in self.studio.files))
        QTest.qWait(30)
        self.assertIn("Week 2.md", [f["name"] for f in self._qml_dict("sidebarState")["files"]])

        # Pinning & unpinning recent notes updates sidebarState.pinned and studio.pinnedRecent across windows.
        second_studio = QuietStudio(True, self.session)
        second_sidebar_signals = []
        second_studio.sidebarChanged.connect(lambda: second_sidebar_signals.append(1))
        self.studio.openNote(str(added))
        self.wait_until(lambda: str(added) in self.studio.recent)
        self.studio.pinRecent(str(added))
        QTest.qWait(30)
        self.assertEqual(self._qml_dict("sidebarState")["pinned"], [str(added)])
        self.assertEqual(self.studio.pinnedRecent, [str(added)])
        self.assertEqual(json.loads(second_studio.sidebarSnapshot)["pinned"], [str(added)])
        self.assertGreaterEqual(len(second_sidebar_signals), 1)

        self.studio.pinRecent(str(added))
        QTest.qWait(30)
        self.assertEqual(self._qml_dict("sidebarState")["pinned"], [])

        # Closing folder clears folder & files while keeping recent notes intact.
        self.studio.closeFolder()
        QTest.qWait(30)
        self.assertEqual(self._qml_dict("sidebarState")["folder"], "")
        self.assertEqual(self._qml_dict("sidebarState")["files"], [])
        self.assertIn(str(added), self._qml_dict("sidebarState")["recent"])

        # Startup workspace folder restoration populates sidebarSnapshot once tree scan finishes.
        restored_session = Session(True)
        restored_session.settings.update(startup="restore", welcomed=True)
        restored_session.startup_folder = str(self.workspace)
        restored_session.startup_expanded = [str(self.workspace), str(coursework)]
        restored_studio = QuietStudio(True, restored_session)
        try:
            self.wait_until(lambda: any(f["name"] == "Week 2.md" for f in restored_studio.files))
            restored_sidebar = json.loads(restored_studio.sidebarSnapshot)
            self.assertEqual(restored_sidebar["folder"], str(self.workspace.resolve()))
            self.assertIn("Week 2.md", [f["name"] for f in restored_sidebar["files"]])
        finally:
            restored_studio.stop()
            restored_studio.pool.shutdown(wait=True)
            restored_studio._search_pool.shutdown(wait=True, cancel_futures=True)
            restored_session.writes.shutdown(wait=True)

    def test_pre_outline_tabs_noop_outline_posts_pinned_rename_and_save_as_folder_refresh(self):
        # 1. Fresh/newly opened tabs without any document_outline key must not churn sidebarChanged on unrelated emits.
        overview = self.workspace / "Overview.md"
        self.studio.openFolder(str(self.workspace))
        self.wait_until(lambda: len(self.studio.files) == 3)
        self.studio.openNote(str(overview))
        self.wait_until(lambda: self.studio._current()["path"] == str(overview))
        self.assertNotIn("outline", self.studio._current())

        baseline_sidebar = self.studio.sidebarSnapshot
        _ = self.studio.snapshot
        pre_outline_signals = []
        self.studio.sidebarChanged.connect(lambda: pre_outline_signals.append(1))
        for zoom in (110, 120, 125):
            self.studio.setZoom(zoom)
        self.studio.message = "Status check"
        self.studio._emit(False)
        QTest.qWait(25)
        self.assertEqual(len(pre_outline_signals), 0)
        self.assertIs(self.studio.sidebarSnapshot, baseline_sidebar)

        # 2. Repeated identical document_outline posts must preserve outline identity so subsequent emits stay silent.
        active_id = self.studio.active
        headings = [{"title": "Overview", "level": 1, "offset": 0}]
        self.studio.post("out-1", "document_outline", json.dumps({"id": active_id, "headings": headings}))
        QTest.qWait(20)
        self.assertEqual(len(pre_outline_signals), 1)
        outline_cache_after_first = self.studio._outline_slice_cache
        sidebar_after_first = self.studio.sidebarSnapshot

        # Post an identical outline (new list object with equal content), then trigger unrelated Studio.changed events.
        self.studio.post("out-2", "document_outline", json.dumps({"id": active_id, "headings": copy.deepcopy(headings)}))
        self.studio.setZoom(130)
        self.studio.message = "After no-op outline"
        self.studio._emit(False)
        QTest.qWait(25)
        self.assertEqual(len(pre_outline_signals), 1)
        self.assertIs(self.studio._outline_slice_cache, outline_cache_after_first)
        self.assertIs(self.studio.sidebarSnapshot, sidebar_after_first)

        # 3. Renaming a pinned note via renameNote updates both sidebarState.pinned and sidebarState.recent cleanly.
        self.studio.pinRecent(str(overview))
        QTest.qWait(20)
        self.assertEqual(self._qml_dict("sidebarState")["pinned"], [str(overview)])

        second_studio = QuietStudio(True, self.session)
        second_studio.openFolder(str(self.workspace))
        self.wait_until(lambda: len(second_studio.files) == 3)

        renamed_overview = self.workspace / "Course Overview.md"
        self.studio.renameNote(active_id, "Course Overview.md")
        self.wait_until(
            lambda: renamed_overview.is_file()
            and any(f["name"] == "Course Overview.md" for f in self.studio.files)
            and any(f["name"] == "Course Overview.md" for f in second_studio.files)
        )
        QTest.qWait(25)
        self.assertEqual(self._qml_dict("sidebarState")["pinned"], [str(renamed_overview)])
        self.assertNotIn(str(overview), self._qml_dict("sidebarState")["recent"])
        self.assertIn(str(renamed_overview), self._qml_dict("sidebarState")["recent"])
        self.assertIn("Course Overview.md", [f["name"] for f in json.loads(second_studio.sidebarSnapshot)["files"]])

        # 4. Saving a new note via saveAs inside an unexpanded subfolder refreshes active folderFilter results immediately.
        filter_field = self.named("folderFilterField")
        filter_field.setProperty("text", "week")
        self.wait_until(
            lambda: not self.studio._folder_searching
            and not self.studio.filter_timer.isActive()
            and [f["name"] for f in self.studio.files] == ["Coursework", "Week 1.md"]
        )
        self.studio.newNote()
        week3_id = self.studio.active
        week3_path = self.workspace / "Coursework" / "Week 3.md"
        self.studio.post("week3-edit", "document_changed", json.dumps({"id": week3_id, "content": "# Week 3"}))
        self.studio.saveAs(str(week3_path))
        self.wait_until(
            lambda: week3_path.is_file()
            and not self.studio._folder_searching
            and [f["name"] for f in self.studio.files] == ["Coursework", "Week 1.md", "Week 3.md"]
        )
        QTest.qWait(25)
        self.assertEqual(
            [f["name"] for f in self._qml_dict("sidebarState")["files"]],
            ["Coursework", "Week 1.md", "Week 3.md"],
        )


if __name__ == "__main__":
    unittest.main()
