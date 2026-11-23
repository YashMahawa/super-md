"""Unit and headless Qt/WebEngine tests for Quick Switcher, streaming cross-note search, and recursive sidebar filtering."""
from __future__ import annotations

import base64
import json
import os
import subprocess
import sys
import tempfile
import threading
import time
import unittest
import uuid
from pathlib import Path
from unittest.mock import patch

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
os.environ.setdefault("QT_QUICK_BACKEND", "software")
os.environ.setdefault("QTWEBENGINE_DISABLE_SANDBOX", "1")

from PySide6.QtCore import QCoreApplication
from PySide6.QtGui import QGuiApplication

import documents
from shortcuts import default_shortcuts, native_label, normalize_shortcuts
from studio import Session
from test_studio import QuietStudio
from workspace_search import (
    filter_folder_tree,
    mask_diagram_spans,
    rank_quick_switcher,
    stream_text_search,
)

TINY_PNG = (
    "data:image/png;base64,"
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="
)


def _wait_until(predicate, timeout: float = 5.0) -> bool:
    app = QCoreApplication.instance()
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if app is not None:
            app.processEvents()
        if predicate():
            return True
        time.sleep(0.015)
    return bool(predicate())


def _webengine_e2e_probe() -> int:
    os.environ["QT_QPA_PLATFORM"] = "offscreen"
    os.environ["QT_QUICK_BACKEND"] = "software"
    os.environ.setdefault("QTWEBENGINE_DISABLE_SANDBOX", "1")
    os.environ.setdefault("QTWEBENGINE_CHROMIUM_FLAGS", "--disable-gpu --disable-dev-shm-usage")

    from PySide6.QtCore import QFile, QIODevice, QMetaObject, QObject, QUrl, Qt, Q_ARG
    from PySide6.QtQml import QQmlApplicationEngine
    from PySide6.QtQuick import QQuickItem, QQuickWindow  # noqa: F401
    from PySide6.QtQuickControls2 import QQuickStyle
    from PySide6.QtTest import QTest
    from PySide6.QtWebEngineQuick import QtWebEngineQuick
    from PySide6.QtWidgets import QApplication

    QQuickStyle.setStyle("Material")
    QtWebEngineQuick.initialize()
    app = QApplication(["Super MD folder search probe"])

    root = Path(__file__).resolve().parent
    sys.path.insert(0, str(root))
    from studio import Session
    from test_studio import QuietStudio

    with tempfile.TemporaryDirectory(prefix="supermd-search-e2e-") as temp_dir:
        folder = Path(temp_dir) / "notes"
        (folder / "research" / "deep").mkdir(parents=True)
        (folder / "empty_dir" / "sub_empty").mkdir(parents=True)

        plain_note = folder / "alpha.md"
        plain_note.write_text("# Alpha\n\nPlain markdown paragraph.\n", encoding="utf-8")

        portable_note = folder / "research" / "deep" / "quantum-field.smd"
        documents.write_portable(
            portable_note,
            "# Quantum Field\n\n```mermaid\ngraph TD\n  A[AuroraSignal] --> B\n```\n\nReal prose with AuroraSignal inside portable bundle.\nSecond AuroraSignal line.\n",
            {"assets/pixel.png": TINY_PNG},
        )

        session = Session(True)
        session.settings["python"] = sys.executable
        session.settings["welcomed"] = True
        session.settings["newNoteLocation"] = temp_dir
        studio = QuietStudio(True, session)
        studio.openFolder(str(folder))
        _wait_until(lambda: len(studio.files) > 0)

        # Start with ZERO open tabs to verify AC1 (Ctrl+P works with zero open tabs).
        studio.tabs.clear()
        studio.active = ""
        studio.recent = [str(plain_note), str(portable_note)]
        session.pinned = [str(portable_note)]
        studio._emit(False)

        channel = QFile(":/qtwebchannel/qwebchannel.js")
        if not channel.open(QIODevice.OpenModeFlag.ReadOnly):
            raise RuntimeError("Qt WebChannel runtime unavailable")
        engine = QQmlApplicationEngine()
        engine.rootContext().setContextProperty("studio", studio)
        engine.rootContext().setContextProperty("readerUrl", QUrl.fromLocalFile(str(root.parent / "dist" / "qt-reader.html")))
        engine.rootContext().setContextProperty("channelScript", bytes(channel.readAll()).decode())
        engine.rootContext().setContextProperty("brandUrl", QUrl.fromLocalFile(str(root.parent / "public" / "brand-mark-fixed.svg")))
        engine.load(QUrl.fromLocalFile(str(root / "qml" / "Main.qml")))
        if not engine.rootObjects():
            raise RuntimeError("Main.qml failed to load")

        window = engine.rootObjects()[0]
        studio.host_window = window
        window.resize(1280, 800)
        window.show()
        QTest.qWait(120)

        quick_dialog = window.findChild(QObject, "quickSwitcherDialog")
        search_dialog = window.findChild(QObject, "folderSearchDialog")
        assert quick_dialog is not None and search_dialog is not None

        # 1. Trigger Ctrl+P with zero open tabs -> opens Quick Switcher with pinned note first.
        QTest.keyClick(window, Qt.Key.Key_P, Qt.KeyboardModifier.ControlModifier)
        assert _wait_until(lambda: bool(quick_dialog.property("visible")) and not studio.quickSwitcherState["loading"])
        items = studio.quickSwitcherState["items"]
        assert len(items) >= 2, f"Expected items in quick switcher, got {items}"
        assert items[0]["name"] == "quantum-field.smd" and items[0]["pinned"], f"Pinned note must be first: {items}"

        # Filter to alpha in <= 3 keystrokes and press Enter to open it.
        quick_input = window.findChild(QObject, "quickSwitcherInput")
        assert quick_input is not None
        quick_input.forceActiveFocus()
        for key in (Qt.Key.Key_A, Qt.Key.Key_L, Qt.Key.Key_P):
            QTest.keyClick(window, key)
        assert _wait_until(lambda: len(studio.quickSwitcherState["items"]) >= 1 and studio.quickSwitcherState["items"][0]["name"] == "alpha.md")
        QTest.keyClick(window, Qt.Key.Key_Return)
        assert _wait_until(lambda: not bool(quick_dialog.property("visible")) and len(studio.tabs) == 1 and studio._current()["name"] == "alpha.md")

        # Wait for WebEngine reader_ready handshake.
        assert _wait_until(lambda: studio.ready, timeout=15.0), "WebEngine reader did not become ready"

        # 2. Press Ctrl+Shift+F -> open FolderSearchDialog, then Escape -> dismisses and cancels.
        QTest.keyClick(window, Qt.Key.Key_F, Qt.KeyboardModifier.ControlModifier | Qt.KeyboardModifier.ShiftModifier)
        assert _wait_until(lambda: bool(search_dialog.property("visible")))
        search_input = window.findChild(QObject, "folderSearchInput")
        assert search_input is not None
        search_input.forceActiveFocus()
        QTest.keyClick(window, Qt.Key.Key_Escape)
        assert _wait_until(lambda: not bool(search_dialog.property("visible")) and not studio.folderSearchState["scanning"])

        # 3. Reopen Ctrl+Shift+F, search "AuroraSignal", select match -> opens .smd note with ReadingSearch seeded and highlighting!
        QTest.keyClick(window, Qt.Key.Key_F, Qt.KeyboardModifier.ControlModifier | Qt.KeyboardModifier.ShiftModifier)
        assert _wait_until(lambda: bool(search_dialog.property("visible")))
        search_input.forceActiveFocus()
        search_input.setProperty("text", "AuroraSignal")
        assert _wait_until(
            lambda: not studio.folderSearchState["scanning"] and len(studio.folderSearchState["matches"]) == 2,
            timeout=8.0,
        ), f"Expected 2 non-diagram matches for AuroraSignal, got {studio.folderSearchState}"
        # Mermaid block on lines 3-6 must be skipped; prose matches start at line 8!
        lines = [m["line"] for m in studio.folderSearchState["matches"]]
        assert lines == [8, 9], f"Expected matches only on prose lines [8, 9], got {lines}"

        QTest.keyClick(window, Qt.Key.Key_Return)
        assert _wait_until(
            lambda: not bool(search_dialog.property("visible")) and studio._current()["name"] == "quantum-field.smd",
            timeout=8.0,
        )

        def eval_reader(js_expr: str) -> dict:
            deadline = time.monotonic() + 12.0
            req = uuid.uuid4().hex
            wrapped = (
                "(()=>{try{const val=(" + js_expr + ");"
                "document.title=JSON.stringify({request:" + json.dumps(req) + ",value:val})}"
                "catch(e){document.title=JSON.stringify({request:" + json.dumps(req) + ",error:String(e)})}})()"
            )
            reader = window.findChild(QObject, "documentReader")
            while time.monotonic() < deadline:
                QMetaObject.invokeMethod(window, "runDocumentScript", Qt.ConnectionType.DirectConnection, Q_ARG("QVariant", wrapped))
                step_end = min(deadline, time.monotonic() + 0.4)
                while time.monotonic() < step_end:
                    app.processEvents()
                    title = str(reader.property("title") or "") if reader else ""
                    if title.startswith("{"):
                        try:
                            parsed = json.loads(title)
                        except json.JSONDecodeError:
                            parsed = {}
                        if parsed.get("request") == req:
                            return parsed
                    time.sleep(0.02)
            raise AssertionError("Timed out evaluating script in WebEngine reader")

        assert _wait_until(
            lambda: eval_reader(
                "({open: !!document.querySelector('.reading-search'),"
                " query: document.querySelector('.reading-search input[role=\"searchbox\"]')?.value || '',"
                " status: document.querySelector('.reading-search output')?.textContent || '',"
                " highlighted: typeof CSS !== 'undefined' && CSS.highlights?.has('smd-search')})"
            ).get("value")
            == {"open": True, "query": "AuroraSignal", "status": "1 / 2", "highlighted": True},
            timeout=10.0,
        ), "Expected seeded in-note ReadingSearch highlighting 2 matches"

        window.close()
        studio.stop()
        studio.pool.shutdown(wait=True)
        session.writes.shutdown(wait=True)
    return 0


class WorkspaceSearchDesktopTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.app = QGuiApplication.instance() or QGuiApplication(["Workspace search desktop tests"])

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="supermd-folder-search-")
        self.root = Path(self.temp.name)
        self.session = Session(True)
        self.session.settings["python"] = sys.executable
        self.studio = QuietStudio(True, self.session)

    def tearDown(self):
        self.studio.stop()
        self.studio.pool.shutdown(wait=True)
        self.session.writes.shutdown(wait=True)
        self.temp.cleanup()

    def test_shortcuts_register_ctrl_p_and_ctrl_shift_f_portably_and_customize(self):
        for plat in ("linux", "win32", "darwin"):
            defaults = default_shortcuts(plat)
            self.assertEqual(defaults["quick_switcher"], ["Ctrl+P"])
            self.assertEqual(defaults["search_folder"], ["Ctrl+Shift+F"])
        self.assertEqual(
            native_label("Ctrl+P"),
            "⌘P" if sys.platform == "darwin" else "Ctrl+P",
        )
        self.assertEqual(self.studio.setShortcut("quick_switcher", "Ctrl+K"), "")
        self.assertEqual(self.studio.shortcutSequences("quick_switcher"), ["Ctrl+K"])
        validated, err = normalize_shortcuts({"quick_switcher": ["Ctrl+O"]})
        self.assertIsNone(validated)
        self.assertIn("Open note", err)
        self.assertIn("Save note", self.studio.setShortcut("search_folder", "Ctrl+S"))

    def test_portable_smd_and_renamed_bundle_search_never_decodes_embedded_images(self):
        smd_path = self.root / "heavy-images.smd"
        renamed_bundle = self.root / "disguised-bundle.txt"
        plain_json_fmd = self.root / "legacy-envelope.fmd"

        documents.write_portable(
            smd_path,
            "# Lab Report\n\n Measured PlanckConstant accurately.\n",
            {"assets/photo.png": TINY_PNG},
        )
        # Copy gzipped .smd bytes to a .txt extension to verify content-based detection.
        renamed_bundle.write_bytes(smd_path.read_bytes())
        plain_json_fmd.write_text(
            json.dumps({
                "format": "supermd-fmd",
                "version": 1,
                "markdown": "# Legacy\n\nPlanckConstant in plain envelope.\n",
                "assets": {"assets/photo.png": TINY_PNG},
            }),
            encoding="utf-8",
        )

        with patch.object(documents, "image_data", side_effect=AssertionError("Must not decode embedded images")) as spy_img, patch.object(
            base64, "b64decode", side_effect=AssertionError("Must not base64-decode embedded assets")
        ) as spy_b64:
            result = stream_text_search("PlanckConstant", [], [], self.root)
            spy_img.assert_not_called()
            spy_b64.assert_not_called()

        matched_files = {m["name"]: m["line"] for m in result["matches"]}
        self.assertEqual(
            matched_files,
            {"heavy-images.smd": 3, "disguised-bundle.txt": 3, "legacy-envelope.fmd": 3},
        )

    def test_live_unsaved_tab_buffer_overrides_disk_and_skips_diagrams_by_default(self):
        note_path = self.root / "draft.md"
        note_path.write_text("# Disk Version\n\nOldDiskPhrase only on disk.\n", encoding="utf-8")

        live_markdown = "\n".join([
            "# Edited Live Tab",
            "Inline <svg width='10' height='10'><text>LiveUniqueToken</text></svg> surrounding prose.",
            "```mermaid",
            "graph LR",
            "  X[LiveUniqueToken]",
            "```",
            "```smd-chart",
            '{"title": "LiveUniqueToken", "series": []}',
            "```",
            "Visible LiveUniqueToken on line ten.",
        ])
        tabs = [{
            "id": "tab-1",
            "name": "draft.md",
            "path": str(note_path),
            "content": live_markdown,
            "dirty": True,
        }]

        stale = stream_text_search("OldDiskPhrase", tabs, [], self.root)
        self.assertEqual(stale["matches"], [], "Older disk file must be shadowed by open tab buffer")

        default_res = stream_text_search("LiveUniqueToken", tabs, [], self.root)
        self.assertEqual(len(default_res["matches"]), 1)
        self.assertEqual(default_res["matches"][0]["line"], 10)
        self.assertTrue(default_res["matches"][0]["dirty"])

        with_diagrams = stream_text_search("LiveUniqueToken", tabs, [], self.root, exclude_diagrams=False)
        self.assertEqual([m["line"] for m in with_diagrams["matches"]], [2, 5, 8, 10])

    def test_dotfiles_symlinks_no_folder_fallback_and_zero_disk_index(self):
        hidden_dir = self.root / ".obsidian"
        hidden_dir.mkdir()
        (hidden_dir / "hidden.md").write_text("SecretNeedle", encoding="utf-8")
        (self.root / ".hidden_note.md").write_text("SecretNeedle", encoding="utf-8")

        outside = tempfile.TemporaryDirectory(prefix="supermd-outside-")
        self.addCleanup(outside.cleanup)
        outside_note = Path(outside.name) / "external.md"
        outside_note.write_text("SecretNeedle and RecentNeedle", encoding="utf-8")

        symlink_note = self.root / "linked.md"
        symlink_note.symlink_to(outside_note)

        real_note = self.root / "visible.md"
        real_note.write_text("VisibleNeedle on line 1", encoding="utf-8")

        before_entries = sorted(p.relative_to(self.root).as_posix() for p in self.root.rglob("*"))
        folder_res = stream_text_search("SecretNeedle", [], [], self.root)
        self.assertEqual(folder_res["matches"], [], "Dotfiles and symlinks must be skipped")
        after_entries = sorted(p.relative_to(self.root).as_posix() for p in self.root.rglob("*"))
        self.assertEqual(before_entries, after_entries, "Search must write zero cached index files to disk")

        # Without an open folder, scan open tabs and recent notes without permission prompts.
        no_folder_res = stream_text_search(
            "RecentNeedle",
            [{"id": "t1", "name": "Untitled.md", "path": "", "content": "RecentNeedle in unsaved draft", "dirty": True}],
            [{"path": str(outside_note), "name": "external.md", "pinned": True}],
            None,
        )
        self.assertEqual({m["name"] for m in no_folder_res["matches"]}, {"Untitled.md", "external.md"})

    def test_quick_switcher_empty_pinned_recent_order_and_fuzzy_ranking(self):
        (self.root / "courses" / "spring").mkdir(parents=True)
        pinned_file = self.root / "pinned.md"
        recent_file = self.root / "recent.md"
        nested_file = self.root / "courses" / "spring" / "QuantumMechanicsLecture.smd"
        for f in (pinned_file, recent_file, nested_file):
            f.write_text("# Note\n", encoding="utf-8")

        recent = [
            {"path": str(recent_file), "name": "recent.md", "pinned": False},
            {"path": str(pinned_file), "name": "pinned.md", "pinned": True},
        ]
        # Zero open tabs!
        empty_ranked = rank_quick_switcher("", [], recent, self.root)
        self.assertEqual([item["name"] for item in empty_ranked[:2]], ["pinned.md", "recent.md"])

        # 3-keystroke acronym/subsequence match on nested collapsed file
        fuzzy_ranked = rank_quick_switcher("qml", [], recent, self.root)
        self.assertGreaterEqual(len(fuzzy_ranked), 1)
        self.assertEqual(fuzzy_ranked[0]["name"], "QuantumMechanicsLecture.smd")
        self.assertEqual(fuzzy_ranked[0]["relative"], "courses/spring/QuantumMechanicsLecture.smd")

    def test_recursive_sidebar_filter_finds_collapsed_subfolders_and_hides_empty_folders(self):
        (self.root / "collapsed_a" / "nested_b").mkdir(parents=True)
        (self.root / "empty_folder" / "empty_child").mkdir(parents=True)
        (self.root / "unmatched_folder").mkdir()
        (self.root / "unmatched_folder" / "other.md").write_text("# Other", encoding="utf-8")
        target = self.root / "collapsed_a" / "nested_b" / "relativity-summary.smd"
        documents.write_portable(target, "# Relativity", {})

        self.studio.openFolder(str(self.root))
        self.assertTrue(_wait_until(lambda: len(self.studio.files) > 0))
        # Before filtering, collapsed_a is NOT expanded, so relativity-summary.smd is not in studio.files.
        self.assertNotIn("relativity-summary.smd", [f["name"] for f in self.studio.files])

        self.studio.setSidebarFilter("relativity")
        self.assertTrue(
            _wait_until(lambda: any(f["name"] == "relativity-summary.smd" for f in self.studio.files))
        )
        names = [(f["name"], f["directory"], f["depth"]) for f in self.studio.files]
        self.assertEqual(
            names,
            [
                ("collapsed_a", True, 0),
                ("nested_b", True, 1),
                ("relativity-summary.smd", False, 2),
            ],
            "Only ancestor directories with matching descendants may appear; zero empty/unmatched folders",
        )

    def test_cancellation_stops_in_flight_scan_immediately(self):
        for i in range(60):
            (self.root / f"note_{i:03d}.md").write_text(f"Line {i} SearchTarget\n", encoding="utf-8")
        cancel_event = threading.Event()
        batches = []

        def on_batch(batch, _scanned, _trunc, _done):
            batches.append(len(batch))
            cancel_event.set()

        res = stream_text_search(
            "SearchTarget",
            [],
            [],
            self.root,
            cancel_event=cancel_event,
            on_batch=on_batch,
        )
        self.assertTrue(res["cancelled"])
        self.assertLess(res["scannedFiles"], 60)

    def test_qml_and_webengine_quick_switcher_escape_and_seeded_reader_search(self):
        completed = subprocess.run(
            [sys.executable, __file__, "--webengine-probe"],
            cwd=str(Path(__file__).resolve().parent),
            capture_output=True,
            text=True,
            timeout=90,
        )
        self.assertEqual(
            completed.returncode,
            0,
            f"WebEngine E2E probe failed:\nSTDOUT:\n{completed.stdout}\nSTDERR:\n{completed.stderr}",
        )


if __name__ == "__main__":
    if "--webengine-probe" in sys.argv:
        raise SystemExit(_webengine_e2e_probe())
    unittest.main()
