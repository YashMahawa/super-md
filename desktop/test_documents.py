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

if __name__ == "__main__": unittest.main()
