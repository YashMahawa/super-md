import base64
import hashlib
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from agent_documents import (
    AgentDocumentError,
    DocumentStore,
    RevisionConflict,
    _headings,
    diagram_spans,
    outline_source,
    resolve_heading,
    search_source,
    section_source,
)
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

    def test_prose_page_reports_only_intersecting_svg_omissions_and_exact_returned_chars(self):
        first = "<svg><text>first</text></svg>"
        second = "<svg><text>second</text></svg>"
        source = "```svg\n" + first + "\n```\n" + ("prose line\n" * 20) + "```svg\n" + second + "\n```\n"
        (self.root / "two-diagrams.md").write_bytes(source.encode("utf-8"))
        page = self.store.read("two-diagrams.md", limit=20)
        self.assertEqual(page["returned_chars"], len(page["text"]))
        self.assertEqual(len(page["svg_omissions"]), 1)
        self.assertLess(page["svg_omissions"][0]["source_start"], page["end"])
        self.assertGreater(page["svg_omissions"][0]["source_end"], page["start"])

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
        svg = "<svg><text>Exact α</text></svg>".encode()
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

    def test_heading_selection_paginates_nested_numbered_sections_and_uses_code_points(self):
        source = ("😀 Preamble\n# Intro\n\n## 7.4 Methods\nA paragraph with details.\n"
                  "### Nested\nNested content stays in the parent section.\n## 7.40 Other\nOther section.\n")
        path = self.root / "numbered-sections.md"
        path.write_bytes(source.encode("utf-8"))
        start = len(source[:source.index("## 7.4 Methods")])
        finish = len(source[:source.index("## 7.40 Other")])
        page = self.store.read("numbered-sections.md", heading="7.4", limit=32, view="source")
        combined = page["text"]
        self.assertEqual(page["start"], start)
        self.assertEqual(page["sectionStart"], start)
        self.assertEqual(page["sectionEnd"], finish)
        self.assertEqual(page["documentLength"], len(source))
        self.assertTrue(page["truncated"])
        while page["next_offset"] is not None:
            page = self.store.read("numbered-sections.md", heading="7.4 Methods",
                                   offset=page["next_offset"], limit=32, view="source")
            combined += page["text"]
            self.assertEqual((page["sectionStart"], page["sectionEnd"]), (start, finish))
        self.assertEqual(combined, source[start:finish])
        self.assertIn("### Nested", combined)
        self.assertNotIn("7.40 Other", combined)
        selected = section_source(source, "7.4")
        self.assertEqual(selected["text"], source[start:finish])
        self.assertEqual((selected["sectionStart"], selected["sectionEnd"], selected["documentLength"]),
                         (start, finish, len(source)))
        self.assertEqual(self.store.read("numbered-sections.md", heading="7-4-methods")["sectionStart"], start)
        self.assertEqual(self.store.read("numbered-sections.md", heading=2)["sectionStart"],
                         len(source[:source.index("### Nested")]))
        numbered = self.store.read("numbered-sections.md", heading="7.40", view="source")
        self.assertEqual(numbered["sectionStart"], finish)

    def test_heading_resolver_reports_ambiguity_without_fuzzy_selection(self):
        source = "".join(f"# Duplicate\nEntry {index}\n" for index in range(8)) + "```md\n# Hidden\n```\n"
        headings = outline_source(source)["headings"]
        with self.assertRaisesRegex(AgentDocumentError, r"ambiguous \(8 matches\).*0: Duplicate.*; …"):
            resolve_heading(headings, "Duplicate")
        with self.assertRaisesRegex(AgentDocumentError, "No heading matches"):
            resolve_heading(headings, "Duplcate")
        self.assertFalse(any(item["title"] == "Hidden" for item in headings))
        numbered = _headings("# 2. Findings\nTop\n## 2.1 Child\nNested\n# 20. Other\nOther\n", include_internal=True)
        self.assertEqual(resolve_heading(numbered, "2")["title"], "2. Findings")

    def test_pure_outline_pages_include_section_bounds_and_document_length(self):
        source = "".join(f"# Section {index}\nBody {index}\n" for index in range(85))
        first = outline_source(source)
        last = outline_source(source, 80, 5)
        self.assertEqual(first["total"], 85)
        self.assertEqual(first["nextOffset"], 80)
        self.assertTrue(first["truncated"])
        self.assertEqual([item["title"] for item in last["headings"]],
                         [f"Section {index}" for index in range(80, 85)])
        self.assertEqual(last["headings"][0]["sectionStart"], last["headings"][0]["start"])
        self.assertEqual(last["headings"][0]["sectionEnd"], last["headings"][1]["sectionStart"])
        self.assertEqual(last["documentLength"], len(source))
        self.assertIsNone(last["nextOffset"])
        self.assertFalse(last["truncated"])

    def test_read_pages_repeat_heading_selector_and_stop_at_next_section(self):
        body = "Body 🧭 stays in this section.\n" * 600
        source = f"# Intro\n## Long Section\n{body}## Next Section\nDo not include this text.\n"
        path = self.root / "long-section.md"
        path.write_bytes(source.encode("utf-8"))
        first = self.store.read(path.name, heading="Long Section", limit=12_000, view="source")
        self.assertEqual(first["start"], len(source[:source.index("## Long Section")]))
        self.assertEqual(first["returned_chars"], 12_000)
        self.assertTrue(first["truncated"])
        second = self.store.read(path.name, heading="Long Section", offset=first["next_offset"],
                                 limit=12_000, view="source")
        self.assertEqual(second["start"], first["next_offset"])
        self.assertEqual((second["sectionStart"], second["sectionEnd"]),
                         (first["sectionStart"], first["sectionEnd"]))
        self.assertIsNone(second["next_offset"])
        self.assertFalse(second["truncated"])
        self.assertIn("Body 🧭", second["text"])
        self.assertNotIn("Do not include this text.", second["text"])

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

    def test_patch_validation_insert_summaries_and_expected_counts(self):
        path = self.root / "patch-contract.md"
        path.write_bytes("😀 one\none one\n".encode())
        revision = self.store.inspect("patch-contract.md")["revision"]
        result = self.store.patch("patch-contract.md", expected_revision=revision, operations=[
            {"type": "replace", "old": "one", "new": "two", "expectedCount": 3},
            {"type": "insert", "line": 2, "text": "middle\n"},
        ])
        self.assertEqual(result["applied"], 2)
        self.assertEqual(result["operation_results"], [
            {"operationIndex": 0, "type": "replace", "startOffset": 2, "endOffset": 13, "deltaChars": 0},
            {"operationIndex": 1, "type": "insert", "startOffset": 6, "endOffset": 6, "deltaChars": 7},
        ])
        self.assertEqual(self.store.read("patch-contract.md", view="source")["text"], "😀 two\nmiddle\ntwo two\n")
        current = self.store.inspect("patch-contract.md")["revision"]
        with self.assertRaisesRegex(AgentDocumentError, r"operations\[0\].*Unknown field 'startLine'"):
            self.store.patch("patch-contract.md", expected_revision=current, operations=[
                {"type": "lines", "start_line": 1, "end_line": 1, "startLine": 1, "text": "x"},
            ])
        with self.assertRaisesRegex(AgentDocumentError, r"operations\[0\].*found 3"):
            self.store.patch("patch-contract.md", expected_revision=current, operations=[
                {"type": "replace", "old": "two", "new": "x", "count": "all", "expectedCount": 4},
            ])
        append = self.root / "append-line.md"
        append.write_text("one", encoding="utf-8")
        revision = self.store.inspect("append-line.md")["revision"]
        self.store.patch("append-line.md", expected_revision=revision,
                         operations=[{"type": "insert", "line": 2, "text": "two"}])
        self.assertEqual(self.store.read("append-line.md", view="source")["text"], "one\ntwo")

    def test_search_pagination_unicode_word_filters_diagrams_and_safe_regex(self):
        path = self.root / "search-contract.md"
        source = "😀 Ward afterward\n```mermaid\nWard --> X\n```\nward ward"
        path.write_bytes(source.encode("utf-8"))
        first = self.store.search("search-contract.md", "ward", limit=2, context=0)
        self.assertEqual([item["matchOffset"] for item in first["matches"]], [2, 12])
        self.assertEqual(first["totalMatches"], 5)
        self.assertEqual(first["remainingMatches"], 5)
        self.assertEqual(first["nextOffset"], 16)
        second = self.store.search("search-contract.md", "ward", limit=2, context=0,
                                   offset=first["nextOffset"], case_sensitive=True,
                                   whole_word=True, exclude_diagrams=True)
        self.assertEqual([item["matchOffset"] for item in second["matches"]], [43, 48])
        self.assertEqual(second["totalMatches"], 2)
        self.assertEqual(second["remainingMatches"], 2)
        self.assertIsNone(second["nextOffset"])
        self.assertFalse(second["truncated"])
        self.assertEqual(second["matches"][0]["snippetOffset"], 43)
        regex = self.store.search("search-contract.md", "w.r", regex=True, case_sensitive=True, context=0)
        self.assertEqual(regex["totalMatches"], 3)
        with self.assertRaisesRegex(AgentDocumentError, "quantifiers"):
            self.store.search("search-contract.md", "w.+d", regex=True)
        direct = search_source(source, "ward", 2, 0, 16, True, True, False, True)
        self.assertEqual(direct["matches"], second["matches"])
        braced = "Lead token\n```{.mermaid, fig-width=6}\ntoken --> B\n```\ntrailing token"
        braced_hits = search_source(braced, "token", 10, 0, 0, False, True, False, True)
        self.assertEqual([item["matchOffset"] for item in braced_hits["matches"]], [5, 63])
        span = diagram_spans(source)[0]
        self.assertEqual(source[span["start"]:span["end"]], "Ward --> X\n")

    def test_search_total_matches_is_stable_across_pages_and_exhausted_offsets(self):
        path = self.root / "search-pagination.md"
        source = "x " * 30
        path.write_bytes(source.encode("utf-8"))
        first = self.store.search("search-pagination.md", "x", limit=25, context=0)
        self.assertEqual(len(first["matches"]), 25)
        self.assertEqual(first["totalMatches"], 30)
        self.assertEqual(first["remainingMatches"], 30)
        self.assertTrue(first["truncated"])
        second = self.store.search("search-pagination.md", "x", limit=25, context=0,
                                  offset=first["nextOffset"])
        self.assertEqual(len(second["matches"]), 5)
        self.assertEqual(second["totalMatches"], 30)
        self.assertEqual(second["remainingMatches"], 5)
        self.assertFalse(second["truncated"])
        self.assertIsNone(second["nextOffset"])
        exhausted = search_source(source, "x", 25, 0, len(source))
        self.assertEqual(exhausted["matches"], [])
        self.assertEqual(exhausted["totalMatches"], 30)
        self.assertEqual(exhausted["remainingMatches"], 0)
        self.assertFalse(exhausted["truncated"])
        self.assertIsNone(exhausted["nextOffset"])

    def test_creation_is_create_only_and_asset_extract_is_bounded_and_no_overwrite(self):
        self.store.create("new.md", "# New\n")
        with self.assertRaises(RevisionConflict):
            self.store.create("new.md", "must not replace")
        png = b"\x89PNG\r\n\x1a\nsmall test bytes"
        asset_file = self.root / "source.png"
        asset_file.write_bytes(png)
        unicode_asset = self.root / "图形 with space.svg"
        unicode_asset.write_bytes(b"<svg xmlns='http://www.w3.org/2000/svg'></svg>")
        self.store.create("portable.smd", "# Image\n")
        revision = self.store.inspect("portable.smd")["revision"]
        attached = self.store.attach_asset("portable.smd", "图形 with space.svg", expected_revision=revision)
        self.assertRegex(attached["asset"]["name"], r"^assets/[A-Za-z0-9._-]+\.svg$")
        revision = attached["revision"]
        for bad_name in ("a" * 147 + ".png", "a" * 155 + ".png", "a" * 147, ".", ".."):
            with self.assertRaisesRegex(AgentDocumentError, "simple filename"):
                self.store.attach_asset("portable.smd", "source.png", expected_revision=revision, name=bad_name)
        max_attached = self.store.attach_asset("portable.smd", "source.png", expected_revision=revision, name="a" * 146 + ".png")
        revision = max_attached["revision"]
        attached = self.store.attach_asset("portable.smd", "source.png", expected_revision=revision)
        output = self.root / "extracted.png"
        extracted = self.store.extract_asset("portable.smd", attached["asset"]["name"], "extracted.png",
                                             expected_revision=attached["revision"])
        self.assertEqual(output.read_bytes(), png)
        self.assertEqual(extracted["sha256"], hashlib.sha256(png).hexdigest())
        with self.assertRaises(RevisionConflict):
            self.store.extract_asset("portable.smd", attached["asset"]["name"], "extracted.png",
                                     expected_revision=attached["revision"])

    def test_existing_151_to_159_char_bundle_opens_exports_and_resaves_without_losing_asset_or_reference(self):
        from agent_exports import export_pdf, export_smd, find_engine
        from markdown_export import write_markdown_export, write_markdown_zip
        import zipfile

        svg_bytes = b"<svg xmlns='http://www.w3.org/2000/svg' width='32' height='16'><rect width='32' height='16' fill='#386a57'/></svg>"
        svg_url = "data:image/svg+xml;base64," + base64.b64encode(svg_bytes).decode("ascii")
        compat_key = "assets/" + ("a" * 155) + ".svg"
        self.assertEqual(len(compat_key.removeprefix("assets/")), 159)
        markdown = f"# Legacy Bundle\n\n![Diagram](<{compat_key}>)\n"
        legacy_path = self.root / "legacy.smd"
        legacy_path.write_bytes(compressed_bundle(markdown, {compat_key: svg_url}))

        # 1. Open and inspect existing bundle with 159-char basename.
        info = self.store.inspect("legacy.smd")
        self.assertEqual(info["asset_count"], 1)
        read_res = self.store.read("legacy.smd", view="source")
        self.assertEqual(read_res["text"], markdown)
        asset_res = self.store.read_asset("legacy.smd", compat_key, expected_revision=info["revision"])
        self.assertEqual(asset_res["data"], svg_bytes)

        # 2. Export existing bundle to portable .smd, Markdown + companion folder, Markdown ZIP, and PDF.
        export_smd(self.store, "legacy.smd", "exported-copy.smd")
        exported_md, exported_assets, exported_portable = self.store._load(self.root / "exported-copy.smd")[:3]
        self.assertTrue(exported_portable)
        self.assertEqual(exported_md, markdown)
        self.assertEqual(exported_assets, {compat_key: svg_url})

        md_dir = self.root / "md-export"
        md_dir.mkdir()
        write_markdown_export(md_dir / "legacy.md", markdown, {compat_key: svg_url})
        self.assertEqual((md_dir / "legacy.md").read_text(encoding="utf-8"), markdown)
        self.assertEqual((md_dir / compat_key).read_bytes(), svg_bytes)

        zip_path = self.root / "legacy-export.zip"
        write_markdown_zip(zip_path, markdown, {compat_key: svg_url})
        with zipfile.ZipFile(zip_path) as archive:
            self.assertEqual(archive.read("legacy-export.md").decode("utf-8"), markdown)
            self.assertEqual(archive.read(compat_key), svg_bytes)

        try:
            engine = find_engine()
        except AgentDocumentError:
            engine = None
        if engine is not None:
            export_pdf(self.store, "legacy.smd", "legacy.pdf", engine=engine)
            self.assertTrue((self.root / "legacy.pdf").read_bytes().startswith(b"%PDF-"))

        # 3. Edit and re-save existing bundle without losing its 159-char asset or Markdown reference.
        patched = self.store.patch(
            "legacy.smd",
            expected_revision=info["revision"],
            operations=[{"type": "replace", "old": "# Legacy Bundle", "new": "# Legacy Bundle\n\nRe-saved note body."}],
        )
        reopened_text = self.store.read("legacy.smd", view="source")["text"]
        self.assertIn(f"![Diagram](<{compat_key}>)", reopened_text)
        self.assertIn("Re-saved note body.", reopened_text)
        reopened_asset = self.store.read_asset("legacy.smd", compat_key, expected_revision=patched["revision"])
        self.assertEqual(reopened_asset["data"], svg_bytes)

    def test_explicit_asset_read_returns_exact_bytes_only_for_current_revision(self):
        payload = "<svg xmlns='http://www.w3.org/2000/svg'><text>Σ</text></svg>".encode()
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
                                capture_output=True, text=True, encoding="utf-8", errors="strict", env=env, check=False)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stderr, "")
        parsed = json.loads(result.stdout)
        self.assertTrue(parsed["ok"])
        self.assertNotIn("PySide6", result.stdout)
        self.assertNotIn("PySide6", result.stderr)
        headless = subprocess.run([sys.executable, "-c",
                                   "import agent_cli,mcp_server,agent_live_client,sys; assert 'PySide6' not in sys.modules and 'mcp' not in sys.modules"],
                                  capture_output=True, text=True, encoding="utf-8", errors="strict", env=env, check=False)
        self.assertEqual(headless.returncode, 0, headless.stderr)

    def test_text_operations_skip_asset_decoding_and_reuse_stat_verified_envelope_cache(self):
        from unittest.mock import patch

        import documents

        png = b"\x89PNG\r\n\x1a\n" + (b"raster-bytes-" * 200)
        assets = {
            f"assets/fig_{i}.png": "data:image/png;base64," + base64.b64encode(png + bytes([i])).decode("ascii")
            for i in range(6)
        }
        prose = "".join(f"# Section {i}\n" + (f"Paragraph {i} searchable token.\n" * 60) for i in range(12))
        note = self.root / "paged.smd"
        packed = compressed_bundle(prose, assets)
        note.write_bytes(packed)

        with (
            patch("documents.base64.b64decode", wraps=base64.b64decode) as b64_spy,
            patch("documents._gzip_json_input", wraps=documents._gzip_json_input) as gzip_spy,
        ):
            cursor = 0
            for _ in range(10):
                page = self.store.read("paged.smd", offset=cursor, limit=1500)
                cursor = page["next_offset"] or 0
            found = self.store.search("paged.smd", "searchable token", limit=5)
            outline = self.store.outline("paged.smd", offset=0, limit=10)
            markdown = self.store.read_markdown("paged.smd")
            self.assertEqual(b64_spy.call_count, 0)
            self.assertEqual(gzip_spy.call_count, 1)
            self.assertEqual(found["totalMatches"], 12 * 60)
            self.assertEqual(outline["total"], 12)
            self.assertEqual(markdown, prose)

            # Corrupt GZIP and invalid envelopes are still rejected without base64 decoding.
            for bad_name, bad_bytes in (
                ("truncated.smd", packed[:-3]),
                ("concat.smd", packed + packed),
            ):
                (self.root / bad_name).write_bytes(bad_bytes)
                for fn in (
                    lambda n=bad_name: self.store.read(n),
                    lambda n=bad_name: self.store.search(n, "Section"),
                    lambda n=bad_name: self.store.outline(n),
                ):
                    with self.assertRaises(AgentDocumentError):
                        fn()

            exact_25mb_len = (documents.MAX_IMAGE // 3) * 4 + 4
            over_25mb = "A" * (exact_25mb_len - 1) + "="
            for idx, bad_env in enumerate((
                {"format": "supermd-smd", "version": 1, "markdown": "# x", "assets": {"assets/../bad.png": assets["assets/fig_0.png"]}},
                {"format": "supermd-smd", "version": 1, "markdown": "# x", "assets": {"assets/bad.png": "data:image/jpeg;base64,eA=="}},
                {"format": "supermd-smd", "version": 1, "markdown": "# x", "assets": {"assets/huge.png": "data:image/png;base64," + over_25mb}},
                {"format": "supermd-smd", "version": 1, "markdown": "x" * (documents.MAX_MARKDOWN + 1), "assets": {}},
                {"format": "supermd-smd", "version": 1, "markdown": "# x", "assets": {
                    f"assets/a{i}.png": "data:image/png;base64,eA==" for i in range(documents.MAX_ASSETS + 1)
                }},
            )):
                bad_path = self.root / f"invalid_{idx}.smd"
                bad_path.write_text(json.dumps(bad_env), encoding="utf-8")
                for fn in (
                    lambda n=bad_path.name: self.store.read(n),
                    lambda n=bad_path.name: self.store.search(n, "x"),
                    lambda n=bad_path.name: self.store.outline(n),
                ):
                    with self.assertRaises(AgentDocumentError):
                        fn()
            self.assertEqual(b64_spy.call_count, 0)

    def test_inspect_assets_read_asset_and_extract_decode_on_demand_and_memoize(self):
        from unittest.mock import patch

        import agent_documents
        import documents

        assets = {
            f"assets/img_{i:03d}.png": "data:image/png;base64," + base64.b64encode(b"\x89PNG\r\n\x1a\n" + f"img-{i}".encode()).decode("ascii")
            for i in range(45)
        }
        packed = compressed_bundle("# Gallery\n", assets)
        expected_rev = hashlib.sha256(packed).hexdigest()
        note = self.root / "gallery.smd"
        note.write_bytes(packed)

        # Cold single-asset read_asset: 1 GZIP inflation and 1 base64 decode.
        cold_read_store = DocumentStore([self.root])
        with (
            patch("documents.base64.b64decode", wraps=base64.b64decode) as b64_spy,
            patch("documents._gzip_json_input", wraps=documents._gzip_json_input) as gzip_spy,
        ):
            single = cold_read_store.read_asset("gallery.smd", "assets/img_044.png", expected_revision=expected_rev)
            self.assertEqual(single["mime_type"], "image/png")
            self.assertEqual(gzip_spy.call_count, 1)
            self.assertEqual(b64_spy.call_count, 1)

        # Cold single-asset extraction: 1 GZIP inflation and 1 base64 decode.
        cold_store = DocumentStore([self.root])
        with (
            patch("documents.base64.b64decode", wraps=base64.b64decode) as b64_spy,
            patch("documents._gzip_json_input", wraps=documents._gzip_json_input) as gzip_spy,
            patch("agent_documents.digest_bytes", wraps=agent_documents.digest_bytes) as digest_spy,
        ):
            extracted = cold_store.extract_asset(
                "gallery.smd", "assets/img_044.png", "out.png", expected_revision=expected_rev
            )
            self.assertTrue(extracted["extracted"])
            self.assertEqual(gzip_spy.call_count, 1)
            self.assertEqual(b64_spy.call_count, 1)
            self.assertEqual(digest_spy.call_count, 2)  # 1 raw revision + 1 decoded asset sha256

            # Repeated read_asset on the same asset reuses both cached envelope and memoized asset bytes.
            item = cold_store.read_asset("gallery.smd", "assets/img_044.png", expected_revision=expected_rev)
            self.assertEqual(item["bytes"], extracted["bytes"])
            self.assertEqual(gzip_spy.call_count, 1)
            self.assertEqual(b64_spy.call_count, 1)

        # Cold inspect decodes only the first 40 assets; subsequent assets() pages decode only uncached slices.
        inspect_store = DocumentStore([self.root])
        with (
            patch("documents.base64.b64decode", wraps=base64.b64decode) as b64_spy,
            patch("documents._gzip_json_input", wraps=documents._gzip_json_input) as gzip_spy,
            patch("agent_documents.digest_bytes", wraps=agent_documents.digest_bytes) as digest_spy,
        ):
            info = inspect_store.inspect("gallery.smd")
            self.assertEqual(info["asset_count"], 45)
            self.assertEqual(len(info["assets"]), 40)
            self.assertEqual(gzip_spy.call_count, 1)
            self.assertEqual(b64_spy.call_count, 40)
            self.assertEqual(digest_spy.call_count, 41)  # 1 raw revision + 40 assets

            first_page = inspect_store.assets("gallery.smd", offset=0, limit=40)
            self.assertEqual(len(first_page["assets"]), 40)
            self.assertEqual(gzip_spy.call_count, 1)
            self.assertEqual(b64_spy.call_count, 40)

            second_page = inspect_store.assets("gallery.smd", offset=40, limit=10)
            self.assertEqual(len(second_page["assets"]), 5)
            self.assertEqual(gzip_spy.call_count, 1)
            self.assertEqual(b64_spy.call_count, 45)

        # Malformed base64 and stale revisions are rejected by read_asset, extract_asset, and mutations.
        import gzip
        bad_note = self.root / "bad_b64.smd"
        bad_bytes = gzip.compress(json.dumps({
            "format": "supermd-smd",
            "version": 1,
            "markdown": "# Bad\n",
            "assets": {"assets/bad.png": "data:image/png;base64,@@@@"},
        }).encode("utf-8"))
        bad_note.write_bytes(bad_bytes)
        bad_rev = hashlib.sha256(bad_bytes).hexdigest()
        self.assertEqual(self.store.read("bad_b64.smd")["text"], "# Bad\n")
        with self.assertRaises(RevisionConflict):
            self.store.read_asset("bad_b64.smd", "assets/bad.png", expected_revision="0" * 64)
        with self.assertRaises(AgentDocumentError):
            self.store.read_asset("bad_b64.smd", "assets/bad.png", expected_revision=bad_rev)
        with self.assertRaises(AgentDocumentError):
            self.store.extract_asset("bad_b64.smd", "assets/bad.png", "never.png", expected_revision=bad_rev)
        with self.assertRaises(AgentDocumentError):
            self.store.patch(
                "bad_b64.smd",
                expected_revision=bad_rev,
                operations=[{"type": "replace", "old": "# Bad", "new": "# Rewritten"}],
            )
        valid_png = self.root / "extra.png"
        valid_png.write_bytes(b"\x89PNG\r\n\x1a\nvalid")
        with self.assertRaises(AgentDocumentError):
            self.store.attach_asset("bad_b64.smd", "extra.png", expected_revision=bad_rev)
        self.assertEqual(bad_note.read_bytes(), bad_bytes)

    def test_envelope_cache_invalidation_mutations_and_lru_byte_budget(self):
        from unittest.mock import patch

        import documents

        created = self.store.create("lifecycle.smd", "# V1\n")
        rev = created["revision"]
        png_a = b"\x89PNG\r\n\x1a\nalpha-asset"
        png_b = b"\x89PNG\r\n\x1a\nbeta-asset-updated"
        (self.root / "a.png").write_bytes(png_a)
        (self.root / "b.png").write_bytes(png_b)

        with patch("documents._gzip_json_input", wraps=documents._gzip_json_input) as gzip_spy:
            self.assertEqual(self.store.read("lifecycle.smd")["text"], "# V1\n")
            self.assertEqual(gzip_spy.call_count, 0)  # Cached directly by create()

            attached = self.store.attach_asset("lifecycle.smd", "a.png", expected_revision=rev)
            rev = attached["revision"]
            patched = self.store.patch(
                "lifecycle.smd",
                expected_revision=rev,
                operations=[{"type": "replace", "old": "# V1", "new": "# V2"}],
            )
            rev = patched["revision"]
            self.assertEqual(self.store.read("lifecycle.smd")["text"], "# V2\n")
            self.assertEqual(
                self.store.read_asset("lifecycle.smd", "assets/a.png", expected_revision=rev)["data"],
                png_a,
            )

            replaced = self.store.replace_asset("lifecycle.smd", "assets/a.png", "b.png", expected_revision=rev)
            rev = replaced["revision"]
            self.assertEqual(
                self.store.read_asset("lifecycle.smd", "assets/a.png", expected_revision=rev)["data"],
                png_b,
            )
            self.assertEqual(gzip_spy.call_count, 0)

        # External modification changes stat key and refreshes the cache.
        atomic_write(self.root / "lifecycle.smd", compressed_bundle("# External V3\n", {}))
        self.assertEqual(self.store.read("lifecycle.smd")["text"], "# External V3\n")

        # Byte-bounded LRU eviction keeps _cache_bytes within max_cache_bytes.
        small_store = DocumentStore([self.root], max_cache_bytes=8_000)
        for index in range(6):
            (self.root / f"item_{index}.md").write_text(f"# Note {index}\n" + ("word " * 500), encoding="utf-8")
            small_store.read(f"item_{index}.md")
            self.assertLessEqual(small_store._cache_bytes, 8_000)
        self.assertGreaterEqual(len(small_store._cache), 1)
        self.assertLess(len(small_store._cache), 6)

    def test_single_pass_fence_boundary_scan_across_headings_svg_and_diagrams(self):
        from unittest.mock import patch

        import agent_documents

        source = (
            "😀 Intro line\n"
            "# Section One\n"
            "```svg\n"
            "# Fenced SVG heading\n"
            "<svg><text>needle</text></svg>\n"
            "```\n"
            "~~~mermaid\n"
            "graph TD; A[needle] --> B\n"
            "~~~\n"
            "````\n"
            "\n"
            "  <SVG viewBox='0 0 8 8'><rect/></SVG>\n"
            "````\n"
            "## Section Two\n"
            "Visible needle after diagrams.\n"
        )
        line_count = len(source.splitlines(keepends=True))
        (self.root / "single-pass.md").write_bytes(source.encode("utf-8"))

        with patch(
            "agent_documents._step_fence_boundary",
            wraps=agent_documents._step_fence_boundary,
        ) as step_spy:
            spans = diagram_spans(source)
            self.assertEqual(step_spy.call_count, line_count)

            step_spy.reset_mock()
            inline_spans = diagram_spans(source, include_inline_svg=True)
            self.assertEqual(step_spy.call_count, line_count)
            self.assertEqual(inline_spans, spans)

            step_spy.reset_mock()
            svg_only = agent_documents._svg_spans(source)
            self.assertEqual(step_spy.call_count, line_count)
            self.assertEqual(len(svg_only), 2)

            step_spy.reset_mock()
            prose_section = self.store.read("single-pass.md", heading="Section One", view="prose")
            self.assertEqual(step_spy.call_count, line_count)
            self.assertEqual(len(prose_section["svg_omissions"]), 2)
            self.assertNotIn("Fenced SVG heading", prose_section["text"])

            # Plain unfenced Markdown skips fence-boundary regex checks altogether.
            step_spy.reset_mock()
            plain = "# Plain\nNo fences here 😀\n## Child\nBody\n"
            self.assertEqual(diagram_spans(plain), [])
            self.assertEqual(agent_documents._svg_spans(plain), [])
            self.assertEqual([h["title"] for h in _headings(plain)], ["Plain", "Child"])
            self.assertEqual(step_spy.call_count, 0)

        self.assertEqual(len(spans), 3)
        self.assertEqual(
            [source[item["start"]:item["end"]] for item in spans],
            [
                "# Fenced SVG heading\n<svg><text>needle</text></svg>\n",
                "graph TD; A[needle] --> B\n",
                "\n  <SVG viewBox='0 0 8 8'><rect/></SVG>\n",
            ],
        )

    def test_fence_scans_preserve_crlf_unicode_mixed_markers_and_unclosed_fences(self):
        import agent_documents

        prefix = ("😀" * 40) + "\r\n"
        h1 = "# 1. Overview 🧭\r\n"
        mixed_svg = (
            "````svg\r\n"
            "~~~\r\n"
            "```\r\n"
            "# Still inside 4-backtick SVG\r\n"
            "<svg><text>needle 𝕏</text></svg>\r\n"
            "`````\r\n"
        )
        tilde_chart = (
            "   ~~~~smd-chart\r\n"
            "```\r\n"
            "~~~\r\n"
            "# Still inside 4-tilde chart\r\n"
            "{\"series\": [\"needle\"]}\r\n"
            "~~~~\r\n"
        )
        indented_non_fence = (
            "    ```svg\r\n"
            "    <svg><text>indented code block, not fence</text></svg>\r\n"
            "    ```\r\n"
        )
        inline_svg = "Before <svg viewBox='0 0 4 4'><text>needle</text></svg> middle\r\n"
        h2 = "## 2. Unclosed Tail\r\n"
        unclosed_mermaid_open = "~~~mermaid\r\n"
        unclosed_mermaid_body = "# Ignored trailing heading\r\ngraph LR; X[needle] --> Y"
        source = (
            prefix
            + h1
            + mixed_svg
            + tilde_chart
            + indented_non_fence
            + inline_svg
            + "needle outside\r\n"
            + h2
            + unclosed_mermaid_open
            + unclosed_mermaid_body
        )

        # Public _headings (without internal start) and outline_source (with exclusive sectionEnd).
        public_headings = _headings(source)
        self.assertEqual(
            public_headings,
            [
                {"index": 0, "level": 1, "title": "1. Overview 🧭", "line": 2},
                {"index": 1, "level": 2, "title": "2. Unclosed Tail", "line": 20},
            ],
        )
        outline = outline_source(source)["headings"]
        expected_h1_start = len(prefix)
        expected_h2_start = source.index(h2)
        self.assertEqual(outline[0]["sectionStart"], expected_h1_start)
        self.assertEqual(outline[0]["sectionEnd"], len(source))
        self.assertEqual(outline[1]["sectionStart"], expected_h2_start)
        self.assertEqual(outline[1]["sectionEnd"], len(source))

        # SVG spans keep exclusive code-point end offsets and 1-based inclusive line bounds.
        svg_spans = agent_documents._svg_spans(source)
        expected_svg_body = (
            "~~~\r\n"
            "```\r\n"
            "# Still inside 4-backtick SVG\r\n"
            "<svg><text>needle 𝕏</text></svg>\r\n"
        )
        self.assertEqual(
            svg_spans,
            [{
                "start": source.index(expected_svg_body),
                "end": source.index(expected_svg_body) + len(expected_svg_body),
                "line_start": 4,
                "line_end": 7,
            }],
        )

        # diagram_spans covers mixed-marker SVG, smd-chart, and unclosed mermaid; inline SVG respects fences.
        fenced_only = diagram_spans(source)
        expected_chart_body = (
            "```\r\n"
            "~~~\r\n"
            "# Still inside 4-tilde chart\r\n"
            "{\"series\": [\"needle\"]}\r\n"
        )
        self.assertEqual(
            [source[s["start"]:s["end"]] for s in fenced_only],
            [expected_svg_body, expected_chart_body, unclosed_mermaid_body],
        )
        self.assertEqual(fenced_only[-1]["end"], len(source))

        # Search excluding diagrams keeps exact non-BMP + CRLF code-point offsets.
        filtered = search_source(source, "needle", exclude_diagrams=True)
        self.assertEqual(
            [m["matchOffset"] for m in filtered["matches"]],
            [
                source.index("needle", source.index(inline_svg)),
                source.index("needle outside"),
            ],
        )

        # Unclosed non-diagram code fence still masks inline <svg> inside it, while unclosed SVG fence extends to EOF.
        unclosed_code = "Prose <svg/> ok\r\n```python\r\n# Hidden\r\nprint('<svg><rect/></svg>')"
        self.assertEqual(_headings(unclosed_code), [])
        self.assertEqual(
            diagram_spans(unclosed_code, include_inline_svg=True),
            [{"start": unclosed_code.index("<svg/>"), "end": unclosed_code.index("<svg/>") + len("<svg/>")}],
        )
        unclosed_svg = "# Fig\r\n```svg\r\n<svg><circle/></svg>"
        self.assertEqual(
            agent_documents._svg_spans(unclosed_svg),
            [{"start": unclosed_svg.index("<svg>"), "end": len(unclosed_svg), "line_start": 3, "line_end": 3}],
        )
        unclosed_empty_svg = "# Fig\r\n```svg"
        self.assertEqual(
            agent_documents._svg_spans(unclosed_empty_svg),
            [{"start": len(unclosed_empty_svg), "end": len(unclosed_empty_svg), "line_start": 3, "line_end": 3}],
        )

    def test_shared_fence_scanner_recognizes_braced_python_and_mermaid_with_exact_offsets_and_unclosed_fences(self):
        from unittest.mock import patch

        import agent_documents

        source = (
            "😀 Lead needle\r\n"
            "```{python, echo=false}\r\n"
            "# Python comment heading\r\n"
            "value = '<svg><rect/></svg>'  # needle in code\r\n"
            "```\r\n"
            "~~~{.py #cell-2}\r\n"
            "y = 2\r\n"
            "~~~\r\n"
            "````{.mermaid, fig-width=6}\r\n"
            "```\r\n"
            "graph TD; A[needle 𝕏] --> B\r\n"
            "````\r\n"
            "```{r, echo=FALSE}\r\n"
            "r_needle <- 1\r\n"
            "```\r\n"
            "```{mermaid\r\n"
            "unclosed_brace_needle\r\n"
            "```\r\n"
            "## Section After Braced\r\n"
            "~~~{mermaid echo=false}\r\n"
            "# Trailing fenced heading\r\n"
            "flowchart LR; X[needle] --> Y"
        )
        line_count = len(source.splitlines(keepends=True))
        with patch(
            "agent_documents._step_fence_boundary",
            wraps=agent_documents._step_fence_boundary,
        ) as step_spy:
            headings, fences = agent_documents._scan_read_only(
                source, collect_headings=True, collect_fences=True
            )
            self.assertEqual(step_spy.call_count, line_count)

        self.assertEqual([h["title"] for h in headings], ["Section After Braced"])
        self.assertEqual(
            [(span.language, span.is_diagram, span.is_svg) for span in fences],
            [
                ("python", False, False),
                ("py", False, False),
                ("mermaid", True, False),
                ("{r,", False, False),
                ("{mermaid", False, False),
                ("mermaid", True, False),
            ],
        )
        self.assertEqual(fences[-1].body_end, len(source))

        diag = diagram_spans(source, include_inline_svg=True)
        expected_closed_mermaid = "```\r\ngraph TD; A[needle 𝕏] --> B\r\n"
        expected_unclosed_mermaid = "# Trailing fenced heading\r\nflowchart LR; X[needle] --> Y"
        self.assertEqual(
            [source[d["start"]:d["end"]] for d in diag],
            [expected_closed_mermaid, expected_unclosed_mermaid],
        )

        filtered = search_source(source, "needle", exclude_diagrams=True)
        self.assertEqual(
            [m["matchOffset"] for m in filtered["matches"]],
            [
                source.index("needle"),
                source.index("needle in code"),
                source.index("r_needle") + 2,
                source.index("unclosed_brace_needle") + len("unclosed_brace_"),
            ],
        )

        unclosed_braced_py = "Inline <svg/> before\r\n```{.python, echo=false}\r\n# Hidden\r\nprint('<svg><circle/></svg>')"
        _, py_fences = agent_documents._scan_read_only(unclosed_braced_py, collect_fences=True)
        self.assertEqual(len(py_fences), 1)
        self.assertEqual(py_fences[0].language, "python")
        self.assertFalse(py_fences[0].is_diagram)
        self.assertEqual(_headings(unclosed_braced_py), [])
        self.assertEqual(
            diagram_spans(unclosed_braced_py, include_inline_svg=True),
            [{"start": unclosed_braced_py.index("<svg/>"), "end": unclosed_braced_py.index("<svg/>") + len("<svg/>")}],
        )

    def test_read_source_contract_and_agent_package_facade_identity(self):
        import importlib

        import agent_documents
        from agent import fs_ops, patches, source_ops, store

        repo_root = str(Path(__file__).resolve().parent.parent)
        added_root = repo_root not in sys.path
        if added_root:
            sys.path.insert(0, repo_root)
        try:
            pkg_agent_documents = importlib.import_module("desktop.agent_documents")
            pkg_source_ops = importlib.import_module("desktop.agent.source_ops")
            pkg_patches = importlib.import_module("desktop.agent.patches")
            pkg_fs_ops = importlib.import_module("desktop.agent.fs_ops")
            pkg_store = importlib.import_module("desktop.agent.store")
        finally:
            if added_root and repo_root in sys.path:
                sys.path.remove(repo_root)

        self.assertIs(pkg_agent_documents, agent_documents)
        self.assertIs(pkg_source_ops, source_ops)
        self.assertIs(pkg_patches, patches)
        self.assertIs(pkg_fs_ops, fs_ops)
        self.assertIs(pkg_store, store)
        self.assertIs(source_ops.AgentDocumentError, AgentDocumentError)
        self.assertIs(source_ops.RevisionConflict, RevisionConflict)
        self.assertIs(source_ops.read_source, agent_documents.read_source)
        self.assertIs(pkg_agent_documents.DocumentStore, DocumentStore)
        self.assertIs(store.DocumentStore, DocumentStore)

        source = "# Intro\nLead.\n## 1.2 Charts\n```svg\n<svg><circle/></svg>\n```\nBody.\n## 2. End\nTail.\n"
        prose = source_ops.read_source(source, heading="1.2", view="prose")
        self.assertEqual(prose["heading"], {"index": 1, "level": 2, "title": "1.2 Charts", "line": 3})
        self.assertIn("[SVG omitted:", prose["text"])
        self.assertNotIn("Tail.", prose["text"])
        self.assertEqual(len(prose["svg_omissions"]), 1)
        plain = source_ops.read_source(source, view="source", limit=12)
        self.assertNotIn("heading", plain)
        self.assertEqual(plain["text"], source[:12])
        for kwargs in (
            {"source": None},
            {"source": source, "offset": True},
            {"source": source, "offset": -1},
            {"source": source, "offset": len(source) + 1},
            {"source": source, "limit": False},
            {"source": source, "limit": 0},
            {"source": source, "view": "html"},
        ):
            with self.assertRaises(AgentDocumentError):
                source_ops.read_source(**kwargs)

        # Pre-lock patch write validation stays untouched and rejects invalid operations before revision checks.
        created = self.store.create("validation-order.md", "# Title\nBody.\n")
        stale_revision = "0" * 64
        self.assertNotEqual(created["revision"], stale_revision)
        with self.assertRaises(AgentDocumentError) as ctx:
            self.store.patch("validation-order.md", expected_revision=stale_revision, operations=[])
        self.assertNotIsInstance(ctx.exception, RevisionConflict)

    def test_patch_validates_pre_lock_and_runs_validation_once_per_store_patch(self):
        from unittest.mock import patch

        from agent import fs_ops, patches

        created = self.store.create("single-pass-patch.md", "# Title\nalpha\nbeta\n")
        revision = created["revision"]
        stale_revision = "f" * 64
        with (
            patch.object(fs_ops, "_path_lock", wraps=fs_ops._path_lock) as lock_spy,
            patch.object(patches, "validate_patch_operations", wraps=patches.validate_patch_operations) as validate_spy,
        ):
            with self.assertRaises(AgentDocumentError) as ctx:
                self.store.patch(
                    "single-pass-patch.md",
                    expected_revision=stale_revision,
                    operations=[{"type": "replace", "old": "", "new": "x"}],
                )
            self.assertNotIsInstance(ctx.exception, RevisionConflict)
            self.assertEqual(validate_spy.call_count, 1)
            self.assertEqual(lock_spy.call_count, 0)

            validate_spy.reset_mock()
            lock_spy.reset_mock()
            updated = self.store.patch(
                "single-pass-patch.md",
                expected_revision=revision,
                operations=[
                    {"type": "replace", "old": "alpha", "new": "omega"},
                    {"type": "insert", "line": 3, "text": "gamma\n"},
                ],
            )
            self.assertTrue(updated["saved"])
            self.assertEqual(validate_spy.call_count, 1)
            self.assertEqual(lock_spy.call_count, 1)
            self.assertEqual(
                self.store.read("single-pass-patch.md", view="source")["text"],
                "# Title\nomega\ngamma\nbeta\n",
            )

            validate_spy.reset_mock()
            self.assertEqual(
                patches.apply_patch_operations("one\n", [{"type": "replace", "old": "one", "new": "two"}]),
                "two\n",
            )
            self.assertEqual(validate_spy.call_count, 1)
            with self.assertRaises(AgentDocumentError):
                patches.apply_patch_operations_detailed("one\n", [])
            self.assertEqual(validate_spy.call_count, 2)

    def test_dual_topology_clean_subprocesses_preserve_singletons_and_avoid_gui_or_mcp_imports(self):
        desktop_dir = Path(__file__).resolve().parent
        repo_root = desktop_dir.parent
        env = {k: v for k, v in os.environ.items() if k != "PYTHONPATH"}
        probe_from_repo = (
            "import importlib, sys\n"
            "from unittest.mock import patch\n"
            "from desktop import agent_documents as pkg_ad\n"
            "from desktop.agent import fs_ops as pkg_fs, patches as pkg_p, source_ops as pkg_so, store as pkg_st\n"
            "assert 'PySide6' not in sys.modules and 'mcp' not in sys.modules\n"
            f"sys.path.insert(0, {str(desktop_dir)!r})\n"
            "import agent_documents as flat_ad\n"
            "from agent import fs_ops as flat_fs, patches as flat_p, source_ops as flat_so, store as flat_st\n"
            "assert pkg_ad is flat_ad and pkg_fs is flat_fs and pkg_p is flat_p and pkg_so is flat_so and pkg_st is flat_st\n"
            "assert pkg_ad.DocumentStore is flat_st.DocumentStore\n"
            "with patch.object(pkg_ad, '_step_fence_boundary', wraps=pkg_ad._step_fence_boundary) as spy:\n"
            "    pkg_ad.diagram_spans('```svg\\n<svg/>\\n```\\n')\n"
            "    assert spy.call_count == 3\n"
        )
        probe_from_desktop = (
            "import importlib, sys\n"
            "from unittest.mock import patch\n"
            "import agent_documents as flat_ad\n"
            "from agent import fs_ops as flat_fs, patches as flat_p, source_ops as flat_so, store as flat_st\n"
            "assert 'PySide6' not in sys.modules and 'mcp' not in sys.modules\n"
            f"sys.path.insert(0, {str(repo_root)!r})\n"
            "pkg_ad = importlib.import_module('desktop.agent_documents')\n"
            "pkg_fs = importlib.import_module('desktop.agent.fs_ops')\n"
            "pkg_p = importlib.import_module('desktop.agent.patches')\n"
            "pkg_so = importlib.import_module('desktop.agent.source_ops')\n"
            "pkg_st = importlib.import_module('desktop.agent.store')\n"
            "assert pkg_ad is flat_ad and pkg_fs is flat_fs and pkg_p is flat_p and pkg_so is flat_so and pkg_st is flat_st\n"
            f"ws = flat_ad.DocumentStore([{str(self.root)!r}])\n"
            "ws.create('probe.md', '# Probe\\n')\n"
            "with patch.object(pkg_ad, 'digest_bytes', wraps=pkg_ad.digest_bytes) as dspy:\n"
            "    ws.create('probe2.md', '# Probe 2\\n')\n"
            "    assert dspy.call_count >= 1\n"
            "assert 'PySide6' not in sys.modules and 'mcp' not in sys.modules\n"
        )
        for cwd, code in ((repo_root, probe_from_repo), (desktop_dir, probe_from_desktop)):
            proc = subprocess.run(
                [sys.executable, "-c", code],
                cwd=str(cwd), env=env, capture_output=True, text=True, encoding="utf-8", check=False,
            )
            self.assertEqual(proc.returncode, 0, proc.stderr)

    def test_hidden_paths_rejected_and_inspect_supports_frontmatter_properties_hook(self):
        from unittest.mock import patch

        import frontmatter

        (self.root / ".hidden.md").write_text("# Secret\n", encoding="utf-8")
        hidden_dir = self.root / ".git"
        hidden_dir.mkdir()
        (hidden_dir / "config").write_text("x\n", encoding="utf-8")
        sub = self.root / "sub"
        sub.mkdir()
        for rel in (".hidden.md", ".git/config", "sub/../.hidden.md"):
            with self.assertRaisesRegex(AgentDocumentError, "Hidden files and directories"):
                self.store.resolve(rel)
        with self.assertRaisesRegex(AgentDocumentError, "Hidden files and directories"):
            self.store.resolve(".new.md", must_exist=False)

        fm_note = "---\ntitle: Spec\n# Hidden Heading\n---\n# Real Heading\nBody\n"
        (self.root / "fm.md").write_text(fm_note, encoding="utf-8")
        info_default = self.store.inspect("fm.md")
        if not hasattr(frontmatter, "parse_frontmatter"):
            self.assertNotIn("properties", info_default)
        fm_end = frontmatter.frontmatter_end(fm_note)
        with patch.object(frontmatter, "parse_frontmatter", create=True, return_value=(fm_end, {"title": "Spec"})):
            info_props = self.store.inspect("fm.md")
        self.assertEqual(info_props["properties"], {"title": "Spec"})
        self.assertEqual([h["title"] for h in info_props["headings"]], ["Real Heading"])


if __name__ == "__main__":
    unittest.main()
