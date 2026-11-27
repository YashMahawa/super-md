"""Focused unit tests for WorkspaceDropFilter, external drop routing, and streaming media writers."""
from __future__ import annotations

import ast, base64, json, os, subprocess, sys, tempfile, unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

ROOT = Path(__file__).resolve().parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from PySide6.QtCore import QEvent, QMimeData, QObject, QPoint, QPointF, Qt, QUrl
from PySide6.QtGui import QDragEnterEvent, QDragMoveEvent, QDropEvent, QGuiApplication

import folder_ops
import studio
from studio import Studio, WorkspaceDropFilter, _matches_media_signature
import studio_paths_media

PNG_HEADER = b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR"


class _ReaderStub:
    def __init__(self, *, visible: bool = True, width: float = 200.0, height: float = 120.0, offset: tuple[float, float] = (0.0, 0.0)):
        self._visible, self._width, self._height, self._offset = visible, width, height, offset

    def isVisible(self) -> bool: return self._visible
    def width(self) -> float: return self._width
    def height(self) -> float: return self._height
    def mapFromScene(self, pos: QPointF) -> QPointF: return QPointF(pos.x() - self._offset[0], pos.y() - self._offset[1])


def _make_drop_proxy(**overrides):
    emits, folder_signals, opened_folders, prefs = [], [], [], []
    host = SimpleNamespace(raised=0, activated=0)
    host.raise_ = lambda: setattr(host, "raised", host.raised + 1)
    host.requestActivate = lambda: setattr(host, "activated", host.activated + 1)
    proxy = SimpleNamespace(
        retired=False, pending_close="", flush_operation="", settings={"welcomed": True}, ready=True,
        reader_overlay=False, image_overlay=False, message="", tabs=[], recent=[], _activation_generation=0,
        host_window=host, emits=emits, folder_signals=folder_signals, opened_folders=opened_folders, prefs=prefs,
        _emit=lambda load=True: emits.append(load), _preferences=lambda: prefs.append(True),
        openFolder=lambda p: opened_folders.append(p),
        workspaceFolderDropped=SimpleNamespace(emit=lambda: folder_signals.append(True)),
    )
    for key, value in overrides.items():
        setattr(proxy, key, value)
    return proxy


class StudioPathsMediaUnitTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.app = QGuiApplication.instance() or QGuiApplication(["studio_paths_media unit tests"])

    def test_ast_guard_no_studio_module_sys_modules_or_importerror_handlers(self):
        source_path = ROOT / "studio_paths_media.py"
        tree = ast.parse(source_path.read_text(encoding="utf-8"), filename=str(source_path))
        for node in ast.walk(tree):
            if isinstance(node, ast.FunctionDef):
                self.assertNotEqual(node.name, "_studio_module")
            elif isinstance(node, ast.Name):
                self.assertNotEqual(node.id, "_studio_module")
            elif isinstance(node, ast.Attribute) and isinstance(node.value, ast.Name):
                self.assertNotEqual((node.value.id, node.attr), ("sys", "modules"))
            elif isinstance(node, ast.ExceptHandler):
                caught = set()
                if isinstance(node.type, ast.Name):
                    caught.add(node.type.id)
                elif isinstance(node.type, ast.Tuple):
                    caught.update(elt.id for elt in node.type.elts if isinstance(elt, ast.Name))
                self.assertFalse(caught & {"ImportError", "ModuleNotFoundError"})

        repo_root = ROOT.parent
        # Verify standalone package-mode import without desktop/ on sys.path, plus package+flat studio integration.
        probe = subprocess.run(
            [
                sys.executable, "-c",
                "import sys, desktop.studio_paths_media as m; "
                "assert m.__package__ == 'desktop' and hasattr(m, 'WorkspaceDropFilter'); "
                f"sys.path.insert(0, {str(ROOT)!r}); "
                "import desktop.studio as s; assert s.WorkspaceDropFilter is m.WorkspaceDropFilter",
            ],
            cwd=str(repo_root),
            env={k: v for k, v in os.environ.items() if k != "PYTHONPATH"} | {"QT_QPA_PLATFORM": "offscreen"},
            capture_output=True, text=True, check=False,
        )
        self.assertEqual(probe.returncode, 0, probe.stderr)

    def test_workspace_drop_filter_modal_blocking_reader_passthrough_and_attach_replacement(self):
        proxy = _make_drop_proxy()
        proxy.dropBlocked = False
        dropped_calls: list[tuple[list[QUrl], bool]] = []
        proxy.shouldInterceptExternalDrop = lambda urls, over: Studio.shouldInterceptExternalDrop(proxy, urls, over)
        proxy.handleExternalDrop = lambda urls, over: dropped_calls.append((list(urls), over))

        win_a, win_b = QObject(), QObject()
        reader_1, reader_2 = _ReaderStub(offset=(10.0, 10.0)), _ReaderStub(offset=(50.0, 50.0))

        Studio.attachWindowDropFilter(proxy, None, reader_1)
        self.assertFalse(hasattr(proxy, "_workspace_drop_filter"))
        Studio.attachWindowDropFilter(proxy, win_a, reader_1)
        first_filter = proxy._workspace_drop_filter
        self.assertIsInstance(first_filter, WorkspaceDropFilter)
        self.assertIs(first_filter.reader, reader_1)
        Studio.attachWindowDropFilter(proxy, win_a, reader_2)
        self.assertIs(proxy._workspace_drop_filter, first_filter)
        self.assertIs(first_filter.reader, reader_2)

        Studio.attachWindowDropFilter(proxy, win_b, reader_1)
        second_filter = proxy._workspace_drop_filter
        self.assertIsNot(second_filter, first_filter)
        self.assertIs(second_filter.window, win_b)

        custom_calls: list[tuple[object, object, object]] = []
        with patch.object(studio, "WorkspaceDropFilter", side_effect=lambda s, w, r: custom_calls.append((s, w, r)) or first_filter):
            Studio.attachWindowDropFilter(proxy, win_a, reader_1)
        self.assertEqual(custom_calls, [(proxy, win_a, reader_1)])

        forwarded_events: list[QEvent.Type] = []
        fake_app = SimpleNamespace(sendEvent=lambda _target, ev: forwarded_events.append(ev.type()) or True)
        flt = WorkspaceDropFilter(proxy, win_b, reader_1, app_instance_fn=lambda: fake_app)

        with tempfile.TemporaryDirectory() as tmp:
            img, note = Path(tmp) / "photo.png", Path(tmp) / "doc.md"
            img.write_bytes(PNG_HEADER)
            note.write_text("# Doc\n", encoding="utf-8")

            tab_mime = QMimeData()
            tab_mime.setUrls([QUrl.fromLocalFile(str(note))])
            tab_mime.setData("application/x-supermd-tab", b"{}")
            tab_enter = QDragEnterEvent(QPoint(20, 20), Qt.DropAction.MoveAction, tab_mime, Qt.MouseButton.LeftButton, Qt.KeyboardModifier.NoModifier)
            self.assertFalse(flt.eventFilter(win_b, tab_enter))

            img_mime = QMimeData()
            img_mime.setUrls([QUrl.fromLocalFile(str(img))])
            win_b.setProperty("modalDialogCount", 1)
            modal_move = QDragMoveEvent(QPoint(20, 20), Qt.DropAction.CopyAction, img_mime, Qt.MouseButton.LeftButton, Qt.KeyboardModifier.NoModifier)
            self.assertTrue(flt.eventFilter(win_b, modal_move))
            self.assertEqual(modal_move.dropAction(), Qt.DropAction.IgnoreAction)
            self.assertEqual(forwarded_events, [QEvent.Type.DragLeave])
            win_b.setProperty("modalDialogCount", 0)
            flt._intercepting_drag = False
            forwarded_events.clear()

            # Drag image onto chrome (x=5) -> intercepted; move over active reader (30, 30) -> forwards DragEnter and passes through.
            chrome_enter = QDragEnterEvent(QPoint(5, 5), Qt.DropAction.CopyAction, img_mime, Qt.MouseButton.LeftButton, Qt.KeyboardModifier.NoModifier)
            self.assertTrue(flt.eventFilter(win_b, chrome_enter))
            self.assertTrue(flt._intercepting_drag)
            reader_move = QDragMoveEvent(QPoint(30, 30), Qt.DropAction.CopyAction, img_mime, Qt.MouseButton.LeftButton, Qt.KeyboardModifier.NoModifier)
            self.assertFalse(flt.eventFilter(win_b, reader_move))
            self.assertEqual(forwarded_events, [QEvent.Type.DragEnter])
            self.assertFalse(flt._intercepting_drag)

            # Drag note over reader -> intercepted, sends DragLeave on un-intercepted DragMove, and dispatches handleExternalDrop on Drop.
            forwarded_events.clear()
            note_mime = QMimeData()
            note_mime.setUrls([QUrl.fromLocalFile(str(note))])
            note_move = QDragMoveEvent(QPoint(30, 30), Qt.DropAction.CopyAction, note_mime, Qt.MouseButton.LeftButton, Qt.KeyboardModifier.NoModifier)
            self.assertTrue(flt.eventFilter(win_b, note_move))
            self.assertEqual(forwarded_events, [QEvent.Type.DragLeave])
            note_drop = QDropEvent(QPointF(30, 30), Qt.DropAction.CopyAction, note_mime, Qt.MouseButton.LeftButton, Qt.KeyboardModifier.NoModifier)
            self.assertTrue(flt.eventFilter(win_b, note_drop))
            self.assertEqual(len(dropped_calls), 1)
            self.assertTrue(dropped_calls[0][1])

    def test_drop_routing_monkeypatch_collaborators_batch_order_and_recent_dedup(self):
        self.assertFalse(Studio.dropBlocked.fget(_make_drop_proxy()))
        self.assertTrue(Studio.dropBlocked.fget(_make_drop_proxy(pending_close="window")))
        self.assertTrue(Studio.dropBlocked.fget(_make_drop_proxy(flush_operation="quit")))
        self.assertTrue(Studio.dropBlocked.fget(_make_drop_proxy(retired=True)))

        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            dir_a, dir_b, img, bad = base / "dir-a", base / "dir-b", base / "pic.png", base / "archive.bin"
            dir_a.mkdir()
            dir_b.mkdir()
            img.write_bytes(PNG_HEADER)
            bad.write_bytes(b"bin")
            notes = [base / "first.md", base / "second.md", base / "third.md"]
            for note in notes:
                note.write_text("# Note\n", encoding="utf-8")

            proxy = _make_drop_proxy()
            with patch.object(studio, "_extract_local_drop_paths", return_value=[img]) as mock_extract, patch.object(
                studio, "_classify_drop_paths", return_value=([], [], [img], [])
            ) as mock_classify:
                self.assertFalse(Studio.shouldInterceptExternalDrop(proxy, ["custom://img"], True))
                self.assertTrue(Studio.shouldInterceptExternalDrop(proxy, ["custom://img"], False))
                Studio.openDroppedUrls(proxy, ["custom://img"])
                self.assertEqual((mock_extract.call_count, mock_classify.call_count), (3, 3))
                self.assertEqual(proxy.message, "Drop images inside an open note to insert them.")

            Studio.handleExternalDrop(proxy, [dir_a, dir_b, img], False)
            self.assertEqual(proxy.opened_folders[-1], str(dir_b.resolve()))
            self.assertEqual((proxy.host_window.raised, proxy.host_window.activated), (1, 1))
            self.assertEqual(
                proxy.message,
                "Opened folder dir-b (1 other folder skipped); drop images inside an open note separately to insert them.",
            )

            pending = {}

            def fake_open_note(path_str, *, explicit, activation_generation, completion_callback, batch_insert, should_activate_fn):
                self.assertTrue(explicit)
                pending[Path(path_str).name] = (Path(path_str), completion_callback, batch_insert, should_activate_fn)

            batch_proxy = _make_drop_proxy(
                tabs=[{"id": "pinned", "path": ""}],
                recent=[folder_ops.canonical_path_str(notes[0]), str(base / "older.md")],
                _open_note=fake_open_note,
            )
            Studio.handleExternalDrop(batch_proxy, [notes[0], notes[1], notes[2], bad], True)
            self.assertEqual(set(pending), {"first.md", "second.md", "third.md"})

            activations: list[tuple[str, bool]] = []
            for idx_name, tab_id in (("third.md", "t3"), ("first.md", "t1")):
                p, done_cb, insert_cb, activate_cb = pending[idx_name]
                tab = {"id": tab_id, "path": str(p)}
                insert_cb(tab)
                activations.append((idx_name, activate_cb(tab)))
                done_cb(tab, None)
            pending["second.md"][1](None, "permission denied")

            self.assertEqual([t["id"] for t in batch_proxy.tabs], ["pinned", "t1", "t3"])
            self.assertEqual(activations, [("third.md", True), ("first.md", False)])
            self.assertEqual(
                batch_proxy.recent,
                [folder_ops.canonical_path_str(notes[2]), folder_ops.canonical_path_str(notes[0]), str(base / "older.md")],
            )
            self.assertEqual(batch_proxy.message, "Could not open second.md: permission denied Skipped 1 unsupported item.")

    def test_streaming_media_envelope_chunk_validation_signature_patch_and_failure_cleanup(self):
        self.assertTrue(_matches_media_signature("image/webp", b"RIFF\x00\x00\x00\x00WEBP"))
        self.assertTrue(_matches_media_signature("image/avif", b"\x00\x00\x00\x1cftypavif"))
        self.assertFalse(_matches_media_signature("image/jpeg", PNG_HEADER))

        large_png = PNG_HEADER + (b"\xab" * 420_000)
        encoded_large = base64.b64encode(large_png).decode("ascii")
        raw_fast = json.dumps({"mimeType": "image/png", "filename": "Chart Export.png", "body": encoded_large})
        self.assertGreater(len(raw_fast), 524_288)
        parsed, source_str, start, end = Studio._parse_media_envelope(raw_fast)
        self.assertIs(source_str, raw_fast)
        self.assertEqual(source_str[start:end], encoded_large)

        with tempfile.TemporaryDirectory() as tmp:
            out_dir = Path(tmp)
            first = Studio._validate_and_write_media(parsed, out_dir, source_str=source_str, body_start=start, body_end=end)
            second = Studio._validate_and_write_media(parsed, out_dir, source_str=source_str, body_start=start, body_end=end)
            self.assertEqual((first["filename"], second["filename"]), ("Chart Export.png", "Chart Export (2).png"))
            self.assertEqual(Path(first["path"]).read_bytes(), large_png)

            with patch.object(studio, "_matches_media_signature", return_value=False) as mock_sig:
                with self.assertRaisesRegex(ValueError, "Media bytes do not match"):
                    Studio._validate_and_write_media(parsed, out_dir, source_str=source_str, body_start=start, body_end=end)
                mock_sig.assert_called_once()

            for filename, body in (
                ("bad-pad-1.mmd", ("A" * 262_140 + "====") + ("B" * 16)),
                ("bad-pad-2.mmd", ("A" * 262_144) + ("B" * 12 + "====" + "C" * 8)),
            ):
                with self.assertRaisesRegex(ValueError, "not valid base64"):
                    Studio._validate_and_write_media({"mimeType": "text/plain", "filename": filename, "body": body}, out_dir)
                self.assertFalse((out_dir / filename).exists())

            with patch("os.fsync", side_effect=OSError("disk full")):
                with self.assertRaisesRegex(OSError, "disk full"):
                    Studio._validate_and_write_media(
                        {"mimeType": "image/svg+xml", "filename": "cleanup.svg",
                         "body": base64.b64encode(b"<svg xmlns='http://www.w3.org/2000/svg'/>").decode("ascii")},
                        out_dir,
                    )
            self.assertFalse((out_dir / "cleanup.svg").exists())


if __name__ == "__main__":
    unittest.main()
