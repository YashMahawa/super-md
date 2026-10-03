import base64
import tempfile
import unittest
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
