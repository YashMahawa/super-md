import tempfile
import unittest
from pathlib import Path

from export_jobs import ExportCancelled, ExportJobRegistry


class FakeProcess:
    def __init__(self, running=True):
        self.running = running
        self.terminated = 0

    def poll(self):
        return None if self.running else 0

    def terminate(self):
        self.terminated += 1
        self.running = False


class ExportJobsTest(unittest.TestCase):
    def test_cancel_owns_only_the_requested_jobs_process(self):
        registry = ExportJobRegistry()
        first = registry.register("first")
        second = registry.register("second")
        first_process, second_process = FakeProcess(), FakeProcess()
        first.attach_process(first_process)
        second.attach_process(second_process)

        self.assertTrue(registry.cancel("first"))
        self.assertEqual(first_process.terminated, 1)
        self.assertEqual(second_process.terminated, 0)
        self.assertTrue(first.cancelled.is_set())
        self.assertFalse(second.cancelled.is_set())

    def test_cancel_before_promotion_preserves_existing_destination(self):
        with tempfile.TemporaryDirectory() as temporary:
            destination = Path(temporary) / "report.pdf"
            stage = Path(temporary) / ".report.unique.stage.pdf"
            destination.write_bytes(b"old pdf")
            stage.write_bytes(b"%PDF-new")
            job = ExportJobRegistry().register("job")

            self.assertTrue(job.cancel())
            with self.assertRaises(ExportCancelled):
                job.promote(stage, destination)
            self.assertEqual(destination.read_bytes(), b"old pdf")
            self.assertTrue(stage.exists())

    def test_cancel_after_promotion_returns_success_state(self):
        with tempfile.TemporaryDirectory() as temporary:
            destination = Path(temporary) / "report.pdf"
            stage = Path(temporary) / ".report.unique.stage.pdf"
            destination.write_bytes(b"old pdf")
            stage.write_bytes(b"%PDF-new")
            job = ExportJobRegistry().register("job")

            job.promote(stage, destination)
            self.assertTrue(job.promoted)
            self.assertFalse(job.cancel())
            self.assertEqual(destination.read_bytes(), b"%PDF-new")

    def test_registry_rejects_duplicate_and_unbounded_identifiers(self):
        registry = ExportJobRegistry()
        registry.register("same")
        with self.assertRaises(ValueError):
            registry.register("same")
        with self.assertRaises(ValueError):
            registry.register("x" * 129)


if __name__ == "__main__":
    unittest.main()
