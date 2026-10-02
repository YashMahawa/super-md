import base64
import json
import os
import stat
import tempfile
import unittest
from pathlib import Path
from documents import atomic_write, bundle, materialize_assets, open_note, validate

class DocumentsTest(unittest.TestCase):
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
    @unittest.skipUnless(hasattr(os,"fchmod"),"Unix permissions")
    def test_atomic_save_preserves_file_permissions(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory)/"note.md"
            atomic_write(path,b"old")
            path.chmod(0o640)
            atomic_write(path,b"new")
            self.assertEqual(stat.S_IMODE(path.stat().st_mode),0o640)

if __name__ == "__main__": unittest.main()
