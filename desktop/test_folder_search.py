"""Unit and headless Qt/WebEngine tests for streaming cross-note search and Unicode UTF-16 snippet offsets."""
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

from PySide6.QtCore import QCoreApplication, QMetaObject, QObject, QUrl, Qt, Q_ARG, Q_RETURN_ARG
from PySide6.QtGui import QGuiApplication
from PySide6.QtQml import QQmlApplicationEngine
from PySide6.QtQuickControls2 import QQuickStyle

import documents
from shortcuts import default_shortcuts, native_label, normalize_shortcuts
from studio import Session
from test_studio import QuietStudio
from workspace_search import (
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
        time.sleep(0.015)
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
        window.raise_()
        window.requestActivate()
        QTest.qWaitForWindowActive(window, 2000)
        QTest.qWait(120)

        search_dialog = window.findChild(QObject, "folderSearchDialog")
        assert search_dialog is not None

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
        studio.pool.shutdown(wait=False, cancel_futures=True)
        session.writes.shutdown(wait=False)
    os._exit(0)


class WorkspaceSearchDesktopTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
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
        self.studio.pool.shutdown(wait=True)
        self.session.writes.shutdown(wait=True)
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
                obj.deleteLater()
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
        self.assertLess(res["matches"][0]["sourceStart"], res["matches"][1]["sourceStart"])
        self.assertLess(res["matches"][1]["sourceStart"], res["matches"][2]["sourceStart"])

        # Handoff to closed disk note preserves exact 2nd occurrence sourceStart/sourceEnd in seededFind.
        disk_note = self.root / "handoff.md"
        disk_content = "# İstanbul 📓\nFirst Needle.\nSecond Needle after 📓.\n"
        disk_note.write_text(disk_content, encoding="utf-8")
        disk_hits = stream_text_search("Needle", [], [], self.root, case_sensitive=True)["matches"]
        self.assertEqual(len(disk_hits), 2)
        second = disk_hits[1]
        disk_u16 = disk_content.encode("utf-16-le")
        self.assertEqual(disk_u16[2 * second["sourceStart"] : 2 * second["sourceEnd"]].decode("utf-16-le"), "Needle")

        active_tab = self.studio.tabs[0]
        self.studio.ready = True
        self.studio.openFolderSearchMatch("", str(disk_note), "Needle", True, second["sourceStart"], second["sourceEnd"])
        op = self.studio.flush_operation
        self.assertIsNotNone(op)
        self.studio.post("f-open", "document_flushed", json.dumps({"operation": op, "id": active_tab["id"], "content": active_tab["content"]}))
        self.assertTrue(_wait_until(lambda: self.studio._current()["name"] == "handoff.md"))
        # Also verify active-tab re-seed passes sourceStart/sourceEnd into window.supermdFind.
        calls: list[str] = []
        self.studio.readerCall.connect(calls.append)
        opened_tab = self.studio._current()
        self.studio.openFolderSearchMatch(opened_tab["id"], opened_tab["path"], "Needle", True, second["sourceStart"], second["sourceEnd"])
        op_active = self.studio.flush_operation
        self.assertIsNotNone(op_active)
        self.studio.post("f-active", "document_flushed", json.dumps({"operation": op_active, "id": opened_tab["id"], "content": opened_tab["content"]}))
        self.assertTrue(any(f'"sourceStart": {second["sourceStart"]}' in call and f'"sourceEnd": {second["sourceEnd"]}' in call for call in calls), calls)

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
