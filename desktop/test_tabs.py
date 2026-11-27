"""Native Qt drop events must reach the real QML strip and preserve ownership."""
import json
import os
import unittest
from pathlib import Path
os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
from PySide6.QtCore import QUrl, QMimeData, QPoint, QPointF, Qt, QEvent
from PySide6.QtGui import QGuiApplication, QDragEnterEvent, QDragMoveEvent, QDropEvent
from PySide6.QtQml import QQmlEngine, QQmlComponent
from PySide6.QtQuick import QQuickItem
from PySide6.QtTest import QTest
import folder_ops
from studio import Session
from test_studio import QuietStudio

class NativeTabsTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.app = QGuiApplication.instance() or QGuiApplication(["Native tab tests"])

    def setUp(self):
        self.session = Session(True)
        self.studio = QuietStudio(True, self.session)
        self.studio.newNote(); self.studio.newNote()
        self.engine = QQmlEngine()
        self.engine.rootContext().setContextProperty("studio", self.studio)
        self.component = QQmlComponent(self.engine)
        self.component.setData(b'''
import QtQuick
import QtQuick.Controls
ApplicationWindow {
    id: host
    width: 700; height: 180; visible: true
    property var viewState: JSON.parse(studio.snapshot)
    Connections {
        target: studio
        function onChanged() { host.viewState = JSON.parse(studio.snapshot) }
    }
    TabStrip { width: parent.width; viewState: host.viewState }
}
''', QUrl.fromLocalFile(str(Path(__file__).parent / "qml/tab-test.qml")))
        self.assertFalse(self.component.isError(), str(self.component.errors()))
        self.window = self.component.create()
        self.assertIsNotNone(self.window)
        self._activate_window()
        QTest.qWait(50)

    def _activate_window(self):
        self.window.show()
        self.window.requestActivate()
        QTest.qWaitForWindowActive(self.window, 1000)
        self.app.processEvents()

    def tearDown(self):
        self.window.close(); self.window.deleteLater()
        self.app.sendPostedEvents(None, QEvent.Type.DeferredDelete)
        self.engine.deleteLater()
        self.app.sendPostedEvents(None, QEvent.Type.DeferredDelete)
        self.studio.stop(); self.studio.pool.shutdown(wait=True)
        self.studio._search_pool.shutdown(wait=True, cancel_futures=True)
        self.session.writes.shutdown(wait=True)

    def drop(self, payload):
        mime = QMimeData(); mime.setData("application/x-supermd-tab", json.dumps(payload).encode())
        point = QPoint(20, 20)
        enter = QDragEnterEvent(point, Qt.DropAction.MoveAction, mime, Qt.MouseButton.LeftButton, Qt.KeyboardModifier.NoModifier)
        self.app.sendEvent(self.window, enter)
        move = QDragMoveEvent(point, Qt.DropAction.MoveAction, mime, Qt.MouseButton.LeftButton, Qt.KeyboardModifier.NoModifier)
        self.app.sendEvent(self.window, move)
        drop = QDropEvent(QPointF(point), Qt.DropAction.MoveAction, mime, Qt.MouseButton.LeftButton, Qt.KeyboardModifier.NoModifier)
        self.app.sendEvent(self.window, drop)
        QTest.qWait(30)
        return drop.isAccepted()

    def test_native_drop_reorders_instead_of_opening_a_file(self):
        note = self.studio.tabs[-1]
        active = self.studio.active
        self.assertTrue(self.drop({"window": self.studio.window_id, "tab": note["id"]}))
        self.assertIs(self.studio.tabs[0], note)
        self.assertEqual(self.studio.active, active)

    def test_forged_or_stale_ids_are_not_accepted(self):
        original = list(self.studio.tabs)
        self.assertFalse(self.drop({"window": "foreign", "tab": "not-open"}))
        self.assertEqual(self.studio.tabs, original)

    def test_drag_hint_is_a_real_rendered_card(self):
        # Repeater delegates belong to a visual tree, not necessarily the
        # window's QObject ownership tree.
        items = [self.window.contentItem()]
        preview = None
        while items:
            item = items.pop()
            if item.objectName() == "tabDragPreview":
                preview = item
                break
            items.extend(item.childItems())
        self.assertIsNotNone(preview)
        result = preview.grabToImage()
        for _ in range(40):
            if not result.image().isNull(): break
            QTest.qWait(25)
        image = result.image()
        self.assertFalse(image.isNull())
        self.assertEqual((image.width(), image.height()), (320, 190))
        colors = {image.pixelColor(x, y).rgba() for x in range(0, 320, 8) for y in range(0, 190, 8)}
        self.assertGreater(len(colors), 3, "The tab tear-off preview must contain painted text and a card, not an empty image")

    def test_tabs_and_plus_share_the_strip_vertical_center(self):
        items = [self.window.contentItem()]
        tabs, plus = [], None
        while items:
            item = items.pop()
            if item.objectName() == "noteTab": tabs.append(item)
            if item.objectName() == "newTabButton": plus = item
            items.extend(item.childItems())
        self.assertEqual(len(tabs), len(self.studio.tabs))
        self.assertIsNotNone(plus)
        self.assertEqual(plus.property("text"), "")
        self.assertEqual(plus.property("glyph"), "Plus")
        for item in [*tabs, plus]:
            self.assertAlmostEqual(item.y() + item.height() / 2, 24, delta=.5)

    def _strip_and_active_tab(self):
        strip = self.window.findChild(QQuickItem, "tabStrip")
        self.assertIsNotNone(strip)
        items = [strip]
        active_item = None
        while items:
            item = items.pop()
            if item.objectName() == "noteTab" and item.property("isActive"):
                active_item = item
                break
            items.extend(item.childItems())
        self.assertIsNotNone(active_item)
        return strip, strip.property("contentItem"), active_item

    def _assert_active_tab_revealed(self, context):
        strip, flickable, active_item = self._strip_and_active_tab()
        content_x = float(flickable.property("contentX"))
        viewport_width = float(strip.property("availableWidth") or strip.width())
        self.assertGreaterEqual(
            active_item.x() + 0.5,
            content_x,
            f"Active tab left edge clipped ({context}): x={active_item.x()}, contentX={content_x}",
        )
        self.assertLessEqual(
            active_item.x() + active_item.width() - 0.5,
            content_x + viewport_width,
            f"Active tab right edge clipped ({context}): right={active_item.x() + active_item.width()}, viewportRight={content_x + viewport_width}",
        )

    def test_overflowing_strip_reveals_active_tab_on_create_switch_move_reopen_and_resize(self):
        # Create enough wide tabs to overflow the 700px window horizontally.
        for index in range(8):
            self.studio.newNote()
            self.studio.renameNote(self.studio.active, f"Chapter {index + 1} Architecture Overview")
        QTest.qWait(60)
        strip, flickable, _ = self._strip_and_active_tab()
        self.assertGreater(float(flickable.property("contentWidth")), strip.width())
        self.assertGreater(float(flickable.property("contentX")), 0)
        self._assert_active_tab_revealed("after creating overflowing rightmost tab")

        # Switching to tab 1 via tabNumber scrolls all the way back to the left.
        self.studio.tabNumber(1)
        QTest.qWait(60)
        self._assert_active_tab_revealed("after switching to tab 1")
        self.assertLessEqual(float(flickable.property("contentX")), 20)

        # Cycling backward from tab 1 wraps to the rightmost tab and reveals it.
        self.studio.cycleTab(-1)
        QTest.qWait(60)
        self._assert_active_tab_revealed("after cycling wrap to last tab")

        # Moving the active tab repeatedly to the left keeps it inside the viewport.
        for _ in range(7):
            self.studio.moveActiveTab(-1)
            QTest.qWait(30)
            self._assert_active_tab_revealed("while moving active tab left")

        # Jump to the last tab, close it, then reopen it and confirm both stay visible.
        self.studio.selectTab(self.studio.tabs[-1]["id"])
        QTest.qWait(50)
        self._assert_active_tab_revealed("after selecting last tab")
        self.studio.closeTabSafely(self.studio.active)
        QTest.qWait(50)
        self._assert_active_tab_revealed("after closing rightmost tab")
        self.studio.reopenTab()
        QTest.qWait(60)
        self._assert_active_tab_revealed("after reopening closed tab")

        # Narrowing the window while on a right-side tab re-reveals the active tab.
        self.window.resize(460, 180)
        QTest.qWait(60)
        self._assert_active_tab_revealed("after narrowing window")

    def test_overflowing_strip_reveals_active_tab_across_folder_create_open_and_rename(self):
        import shutil
        import tempfile
        import time
        from PySide6.QtCore import QMetaObject, QObject, Q_ARG

        folder_dir = Path(tempfile.mkdtemp(prefix="supermd-tab-folder-reveal-"))
        self.addCleanup(lambda: shutil.rmtree(folder_dir, ignore_errors=True))

        def wait_until(predicate, timeout=5.0):
            deadline = time.monotonic() + timeout
            while time.monotonic() < deadline:
                self.app.processEvents()
                if predicate():
                    return
                QTest.qWait(10)
            self.assertTrue(predicate())

        self.studio.openFolder(str(folder_dir))
        wait_until(lambda: bool(self.studio.folder))

        # Create enough folder-backed notes via #87 createFolderNote to overflow horizontally.
        for index in range(7):
            title = f"1.{index + 1} Module Overview"
            self.studio.createFolderNote(str(folder_dir), title, "md")
            wait_until(lambda expected=f"{title}.md": self.studio.busy == 0 and self.studio._current()["name"] == expected)
        QTest.qWait(60)
        self._assert_active_tab_revealed("after creating overflowing folder-backed note")

        # Activating the first folder note via openNote reveals it at the left edge.
        first_note = folder_dir / "1.1 Module Overview.md"
        self.studio.openNote(str(first_note))
        wait_until(lambda: self.studio._current()["name"] == "1.1 Module Overview.md")
        QTest.qWait(60)
        self._assert_active_tab_revealed("after activating first folder note via openNote")

        # Activate a note near the right edge of the current viewport and rename it via #87 renameEntry so it widens past the viewport.
        self.studio.tabNumber(4)
        QTest.qWait(60)
        self._assert_active_tab_revealed("before renaming folder-backed active tab")
        target_path = self.studio._current()["path"]
        self.studio.renameEntry(target_path, "1.2 Comprehensive Distributed Consensus Architecture")
        wait_until(
            lambda: self.studio.busy == 0
            and self.studio._current()["name"] == "1.2 Comprehensive Distributed Consensus Architecture.md"
        )
        QTest.qWait(60)
        self._assert_active_tab_revealed("after widening active tab via folder renameEntry")

        # Verify TabStrip's renameDialog still selects only the dotted stem (without .md) from #87.
        self._activate_window()
        strip = self.window.findChild(QQuickItem, "tabStrip")
        self.assertTrue(
            QMetaObject.invokeMethod(
                strip,
                "openRename",
                Q_ARG("QVariant", self.studio.active),
                Q_ARG("QVariant", self.studio._current()["name"]),
            )
        )
        rename_field = self.window.findChild(QObject, "renameField")
        self.assertIsNotNone(rename_field)
        wait_until(lambda: bool(rename_field.property("selectedText")))
        self.assertEqual(
            rename_field.property("selectedText"),
            "1.2 Comprehensive Distributed Consensus Architecture",
        )
        rename_dialog = self.window.findChild(QObject, "renameDialog")
        rename_dialog.close()
        QTest.qWait(20)

        # Opening dropped external notes (#118 _open_dropped_notes) appends and reveals the activated dropped tab.
        drop_dir = Path(tempfile.mkdtemp(prefix="supermd-tab-drop-reveal-"))
        self.addCleanup(lambda: shutil.rmtree(drop_dir, ignore_errors=True))
        dropped_a = drop_dir / "Dropped Appendix A.md"
        dropped_b = drop_dir / "Dropped Appendix B Final Summary.md"
        dropped_a.write_text("# Appendix A\n", encoding="utf-8")
        dropped_b.write_text("# Appendix B\n", encoding="utf-8")
        self.studio._open_dropped_notes([dropped_a, dropped_b])
        wait_until(
            lambda: self.studio.busy == 0
            and self.studio._current()["name"] == "Dropped Appendix B Final Summary.md"
        )
        QTest.qWait(60)
        self._assert_active_tab_revealed("after opening multi-note workspace drop")

    def _ordered_note_tabs(self):
        self.app.processEvents()
        self.app.sendPostedEvents(None, QEvent.Type.DeferredDelete)
        strip = self.window.findChild(QQuickItem, "tabStrip")
        self.assertIsNotNone(strip)
        items = [strip]
        found = []
        while items:
            item = items.pop()
            if item.objectName() == "noteTab" and item.isVisible() and item.parentItem() is not None:
                found.append(item)
            items.extend(item.childItems())
        found.sort(key=lambda it: int(it.property("index")))
        return strip, found

    @staticmethod
    def _find_descendant(root, object_name):
        pending = [root]
        while pending:
            item = pending.pop(0)
            if item.objectName() == object_name:
                return item
            pending.extend(item.childItems())
        return None

    def test_duplicate_filenames_show_shortest_parent_context_accessible_names_and_hover_details(self):
        import shutil
        import tempfile
        import time
        from PySide6.QtCore import QMetaObject, QObject, Q_ARG

        root = Path(tempfile.mkdtemp(prefix="supermd-dup-tabs-"))
        self.addCleanup(lambda: shutil.rmtree(root, ignore_errors=True))

        def wait_until(predicate, timeout=5.0):
            deadline = time.monotonic() + timeout
            while time.monotonic() < deadline:
                self.app.processEvents()
                if predicate():
                    return
                QTest.qWait(10)
            self.assertTrue(predicate())

        phys_note = root / "Courses" / "Physics" / "Overview.md"
        unique_note = root / "Courses" / "Roadmap.md"
        chem_note = root / "Courses" / "Chemistry" / "Overview.md"
        arch_phys_note = root / "Archive" / "Physics" / "Overview.md"
        for target, body in (
            (phys_note, "# Physics Overview\n"),
            (unique_note, "# Roadmap\n"),
            (chem_note, "# Chemistry Overview\n"),
            (arch_phys_note, "# Archived Physics Overview\n"),
        ):
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(body, encoding="utf-8")

        # Replace initial scratch tabs cleanly so tab order is deterministic.
        self.studio._open_dropped_notes([phys_note, unique_note, chem_note, arch_phys_note])
        wait_until(lambda: self.studio.busy == 0 and sum(1 for t in self.studio.tabs if t["path"]) == 4)
        for scratch_id in [t["id"] for t in list(self.studio.tabs) if not t["path"]]:
            self.studio.closeTabSafely(scratch_id)
        wait_until(lambda: len(self.studio.tabs) == 4 and len(self._ordered_note_tabs()[1]) == 4)

        # Exact open order is preserved; Chemistry uses depth 1 ("Chemistry") while colliding Physics folders expand to depth 2.
        expected_paths = [
            folder_ops.canonical_path_str(phys_note),
            folder_ops.canonical_path_str(unique_note),
            folder_ops.canonical_path_str(chem_note),
            folder_ops.canonical_path_str(arch_phys_note),
        ]
        self.assertEqual([t["path"] for t in self.studio.tabs], expected_paths)

        _, note_tabs = self._ordered_note_tabs()
        self.assertEqual(len(note_tabs), 4)
        self.assertLess(note_tabs[0].x(), note_tabs[1].x())
        self.assertLess(note_tabs[1].x(), note_tabs[2].x())
        self.assertLess(note_tabs[2].x(), note_tabs[3].x())

        surviving_destroyed = []
        phys_tab_item = note_tabs[0]
        roadmap_tab_item = note_tabs[1]
        phys_tab_item.destroyed.connect(lambda *_args: surviving_destroyed.append("phys"))
        roadmap_tab_item.destroyed.connect(lambda *_args: surviving_destroyed.append("roadmap"))

        expected_contexts = ["Courses/Physics", "", "Chemistry", "Archive/Physics"]
        expected_labels = [
            "Overview.md · Courses/Physics",
            "Roadmap.md",
            "Overview.md · Chemistry",
            "Overview.md · Archive/Physics",
        ]
        for tab_item, exp_ctx, exp_label, exp_path in zip(note_tabs, expected_contexts, expected_labels, expected_paths):
            btn = self._find_descendant(tab_item, "noteTabLabel")
            ctx_text = self._find_descendant(tab_item, "noteTabParentContext")
            hint = btn.findChild(QObject, "actionHint")
            self.assertIsNotNone(hint)
            self.assertEqual(tab_item.property("parentContext"), exp_ctx)
            self.assertEqual(btn.property("text"), exp_label)
            self.assertEqual(hint.property("text"), exp_path)
            self.assertEqual(bool(ctx_text.property("visible")), bool(exp_ctx))
            self.assertEqual(ctx_text.property("text"), exp_ctx)

        # Inspect QQuickAccessibleAttached names via QML helper expression on the host window.
        acc_probe = QQmlComponent(self.engine)
        acc_probe.setData(
            b"""
import QtQuick
import QtQuick.Controls
QtObject {
    function nameOf(item) { return item ? item.Accessible.name : "" }
    function tipOf(item) { return item ? item.ToolTip.text : "" }
}
""",
            QUrl("qrc:/acc_probe.qml"),
        )
        probe = acc_probe.create()

        def acc_name(item):
            from PySide6.QtCore import Q_RETURN_ARG
            ok_val = [None]
            val = QMetaObject.invokeMethod(
                probe, "nameOf", Q_RETURN_ARG("QVariant"), Q_ARG("QVariant", item)
            )
            _ = ok_val
            return val

        def tip_text(item):
            from PySide6.QtCore import Q_RETURN_ARG
            return QMetaObject.invokeMethod(
                probe, "tipOf", Q_RETURN_ARG("QVariant"), Q_ARG("QVariant", item)
            )

        for tab_item, exp_label, exp_path in zip(note_tabs, expected_labels, expected_paths):
            btn = self._find_descendant(tab_item, "noteTabLabel")
            close_btn = self._find_descendant(tab_item, "noteTabCloseButton")
            self.assertEqual(acc_name(btn), exp_label)
            self.assertEqual(tip_text(btn), exp_path)
            self.assertEqual(acc_name(close_btn), f"Close {exp_label}")
            self.assertIn(f"Close {exp_label}", tip_text(close_btn))

        # Dirty state updates both the visual bullet and accessible name while keeping parent context.
        phys_id = self.studio.tabs[0]["id"]
        self.studio.post("edit-phys", "document_changed", json.dumps({"id": phys_id, "content": "# Physics Updated\n"}))
        wait_until(
            lambda: self._find_descendant(self._ordered_note_tabs()[1][0], "noteTabLabel").property("text")
            == "• Overview.md · Courses/Physics"
        )
        _, note_tabs = self._ordered_note_tabs()
        dirty_btn = self._find_descendant(note_tabs[0], "noteTabLabel")
        self.assertEqual(dirty_btn.property("text"), "• Overview.md · Courses/Physics")
        self.assertEqual(acc_name(dirty_btn), "Overview.md · Courses/Physics, unsaved changes")
        # Revert edit so closeTabSafely below closes cleanly without unsaved prompt.
        self.studio.post("revert-phys", "document_changed", json.dumps({"id": phys_id, "content": "# Physics Overview\n"}))
        wait_until(
            lambda: self._find_descendant(self._ordered_note_tabs()[1][0], "noteTabLabel").property("text")
            == "Overview.md · Courses/Physics"
        )

        # Rename dialog on a disambiguated tab still edits the raw filename (without parent context) and selects stem.
        self._activate_window()
        strip, _ = self._ordered_note_tabs()
        self.assertTrue(
            QMetaObject.invokeMethod(
                strip,
                "openRename",
                Q_ARG("QVariant", phys_id),
                Q_ARG("QVariant", self.studio.tabs[0]["name"]),
            )
        )
        rename_field = self.window.findChild(QObject, "renameField")
        wait_until(lambda: bool(rename_field.property("selectedText")))
        self.assertEqual(rename_field.property("text"), "Overview.md")
        self.assertEqual(rename_field.property("selectedText"), "Overview")
        self.window.findChild(QObject, "renameDialog").close()
        QTest.qWait(20)

        # Closing Archive/Physics reduces Physics to depth 1 ("Physics"); closing Chemistry clears context on remaining Overview.md.
        self.studio.closeTabSafely(self.studio.tabs[3]["id"])
        wait_until(lambda: len(self.studio.tabs) == 3 and len(self._ordered_note_tabs()[1]) == 3)
        _, note_tabs = self._ordered_note_tabs()
        self.assertEqual(acc_name(self._find_descendant(note_tabs[0], "noteTabLabel")), "Overview.md · Physics")
        self.assertEqual(acc_name(self._find_descendant(note_tabs[2], "noteTabLabel")), "Overview.md · Chemistry")

        self.studio.closeTabSafely(self.studio.tabs[2]["id"])
        wait_until(lambda: len(self.studio.tabs) == 2 and len(self._ordered_note_tabs()[1]) == 2)
        _, note_tabs = self._ordered_note_tabs()
        self.assertEqual(acc_name(self._find_descendant(note_tabs[0], "noteTabLabel")), "Overview.md")
        self.assertFalse(bool(self._find_descendant(note_tabs[0], "noteTabParentContext").property("visible")))

        # Reopening restores parent disambiguation automatically without recreating surviving ListModel delegates.
        self.studio.reopenTab()
        wait_until(lambda: len(self.studio.tabs) == 3 and len(self._ordered_note_tabs()[1]) == 3)
        _, note_tabs = self._ordered_note_tabs()
        labels_after_reopen = [acc_name(self._find_descendant(t, "noteTabLabel")) for t in note_tabs]
        self.assertIn("Overview.md · Physics", labels_after_reopen)
        self.assertIn("Overview.md · Chemistry", labels_after_reopen)
        self.assertEqual(surviving_destroyed, [], "Surviving tab delegates must stay alive across dynamic parentContext updates")
        self.assertIs(note_tabs[0], phys_tab_item)
        self.assertIs(note_tabs[1], roadmap_tab_item)
        probe.deleteLater()
        self.app.sendPostedEvents(None, QEvent.Type.DeferredDelete)

    def test_long_duplicate_tabs_preserve_parent_context_narrow_layout_and_keyboard_reveal(self):
        import shutil
        import tempfile
        import time

        root = Path(tempfile.mkdtemp(prefix="supermd-dup-narrow-"))
        self.addCleanup(lambda: shutil.rmtree(root, ignore_errors=True))

        def wait_until(predicate, timeout=5.0):
            deadline = time.monotonic() + timeout
            while time.monotonic() < deadline:
                self.app.processEvents()
                if predicate():
                    return
                QTest.qWait(10)
            self.assertTrue(predicate())

        long_name = "Comprehensive Distributed Systems Architecture Specification.md"
        files = []
        for folder in ("client", "server", "gateway", "worker"):
            target = root / "packages" / folder / long_name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(f"# {folder}\n", encoding="utf-8")
            files.append(target)

        self.studio._open_dropped_notes(files)
        wait_until(lambda: self.studio.busy == 0 and sum(1 for t in self.studio.tabs if t["path"]) == 4)
        for scratch_id in [t["id"] for t in list(self.studio.tabs) if not t["path"]]:
            self.studio.closeTabSafely(scratch_id)
        wait_until(
            lambda: len(self.studio.tabs) == 4
            and len(self._ordered_note_tabs()[1]) == 4
            and all(t.width() > 0 for t in self._ordered_note_tabs()[1])
        )

        strip, note_tabs = self._ordered_note_tabs()
        self.assertEqual(len(note_tabs), 4)
        for tab_item, expected_folder in zip(note_tabs, ("client", "server", "gateway", "worker")):
            self.assertLessEqual(tab_item.width(), 260.5)
            btn = self._find_descendant(tab_item, "noteTabLabel")
            close_btn = self._find_descendant(tab_item, "noteTabCloseButton")
            title_text = self._find_descendant(tab_item, "noteTabTitle")
            ctx_text = self._find_descendant(tab_item, "noteTabParentContext")
            self.assertTrue(bool(ctx_text.property("visible")))
            self.assertEqual(ctx_text.property("text"), expected_folder)
            self.assertGreater(ctx_text.width(), 20.0)
            self.assertFalse(bool(ctx_text.property("truncated")), "Short parent context must remain unclipped on 260px tabs")
            self.assertTrue(bool(title_text.property("truncated")), "Long filename should elide before clipping parent context")
            # Ensure label content never collides with close button.
            self.assertLessEqual(btn.x() + btn.width(), close_btn.x() + 0.5)

        # Keyboard tab selection, cycling, and reordering reveal disambiguated tabs cleanly.
        self.studio.tabNumber(1)
        QTest.qWait(60)
        self._assert_active_tab_revealed("after keyboard jump to first duplicate tab")
        self.studio.cycleTab(-1)
        QTest.qWait(60)
        self._assert_active_tab_revealed("after keyboard wrap to rightmost duplicate tab")
        self.studio.moveActiveTab(-1)
        QTest.qWait(60)
        self._assert_active_tab_revealed("after moving disambiguated active tab left")

        # Keyboard Tab focus on an offscreen non-active tab scrolls it into view without changing activeTabId.
        active_before = self.studio.active
        self._activate_window()
        _, note_tabs = self._ordered_note_tabs()
        first_btn = self._find_descendant(note_tabs[0], "noteTabLabel")
        first_btn.forceActiveFocus(Qt.FocusReason.TabFocusReason)
        flickable = strip.property("contentItem")
        wait_until(
            lambda: bool(first_btn.property("activeFocus"))
            and note_tabs[0].x() + 0.5 >= float(flickable.property("contentX"))
        )
        viewport_w = float(strip.property("availableWidth") or strip.width())
        content_x = float(flickable.property("contentX"))
        self.assertGreaterEqual(note_tabs[0].x() + 0.5, content_x)
        self.assertLessEqual(note_tabs[0].x() + note_tabs[0].width() - 0.5, content_x + viewport_w)
        self.assertEqual(self.studio.active, active_before)

        # Narrow-window layout keeps tabs vertically centered, bounded, and active tab revealed.
        for narrow_w in (460, 240):
            self.window.resize(narrow_w, 180)
            QTest.qWait(60)
            self.studio.selectTab(self.studio.tabs[-1]["id"])
            QTest.qWait(60)
            self._assert_active_tab_revealed(f"at narrow width {narrow_w}px")
            _, narrow_tabs = self._ordered_note_tabs()
            for tab_item in narrow_tabs:
                self.assertAlmostEqual(tab_item.y() + tab_item.height() / 2, 24, delta=0.5)


class TabParentDisambiguationUnitTest(unittest.TestCase):
    def test_unique_and_unsaved_tabs_stay_uncluttered(self):
        self.assertEqual(
            folder_ops.disambiguate_tab_parents([
                ("Untitled.md", ""),
                ("Untitled.md", ""),
                ("Overview.md", "/work/Physics/Overview.md"),
                ("Overview.smd", "/work/Physics/Overview.smd"),
            ]),
            ["", "", "", ""],
        )

    def test_unsaved_and_saved_same_filename_disambiguates_saved_parent(self):
        self.assertEqual(
            folder_ops.disambiguate_tab_parents([
                ("Overview.md", ""),
                ("Overview.md", "/Users/alice/Physics/Overview.md"),
            ]),
            ["", "Physics"],
        )

    def test_per_tab_shortest_depth_and_order_preservation(self):
        tabs = [
            ("index.md", "/repo/packages/core/src/index.md"),
            ("Unique.md", "/repo/docs/Unique.md"),
            ("index.md", "/repo/docs/index.md"),
            ("index.md", "/repo/packages/cli/src/index.md"),
        ]
        self.assertEqual(
            folder_ops.disambiguate_tab_parents(tabs),
            ["core/src", "", "docs", "cli/src"],
        )

    def test_deep_shared_hierarchy_compacts_middle_segments_symmetrically(self):
        self.assertEqual(
            folder_ops.disambiguate_tab_parents([
                ("README.md", "/repo/service-a/src/main/resources/docs/README.md"),
                ("README.md", "/repo/service-b/src/main/resources/docs/README.md"),
            ]),
            ["service-a/…/docs", "service-b/…/docs"],
        )
        # When all four reach depth 5 and two share service-a, compaction preserves segment 2 symmetrically.
        self.assertEqual(
            folder_ops.disambiguate_tab_parents([
                ("README.md", "/repo/service-a/alpha/v1/resources/docs/README.md"),
                ("README.md", "/repo/service-a/beta/v1/resources/docs/README.md"),
                ("README.md", "/repo/service-b/alpha/v1/resources/docs/README.md"),
                ("README.md", "/repo/service-c/beta/v1/resources/docs/README.md"),
            ]),
            ["service-a/alpha/…/docs", "service-a/beta/…/docs", "service-b/…/docs", "service-c/…/docs"],
        )

    def test_posix_and_windows_root_and_drive_anchors(self):
        self.assertEqual(
            folder_ops.disambiguate_tab_parents([
                ("README.md", "/README.md"),
                ("README.md", "/docs/README.md"),
            ]),
            ["/", "docs"],
        )
        self.assertEqual(
            folder_ops.disambiguate_tab_parents([
                ("README.md", "/docs/README.md"),
                ("README.md", "/work/docs/README.md"),
            ]),
            ["/docs", "work/docs"],
        )
        self.assertEqual(
            folder_ops.disambiguate_tab_parents([
                ("Notes.md", r"\\?\C:\Users\alice\work\docs\Notes.md"),
                ("Notes.md", r"D:\Users\alice\work\docs\Notes.md"),
            ]),
            ["C:/…/docs", "D:/…/docs"],
        )
        self.assertEqual(
            folder_ops.disambiguate_tab_parents([
                ("Notes.md", r"C:\Notes.md"),
                ("Notes.md", r"D:\Notes.md"),
            ]),
            ["C:", "D:"],
        )
        self.assertEqual(
            folder_ops.disambiguate_tab_parents([
                ("Notes.md", r"\\server\share\Notes.md"),
                ("Notes.md", r"\\?\UNC\server\share\docs\Notes.md"),
            ]),
            ["//server/share", "docs"],
        )

    def test_windows_os_name_and_outer_whitespace_preservation(self):
        from unittest import mock

        with mock.patch.object(folder_ops.os, "name", "nt"):
            self.assertEqual(
                folder_ops.disambiguate_tab_parents([
                    ("README.md", "/README.md"),
                    ("README.md", "/docs/README.md"),
                ]),
                ["/", "docs"],
            )
            self.assertEqual(
                folder_ops.disambiguate_tab_parents([
                    ("README.md", "/docs/README.md"),
                    ("README.md", "/work/docs/README.md"),
                ]),
                ["/docs", "work/docs"],
            )
            self.assertEqual(
                folder_ops.disambiguate_tab_parents([
                    ("README.md", r"\README.md"),
                    ("README.md", r"\docs\README.md"),
                ]),
                ["/", "docs"],
            )
            self.assertEqual(
                folder_ops.disambiguate_tab_parents([
                    ("Notes.md", r"\\?\C:\Users\alice\work\docs\Notes.md"),
                    ("Notes.md", r"D:\Users\alice\work\docs\Notes.md"),
                ]),
                ["C:/…/docs", "D:/…/docs"],
            )

        self.assertEqual(
            folder_ops.disambiguate_tab_parents([
                ("  Overview.md", "/work/Cohort A /  Overview.md"),
                ("  Overview.md", "/work/Cohort B /  Overview.md"),
                ("Overview.md", "/work/Cohort A /Overview.md"),
            ]),
            ["Cohort A ", "Cohort B ", ""],
        )


if __name__ == "__main__":
    unittest.main()


