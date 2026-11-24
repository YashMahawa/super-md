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

    def test_opening_smd_and_streaming_embedded_raster_decodes_once_and_evicts_on_invalidation(self):
        import time
        import documents

        session = Session(True)
        session.settings["python"] = sys.executable
        studio = Studio(True, session)
        try:
            with tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                raw_one = b"\x89PNG\r\n\x1a\n" + (b"raster-one-" * 64)
                raw_two = b"\x89PNG\r\n\x1a\n" + (b"raster-two-" * 64)
                assets = {
                    "assets/one.png": "data:image/png;base64," + base64.b64encode(raw_one).decode("ascii"),
                    "assets/two.png": "data:image/png;base64," + base64.b64encode(raw_two).decode("ascii"),
                }
                smd_path = root / "gallery.smd"
                smd_path.write_bytes(documents.compressed_bundle("# Gallery\n\n![](assets/one.png)\n![](assets/two.png)\n", assets))

                replies = []
                studio.replied.connect(lambda identifier, value, error: replies.append((identifier, value, error)))

                with patch.object(documents.base64, "b64decode", wraps=base64.b64decode) as b64_spy:
                    content, loaded_assets, portable = documents.open_note(smd_path)
                    self.assertEqual(b64_spy.call_count, 0)
                    tab = studio._current()
                    tab.update(
                        path=str(smd_path), name=smd_path.name, content=content, saved=content,
                        assets=loaded_assets, saved_assets=dict(loaded_assets), portable=portable,
                    )

                    with patch.object(studio, "_submit", side_effect=lambda action, done, *_a, **_kw: done(action(), None)):
                        for source, expected_bytes in (("assets/one.png", raw_one), ("assets/two.png", raw_two)):
                            replies.clear()
                            studio.post("res", "resolve_reader_asset", json.dumps({
                                "documentPath": tab["id"], "source": source,
                            }))
                            response = json.loads(replies[0][1])
                            token = response["url"].split("//", 1)[1].split("?", 1)[0]
                            fingerprint = response["url"].split("v=", 1)[1]
                            grant = session.reader_assets.lookup(token, fingerprint)
                            self.assertIsNotNone(grant)
                            device = session.reader_assets.open_payload(grant)
                            try:
                                self.assertEqual(bytes(device.readAll()), expected_bytes)
                            finally:
                                device.close()
                            # Repeat resolution + stream: still 0 additional decodes.
                            replies.clear()
                            studio.post("res2", "resolve_reader_asset", json.dumps({
                                "documentPath": tab["id"], "source": source,
                            }))
                            device2 = session.reader_assets.open_payload(grant)
                            device2.close()

                    # Opening + resolving + streaming 2 rasters decoded each raster exactly once (1.0x).
                    self.assertEqual(b64_spy.call_count, 2)
                    self.assertEqual(session.reader_assets.cached_bytes, len(raw_one) + len(raw_two))

                # Changing tab["assets"][source] immediately invalidates and evicts that asset's cached bytes.
                first_token = next(
                    tok for tok, g in session.reader_assets._grants.items() if g.source == "assets/one.png"
                )
                first_grant = session.reader_assets._grants[first_token]
                first_fp = first_grant.fingerprint
                tab["assets"]["assets/one.png"] = "data:image/png;base64," + base64.b64encode(b"\x89PNG\r\n\x1a\nreplaced").decode("ascii")
                self.assertEqual(session.reader_assets.cached_bytes, len(raw_two))
                self.assertIsNone(session.reader_assets.lookup(first_token, first_fp))
                with self.assertRaises(ValueError):
                    session.reader_assets.open_payload(first_grant)

                # Closing the tab revokes remaining grants and evicts all cached bytes for that tab.
                studio.newNote()
                studio._finish_remove_tab(tab["id"])
                self.assertEqual(session.reader_assets.cached_bytes, 0)
                self.assertEqual(len(session.reader_assets), 0)

                # Payload byte cap evicts oldest cached payloads while keeping capabilities bounded.
                active = studio._current()
                p1 = b"\x89PNG\r\n\x1a\n" + (b"1" * 100)
                p2 = b"\x89PNG\r\n\x1a\n" + (b"2" * 100)
                active["assets"]["assets/p1.png"] = "data:image/png;base64," + base64.b64encode(p1).decode("ascii")
                active["assets"]["assets/p2.png"] = "data:image/png;base64," + base64.b64encode(p2).decode("ascii")
                session.reader_assets.MAX_PAYLOAD_BYTES = len(p1) + 10
                session.reader_assets.register(studio.window_id, active["id"], "assets/p1.png", resolve_source(active, "assets/p1.png"))
                session.reader_assets.register(studio.window_id, active["id"], "assets/p2.png", resolve_source(active, "assets/p2.png"))
                self.assertLessEqual(session.reader_assets.cached_bytes, session.reader_assets.MAX_PAYLOAD_BYTES)
                self.assertEqual(session.reader_assets.cached_bytes, len(p2))

                # Window retirement (revoke_owner) evicts all remaining cached bytes.
                studio.stop()
                self.assertEqual(session.reader_assets.cached_bytes, 0)
        finally:
            studio.stop()
            studio.pool.shutdown(wait=True, cancel_futures=True)
            session.writes.shutdown(wait=True)

    def test_studio_save_text_skips_base64_decode_and_detects_external_or_corrupt_smd(self):
        import time
        import documents

        session = Session(True)
        session.settings["python"] = sys.executable
        studio = Studio(True, session)
        try:
            with tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                png = b"\x89PNG\r\n\x1a\n" + (b"autosave-raster-" * 100)
                assets = {"assets/pic.png": "data:image/png;base64," + base64.b64encode(png).decode("ascii")}
                note = root / "autosave.smd"
                documents.write_portable(note, "# Original\n", assets)

                def wait_for_save():
                    deadline = time.monotonic() + 3.0
                    while studio.saving and time.monotonic() < deadline:
                        self.app.processEvents()
                        time.sleep(0.005)
                    self.app.processEvents()

                with patch.object(documents.base64, "b64decode", wraps=base64.b64decode) as b64_spy:
                    content, loaded_assets, portable = documents.open_note(note)
                    tab = studio._current()
                    tab.update(
                        path=str(note), name=note.name, content="# Autosaved edit\n", saved=content,
                        assets=loaded_assets, saved_assets=dict(loaded_assets), portable=portable,
                    )
                    studio._save_text(tab, note, automatic=True)
                    wait_for_save()
                    self.assertEqual(tab["saved"], "# Autosaved edit\n")
                    self.assertEqual(documents.open_note(note)[0], "# Autosaved edit\n")

                    tab["content"] = "# Manual save edit\n"
                    studio._save_text(tab, note, automatic=False)
                    wait_for_save()
                    self.assertEqual(tab["saved"], "# Manual save edit\n")
                    self.assertEqual(b64_spy.call_count, 0)

                    # External Markdown edit pauses autosave without decoding images or overwriting disk.
                    documents.write_portable(note, "# External change\n", loaded_assets, validate_assets=False)
                    tab["content"] = "# Local draft\n"
                    studio._save_text(tab, note, automatic=True)
                    wait_for_save()
                    self.assertEqual(documents.open_note(note)[0], "# External change\n")
                    self.assertIn("Autosave paused", studio.message)

                    # Truncated/concatenated GZIP and invalid envelopes on disk also fail autosave without decoding images.
                    raw_disk = note.read_bytes()
                    exact_25mb_len = (documents.MAX_IMAGE // 3) * 4 + 4
                    over_25mb = "A" * (exact_25mb_len - 1) + "="
                    for damaged in (
                        raw_disk[:-4],
                        raw_disk + raw_disk,
                        json.dumps({"format": "supermd-smd", "version": 1, "markdown": "# External change\n",
                                    "assets": {"assets/../escape.png": "data:image/png;base64,eA=="}}).encode("utf-8"),
                        json.dumps({"format": "supermd-smd", "version": 1, "markdown": "# External change\n",
                                    "assets": {"assets/pic.png": "data:image/jpeg;base64,eA=="}}).encode("utf-8"),
                        json.dumps({"format": "supermd-smd", "version": 1, "markdown": "# External change\n",
                                    "assets": {"assets/huge.png": "data:image/png;base64," + over_25mb}}).encode("utf-8"),
                    ):
                        note.write_bytes(damaged)
                        studio.message = ""
                        studio._save_text(tab, note, automatic=True)
                        wait_for_save()
                        self.assertEqual(note.read_bytes(), damaged)
                    self.assertEqual(b64_spy.call_count, 0)
        finally:
            studio.stop()
            studio.pool.shutdown(wait=True, cancel_futures=True)
            session.writes.shutdown(wait=True)


if __name__ == "__main__":
    unittest.main()
