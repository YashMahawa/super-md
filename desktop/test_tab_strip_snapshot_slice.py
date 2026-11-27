"""Focused regression suite for Desktop TabStrip snapshot slicing and delegate stability."""
from __future__ import annotations

import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import textwrap
import time
import unittest

DESKTOP = Path(__file__).resolve().parent
if str(DESKTOP) not in sys.path:
    sys.path.insert(0, str(DESKTOP))

MAIN_QML = DESKTOP / "qml" / "Main.qml"
_ISOLATED_HARNESS_ENV = "SUPERMD_TAB_STRIP_ISOLATED_HARNESS"
_IS_ISOLATED_SUBPROCESS = os.environ.get(_ISOLATED_HARNESS_ENV) == "1"

if _IS_ISOLATED_SUBPROCESS:
    os.environ["QT_QUICK_CONTROLS_STYLE"] = "Material"
    os.environ.pop("QT_STYLE_OVERRIDE", None)
    os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
    os.environ.setdefault("QT_QUICK_BACKEND", "software")

    from PySide6.QtCore import QEvent, QMimeData, QObject, QPoint, QPointF, Qt, QUrl
    from PySide6.QtGui import QColor, QDragEnterEvent, QDragMoveEvent, QDropEvent, QGuiApplication
    from PySide6.QtQml import QQmlComponent, QQmlEngine
    from PySide6.QtQuick import QQuickItem
    from PySide6.QtQuickControls2 import QQuickStyle
    from PySide6.QtTest import QTest

    if QGuiApplication.instance() is not None:
        raise RuntimeError("Isolated TabStrip QML harness requires a fresh process before QGuiApplication startup")
    QQuickStyle.setStyle("Material")

    import folder_ops
    from studio import Session, Studio

    class QuietStudio(Studio):
        def _choose_default_python(self, emit=True):
            self.python_status = "No Python interpreter configured."


def _extract_qml_function(qml: str, signature: str) -> str:
    start = qml.index(signature)
    brace = qml.index("{", start)
    depth = 0
    for end in range(brace, len(qml)):
        if qml[end] == "{":
            depth += 1
        elif qml[end] == "}":
            depth -= 1
            if depth == 0:
                return textwrap.dedent(qml[start : end + 1]).rstrip()
    raise AssertionError(f"Could not extract QML function: {signature}")


def _build_main_chrome_harness_qml() -> bytes:
    qml = MAIN_QML.read_text(encoding="utf-8")
    tab_strip_start = qml.index("        TabStrip {\n")
    tab_strip_end = qml.index("        Rectangle { width: parent.width; height: 1; color: viewState.colors.outline", tab_strip_start)
    tab_strip_block = textwrap.dedent(qml[tab_strip_start:tab_strip_end]).rstrip()

    sidebar_start = qml.index("        WorkspaceSidebar {")
    sidebar_end = qml.index("        Item {\n            SplitView.fillWidth: true", sidebar_start)
    sidebar_pane = textwrap.dedent(qml[sidebar_start:sidebar_end]).rstrip()
    sidebar_pane = sidebar_pane.replace(
        "WorkspaceSidebar {",
        "WorkspaceSidebar {\n    Layout.preferredWidth: 260\n    Layout.fillHeight: true",
        1,
    )

    hint_fn = _extract_qml_function(qml, "    function hintWithShortcut(label, key, fallback)")
    focus_fn = _extract_qml_function(qml, "    function nativeTextEditorFocused()")
    enabled_fn = _extract_qml_function(qml, "    function shortcutEnabled(action)")
    activate_fn = _extract_qml_function(qml, "    function activateShortcut(action)")

    harness = f"""import QtQuick
import QtQuick.Controls
import QtQuick.Controls.Material
import QtQuick.Layouts

ApplicationWindow {{
    id: window
    width: 1040
    height: 680
    visible: true
    color: viewState.colors.surface
    property var viewState: JSON.parse(studio.snapshot)
    property var tabsState: JSON.parse(studio.tabsSnapshot)
    property string activeTabId: studio.activeTabId
    property var sidebarState: JSON.parse(studio.sidebarSnapshot)
    property var shortcutBindings: JSON.parse(studio.shortcutBindings)
    property var shortcutLabels: JSON.parse(studio.shortcutLabels)
    property var reader: null
    property bool sidebar: true
    property bool settingsOpen: false
    property bool capturingShortcut: false
    property string sidebarSection: "folder"
    property bool chromeAwake: true
    property int contextMenuCount: 0
    property int modalDialogCount: 0
    property int viewStateEvaluations: 0
    property int tabsStateEvaluations: 0
    property int activeTabEvaluations: 0
    property int sidebarStateEvaluations: 0
    property string lastClosePromptName: ""
    property int closePromptCount: 0
    onViewStateChanged: viewStateEvaluations += 1
    onTabsStateChanged: tabsStateEvaluations += 1
    onActiveTabIdChanged: activeTabEvaluations += 1
    onSidebarStateChanged: sidebarStateEvaluations += 1
    function focusReader() {{}}
    function openFind() {{}}
    function runDocumentScript() {{}}
    function runDocumentScriptWithCallback() {{}}
    function nativeReaderEditAction() {{}}
    QtObject {{ id: openDialog; function open() {{}} }}
    QtObject {{ id: contentsPopup; property bool visible: false }}
    QtObject {{ id: windowModes; property bool fullscreen: false; function setFullscreen(v) {{ fullscreen = v }} }}
    Connections {{
        target: studio
        function onCloseRequested(name) {{
            window.lastClosePromptName = name
            window.closePromptCount += 1
        }}
    }}
{textwrap.indent(hint_fn, "    ")}
{textwrap.indent(focus_fn, "    ")}
{textwrap.indent(enabled_fn, "    ")}
{textwrap.indent(activate_fn, "    ")}
    Material.theme: viewState.dark ? Material.Dark : Material.Light
    Material.primary: viewState.colors.primary
    Material.accent: viewState.colors.primary
    Material.background: viewState.colors.surface
    Material.foreground: viewState.colors["on-surface"]

    header: Column {{
        width: parent.width
{textwrap.indent(tab_strip_block, "        ")}
        Rectangle {{ width: parent.width; height: 1; color: viewState.colors.outline; opacity: .55 }}
    }}

    RowLayout {{
        anchors.fill: parent
        spacing: 0
{textwrap.indent(sidebar_pane, "        ")}
        Item {{ Layout.fillWidth: true; Layout.fillHeight: true }}
    }}
}}
"""
    return harness.encode("utf-8")


class TabStripSnapshotSliceTest(unittest.TestCase):
    _CASE_NAMES = (
        "test_unrelated_snapshots_keep_tab_delegates_alive_and_skip_tabs_slice_reparsing",
        "test_dirty_state_and_active_tab_update_in_actual_tab_strip_without_delegate_churn",
        "test_reorder_close_reopen_and_detach_in_actual_tab_strip",
        "test_folder_sidebar_rename_shortcut_uses_tabs_slice_for_in_folder_and_untitled_tabs",
    )
    _isolated_suite_outcomes: dict[str, dict[str, object]] | None = None
    _isolated_suite_output: tuple[int, str, str] = (0, "", "")

    @classmethod
    def setUpClass(cls):
        if not _IS_ISOLATED_SUBPROCESS:
            cls._isolated_suite_outcomes = None
            cls._isolated_suite_output = (0, "", "")
            return
        if QGuiApplication.instance() is None:
            QQuickStyle.setStyle("Material")
        cls.app = QGuiApplication.instance() or QGuiApplication(["TabStrip snapshot slice tests"])
        if QQuickStyle.name().lower() != "material":
            raise AssertionError(f"Expected Qt Quick Material style, got {QQuickStyle.name()!r}")

    @classmethod
    def _ensure_isolated_suite_ran(cls) -> None:
        if cls._isolated_suite_outcomes is not None:
            return
        env = os.environ.copy()
        env[_ISOLATED_HARNESS_ENV] = "1"
        env["QT_QUICK_CONTROLS_STYLE"] = "Material"
        env.pop("QT_STYLE_OVERRIDE", None)
        env.setdefault("QT_QPA_PLATFORM", "offscreen")
        env.setdefault("QT_QUICK_BACKEND", "software")
        with tempfile.TemporaryDirectory(prefix="supermd-tabstrip-isolated-") as tmp_dir:
            report_path = Path(tmp_dir) / "outcomes.json"
            proc = subprocess.run(
                [sys.executable, str(Path(__file__).resolve()), "--isolated-suite", str(report_path)],
                cwd=str(DESKTOP.parent),
                env=env,
                capture_output=True,
                text=True,
                timeout=120,
            )
            cls._isolated_suite_output = (proc.returncode, proc.stdout, proc.stderr)
            if report_path.is_file():
                cls._isolated_suite_outcomes = json.loads(report_path.read_text(encoding="utf-8"))
            else:
                cls._isolated_suite_outcomes = {}

    def _run_isolated_case(self, case_name: str) -> None:
        type(self)._ensure_isolated_suite_ran()
        outcomes = type(self)._isolated_suite_outcomes or {}
        returncode, stdout, stderr = type(self)._isolated_suite_output
        outcome = outcomes.get(case_name)
        if outcome is None or not outcome.get("ok"):
            details = outcome.get("details", "") if isinstance(outcome, dict) else ""
            self.fail(
                f"Isolated Material QML harness failed for {case_name} (exit {returncode}):\n"
                f"{details}\n--- STDOUT ---\n{stdout}\n--- STDERR ---\n{stderr}"
            )
        if returncode != 0 and all(item.get("ok") for item in outcomes.values()):
            self.fail(
                f"Isolated Material QML harness exited non-zero ({returncode}) after {case_name}:\n"
                f"--- STDOUT ---\n{stdout}\n--- STDERR ---\n{stderr}"
            )

    def setUp(self):
        if not _IS_ISOLATED_SUBPROCESS:
            return
        self.session = Session(True)
        self.session.settings["welcomed"] = True
        self.session.settings["motion"] = False
        self.session.settings["autosave"] = False
        self.studio = QuietStudio(True, self.session)
        raw_ws = self.studio.data / "Workspace"
        raw_ws.mkdir(parents=True, exist_ok=True)
        self.workspace = Path(folder_ops.canonical_path_str(raw_ws))
        (self.workspace / "Overview.md").write_text("# Overview\n\nInitial overview paragraph.", encoding="utf-8")
        (self.workspace / "Reading.md").write_text("# Reading\n\nChapter reading notes.", encoding="utf-8")
        coursework = self.workspace / "Coursework"
        coursework.mkdir()
        (coursework / "Week 1.md").write_text("# Week 1\n\nSeminar exercises.", encoding="utf-8")

        self.qml_warnings: list[str] = []
        self.engine, self.component, self.window = self._mount_window(self.studio)

    def _mount_window(self, studio_instance: Studio):
        engine = QQmlEngine()
        engine.warnings.connect(
            lambda warnings: self.qml_warnings.extend(w.toString() for w in warnings)
        )
        qml_dir = DESKTOP / "qml"
        engine.addImportPath(str(qml_dir))
        engine.rootContext().setContextProperty("studio", studio_instance)
        component = QQmlComponent(engine)
        component.setData(
            _build_main_chrome_harness_qml(),
            QUrl.fromLocalFile(str(qml_dir / "__tab_strip_slice_harness__.qml")),
        )
        self.assertFalse(component.isError(), str(component.errors()))
        window = component.create()
        self.assertIsNotNone(window, str(component.errors()))
        QTest.qWait(40)
        self._polish(window)
        return engine, component, window

    def _destroy_window(self, engine, window):
        if window is not None:
            window.close()
            window.deleteLater()
            self.app.sendPostedEvents(None, QEvent.Type.DeferredDelete)
        if engine is not None:
            engine.deleteLater()
            self.app.sendPostedEvents(None, QEvent.Type.DeferredDelete)

    def _retire_studio(self, st: Studio):
        st.external_timer.stop()
        st.external_paths.clear()
        if not st.retired:
            st.stop()
        st.pool.shutdown(wait=True, cancel_futures=True)
        st._search_pool.shutdown(wait=True, cancel_futures=True)

    def tearDown(self):
        if not _IS_ISOLATED_SUBPROCESS:
            return
        data_dir = self.studio.data
        try:
            self._destroy_window(self.engine, self.window)
            for win in list(self.session.windows.values()):
                self._retire_studio(win)
            self._retire_studio(self.studio)
            self.session.writes.shutdown(wait=True)
            self.app.processEvents()
            self.assertEqual(self.qml_warnings, [], f"Unexpected QML warnings: {self.qml_warnings}")
        finally:
            shutil.rmtree(data_dir, ignore_errors=True)

    def _polish(self, win=None):
        target = win or self.window
        self.app.processEvents()
        if target is not None:
            QTest.qWaitForWindowExposed(target, 200)
        QTest.qWait(20)
        self.app.processEvents()

    def wait_until(self, predicate, timeout=5.0):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            self.app.processEvents()
            if predicate():
                return
            QTest.qWait(15)
        self.app.processEvents()
        self.assertTrue(predicate(), "Timed out waiting for condition")

    def _iter_items(self, root_item: QQuickItem):
        stack = [root_item]
        while stack:
            current = stack.pop()
            yield current
            stack.extend(reversed(current.childItems()))

    def _tab_strip(self, win=None) -> QQuickItem:
        target = win or self.window
        strip = target.findChild(QQuickItem, "tabStrip")
        self.assertIsNotNone(strip)
        return strip

    def _note_tabs(self, win=None) -> list[QQuickItem]:
        self._polish(win)
        strip = self._tab_strip(win)
        tabs = [item for item in self._iter_items(strip) if item.objectName() == "noteTab" and item.isVisible()]
        tabs.sort(key=lambda item: float(item.x()))
        return tabs

    def _child_named(self, parent_item: QQuickItem, object_name: str) -> QQuickItem:
        for child in self._iter_items(parent_item):
            if child.objectName() == object_name:
                return child
        raise AssertionError(f"Missing child {object_name!r} under {parent_item}")

    def _drop_tab_payload_at(self, win, scene_point: QPoint, payload: dict) -> bool:
        mime = QMimeData()
        mime.setData("application/x-supermd-tab", json.dumps(payload).encode("utf-8"))
        enter = QDragEnterEvent(
            scene_point,
            Qt.DropAction.MoveAction,
            mime,
            Qt.MouseButton.LeftButton,
            Qt.KeyboardModifier.NoModifier,
        )
        self.app.sendEvent(win, enter)
        move = QDragMoveEvent(
            scene_point,
            Qt.DropAction.MoveAction,
            mime,
            Qt.MouseButton.LeftButton,
            Qt.KeyboardModifier.NoModifier,
        )
        self.app.sendEvent(win, move)
        drop = QDropEvent(
            QPointF(scene_point),
            Qt.DropAction.MoveAction,
            mime,
            Qt.MouseButton.LeftButton,
            Qt.KeyboardModifier.NoModifier,
        )
        self.app.sendEvent(win, drop)
        QTest.qWait(35)
        self._polish(win)
        return drop.isAccepted()

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
        delegates.sort(key=lambda child: (round(float(child.y()), 2), round(float(child.x()), 2)))
        return delegates

    def test_unrelated_snapshots_keep_tab_delegates_alive_and_skip_tabs_slice_reparsing(self):
        if not _IS_ISOLATED_SUBPROCESS:
            self._run_isolated_case(
                "test_unrelated_snapshots_keep_tab_delegates_alive_and_skip_tabs_slice_reparsing"
            )
            return
        overview = self.workspace / "Overview.md"
        reading = self.workspace / "Reading.md"
        coursework = self.workspace / "Coursework"
        week1 = coursework / "Week 1.md"

        self.studio.openFolder(str(self.workspace))
        self.wait_until(lambda: len(self.studio.files) == 3)
        initial_starter_id = self.studio.tabs[0]["id"]
        for note_path in (overview, reading, week1):
            self.studio.openNote(str(note_path))
            self.wait_until(lambda p=note_path: any(folder_ops.same_path(t["path"], p) for t in self.studio.tabs))
        self.studio.closeTabSafely(initial_starter_id)
        self.studio.pinRecent(str(overview))
        self.wait_until(lambda: len(self._note_tabs()) == 3)

        files_view = self.window.findChild(QQuickItem, "folderFilesView")
        recent_notes = self.window.findChild(QQuickItem, "sidebarRecentNotes")
        self.assertIsNotNone(files_view)
        self.assertIsNotNone(recent_notes)
        self.wait_until(lambda: len(self._list_delegates(files_view)) == 3 and len(self._list_delegates(recent_notes)) >= 1)

        initial_tabs = self._note_tabs()
        self.assertEqual([t.property("tabId") for t in initial_tabs], [t["id"] for t in self.studio.tabs])
        destroyed_tabs: list[str] = []
        for tab_item in initial_tabs:
            tid = str(tab_item.property("tabId"))
            tab_item.destroyed.connect(lambda _obj=None, tid=tid: destroyed_tabs.append(tid))

        # Make active tab (Week 1.md) dirty once so subsequent body text edits are pure text churn.
        week1_id = self.studio.active
        self.studio.post(
            "dirty-init",
            "document_changed",
            json.dumps({"id": week1_id, "content": "# Week 1\n\nInitial dirty body."}),
        )
        self._polish()
        # Even flipping dirty kept every noteTab delegate alive in place.
        self.assertEqual(destroyed_tabs, [])
        self.assertEqual(self._note_tabs(), initial_tabs)

        # Settle watchers before counting slice signals.
        QTest.qWait(50)
        self.app.processEvents()

        baseline_tabs_json = self.studio.tabsSnapshot
        tabs_cache_before = self.studio._tabs_slice_cache
        changed_signals: list[int] = []
        tabs_signals: list[int] = []
        active_signals: list[int] = []
        self.studio.changed.connect(lambda: changed_signals.append(1))
        self.studio.tabsChanged.connect(lambda: tabs_signals.append(1))
        self.studio.activeTabChanged.connect(lambda: active_signals.append(1))

        view_evals_before = int(self.window.property("viewStateEvaluations"))
        tabs_evals_before = int(self.window.property("tabsStateEvaluations"))
        active_evals_before = int(self.window.property("activeTabEvaluations"))
        strip = self._tab_strip()

        # Fire unrelated snapshots: body text edits, zoom, status/busy, mode, overlays, settings, outline, folder ops, pins.
        for rev in range(1, 5):
            self.studio.post(
                f"body-edit-{rev}",
                "document_changed",
                json.dumps({"id": week1_id, "content": f"# Week 1\n\nStreaming paragraph revision {rev}."}),
            )
        self.studio.setZoom(145)
        self.studio.setZoom(110)
        self.studio.notifyMessage("Saved layout state")
        self.studio.busy = 1
        self.studio._emit(False)
        self.studio.busy = 0
        self.studio._emit(False)
        self.studio.setMode("reader")
        self.studio.setMode("split")
        self.studio.setMode("live")
        self.studio.post("overlay-open", "reader_overlay_changed", json.dumps({"open": True, "image": False}))
        self.studio.post("overlay-close", "reader_overlay_changed", json.dumps({"open": False, "image": False}))
        self.studio.setting("typewriterScroll", "true")
        self.studio.setting("centerLock", "false")
        self.studio.post(
            "outline-saved-note",
            "document_outline",
            json.dumps({
                "id": week1_id,
                "headings": [
                    {"title": "Week 1", "level": 1, "offset": 0},
                    {"title": "Part B", "level": 2, "offset": 18},
                ],
            }),
        )
        self.studio.toggleDirectory(str(coursework))
        self.wait_until(lambda: len(self.studio.files) == 4)
        self.studio.setFolderFilter("Week")
        self.wait_until(lambda: all("Week" in f["name"] or f["directory"] for f in self.studio.files))
        self.studio.setFolderFilter("")
        self.wait_until(lambda: len(self.studio.files) == 4)
        self.studio.pinRecent(str(reading))
        self._polish()

        self.assertGreaterEqual(len(changed_signals), 14)
        self.assertGreaterEqual(int(self.window.property("viewStateEvaluations")) - view_evals_before, 14)
        self.assertEqual(len(tabs_signals), 0, "Unrelated snapshots must never emit tabsChanged")
        self.assertEqual(len(active_signals), 0, "Unrelated snapshots must never emit activeTabChanged")
        self.assertEqual(int(self.window.property("tabsStateEvaluations")) - tabs_evals_before, 0)
        self.assertEqual(int(self.window.property("activeTabEvaluations")) - active_evals_before, 0)
        self.assertIs(self.studio.tabsSnapshot, baseline_tabs_json)
        self.assertIs(self.studio._tabs_slice_cache, tabs_cache_before)
        self.assertFalse(bool(strip.property("rebuildingTabs")))
        self.assertEqual(destroyed_tabs, [])
        self.assertEqual(self._note_tabs(), initial_tabs)

        # #105 sidebar slice still reflects the outline, expanded folder, and pinned recent updates.
        sidebar_state = self.window.property("sidebarState").toVariant()
        self.assertEqual([h["title"] for h in sidebar_state["outline"]], ["Week 1", "Part B"])
        self.assertEqual(len(sidebar_state["pinned"]), 2)
        self.assertEqual(len(self._list_delegates(files_view)), 4)

    def test_dirty_state_and_active_tab_update_in_actual_tab_strip_without_delegate_churn(self):
        if not _IS_ISOLATED_SUBPROCESS:
            self._run_isolated_case(
                "test_dirty_state_and_active_tab_update_in_actual_tab_strip_without_delegate_churn"
            )
            return
        overview = self.workspace / "Overview.md"
        reading = self.workspace / "Reading.md"
        portable_path = self.workspace / "Diagram.smd"

        self.studio.openFolder(str(self.workspace))
        self.wait_until(lambda: len(self.studio.files) == 3)
        initial_starter_id = self.studio.tabs[0]["id"]
        self.studio.createFolderNote(str(self.workspace), "Diagram", "smd")
        self.wait_until(lambda: portable_path.is_file() and folder_ops.same_path(self.studio._current()["path"], portable_path))
        portable_id = self.studio.active
        self.studio.closeTabSafely(initial_starter_id)

        self.studio.openNote(str(overview))
        self.wait_until(lambda: folder_ops.same_path(self.studio._current()["path"], overview))
        overview_id = self.studio.active

        self.studio.openNote(str(reading))
        self.wait_until(lambda: folder_ops.same_path(self.studio._current()["path"], reading))
        reading_id = self.studio.active
        self.wait_until(lambda: len(self._note_tabs()) == 3)

        initial_tabs = self._note_tabs()
        by_id = {str(item.property("tabId")): item for item in initial_tabs}
        destroyed: list[str] = []
        for tid, item in by_id.items():
            item.destroyed.connect(lambda _obj=None, tid=tid: destroyed.append(tid))

        # 1. Active tab click, selectTab, cycleTab, and tabNumber in actual TabStrip keep all delegates alive.
        tabs_signals: list[int] = []
        active_signals: list[int] = []
        self.studio.tabsChanged.connect(lambda: tabs_signals.append(1))
        self.studio.activeTabChanged.connect(lambda: active_signals.append(1))

        overview_label = self._child_named(by_id[overview_id], "noteTabLabel")
        click_pt = overview_label.mapToScene(QPointF(overview_label.width() / 2, overview_label.height() / 2)).toPoint()
        QTest.mouseClick(self.window, Qt.MouseButton.LeftButton, Qt.KeyboardModifier.NoModifier, click_pt)
        self._polish()

        self.assertEqual(self.studio.active, overview_id)
        self.assertEqual(self.window.property("activeTabId"), overview_id)
        self.assertTrue(bool(by_id[overview_id].property("isActive")))
        self.assertFalse(bool(by_id[reading_id].property("isActive")))
        colors = self.window.property("viewState").toVariant()["colors"]
        self.assertEqual(QColor(by_id[overview_id].property("color")).name(), QColor(colors["surface-high"]).name())
        self.assertEqual(QColor(by_id[reading_id].property("color")).name(), QColor(colors["surface"]).name())
        self.assertEqual(len(tabs_signals), 0, "Switching active tab must not emit tabsChanged")
        self.assertEqual(len(active_signals), 1)
        self.assertEqual(destroyed, [])

        # Verify cycleTab and tabNumber shortcuts update activeTabId without tabsChanged.
        self.studio.cycleTab(1)
        self._polish()
        self.assertEqual(self.studio.active, reading_id)
        self.assertTrue(bool(by_id[reading_id].property("isActive")))
        self.window.activateShortcut("tab_1")
        self._polish()
        self.assertEqual(self.studio.active, portable_id)
        self.assertTrue(bool(by_id[portable_id].property("isActive")))
        self.assertEqual(len(tabs_signals), 0)
        self.assertEqual(destroyed, [])

        # 2. Dirty state false -> true -> false via document_patch and saveSafely updates "• " in place.
        self.studio.selectTab(overview_id)
        self._polish()
        self.assertEqual(overview_label.property("text"), "Overview.md")
        base_text = self.studio._current()["content"]
        self.studio.post(
            "sync-overview",
            "document_sync",
            json.dumps({"id": overview_id, "epoch": "ep1", "revision": 0, "content": base_text}),
        )
        suffix = "\n\nAdded section"
        self.studio.post(
            "patch-overview-dirty",
            "document_patch",
            json.dumps({
                "id": overview_id,
                "epoch": "ep1",
                "baseRevision": 0,
                "revision": 1,
                "changes": [{"from": len(base_text), "to": len(base_text), "insert": suffix}],
            }),
        )
        self.wait_until(lambda: overview_label.property("text") == "• Overview.md")
        self.assertEqual(destroyed, [], "Dirty state toggle must keep noteTab delegates alive")
        self.assertEqual(self._note_tabs(), initial_tabs)

        self.studio.saveSafely()
        self.session.writes.flush(timeout=3.0)
        self.wait_until(lambda: overview_label.property("text") == "Overview.md")
        self.assertEqual(destroyed, [], "Saving dirty tab must keep noteTab delegates alive")

        # 3. Portable .smd assets_dirty also reflects "• " in TabStrip and clears on save.
        portable_label = self._child_named(by_id[portable_id], "noteTabLabel")
        self.studio.selectTab(portable_id)
        self._polish()
        self.assertEqual(portable_label.property("text"), "Diagram.smd")
        portable_tab = next(t for t in self.studio.tabs if t["id"] == portable_id)
        portable_tab["assets"]["assets/img-1.png"] = (
            "data:image/png;base64,"
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="
        )
        portable_tab["assets_dirty"] = True
        self.studio._emit(False)
        self.wait_until(lambda: portable_label.property("text") == "• Diagram.smd")
        self.studio.saveSafely()
        self.session.writes.flush(timeout=3.0)
        self.wait_until(lambda: portable_label.property("text") == "Diagram.smd")
        self.assertEqual(destroyed, [])

        # 4. Duplicate-filename tab disambiguation updates parentContext in place via tabsSnapshot without delegate churn.
        dup_overview = self.workspace / "Coursework" / "Overview.md"
        dup_overview.write_text("# Coursework Overview\n", encoding="utf-8")
        self.studio.openNote(str(dup_overview))
        self.wait_until(lambda: folder_ops.same_path(self.studio._current()["path"], dup_overview))
        dup_overview_id = self.studio.active
        self.wait_until(lambda: overview_label.property("text") == f"Overview.md · {self.workspace.name}")
        dup_item = next(t for t in self._note_tabs() if str(t.property("tabId")) == dup_overview_id)
        dup_label = self._child_named(dup_item, "noteTabLabel")
        self.assertEqual(dup_label.property("text"), "Overview.md · Coursework")
        self.assertEqual(by_id[overview_id].property("parentContext"), self.workspace.name)
        self.assertEqual(dup_item.property("parentContext"), "Coursework")
        self.assertEqual(destroyed, [], "Opening duplicate-filename tab must keep existing noteTab delegates alive")
        self.studio.closeTabSafely(dup_overview_id)
        self.wait_until(lambda: overview_label.property("text") == "Overview.md")
        self.assertEqual(by_id[overview_id].property("parentContext"), "")
        self.assertEqual(destroyed, [], "Closing duplicate-filename tab must keep surviving noteTab delegates alive")

        # 5. Narrow overflowing strip still reveals newly activated edge tabs.
        for idx in range(5):
            p = self.workspace / f"Extra {idx}.md"
            p.write_text(f"# Extra {idx}\n", encoding="utf-8")
            self.studio.openNote(str(p))
            self.wait_until(lambda path=p: any(folder_ops.same_path(t["path"], path) for t in self.studio.tabs))
        self.window.setWidth(520)
        self._polish()
        strip = self._tab_strip()
        flickable = strip.property("contentItem")
        for target_id in (self.studio.tabs[0]["id"], self.studio.tabs[-1]["id"]):
            self.studio.selectTab(target_id)
            self._polish()
            QTest.qWait(30)
            active_item = next(t for t in self._note_tabs() if str(t.property("tabId")) == target_id)
            content_x = float(flickable.property("contentX"))
            viewport_w = float(strip.property("availableWidth") or strip.width())
            self.assertGreaterEqual(active_item.x() + 0.5, content_x)
            self.assertLessEqual(active_item.x() + active_item.width() - 0.5, content_x + viewport_w)

    def test_reorder_close_reopen_and_detach_in_actual_tab_strip(self):
        if not _IS_ISOLATED_SUBPROCESS:
            self._run_isolated_case("test_reorder_close_reopen_and_detach_in_actual_tab_strip")
            return
        overview = self.workspace / "Overview.md"
        reading = self.workspace / "Reading.md"
        week1 = self.workspace / "Coursework" / "Week 1.md"

        initial_starter_id = self.studio.tabs[0]["id"]
        for note_path in (overview, reading, week1):
            self.studio.openNote(str(note_path))
            self.wait_until(lambda p=note_path: any(folder_ops.same_path(t["path"], p) for t in self.studio.tabs))
        self.studio.closeTabSafely(initial_starter_id)
        self.wait_until(lambda: len(self._note_tabs()) == 3)

        t0, t1, t2 = [t["id"] for t in self.studio.tabs]
        self.assertEqual(self.studio.active, t2)
        destroyed_ids: list[str] = []
        for tab_item in self._note_tabs():
            tid = str(tab_item.property("tabId"))
            tab_item.destroyed.connect(lambda _obj=None, tid=tid: destroyed_ids.append(tid))

        # 1. Reorder via moveActiveTab(-1) and moveActiveTab(1) updates visual Row x() order without destroying delegates.
        self.studio.moveActiveTab(-1)
        self.wait_until(lambda: [str(t.property("tabId")) for t in self._note_tabs()] == [t0, t2, t1])
        self.assertEqual(self.studio.active, t2)
        self.assertEqual(destroyed_ids, [])

        self.studio.moveActiveTab(-1)
        self.wait_until(lambda: [str(t.property("tabId")) for t in self._note_tabs()] == [t2, t0, t1])
        self.assertEqual(self.studio.active, t2)

        self.studio.moveActiveTab(1)
        self.wait_until(lambda: [str(t.property("tabId")) for t in self._note_tabs()] == [t0, t2, t1])

        # 2. Reorder via real application/x-supermd-tab drop onto first tab (before midpoint) and newTabButton (end).
        first_tab_item = self._note_tabs()[0]
        before_pt = first_tab_item.mapToScene(QPointF(6.0, first_tab_item.height() / 2)).toPoint()
        self.assertTrue(self._drop_tab_payload_at(self.window, before_pt, {"window": self.studio.window_id, "tab": t1}))
        self.wait_until(lambda: [str(t.property("tabId")) for t in self._note_tabs()] == [t1, t0, t2])
        self.assertEqual(self.studio.active, t2)

        plus_btn = self._child_named(self._tab_strip(), "newTabButton")
        plus_pt = plus_btn.mapToScene(QPointF(plus_btn.width() / 2, plus_btn.height() / 2)).toPoint()
        self.assertTrue(self._drop_tab_payload_at(self.window, plus_pt, {"window": self.studio.window_id, "tab": t1}))
        self.wait_until(lambda: [str(t.property("tabId")) for t in self._note_tabs()] == [t0, t2, t1])

        # Also test dropping after midpoint of the first tab -> inserts at index 1; zero delegates destroyed across all reorders.
        first_now = self._note_tabs()[0]
        after_pt = first_now.mapToScene(QPointF(first_now.width() - 6.0, first_now.height() / 2)).toPoint()
        self.assertTrue(self._drop_tab_payload_at(self.window, after_pt, {"window": self.studio.window_id, "tab": t1}))
        self.wait_until(lambda: [str(t.property("tabId")) for t in self._note_tabs()] == [t0, t1, t2])
        self.assertEqual(destroyed_ids, [])

        # 3. Detach dirty tab to a second live QML TabStrip window, then drag-drop back into first window.
        self.studio.post(
            "dirty-reading-detach",
            "document_changed",
            json.dumps({"id": t1, "content": "# Reading\n\nUnsaved notes carried across detach."}),
        )
        self.wait_until(
            lambda: self._child_named(
                next(it for it in self._note_tabs() if str(it.property("tabId")) == t1),
                "noteTabLabel",
            ).property("text")
            == "• Reading.md"
        )

        second_studio = None
        second_engine = second_component = second_window = None
        detached_requests: list[tuple[str, str]] = []

        def on_detached_window_requested(source_id: str, tab_id: str):
            nonlocal second_studio, second_engine, second_component, second_window
            detached_requests.append((source_id, tab_id))
            source = self.session.windows.get(source_id)
            self.assertIsNotNone(source)
            second_studio = QuietStudio(True, self.session)
            second_studio.mode = source.mode
            second_studio.tabs = []
            self.assertTrue(source._move_tab(second_studio, tab_id, 0))
            second_engine, second_component, second_window = self._mount_window(second_studio)

        self.studio.detachedWindowRequested.connect(on_detached_window_requested)
        try:
            # Trigger "Move to new window" from the actual TabStrip context menu item on t1.
            t1_delegate = next(it for it in self._note_tabs() if str(it.property("tabId")) == t1)
            detach_action = t1_delegate.findChild(QObject, "detachTabAction")
            self.assertIsNotNone(detach_action)
            detach_action.triggered.emit()

            self.wait_until(
                lambda: detached_requests == [(self.studio.window_id, t1)]
                and [str(t.property("tabId")) for t in self._note_tabs()] == [t0, t2]
            )
            # Detaching t1 destroys only t1's delegate; surviving t0 and t2 delegates stay alive.
            self.app.sendPostedEvents(None, QEvent.Type.DeferredDelete)
            self.assertEqual(destroyed_ids, [t1])

            self.wait_until(lambda: [str(t.property("tabId")) for t in self._note_tabs(second_window)] == [t1])
            detached_item = self._note_tabs(second_window)[0]
            self.assertTrue(bool(detached_item.property("isActive")))
            self.assertEqual(
                self._child_named(detached_item, "noteTabLabel").property("text"),
                "• Reading.md",
            )
            self.assertEqual(second_studio._current()["content"], "# Reading\n\nUnsaved notes carried across detach.")

            # Cross-window drop from second_studio back onto first window's first tab (index 0).
            target_first = self._note_tabs(self.window)[0]
            cross_pt = target_first.mapToScene(QPointF(5.0, target_first.height() / 2)).toPoint()
            self.assertTrue(
                self._drop_tab_payload_at(
                    self.window,
                    cross_pt,
                    {"window": second_studio.window_id, "tab": t1},
                )
            )
            self.wait_until(lambda: [str(t.property("tabId")) for t in self._note_tabs(self.window)] == [t1, t0, t2])
            self.assertEqual(self.studio.active, t1)
            # Cross-window insert of t1 also keeps surviving t0 and t2 delegates alive.
            self.app.sendPostedEvents(None, QEvent.Type.DeferredDelete)
            self.assertEqual(destroyed_ids, [t1])
            returned_item = self._note_tabs(self.window)[0]
            self.assertEqual(self._child_named(returned_item, "noteTabLabel").property("text"), "• Reading.md")
        finally:
            self._destroy_window(second_engine, second_window)
            if second_studio is not None:
                self._retire_studio(second_studio)

        # 4. Close clean tab via actual "X" button, then reopenTab().
        t2_item = next(it for it in self._note_tabs() if str(it.property("tabId")) == t2)
        t2_close = self._child_named(t2_item, "noteTabCloseButton")
        t2_close_pt = t2_close.mapToScene(QPointF(t2_close.width() / 2, t2_close.height() / 2)).toPoint()
        QTest.mouseClick(self.window, Qt.MouseButton.LeftButton, Qt.KeyboardModifier.NoModifier, t2_close_pt)
        self.wait_until(lambda: [str(t.property("tabId")) for t in self._note_tabs()] == [t1, t0])

        self.studio.reopenTab()
        self.wait_until(lambda: len(self._note_tabs()) == 3 and any(folder_ops.same_path(t["path"], week1) for t in self.studio.tabs))
        t2_reopened = next(t["id"] for t in self.studio.tabs if folder_ops.same_path(t["path"], week1))

        # 5. Close dirty tab via actual "X" button: prompts first, cancel keeps tab, discard closes it.
        t1_item = next(it for it in self._note_tabs() if str(it.property("tabId")) == t1)
        t1_close = self._child_named(t1_item, "noteTabCloseButton")
        t1_close_pt = t1_close.mapToScene(QPointF(t1_close.width() / 2, t1_close.height() / 2)).toPoint()
        QTest.mouseClick(self.window, Qt.MouseButton.LeftButton, Qt.KeyboardModifier.NoModifier, t1_close_pt)
        self.wait_until(lambda: int(self.window.property("closePromptCount")) == 1)
        self.assertEqual(self.window.property("lastClosePromptName"), "Reading.md")
        self.assertIn(t1, [str(t.property("tabId")) for t in self._note_tabs()])

        self.studio.resolveClose("cancel")
        self._polish()
        self.assertIn(t1, [str(t.property("tabId")) for t in self._note_tabs()])

        QTest.mouseClick(self.window, Qt.MouseButton.LeftButton, Qt.KeyboardModifier.NoModifier, t1_close_pt)
        self.wait_until(lambda: int(self.window.property("closePromptCount")) == 2)
        self.studio.resolveClose("discard")
        self.wait_until(lambda: [str(t.property("tabId")) for t in self._note_tabs()] == [t0, t2_reopened])

        # 6. Closing all remaining clean tabs leaves a fresh Untitled.md tab in TabStrip.
        for remaining_id in (t0, t2_reopened):
            rem_item = next(it for it in self._note_tabs() if str(it.property("tabId")) == remaining_id)
            rem_close = self._child_named(rem_item, "noteTabCloseButton")
            pt = rem_close.mapToScene(QPointF(rem_close.width() / 2, rem_close.height() / 2)).toPoint()
            QTest.mouseClick(self.window, Qt.MouseButton.LeftButton, Qt.KeyboardModifier.NoModifier, pt)
            self._polish()
        self.wait_until(
            lambda: len(self._note_tabs()) == 1
            and self._child_named(self._note_tabs()[0], "noteTabLabel").property("text") == "Untitled.md"
        )
        self.assertTrue(bool(self._note_tabs()[0].property("isActive")))

    def test_folder_sidebar_rename_shortcut_uses_tabs_slice_for_in_folder_and_untitled_tabs(self):
        if not _IS_ISOLATED_SUBPROCESS:
            self._run_isolated_case(
                "test_folder_sidebar_rename_shortcut_uses_tabs_slice_for_in_folder_and_untitled_tabs"
            )
            return
        overview = self.workspace / "Overview.md"
        self.studio.openFolder(str(self.workspace))
        self.wait_until(lambda: len(self.studio.files) == 3)
        self.studio.openNote(str(overview))
        self.wait_until(lambda: folder_ops.same_path(self.studio._current()["path"], overview))
        self._polish()

        # Active note inside open folder opens FolderSidebar's renameEntryDialog.
        self.window.activateShortcut("rename_entry")
        self._polish()
        rename_entry_dialog = self.window.findChild(QObject, "renameEntryDialog")
        self.assertIsNotNone(rename_entry_dialog)
        self.assertTrue(bool(rename_entry_dialog.property("visible")))
        rename_entry_dialog.close()
        self._polish()

        # Active untitled note outside open folder opens FolderSidebar's tabFallbackRenameDialog.
        self.studio.newNote()
        self._polish()
        self.window.activateShortcut("rename_entry")
        self._polish()
        fallback_dialog = self.window.findChild(QObject, "tabFallbackRenameDialog")
        self.assertIsNotNone(fallback_dialog)
        self.assertTrue(bool(fallback_dialog.property("visible")))
        fallback_dialog.close()
        self._polish()


def _run_isolated_suite_to_report(report_file: Path) -> int:
    outcomes: dict[str, dict[str, object]] = {}
    TabStripSnapshotSliceTest.setUpClass()
    overall_ok = True
    try:
        for name in TabStripSnapshotSliceTest._CASE_NAMES:
            single_result = unittest.TestResult()
            TabStripSnapshotSliceTest(name)(single_result)
            problems = [tb for _case, tb in (*single_result.failures, *single_result.errors)]
            ok = single_result.wasSuccessful() and single_result.testsRun == 1
            overall_ok = overall_ok and ok
            outcomes[name] = {"ok": ok, "details": "\n".join(problems)}
    finally:
        TabStripSnapshotSliceTest.tearDownClass()
    report_file.write_text(json.dumps(outcomes), encoding="utf-8")
    return 0 if overall_ok else 1


if __name__ == "__main__":
    if len(sys.argv) == 3 and sys.argv[1] == "--isolated-suite":
        if not _IS_ISOLATED_SUBPROCESS:
            raise SystemExit(f"--isolated-suite requires {_ISOLATED_HARNESS_ENV}=1")
        raise SystemExit(_run_isolated_suite_to_report(Path(sys.argv[2])))
    if len(sys.argv) == 3 and sys.argv[1] == "--isolated-case":
        if not _IS_ISOLATED_SUBPROCESS:
            raise SystemExit(f"--isolated-case requires {_ISOLATED_HARNESS_ENV}=1")
        suite = unittest.TestSuite([TabStripSnapshotSliceTest(sys.argv[2])])
        result = unittest.TextTestRunner(verbosity=2).run(suite)
        raise SystemExit(0 if result.wasSuccessful() else 1)
    unittest.main()
