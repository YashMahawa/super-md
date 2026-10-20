"""Static lifecycle checks for the Qt WebEngine renderer recovery path."""

import unittest
from pathlib import Path


QML = Path(__file__).parent / "qml" / "Main.qml"
MAIN = Path(__file__).parent / "main.py"


class ReaderCrashRecoveryTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.qml = QML.read_text(encoding="utf-8")
        cls.main = MAIN.read_text(encoding="utf-8")

    def test_unexpected_termination_invalidates_native_reader_state(self):
        self.assertIn("onRenderProcessTerminated: function(terminationStatus, exitCode)", self.qml)
        self.assertIn("terminationStatus === WebEngineView.NormalTerminationStatus", self.qml)
        self.assertIn("studio.readerCrashed()", self.qml)
        self.assertIn("studio.retired", self.qml)
        self.assertIn("intentionalShutdown || closingAllowed", self.qml)

    def test_retry_remounts_view_and_reattaches_gestures(self):
        self.assertIn('objectName: "documentReader"', self.qml)
        self.assertIn('id: readerLoader', self.qml)
        self.assertIn("readerLoader.active = false", self.qml)
        self.assertIn("readerLoader.active = true", self.qml)
        self.assertIn("signal readerViewChanged(var readerView)", self.qml)
        self.assertIn("window.readerViewChanged(item)", self.qml)
        self.assertIn("window.readerViewChanged.connect(attach_reader_gestures)", self.main)
        self.assertIn("window.removeEventFilter(previous)", self.main)
        self.assertIn("const retryDelays = [500, 1500, 4000]", self.qml)
        self.assertIn("readerRetryCount >= retryDelays.length", self.qml)
        self.assertIn("script.injectionPoint = WebEngineScript.DocumentCreation", self.qml)
        self.assertIn("userScripts.insert(script)", self.qml)
        self.assertEqual(self.qml.count("userScripts.insert(script)"), 1)
        self.assertNotIn("reader.reload()", self.qml)

    def test_repeated_failure_has_manual_retry_without_running_python(self):
        self.assertIn("readerRecoveryExhausted = true", self.qml)
        self.assertIn('text: "Retry reader"', self.qml)
        self.assertIn("onClicked: retryReaderManually()", self.qml)
        self.assertNotIn("runPython", self.qml)

    def test_retry_budget_resets_only_after_a_stable_ready_period(self):
        self.assertIn("interval: 15000", self.qml)
        self.assertIn("!readerStableTimer.running && (readerRetryCount > 0 || readerRecoveryLoading)", self.qml)
        self.assertNotIn("readerStableTimer.restart()", self.qml)
        self.assertIn("readerRetryCount = 0", self.qml)


if __name__ == "__main__":
    unittest.main()
