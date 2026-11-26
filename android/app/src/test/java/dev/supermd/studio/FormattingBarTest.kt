package dev.supermd.studio

import android.view.KeyEvent
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class FormattingBarTest {
    @Test fun mapsAllDefaultHardwareFormattingShortcuts() {
        assertEquals("bold", markdownFormatActionForKey(KeyEvent.KEYCODE_B, isCtrlPressed = true, isShiftPressed = false, isAltPressed = false))
        assertEquals("italic", markdownFormatActionForKey(KeyEvent.KEYCODE_I, isCtrlPressed = true, isShiftPressed = false, isAltPressed = false))
        assertEquals("inline_code", markdownFormatActionForKey(KeyEvent.KEYCODE_E, isCtrlPressed = true, isShiftPressed = false, isAltPressed = false))
        assertEquals("inline_code", markdownFormatActionForKey(KeyEvent.KEYCODE_GRAVE, isCtrlPressed = true, isShiftPressed = false, isAltPressed = false))
        assertEquals("link", markdownFormatActionForKey(KeyEvent.KEYCODE_K, isCtrlPressed = true, isShiftPressed = false, isAltPressed = false))
        assertEquals("heading", markdownFormatActionForKey(KeyEvent.KEYCODE_H, isCtrlPressed = true, isShiftPressed = true, isAltPressed = false))
        assertEquals("list", markdownFormatActionForKey(KeyEvent.KEYCODE_L, isCtrlPressed = true, isShiftPressed = true, isAltPressed = false))
        assertEquals("quote", markdownFormatActionForKey(KeyEvent.KEYCODE_Q, isCtrlPressed = true, isShiftPressed = true, isAltPressed = false))
        assertEquals("quote", markdownFormatActionForKey(KeyEvent.KEYCODE_Q, isCtrlPressed = true, isShiftPressed = false, isAltPressed = true))
        assertEquals("inline_math", markdownFormatActionForKey(KeyEvent.KEYCODE_M, isCtrlPressed = true, isShiftPressed = true, isAltPressed = false))
    }

    @Test fun ignoresUnmodifiedOrConflictingKeyChords() {
        assertNull(markdownFormatActionForKey(KeyEvent.KEYCODE_B, isCtrlPressed = false, isShiftPressed = false, isAltPressed = false))
        assertNull(markdownFormatActionForKey(KeyEvent.KEYCODE_B, isCtrlPressed = true, isShiftPressed = true, isAltPressed = false))
        assertNull(markdownFormatActionForKey(KeyEvent.KEYCODE_H, isCtrlPressed = true, isShiftPressed = false, isAltPressed = false))
        assertNull(markdownFormatActionForKey(KeyEvent.KEYCODE_B, isCtrlPressed = true, isShiftPressed = false, isAltPressed = true))
        assertNull(markdownFormatActionForKey(KeyEvent.KEYCODE_B, isCtrlPressed = true, isShiftPressed = false, isAltPressed = false, isMetaPressed = true))
    }

    @Test fun showsKeyboardBarOnlyDuringActiveSoftKeyboardEditing() {
        for (mode in listOf("editor", "split", "live")) {
            assertTrue(
                shouldShowKeyboardFormattingBar(
                    mode = mode,
                    imeVisible = true,
                    editorFocused = true,
                    readerReady = true,
                    readerOverlay = false,
                    modalOpen = false,
                )
            )
        }
        // Hidden in Read mode
        assertFalse(
            shouldShowKeyboardFormattingBar(
                mode = "reader",
                imeVisible = true,
                editorFocused = true,
                readerReady = true,
                readerOverlay = false,
                modalOpen = false,
            )
        )
        // Hidden when soft keyboard closes or hardware keyboard suppresses IME
        assertFalse(
            shouldShowKeyboardFormattingBar(
                mode = "editor",
                imeVisible = false,
                editorFocused = true,
                readerReady = true,
                readerOverlay = false,
                modalOpen = false,
            )
        )
        // Hidden when editor is unfocused, overlay is open, or native modal is open
        assertFalse(
            shouldShowKeyboardFormattingBar(
                mode = "live",
                imeVisible = true,
                editorFocused = false,
                readerReady = true,
                readerOverlay = false,
                modalOpen = false,
            )
        )
        assertFalse(
            shouldShowKeyboardFormattingBar(
                mode = "editor",
                imeVisible = true,
                editorFocused = true,
                readerReady = true,
                readerOverlay = true,
                modalOpen = false,
            )
        )
        assertFalse(
            shouldShowKeyboardFormattingBar(
                mode = "split",
                imeVisible = true,
                editorFocused = true,
                readerReady = true,
                readerOverlay = false,
                modalOpen = true,
            )
        )
    }

    @Test fun hardwareShortcutsWorkWithoutSoftKeyboardWhenEditorIsFocused() {
        assertTrue(
            canTriggerHardwareFormatShortcut(
                mode = "live",
                editorFocused = true,
                readerReady = true,
                readerOverlay = false,
                modalOpen = false,
            )
        )
        assertFalse(
            canTriggerHardwareFormatShortcut(
                mode = "reader",
                editorFocused = true,
                readerReady = true,
                readerOverlay = false,
                modalOpen = false,
            )
        )
        assertFalse(
            canTriggerHardwareFormatShortcut(
                mode = "live",
                editorFocused = false,
                readerReady = true,
                readerOverlay = false,
                modalOpen = false,
            )
        )
    }
}
