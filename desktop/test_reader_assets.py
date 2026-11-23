import base64
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
from PySide6.QtGui import QGuiApplication
from reader_assets import (
    READER_HOST,
    READER_SCHEME,
    ReaderAssetStore,
    ReaderBundleSchemeHandler,
    reader_bundle_url,
    resolve_bundle_file,
    resolve_source,
)
from studio import Session, Studio


class ReaderAssetTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.app = QGuiApplication.instance() or QGuiApplication(["Super MD reader asset tests"])

    def test_embedded_raster_is_hashed_without_returning_a_data_url(self):
        raw = b"\x89PNG\r\n\x1a\nsmall"
        encoded = "data:image/png;base64," + base64.b64encode(raw).decode("ascii")
        resolved = resolve_source({"assets": {"assets/a.png": encoded}}, "assets/a.png")
        self.assertEqual(resolved["mime"], "image/png")
        self.assertEqual(resolved["size"], len(raw))
        self.assertEqual(resolved["embedded_data"], encoded)
        self.assertNotIn("data:", resolved["fingerprint"])

    def test_files_are_contained_bounded_and_fingerprinted(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            note = root / "note.md"
            image = root / "assets" / "a.png"
            image.parent.mkdir()
            image.write_bytes(b"PNG payload")
            resolved = resolve_source({"path": str(note), "assets": {}}, "assets/a.png")
            self.assertEqual(resolved["path"], str(image.resolve()))
            self.assertEqual(resolved["size"], len(b"PNG payload"))
            with self.assertRaises(ValueError):
                resolve_source({"path": str(note), "assets": {}}, "../outside.png")
            with self.assertRaises(ValueError):
                resolve_source({"path": str(note), "assets": {}}, "assets/a.svg")

    def test_capability_is_exact_owner_bound_and_revocable(self):
        current = {"owner": "window", "tab": "note", "source": "assets/a.png", "data": "stable"}

        def is_current(grant):
            return (grant.owner_id, grant.tab_id, grant.source, grant.embedded_identity) == (
                current["owner"], current["tab"], current["source"], id(current["data"]))

        store = ReaderAssetStore(is_current, lambda grant: current["data"] if is_current(grant) else None)
        resolved = {"mime": "image/png", "fingerprint": "a" * 64, "embedded_data": "stable", "size": 6}
        url = store.register("window", "note", "assets/a.png", resolved)
        token = url.split("//", 1)[1].split("?", 1)[0]
        self.assertIsNotNone(store.lookup(token, "a" * 64))
        self.assertIsNone(store.lookup(token, "b" * 64))
        self.assertIsNotNone(store.lookup(token, "a" * 64))
        self.assertIsNone(store.lookup("../" + token, "a" * 64))
        current["data"] = "changed"
        self.assertIsNone(store.lookup(token, "a" * 64))

    def test_revoking_tab_does_not_revoke_other_open_notes(self):
        store = ReaderAssetStore(lambda _: True, lambda _: "x")
        resolved = {"mime": "image/png", "fingerprint": "a" * 64, "embedded_data": "x", "size": 1}
        one = store.register("window", "one", "assets/a.png", resolved)
        two = store.register("window", "two", "assets/a.png", resolved)
        token = lambda url: url.split("//", 1)[1].split("?", 1)[0]
        store.revoke_tab("window", "one")
        self.assertIsNone(store.lookup(token(one), "a" * 64))
        self.assertIsNotNone(store.lookup(token(two), "a" * 64))

    def test_external_file_capability_expires_after_metadata_change(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            note = root / "note.md"
            image = root / "image.png"
            image.write_bytes(b"first")
            resolved = resolve_source({"path": str(note), "assets": {}}, "image.png")
            store = ReaderAssetStore(lambda _: True, lambda _: None)
            url = store.register("window", "note", "image.png", resolved)
            token = url.split("//", 1)[1].split("?", 1)[0]
            self.assertIsNotNone(store.lookup(token, resolved["fingerprint"]))
            image.write_bytes(b"second image")
            self.assertIsNone(store.lookup(token, resolved["fingerprint"]))

    def test_file_device_reads_the_fstat_checked_open_handle(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            image = root / "image.png"
            image.write_bytes(b"bounded streamed payload")
            resolved = resolve_source({"path": str(root / "note.md"), "assets": {}}, "image.png")
            store = ReaderAssetStore(lambda _: True, lambda _: None)
            url = store.register("window", "note", "image.png", resolved)
            grant = store.lookup(url.split("//", 1)[1].split("?", 1)[0], resolved["fingerprint"])
            device = store.open_payload(grant)
            try:
                self.assertEqual(bytes(device.readAll()), b"bounded streamed payload")
            finally:
                device.close()

    @unittest.skipUnless(hasattr(os, "O_NOFOLLOW"), "platform does not expose O_NOFOLLOW")
    def test_symlink_replacement_is_rejected_when_opening_the_capability(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            image = root / "image.png"
            outside = root / "outside.png"
            image.write_bytes(b"inside")
            outside.write_bytes(b"outside")
            resolved = resolve_source({"path": str(root / "note.md"), "assets": {}}, "image.png")
            store = ReaderAssetStore(lambda _: True, lambda _: None)
            url = store.register("window", "note", "image.png", resolved)
            grant = store.lookup(url.split("//", 1)[1].split("?", 1)[0], resolved["fingerprint"])
            image.unlink()
            image.symlink_to(outside)
            with self.assertRaises((OSError, ValueError)):
                store.open_payload(grant)

    def test_repeated_resolution_deduplicates_and_full_capacity_preserves_old_urls(self):
        store = ReaderAssetStore(lambda _: True, lambda _: "x")
        store.MAX_CAPABILITIES = 2
        resolved = {"mime": "image/png", "fingerprint": "a" * 64, "embedded_data": "x", "size": 1}
        first = store.register("window", "note", "one.png", resolved)
        self.assertEqual(store.register("window", "note", "one.png", resolved), first)
        self.assertEqual(len(store), 1)
        second = store.register("window", "note", "two.png", resolved)
        self.assertIsNotNone(second)
        self.assertIsNone(store.register("window", "note", "three.png", resolved))
        token = first.split("//", 1)[1].split("?", 1)[0]
        self.assertIsNotNone(store.lookup(token, "a" * 64))
        self.assertEqual(len(store), 2)

    def test_studio_resolver_returns_a_live_note_scoped_capability(self):
        session = Session(True)
        session.settings["python"] = sys.executable
        studio = Studio(True, session)
        try:
            tab = studio._current()
            raw = b"\x89PNG\r\n\x1a\nsmall"
            tab["assets"]["assets/a.png"] = "data:image/png;base64," + base64.b64encode(raw).decode("ascii")
            replies = []
            studio.replied.connect(lambda identifier, value, error: replies.append((identifier, value, error)))

            def submit(action, done, *_args, **_kwargs):
                try:
                    done(action(), None)
                except Exception as error:
                    done(None, str(error))

            with patch.object(studio, "_submit", side_effect=submit):
                studio.post("resolve", "resolve_reader_asset", json.dumps({
                    "documentPath": tab["id"], "source": "assets/a.png"}))
            self.assertEqual(len(replies), 1)
            self.assertEqual(replies[0][0], "resolve")
            self.assertEqual(replies[0][2], "")
            response = json.loads(replies[0][1])
            self.assertRegex(response["url"], r"^supermdasset://[a-f0-9]{32}\?v=[a-f0-9]{64}$")
            self.assertEqual(response["mime"], "image/png")
            token = response["url"].split("//", 1)[1].split("?", 1)[0]
            self.assertIsNotNone(session.reader_assets.lookup(token, response["url"].split("v=", 1)[1]))
            session.reader_assets.revoke_tab(studio.window_id, tab["id"])
            self.assertIsNone(session.reader_assets.lookup(token, response["url"].split("v=", 1)[1]))
        finally:
            studio.stop()
            studio.pool.shutdown(wait=True, cancel_futures=True)
            session.writes.shutdown(wait=True)

    def test_studio_resolver_uses_legacy_fallback_when_capability_capacity_is_full(self):
        session = Session(True)
        session.settings["python"] = sys.executable
        studio = Studio(True, session)
        try:
            tab = studio._current()
            tab["assets"]["assets/a.png"] = "data:image/png;base64," + base64.b64encode(b"small").decode("ascii")
            session.reader_assets.MAX_CAPABILITIES = 0
            replies = []
            studio.replied.connect(lambda identifier, value, error: replies.append((identifier, value, error)))
            with patch.object(studio, "_submit", side_effect=lambda action, done, *_args, **_kwargs: done(action(), None)):
                studio.post("resolve", "resolve_reader_asset", json.dumps({
                    "documentPath": tab["id"], "source": "assets/a.png"}))
            self.assertEqual(replies[0][2], "")
            self.assertIsNone(json.loads(replies[0][1])["url"])
            self.assertEqual(len(session.reader_assets), 0)
        finally:
            studio.stop()
            studio.pool.shutdown(wait=True, cancel_futures=True)
            session.writes.shutdown(wait=True)

    def test_reader_bundle_scheme_serves_contained_dist_files_and_rejects_escapes_or_symlinks(self):
        self.assertEqual(reader_bundle_url().toString(), f"{READER_SCHEME}://{READER_HOST}/qt-reader.html")
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            dist = root / "dist"
            assets = dist / "assets"
            assets.mkdir(parents=True)
            (dist / "qt-reader.html").write_text("<!doctype html><title>ok</title>", encoding="utf-8")
            (assets / "reader.js").write_text("export default 1;", encoding="utf-8")
            (dist / "secret.exe").write_bytes(b"MZ")
            outside = root / "outside.html"
            outside.write_text("outside", encoding="utf-8")
            (dist / "linked.html").symlink_to(outside)

            resolved_html, html_mime = resolve_bundle_file(dist, "/qt-reader.html")
            self.assertEqual(resolved_html, (dist / "qt-reader.html").resolve())
            self.assertEqual(html_mime, "text/html")

            handler = ReaderBundleSchemeHandler(dist)
            device, js_mime = handler.open_bundle_device("/assets/reader.js")
            try:
                self.assertEqual(js_mime, "text/javascript")
                self.assertEqual(bytes(device.readAll()), b"export default 1;")
            finally:
                device.close()

            for blocked in (
                "/../outside.html",
                "/%2e%2e/outside.html",
                "/linked.html",
                "/secret.exe",
                "/",
                "qt-reader.html",
            ):
                with self.assertRaises(PermissionError, msg=blocked):
                    resolve_bundle_file(dist, blocked)

            qml_source = (Path(__file__).resolve().parent / "qml" / "Main.qml").read_text(encoding="utf-8")
            self.assertIn("settings.localContentCanAccessFileUrls: false", qml_source)
            self.assertNotIn("settings.localContentCanAccessFileUrls: true", qml_source)

    def test_production_main_qml_renders_fallback_mermaid_sandbox_and_rejects_untrusted_subframes(self):
        import subprocess
        import sys

        desktop_dir = Path(__file__).resolve().parent
        dist_dir = desktop_dir.parent / "dist"
        if not (dist_dir / "qt-reader.html").is_file():
            self.skipTest("dist/qt-reader.html is not built")

        probe_code = """
import json, os, sys, time
from pathlib import Path
os.environ["QT_QPA_PLATFORM"] = "offscreen"
os.environ["QT_QUICK_BACKEND"] = "software"
os.environ.setdefault("QTWEBENGINE_CHROMIUM_FLAGS", "--disable-gpu --disable-dev-shm-usage")
os.environ.setdefault("QTWEBENGINE_DISABLE_SANDBOX", "1")
from PySide6.QtCore import QFile, QIODevice, QMetaObject, QObject, QTimer, QUrl, Q_ARG, Slot
from PySide6.QtGui import QDesktopServices
from PySide6.QtQml import QQmlApplicationEngine
from PySide6.QtQuickControls2 import QQuickStyle
from PySide6.QtWebEngineCore import QWebEngineProfile
from PySide6.QtWebEngineQuick import QtWebEngineQuick
from PySide6.QtWidgets import QApplication
from reader_assets import READER_SCHEME, ReaderBundleSchemeHandler, reader_bundle_url, register_reader_schemes
from studio import ROOT, Session, Studio

QQuickStyle.setStyle("Material")
register_reader_schemes()
QtWebEngineQuick.initialize()
app = QApplication(["Super MD Main.qml Mermaid sandbox test"])
opened_external = []

class UrlCatcher(QObject):
    @Slot(QUrl)
    def handleUrl(self, url):
        opened_external.append(url.toString())

catcher = UrlCatcher()
QDesktopServices.setUrlHandler("https", catcher, "handleUrl")
QDesktopServices.setUrlHandler("http", catcher, "handleUrl")

bundle_handler = ReaderBundleSchemeHandler(ROOT / "dist", app)
QWebEngineProfile.defaultProfile().installUrlSchemeHandler(READER_SCHEME.encode("ascii"), bundle_handler)
session = Session(True)
session.settings["python"] = sys.executable
studio = Studio(True, session)
studio.settings["welcomed"] = True
studio.mode = "reader"
note = next(t for t in studio.tabs if t["id"] == studio.active)
note["content"] = (
    "# Qt Sandbox Check\\n\\n"
    "```mermaid\\n"
    "gantt\\n"
    "  title Sandbox Schedule\\n"
    "  dateFormat YYYY-MM-DD\\n"
    "  Phase 1 :a1, 2026-09-01, 3d\\n"
    "  Phase 2 :after a1, 2d\\n"
    "```\\n"
)
note["saved"] = note["content"]

channel = QFile(":/qtwebchannel/qwebchannel.js")
if not channel.open(QIODevice.OpenModeFlag.ReadOnly):
    raise RuntimeError("Qt WebChannel runtime is unavailable")
channel_script = bytes(channel.readAll()).decode()

engine = QQmlApplicationEngine()
engine.rootContext().setContextProperty("studio", studio)
engine.rootContext().setContextProperty("readerUrl", reader_bundle_url())
engine.rootContext().setContextProperty("channelScript", channel_script)
engine.rootContext().setContextProperty("brandUrl", QUrl.fromLocalFile(str(ROOT / "public" / "brand-mark-fixed.svg")))
engine.load(QUrl.fromLocalFile(str(ROOT / "desktop" / "qml" / "Main.qml")))
if not engine.rootObjects():
    raise RuntimeError("Main.qml failed to load")
window = engine.rootObjects()[0]
studio.host_window = window
window.show()

deadline = time.monotonic() + 20.0
probe_sent = False

def poll():
    global probe_sent
    if studio.message.startswith("QML_SANDBOX:"):
        payload = json.loads(studio.message.removeprefix("QML_SANDBOX:"))
        payload["openedExternal"] = list(opened_external)
        print("QML_SANDBOX_RESULT:" + json.dumps(payload), flush=True)
        app.exit(0)
        return
    if time.monotonic() >= deadline:
        print("QML_SANDBOX_TIMEOUT:" + json.dumps({"ready": studio.ready, "message": studio.message}), flush=True)
        app.exit(2)
        return
    if studio.ready and not probe_sent:
        script = '''(()=>{
          const img = document.querySelector('.mermaid img');
          const err = document.querySelector('.render-error,.image-error');
          if (err) {
            window.SuperMD?.post('q', 'export_failed', JSON.stringify({error: 'QML_SANDBOX:' + JSON.stringify({ok: false, error: err.textContent})}));
            return;
          }
          if (!img || !img.complete || img.naturalWidth <= 0) return;
          if (window.__probeSent) return;
          window.__probeSent = true;
          const svg = decodeURIComponent(img.src.split(',').slice(1).join(','));
          const sandboxFrame = document.documentElement.querySelector('iframe[data-mermaid-sandbox]');
          // Attempt untrusted subframe navigations; CSP + Main.qml must block without opening external browser.
          const evil = document.createElement('iframe');
          evil.src = 'https://evil.example/subframe';
          document.documentElement.appendChild(evil);
          setTimeout(() => {
            evil.remove();
            window.SuperMD?.post('q', 'export_failed', JSON.stringify({error: 'QML_SANDBOX:' + JSON.stringify({
              ok: true,
              naturalWidth: img.naturalWidth,
              hasMermaidEngine: svg.includes('data-diagram-engine="mermaid"'),
              sandboxAttr: sandboxFrame?.getAttribute('sandbox') ?? null,
              inBody: sandboxFrame ? document.body.contains(sandboxFrame) : null
            })}));
          }, 150);
        })()'''
        QMetaObject.invokeMethod(window, "runDocumentScript", Q_ARG("QVariant", script))
    QTimer.singleShot(200, poll)

QTimer.singleShot(200, poll)
code = app.exec()
studio.stop()
for eng in (engine,):
    eng.deleteLater()
studio.pool.shutdown(wait=False, cancel_futures=True)
session.writes.shutdown(wait=True)
QDesktopServices.unsetUrlHandler("https")
QDesktopServices.unsetUrlHandler("http")
sys.exit(code)
"""
        proc = subprocess.run(
            [sys.executable, "-c", probe_code],
            cwd=str(desktop_dir),
            capture_output=True,
            text=True,
            timeout=35,
        )
        self.assertEqual(proc.returncode, 0, msg=f"stdout:\n{proc.stdout}\nstderr:\n{proc.stderr}")
        marker = next((line for line in proc.stdout.splitlines() if line.startswith("QML_SANDBOX_RESULT:")), "")
        self.assertTrue(marker, msg=proc.stdout)
        result = json.loads(marker.removeprefix("QML_SANDBOX_RESULT:"))
        self.assertTrue(result["ok"], msg=result)
        self.assertGreater(result["naturalWidth"], 80)
        self.assertTrue(result["hasMermaidEngine"])
        self.assertEqual(result["sandboxAttr"], "allow-scripts")
        self.assertIs(result["inBody"], False)
        self.assertEqual(result["openedExternal"], [])


if __name__ == "__main__":
    unittest.main()
