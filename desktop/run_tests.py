"""CI harness: preserve every native assertion and diagnose stalled Qt drivers."""
import faulthandler
import gc
import os
import platform
import sys
import unittest
from pathlib import Path

os.environ.setdefault("QT_QUICK_CONTROLS_STYLE", "Material")


class _CleanupTestResult(unittest.TextTestResult):
    def __init__(self, *args, **kwargs) -> None:
        super().__init__(*args, **kwargs)
        self._last_module: str | None = None

    def startTest(self, test: unittest.TestCase) -> None:
        module = test.__class__.__module__
        if module != self._last_module:
            self._last_module = module
            if module == "test_documents":
                gc.collect()
        super().startTest(test)


def suite_watchdog_seconds(platform_name: str = sys.platform, machine: str | None = None) -> int:
    """Return the faulthandler watchdog timeout in seconds.

    CI steps allow 8 minutes (480s) on Linux, Windows, and arm64 macOS
    (`macos-latest`) because the 80+ Qt Quick / WebEngine / desktop test files
    (~600 tests) take ~4 minutes in software/offscreen mode. Keep the default
    suite watchdog at 420s (and 720s on x86_64 macOS under release.yml's
    15-minute budget) so faulthandler still dumps Python tracebacks before the
    GitHub Actions step timeout if a Qt driver genuinely stalls.
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
        result = unittest.TextTestRunner(verbosity=2, resultclass=_CleanupTestResult).run(suite)
    finally:
        faulthandler.cancel_dump_traceback_later()
    sys.exit(0 if result.wasSuccessful() else 1)
