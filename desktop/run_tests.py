"""CI harness: preserve every native assertion and diagnose stalled Qt drivers."""
import faulthandler
import platform
import sys
import unittest
from pathlib import Path

def suite_timeout_seconds(platform_name: str | None = None, machine: str | None = None) -> int:
    # macOS CI runs five bounded 60-second Qt mouse-selection probes plus
    # several WebEngine subprocess tests after hundreds of native tests. A
    # four-minute suite watchdog kills the process before per-probe timeouts
    # can report a real failure. Keep Apple Silicon within ci.yml's 8-minute
    # step budget so faulthandler still flushes tracebacks on a true hang.
    active_platform = sys.platform if platform_name is None else platform_name
    active_machine = platform.machine() if machine is None else machine
    if active_platform == "darwin":
        return 720 if active_machine == "x86_64" else 420
    return 240


if __name__ == "__main__":
    faulthandler.enable()
    suite_timeout = suite_timeout_seconds()
    faulthandler.dump_traceback_later(suite_timeout, exit=True)
    try:
        suite=unittest.defaultTestLoader.discover(str(Path(__file__).parent),pattern="test_*.py")
        result=unittest.TextTestRunner(verbosity=2).run(suite)
    finally:
        faulthandler.cancel_dump_traceback_later()
    sys.exit(0 if result.wasSuccessful() else 1)
