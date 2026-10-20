import base64
import tempfile
import unittest
from unittest.mock import patch
from pathlib import Path
from python_outputs import PythonOutputs

class PythonOutputsTest(unittest.TestCase):
    def test_disk_output_survives_ram_eviction_without_changing_source(self):
        with tempfile.TemporaryDirectory() as directory:
            store=PythonOutputs(Path(directory)/"derived")
            source="print('λ') # ../../not-a-path"
            result={"ok":True,"stdout":"λ\n","stderr":"","images":["data:image/svg+xml;base64,"+base64.b64encode(b"<svg/>").decode()]}
            self.assertIsNone(store.load(source));store.store(source,result)
            self.assertEqual(PythonOutputs(store.root).load(source),result)
            self.assertEqual(len(list(store.root.iterdir())),1)
            with self.assertRaises(ValueError):store.store(source,{**result,"images":["javascript:bad"]})
            self.assertEqual(store.load(source),result)

    def test_context_scopes_document_cell_and_interpreter_and_persists_provenance(self):
        with tempfile.TemporaryDirectory() as directory:
            store=PythonOutputs(Path(directory)/"derived")
            source="print('same source')"
            contexts=[
                {"document":"doc-a","cell":"cell-1","interpreter":"python-3.13"},
                {"document":"doc-b","cell":"cell-1","interpreter":"python-3.13"},
                {"document":"doc-a","cell":"cell-2","interpreter":"python-3.13"},
                {"document":"doc-a","cell":"cell-1","interpreter":"python-3.12"},
            ]
            results=[]
            for index,context in enumerate(contexts):
                result={"ok":True,"stdout":str(index),"stderr":"","images":[],"provenance":{"verified":True,"document":"forged"}}
                results.append({key:result[key] for key in ("ok","stdout","stderr","images")})
                store.store(source,result,context)
            self.assertEqual(len(list(store.root.iterdir())),len(contexts))
            for context,result in zip(contexts,results):
                loaded=PythonOutputs(store.root).load(source,context)
                self.assertEqual(loaded["result"],result)
                self.assertEqual(loaded["provenance"]["verified"],True)
                self.assertEqual(loaded["provenance"]["document"],context["document"])
                self.assertEqual(loaded["provenance"]["cell"],context["cell"])
                self.assertEqual(loaded["provenance"]["interpreter"],context["interpreter"])
                self.assertTrue(loaded["provenance"]["savedAt"].endswith("Z"))

    def test_context_miss_uses_legacy_with_warning_without_migrating_or_deleting(self):
        with tempfile.TemporaryDirectory() as directory:
            store=PythonOutputs(Path(directory)/"derived")
            source="legacy source"
            context={"document":"doc","cell":"cell","interpreter":"python"}
            result={"ok":False,"stdout":"old","stderr":"","images":[]}
            store.store(source,result)
            legacy_file=store._path(source)
            original=legacy_file.read_bytes()
            loaded=store.load(source,context)
            self.assertEqual(loaded["result"],result)
            self.assertEqual(loaded["provenance"],{"verified":False,"reason":"Legacy saved output; document and runtime were not recorded"})
            self.assertEqual(legacy_file.read_bytes(),original)
            self.assertEqual(len(list(store.root.iterdir())),1)
            self.assertEqual(store.load(source),result)

    def test_invalid_context_and_atomic_failure_do_not_damage_existing_output(self):
        with tempfile.TemporaryDirectory() as directory:
            store=PythonOutputs(Path(directory)/"derived")
            source="source"
            valid={"document":"doc","cell":"cell","interpreter":"python"}
            result={"ok":True,"stdout":"before","stderr":"","images":[]}
            store.store(source,result,valid)
            for invalid in (
                {"document":"doc","cell":"cell"},
                {**valid,"extra":"x"},
                {**valid,"document":""},
                {**valid,"cell":"x"*513},
            ):
                with self.assertRaises(ValueError):store.load(source,invalid)
            with patch("python_outputs.atomic_json",side_effect=OSError("disk full")):
                with self.assertRaises(OSError):store.store(source,{**result,"stdout":"after"},valid)
            self.assertEqual(store.load(source,valid)["result"],result)
            self.assertEqual(len(list(store.root.iterdir())),1)
