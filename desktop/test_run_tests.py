"""Verify desktop CI test harness watchdog budgets across macOS architectures and workflows."""
from __future__ import annotations

import re
import runpy
import subprocess
import sys
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parent
REPO_ROOT = ROOT.parent


def _captured_watchdog_timeout(platform_name: str, machine: str) -> tuple[int, bool]:
    recorded: dict[str, object] = {}

    class _Result:
        def wasSuccessful(self) -> bool:
            return True

    class _Runner:
        def __init__(self, *args: object, **kwargs: object) -> None:
            pass

        def run(self, _suite: object) -> _Result:
            return _Result()

    def fake_dump_later(timeout: int, *, repeat: bool = False, file: object = None, exit: bool = False) -> None:
        recorded["timeout"] = timeout
        recorded["exit"] = exit

    with (
        mock.patch.object(sys, "platform", platform_name),
        mock.patch("platform.machine", return_value=machine),
        mock.patch("faulthandler.enable"),
        mock.patch("faulthandler.dump_traceback_later", side_effect=fake_dump_later),
        mock.patch("faulthandler.cancel_dump_traceback_later"),
        mock.patch("unittest.defaultTestLoader.discover", return_value=unittest.TestSuite()),
        mock.patch("unittest.TextTestRunner", _Runner),
    ):
        with mock.patch.object(sys, "exit", side_effect=SystemExit):
            try:
                runpy.run_path(str(ROOT / "run_tests.py"), run_name="__main__")
            except SystemExit as exc:
                if exc.code not in (0, None):
                    raise AssertionError(f"Unexpected exit code: {exc.code}") from exc

    return int(recorded["timeout"]), bool(recorded["exit"])


def _workflow_desktop_test_timeout_minutes(workflow_path: Path) -> int:
    text = workflow_path.read_text(encoding="utf-8")
    # Match the step block invoking `python desktop/run_tests.py` in GitHub Actions YAML.
    steps = re.split(r"\n(?=\s*-\s+(?:name|run|uses):)", text)
    for step in steps:
        if "python desktop/run_tests.py" in step:
            match = re.search(r"timeout-minutes:\s*(\d+)", step)
            if not match:
                raise AssertionError(f"{workflow_path.name} runs desktop/run_tests.py without timeout-minutes")
            return int(match.group(1))
    raise AssertionError(f"{workflow_path.name} does not contain python desktop/run_tests.py step")


class RunTestsWatchdogTest(unittest.TestCase):
    def test_macos_arm64_and_x86_64_both_receive_extended_suite_watchdog(self) -> None:
        arm64_timeout, arm64_exit = _captured_watchdog_timeout("darwin", "arm64")
        x64_timeout, x64_exit = _captured_watchdog_timeout("darwin", "x86_64")
        linux_timeout, linux_exit = _captured_watchdog_timeout("linux", "x86_64")
        win_timeout, win_exit = _captured_watchdog_timeout("win32", "AMD64")

        self.assertTrue(arm64_exit)
        self.assertTrue(x64_exit)
        self.assertTrue(linux_exit)
        self.assertTrue(win_exit)
        self.assertEqual(arm64_timeout, 720)
        self.assertEqual(x64_timeout, 720)
        self.assertEqual(linux_timeout, 420)
        self.assertEqual(win_timeout, 420)

    def test_workflow_step_timeouts_exceed_faulthandler_watchdog(self) -> None:
        arm64_watchdog, _ = _captured_watchdog_timeout("darwin", "arm64")
        x64_watchdog, _ = _captured_watchdog_timeout("darwin", "x86_64")
        linux_watchdog, _ = _captured_watchdog_timeout("linux", "x86_64")
        win_watchdog, _ = _captured_watchdog_timeout("win32", "AMD64")
        ci_minutes = _workflow_desktop_test_timeout_minutes(REPO_ROOT / ".github" / "workflows" / "ci.yml")
        release_minutes = _workflow_desktop_test_timeout_minutes(REPO_ROOT / ".github" / "workflows" / "release.yml")
        self.assertEqual(ci_minutes, 15)
        self.assertEqual(release_minutes, 15)
        for label, watchdog in (
            ("arm64", arm64_watchdog),
            ("x86_64", x64_watchdog),
            ("linux", linux_watchdog),
            ("windows", win_watchdog),
        ):
            self.assertGreater(
                ci_minutes * 60,
                watchdog,
                f"ci.yml timeout-minutes ({ci_minutes}m = {ci_minutes * 60}s) must exceed {label} watchdog ({watchdog}s)",
            )
            self.assertGreater(
                release_minutes * 60,
                watchdog,
                f"release.yml timeout-minutes ({release_minutes}m = {release_minutes * 60}s) must exceed {label} watchdog ({watchdog}s)",
            )

    def test_watchdog_expiration_exits_with_code_1_while_widened_budget_succeeds(self) -> None:
        probe_code = """
import faulthandler, runpy, sys, time, unittest
from unittest import mock

budget = int(sys.argv[1])
sleep_s = float(sys.argv[2])

class _SlowCase(unittest.TestCase):
    def runTest(self) -> None:
        time.sleep(sleep_s)

orig = faulthandler.dump_traceback_later
def patched(_timeout: int, *, repeat: bool = False, file: object = None, exit: bool = False) -> None:
    orig(budget, repeat=repeat, file=file, exit=exit)

with (
    mock.patch("unittest.defaultTestLoader.discover", return_value=unittest.TestSuite([_SlowCase()])),
    mock.patch("faulthandler.dump_traceback_later", side_effect=patched),
):
    runpy.run_path(sys.argv[3], run_name="__main__")
"""
        runner_path = str(ROOT / "run_tests.py")
        expired = subprocess.run(
            [sys.executable, "-c", probe_code, "1", "1.6", runner_path],
            capture_output=True,
            text=True,
            timeout=10,
        )
        self.assertEqual(expired.returncode, 1)
        self.assertIn("Timeout (0:00:01)!", expired.stderr)

        completed = subprocess.run(
            [sys.executable, "-c", probe_code, "5", "0.2", runner_path],
            capture_output=True,
            text=True,
            timeout=10,
        )
        self.assertEqual(completed.returncode, 0)


if __name__ == "__main__":
    unittest.main()
