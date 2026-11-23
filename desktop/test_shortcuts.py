"""Validation and portable/native display for configurable keyboard shortcuts."""
import unittest
import sys

from shortcuts import capture_sequence, default_shortcuts, native_label, normalize_shortcuts, parse_sequence


class ShortcutValidationTest(unittest.TestCase):
    def test_default_bindings_are_valid_and_have_platform_native_labels(self):
        defaults = default_shortcuts()
        normalized, error = normalize_shortcuts(defaults)
        self.assertEqual(error, "")
        self.assertEqual(normalized, defaults)
        self.assertTrue(native_label(defaults["find"][0]))
        self.assertEqual(parse_sequence("Ctrl+PageDown"), "Ctrl+PgDown")

    def test_macos_defaults_use_portable_command_modifiers_and_fullscreen_chord(self):
        defaults = default_shortcuts("darwin")
        for action, sequences in defaults.items():
            if action == "fullscreen":
                continue
            self.assertFalse(any("Meta" in sequence for sequence in sequences), f"{action} should use portable Ctrl for Command")
        self.assertEqual(defaults["copy"], ["Ctrl+C"])
        self.assertEqual(defaults["find"], ["Ctrl+F"])
        self.assertEqual(defaults["new_note"], ["Ctrl+T"])
        self.assertEqual(defaults["undo"], ["Ctrl+Z"])
        self.assertEqual(defaults["redo"], ["Ctrl+Shift+Z"])
        self.assertEqual(defaults["fullscreen"], ["F11", "Meta+Ctrl+F"])
        self.assertTrue(native_label(defaults["copy"][0]))
        if sys.platform == "darwin":
            self.assertIn("⌘", native_label(defaults["copy"][0]))
        normalized, error = normalize_shortcuts(defaults)
        self.assertEqual(error, "")
        self.assertEqual(normalized, defaults)

    def test_exact_conflicts_are_rejected_across_actions(self):
        candidate = default_shortcuts()
        candidate["find"] = ["Ctrl+O"]
        _, error = normalize_shortcuts(candidate)
        self.assertIn("Open note", error)


    def test_recorder_captures_modified_combinations_and_rejects_plain_letters(self):
        from PySide6.QtCore import Qt

        sequence, error = capture_sequence(int(Qt.Key_F), int(Qt.ControlModifier.value))
        self.assertEqual((sequence, error), ("Ctrl+F", ""))
        sequence, error = capture_sequence(int(Qt.Key_F11), int(Qt.NoModifier.value))
        self.assertEqual((sequence, error), ("F11", ""))
        sequence, error = capture_sequence(int(Qt.Key_A), int(Qt.NoModifier.value))
        self.assertEqual(sequence, "")
        self.assertIn("Use Ctrl", error)


if __name__ == "__main__":
    unittest.main()
