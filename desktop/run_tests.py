"""CI harness: preserve every native assertion and diagnose stalled Qt drivers."""
import faulthandler
import platform
import sys
import unittest
from pathlib import Path

if __name__ == "__main__":
    faulthandler.enable()
    # macOS CI runs multiple bounded 60-second Qt WebEngine subprocess probes
    # after hundreds of native tests. Keep per-probe assertions and timeouts
    # intact while giving arm64 macOS 420s (within ci.yml's 8-minute step budget)
    # and Intel macOS 720s.
    suite_timeout = 720 if sys.platform == "darwin" and platform.machine() == "x86_64" else (420 if sys.platform == "darwin" else 240)
    faulthandler.dump_traceback_later(suite_timeout, exit=True)
    try:
        suite=unittest.defaultTestLoader.discover(str(Path(__file__).parent),pattern="test_*.py")
        result=unittest.TextTestRunner(verbosity=2).run(suite)
    finally:
        faulthandler.cancel_dump_traceback_later()
    sys.exit(0 if result.wasSuccessful() else 1)
