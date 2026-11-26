"""Shared portable YAML frontmatter fixture corpus tests for Desktop Python."""
from __future__ import annotations

import base64
import hashlib
import json
import struct
import tempfile
import unittest
import zipfile
import zlib
from pathlib import Path

try:
    from . import documents
    from .agent_documents import DocumentStore, _scan_read_only
    from .agent_exports import (
        AgentDocumentError,
        _clean_markdown_images,
        _contains_unsupported_diagrams,
        _image_destinations,
        _resolve_image_assets,
        export_smd,
        find_engine,
    )
    from .frontmatter import frontmatter_end, mask_frontmatter, strip_frontmatter
    from .markdown_export import write_markdown_export, write_markdown_zip
except ImportError:
    import documents
    from agent_documents import DocumentStore, _scan_read_only
    from agent_exports import (
        AgentDocumentError,
        _clean_markdown_images,
        _contains_unsupported_diagrams,
        _image_destinations,
        _resolve_image_assets,
        export_smd,
        find_engine,
    )
    from frontmatter import frontmatter_end, mask_frontmatter, strip_frontmatter
    from markdown_export import write_markdown_export, write_markdown_zip

REQUIRED_CATEGORIES = (
    "quoted-scalars",
    "flow-collections",
    "folded-scalars",
    "crlf",
    "unicode-separators",
)

FIXTURES_DIR = Path(__file__).resolve().parent.parent / "test-fixtures"
CORPUS_PATH = FIXTURES_DIR / "frontmatter-corpus.json"
CONFORMANCE_PATH = FIXTURES_DIR / "frontmatter-conformance.json"


def _utf16_len(text: str) -> int:
    return len(text.encode("utf-16-le")) // 2


def _png_chunk(kind: bytes, payload: bytes) -> bytes:
    body = kind + payload
    return struct.pack(">I", len(payload)) + body + struct.pack(">I", zlib.crc32(body) & 0xFFFFFFFF)


def _make_png_bytes(seed: str) -> bytes:
    digest = hashlib.sha256(seed.encode("utf-8")).digest()
    scanline = bytes((0, digest[0], digest[1], digest[2]))
    return (
        b"\x89PNG\r\n\x1a\n"
        + _png_chunk(b"IHDR", struct.pack(">IIBBBBB", 1, 1, 8, 2, 0, 0, 0))
        + _png_chunk(b"IDAT", zlib.compress(scanline))
        + _png_chunk(b"IEND", b"")
    )


def _png_data_url(raw: bytes) -> str:
    return "data:image/png;base64," + base64.b64encode(raw).decode("ascii")


def _pr186_desktop_aligned() -> bool:
    """Detect whether PR #186's Desktop flow/line-splitting alignment is active."""
    return frontmatter_end("---\nmeta: {not_a_pair}\n---\nBody\n") == 0


class FrontmatterCorpusTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.corpus = json.loads(CORPUS_PATH.read_text(encoding="utf-8"))
        cls.shared_cases = cls.corpus["sharedCases"]
        cls.divergences = cls.corpus["divergences"]
        cls.conformance = (
            json.loads(CONFORMANCE_PATH.read_text(encoding="utf-8"))
            if CONFORMANCE_PATH.is_file()
            else None
        )

    def _assert_mask_invariants(self, source: str, masked: str, end_cp: int, expected_body: str, label: str) -> None:
        self.assertEqual(len(masked), len(source), label)
        for idx, ch in enumerate(source):
            self.assertEqual(masked[idx] == "\r", ch == "\r", f"{label}: CR mismatch at {idx}")
            self.assertEqual(masked[idx] == "\n", ch == "\n", f"{label}: LF mismatch at {idx}")
            if idx < end_cp and ch not in ("\r", "\n"):
                self.assertEqual(masked[idx], " ", f"{label}: unmasked char at {idx}")
        self.assertEqual(masked[end_cp:], expected_body, label)

    def _assert_companion_exports(
        self,
        root: Path,
        case_id: str,
        source: str,
        end_cp: int,
        discovered_images: list[str],
        forbidden_tokens: tuple[str, ...] | list[str] = (),
        body_probes: tuple[str, ...] | list[str] = (),
    ) -> None:
        expected_payloads = {rel_path: _make_png_bytes(f"{case_id}:{rel_path}") for rel_path in discovered_images}
        companion_assets = {rel_path: _png_data_url(raw) for rel_path, raw in expected_payloads.items()}

        export_dir = root / "companion-dir"
        export_dir.mkdir()
        note_md = export_dir / "note.md"
        write_markdown_export(note_md, source, companion_assets, create_only=True)

        exported_text = note_md.read_bytes().decode("utf-8")
        self.assertEqual(exported_text, source, case_id)
        self.assertEqual(exported_text[:end_cp], source[:end_cp], case_id)
        self.assertEqual(exported_text[end_cp:], source[end_cp:], case_id)
        for probe in body_probes:
            self.assertEqual(exported_text.index(probe, end_cp), source.index(probe, end_cp), case_id)

        written_files = {
            path.relative_to(export_dir).as_posix()
            for path in export_dir.rglob("*")
            if path.is_file()
        }
        self.assertEqual(written_files, {"note.md", *discovered_images}, case_id)
        for rel_path, expected_bytes in expected_payloads.items():
            self.assertEqual((export_dir / rel_path).read_bytes(), expected_bytes, case_id)
        for forbidden in forbidden_tokens:
            self.assertNotIn(forbidden, companion_assets, case_id)
            if forbidden.endswith((".png", ".svg", ".gif", ".jpg", ".jpeg", ".webp", ".avif")):
                self.assertFalse((export_dir / forbidden).exists(), case_id)

        zip_dir = root / "companion-zip"
        zip_dir.mkdir()
        bundle_zip = zip_dir / "bundle.zip"
        write_markdown_zip(
            bundle_zip,
            source,
            companion_assets,
            create_only=True,
            markdown_filename="note.md",
        )
        with zipfile.ZipFile(bundle_zip) as archive:
            self.assertEqual(archive.namelist(), ["note.md", *discovered_images], case_id)
            self.assertEqual(archive.read("note.md").decode("utf-8"), source, case_id)
            for rel_path, expected_bytes in expected_payloads.items():
                self.assertEqual(archive.read(rel_path), expected_bytes, case_id)

    def test_corpus_schema_and_category_coverage(self) -> None:
        self.assertEqual(self.corpus["version"], 1)
        self.assertEqual(
            self.corpus["companionConformanceFixture"],
            "test-fixtures/frontmatter-conformance.json",
        )
        seen_ids: set[str] = set()
        for entry in [*self.shared_cases, *self.divergences]:
            case_id = entry["id"]
            self.assertNotIn(case_id, seen_ids, f"duplicate corpus ID: {case_id}")
            seen_ids.add(case_id)
        for entry in self.divergences:
            self.assertIsInstance(entry["alignedInPr186"], bool, entry["id"])
        for category in REQUIRED_CATEGORIES:
            self.assertTrue(
                any(c["category"] == category and c["recognized"] for c in self.shared_cases),
                f"missing positive shared case for {category}",
            )
            self.assertTrue(
                any(c["category"] == category and not c["recognized"] for c in self.shared_cases),
                f"missing negative shared case for {category}",
            )
        if self.conformance is not None:
            self.assertEqual(self.conformance["version"], 1)
            conformance_ids = {case["id"] for case in self.conformance["cases"]}
            self.assertTrue(
                seen_ids.isdisjoint(conformance_ids),
                f"overlapping fixture IDs with frontmatter-conformance.json: {seen_ids & conformance_ids}",
            )
            for entry in self.divergences:
                if "conformanceCaseId" in entry:
                    self.assertIn(entry["conformanceCaseId"], conformance_ids, entry["id"])

    def test_shared_cases_recognition_masking_and_active_exports(self) -> None:
        try:
            native_engine = find_engine()
        except AgentDocumentError:
            native_engine = None

        with tempfile.TemporaryDirectory(prefix="supermd-fm-corpus-") as temp_name:
            temp_root = Path(temp_name)
            for index, item in enumerate(self.shared_cases):
                case_id = item["id"]
                source = item["source"]
                case_root = temp_root / f"shared-{index}"
                case_root.mkdir()
                with self.subTest(id=case_id, category=item["category"]):
                    end = frontmatter_end(source)
                    masked = mask_frontmatter(source)
                    stripped = strip_frontmatter(source)

                    if not item["recognized"]:
                        self.assertEqual(end, 0)
                        self.assertEqual(stripped, source)
                        self.assertEqual(masked, source)
                        self.assertEqual(item["endOffset"]["codePoints"], 0)
                    else:
                        self.assertGreater(end, 0)
                        self.assertEqual(end, item["endOffset"]["codePoints"])
                        self.assertEqual(_utf16_len(source[:end]), item["endOffset"]["utf16"])
                        self.assertEqual(source[:end], item["frontmatterRaw"])
                        self.assertEqual(stripped, item["body"])
                        self.assertEqual(source[:end] + stripped, source)
                        self._assert_mask_invariants(source, masked, end, item["body"], case_id)

                        cleaned_masked = _clean_markdown_images(masked)
                        for forbidden in item.get("maskedExcludes", ()):
                            self.assertNotIn(forbidden, masked)
                            self.assertNotIn(forbidden, stripped)
                            self.assertNotIn(forbidden, cleaned_masked)

                        headings, fences = _scan_read_only(
                            masked,
                            collect_headings=True,
                            collect_fences=True,
                        )
                        for heading in headings:
                            self.assertGreaterEqual(heading["start"], end)
                            self.assertTrue(source[heading["start"]:].startswith("#"))
                        for fence in fences:
                            self.assertGreaterEqual(fence.fence_start, end)

                    for probe in item.get("bodyProbes", ()):
                        expected_idx = source.index(probe, end)
                        self.assertEqual(masked.index(probe, end), expected_idx)

                    discovered_images = _image_destinations(source)
                    if "bodyImages" in item:
                        expected_images = item["bodyImages"]
                        self.assertEqual(discovered_images, expected_images)
                        for img_source in expected_images:
                            body_img_offset = source.index(img_source, end)
                            self.assertGreaterEqual(body_img_offset, end)
                            self.assertEqual(masked.index(img_source, end), body_img_offset)

                        workspace_dir = case_root / "workspace"
                        workspace_dir.mkdir()
                        store = DocumentStore([workspace_dir])
                        expected_raw_by_path: dict[str, bytes] = {}
                        for rel_path in expected_images:
                            raw_png = _make_png_bytes(f"agent:{case_id}:{rel_path}")
                            expected_raw_by_path[rel_path] = raw_png
                            asset_file = workspace_dir / rel_path
                            asset_file.parent.mkdir(parents=True, exist_ok=True)
                            asset_file.write_bytes(raw_png)

                        note_md = workspace_dir / "note.md"
                        note_md.write_bytes(source.encode("utf-8"))
                        resolved_assets = _resolve_image_assets(store, note_md, source, {})
                        self.assertEqual(list(resolved_assets.keys()), expected_images)
                        for rel_path, raw_png in expected_raw_by_path.items():
                            self.assertEqual(base64.b64decode(resolved_assets[rel_path]), raw_png)

                        if all(documents._SAFE_ASSET_NAME.fullmatch(p) for p in expected_images):
                            embedded = {
                                rel_path: _png_data_url(raw_png)
                                for rel_path, raw_png in expected_raw_by_path.items()
                            }
                            source_smd = workspace_dir / "source.smd"
                            source_smd.write_bytes(documents.compressed_bundle(source, embedded))
                            export_result = export_smd(store, "source.smd", "exported.smd")
                            self.assertEqual(export_result["format"], "supermd-smd")
                            unpacked_md, unpacked_assets, portable = documents.open_note(workspace_dir / "exported.smd")
                            self.assertTrue(portable)
                            self.assertEqual(unpacked_md, source)
                            self.assertEqual(set(unpacked_assets.keys()), set(expected_images))
                        elif native_engine is not None and item["recognized"]:
                            export_result = export_smd(store, "note.md", "exported.smd", engine=native_engine)
                            self.assertEqual(export_result["format"], "supermd-smd")
                            unpacked_md, unpacked_assets, portable = documents.open_note(workspace_dir / "exported.smd")
                            self.assertTrue(portable)
                            expected_front = source[:end].removeprefix("\ufeff")
                            self.assertEqual(unpacked_md[:len(expected_front)], expected_front)
                            self.assertEqual(len(unpacked_assets), len(expected_images))
                    elif not discovered_images:
                        workspace_dir = case_root / "workspace"
                        workspace_dir.mkdir()
                        store = DocumentStore([workspace_dir])
                        note_md = workspace_dir / "note.md"
                        note_md.write_bytes(source.encode("utf-8"))
                        export_result = export_smd(store, "note.md", "exported.smd")
                        self.assertEqual(export_result["format"], "supermd-smd")
                        unpacked_md, unpacked_assets, portable = documents.open_note(workspace_dir / "exported.smd")
                        self.assertTrue(portable)
                        self.assertEqual(unpacked_md, source.removeprefix("\ufeff"))
                        self.assertEqual(unpacked_assets, {})

                    if "unsupportedDiagrams" in item:
                        self.assertEqual(
                            _contains_unsupported_diagrams(source),
                            item["unsupportedDiagrams"],
                        )

                    self._assert_companion_exports(
                        case_root,
                        case_id,
                        source,
                        end,
                        discovered_images,
                        item.get("maskedExcludes", ()),
                        item.get("bodyProbes", ()),
                    )

    def test_recorded_cross_parser_divergences(self) -> None:
        pr186_aligned = _pr186_desktop_aligned()
        with tempfile.TemporaryDirectory(prefix="supermd-fm-divergences-") as temp_name:
            temp_root = Path(temp_name)
            for index, entry in enumerate(self.divergences):
                case_id = entry["id"]
                source = entry["source"]
                desktop = entry["desktop"]
                ts = entry["typescript"]
                case_root = temp_root / f"div-{index}"
                case_root.mkdir()
                with self.subTest(id=case_id, category=entry["category"]):
                    self.assertNotEqual(desktop["recognized"], ts["recognized"], entry["reason"])
                    if pr186_aligned and entry["alignedInPr186"]:
                        expected_recognized = ts["recognized"]
                        expected_raw = ts["frontmatterRaw"]
                        expected_body = ts["body"]
                        expected_end_cp = len(expected_raw)
                    else:
                        expected_recognized = desktop["recognized"]
                        expected_raw = desktop["frontmatterRaw"]
                        expected_body = desktop["body"]
                        expected_end_cp = desktop["endCodePoints"]

                    end = frontmatter_end(source)
                    masked = mask_frontmatter(source)
                    stripped = strip_frontmatter(source)

                    if not expected_recognized:
                        self.assertEqual(end, 0)
                        self.assertEqual(stripped, source)
                        self.assertEqual(masked, source)
                    else:
                        self.assertGreater(end, 0)
                        self.assertEqual(end, expected_end_cp)
                        self.assertEqual(source[:end], expected_raw)
                        self.assertEqual(stripped, expected_body)
                        self._assert_mask_invariants(source, masked, end, expected_body, case_id)

                    self._assert_companion_exports(
                        case_root,
                        case_id,
                        source,
                        end,
                        _image_destinations(source),
                    )

    def test_pr186_conformance_fixture_companion_exports_when_present(self) -> None:
        if self.conformance is None or not _pr186_desktop_aligned():
            return
        with tempfile.TemporaryDirectory(prefix="supermd-fm-conformance-") as temp_name:
            temp_root = Path(temp_name)
            for index, case in enumerate(self.conformance["cases"]):
                case_id = case["id"]
                source = case["markdown"]
                expected_body = case["body"]
                case_root = temp_root / f"conf-{index}"
                case_root.mkdir()
                with self.subTest(id=case_id):
                    end = frontmatter_end(source)
                    masked = mask_frontmatter(source)
                    stripped = strip_frontmatter(source)
                    if not case["valid"]:
                        self.assertEqual(end, 0)
                        self.assertEqual(stripped, source)
                        self.assertEqual(masked, source)
                    else:
                        self.assertGreater(end, 0)
                        self.assertEqual(stripped, expected_body)
                        self._assert_mask_invariants(source, masked, end, expected_body, case_id)
                    self._assert_companion_exports(
                        case_root,
                        case_id,
                        source,
                        end,
                        _image_destinations(source),
                    )


if __name__ == "__main__":
    unittest.main()
