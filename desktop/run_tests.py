"""CI harness: preserve every native assertion and diagnose stalled Qt drivers."""
import faulthandler
import sys
import unittest
from pathlib import Path

def suite_watchdog_seconds(platform_name: str = sys.platform) -> int:
    # macOS CI (both Intel x86_64 and Apple Silicon arm64) runs multiple
    # bounded 60-second Qt WebEngine subprocess probes after hundreds of native
    # tests under software rendering. A four-minute suite watchdog kills the
    # process before those individual timeouts can report a real failure.
    # Keep the per-probe assertions and timeout; only widen the suite budget.
    return 720 if platform_name == "darwin" else 360


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
