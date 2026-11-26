"""Unit tests for desktop/portable_search.py and shared single-member gzip streaming."""
from __future__ import annotations

import base64
import gzip
import io
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import documents
import portable_search
from workspace_search import stream_text_search


class PortableSearchTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory(prefix="supermd-portable-search-")
        self.root = Path(self.temp.name)

    def tearDown(self) -> None:
        self.temp.cleanup()

    def test_documents_reexports_portable_search_symbols(self) -> None:
        self.assertIs(documents.read_searchable_markdown, portable_search.read_searchable_markdown)
        self.assertIs(documents._read_bounded_utf8_stream, portable_search._read_bounded_utf8_stream)
        self.assertIs(documents._extract_portable_markdown, portable_search._extract_portable_markdown)
        self.assertIs(documents.iter_single_member_gzip_chunks, portable_search.iter_single_member_gzip_chunks)
        self.assertEqual(documents.MAX_SEARCH_MARKDOWN_BYTES, portable_search.MAX_SEARCH_MARKDOWN_BYTES)

    def test_single_member_gzip_rejects_truncation_concatenation_and_trailing_bytes(self) -> None:
        compressed = documents.compressed_bundle("# Portable Title\n\nBody text.\n", {})
        mid_deflate = compressed[: max(12, len(compressed) // 2)]
        invalid_payloads = (
            compressed[:-2],
            mid_deflate,
            compressed + compressed,
            compressed + b"trailing",
        )
        target = self.root / "damaged.smd"
        for payload in invalid_payloads:
            target.write_bytes(payload)
            with self.assertRaises(ValueError):
                list(portable_search.iter_single_member_gzip_chunks(io.BytesIO(payload), max_bytes=documents.MAX_FILE))
            with self.assertRaises(ValueError):
                list(portable_search._read_bounded_utf8_stream(target, is_gzip=True))
            with self.assertRaises(ValueError):
                documents._gzip_json_input(target)
            self.assertIsNone(portable_search.read_searchable_markdown(target))

    def test_max_file_cap_enforced_across_compressed_and_inflated_streams(self) -> None:
        large_markdown = "# Heading\n\n" + ("Searchable line with repeated words.\n" * 400)
        compressed = documents.compressed_bundle(large_markdown, {})
        note_path = self.root / "capped.smd"
        note_path.write_bytes(compressed)

        compressed_cap = max(16, len(compressed) - 1)
        with patch("documents.MAX_FILE", compressed_cap):
            with self.assertRaises(ValueError):
                list(portable_search.iter_single_member_gzip_chunks(io.BytesIO(compressed), max_bytes=documents.MAX_FILE))
            with self.assertRaises(ValueError):
                list(portable_search._read_bounded_utf8_stream(note_path, is_gzip=True))
            with self.assertRaises(ValueError):
                documents._gzip_json_input(note_path)
            self.assertIsNone(portable_search.read_searchable_markdown(note_path))

        inflated_cap = len(compressed) + 32
        self.assertLess(inflated_cap, len(large_markdown))
        with patch("documents.MAX_FILE", inflated_cap):
            with self.assertRaises(ValueError):
                list(portable_search.iter_single_member_gzip_chunks(io.BytesIO(compressed), max_bytes=documents.MAX_FILE))
            with self.assertRaises(ValueError):
                list(portable_search._read_bounded_utf8_stream(note_path, is_gzip=True))
            with self.assertRaises(ValueError):
                documents._gzip_json_input(note_path)
            self.assertIsNone(portable_search.read_searchable_markdown(note_path))

    def test_multi_megabyte_portable_archives_stream_markdown_without_base64_decode(self) -> None:
        raw_png = b"\x89PNG\r\n\x1a\n" + bytes((i * 31) % 251 for i in range(1_200_000))
        asset_url = "data:image/png;base64," + base64.b64encode(raw_png).decode("ascii")
        assets = {"assets/diagram-a.png": asset_url, "assets/diagram-b.png": asset_url}
        smd_md = "# SMD Study Note\n\nNeutrinoOscillation inside multi-megabyte archive.\n"
        fmd_md = "# FMD Legacy Note\n\nNeutrinoOscillation inside legacy fmd envelope.\n"

        smd_path = self.root / "large-bundle.smd"
        fmd_path = self.root / "large-legacy.fmd"
        plain_fmd_path = self.root / "plain-legacy.fmd"

        smd_bytes = gzip.compress(
            json.dumps({"format": "supermd-smd", "version": 1, "markdown": smd_md, "assets": assets}).encode("utf-8"),
            compresslevel=1,
        )
        fmd_envelope = json.dumps({"format": "supermd-fmd", "version": 1, "markdown": fmd_md, "assets": assets}).encode("utf-8")
        smd_path.write_bytes(smd_bytes)
        fmd_path.write_bytes(gzip.compress(fmd_envelope, compresslevel=1))
        plain_fmd_path.write_bytes(fmd_envelope)
        self.assertGreater(len(fmd_envelope), 3_000_000)

        with patch.object(base64, "b64decode", side_effect=AssertionError("Must not decode Base64 assets")):
            self.assertEqual(portable_search.read_searchable_markdown(smd_path), smd_md)
            self.assertEqual(portable_search.read_searchable_markdown(fmd_path), fmd_md)
            self.assertEqual(portable_search.read_searchable_markdown(plain_fmd_path), fmd_md)

    def test_plain_text_crlf_bom_nul_rejection_and_workspace_search_patch_hooks(self) -> None:
        plain_path = self.root / "notes.md"
        plain_path.write_bytes("\ufeff# Title\r\nSecond line\rThird line\n".encode("utf-8"))
        self.assertEqual(portable_search.read_searchable_markdown(plain_path), "# Title\nSecond line\nThird line\n")

        binary_path = self.root / "binary.md"
        binary_path.write_bytes(b"# Looks like text\n\x00binary tail")
        self.assertIsNone(portable_search.read_searchable_markdown(binary_path))

        portable_calls: list[str] = []
        orig_reader = portable_search.read_searchable_markdown
        with patch.object(
            portable_search,
            "read_searchable_markdown",
            side_effect=lambda p, *a, **kw: (portable_calls.append(Path(p).name), orig_reader(p, *a, **kw))[1],
        ):
            res = stream_text_search("Second line", [], [], self.root)
        self.assertEqual([m["name"] for m in res["matches"]], ["notes.md"])
        self.assertIn("notes.md", portable_calls)


if __name__ == "__main__":
    unittest.main()
