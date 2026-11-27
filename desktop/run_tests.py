"""CI harness: preserve every native assertion and diagnose stalled Qt drivers."""
import faulthandler
import platform
import sys
import unittest
from pathlib import Path

def suite_watchdog_seconds(platform_name: str = sys.platform, machine: str | None = None) -> int:
    """Return the faulthandler watchdog timeout in seconds.

    CI workflows allow 8 minutes (480s) for `python desktop/run_tests.py` on
    Linux, Windows, and arm64 macOS (and 15 minutes / 900s in release.yml) as
    the 90+ Qt Quick, WebEngine, and subprocess test files run sequentially in
    software/offscreen mode. Keep 8-minute CI runners at 420s (and Intel macOS
    release runners at 720s) so faulthandler still dumps Python tracebacks
    before the GitHub Actions step timeout if a Qt driver genuinely stalls.
    """
    resolved_machine = platform.machine() if machine is None else machine
    if platform_name == "darwin" and resolved_machine == "x86_64":
        return 720
    return 420


if __name__ == "__main__":
    faulthandler.enable()
    suite_timeout = suite_watchdog_seconds()
    faulthandler.dump_traceback_later(suite_timeout, exit=True)
    try:
        desktop_dir = str(Path(__file__).resolve().parent)
        suite = unittest.defaultTestLoader.discover(
            start_dir=desktop_dir,
            pattern="test_*.py",
            top_level_dir=desktop_dir,
        )
        result = unittest.TextTestRunner(verbosity=2).run(suite)
    finally:
        faulthandler.cancel_dump_traceback_later()
    sys.exit(0 if result.wasSuccessful() else 1)
