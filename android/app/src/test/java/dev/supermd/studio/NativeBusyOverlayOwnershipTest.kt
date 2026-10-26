package dev.supermd.studio

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class NativeBusyOverlayOwnershipTest {
    @Test fun readerPdfProgressOwnsTheBusyIntervalWithoutCoveringItsWebView() {
        assertTrue(shouldShowNativeBusyOverlay(busy = true, readerReady = true, readerOwnsProgress = false))
        assertFalse(shouldShowNativeBusyOverlay(busy = true, readerReady = true, readerOwnsProgress = true))
        assertFalse(shouldShowNativeBusyOverlay(busy = false, readerReady = true, readerOwnsProgress = false))
        assertTrue(shouldShowNativeBusyOverlay(busy = false, readerReady = false, readerOwnsProgress = false))
    }
}
