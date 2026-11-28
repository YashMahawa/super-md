"""CI harness: preserve every native assertion and diagnose stalled Qt drivers."""
import faulthandler
import platform
import sys
import unittest
from pathlib import Path

def suite_watchdog_seconds(platform_name: str = sys.platform, machine: str | None = None) -> int:
    """Return the faulthandler watchdog timeout in seconds.

    CI and release steps allow 15 minutes (900s) because the 100+ Qt Quick /
    WebEngine / desktop test modules (720+ tests) take ~6.5-7+ minutes on macOS
    (`macos-latest` arm64 and `macos-15-intel` x86_64) and ~4-5.5 minutes on
    Linux and Windows in software/offscreen mode. Keep macOS at 720s (12m) and
    Linux/Windows at 420s (7m) so faulthandler still dumps Python tracebacks
    before the GitHub Actions step timeout if a Qt driver genuinely stalls.
    """
    _ = platform.machine() if machine is None else machine
    if platform_name == "darwin":
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
