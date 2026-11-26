"""Cross-runtime YAML frontmatter conformance suite for Desktop Python."""
from __future__ import annotations

import json
import unittest
from pathlib import Path

from frontmatter import frontmatter_end, mask_frontmatter, strip_frontmatter

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
                if case["valid"]:
                    self.assertGreater(end, 0)
                    self.assertEqual(md[end:], expected_body)
                    self.assertEqual(md[:end] + expected_body, md)
                else:
                    self.assertEqual(end, 0)

                self.assertEqual(strip_frontmatter(md), expected_body)
                masked = mask_frontmatter(md)
                self.assertEqual(len(masked), len(md))
                self.assertEqual(masked[end:], expected_body)
                for idx, ch in enumerate(md[:end]):
                    self.assertEqual(masked[idx], ch if ch in ("\r", "\n") else " ")


if __name__ == "__main__":
    unittest.main()
