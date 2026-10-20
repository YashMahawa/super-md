import unittest
from reader_edits import ReaderEdits


class ReaderEditTests(unittest.TestCase):
    def setUp(self):
        self.protocol = ReaderEdits()
        self.content = "A😀é\r\nZ"
        self.base = {"id": "note", "epoch": "renderer", "revision": 0}
        self.assertTrue(self.call("document_sync", content=self.content)["accepted"])

    def call(self, command, **args):
        return self.protocol.apply(command, {**self.base, **args}, self.content, lambda value: setattr(self, "content", value))

    def test_unicode_and_duplicate(self):
        args = dict(baseRevision=0, revision=1, changes=[{"from": 1, "to": 3, "insert": "B"}, {"from": 7, "to": 8, "insert": "!"}])
        self.assertTrue(self.call("document_patch", **args)["accepted"])
        self.assertEqual(self.content, "ABé\r\n!")
        self.assertTrue(self.call("document_patch", **args)["accepted"])
        self.content = "external replacement"
        self.assertFalse(self.call("document_patch", **args)["accepted"])

    def test_atomic_invalid_range_and_surrogate(self):
        original = self.content
        for changes in ([{"from": 2, "to": 3, "insert": "x"}], [{"from": 0, "to": 1, "insert": "x"}, {"from": 0, "to": 2, "insert": "y"}]):
            self.assertFalse(self.call("document_patch", baseRevision=0, revision=1, changes=changes)["accepted"])
            self.assertEqual(self.content, original)

    def test_large_paste_keeps_only_a_small_duplicate_proof(self):
        args=dict(baseRevision=0,revision=1,changes=[{"from":0,"to":0,"insert":"large pasted content"*100000}])
        self.assertTrue(self.call("document_patch",**args)["accepted"])
        self.assertLess(len(repr(self.protocol.sessions["note"][3])),200)
        self.assertTrue(self.call("document_patch",**args)["accepted"])

    def test_divergence_and_resync(self):
        original = self.content
        self.content = "external edit"
        self.assertFalse(self.call("document_patch", baseRevision=0, revision=1, changes=[{"from": 0, "to": 1, "insert": "!"}])["accepted"])
        self.assertFalse(self.call("document_resync", bases=[original], content="renderer draft")["accepted"])
        self.assertTrue(self.call("document_resync", bases=[self.content], content="reconciled")["accepted"])

    def test_closed_epoch_and_failed_commit(self):
        args = {**self.base, "baseRevision": 0, "revision": 1, "changes": [{"from": 0, "to": 0, "insert": "!"}]}
        self.assertFalse(self.protocol.apply("document_patch", args, None, lambda _: None)["accepted"])
        self.assertFalse(self.protocol.apply("document_patch", {**args,"epoch":"other"}, self.content, lambda _:None)["accepted"])
        with self.assertRaises(OSError):
            self.protocol.apply("document_patch", args, self.content, lambda _: (_ for _ in ()).throw(OSError("disk")))
        self.assertEqual(self.protocol.sessions["note"][1], 0)
