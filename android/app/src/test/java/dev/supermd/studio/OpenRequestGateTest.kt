package dev.supermd.studio

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class OpenRequestGateTest {
    @Test fun onlyNewestAsynchronousOpenMayCommit() {
        val gate = OpenRequestGate()
        val first = gate.begin()
        val second = gate.begin()

        assertFalse(gate.isCurrent(first))
        assertTrue(gate.isCurrent(second))
    }

    @Test fun explicitTabActionInvalidatesPendingOpen() {
        val gate = OpenRequestGate()
        val opening = gate.begin()

        gate.invalidate()

        assertFalse(gate.isCurrent(opening))
    }

    @Test fun readerNotReadyRetainsEveryDistinctOpenInOrderAndDeliversOnAttach() {
        val dispatcher = OpenIntentDispatcher<String>()
        val received = mutableListOf<OpenIntentDispatcher.Request<String>>()
        dispatcher.request("first", "first.md")
        dispatcher.request("second", "second.md")
        dispatcher.request("first", "nested/first.md")

        val handler = OpenIntentDispatcher.Handler<String> { target, relative ->
            received += OpenIntentDispatcher.Request(target, relative)
        }
        dispatcher.attach(handler)

        assertEquals(listOf(
            OpenIntentDispatcher.Request("second", "second.md"),
            OpenIntentDispatcher.Request("first", "nested/first.md"),
        ), received)
    }

    @Test fun existingHandlerGetsOpenImmediatelyAndOldDisposeCannotClearReplacement() {
        val dispatcher = OpenIntentDispatcher<String>()
        val received = mutableListOf<String>()
        val first = OpenIntentDispatcher.Handler<String> { target, _ -> received += target }
        val replacement = OpenIntentDispatcher.Handler<String> { target, _ -> received += "new:$target" }

        dispatcher.attach(first)
        dispatcher.request("open")
        dispatcher.attach(replacement)
        dispatcher.detach(first)
        dispatcher.request("current")

        assertEquals(listOf("open", "new:current"), received)
    }
}
