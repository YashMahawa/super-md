"""Subprocess workflows for the headless CLI with large SVG notes and Unicode paths."""
import base64
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from documents import compressed_bundle, open_note
from agent_documents import _svg_spans


class AgentCLIWorkflowTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="supermd-cli-workflow-")
        self.root = Path(self.temp.name)
        self.cli = Path(__file__).with_name("agent_cli.py")
        self.python = sys.executable

    def tearDown(self):
        self.temp.cleanup()

    def run_cli(self, *args, ok=True):
        completed = subprocess.run([self.python, str(self.cli), "--root", str(self.root), *map(str, args)],
                                   capture_output=True, text=True, check=False)
        self.assertEqual(completed.returncode == 0, ok, completed.stderr + completed.stdout[:500])
        self.assertLessEqual(len(completed.stdout.encode("utf-8")), 64_000)
        value = json.loads(completed.stdout)
        self.assertEqual(value["ok"], ok)
        return value

    def test_large_smd_prose_source_stale_and_targeted_edits_are_bounded(self):
        block = "<svg xmlns='http://www.w3.org/2000/svg'>\n" + "\n".join(
            f"<path id='p{index}' d='M{index} {index} L{index + 1} {index + 2}'/>" for index in range(26_000)
        ) + "\n</svg>"
        markdown = "# A4 report\n\nIntro text 🧭.\n\n```svg\n" + block + "\n```\n\n## Summary\nReviewable text.\n"
        note = self.root / "A4 report copy.smd"
        note.write_bytes(compressed_bundle(markdown, {}))
        self.assertGreater(len(markdown), 1_000_000)
        spans = _svg_spans(markdown)
        self.assertEqual(len(spans), 1)

        info = self.run_cli("inspect", note.name)["result"]
        start = spans[0]["start"]
        prose = self.run_cli("read", note.name, "--offset", start, "--limit", 12_000)["result"]
        source = self.run_cli("read", note.name, "--offset", start, "--limit", 400, "--view", "source")["result"]
        self.assertNotIn("<svg", prose["text"].lower())
        self.assertLess(len(prose["text"]), 200)
        self.assertEqual(prose["start"], start)
        self.assertEqual(source["text"], markdown[start:start + 400])

        search = self.run_cli("search", note.name, "Reviewable", "--limit", 3)["result"]
        self.assertEqual(search["matches"][0]["line"], 26_011)
        line_count = info["lines"]
        patched = self.run_cli("patch", note.name, "--revision", info["revision"], "--operations-json",
                               json.dumps([{"type": "lines", "start_line": line_count + 1,
                                            "end_line": line_count + 1,
                                            "text": "\n<!-- cli workflow -->\n"}]))["result"]
        self.assertTrue(patched["saved"])
        stale = self.run_cli("patch", note.name, "--revision", info["revision"], "--operations-json",
                             json.dumps([{"type": "replace", "old": "Reviewable", "new": "stale"}]), ok=False)
        self.assertIn("changed", stale["error"]["message"].lower())

    def test_unicode_asset_paths_replacement_and_repeated_replace_policy(self):
        source = "# Figure\n\n![diagram](assets/figure.svg)\n"
        created = self.run_cli("create", "Unicode notes.smd", "--content", source)["result"]
        first = self.root / "图形 sample Ω.svg"
        second = self.root / "replacement sample.svg"
        original_svg = b"<svg xmlns='http://www.w3.org/2000/svg'><path d='M0 0'/></svg>"
        replacement_svg = b"<svg xmlns='http://www.w3.org/2000/svg'><circle r='3'/></svg>"
        first.write_bytes(original_svg)
        second.write_bytes(replacement_svg)
        attached = self.run_cli("attach", "Unicode notes.smd", first.name, "--revision",
                                created["revision"])["result"]
        asset = self.run_cli("assets", "Unicode notes.smd")["result"]["assets"][0]
        replaced = self.run_cli("replace-asset", "Unicode notes.smd", asset["id"], second.name,
                                "--revision", attached["revision"])["result"]
        markdown, assets, portable = open_note(self.root / "Unicode notes.smd")
        self.assertTrue(portable)
        self.assertEqual(markdown, source)
        self.assertEqual(replaced["asset"]["id"], asset["id"])
        self.assertEqual(base64.b64decode(assets[asset["name"]].split(",", 1)[1]), replacement_svg)

        repeated = self.run_cli("create", "repeat.md", "--content", "same same\n")["result"]
        before = (self.root / "repeat.md").read_bytes()
        self.run_cli("patch", "repeat.md", "--revision", repeated["revision"], "--operations-json",
                     json.dumps([{"type": "replace", "old": "same", "new": "new"}]), ok=False)
        self.assertEqual((self.root / "repeat.md").read_bytes(), before)
        saved = self.run_cli("patch", "repeat.md", "--revision", repeated["revision"], "--operations-json",
                             json.dumps([{"type": "replace", "old": "same", "new": "new", "count": "all"}]))
        self.assertTrue(saved["result"]["saved"])
        self.assertEqual((self.root / "repeat.md").read_text(encoding="utf-8"), "new new\n")


if __name__ == "__main__":
    unittest.main()
