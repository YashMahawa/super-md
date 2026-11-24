import base64
import json
import os
import stat
import tempfile
import unittest
import zlib
from pathlib import Path
from documents import atomic_write, atomic_json, bundle, compressed_bundle, materialize_assets, open_note, validate, write_portable

class DocumentsTest(unittest.TestCase):
    def test_windows_sharing_lock_retries_atomic_replace_without_touching_old_note(self):
        import documents
        from unittest.mock import patch
        with tempfile.TemporaryDirectory() as directory:
            target=Path(directory)/"existing.smd"
            target.write_bytes(b"old note")
            actual_replace=os.replace
            calls=[]
            def temporarily_locked(source, destination):
                calls.append((source,destination))
                if len(calls)<=2:
                    error=PermissionError("sharing violation")
                    error.winerror=32
                    raise error
                actual_replace(source,destination)
            with patch.object(documents.os,"name","nt"), patch.object(documents.os,"replace",side_effect=temporarily_locked):
                write_portable(target,"# safe",{})
            self.assertEqual(len(calls),3)
            self.assertEqual(open_note(target),("# safe",{},True))

    def test_portable_envelopes_are_detected_independently_of_filename(self):
        with tempfile.TemporaryDirectory() as directory:
            for name in ("shared", "note.txt", "note.json", "note.md", "note.SMD", "note.FMD"):
                path=Path(directory)/name
                for kind in ("supermd-smd", "supermd-fmd"):
                    value=bundle("# Actual Markdown",{});value["format"]=kind
                    path.write_text("\ufeff  "+json.dumps(value),encoding="utf-8")
                    self.assertEqual(open_note(path),("# Actual Markdown",{},True))
            ordinary=Path(directory)/"data.json"
            ordinary.write_text('{"format":"csv","markdown":"not a bundle"}')
            self.assertEqual(open_note(ordinary),(ordinary.read_text(),{},False))

    def test_gzip_portable_is_deterministic_and_round_trips_source_and_asset_bytes(self):
        import base64
        svg="<svg xmlns='http://www.w3.org/2000/svg'><text>α &amp; β</text></svg>".encode()
        source="# α\n\n![Exact](assets/plot.svg)\n"
        assets={"assets/plot.svg":"data:image/svg+xml;base64,"+base64.b64encode(svg).decode("ascii")}
        first=compressed_bundle(source,assets)
        self.assertEqual(first[:2],b"\x1f\x8b")
        self.assertEqual(first,compressed_bundle(source,assets))
        with tempfile.TemporaryDirectory() as directory:
            path=Path(directory)/"opaque.bin"
            path.write_bytes(first)
            self.assertEqual(open_note(path),(source,assets,True))
            decoded=base64.b64decode(open_note(path)[1]["assets/plot.svg"].split(",",1)[1])
            self.assertEqual(decoded,svg)
            write_portable(path,source,assets)
            self.assertEqual(open_note(path),(source,assets,True))

    def test_gzip_portable_rejects_corruption_truncation_and_extra_members(self):
        import gzip
        from documents import _gzip_json_input
        data=compressed_bundle("# source",{})
        with tempfile.TemporaryDirectory() as directory:
            path=Path(directory)/"renamed.txt"
            for invalid in (data[:-2],data+data,data+b"trailing",bytes([data[0]^255])+data[1:]):
                path.write_bytes(invalid)
                with self.assertRaises((ValueError,OSError,zlib.error)):
                    _gzip_json_input(path)
                with self.assertRaises((ValueError,OSError)):
                    open_note(path)
            bomb=gzip.compress(b"x"*4096,mtime=0)
            path.write_bytes(bomb)
            from unittest.mock import patch
            with patch("documents.MAX_FILE",1024):
                with self.assertRaises(ValueError): _gzip_json_input(path)

    def test_failed_compressed_write_preserves_existing_destination(self):
        from unittest.mock import patch
        with tempfile.TemporaryDirectory() as directory:
            path=Path(directory)/"note.smd"
            path.write_bytes(b"existing note")
            with patch("documents.MAX_FILE",32):
                with self.assertRaises(ValueError): write_portable(path,"# too large for bound",{})
            self.assertEqual(path.read_bytes(),b"existing note")
    def test_streamed_recovery_round_trip_and_failed_serialization_are_atomic(self):
        with tempfile.TemporaryDirectory() as directory:
            path=Path(directory)/"recovery.json"
            value=[{"content":'Quoted "λ" and \\math\n'*10000,"saved":"original"}]
            atomic_json(path,value)
            self.assertEqual(json.loads(path.read_text(encoding="utf-8")),value)
            before=path.read_bytes()
            with self.assertRaises(TypeError):atomic_json(path,{"unsupported":object()})
            self.assertEqual(path.read_bytes(),before)
            self.assertEqual(list(Path(directory).iterdir()),[path])
    def test_legacy_and_new_formats(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory)/"note.smd"
            atomic_write(path,b"# Old plain-text SMD")
            self.assertEqual(open_note(path),("# Old plain-text SMD",{},False))
            asset = "data:image/svg+xml;base64,"+base64.b64encode(b"<svg/>").decode()
            for format in ("supermd-smd","supermd-fmd"):
                data = bundle("![plot](assets/plot.svg)",{"assets/plot.svg":asset})
                data["format"] = format
                atomic_write(path,json.dumps(data).encode())
                text, images, portable = open_note(path)
                self.assertTrue(portable)
                self.assertNotIn("base64",text)
                self.assertEqual(images["assets/plot.svg"],asset)
    def test_rejects_unsafe_assets(self):
        with self.assertRaises(ValueError):
            bundle("text",{"assets/../secret.svg":"data:image/svg+xml;base64,eA=="})
    def test_failure_preserves_original(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory)/"note.md"
            atomic_write(path,b"original")
            with self.assertRaises(OSError):
                atomic_write(path/"missing",b"bad")
            self.assertEqual(path.read_text(),"original")
    def test_recovery_preserves_transient_utf16_surrogates_without_invalid_utf8(self):
        with tempfile.TemporaryDirectory() as directory:
            path=Path(directory)/"recovery.json"
            value={"content":"Draft 😀\ud800 unfinished"}
            atomic_json(path,value)
            self.assertEqual(json.loads(path.read_text(encoding="utf-8")),value)
            self.assertIn(b"\\ud800",path.read_bytes())

    def test_markdown_conversion_keeps_images_without_overwriting_other_notes(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            data = "data:image/svg+xml;base64,"+base64.b64encode(b"<svg/>").decode()
            materialize_assets(root,{"assets/plot.svg":data})
            self.assertEqual((root/"assets/plot.svg").read_bytes(),b"<svg/>")
            materialize_assets(root,{"assets/plot.svg":data})
            changed = "data:image/svg+xml;base64,"+base64.b64encode(b"<svg>other</svg>").decode()
            with self.assertRaises(ValueError): materialize_assets(root,{"assets/plot.svg":changed})
            self.assertEqual((root/"assets/plot.svg").read_bytes(),b"<svg/>")
    @unittest.skipUnless(os.name == "posix" and hasattr(os,"fchmod"),"Unix permission bits do not apply to Windows ACLs")
    def test_atomic_save_preserves_file_permissions(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory)/"note.md"
            atomic_write(path,b"old")
            path.chmod(0o640)
            atomic_write(path,b"new")
            self.assertEqual(stat.S_IMODE(path.stat().st_mode),0o640)

    def test_structural_envelope_validation_defers_base64_decode_and_enforces_limits(self):
        import documents
        from unittest.mock import patch
        from documents import decode_note_bytes, read_note_markdown, validate_envelope

        png = b"\x89PNG\r\n\x1a\n" + b"p" * 128
        assets = {"assets/pic.png": "data:image/png;base64," + base64.b64encode(png).decode("ascii")}
        packed = compressed_bundle("# Heading\n\n![pic](assets/pic.png)\n", assets)

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            smd = root / "note.smd"
            smd.write_bytes(packed)
            json_smd = root / "plain-json.smd"
            json_smd.write_text(json.dumps(bundle("# JSON note\n", assets)), encoding="utf-8")

            with patch("documents.base64.b64decode", wraps=base64.b64decode) as spy:
                text, loaded_assets, portable = open_note(smd)
                self.assertTrue(portable)
                self.assertEqual(loaded_assets, assets)
                self.assertEqual(read_note_markdown(smd), text)
                self.assertEqual(decode_note_bytes(packed, smd), (text, assets, True))
                self.assertEqual(open_note(json_smd), ("# JSON note\n", assets, True))
                write_portable(smd, "# Updated\n", loaded_assets, validate_assets=False)
                write_portable(smd, "# Updated again\n", loaded_assets, validated_assets=loaded_assets)
                self.assertEqual(read_note_markdown(smd), "# Updated again\n")
                self.assertEqual(spy.call_count, 0)

                # Exact 25 MB encoded bound passes structural validation; 25 MB + 1 byte fails.
                exact_25mb_len = (documents.MAX_IMAGE // 3) * 4 + 4  # 33,333,336 chars -> 25,000,000 bytes with '=='
                exact_25mb = "A" * (exact_25mb_len - 2) + "=="
                over_25mb = "A" * (exact_25mb_len - 1) + "="  # 25,000,001 bytes
                validate_envelope({
                    "format": "supermd-smd", "version": 1, "markdown": "ok",
                    "assets": {"assets/max.png": "data:image/png;base64," + exact_25mb},
                })
                for invalid_envelope in (
                    {"format": "other", "version": 1, "markdown": "", "assets": {}},
                    {"format": "supermd-smd", "version": True, "markdown": "", "assets": {}},
                    {"format": "supermd-smd", "version": 1, "markdown": "", "assets": {}, "extra": 1},
                    {"format": "supermd-smd", "version": 1, "markdown": "x" * (documents.MAX_MARKDOWN + 1), "assets": {}},
                    {"format": "supermd-smd", "version": 1, "markdown": "", "assets": {
                        f"assets/a{i}.png": "data:image/png;base64,eA==" for i in range(documents.MAX_ASSETS + 1)
                    }},
                    {"format": "supermd-smd", "version": 1, "markdown": "", "assets": {
                        "assets/../escape.png": "data:image/png;base64,eA=="
                    }},
                    {"format": "supermd-smd", "version": 1, "markdown": "", "assets": {
                        "assets/mismatch.png": "data:image/jpeg;base64,eA=="
                    }},
                    {"format": "supermd-smd", "version": 1, "markdown": "", "assets": {
                        "assets/unaligned.png": "data:image/png;base64,ABC"
                    }},
                    {"format": "supermd-smd", "version": 1, "markdown": "", "assets": {
                        "assets/triplepad.png": "data:image/png;base64,A==="
                    }},
                    {"format": "supermd-smd", "version": 1, "markdown": "", "assets": {
                        "assets/huge.png": "data:image/png;base64," + over_25mb
                    }},
                    {"format": "supermd-smd", "version": 1, "markdown": "", "assets": {
                        f"assets/part{i}.png": "data:image/png;base64," + exact_25mb for i in range(4)
                    }},
                ):
                    with self.assertRaises(ValueError):
                        validate_envelope(invalid_envelope)
                self.assertEqual(spy.call_count, 0)

            # Untrusted validation entry points continue to run full base64.b64decode(..., validate=True).
            malformed = {"assets/bad.png": "data:image/png;base64,@@@@"}
            validate_envelope({"format": "supermd-smd", "version": 1, "markdown": "", "assets": malformed})
            with self.assertRaises(ValueError):
                validate({"format": "supermd-smd", "version": 1, "markdown": "", "assets": malformed})
            with self.assertRaises(ValueError):
                bundle("", malformed)
            with self.assertRaises(ValueError):
                write_portable(root / "bad.smd", "", malformed)
            with self.assertRaises(ValueError):
                write_portable(root / "bad2.smd", "", {**assets, **malformed}, validated_assets=assets)
            with self.assertRaises(ValueError):
                materialize_assets(root / "out", malformed)
            bad_smd = root / "corrupt-b64.smd"
            write_portable(bad_smd, "# text", malformed, validate_assets=False)
            self.assertEqual(read_note_markdown(bad_smd), "# text")
            with self.assertRaises(ValueError):
                open_note(bad_smd, decode_assets=True)

if __name__ == "__main__": unittest.main()
