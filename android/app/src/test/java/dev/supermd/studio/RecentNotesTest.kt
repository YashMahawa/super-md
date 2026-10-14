package dev.supermd.studio
import org.junit.Assert.*
import org.junit.Test
class RecentNotesTest {
    @Test fun pinsStayFirstAndTheWholeListIsLimitedToTen() {
        val pin=RecentNote("Pinned","uri:pinned",pinned=true)
        val result=orderedRecents((0..20).map {RecentNote("Note $it","uri:$it")}+pin)
        assertEquals(10,result.size);assertEquals(pin,result.first())
        assertEquals(1,orderedRecents(listOf(pin,pin)).size)
    }
}
