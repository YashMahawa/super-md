"""Cross-runtime YAML frontmatter conformance suite for Desktop Python."""
from __future__ import annotations

import json
import unittest
from pathlib import Path

from frontmatter import (
    _parse_frontmatter_entries,
    extract_visible_metadata,
    frontmatter_end,
    mask_frontmatter,
    parse_frontmatter,
    strip_frontmatter,
)

_FIXTURE_PATH = Path(__file__).resolve().parent.parent / "test-fixtures" / "frontmatter-conformance.json"


class TestFrontmatterConformance(unittest.TestCase):
    def test_shared_conformance_vectors(self) -> None:
        suite = json.loads(_FIXTURE_PATH.read_text(encoding="utf-8"))
        self.assertEqual(suite["version"], 1)
        self.assertGreaterEqual(len(suite["cases"]), 20)

        for case in suite["cases"]:
            with self.subTest(case=case["id"]):
                md: str = case["markdown"]
                expected_body: str = case["body"]
                end = frontmatter_end(md)
                entries_end, entries = _parse_frontmatter_entries(md)
                parsed_end, props = parse_frontmatter(md)
                self.assertEqual(entries_end, end)
                self.assertEqual(parsed_end, end)
                self.assertEqual(extract_visible_metadata(md), props)

                if case["valid"]:
                    self.assertGreater(end, 0)
                    self.assertEqual(md[end:], expected_body)
                    self.assertEqual(md[:end] + expected_body, md)
                    self.assertEqual(entries, case["entries"])
                    expected_meta = case["metadata"]
                    if expected_meta is None:
                        self.assertIsNone(props)
                    else:
                        expected_props: dict[str, object] = {}
                        if expected_meta["title"]:
                            expected_props["title"] = expected_meta["title"]
                        if expected_meta["authors"]:
                            expected_props["author"] = ", ".join(expected_meta["authors"])
                            expected_props["authors"] = expected_meta["authors"]
                        if expected_meta["tags"]:
                            expected_props["tags"] = expected_meta["tags"]
                        self.assertEqual(props, expected_props or None)
                else:
                    self.assertEqual(end, 0)
                    self.assertIsNone(entries)
                    self.assertIsNone(props)

                self.assertEqual(strip_frontmatter(md), expected_body)
                masked = mask_frontmatter(md)
                self.assertEqual(len(masked), len(md))
                self.assertEqual(masked[end:], expected_body)
                for idx, ch in enumerate(md[:end]):
                    self.assertEqual(masked[idx], ch if ch in ("\r", "\n") else " ")


if __name__ == "__main__":
    unittest.main()
