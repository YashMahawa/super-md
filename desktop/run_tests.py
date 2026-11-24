"""CI harness: preserve every native assertion and diagnose stalled Qt drivers."""
import faulthandler
import platform
import sys
import unittest
from pathlib import Path

def suite_timeout_for(platform_name: str | None = None, machine: str | None = None) -> int:
    current_platform = sys.platform if platform_name is None else platform_name
    current_machine = platform.machine() if machine is None else machine
    # macOS CI runs five bounded 60-second Qt mouse-selection probes plus
    # software-rendered WebEngine integration suites after the native unit
    # tests. Widen the suite watchdog on both Intel and Apple Silicon so
    # faulthandler dumps tracebacks before the CI step timeout without killing
    # healthy runs at four minutes.
    if current_platform == "darwin":
        return 720 if current_machine == "x86_64" else 420
    return 240


if __name__ == "__main__":
    faulthandler.enable()
    suite_timeout = suite_timeout_for()
    faulthandler.dump_traceback_later(suite_timeout, exit=True)
    try:
        suite=unittest.defaultTestLoader.discover(str(Path(__file__).parent),pattern="test_*.py")
        result=unittest.TextTestRunner(verbosity=2).run(suite)
    finally:
        faulthandler.cancel_dump_traceback_later()
    sys.exit(0 if result.wasSuccessful() else 1)
