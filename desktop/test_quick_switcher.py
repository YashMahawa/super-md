"""Unit, QML, and headless WebEngine E2E tests for the Desktop filename quick switcher."""
from __future__ import annotations

import base64
import json
import os
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest import mock

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
os.environ.setdefault("QT_QUICK_BACKEND", "software")
os.environ.setdefault("QTWEBENGINE_DISABLE_SANDBOX", "1")
os.environ.setdefault("QTWEBENGINE_CHROMIUM_FLAGS", "--disable-gpu --disable-dev-shm-usage")

from PySide6.QtCore import QEvent, QMetaObject, QObject, Q_ARG, Q_RETURN_ARG, Qt, QUrl
from PySide6.QtGui import QGuiApplication
from PySide6.QtQml import QQmlApplicationEngine
from PySide6.QtQuickControls2 import QQuickStyle
from PySide6.QtTest import QTest

import documents
import quick_switcher
from shortcuts import default_shortcuts, native_label, normalize_shortcuts
from workspace_search import walk_folder_notes

TINY_PNG = "data:image/png;base64," + base64.b64encode(
    bytes.fromhex(
        "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489"
        "0000000d49444154789c6360606060000000050001a5f645400000000049454e44ae426082"
    )
).decode("ascii")


def _find_visual_item(root_item, object_name: str):
    if root_item is None:
        return None
    stack = [root_item]
    while stack:
        current = stack.pop()
        if current.objectName() == object_name:
            return current
        child_items = getattr(current, "childItems", None)
        if callable(child_items):
            stack.extend(child_items())
        for qchild in current.children():
            if qchild not in stack:
                stack.append(qchild)
    return None


def _wait_until(predicate, timeout: float = 8.0, interval: float = 0.02) -> bool:
    app = QGuiApplication.instance()
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if app is not None:
            app.processEvents()
        if predicate():
            return True
        time.sleep(interval)
    if app is not None:
        app.processEvents()
    return bool(predicate())


def _run_webengine_quick_switcher_probe() -> None:
    os.environ["QT_QPA_PLATFORM"] = "offscreen"
    os.environ["QT_QUICK_BACKEND"] = "software"
    os.environ.setdefault("QTWEBENGINE_DISABLE_SANDBOX", "1")
    os.environ.setdefault("QTWEBENGINE_CHROMIUM_FLAGS", "--disable-gpu --disable-dev-shm-usage")

    from PySide6.QtCore import QFile, QIODevice, QMetaObject, QPoint
    from PySide6.QtGui import QKeySequence
    from PySide6.QtQuick import QQuickItem, QQuickWindow  # noqa: F401
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
    app = QApplication(["Super MD quick switcher probe"])
    bundle_handler = ReaderBundleSchemeHandler(root.parent / "dist", app)
    QWebEngineProfile.defaultProfile().installUrlSchemeHandler(READER_SCHEME.encode("ascii"), bundle_handler)

    with tempfile.TemporaryDirectory(prefix="supermd-qs-e2e-") as temp_dir:
        resolved_temp = Path(temp_dir).resolve()
        folder = resolved_temp / "workspace"
        (folder / "math").mkdir(parents=True)
        (folder / "physics").mkdir(parents=True)

        math_readme = folder / "math" / "Readme.md"
        math_readme.write_text("# Math Readme\n\nLinear algebra notes.\n", encoding="utf-8")

        physics_readme = folder / "physics" / "Readme.md"
        physics_readme.write_text("# Physics Readme\n\nElectromagnetism notes.\n", encoding="utf-8")

        portable_note = folder / "physics" / "Quantum-Lab.smd"
        documents.write_portable(
            portable_note,
            "# Quantum Lab\n\nPortable Super MD experiment bundle.\n",
            {"assets/pixel.png": TINY_PNG},
        )

        session = Session(True)
        session.settings["python"] = sys.executable
        session.settings["welcomed"] = True
        studio = QuietStudio(True, session)
        studio.openFolder(str(folder))
        assert _wait_until(lambda: len(studio.files) > 0), "Folder tree did not load"

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

        qs_dialog = window.findChild(QObject, "quickSwitcherDialog")
        assert qs_dialog is not None, "quickSwitcherDialog not found in Main.qml"

        def trigger_quick_switcher() -> QObject:
            assert _wait_until(lambda: int(window.property("modalDialogCount") or 0) == 0), (
                f"Expected modalDialogCount==0 before quick_switcher, got {window.property('modalDialogCount')}"
            )
            window.raise_()
            window.requestActivate()
            QTest.qWaitForWindowActive(window, 1000)
            app.processEvents()
            seq = QKeySequence.fromString(
                studio.shortcutSequences("quick_switcher")[0],
                QKeySequence.SequenceFormat.PortableText,
            )
            combo = seq[0]
            QTest.keyClick(window, combo.key(), combo.keyboardModifiers())
            assert _wait_until(
                lambda: bool(qs_dialog.property("opened")) and not studio.quickSwitcherState["loading"],
                timeout=8.0,
            ), f"QuickSwitcherDialog did not finish opening: state={studio.quickSwitcherState}"
            qs_input = window.findChild(QObject, "quickSwitcherInput")
            assert qs_input is not None
            assert _wait_until(lambda: bool(qs_input.property("activeFocus")), timeout=4.0), (
                "quickSwitcherInput did not receive active focus on open"
            )
            return qs_input

        assert _wait_until(lambda: studio.ready, timeout=20.0), "WebEngine reader did not become ready"
        initial_active_id = studio.active

        # 1. Focus a QML TextField (zoomPercentage), open Quick Switcher via Ctrl+P,
        #    navigate with Down/Up, dismiss with Escape -> focus recovers to zoomPercentage!
        zoom_field = window.findChild(QObject, "zoomPercentage")
        assert zoom_field is not None, "zoomPercentage not found"
        zoom_field.forceActiveFocus()
        assert _wait_until(lambda: bool(zoom_field.property("activeFocus"))), "zoomPercentage did not gain focus"

        qs_input = trigger_quick_switcher()
        assert int(window.property("modalDialogCount") or 0) == 1
        QTest.keyClick(window, Qt.Key.Key_Down)
        assert _wait_until(lambda: int(qs_dialog.property("selectedIndex")) == 1), "Down key did not advance selectedIndex"
        QTest.keyClick(window, Qt.Key.Key_Up)
        assert _wait_until(lambda: int(qs_dialog.property("selectedIndex")) == 0), "Up key did not move selectedIndex back"

        QTest.keyClick(window, Qt.Key.Key_Escape)
        assert _wait_until(
            lambda: not bool(qs_dialog.property("visible"))
            and int(window.property("modalDialogCount") or 0) == 0
            and bool(zoom_field.property("activeFocus")),
            timeout=8.0,
        ), (
            f"Focus did not recover to zoomPercentage after Escape: "
            f"visible={qs_dialog.property('visible')} modal={window.property('modalDialogCount')} "
            f"activeFocusItem={window.property('activeFocusItem')}"
        )
        assert studio.active == initial_active_id, "Dismissing Quick Switcher must not change active tab"

        # 2. Focus WebEngine documentReader, open Quick Switcher, dismiss via Escape AND via outside scrim click ->
        #    focus recovers to documentReader both times!
        reader = window.findChild(QObject, "documentReader")
        assert reader is not None, "documentReader not found"
        reader.forceActiveFocus()
        assert _wait_until(lambda: bool(reader.property("activeFocus"))), "documentReader did not gain focus"

        trigger_quick_switcher()
        QTest.keyClick(window, Qt.Key.Key_Escape)
        assert _wait_until(
            lambda: not bool(qs_dialog.property("visible"))
            and int(window.property("modalDialogCount") or 0) == 0
            and bool(reader.property("activeFocus")),
            timeout=8.0,
        ), "Focus did not recover to documentReader after Escape"

        trigger_quick_switcher()
        scrim_point = QPoint(int(window.property("width")) - 16, int(window.property("height")) // 2)
        QTest.mouseClick(window, Qt.MouseButton.LeftButton, Qt.KeyboardModifier.NoModifier, scrim_point)
        assert _wait_until(
            lambda: not bool(qs_dialog.property("visible"))
            and int(window.property("modalDialogCount") or 0) == 0
            and bool(reader.property("activeFocus")),
            timeout=8.0,
        ), "Focus did not recover to documentReader after outside click dismissal"

        # 3. Filter duplicate Readme.md entries, verify parent paths disambiguate them, then select Quantum-Lab.smd via keyboard!
        qs_input = trigger_quick_switcher()
        qs_input.setProperty("text", "Readme.md")
        assert _wait_until(
            lambda: len(studio.quickSwitcherState["items"]) == 2,
            timeout=5.0,
        ), f"Expected 2 Readme.md matches, got {studio.quickSwitcherState['items']}"
        parents = {item["parentPath"] for item in studio.quickSwitcherState["items"]}
        assert parents == {"math", "physics"}, f"Expected disambiguating parent paths {{'math', 'physics'}}, got {parents}"

        qs_input.setProperty("text", "Quantum")
        assert _wait_until(
            lambda: len(studio.quickSwitcherState["items"]) == 1
            and studio.quickSwitcherState["items"][0]["name"] == "Quantum-Lab.smd",
            timeout=5.0,
        ), f"Expected Quantum-Lab.smd match, got {studio.quickSwitcherState['items']}"

        QTest.keyClick(window, Qt.Key.Key_Return)
        assert _wait_until(
            lambda: not bool(qs_dialog.property("visible"))
            and int(window.property("modalDialogCount") or 0) == 0
            and studio._current()["name"] == "Quantum-Lab.smd"
            and bool(reader.property("activeFocus")),
            timeout=10.0,
        ), (
            f"Return in Quick Switcher did not open Quantum-Lab.smd and focus reader: "
            f"current={studio._current()['name']!r} readerFocus={reader.property('activeFocus')}"
        )

        print(json.dumps({"ok": True, "opened": studio._current()["name"], "parents": sorted(parents)}), flush=True)
        window.setProperty("closingAllowed", True)
        window.setProperty("intentionalShutdown", True)
        window.close()
        del engine
        studio.stop()
        studio.pool.shutdown(wait=False, cancel_futures=True)
        session.writes.shutdown(wait=False)
    os._exit(0)


class QuickSwitcherDesktopTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if QGuiApplication.instance() is None:
            QQuickStyle.setStyle("Material")
        cls.app = QGuiApplication.instance() or QGuiApplication(["Quick switcher desktop tests"])

    def setUp(self):
        from studio import Session
        from test_studio import QuietStudio

        self.temp = tempfile.TemporaryDirectory(prefix="supermd-quick-switcher-")
        self.root = Path(self.temp.name).resolve()
        self.session = Session(True)
        self.session.settings["python"] = sys.executable
        self.studio = QuietStudio(True, self.session)

    def tearDown(self):
        self.studio.stop()
        self.studio.pool.shutdown(wait=True)
        self.session.writes.shutdown(wait=True)
        self.temp.cleanup()

    def test_shortcut_registers_ctrl_p_portably_and_customizes(self):
        for plat in ("linux", "win32", "darwin"):
            defaults = default_shortcuts(plat)
            self.assertEqual(defaults["quick_switcher"], ["Ctrl+P"])
        self.assertEqual(
            native_label("Ctrl+P"),
            "⌘P" if sys.platform == "darwin" else "Ctrl+P",
        )
        self.assertEqual(self.studio.setShortcut("quick_switcher", "Ctrl+Shift+P"), "")
        self.assertEqual(self.studio.shortcutSequences("quick_switcher"), ["Ctrl+Shift+P"])
        validated, err = normalize_shortcuts({"quick_switcher": ["Ctrl+S"]})
        self.assertIsNone(validated)
        self.assertIn("Save note", err)

    def test_presents_md_and_smd_across_workspace_roots_while_filtering_non_notes_and_symlinks(self):
        ws_main = self.root / "courses"
        ws_extra = self.root / "inbox"
        external_dir = self.root / "external"
        (ws_main / "lectures").mkdir(parents=True)
        ws_extra.mkdir(parents=True)
        external_dir.mkdir(parents=True)

        md_note = ws_main / "lectures" / "Week-01.md"
        md_note.write_text("# Week 1\n", encoding="utf-8")
        smd_note = ws_main / "lectures" / "Week-01.smd"
        documents.write_portable(smd_note, "# Week 1 Portable\n", {})
        inbox_smd = ws_extra / "Capture.smd"
        documents.write_portable(inbox_smd, "# Capture\n", {})
        recent_md = external_dir / "Reference.md"
        recent_md.write_text("# Reference\n", encoding="utf-8")

        # Non-.md/.smd files and dotfiles must be excluded from Quick Switcher.
        (ws_main / "notes.txt").write_text("plain text", encoding="utf-8")
        (ws_main / "data.json").write_text("{}", encoding="utf-8")
        (ws_main / ".secret.md").write_text("hidden", encoding="utf-8")
        recent_txt = external_dir / "Scratch.txt"
        recent_txt.write_text("scratch", encoding="utf-8")

        outside_secret = self.root / "outside-secret.md"
        outside_secret.write_text("# Secret\n", encoding="utf-8")
        try:
            (ws_main / "linked.md").symlink_to(outside_secret)
        except OSError:
            pass

        self.studio.settings["newNoteLocation"] = str(ws_extra)
        self.studio.recent = [str(recent_md), str(recent_txt)]
        self.studio.openFolder(str(ws_main))

        self.studio.openQuickSwitcher()
        self.assertTrue(_wait_until(lambda: not self.studio.quickSwitcherState["loading"]))

        items = self.studio.quickSwitcherState["items"]
        names = [item["name"] for item in items]
        self.assertIn("Week-01.md", names)
        self.assertIn("Week-01.smd", names)
        self.assertIn("Capture.smd", names)
        self.assertIn("Reference.md", names)
        self.assertNotIn("notes.txt", names)
        self.assertNotIn("Scratch.txt", names)
        self.assertNotIn("data.json", names)
        self.assertNotIn(".secret.md", names)
        self.assertNotIn("linked.md", names)

    def test_parent_paths_disambiguate_duplicate_filenames_across_subfolders_roots_and_external_notes(self):
        # 1. Single workspace root with root-level, nested, and same-named subfolder duplicates
        ws = self.root / "vault"
        (ws / "alpha").mkdir(parents=True)
        (ws / "beta").mkdir(parents=True)
        (ws / "vault").mkdir(parents=True)
        ext = self.root / "archive" / "alpha"
        ext.mkdir(parents=True)

        for target in (
            ws / "Index.md",
            ws / "alpha" / "Index.md",
            ws / "beta" / "Index.md",
            ws / "vault" / "Index.md",
            ext / "Index.md",
        ):
            target.write_text(f"# {target}\n", encoding="utf-8")

        self.studio.recent = [str(ext / "Index.md")]
        self.studio.openFolder(str(ws))
        self.studio.openQuickSwitcher()
        self.assertTrue(_wait_until(lambda: not self.studio.quickSwitcherState["loading"]))
        self.studio.setQuickSwitcherQuery("Index.md")

        items = self.studio.quickSwitcherState["items"]
        self.assertEqual(len(items), 5)
        parent_labels = [item["parentPath"] for item in items]
        self.assertTrue(all(parent_labels), f"Every duplicate must display a non-empty parentPath: {items}")
        self.assertEqual(
            len({label.casefold() for label in parent_labels}),
            5,
            f"Expected 5 distinct parentPath labels for 5 Index.md files, got {parent_labels}",
        )

        # Querying by parent folder + filename ranks the matching subfolder duplicate first.
        self.studio.setQuickSwitcherQuery("beta Index.md")
        ranked = self.studio.quickSwitcherState["items"]
        self.assertGreaterEqual(len(ranked), 1)
        self.assertEqual(Path(ranked[0]["path"]).resolve(), (ws / "beta" / "Index.md").resolve())

        # 2. Two workspace roots whose leaf folder names collide (/team-a/docs vs /team-b/docs)
        self.studio.closeQuickSwitcher()
        root_a = self.root / "team-a" / "docs"
        root_b = self.root / "team-b" / "docs"
        root_a.mkdir(parents=True)
        root_b.mkdir(parents=True)
        documents.write_portable(root_a / "Roadmap.smd", "# Team A\n", {})
        documents.write_portable(root_b / "Roadmap.smd", "# Team B\n", {})

        self.studio.settings["newNoteLocation"] = str(root_b)
        self.studio.openFolder(str(root_a))
        self.studio.openQuickSwitcher()
        self.assertTrue(_wait_until(lambda: not self.studio.quickSwitcherState["loading"]))
        self.studio.setQuickSwitcherQuery("Roadmap.smd")

        roadmap_items = self.studio.quickSwitcherState["items"]
        self.assertEqual(len(roadmap_items), 2)
        self.assertEqual(
            {it["parentPath"] for it in roadmap_items},
            {"team-a/docs", "team-b/docs"},
        )

    def test_reuses_cached_folder_index_across_queries_and_reopens_until_invalidated(self):
        ws = self.root / "indexed"
        (ws / "empty_sub").mkdir(parents=True)
        (ws / "alpha.md").write_text("# Alpha\n", encoding="utf-8")
        documents.write_portable(ws / "beta.smd", "# Beta\n", {})

        self.studio.openFolder(str(ws))
        self.assertTrue(_wait_until(lambda: len(self.studio.files) > 0))
        with mock.patch.object(quick_switcher, "walk_folder_notes", wraps=walk_folder_notes) as spy:
            self.studio.openQuickSwitcher()
            self.assertTrue(_wait_until(lambda: not self.studio.quickSwitcherState["loading"]))
            self.assertEqual(spy.call_count, 1)

            # Typing multiple queries filters purely in memory without re-walking disk.
            for q in ("a", "al", "beta", "smd", ""):
                self.studio.setQuickSwitcherQuery(q)
            self.assertEqual(spy.call_count, 1)

            # Closing and reopening Quick Switcher with unchanged directories reuses the cached folder index.
            self.studio.closeQuickSwitcher()
            self.studio.openQuickSwitcher()
            self.assertFalse(self.studio.quickSwitcherState["loading"])
            self.assertTrue(_wait_until(lambda: not self.studio.quickSwitcherState["loading"]))
            time.sleep(0.08)
            self.app.processEvents()
            self.assertEqual(spy.call_count, 1)

            # Creating a new note via Studio invalidates the folder index so the new note appears.
            self.studio.closeQuickSwitcher()
            self.studio.createFolderNote(str(ws), "gamma", "smd")
            self.assertTrue(
                _wait_until(
                    lambda: (ws / "gamma.smd").is_file()
                    and any(t.get("name") == "gamma.smd" for t in self.studio.tabs)
                )
            )

            self.studio.openQuickSwitcher()
            self.assertTrue(_wait_until(lambda: not self.studio.quickSwitcherState["loading"]))
            self.assertGreaterEqual(spy.call_count, 2)
            names = [it["name"] for it in self.studio.quickSwitcherState["items"]]
            self.assertIn("gamma.smd", names)

            # External file creation inside a previously empty subdirectory bumps its mtime and refreshes on reopen.
            self.studio.closeQuickSwitcher()
            calls_before_ext = spy.call_count
            ext_file = ws / "empty_sub" / "external-added.md"
            ext_file.write_text("# Added externally\n", encoding="utf-8")
            future_ns = (ws / "empty_sub").stat().st_mtime_ns + 1_000_000_000
            os.utime(ws / "empty_sub", ns=(future_ns, future_ns))

            self.studio.openQuickSwitcher()
            self.assertTrue(
                _wait_until(
                    lambda: any(it["name"] == "external-added.md" for it in self.studio.quickSwitcherState["items"])
                )
            )
            self.assertGreater(spy.call_count, calls_before_ext)

    def test_note_opening_flow_deduplicates_open_tabs_and_opens_unsaved_or_disk_notes(self):
        ws = self.root / "flow"
        ws.mkdir(parents=True)
        disk_md = ws / "Saved.md"
        disk_md.write_text("# Saved Note\n", encoding="utf-8")
        disk_smd = ws / "Diagram.smd"
        documents.write_portable(disk_smd, "# Portable Diagram\n", {"assets/p.png": TINY_PNG})

        self.studio.openFolder(str(ws))
        self.studio.newNote()
        unsaved_id = self.studio.active
        self.studio._current()["content"] = "Draft text"

        # Activate disk .md note via Quick Switcher -> opens via Studio.openNote and updates recent.
        self.studio.openQuickSwitcher()
        self.assertTrue(_wait_until(lambda: not self.studio.quickSwitcherState["loading"]))
        self.studio.activateQuickSwitcherItem("", str(disk_md))
        self.assertFalse(self.studio.quickSwitcherState["open"])
        self.assertTrue(_wait_until(lambda: self.studio._current()["name"] == "Saved.md"))
        tab_count_after_open = len(self.studio.tabs)
        self.assertTrue(any(Path(p).resolve() == disk_md.resolve() for p in self.studio.recent))

        # Switch back to unsaved tab via Quick Switcher -> selects existing unsaved tab without extra tabs.
        self.studio.activateQuickSwitcherItem(unsaved_id, "")
        self.assertEqual(self.studio.active, unsaved_id)
        self.assertEqual(len(self.studio.tabs), tab_count_after_open)

        # Activate already-open Saved.md via Quick Switcher -> selects existing tab without duplicating.
        saved_tab = next(t for t in self.studio.tabs if t["name"] == "Saved.md")
        self.studio.activateQuickSwitcherItem(saved_tab["id"], saved_tab["path"])
        self.assertEqual(self.studio.active, saved_tab["id"])
        self.assertEqual(len(self.studio.tabs), tab_count_after_open)

        # Activate disk .smd note -> opens portable bundle cleanly.
        self.studio.activateQuickSwitcherItem("", str(disk_smd))
        self.assertTrue(_wait_until(lambda: self.studio._current()["name"] == "Diagram.smd"))
        self.assertTrue(self.studio._current()["portable"])

    def test_coexists_with_relative_link_activation_generation_and_manual_tab_selection(self):
        ws = self.root / "activation-coexist"
        ws.mkdir(parents=True)
        index_note = ws / "Index.md"
        keep_note = ws / "Keep.md"
        linked_note = ws / "Linked.md"
        switched_note = ws / "Switched.md"
        index_note.write_text("# Index\n\n[[Linked#Target]]\n", encoding="utf-8")
        keep_note.write_text("# Keep\n", encoding="utf-8")
        linked_note.write_text("# Linked\n\n## Target\n", encoding="utf-8")
        switched_note.write_text("# Switched\n", encoding="utf-8")

        self.studio.ready = True
        loads: list[dict] = []
        self.studio.readerLoad.connect(lambda payload: loads.append(json.loads(payload)))
        self.studio.openFolder(str(ws))
        self.studio.openNote(str(index_note))
        self.assertTrue(_wait_until(lambda: self.studio._current()["path"] == str(index_note.resolve())))
        self.studio.openNote(str(keep_note))
        self.assertTrue(_wait_until(lambda: self.studio._current()["path"] == str(keep_note.resolve())))
        keep_id = self.studio.active
        index_id = next(t["id"] for t in self.studio.tabs if t["path"] == str(index_note.resolve()))
        self.studio.selectTab(index_id)

        pending_reads: list[tuple[object, object]] = []

        def intercept_submit(action, done, *args, **kwargs):
            if getattr(done, "__name__", "") == "_noop_done":
                return
            pending_reads.append((action, done))

        # 1. In-flight relative link (#72) superseded by Quick Switcher activation of an open tab:
        #    Quick Switcher selection stays active and no stale pendingHeading is attached.
        with mock.patch.object(self.studio, "_submit", side_effect=intercept_submit):
            self.studio.post(
                "qs-vs-link",
                "open_workspace_link",
                json.dumps(
                    {
                        "documentPath": str(index_note.resolve()),
                        "target": "Linked.md",
                        "fragment": "target",
                        "wikilink": False,
                    }
                ),
            )
            self.assertEqual(len(pending_reads), 1)
            resolve_action, resolve_done = pending_reads.pop()
            resolve_done(resolve_action(), None)
            self.assertEqual(len(pending_reads), 1)

            self.studio.activateQuickSwitcherItem(keep_id, str(keep_note.resolve()))
            loads.clear()
            link_action, link_done = pending_reads.pop()
            link_done(link_action(), None)

        self.assertEqual(self.studio.active, keep_id)
        self.assertEqual(loads, [])
        linked_tab = next(t for t in self.studio.tabs if t["path"] == str(linked_note.resolve()))
        self.assertNotIn("pendingHeading", linked_tab)

        # 2. In-flight Quick Switcher disk note open superseded by manual selectTab before read completes:
        #    manual tab selection stays active and backgrounded note does not emit readerLoad.
        pending_reads.clear()
        with mock.patch.object(self.studio, "_submit", side_effect=intercept_submit):
            self.studio.activateQuickSwitcherItem("", str(switched_note))
            self.assertEqual(len(pending_reads), 1)

            self.studio.selectTab(index_id)
            loads.clear()
            qs_action, qs_done = pending_reads.pop()
            qs_done(qs_action(), None)

        self.assertEqual(self.studio.active, index_id)
        self.assertEqual(loads, [])
        self.assertTrue(any(t["path"] == str(switched_note.resolve()) for t in self.studio.tabs))

    def test_preserves_pr64_workspace_link_cache_and_open_tab_reuse_coexistence(self):
        ws = self.root / "pr64-coexist"
        (ws / "specs").mkdir(parents=True)
        first = ws / "First.md"
        first.write_text("# First\n\nSee [[Second Note#Overview]]\n", encoding="utf-8")
        second = ws / "specs" / "Second Note.md"
        second.write_text("# Second Note\n\n## Overview\n\nBody.\n", encoding="utf-8")

        self.studio.ready = True
        self.studio.settings["autosave"] = False
        replies: list[tuple[str, str, str]] = []
        self.studio.replied.connect(lambda req_id, res, err: replies.append((req_id, res, err)))

        self.studio.openFolder(str(ws))
        self.assertTrue(_wait_until(lambda: len(self.studio.files) > 0))
        self.studio.openNote(str(first))
        self.assertTrue(_wait_until(lambda: self.studio._current()["path"] == str(first.resolve())))
        first_tab_id = self.studio.active
        self.studio.post(
            "draft-1",
            "document_changed",
            json.dumps({"id": first_tab_id, "content": "# First (unsaved draft)\n"}),
        )

        # Warm both Session caches: #64 WorkspaceLinkCache (via [[Second Note]]) and Quick Switcher FolderNoteIndex.
        replies.clear()
        self.studio.post(
            "link-open-second",
            "open_workspace_link",
            json.dumps(
                {
                    "documentPath": str(first.resolve()),
                    "target": "Second Note",
                    "fragment": "Overview",
                    "wikilink": True,
                }
            ),
        )
        self.assertTrue(_wait_until(lambda: any(r[0] == "link-open-second" for r in replies)))
        self.assertTrue(json.loads(next(r[1] for r in replies if r[0] == "link-open-second"))["opened"])
        self.assertEqual(self.studio._current()["path"], str(second.resolve()))
        second_tab_id = self.studio.active
        tab_count = len(self.studio.tabs)

        self.studio.openQuickSwitcher()
        self.assertTrue(_wait_until(lambda: not self.studio.quickSwitcherState["loading"]))
        self.studio.closeQuickSwitcher()

        # Even if an open tab holds a differently-cased path string (as on macOS APFS before canonicalization),
        # Quick Switcher deduplicates it via inode identity and reuses the open tab while retaining drafts and
        # promoting recent[0] via #64's open-note flow.
        first_tab = next(t for t in self.studio.tabs if t["id"] == first_tab_id)
        alt_first = ws / "FIRST.MD"
        first_tab["path"] = str(alt_first)
        real_samefile = os.path.samefile
        try:
            with mock.patch.object(
                os.path,
                "samefile",
                side_effect=lambda a, b: True
                if {str(a), str(b)} == {str(alt_first), str(first.resolve())}
                else real_samefile(a, b),
            ):
                self.studio.openQuickSwitcher()
                self.assertTrue(_wait_until(lambda: not self.studio.quickSwitcherState["loading"]))
                self.studio.setQuickSwitcherQuery("First.md")
                first_matches = self.studio.quickSwitcherState["items"]
                self.assertEqual(len(first_matches), 1)
                self.assertEqual(first_matches[0]["tabId"], first_tab_id)
                self.assertTrue(first_matches[0]["open"])
                self.assertTrue(first_matches[0]["dirty"])
                self.assertFalse(first_matches[0]["duplicate"])

                self.studio.activateQuickSwitcherItem(first_matches[0]["tabId"], first_matches[0]["path"])
                self.assertEqual(len(self.studio.tabs), tab_count)
                self.assertEqual(self.studio.active, first_tab_id)
                self.assertEqual(self.studio._current()["content"], "# First (unsaved draft)\n")
                self.assertEqual(self.studio.recent[0], str(first.resolve()))
                self.assertTrue(all("pendingHeading" not in t for t in self.studio.tabs))
        finally:
            first_tab["path"] = str(first.resolve())

        # Creating and renaming notes invalidates both WorkspaceLinkCache and FolderNoteIndex.
        self.studio.createFolderNote(str(ws / "specs"), "Third Spec", "md")
        third = (ws / "specs" / "Third Spec.md").resolve()
        self.assertTrue(
            _wait_until(lambda: third.is_file() and any(t.get("path") == str(third) for t in self.studio.tabs))
        )

        self.studio.renameNote(second_tab_id, "Renamed Second.md")
        renamed_second = (ws / "specs" / "Renamed Second.md").resolve()
        self.assertTrue(
            _wait_until(lambda: any(t["id"] == second_tab_id and t["path"] == str(renamed_second) for t in self.studio.tabs))
        )

        # Quick Switcher immediately indexes Third Spec.md and Renamed Second.md (without stale Second Note.md).
        self.studio.openQuickSwitcher()
        self.assertTrue(_wait_until(lambda: not self.studio.quickSwitcherState["loading"]))
        qs_names = {item["name"] for item in self.studio.quickSwitcherState["items"]}
        self.assertIn("Third Spec.md", qs_names)
        self.assertIn("Renamed Second.md", qs_names)
        self.assertNotIn("Second Note.md", qs_names)
        self.studio.closeQuickSwitcher()

        # #64 WorkspaceLinkCache also resolves [[Renamed Second]] and [[Third Spec]] immediately, reusing open tabs.
        for req_id, target, expected_path in (
            ("link-renamed", "Renamed Second", str(renamed_second)),
            ("link-third", "Third Spec", str(third)),
        ):
            replies.clear()
            self.studio.post(
                req_id,
                "open_workspace_link",
                json.dumps(
                    {
                        "documentPath": str(first.resolve()),
                        "target": target,
                        "fragment": "",
                        "wikilink": True,
                    }
                ),
            )
            self.assertTrue(_wait_until(lambda: any(r[0] == req_id for r in replies)))
            self.assertTrue(json.loads(next(r[1] for r in replies if r[0] == req_id))["opened"])
            self.assertEqual(self.studio._current()["path"], expected_path)

    def test_qml_quick_switcher_dialog_renders_parent_paths_and_restores_focus_in_qml_scene(self):
        ws = self.root / "qml-scene"
        (ws / "design").mkdir(parents=True)
        (ws / "specs").mkdir(parents=True)
        (ws / "design" / "Architecture.md").write_text("# Design Arch\n", encoding="utf-8")
        documents.write_portable(ws / "specs" / "Architecture.smd", "# Spec Arch\n", {})

        self.studio.settings["welcomed"] = True
        self.studio.openFolder(str(ws))
        self.assertTrue(_wait_until(lambda: len(self.studio.files) > 0))

        qml_root = Path(__file__).resolve().parent / "qml"
        engine = QQmlApplicationEngine()
        engine.rootContext().setContextProperty("studio", self.studio)
        engine.rootContext().setContextProperty("readerUrl", QUrl("about:blank"))
        engine.rootContext().setContextProperty("channelScript", "")
        engine.rootContext().setContextProperty("brandUrl", QUrl.fromLocalFile(str(qml_root.parent.parent / "public" / "brand-mark-fixed.svg")))
        engine.load(QUrl.fromLocalFile(str(qml_root / "Main.qml")))
        self.assertTrue(engine.rootObjects(), "Main.qml failed to load")

        window = engine.rootObjects()[0]
        self.studio.host_window = window
        window.show()
        window.requestActivate()
        QTest.qWaitForWindowActive(window, 1000)
        QTest.qWait(60)
        try:
            zoom_field = window.findChild(QObject, "zoomPercentage")
            self.assertIsNotNone(zoom_field)
            zoom_field.forceActiveFocus()
            self.assertTrue(_wait_until(lambda: bool(zoom_field.property("activeFocus"))))

            # Trigger via compactNoteActions menu action exists, and open via studio.openQuickSwitcher().
            compact_action = window.findChild(QObject, "quickSwitcherAction")
            self.assertIsNotNone(compact_action)
            self.assertEqual(compact_action.property("text"), "Quick switcher")
            self.assertTrue(bool(compact_action.property("hasShortcutHint")))
            self.assertEqual(
                compact_action.findChild(QObject, "menuShortcutHint").property("text"),
                native_label("Ctrl+P"),
            )

            self.studio.openQuickSwitcher()
            dialog = window.findChild(QObject, "quickSwitcherDialog")
            self.assertIsNotNone(dialog)
            self.assertTrue(_wait_until(lambda: bool(dialog.property("opened")) and not self.studio.quickSwitcherState["loading"]))
            self.assertEqual(window.property("modalDialogCount"), 1)

            qs_input = _find_visual_item(dialog.property("contentItem"), "quickSwitcherInput")
            self.assertIsNotNone(qs_input)
            qs_input.setProperty("text", "Architecture")
            self.assertTrue(_wait_until(lambda: len(self.studio.quickSwitcherState["items"]) == 2))
            self.assertTrue(
                _wait_until(
                    lambda: _find_visual_item(dialog.property("contentItem"), "quickSwitcherRowName_0") is not None
                    and _find_visual_item(dialog.property("contentItem"), "quickSwitcherRowName_1") is not None
                )
            )

            row0_name = _find_visual_item(dialog.property("contentItem"), "quickSwitcherRowName_0")
            row0_parent = _find_visual_item(dialog.property("contentItem"), "quickSwitcherRowParent_0")
            row1_name = _find_visual_item(dialog.property("contentItem"), "quickSwitcherRowName_1")
            row1_parent = _find_visual_item(dialog.property("contentItem"), "quickSwitcherRowParent_1")
            self.assertIsNotNone(row0_name)
            self.assertIsNotNone(row0_parent)
            self.assertIsNotNone(row1_name)
            self.assertIsNotNone(row1_parent)
            self.assertEqual(
                {str(row0_name.property("text")), str(row1_name.property("text"))},
                {"Architecture.md", "Architecture.smd"},
            )
            self.assertEqual(
                {str(row0_parent.property("text")), str(row1_parent.property("text"))},
                {"design", "specs"},
            )

            # Dismiss dialog -> focus returns to zoomPercentage!
            dialog.close()
            self.assertTrue(
                _wait_until(
                    lambda: not bool(dialog.property("visible"))
                    and int(window.property("modalDialogCount") or 0) == 0
                    and bool(zoom_field.property("activeFocus"))
                )
            )
        finally:
            window.setProperty("closingAllowed", True)
            window.setProperty("intentionalShutdown", True)
            window.close()
            window.deleteLater()
            self.app.sendPostedEvents(None, QEvent.Type.DeferredDelete)
            engine.deleteLater()
            self.app.sendPostedEvents(None, QEvent.Type.DeferredDelete)

    def test_preserves_pr104_remappable_shortcuts_active_tab_reveal_and_modal_keyboard_scope(self):
        ws = self.root / "pr104-coexist"
        ws.mkdir(parents=True)
        note_paths: list[Path] = []
        for idx in range(1, 8):
            md_path = ws / f"Chapter-{idx:02d}-Foundations-And- Derivations.md".replace(" ", "")
            md_path.write_text(f"# Chapter {idx}\n", encoding="utf-8")
            note_paths.append(md_path)
        overflow_smd = ws / "Chapter-08-Portable-Appendix.smd"
        documents.write_portable(overflow_smd, "# Portable Appendix\n", {})

        self.studio.settings["welcomed"] = True
        self.studio.settings["motion"] = True
        self.studio.openFolder(str(ws))
        self.assertTrue(_wait_until(lambda: len(self.studio.files) > 0))
        for p in note_paths:
            self.studio.openNote(str(p))
        self.assertTrue(_wait_until(lambda: len(self.studio.tabs) >= len(note_paths)))

        qml_root = Path(__file__).resolve().parent / "qml"
        engine = QQmlApplicationEngine()
        engine.rootContext().setContextProperty("studio", self.studio)
        engine.rootContext().setContextProperty("readerUrl", QUrl("about:blank"))
        engine.rootContext().setContextProperty("channelScript", "")
        engine.rootContext().setContextProperty(
            "brandUrl",
            QUrl.fromLocalFile(str(qml_root.parent.parent / "public" / "brand-mark-fixed.svg")),
        )
        engine.load(QUrl.fromLocalFile(str(qml_root / "Main.qml")))
        self.assertTrue(engine.rootObjects(), "Main.qml failed to load")

        window = engine.rootObjects()[0]
        self.studio.host_window = window
        window.resize(760, 600)
        window.show()
        window.requestActivate()
        QTest.qWaitForWindowActive(window, 1000)
        QTest.qWait(80)

        def js_variant(value):
            return value.toVariant() if hasattr(value, "toVariant") else value

        def shortcut_enabled(action_id: str) -> bool:
            result = QMetaObject.invokeMethod(
                window,
                "shortcutEnabled",
                Q_RETURN_ARG("QVariant"),
                Q_ARG("QVariant", action_id),
            )
            return bool(js_variant(result))

        try:
            # 1. #104 remappable shortcuts + #151 deduplicated search menu: live update + disable hides menu hint without showing "Disabled"
            compact_qs = window.findChild(QObject, "quickSwitcherAction")
            compact_reopen = window.findChild(QObject, "reopenClosedTabAction")
            self.assertIsNotNone(compact_qs)
            self.assertIsNotNone(compact_reopen)
            self.assertIsNone(window.findChild(QObject, "compactSearchFolderAction"))
            self.assertEqual(
                compact_reopen.findChild(QObject, "menuShortcutHint").property("text"),
                native_label("Ctrl+Shift+T"),
            )
            self.assertEqual(self.studio.setShortcut("quick_switcher", "Ctrl+Alt+P"), "")
            self.assertTrue(
                _wait_until(
                    lambda: compact_qs.findChild(QObject, "menuShortcutHint").property("text")
                    == native_label("Ctrl+Alt+P")
                )
            )
            self.assertEqual(js_variant(window.property("shortcutBindings"))["quick_switcher"], ["Ctrl+Alt+P"])

            self.assertEqual(self.studio.setShortcut("quick_switcher", ""), "")
            self.assertTrue(_wait_until(lambda: not bool(compact_qs.property("hasShortcutHint"))))
            self.assertEqual(js_variant(window.property("shortcutLabels"))["quick_switcher"], "Disabled")

            self.assertEqual(self.studio.resetShortcuts(), "")
            self.assertTrue(
                _wait_until(
                    lambda: bool(compact_qs.property("hasShortcutHint"))
                    and compact_qs.findChild(QObject, "menuShortcutHint").property("text")
                    == native_label("Ctrl+P")
                )
            )

            # 2. #104 modal keyboard scope & focus behavior (with motion=True animated transitions)
            self.assertTrue(shortcut_enabled("quick_switcher"))
            self.assertTrue(shortcut_enabled("mode_live"))
            self.assertTrue(shortcut_enabled("new_folder_note"))

            # Another modal (#104/#87) suppresses quick_switcher shortcut
            window.setProperty("settingsOpen", True)
            self.assertTrue(_wait_until(lambda: int(window.property("modalDialogCount") or 0) == 1))
            self.assertFalse(shortcut_enabled("quick_switcher"))
            window.setProperty("settingsOpen", False)
            self.assertTrue(_wait_until(lambda: int(window.property("modalDialogCount") or 0) == 0))
            self.assertTrue(shortcut_enabled("quick_switcher"))

            zoom_field = window.findChild(QObject, "zoomPercentage")
            sidebar_search = window.findChild(QObject, "sidebarFolderSearchButton")
            dialog = window.findChild(QObject, "quickSwitcherDialog")
            self.assertIsNotNone(zoom_field)
            self.assertIsNotNone(sidebar_search)
            self.assertIsNotNone(dialog)
            zoom_field.forceActiveFocus()
            self.assertTrue(_wait_until(lambda: bool(zoom_field.property("activeFocus"))))

            self.studio.openQuickSwitcher()
            self.assertTrue(
                _wait_until(lambda: bool(dialog.property("opened")) and not self.studio.quickSwitcherState["loading"])
            )
            qs_input = _find_visual_item(dialog.property("contentItem"), "quickSwitcherInput")
            self.assertIsNotNone(qs_input)
            self.assertTrue(_wait_until(lambda: bool(qs_input.property("activeFocus"))))
            self.assertEqual(int(window.property("modalDialogCount") or 0), 1)
            self.assertTrue(
                bool(js_variant(QMetaObject.invokeMethod(window, "nativeTextEditorFocused", Q_RETURN_ARG("QVariant"))))
            )
            for suppressed in (
                "mode_live",
                "mode_editor",
                "mode_reader",
                "mode_split",
                "new_note",
                "new_folder_note",
                "rename_entry",
                "close_tab",
                "select_all",
                "copy",
                "paste",
                "bold",
                "dismiss",
            ):
                self.assertFalse(shortcut_enabled(suppressed), f"Expected {suppressed} disabled while modal open")

            # Tab / Shift+Tab cycle Quick Switcher selection without escaping Overlay.overlay into background chrome
            self.assertGreaterEqual(len(self.studio.quickSwitcherState["items"]), 2)
            QTest.keyClick(window, Qt.Key.Key_Tab)
            self.assertTrue(_wait_until(lambda: int(dialog.property("selectedIndex")) == 1))
            self.assertTrue(bool(qs_input.property("activeFocus")))
            QTest.keyClick(window, Qt.Key.Key_Tab, Qt.KeyboardModifier.ShiftModifier)
            self.assertTrue(_wait_until(lambda: int(dialog.property("selectedIndex")) == 0))
            self.assertTrue(bool(qs_input.property("activeFocus")))

            # Animated Escape dismissal (motion=True) restores focus to zoom_field and re-enables shortcuts
            QTest.keyClick(window, Qt.Key.Key_Escape)
            self.assertTrue(
                _wait_until(
                    lambda: not bool(dialog.property("visible"))
                    and int(window.property("modalDialogCount") or 0) == 0
                    and bool(zoom_field.property("activeFocus"))
                )
            )
            QTest.qWait(40)
            self.assertTrue(bool(zoom_field.property("activeFocus")))
            self.assertTrue(shortcut_enabled("mode_live"))

            # Animated Enter activation (motion=True) from a focused QML field focuses documentReader
            # rather than letting QQuickPopup's exit transition revert focus back to zoom_field
            reader = window.findChild(QObject, "documentReader")
            self.assertIsNotNone(reader)
            self.studio.openQuickSwitcher()
            self.assertTrue(
                _wait_until(lambda: bool(dialog.property("opened")) and not self.studio.quickSwitcherState["loading"])
            )
            QTest.keyClick(window, Qt.Key.Key_Return)
            self.assertTrue(
                _wait_until(
                    lambda: not bool(dialog.property("visible"))
                    and int(window.property("modalDialogCount") or 0) == 0
                    and bool(reader.property("activeFocus"))
                )
            )
            QTest.qWait(40)
            self.assertTrue(bool(reader.property("activeFocus")))
            self.assertFalse(bool(zoom_field.property("activeFocus")))

            # 3. #104 TabStrip active-tab reveal on Quick Switcher selection
            tab_strip = window.findChild(QObject, "tabStrip")
            self.assertIsNotNone(tab_strip)
            flickable = tab_strip.property("contentItem")
            self.assertIsNotNone(flickable)

            def active_tab_revealed() -> bool:
                QTest.qWait(10)
                viewport_w = float(tab_strip.property("availableWidth") or tab_strip.property("width") or 0)
                scroll_x = float(flickable.property("contentX") or 0)
                stack = [tab_strip]
                while stack:
                    candidate = stack.pop()
                    if candidate.objectName() == "noteTab" and bool(candidate.property("isActive")):
                        left = float(candidate.property("x") or 0)
                        width = float(candidate.property("width") or 0)
                        return width > 0 and (left + 0.5) >= scroll_x and (left + width - 0.5) <= (scroll_x + viewport_w)
                    child_items = getattr(candidate, "childItems", None)
                    if callable(child_items):
                        stack.extend(child_items())
                return False

            first_tab = next(t for t in self.studio.tabs if t["path"] == str(note_paths[0].resolve()))
            self.studio.activateQuickSwitcherItem(first_tab["id"], first_tab["path"])
            self.assertTrue(_wait_until(active_tab_revealed))
            left_scroll_x = float(flickable.property("contentX") or 0)

            # Open overflowing Chapter-08-Portable-Appendix.smd via Quick Switcher -> TabStrip scrolls right to reveal it
            self.studio.activateQuickSwitcherItem("", str(overflow_smd))
            self.assertTrue(
                _wait_until(
                    lambda: self.studio._current()["name"] == "Chapter-08-Portable-Appendix.smd"
                    and active_tab_revealed()
                    and float(flickable.property("contentX") or 0) > left_scroll_x + 40.0
                )
            )

            # Switch back to Chapter-01 via Quick Switcher -> TabStrip scrolls back left to reveal it
            self.studio.activateQuickSwitcherItem(first_tab["id"], first_tab["path"])
            self.assertTrue(
                _wait_until(
                    lambda: self.studio.active == first_tab["id"]
                    and active_tab_revealed()
                    and float(flickable.property("contentX") or 0) <= left_scroll_x + 20.0
                )
            )
        finally:
            window.setProperty("closingAllowed", True)
            window.setProperty("intentionalShutdown", True)
            window.close()
            window.deleteLater()
            self.app.sendPostedEvents(None, QEvent.Type.DeferredDelete)
            engine.deleteLater()
            self.app.sendPostedEvents(None, QEvent.Type.DeferredDelete)

    def test_end_to_end_webengine_keyboard_selection_and_focus_recovery(self):
        if "--webengine-quick-switcher-probe" in sys.argv:
            raise unittest.SkipTest("probe subprocess only")
        root = Path(__file__).resolve().parent
        dist_dir = root.parent / "dist"
        self.assertTrue((dist_dir / "qt-reader.html").is_file(), f"Missing built native reader bundle at {dist_dir}")
        env = dict(
            os.environ,
            QT_QPA_PLATFORM="offscreen",
            QT_QUICK_BACKEND="software",
            QTWEBENGINE_DISABLE_SANDBOX="1",
            QTWEBENGINE_CHROMIUM_FLAGS="--disable-gpu --disable-dev-shm-usage",
        )
        proc = subprocess.run(
            [sys.executable, str(Path(__file__).resolve()), "--webengine-quick-switcher-probe"],
            cwd=str(root),
            env=env,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="strict",
            timeout=90,
        )
        self.assertEqual(
            proc.returncode,
            0,
            f"WebEngine quick switcher probe failed (rc={proc.returncode}):\nSTDOUT:\n{proc.stdout}\nSTDERR:\n{proc.stderr}",
        )
        payload_lines = [ln for ln in proc.stdout.splitlines() if ln.strip().startswith("{")]
        self.assertTrue(payload_lines, f"Missing JSON result in probe output:\n{proc.stdout}")
        result = json.loads(payload_lines[-1])
        self.assertTrue(result["ok"])
        self.assertEqual(result["opened"], "Quantum-Lab.smd")
        self.assertEqual(result["parents"], ["math", "physics"])


if __name__ == "__main__":
    if "--webengine-quick-switcher-probe" in sys.argv:
        _run_webengine_quick_switcher_probe()
    else:
        unittest.main()
