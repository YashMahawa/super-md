"""CI harness: preserve every native assertion and diagnose stalled Qt drivers."""
import faulthandler
import platform
import sys
import unittest
from pathlib import Path

if __name__ == "__main__":
    faulthandler.enable()
    # macOS CI runs five bounded 60-second Qt mouse-selection probes plus
    # WebEngine/QML smoke suites after hundreds of native tests. A four-minute
    # suite watchdog kills the 3-core macOS runner right at the end of the run
    # before individual test timeouts or the 8-minute CI step budget can report
    # a real failure. Keep per-probe assertions intact; size the suite watchdog
    # inside CI's 480s step timeout on arm64 macOS (and 720s on Intel macOS).
    suite_timeout = (
        720
        if sys.platform == "darwin" and platform.machine() == "x86_64"
        else (420 if sys.platform == "darwin" else 240)
    )
    faulthandler.dump_traceback_later(suite_timeout, exit=True)
    try:
        suite=unittest.defaultTestLoader.discover(str(Path(__file__).parent),pattern="test_*.py")
        result=unittest.TextTestRunner(verbosity=2).run(suite)
    finally:
        faulthandler.cancel_dump_traceback_later()
    sys.exit(0 if result.wasSuccessful() else 1)
