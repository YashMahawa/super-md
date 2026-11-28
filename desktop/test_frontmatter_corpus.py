"""Desktop frontmatter companion-export, scanner, and inner-BOM divergence regressions."""
from __future__ import annotations

import base64
import hashlib
import json
import struct
import sys
import tempfile
import unittest
import zipfile
import zlib
from pathlib import Path

DESKTOP_DIR = Path(__file__).resolve().parent
if str(DESKTOP_DIR) not in sys.path:
    sys.path.insert(0, str(DESKTOP_DIR))

import documents
from agent_documents import DocumentStore, _scan_read_only
from agent_exports import (
    _clean_markdown_images,
    _contains_unsupported_diagrams,
    _image_destinations,
    _resolve_image_assets,
    export_smd,
)
from frontmatter import frontmatter_end, mask_frontmatter, strip_frontmatter
from markdown_export import write_markdown_export, write_markdown_zip

CONFORMANCE_PATH = DESKTOP_DIR.parent / "test-fixtures" / "frontmatter-conformance.json"

MASKED_EXPORT_SPECS = (
    (
        "folded_clip_indented_delimiters_and_fences",
        ["real.png"],
        ("folded-fake.png", "mermaid"),
        ("# Real Section", "![Real](real.png)"),
    ),
    (
        "single_quoted_trailing_backslash_and_masked_tokens",
        ["flow-real.png"],
        ("missing.png", "wiki-fake.png", "fake.png", "flow-missing.png", "mermaid"),
        ("# Lecture 1", "![Body](flow-real.png)"),
    ),
    (
        "crlf_bom_astral_and_mixed_endings",
        ["crlf-real.png"],
        ("crlf-fake.png",),
        ("# CRLF Astral Heading", "- [ ] CRLF Astral Task", "![Real](crlf-real.png)"),
    ),
)


def _make_png_bytes(seed: str) -> bytes:
    def chunk(kind: bytes, payload: bytes) -> bytes:
        body = kind + payload
        return struct.pack(">I", len(payload)) + body + struct.pack(">I", zlib.crc32(body) & 0xFFFFFFFF)

    digest = hashlib.sha256(seed.encode("utf-8")).digest()
    scanline = bytes((0, digest[0], digest[1], digest[2]))
    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", struct.pack(">IIBBBBB", 1, 1, 8, 2, 0, 0, 0))
        + chunk(b"IDAT", zlib.compress(scanline))
        + chunk(b"IEND", b"")
    )


def _png_data_url(raw: bytes) -> str:
    return "data:image/png;base64," + base64.b64encode(raw).decode("ascii")


class FrontmatterCorpusTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        suite = json.loads(CONFORMANCE_PATH.read_text(encoding="utf-8"))
        cls.by_id = {case["id"]: case for case in suite["cases"]}

    def test_masked_frontmatter_excludes_fake_media_and_fences_across_active_exports(self) -> None:
        with tempfile.TemporaryDirectory(prefix="supermd-fm-exports-") as temp_name:
            temp_root = Path(temp_name)
            for idx, (case_id, body_images, masked_excludes, body_probes) in enumerate(MASKED_EXPORT_SPECS):
                with self.subTest(id=case_id):
                    source: str = self.by_id[case_id]["markdown"]
                    end = frontmatter_end(source)
                    masked = mask_frontmatter(source)
                    self.assertGreater(end, 0)
                    self.assertFalse(_contains_unsupported_diagrams(source))
                    self.assertEqual(_image_destinations(source), body_images)

                    cleaned = _clean_markdown_images(masked)
                    for forbidden in masked_excludes:
                        self.assertNotIn(forbidden, masked)
                        self.assertNotIn(forbidden, cleaned)

                    headings, fences = _scan_read_only(masked, collect_headings=True, collect_fences=True)
                    self.assertEqual(fences, [])
                    self.assertEqual(len(headings), 1)
                    self.assertEqual(headings[0]["start"], source.index(body_probes[0], end))

                    case_root = temp_root / f"case-{idx}"
                    workspace = case_root / "workspace"
                    workspace.mkdir(parents=True)
                    store = DocumentStore([workspace])
                    payloads = {rel: _make_png_bytes(f"{case_id}:{rel}") for rel in body_images}
                    for rel, raw in payloads.items():
                        (workspace / rel).write_bytes(raw)
                    note_md = workspace / "note.md"
                    note_md.write_bytes(source.encode("utf-8"))

                    resolved = _resolve_image_assets(store, note_md, source, {})
                    self.assertEqual(list(resolved.keys()), body_images)
                    for rel, raw in payloads.items():
                        self.assertEqual(base64.b64decode(resolved[rel]), raw)

                    companion_assets = {rel: _png_data_url(raw) for rel, raw in payloads.items()}
                    export_dir = case_root / "companion"
                    export_dir.mkdir()
                    write_markdown_export(export_dir / "note.md", source, companion_assets, create_only=True)
                    exported = (export_dir / "note.md").read_bytes().decode("utf-8")
                    self.assertEqual(exported, source)
                    for probe in body_probes:
                        self.assertEqual(exported.index(probe, end), source.index(probe, end))
                    written = {p.relative_to(export_dir).as_posix() for p in export_dir.rglob("*") if p.is_file()}
                    self.assertEqual(written, {"note.md", *body_images})

                    bundle_zip = case_root / "bundle.zip"
                    write_markdown_zip(
                        bundle_zip,
                        source,
                        companion_assets,
                        create_only=True,
                        markdown_filename="note.md",
                    )
                    with zipfile.ZipFile(bundle_zip) as archive:
                        self.assertEqual(archive.namelist(), ["note.md", *body_images])
                        self.assertEqual(archive.read("note.md").decode("utf-8"), source)

                    portable_md = source
                    portable_assets = {}
                    for rel, url in companion_assets.items():
                        safe_rel = f"assets/{rel}"
                        portable_md = portable_md[:end] + portable_md[end:].replace(f"({rel})", f"({safe_rel})")
                        portable_assets[safe_rel] = url
                    source_smd = workspace / "source.smd"
                    source_smd.write_bytes(documents.compressed_bundle(portable_md, portable_assets))
                    self.assertEqual(export_smd(store, "source.smd", "out.smd")["format"], "supermd-smd")
                    unpacked_md, unpacked_assets, portable = documents.open_note(workspace / "out.smd")
                    self.assertTrue(portable)
                    self.assertEqual(unpacked_md, portable_md)
                    self.assertEqual(set(unpacked_assets.keys()), set(portable_assets.keys()))

    def test_astral_codepoint_vs_utf16_boundary_and_inner_bom_divergence(self) -> None:
        astral_md: str = self.by_id["crlf_bom_astral_and_mixed_endings"]["markdown"]
        end_cp = frontmatter_end(astral_md)
        end_utf16 = len(astral_md[:end_cp].encode("utf-16-le")) // 2
        self.assertEqual(end_utf16, end_cp + 3)

        inner_bom = "---\ntitle: Alpha\n\ufeff\nauthor: Beta\n---\n# Body\n"
        self.assertEqual(frontmatter_end(inner_bom), 0)
        self.assertEqual(strip_frontmatter(inner_bom), inner_bom)
        self.assertEqual(mask_frontmatter(inner_bom), inner_bom)


if __name__ == "__main__":
    unittest.main()
