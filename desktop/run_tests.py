"""CI harness: preserve every native assertion and diagnose stalled Qt drivers."""
import faulthandler
import platform
import sys
import unittest
from pathlib import Path

def suite_watchdog_seconds(system: str = sys.platform, machine: str = platform.machine()) -> int:
    # macOS CI runs multiple isolated Qt WebEngine + Chromium probes (including
    # five bounded 60-second mouse-selection probes and live reader/export E2E
    # checks) plus hdiutil DMG packaging checks after hundreds of native tests.
    # A four-minute suite watchdog kills macos-latest (arm64) right around 240s
    # before the suite can finish, while 420s stays inside ci.yml's 8-minute
    # step timeout so faulthandler still dumps stacks if a Qt driver stalls.
    if system == "darwin":
        return 720 if machine == "x86_64" else 420
    return 240


if __name__ == "__main__":
    faulthandler.enable()
    suite_timeout = suite_watchdog_seconds()
    faulthandler.dump_traceback_later(suite_timeout, exit=True)
    try:
        suite=unittest.defaultTestLoader.discover(str(Path(__file__).parent),pattern="test_*.py")
        result=unittest.TextTestRunner(verbosity=2).run(suite)
    finally:
        faulthandler.cancel_dump_traceback_later()
    sys.exit(0 if result.wasSuccessful() else 1)
