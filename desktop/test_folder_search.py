"""Unit and headless Qt/WebEngine tests for streaming cross-note search and Unicode UTF-16 snippet offsets."""
from __future__ import annotations

import base64
import contextlib
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

from PySide6.QtCore import QCoreApplication, QEvent, QMetaObject, QObject, QPointF, QUrl, Qt, Q_ARG, Q_RETURN_ARG
from PySide6.QtGui import QGuiApplication, QKeyEvent
from PySide6.QtQml import QQmlApplicationEngine, QQmlComponent, QQmlEngine
from PySide6.QtQuickControls2 import QQuickStyle
from PySide6.QtTest import QTest

import documents
from shortcuts import default_shortcuts, native_label, normalize_shortcuts
from studio import Session
from test_studio import QuietStudio
from workspace_search import (
    BATCH_SIZE,
    MAX_MATCHES_PER_NOTE,
    fold_with_offsets,
    stream_text_search,
    utf16_offset,
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
        time.sleep(0.005)
    return bool(predicate())


def _webengine_e2e_probe() -> int:
    os.environ["QT_QPA_PLATFORM"] = "offscreen"
    os.environ["QT_QUICK_BACKEND"] = "software"
    os.environ.setdefault("QTWEBENGINE_DISABLE_SANDBOX", "1")
    os.environ.setdefault("QTWEBENGINE_CHROMIUM_FLAGS", "--disable-gpu --disable-dev-shm-usage")

    from PySide6.QtCore import QFile, QIODevice, QMetaObject, QObject, QUrl, Qt, Q_ARG
    from PySide6.QtGui import QKeySequence
    from PySide6.QtQml import QQmlApplicationEngine
    from PySide6.QtQuick import QQuickItem, QQuickWindow  # noqa: F401
    from PySide6.QtQuickControls2 import QQuickStyle
    from PySide6.QtSvg import QSvgRenderer
    from PySide6.QtTest import QTest
    from PySide6.QtWebEngineCore import QWebEngineProfile
    from PySide6.QtWebEngineQuick import QtWebEngineQuick
    from PySide6.QtWidgets import QApplication

    root = Path(__file__).resolve().parent
    sys.path.insert(0, str(root))
    from reader_assets import READER_SCHEME, ReaderBundleSchemeHandler, reader_bundle_url, register_reader_schemes
    from studio import Session
    from test_studio import QuietStudio

    QQuickStyle.setStyle("Material")
    register_reader_schemes()
    QtWebEngineQuick.initialize()
    app = QApplication(["Super MD folder search probe"])
    bundle_handler = ReaderBundleSchemeHandler(root.parent / "dist", app)
    QWebEngineProfile.defaultProfile().installUrlSchemeHandler(READER_SCHEME.encode("ascii"), bundle_handler)

    with tempfile.TemporaryDirectory(prefix="supermd-search-e2e-") as temp_dir:
        resolved_temp = Path(temp_dir).resolve()
        folder = resolved_temp / "notes"
        (folder / "research" / "deep").mkdir(parents=True)

        plain_note = folder / "alpha.md"
        plain_note.write_text("# Alpha\n\nPlain markdown paragraph.\n", encoding="utf-8")

        portable_note = folder / "research" / "deep" / "quantum-field.smd"
        documents.write_portable(
            portable_note,
            "# Quantum Field\n\n```mermaid\ngraph TD\n  A[AuroraSignal] --> B\n```\n\nİstanbul 📓 prose with AuroraSignal inside portable bundle.\nSecond AuroraSignal line with [reference](https://example.com/HiddenUrlSignal).\n",
            {"assets/pixel.png": TINY_PNG},
        )

        session = Session(True)
        session.settings["python"] = sys.executable
        session.settings["welcomed"] = True
        session.settings["newNoteLocation"] = str(resolved_temp)
        studio = QuietStudio(True, session)
        studio.openFolder(str(folder))
        _wait_until(lambda: len(studio.files) > 0)

        channel = QFile(":/qtwebchannel/qwebchannel.js")
        if not channel.open(QIODevice.OpenModeFlag.ReadOnly):
            raise RuntimeError("Qt WebChannel runtime unavailable")
        engine = QQmlApplicationEngine()
        engine.rootContext().setContextProperty("studio", studio)
        engine.rootContext().setContextProperty("readerUrl", reader_bundle_url())
        engine.rootContext().setContextProperty("channelScript", bytes(channel.readAll()).decode())
        engine.rootContext().setContextProperty("brandUrl", QUrl.fromLocalFile(str(root.parent / "public" / "brand-mark-fixed.svg")))
        engine.load(QUrl.fromLocalFile(str(root / "qml" / "Main.qml")))
        if not engine.rootObjects():
            raise RuntimeError("Main.qml failed to load")

        window = engine.rootObjects()[0]
        studio.host_window = window
        window.resize(1280, 800)
        window.show()
        window.raise_()
        window.requestActivate()
        QTest.qWaitForWindowActive(window, 2000)
        QTest.qWait(120)

        search_dialog = window.findChild(QObject, "folderSearchDialog")
        assert search_dialog is not None

        note_find = window.findChild(QObject, "findInNoteButton")
        folder_search = window.findChild(QObject, "sidebarFolderSearchButton")
        assert note_find is not None and folder_search is not None
        assert note_find.property("glyph") == "MagnifyingGlass"
        assert folder_search.property("glyph") == "FolderSearch"
        for button in (note_find, folder_search):
            glyph = button.property("glyph")
            assert QSvgRenderer(str(root / "icons" / f"{glyph}.svg")).isValid()

        def send_window_shortcut(action_id: str) -> None:
            assert _wait_until(lambda: int(window.property("modalDialogCount") or 0) == 0), (
                f"Expected modalDialogCount==0 before {action_id}, got {window.property('modalDialogCount')}"
            )
            window.raise_()
            window.requestActivate()
            QTest.qWaitForWindowActive(window, 1000)
            app.processEvents()
            seq = QKeySequence.fromString(
                studio.shortcutSequences(action_id)[0],
                QKeySequence.SequenceFormat.PortableText,
            )
            combo = seq[0]
            QTest.keyClick(window, combo.key(), combo.keyboardModifiers())

        # Wait for WebEngine reader_ready handshake.
        assert _wait_until(lambda: studio.ready, timeout=20.0), "WebEngine reader did not become ready"

        # 1. Press Ctrl+Shift+F -> open FolderSearchDialog, then Escape -> dismisses and cancels.
        send_window_shortcut("search_folder")
        assert _wait_until(lambda: bool(search_dialog.property("opened")), timeout=8.0), (
            f"FolderSearchDialog did not open: visible={search_dialog.property('visible')} state={studio.folderSearchState}"
        )
        search_input = window.findChild(QObject, "folderSearchInput")
        assert search_input is not None
        window.requestActivate()
        search_input.forceActiveFocus()
        assert _wait_until(lambda: bool(search_input.property("activeFocus"))), "folderSearchInput did not gain focus"
        QTest.keyClick(window, Qt.Key.Key_Escape)
        assert _wait_until(
            lambda: not bool(search_dialog.property("visible"))
            and int(window.property("modalDialogCount") or 0) == 0
            and not studio.folderSearchState["scanning"],
            timeout=8.0,
        ), f"Escape did not close FolderSearchDialog: visible={search_dialog.property('visible')} modal={window.property('modalDialogCount')}"

        # 2. Reopen Ctrl+Shift+F, search "AuroraSignal", select match -> opens .smd note with ReadingSearch seeded and highlighting!
        send_window_shortcut("search_folder")
        assert _wait_until(lambda: bool(search_dialog.property("opened")), timeout=8.0), "FolderSearchDialog did not reopen"
        window.requestActivate()
        search_input.forceActiveFocus()
        assert _wait_until(lambda: bool(search_input.property("activeFocus"))), "folderSearchInput did not regain focus"
        search_input.setProperty("text", "AuroraSignal")
        assert _wait_until(
            lambda: not studio.folderSearchState["scanning"] and len(studio.folderSearchState["matches"]) == 2,
            timeout=10.0,
        ), f"Expected 2 non-diagram matches for AuroraSignal, got {studio.folderSearchState}"
        # Mermaid block on lines 3-6 must be skipped; prose matches start at line 8!
        lines = [m["line"] for m in studio.folderSearchState["matches"]]
        assert lines == [8, 9], f"Expected matches only on prose lines [8, 9], got {lines}"

        search_input.forceActiveFocus()
        QTest.keyClick(window, Qt.Key.Key_Return)
        assert _wait_until(
            lambda: not bool(search_dialog.property("visible")) and studio._current()["name"] == "quantum-field.smd",
            timeout=10.0,
        ), f"Return in FolderSearchDialog did not open quantum-field.smd: current={studio._current()['name']!r} state={studio.folderSearchState}"

        def eval_reader(js_expr: str) -> dict:
            deadline = time.monotonic() + 15.0
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
            timeout=15.0,
        ), "Expected seeded in-note ReadingSearch highlighting occurrence 1 / 2"

        # 3. Reopen Ctrl+Shift+F, move Down to the 2nd occurrence of "AuroraSignal" (after İstanbul 📓), press Return -> reveals 2 / 2!
        send_window_shortcut("search_folder")
        assert _wait_until(lambda: bool(search_dialog.property("opened")), timeout=8.0), "FolderSearchDialog did not reopen for 2nd occurrence"
        window.requestActivate()
        search_input.forceActiveFocus()
        assert _wait_until(lambda: bool(search_input.property("activeFocus"))), "folderSearchInput did not regain focus for 2nd occurrence"
        assert _wait_until(
            lambda: not studio.folderSearchState["scanning"] and len(studio.folderSearchState["matches"]) == 2,
            timeout=10.0,
        ), f"Expected 2 matches for AuroraSignal on reopen, got {studio.folderSearchState}"
        QTest.keyClick(window, Qt.Key.Key_Down)
        QTest.keyClick(window, Qt.Key.Key_Return)
        assert _wait_until(lambda: not bool(search_dialog.property("visible")), timeout=8.0)
        assert _wait_until(
            lambda: eval_reader("document.querySelector('.reading-search output')?.textContent || ''").get("value") == "2 / 2",
            timeout=15.0,
        ), f"Expected 2nd folder-search occurrence to reveal 2 / 2, got {eval_reader('document.querySelector(\".reading-search output\")?.textContent || \"\"')}"

        # 4. Hidden Markdown URL hit reveals block separately as "In Markdown source" instead of "No matches".
        send_window_shortcut("search_folder")
        assert _wait_until(lambda: bool(search_dialog.property("opened")), timeout=8.0), "FolderSearchDialog did not reopen for hidden URL"
        window.requestActivate()
        search_input.forceActiveFocus()
        assert _wait_until(lambda: bool(search_input.property("activeFocus"))), "folderSearchInput did not regain focus for hidden URL"
        search_input.setProperty("text", "HiddenUrlSignal")
        assert _wait_until(
            lambda: not studio.folderSearchState["scanning"] and len(studio.folderSearchState["matches"]) == 1,
            timeout=10.0,
        ), f"Expected 1 match for HiddenUrlSignal, got {studio.folderSearchState}"
        QTest.keyClick(window, Qt.Key.Key_Return)
        assert _wait_until(lambda: not bool(search_dialog.property("visible")), timeout=8.0)
        assert _wait_until(
            lambda: eval_reader("document.querySelector('.reading-search output')?.textContent || ''").get("value") == "In Markdown source",
            timeout=15.0,
        ), f"Expected hidden URL hit status 'In Markdown source', got {eval_reader('document.querySelector(\".reading-search output\")?.textContent || \"\"')}"

        print(json.dumps({"ok": True, "lines": lines}), flush=True)
        window.setProperty("closingAllowed", True)
        window.setProperty("intentionalShutdown", True)
        window.close()
        del engine
        studio.stop()
        studio._search_pool.shutdown(wait=False, cancel_futures=True)
        studio.pool.shutdown(wait=False, cancel_futures=True)
        session.writes.shutdown(wait=False)
    os._exit(0)


FOLDER_SEARCH_HOST_QML = b"""
import QtQuick
import QtQuick.Controls
import QtQuick.Controls.Material

ApplicationWindow {
    id: window; width: 960; height: 680; visible: true; color: viewState.colors.surface
    property var viewState: JSON.parse(studio.snapshot)
    property int modalDialogCount: 0
    function focusReader() {}
    Material.theme: viewState.dark ? Material.Dark : Material.Light
    Material.primary: viewState.colors.primary; Material.accent: viewState.colors.primary
    Material.background: viewState.colors.surface; Material.foreground: viewState.colors.text
    Connections {
        target: studio
        function onWorkspaceSearchChanged() {
            if (studio.folderSearchState.open && !folderSearchDialog.visible) folderSearchDialog.open()
            else if (!studio.folderSearchState.open && folderSearchDialog.visible) folderSearchDialog.close()
        }
    }
    FolderSearchDialog { id: folderSearchDialog }
}
"""


class WorkspaceSearchDesktopTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if QGuiApplication.instance() is None:
            QQuickStyle.setStyle("Material")
        cls.app = QGuiApplication.instance() or QGuiApplication(["Workspace search desktop tests"])

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="supermd-folder-search-")
        self.root = Path(self.temp.name).resolve()
        self.session = Session(True)
        self.session.settings["python"] = sys.executable
        self.studio = QuietStudio(True, self.session)

    def tearDown(self):
        self.studio.stop()
        self.studio._search_pool.shutdown(wait=True, cancel_futures=True)
        self.studio.pool.shutdown(wait=True)
        self.session.writes.shutdown(wait=True)
        self.app.sendPostedEvents(None, QEvent.Type.DeferredDelete)
        self.temp.cleanup()

    def test_shortcuts_register_ctrl_shift_f_portably_and_customize(self):
        for plat in ("linux", "win32", "darwin"):
            defaults = default_shortcuts(plat)
            self.assertEqual(defaults["search_folder"], ["Ctrl+Shift+F"])
        self.assertEqual(
            native_label("Ctrl+Shift+F"),
            "⇧⌘F" if sys.platform == "darwin" else "Ctrl+Shift+F",
        )
        self.assertEqual(self.studio.setShortcut("search_folder", "Ctrl+Shift+K"), "")
        self.assertEqual(self.studio.shortcutSequences("search_folder"), ["Ctrl+Shift+K"])
        validated, err = normalize_shortcuts({"search_folder": ["Ctrl+O"]})
        self.assertIsNone(validated)
        self.assertIn("Open note", err)
        self.assertIn("Save note", self.studio.setShortcut("search_folder", "Ctrl+S"))

    def test_unicode_casefold_expansion_and_astral_utf16_snippet_highlighting_in_qml(self):
        folded, starts, ends = fold_with_offsets("İstanbul: note")
        self.assertEqual(folded, "i\u0307stanbul: note")
        self.assertEqual(starts[:2], [0, 0])
        self.assertEqual(ends[:2], [1, 1])
        self.assertEqual(utf16_offset("📓 note", 2), 3)
        self.assertEqual(utf16_offset("📓 note", 6), 7)

        long_prefix = "İstanbul 📓 " * 8
        markdown = "\n".join([
            "İstanbul: note",
            "📓 note",
            "İstanbul 📓: NOTE",
            "Straße: note",
            f"{long_prefix}target NOTE after unicode prefix " + ("x" * 90),
        ])
        tabs = [{
            "id": "tab-u",
            "name": "unicode.md",
            "path": "",
            "content": markdown,
            "dirty": True,
        }]
        res = stream_text_search("note", tabs, [], None, case_sensitive=False)
        self.assertEqual([m["line"] for m in res["matches"]], [1, 2, 3, 4, 5])

        m_istanbul, m_emoji, m_both, m_strasse, m_long = res["matches"]
        # Line 1: "İstanbul: note" -> UTF-16 [10, 14)
        self.assertEqual((m_istanbul["snippet"], m_istanbul["matchStart"], m_istanbul["matchEnd"]), ("İstanbul: note", 10, 14))
        self.assertEqual(m_istanbul["column"], 11)
        # Line 2: "📓 note" -> U+1F4D3 takes 2 UTF-16 code units + space = 3 -> [3, 7)
        self.assertEqual((m_emoji["snippet"], m_emoji["matchStart"], m_emoji["matchEnd"]), ("📓 note", 3, 7))
        self.assertEqual(m_emoji["column"], 4)
        # Line 3: "İstanbul 📓: NOTE" -> 9 + 2 + 2 = 13 -> [13, 17)
        self.assertEqual((m_both["snippet"], m_both["matchStart"], m_both["matchEnd"]), ("İstanbul 📓: NOTE", 13, 17))
        # Line 4: "Straße: note" -> 'ß' expands to "ss" in casefold, original UTF-16 [8, 12)
        self.assertEqual((m_strasse["snippet"], m_strasse["matchStart"], m_strasse["matchEnd"]), ("Straße: note", 8, 12))

        u16_bytes = markdown.encode("utf-16-le")
        for hit, expected_text in zip(res["matches"], ["note", "note", "NOTE", "note", "NOTE"]):
            s, e = hit["sourceStart"], hit["sourceEnd"]
            self.assertEqual(u16_bytes[2 * s : 2 * e].decode("utf-16-le"), expected_text)

        # Verify actual QML JS String.prototype.slice highlighting inside FolderSearchDialog.qml!
        qml_root = Path(__file__).resolve().parent / "qml"
        engine = QQmlApplicationEngine()
        engine.rootContext().setContextProperty("studio", self.studio)
        engine.rootContext().setContextProperty("readerUrl", QUrl("about:blank"))
        engine.rootContext().setContextProperty("channelScript", "")
        engine.rootContext().setContextProperty("brandUrl", QUrl("about:blank"))
        engine.load(QUrl.fromLocalFile(str(qml_root / "Main.qml")))
        self.assertTrue(engine.rootObjects(), "Main.qml must load for QML UTF-16 slice verification")
        try:
            window = engine.rootObjects()[0]
            dialog = window.findChild(QObject, "folderSearchDialog")
            self.assertIsNotNone(dialog)

            def qml_highlight(match_dict: dict) -> str:
                return QMetaObject.invokeMethod(
                    dialog,
                    "highlightedSnippet",
                    Qt.ConnectionType.DirectConnection,
                    Q_RETURN_ARG("QVariant"),
                    Q_ARG("QVariant", match_dict["snippet"]),
                    Q_ARG("QVariant", match_dict["matchStart"]),
                    Q_ARG("QVariant", match_dict["matchEnd"]),
                )

            self.assertIn("<b>note</b>", qml_highlight(m_istanbul))
            self.assertNotIn("<b>ote</b>", qml_highlight(m_istanbul))
            self.assertIn("<b>note</b>", qml_highlight(m_emoji))
            self.assertNotIn("<b> not</b>", qml_highlight(m_emoji))
            self.assertIn("<b>NOTE</b>", qml_highlight(m_both))
            self.assertIn("<b>note</b>", qml_highlight(m_strasse))
            self.assertIn("<b>NOTE</b>", qml_highlight(m_long))

            cs_res = stream_text_search("note", tabs, [], None, case_sensitive=True)
            self.assertEqual([m["line"] for m in cs_res["matches"]], [1, 2, 4])
            self.assertEqual((cs_res["matches"][0]["matchStart"], cs_res["matches"][0]["matchEnd"]), (10, 14))
            self.assertEqual((cs_res["matches"][1]["matchStart"], cs_res["matches"][1]["matchEnd"]), (3, 7))
            self.assertIn("<b>note</b>", qml_highlight(cs_res["matches"][1]))

            emoji_q = stream_text_search("📓", tabs, [], None, case_sensitive=False)
            self.assertIn("<b>📓</b>", qml_highlight(emoji_q["matches"][0]))
        finally:
            for obj in engine.rootObjects():
                if hasattr(obj, "close"):
                    obj.close()
                obj.deleteLater()
            engine.deleteLater()
            self.app.sendPostedEvents(None, QEvent.Type.DeferredDelete)
            del engine

    def test_portable_smd_and_renamed_bundle_search_never_decodes_embedded_images(self):
        smd_path = self.root / "heavy-images.smd"
        renamed_bundle = self.root / "disguised-bundle.txt"
        plain_json_fmd = self.root / "legacy-envelope.fmd"

        documents.write_portable(
            smd_path,
            "# Lab Report\n\n Measured PlanckConstant accurately.\n",
            {"assets/photo.png": TINY_PNG},
        )
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
        outside_note = Path(outside.name).resolve() / "external.md"
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

        no_folder_res = stream_text_search(
            "RecentNeedle",
            [{"id": "t1", "name": "Untitled.md", "path": "", "content": "RecentNeedle in unsaved draft", "dirty": True}],
            [{"path": str(outside_note), "name": "external.md", "pinned": True}],
            None,
        )
        self.assertEqual({m["name"] for m in no_folder_res["matches"]}, {"Untitled.md", "external.md"})

    def test_cancellation_stops_in_flight_scan_immediately(self):
        import builtins

        for i in range(60):
            (self.root / f"note_{i:03d}.md").write_bytes(f"# Heading\r\nLine {i} SearchTarget\r\n".encode("utf-8"))
        cancel_event = threading.Event()
        batches = []
        active_handles = 0
        handle_lock = threading.Lock()
        real_open = builtins.open
        root_prefix = os.path.normcase(str(self.root))

        def tracked_open(file, *args, **kwargs):
            nonlocal active_handles
            path_str = os.fspath(file) if isinstance(file, (str, os.PathLike)) else ""
            tracked = os.path.normcase(str(path_str)).startswith(root_prefix)
            handle = real_open(file, *args, **kwargs)
            if not tracked:
                return handle
            with handle_lock:
                active_handles += 1
            time.sleep(0.002)

            class _HandleGuard:
                def __getattr__(self, name):
                    return getattr(handle, name)

                def __enter__(self):
                    handle.__enter__()
                    return self

                def __exit__(self, *exc):
                    nonlocal active_handles
                    try:
                        return handle.__exit__(*exc)
                    finally:
                        with handle_lock:
                            active_handles -= 1

            return _HandleGuard()

        def on_batch(batch, _scanned, _trunc, _done):
            batches.append(len(batch))
            cancel_event.set()

        with patch.object(builtins, "open", side_effect=tracked_open):
            res = stream_text_search(
                "SearchTarget",
                [],
                [],
                self.root,
                cancel_event=cancel_event,
                on_batch=on_batch,
            )
            with handle_lock:
                leaked_on_cancel = active_handles

            trunc = stream_text_search(
                "SearchTarget",
                [],
                [],
                self.root,
                max_matches=7,
            )
            with handle_lock:
                leaked_on_truncate = active_handles

        self.assertTrue(res["cancelled"])
        self.assertLess(res["scannedFiles"], 60)
        self.assertEqual(leaked_on_cancel, 0, "No worker file handles may remain open when cancelled search returns")
        self.assertTrue(trunc["truncated"])
        self.assertEqual(len(trunc["matches"]), 7)
        self.assertTrue(all(m["line"] == 2 for m in trunc["matches"]))
        self.assertEqual(leaked_on_truncate, 0, "No worker file handles may remain open when truncated search returns")

    def test_stateless_order_preserving_benchmark_and_disk_freshness(self):
        for d in range(12):
            sub = self.root / f"topic_{d:02d}"
            sub.mkdir(parents=True)
            for f in range(20):
                idx = d * 20 + f
                has_match = (idx % 9 == 3)
                note_path = sub / (f"note_{f:02d}.smd" if idx == 30 else f"note_{f:02d}.md")
                body_lines = [
                    f"# Note {idx:03d} — İstanbul & Straße",
                    "```mermaid",
                    "graph TD",
                    f"  A[Node{idx}] --> B[EigenSpectrum]",
                    "```",
                    (
                        f"Observation {idx}: EigenSpectrum first prose hit and EigenSpectrum second hit."
                        if has_match
                        else f"Observation {idx}: Background Hamiltonian prose without target token."
                    ),
                ]
                markdown = "\n".join(body_lines) + "\n"
                if note_path.suffix == ".smd":
                    documents.write_portable(note_path, markdown, {"assets/pixel.png": TINY_PNG})
                else:
                    note_path.write_text(markdown, encoding="utf-8")

        shadowed_path = self.root / "topic_00" / "note_03.md"
        tabs = [{
            "id": "tab-dirty-override",
            "name": "note_03.md",
            "path": str(shadowed_path),
            "content": "# Live Override\n\nEigenSpectrum live unsaved hit.\n",
            "dirty": True,
        }]

        # Build exact sequential reference order.
        seq_entries = []
        for sub_dir in sorted((p for p in self.root.iterdir() if p.is_dir()), key=lambda p: p.name.lower()):
            for note_file in sorted(sub_dir.iterdir(), key=lambda p: p.name.lower()):
                if note_file.resolve() == shadowed_path.resolve():
                    continue
                seq_entries.append(note_file)

        expected_tuples = [("topic_00/note_03.md", 3, 1, "EigenSpectrum live unsaved hit.", True)]
        for note_file in seq_entries:
            single = stream_text_search("eigenspectrum", [], [{"path": str(note_file), "name": note_file.name}], None)
            rel = note_file.relative_to(self.root).as_posix()
            for m in single["matches"]:
                expected_tuples.append((rel, m["line"], m["column"], m["snippet"], False))

        # Invert completion timing so early files sleep longer than later files in worker threads.
        orig_read = documents.read_searchable_markdown
        read_counts: dict[str, int] = {}
        count_lock = threading.Lock()

        def jittered_read(path_arg, *args, **kwargs):
            raw = os.fspath(path_arg)
            with count_lock:
                read_counts[raw] = read_counts.get(raw, 0) + 1
            if "topic_00" in raw or "topic_01" in raw or "topic_02" in raw:
                time.sleep(0.0015)
            return orig_read(path_arg, *args, **kwargs)

        streamed_batches: list[dict] = []
        with patch.object(documents, "read_searchable_markdown", side_effect=jittered_read):
            res = stream_text_search(
                "eigenspectrum",
                tabs,
                [],
                self.root,
                active_id="tab-dirty-override",
                case_sensitive=False,
                on_batch=lambda batch, _s, _t, _d: streamed_batches.extend(batch),
            )

        actual_tuples = [
            (m["relative"], m["line"], m["column"], m["snippet"], m["dirty"])
            for m in res["matches"]
        ]
        streamed_tuples = [
            (m["relative"], m["line"], m["column"], m["snippet"], m["dirty"])
            for m in streamed_batches
        ]
        self.assertEqual(actual_tuples, expected_tuples)
        self.assertEqual(streamed_tuples, expected_tuples)
        self.assertEqual(res["scannedFiles"], 240)
        self.assertFalse(res["truncated"])
        self.assertEqual(read_counts.get(str(shadowed_path), 0), 0, "Open tab path must not be re-read from disk")

        # Truncation must slice at the exact deterministic prefix boundary.
        trunc_res = stream_text_search(
            "eigenspectrum",
            tabs,
            [],
            self.root,
            active_id="tab-dirty-override",
            case_sensitive=False,
            max_matches=17,
        )
        self.assertTrue(trunc_res["truncated"])
        self.assertEqual(
            [(m["relative"], m["line"], m["column"], m["snippet"], m["dirty"]) for m in trunc_res["matches"]],
            expected_tuples[:17],
        )

        # Duplicate recent entries (including unnormalized relative segments) must be deduplicated.
        dup_target = (self.root / "topic_01" / "note_01.md").resolve()
        norm_dup_target = os.path.normcase(str(dup_target))
        unnormalized_dup = str(self.root / "topic_01" / ".." / "topic_01" / "note_01.md")
        recent_reads: list[str] = []

        def counting_read(path_arg, *args, **kwargs):
            norm = os.path.normcase(str(Path(path_arg).resolve()))
            if norm == norm_dup_target:
                recent_reads.append(norm)
            return orig_read(path_arg, *args, **kwargs)

        with patch.object(documents, "read_searchable_markdown", side_effect=counting_read):
            rec_res = stream_text_search(
                "Observation",
                [],
                [
                    {"path": str(dup_target), "name": "note_01.md", "pinned": True},
                    {"path": unnormalized_dup, "name": "note_01.md", "pinned": False},
                ],
                None,
            )
        self.assertEqual(len(recent_reads), 1)
        self.assertEqual(rec_res["scannedFiles"], 1)

        # Stateless freshness: mutating a file on disk is reflected on the very next search with zero cache invalidation.
        fresh_note = self.root / "topic_05" / "note_00.md"
        fresh_note.write_text("# Updated on Disk\n\nFreshlyWrittenDiskPhrase appears immediately.\n", encoding="utf-8")
        fresh_res = stream_text_search("FreshlyWrittenDiskPhrase", tabs, [], self.root, active_id="tab-dirty-override")
        self.assertEqual([(m["relative"], m["line"]) for m in fresh_res["matches"]], [("topic_05/note_00.md", 3)])

    def test_shared_batch_stream_preserves_precedence_and_order_across_open_tabs_and_disk_notes(self):
        sub = self.root / "sub"
        sub.mkdir()
        zeta_disk = self.root / "zeta.md"
        shadow_disk = self.root / "shadow.md"
        beta_disk = sub / "beta.md"
        alpha_disk = self.root / "alpha.md"
        gamma_disk = self.root / "gamma.md"

        # Disk copies of zeta.md, shadow.md, and sub/beta.md must be shadowed by open tabs.
        zeta_disk.write_text("SharedHit stale-zeta\n", encoding="utf-8")
        shadow_disk.write_text("SharedHit stale-shadow\n", encoding="utf-8")
        beta_disk.write_text("SharedHit stale-beta\n", encoding="utf-8")
        alpha_disk.write_text(
            "\n".join(f"alpha-{i} SharedHit" for i in range(1, 6)) + "\n",
            encoding="utf-8",
        )
        gamma_disk.write_text(
            "\n".join(f"gamma-{i} SharedHit" for i in range(1, 5)) + "\n",
            encoding="utf-8",
        )

        # Open tabs are intentionally passed with the active tab NOT first in tabs_snapshot.
        tabs = [
            {
                "id": "tab-unsaved",
                "name": "Untitled.md",
                "path": "",
                "content": "\n".join(f"unsaved-{i} SharedHit" for i in range(1, 9)),
                "dirty": True,
            },
            {
                "id": "tab-shadow",
                "name": "shadow.md",
                "path": str(shadow_disk),
                "content": "# Clean open tab with zero query matches\n",
                "dirty": False,
            },
            {
                "id": "tab-active",
                "name": "zeta.md",
                "path": str(zeta_disk),
                "content": "\n".join(f"active-{i} SharedHit" for i in range(1, 8)),
                "dirty": True,
            },
            {
                "id": "tab-beta",
                "name": "beta.md",
                "path": str(beta_disk),
                "content": "\n".join(f"beta-{i} SharedHit" for i in range(1, 3)),
                "dirty": False,
            },
        ]

        batches: list[tuple[list[tuple[str, int, bool]], int, bool, bool]] = []

        def on_batch(batch: list[dict], scanned: int, truncated: bool, done: bool) -> None:
            batches.append(([(m["relative"], m["line"], m["isOpen"]) for m in batch], scanned, truncated, done))

        res = stream_text_search(
            "sharedhit",
            tabs,
            [],
            self.root,
            active_id="tab-active",
            case_sensitive=False,
            on_batch=on_batch,
        )

        # Precedence order:
        # 1. Active open tab (zeta.md: 7 matches)
        # 2. Remaining open tabs in snapshot order (Untitled.md: 8, shadow.md: 0, sub/beta.md: 2) -> 17 in-memory matches (< BATCH_SIZE=20)
        # 3. Non-shadowed folder notes (alpha.md: 5 -> reaches 22 >= BATCH_SIZE, flushing first shared batch; gamma.md: 4 -> final done=True batch)
        expected_order = (
            [("zeta.md", i, True) for i in range(1, 8)]
            + [("Untitled.md", i, True) for i in range(1, 9)]
            + [("sub/beta.md", i, True) for i in range(1, 3)]
            + [("alpha.md", i, False) for i in range(1, 6)]
            + [("gamma.md", i, False) for i in range(1, 5)]
        )
        self.assertEqual([(m["relative"], m["line"], m["isOpen"]) for m in res["matches"]], expected_order)
        self.assertEqual(res["scannedFiles"], 6)
        self.assertFalse(res["truncated"])
        self.assertFalse(res["cancelled"])

        self.assertEqual(len(batches), 2)
        self.assertGreaterEqual(len(batches[0][0]), BATCH_SIZE)
        self.assertEqual(batches[0], (expected_order[:22], 5, False, False))
        self.assertEqual(batches[1], (expected_order[22:], 6, False, True))

        # Without an open folder, recent_snapshot falls back in pinned-first order while open tabs still take precedence.
        outside_dir = tempfile.TemporaryDirectory(prefix="supermd-recents-")
        self.addCleanup(outside_dir.cleanup)
        out_root = Path(outside_dir.name).resolve()
        unpinned_note = out_root / "unpinned.md"
        pinned_note = out_root / "pinned.md"
        unpinned_note.write_text("RecentOrderHit unpinned\n", encoding="utf-8")
        pinned_note.write_text("RecentOrderHit pinned\n", encoding="utf-8")
        zeta_disk.write_text("RecentOrderHit stale-zeta\n", encoding="utf-8")

        recent_res = stream_text_search(
            "RecentOrderHit",
            [
                {"id": "t-other", "name": "other.md", "path": "", "content": "RecentOrderHit other\n", "dirty": True},
                {"id": "t-active", "name": "zeta.md", "path": str(zeta_disk), "content": "RecentOrderHit live-zeta\n", "dirty": True},
            ],
            [
                {"path": str(unpinned_note), "name": "unpinned.md", "pinned": False},
                {"path": str(zeta_disk), "name": "zeta.md", "pinned": True},
                {"path": str(pinned_note), "name": "pinned.md", "pinned": True},
                {"path": str(pinned_note), "name": "pinned.md", "pinned": False},
            ],
            None,
            active_id="t-active",
        )
        self.assertEqual(
            [(m["name"], m["isOpen"], m["snippet"]) for m in recent_res["matches"]],
            [
                ("zeta.md", True, "RecentOrderHit live-zeta"),
                ("other.md", True, "RecentOrderHit other"),
                ("pinned.md", False, "RecentOrderHit pinned"),
                ("unpinned.md", False, "RecentOrderHit unpinned"),
            ],
        )

    def test_unicode_offsets_preserved_across_in_memory_and_on_disk_batches(self):
        def utf16_slice(text: str, u16_start: int, u16_end: int) -> str:
            raw = text.encode("utf-16-le", errors="surrogatepass")
            return raw[u16_start * 2 : u16_end * 2].decode("utf-16-le", errors="surrogatepass")

        long_prefix = "İstanbul 🧪 " * 9
        shared_lines = [
            "İstanbul: Signal",
            "📓🧪 SIGNAL after astral pair",
            "Straße: signal",
            f"{long_prefix}windowed SIGNAL match " + ("z" * 90),
        ]
        disk_md = self.root / "unicode-disk.md"
        disk_smd = self.root / "unicode-portable.smd"
        disk_md.write_text("\n".join(shared_lines * 4) + "\n", encoding="utf-8")
        documents.write_portable(disk_smd, "\n".join(shared_lines * 3) + "\n", {})

        tabs = [{
            "id": "tab-u-batch",
            "name": "unicode-live.md",
            "path": "",
            "content": "\n".join(shared_lines * 3),
            "dirty": True,
        }]
        streamed: list[dict] = []
        done_flags: list[bool] = []

        def on_batch(batch: list[dict], _scanned: int, _trunc: bool, done: bool) -> None:
            streamed.extend(batch)
            done_flags.append(done)

        res = stream_text_search("signal", tabs, [], self.root, case_sensitive=False, on_batch=on_batch)
        self.assertEqual(streamed, res["matches"])
        self.assertGreaterEqual(len(done_flags), 2)
        self.assertTrue(done_flags[-1])
        self.assertEqual(len(res["matches"]), 40)

        for match in res["matches"]:
            highlighted = utf16_slice(match["snippet"], match["matchStart"], match["matchEnd"])
            self.assertEqual(highlighted.casefold(), "signal")

        in_mem_first4 = [(m["column"], m["matchStart"], m["matchEnd"]) for m in res["matches"][:4]]
        disk_md_first4 = [(m["column"], m["matchStart"], m["matchEnd"]) for m in res["matches"][12:16]]
        disk_smd_first4 = [(m["column"], m["matchStart"], m["matchEnd"]) for m in res["matches"][28:32]]
        self.assertEqual(in_mem_first4, disk_md_first4)
        self.assertEqual(in_mem_first4, disk_smd_first4)

    def test_query_limits_and_early_cap_preserved_across_in_memory_and_on_disk_notes(self):
        disk_a = self.root / "01_first.md"
        disk_b = self.root / "02_second.md"
        disk_a.write_text("\n".join(f"disk-a-{i} CapToken" for i in range(65)) + "\n", encoding="utf-8")
        disk_b.write_text("\n".join(f"disk-b-{i} CapToken" for i in range(20)) + "\n", encoding="utf-8")

        tabs = [{
            "id": "tab-cap",
            "name": "live.md",
            "path": "",
            "content": "\n".join(f"live-{i} CapToken" for i in range(65)),
            "dirty": True,
        }]

        # Per-note limit (MAX_MATCHES_PER_NOTE=50) applies equally to open tabs and disk notes without global truncation.
        per_note_res = stream_text_search("CapToken", tabs, [], self.root, max_matches=500)
        self.assertFalse(per_note_res["truncated"])
        self.assertEqual(
            [sum(1 for m in per_note_res["matches"] if m["name"] == name) for name in ("live.md", "01_first.md", "02_second.md")],
            [MAX_MATCHES_PER_NOTE, MAX_MATCHES_PER_NOTE, 20],
        )

        # Global cap reached inside open tabs short-circuits before walking the folder on disk.
        tab_cap_batches: list[tuple[int, bool, bool]] = []
        with patch("workspace_search.walk_folder_notes", side_effect=AssertionError("Must not walk disk when open tabs hit max_matches")) as spy_walk:
            tab_cap_res = stream_text_search(
                "CapToken",
                tabs,
                [],
                self.root,
                max_matches=25,
                on_batch=lambda b, _s, trunc, done: tab_cap_batches.append((len(b), trunc, done)),
            )
            spy_walk.assert_not_called()
        self.assertTrue(tab_cap_res["truncated"])
        self.assertEqual(len(tab_cap_res["matches"]), 25)
        self.assertEqual(tab_cap_res["scannedFiles"], 1)
        self.assertEqual(tab_cap_batches, [(25, False, False), (0, True, True)])

        # Global cap spanning an open tab (12 matches) into the first disk note (capped at 13) skips later disk notes.
        cross_batches: list[tuple[int, int, bool, bool]] = []
        cross_res = stream_text_search(
            "CapToken",
            [{"id": "t-12", "name": "twelve.md", "path": "", "content": "\n".join(f"t-{i} CapToken" for i in range(12)), "dirty": True}],
            [],
            self.root,
            max_matches=25,
            on_batch=lambda b, s, trunc, done: cross_batches.append((len(b), s, trunc, done)),
        )
        self.assertTrue(cross_res["truncated"])
        self.assertEqual(cross_res["scannedFiles"], 2)
        self.assertEqual([m["name"] for m in cross_res["matches"]], ["twelve.md"] * 12 + ["01_first.md"] * 13)
        self.assertEqual([m["line"] for m in cross_res["matches"][12:]], list(range(1, 14)))
        self.assertEqual(cross_batches, [(25, 2, False, False), (0, 2, True, True)])

    def test_open_search_match_supersedes_pending_sync_for_search_flush(self):
        target = self.root / "target.md"
        target.write_text("# Target\n\nNeedle match here.\n", encoding="utf-8")
        self.studio.ready = True
        self.studio.openFolderSearch()
        self.assertIsNotNone(self.studio.flush_operation)
        self.assertEqual(self.studio.flush_operation["action"], "sync_for_search")
        self.studio.openFolderSearchMatch("", str(target), "Needle", True)
        self.assertEqual(self.studio.flush_operation["action"], "open_search_match")

    def test_repeated_matches_crlf_unicode_offsets_and_studio_handoff(self):
        crlf_markdown = (
            "# İstanbul 📓\r\n"
            "First 📓 EchoToken and second EchoToken on same line.\r\n"
            "Straße precedes third ECHOTOKEN here.\r\n"
        )
        tabs = [{
            "id": "tab-repeat",
            "name": "repeat.md",
            "path": "",
            "content": crlf_markdown,
            "dirty": True,
        }]
        res = stream_text_search("echotoken", tabs, [], None, case_sensitive=False)
        self.assertEqual(len(res["matches"]), 3)
        u16 = crlf_markdown.encode("utf-16-le")
        sliced = [u16[2 * m["sourceStart"] : 2 * m["sourceEnd"]].decode("utf-16-le") for m in res["matches"]]
        self.assertEqual(sliced, ["EchoToken", "EchoToken", "ECHOTOKEN"])
        self.assertEqual([m["matchText"] for m in res["matches"]], ["EchoToken", "EchoToken", "ECHOTOKEN"])
        self.assertLess(res["matches"][0]["sourceStart"], res["matches"][1]["sourceStart"])
        self.assertLess(res["matches"][1]["sourceStart"], res["matches"][2]["sourceStart"])

        # Handoff to closed disk note preserves exact 2nd occurrence sourceStart/sourceEnd/matchText in seededFind.
        disk_note = self.root / "handoff.md"
        disk_content = "# İstanbul 📓\nFirst Needle.\nSecond Needle after 📓.\n"
        disk_note.write_text(disk_content, encoding="utf-8")
        disk_hits = stream_text_search("Needle", [], [], self.root, case_sensitive=True)["matches"]
        self.assertEqual(len(disk_hits), 2)
        second = disk_hits[1]
        disk_u16 = disk_content.encode("utf-16-le")
        self.assertEqual(disk_u16[2 * second["sourceStart"] : 2 * second["sourceEnd"]].decode("utf-16-le"), "Needle")
        self.assertEqual(second["matchText"], "Needle")

        active_tab = self.studio.tabs[0]
        self.studio.ready = True
        self.studio.openFolderSearchMatch("", str(disk_note), "Needle", True, second["sourceStart"], second["sourceEnd"], second["matchText"])
        op = self.studio.flush_operation
        self.assertIsNotNone(op)
        self.studio.post("f-open", "document_flushed", json.dumps({"operation": op, "id": active_tab["id"], "content": active_tab["content"]}))
        self.assertTrue(_wait_until(lambda: self.studio._current()["name"] == "handoff.md"))
        # Also verify active-tab re-seed passes sourceStart/sourceEnd/matchText into window.supermdFind.
        calls: list[str] = []
        self.studio.readerCall.connect(calls.append)
        opened_tab = self.studio._current()
        self.studio.openFolderSearchMatch(opened_tab["id"], opened_tab["path"], "Needle", True, second["sourceStart"], second["sourceEnd"], second["matchText"])
        op_active = self.studio.flush_operation
        self.assertIsNotNone(op_active)
        self.studio.post("f-active", "document_flushed", json.dumps({"operation": op_active, "id": opened_tab["id"], "content": opened_tab["content"]}))
        self.assertTrue(
            any(
                f'"sourceStart": {second["sourceStart"]}' in call
                and f'"sourceEnd": {second["sourceEnd"]}' in call
                and '"matchText": "Needle"' in call
                for call in calls
            ),
            calls,
        )

    def test_sync_for_search_preserves_matches_when_unchanged_and_rescans_when_flushed_edits_arrive(self):
        note = self.root / "synced.md"
        note.write_text("# Synced\n\nDiskMatch line.\n", encoding="utf-8")
        self.studio.openFolder(str(self.root))
        self.assertTrue(_wait_until(lambda: len(self.studio.files) > 0))
        tab = self.studio.tabs[0]
        tab["content"] = "# Draft\n\nBaselineToken here.\n"
        tab["saved"] = tab["content"]
        self.studio.ready = True

        self.studio.openFolderSearch()
        op = self.studio.flush_operation
        self.assertIsNotNone(op)
        self.assertEqual(op["action"], "sync_for_search")

        self.studio.updateFolderSearch("DiskMatch", False, False)
        self.assertTrue(_wait_until(lambda: len(self.studio.folderSearchState["matches"]) == 1))
        self.assertTrue(self.studio.folderSearchState["scanning"])

        self.studio.post(
            "flush-1",
            "document_flushed",
            json.dumps({"operation": op, "id": tab["id"], "content": tab["content"]}),
        )
        self.assertTrue(_wait_until(lambda: not self.studio.folderSearchState["scanning"]))
        self.assertEqual(len(self.studio.folderSearchState["matches"]), 1)
        self.assertEqual(self.studio.folderSearchState["matches"][0]["name"], "synced.md")

        self.studio.closeFolderSearch()
        self.studio.openFolderSearch()
        op2 = self.studio.flush_operation
        self.assertIsNotNone(op2)
        self.studio.updateFolderSearch("NewlyFlushedToken", False, False)
        self.assertTrue(_wait_until(lambda: not self.studio._folder_search_scanning))
        self.assertEqual(self.studio.folderSearchState["matches"], [])
        self.assertTrue(self.studio.folderSearchState["scanning"])

        self.studio.post(
            "flush-2",
            "document_flushed",
            json.dumps({"operation": op2, "id": tab["id"], "content": "# Draft\n\nNewlyFlushedToken in live buffer.\n"}),
        )
        self.assertTrue(
            _wait_until(
                lambda: not self.studio.folderSearchState["scanning"]
                and len(self.studio.folderSearchState["matches"]) == 1
            )
        )
        self.assertEqual(self.studio.folderSearchState["matches"][0]["line"], 3)
        self.assertTrue(self.studio.folderSearchState["matches"][0]["dirty"])

    @contextlib.contextmanager
    def _real_folder_search_dialog(self):
        self.session.settings.update(theme="dark", accent="blue", motion=False, welcomed=True)
        qml_dir = Path(__file__).resolve().parent / "qml"
        engine = QQmlEngine()
        engine.rootContext().setContextProperty("studio", self.studio)
        component = QQmlComponent(engine)
        component.setData(FOLDER_SEARCH_HOST_QML, QUrl.fromLocalFile(str(qml_dir / "folder-search-dialog-host.qml")))
        self.assertFalse(component.isError(), str(component.errors()))
        window = component.create()
        self.assertIsNotNone(window, str(component.errors()))
        self.studio.host_window = window
        try:
            window.show()
            window.requestActivate()
            QTest.qWaitForWindowExposed(window, 300)
            QTest.qWait(15)
            dialog = window.findChild(QObject, "folderSearchDialog")
            search_input = window.findChild(QObject, "folderSearchInput")
            debounce_timer = window.findChild(QObject, "folderSearchDebounce")
            self.assertTrue(dialog is not None and search_input is not None and debounce_timer is not None)
            yield window, dialog, search_input, debounce_timer
        finally:
            self.studio.host_window = None
            window.close(); window.deleteLater()
            self.app.sendPostedEvents(None, QEvent.Type.DeferredDelete)
            engine.deleteLater()
            self.app.sendPostedEvents(None, QEvent.Type.DeferredDelete)

    @staticmethod
    def _find_named_item(root_obj: QObject, object_name: str) -> QObject | None:
        def walk(item):
            if item is None: return None
            if item.objectName() == object_name: return item
            if (found := item.findChild(QObject, object_name)) is not None: return found
            for ch in (item.childItems() if callable(getattr(item, "childItems", None)) else ()):
                if (hit := walk(ch)) is not None: return hit
            return None
        return root_obj.findChild(QObject, object_name) or walk(root_obj.contentItem())

    @staticmethod
    def _type_keys(window, text: str, delay_ms: int = 0) -> None:
        for ch in text:
            mods = Qt.KeyboardModifier.ShiftModifier if ch.isupper() else Qt.KeyboardModifier.NoModifier
            key = int(Qt.Key(ord(ch.upper()))) if ch.isascii() and ch.isalpha() else 0
            QGuiApplication.sendEvent(window, QKeyEvent(QEvent.Type.KeyPress, key, mods, ch))
            QGuiApplication.sendEvent(window, QKeyEvent(QEvent.Type.KeyRelease, key, mods, ch))
            if delay_ms > 0:
                QTest.qWait(delay_ms)

    def test_real_dialog_debounces_typing_bursts_and_cancels_previous_generation_immediately(self):
        (self.root / "alpha.md").write_text("# Alpha\n\nRocketToken in alpha.\n", encoding="utf-8")
        (self.root / "beta.md").write_text("# Beta\n\nRocketToken in beta.\nSlowQueryx settled hit.\n", encoding="utf-8")
        self.studio.openFolder(str(self.root))
        self.assertTrue(_wait_until(lambda: len(self.studio.files) == 2))

        with self._real_folder_search_dialog() as (window, dialog, search_input, debounce_timer):
            self.assertEqual(dialog.property("debounceInterval"), 120)
            self.studio.openFolderSearch()
            self.assertTrue(_wait_until(lambda: bool(dialog.property("opened"))))
            window.requestActivate()
            search_input.forceActiveFocus()
            self.assertTrue(_wait_until(lambda: bool(search_input.property("activeFocus"))))

            # 1. Rapid keystroke burst coalesces into a single workspace scan for the settled query.
            queries_run: list[str] = []
            with patch("studio.stream_text_search", side_effect=lambda q, *a, **kw: (queries_run.append(q), stream_text_search(q, *a, **kw))[1]):
                self._type_keys(window, "RocketToken", delay_ms=2)
                self.app.processEvents()
                self.assertEqual(search_input.property("text"), "RocketToken")
                self.assertTrue(bool(debounce_timer.property("running")) and bool(dialog.property("queryPending")))
                self.assertTrue(self.studio.folderSearchState["pending"] and self.studio.folderSearchState["scanning"])
                self.assertEqual(queries_run, [], "Workspace scan must not start before debounce settles")
                self.assertTrue(_wait_until(lambda: not self.studio.folderSearchState["scanning"] and len(self.studio.folderSearchState["matches"]) == 2))
                self.assertEqual(queries_run, ["RocketToken"])
                self.assertFalse(bool(dialog.property("queryPending")))
                self.assertEqual({m["name"] for m in self.studio.folderSearchState["matches"]}, {"alpha.md", "beta.md"})

            # 2. Editing while a previous generation is scanning cancels & invalidates immediately.
            scan_started, cancel_observed = threading.Event(), threading.Event()
            captured: dict[str, object] = {}
            stale_hit = [{"name": "stale.md", "relative": "stale.md", "path": "", "tabId": "", "line": 1, "column": 1,
                          "snippet": "SlowQuery", "matchStart": 0, "matchEnd": 9, "sourceStart": 0, "sourceEnd": 9,
                          "matchText": "SlowQuery", "dirty": False, "isOpen": False}]

            def blocking_then_real_search(query, *args, **kwargs):
                cancel_event, on_batch = kwargs.get("cancel_event"), kwargs.get("on_batch")
                if query != "SlowQuery":
                    return stream_text_search(query, *args, **kwargs)
                captured["cancel_event"] = cancel_event
                scan_started.set()
                if cancel_event is not None and cancel_event.wait(timeout=3.0):
                    cancel_observed.set()
                if callable(on_batch):
                    on_batch(stale_hit, 1, False, True)
                return {"matches": [], "scannedFiles": 0, "truncated": False}

            with patch("studio.stream_text_search", side_effect=blocking_then_real_search):
                QTest.keyClick(window, Qt.Key.Key_A, Qt.KeyboardModifier.ControlModifier)
                self._type_keys(window, "SlowQuery")
                self.assertTrue(_wait_until(scan_started.is_set))
                prev_generation, prev_cancel = self.studio._folder_search_generation, captured["cancel_event"]
                self.assertFalse(prev_cancel.is_set())

                dialog.setProperty("debounceInterval", 220)
                QTest.keyClick(window, Qt.Key.Key_X)
                self.app.processEvents()
                self.assertEqual(search_input.property("text"), "SlowQueryx")
                self.assertTrue(prev_cancel.is_set(), "Previous cancel_event must be set immediately on edit")
                self.assertGreater(self.studio._folder_search_generation, prev_generation)
                self.assertTrue(bool(debounce_timer.property("running")) and self.studio.folderSearchState["pending"])
                self.assertEqual(
                    (self.studio.folderSearchState["matches"], self.studio.folderSearchState["scannedFiles"], self.studio.folderSearchState["truncated"]),
                    ([], 0, False),
                )
                self.assertTrue(cancel_observed.wait(timeout=1.0))

                # Late batch signal from the superseded generation on the GUI thread is dropped.
                self.studio.workspaceSearchBatch.emit(prev_generation, stale_hit, 1, False, True)
                self.app.processEvents()
                self.assertTrue(all(m["name"] != "stale.md" for m in self.studio.folderSearchState["matches"]))
                self.assertTrue(_wait_until(lambda: not self.studio.folderSearchState["scanning"] and len(self.studio.folderSearchState["matches"]) == 1))
                self.assertEqual(self.studio.folderSearchState["matches"][0]["name"], "beta.md")
                self.assertEqual(self.studio.folderSearchState["matches"][0]["matchText"], "SlowQueryx")

    def test_real_dialog_blocks_stale_enter_while_pending_and_covers_clear_escape_and_activation(self):
        first_note, second_note = self.root / "first.md", self.root / "second.md"
        first_note.write_text("# First\n\nAlphaHit in first note.\n```mermaid\ngraph TD\n  A[DiagramHit]\n```\n", encoding="utf-8")
        second_note.write_text("# Second\n\nOmegaHit line three.\nFiller.\nOmegaHit line five.\n", encoding="utf-8")
        self.studio.openFolder(str(self.root))
        self.assertTrue(_wait_until(lambda: len(self.studio.files) == 2))
        active_tab = self.studio.tabs[0]
        self.studio.ready = True

        with self._real_folder_search_dialog() as (window, dialog, search_input, debounce_timer):
            status_label = window.findChild(QObject, "folderSearchStatus")
            self.assertIsNotNone(status_label)

            def select_all_and_clear(key=Qt.Key.Key_Backspace):
                QTest.keyClick(window, Qt.Key.Key_A, Qt.KeyboardModifier.ControlModifier)
                QTest.keyClick(window, key)
                self.app.processEvents()

            def open_and_ack_sync():
                self.studio.openFolderSearch()
                self.assertTrue(_wait_until(lambda: bool(dialog.property("opened"))))
                if self.studio.flush_operation and self.studio.flush_operation.get("action") == "sync_for_search":
                    self.studio.post("sync-ack", "document_flushed", json.dumps({
                        "operation": self.studio.flush_operation, "id": active_tab["id"], "content": active_tab["content"],
                    }))
                window.requestActivate()
                search_input.forceActiveFocus()
                self.assertTrue(_wait_until(lambda: bool(search_input.property("activeFocus"))))

            open_and_ack_sync()

            # Settle initial query "AlphaHit" -> matches first.md.
            self._type_keys(window, "AlphaHit")
            self.assertTrue(_wait_until(lambda: not self.studio.folderSearchState["scanning"] and len(self.studio.folderSearchState["matches"]) == 1))
            self.assertEqual(self.studio.folderSearchState["matches"][0]["name"], "first.md")
            self.assertIsNone(self.studio.flush_operation)

            # Type "OmegaHit" and immediately press Down, Return, and Keypad Enter while pending (plus direct slot guard).
            dialog.setProperty("debounceInterval", 300)
            QTest.keyClick(window, Qt.Key.Key_A, Qt.KeyboardModifier.ControlModifier)
            self._type_keys(window, "OmegaHit")
            self.app.processEvents()
            self.assertTrue(bool(dialog.property("queryPending")) and bool(debounce_timer.property("running")))
            QTest.keyClick(window, Qt.Key.Key_Down)
            self.assertEqual(dialog.property("selectedIndex"), 0)
            QTest.keyClick(window, Qt.Key.Key_Return)
            QTest.keyClick(window, Qt.Key.Key_Enter, Qt.KeyboardModifier.KeypadModifier)
            self.studio.openFolderSearchMatch("", str(first_note), "AlphaHit", False)
            self.app.processEvents()
            self.assertTrue(bool(dialog.property("visible")) and self.studio.folderSearchState["open"])
            self.assertIsNone(self.studio.flush_operation, "Enter while pending must not open stale match")

            # Clear input while pending: stops debounce immediately, launches no scan, resets state cleanly.
            dialog.setProperty("debounceInterval", 160)
            with patch("studio.stream_text_search", wraps=stream_text_search) as spy_clear_pending:
                self._type_keys(window, "z")
                self.app.processEvents()
                self.assertTrue(bool(debounce_timer.property("running")))
                select_all_and_clear(Qt.Key.Key_Backspace)
                self.assertEqual(search_input.property("text"), "")
                self.assertFalse(bool(debounce_timer.property("running")) or bool(dialog.property("queryPending")))
                self.assertFalse(self.studio.folderSearchState["pending"] or self.studio.folderSearchState["scanning"])
                self.assertEqual(self.studio.folderSearchState["matches"], [])
                self.assertIn("Streams live matches", str(status_label.property("text")))
                QTest.qWait(180)
                spy_clear_pending.assert_not_called()

            # Settle "OmegaHit", clear settled results, and verify Enter on empty input is a no-op.
            dialog.setProperty("debounceInterval", 120)
            self._type_keys(window, "OmegaHit")
            self.assertTrue(_wait_until(lambda: not self.studio.folderSearchState["scanning"] and len(self.studio.folderSearchState["matches"]) == 2))
            select_all_and_clear(Qt.Key.Key_Delete)
            self.assertEqual(self.studio.folderSearchState["matches"], [])
            self.assertFalse(self.studio.folderSearchState["scanning"])
            QTest.keyClick(window, Qt.Key.Key_Return)
            self.app.processEvents()
            self.assertTrue(bool(dialog.property("visible")) and self.studio.flush_operation is None)

            # Toggling Diagrams / Match case while pending stops debounce, keeps input focus, and runs once immediately.
            case_toggle = window.findChild(QObject, "folderSearchCaseToggle")
            diag_toggle = window.findChild(QObject, "folderSearchDiagramsToggle")
            self.assertTrue(case_toggle is not None and diag_toggle is not None)
            self.assertTrue(_wait_until(lambda: diag_toggle.width() > 0 and case_toggle.width() > 0))
            diag_pt = diag_toggle.mapToScene(QPointF(diag_toggle.width() / 2.0, diag_toggle.height() / 2.0)).toPoint()
            toggle_pt = case_toggle.mapToScene(QPointF(case_toggle.width() / 2.0, case_toggle.height() / 2.0)).toPoint()
            dialog.setProperty("debounceInterval", 220)
            toggle_queries: list[tuple[str, bool, bool]] = []
            with patch("studio.stream_text_search", side_effect=lambda q, *a, **kw: (toggle_queries.append((q, bool(kw.get("case_sensitive")), not bool(kw.get("exclude_diagrams", True)))), stream_text_search(q, *a, **kw))[1]):
                self._type_keys(window, "diagramhit")
                self.app.processEvents()
                self.assertTrue(bool(debounce_timer.property("running")))
                QTest.mouseClick(window, Qt.MouseButton.LeftButton, Qt.KeyboardModifier.NoModifier, diag_pt)
                self.assertTrue(bool(search_input.property("activeFocus")))
                self.assertFalse(bool(debounce_timer.property("running")))
                self.assertTrue(_wait_until(lambda: not self.studio.folderSearchState["scanning"] and len(self.studio.folderSearchState["matches"]) == 1))
                QTest.qWait(240)
                self.assertEqual(toggle_queries, [("diagramhit", False, True)])
                QTest.mouseClick(window, Qt.MouseButton.LeftButton, Qt.KeyboardModifier.NoModifier, toggle_pt)
                self.assertTrue(_wait_until(lambda: bool(case_toggle.property("checked")) and not self.studio.folderSearchState["scanning"]))
                self.assertEqual(self.studio.folderSearchState["matches"], [])
                QTest.mouseClick(window, Qt.MouseButton.LeftButton, Qt.KeyboardModifier.NoModifier, toggle_pt)
                self.assertTrue(_wait_until(lambda: not bool(case_toggle.property("checked")) and not self.studio.folderSearchState["scanning"]))
                QTest.mouseClick(window, Qt.MouseButton.LeftButton, Qt.KeyboardModifier.NoModifier, diag_pt)
                self.assertTrue(_wait_until(lambda: not bool(diag_toggle.property("checked")) and not self.studio.folderSearchState["scanning"]))

            select_all_and_clear(Qt.Key.Key_Delete)

            # Escape while pending cancels debounce cleanly and never runs after closing.
            dialog.setProperty("debounceInterval", 160)
            with patch("studio.stream_text_search", wraps=stream_text_search) as spy_escape_pending:
                self._type_keys(window, "AlphaHit")
                self.app.processEvents()
                self.assertTrue(bool(debounce_timer.property("running")))
                QTest.keyClick(window, Qt.Key.Key_Escape)
                self.assertTrue(_wait_until(lambda: not bool(dialog.property("visible"))))
                self.assertFalse(self.studio.folderSearchState["open"] or bool(debounce_timer.property("running")))
                QTest.qWait(180)
                spy_escape_pending.assert_not_called()

            # Reopen, search "OmegaHit", step Down to 2nd occurrence, and press Return to activate current result.
            dialog.setProperty("debounceInterval", 120)
            open_and_ack_sync()
            self._type_keys(window, "OmegaHit")
            self.assertTrue(_wait_until(lambda: not self.studio.folderSearchState["scanning"] and len(self.studio.folderSearchState["matches"]) == 2))
            settled_matches = list(self.studio.folderSearchState["matches"])
            self.assertEqual([m["line"] for m in settled_matches], [3, 5])
            QTest.keyClick(window, Qt.Key.Key_Down)
            self.assertEqual(dialog.property("selectedIndex"), 1)
            QTest.keyClick(window, Qt.Key.Key_Return)
            self.assertTrue(_wait_until(lambda: not bool(dialog.property("visible"))))
            self.assertEqual(self.studio.flush_operation["action"], "open_search_match")
            activated_payload = json.loads(self.studio.flush_operation["target"])
            self.assertEqual(
                (activated_payload["path"], activated_payload["query"], activated_payload["sourceStart"], activated_payload["sourceEnd"], activated_payload["matchText"]),
                (str(second_note), "OmegaHit", settled_matches[1]["sourceStart"], settled_matches[1]["sourceEnd"], "OmegaHit"),
            )

            # Complete flush, reopen, and verify clicking a current result row also activates it cleanly.
            self.studio.post("open-ack", "document_flushed", json.dumps({
                "operation": self.studio.flush_operation, "id": active_tab["id"], "content": active_tab["content"],
            }))
            self.assertTrue(_wait_until(lambda: self.studio._current()["name"] == "second.md"))
            open_and_ack_sync()
            self.assertTrue(_wait_until(lambda: not self.studio.folderSearchState["scanning"] and len(self.studio.folderSearchState["matches"]) == 2))
            self.assertTrue(
                _wait_until(
                    lambda: (r := self._find_named_item(window, "folderSearchRow_0")) is not None
                    and r.width() > 0
                    and r.height() > 0
                )
            )
            row0 = self._find_named_item(window, "folderSearchRow_0")
            self.assertIsNotNone(row0)
            center = row0.mapToScene(QPointF(row0.width() / 2.0, row0.height() / 2.0)).toPoint()
            QTest.mouseClick(window, Qt.MouseButton.LeftButton, Qt.KeyboardModifier.NoModifier, center)
            self.assertTrue(_wait_until(lambda: not bool(dialog.property("visible"))))
            self.assertEqual(self.studio.flush_operation["action"], "open_search_match")
            self.assertEqual(json.loads(self.studio.flush_operation["target"])["sourceStart"], settled_matches[0]["sourceStart"])

    def test_qml_and_webengine_folder_search_escape_and_seeded_reader_search(self):
        if "--webengine-probe" in sys.argv:
            raise unittest.SkipTest("probe subprocess only")
        root = Path(__file__).resolve().parent
        if not (root.parent / "dist" / "qt-reader.html").is_file():
            raise unittest.SkipTest("dist/qt-reader.html not built")
        env = dict(
            os.environ,
            QT_QPA_PLATFORM="offscreen",
            QT_QUICK_BACKEND="software",
            QTWEBENGINE_DISABLE_SANDBOX="1",
            QTWEBENGINE_CHROMIUM_FLAGS="--disable-gpu --disable-dev-shm-usage",
        )
        completed = subprocess.run(
            [sys.executable, str(Path(__file__).resolve()), "--webengine-probe"],
            cwd=str(root),
            env=env,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="strict",
            timeout=90,
        )
        self.assertEqual(
            completed.returncode,
            0,
            f"WebEngine E2E probe failed:\nSTDOUT:\n{completed.stdout}\nSTDERR:\n{completed.stderr}",
        )
        lines = [ln for ln in completed.stdout.splitlines() if ln.startswith("{")]
        self.assertTrue(lines and json.loads(lines[-1]).get("ok"), completed.stdout)


if __name__ == "__main__":
    if "--webengine-probe" in sys.argv:
        raise SystemExit(_webengine_e2e_probe())
    unittest.main()
