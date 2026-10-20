import threading
import time
import unittest

from latest_writes import LatestWriteExecutor


class LatestWriteExecutorTest(unittest.TestCase):
    def test_many_replacements_keep_only_two_latest_slots(self):
        writer = LatestWriteExecutor()
        started = threading.Event()
        release = threading.Event()
        written = []

        def block():
            started.set()
            release.wait(2)

        first = writer.submit(block)
        self.assertTrue(started.wait(1))
        for index in range(500):
            writer.submit_latest("startup", lambda value=index: written.append(("startup", value)))
            writer.submit_latest("recovery", lambda value=index: written.append(("recovery", value)))
        self.assertEqual(writer.pending_count, 2)

        release.set()
        writer.shutdown(wait=True)
        first.result(timeout=1)
        self.assertEqual(set(written), {("startup", 499), ("recovery", 499)})
        self.assertEqual(len(written), 2)

    def test_continuation_yields_to_actual_fifo_save(self):
        writer = LatestWriteExecutor()
        first_started = threading.Event()
        release_first = threading.Event()
        order = []

        def first_snapshot():
            order.append("first-snapshot")
            first_started.set()
            release_first.wait(2)

        writer.submit_latest("recovery", first_snapshot)
        self.assertTrue(first_started.wait(1))
        manual_save = writer.submit(lambda: order.append("manual-save"))
        writer.submit_latest("recovery", lambda: order.append("latest-snapshot"))
        release_first.set()

        manual_save.result(timeout=1)
        writer.shutdown(wait=True)
        self.assertEqual(order, ["first-snapshot", "manual-save", "latest-snapshot"])

    def test_write_failure_is_reported_to_callback_without_rewriting_error(self):
        writer = LatestWriteExecutor()
        failures = []

        def fail():
            raise OSError("private/path/recovery.json")

        writer.submit_latest("recovery", fail, failures.append)
        writer.shutdown(wait=True)
        self.assertEqual(len(failures), 1)
        self.assertIsInstance(failures[0], OSError)
        self.assertIn("private/path", str(failures[0]))

    def test_shutdown_wait_flushes_pending_latest_after_earlier_jobs(self):
        writer = LatestWriteExecutor()
        started = threading.Event()
        release = threading.Event()
        finished_shutdown = threading.Event()
        values = []

        def block():
            started.set()
            release.wait(2)
            values.append("earlier-save")

        blocker = writer.submit(block)
        self.assertTrue(started.wait(1))
        writer.submit_latest("recovery", lambda: values.append("latest-recovery"))
        shutdown_thread = threading.Thread(target=lambda: (writer.shutdown(wait=True), finished_shutdown.set()))
        shutdown_thread.start()
        time.sleep(.02)
        self.assertFalse(finished_shutdown.is_set())
        release.set()
        shutdown_thread.join(timeout=2)
        self.assertFalse(shutdown_thread.is_alive())
        blocker.result(timeout=1)
        self.assertEqual(values, ["earlier-save", "latest-recovery"])

    def test_shutdown_called_from_worker_does_not_deadlock_or_drop_latest(self):
        writer = LatestWriteExecutor()
        written = []

        def shutdown_in_worker():
            writer.submit_latest("startup", lambda: written.append("startup"))
            writer.shutdown(wait=True)

        future = writer.submit(shutdown_in_worker)
        future.result(timeout=1)
        writer.shutdown(wait=True)
        self.assertEqual(written, ["startup"])


if __name__ == "__main__":
    unittest.main()
