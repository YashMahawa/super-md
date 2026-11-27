import json
import sys
import tempfile
import unittest
from pathlib import Path

DESKTOP_DIR = Path(__file__).resolve().parent
if str(DESKTOP_DIR) not in sys.path:
    sys.path.insert(0, str(DESKTOP_DIR))

import agent_documents  # noqa: E402
from agent_documents import DocumentStore, _headings, resolve_heading  # noqa: E402

FIXTURE_PATH = DESKTOP_DIR.parent / "test-fixtures" / "heading-slug-conformance.json"


class HeadingSlugConformanceTest(unittest.TestCase):
    def test_agent_heading_slug_matches_shared_conformance_corpus(self):
        suite = json.loads(FIXTURE_PATH.read_text(encoding="utf-8"))
        self.assertEqual(suite["version"], 1)
        self.assertTrue(24 <= len(suite["cases"]) <= 30)
        self.assertTrue(any(c["documentSlug"] != c["agentSlug"] for c in suite["cases"]))
        for case in suite["cases"]:
            with self.subTest(case=case["id"]):
                self.assertEqual(agent_documents._heading_slug(case["input"]), case["agentSlug"])

    def test_compatibility_headings_resolve_by_title_and_slug_in_document_store(self):
        source = (
            "# Overview\nIntro.\n\n"
            "## ℍ₂O & ℝ² Space\nVector space notes.\n\n"
            "## Trade™ 100㎐\nFrequency spec.\n"
        )
        headings = _headings(source, include_internal=True)
        self.assertEqual(resolve_heading(headings, "ℍ₂O & ℝ² Space")["index"], 1)
        self.assertEqual(resolve_heading(headings, "h2o-r2-space")["index"], 1)
        self.assertEqual(resolve_heading(headings, "Trade™ 100㎐")["index"], 2)
        self.assertEqual(resolve_heading(headings, "tradetm-100hz")["index"], 2)

        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "note.md").write_text(source, encoding="utf-8")
            store = DocumentStore([root])
            math_sec = store.read("note.md", heading="h2o-r2-space")
            self.assertEqual(math_sec["text"], "## ℍ₂O & ℝ² Space\nVector space notes.\n\n")
            hz_sec = store.read("note.md", heading="tradetm-100hz")
            self.assertEqual(hz_sec["text"], "## Trade™ 100㎐\nFrequency spec.\n")
            exact_sec = store.read("note.md", heading="ℍ₂O & ℝ² Space")
            self.assertEqual(exact_sec["text"], math_sec["text"])


if __name__ == "__main__":
    unittest.main()
