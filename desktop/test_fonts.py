import base64
import os
import tempfile
import unittest
from pathlib import Path
os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
from PySide6.QtGui import QGuiApplication
from fonts import FontStore

class FontImportTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.app=QGuiApplication.instance() or QGuiApplication(["Font import tests"])

    def test_private_import_survives_restart_and_supplies_identical_pdf_bytes(self):
        original=Path(__file__).parent.parent / "smd-core/fonts/Manrope.ttf"
        with tempfile.TemporaryDirectory(prefix="supermd-font-test-") as temporary:
            store=FontStore(temporary)
            family=store.import_file(original)
            self.assertEqual(family,"Manrope")
            reader=store.reader(family)
            self.assertEqual(base64.b64decode(reader["data"].split(",",1)[1]),original.read_bytes())
            restored=FontStore(temporary)
            self.assertEqual(len(restored.families[family]),1)
            self.assertEqual(base64.b64decode(next(iter(restored.pdf_assets(family).values()))),original.read_bytes())
            store.import_file(original)
            self.assertEqual(len(store.families[family]),1)

    def test_invalid_font_is_rejected_without_creating_library_entries(self):
        with tempfile.TemporaryDirectory(prefix="supermd-font-test-") as temporary:
            bad=Path(temporary)/"not-font.ttf";bad.write_bytes(b"not a font")
            store=FontStore(temporary)
            with self.assertRaises(ValueError):store.import_file(bad)
            self.assertEqual(store.families,{})
