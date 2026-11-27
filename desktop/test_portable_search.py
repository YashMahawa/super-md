"""Unit tests for desktop/portable_search.py and shared single-member gzip streaming."""
from __future__ import annotations

import base64
import builtins
import gzip
import io
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import documents
import portable_search
from workspace_search import stream_text_search

TINY_PNG = (
    "data:image/png;base64,"
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="
)


class PortableSearchTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory(prefix="supermd-portable-search-")
        self.root = Path(self.temp.name)

    def tearDown(self) -> None:
        self.temp.cleanup()

    def test_boundary_reexports_and_standalone_portable_compatibility(self) -> None:
        self.assertFalse(hasattr(portable_search, "sys"))
        self.assertFalse(hasattr(portable_search, "MAX_FILE"))
        self.assertFalse(hasattr(portable_search, "_DEFAULT_MAX_FILE"))
        self.assertIs(documents._extract_portable_markdown, portable_search._extract_portable_markdown)
        self.assertIs(documents.iter_single_member_gzip_chunks, portable_search.iter_single_member_gzip_chunks)
        self.assertEqual(documents.MAX_SEARCH_MARKDOWN_BYTES, portable_search.MAX_SEARCH_MARKDOWN_BYTES)

        smd_path = self.root / "standalone.smd"
        smd_path.write_bytes(documents.compressed_bundle("# Standalone\n\nDirect scanner call.\n", {}))
        self.assertEqual(
            portable_search.read_searchable_markdown(smd_path, max_file_bytes=documents.MAX_FILE),
            "# Standalone\n\nDirect scanner call.\n",
        )
        seen_keys: list[tuple[int, int, int, int]] = []
        self.assertEqual(
            portable_search.read_searchable_markdown(
                smd_path,
                max_file_bytes=documents.MAX_FILE,
                cache_lookup=lambda key: (seen_keys.append(key), "# Injected Cache\n")[1],
            ),
            "# Injected Cache\n",
        )
        self.assertEqual(len(seen_keys), 1)

        env = {k: v for k, v in os.environ.items() if k not in {"PYTHONPATH", "PYTHONSAFEPATH", "PYTHONSTARTUP"}}
        probe = (
            "from desktop import documents, portable_search\n"
            "assert documents.portable_search is portable_search\n"
            f"assert documents.read_searchable_markdown({str(smd_path)!r}) == '# Standalone\\n\\nDirect scanner call.\\n'\n"
        )
        proc = subprocess.run([sys.executable, "-E", "-c", probe], cwd=Path(__file__).resolve().parent.parent, env=env, capture_output=True, text=True, timeout=30)
        self.assertEqual(proc.returncode, 0, proc.stdout + "\n" + proc.stderr)

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
                list(portable_search._read_bounded_utf8_stream(target, is_gzip=True, max_file_bytes=documents.MAX_FILE))
            with self.assertRaises(ValueError):
                list(documents._read_bounded_utf8_stream(target, is_gzip=True))
            with self.assertRaises(ValueError):
                documents._gzip_json_input(target)
            self.assertIsNone(documents.read_searchable_markdown(target))
            self.assertIsNone(portable_search.read_searchable_markdown(target, max_file_bytes=documents.MAX_FILE))

        with self.assertRaises(ValueError):
            list(
                portable_search.iter_single_member_gzip_chunks(
                    io.BytesIO(compressed + compressed),
                    max_bytes=documents.MAX_FILE,
                    read_chunk_size=len(compressed),
                )
            )

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
                list(documents._read_bounded_utf8_stream(note_path, is_gzip=True))
            with self.assertRaises(ValueError):
                documents._gzip_json_input(note_path)
            self.assertIsNone(documents.read_searchable_markdown(note_path))

        inflated_cap = len(compressed) + 32
        self.assertLess(inflated_cap, len(large_markdown))
        with patch("documents.MAX_FILE", inflated_cap):
            with self.assertRaises(ValueError):
                list(portable_search.iter_single_member_gzip_chunks(io.BytesIO(compressed), max_bytes=documents.MAX_FILE))
            with self.assertRaises(ValueError):
                list(documents._read_bounded_utf8_stream(note_path, is_gzip=True))
            with self.assertRaises(ValueError):
                documents._gzip_json_input(note_path)
            self.assertIsNone(documents.read_searchable_markdown(note_path))

    def test_multi_megabyte_portable_archives_stream_early_exit_without_base64_decode(self) -> None:
        raw_png = b"\x89PNG\r\n\x1a\n" + os.urandom(1_200_000)
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
        self.assertGreater(len(smd_bytes), 1_000_000)
        self.assertGreater(len(fmd_envelope), 3_000_000)

        bytes_read: dict[str, int] = {}
        real_path_open = Path.open

        def counting_path_open(path_self: Path, *args, **kwargs):
            handle = real_path_open(path_self, *args, **kwargs)
            if path_self.parent != self.root:
                return handle

            class _CountingReader:
                def read(self, size: int = -1):
                    data = handle.read(size)
                    bytes_read[path_self.name] = bytes_read.get(path_self.name, 0) + len(data)
                    return data

                def __enter__(self):
                    handle.__enter__()
                    return self

                def __exit__(self, *exc):
                    return handle.__exit__(*exc)

            return _CountingReader()

        with patch.object(base64, "b64decode", side_effect=AssertionError("Must not decode Base64 assets")), patch.object(
            Path, "open", counting_path_open
        ):
            self.assertEqual(documents.read_searchable_markdown(smd_path), smd_md)
            self.assertEqual(documents.read_searchable_markdown(fmd_path), fmd_md)
            self.assertEqual(documents.read_searchable_markdown(plain_fmd_path), fmd_md)

        self.assertLess(bytes_read["large-bundle.smd"], 65_536)
        self.assertLess(bytes_read["large-legacy.fmd"], 65_536)
        self.assertLess(bytes_read["plain-legacy.fmd"], 131_072)

    def test_hot_cache_serves_recent_portable_markdown_without_disk_open_and_refreshes_on_edit(self) -> None:
        hot_path = self.root / "hot-cached.smd"
        documents.write_portable(hot_path, "# Hot Note\n\nHotCacheToken inside cached bundle.\n", {"assets/p.png": TINY_PNG})

        real_open = builtins.open
        target_norm = os.path.normcase(str(hot_path))

        def forbid_hot_open(file, *args, **kwargs):
            if isinstance(file, (str, os.PathLike)) and os.path.normcase(os.fspath(file)) == target_norm:
                raise AssertionError("Expected hot _RECENT_PORTABLE_FILES cache hit without opening file")
            return real_open(file, *args, **kwargs)

        with patch.object(builtins, "open", side_effect=forbid_hot_open):
            self.assertEqual(documents.read_searchable_markdown(hot_path), "# Hot Note\n\nHotCacheToken inside cached bundle.\n")
            res = stream_text_search("HotCacheToken", [], [], self.root)
        self.assertEqual([(m["name"], m["line"]) for m in res["matches"]], [("hot-cached.smd", 3)])
        self.assertIsNone(documents.read_searchable_markdown(hot_path, max_text_bytes=8))

        hot_path.write_bytes(documents.compressed_bundle("# Updated Disk Note\n\nFreshUncachedToken after overwrite.\n", {}))
        self.assertEqual(
            documents.read_searchable_markdown(hot_path),
            "# Updated Disk Note\n\nFreshUncachedToken after overwrite.\n",
        )

    def test_plain_text_crlf_bom_nul_rejection_and_caller_patch_compatibility(self) -> None:
        plain_path = self.root / "notes.md"
        plain_path.write_bytes("\ufeff# Title\r\nSecond line\rThird line\n".encode("utf-8"))
        self.assertEqual(documents.read_searchable_markdown(plain_path), "# Title\nSecond line\nThird line\n")

        binary_path = self.root / "binary.md"
        binary_path.write_bytes(b"# Looks like text\n\x00binary tail")
        self.assertIsNone(documents.read_searchable_markdown(binary_path))

        doc_calls: list[str] = []
        orig_doc_reader = documents.read_searchable_markdown
        with patch.object(
            documents,
            "read_searchable_markdown",
            side_effect=lambda p, *a, **kw: (doc_calls.append(Path(p).name), orig_doc_reader(p, *a, **kw))[1],
        ):
            doc_res = stream_text_search("Second line", [], [], self.root)
        self.assertEqual([m["name"] for m in doc_res["matches"]], ["notes.md"])
        self.assertIn("notes.md", doc_calls)

        portable_calls: list[str] = []
        orig_portable_reader = portable_search.read_searchable_markdown
        with patch.object(
            portable_search,
            "read_searchable_markdown",
            side_effect=lambda p, *a, **kw: (portable_calls.append(Path(p).name), orig_portable_reader(p, *a, **kw))[1],
        ):
            portable_res = stream_text_search("Third line", [], [], self.root)
        self.assertEqual([m["name"] for m in portable_res["matches"]], ["notes.md"])
        self.assertIn("notes.md", portable_calls)


if __name__ == "__main__":
    unittest.main()
