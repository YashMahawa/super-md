import unittest
from unittest.mock import patch
from material_color_utilities import get_contrast_ratio
from theme import detect_system_dark,tokens

class ThemeTest(unittest.TestCase):
    def test_unknown_qt_is_not_assumed_light(self):
        with patch("theme.subprocess.run") as run, patch("theme.sys.platform", "linux"):
            run.return_value.returncode = 0
            run.return_value.stdout = "'prefer-dark'"
            self.assertTrue(detect_system_dark("Unknown"))
    def test_all_semantic_text_pairs_pass_contrast(self):
        for mode in ("system","light","dark","black"):
            for system in (True,False,None):
                dark,colors = tokens(mode,system,{"primary":"#f7b99a","onPrimary":"#f7b99a","surface":"#130d0a","onSurface":"#130d0a","onSurfaceVariant":"#222222"},"dark")
                for foreground,background in [("text","surface"),("text","surface-high"),("muted","surface"),("muted","surface-high"),("on-primary","primary"),("on-primary-container","primary-container")]:
                    self.assertGreaterEqual(get_contrast_ratio(colors[foreground],colors[background]),4.5)
                if mode == "light": self.assertFalse(dark)
                if mode in ("dark","black"): self.assertTrue(dark)

if __name__ == "__main__": unittest.main()
