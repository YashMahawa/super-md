import unittest
from unittest.mock import patch

from run_tests import suite_timeout_seconds


class RunTestsWatchdogTest(unittest.TestCase):
    def test_suite_timeout_covers_macos_architectures_within_workflow_step_budgets(self):
        # Apple Silicon macOS (macos-latest in ci.yml) runs under an 8-minute
        # (480s) step timeout and executes five 60s Qt mouse-selection probes
        # plus WebEngine/MCP integration tests; 420s leaves 60s for faulthandler
        # stack dumps before the CI step timeout while preventing 240s cutoffs.
        arm64_macos = suite_timeout_seconds("darwin", "arm64")
        self.assertEqual(arm64_macos, 420)
        self.assertGreater(arm64_macos, 5 * 60)
        self.assertLess(arm64_macos, 8 * 60)

        with patch("run_tests.sys.platform", "darwin"), patch("run_tests.platform.machine", return_value="arm64"):
            self.assertEqual(suite_timeout_seconds(), 420)

        # Intel macOS (macos-15-intel in release.yml) runs under a 15-minute (900s) budget.
        intel_macos = suite_timeout_seconds("darwin", "x86_64")
        self.assertEqual(intel_macos, 720)
        self.assertLess(intel_macos, 15 * 60)

        # Linux and Windows keep the 4-minute watchdog.
        self.assertEqual(suite_timeout_seconds("linux", "x86_64"), 240)
        self.assertEqual(suite_timeout_seconds("win32", "AMD64"), 240)


if __name__ == "__main__":
    unittest.main()
