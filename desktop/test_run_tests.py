import unittest

from run_tests import suite_watchdog_seconds


class RunTestsWatchdogTest(unittest.TestCase):
    def test_macos_arm64_watchdog_exceeds_four_minutes_and_stays_under_ci_step_timeout(self):
        timeout = suite_watchdog_seconds("darwin", "arm64")
        self.assertEqual(timeout, 420)
        self.assertGreater(timeout, 240)
        self.assertLess(timeout, 8 * 60)

    def test_macos_intel_and_non_darwin_watchdog_budgets(self):
        self.assertEqual(suite_watchdog_seconds("darwin", "x86_64"), 720)
        self.assertEqual(suite_watchdog_seconds("linux", "x86_64"), 240)
        self.assertEqual(suite_watchdog_seconds("win32", "AMD64"), 240)


if __name__ == "__main__":
    unittest.main()
