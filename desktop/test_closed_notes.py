import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from closed_notes import ClosedNoteStore


class ClosedNoteStoreTest(unittest.TestCase):
    def test_large_dirty_portable_note_round_trips_without_loss(self):
        with tempfile.TemporaryDirectory() as directory:
            store=ClosedNoteStore(Path(directory)/"closed")
            note={"id":"note-1","name":"Huge.smd","path":"/notes/Huge.smd",
                  "content":"λ"*(5*1024*1024),"saved":"older saved text",
                  "assets":{"assets/figure.svg":"data:image/svg+xml;base64,PHN2Zy8+"},
                  "portable":True,"undoRevision":{"sequence":17}}
            reference=store.save(note)
            store.save_index([reference])
            self.assertEqual(store.load(reference),note)
            self.assertEqual(store.load_index(),[reference])

    def test_snapshot_tokens_are_immutable_and_index_only_keeps_twelve_refs(self):
        with tempfile.TemporaryDirectory() as directory:
            store=ClosedNoteStore(Path(directory)/"closed")
            refs=[]
            for index in range(14):
                refs.append(store.save({"id":f"note-{index}","name":"Note.md","content":str(index),"saved":""}))
            store.save_index(list(reversed(refs)))
            self.assertEqual(len(store.load_index()),12)
            self.assertEqual(store.load(refs[0])["content"],"0")
            self.assertEqual(store.load(refs[-1])["content"],"13")
            self.assertEqual(len(list(store.root.glob("snapshot-*.json"))),14)

    def test_atomic_snapshot_failure_does_not_publish_a_reference(self):
        with tempfile.TemporaryDirectory() as directory:
            store=ClosedNoteStore(Path(directory)/"closed")
            with patch("documents.os.replace",side_effect=OSError("disk full")):
                with self.assertRaises(OSError):store.save({"id":"note-1","content":"valuable"})
            self.assertEqual(list(store.root.glob("snapshot-*.json")),[])
            self.assertEqual(store.load_index(),[])
