import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from material_color_utilities import get_contrast_ratio
import custom_theme
from theme import tokens

class CustomThemeTest(unittest.TestCase):
    def test_native_palette_protects_contrast_and_reader_keeps_optional_roles(self):
        _,base=tokens("dark",True)
        self.assertEqual(custom_theme.palette(base,{}),base)
        self.assertEqual(custom_theme.palette(base,{"heading":"#dddddd"}),base)
        colors=custom_theme.palette(base,{"surface":"#222222","surface-low":"#222222","surface-high":"#222222","text":"#222222","primary":"#222222","on-primary":"#222222"})
        for fg,bg in [("text","surface"),("muted","surface"),("primary","surface"),("on-primary","primary")]:self.assertGreaterEqual(get_contrast_ratio(colors[fg],colors[bg]),4.5)
        mixed=custom_theme.palette(base,{"surface":"#ffffff","surface-low":"#111111","surface-high":"#eeeeee"})
        for bg in ("surface","surface-low","surface-high"):self.assertGreaterEqual(get_contrast_ratio(mixed["text"],mixed[bg]),4.5)
        self.assertEqual(custom_theme.reader(custom_theme.TEMPLATE,"black",True)["colors"],{})
        self.assertEqual(custom_theme.reader(custom_theme.TEMPLATE,"dark",True)["background"]["pattern"],"dots")

    def test_engine_errors_are_not_interpreted_as_theme_data(self):
        with patch("custom_theme.subprocess.run") as run:
            run.return_value.stdout=json.dumps({"error":"Unknown field css"})
            with self.assertRaisesRegex(ValueError,"Unknown field"):custom_theme.validate("engine",'{}')
            run.return_value.stdout=json.dumps({"theme":custom_theme.TEMPLATE})
            self.assertEqual(custom_theme.validate("engine",'{}'),custom_theme.TEMPLATE)
            self.assertEqual(run.call_args.kwargs["timeout"],10)
            self.assertEqual(run.call_args.kwargs["encoding"],"utf-8")

    def test_theme_file_reads_are_bounded_before_decoding(self):
        with tempfile.TemporaryDirectory() as folder:
            path=Path(folder)/"theme.json";path.write_bytes(b" "*65537)
            with self.assertRaisesRegex(ValueError,"64 KB"):custom_theme.read("engine",path)
