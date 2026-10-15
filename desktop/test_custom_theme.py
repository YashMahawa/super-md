import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from material_color_utilities import get_contrast_ratio
import custom_theme
from theme import tokens

class CustomThemeTest(unittest.TestCase):
    def test_component_roles_and_metrics_survive_native_reader_and_theme_sharing(self):
        document={**custom_theme.TEMPLATE,"variants":{"light":{"colors":{"python-bg":"#172a31","table-header-bg":"#314e40","table-border":"#807251"}}},"metrics":{"pythonRadius":16,"tableBorderWidth":2,"pythonSourceMaxHeight":24}}
        before=json.dumps(document)
        style=custom_theme.reader(document,"light",False)
        self.assertEqual(style['colors'],document['variants']['light']['colors']);self.assertEqual(style['metrics'],document['metrics'])
        self.assertEqual(custom_theme.for_sharing(document,{})['metrics'],document['metrics']);self.assertEqual(json.dumps(document),before)
    def test_background_controls_do_not_mutate_theme_or_override_reading_layout(self):
        before=json.dumps(custom_theme.TEMPLATE)
        style=custom_theme.reader(custom_theme.TEMPLATE,"light",False,{"patternKind":"paws","patternOpacity":0,"patternSize":32,"patternSpacing":96})
        self.assertEqual(style["background"],{"pattern":"paws","color":"#7255a5","opacity":0,"size":32,"spacing":96,"angle":0})
        self.assertEqual(json.dumps(custom_theme.TEMPLATE),before)
        exported=custom_theme.for_sharing(custom_theme.TEMPLATE,{"patternKind":"paws","patternOpacity":.1,"patternSize":32,"patternSpacing":96})
        self.assertEqual(exported["variants"]["dark"]["background"]["pattern"],"paws")
        self.assertEqual(exported["variants"]["light"]["background"]["size"],32)
        self.assertEqual(json.dumps(custom_theme.TEMPLATE),before)
        self.assertIsNone(custom_theme.reader(None,"light",False,{"patternKind":"paws"})["background"])
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
            self.assertEqual(run.call_args.kwargs["creationflags"],getattr(custom_theme.subprocess,"CREATE_NO_WINDOW",0))

    def test_theme_file_reads_are_bounded_before_decoding(self):
        with tempfile.TemporaryDirectory() as folder:
            path=Path(folder)/"theme.json";path.write_bytes(b" "*(custom_theme.MAX_THEME+1))
            with self.assertRaisesRegex(ValueError,"2 MB"):custom_theme.read("engine",path)

    def test_shared_assets_resolve_for_paint_but_stay_deduplicated_for_export(self):
        theme={**custom_theme.TEMPLATE,"assets":{"portrait":"data:image/png;base64,example"},"variants":{"dark":{"artwork":{"reader":{"image":"asset:portrait","position":"right","opacity":.1},"toolbar":{"image":"asset:portrait"}}}}}
        before=json.dumps(theme)
        style=custom_theme.reader(theme,"dark",True)
        self.assertEqual(style["artwork"]["reader"]["image"],theme["assets"]["portrait"])
        self.assertEqual(style["artwork"]["reader"]["position"],"right")
        self.assertNotIn("toolbar",style["artwork"])
        exported=custom_theme.for_sharing(theme,{"patternOpacity":.12})
        self.assertEqual(exported["assets"],theme["assets"])
        self.assertEqual(exported["variants"]["dark"]["artwork"]["reader"]["image"],"asset:portrait")
        self.assertEqual(json.dumps(theme),before)
