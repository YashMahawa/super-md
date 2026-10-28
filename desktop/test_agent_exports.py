import base64
import contextlib
import io
import json
import os
import tempfile
import unittest
from pathlib import Path

from agent_documents import AgentDocumentError, DocumentStore, RevisionConflict
from agent_cli import main as agent_cli_main
from agent_exports import DEFAULT_PDF_OPTIONS, export_pdf, export_smd, find_engine, validate_pdf_options
from documents import open_note


class AgentExportsTest(unittest.TestCase):
    def test_frozen_export_engine_is_resolved_from_bundled_resources(self):
        import sys
        from unittest.mock import patch
        engine = self.root / "resources" / "desktop" / ("smd-engine.exe" if os.name == "nt" else "smd-engine")
        engine.parent.mkdir(parents=True);engine.write_bytes(b"test executable")
        with patch.object(sys, "frozen", True, create=True), patch.object(sys, "_MEIPASS", str(self.root), create=True):
            self.assertEqual(find_engine(), engine)

    @classmethod
    def setUpClass(cls):
        cls.engine = find_engine()

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.store = DocumentStore([self.root])

    def tearDown(self):
        self.temp.cleanup()

    def test_pdf_options_cover_all_desktop_controls_and_reject_invalid_values(self):
        options = validate_pdf_options({"pageSize": "letter", "margin": 22, "fontSize": 12,
                                        "lineHeight": 1.6, "paragraphSpacing": 1.2,
                                        "fontFamily": "Manrope", "pageNumbers": False,
                                        "themed": True, "themeAccent": "#123456"})
        self.assertEqual(set(options), set(DEFAULT_PDF_OPTIONS))
        self.assertEqual(options["pageSize"], "letter")
        with self.assertRaises(AgentDocumentError):
            validate_pdf_options({"fontSize": 100})
        with self.assertRaises(AgentDocumentError):
            validate_pdf_options({"unrecognized": True})

    def test_pack_md_to_smd_preserves_markdown_and_local_svg_bytes(self):
        svg = "<svg xmlns='http://www.w3.org/2000/svg'><text>Export λ</text></svg>".encode("utf-8")
        (self.root / "diagram.svg").write_bytes(svg)
        (self.root / "source.md").write_bytes(b"# Export\n\n![diagram](diagram.svg)\n")
        result = export_smd(self.store, "source.md", "portable.smd", engine=self.engine)
        markdown, assets, portable = open_note(self.root / "portable.smd")
        self.assertTrue(portable)
        self.assertEqual(markdown, "# Export\n\n![diagram](<assets/image-1.svg>)\n")
        self.assertEqual(base64.b64decode(assets["assets/image-1.svg"].split(",", 1)[1]), svg)
        self.assertGreater(result["bytes"], 0)
        self.assertEqual(result["format"], "supermd-smd")

    def test_native_pdf_export_passes_options_and_does_not_execute_python(self):
        source = self.root / "report.md"
        marker = self.root / "python-executed.txt"
        code = f"from pathlib import Path\nPath({str(marker)!r}).write_text('bad')"
        source.write_text("# Report\n\nText.\n\n```python\n" + code + "\n```\n", encoding="utf-8")
        options = {**DEFAULT_PDF_OPTIONS, "pageSize": "letter", "margin": 20, "fontSize": 12,
                   "lineHeight": 1.7, "paragraphSpacing": 1.3, "fontFamily": "Manrope",
                   "pageNumbers": False, "themed": True, "themeAccent": "#123456"}
        result = export_pdf(self.store, "report.md", "report.pdf", options=options, engine=self.engine)
        pdf = self.root / "report.pdf"
        self.assertTrue(pdf.read_bytes().startswith(b"%PDF-"))
        self.assertFalse(marker.exists())
        self.assertEqual(result["options"], options)
        self.assertEqual(result["format"], "pdf")

    def test_headless_cli_exports_json_result_and_creates_pdf(self):
        (self.root / "cli.md").write_text("# CLI export\n", encoding="utf-8")
        stdout = io.StringIO()
        with contextlib.redirect_stdout(stdout):
            status = agent_cli_main(["--root", str(self.root), "export", "cli.md", "pdf", "cli.pdf",
                                     "--engine", str(self.engine)])
        self.assertEqual(status, 0)
        result = json.loads(stdout.getvalue())
        self.assertTrue(result["ok"])
        self.assertEqual(result["result"]["format"], "pdf")
        self.assertTrue((self.root / "cli.pdf").read_bytes().startswith(b"%PDF-"))

    def test_pdf_export_keeps_exact_svg_bytes_and_refuses_unsupported_diagrams_or_overwrite(self):
        svg = b"<svg xmlns='http://www.w3.org/2000/svg' width='40' height='20'><rect width='40' height='20'/></svg>"
        (self.root / "asset.svg").write_bytes(svg)
        source = self.root / "asset.md"
        source.write_text("# Art\n\n![art](asset.svg)\n", encoding="utf-8")
        result = export_pdf(self.store, "asset.md", "art.pdf", engine=self.engine)
        self.assertTrue((self.root / "art.pdf").read_bytes().startswith(b"%PDF-"))
        self.assertGreater(result["bytes"], 0)
        with self.assertRaises(RevisionConflict):
            export_pdf(self.store, "asset.md", "art.pdf", engine=self.engine)
        chart = self.root / "chart.md"
        chart.write_text("```mermaid\ngraph TD; A-->B\n```\n", encoding="utf-8")
        with self.assertRaisesRegex(AgentDocumentError, "does not render Mermaid"):
            export_pdf(self.store, "chart.md", "chart.pdf", engine=self.engine)
        self.assertFalse((self.root / "chart.pdf").exists())


if __name__ == "__main__":
    unittest.main()
