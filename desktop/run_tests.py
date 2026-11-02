"""CI harness: preserve every native assertion and diagnose stalled Qt drivers."""
import faulthandler
import platform
import sys
import unittest
from pathlib import Path

if __name__ == "__main__":
    faulthandler.enable()
    # Intel macOS CI runs five bounded 60-second Qt mouse-selection probes
    # after hundreds of native tests. A four-minute suite watchdog kills the
    # process before those individual timeouts can report a real failure.
    # Keep the per-probe assertions and timeout; only widen the suite budget.
    suite_timeout = 720 if sys.platform == "darwin" and platform.machine() == "x86_64" else 240
    faulthandler.dump_traceback_later(suite_timeout, exit=True)
    try:
        suite=unittest.defaultTestLoader.discover(str(Path(__file__).parent),pattern="test_*.py")
        result=unittest.TextTestRunner(verbosity=2).run(suite)
    finally:
        faulthandler.cancel_dump_traceback_later()
    sys.exit(0 if result.wasSuccessful() else 1)
