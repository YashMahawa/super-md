"""CI harness: preserve every native assertion and diagnose stalled Qt drivers."""
import faulthandler
import platform
import sys
import unittest
from pathlib import Path

def suite_watchdog_seconds(platform_name: str | None = None, machine: str | None = None) -> int:
    current_platform = sys.platform if platform_name is None else platform_name
    current_machine = platform.machine() if machine is None else machine
    if current_platform == "darwin":
        return 720 if current_machine == "x86_64" else 420
    return 240


if __name__ == "__main__":
    faulthandler.enable()
    # macOS CI runs five bounded 60-second Qt mouse-selection probes after
    # hundreds of native tests. A four-minute suite watchdog kills the process
    # on Apple Silicon (~240s) and Intel runners before those individual
    # timeouts can report a real failure, while staying inside CI's 8m/15m caps.
    suite_timeout = suite_watchdog_seconds()
    faulthandler.dump_traceback_later(suite_timeout, exit=True)
    try:
        suite=unittest.defaultTestLoader.discover(str(Path(__file__).parent),pattern="test_*.py")
        result=unittest.TextTestRunner(verbosity=2).run(suite)
    finally:
        faulthandler.cancel_dump_traceback_later()
    sys.exit(0 if result.wasSuccessful() else 1)
