package dev.supermd.studio

import org.junit.Assert.*
import org.junit.Test

class ReadingChromeTest {
    @Test fun fullscreenScrollNeverRevealsControls() {
        for (visible in listOf(false, true)) for (up in listOf(false, true)) {
            assertEquals(false, readingChromeAfterGesture(true, visible, up, false))
        }
    }
    @Test fun normalModeKeepsDirectionalScrollBehavior() {
        assertEquals(true, readingChromeAfterGesture(false, false, true, false))
        assertEquals(false, readingChromeAfterGesture(false, true, false, false))
    }
    @Test fun deliberateTapsStillToggleControls() {
        for (fullscreen in listOf(false, true)) {
            assertEquals(true, readingChromeAfterGesture(fullscreen, false, null, true))
            assertEquals(false, readingChromeAfterGesture(fullscreen, true, null, true))
            assertNull(readingChromeAfterGesture(fullscreen, false, null, false))
        }
    }
}
