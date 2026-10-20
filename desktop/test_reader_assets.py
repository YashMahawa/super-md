import base64
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
from PySide6.QtGui import QGuiApplication
from reader_assets import ReaderAssetStore, resolve_source
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


if __name__ == "__main__":
    unittest.main()
