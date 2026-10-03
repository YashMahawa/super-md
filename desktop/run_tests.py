"""CI harness: preserve every native assertion and diagnose stalled Qt drivers."""
import faulthandler
import sys
import unittest
from pathlib import Path

if __name__ == "__main__":
    faulthandler.enable()
    faulthandler.dump_traceback_later(240, exit=True)
    try:
        suite=unittest.defaultTestLoader.discover(str(Path(__file__).parent),pattern="test_*.py")
        result=unittest.TextTestRunner(verbosity=2).run(suite)
    finally:
        faulthandler.cancel_dump_traceback_later()
    sys.exit(0 if result.wasSuccessful() else 1)
