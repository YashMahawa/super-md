"""CI harness: preserve every native assertion and diagnose stalled Qt drivers."""
import faulthandler
import platform
import sys
import unittest
from pathlib import Path

def suite_watchdog_seconds(platform_name: str | None = None, machine: str | None = None) -> int:
    """Return the faulthandler watchdog timeout in seconds.

    macOS CI steps allow 8 minutes (480s) on arm64 (`macos-latest`) because the
    60+ Qt Quick / WebEngine test files and bounded mouse-selection probes take
    ~4 minutes in software/offscreen mode. Keep arm64 at 420s so faulthandler
    still dumps Python tracebacks before the GitHub Actions step timeout if a
    Qt driver genuinely stalls.
    """
    current_platform = sys.platform if platform_name is None else platform_name
    resolved_machine = platform.machine() if machine is None else machine
    if current_platform == "darwin":
        return 720 if resolved_machine == "x86_64" else 420
    return 240


suite_timeout_for = suite_watchdog_seconds


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
