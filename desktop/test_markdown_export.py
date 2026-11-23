import base64
import tempfile
import unittest
from pathlib import Path

from markdown_export import write_markdown_export, write_markdown_zip


class MarkdownExportTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="supermd-markdown-export-")
        self.root = Path(self.temp.name)

    def tearDown(self):
        self.temp.cleanup()

    def test_writes_gif_and_svg_raster_assets_under_safe_relative_paths(self):
        gif = base64.b64decode("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7")
        self.assertTrue(gif.startswith(b"GIF89a"))
        svg = b"<svg xmlns='http://www.w3.org/2000/svg'><text>source</text></svg>"
        write_markdown_export(self.root / "note.md", "# Export\n![gif](media/loop.gif)\n", {
            "media/loop.gif": "data:image/gif;base64," + base64.b64encode(gif).decode(),
            "diagrams/source.svg": "data:image/svg+xml;base64," + base64.b64encode(svg).decode(),
        })
        self.assertEqual((self.root / "note.md").read_text(encoding="utf-8"), "# Export\n![gif](media/loop.gif)\n")
        self.assertEqual((self.root / "media/loop.gif").read_bytes(), gif)
        self.assertEqual((self.root / "diagrams/source.svg").read_bytes(), svg)

    def test_reuses_identical_assets_and_rejects_conflicts_without_overwrite(self):
        path = self.root / "images/cover.png"
        path.parent.mkdir()
        path.write_bytes(b"existing")
        data = "data:image/png;base64," + base64.b64encode(b"existing").decode()
        write_markdown_export(self.root / "note.md", "ok", {"images/cover.png": data})
        self.assertEqual(path.read_bytes(), b"existing")
        with self.assertRaisesRegex(FileExistsError, "different contents"):
            write_markdown_export(self.root / "other.md", "should not publish", {
                "images/cover.png": "data:image/png;base64," + base64.b64encode(b"replacement").decode(),
            })
        self.assertFalse((self.root / "other.md").exists())
        self.assertEqual(path.read_bytes(), b"existing")

    def test_rejects_path_traversal_and_symlinks(self):
        data = "data:image/png;base64," + base64.b64encode(b"image").decode()
        with self.assertRaisesRegex(ValueError, "traversal"):
            write_markdown_export(self.root / "note.md", "", {"../outside.png": data})
        outside = self.root / "outside"
        outside.mkdir()
        (self.root / "media").symlink_to(outside, target_is_directory=True)
        with self.assertRaisesRegex(ValueError, "symlink"):
            write_markdown_export(self.root / "note.md", "", {"media/asset.png": data})
        self.assertFalse((outside / "asset.png").exists())

    def test_enforces_asset_count_and_data_url_mime(self):
        with self.assertRaisesRegex(ValueError, "valid image data"):
            write_markdown_export(self.root / "note.md", "", {"x.png": "not-an-image"})

    def test_zip_contains_markdown_and_relative_gif_assets_without_changing_source(self):
        import zipfile
        source = self.root / "note.smd"
        original = b"source note bytes"
        source.write_bytes(original)
        gif = base64.b64decode("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7")
        output = self.root / "export.zip"
        write_markdown_zip(output, "![Loop](images/loop.gif)\n", {
            "images/loop.gif": "data:image/gif;base64," + base64.b64encode(gif).decode(),
        })
        with zipfile.ZipFile(output) as archive:
            self.assertEqual(set(archive.namelist()), {"export.md", "images/loop.gif"})
            self.assertEqual(archive.read("export.md"), b"![Loop](images/loop.gif)\n")
            self.assertEqual(archive.read("images/loop.gif"), gif)
        self.assertEqual(source.read_bytes(), original)


if __name__ == "__main__":
    unittest.main()
