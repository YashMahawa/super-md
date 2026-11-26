"""Regression tests for cached folder/sidebar snapshot slices and sidebarChanged domain signal."""
import copy
import json
import os
import shutil
import textwrap
import threading
import time
import unittest
from pathlib import Path
from unittest import mock

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
os.environ.setdefault("QT_QUICK_BACKEND", "software")

from PySide6.QtCore import QEvent, QObject, QUrl
from PySide6.QtGui import QGuiApplication
from PySide6.QtQml import QQmlComponent, QQmlEngine
from PySide6.QtQuickControls2 import QQuickStyle
from PySide6.QtTest import QTest

import folder_ops
import studio
from studio import Session
from test_studio import QuietStudio


def _unlink_path_with_windows_retry(target: Path) -> None:
    is_win = getattr(studio, "_is_windows", lambda: os.name == "nt")
    if not is_win():
        target.unlink()
        return
    delay = 0.005
    deadline = time.monotonic() + 1.5
    while True:
        try:
            target.unlink()
            return
        except PermissionError as error:
            if getattr(error, "winerror", None) not in (5, 32) or time.monotonic() >= deadline:
                raise
            time.sleep(delay)
            delay = min(0.05, delay * 2.0)


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
    property int contextMenuCount: 0
    property int modalDialogCount: 0
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
        self.session.writes.flush(timeout=3)
        raw_workspace = self.studio.data / "NotesWorkspace"
        (raw_workspace / "Coursework").mkdir(parents=True)
        self.workspace = Path(folder_ops.canonical_path_str(raw_workspace))
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
        self._polish()

    def tearDown(self):
        self._settle_watchers()
        self.window.close()
        self.window.deleteLater()
        self.app.sendPostedEvents(None, QEvent.Type.DeferredDelete)
        self.engine.deleteLater()
        self.app.sendPostedEvents(None, QEvent.Type.DeferredDelete)
        self.app.processEvents()
        for window in list(self.session.windows.values()):
            window.stop()
            window.pool.shutdown(wait=True, cancel_futures=True)
            window._search_pool.shutdown(wait=True, cancel_futures=True)
        self.session.writes.shutdown(wait=True)
        shutil.rmtree(self.studio.data, ignore_errors=True)

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

    def wait_until(self, predicate, timeout=8.0):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            self.app.processEvents()
            if predicate():
                return
            QTest.qWait(15)
        self.app.processEvents()
        self.assertTrue(predicate())

    def _polish(self):
        self.app.processEvents()
        self.window.grabWindow()
        self.app.processEvents()

    def _settle_watchers(self):
        for window in tuple(self.session.windows.values()):
            if getattr(window, "retired", False):
                continue
            if window.external_timer.isActive() or window.external_paths:
                window.external_timer.stop()
                window.external_paths.clear()
        QTest.qWait(25)
        for window in tuple(self.session.windows.values()):
            if getattr(window, "retired", False):
                continue
            window.external_timer.stop()
            window.external_paths.clear()
        self._polish()

    @staticmethod
    def _retire_window(window):
        window.stop()
        window.pool.shutdown(wait=True, cancel_futures=True)
        window._search_pool.shutdown(wait=True, cancel_futures=True)

    @staticmethod
    def _same_path_list(actual, expected) -> bool:
        return len(actual) == len(expected) and all(
            folder_ops.same_path(a, b) for a, b in zip(actual, expected)
        )

    @staticmethod
    def _contains_path(items, target) -> bool:
        return any(folder_ops.same_path(item, target) for item in items)

    def _qml_dict(self, prop_name: str) -> dict:
        value = self.window.property(prop_name)
        return value.toVariant() if hasattr(value, "toVariant") else value

    def _list_delegates(self, list_view):
        self._polish()
        content = list_view.property("contentItem")
        if content is None:
            return []
        delegates = [
            child
            for child in content.childItems()
            if child.metaObject().className() != "QQuickItem"
            and bool(child.property("visible"))
            and (child.property("width") or 0) > 0
            and (child.property("height") or 0) > 0
        ]
        delegates.sort(
            key=lambda child: (
                round(float(child.property("y") or 0.0), 2),
                round(float(child.property("x") or 0.0), 2),
            )
        )
        return delegates

    def test_unrelated_studio_changes_reuse_cached_slices_and_keep_sidebar_delegates_alive(self):
        overview = self.workspace / "Overview.md"
        self.studio.openFolder(str(self.workspace))
        self.wait_until(lambda: len(self.studio.files) == 3)
        self.studio.openNote(str(overview))
        self.wait_until(lambda: folder_ops.same_path(self.studio._current()["path"], overview))
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
        self.wait_until(lambda: len(self._qml_dict("sidebarState")["outline"]) == 2)

        folder_sidebar = self.named("folderSidebar")
        files_view = self.named("folderFilesView")
        outline_list = self.named("sidebarOutlineList")
        recent_notes = self.named("sidebarRecentNotes")
        self.assertIsNotNone(folder_sidebar)
        self.assertTrue(folder_sidebar.metaObject().className().startswith("FolderSidebar_QMLTYPE"))
        self.assertIsNotNone(files_view)
        self.assertIsNotNone(outline_list)
        self.assertIsNotNone(recent_notes)
        self.assertEqual(
            files_view.property("model").toVariant() if hasattr(files_view.property("model"), "toVariant") else files_view.property("model"),
            self._qml_dict("sidebarState")["files"],
        )

        self.wait_until(
            lambda: len(self._list_delegates(files_view)) == 3
            and len(self._list_delegates(recent_notes)) == 1
        )
        initial_file_delegates = self._list_delegates(files_view)
        initial_recent_delegates = self._list_delegates(recent_notes)
        self.assertEqual(len(initial_file_delegates), 3)
        self.assertEqual(len(initial_recent_delegates), 1)

        self.window.setProperty("sidebarSection", "contents")
        self.wait_until(lambda: len(self._list_delegates(outline_list)) == 2)
        initial_outline_delegates = self._list_delegates(outline_list)
        self.assertEqual(len(initial_outline_delegates), 2)
        self.window.setProperty("sidebarSection", "folder")
        self.wait_until(lambda: len(self._list_delegates(files_view)) == 3)
        initial_file_delegates = self._list_delegates(files_view)
        initial_recent_delegates = self._list_delegates(recent_notes)
        self._settle_watchers()

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

        # Trigger unrelated global studio.changed events: zoom, status message, notifyMessage, busy, overlay, settings, body edit.
        self.studio.setZoom(135)
        self.studio.notifyMessage("Exported preview")
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

        # Delegate instances in folderFilesView, RecentNotes, and OutlineList were never destroyed/recreated.
        self.assertEqual(self._list_delegates(files_view), initial_file_delegates)
        self.assertEqual(self._list_delegates(recent_notes), initial_recent_delegates)
        self.window.setProperty("sidebarSection", "contents")
        self.assertEqual(self._list_delegates(outline_list), initial_outline_delegates)
        self.window.setProperty("sidebarSection", "folder")

        snap = json.loads(self.studio.snapshot)
        self.assertEqual(snap["zoom"], 135)
        self.assertTrue(any(t["id"] == active_id and t["dirty"] for t in snap["tabs"]))

    def test_preserves_updates_after_tab_changes_and_edits(self):
        overview = self.workspace / "Overview.md"
        reading = self.workspace / "Reading.md"
        self.studio.openFolder(str(self.workspace))
        self.wait_until(lambda: len(self.studio.files) == 3)

        self.studio.openNote(str(overview))
        self.wait_until(lambda: folder_ops.same_path(self.studio._current()["path"], overview))
        overview_id = self.studio.active
        self.studio.post(
            "out-overview",
            "document_outline",
            json.dumps({"id": overview_id, "headings": [{"title": "Overview", "level": 1, "offset": 0}]}),
        )

        self.studio.openNote(str(reading))
        self.wait_until(lambda: folder_ops.same_path(self.studio._current()["path"], reading))
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
        self.wait_until(
            lambda: saved_draft.is_file()
            and any(folder_ops.same_path(p, saved_draft) for p in self.studio.recent)
        )
        QTest.qWait(30)
        self.assertTrue(folder_ops.same_path(self._qml_dict("sidebarState")["recent"][0], saved_draft))
        self.assertFalse(any(t["id"] == untitled_id and t["dirty"] for t in self._qml_dict("viewState")["tabs"]))

        # Renaming a saved note updates tabs, recent notes, and folder file listing.
        renamed_draft = self.workspace / "Final Plan.md"
        self.studio.renameNote(untitled_id, "Final Plan.md")
        self.wait_until(
            lambda: renamed_draft.is_file()
            and any(f["name"] == "Final Plan.md" for f in self.studio.files)
        )
        QTest.qWait(30)
        self.assertTrue(folder_ops.same_path(self._qml_dict("sidebarState")["recent"][0], renamed_draft))
        self.assertIn("Final Plan.md", [f["name"] for f in self._qml_dict("sidebarState")["files"]])

        # Closing and reopening the active tab preserves sidebar outline/active sync.
        self.studio.closeTab(untitled_id)
        self.wait_until(lambda: all(t["id"] != untitled_id for t in self.studio.tabs))
        QTest.qWait(30)
        self.assertNotEqual(self._qml_dict("sidebarState")["active"], untitled_id)
        self.studio.reopenTab()
        self.wait_until(lambda: any(folder_ops.same_path(t["path"], renamed_draft) for t in self.studio.tabs))
        QTest.qWait(30)
        self.assertTrue(folder_ops.same_path(self.studio._current()["path"], renamed_draft))
        self.assertEqual(self._qml_dict("sidebarState")["active"], self.studio.active)

        # Cross-window tab move updates both source and destination sidebar states.
        second_studio = QuietStudio(True, self.session)
        try:
            moved_id = self.studio.active
            self.assertTrue(self.studio._move_tab(second_studio, moved_id, 0))
            self.assertEqual(json.loads(second_studio.sidebarSnapshot)["active"], moved_id)
            self.assertNotEqual(json.loads(self.studio.sidebarSnapshot)["active"], moved_id)
        finally:
            self._retire_window(second_studio)

        # Incremental document_patch clean -> dirty -> clean flips tab dirty state without emitting sidebarChanged.
        self.studio.selectTab(overview_id)
        self.wait_until(lambda: self._qml_dict("sidebarState")["active"] == overview_id)
        self._settle_watchers()
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
        self.wait_until(lambda: any(t["id"] == overview_id and t["dirty"] for t in self._qml_dict("viewState")["tabs"]))
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
        self.wait_until(lambda: not any(t["id"] == overview_id and t["dirty"] for t in self._qml_dict("viewState")["tabs"]))
        self.assertEqual(len(sync_sidebar_signals), 0)

        # External rename and delete propagate to pinned & recent slices.
        self.studio.pinRecent(str(overview))
        ext_renamed = self.workspace / "Overview Renamed.md"
        resume_ext_watch = self.studio._suspend_watches_for_prefix(str(overview), is_dir=False)
        try:
            rename_fn = getattr(studio, "_rename_path_with_windows_retry", lambda b, a: b.rename(a))
            rename_fn(overview, ext_renamed)
        finally:
            if resume_ext_watch is not None:
                resume_ext_watch.set()
        self.session.locationChanged.emit(str(overview), str(ext_renamed))
        self.wait_until(lambda: self._same_path_list(self._qml_dict("sidebarState")["pinned"], [ext_renamed]))
        self.assertTrue(self._contains_path(self._qml_dict("sidebarState")["recent"], ext_renamed))
        resume_del_watch = self.studio._suspend_watches_for_prefix(str(ext_renamed), is_dir=False)
        try:
            _unlink_path_with_windows_retry(ext_renamed)
        finally:
            if resume_del_watch is not None:
                resume_del_watch.set()
        self.session.locationChanged.emit(str(ext_renamed), "")
        self.wait_until(
            lambda: all(not (t["path"] and folder_ops.same_path(t["path"], ext_renamed)) for t in self.studio.tabs)
            and self._qml_dict("sidebarState")["pinned"] == []
        )
        self._settle_watchers()
        self.assertFalse(self._contains_path(self._qml_dict("sidebarState")["recent"], ext_renamed))

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
            and [f["name"] for f in self._qml_dict("sidebarState")["files"]] == ["Coursework", "Week 1.md"]
        )
        self._polish()
        self.assertFalse(empty_state.property("visible"))

        filter_field.setProperty("text", "nonexistent-note-xyz")
        self.wait_until(
            lambda: not self.studio._folder_searching
            and not self.studio.filter_timer.isActive()
            and len(self._qml_dict("sidebarState")["files"]) == 0
        )
        self._polish()
        self.assertTrue(empty_state.property("visible"))

        # Clearing filter restores expanded tree.
        filter_field.setProperty("text", "")
        self.wait_until(lambda: len(self._qml_dict("sidebarState")["files"]) == 4)
        self._polish()
        self.assertFalse(empty_state.property("visible"))

        # External file creation in watched folder refreshes sidebar files.
        added = coursework / "Week 2.md"
        added.write_text("# Week 2", encoding="utf-8")
        self.studio._external_note_changed(str(coursework))
        self.studio.external_timer.stop()
        self.studio._refresh_external_notes()
        self.wait_until(lambda: any(f["name"] == "Week 2.md" for f in self._qml_dict("sidebarState")["files"]))

        # Pinning & unpinning recent notes updates sidebarState.pinned and studio.pinnedRecent across windows.
        second_studio = QuietStudio(True, self.session)
        try:
            second_sidebar_signals = []
            second_studio.sidebarChanged.connect(lambda: second_sidebar_signals.append(1))
            self.studio.openNote(str(added))
            self.wait_until(lambda: self._contains_path(self.studio.recent, added))
            self.studio.pinRecent(str(added))
            self.wait_until(lambda: self._same_path_list(self._qml_dict("sidebarState")["pinned"], [added]))
            self.assertTrue(self._same_path_list(self.studio.pinnedRecent, [added]))
            self.assertTrue(self._same_path_list(json.loads(second_studio.sidebarSnapshot)["pinned"], [added]))
            self.assertGreaterEqual(len(second_sidebar_signals), 1)
        finally:
            self._retire_window(second_studio)

        self.studio.pinRecent(str(added))
        self.wait_until(lambda: self._qml_dict("sidebarState")["pinned"] == [])

        # Closing folder clears folder & files while keeping recent notes intact.
        self.studio.closeFolder()
        QTest.qWait(30)
        self.assertEqual(self._qml_dict("sidebarState")["folder"], "")
        self.assertEqual(self._qml_dict("sidebarState")["files"], [])
        self.assertTrue(self._contains_path(self._qml_dict("sidebarState")["recent"], added))

        # Startup workspace folder restoration populates sidebarSnapshot once tree scan finishes.
        restored_session = Session(True)
        restored_session.settings.update(startup="restore", welcomed=True)
        restored_session.startup_folder = str(self.workspace)
        restored_session.startup_expanded = [str(self.workspace), str(coursework)]
        restored_studio = QuietStudio(True, restored_session)
        try:
            self.wait_until(lambda: any(f["name"] == "Week 2.md" for f in restored_studio.files))
            restored_sidebar = json.loads(restored_studio.sidebarSnapshot)
            self.assertEqual(restored_sidebar["folder"], folder_ops.canonical_path_str(self.workspace))
            self.assertIn("Week 2.md", [f["name"] for f in restored_sidebar["files"]])
        finally:
            restored_studio.stop()
            restored_studio.pool.shutdown(wait=True, cancel_futures=True)
            restored_studio._search_pool.shutdown(wait=True, cancel_futures=True)
            restored_session.writes.shutdown(wait=True)
            shutil.rmtree(restored_studio.data, ignore_errors=True)

    def test_folder_sidebar_create_rename_filter_pinned_recent_and_contents_integration(self):
        self.studio.openFolder(str(self.workspace))
        self.wait_until(lambda: len(self.studio.files) == 3)

        folder_sidebar = self.named("folderSidebar")
        files_view = self.named("folderFilesView")
        filter_field = self.named("folderFilterField")
        outline_list = self.named("sidebarOutlineList")
        popup_outline = self.named("popupOutlineList")
        recent_notes = self.named("sidebarRecentNotes")
        create_dialog = self.named("createFolderItemDialog")
        create_field = self.named("createFolderItemField")
        rename_dialog = self.named("renameEntryDialog")
        rename_field = self.named("renameEntryField")

        self.assertIsNotNone(folder_sidebar)
        self.wait_until(
            lambda: [d.property("text") for d in self._list_delegates(files_view)]
            == ["▸ Coursework", "Overview.md", "Reading.md"]
        )

        # Create a new subfolder through FolderSidebar's real dialog & model.
        folder_sidebar.openCreateDialog("folder", str(self.workspace))
        self.wait_until(lambda: bool(create_dialog.property("visible")))
        create_field.setProperty("text", "Labs")
        create_dialog.accept()
        labs_dir = self.workspace / "Labs"
        self.wait_until(
            lambda: labs_dir.is_dir()
            and any(f["name"] == "Labs" and f["directory"] and f["expanded"] for f in self._qml_dict("sidebarState")["files"])
        )
        self.wait_until(lambda: "▾ Labs" in [d.property("text") for d in self._list_delegates(files_view)])

        # Create a Markdown note inside the new subfolder through FolderSidebar's dialog.
        folder_sidebar.openCreateDialog("md", str(labs_dir))
        self.wait_until(lambda: bool(create_dialog.property("visible")))
        create_field.setProperty("text", "1.2 Signals")
        create_dialog.accept()
        created_note = labs_dir / "1.2 Signals.md"
        self.wait_until(
            lambda: created_note.is_file()
            and folder_ops.same_path(self.studio._current()["path"], created_note)
            and any(f["name"] == "1.2 Signals.md" for f in self._qml_dict("sidebarState")["files"])
        )
        self.wait_until(
            lambda: "▾ Labs" in [d.property("text") for d in self._list_delegates(files_view)]
            and "1.2 Signals.md" in [d.property("text") for d in self._list_delegates(files_view)]
            and len(self._list_delegates(recent_notes)) >= 1
        )

        # Populate Contents outline for the created note and pin it in Recent.
        created_id = self.studio.active
        self.studio.post(
            "out-signals",
            "document_outline",
            json.dumps({
                "id": created_id,
                "headings": [
                    {"title": "1.2 Signals", "level": 1, "offset": 0},
                    {"title": "Fourier Transform", "level": 2, "offset": 18},
                ],
            }),
        )
        self.studio.pinRecent(str(created_note))
        self.wait_until(
            lambda: len(self._qml_dict("sidebarState")["outline"]) == 2
            and self._same_path_list(self._qml_dict("sidebarState")["pinned"], [created_note])
        )
        outline_cache_before_rename = self.studio._outline_slice_cache

        # Rename the pinned note via FolderSidebar's rename dialog; outline cache stays valid while files/pinned/recent update.
        folder_sidebar.openRenameFor(str(created_note), "1.2 Signals.md", False)
        self.wait_until(lambda: bool(rename_dialog.property("visible")))
        rename_field.setProperty("text", "1.3 Systems")
        rename_dialog.accept()
        renamed_note = labs_dir / "1.3 Systems.md"
        self.wait_until(
            lambda: renamed_note.is_file()
            and self._same_path_list(self._qml_dict("sidebarState")["pinned"], [renamed_note])
            and any(f["name"] == "1.3 Systems.md" for f in self._qml_dict("sidebarState")["files"])
        )
        self.wait_until(lambda: "1.3 Systems.md" in [d.property("text") for d in self._list_delegates(files_view)])
        self.assertIs(self.studio._outline_slice_cache, outline_cache_before_rename)

        # Filter in FolderSidebar, then rename the parent subfolder and verify filtered FolderSidebar delegates & pinned Recent remap.
        filter_field.setProperty("text", "systems")
        self.wait_until(
            lambda: not self.studio._folder_searching
            and not self.studio.filter_timer.isActive()
            and [f["name"] for f in self._qml_dict("sidebarState")["files"]] == ["Labs", "1.3 Systems.md"]
        )
        self.wait_until(
            lambda: [d.property("text") for d in self._list_delegates(files_view)] == ["▾ Labs", "1.3 Systems.md"]
        )

        folder_sidebar.openRenameFor(str(labs_dir), "Labs", True)
        self.wait_until(lambda: bool(rename_dialog.property("visible")))
        rename_field.setProperty("text", "ProblemSets")
        watched_during_dir_rename: list[list[str]] = []
        orig_path_rename = Path.rename
        dir_rename_attempts = 0
        dir_attempt0_started = threading.Event()
        dir_main_thread_emitted = threading.Event()

        def spy_path_rename(self_path, target):
            nonlocal dir_rename_attempts
            if dir_rename_attempts == 0:
                dir_rename_attempts += 1
                watched_during_dir_rename.append(
                    list(self.studio.note_watcher.files() + self.studio.note_watcher.directories())
                )
                dir_attempt0_started.set()
                dir_main_thread_emitted.wait(timeout=2.0)
                err = PermissionError(13, "Access is denied")
                err.winerror = 5
                raise err
            watched_during_dir_rename.append(
                list(self.studio.note_watcher.files() + self.studio.note_watcher.directories())
            )
            return orig_path_rename(self_path, target)

        renamed_dir = self.workspace / "ProblemSets"
        remapped_note = renamed_dir / "1.3 Systems.md"
        with (
            mock.patch.object(studio, "_is_windows", return_value=True, create=True),
            mock.patch.object(Path, "rename", spy_path_rename),
        ):
            rename_dialog.accept()
            self.assertTrue(dir_attempt0_started.wait(timeout=2.0))
            # Even if an unrelated _emit/_watch_notes fires while the async folder rename is in flight,
            # suspended paths must not be re-added to QFileSystemWatcher before rename finishes.
            self.studio._emit(False)
            dir_main_thread_emitted.set()
            self.wait_until(
                lambda: remapped_note.is_file()
                and not self.studio._folder_searching
                and [f["name"] for f in self._qml_dict("sidebarState")["files"]] == ["ProblemSets", "1.3 Systems.md"]
                and self._same_path_list(self._qml_dict("sidebarState")["pinned"], [remapped_note])
                and folder_ops.same_path(self._qml_dict("sidebarState")["recent"][0], remapped_note)
            )
        self.assertEqual(len(watched_during_dir_rename), 2)
        for attempt_watched in watched_during_dir_rename:
            for watched_path in attempt_watched:
                self.assertFalse(
                    folder_ops.matches_path_prefix(watched_path, str(labs_dir), is_directory=True),
                    f"Expected note_watcher to suspend {labs_dir} during folder rename, saw {attempt_watched}",
                )
                self.assertFalse(
                    folder_ops.same_path(watched_path, str(self.workspace)),
                    f"Expected note_watcher to suspend parent {self.workspace} during folder rename, saw {attempt_watched}",
                )
        self.wait_until(
            lambda: [d.property("text") for d in self._list_delegates(files_view)] == ["▾ ProblemSets", "1.3 Systems.md"]
        )

        # Switch sidebar to Contents and verify OutlineList delegates and popupOutlineList retain headings & active noteId.
        self.window.setProperty("sidebarSection", "contents")
        self.wait_until(lambda: len(self._list_delegates(outline_list)) == 2)
        self.assertEqual(outline_list.property("noteId"), created_id)
        self.assertEqual(popup_outline.property("noteId"), created_id)
        self.assertEqual(
            [e["title"] for e in self._qml_dict("sidebarState")["outline"]],
            ["1.2 Signals", "Fourier Transform"],
        )

    def test_pre_outline_tabs_noop_outline_posts_pinned_rename_and_save_as_folder_refresh(self):
        # 1. Fresh/newly opened tabs without any document_outline key must not churn sidebarChanged on unrelated emits.
        overview = self.workspace / "Overview.md"
        self.studio.openFolder(str(self.workspace))
        self.wait_until(lambda: len(self.studio.files) == 3)
        self.studio.openNote(str(overview))
        self.wait_until(lambda: folder_ops.same_path(self.studio._current()["path"], overview))
        self.assertNotIn("outline", self.studio._current())
        self._settle_watchers()

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
        self.wait_until(lambda: self._same_path_list(self._qml_dict("sidebarState")["pinned"], [overview]))

        second_studio = QuietStudio(True, self.session)
        try:
            second_studio.openFolder(str(self.workspace))
            self.wait_until(lambda: len(second_studio.files) == 3)

            renamed_overview = self.workspace / "Course Overview.md"
            watched_across_windows: list[tuple[list[str], list[str]]] = []
            orig_rename = Path.rename
            transient_attempts = 0
            file_attempt0_started = threading.Event()
            file_main_thread_emitted = threading.Event()

            def spy_multiwindow_rename(self_path, target):
                nonlocal transient_attempts
                if transient_attempts == 0:
                    transient_attempts += 1
                    watched_across_windows.append((
                        list(self.studio.note_watcher.files() + self.studio.note_watcher.directories()),
                        list(second_studio.note_watcher.files() + second_studio.note_watcher.directories()),
                    ))
                    file_attempt0_started.set()
                    file_main_thread_emitted.wait(timeout=2.0)
                    err = PermissionError(13, "Sharing violation")
                    err.winerror = 32
                    raise err
                watched_across_windows.append((
                    list(self.studio.note_watcher.files() + self.studio.note_watcher.directories()),
                    list(second_studio.note_watcher.files() + second_studio.note_watcher.directories()),
                ))
                return orig_rename(self_path, target)

            with (
                mock.patch.object(studio, "_is_windows", return_value=True, create=True),
                mock.patch.object(Path, "rename", spy_multiwindow_rename),
            ):
                self.studio.renameNote(active_id, "Course Overview.md")
                self.assertTrue(file_attempt0_started.wait(timeout=2.0))
                self.studio._emit(False)
                second_studio._emit(False)
                file_main_thread_emitted.set()
                self.wait_until(
                    lambda: renamed_overview.is_file()
                    and any(f["name"] == "Course Overview.md" for f in self._qml_dict("sidebarState")["files"])
                    and any(f["name"] == "Course Overview.md" for f in second_studio.files)
                    and self._same_path_list(self._qml_dict("sidebarState")["pinned"], [renamed_overview])
                )
            self.assertEqual(len(watched_across_windows), 2)
            for first_watched, second_watched in watched_across_windows:
                for watched_path in first_watched + second_watched:
                    self.assertFalse(folder_ops.same_path(watched_path, str(overview)))
                    self.assertFalse(folder_ops.same_path(watched_path, str(self.workspace)))
            self.assertFalse(self._contains_path(self._qml_dict("sidebarState")["recent"], overview))
            self.assertTrue(self._contains_path(self._qml_dict("sidebarState")["recent"], renamed_overview))
            self.assertIn("Course Overview.md", [f["name"] for f in json.loads(second_studio.sidebarSnapshot)["files"]])
        finally:
            self._retire_window(second_studio)

        # 4. Saving a new note via saveAs inside an unexpanded subfolder refreshes active folderFilter results immediately.
        filter_field = self.named("folderFilterField")
        filter_field.setProperty("text", "week")
        self.wait_until(
            lambda: not self.studio._folder_searching
            and not self.studio.filter_timer.isActive()
            and [f["name"] for f in self._qml_dict("sidebarState")["files"]] == ["Coursework", "Week 1.md"]
        )
        self.studio.newNote()
        week3_id = self.studio.active
        week3_path = self.workspace / "Coursework" / "Week 3.md"
        self.studio.post("week3-edit", "document_changed", json.dumps({"id": week3_id, "content": "# Week 3"}))
        self.studio.saveAs(str(week3_path))
        self.wait_until(
            lambda: week3_path.is_file()
            and not self.studio._folder_searching
            and [f["name"] for f in self._qml_dict("sidebarState")["files"]] == ["Coursework", "Week 1.md", "Week 3.md"]
        )


if __name__ == "__main__":
    unittest.main()
