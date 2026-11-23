"""CI harness: preserve every native assertion and diagnose stalled Qt drivers."""
import faulthandler
import platform
import sys
import unittest
from pathlib import Path

if __name__ == "__main__":
    faulthandler.enable()
    # macOS CI runs multiple software-rendered QtWebEngine subprocess probes
    # (five mouse-selection probes plus live viewport, preview, context-menu,
    # and typewriter checks) after hundreds of native tests. Keep per-probe
    # assertions and timeouts intact while giving arm64 macOS 420s (inside
    # ci.yml's 8-minute step budget) and Intel macOS 720s.
    if sys.platform == "darwin":
        suite_timeout = 720 if platform.machine() == "x86_64" else 420
    else:
        suite_timeout = 240
    faulthandler.dump_traceback_later(suite_timeout, exit=True)
    try:
        suite=unittest.defaultTestLoader.discover(str(Path(__file__).parent),pattern="test_*.py")
        result=unittest.TextTestRunner(verbosity=2).run(suite)
    finally:
        faulthandler.cancel_dump_traceback_later()
    sys.exit(0 if result.wasSuccessful() else 1)
