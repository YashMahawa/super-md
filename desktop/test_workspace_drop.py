"""Native Desktop drag-and-drop workspace routing, multi-note batch open, and editor image drop tests."""
from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest.mock import patch

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

ROOT = Path(__file__).resolve().parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from PySide6.QtCore import QEvent, QMimeData, QObject, QPoint, QPointF, Qt, QUrl, Slot
from PySide6.QtGui import QDragEnterEvent, QDragMoveEvent, QDropEvent, QGuiApplication
from PySide6.QtQml import QQmlComponent, QQmlEngine
from PySide6.QtQuick import QQuickItem  # noqa: F401 - registers QQuickItem* property converter
from PySide6.QtTest import QTest

from documents import write_portable
import studio as studio_module
from studio import Session
from test_studio import QuietStudio


PNG_1X1 = (
    b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01"
    b"\x08\x06\x00\x00\x00\x1f\x15\xc4\x89\x00\x00\x00\rIDATx\x9cc`\x00\x00"
    b"\x00\x02\x00\x01\xe5'\xde\xfc\x00\x00\x00\x00IEND\xaeB`\x82"
)


def _footer_notice_text(window: QObject) -> str:
    footer = window.property("footer")
    if isinstance(footer, QObject):
        direct = footer.property("text")
        if isinstance(direct, str):
            return direct
        for item in footer.findChildren(QObject):
            text = item.property("text")
            if isinstance(text, str) and text:
                return text
    return ""


class _HostStub(QObject):
    def __init__(self) -> None:
        super().__init__()
        self.raised = 0
        self.activated = 0
        self.focused = 0

    def raise_(self) -> None:
        self.raised += 1

    def requestActivate(self) -> None:
        self.activated += 1

    @Slot()
    def focusReader(self) -> None:
        self.focused += 1


class DesktopWorkspaceDropUnitTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.app = QGuiApplication.instance() or QGuiApplication(["Desktop workspace drop tests"])

    def setUp(self) -> None:
        self.session = Session(True)
        self.studio = QuietStudio(True, self.session)
        self.studio.ready = True
        self.studio.settings["welcomed"] = True

    def tearDown(self) -> None:
        self.studio.stop()
        self.studio.pool.shutdown(wait=True)
        self.studio._search_pool.shutdown(wait=True)
        self.session.writes.shutdown(wait=True)
        self.app.sendPostedEvents(None, QEvent.Type.DeferredDelete)

    def _wait_for(self, predicate, timeout: float = 3.0) -> None:
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            self.app.processEvents()
            if predicate():
                return
            time.sleep(0.005)
        self.app.processEvents()
        self.assertTrue(predicate(), "Timed out waiting for Studio condition")

    def test_single_dropped_notes_open_from_welcome_and_preserve_unsaved_drafts(self) -> None:
        self.studio.settings["welcomed"] = False
        draft_tab = self.studio.tabs[0]
        draft_tab["content"] = "# Unsaved draft\nKeep me safe"
        draft_id = draft_tab["id"]

        md_note = self.studio.data / "welcome-drop.md"
        md_note.write_text("# Welcome Note\nBody", encoding="utf-8")
        smd_note = self.studio.data / "portable-drop.smd"
        write_portable(smd_note, "# Portable Note\nWith bundle", {})

        self.assertTrue(self.studio.shouldInterceptExternalDrop([QUrl.fromLocalFile(str(md_note))], False))
        self.studio.handleExternalDrop([QUrl.fromLocalFile(str(md_note))], False)
        self._wait_for(lambda: any(t["path"] == str(md_note.resolve()) for t in self.studio.tabs))

        self.assertTrue(self.studio.settings["welcomed"])
        self.assertEqual(self.studio._current()["path"], str(md_note.resolve()))
        self.assertEqual(
            next(t for t in self.studio.tabs if t["id"] == draft_id)["content"],
            "# Unsaved draft\nKeep me safe",
        )

        self.studio.handleExternalDrop([QUrl.fromLocalFile(str(smd_note))], True)
        self._wait_for(lambda: any(t["path"] == str(smd_note.resolve()) for t in self.studio.tabs))
        self.assertEqual(self.studio._current()["path"], str(smd_note.resolve()))
        self.assertTrue(self.studio._current()["portable"])

    def test_multiple_dropped_notes_preserve_drop_order_even_when_reads_complete_out_of_order(self) -> None:
        existing_note = self.studio.data / "already-open.md"
        existing_note.write_text("# Existing", encoding="utf-8")
        self.studio.openNote(str(existing_note))
        self._wait_for(lambda: any(t["path"] == str(existing_note.resolve()) for t in self.studio.tabs))
        existing_id = self.studio.active

        alpha = self.studio.data / "alpha.md"
        beta = self.studio.data / "beta.markdown"
        gamma = self.studio.data / "gamma.smd"
        delta = self.studio.data / "delta.txt"
        alpha.write_text("# Alpha", encoding="utf-8")
        beta.write_text("# Beta", encoding="utf-8")
        write_portable(gamma, "# Gamma", {})
        delta.write_text("Delta plain text", encoding="utf-8")

        pending: list[tuple[object, object]] = []
        dropped_urls = [
            QUrl.fromLocalFile(str(alpha)),
            QUrl.fromLocalFile(str(existing_note)),
            QUrl.fromLocalFile(str(beta)),
            QUrl.fromLocalFile(str(alpha)),  # duplicate URL in same drop payload
            QUrl.fromLocalFile(str(gamma)),
            QUrl.fromLocalFile(str(delta)),
        ]

        with patch.object(
            self.studio,
            "_submit",
            side_effect=lambda action, done, *args, **kwargs: pending.append((action, done)),
        ):
            self.studio.handleExternalDrop(dropped_urls, True)
            # existing_note is already open and duplicate alpha is deduplicated -> 4 async reads.
            self.assertEqual(len(pending), 4)
            # Complete reads out of order: gamma (2), delta (3), alpha (0), beta (1)
            for out_of_order in (2, 3, 0, 1):
                action, done = pending[out_of_order]
                done(action(), None)

        opened_paths = [t["path"] for t in self.studio.tabs if t["path"]]
        self.assertEqual(
            opened_paths,
            [
                str(existing_note.resolve()),
                str(alpha.resolve()),
                str(beta.resolve()),
                str(gamma.resolve()),
                str(delta.resolve()),
            ],
        )
        # Existing tab stayed in place; last dropped note (delta.txt) is active and first in recent.
        self.assertEqual(self.studio.tabs[1]["id"], existing_id)
        self.assertEqual(self.studio._current()["path"], str(delta.resolve()))
        self.assertEqual(
            self.studio.recent[:5],
            [
                str(delta.resolve()),
                str(gamma.resolve()),
                str(beta.resolve()),
                str(existing_note.resolve()),
                str(alpha.resolve()),
            ],
        )

    def test_manual_tab_switch_during_multi_file_drop_is_not_overridden(self) -> None:
        keep_focused = self.studio.data / "keep-focused.md"
        keep_focused.write_text("# Keep Focused", encoding="utf-8")
        self.studio.openNote(str(keep_focused))
        self._wait_for(lambda: any(t["path"] == str(keep_focused.resolve()) for t in self.studio.tabs))
        keep_id = self.studio.active
        self.studio.newNote()

        first = self.studio.data / "slow-1.md"
        second = self.studio.data / "slow-2.md"
        first.write_text("# Slow 1", encoding="utf-8")
        second.write_text("# Slow 2", encoding="utf-8")

        pending: list[tuple[object, object]] = []
        with patch.object(
            self.studio,
            "_submit",
            side_effect=lambda action, done, *args, **kwargs: pending.append((action, done)),
        ):
            self.studio.handleExternalDrop(
                [QUrl.fromLocalFile(str(first)), QUrl.fromLocalFile(str(second))],
                True,
            )
            self.studio.selectTab(keep_id)
            for action, done in reversed(pending):
                done(action(), None)

        self.assertEqual(self.studio.active, keep_id)
        self.assertEqual(
            [t["path"] for t in self.studio.tabs[-2:]],
            [str(first.resolve()), str(second.resolve())],
        )

    def test_dropped_folder_and_mixed_drops_use_native_workspace_flow(self) -> None:
        workspace_dir = self.studio.data / "research-folder"
        workspace_dir.mkdir()
        inside_note = workspace_dir / "overview.md"
        inside_note.write_text("# Overview", encoding="utf-8")
        extra_note = self.studio.data / "scratch.md"
        extra_note.write_text("# Scratch", encoding="utf-8")
        image_file = self.studio.data / "diagram.png"
        image_file.write_bytes(PNG_1X1)
        pdf_file = self.studio.data / "slides.pdf"
        pdf_file.write_bytes(b"%PDF-1.4\n")

        host = _HostStub()
        self.studio.host_window = host
        folder_signals: list[bool] = []
        self.studio.workspaceFolderDropped.connect(lambda: folder_signals.append(True))

        # Pure folder drop opens workspace folder and raises host window.
        self.assertTrue(self.studio.shouldInterceptExternalDrop([QUrl.fromLocalFile(str(workspace_dir))], True))
        self.studio.handleExternalDrop([QUrl.fromLocalFile(str(workspace_dir))], True)
        self._wait_for(lambda: any(entry["name"] == "overview.md" for entry in self.studio.files))
        self.assertEqual(self.studio.folder, str(workspace_dir.resolve()))
        self.assertEqual(len(folder_signals), 1)
        self.assertEqual((host.raised, host.activated), (1, 1))

        # Mixed folder + notes + unsupported PDF opens folder and notes while surfacing notice.
        other_dir = self.studio.data / "second-folder"
        other_dir.mkdir()
        (other_dir / "chapter.md").write_text("# Chapter", encoding="utf-8")
        expected_mixed_paths = {str(inside_note.resolve()), str(extra_note.resolve())}
        self.studio.handleExternalDrop(
            [
                QUrl.fromLocalFile(str(other_dir)),
                QUrl.fromLocalFile(str(inside_note)),
                QUrl.fromLocalFile(str(extra_note)),
                QUrl.fromLocalFile(str(pdf_file)),
            ],
            True,
        )
        self._wait_for(
            lambda: "skipped 1 unsupported item" in self.studio.message.lower()
            and expected_mixed_paths.issubset({t["path"] for t in self.studio.tabs if t["path"]})
            and self.studio.folder == str(other_dir.resolve())
            and [entry["name"] for entry in self.studio.files] == ["chapter.md"]
        )
        self.assertEqual(self.studio.folder, str(other_dir.resolve()))
        self.assertEqual([entry["name"] for entry in self.studio.files], ["chapter.md"])
        self.assertEqual(
            [t["path"] for t in self.studio.tabs if t["path"]],
            [str(inside_note.resolve()), str(extra_note.resolve())],
        )
        self.assertEqual(self.studio._current()["path"], str(extra_note.resolve()))
        self.assertIn("skipped 1 unsupported item", self.studio.message.lower())

        # Pure image drop: NOT intercepted over ready active reader, intercepted on chrome.
        self.assertFalse(self.studio.shouldInterceptExternalDrop([QUrl.fromLocalFile(str(image_file))], True))
        self.assertTrue(self.studio.shouldInterceptExternalDrop([QUrl.fromLocalFile(str(image_file))], False))
        tabs_before = [t["id"] for t in self.studio.tabs]
        self.studio.handleExternalDrop([QUrl.fromLocalFile(str(image_file))], False)
        self.assertEqual([t["id"] for t in self.studio.tabs], tabs_before)
        self.assertIn("Drop images inside an open note", self.studio.message)

        # Pure unsupported file drop: intercepted everywhere without mutating tabs.
        self.assertTrue(self.studio.shouldInterceptExternalDrop([QUrl.fromLocalFile(str(pdf_file))], True))
        self.studio.handleExternalDrop([QUrl.fromLocalFile(str(pdf_file))], True)
        self.assertEqual([t["id"] for t in self.studio.tabs], tabs_before)
        self.assertIn("Only Markdown notes", self.studio.message)

        # Pending close blocks external drops from mutating workspace state.
        unopened = self.studio.data / "blocked-during-close.md"
        unopened.write_text("# Blocked", encoding="utf-8")
        self.studio.pending_close = "window"
        self.assertTrue(self.studio.shouldInterceptExternalDrop([QUrl.fromLocalFile(str(unopened))], True))
        self.studio.handleExternalDrop([QUrl.fromLocalFile(str(unopened))], True)
        self.studio.pending_close = ""
        self.assertFalse(any(t["path"] == str(unopened.resolve()) for t in self.studio.tabs))

    def test_mixed_drop_publishes_skipped_notice_after_earlier_read_finishes_last(self) -> None:
        other_dir = self.studio.data / "ordered-folder"
        other_dir.mkdir()
        (other_dir / "chapter.md").write_text("# Chapter", encoding="utf-8")
        inside_note = self.studio.data / "slow-earlier.md"
        inside_note.write_text("# Earlier Note", encoding="utf-8")
        extra_note = self.studio.data / "fast-last.md"
        extra_note.write_text("# Last Note", encoding="utf-8")
        pdf_file = self.studio.data / "handout.pdf"
        pdf_file.write_bytes(b"%PDF-1.4\n")

        real_open_note = studio_module.open_note
        first_read_started = threading.Event()
        allow_first_read_to_finish = threading.Event()

        def controlled_open_note(path: Path):
            resolved = path.resolve()
            if resolved == inside_note.resolve():
                first_read_started.set()
                if not allow_first_read_to_finish.wait(timeout=5.0):
                    raise TimeoutError("Timed out waiting to release earlier dropped note read")
            elif resolved == extra_note.resolve():
                if not first_read_started.wait(timeout=5.0):
                    raise TimeoutError("Timed out waiting for earlier dropped note read to start")
            return real_open_note(path)

        with patch.object(studio_module, "open_note", side_effect=controlled_open_note):
            self.studio.handleExternalDrop(
                [
                    QUrl.fromLocalFile(str(other_dir)),
                    QUrl.fromLocalFile(str(inside_note)),
                    QUrl.fromLocalFile(str(extra_note)),
                    QUrl.fromLocalFile(str(pdf_file)),
                ],
                True,
            )
            try:
                # Force the exact race: folder and last note have appeared, while earlier read is still in flight.
                self._wait_for(
                    lambda: self.studio.folder == str(other_dir.resolve())
                    and any(t["path"] == str(extra_note.resolve()) for t in self.studio.tabs)
                )
                self.assertFalse(any(t["path"] == str(inside_note.resolve()) for t in self.studio.tabs))
                self.assertEqual(self.studio._current()["path"], str(extra_note.resolve()))
                self.assertNotIn("skipped 1 unsupported item", self.studio.message.lower())
            finally:
                allow_first_read_to_finish.set()

            self._wait_for(
                lambda: "skipped 1 unsupported item" in self.studio.message.lower()
                and any(t["path"] == str(inside_note.resolve()) for t in self.studio.tabs)
                and self.studio.folder == str(other_dir.resolve())
                and [entry["name"] for entry in self.studio.files] == ["chapter.md"]
            )

        self.assertEqual(self.studio.folder, str(other_dir.resolve()))
        self.assertEqual([entry["name"] for entry in self.studio.files], ["chapter.md"])
        self.assertEqual(
            [t["path"] for t in self.studio.tabs if t["path"]],
            [str(inside_note.resolve()), str(extra_note.resolve())],
        )
        self.assertEqual(self.studio._current()["path"], str(extra_note.resolve()))
        self.assertIn("skipped 1 unsupported item", self.studio.message.lower())


class DesktopWorkspaceDropQmlTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.app = QGuiApplication.instance() or QGuiApplication(["Desktop QML workspace drop tests"])

    def setUp(self) -> None:
        self.session = Session(True)
        self.studio = QuietStudio(True, self.session)
        self.studio.ready = True
        self.studio.settings["welcomed"] = True
        self.studio.newNote()
        self.engine = QQmlEngine()
        self.engine.rootContext().setContextProperty("studio", self.studio)
        qml_dir = ROOT / "qml"
        self.engine.addImportPath(str(qml_dir))
        source = f"""
import QtQuick
import QtQuick.Controls
import "{qml_dir.as_uri()}"

ApplicationWindow {{
    id: win
    width: 720
    height: 240
    visible: true
    property var viewState: JSON.parse(studio.snapshot)
    property int modalDialogCount: 0
    Component.onCompleted: studio.attachWindowDropFilter(win, null)
    TabStrip {{
        id: strip
        width: parent.width
        viewState: win.viewState
    }}
    footer: Label {{
        objectName: "statusNotice"
        text: win.viewState.busy ? "Preparing document…" : (win.viewState.message || "")
    }}
}}
"""
        self.component = QQmlComponent(self.engine)
        self.component.setData(source.encode("utf-8"), QUrl.fromLocalFile(str(qml_dir / "workspace-drop-qml-test.qml")))
        self.assertFalse(self.component.isError(), str(self.component.errors()))
        self.window = self.component.create()
        self.assertIsNotNone(self.window)
        QTest.qWait(40)

    def tearDown(self) -> None:
        self.window.close()
        self.window.deleteLater()
        self.app.sendPostedEvents(None, QEvent.Type.DeferredDelete)
        self.engine.deleteLater()
        self.app.sendPostedEvents(None, QEvent.Type.DeferredDelete)
        self.studio.stop()
        self.studio.pool.shutdown(wait=True)
        self.studio._search_pool.shutdown(wait=True)
        self.session.writes.shutdown(wait=True)

    def _send_drop(self, mime: QMimeData, action: Qt.DropAction, point: QPoint = QPoint(24, 24)) -> bool:
        enter = QDragEnterEvent(point, action, mime, Qt.MouseButton.LeftButton, Qt.KeyboardModifier.NoModifier)
        self.app.sendEvent(self.window, enter)
        move = QDragMoveEvent(point, action, mime, Qt.MouseButton.LeftButton, Qt.KeyboardModifier.NoModifier)
        self.app.sendEvent(self.window, move)
        drop = QDropEvent(QPointF(point), action, mime, Qt.MouseButton.LeftButton, Qt.KeyboardModifier.NoModifier)
        self.app.sendEvent(self.window, drop)
        QTest.qWait(40)
        return drop.isAccepted()

    def test_tab_strip_preserves_internal_tab_drags_and_opens_external_file_drops(self) -> None:
        # 1. Internal application/x-supermd-tab drag passes through WorkspaceDropArea to TabStrip.
        trailing = self.studio.tabs[-1]
        tab_mime = QMimeData()
        tab_mime.setData(
            "application/x-supermd-tab",
            json.dumps({"window": self.studio.window_id, "tab": trailing["id"]}).encode("utf-8"),
        )
        self.assertTrue(self._send_drop(tab_mime, Qt.DropAction.MoveAction))
        self.assertIs(self.studio.tabs[0], trailing)

        # 2. External multi-note drop onto TabStrip opens dropped notes in order and surfaces skipped-item notice.
        first = self.studio.data / "strip-1.md"
        second = self.studio.data / "strip-2.md"
        skipped = self.studio.data / "strip-ignored.pdf"
        first.write_text("# Strip 1", encoding="utf-8")
        second.write_text("# Strip 2", encoding="utf-8")
        skipped.write_bytes(b"%PDF-1.4\n")
        expected_strip_paths = {str(first.resolve()), str(second.resolve())}
        file_mime = QMimeData()
        file_mime.setUrls(
            [
                QUrl.fromLocalFile(str(first)),
                QUrl.fromLocalFile(str(second)),
                QUrl.fromLocalFile(str(skipped)),
            ]
        )
        self.assertTrue(self._send_drop(file_mime, Qt.DropAction.CopyAction))

        deadline = time.monotonic() + 3.0
        while time.monotonic() < deadline and (
            not expected_strip_paths.issubset({t["path"] for t in self.studio.tabs if t["path"]})
            or "skipped 1 unsupported item" not in _footer_notice_text(self.window).lower()
        ):
            self.app.processEvents()
            time.sleep(0.005)
        self.assertEqual(
            [t["path"] for t in self.studio.tabs if t["path"]],
            [str(first.resolve()), str(second.resolve())],
        )
        self.assertEqual(self.studio._current()["path"], str(second.resolve()))
        self.assertIn("skipped 1 unsupported item", _footer_notice_text(self.window).lower())

        # 3. Modal dialog count > 0 blocks external drops on the strip.
        blocked = self.studio.data / "modal-blocked.md"
        blocked.write_text("# Modal Blocked", encoding="utf-8")
        self.window.setProperty("modalDialogCount", 1)
        blocked_mime = QMimeData()
        blocked_mime.setUrls([QUrl.fromLocalFile(str(blocked))])
        self._send_drop(blocked_mime, Qt.DropAction.CopyAction)
        QTest.qWait(60)
        self.assertFalse(any(t["path"] == str(blocked.resolve()) for t in self.studio.tabs))


def _webengine_drop_probe() -> None:
    os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
    os.environ.setdefault("QT_QUICK_BACKEND", "software")
    os.environ.setdefault("QTWEBENGINE_CHROMIUM_FLAGS", "--disable-gpu --disable-dev-shm-usage")

    from PySide6.QtCore import QEvent, QFile, QIODevice, QMimeData, QObject, QPoint, QPointF, Qt, QUrl
    from PySide6.QtGui import QDragEnterEvent, QDragMoveEvent, QDropEvent
    from PySide6.QtQml import QQmlApplicationEngine
    from PySide6.QtQuick import QQuickItem
    from PySide6.QtQuickControls2 import QQuickStyle
    from PySide6.QtTest import QTest
    from PySide6.QtWebEngineQuick import QtWebEngineQuick
    from PySide6.QtWidgets import QApplication

    QQuickStyle.setStyle("Material")
    QtWebEngineQuick.initialize()
    app = QApplication.instance() or QApplication(["Desktop WebEngine workspace drop probe"])

    with tempfile.TemporaryDirectory(prefix="supermd-desktop-drop-probe-") as tmp:
        tmp_path = Path(tmp)
        probe_html = tmp_path / "reader-probe.html"
        probe_html.write_text(
            """<!doctype html>
<html>
<body style="margin:0;background:#111;color:#eee;font:16px sans-serif">
  <div class="workspace" id="workspace" style="width:100vw;height:100vh;box-sizing:border-box;padding:32px">
    <p id="line">Existing editor content</p>
  </div>
  <script>
    window.__droppedFiles = [];
    window.__dragOvers = 0;
    document.addEventListener("dragover", (event) => {
      if (event.target.closest(".workspace") && Array.from(event.dataTransfer?.types || []).includes("Files")) {
        event.preventDefault();
        window.__dragOvers += 1;
      }
    });
    document.addEventListener("drop", (event) => {
      if (!event.target.closest(".workspace")) return;
      const files = Array.from(event.dataTransfer?.files || []).filter(
        (f) => /^image\\//.test(f.type) || /\\.(png|jpe?g|gif|webp|avif|svg)$/i.test(f.name)
      );
      if (!files.length) return;
      event.preventDefault();
      event.stopPropagation();
      window.__droppedFiles.push({
        names: files.map((f) => f.name),
        x: Math.round(event.clientX),
        y: Math.round(event.clientY),
      });
      document.title = JSON.stringify({ dragOvers: window.__dragOvers, droppedFiles: window.__droppedFiles });
    }, true);
    document.title = JSON.stringify({ ready: true, dragOvers: 0, droppedFiles: [] });
  </script>
</body>
</html>
""",
            encoding="utf-8",
        )

        session = Session(True)
        session.settings["welcomed"] = True
        session.settings["python"] = sys.executable
        studio = QuietStudio(True, session)
        studio.ready = True

        channel = QFile(":/qtwebchannel/qwebchannel.js")
        if not channel.open(QIODevice.OpenModeFlag.ReadOnly):
            raise RuntimeError("Qt WebChannel runtime unavailable")

        engine = QQmlApplicationEngine()
        engine.rootContext().setContextProperty("studio", studio)
        engine.rootContext().setContextProperty("readerUrl", QUrl.fromLocalFile(str(probe_html)))
        engine.rootContext().setContextProperty("channelScript", bytes(channel.readAll()).decode())
        engine.rootContext().setContextProperty(
            "brandUrl", QUrl.fromLocalFile(str(ROOT.parent / "public" / "brand-mark-fixed.svg"))
        )
        engine.load(QUrl.fromLocalFile(str(ROOT / "qml" / "Main.qml")))
        if not engine.rootObjects():
            raise RuntimeError("Production Main.qml failed to load")

        window = engine.rootObjects()[0]
        studio.host_window = window
        window.show()
        window.raise_()
        window.requestActivate()

        try:
            reader = window.findChild(QObject, "documentReader")
            if not isinstance(reader, QQuickItem):
                raise AssertionError("Expected Main.qml documentReader to exist")

            deadline = time.monotonic() + 15.0
            while time.monotonic() < deadline:
                app.processEvents()
                QTest.qWait(20)
                title = reader.property("title")
                if isinstance(title, str) and '"ready":true' in title.replace(" ", ""):
                    break
            else:
                raise AssertionError(f"WebEngine reader probe did not become ready (title={reader.property('title')!r})")
            window.grabWindow()
            app.processEvents()

            reader_scene = reader.mapToScene(QPointF(reader.width() * 0.5, reader.height() * 0.5))
            reader_pt = QPoint(int(round(reader_scene.x())), int(round(reader_scene.y())))
            sidebar_pt = QPoint(110, int(round(reader_scene.y())))

            # 1. Dropping multiple notes (+ unsupported item) over WebEngineView is intercepted natively, opens tabs in order, and shows visible notice.
            note_one = tmp_path / "first-drop.md"
            note_two = tmp_path / "second-drop.smd"
            skipped_note_drop = tmp_path / "ignored-drop.pdf"
            note_one.write_text("# First Drop", encoding="utf-8")
            write_portable(note_two, "# Second Drop", {})
            skipped_note_drop.write_bytes(b"%PDF-1.4\n")
            expected_note_paths = {str(note_one.resolve()), str(note_two.resolve())}
            notes_mime = QMimeData()
            notes_mime.setUrls(
                [
                    QUrl.fromLocalFile(str(note_one)),
                    QUrl.fromLocalFile(str(note_two)),
                    QUrl.fromLocalFile(str(skipped_note_drop)),
                ]
            )

            app.sendEvent(window, QDragEnterEvent(reader_pt, Qt.DropAction.CopyAction, notes_mime, Qt.MouseButton.LeftButton, Qt.KeyboardModifier.NoModifier))
            app.sendEvent(window, QDragMoveEvent(reader_pt, Qt.DropAction.CopyAction, notes_mime, Qt.MouseButton.LeftButton, Qt.KeyboardModifier.NoModifier))
            note_drop = QDropEvent(QPointF(reader_pt), Qt.DropAction.CopyAction, notes_mime, Qt.MouseButton.LeftButton, Qt.KeyboardModifier.NoModifier)
            app.sendEvent(window, note_drop)

            deadline = time.monotonic() + 5.0
            while time.monotonic() < deadline and (
                not expected_note_paths.issubset({t["path"] for t in studio.tabs if t["path"]})
                or "skipped 1 unsupported item" not in _footer_notice_text(window).lower()
            ):
                app.processEvents()
                QTest.qWait(15)
            opened = [t["path"] for t in studio.tabs if t["path"]]
            if opened != [str(note_one.resolve()), str(note_two.resolve())]:
                raise AssertionError(f"Unexpected opened tabs after WebEngine note drop: {opened}")
            if studio._current()["path"] != str(note_two.resolve()):
                raise AssertionError(f"Expected active note {note_two}, got {studio._current()['path']}")
            if "skipped 1 unsupported item" not in _footer_notice_text(window).lower():
                raise AssertionError(f"Expected visible skipped-item notice in Main.qml footer, got {_footer_notice_text(window)!r}")
            current_url = reader.property("url")
            current_url_str = current_url.toString() if hasattr(current_url, "toString") else str(current_url)
            if current_url_str.split("#")[0] != QUrl.fromLocalFile(str(probe_html)).toString():
                raise AssertionError(f"WebEngineView navigated on note drop: {current_url_str}")

            # 2. Dropping a folder when sidebar is collapsed/on 'contents' opens folder & reveals sidebar folder view.
            window.setProperty("sidebar", False)
            window.setProperty("sidebarSection", "contents")
            dropped_folder = tmp_path / "workspace-folder"
            dropped_folder.mkdir()
            (dropped_folder / "inside.md").write_text("# Inside", encoding="utf-8")
            folder_mime = QMimeData()
            folder_mime.setUrls([QUrl.fromLocalFile(str(dropped_folder))])
            app.sendEvent(window, QDragEnterEvent(reader_pt, Qt.DropAction.CopyAction, folder_mime, Qt.MouseButton.LeftButton, Qt.KeyboardModifier.NoModifier))
            app.sendEvent(window, QDragMoveEvent(reader_pt, Qt.DropAction.CopyAction, folder_mime, Qt.MouseButton.LeftButton, Qt.KeyboardModifier.NoModifier))
            app.sendEvent(window, QDropEvent(QPointF(reader_pt), Qt.DropAction.CopyAction, folder_mime, Qt.MouseButton.LeftButton, Qt.KeyboardModifier.NoModifier))

            deadline = time.monotonic() + 5.0
            while time.monotonic() < deadline and not any(f["name"] == "inside.md" for f in studio.files):
                app.processEvents()
                QTest.qWait(15)
            if studio.folder != str(dropped_folder.resolve()):
                raise AssertionError(f"Expected dropped folder {dropped_folder}, got {studio.folder}")
            if not window.property("sidebar") or window.property("sidebarSection") != "folder":
                raise AssertionError("Expected folder drop to reveal sidebar in 'folder' section")

            # Recompute reader & sidebar points after sidebar became visible.
            QTest.qWait(50)
            app.processEvents()
            window.grabWindow()
            app.processEvents()
            reader_scene = reader.mapToScene(QPointF(reader.width() * 0.5, reader.height() * 0.5))
            reader_pt = QPoint(int(round(reader_scene.x())), int(round(reader_scene.y())))
            sidebar_pt = QPoint(110, int(round(reader_scene.y())))

            # 3. Existing editor image drops: dragging an image across the sidebar into WebEngineView
            # passes straight through WorkspaceDropFilter to the editor's DOM dragover + drop handlers!
            image_one = tmp_path / "figure-a.png"
            image_two = tmp_path / "diagram-b.svg"
            image_one.write_bytes(PNG_1X1)
            image_two.write_text('<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"></svg>', encoding="utf-8")
            img_mime = QMimeData()
            img_mime.setUrls([QUrl.fromLocalFile(str(image_one)), QUrl.fromLocalFile(str(image_two))])
            os_actions = Qt.DropAction.CopyAction | Qt.DropAction.MoveAction

            tabs_before_img = [t["id"] for t in studio.tabs]
            app.sendEvent(window, QDragEnterEvent(sidebar_pt, os_actions, img_mime, Qt.MouseButton.LeftButton, Qt.KeyboardModifier.NoModifier))
            app.sendEvent(window, QDragMoveEvent(sidebar_pt, os_actions, img_mime, Qt.MouseButton.LeftButton, Qt.KeyboardModifier.NoModifier))
            app.sendEvent(window, QDragMoveEvent(reader_pt, os_actions, img_mime, Qt.MouseButton.LeftButton, Qt.KeyboardModifier.NoModifier))
            for step in range(25):
                app.processEvents()
                QTest.qWait(20)
                move_ev = QDragMoveEvent(
                    QPoint(reader_pt.x() + (step % 3), reader_pt.y()),
                    os_actions,
                    img_mime,
                    Qt.MouseButton.LeftButton,
                    Qt.KeyboardModifier.NoModifier,
                )
                app.sendEvent(window, move_ev)
                if move_ev.isAccepted():
                    break
            img_drop = QDropEvent(QPointF(reader_pt), os_actions, img_mime, Qt.MouseButton.LeftButton, Qt.KeyboardModifier.NoModifier)
            app.sendEvent(window, img_drop)

            deadline = time.monotonic() + 5.0
            parsed_dom = None
            while time.monotonic() < deadline:
                app.processEvents()
                QTest.qWait(20)
                title = reader.property("title")
                if isinstance(title, str) and "figure-a.png" in title:
                    parsed_dom = json.loads(title)
                    break
            if (
                not parsed_dom
                or parsed_dom["droppedFiles"][-1]["names"] != ["figure-a.png", "diagram-b.svg"]
                or parsed_dom.get("dragOvers", 0) < 1
            ):
                raise AssertionError(
                    f"Expected WebEngine DOM to receive genuine dragover + dropped images, got title={reader.property('title')!r}"
                )
            if [t["id"] for t in studio.tabs] != tabs_before_img:
                raise AssertionError("Pure editor image drop must not open native workspace tabs")

            # 4. Open modal dialog blocks both note drops and editor image drops behind the modal.
            window.setProperty("modalDialogCount", 1)
            app.processEvents()
            modal_img = tmp_path / "behind-modal.png"
            modal_img.write_bytes(PNG_1X1)
            modal_mime = QMimeData()
            modal_mime.setUrls([QUrl.fromLocalFile(str(modal_img))])
            app.sendEvent(window, QDragEnterEvent(reader_pt, os_actions, modal_mime, Qt.MouseButton.LeftButton, Qt.KeyboardModifier.NoModifier))
            app.sendEvent(window, QDragMoveEvent(reader_pt, os_actions, modal_mime, Qt.MouseButton.LeftButton, Qt.KeyboardModifier.NoModifier))
            app.sendEvent(window, QDropEvent(QPointF(reader_pt), os_actions, modal_mime, Qt.MouseButton.LeftButton, Qt.KeyboardModifier.NoModifier))
            QTest.qWait(120)
            app.processEvents()
            if "behind-modal.png" in str(reader.property("title")):
                raise AssertionError("Editor DOM must not receive image drops while a modal dialog is open")
        finally:
            window.close()
            window.deleteLater()
            app.sendPostedEvents(None, QEvent.Type.DeferredDelete)
            engine.deleteLater()
            app.sendPostedEvents(None, QEvent.Type.DeferredDelete)
            studio.stop()
            studio.pool.shutdown(wait=True)
            studio._search_pool.shutdown(wait=True)
            session.writes.shutdown(wait=True)


class DesktopWorkspaceDropWebEngineTest(unittest.TestCase):
    def test_production_main_qml_and_webengine_drop_routing(self) -> None:
        result = subprocess.run(
            [sys.executable, str(Path(__file__).resolve()), "--webengine-probe"],
            capture_output=True,
            text=True,
            timeout=60,
            env={
                **os.environ,
                "QT_QPA_PLATFORM": "offscreen",
                "QT_QUICK_BACKEND": "software",
                "QTWEBENGINE_CHROMIUM_FLAGS": "--disable-gpu --disable-dev-shm-usage",
            },
        )
        if result.returncode != 0:
            self.fail(
                f"Isolated WebEngine workspace drop probe failed (exit={result.returncode}):\n"
                f"stdout:\n{result.stdout}\nstderr:\n{result.stderr}"
            )

    def test_real_reader_bundle_editor_image_drop_and_multi_file_open(self) -> None:
        if not (ROOT.parent / "dist" / "qt-reader.html").is_file():
            self.skipTest("Built frontend dist/qt-reader.html bundle not present in standalone Python run")
        result = subprocess.run(
            [sys.executable, str(Path(__file__).resolve()), "--real-bundle-probe"],
            capture_output=True,
            text=True,
            timeout=90,
            env={
                **os.environ,
                "QT_QPA_PLATFORM": "offscreen",
                "QT_QUICK_BACKEND": "software",
                "QTWEBENGINE_DISABLE_SANDBOX": "1",
                "QTWEBENGINE_CHROMIUM_FLAGS": "--disable-gpu --disable-dev-shm-usage",
            },
        )
        if result.returncode != 0:
            self.fail(
                f"Real reader bundle Desktop drop probe failed (exit={result.returncode}):\n"
                f"stdout:\n{result.stdout}\nstderr:\n{result.stderr}"
            )


def _real_reader_bundle_probe() -> None:
    os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
    os.environ.setdefault("QT_QUICK_BACKEND", "software")
    os.environ.setdefault("QTWEBENGINE_DISABLE_SANDBOX", "1")
    os.environ.setdefault("QTWEBENGINE_CHROMIUM_FLAGS", "--disable-gpu --disable-dev-shm-usage")

    from PySide6.QtCore import QEvent, QFile, QIODevice, QMetaObject, QMimeData, QObject, QPoint, QPointF, Qt, QUrl, Q_ARG
    from PySide6.QtGui import QColor, QDragEnterEvent, QDragMoveEvent, QDropEvent, QImage
    from PySide6.QtQml import QQmlApplicationEngine
    from PySide6.QtQuick import QQuickItem
    from PySide6.QtQuickControls2 import QQuickStyle
    from PySide6.QtTest import QTest
    from PySide6.QtWebEngineCore import QWebEngineProfile
    from PySide6.QtWebEngineQuick import QtWebEngineQuick
    from PySide6.QtWidgets import QApplication
    from reader_assets import (
        READER_SCHEME,
        SCHEME,
        ReaderAssetSchemeHandler,
        ReaderBundleSchemeHandler,
        reader_bundle_url,
        register_reader_schemes,
    )

    QQuickStyle.setStyle("Material")
    register_reader_schemes()
    QtWebEngineQuick.initialize()
    app = QApplication.instance() or QApplication(["Desktop real reader bundle drop probe"])
    bundle_handler = ReaderBundleSchemeHandler(ROOT.parent / "dist", app)
    QWebEngineProfile.defaultProfile().installUrlSchemeHandler(READER_SCHEME.encode("ascii"), bundle_handler)

    with tempfile.TemporaryDirectory(prefix="supermd-real-bundle-drop-") as tmp:
        tmp_path = Path(tmp)
        current_note = tmp_path / "Current Note.md"
        current_note.write_text("# Current Note\n\nDrop an image directly into the editor.\n", encoding="utf-8")

        session = Session(True)
        asset_handler = ReaderAssetSchemeHandler(session.reader_assets, app)
        QWebEngineProfile.defaultProfile().installUrlSchemeHandler(SCHEME.encode("ascii"), asset_handler)
        session.settings["welcomed"] = True
        session.settings["autosave"] = False
        session.settings["python"] = sys.executable
        session.settings["newNoteLocation"] = str(tmp_path)
        studio = QuietStudio(True, session)
        tab0 = studio.tabs[0]
        tab0["name"] = current_note.name
        tab0["path"] = str(current_note.resolve())
        tab0["content"] = current_note.read_text(encoding="utf-8")
        tab0["saved"] = tab0["content"]

        channel = QFile(":/qtwebchannel/qwebchannel.js")
        if not channel.open(QIODevice.OpenModeFlag.ReadOnly):
            raise RuntimeError("Qt WebChannel runtime unavailable")

        engine = QQmlApplicationEngine()
        engine.rootContext().setContextProperty("studio", studio)
        engine.rootContext().setContextProperty("readerUrl", reader_bundle_url())
        engine.rootContext().setContextProperty("channelScript", bytes(channel.readAll()).decode())
        engine.rootContext().setContextProperty(
            "brandUrl", QUrl.fromLocalFile(str(ROOT.parent / "public" / "brand-mark-fixed.svg"))
        )
        engine.load(QUrl.fromLocalFile(str(ROOT / "qml" / "Main.qml")))
        if not engine.rootObjects():
            raise RuntimeError("Production Main.qml failed to load")

        window = engine.rootObjects()[0]
        studio.host_window = window
        window.show()
        window.raise_()
        window.requestActivate()

        try:
            reader = window.findChild(QObject, "documentReader")
            if not isinstance(reader, QQuickItem):
                raise AssertionError("documentReader not found")

            deadline = time.monotonic() + 25.0
            while time.monotonic() < deadline and not studio.ready:
                app.processEvents()
                QTest.qWait(25)
            if not studio.ready:
                raise AssertionError("Real React reader bundle did not complete WebChannel ready handshake")
            workspace_ready = False
            ws_deadline = time.monotonic() + 15.0
            while time.monotonic() < ws_deadline:
                QMetaObject.invokeMethod(
                    window,
                    "runDocumentScript",
                    Qt.ConnectionType.DirectConnection,
                    Q_ARG(
                        "QVariant",
                        "document.title = (document.querySelector('.cm-editor, .android-reading') && document.body && document.body.innerText.includes('Drop an image')) ? 'ws-ready' : 'ws-wait'",
                    ),
                )
                app.processEvents()
                QTest.qWait(30)
                if reader.property("title") == "ws-ready":
                    workspace_ready = True
                    break
            if not workspace_ready:
                raise AssertionError(f"Real React reader .workspace did not mount in time (title={reader.property('title')!r})")
            window.grabWindow()
            app.processEvents()

            reader_scene = reader.mapToScene(QPointF(reader.width() * 0.5, reader.height() * 0.45))
            reader_pt = QPoint(int(round(reader_scene.x())), int(round(reader_scene.y())))
            sidebar_pt = QPoint(110, int(round(reader_scene.y())))
            os_actions = Qt.DropAction.CopyAction | Qt.DropAction.MoveAction

            # 1. Real MediaTools.tsx image drop across sidebar into Live editor.
            sample_img_path = tmp_path / "dropped-diagram.png"
            sample_img = QImage(48, 32, QImage.Format.Format_RGBA8888)
            sample_img.fill(QColor("#3b82f6"))
            sample_img.save(str(sample_img_path), "PNG")

            img_mime = QMimeData()
            img_mime.setUrls([QUrl.fromLocalFile(str(sample_img_path))])
            app.sendEvent(window, QDragEnterEvent(sidebar_pt, os_actions, img_mime, Qt.MouseButton.LeftButton, Qt.KeyboardModifier.NoModifier))
            app.sendEvent(window, QDragMoveEvent(sidebar_pt, os_actions, img_mime, Qt.MouseButton.LeftButton, Qt.KeyboardModifier.NoModifier))
            app.sendEvent(window, QDragMoveEvent(reader_pt, os_actions, img_mime, Qt.MouseButton.LeftButton, Qt.KeyboardModifier.NoModifier))
            for step in range(30):
                app.processEvents()
                QTest.qWait(25)
                move_ev = QDragMoveEvent(
                    QPoint(reader_pt.x() + (step % 3), reader_pt.y()),
                    os_actions,
                    img_mime,
                    Qt.MouseButton.LeftButton,
                    Qt.KeyboardModifier.NoModifier,
                )
                app.sendEvent(window, move_ev)
                if move_ev.isAccepted():
                    break
            app.sendEvent(window, QDropEvent(QPointF(reader_pt), os_actions, img_mime, Qt.MouseButton.LeftButton, Qt.KeyboardModifier.NoModifier))

            deadline = time.monotonic() + 10.0
            while time.monotonic() < deadline and "![dropped-diagram](" not in studio.tabs[0]["content"]:
                app.processEvents()
                QTest.qWait(25)
            if "![dropped-diagram](" not in studio.tabs[0]["content"]:
                raise AssertionError(f"Expected MediaTools image drop to insert markdown image, got {studio.tabs[0]['content']!r}")
            if len(studio.tabs) != 1:
                raise AssertionError(f"Expected single tab after editor image drop, got {len(studio.tabs)}")

            # 2. Drop workspace folder + multiple notes onto the reader.
            project_folder = tmp_path / "study-workspace"
            project_folder.mkdir()
            (project_folder / "01-overview.md").write_text("# Overview\n", encoding="utf-8")
            (project_folder / "02-calculus.md").write_text("# Calculus\n", encoding="utf-8")

            meeting_note = tmp_path / "Meeting Notes.md"
            meeting_note.write_text("# Meeting Notes\n\nOpened via native workspace drop.\n", encoding="utf-8")
            portable_spec = tmp_path / "Architecture Spec.smd"
            write_portable(
                portable_spec,
                "# Architecture Spec\n\nDropped alongside folder and Markdown notes — opened cleanly in native tabs.\n\n- Native folder tree in sidebar\n- Multi-file tab order preserved\n- Existing editor image drops preserved\n",
                {},
            )

            skipped_bundle_pdf = tmp_path / "handout.pdf"
            skipped_bundle_pdf.write_bytes(b"%PDF-1.4\n")
            expected_bundle_paths = {
                str(current_note.resolve()),
                str(meeting_note.resolve()),
                str(portable_spec.resolve()),
            }

            batch_mime = QMimeData()
            batch_mime.setUrls([
                QUrl.fromLocalFile(str(project_folder)),
                QUrl.fromLocalFile(str(meeting_note)),
                QUrl.fromLocalFile(str(portable_spec)),
                QUrl.fromLocalFile(str(skipped_bundle_pdf)),
            ])
            app.sendEvent(window, QDragEnterEvent(reader_pt, os_actions, batch_mime, Qt.MouseButton.LeftButton, Qt.KeyboardModifier.NoModifier))
            app.sendEvent(window, QDragMoveEvent(reader_pt, os_actions, batch_mime, Qt.MouseButton.LeftButton, Qt.KeyboardModifier.NoModifier))
            app.sendEvent(window, QDropEvent(QPointF(reader_pt), os_actions, batch_mime, Qt.MouseButton.LeftButton, Qt.KeyboardModifier.NoModifier))

            deadline = time.monotonic() + 10.0
            while time.monotonic() < deadline and (
                not expected_bundle_paths.issubset({t["path"] for t in studio.tabs if t["path"]})
                or studio.folder != str(project_folder.resolve())
                or [f["name"] for f in studio.files] != ["01-overview.md", "02-calculus.md"]
                or "skipped 1 unsupported item" not in _footer_notice_text(window).lower()
            ):
                app.processEvents()
                QTest.qWait(25)

            if [t["path"] for t in studio.tabs] != [
                str(current_note.resolve()),
                str(meeting_note.resolve()),
                str(portable_spec.resolve()),
            ]:
                raise AssertionError(f"Unexpected tab order after multi-item drop: {[t['path'] for t in studio.tabs]}")
            if studio._current()["path"] != str(portable_spec.resolve()):
                raise AssertionError(f"Unexpected active tab after multi-item drop: {studio._current()['path']}")
            if studio.folder != str(project_folder.resolve()):
                raise AssertionError(f"Unexpected folder after drop: {studio.folder}")
            if [f["name"] for f in studio.files] != ["01-overview.md", "02-calculus.md"]:
                raise AssertionError(f"Unexpected folder listing after drop: {studio.files}")
            if "skipped 1 unsupported item" not in _footer_notice_text(window).lower():
                raise AssertionError(f"Expected visible skipped-item notice in Main.qml footer, got {_footer_notice_text(window)!r}")
            if "![dropped-diagram](" not in studio.tabs[0]["content"]:
                raise AssertionError("Previously dropped image in first tab was lost")

            dom_deadline = time.monotonic() + 10.0
            rendered_ok = False
            while time.monotonic() < dom_deadline:
                QMetaObject.invokeMethod(
                    window,
                    "runDocumentScript",
                    Qt.ConnectionType.DirectConnection,
                    Q_ARG("QVariant", "document.title = document.body ? document.body.innerText : ''"),
                )
                app.processEvents()
                QTest.qWait(40)
                if "Architecture Spec" in str(reader.property("title") or ""):
                    rendered_ok = True
                    break
            if not rendered_ok:
                raise AssertionError(
                    f"Active dropped note did not render in WebEngine DOM; title={reader.property('title')!r}"
                )

            screenshot_out = os.environ.get("SUPERMD_DROP_SCREENSHOT", "").strip()
            if screenshot_out:
                for _ in range(15):
                    app.processEvents()
                    QTest.qWait(30)
                image = window.grabWindow()
                image.save(screenshot_out, "PNG")
        finally:
            window.close()
            window.deleteLater()
            app.sendPostedEvents(None, QEvent.Type.DeferredDelete)
            engine.deleteLater()
            app.sendPostedEvents(None, QEvent.Type.DeferredDelete)
            studio.stop()
            studio.pool.shutdown(wait=True)
            studio._search_pool.shutdown(wait=True)
            session.writes.shutdown(wait=True)


if __name__ == "__main__":
    if "--webengine-probe" in sys.argv:
        _webengine_drop_probe()
        sys.exit(0)
    if "--real-bundle-probe" in sys.argv:
        _real_reader_bundle_probe()
        sys.exit(0)
    unittest.main()
