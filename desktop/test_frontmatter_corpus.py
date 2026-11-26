"""Shared portable YAML frontmatter fixture corpus tests for Desktop Python."""
from __future__ import annotations

import json
import unittest
from pathlib import Path

try:
    from .agent_exports import _contains_unsupported_diagrams, _image_destinations
    from .frontmatter import frontmatter_end, mask_frontmatter, strip_frontmatter
    from .markdown_prepare import _mask_code, _references
except ImportError:
    from agent_exports import _contains_unsupported_diagrams, _image_destinations
    from frontmatter import frontmatter_end, mask_frontmatter, strip_frontmatter
    from markdown_prepare import _mask_code, _references

REQUIRED_CATEGORIES = (
    "quoted-scalars",
    "flow-collections",
    "folded-scalars",
    "crlf",
    "unicode-separators",
)

CORPUS_PATH = Path(__file__).resolve().parent.parent / "test-fixtures" / "frontmatter-corpus.json"


def _utf16_len(text: str) -> int:
    return len(text.encode("utf-16-le")) // 2


class FrontmatterCorpusTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.corpus = json.loads(CORPUS_PATH.read_text(encoding="utf-8"))
        cls.shared_cases = cls.corpus["sharedCases"]
        cls.divergences = cls.corpus["divergences"]

    def _assert_mask_invariants(self, source: str, masked: str, end_cp: int, expected_body: str, label: str) -> None:
        self.assertEqual(len(masked), len(source), label)
        for idx, ch in enumerate(source):
            self.assertEqual(masked[idx] == "\r", ch == "\r", f"{label}: CR mismatch at {idx}")
            self.assertEqual(masked[idx] == "\n", ch == "\n", f"{label}: LF mismatch at {idx}")
            if idx < end_cp and ch not in ("\r", "\n"):
                self.assertEqual(masked[idx], " ", f"{label}: unmasked char at {idx}")
        self.assertEqual(masked[end_cp:], expected_body, label)

    def test_corpus_schema_and_category_coverage(self) -> None:
        self.assertEqual(self.corpus["version"], 1)
        seen_ids: set[str] = set()
        for entry in [*self.shared_cases, *self.divergences]:
            case_id = entry["id"]
            self.assertNotIn(case_id, seen_ids, f"duplicate corpus ID: {case_id}")
            seen_ids.add(case_id)
        for category in REQUIRED_CATEGORIES:
            self.assertTrue(
                any(c["category"] == category and c["recognized"] for c in self.shared_cases),
                f"missing positive shared case for {category}",
            )
            self.assertTrue(
                any(c["category"] == category and not c["recognized"] for c in self.shared_cases),
                f"missing negative shared case for {category}",
            )

    def test_shared_cases_recognition_masking_and_boundaries(self) -> None:
        for item in self.shared_cases:
            case_id = item["id"]
            source = item["source"]
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

                    code_masked = _mask_code(source)
                    self.assertEqual(len(code_masked), len(source))
                    for forbidden in item.get("maskedExcludes", ()):
                        self.assertNotIn(forbidden, masked)
                        self.assertNotIn(forbidden, code_masked)

                for probe in item.get("bodyProbes", ()):
                    expected_idx = source.index(probe, end)
                    self.assertEqual(masked.index(probe, end), expected_idx)

                if "bodyImages" in item:
                    expected_images = item["bodyImages"]
                    self.assertEqual(_image_destinations(source), expected_images)
                    prep_refs = [ref for ref in _references(source) if ref.kind == "image"]
                    self.assertEqual([ref.source for ref in prep_refs], expected_images)
                    for ref in prep_refs:
                        self.assertGreaterEqual(ref.start, end)
                        self.assertIn(ref.source, source[ref.start:ref.end])

                if "unsupportedDiagrams" in item:
                    self.assertEqual(_contains_unsupported_diagrams(source), item["unsupportedDiagrams"])

    def test_recorded_cross_parser_divergences(self) -> None:
        for entry in self.divergences:
            case_id = entry["id"]
            source = entry["source"]
            desktop = entry["desktop"]
            ts = entry["typescript"]
            with self.subTest(id=case_id, category=entry["category"]):
                self.assertNotEqual(desktop["recognized"], ts["recognized"], entry["reason"])
                end = frontmatter_end(source)
                masked = mask_frontmatter(source)
                stripped = strip_frontmatter(source)

                if not desktop["recognized"]:
                    self.assertEqual(end, 0)
                    self.assertEqual(stripped, source)
                    self.assertEqual(masked, source)
                else:
                    self.assertGreater(end, 0)
                    self.assertEqual(end, desktop["endCodePoints"])
                    self.assertEqual(source[:end], desktop["frontmatterRaw"])
                    self.assertEqual(stripped, desktop["body"])
                    self._assert_mask_invariants(source, masked, end, desktop["body"], case_id)


if __name__ == "__main__":
    unittest.main()
