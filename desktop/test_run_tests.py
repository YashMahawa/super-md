import unittest

from run_tests import suite_watchdog_seconds


class RunTestsWatchdogTest(unittest.TestCase):
    def test_macos_arm64_and_intel_watchdogs_cover_five_probe_budget_within_ci_caps(self):
        five_probe_budget = 5 * 60
        ci_step_timeout = 8 * 60
        release_step_timeout = 15 * 60

        arm64_budget = suite_watchdog_seconds("darwin", "arm64")
        self.assertEqual(arm64_budget, 420)
        self.assertGreater(arm64_budget, five_probe_budget)
        self.assertLess(arm64_budget, ci_step_timeout)

        intel_budget = suite_watchdog_seconds("darwin", "x86_64")
        self.assertEqual(intel_budget, 720)
        self.assertGreater(intel_budget, arm64_budget)
        self.assertLess(intel_budget, release_step_timeout)

        self.assertEqual(suite_watchdog_seconds("linux", "x86_64"), 240)
        self.assertEqual(suite_watchdog_seconds("win32", "AMD64"), 240)


if __name__ == "__main__":
    unittest.main()
