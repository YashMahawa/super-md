import base64
import hashlib
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from agent_documents import AgentDocumentError, DocumentStore, RevisionConflict
from documents import atomic_write, compressed_bundle


class AgentDocumentsTest(unittest.TestCase):
    def test_source_and_revision_use_one_snapshot_during_external_replacement(self):
        from unittest.mock import patch
        path = self.root / "changing.md"
        original = b"# Original snapshot\n"
        path.write_bytes(original)
        read = self.store._read_raw
        def replace_after_read(target):
            snapshot = read(target)
            path.write_text("# New external content\n", encoding="utf-8")
            return snapshot
        with patch.object(self.store, "_read_raw", side_effect=replace_after_read):
            result = self.store.read("changing.md", view="source")
        self.assertEqual(result["text"], original.decode())
        self.assertEqual(result["revision"], hashlib.sha256(original).hexdigest())

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.store = DocumentStore([self.root])

    def tearDown(self):
        self.temp.cleanup()

    def test_bounded_inspect_and_page_read_exclude_svg_bytes(self):
        svg = (b"<svg xmlns='http://www.w3.org/2000/svg'><metadata>" + b"vector-safe" * 8000 + b"</metadata></svg>")
        source = "# Intro\n\n" + ("alpha beta gamma\n" * 3000) + "\n## End\nend\n"
        asset = "data:image/svg+xml;base64," + base64.b64encode(svg).decode("ascii")
        path = self.root / "vectors.smd"
        path.write_bytes(compressed_bundle(source, {"assets/vector.svg": asset}))

        info = self.store.inspect("vectors.smd")
        page = self.store.read("vectors.smd", offset=0, limit=211)
        asset_page = self.store.assets("vectors.smd")
        self.assertEqual(info["asset_count"], 1)
        self.assertEqual(asset_page["assets"][0]["bytes"], len(svg))
        self.assertEqual(page["text"], source[:211])
        self.assertNotIn(base64.b64encode(svg).decode(), json.dumps(info) + json.dumps(asset_page))
        self.assertLess(len(json.dumps(page)), 800)

    def test_prose_read_elides_large_fenced_svg_and_reports_exact_source_ranges(self):
        svg = "<svg>" + ("<path d='M0 0'/ >" * 15_000) + "</svg>"
        prefix = "# Figure\n```svg\n"
        after = "After the figure. " * 1500
        source = prefix + svg + "\n```\n" + after
        (self.root / "diagram.md").write_bytes(source.encode("utf-8"))
        prose = self.store.read("diagram.md", limit=12000)
        self.assertNotIn("<svg>", prose["text"])
        self.assertLessEqual(len(prose["text"]), 12_100)
        self.assertEqual(prose["start"], 0)
        omission = prose["svg_omissions"][0]
        self.assertEqual(omission["source_start"], len(prefix))
        self.assertEqual(omission["source_end"], len(prefix) + len(svg) + 1)
        self.assertEqual((omission["line_start"], omission["line_end"]), (3, 3))
        self.assertEqual(prose["end"], omission["source_end"] + 12000 - len(prefix))
        self.assertEqual(prose["next_offset"], prose["end"])
        next_page = self.store.read("diagram.md", offset=prose["next_offset"], limit=12000)
        self.assertNotIn("[SVG omitted:", next_page["text"])
        self.assertIn("After the figure.", next_page["text"])
        exact = self.store.read("diagram.md", limit=12000, view="source")
        self.assertIn("<svg>", exact["text"])
        self.assertEqual(exact["text"], source[:12000])
        self.assertEqual(exact["end"], 12000)

    def test_prose_svg_page_end_is_clamped_to_heading_section(self):
        svg = "<svg>" + ("<path/>" * 500) + "</svg>"
        source = "# Figure\n```svg\n" + svg + "\n```\n\n# Next\nNext section text.\n"
        (self.root / "heading.svg.md").write_bytes(source.encode("utf-8"))
        page = self.store.read("heading.svg.md", heading=0, limit=12000)
        heading_end = source.index("# Next")
        self.assertEqual(page["end"], heading_end)
        self.assertIsNone(page["next_offset"])
        self.assertIn("[SVG omitted:", page["text"])

    def test_crlf_source_offsets_preserve_the_exact_document_bytes(self):
        source = "# Figure\r\n```svg\r\n<svg><path/></svg>\r\n```\r\n\r\n# Next\r\nNext text.\r\n"
        (self.root / "windows.md").write_bytes(source.encode("utf-8"))
        exact = self.store.read("windows.md", view="source")
        self.assertEqual(exact["text"], source)
        self.assertEqual(exact["end"], len(source))
        page = self.store.read("windows.md", heading=0)
        self.assertEqual(page["end"], source.index("# Next"))
        self.assertEqual(page["svg_omissions"][0]["source_start"], source.index("<svg>"))

    def test_heading_read_search_and_line_patch_keep_exact_embedded_asset(self):
        svg = "<svg><text>Exact α</text></svg>".encode("utf-8")
        encoded = "data:image/svg+xml;base64," + base64.b64encode(svg).decode()
        source = "# Title\nfirst line\nsecond phrase\n\n## Child\nchild text\n"
        path = self.root / "edit.smd"
        path.write_bytes(compressed_bundle(source, {"assets/chart.svg": encoded}))
        before = self.store.inspect("edit.smd")["revision"]
        heading = self.store.read("edit.smd", heading=1)
        self.assertTrue(heading["text"].startswith("## Child"))
        found = self.store.search("edit.smd", "SECOND PHRASE")
        self.assertEqual(found["matches"][0]["line"], 3)
        result = self.store.patch("edit.smd", expected_revision=before, operations=[{
            "type": "lines", "start_line": 3, "end_line": 3, "text": "second updated\n",
        }])
        self.assertNotEqual(result["revision"], before)
        self.assertEqual(self.store.read("edit.smd", offset=0, limit=500)["text"], source.replace("second phrase", "second updated"))
        import documents
        markdown, assets, portable = documents.open_note(path)
        self.assertTrue(portable)
        self.assertEqual(markdown, source.replace("second phrase", "second updated"))
        self.assertEqual(base64.b64decode(assets["assets/chart.svg"].split(",", 1)[1]), svg)

    def test_stale_or_ambiguous_patch_refuses_without_changing_bytes(self):
        path = self.root / "plain.md"
        atomic_write(path, b"same same\n")
        old = self.store.inspect("plain.md")["revision"]
        with self.assertRaises(AgentDocumentError):
            self.store.patch("plain.md", expected_revision=old, operations=[{"type": "replace", "old": "same", "new": "x"}])
        self.assertEqual(path.read_bytes(), b"same same\n")
        old = self.store.inspect("plain.md")["revision"]
        atomic_write(path, b"external\n")
        with self.assertRaises(RevisionConflict):
            self.store.patch("plain.md", expected_revision=old, operations=[{"type": "replace", "old": "external", "new": "agent"}])
        self.assertEqual(path.read_bytes(), b"external\n")

    def test_creation_is_create_only_and_asset_extract_is_bounded_and_no_overwrite(self):
        self.store.create("new.md", "# New\n")
        with self.assertRaises(RevisionConflict):
            self.store.create("new.md", "must not replace")
        png = b"\x89PNG\r\n\x1a\nsmall test bytes"
        asset_file = self.root / "source.png"
        asset_file.write_bytes(png)
        unicode_asset = self.root / "图形 with space.svg"
        unicode_asset.write_bytes(b"<svg xmlns='http://www.w3.org/2000/svg'></svg>")
        portable = self.root / "portable.smd"
        self.store.create("portable.smd", "# Image\n")
        revision = self.store.inspect("portable.smd")["revision"]
        attached = self.store.attach_asset("portable.smd", "图形 with space.svg", expected_revision=revision)
        self.assertRegex(attached["asset"]["name"], r"^assets/[A-Za-z0-9._-]+\.svg$")
        revision = attached["revision"]
        attached = self.store.attach_asset("portable.smd", "source.png", expected_revision=revision)
        output = self.root / "extracted.png"
        extracted = self.store.extract_asset("portable.smd", attached["asset"]["name"], "extracted.png",
                                             expected_revision=attached["revision"])
        self.assertEqual(output.read_bytes(), png)
        self.assertEqual(extracted["sha256"], hashlib.sha256(png).hexdigest())
        with self.assertRaises(RevisionConflict):
            self.store.extract_asset("portable.smd", attached["asset"]["name"], "extracted.png",
                                     expected_revision=attached["revision"])

    def test_explicit_asset_read_returns_exact_bytes_only_for_current_revision(self):
        payload = "<svg xmlns='http://www.w3.org/2000/svg'><text>Σ</text></svg>".encode("utf-8")
        import base64
        data_url = "data:image/svg+xml;base64," + base64.b64encode(payload).decode("ascii")
        path = self.root / "asset.smd"
        path.write_bytes(compressed_bundle("# asset\n", {"assets/diagram.svg": data_url}))
        revision = self.store.inspect("asset.smd")["revision"]
        item = self.store.read_asset("asset.smd", "assets/diagram.svg", expected_revision=revision)
        self.assertEqual(item["mime_type"], "image/svg+xml")
        self.assertEqual(item["data"], payload)
        atomic_write(path, compressed_bundle("# changed\n", {"assets/diagram.svg": data_url}))
        with self.assertRaises(RevisionConflict):
            self.store.read_asset("asset.smd", "assets/diagram.svg", expected_revision=revision)

    def test_replace_asset_by_stable_id_preserves_markdown_and_every_other_asset(self):
        old_svg = b"<svg xmlns='http://www.w3.org/2000/svg'><circle r='1'/></svg>"
        new_svg = b"<svg xmlns='http://www.w3.org/2000/svg'><rect width='2'/></svg>"
        other_png = b"\x89PNG\r\n\x1a\nunchanged asset"
        make_data = lambda mime, data: f"data:{mime};base64," + base64.b64encode(data).decode("ascii")
        source = "# Diagram\n\n![diagram](assets/chart.svg)\n"
        path = self.root / "replace.smd"
        path.write_bytes(compressed_bundle(source, {
            "assets/chart.svg": make_data("image/svg+xml", old_svg),
            "assets/other.png": make_data("image/png", other_png),
        }))
        (self.root / "replacement.svg").write_bytes(new_svg)
        before = self.store.inspect("replace.smd")
        asset_id = next(item["id"] for item in before["assets"] if item["name"] == "assets/chart.svg")
        result = self.store.replace_asset("replace.smd", asset_id, "replacement.svg", expected_revision=before["revision"])
        import documents
        markdown, assets, portable = documents.open_note(path)
        self.assertTrue(result["saved"])
        self.assertTrue(portable)
        self.assertEqual(markdown, source)
        self.assertEqual(base64.b64decode(assets["assets/chart.svg"].split(",", 1)[1]), new_svg)
        self.assertEqual(assets["assets/other.png"], make_data("image/png", other_png))
        self.assertEqual(result["asset"]["id"], asset_id)
        current_revision = result["revision"]
        (self.root / "wrong-type.png").write_bytes(other_png)
        with self.assertRaises(AgentDocumentError):
            self.store.replace_asset("replace.smd", asset_id, "wrong-type.png", expected_revision=current_revision)
        self.assertEqual(self.store.inspect("replace.smd")["revision"], current_revision)
        with self.assertRaises(RevisionConflict):
            self.store.replace_asset("replace.smd", asset_id, "replacement.svg", expected_revision=before["revision"])
        self.assertEqual(self.store.inspect("replace.smd")["revision"], current_revision)

    def test_roots_symlinks_and_corrupt_smd_are_rejected(self):
        outside = self.root.parent / (self.root.name + "-outside.md")
        outside.write_text("private")
        try:
            with self.assertRaises(AgentDocumentError):
                self.store.inspect(str(outside))
            if hasattr(os, "symlink"):
                (self.root / "link.md").symlink_to(outside)
                with self.assertRaises(AgentDocumentError):
                    self.store.inspect("link.md")
            corrupt = self.root / "bad.smd"
            corrupt.write_bytes(b"\x1f\x8bnot a valid gzip")
            with self.assertRaises(AgentDocumentError):
                self.store.inspect("bad.smd")
        finally:
            outside.unlink(missing_ok=True)

    @unittest.skipUnless(os.name == "posix", "directory symlink root aliases require POSIX")
    def test_explicit_root_alias_accepts_absolute_paths_but_rejects_internal_links(self):
        real = self.root / "canonical"
        real.mkdir()
        workspace = real / "workspace"
        workspace.mkdir()
        (workspace / "note.md").write_text("# Aliased workspace\n", encoding="utf-8")
        alias = self.root / "alias"
        alias.symlink_to(real, target_is_directory=True)
        store = DocumentStore([alias / "workspace"])
        self.assertEqual(store.resolve(alias / "workspace/note.md"), workspace.resolve() / "note.md")
        self.assertEqual(store.resolve(alias / "workspace/new.md", must_exist=False), workspace.resolve() / "new.md")
        (workspace / "link.md").symlink_to(workspace / "note.md")
        with self.assertRaises(AgentDocumentError):
            store.resolve(alias / "workspace/link.md")
        (real / "outside.md").write_text("outside", encoding="utf-8")
        with self.assertRaises(AgentDocumentError):
            store.resolve(alias / "workspace/../outside.md")
        # An explicitly approved alias is bound to its original root, even
        # if another process later changes that symlink's destination.
        alias.unlink()
        other = self.root / "other"
        (other / "workspace").mkdir(parents=True)
        (other / "workspace/note.md").write_text("outside", encoding="utf-8")
        alias.symlink_to(other, target_is_directory=True)
        self.assertEqual(store.read(str(alias / "workspace/note.md"), view="source")["text"], "# Aliased workspace\n")

    def test_cli_is_headless_json_and_emits_no_startup_noise(self):
        path = self.root / "cli.md"
        path.write_text("# CLI\nhello\n", encoding="utf-8")
        code = "import sys; from agent_cli import main; raise SystemExit(main())"
        env = dict(os.environ, PYTHONPATH=str(Path(__file__).parent))
        result = subprocess.run([sys.executable, "-c", code, "--root", str(self.root), "inspect", "cli.md"],
                                capture_output=True, text=True, env=env, check=False)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stderr, "")
        parsed = json.loads(result.stdout)
        self.assertTrue(parsed["ok"])
        self.assertNotIn("PySide6", result.stdout)
        self.assertNotIn("PySide6", result.stderr)
        headless = subprocess.run([sys.executable, "-c",
                                   "import agent_cli,mcp_server,agent_live_client,sys; assert 'PySide6' not in sys.modules and 'mcp' not in sys.modules"],
                                  capture_output=True, text=True, env=env, check=False)
        self.assertEqual(headless.returncode, 0, headless.stderr)


if __name__ == "__main__":
    unittest.main()
