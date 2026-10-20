import unittest

from pending_python import PendingPythonProofs


class FakeClock:
    def __init__(self):
        self.now = 0.0

    def __call__(self):
        return self.now


class PendingPythonProofsTest(unittest.TestCase):
    def setUp(self):
        self.clock = FakeClock()
        self.proofs = PendingPythonProofs(clock=self.clock, max_entries=2, ttl_seconds=10)
        self.context = {"document": "/notes/a.md", "cell": "1", "interpreter": "embedded"}
        self.result = {"stdout": "hello", "stderr": "", "images": ["data:image/png;base64,AAAA"], "ok": True}

    def test_matches_only_exact_source_context_and_result_fields(self):
        self.proofs.remember("print('hello')", self.result, self.context)
        self.assertTrue(self.proofs.matches("print('hello')", self.result, self.context))
        self.assertFalse(self.proofs.matches("print('other')", self.result, self.context))
        self.assertFalse(self.proofs.matches("print('hello')", {**self.result, "stdout": "changed"}, self.context))
        other_context = {**self.context, "cell": "2"}
        self.assertFalse(self.proofs.matches("print('hello')", self.result, other_context))

    def test_provenance_is_ignored_not_used_as_a_proof(self):
        self.proofs.remember("code", self.result, self.context)
        forged = {**self.result, "provenance": {"verified": True, "document": "/wrong.md"}}
        self.assertTrue(self.proofs.matches("code", forged, self.context))
        altered_payload = {**forged, "images": ["data:image/png;base64,BBBB"]}
        self.assertFalse(self.proofs.matches("code", altered_payload, self.context))

    def test_expiry_and_lru_capacity_are_bounded(self):
        self.proofs.remember("one", self.result, self.context)
        self.proofs.remember("two", self.result, self.context)
        self.assertTrue(self.proofs.matches("one", self.result, self.context))  # Refresh one in LRU order.
        self.proofs.remember("three", self.result, self.context)
        self.assertTrue(self.proofs.matches("one", self.result, self.context))
        self.assertFalse(self.proofs.matches("two", self.result, self.context))
        self.clock.now = 10
        self.assertFalse(self.proofs.matches("one", self.result, self.context))
        self.assertFalse(self.proofs.matches("three", self.result, self.context))

    def test_forget_clear_and_invalid_context(self):
        self.proofs.remember("code", self.result, self.context)
        self.proofs.forget("code", self.context)
        self.assertFalse(self.proofs.matches("code", self.result, self.context))
        self.proofs.remember("code", self.result, self.context)
        self.proofs.clear()
        self.assertFalse(self.proofs.matches("code", self.result, self.context))
        with self.assertRaises(ValueError):
            self.proofs.remember("code", self.result, {"document": "/notes/a.md"})


if __name__ == "__main__":
    unittest.main()
