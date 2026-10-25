package dev.supermd.studio

import java.net.URLDecoder
import org.junit.Assert.*
import org.junit.Test

class SelectionActionsTest {
    @Test fun googlePreservesExactUnicodeAndUrlPunctuation() {
        val text = "    A & B? # Ω + 100%\u2029    next line\n"
        val target = SelectionActions.target("google", text, "chatgpt")
        assertFalse(target.copy)
        assertTrue(target.url.startsWith("https://www.google.com/search?q="))
        assertEquals(text.replace('\u2029','\n'), URLDecoder.decode(target.url.substringAfter("?q="), "UTF-8"))
    }
    @Test fun everyAssistantUsesClipboardAndNeverSubmitsAnyPrompt() {
        for ((provider, _) in SelectionActions.assistants) {
            val target = SelectionActions.target("assistant", "x".repeat(9000), provider)
            assertTrue(target.copy)
            assertFalse(target.url.contains('?'))
            assertTrue(target.message.contains("review"))
        }
        assertEquals("chatgpt", SelectionActions.provider("https://untrusted.example"))
    }
    @Test fun noSilentTruncationOrArbitraryDestinations() {
        for ((action,text,provider) in listOf(Triple("google","","chatgpt"),Triple("google","x".repeat(9000),"chatgpt"),Triple("assistant","x".repeat(1_000_001),"chatgpt"),Triple("assistant","text","invalid"),Triple("invalid","text","chatgpt"))) {
            assertThrows(IllegalArgumentException::class.java) { SelectionActions.target(action,text,provider) }
        }
    }
}
