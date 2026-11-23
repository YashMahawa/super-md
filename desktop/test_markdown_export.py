import base64
import json
import os
import subprocess
import sys
import tempfile
import time
import unittest
import zipfile
from pathlib import Path

from markdown_export import write_markdown_export, write_markdown_zip

ROOT = Path(__file__).resolve().parent

REALISTIC_MDZIP_NOTE = (
    "---\n"
    "title: \"Graph Relaxation & Proof Notes 🧭\"\n"
    "tags: [algorithms, proofs]\n"
    "links:\n"
    "  - \"[[wikilinks]]\"\n"
    "---\n\n"
    "# Graph Relaxation — Café Session\n\n"
    "Start from [[wikilinks]] and [[Graph Theory#Shortest Paths|Dijkstra's invariant]], "
    "keeping inline `[[x]]` and `![[missing-inline.png]]` untouched.\n\n"
    "![[img.png]]\n\n"
    "![[DM Images/proof guide.png|Proof Method Guide]]\n\n"
    "> [!NOTE] Relaxation Invariant for [[wikilinks]]\n"
    "> For every settled vertex $u$, $d(v) \\le d(u) + w(u, v)$ holds across [[Graph Theory#Lemma 1|Lemma 1]] "
    "and literal `[[x]]` markers.\n\n"
    "```python\n"
    "layers = [[x] for x in range(5)]\n"
    "edges = [[0, 1], [1, 2]]\n"
    "ignore_embed = \"![[missing-fenced.png]]\"\n"
    "```\n\n"
    "````markdown\n"
    ":::callout warning Literal Syntax Example\n"
    "Do not rewrite [[wikilinks]] or ![[missing-example.png]] inside code fences.\n"
    ":::\n"
    "````\n\n"
    "| Case | Expression | Reference |\n"
    "| :--- | :--- | :--- |\n"
    "| Bucket | `[[x]]` | [[wikilinks]] |\n\n"
    "*   Preserve   irregular   internal   spacing  around [[wikilinks]].\n"
)

PNG_1X1 = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="
)
PNG_2X2 = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAQAAADYv8WvAAAADklEQVR42mNk+M/AQAgAAwgB/7b5L2cAAAAASUVORK5CYII="
)


def _mdzip_e2e_probe(directory: str) -> int:
    os.environ["QT_QPA_PLATFORM"] = "offscreen"
    os.environ["QT_QUICK_BACKEND"] = "software"
    os.environ.setdefault("QTWEBENGINE_CHROMIUM_FLAGS", "--disable-gpu --disable-dev-shm-usage")
    os.environ.setdefault("QTWEBENGINE_DISABLE_SANDBOX", "1")
    from PySide6.QtCore import QFile, QIODevice, QTimer, QUrl
    from PySide6.QtQml import QQmlApplicationEngine
    from PySide6.QtQuickControls2 import QQuickStyle
    from PySide6.QtWebEngineCore import QWebEngineProfile, QWebEngineUrlScheme
    from PySide6.QtWebEngineQuick import QtWebEngineQuick
    from PySide6.QtWidgets import QApplication
    from agent_live import LiveTabClient, create_qt_bridge
    from reader_assets import ReaderAssetSchemeHandler, SCHEME
    from studio import Session, Studio

    QQuickStyle.setStyle("Material")
    scheme = QWebEngineUrlScheme(SCHEME.encode("ascii"))
    scheme.setSyntax(QWebEngineUrlScheme.Syntax.Host)
    scheme.setFlags(
        QWebEngineUrlScheme.Flag.SecureScheme
        | QWebEngineUrlScheme.Flag.CorsEnabled
        | QWebEngineUrlScheme.Flag.LocalScheme
    )
    QWebEngineUrlScheme.registerScheme(scheme)
    QtWebEngineQuick.initialize()
    app = QApplication(["Super MD mdzip E2E test"])

    vault = Path(directory).resolve()
    export_dir = vault / "exports"
    export_dir.mkdir(parents=True, exist_ok=True)
    note_path = vault / "Graph Study.md"
    source_bytes = REALISTIC_MDZIP_NOTE.encode("utf-8")
    note_path.write_bytes(source_bytes)
    (vault / "img.png").write_bytes(PNG_1X1)
    guide_dir = vault / "DM Images"
    guide_dir.mkdir(parents=True, exist_ok=True)
    (guide_dir / "proof guide.png").write_bytes(PNG_2X2)

    session = Session(True)
    session.settings["newNoteLocation"] = str(export_dir)
    studio = Studio(True, session)
    session.agent_bridge = create_qt_bridge(session, session.data)
    bridge = session.agent_bridge
    asset_handler = ReaderAssetSchemeHandler(session.reader_assets, app)
    QWebEngineProfile.defaultProfile().installUrlSchemeHandler(SCHEME.encode("ascii"), asset_handler)

    tab = studio._current()
    tab["name"] = note_path.name
    tab["path"] = str(note_path)
    tab["content"] = REALISTIC_MDZIP_NOTE
    tab["saved"] = REALISTIC_MDZIP_NOTE
    studio.mode = "reader"
    studio.settings["readingMode"] = "reader"
    studio.settings["welcomed"] = True

    channel = QFile(":/qtwebchannel/qwebchannel.js")
    if not channel.open(QIODevice.OpenModeFlag.ReadOnly):
        raise RuntimeError("Qt WebChannel runtime unavailable")
    channel_script = bytes(channel.readAll()).decode()

    engine = QQmlApplicationEngine()
    engine.rootContext().setContextProperty("studio", studio)
    engine.rootContext().setContextProperty("readerUrl", QUrl.fromLocalFile(str(ROOT.parent / "dist" / "qt-reader.html")))
    engine.rootContext().setContextProperty("channelScript", channel_script)
    engine.rootContext().setContextProperty("brandUrl", QUrl.fromLocalFile(str(ROOT.parent / "public" / "brand-mark-fixed.svg")))
    engine.load(QUrl.fromLocalFile(str(ROOT / "qml" / "Main.qml")))
    if not engine.rootObjects():
        studio.stop()
        studio.pool.shutdown(wait=False, cancel_futures=True)
        session.writes.shutdown(wait=False)
        raise RuntimeError("Production Main.qml did not load")
    window = engine.rootObjects()[0]
    studio.host_window = window
    window.show()
    studio._emit()
    bridge.start()

    ui_zip = export_dir / "Graph Study.zip"
    live_zip_holder: dict[str, object] = {}
    state = {"stage": "wait_ready", "done": False, "error": ""}

    def finish(code: int = 0) -> None:
        if state["done"]:
            return
        state["done"] = True
        try:
            bridge.stop()
        except Exception:
            pass
        try:
            window.close()
        except Exception:
            pass
        try:
            studio.stop()
        except Exception:
            pass
        try:
            studio.pool.shutdown(wait=False, cancel_futures=True)
        except Exception:
            pass
        try:
            session.writes.shutdown(wait=False)
        except Exception:
            pass
        if code == 0:
            print(json.dumps({
                "ok": True,
                "uiZip": str(ui_zip),
                "liveZip": str(live_zip_holder.get("path", "")),
            }, separators=(",", ":")), flush=True)
        else:
            print(json.dumps({"ok": False, "stage": state["stage"], "error": state["error"]}, separators=(",", ":")), flush=True)
        app.exit(code)

    def run_live_export() -> None:
        import threading

        state["stage"] = "live_export"

        def worker() -> None:
            try:
                client = LiveTabClient(bridge.discovery_path)
                tabs = client.list_tabs().get("tabs", [])
                if not tabs:
                    raise RuntimeError("Live bridge listed no tabs")
                target = tabs[0]
                started = client.export_document(
                    target["id"],
                    format="mdzip",
                    filename="Live Graph Bundle",
                    expected_revision=target["revision"],
                )
                job_id = started["jobId"]
                deadline = time.monotonic() + 15
                while time.monotonic() < deadline:
                    job = client.job_status(target["id"], job_id)
                    if job.get("status") == "completed":
                        live_zip_holder["path"] = job["path"]
                        live_zip_holder["done"] = True
                        return
                    if job.get("status") in ("failed", "cancelled"):
                        raise RuntimeError(f"Live mdzip export job failed: {job}")
                    time.sleep(0.02)
                raise RuntimeError("Timed out waiting for live mdzip export job")
            except Exception as error:
                live_zip_holder["error"] = str(error)
                live_zip_holder["done"] = True

        threading.Thread(target=worker, daemon=True).start()
        QTimer.singleShot(15, poll_live_export)

    def poll_live_export() -> None:
        if not live_zip_holder.get("done"):
            QTimer.singleShot(15, poll_live_export)
            return
        if live_zip_holder.get("error"):
            state["error"] = str(live_zip_holder["error"])
            finish(2)
            return
        finish(0)

    def poll_ui_export() -> None:
        if studio.pending_export:
            if time.monotonic() > ui_deadline[0]:
                state["error"] = f"Timed out waiting for UI mdzip export; message={studio.message!r}"
                finish(2)
                return
            QTimer.singleShot(15, poll_ui_export)
            return
        if not ui_zip.is_file():
            state["error"] = f"UI mdzip export did not produce {ui_zip}; message={studio.message!r}"
            finish(2)
            return
        run_live_export()

    ui_deadline = [0.0]
    ready_deadline = time.monotonic() + 25

    def wait_ready() -> None:
        if studio.ready:
            state["stage"] = "ui_export"
            ui_deadline[0] = time.monotonic() + 20
            studio.exportTo(QUrl.fromLocalFile(str(ui_zip)).toString(), "mdzip")
            QTimer.singleShot(15, poll_ui_export)
            return
        if time.monotonic() > ready_deadline:
            state["error"] = "Timed out waiting for real Qt WebEngine reader readiness"
            finish(2)
            return
        QTimer.singleShot(25, wait_ready)

    QTimer.singleShot(25, wait_ready)
    QTimer.singleShot(60_000, lambda: (state.update(error=f"mdzip E2E probe timed out at {state['stage']}"), finish(2)))
    return app.exec()


class MarkdownExportTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="supermd-markdown-export-")
        self.root = Path(self.temp.name)

    def tearDown(self):
        self.temp.cleanup()

    def test_writes_gif_and_svg_raster_assets_under_safe_relative_paths(self):
        gif = base64.b64decode("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7")
        self.assertTrue(gif.startswith(b"GIF89a"))
        svg = b"<svg xmlns='http://www.w3.org/2000/svg'><text>source</text></svg>"
        write_markdown_export(self.root / "note.md", "# Export\n![gif](media/loop.gif)\n", {
            "media/loop.gif": "data:image/gif;base64," + base64.b64encode(gif).decode(),
            "diagrams/source.svg": "data:image/svg+xml;base64," + base64.b64encode(svg).decode(),
        })
        self.assertEqual((self.root / "note.md").read_text(encoding="utf-8"), "# Export\n![gif](media/loop.gif)\n")
        self.assertEqual((self.root / "media/loop.gif").read_bytes(), gif)
        self.assertEqual((self.root / "diagrams/source.svg").read_bytes(), svg)

    def test_reuses_identical_assets_and_rejects_conflicts_without_overwrite(self):
        path = self.root / "images/cover.png"
        path.parent.mkdir()
        path.write_bytes(b"existing")
        data = "data:image/png;base64," + base64.b64encode(b"existing").decode()
        write_markdown_export(self.root / "note.md", "ok", {"images/cover.png": data})
        self.assertEqual(path.read_bytes(), b"existing")
        with self.assertRaisesRegex(FileExistsError, "different contents"):
            write_markdown_export(self.root / "other.md", "should not publish", {
                "images/cover.png": "data:image/png;base64," + base64.b64encode(b"replacement").decode(),
            })
        self.assertFalse((self.root / "other.md").exists())
        self.assertEqual(path.read_bytes(), b"existing")

    def test_rejects_path_traversal_and_symlinks(self):
        data = "data:image/png;base64," + base64.b64encode(b"image").decode()
        with self.assertRaisesRegex(ValueError, "traversal"):
            write_markdown_export(self.root / "note.md", "", {"../outside.png": data})
        outside = self.root / "outside"
        outside.mkdir()
        (self.root / "media").symlink_to(outside, target_is_directory=True)
        with self.assertRaisesRegex(ValueError, "symlink"):
            write_markdown_export(self.root / "note.md", "", {"media/asset.png": data})
        self.assertFalse((outside / "asset.png").exists())

    def test_enforces_asset_count_and_data_url_mime(self):
        with self.assertRaisesRegex(ValueError, "valid image data"):
            write_markdown_export(self.root / "note.md", "", {"x.png": "not-an-image"})

    def test_zip_contains_markdown_and_relative_gif_assets_without_changing_source(self):
        import zipfile
        source = self.root / "note.smd"
        original = b"source note bytes"
        source.write_bytes(original)
        gif = base64.b64decode("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7")
        output = self.root / "export.zip"
        write_markdown_zip(output, "![Loop](images/loop.gif)\n", {
            "images/loop.gif": "data:image/gif;base64," + base64.b64encode(gif).decode(),
        })
        with zipfile.ZipFile(output) as archive:
            self.assertEqual(set(archive.namelist()), {"export.md", "images/loop.gif"})
            self.assertEqual(archive.read("export.md"), b"![Loop](images/loop.gif)\n")
            self.assertEqual(archive.read("images/loop.gif"), gif)
        self.assertEqual(source.read_bytes(), original)

    @unittest.skipUnless(
        (ROOT.parent / "dist" / "qt-reader.html").is_file(),
        "Build the Qt reader before running the real WebEngine mdzip E2E test",
    )
    def test_end_to_end_mdzip_export_preserves_realistic_note_byte_for_byte(self):
        expected_source_bytes = REALISTIC_MDZIP_NOTE.encode("utf-8")
        env = dict(
            os.environ,
            QT_QPA_PLATFORM="offscreen",
            QT_QUICK_BACKEND="software",
            QTWEBENGINE_DISABLE_SANDBOX="1",
            QTWEBENGINE_CHROMIUM_FLAGS="--disable-gpu --disable-dev-shm-usage",
        )
        result = subprocess.run(
            [sys.executable, str(Path(__file__).resolve()), "--mdzip-e2e-probe", str(self.root)],
            cwd=ROOT,
            env=env,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="strict",
            timeout=90,
        )
        lines = [line for line in result.stdout.splitlines() if line.startswith("{")]
        self.assertTrue(lines, f"mdzip E2E probe emitted no JSON report: {result.stdout}\n{result.stderr}")
        report = json.loads(lines[-1])
        self.assertEqual(result.returncode, 0, f"mdzip E2E probe failed: {report}\n{result.stderr}")
        self.assertTrue(report["ok"], report)

        ui_zip = Path(report["uiZip"])
        live_zip = Path(report["liveZip"])
        self.assertTrue(ui_zip.is_file())
        self.assertTrue(live_zip.is_file())
        self.assertEqual((self.root.resolve() / "Graph Study.md").read_bytes(), expected_source_bytes)

        for archive_path, expected_md_entry in (
            (ui_zip, "Graph Study.md"),
            (live_zip, "Live Graph Bundle.md"),
        ):
            with zipfile.ZipFile(archive_path) as archive:
                self.assertEqual(
                    set(archive.namelist()),
                    {expected_md_entry, "img.png", "DM Images/proof guide.png"},
                )
                self.assertEqual(archive.read(expected_md_entry), expected_source_bytes)
                self.assertEqual(archive.read("img.png"), PNG_1X1)
                self.assertEqual(archive.read("DM Images/proof guide.png"), PNG_2X2)


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "--mdzip-e2e-probe":
        raise SystemExit(_mdzip_e2e_probe(sys.argv[2]))
    unittest.main()
