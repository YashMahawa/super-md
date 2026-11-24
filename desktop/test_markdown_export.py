import base64
import os
import stat
import tempfile
import unittest
import zipfile
from pathlib import Path
from unittest import mock

import markdown_export
from markdown_export import MAX_ASSETS, write_markdown_export, write_markdown_zip


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

    def test_create_only_creates_new_outputs_and_rejects_existing_targets(self):
        gif = base64.b64decode("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7")
        gif_url = "data:image/gif;base64," + base64.b64encode(gif).decode()

        note = self.root / "note.md"
        write_markdown_export(note, "# Initial\n", {}, create_only=True)
        self.assertEqual(note.read_text(encoding="utf-8"), "# Initial\n")
        with self.assertRaisesRegex(FileExistsError, r"Markdown output already exists: note\.md"):
            write_markdown_export(note, "# Replacement\n", {"media/loop.gif": gif_url}, create_only=True)
        self.assertEqual(note.read_text(encoding="utf-8"), "# Initial\n")
        self.assertFalse((self.root / "media/loop.gif").exists())

        archive_path = self.root / "export.zip"
        write_markdown_zip(archive_path, "# Initial ZIP\n", {}, create_only=True, markdown_filename="custom.md")
        with zipfile.ZipFile(archive_path) as archive:
            self.assertEqual(archive.namelist(), ["custom.md"])
            self.assertEqual(archive.read("custom.md"), b"# Initial ZIP\n")
        with self.assertRaisesRegex(FileExistsError, r"ZIP output already exists: export\.zip"):
            write_markdown_zip(archive_path, "# Replacement ZIP\n", {"media/loop.gif": gif_url}, create_only=True)
        with zipfile.ZipFile(archive_path) as archive:
            self.assertEqual(archive.read("custom.md"), b"# Initial ZIP\n")
        self.assertEqual(list(self.root.glob(".*.stage")), [])

    def test_preserves_writer_specific_symlink_and_validation_order(self):
        gif = base64.b64decode("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7")
        gif_url = "data:image/gif;base64," + base64.b64encode(gif).decode()

        real_md = self.root / "real.md"
        real_md.write_bytes(b"original-md")
        symlink_md = self.root / "symlink.md"
        symlink_md.symlink_to(real_md)
        with self.assertRaisesRegex(ValueError, "Refusing to write Markdown through a symlink"):
            write_markdown_export(symlink_md, "overwrite", {"bad.png": "not-an-image"})
        self.assertEqual(real_md.read_bytes(), b"original-md")

        late_target = self.root / "late.md"
        real_fsync = os.fsync

        def inject_symlink_after_sidecar(fd: int) -> None:
            real_fsync(fd)
            if not late_target.is_symlink():
                late_target.symlink_to(real_md)

        with mock.patch.object(markdown_export.os, "fsync", side_effect=inject_symlink_after_sidecar):
            with self.assertRaisesRegex(ValueError, "Refusing to write Markdown through a symlink"):
                write_markdown_export(late_target, "overwrite", {"media/loop.gif": gif_url})
        self.assertFalse((self.root / "media/loop.gif").exists())
        self.assertEqual(real_md.read_bytes(), b"original-md")

        real_zip = self.root / "real.zip"
        real_zip.write_bytes(b"original-zip")
        symlink_zip = self.root / "symlink.zip"
        symlink_zip.symlink_to(real_zip)
        with self.assertRaisesRegex(ValueError, "valid image data URLs"):
            write_markdown_zip(symlink_zip, "overwrite", {"bad.png": "not-an-image"})
        with self.assertRaisesRegex(ValueError, "Refusing to write a ZIP through a symlink"):
            write_markdown_zip(symlink_zip, "overwrite", {})
        self.assertEqual(real_zip.read_bytes(), b"original-zip")

    def test_enforces_content_and_asset_size_bounds(self):
        gif = base64.b64decode("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7")
        gif_url = "data:image/gif;base64," + base64.b64encode(gif).decode()
        oversized_utf8 = "é" * 10_000_001
        too_many_assets = {f"img-{index}.gif": gif_url for index in range(MAX_ASSETS + 1)}

        for writer, target in (
            (write_markdown_export, self.root / "note.md"),
            (write_markdown_zip, self.root / "note.zip"),
        ):
            with self.assertRaisesRegex(ValueError, "under 20 MB"):
                writer(target, oversized_utf8, {})
            with self.assertRaisesRegex(ValueError, "under 20 MB"):
                writer(target, None, {})  # type: ignore[arg-type]
            with self.assertRaisesRegex(ValueError, "assets are invalid"):
                writer(target, "ok", None)
            with self.assertRaisesRegex(ValueError, "assets are invalid"):
                writer(target, "ok", too_many_assets)
            with self.assertRaisesRegex(ValueError, "MIME does not match"):
                writer(target, "ok", {"media/mismatch.png": gif_url})
            with mock.patch.object(markdown_export, "MAX_IMAGE", len(gif) - 1):
                with self.assertRaisesRegex(ValueError, "exceeds 25 MB"):
                    writer(target, "ok", {"media/loop.gif": gif_url})
            with mock.patch.object(markdown_export, "MAX_ASSET_TOTAL", len(gif) * 2 - 1):
                with self.assertRaisesRegex(ValueError, "bounded total size"):
                    writer(target, "ok", {"media/a.gif": gif_url, "media/b.gif": gif_url})
            self.assertFalse(target.exists())

    def test_rolls_back_created_sidecars_and_stage_files_when_staging_fails(self):
        gif = base64.b64decode("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7")
        gif_url = "data:image/gif;base64," + base64.b64encode(gif).decode()
        kept = self.root / "media/kept.gif"
        kept.parent.mkdir(parents=True)
        kept.write_bytes(gif)

        with mock.patch.object(markdown_export.os, "replace", side_effect=OSError("publish failed")):
            with self.assertRaisesRegex(OSError, "publish failed"):
                write_markdown_export(self.root / "note.md", "# Rollback\n", {
                    "media/kept.gif": gif_url,
                    "media/created.gif": gif_url,
                })
            with self.assertRaisesRegex(OSError, "publish failed"):
                write_markdown_zip(self.root / "note.zip", "# Rollback\n", {"media/created.gif": gif_url})

        self.assertEqual(kept.read_bytes(), gif)
        self.assertFalse((self.root / "media/created.gif").exists())
        self.assertFalse((self.root / "note.md").exists())
        self.assertFalse((self.root / "note.zip").exists())
        self.assertEqual(list(self.root.glob(".*.stage")), [])

    def test_fchmod_runs_only_when_overwriting_existing_markdown_file(self):
        real_fchmod = getattr(os, "fchmod", None)
        with mock.patch.object(
            markdown_export.os,
            "fchmod",
            wraps=real_fchmod,
            create=True,
        ) as fchmod_mock:
            fresh_md = self.root / "fresh.md"
            write_markdown_export(fresh_md, "first", {})
            fchmod_mock.assert_not_called()

            fresh_md.chmod(0o644)
            expected_mode = stat.S_IMODE(fresh_md.stat().st_mode)
            write_markdown_export(fresh_md, "second", {})
            fchmod_mock.assert_called_once_with(mock.ANY, expected_mode)
            if real_fchmod is not None:
                self.assertEqual(stat.S_IMODE(fresh_md.stat().st_mode), expected_mode)

            fchmod_mock.reset_mock()
            existing_zip = self.root / "existing.zip"
            write_markdown_zip(existing_zip, "first", {})
            write_markdown_zip(existing_zip, "second", {})
            fchmod_mock.assert_not_called()


if __name__ == "__main__":
    unittest.main()
